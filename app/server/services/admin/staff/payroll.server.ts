/**
 * Admin 15.04 — wages, salaries, bonuses, advances and settlements: computed here, approved by a second person, booked
 * only through the accounting core (app/server/services/accounting/payroll.server.ts).
 *
 * A RUN covers one month (Baghdad) for the real staff, or — in a separate run — for the demo staff (never mixed: a
 * demo run's posting is a demo entry). Its id says which: `pyr_…` real, `pyd_…` demo. At most one open run (draft or
 * approved) per month and kind. Preparing computes, per employee who works or worked here during the month:
 *   base        monthly salary × payable days ÷ days in the month — payable days are the days employed in the month
 *               (from the account's creation to its disabling) minus approved UNPAID leave — less the base already
 *               paid to them in another run of the same month (an earlier final settlement): a base is paid once
 *   commission  every computed commission not yet in a run, of this month or before (clawbacks for returns
 *               included; when clawbacks would take the pay below zero they wait for a later run)
 *   advances    open salary advances, oldest first, deducted whole as long as the pay stays ≥ 0 (the rest wait)
 *   bonus, other deduction   typed by the preparer on the draft, each with a note
 *   net         base + commission + bonus − advances − other deductions (the schema's CHECK)
 * Employees with nothing to pay are left out (listed as such). The commissions and advances a run counts are linked to
 * it (payroll_run_id / settled_run_id) in the same batch, guarded so two runs can never count the same row.
 *
 * TWO PEOPLE. staff.payroll.run prepares, recomputes, edits and defers; staff.payroll.approve approves and pays —
 * never someone who prepared, recomputed or edited the run, nor someone who changed the salary of one of its
 * employees after that salary was last computed into a paid run (lastPaidComputationSql), nor someone the run pays
 * (run_self_approval, 403; held again inside
 * the batch). The approver
 * approves exactly what they saw (count and net total, else run_changed). Paying (approved → paid) posts the run,
 * marks its commissions paid and its advances settled, in ONE batch with the posting.
 *
 * ADVANCES. staff.payroll.run asks for an advance (an `approvals` row, kind "staff_advance"); staff.payroll.approve
 * decides — never the requester, never the employee it is for; approving hands it out: the `employee_advances` row
 * and its posting (Dr payroll / Cr cash or bank) in one batch. The requester may withdraw a pending request.
 *
 * A paid run is final; corrections go into the next run as a bonus or a deduction. Salary and pay are absent from
 * every result for employees without staff.payroll.read (or the run / approve permissions).
 *
 * Errors: forbidden, not_found, invalid (fields), run_open_exists, run_not_draft, run_not_approved, run_changed,
 * run_self_approval (403), run_empty, net_negative, advance_not_pending, approver_is_requester (403),
 * advance_beneficiary (403), advance_not_in_run, employee_inactive, period_closed, already_posted, idempotency_mismatch.
 */
import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, commissions, employeeAdvances, employees, payrollItems, payrollRuns, type PayrollItem, type PayrollRun } from "~/server/db/schema";
import { chunkRows, expectChanged, expectThat, isDbError, isUniqueViolation, runBatch, type BatchStatement } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { mapPostingError, postedBy } from "../../accounting/post.server";
import { PAYROLL_PAID_FROM, postEmployeeAdvance, postPayrollRun, type PayrollRunTotals } from "../../accounting/payroll.server";
import { syncCommissions } from "./commissions.server";
import { actorId, assertAny, assertReach, assertWholeStore, branchLimit, byView, cleanLine, IdSchema, KeySchema, OptionalNote, participants, peopleById, personOf, reachSql, Reason, stamp, tookPartSql, wholeIqd } from "./shared.server";
import {
  addDays,
  ADVANCE_APPROVAL_KIND,
  baghdadDay,
  daySpan,
  MAX_PAY_IQD,
  monthDays,
  PAGE_SIZE,
  periodOf,
  periodRange,
  shiftPeriod,
  type AdvanceFilters,
  type AdvanceRow,
  type AdvanceStatusKey,
  type ByView,
  type PayrollFilters,
  type PersonRef,
  type RunItemView,
  type RunRow,
} from "./types";

const VIEWERS = ["staff.payroll.read", "staff.payroll.run", "staff.payroll.approve"] as const;
/** The audit actions of a run that make someone a participant (who may then not approve it). */
export const RUN_PARTICIPANT_ACTIONS = ["staff.payroll.run_prepare", "staff.payroll.run_recompute", "staff.payroll.item_update", "staff.payroll.advance_defer"] as const;
const PERIOD = z.string({ error: "required" }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, "invalid");

export const isDemoRun = (runId: string) => runId.startsWith("pyd_");
export const runRef = (run: Pick<PayrollRun, "id" | "period">) => `PR-${run.period.replace("-", "")}-${run.id.slice(4, 8).toUpperCase()}`;

