/**
 * Admin 07.05 — merging duplicate accounts after verification, with the plan shown before anyone confirms and an
 * audit trail that keeps the original references.
 *
 *   await duplicateCandidates(db, actor, customerId)            other accounts that look like the same person, with why
 *   await storeDuplicates(db, actor)                             such pairs across the store
 *   await planMerge(db, actor, { keepId, mergeId }, now)         what moves, what stays, what stands in the way
 *   await mergeCustomers(db, actor, { keepId, mergeId, method, verification, reason, fingerprint }, now)
 *   await recentMerges(db, actor)                                                          customers.customer.merge
 *
 * The duplicate ("merge") account is folded into the kept one in ONE batch: its orders (each gets an order event
 * "customer_merged" naming both accounts), addresses (its default stops being one when the kept account has its own),
 * favourites, saved devices and recently viewed (the kept account's copy wins on a duplicate), notifications, guest
 * contacts, returns, warranties, repairs, support tickets, trade-ins, coupon redemptions (so per-customer coupon
 * limits keep counting) and reviews (unless the kept account reviewed the same product) move; its sessions end; it
 * becomes status "merged" with merged_into_id → the kept account, and can no longer sign in.
 *
 * The WALLET's money moves too (since 2026-11-12): the commerce core's `walletTransferStatements` in the merge's batch
 * — a debit row on the duplicate's append-only ledger, a credit row on the kept account's, the duplicate left at exactly
 * 0 (re-checked in the batch: merge_plan_changed when money arrived meanwhile); the duplicate's ledger stays readable
 * under it. What never moves:
 *   · a pending top-up or a pending adjustment (merge_blocked, with a link to its wallet page) and loyalty points.
 *   · CONSENTS: never carried over as a grant. Per question, when the duplicate's newest answer is a withdrawal newer
 *     than the kept account's answer, a withdrawal is recorded on the kept account (source "merge").
 *   · the audit trail and the duplicate's own history.
 * The labels that protect the store never vanish in a merge (review 2026-11-11): a BLOCKED duplicate is not folded into
 * an account that is not blocked (duplicate_blocked — merge the other way, or unblock it first with a reason), and a
 * FRAUD-FLAGGED one not into an account without the flag (duplicate_flagged — flag the kept account first, with a
 * reason, so module 05 keeps reviewing the person's orders). Both are checked again inside the batch.
 * Wallet balances are shown only to staff with customers.wallet.read (the plan says "holds money" to the others).
 * The plan carries a fingerprint; a merge sent with an older one is refused (merge_plan_changed) so nobody confirms
 * numbers they did not see. Verification is required (how staff confirmed both accounts are the same person, with a
 * note) together with a reason; both go into the two audit events, with the moved order references.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { auditEvents, customers, orderEvents, orders } from "~/server/db/schema";
import { batchSql, chunkRows, expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError } from "~/server/errors";
import { consentStatement } from "~/server/services/account/preferences.server";
import { walletTransferStatements } from "~/server/services/wallet.server";
import { cleanBlock } from "~/server/text.server";
import { customerById, employeeNames, ID, num, phoneView } from "./shared.server";
import { CONSENT_KIND_LIST, MERGE_VERIFY_METHODS, type ConsentKindKey, type DuplicateReason, type PhoneView } from "./types";

export type MergeSide = {
  id: string;
  name: string | null;
  phone: PhoneView | null;
  email: string | null;
  status: string;
  fraudFlag: boolean;
  createdAt: number;
  orders: number;
  spentIqd: number;
  /** The wallet balance (ledger sum); null for staff without customers.wallet.read. */
  walletIqd: number | null;
  lastOrderAt: number | null;
  isDemo: boolean;
};

