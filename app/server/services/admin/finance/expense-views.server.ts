/**
 * Admin 10.05 — the screens' side of expenses and cost centres (finance.expense.manage). Writing an expense, posting
 * and voiding it are the accounting core's (accounting/expenses.server.ts); this file lists them, prepares the form
 * and keeps the cost centres (a code that never changes once used — journal lines keep it — and a name).
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { L10n, Locale } from "~/lib/locales";
import { pick } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { costCenters, expenses } from "~/server/db/schema";
import { mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { expenseAccounts, expenseApprovalLimit, needsOtherApprover, paidFromAccounts, selfApprovedRecentIqd } from "~/server/services/accounting/expenses.server";
import { postedBy } from "~/server/services/accounting/post.server";
import { chartOfAccounts } from "~/server/services/accounting/reports.server";
import { employeeNames } from "./shared.server";
import { latinDigits, PAGE_SIZE, periodOf, type RangeFilter } from "./types";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const num = (value: unknown) => Number(value ?? 0);

function requireExpenses(actor: Actor): void {
  assertCan(actor, "finance.expense.manage");
}

export type ExpenseFilters = RangeFilter & { status: "draft" | "posted" | "void" | null; account: string | null; center: string | null; page: number };

export type ExpenseRow = {
  id: string;
  incurredOn: string;
  accountId: string;
  account: string;
  paidFrom: string | null;
  costCenter: string | null;
  amountIqd: number;
  vendor: string | null;
  description: string;
  status: "draft" | "approved" | "posted" | "void";
  createdBy: string | null;
  approvedBy: string | null;
  createdAt: number;
  approvedAt: number | null;
  journalEntryId: string | null;
  isDemo: boolean;
  /** This employee recorded it, and its amount — with what they recorded and approved alone in the last 24 hours —
   *  is above the limit: someone else must approve it. */
  needsOther: boolean;
  hasReceipt: boolean;
};

export type ExpensePage = {
  rows: ExpenseRow[];
  total: number;
  page: number;
  pageCount: number;
  demoHidden: number;
  totals: { status: string; count: number; iqd: number }[];
  byAccount: { accountId: string; account: string; iqd: number }[];
  byCenter: { code: string | null; name: string | null; iqd: number }[];
  threshold: number;
  /** What this employee recorded and approved alone in the last 24 hours (it counts against the limit). */
  selfApprovedIqd: number;
};

function expenseWhere(filters: ExpenseFilters, withDemo: boolean): SQL {
  const parts: SQL[] = [sql`x.incurred_on >= ${filters.from}`, sql`x.incurred_on <= ${filters.to}`];
  if (!withDemo) parts.push(sql`x.is_demo = 0`);
  if (filters.account) parts.push(sql`x.account_id = ${filters.account}`);
  if (filters.center) parts.push(filters.center === "none" ? sql`x.cost_center IS NULL` : sql`x.cost_center = ${filters.center}`);
  return sql.join(parts, sql` AND `);
}

