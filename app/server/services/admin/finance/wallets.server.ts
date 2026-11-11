/**
 * Admin 10.07 — the customer wallet, read from its ledger (nobody edits a balance: there is none), and the two ways
 * staff put money into it, both through the wallet service's `creditWallet` (wallet.server.ts):
 *
 *   · TOP-UP REQUESTS recorded by the storefront (account/topups.server.ts): a person checks the private proof
 *     (payment_proof.read) and the amount that really arrived, then approves (creditWallet kind "topup", refType
 *     "wallet_topup", key "topup:<id>") or rejects with a reason the customer reads. Above
 *     TOPUP_SECOND_APPROVAL_ABOVE_IQD two people decide: the first approval is an `approvals` row (kind
 *     "wallet_topup"); a different person confirms it (or sends it back, or rejects the request).
 *   · ADJUSTMENTS (goodwill credit): always two people — one requests (approvals row kind "wallet_adjustment" with
 *     the reason), another approves (creditWallet kind "adjustment", key "adjustment:<approval id>").
 *
 * Order of writes (no interactive transactions on D1): the decision is recorded first in a guarded batch (one winner
 * between two staff and the customer's own "cancel"), then the idempotent credit, then the ledger id is linked.
 * Should the credit fail after the decision, the request shows "approved, not credited yet" and the same action
 * finishes it (same idempotency key: never twice); the anomaly checks list any such request (10.10).
 *
 * Permissions: finance.wallet.read to see anything here; customers.wallet.adjust (creditWallet's) to decide;
 * payment_proof.read for the proof image; customer.phone.read_full for full numbers.
 */
import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex, newId } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, customers, files, walletLedger, walletTopups, type WalletTopup } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { familyIds, chartOfAccounts, accountSums } from "~/server/services/accounting/reports.server";
import { creditWallet } from "~/server/services/wallet.server";
import { customerLabels, employeeNames, type CustomerLabel } from "./shared.server";
import { normalizeReference } from "./statement-csv";
import { PAGE_SIZE, type RangeFilter } from "./types";

export const WALLET_ADMIN_ERROR_KEYS = [
  "topup_not_pending",
  "topup_second_person",
  "topup_amount_changed",
  "topup_amount_note_required",
  "topup_reject_reason_required",
  "topup_nothing_to_return",
  "adjustment_self_approval",
  "adjustment_not_pending",
  "customer_unavailable",
  "wallet_insufficient",
  "idempotency_mismatch",
] as const;

/**
 * Above this amount a top-up needs two people — the DEFAULT of the setting "finance.topup_second_approval_iqd" (admin
 * 22), which this file reads (getSetting) wherever the limit applies. What one person approves alone
 * for one customer counts together over TOPUP_SOLO_WINDOW_MS, so the limit cannot be split into small top-ups.
 */
export const TOPUP_SECOND_APPROVAL_ABOVE_IQD = 500_000;
export const TOPUP_SOLO_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The most one top-up or adjustment may credit here (the storefront caps requests at 10,000,000). */
export const MAX_WALLET_CREDIT_IQD = 10_000_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const num = (value: unknown) => Number(value ?? 0);
const DECIDE: Parameters<typeof assertCan>[1] = "customers.wallet.adjust";

function requireRead(actor: Actor): void {
  assertCan(actor, "finance.wallet.read");
}
function requireDecide(actor: Actor): void {
  requireRead(actor);
  assertCan(actor, DECIDE);
}
const me = (actor: Actor) => (actor.kind === "employee" ? actor.id : actor.kind === "system" ? `system:${actor.job}` : "unknown");

/** SQL: Σ of `customerId`'s top-ups that `employeeId` approved ALONE (no confirmed first approval) after `since`. */
const soloApprovedSql = (customerId: string, employeeId: string, since: number) => sql`
  SELECT coalesce(sum(t.amount_iqd), 0) FROM wallet_topups AS t
  WHERE t.customer_id = ${customerId} AND t.status = 'approved' AND t.verified_by = ${employeeId} AND t.verified_at > ${since}
    AND NOT EXISTS (SELECT 1 FROM approvals AS a WHERE a.kind = 'wallet_topup' AND a.entity_id = t.id AND a.status = 'approved')`;

/** What `employeeId` approved alone for `customerId` in the 24 hours before `now` (it counts against the limit). */
async function soloApprovedIqd(db: Db, customerId: string, employeeId: string, now: number): Promise<number> {
  const rows = await db.all<{ total: number }>(sql`SELECT (${soloApprovedSql(customerId, employeeId, now - TOPUP_SOLO_WINDOW_MS)}) AS total`);
  return num(rows[0]?.total);
}

// ───────────────────────────────────────────────────────────────── overview and ledger

export type WalletOverview = {
  /** Σ wallet_ledger (every row, demo included: this is what the account must equal). */
  ledgerIqd: number;
  /** Credit balance of the wallet liability account family (every posting). */
  journalIqd: number;
  differenceIqd: number;
  customersWithBalance: number;
  byKind: { kind: string; count: number; iqd: number }[];
  pendingTopups: { count: number; iqd: number };
  pendingAdjustments: { count: number; iqd: number };
};

