/**
 * Refunds (docs/CONTRACTS.md §1, ARCHITECTURE §7.4, admin 05/12) — money back to a customer,
 * always tied to the payment it came from and bounded by the database:
 *   Σ refunds of a payment (not rejected/cancelled) ≤ what that payment paid   TT:REFUND_EXCEEDS_PAYMENT
 *   Σ refunded quantity of an order line ≤ quantity bought                      TT:REFUND_QTY_EXCEEDS
 *   orders.refunded_iqd ≤ orders.paid_iqd                                       TT:ORDER_REFUND_EXCEEDS_PAID
 *
 *   const { refundId, status } = await createRefund(db, actor, { orderId, paymentId, items, amountIqd, method, reason }, now);
 *   await approveRefund(db, otherEmployee, refundId, { approve: true, note }, now);   // when status was "pending"
 *
 * WHO
 *   · createRefund needs orders.refund.create. A refund up to the owner's threshold
 *     (settings "refunds.approval_threshold_iqd", default 0 = none) is issued at once. Anything above
 *     it is stored as `pending` — it already counts against the bounds — with an `approvals` row,
 *     and is issued only by approveRefund: orders.refund.approve held by a DIFFERENT employee than
 *     the one who requested it (four eyes on money leaving).
 *   · A paid order that is cancelled starts the same path: transitionOrder adds a pending refund of
 *     what is left to refund on each paid payment (refundRequestStatements).
 *
 * WHERE THE MONEY GOES
 *   wallet                       a wallet credit (ledger row in the same batch); needs a customer account
 *   cash                         handed over in cash
 *   original                     wallet → wallet credit · cash on delivery → cash · bank transfer / Zain Cash →
 *                                an outgoing transfer whose `reference` the issuer records (required)
 *
 * GOODS
 *   Each refunded line may say what happens to the goods that came back: `disposition: "restock"`
 *   or `"scrap"` (decided by the caller after inspection; see orders/returns.server). Without a
 *   disposition the refund only counts the quantity (goods kept by the customer, never shipped, or
 *   already back through a failed delivery). An amount-only refund has no items.
 *
 * BOOKS
 *   Issuing posts, in the same batch: Dr sales refunds (or Dr customer control when the order was
 *   never delivered — nothing was recognised as revenue), Cr the account the money leaves from; and
 *   for returned goods the inventory / COGS / write-off entries of postReturnedGoods.
 *
 * Must not import "cloudflare:workers".
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  approvals,
  journalEntries,
  orderEvents,
  orderItems,
  orders,
  payments,
  refundItems,
  refunds,
  REFUND_METHODS,
  type Order,
  type Payment,
  type PaymentMethod,
  type Refund,
  type RefundMethod,
} from "~/server/db/schema";
import { chunkRows, expectChanged, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound, toAppError } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { cogsPostingKey, mapPostingError, postRefund, postReturnedGoods, postedBy, salePostingKey } from "./accounting/post.server";
import { RETURN_DISPOSITIONS, planReturnedGoods, type ReturnLine } from "./orders/returns.server";
import { walletCreditStatement } from "./wallet.server";

export const REFUND_ERROR_KEYS = [
  "payment_not_paid",
  "refund_exceeds_payment",
  "refund_qty_exceeds",
  "refund_not_pending",
  "approver_is_requester",
  "reference_required",
  "wallet_requires_account",
  "return_exceeds_shipped",
  "serials_required",
  "serial_not_on_line",
  "idempotency_mismatch",
] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
const LIVE_REFUND = ["rejected", "cancelled"] as const;

export const RefundItemInput = z.object({
  orderItemId: idSchema,
  qty: z.number().int("invalid").min(1, "too_small").max(1000, "too_big"),
  /** What happens to the goods that came back. Omit when nothing comes back. */
  disposition: z.enum(RETURN_DISPOSITIONS).optional(),
  /** Serial-tracked units: which ones came back (optional when the whole line comes back). */
  serialIds: z.array(idSchema).max(1000).optional(),
});

export const CreateRefundInput = z.object({
  orderId: idSchema,
  paymentId: idSchema,
  items: z.array(RefundItemInput).max(200).default([]),
  amountIqd: z.number().int("invalid").min(1, "too_small").max(10_000_000_000, "too_big"),
  method: z.enum(REFUND_METHODS),
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
  /** Outgoing transfer reference — required to issue an 'original' refund of a bank / Zain Cash payment. */
  reference: z.string().trim().min(1, "required").max(100, "too_long").optional(),
  /** A retry with the same key returns the first refund. */
  idempotencyKey: z.string().trim().min(8, "too_short").max(200, "too_long").optional(),
  /** Where restocked goods go (default: where they left from). */
  locationId: idSchema.optional(),
});
export type CreateRefundInput = z.input<typeof CreateRefundInput>;
type RefundItem = z.output<typeof RefundItemInput>;