function sqlIn(values: readonly string[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

// ───────────────────────────────────────────────────────────────── planning (no writes)

export type PlanItem = {
  employee: PersonRef & { status: "active" | "disabled"; jobTitle: string | null };
  monthlyIqd: number | null;
  payableDays: number;
  monthDays: number;
  unpaidLeaveDays: number;
  paidElsewhereIqd: number;
  baseIqd: number;
  commissionIds: string[];
  commissionIqd: number;
  deferredClawbacks: number;
  bonusIqd: number;
  otherDeductionIqd: number;
  notes: string | null;
  advanceIds: string[];
  advanceDeductionIqd: number;
  deferredAdvances: number;
  netIqd: number;
};

export type Plan = { period: string; demo: boolean; items: PlanItem[]; excluded: (PersonRef & { reason: "no_pay" })[] };

type Keep = Map<string, { bonusIqd: number; otherDeductionIqd: number; notes: string | null }>;

/**
 * What a run of `period` would pay now (reads only). `runId`: the draft being recomputed — its own links count as
 * free, its edits (`keep`) are carried over, and its advances are those still linked to it plus any given after it was
 * prepared (an advance its preparer deferred stays deferred).
 */
export async function planRun(db: Db, input: { period: string; demo: boolean; runId?: string | null; runCreatedAt?: number; keep?: Keep }, now: number): Promise<Plan> {
  const { from, to } = periodRange(input.period);
  const month = monthDays(input.period);
  const people = await db
    .select({ id: employees.id, name: employees.name, isDemo: employees.isDemo, status: employees.status, jobTitle: employees.jobTitle, baseSalaryIqd: employees.baseSalaryIqd, createdAt: employees.createdAt, disabledAt: employees.disabledAt })
    .from(employees)
    .where(and(eq(employees.isDemo, input.demo), sql`${employees.createdAt} < ${to}`, or(eq(employees.status, "active"), sql`${employees.disabledAt} >= ${from}`)))
    .orderBy(asc(employees.name));
  const runId = input.runId ?? null;
  const ids = people.map((person) => person.id);
  if (!ids.length) return { period: input.period, demo: input.demo, items: [], excluded: [] };
  const commissionRows: { id: string; employeeId: string; amountIqd: number }[] = [];
  const advanceRows: { id: string; employeeId: string; amountIqd: number; givenAt: number; settledRunId: string | null }[] = [];
  const paidElsewhere = new Map<string, number>();
  for (let at = 0; at < ids.length; at += 80) {
    const part = ids.slice(at, at + 80);
    commissionRows.push(
      ...(await db
        .select({ id: commissions.id, employeeId: commissions.employeeId, amountIqd: commissions.amountIqd })
        .from(commissions)
        .where(and(inArray(commissions.employeeId, part), eq(commissions.status, "accrued"), lte(commissions.period, input.period), runId ? or(isNull(commissions.payrollRunId), eq(commissions.payrollRunId, runId)) : isNull(commissions.payrollRunId)))
        .orderBy(asc(commissions.createdAt), asc(commissions.id))),
    );
    advanceRows.push(
      ...(await db
        .select({ id: employeeAdvances.id, employeeId: employeeAdvances.employeeId, amountIqd: employeeAdvances.amountIqd, givenAt: employeeAdvances.givenAt, settledRunId: employeeAdvances.settledRunId })
        .from(employeeAdvances)
        .where(and(inArray(employeeAdvances.employeeId, part), eq(employeeAdvances.status, "open"), lte(employeeAdvances.givenAt, now), runId ? or(isNull(employeeAdvances.settledRunId), eq(employeeAdvances.settledRunId, runId)) : isNull(employeeAdvances.settledRunId)))
        .orderBy(asc(employeeAdvances.givenAt), asc(employeeAdvances.id))),
    );
    const paid = await db.all<{ employeeId: string; base: number }>(sql`
      SELECT i.employee_id AS employeeId, sum(i.base_iqd) AS base FROM payroll_items AS i JOIN payroll_runs AS r ON r.id = i.run_id
      WHERE r.period = ${input.period} AND r.status <> 'void' ${runId ? sql`AND r.id <> ${runId}` : sql``} AND i.employee_id IN (${sqlIn(part)})
      GROUP BY i.employee_id`);
    for (const row of paid) paidElsewhere.set(row.employeeId, Number(row.base));
  }
  const unpaidLeave = await db.all<{ employeeId: string; startsOn: string; endsOn: string }>(sql`
    SELECT employee_id AS employeeId, starts_on AS startsOn, ends_on AS endsOn FROM leave_requests
    WHERE status = 'approved' AND kind = 'unpaid' AND ends_on >= ${month.first} AND starts_on <= ${month.last}`);
  const items: PlanItem[] = [];
  const excluded: Plan["excluded"] = [];
  for (const person of people) {
    const startDay = baghdadDay(person.createdAt) > month.first ? baghdadDay(person.createdAt) : month.first;
    const endDay = person.status === "disabled" && person.disabledAt !== null && baghdadDay(person.disabledAt) < month.last ? baghdadDay(person.disabledAt) : month.last;
    const employed = daySpan(startDay, endDay);
    const unpaid = employed > 0 ? unpaidDaysIn(unpaidLeave.filter((row) => row.employeeId === person.id), startDay, endDay) : 0;
    const payable = Math.max(0, employed - unpaid);
    const monthly = person.baseSalaryIqd ?? null;
    const elsewhere = paidElsewhere.get(person.id) ?? 0;
    const fullBase = monthly && monthly > 0 ? Math.floor((monthly * payable) / month.count) : 0;
    const base = Math.max(0, fullBase - elsewhere);
    const kept = input.keep?.get(person.id);
    const bonus = kept?.bonusIqd ?? 0;
    const other = kept?.otherDeductionIqd ?? 0;
    let rows = commissionRows.filter((row) => row.employeeId === person.id);
    let commission = rows.reduce((sum, row) => sum + row.amountIqd, 0);
    let deferredClawbacks = 0;
    if (base + bonus - other + commission < 0) {
      // returns outweigh the pay: their clawbacks wait for a later run
      deferredClawbacks = rows.filter((row) => row.amountIqd < 0).length;
      rows = rows.filter((row) => row.amountIqd > 0);
      commission = rows.reduce((sum, row) => sum + row.amountIqd, 0);
    }
    const before = base + commission + bonus - other;
    let advance = 0;
    const advanceIds: string[] = [];
    let deferredAdvances = 0;
    for (const row of advanceRows.filter((item) => item.employeeId === person.id)) {
      const wasDeferred = runId !== null && row.settledRunId === null && input.runCreatedAt !== undefined && row.givenAt <= input.runCreatedAt;
      if (wasDeferred || advance + row.amountIqd > before) {
        deferredAdvances += 1;
        continue;
      }
      advance += row.amountIqd;
      advanceIds.push(row.id);
    }
    const net = before - advance;
    if (base === 0 && commission === 0 && advance === 0 && bonus === 0 && other === 0) {
      excluded.push({ id: person.id, name: person.name, isDemo: person.isDemo, reason: "no_pay" });
      continue;
    }
    items.push({
      employee: { id: person.id, name: person.name, isDemo: person.isDemo, status: person.status, jobTitle: person.jobTitle },
      monthlyIqd: monthly,
      payableDays: payable,
      monthDays: month.count,
      unpaidLeaveDays: unpaid,
      paidElsewhereIqd: elsewhere,
      baseIqd: base,
      commissionIds: rows.map((row) => row.id),
      commissionIqd: commission,
      deferredClawbacks,
      bonusIqd: bonus,
      otherDeductionIqd: other,
      notes: kept?.notes ?? null,
      advanceIds,
      advanceDeductionIqd: advance,
      deferredAdvances,
      netIqd: net,
    });
  }
  return { period: input.period, demo: input.demo, items, excluded };
}

/** Distinct leave days of the rows that fall between two days (inclusive). */
export function unpaidDaysIn(rows: readonly { startsOn: string; endsOn: string }[], from: string, to: string): number {
  const days = new Set<string>();
  for (const row of rows) {
    let day = row.startsOn < from ? from : row.startsOn;
    const last = row.endsOn > to ? to : row.endsOn;
    while (day <= last) {
      days.add(day);
      day = addDays(day, 1);
    }
  }
  return days.size;
}

export function planTotals(items: readonly Pick<PlanItem, "baseIqd" | "commissionIqd" | "bonusIqd" | "advanceDeductionIqd" | "otherDeductionIqd" | "netIqd">[]): PayrollRunTotals {
  return items.reduce<PayrollRunTotals>(
    (sum, item) => ({
      baseIqd: sum.baseIqd + item.baseIqd,
      bonusIqd: sum.bonusIqd + item.bonusIqd,
      commissionIqd: sum.commissionIqd + item.commissionIqd,
      advanceDeductionIqd: sum.advanceDeductionIqd + item.advanceDeductionIqd,
      otherDeductionIqd: sum.otherDeductionIqd + item.otherDeductionIqd,
      netIqd: sum.netIqd + item.netIqd,
    }),
    { baseIqd: 0, bonusIqd: 0, commissionIqd: 0, advanceDeductionIqd: 0, otherDeductionIqd: 0, netIqd: 0 },
  );
}

/** Statements that link rows to a run, each guarded to have changed exactly the rows it names (never a row taken by another run). */
function linkStatements(db: Db, runId: string, commissionIds: readonly string[], advanceIds: readonly string[]): BatchStatement[] {
  const out: BatchStatement[] = [];
  for (let at = 0; at < commissionIds.length; at += 90) {
    const part = commissionIds.slice(at, at + 90);
    out.push(
      db
        .update(commissions)
        .set({ payrollRunId: runId })
        .where(and(inArray(commissions.id, part), isNull(commissions.payrollRunId), eq(commissions.status, "accrued"))),
      expectChanged(db, part.length, { code: "RUN_CHANGED", detail: "commissions" }),
    );
  }
  for (let at = 0; at < advanceIds.length; at += 90) {
    const part = advanceIds.slice(at, at + 90);
    out.push(
      db
        .update(employeeAdvances)
        .set({ settledRunId: runId })
        .where(and(inArray(employeeAdvances.id, part), isNull(employeeAdvances.settledRunId), eq(employeeAdvances.status, "open"))),
      expectChanged(db, part.length, { code: "RUN_CHANGED", detail: "advances" }),
    );
  }
  return out;
}

function itemRows(runId: string, items: readonly PlanItem[]): (typeof payrollItems.$inferInsert)[] {
  return items.map((item) => ({
    id: `${runId}.${item.employee.id}`,
    runId,
    employeeId: item.employee.id,
    baseIqd: item.baseIqd,
    commissionIqd: item.commissionIqd,
    bonusIqd: item.bonusIqd,
    advanceDeductionIqd: item.advanceDeductionIqd,
    otherDeductionIqd: item.otherDeductionIqd,
    netIqd: item.netIqd,
    notes: item.notes,
  }));
}

function totalsStatement(db: Db, runId: string): BatchStatement {
  return db
    .update(payrollRuns)
    .set({
      totalGrossIqd: sql`(SELECT coalesce(sum(base_iqd + commission_iqd + bonus_iqd), 0) FROM payroll_items WHERE run_id = ${runId})`,
      totalNetIqd: sql`(SELECT coalesce(sum(net_iqd), 0) FROM payroll_items WHERE run_id = ${runId})`,
    })
    .where(eq(payrollRuns.id, runId));
}

function translateRunError(error: unknown): never {
  if (isDbError(error, "RUN_CHANGED")) throw new AppError("run_changed", 409);
  if (isDbError(error, "RUN_OPEN_EXISTS")) throw new AppError("run_open_exists", 409);
  if (isDbError(error, "RUN_NOT_DRAFT")) throw new AppError("run_not_draft", 409);
  if (isDbError(error, "RUN_NOT_APPROVED")) throw new AppError("run_not_approved", 409);
  if (isDbError(error, "RUN_SELF_APPROVAL")) throw new AppError("run_self_approval", 403);
  const posting = mapPostingError(error);
  if (posting) throw posting;
  throw error;
}

// ───────────────────────────────────────────────────────────────── runs

export type RunPage = { rows: RunRow[]; total: number; page: number; pageCount: number; open: { period: string; demo: boolean; runId: string; status: string }[]; can: { prepare: boolean } };

export async function listRuns(db: Db, actor: Actor, filters: PayrollFilters): Promise<RunPage> {
  assertAny(actor, VIEWERS);
  assertWholeStore(actor);
  const where: SQL[] = [];
  if (filters.status) where.push(eq(payrollRuns.status, filters.status));
  const condition = where.length ? and(...where) : undefined;
  const [rows, count, open] = await Promise.all([
    db
      .select({ run: payrollRuns, employees: sql<number>`(SELECT count(*) FROM payroll_items WHERE run_id = ${payrollRuns.id})` })
      .from(payrollRuns)
      .where(condition)
      .orderBy(desc(payrollRuns.period), desc(payrollRuns.createdAt))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)` }).from(payrollRuns).where(condition).get(),
    db.select({ id: payrollRuns.id, period: payrollRuns.period, status: payrollRuns.status }).from(payrollRuns).where(inArray(payrollRuns.status, ["draft", "approved"])),
  ]);
  const people = await peopleById(db, [...rows.map(({ run }) => run.createdBy), ...rows.map(({ run }) => run.approvedBy)]);
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map(({ run, employees: count }) => runRowOf(run, Number(count), people)),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    open: open.map((run) => ({ period: run.period, demo: isDemoRun(run.id), runId: run.id, status: run.status })),
    can: { prepare: can(actor, "staff.payroll.run") },
  };
}

function runRowOf(run: PayrollRun, count: number, people: Map<string, PersonRef>): RunRow {
  return {
    id: run.id,
    ref: runRef(run),
    period: run.period,
    status: run.status,
    employees: count,
    grossIqd: run.totalGrossIqd,
    netIqd: run.totalNetIqd,
    createdBy: byView(people, run.createdBy),
    approvedBy: run.approvedBy ? byView(people, run.approvedBy) : null,
    createdAt: run.createdAt,
    approvedAt: run.approvedAt,
    paidAt: run.paidAt,
    isDemo: isDemoRun(run.id),
    journalEntryId: run.journalEntryId,
  };
}

/** What a new run of a month would pay (staff.payroll.run): the preview before preparing. Computes nothing new. */
export async function previewRun(db: Db, actor: Actor, raw: { period: string; demo?: boolean }, now: number): Promise<Plan & { totals: PayrollRunTotals; openRun: string | null }> {
  assertAny(actor, ["staff.payroll.run"]);
  assertWholeStore(actor);
  const period = PERIOD.parse(raw.period);
  const demo = raw.demo === true;
  const plan = await planRun(db, { period, demo }, now);
  const open = await db
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.period, period), inArray(payrollRuns.status, ["draft", "approved"]), sql`${payrollRuns.id} LIKE ${demo ? "pyd\\_%" : "pyr\\_%"} ESCAPE '\\'`))
    .get();
  return { ...plan, totals: planTotals(plan.items), openRun: open?.id ?? null };
}

const PrepareInput = z.object({ period: PERIOD, demo: z.boolean().default(false), notes: OptionalNote, idempotencyKey: KeySchema });

/** Prepares the draft run of a month (staff.payroll.run): computes the month's commissions first, then the pay. */
export async function prepareRun(db: Db, actor: Actor, raw: z.input<typeof PrepareInput>, now: number): Promise<{ runId: string; replayed: boolean; employees: number }> {
  assertAny(actor, ["staff.payroll.run"]);
  assertWholeStore(actor);
  const input = PrepareInput.parse(raw);
  const current = periodOf(now);
  if (input.period > current) throw invalid({ period: "period_future" });
  if (input.period < shiftPeriod(current, -12)) throw invalid({ period: "period_too_old" });
  const runId = `${input.demo ? "pyd" : "pyr"}_${(await sha256Hex(`tamtam.payroll.run.v1|${stamp(actor)}|${input.idempotencyKey}`)).slice(0, 26)}`;
  const replayOf = async () => {
    const existing = await db.select({ id: payrollRuns.id, period: payrollRuns.period }).from(payrollRuns).where(eq(payrollRuns.id, runId)).get();
    if (!existing) return null;
    if (existing.period !== input.period) throw new AppError("idempotency_mismatch", 409);
    const count = await db.select({ n: sql<number>`count(*)` }).from(payrollItems).where(eq(payrollItems.runId, runId)).get();
    return { runId, replayed: true, employees: Number(count?.n ?? 0) };
  };
  const earlier = await replayOf();
  if (earlier) return earlier;
  const prefix = input.demo ? "pyd\\_%" : "pyr\\_%";
  const open = await db
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.period, input.period), inArray(payrollRuns.status, ["draft", "approved"]), sql`${payrollRuns.id} LIKE ${prefix} ESCAPE '\\'`))
    .get();
  if (open) throw new AppError("run_open_exists", 409, { detail: open.id });
  await syncCommissions(db, actor, { period: shiftPeriod(input.period, -1) }, now);
  await syncCommissions(db, actor, { period: input.period }, now);
  const plan = await planRun(db, { period: input.period, demo: input.demo }, now);
  if (!plan.items.length) throw new AppError("run_empty", 409);
  const totals = planTotals(plan.items);
  const rows = itemRows(runId, plan.items);
  try {
    await runBatch(db, [
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM payroll_runs WHERE period = ${input.period} AND status IN ('draft', 'approved') AND id LIKE ${prefix} ESCAPE '\\')`, { code: "RUN_OPEN_EXISTS", detail: input.period }),
      db.insert(payrollRuns).values({ id: runId, period: input.period, status: "draft", totalGrossIqd: totals.baseIqd + totals.commissionIqd + totals.bonusIqd, totalNetIqd: totals.netIqd, notes: input.notes, createdBy: stamp(actor), createdAt: now }),
      ...chunkRows(payrollItems, rows).map((part) => db.insert(payrollItems).values(part)),
      ...linkStatements(
        db,
        runId,
        plan.items.flatMap((item) => item.commissionIds),
        plan.items.flatMap((item) => item.advanceIds),
      ),
      auditStatement(db, {
        actor,
        action: "staff.payroll.run_prepare",
        entityType: "payroll_run",
        entityId: runId,
        summary: `${input.period}: ${plan.items.length} employee(s)`,
        after: { period: input.period, demo: input.demo, employees: plan.items.length, ...totals },
        reason: input.notes,
        at: now,
      }),
    ]);
  } catch (error) {
    const again = await replayOf().catch(() => null);
    if (again) return again;
    if (isUniqueViolation(error)) throw new AppError("run_open_exists", 409);
    translateRunError(error);
  }
  return { runId, replayed: false, employees: plan.items.length };
}