/** The wallet as a whole: the ledger against the journal (they must agree to the dinar), movements of the range. */
export async function walletOverview(db: Db, actor: Actor, range: RangeFilter): Promise<WalletOverview> {
  requireRead(actor);
  const chart = await chartOfAccounts(db);
  const ids = familyIds(chart, "wallet_liability");
  const [ledger, sums, holders, kinds, topups, adjustments] = await Promise.all([
    db.all<{ total: number }>(sql`SELECT coalesce(sum(amount_iqd), 0) AS total FROM wallet_ledger`),
    accountSums(db, { includeDemo: true }),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM (SELECT customer_id FROM wallet_ledger GROUP BY customer_id HAVING sum(amount_iqd) > 0)`),
    db.all<{ kind: string; n: number; total: number }>(sql`
      SELECT w.kind AS kind, count(*) AS n, coalesce(sum(w.amount_iqd), 0) AS total FROM wallet_ledger AS w JOIN customers AS c ON c.id = w.customer_id
      WHERE w.at >= ${range.fromMs} AND w.at < ${range.toMs} AND ${range.demo ? sql`1 = 1` : sql`c.is_demo = 0`} GROUP BY w.kind ORDER BY w.kind`),
    db.all<{ n: number; total: number }>(sql`SELECT count(*) AS n, coalesce(sum(amount_iqd), 0) AS total FROM wallet_topups WHERE status = 'pending_verification'`),
    db.all<{ n: number; total: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(CAST(json_extract(payload, '$.amountIqd') AS INTEGER)), 0) AS total FROM approvals WHERE kind = 'wallet_adjustment' AND status = 'pending'`),
  ]);
  let journal = 0;
  for (const id of ids) {
    const s = sums.get(id);
    if (s) journal += s.credit - s.debit;
  }
  const ledgerIqd = num(ledger[0]?.total);
  return {
    ledgerIqd,
    journalIqd: journal,
    differenceIqd: ledgerIqd - journal,
    customersWithBalance: num(holders[0]?.n),
    byKind: kinds.map((row) => ({ kind: row.kind, count: num(row.n), iqd: num(row.total) })),
    pendingTopups: { count: num(topups[0]?.n), iqd: num(topups[0]?.total) },
    pendingAdjustments: { count: num(adjustments[0]?.n), iqd: num(adjustments[0]?.total) },
  };
}

export type WalletEntryRow = {
  id: string;
  at: number;
  customer: CustomerLabel | null;
  customerId: string;
  kind: string;
  amountIqd: number;
  refType: string | null;
  /** An order reference, a top-up reference, or null. */
  refLabel: string | null;
  refHref: string | null;
  reason: string | null;
  by: { kind: string; name: string | null };
};

export type WalletLedgerFilters = RangeFilter & { kind: string | null; customer: string | null; page: number };

async function decorateEntries(db: Db, actor: Actor, rows: { id: string; at: number; customerId: string; kind: string; amount: number; refType: string | null; refId: string | null; reason: string | null; actorKind: string; actorId: string | null }[]): Promise<WalletEntryRow[]> {
  const orderIds = rows.filter((row) => row.refType === "order" && row.refId).map((row) => row.refId as string);
  const refundIds = rows.filter((row) => row.refType === "refund" && row.refId).map((row) => row.refId as string);
  const topupIds = rows.filter((row) => row.refType === "wallet_topup" && row.refId).map((row) => row.refId as string);
  const list = (ids: string[]) =>
    sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
  const [refundOrders, topups] = await Promise.all([
    refundIds.length ? db.all<{ id: string; orderId: string }>(sql`SELECT id, order_id AS orderId FROM refunds WHERE id IN (${list(refundIds)})`) : [],
    topupIds.length ? db.all<{ id: string; ref: string }>(sql`SELECT id, ref FROM wallet_topups WHERE id IN (${list(topupIds)})`) : [],
  ]);
  const allOrders = [...new Set([...orderIds, ...refundOrders.map((row) => row.orderId)])];
  const orderRefs = allOrders.length ? await db.all<{ id: string; ref: string }>(sql`SELECT id, ref FROM orders WHERE id IN (${list(allOrders)})`) : [];
  const refOfOrder = new Map(orderRefs.map((row) => [row.id, row.ref]));
  const orderOfRefund = new Map(refundOrders.map((row) => [row.id, row.orderId]));
  const refOfTopup = new Map(topups.map((row) => [row.id, row.ref]));
  const [labels, names] = await Promise.all([customerLabels(db, rows.map((row) => row.customerId), can(actor, "customer.phone.read_full")), employeeNames(db, rows.filter((row) => row.actorKind === "employee").map((row) => row.actorId))]);
  return rows.map((row) => {
    let refLabel: string | null = null;
    let refHref: string | null = null;
    if (row.refType === "order" && row.refId) refLabel = refOfOrder.get(row.refId) ?? null;
    if (row.refType === "refund" && row.refId) refLabel = refOfOrder.get(orderOfRefund.get(row.refId) ?? "") ?? null;
    if (refLabel) refHref = `/admin/orders/${refLabel}`;
    if (row.refType === "wallet_topup" && row.refId) {
      refLabel = refOfTopup.get(row.refId) ?? null;
      refHref = `/admin/finance/wallets/topups/${row.refId}`;
    }
    return {
      id: row.id,
      at: num(row.at),
      customer: labels.get(row.customerId) ?? null,
      customerId: row.customerId,
      kind: row.kind,
      amountIqd: num(row.amount),
      refType: row.refType,
      refLabel,
      refHref,
      reason: row.reason,
      by: { kind: row.actorKind, name: row.actorKind === "employee" && row.actorId ? (names.get(row.actorId) ?? null) : null },
    };
  });
}

const ENTRY_COLUMNS = sql`w.id AS id, w.at AS at, w.customer_id AS customerId, w.kind AS kind, w.amount_iqd AS amount, w.ref_type AS refType, w.ref_id AS refId, w.reason AS reason, w.actor_kind AS actorKind, w.actor_id AS actorId`;

