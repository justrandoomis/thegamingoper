/**
 * Admin module 23 "ops" (technical operations) — services against a real local D1:
 *
 *   · authorization per role (owner, manager, finance, cashier, support, custom roles) on every service
 *   · 23.03 jobs: health from job_runs (never, ok, failing with its streak, late, stuck), the cron arithmetic, the cron
 *     list equals wrangler.jsonc, run now once per form (idempotent, audited, refused while running), the impact
 *     preview, counters with cost keys cut; the outbox with recipients masked and no payload
 *   · 23.06 consistency: real findings from the daily job, filters, numbers of cost checks withheld (also from search)
 *     without cost.read, give to a person (a staff task, acknowledged), close as resolved / false positive with a
 *     reason (never touching the data checked), the job opening a "resolved" problem that is still there again and
 *     leaving a false positive closed, reopen, bulk limits
 *   · 23.05 incidents: INC refs from the counter, idempotent creation, owner (who may read incidents) and target day as
 *     the owner's task, links kept by id (finding, run, error), status moves against the status the form saw, resolve
 *     with the resolution time and the post-mortem, reopen, owner / severity / details changes, views
 *   · 23.01 / 23.02 telemetry: scrubbed and grouped errors, reopen on recurrence, the isolate budget, slow / failed
 *     samples only, the per-route view, retention
 *   · 23.04 backups: the monitor reads module 20's evidence, never records it
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { auditEvents, consistencyFindings, employeeRoles, errorReports, incidents, jobRuns, outbox, perfRollups, rolePermissions, roles, staffTasks, stockLevels } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { JOB_NAMES, SCHEDULES, runJob } from "~/server/jobs.server";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { recordRestoreTest } from "~/server/services/admin/security/backups.server";
import { assignFindings, closeFindings, findingCounts, getFinding, listFindings, reopenFinding } from "~/server/services/admin/ops/consistency.server";
import {
  addIncidentUpdate,
  changeIncidentOwner,
  changeIncidentSeverity,
  createIncident,
  editIncident,
  getIncident,
  incidentCounts,
  linkToIncident,
  listIncidents,
  reopenIncident,
  resolveIncident,
  unlinkFromIncident,
} from "~/server/services/admin/ops/incidents.server";
import { cronPeriod, getRun, jobPreview, jobsOverview, listOutbox, listRuns, maskRecipient, nextCronRun, outboxOverview, runJobNow } from "~/server/services/admin/ops/job-monitor.server";
import { backupsMonitor, opsOverview, opsQueueCounts } from "~/server/services/admin/ops/overview.server";
import { cutProtected } from "~/server/services/admin/ops/shared.server";
import {
  ISOLATE_WRITES_PER_MINUTE,
  deviceOf,
  getErrorReport,
  listErrors,
  pathOf,
  performanceView,
  purgeOpsTelemetry,
  recordError,
  recordPerfSample,
  resetTelemetryBudget,
  scrubText,
  setErrorStatus,
} from "~/server/services/admin/ops/telemetry.server";
import { DAY_MS, HOUR_MS, MINUTE_MS, OPS_ERROR_KEYS, addDays, baghdadDay, baghdadDayEnd, parseErrorFilters, parseFindingFilters, parseIncidentFilters, parseOutboxFilters, parsePerfFilters, parseRunFilters, toBaghdadInput } from "~/server/services/admin/ops/types";
import opsMessages from "~/i18n/messages/admin-ops";
import sharedErrors from "~/i18n/messages/errors";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor };
const people: Record<string, Person> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "cashier", "support", "inventory"] as const) people[role] = await person(role);
  people.manager2 = await person("manager");
  // ops readers without cost.read: the numbers of cost checks and cost counters must not reach them
  people.opsReader = await person(["ops.consistency.read", "ops.job.read", "ops.error.read", "ops.incident.read"]);
  people.opsResolver = await person(["ops.consistency.read", "ops.consistency.resolve"]);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});
beforeEach(() => resetTelemetryBudget());

async function person(role: DefaultRoleKey | Permission[]): Promise<Person> {
  const id = await make.employee({ name: Array.isArray(role) ? `custom ${role.length}` : role });
  if (Array.isArray(role)) {
    const custom = `role_${make.next("ops").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, actor: { kind: "employee", id, permissions: new Set<string>(role), label: "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const permissions = role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  return { id, actor: { kind: "employee", id, permissions, label: role } };
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
const fieldOf = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.fields ?? {};
const key = () => `${make.next("key")}-0123456789abcdef`;

async function finding(values: Partial<typeof consistencyFindings.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? newId("cfd");
  await t.db.insert(consistencyFindings).values({
    id,
    fingerprint: `${values.checkKey ?? "orders.totals_vs_items"}|test|${id}`,
    checkKey: "orders.totals_vs_items",
    severity: "critical",
    entityType: "order",
    entityId: id,
    message: "Order X: subtotal 100 IQD but its lines add up to 90 IQD.",
    details: { subtotalIqd: 100, linesIqd: 90 },
    status: "open",
    detectedAt: NOW - HOUR_MS,
    lastSeenAt: NOW - HOUR_MS,
    ...values,
  });
  return id;
}

async function run(job: string, values: Partial<typeof jobRuns.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? newId("job");
  await t.db.insert(jobRuns).values({ id, job, status: "succeeded", origin: "cron", startedAt: NOW - MINUTE_MS, finishedAt: NOW - MINUTE_MS + 10, durationMs: 10, stats: {}, ...values });
  return id;
}

// ───────────────────────────────────────────────────────────────── authorization

describe("authorization", () => {
  test("every service refuses a role without its permission, before reading the input", async () => {
    const cashier = people.cashier.actor;
    const support = people.support.actor;
    expect(await code(() => jobsOverview(t.db, cashier, NOW))).toBe("forbidden");
    expect(await code(() => listRuns(t.db, support, parseRunFilters(new URLSearchParams())))).toBe("forbidden");
    expect(await code(() => runJobNow(t.db, people.finance.actor, {}, NOW))).toBe("forbidden");
    expect(await code(() => listOutbox(t.db, cashier, parseOutboxFilters(new URLSearchParams())))).toBe("forbidden");
    expect(await code(() => listFindings(t.db, cashier, parseFindingFilters(new URLSearchParams())))).toBe("forbidden");
    expect(await code(() => assignFindings(t.db, people.finance.actor, {}, NOW))).toBe("forbidden");
    expect(await code(() => closeFindings(t.db, people.opsReader.actor, {}, NOW))).toBe("forbidden");
    expect(await code(() => listIncidents(t.db, people.finance.actor, parseIncidentFilters(new URLSearchParams()), NOW))).toBe("forbidden");
    expect(await code(() => createIncident(t.db, people.opsReader.actor, {}, NOW))).toBe("forbidden");
    expect(await code(() => listErrors(t.db, people.inventory.actor, parseErrorFilters(new URLSearchParams()), NOW))).toBe("forbidden");
    expect(await code(() => setErrorStatus(t.db, people.opsReader.actor, {}, NOW))).toBe("forbidden");
    expect(await code(() => performanceView(t.db, people.finance.actor, parsePerfFilters(new URLSearchParams()), NOW))).toBe("forbidden");
    expect(await code(() => backupsMonitor(t.db, people.finance.actor, NOW))).toBe("forbidden");
    // what the default roles may open: finance reads findings only, the manager everything
    expect((await listFindings(t.db, people.finance.actor, parseFindingFilters(new URLSearchParams()))).rows).toBeDefined();
    expect((await jobsOverview(t.db, people.manager.actor, NOW)).jobs.length).toBeGreaterThanOrEqual(JOB_NAMES.length);
    expect((await listIncidents(t.db, people.manager.actor, parseIncidentFilters(new URLSearchParams()), NOW)).rows).toBeDefined();
  });

  test("the front page and the bell carry only what each employee may see", async () => {
    const finance = await opsOverview(t.db, people.finance.actor, NOW);
    expect(finance.jobs).toBeNull();
    expect(finance.incidents).toBeNull();
    expect(finance.errors).toBeNull();
    expect(finance.findings).not.toBeNull();
    const cashier = await opsOverview(t.db, people.cashier.actor, NOW);
    expect([cashier.jobs, cashier.outbox, cashier.findings, cashier.incidents, cashier.errors, cashier.performance, cashier.backups].every((part) => part === null)).toBe(true);
    expect(await opsQueueCounts(t.db, people.finance.actor, NOW)).toEqual({ criticalFindings: null, failingJobs: null, overdueIncidents: null });
    const manager = await opsQueueCounts(t.db, people.manager.actor, NOW);
    expect(typeof manager.criticalFindings).toBe("number");
    expect(typeof manager.failingJobs).toBe("number");
  });

  test("every error code of the module has a text in ar, en and ckb", () => {
    const textOf = (tree: unknown, locale: string, name: string) => ((tree as Record<string, { errors?: Record<string, unknown> }>)[locale]?.errors ?? {})[name];
    for (const locale of ["ar", "en", "ckb"]) {
      for (const name of OPS_ERROR_KEYS) expect(textOf(opsMessages, locale, name) ?? textOf(sharedErrors, locale, name), `${locale} ${name}`).toEqual(expect.any(String));
    }
  });
});

// ───────────────────────────────────────────────────────────────── 23.03 jobs and the queue

describe("23.03 jobs", () => {
  test("the cron arithmetic: next run and period of the two schedules, in UTC as Cloudflare fires them", () => {
    const at = Date.UTC(2026, 10, 10, 6, 2, 30);
    expect(nextCronRun("*/5 * * * *", at)).toBe(Date.UTC(2026, 10, 10, 6, 5, 0));
    expect(nextCronRun("30 0 * * *", at)).toBe(Date.UTC(2026, 10, 11, 0, 30, 0));
    expect(nextCronRun("30 0 * * *", Date.UTC(2026, 10, 10, 0, 10))).toBe(Date.UTC(2026, 10, 10, 0, 30));
    expect(cronPeriod("*/5 * * * *", at)).toBe(5 * MINUTE_MS);
    expect(cronPeriod("30 0 * * *", at)).toBe(DAY_MS);
    expect(nextCronRun("0 0 1 * *", at)).toBeNull();
  });

  test("the schedules the screens show are exactly the crons wrangler.jsonc triggers", () => {
    const text = readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
    const crons = JSON.parse(/"crons"\s*:\s*(\[[^\]]*\])/.exec(text)?.[1] ?? "[]") as string[];
    expect([...crons].sort()).toEqual(Object.keys(SCHEDULES).sort());
  });

  test("health from the runs: never, ok, failing (with the streak), late, stuck", async () => {
    let view = await jobsOverview(t.db, people.manager.actor, NOW);
    expect(view.jobs.find((job) => job.job === "catalog.publish_due")?.health).toBe("never");
    await run("catalog.publish_due", { startedAt: NOW - 2 * MINUTE_MS });
    view = await jobsOverview(t.db, people.manager.actor, NOW);
    const publish = view.jobs.find((job) => job.job === "catalog.publish_due");
    expect(publish?.health).toBe("ok");
    expect(publish?.cadence).toBe("frequent");
    expect(publish?.nextDueAt).toBe(nextCronRun("*/5 * * * *", NOW));
    // late: a frequent job that has not run for an hour (its trigger stopped firing)
    await run("ratelimits.cleanup", { startedAt: NOW - 30 * HOUR_MS });
    await run("inventory.reservations.expire", { startedAt: NOW - HOUR_MS });
    view = await jobsOverview(t.db, people.manager.actor, NOW);
    expect(view.jobs.find((job) => job.job === "inventory.reservations.expire")?.health).toBe("late");
    expect(view.jobs.find((job) => job.job === "ratelimits.cleanup")?.health).toBe("late");
    // failing twice in a row after a success
    await run("orders.expire_unpaid", { startedAt: NOW - 20 * MINUTE_MS });
    await run("orders.expire_unpaid", { startedAt: NOW - 10 * MINUTE_MS, status: "failed", error: "Error: boom" });
    await run("orders.expire_unpaid", { startedAt: NOW - 5 * MINUTE_MS, status: "failed", error: "Error: boom" });
    // stuck: a run that never recorded its end
    await run("audit.seal", { startedAt: NOW - 2 * HOUR_MS, status: "running", finishedAt: null, durationMs: null });
    view = await jobsOverview(t.db, people.manager.actor, NOW);
    const expire = view.jobs.find((job) => job.job === "orders.expire_unpaid");
    expect(expire?.health).toBe("failing");
    expect(expire?.streak).toBe(2);
    expect(expire?.failures7d).toBe(2);
    expect(expire?.lastSuccessAt).toBe(NOW - 20 * MINUTE_MS);
    expect(view.jobs.find((job) => job.job === "audit.seal")?.health).toBe("stuck");
    expect((await opsQueueCounts(t.db, people.owner.actor, NOW)).failingJobs).toBeGreaterThanOrEqual(3);
    const history = await listRuns(t.db, people.manager.actor, parseRunFilters(new URLSearchParams("job=orders.expire_unpaid&status=failed")));
    expect(history.total).toBe(2);
    expect(history.rows.every((row) => row.status === "failed" && row.job === "orders.expire_unpaid")).toBe(true);
  });

  test("counters a job reports lose their cost keys for an employee without cost.read", async () => {
    const id = await run("consistency.daily", { startedAt: NOW - 3 * HOUR_MS, stats: { released: 2, cogsIqd: 750_000, inventoryValueIqd: 1, nested: { marginBps: 1200, count: 3 } } });
    const reader = await getRun(t.db, people.opsReader.actor, id);
    expect(reader.run.stats).toEqual({ released: 2, nested: { count: 3 } });
    expect(reader.run.statsWithheld).toBe(true);
    expect(JSON.stringify(reader)).not.toContain("750000");
    const owner = await getRun(t.db, people.owner.actor, id);
    expect(owner.run.stats).toMatchObject({ cogsIqd: 750_000 });
    expect(cutProtected({ profitIqd: 1, costIqd: 2, a: 3 }, { cost: true, profit: false })).toEqual({ value: { costIqd: 2, a: 3 }, withheld: true });
  });

  test("run now: the job's own code, once per form, audited with the reason, refused while one is running", async () => {
    const manager = people.manager.actor;
    const form = key();
    const first = await runJobNow(t.db, manager, { job: "outbox.deliver", reason: "check the queue after the fix", idempotencyKey: form }, NOW);
    expect(first.replayed).toBe(false);
    expect(first.status).toBe("skipped"); // no message provider is configured
    const again = await runJobNow(t.db, manager, { job: "outbox.deliver", reason: "check the queue after the fix", idempotencyKey: form }, NOW + 1000);
    expect(again).toEqual({ runId: first.runId, status: "skipped", replayed: true });
    const runs = await t.db.select().from(jobRuns).where(and(eq(jobRuns.job, "outbox.deliver"), eq(jobRuns.origin, "manual")));
    expect(runs).toHaveLength(1);
    expect(runs[0].triggeredBy).toBe(people.manager.id);
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "ops.job.run"), eq(auditEvents.entityId, "outbox.deliver")));
    expect(audit).toHaveLength(1);
    expect(audit[0].reason).toBe("check the queue after the fix");
    expect(await code(() => runJobNow(t.db, manager, { job: "no.such_job", reason: "test", idempotencyKey: key() }, NOW))).toBe("job_unknown");
    expect(await fieldOf(() => runJobNow(t.db, manager, { job: "outbox.deliver", reason: "x", idempotencyKey: key() }, NOW))).toEqual({ reason: "reason_required" });
    await run("retention", { startedAt: NOW - MINUTE_MS, status: "running", finishedAt: null, durationMs: null });
    expect(await code(() => runJobNow(t.db, manager, { job: "retention", reason: "clean up now", idempotencyKey: key() }, NOW))).toBe("job_running");
  });

  test("run now of the daily checks records findings like the cron (origin manual)", async () => {
    const product = await make.product({ stock: 3 }); // a stock level written without its movement: a real inconsistency
    const outcome = await runJobNow(t.db, people.owner.actor, { job: "consistency.daily", reason: "after the stock import", idempotencyKey: key() }, NOW);
    expect(outcome.status).toBe("succeeded");
    const found = await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.entityId, `${product.variantId}@${DEFAULT_LOCATION_ID}`));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkKey: 'stock.levels_vs_movements', status: 'open', runId: outcome.runId });
  });

  test("the preview counts what a run would touch, read only", async () => {
    for (const job of JOB_NAMES) {
      const preview = await jobPreview(t.db, people.manager.actor, job, NOW);
      expect(preview.lines.length).toBeGreaterThan(0);
    }
    const checks = await jobPreview(t.db, people.manager.actor, "consistency.daily", NOW);
    expect(checks.changesData).toBe(false);
    expect((await jobPreview(t.db, people.manager.actor, "retention", NOW)).changesData).toBe(true);
  });

  test("the outbox: counts per status, recipients masked, never a payload", async () => {
    await t.db.insert(outbox).values([
      { id: newId("msg"), channel: "sms", recipient: "+9647701234567", template: "order_confirmed", payload: { ref: "TT-SECRET", code: "991188" }, status: "held", createdAt: NOW - HOUR_MS },
      { id: newId("msg"), channel: "email", recipient: "zahra.ali@example.com", template: "otp", payload: { code: "123456" }, status: "failed", lastError: "550 mailbox", attempts: 3, createdAt: NOW - 2 * HOUR_MS },
    ]);
    const overview = await outboxOverview(t.db, people.manager.actor);
    expect(overview.held).toBeGreaterThanOrEqual(1);
    expect(overview.failed).toBeGreaterThanOrEqual(1);
    const page = await listOutbox(t.db, people.manager.actor, parseOutboxFilters(new URLSearchParams()));
    const json = JSON.stringify(page);
    expect(json).not.toContain("7701234567");
    expect(json).not.toContain("zahra.ali");
    expect(json).not.toContain("991188");
    expect(json).not.toContain("123456");
    expect(page.rows.find((row) => row.channel === "email")?.recipient).toBe("z•••@example.com");
    const held = await listOutbox(t.db, people.manager.actor, parseOutboxFilters(new URLSearchParams("status=held")));
    expect(held.rows.every((row) => row.status === "held")).toBe(true);
    expect(maskRecipient("07701234567")).toBe("0770 ••• ••67");
  });
});

