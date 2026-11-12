/**
 * Editing an order before it ships (admin 05.05) — docs/CONTRACTS.md §1 "orders/edit.server.ts". A commerce-core file:
 * it moves stock and money owed, so it reuses the core's statement builders and invariants and runs as ONE db.batch.
 *
 *   const plan = await planOrderEdit(db, actor, orderId, { lines: [{ orderItemId, qty: 1 }], reason }, ctx.now);   // preview, writes nothing
 *   const done = await editOrder(db, actor, orderId, { lines, reason, idempotencyKey, expectedTotalIqd: plan.after.totalIqd }, ctx.now);
 *
 * WHAT CAN CHANGE (orders.order.update)
 *   lines     the quantity of a line (0 removes it; a used device is 1 or removed). Adding new products is not offered.
 *   address   contact name, phone, governorate, district, area, address, notes. A new governorate takes today's delivery
 *             fee (getShippingFee — 5,000 IQD everywhere unless the owner enabled overrides); the old one keeps its fee.
 *
 * WHEN (otherwise AppError 409, nothing written)
 *   · the order is new, awaiting_payment, confirmed or preparing, and a web order — edit_not_allowed
 *   · no transfer proof is waiting for a decision — edit_payment_in_review (decide the proof first)
 *   · no refund exists on it — edit_has_refunds
 *   · LINES and TOTALS change only while no money has been received — edit_paid_order. A paid order (wallet, a
 *     verified transfer) whose total went down would need its refund booked as a price change, not as a sales refund:
 *     the delivery posting (postSale) counts every refund issued before delivery as a sales refund. Until the core
 *     can tell the two apart, a paid order is cancelled (refund path, four eyes) or refunded after delivery. An address
 *     change that keeps the total is allowed on a paid order.
 *   · LINES and TOTALS stay as invoiced once the order's numbered invoice is issued (admin 05.06 freezes it) —
 *     edit_invoiced; an address change that keeps the total is still allowed
 *   · a line with a serial scanned onto it (packing) cannot go down or be removed — edit_serials_attached; a line
 *     never goes below the units already verified at the packing station (scanned or confirmed by hand: they are in
 *     the parcel) — edit_units_scanned (editLineFloors gives each line's floor for the form); nothing changes in
 *     lines once a parcel is packed — edit_parcel_packed
 *   · something must change — edit_no_change; at least one line must remain — edit_empty_order (cancel instead)
 *   · PROMOTIONS (2026-11-12): a flash-priced line keeps its claim on the sale (edit_not_allowed, detail "flash_line");
 *     an order priced with an automatic offer, a membership discount or redeemed points is not edited line by line at
 *     all (edit_not_allowed, detail "promotions" — review 2026-11-12: they were worked out on the goods as ordered, and
 *     an offer for one product kind stayed on the others); cancel it instead (its points and offer units come back).
 *     A coupon is re-priced by its own rule (a demo coupon on demo goods only), a waived delivery fee stays waived on a
 *     new governorate (a member's whole fee, a rule's up to what it waived), and either change appends a re-priced
 *     "promotions" record (orders/promotions.server editedPromotionsRecord) — the order page and the invoice add up
 *   · the address's phone may be left out: the order keeps its number (employees without customer.phone.read_full
 *     never see it, so their form leaves it empty)
 *
 * WHAT HAPPENS, in one batch, guarded so a concurrent change aborts it (the order row's version, the reservation and
 * payment rows, and — not on the order row — "no invoice issued meanwhile" and "no unit scanned into a lowered line";
 * it is planned again, up to three times; if the total then differs from `expectedTotalIqd`, the employee's preview
 * was stale → totals_changed):
 *   · lines: quantity and line total updated (CHECK: total = unit × qty − discount), removed lines deleted with their
 *     not-yet-packed parcel rows; the parcels are filled again at the next scan
 *   · STOCK: per stocked variant (bundles = their components) the hold is brought to what the new lines need: more →
 *     reserveStatements (shortage aborts everything: insufficient_stock); less → the newest reservation rows are
 *     released or reduced, with 'release' movements and stock_levels.reserved lowered. A removed used device goes back
 *     on sale (releaseUsedUnitStatements). Holds keep their expiry (a transfer order's proof window).
 *   · MONEY: totals recomputed (subtotal − discount + shipping + tax). A coupon's discount is recomputed with the
 *     coupon's own rule on the remaining lines (fixed amount / basis points of the eligible lines, its cap, its minimum
 *     subtotal and quantity); when it no longer applies the discount becomes 0 and the redemption is voided. The open
 *     payment row (cash on delivery, or the transfer still awaited) now asks for the new total: that is the payment
 *     difference — COD collection, the shopper's next proof and the books all follow from it.
 *   · an order event "edited" (id derived from the idempotency key: a retry returns `replayed: true`) and an audit event
 *     with the before/after lines, totals and address.
 *
 * Must not import "cloudflare:workers".
 */
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { bpsOf } from "~/lib/money";
import { newId, sha256Hex } from "~/lib/ids";
import type { L10n } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { actorRef, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  bundleItems,
  categories,
  couponRedemptions,
  coupons,
  districts,
  invoices,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  products,
  refunds,
  shipmentEvents,
  shipmentItems,
  shipments,
  stockLevels,
  stockMovements,
  stockReservations,
  variants,
  type CouponConditions,
  type Order,
} from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { releaseUsedUnitStatements, reserveStatements } from "../inventory/stock.server";
import { getShippingFee } from "../shipping/fees.server";
import { editedPromotionsRecord, promotionsEventStatement, promotionsRecordOf, type PromotionsRecord } from "./promotions.server";

