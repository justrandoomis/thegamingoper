/**
 * Admin 15.02 — attendance: employees clock themselves in and out (method "self"), a manager records a missed
 * clock-in or corrects a record (method "manager", with a reason, before and after audited) and approves closed
 * records (one by one or in bulk). A clock-in belongs to the shift it falls in (or that starts within two hours);
 * more than LATE_GRACE_MINUTES after the shift's start is late. Clocking out closes the shift as worked.
 *
 * Two-person rule: nobody records, corrects or approves their own attendance (attendance_self_approval, 403).
 * One open record per employee (already_clocked_in), held inside the batch.
 *
 * Errors: forbidden, not_found, invalid (fields), already_clocked_in, not_clocked_in, attendance_self_approval (403),
 * attendance_changed, attendance_overlap.
 */
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { attendance, shifts } from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { shiftAt, shiftTimes } from "./schedule.server";
import { actorId, activeEmployee, assertAny, assertReach, assertReachOf, branchLimit, employeeOptions, IdSchema, OptionalNote, peopleById, personOf, reachSql, Reason } from "./shared.server";
import {
  CLOCK_IN_EARLY_MS,
  dayStart,
  DAY_MS,
  isDay,
  LATE_GRACE_MINUTES,
  MAX_ATTENDANCE_MS,
  PAGE_SIZE,
  type AttendanceFilters,
  type AttendanceRow,
  type PersonRef,
} from "./types";

const VIEWERS = ["staff.attendance.manage", "staff.schedule.manage"] as const;
const GRACE_MS = LATE_GRACE_MINUTES * 60_000;

export type AttendancePage = {
  rows: AttendanceRow[];
  total: number;
  page: number;
  pageCount: number;
  summary: { records: number; minutes: number; late: number; open: number; unapproved: number };
  employees: (PersonRef & { status: "active" | "disabled" })[];
  can: { manage: boolean };
};

function rowOf(actor: Actor, people: Map<string, PersonRef>, row: { id: string; employeeId: string; clockInAt: number; clockOutAt: number | null; method: string; note: string | null; approvedBy: string | null; shiftId: string | null; shiftStart: number | null; shiftEnd: number | null }): AttendanceRow {
  const lateMs = row.shiftStart !== null ? row.clockInAt - row.shiftStart : 0;
  const late = row.shiftStart !== null && lateMs > GRACE_MS;
  return {
    id: row.id,
    employee: personOf(people, row.employeeId),
    clockInAt: row.clockInAt,
    clockOutAt: row.clockOutAt,
    minutes: row.clockOutAt !== null ? Math.max(0, Math.round((row.clockOutAt - row.clockInAt) / 60_000)) : null,
    method: row.method,
    note: row.note,
    shift: row.shiftId && row.shiftStart !== null && row.shiftEnd !== null ? { id: row.shiftId, startsAt: row.shiftStart, endsAt: row.shiftEnd } : null,
    late,
    lateMinutes: late ? Math.round(lateMs / 60_000) : 0,
    approvedBy: row.approvedBy ? (people.get(row.approvedBy)?.name ?? row.approvedBy) : null,
    canApprove: can(actor, "staff.attendance.manage") && row.approvedBy === null && row.clockOutAt !== null && actorId(actor) !== row.employeeId,
    // correctAttendance refuses one's own record (attendance_self_approval): no key for it
    canCorrect: can(actor, "staff.attendance.manage") && actorId(actor) !== row.employeeId,
  };
}

const SELECT = {
  id: attendance.id,
  employeeId: attendance.employeeId,
  clockInAt: attendance.clockInAt,
  clockOutAt: attendance.clockOutAt,
  method: attendance.method,
  note: attendance.note,
  approvedBy: attendance.approvedBy,
  shiftId: attendance.shiftId,
  shiftStart: shifts.startsAt,
  shiftEnd: shifts.endsAt,
};

