/**
 * Admin 07.06 — VIP customers, fraud risk and open complaints, from explained rules (types.ts FLAG_RULES), plus the
 * three labels staff set by hand with a reason: a VIP label, the fraud flag (orders of a flagged customer go to the
 * orders module's human review, rule "customer_flagged") and blocking the account (sign-in and checkout refuse it).
 *
 *   const flags = await customerFlags(db, ids, now);          // Map<customerId, CustomerFlag[]> — each with its numbers
 *   flagCondition("risk", now)                                 // SQL for the list's saved views
 *   await setVip(db, actor, { customerId, tier: "VIP", reason }, now);              customers.customer.update
 *   await setFraudFlag(db, actor, { customerId, flagged: true, reason }, now);      customers.customer.block
 *   await setBlocked(db, actor, { customerId, blocked: true, reason }, now);        customers.customer.block
 *
 * The computed labels are read-only: they follow the orders, proofs and tickets. Every manual change is one guarded
 * batch (the row must still be as the screen read it) with its audit event (before/after, reason).
 */
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement, maskPhonesIn } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { customerSessions, customers } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { changeableCustomer, hasLongDigitRun, num } from "./shared.server";
import { customerRules } from "./rules.server";
import { FLAG_RULES, type CustomerFlag, type CustomerView, type FlagRules } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The numbers behind the labels, as correlated subqueries on `c` (an alias of customers), over the rules' windows. */
function metrics(now: number, rules: FlagRules) {
  const vipSince = now - rules.vipWindowDays * DAY_MS;
  const cancelSince = now - rules.riskCancelledDays * DAY_MS;
  const rejectSince = now - rules.riskRejectedDays * DAY_MS;
  const returnSince = now - rules.riskReturnedDays * DAY_MS;
  return {
    spend: sql`(SELECT coalesce(sum(o.paid_iqd - o.refunded_iqd), 0) FROM orders AS o WHERE o.customer_id = c.id AND o.status <> 'cancelled' AND o.paid_iqd > o.refunded_iqd AND o.placed_at >= ${vipSince})`,
    purchases: sql`(SELECT count(*) FROM orders AS o WHERE o.customer_id = c.id AND o.status <> 'cancelled' AND o.paid_iqd > o.refunded_iqd AND o.placed_at >= ${vipSince})`,
    cancelled: sql`(SELECT count(*) FROM orders AS o WHERE o.customer_id = c.id AND o.status = 'cancelled' AND coalesce(o.cancelled_at, o.placed_at) >= ${cancelSince})`,
    rejected: sql`(SELECT count(*) FROM payment_proofs AS pp JOIN payments AS p ON p.id = pp.payment_id JOIN orders AS o ON o.id = p.order_id WHERE o.customer_id = c.id AND pp.status = 'rejected' AND coalesce(pp.reviewed_at, pp.created_at) >= ${rejectSince})`,
    returned: sql`(SELECT count(*) FROM orders AS o WHERE o.customer_id = c.id AND o.status = 'returned' AND o.placed_at >= ${returnSince})`,
    duplicate: sql`(SELECT count(*) FROM payment_proofs AS pp JOIN payments AS p ON p.id = pp.payment_id JOIN orders AS o ON o.id = p.order_id WHERE o.customer_id = c.id AND pp.duplicate_of IS NOT NULL)`,
    complaints: sql`(SELECT count(*) FROM support_tickets AS t WHERE t.customer_id = c.id AND t.status NOT IN ('resolved', 'closed') AND (t.category = 'complaint' OR t.escalated_at IS NOT NULL))`,
  };
}

/**
 * SQL (on alias `c`) that is true for the customers a saved view of the list shows; null = no condition. `rules`: the
 * thresholds in force (customerRules — the setting customers.flag_rules); FLAG_RULES when left out.
 */
export function flagCondition(view: CustomerView, now: number, rules: FlagRules = FLAG_RULES): SQL | null {
  const m = metrics(now, rules);
  switch (view) {
    case "vip":
      return sql`(c.vip_tier IS NOT NULL OR ${m.spend} >= ${rules.vipSpendIqd} OR ${m.purchases} >= ${rules.vipPurchases})`;
    case "risk":
      return sql`(c.fraud_flag = 1 OR ${m.cancelled} >= ${rules.riskCancelled} OR ${m.rejected} >= ${rules.riskRejectedProofs} OR ${m.returned} >= ${rules.riskReturned} OR ${m.duplicate} > 0)`;
    case "complaints":
      return sql`${m.complaints} > 0`;
    default:
      return null;
  }
}

