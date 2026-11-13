/**
 * Admin 08.04 — reward points: earning, reversal, expiry and manual adjustments over the append-only
 * `loyalty_ledger` (balance = SUM(points); a database trigger refuses a row that would overdraw —
 * TT:LOYALTY_OVERDRAFT; every row carries a reason, a reference, an actor, a time and a UNIQUE idempotency key).
 *
 *   loyaltyOverview(db, actor, now) · listLedger(db, actor, filters) · customerPoints(db, actor, customerId, now)
 *   findCustomerId(db, actor, { phone | customerId })
 *   syncOrderPoints(db, actor, now)    earn for delivered orders past the return window; reverse for later refunds
 *   postExpiry(db, actor, now)         points older than LOYALTY.expiryDays that were never used expire (FIFO)
 *   adjustPoints(db, actor, { customerId, points, reason, idempotencyKey }, now)   a second person above 5,000 points,
 *                                       or when the employee gave more than 10,000 alone in 24 hours (no splitting)
 *   decideAdjustment(db, actor, { approvalId, customerId?, decision, note }, now) · withdrawAdjustment(…)
 *                                       customerId = the page's customer: another customer's request is not found
 *
 * Earning: 1 point per whole 1,000 IQD of goods paid and kept (pointsFor in ./rules.ts; shipping earns nothing),
 * times the multiplier of the customer's active VIP membership (08.06), once the order is delivered and its return
 * window (`returns.window_days`) has passed — any channel: an online order, or a sale at the till to a known customer
 * (delivered when it is rung up) — key "loyalty:earn:<order id>", so a re-run or a concurrent run never earns twice. A
 * refund paid after the points were earned reverses its share (key "loyalty:reversal:<refund id>", proportional to
 * what the order kept when it earned; never more than the customer still holds — the rest is counted as spent).
 * Expiry posts one 'expire' row per customer and state (key "loyalty:expire:<customer>:<expired credits>"). Posting
 * runs every night (jobs.server.ts: promotions.points.sync, promotions.points.expire) and at once from the points page.
 *
 * REDEEMING is the commerce core's, not this file's (since 2026-11-12): a signed-in customer redeems points at the
 * online checkout — orders/promotions.ts applyDiscounts step 5 (never more than the balance nor the goods left, ×
 * the point's worth in force), a 'redeem' row in placeOrder's batch (pointsRedeemStatement; the overdraft trigger
 * keeps it safe), given back on a cancel or a parcel refused at the door and a share on a refund
 * (orders/promotions.server.ts: 'reversal' rows with ref_type "redeem", which the earn reversals here — ref_type
 * "order" — never count). HONEST BOUNDARY: the till (admin 06) does not redeem points
 * (routes/admin/promotions/checkout-state.ts says so to staff).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { normalizeIraqPhone } from "~/lib/phone";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, customers, loyaltyLedger } from "~/server/db/schema";
import { chunkRows, expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { cleanBlock } from "~/server/text.server";
import { pointsFor } from "./rules";
import { ID, KEY, SECTION_READ, assertAny, assertMayDecide, canDecideApproval, customerLabels, employeeNames, idFromKey, num } from "./shared.server";
import { DAY_MS, LOYALTY, PAGE_SIZE, parseWhole, type CustomerPoints, type LedgerFilters, type LedgerPage, type LedgerRow, type LoyaltyKind, type LoyaltyOverview, type PendingAdjustment } from "./types";
import { programRules } from "./program.server";

const KIND = "loyalty_adjustment" as const;
export const earnKey = (orderId: string) => `loyalty:earn:${orderId}`;
export const reversalKey = (refundId: string) => `loyalty:reversal:${refundId}`;

function overdraftGuard(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "LOYALTY_OVERDRAFT") throw new AppError("points_insufficient", 409);
  if (info?.code === "CHANGE_NOT_PENDING") throw new AppError("change_not_pending", 409);
  if (info?.code === "POINTS_SOLO_LIMIT") throw new AppError("points_solo_limit", 409);
  if (info?.code === "CUSTOMER_UNAVAILABLE") throw new AppError("customer_unavailable", 409);
  throw error;
}

/** The membership multiplier of each customer's active VIP membership (basis points), when its tier has one. */
export async function multipliers(db: Db, customerIds: readonly string[], now: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(customerIds)];
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    const rows = await db.all<{ customer_id: string; bps: number | null }>(sql`SELECT m.customer_id, CAST(json_extract(t.benefits, '$.pointsMultiplierBps') AS INTEGER) AS bps
      FROM memberships AS m JOIN membership_tiers AS t ON t.id = m.tier_id
      WHERE m.status = 'active' AND m.starts_at <= ${now} AND (m.ends_at IS NULL OR m.ends_at > ${now}) AND m.customer_id IN (${sql.join(part.map((id) => sql`${id}`), sql`, `)})`);
    for (const row of rows) if (row.bps !== null && num(row.bps) > 10_000) out.set(row.customer_id, Math.max(out.get(row.customer_id) ?? 0, num(row.bps)));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── what is waiting

