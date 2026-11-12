/**
 * Platform integration of admin wave D (2026-11-12, owner: admin shell / platform): the bell's queues of modules 08,
 * 14, 15, 17 and 23, the gate's three narrow exceptions, the operations module's timing middleware and reporter in the
 * shell, the scheduled jobs of the wave, the auth core's staff accounts (createEmployee with a one-time password link,
 * enableEmployee, the hierarchy rule on ending sessions, two-step verification required per role) and entry.server's
 * handleError. Each test fails on the code before this pass.
 *
 * Runs against a real local D1 (tests/helpers/db.ts) with the built-in roles installed.
 */
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { handleError, recordServerError, routePatternOf } from "~/entry.server";
import errorsMessages from "~/i18n/messages/errors";
import { randomToken } from "~/lib/ids";
import { middleware as layoutMiddleware } from "~/routes/admin/_layout";
import { opsTimingMiddleware } from "~/routes/admin/ops/observe.server";
import { adminGate, findAdminSession, gateAllows, gateRuleOf } from "~/routes/admin/shell/gate.server";
import { loadWaiting, QUEUE_HREF, type ShellWaiting } from "~/routes/admin/shell/queues.server";
import type { EmployeeActor } from "~/server/actor";
import { beginTotpEnrollment, confirmTotpEnrollment, disableOwnTotp, getEmployee, MFA_ENROLMENT_PATH, requireEmployee, revokeAllEmployeeSessions, revokeEmployeeSession, signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { checkPasswordLink, createEmployee, enableEmployee, issuePasswordLink, PASSWORD_LINK_PATH, roleTwoStep, setPasswordWithLink, setRoleTwoStepRequired } from "~/server/auth/employees.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword, toBase64Url, totpCode } from "~/server/crypto.server";
import {
  approvals,
  auditEvents,
  consistencyFindings,
  employeePasswordLinks,
  employeeRoles,
  employees,
  employeeSessions,
  errorReports,
  jobRuns,
  leaveRequests,
  pages,
  payrollRuns,
  rolePermissions,
  roles,
  stockMovements,
  supportTickets,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { CORE_ERROR_KEYS, toAppError } from "~/server/errors";
import { CONSISTENCY_CHECKS, CRON_DAILY, CRON_FREQUENT, JOB_NAMES, RETENTION_DAYS, SCHEDULES, runJob, runScheduledJobs } from "~/server/jobs.server";
import { roleId, type Permission } from "~/server/permissions";
import { postCogs } from "~/server/services/accounting/post.server";
import { opsQueueCounts } from "~/server/services/admin/ops/overview.server";
import { listApprovals } from "~/server/services/admin/promotions/approvals.server";
import { endAllStaffSessions, endStaffSession } from "~/server/services/admin/security/staff.server";
import { staffDecisions } from "~/server/services/admin/staff/approvals.server";
import { listInbox } from "~/server/services/admin/support/inbox.server";
import { parseInboxFilters } from "~/server/services/admin/support/types";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

/** While on, a module's own count (or a job) throws: only that module's queues (that job) must go. */
const failing = vi.hoisted(() => ({ support: false, telemetryPurge: false }));
/** What handleError handed to the Worker's waitUntil. */
const waited = vi.hoisted(() => ({ promises: [] as Promise<unknown>[] }));
vi.mock("~/server/services/admin/support/inbox.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/support/inbox.server")>();
  return {
    ...real,
    supportQueueCounts: async (...args: Parameters<typeof real.supportQueueCounts>) => {
      if (failing.support) throw new Error("the support counts are down (test)");
      return real.supportQueueCounts(...args);
    },
  };
});
vi.mock("~/server/services/admin/ops/telemetry.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/ops/telemetry.server")>();
  return {
    ...real,
    purgeOpsTelemetry: async (...args: Parameters<typeof real.purgeOpsTelemetry>) => {
      if (failing.telemetryPurge) throw new Error("the telemetry purge is down (test)");
      return real.purgeOpsTelemetry(...args);
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
const DAY = 24 * HOUR;

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

const DATA_KEY = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const secrets = { DATA_KEY };

// ───────────────────────────────────────────────────────────────── helpers

let requestCount = 0;
function request(options: { now?: number; cookies?: Record<string, string> } = {}): { ctx: RequestCtx; setCookies: string[] } {
  const n = ++requestCount;
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `platform-${n}`,
    nonce: "test-nonce",
    origin: "http://localhost:5173",
    isHttps: false,
    isDev: true,
    now: options.now ?? NOW,
    ip: `198.51.${Math.floor(n / 250)}.${n % 250}`,
    country: "IQ",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: (name) => jar.get(name) ?? null,
    setCookie: (serialized) => void setCookies.push(serialized),
  };
  return { ctx, setCookies };
}

/** The admin cookie a response set (the last one wins). */
function adminCookie(setCookies: string[]): string | null {
  let value: string | null = null;
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    if (pair.startsWith("tt_adm=")) value = decodeURIComponent(pair.slice("tt_adm=".length)) || null;
  }
  return value;
}

type Person = { id: string; email: string; password: string; roleId: string; actor: EmployeeActor & { permissions: ReadonlySet<string> } };

/** An employee holding exactly these permissions through a role of their own. */
async function employeeWith(permissions: readonly string[], options: { branchId?: string | null } = {}): Promise<Person> {
  const password = "platform-password-1234";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("pf")}@platform.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations, branchId: options.branchId ?? null, name: "موظف المنصة" });
  const role = `rol_${make.next("pf").replace(/-/g, "_")}`;
  await t.db.insert(roles).values({ id: role, key: role, name: { ar: "دور للاختبار", en: "Test role" }, createdAt: NOW });
  if (permissions.length) await t.db.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: role, permission })));
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: role });
  return { id, email, password, roleId: role, actor: { kind: "employee", id, permissions: new Set(permissions), branchId: options.branchId ?? null } };
}