/** What an approval carries until the refund is issued. */
type RefundPayload = { items: RefundItem[]; reference: string | null; locationId: string | null };

type Destination = { wallet: boolean; account: "wallet_liability" | "cash" | "bank_clearing"; needsReference: boolean };

/** Where the money of a refund goes, by the refund method and the original payment method. */
export function refundDestination(method: RefundMethod, paymentMethod: PaymentMethod): Destination {
  if (method === "wallet") return { wallet: true, account: "wallet_liability", needsReference: false };
  if (method === "cash") return { wallet: false, account: "cash", needsReference: false };
  switch (paymentMethod) {
    case "wallet":
      return { wallet: true, account: "wallet_liability", needsReference: false };
    case "cod":
    case "pos_cash":
      return { wallet: false, account: "cash", needsReference: false };
    case "bank_transfer":
    case "zaincash":
      return { wallet: false, account: "bank_clearing", needsReference: true };
    case "pos_card":
      return { wallet: false, account: "bank_clearing", needsReference: false };
  }
}

/** Amount still refundable on a payment: its paid amount minus every refund not rejected/cancelled. */
export async function getRefundableAmount(db: Db, paymentId: string): Promise<number> {
  const [payment, used] = await Promise.all([
    db.select({ status: payments.status, amountIqd: payments.amountIqd }).from(payments).where(eq(payments.id, paymentId)).get(),
    db
      .select({ total: sql<number>`coalesce(sum(${refunds.amountIqd}), 0)` })
      .from(refunds)
      .where(and(eq(refunds.paymentId, paymentId), notInArray(refunds.status, LIVE_REFUND)))
      .get(),
  ]);
  if (!payment || payment.status !== "paid") return 0;
  return Math.max(0, payment.amountIqd - Number(used?.total ?? 0));
}

function translateRefundError(error: unknown): unknown {
  const posting = mapPostingError(error);
  if (posting) return posting;
  const info = mapDbError(error);
  if (!info) return error;
  switch (info.code) {
    case "REFUND_EXCEEDS_PAYMENT":
    case "ORDER_REFUND_EXCEEDS_PAID":
      return new AppError("refund_exceeds_payment", 409, { detail: info.detail, cause: error });
    case "REFUND_QTY_EXCEEDS":
      return new AppError("refund_qty_exceeds", 409, { detail: info.detail, fields: { items: "refund_qty_exceeds" }, cause: error });
    case "REFUND_NOT_PENDING":
      return new AppError("refund_not_pending", 409, { detail: info.detail, cause: error });
    case "RETURN_EXCEEDS_SHIPPED":
    case "SERIAL_NOT_RETURNABLE":
      return new AppError("return_exceeds_shipped", 409, { detail: info.detail, cause: error });
    default:
      return toAppError(error) ?? error;
  }
}

function refundItemStatements(db: Db, refundId: string, items: readonly RefundItem[]): BatchStatement[] {
  const rows = items.map((item) => ({ refundId, orderItemId: item.orderItemId, qty: item.qty }));
  return chunkRows(refundItems, rows).map((part) => db.insert(refundItems).values(part));
}

async function journalExists(db: Db, key: string): Promise<boolean> {
  const row = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.idempotencyKey, key)).get();
  return row !== undefined;
}

/**
 * The statements that ISSUE a refund (money and goods), for a refund row that is being inserted as
 * paid (`insert`) or updated from pending (`fromPending`). Validates destination and goods first.
 */