type EarnCandidate = { id: string; ref: string; customer_id: string; subtotal_iqd: number; discount_iqd: number; paid_iqd: number; refunded_iqd: number };

async function earnCandidates(db: Db, now: number, windowDays: number, limit: number): Promise<EarnCandidate[]> {
  const before = now - windowDays * DAY_MS;
  return db.all<EarnCandidate>(sql`SELECT o.id, o.ref, o.customer_id, o.subtotal_iqd, o.discount_iqd, o.paid_iqd, o.refunded_iqd FROM orders AS o
    JOIN customers AS c ON c.id = o.customer_id AND c.status IN ('active', 'blocked')
    WHERE o.status = 'delivered' AND o.delivered_at IS NOT NULL AND o.delivered_at <= ${before}
      AND min(o.subtotal_iqd - o.discount_iqd, o.paid_iqd - o.refunded_iqd) >= 1000
      AND NOT EXISTS (SELECT 1 FROM loyalty_ledger AS l WHERE l.idempotency_key = 'loyalty:earn:' || o.id)
    ORDER BY o.delivered_at ASC LIMIT ${limit}`);
}

type ReversalCandidate = { refund_id: string; refund_iqd: number; order_id: string; ref: string; customer_id: string; earned: number; earned_at: number; subtotal_iqd: number; discount_iqd: number; paid_iqd: number; refunded_before: number; reversed: number };

async function reversalCandidates(db: Db, limit: number): Promise<ReversalCandidate[]> {
  return db.all<ReversalCandidate>(sql`SELECT r.id AS refund_id, r.amount_iqd AS refund_iqd, o.id AS order_id, o.ref, e.customer_id, e.points AS earned, e.at AS earned_at,
      o.subtotal_iqd, o.discount_iqd, o.paid_iqd,
      (SELECT coalesce(sum(r2.amount_iqd), 0) FROM refunds AS r2 WHERE r2.order_id = o.id AND r2.status = 'paid' AND coalesce(r2.paid_at, r2.created_at) <= e.at) AS refunded_before,
      (SELECT coalesce(-sum(l.points), 0) FROM loyalty_ledger AS l WHERE l.kind = 'reversal' AND l.ref_type = 'order' AND l.ref_id = o.id) AS reversed
    FROM refunds AS r
    JOIN orders AS o ON o.id = r.order_id
    JOIN loyalty_ledger AS e ON e.idempotency_key = 'loyalty:earn:' || o.id
    WHERE r.status = 'paid' AND coalesce(r.paid_at, r.created_at) > e.at
      AND NOT EXISTS (SELECT 1 FROM loyalty_ledger AS l WHERE l.idempotency_key = 'loyalty:reversal:' || r.id)
    ORDER BY coalesce(r.paid_at, r.created_at) ASC LIMIT ${limit}`);
}

/** The points one late refund takes back: its share of what the order kept when it earned, never more than is left. */
export function reversalPoints(candidate: Pick<ReversalCandidate, "refund_iqd" | "earned" | "subtotal_iqd" | "discount_iqd" | "paid_iqd" | "refunded_before" | "reversed">): number {
  const keptAtEarn = Math.max(0, Math.min(num(candidate.subtotal_iqd) - num(candidate.discount_iqd), num(candidate.paid_iqd) - num(candidate.refunded_before)));
  if (keptAtEarn <= 0) return 0;
  const share = Math.floor((num(candidate.earned) * Math.min(num(candidate.refund_iqd), keptAtEarn)) / keptAtEarn);
  return Math.max(0, Math.min(share, num(candidate.earned) - num(candidate.reversed)));
}

type BalanceRow = { customer_id: string; expired_credits: number; debits: number };