/** An employee holding a built-in role (owner, manager, …). */
async function builtIn(role: "owner" | "manager" | "cashier" | "support"): Promise<Person> {
  const person = await employeeWith([]);
  await t.db.delete(employeeRoles).where(eq(employeeRoles.employeeId, person.id));
  await t.db.insert(employeeRoles).values({ employeeId: person.id, roleId: roleId(role) });
  const grants = await t.db.select({ permission: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId(role)));
  return { ...person, actor: { ...person.actor, permissions: new Set(grants.map((grant) => grant.permission)) } };
}

/** The shell's session object for an employee (what the gate hands the layout). */
function sessionOf(person: Person, totpEnabled = false): EmployeeSession {
  return {
    employee: { id: person.id, email: person.email, name: "موظف المنصة", phone: null, jobTitle: null, locale: "ar", branchId: person.actor.branchId ?? null, totpEnabled, passwordChangedAt: null },
    actor: person.actor,
    roles: [],
    session: { id: "s", createdAt: NOW, expiresAt: NOW + HOUR, mfaOk: totpEnabled },
  };
}

const queue = (waiting: ShellWaiting, id: string) => waiting.queues.find((entry) => entry.id === id) ?? null;

async function failure(run: () => unknown): Promise<{ code: string; status: number }> {
  try {
    await run();
  } catch (error) {
    const appError = toAppError(error);
    if (appError) return { code: appError.code, status: appError.status };
    throw error;
  }
  throw new Error("Expected the call to fail");
}

async function thrown(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
}

/** Runs the admin gate behind the real root middleware for one route pattern. */
async function throughGate(options: { pattern: string; method?: string; cookies?: Record<string, string> }): Promise<{ result: unknown; session: EmployeeSession | null; reached: boolean }> {
  const cookie = Object.entries(options.cookies ?? {})
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
  const path = options.pattern.replace(/:[A-Za-z]+/g, "x");
  const req = new Request(`http://localhost:5173${path}`, { method: options.method ?? "GET", headers: { ...(cookie ? { cookie } : {}), origin: "http://localhost:5173", "sec-fetch-site": "same-origin" } });
  const context = new RouterContextProvider();
  const url = new URL(req.url);
  let reached = false;
  let result: unknown;
  try {
    result = await requestContextMiddleware({ request: req, context, url, pattern: "/", params: {} }, () =>
      adminGate({ request: req, context, url, pattern: options.pattern, params: {} }, async () => {
        reached = true;
        return new Response("ok");
      }) as Promise<Response>,
    );
  } catch (error) {
    result = error;
  }
  return { result, session: findAdminSession(context), reached };
}

// ───────────────────────────────────────────────────────────────── the bell