/** Expenses incurred in the range (newest first) with totals by status, account and cost centre (posted only). */
export async function listExpenses(db: Db, actor: Actor, filters: ExpenseFilters, locale: Locale, now: number = Date.now()): Promise<ExpensePage> {
  requireExpenses(actor);
  const selfApprovedIqd = await selfApprovedRecentIqd(db, postedBy(actor), now);
  const threshold = await expenseApprovalLimit(db);
  const base = expenseWhere(filters, filters.demo);
  const where = filters.status ? sql`${base} AND x.status = ${filters.status}` : base;
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, count, hidden, totals, byAccount, byCenter, chart, centers] = await Promise.all([
    db.all<{
      id: string;
      incurredOn: string;
      accountId: string;
      paidFromAccountId: string | null;
      costCenter: string | null;
      amount: number;
      vendor: string | null;
      description: string;
      status: ExpenseRow["status"];
      createdBy: string | null;
      approvedBy: string | null;
      createdAt: number;
      approvedAt: number | null;
      journalEntryId: string | null;
      isDemo: number;
      receiptFileId: string | null;
    }>(sql`
      SELECT x.id, x.incurred_on AS incurredOn, x.account_id AS accountId, x.paid_from_account_id AS paidFromAccountId, x.cost_center AS costCenter, x.amount_iqd AS amount,
             x.vendor, x.description, x.status, x.created_by AS createdBy, x.approved_by AS approvedBy, x.created_at AS createdAt, x.approved_at AS approvedAt,
             x.journal_entry_id AS journalEntryId, x.is_demo AS isDemo, x.receipt_file_id AS receiptFileId
      FROM expenses AS x WHERE ${where} ORDER BY x.incurred_on DESC, x.created_at DESC, x.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM expenses AS x WHERE ${where}`),
    filters.demo ? Promise.resolve([{ n: 0 }]) : db.all<{ n: number }>(sql`SELECT count(*) AS n FROM expenses AS x WHERE ${expenseWhere(filters, true)} AND x.is_demo = 1`),
    db.all<{ status: string; n: number; total: number }>(sql`SELECT x.status AS status, count(*) AS n, coalesce(sum(x.amount_iqd), 0) AS total FROM expenses AS x WHERE ${base} GROUP BY x.status`),
    db.all<{ accountId: string; total: number }>(sql`SELECT x.account_id AS accountId, coalesce(sum(x.amount_iqd), 0) AS total FROM expenses AS x WHERE ${base} AND x.status = 'posted' GROUP BY x.account_id ORDER BY total DESC`),
    db.all<{ code: string | null; total: number }>(sql`SELECT x.cost_center AS code, coalesce(sum(x.amount_iqd), 0) AS total FROM expenses AS x WHERE ${base} AND x.status = 'posted' GROUP BY x.cost_center ORDER BY total DESC`),
    chartOfAccounts(db),
    db.select({ code: costCenters.code, name: costCenters.name }).from(costCenters),
  ]);
  const nameOf = new Map(chart.map((account) => [account.id, `${account.code} · ${pick(account.name, locale)}`]));
  const centerName = new Map(centers.map((center) => [center.code, pick(center.name, locale)]));
  const names = await employeeNames(db, [...rows.map((row) => row.createdBy), ...rows.map((row) => row.approvedBy)]);
  const myId = postedBy(actor);
  const total = num(count[0]?.n);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      incurredOn: row.incurredOn,
      accountId: row.accountId,
      account: nameOf.get(row.accountId) ?? row.accountId,
      paidFrom: row.paidFromAccountId ? (nameOf.get(row.paidFromAccountId) ?? row.paidFromAccountId) : null,
      costCenter: row.costCenter,
      amountIqd: num(row.amount),
      vendor: row.vendor,
      description: row.description,
      status: row.status,
      createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
      approvedBy: row.approvedBy ? (names.get(row.approvedBy) ?? null) : null,
      createdAt: num(row.createdAt),
      approvedAt: row.approvedAt === null ? null : num(row.approvedAt),
      journalEntryId: row.journalEntryId,
      isDemo: Boolean(row.isDemo),
      needsOther: row.status === "draft" && needsOtherApprover({ amountIqd: num(row.amount), createdBy: row.createdBy }, myId, selfApprovedIqd, threshold),
      hasReceipt: Boolean(row.receiptFileId),
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    demoHidden: num(hidden[0]?.n),
    totals: totals.map((row) => ({ status: row.status, count: num(row.n), iqd: num(row.total) })),
    byAccount: byAccount.map((row) => ({ accountId: row.accountId, account: nameOf.get(row.accountId) ?? row.accountId, iqd: num(row.total) })),
    byCenter: byCenter.map((row) => ({ code: row.code, name: row.code ? (centerName.get(row.code) ?? null) : null, iqd: num(row.total) })),
    threshold,
    selfApprovedIqd,
  };
}

export type ExpenseDetail = ExpenseRow & {
  period: string;
  refType: string | null;
  refId: string | null;
  reversalId: string | null;
  canApprove: boolean;
  canVoid: boolean;
  threshold: number;
  /** What this employee recorded and approved alone in the last 24 hours (it counts against the limit). */
  selfApprovedIqd: number;
};