/** Every customer's wallet movements in the range, newest first (finance.wallet.read). */
export async function listWalletLedger(db: Db, actor: Actor, filters: WalletLedgerFilters): Promise<{ rows: WalletEntryRow[]; total: number; page: number; pageCount: number; demoHidden: number; inIqd: number; outIqd: number }> {
  requireRead(actor);
  const parts: SQL[] = [sql`w.at >= ${filters.fromMs}`, sql`w.at < ${filters.toMs}`];
  if (filters.kind) parts.push(sql`w.kind = ${filters.kind}`);
  if (filters.customer) parts.push(sql`w.customer_id = ${filters.customer}`);
  const base = sql.join(parts, sql` AND `);
  const where = filters.demo ? base : sql`${base} AND c.is_demo = 0`;
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, count, hidden] = await Promise.all([
    db.all<Parameters<typeof decorateEntries>[2][number]>(sql`SELECT ${ENTRY_COLUMNS} FROM wallet_ledger AS w JOIN customers AS c ON c.id = w.customer_id WHERE ${where} ORDER BY w.at DESC, w.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    db.all<{ n: number; inIqd: number; outIqd: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(CASE WHEN w.amount_iqd > 0 THEN w.amount_iqd ELSE 0 END), 0) AS inIqd, coalesce(sum(CASE WHEN w.amount_iqd < 0 THEN -w.amount_iqd ELSE 0 END), 0) AS outIqd
      FROM wallet_ledger AS w JOIN customers AS c ON c.id = w.customer_id WHERE ${where}`),
    filters.demo ? Promise.resolve([{ n: 0 }]) : db.all<{ n: number }>(sql`SELECT count(*) AS n FROM wallet_ledger AS w JOIN customers AS c ON c.id = w.customer_id WHERE ${base} AND c.is_demo = 1`),
  ]);
  const total = num(count[0]?.n);
  return { rows: await decorateEntries(db, actor, rows), total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), demoHidden: num(hidden[0]?.n), inIqd: num(count[0]?.inIqd), outIqd: num(count[0]?.outIqd) };
}

export type CustomerWallet = {
  customer: CustomerLabel;
  balanceIqd: number;
  entries: WalletEntryRow[];
  total: number;
  page: number;
  pageCount: number;
  topups: TopupRow[];
  adjustments: AdjustmentRow[];
  canDecide: boolean;
};

/** One customer's wallet: balance (Σ ledger), movements, top-up requests and adjustment requests. */
export async function customerWallet(db: Db, actor: Actor, customerId: string, page: number): Promise<CustomerWallet> {
  requireRead(actor);
  if (!ID.test(customerId)) throw notFound("customer");
  const labels = await customerLabels(db, [customerId], can(actor, "customer.phone.read_full"));
  const customer = labels.get(customerId);
  if (!customer) throw notFound("customer");
  const offset = (page - 1) * PAGE_SIZE;
  const [balance, rows, count, topups, adjustments] = await Promise.all([
    db.all<{ total: number }>(sql`SELECT coalesce(sum(amount_iqd), 0) AS total FROM wallet_ledger WHERE customer_id = ${customerId}`),
    db.all<Parameters<typeof decorateEntries>[2][number]>(sql`SELECT ${ENTRY_COLUMNS} FROM wallet_ledger AS w WHERE w.customer_id = ${customerId} ORDER BY w.at DESC, w.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM wallet_ledger WHERE customer_id = ${customerId}`),
    listTopupsWhere(db, actor, eq(walletTopups.customerId, customerId), 20),
    listAdjustmentsWhere(db, actor, and(eq(approvals.kind, "wallet_adjustment"), eq(approvals.entityId, customerId)), 20),
  ]);
  const total = num(count[0]?.n);
  return {
    customer,
    balanceIqd: num(balance[0]?.total),
    entries: await decorateEntries(db, actor, rows),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    topups,
    adjustments,
    canDecide: can(actor, DECIDE),
  };
}

// ───────────────────────────────────────────────────────────────── top-ups

export type FirstApproval = { approvalId: string; by: string | null; byMe: boolean; amountIqd: number; note: string | null; at: number };

export type TopupRow = {
  id: string;
  ref: string;
  customerId: string;
  customer: CustomerLabel | null;
  method: string;
  declaredAmountIqd: number | null;
  amountIqd: number;
  reference: string | null;
  status: WalletTopup["status"];
  createdAt: number;
  verifiedAt: number | null;
  verifiedBy: string | null;
  rejectReason: string | null;
  /** Approved but the wallet not credited yet (the credit failed after the decision): "finish crediting". */
  notCredited: boolean;
  needsTwo: boolean;
  firstApproval: FirstApproval | null;
  flags: { sameProof: number; sameReference: number };
};

async function listTopupsWhere(db: Db, actor: Actor, where: SQL | undefined, limit: number, offset = 0): Promise<TopupRow[]> {
  const rows = await db.select().from(walletTopups).where(where).orderBy(sql`CASE ${walletTopups.status} WHEN 'pending_verification' THEN 0 ELSE 1 END`, desc(walletTopups.createdAt), desc(walletTopups.id)).limit(limit).offset(offset);
  return decorateTopups(db, actor, rows);
}