async function runById(db: Db, runId: string): Promise<PayrollRun> {
  if (!/^py[rd]_[0-9a-f]{26}$/.test(runId)) throw notFound("payroll_run");
  const run = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).get();
  if (!run) throw notFound("payroll_run");
  return run;
}

/**
 * SQL: the instant the employee's (`employeeId`, a column) pay was last computed into a run that was then paid — the
 * latest preparation or recomputation of their last paid run other than `runId` (0 when none). A salary changed AFTER
 * that instant has not been paid by any run yet, so its author is involved in the next run that pays it. (The payment
 * itself is no boundary: a run computed before a raise and paid after it never paid the raise — review 2026-11-12.)
 */
function lastPaidComputationSql(employeeId: SQL, runId: string) {
  return sql`coalesce((SELECT max(max(r.created_at, coalesce((SELECT max(x.at) FROM audit_events AS x WHERE x.entity_type = 'payroll_run' AND x.entity_id = r.id AND x.action = 'staff.payroll.run_recompute'), 0)))
    FROM payroll_items AS pi JOIN payroll_runs AS r ON r.id = pi.run_id WHERE pi.employee_id = ${employeeId} AND r.status = 'paid' AND r.id <> ${runId}), 0)`;
}

/** The employees who may not approve a run: who prepared, recomputed or edited it, and who changed one of its salaries since that salary was last paid. */
export async function runInvolved(db: Db, run: PayrollRun): Promise<{ ids: Set<string>; salaryChangers: Map<string, string[]> }> {
  const ids = await participants(db, "payroll_run", run.id, RUN_PARTICIPANT_ACTIONS);
  if (run.createdBy && !run.createdBy.startsWith("system")) ids.add(run.createdBy);
  const changes = await db.all<{ employeeId: string; actorId: string }>(sql`
    SELECT a.entity_id AS employeeId, a.actor_id AS actorId FROM audit_events AS a
    JOIN payroll_items AS i ON i.employee_id = a.entity_id AND i.run_id = ${run.id}
    WHERE a.action = 'staff.payroll.salary_set' AND a.entity_type = 'employee' AND a.actor_kind = 'employee'
      AND a.at >= ${lastPaidComputationSql(sql`a.entity_id`, run.id)}`);
  const salaryChangers = new Map<string, string[]>();
  for (const change of changes) {
    ids.add(change.actorId);
    salaryChangers.set(change.employeeId, [...new Set([...(salaryChangers.get(change.employeeId) ?? []), change.actorId])]);
  }
  return { ids, salaryChangers };
}

