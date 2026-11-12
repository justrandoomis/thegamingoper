/**
 * Standard journal postings (docs/CONTRACTS.md §1, docs/metrics.md "Postings").
 *
 *   await runBatch(db, [
 *     …business statements…,
 *     ...postSale(db, { orderId, ref, subtotalIqd, discountIqd, shippingIqd, totalIqd, at: now, createdBy, isDemo }),
 *   ]);
 *
 * Every builder is SYNCHRONOUS and returns batch statements, so a posting is always written in the
 * same db.batch as the business change it describes: both are stored or neither is. They go through
 * journalEntryStatements() (lines first, sealing header last), so the database refuses an
 * unbalanced entry (TT:JOURNAL_UNBALANCED) and any entry dated into a closed month
 * (TT:PERIOD_CLOSED → AppError "period_closed", 409, via toAppError/mapPostingError).
 *
 * Accounts are named by their stable SYSTEM KEY from the reference seed ("sales_revenue",
 * "cod_receivable", …). The seed gives each one the id `acc_<key>` (accountId() in
 * ~/server/db/seed/reference), which an accountant cannot change by renumbering or renaming, so no
 * lookup is needed; a database without the reference seed fails the batch on the foreign key.
 *
 * One posting per business event: each builder sets a deterministic `idempotency_key`
 * ("order:<id>:sale", "payment:<id>:received", "refund:<id>" …). Posting the same event twice fails
 * the batch with UNIQUE journal_entries.idempotency_key instead of doubling the books.
 *
 * Zero-amount lines are dropped; a posting whose lines are all zero writes nothing. Anything else
 * that does not balance throws JournalEntryError BEFORE touching the database — that is a bug, not
 * a user error.
 *
 * The chart has no separate "customer advances" account. `cod_receivable` is therefore used as the
 * CUSTOMER CONTROL ACCOUNT: debited with the order total when revenue is recognised (delivery),
 * credited by every payment for an order (COD collected, transfer verified, wallet debit). A credit
 * balance on it means money received for orders not delivered yet. See docs/metrics.md.
 */
import { newId } from "~/lib/ids";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { assertBalanced, journalEntryStatements, type JournalLineInput } from "~/server/db/journal.server";
import type { PaymentMethod, SystemAccountKey } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import { mapDbError } from "~/server/db/tx.server";
import { AppError } from "~/server/errors";

/** Error keys this module can produce (translated through `errors.<key>`). */
export const ACCOUNTING_ERROR_KEYS = ["period_closed", "already_posted"] as const;

/** A line naming its account by system key (`accountCode`) or, for non-system accounts, by id. */
export type JournalLineSpec = ({ accountCode: SystemAccountKey } | { accountId: string }) & {
  debitIqd?: number;
  creditIqd?: number;
  costCenter?: string | null;
  memo?: string | null;
};

export type JournalSpec = {
  /** Default: a new id. */
  id?: string;
  at: number;
  memo?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** Employee id, or "system:<job>" for postings made by the server itself. */
  createdBy?: string | null;
  /** One posting per business event. */
  idempotencyKey?: string | null;
  reversesId?: string | null;
  /** Postings of demo orders are flagged and excluded from real reports. */
  isDemo?: boolean;
  lines: JournalLineSpec[];
};

/** Who and when, shared by the standard postings. */
export type PostingContext = { at: number; createdBy: string | null; isDemo: boolean };

function lineAccountId(line: JournalLineSpec): string {
  return "accountCode" in line ? accountId(line.accountCode) : line.accountId;
}

/**
 * Statements for one balanced journal entry (lines first, header last). Zero-amount lines are
 * dropped; when nothing is left the result is [] (nothing to post). Throws JournalEntryError when
 * the remaining lines do not balance or a line is not a positive whole number on exactly one side.
 */
export function journalStatements(db: Db, spec: JournalSpec): BatchStatement[] {
  const lines: JournalLineInput[] = spec.lines
    .filter((line) => (line.debitIqd ?? 0) !== 0 || (line.creditIqd ?? 0) !== 0)
    .map((line) => ({
      accountId: lineAccountId(line),
      ...(line.debitIqd ? { debitIqd: line.debitIqd } : {}),
      ...(line.creditIqd ? { creditIqd: line.creditIqd } : {}),
      costCenter: line.costCenter ?? null,
      memo: line.memo ?? null,
    }));
  if (lines.length === 0) return [];
  assertBalanced(lines);
  return journalEntryStatements(db, {
    id: spec.id ?? newId("je"),
    at: spec.at,
    memo: spec.memo ?? null,
    refType: spec.refType ?? null,
    refId: spec.refId ?? null,
    createdBy: spec.createdBy ?? null,
    reversesId: spec.reversesId ?? null,
    idempotencyKey: spec.idempotencyKey ?? null,
    isDemo: spec.isDemo ?? false,
    lines,
  });
}

