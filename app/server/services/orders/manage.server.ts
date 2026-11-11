/**
 * Order management (docs/CONTRACTS.md §1): moving an order through its states with every side
 * effect in the SAME db.batch, and the shopper-facing reads (customer, confirmation link, guest
 * lookup, "my orders").
 *
 *   await transitionOrder(db, actor, orderId, "shipped", {}, ctx.now);
 *   await transitionOrder(db, actor, orderId, "cancelled", { reason: "طلب العميل الإلغاء هاتفياً" }, ctx.now);
 *   const view = await lookupGuestOrder(db, { ref, phone }, { ip: ctx.ip, locale: ctx.locale }, ctx.now);
 *
 * TRANSITIONS (./state — ORDER_TRANSITIONS). Who may make them:
 *   → confirmed   orders.order.update          (cash on delivery, after the phone confirmation)
 *   → preparing   orders.fulfillment.pack
 *   → shipped     orders.fulfillment.ship
 *   → delivered   orders.fulfillment.deliver
 *   → cancelled   orders.order.cancel          reason required
 *   → returned    shipping.attempt.manage      from shipped (parcel came back undelivered), reason required
 *                 returns.rma.approve          from delivered (sent back after delivery), reason required
 *   The payment moves (awaiting_payment ⇄ payment_review → confirmed) are refused here: they belong
 *   to submitPaymentProof / verifyPayment, so no order is confirmed without a verified payment.
 *   The system actor (scheduled jobs) passes every permission check.
 *   Moving an order to the state it is already in does nothing (a repeated click is harmless).
 *   `opts.from` pins the status the caller decided on (the unpaid-order job passes
 *   "awaiting_payment"): if the order is elsewhere by then, nothing happens ("order_changed").
 *
 * SIDE EFFECTS (all in the transition's batch, guarded by the order's current status, so two
 * concurrent transitions cannot both apply):
 *   shipped     every serial-tracked unit must have its serial scanned onto its line first
 *               (assignSerialsStatements; "serials_required" otherwise), and the order must still
 *               hold its stock ("stock_not_reserved"). The reservations are committed: on_hand and
 *               reserved go down, 'sale' movements with the FIFO landed cost [P], used units sold.
 *   delivered   warranties start (one per scanned serial, otherwise one per line; months for new
 *               items, days for used units); revenue is recognised (postSale) and the cost of the
 *               goods that left is posted (postCogs, from the order's own 'sale' movements and the
 *               used units' acquisition cost) — see docs/metrics.md.
 *   cancelled   stock reservations and reserved used units released, serials scanned while packing
 *               go back to stock, the coupon use is freed, unpaid payment rows are cancelled, and
 *               every PAID payment gets a pending refund of what is still refundable on it (the
 *               refund path: issued by approveRefund, four eyes).
 *   returned    from shipped: the goods come back (restocked by default; `opts.goods` decides per
 *               line, e.g. a damaged parcel is scrapped), the coupon use is freed, the unpaid
 *               cash-on-delivery payment is cancelled and paid payments get a pending refund.
 *               From delivered: status only — the goods and the money of a return after delivery
 *               go through createRefund (items with restock/scrap after inspection) first.
 *   Every transition writes an order event (kind "status_changed") and an audit event.
 *
 * READS return the client-safe OrderView / OrderSummary (./types): never cost data, internal notes,
 * risk flags, staff identities or serial numbers; the phone number is masked.
 *
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { OrderStatus, Paged } from "~/lib/dto";
import { newId, sha256Hex, timingSafeEqual } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { actorRef, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  bundleItems,
  journalEntries,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  ORDER_STATUSES,
  payments,
  serials,
  stockMovements,
  usedUnits,
  variants,
  warranties,
  type NewOrder,
  type NewWarranty,
  type Order,
} from "~/server/db/schema";
import { batchSql, expectChanged, isDbError, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { cogsPostingKey, mapPostingError, postCogs, postReturnedGoods, postSale, postedBy } from "../accounting/post.server";
import { commitOrderReservationsStatements, releaseOrderReservationsStatements } from "../inventory/stock.server";
import { getRefundableAmount, refundRequestStatements } from "../refunds.server";
import { RETURN_DISPOSITIONS, planReturnedGoods, type ReturnLine } from "./returns.server";
import { canTransition, isPaymentDriven, ORDER_TRANSITIONS } from "./state";
import type { OrderSummary, OrderView } from "./types";
import { buildOrderSummaries, buildOrderView } from "./view.server";

export { ORDER_TRANSITIONS };

/** Error keys this module produces (besides invalid / forbidden / not_found / rate_limited and the stock and posting keys). */
export const ORDER_ERROR_KEYS = ["transition_not_allowed", "transition_payment_driven", "order_changed", "serials_required", "stock_not_reserved", "period_closed"] as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BAGHDAD_OFFSET_MS = 3 * HOUR_MS;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");