export async function getExpense(db: Db, actor: Actor, expenseId: string, locale: Locale, now: number = Date.now()): Promise<ExpenseDetail> {
  requireExpenses(actor);
  if (!ID.test(expenseId)) throw notFound("expense");
  const row = await db.select().from(expenses).where(eq(expenses.id, expenseId)).get();
  if (!row) throw notFound("expense");
  const myId = postedBy(actor);
  const [chart, names, reversal, selfApprovedIqd, threshold] = await Promise.all([
    chartOfAccounts(db),
    employeeNames(db, [row.createdBy, row.approvedBy]),
    row.journalEntryId ? db.all<{ id: string }>(sql`SELECT id FROM journal_entries WHERE reverses_id = ${row.journalEntryId}`) : Promise.resolve([] as { id: string }[]),
    selfApprovedRecentIqd(db, myId, now),
    expenseApprovalLimit(db),
  ]);
  const nameOf = new Map(chart.map((account) => [account.id, `${account.code} · ${pick(account.name, locale)}`]));
  const needsOther = row.status === "draft" && needsOtherApprover(row, myId, selfApprovedIqd, threshold);
  return {
    id: row.id,
    incurredOn: row.incurredOn,
    accountId: row.accountId,
    account: nameOf.get(row.accountId) ?? row.accountId,
    paidFrom: row.paidFromAccountId ? (nameOf.get(row.paidFromAccountId) ?? row.paidFromAccountId) : null,
    costCenter: row.costCenter,
    amountIqd: row.amountIqd,
    vendor: row.vendor,
    description: row.description,
    status: row.status,
    createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    approvedBy: row.approvedBy ? (names.get(row.approvedBy) ?? null) : null,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    journalEntryId: row.journalEntryId,
    isDemo: row.isDemo,
    needsOther,
    hasReceipt: Boolean(row.receiptFileId),
    period: row.period,
    refType: row.refType,
    refId: row.refId,
    reversalId: reversal[0]?.id ?? null,
    canApprove: row.status === "draft" && !needsOther,
    canVoid: row.status === "draft" || row.status === "posted",
    threshold,
    selfApprovedIqd,
  };
}

export type ExpenseFormOptions = {
  accounts: { id: string; label: string; systemKey: string | null }[];
  paidFrom: { id: string; label: string; systemKey: string | null }[];
  costCenters: { code: string; name: string }[];
  threshold: number;
};

/** What the expense form offers: expense accounts, where the money came from, active cost centres. */
export async function expenseFormOptions(db: Db, actor: Actor, locale: Locale): Promise<ExpenseFormOptions> {
  requireExpenses(actor);
  const [chart, centers] = await Promise.all([chartOfAccounts(db), db.select({ code: costCenters.code, name: costCenters.name }).from(costCenters).where(eq(costCenters.isActive, true))]);
  const label = (account: { code: string; name: L10n }) => `${account.code} · ${pick(account.name, locale)}`;
  return {
    accounts: expenseAccounts(chart).map((account) => ({ id: account.id, label: label(account), systemKey: account.systemKey })),
    paidFrom: paidFromAccounts(chart).map((account) => ({ id: account.id, label: label(account), systemKey: account.systemKey })),
    costCenters: centers.map((center) => ({ code: center.code, name: pick(center.name, locale) })).sort((a, b) => a.code.localeCompare(b.code)),
    threshold: await expenseApprovalLimit(db),
  };
}

/** The receipt photo of an expense (a private file) for finance.expense.manage holders. */
export async function expenseReceiptFile(db: Db, actor: Actor, expenseId: string): Promise<string | null> {
  requireExpenses(actor);
  if (!ID.test(expenseId)) return null;
  const row = await db.select({ fileId: expenses.receiptFileId }).from(expenses).where(eq(expenses.id, expenseId)).get();
  return row?.fileId ?? null;
}

// ───────────────────────────────────────────────────────────────── cost centres

export type CostCenterRow = { id: string; code: string; name: string; nameL10n: L10n; isActive: boolean; postedIqd: number; expenses: number; lines: number };

/** Cost centres with what was booked to them in the range (posted expenses and every journal line that names them). */
export async function listCostCenters(db: Db, actor: Actor, range: RangeFilter, locale: Locale): Promise<{ rows: CostCenterRow[]; canSeeBooks: boolean }> {
  requireExpenses(actor);
  const canSeeBooks = can(actor, "finance.journal.read") && can(actor, "cost.read");
  const [centers, spent, lines] = await Promise.all([
    db.select().from(costCenters),
    db.all<{ code: string; total: number; n: number }>(sql`
      SELECT cost_center AS code, coalesce(sum(amount_iqd), 0) AS total, count(*) AS n FROM expenses
      WHERE status = 'posted' AND cost_center IS NOT NULL AND incurred_on >= ${range.from} AND incurred_on <= ${range.to} ${range.demo ? sql`` : sql`AND is_demo = 0`}
      GROUP BY cost_center`),
    db.all<{ code: string; n: number }>(sql`
      SELECT l.cost_center AS code, count(*) AS n FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id
      WHERE l.cost_center IS NOT NULL AND e.at >= ${range.fromMs} AND e.at < ${range.toMs} GROUP BY l.cost_center`),
  ]);
  const spentOf = new Map(spent.map((row) => [row.code, row]));
  const linesOf = new Map(lines.map((row) => [row.code, num(row.n)]));
  return {
    rows: centers
      .map((center) => ({
        id: center.id,
        code: center.code,
        name: pick(center.name, locale),
        nameL10n: center.name,
        isActive: center.isActive,
        postedIqd: num(spentOf.get(center.code)?.total),
        expenses: num(spentOf.get(center.code)?.n),
        lines: linesOf.get(center.code) ?? 0,
      }))
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.code.localeCompare(b.code)),
    canSeeBooks,
  };
}

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);

