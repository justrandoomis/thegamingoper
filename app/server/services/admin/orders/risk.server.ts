/**
 * 05.09 — suspicious or late orders for human review, by deterministic and explained rules.
 *
 *   const flags = await riskFlagsOf(db, [orderId], ctx.now);              // Map<orderId, RiskRuleId[]>
 *   const queue = await listReviewQueue(db, actor, ctx.now);              // orders.risk.review
 *   await decideReview(db, actor, orderId, { decision: "clear", reason }, ctx.now);
 *
 * RULES (RISK_THRESHOLDS in ./types; the sentence that explains each one is "risk.<id>.why" in admin-orders):
 *   late         proof_waiting · cod_unconfirmed · not_shipped · not_delivered · preorder_overdue
 *   suspicious   duplicate_proof · amount_mismatch · high_value_cod · phone_cancellations · phone_open_orders ·
 *                customer_flagged · bulk_quantity
 * Each rule is one SQL condition on the `orders` row (and its own payments, proofs and lines), evaluated at `now`,
 * so the same order gets the same flags at the same moment, in the list filter, the queue and the order page alike.
 *
 * DECISIONS (orders.risk.review; "flag" also with orders.order.note), each with a reason, an order event and an audit
 * event, guarded against a concurrent decision:
 *   clear   reviewed and fine — remembers the flags it saw; a NEW flag later puts the order back in the queue
 *   hold    stop the order: this module refuses to move it forward (confirm, prepare, ship, deliver) until it is
 *           cleared; cancelling stays possible
 *   flag    ask for a review by hand (e.g. support heard something on the phone). Refused on a held order
 *           (order_on_hold): it would lower the hold, and only a reviewer's "clear" lifts one
 * The hold is enforced by this module's actions, not by the commerce core (requested in docs/areas/admin-orders.md).
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { orderEvents, orders } from "~/server/db/schema";
import { expectChanged, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, notFound } from "~/server/errors";
import { OPEN_STATUSES, RISK_RULE_IDS, RISK_THRESHOLDS as T, type ReviewStatus, type RiskRuleId } from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const openList = sql.raw(OPEN_STATUSES.map((status) => `'${status}'`).join(", "));

/** The condition of each rule on the current `orders` row, at `now`. */
export function riskConditions(now: number): Record<RiskRuleId, SQL> {
  return {
    proof_waiting: sql`(${orders.status} = 'payment_review' AND EXISTS (
      SELECT 1 FROM payment_proofs pp JOIN payments p ON p.id = pp.payment_id
      WHERE p.order_id = ${orders.id} AND pp.status = 'submitted' AND pp.created_at <= ${now - T.proofWaitingHours * HOUR}))`,
    cod_unconfirmed: sql`(${orders.status} = 'new' AND ${orders.placedAt} <= ${now - T.codUnconfirmedHours * HOUR})`,
    not_shipped: sql`(${orders.status} IN ('confirmed', 'preparing') AND coalesce(${orders.confirmedAt}, ${orders.placedAt}) <= ${now - T.notShippedHours * HOUR})`,
    not_delivered: sql`(${orders.status} = 'shipped' AND coalesce(${orders.shippedAt}, ${orders.updatedAt}) <= ${now - T.notDeliveredDays * DAY})`,
    preorder_overdue: sql`(${orders.isPreorder} = 1 AND ${orders.expectedAt} IS NOT NULL AND ${orders.expectedAt} < ${now} AND ${orders.status} IN ('new', 'awaiting_payment', 'payment_review', 'confirmed', 'preparing'))`,
    duplicate_proof: sql`EXISTS (SELECT 1 FROM payment_proofs pp JOIN payments p ON p.id = pp.payment_id WHERE p.order_id = ${orders.id} AND pp.duplicate_of IS NOT NULL)`,
    amount_mismatch: sql`EXISTS (SELECT 1 FROM payment_proofs pp JOIN payments p ON p.id = pp.payment_id
      WHERE p.order_id = ${orders.id} AND pp.status = 'submitted' AND pp.declared_amount_iqd <> p.amount_iqd)`,
    high_value_cod: sql`(${orders.paymentMethod} = 'cod' AND ${orders.totalIqd} >= ${T.highValueCodIqd} AND ${orders.status} IN (${openList}))`,
    phone_cancellations: sql`(${orders.contactPhoneE164} IS NOT NULL AND (
      SELECT count(*) FROM orders o2 WHERE o2.contact_phone_e164 = ${orders.contactPhoneE164} AND o2.id <> ${orders.id}
        AND o2.status = 'cancelled' AND o2.placed_at <= ${orders.placedAt} AND o2.placed_at >= ${orders.placedAt} - ${T.phoneCancellationDays * DAY}
    ) >= ${T.phoneCancellations})`,
    phone_open_orders: sql`(${orders.contactPhoneE164} IS NOT NULL AND ${orders.status} IN (${openList}) AND (
      SELECT count(*) FROM orders o2 WHERE o2.contact_phone_e164 = ${orders.contactPhoneE164} AND o2.status IN (${openList})
    ) >= ${T.phoneOpenOrders})`,
    customer_flagged: sql`EXISTS (SELECT 1 FROM customers c WHERE c.id = ${orders.customerId} AND c.fraud_flag = 1)`,
    bulk_quantity: sql`EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = ${orders.id} AND oi.qty >= ${T.bulkQuantity})`,
  };
}

