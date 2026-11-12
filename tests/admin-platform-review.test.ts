/**
 * Adversarial review of the platform pass of admin wave D (2026-11-12, owner: admin shell / platform): each test is an
 * attack on the builder's code that failed before its fix —
 *
 *   · a disabled account's unused password-set link came back to life when the account was enabled again;
 *   · the server-error recorder stored a failed query's bound values (names, addresses, hashes) in the operations
 *     module's error log — Drizzle puts them in the message and the stack;
 *   · an error on a splat route was filed under its address, one row per URL, instead of under the route pattern;
 *   · a new employee for a branch that does not exist was a database conflict (409 foreign_key), not a field error;
 *   · the staff advances' count sat in the shell's own batch: a failing staff module still showed it (and a failing
 *     statement there would have taken the whole bell down with it);
 *   · the password-set page looked links up for anybody, as often as they liked.
 *
 * Runs against a real local D1 (tests/helpers/db.ts) with the built-in roles installed.
 */
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { handleError, routePatternOf } from "~/entry.server";
import { randomToken } from "~/lib/ids";
import { loadWaiting, type ShellWaiting } from "~/routes/admin/shell/queues.server";
import type { EmployeeActor } from "~/server/actor";
import { disableEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { checkPasswordLink, createEmployee, enableEmployee, setPasswordWithLink } from "~/server/auth/employees.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { hashPassword } from "~/server/crypto.server";
import { approvals, branches, employeePasswordLinks, employeeRoles, employees, errorReports, jobRuns, leaveRequests, rolePermissions, roles } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { runJob } from "~/server/jobs.server";
import { roleId } from "~/server/permissions";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

/** While on, the staff module's own count throws: all of the staff module's queues must go, and only those. */
const failing = vi.hoisted(() => ({ staff: false }));
/** What handleError handed to the Worker's waitUntil. */
const waited = vi.hoisted(() => ({ promises: [] as Promise<unknown>[] }));
vi.mock("~/server/services/admin/staff/approvals.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/staff/approvals.server")>();
  return {
    ...real,
    staffDecisions: async (...args: Parameters<typeof real.staffDecisions>) => {
      if (failing.staff) throw new Error("the staff counts are down (test)");
      return real.staffDecisions(...args);
    },
  };
});
vi.mock("cloudflare:workers", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, waitUntil: (promise: Promise<unknown>) => void waited.promises.push(promise) };
});

const NOW = TEST_NOW;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let t: TestDb;
let make: Fixtures;
beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

type Person = { id: string; email: string; roleId: string; actor: EmployeeActor & { permissions: ReadonlySet<string> } };