/** SQL (for a guard inside the approval batch): the approver took part in the run or changed one of its salaries. */
function approverInvolvedSql(runId: string, approverId: string) {
  return sql`(${tookPartSql("payroll_run", runId, RUN_PARTICIPANT_ACTIONS, approverId)}
    OR EXISTS (SELECT 1 FROM payroll_runs WHERE id = ${runId} AND created_by = ${approverId})
    OR EXISTS (SELECT 1 FROM audit_events AS a JOIN payroll_items AS i ON i.employee_id = a.entity_id AND i.run_id = ${runId}
      WHERE a.action = 'staff.payroll.salary_set' AND a.entity_type = 'employee' AND a.actor_kind = 'employee' AND a.actor_id = ${approverId}
        AND a.at >= ${lastPaidComputationSql(sql`a.entity_id`, runId)}))`;
}

export type RunDetail = {
  /** paidBy: who paid it (the run's payment audit event), null before payment. */
  run: RunRow & { notes: string | null; paidBy: ByView | null };
  items: RunItemView[];
  totals: PayrollRunTotals;
  /** A draft only: what recomputing it now would change (null when it is up to date, or not a draft). */
  stale: { netNowIqd: number; employeesNow: number } | null;
  /** A draft only: employees left out because they have nothing to be paid. */
  excluded: (PersonRef & { reason: "no_pay" })[];
  /** Payroll already recorded as finance expenses in this month (it would be counted twice). */
  payrollExpenses: { count: number; iqd: number };
  involved: { me: boolean; names: string[] };
  blockers: { netNegative: number };
  can: { edit: boolean; approve: boolean; pay: boolean; void: boolean; journal: boolean };
};

/** One run with its items (staff.payroll.read, .run or .approve); a draft also shows how each base was reached. */
export async function getRun(db: Db, actor: Actor, runId: string, now: number): Promise<RunDetail> {
  assertAny(actor, VIEWERS);
  assertWholeStore(actor);
  const run = await runById(db, runId);
  const items = await db.select().from(payrollItems).where(eq(payrollItems.runId, run.id)).orderBy(asc(payrollItems.id));
  const employeeIds = items.map((item) => item.employeeId);
  const [advances, commissionCounts, involved, expenses, facts, payer] = await Promise.all([
    db.select().from(employeeAdvances).where(eq(employeeAdvances.settledRunId, run.id)).orderBy(asc(employeeAdvances.givenAt)),
    db.select({ employeeId: commissions.employeeId, n: sql<number>`count(*)` }).from(commissions).where(eq(commissions.payrollRunId, run.id)).groupBy(commissions.employeeId),
    runInvolved(db, run),
    db.all<{ n: number; iqd: number }>(sql`SELECT count(*) AS n, coalesce(sum(amount_iqd), 0) AS iqd FROM expenses WHERE status = 'posted' AND period = ${run.period}
      AND account_id IN (SELECT id FROM accounts WHERE system_key = 'payroll' OR parent_id IN (SELECT id FROM accounts WHERE system_key = 'payroll'))`),
    employeeIds.length ? db.select({ id: employees.id, baseSalaryIqd: employees.baseSalaryIqd }).from(employees).where(inArray(employees.id, employeeIds)) : Promise.resolve([]),
    run.status === "paid"
      ? db.all<{ actorId: string | null }>(sql`SELECT actor_id AS actorId FROM audit_events WHERE action = 'staff.payroll.run_pay' AND entity_type = 'payroll_run' AND entity_id = ${run.id} ORDER BY at DESC LIMIT 1`)
      : Promise.resolve([]),
  ]);
  const paidById = payer[0]?.actorId ?? null;
  const people = await peopleById(db, [...employeeIds, run.createdBy, run.approvedBy, paidById, ...involved.ids]);
  const plan =
    run.status === "draft"
      ? await planRun(db, { period: run.period, demo: isDemoRun(run.id), runId: run.id, runCreatedAt: run.createdAt, keep: new Map(items.map((item) => [item.employeeId, { bonusIqd: item.bonusIqd, otherDeductionIqd: item.otherDeductionIqd, notes: item.notes }])) }, now)
      : null;
  const planned = new Map((plan?.items ?? []).map((item) => [item.employee.id, item]));
  const month = monthDays(run.period);
  const salaryOf = new Map(facts.map((row) => [row.id, row.baseSalaryIqd]));
  const me = actorId(actor);
  const views: RunItemView[] = items.map((item: PayrollItem) => {
    const person = people.get(item.employeeId);
    const basis = planned.get(item.employeeId);
    return {
      employee: { id: item.employeeId, name: person?.name ?? item.employeeId, isDemo: person?.isDemo ?? false, jobTitle: person?.jobTitle ?? null, status: person?.status ?? "active" },
      baseIqd: item.baseIqd,
      commissionIqd: item.commissionIqd,
      bonusIqd: item.bonusIqd,
      advanceDeductionIqd: item.advanceDeductionIqd,
      otherDeductionIqd: item.otherDeductionIqd,
      netIqd: item.netIqd,
      notes: item.notes,
      basis: basis
        ? { monthlyIqd: basis.monthlyIqd, payableDays: basis.payableDays, monthDays: basis.monthDays, unpaidLeaveDays: basis.unpaidLeaveDays, paidElsewhereIqd: basis.paidElsewhereIqd }
        : { monthlyIqd: salaryOf.get(item.employeeId) ?? null, payableDays: 0, monthDays: month.count, unpaidLeaveDays: 0, paidElsewhereIqd: 0 },
      advances: advances.filter((row) => row.employeeId === item.employeeId).map((row) => ({ id: row.id, amountIqd: row.amountIqd, givenAt: row.givenAt, reason: row.reason })),
      commissionRows: Number(commissionCounts.find((row) => row.employeeId === item.employeeId)?.n ?? 0),
      salaryChangedAt: involved.salaryChangers.has(item.employeeId) ? run.createdAt : null,
    };
  });
  const totals = planTotals(views);
  const planTotal = plan ? planTotals(plan.items) : null;
  const stale = plan && planTotal && (planTotal.netIqd !== totals.netIqd || plan.items.length !== views.length) ? { netNowIqd: planTotal.netIqd, employeesNow: plan.items.length } : null;
  const isMe = me !== null && (involved.ids.has(me) || employeeIds.includes(me));
  return {
    run: { ...runRowOf(run, items.length, people), notes: run.notes, paidBy: run.status === "paid" ? byView(people, paidById) : null },
    items: views,
    totals,
    stale,
    excluded: plan?.excluded ?? [],
    payrollExpenses: { count: Number(expenses[0]?.n ?? 0), iqd: Number(expenses[0]?.iqd ?? 0) },
    involved: { me: isMe, names: [...involved.ids].map((id) => people.get(id)?.name ?? id) },
    blockers: { netNegative: views.filter((item) => item.netIqd < 0).length },
    can: {
      edit: run.status === "draft" && can(actor, "staff.payroll.run"),
      approve: run.status === "draft" && can(actor, "staff.payroll.approve") && !isMe,
      pay: run.status === "approved" && can(actor, "staff.payroll.approve"),
      void: (run.status === "draft" && can(actor, "staff.payroll.run")) || (run.status === "approved" && can(actor, "staff.payroll.approve")),
      journal: run.journalEntryId !== null && can(actor, "finance.journal.read") && can(actor, "cost.read"),
    },
  };
}