/** Any of these rules holds. */
export function anyRule(now: number, ids: readonly RiskRuleId[]): SQL {
  const conditions = riskConditions(now);
  return sql`(${sql.join(
    ids.map((id) => conditions[id]),
    sql` OR `,
  )})`;
}

/** The flags of each order (ids in, rules out), evaluated in one query. */
export async function riskFlagsOf(db: Db, orderIds: readonly string[], now: number): Promise<Map<string, RiskRuleId[]>> {
  const out = new Map<string, RiskRuleId[]>();
  if (orderIds.length === 0) return out;
  const conditions = riskConditions(now);
  const columns = Object.fromEntries(RISK_RULE_IDS.map((id) => [id, sql<number>`CASE WHEN ${conditions[id]} THEN 1 ELSE 0 END`.as(`r_${id}`)])) as Record<RiskRuleId, SQL.Aliased<number>>;
  const rows = await db
    .select({ id: orders.id, ...columns })
    .from(orders)
    .where(sql`${orders.id} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(orderIds)])}))`);
  for (const row of rows) {
    const record = row as unknown as Record<string, unknown>;
    out.set(
      row.id,
      RISK_RULE_IDS.filter((id) => Number(record[id]) === 1),
    );
  }
  return out;
}

const asRules = (value: unknown): RiskRuleId[] => (Array.isArray(value) ? value.filter((item): item is RiskRuleId => (RISK_RULE_IDS as readonly string[]).includes(item as string)) : []);

/** Flags that still need a person: everything, unless the order was cleared with exactly these (or more) flags seen. */
export function unresolvedFlags(flags: readonly RiskRuleId[], reviewStatus: ReviewStatus, clearedFlags: unknown): RiskRuleId[] {
  if (reviewStatus !== "cleared") return [...flags];
  const seen = new Set(asRules(clearedFlags));
  return flags.filter((flag) => !seen.has(flag));
}

export type ReviewQueueRow = {
  id: string;
  ref: string;
  status: string;
  placedAt: number;
  totalIqd: number;
  paymentMethod: string | null;
  reviewStatus: ReviewStatus;
  flags: RiskRuleId[];
  isDemo: boolean;
};

/**
 * Open orders that need a person: a flag nobody has cleared yet, a manual request for review, or a hold.
 * Oldest first. Bounded (300 candidates) — the queue is a to-do list, not a report.
 */
