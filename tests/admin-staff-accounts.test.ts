/**
 * Admin module 15 "staff" — staff accounts from the admin (QA fix 2026-11-12). The auth core's createEmployee,
 * issuePasswordLink and enableEmployee existed only as services: no screen called them, so the owner could not add a
 * member of staff (a QA script had to call createEmployee). Each test failed before the screens:
 *
 *   · /admin/staff/employees offers «add an employee» to staff.manage only, with the roles this person may give (each
 *     marked) and the branches — a branch-limited person hires for their own branch only
 *   · posting it creates the account (no password, its roles, demo in a demo store) and answers the one-time password
 *     link ONCE, as a full address on this store; the token reaches no audit row
 *   · the hierarchy rule and the form's mistakes come back as sentences on their fields (a role the person does not
 *     hold, an email taken, a phone that is not one), and a person without staff.manage is refused
 *   · an employee's file offers a new link for an active account and re-enabling a closed one (with a new link), only
 *     to who may (never one's own account, never a stronger one); the older link stops working
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { action as employeeAction, loader as employeeLoader } from "~/routes/admin/staff/employee";
import { action as employeesAction, loader as employeesLoader } from "~/routes/admin/staff/employees";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { checkPasswordLink } from "~/server/auth/employees.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { auditEvents, employeeRoles, employees, rolePermissions, roles } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { terminateEmployee } from "~/server/services/admin/staff/employees.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "http://localhost:5173";
const PASSWORD = "staff-accounts-password-1";

let t: TestDb;
let make: Fixtures;
type Person = { id: string; email: string; actor: EmployeeActor };
const people: Record<string, Person> = {};
const cookies: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  people.owner = await person("owner");
  people.manager = await person("manager");
  // human resources: may manage staff and holds every permission of the cashier role, nothing of the owner's
  people.hr = await person(["staff.manage", "staff.employee.read", ...defaultRolePermissions("cashier")]);
  // reads the directory only
  people.reader = await person(["staff.employee.read"]);
  for (const name of ["owner", "manager", "hr", "reader"]) cookies[name] = await signedIn(people[name]);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[]): Promise<Person> {
  const hashed = await hashPassword(PASSWORD, 1000);
  const email = `${make.next("accounts")}@staff-accounts.test`;
  const id = await make.employee({ email, name: Array.isArray(role) ? "custom" : role, passwordHash: hashed.hash, passwordIters: hashed.iterations, createdAt: NOW - 400 * DAY });
  if (Array.isArray(role)) {
    const custom = `role_${make.next("custom").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    await t.db.insert(rolePermissions).values([...new Set(role)].map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, email, actor: { kind: "employee", id, permissions: new Set<string>(role), label: "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, actor: { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: role } };
}

// ───────────────────────────────────────────────────────────────── routes, signed in through the real middleware

function requestCtx(setCookies: string[]): RequestCtx {
  return {
    requestId: `staff-accounts-${randomToken(6)}`,
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
  return setCookies.map((line) => line.split("; ")[0]).find((value) => value.startsWith("tt_adm=") && value.length > 10) ?? "";
}

async function call(cookie: string, path: string, fn: (args: never) => unknown, params: Record<string, string>, body?: Record<string, string | string[]>): Promise<unknown> {
  let init: RequestInit = { headers: { cookie } };
  if (body) {
    const form = new FormData();
    for (const [name, value] of Object.entries(body)) for (const one of Array.isArray(value) ? value : [value]) form.append(name, one);
    init = { method: "POST", body: form, headers: { cookie, origin: ORIGIN } };
  }
  const request = new Request(`${ORIGIN}${path}`, init);
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params }, async () => {
      out = await fn({ request, context, params, url: new URL(request.url), pattern: path } as never);
      return new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}

const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);
/** The body of an action's answer, whether it came back plain or wrapped by data() with a status. */
const bodyOf = <T>(value: unknown): T => ((value as { data?: unknown; init?: unknown } | null)?.init !== undefined ? (value as { data: T }).data : (value as T));

type Hire = { roles: { id: string; key: string; name: string; assignable: boolean; twoStep: boolean }[]; branches: { id: string; name: string }[]; branch: { id: string; name: string } | null } | null;
type LinkAnswer = { ok: true; intent: string; message: string; employee?: { id: string; name: string }; link: { url: string; purpose: string; expiresAt: number } | null };
type Failure = { ok: false; code: string; message?: string; fields?: Record<string, string> };