async function issueStatements(
  db: Db,
  args: {
    refund: { id: string; amountIqd: number; method: RefundMethod; reason: string | null };
    order: Order;
    payment: Payment;
    items: RefundItem[];
    reference: string | null;
    locationId: string | null;
    actor: Actor;
    now: number;
    mode: { insert: Refund } | { fromPending: true };
    extra?: BatchStatement[];
  },
): Promise<BatchStatement[]> {
  const { refund, order, payment, actor, now } = args;
  const destination = refundDestination(refund.method, payment.method);
  if (destination.wallet && !order.customerId) throw new AppError("wallet_requires_account", 409, { fields: { method: "wallet_requires_account" } });
  if (destination.needsReference && !args.reference) throw invalid({ reference: "reference_required" });

  const goodsLines: ReturnLine[] = args.items.filter((item) => item.disposition).map((item) => ({ orderItemId: item.orderItemId, qty: item.qty, disposition: item.disposition!, serialIds: item.serialIds }));
  const goods = goodsLines.length ? await planReturnedGoods(db, { orderId: order.id, lines: goodsLines, actor, now, reason: `refund:${refund.id}`, locationId: args.locationId }) : null;
  const [revenueRecognized, cogsPosted] = await Promise.all([journalExists(db, salePostingKey(order.id)), goods ? journalExists(db, cogsPostingKey(order.id)) : Promise.resolve(false)]);

  const ledgerId = destination.wallet ? newId("wal") : null;
  const approvedBy = postedBy(actor);
  const statements: BatchStatement[] = [];
  if ("insert" in args.mode) {
    statements.push(db.insert(refunds).values({ ...args.mode.insert, status: "paid", approvedBy, approvedAt: now, paidAt: now, walletLedgerId: ledgerId, reference: args.reference }));
    statements.push(...refundItemStatements(db, refund.id, args.items));
  } else {
    statements.push(
      db
        .update(refunds)
        .set({ status: "paid", approvedBy, approvedAt: now, paidAt: now, walletLedgerId: ledgerId, reference: args.reference })
        .where(and(eq(refunds.id, refund.id), eq(refunds.status, "pending"))),
      expectChanged(db, 1, { code: "REFUND_NOT_PENDING", detail: refund.id }),
    );
  }
  for (const item of args.items) {
    statements.push(
      db
        .update(orderItems)
        .set({ refundedQty: sql`${orderItems.refundedQty} + ${item.qty}` })
        .where(and(eq(orderItems.id, item.orderItemId), eq(orderItems.orderId, order.id))),
    );
  }
  statements.push(
    db
      .update(orders)
      .set({
        refundedIqd: sql`${orders.refundedIqd} + ${refund.amountIqd}`,
        paymentStatus: sql`CASE WHEN ${orders.refundedIqd} + ${refund.amountIqd} >= ${orders.paidIqd} THEN 'refunded' ELSE 'partially_refunded' END`,
        updatedAt: now,
      })
      .where(eq(orders.id, order.id)),
  );
  if (ledgerId && order.customerId) {
    statements.push(
      walletCreditStatement(db, {
        id: ledgerId,
        customerId: order.customerId,
        amountIqd: refund.amountIqd,
        kind: "refund",
        refType: "refund",
        refId: refund.id,
        reason: refund.reason,
        idempotencyKey: `refund:${refund.id}`,
        actor,
        now,
      }),
    );
  }
  if (goods) statements.push(...goods.statements);
  statements.push(
    ...postRefund(db, { refundId: refund.id, orderId: order.id, ref: order.ref, amountIqd: refund.amountIqd, paidFrom: destination.account, revenueRecognized, at: now, createdBy: approvedBy, isDemo: order.isDemo }),
  );
  if (goods) {
    statements.push(
      ...postReturnedGoods(db, {
        key: `refund:${refund.id}`,
        refType: "refund",
        refId: refund.id,
        orderId: order.id,
        ref: order.ref,
        restockedCostIqd: goods.restockedCostIqd,
        scrappedCostIqd: goods.scrappedCostIqd,
        cogsPosted,
        at: now,
        createdBy: approvedBy,
        isDemo: order.isDemo,
      }),
    );
  }
  const { actorKind, actorId } = actorRef(actor);
  statements.push(
    ...(args.extra ?? []),
    db.insert(orderEvents).values({
      id: newId("oev"),
      orderId: order.id,
      kind: "refunded",
      data: { refundId: refund.id, amountIqd: refund.amountIqd, method: refund.method, wallet: destination.wallet, goods: goods ? { units: goods.units } : null },
      actorKind,
      actorId,
      at: now,
    }),
    auditStatement(db, {
      actor,
      action: "orders.refund.issue",
      entityType: "refund",
      entityId: refund.id,
      after: { orderId: order.id, paymentId: payment.id, amountIqd: refund.amountIqd, method: refund.method, to: destination.account, reference: args.reference, items: args.items.map((item) => ({ orderItemId: item.orderItemId, qty: item.qty, disposition: item.disposition ?? null })) },
      reason: refund.reason,
      at: now,
    }),
  );
  return statements;
}