async function decorateTopups(db: Db, actor: Actor, rows: WalletTopup[]): Promise<TopupRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const pending = await db
    .select({ id: approvals.id, entityId: approvals.entityId, requestedBy: approvals.requestedBy, payload: approvals.payload, reason: approvals.reason, createdAt: approvals.createdAt })
    .from(approvals)
    .where(and(eq(approvals.kind, "wallet_topup"), eq(approvals.status, "pending"), inArray(approvals.entityId, ids)));
  const hashes = rows.map((row) => row.sha256).filter((h): h is string => Boolean(h));
  const references = rows.map((row) => normalizeReference(row.reference)).filter(Boolean);
  const [sameProof, sameRef] = await Promise.all([
    hashes.length
      ? db.all<{ sha: string; n: number }>(sql`
          SELECT sha, count(*) AS n FROM (
            SELECT sha256 AS sha FROM wallet_topups WHERE sha256 IN (${sql.join(
              hashes.map((h) => sql`${h}`),
              sql`, `,
            )})
            UNION ALL SELECT sha256 FROM payment_proofs WHERE sha256 IN (${sql.join(
              hashes.map((h) => sql`${h}`),
              sql`, `,
            )})
          ) GROUP BY sha`)
      : [],
    references.length
      ? db.all<{ r: string; n: number }>(sql`
          SELECT r, count(*) AS n FROM (
            SELECT upper(replace(replace(reference, '-', ''), ' ', '')) AS r FROM wallet_topups WHERE reference IS NOT NULL
            UNION ALL SELECT upper(replace(replace(reference, '-', ''), ' ', '')) FROM payments WHERE reference IS NOT NULL
          ) WHERE r IN (${sql.join(
            references.map((r) => sql`${r}`),
            sql`, `,
          )}) GROUP BY r`)
      : [],
  ]);
  const proofCount = new Map(sameProof.map((row) => [row.sha, num(row.n)]));
  const refCount = new Map(sameRef.map((row) => [row.r, num(row.n)]));
  const [labels, names] = await Promise.all([
    customerLabels(db, rows.map((row) => row.customerId), can(actor, "customer.phone.read_full")),
    employeeNames(db, [...rows.map((row) => row.verifiedBy), ...pending.map((row) => row.requestedBy)]),
  ]);
  const myId = me(actor);
  const secondAbove = await getSetting(db, "finance.topup_second_approval_iqd");
  return rows.map((row) => {
    const first = pending.find((approval) => approval.entityId === row.id);
    const payload = (first?.payload ?? {}) as { amountIqd?: number; note?: string | null };
    const ref = normalizeReference(row.reference);
    return {
      id: row.id,
      ref: row.ref,
      customerId: row.customerId,
      customer: labels.get(row.customerId) ?? null,
      method: row.method,
      declaredAmountIqd: row.declaredAmountIqd,
      amountIqd: row.amountIqd,
      reference: row.reference,
      status: row.status,
      createdAt: row.createdAt,
      verifiedAt: row.verifiedAt,
      verifiedBy: row.verifiedBy ? (names.get(row.verifiedBy) ?? null) : null,
      rejectReason: row.rejectReason,
      notCredited: row.status === "approved" && !row.walletLedgerId,
      needsTwo: (row.declaredAmountIqd ?? row.amountIqd) > secondAbove,
      firstApproval: first
        ? { approvalId: first.id, by: names.get(first.requestedBy) ?? null, byMe: first.requestedBy === myId, amountIqd: num(payload.amountIqd), note: payload.note ?? first.reason ?? null, at: first.createdAt }
        : null,
      flags: { sameProof: row.sha256 ? Math.max(0, (proofCount.get(row.sha256) ?? 1) - 1) : 0, sameReference: ref ? Math.max(0, (refCount.get(ref) ?? 1) - 1) : 0 },
    };
  });
}

/** Top-up requests, those awaiting a decision first (finance.wallet.read). */
export async function listTopups(db: Db, actor: Actor, filters: { status: WalletTopup["status"] | null; page: number }): Promise<{ rows: TopupRow[]; total: number; page: number; pageCount: number }> {
  requireRead(actor);
  const where = filters.status ? eq(walletTopups.status, filters.status) : undefined;
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, count] = await Promise.all([listTopupsWhere(db, actor, where, PAGE_SIZE, offset), db.select({ n: sql<number>`count(*)` }).from(walletTopups).where(where).get()]);
  const total = num(count?.n);
  return { rows, total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

export type TopupReview = TopupRow & {
  balanceIqd: number;
  approvedBefore: number;
  proofUrl: string | null;
  hasProof: boolean;
  canDecide: boolean;
  threshold: number;
  /** What this employee approved alone for this customer in the last 24 hours (it counts against the limit). */
  soloApprovedIqd: number;
  /** How much this employee may still approve alone for this customer now; above it, their approval is a first one. */
  soloRoomIqd: number;
};

/** One top-up request for a decision: the proof (payment_proof.read), the amounts, the flags, the two-person state. */
export async function getTopupReview(db: Db, actor: Actor, topupId: string, proofUrl: (topupId: string) => string, now: number = Date.now()): Promise<TopupReview> {
  requireRead(actor);
  if (!ID.test(topupId)) throw notFound("wallet_topup");
  const row = await db.select().from(walletTopups).where(eq(walletTopups.id, topupId)).get();
  if (!row) throw notFound("wallet_topup");
  const [decorated] = await decorateTopups(db, actor, [row]);
  const [balance, before, solo, secondAbove] = await Promise.all([
    db.all<{ total: number }>(sql`SELECT coalesce(sum(amount_iqd), 0) AS total FROM wallet_ledger WHERE customer_id = ${row.customerId}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM wallet_topups WHERE customer_id = ${row.customerId} AND status = 'approved' AND id <> ${row.id}`),
    soloApprovedIqd(db, row.customerId, me(actor), now),
    getSetting(db, "finance.topup_second_approval_iqd"),
  ]);
  const hasProof = Boolean(row.proofFileId);
  const soloRoomIqd = Math.max(0, secondAbove - solo);
  return {
    ...decorated,
    needsTwo: (row.declaredAmountIqd ?? row.amountIqd) > soloRoomIqd,
    balanceIqd: num(balance[0]?.total),
    approvedBefore: num(before[0]?.n),
    hasProof,
    proofUrl: hasProof && can(actor, "payment_proof.read") ? proofUrl(row.id) : null,
    canDecide: can(actor, DECIDE),
    threshold: secondAbove,
    soloApprovedIqd: solo,
    soloRoomIqd,
  };
}

/** The private proof file of a top-up, for an employee holding finance.wallet.read and payment_proof.read. */
export async function topupProofFile(db: Db, actor: Actor, topupId: string): Promise<string | null> {
  requireRead(actor);
  assertCan(actor, "payment_proof.read");
  if (!ID.test(topupId)) return null;
  const row = await db.select({ fileId: walletTopups.proofFileId }).from(walletTopups).where(eq(walletTopups.id, topupId)).get();
  if (!row?.fileId) return null;
  const file = await db.select({ kind: files.kind, visibility: files.visibility }).from(files).where(eq(files.id, row.fileId)).get();
  if (!file || file.kind !== "wallet_topup_proof" || file.visibility !== "private") return null;
  return row.fileId;
}

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);