const RunTarget = z.object({ runId: IdSchema });

/** Recomputes a draft (staff.payroll.run): new commissions, salaries, leave and advances; bonuses and deductions kept. */
export async function recomputeRun(db: Db, actor: Actor, raw: z.input<typeof RunTarget>, now: number): Promise<{ employees: number; netIqd: number }> {
  assertAny(actor, ["staff.payroll.run"]);
  assertWholeStore(actor);
  const input = RunTarget.parse(raw);
  const run = await runById(db, input.runId);
  if (run.status !== "draft") throw new AppError("run_not_draft", 409);
  await syncCommissions(db, actor, { period: shiftPeriod(run.period, -1) }, now);
  await syncCommissions(db, actor, { period: run.period }, now);
  const existing = await db.select().from(payrollItems).where(eq(payrollItems.runId, run.id));
  const keep: Keep = new Map(existing.map((item) => [item.employeeId, { bonusIqd: item.bonusIqd, otherDeductionIqd: item.otherDeductionIqd, notes: item.notes }]));
  const plan = await planRun(db, { period: run.period, demo: isDemoRun(run.id), runId: run.id, runCreatedAt: run.createdAt, keep }, now);
  if (!plan.items.length) throw new AppError("run_empty", 409);
  const totals = planTotals(plan.items);
  try {
    await runBatch(db, [
      db.update(payrollRuns).set({ notes: run.notes }).where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.status, "draft"))),
      expectChanged(db, 1, { code: "RUN_NOT_DRAFT", detail: run.id }),
      db
        .update(commissions)
        .set({ payrollRunId: null })
        .where(and(eq(commissions.payrollRunId, run.id), eq(commissions.status, "accrued"))),
      db
        .update(employeeAdvances)
        .set({ settledRunId: null })
        .where(and(eq(employeeAdvances.settledRunId, run.id), eq(employeeAdvances.status, "open"))),
      db.delete(payrollItems).where(eq(payrollItems.runId, run.id)),
      ...chunkRows(payrollItems, itemRows(run.id, plan.items)).map((part) => db.insert(payrollItems).values(part)),
      ...linkStatements(
        db,
        run.id,
        plan.items.flatMap((item) => item.commissionIds),
        plan.items.flatMap((item) => item.advanceIds),
      ),
      totalsStatement(db, run.id),
      auditStatement(db, { actor, action: "staff.payroll.run_recompute", entityType: "payroll_run", entityId: run.id, after: { employees: plan.items.length, ...totals }, at: now }),
    ]);
  } catch (error) {
    translateRunError(error);
  }
  return { employees: plan.items.length, netIqd: totals.netIqd };
}

const ItemInput = z.object({
  runId: IdSchema,
  employeeId: IdSchema,
  bonusIqd: wholeIqd(MAX_PAY_IQD),
  otherDeductionIqd: wholeIqd(MAX_PAY_IQD),
  notes: z
    .string()
    .overwrite(cleanLine)
    .max(300, "too_long")
    .nullish()
    .transform((value) => value || null),
  /** The item's net pay as the form showed it. */
  expectedNetIqd: z.number().int(),
});

/** A bonus or another deduction on a draft's line (staff.payroll.run), with a note; never taking the pay below zero. */
export async function updateItem(db: Db, actor: Actor, raw: z.input<typeof ItemInput>, now: number): Promise<{ netIqd: number }> {
  assertAny(actor, ["staff.payroll.run"]);
  assertWholeStore(actor);
  const input = ItemInput.parse(raw);
  const run = await runById(db, input.runId);
  if (run.status !== "draft") throw new AppError("run_not_draft", 409);
  const item = await db.select().from(payrollItems).where(and(eq(payrollItems.runId, run.id), eq(payrollItems.employeeId, input.employeeId))).get();
  if (!item) throw notFound("payroll_item");
  if (item.netIqd !== input.expectedNetIqd) throw new AppError("run_changed", 409);
  if ((input.bonusIqd > 0 || input.otherDeductionIqd > 0) && (!input.notes || input.notes.length < 3)) throw invalid({ notes: "reason_required" });
  const net = item.baseIqd + item.commissionIqd + input.bonusIqd - item.advanceDeductionIqd - input.otherDeductionIqd;
  if (net < 0) throw invalid({ otherDeductionIqd: "net_negative" });
  try {
    await runBatch(db, [
      db
        .update(payrollItems)
        .set({ bonusIqd: input.bonusIqd, otherDeductionIqd: input.otherDeductionIqd, netIqd: net, notes: input.notes })
        .where(and(eq(payrollItems.id, item.id), eq(payrollItems.netIqd, item.netIqd), eq(payrollItems.bonusIqd, item.bonusIqd), eq(payrollItems.otherDeductionIqd, item.otherDeductionIqd))),
      expectChanged(db, 1, { code: "RUN_CHANGED", detail: item.id }),
      expectThat(db, sql`EXISTS (SELECT 1 FROM payroll_runs WHERE id = ${run.id} AND status = 'draft')`, { code: "RUN_NOT_DRAFT", detail: run.id }),
      totalsStatement(db, run.id),
      auditStatement(db, {
        actor,
        action: "staff.payroll.item_update",
        entityType: "payroll_run",
        entityId: run.id,
        summary: `${input.employeeId}`,
        before: { employeeId: input.employeeId, bonusIqd: item.bonusIqd, otherDeductionIqd: item.otherDeductionIqd, netIqd: item.netIqd, notes: item.notes },
        after: { employeeId: input.employeeId, bonusIqd: input.bonusIqd, otherDeductionIqd: input.otherDeductionIqd, netIqd: net, notes: input.notes },
        reason: input.notes,
        at: now,
      }),
    ]);
  } catch (error) {
    translateRunError(error);
  }
  return { netIqd: net };
}

const DeferInput = z.object({ runId: IdSchema, advanceId: IdSchema, reason: Reason });

