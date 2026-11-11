/**
 * Admin module 20 "security" — the adversarial review (2026-11-11). Each test is an attack that the first build let
 * through:
 *
 *   · the sign-in alerts sent a FULL phone number in every alert's row key (`identifier_failures:+9647…`, `lockout:+964…`)
 *     to employees without customer.phone.read_full — in the loader's JSON, while the cell showed it masked
 *   · an employee holding security.mfa.manage but not everything the target holds (an "IT" role) could remove the
 *     OWNER's second factor — with a known password, that is the owner's account
 *   · a non-owner with staff.manage could take the owner role away from an owner (while another owner remained), and
 *     strip a role of permissions they could never have granted; and put a branch limit on an owner
 *   · an access review "confirmed" the members of a role although someone was added after the reviewer looked
 *
 * And one guard (not an attack: it passed before): the retention page wrote two purge periods as numbers of its own
 * instead of their owners' constants — now it reads them, and the test keeps them equal.
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { loader as signinsLoader } from "~/routes/admin/security/sign-ins";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { authEvents, branches, employeeRoles, employees, rolePermissions, roles } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { UNUSED_TOPUP_PROOF_MAX_AGE_SEC } from "~/server/services/account/topups.server";
import { performAccessReview, retentionView } from "~/server/services/admin/security/retention.server";
import { getRole, saveRolePermissions, setEmployeeBranch, setEmployeeRoles } from "~/server/services/admin/security/roles.server";
import { signinOverview } from "~/server/services/admin/security/signins.server";
import { getStaffSecurity, resetStaffTwoStep } from "~/server/services/admin/security/staff.server";
import { SECURITY_ERROR_KEYS } from "~/server/services/admin/security/types";
import { TRADE_IN_DRAFT_MAX_AGE_SEC } from "~/server/services/tradein.server";
import securityMessages from "~/i18n/messages/admin-security";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const ORIGIN = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor; email: string; password: string };
let roleSeq = 0;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], name?: string): Promise<Person> {
  const password = "security-review-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("secrev")}@security.test`;
  const id = await make.employee({ email, name: name ?? (Array.isArray(role) ? "custom" : role), passwordHash: hashed.hash, passwordIters: hashed.iterations });
  if (Array.isArray(role)) {
    const custom = `role_secrev_${++roleSeq}`;
    await t.db.insert(roles).values({ id: custom, key: `secrev_${roleSeq}`, name: { ar: "دور مراجعة", en: "Review role" }, isSystem: false, createdAt: NOW });
    if (role.length) await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, email, password, actor: { kind: "employee", id, permissions: new Set<string>(role), label: name ?? "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password, actor: { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: name ?? role } };
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const failure = async (run: () => Promise<unknown>) => toAppError(await thrown(run));
const code = async (run: () => Promise<unknown>) => (await failure(run))?.code ?? "unexpected";
const rolesOf = async (employeeId: string) => (await t.db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(eq(employeeRoles.employeeId, employeeId))).map((row) => row.roleId).sort();

// ───────────────────────────────────────────────────────────────── routes (signed in through the real auth service)

function requestCtx(): RequestCtx {
  return {
    requestId: `secrev-${randomToken(6)}`,
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

describe("20.08 a phone typed at a sign-in never reaches someone without customer.phone.read_full", () => {
  test("not in an alert's text, and not in its row key either — the service's result and the page's JSON", async () => {
    // a phone that is in no other row of this database, so finding its digits anywhere is the leak
    const phone = "+9647809876543";
    const national = "07809876543";
    const at = (offset: number) => Date.now() - offset;
    await t.db.insert(authEvents).values([
      ...Array.from({ length: 6 }, (_, index) => ({ id: newId("aev"), subjectKind: "customer" as const, subjectId: null, identifier: phone, kind: "login", success: false, ip: "198.51.100.77", userAgent: null, details: { reason: "bad_password" }, at: at(index * 60_000 + 5_000) })),
      { id: newId("aev"), subjectKind: "customer" as const, subjectId: null, identifier: phone, kind: "lockout", success: false, ip: "198.51.100.77", userAgent: null, details: { windowSec: 900 }, at: at(1_000) },
    ]);
    const reviewer = await person(["dashboard.overview.read", "security.auth_event.read"], "alerts-reviewer");
    const overview = await signinOverview(t.db, reviewer.actor, "24h", Date.now());
    const mine = overview.alerts.filter((alert) => alert.rule === "identifier_failures" || alert.rule === "lockout");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((alert) => alert.identifierMasked)).toBe(true);
    const leaks = (value: unknown) => JSON.stringify(value).includes(phone.slice(4)) || JSON.stringify(value).includes(national);
    expect(leaks(overview)).toBe(false);
    // row keys stay unique, so the list renders one row per alert
    expect(new Set(overview.alerts.map((alert) => alert.key)).size).toBe(overview.alerts.length);

    const page = await run(await signedIn(reviewer), "/admin/security/sign-ins?window=24h", signinsLoader as never);
    expect((page as { overview?: unknown }).overview).toBeDefined();
    expect(leaks(page)).toBe(false);

    // who may see full numbers still sees them
    const owner = await person("owner", "alerts-owner");
    expect(JSON.stringify(await signinOverview(t.db, owner.actor, "24h", Date.now()))).toContain(phone);
  });
});

describe("20.01 two-step verification is never removed from an account that holds more than the person removing it", () => {
  test("an IT role with security.mfa.manage resets a cashier's, never an owner's; the owner resets anyone's", async () => {
    const it = await person(["dashboard.overview.read", "security.session.read", "security.mfa.manage"], "it-support");
    const owner = await person("owner", "mfa-owner");
    const otherOwner = await person("owner", "mfa-owner-2");
    const cashier = await person("cashier", "mfa-cashier");
    const manager = await person("manager", "mfa-manager");
    for (const who of [otherOwner, cashier, manager]) await t.db.update(employees).set({ totpEnabled: true, totpSecretEnc: "v1.x.y", recoveryCodes: ["h"] }).where(eq(employees.id, who.id));

    expect(await code(() => resetStaffTwoStep(t.db, it.actor, { employeeId: otherOwner.id, reason: "فقد هاتفه" }, NOW))).toBe("target_more_privileged");
    // the manager holds permissions the IT role does not: same answer
    expect(await code(() => resetStaffTwoStep(t.db, it.actor, { employeeId: manager.id, reason: "فقد هاتفه" }, NOW))).toBe("target_more_privileged");
    expect((await t.db.select({ on: employees.totpEnabled }).from(employees).where(eq(employees.id, otherOwner.id)).get())?.on).toBe(true);
    // the page does not offer it either
    expect((await getStaffSecurity(t.db, it.actor, otherOwner.id, "ar", NOW)).can.resetTwoStep).toBe(false);

    // someone who holds nothing beyond the IT role may be reset by it; a cashier holds point-of-sale permissions it lacks
    const narrow = await person(["dashboard.overview.read", "security.session.read"], "narrow");
    await t.db.update(employees).set({ totpEnabled: true, totpSecretEnc: "v1.x.y", recoveryCodes: ["h"] }).where(eq(employees.id, narrow.id));
    expect((await getStaffSecurity(t.db, it.actor, narrow.id, "ar", NOW)).can.resetTwoStep).toBe(true);
    expect(await resetStaffTwoStep(t.db, it.actor, { employeeId: narrow.id, reason: "فقد هاتفه" }, NOW)).toEqual({ reset: true });
    expect(await code(() => resetStaffTwoStep(t.db, it.actor, { employeeId: cashier.id, reason: "فقد هاتفه" }, NOW))).toBe("target_more_privileged");

    // the owner (everything) may reset anyone else's
    expect(await resetStaffTwoStep(t.db, owner.actor, { employeeId: otherOwner.id, reason: "فقد هاتفه" }, NOW)).toEqual({ reset: true });
  });
});

describe("20.02 nobody takes away what they could not give", () => {
  test("a non-owner role manager cannot take the owner role from an owner, even with another owner left", async () => {
    const hr = await person(["dashboard.overview.read", "staff.manage", "security.session.read", "orders.order.read"], "hr");
    const ownerA = await person("owner", "owner-a");
    const ownerB = await person("owner", "owner-b");
    expect(await code(() => setEmployeeRoles(t.db, hr.actor, { employeeId: ownerB.id, roleIds: [], expected: roleId("owner"), reason: "إزالة" }, NOW))).toBe("revoke_exceeds_own");
    expect(await rolesOf(ownerB.id)).toEqual([roleId("owner")]);
    // the same for a role with permissions the remover never held (finance)
    const clerk = await person("finance", "finance-clerk");
    expect(await code(() => setEmployeeRoles(t.db, hr.actor, { employeeId: clerk.id, roleIds: [], expected: roleId("finance"), reason: "إزالة" }, NOW))).toBe("revoke_exceeds_own");
    // a role within the remover's own permissions can be taken away
    const helper = await person(["dashboard.overview.read", "orders.order.read"], "orders-helper");
    const helperRoles = await rolesOf(helper.id);
    expect((await setEmployeeRoles(t.db, hr.actor, { employeeId: helper.id, roleIds: [], expected: helperRoles.join(","), reason: "انتهى العمل" }, NOW)).removed).toEqual(helperRoles);
    // an owner may take it from another owner (another active owner remains)
    expect((await setEmployeeRoles(t.db, ownerA.actor, { employeeId: ownerB.id, roleIds: [roleId("manager")], expected: roleId("owner"), reason: "يبقى مديراً" }, NOW)).removed).toEqual([roleId("owner")]);
    // the employee page offers only the roles this person may give and take
    const detail = await getStaffSecurity(t.db, hr.actor, clerk.id, "ar", NOW);
    expect(detail.allRoles?.find((role) => role.id === roleId("finance"))?.assignable).toBe(false);
    expect(detail.allRoles?.find((role) => role.id === roleId("owner"))?.assignable).toBe(false);
  });

  test("a role editor removes only permissions they hold themselves", async () => {
    const hr = await person(["dashboard.overview.read", "staff.manage", "security.session.read", "orders.order.read"], "hr-editor");
    const finance = await getRole(t.db, hr.actor, roleId("finance"), "ar");
    const without = finance.stored.filter((permission) => permission !== "finance.period.close");
    expect(without.length).toBe(finance.stored.length - 1);
    expect(await code(() => saveRolePermissions(t.db, hr.actor, { roleId: roleId("finance"), permissions: without, fingerprint: finance.fingerprint, reason: "إزالة صلاحية" }, NOW))).toBe("revoke_exceeds_own");
    expect((await getRole(t.db, hr.actor, roleId("finance"), "ar")).stored).toContain("finance.period.close");
    // within their own permissions, both ways
    const cashier = await getRole(t.db, hr.actor, roleId("cashier"), "ar");
    const added = await saveRolePermissions(t.db, hr.actor, { roleId: roleId("cashier"), permissions: [...cashier.stored, "orders.order.read"], fingerprint: cashier.fingerprint, reason: "يرى الطلبات" }, NOW);
    expect(added.added).toEqual(["orders.order.read"]);
    const after = await getRole(t.db, hr.actor, roleId("cashier"), "ar");
    const removed = await saveRolePermissions(t.db, hr.actor, { roleId: roleId("cashier"), permissions: after.stored.filter((permission) => permission !== "orders.order.read"), fingerprint: after.fingerprint, reason: "عودة" }, NOW);
    expect(removed.removed).toEqual(["orders.order.read"]);
  });

  test("a branch limit is never put on someone who holds more than the person setting it", async () => {
    const branchId = `br_${randomToken(6)}`;
    await t.db.insert(branches).values({ id: branchId, code: `B-${randomToken(4)}`, name: { ar: "فرع الاختبار", en: "Test branch" }, isActive: true, createdAt: NOW });
    const hr = await person(["dashboard.overview.read", "staff.manage", "security.session.read", "orders.order.read"], "hr-branch");
    const owner = await person("owner", "branch-owner");
    const otherOwner = await person("owner", "branch-owner-2");
    expect(await code(() => setEmployeeBranch(t.db, hr.actor, { employeeId: otherOwner.id, branchId, reason: "فرع واحد" }, NOW))).toBe("target_more_privileged");
    expect((await t.db.select({ branchId: employees.branchId }).from(employees).where(eq(employees.id, otherOwner.id)).get())?.branchId ?? null).toBeNull();
    const helper = await person(["dashboard.overview.read", "orders.order.read"], "branch-helper");
    expect(await setEmployeeBranch(t.db, hr.actor, { employeeId: helper.id, branchId, reason: "يعمل في الفرع" }, NOW)).toEqual({ changed: true });
    expect(await setEmployeeBranch(t.db, owner.actor, { employeeId: otherOwner.id, branchId, reason: "يدير الفرع" }, NOW)).toEqual({ changed: true });
  });

  test("the new refusals have their texts in every language", () => {
    const errorsOf = (locale: string) => ((securityMessages as unknown as Record<string, { errors?: Record<string, unknown> }>)[locale]?.errors ?? {}) as Record<string, unknown>;
    for (const key of ["target_more_privileged", "revoke_exceeds_own"]) {
      expect(SECURITY_ERROR_KEYS as readonly string[]).toContain(key);
      for (const locale of ["ar", "en", "ckb"]) expect(errorsOf(locale)[key], `${locale} ${key}`).toEqual(expect.any(String));
    }
  });
});

describe("20.07 an access review is of what the reviewer saw — the permissions and the members", () => {
  test("a member added after the reviewer looked makes the review stale", async () => {
    const owner = await person("owner", "review-owner");
    const role = await getRole(t.db, owner.actor, roleId("content"), "ar");
    expect(role.membersFingerprint).toBe(role.members.map((member) => member.id).sort().join(","));
    const newcomer = await person("cashier", "newcomer");
    await t.db.insert(employeeRoles).values({ employeeId: newcomer.id, roleId: roleId("content") });
    expect(await code(() => performAccessReview(t.db, owner.actor, { roleId: roleId("content"), outcome: "confirmed", note: "كل شيء صحيح", fingerprint: role.fingerprint, members: role.membersFingerprint }, NOW))).toBe("role_changed");
    const fresh = await getRole(t.db, owner.actor, roleId("content"), "ar");
    expect(fresh.membersFingerprint).toContain(newcomer.id);
    const recorded = await performAccessReview(t.db, owner.actor, { roleId: roleId("content"), outcome: "confirmed", note: "كل شيء صحيح", fingerprint: fresh.fingerprint, members: fresh.membersFingerprint }, NOW);
    expect(recorded.id).toMatch(/^aud_/);
    // the members' fingerprint is required: a review that does not say what it saw is refused
    expect(await code(() => performAccessReview(t.db, owner.actor, { roleId: roleId("content"), outcome: "confirmed", note: "كل شيء صحيح", fingerprint: fresh.fingerprint }, NOW))).toBe("invalid");
    await t.db.delete(employeeRoles).where(and(eq(employeeRoles.employeeId, newcomer.id), eq(employeeRoles.roleId, roleId("content"))));
  });
});

describe("20.07 the retention page shows the periods the purges really use", () => {
  test("trade-in draft photos and unused top-up proofs: their owners' constants, in days", async () => {
    const owner = await person("owner", "retention-owner");
    const view = await retentionView(t.db, owner.actor);
    expect(view.rows.find((row) => row.key === "tradeInDrafts")?.days).toBe(TRADE_IN_DRAFT_MAX_AGE_SEC / 86_400);
    expect(view.rows.find((row) => row.key === "topupProofs")?.days).toBe(UNUSED_TOPUP_PROOF_MAX_AGE_SEC / 86_400);
  });
});