describe("the bell: queues of promotions, support, staff, operations and content", () => {
  test("promotions: the requests this employee may decide, never their own — the approvals page lists exactly those", async () => {
    const decide: Permission[] = ["promotions.coupon.manage", "pricing.discount.override"];
    const asker = await employeeWith(decide);
    const decider = await employeeWith(decide);
    const reader = await employeeWith(["promotions.promotion.read"]);
    await t.db.insert(approvals).values([
      { id: `apr_${randomToken(8)}`, kind: "coupon", entityType: "coupon", entityId: "cpn_bell_1", requestedBy: asker.id, payload: { action: "create" }, status: "pending", createdAt: NOW },
      { id: `apr_${randomToken(8)}`, kind: "coupon", entityType: "coupon", entityId: "cpn_bell_2", requestedBy: decider.id, payload: { action: "create" }, status: "pending", createdAt: NOW },
    ]);
    const forDecider = await loadWaiting(t.db, sessionOf(decider), NOW);
    expect(queue(forDecider, "promotion_approvals")).toEqual({ id: "promotion_approvals", module: "promotions", count: 1, href: "/admin/promotions/approvals" });
    const page = await listApprovals(t.db, decider.actor, "ar", { iqd: String, percent: String, points: String });
    expect(page.decide).toHaveLength(1);
    // the asker sees the other request (not their own); a reader decides nothing
    expect(queue(await loadWaiting(t.db, sessionOf(asker), NOW), "promotion_approvals")?.count).toBe(1);
    expect(queue(await loadWaiting(t.db, sessionOf(reader), NOW), "promotion_approvals")).toBeNull();
  });

  test("support: escalated to me, nobody holds it, mine past due — each count is its inbox view's total", async () => {
    const agent = await employeeWith(["support.ticket.read", "support.ticket.assign", "support.ticket.reply"]);
    const readerOnly = await employeeWith(["support.ticket.read"]);
    const ticket = (suffix: string, values: Partial<typeof supportTickets.$inferInsert>) => ({ id: `tkt_bell_${suffix}`, ref: `SP-BELL${suffix.toUpperCase()}`, subject: "الجهاز لا يعمل", status: "open" as const, createdAt: NOW - DAY, updatedAt: NOW - DAY, ...values });
    await t.db.insert(supportTickets).values([
      ticket("esc", { escalatedTo: agent.id, assignedTo: readerOnly.id, firstResponseDueAt: NOW + DAY }),
      ticket("free", { firstResponseDueAt: NOW + DAY }),
      ticket("late", { assignedTo: agent.id, firstResponseDueAt: NOW - HOUR }),
      ticket("done", { assignedTo: agent.id, status: "closed", firstResponseDueAt: NOW - HOUR }),
    ]);
    const waiting = await loadWaiting(t.db, sessionOf(agent), NOW);
    for (const [id, view] of [
      ["support_escalated", "view=escalated_me"],
      ["support_unassigned", "view=unassigned&kind=ticket"],
      ["support_late", "view=late&kind=ticket&assignee=me"],
    ] as const) {
      const entry = queue(waiting, id);
      expect(entry?.href, id).toBe(`/admin/support?${view}`);
      const listed = await listInbox(t.db, agent.actor, parseInboxFilters(new URLSearchParams(view)), NOW);
      expect(entry?.count, id).toBe(listed.total);
      expect(entry?.count, id).toBeGreaterThan(0);
    }
    // read-only: no assignment or reply queue
    const reader = await loadWaiting(t.db, sessionOf(readerOnly), NOW);
    expect(queue(reader, "support_unassigned")).toBeNull();
    expect(queue(reader, "support_late")).toBeNull();
  });

  test("staff: leave to decide, payroll runs to approve, advances to decide — never one's own, never asked for oneself", async () => {
    const approver = await employeeWith(["staff.leave.approve", "staff.payroll.approve", "staff.payroll.read"]);
    const colleague = await employeeWith(["staff.employee.read"]);
    const limited = await employeeWith(["staff.payroll.approve", "staff.payroll.read"], { branchId: null });
    await t.db.insert(leaveRequests).values([
      { id: `lvr_bell_${randomToken(6)}`, employeeId: colleague.id, kind: "annual", startsOn: "2026-11-20", endsOn: "2026-11-21", status: "pending", createdAt: NOW },
      { id: `lvr_bell_${randomToken(6)}`, employeeId: approver.id, kind: "annual", startsOn: "2026-11-22", endsOn: "2026-11-23", status: "pending", createdAt: NOW },
    ]);
    await t.db.insert(payrollRuns).values({ id: `pyr_bell_${randomToken(6)}`, period: "2026-10", status: "draft", createdBy: colleague.id, createdAt: NOW });
    await t.db.insert(approvals).values([
      { id: `apr_${randomToken(8)}`, kind: "staff_advance", entityType: "employee", entityId: colleague.id, requestedBy: colleague.id, payload: { amountIqd: 50_000 }, status: "pending", createdAt: NOW },
      { id: `apr_${randomToken(8)}`, kind: "staff_advance", entityType: "employee", entityId: approver.id, requestedBy: colleague.id, payload: { amountIqd: 50_000 }, status: "pending", createdAt: NOW },
    ]);
    const waiting = await loadWaiting(t.db, sessionOf(approver), NOW);
    const decisions = await staffDecisions(t.db, approver.actor);
    expect(queue(waiting, "staff_leave")).toMatchObject({ module: "staff", count: decisions.filter((item) => item.kind === "leave").length, href: "/admin/staff/leave" });
    expect(queue(waiting, "staff_leave")?.count).toBe(1);
    expect(queue(waiting, "staff_payroll")).toMatchObject({ count: decisions.filter((item) => item.kind === "payroll_run").length, href: "/admin/staff/payroll" });
    expect(queue(waiting, "staff_payroll")?.count).toBeGreaterThanOrEqual(1);
    // the colleague's advance, not the one that pays the approver
    expect(queue(waiting, "staff_advances")).toMatchObject({ count: 1, href: "/admin/staff/payroll/advances?status=pending" });
    // the colleague asked for theirs: nothing for them (and no permission anyway)
    expect(queue(await loadWaiting(t.db, sessionOf(colleague), NOW), "staff_advances")).toBeNull();
    // a branch-limited approver is never asked about a store-wide payroll run
    const branchActor = { ...limited, actor: { ...limited.actor, branchId: "brn_bell" } };
    expect(queue(await loadWaiting(t.db, sessionOf(branchActor), NOW), "staff_payroll")).toBeNull();
  });

  test("operations: failing jobs, overdue incidents, unassigned critical findings — the module's own counts and links", async () => {
    const manager = await employeeWith(["ops.job.read", "ops.job.run", "ops.incident.read", "ops.incident.manage", "ops.consistency.read", "ops.consistency.resolve"]);
    await t.db.insert(jobRuns).values({ id: `job_bell_${randomToken(6)}`, job: "orders.expire_unpaid", status: "failed", origin: "cron", startedAt: NOW - MINUTE, finishedAt: NOW - MINUTE, durationMs: 5, error: "boom (test)" });
    await t.db.insert(consistencyFindings).values({ id: `cfd_bell_${randomToken(6)}`, fingerprint: `bell|${randomToken(6)}`, checkKey: "wallet.negative_balance", severity: "critical", entityType: "customer", entityId: "cus_x", message: "x", status: "open", detectedAt: NOW, lastSeenAt: NOW });
    const counts = await opsQueueCounts(t.db, manager.actor, NOW);
    const waiting = await loadWaiting(t.db, sessionOf(manager), NOW);
    expect(queue(waiting, "ops_jobs")).toMatchObject({ module: "ops", count: counts.failingJobs, href: "/admin/ops/jobs?view=attention" });
    expect(counts.failingJobs).toBeGreaterThanOrEqual(1);
    expect(queue(waiting, "ops_findings")).toMatchObject({ count: counts.criticalFindings, href: "/admin/ops/consistency?severity=critical&assignee=none" });
    expect(counts.criticalFindings).toBeGreaterThanOrEqual(1);
    expect(queue(waiting, "ops_incidents")?.href ?? QUEUE_HREF.ops_incidents).toBe("/admin/ops/incidents?view=overdue");
    // a reader of the jobs page runs nothing: no queue
    const reader = await employeeWith(["ops.job.read"]);
    expect(queue(await loadWaiting(t.db, sessionOf(reader), NOW), "ops_jobs")).toBeNull();
  });

  test("content (optional): policies waiting for a publisher, never one whose draft they saved last", async () => {
    const publisher = await employeeWith(["cms.page.manage", "cms.page.publish"]);
    const other = await employeeWith(["cms.page.manage", "cms.page.publish"]);
    const editor = await employeeWith(["cms.page.manage"]);
    // a fresh store: the four policies of the content module are the code's drafts, approved by nobody
    expect(queue(await loadWaiting(t.db, sessionOf(publisher), NOW), "cms_policies")).toEqual({ id: "cms_policies", module: "cms", count: 4, href: "/admin/cms/pages" });
    await t.db.insert(pages).values({ id: `pag_bell_${randomToken(6)}`, slug: "terms", kind: "policy", title: { ar: "الشروط" }, draft: { ar: [{ type: "p", text: "نص" }] } as never, status: "draft", updatedBy: publisher.id, createdAt: NOW, updatedAt: NOW });
    expect(queue(await loadWaiting(t.db, sessionOf(publisher), NOW), "cms_policies")?.count).toBe(3);
    expect(queue(await loadWaiting(t.db, sessionOf(other), NOW), "cms_policies")?.count).toBe(4);
    expect(queue(await loadWaiting(t.db, sessionOf(editor), NOW), "cms_policies")).toBeNull();
  });

  test("a module whose count fails shows none of ITS queues; every other queue and the page still load", async () => {
    const both = await employeeWith(["support.ticket.read", "support.ticket.assign", "cms.page.manage", "cms.page.publish"]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failing.support = true;
    try {
      const waiting = await loadWaiting(t.db, sessionOf(both), NOW);
      expect(waiting.queues.filter((entry) => entry.module === "support")).toEqual([]);
      expect(queue(waiting, "cms_policies")).not.toBeNull();
      expect(errors.mock.calls.some((call) => String(call[0]).includes("the support queues failed"))).toBe(true);
    } finally {
      failing.support = false;
      errors.mockRestore();
    }
  });

});

// ───────────────────────────────────────────────────────────────── the gate and the layout

describe("the gate's exceptions, the timing middleware and the reporter", () => {
  test("My day opens for every employee (dashboard.overview.read), nothing else of module 15 does", () => {
    const cashier = { kind: "employee" as const, id: "emp_c", permissions: new Set<string>(["dashboard.overview.read", "pos.sale.create"]) };
    const me = gateRuleOf("admin/staff/me");
    expect(me.kind === "module" && gateAllows(cashier, me)).toBe(true);
    for (const pattern of ["admin/staff", "admin/staff/leave", "admin/staff/payroll/:runId"]) {
      const rule = gateRuleOf(pattern);
      expect(rule.kind === "module" && gateAllows(cashier, rule), pattern).toBe(false);
    }
  });

  test("POST /admin/ops/report reaches any signed-in employee; a GET there is still the module's", async () => {
    expect(gateRuleOf("admin/ops/report", "POST")).toEqual({ kind: "employee" });
    expect(gateRuleOf("admin/ops/report", "GET")).toMatchObject({ kind: "module", module: "ops" });
    const cashier = await builtIn("cashier");
    // the root middleware reads the real clock: a session signed in now
    const signed = request({ now: Date.now() });
    await signInEmployee(signed.ctx, t.db, { email: cashier.email, password: cashier.password });
    const cookies = { tt_adm: adminCookie(signed.setCookies)! };
    expect((await throughGate({ pattern: "/admin/ops/report", method: "POST", cookies })).reached).toBe(true);
    const refused = await throughGate({ pattern: "/admin/ops/jobs", cookies });
    expect(refused.reached).toBe(false);
    expect((refused.result as { init?: { status?: number } }).init?.status).toBe(403);
  });

  test("the password-set page needs nobody signed in, and stays no-store/noindex", async () => {
    expect(gateRuleOf("admin/welcome")).toEqual({ kind: "public" });
    const open = await throughGate({ pattern: "/admin/welcome" });
    expect(open.reached).toBe(true);
    expect(open.session).toBeNull();
    const response = open.result as Response;
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    // every other page still sends nobody to the sign-in page
    const closed = await throughGate({ pattern: "/admin/orders" });
    expect(closed.reached).toBe(false);
    expect((closed.result as Response).headers.get("Location")).toMatch(/^\/admin\/login/);
  });

  test("the admin layout times every request after the gate, and the shell mounts the browser reporter", () => {
    expect(layoutMiddleware).toEqual([adminGate, opsTimingMiddleware]);
    const shell = readFileSync(new URL("../app/routes/admin/shell/AdminShell.tsx", import.meta.url), "utf8");
    expect(shell).toMatch(/import \{ OpsReporter \} from "\.\.\/ops\/components\/Reporter"/);
    expect(shell).toMatch(/<OpsReporter \/>/);
  });
});

// ───────────────────────────────────────────────────────────────── jobs

describe("scheduled jobs of wave D", () => {
  test("daily: memberships, points, gift cards, commissions and the telemetry purge are jobs of their own; every five minutes the support routing", async () => {
    for (const job of ["promotions.memberships.close", "promotions.points.sync", "promotions.points.expire", "promotions.gift_cards.expire", "staff.commissions.sync", "ops.telemetry.purge"] as const) {
      expect(SCHEDULES[CRON_DAILY], job).toContain(job);
    }
    expect(SCHEDULES[CRON_DAILY].at(-1)).toBe("consistency.daily");
    expect(SCHEDULES[CRON_FREQUENT]).toContain("support.tickets.route");
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
    expect([...Object.values(SCHEDULES).flat()].sort()).toEqual([...JOB_NAMES].sort());

    const night = await runScheduledJobs(t.db, CRON_DAILY, NOW);
    expect(night.ok).toBe(true);
    const ran = night.jobs.map((job) => [job.job, job.status]);
    for (const job of ["promotions.memberships.close", "promotions.points.sync", "promotions.points.expire", "promotions.gift_cards.expire", "staff.commissions.sync", "ops.telemetry.purge"]) expect(ran).toContainEqual([job, "succeeded"]);
    const rows = await t.db.select({ job: jobRuns.job, status: jobRuns.status }).from(jobRuns).where(inArray(jobRuns.id, night.jobs.map((job) => job.runId)));
    expect(rows).toHaveLength(SCHEDULES[CRON_DAILY].length);
    expect(night.jobs.find((job) => job.job === "ops.telemetry.purge")?.stats).toMatchObject({ errors: expect.any(Number), perf: expect.any(Number) });

    const frequent = await runScheduledJobs(t.db, CRON_FREQUENT, NOW);
    expect(frequent.jobs.find((job) => job.job === "support.tickets.route")).toMatchObject({ status: "succeeded", stats: { routed: expect.any(Number) } });
  });

  test("a failing job fails alone: its own job_runs row, the others of the night still run", async () => {
    failing.telemetryPurge = true;
    try {
      const night = await runScheduledJobs(t.db, CRON_DAILY, NOW + DAY);
      expect(night.ok).toBe(false);
      expect(night.jobs.filter((job) => job.status === "failed").map((job) => job.job)).toEqual(["ops.telemetry.purge"]);
      expect(night.jobs.find((job) => job.job === "consistency.daily")?.status).toBe("succeeded");
      const row = await t.db.select().from(jobRuns).where(eq(jobRuns.id, night.jobs.find((job) => job.job === "ops.telemetry.purge")!.runId)).get();
      expect(row).toMatchObject({ status: "failed" });
      expect(row?.error).toContain("the telemetry purge is down");
    } finally {
      failing.telemetryPurge = false;
    }
  });

  test("the daily checks find a delivered order without its cost-of-goods posting, and close the finding once it is posted", async () => {
    expect(CONSISTENCY_CHECKS.map((check) => check.key)).toContain("money.missing_cogs");
    const product = await make.product({ priceIqd: 40_000 });
    const order = await make.order([{ ...product, qty: 2 }], { status: "delivered", deliveredAt: NOW - HOUR });
    await t.db.insert(stockMovements).values({ id: `smv_cogs_${randomToken(6)}`, variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -2, reservedDelta: 0, unitCostIqd: 30_000, refType: "order", refId: order.orderId, actorKind: "system", at: NOW - HOUR });
    // an order whose goods had no known cost posts nothing and is no finding
    const uncosted = await make.order([{ ...product, qty: 1 }], { status: "delivered", deliveredAt: NOW - HOUR });
    await t.db.insert(stockMovements).values({ id: `smv_cogs_${randomToken(6)}`, variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -1, reservedDelta: 0, unitCostIqd: null, refType: "order", refId: uncosted.orderId, actorKind: "system", at: NOW - HOUR });

    const first = await runJob(t.db, "consistency.daily", NOW);
    expect(first.status).toBe("succeeded");
    const fingerprint = `money.missing_cogs|order|${order.orderId}`;
    expect(await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.fingerprint, fingerprint)).get()).toMatchObject({ checkKey: "money.missing_cogs", status: "open", severity: "critical", details: { ref: order.ref, cogsIqd: 60_000 } });
    expect(await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.fingerprint, `money.missing_cogs|order|${uncosted.orderId}`)).get()).toBeUndefined();

    await runBatch(t.db, postCogs(t.db, { at: NOW, createdBy: null, isDemo: false, orderId: order.orderId, ref: order.ref, cogsIqd: 60_000 }));
    await runJob(t.db, "consistency.daily", NOW + DAY);
    expect((await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.fingerprint, fingerprint)).get())?.status).toBe("resolved");
  });

  test("retention deletes staff password links a month after they stopped working", async () => {
    const employeeId = await make.employee();
    const old = NOW - (RETENTION_DAYS.passwordLinks + 1) * DAY;
    await t.db.insert(employeePasswordLinks).values([
      { idHash: `old_${randomToken(8)}`, employeeId, purpose: "welcome", createdAt: old - DAY, expiresAt: old },
      { idHash: `used_${randomToken(8)}`, employeeId, purpose: "welcome", createdAt: old - DAY, expiresAt: NOW + DAY, usedAt: old },
      { idHash: `live_${randomToken(8)}`, employeeId, purpose: "reset", createdAt: NOW, expiresAt: NOW + DAY },
    ]);
    const run = await runJob(t.db, "retention", NOW);
    expect(run.status).toBe("succeeded");
    expect(Number(run.stats.passwordLinks)).toBeGreaterThanOrEqual(2);
    expect((await t.db.select({ purpose: employeePasswordLinks.purpose }).from(employeePasswordLinks).where(eq(employeePasswordLinks.employeeId, employeeId))).map((row) => row.purpose)).toEqual(["reset"]);
  });
});

