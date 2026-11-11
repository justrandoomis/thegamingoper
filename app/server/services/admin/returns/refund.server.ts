/**
 * The money of a return (blueprint 12.04 and 12.05) — only through the commerce core: createRefund (orders.refund.create)
 * and approveRefund (orders.refund.approve, a DIFFERENT employee than the one who asked: approver_is_requester).
 *
 *   await requestReturnRefund(db, actor, { returnId, paymentId, itemIds, amountIqd, method: "wallet", reason, idempotencyKey }, now);
 *   await decideReturnRefund(db, otherActor, { returnId, refundId, approve: true }, now);
 *
 * WHAT IS PREVENTED, layer by layer (tests/admin-returns.test.ts "never twice", tests/admin-returns-adversarial.test.ts):
 *   1. here: only units of THIS return that came back (inspected, and not kept by the customer — a kept unit only once
 *      its repair under the RMA failed) and are not refunded yet; the amount never exceeds what those units cost the
 *      customer minus the policy's restocking fee on a change of mind (12.04 "per policy"; shipping, goodwill and a
 *      waived fee go through the orders module as amount-only refunds);
 *   2. INSIDE the core's own refund batch (createRefund writes in one batch; this module appends its guard to it): the
 *      units held by this return's refunds never exceed the units it took in, per order line — two requests racing for
 *      the same unit cannot both pass, also when the line was bought more times than it was returned (which layer 4
 *      cannot see);
 *   3. createRefund: never above getRefundableAmount (what the payment paid minus every refund not rejected), the units
 *      never above what was bought minus what was refunded, a retry with the same key returns the first refund;
 *   4. the database: triggers on refunds and refund_items (Σ refunds ≤ paid per payment, Σ refunded units ≤ bought per
 *      line, orders.refunded_iqd ≤ paid_iqd) — whatever path a refund takes;
 *   5. returns: a unit sits in one open or finished return at a time (rma.server's in-batch guard, a serial once).
 * Refunded units are counted on the refund (refund_items) without a disposition: their goods already came back at
 * inspection (or, after a failed repair, stayed with the customer). Methods: the original payment method, the
 * customer's wallet (store credit — a customer account is needed), or cash. Each refund keeps its return's reference
 * (refunds.return_id) and its key is "rma:<return id>:<form key>". The RMA reads "refunded" once every unit that came
 * back is paid for (a refund of some of them leaves it in the refund queue).
 *
 * Errors: forbidden (403), approver_is_requester (403), not_found (404), invalid (400), refund_exceeds_items ·
 * refund_exceeds_policy · refund_not_ready (fields itemIds = not_inspected | not_returned) · plus the core's
 * (refund_exceeds_payment, refund_qty_exceeds, payment_not_paid, wallet_requires_account, refund_not_pending,
 * period_closed) (409).
 */
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { orderItems, orders, refundItems, refunds, returnItems, warranties, type Order, type ReturnRequest } from "~/server/db/schema";
import { batchSql, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { approveRefund, createRefund } from "~/server/services/refunds.server";
import { linkRefundStatements } from "~/server/services/returns/receive.server";
import { evaluateOrder } from "./policy.server";
import { VOID_REFUND, failedRepairs, refundKeyPrefix, refundableLine, returnById, returnRefundFilter, unitValuesFor } from "./shared.server";
import { REFUND_METHOD_LIST, isFaultReason } from "./types";

export const RETURN_REFUND_ERROR_KEYS = ["refund_exceeds_items", "refund_exceeds_policy", "refund_not_ready"] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID, "invalid");

export const ReturnRefundInput = z.object({
  returnId: idSchema,
  paymentId: idSchema,
  /** The RMA lines refunded now (each one's units not refunded yet). */
  itemIds: z.array(idSchema).min(1, "required").max(100, "too_big"),
  amountIqd: z.number({ error: "required" }).int("invalid").min(1, "too_small").max(10_000_000_000, "too_big"),
  method: z.enum(REFUND_METHOD_LIST, "required"),
  reason: z.string().trim().min(3, "required").max(400, "too_long"),
  reference: z
    .string()
    .trim()
    .max(100, "too_long")
    .optional()
    .transform((value) => value || undefined),
  idempotencyKey: z.string().trim().min(8, "invalid").max(100, "invalid"),
});
export type ReturnRefundInput = z.input<typeof ReturnRefundInput>;