type FlagRow = {
  id: string;
  vip_tier: string | null;
  fraud_flag: number;
  fraud_reason: string | null;
  spend: number;
  purchases: number;
  cancelled: number;
  rejected: number;
  returned: number;
  duplicate: number;
  complaints: number;
};

/** The flags of each customer, with the numbers that explain them. Customers without a flag get an empty list. */
export async function customerFlags(db: Db, customerIds: readonly string[], now: number): Promise<Map<string, CustomerFlag[]>> {
  const out = new Map<string, CustomerFlag[]>();
  const ids = [...new Set(customerIds)];
  if (ids.length === 0) return out;
  // the thresholds in force (the setting customers.flag_rules — follow-up 2026-11-12)
  const { flags: rules } = await customerRules(db);
  const m = metrics(now, rules);
  // 60 ids per query: each subquery binds its own parameters and D1 allows 100 per statement.
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const rows = await db.all<FlagRow>(sql`
      SELECT c.id, c.vip_tier, c.fraud_flag, c.fraud_reason,
        ${m.spend} AS spend, ${m.purchases} AS purchases, ${m.cancelled} AS cancelled, ${m.rejected} AS rejected,
        ${m.returned} AS returned, ${m.duplicate} AS duplicate, ${m.complaints} AS complaints
      FROM customers AS c WHERE c.id IN (${sql.join(
        chunk.map((id) => sql`${id}`),
        sql`, `,
      )})`);
    for (const row of rows) out.set(row.id, flagsOf(row, rules));
  }
  for (const id of ids) if (!out.has(id)) out.set(id, []);
  return out;
}

function flagsOf(row: FlagRow, rules: FlagRules): CustomerFlag[] {
  const flags: CustomerFlag[] = [];
  const spend = num(row.spend);
  const purchases = num(row.purchases);
  if (row.vip_tier) flags.push({ id: "vip_manual", vars: { tier: row.vip_tier } });
  if (spend >= rules.vipSpendIqd) flags.push({ id: "vip_spend", vars: { amount: spend, threshold: rules.vipSpendIqd, days: rules.vipWindowDays } });
  if (purchases >= rules.vipPurchases) flags.push({ id: "vip_purchases", vars: { count: purchases, threshold: rules.vipPurchases, days: rules.vipWindowDays } });
  if (num(row.fraud_flag) === 1) flags.push({ id: "risk_manual", vars: { reason: row.fraud_reason ? maskPhonesIn(row.fraud_reason) : "—" } });
  if (num(row.cancelled) >= rules.riskCancelled) flags.push({ id: "risk_cancelled", vars: { count: num(row.cancelled), threshold: rules.riskCancelled, days: rules.riskCancelledDays } });
  if (num(row.rejected) >= rules.riskRejectedProofs) flags.push({ id: "risk_rejected_proofs", vars: { count: num(row.rejected), threshold: rules.riskRejectedProofs, days: rules.riskRejectedDays } });
  if (num(row.returned) >= rules.riskReturned) flags.push({ id: "risk_returned", vars: { count: num(row.returned), threshold: rules.riskReturned, days: rules.riskReturnedDays } });
  if (num(row.duplicate) > 0) flags.push({ id: "risk_duplicate_proof", vars: { count: num(row.duplicate) } });
  if (num(row.complaints) > 0) flags.push({ id: "complaint_open", vars: { count: num(row.complaints) } });
  return flags;
}

// ───────────────────────────────────────────────────────────────── manual labels

const reason = z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "required").max(500, "too_long");
const customerId = z.string({ error: "required" }).min(1, "required").max(128, "invalid");

export const SetVipInput = z.object({
  customerId,
  /** The label ("VIP", "ذهبي"…); empty removes it. */
  tier: z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? null : value), z.string().overwrite(cleanLine).trim().min(1, "required").max(30, "too_long").nullable()),
  reason,
});
export type SetVipInput = z.input<typeof SetVipInput>;

function changedGuard(error: unknown): never {
  if (mapDbError(error)?.code === "CUSTOMER_CHANGED") throw new AppError("customer_changed", 409);
  throw error;
}