// ───────────────────────────────────────────────────────────────── auth core: staff accounts

describe("staff accounts: createEmployee, the one-time password link, enableEmployee", () => {
  test("a new employee gets no password, their roles and a link that works once — shown to the creator, never stored or audited", async () => {
    const owner = await builtIn("owner");
    const created = await createEmployee(t.db, owner.actor, { email: "  New.Hire@Platform.Test ", name: "موظف جديد", roleIds: [roleId("cashier")], jobTitle: "أمين صندوق", reason: "تعيين جديد" }, NOW);
    expect(created.link.path).toBe(`${PASSWORD_LINK_PATH}#${created.link.token}`);
    expect(created.link).toMatchObject({ purpose: "welcome", expiresAt: NOW + 72 * HOUR });
    const row = await t.db.select().from(employees).where(eq(employees.id, created.employeeId)).get();
    expect(row).toMatchObject({ email: "new.hire@platform.test", status: "active", passwordHash: null, jobTitle: "أمين صندوق" });
    expect(await t.db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(eq(employeeRoles.employeeId, created.employeeId))).toEqual([{ roleId: roleId("cashier") }]);
    // only the hash is kept, and no audit event carries the token
    const stored = await t.db.select().from(employeePasswordLinks).where(eq(employeePasswordLinks.employeeId, created.employeeId));
    expect(stored).toHaveLength(1);
    expect(stored[0].idHash).not.toContain(created.link.token);
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, created.employeeId));
    expect(events.map((event) => event.action)).toEqual(["staff.employee.create"]);
    expect(JSON.stringify(events)).not.toContain(created.link.token);

    // no password yet: nobody signs in to it
    expect(await failure(() => signInEmployee(request().ctx, t.db, { email: "new.hire@platform.test", password: "anything-at-all-123" }))).toMatchObject({ code: "invalid_credentials" });
    expect(await checkPasswordLink(t.db, created.link.token, NOW + HOUR)).toMatchObject({ name: "موظف جديد", email: "new.hire@platform.test", purpose: "welcome" });
    expect(await failure(() => setPasswordWithLink(t.db, { token: created.link.token, password: "short" }, NOW + HOUR, { ip: "203.0.113.9", userAgent: null }))).toMatchObject({ code: "invalid" });
    await setPasswordWithLink(t.db, { token: created.link.token, password: "the-new-hire-password" }, NOW + HOUR, { ip: "203.0.113.9", userAgent: null });
    const signed = await signInEmployee(request({ now: NOW + 2 * HOUR }).ctx, t.db, { email: "new.hire@platform.test", password: "the-new-hire-password" });
    expect(signed.status).toBe("signed_in");
    // once only
    expect(await failure(() => setPasswordWithLink(t.db, { token: created.link.token, password: "another-password-123" }, NOW + 3 * HOUR, { ip: "203.0.113.9", userAgent: null }))).toEqual({ code: "password_link_invalid", status: 410 });
    expect(await checkPasswordLink(t.db, created.link.token, NOW + 3 * HOUR)).toBeNull();
    expect(await t.db.select({ action: auditEvents.action, actorId: auditEvents.actorId }).from(auditEvents).where(and(eq(auditEvents.entityId, created.employeeId), eq(auditEvents.action, "security.password.set_with_link")))).toEqual([
      { action: "security.password.set_with_link", actorId: created.employeeId },
    ]);
  });

  test("giving a role needs everything it grants; the same email twice is refused; a branch-limited manager hires for their branch", async () => {
    const hr = await employeeWith(["staff.manage", "pos.sale.create", "dashboard.overview.read", "dashboard.search.use"]);
    expect(await failure(() => createEmployee(t.db, hr.actor, { email: "x1@platform.test", name: "مدير", roleIds: [roleId("manager")], reason: "تعيين جديد" }, NOW))).toEqual({ code: "grant_exceeds_own", status: 403 });
    expect(await failure(() => createEmployee(t.db, hr.actor, { email: "x2@platform.test", name: "مالك", roleIds: [roleId("owner")], reason: "تعيين جديد" }, NOW))).toEqual({ code: "grant_exceeds_own", status: 403 });
    expect(await t.db.select().from(employees).where(inArray(employees.email, ["x1@platform.test", "x2@platform.test"]))).toEqual([]);
    const ownRole = await employeeWith(["pos.sale.create"]);
    await createEmployee(t.db, hr.actor, { email: "x3@platform.test", name: "بائع", roleIds: [ownRole.roleId], reason: "تعيين جديد" }, NOW);
    expect(await failure(() => createEmployee(t.db, hr.actor, { email: "X3@platform.test", name: "بائع آخر", roleIds: [ownRole.roleId], reason: "تعيين جديد" }, NOW))).toEqual({ code: "email_taken", status: 409 });
    expect(await failure(() => createEmployee(t.db, { ...hr.actor, permissions: new Set(["pos.sale.create"]) }, { email: "x4@platform.test", name: "بائع", roleIds: [ownRole.roleId], reason: "تعيين جديد" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failure(() => createEmployee(t.db, { ...hr.actor, branchId: "brn_a" }, { email: "x5@platform.test", name: "بائع", roleIds: [ownRole.roleId], branchId: "brn_b", reason: "تعيين جديد" }, NOW))).toMatchObject({ code: "forbidden", status: 403 });
  });

  test("a new link for someone needs everything they hold and replaces the older one; enabling an account follows the same rule", async () => {
    const owner = await builtIn("owner");
    const manager = await builtIn("manager");
    const hr = await employeeWith(["staff.manage", "pos.sale.create"]);
    const seller = await employeeWith(["pos.sale.create"]);
    expect(await failure(() => issuePasswordLink(t.db, hr.actor, { employeeId: manager.id, reason: "نسي كلمة المرور" }, NOW))).toEqual({ code: "target_more_privileged", status: 403 });
    expect(await failure(() => issuePasswordLink(t.db, hr.actor, { employeeId: hr.id, reason: "نسي كلمة المرور" }, NOW))).toMatchObject({ code: "own_account_here" });
    const first = await issuePasswordLink(t.db, hr.actor, { employeeId: seller.id, reason: "نسي كلمة المرور" }, NOW);
    const second = await issuePasswordLink(t.db, hr.actor, { employeeId: seller.id, reason: "نسي كلمة المرور مرة أخرى" }, NOW + MINUTE);
    expect(second.link.purpose).toBe("reset");
    expect(await checkPasswordLink(t.db, first.link.token, NOW + 2 * MINUTE)).toBeNull();
    expect(await checkPasswordLink(t.db, second.link.token, NOW + 2 * MINUTE)).not.toBeNull();
    // the reset signs the employee out everywhere
    const live = request({ now: NOW + 2 * MINUTE });
    await signInEmployee(live.ctx, t.db, { email: seller.email, password: seller.password });
    await setPasswordWithLink(t.db, { token: second.link.token, password: "a-brand-new-password" }, NOW + 3 * MINUTE, { ip: null, userAgent: null });
    expect(await getEmployee(request({ now: NOW + 4 * MINUTE, cookies: { tt_adm: adminCookie(live.setCookies)! } }).ctx, t.db)).toBeNull();

    // enabling: only a disabled account, only by someone who holds everything it holds
    await t.db.update(employees).set({ status: "disabled", disabledAt: NOW }).where(inArray(employees.id, [seller.id, manager.id]));
    expect(await failure(() => enableEmployee(t.db, hr.actor, { employeeId: manager.id, reason: "عاد إلى العمل" }, NOW))).toEqual({ code: "target_more_privileged", status: 403 });
    const enabled = await enableEmployee(t.db, hr.actor, { employeeId: seller.id, reason: "عاد إلى العمل", newPasswordLink: true }, NOW);
    expect(enabled).toMatchObject({ enabled: true, link: { purpose: "reset" } });
    expect((await t.db.select({ status: employees.status, disabledAt: employees.disabledAt }).from(employees).where(eq(employees.id, seller.id)).get())).toEqual({ status: "active", disabledAt: null });
    expect(await failure(() => enableEmployee(t.db, hr.actor, { employeeId: seller.id, reason: "مرة ثانية" }, NOW))).toEqual({ code: "employee_already_active", status: 409 });
    await enableEmployee(t.db, owner.actor, { employeeId: manager.id, reason: "عاد إلى العمل" }, NOW);
    expect(await t.db.select({ action: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.entityId, seller.id), eq(auditEvents.action, "staff.employee.enable")))).toHaveLength(1);
  });
});