/** Units of each line of a return already refunded through it (refunds of the return that were not rejected). */
async function refundedThroughReturn(db: Db, returnId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ orderItemId: refundItems.orderItemId, qty: sql<number>`sum(${refundItems.qty})` })
    .from(refundItems)
    .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
    .where(and(returnRefundFilter(returnId), notInArray(refunds.status, [...VOID_REFUND])))
    .groupBy(refundItems.orderItemId);
  return new Map(rows.map((row) => [row.orderItemId, Number(row.qty)]));
}

/**
 * The RMA's status once money went back: refunded (or exchanged) when every unit was inspected AND every unit that came
 * back is paid for; unchanged otherwise (a partial refund leaves the RMA in the refund queue — closeReturn ends it).
 */
function settleStatements(db: Db, ret: ReturnRequest, method: string, now: number) {
  const resolution = method === "wallet" ? (ret.requestedResolution === "exchange" ? "exchange" : "store_credit") : "refund";
  const status = resolution === "exchange" ? "exchanged" : "refunded";
  return [
    batchSql(
      db,
      sql`UPDATE returns SET status = ${status}, resolution = ${resolution}, updated_at = ${now}
          WHERE id = ${ret.id} AND status IN ('received', 'inspected', 'refunded')
            AND NOT EXISTS (SELECT 1 FROM return_items WHERE return_id = ${ret.id} AND inspected_by IS NULL)
            AND EXISTS (SELECT 1 FROM refunds WHERE return_id = ${ret.id} AND status = 'paid')
            AND NOT EXISTS (
              SELECT 1 FROM return_items ri
              WHERE ri.return_id = ${ret.id} AND ri.restock_action IS NOT NULL
              GROUP BY ri.order_item_id
              HAVING sum(ri.qty) > (
                SELECT coalesce(sum(rfi.qty), 0) FROM refund_items rfi JOIN refunds rf ON rf.id = rfi.refund_id
                WHERE rf.return_id = ${ret.id} AND rf.status = 'paid' AND rfi.order_item_id = ri.order_item_id))`,
    ),
  ];
}

/**
 * The batch guard of layer 2 (file header): the units held by this return's refunds that were not rejected never exceed,
 * per order line, the units this return took in and inspected.
 */
function unitsGuard(db: Db, returnId: string): BatchStatement {
  const prefix = refundKeyPrefix(returnId);
  return expectThat(
    db,
    sql`NOT EXISTS (
          SELECT 1 FROM refund_items rfi JOIN refunds rf ON rf.id = rfi.refund_id
          WHERE (rf.return_id = ${returnId} OR substr(rf.idempotency_key, 1, ${prefix.length}) = ${prefix}) AND rf.status NOT IN ('rejected', 'cancelled')
          GROUP BY rfi.order_item_id
          HAVING sum(rfi.qty) > (
            SELECT coalesce(sum(ri.qty), 0) FROM return_items ri
            WHERE ri.return_id = ${returnId} AND ri.order_item_id = rfi.order_item_id AND ri.inspected_by IS NOT NULL))`,
    { code: "RETURN_REFUND_EXCEEDS", detail: returnId },
  );
}

/**
 * `db` for a core call whose write batch must carry this module's guards: every `batch` it runs gets `guards` at its
 * end — the same transaction, all or nothing. Reads and everything else go to `db` unchanged.
 */
function withBatchGuards(db: Db, guards: readonly BatchStatement[]): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") return (statements: readonly BatchStatement[]) => target.batch([...statements, ...guards] as unknown as Parameters<Db["batch"]>[0]);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Restocking fee rates (basis points) per order line for this return: none when the store is at fault (12.02). */
async function feeRates(db: Db, ret: ReturnRequest, order: Order): Promise<Map<string, number>> {
  if (isFaultReason(ret.reasonCode)) return new Map();
  const lines = await evaluateOrder(db, order, ret.createdAt, "ar", { exceptReturnId: ret.id });
  return new Map(lines.map((line) => [line.orderItemId, line.eligibility.restockingFeeBps]));
}

/**
 * A kept unit whose repair failed and whose money went back: its running warranty ends ("refunded: RMA-…") — the store
 * paid for the unit. A unit without a serial ends its line's warranty only when the whole line was kept (as at inspection).
 */
