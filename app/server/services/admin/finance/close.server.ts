/**
 * Admin 10.09 — the monthly close. A month is a fiscal period "YYYY-MM" (Baghdad). Closing it writes the
 * `fiscal_periods` row (status closed, who, when, the reason); from then on the database refuses every journal entry
 * dated into it (TT:PERIOD_CLOSED — drizzle/0001_invariants.sql), and the services refuse anything dated before it
 * as well (isLockedPeriod / openPeriodGuard in accounting/reports.server.ts: an earlier month left open would
 * otherwise move the closed month's closing balances), so a closed month changes only through reversing or adjusting
 * entries dated in an open month after it. There is no "reopen": the blueprint allows corrections by reversal only.
 *
 * Before closing, a checklist (blocking items stop the close; warnings are shown with their counts and the person
 * decides with a reason):
 *   blocking  the month is over · no earlier month with entries is still open · the month's entries balance, each
 *             with at least two lines
 *   warnings  draft expenses dated in the month or before it (they cannot be posted after the close) · transfer proofs, refunds
 *             and top-ups still waiting · statement lines not matched · open critical consistency findings
 *
 * Viewing needs the books (finance.journal.read + cost.read) or finance.period.close; closing needs
 * finance.period.close. Amounts are shown only with cost.read.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { can, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { fiscalPeriods } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden } from "~/server/errors";
import { employeeNames, financeAccess } from "./shared.server";
import { isPeriod, periodOf, periodRange } from "./types";

export const CLOSE_ERROR_KEYS = ["period_not_over", "period_earlier_open", "period_unbalanced", "period_already_closed", "period_close_blocked"] as const;

const num = (value: unknown) => Number(value ?? 0);

function requireView(actor: Actor): void {
  if (!financeAccess(actor).closeView) throw forbidden("finance.period.close");
}

export type PeriodRow = {
  period: string;
  status: "open" | "closed";
  closedBy: string | null;
  closedAt: number | null;
  note: string | null;
  entries: number;
  demoEntries: number;
  /** Σ debit of the month's entries (cost.read only). */
  totalIqd: number | null;
  current: boolean;
};

/** Every month that has entries or a close record, plus the current one, newest first. */
export async function listPeriods(db: Db, actor: Actor, now: number): Promise<PeriodRow[]> {
  requireView(actor);
  const withCost = can(actor, "cost.read");
  const current = periodOf(now);
  const [entries, closes] = await Promise.all([
    db.all<{ period: string; n: number; demo: number; total: number }>(sql`
      SELECT e.period AS period, count(*) AS n, coalesce(sum(e.is_demo), 0) AS demo,
             coalesce((SELECT sum(l.debit_iqd) FROM journal_lines AS l JOIN journal_entries AS e2 ON e2.id = l.entry_id WHERE e2.period = e.period), 0) AS total
      FROM journal_entries AS e GROUP BY e.period`),
    db.select().from(fiscalPeriods),
  ]);
  const periods = new Set<string>([current, ...entries.map((row) => row.period), ...closes.map((row) => row.period)]);
  const names = await employeeNames(db, closes.map((row) => row.closedBy));
  return [...periods]
    .filter(isPeriod)
    .sort((a, b) => b.localeCompare(a))
    .map((period) => {
      const e = entries.find((row) => row.period === period);
      const c = closes.find((row) => row.period === period);
      return {
        period,
        status: c?.status === "closed" ? "closed" : "open",
        closedBy: c?.closedBy ? (names.get(c.closedBy) ?? null) : null,
        closedAt: c?.closedAt ?? null,
        note: c?.note ?? null,
        entries: num(e?.n),
        demoEntries: num(e?.demo),
        totalIqd: withCost ? num(e?.total) : null,
        current: period === current,
      };
    });
}

export type ChecklistItem = {
  key: "month_over" | "earlier_open" | "balanced" | "entry_lines" | "draft_expenses" | "pending_proofs" | "pending_refunds" | "pending_topups" | "unmatched_lines" | "critical_findings";
  state: "ok" | "warn" | "block";
  count: number;
  /** Earlier open months, for "earlier_open". */
  periods?: string[];
};

export type CloseChecklist = { period: string; status: "open" | "closed"; items: ChecklistItem[]; canClose: boolean; blocked: boolean; entries: number; totalIqd: number | null };

