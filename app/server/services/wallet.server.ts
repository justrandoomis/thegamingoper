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
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Paged } from "~/lib/dto";
import { newId } from "~/lib/ids";
import { actorRef, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { customers, orders, refunds, walletLedger, walletTopups, type SystemAccountKey, type WalletEntryKind } from "~/server/db/schema";
import { isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { postWalletCredit, postedBy } from "./accounting/post.server";

/** Error keys this module produces (translated through `errors.<key>`). */
export const WALLET_ERROR_KEYS = ["wallet_insufficient", "wallet_requires_account", "idempotency_mismatch", "customer_unavailable"] as const;

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
    return { id: row.id, kind: row.kind, amountIqd: row.amountIqd, at: row.at, orderRef: orderId ? (refOf.get(orderId) ?? null) : null };
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
