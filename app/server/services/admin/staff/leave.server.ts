/**
 * Admin 15.02 — leave: an employee asks for leave (annual, sick, unpaid, other) for whole days; someone with
 * staff.leave.approve decides — never on their own leave (leave_self_decision, 403); approving cancels the employee's
 * planned shifts on those days in the same batch (the roster then shows the leave). Unpaid leave days reduce the
 * base salary of the payroll run of that month (payroll.server.ts). A leave approver may also record leave on
 * someone's behalf (still to be decided, by anyone but that employee).
 *
 * Rules: whole days "YYYY-MM-DD", at most MAX_LEAVE_DAYS per request, starting no more than LEAVE_BACKDATE_DAYS ago
 * (sick leave is often recorded afterwards) and no more than a year ahead; never overlapping a pending or approved
 * request of the same employee (held inside the batch). The employee withdraws a pending request; an approver cancels
 * an approved one that has not ended, with a reason.
 *
 * Errors: forbidden, not_found, invalid (fields), leave_overlap, leave_not_pending, leave_self_decision (403),
 * leave_not_cancellable, employee_inactive.
 */
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { leaveRequests, shifts } from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { actorId, activeEmployee, assertAny, assertReach, assertReachOf, branchLimit, employeeOptions, IdSchema, OptionalNote, participants, peopleById, personOf, reachSql, Reason } from "./shared.server";
import { addDays, baghdadDay, dayStart, daySpan, DAY_MS, isDay, LEAVE_BACKDATE_DAYS, LEAVE_KIND_LIST, MAX_LEAVE_DAYS, PAGE_SIZE, type LeaveFilters, type LeaveRow, type PersonRef } from "./types";

const VIEWERS = ["staff.leave.approve", "staff.employee.read"] as const;

export type LeavePage = {
  rows: LeaveRow[];
  total: number;
  page: number;
  pageCount: number;
  counts: { pending: number; approvedUpcoming: number; onLeaveToday: number };
  employees: (PersonRef & { status: "active" | "disabled" })[];
  can: { decide: boolean; record: boolean };
};

type Row = typeof leaveRequests.$inferSelect;