export type MergeMoves = {
  orders: number;
  addresses: number;
  wishlist: number;
  savedDevices: number;
  recentlyViewed: number;
  notifications: number;
  guestContacts: number;
  returns: number;
  warranties: number;
  repairs: number;
  tickets: number;
  tradeIns: number;
  couponRedemptions: number;
  reviews: number;
  sessions: number;
};
export type MergeStays = { walletEntries: number; topups: number; consents: number; duplicateFavourites: number; duplicateReviews: number };
export type MergeBlocker = {
  code: "same_account" | "keep_unavailable" | "merge_unavailable" | "duplicate_blocked" | "duplicate_flagged" | "wallet_balance" | "pending_topups" | "pending_adjustments" | "loyalty_balance" | "open_privacy" | "growth_records";
  /** IQD for wallet_balance (absent without customers.wallet.read), points for loyalty_balance. */
  amount?: number;
  count?: number;
};
export type MergePlan = { keep: MergeSide; merge: MergeSide; moves: MergeMoves; stays: MergeStays; consentCarry: ConsentKindKey[]; blockers: MergeBlocker[]; fingerprint: string; walletHref: string | null };
/** A side as the database has it (the wallet balance always a number): what the fingerprint and the audit use. */
type FullSide = Omit<MergeSide, "walletIqd"> & { walletIqd: number };
type FullPlan = Omit<MergePlan, "keep" | "merge"> & { keep: FullSide; merge: FullSide };

const one = async (db: Db, query: SQL) => num((await db.all<{ n: number }>(query))[0]?.n);

async function side(db: Db, actor: Actor, id: string): Promise<FullSide> {
  const row = await customerById(db, id);
  const [stats] = await db.all<{ orders: number; spent: number; last_at: number | null; wallet: number }>(sql`
    SELECT (SELECT count(*) FROM orders WHERE customer_id = ${id}) AS orders,
      (SELECT coalesce(sum(paid_iqd - refunded_iqd), 0) FROM orders WHERE customer_id = ${id} AND status <> 'cancelled' AND paid_iqd > refunded_iqd) AS spent,
      (SELECT max(placed_at) FROM orders WHERE customer_id = ${id}) AS last_at,
      (SELECT coalesce(sum(amount_iqd), 0) FROM wallet_ledger WHERE customer_id = ${id}) AS wallet`);
  return {
    id: row.id,
    name: row.name,
    phone: phoneView(row.phoneE164, can(actor, "customer.phone.read_full")),
    email: row.email,
    status: row.status,
    fraudFlag: row.fraudFlag,
    createdAt: row.createdAt,
    orders: num(stats?.orders),
    spentIqd: num(stats?.spent),
    walletIqd: num(stats?.wallet),
    lastOrderAt: stats?.last_at === null || stats?.last_at === undefined ? null : num(stats.last_at),
    isDemo: row.isDemo,
  };
}

/** A side as this employee may see it: the wallet balance only with customers.wallet.read (review 2026-11-11). */
function sideFor(actor: Actor, full: FullSide): MergeSide {
  return can(actor, "customers.wallet.read") ? full : { ...full, walletIqd: null };
}

/** The plan as this employee may see it: wallet amounts only with customers.wallet.read; the fingerprint unchanged. */
function planForViewer(actor: Actor, plan: FullPlan): MergePlan {
  if (can(actor, "customers.wallet.read")) return plan;
  return {
    ...plan,
    keep: sideFor(actor, plan.keep),
    merge: sideFor(actor, plan.merge),
    blockers: plan.blockers.map((blocker) => (blocker.code === "wallet_balance" ? { code: blocker.code } : blocker)),
  };
}

/** The newest answer per consent question, with its time. */
async function latestAnswers(db: Db, customerId: string): Promise<Map<ConsentKindKey, { granted: boolean; at: number }>> {
  const rows = await db.all<{ kind: ConsentKindKey; granted: number; at: number; id: string }>(sql`
    SELECT kind, granted, at, id FROM consents WHERE subject_type = 'customer' AND subject_id = ${customerId} ORDER BY at DESC, id DESC`);
  const out = new Map<ConsentKindKey, { granted: boolean; at: number }>();
  for (const row of rows) if (!out.has(row.kind)) out.set(row.kind, { granted: num(row.granted) === 1, at: num(row.at) });
  return out;
}