export const TransitionOptions = z.object({
  /** Why. Required for cancelled and returned (at least 3 characters). */
  reason: z.string().trim().max(500, "too_long").optional(),
  /**
   * shipped → returned only: what happens to the goods of each line. Default: every unit that left
   * comes back and is restocked where it left from.
   */
  goods: z
    .array(
      z.object({
        orderItemId: idSchema,
        qty: z.number().int("invalid").min(1, "too_small").max(1000, "too_big"),
        disposition: z.enum(RETURN_DISPOSITIONS),
        serialIds: z.array(idSchema).max(1000).optional(),
      }),
    )
    .max(200)
    .optional(),
  /** Where restocked goods go (default: where they left from). */
  locationId: idSchema.optional(),
  /**
   * The status (or statuses) the caller decided on. When the order has moved on to another status
   * since — a proof arrived while a job was cancelling an unpaid order — nothing is done:
   * AppError("order_changed", 409). Checked again after every retry. Omit to move from any status
   * the state machine allows.
   */
  from: z.union([z.enum(ORDER_STATUSES), z.array(z.enum(ORDER_STATUSES)).min(1)]).optional(),
});
export type TransitionOptions = z.input<typeof TransitionOptions>;

/** The permission a transition needs (the admin uses it to decide which actions to offer). */
export function transitionPermission(from: OrderStatus, to: OrderStatus): Permission {
  switch (to) {
    case "confirmed":
      return "orders.order.update";
    case "preparing":
      return "orders.fulfillment.pack";
    case "shipped":
      return "orders.fulfillment.ship";
    case "delivered":
      return "orders.fulfillment.deliver";
    case "cancelled":
      return "orders.order.cancel";
    case "returned":
      return from === "shipped" ? "shipping.attempt.manage" : "returns.rma.approve";
    default:
      return "orders.order.update";
  }
}

const AUDIT_VERB: Partial<Record<OrderStatus, string>> = {
  confirmed: "confirm",
  preparing: "prepare",
  shipped: "ship",
  delivered: "deliver",
  cancelled: "cancel",
  returned: "return",
};

/** `months` calendar months after `at` in Asia/Baghdad (31 January + 1 month = 28/29 February). */
export function addMonthsBaghdad(at: number, months: number): number {
  const local = new Date(at + BAGHDAD_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const target = Date.UTC(year, month, Math.min(local.getUTCDate(), lastDay), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds());
  return target - BAGHDAD_OFFSET_MS;
}

async function journalExists(db: Db, key: string): Promise<boolean> {
  const row = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.idempotencyKey, key)).get();
  return row !== undefined;
}

type Ctx = { actor: Actor; order: Order; to: OrderStatus; reason: string; now: number; options: z.output<typeof TransitionOptions> };

/** The guarded status change: fails the batch with ORDER_CHANGED when someone moved the order meanwhile. */
function statusStatements(db: Db, ctx: Ctx, set: Partial<NewOrder> = {}): BatchStatement[] {
  return [
    db
      .update(orders)
      .set({ status: ctx.to, updatedAt: ctx.now, ...set })
      .where(and(eq(orders.id, ctx.order.id), eq(orders.status, ctx.order.status))),
    expectChanged(db, 1, { code: "ORDER_CHANGED", detail: ctx.order.id }),
  ];
}