describe("the hierarchy rule on ending someone else's sessions", () => {
  test("ending a stronger employee's sessions is refused in the auth core — module 20's screens included; one's own and a weaker one's work", async () => {
    const guard = await employeeWith(["security.session.read", "security.session.revoke"]);
    const owner = await builtIn("owner");
    const cashier = await employeeWith(["security.session.read"]);
    const ownerDevice = request();
    await signInEmployee(ownerDevice.ctx, t.db, { email: owner.email, password: owner.password });
    const ownerSession = (await getEmployee(request({ cookies: { tt_adm: adminCookie(ownerDevice.setCookies)! } }).ctx, t.db))!.session.id;

    expect(await failure(() => revokeEmployeeSession(t.db, guard.actor, { employeeId: owner.id, sessionId: ownerSession, reason: "خروج" }, NOW))).toEqual({ code: "target_more_privileged", status: 403 });
    expect(await failure(() => revokeAllEmployeeSessions(t.db, guard.actor, { employeeId: owner.id, reason: "خروج" }, NOW))).toEqual({ code: "target_more_privileged", status: 403 });
    expect(await failure(() => endStaffSession(t.db, guard.actor, { employeeId: owner.id, sessionId: ownerSession, reason: "خروج الجميع" }, NOW))).toEqual({ code: "target_more_privileged", status: 403 });
    expect(await failure(() => endAllStaffSessions(t.db, guard.actor, { employeeId: owner.id, reason: "خروج الجميع" }, NOW))).toEqual({ code: "target_more_privileged", status: 403 });
    expect(await t.db.select({ revokedAt: employeeSessions.revokedAt }).from(employeeSessions).where(eq(employeeSessions.idHash, ownerSession)).get()).toEqual({ revokedAt: null });

    // a weaker employee's sessions end; and anyone ends their own
    const device = request();
    await signInEmployee(device.ctx, t.db, { email: cashier.email, password: cashier.password });
    await endAllStaffSessions(t.db, guard.actor, { employeeId: cashier.id, reason: "جهاز مفقود" }, NOW);
    expect(await getEmployee(request({ now: NOW + MINUTE, cookies: { tt_adm: adminCookie(device.setCookies)! } }).ctx, t.db)).toBeNull();
    await revokeAllEmployeeSessions(t.db, owner.actor, { employeeId: owner.id }, NOW);
  });
});