async function expiryCandidates(db: Db, now: number, limit: number): Promise<BalanceRow[]> {
  return db.all<BalanceRow>(sql`SELECT customer_id,
      sum(CASE WHEN points > 0 AND expires_at IS NOT NULL AND expires_at <= ${now} THEN points ELSE 0 END) AS expired_credits,
      sum(CASE WHEN points < 0 THEN -points ELSE 0 END) AS debits
    FROM loyalty_ledger GROUP BY customer_id
    HAVING expired_credits > debits LIMIT ${limit}`);
}

export async function loyaltyOverview(db: Db, actor: Actor, now: number): Promise<LoyaltyOverview> {
  // the rules in force (the setting promotions.* — program.server.ts, follow-up 2026-11-12)
  const loyalty = (await programRules(db)).loyalty;
  assertAny(actor, SECTION_READ.points);
  const windowDays = await getSetting(db, "returns.window_days");
  const before = now - windowDays * DAY_MS;
  const soon = now + 30 * DAY_MS;
  const [totals, earned, waiting, reversals, expiring, expiry] = await Promise.all([
    db.all<{ points: number; members: number }>(sql`SELECT coalesce(sum(b.balance), 0) AS points, count(*) AS members FROM (SELECT customer_id, sum(points) AS balance FROM loyalty_ledger GROUP BY customer_id HAVING sum(points) > 0) AS b`),
    db.all<{ n: number }>(sql`SELECT coalesce(sum(points), 0) AS n FROM loyalty_ledger WHERE kind = 'earn' AND at >= ${now - 30 * DAY_MS}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM orders AS o JOIN customers AS c ON c.id = o.customer_id AND c.status IN ('active', 'blocked')
      WHERE o.status = 'delivered' AND o.delivered_at IS NOT NULL AND o.delivered_at <= ${before}
        AND min(o.subtotal_iqd - o.discount_iqd, o.paid_iqd - o.refunded_iqd) >= 1000
        AND NOT EXISTS (SELECT 1 FROM loyalty_ledger AS l WHERE l.idempotency_key = 'loyalty:earn:' || o.id)`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM refunds AS r JOIN loyalty_ledger AS e ON e.idempotency_key = 'loyalty:earn:' || r.order_id
      WHERE r.status = 'paid' AND coalesce(r.paid_at, r.created_at) > e.at AND NOT EXISTS (SELECT 1 FROM loyalty_ledger AS l WHERE l.idempotency_key = 'loyalty:reversal:' || r.id)`),
    db.all<{ n: number }>(sql`SELECT coalesce(sum(CASE WHEN x.soon > x.debits THEN x.soon - x.debits ELSE 0 END), 0) AS n FROM (SELECT customer_id,
        sum(CASE WHEN points > 0 AND expires_at IS NOT NULL AND expires_at <= ${soon} THEN points ELSE 0 END) AS soon,
        sum(CASE WHEN points < 0 THEN -points ELSE 0 END) AS debits FROM loyalty_ledger GROUP BY customer_id) AS x`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM (SELECT customer_id FROM loyalty_ledger GROUP BY customer_id
        HAVING sum(CASE WHEN points > 0 AND expires_at IS NOT NULL AND expires_at <= ${now} THEN points ELSE 0 END) > sum(CASE WHEN points < 0 THEN -points ELSE 0 END))`),
  ]);
  const outstanding = num(totals[0]?.points);
  return {
    outstandingPoints: outstanding,
    outstandingValueIqd: outstanding * loyalty.pointValueIqd,
    members: num(totals[0]?.members),
    earned30d: num(earned[0]?.n),
    expiringPoints30d: num(expiring[0]?.n),
    ordersWaiting: num(waiting[0]?.n),
    reversalsWaiting: num(reversals[0]?.n),
    expiryWaiting: num(expiry[0]?.n),
    returnWindowDays: windowDays,
  };
}

// ───────────────────────────────────────────────────────────────── the ledger

type LedgerJoin = { id: string; at: number; kind: LoyaltyKind; points: number; customer_id: string; ref_type: string | null; ref_id: string | null; reason: string | null; expires_at: number | null; actor_kind: string; actor_id: string | null; order_ref: string | null };