/** Error keys this module adds (besides invalid / forbidden / not_found / insufficient_stock / shipping_unavailable / order_changed). */
export const EDIT_ERROR_KEYS = [
  "edit_not_allowed",
  "edit_payment_in_review",
  "edit_has_refunds",
  "edit_paid_order",
  "edit_invoiced",
  "edit_serials_attached",
  "edit_units_scanned",
  "edit_parcel_packed",
  "edit_no_change",
  "edit_empty_order",
  "edit_used_unit_qty",
  "edit_line_referenced",
  "totals_changed",
] as const;

/** Units verified at the packing station (scans and confirmations by hand), per order item, as SQL over shipment_events. */
const verifiedUnits = sql`CASE WHEN json_extract(${shipmentEvents.data}, '$.units') > 0 THEN json_extract(${shipmentEvents.data}, '$.units') ELSE 1 END`;

/** Per order item with units verified at the packing station: how many, and how many units one of the line holds. */
async function verifiedByLine(db: Db, orderId: string): Promise<Map<string, { units: number; perQty: number; qty: number }>> {
  const [verified, lines] = await Promise.all([
    db
      .select({ orderItemId: sql<string | null>`json_extract(${shipmentEvents.data}, '$.orderItemId')`, units: sql<number>`sum(${verifiedUnits})` })
      .from(shipmentEvents)
      .innerJoin(shipments, eq(shipments.id, shipmentEvents.shipmentId))
      .where(and(eq(shipments.orderId, orderId), inArray(shipmentEvents.kind, ["scan", "scan_manual"])))
      .groupBy(sql`json_extract(${shipmentEvents.data}, '$.orderItemId')`),
    db.select({ id: orderItems.id, variantId: orderItems.variantId, usedUnitId: orderItems.usedUnitId, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, orderId)),
  ]);
  const out = new Map<string, { units: number; perQty: number; qty: number }>();
  const counted = verified.filter((row) => row.orderItemId && Number(row.units) > 0);
  if (counted.length === 0) return out;
  const variantIds = [...new Set(lines.filter((line) => !line.usedUnitId).map((line) => line.variantId))];
  const parts = variantIds.length ? await db.select({ bundleId: bundleItems.bundleVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, variantIds)) : [];
  for (const row of counted) {
    const line = lines.find((entry) => entry.id === row.orderItemId);
    if (!line) continue;
    // a bundle's units are its components (scanned one by one); anything else is one unit per piece
    const perQty = line.usedUnitId ? 1 : parts.filter((part) => part.bundleId === line.variantId).reduce((sum, part) => sum + part.qty, 0) || 1;
    out.set(line.id, { units: Number(row.units), perQty, qty: line.qty });
  }
  return out;
}

/** Units one of this line holds at the packing station: a bundle's components, otherwise 1. */
async function bundleUnits(db: Db, line: { variantId: string; usedUnitId: string | null }): Promise<number> {
  if (line.usedUnitId) return 1;
  const parts = await db.select({ qty: bundleItems.qty }).from(bundleItems).where(eq(bundleItems.bundleVariantId, line.variantId));
  return parts.reduce((sum, part) => sum + part.qty, 0) || 1;
}

/**
 * The lowest quantity each line may be edited to: units already verified at the packing station (admin 04.11 —
 * scanned, or confirmed by hand) are in the parcel, so the line cannot go below them; a bundle line counts its
 * components (units ÷ components per bundle, rounded up). Lines with nothing verified are absent (floor 0).
 */
export async function editLineFloors(db: Db, orderId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [id, line] of await verifiedByLine(db, orderId)) out.set(id, Math.min(line.qty, Math.ceil(line.units / line.perQty)));
  return out;
}

export const EDITABLE_STATUSES = ["new", "awaiting_payment", "confirmed", "preparing"] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "too_long")
    .nullish()
    .transform((value) => (value ? value : null));

export const EditAddressInput = z.object({
  contactName: optionalText(100),
  /** Empty or absent: the order keeps its number (an employee without customer.phone.read_full never sees it). */
  phone: optionalText(40),
  governorateId: idSchema,
  districtId: z
    .union([z.literal(""), idSchema])
    .nullish()
    .transform((value) => value || null),
  areaText: z.string().trim().min(2, "required").max(200, "too_long"),
  addressText: z.string().trim().min(5, "too_short").max(500, "too_long"),
  notes: optionalText(500),
});

export const EditOrderInput = z.object({
  lines: z
    .array(z.object({ orderItemId: idSchema, qty: z.number().int("invalid").min(0, "too_small").max(1000, "too_big") }))
    .max(200)
    .default([]),
  address: EditAddressInput.optional(),
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
  /** One per confirmed edit (the page makes it): a retry returns the first result. Required by editOrder. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "invalid").optional(),
  /** The new total the employee saw in the preview; when the order changed meanwhile and the total differs → totals_changed. */
  expectedTotalIqd: z.number().int("invalid").min(0, "too_small").optional(),
});
export type EditOrderInput = z.input<typeof EditOrderInput>;