/** Withdrawals to record on the kept account: the duplicate's newer "no" (a grant is never carried). */
async function consentCarry(db: Db, keepId: string, mergeId: string): Promise<ConsentKindKey[]> {
  const [keep, merge] = await Promise.all([latestAnswers(db, keepId), latestAnswers(db, mergeId)]);
  return CONSENT_KIND_LIST.filter((kind) => {
    const theirs = merge.get(kind);
    if (!theirs || theirs.granted) return false;
    const mine = keep.get(kind);
    return !mine || (mine.granted && theirs.at > mine.at);
  });
}

export const MergeRefInput = z.object({ keepId: z.string().regex(ID, "invalid"), mergeId: z.string().regex(ID, "invalid") });

export async function planMerge(db: Db, actor: Actor, raw: z.input<typeof MergeRefInput>, now: number): Promise<MergePlan> {
  assertCan(actor, "customers.customer.merge");
  void now;
  const { keepId, mergeId } = MergeRefInput.parse(raw);
  return planForViewer(actor, await buildPlan(db, actor, keepId, mergeId));
}

/** The whole plan with the real numbers (the fingerprint and the audit events are made from it). */
async function buildPlan(db: Db, actor: Actor, keepId: string, mergeId: string): Promise<FullPlan> {
  const [keep, merge] = await Promise.all([side(db, actor, keepId), side(db, actor, mergeId)]);
  const m = mergeId;
  const k = keepId;
  const [
    ordersN,
    addressesN,
    wishMove,
    wishDup,
    devicesMove,
    recentMove,
    noticesN,
    guestsN,
    returnsN,
    warrantiesN,
    repairsN,
    ticketsN,
    tradesN,
    couponsN,
    reviewsMove,
    reviewsDup,
    sessionsN,
    walletEntries,
    topupsN,
    consentsN,
    pendingTopups,
    pendingAdjustments,
    loyalty,
    openPrivacy,
    growth,
    carry,
  ] = await Promise.all([
    one(db, sql`SELECT count(*) AS n FROM orders WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM addresses WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM wishlist_items WHERE customer_id = ${m} AND product_id NOT IN (SELECT product_id FROM wishlist_items WHERE customer_id = ${k})`),
    one(db, sql`SELECT count(*) AS n FROM wishlist_items WHERE customer_id = ${m} AND product_id IN (SELECT product_id FROM wishlist_items WHERE customer_id = ${k})`),
    one(db, sql`SELECT count(*) AS n FROM saved_devices WHERE customer_id = ${m} AND device_model_id NOT IN (SELECT device_model_id FROM saved_devices WHERE customer_id = ${k})`),
    one(db, sql`SELECT count(*) AS n FROM recently_viewed WHERE customer_id = ${m} AND product_id NOT IN (SELECT product_id FROM recently_viewed WHERE customer_id = ${k})`),
    one(db, sql`SELECT count(*) AS n FROM notifications WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM guest_contacts WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM returns WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM warranties WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM repair_tickets WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM support_tickets WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM trade_ins WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM coupon_redemptions WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM reviews WHERE customer_id = ${m} AND product_id NOT IN (SELECT product_id FROM reviews WHERE customer_id = ${k})`),
    one(db, sql`SELECT count(*) AS n FROM reviews WHERE customer_id = ${m} AND product_id IN (SELECT product_id FROM reviews WHERE customer_id = ${k})`),
    one(db, sql`SELECT count(*) AS n FROM customer_sessions WHERE customer_id = ${m} AND revoked_at IS NULL`),
    one(db, sql`SELECT count(*) AS n FROM wallet_ledger WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM wallet_topups WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM consents WHERE subject_type = 'customer' AND subject_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM wallet_topups WHERE customer_id = ${m} AND status = 'pending_verification'`),
    one(db, sql`SELECT count(*) AS n FROM approvals WHERE kind IN ('wallet_adjustment', 'wallet_payout') AND entity_id = ${m} AND status = 'pending'`),
    one(db, sql`SELECT coalesce(sum(points), 0) AS n FROM loyalty_ledger WHERE customer_id = ${m}`),
    one(db, sql`SELECT count(*) AS n FROM privacy_requests WHERE customer_id = ${m} AND status IN ('open', 'verifying', 'in_progress')`),
    one(db, sql`SELECT (SELECT count(*) FROM memberships WHERE customer_id = ${m}) + (SELECT count(*) FROM referral_codes WHERE customer_id = ${m}) AS n`),
    consentCarry(db, keepId, mergeId),
  ]);
  const blockers: MergeBlocker[] = [];
  if (keepId === mergeId) blockers.push({ code: "same_account" });
  if (keep.status === "merged" || keep.status === "deleted") blockers.push({ code: "keep_unavailable" });
  if (merge.status === "merged" || merge.status === "deleted") blockers.push({ code: "merge_unavailable" });
  // a block or a fraud flag must not vanish with the account that carries it
  if (merge.status === "blocked" && keep.status !== "blocked") blockers.push({ code: "duplicate_blocked" });
  if (merge.fraudFlag && !keep.fraudFlag) blockers.push({ code: "duplicate_flagged" });
  if (pendingTopups > 0) blockers.push({ code: "pending_topups", count: pendingTopups });
  if (pendingAdjustments > 0) blockers.push({ code: "pending_adjustments", count: pendingAdjustments });
  if (loyalty !== 0) blockers.push({ code: "loyalty_balance", amount: loyalty });
  if (openPrivacy > 0) blockers.push({ code: "open_privacy", count: openPrivacy });
  if (growth > 0) blockers.push({ code: "growth_records", count: growth });
  const moves: MergeMoves = {
    orders: ordersN,
    addresses: addressesN,
    wishlist: wishMove,
    savedDevices: devicesMove,
    recentlyViewed: recentMove,
    notifications: noticesN,
    guestContacts: guestsN,
    returns: returnsN,
    warranties: warrantiesN,
    repairs: repairsN,
    tickets: ticketsN,
    tradeIns: tradesN,
    couponRedemptions: couponsN,
    reviews: reviewsMove,
    sessions: sessionsN,
  };
  const stays: MergeStays = { walletEntries, topups: topupsN, consents: consentsN, duplicateFavourites: wishDup, duplicateReviews: reviewsDup };
  const fingerprint = (await sha256Hex(JSON.stringify({ keepId, mergeId, keep: keep.status, merge: merge.status, moves, stays, blockers, carry }))).slice(0, 24);
  return {
    keep,
    merge,
    moves,
    stays,
    consentCarry: carry,
    blockers,
    fingerprint,
    walletHref: merge.walletIqd !== 0 || pendingTopups > 0 || pendingAdjustments > 0 ? (can(actor, "finance.wallet.read") ? `/admin/finance/wallets/${encodeURIComponent(mergeId)}` : null) : null,
  };
}

