/**
 * The customer wallet (docs/CONTRACTS.md §1, ARCHITECTURE §7.5) — a ledger and nothing else.
 *
 *   const balance = await getWalletBalance(db, customerId);                     // SUM(wallet_ledger.amount_iqd)
 *   await runBatch(db, [insertOrder, walletDebitStatement(db, { customerId, amountIqd, refType: "order", refId, idempotencyKey, actor, now }), …]);
 *   await creditWallet(db, actor, { customerId, amountIqd, kind: "topup", refType: "wallet_topup", refId, reason, idempotencyKey }, now);
 *
 * RULES
 *   · There is no balance column. The balance is the sum of the ledger, credits positive, debits
 *     negative. A debit that would take it below zero is refused by the database trigger
 *     (TT:WALLET_OVERDRAFT → AppError "wallet_insufficient"), inside the batch that wanted to spend
 *     it — so the order, its reservations and everything else in that batch roll back with it.
 *   · Every entry has a UNIQUE idempotency key: the same credit or debit cannot be written twice.
 *   · Only customers have wallets. Guests cannot pay with or see one; nothing here takes a guest.
 *   · Credits move money the customer can spend, so each one is posted to the journal in the same
 *     batch (Cr wallet liability) and audited. Who may credit depends on why:
 *        topup            customers.wallet.adjust     a transfer/cash top-up checked by staff (Dr cash or bank clearing)
 *        adjustment       customers.wallet.adjust     goodwill credit (Dr operating expenses)
 *        trade_in_credit  devices.tradein.payout      a trade-in paid as store credit (Dr inventory: the device bought)
 *     Refund credits are NOT made here: they are written by refunds.server (createRefund /
 *     approveRefund) with walletCreditStatement, inside the refund's batch, so they stay bounded by
 *     the refund triggers. Gift-card redemptions belong to the gift-card flow (no gift-card
 *     liability account exists in the chart yet).
 *
 * MONEY THAT MOVES OUT (since 2026-11-12, for admin 07's merge and erasure)
 *   · walletTransferStatements — a TRANSFER between two customers' wallets, for the caller's batch (module 07's
 *     merge): a debit row on one ledger and a credit row on the other (kind "adjustment", ref "wallet_transfer",
 *     keys "wallet_transfer:<id>:out|in"), no journal entry (the money stays in wallet liability), an audit event;
 *     `drain` re-checks inside the batch that the source is left at exactly 0 (nothing credited meanwhile is
 *     left behind). The overdraft trigger refuses moving more than the source holds, and a demo account and a real
 *     one never exchange money (TT:WALLET_DEMO_MISMATCH — demo credits are demo postings; review 2026-11-12).
 *   · requestWalletPayout / decideWalletPayout — a PAYOUT (debit) with a reason and a SECOND PERSON: one employee
 *     (customers.wallet.adjust or customers.privacy.manage) asks for it — an `approvals` row "wallet_payout", one
 *     waiting per customer —, another employee with customers.wallet.adjust decides (never the requester:
 *     approver_is_requester). Approving debits the ledger (kind "adjustment", key "wallet_payout:<approval>"), posts
 *     Dr wallet liability / Cr cash or bank clearing (a bank transfer needs its reference) and audits, in ONE guarded
 *     batch. Errors: wallet_insufficient, wallet_payout_pending, approver_is_requester, change_not_pending,
 *     reference_required, customer_unavailable, idempotency_mismatch.
 *
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Paged } from "~/lib/dto";
import { newId, sha256Hex } from "~/lib/ids";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, customers, orders, refunds, walletLedger, walletTopups, type SystemAccountKey, type WalletEntryKind } from "~/server/db/schema";
import { expectChanged, expectThat, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { mapPostingError, postWalletCredit, postWalletDebit, postedBy } from "./accounting/post.server";

/** Error keys this module produces (translated through `errors.<key>`). */
export const WALLET_ERROR_KEYS = ["wallet_insufficient", "wallet_requires_account", "idempotency_mismatch", "customer_unavailable", "wallet_payout_pending", "approver_is_requester", "change_not_pending", "reference_required"] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");