async function loadOrderAndPayment(db: Db, orderId: string, paymentId: string): Promise<{ order: Order; payment: Payment }> {
  const [order, payment] = await Promise.all([db.select().from(orders).where(eq(orders.id, orderId)).get(), db.select().from(payments).where(eq(payments.id, paymentId)).get()]);
  if (!order) throw notFound("order");
  if (!payment || payment.orderId !== order.id) throw notFound("payment");
  return { order, payment };
}

/**
 * Requests (or, within the threshold, issues) a refund. Returns its id and status: "paid" when it
 * was issued now, "pending" when it waits for approveRefund. Throws AppError: forbidden (403),
 * invalid (400), payment_not_paid · refund_exceeds_payment · refund_qty_exceeds ·
 * wallet_requires_account · return_exceeds_shipped · period_closed (409).
 */
export async function createRefund(db: Db, actor: Actor, raw: CreateRefundInput, now: number): Promise<{ refundId: string; status: "pending" | "paid"; replayed: boolean }> {
  assertCan(actor, "orders.refund.create");
  const input = CreateRefundInput.parse(raw);

  if (input.idempotencyKey) {
    const existing = await db.select().from(refunds).where(eq(refunds.idempotencyKey, input.idempotencyKey)).get();
    if (existing) {
      if (existing.orderId !== input.orderId || existing.amountIqd !== input.amountIqd) throw new AppError("idempotency_mismatch", 409, { detail: input.idempotencyKey });
      return { refundId: existing.id, status: existing.status === "paid" ? "paid" : "pending", replayed: true };
    }
  }

  const { order, payment } = await loadOrderAndPayment(db, input.orderId, input.paymentId);
  if (payment.status !== "paid") throw new AppError("payment_not_paid", 409, { detail: payment.id });
  const refundable = await getRefundableAmount(db, payment.id);
  if (input.amountIqd > refundable) throw new AppError("refund_exceeds_payment", 409, { detail: payment.id, fields: { amountIqd: "refund_exceeds_payment" } });

  const itemIds = input.items.map((item) => item.orderItemId);
  if (new Set(itemIds).size !== itemIds.length) throw invalid({ items: "invalid" });
  if (itemIds.length) {
    const [lines, taken] = await Promise.all([
      db.select({ id: orderItems.id, orderId: orderItems.orderId, qty: orderItems.qty }).from(orderItems).where(inArray(orderItems.id, itemIds)),
      db
        .select({ orderItemId: refundItems.orderItemId, qty: sql<number>`sum(${refundItems.qty})` })
        .from(refundItems)
        .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
        .where(and(inArray(refundItems.orderItemId, itemIds), notInArray(refunds.status, LIVE_REFUND)))
        .groupBy(refundItems.orderItemId),
    ]);
    const takenBy = new Map(taken.map((row) => [row.orderItemId, Number(row.qty)]));
    for (const item of input.items) {
      const line = lines.find((entry) => entry.id === item.orderItemId);
      if (!line || line.orderId !== order.id) throw invalid({ items: "invalid" }, `order item ${item.orderItemId} is not on this order`);
      if (item.qty + (takenBy.get(line.id) ?? 0) > line.qty) throw new AppError("refund_qty_exceeds", 409, { detail: line.id, fields: { items: "refund_qty_exceeds" } });
    }
  }
  const destination = refundDestination(input.method, payment.method);
  if (destination.wallet && !order.customerId) throw new AppError("wallet_requires_account", 409, { fields: { method: "wallet_requires_account" } });

  const threshold = await getSetting(db, "refunds.approval_threshold_iqd");
  const immediate = input.amountIqd <= threshold;
  const refundId = newId("rfd");
  const createdBy = postedBy(actor);
  const row: Refund = {
    id: refundId,
    orderId: order.id,
    paymentId: payment.id,
    amountIqd: input.amountIqd,
    method: input.method,
    reason: input.reason,
    status: "pending",
    approvedBy: null,
    createdBy,
    createdAt: now,
    returnId: null,
    approvedAt: null,
    paidAt: null,
    walletLedgerId: null,
    reference: input.reference ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    rejectReason: null,
  };
  const items: RefundItem[] = input.items;
  const { actorKind, actorId } = actorRef(actor);

  let statements: BatchStatement[];
  if (immediate) {
    statements = await issueStatements(db, {
      refund: { id: refundId, amountIqd: input.amountIqd, method: input.method, reason: input.reason },
      order,
      payment,
      items,
      reference: input.reference ?? null,
      locationId: input.locationId ?? null,
      actor,
      now,
      mode: { insert: row },
      extra: [auditStatement(db, { actor, action: "orders.refund.create", entityType: "refund", entityId: refundId, after: { orderId: order.id, amountIqd: input.amountIqd, method: input.method, threshold, immediate: true }, reason: input.reason, at: now })],
    });
  } else {
    // Validate the goods now, so a request that could never be issued is refused up front.
    const goodsLines: ReturnLine[] = items.filter((item) => item.disposition).map((item) => ({ orderItemId: item.orderItemId, qty: item.qty, disposition: item.disposition!, serialIds: item.serialIds }));
    if (goodsLines.length) await planReturnedGoods(db, { orderId: order.id, lines: goodsLines, actor, now, reason: `refund:${refundId}`, locationId: input.locationId ?? null });
    const payload: RefundPayload = { items, reference: input.reference ?? null, locationId: input.locationId ?? null };
    statements = [
      db.insert(refunds).values(row),
      ...refundItemStatements(db, refundId, items),
      db.insert(approvals).values({
        id: newId("apr"),
        kind: "refund",
        entityType: "refund",
        entityId: refundId,
        requestedBy: createdBy ?? "unknown",
        payload: { orderId: order.id, paymentId: payment.id, amountIqd: input.amountIqd, method: input.method, ...payload },
        status: "pending",
        reason: input.reason,
        createdAt: now,
        requiredPermission: "orders.refund.approve",
      }),
      db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "refund_requested", data: { refundId, amountIqd: input.amountIqd, method: input.method }, actorKind, actorId, at: now }),
      auditStatement(db, { actor, action: "orders.refund.create", entityType: "refund", entityId: refundId, after: { orderId: order.id, paymentId: payment.id, amountIqd: input.amountIqd, method: input.method, threshold, immediate: false, items: items.map((item) => ({ orderItemId: item.orderItemId, qty: item.qty, disposition: item.disposition ?? null })) }, reason: input.reason, at: now }),
    ];
  }

  try {
    await runBatch(db, statements);
  } catch (error) {
    if (input.idempotencyKey && isUniqueViolation(error, "refunds.idempotency_key")) {
      const existing = await db.select().from(refunds).where(eq(refunds.idempotencyKey, input.idempotencyKey)).get();
      if (existing) return { refundId: existing.id, status: existing.status === "paid" ? "paid" : "pending", replayed: true };
    }
    throw translateRefundError(error);
  }
  return { refundId, status: immediate ? "paid" : "pending", replayed: false };
}