export type EditTotals = { subtotalIqd: number; discountIqd: number; shippingIqd: number; taxIqd: number; totalIqd: number };
export type EditLinePlan = { orderItemId: string; variantId: string; usedUnitId: string | null; sku: string; name: L10n; unitPriceIqd: number; qtyBefore: number; qtyAfter: number };
export type EditPlan = {
  orderId: string;
  ref: string;
  status: Order["status"];
  lines: EditLinePlan[];
  before: EditTotals;
  after: EditTotals;
  /** Per stocked variant: + units newly held for the order, − units released. */
  stock: { variantId: string; sku: string; deltaQty: number }[];
  usedUnitsReleased: string[];
  coupon: { code: string; beforeIqd: number; afterIqd: number; lost: boolean } | null;
  /** The open payment whose amount due changes (cash on delivery, the awaited transfer). */
  payment: { paymentId: string; method: string; fromIqd: number; toIqd: number } | null;
  address: { changed: boolean; shippingBeforeIqd: number; shippingAfterIqd: number };
};

/** Why the lines / the address of this order cannot be edited now (null = they can). Cheap: for the order page. */
export async function orderEditBlockers(db: Db, order: Order): Promise<{ lines: string | null; address: string | null }> {
  if (order.channel !== "web" || !(EDITABLE_STATUSES as readonly string[]).includes(order.status)) return { lines: "edit_not_allowed", address: "edit_not_allowed" };
  const [reviewing, refunded, packed, paid, invoiced, record] = await Promise.all([
    db.select({ id: payments.id }).from(payments).where(and(eq(payments.orderId, order.id), eq(payments.status, "pending_verification"))).get(),
    db
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), notInArray(refunds.status, ["rejected", "cancelled"])))
      .get(),
    db
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(eq(shipments.orderId, order.id), notInArray(shipments.status, ["pending", "cancelled"])))
      .get(),
    db.select({ id: payments.id }).from(payments).where(and(eq(payments.orderId, order.id), eq(payments.status, "paid"))).get(),
    invoiceOf(db, order.id),
    promotionsRecordOf(db, order.id),
  ]);
  if (reviewing) return { lines: "edit_payment_in_review", address: "edit_payment_in_review" };
  if (refunded) return { lines: "edit_has_refunds", address: "edit_has_refunds" };
  // an automatic offer, a membership discount or points: the lines stay as ordered (plan(), review 2026-11-12)
  const promoted = (record?.discounts ?? []).some((entry) => entry.kind !== "coupon");
  const lines = order.paidIqd > 0 || paid ? "edit_paid_order" : invoiced ? "edit_invoiced" : packed ? "edit_parcel_packed" : promoted ? "edit_not_allowed" : null;
  return { lines, address: null };
}

/** The order's numbered invoice, if one was issued (admin 05.06 — its content is frozen). */
function invoiceOf(db: Db, orderId: string) {
  return db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), eq(invoices.kind, "invoice")))
    .get();
}

// ───────────────────────────────────────────────────────────────── coupon

/**
 * The coupon's discount on these lines, by its own rule (the arithmetic of evaluateCoupon in coupons.server.ts,
 * without the date, usage and identity checks, which were settled when the order was placed). 0 when the coupon no
 * longer applies. Kept in step with coupons.server.ts — requested: one shared helper exported by the coupons owner.
 */
async function couponDiscountFor(db: Db, couponId: string, lines: { variantId: string; qty: number; unitPriceIqd: number }[], subtotalIqd: number): Promise<number> {
  const coupon = await db.select().from(coupons).where(eq(coupons.id, couponId)).get();
  if (!coupon || lines.length === 0) return 0;
  const conditions: CouponConditions = coupon.conditions ?? {};
  const has = (list: readonly string[] | undefined): list is readonly string[] => Array.isArray(list) && list.length > 0;
  let eligible = lines;
  // a demo coupon discounts demo goods only (coupons.server.ts, review 2026-11-12)
  if (coupon.isDemo || has(conditions.platformIds) || has(conditions.categoryIds) || has(conditions.productIds) || has(conditions.productKinds)) {
    const rows = await db
      .select({ variantId: variants.id, productId: products.id, platformId: products.platformId, categoryId: products.categoryId, kind: products.kind, isDemo: products.isDemo })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(
        inArray(
          variants.id,
          lines.map((line) => line.variantId),
        ),
      );
    const byVariant = new Map(rows.map((row) => [row.variantId, row]));
    let parentOf = new Map<string, string | null>();
    if (has(conditions.categoryIds)) parentOf = new Map((await db.select({ id: categories.id, parentId: categories.parentId }).from(categories)).map((row) => [row.id, row.parentId]));
    const chain = (categoryId: string | null) => {
      const seen = new Set<string>();
      for (let current = categoryId; current && !seen.has(current); current = parentOf.get(current) ?? null) seen.add(current);
      return seen;
    };
    eligible = lines.filter((line) => {
      const product = byVariant.get(line.variantId);
      if (!product) return false;
      if (coupon.isDemo && !product.isDemo) return false;
      if (has(conditions.productIds) && !conditions.productIds.includes(product.productId)) return false;
      if (has(conditions.productKinds) && !conditions.productKinds.includes(product.kind)) return false;
      if (has(conditions.platformIds) && (!product.platformId || !conditions.platformIds.includes(product.platformId))) return false;
      if (has(conditions.categoryIds)) {
        const ancestors = chain(product.categoryId);
        if (!conditions.categoryIds.some((id) => ancestors.has(id))) return false;
      }
      return true;
    });
  }
  if (eligible.length === 0) return 0;
  const eligibleQty = eligible.reduce((sum, line) => sum + line.qty, 0);
  if (typeof conditions.minQty === "number" && eligibleQty < conditions.minQty) return 0;
  const base = eligible.reduce((sum, line) => sum + line.unitPriceIqd * line.qty, 0);
  if (coupon.minSubtotalIqd !== null && (coupon.isDemo ? base : subtotalIqd) < coupon.minSubtotalIqd) return 0;
  let discount = coupon.kind === "fixed" ? coupon.value : bpsOf(base, coupon.value);
  if (coupon.maxDiscountIqd !== null) discount = Math.min(discount, coupon.maxDiscountIqd);
  return Math.max(0, Math.min(discount, base, subtotalIqd));
}

