/**
 * Admin module 23 "ops" — adversarial review (2026-11-12). Every test here failed on the builder's code:
 *
 *   · linked incidents (ref, title, status) reached the finding and job-run pages of people without ops.incident.read
 *     (the built-in finance role on every finding), and those pages linked to runs and incidents the person cannot open
 *   · a negative wallet balance and the wallet liability total reached readers without a wallet permission, and their
 *     sentence was searchable
 *   · an incident manager could read any finding's, run's or error's description by linking it (or prefilling the new
 *     incident form with its id) without the permission to read that kind
 *   · the view chips counted every row of a view while their links kept the active filters (findings, errors,
 *     incidents); the "past their date" count was mine while its link listed everyone's
 *   · the retention purge deleted an error report an incident is about — the incident lost its evidence
 *   · a run by hand made a job whose cron stopped firing look healthy
 *   · an outbox row's provider error was shown unscrubbed (recipient phone / e-mail)
 *   · the incident page's action changed whichever incident the form named, not the page's
 *   · a reused "new incident" form key with other details silently returned the first incident
 *   · a branch-limited employee saw, and could close, findings about another branch's stock and orders
 */
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { action as findingAction } from "~/routes/admin/ops/finding";
import { action as incidentAction } from "~/routes/admin/ops/incident";
import { loader as jobsLoader } from "~/routes/admin/ops/jobs";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { branches, consistencyFindings, employeeRoles, errorReports, incidents, inventoryLocations, jobRuns, outbox, rolePermissions, roles } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { closeFindings, findingCounts, getFinding, listFindings, reopenFinding, assignFindings } from "~/server/services/admin/ops/consistency.server";
import { createIncident, getIncident, incidentFormOptions, linkToIncident, listIncidents } from "~/server/services/admin/ops/incidents.server";
import { getRun, jobsOverview, listOutbox } from "~/server/services/admin/ops/job-monitor.server";
import { opsQueueCounts } from "~/server/services/admin/ops/overview.server";
import { getErrorReport, listErrors, purgeOpsTelemetry, recordError, resetTelemetryBudget } from "~/server/services/admin/ops/telemetry.server";
import { DAY_MS, HOUR_MS, MINUTE_MS, addDays, baghdadDay, parseErrorFilters, parseFindingFilters, parseIncidentFilters, parseOutboxFilters } from "~/server/services/admin/ops/types";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const ORIGIN = "http://localhost:5173";
let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor; cookie?: string };
const people: Record<string, Person> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  people.owner = await person("owner");
  people.manager = await person("manager", { signIn: true });
  people.manager2 = await person("manager");
  people.finance = await person("finance");
  // custom roles: each holds one part of the module
  people.reader = await person(["ops.consistency.read", "ops.job.read", "ops.error.read", "ops.incident.read"]);
  people.jobsOnly = await person(["ops.job.read"]);
  people.errorsOnly = await person(["ops.error.read", "ops.error.resolve"]);
  people.incidentsOnly = await person(["ops.incident.read", "ops.incident.manage"]);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});
beforeEach(() => resetTelemetryBudget());