function recordStatements(db: Db, ctx: Ctx, data: Record<string, unknown> = {}): BatchStatement[] {
  const { actorKind, actorId } = actorRef(ctx.actor);
  return [
    db.insert(orderEvents).values({
      id: newId("oev"),
      orderId: ctx.order.id,
      kind: "status_changed",
      data: { from: ctx.order.status, to: ctx.to, reason: ctx.reason || null, ...data },
      actorKind,
      actorId,
      at: ctx.now,
    }),
    auditStatement(db, {
      actor: ctx.actor,
      action: `orders.order.${AUDIT_VERB[ctx.to] ?? "update"}`,
      entityType: "order",
      entityId: ctx.order.id,
      summary: `${ctx.order.ref}: ${ctx.order.status} → ${ctx.to}`,
      before: { status: ctx.order.status },
      after: { status: ctx.to, ...data },
      reason: ctx.reason || null,
      at: ctx.now,
    }),
  ];
}

/** Pending refunds of everything still refundable on the order's paid payments (cancel / returned undelivered). */
async function refundPathStatements(db: Db, ctx: Ctx): Promise<{ statements: BatchStatement[]; refundIds: string[] }> {
  const paid = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.orderId, ctx.order.id), eq(payments.status, "paid")));
  const statements: BatchStatement[] = [];
  const refundIds: string[] = [];
  for (const payment of paid) {
    const amountIqd = await getRefundableAmount(db, payment.id);
    const request = refundRequestStatements(db, { order: ctx.order, payment, amountIqd, reason: ctx.reason, actor: ctx.actor, now: ctx.now });
    statements.push(...request.statements);
    if (request.refundId) refundIds.push(request.refundId);
  }
  return { statements, refundIds };
}

/** Statements shared by cancel and "returned undelivered": the coupon use is freed, unpaid payment rows are cancelled. */
function unwindStatements(db: Db, ctx: Ctx): BatchStatement[] {
  return [
    batchSql(db, sql`UPDATE coupon_redemptions SET voided_at = ${ctx.now} WHERE order_id = ${ctx.order.id} AND voided_at IS NULL`),
    batchSql(db, sql`UPDATE payments SET status = 'cancelled', updated_at = ${ctx.now} WHERE order_id = ${ctx.order.id} AND status IN ('pending', 'pending_verification', 'rejected')`),
  ];
}

/** The order's payment status once nothing unpaid is owed any more: unchanged when money was received. */
function unwoundPaymentStatus(order: Order): NewOrder["paymentStatus"] {
  return order.paidIqd > 0 ? order.paymentStatus : "unpaid";
}

async function planCancel(db: Db, ctx: Ctx): Promise<BatchStatement[]> {
  const refundPath = await refundPathStatements(db, ctx);
  const itemsOfOrder = sql`(SELECT id FROM order_items WHERE order_id = ${ctx.order.id})`;
  return [
    ...statusStatements(db, ctx, { cancelledAt: ctx.now, cancelReason: ctx.reason, paymentStatus: unwoundPaymentStatus(ctx.order) }),
    ...releaseOrderReservationsStatements(db, { orderId: ctx.order.id, actor: ctx.actor, reason: `order_cancelled: ${ctx.reason}`, now: ctx.now }),
    // Units scanned onto the order while packing never left: back to stock, link released (history kept).
    batchSql(
      db,
      sql`UPDATE serials SET status = 'in_stock', updated_at = ${ctx.now}
        WHERE status = 'sold' AND id IN (SELECT serial_id FROM order_item_serials WHERE released_at IS NULL AND order_item_id IN ${itemsOfOrder})`,
    ),
    batchSql(db, sql`UPDATE order_item_serials SET released_at = ${ctx.now} WHERE released_at IS NULL AND order_item_id IN ${itemsOfOrder}`),
    ...unwindStatements(db, ctx),
    ...refundPath.statements,
    ...recordStatements(db, ctx, { refundRequests: refundPath.refundIds }),
  ];
}