// ───────────────────────────────────────────────────────────────── planning

type Planned = {
  plan: EditPlan;
  order: Order;
  input: z.output<typeof EditOrderInput>;
  /** Reservation rows to release or reduce, per row. */
  releases: { id: string; variantId: string; locationId: string; qtyBefore: number; release: number }[];
  reserve: { variantId: string; qty: number }[];
  linesChanged: boolean;
  phoneE164: string | null;
  paymentStatus: string | null;
  /** Lines lowered while units of them are verified at the packing station: the most units each may hold then. */
  scanGuards: { orderItemId: string; maxUnits: number }[];
  /** The lines or the total change: the batch re-checks that no invoice was issued meanwhile. */
  guardInvoice: boolean;
  /** The order's promotions record after this edit (the coupon re-priced, the delivery waiver on the new fee), or null when it stays. */
  promotionsAfter: PromotionsRecord | null;
};

async function plan(db: Db, actor: Actor, orderId: string, raw: EditOrderInput): Promise<Planned> {
  assertCan(actor, "orders.order.update");
  const input = EditOrderInput.parse(raw);
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw notFound("order");
  if (order.channel !== "web" || !(EDITABLE_STATUSES as readonly string[]).includes(order.status)) {
    throw new AppError(order.status === "payment_review" ? "edit_payment_in_review" : "edit_not_allowed", 409, { detail: order.status });
  }

  const [items, paymentRows, refundRow, serialRows, parcelRows, reservations] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(asc(orderItems.id)),
    db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(desc(payments.createdAt), desc(payments.id)),
    db
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), notInArray(refunds.status, ["rejected", "cancelled"])))
      .get(),
    db
      .select({ orderItemId: orderItemSerials.orderItemId, releasedAt: orderItemSerials.releasedAt })
      .from(orderItemSerials)
      .innerJoin(orderItems, eq(orderItems.id, orderItemSerials.orderItemId))
      .where(eq(orderItems.orderId, order.id)),
    db.select({ id: shipments.id, status: shipments.status }).from(shipments).where(eq(shipments.orderId, order.id)),
    db
      .select({ id: stockReservations.id, variantId: stockReservations.variantId, locationId: stockReservations.locationId, qty: stockReservations.qty })
      .from(stockReservations)
      .where(and(eq(stockReservations.orderId, order.id), eq(stockReservations.status, "active")))
      .orderBy(desc(stockReservations.createdAt), desc(stockReservations.id)),
  ]);
  if (paymentRows.some((row) => row.status === "pending_verification")) throw new AppError("edit_payment_in_review", 409, { detail: order.id });
  if (refundRow) throw new AppError("edit_has_refunds", 409, { detail: order.id });

  // ── lines
  const byId = new Map(items.map((item) => [item.id, item]));
  const requested = new Map<string, number>();
  for (const line of input.lines) {
    const item = byId.get(line.orderItemId);
    if (!item || requested.has(line.orderItemId)) throw invalid({ lines: "invalid" }, line.orderItemId);
    if (item.usedUnitId && line.qty > 1) throw new AppError("edit_used_unit_qty", 400, { fields: { lines: "edit_used_unit_qty" }, detail: item.id });
    requested.set(item.id, line.qty);
  }
  const planLines: EditLinePlan[] = items.map((item) => ({
    orderItemId: item.id,
    variantId: item.variantId,
    usedUnitId: item.usedUnitId,
    sku: item.sku,
    name: item.nameSnapshot,
    unitPriceIqd: item.unitPriceIqd,
    qtyBefore: item.qty,
    qtyAfter: requested.get(item.id) ?? item.qty,
  }));
  const changedLines = planLines.filter((line) => line.qtyAfter !== line.qtyBefore);
  const linesChanged = changedLines.length > 0;
  // What the order's promotions recorded (2026-11-12): a flash-priced line keeps its claim on the sale's allowance — its
  // quantity is not edited (cancel the order instead); a waived delivery fee stays waived on an address edit.
  const promotionsRecord = await promotionsRecordOf(db, order.id);
  const flashLines = new Set((promotionsRecord?.flash ?? []).map((claim) => claim.orderItemId));
  if (changedLines.some((line) => flashLines.has(line.orderItemId))) throw new AppError("edit_not_allowed", 409, { detail: "flash_line" });
  // An automatic offer, a membership discount or redeemed points were worked out on the goods as ordered (an offer may
  // be for one product kind only): kept as they were on other goods they would be a discount nobody gave; worked out
  // again they would need the offer's terms of that day. Such an order's lines are not edited — cancelling it gives
  // back the points and the offer's units (review 2026-11-12: the headset's offer stayed on the console).
  if (linesChanged && (promotionsRecord?.discounts ?? []).some((entry) => entry.kind !== "coupon")) throw new AppError("edit_not_allowed", 409, { detail: "promotions" });
  const scanGuards: Planned["scanGuards"] = [];
  if (linesChanged) {
    if (planLines.every((line) => line.qtyAfter === 0)) throw new AppError("edit_empty_order", 409, { detail: order.id });
    const serialsOn = (itemId: string) => serialRows.filter((row) => row.orderItemId === itemId);
    for (const line of changedLines) {
      const attached = serialsOn(line.orderItemId);
      if (line.qtyAfter < line.qtyBefore && attached.some((row) => row.releasedAt === null)) throw new AppError("edit_serials_attached", 409, { detail: line.orderItemId });
      // A removed line is deleted: any serial history on it (even released) keeps it.
      if (line.qtyAfter === 0 && attached.length > 0) throw new AppError("edit_serials_attached", 409, { detail: line.orderItemId });
    }
    if (parcelRows.some((row) => row.status !== "pending" && row.status !== "cancelled")) throw new AppError("edit_parcel_packed", 409, { detail: order.id });
    // Units verified at the packing station are in the parcel: a line never goes below them (the station would show
    // it complete with the extra units still in the box — goods leaving unpaid, stock wrong).
    const lowered = changedLines.filter((line) => line.qtyAfter < line.qtyBefore);
    if (lowered.length > 0) {
      const verified = await verifiedByLine(db, order.id);
      for (const line of lowered) {
        const held = verified.get(line.orderItemId);
        const perQty = held?.perQty ?? (await bundleUnits(db, line));
        if (held && line.qtyAfter * perQty < held.units) throw new AppError("edit_units_scanned", 409, { detail: line.orderItemId });
        // re-checked in the batch: a scan may land between this plan and the write
        scanGuards.push({ orderItemId: line.orderItemId, maxUnits: line.qtyAfter * perQty });
      }
    }
  }

  // ── address
  let phoneE164: string | null = null;
  let shippingAfter = order.shippingIqd;
  let waiverAfter: { feeIqd: number; waivedIqd: number } | null = null;
  let addressChanged = false;
  if (input.address) {
    const address = input.address;
    // No number typed: the order keeps its own (the form leaves it empty for employees who see it masked).
    phoneE164 = address.phone ? normalizeIraqPhone(address.phone) : order.contactPhoneE164;
    if (address.phone && !phoneE164) throw invalid({ phone: "phone_invalid" });
    if (address.districtId) {
      const district = await db.select({ governorateId: districts.governorateId, isActive: districts.isActive }).from(districts).where(eq(districts.id, address.districtId)).get();
      if (!district || district.governorateId !== address.governorateId || !district.isActive) throw invalid({ districtId: "district_invalid" });
    }
    if (address.governorateId !== order.governorateId) {
      const fee = await getShippingFee(db, address.governorateId);
      // a waived fee stays waived: a member's whole fee, a rule's up to what it waived — and the record says so
      const waiver = promotionsRecord?.shipping ?? null;
      if (waiver) waiverAfter = { feeIqd: fee, waivedIqd: waiver.by === "member" ? fee : Math.min(fee, waiver.waivedIqd) };
      shippingAfter = waiverAfter ? fee - waiverAfter.waivedIqd : fee;
    }
    addressChanged =
      (address.contactName ?? null) !== (order.contactName ?? null) ||
      phoneE164 !== order.contactPhoneE164 ||
      address.governorateId !== order.governorateId ||
      (address.districtId ?? null) !== (order.districtId ?? null) ||
      address.areaText !== (order.areaText ?? "") ||
      address.addressText !== (order.addressText ?? "") ||
      (address.notes ?? null) !== (order.notes ?? null);
  }
  if (!linesChanged && !addressChanged) throw new AppError("edit_no_change", 409, { detail: order.id });

  // ── totals
  const kept = planLines.filter((line) => line.qtyAfter > 0);
  const lineDiscount = new Map(items.map((item) => [item.id, item.discountIqd]));
  const subtotalAfter = kept.reduce((sum, line) => sum + line.unitPriceIqd * line.qtyAfter - (lineDiscount.get(line.orderItemId) ?? 0), 0);
  let discountAfter = order.discountIqd;
  let coupon: EditPlan["coupon"] = null;
  if (linesChanged) {
    if (order.couponId) {
      // the coupon's own part of the discount is re-applied by its rule; the rest (automatic rules, membership,
      // redeemed points — 2026-11-12) stays as it was given, never above the goods left
      const redeemed = await db.select({ amountIqd: couponRedemptions.amountIqd }).from(couponRedemptions).where(and(eq(couponRedemptions.orderId, order.id), eq(couponRedemptions.couponId, order.couponId), isNull(couponRedemptions.voidedAt))).get();
      const couponBefore = Math.min(order.discountIqd, redeemed?.amountIqd ?? order.discountIqd);
      const otherPart = order.discountIqd - couponBefore;
      const couponAfter = await couponDiscountFor(
        db,
        order.couponId,
        kept.map((line) => ({ variantId: line.variantId, qty: line.qtyAfter, unitPriceIqd: line.unitPriceIqd })),
        subtotalAfter,
      );
      discountAfter = Math.min(subtotalAfter, couponAfter + otherPart);
      coupon = { code: order.couponCode ?? "", beforeIqd: couponBefore, afterIqd: couponAfter, lost: couponAfter === 0 && couponBefore > 0 };
    } else {
      discountAfter = Math.min(order.discountIqd, subtotalAfter);
    }
  }
  const before: EditTotals = { subtotalIqd: order.subtotalIqd, discountIqd: order.discountIqd, shippingIqd: order.shippingIqd, taxIqd: order.taxIqd, totalIqd: order.totalIqd };
  const after: EditTotals = {
    subtotalIqd: subtotalAfter,
    discountIqd: discountAfter,
    shippingIqd: shippingAfter,
    taxIqd: order.taxIqd,
    totalIqd: subtotalAfter - discountAfter + shippingAfter + order.taxIqd,
  };
  if (!Number.isSafeInteger(after.totalIqd) || after.totalIqd < 0) throw new Error(`editOrder: impossible total ${after.totalIqd} for ${order.id}`);

  // ── money: nothing may change for a paid order; otherwise the open payment asks for the new total
  const paidRows = paymentRows.filter((row) => row.status === "paid");
  const totalChanges = after.totalIqd !== before.totalIqd;
  if ((linesChanged || totalChanges) && (order.paidIqd > 0 || paidRows.length > 0)) throw new AppError("edit_paid_order", 409, { detail: order.id });
  // An issued invoice (admin 05.06) froze the lines and the total: the courier would collect one amount against a
  // printed invoice of another. The address may still change while the total stays.
  const guardInvoice = linesChanged || totalChanges;
  if (guardInvoice && (await invoiceOf(db, order.id))) throw new AppError("edit_invoiced", 409, { detail: order.id });
  const open = paymentRows.find((row) => row.status === "pending" || row.status === "rejected") ?? null;
  const payment = totalChanges && open ? { paymentId: open.id, method: open.method, fromIqd: open.amountIqd, toIqd: after.totalIqd } : null;

  // ── stock: what the new lines need, per stocked variant, against what the order holds now
  const releases: Planned["releases"] = [];
  const reserve: Planned["reserve"] = [];
  const stock: EditPlan["stock"] = [];
  const usedUnitsReleased = changedLines.filter((line) => line.usedUnitId && line.qtyAfter === 0).map((line) => line.usedUnitId as string);
  if (linesChanged) {
    const lineVariants = [...new Set(planLines.filter((line) => !line.usedUnitId).map((line) => line.variantId))];
    const parts = lineVariants.length
      ? await db.select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, lineVariants))
      : [];
    const need = new Map<string, number>();
    for (const line of planLines) {
      if (line.usedUnitId || line.qtyAfter === 0) continue;
      const components = parts.filter((part) => part.bundleId === line.variantId);
      if (components.length === 0) need.set(line.variantId, (need.get(line.variantId) ?? 0) + line.qtyAfter);
      for (const part of components) need.set(part.componentId, (need.get(part.componentId) ?? 0) + part.qty * line.qtyAfter);
    }
    const held = new Map<string, number>();
    for (const row of reservations) held.set(row.variantId, (held.get(row.variantId) ?? 0) + row.qty);
    const stockVariants = [...new Set([...need.keys(), ...held.keys()])];
    const skuRows = stockVariants.length ? await db.select({ id: variants.id, sku: variants.sku }).from(variants).where(inArray(variants.id, stockVariants)) : [];
    const skuOf = new Map(skuRows.map((row) => [row.id, row.sku]));
    for (const variantId of stockVariants) {
      const delta = (need.get(variantId) ?? 0) - (held.get(variantId) ?? 0);
      if (delta === 0) continue;
      stock.push({ variantId, sku: skuOf.get(variantId) ?? variantId, deltaQty: delta });
      if (delta > 0) {
        reserve.push({ variantId, qty: delta });
        continue;
      }
      // Release the newest holds first, whole rows where possible.
      let left = -delta;
      for (const row of reservations.filter((entry) => entry.variantId === variantId)) {
        if (left <= 0) break;
        const take = Math.min(row.qty, left);
        left -= take;
        releases.push({ id: row.id, variantId, locationId: row.locationId, qtyBefore: row.qty, release: take });
      }
    }
  }

  return {
    plan: {
      orderId: order.id,
      ref: order.ref,
      status: order.status,
      lines: planLines,
      before,
      after,
      stock,
      usedUnitsReleased,
      coupon,
      payment,
      address: { changed: addressChanged, shippingBeforeIqd: order.shippingIqd, shippingAfterIqd: shippingAfter },
    },
    order,
    input,
    releases,
    reserve,
    linesChanged,
    phoneE164,
    paymentStatus: open?.status ?? null,
    scanGuards,
    guardInvoice,
    // the order page and the invoice show the record's lines: re-priced with the order (review 2026-11-12)
    promotionsAfter: promotionsRecord ? editedPromotionsRecord(promotionsRecord, { coupon: coupon ? { afterIqd: coupon.afterIqd, lost: coupon.lost } : null, shipping: waiverAfter }) : null,
  };
}