async function person(role: DefaultRoleKey | Permission[], options: { signIn?: boolean } = {}): Promise<Person> {
  const password = "ops-review-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("opsrev")}@ops.test`;
  const id = await make.employee({ email, name: Array.isArray(role) ? `custom ${role.join(" ")}` : role, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  let permissions: Set<string>;
  if (Array.isArray(role)) {
    const custom = `role_${make.next("opsrev").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    permissions = new Set<string>(role);
  } else {
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
    permissions = role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  }
  const who: Person = { id, actor: { kind: "employee", id, permissions, label: Array.isArray(role) ? "custom" : role } };
  if (options.signIn) who.cookie = await signedIn(email, password);
  return who;
}

function requestCtx(): RequestCtx {
  return {
    requestId: "test",
    nonce: "n",
    origin: ORIGIN,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: null,
    country: null,
    userAgent: "Mozilla/5.0 (Windows NT 10.0) Edg/130",
    locale: "ar",
    dir: "rtl",
    prefs: {} as RequestCtx["prefs"],
    storeMode: "demo",
    cookie: () => null,
    setCookie: () => {},
  };
}

async function signedIn(email: string, password: string): Promise<string> {
  const setCookies: string[] = [];
  const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
  const result = await signInEmployee(ctx, t.db, { email, password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  return setCookies.map((line) => line.split("; ")[0]).find((value) => value.startsWith("tt_adm=") && value.length > 10) ?? "";
}

async function route(cookie: string, path: string, fn: (args: never) => unknown, init: { params?: Record<string, string>; method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", body: init.body, headers: { cookie, origin: ORIGIN, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Edg/130", ...(init.headers ?? {}) } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params: init.params ?? {}, url: new URL(request.url), pattern: path } as never);
      return out instanceof Response ? out : new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}
const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const code = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.code ?? "unexpected";
const key = () => `${make.next("key")}-0123456789abcdef`;
const today = () => baghdadDay(NOW);

async function finding(values: Partial<typeof consistencyFindings.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? newId("cfd");
  await t.db.insert(consistencyFindings).values({
    id,
    fingerprint: `${values.checkKey ?? "orders.totals_vs_items"}|review|${id}`,
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

async function jobRun(job: string, values: Record<string, unknown> = {}): Promise<string> {
  const id = (values.id as string | undefined) ?? newId("job");
  await t.db.insert(jobRuns).values({ id, job, status: "succeeded", origin: "cron", startedAt: NOW - MINUTE_MS, finishedAt: NOW - MINUTE_MS + 10, durationMs: 10, stats: {}, ...values } as never);
  return id;
}

const incidentInput = (values: Record<string, unknown> = {}) => ({
  title: "Proof queue slow",
  severity: "sev2",
  summary: "Staff report the proof queue takes 20 seconds to open.",
  ownerId: people.manager.id,
  targetDay: addDays(today(), 1),
  idempotencyKey: key(),
  ...values,
});

// ───────────────────────────────────────────────────────────────── 1. who sees what

describe("authorization across the module's parts", () => {
  test("a finding's and a run's incidents reach only people who may read incidents", async () => {
    const findingId = await finding();
    const runId = await jobRun("orders.expire_unpaid", { status: "failed", error: "Error: D1 timeout" });
    const { ref } = await createIncident(t.db, people.manager.actor, incidentInput({ title: "Secret incident title 4417", links: [{ kind: "finding", id: findingId }, { kind: "run", id: runId }] }), NOW);
    // the built-in finance role reads findings, not incidents
    const finance = await getFinding(t.db, people.finance.actor, findingId);
    expect(finance.incidents).toEqual([]);
    expect(JSON.stringify(finance)).not.toContain("4417");
    const jobs = await getRun(t.db, people.jobsOnly.actor, runId);
    expect(jobs.incidents).toEqual([]);
    expect(JSON.stringify(jobs)).not.toContain("4417");
    // whoever may read incidents still sees them
    expect((await getFinding(t.db, people.reader.actor, findingId)).incidents.map((row) => row.ref)).toEqual([ref]);
    expect((await getRun(t.db, people.reader.actor, runId)).incidents.map((row) => row.ref)).toEqual([ref]);
  });

  test("links lead only to pages the employee may open (the run of a finding, the incident of an error)", async () => {
    const runId = await jobRun("consistency.daily");
    const findingId = await finding({ runId });
    expect((await getFinding(t.db, people.finance.actor, findingId)).run?.href).toBeNull();
    expect((await getFinding(t.db, people.manager.actor, findingId)).run?.href).toBe(`/admin/ops/jobs/runs/${runId}`);
    const error = await recordError(t.db, { source: "server", message: "Error: review link check", route: "/admin/ops/review" }, NOW);
    const { ref } = await createIncident(t.db, people.manager.actor, incidentInput({ links: [{ kind: "error", id: error.id }] }), NOW);
    const forErrors = await listErrors(t.db, people.errorsOnly.actor, parseErrorFilters(new URLSearchParams("q=review link check")), NOW);
    expect(forErrors.rows[0]?.incident?.ref).toBe(ref);
    expect(forErrors.rows[0]?.incident?.href).toBeNull();
    expect((await getErrorReport(t.db, people.errorsOnly.actor, error.id!)).error.incident?.href).toBeNull();
    expect((await getErrorReport(t.db, people.reader.actor, error.id!)).error.incident?.href).toBe(`/admin/ops/incidents/${ref}`);
  });

  test("wallet amounts in findings need a wallet permission — in the rows, the detail and search", async () => {
    const customerId = await make.customer({ name: "Wallet review customer" });
    const id = await finding({ checkKey: "wallet.negative_balance", entityType: "customer", entityId: customerId, message: "Wallet balance is negative (-48250 IQD).", details: { balanceIqd: -48_250 } });
    const total = await finding({ checkKey: "wallet.ledger_vs_journal", entityType: "account", entityId: "wallet_liability", fingerprint: `wallet.ledger_vs_journal|account|${newId("x")}`, message: "Wallet ledger total 9913377 IQD differs from the wallet liability account (9913000 IQD).", details: { ledgerIqd: 9_913_377, journalIqd: 9_913_000 } });
    const page = await listFindings(t.db, people.reader.actor, parseFindingFilters(new URLSearchParams("view=all&check=wallet.negative_balance")));
    const row = page.rows.find((entry) => entry.id === id);
    expect(row).toMatchObject({ withheld: true, details: null, message: null });
    const json = JSON.stringify([page, await getFinding(t.db, people.reader.actor, id), await getFinding(t.db, people.reader.actor, total)]);
    expect(json).not.toContain("48250");
    expect(json).not.toContain("9913377");
    expect((await listFindings(t.db, people.reader.actor, parseFindingFilters(new URLSearchParams("view=all&q=48250")))).total).toBe(0);
    // finance holds the wallet permission: the numbers are there
    expect((await getFinding(t.db, people.finance.actor, id)).finding.details).toEqual({ balanceIqd: -48_250 });
    expect((await listFindings(t.db, people.finance.actor, parseFindingFilters(new URLSearchParams("view=all&q=48250")))).total).toBe(1);
  });

  test("linking a record to an incident needs the permission to read that kind of record", async () => {
    const error = await recordError(t.db, { source: "server", message: "Error: private stack of the payments page 7731", route: "/admin/ops/review-link" }, NOW);
    const findingId = await finding();
    const runId = await jobRun("audit.seal");
    const manager = people.incidentsOnly.actor; // may manage incidents, may not read errors, findings or runs
    const options = await incidentFormOptions(t.db, manager, NOW, [{ kind: "error", id: error.id! }, { kind: "finding", id: findingId }, { kind: "run", id: runId }]);
    expect(options.links).toEqual([]);
    expect(JSON.stringify(options)).not.toContain("7731");
    expect(await code(() => createIncident(t.db, manager, incidentInput({ ownerId: people.incidentsOnly.id, links: [{ kind: "error", id: error.id }] }), NOW))).toBe("forbidden");
    const { incidentId } = await createIncident(t.db, manager, incidentInput({ ownerId: people.incidentsOnly.id }), NOW);
    expect(await code(() => linkToIncident(t.db, manager, { incidentId, kind: "finding", id: findingId }, NOW))).toBe("forbidden");
    expect(await code(() => linkToIncident(t.db, manager, { incidentId, kind: "run", id: runId }, NOW))).toBe("forbidden");
    expect(await code(() => linkToIncident(t.db, manager, { incidentId, kind: "error", id: error.id! }, NOW))).toBe("forbidden");
    expect((await t.db.select().from(errorReports).where(eq(errorReports.id, error.id!)).get())?.incidentId).toBeNull();
    // someone who may read them links them
    expect(await linkToIncident(t.db, people.manager.actor, { incidentId, kind: "error", id: error.id! }, NOW)).toEqual({ replayed: false });
  });
});

// ───────────────────────────────────────────────────────────────── 2. counts equal the lists they open

describe("counts", () => {
  test("the view chips count what their links open, with the same filters", async () => {
    const check = "review.count_check";
    await finding({ checkKey: check, severity: "warning" });
    await finding({ checkKey: check, severity: "warning", status: "acknowledged" });
    await finding({ checkKey: check, severity: "critical" });
    await finding({ checkKey: check, severity: "warning", status: "resolved" });
    const filtered = await listFindings(t.db, people.owner.actor, parseFindingFilters(new URLSearchParams(`check=${check}&severity=warning`)));
    expect(filtered.total).toBe(2);
    expect(filtered.counts.active).toBe(2);
    expect(filtered.counts.open).toBe(1);
    expect(filtered.counts.resolved).toBe(1);
    expect(filtered.counts.all).toBe(3);

    for (const message of ["Error: review count one", "Error: review count two"]) await recordError(t.db, { source: "db", message, route: "/admin/review-count" }, NOW);
    await recordError(t.db, { source: "client", message: "Error: review count three", route: "/admin/review-count" }, NOW);
    const errors = await listErrors(t.db, people.owner.actor, parseErrorFilters(new URLSearchParams("source=db&q=review count")), NOW);
    expect(errors.total).toBe(2);
    expect(errors.counts.open).toBe(2);
    expect(errors.counts.all).toBe(2);

    await createIncident(t.db, people.manager.actor, incidentInput({ title: "Review count incident A", severity: "sev4" }), NOW);
    await createIncident(t.db, people.manager.actor, incidentInput({ title: "Review count incident B", severity: "sev3" }), NOW);
    const list = await listIncidents(t.db, people.owner.actor, parseIncidentFilters(new URLSearchParams("severity=sev4&q=Review count")), NOW);
    expect(list.total).toBe(1);
    expect(list.counts.active).toBe(1);
    expect(list.counts.all).toBe(1);
  });

  test("the incidents past their date that the bell and the front page count are the ones their link lists", async () => {
    const later = NOW + 3 * DAY_MS;
    await createIncident(t.db, people.manager.actor, incidentInput({ title: "Overdue mine", targetDay: today() }), NOW);
    await createIncident(t.db, people.manager.actor, incidentInput({ title: "Overdue other", ownerId: people.manager2.id, targetDay: today() }), NOW);
    const listed = await listIncidents(t.db, people.manager.actor, parseIncidentFilters(new URLSearchParams("view=overdue")), later);
    expect(listed.total).toBeGreaterThanOrEqual(2);
    expect((await opsQueueCounts(t.db, people.manager.actor, later)).overdueIncidents).toBe(listed.total);
  });
});

// ───────────────────────────────────────────────────────────────── 3. evidence, honesty, privacy

describe("evidence and honesty", () => {
  test("the retention purge keeps an error report that an incident is about", async () => {
    const old = await recordError(t.db, { source: "db", message: "Error: old evidence for the incident", route: "/admin/review-old" }, NOW - 120 * DAY_MS);
    const { ref } = await createIncident(t.db, people.manager.actor, incidentInput({ links: [{ kind: "error", id: old.id }] }), NOW);
    await purgeOpsTelemetry(t.db, NOW);
    expect(await t.db.select().from(errorReports).where(eq(errorReports.id, old.id!)).get()).toBeDefined();
    const detail = await getIncident(t.db, people.manager.actor, ref, NOW);
    expect(detail.links.map((link) => `${link.kind}:${link.id}`)).toContain(`error:${old.id}`);
  });

  test("a run by hand does not make a job whose trigger stopped firing look healthy", async () => {
    const job = "inventory.reservations.expire";
    await jobRun(job, { origin: "cron", startedAt: NOW - 2 * HOUR_MS, finishedAt: NOW - 2 * HOUR_MS + 5 });
    await jobRun(job, { origin: "manual", startedAt: NOW - MINUTE_MS, finishedAt: NOW - MINUTE_MS + 5, triggeredBy: people.manager.id });
    const view = await jobsOverview(t.db, people.manager.actor, NOW);
    expect(view.jobs.find((entry) => entry.job === job)?.health).toBe("late");
  });

  test("an outbox row's provider error is scrubbed like everything else the page shows", async () => {
    await t.db.insert(outbox).values({ id: newId("msg"), channel: "email", recipient: "layla.review@example.com", template: "order_confirmed", payload: {}, status: "failed", attempts: 3, lastError: "550 5.1.1 <layla.review@example.com> unknown; sms fallback +9647701239988 refused", createdAt: NOW - HOUR_MS });
    const page = await listOutbox(t.db, people.manager.actor, parseOutboxFilters(new URLSearchParams("status=failed")));
    const json = JSON.stringify(page);
    expect(json).not.toContain("layla.review");
    expect(json).not.toContain("7701239988");
  });
});

// ───────────────────────────────────────────────────────────────── 4. forms and keys

describe("forms", () => {
  test("the incident page changes its own incident, never the one a form names", async () => {
    const a = await createIncident(t.db, people.manager.actor, incidentInput({ title: "Page incident A", severity: "sev3" }), NOW);
    const b = await createIncident(t.db, people.manager.actor, incidentInput({ title: "Page incident B", severity: "sev3" }), NOW);
    const form = new FormData();
    form.set("intent", "severity");
    form.set("incidentId", b.incidentId);
    form.set("severity", "sev1");
    form.set("reason", "checkout is down for everyone");
    const result = await route(people.manager.cookie!, `/admin/ops/incidents/${a.ref}`, incidentAction as never, { method: "POST", body: form, params: { ref: a.ref } });
    expect(statusOf(result)).toBeGreaterThanOrEqual(400);
    expect((await t.db.select().from(incidents).where(eq(incidents.id, b.incidentId)).get())?.severity).toBe("sev3");
    expect((await t.db.select().from(incidents).where(eq(incidents.id, a.incidentId)).get())?.severity).toBe("sev3");
  });

  test("a reused new-incident key with other details is refused, not answered with the first incident", async () => {
    const input = incidentInput({ title: "First use of the key" });
    const first = await createIncident(t.db, people.manager.actor, input, NOW);
    expect(await createIncident(t.db, people.manager.actor, input, NOW + 1)).toEqual({ ...first, replayed: true });
    expect(await code(() => createIncident(t.db, people.manager.actor, { ...input, title: "A different incident" }, NOW + 2))).toBe("idempotency_mismatch");
    expect(await t.db.select().from(incidents).where(eq(incidents.title, "A different incident")).get()).toBeUndefined();
  });
});

describe("requests and input", () => {
  test("a POST that is not a form gets 400, not a crash (500)", async () => {
    const id = await finding();
    const result = await route(people.manager.cookie!, `/admin/ops/consistency/${id}`, findingAction as never, { method: "POST", body: JSON.stringify({ intent: "close" }), params: { findingId: id }, headers: { "content-type": "application/json" } });
    expect(result instanceof Error).toBe(false);
    expect(statusOf(result)).toBe(400);
  });

  test("search accepts Arabic-Indic and Persian digits (an incident reference typed on an Arabic keyboard)", async () => {
    const { ref } = await createIncident(t.db, people.manager.actor, incidentInput({ title: "Digits search incident" }), NOW);
    const arabic = ref.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));
    const persian = ref.replace(/\d/g, (digit) => String.fromCharCode(0x06f0 + Number(digit)));
    for (const typed of [arabic, persian]) {
      const found = await listIncidents(t.db, people.manager.actor, parseIncidentFilters(new URLSearchParams({ view: "all", q: typed })), NOW);
      expect(found.rows.map((row) => row.ref)).toContain(ref);
    }
    const error = await recordError(t.db, { source: "server", message: "Error: digits 4471 in a message", route: "/admin/digits" }, NOW);
    const errors = await listErrors(t.db, people.manager.actor, parseErrorFilters(new URLSearchParams({ view: "all", q: "٤٤٧١" })), NOW);
    expect(errors.rows.map((row) => row.id)).toContain(error.id);
  });

  test("the jobs that need attention — counted for the bell and the front page — are a list of their own", async () => {
    await jobRun("catalog.publish_due", { status: "failed", error: "Error: boom", startedAt: NOW - 2 * MINUTE_MS });
    const page = (await route(people.manager.cookie!, "/admin/ops/jobs?view=attention", jobsLoader as never)) as { jobs?: { job: string }[]; now: number };
    const counted = (await opsQueueCounts(t.db, people.manager.actor, page.now)).failingJobs;
    expect(counted).toBeGreaterThan(0);
    expect(page.jobs?.length).toBe(counted);
  });
});

// ───────────────────────────────────────────────────────────────── 5. branch limits

describe("branch limits", () => {
  test("a branch-limited employee sees and acts on findings of their branch's records only", async () => {
    const [north, south] = [newId("brn"), newId("brn")];
    await t.db.insert(branches).values([
      { id: north, code: make.next("N"), name: { ar: "فرع الشمال", en: "North" }, createdAt: NOW },
      { id: south, code: make.next("S"), name: { ar: "فرع الجنوب", en: "South" }, createdAt: NOW },
    ]);
    const [northShelf, southShelf] = [newId("loc"), newId("loc")];
    await t.db.insert(inventoryLocations).values([
      { id: northShelf, code: make.next("LN"), name: "North shelf", branchId: north },
      { id: southShelf, code: make.next("LS"), name: "South shelf", branchId: south },
    ]);
    const product = await make.product();
    const stock = (location: string) => ({ checkKey: "stock.levels_vs_movements", severity: "warning" as const, entityType: "stock_level", entityId: `${product.variantId}@${location}`, message: "Stock level does not match its movements: on hand 4 vs 3, reserved 0 vs 0.", details: { onHand: 4, movedQty: 3 } });
    const mine = await finding({ ...stock(northShelf), fingerprint: `stock|${northShelf}` });
    const theirs = await finding({ ...stock(southShelf), fingerprint: `stock|${southShelf}` });
    const warehouse = await finding({ ...stock(DEFAULT_LOCATION_ID), fingerprint: `stock|${DEFAULT_LOCATION_ID}` });
    const southOrder = await make.order([{ ...product, qty: 1 }], { branchId: south });
    const theirOrder = await finding({ entityType: "order", entityId: southOrder.orderId });
    const limited: EmployeeActor = { ...people.manager.actor, branchId: north };

    const page = await listFindings(t.db, limited, parseFindingFilters(new URLSearchParams("view=all&check=stock.levels_vs_movements")));
    expect(page.rows.map((row) => row.id)).toContain(mine);
    expect(page.rows.map((row) => row.id)).not.toContain(theirs);
    expect(page.rows.map((row) => row.id)).not.toContain(warehouse);
    expect(page.total).toBe(page.rows.length);
    const everything = await listFindings(t.db, limited, parseFindingFilters(new URLSearchParams("view=all")));
    expect(everything.rows.map((row) => row.id)).not.toContain(theirOrder);
    expect(await code(() => getFinding(t.db, limited, theirs))).toBe("not_found");
    expect(await code(() => closeFindings(t.db, limited, { ids: [theirs], outcome: "false_positive", reason: "not our shelf anyway" }, NOW))).toBe("not_found");
    expect(await code(() => assignFindings(t.db, limited, { ids: [theirOrder], assigneeId: people.manager2.id }, NOW))).toBe("not_found");
    expect((await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.id, theirs)).get())?.status).toBe("open");
    // the front page counts the same rows
    const counts = await findingCounts(t.db, limited);
    const active = await listFindings(t.db, limited, parseFindingFilters(new URLSearchParams()));
    expect(counts?.active).toBe(active.total);
    // their own branch works as before
    expect(await closeFindings(t.db, limited, { ids: [mine], outcome: "resolved", reason: "counted the north shelf" }, NOW)).toEqual({ closed: 1, unchanged: 0 });
    expect(await reopenFinding(t.db, limited, { id: mine, reason: "still short after the count" }, NOW + 1)).toEqual({ replayed: false });
    // an unlimited manager still sees every branch
    const all = await listFindings(t.db, people.manager.actor, parseFindingFilters(new URLSearchParams("view=all&check=stock.levels_vs_movements")));
    expect(all.rows.map((row) => row.id)).toEqual(expect.arrayContaining([mine, theirs, warehouse]));
    // a finding is given only to someone who may open it: never to an employee limited to another branch
    const northClerk = await person(["ops.consistency.read"]);
    const { employees } = await import("~/server/db/schema");
    await t.db.update(employees).set({ branchId: north }).where(eq(employees.id, northClerk.id));
    expect(toAppError(await thrown(() => assignFindings(t.db, people.manager.actor, { ids: [theirs], assigneeId: northClerk.id }, NOW)))?.fields).toEqual({ assigneeId: "assignee_invalid" });
    expect(await assignFindings(t.db, people.manager.actor, { ids: [mine], assigneeId: northClerk.id }, NOW + 2)).toEqual({ assigned: 1, unchanged: 0 });
  });
});