const DecideTopupInput = z.object({
  topupId: z.string().regex(ID, "invalid"),
  decision: z.enum(["approve", "reject", "return"]),
  amountIqd: z.preprocess(blank, z.number().int("invalid").min(1, "too_small").max(MAX_WALLET_CREDIT_IQD, "too_big").optional()),
  note: z.preprocess(blank, z.string().trim().min(3, "required").max(500, "too_long").optional()),
});
export type DecideTopupInput = z.input<typeof DecideTopupInput>;

export type TopupDecision = { status: "approved" | "rejected" | "awaiting_second" | "pending"; replayed: boolean; entryId?: string };

/** Credits the wallet for an approved top-up (idempotent: "topup:<id>") and links the ledger row. */
async function creditApprovedTopup(db: Db, actor: Actor, topup: WalletTopup, note: string | null, now: number): Promise<string> {
  const { entryId } = await creditWallet(
    db,
    actor,
    { customerId: topup.customerId, amountIqd: topup.amountIqd, kind: "topup", refType: "wallet_topup", refId: topup.id, reason: `Top-up ${topup.ref}${note ? ` — ${note}` : ""}`.slice(0, 500), idempotencyKey: `topup:${topup.id}` },
    now,
  );
  await db
    .update(walletTopups)
    .set({ walletLedgerId: entryId })
    .where(and(eq(walletTopups.id, topup.id), sql`${walletTopups.walletLedgerId} IS NULL`))
    .run();
  return entryId;
}

/**
 * Decides a top-up request (customers.wallet.adjust + finance.wallet.read):
 *   approve  — the amount that arrived (default: what the customer declared; a different amount needs a note).
 *              Above the limit, the first approval waits for a second person, who confirms the same amount.
 *   reject   — a reason the customer reads (also clears a waiting first approval).
 *   return   — a second person sends a first approval back (the request stays pending), with a note.
 * An approved request whose credit did not happen is finished by approving it again.
 * Above the limit counts what this person approved ALONE for the same customer in the last 24 hours too (the limit
 * cannot be split into small top-ups); two tabs approving two small top-ups at once meet a guard inside the batch,
 * and the one that loses is decided again — as a first approval.
 */
export async function decideTopup(db: Db, actor: Actor, raw: DecideTopupInput, now: number): Promise<TopupDecision> {
  try {
    return await decideTopupOnce(db, actor, raw, now);
  } catch (error) {
    if (!(error instanceof SoloLimitRace)) throw error;
    try {
      return await decideTopupOnce(db, actor, raw, now);
    } catch (again) {
      if (again instanceof SoloLimitRace) throw new AppError("topup_not_pending", 409);
      throw again;
    }
  }
}

/** Another approval by the same person for the same customer landed first: decide again with it counted. */
class SoloLimitRace extends Error {}