/**
 * A posting failure in the shape a route can show: a closed month is "period_closed" (409), an
 * event posted twice is "already_posted" (409). Null for anything else (rethrow it).
 */
export function mapPostingError(error: unknown): AppError | null {
  const info = mapDbError(error);
  if (!info) return null;
  if (info.code === "PERIOD_CLOSED") return new AppError("period_closed", 409, { detail: info.detail, cause: error });
  if (info.kind === "unique" && info.table === "journal_entries") return new AppError("already_posted", 409, { detail: info.detail, cause: error });
  return null;
}

// ───────────────────────────────────────────────────────────────── money in

/** The account a payment method's money lands in. */
export function receivingAccount(method: PaymentMethod): SystemAccountKey {
  switch (method) {
    case "cod":
    case "pos_cash":
      return "cash";
    case "bank_transfer":
    case "zaincash":
    case "pos_card":
      return "bank_clearing";
    case "wallet":
      return "wallet_liability";
  }
}

/** Idempotency key of the "money received" posting of a payment (also read by the consistency checks). */
export const paymentPostingKey = (paymentId: string) => `payment:${paymentId}:received`;
export const salePostingKey = (orderId: string) => `order:${orderId}:sale`;
export const cogsPostingKey = (orderId: string) => `order:${orderId}:cogs`;
export const refundPostingKey = (refundId: string) => `refund:${refundId}`;
export const returnedGoodsPostingKey = (key: string) => `${key}:goods`;
export const walletCreditPostingKey = (ledgerEntryId: string) => `wallet:${ledgerEntryId}`;

type PaymentPosting = PostingContext & {
  paymentId: string;
  orderId: string;
  ref: string;
  method: PaymentMethod;
  /** What actually arrived. */
  receivedIqd: number;
  /** What the order still owed on this payment. A difference accepted by an override goes to cash over/short. */
  dueIqd: number;
};

/**
 * Money received for an order: Dr cash / bank clearing / wallet liability (by method),
 * Cr customer control (cod_receivable) for what was due; a difference accepted by an override is
 * booked to cash_over_short (debit when short, credit when over).
 */
export function postPaymentReceived(db: Db, input: PaymentPosting): BatchStatement[] {
  const difference = input.receivedIqd - input.dueIqd;
  return journalStatements(db, {
    at: input.at,
    memo: `Payment ${input.method} for order ${input.ref}`,
    refType: "payment",
    refId: input.paymentId,
    createdBy: input.createdBy,
    idempotencyKey: paymentPostingKey(input.paymentId),
    isDemo: input.isDemo,
    lines: [
      { accountCode: receivingAccount(input.method), debitIqd: input.receivedIqd },
      { accountCode: "cash_over_short", debitIqd: difference < 0 ? -difference : 0, creditIqd: difference > 0 ? difference : 0 },
      { accountCode: "cod_receivable", creditIqd: input.dueIqd },
    ],
  });
}

/** Cash collected on delivery (recordCodCollection). */
export function postCodCollected(db: Db, input: Omit<PaymentPosting, "method">): BatchStatement[] {
  return postPaymentReceived(db, { ...input, method: "cod" });
}

/** A bank-card or Zain Cash transfer verified by an employee (verifyPayment). */
export function postTransferVerified(db: Db, input: Omit<PaymentPosting, "method"> & { method: "bank_transfer" | "zaincash" }): BatchStatement[] {
  return postPaymentReceived(db, input);
}

/** An order paid from the customer's wallet at checkout. */
export function postWalletPayment(db: Db, input: Omit<PaymentPosting, "method" | "dueIqd" | "receivedIqd"> & { amountIqd: number }): BatchStatement[] {
  return postPaymentReceived(db, { ...input, method: "wallet", receivedIqd: input.amountIqd, dueIqd: input.amountIqd });
}

// ───────────────────────────────────────────────────────────────── revenue and cost (at delivery)