/** The preview of an edit: what would change in lines, stock and money. Writes nothing; throws what editOrder would. */
export async function planOrderEdit(db: Db, actor: Actor, orderId: string, raw: EditOrderInput): Promise<EditPlan> {
  return (await plan(db, actor, orderId, raw)).plan;
}

/** The order event id of an edit: one per (order, idempotency key). */
export async function editEventId(orderId: string, idempotencyKey: string): Promise<string> {
  return `oev_edit_${(await sha256Hex(`orders.edit|${orderId}|${idempotencyKey}`)).slice(0, 32)}`;
}

const RETRYABLE = ["ORDER_CHANGED", "RESERVATION_CHANGED", "PAYMENT_CHANGED", "PARCEL_CHANGED"] as const;

function translate(error: unknown): unknown {
  const info = mapDbError(error);
  switch (info?.code) {
    case "ORDER_CHANGED":
    case "RESERVATION_CHANGED":
    case "PAYMENT_CHANGED":
    case "PARCEL_CHANGED":
      return new AppError("order_changed", 409, { detail: info.detail, cause: error });
    case "FOREIGN_KEY":
      return new AppError("edit_line_referenced", 409, { detail: info.detail, cause: error });
    default:
      return toAppError(error) ?? error;
  }
}

function statementsFor(db: Db, actor: Actor, planned: Planned, eventId: string, now: number): BatchStatement[] {
  const { plan: p, order, input } = planned;
  const { actorKind, actorId } = actorRef(actor);
  const reason = input.reason;
  const statements: BatchStatement[] = [];

  // 1. the order itself — guarded on the version that was planned
  const address = input.address;
  statements.push(
    db
      .update(orders)
      .set({
        subtotalIqd: p.after.subtotalIqd,
        discountIqd: p.after.discountIqd,
        shippingIqd: p.after.shippingIqd,
        totalIqd: p.after.totalIqd,
        ...(address && p.address.changed
          ? {
              contactName: address.contactName,
              contactPhoneE164: planned.phoneE164 ?? order.contactPhoneE164,
              governorateId: address.governorateId,
              districtId: address.districtId,
              areaText: address.areaText,
              addressText: address.addressText,
              notes: address.notes,
            }
          : {}),
        updatedAt: now,
      })
      .where(and(eq(orders.id, order.id), eq(orders.status, order.status), eq(orders.updatedAt, order.updatedAt), eq(orders.paidIqd, order.paidIqd))),
    expectChanged(db, 1, { code: "ORDER_CHANGED", detail: order.id }),
  );
  // Facts the order row does not carry, re-checked at write time (a failure re-plans, which then refuses):
  // no invoice was issued meanwhile, and no unit was scanned into a line being lowered beyond its new quantity.
  if (planned.guardInvoice) {
    statements.push(expectThat(db, sql`NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = ${order.id} AND kind = 'invoice')`, { code: "ORDER_CHANGED", detail: `${order.id} invoiced` }));
  }
  for (const guard of planned.scanGuards) {
    statements.push(
      expectThat(
        db,
        sql`(SELECT coalesce(sum(${verifiedUnits}), 0) FROM shipment_events JOIN shipments ON shipments.id = shipment_events.shipment_id
          WHERE shipments.order_id = ${order.id} AND shipment_events.kind IN ('scan', 'scan_manual')
            AND json_extract(shipment_events.data, '$.orderItemId') = ${guard.orderItemId}) <= ${guard.maxUnits}`,
        { code: "PARCEL_CHANGED", detail: guard.orderItemId },
      ),
    );
  }

  if (planned.linesChanged) {
    // 2. lines (and their not-yet-packed parcel rows; the next scan fills parcel 1 again)
    for (const line of p.lines) {
      if (line.qtyAfter === line.qtyBefore) continue;
      statements.push(
        db
          .delete(shipmentItems)
          .where(and(eq(shipmentItems.orderItemId, line.orderItemId), sql`${shipmentItems.shipmentId} IN (SELECT id FROM shipments WHERE order_id = ${order.id} AND status = 'pending')`)),
      );
      if (line.qtyAfter === 0) {
        statements.push(
          db.delete(orderItems).where(and(eq(orderItems.id, line.orderItemId), eq(orderItems.orderId, order.id), eq(orderItems.qty, line.qtyBefore))),
          expectChanged(db, 1, { code: "ORDER_CHANGED", detail: line.orderItemId }),
        );
      } else {
        statements.push(
          db
            .update(orderItems)
            .set({ qty: line.qtyAfter, totalIqd: sql`${orderItems.unitPriceIqd} * ${line.qtyAfter} - ${orderItems.discountIqd}` })
            .where(and(eq(orderItems.id, line.orderItemId), eq(orderItems.orderId, order.id), eq(orderItems.qty, line.qtyBefore))),
          expectChanged(db, 1, { code: "ORDER_CHANGED", detail: line.orderItemId }),
        );
      }
    }

    // 3. stock: release the holds no longer needed (row by row, guarded) …
    for (const row of planned.releases) {
      const whole = row.release === row.qtyBefore;
      statements.push(
        whole
          ? db
              .update(stockReservations)
              .set({ status: "released", releasedAt: now })
              .where(and(eq(stockReservations.id, row.id), eq(stockReservations.status, "active"), eq(stockReservations.qty, row.qtyBefore)))
          : db
              .update(stockReservations)
              .set({ qty: row.qtyBefore - row.release })
              .where(and(eq(stockReservations.id, row.id), eq(stockReservations.status, "active"), eq(stockReservations.qty, row.qtyBefore))),
        expectChanged(db, 1, { code: "RESERVATION_CHANGED", detail: row.id }),
        db
          .update(stockLevels)
          .set({ reserved: sql`${stockLevels.reserved} - ${row.release}`, updatedAt: now })
          .where(and(eq(stockLevels.variantId, row.variantId), eq(stockLevels.locationId, row.locationId))),
        expectChanged(db, 1, { code: "RESERVATION_CHANGED", detail: `${row.variantId}@${row.locationId}` }),
        db.insert(stockMovements).values({
          id: newId("mov"),
          variantId: row.variantId,
          locationId: row.locationId,
          kind: "release",
          qtyDelta: 0,
          reservedDelta: -row.release,
          refType: "order",
          refId: order.id,
          reason: `order_edited: ${reason}`.slice(0, 500),
          actorKind,
          actorId,
          at: now,
        }),
      );
    }
    // … and hold what the new lines need more of (a shortage aborts the whole edit)
    if (planned.reserve.length > 0) {
      statements.push(...reserveStatements(db, { orderId: order.id, lines: planned.reserve, expiresAt: order.status === "awaiting_payment" ? order.paymentDueAt : null, actor, now }));
    }
    for (const usedUnitId of p.usedUnitsReleased) statements.push(...releaseUsedUnitStatements(db, { usedUnitId, now }));

    // 4. the coupon's use follows the new discount
    if (order.couponId && p.coupon) {
      statements.push(
        db
          .update(couponRedemptions)
          .set(p.coupon.lost ? { amountIqd: 0, voidedAt: now } : { amountIqd: p.coupon.afterIqd })
          .where(and(eq(couponRedemptions.orderId, order.id), eq(couponRedemptions.couponId, order.couponId), isNull(couponRedemptions.voidedAt))),
      );
    }
  }

  // 4b. what the order's promotions record says now (a newer "promotions" event; readers take the latest)
  if (planned.promotionsAfter) statements.push(promotionsEventStatement(db, { orderId: order.id, record: planned.promotionsAfter, actor, now }));

  // 5. the payment difference: the open payment now asks for the new total
  if (p.payment && planned.paymentStatus) {
    statements.push(
      db
        .update(payments)
        .set({ amountIqd: p.payment.toIqd, updatedAt: now })
        .where(and(eq(payments.id, p.payment.paymentId), eq(payments.status, planned.paymentStatus as "pending" | "rejected"), eq(payments.amountIqd, p.payment.fromIqd))),
      expectChanged(db, 1, { code: "PAYMENT_CHANGED", detail: p.payment.paymentId }),
    );
  }

  // 6. history
  const lines = p.lines.filter((line) => line.qtyAfter !== line.qtyBefore).map((line) => ({ orderItemId: line.orderItemId, sku: line.sku, from: line.qtyBefore, to: line.qtyAfter }));
  statements.push(
    db.insert(orderEvents).values({
      id: eventId,
      orderId: order.id,
      kind: "edited",
      data: {
        reason,
        totalBefore: p.before.totalIqd,
        totalAfter: p.after.totalIqd,
        lines: lines.length,
        address: p.address.changed,
        couponLost: p.coupon?.lost ?? false,
        paymentId: p.payment?.paymentId ?? null,
      },
      actorKind,
      actorId,
      at: now,
    }),
    auditStatement(db, {
      actor,
      action: "orders.order.edit",
      entityType: "order",
      entityId: order.id,
      summary: `${order.ref}: edited before shipping`,
      before: {
        totals: p.before,
        lines: lines.map((line) => ({ orderItemId: line.orderItemId, sku: line.sku, qty: line.from })),
        address: p.address.changed ? { governorateId: order.governorateId, districtId: order.districtId, area: order.areaText, address: order.addressText, phone: order.contactPhoneE164, name: order.contactName } : undefined,
      },
      after: {
        totals: p.after,
        lines: lines.map((line) => ({ orderItemId: line.orderItemId, sku: line.sku, qty: line.to })),
        address: p.address.changed && input.address ? { governorateId: input.address.governorateId, districtId: input.address.districtId, area: input.address.areaText, address: input.address.addressText, phone: planned.phoneE164, name: input.address.contactName } : undefined,
        stock: p.stock,
        coupon: p.coupon,
        payment: p.payment,
      },
      reason,
      at: now,
    }),
  );
  return statements;
}