/** Leaves an advance out of a draft (staff.payroll.run): it stays open for a later run. */
export async function deferAdvance(db: Db, actor: Actor, raw: z.input<typeof DeferInput>, now: number): Promise<{ netIqd: number }> {
  assertAny(actor, ["staff.payroll.run"]);
  assertWholeStore(actor);
  const input = DeferInput.parse(raw);
  const run = await runById(db, input.runId);
  if (run.status !== "draft") throw new AppError("run_not_draft", 409);
  const advance = await db.select().from(employeeAdvances).where(eq(employeeAdvances.id, input.advanceId)).get();
  if (!advance || advance.settledRunId !== run.id || advance.status !== "open") throw new AppError("advance_not_in_run", 409);
  const item = await db.select().from(payrollItems).where(and(eq(payrollItems.runId, run.id), eq(payrollItems.employeeId, advance.employeeId))).get();
  if (!item || item.advanceDeductionIqd < advance.amountIqd) throw new AppError("advance_not_in_run", 409);
  try {
    await runBatch(db, [
      db
        .update(employeeAdvances)
        .set({ settledRunId: null })
        .where(and(eq(employeeAdvances.id, advance.id), eq(employeeAdvances.settledRunId, run.id), eq(employeeAdvances.status, "open"))),
      expectChanged(db, 1, { code: "RUN_CHANGED", detail: advance.id }),
      db
        .update(payrollItems)
        .set({ advanceDeductionIqd: sql`${payrollItems.advanceDeductionIqd} - ${advance.amountIqd}`, netIqd: sql`${payrollItems.netIqd} + ${advance.amountIqd}` })
        .where(and(eq(payrollItems.id, item.id), sql`${payrollItems.advanceDeductionIqd} >= ${advance.amountIqd}`)),
      expectChanged(db, 1, { code: "RUN_CHANGED", detail: item.id }),
      expectThat(db, sql`EXISTS (SELECT 1 FROM payroll_runs WHERE id = ${run.id} AND status = 'draft')`, { code: "RUN_NOT_DRAFT", detail: run.id }),
      totalsStatement(db, run.id),
      auditStatement(db, { actor, action: "staff.payroll.advance_defer", entityType: "payroll_run", entityId: run.id, after: { advanceId: advance.id, employeeId: advance.employeeId, amountIqd: advance.amountIqd }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    translateRunError(error);
  }
  return { netIqd: item.netIqd + advance.amountIqd };
}

const ApproveInput = z.object({ runId: IdSchema, expectedNetIqd: z.number().int(), expectedItems: z.number().int().min(1), note: OptionalNote });

/** Approves a draft (staff.payroll.approve) — someone who took no part in it, approving exactly what they saw. */
export async function approveRun(db: Db, actor: Actor, raw: z.input<typeof ApproveInput>, now: number): Promise<{ status: "approved" }> {
  assertAny(actor, ["staff.payroll.approve"]);
  assertWholeStore(actor);
  const input = ApproveInput.parse(raw);
  const run = await runById(db, input.runId);
  if (run.status !== "draft") throw new AppError("run_not_draft", 409);
  const me = actorId(actor) ?? stamp(actor);
  const involved = await runInvolved(db, run);
  const items = await db.select().from(payrollItems).where(eq(payrollItems.runId, run.id));
  // a participant never approves, nor someone the run pays
  if (involved.ids.has(me) || items.some((item) => item.employeeId === me)) throw new AppError("run_self_approval", 403);
  const net = items.reduce((sum, item) => sum + item.netIqd, 0);
  if (items.length !== input.expectedItems || net !== input.expectedNetIqd) throw new AppError("run_changed", 409);
  if (items.some((item) => item.netIqd < 0)) throw new AppError("net_negative", 409);
  try {
    await runBatch(db, [
      expectThat(db, sql`NOT ${approverInvolvedSql(run.id, me)} AND NOT EXISTS (SELECT 1 FROM payroll_items WHERE run_id = ${run.id} AND employee_id = ${me})`, { code: "RUN_SELF_APPROVAL", detail: run.id }),
      expectThat(db, sql`(SELECT count(*) FROM payroll_items WHERE run_id = ${run.id}) = ${input.expectedItems} AND (SELECT coalesce(sum(net_iqd), 0) FROM payroll_items WHERE run_id = ${run.id}) = ${input.expectedNetIqd}`, { code: "RUN_CHANGED", detail: run.id }),
      db
        .update(payrollRuns)
        .set({ status: "approved", approvedBy: me, approvedAt: now })
        .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.status, "draft"))),
      expectChanged(db, 1, { code: "RUN_NOT_DRAFT", detail: run.id }),
      db
        .update(commissions)
        .set({ status: "approved" })
        .where(and(eq(commissions.payrollRunId, run.id), eq(commissions.status, "accrued"))),
      auditStatement(db, { actor, action: "staff.payroll.run_approve", entityType: "payroll_run", entityId: run.id, summary: runRef(run), before: { status: "draft" }, after: { status: "approved", employees: items.length, netIqd: net }, reason: input.note, at: now }),
    ]);
  } catch (error) {
    translateRunError(error);
  }
  return { status: "approved" };
}

const PayInput = z.object({
  runId: IdSchema,
  paidFrom: z.enum(PAYROLL_PAID_FROM, { error: "required" }),
  reference: z
    .string()
    .overwrite(cleanLine)
    .max(80, "too_long")
    .nullish()
    .transform((value) => value || null),
});

/**
 * Pays an approved run (staff.payroll.approve): approved → paid, the posting (Dr payroll and commissions, Cr cash or
 * bank clearing), its commissions paid and its advances settled — one batch. Paying a paid run again is a replay.
 */
export async function payRun(db: Db, actor: Actor, raw: z.input<typeof PayInput>, now: number): Promise<{ status: "paid"; journalEntryId: string | null; replayed: boolean }> {
  assertAny(actor, ["staff.payroll.approve"]);
  assertWholeStore(actor);
  const input = PayInput.parse(raw);
  const run = await runById(db, input.runId);
  if (run.status === "paid") return { status: "paid", journalEntryId: run.journalEntryId, replayed: true };
  if (run.status !== "approved") throw new AppError("run_not_approved", 409);
  const items = await db.select().from(payrollItems).where(eq(payrollItems.runId, run.id));
  const totals = planTotals(items);
  const entryId = newId("je");
  const posting = postPayrollRun(db, { entryId, runId: run.id, ref: runRef(run), period: run.period, paidFrom: input.paidFrom, totals, at: now, createdBy: postedBy(actor), isDemo: isDemoRun(run.id) });
  const journalEntryId = posting.length ? entryId : null;
  try {
    await runBatch(db, [
      db
        .update(payrollRuns)
        .set({ status: "paid", paidAt: now, journalEntryId })
        .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.status, "approved"))),
      expectChanged(db, 1, { code: "RUN_NOT_APPROVED", detail: run.id }),
      expectThat(db, sql`(SELECT count(*) FROM payroll_items WHERE run_id = ${run.id}) = ${items.length} AND (SELECT coalesce(sum(net_iqd), 0) FROM payroll_items WHERE run_id = ${run.id}) = ${totals.netIqd}`, { code: "RUN_CHANGED", detail: run.id }),
      db
        .update(commissions)
        .set({ status: "paid" })
        .where(and(eq(commissions.payrollRunId, run.id), eq(commissions.status, "approved"))),
      db
        .update(employeeAdvances)
        .set({ status: "settled", settledAt: now })
        .where(and(eq(employeeAdvances.settledRunId, run.id), eq(employeeAdvances.status, "open"))),
      expectThat(db, sql`(SELECT coalesce(sum(amount_iqd), 0) FROM employee_advances WHERE settled_run_id = ${run.id} AND status = 'settled') = ${totals.advanceDeductionIqd}`, { code: "RUN_CHANGED", detail: run.id }),
      ...posting,
      auditStatement(db, {
        actor,
        action: "staff.payroll.run_pay",
        entityType: "payroll_run",
        entityId: run.id,
        summary: runRef(run),
        before: { status: "approved" },
        after: { status: "paid", paidFrom: input.paidFrom, reference: input.reference, journalEntryId, netIqd: totals.netIqd, commissionIqd: totals.commissionIqd, advanceDeductionIqd: totals.advanceDeductionIqd },
        at: now,
      }),
    ]);
  } catch (error) {
    const after = await db.select({ status: payrollRuns.status, journalEntryId: payrollRuns.journalEntryId }).from(payrollRuns).where(eq(payrollRuns.id, run.id)).get();
    if (after?.status === "paid") return { status: "paid", journalEntryId: after.journalEntryId, replayed: true };
    translateRunError(error);
  }
  return { status: "paid", journalEntryId, replayed: false };
}

const VoidInput = z.object({ runId: IdSchema, reason: Reason });