/**
 * Issues (approve) or refuses (reject, `note` required) a pending refund. Needs
 * orders.refund.approve, and the approver must not be the employee who requested it
 * (AppError "approver_is_requester", 403). Repeating the same decision is a no-op.
 */
export async function approveRefund(db: Db, actor: Actor, refundId: string, decision: { approve: boolean; note?: string | null; reference?: string | null }, now: number): Promise<{ status: "paid" | "rejected" }> {
  assertCan(actor, "orders.refund.approve");
  const refund = await db.select().from(refunds).where(eq(refunds.id, refundId)).get();
  if (!refund) throw notFound("refund");
  if (refund.status !== "pending") {
    if (decision.approve && refund.status === "paid") return { status: "paid" };
    if (!decision.approve && refund.status === "rejected") return { status: "rejected" };
    throw new AppError("refund_not_pending", 409, { detail: refund.status });
  }
  if (actor.kind === "employee" && refund.createdBy === actor.id) throw new AppError("approver_is_requester", 403, { detail: refund.id });
  const note = typeof decision.note === "string" ? decision.note.trim().slice(0, 500) : "";
  const approval = await db.select().from(approvals).where(and(eq(approvals.entityType, "refund"), eq(approvals.entityId, refund.id), eq(approvals.status, "pending"))).get();
  const decidedBy = postedBy(actor);
  const closeApproval = (status: "approved" | "rejected"): BatchStatement[] =>
    approval ? [db.update(approvals).set({ status, decidedBy, decidedAt: now, decisionNote: note || null }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))] : [];
  const { actorKind, actorId } = actorRef(actor);

  if (!decision.approve) {
    if (note.length < 3) throw invalid({ note: "required" });
    try {
      await runBatch(db, [
        db.update(refunds).set({ status: "rejected", rejectReason: note, approvedBy: null }).where(and(eq(refunds.id, refund.id), eq(refunds.status, "pending"))),
        expectChanged(db, 1, { code: "REFUND_NOT_PENDING", detail: refund.id }),
        ...closeApproval("rejected"),
        db.insert(orderEvents).values({ id: newId("oev"), orderId: refund.orderId, kind: "refund_rejected", data: { refundId: refund.id }, actorKind, actorId, at: now }),
        auditStatement(db, { actor, action: "orders.refund.reject", entityType: "refund", entityId: refund.id, before: { status: "pending" }, after: { status: "rejected" }, reason: note, at: now }),
      ]);
    } catch (error) {
      throw translateRefundError(error);
    }
    return { status: "rejected" };
  }

  const { order, payment } = await loadOrderAndPayment(db, refund.orderId, refund.paymentId);
  const payload = (approval?.payload ?? {}) as Partial<RefundPayload>;
  const storedItems = await db.select({ orderItemId: refundItems.orderItemId, qty: refundItems.qty }).from(refundItems).where(eq(refundItems.refundId, refund.id));
  // Dispositions and serials come from the request; quantities from the stored refund lines.
  const items: RefundItem[] = storedItems.map((item) => {
    const requested = (payload.items ?? []).find((entry) => entry.orderItemId === item.orderItemId);
    return { orderItemId: item.orderItemId, qty: item.qty, disposition: requested?.disposition, serialIds: requested?.serialIds };
  });
  const reference = decision.reference?.trim() || payload.reference || refund.reference || null;
  const statements = await issueStatements(db, {
    refund: { id: refund.id, amountIqd: refund.amountIqd, method: refund.method, reason: refund.reason },
    order,
    payment,
    items,
    reference,
    locationId: payload.locationId ?? null,
    actor,
    now,
    mode: { fromPending: true },
    extra: [
      ...closeApproval("approved"),
      auditStatement(db, { actor, action: "orders.refund.approve", entityType: "refund", entityId: refund.id, before: { status: "pending" }, after: { status: "paid" }, reason: note || null, at: now }),
    ],
  });
  try {
    await runBatch(db, statements);
  } catch (error) {
    throw translateRefundError(error);
  }
  return { status: "paid" };
}

