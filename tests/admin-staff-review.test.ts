/**
 * Admin module 15 "staff" — adversarial review (2026-11-12). Each test failed on the builder's code:
 *
 *   · two people: whoever changed a salary never approves the first run that pays it, even when an older run of the
 *     employee was paid after the change (the old rule only looked at changes after the last PAYMENT)
 *   · branch limits: an employee limited to a branch neither reads nor changes the staff of another branch (or of the
 *     whole store), and the store-wide payroll is not theirs
 *   · an unknown decision posted to a route is refused, never read as "approve" (leave, advances, a shift's mark)
 *   · the module's front page counts only the advances this approver may decide
 *   · a profit plan is not superseded by someone who may not see profit
 *   · approving leave cancels a shift planned a moment before, inside the batch
 *   · nobody marks their own shift worked; whoever recorded leave for someone does not approve it
 */
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, branches, employeeRoles, employees, leaveRequests, rolePermissions, roles, shifts } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { staffDecisions } from "~/server/services/admin/staff/approvals.server";
import { listAttendance, recordAttendance } from "~/server/services/admin/staff/attendance.server";
import { saveRuleVersion } from "~/server/services/admin/staff/commissions.server";
import { getEmployeeProfile, listEmployees, setBaseSalary, terminateEmployee, updateEmployeeProfile } from "~/server/services/admin/staff/employees.server";
import { decideLeave, listLeave, requestLeave } from "~/server/services/admin/staff/leave.server";
import { staffOverview } from "~/server/services/admin/staff/overview.server";
import { approveRun, decideAdvance, getRun, listAdvances, listRuns, payRun, prepareRun, requestAdvance } from "~/server/services/admin/staff/payroll.server";
import { createShift, listRoster, markShift } from "~/server/services/admin/staff/schedule.server";
import { createTask } from "~/server/services/admin/staff/tasks.server";
import { addDays, baghdadDay, parseAttendanceFilters, parseEmployeeFilters, parsePeriod, parseRosterFilters, periodOf, weekStartOf } from "~/server/services/admin/staff/types";
import { action as advancesAction } from "~/routes/admin/staff/advances";
import { action as leaveAction } from "~/routes/admin/staff/leave";
import { action as scheduleAction } from "~/routes/admin/staff/schedule";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW; // Tuesday 10 Nov 2026, 09:00 Baghdad
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TODAY = baghdadDay(NOW);
const TOMORROW = addDays(TODAY, 1);
const ORIGIN = "http://localhost:5173";
const PASSWORD = "staff-review-password-1";

