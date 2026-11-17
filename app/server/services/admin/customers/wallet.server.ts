/**
 * Admin 07 — money paid OUT of a customer's wallet: the REQUEST (2026-11-13). A customer leaving, an account closed or
 * erased (07.04: an account holding money is paid out before it can be erased), money owed back in cash or by transfer.
 *
 *   await requestPayout(db, actor, { customerId, amountIqd: 25_000, method: "cash", reason: "طلب حذف الحساب", idempotencyKey }, now);
 *   const state = await payoutState(db, actor, customerId);   // the profile's wallet section
 *
 * RULES (the commerce core's, wallet.server.ts requestWalletPayout — nothing here weakens them):
 *   · asked by an employee with customers.wallet.adjust or customers.privacy.manage, always with a reason (≥ 10
 *     characters here: the person who decides reads it), integer IQD, never more than the wallet holds NOW
 *     (payout_exceeds_balance), one waiting request per customer (wallet_payout_pending — also for two tabs at once);
 *   · nothing moves until a SECOND person decides it in finance 10 (services/admin/finance/wallets.server.ts
 *     decidePayout: never the requester; the overdraft trigger refuses it again if the wallet was spent meanwhile);
 *   · cash (handed over at the store) or a bank transfer (its outgoing reference now or when it is approved);
 *   · audited by the core (`customers.wallet.payout_request`); idempotent on the form's key.
 * The amounts and states reach only employees who read wallets (customers.wallet.read): the profile's wallet section is
 * absent from the loader data otherwise.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, customers } from "~/server/db/schema";
import { AppError, forbidden, toAppError } from "~/server/errors";
import { getWalletBalance, requestWalletPayout, WALLET_PAYOUT_KIND } from "~/server/services/wallet.server";
import { employeeNames } from "./shared.server";

export const PAYOUT_REQUEST_METHODS = ["cash", "bank_transfer"] as const;
export type PayoutRequestMethod = (typeof PAYOUT_REQUEST_METHODS)[number];

/** Error keys this file adds (texts: admin-customers → errors.*); the core's wallet_payout_pending and customer_unavailable keep theirs. */
export const PAYOUT_REQUEST_ERROR_KEYS = ["payout_exceeds_balance"] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);

export const PayoutRequestInput = z.object({
  customerId: z.string().regex(ID, "invalid"),
  amountIqd: z.number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") }).int("invalid").min(1, "too_small").max(100_000_000, "too_big"),
  method: z.enum(PAYOUT_REQUEST_METHODS, { error: "required" }),
  reference: z.preprocess(blank, z.string().trim().max(100, "too_long").optional()),
  reason: z.string({ error: "required" }).trim().min(10, "too_short").max(500, "too_long"),
  idempotencyKey: z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid"),
});
export type PayoutRequestInput = z.input<typeof PayoutRequestInput>;

/** May this employee ask for a payout (the core's rule: customers.wallet.adjust or customers.privacy.manage)? */
export function canRequestPayout(actor: Actor): boolean {
  return actor.kind === "employee" && (can(actor, "customers.wallet.adjust") || can(actor, "customers.privacy.manage"));
}

/**
 * Asks for a payout (file header). Answers the request's id; a repeat of the same form answers it again (`replayed`).
 * The core's wallet_insufficient is worded for this form (payout_exceeds_balance, on the amount field).
 */
export async function requestPayout(db: Db, actor: Actor, raw: PayoutRequestInput, now: number): Promise<{ approvalId: string; replayed: boolean }> {
  if (!canRequestPayout(actor)) throw forbidden("customers.wallet.adjust");
  const input = PayoutRequestInput.parse(raw);
  try {
    return await requestWalletPayout(db, actor, { customerId: input.customerId, amountIqd: input.amountIqd, method: input.method, reference: input.reference ?? null, reason: input.reason, idempotencyKey: `payout:${input.idempotencyKey}` }, now);
  } catch (error) {
    if (toAppError(error)?.code === "wallet_insufficient") throw new AppError("payout_exceeds_balance", 409, { fields: { amountIqd: "payout_exceeds_balance" }, cause: error });
    throw error;
  }
}

export type PayoutState = {
  /** The waiting request, if any (one per customer). */
  pending: { id: string; amountIqd: number; method: PayoutRequestMethod; requestedBy: string | null; mine: boolean; createdAt: number; reason: string | null } | null;
  /** The latest decided request (paid or refused), for context. */
  last: { id: string; amountIqd: number; method: PayoutRequestMethod; status: "approved" | "rejected"; decidedAt: number | null } | null;
  /** This employee may ask now: the right, an account that still holds a wallet, money in it, nothing waiting. */
  canRequest: boolean;
  /** Why not (when they hold the right): the screen says so instead of hiding the action. */
  blockedBy: "pending" | "empty" | "closed" | null;
};

/** The profile's payout facts (customers.wallet.read — the section is absent without it). */
export async function payoutState(db: Db, actor: Actor, customerId: string): Promise<PayoutState> {
  assertCan(actor, "customers.wallet.read");
  const [rows, balance, customer] = await Promise.all([
    db
      .select()
      .from(approvals)
      // (entity_type, entity_id) seeks approvals_entity_idx: this customer's rows only, never every payout ever asked
      .where(and(eq(approvals.entityType, "customer"), eq(approvals.entityId, customerId), eq(approvals.kind, WALLET_PAYOUT_KIND)))
      .orderBy(sql`CASE ${approvals.status} WHEN 'pending' THEN 0 ELSE 1 END`, desc(approvals.createdAt), desc(approvals.id))
      .limit(2),
    getWalletBalance(db, customerId),
    db.select({ status: customers.status }).from(customers).where(eq(customers.id, customerId)).get(),
  ]);
  const pendingRow = rows.find((row) => row.status === "pending");
  const lastRow = rows.find((row) => row.status === "approved" || row.status === "rejected");
  const names = await employeeNames(db, pendingRow ? [pendingRow.requestedBy] : []);
  const amountOf = (row: (typeof rows)[number]) => Number((row.payload as { amountIqd?: number } | null)?.amountIqd ?? 0);
  const methodOf = (row: (typeof rows)[number]): PayoutRequestMethod => ((row.payload as { method?: string } | null)?.method === "bank_transfer" ? "bank_transfer" : "cash");
  const open = customer?.status === "active" || customer?.status === "blocked";
  const blockedBy: PayoutState["blockedBy"] = !open ? "closed" : pendingRow ? "pending" : balance <= 0 ? "empty" : null;
  return {
    pending: pendingRow
      ? { id: pendingRow.id, amountIqd: amountOf(pendingRow), method: methodOf(pendingRow), requestedBy: names.get(pendingRow.requestedBy) ?? null, mine: actor.kind === "employee" && pendingRow.requestedBy === actor.id, createdAt: pendingRow.createdAt, reason: pendingRow.reason }
      : null,
    last: lastRow ? { id: lastRow.id, amountIqd: amountOf(lastRow), method: methodOf(lastRow), status: lastRow.status as "approved" | "rejected", decidedAt: lastRow.decidedAt } : null,
    canRequest: canRequestPayout(actor) && blockedBy === null,
    blockedBy: canRequestPayout(actor) ? blockedBy : null,
  };
}
