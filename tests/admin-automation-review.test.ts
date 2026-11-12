/**
 * Admin module 19 "automation" — the adversarial review's tests (each one failed on the builder's code), on a real
 * local D1 (createTestDb, roles seeded, fixtures of their own):
 *
 *   · 19.02: a draft purchase order is made only from suggestions that are still open — a new form key on dismissed
 *     or already linked suggestions, or two people at once, never make a second draft; a draft 09 refuses leaves the
 *     suggestions open; suggestions taken by a request that stopped half way are released by the next scan
 *   · the runner: a rule paused, or saved as a new version, after a run read it does nothing more in that run
 *   · a review flag never reopens an order a reviewer already cleared (05.09)
 *   · counts equal the lists they open: rules waiting for this person, failed runs and runs of the last 24 hours on
 *     the front page; 19.03's tickets (every open ticket counted, pages that add up); 19.04's own checks (the number
 *     found beside the 50 listed)
 *   · "run the active rules now" checks the stock, and the suggestions page says when it was checked
 *   · the dry run's window in any of the three digit sets
 *   · the builder's actions answer a body that is not a form with 400, never a crash
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { action as ruleEditAction } from "~/routes/admin/automation/rule-edit";
import { action as ruleNewAction } from "~/routes/admin/automation/rule-new";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { employeeRoles, orders, reorderSuggestions, stockLevels, supportTickets, workflowRuns, workflows } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { unusualTransactions } from "~/server/services/admin/automation/anomalies.server";
import { DAY_MS, HOUR_MS } from "~/server/services/admin/automation/catalog";
import type { RuleRaw } from "~/server/services/admin/automation/definition";
import { countNotices, listNoticeGroups, listRuns, markRuleNoticesSeen } from "~/server/services/admin/automation/log.server";
import { QUEUE_HREFS, automationOverview, automationQueueCounts } from "~/server/services/admin/automation/overview.server";
import { activateRule, dryRunRule, listRules, pauseRule, saveRule } from "~/server/services/admin/automation/rules.server";
import { runAutomation, runRule } from "~/server/services/admin/automation/runner.server";
import { createDraftOrder, dismissSuggestion, listSuggestions, scanStockOuts } from "~/server/services/admin/automation/suggestions.server";
import { ticketSuggestions } from "~/server/services/admin/automation/tickets.server";
import * as automationTypes from "~/server/services/admin/automation/types";
import { parseRuleFilters, parseRunFilters, parseSuggestionFilters } from "~/server/services/admin/automation/types";
import { cancelPurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { createSupplier } from "~/server/services/admin/purchasing/suppliers.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const ORIGIN = "http://localhost:5173";
let t: TestDb;
let make: Fixtures;

type Person = { id: string; actor: EmployeeActor; email: string; password: string; cookie: string };
let managerA: Person;
let managerB: Person;
let worker: Person;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  managerA = await person("manager", true);
  managerB = await person("manager");
  worker = await person("fulfillment");
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey, signIn = false): Promise<Person> {
  const password = "automation-review-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("review")}@automation.test`;
  const id = await make.employee({ email, name: `${role} ${make.next("p")}`, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const who: Person = { id, email, password, actor: { kind: "employee", id, permissions: defaultRolePermissions(role), label: role }, cookie: "" };
  if (signIn) who.cookie = await signedIn(who);
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

async function signedIn(who: Pick<Person, "email" | "password">): Promise<string> {
  const setCookies: string[] = [];
  const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
  const result = await signInEmployee(ctx, t.db, { email: who.email, password: who.password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  return setCookies.map((line) => line.split("; ")[0]).find((value) => value.startsWith("tt_adm=") && value.length > 10) ?? "";
}

type Fn = (args: never) => unknown;
async function run(cookie: string, path: string, fn: Fn, init: { params?: Record<string, string>; method?: string; body?: BodyInit } = {}): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", body: init.body, headers: { cookie, origin: ORIGIN, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Edg/130" } });
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

async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const code = async (fn: () => Promise<unknown>) => toAppError(await thrown(fn))?.code ?? "unexpected";
const key = () => `k_${newId("idem").slice(4)}_0123456789`;
const count = async (table: string, where = "1 = 1") => Number((await t.d1.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())?.n ?? 0);
const linkParams = (href: string) => new URL(href, ORIGIN).searchParams;

const orderRule = (overrides: Partial<RuleRaw> = {}): RuleRaw => ({
  name: `طلبات كبيرة ${make.next("r")}`,
  event: "order.placed",
  match: { channel: "web", paymentMethods: ["cod"], minTotal: "٥٠٠٠٠٠" },
  actions: { staff_task: { assigneeId: worker.id, priority: "high", dueHours: "٤", note: "اتصل بالعميل" }, notify: { audience: "automation.workflow.read" }, flag_order: true },
  ...overrides,
});

async function order(at: number, overrides: Partial<typeof orders.$inferInsert> = {}, price = 600_000) {
  const product = await make.product({ priceIqd: price, stock: 5 });
  return make.order([{ variantId: product.variantId, sku: product.sku, unitPriceIqd: price }], { placedAt: at, channel: "web", paymentMethod: "cod", ...overrides });
}

const updatedAt = async (ruleId: string) => (await t.db.select({ updatedAt: workflows.updatedAt }).from(workflows).where(eq(workflows.id, ruleId)).get())!.updatedAt;

/** A rule saved by A, dry-run by A and switched on by B at `at`. */
async function activeRule(raw: RuleRaw, at: number): Promise<string> {
  const { ruleId } = await saveRule(t.db, managerA.actor, { definition: raw, idempotencyKey: key() }, at - 3 * HOUR_MS);
  await dryRunRule(t.db, managerA.actor, { ruleId, days: 7, expectedUpdatedAt: await updatedAt(ruleId) }, at - 2 * HOUR_MS);
  await activateRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: await updatedAt(ruleId), reason: "راجعتُ المحاكاة" }, at);
  return ruleId;
}