async function keptWarrantyStatements(db: Db, ret: ReturnRequest, orderItemIds: readonly string[]): Promise<BatchStatement[]> {
  if (orderItemIds.length === 0) return [];
  const kept = await db
    .select({ id: returnItems.id, orderItemId: returnItems.orderItemId, qty: returnItems.qty, serialId: returnItems.serialId, lineQty: orderItems.qty })
    .from(returnItems)
    .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
    .where(and(eq(returnItems.returnId, ret.id), isNotNull(returnItems.inspectedBy), isNull(returnItems.restockAction), inArray(returnItems.orderItemId, [...orderItemIds])));
  const failed = await failedRepairs(
    db,
    kept.map((line) => line.id),
  );
  return kept
    .filter((line) => failed.has(line.id) && (line.serialId !== null || line.qty >= line.lineQty))
    .map((line) =>
      db
        .update(warranties)
        .set({ status: "void", voidReason: `refunded: ${ret.rma}` })
        .where(and(eq(warranties.orderItemId, line.orderItemId), line.serialId ? eq(warranties.serialId, line.serialId) : undefined, eq(warranties.status, "active"))),
    );
}

/** The fee kept on `qty` units worth `unitValueIqd` each at `bps` basis points, rounded down (in the customer's favour). */
export const restockingFee = (unitValueIqd: number, qty: number, bps: number): number => (bps > 0 ? Math.floor((unitValueIqd * qty * bps) / 10_000) : 0);

/** Asks for (or, within the owner's threshold, issues) the refund of units of a return that came back (file header). */
export async function requestReturnRefund(db: Db, actor: Actor, raw: ReturnRefundInput, now: number): Promise<{ refundId: string; status: "pending" | "paid"; replayed: boolean }> {
  assertCan(actor, "orders.refund.create");
  assertCan(actor, "returns.rma.read");
  const input = ReturnRefundInput.parse(raw);
  const ret = await returnById(db, input.returnId);
  const key = `${refundKeyPrefix(ret.id)}${input.idempotencyKey}`;
  const earlier = await db.select().from(refunds).where(eq(refunds.idempotencyKey, key)).get();
  // a closed RMA said nothing is left to do: no new refund through it (a retry of an earlier one still answers)
  if (!earlier && (ret.closedAt !== null || !["received", "inspected", "refunded"].includes(ret.status))) throw new AppError("refund_not_ready", 409, { detail: ret.closedAt !== null ? "closed" : ret.status });

  const items = await db
    .select({ id: returnItems.id, orderItemId: returnItems.orderItemId, qty: returnItems.qty, inspectedBy: returnItems.inspectedBy, restockAction: returnItems.restockAction })
    .from(returnItems)
    .where(eq(returnItems.returnId, ret.id))
    .orderBy(returnItems.id);
  const order = await db.select().from(orders).where(eq(orders.id, ret.orderId)).get();
  if (!order) throw notFound("order");
  const wanted = [...new Set(input.itemIds)];
  const chosen = items.filter((item) => wanted.includes(item.id));
  if (chosen.length !== wanted.length) throw notFound("return_item");

  let units: { orderItemId: string; qty: number }[] = [];
  if (!earlier) {
    if (chosen.some((item) => !item.inspectedBy)) throw new AppError("refund_not_ready", 409, { detail: "not inspected", fields: { itemIds: "not_inspected" } });
    // A unit that stayed with its customer is not paid for (it never came back) — unless its repair under the RMA failed.
    const failed = await failedRepairs(
      db,
      items.filter((item) => item.inspectedBy && item.restockAction === null).map((item) => item.id),
    );
    if (chosen.some((item) => !refundableLine(item, failed))) throw new AppError("refund_not_ready", 409, { detail: "kept by the customer", fields: { itemIds: "not_returned" } });
    // Units already refunded through this return, handed out to its refundable lines in order (a kept unit never takes them).
    const refunded = await refundedThroughReturn(db, ret.id);
    const left = new Map<string, number>();
    for (const item of items) left.set(item.id, refundableLine(item, failed) ? item.qty : 0);
    for (const item of items) {
      const already = refunded.get(item.orderItemId) ?? 0;
      const own = left.get(item.id) ?? 0;
      if (already <= 0 || own <= 0) continue;
      const take = Math.min(already, own);
      left.set(item.id, own - take);
      refunded.set(item.orderItemId, already - take);
    }
    const [values, rates] = await Promise.all([unitValuesFor(db, [order]), feeRates(db, ret, order)]);
    const perLine = new Map<string, number>();
    let capIqd = 0;
    let feeIqd = 0;
    for (const item of chosen) {
      const qty = left.get(item.id) ?? 0;
      if (qty <= 0) throw new AppError("refund_qty_exceeds", 409, { detail: item.id, fields: { itemIds: "refund_qty_exceeds" } });
      perLine.set(item.orderItemId, (perLine.get(item.orderItemId) ?? 0) + qty);
      const unitValue = values.get(item.orderItemId) ?? 0;
      capIqd += unitValue * qty;
      feeIqd += restockingFee(unitValue, qty, rates.get(item.orderItemId) ?? 0);
    }
    units = [...perLine].map(([orderItemId, qty]) => ({ orderItemId, qty }));
    if (input.amountIqd > capIqd) throw new AppError("refund_exceeds_items", 409, { detail: `${input.amountIqd} > ${capIqd}`, fields: { amountIqd: "refund_exceeds_items" } });
    if (input.amountIqd > capIqd - feeIqd) throw new AppError("refund_exceeds_policy", 409, { detail: `${input.amountIqd} > ${capIqd} - ${feeIqd}`, fields: { amountIqd: "refund_exceeds_policy" } });
  } else {
    const stored = await db.select({ orderItemId: refundItems.orderItemId, qty: refundItems.qty }).from(refundItems).where(eq(refundItems.refundId, earlier.id));
    units = stored;
  }

  let result: Awaited<ReturnType<typeof createRefund>>;
  try {
    result = await createRefund(
      withBatchGuards(db, [unitsGuard(db, ret.id)]),
      actor,
      {
        orderId: order.id,
        paymentId: input.paymentId,
        items: units,
        amountIqd: input.amountIqd,
        method: input.method,
        reason: `${ret.rma}: ${input.reason}`,
        reference: input.reference,
        idempotencyKey: key,
      },
      now,
    );
  } catch (error) {
    // Another request took these units between the checks above and the core's batch: nothing was written.
    if (isDbError(error, "RETURN_REFUND_EXCEEDS")) throw new AppError("refund_qty_exceeds", 409, { detail: ret.id, fields: { itemIds: "refund_qty_exceeds" }, cause: error });
    throw error;
  }
  // The money keeps its return's reference; the RMA follows when it was paid at once (a retry links again harmlessly).
  await runBatch(db, [
    ...linkRefundStatements(db, { refundId: result.refundId, returnId: ret.id, orderId: order.id }),
    ...(result.status === "paid" ? [...settleStatements(db, ret, input.method, now), ...(await keptWarrantyStatements(db, ret, units.map((line) => line.orderItemId)))] : []),
    ...(result.replayed
      ? []
      : [
          auditStatement(db, {
            actor,
            action: "returns.rma.refund",
            entityType: "return",
            entityId: ret.id,
            summary: ret.rma,
            after: { refundId: result.refundId, status: result.status, amountIqd: input.amountIqd, method: input.method, units },
            reason: input.reason,
            at: now,
          }),
        ]),
  ]);
  return result;
}

