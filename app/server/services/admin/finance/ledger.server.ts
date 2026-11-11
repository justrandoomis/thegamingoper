/**
 * Admin 10.01 — the double-entry ledger as the single source of truth: the journal (list, one entry), the chart of
 * accounts with balances and the trial balance, an account's ledger with its running balance, manual entries and
 * reversals. Every view of the books needs finance.journal.read + cost.read (shared.server.ts); posting needs
 * finance.journal.post, the chart finance.account.manage.
 *
 * Postings go through the accounting core (`journalStatements` of accounting/post.server.ts): balanced or refused
 * before the database is touched, lines first and the sealing header last, a closed month refused by the database
 * (period_closed). Entries are never edited: a manual entry is corrected by its reversal — a mirror entry dated now,
 * in an open month, with `reverses_id` set (one reversal per entry, enforced by a UNIQUE index). Automatic postings
 * (orders, payments, refunds, wallet, stock) are corrected through their own flows or a manual adjusting entry.
 * Nobody posts to the wallet liability by hand: the wallet ledger is its subledger (10.07).
 */
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { L10n, Locale } from "~/lib/locales";
import { pick } from "~/lib/locales";
import { sha256Hex } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { accounts, costCenters, journalEntries } from "~/server/db/schema";
import { expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { journalStatements, mapPostingError, postedBy, type JournalLineSpec } from "~/server/services/accounting/post.server";
import { accountSums, chartOfAccounts, isDebitNormal, isLockedPeriod, naturalBalance, openPeriodGuard, systemRoots, trialBalance, type ChartAccount } from "~/server/services/accounting/reports.server";
import { assertBooks, byView, closedPeriods, employeeNames, isPeriodClosed, refLinks, type ByView, type RefLink } from "./shared.server";
import { ACCOUNT_TYPE_LIST, baghdadDay, dayNoon, isDay, latinDigits, MAX_MANUAL_LINES, PAGE_SIZE, periodOf, REF_TYPES, type RangeFilter } from "./types";

export { MAX_MANUAL_LINES };

export const LEDGER_ERROR_KEYS = [
  "journal_unbalanced",
  "journal_line_invalid",
  "journal_wallet_manual",
  "journal_account_inactive",
  "journal_date_future",
  "period_closed",
  "reverse_not_manual",
  "reverse_reversal",
  "already_reversed",
  "account_code_taken",
  "account_parent_invalid",
  "account_system_locked",
  "account_has_balance",
  "account_has_children",
  "account_family_locked",
  "idempotency_mismatch",
] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_LINE_IQD = 10_000_000_000;

// ───────────────────────────────────────────────────────────────── shapes

export type AccountOption = { id: string; code: string; name: string; type: ChartAccount["type"]; systemKey: string | null; isActive: boolean };

export function accountOptions(chart: readonly ChartAccount[], locale: Locale): AccountOption[] {
  return chart.map((account) => ({ id: account.id, code: account.code, name: pick(account.name, locale), type: account.type, systemKey: account.systemKey, isActive: account.isActive }));
}

export type JournalFilters = RangeFilter & { account: string | null; refType: string | null; q: string; page: number };

export type JournalRow = {
  id: string;
  at: number;
  period: string;
  memo: string | null;
  refType: string | null;
  refId: string | null;
  by: ByView;
  reversesId: string | null;
  reversedBy: string | null;
  totalIqd: number;
  isDemo: boolean;
  /** Debit and credit accounts, in line order ("cash", "customer control"). */
  debits: string[];
  credits: string[];
  link: RefLink;
};

export type JournalPage = { rows: JournalRow[]; total: number; page: number; pageCount: number; demoHidden: number; accounts: AccountOption[]; refTypes: string[] };

/** Escapes LIKE wildcards and keeps the pattern under D1's limit (~50 bytes). */
export function likePattern(text: string): string {
  let cut = text;
  while (new TextEncoder().encode(cut).length > 44) cut = cut.slice(0, -1);
  return `%${cut.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function journalWhere(filters: JournalFilters, includeDemo: boolean): SQL {
  const parts: SQL[] = [sql`e.at >= ${filters.fromMs}`, sql`e.at < ${filters.toMs}`];
  if (!includeDemo) parts.push(sql`e.is_demo = 0`);
  if (filters.refType) parts.push(filters.refType === "other" ? sql`(e.ref_type IS NULL OR e.ref_type NOT IN (${sql.join(REF_TYPES.map((ref) => sql`${ref}`), sql`, `)}))` : sql`e.ref_type = ${filters.refType}`);
  if (filters.account) parts.push(sql`EXISTS (SELECT 1 FROM journal_lines AS fl WHERE fl.entry_id = e.id AND fl.account_id = ${filters.account})`);
  if (filters.q) {
    const pattern = likePattern(filters.q);
    parts.push(sql`(e.memo LIKE ${pattern} ESCAPE '\\' OR e.id LIKE ${pattern} ESCAPE '\\' OR e.ref_id LIKE ${pattern} ESCAPE '\\')`);
  }
  return sql.join(parts, sql` AND `);
}

/** 10.01 — the journal, newest first, 25 a page, filters in the URL. */
export async function listJournal(db: Db, actor: Actor, filters: JournalFilters, locale: Locale): Promise<JournalPage> {
  assertBooks(actor);
  const where = journalWhere(filters, filters.demo);
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, count, hidden, chart] = await Promise.all([
    db.all<{ id: string; at: number; period: string; memo: string | null; refType: string | null; refId: string | null; createdBy: string | null; reversesId: string | null; isDemo: number; reversedBy: string | null; total: number }>(sql`
      SELECT e.id, e.at, e.period, e.memo, e.ref_type AS refType, e.ref_id AS refId, e.created_by AS createdBy, e.reverses_id AS reversesId, e.is_demo AS isDemo,
             (SELECT r.id FROM journal_entries AS r WHERE r.reverses_id = e.id) AS reversedBy,
             (SELECT coalesce(sum(l.debit_iqd), 0) FROM journal_lines AS l WHERE l.entry_id = e.id) AS total
      FROM journal_entries AS e WHERE ${where}
      ORDER BY e.at DESC, e.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM journal_entries AS e WHERE ${where}`),
    filters.demo ? Promise.resolve([{ n: 0 }]) : db.all<{ n: number }>(sql`SELECT count(*) AS n FROM journal_entries AS e WHERE ${journalWhere(filters, true)} AND e.is_demo = 1`),
    chartOfAccounts(db),
  ]);
  const ids = rows.map((row) => row.id);
  const lines = ids.length
    ? await db.all<{ entryId: string; accountId: string; debit: number; credit: number }>(sql`
        SELECT entry_id AS entryId, account_id AS accountId, debit_iqd AS debit, credit_iqd AS credit FROM journal_lines
        WHERE entry_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}) ORDER BY id`)
    : [];
  const nameOf = new Map(chart.map((account) => [account.id, pick(account.name, locale)]));
  const byEntry = new Map<string, { debits: string[]; credits: string[] }>();
  for (const line of lines) {
    const entry = byEntry.get(line.entryId) ?? { debits: [], credits: [] };
    const name = nameOf.get(line.accountId) ?? line.accountId;
    if (Number(line.debit) > 0 && !entry.debits.includes(name)) entry.debits.push(name);
    if (Number(line.credit) > 0 && !entry.credits.includes(name)) entry.credits.push(name);
    byEntry.set(line.entryId, entry);
  }
  const [names, links] = await Promise.all([employeeNames(db, rows.map((row) => row.createdBy)), refLinks(db, rows.map((row) => ({ refType: row.refType, refId: row.refId, entryId: row.id })))]);
  const refTypes = await db.all<{ refType: string | null }>(sql`SELECT DISTINCT ref_type AS refType FROM journal_entries ORDER BY ref_type`);
  const total = Number(count[0]?.n ?? 0);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      at: Number(row.at),
      period: row.period,
      memo: row.memo,
      refType: row.refType,
      refId: row.refId,
      by: byView(row.createdBy, names),
      reversesId: row.reversesId,
      reversedBy: row.reversedBy,
      totalIqd: Number(row.total),
      isDemo: Boolean(row.isDemo),
      debits: byEntry.get(row.id)?.debits ?? [],
      credits: byEntry.get(row.id)?.credits ?? [],
      link: links.get(row.id) ?? { kind: "none", href: null, label: null },
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    demoHidden: Number(hidden[0]?.n ?? 0),
    accounts: accountOptions(chart, locale),
    refTypes: refTypes.map((row) => row.refType ?? "other").filter((value, index, all) => all.indexOf(value) === index),
  };
}

export type EntryLine = { id: string; accountId: string; code: string; name: string; debitIqd: number; creditIqd: number; costCenter: string | null; memo: string | null };

export type EntryView = {
  id: string;
  at: number;
  period: string;
  periodClosed: boolean;
  memo: string | null;
  refType: string | null;
  refId: string | null;
  idempotencyKey: string | null;
  by: ByView;
  isDemo: boolean;
  lines: EntryLine[];
  totalIqd: number;
  reverses: { id: string; at: number } | null;
  reversedBy: { id: string; at: number; memo: string | null } | null;
  link: RefLink;
  /** Why this entry cannot be reversed here (null = it can, for an employee holding finance.journal.post). */
  reverseBlocked: "not_manual" | "reversal" | "already_reversed" | null;
  canReverse: boolean;
};

/** One entry with its lines, what it reverses or was reversed by, and whether it may be reversed here. */
export async function getEntry(db: Db, actor: Actor, entryId: string, locale: Locale): Promise<EntryView> {
  assertBooks(actor);
  if (typeof entryId !== "string" || !ID.test(entryId)) throw notFound("journal_entry");
  const entry = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).get();
  if (!entry) throw notFound("journal_entry");
  const [lines, chart, reversal, original] = await Promise.all([
    db.all<{ id: string; accountId: string; debit: number; credit: number; costCenter: string | null; memo: string | null }>(sql`
      SELECT id, account_id AS accountId, debit_iqd AS debit, credit_iqd AS credit, cost_center AS costCenter, memo FROM journal_lines WHERE entry_id = ${entryId} ORDER BY id`),
    chartOfAccounts(db),
    db.select({ id: journalEntries.id, at: journalEntries.at, memo: journalEntries.memo }).from(journalEntries).where(eq(journalEntries.reversesId, entryId)).get(),
    entry.reversesId ? db.select({ id: journalEntries.id, at: journalEntries.at }).from(journalEntries).where(eq(journalEntries.id, entry.reversesId)).get() : Promise.resolve(undefined),
  ]);
  const byId = new Map(chart.map((account) => [account.id, account]));
  const [names, links] = await Promise.all([employeeNames(db, [entry.createdBy]), refLinks(db, [{ refType: entry.refType, refId: entry.refId, entryId }])]);
  const reverseBlocked = entry.refType !== "manual" ? "not_manual" : entry.reversesId ? "reversal" : reversal ? "already_reversed" : null;
  return {
    id: entry.id,
    at: entry.at,
    period: entry.period,
    periodClosed: await isPeriodClosed(db, entry.period),
    memo: entry.memo,
    refType: entry.refType,
    refId: entry.refId,
    idempotencyKey: entry.idempotencyKey,
    by: byView(entry.createdBy, names),
    isDemo: entry.isDemo,
    lines: lines.map((line) => {
      const account = byId.get(line.accountId);
      return { id: line.id, accountId: line.accountId, code: account?.code ?? "—", name: account ? pick(account.name, locale) : line.accountId, debitIqd: Number(line.debit), creditIqd: Number(line.credit), costCenter: line.costCenter, memo: line.memo };
    }),
    totalIqd: lines.reduce((total, line) => total + Number(line.debit), 0),
    reverses: original ? { id: original.id, at: original.at } : null,
    reversedBy: reversal ? { id: reversal.id, at: reversal.at, memo: reversal.memo } : null,
    link: links.get(entryId) ?? { kind: "none", href: null, label: null },
    reverseBlocked,
    canReverse: reverseBlocked === null && can(actor, "finance.journal.post"),
  };
}

// ───────────────────────────────────────────────────────────────── manual entries and reversals

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);

export const ManualEntryInput = z.object({
  date: z.string({ error: "required" }).refine((value) => isDay(value), "invalid"),
  memo: z.string({ error: "required" }).trim().min(3, "required").max(200, "too_long"),
  reason: z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long"),
  lines: z
    .array(
      z.object({
        accountId: z.string({ error: "required" }).regex(ID, "required"),
        debitIqd: z.preprocess(blank, z.number().int("invalid").min(0, "invalid").max(MAX_LINE_IQD, "too_big").optional()),
        creditIqd: z.preprocess(blank, z.number().int("invalid").min(0, "invalid").max(MAX_LINE_IQD, "too_big").optional()),
        costCenter: z.preprocess(blank, z.string().trim().toUpperCase().max(16, "too_long").optional()),
        memo: z.preprocess(blank, z.string().trim().max(200, "too_long").optional()),
      }),
    )
    .min(2, "journal_unbalanced")
    .max(MAX_MANUAL_LINES, "too_big"),
  idempotencyKey: z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid"),
});
export type ManualEntryInput = z.input<typeof ManualEntryInput>;

/** The id an idempotency key gives a manual entry (a resubmitted form finds the first one). */
async function manualEntryId(key: string): Promise<string> {
  return `je_m_${(await sha256Hex(`manual:${key}`)).slice(0, 24)}`;
}

/**
 * Posts a balanced manual entry dated `date` (noon in Baghdad; today = now), in an open month, with a reason that
 * goes to the audit trail. Lines: exactly one positive side each; never on the wallet liability; accounts active;
 * cost centres known. Idempotent on `idempotencyKey`.
 */
export async function postManualEntry(db: Db, actor: Actor, raw: ManualEntryInput, now: number, options: { demo?: boolean } = {}): Promise<{ entryId: string; replayed: boolean }> {
  assertCan(actor, "finance.journal.post");
  assertBooks(actor);
  const input = ManualEntryInput.parse(raw);
  const entryId = await manualEntryId(input.idempotencyKey);
  // The same key again: the first entry — when it is the same entry. A key reused with other content is refused.
  const signature = (rows: readonly { accountId: string; debit: number; credit: number }[]) =>
    rows
      .map((row) => `${row.accountId}:${row.debit}:${row.credit}`)
      .sort()
      .join("|");
  const wanted = signature(input.lines.map((line) => ({ accountId: line.accountId, debit: line.debitIqd ?? 0, credit: line.creditIqd ?? 0 })).filter((line) => line.debit !== 0 || line.credit !== 0));
  const replay = async (): Promise<{ entryId: string; replayed: true } | null> => {
    const existing = await db.select({ id: journalEntries.id, memo: journalEntries.memo }).from(journalEntries).where(eq(journalEntries.id, entryId)).get();
    if (!existing) return null;
    const stored = await db.all<{ accountId: string; debit: number; credit: number }>(sql`SELECT account_id AS accountId, debit_iqd AS debit, credit_iqd AS credit FROM journal_lines WHERE entry_id = ${entryId}`);
    if (existing.memo !== input.memo || signature(stored.map((row) => ({ accountId: row.accountId, debit: Number(row.debit), credit: Number(row.credit) }))) !== wanted) {
      throw new AppError("idempotency_mismatch", 409);
    }
    return { entryId, replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const today = baghdadDay(now);
  if (input.date > today) throw invalid({ date: "journal_date_future" });
  const at = input.date === today ? now : dayNoon(input.date);

  const fields: Record<string, string> = {};
  const lines: JournalLineSpec[] = [];
  let debit = 0;
  let credit = 0;
  const chart = await chartOfAccounts(db);
  const byId = new Map(chart.map((account) => [account.id, account]));
  const roots = systemRoots(chart);
  const centers = new Map((await db.select({ code: costCenters.code, isActive: costCenters.isActive }).from(costCenters)).map((row) => [row.code, row.isActive]));
  input.lines.forEach((line, index) => {
    const d = line.debitIqd ?? 0;
    const c = line.creditIqd ?? 0;
    const account = byId.get(line.accountId);
    if (!account) fields[`lines.${index}.accountId`] = "required";
    else if (!account.isActive) fields[`lines.${index}.accountId`] = "journal_account_inactive";
    else if (roots.get(account.id) === "wallet_liability") fields[`lines.${index}.accountId`] = "journal_wallet_manual";
    if ((d > 0) === (c > 0)) fields[`lines.${index}.amount`] = "journal_line_invalid";
    if (line.costCenter && centers.get(line.costCenter) !== true) fields[`lines.${index}.costCenter`] = "cost_center_invalid";
    debit += d;
    credit += c;
    lines.push({ accountId: line.accountId, ...(d > 0 ? { debitIqd: d } : {}), ...(c > 0 ? { creditIqd: c } : {}), costCenter: line.costCenter ?? null, memo: line.memo ?? null });
  });
  if (Object.keys(fields).length > 0) throw invalid(fields);
  if (debit !== credit || debit === 0) throw new AppError("journal_unbalanced", 400, { fields: { lines: "journal_unbalanced" }, detail: `${debit} ≠ ${credit}` });
  const period = periodOf(at);
  // a closed month is final, and so is every month before the last closed one (they would change its balances)
  if (await isLockedPeriod(db, period)) throw new AppError("period_closed", 409, { fields: { date: "period_closed" }, detail: period });

  try {
    await runBatch(db, [
      openPeriodGuard(db, period),
      ...journalStatements(db, {
        id: entryId,
        at,
        memo: input.memo,
        refType: "manual",
        refId: entryId,
        createdBy: postedBy(actor),
        idempotencyKey: `manual:${entryId}`,
        isDemo: options.demo ?? false,
        lines,
      }),
      auditStatement(db, {
        actor,
        action: "finance.journal.post",
        entityType: "journal_entry",
        entityId: entryId,
        after: { date: input.date, period, memo: input.memo, totalIqd: debit, lines: lines.map((line) => ({ accountId: "accountId" in line ? line.accountId : null, debitIqd: line.debitIqd ?? 0, creditIqd: line.creditIqd ?? 0, costCenter: line.costCenter ?? null })) },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    const posting = mapPostingError(error);
    if (posting?.code === "already_posted" || mapDbError(error)?.kind === "unique") {
      // the same form sent twice at once: the other request posted it (or the key was reused with other content)
      const raced = await replay();
      if (raced) return raced;
    }
    if (posting) throw posting;
    throw error;
  }
  return { entryId, replayed: false };
}

const ReverseInput = z.object({ entryId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long") });

/**
 * Reverses a MANUAL entry: a mirror entry dated now (an open month) with `reverses_id` set, its own audit event and
 * the reason. One reversal per entry (`reversal:<id>` and the UNIQUE reverses_id); a repeat returns `replayed`.
 */
export async function reverseEntry(db: Db, actor: Actor, raw: { entryId: string; reason: string }, now: number): Promise<{ reversalId: string; replayed: boolean }> {
  assertCan(actor, "finance.journal.post");
  assertBooks(actor);
  const input = ReverseInput.parse(raw);
  const entry = await db.select().from(journalEntries).where(eq(journalEntries.id, input.entryId)).get();
  if (!entry) throw notFound("journal_entry");
  const existing = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.reversesId, entry.id)).get();
  if (existing) return { reversalId: existing.id, replayed: true };
  if (entry.refType !== "manual") throw new AppError("reverse_not_manual", 409);
  if (entry.reversesId) throw new AppError("reverse_reversal", 409);
  const lines = await db.all<{ accountId: string; debit: number; credit: number; costCenter: string | null; memo: string | null }>(sql`
    SELECT account_id AS accountId, debit_iqd AS debit, credit_iqd AS credit, cost_center AS costCenter, memo FROM journal_lines WHERE entry_id = ${entry.id} ORDER BY id`);
  const reversalId = `${entry.id}_r`;
  const total = lines.reduce((sum, line) => sum + Number(line.debit), 0);
  try {
    await runBatch(db, [
      ...journalStatements(db, {
        id: reversalId,
        at: now,
        memo: `Reversal: ${entry.memo ?? entry.id} — ${input.reason}`.slice(0, 300),
        refType: entry.refType,
        refId: entry.refId,
        createdBy: postedBy(actor),
        reversesId: entry.id,
        idempotencyKey: `reversal:${entry.id}`,
        isDemo: entry.isDemo,
        lines: lines.map((line) => ({ accountId: line.accountId, ...(Number(line.credit) > 0 ? { debitIqd: Number(line.credit) } : {}), ...(Number(line.debit) > 0 ? { creditIqd: Number(line.debit) } : {}), costCenter: line.costCenter, memo: line.memo })),
      }),
      auditStatement(db, { actor, action: "finance.journal.reverse", entityType: "journal_entry", entityId: entry.id, before: { period: entry.period, totalIqd: total }, after: { reversalId, period: periodOf(now) }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    const posting = mapPostingError(error);
    if (posting?.code === "already_posted" || mapDbError(error)?.kind === "unique") {
      const raced = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.reversesId, entry.id)).get();
      if (raced) return { reversalId: raced.id, replayed: true };
    }
    if (posting) throw posting;
    throw error;
  }
  return { reversalId, replayed: false };
}

// ───────────────────────────────────────────────────────────────── chart of accounts and trial balance

export type AccountRow = {
  id: string;
  code: string;
  name: string;
  nameL10n: L10n;
  type: ChartAccount["type"];
  systemKey: string | null;
  isContra: boolean;
  isSystem: boolean;
  isActive: boolean;
  parentId: string | null;
  depth: number;
  description: string | null;
  /** Movement in the range. */
  debitIqd: number;
  creditIqd: number;
  /** Balance at the end of the range on the account's normal side (negative = the unusual side). */
  balanceIqd: number;
  balanceDebitIqd: number;
  balanceCreditIqd: number;
};

export type ChartView = {
  rows: AccountRow[];
  totals: { debitIqd: number; creditIqd: number; balanced: boolean; entries: number };
  closedPeriods: string[];
  canManage: boolean;
};

/** The chart with each account's movement in the range and its balance at the range's end (the trial balance). */
export async function listAccounts(db: Db, actor: Actor, range: RangeFilter, locale: Locale): Promise<ChartView> {
  assertBooks(actor);
  const [chart, movement, tb, closed] = await Promise.all([
    chartOfAccounts(db),
    accountSums(db, { from: range.fromMs, to: range.toMs, includeDemo: range.demo }),
    trialBalance(db, actor, { to: range.toMs, includeDemo: range.demo }),
    closedPeriods(db),
  ]);
  const byId = new Map(chart.map((account) => [account.id, account]));
  const depthOf = (account: ChartAccount): number => {
    let depth = 0;
    let current = account.parentId ? byId.get(account.parentId) : undefined;
    while (current && depth < 6) {
      depth++;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return depth;
  };
  const closing = new Map(tb.rows.map((row) => [row.account.id, row]));
  // parents before their children, in code order
  const ordered: ChartAccount[] = [];
  const children = new Map<string | null, ChartAccount[]>();
  for (const account of chart) {
    const parent = account.parentId && byId.has(account.parentId) ? account.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), account]);
  }
  const walk = (parent: string | null, depth: number) => {
    for (const account of (children.get(parent) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
      ordered.push(account);
      if (depth < 6) walk(account.id, depth + 1);
    }
  };
  walk(null, 0);
  return {
    rows: ordered.map((account) => {
      const m = movement.get(account.id) ?? { debit: 0, credit: 0 };
      const c = closing.get(account.id);
      const closingSums = { debit: c?.debit ?? 0, credit: c?.credit ?? 0 };
      return {
        id: account.id,
        code: account.code,
        name: pick(account.name, locale),
        nameL10n: account.name,
        type: account.type,
        systemKey: account.systemKey,
        isContra: account.isContra,
        isSystem: account.isSystem,
        isActive: account.isActive,
        parentId: account.parentId,
        depth: depthOf(account),
        description: account.description,
        debitIqd: m.debit,
        creditIqd: m.credit,
        balanceIqd: naturalBalance(account, closingSums),
        balanceDebitIqd: c?.balanceDebit ?? 0,
        balanceCreditIqd: c?.balanceCredit ?? 0,
      };
    }),
    totals: { debitIqd: tb.totalDebit, creditIqd: tb.totalCredit, balanced: tb.balanced, entries: tb.entries },
    closedPeriods: [...closed].sort(),
    canManage: can(actor, "finance.account.manage"),
  };
}

/** Digits typed on an Arabic (٠-٩) or Kurdish (۰-۹) keyboard read as digits. */
const digitsLatin = (value: unknown) => (typeof value === "string" ? latinDigits(value) : value);

export const SaveAccountInput = z.object({
  id: z.preprocess(blank, z.string().regex(ID, "invalid").optional()),
  code: z.preprocess(digitsLatin, z.string({ error: "required" }).trim().regex(/^\d{3,6}$/, "invalid")),
  nameAr: z.string({ error: "required" }).trim().min(2, "required").max(80, "too_long"),
  nameEn: z.preprocess(blank, z.string().trim().max(80, "too_long").optional()),
  type: z.preprocess(blank, z.enum(ACCOUNT_TYPE_LIST).optional()),
  /** undefined keeps the current parent (an edit), null or "" removes it. */
  parentId: z.preprocess((value) => (value === "" ? null : value), z.string().regex(ID, "invalid").nullable().optional()),
  description: z.preprocess(blank, z.string().trim().max(300, "too_long").optional()),
  isActive: z.boolean(),
  reason: z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long"),
});
export type SaveAccountInput = z.input<typeof SaveAccountInput>;

/**
 * Adds an account or changes one (finance.account.manage): code (renumbering is safe — postings use system keys),
 * names, description, parent (same type, no cycle), switched on/off. A system account keeps its type and stays on;
 * an account with a balance or with active sub-accounts cannot be switched off; an account (or a sub-account) that
 * holds postings never moves to another family (account_family_locked). Codes typed with Arabic-Indic or Persian
 * digits are read as digits. Audited with before/after.
 */
export async function saveAccount(db: Db, actor: Actor, raw: SaveAccountInput, now: number): Promise<{ accountId: string; created: boolean }> {
  assertCan(actor, "finance.account.manage");
  const input = SaveAccountInput.parse(raw);
  const chart = await chartOfAccounts(db);
  const byId = new Map(chart.map((account) => [account.id, account]));
  const current = input.id ? byId.get(input.id) : undefined;
  if (input.id && !current) throw notFound("account");
  const type = current?.type ?? input.type;
  if (!type) throw invalid({ type: "required" });
  const taken = chart.find((account) => account.code === input.code && account.id !== current?.id);
  if (taken) throw new AppError("account_code_taken", 409, { fields: { code: "account_code_taken" } });
  const parentId = input.parentId === undefined ? (current?.parentId ?? null) : input.parentId;
  if (parentId) {
    const parent = byId.get(parentId);
    let cycle = false;
    for (let node = parent, depth = 0; node && depth < 12; node = node.parentId ? byId.get(node.parentId) : undefined, depth++) if (node.id === current?.id) cycle = true;
    if (!parent || parent.type !== type || !parent.isActive || cycle) throw new AppError("account_parent_invalid", 409, { fields: { parentId: "account_parent_invalid" } });
  }
  // An account keeps the family (the system account it rolls up to) it was posted in: moving it with its postings
  // under cost of goods, the wallet liability or any other family would rewrite closed months' statements without an
  // entry. Move the balance with a manual entry to a new account instead.
  let changesFamily: SQL | null = null;
  if (current && parentId !== current.parentId) {
    const before = systemRoots(chart);
    const after = systemRoots(chart.map((account) => (account.id === current.id ? { ...account, parentId } : account)));
    const family = [current.id];
    for (let i = 0; i < family.length && family.length < 500; i++) for (const child of chart) if (child.parentId === family[i] && !family.includes(child.id)) family.push(child.id);
    const moved = family.filter((id) => (before.get(id) ?? null) !== (after.get(id) ?? null));
    if (moved.length > 0) {
      changesFamily = sql.join(
        moved.map((id) => sql`${id}`),
        sql`, `,
      );
      const posted = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM journal_lines WHERE account_id IN (${changesFamily})`);
      if (Number(posted[0]?.n ?? 0) > 0) throw new AppError("account_family_locked", 409, { fields: { parentId: "account_family_locked" } });
    }
  }
  if (current && !input.isActive && current.isActive) {
    if (current.isSystem) throw new AppError("account_system_locked", 409, { fields: { isActive: "account_system_locked" } });
    const sums = (await accountSums(db, { includeDemo: true })).get(current.id) ?? { debit: 0, credit: 0 };
    if (sums.debit !== sums.credit) throw new AppError("account_has_balance", 409, { fields: { isActive: "account_has_balance" } });
    if (chart.some((account) => account.parentId === current.id && account.isActive)) throw new AppError("account_has_children", 409, { fields: { isActive: "account_has_children" } });
  }
  const name: L10n = { ...(current?.name ?? {}), ar: input.nameAr, ...(input.nameEn ? { en: input.nameEn } : {}) };
  if (!input.nameEn && current?.name.en && !current.isSystem) delete name.en;
  const accountId = current?.id ?? `acc_${input.code}_${(await sha256Hex(`${input.code}:${now}:${postedBy(actor)}`)).slice(0, 8)}`;
  const before = current ? { code: current.code, name: current.name, parentId: current.parentId, description: current.description, isActive: current.isActive } : null;
  const after = { code: input.code, name, type, parentId, description: input.description ?? null, isActive: current?.isSystem ? true : input.isActive };
  try {
    await runBatch(db, [
      current
        ? db
            .update(accounts)
            .set({ code: input.code, name, parentId, description: input.description ?? null, isActive: after.isActive })
            .where(eq(accounts.id, current.id))
        : db.insert(accounts).values({ id: accountId, code: input.code, name, type, parentId, description: input.description ?? null, isActive: input.isActive, isSystem: false, isContra: false }),
      // a posting that landed after the check above keeps the account where it is
      ...(changesFamily ? [expectThat(db, sql`NOT EXISTS (SELECT 1 FROM journal_lines WHERE account_id IN (${changesFamily}))`, { code: "ACCOUNT_FAMILY_LOCKED", detail: accountId })] : []),
      auditStatement(db, { actor, action: current ? "finance.account.update" : "finance.account.create", entityType: "account", entityId: accountId, before, after, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    const info = mapDbError(error);
    if (info?.kind === "unique" && info.columns?.includes("code")) throw new AppError("account_code_taken", 409, { fields: { code: "account_code_taken" } });
    if (info?.code === "ACCOUNT_FAMILY_LOCKED") throw new AppError("account_family_locked", 409, { fields: { parentId: "account_family_locked" } });
    throw error;
  }
  return { accountId, created: !current };
}

// ───────────────────────────────────────────────────────────────── one account's ledger

export type AccountLedgerRow = {
  lineId: string;
  entryId: string;
  at: number;
  memo: string | null;
  refType: string | null;
  isDemo: boolean;
  debitIqd: number;
  creditIqd: number;
  costCenter: string | null;
  lineMemo: string | null;
  /** The balance after this line, on the account's normal side. */
  balanceIqd: number;
  link: RefLink;
};

export type AccountLedger = {
  account: AccountRow;
  children: { id: string; code: string; name: string }[];
  openingIqd: number;
  closingIqd: number;
  debitIqd: number;
  creditIqd: number;
  rows: AccountLedgerRow[];
  total: number;
  page: number;
  pageCount: number;
};

/** One account's lines in the range (newest first) with the running balance, the opening and the closing balance. */
export async function accountLedger(db: Db, actor: Actor, accountId: string, range: RangeFilter, page: number, locale: Locale): Promise<AccountLedger> {
  assertBooks(actor);
  if (!ID.test(accountId)) throw notFound("account");
  const chart = await chartOfAccounts(db);
  const account = chart.find((row) => row.id === accountId);
  if (!account) throw notFound("account");
  const demo = range.demo ? sql`1 = 1` : sql`e.is_demo = 0`;
  const sign = isDebitNormal(account.type, account.isContra) ? 1 : -1;
  const offset = (page - 1) * PAGE_SIZE;
  const [opening, during, rows, count] = await Promise.all([
    db.all<{ net: number }>(sql`SELECT coalesce(sum(l.debit_iqd - l.credit_iqd), 0) AS net FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id WHERE l.account_id = ${accountId} AND e.at < ${range.fromMs} AND ${demo}`),
    db.all<{ debit: number; credit: number }>(sql`SELECT coalesce(sum(l.debit_iqd), 0) AS debit, coalesce(sum(l.credit_iqd), 0) AS credit FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id WHERE l.account_id = ${accountId} AND e.at >= ${range.fromMs} AND e.at < ${range.toMs} AND ${demo}`),
    db.all<{ lineId: string; entryId: string; at: number; memo: string | null; refType: string | null; refId: string | null; isDemo: number; debit: number; credit: number; costCenter: string | null; lineMemo: string | null; running: number }>(sql`
      SELECT * FROM (
        SELECT l.id AS lineId, e.id AS entryId, e.at AS at, e.memo AS memo, e.ref_type AS refType, e.ref_id AS refId, e.is_demo AS isDemo,
               l.debit_iqd AS debit, l.credit_iqd AS credit, l.cost_center AS costCenter, l.memo AS lineMemo,
               sum(l.debit_iqd - l.credit_iqd) OVER (ORDER BY e.at, e.id, l.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
        FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id
        WHERE l.account_id = ${accountId} AND e.at >= ${range.fromMs} AND e.at < ${range.toMs} AND ${demo}
      ) ORDER BY at DESC, entryId DESC, lineId DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id WHERE l.account_id = ${accountId} AND e.at >= ${range.fromMs} AND e.at < ${range.toMs} AND ${demo}`),
  ]);
  const openingNet = Number(opening[0]?.net ?? 0);
  const debitIqd = Number(during[0]?.debit ?? 0);
  const creditIqd = Number(during[0]?.credit ?? 0);
  const links = await refLinks(db, rows.map((row) => ({ refType: row.refType, refId: row.refId, entryId: row.entryId })));
  const total = Number(count[0]?.n ?? 0);
  const closingNet = openingNet + debitIqd - creditIqd;
  const closingSums = { debit: Math.max(closingNet, 0), credit: Math.max(-closingNet, 0) };
  return {
    account: {
      id: account.id,
      code: account.code,
      name: pick(account.name, locale),
      nameL10n: account.name,
      type: account.type,
      systemKey: account.systemKey,
      isContra: account.isContra,
      isSystem: account.isSystem,
      isActive: account.isActive,
      parentId: account.parentId,
      depth: 0,
      description: account.description,
      debitIqd,
      creditIqd,
      balanceIqd: naturalBalance(account, closingSums),
      balanceDebitIqd: closingSums.debit,
      balanceCreditIqd: closingSums.credit,
    },
    children: chart.filter((row) => row.parentId === account.id).map((row) => ({ id: row.id, code: row.code, name: pick(row.name, locale) })),
    openingIqd: sign * openingNet,
    closingIqd: sign * closingNet,
    debitIqd,
    creditIqd,
    rows: rows.map((row) => ({
      lineId: row.lineId,
      entryId: row.entryId,
      at: Number(row.at),
      memo: row.memo,
      refType: row.refType,
      isDemo: Boolean(row.isDemo),
      debitIqd: Number(row.debit),
      creditIqd: Number(row.credit),
      costCenter: row.costCenter,
      lineMemo: row.lineMemo,
      balanceIqd: sign * (openingNet + Number(row.running)),
      link: links.get(row.entryId) ?? { kind: "none", href: null, label: null },
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export const EXPORT_MAX_LINES = 10_000;

export type JournalExportLine = { at: number; entryId: string; period: string; memo: string | null; refType: string | null; refId: string | null; code: string; account: string; debitIqd: number; creditIqd: number; costCenter: string | null; by: string | null; isDemo: boolean };

/**
 * The journal's lines for a CSV with the list's filters (the books: finance.journal.read + cost.read), oldest first,
 * at most EXPORT_MAX_LINES. The export is audited (who took which range).
 */
export async function exportJournalLines(db: Db, actor: Actor, filters: JournalFilters, locale: Locale, now: number): Promise<{ lines: JournalExportLine[]; truncated: boolean }> {
  assertBooks(actor);
  const where = journalWhere(filters, filters.demo);
  const [rows, chart] = await Promise.all([
    db.all<{ at: number; entryId: string; period: string; memo: string | null; refType: string | null; refId: string | null; accountId: string; debit: number; credit: number; costCenter: string | null; createdBy: string | null; isDemo: number }>(sql`
      SELECT e.at AS at, e.id AS entryId, e.period AS period, e.memo AS memo, e.ref_type AS refType, e.ref_id AS refId, l.account_id AS accountId,
             l.debit_iqd AS debit, l.credit_iqd AS credit, l.cost_center AS costCenter, e.created_by AS createdBy, e.is_demo AS isDemo
      FROM journal_entries AS e JOIN journal_lines AS l ON l.entry_id = e.id WHERE ${where}
      ORDER BY e.at, e.id, l.id LIMIT ${EXPORT_MAX_LINES + 1}`),
    chartOfAccounts(db),
  ]);
  const byId = new Map(chart.map((account) => [account.id, account]));
  const names = await employeeNames(db, rows.map((row) => row.createdBy));
  await runBatch(db, [
    auditStatement(db, { actor, action: "finance.journal.export", entityType: "journal", entityId: null, after: { from: filters.from, to: filters.to, account: filters.account, refType: filters.refType, demo: filters.demo, lines: Math.min(rows.length, EXPORT_MAX_LINES) }, at: now }),
  ]);
  return {
    lines: rows.slice(0, EXPORT_MAX_LINES).map((row) => {
      const account = byId.get(row.accountId);
      const by = byView(row.createdBy, names);
      return {
        at: Number(row.at),
        entryId: row.entryId,
        period: row.period,
        memo: row.memo,
        refType: row.refType,
        refId: row.refId,
        code: account?.code ?? "",
        account: account ? pick(account.name, locale) : row.accountId,
        debitIqd: Number(row.debit),
        creditIqd: Number(row.credit),
        costCenter: row.costCenter,
        by: by.kind === "employee" ? by.name : by.kind === "system" ? `system:${by.name ?? ""}` : by.kind,
        isDemo: Boolean(row.isDemo),
      };
    }),
    truncated: rows.length > EXPORT_MAX_LINES,
  };
}

/** Options for the manual entry form: active accounts (the wallet liability is never offered) and active cost centres. */
export async function manualEntryOptions(db: Db, actor: Actor, locale: Locale): Promise<{ accounts: AccountOption[]; costCenters: { code: string; name: string }[]; closed: string[] }> {
  assertCan(actor, "finance.journal.post");
  assertBooks(actor);
  const chart = await chartOfAccounts(db);
  const roots = systemRoots(chart);
  const centers = await db.select({ code: costCenters.code, name: costCenters.name }).from(costCenters).where(and(eq(costCenters.isActive, true), ne(costCenters.code, "")));
  return {
    accounts: accountOptions(
      chart.filter((account) => account.isActive && roots.get(account.id) !== "wallet_liability"),
      locale,
    ),
    costCenters: centers.map((row) => ({ code: row.code, name: pick(row.name, locale) })),
    closed: [...(await closedPeriods(db))].sort(),
  };
}