/**
 * Applies an edit (file header). Throws AppError: forbidden (403), invalid (400), not_found (404), the edit_* codes,
 * insufficient_stock, shipping_unavailable, order_changed, totals_changed (409). Returns `replayed: true` for a retry
 * with the same idempotency key. Nothing is written when it throws.
 */
export async function editOrder(db: Db, actor: Actor, orderId: string, raw: EditOrderInput, now: number): Promise<{ replayed: boolean; plan: EditPlan | null; totalIqd: number }> {
  assertCan(actor, "orders.order.update");
  const key = EditOrderInput.parse(raw).idempotencyKey;
  if (!key) throw invalid({ idempotencyKey: "required" });
  const eventId = await editEventId(orderId, key);
  const replay = async () => {
    const done = await db.select({ id: orderEvents.id }).from(orderEvents).where(eq(orderEvents.id, eventId)).get();
    if (!done) return null;
    const order = await db.select({ totalIqd: orders.totalIqd }).from(orders).where(eq(orders.id, orderId)).get();
    return { replayed: true, plan: null, totalIqd: order?.totalIqd ?? 0 };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  for (let attempt = 1; ; attempt++) {
    const planned = await plan(db, actor, orderId, raw);
    if (planned.input.expectedTotalIqd !== undefined && planned.input.expectedTotalIqd !== planned.plan.after.totalIqd) {
      throw new AppError("totals_changed", 409, { detail: `${planned.input.expectedTotalIqd}→${planned.plan.after.totalIqd}` });
    }
    try {
      await runBatch(db, statementsFor(db, actor, planned, eventId, now));
      return { replayed: false, plan: planned.plan, totalIqd: planned.plan.after.totalIqd };
    } catch (error) {
      // The same edit raced itself (a double submit): the first one won.
      const again = await replay();
      if (again) return again;
      if (attempt < 3 && RETRYABLE.some((code) => isDbError(error, code))) continue;
      throw translate(error);
    }
  }
}
