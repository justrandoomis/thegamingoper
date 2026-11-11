/**
 * Admin module 20 "security" — services and routes against a real local D1:
 *
 *   · authorization per role (cashier, finance, manager, owner, custom roles) on every service
 *   · 20.01 other employees' sessions ended with a reason, two-step reset, never one's own account here
 *   · 20.02 roles: the owner's wildcard is locked, nobody grants what they do not hold or edits a role they hold, a
 *     stale editor is refused (also inside the batch), the last active owner keeps the role, every change audited
 *   · 20.03 the audit trail: filters, cost withheld / cut for employees without cost.read (also in the CSV), the chain
 *     sealed and verified (both recorded)
 *   · 20.04 DATA_KEY self-test and readable authenticator secrets — counts only, never a secret in the result
 *   · 20.05 restore tests recorded once per form (idempotent), never in the future, owner only
 *   · 20.06 every idempotency rule present in the schema
 *   · 20.07 an access review against what the reviewer saw
 *   · 20.08 sign-in alerts by rule with phone numbers masked without customer.phone.read_full; refund reviews with
 *     their signals, never by someone who asked for or approved the refund
 *   · route loaders: 403 for a role without the page's permission
 */
import { and, eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import { loader as protectionsLoader } from "~/routes/admin/security/protections";
import { loader as staffLoader } from "~/routes/admin/security/staff";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { encryptSecret, hashPassword } from "~/server/crypto.server";
import { auditEvents, authEvents, employeeRoles, employeeSessions, employees, orders, refunds, rolePermissions, roles } from "~/server/db/schema";
import { audit } from "~/server/audit.server";
import { toAppError } from "~/server/errors";
import { FIELD_PERMISSIONS, defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { exportAuditCsv, getAuditEvent, listAuditEvents, sealNow, verifyChain } from "~/server/services/admin/security/audit-log.server";
import { backupsView, recordRestoreTest } from "~/server/services/admin/security/backups.server";
import { duplicatesView, encryptionStatus } from "~/server/services/admin/security/protections.server";
import { listRefundReviews, reviewRefund } from "~/server/services/admin/security/refund-reviews.server";
import { performAccessReview, retentionView } from "~/server/services/admin/security/retention.server";
import { createRole, fingerprintOf, getRole, listRoles, saveRolePermissions, setEmployeeBranch, setEmployeeRoles } from "~/server/services/admin/security/roles.server";
import { listAuthEvents, signinOverview } from "~/server/services/admin/security/signins.server";
import { endAllStaffSessions, endStaffSession, getStaffSecurity, listStaffSecurity, resetStaffTwoStep } from "~/server/services/admin/security/staff.server";
import { FIELD_KEYS, SECURITY_ERROR_KEYS, parseAuditFilters, parseStaffFilters } from "~/server/services/admin/security/types";
import { SETTINGS_ERROR_KEYS } from "~/server/services/admin/settings/catalog";
import securityMessages from "~/i18n/messages/admin-security";
import settingsMessages from "~/i18n/messages/admin-settings";
import sharedErrors from "~/i18n/messages/errors";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const ORIGIN = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor; email: string; password: string };
const people: Record<string, Person> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "cashier", "support", "inventory"] as const) people[role] = await person(role);
  people.owner2 = await person("owner");
  people.manager2 = await person("manager");
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], name?: string): Promise<Person> {
  const password = "security-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("sec")}@security.test`;
  const id = await make.employee({ email, name: name ?? (Array.isArray(role) ? "custom" : role), passwordHash: hashed.hash, passwordIters: hashed.iterations });
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

async function session(employeeId: string, options: { mfaOk?: boolean; lastSeenAt?: number } = {}): Promise<string> {
  const idHash = await sha256Hex(randomToken());
  await t.db.insert(employeeSessions).values({ idHash, employeeId, mfaOk: options.mfaOk ?? true, createdAt: NOW - HOUR, lastSeenAt: options.lastSeenAt ?? NOW - 60_000, expiresAt: NOW + 11 * HOUR, ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Windows NT 10.0) Edg/130" });
  return idHash;
}

describe("authorization", () => {
  test("each service refuses a role without its permission (403 before reading the input)", async () => {
    const cashier = people.cashier.actor;
    const finance = people.finance.actor;
    expect(await code(() => listStaffSecurity(t.db, cashier, parseStaffFilters(new URLSearchParams()), "ar", NOW))).toBe("forbidden");
    expect(await code(() => listStaffSecurity(t.db, finance, parseStaffFilters(new URLSearchParams()), "ar", NOW))).toBe("forbidden");
    expect(await code(() => listAuditEvents(t.db, cashier, parseAuditFilters(new URLSearchParams())))).toBe("forbidden");
    expect(await code(() => signinOverview(t.db, finance, "7d", NOW))).toBe("forbidden");
    expect(await code(() => listRefundReviews(t.db, cashier, { view: "all", page: 1 }, NOW))).toBe("forbidden");
    expect(await code(() => encryptionStatus(t.db, finance, { DATA_KEY: TEST_VARS.DATA_KEY }))).toBe("forbidden");
    expect(await code(() => backupsView(t.db, people.manager.actor, NOW))).toBe("forbidden");
    expect(await code(() => recordRestoreTest(t.db, people.manager.actor, {}, NOW))).toBe("forbidden");
    expect(await code(() => performAccessReview(t.db, people.manager.actor, {}, NOW))).toBe("forbidden");
    expect(await code(() => resetStaffTwoStep(t.db, people.manager.actor, { employeeId: people.cashier.id, reason: "lost phone" }, NOW))).toBe("forbidden");
    expect(await code(() => endStaffSession(t.db, finance, { employeeId: people.cashier.id, sessionId: "0".repeat(64), reason: "test" }, NOW))).toBe("forbidden");
    expect(await code(() => saveRolePermissions(t.db, people.manager.actor, { roleId: roleId("cashier"), permissions: [], fingerprint: "", reason: "test" }, NOW))).toBe("forbidden");
    expect(await code(() => listRoles(t.db, cashier, "ar", NOW))).toBe("forbidden");
    expect(await code(() => retentionView(t.db, cashier))).toBe("forbidden");
    // what each default role may open
    expect((await listAuditEvents(t.db, finance, parseAuditFilters(new URLSearchParams()))).rows).toBeDefined();
    expect((await listRefundReviews(t.db, finance, { view: "all", page: 1 }, NOW)).rows).toBeDefined();
    expect((await listStaffSecurity(t.db, people.manager.actor, parseStaffFilters(new URLSearchParams()), "ar", NOW)).rows.length).toBeGreaterThan(0);
  });

  test("the client-safe list of protected-data permissions is the catalogue's", () => {
    expect([...FIELD_KEYS]).toEqual([...FIELD_PERMISSIONS]);
  });

  test("every error code of modules 20 and 22 has a text in ar, en and ckb (module first, then the shared errors)", () => {
    const textOf = (tree: unknown, locale: string, code: string) => ((tree as Record<string, { errors?: Record<string, unknown> }>)[locale]?.errors ?? {})[code];
    const shared = (locale: string, code: string) => textOf(sharedErrors, locale, code);
    expect(textOf(securityMessages, "ar", "own_role")).toEqual(expect.any(String));
    expect(textOf(settingsMessages, "ckb", "setting_changed")).toEqual(expect.any(String));
    expect(shared("en", "idempotency_mismatch")).toEqual(expect.any(String));
    for (const locale of ["ar", "en", "ckb"]) {
      for (const code of SECURITY_ERROR_KEYS) expect(textOf(securityMessages, locale, code) ?? shared(locale, code), `security ${locale} ${code}`).toEqual(expect.any(String));
      for (const code of SETTINGS_ERROR_KEYS) expect(textOf(settingsMessages, locale, code) ?? shared(locale, code), `settings ${locale} ${code}`).toEqual(expect.any(String));
    }
  });
});

describe("20.01 sessions and two-step verification", () => {
  test("ending someone else's session (or all of them) needs a reason, is audited, and never touches one's own account here", async () => {
    const target = await person("support", "target-session");
    const one = await session(target.id);
    const two = await session(target.id);
    const owner = people.owner.actor;
    expect(await code(() => endStaffSession(t.db, owner, { employeeId: target.id, sessionId: one, reason: "" }, NOW))).toBe("invalid");
    expect(await endStaffSession(t.db, owner, { employeeId: target.id, sessionId: one, reason: "جهاز ضائع" }, NOW)).toEqual({ ended: true });
    expect(await endStaffSession(t.db, owner, { employeeId: target.id, sessionId: one, reason: "جهاز ضائع" }, NOW)).toEqual({ ended: false });
    const detail = await getStaffSecurity(t.db, owner, target.id, "ar", NOW);
    expect(detail.sessions.map((s) => s.id)).toEqual([two]);
    expect(detail.sessions[0]).toMatchObject({ browser: "Edge", system: "Windows" });
    expect(await endAllStaffSessions(t.db, people.manager.actor, { employeeId: target.id, reason: "تسجيل خروج كامل" }, NOW)).toEqual({ ended: 1 });
    const revoked = await t.db.select({ revokedAt: employeeSessions.revokedAt }).from(employeeSessions).where(eq(employeeSessions.employeeId, target.id));
    expect(revoked.every((row) => row.revokedAt === NOW)).toBe(true);
    const events = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "security.session.revoke"), eq(auditEvents.entityId, target.id)));
    expect(events.length).toBe(2);
    expect(events.map((event) => event.reason).sort()).toEqual(["تسجيل خروج كامل", "جهاز ضائع"]);
    const mine = await session(people.owner.id);
    expect(await code(() => endStaffSession(t.db, owner, { employeeId: people.owner.id, sessionId: mine, reason: "my own" }, NOW))).toBe("own_account_here");
  });

  test("resetting two-step verification: owner only, someone else's, only when it is on; signs them out everywhere", async () => {
    const target = await person("fulfillment", "target-mfa");
    const live = await session(target.id);
    expect(await code(() => resetStaffTwoStep(t.db, people.owner.actor, { employeeId: target.id, reason: "lost phone" }, NOW))).toBe("two_step_not_on");
    await t.db.update(employees).set({ totpEnabled: true, totpSecretEnc: "v1.x.y", recoveryCodes: ["h"] }).where(eq(employees.id, target.id));
    expect(await code(() => resetStaffTwoStep(t.db, people.owner.actor, { employeeId: people.owner.id, reason: "lost phone" }, NOW))).toBe("own_account_here");
    expect(await resetStaffTwoStep(t.db, people.owner.actor, { employeeId: target.id, reason: "فقد هاتفه" }, NOW)).toEqual({ reset: true });
    const row = await t.db.select().from(employees).where(eq(employees.id, target.id)).get();
    expect(row).toMatchObject({ totpEnabled: false, totpSecretEnc: null, recoveryCodes: null });
    expect((await t.db.select().from(employeeSessions).where(eq(employeeSessions.idHash, live)).get())?.revokedAt).toBe(NOW);
  });

  test("the staff list puts people without two-step first and counts coverage per role", async () => {
    const page = await listStaffSecurity(t.db, people.owner.actor, parseStaffFilters(new URLSearchParams("twostep=off&status=active")), "ar", NOW);
    expect(page.rows.every((row) => !row.twoStep && row.status === "active")).toBe(true);
    expect(page.coverage.active).toBeGreaterThan(0);
    expect(page.coverage.byRole.find((role) => role.key === "owner")?.members).toBeGreaterThanOrEqual(2);
  });
});