export const ReturnRefundDecision = z.object({
  returnId: idSchema,
  refundId: idSchema,
  approve: z.boolean(),
  note: z.string().trim().max(500, "too_long").optional(),
  reference: z.string().trim().max(100, "too_long").optional(),
});

/** The second person's decision on a refund of THIS return (another return's refund is not_found). */
export async function decideReturnRefund(db: Db, actor: Actor, raw: z.input<typeof ReturnRefundDecision>, now: number): Promise<{ status: "paid" | "rejected" }> {
  assertCan(actor, "orders.refund.approve");
  const input = ReturnRefundDecision.parse(raw);
  const ret = await returnById(db, input.returnId);
  const refund = await db
    .select()
    .from(refunds)
    .where(and(eq(refunds.id, input.refundId), returnRefundFilter(ret.id)))
    .get();
  if (!refund) throw notFound("refund");
  const result = await approveRefund(db, actor, refund.id, { approve: input.approve, note: input.note || null, reference: input.reference || null }, now);
  const paidLines = result.status === "paid" ? (await db.select({ orderItemId: refundItems.orderItemId }).from(refundItems).where(eq(refundItems.refundId, refund.id))).map((row) => row.orderItemId) : [];
  await runBatch(db, [
    ...linkRefundStatements(db, { refundId: refund.id, returnId: ret.id, orderId: ret.orderId }),
    ...(result.status === "paid" ? [...settleStatements(db, ret, refund.method, now), ...(await keptWarrantyStatements(db, ret, paidLines))] : []),
    auditStatement(db, { actor, action: result.status === "paid" ? "returns.rma.refund_approved" : "returns.rma.refund_rejected", entityType: "return", entityId: ret.id, summary: ret.rma, after: { refundId: refund.id, status: result.status }, reason: input.note || null, at: now }),
  ]);
  return result;
}
