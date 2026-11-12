/**
 * Payroll postings — how wages, salaries, bonuses, commissions and salary advances reach the books (admin module 15
 * "staff", docs/CONTRACTS.md §1). Added by admin 15 on 2026-11-11 as a commerce-core file: like the standard
 * postings of ./post.server.ts these builders are SYNCHRONOUS and return batch statements, so a posting is written in
 * the same db.batch as the business change it describes (the run turning `paid`, the advance being handed out) — both
 * are stored or neither is. They go through journalStatements(): balanced or it throws before touching the database,
 * one posting per business event (deterministic `idempotency_key`), a closed month refused by the database
 * (TT:PERIOD_CLOSED → "period_closed" through mapPostingError).
 *
 *   await runBatch(db, [
 *     …the run's guarded status change, the commissions marked paid, the advances settled…,
 *     ...postPayrollRun(db, { runId, ref, period, paidFrom: "bank_clearing", totals, at: now, createdBy, isDemo }),
 *   ]);
 *
 * What is booked (the chart has no "salaries payable" and no "advances to employees" account — CONTRACTS §1 lists the
 * request — so pay is booked when it is paid out):
 *
 *   salary advance handed out     Dr payroll [6300]                       Cr cash [1000] | bank clearing [1010]
 *   payroll run paid              Dr payroll    base + bonus − advances deducted − other deductions   (Cr when < 0)
 *                                 Dr commissions [6200]   commissions of the run, net of returns     (Cr when < 0)
 *                                 Cr cash | bank clearing   the net pay
 *
 * An advance is pay handed out early: it is a payroll expense when it leaves the drawer, and the run that deducts it
 * books it back, so over the advance and its run the payroll account carries exactly base + bonus − other deductions
 * and the cash accounts exactly what the employees received. Commissions land on their own account, which is what the
 * profit definition subtracts (docs/metrics.md §4, "Commissions") — in the month the run pays them.
 *
 * Errors: none of its own; a posting the database refuses surfaces as `period_closed` / `already_posted` through
 * mapPostingError (./post.server.ts). An inconsistent total (net ≠ base + commission + bonus − deductions) is a bug of
 * the caller and throws PayrollPostingError before anything is written.
 */
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { journalStatements, type JournalLineSpec, type PostingContext } from "./post.server";

/** Where pay leaves from: the cash drawer or the bank. */
export const PAYROLL_PAID_FROM = ["cash", "bank_clearing"] as const;
export type PayrollPaidFrom = (typeof PAYROLL_PAID_FROM)[number];

export const payrollRunPostingKey = (runId: string) => `payroll_run:${runId}:paid`;
export const advancePostingKey = (advanceId: string) => `staff_advance:${advanceId}:paid`;

/** The money of a run, summed over its items. Every figure is integer IQD; only the commission may be negative (returns). */
export type PayrollRunTotals = {
  baseIqd: number;
  bonusIqd: number;
  /** Commissions of the run net of clawbacks for returns — negative when returns outweigh new commissions. */
  commissionIqd: number;
  advanceDeductionIqd: number;
  otherDeductionIqd: number;
  netIqd: number;
};

export class PayrollPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollPostingError";
  }
}

function whole(name: string, value: number, signed = false): number {
  if (!Number.isSafeInteger(value)) throw new PayrollPostingError(`${name} is not a whole number of dinars: ${value}`);
  if (!signed && value < 0) throw new PayrollPostingError(`${name} is negative: ${value}`);
  return value;
}

/** A signed amount on an expense account: positive is a debit, negative a credit. */
function expenseLine(accountCode: "payroll" | "commissions", amountIqd: number): JournalLineSpec {
  return amountIqd >= 0 ? { accountCode, debitIqd: amountIqd } : { accountCode, creditIqd: -amountIqd };
}

/**
 * The journal lines of a paid run (pure; zero lines are dropped by journalStatements). Throws PayrollPostingError when
 * the totals do not add up: net = base + commission + bonus − advance deductions − other deductions, net ≥ 0.
 */
export function payrollRunLines(totals: PayrollRunTotals, paidFrom: PayrollPaidFrom): JournalLineSpec[] {
  const base = whole("baseIqd", totals.baseIqd);
  const bonus = whole("bonusIqd", totals.bonusIqd);
  const commission = whole("commissionIqd", totals.commissionIqd, true);
  const advance = whole("advanceDeductionIqd", totals.advanceDeductionIqd);
  const other = whole("otherDeductionIqd", totals.otherDeductionIqd);
  const net = whole("netIqd", totals.netIqd);
  if (base + commission + bonus - advance - other !== net) throw new PayrollPostingError(`net ${net} ≠ base ${base} + commission ${commission} + bonus ${bonus} − advances ${advance} − other ${other}`);
  if (!PAYROLL_PAID_FROM.includes(paidFrom)) throw new PayrollPostingError(`unknown paying account ${String(paidFrom)}`);
  return [expenseLine("payroll", base + bonus - advance - other), expenseLine("commissions", commission), { accountCode: paidFrom, creditIqd: net }];
}

/** A payroll run paid out: one entry (its id = entryId when given), key "payroll_run:<id>:paid", ref "payroll_run"; [] when every line is 0. */
export function postPayrollRun(db: Db, input: PostingContext & { entryId?: string; runId: string; ref: string; period: string; paidFrom: PayrollPaidFrom; totals: PayrollRunTotals }): BatchStatement[] {
  return journalStatements(db, {
    id: input.entryId,
    at: input.at,
    memo: `Payroll ${input.period} (${input.ref})`,
    refType: "payroll_run",
    refId: input.runId,
    createdBy: input.createdBy,
    idempotencyKey: payrollRunPostingKey(input.runId),
    isDemo: input.isDemo,
    lines: payrollRunLines(input.totals, input.paidFrom),
  });
}

/** A salary advance handed out: Dr payroll, Cr where the money left from; key "staff_advance:<id>:paid". */
export function postEmployeeAdvance(db: Db, input: PostingContext & { entryId?: string; advanceId: string; amountIqd: number; paidFrom: PayrollPaidFrom; memo?: string }): BatchStatement[] {
  const amount = whole("amountIqd", input.amountIqd);
  if (amount === 0) throw new PayrollPostingError("an advance of 0");
  if (!PAYROLL_PAID_FROM.includes(input.paidFrom)) throw new PayrollPostingError(`unknown paying account ${String(input.paidFrom)}`);
  return journalStatements(db, {
    id: input.entryId,
    at: input.at,
    memo: input.memo ?? "Salary advance",
    refType: "staff_advance",
    refId: input.advanceId,
    createdBy: input.createdBy,
    idempotencyKey: advancePostingKey(input.advanceId),
    isDemo: input.isDemo,
    lines: [
      { accountCode: "payroll", debitIqd: amount },
      { accountCode: input.paidFrom, creditIqd: amount },
    ],
  });
}
