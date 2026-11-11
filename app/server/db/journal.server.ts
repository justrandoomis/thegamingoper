/**
 * Posting to the double-entry journal.
 *
 * The database only accepts a journal entry whose lines are written BEFORE its header, in the same
 * batch (see schema/accounting.ts): the header insert validates the balance and seals the entry.
 * journalEntryStatements() builds the statements in that order and checks the entry up front, so a
 * programming mistake fails here with a clear message instead of as a trigger error:
 *
 *   await runBatch(db, [
 *     …business statements…,
 *     ...journalEntryStatements(db, {
 *       id: newId("je"), at: now, memo: "Order TT-7K4M2Q9X delivered",
 *       refType: "order", refId: order.id, idempotencyKey: `order:${order.id}:delivered`,
 *       lines: [
 *         { accountId: accountId("cod_receivable"), debitIqd: 754_000 },
 *         { accountId: accountId("sales_revenue"), creditIqd: 749_000 },
 *         { accountId: accountId("shipping_income"), creditIqd: 5_000 },
 *       ],
 *     }),
 *   ]);
 *
 * Database errors you can still get (map them with mapDbError):
 *   TT:PERIOD_CLOSED:<period>   the month is closed — post a reversal in an open period instead
 *   UNIQUE journal_entries.idempotency_key   this business event was already posted (retry / webhook replay)
 *   UNIQUE journal_entries.reverses_id       the entry was already reversed
 */
import type { BatchStatement, Db } from "./drizzle.server";
import { journalEntries, journalLines, type NewJournalLine } from "./schema";
import { chunkRows } from "./tx.server";

/** Asia/Baghdad is UTC+3 all year (no daylight saving). */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;

/** The fiscal period ("YYYY-MM", Asia/Baghdad) an instant belongs to. */
export function fiscalPeriodOf(at: number): string {
  return new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 7);
}

export type JournalLineInput = {
  accountId: string;
  /** Exactly one of debitIqd / creditIqd, a positive integer. */
  debitIqd?: number;
  creditIqd?: number;
  costCenter?: string | null;
  memo?: string | null;
};

export type JournalEntryInput = {
  id: string;
  at: number;
  /** Defaults to the Asia/Baghdad month of `at`. */
  period?: string;
  memo?: string | null;
  refType?: string | null;
  refId?: string | null;
  createdBy?: string | null;
  /** Set when this entry reverses another one (its lines must mirror the original). */
  reversesId?: string | null;
  /** One posting per business event, e.g. "order:<id>:delivered". */
  idempotencyKey?: string | null;
  isDemo?: boolean;
  lines: JournalLineInput[];
};

export class JournalEntryError extends Error {
  constructor(
    readonly code: "JOURNAL_UNBALANCED" | "JOURNAL_INVALID_LINE",
    message: string,
  ) {
    super(message);
    this.name = "JournalEntryError";
  }
}

/** Throws JournalEntryError unless the lines form a valid, balanced entry. Returns the entry total. */
export function assertBalanced(lines: readonly JournalLineInput[]): number {
  if (lines.length < 2) throw new JournalEntryError("JOURNAL_UNBALANCED", "A journal entry needs at least two lines.");
  let debit = 0;
  let credit = 0;
  lines.forEach((line, index) => {
    const d = line.debitIqd ?? 0;
    const c = line.creditIqd ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) {
      throw new JournalEntryError("JOURNAL_INVALID_LINE", `Journal line ${index + 1} must have exactly one positive integer side (debit ${d}, credit ${c}).`);
    }
    debit += d;
    credit += c;
  });
  if (debit !== credit) throw new JournalEntryError("JOURNAL_UNBALANCED", `Journal entry does not balance: debit ${debit} ≠ credit ${credit}.`);
  return debit;
}

/**
 * Statements that post one journal entry: the lines first, the sealing header last.
 * Spread them into the batch of the business operation they belong to.
 */
export function journalEntryStatements(db: Db, entry: JournalEntryInput): BatchStatement[] {
  assertBalanced(entry.lines);
  const lineRows: NewJournalLine[] = entry.lines.map((line, index) => ({
    id: `${entry.id}.${index + 1}`,
    entryId: entry.id,
    accountId: line.accountId,
    debitIqd: line.debitIqd ?? 0,
    creditIqd: line.creditIqd ?? 0,
    costCenter: line.costCenter ?? null,
    memo: line.memo ?? null,
  }));
  return [
    ...chunkRows(journalLines, lineRows).map((rows) => db.insert(journalLines).values(rows)),
    db.insert(journalEntries).values({
      id: entry.id,
      at: entry.at,
      period: entry.period ?? fiscalPeriodOf(entry.at),
      memo: entry.memo ?? null,
      refType: entry.refType ?? null,
      refId: entry.refId ?? null,
      createdBy: entry.createdBy ?? null,
      reversesId: entry.reversesId ?? null,
      idempotencyKey: entry.idempotencyKey ?? null,
      isDemo: entry.isDemo ?? false,
    }),
  ];
}
