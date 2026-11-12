/**
 * Admin module 15 "staff" — people and time, against a real local D1:
 *
 *   · authorization per role (cashier, support, finance, manager, owner, custom roles) on every service
 *   · 15.01 each employee's effective permissions: what their roles grant, protected-data ones marked, read-only
 *   · 15.02 the schedule (no overlapping shifts — also two planners at once — none in the past or on approved leave,
 *     a week copied without overlaps), attendance (one open clock-in, late arrivals, never one's own record by hand
 *     or approved by oneself), leave (never decided on one's own, no overlaps, approving cancels that day's shifts),
 *     tasks (the assignee or a task manager moves them; another module's tasks change only there)
 *   · 15.05 performance without any cost: the result never carries a cost or profit figure
 *   · 15.06 the store's pending approvals without their payload; one's own requests
 *   · 15.07 termination through the sign-in service: locked out, sessions ended, future shifts and pending leave
 *     cancelled; never oneself, never an account holding more than the actor
 *   · route loaders: 403 for a role without the page's permission
 */
import { eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { approvals, employeeRoles, employeeSessions, employees, leaveRequests, rolePermissions, roles, shifts, staffTasks } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { FIELD_PERMISSIONS, PERMISSIONS, defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { approvalHref, approvalModule, myRequests, storeApprovals } from "~/server/services/admin/staff/approvals.server";
import { approveAttendance, clockIn, clockOut, correctAttendance, listAttendance, recordAttendance } from "~/server/services/admin/staff/attendance.server";
import { effectivePermissions, getEmployeeProfile, listEmployees, terminateEmployee, terminationPlan, updateEmployeeProfile } from "~/server/services/admin/staff/employees.server";
import { cancelLeave, decideLeave, listLeave, requestLeave } from "~/server/services/admin/staff/leave.server";
import { performance } from "~/server/services/admin/staff/performance.server";
import { cancelShift, copyWeek, createShift, listRoster } from "~/server/services/admin/staff/schedule.server";
import { createTask, listTasks, moveTask, reassignTask } from "~/server/services/admin/staff/tasks.server";
import { addDays, baghdadDay, parseAttendanceFilters, parseEmployeeFilters, parseRateBps, parseTaskFilters, periodOf, STAFF_ERROR_KEYS, weekStartOf } from "~/server/services/admin/staff/types";
import staffMessages from "~/i18n/messages/admin-staff";
import sharedErrors from "~/i18n/messages/errors";
import { loader as employeesLoader } from "~/routes/admin/staff/employees";
import { loader as payrollLoader } from "~/routes/admin/staff/payroll";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW; // Tuesday 10 Nov 2026, 09:00 Baghdad
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TODAY = baghdadDay(NOW);
const TOMORROW = addDays(TODAY, 1);
const ORIGIN = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor; email: string; password: string };
const people: Record<string, Person> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "cashier", "support"] as const) people[role] = await person(role);
  people.hr = await person(["staff.manage", "staff.employee.read"], "موارد بشرية");
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], name?: string): Promise<Person> {
  const password = "staff-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("staff")}@staff.test`;
  const id = await make.employee({ email, name: name ?? (Array.isArray(role) ? "custom" : role), passwordHash: hashed.hash, passwordIters: hashed.iterations, createdAt: NOW - 60 * DAY });
  if (Array.isArray(role)) {
    const custom = `role_${make.next("custom").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    if (role.length) await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, email, password, actor: { kind: "employee", id, permissions: new Set<string>(role), label: name ?? "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const permissions = role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  return { id, email, password, actor: { kind: "employee", id, permissions, label: name ?? role } };
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const code = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.code ?? "unexpected";

describe("authorization", () => {
  test("each service refuses a role without its permission", async () => {
    const cashier = people.cashier.actor;
    const support = people.support.actor;
    expect(await code(() => listEmployees(t.db, cashier, parseEmployeeFilters(new URLSearchParams()), "ar"))).toBe("forbidden");
    expect(await code(() => listRoster(t.db, support, { week: weekStartOf(TODAY), employee: null }, "ar", NOW))).toBe("forbidden");
    expect(await code(() => listAttendance(t.db, people.finance.actor, parseAttendanceFilters(new URLSearchParams(), NOW), "ar"))).toBe("forbidden");
    expect(await code(() => listLeave(t.db, cashier, { status: null, employee: null, page: 1 }, NOW))).toBe("forbidden");
    expect(await code(() => createShift(t.db, people.finance.actor, { employeeId: people.cashier.id, day: TOMORROW, start: "09:00", end: "17:00" }, NOW))).toBe("forbidden");
    expect(await code(() => createTask(t.db, people.finance.actor, { title: "مهمة", assigneeId: people.cashier.id }, NOW))).toBe("forbidden");
    expect(await code(() => performance(t.db, people.finance.actor, { period: periodOf(NOW) }, "ar", NOW))).toBe("forbidden");
    expect(await code(() => storeApprovals(t.db, cashier, "ar"))).toBe("forbidden");
    expect(await code(() => terminateEmployee(t.db, people.manager.actor, { employeeId: people.cashier.id, reason: "انتهاء العقد" }, NOW))).toBe("forbidden");
    // what each default role may open
    expect((await listEmployees(t.db, people.finance.actor, parseEmployeeFilters(new URLSearchParams()), "ar")).rows.length).toBeGreaterThan(0);
    expect((await performance(t.db, people.manager.actor, { period: periodOf(NOW) }, "ar", NOW)).can.pay).toBe(true);
    // a cashier still clocks in and sees their own tasks
    const own = await listTasks(t.db, cashier, parseTaskFilters(new URLSearchParams()), NOW);
    expect(own.can.seeAll).toBe(false);
  });

  test("every error code of the module has a text in ar, en and ckb (module first, then the shared errors)", () => {
    const textOf = (tree: unknown, locale: string, key: string) => ((tree as Record<string, { errors?: Record<string, unknown> }>)[locale]?.errors ?? {})[key];
    for (const locale of ["ar", "en", "ckb"]) {
      for (const key of [...STAFF_ERROR_KEYS, "approver_is_requester", "last_owner", "cannot_disable_self", "employee_not_active"]) {
        expect(textOf(staffMessages, locale, key) ?? textOf(sharedErrors, locale, key), `${locale} ${key}`).toEqual(expect.any(String));
      }
    }
  });

  test("rates are typed as percentages with Arabic-Indic and Persian digits", () => {
    expect(parseRateBps("2.5")).toBe(250);
    expect(parseRateBps("٢٫٥")).toBe(250);
    expect(parseRateBps("۱۰%")).toBe(1_000);
    expect(parseRateBps("")).toBeUndefined();
    expect(Number.isNaN(parseRateBps("101") as number)).toBe(true);
    expect(Number.isNaN(parseRateBps("1.234") as number)).toBe(true);
  });
});

describe("15.01 effective permissions (read-only)", () => {
  test("what the roles grant, protected-data permissions marked, with the role that grants each", async () => {
    const finance = await effectivePermissions(t.db, people.finance.id, "ar");
    expect(finance.all).toBe(false);
    expect(finance.field).toEqual(expect.arrayContaining(["cost.read", "profit.read"]));
    const fields = finance.groups.find((group) => group.key === "fields")!;
    expect(fields.permissions.find((permission) => permission.key === "cost.read")).toMatchObject({ field: true, roles: [expect.any(String)] });
    const owner = await effectivePermissions(t.db, people.owner.id, "ar");
    expect(owner.all).toBe(true);
    expect(owner.count).toBe(PERMISSIONS.length);
    expect(owner.field).toEqual([...FIELD_PERMISSIONS]);
    const profile = await getEmployeeProfile(t.db, people.hr.actor, people.cashier.id, "ar", NOW);
    expect(profile.permissions.field).toEqual([]);
    expect(profile.links.roleEditor).toBe(true);
    expect(profile.salary).toBeNull();
  });

  test("HR facts change with a reason, on the row the form showed", async () => {
    const profile = await getEmployeeProfile(t.db, people.owner.actor, people.support.id, "ar", NOW);
    await updateEmployeeProfile(t.db, people.hr.actor, { employeeId: people.support.id, jobTitle: "مسؤول الدعم", phone: "0770 123 4567", reason: "تحديث الملف", expectedUpdatedAt: profile.employee.updatedAt }, NOW);
    expect(await code(() => updateEmployeeProfile(t.db, people.hr.actor, { employeeId: people.support.id, jobTitle: "x", reason: "تحديث", expectedUpdatedAt: profile.employee.updatedAt }, NOW + 1))).toBe("employee_changed");
    expect(await code(() => updateEmployeeProfile(t.db, people.manager.actor, { employeeId: people.support.id, jobTitle: "x", reason: "تحديث", expectedUpdatedAt: 0 }, NOW))).toBe("forbidden");
  });
});

describe("15.02 schedule", () => {
  test("no overlapping shifts — also two planners at once — none in the past, none on approved leave", async () => {
    const worker = await person("cashier");
    const manager = people.manager.actor;
    await createShift(t.db, manager, { employeeId: worker.id, day: TOMORROW, start: "09:00", end: "17:00" }, NOW);
    expect(await code(() => createShift(t.db, manager, { employeeId: worker.id, day: TOMORROW, start: "16:00", end: "20:00" }, NOW))).toBe("shift_overlap");
    expect(await code(() => createShift(t.db, manager, { employeeId: worker.id, day: addDays(TODAY, -2), start: "09:00", end: "17:00" }, NOW))).toBe("shift_in_past");
    expect(await code(() => createShift(t.db, manager, { employeeId: worker.id, day: TOMORROW, start: "25:00", end: "17:00" }, NOW))).toBe("invalid");
    // an overnight shift ends the next day; two planners at once: one wins
    const day = addDays(TODAY, 3);
    const results = await Promise.allSettled([
      createShift(t.db, manager, { employeeId: worker.id, day, start: "20:00", end: "04:00" }, NOW),
      createShift(t.db, people.owner.actor, { employeeId: worker.id, day, start: "22:00", end: "06:00" }, NOW),
    ]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    // approved leave blocks a shift that day
    const leaveDay = addDays(TODAY, 5);
    const leave = await requestLeave(t.db, worker.actor, { kind: "annual", startsOn: leaveDay, endsOn: leaveDay }, NOW);
    await decideLeave(t.db, manager, { leaveId: leave.leaveId, decision: "approve" }, NOW);
    expect(await code(() => createShift(t.db, manager, { employeeId: worker.id, day: leaveDay, start: "09:00", end: "17:00" }, NOW))).toBe("shift_on_leave");
    const roster = await listRoster(t.db, people.finance.actor, { week: weekStartOf(TOMORROW), employee: worker.id }, "ar", NOW);
    expect(roster.rows[0].days.flat().length).toBeGreaterThanOrEqual(1);
    expect(roster.can.manage).toBe(false);
  });

  test("a week is copied without overlaps; a cancelled shift needs a reason", async () => {
    const worker = await person("cashier");
    const week = weekStartOf(addDays(TODAY, 7));
    const made = await createShift(t.db, people.manager.actor, { employeeId: worker.id, day: addDays(week, 1), start: "10:00", end: "18:00" }, NOW);
    await createShift(t.db, people.manager.actor, { employeeId: worker.id, day: addDays(week, 8), start: "12:00", end: "15:00" }, NOW);
    const copied = await copyWeek(t.db, people.manager.actor, { fromWeek: week, toWeek: addDays(week, 7) }, NOW);
    // the copy of Sunday 10:00–18:00 overlaps the 12:00–15:00 shift already there: skipped
    expect(copied.copied).toBe(0);
    const copiedAgain = await copyWeek(t.db, people.manager.actor, { fromWeek: week, toWeek: addDays(week, 14) }, NOW);
    expect(copiedAgain.copied).toBe(1);
    expect(await code(() => cancelShift(t.db, people.manager.actor, { shiftId: made.shiftId, reason: "" }, NOW))).toBe("invalid");
    await cancelShift(t.db, people.manager.actor, { shiftId: made.shiftId, reason: "تغيير الجدول" }, NOW);
    expect(await code(() => cancelShift(t.db, people.manager.actor, { shiftId: made.shiftId, reason: "مرة ثانية" }, NOW))).toBe("shift_not_scheduled");
  });

  test("attendance: one open clock-in, lateness, never one's own record by hand or approved by oneself", async () => {
    const worker = await person("cashier");
    const shiftStart = NOW + HOUR; // 10:00
    await t.db.insert(shifts).values({ id: newId("shf"), employeeId: worker.id, startsAt: shiftStart, endsAt: shiftStart + 8 * HOUR, status: "scheduled", createdAt: NOW - DAY });
    const first = await clockIn(t.db, worker.actor, {}, shiftStart + 25 * 60_000);
    expect(first.late).toBe(true);
    expect(first.shiftId).not.toBeNull();
    expect(await code(() => clockIn(t.db, worker.actor, {}, shiftStart + 30 * 60_000))).toBe("already_clocked_in");
    const out = await clockOut(t.db, worker.actor, {}, shiftStart + 8 * HOUR);
    expect(out.minutes).toBe(8 * 60 - 25);
    expect(await code(() => clockOut(t.db, worker.actor, {}, shiftStart + 9 * HOUR))).toBe("not_clocked_in");
    // a manager records their own hours: refused
    expect(await code(() => recordAttendance(t.db, people.manager.actor, { employeeId: people.manager.id, day: TODAY, start: "07:00", end: "08:00", reason: "نسيت" }, NOW))).toBe("attendance_self_approval");
    // records the worker's hours (overlapping their record: refused)
    expect(await code(() => recordAttendance(t.db, people.manager.actor, { employeeId: worker.id, day: TODAY, start: "11:00", end: "12:00", reason: "تسجيل يدوي" }, NOW + 12 * HOUR))).toBe("attendance_overlap");
    const page = await listAttendance(t.db, people.manager.actor, { from: TODAY, to: TODAY, employee: worker.id, state: "all", page: 1 }, "ar");
    expect(page.rows[0]).toMatchObject({ late: true, lateMinutes: 25, canApprove: true });
    // approving in bulk skips one's own records
    const mine = await clockIn(t.db, people.manager.actor, {}, NOW + 10 * HOUR);
    await clockOut(t.db, people.manager.actor, {}, NOW + 11 * HOUR);
    const result = await approveAttendance(t.db, people.manager.actor, { ids: [page.rows[0].id, mine.attendanceId] }, NOW + 12 * HOUR);
    expect(result).toEqual({ approved: 1, skipped: 1 });
    // and the list offers no key on one's own record
    const own = await listAttendance(t.db, people.manager.actor, { from: TODAY, to: TODAY, employee: people.manager.id, state: "all", page: 1 }, "ar");
    expect(own.rows[0]).toMatchObject({ canApprove: false, canCorrect: false });
    expect(page.rows[0].canCorrect).toBe(true);
    // a correction needs the record as the form showed it
    const row = page.rows[0];
    expect(await code(() => correctAttendance(t.db, people.owner.actor, { attendanceId: row.id, day: TODAY, start: "10:00", end: "18:00", reason: "تصحيح", expectedClockInAt: row.clockInAt + 1, expectedClockOutAt: row.clockOutAt }, NOW + 12 * HOUR))).toBe("attendance_changed");
    await correctAttendance(t.db, people.owner.actor, { attendanceId: row.id, day: TODAY, start: "10:00", end: "18:00", reason: "تصحيح الدخول", expectedClockInAt: row.clockInAt, expectedClockOutAt: row.clockOutAt }, NOW + 12 * HOUR);
  });

  test("leave: never decided on one's own, no overlaps, approval cancels that day's shifts", async () => {
    const worker = await person("cashier");
    const day = addDays(TODAY, 10);
    await t.db.insert(shifts).values({ id: newId("shf"), employeeId: worker.id, startsAt: Date.parse(`${day}T06:00:00Z`), endsAt: Date.parse(`${day}T14:00:00Z`), status: "scheduled", createdAt: NOW });
    const asked = await requestLeave(t.db, worker.actor, { kind: "sick", startsOn: day, endsOn: addDays(day, 1), reason: "مراجعة طبية" }, NOW);
    expect(await code(() => requestLeave(t.db, worker.actor, { kind: "annual", startsOn: addDays(day, 1), endsOn: addDays(day, 2) }, NOW))).toBe("leave_overlap");
    expect(await code(() => requestLeave(t.db, worker.actor, { kind: "annual", startsOn: addDays(TODAY, -40), endsOn: addDays(TODAY, -39) }, NOW))).toBe("invalid");
    const managerAsked = await requestLeave(t.db, people.manager.actor, { kind: "annual", startsOn: day, endsOn: day }, NOW);
    expect(await code(() => decideLeave(t.db, people.manager.actor, { leaveId: managerAsked.leaveId, decision: "approve" }, NOW))).toBe("leave_self_decision");
    expect(await code(() => decideLeave(t.db, people.manager.actor, { leaveId: asked.leaveId, decision: "reject" }, NOW))).toBe("invalid");
    const decided = await decideLeave(t.db, people.manager.actor, { leaveId: asked.leaveId, decision: "approve" }, NOW);
    expect(decided).toEqual({ status: "approved", shiftsCancelled: 1 });
    expect(await code(() => cancelLeave(t.db, worker.actor, { leaveId: asked.leaveId }, NOW))).toBe("leave_not_cancellable");
    await cancelLeave(t.db, people.owner.actor, { leaveId: asked.leaveId, reason: "عاد للعمل" }, NOW);
  });

  test("tasks: the assignee or a task manager moves them; another module's tasks change only there", async () => {
    const worker = await person("cashier");
    const other = await person("cashier");
    const { taskId } = await createTask(t.db, people.manager.actor, { title: "رتّب رف الألعاب", assigneeId: worker.id, priority: "high", dueDay: TOMORROW }, NOW);
    expect(await code(() => moveTask(t.db, other.actor, { taskId, to: "done" }, NOW))).toBe("task_not_yours");
    await moveTask(t.db, worker.actor, { taskId, to: "in_progress" }, NOW);
    expect(await code(() => moveTask(t.db, worker.actor, { taskId, to: "cancelled", reason: "لا أريد" }, NOW))).toBe("task_not_open");
    await reassignTask(t.db, people.manager.actor, { taskId, assigneeId: other.id }, NOW);
    await moveTask(t.db, other.actor, { taskId, to: "done" }, NOW);
    const refTask = newId("tsk");
    await t.db.insert(staffTasks).values({ id: refTask, title: "جهّز الطلب", assignedTo: worker.id, status: "open", refType: "order", refId: "ord_x", createdAt: NOW });
    expect(await code(() => moveTask(t.db, worker.actor, { taskId: refTask, to: "done" }, NOW))).toBe("task_managed_elsewhere");
    const mine = await listTasks(t.db, worker.actor, { status: "all", assignee: null, mine: false, page: 1 }, NOW);
    expect(mine.rows.every((row) => row.assignee?.id === worker.id)).toBe(true);
    expect(mine.rows.find((row) => row.id === refTask)?.moves).toEqual([]);
  });
});

describe("15.05 performance, 15.06 approvals", () => {
  test("performance carries no cost or profit figure", async () => {
    const view = await performance(t.db, people.owner.actor, { period: periodOf(NOW) }, "ar", NOW);
    expect(JSON.stringify(view)).not.toMatch(/cost|profit|margin/i);
  });

  test("the store's pending approvals without their payload; one's own requests", async () => {
    await t.db.insert(approvals).values({ id: newId("apr"), kind: "wallet_adjustment", entityType: "customer", entityId: "cus_x", requestedBy: people.finance.id, payload: { amountIqd: 987_654 }, status: "pending", reason: "تسوية", createdAt: NOW - DAY });
    const store = await storeApprovals(t.db, people.manager.actor, "ar");
    expect(store.byKind.find((row) => row.kind === "wallet_adjustment")?.count).toBe(1);
    expect(JSON.stringify(store)).not.toContain("987654");
    expect(store.rows[0].href).toBe("/admin/finance/wallets?tab=adjustments");
    const mine = await myRequests(t.db, people.finance.actor);
    expect(mine.map((row) => row.kind)).toContain("wallet_adjustment");
    // every request links to the screen where its module decides it
    expect(approvalHref("coupon", "coupon", "cpn_1")).toBe("/admin/promotions/approvals");
    expect(approvalModule("loyalty_adjustment")).toBe("promotions");
    expect(approvalHref("staff_advance", "employee", "emp_1")).toBe("/admin/staff/payroll/advances");
    expect(approvalHref("something_new", null, null)).toBeNull();
  });
});

describe("15.07 termination", () => {
  test("locked out, sessions ended, future shifts and pending leave cancelled; never oneself or a stronger account", async () => {
    // someone who holds nothing the HR role does not (the hierarchy rule: never an account holding more than the actor)
    const leaver = await person(["staff.employee.read"], "مغادر");
    expect((await terminationPlan(t.db, people.hr.actor, people.cashier.id, NOW)).blockers).toEqual(["outranked"]);
    const idHash = await sha256Hex(randomToken());
    await t.db.insert(employeeSessions).values({ idHash, employeeId: leaver.id, mfaOk: true, createdAt: NOW - HOUR, lastSeenAt: NOW - 60_000, expiresAt: NOW + 11 * HOUR });
    await t.db.insert(shifts).values({ id: newId("shf"), employeeId: leaver.id, startsAt: NOW + 2 * DAY, endsAt: NOW + 2 * DAY + 8 * HOUR, status: "scheduled", createdAt: NOW });
    await t.db.insert(leaveRequests).values({ id: newId("lvr"), employeeId: leaver.id, kind: "annual", startsOn: addDays(TODAY, 20), endsOn: addDays(TODAY, 21), status: "pending", createdAt: NOW });
    const plan = await terminationPlan(t.db, people.hr.actor, leaver.id, NOW);
    expect(plan).toMatchObject({ liveSessions: 1, futureShifts: 1, pendingLeave: 1, blockers: [], openAdvancesIqd: null });
    expect(await code(() => terminateEmployee(t.db, people.hr.actor, { employeeId: people.hr.id, reason: "اختبار" }, NOW))).toBe("own_account_here");
    expect(await code(() => terminateEmployee(t.db, people.hr.actor, { employeeId: people.manager.id, reason: "اختبار" }, NOW))).toBe("target_more_privileged");
    const done = await terminateEmployee(t.db, people.hr.actor, { employeeId: leaver.id, reason: "انتهاء العقد" }, NOW);
    expect(done).toEqual({ sessionsEnded: 1, shiftsCancelled: 1, leaveCancelled: 1, attendanceClosed: 0 });
    const row = await t.db.select({ status: employees.status }).from(employees).where(eq(employees.id, leaver.id)).get();
    expect(row?.status).toBe("disabled");
    const session = await t.db.select({ revokedAt: employeeSessions.revokedAt }).from(employeeSessions).where(eq(employeeSessions.idHash, idHash)).get();
    expect(session?.revokedAt).toBe(NOW);
    expect(await code(() => terminateEmployee(t.db, people.hr.actor, { employeeId: leaver.id, reason: "مرة ثانية" }, NOW))).toBe("employee_not_active");
    const audit = await t.db.all<{ action: string }>(sql`SELECT action FROM audit_events WHERE entity_id = ${leaver.id} ORDER BY seq`);
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining(["staff.employee.disable", "staff.employee.offboard"]));
  });
});

// ───────────────────────────────────────────────────────────────── routes

/** The sign-in runs on the real clock: the loaders below go through the request middleware, which reads Date.now(). */
function requestCtx(): RequestCtx {
  return {
    requestId: `staff-${randomToken(6)}`,
    nonce: "n",
    origin: ORIGIN,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: null,
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: () => null,
    setCookie: () => {},
  };
}

async function signedIn(who: Person): Promise<string> {
  const setCookies: string[] = [];
  const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
  const result = await signInEmployee(ctx, t.db, { email: who.email, password: who.password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  return setCookies.map((line) => line.split("; ")[0]).find((value) => value.startsWith("tt_adm=") && value.length > 10) ?? "";
}

async function run(cookie: string, path: string, fn: (args: never) => unknown): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { headers: { cookie } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params: {}, url: new URL(request.url), pattern: path } as never);
      return new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}

const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);

describe("routes", () => {
  test("the directory answers 403 to a cashier and serves finance; payroll answers 403 to support", async () => {
    const cashierCookie = await signedIn(people.cashier);
    expect(statusOf(await run(cashierCookie, "/admin/staff/employees", employeesLoader as never))).toBe(403);
    const financeCookie = await signedIn(people.finance);
    const data = (await run(financeCookie, "/admin/staff/employees", employeesLoader as never)) as { page?: { rows: unknown[] } };
    expect(data.page?.rows.length).toBeGreaterThan(0);
    const supportCookie = await signedIn(people.support);
    const refused = await run(supportCookie, "/admin/staff/payroll", payrollLoader as never);
    expect(statusOf(refused)).toBe(403);
    // the shell's error page names what was missing
    expect((refused as { data?: { permission?: string } }).data?.permission).toBe("staff.payroll.read · staff.payroll.run · staff.payroll.approve");
  });
});
