/**
 * Admin 15.02 — the work schedule: planned working shifts per employee and day (table `shifts`), shown as a week
 * roster (Saturday to Friday) with attendance and approved leave beside each shift. These are WORK shifts; the
 * point-of-sale's shifts are cash drawers (module 06, `pos_shifts`) and are only linked from the page.
 *
 * Rules: staff.schedule.manage plans, cancels and copies; an employee never has two live shifts that overlap (checked
 * inside the batch, so two planners at once cannot both win); a shift is planned only for an active employee, not in
 * the past, at most 16 hours long (an overnight shift ends the next day) and at most SCHEDULE_AHEAD_DAYS ahead, never
 * on a day of the employee's approved leave. Every change is audited (staff.schedule.*).
 *
 * Errors: forbidden, not_found, invalid (fields: day, start, end, employeeId), shift_overlap, shift_in_past,
 * shift_on_leave, shift_not_scheduled, employee_inactive.
 */
import { and, asc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { attendance, leaveRequests, shifts } from "~/server/db/schema";
import { batchSql, expectChanged, expectThat, isDbError, runBatch, type BatchStatement } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { actorId, activeEmployee, assertAny, assertReach, assertReachOf, branchLimit, employeeOptions, IdSchema, OptionalNote, peopleById, personOf, reachSql, Reason, stamp } from "./shared.server";
import {
  addDays,
  baghdadDay,
  clockOf,
  dayStart,
  DAY_MS,
  isDay,
  LATE_GRACE_MINUTES,
  MAX_SHIFT_MS,
  parseClock,
  SCHEDULE_AHEAD_DAYS,
  weekDays,
  type PersonRef,
  type RosterFilters,
  type RosterRow,
  type ShiftCell,
  type ShiftStatusKey,
} from "./types";

const VIEWERS = ["staff.employee.read", "staff.schedule.manage", "staff.attendance.manage"] as const;
const LIVE: ShiftStatusKey[] = ["scheduled", "completed"];

export type RosterView = {
  week: string;
  days: string[];
  rows: RosterRow[];
  totals: { shifts: number; plannedMinutes: number; employees: number };
  employees: (PersonRef & { status: "active" | "disabled" })[];
  can: { manage: boolean; mark: boolean };
  today: string;
};

/** The week's roster: every employee with a shift that week (or the one asked for), each day's shifts with attendance. */
export async function listRoster(db: Db, actor: Actor, filters: RosterFilters, locale: Locale, now: number): Promise<RosterView> {
  assertAny(actor, VIEWERS);
  void locale;
  const days = weekDays(filters.week);
  const from = dayStart(days[0]);
  const to = dayStart(days[6]) + DAY_MS;
  // an employee limited to a branch sees the roster of that branch's staff only
  const shiftRows = await db
    .select()
    .from(shifts)
    .where(and(gte(shifts.startsAt, from), lt(shifts.startsAt, to), filters.employee ? eq(shifts.employeeId, filters.employee) : undefined, reachSql(actor, shifts.employeeId)))
    .orderBy(asc(shifts.startsAt));
  const ids = new Set(shiftRows.map((row) => row.employeeId));
  if (filters.employee && (await assertReachOf(db, actor, filters.employee).then(() => true, () => false))) ids.add(filters.employee);
  const people = await peopleById(db, [...ids]);
  const shiftIds = shiftRows.map((row) => row.id);
  const [clockIns, leave, options] = await Promise.all([
    shiftIds.length
      ? db
          .select({ shiftId: attendance.shiftId, clockInAt: sql<number>`min(${attendance.clockInAt})`, open: sql<number>`max(CASE WHEN ${attendance.clockOutAt} IS NULL THEN 1 ELSE 0 END)` })
          .from(attendance)
          .where(inArray(attendance.shiftId, shiftIds))
          .groupBy(attendance.shiftId)
      : Promise.resolve([]),
    ids.size
      ? db
          .select({ employeeId: leaveRequests.employeeId, startsOn: leaveRequests.startsOn, endsOn: leaveRequests.endsOn })
          .from(leaveRequests)
          .where(and(inArray(leaveRequests.employeeId, [...ids]), eq(leaveRequests.status, "approved"), sql`${leaveRequests.endsOn} >= ${days[0]}`, sql`${leaveRequests.startsOn} <= ${days[6]}`))
      : Promise.resolve([]),
    employeeOptions(db, { branchId: branchLimit(actor) }),
  ]);
  const firstIn = new Map(clockIns.map((row) => [row.shiftId as string, { at: Number(row.clockInAt), open: Number(row.open) === 1 }]));
  const leaveDaysOf = (employeeId: string) =>
    days.filter((day) => leave.some((row) => row.employeeId === employeeId && row.startsOn <= day && row.endsOn >= day));
  const rows: RosterRow[] = [...ids]
    .map((employeeId) => {
      const person = people.get(employeeId);
      const mine = shiftRows.filter((row) => row.employeeId === employeeId);
      const onLeave = leaveDaysOf(employeeId);
      const cells: ShiftCell[][] = days.map((day) =>
        mine
          .filter((row) => baghdadDay(row.startsAt) === day)
          .map((row) => {
            const clock = firstIn.get(row.id);
            let attended: ShiftCell["attended"] = null;
            if (clock) attended = clock.open ? "open" : clock.at > row.startsAt + LATE_GRACE_MINUTES * 60_000 ? "late" : "on_time";
            else if (row.status !== "cancelled" && row.endsAt < now) attended = "absent";
            return { id: row.id, startsAt: row.startsAt, endsAt: row.endsAt, status: row.status, note: row.note, overnight: baghdadDay(row.endsAt - 1) !== day, attended, onLeave: onLeave.includes(day) };
          }),
      );
      const planned = mine.filter((row) => row.status !== "cancelled").reduce((sum, row) => sum + Math.round((row.endsAt - row.startsAt) / 60_000), 0);
      return { employee: personOf(people, employeeId), jobTitle: person?.jobTitle ?? null, days: cells, leaveDays: onLeave, plannedMinutes: planned };
    })
    .sort((a, b) => a.employee.name.localeCompare(b.employee.name, "ar"));
  const live = shiftRows.filter((row) => row.status !== "cancelled");
  return {
    week: filters.week,
    days,
    rows,
    totals: { shifts: live.length, plannedMinutes: live.reduce((sum, row) => sum + Math.round((row.endsAt - row.startsAt) / 60_000), 0), employees: rows.length },
    employees: options,
    can: { manage: can(actor, "staff.schedule.manage"), mark: can(actor, "staff.schedule.manage") || can(actor, "staff.attendance.manage") },
    today: baghdadDay(now),
  };
}

const ShiftInput = z.object({
  employeeId: IdSchema,
  day: z.string({ error: "required" }).refine(isDay, "invalid"),
  start: z.string({ error: "required" }),
  end: z.string({ error: "required" }),
  note: OptionalNote,
});

/** The instants of a shift typed as a day and two wall-clock times (an end at or before the start ends the next day). */
export function shiftTimes(day: string, start: string, end: string): { startsAt: number; endsAt: number } | { field: "start" | "end"; code: string } {
  const startMin = parseClock(start);
  if (startMin === null) return { field: "start", code: "invalid" };
  const endMin = parseClock(end);
  if (endMin === null) return { field: "end", code: "invalid" };
  const startsAt = dayStart(day) + startMin * 60_000;
  const endsAt = dayStart(day) + endMin * 60_000 + (endMin <= startMin ? DAY_MS : 0);
  if (endsAt - startsAt > MAX_SHIFT_MS) return { field: "end", code: "shift_too_long" };
  return { startsAt, endsAt };
}

function overlapGuard(db: Db, employeeId: string, startsAt: number, endsAt: number, exceptId?: string): BatchStatement {
  return expectThat(
    db,
    sql`(SELECT count(*) FROM shifts WHERE employee_id = ${employeeId} AND status IN ('scheduled', 'completed') AND starts_at < ${endsAt} AND ends_at > ${startsAt} ${exceptId ? sql`AND id <> ${exceptId}` : sql``}) = ${exceptId ? 0 : 1}`,
    { code: "SHIFT_OVERLAP", detail: employeeId },
  );
}

function onLeaveSql(employeeId: string, day: string) {
  return sql`EXISTS (SELECT 1 FROM leave_requests WHERE employee_id = ${employeeId} AND status = 'approved' AND starts_on <= ${day} AND ends_on >= ${day})`;
}

/** Plans one shift (staff.schedule.manage). */
export async function createShift(db: Db, actor: Actor, raw: z.input<typeof ShiftInput>, now: number): Promise<{ shiftId: string }> {
  assertAny(actor, ["staff.schedule.manage"]);
  const input = ShiftInput.parse(raw);
  const times = shiftTimes(input.day, input.start, input.end);
  if ("field" in times) throw invalid({ [times.field]: times.code });
  if (times.endsAt <= now) throw new AppError("shift_in_past", 409, { fields: { day: "shift_in_past" } });
  if (times.startsAt > now + SCHEDULE_AHEAD_DAYS * DAY_MS) throw invalid({ day: "too_far" });
  const employee = await activeEmployee(db, input.employeeId);
  assertReach(actor, employee);
  const shiftId = newId("shf");
  try {
    await runBatch(db, [
      expectThat(db, sql`NOT ${onLeaveSql(employee.id, input.day)}`, { code: "SHIFT_ON_LEAVE", detail: employee.id }),
      expectThat(db, sql`EXISTS (SELECT 1 FROM employees WHERE id = ${employee.id} AND status = 'active')`, { code: "EMPLOYEE_INACTIVE", detail: employee.id }),
      db.insert(shifts).values({ id: shiftId, employeeId: employee.id, branchId: employee.branchId, startsAt: times.startsAt, endsAt: times.endsAt, status: "scheduled", note: input.note, createdBy: stamp(actor), createdAt: now }),
      overlapGuard(db, employee.id, times.startsAt, times.endsAt),
      auditStatement(db, { actor, action: "staff.schedule.create", entityType: "shift", entityId: shiftId, summary: `${employee.name}: ${input.day} ${clockOf(times.startsAt)}–${clockOf(times.endsAt)}`, after: { employeeId: employee.id, startsAt: times.startsAt, endsAt: times.endsAt, note: input.note }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "SHIFT_OVERLAP")) throw new AppError("shift_overlap", 409, { fields: { start: "shift_overlap" } });
    if (isDbError(error, "SHIFT_ON_LEAVE")) throw new AppError("shift_on_leave", 409, { fields: { day: "shift_on_leave" } });
    if (isDbError(error, "EMPLOYEE_INACTIVE")) throw new AppError("employee_inactive", 409, { fields: { employeeId: "employee_inactive" } });
    throw error;
  }
  return { shiftId };
}

const CancelInput = z.object({ shiftId: IdSchema, reason: Reason });

/** Cancels a planned shift (staff.schedule.manage), with a reason. */
export async function cancelShift(db: Db, actor: Actor, raw: z.input<typeof CancelInput>, now: number): Promise<{ cancelled: true }> {
  assertAny(actor, ["staff.schedule.manage"]);
  const input = CancelInput.parse(raw);
  const row = await db.select().from(shifts).where(eq(shifts.id, input.shiftId)).get();
  if (!row) throw notFound("shift");
  await assertReachOf(db, actor, row.employeeId);
  if (row.status !== "scheduled") throw new AppError("shift_not_scheduled", 409);
  try {
    await runBatch(db, [
      db.update(shifts).set({ status: "cancelled" }).where(and(eq(shifts.id, row.id), eq(shifts.status, "scheduled"))),
      expectChanged(db, 1, { code: "SHIFT_NOT_SCHEDULED", detail: row.id }),
      auditStatement(db, { actor, action: "staff.schedule.cancel", entityType: "shift", entityId: row.id, before: { status: row.status, startsAt: row.startsAt, endsAt: row.endsAt }, after: { status: "cancelled" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "SHIFT_NOT_SCHEDULED")) throw new AppError("shift_not_scheduled", 409);
    throw error;
  }
  return { cancelled: true };
}

const MarkInput = z.object({ shiftId: IdSchema, status: z.enum(["completed", "missed"]), reason: OptionalNote });

/**
 * Marks a shift that has begun as worked or missed (staff.schedule.manage or staff.attendance.manage). "Missed" needs a
 * reason; a shift with a clock-in cannot be marked missed (the attendance record says otherwise). Never one's own
 * shift: saying one worked is recording one's own attendance (attendance_self_approval, 403 — review 2026-11-12).
 */
export async function markShift(db: Db, actor: Actor, raw: z.input<typeof MarkInput>, now: number): Promise<{ status: "completed" | "missed" }> {
  assertAny(actor, ["staff.schedule.manage", "staff.attendance.manage"]);
  const input = MarkInput.parse(raw);
  if (input.status === "missed" && (!input.reason || input.reason.length < 3)) throw invalid({ reason: "reason_required" });
  const row = await db.select().from(shifts).where(eq(shifts.id, input.shiftId)).get();
  if (!row) throw notFound("shift");
  if (actorId(actor) === row.employeeId) throw new AppError("attendance_self_approval", 403);
  await assertReachOf(db, actor, row.employeeId);
  if (row.status !== "scheduled") throw new AppError("shift_not_scheduled", 409);
  if (row.startsAt > now) throw new AppError("shift_not_started", 409);
  try {
    await runBatch(db, [
      ...(input.status === "missed" ? [expectThat(db, sql`NOT EXISTS (SELECT 1 FROM attendance WHERE shift_id = ${row.id})`, { code: "SHIFT_ATTENDED", detail: row.id })] : []),
      db.update(shifts).set({ status: input.status }).where(and(eq(shifts.id, row.id), eq(shifts.status, "scheduled"))),
      expectChanged(db, 1, { code: "SHIFT_NOT_SCHEDULED", detail: row.id }),
      auditStatement(db, { actor, action: "staff.schedule.mark", entityType: "shift", entityId: row.id, before: { status: row.status }, after: { status: input.status }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "SHIFT_NOT_SCHEDULED")) throw new AppError("shift_not_scheduled", 409);
    if (isDbError(error, "SHIFT_ATTENDED")) throw new AppError("shift_attended", 409);
    throw error;
  }
  return { status: input.status };
}

const CopyInput = z.object({ fromWeek: z.string().refine(isDay, "invalid"), toWeek: z.string().refine(isDay, "invalid") });

/**
 * Copies a week's live shifts to another week (staff.schedule.manage), same weekday and times. A copy is skipped — not
 * an error — when it would lie in the past, overlap a shift the employee already has, fall on their approved leave, or
 * belong to someone who no longer works here: each insert carries those conditions itself, inside one batch.
 */
export async function copyWeek(db: Db, actor: Actor, raw: z.input<typeof CopyInput>, now: number): Promise<{ copied: number; skipped: number }> {
  assertAny(actor, ["staff.schedule.manage"]);
  const input = CopyInput.parse(raw);
  const offsetDays = Math.round((dayStart(input.toWeek) - dayStart(input.fromWeek)) / DAY_MS);
  if (offsetDays === 0 || offsetDays % 7 !== 0) throw invalid({ toWeek: "invalid" });
  const from = dayStart(input.fromWeek);
  const source = await db
    .select()
    .from(shifts)
    .where(and(gte(shifts.startsAt, from), lt(shifts.startsAt, from + 7 * DAY_MS), inArray(shifts.status, LIVE), reachSql(actor, shifts.employeeId)))
    .orderBy(asc(shifts.startsAt));
  const offset = offsetDays * DAY_MS;
  const planned = source.map((row) => ({ row, id: newId("shf"), startsAt: row.startsAt + offset, endsAt: row.endsAt + offset, day: addDays(baghdadDay(row.startsAt), offsetDays) })).filter((item) => item.endsAt > now && item.startsAt <= now + SCHEDULE_AHEAD_DAYS * DAY_MS);
  if (!planned.length) return { copied: 0, skipped: source.length };
  const by = stamp(actor);
  const statements: BatchStatement[] = planned.map((item) =>
    batchSql(
      db,
      sql`INSERT INTO shifts (id, employee_id, branch_id, starts_at, ends_at, status, note, created_by, created_at)
        SELECT ${item.id}, ${item.row.employeeId}, ${item.row.branchId}, ${item.startsAt}, ${item.endsAt}, 'scheduled', ${item.row.note}, ${by}, ${now}
        WHERE EXISTS (SELECT 1 FROM employees WHERE id = ${item.row.employeeId} AND status = 'active')
          AND NOT EXISTS (SELECT 1 FROM shifts WHERE employee_id = ${item.row.employeeId} AND status IN ('scheduled', 'completed') AND starts_at < ${item.endsAt} AND ends_at > ${item.startsAt})
          AND NOT ${onLeaveSql(item.row.employeeId, item.day)}`,
    ),
  );
  await runBatch(db, statements);
  const made = await db.select({ n: sql<number>`count(*)` }).from(shifts).where(inArray(shifts.id, planned.map((item) => item.id))).get();
  const copied = Number(made?.n ?? 0);
  if (copied > 0) {
    await runBatch(db, [auditStatement(db, { actor, action: "staff.schedule.copy_week", entityType: "schedule", entityId: input.toWeek, summary: `${input.fromWeek} → ${input.toWeek}`, after: { copied, skipped: source.length - copied }, at: now })]);
  }
  return { copied, skipped: source.length - copied };
}

/** The scheduled shift of an employee that a clock-in at `at` belongs to (it starts at most 2 hours later, or is under way). */
export async function shiftAt(db: Db, employeeId: string, at: number, earlyMs: number): Promise<{ id: string; startsAt: number; endsAt: number; branchId: string | null } | null> {
  const row = await db
    .select({ id: shifts.id, startsAt: shifts.startsAt, endsAt: shifts.endsAt, branchId: shifts.branchId })
    .from(shifts)
    .where(and(eq(shifts.employeeId, employeeId), eq(shifts.status, "scheduled"), lt(shifts.startsAt, at + earlyMs), sql`${shifts.endsAt} > ${at}`))
    .orderBy(asc(shifts.startsAt))
    .get();
  return row ?? null;
}

/** An employee's shifts between two instants (the "my schedule" page). */
export async function shiftsOf(db: Db, employeeId: string, from: number, to: number) {
  return db
    .select({ id: shifts.id, startsAt: shifts.startsAt, endsAt: shifts.endsAt, status: shifts.status, note: shifts.note })
    .from(shifts)
    .where(and(eq(shifts.employeeId, employeeId), gte(shifts.startsAt, from), lt(shifts.startsAt, to), ne(shifts.status, "cancelled")))
    .orderBy(asc(shifts.startsAt));
}

