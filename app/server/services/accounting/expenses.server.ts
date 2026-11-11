/**
 * Operating expenses through the accounting core (blueprint 10.05; schema `expenses`, `cost_centers`). Added by admin
 * 10 finance on 2026-11-11 as a commerce-core file (CONTRACTS.md §1); tests: tests/admin-finance-core.test.ts.
 *
 *   const { expenseId } = await createExpense(db, actor, { accountId, paidFromAccountId, costCenter, amountIqd, vendor,
 *     description, incurredOn: "2026-11-09", idempotencyKey }, now);                         // a draft: not in the books
 *   await approveExpense(db, actor, { expenseId }, now);                                     // posted: one journal entry
 *   await voidExpense(db, actor, { expenseId, reason }, now);                                // a draft is dropped; a posted
 *                                                                                            // one is reversed (open month)
 *
 * RULES
 *   · finance.expense.manage for every call; the services check it before reading the input.
 *   · A draft is not in the books. Approving posts ONE entry in the same batch as the status change: Dr the expense
 *     account (with the cost centre on that line), Cr where the money came from (cash, bank clearing, accounts
 *     payable for a bill not paid yet, owner's equity when the owner paid personally, or an accountant's own account
 *     of those kinds). Idempotency key "expense:<id>:posted"; the status update is guarded (draft → posted), so a
 *     double click or two approvers at once post once.
 *   · Four eyes above EXPENSE_SECOND_APPROVAL_ABOVE_IQD: whoever recorded the expense cannot approve it
 *     (expense_self_approval, 403). At or below it, the person who recorded it may post it — but what one person
 *     records AND approves alone counts together over 24 hours (SELF_APPROVAL_WINDOW_MS), so the limit cannot be
 *     split into small expenses; a guard inside the posting batch holds it when two tabs approve at once.
 *   · The entry is dated at noon (Baghdad) of the day the expense was incurred — never later than now — so it lands
 *     in that month; a closed month refuses it (period_closed): void the draft and record it in an open month. A
 *     closed month is final for everything before it as well: nothing is dated on or before the last closed month
 *     (an earlier month left open would otherwise change the closed month's closing balances).
 *   · Voiding a posted expense never edits the books: a reversing entry dated now (an open month) with
 *     `reverses_id` = the original ("expense:<id>:void"), in the same batch as the status change (posted → void).
 *   · The cost of goods, stock write-offs and cash over/short are posted by their own flows, never as expenses; the
 *     wallet, customer control and inventory accounts cannot pay for one.
 *   · Creation is idempotent: the key decides the expense id, so a resubmitted form returns the first expense.
 *
 * Errors (AppError, texts in admin-finance → errors.*): invalid (400, fields: amountIqd, accountId,
 * paidFromAccountId, costCenter, incurredOn: expense_date_future | invalid, description, reason), forbidden /
 * expense_self_approval (403), not_found (404), expense_not_draft, expense_not_posted, expense_account_invalid,
 * expense_paid_from_invalid, cost_center_invalid, period_closed, idempotency_mismatch (409).
 * Must not import "cloudflare:workers".
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { fiscalPeriodOf } from "~/server/db/journal.server";
import { costCenters, expenses, journalEntries, type Expense, type SystemAccountKey } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { journalStatements, mapPostingError, postedBy } from "./post.server";
import { chartOfAccounts, isLockedPeriod, openPeriodGuard, systemRoots, type ChartAccount } from "./reports.server";

/** Asia/Baghdad is UTC+3 all year. */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" of an instant in Baghdad. */
function baghdadDay(at: number): string {
  return new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

/** A real calendar day "YYYY-MM-DD" (2000–2100). */
function isDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

/** Noon in Baghdad of a day: the moment an expense of that day is booked at. */
export function expenseInstant(day: string): number {
  const match = DAY_PATTERN.exec(day);
  if (!match) throw new Error(`expenseInstant: not a day: ${day}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) - BAGHDAD_OFFSET_MS;
}
const dayNoon = expenseInstant;
const periodOf = fiscalPeriodOf;

export const EXPENSE_ERROR_KEYS = [
  "expense_not_draft",
  "expense_not_posted",
  "expense_self_approval",
  "expense_account_invalid",
  "expense_paid_from_invalid",
  "cost_center_invalid",
  "expense_date_future",
  "period_closed",
  "idempotency_mismatch",
] as const;

/**
 * Above this amount the person who recorded an expense cannot approve it — the DEFAULT of the setting
 * "finance.expense_second_approval_iqd" (admin 22), which the services read (expenseApprovalLimit).
 */
export const EXPENSE_SECOND_APPROVAL_ABOVE_IQD = 500_000;

/** The limit in force: the setting "finance.expense_second_approval_iqd" (EXPENSE_SECOND_APPROVAL_ABOVE_IQD until changed). */
export function expenseApprovalLimit(db: Db): Promise<number> {
  return getSetting(db, "finance.expense_second_approval_iqd");
}
/** What one person records and approves alone counts together over this window against the limit. */
export const SELF_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The largest single expense the form accepts (1 bn IQD). */
export const MAX_EXPENSE_IQD = 1_000_000_000;

/** Expense families that are posted by their own flows, never as an expense. */
const NOT_EXPENSES: readonly SystemAccountKey[] = ["cogs", "inventory_adjustments", "cash_over_short"];
/** System families an expense may be paid from. */
const PAID_FROM: readonly SystemAccountKey[] = ["cash", "bank_clearing", "accounts_payable", "owner_equity"];

/** Accounts an expense may be booked to (active expense accounts outside the stock and cash-count families). */
export function expenseAccounts(chart: readonly ChartAccount[]): ChartAccount[] {
  const roots = systemRoots(chart);
  return chart.filter((account) => account.isActive && account.type === "expense" && !NOT_EXPENSES.includes(roots.get(account.id) as SystemAccountKey));
}

/** Accounts an expense may be paid from: cash, bank, payables, the owner — or an accountant's own of those kinds. */
export function paidFromAccounts(chart: readonly ChartAccount[]): ChartAccount[] {
  const roots = systemRoots(chart);
  return chart.filter((account) => {
    if (!account.isActive) return false;
    const root = roots.get(account.id) ?? null;
    if (root) return PAID_FROM.includes(root);
    return account.type === "asset" || account.type === "liability" || account.type === "equity";
  });
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const COST_CENTER = /^[A-Z0-9][A-Z0-9-]{1,15}$/;

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);

export const CreateExpenseInput = z.object({
  accountId: z.string({ error: "required" }).regex(ID, "expense_account_invalid"),
  paidFromAccountId: z.string({ error: "required" }).regex(ID, "expense_paid_from_invalid"),
  costCenter: z.preprocess(blankToUndefined, z.string().trim().toUpperCase().regex(COST_CENTER, "cost_center_invalid").optional()),
  amountIqd: z.number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") }).int("invalid").min(1, "too_small").max(MAX_EXPENSE_IQD, "too_big"),
  vendor: z.preprocess(blankToUndefined, z.string().trim().max(120, "too_long").optional()),
  description: z.string({ error: "required" }).trim().min(3, "required").max(300, "too_long"),
  incurredOn: z.string({ error: "required" }).refine((value) => isDay(value), "invalid"),
  receiptFileId: z.preprocess(blankToUndefined, z.string().regex(ID, "invalid").optional()),
  refType: z.preprocess(blankToUndefined, z.string().trim().max(40, "too_long").optional()),
  refId: z.preprocess(blankToUndefined, z.string().trim().max(120, "too_long").optional()),
  idempotencyKey: z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid"),
});
export type CreateExpenseInput = z.input<typeof CreateExpenseInput>;

const ReasonInput = z.object({
  expenseId: z.string().regex(ID, "invalid"),
  reason: z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long"),
});
const ApproveInput = z.object({
  expenseId: z.string().regex(ID, "invalid"),
  note: z.preprocess(blankToUndefined, z.string().trim().max(500, "too_long").optional()),
});

/** Σ of the posted expenses `employeeId` recorded AND approved alone in the 24 hours before `now`. */
export async function selfApprovedRecentIqd(db: Db, employeeId: string | null, now: number): Promise<number> {
  if (!employeeId) return 0;
  const rows = await db.all<{ total: number }>(sql`
    SELECT coalesce(sum(amount_iqd), 0) AS total FROM expenses
    WHERE status = 'posted' AND created_by = ${employeeId} AND approved_by = ${employeeId} AND approved_at > ${now - SELF_APPROVAL_WINDOW_MS}`);
  return Number(rows[0]?.total ?? 0);
}

/**
 * Whether `approverId` must leave this draft to someone else: they recorded it, and its amount together with what
 * they recorded and approved alone in the last 24 hours (`recentSelfIqd`) is above the limit.
 */
export function needsOtherApprover(expense: Pick<Expense, "amountIqd" | "createdBy">, approverId: string | null, recentSelfIqd: number, limitIqd: number = EXPENSE_SECOND_APPROVAL_ABOVE_IQD): boolean {
  return Boolean(approverId) && expense.createdBy === approverId && expense.amountIqd + recentSelfIqd > limitIqd;
}

async function loadExpense(db: Db, expenseId: string): Promise<Expense> {
  const row = await db.select().from(expenses).where(eq(expenses.id, expenseId)).get();
  if (!row) throw notFound("expense");
  return row;
}

/** The id an idempotency key gives an expense: a resubmitted form finds the first one. */
export async function expenseIdFor(idempotencyKey: string): Promise<string> {
  return `exp_${(await sha256Hex(`expense:${idempotencyKey}`)).slice(0, 26)}`;
}

/**
 * Records an expense as a draft (not in the books yet). Idempotent on `idempotencyKey`: the same key returns the
 * first expense (`replayed: true`); the same key with a different amount or account is idempotency_mismatch.
 */
export async function createExpense(db: Db, actor: Actor, raw: CreateExpenseInput, now: number, options: { demo?: boolean } = {}): Promise<{ expenseId: string; replayed: boolean }> {
  assertCan(actor, "finance.expense.manage");
  const input = CreateExpenseInput.parse(raw);
  const expenseId = await expenseIdFor(input.idempotencyKey);

  const replay = async () => {
    const existing = await db.select().from(expenses).where(eq(expenses.id, expenseId)).get();
    if (!existing) return null;
    if (existing.amountIqd !== input.amountIqd || existing.accountId !== input.accountId || existing.paidFromAccountId !== input.paidFromAccountId) throw new AppError("idempotency_mismatch", 409);
    return { expenseId, replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  if (input.incurredOn > baghdadDay(now)) throw new AppError("invalid", 400, { fields: { incurredOn: "expense_date_future" } });
  const chart = await chartOfAccounts(db);
  if (!expenseAccounts(chart).some((account) => account.id === input.accountId)) throw new AppError("expense_account_invalid", 409, { fields: { accountId: "expense_account_invalid" } });
  if (!paidFromAccounts(chart).some((account) => account.id === input.paidFromAccountId)) throw new AppError("expense_paid_from_invalid", 409, { fields: { paidFromAccountId: "expense_paid_from_invalid" } });
  if (input.costCenter) {
    const center = await db.select({ isActive: costCenters.isActive }).from(costCenters).where(eq(costCenters.code, input.costCenter)).get();
    if (!center?.isActive) throw new AppError("cost_center_invalid", 409, { fields: { costCenter: "cost_center_invalid" } });
  }
  const period = periodOf(dayNoon(input.incurredOn));
  if (await isLockedPeriod(db, period)) throw new AppError("period_closed", 409, { fields: { incurredOn: "period_closed" }, detail: period });

  const createdBy = postedBy(actor);
  try {
    await runBatch(db, [
      db.insert(expenses).values({
        id: expenseId,
        accountId: input.accountId,
        paidFromAccountId: input.paidFromAccountId,
        costCenter: input.costCenter ?? null,
        amountIqd: input.amountIqd,
        vendor: input.vendor ?? null,
        description: input.description,
        incurredOn: input.incurredOn,
        period,
        receiptFileId: input.receiptFileId ?? null,
        status: "draft",
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        isDemo: options.demo ?? false,
        createdBy,
        createdAt: now,
      }),
      auditStatement(db, {
        actor,
        action: "finance.expense.create",
        entityType: "expense",
        entityId: expenseId,
        after: { accountId: input.accountId, paidFromAccountId: input.paidFromAccountId, costCenter: input.costCenter ?? null, amountIqd: input.amountIqd, vendor: input.vendor ?? null, incurredOn: input.incurredOn },
        reason: input.description,
        at: now,
      }),
    ]);
  } catch (error) {
    const raced = await replay().catch(() => null);
    if (raced) return raced;
    throw error;
  }
  return { expenseId, replayed: false };
}

/**
 * Approves a draft and posts it to the journal, in one batch. A repeat (or a second approver at the same moment)
 * returns `replayed: true` with the entry already posted.
 */
export async function approveExpense(db: Db, actor: Actor, raw: { expenseId: string; note?: string | null }, now: number): Promise<{ status: "posted"; entryId: string; replayed: boolean }> {
  assertCan(actor, "finance.expense.manage");
  const input = ApproveInput.parse(raw);
  const expense = await loadExpense(db, input.expenseId);
  if (expense.status === "posted" && expense.journalEntryId) return { status: "posted", entryId: expense.journalEntryId, replayed: true };
  if (expense.status !== "draft") throw new AppError("expense_not_draft", 409);
  const me = postedBy(actor);
  const selfApproval = Boolean(me) && expense.createdBy === me;
  const limitIqd = await expenseApprovalLimit(db);
  if (selfApproval && needsOtherApprover(expense, me, await selfApprovedRecentIqd(db, me, now), limitIqd)) throw new AppError("expense_self_approval", 403);

  const chart = await chartOfAccounts(db);
  if (!expenseAccounts(chart).some((account) => account.id === expense.accountId)) throw new AppError("expense_account_invalid", 409);
  if (!expense.paidFromAccountId || !paidFromAccounts(chart).some((account) => account.id === expense.paidFromAccountId)) throw new AppError("expense_paid_from_invalid", 409);
  if (expense.costCenter) {
    const center = await db.select({ isActive: costCenters.isActive }).from(costCenters).where(eq(costCenters.code, expense.costCenter)).get();
    if (!center?.isActive) throw new AppError("cost_center_invalid", 409);
  }

  const entryId = newId("je");
  const at = Math.min(dayNoon(expense.incurredOn), now);
  if (await isLockedPeriod(db, periodOf(at))) throw new AppError("period_closed", 409, { detail: periodOf(at) });
  const statements: BatchStatement[] = [
    db
      .update(expenses)
      .set({ status: "posted", approvedBy: me, approvedAt: now, journalEntryId: entryId })
      .where(and(eq(expenses.id, expense.id), eq(expenses.status, "draft"))),
    expectChanged(db, 1, { code: "EXPENSE_NOT_DRAFT", detail: expense.id }),
    openPeriodGuard(db, periodOf(at)),
    // two tabs approving two of one's own small expenses at once: the limit holds inside the batch too
    ...(selfApproval
      ? [
          expectThat(
            db,
            sql`(SELECT coalesce(sum(amount_iqd), 0) FROM expenses WHERE status = 'posted' AND created_by = ${me} AND approved_by = ${me} AND approved_at > ${now - SELF_APPROVAL_WINDOW_MS}) <= ${limitIqd}`,
            { code: "EXPENSE_SELF_LIMIT", detail: expense.id },
          ),
        ]
      : []),
    ...journalStatements(db, {
      id: entryId,
      at,
      memo: `Expense: ${expense.description}${expense.vendor ? ` (${expense.vendor})` : ""}`.slice(0, 300),
      refType: "expense",
      refId: expense.id,
      createdBy: me,
      idempotencyKey: `expense:${expense.id}:posted`,
      isDemo: expense.isDemo,
      lines: [
        { accountId: expense.accountId, debitIqd: expense.amountIqd, costCenter: expense.costCenter, memo: expense.vendor },
        { accountId: expense.paidFromAccountId, creditIqd: expense.amountIqd },
      ],
    }),
    auditStatement(db, {
      actor,
      action: "finance.expense.approve",
      entityType: "expense",
      entityId: expense.id,
      before: { status: "draft" },
      after: { status: "posted", journalEntryId: entryId, amountIqd: expense.amountIqd, period: periodOf(at) },
      reason: input.note ?? null,
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    const posting = mapPostingError(error);
    if (posting?.code === "period_closed") throw posting;
    const info = mapDbError(error);
    if (info?.code === "EXPENSE_SELF_LIMIT") throw new AppError("expense_self_approval", 403);
    if (info?.code === "EXPENSE_NOT_DRAFT" || posting?.code === "already_posted") {
      const current = await loadExpense(db, expense.id);
      if (current.status === "posted" && current.journalEntryId) return { status: "posted", entryId: current.journalEntryId, replayed: true };
      throw new AppError("expense_not_draft", 409);
    }
    throw error;
  }
  return { status: "posted", entryId, replayed: false };
}

/**
 * Voids an expense: a draft is simply dropped; a posted one is reversed by a new entry dated now (the original
 * stays in its month). A repeat returns `replayed: true`.
 */
export async function voidExpense(db: Db, actor: Actor, raw: { expenseId: string; reason: string }, now: number): Promise<{ status: "void"; reversalId: string | null; replayed: boolean }> {
  assertCan(actor, "finance.expense.manage");
  const input = ReasonInput.parse(raw);
  const expense = await loadExpense(db, input.expenseId);
  if (expense.status === "void") return { status: "void", reversalId: null, replayed: true };
  const me = postedBy(actor);

  if (expense.status !== "posted") {
    await runBatch(db, [
      db.update(expenses).set({ status: "void" }).where(and(eq(expenses.id, expense.id), inArray(expenses.status, ["draft", "approved"]))),
      expectChanged(db, 1, { code: "EXPENSE_NOT_DRAFT", detail: expense.id }),
      auditStatement(db, { actor, action: "finance.expense.void", entityType: "expense", entityId: expense.id, before: { status: expense.status }, after: { status: "void" }, reason: input.reason, at: now }),
    ]).catch(async (error) => {
      if (mapDbError(error)?.code === "EXPENSE_NOT_DRAFT") {
        const current = await loadExpense(db, expense.id);
        if (current.status === "void") return;
        throw new AppError("expense_not_draft", 409);
      }
      throw error;
    });
    return { status: "void", reversalId: null, replayed: false };
  }

  if (!expense.journalEntryId || !expense.paidFromAccountId) throw new AppError("expense_not_posted", 409);
  const original = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.id, expense.journalEntryId)).get();
  if (!original) throw new AppError("expense_not_posted", 409);
  const reversalId = newId("je");
  try {
    await runBatch(db, [
      db.update(expenses).set({ status: "void" }).where(and(eq(expenses.id, expense.id), eq(expenses.status, "posted"))),
      expectChanged(db, 1, { code: "EXPENSE_NOT_POSTED", detail: expense.id }),
      ...journalStatements(db, {
        id: reversalId,
        at: now,
        memo: `Void of expense: ${expense.description} — ${input.reason}`.slice(0, 300),
        refType: "expense",
        refId: expense.id,
        createdBy: me,
        reversesId: expense.journalEntryId,
        idempotencyKey: `expense:${expense.id}:void`,
        isDemo: expense.isDemo,
        lines: [
          { accountId: expense.paidFromAccountId, debitIqd: expense.amountIqd },
          { accountId: expense.accountId, creditIqd: expense.amountIqd, costCenter: expense.costCenter, memo: expense.vendor },
        ],
      }),
      auditStatement(db, {
        actor,
        action: "finance.expense.void",
        entityType: "expense",
        entityId: expense.id,
        before: { status: "posted", journalEntryId: expense.journalEntryId },
        after: { status: "void", reversalId },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    const posting = mapPostingError(error);
    if (posting?.code === "period_closed") throw posting;
    if (mapDbError(error)?.code === "EXPENSE_NOT_POSTED" || posting?.code === "already_posted") {
      const current = await loadExpense(db, expense.id);
      if (current.status === "void") return { status: "void", reversalId: null, replayed: true };
      throw new AppError("expense_not_posted", 409);
    }
    throw error;
  }
  return { status: "void", reversalId, replayed: false };
}