async function decideTopupOnce(db: Db, actor: Actor, raw: DecideTopupInput, now: number): Promise<TopupDecision> {
  requireDecide(actor);
  const input = DecideTopupInput.parse(raw);
  const topup = await db.select().from(walletTopups).where(eq(walletTopups.id, input.topupId)).get();
  if (!topup) throw notFound("wallet_topup");
  const myId = me(actor);

  if (topup.status === "approved") {
    if (input.decision !== "approve") throw new AppError("topup_not_pending", 409);
    if (topup.walletLedgerId) return { status: "approved", replayed: true, entryId: topup.walletLedgerId };
    const entryId = await creditApprovedTopup(db, actor, topup, input.note ?? null, now);
    return { status: "approved", replayed: false, entryId };
  }
  if (topup.status !== "pending_verification") {
    if (input.decision === "reject" && topup.status === "rejected") return { status: "rejected", replayed: true };
    throw new AppError("topup_not_pending", 409);
  }
  const first = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.kind, "wallet_topup"), eq(approvals.entityId, topup.id), eq(approvals.status, "pending")))
    .get();

  if (input.decision === "reject") {
    if (!input.note) throw new AppError("topup_reject_reason_required", 400, { fields: { note: "topup_reject_reason_required" } });
    try {
      await runBatch(db, [
        db
          .update(walletTopups)
          .set({ status: "rejected", rejectReason: input.note, verifiedBy: myId, verifiedAt: now })
          .where(and(eq(walletTopups.id, topup.id), eq(walletTopups.status, "pending_verification"))),
        expectChanged(db, 1, { code: "TOPUP_NOT_PENDING", detail: topup.id }),
        db
          .update(approvals)
          .set({ status: "rejected", decidedBy: myId, decidedAt: now, decisionNote: input.note })
          .where(and(eq(approvals.kind, "wallet_topup"), eq(approvals.entityId, topup.id), eq(approvals.status, "pending"))),
        auditStatement(db, { actor, action: "finance.wallet.topup_reject", entityType: "wallet_topup", entityId: topup.id, before: { status: topup.status }, after: { status: "rejected", ref: topup.ref }, reason: input.note, at: now }),
      ]);
    } catch (error) {
      if (mapDbError(error)?.code === "TOPUP_NOT_PENDING") throw new AppError("topup_not_pending", 409);
      throw error;
    }
    return { status: "rejected", replayed: false };
  }

  if (input.decision === "return") {
    if (!first) throw new AppError("topup_nothing_to_return", 409);
    if (first.requestedBy === myId) throw new AppError("topup_second_person", 403);
    if (!input.note) throw new AppError("invalid", 400, { fields: { note: "required" } });
    await runBatch(db, [
      db.update(approvals).set({ status: "rejected", decidedBy: myId, decidedAt: now, decisionNote: input.note }).where(and(eq(approvals.id, first.id), eq(approvals.status, "pending"))),
      expectChanged(db, 1, { code: "TOPUP_NOT_PENDING", detail: first.id }),
      auditStatement(db, { actor, action: "finance.wallet.topup_return", entityType: "wallet_topup", entityId: topup.id, before: { firstApproval: first.id }, after: { status: "pending_verification" }, reason: input.note, at: now }),
    ]).catch((error) => {
      if (mapDbError(error)?.code === "TOPUP_NOT_PENDING") throw new AppError("topup_not_pending", 409);
      throw error;
    });
    return { status: "pending", replayed: false };
  }

  // approve
  const declared = topup.declaredAmountIqd ?? topup.amountIqd;
  const amount = input.amountIqd ?? (first ? num((first.payload as { amountIqd?: number } | null)?.amountIqd) : declared);
  if (amount !== declared && !input.note && !first) throw new AppError("topup_amount_note_required", 400, { fields: { note: "topup_amount_note_required" } });
  const customer = await db.select({ status: customers.status }).from(customers).where(eq(customers.id, topup.customerId)).get();
  if (!customer || customer.status === "merged" || customer.status === "deleted") throw new AppError("customer_unavailable", 409, { detail: customer?.status });

  // what this person already approved alone for this customer today counts with this amount
  const alone = first ? 0 : await soloApprovedIqd(db, topup.customerId, myId, now);
  const secondAbove = await getSetting(db, "finance.topup_second_approval_iqd");
  const needsTwo = amount + alone > secondAbove;
  if (needsTwo && !first) {
    const approvalId = newId("apv");
    try {
      await runBatch(db, [
        db.insert(approvals).values({
          id: approvalId,
          kind: "wallet_topup",
          entityType: "wallet_topup",
          entityId: topup.id,
          requestedBy: myId,
          payload: { amountIqd: amount, declaredAmountIqd: declared, note: input.note ?? null },
          status: "pending",
          reason: input.note ?? `Top-up ${topup.ref}`,
          requiredPermission: DECIDE,
          createdAt: now,
        }),
        // one first approval at a time, and only while the request is still pending
        expectThat(db, sql`(SELECT count(*) FROM approvals WHERE kind = 'wallet_topup' AND entity_id = ${topup.id} AND status = 'pending') = 1`, { code: "TOPUP_NOT_PENDING", detail: topup.id }),
        expectThat(db, sql`EXISTS (SELECT 1 FROM wallet_topups WHERE id = ${topup.id} AND status = 'pending_verification')`, { code: "TOPUP_NOT_PENDING", detail: topup.id }),
        auditStatement(db, { actor, action: "finance.wallet.topup_first_approval", entityType: "wallet_topup", entityId: topup.id, after: { approvalId, amountIqd: amount, declaredAmountIqd: declared }, reason: input.note ?? null, at: now }),
      ]);
    } catch (error) {
      if (mapDbError(error)?.code === "TOPUP_NOT_PENDING") throw new AppError("topup_not_pending", 409);
      throw error;
    }
    return { status: "awaiting_second", replayed: false };
  }
  if (first) {
    if (first.requestedBy === myId) throw new AppError("topup_second_person", 403);
    const firstAmount = num((first.payload as { amountIqd?: number } | null)?.amountIqd);
    if (amount !== firstAmount) throw new AppError("topup_amount_changed", 409, { detail: String(firstAmount) });
  }

  try {
    await runBatch(db, [
      db
        .update(walletTopups)
        .set({ status: "approved", amountIqd: amount, verifiedBy: myId, verifiedAt: now })
        .where(and(eq(walletTopups.id, topup.id), eq(walletTopups.status, "pending_verification"))),
      expectChanged(db, 1, { code: "TOPUP_NOT_PENDING", detail: topup.id }),
      ...(first
        ? [
            db.update(approvals).set({ status: "approved", decidedBy: myId, decidedAt: now, decisionNote: input.note ?? null }).where(and(eq(approvals.id, first.id), eq(approvals.status, "pending"))),
            expectChanged(db, 1, { code: "TOPUP_NOT_PENDING", detail: first.id }),
          ]
        : // alone: with this one, what this person approved alone for this customer in 24 hours stays within the limit
          [expectThat(db, sql`(${soloApprovedSql(topup.customerId, myId, now - TOPUP_SOLO_WINDOW_MS)}) <= ${secondAbove}`, { code: "TOPUP_SOLO_LIMIT", detail: topup.id })]),
      auditStatement(db, {
        actor,
        action: "finance.wallet.topup_approve",
        entityType: "wallet_topup",
        entityId: topup.id,
        before: { status: topup.status, declaredAmountIqd: declared },
        after: { status: "approved", amountIqd: amount, firstApproval: first?.id ?? null },
        reason: input.note ?? null,
        at: now,
      }),
    ]);
  } catch (error) {
    const code = mapDbError(error)?.code;
    if (code === "TOPUP_NOT_PENDING") throw new AppError("topup_not_pending", 409);
    if (code === "TOPUP_SOLO_LIMIT") throw new SoloLimitRace(topup.id);
    throw error;
  }
  const approved = { ...topup, status: "approved" as const, amountIqd: amount, verifiedBy: myId, verifiedAt: now };
  const entryId = await creditApprovedTopup(db, actor, approved, input.note ?? null, now);
  return { status: "approved", replayed: false, entryId };
}