describe("20.02 roles and assignments", () => {
  test("the owner role is locked, the wildcard is the owner's alone, a stale editor is refused", async () => {
    const owner = people.owner.actor;
    expect(await code(() => saveRolePermissions(t.db, owner, { roleId: roleId("owner"), permissions: [], fingerprint: "*", reason: "test" }, NOW))).toBe("role_locked");
    const role = await getRole(t.db, owner, roleId("content"), "ar");
    expect(await code(() => saveRolePermissions(t.db, owner, { roleId: roleId("content"), permissions: [...role.stored, "*"], fingerprint: role.fingerprint, reason: "test" }, NOW))).toBe("wildcard_owner_only");
    expect(await code(() => saveRolePermissions(t.db, owner, { roleId: roleId("content"), permissions: [...role.stored, "audit.read"], fingerprint: "stale", reason: "test" }, NOW))).toBe("role_changed");
    expect(await code(() => saveRolePermissions(t.db, owner, { roleId: roleId("content"), permissions: role.stored, fingerprint: role.fingerprint, reason: "test" }, NOW))).toBe("invalid");
  });

  test("a change adds and removes exactly, reaches the members, and is audited with before and after", async () => {
    const owner = people.owner.actor;
    const before = await getRole(t.db, owner, roleId("support"), "ar");
    const next = [...before.stored.filter((permission) => permission !== "support.canned_reply.manage"), "audit.read"];
    const result = await saveRolePermissions(t.db, owner, { roleId: roleId("support"), permissions: next, fingerprint: before.fingerprint, reason: "الدعم يرى سجل التدقيق" }, NOW);
    expect(result.added).toEqual(["audit.read"]);
    expect(result.removed).toEqual(["support.canned_reply.manage"]);
    const after = await getRole(t.db, owner, roleId("support"), "ar");
    expect(after.stored).toContain("audit.read");
    expect(after.stored).not.toContain("support.canned_reply.manage");
    const event = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "security.role.update"), eq(auditEvents.entityId, roleId("support")))).get();
    expect(event?.reason).toBe("الدعم يرى سجل التدقيق");
    expect((event?.after as { added: string[] }).added).toEqual(["audit.read"]);
    // the old fingerprint is stale now — also when the race lands between the read and the batch
    expect(await code(() => saveRolePermissions(t.db, owner, { roleId: roleId("support"), permissions: before.stored, fingerprint: before.fingerprint, reason: "undo" }, NOW))).toBe("role_changed");
  });

  test("nobody grants what they do not hold, or edits a role they hold", async () => {
    const roleManager = await person(["staff.manage", "security.session.read", "orders.order.read", "audit.read"], "role-manager");
    const target = await getRole(t.db, people.owner.actor, roleId("cashier"), "ar");
    expect(await code(() => saveRolePermissions(t.db, roleManager.actor, { roleId: roleId("cashier"), permissions: [...target.stored, "cost.read"], fingerprint: target.fingerprint, reason: "test" }, NOW))).toBe("grant_exceeds_own");
    expect((await saveRolePermissions(t.db, roleManager.actor, { roleId: roleId("cashier"), permissions: [...target.stored, "orders.order.read"], fingerprint: target.fingerprint, reason: "الكاشير يرى الطلبات" }, NOW)).added).toEqual(["orders.order.read"]);
    const own = (await t.db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(eq(employeeRoles.employeeId, roleManager.id)).get())!.roleId;
    const ownRole = await getRole(t.db, roleManager.actor, own, "ar");
    expect(ownRole.locked).toBe("own_role");
    expect(await code(() => saveRolePermissions(t.db, roleManager.actor, { roleId: own, permissions: [...ownRole.stored, "orders.order.update"], fingerprint: ownRole.fingerprint, reason: "test" }, NOW))).toBe("own_role");
    // assigning the owner role (the wildcard) or a role with cost.read is beyond this manager
    const victim = await person("support", "assign-target");
    const current = (await t.db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(eq(employeeRoles.employeeId, victim.id))).map((row) => row.roleId).sort().join(",");
    expect(await code(() => setEmployeeRoles(t.db, roleManager.actor, { employeeId: victim.id, roleIds: [roleId("support"), roleId("owner")], expected: current, reason: "test" }, NOW))).toBe("grant_exceeds_own");
    expect(await code(() => setEmployeeRoles(t.db, roleManager.actor, { employeeId: victim.id, roleIds: [roleId("support"), roleId("finance")], expected: current, reason: "test" }, NOW))).toBe("grant_exceeds_own");
    expect(await code(() => setEmployeeRoles(t.db, roleManager.actor, { employeeId: roleManager.id, roleIds: [], expected: own, reason: "test" }, NOW))).toBe("own_roles");
  });

  test("role assignment: what is gained and lost, a stale form refused, and the last active owner keeps the role", async () => {
    const owner = people.owner.actor;
    const target = await person("cashier", "promote");
    const result = await setEmployeeRoles(t.db, owner, { employeeId: target.id, roleIds: [roleId("cashier"), roleId("finance")], expected: roleId("cashier"), reason: "انتقل إلى المالية" }, NOW);
    expect(result.added).toEqual([roleId("finance")]);
    expect(result.gained).toContain("cost.read");
    expect(await code(() => setEmployeeRoles(t.db, owner, { employeeId: target.id, roleIds: [roleId("cashier")], expected: roleId("cashier"), reason: "stale" }, NOW))).toBe("roles_changed");
    const event = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "security.employee.roles"), eq(auditEvents.entityId, target.id))).get();
    expect((event?.after as { fieldGained: string[] }).fieldGained).toEqual(expect.arrayContaining(["cost.read", "profit.read"]));

    // only one active owner left: disable the others, then someone tries to take the role away. A role manager who is
    // not an owner may not take the owner role at all (revoke_exceeds_own, review 2026-11-11); what may (here the
    // server itself) still meets the in-batch guard
    const owners = await t.db.select({ id: employeeRoles.employeeId }).from(employeeRoles).where(eq(employeeRoles.roleId, roleId("owner")));
    const keep = people.owner.id;
    await t.db.update(employees).set({ status: "disabled" }).where(sql`${employees.id} IN (SELECT value FROM json_each(${JSON.stringify(owners.map((row) => row.id).filter((id) => id !== keep))}))`);
    const remover = await person(["staff.manage", "security.session.read"], "remover");
    expect(await code(() => setEmployeeRoles(t.db, remover.actor, { employeeId: keep, roleIds: [], expected: roleId("owner"), reason: "test" }, NOW))).toBe("revoke_exceeds_own");
    expect(await code(() => setEmployeeRoles(t.db, systemActor("test"), { employeeId: keep, roleIds: [], expected: roleId("owner"), reason: "test" }, NOW))).toBe("last_owner");
    await t.db.update(employees).set({ status: "active" }).where(eq(employees.id, people.owner2.id));
  });

  test("a new role starts empty or as a copy within the creator's own permissions; branches must exist", async () => {
    const limited = await person(["staff.manage", "security.session.read", "orders.order.read", "orders.order.note"], "creator");
    const copy = await createRole(t.db, limited.actor, { key: "orders_helper", nameAr: "مساعد الطلبات", copyFrom: roleId("support"), reason: "دور جديد" }, NOW);
    const stored = (await t.db.select({ permission: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, copy.roleId))).map((row) => row.permission).sort();
    expect(stored).toEqual(["orders.order.note", "orders.order.read"]);
    expect(copy.skipped).toBeGreaterThan(0);
    expect(await code(() => createRole(t.db, people.owner.actor, { key: "orders_helper", nameAr: "مكرر", reason: "test" }, NOW))).toBe("role_key_taken");
    expect(await code(() => createRole(t.db, people.owner.actor, { key: "owner", nameAr: "مالك ثان", reason: "test" }, NOW))).toBe("role_key_taken");
    expect(await code(() => setEmployeeBranch(t.db, people.owner.actor, { employeeId: people.cashier.id, branchId: "br_missing", reason: "test" }, NOW))).toBe("branch_unknown");
    expect(fingerprintOf(["b", "a"])).toBe("a,b");
  });
});