/**
 * Statements that open the refund path for a paid payment (used by order cancellation): a PENDING
 * refund of everything still refundable on it, to the original method, with its approval row.
 * Returns no statements when nothing is refundable. Synchronous on the amounts passed in.
 */
export function refundRequestStatements(
  db: Db,
  input: { order: Pick<Order, "id">; payment: Pick<Payment, "id">; amountIqd: number; reason: string; actor: Actor; now: number },
): { refundId: string | null; statements: BatchStatement[] } {
  if (!Number.isSafeInteger(input.amountIqd) || input.amountIqd <= 0) return { refundId: null, statements: [] };
  const refundId = newId("rfd");
  const createdBy = postedBy(input.actor);
  const { actorKind, actorId } = actorRef(input.actor);
  return {
    refundId,
    statements: [
      db.insert(refunds).values({ id: refundId, orderId: input.order.id, paymentId: input.payment.id, amountIqd: input.amountIqd, method: "original", reason: input.reason, status: "pending", createdBy, createdAt: input.now }),
      db.insert(approvals).values({
        id: newId("apr"),
        kind: "refund",
        entityType: "refund",
        entityId: refundId,
        requestedBy: createdBy ?? "unknown",
        payload: { orderId: input.order.id, paymentId: input.payment.id, amountIqd: input.amountIqd, method: "original", items: [], reference: null, locationId: null, source: "order_cancelled" },
        status: "pending",
        reason: input.reason,
        createdAt: input.now,
        requiredPermission: "orders.refund.approve",
      }),
      db.insert(orderEvents).values({ id: newId("oev"), orderId: input.order.id, kind: "refund_requested", data: { refundId, amountIqd: input.amountIqd, method: "original", source: "order_cancelled" }, actorKind, actorId, at: input.now }),
    ],
  };
}

/** Refunds that wait for a decision (the admin approval queue). */
export async function listPendingRefunds(db: Db, actor: Actor, limit = 50): Promise<Refund[]> {
  if (!can(actor, "orders.refund.approve") && !can(actor, "orders.refund.create")) throw forbidden("orders.refund.approve");
  return db.select().from(refunds).where(eq(refunds.status, "pending")).orderBy(refunds.createdAt).limit(Math.min(Math.max(limit, 1), 200));
}