async function ledgerRows(db: Db, actor: Actor, where: ReturnType<typeof sql>, limit: number, offset: number): Promise<LedgerRow[]> {
  const rows = await db.all<LedgerJoin>(sql`SELECT l.id, l.at, l.kind, l.points, l.customer_id, l.ref_type, l.ref_id, l.reason, l.expires_at, l.actor_kind, l.actor_id,
      CASE WHEN l.ref_type = 'order' THEN (SELECT o.ref FROM orders AS o WHERE o.id = l.ref_id) END AS order_ref
    FROM loyalty_ledger AS l WHERE ${where} ORDER BY l.at DESC, l.id DESC LIMIT ${limit} OFFSET ${offset}`);
  const [people, names] = await Promise.all([customerLabels(db, actor, rows.map((row) => row.customer_id)), employeeNames(db, rows.filter((row) => row.actor_kind === "employee").map((row) => row.actor_id))]);
  return rows.map((row) => ({
    id: row.id,
    at: num(row.at),
    kind: row.kind,
    points: num(row.points),
    customerId: row.customer_id,
    customer: people.get(row.customer_id)?.name ?? null,
    phone: people.get(row.customer_id)?.phone ?? null,
    refType: row.ref_type,
    refLabel: row.order_ref ?? (row.ref_type === "referral" ? row.ref_id : null),
    reason: row.reason,
    expiresAt: row.expires_at === null ? null : num(row.expires_at),
    actor: row.actor_kind === "employee" ? (row.actor_id ? (names.get(row.actor_id) ?? null) : null) : row.actor_kind === "system" ? "system" : null,
  }));
}

export async function listLedger(db: Db, actor: Actor, filters: LedgerFilters): Promise<LedgerPage> {
  assertAny(actor, SECTION_READ.points);
  const parts = [sql`1 = 1`];
  if (filters.kind) parts.push(sql`l.kind = ${filters.kind}`);
  if (filters.customer) parts.push(sql`l.customer_id = ${filters.customer}`);
  const where = sql.join(parts, sql` AND `);
  const [rows, total] = await Promise.all([ledgerRows(db, actor, where, PAGE_SIZE, (filters.page - 1) * PAGE_SIZE), db.all<{ n: number }>(sql`SELECT count(*) AS n FROM loyalty_ledger AS l WHERE ${where}`)]);
  const count = num(total[0]?.n);
  return { rows, total: count, page: filters.page, pageCount: Math.max(1, Math.ceil(count / PAGE_SIZE)) };
}

/** A customer's account by a phone number typed (any form) or an id; null when there is none. */
export async function findCustomerId(db: Db, actor: Actor, input: { phone?: string; customerId?: string }): Promise<string | null> {
  assertAny(actor, SECTION_READ.points);
  if (input.customerId && ID.test(input.customerId)) return (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).get())?.id ?? null;
  const phone = normalizeIraqPhone(input.phone ?? "");
  if (!phone) return null;
  return (await db.select({ id: customers.id }).from(customers).where(eq(customers.phoneE164, phone)).get())?.id ?? null;
}

export async function customerPoints(db: Db, actor: Actor, customerId: string, now: number): Promise<CustomerPoints> {
  // the rules in force (the setting promotions.* — program.server.ts, follow-up 2026-11-12)
  const loyalty = (await programRules(db)).loyalty;
  assertAny(actor, SECTION_READ.points);
  if (!ID.test(customerId)) throw notFound("customer");
  const customer = await db.select({ id: customers.id, status: customers.status }).from(customers).where(eq(customers.id, customerId)).get();
  if (!customer) throw notFound("customer");
  const soon = now + 30 * DAY_MS;
  const [label, sums, entries, pending, multiplier] = await Promise.all([
    customerLabels(db, actor, [customer.id]),
    db.all<{ balance: number; soon: number; debits: number }>(sql`SELECT coalesce(sum(points), 0) AS balance,
        coalesce(sum(CASE WHEN points > 0 AND expires_at IS NOT NULL AND expires_at <= ${soon} THEN points ELSE 0 END), 0) AS soon,
        coalesce(sum(CASE WHEN points < 0 THEN -points ELSE 0 END), 0) AS debits FROM loyalty_ledger WHERE customer_id = ${customer.id}`),
    ledgerRows(db, actor, sql`l.customer_id = ${customer.id}`, 100, 0),
    db.select().from(approvals).where(and(eq(approvals.kind, KIND), eq(approvals.entityId, customer.id), eq(approvals.status, "pending"))).orderBy(desc(approvals.createdAt)),
    multipliers(db, [customer.id], now),
  ]);
  const names = await employeeNames(db, pending.map((row) => row.requestedBy));
  const balance = num(sums[0]?.balance);
  return {
    customerId: customer.id,
    name: label.get(customer.id)?.name ?? null,
    phone: label.get(customer.id)?.phone ?? null,
    status: customer.status,
    balance,
    valueIqd: balance * loyalty.pointValueIqd,
    expiringSoon: Math.min(balance, Math.max(0, num(sums[0]?.soon) - num(sums[0]?.debits))),
    multiplierBps: multiplier.get(customer.id) ?? null,
    entries,
    pending: pending.map(
      (row): PendingAdjustment => ({
        approvalId: row.id,
        points: num((row.payload as { points?: number } | null)?.points),
        reason: row.reason,
        requestedBy: names.get(row.requestedBy) ?? null,
        requestedAt: row.createdAt,
        mine: actor.kind === "employee" && row.requestedBy === actor.id,
        canDecide: canDecideApproval(actor, row),
      }),
    ),
    canAdjust: can(actor, "promotions.loyalty.adjust") && (customer.status === "active" || customer.status === "blocked"),
    canSeeProfile: can(actor, "customers.customer.read"),
  };
}