/**
 * Revenue is recognised when an order is delivered: Dr customer control (total), Dr sales
 * discounts (discount), Cr sales revenue (subtotal of the lines), Cr shipping income (fee charged).
 * Prices are tax-inclusive and no tax is configured: an order carrying tax cannot be posted here.
 *
 * `refundedBeforeIqd`: refunds already issued for this order BEFORE delivery were posted against
 * customer control (there was no revenue to reverse yet). At recognition that part of the total is
 * moved to sales refunds (Dr sales refunds instead of Dr customer control), so customer control
 * nets to zero and net revenue is the total minus every refund — whenever it was issued.
 */
export function postSale(
  db: Db,
  input: PostingContext & { orderId: string; ref: string; subtotalIqd: number; discountIqd: number; shippingIqd: number; totalIqd: number; taxIqd?: number; refundedBeforeIqd?: number },
): BatchStatement[] {
  if ((input.taxIqd ?? 0) !== 0) throw new Error(`postSale: order ${input.ref} carries tax, but no tax account is configured`);
  const refundedBefore = input.refundedBeforeIqd ?? 0;
  if (!Number.isSafeInteger(refundedBefore) || refundedBefore < 0 || refundedBefore > input.totalIqd) {
    throw new Error(`postSale: refundedBeforeIqd must be a whole number between 0 and the order total, got ${String(refundedBefore)}`);
  }
  return journalStatements(db, {
    at: input.at,
    memo: `Order ${input.ref} delivered`,
    refType: "order",
    refId: input.orderId,
    createdBy: input.createdBy,
    idempotencyKey: salePostingKey(input.orderId),
    isDemo: input.isDemo,
    lines: [
      { accountCode: "cod_receivable", debitIqd: input.totalIqd - refundedBefore },
      { accountCode: "sales_refunds", debitIqd: refundedBefore },
      { accountCode: "sales_discounts", debitIqd: input.discountIqd },
      { accountCode: "sales_revenue", creditIqd: input.subtotalIqd },
      { accountCode: "shipping_income", creditIqd: input.shippingIqd },
    ],
  });
}

/** Cost of the goods of a delivered order (FIFO landed cost of the units that left, used units at acquisition cost) [P]. */
export function postCogs(db: Db, input: PostingContext & { orderId: string; ref: string; cogsIqd: number }): BatchStatement[] {
  return journalStatements(db, {
    at: input.at,
    memo: `Cost of goods, order ${input.ref}`,
    refType: "order",
    refId: input.orderId,
    createdBy: input.createdBy,
    idempotencyKey: cogsPostingKey(input.orderId),
    isDemo: input.isDemo,
    lines: [
      { accountCode: "cogs", debitIqd: input.cogsIqd },
      { accountCode: "inventory", creditIqd: input.cogsIqd },
    ],
  });
}

// ───────────────────────────────────────────────────────────────── money out

/**
 * Money returned to a customer. Dr sales refunds when the order's revenue was already recognised
 * (delivered), otherwise Dr customer control (the refund returns an advance, there is no revenue to
 * reverse); Cr the account the money leaves from.
 */
export function postRefund(
  db: Db,
  input: PostingContext & { refundId: string; orderId: string; ref: string; amountIqd: number; paidFrom: "cash" | "bank_clearing" | "wallet_liability"; revenueRecognized: boolean },
): BatchStatement[] {
  return journalStatements(db, {
    at: input.at,
    memo: `Refund for order ${input.ref}`,
    refType: "refund",
    refId: input.refundId,
    createdBy: input.createdBy,
    idempotencyKey: refundPostingKey(input.refundId),
    isDemo: input.isDemo,
    lines: [
      { accountCode: input.revenueRecognized ? "sales_refunds" : "cod_receivable", debitIqd: input.amountIqd },
      { accountCode: input.paidFrom, creditIqd: input.amountIqd },
    ],
  });
}

/**
 * Goods coming back from a customer [P]. When the order's cost of goods was posted: restocked units
 * go back to inventory (Dr inventory, Cr COGS) and scrapped units are reclassified as a write-off
 * (Dr inventory adjustments, Cr COGS). When it was not (shipped, never delivered): restocking needs
 * no entry (the units never left the inventory account) and scrapped units are written off
 * (Dr inventory adjustments, Cr inventory).
 */