async function planShip(db: Db, ctx: Ctx): Promise<BatchStatement[]> {
  const items = await db.select({ id: orderItems.id, variantId: orderItems.variantId, usedUnitId: orderItems.usedUnitId, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, ctx.order.id));
  const stockItems = items.filter((item) => !item.usedUnitId);
  const usedItems = items.filter((item) => item.usedUnitId);

  // What each line is made of in stock terms, and which of those variants track serials.
  const lineVariants = [...new Set(stockItems.map((item) => item.variantId))];
  const components = lineVariants.length
    ? await db.select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, lineVariants))
    : [];
  const partsOf = (variantId: string) => {
    const parts = components.filter((row) => row.bundleId === variantId).map((row) => ({ variantId: row.componentId, qty: row.qty }));
    return parts.length ? parts : [{ variantId, qty: 1 }];
  };
  const partVariants = [...new Set(stockItems.flatMap((item) => partsOf(item.variantId).map((part) => part.variantId)))];
  const tracked = new Set(
    partVariants.length ? (await db.select({ id: variants.id }).from(variants).where(and(inArray(variants.id, partVariants), eq(variants.trackSerials, true)))).map((row) => row.id) : [],
  );
  const attached = stockItems.length
    ? await db
        .select({ orderItemId: orderItemSerials.orderItemId, serialVariantId: serials.variantId })
        .from(orderItemSerials)
        .innerJoin(serials, eq(serials.id, orderItemSerials.serialId))
        .where(and(inArray(orderItemSerials.orderItemId, stockItems.map((item) => item.id)), isNull(orderItemSerials.releasedAt)))
    : [];

  let expectedUnits = 0;
  for (const item of stockItems) {
    for (const part of partsOf(item.variantId)) {
      const units = part.qty * item.qty;
      expectedUnits += units;
      if (!tracked.has(part.variantId)) continue;
      const scanned = attached.filter((row) => row.orderItemId === item.id && row.serialVariantId === part.variantId).length;
      if (scanned !== units) throw new AppError("serials_required", 409, { detail: item.id, fields: { items: "serials_required" } });
    }
  }

  const commit = await commitOrderReservationsStatements(db, ctx.actor, ctx.order.id, ctx.now);
  if (commit.result.units !== expectedUnits || commit.result.usedUnits !== usedItems.length) {
    throw new AppError("stock_not_reserved", 409, { detail: `${ctx.order.id}: ${commit.result.units}/${expectedUnits} units, ${commit.result.usedUnits}/${usedItems.length} used units held` });
  }
  return [
    ...statusStatements(db, ctx, { shippedAt: ctx.now }),
    ...commit.statements,
    ...recordStatements(db, ctx, { units: commit.result.units, usedUnits: commit.result.usedUnits }),
  ];
}