async function lowSku(point = 5, qty = 10) {
  const product = await make.product({ priceIqd: 90_000, stock: 2 });
  await t.db.update(stockLevels).set({ reorderPoint: point, reorderQty: qty }).where(and(eq(stockLevels.variantId, product.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)));
  return product;
}
const suggestionOf = (variantId: string) => t.db.select().from(reorderSuggestions).where(eq(reorderSuggestions.variantId, variantId));
const supplier = async () => (await createSupplier(t.db, managerA.actor, { code: make.next("SUP").toUpperCase(), name: "مورّد المراجعة", currency: "IQD", leadTimeDays: "5", paymentTerms: "نقداً" }, NOW)).supplierId;
const draftInput = (ids: string[], supplierId: string, idempotencyKey: string) => ({
  suggestionIds: ids,
  supplierId,
  locationId: DEFAULT_LOCATION_ID,
  currency: "IQD",
  notes: "",
  lines: ids.map((id) => ({ suggestionId: id, qty: "", unitCost: "٢٥٠٠٠" })),
  idempotencyKey,
});

// ───────────────────────────────────────────────────────────────── 19.02

describe("19.02 a draft purchase order only from suggestions that are still open", () => {
  test("dismissed or already linked suggestions never make a second draft, whatever the form's key", async () => {
    const a = await lowSku(5, 8);
    const b = await lowSku(4, 6);
    await scanStockOuts(t.db, managerA.actor, NOW);
    const [sa] = await suggestionOf(a.variantId);
    const [sb] = await suggestionOf(b.variantId);
    const supplierId = await supplier();
    await dismissSuggestion(t.db, managerA.actor, { suggestionId: sa.id, reason: "لن نبيعه" }, NOW);
    const before = await count("purchase_orders");
    expect(await code(() => createDraftOrder(t.db, managerA.actor, draftInput([sa.id], supplierId, key()), NOW))).toBe("suggestion_not_open");
    expect(await count("purchase_orders")).toBe(before);
    const first = draftInput([sb.id], supplierId, key());
    const made = await createDraftOrder(t.db, managerA.actor, first, NOW);
    expect(made).toMatchObject({ replayed: false, linked: 1 });
    // another tab, a new key, the same (now linked) suggestion — by the same person or by someone else
    expect(await code(() => createDraftOrder(t.db, managerA.actor, draftInput([sb.id], supplierId, key()), NOW + 1000))).toBe("suggestion_not_open");
    expect(await code(() => createDraftOrder(t.db, managerB.actor, draftInput([sb.id], supplierId, key()), NOW + 1000))).toBe("suggestion_not_open");
    expect(await count("purchase_orders")).toBe(before + 1);
    // the same form sent again is a replay of the same draft
    expect(await createDraftOrder(t.db, managerA.actor, first, NOW + 2000)).toMatchObject({ poId: made.poId, replayed: true, linked: 0 });
    expect(await count("purchase_orders")).toBe(before + 1);
  });

  test("two people at once make ONE draft; the other is told", async () => {
    const c = await lowSku(5, 9);
    await scanStockOuts(t.db, managerA.actor, NOW + 10_000);
    const [sc] = await suggestionOf(c.variantId);
    const supplierId = await supplier();
    const before = await count("purchase_orders");
    const results = await Promise.allSettled([
      createDraftOrder(t.db, managerA.actor, draftInput([sc.id], supplierId, key()), NOW + 11_000),
      createDraftOrder(t.db, managerB.actor, draftInput([sc.id], supplierId, key()), NOW + 11_000),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(["suggestion_changed", "suggestion_not_open"]).toContain(toAppError(refused.reason)?.code);
    expect(await count("purchase_orders")).toBe(before + 1);
    const [linked] = await suggestionOf(c.variantId);
    expect(linked.status).toBe("approved");
    expect(await count("purchase_orders", `id = '${linked.purchaseOrderId}'`)).toBe(1);
  });

  test("an old form sent again after 09 cancelled its draft never links the reopened suggestions to that cancelled draft", async () => {
    const e = await lowSku(5, 5);
    await scanStockOuts(t.db, managerA.actor, NOW + 15_000);
    const [se] = await suggestionOf(e.variantId);
    const supplierId = await supplier();
    const form = draftInput([se.id], supplierId, key());
    const made = await createDraftOrder(t.db, managerA.actor, form, NOW + 16_000);
    await cancelPurchaseOrder(t.db, managerA.actor, { poId: made.poId, reason: "مورّد آخر" }, NOW + 17_000);
    await scanStockOuts(t.db, managerA.actor, NOW + 18_000);
    expect((await suggestionOf(e.variantId))[0]).toMatchObject({ status: "open", purchaseOrderId: null });
    expect(await code(() => createDraftOrder(t.db, managerA.actor, form, NOW + 19_000))).toBe("idempotency_mismatch");
    expect((await suggestionOf(e.variantId))[0]).toMatchObject({ status: "open", purchaseOrderId: null, decidedBy: null });
  });

  test("a draft that 09 refuses leaves the suggestions open; suggestions taken by a request that stopped half way come back", async () => {
    const d = await lowSku(5, 7);
    await scanStockOuts(t.db, managerA.actor, NOW + 20_000);
    const [sd] = await suggestionOf(d.variantId);
    const supplierId = await supplier();
    const before = await count("purchase_orders");
    const bad = { ...draftInput([sd.id], supplierId, key()), lines: [{ suggestionId: sd.id, qty: "", unitCost: "ليس رقماً" }] };
    expect(await code(() => createDraftOrder(t.db, managerA.actor, bad, NOW + 21_000))).toBe("invalid");
    expect((await suggestionOf(d.variantId))[0]).toMatchObject({ status: "open", purchaseOrderId: null, decidedBy: null });
    expect(await count("purchase_orders")).toBe(before);
    // a request that took the suggestion and stopped before 09 wrote the draft (the worker was stopped)
    await t.db.update(reorderSuggestions).set({ status: "approved", purchaseOrderId: "po_neverwritten00000000000000", decidedBy: managerA.id, decidedAt: NOW + 22_000 }).where(eq(reorderSuggestions.id, sd.id));
    await scanStockOuts(t.db, managerA.actor, NOW + 22_000 + 60_000); // a minute later it may still be running
    expect((await suggestionOf(d.variantId))[0].status).toBe("approved");
    await scanStockOuts(t.db, managerA.actor, NOW + 22_000 + 30 * 60_000);
    expect((await suggestionOf(d.variantId))[0]).toMatchObject({ status: "open", purchaseOrderId: null, decidedBy: null });
  });

  test("a scan with more than a hundred SKUs to reorder (D1 binds at most 100 values per statement)", async () => {
    const many: Awaited<ReturnType<typeof lowSku>>[] = [];
    for (let index = 0; index < 105; index++) many.push(await lowSku(5, 4));
    const scan = await scanStockOuts(t.db, managerA.actor, NOW + 25_000);
    expect(scan.created).toBeGreaterThanOrEqual(105);
    for (const sku of [many[0], many[52], many[104]]) expect(await suggestionOf(sku.variantId)).toHaveLength(1);
    expect((await scanStockOuts(t.db, managerA.actor, NOW + 26_000)).created).toBe(0);
  });

  test("'run the active rules now' checks the stock, and the suggestions page says when", async () => {
    const at = NOW + 200 * DAY_MS;
    await runAutomation(t.db, at, { triggeredBy: managerA.actor, reason: "المجدول متوقف محلياً" });
    const page = await listSuggestions(t.db, managerA.actor, parseSuggestionFilters(new URLSearchParams()), "ar", at);
    expect(page.lastScanAt).toBe(at);
  });
});

// ───────────────────────────────────────────────────────────────── the runner

describe("the runner stops when the rule changed under it", () => {
  test("a rule paused, or saved as a new version, after the run read it does nothing more", async () => {
    const at = NOW + 30 * DAY_MS;
    const ruleId = await activeRule(orderRule(), at);
    const placed = await order(at + HOUR_MS);
    const stale = (await t.db.select().from(workflows).where(eq(workflows.id, ruleId)).get())!;
    await pauseRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: stale.updatedAt, reason: "تنشئ مهاماً كثيرة" }, at + 2 * HOUR_MS);
    await runRule(t.db, stale, at + 3 * HOUR_MS);
    expect(await count("workflow_runs", `workflow_id = '${ruleId}' AND is_dry_run = 0`)).toBe(0);
    expect(await count("staff_tasks", `title LIKE '%${placed.ref}%'`)).toBe(0);
    expect((await t.db.select({ reviewStatus: orders.reviewStatus }).from(orders).where(eq(orders.id, placed.orderId)).get())?.reviewStatus).toBe("none");

    const notifyOnly = await activeRule(orderRule({ actions: { notify: { audience: "automation.workflow.read" } } }), at + 4 * HOUR_MS);
    await order(at + 5 * HOUR_MS);
    const read = (await t.db.select().from(workflows).where(eq(workflows.id, notifyOnly)).get())!;
    await saveRule(t.db, managerB.actor, { ruleId: notifyOnly, expectedUpdatedAt: read.updatedAt, definition: orderRule({ name: read.name, actions: { notify: { audience: "automation.suggestion.read" } } }), reason: "جمهور آخر" }, at + 6 * HOUR_MS);
    await runRule(t.db, read, at + 7 * HOUR_MS);
    expect(await count("workflow_runs", `workflow_id = '${notifyOnly}' AND is_dry_run = 0`)).toBe(0);
  });

  test("a review flag never reopens an order a reviewer already cleared", async () => {
    const at = NOW + 40 * DAY_MS;
    const ruleId = await activeRule(orderRule({ actions: { flag_order: true } }), at);
    const cleared = await order(at + HOUR_MS, { reviewStatus: "cleared" });
    await runAutomation(t.db, at + 2 * HOUR_MS, { ruleId, scan: false });
    const ran = (await t.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ruleId), eq(workflowRuns.refId, cleared.orderId), eq(workflowRuns.isDryRun, false))).get())!;
    expect(ran.actionsLog?.find((entry) => entry.type === "flag_order")).toMatchObject({ outcome: "skipped", reason: "order_reviewed" });
    expect((await t.db.select({ reviewStatus: orders.reviewStatus }).from(orders).where(eq(orders.id, cleared.orderId)).get())?.reviewStatus).toBe("cleared");
  });

  test("the dry run's window in any of the three digit sets", async () => {
    const at = NOW + 45 * DAY_MS;
    const { ruleId } = await saveRule(t.db, managerA.actor, { definition: orderRule(), idempotencyKey: key() }, at);
    expect((await dryRunRule(t.db, managerA.actor, { ruleId, days: "٣٠", expectedUpdatedAt: await updatedAt(ruleId) }, at + 1000)).days).toBe(30);
    expect((await dryRunRule(t.db, managerA.actor, { ruleId, days: "۷", expectedUpdatedAt: await updatedAt(ruleId) }, at + 2000)).days).toBe(7);
    expect(await code(async () => dryRunRule(t.db, managerA.actor, { ruleId, days: "٣١", expectedUpdatedAt: await updatedAt(ruleId) }, at + 3000))).toBe("invalid");
  });
});