/** Voids a run that is not paid (a draft: staff.payroll.run; an approved one: staff.payroll.approve); its commissions and advances are freed. */
export async function voidRun(db: Db, actor: Actor, raw: z.input<typeof VoidInput>, now: number): Promise<{ status: "void" }> {
  assertAny(actor, ["staff.payroll.run", "staff.payroll.approve"]);
  assertWholeStore(actor);
  const input = VoidInput.parse(raw);
  const run = await runById(db, input.runId);
  if (run.status === "draft") assertAny(actor, ["staff.payroll.run"]);
  else if (run.status === "approved") assertAny(actor, ["staff.payroll.approve"]);
  else throw new AppError("run_not_draft", 409);
  try {
    await runBatch(db, [
      db
        .update(payrollRuns)
        .set({ status: "void" })
        .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.status, run.status))),
      expectChanged(db, 1, { code: "RUN_CHANGED", detail: run.id }),
      db
        .update(commissions)
        .set({ payrollRunId: null, status: "accrued" })
        .where(and(eq(commissions.payrollRunId, run.id), inArray(commissions.status, ["accrued", "approved"]))),
      db
        .update(employeeAdvances)
        .set({ settledRunId: null })
        .where(and(eq(employeeAdvances.settledRunId, run.id), eq(employeeAdvances.status, "open"))),
      auditStatement(db, { actor, action: "staff.payroll.run_void", entityType: "payroll_run", entityId: run.id, summary: runRef(run), before: { status: run.status }, after: { status: "void" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    translateRunError(error);
  }
  return { status: "void" };
}

/** The signed-in employee's own pay: their lines of paid and approved runs, newest first, and their open advances. */
export async function myPay(db: Db, actor: Actor): Promise<{ lines: (Pick<PayrollItem, "baseIqd" | "commissionIqd" | "bonusIqd" | "advanceDeductionIqd" | "otherDeductionIqd" | "netIqd" | "notes"> & { runId: string; period: string; status: string; paidAt: number | null })[]; openAdvancesIqd: number }> {
  const me = actorId(actor);
  if (!me) return { lines: [], openAdvancesIqd: 0 };
  const [lines, open] = await Promise.all([
    db
      .select({
        runId: payrollRuns.id,
        period: payrollRuns.period,
        status: payrollRuns.status,
        paidAt: payrollRuns.paidAt,
        baseIqd: payrollItems.baseIqd,
        commissionIqd: payrollItems.commissionIqd,
        bonusIqd: payrollItems.bonusIqd,
        advanceDeductionIqd: payrollItems.advanceDeductionIqd,
        otherDeductionIqd: payrollItems.otherDeductionIqd,
        netIqd: payrollItems.netIqd,
        notes: payrollItems.notes,
      })
      .from(payrollItems)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.runId))
      .where(and(eq(payrollItems.employeeId, me), inArray(payrollRuns.status, ["approved", "paid"])))
      .orderBy(desc(payrollRuns.period))
      .limit(12),
    db.select({ n: sql<number>`coalesce(sum(${employeeAdvances.amountIqd}), 0)` }).from(employeeAdvances).where(and(eq(employeeAdvances.employeeId, me), eq(employeeAdvances.status, "open"))).get(),
  ]);
  return { lines, openAdvancesIqd: Number(open?.n ?? 0) };
}

// ───────────────────────────────────────────────────────────────── advances

export type AdvancePage = { rows: AdvanceRow[]; total: number; page: number; pageCount: number; counts: { pending: number; openIqd: number }; can: { request: boolean; decide: boolean } };

type ApprovalRow = typeof approvals.$inferSelect;

/** Advance requests and handed-out advances, newest first; filters in the URL. */
export async function listAdvances(db: Db, actor: Actor, filters: AdvanceFilters): Promise<AdvancePage> {
  assertAny(actor, VIEWERS);
  const me = actorId(actor);
  const limit = branchLimit(actor);
  // an employee limited to a branch sees the advances of that branch's staff only (the figures too)
  const reach = (column: string) => (limit ? sql`AND ${sql.raw(column)} IN (SELECT reach.id FROM employees AS reach WHERE reach.branch_id = ${limit})` : sql``);
  const want = (status: AdvanceStatusKey) => !filters.status || filters.status === status;
  const [requests, given, counts] = await Promise.all([
    want("pending") || want("rejected")
      ? db
          .select()
          .from(approvals)
          .where(and(eq(approvals.kind, ADVANCE_APPROVAL_KIND), filters.status === "pending" ? eq(approvals.status, "pending") : filters.status === "rejected" ? eq(approvals.status, "rejected") : inArray(approvals.status, ["pending", "rejected"]), filters.employee ? eq(approvals.entityId, filters.employee) : undefined, reachSql(actor, approvals.entityId)))
          .orderBy(desc(approvals.createdAt))
          .limit(200)
      : Promise.resolve([] as ApprovalRow[]),
    want("open") || want("settled")
      ? db
          .select()
          .from(employeeAdvances)
          .where(and(filters.status === "open" ? eq(employeeAdvances.status, "open") : filters.status === "settled" ? eq(employeeAdvances.status, "settled") : inArray(employeeAdvances.status, ["open", "settled"]), filters.employee ? eq(employeeAdvances.employeeId, filters.employee) : undefined, reachSql(actor, employeeAdvances.employeeId)))
          .orderBy(desc(employeeAdvances.givenAt))
          .limit(200)
      : Promise.resolve([] as (typeof employeeAdvances.$inferSelect)[]),
    db.all<{ pending: number; open: number }>(sql`SELECT
        (SELECT count(*) FROM approvals WHERE kind = ${ADVANCE_APPROVAL_KIND} AND status = 'pending' ${reach("entity_id")}) AS pending,
        coalesce((SELECT sum(amount_iqd) FROM employee_advances WHERE status = 'open' ${reach("employee_id")}), 0) AS open`),
  ]);
  const approvalsOf = given.length ? await db.select().from(approvals).where(inArray(approvals.id, given.map((row) => `apv_${row.id.slice(4)}`))) : [];
  const runs = given.some((row) => row.settledRunId) ? await db.select({ id: payrollRuns.id, period: payrollRuns.period }).from(payrollRuns).where(inArray(payrollRuns.id, given.filter((row) => row.settledRunId).map((row) => row.settledRunId as string))) : [];
  const people = await peopleById(db, [...requests.map((row) => row.entityId), ...requests.map((row) => row.requestedBy), ...requests.map((row) => row.decidedBy), ...given.map((row) => row.employeeId), ...given.map((row) => row.givenBy), ...approvalsOf.map((row) => row.requestedBy)]);
  const decide = can(actor, "staff.payroll.approve");
  const rows: AdvanceRow[] = [
    ...requests.map((row): AdvanceRow => {
      const payload = (row.payload ?? {}) as { amountIqd?: number; paidFrom?: string };
      const employeeId = row.entityId ?? "";
      return {
        id: row.id,
        kind: "request",
        employee: personOf(people, employeeId),
        amountIqd: Number(payload.amountIqd ?? 0),
        reason: row.reason,
        status: row.status === "pending" ? "pending" : "rejected",
        paidFrom: payload.paidFrom === "cash" || payload.paidFrom === "bank_clearing" ? payload.paidFrom : null,
        requestedBy: byView(people, row.requestedBy),
        decidedBy: row.decidedBy ? byView(people, row.decidedBy) : null,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        settledRun: null,
        canDecide: row.status === "pending" && decide && me !== row.requestedBy && me !== employeeId,
        canWithdraw: row.status === "pending" && me === row.requestedBy,
      };
    }),
    ...given.map((row): AdvanceRow => {
      const request = approvalsOf.find((item) => item.id === `apv_${row.id.slice(4)}`);
      const payload = (request?.payload ?? {}) as { paidFrom?: string };
      const settled = runs.find((run) => run.id === row.settledRunId);
      return {
        id: row.id,
        kind: "advance",
        employee: personOf(people, row.employeeId),
        amountIqd: row.amountIqd,
        reason: row.reason,
        status: row.status === "settled" ? "settled" : "open",
        paidFrom: payload.paidFrom === "cash" || payload.paidFrom === "bank_clearing" ? payload.paidFrom : null,
        requestedBy: byView(people, request?.requestedBy),
        decidedBy: byView(people, row.givenBy),
        createdAt: row.givenAt,
        decidedAt: row.givenAt,
        settledRun: settled && row.status === "settled" ? settled : null,
        canDecide: false,
        canWithdraw: false,
      };
    }),
  ].sort((a, b) => b.createdAt - a.createdAt);
  const total = rows.length;
  const start = (filters.page - 1) * PAGE_SIZE;
  return {
    rows: rows.slice(start, start + PAGE_SIZE),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: { pending: Number(counts[0]?.pending ?? 0), openIqd: Number(counts[0]?.open ?? 0) },
    can: { request: can(actor, "staff.payroll.run"), decide },
  };
}