export const MergeInput = MergeRefInput.extend({
  method: z.enum(MERGE_VERIFY_METHODS, { error: "required" }),
  verification: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(10, "too_short").max(500, "too_long"),
  reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "required").max(500, "too_long"),
  fingerprint: z.string().regex(/^[0-9a-f]{24}$/, "invalid"),
});
export type MergeInput = z.input<typeof MergeInput>;

// WALLET_DEMO_MISMATCH: the commerce core's walletTransferStatements never moves a demo account's money into a real one (review 2026-11-12)
const MERGE_GUARDS: Record<string, string> = { MERGE_BLOCKED: "merge_blocked", MERGE_CHANGED: "merge_plan_changed", WALLET_DEMO_MISMATCH: "merge_blocked" };

/** Folds the duplicate into the kept account in ONE batch (see the header). Idempotent: a repeat says `replayed`. */
export async function mergeCustomers(db: Db, actor: Actor, raw: MergeInput, now: number): Promise<{ replayed: boolean; moved: MergeMoves | null }> {
  assertCan(actor, "customers.customer.merge");
  const input = MergeInput.parse(raw);
  const { keepId, mergeId } = input;
  if (keepId === mergeId) throw new AppError("merge_same_account", 409);
  const current = await customerById(db, mergeId);
  if (current.status === "merged" && current.mergedIntoId === keepId) return { replayed: true, moved: null };
  const plan = await buildPlan(db, actor, keepId, mergeId);
  if (plan.blockers.length > 0) throw new AppError("merge_blocked", 409, { detail: plan.blockers.map((blocker) => blocker.code).join(",") });
  if (plan.fingerprint !== input.fingerprint) throw new AppError("merge_plan_changed", 409);

  const orderRows = await db.select({ id: orders.id, ref: orders.ref }).from(orders).where(eq(orders.customerId, mergeId));
  const keepHasDefault = (await one(db, sql`SELECT count(*) AS n FROM addresses WHERE customer_id = ${keepId} AND is_default = 1`)) > 0;
  const { actorKind, actorId } = actorRef(actor);
  const statements: BatchStatement[] = [
    // the plan's refusals, again inside the batch
    expectThat(db, sql`(SELECT status FROM customers WHERE id = ${keepId}) IN ('active', 'blocked')`, { code: "MERGE_BLOCKED", detail: "keep_unavailable" }),
    expectThat(db, sql`NOT ((SELECT status FROM customers WHERE id = ${mergeId}) = 'blocked' AND (SELECT status FROM customers WHERE id = ${keepId}) <> 'blocked')`, { code: "MERGE_BLOCKED", detail: "duplicate_blocked" }),
    expectThat(db, sql`NOT ((SELECT fraud_flag FROM customers WHERE id = ${mergeId}) = 1 AND (SELECT fraud_flag FROM customers WHERE id = ${keepId}) = 0)`, { code: "MERGE_BLOCKED", detail: "duplicate_flagged" }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM memberships WHERE customer_id = ${mergeId}) AND NOT EXISTS (SELECT 1 FROM referral_codes WHERE customer_id = ${mergeId})`, { code: "MERGE_BLOCKED", detail: "growth_records" }),
    // the duplicate's wallet money moves to the kept account (commerce core), the duplicate left at exactly 0
    ...walletTransferStatements(db, { transferId: `merge:${mergeId}`, fromCustomerId: mergeId, toCustomerId: keepId, amountIqd: plan.merge.walletIqd, reason: input.reason, actor, now, drain: { code: "MERGE_CHANGED" } }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM wallet_topups WHERE customer_id = ${mergeId} AND status = 'pending_verification')`, { code: "MERGE_BLOCKED", detail: "pending_topups" }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM approvals WHERE kind IN ('wallet_adjustment', 'wallet_payout') AND entity_id = ${mergeId} AND status = 'pending')`, { code: "MERGE_BLOCKED", detail: "pending_adjustments" }),
    expectThat(db, sql`(SELECT coalesce(sum(points), 0) FROM loyalty_ledger WHERE customer_id = ${mergeId}) = 0`, { code: "MERGE_BLOCKED", detail: "loyalty_balance" }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM privacy_requests WHERE customer_id = ${mergeId} AND status IN ('open', 'verifying', 'in_progress'))`, { code: "MERGE_BLOCKED", detail: "open_privacy" }),
    db
      .update(customers)
      .set({ status: "merged", mergedIntoId: keepId, updatedAt: now })
      .where(and(eq(customers.id, mergeId), inArray(customers.status, ["active", "blocked"]))),
    expectChanged(db, 1, { code: "MERGE_CHANGED", detail: mergeId }),
  ];
  // orders: exactly the ones read (the audit names them), then none may be left behind
  for (let i = 0; i < orderRows.length; i += 90) {
    statements.push(
      db
        .update(orders)
        .set({ customerId: keepId, updatedAt: now })
        .where(
          and(
            eq(orders.customerId, mergeId),
            inArray(
              orders.id,
              orderRows.slice(i, i + 90).map((order) => order.id),
            ),
          ),
        ),
    );
  }
  statements.push(expectThat(db, sql`NOT EXISTS (SELECT 1 FROM orders WHERE customer_id = ${mergeId})`, { code: "MERGE_CHANGED", detail: "orders" }));
  const events = orderRows.map((order) => ({ id: newId("oev"), orderId: order.id, kind: "customer_merged", data: { from: mergeId, to: keepId }, actorKind, actorId, at: now }));
  for (const chunk of chunkRows(orderEvents, events)) statements.push(db.insert(orderEvents).values(chunk));
  const move = (table: string, column = "customer_id") => sql.raw(`UPDATE ${table} SET ${column} = `);
  statements.push(
    ...(keepHasDefault ? [batchSql(db, sql`UPDATE addresses SET is_default = 0 WHERE customer_id = ${mergeId}`)] : []),
    batchSql(db, sql`${move("addresses")}${keepId}, updated_at = ${now} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`DELETE FROM wishlist_items WHERE customer_id = ${mergeId} AND product_id IN (SELECT product_id FROM wishlist_items WHERE customer_id = ${keepId})`),
    batchSql(db, sql`${move("wishlist_items")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`DELETE FROM saved_devices WHERE customer_id = ${mergeId} AND device_model_id IN (SELECT device_model_id FROM saved_devices WHERE customer_id = ${keepId})`),
    batchSql(db, sql`${move("saved_devices")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`DELETE FROM recently_viewed WHERE customer_id = ${mergeId} AND product_id IN (SELECT product_id FROM recently_viewed WHERE customer_id = ${keepId})`),
    batchSql(db, sql`${move("recently_viewed")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("notifications")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("guest_contacts")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("returns")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("warranties")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("repair_tickets")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("support_tickets")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("trade_ins")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("coupon_redemptions")}${keepId} WHERE customer_id = ${mergeId}`),
    batchSql(db, sql`${move("reviews")}${keepId} WHERE customer_id = ${mergeId} AND product_id NOT IN (SELECT product_id FROM reviews WHERE customer_id = ${keepId})`),
    batchSql(db, sql`UPDATE customer_sessions SET revoked_at = ${now} WHERE customer_id = ${mergeId} AND revoked_at IS NULL`),
    batchSql(db, sql`DELETE FROM customer_segment_members WHERE customer_id = ${mergeId}`),
    ...plan.consentCarry.map((kind) => consentStatement(db, { subjectType: "customer", subjectId: keepId, kind, granted: false, source: "merge", ip: null, now })),
  );
  const audit = {
    keepId,
    mergeId,
    method: input.method,
    verification: input.verification,
    orders: orderRows.map((order) => order.ref),
    moves: plan.moves,
    stays: plan.stays,
    consentCarry: plan.consentCarry,
  };
  statements.push(
    auditStatement(db, { actor, action: "customers.customer.merge_in", entityType: "customer", entityId: keepId, before: { keep: plan.keep, merge: plan.merge }, after: audit, reason: input.reason, at: now }),
    auditStatement(db, { actor, action: "customers.customer.merge_out", entityType: "customer", entityId: mergeId, before: { status: current.status }, after: { ...audit, status: "merged", mergedIntoId: keepId }, reason: input.reason, at: now }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    const code = mapDbError(error)?.code;
    if (code === "MERGE_CHANGED") {
      const after = await customerById(db, mergeId);
      if (after.status === "merged" && after.mergedIntoId === keepId) return { replayed: true, moved: null };
    }
    if (code && MERGE_GUARDS[code]) throw new AppError(MERGE_GUARDS[code], 409, { detail: mapDbError(error)?.detail });
    throw error;
  }
  return { replayed: false, moved: plan.moves };
}

// ───────────────────────────────────────────────────────────────── finding duplicates

export type DuplicateCandidate = { customer: MergeSide; reasons: DuplicateReason[] };

/** Other active accounts that look like the same person as this one, each with the reasons. */
export async function duplicateCandidates(db: Db, actor: Actor, customerId: string): Promise<DuplicateCandidate[]> {
  assertCan(actor, "customers.customer.merge");
  const row = await customerById(db, customerId);
  const phone = row.phoneE164.startsWith("+964") ? row.phoneE164 : null;
  const reasons = new Map<string, Set<DuplicateReason>>();
  const add = (ids: { id: string }[], reason: DuplicateReason) => {
    for (const { id } of ids) {
      if (id === row.id) continue;
      const set = reasons.get(id) ?? new Set<DuplicateReason>();
      set.add(reason);
      reasons.set(id, set);
    }
  };
  const active = sql`c.status IN ('active', 'blocked') AND c.id <> ${row.id}`;
  const queries: Promise<void>[] = [];
  if (row.email) queries.push(db.all<{ id: string }>(sql`SELECT c.id FROM customers AS c WHERE ${active} AND lower(c.email) = ${row.email.toLowerCase()} LIMIT 20`).then((ids) => add(ids, "same_email")));
  if (phone) {
    // this account's number on another account's orders or addresses, and the other way round
    queries.push(
      db
        .all<{ id: string }>(sql`SELECT DISTINCT c.id FROM customers AS c JOIN orders AS o ON o.customer_id = c.id WHERE ${active} AND o.contact_phone_e164 = ${phone} LIMIT 20`)
        .then((ids) => add(ids, "phone_on_orders")),
      db
        .all<{ id: string }>(sql`SELECT DISTINCT c.id FROM customers AS c JOIN orders AS o ON o.contact_phone_e164 = c.phone_e164 WHERE ${active} AND o.customer_id = ${row.id} LIMIT 20`)
        .then((ids) => add(ids, "phone_on_orders")),
      db.all<{ id: string }>(sql`SELECT DISTINCT c.id FROM customers AS c JOIN addresses AS a ON a.customer_id = c.id WHERE ${active} AND a.phone_e164 = ${phone} LIMIT 20`).then((ids) => add(ids, "phone_on_addresses")),
      db
        .all<{ id: string }>(sql`SELECT DISTINCT c.id FROM customers AS c JOIN addresses AS a ON a.phone_e164 = c.phone_e164 WHERE ${active} AND a.customer_id = ${row.id} LIMIT 20`)
        .then((ids) => add(ids, "phone_on_addresses")),
    );
  }
  if (row.name && row.name.trim().length >= 3) {
    queries.push(
      db
        .all<{ id: string }>(sql`
          SELECT DISTINCT c.id FROM customers AS c JOIN addresses AS a ON a.customer_id = c.id
          WHERE ${active} AND lower(trim(c.name)) = ${row.name.trim().toLowerCase()}
            AND a.governorate_id IN (SELECT governorate_id FROM addresses WHERE customer_id = ${row.id})
            AND lower(trim(coalesce(a.area_text, ''))) IN (SELECT lower(trim(coalesce(area_text, ''))) FROM addresses WHERE customer_id = ${row.id} AND area_text IS NOT NULL)
          LIMIT 20`)
        .then((ids) => add(ids, "same_name_area")),
    );
  }
  await Promise.all(queries);
  const ids = [...reasons.keys()].slice(0, 20);
  const sides = (await Promise.all(ids.map((id) => side(db, actor, id)))).map((full) => sideFor(actor, full));
  return sides.map((customer) => ({ customer, reasons: [...(reasons.get(customer.id) ?? [])] })).sort((a, b) => b.reasons.length - a.reasons.length);
}

export type DuplicatePair = { a: { id: string; name: string | null; phone: PhoneView | null; isDemo: boolean }; b: { id: string; name: string | null; phone: PhoneView | null; isDemo: boolean }; reason: DuplicateReason };

/** Pairs of active accounts that share an e-mail, or whose number appears on the other's orders or addresses. */
export async function storeDuplicates(db: Db, actor: Actor, limit = 50): Promise<DuplicatePair[]> {
  assertCan(actor, "customers.customer.merge");
  const rows = await db.all<{ a: string; b: string; reason: DuplicateReason }>(sql`
    SELECT a, b, reason FROM (
      SELECT c1.id AS a, c2.id AS b, 'same_email' AS reason FROM customers AS c1 JOIN customers AS c2
        ON lower(c1.email) = lower(c2.email) AND c1.id < c2.id
        WHERE c1.email IS NOT NULL AND c1.status IN ('active', 'blocked') AND c2.status IN ('active', 'blocked')
      UNION
      SELECT DISTINCT o.customer_id AS a, c2.id AS b, 'phone_on_orders' AS reason FROM orders AS o JOIN customers AS c2
        ON c2.phone_e164 = o.contact_phone_e164 AND c2.id <> o.customer_id
        JOIN customers AS c1 ON c1.id = o.customer_id
        WHERE c1.status IN ('active', 'blocked') AND c2.status IN ('active', 'blocked')
      UNION
      SELECT DISTINCT ad.customer_id AS a, c2.id AS b, 'phone_on_addresses' AS reason FROM addresses AS ad JOIN customers AS c2
        ON c2.phone_e164 = ad.phone_e164 AND c2.id <> ad.customer_id
        JOIN customers AS c1 ON c1.id = ad.customer_id
        WHERE c1.status IN ('active', 'blocked') AND c2.status IN ('active', 'blocked')
    ) LIMIT ${limit}`);
  const ids = [...new Set(rows.flatMap((row) => [row.a, row.b]))];
  const people = new Map<string, { id: string; name: string | null; phone: string; isDemo: boolean }>();
  for (let i = 0; i < ids.length; i += 90) {
    for (const person of await db.select({ id: customers.id, name: customers.name, phone: customers.phoneE164, isDemo: customers.isDemo }).from(customers).where(inArray(customers.id, ids.slice(i, i + 90)))) people.set(person.id, person);
  }
  const fullPhone = can(actor, "customer.phone.read_full");
  const label = (id: string) => {
    const person = people.get(id);
    return { id, name: person?.name ?? null, phone: phoneView(person?.phone, fullPhone), isDemo: person?.isDemo ?? false };
  };
  const seen = new Set<string>();
  const out: DuplicatePair[] = [];
  for (const row of rows) {
    const key = [row.a, row.b].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: label(row.a), b: label(row.b), reason: row.reason });
  }
  return out;
}

export type MergeRecord = { mergedId: string; mergedName: string | null; mergedPhone: PhoneView | null; keepId: string; keepName: string | null; at: number; by: string | null; reason: string | null; orders: number };

/** The latest merges, from the audit trail (who, when, why, how many orders moved). */
export async function recentMerges(db: Db, actor: Actor, limit = 20): Promise<MergeRecord[]> {
  assertCan(actor, "customers.customer.merge");
  const events = await db
    .select({ entityId: auditEvents.entityId, after: auditEvents.after, at: auditEvents.at, actorId: auditEvents.actorId, actorLabel: auditEvents.actorLabel, reason: auditEvents.reason })
    .from(auditEvents)
    .where(eq(auditEvents.action, "customers.customer.merge_out"))
    .orderBy(desc(auditEvents.seq))
    .limit(limit);
  const ids = new Set<string>();
  for (const event of events) {
    const after = (event.after ?? {}) as { keepId?: string };
    if (event.entityId) ids.add(event.entityId);
    if (after.keepId) ids.add(after.keepId);
  }
  const people = new Map<string, { name: string | null; phone: string }>();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 90) {
    for (const person of await db.select({ id: customers.id, name: customers.name, phone: customers.phoneE164 }).from(customers).where(inArray(customers.id, list.slice(i, i + 90)))) people.set(person.id, person);
  }
  const names = await employeeNames(
    db,
    events.map((event) => event.actorId),
  );
  const fullPhone = can(actor, "customer.phone.read_full");
  return events.map((event) => {
    const after = (event.after ?? {}) as { keepId?: string; orders?: unknown[] };
    const merged = event.entityId ?? "";
    const keepId = after.keepId ?? "";
    return {
      mergedId: merged,
      mergedName: people.get(merged)?.name ?? null,
      mergedPhone: phoneView(people.get(merged)?.phone, fullPhone),
      keepId,
      keepName: people.get(keepId)?.name ?? null,
      at: event.at,
      by: (event.actorId && names.get(event.actorId)) || event.actorLabel || null,
      reason: event.reason,
      orders: Array.isArray(after.orders) ? after.orders.length : 0,
    };
  });
}