async function planDeliver(db: Db, ctx: Ctx): Promise<BatchStatement[]> {
  const order = ctx.order;
  const items = await db
    .select({ id: orderItems.id, usedUnitId: orderItems.usedUnitId, qty: orderItems.qty, warrantyMonths: orderItems.warrantyMonths, warrantyDays: orderItems.warrantyDays })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const itemIds = items.map((item) => item.id);
  const [sale, used, attached] = await Promise.all([
    db
      .select({
        cost: sql<number>`coalesce(sum(-${stockMovements.qtyDelta} * ${stockMovements.unitCostIqd}), 0)`,
        uncosted: sql<number>`coalesce(sum(CASE WHEN ${stockMovements.unitCostIqd} IS NULL THEN -${stockMovements.qtyDelta} ELSE 0 END), 0)`,
      })
      .from(stockMovements)
      .where(and(eq(stockMovements.refType, "order"), eq(stockMovements.refId, order.id), eq(stockMovements.kind, "sale")))
      .get(),
    itemIds.length
      ? db
          .select({ cost: sql<number>`coalesce(sum(${usedUnits.acquisitionCostIqd}), 0)`, uncosted: sql<number>`coalesce(sum(CASE WHEN ${usedUnits.acquisitionCostIqd} IS NULL THEN 1 ELSE 0 END), 0)` })
          .from(usedUnits)
          .where(inArray(usedUnits.soldOrderItemId, itemIds))
          .get()
      : Promise.resolve(undefined),
    itemIds.length
      ? db
          .select({ orderItemId: orderItemSerials.orderItemId, serialId: orderItemSerials.serialId })
          .from(orderItemSerials)
          .where(and(inArray(orderItemSerials.orderItemId, itemIds), isNull(orderItemSerials.releasedAt)))
      : Promise.resolve([]),
  ]);
  const cogsIqd = Number(sale?.cost ?? 0) + Number(used?.cost ?? 0);
  const uncostedUnits = Number(sale?.uncosted ?? 0) + Number(used?.uncosted ?? 0);

  // Warranties start now: one per scanned serial, otherwise one for the line.
  const warrantyRows: NewWarranty[] = [];
  for (const item of items) {
    const months = item.warrantyMonths ?? 0;
    const days = item.warrantyDays ?? 0;
    if (months <= 0 && days <= 0) continue;
    const endsAt = months > 0 ? addMonthsBaghdad(ctx.now, months) : ctx.now + days * DAY_MS;
    const lineSerials = attached.filter((row) => row.orderItemId === item.id).map((row) => row.serialId);
    const base = { orderItemId: item.id, customerId: order.customerId, phoneE164: order.contactPhoneE164, startsAt: ctx.now, endsAt, status: "active" as const, usedUnitId: item.usedUnitId, createdAt: ctx.now };
    if (lineSerials.length === 0) warrantyRows.push({ id: newId("wty"), serialId: null, ...base });
    else for (const serialId of lineSerials) warrantyRows.push({ id: newId("wty"), serialId, ...base });
  }

  const posting = { at: ctx.now, createdBy: postedBy(ctx.actor), isDemo: order.isDemo };
  return [
    ...statusStatements(db, ctx, { deliveredAt: ctx.now }),
    ...warrantyRows.map((row) => db.insert(warranties).values(row)),
    ...postSale(db, {
      ...posting,
      orderId: order.id,
      ref: order.ref,
      subtotalIqd: order.subtotalIqd,
      discountIqd: order.discountIqd,
      shippingIqd: order.shippingIqd,
      totalIqd: order.totalIqd,
      taxIqd: order.taxIqd,
      refundedBeforeIqd: order.refundedIqd,
    }),
    ...postCogs(db, { ...posting, orderId: order.id, ref: order.ref, cogsIqd }),
    ...recordStatements(db, ctx, { warranties: warrantyRows.length, uncostedUnits }),
  ];
}

async function planReturned(db: Db, ctx: Ctx): Promise<BatchStatement[]> {
  if (ctx.order.status === "delivered") return [...statusStatements(db, ctx), ...recordStatements(db, ctx)];

  // shipped → returned: the parcel came back undelivered.
  const order = ctx.order;
  let lines: ReturnLine[];
  if (ctx.options.goods && ctx.options.goods.length > 0) {
    lines = ctx.options.goods.map((line) => ({ orderItemId: line.orderItemId, qty: line.qty, disposition: line.disposition, serialIds: line.serialIds }));
  } else {
    const items = await db.select({ id: orderItems.id, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, order.id));
    lines = items.map((item) => ({ orderItemId: item.id, qty: item.qty, disposition: "restock" as const }));
  }
  const goods = await planReturnedGoods(db, { orderId: order.id, lines, actor: ctx.actor, now: ctx.now, reason: "order_returned_undelivered", locationId: ctx.options.locationId ?? null });
  const cogsPosted = await journalExists(db, cogsPostingKey(order.id));
  const refundPath = await refundPathStatements(db, ctx);
  return [
    ...statusStatements(db, ctx, { paymentStatus: unwoundPaymentStatus(order) }),
    ...goods.statements,
    ...postReturnedGoods(db, {
      key: `order:${order.id}:returned`,
      refType: "order",
      refId: order.id,
      orderId: order.id,
      ref: order.ref,
      restockedCostIqd: goods.restockedCostIqd,
      scrappedCostIqd: goods.scrappedCostIqd,
      cogsPosted,
      at: ctx.now,
      createdBy: postedBy(ctx.actor),
      isDemo: order.isDemo,
    }),
    ...unwindStatements(db, ctx),
    ...refundPath.statements,
    ...recordStatements(db, ctx, { units: goods.units, refundRequests: refundPath.refundIds }),
  ];
}