/** Records of a period (by clock-in day), filters in the URL; totals of the filtered records. */
export async function listAttendance(db: Db, actor: Actor, filters: AttendanceFilters, locale: Locale): Promise<AttendancePage> {
  assertAny(actor, VIEWERS);
  void locale;
  const from = dayStart(filters.from);
  const to = dayStart(filters.to) + DAY_MS;
  const where: SQL[] = [gte(attendance.clockInAt, from), lt(attendance.clockInAt, to)];
  // an employee limited to a branch sees the records of that branch's staff only (the totals too)
  const reach = reachSql(actor, attendance.employeeId);
  if (reach) where.push(reach);
  if (filters.employee) where.push(eq(attendance.employeeId, filters.employee));
  if (filters.state === "open") where.push(isNull(attendance.clockOutAt));
  if (filters.state === "unapproved") where.push(and(isNull(attendance.approvedBy), isNotNull(attendance.clockOutAt)) as SQL);
  if (filters.state === "late") where.push(sql`${shifts.startsAt} IS NOT NULL AND ${attendance.clockInAt} > ${shifts.startsAt} + ${GRACE_MS}`);
  const condition = and(...where);
  const [rows, totals, options] = await Promise.all([
    db.select(SELECT).from(attendance).leftJoin(shifts, eq(shifts.id, attendance.shiftId)).where(condition).orderBy(desc(attendance.clockInAt)).limit(PAGE_SIZE).offset((filters.page - 1) * PAGE_SIZE),
    db
      .select({
        n: sql<number>`count(*)`,
        minutes: sql<number>`coalesce(sum(CASE WHEN ${attendance.clockOutAt} IS NOT NULL THEN (${attendance.clockOutAt} - ${attendance.clockInAt}) / 60000 ELSE 0 END), 0)`,
        late: sql<number>`coalesce(sum(CASE WHEN ${shifts.startsAt} IS NOT NULL AND ${attendance.clockInAt} > ${shifts.startsAt} + ${GRACE_MS} THEN 1 ELSE 0 END), 0)`,
        open: sql<number>`coalesce(sum(CASE WHEN ${attendance.clockOutAt} IS NULL THEN 1 ELSE 0 END), 0)`,
        unapproved: sql<number>`coalesce(sum(CASE WHEN ${attendance.clockOutAt} IS NOT NULL AND ${attendance.approvedBy} IS NULL THEN 1 ELSE 0 END), 0)`,
      })
      .from(attendance)
      .leftJoin(shifts, eq(shifts.id, attendance.shiftId))
      .where(condition)
      .get(),
    employeeOptions(db, { includeDisabled: true, branchId: branchLimit(actor) }),
  ]);
  const people = await peopleById(db, [...rows.map((row) => row.employeeId), ...rows.map((row) => row.approvedBy)]);
  const total = Number(totals?.n ?? 0);
  return {
    rows: rows.map((row) => rowOf(actor, people, row)),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    summary: { records: total, minutes: Math.round(Number(totals?.minutes ?? 0)), late: Number(totals?.late ?? 0), open: Number(totals?.open ?? 0), unapproved: Number(totals?.unapproved ?? 0) },
    employees: options,
    can: { manage: can(actor, "staff.attendance.manage") },
  };
}

export type MyClock = {
  open: AttendanceRow | null;
  /** The shift a clock-in now would belong to. */
  shift: { id: string; startsAt: number; endsAt: number } | null;
  recent: AttendanceRow[];
};

/** The signed-in employee's own clock: the open record, the shift now, the last 14 records. */
export async function myClock(db: Db, actor: Actor, now: number): Promise<MyClock> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const [rows, shift] = await Promise.all([
    db.select(SELECT).from(attendance).leftJoin(shifts, eq(shifts.id, attendance.shiftId)).where(eq(attendance.employeeId, me)).orderBy(desc(attendance.clockInAt)).limit(14),
    shiftAt(db, me, now, CLOCK_IN_EARLY_MS),
  ]);
  const people = await peopleById(db, [me, ...rows.map((row) => row.approvedBy)]);
  const views = rows.map((row) => rowOf(actor, people, row));
  return { open: views.find((row) => row.clockOutAt === null) ?? null, shift: shift ? { id: shift.id, startsAt: shift.startsAt, endsAt: shift.endsAt } : null, recent: views };
}