/** One line of the wallet history, as the customer sees it. */
export type WalletEntryView = {
  id: string;
  kind: WalletEntryKind;
  /** Positive = money in, negative = money spent. */
  amountIqd: number;
  at: number;
  /** The order it belongs to (purchases and refunds). */
  orderRef: string | null;
  /** What the row refers to ("order", "refund", "wallet_topup", "gift_card", "trade_in", "wallet_transfer", "wallet_payout", …). */
  refType?: string | null;
};

// ───────────────────────────────────────────────────────────────── reading

/** The customer's balance: SUM of the ledger (0 for a customer without entries). */
export async function getWalletBalance(db: Db, customerId: string): Promise<number> {
  const row = await db
    .select({ balance: sql<number>`coalesce(sum(${walletLedger.amountIqd}), 0)` })
    .from(walletLedger)
    .where(eq(walletLedger.customerId, customerId))
    .get();
  return Number(row?.balance ?? 0);
}

export type WalletPage = { cursor?: string | null; limit?: number };

function parseCursor(cursor: string | null | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const match = /^(\d{1,16}):([A-Za-z0-9_.:-]{1,128})$/.exec(cursor);
  return match ? { at: Number(match[1]), id: match[2] } : null;
}

/** The customer's wallet history, newest first (keyset pages; pass `nextCursor` back as `cursor`). */
export async function listWalletEntries(db: Db, customerId: string, page: WalletPage = {}): Promise<Paged<WalletEntryView>> {
  const limit = Math.min(Math.max(Math.floor(page.limit ?? 20), 1), 100);
  const cursor = parseCursor(page.cursor);
  const where = cursor
    ? and(eq(walletLedger.customerId, customerId), or(lt(walletLedger.at, cursor.at), and(eq(walletLedger.at, cursor.at), lt(walletLedger.id, cursor.id))))
    : eq(walletLedger.customerId, customerId);
  const [rows, total] = await Promise.all([
    db
      .select({ id: walletLedger.id, kind: walletLedger.kind, amountIqd: walletLedger.amountIqd, at: walletLedger.at, refType: walletLedger.refType, refId: walletLedger.refId })
      .from(walletLedger)
      .where(where)
      .orderBy(desc(walletLedger.at), desc(walletLedger.id))
      .limit(limit + 1),
    db
      .select({ n: sql<number>`count(*)` })
      .from(walletLedger)
      .where(eq(walletLedger.customerId, customerId))
      .get(),
  ]);
  const pageRows = rows.slice(0, limit);

  // Order references: purchases point at the order, refunds at the refund (whose order we look up).
  const orderIds = new Set(pageRows.filter((row) => row.refType === "order" && row.refId).map((row) => row.refId as string));
  const refundIds = pageRows.filter((row) => row.refType === "refund" && row.refId).map((row) => row.refId as string);
  const refundOrders = refundIds.length ? await db.select({ id: refunds.id, orderId: refunds.orderId }).from(refunds).where(inArray(refunds.id, refundIds)) : [];
  for (const row of refundOrders) orderIds.add(row.orderId);
  const refs = orderIds.size
    ? await db
        .select({ id: orders.id, ref: orders.ref, customerId: orders.customerId })
        .from(orders)
        .where(inArray(orders.id, [...orderIds]))
    : [];
  // Only references of this customer's own orders are shown.
  const refOf = new Map(refs.filter((row) => row.customerId === customerId).map((row) => [row.id, row.ref]));
  const orderOfRefund = new Map(refundOrders.map((row) => [row.id, row.orderId]));

  const items: WalletEntryView[] = pageRows.map((row) => {
    const orderId = row.refType === "order" ? row.refId : row.refType === "refund" && row.refId ? (orderOfRefund.get(row.refId) ?? null) : null;
    return { id: row.id, kind: row.kind, amountIqd: row.amountIqd, at: row.at, orderRef: orderId ? (refOf.get(orderId) ?? null) : null, refType: row.refType ?? null };
  });
  const last = pageRows[pageRows.length - 1];
  return { items, total: Number(total?.n ?? 0), nextCursor: rows.length > limit && last ? `${last.at}:${last.id}` : null };
}