async function planTransition(db: Db, ctx: Ctx): Promise<BatchStatement[]> {
  switch (ctx.to) {
    case "confirmed":
      return [...statusStatements(db, ctx, { confirmedAt: ctx.order.confirmedAt ?? ctx.now }), ...recordStatements(db, ctx)];
    case "preparing":
      return [...statusStatements(db, ctx), ...recordStatements(db, ctx)];
    case "shipped":
      return planShip(db, ctx);
    case "delivered":
      return planDeliver(db, ctx);
    case "cancelled":
      return planCancel(db, ctx);
    case "returned":
      return planReturned(db, ctx);
    default:
      throw new AppError("transition_payment_driven", 409, { detail: `${ctx.order.status}→${ctx.to}` });
  }
}

const RETRYABLE = ["ORDER_CHANGED", "COST_LAYER_CHANGED", "RESERVATION_CHANGED", "USED_UNIT_CHANGED"] as const;

function translateTransitionError(error: unknown): unknown {
  const posting = mapPostingError(error);
  if (posting) return posting;
  const info = mapDbError(error);
  switch (info?.code) {
    case "ORDER_CHANGED":
      return new AppError("order_changed", 409, { detail: info.detail, cause: error });
    case "RETURN_EXCEEDS_SHIPPED":
    case "SERIAL_NOT_RETURNABLE":
      return new AppError("return_exceeds_shipped", 409, { detail: info.detail, cause: error });
    case "COST_LAYER_CHANGED":
    case "RESERVATION_CHANGED":
    case "USED_UNIT_CHANGED":
      return new AppError("order_changed", 409, { detail: info.detail, cause: error });
    default:
      return toAppError(error) ?? error;
  }
}

/**
 * Moves an order to `to` with its side effects (file header). Throws AppError: invalid (400, a
 * missing reason), forbidden (403), not_found (404), transition_not_allowed ·
 * transition_payment_driven · order_changed · serials_required · stock_not_reserved ·
 * return_exceeds_shipped · period_closed (409). Nothing is written when it throws.
 */
export async function transitionOrder(db: Db, actor: Actor, orderId: string, to: OrderStatus, opts: TransitionOptions, now: number): Promise<void> {
  const target = z.enum(ORDER_STATUSES).parse(to);
  const options = TransitionOptions.parse(opts ?? {});
  const reason = options.reason ?? "";
  const expectedFrom = options.from === undefined ? null : Array.isArray(options.from) ? options.from : [options.from];
  for (let attempt = 1; ; attempt++) {
    const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw notFound("order");
    if (order.status === target) return;
    // The caller decided on an earlier read; on a retry after ORDER_CHANGED this is what stops a
    // cancel planned for an unpaid order from landing on one whose proof has just arrived.
    if (expectedFrom && !expectedFrom.includes(order.status)) throw new AppError("order_changed", 409, { detail: `${order.status}, expected ${expectedFrom.join("|")}` });
    if (isPaymentDriven(order.status, target)) throw new AppError("transition_payment_driven", 409, { detail: `${order.status}→${target}` });
    if (!canTransition(order.status, target)) throw new AppError("transition_not_allowed", 409, { detail: `${order.status}→${target}` });
    assertCan(actor, transitionPermission(order.status, target));
    if ((target === "cancelled" || target === "returned") && reason.length < 3) throw invalid({ reason: "required" });

    const statements = await planTransition(db, { actor, order, to: target, reason, now, options });
    try {
      await runBatch(db, statements);
      return;
    } catch (error) {
      // Someone moved the order or consumed the same cost layer meanwhile: look again (the order may
      // already be where we wanted it, which makes this call a no-op).
      if (attempt < 3 && RETRYABLE.some((code) => isDbError(error, code))) continue;
      throw translateTransitionError(error);
    }
  }
}

// ───────────────────────────────────────────────────────────────── reads

/** "tt-7k4m2q9x " → "TT-7K4M2Q9X"; null for anything that cannot be an order reference. */
export function normalizeOrderRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const value = ref.trim().toUpperCase();
  return /^[A-Z]{2,4}-[A-Z0-9]{4,16}$/.test(value) ? value : null;
}