let t: TestDb;
let make: Fixtures;
type Person = { id: string; email: string; actor: EmployeeActor };
const people: Record<string, Person> = {};
let keyCounter = 0;
const key = () => `review-key-${String(++keyCounter).padStart(10, "0")}`;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance"] as const) people[role] = await person(role);
  people.owner2 = await person("owner");
  // a commission administrator who may not see profit
  people.clerk = await person(["staff.commission.manage", "staff.payroll.read"]);
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], overrides: Partial<typeof employees.$inferInsert> = {}): Promise<Person> {
  const hashed = await hashPassword(PASSWORD, 1000);
  const email = `${make.next("review")}@staff-review.test`;
  const id = await make.employee({ email, name: Array.isArray(role) ? "custom" : role, passwordHash: hashed.hash, passwordIters: hashed.iterations, createdAt: NOW - 400 * DAY, ...overrides });
  const branchId = overrides.branchId ?? null;
  if (Array.isArray(role)) {
    const custom = `role_${make.next("custom").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    if (role.length) await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, email, actor: { kind: "employee", id, permissions: new Set<string>(role), branchId, label: "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const permissions = role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  return { id, email, actor: { kind: "employee", id, permissions, branchId, label: role } };
}

async function branch(): Promise<string> {
  const id = newId("brn");
  await t.db.insert(branches).values({ id, code: make.next("BR"), name: { ar: "فرع المراجعة", en: "Review branch" }, createdAt: NOW });
  return id;
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

type Batch = (statements: unknown) => Promise<unknown>;
/** The same database, except that `hook` runs once just before the `nth` db.batch call: a competing request. */
function beforeBatch(db: Db, nth: number, hook: () => PromiseLike<unknown>): Db {
  let calls = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: unknown) => {
          calls += 1;
          if (calls === nth) await hook();
          return (target.batch as unknown as Batch).call(target, statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ───────────────────────────────────────────────────────────────── routes (signed in through the real middleware)

function requestCtx(setCookies: string[]): RequestCtx {
  return {
    requestId: `staff-review-${make.next("rq")}`,
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
    setCookie: (serialized: string) => void setCookies.push(serialized),
  } as RequestCtx;
}

async function signedIn(who: Person): Promise<string> {
  const setCookies: string[] = [];
  const result = await signInEmployee(requestCtx(setCookies), t.db, { email: who.email, password: PASSWORD });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function post(cookie: string, path: string, body: Record<string, string>, run: (args: never) => unknown): Promise<unknown> {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) form.set(name, value);
  const request = new Request(`${ORIGIN}${path}`, { method: "POST", body: form, headers: { cookie, origin: ORIGIN } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await run({ request, context, params: {} } as never);
      return new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}

const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);

describe("admin 15 staff — adversarial review", () => {
  test("two people: whoever changed a salary never approves the first run that pays it, even after an older run was paid", async () => {
    // July: the run is prepared with the old salary; then a second owner raises it; July is approved and paid after the raise
    const julyEnd = Date.UTC(2026, 6, 31, 9, 0, 0);
    const worker = await person("manager", { isDemo: true, createdAt: Date.UTC(2026, 0, 1) });
    await setBaseSalary(t.db, people.finance.actor, { employeeId: worker.id, baseSalaryIqd: 500_000, expectedIqd: null, reason: "راتب البداية" }, julyEnd - 40 * DAY);
    const july = await prepareRun(t.db, people.finance.actor, { period: periodOf(julyEnd), demo: true, idempotencyKey: key() }, julyEnd);
    const changer = await person("owner", { isDemo: true });
    await setBaseSalary(t.db, changer.actor, { employeeId: worker.id, baseSalaryIqd: 2_000_000, expectedIqd: 500_000, reason: "ترقية" }, julyEnd + HOUR);
    const julyDetail = await getRun(t.db, people.owner.actor, july.runId, julyEnd + 2 * HOUR);
    expect(julyDetail.items.find((item) => item.employee.id === worker.id)?.baseIqd).toBe(500_000);
    await approveRun(t.db, people.owner.actor, { runId: july.runId, expectedNetIqd: julyDetail.totals.netIqd, expectedItems: julyDetail.items.length }, julyEnd + 2 * HOUR);
    await payRun(t.db, people.owner2.actor, { runId: july.runId, paidFrom: "cash" }, julyEnd + 3 * HOUR);

    // August is the first run that pays the raise: its author may not approve it
    const augustEnd = Date.UTC(2026, 7, 31, 9, 0, 0);
    const august = await prepareRun(t.db, people.finance.actor, { period: periodOf(augustEnd), demo: true, idempotencyKey: key() }, augustEnd);
    const detail = await getRun(t.db, changer.actor, august.runId, augustEnd);
    expect(detail.items.find((item) => item.employee.id === worker.id)?.baseIqd).toBe(2_000_000);
    expect(detail.can.approve).toBe(false);
    expect((await staffDecisions(t.db, changer.actor)).some((row) => row.id === august.runId)).toBe(false);
    expect(await code(() => approveRun(t.db, changer.actor, { runId: august.runId, expectedNetIqd: detail.totals.netIqd, expectedItems: detail.items.length }, augustEnd))).toBe("run_self_approval");
    // someone who took no part approves it; once August is paid, the raise is behind them and September is free
    await approveRun(t.db, people.owner.actor, { runId: august.runId, expectedNetIqd: detail.totals.netIqd, expectedItems: detail.items.length }, augustEnd + HOUR);
    await payRun(t.db, people.owner2.actor, { runId: august.runId, paidFrom: "cash" }, augustEnd + 2 * HOUR);
    const septemberEnd = Date.UTC(2026, 8, 30, 9, 0, 0);
    const september = await prepareRun(t.db, people.finance.actor, { period: periodOf(septemberEnd), demo: true, idempotencyKey: key() }, septemberEnd);
    const next = await getRun(t.db, changer.actor, september.runId, septemberEnd);
    await approveRun(t.db, changer.actor, { runId: september.runId, expectedNetIqd: next.totals.netIqd, expectedItems: next.items.length }, septemberEnd);
  });

  test("branch limits: an employee limited to a branch neither reads nor changes the staff of another branch, nor the store-wide payroll", async () => {
    const here = await branch();
    const away = await branch();
    const local = await person(["staff.employee.read"], { branchId: here });
    const remote = await person(["staff.employee.read"], { branchId: away });
    const manager = await person("manager", { branchId: here });

    // reads: the directory, a file, the attendance and leave lists, the roster
    const directory = await listEmployees(t.db, manager.actor, parseEmployeeFilters(new URLSearchParams("q=custom")), "ar");
    expect(directory.rows.map((row) => row.id)).toContain(local.id);
    expect(directory.rows.map((row) => row.id)).not.toContain(remote.id);
    expect(await code(() => getEmployeeProfile(t.db, manager.actor, remote.id, "ar", NOW))).toBe("forbidden");
    expect((await getEmployeeProfile(t.db, manager.actor, local.id, "ar", NOW)).employee.id).toBe(local.id);

    // writes on someone of the other branch: refused; on someone of one's own branch: allowed
    expect(await code(() => createShift(t.db, manager.actor, { employeeId: remote.id, day: TOMORROW, start: "09:00", end: "17:00" }, NOW))).toBe("forbidden");
    await createShift(t.db, manager.actor, { employeeId: local.id, day: TOMORROW, start: "09:00", end: "17:00" }, NOW);
    await createShift(t.db, people.owner.actor, { employeeId: remote.id, day: TOMORROW, start: "09:00", end: "17:00" }, NOW);
    const roster = await listRoster(t.db, manager.actor, { week: weekStartOf(TOMORROW), employee: null }, "ar", NOW);
    expect(roster.rows.map((row) => row.employee.id)).toContain(local.id);
    expect(roster.rows.map((row) => row.employee.id)).not.toContain(remote.id);
    expect(roster.employees.map((row) => row.id)).not.toContain(remote.id);
    expect(await code(() => recordAttendance(t.db, manager.actor, { employeeId: remote.id, day: addDays(TODAY, -1), start: "09:00", end: "17:00", reason: "نسي البصمة" }, NOW))).toBe("forbidden");
    await recordAttendance(t.db, people.owner.actor, { employeeId: remote.id, day: addDays(TODAY, -1), start: "09:00", end: "17:00", reason: "نسي البصمة" }, NOW);
    const attendancePage = await listAttendance(t.db, manager.actor, { from: addDays(TODAY, -1), to: TODAY, employee: null, state: "all", page: 1 }, "ar");
    expect(attendancePage.rows.map((row) => row.employee.id)).not.toContain(remote.id);
    const leave = await requestLeave(t.db, remote.actor, { kind: "annual", startsOn: addDays(TODAY, 30), endsOn: addDays(TODAY, 30) }, NOW);
    expect(await code(() => decideLeave(t.db, manager.actor, { leaveId: leave.leaveId, decision: "approve" }, NOW))).toBe("forbidden");
    expect((await listLeave(t.db, manager.actor, { status: null, employee: null, page: 1 }, NOW)).rows.map((row) => row.employee.id)).not.toContain(remote.id);
    expect(await code(() => createTask(t.db, manager.actor, { title: "رتّب رف الفرع", assigneeId: remote.id }, NOW))).toBe("forbidden");

    // pay: a finance clerk limited to the branch
    const clerk = await person("finance", { branchId: here });
    expect(await code(() => setBaseSalary(t.db, clerk.actor, { employeeId: remote.id, baseSalaryIqd: 700_000, expectedIqd: null, reason: "راتب" }, NOW))).toBe("forbidden");
    expect(await code(() => requestAdvance(t.db, clerk.actor, { employeeId: remote.id, amountIqd: 50_000, paidFrom: "cash", reason: "سلفة", idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await code(() => prepareRun(t.db, clerk.actor, { period: periodOf(NOW), demo: true, idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await code(() => listRuns(t.db, clerk.actor, { status: null, page: 1 }))).toBe("forbidden");
    const asked = await requestAdvance(t.db, people.finance.actor, { employeeId: remote.id, amountIqd: 40_000, paidFrom: "cash", reason: "سلفة", idempotencyKey: key() }, NOW);
    expect((await listAdvances(t.db, clerk.actor, { status: null, employee: null, page: 1 })).rows.map((row) => row.id)).not.toContain(asked.approvalId);
    const limitedApprover = await person("owner", { branchId: here });
    expect(await code(() => decideAdvance(t.db, limitedApprover.actor, { approvalId: asked.approvalId, decision: "approve" }, NOW))).toBe("forbidden");

    // HR limited to the branch: never the profile or the access of someone of another branch (or of the whole store)
    const hr = await person(["staff.manage", "staff.employee.read"], { branchId: here });
    const remoteFacts = await getEmployeeProfile(t.db, people.owner.actor, remote.id, "ar", NOW);
    expect(await code(() => updateEmployeeProfile(t.db, hr.actor, { employeeId: remote.id, jobTitle: "x", reason: "تحديث", expectedUpdatedAt: remoteFacts.employee.updatedAt }, NOW))).toBe("forbidden");
    expect(await code(() => terminateEmployee(t.db, hr.actor, { employeeId: remote.id, reason: "انتهاء العقد" }, NOW))).toBe("forbidden");
    const status = await t.db.select({ status: employees.status }).from(employees).where(eq(employees.id, remote.id)).get();
    expect(status?.status).toBe("active");
  });

  test("an unknown decision posted to a route is refused, never read as approval", async () => {
    const worker = await person("manager");
    const leave = await requestLeave(t.db, worker.actor, { kind: "unpaid", startsOn: addDays(TODAY, 40), endsOn: addDays(TODAY, 41) }, NOW);
    const ownerCookie = await signedIn(people.owner);
    const leaveResult = await post(ownerCookie, "/admin/staff/leave", { intent: "decide", leaveId: leave.leaveId, decision: "maybe" }, leaveAction as never);
    expect(statusOf(leaveResult)).toBe(400);
    const row = await t.db.select({ status: leaveRequests.status }).from(leaveRequests).where(eq(leaveRequests.id, leave.leaveId)).get();
    expect(row?.status).toBe("pending");

    const asked = await requestAdvance(t.db, people.finance.actor, { employeeId: worker.id, amountIqd: 25_000, paidFrom: "cash", reason: "سلفة طارئة", idempotencyKey: key() }, NOW);
    const advanceResult = await post(ownerCookie, "/admin/staff/payroll/advances", { intent: "decide", approvalId: asked.approvalId, decision: "" }, advancesAction as never);
    expect(statusOf(advanceResult)).toBe(400);
    const request = await t.db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, asked.approvalId)).get();
    expect(request?.status).toBe("pending");

    const shiftId = newId("shf");
    await t.db.insert(shifts).values({ id: shiftId, employeeId: worker.id, startsAt: NOW - 3 * HOUR, endsAt: NOW + 5 * HOUR, status: "scheduled", createdAt: NOW - DAY });
    const markResult = await post(ownerCookie, "/admin/staff/schedule", { intent: "mark", shiftId, status: "worked-ish" }, scheduleAction as never);
    expect(statusOf(markResult)).toBe(400);
    const shift = await t.db.select({ status: shifts.status }).from(shifts).where(eq(shifts.id, shiftId)).get();
    expect(shift?.status).toBe("scheduled");
  });

  test("the front page counts only the advances this approver may decide", async () => {
    const worker = await person("manager");
    const before = { owner: (await staffOverview(t.db, people.owner.actor, NOW)).payroll?.advancesPending ?? -1, owner2: (await staffOverview(t.db, people.owner2.actor, NOW)).payroll?.advancesPending ?? -1 };
    // asked by the owner (they may not decide their own request), and one for the owner (they may not decide their own advance)
    await requestAdvance(t.db, people.owner.actor, { employeeId: worker.id, amountIqd: 30_000, paidFrom: "cash", reason: "سلفة", idempotencyKey: key() }, NOW);
    await requestAdvance(t.db, people.finance.actor, { employeeId: people.owner.id, amountIqd: 30_000, paidFrom: "cash", reason: "سلفة", idempotencyKey: key() }, NOW);
    expect((await staffOverview(t.db, people.owner.actor, NOW)).payroll?.advancesPending).toBe(before.owner);
    expect((await staffOverview(t.db, people.owner2.actor, NOW)).payroll?.advancesPending).toBe(before.owner2 + 2);
  });

  test("a profit plan is not superseded by someone who may not see profit", async () => {
    const plan = await saveRuleVersion(t.db, people.owner.actor, { name: "ربح الفريق", basis: "profit", rateBps: 500, scope: "everyone", reason: "خطة الربح" }, NOW);
    expect(await code(() => saveRuleVersion(t.db, people.clerk.actor, { planId: plan.planId, name: "مبيعات الفريق", basis: "sales", rateBps: 100, scope: "everyone", reason: "تبديل الخطة" }, NOW + 1000))).toBe("profit_basis_needs_permission");
  });

  test("approving leave cancels a shift planned a moment before the decision is written", async () => {
    const worker = await person("manager");
    const day = addDays(TODAY, 12);
    const leave = await requestLeave(t.db, worker.actor, { kind: "annual", startsOn: day, endsOn: day }, NOW);
    let shiftId = "";
    const raced = beforeBatch(t.db, 1, async () => {
      shiftId = (await createShift(t.db, people.manager.actor, { employeeId: worker.id, day, start: "09:00", end: "17:00" }, NOW)).shiftId;
    });
    const decided = await decideLeave(raced, people.owner.actor, { leaveId: leave.leaveId, decision: "approve" }, NOW);
    const shift = await t.db.select({ status: shifts.status }).from(shifts).where(eq(shifts.id, shiftId)).get();
    expect(shift?.status).toBe("cancelled");
    expect(decided.shiftsCancelled).toBe(1);
  });

  test("a month or a day typed with Arabic-Indic or Persian digits (a browser without a month picker) is read, not dropped", () => {
    expect(parsePeriod(new URLSearchParams("period=٢٠٢٦-١٠"), NOW)).toBe("2026-10");
    expect(parsePeriod(new URLSearchParams("period=۲۰۲۶-۰۹"), NOW)).toBe("2026-09");
    const filters = parseAttendanceFilters(new URLSearchParams("from=٢٠٢٦-١١-٠١&to=٢٠٢٦-١١-٠٣"), NOW);
    expect([filters.from, filters.to]).toEqual(["2026-11-01", "2026-11-03"]);
    expect(parseRosterFilters(new URLSearchParams("week=٢٠٢٦-١١-١٩"), NOW).week).toBe(weekStartOf("2026-11-19"));
  });

  test("nobody marks their own shift worked; whoever recorded leave for someone does not approve it", async () => {
    const shiftId = newId("shf");
    await t.db.insert(shifts).values({ id: shiftId, employeeId: people.manager.id, startsAt: NOW - 2 * HOUR, endsAt: NOW + 6 * HOUR, status: "scheduled", createdAt: NOW - DAY });
    expect(await code(() => markShift(t.db, people.manager.actor, { shiftId, status: "completed" }, NOW))).toBe("attendance_self_approval");

    const worker = await person("manager");
    const day = addDays(TODAY, 50);
    const recorded = await requestLeave(t.db, people.manager.actor, { employeeId: worker.id, kind: "unpaid", startsOn: day, endsOn: day }, NOW);
    expect(await code(() => decideLeave(t.db, people.manager.actor, { leaveId: recorded.leaveId, decision: "approve" }, NOW))).toBe("leave_self_decision");
    const page = await listLeave(t.db, people.manager.actor, { status: "pending", employee: worker.id, page: 1 }, NOW);
    expect(page.rows.find((row) => row.id === recorded.leaveId)?.canDecide).toBe(false);
    expect((await staffDecisions(t.db, people.manager.actor)).some((row) => row.id === recorded.leaveId)).toBe(false);
    await decideLeave(t.db, people.owner.actor, { leaveId: recorded.leaveId, decision: "approve" }, NOW);
  });
});