/** An employee holding exactly these permissions through a role of their own. */
async function employeeWith(permissions: readonly string[], options: { branchId?: string | null } = {}): Promise<Person> {
  const hashed = await hashPassword("review-password-1234", 1000);
  const email = `${make.next("rv")}@platform-review.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations, branchId: options.branchId ?? null, name: "موظف المراجعة" });
  const role = `rol_${make.next("rv").replace(/-/g, "_")}`;
  await t.db.insert(roles).values({ id: role, key: role, name: { ar: "دور للمراجعة", en: "Review role" }, createdAt: NOW });
  if (permissions.length) await t.db.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: role, permission })));
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: role });
  return { id, email, roleId: role, actor: { kind: "employee", id, permissions: new Set(permissions), branchId: options.branchId ?? null } };
}

/** The owner: a built-in role holding `*`. */
async function owner(): Promise<Person> {
  const person = await employeeWith([]);
  await t.db.delete(employeeRoles).where(eq(employeeRoles.employeeId, person.id));
  await t.db.insert(employeeRoles).values({ employeeId: person.id, roleId: roleId("owner") });
  return { ...person, actor: { ...person.actor, permissions: new Set(["*"]) } };
}

function sessionOf(person: Person): EmployeeSession {
  return {
    employee: { id: person.id, email: person.email, name: "موظف المراجعة", phone: null, jobTitle: null, locale: "ar", branchId: person.actor.branchId ?? null, totpEnabled: true, passwordChangedAt: null },
    actor: person.actor,
    roles: [],
    session: { id: "s", createdAt: NOW, expiresAt: NOW + HOUR, mfaOk: true },
  };
}

const queue = (waiting: ShellWaiting, id: string) => waiting.queues.find((entry) => entry.id === id) ?? null;

async function failure(run: () => unknown): Promise<{ code: string; status: number; fields?: Record<string, string> }> {
  try {
    await run();
  } catch (error) {
    const appError = toAppError(error);
    if (appError) return { code: appError.code, status: appError.status, ...(appError.fields ? { fields: appError.fields } : {}) };
    throw error;
  }
  throw new Error("Expected the call to fail");
}

// ───────────────────────────────────────────────────────────────── auth core

describe("staff accounts: the one-time password link and the account's state", () => {
  test("disabling an account ends its unused password link for good — enabling it again does not bring the link back", async () => {
    const boss = await owner();
    const created = await createEmployee(t.db, boss.actor, { email: `${make.next("hire")}@platform-review.test`, name: "موظف جديد", roleIds: [roleId("cashier")], reason: "تعيين جديد" }, NOW);
    // the link was handed to the wrong person: the manager closes the account at once
    await disableEmployee(t.db, boss.actor, { employeeId: created.employeeId, reason: "أُعطي الرابط لشخص آخر" }, NOW + MINUTE);
    const row = await t.db.select({ revokedAt: employeePasswordLinks.revokedAt }).from(employeePasswordLinks).where(eq(employeePasswordLinks.employeeId, created.employeeId)).get();
    expect(row?.revokedAt).toBe(NOW + MINUTE);

    // …and opens it again later (without asking for a new link): the old link must stay dead
    await enableEmployee(t.db, boss.actor, { employeeId: created.employeeId, reason: "الموظف حضر بنفسه" }, NOW + 2 * MINUTE);
    expect(await checkPasswordLink(t.db, created.link.token, NOW + 3 * MINUTE)).toBeNull();
    expect(await failure(() => setPasswordWithLink(t.db, { token: created.link.token, password: "someone-elses-password" }, NOW + 3 * MINUTE, { ip: "203.0.113.40", userAgent: null }))).toEqual({
      code: "password_link_invalid",
      status: 410,
    });
    expect((await t.db.select({ passwordHash: employees.passwordHash }).from(employees).where(eq(employees.id, created.employeeId)).get())?.passwordHash).toBeNull();
  });

  test("an account disabled before this rule still loses its old link when it is enabled again", async () => {
    const boss = await owner();
    const created = await createEmployee(t.db, boss.actor, { email: `${make.next("hire")}@platform-review.test`, name: "موظف قديم", roleIds: [roleId("cashier")], reason: "تعيين جديد" }, NOW);
    // a database written by the old code: disabled, its link never revoked
    await t.db.update(employees).set({ status: "disabled", disabledAt: NOW + MINUTE }).where(eq(employees.id, created.employeeId));
    const enabled = await enableEmployee(t.db, boss.actor, { employeeId: created.employeeId, reason: "عاد إلى العمل" }, NOW + 2 * MINUTE);
    expect(enabled.link).toBeNull();
    expect(await checkPasswordLink(t.db, created.link.token, NOW + 3 * MINUTE)).toBeNull();
    // asking for a new one in the same step gives a link that works
    await t.db.update(employees).set({ status: "disabled", disabledAt: NOW + 4 * MINUTE }).where(eq(employees.id, created.employeeId));
    const again = await enableEmployee(t.db, boss.actor, { employeeId: created.employeeId, reason: "عاد مرة أخرى", newPasswordLink: true }, NOW + 5 * MINUTE);
    expect(await checkPasswordLink(t.db, again.link!.token, NOW + 6 * MINUTE)).toMatchObject({ name: "موظف قديم", purpose: "welcome" });
  });

  test("a new employee for a branch that does not exist is a field error (400), not a database conflict", async () => {
    const boss = await owner();
    const email = `${make.next("hire")}@platform-review.test`;
    expect(await failure(() => createEmployee(t.db, boss.actor, { email, name: "موظف فرع", roleIds: [roleId("cashier")], branchId: "brn_does_not_exist", reason: "تعيين جديد" }, NOW))).toEqual({
      code: "invalid",
      status: 400,
      fields: { branchId: "invalid" },
    });
    expect(await t.db.select().from(employees).where(eq(employees.email, email))).toEqual([]);
    // a branch that exists is fine
    const branchId = `brn_${randomToken(6)}`;
    await t.db.insert(branches).values({ id: branchId, code: make.next("BR"), name: { ar: "فرع الكرادة" }, createdAt: NOW });
    const created = await createEmployee(t.db, boss.actor, { email, name: "موظف فرع", roleIds: [roleId("cashier")], branchId, reason: "تعيين جديد" }, NOW);
    expect((await t.db.select({ branchId: employees.branchId }).from(employees).where(eq(employees.id, created.employeeId)).get())?.branchId).toBe(branchId);
  });

  test("the password-set page's look-ups are limited per address (nobody signed in there)", async () => {
    const origin = { ip: "203.0.113.77", userAgent: null };
    for (let i = 0; i < 20; i++) expect(await checkPasswordLink(t.db, randomToken(), NOW, origin)).toBeNull();
    expect(await failure(() => checkPasswordLink(t.db, randomToken(), NOW, origin))).toMatchObject({ code: "rate_limited", status: 429 });
    // another address is not affected; the service's own callers (no origin) are not limited
    expect(await checkPasswordLink(t.db, randomToken(), NOW, { ip: "203.0.113.78", userAgent: null })).toBeNull();
    expect(await checkPasswordLink(t.db, randomToken(), NOW)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── the bell

describe("the bell: one module's failure", () => {
  test("a failing staff module shows none of its queues — the salary advances included — and every other queue stays", async () => {
    const approver = await employeeWith(["staff.leave.approve", "staff.payroll.approve", "staff.payroll.read", "cms.page.manage", "cms.page.publish"]);
    const colleague = await employeeWith(["staff.employee.read"]);
    await t.db.insert(leaveRequests).values({ id: `lvr_rv_${randomToken(6)}`, employeeId: colleague.id, kind: "annual", startsOn: "2026-11-20", endsOn: "2026-11-21", status: "pending", createdAt: NOW });
    await t.db.insert(approvals).values({ id: `apr_${randomToken(8)}`, kind: "staff_advance", entityType: "employee", entityId: colleague.id, requestedBy: colleague.id, payload: { amountIqd: 50_000 }, status: "pending", createdAt: NOW });
    const working = await loadWaiting(t.db, sessionOf(approver), NOW);
    expect(queue(working, "staff_leave")?.count).toBe(1);
    expect(queue(working, "staff_advances")?.count).toBe(1);

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failing.staff = true;
    try {
      const waiting = await loadWaiting(t.db, sessionOf(approver), NOW);
      expect(waiting.queues.filter((entry) => entry.module === "staff")).toEqual([]);
      expect(queue(waiting, "cms_policies")).not.toBeNull();
      expect(waiting.total).toBe(waiting.queues.reduce((sum, entry) => sum + entry.count, 0));
      expect(errors.mock.calls.some((call) => String(call[0]).includes("the staff queues failed"))).toBe(true);
    } finally {
      failing.staff = false;
      errors.mockRestore();
    }
  });
});

// ───────────────────────────────────────────────────────────────── jobs

describe("scheduled jobs of wave D: what a run keeps", () => {
  test("the commissions job keeps counts, never pay: its job_runs row (shown to ops.job.read) holds no amount", async () => {
    const run = await runJob(t.db, "staff.commissions.sync", NOW);
    expect(run.status).toBe("succeeded");
    const row = await t.db.select({ stats: jobRuns.stats }).from(jobRuns).where(eq(jobRuns.id, run.runId)).get();
    const keys: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object")
        for (const [key, value] of Object.entries(node)) {
          keys.push(key);
          walk(value);
        }
    };
    walk(row?.stats);
    // the operations module withholds only cost and profit keys: pay (staff.payroll.*) must not be there at all
    expect(keys.filter((key) => /iqd|amount|pay/i.test(key))).toEqual([]);
    // still says what happened, per month
    expect((row?.stats as { periods?: { period: string; lines: number }[] }).periods?.map((entry) => Object.keys(entry).sort())).toEqual([
      ["clawbacks", "earned", "lines", "noPlan", "period", "unchanged", "uncosted"],
      ["clawbacks", "earned", "lines", "noPlan", "period", "unchanged", "uncosted"],
    ]);
  });
});

// ───────────────────────────────────────────────────────────────── entry.server

describe("entry.server handleError: what reaches the operations module's error log", () => {
  test("a failed query is recorded without its bound values — not in the message, not in the stack", async () => {
    const email = `${make.next("dup")}@platform-review.test`;
    await make.employee({ email });
    let error: unknown;
    try {
      // a single statement (not a batch): Drizzle wraps the database's refusal as "Failed query: …\nparams: …"
      await t.db.insert(employees).values({ id: `emp_${randomToken(8)}`, email, name: "زينب الكرادية السرية", phone: "شارع أبي نواس، الدار 77", passwordHash: "pbkdf2$1000$c2FsdA$aGFzaA", createdAt: NOW });
    } catch (caught) {
      error = caught;
    }
    expect(String((error as Error).message)).toContain("params:");

    const route = `/admin/staff/employees/${make.next("emp")}`;
    const context = new RouterContextProvider();
    const errorsLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    waited.promises.length = 0;
    try {
      handleError(error, { request: new Request(`http://localhost:5173${route}`), params: {}, context });
      await Promise.all(waited.promises);
    } finally {
      errorsLog.mockRestore();
    }
    const row = await t.db.select().from(errorReports).where(eq(errorReports.url, route)).get();
    expect(row).toBeDefined();
    // still useful: what failed and why
    expect(row?.message).toContain("Failed query");
    expect(row?.message).toContain("employees");
    expect(row?.message).toContain("UNIQUE constraint failed");
    for (const secret of ["زينب الكرادية السرية", "أبي نواس", "pbkdf2$1000$c2FsdA$aGFzaA", "c2FsdA"]) {
      expect(row?.message ?? "", secret).not.toContain(secret);
      expect(row?.stack ?? "", secret).not.toContain(secret);
    }
  });

  test("an error on a splat route is filed under the route pattern, not under each address", () => {
    expect(routePatternOf("/admin/no/such/page", { "*": "no/such/page" })).toBe("/admin/*");
    expect(routePatternOf("/somewhere/else", { "*": "somewhere/else" })).toBe("/*");
    expect(routePatternOf("/en/old-page/2024", { locale: "en", "*": "old-page/2024" })).toBe("/:locale/*");
    // encoded segments count as one segment each
    expect(routePatternOf("/admin/%D8%B5%D9%81%D8%AD%D8%A9/x", { "*": "صفحة/x" })).toBe("/admin/*");
    // named parameters as before
    expect(routePatternOf("/admin/orders/TT-ABC123", { ref: "TT-ABC123" })).toBe("/admin/orders/:ref");
    expect(routePatternOf("/admin", {})).toBe("/admin");
  });
});