/** The order `ref` of this customer, or null (also for another customer's order). */
export async function getOrderForCustomer(db: Db, customerId: string, ref: string, locale: Locale, now: number = Date.now()): Promise<OrderView | null> {
  const normalized = normalizeOrderRef(ref);
  if (!normalized || !customerId) return null;
  const order = await db
    .select()
    .from(orders)
    .where(and(eq(orders.ref, normalized), eq(orders.customerId, customerId)))
    .get();
  return order ? buildOrderView(db, order, locale, now) : null;
}

/** The confirmation-page link of a guest order (/order/<ref>?t=<token>): the token must match the stored hash. */
export async function getOrderByAccessToken(db: Db, ref: string, accessToken: string, locale: Locale, now: number = Date.now()): Promise<OrderView | null> {
  const normalized = normalizeOrderRef(ref);
  if (!normalized || typeof accessToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(accessToken)) return null;
  const order = await db.select().from(orders).where(eq(orders.ref, normalized)).get();
  const hash = await sha256Hex(accessToken);
  if (!order || !order.accessTokenHash || !timingSafeEqual(order.accessTokenHash, hash)) return null;
  return buildOrderView(db, order, locale, now);
}

/**
 * Guest order lookup: needs the reference AND the phone the order was placed with. Malformed input
 * is a field error (it reveals nothing); after that, a wrong reference and a wrong phone get exactly
 * the same answer (null), and every attempt counts against two limits — per IP and per reference —
 * so neither phones nor references can be enumerated. Over the limit: AppError("rate_limited", 429).
 */
export async function lookupGuestOrder(db: Db, input: { ref: string; phone: string }, ctx: { ip: string | null; locale?: Locale }, now: number): Promise<OrderView | null> {
  const ref = normalizeOrderRef(input?.ref);
  const phone = normalizeIraqPhone(typeof input?.phone === "string" ? input.phone : null);
  const fields: Record<string, string> = {};
  if (!ref) fields.ref = typeof input?.ref === "string" && input.ref.trim() ? "invalid" : "required";
  if (!phone) fields.phone = typeof input?.phone === "string" && input.phone.trim() ? "phone_invalid" : "required";
  if (Object.keys(fields).length > 0) throw invalid(fields);

  await enforceRateLimit(db, await limitKey("order_lookup", "ip", ctx?.ip), RATE_LIMITS.orderLookup, now);
  await enforceRateLimit(db, await limitKey("order_lookup", "ref", ref), RATE_LIMITS.orderLookupRef, now);

  const order = await db.select().from(orders).where(eq(orders.ref, ref as string)).get();
  // Compare even when there is no order (same length as a real number), so both kinds of miss cost the same.
  const stored = order?.contactPhoneE164 ?? "+0000000000000";
  const matches = timingSafeEqual(stored, phone as string) && order !== undefined;
  if (!matches || !order) return null;
  return buildOrderView(db, order, ctx?.locale ?? order.locale, now);
}

export type OrderPage = { cursor?: string | null; limit?: number };

function parseCursor(cursor: string | null | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const match = /^(\d{1,16}):([A-Za-z0-9_.:-]{1,128})$/.exec(cursor);
  return match ? { at: Number(match[1]), id: match[2] } : null;
}

/** "My orders", newest first (keyset pages: pass `nextCursor` back as `cursor`). */
export async function listOrdersForCustomer(db: Db, customerId: string, locale: Locale, page: OrderPage = {}): Promise<Paged<OrderSummary>> {
  const limit = Math.min(Math.max(Math.floor(page.limit ?? 10), 1), 50);
  const cursor = parseCursor(page.cursor);
  const mine = eq(orders.customerId, customerId);
  const where = cursor ? and(mine, or(lt(orders.placedAt, cursor.at), and(eq(orders.placedAt, cursor.at), lt(orders.id, cursor.id)))) : mine;
  const [rows, total] = await Promise.all([
    db.select().from(orders).where(where).orderBy(desc(orders.placedAt), desc(orders.id)).limit(limit + 1),
    db.select({ n: sql<number>`count(*)` }).from(orders).where(mine).get(),
  ]);
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: await buildOrderSummaries(db, pageRows, locale),
    total: Number(total?.n ?? 0),
    nextCursor: rows.length > limit && last ? `${last.placedAt}:${last.id}` : null,
  };
}