// ───────────────────────────────────────────────────────────────── posting

/**
 * Posts what is due: earn rows for orders delivered and past their return window, then reversals for refunds paid
 * after an order earned. Idempotent (the keys above); at most loyalty.syncBatchOrders of each per run.
 */
export async function syncOrderPoints(db: Db, actor: Actor, now: number): Promise<{ earnedOrders: number; earnedPoints: number; reversed: number; reversedPoints: number; spent: number; more: boolean }> {
  // the rules in force (the setting promotions.* — program.server.ts, follow-up 2026-11-12)
  const loyalty = (await programRules(db)).loyalty;
  assertCan(actor, "promotions.loyalty.manage");
  const windowDays = await getSetting(db, "returns.window_days");
  const candidates = await earnCandidates(db, now, windowDays, loyalty.syncBatchOrders + 1);
  const more = candidates.length > loyalty.syncBatchOrders;
  const batch = candidates.slice(0, loyalty.syncBatchOrders);
  const factor = await multipliers(db, batch.map((row) => row.customer_id), now);
  const { actorKind, actorId } = actorRef(actor);
  const rows = batch
    .map((order) => ({ order, points: pointsFor({ paidIqd: num(order.paid_iqd), refundedIqd: num(order.refunded_iqd), subtotalIqd: num(order.subtotal_iqd), discountIqd: num(order.discount_iqd) }, factor.get(order.customer_id) ?? null, loyalty.pointsPerThousandIqd) }))
    .filter((entry) => entry.points > 0)
    .map(({ order, points }) => ({
      id: newId("lyl"),
      customerId: order.customer_id,
      points,
      kind: "earn" as const,
      refType: "order",
      refId: order.id,
      reason: `${order.ref}`,
      expiresAt: now + loyalty.expiryDays * DAY_MS,
      actorKind,
      actorId,
      idempotencyKey: earnKey(order.id),
      at: now,
    }));
  if (rows.length) {
    const statements: BatchStatement[] = chunkRows(loyaltyLedger, rows).map((chunk) => db.insert(loyaltyLedger).values(chunk).onConflictDoNothing({ target: loyaltyLedger.idempotencyKey }));
    statements.push(auditStatement(db, { actor, action: "promotions.loyalty.earn", entityType: "loyalty", entityId: "orders", after: { orders: rows.length, points: rows.reduce((sum, row) => sum + row.points, 0) }, at: now }));
    await runBatch(db, statements);
  }
  // A concurrent run may have written some of them first: count what this run really stored.
  let earnedOrders = 0;
  let earnedPoints = 0;
  for (let i = 0; i < rows.length; i += 90) {
    const ids = rows.slice(i, i + 90).map((row) => row.id);
    const stored = await db.select({ points: loyaltyLedger.points }).from(loyaltyLedger).where(inArray(loyaltyLedger.id, ids));
    earnedOrders += stored.length;
    earnedPoints += stored.reduce((sum, row) => sum + row.points, 0);
  }

  let reversed = 0;
  let reversedPoints = 0;
  let spent = 0;
  const lates = await reversalCandidates(db, loyalty.syncBatchOrders);
  for (const late of lates) {
    let points = reversalPoints(late);
    if (points <= 0) continue;
    const balance = num((await db.select({ n: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)` }).from(loyaltyLedger).where(eq(loyaltyLedger.customerId, late.customer_id)).get())?.n);
    if (balance < points) {
      spent += points - Math.max(0, balance);
      points = Math.max(0, balance);
    }
    if (points <= 0) continue;
    try {
      await runBatch(db, [
        db
          .insert(loyaltyLedger)
          .values({ id: newId("lyl"), customerId: late.customer_id, points: -points, kind: "reversal", refType: "order", refId: late.order_id, reason: `${late.ref} · refund ${late.refund_id}`, expiresAt: null, actorKind, actorId, idempotencyKey: reversalKey(late.refund_id), at: now })
          .onConflictDoNothing({ target: loyaltyLedger.idempotencyKey }),
        auditStatement(db, { actor, action: "promotions.loyalty.reverse", entityType: "customer", entityId: late.customer_id, after: { orderId: late.order_id, refundId: late.refund_id, points: -points }, at: now }),
      ]);
      reversed += 1;
      reversedPoints += points;
    } catch (error) {
      // the customer spent them meanwhile: the next run takes back what is left
      if (mapDbError(error)?.code !== "LOYALTY_OVERDRAFT") throw error;
      spent += points;
    }
  }
  return { earnedOrders, earnedPoints, reversed, reversedPoints, spent, more };
}

/** Expires what is due, one 'expire' row per customer (FIFO, ./rules.ts expiredUnconsumed). */
export async function postExpiry(db: Db, actor: Actor, now: number): Promise<{ customers: number; points: number }> {
  assertCan(actor, "promotions.loyalty.manage");
  const due = await expiryCandidates(db, now, 500);
  const { actorKind, actorId } = actorRef(actor);
  const rows = due
    .map((row) => ({ row, points: num(row.expired_credits) - num(row.debits) }))
    .filter((entry) => entry.points > 0)
    .map(({ row, points }) => ({ id: newId("lyl"), customerId: row.customer_id, points: -points, kind: "expire" as const, refType: "expiry", refId: null, reason: `expired by ${new Date(now).toISOString().slice(0, 10)}`, expiresAt: null, actorKind, actorId, idempotencyKey: `loyalty:expire:${row.customer_id}:${num(row.expired_credits)}`, at: now }));
  if (rows.length === 0) return { customers: 0, points: 0 };
  const statements: BatchStatement[] = chunkRows(loyaltyLedger, rows).map((chunk) => db.insert(loyaltyLedger).values(chunk).onConflictDoNothing({ target: loyaltyLedger.idempotencyKey }));
  statements.push(auditStatement(db, { actor, action: "promotions.loyalty.expire", entityType: "loyalty", entityId: "expiry", after: { customers: rows.length, points: rows.reduce((sum, row) => sum - row.points, 0) }, at: now }));
  await runBatch(db, statements).catch(overdraftGuard);
  // a concurrent run may have posted some first (same key): count what this run stored
  let customersExpired = 0;
  let points = 0;
  for (let i = 0; i < rows.length; i += 90) {
    const stored = await db.select({ points: loyaltyLedger.points }).from(loyaltyLedger).where(inArray(loyaltyLedger.id, rows.slice(i, i + 90).map((row) => row.id)));
    customersExpired += stored.length;
    points += stored.reduce((sum, row) => sum - row.points, 0);
  }
  return { customers: customersExpired, points };
}

// ───────────────────────────────────────────────────────────────── manual adjustments

export const AdjustInput = z.object({
  customerId: z.string({ error: "required" }).regex(ID, "invalid"),
  points: z.preprocess((value) => (value === "" || value === null || value === undefined ? undefined : parseWhole(value) ?? Number.NaN), z.number({ error: (issue) => (issue.input === undefined ? "required" : "number_invalid") }).int("number_invalid").refine((value) => value !== 0, "required").refine((value) => Math.abs(value) <= LOYALTY.maxAdjustPoints, "too_big")),
  reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long"),
  idempotencyKey: z.string({ error: "required" }).regex(KEY, "invalid"),
});

async function adjustableCustomer(db: Db, customerId: string) {
  const customer = await db.select({ id: customers.id, status: customers.status }).from(customers).where(eq(customers.id, customerId)).get();
  if (!customer) throw notFound("customer");
  if (customer.status !== "active" && customer.status !== "blocked") throw new AppError("customer_unavailable", 409);
  return customer;
}

/** Inside a batch: the customer may still hold points (not merged or erased meanwhile). */
const customerStillThere = (db: Db, customerId: string) => expectThat(db, sql`EXISTS (SELECT 1 FROM customers WHERE id = ${customerId} AND status IN ('active', 'blocked'))`, { code: "CUSTOMER_UNAVAILABLE", detail: customerId });

/** The points one employee GAVE alone (manual credits, no second person) in the 24 hours before `now` — SQL, so a batch re-checks it. */
const soloGivenSql = (employeeId: string, now: number) =>
  sql`(SELECT coalesce(sum(points), 0) FROM loyalty_ledger WHERE kind = 'adjust' AND ref_type = 'manual' AND actor_kind = 'employee' AND actor_id = ${employeeId} AND points > 0 AND at > ${now - DAY_MS})`;

/**
 * Adds or takes points by hand with a reason. Up to LOYALTY.adjustSecondPersonPoints either way it is posted at once —
 * as long as what this employee GAVE alone in the last 24 hours stays within LOYALTY.adjustSoloDayPoints (no splitting
 * a large gift into small ones; the window is re-checked inside the batch, so two tabs at once cannot both slip under
 * it: `points_solo_limit`). Beyond, it waits for a second person (promotions.loyalty.adjust, not the requester). Added
 * points expire like earned ones; taking more than the customer holds is refused (`points_insufficient`).
 */
export async function adjustPoints(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "applied" | "requested"; replayed: boolean }> {
  // the rules in force (the setting promotions.* — program.server.ts, follow-up 2026-11-12)
  const loyalty = (await programRules(db)).loyalty;
  assertCan(actor, "promotions.loyalty.adjust");
  const parsed = AdjustInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "loyalty.adjust");
  const input = parsed.data;
  const customer = await adjustableCustomer(db, input.customerId);
  const key = `loyalty:adjust:${await idFromKey("adj", actor, input.idempotencyKey)}`;
  // the same form sent again after it was posted: its first answer
  const done = await db.select({ id: loyaltyLedger.id, points: loyaltyLedger.points }).from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, key)).get();
  if (done) {
    if (done.points !== input.points) throw new AppError("idempotency_mismatch", 409);
    return { status: "applied", replayed: true };
  }
  const employeeId = actor.kind === "employee" ? actor.id : null;
  const soloSoFar = employeeId && input.points > 0 ? num((await db.all<{ n: number }>(sql`SELECT ${soloGivenSql(employeeId, now)} AS n`))[0]?.n) : 0;
  const overDay = input.points > 0 && soloSoFar + input.points > loyalty.adjustSoloDayPoints;
  if (Math.abs(input.points) > loyalty.adjustSecondPersonPoints || overDay) {
    const approvalId = await idFromKey("apr", actor, `${input.idempotencyKey}:points`);
    const existing = await db.select({ id: approvals.id, payload: approvals.payload }).from(approvals).where(eq(approvals.id, approvalId)).get();
    if (existing) {
      if ((existing.payload as { points?: number } | null)?.points !== input.points) throw new AppError("idempotency_mismatch", 409);
      return { status: "requested", replayed: true };
    }
    await runBatch(db, [
      db.insert(approvals).values({ id: approvalId, kind: KIND, entityType: "customer", entityId: customer.id, requestedBy: employeeId ?? "system", payload: { points: input.points, key, soloSoFar }, status: "pending", reason: input.reason, createdAt: now }),
      auditStatement(db, { actor, action: "promotions.loyalty.request", entityType: "customer", entityId: customer.id, after: { points: input.points, soloSoFar }, reason: input.reason, at: now }),
    ]);
    return { status: "requested", replayed: false };
  }
  const { actorKind, actorId } = actorRef(actor);
  try {
    await runBatch(db, [
      customerStillThere(db, customer.id),
      // the 24-hour window again inside the batch: two adjustments sent at once cannot both slip under it
      ...(employeeId && input.points > 0 ? [expectThat(db, sql`${soloGivenSql(employeeId, now)} + ${input.points} <= ${loyalty.adjustSoloDayPoints}`, { code: "POINTS_SOLO_LIMIT", detail: employeeId })] : []),
      db.insert(loyaltyLedger).values({ id: newId("lyl"), customerId: customer.id, points: input.points, kind: "adjust", refType: "manual", refId: null, reason: input.reason, expiresAt: input.points > 0 ? now + loyalty.expiryDays * DAY_MS : null, actorKind, actorId, idempotencyKey: key, at: now }),
      auditStatement(db, { actor, action: "promotions.loyalty.adjust", entityType: "customer", entityId: customer.id, after: { points: input.points }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    // the same form sent twice at once: the other request stored it
    if (mapDbError(error)?.kind === "unique") return { status: "applied", replayed: true };
    overdraftGuard(error);
  }
  return { status: "applied", replayed: false };
}

/** `customerId`: the customer whose page sent the decision — another customer's request is not found there (no IDOR). */
export const DecideAdjustmentInput = z.object({ approvalId: z.string().regex(ID, "invalid"), customerId: z.string().regex(ID, "invalid").optional(), decision: z.enum(["approve", "reject"], { error: "required" }), note: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(500, "too_long")) });

export async function decideAdjustment(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "approved" | "rejected"; customerId: string }> {
  assertCan(actor, "promotions.loyalty.adjust");
  const parsed = DecideAdjustmentInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "loyalty.decide");
  const input = parsed.data;
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId || (input.customerId !== undefined && approval.entityId !== input.customerId)) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  assertMayDecide(actor, approval);
  if (input.decision === "reject" && input.note.length < 3) throw invalid({ note: "reason_short" });
  const payload = (approval.payload ?? {}) as { points?: number; key?: string };
  const points = num(payload.points);
  const customer = input.decision === "approve" ? await adjustableCustomer(db, approval.entityId) : { id: approval.entityId };
  // the days in force (the setting promotions.loyalty), like a direct adjustment and earned points — review 2026-11-12:
  // an approved adjustment kept the constant LOYALTY.expiryDays
  const { expiryDays } = (await programRules(db)).loyalty;
  const actorId = actor.kind === "employee" ? actor.id : "system";
  const statements: BatchStatement[] = [
    db
      .update(approvals)
      .set({ status: input.decision === "approve" ? "approved" : "rejected", decidedBy: actorId, decidedAt: now, decisionNote: input.note || null })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
  ];
  if (input.decision === "approve") {
    if (points === 0 || !payload.key) throw new AppError("change_not_pending", 409);
    // the requester stays the author of the movement; the approver is in the audit event
    statements.push(
      customerStillThere(db, customer.id),
      db.insert(loyaltyLedger).values({ id: newId("lyl"), customerId: customer.id, points, kind: "adjust", refType: "approval", refId: approval.id, reason: approval.reason, expiresAt: points > 0 ? now + expiryDays * DAY_MS : null, actorKind: "employee", actorId: approval.requestedBy, idempotencyKey: payload.key, at: now }),
    );
  }
  statements.push(auditStatement(db, { actor, action: input.decision === "approve" ? "promotions.loyalty.approve" : "promotions.loyalty.reject", entityType: "customer", entityId: customer.id, after: { approvalId: approval.id, points }, reason: input.note || approval.reason, at: now }));
  await runBatch(db, statements).catch(overdraftGuard);
  return { status: input.decision === "approve" ? "approved" : "rejected", customerId: customer.id };
}

export async function withdrawAdjustment(db: Db, actor: Actor, raw: { approvalId: string; customerId?: string }, now: number): Promise<{ customerId: string }> {
  assertCan(actor, "promotions.loyalty.adjust");
  const approvalId = z.string().regex(ID, "invalid").parse(raw.approvalId);
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId || (raw.customerId !== undefined && approval.entityId !== raw.customerId)) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  if (actor.kind !== "employee" || approval.requestedBy !== actor.id) throw new AppError("forbidden", 403, { detail: "not_requester" });
  await runBatch(db, [
    db.update(approvals).set({ status: "rejected", decidedBy: actor.id, decidedAt: now, decisionNote: "withdrawn" }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
    auditStatement(db, { actor, action: "promotions.loyalty.withdraw", entityType: "customer", entityId: approval.entityId, after: { approvalId: approval.id }, at: now }),
  ]).catch(overdraftGuard);
  return { customerId: approval.entityId };
}

/**
 * Posts referral reward points (used by referrals.server.ts inside its own batch). `expiryDays`: the programme's days
 * in force (programRules — the setting promotions.loyalty; review 2026-11-12), LOYALTY.expiryDays when left out.
 */
export function rewardPointsStatement(db: Db, actor: Actor, input: { customerId: string; points: number; referralId: string; code: string; expiryDays?: number }, now: number): BatchStatement {
  const { actorKind, actorId } = actorRef(actor);
  return db.insert(loyaltyLedger).values({ id: newId("lyl"), customerId: input.customerId, points: input.points, kind: "earn", refType: "referral", refId: input.referralId, reason: `referral ${input.code}`, expiresAt: now + (input.expiryDays ?? LOYALTY.expiryDays) * DAY_MS, actorKind, actorId, idempotencyKey: `referral:${input.referralId}:reward`, at: now });
}