const directory = (who: string) => call(cookies[who], "/admin/staff/employees", employeesLoader as never, {}) as Promise<{ hire: Hire }>;
const hire = (who: string, body: Record<string, string | string[]>) => call(cookies[who], "/admin/staff/employees", employeesAction as never, {}, { intent: "create", ...body });
const file = (who: string, employeeId: string) =>
  call(cookies[who], `/admin/staff/employees/${employeeId}`, employeeLoader as never, { employeeId }) as Promise<{ profile: { employee: { status: string; hasPassword: boolean }; can: { passwordLink: boolean; enable: boolean } } }>;
const onFile = (who: string, employeeId: string, body: Record<string, string>) => call(cookies[who], `/admin/staff/employees/${employeeId}`, employeeAction as never, { employeeId }, body);
const tokenOf = (url: string) => url.slice(url.indexOf("#") + 1);

describe("admin 15 staff — accounts from the admin", () => {
  test("the directory offers «add an employee» to staff.manage only, with the roles this person may give", async () => {
    const owner = (await directory("owner")).hire;
    expect(owner).not.toBeNull();
    expect(owner?.roles.find((role) => role.key === "owner")?.assignable).toBe(true);
    expect(owner?.roles.find((role) => role.key === "cashier")?.assignable).toBe(true);
    expect(owner?.branch).toBeNull();

    // human resources hold every cashier permission but not the owner's wildcard, nor all of a manager's
    const hr = (await directory("hr")).hire;
    expect(hr?.roles.find((role) => role.key === "cashier")?.assignable).toBe(true);
    expect(hr?.roles.find((role) => role.key === "owner")?.assignable).toBe(false);
    expect(hr?.roles.find((role) => role.key === "manager")?.assignable).toBe(false);

    // a reader of the directory, and a manager (no staff.manage), are offered nothing
    expect((await directory("reader")).hire).toBeNull();
    expect((await directory("manager")).hire).toBeNull();
  });

  test("adding an employee creates the account without a password and answers the one-time link once, on this store", async () => {
    const before = Date.now();
    const answer = bodyOf<LinkAnswer>(await hire("owner", { name: "  سارة الكاشير  ", email: " Sara.New@Staff-Accounts.Test ", phone: "0770 123 4567", jobTitle: "أمينة صندوق", roleId: [roleId("cashier")], branchId: "", reason: "تعيين جديد" }));
    expect(answer).toMatchObject({ ok: true, intent: "create", employee: { name: "سارة الكاشير" } });
    expect(answer.link?.url.startsWith(`${ORIGIN}/admin/welcome#`)).toBe(true);
    expect(answer.link?.purpose).toBe("welcome");
    expect(answer.link?.expiresAt).toBeGreaterThan(before);
    const token = tokenOf(answer.link!.url);
    expect(token.length).toBeGreaterThanOrEqual(32);

    const employeeId = answer.employee!.id;
    const row = await t.db.select().from(employees).where(eq(employees.id, employeeId)).get();
    expect(row).toMatchObject({ email: "sara.new@staff-accounts.test", name: "سارة الكاشير", phone: "0770 123 4567", jobTitle: "أمينة صندوق", status: "active", passwordHash: null, branchId: null, isDemo: true });
    const given = await t.db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(eq(employeeRoles.employeeId, employeeId));
    expect(given.map((one) => one.roleId)).toEqual([roleId("cashier")]);
    // the link is the one the welcome page takes; the token itself reaches no audit row
    expect(await checkPasswordLink(t.db, token, Date.now())).toMatchObject({ name: "سارة الكاشير", email: "sara.new@staff-accounts.test", purpose: "welcome" });
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, employeeId), eq(auditEvents.action, "staff.employee.create"))).all();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(token);

    // the new employee's file: no password yet, a new link may be made, nothing to re-enable
    const opened = await file("owner", employeeId);
    expect(opened.profile.employee.hasPassword).toBe(false);
    expect(opened.profile.can).toMatchObject({ passwordLink: true, enable: false });
  });

  test("the hierarchy rule and the form's mistakes come back as sentences on their fields; no staff.manage, no account", async () => {
    // a role granting a permission human resources do not hold
    const above = await hire("hr", { name: "مدير جديد", email: "boss@staff-accounts.test", roleId: [roleId("manager")], reason: "تعيين جديد" });
    expect(statusOf(above)).toBe(403);
    expect(bodyOf<Failure>(above)).toMatchObject({ ok: false, code: "grant_exceeds_own", fields: { roleIds: expect.stringContaining("صلاحية لا تملكها") } });
    // a role they hold all of: accepted
    const cashier = bodyOf<LinkAnswer>(await hire("hr", { name: "كاشير جديد", email: "till@staff-accounts.test", roleId: [roleId("cashier")], reason: "تعيين جديد" }));
    expect(cashier.ok).toBe(true);
    // the same email again (another case, spaces): taken, on the email field
    const twice = await hire("owner", { name: "كاشير آخر", email: " TILL@staff-accounts.test", roleId: [roleId("cashier")], reason: "تعيين جديد" });
    expect(statusOf(twice)).toBe(409);
    expect(bodyOf<Failure>(twice).fields?.email).toContain("البريد");
    // the form's mistakes, every field at once: the phone follows the HR facts' rule
    const wrong = await hire("owner", { name: "س", email: "not-an-email", phone: "اتصل بي", roleId: [], reason: "" });
    expect(statusOf(wrong)).toBe(400);
    expect(Object.keys(bodyOf<Failure>(wrong).fields ?? {}).sort()).toEqual(["email", "name", "phone", "reason", "roleIds"]);
    expect(bodyOf<Failure>(wrong).fields?.phone).toContain("موبايل");
    // whoever may not manage staff
    const refused = await hire("reader", { name: "موظف", email: "nope@staff-accounts.test", roleId: [roleId("cashier")], reason: "تعيين جديد" });
    expect(statusOf(refused)).toBe(403);
    expect(await t.db.select({ id: employees.id }).from(employees).where(eq(employees.email, "nope@staff-accounts.test")).get()).toBeUndefined();
  });

  test("an employee's file: a new link for an active account, re-enabling a closed one — only for who may", async () => {
    const created = bodyOf<LinkAnswer>(await hire("owner", { name: "عامل مستودع", email: "store.hand@staff-accounts.test", roleId: [roleId("cashier")], reason: "تعيين جديد" }));
    const employeeId = created.employee!.id;
    const first = tokenOf(created.link!.url);

    // never one's own account; never a stronger one (a manager has no staff.manage at all; HR does not hold the owner's)
    expect((await file("owner", people.owner.id)).profile.can).toMatchObject({ passwordLink: false, enable: false });
    expect((await file("hr", people.owner.id)).profile.can).toMatchObject({ passwordLink: false, enable: false });
    expect(statusOf(await onFile("hr", people.owner.id, { intent: "password-link", reason: "نسي كلمة المرور" }))).toBe(403);

    // a new link: the older one stops working
    const renewed = bodyOf<LinkAnswer>(await onFile("hr", employeeId, { intent: "password-link", reason: "ضاع الرابط الأول" }));
    expect(renewed).toMatchObject({ ok: true, intent: "password-link", link: { purpose: "welcome" } });
    expect(renewed.link?.url.startsWith(`${ORIGIN}/admin/welcome#`)).toBe(true);
    expect(await checkPasswordLink(t.db, first, Date.now())).toBeNull();
    expect(await checkPasswordLink(t.db, tokenOf(renewed.link!.url), Date.now())).not.toBeNull();

    // the account closed: re-enabling is offered (a new link is not), and answers a fresh link when asked for one
    await terminateEmployee(t.db, people.owner.actor, { employeeId, reason: "انتهاء العقد" }, Date.now());
    expect((await file("hr", employeeId)).profile.can).toMatchObject({ passwordLink: false, enable: true });
    expect(statusOf(await onFile("hr", employeeId, { intent: "password-link", reason: "رابط لحساب موقوف" }))).toBe(409);
    const enabled = bodyOf<LinkAnswer>(await onFile("hr", employeeId, { intent: "enable", reason: "عاد إلى العمل", newLink: "on" }));
    expect(enabled).toMatchObject({ ok: true, intent: "enable", link: { purpose: "welcome" } });
    expect((await t.db.select({ status: employees.status }).from(employees).where(eq(employees.id, employeeId)).get())?.status).toBe("active");
    expect(await checkPasswordLink(t.db, tokenOf(enabled.link!.url), Date.now())).toMatchObject({ name: "عامل مستودع" });
    // twice: already active, a sentence
    const again = await onFile("hr", employeeId, { intent: "enable", reason: "مرة ثانية" });
    expect(statusOf(again)).toBe(409);
    expect(bodyOf<Failure>(again).message).toEqual(expect.any(String));

    // re-enabled without asking for a link: no link is answered
    await terminateEmployee(t.db, people.owner.actor, { employeeId, reason: "انتهاء العقد مرة أخرى" }, Date.now());
    const plain = bodyOf<LinkAnswer>(await onFile("owner", employeeId, { intent: "enable", reason: "عاد إلى العمل" }));
    expect(plain).toMatchObject({ ok: true, intent: "enable", link: null });
  });
});