// ───────────────────────────────────────────────────────────────── statements for other services' batches

type LedgerStatementInput = {
  /** Default: a new id. */
  id?: string;
  customerId: string;
  /** Positive amount; the direction comes from the function. */
  amountIqd: number;
  refType: string | null;
  refId: string | null;
  reason?: string | null;
  idempotencyKey: string;
  actor: Actor;
  now: number;
};

function positiveAmount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${what}: amount must be a positive whole number of dinars, got ${String(value)}`);
  return value;
}

/**
 * ONE statement that spends `amountIqd` from the customer's wallet (a 'purchase' row of −amount).
 * Put it in the batch of the thing being paid for: if the balance does not cover it, the overdraft
 * trigger aborts the whole batch (TT:WALLET_OVERDRAFT:<customerId>).
 */
export function walletDebitStatement(db: Db, input: LedgerStatementInput): BatchStatement {
  const amount = positiveAmount(input.amountIqd, "walletDebitStatement");
  const { actorKind, actorId } = actorRef(input.actor);
  return db.insert(walletLedger).values({
    id: input.id ?? newId("wal"),
    customerId: input.customerId,
    amountIqd: -amount,
    kind: "purchase",
    refType: input.refType,
    refId: input.refId,
    reason: input.reason ?? null,
    actorKind,
    actorId,
    idempotencyKey: input.idempotencyKey,
    at: input.now,
  });
}

/** ONE statement that credits the wallet. Callers post the matching journal entry in the same batch. */
export function walletCreditStatement(db: Db, input: LedgerStatementInput & { kind: Exclude<WalletEntryKind, "purchase"> }): BatchStatement {
  const amount = positiveAmount(input.amountIqd, "walletCreditStatement");
  const { actorKind, actorId } = actorRef(input.actor);
  return db.insert(walletLedger).values({
    id: input.id ?? newId("wal"),
    customerId: input.customerId,
    amountIqd: amount,
    kind: input.kind,
    refType: input.refType,
    refId: input.refId,
    reason: input.reason ?? null,
    actorKind,
    actorId,
    idempotencyKey: input.idempotencyKey,
    at: input.now,
  });
}

// ───────────────────────────────────────────────────────────────── crediting

export const WALLET_CREDIT_KINDS = ["topup", "adjustment", "trade_in_credit"] as const;
export type WalletCreditKind = (typeof WALLET_CREDIT_KINDS)[number];

const CREDIT_PERMISSION: Record<WalletCreditKind, Permission> = {
  topup: "customers.wallet.adjust",
  adjustment: "customers.wallet.adjust",
  trade_in_credit: "devices.tradein.payout",
};

export const CreditWalletInput = z.object({
  customerId: idSchema,
  amountIqd: z.number().int("invalid").min(1, "too_small").max(100_000_000, "too_big"),
  kind: z.enum(WALLET_CREDIT_KINDS),
  refType: z.string().trim().min(1, "required").max(50, "too_long").nullish(),
  refId: z.string().trim().min(1, "required").max(200, "too_long").nullish(),
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
  idempotencyKey: z.string().trim().min(8, "too_short").max(200, "too_long"),
  /** Top-ups: where the money arrived. Default: the top-up request's method, else bank clearing. */
  fundedBy: z.enum(["cash", "bank_clearing"]).optional(),
});
export type CreditWalletInput = z.input<typeof CreditWalletInput>;

/**
 * Credits a customer's wallet: one ledger row, its journal entry and an audit event, in one batch.
 * Idempotent on `idempotencyKey`: a retry with the same key returns the first entry
 * (`replayed: true`); the same key with a different customer, amount or kind is
 * AppError("idempotency_mismatch", 409).
 */
export async function creditWallet(db: Db, actor: Actor, raw: CreditWalletInput, now: number): Promise<{ entryId: string; replayed: boolean }> {
  const input = CreditWalletInput.parse(raw);
  assertCan(actor, CREDIT_PERMISSION[input.kind]);

  const replay = async () => {
    const existing = await db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, input.idempotencyKey)).get();
    if (!existing) return null;
    if (existing.customerId !== input.customerId || existing.amountIqd !== input.amountIqd || existing.kind !== input.kind) {
      throw new AppError("idempotency_mismatch", 409, { detail: input.idempotencyKey });
    }
    return { entryId: existing.id, replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const customer = await db.select({ id: customers.id, status: customers.status, isDemo: customers.isDemo }).from(customers).where(eq(customers.id, input.customerId)).get();
  if (!customer) throw notFound("customer");
  if (customer.status === "merged" || customer.status === "deleted") throw new AppError("customer_unavailable", 409, { detail: customer.status });

  let debitAccount: SystemAccountKey;
  if (input.kind === "trade_in_credit") debitAccount = "inventory";
  else if (input.kind === "adjustment") debitAccount = "operating_expenses";
  else {
    let fundedBy = input.fundedBy;
    if (!fundedBy && input.refType === "wallet_topup" && input.refId) {
      const topup = await db.select({ method: walletTopups.method }).from(walletTopups).where(eq(walletTopups.id, input.refId)).get();
      if (topup) fundedBy = topup.method === "cash" ? "cash" : "bank_clearing";
    }
    debitAccount = fundedBy ?? "bank_clearing";
  }

  const entryId = newId("wal");
  const statements: BatchStatement[] = [
    walletCreditStatement(db, {
      id: entryId,
      customerId: input.customerId,
      amountIqd: input.amountIqd,
      kind: input.kind,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      actor,
      now,
    }),
    ...postWalletCredit(db, {
      ledgerEntryId: entryId,
      customerId: input.customerId,
      amountIqd: input.amountIqd,
      debitAccount,
      memo: `Wallet ${input.kind}`,
      at: now,
      createdBy: postedBy(actor),
      isDemo: customer.isDemo,
    }),
    auditStatement(db, {
      actor,
      action: "customers.wallet.credit",
      entityType: "customer",
      entityId: input.customerId,
      after: { entryId, kind: input.kind, amountIqd: input.amountIqd, refType: input.refType ?? null, refId: input.refId ?? null },
      reason: input.reason,
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isUniqueViolation(error, "wallet_ledger.idempotency_key")) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw error;
  }
  return { entryId, replayed: false };
}

// ───────────────────────────────────────────────────────────────── transfers (admin 07 merge)

export type WalletTransferInput = {
  /** Names the transfer: its rows' keys are "wallet_transfer:<id>:out|in". */
  transferId: string;
  fromCustomerId: string;
  toCustomerId: string;
  /** Positive; 0 moves nothing (with `drain`, the source must already be empty). */
  amountIqd: number;
  reason: string;
  actor: Actor;
  now: number;
  /** Inside the batch, after the move: the source holds exactly 0 — else the batch fails with this code. */
  drain?: { code: string };
};

/**
 * The statements that move `amountIqd` from one customer's wallet to another's, for the caller's batch (the caller
 * authorizes — module 07's merge holds customers.customer.merge): a debit row on the source, a credit row on the
 * target (kind "adjustment", ref "wallet_transfer"), an audit event; no journal entry (the money stays in wallet
 * liability: the sum of the ledger does not change). The overdraft trigger refuses moving more than the source holds;
 * a demo account and a real one never exchange money (TT:WALLET_DEMO_MISMATCH:<from> — review 2026-11-12).
 */
export function walletTransferStatements(db: Db, input: WalletTransferInput): BatchStatement[] {
  if (input.fromCustomerId === input.toCustomerId) throw new Error("walletTransferStatements: a transfer needs two different wallets");
  if (!Number.isSafeInteger(input.amountIqd) || input.amountIqd < 0) throw new Error(`walletTransferStatements: amount must be a whole number of dinars ≥ 0, got ${String(input.amountIqd)}`);
  const statements: BatchStatement[] = [];
  if (input.amountIqd > 0) {
    const { actorKind, actorId } = actorRef(input.actor);
    const row = (customerId: string, amountIqd: number, side: "out" | "in") => ({
      id: newId("wal"),
      customerId,
      amountIqd,
      kind: "adjustment" as const,
      refType: "wallet_transfer",
      refId: input.transferId,
      reason: input.reason,
      actorKind,
      actorId,
      idempotencyKey: `wallet_transfer:${input.transferId}:${side}`,
      at: input.now,
    });
    statements.push(
      // demo money never lands in a real wallet, nor real money in a demo one: each was posted to its own books (a demo
      // credit is a demo journal entry), so a transfer across would create real money (review 2026-11-12)
      expectThat(db, sql`(SELECT is_demo FROM customers WHERE id = ${input.fromCustomerId}) IS (SELECT is_demo FROM customers WHERE id = ${input.toCustomerId})`, { code: "WALLET_DEMO_MISMATCH", detail: input.fromCustomerId }),
      db.insert(walletLedger).values(row(input.fromCustomerId, -input.amountIqd, "out")),
      db.insert(walletLedger).values(row(input.toCustomerId, input.amountIqd, "in")),
      auditStatement(db, {
        actor: input.actor,
        action: "customers.wallet.transfer",
        entityType: "customer",
        entityId: input.toCustomerId,
        after: { transferId: input.transferId, fromCustomerId: input.fromCustomerId, toCustomerId: input.toCustomerId, amountIqd: input.amountIqd },
        reason: input.reason,
        at: input.now,
      }),
    );
  }
  if (input.drain) {
    statements.push(expectThat(db, sql`(SELECT coalesce(sum(amount_iqd), 0) FROM wallet_ledger WHERE customer_id = ${input.fromCustomerId}) = 0`, { code: input.drain.code, detail: "wallet_balance" }));
  }
  return statements;
}

// ───────────────────────────────────────────────────────────────── payouts (admin 07 erasure) — two people

export const WALLET_PAYOUT_KIND = "wallet_payout" as const;
const PAYOUT_METHODS = ["cash", "bank_transfer"] as const;

const reasonText = z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long");

export const RequestPayoutInput = z.object({
  customerId: idSchema,
  amountIqd: z.number({ error: "required" }).int("invalid").min(1, "too_small").max(100_000_000, "too_big"),
  /** Cash handed over at the store, or a bank transfer to the customer (its reference when it is sent). */
  method: z.enum(PAYOUT_METHODS, { error: "required" }),
  reference: z.string().trim().max(100, "too_long").optional().nullable().transform((value) => value || null),
  reason: reasonText,
  idempotencyKey: z.string().trim().min(8, "too_short").max(200, "too_long"),
});
export type RequestPayoutInput = z.input<typeof RequestPayoutInput>;

/** Inside a batch: the customer may still hold a wallet (not merged or erased meanwhile). */
const walletHolderStill = (db: Db, customerId: string) => expectThat(db, sql`EXISTS (SELECT 1 FROM customers WHERE id = ${customerId} AND status IN ('active', 'blocked'))`, { code: "CUSTOMER_UNAVAILABLE", detail: customerId });

/**
 * Asks for money to be paid OUT of a customer's wallet (file header): one waiting request per customer, never more
 * than the balance now (checked again when it is decided). customers.wallet.adjust or customers.privacy.manage.
 * Idempotent on the key (the same key with another amount or customer is idempotency_mismatch).
 */
export async function requestWalletPayout(db: Db, actor: Actor, raw: RequestPayoutInput, now: number): Promise<{ approvalId: string; replayed: boolean }> {
  if (!can(actor, "customers.wallet.adjust") && !can(actor, "customers.privacy.manage")) throw forbidden("customers.wallet.adjust");
  if (actor.kind !== "employee") throw forbidden("customers.wallet.adjust");
  const input = RequestPayoutInput.parse(raw);
  const approvalId = `apr_${(await sha256Hex(`tamtam.wallet.payout.v1|${actor.id}|${input.idempotencyKey}`)).slice(0, 26)}`;
  const earlier = await db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
  if (earlier) {
    const payload = (earlier.payload ?? {}) as { amountIqd?: number };
    if (earlier.entityId !== input.customerId || payload.amountIqd !== input.amountIqd) throw new AppError("idempotency_mismatch", 409, { detail: input.idempotencyKey });
    return { approvalId, replayed: true };
  }
  const customer = await db.select({ id: customers.id, status: customers.status }).from(customers).where(eq(customers.id, input.customerId)).get();
  if (!customer) throw notFound("customer");
  if (customer.status === "merged" || customer.status === "deleted") throw new AppError("customer_unavailable", 409, { detail: customer.status });
  if ((await getWalletBalance(db, customer.id)) < input.amountIqd) throw new AppError("wallet_insufficient", 409, { fields: { amountIqd: "wallet_insufficient" } });
  try {
    await runBatch(db, [
      // one waiting payout per customer, decided in the batch (two tabs cannot both ask)
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM approvals WHERE kind = ${WALLET_PAYOUT_KIND} AND entity_id = ${customer.id} AND status = 'pending')`, { code: "WALLET_PAYOUT_PENDING", detail: customer.id }),
      db.insert(approvals).values({
        id: approvalId,
        kind: WALLET_PAYOUT_KIND,
        entityType: "customer",
        entityId: customer.id,
        requestedBy: actor.id,
        payload: { amountIqd: input.amountIqd, method: input.method, reference: input.reference },
        status: "pending",
        reason: input.reason,
        createdAt: now,
        requiredPermission: "customers.wallet.adjust",
      }),
      auditStatement(db, { actor, action: "customers.wallet.payout_request", entityType: "customer", entityId: customer.id, after: { approvalId, amountIqd: input.amountIqd, method: input.method }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (mapDbError(error)?.code === "WALLET_PAYOUT_PENDING") throw new AppError("wallet_payout_pending", 409, { detail: customer.id });
    if (isUniqueViolation(error, "approvals.id")) return { approvalId, replayed: true };
    throw error;
  }
  return { approvalId, replayed: false };
}