const RequestInput = z.object({
  employeeId: IdSchema,
  amountIqd: wholeIqd(MAX_PAY_IQD).refine((value) => value > 0, "too_small"),
  paidFrom: z.enum(PAYROLL_PAID_FROM, { error: "required" }),
  reason: Reason,
  idempotencyKey: KeySchema,
});

/** Asks for a salary advance for an employee (staff.payroll.run): a pending request another person decides. */
export async function requestAdvance(db: Db, actor: Actor, raw: z.input<typeof RequestInput>, now: number): Promise<{ approvalId: string; replayed: boolean }> {
  assertAny(actor, ["staff.payroll.run"]);
  const input = RequestInput.parse(raw);
  const approvalId = `apv_${(await sha256Hex(`tamtam.staff.advance.v1|${stamp(actor)}|${input.idempotencyKey}`)).slice(0, 26)}`;
  const replayOf = async () => {
    const existing = await db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    if (!existing) return null;
    const payload = (existing.payload ?? {}) as { amountIqd?: number };
    if (existing.entityId !== input.employeeId || payload.amountIqd !== input.amountIqd) throw new AppError("idempotency_mismatch", 409);
    return { approvalId, replayed: true };
  };
  const earlier = await replayOf();
  if (earlier) return earlier;
  const employee = await db.select({ id: employees.id, name: employees.name, status: employees.status, branchId: employees.branchId }).from(employees).where(eq(employees.id, input.employeeId)).get();
  if (!employee) throw notFound("employee");
  assertReach(actor, employee);
  if (employee.status !== "active") throw new AppError("employee_inactive", 409, { fields: { employeeId: "employee_inactive" } });
  try {
    await runBatch(db, [
      db.insert(approvals).values({
        id: approvalId,
        kind: ADVANCE_APPROVAL_KIND,
        entityType: "employee",
        entityId: employee.id,
        requestedBy: stamp(actor),
        payload: { amountIqd: input.amountIqd, paidFrom: input.paidFrom },
        status: "pending",
        reason: input.reason,
        requiredPermission: "staff.payroll.approve",
        createdAt: now,
      }),
      auditStatement(db, { actor, action: "staff.payroll.advance_request", entityType: "employee", entityId: employee.id, summary: approvalId, after: { approvalId, amountIqd: input.amountIqd, paidFrom: input.paidFrom }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    const again = await replayOf().catch(() => null);
    if (again) return again;
    throw error;
  }
  return { approvalId, replayed: false };
}

const DecideInput = z.object({ approvalId: IdSchema, decision: z.enum(["approve", "reject"]), note: OptionalNote });

/**
 * Decides an advance request (staff.payroll.approve): never the requester (approver_is_requester), never the employee
 * it is for (advance_beneficiary). Approving hands it out — the advance row and its posting in one batch.
 */
export async function decideAdvance(db: Db, actor: Actor, raw: z.input<typeof DecideInput>, now: number): Promise<{ status: "approved" | "rejected"; advanceId: string | null; journalEntryId: string | null }> {
  assertAny(actor, ["staff.payroll.approve"]);
  const input = DecideInput.parse(raw);
  const request = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, ADVANCE_APPROVAL_KIND))).get();
  if (!request) throw notFound("advance_request");
  const me = actorId(actor) ?? stamp(actor);
  if (request.requestedBy === me) throw new AppError("approver_is_requester", 403);
  if (request.entityId === me) throw new AppError("advance_beneficiary", 403);
  if (request.status !== "pending") throw new AppError("advance_not_pending", 409);
  if (input.decision === "reject" && (!input.note || input.note.length < 3)) throw invalid({ note: "reason_required" });
  const payload = (request.payload ?? {}) as { amountIqd?: number; paidFrom?: string };
  const amount = Number(payload.amountIqd ?? 0);
  const paidFrom = payload.paidFrom === "bank_clearing" ? "bank_clearing" : "cash";
  const employee = await db.select({ id: employees.id, name: employees.name, isDemo: employees.isDemo, branchId: employees.branchId }).from(employees).where(eq(employees.id, request.entityId ?? "")).get();
  if (!employee) throw notFound("employee");
  assertReach(actor, employee);
  const decided = [
    db
      .update(approvals)
      .set({ status: input.decision === "approve" ? "approved" : "rejected", decidedBy: me, decidedAt: now, decisionNote: input.note })
      .where(and(eq(approvals.id, request.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "ADVANCE_NOT_PENDING", detail: request.id }),
  ];
  if (input.decision === "reject") {
    try {
      await runBatch(db, [...decided, auditStatement(db, { actor, action: "staff.payroll.advance_reject", entityType: "employee", entityId: employee.id, summary: request.id, before: { status: "pending" }, after: { status: "rejected", amountIqd: amount }, reason: input.note, at: now })]);
    } catch (error) {
      if (isDbError(error, "ADVANCE_NOT_PENDING")) throw new AppError("advance_not_pending", 409);
      throw error;
    }
    return { status: "rejected", advanceId: null, journalEntryId: null };
  }
  const advanceId = `adv_${request.id.slice(4)}`;
  const entryId = newId("je");
  try {
    await runBatch(db, [
      ...decided,
      expectThat(db, sql`EXISTS (SELECT 1 FROM employees WHERE id = ${employee.id} AND status = 'active')`, { code: "EMPLOYEE_INACTIVE", detail: employee.id }),
      db.insert(employeeAdvances).values({ id: advanceId, employeeId: employee.id, amountIqd: amount, reason: request.reason, status: "open", givenBy: me, givenAt: now }),
      ...postEmployeeAdvance(db, { entryId, advanceId, amountIqd: amount, paidFrom, memo: `Salary advance (${advanceId})`, at: now, createdBy: postedBy(actor), isDemo: employee.isDemo }),
      auditStatement(db, { actor, action: "staff.payroll.advance_approve", entityType: "employee", entityId: employee.id, summary: request.id, before: { status: "pending" }, after: { status: "approved", advanceId, amountIqd: amount, paidFrom, journalEntryId: entryId }, reason: input.note, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "ADVANCE_NOT_PENDING")) throw new AppError("advance_not_pending", 409);
    if (isDbError(error, "EMPLOYEE_INACTIVE")) throw new AppError("employee_inactive", 409);
    const posting = mapPostingError(error);
    if (posting) throw posting;
    throw error;
  }
  return { status: "approved", advanceId, journalEntryId: entryId };
}

const WithdrawInput = z.object({ approvalId: IdSchema, reason: OptionalNote });

/** The requester withdraws their own pending advance request. */
export async function withdrawAdvance(db: Db, actor: Actor, raw: z.input<typeof WithdrawInput>, now: number): Promise<{ status: "rejected" }> {
  assertAny(actor, ["staff.payroll.run"]);
  const input = WithdrawInput.parse(raw);
  const request = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, ADVANCE_APPROVAL_KIND))).get();
  if (!request) throw notFound("advance_request");
  const me = actorId(actor) ?? stamp(actor);
  if (request.requestedBy !== me) throw new AppError("advance_not_yours", 403);
  if (request.status !== "pending") throw new AppError("advance_not_pending", 409);
  try {
    await runBatch(db, [
      db
        .update(approvals)
        .set({ status: "rejected", decidedBy: me, decidedAt: now, decisionNote: input.reason ?? "withdrawn" })
        .where(and(eq(approvals.id, request.id), eq(approvals.status, "pending"))),
      expectChanged(db, 1, { code: "ADVANCE_NOT_PENDING", detail: request.id }),
      auditStatement(db, { actor, action: "staff.payroll.advance_withdraw", entityType: "employee", entityId: request.entityId, summary: request.id, before: { status: "pending" }, after: { status: "withdrawn" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "ADVANCE_NOT_PENDING")) throw new AppError("advance_not_pending", 409);
    throw error;
  }
  return { status: "rejected" };
}