export function postReturnedGoods(
  db: Db,
  input: PostingContext & { key: string; refType: string; refId: string; orderId: string; ref: string; restockedCostIqd: number; scrappedCostIqd: number; cogsPosted: boolean },
): BatchStatement[] {
  const lines: JournalLineSpec[] = input.cogsPosted
    ? [
        { accountCode: "inventory", debitIqd: input.restockedCostIqd },
        { accountCode: "inventory_adjustments", debitIqd: input.scrappedCostIqd },
        { accountCode: "cogs", creditIqd: input.restockedCostIqd + input.scrappedCostIqd },
      ]
    : [
        { accountCode: "inventory_adjustments", debitIqd: input.scrappedCostIqd },
        { accountCode: "inventory", creditIqd: input.scrappedCostIqd },
      ];
  return journalStatements(db, {
    at: input.at,
    memo: `Returned goods, order ${input.ref}`,
    refType: input.refType,
    refId: input.refId,
    createdBy: input.createdBy,
    idempotencyKey: returnedGoodsPostingKey(input.key),
    isDemo: input.isDemo,
    lines,
  });
}

// ───────────────────────────────────────────────────────────────── wallet and stock

/** A wallet top-up approved by staff: Dr the account the money arrived in, Cr wallet liability. */
export function postWalletTopup(db: Db, input: PostingContext & { ledgerEntryId: string; customerId: string; amountIqd: number; fundedBy: "cash" | "bank_clearing" }): BatchStatement[] {
  return postWalletCredit(db, { ...input, debitAccount: input.fundedBy, memo: "Wallet top-up" });
}

/**
 * Any other wallet credit: Dr `debitAccount` (inventory for trade-in credit, operating expenses for
 * a goodwill adjustment…), Cr wallet liability.
 */
export function postWalletCredit(
  db: Db,
  input: PostingContext & { ledgerEntryId: string; customerId: string; amountIqd: number; debitAccount: SystemAccountKey; memo?: string },
): BatchStatement[] {
  return journalStatements(db, {
    at: input.at,
    memo: input.memo ?? "Wallet credit",
    refType: "wallet_ledger",
    refId: input.ledgerEntryId,
    createdBy: input.createdBy,
    idempotencyKey: walletCreditPostingKey(input.ledgerEntryId),
    isDemo: input.isDemo,
    lines: [
      { accountCode: input.debitAccount, debitIqd: input.amountIqd },
      { accountCode: "wallet_liability", creditIqd: input.amountIqd },
    ],
  });
}

/**
 * Money paid OUT of a customer's wallet (since 2026-11-12 — wallet.server.ts decideWalletPayout: an erasure, an account
 * closed): Dr wallet liability, Cr where the money leaves from (cash handed over, or a bank transfer). The opposite of
 * postWalletCredit; keyed per ledger row like it (`wallet:<ledger id>`).
 */
export function postWalletDebit(
  db: Db,
  input: PostingContext & { ledgerEntryId: string; customerId: string; amountIqd: number; creditAccount: "cash" | "bank_clearing"; memo?: string },
): BatchStatement[] {
  return journalStatements(db, {
    at: input.at,
    memo: input.memo ?? "Wallet paid out",
    refType: "wallet_ledger",
    refId: input.ledgerEntryId,
    createdBy: input.createdBy,
    idempotencyKey: walletCreditPostingKey(input.ledgerEntryId),
    isDemo: input.isDemo,
    lines: [
      { accountCode: "wallet_liability", debitIqd: input.amountIqd },
      { accountCode: input.creditAccount, creditIqd: input.amountIqd },
    ],
  });
}

/**
 * Goods received into stock at landed cost [P]: Dr inventory, Cr what pays for them (accounts
 * payable for a supplier invoice, cash or bank clearing when paid at once, owner equity for an
 * opening balance). For the purchasing module; receiveStock() does not post by itself.
 */
export function postStockReceipt(
  db: Db,
  input: PostingContext & { refType: string; refId: string; amountIqd: number; creditAccount: "accounts_payable" | "cash" | "bank_clearing" | "owner_equity"; memo?: string },
): BatchStatement[] {
  return journalStatements(db, {
    at: input.at,
    memo: input.memo ?? "Stock received",
    refType: input.refType,
    refId: input.refId,
    createdBy: input.createdBy,
    idempotencyKey: `${input.refType}:${input.refId}:receipt`,
    isDemo: input.isDemo,
    lines: [
      { accountCode: "inventory", debitIqd: input.amountIqd },
      { accountCode: input.creditAccount, creditIqd: input.amountIqd },
    ],
  });
}

/** `created_by` for a posting: the employee's id, or "system:<job>" / "customer:<id>" for the others. */
export function postedBy(actor: { kind: string; id?: string; job?: string }): string | null {
  if (actor.kind === "employee") return actor.id ?? null;
  if (actor.kind === "system") return `system:${actor.job ?? "unknown"}`;
  if (actor.kind === "customer") return `customer:${actor.id ?? ""}`;
  return "guest";
}
