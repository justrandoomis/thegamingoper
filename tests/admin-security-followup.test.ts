/**
 * Admin module 20 "security" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · unreviewedCount listed every refund of 90 days (and their reviews) into the worker to count them, and counted
 *     refunds the reviewer asked for or approved, which reviewRefund refuses them — too heavy and too wide for the
 *     bell. Now one statement, one row back, only what this reviewer may review
 *   · the retention page read every purge count from the `retention` run, but three purges run as their own jobs
 *     since 2026-11-11: their rows never showed what was deleted. Each row reads its own job's last run now
 *   · the role page linked a staff.manage-only viewer (let in by the gate for module 15) to the audit trail and to
 *     each member's security page — both 403 for them
 *   · ending another employee's sessions had no hierarchy rule: a manager with security.session.revoke could sign the
 *     owner out again and again. Now target_more_privileged, as for resetting two-step
 *   · an audit reader without staff.payroll.read saw every salary change, payroll run and advance through the trail
 */
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { loader as roleLoader } from "~/routes/admin/security/role";
import { can, systemActor, type EmployeeActor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { createDb } from "~/server/db/drizzle.server";
import { employeeRoles, employeeSessions, jobRuns, orders, refunds, rolePermissions, roles } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { getAuditEvent } from "~/server/services/admin/security/audit-log.server";
import { listRefundReviews, unreviewedCount } from "~/server/services/admin/security/refund-reviews.server";
import { retentionView } from "~/server/services/admin/security/retention.server";
import { endAllStaffSessions, endStaffSession, getStaffSecurity } from "~/server/services/admin/security/staff.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 3_600_000;
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
  const password = "security-followup-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("secfu")}@security.test`;
  const id = await make.employee({ email, name: name ?? (Array.isArray(role) ? "custom" : role), passwordHash: hashed.hash, passwordIters: hashed.iterations });
  if (Array.isArray(role)) {
    const custom = `role_secfu_${++roleSeq}`;
    await t.db.insert(roles).values({ id: custom, key: `secfu_${roleSeq}`, name: { ar: "دور متابعة", en: "Follow-up role" }, isSystem: false, createdAt: NOW });
    if (role.length) await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, email, password, actor: { kind: "employee", id, permissions: new Set<string>(role), label: name ?? "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password, actor: { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: name ?? role } };
}
async function code(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return toAppError(error)?.code ?? "unexpected";
  }
  return "no error";
}

function requestCtx(): RequestCtx {
  return {
    requestId: `secfu-${randomToken(6)}`,
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
async function run(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { headers: { cookie } });
  const context = new RouterContextProvider();
  let out: unknown;
  await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
    out = await fn({ request, context, params, url: new URL(request.url), pattern: path } as never);
    return new Response(null);
  });
  return out;
}

/** A D1 binding that counts the statements prepared and the rows they bring back. */
function countingD1(real: D1Database): { d1: D1Database; statements: () => number; rows: () => number } {
  let statements = 0;
  let rows = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async () => {
        const result = await statement.all();
        rows += result.results.length;
        return result;
      },
      raw: async () => {
        const result = await statement.raw();
        rows += result.length;
        return result;
      },
      first: async (column?: string) => {
        const result = column === undefined ? await statement.first() : await statement.first(column);
        rows += result === null ? 0 : 1;
        return result;
      },
      run: () => statement.run(),
    }) as unknown as D1PreparedStatement;
  const d1 = { prepare: (sql: string) => (statements++, wrap(real.prepare(sql))), batch: (list: D1PreparedStatement[]) => real.batch(list), exec: (sql: string) => real.exec(sql) };
  return { d1: d1 as unknown as D1Database, statements: () => statements, rows: () => rows };
}