describe("two-step verification required per role", () => {
  test("switched per role by security.mfa.manage, only for a role whose permissions one holds all; audited; no change, no write", async () => {
    const securityLead = await employeeWith(["security.mfa.manage", "pos.sale.create"]);
    const tills = await employeeWith(["pos.sale.create"]);
    expect(await failure(() => setRoleTwoStepRequired(t.db, securityLead.actor, { roleId: roleId("manager"), required: true, reason: "سياسة جديدة" }, NOW))).toEqual({ code: "target_more_privileged", status: 403 });
    expect(await failure(() => setRoleTwoStepRequired(t.db, tills.actor, { roleId: tills.roleId, required: true, reason: "سياسة جديدة" }, NOW))).toMatchObject({ code: "forbidden" });
    const switched = await setRoleTwoStepRequired(t.db, securityLead.actor, { roleId: tills.roleId, required: true, reason: "سياسة جديدة" }, NOW);
    expect(switched).toMatchObject({ changed: true, required: true, members: 1, membersWithoutTwoStep: 1 });
    expect(await setRoleTwoStepRequired(t.db, securityLead.actor, { roleId: tills.roleId, required: true, reason: "مرة ثانية" }, NOW)).toMatchObject({ changed: false });
    expect(await t.db.select({ action: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.entityId, tills.roleId), eq(auditEvents.action, "security.role.two_step")))).toHaveLength(1);
    expect(await roleTwoStep(t.db, tills.roleId)).toMatchObject({ required: true });
  });

  test("a member without it signs in to an enrolment-only session: no permission, every page sends them to My security, enrolling opens the admin, turning it off is refused", async () => {
    const owner = await builtIn("owner");
    const member = await employeeWith(["orders.order.read", "pos.sale.create"]);
    await setRoleTwoStepRequired(t.db, owner.actor, { roleId: member.roleId, required: true, reason: "سياسة الدور" }, NOW);

    const device = request();
    expect((await signInEmployee(device.ctx, t.db, { email: member.email, password: member.password })).status).toBe("signed_in");
    const cookies = { tt_adm: adminCookie(device.setCookies)! };
    const session = (await getEmployee(request({ cookies }).ctx, t.db))!;
    expect(session.restriction).toBe("mfa_enrolment");
    expect([...session.actor.permissions]).toEqual([]);
    // a module page: a document redirect to the two-step setup; My security opens
    const redirected = await thrown(() => requireEmployee(request({ cookies }).ctx, t.db, "orders.order.read"));
    expect((redirected as Response).headers.get("Location")).toBe(MFA_ENROLMENT_PATH);
    expect((await requireEmployee(request({ cookies }).ctx, t.db, undefined, { allowEnrolment: true })).restriction).toBe("mfa_enrolment");
    // through the gate (the root middleware reads the real clock: a second sign-in, now)
    const browser = request({ now: Date.now() });
    await signInEmployee(browser.ctx, t.db, { email: member.email, password: member.password });
    const now = { tt_adm: adminCookie(browser.setCookies)! };
    const gated = await throughGate({ pattern: "/admin/orders", cookies: now });
    expect(gated.reached).toBe(false);
    expect((gated.result as Response).headers.get("Location")).toBe(MFA_ENROLMENT_PATH);
    expect((await throughGate({ pattern: "/admin/me", cookies: now })).reached).toBe(true);
    // the shell shows nothing to act on, only the two-step notice
    const waiting = await loadWaiting(t.db, session, NOW);
    expect(waiting.queues).toEqual([]);
    expect(waiting.notices.map((notice) => notice.id)).toEqual(["mfa_off"]);

    // enrolling (within 15 minutes of the password, no second typing) turns it into a full session
    const enrolling = request({ cookies, now: NOW + MINUTE });
    const { secret } = await beginTotpEnrollment(enrolling.ctx, t.db, secrets, {});
    const confirming = request({ cookies, now: NOW + 2 * MINUTE });
    await confirmTotpEnrollment(confirming.ctx, t.db, { code: await totpCode(secret, NOW + 2 * MINUTE) }, secrets);
    const full = (await getEmployee(request({ cookies: { tt_adm: adminCookie(confirming.setCookies)! }, now: NOW + 3 * MINUTE }).ctx, t.db))!;
    expect(full.restriction).toBeUndefined();
    expect(full.actor.permissions.has("orders.order.read")).toBe(true);
    // the role requires it: turning it off is refused
    const off = request({ cookies: { tt_adm: adminCookie(confirming.setCookies)! }, now: NOW + 3 * MINUTE + 31_000 });
    expect(await failure(async () => disableOwnTotp(off.ctx, t.db, { password: member.password, code: await totpCode(secret, NOW + 3 * MINUTE + 31_000) }, secrets))).toEqual({ code: "mfa_required_by_role", status: 409 });
  });

  test("a requirement switched on later applies at the member's next click", async () => {
    const owner = await builtIn("owner");
    const member = await employeeWith(["orders.order.read"]);
    const device = request();
    await signInEmployee(device.ctx, t.db, { email: member.email, password: member.password });
    const cookies = { tt_adm: adminCookie(device.setCookies)! };
    expect((await getEmployee(request({ cookies }).ctx, t.db))!.restriction).toBeUndefined();
    await setRoleTwoStepRequired(t.db, owner.actor, { roleId: member.roleId, required: true, reason: "سياسة الدور" }, NOW);
    expect((await getEmployee(request({ cookies, now: NOW + MINUTE }).ctx, t.db))!.restriction).toBe("mfa_enrolment");
  });
});