async function shiftsOnLeave(db: Db, rows: readonly Row[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const found = await db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM shifts WHERE employee_id = ${row.employeeId} AND status = 'scheduled' AND starts_at >= ${dayStart(row.startsOn)} AND starts_at < ${dayStart(row.endsOn) + DAY_MS}`,
    );
    out.set(row.id, Number(found[0]?.n ?? 0));
  }
  return out;
}

/** The audit action of asking for leave: its actor is who recorded the request (the employee, or a leave approver for them). */
const LEAVE_REQUEST_ACTION = "staff.leave.request";

/** Who recorded each request (leave id → employee id), from the audit trail (append-only). */
export async function leaveRecorders(db: Db, leaveIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let at = 0; at < leaveIds.length; at += 90) {
    const part = leaveIds.slice(at, at + 90);
    const rows = await db.all<{ leaveId: string; actorId: string | null }>(sql`SELECT entity_id AS leaveId, actor_id AS actorId FROM audit_events
      WHERE action = ${LEAVE_REQUEST_ACTION} AND entity_type = 'leave_request' AND actor_kind = 'employee' AND entity_id IN (${sql.join(
        part.map((id) => sql`${id}`),
        sql`, `,
      )})`);
    for (const row of rows) if (row.actorId) out.set(row.leaveId, row.actorId);
  }
  return out;
}

function viewOf(actor: Actor, people: Map<string, PersonRef>, row: Row, affectedShifts: number, today: string, recordedBy: string | null = null): LeaveRow {
  const mine = actorId(actor) === row.employeeId;
  // never one's own leave, nor leave one recorded for someone else (the requester never decides their own request)
  const recorder = recordedBy !== null && actorId(actor) === recordedBy;
  return {
    id: row.id,
    employee: personOf(people, row.employeeId),
    kind: row.kind,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    days: daySpan(row.startsOn, row.endsOn),
    reason: row.reason,
    status: row.status,
    decidedBy: row.decidedBy ? (people.get(row.decidedBy)?.name ?? null) : null,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    canDecide: row.status === "pending" && can(actor, "staff.leave.approve") && !mine && !recorder,
    canCancel: (row.status === "pending" && (mine || can(actor, "staff.leave.approve"))) || (row.status === "approved" && row.endsOn >= today && can(actor, "staff.leave.approve") && !mine),
    shiftsAffected: affectedShifts,
  };
}

/** Requests by status (pending first by default) and employee; filters in the URL. */
export async function listLeave(db: Db, actor: Actor, filters: LeaveFilters, now: number): Promise<LeavePage> {
  assertAny(actor, VIEWERS);
  const today = baghdadDay(now);
  const limit = branchLimit(actor);
  const where: SQL[] = [];
  // an employee limited to a branch sees the leave of that branch's staff only (the counts too)
  const reach = reachSql(actor, leaveRequests.employeeId);
  if (reach) where.push(reach);
  if (filters.status) where.push(eq(leaveRequests.status, filters.status));
  if (filters.employee) where.push(eq(leaveRequests.employeeId, filters.employee));
  const condition = where.length ? and(...where) : undefined;
  const [rows, count, counts, options] = await Promise.all([
    db.select().from(leaveRequests).where(condition).orderBy(sql`CASE ${leaveRequests.status} WHEN 'pending' THEN 0 ELSE 1 END`, desc(leaveRequests.startsOn), desc(leaveRequests.createdAt)).limit(PAGE_SIZE).offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)` }).from(leaveRequests).where(condition).get(),
    db.all<{ pending: number; upcoming: number; today: number }>(sql`SELECT
        coalesce(sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
        coalesce(sum(CASE WHEN status = 'approved' AND starts_on > ${today} THEN 1 ELSE 0 END), 0) AS upcoming,
        coalesce(sum(CASE WHEN status = 'approved' AND starts_on <= ${today} AND ends_on >= ${today} THEN 1 ELSE 0 END), 0) AS today
      FROM leave_requests ${limit ? sql`WHERE employee_id IN (SELECT reach.id FROM employees AS reach WHERE reach.branch_id = ${limit})` : sql``}`),
    employeeOptions(db, { branchId: limit }),
  ]);
  const people = await peopleById(db, [...rows.map((row) => row.employeeId), ...rows.map((row) => row.decidedBy)]);
  const pending = rows.filter((row) => row.status === "pending");
  const [affected, recorders] = await Promise.all([shiftsOnLeave(db, pending), leaveRecorders(db, pending.map((row) => row.id))]);
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map((row) => viewOf(actor, people, row, affected.get(row.id) ?? 0, today, recorders.get(row.id) ?? null)),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: { pending: Number(counts[0]?.pending ?? 0), approvedUpcoming: Number(counts[0]?.upcoming ?? 0), onLeaveToday: Number(counts[0]?.today ?? 0) },
    employees: options,
    can: { decide: can(actor, "staff.leave.approve"), record: can(actor, "staff.leave.approve") },
  };
}

/** The signed-in employee's own requests, newest first. */
export async function myLeave(db: Db, actor: Actor, now: number): Promise<LeaveRow[]> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const rows = await db.select().from(leaveRequests).where(eq(leaveRequests.employeeId, me)).orderBy(desc(leaveRequests.startsOn)).limit(20);
  const people = await peopleById(db, [me, ...rows.map((row) => row.decidedBy)]);
  const today = baghdadDay(now);
  return rows.map((row) => viewOf(actor, people, row, 0, today));
}

const RequestInput = z.object({
  /** Someone else's leave needs staff.leave.approve; empty = one's own. */
  employeeId: IdSchema.nullish(),
  kind: z.enum(LEAVE_KIND_LIST, { error: "required" }),
  startsOn: z.string({ error: "required" }).refine(isDay, "invalid"),
  endsOn: z.string({ error: "required" }).refine(isDay, "invalid"),
  reason: OptionalNote,
});