describe("20.03 the audit trail", () => {
  test("cost snapshots are withheld or cut for employees without cost.read — on screen and in the CSV", async () => {
    const owner = people.owner.actor;
    const costEvent = await audit(t.db, { actor: owner, action: "pricing.cost.update", entityType: "variant", entityId: "var_cost_probe", before: { unitCost: 100 }, after: { unitCost: 120, landedCostIqd: 160_000 }, reason: "new supplier price", at: NOW });
    const mixed = await audit(t.db, { actor: owner, action: "orders.order.update", entityType: "order", entityId: "ord_probe", after: { qty: 2, costSnapshotIqd: 90_000, marginBps: 1200, note: "ok" }, reason: "probe", at: NOW });
    const reader = await person(["audit.read"], "auditor");
    const listed = await listAuditEvents(t.db, reader.actor, parseAuditFilters(new URLSearchParams("type=variant&entity=var_cost_probe")));
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0].withheld).toBe(true);
    const hidden = await getAuditEvent(t.db, reader.actor, costEvent);
    expect(hidden.after).toBeNull();
    const cut = await getAuditEvent(t.db, reader.actor, mixed);
    expect(cut.after).toEqual({ qty: 2, note: "ok" });
    const full = await getAuditEvent(t.db, owner, costEvent);
    expect(full.after).toMatchObject({ landedCostIqd: 160_000 });
    const csv = await exportAuditCsv(t.db, reader.actor, parseAuditFilters(new URLSearchParams("q=probe")), NOW);
    expect(csv.csv).not.toMatch(/costSnapshotIqd|marginBps|landedCostIqd/);
    expect((await exportAuditCsv(t.db, owner, parseAuditFilters(new URLSearchParams("q=probe")), NOW)).csv).toMatch(/costSnapshotIqd/);
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "security.audit.export"))).toHaveLength(2);
  });

  test("filters: by module, by person, by day", async () => {
    const owner = people.owner.actor;
    const bySecurity = await listAuditEvents(t.db, owner, parseAuditFilters(new URLSearchParams("module=security")));
    expect(bySecurity.rows.length).toBeGreaterThan(0);
    expect(bySecurity.rows.every((row) => row.action.startsWith("security."))).toBe(true);
    const byPerson = await listAuditEvents(t.db, owner, parseAuditFilters(new URLSearchParams(`actor=${people.owner.id}`)));
    expect(byPerson.rows.every((row) => row.actorId === people.owner.id)).toBe(true);
    const future = await listAuditEvents(t.db, owner, parseAuditFilters(new URLSearchParams("from=2030-01-01")));
    expect(future.total).toBe(0);
  });

  test("sealing and verifying (security.audit.verify) — both are recorded; a manager may, finance may not", async () => {
    expect(await code(() => sealNow(t.db, people.finance.actor, NOW))).toBe("forbidden");
    const seal = await sealNow(t.db, people.manager.actor, NOW);
    expect(seal.events).toBeGreaterThan(0);
    expect(seal.headHash).toMatch(/^[0-9a-f]{64}$/);
    const report = await verifyChain(t.db, people.manager.actor, NOW);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    const recorded = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "security.audit.verify")).get();
    expect((recorded?.after as { ok: boolean }).ok).toBe(true);
  });
});