// ───────────────────────────────────────────────────────────────── counts and their lists

describe("counts equal the lists they open", () => {
  test("the front page: rules waiting for this person, failed runs and the runs of the last 24 hours", async () => {
    const at = NOW + 60 * DAY_MS;
    // A's rule with a fresh dry run (B may switch it on), B's own (B may not), A's with a stale dry run (nobody may)
    const ready = await saveRule(t.db, managerA.actor, { definition: orderRule(), idempotencyKey: key() }, at - HOUR_MS);
    await dryRunRule(t.db, managerA.actor, { ruleId: ready.ruleId, days: 7, expectedUpdatedAt: await updatedAt(ready.ruleId) }, at - HOUR_MS + 1000);
    const own = await saveRule(t.db, managerB.actor, { definition: orderRule(), idempotencyKey: key() }, at - HOUR_MS);
    await dryRunRule(t.db, managerB.actor, { ruleId: own.ruleId, days: 7, expectedUpdatedAt: await updatedAt(own.ruleId) }, at - HOUR_MS + 1000);
    const stale = await saveRule(t.db, managerA.actor, { definition: orderRule(), idempotencyKey: key() }, at - 10 * DAY_MS);
    await dryRunRule(t.db, managerA.actor, { ruleId: stale.ruleId, days: 7, expectedUpdatedAt: await updatedAt(stale.ruleId) }, at - 10 * DAY_MS + 1000);

    const counts = await automationQueueCounts(t.db, managerB.actor, at);
    const listed = await listRules(t.db, managerB.actor, parseRuleFilters(linkParams(QUEUE_HREFS.rulesToActivate)), at);
    expect(listed.total).toBe(counts.rulesToActivate);
    expect(listed.rows.map((row) => row.id)).toContain(ready.ruleId);
    expect(listed.rows.map((row) => row.id)).not.toContain(own.ruleId);
    expect(listed.rows.map((row) => row.id)).not.toContain(stale.ruleId);

    // failed runs: the front page counts the last 24 hours, and its link lists the same runs
    for (const [startedAt, status] of [
      [at - 2 * DAY_MS, "failed"],
      [at - HOUR_MS, "failed"],
      [at - 2 * HOUR_MS, "succeeded"],
    ] as const)
      await t.db.insert(workflowRuns).values({ id: newId("wfr").toLowerCase(), workflowId: ready.ruleId, refType: "order", refId: "ord_x", event: {}, isDryRun: false, status, actionsLog: [], error: status === "failed" ? "assignee_inactive" : null, startedAt, finishedAt: startedAt });
    const links = (automationTypes as unknown as { AUTOMATION_LINKS?: Record<string, string> }).AUTOMATION_LINKS;
    expect(links).toBeDefined();
    const overview = await automationOverview(t.db, managerB.actor, at);
    expect((await listRuns(t.db, managerB.actor, parseRunFilters(linkParams(links!.failedRuns)), at)).total).toBe(overview.waiting.failedRuns);
    expect((await listRuns(t.db, managerB.actor, parseRunFilters(linkParams(links!.runs24h)), at)).total).toBe(overview.figures.runs24h);
    expect(links!.rulesToActivate).toBe(QUEUE_HREFS.rulesToActivate);
  });

  test("notices: the front page counts every notice of a rule (as the bell does), and 'mark all as seen' marks them all", async () => {
    const at = NOW + 70 * DAY_MS;
    const ruleId = await activeRule(orderRule({ actions: { notify: { audience: "automation.workflow.read" } } }), at);
    const rows = Array.from({ length: 310 }, (_, index) => ({
      id: newId("wfr").toLowerCase(),
      workflowId: ruleId,
      refType: "order",
      refId: `ord_notice_${index}`,
      event: { type: "order.placed", label: `TT-N${index}`, at: at + index, version: 1, isDemo: false, facts: {} },
      isDryRun: false,
      status: "succeeded" as const,
      actionsLog: [{ type: "notify" as const, outcome: "done" as const, detail: { audience: "automation.workflow.read" } }],
      error: null,
      startedAt: at + 1000 + index,
      finishedAt: at + 1000 + index,
    }));
    for (let index = 0; index < rows.length; index += 8) await t.db.insert(workflowRuns).values(rows.slice(index, index + 8));
    const when = at + DAY_MS;
    const bell = await countNotices(t.db, managerB.actor, when);
    const groups = await listNoticeGroups(t.db, managerB.actor, when);
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(bell);
    expect(groups.find((group) => group.ruleId === ruleId)).toMatchObject({ count: 310 });
    expect(groups.find((group) => group.ruleId === ruleId)?.items).toHaveLength(3);
    expect(await markRuleNoticesSeen(t.db, managerB.actor, { ruleId }, when)).toEqual({ marked: 310 });
    expect((await listNoticeGroups(t.db, managerB.actor, when)).some((group) => group.ruleId === ruleId)).toBe(false);
    expect(await countNotices(t.db, managerB.actor, when)).toBe((bell ?? 0) - 310);
    expect(await count("audit_events", `action = 'automation.notice.seen' AND actor_id = '${managerB.id}'`)).toBe(310);
  });

  test("19.03: every open ticket is counted, and the list comes in pages that add up to its count", async () => {
    const rows = Array.from({ length: 230 }, (_, index) => ({ id: newId("tkt"), ref: make.next("SUP"), subject: `حوالة ما وصلت ${index}`, category: "order" as const, status: "open" as const, createdAt: NOW - index * 1000, updatedAt: NOW, lastMessageAt: NOW - index * 1000 }));
    for (let at = 0; at < rows.length; at += 8) await t.db.insert(supportTickets).values(rows.slice(at, at + 8));
    const open = await count("support_tickets", "status NOT IN ('resolved', 'closed')");
    const first = (await ticketSuggestions(t.db, managerA.actor, { view: "differs", page: 1 } as never, NOW)) as Awaited<ReturnType<typeof ticketSuggestions>> & { total?: number; pageCount?: number };
    expect(first.open).toBe(open);
    expect(first.total).toBe(first.differs);
    let seen = first.rows.length;
    for (let page = 2; page <= (first.pageCount ?? 1); page++) seen += (await ticketSuggestions(t.db, managerA.actor, { view: "differs", page } as never, NOW)).rows.length;
    expect(seen).toBe(first.differs);
    expect(first.differs).toBeGreaterThanOrEqual(230);
  });

  test("19.04: the module's own checks give the number found beside the 50 they list", async () => {
    const product = await make.product({ priceIqd: 200_000 });
    for (let index = 0; index < 55; index++) await make.order([{ variantId: product.variantId, sku: product.sku, unitPriceIqd: 200_000 }], { placedAt: NOW - DAY_MS - index * 1000, discountIqd: 60_000 });
    const hub = await unusualTransactions(t.db, managerA.actor, { demo: false }, "ar", NOW);
    const check = hub.checks.find((candidate) => candidate.check === "order.discount_high")! as (typeof hub.checks)[number] & { total?: number };
    expect(check.findings).toHaveLength(50);
    expect(check.total).toBe(55);
  });
});

// ───────────────────────────────────────────────────────────────── routes

describe("the builder's actions", () => {
  test("a body that is not a form is a 400, never a crash", async () => {
    const { ruleId } = await saveRule(t.db, managerA.actor, { definition: orderRule(), idempotencyKey: key() }, NOW);
    const created = await run(managerA.cookie, "/admin/automation/rules/new", ruleNewAction as never, { method: "POST", body: "{}" });
    expect(created).not.toBeInstanceOf(Error);
    expect(statusOf(created)).toBe(400);
    const edited = await run(managerA.cookie, `/admin/automation/rules/${ruleId}/edit`, ruleEditAction as never, { method: "POST", body: "{}", params: { ruleId } });
    expect(edited).not.toBeInstanceOf(Error);
    expect(statusOf(edited)).toBe(400);
  });
});