export const SaveCostCenterInput = z.object({
  id: z.preprocess(blank, z.string().regex(ID, "invalid").optional()),
  // digits typed on an Arabic or Kurdish keyboard read as digits
  code: z.preprocess((value) => blank(typeof value === "string" ? latinDigits(value) : value), z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/, "cost_center_code_invalid").optional()),
  nameAr: z.string({ error: "required" }).trim().min(2, "required").max(80, "too_long"),
  nameEn: z.preprocess(blank, z.string().trim().max(80, "too_long").optional()),
  isActive: z.boolean(),
});

/**
 * Adds a cost centre (code + names) or renames / switches one (its code never changes: journal lines and expenses keep
 * it). Audited.
 */
export async function saveCostCenter(db: Db, actor: Actor, raw: z.input<typeof SaveCostCenterInput>, now: number): Promise<{ id: string; created: boolean }> {
  requireExpenses(actor);
  const input = SaveCostCenterInput.parse(raw);
  const name: L10n = { ar: input.nameAr, ...(input.nameEn ? { en: input.nameEn } : {}) };
  if (input.id) {
    const current = await db.select().from(costCenters).where(eq(costCenters.id, input.id)).get();
    if (!current) throw notFound("cost_center");
    await runBatch(db, [
      db.update(costCenters).set({ name, isActive: input.isActive }).where(eq(costCenters.id, current.id)),
      auditStatement(db, { actor, action: "finance.cost_center.update", entityType: "cost_center", entityId: current.id, before: { name: current.name, isActive: current.isActive }, after: { name, isActive: input.isActive }, at: now }),
    ]);
    return { id: current.id, created: false };
  }
  if (!input.code) throw new AppError("invalid", 400, { fields: { code: "required" } });
  const id = `cc_${input.code.toLowerCase().replace(/-/g, "_")}`;
  try {
    await runBatch(db, [
      db.insert(costCenters).values({ id, code: input.code, name, isActive: input.isActive }),
      auditStatement(db, { actor, action: "finance.cost_center.create", entityType: "cost_center", entityId: id, after: { code: input.code, name, isActive: input.isActive }, at: now }),
    ]);
  } catch (error) {
    const info = mapDbError(error);
    if (info?.kind === "unique") throw new AppError("cost_center_code_taken", 409, { fields: { code: "cost_center_code_taken" } });
    throw error;
  }
  return { id, created: true };
}

/**
 * Drafts this employee may approve — not their own when, with what they approved alone in the last 24 hours, they
 * would pass the limit — the module's queue (and the admin bell's). Never a draft whose posting month is closed:
 * approving posts it dated noon of the day it was incurred (now, for a later day — accounting/expenses.server), and a
 * month on or before the last closed one refuses it (`period_closed`), so it is no decision anyone can make.
 */
export async function countDecidableExpenses(db: Db, actor: Actor, now: number = Date.now()): Promise<number | null> {
  if (!can(actor, "finance.expense.manage")) return null;
  const myId = postedBy(actor);
  const [limit, selfApproved] = await Promise.all([expenseApprovalLimit(db), selfApprovedRecentIqd(db, myId, now)]);
  const room = limit - selfApproved;
  // the posting month: min(the day's month, this month) — periodOf(min(dayNoon(incurred_on), now)) without the clock
  const rows = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM expenses AS x WHERE x.status = 'draft' AND NOT (x.created_by = ${myId ?? ""} AND x.amount_iqd > ${room})
      AND NOT EXISTS (SELECT 1 FROM fiscal_periods AS p WHERE p.status = 'closed' AND p.period >= min(substr(x.incurred_on, 1, 7), ${periodOf(now)}))`);
  return num(rows[0]?.n);
}