describe("error keys of the auth core", () => {
  test("target_more_privileged and the other staff-account codes are core keys with texts in Arabic, English and Sorani", () => {
    for (const key of ["target_more_privileged", "grant_exceeds_own", "own_account_here", "email_taken", "employee_already_active", "password_link_invalid", "mfa_required_by_role"]) {
      expect(CORE_ERROR_KEYS as readonly string[], key).toContain(key);
      for (const locale of ["ar", "en", "ckb"] as const) {
        const text = (errorsMessages[locale].errors as Record<string, unknown>)[key];
        expect(typeof text === "string" && text.length > 10, `${locale} ${key}`).toBe(true);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── entry.server

describe("entry.server handleError → the operations module's error log", () => {
  test("a server error is recorded once, scrubbed, with its route pattern and page path — after the response, inside waitUntil", async () => {
    expect(routePatternOf("/admin/ops/consistency/cfd_123", { findingId: "cfd_123" })).toBe("/admin/ops/consistency/:findingId");
    const context = new RouterContextProvider();
    const req = new Request("http://localhost:5173/admin/orders/TT-ABC123.data?token=secret-value");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    waited.promises.length = 0;
    try {
      handleError(new Error("the orders loader broke for +9647701234567 (test)"), { request: req, params: { ref: "TT-ABC123" }, context });
      expect(waited.promises).toHaveLength(1);
      await Promise.all(waited.promises);
    } finally {
      errors.mockRestore();
    }
    const row = await t.db.select().from(errorReports).where(eq(errorReports.route, "/admin/orders/:ref")).get();
    expect(row).toMatchObject({ source: "server", level: "error", url: "/admin/orders/TT-ABC123", count: 1 });
    expect(row?.message).toContain("the orders loader broke");
    expect(row?.message).not.toContain("+9647701234567");
    expect(row?.sample).toMatchObject({ status: 500, phase: "loader" });
  });

  test("aborted requests and the app's own answers (thrown Responses, data()) are not recorded", async () => {
    const before = (await t.db.select({ id: errorReports.id }).from(errorReports)).length;
    const controller = new AbortController();
    controller.abort();
    waited.promises.length = 0;
    handleError(new Error("aborted (test)"), { request: new Request("http://localhost:5173/admin", { signal: controller.signal }), params: {}, context: new RouterContextProvider() });
    handleError(new Response(null, { status: 404 }), { request: new Request("http://localhost:5173/admin/x"), params: {}, context: new RouterContextProvider() });
    handleError({ type: "DataWithResponseInit", data: { error: "forbidden" }, init: { status: 403 } }, { request: new Request("http://localhost:5173/admin/y"), params: {}, context: new RouterContextProvider() });
    expect(waited.promises).toEqual([]);
    expect((await t.db.select({ id: errorReports.id }).from(errorReports)).length).toBe(before);
  });

  test("a report that cannot be written is logged, never thrown", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { getDb } = await import("~/server/db.server");
      const failing = vi.spyOn(getDb(), "insert").mockImplementation(() => {
        throw new Error("the database is down (test)");
      });
      try {
        await expect(recordServerError(new Error("x (test)"), { request: new Request("http://localhost:5173/admin"), params: {}, context: new RouterContextProvider() })).resolves.toBeUndefined();
      } finally {
        failing.mockRestore();
      }
    } finally {
      errors.mockRestore();
    }
  });
});