/** Asks for leave (one's own, or someone's with staff.leave.approve): a pending request. */
export async function requestLeave(db: Db, actor: Actor, raw: z.input<typeof RequestInput>, now: number): Promise<{ leaveId: string }> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const input = RequestInput.parse(raw);
  const employeeId = input.employeeId || me;
  if (employeeId !== me) {
    assertAny(actor, ["staff.leave.approve"]);
    await assertReachOf(db, actor, employeeId);
  }
  const today = baghdadDay(now);
  if (input.endsOn < input.startsOn) throw invalid({ endsOn: "leave_end_before_start" });
  if (daySpan(input.startsOn, input.endsOn) > MAX_LEAVE_DAYS) throw invalid({ endsOn: "leave_too_long" });
  if (input.startsOn < addDays(today, -LEAVE_BACKDATE_DAYS)) throw invalid({ startsOn: "leave_too_old" });
  if (input.startsOn > addDays(today, 365)) throw invalid({ startsOn: "too_far" });
  if (input.kind === "other" && !input.reason) throw invalid({ reason: "reason_required" });
  const employee = await activeEmployee(db, employeeId);
  const id = newId("lvr");
  try {
    await runBatch(db, [
      expectThat(
        db,
        sql`NOT EXISTS (SELECT 1 FROM leave_requests WHERE employee_id = ${employee.id} AND status IN ('pending', 'approved') AND starts_on <= ${input.endsOn} AND ends_on >= ${input.startsOn})`,
        { code: "LEAVE_OVERLAP", detail: employee.id },
      ),
      db.insert(leaveRequests).values({ id, employeeId: employee.id, kind: input.kind, startsOn: input.startsOn, endsOn: input.endsOn, reason: input.reason, status: "pending", createdAt: now }),
      auditStatement(db, { actor, action: "staff.leave.request", entityType: "leave_request", entityId: id, summary: `${employee.name}: ${input.startsOn} → ${input.endsOn}`, after: { employeeId: employee.id, kind: input.kind, startsOn: input.startsOn, endsOn: input.endsOn }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "LEAVE_OVERLAP")) throw new AppError("leave_overlap", 409, { fields: { startsOn: "leave_overlap" } });
    throw error;
  }
  return { leaveId: id };
}

const DecideInput = z.object({ leaveId: IdSchema, decision: z.enum(["approve", "reject"]), note: OptionalNote });

/**
 * Approves or rejects a pending request (staff.leave.approve; never one's own, nor one the approver recorded for
 * someone else — leave_self_decision, 403). Rejecting needs a note; approving cancels the employee's scheduled shifts
 * on those days in the same batch — chosen inside it, so a shift planned a moment before is cancelled too.
 */
export async function decideLeave(db: Db, actor: Actor, raw: z.input<typeof DecideInput>, now: number): Promise<{ status: "approved" | "rejected"; shiftsCancelled: number }> {
  assertAny(actor, ["staff.leave.approve"]);
  const input = DecideInput.parse(raw);
  if (input.decision === "reject" && (!input.note || input.note.length < 3)) throw invalid({ note: "reason_required" });
  const row = await db.select().from(leaveRequests).where(eq(leaveRequests.id, input.leaveId)).get();
  if (!row) throw notFound("leave_request");
  const me = actorId(actor);
  if (me === row.employeeId) throw new AppError("leave_self_decision", 403);
  if (me && (await participants(db, "leave_request", row.id, [LEAVE_REQUEST_ACTION])).has(me)) throw new AppError("leave_self_decision", 403);
  await assertReachOf(db, actor, row.employeeId);
  if (row.status !== "pending") throw new AppError("leave_not_pending", 409);
  const status = input.decision === "approve" ? "approved" : "rejected";
  const from = dayStart(row.startsOn);
  const to = dayStart(row.endsOn) + DAY_MS;
  let cancelled = 0;
  try {
    const results = await runBatch(db, [
      db
        .update(leaveRequests)
        .set({ status, decidedBy: me, decidedAt: now })
        .where(and(eq(leaveRequests.id, row.id), eq(leaveRequests.status, "pending"))),
      expectChanged(db, 1, { code: "LEAVE_NOT_PENDING", detail: row.id }),
      auditStatement(db, {
        actor,
        action: input.decision === "approve" ? "staff.leave.approve" : "staff.leave.reject",
        entityType: "leave_request",
        entityId: row.id,
        before: { status: "pending" },
        after: status === "approved" ? { status, shiftsCancelledOn: { from: row.startsOn, to: row.endsOn } } : { status },
        reason: input.note,
        at: now,
      }),
      ...(status === "approved" ? [cancelShiftsOn(db, row.employeeId, from, to)] : []),
    ]);
    cancelled = status === "approved" ? rowsOf(results[3]) : 0;
  } catch (error) {
    if (isDbError(error, "LEAVE_NOT_PENDING")) throw new AppError("leave_not_pending", 409);
    throw error;
  }
  return { status, shiftsCancelled: cancelled };
}

/** The employee's scheduled shifts that start on the leave's days, cancelled (the rows it changed are returned). */
function cancelShiftsOn(db: Db, employeeId: string, from: number, to: number) {
  return db
    .update(shifts)
    .set({ status: "cancelled" })
    .where(and(eq(shifts.employeeId, employeeId), eq(shifts.status, "scheduled"), gte(shifts.startsAt, from), lt(shifts.startsAt, to)))
    .returning({ id: shifts.id });
}

/** How many rows a batch statement with RETURNING gave back (an array, or a D1 result with its rows). */
function rowsOf(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rows = (result as { results?: unknown } | null)?.results;
  return Array.isArray(rows) ? rows.length : 0;
}

const CancelInput = z.object({ leaveId: IdSchema, reason: OptionalNote });

/**
 * Withdraws a pending request (its employee, or a leave approver) or cancels an approved leave that has not ended
 * (a leave approver other than the employee, with a reason). Shifts cancelled by the approval are not brought back.
 */
export async function cancelLeave(db: Db, actor: Actor, raw: z.input<typeof CancelInput>, now: number): Promise<{ status: "cancelled" }> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const input = CancelInput.parse(raw);
  const row = await db.select().from(leaveRequests).where(eq(leaveRequests.id, input.leaveId)).get();
  if (!row) throw notFound("leave_request");
  const approver = can(actor, "staff.leave.approve");
  const mine = row.employeeId === me;
  if (!mine) await assertReachOf(db, actor, row.employeeId);
  if (row.status === "pending") {
    if (!mine && !approver) throw forbidden("staff.leave.approve");
  } else if (row.status === "approved") {
    if (!approver || mine) throw new AppError("leave_not_cancellable", 409);
    if (row.endsOn < baghdadDay(now)) throw new AppError("leave_not_cancellable", 409);
    if (!input.reason || input.reason.length < 3) throw invalid({ reason: "reason_required" });
  } else throw new AppError("leave_not_cancellable", 409);
  try {
    await runBatch(db, [
      db
        .update(leaveRequests)
        .set({ status: "cancelled", decidedBy: me, decidedAt: now })
        .where(and(eq(leaveRequests.id, row.id), eq(leaveRequests.status, row.status))),
      expectChanged(db, 1, { code: "LEAVE_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "staff.leave.cancel", entityType: "leave_request", entityId: row.id, before: { status: row.status }, after: { status: "cancelled" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "LEAVE_CHANGED")) throw new AppError("leave_not_cancellable", 409);
    throw error;
  }
  return { status: "cancelled" };
}

/** Approved unpaid-leave days of an employee between two days (inclusive) — what a payroll run deducts. */
export async function unpaidLeaveDays(db: Db, employeeId: string, from: string, to: string): Promise<number> {
  if (to < from) return 0;
  const rows = await db
    .select({ startsOn: leaveRequests.startsOn, endsOn: leaveRequests.endsOn })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.employeeId, employeeId), eq(leaveRequests.status, "approved"), eq(leaveRequests.kind, "unpaid"), sql`${leaveRequests.endsOn} >= ${from}`, sql`${leaveRequests.startsOn} <= ${to}`));
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