// ───────────────────────────────────────────────────────────────── adjustments (two people, always)

export type AdjustmentRow = {
  id: string;
  customerId: string;
  customer: CustomerLabel | null;
  amountIqd: number;
  reason: string | null;
  status: string;
  requestedBy: string | null;
  mine: boolean;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
  /** Approved but not credited yet (finish it by approving again). */
  notCredited: boolean;
};

async function listAdjustmentsWhere(db: Db, actor: Actor, where: SQL | undefined, limit: number): Promise<AdjustmentRow[]> {
  const rows = await db
    .select()
    .from(approvals)
    .where(where)
    .orderBy(sql`CASE ${approvals.status} WHEN 'pending' THEN 0 ELSE 1 END`, desc(approvals.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const credited = await db
    .select({ key: walletLedger.idempotencyKey })
    .from(walletLedger)
    .where(
      inArray(
        walletLedger.idempotencyKey,
        rows.map((row) => `adjustment:${row.id}`),
      ),
    );
  const done = new Set(credited.map((row) => row.key));
  const [labels, names] = await Promise.all([
    customerLabels(db, rows.map((row) => row.entityId), can(actor, "customer.phone.read_full")),
    employeeNames(db, [...rows.map((row) => row.requestedBy), ...rows.map((row) => row.decidedBy)]),
  ]);
  const myId = me(actor);
  return rows.map((row) => ({
    id: row.id,
    customerId: row.entityId ?? "",
    customer: row.entityId ? (labels.get(row.entityId) ?? null) : null,
    amountIqd: num((row.payload as { amountIqd?: number } | null)?.amountIqd),
    reason: row.reason,
    status: row.status,
    requestedBy: names.get(row.requestedBy) ?? null,
    mine: row.requestedBy === myId,
    createdAt: row.createdAt,
    decidedBy: row.decidedBy ? (names.get(row.decidedBy) ?? null) : null,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    notCredited: row.status === "approved" && !done.has(`adjustment:${row.id}`),
  }));
}

/** Adjustment requests: waiting ones first, then the latest decided (finance.wallet.read). */
export async function listAdjustments(db: Db, actor: Actor, limit = 30): Promise<AdjustmentRow[]> {
  requireRead(actor);
  return listAdjustmentsWhere(db, actor, eq(approvals.kind, "wallet_adjustment"), limit);
}

const RequestAdjustmentInput = z.object({
  customerId: z.string().regex(ID, "invalid"),
  amountIqd: z.number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") }).int("invalid").min(1, "too_small").max(MAX_WALLET_CREDIT_IQD, "too_big"),
  reason: z.string({ error: "required" }).trim().min(10, "too_short").max(500, "too_long"),
  idempotencyKey: z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid"),
});
export type RequestAdjustmentInput = z.input<typeof RequestAdjustmentInput>;

/**
 * Asks for a goodwill credit to a customer's wallet. Nothing moves until another person approves it. Idempotent on
 * the key (it decides the approval id).
 */
export async function requestWalletAdjustment(db: Db, actor: Actor, raw: RequestAdjustmentInput, now: number): Promise<{ approvalId: string; replayed: boolean }> {
  requireDecide(actor);
  const input = RequestAdjustmentInput.parse(raw);
  const approvalId = `apv_${(await sha256Hex(`wallet_adjustment:${input.idempotencyKey}`)).slice(0, 26)}`;
  const replay = async () => {
    const existing = await db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    if (!existing) return null;
    if (existing.entityId !== input.customerId || num((existing.payload as { amountIqd?: number } | null)?.amountIqd) !== input.amountIqd) throw new AppError("idempotency_mismatch", 409);
    return { approvalId, replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const customer = await db.select({ status: customers.status }).from(customers).where(eq(customers.id, input.customerId)).get();
  if (!customer) throw notFound("customer");
  if (customer.status === "merged" || customer.status === "deleted") throw new AppError("customer_unavailable", 409, { detail: customer.status });
  try {
    await runBatch(db, [
      db.insert(approvals).values({
        id: approvalId,
        kind: "wallet_adjustment",
        entityType: "customer",
        entityId: input.customerId,
        requestedBy: me(actor),
        payload: { amountIqd: input.amountIqd },
        status: "pending",
        reason: input.reason,
        requiredPermission: DECIDE,
        createdAt: now,
      }),
      auditStatement(db, { actor, action: "finance.wallet.adjustment_request", entityType: "customer", entityId: input.customerId, after: { approvalId, amountIqd: input.amountIqd }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    const raced = await replay().catch(() => null);
    if (raced) return raced;
    throw error;
  }
  return { approvalId, replayed: false };
}

const DecideAdjustmentInput = z.object({
  approvalId: z.string().regex(ID, "invalid"),
  decision: z.enum(["approve", "reject"]),
  note: z.preprocess(blank, z.string().trim().min(3, "required").max(500, "too_long").optional()),
});

/**
 * Approves (credits the wallet through creditWallet, kind "adjustment") or rejects an adjustment request. The person
 * who asked never approves it (adjustment_self_approval, 403); they may withdraw it (reject). Approving an approved
 * request whose credit did not happen finishes it (same key: never twice).
 */
export async function decideWalletAdjustment(db: Db, actor: Actor, raw: { approvalId: string; decision: "approve" | "reject"; note?: string }, now: number): Promise<{ status: "approved" | "rejected"; replayed: boolean; entryId?: string }> {
  requireDecide(actor);
  const input = DecideAdjustmentInput.parse(raw);
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, "wallet_adjustment"))).get();
  if (!approval || !approval.entityId) throw notFound("approval");
  const myId = me(actor);
  const amount = num((approval.payload as { amountIqd?: number } | null)?.amountIqd);
  const credit = () =>
    creditWallet(db, actor, { customerId: approval.entityId as string, amountIqd: amount, kind: "adjustment", refType: "approval", refId: approval.id, reason: (approval.reason ?? "Wallet adjustment").slice(0, 500), idempotencyKey: `adjustment:${approval.id}` }, now);

  if (approval.status === "approved") {
    if (input.decision !== "approve") throw new AppError("adjustment_not_pending", 409);
    if (approval.requestedBy === myId) throw new AppError("adjustment_self_approval", 403);
    const { entryId, replayed } = await credit();
    return { status: "approved", replayed, entryId };
  }
  if (approval.status !== "pending") {
    if (input.decision === "reject" && approval.status === "rejected") return { status: "rejected", replayed: true };
    throw new AppError("adjustment_not_pending", 409);
  }

  if (input.decision === "reject") {
    if (!input.note) throw new AppError("invalid", 400, { fields: { note: "required" } });
    await runBatch(db, [
      db.update(approvals).set({ status: "rejected", decidedBy: myId, decidedAt: now, decisionNote: input.note }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
      expectChanged(db, 1, { code: "ADJUSTMENT_NOT_PENDING", detail: approval.id }),
      auditStatement(db, { actor, action: approval.requestedBy === myId ? "finance.wallet.adjustment_withdraw" : "finance.wallet.adjustment_reject", entityType: "customer", entityId: approval.entityId, before: { approvalId: approval.id, status: "pending" }, after: { status: "rejected" }, reason: input.note, at: now }),
    ]).catch((error) => {
      if (mapDbError(error)?.code === "ADJUSTMENT_NOT_PENDING") throw new AppError("adjustment_not_pending", 409);
      throw error;
    });
    return { status: "rejected", replayed: false };
  }

  if (approval.requestedBy === myId) throw new AppError("adjustment_self_approval", 403);
  const customer = await db.select({ status: customers.status }).from(customers).where(eq(customers.id, approval.entityId)).get();
  if (!customer || customer.status === "merged" || customer.status === "deleted") throw new AppError("customer_unavailable", 409);
  await runBatch(db, [
    db.update(approvals).set({ status: "approved", decidedBy: myId, decidedAt: now, decisionNote: input.note ?? null }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"), ne(approvals.requestedBy, myId))),
    expectChanged(db, 1, { code: "ADJUSTMENT_NOT_PENDING", detail: approval.id }),
    auditStatement(db, { actor, action: "finance.wallet.adjustment_approve", entityType: "customer", entityId: approval.entityId, before: { approvalId: approval.id, status: "pending" }, after: { status: "approved", amountIqd: amount }, reason: input.note ?? approval.reason, at: now }),
  ]).catch((error) => {
    if (mapDbError(error)?.code === "ADJUSTMENT_NOT_PENDING") throw new AppError("adjustment_not_pending", 409);
    throw error;
  });
  const { entryId } = await credit();
  return { status: "approved", replayed: false, entryId };
}

/** What waits for this employee here: top-ups to decide (not their own first approval), adjustments by others. */
export async function walletQueue(db: Db, actor: Actor): Promise<{ topups: number; adjustments: number } | null> {
  if (!can(actor, "finance.wallet.read") || !can(actor, DECIDE)) return null;
  const myId = me(actor);
  const [topups, adjustments] = await Promise.all([
    db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM wallet_topups AS t WHERE t.status = 'pending_verification'
        AND NOT EXISTS (SELECT 1 FROM approvals AS a WHERE a.kind = 'wallet_topup' AND a.entity_id = t.id AND a.status = 'pending' AND a.requested_by = ${myId})`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM approvals WHERE kind = 'wallet_adjustment' AND status = 'pending' AND requested_by <> ${myId}`),
  ]);
  return { topups: num(topups[0]?.n), adjustments: num(adjustments[0]?.n) };
}