/** Sets or removes the manual VIP label (07.06). */
export async function setVip(db: Db, actor: Actor, raw: SetVipInput, now: number): Promise<{ tier: string | null }> {
  assertCan(actor, "customers.customer.update");
  const input = SetVipInput.parse(raw);
  const row = await changeableCustomer(db, input.customerId);
  if ((row.vipTier ?? null) === input.tier) throw new AppError("vip_unchanged", 409);
  const same = row.vipTier === null ? isNull(customers.vipTier) : eq(customers.vipTier, row.vipTier);
  await runBatch(db, [
    db.update(customers).set({ vipTier: input.tier, updatedAt: now }).where(and(eq(customers.id, row.id), same, sql`${customers.status} IN ('active', 'blocked')`)),
    expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "customers.customer.vip", entityType: "customer", entityId: row.id, before: { vipTier: row.vipTier }, after: { vipTier: input.tier }, reason: input.reason, at: now }),
  ]).catch(changedGuard);
  return { tier: input.tier };
}

export const SetFlagInput = z.object({ customerId, flagged: z.boolean(), reason });
export type SetFlagInput = z.input<typeof SetFlagInput>;

/**
 * Raises or clears the fraud-risk flag (07.06). While it is raised, the orders module sends the customer's orders to
 * human review (rule customer_flagged). The reason is kept on the customer (fraud_reason) and in the audit trail.
 * Every reader of the customer sees that reason, so it is stored as the audit trail stores text: phone numbers masked
 * ("0771 ••• ••52"), card or account numbers refused (note_has_card_number) — review 2026-11-11.
 */
export async function setFraudFlag(db: Db, actor: Actor, raw: SetFlagInput, now: number): Promise<{ flagged: boolean }> {
  assertCan(actor, "customers.customer.block");
  const input = SetFlagInput.parse(raw);
  if (hasLongDigitRun(input.reason)) throw new AppError("invalid", 400, { fields: { reason: "note_has_card_number" } });
  const row = await changeableCustomer(db, input.customerId);
  if (row.fraudFlag === input.flagged) throw new AppError("flag_unchanged", 409);
  await runBatch(db, [
    db
      .update(customers)
      .set({ fraudFlag: input.flagged, fraudReason: input.flagged ? maskPhonesIn(input.reason) : null, updatedAt: now })
      .where(and(eq(customers.id, row.id), eq(customers.fraudFlag, row.fraudFlag), sql`${customers.status} IN ('active', 'blocked')`)),
    expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: row.id }),
    auditStatement(db, {
      actor,
      action: input.flagged ? "customers.customer.flag" : "customers.customer.unflag",
      entityType: "customer",
      entityId: row.id,
      before: { fraudFlag: row.fraudFlag, fraudReason: row.fraudReason },
      after: { fraudFlag: input.flagged },
      reason: input.reason,
      at: now,
    }),
  ]).catch(changedGuard);
  return { flagged: input.flagged };
}

export const SetBlockedInput = z.object({ customerId, blocked: z.boolean(), reason });
export type SetBlockedInput = z.input<typeof SetBlockedInput>;

/**
 * Blocks or unblocks the account (07.06). A blocked account cannot sign in or check out (account_blocked); its open
 * orders carry on. Blocking also ends the customer's signed-in sessions in the same batch.
 */
export async function setBlocked(db: Db, actor: Actor, raw: SetBlockedInput, now: number): Promise<{ status: "active" | "blocked"; sessionsEnded: number }> {
  assertCan(actor, "customers.customer.block");
  const input = SetBlockedInput.parse(raw);
  const row = await changeableCustomer(db, input.customerId);
  const from = row.status as "active" | "blocked";
  const to = input.blocked ? "blocked" : "active";
  if (from === to) throw new AppError("status_unchanged", 409);
  const open = await db
    .select({ n: sql<number>`count(*)` })
    .from(customerSessions)
    .where(and(eq(customerSessions.customerId, row.id), isNull(customerSessions.revokedAt), sql`${customerSessions.expiresAt} > ${now}`))
    .get();
  const sessions = input.blocked ? num(open?.n) : 0;
  await runBatch(db, [
    db.update(customers).set({ status: to, updatedAt: now }).where(and(eq(customers.id, row.id), eq(customers.status, from))),
    expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: row.id }),
    ...(input.blocked ? [db.update(customerSessions).set({ revokedAt: now }).where(and(eq(customerSessions.customerId, row.id), isNull(customerSessions.revokedAt)))] : []),
    auditStatement(db, {
      actor,
      action: input.blocked ? "customers.customer.block" : "customers.customer.unblock",
      entityType: "customer",
      entityId: row.id,
      before: { status: from },
      after: { status: to, sessionsEnded: sessions },
      reason: input.reason,
      at: now,
    }),
  ]).catch(changedGuard);
  return { status: to, sessionsEnded: sessions };
}