/** What closing `period` would face (see the file header). */
export async function closeChecklist(db: Db, actor: Actor, period: string, now: number): Promise<CloseChecklist> {
  requireView(actor);
  if (!isPeriod(period)) throw new AppError("invalid", 400, { fields: { period: "invalid" } });
  const { from, to } = periodRange(period);
  const [status, earlier, balance, badEntries, drafts, proofs, refunds, topups, lines, findings] = await Promise.all([
    db.all<{ status: string }>(sql`SELECT status FROM fiscal_periods WHERE period = ${period}`),
    db.all<{ period: string }>(sql`
      SELECT DISTINCT e.period AS period FROM journal_entries AS e
      WHERE e.period < ${period} AND NOT EXISTS (SELECT 1 FROM fiscal_periods AS f WHERE f.period = e.period AND f.status = 'closed') ORDER BY e.period`),
    db.all<{ debit: number; credit: number; n: number }>(sql`
      SELECT coalesce(sum(l.debit_iqd), 0) AS debit, coalesce(sum(l.credit_iqd), 0) AS credit, (SELECT count(*) FROM journal_entries WHERE period = ${period}) AS n
      FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id WHERE e.period = ${period}`),
    db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM (SELECT e.id FROM journal_entries AS e LEFT JOIN journal_lines AS l ON l.entry_id = e.id WHERE e.period = ${period}
        GROUP BY e.id HAVING count(l.id) < 2 OR coalesce(sum(l.debit_iqd), 0) <> coalesce(sum(l.credit_iqd), 0))`),
    // drafts dated in the month or before it: after the close none of them can be posted (a closed month is final
    // for the months before it too — accounting/reports.server.ts isLockedPeriod)
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM expenses WHERE period <= ${period} AND status = 'draft'`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM payments WHERE status = 'pending_verification' AND created_at >= ${from} AND created_at < ${to}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM refunds WHERE status = 'pending' AND created_at >= ${from} AND created_at < ${to}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM wallet_topups WHERE status = 'pending_verification' AND created_at >= ${from} AND created_at < ${to}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM statement_lines WHERE status = 'unmatched' AND occurred_at >= ${from} AND occurred_at < ${to}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM consistency_findings WHERE status IN ('open', 'acknowledged') AND severity = 'critical'`),
  ]);
  const closed = status[0]?.status === "closed";
  const over = period < periodOf(now);
  const debit = num(balance[0]?.debit);
  const credit = num(balance[0]?.credit);
  const items: ChecklistItem[] = [
    { key: "month_over", state: over ? "ok" : "block", count: 0 },
    { key: "earlier_open", state: earlier.length ? "block" : "ok", count: earlier.length, periods: earlier.map((row) => row.period) },
    { key: "balanced", state: debit === credit ? "ok" : "block", count: 0 },
    { key: "entry_lines", state: num(badEntries[0]?.n) ? "block" : "ok", count: num(badEntries[0]?.n) },
    { key: "draft_expenses", state: num(drafts[0]?.n) ? "warn" : "ok", count: num(drafts[0]?.n) },
    { key: "pending_proofs", state: num(proofs[0]?.n) ? "warn" : "ok", count: num(proofs[0]?.n) },
    { key: "pending_refunds", state: num(refunds[0]?.n) ? "warn" : "ok", count: num(refunds[0]?.n) },
    { key: "pending_topups", state: num(topups[0]?.n) ? "warn" : "ok", count: num(topups[0]?.n) },
    { key: "unmatched_lines", state: num(lines[0]?.n) ? "warn" : "ok", count: num(lines[0]?.n) },
    { key: "critical_findings", state: num(findings[0]?.n) ? "warn" : "ok", count: num(findings[0]?.n) },
  ];
  const blocked = items.some((item) => item.state === "block");
  return {
    period,
    status: closed ? "closed" : "open",
    items,
    blocked,
    canClose: !closed && !blocked && can(actor, "finance.period.close"),
    entries: num(balance[0]?.n),
    totalIqd: can(actor, "cost.read") ? debit : null,
  };
}

const CloseInput = z.object({
  period: z.string().refine((value) => isPeriod(value), "invalid"),
  reason: z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long"),
});

/**
 * Closes a month (finance.period.close) after re-running the blocking checks. Guarded: a month already closed returns
 * `replayed: true`; two people closing at once close it once.
 */
export async function closePeriod(db: Db, actor: Actor, raw: { period: string; reason: string }, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "finance.period.close");
  const input = CloseInput.parse(raw);
  const checklist = await closeChecklist(db, actor, input.period, now);
  if (checklist.status === "closed") return { replayed: true };
  const blocking = checklist.items.find((item) => item.state === "block");
  if (blocking) {
    const code = blocking.key === "month_over" ? "period_not_over" : blocking.key === "earlier_open" ? "period_earlier_open" : "period_unbalanced";
    throw new AppError(code, 409, { detail: blocking.periods?.join(",") });
  }
  const by = actor.kind === "employee" ? actor.id : null;
  try {
    await runBatch(db, [
      db
        .insert(fiscalPeriods)
        .values({ period: input.period, status: "closed", closedBy: by, closedAt: now, note: input.reason })
        .onConflictDoUpdate({ target: fiscalPeriods.period, set: { status: "closed", closedBy: by, closedAt: now, note: input.reason }, setWhere: sql`${fiscalPeriods.status} = 'open'` }),
      expectChanged(db, 1, { code: "PERIOD_ALREADY_CLOSED", detail: input.period }),
      auditStatement(db, {
        actor,
        action: "finance.period.close",
        entityType: "fiscal_period",
        entityId: input.period,
        before: { status: "open" },
        after: { status: "closed", entries: checklist.entries, warnings: checklist.items.filter((item) => item.state === "warn").map((item) => ({ key: item.key, count: item.count })) },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (mapDbError(error)?.code === "PERIOD_ALREADY_CLOSED") return { replayed: true };
    throw error;
  }
  return { replayed: false };
}