const ClockInput = z.object({ note: OptionalNote });

/** Clocks the signed-in employee in, onto the shift under way (or starting within two hours). */
export async function clockIn(db: Db, actor: Actor, raw: z.input<typeof ClockInput>, now: number): Promise<{ attendanceId: string; shiftId: string | null; late: boolean }> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const input = ClockInput.parse(raw);
  const employee = await activeEmployee(db, me);
  const shift = await shiftAt(db, me, now, CLOCK_IN_EARLY_MS);
  const id = newId("att");
  try {
    await runBatch(db, [
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM attendance WHERE employee_id = ${me} AND clock_out_at IS NULL)`, { code: "ALREADY_CLOCKED_IN", detail: me }),
      db.insert(attendance).values({ id, employeeId: me, shiftId: shift?.id ?? null, branchId: shift?.branchId ?? employee.branchId, clockInAt: now, method: "self", note: input.note }),
      auditStatement(db, { actor, action: "staff.attendance.clock_in", entityType: "attendance", entityId: id, after: { shiftId: shift?.id ?? null, at: now }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "ALREADY_CLOCKED_IN")) throw new AppError("already_clocked_in", 409);
    throw error;
  }
  return { attendanceId: id, shiftId: shift?.id ?? null, late: shift ? now > shift.startsAt + GRACE_MS : false };
}

/** Clocks the signed-in employee out; the shift it belongs to is marked worked. */
export async function clockOut(db: Db, actor: Actor, raw: z.input<typeof ClockInput>, now: number): Promise<{ attendanceId: string; minutes: number }> {
  const me = actorId(actor);
  if (!me) throw forbidden("employee");
  const input = ClockInput.parse(raw);
  const open = await db.select().from(attendance).where(and(eq(attendance.employeeId, me), isNull(attendance.clockOutAt))).get();
  if (!open) throw new AppError("not_clocked_in", 409);
  const note = input.note ? (open.note ? `${open.note} · ${input.note}` : input.note) : open.note;
  try {
    await runBatch(db, [
      db
        .update(attendance)
        .set({ clockOutAt: now, note })
        .where(and(eq(attendance.id, open.id), isNull(attendance.clockOutAt))),
      expectChanged(db, 1, { code: "NOT_CLOCKED_IN", detail: open.id }),
      ...(open.shiftId ? [db.update(shifts).set({ status: "completed" }).where(and(eq(shifts.id, open.shiftId), eq(shifts.status, "scheduled"), lt(shifts.startsAt, now)))] : []),
      auditStatement(db, { actor, action: "staff.attendance.clock_out", entityType: "attendance", entityId: open.id, after: { at: now, minutes: Math.round((now - open.clockInAt) / 60_000) }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "NOT_CLOCKED_IN")) throw new AppError("not_clocked_in", 409);
    throw error;
  }
  return { attendanceId: open.id, minutes: Math.round((now - open.clockInAt) / 60_000) };
}

const RecordInput = z.object({
  employeeId: IdSchema,
  day: z.string({ error: "required" }).refine(isDay, "invalid"),
  start: z.string({ error: "required" }),
  end: z.string({ error: "required" }),
  reason: Reason,
});

function notOwn(actor: Actor, employeeId: string): void {
  if (actorId(actor) === employeeId) throw new AppError("attendance_self_approval", 403);
}

function noOverlapSql(employeeId: string, startsAt: number, endsAt: number, exceptId: string | null) {
  return sql`NOT EXISTS (SELECT 1 FROM attendance WHERE employee_id = ${employeeId} ${exceptId ? sql`AND id <> ${exceptId}` : sql``}
    AND clock_in_at < ${endsAt} AND coalesce(clock_out_at, ${Number.MAX_SAFE_INTEGER}) > ${startsAt})`;
}

/**
 * A manager records someone's worked hours by hand (staff.attendance.manage): a forgotten clock-in, a day at another
 * site. Never one's own; never overlapping another record of theirs; recorded by a manager counts as approved by them.
 */
export async function recordAttendance(db: Db, actor: Actor, raw: z.input<typeof RecordInput>, now: number): Promise<{ attendanceId: string }> {
  assertAny(actor, ["staff.attendance.manage"]);
  const input = RecordInput.parse(raw);
  notOwn(actor, input.employeeId);
  const times = shiftTimes(input.day, input.start, input.end);
  if ("field" in times) throw invalid({ [times.field]: times.code === "shift_too_long" ? "attendance_too_long" : times.code });
  if (times.endsAt - times.startsAt > MAX_ATTENDANCE_MS) throw invalid({ end: "attendance_too_long" });
  if (times.endsAt > now) throw invalid({ end: "attendance_future" });
  const employee = await activeEmployee(db, input.employeeId);
  assertReach(actor, employee);
  const shift = await shiftAt(db, employee.id, times.startsAt, CLOCK_IN_EARLY_MS);
  const id = newId("att");
  try {
    await runBatch(db, [
      expectThat(db, noOverlapSql(employee.id, times.startsAt, times.endsAt, null), { code: "ATTENDANCE_OVERLAP", detail: employee.id }),
      db.insert(attendance).values({ id, employeeId: employee.id, shiftId: shift?.id ?? null, branchId: shift?.branchId ?? employee.branchId, clockInAt: times.startsAt, clockOutAt: times.endsAt, method: "manager", note: input.reason, approvedBy: actorId(actor) }),
      ...(shift ? [db.update(shifts).set({ status: "completed" }).where(and(eq(shifts.id, shift.id), eq(shifts.status, "scheduled")))] : []),
      auditStatement(db, { actor, action: "staff.attendance.record", entityType: "attendance", entityId: id, summary: `${employee.name}: ${input.day}`, after: { employeeId: employee.id, clockInAt: times.startsAt, clockOutAt: times.endsAt }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "ATTENDANCE_OVERLAP")) throw new AppError("attendance_overlap", 409, { fields: { start: "attendance_overlap" } });
    throw error;
  }
  return { attendanceId: id };
}

const CorrectInput = z.object({
  attendanceId: IdSchema,
  day: z.string({ error: "required" }).refine(isDay, "invalid"),
  start: z.string({ error: "required" }),
  end: z.string({ error: "required" }),
  reason: Reason,
  /** The record as the form showed it. */
  expectedClockInAt: z.number().int(),
  expectedClockOutAt: z.number().int().nullable(),
});

/** Corrects a record's times (staff.attendance.manage, a reason; never one's own); the corrector approves it. */
export async function correctAttendance(db: Db, actor: Actor, raw: z.input<typeof CorrectInput>, now: number): Promise<{ changed: true }> {
  assertAny(actor, ["staff.attendance.manage"]);
  const input = CorrectInput.parse(raw);
  const row = await db.select().from(attendance).where(eq(attendance.id, input.attendanceId)).get();
  if (!row) throw notFound("attendance");
  notOwn(actor, row.employeeId);
  await assertReachOf(db, actor, row.employeeId);
  if (row.clockInAt !== input.expectedClockInAt || row.clockOutAt !== input.expectedClockOutAt) throw new AppError("attendance_changed", 409);
  const times = shiftTimes(input.day, input.start, input.end);
  if ("field" in times) throw invalid({ [times.field]: times.code === "shift_too_long" ? "attendance_too_long" : times.code });
  if (times.endsAt - times.startsAt > MAX_ATTENDANCE_MS) throw invalid({ end: "attendance_too_long" });
  if (times.endsAt > now) throw invalid({ end: "attendance_future" });
  try {
    await runBatch(db, [
      expectThat(db, noOverlapSql(row.employeeId, times.startsAt, times.endsAt, row.id), { code: "ATTENDANCE_OVERLAP", detail: row.employeeId }),
      db
        .update(attendance)
        .set({ clockInAt: times.startsAt, clockOutAt: times.endsAt, approvedBy: actorId(actor) })
        .where(and(eq(attendance.id, row.id), eq(attendance.clockInAt, input.expectedClockInAt), input.expectedClockOutAt === null ? isNull(attendance.clockOutAt) : eq(attendance.clockOutAt, input.expectedClockOutAt))),
      expectChanged(db, 1, { code: "ATTENDANCE_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "staff.attendance.correct", entityType: "attendance", entityId: row.id, before: { clockInAt: row.clockInAt, clockOutAt: row.clockOutAt, approvedBy: row.approvedBy }, after: { clockInAt: times.startsAt, clockOutAt: times.endsAt, approvedBy: actorId(actor) }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "ATTENDANCE_OVERLAP")) throw new AppError("attendance_overlap", 409, { fields: { start: "attendance_overlap" } });
    if (isDbError(error, "ATTENDANCE_CHANGED")) throw new AppError("attendance_changed", 409);
    throw error;
  }
  return { changed: true };
}

const ApproveInput = z.object({ ids: z.array(IdSchema).min(1, "required").max(100, "too_big") });

/**
 * Approves closed records (staff.attendance.manage) — the bulk action of the list. Records of one's own, still open
 * or already approved are skipped, never approved: the update itself carries those conditions.
 */
export async function approveAttendance(db: Db, actor: Actor, raw: z.input<typeof ApproveInput>, now: number): Promise<{ approved: number; skipped: number }> {
  assertAny(actor, ["staff.attendance.manage"]);
  const input = ApproveInput.parse(raw);
  const me = actorId(actor) ?? "system";
  const ids = [...new Set(input.ids)];
  // records of someone out of a branch-limited approver's reach are skipped like their own
  const eligible = await db
    .select({ id: attendance.id })
    .from(attendance)
    .where(and(inArray(attendance.id, ids), isNull(attendance.approvedBy), isNotNull(attendance.clockOutAt), sql`${attendance.employeeId} <> ${me}`, reachSql(actor, attendance.employeeId)));
  const approvedIds = eligible.map((row) => row.id);
  if (approvedIds.length) {
    await runBatch(db, [
      db
        .update(attendance)
        .set({ approvedBy: me })
        .where(and(inArray(attendance.id, approvedIds), isNull(attendance.approvedBy), isNotNull(attendance.clockOutAt), sql`${attendance.employeeId} <> ${me}`, reachSql(actor, attendance.employeeId))),
      auditStatement(db, { actor, action: "staff.attendance.approve", entityType: "attendance", entityId: approvedIds.length === 1 ? approvedIds[0] : null, summary: `${approvedIds.length} attendance record(s) approved`, after: { ids: approvedIds }, at: now }),
    ]);
  }
  return { approved: approvedIds.length, skipped: ids.length - approvedIds.length };
}

/** Who is clocked in right now (for the module's front page): id, name, since. */
export async function clockedInNow(db: Db): Promise<{ employee: PersonRef; since: number }[]> {
  const rows = await db.select({ employeeId: attendance.employeeId, since: attendance.clockInAt }).from(attendance).where(isNull(attendance.clockOutAt)).orderBy(asc(attendance.clockInAt)).limit(100);
  const people = await peopleById(db, rows.map((row) => row.employeeId));
  return rows.map((row) => ({ employee: personOf(people, row.employeeId), since: row.since }));
}