export async function listReviewQueue(db: Db, actor: Actor, now: number): Promise<{ needsReview: ReviewQueueRow[]; onHold: ReviewQueueRow[] }> {
  assertCan(actor, "orders.risk.review");
  const candidates = await db
    .select({
      id: orders.id,
      ref: orders.ref,
      status: orders.status,
      placedAt: orders.placedAt,
      totalIqd: orders.totalIqd,
      paymentMethod: orders.paymentMethod,
      reviewStatus: orders.reviewStatus,
      riskFlags: orders.riskFlags,
      isDemo: orders.isDemo,
    })
    .from(orders)
    .where(and(inArray(orders.status, [...OPEN_STATUSES]), sql`(${anyRule(now, RISK_RULE_IDS)} OR ${orders.reviewStatus} IN ('needs_review', 'blocked'))`))
    .orderBy(orders.placedAt, orders.id)
    .limit(300);
  const flags = await riskFlagsOf(
    db,
    candidates.map((row) => row.id),
    now,
  );
  const needsReview: ReviewQueueRow[] = [];
  const onHold: ReviewQueueRow[] = [];
  for (const row of candidates) {
    const current = flags.get(row.id) ?? [];
    const entry: ReviewQueueRow = { id: row.id, ref: row.ref, status: row.status, placedAt: row.placedAt, totalIqd: row.totalIqd, paymentMethod: row.paymentMethod, reviewStatus: row.reviewStatus, flags: current, isDemo: row.isDemo };
    if (row.reviewStatus === "blocked") onHold.push(entry);
    else if (row.reviewStatus === "needs_review" || unresolvedFlags(current, row.reviewStatus, row.riskFlags).length > 0) needsReview.push(entry);
  }
  return { needsReview, onHold };
}

export const ReviewDecisionInput = z.object({
  decision: z.enum(["clear", "hold", "flag"]),
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
});
export type ReviewDecisionInput = z.input<typeof ReviewDecisionInput>;

const NEXT_STATUS: Record<"clear" | "hold" | "flag", ReviewStatus> = { clear: "cleared", hold: "blocked", flag: "needs_review" };

/** Records a reviewer's decision on an order (file header). Throws forbidden (403), invalid (400), not_found (404), review_not_open / order_changed (409). */
export async function decideReview(db: Db, actor: Actor, orderId: string, raw: ReviewDecisionInput, now: number): Promise<{ status: ReviewStatus; flags: RiskRuleId[] }> {
  // Who may decide is checked before the input is: a refused employee learns nothing about the form.
  if ((raw as { decision?: unknown } | null)?.decision === "flag") {
    if (!can(actor, "orders.risk.review") && !can(actor, "orders.order.note")) throw forbidden("orders.risk.review");
  } else {
    assertCan(actor, "orders.risk.review");
  }
  const input = ReviewDecisionInput.parse(raw);
  const order = await db.select({ id: orders.id, ref: orders.ref, status: orders.status, reviewStatus: orders.reviewStatus, riskFlags: orders.riskFlags }).from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw notFound("order");
  if (!(OPEN_STATUSES as readonly string[]).includes(order.status)) throw new AppError("review_not_open", 409, { detail: order.status });
  // Asking for a review never lowers a hold: "flag" on a held order would make it needs_review, which this module
  // lets move forward — a hold is lifted by a reviewer's "clear" only (support holds orders.order.note).
  if (input.decision === "flag" && order.reviewStatus === "blocked") throw new AppError("order_on_hold", 409, { detail: order.id });
  const flags = (await riskFlagsOf(db, [order.id], now)).get(order.id) ?? [];
  const next = NEXT_STATUS[input.decision];
  const { actorKind, actorId } = actorRef(actor);
  try {
    await runBatch(db, [
      db
        .update(orders)
        .set({
          reviewStatus: next,
          reviewedBy: actorId,
          reviewedAt: now,
          // What the reviewer saw when clearing: a flag that appears later brings the order back.
          riskFlags: input.decision === "clear" ? flags : order.riskFlags,
          updatedAt: now,
        })
        .where(and(eq(orders.id, order.id), eq(orders.reviewStatus, order.reviewStatus))),
      expectChanged(db, 1, { code: "ORDER_CHANGED", detail: order.id }),
      db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: `review_${input.decision}`, data: { from: order.reviewStatus, to: next, flags, reason: input.reason }, actorKind, actorId, at: now }),
      auditStatement(db, {
        actor,
        action: `orders.risk.${input.decision}`,
        entityType: "order",
        entityId: order.id,
        summary: `${order.ref}: review ${order.reviewStatus} → ${next}`,
        before: { reviewStatus: order.reviewStatus },
        after: { reviewStatus: next, flags },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "ORDER_CHANGED")) throw new AppError("order_changed", 409, { detail: order.id, cause: error });
    throw error;
  }
  return { status: next, flags };
}