describe("20.04 encryption status", () => {
  test("the key's self-test and readable secrets are counts and booleans — never a secret", async () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const enrolled = await person("finance", "enrolled");
    await t.db.update(employees).set({ totpEnabled: true, totpSecretEnc: await encryptSecret(secret, TEST_VARS.DATA_KEY, `employee:${enrolled.id}:totp`) }).where(eq(employees.id, enrolled.id));
    const status = await encryptionStatus(t.db, people.owner.actor, { DATA_KEY: TEST_VARS.DATA_KEY });
    expect(status.dataKey).toEqual({ configured: true, validLength: true, selfTest: true });
    expect(status.totp.readable).toBeGreaterThanOrEqual(1);
    expect(status.totp.unreadable).toBe(0);
    expect(JSON.stringify(status)).not.toContain(secret);
    const wrongKey = await encryptionStatus(t.db, people.owner.actor, { DATA_KEY: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=" });
    expect(wrongKey.dataKey.selfTest).toBe(true);
    expect(wrongKey.totp.unreadable).toBeGreaterThanOrEqual(1);
    const none = await encryptionStatus(t.db, people.owner.actor, {});
    expect(none.dataKey).toEqual({ configured: false, validLength: false, selfTest: false });
  });

  test("20.06 every idempotency rule exists in the schema, and incoming events are keyed by provider and id", async () => {
    const view = await duplicatesView(t.db, people.finance.actor);
    expect(view.rules.every((rule) => rule.present)).toBe(true);
    expect(view.inboundKey).toBe(true);
    expect(view.inbound.total).toBe(0);
  });
});

describe("20.05 restore tests and 20.07 reviews", () => {
  test("a restore test is evidence: recorded once per form, never in the future, the owner's", async () => {
    const raw = { testedOn: "2026-11-09", method: "time_travel_new_db", restoredTo: "tamtam-db-restore-test", durationMinutes: "١٢", result: "passed", checks: "أعداد الطلبات والقيود متطابقة، والسلسلة سليمة", idempotencyKey: "restore-form-0001" };
    const first = await recordRestoreTest(t.db, people.owner.actor, raw, NOW);
    expect(first.replayed).toBe(false);
    expect(await recordRestoreTest(t.db, people.owner.actor, raw, NOW)).toEqual({ id: first.id, replayed: true });
    expect(await code(() => recordRestoreTest(t.db, people.owner.actor, { ...raw, testedOn: "2026-12-01", idempotencyKey: "restore-form-0002" }, NOW))).toBe("restore_test_future");
    const view = await backupsView(t.db, people.owner.actor, NOW);
    expect(view.tests).toHaveLength(1);
    expect(view.tests[0]).toMatchObject({ durationMinutes: 12, result: "passed", restoredTo: "tamtam-db-restore-test" });
    expect(view.due).toBe(false);
  });

  test("an access review records what the reviewer saw; a role changed since is reviewed again", async () => {
    const role = await getRole(t.db, people.owner.actor, roleId("inventory"), "ar");
    expect(await code(() => performAccessReview(t.db, people.owner.actor, { roleId: roleId("inventory"), outcome: "confirmed", note: "صحيح", fingerprint: "stale", members: role.membersFingerprint }, NOW))).toBe("role_changed");
    await performAccessReview(t.db, people.owner.actor, { roleId: roleId("inventory"), outcome: "confirmed", note: "الصلاحيات والأعضاء صحيحة", fingerprint: role.fingerprint, members: role.membersFingerprint }, NOW);
    const rows = await listRoles(t.db, people.owner.actor, "ar", NOW);
    const inventory = rows.find((row) => row.id === roleId("inventory"));
    expect(inventory?.lastReview).toMatchObject({ outcome: "confirmed", by: "owner" });
    expect(inventory?.reviewDue).toBe(false);
    expect(rows.find((row) => row.id === roleId("support"))?.reviewDue).toBe(true);
    const view = await retentionView(t.db, people.finance.actor);
    expect(view.rows.find((row) => row.key === "authEvents")?.days).toBe(180);
  });
});

describe("20.08 alerts and refund reviews", () => {
  test("sign-in alerts by rule; a phone typed at a sign-in is masked without customer.phone.read_full", async () => {
    const phone = "+9647701234567";
    const at = (offset: number) => NOW - offset;
    const rows = [
      ...Array.from({ length: 6 }, (_, index) => ({ id: newId("aev"), subjectKind: "customer" as const, subjectId: null, identifier: phone, kind: "login", success: false, ip: "198.51.100.9", userAgent: null, details: null, at: at(index * 60_000 + 1000) })),
      { id: newId("aev"), subjectKind: "customer" as const, subjectId: null, identifier: phone, kind: "lockout", success: false, ip: "198.51.100.9", userAgent: null, details: { windowSec: 900 }, at: at(500) },
      { id: newId("aev"), subjectKind: "employee" as const, subjectId: people.support.id, identifier: people.support.email, kind: "login", success: true, ip: "192.0.2.1", userAgent: null, details: { secondStep: "off" }, at: at(40 * 24 * HOUR) },
      { id: newId("aev"), subjectKind: "employee" as const, subjectId: people.support.id, identifier: people.support.email, kind: "login", success: true, ip: "192.0.2.99", userAgent: null, details: { secondStep: "off" }, at: at(2 * HOUR) },
    ];
    await t.db.insert(authEvents).values(rows);
    const reviewer = await person(["security.auth_event.read"], "signin-reviewer");
    const overview = await signinOverview(t.db, reviewer.actor, "24h", NOW);
    const repeated = overview.alerts.find((alert) => alert.rule === "identifier_failures");
    expect(repeated).toMatchObject({ count: 6, identifierMasked: true });
    expect(repeated?.identifier).not.toContain("1234567");
    expect(overview.alerts.some((alert) => alert.rule === "lockout")).toBe(true);
    expect(overview.alerts.find((alert) => alert.rule === "new_address")).toMatchObject({ subjectId: people.support.id, ip: "192.0.2.99" });
    const full = await signinOverview(t.db, people.owner.actor, "24h", NOW);
    expect(full.alerts.find((alert) => alert.rule === "identifier_failures")?.identifier).toBe(phone);
    // a full number finds its events; partial digits find nothing for someone who may not see numbers
    expect((await listAuthEvents(t.db, reviewer.actor, { window: "24h", outcome: null, subject: null, kind: null, q: "07701234567", page: 1 }, NOW)).total).toBe(7);
    expect((await listAuthEvents(t.db, reviewer.actor, { window: "24h", outcome: null, subject: null, kind: null, q: "1234567", page: 1 }, NOW)).total).toBe(0);
    const logged = await listAuthEvents(t.db, reviewer.actor, { window: "24h", outcome: "failed", subject: "customer", kind: null, q: "", page: 1 }, NOW);
    expect(logged.rows.every((row) => row.identifierMasked && !row.identifier?.includes("1234567"))).toBe(true);
  });

  test("refund reviews: signals with their numbers; never reviewed by who asked for or approved it", async () => {
    const product = await make.product({ priceIqd: 1_500_000 });
    const order = await make.order([{ ...product, qty: 1 }], { status: "delivered", paymentStatus: "paid" });
    const paymentId = await make.payment(order.orderId, order.totalIqd, { method: "cod", status: "paid" });
    const refundId = newId("rfd");
    const asker = people.manager.id;
    await t.db.update(orders).set({ paidIqd: order.totalIqd }).where(eq(orders.id, order.orderId));
    await t.db.insert(refunds).values({ id: refundId, orderId: order.orderId, paymentId, amountIqd: 1_200_000, method: "wallet", reason: "test", status: "paid", createdBy: asker, approvedBy: asker, createdAt: NOW - HOUR });
    const page = await listRefundReviews(t.db, people.finance.actor, { view: "flagged", page: 1 }, NOW);
    const row = page.rows.find((entry) => entry.id === refundId);
    expect(row?.signals).toEqual(expect.arrayContaining(["high_value", "other_method", "one_person"]));
    expect(row?.paymentMethod).toBe("cod");
    expect(await code(() => reviewRefund(t.db, people.manager.actor, { refundId, outcome: "cleared", note: "راجعته" }, NOW))).toBe("reviewer_involved");
    expect(await code(() => reviewRefund(t.db, people.finance.actor, { refundId, outcome: "suspicious", note: "" }, NOW))).toBe("invalid");
    await reviewRefund(t.db, people.finance.actor, { refundId, outcome: "suspicious", note: "استرداد إلى المحفظة لدفعة نقدية" }, NOW);
    const suspicious = await listRefundReviews(t.db, people.owner.actor, { view: "suspicious", page: 1 }, NOW);
    expect(suspicious.rows.map((entry) => entry.id)).toContain(refundId);
    expect(suspicious.rows.find((entry) => entry.id === refundId)?.review).toMatchObject({ outcome: "suspicious", by: "finance" });
    const unreviewed = await listRefundReviews(t.db, people.owner.actor, { view: "unreviewed", page: 1 }, NOW);
    expect(unreviewed.rows.map((entry) => entry.id)).not.toContain(refundId);
  });
});

// ───────────────────────────────────────────────────────────────── routes

function requestCtx(): RequestCtx {
  return {
    requestId: `sec-${randomToken(6)}`,
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
  const pair = setCookies.map((line) => line.split("; ")[0]).find((value) => value.startsWith("tt_adm=") && value.length > 10);
  return pair ?? "";
}

async function run(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { headers: { cookie } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params, url: new URL(request.url), pattern: path } as never);
      return new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}

const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);

describe("routes", () => {
  test("the staff page answers 403 to a role without security.session.read, and serves the manager", async () => {
    const financeCookie = await signedIn(people.finance);
    expect(statusOf(await run(financeCookie, "/admin/security/staff", {}, staffLoader as never))).toBe(403);
    const managerCookie = await signedIn(people.manager2);
    const data = (await run(managerCookie, "/admin/security/staff", {}, staffLoader as never)) as { page?: { rows: unknown[] } };
    expect(data.page?.rows.length).toBeGreaterThan(0);
  });

  test("the protections page answers 403 to a role that may see neither section", async () => {
    const supportCookie = await signedIn(people.support);
    expect(statusOf(await run(supportCookie, "/admin/security/protections", {}, protectionsLoader as never))).toBe(403);
  });
});
