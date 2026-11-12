/**
 * Admin module 15 — the front page's figures, each only for who may open the page behind it (null otherwise, never 0).
 * An employee limited to a branch counts that branch's staff only, as the lists behind the figures show them; the
 * advances "waiting" are those this employee may decide — never one they asked for or one for themselves (review
 * 2026-11-12: the card counted every pending advance).
 */
import { sql } from "drizzle-orm";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import { actorId, branchLimit, staffAccess } from "./shared.server";
import { ADVANCE_APPROVAL_KIND, baghdadDay, dayStart, DAY_MS, periodOf } from "./types";

export type StaffOverview = {
  staff: { active: number; disabled: number } | null;
  today: { shifts: number; clockedIn: number; onLeave: number } | null;
  leavePending: number | null;
  tasks: { open: number; overdue: number; mine: number };
  commissions: { period: string; netIqd: number; accruedIqd: number } | null;
  /** advancesPending: advance requests this employee may decide (staff.payroll.approve; 0 for the others). */
  payroll: { drafts: number; approved: number; advancesPending: number } | null;
  me: { clockedInSince: number | null };
};

export async function staffOverview(db: Db, actor: Actor, now: number): Promise<StaffOverview> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const access = staffAccess(actor);
  const limit = branchLimit(actor);
  const today = baghdadDay(now);
  const dayFrom = dayStart(today);
  const period = periodOf(now);
  // the staff within reach: everyone, or the staff of the branch a limited employee works in
  const staff = limit ? sql`AND branch_id = ${limit}` : sql``;
  const theirs = (column: string) => (limit ? sql`AND ${sql.raw(column)} IN (SELECT reach.id FROM employees AS reach WHERE reach.branch_id = ${limit})` : sql``);
  const [row] = await db.all<Record<string, number | null>>(sql`SELECT
      (SELECT count(*) FROM employees WHERE status = 'active' ${staff}) AS active,
      (SELECT count(*) FROM employees WHERE status = 'disabled' ${staff}) AS disabled,
      (SELECT count(*) FROM shifts WHERE status <> 'cancelled' AND starts_at >= ${dayFrom} AND starts_at < ${dayFrom + DAY_MS} ${theirs("employee_id")}) AS shiftsToday,
      (SELECT count(*) FROM attendance WHERE clock_out_at IS NULL ${theirs("employee_id")}) AS clockedIn,
      (SELECT count(*) FROM leave_requests WHERE status = 'approved' AND starts_on <= ${today} AND ends_on >= ${today} ${theirs("employee_id")}) AS onLeave,
      (SELECT count(*) FROM leave_requests WHERE status = 'pending' AND employee_id <> ${me} ${theirs("employee_id")}) AS leavePending,
      (SELECT count(*) FROM staff_tasks WHERE status IN ('open', 'in_progress') ${theirs("assigned_to")}) AS tasksOpen,
      (SELECT count(*) FROM staff_tasks WHERE status IN ('open', 'in_progress') AND due_at IS NOT NULL AND due_at < ${now} ${theirs("assigned_to")}) AS tasksOverdue,
      (SELECT count(*) FROM staff_tasks WHERE status IN ('open', 'in_progress') AND assigned_to = ${me}) AS tasksMine,
      (SELECT coalesce(sum(amount_iqd), 0) FROM commissions WHERE period = ${period} AND status <> 'void' ${theirs("employee_id")}) AS commissionNet,
      (SELECT coalesce(sum(amount_iqd), 0) FROM commissions WHERE status = 'accrued' AND payroll_run_id IS NULL ${theirs("employee_id")}) AS commissionAccrued,
      (SELECT count(*) FROM payroll_runs WHERE status = 'draft') AS drafts,
      (SELECT count(*) FROM payroll_runs WHERE status = 'approved') AS approved,
      (SELECT count(*) FROM approvals WHERE kind = ${ADVANCE_APPROVAL_KIND} AND status = 'pending' AND requested_by <> ${me} AND coalesce(entity_id, '') <> ${me} ${theirs("entity_id")}) AS advancesToDecide,
      (SELECT min(clock_in_at) FROM attendance WHERE employee_id = ${me} AND clock_out_at IS NULL) AS mySince`);
  const n = (key: string) => Number(row?.[key] ?? 0);
  const seesTeam = access.directory || access.roster;
  return {
    staff: access.directory ? { active: n("active"), disabled: n("disabled") } : null,
    today: seesTeam ? { shifts: n("shiftsToday"), clockedIn: n("clockedIn"), onLeave: n("onLeave") } : null,
    leavePending: access.leave ? n("leavePending") : null,
    tasks: { open: access.tasksView ? n("tasksOpen") : n("tasksMine"), overdue: access.tasksView ? n("tasksOverdue") : 0, mine: n("tasksMine") },
    commissions: access.commissionView ? { period, netIqd: n("commissionNet"), accruedIqd: n("commissionAccrued") } : null,
    // a branch-limited approver: no store-wide runs, but their branch's advances (advancesToDecide is scoped by theirs())
    payroll: access.payrollView || access.advancesView ? { drafts: access.payrollView ? n("drafts") : 0, approved: access.payrollView ? n("approved") : 0, advancesPending: can(actor, "staff.payroll.approve") ? n("advancesToDecide") : 0 } : null,
    me: { clockedInSince: row?.mySince === null || row?.mySince === undefined ? null : Number(row.mySince) },
  };
}