describe("admin 20 security — follow-up", () => {
  test("unreviewedCount: only refunds this reviewer may review, in one statement that brings back one row", async () => {
    const asker = await person("manager", "asker");
    const reviewer = await person("finance", "reviewer");
    const product = await make.product({ priceIqd: 1_500_000 });
    for (let i = 0; i < 4; i++) {
      const order = await make.order([{ ...product, qty: 1 }], { status: "delivered", paymentStatus: "paid" });
      const paymentId = await make.payment(order.orderId, order.totalIqd, { method: "cod", status: "paid" });
      await t.db.update(orders).set({ paidIqd: order.totalIqd }).where(eq(orders.id, order.orderId));
      // high value, another method, one person: flagged; two asked by `asker`, two by someone else
      await t.db.insert(refunds).values({ id: newId("rfd"), orderId: order.orderId, paymentId, amountIqd: 1_200_000, method: "wallet", reason: "test", status: "paid", createdBy: i < 2 ? asker.id : "emp_someone_else", approvedBy: i < 2 ? asker.id : "emp_someone_else", createdAt: NOW - (i + 1) * HOUR });
    }
    // what each reviewer may review: the flagged, unreviewed refunds they neither asked for nor approved (each one's
    // own "unreviewed" list since the review of 2026-11-12, which holds exactly those)
    const mayReview = async (actor: EmployeeActor) => {
      const all = await listRefundReviews(t.db, actor, { view: "flagged", page: 1 }, NOW);
      return all.rows.filter((row) => !row.review && row.createdById !== actor.id && row.approvedById !== actor.id).length;
    };
    expect(await unreviewedCount(t.db, asker.actor, NOW)).toBe(await mayReview(asker.actor));
    expect(await unreviewedCount(t.db, reviewer.actor, NOW)).toBe(await mayReview(reviewer.actor));
    expect((await unreviewedCount(t.db, reviewer.actor, NOW)) ?? 0).toBe(((await unreviewedCount(t.db, asker.actor, NOW)) ?? 0) + 2);
    const counting = countingD1(t.d1);
    await unreviewedCount(createDb(counting.d1), reviewer.actor, NOW);
    expect(counting.statements()).toBe(1);
    expect(counting.rows()).toBe(1);
  });

  test("review 2026-11-12: the module's card count is the list it opens — 'unreviewed' holds what this reviewer may review", async () => {
    // the security home's card ("refunds to review", unreviewedCount) links to /admin/security/refunds?view=unreviewed:
    // the list and its chip count must hold exactly those, not also the refunds this reviewer asked for or approved
    const own = await person("finance", "own refunds");
    const product = await make.product({ priceIqd: 1_400_000 });
    for (let i = 0; i < 3; i++) {
      const order = await make.order([{ ...product, qty: 1 }], { status: "delivered", paymentStatus: "paid" });
      const paymentId = await make.payment(order.orderId, order.totalIqd, { method: "cod", status: "paid" });
      await t.db.update(orders).set({ paidIqd: order.totalIqd }).where(eq(orders.id, order.orderId));
      // flagged (high value, another method); two asked and approved by `own`, one by someone else
      await t.db.insert(refunds).values({ id: newId("rfd"), orderId: order.orderId, paymentId, amountIqd: 1_100_000, method: "cash", reason: "test", status: "paid", createdBy: i < 2 ? own.id : "emp_another", approvedBy: i < 2 ? own.id : "emp_another", createdAt: NOW - (i + 1) * 2 * HOUR });
    }
    const count = await unreviewedCount(t.db, own.actor, NOW);
    const list = await listRefundReviews(t.db, own.actor, { view: "unreviewed", page: 1 }, NOW);
    expect(list.total).toBe(count);
    expect(list.counts.unreviewed).toBe(count);
    expect(list.rows.every((row) => row.canReview)).toBe(true);
    // their own refunds stay in sight in the other views, marked as not theirs to review
    const flagged = await listRefundReviews(t.db, own.actor, { view: "flagged", page: 1 }, NOW);
    expect(flagged.rows.filter((row) => row.createdById === own.id).every((row) => !row.canReview)).toBe(true);
    expect(flagged.rows.some((row) => row.createdById === own.id)).toBe(true);
  });

  test("each retention row shows what its own purge job deleted last", async () => {
    const owner = await person("owner", "retention-owner");
    const run = (job: string, stats: Record<string, unknown>, at: number) => t.db.insert(jobRuns).values({ id: newId("run"), job, status: "succeeded", startedAt: at, finishedAt: at + 1000, stats, origin: "cron" } as typeof jobRuns.$inferInsert);
    await run("retention", { customerSessions: 3, employeeSessions: 2, otpCodes: 4, authEvents: 5, outbox: 6, jobRuns: 7, topupProofs: 1, assistantSessions: 0 }, NOW - HOUR);
    await run("recommendations.events.purge", { deleted: 12 }, NOW - HOUR);
    await run("tradein.drafts.purge", { deleted: 2 }, NOW - HOUR);
    await run("ops.telemetry.purge", { errors: 3, perf: 4 }, NOW - HOUR);
    const view = await retentionView(t.db, owner.actor);
    const deleted = Object.fromEntries(view.rows.map((row) => [row.key, row.deleted]));
    expect(deleted).toMatchObject({ sessions: 5, otpCodes: 4, recommendationEvents: 12, tradeInDrafts: 2, opsTelemetry: 7, assistantSessions: 0 });
    expect(view.runs.map((entry) => entry.job)).toEqual(["retention", "recommendations.events.purge", "tradein.drafts.purge", "ops.telemetry.purge"]);
  });

  test("the role page links a staff.manage-only viewer to no page that answers them 403", async () => {
    const hr = await person(["staff.manage"], "hr only");
    const owner = await person("owner", "role-owner");
    const asHr = (await run(await signedIn(hr), `/admin/security/roles/${roleId("cashier")}`, { roleId: roleId("cashier") }, roleLoader as never)) as { links: { history: boolean; staff: boolean } };
    expect(asHr.links).toEqual({ history: false, staff: false });
    const asOwner = (await run(await signedIn(owner), `/admin/security/roles/${roleId("cashier")}`, { roleId: roleId("cashier") }, roleLoader as never)) as { links: { history: boolean; staff: boolean } };
    expect(asOwner.links).toEqual({ history: true, staff: true });
  });

  test("ending sessions: never an account that holds more than the person ending them", async () => {
    const owner = await person("owner", "session-owner");
    const manager = await person("manager", "session-manager");
    const cashier = await person("cashier", "session-cashier");
    const sessionOf = async (employeeId: string) => {
      const idHash = randomToken(32).replace(/[^0-9a-f]/gi, "a").toLowerCase().padEnd(64, "a").slice(0, 64);
      await t.db.insert(employeeSessions).values({ idHash, employeeId, mfaOk: true, createdAt: NOW - HOUR, lastSeenAt: NOW - 60_000, expiresAt: NOW + 11 * HOUR, ip: "203.0.113.7", userAgent: "vitest" });
      return idHash;
    };
    expect(can(manager.actor, "security.session.revoke")).toBe(true);
    const ownersSession = await sessionOf(owner.id);
    expect(await code(() => endStaffSession(t.db, manager.actor, { employeeId: owner.id, sessionId: ownersSession, reason: "خروج قسري" }, NOW))).toBe("target_more_privileged");
    expect(await code(() => endAllStaffSessions(t.db, manager.actor, { employeeId: owner.id, reason: "خروج قسري" }, NOW))).toBe("target_more_privileged");
    expect((await getStaffSecurity(t.db, manager.actor, owner.id, "ar", NOW)).can.revoke).toBe(false);
    // someone they outrank: as before
    const cashiersSession = await sessionOf(cashier.id);
    expect(await endStaffSession(t.db, manager.actor, { employeeId: cashier.id, sessionId: cashiersSession, reason: "جهاز ضائع" }, NOW)).toEqual({ ended: true });
    expect((await getStaffSecurity(t.db, manager.actor, cashier.id, "ar", NOW)).can.revoke).toBe(true);
  });

  test("a payroll snapshot in the audit trail is for staff.payroll.read holders only", async () => {
    const employee = await make.employee({ name: "راتب للاختبار" });
    const eventId = await audit(t.db, { actor: systemActor("test.security-followup"), action: "staff.payroll.salary_set", entityType: "employee", entityId: employee, before: { baseSalaryIqd: 900_000 }, after: { baseSalaryIqd: 1_250_000 }, reason: "زيادة سنوية", at: NOW });
    const auditor = await person(["audit.read"], "auditor");
    const withPay = await person(["audit.read", "staff.payroll.read"], "auditor with pay");
    const hidden = await getAuditEvent(t.db, auditor.actor, eventId);
    expect(hidden).toMatchObject({ withheld: true, before: null, after: null });
    expect(JSON.stringify(hidden)).not.toContain("1250000");
    const shown = await getAuditEvent(t.db, withPay.actor, eventId);
    expect(shown).toMatchObject({ withheld: false, after: { baseSalaryIqd: 1_250_000 } });
  });
});