export const DecidePayoutInput = z.object({
  approvalId: idSchema,
  approve: z.boolean(),
  /** Rejecting: why (≥ 3). */
  note: z.string().trim().max(500, "too_long").optional().nullable().transform((value) => value || ""),
  /** The outgoing transfer's reference, when the request did not carry it (a bank transfer needs one). */
  reference: z.string().trim().max(100, "too_long").optional().nullable().transform((value) => value || null),
});
export type DecidePayoutInput = z.input<typeof DecidePayoutInput>;

/**
 * Decides a payout request (file header): customers.wallet.adjust, never the requester. Approving pays it out in ONE
 * batch — the approval guarded on pending, the customer still holding a wallet, the ledger debit (the overdraft trigger:
 * wallet_insufficient), its posting, the audit event. Repeating the same decision answers `replayed`.
 */
export async function decideWalletPayout(db: Db, actor: Actor, raw: DecidePayoutInput, now: number): Promise<{ status: "paid" | "rejected"; entryId: string | null; replayed: boolean }> {
  assertCan(actor, "customers.wallet.adjust");
  if (actor.kind !== "employee") throw forbidden("customers.wallet.adjust");
  const input = DecidePayoutInput.parse(raw);
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, WALLET_PAYOUT_KIND))).get();
  if (!approval || !approval.entityId) throw notFound("approval");
  const entryKey = `wallet_payout:${approval.id}`;
  if (approval.status !== "pending") {
    if (input.approve && approval.status === "approved") return { status: "paid", entryId: (await db.select({ id: walletLedger.id }).from(walletLedger).where(eq(walletLedger.idempotencyKey, entryKey)).get())?.id ?? null, replayed: true };
    if (!input.approve && approval.status === "rejected") return { status: "rejected", entryId: null, replayed: true };
    throw new AppError("change_not_pending", 409, { detail: approval.status });
  }
  if (approval.requestedBy === actor.id) throw new AppError("approver_is_requester", 403, { detail: approval.id });
  const payload = (approval.payload ?? {}) as { amountIqd?: number; method?: (typeof PAYOUT_METHODS)[number]; reference?: string | null };
  const amount = Number(payload.amountIqd);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError("change_not_pending", 409, { detail: "payload" });
  const customerId = approval.entityId;
  const close = (status: "approved" | "rejected") => [
    db
      .update(approvals)
      .set({ status, decidedBy: actor.id, decidedAt: now, decisionNote: input.note || null })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
  ];
  const guard = (error: unknown): never => {
    const posting = mapPostingError(error);
    if (posting) throw posting;
    const code = mapDbError(error)?.code;
    if (code === "WALLET_OVERDRAFT") throw new AppError("wallet_insufficient", 409, { cause: error });
    if (code === "CHANGE_NOT_PENDING") throw new AppError("change_not_pending", 409, { cause: error });
    if (code === "CUSTOMER_UNAVAILABLE") throw new AppError("customer_unavailable", 409, { cause: error });
    throw error;
  };

  if (!input.approve) {
    if (input.note.length < 3) throw invalid({ note: "required" });
    await runBatch(db, [...close("rejected"), auditStatement(db, { actor, action: "customers.wallet.payout_reject", entityType: "customer", entityId: customerId, after: { approvalId: approval.id, amountIqd: amount }, reason: input.note, at: now })]).catch(guard);
    return { status: "rejected", entryId: null, replayed: false };
  }

  const method = payload.method === "bank_transfer" ? "bank_transfer" : "cash";
  const reference = input.reference ?? payload.reference ?? null;
  if (method === "bank_transfer" && !reference) throw invalid({ reference: "reference_required" });
  const customer = await db.select({ status: customers.status, isDemo: customers.isDemo }).from(customers).where(eq(customers.id, customerId)).get();
  if (!customer) throw notFound("customer");
  const entryId = newId("wal");
  const { actorKind, actorId } = actorRef(actor);
  const reason = approval.reason ?? "payout";
  try {
    await runBatch(db, [
      ...close("approved"),
      walletHolderStill(db, customerId),
      // the requester stays the author of the request; the payer is the one who decided (both in the audit trail)
      db.insert(walletLedger).values({ id: entryId, customerId, amountIqd: -amount, kind: "adjustment", refType: WALLET_PAYOUT_KIND, refId: approval.id, reason, actorKind, actorId, idempotencyKey: entryKey, at: now }),
      ...postWalletDebit(db, { ledgerEntryId: entryId, customerId, amountIqd: amount, creditAccount: method === "cash" ? "cash" : "bank_clearing", memo: `Wallet paid out (${method})`, at: now, createdBy: postedBy(actor), isDemo: customer.isDemo }),
      auditStatement(db, {
        actor,
        action: "customers.wallet.payout",
        entityType: "customer",
        entityId: customerId,
        after: { approvalId: approval.id, entryId, amountIqd: amount, method, reference, requestedBy: approval.requestedBy },
        reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "wallet_ledger.idempotency_key")) return { status: "paid", entryId: (await db.select({ id: walletLedger.id }).from(walletLedger).where(eq(walletLedger.idempotencyKey, entryKey)).get())?.id ?? null, replayed: true };
    guard(error);
  }
  return { status: "paid", entryId, replayed: false };
}

/** Payout requests waiting for a second person (for the screens that decide them). */
export async function pendingWalletPayouts(db: Db, customerId?: string): Promise<{ approvalId: string; customerId: string; amountIqd: number; method: string; requestedBy: string; reason: string | null; createdAt: number }[]> {
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.kind, WALLET_PAYOUT_KIND), eq(approvals.status, "pending"), ...(customerId ? [eq(approvals.entityId, customerId)] : [])))
    .orderBy(approvals.createdAt);
  return rows.map((row) => {
    const payload = (row.payload ?? {}) as { amountIqd?: number; method?: string };
    return { approvalId: row.id, customerId: row.entityId ?? "", amountIqd: Number(payload.amountIqd ?? 0), method: payload.method ?? "cash", requestedBy: row.requestedBy, reason: row.reason, createdAt: row.createdAt };
  });
}