// ───────────────────────────────────────────────────────────────── 23.06 consistency

describe("23.06 consistency", () => {
  test("filters and the numbers of cost checks withheld without cost.read — from the rows and from search", async () => {
    const journal = await finding({ checkKey: "journal.unbalanced_entries", entityType: "journal_entry", entityId: newId("jen"), message: "Journal entry does not balance: debit 734512 vs credit 0.", details: { debitIqd: 734_512, creditIqd: 0 } });
    const stock = await finding({ checkKey: "stock.levels_vs_movements", severity: "warning", entityType: "stock_level", entityId: "var_x@loc_y", details: { onHand: 4, movedQty: 3, reserved: 0, movedReserved: 0 }, message: "Stock level does not match its movements: on hand 4 vs 3, reserved 0 vs 0." });
    const reader = await listFindings(t.db, people.opsReader.actor, parseFindingFilters(new URLSearchParams("view=all")));
    const journalRow = reader.rows.find((row) => row.id === journal);
    expect(journalRow?.withheld).toBe(true);
    expect(journalRow?.details).toBeNull();
    expect(journalRow?.message).toBeNull();
    expect(JSON.stringify(reader)).not.toContain("734512");
    expect(reader.rows.find((row) => row.id === stock)?.details).toMatchObject({ onHand: 4, movedQty: 3 });
    expect((await getFinding(t.db, people.opsReader.actor, journal)).finding.details).toBeNull();
    // the job's sentence holds the numbers: searching them finds nothing without cost.read
    expect((await listFindings(t.db, people.opsReader.actor, parseFindingFilters(new URLSearchParams("view=all&q=734512")))).total).toBe(0);
    expect((await listFindings(t.db, people.owner.actor, parseFindingFilters(new URLSearchParams("view=all&q=734512")))).total).toBe(1);
    // filters
    const critical = await listFindings(t.db, people.owner.actor, parseFindingFilters(new URLSearchParams("severity=warning&check=stock.levels_vs_movements")));
    expect(critical.rows.every((row) => row.severity === "warning" && row.checkKey === "stock.levels_vs_movements")).toBe(true);
    expect(critical.rows.some((row) => row.id === stock)).toBe(true);
  });

  test("give a finding to a person: a task about it, acknowledged; again to another; same again changes nothing", async () => {
    const id = await finding();
    const manager = people.manager.actor;
    expect(await fieldOf(() => assignFindings(t.db, manager, { ids: [id], assigneeId: people.cashier.id }, NOW))).toEqual({ assigneeId: "assignee_invalid" });
    expect(await fieldOf(() => assignFindings(t.db, manager, { ids: [id], assigneeId: people.finance.id, dueDay: addDays(baghdadDay(NOW), -1) }, NOW))).toEqual({ dueDay: "due_invalid" });
    const day = addDays(baghdadDay(NOW), 2);
    expect(await assignFindings(t.db, manager, { ids: [id], assigneeId: people.finance.id, dueDay: day, note: "check the order lines" }, NOW)).toEqual({ assigned: 1, unchanged: 0 });
    let row = await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.id, id)).get();
    expect(row?.status).toBe("acknowledged");
    let tasks = await t.db.select().from(staffTasks).where(and(eq(staffTasks.refType, "consistency_finding"), eq(staffTasks.refId, id)));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assignedTo: people.finance.id, status: "open", dueAt: baghdadDayEnd(day), priority: "urgent" });
    expect(await assignFindings(t.db, manager, { ids: [id], assigneeId: people.finance.id, dueDay: day }, NOW)).toEqual({ assigned: 0, unchanged: 1 });
    await assignFindings(t.db, manager, { ids: [id], assigneeId: people.owner.id }, NOW + 1000);
    tasks = await t.db.select().from(staffTasks).where(and(eq(staffTasks.refType, "consistency_finding"), eq(staffTasks.refId, id)));
    expect(tasks.map((task) => task.status).sort()).toEqual(["cancelled", "open"]);
    const mine = await listFindings(t.db, people.owner.actor, parseFindingFilters(new URLSearchParams("assignee=me")));
    expect(mine.rows.some((entry) => entry.id === id && entry.assignee?.id === people.owner.id)).toBe(true);
    const none = await listFindings(t.db, people.owner.actor, parseFindingFilters(new URLSearchParams("assignee=none")));
    expect(none.rows.some((entry) => entry.id === id)).toBe(false);
    const history = (await getFinding(t.db, people.owner.actor, id)).history;
    expect(history.filter((event) => event.action === "ops.finding.assign")).toHaveLength(2);
    row = await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.id, id)).get();
    expect(row?.details).toEqual({ subtotalIqd: 100, linesIqd: 90 }); // the checked data is never touched
  });

  test("close with a reason; the job opens a resolved problem that is still there again and keeps a false positive closed", async () => {
    const product = await make.product({ stock: 2 });
    await runJob(t.db, "consistency.daily", NOW);
    const [found] = await t.db.select().from(consistencyFindings).where(sql`${consistencyFindings.entityId} LIKE ${`${product.variantId}@%`}`);
    expect(found?.checkKey).toBe("stock.levels_vs_movements");
    const resolver = people.opsResolver.actor;
    expect(await fieldOf(() => closeFindings(t.db, resolver, { ids: [found.id], outcome: "resolved", reason: "" }, NOW))).toEqual({ reason: "reason_required" });
    await assignFindings(t.db, people.owner.actor, { ids: [found.id], assigneeId: people.opsResolver.id }, NOW);
    expect(await closeFindings(t.db, resolver, { ids: [found.id], outcome: "resolved", reason: "counted the shelf: 2 units" }, NOW + 1000)).toEqual({ closed: 1, unchanged: 0 });
    expect(await closeFindings(t.db, resolver, { ids: [found.id], outcome: "resolved", reason: "counted the shelf: 2 units" }, NOW + 2000)).toEqual({ closed: 0, unchanged: 1 });
    expect(await code(() => closeFindings(t.db, resolver, { ids: [found.id], outcome: "false_positive", reason: "not a problem" }, NOW))).toBe("finding_not_open");
    const task = await t.db.select().from(staffTasks).where(and(eq(staffTasks.refType, "consistency_finding"), eq(staffTasks.refId, found.id))).get();
    expect(task?.status).toBe("done");
    let row = await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.id, found.id)).get();
    expect(row).toMatchObject({ status: "resolved", resolvedBy: people.opsResolver.id, resolutionNote: "counted the shelf: 2 units" });
    // still wrong in the data: the next daily run opens it again
    await runJob(t.db, "consistency.daily", NOW + DAY_MS);
    row = await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.id, found.id)).get();
    expect(row?.status).toBe("open");
    // a false positive stays closed
    await closeFindings(t.db, resolver, { ids: [found.id], outcome: "false_positive", reason: "opening stock of the demo shelf" }, NOW + DAY_MS + 1);
    await runJob(t.db, "consistency.daily", NOW + 2 * DAY_MS);
    row = await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.id, found.id)).get();
    expect(row?.status).toBe("false_positive");
    // the stock level itself was never changed by any of this
    expect((await t.db.select().from(stockLevels).where(eq(stockLevels.variantId, product.variantId)).get())?.onHand).toBe(2);
    // reopen a false positive with a reason
    expect(await code(() => reopenFinding(t.db, resolver, { id: found.id, reason: "x" }, NOW))).toBe("invalid");
    expect(await reopenFinding(t.db, resolver, { id: found.id, reason: "it was a real shortage" }, NOW + 2 * DAY_MS + 5)).toEqual({ replayed: false });
    expect(await reopenFinding(t.db, resolver, { id: found.id, reason: "it was a real shortage" }, NOW + 2 * DAY_MS + 6)).toEqual({ replayed: true });
    const actions = (await getFinding(t.db, people.owner.actor, found.id)).history.map((event) => event.action);
    expect(actions).toEqual(["ops.finding.assign", "ops.finding.resolve", "ops.finding.dismiss", "ops.finding.reopen"]);
  });

  test("bulk: at most 25, all or nothing, a finding changed meanwhile refuses the batch", async () => {
    const ids = await Promise.all(Array.from({ length: 26 }, () => finding({ severity: "info" })));
    expect(await fieldOf(() => closeFindings(t.db, people.owner.actor, { ids, outcome: "resolved", reason: "fixed upstream" }, NOW))).toEqual({ ids: "too_many" });
    expect(await fieldOf(() => closeFindings(t.db, people.owner.actor, { ids: [], outcome: "resolved", reason: "fixed upstream" }, NOW))).toEqual({ ids: "nothing_selected" });
    expect(await closeFindings(t.db, people.owner.actor, { ids: ids.slice(0, 25), outcome: "resolved", reason: "fixed upstream" }, NOW)).toEqual({ closed: 25, unchanged: 0 });
    expect(await code(() => closeFindings(t.db, people.owner.actor, { ids: ["cfd_missing"], outcome: "resolved", reason: "fixed upstream" }, NOW))).toBe("not_found");
    const counts = await findingCounts(t.db, people.owner.actor);
    expect(counts?.active).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────── 23.05 incidents

describe("23.05 incidents", () => {
  const today = () => baghdadDay(NOW);
  const base = () => ({ title: "Payments page slow", severity: "sev2", summary: "Staff report the proof queue takes 20 seconds.", ownerId: people.manager2.id, targetDay: addDays(today(), 1), idempotencyKey: key() });

  test("create: INC refs from the counter, once per form, owner as a task with the target day, links by id", async () => {
    const manager = people.manager.actor;
    expect(await fieldOf(() => createIncident(t.db, manager, { ...base(), ownerId: people.finance.id }, NOW))).toEqual({ ownerId: "owner_invalid" });
    expect(await fieldOf(() => createIncident(t.db, manager, { ...base(), targetDay: addDays(today(), -1) }, NOW))).toEqual({ targetDay: "target_invalid" });
    expect(await fieldOf(() => createIncident(t.db, manager, { ...base(), startedAt: toBaghdadInput(NOW + 2 * HOUR_MS) }, NOW))).toEqual({ startedAt: "started_invalid" });
    const findingId = await finding();
    const runId = await run("orders.expire_unpaid", { status: "failed", startedAt: NOW - 7 * MINUTE_MS, error: "Error: D1 timeout" });
    const error = await recordError(t.db, { source: "server", message: "D1_ERROR: timeout on proofs", route: "admin/orders/proofs" }, NOW);
    const input = { ...base(), startedAt: toBaghdadInput(NOW - HOUR_MS), links: [{ kind: "finding", id: findingId }, { kind: "run", id: runId }, { kind: "error", id: error.id! }] };
    const first = await createIncident(t.db, manager, input, NOW);
    expect(first.ref).toMatch(/^INC-\d{4}$/);
    expect(await createIncident(t.db, manager, input, NOW + 1000)).toEqual({ ...first, replayed: true });
    const second = await createIncident(t.db, manager, { ...base(), title: "Second" }, NOW);
    expect(Number(second.ref.slice(4))).toBe(Number(first.ref.slice(4)) + 1);
    const task = await t.db.select().from(staffTasks).where(and(eq(staffTasks.refType, "incident"), eq(staffTasks.refId, first.incidentId))).get();
    expect(task).toMatchObject({ assignedTo: people.manager2.id, status: "open", dueAt: baghdadDayEnd(addDays(today(), 1)), priority: "high" });
    expect(task?.title.startsWith(first.ref)).toBe(true);
    expect((await t.db.select().from(errorReports).where(eq(errorReports.id, error.id!)).get())?.incidentId).toBe(first.incidentId);
    const detail = await getIncident(t.db, people.opsReader.actor, first.ref, NOW);
    expect(detail.incident.owner?.id).toBe(people.manager2.id);
    expect(detail.incident.startedAt).toBe(NOW - HOUR_MS);
    expect(detail.links.map((link) => link.kind).sort()).toEqual(["error", "finding", "run"]);
    expect(detail.links.find((link) => link.kind === "run")?.state).toBe("failed");
    expect(detail.timeline[0]).toMatchObject({ kind: "update", status: "open" });
    // the finding and the run point back at it
    expect((await getFinding(t.db, people.owner.actor, findingId)).incidents.map((entry) => entry.ref)).toEqual([first.ref]);
    expect((await getRun(t.db, people.owner.actor, runId)).incidents.map((entry) => entry.ref)).toEqual([first.ref]);
    // an error already in another incident is refused
    expect(await code(() => createIncident(t.db, manager, { ...base(), links: [{ kind: "error", id: error.id! }] }, NOW))).toBe("link_exists");
    expect(await code(() => linkToIncident(t.db, manager, { incidentId: second.incidentId, kind: "error", id: error.id! }, NOW))).toBe("link_exists");
    expect(await code(() => linkToIncident(t.db, manager, { incidentId: second.incidentId, kind: "finding", id: "cfd_nope" }, NOW))).toBe("invalid");
  });

  test("status moves against what the form saw, resolve with the post-mortem, reopen, owner and severity", async () => {
    const manager = people.manager.actor;
    const { incidentId, ref } = await createIncident(t.db, manager, { ...base(), startedAt: toBaghdadInput(NOW - 3 * HOUR_MS) }, NOW);
    expect(await code(() => addIncidentUpdate(t.db, manager, { incidentId, note: "looking", status: "investigating", expectedStatus: "mitigated" }, NOW))).toBe("incident_changed");
    expect(await addIncidentUpdate(t.db, manager, { incidentId, note: "looking at the D1 metrics", status: "investigating", expectedStatus: "open" }, NOW + 1)).toEqual({ status: "investigating" });
    expect(await code(() => addIncidentUpdate(t.db, manager, { incidentId, note: "back", status: "open", expectedStatus: "investigating" }, NOW))).toBe("invalid");
    await addIncidentUpdate(t.db, manager, { incidentId, note: "index added, queue fast again", status: "mitigated", expectedStatus: "investigating" }, NOW + 2);
    expect(await fieldOf(() => resolveIncident(t.db, manager, { incidentId, rootCause: "short", expectedStatus: "mitigated" }, NOW))).toEqual({ rootCause: "postmortem_required" });
    expect(await fieldOf(() => resolveIncident(t.db, manager, { incidentId, rootCause: "A missing index on payment_proofs.status made the queue scan.", resolvedAt: toBaghdadInput(NOW - 4 * HOUR_MS), expectedStatus: "mitigated" }, NOW))).toEqual({ resolvedAt: "resolved_invalid" });
    expect(await resolveIncident(t.db, manager, { incidentId, rootCause: "A missing index on payment_proofs.status made the queue scan.", expectedStatus: "mitigated" }, NOW + 3)).toEqual({ replayed: false });
    expect(await resolveIncident(t.db, manager, { incidentId, rootCause: "A missing index on payment_proofs.status made the queue scan.", expectedStatus: "mitigated" }, NOW + 4)).toEqual({ replayed: true });
    let detail = await getIncident(t.db, manager, ref, NOW + 5);
    expect(detail.incident).toMatchObject({ status: "resolved", resolvedAt: NOW + 3, rootCause: expect.stringContaining("missing index") });
    expect(detail.incident.mitigatedAt).toBe(NOW + 2);
    expect((await t.db.select().from(staffTasks).where(and(eq(staffTasks.refType, "incident"), eq(staffTasks.refId, incidentId))).get())?.status).toBe("done");
    expect(await code(() => changeIncidentOwner(t.db, manager, { incidentId, ownerId: people.owner.id, targetDay: today(), reason: "handover" }, NOW))).toBe("incident_resolved");
    await reopenIncident(t.db, manager, { incidentId, reason: "slow again this morning", targetDay: addDays(today(), 2) }, NOW + 6);
    detail = await getIncident(t.db, manager, ref, NOW + 7);
    expect(detail.incident.status).toBe("investigating");
    expect(detail.incident.resolvedAt).toBeNull();
    expect(detail.incident.targetAt).toBe(baghdadDayEnd(addDays(today(), 2)));
    expect(await changeIncidentOwner(t.db, manager, { incidentId, ownerId: people.owner.id, targetDay: addDays(today(), 3), reason: "the owner takes it" }, NOW + 8)).toEqual({ changed: true });
    expect(await changeIncidentOwner(t.db, manager, { incidentId, ownerId: people.owner.id, targetDay: addDays(today(), 3), reason: "the owner takes it" }, NOW + 9)).toEqual({ changed: false });
    expect(await changeIncidentSeverity(t.db, manager, { incidentId, severity: "sev1", reason: "checkout affected too" }, NOW + 10)).toEqual({ changed: true });
    const open = await t.db.select().from(staffTasks).where(and(eq(staffTasks.refType, "incident"), eq(staffTasks.refId, incidentId), eq(staffTasks.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ assignedTo: people.owner.id, priority: "urgent" });
    detail = await getIncident(t.db, manager, ref, NOW + 11);
    expect(detail.timeline.filter((item) => item.kind === "event").map((item) => (item.kind === "event" ? item.action : ""))).toEqual(["ops.incident.owner", "ops.incident.severity"]);
    expect(detail.timeline.filter((item) => item.kind === "update").map((item) => (item.kind === "update" ? item.status : null))).toEqual(["open", "investigating", "mitigated", "resolved", "investigating"]);
    // details against the version the form saw
    expect(await code(() => editIncident(t.db, manager, { incidentId, title: "Proof queue slow", summary: "Staff report the proof queue takes 20 seconds.", expectedUpdatedAt: 1, reason: "clearer title" }, NOW))).toBe("incident_changed");
    const row = await t.db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
    expect(await editIncident(t.db, manager, { incidentId, title: "Proof queue slow", summary: row!.summary!, expectedUpdatedAt: row!.updatedAt, reason: "clearer title" }, NOW + 12)).toEqual({ changed: true });
    expect(await code(() => editIncident(t.db, manager, { incidentId, title: "Proof queue slow", summary: row!.summary!, expectedUpdatedAt: NOW + 12, reason: "again" }, NOW + 13))).toBe("no_change");
  });

  test("links and unlinks with a reason; views mine and overdue", async () => {
    const manager = people.manager.actor;
    const { incidentId, ref } = await createIncident(t.db, manager, { ...base(), ownerId: people.manager.id, targetDay: today() }, NOW);
    const findingId = await finding();
    expect(await linkToIncident(t.db, manager, { incidentId, kind: "finding", id: findingId }, NOW + 1)).toEqual({ replayed: false });
    expect(await linkToIncident(t.db, manager, { incidentId, kind: "finding", id: findingId }, NOW + 2)).toEqual({ replayed: true });
    expect(await code(() => unlinkFromIncident(t.db, manager, { incidentId, kind: "finding", id: findingId, reason: "" }, NOW))).toBe("invalid");
    expect(await unlinkFromIncident(t.db, manager, { incidentId, kind: "finding", id: findingId, reason: "a different problem" }, NOW + 3)).toEqual({ replayed: false });
    const detail = await getIncident(t.db, manager, ref, NOW + 4);
    expect(detail.links).toHaveLength(0);
    expect((await getFinding(t.db, people.owner.actor, findingId)).incidents).toHaveLength(0);
    const later = NOW + 2 * DAY_MS;
    const mine = await listIncidents(t.db, manager, parseIncidentFilters(new URLSearchParams("view=mine")), later);
    expect(mine.rows.some((row) => row.id === incidentId)).toBe(true);
    const overdue = await listIncidents(t.db, manager, parseIncidentFilters(new URLSearchParams("view=overdue")), later);
    expect(overdue.rows.find((row) => row.id === incidentId)?.overdue).toBe(true);
    expect((await incidentCounts(t.db, manager, later))?.mineOverdue).toBeGreaterThanOrEqual(1);
    expect((await opsQueueCounts(t.db, manager, later)).overdueIncidents).toBeGreaterThanOrEqual(1);
    const search = await listIncidents(t.db, manager, parseIncidentFilters(new URLSearchParams(`view=all&q=${ref}`)), NOW);
    expect(search.rows.map((row) => row.ref)).toEqual([ref]);
  });
});

// ───────────────────────────────────────────────────────────────── 23.01 / 23.02 telemetry

describe("23.01 errors and 23.02 speed", () => {
  test("texts are scrubbed before they are stored; repeats of the same error are one row", async () => {
    expect(scrubText("call 0770 123 4567 or a.b@c.io, token eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123", 500)).toBe("call 0770 ••• ••67 or [email], token [token]");
    expect(pathOf("https://tamtamgames.com/order/TT-1?t=secret#x")).toBe("/order/TT-1");
    const a = await recordError(t.db, { source: "client", message: "TypeError: cannot read 'x' of order 4411 (customer 07801234567)", url: "/admin/orders/TT-9?t=abc", route: "/admin/orders/:ref" }, NOW);
    const b = await recordError(t.db, { source: "client", message: "TypeError: cannot read 'y' of order 9822 (customer 07801234567)", url: "/admin/orders/TT-8", route: "/admin/orders/:ref" }, NOW + 1);
    expect(a.recorded && b.recorded).toBe(true);
    expect(b.id).toBe(a.id);
    const row = await t.db.select().from(errorReports).where(eq(errorReports.id, a.id!)).get();
    expect(row?.count).toBe(2);
    expect(row?.url).toBe("/admin/orders/TT-8");
    expect(row?.message).not.toContain("07801234567");
    expect(row?.message).toContain("0780 ••• ••67");
    expect((await recordError(t.db, { source: "nonsense", message: "x" }, NOW)).recorded).toBe(false);
  });

  test("a resolved error that happens again is open again; an ignored one stays ignored", async () => {
    const first = await recordError(t.db, { source: "server", message: "Error: D1 overloaded", route: "admin/ops" }, NOW);
    const other = await recordError(t.db, { source: "server", message: "Error: font file missing", route: "admin" }, NOW);
    expect(await setErrorStatus(t.db, people.manager.actor, { ids: [first.id, other.id], status: "resolved", reason: "x" }, NOW).catch((error) => toAppError(error)?.fields)).toEqual({ reason: "reason_required" });
    expect(await setErrorStatus(t.db, people.manager.actor, { ids: [first.id], status: "resolved", reason: "raised the D1 limit" }, NOW + 1)).toEqual({ changed: 1, unchanged: 0 });
    expect(await setErrorStatus(t.db, people.manager.actor, { ids: [other.id], status: "ignored", reason: "a browser extension" }, NOW + 1)).toEqual({ changed: 1, unchanged: 0 });
    expect(await code(() => setErrorStatus(t.db, people.manager.actor, { ids: [other.id], status: "resolved", reason: "fixed" }, NOW))).toBe("error_changed");
    await recordError(t.db, { source: "server", message: "Error: D1 overloaded", route: "admin/ops" }, NOW + 2);
    await recordError(t.db, { source: "server", message: "Error: font file missing", route: "admin" }, NOW + 2);
    expect((await t.db.select().from(errorReports).where(eq(errorReports.id, first.id!)).get())?.status).toBe("open");
    const ignored = await t.db.select().from(errorReports).where(eq(errorReports.id, other.id!)).get();
    expect(ignored).toMatchObject({ status: "ignored", count: 2 });
    const detail = await getErrorReport(t.db, people.opsReader.actor, first.id!);
    expect(detail.history.map((event) => event.action)).toEqual(["ops.error.resolve"]);
    const open = await listErrors(t.db, people.opsReader.actor, parseErrorFilters(new URLSearchParams("q=D1 overloaded")), NOW + 3);
    expect(open.rows.map((row) => row.id)).toContain(first.id);
  });

  test("the isolate budget: beyond it nothing is written and the occurrences join the next write", async () => {
    resetTelemetryBudget();
    for (let i = 0; i < ISOLATE_WRITES_PER_MINUTE; i++) await recordError(t.db, { source: "client", message: `Burst ${i % 3}`, route: "/admin/burst" }, NOW);
    const over = await recordError(t.db, { source: "client", message: "Burst 0", route: "/admin/burst" }, NOW);
    expect(over.recorded).toBe(false);
    const next = await recordError(t.db, { source: "client", message: "Burst 0", route: "/admin/burst" }, NOW + MINUTE_MS);
    expect(next.recorded).toBe(true);
    const row = await t.db.select().from(errorReports).where(eq(errorReports.id, next.id!)).get();
    // "Burst <n>" with its number blanked is one fingerprint: 60 + the one held back + this one
    expect(row?.count).toBe(ISOLATE_WRITES_PER_MINUTE + 2);
  });

  test("only slow or failed samples are written, per day, route, metric and device", async () => {
    expect((await recordPerfSample(t.db, { area: "admin", route: "/admin/ops/jobs", kind: "server", ms: 120, status: 200, device: "desktop" }, NOW)).recorded).toBe(false);
    expect((await recordPerfSample(t.db, { area: "admin", route: "/admin/ops/jobs", kind: "server", ms: 1500, status: 200, device: "desktop" }, NOW)).metric).toBe("server_slow");
    await recordPerfSample(t.db, { area: "admin", route: "/admin/ops/jobs", kind: "server", ms: 3500, status: 200, device: "desktop" }, NOW);
    await recordPerfSample(t.db, { area: "admin", route: "/admin/ops/jobs", kind: "server", ms: 40, status: 500, device: "mobile" }, NOW);
    await recordPerfSample(t.db, { area: "admin", route: "/admin/ops/jobs", kind: "load", ms: 7000, device: "mobile" }, NOW);
    const rows = await t.db.select().from(perfRollups).where(eq(perfRollups.route, "/admin/ops/jobs"));
    expect(rows.find((row) => row.metric === "server_slow")).toMatchObject({ samples: 2, sumValue: 5000, maxValue: 3500, poor: 1 });
    const view = await performanceView(t.db, people.manager.actor, parsePerfFilters(new URLSearchParams()), NOW);
    const jobs = view.rows.find((row) => row.route === "/admin/ops/jobs");
    expect(jobs).toMatchObject({ serverSlow: { count: 2, avgMs: 2500, maxMs: 3500, poor: 1 }, serverFailed: { count: 1 }, loadSlow: { count: 1, poor: 1 } });
    expect(view.days).toHaveLength(7);
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148")).toBe("mobile");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130")).toBe("desktop");
  });

  test("retention deletes what has not been seen for 90 days", async () => {
    const old = await recordError(t.db, { source: "db", message: "Error: very old" }, NOW - 120 * DAY_MS);
    await recordPerfSample(t.db, { area: "admin", route: "/admin/old", kind: "server", ms: 5000, status: 200 }, NOW - 120 * DAY_MS);
    const purged = await purgeOpsTelemetry(t.db, NOW);
    expect(purged.errors).toBeGreaterThanOrEqual(1);
    expect(purged.perf).toBeGreaterThanOrEqual(1);
    expect(await t.db.select().from(errorReports).where(eq(errorReports.id, old.id!)).get()).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────── 23.04 backups

describe("23.04 backups", () => {
  test("the monitor reads the restore tests module 20 records, and records none itself", async () => {
    const before = await backupsMonitor(t.db, people.manager.actor, NOW);
    expect(before.restore.due).toBe(true);
    expect(before.canRecord).toBe(false); // the manager may monitor, only the owner records tests (module 20)
    await recordRestoreTest(t.db, people.owner.actor, { testedOn: addDays(baghdadDay(NOW), -10), method: "time_travel_new_db", restoredTo: "tamtam-restore-test", result: "passed", checks: "orders, stock and journal counts match", idempotencyKey: key() }, NOW);
    const after = await backupsMonitor(t.db, people.manager.actor, NOW);
    expect(after.restore.due).toBe(false);
    expect(after.restore.ageDays).toBeGreaterThanOrEqual(9);
    expect(after.restore.ageDays).toBeLessThanOrEqual(10);
    expect((await backupsMonitor(t.db, people.owner.actor, NOW)).canRecord).toBe(true);
    const tests = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "security.backup.restore_test"));
    expect(tests).toHaveLength(1);
  });
});

