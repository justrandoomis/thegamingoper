/**
 * Admin module 19 "automation" (owner: admin automation) — the services under app/server/services/admin/automation on
 * a real local D1 with the demo catalogue (createTestDb + seedDemo) and fixtures of their own:
 *
 *   · the fixed catalogue: the evaluator per event, the builder's parsing (Arabic-Indic / Persian digits, every field
 *     error at once, actions an event does not allow), the keyword rules (19.03), the forecast method (19.05), waiting
 *     episodes of a ticket
 *   · authorization per built-in role and custom roles, before the input is read; branch-limited employees read only
 *   · 19.01 / 19.07: versions (+1, back to draft, audit snapshots, no-change refused), idempotent creation, the dry run
 *     (what it counts, why others did not count, samples only — nothing done), switching on only after a fresh dry run
 *     of the current version and never by its author (four eyes), pause and resume with a reason
 *   · the runner: once per rule and event (twice in a row, two at once), never before the rule was switched on, demo
 *     records only when asked, a task in 15.02's table, a notice for holders of a permission (marked seen per person),
 *     a review flag through 05.09 (skipped on a held order), an inactive assignee fails the run
 *   · 19.08: no run moves stock or money, changes a price or an order's status — the tables are counted before / after
 *   · 19.02: stock-out suggestions from 04's numbers, one per stock episode, dismissed with a reason, a draft purchase
 *     order through 09 (permissions, idempotent, demo kept apart), reopened when 09 cancels the draft; no cost in lists
 *   · 19.04: the own checks with their thresholds, cost jumps only with cost.read, the other modules' summaries only
 *     for their readers
 *   · 19.05: short history, the moving average and the seasonal index from real movements, the stored forecast
 *   · the admin bell's counts
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import {
  auditEvents,
  costLayers,
  employees,
  employeeRoles,
  orders,
  priceChanges,
  purchaseOrders,
  reorderSuggestions,
  staffTasks,
  stockLevels,
  stockMovements,
  supportTickets,
  ticketMessages,
  workflowRuns,
  workflows,
} from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { unusualTransactions } from "~/server/services/admin/automation/anomalies.server";
import { DAY_MS, HOUR_MS, KEYWORD_RULES, changeBpsOf, evaluate, latinDigits, parseWhole, type OrderFacts, type OrderMatch, type PriceFacts, type StockFacts, type TicketFacts } from "~/server/services/admin/automation/catalog";
import { looseValues, parseDefinition, readStored, ruleRawFromForm, type RuleRaw } from "~/server/services/admin/automation/definition";
import { waitingEpisodes } from "~/server/services/admin/automation/events.server";
import { FORECAST, forecastOf, historyMonthsOf, monthKey, monthStart } from "~/server/services/admin/automation/forecast";
import { demandForecast, storeDemandForecasts } from "~/server/services/admin/automation/forecast.server";
import { countNotices, getRun, listNoticeGroups, listNotices, listRuns, markNoticeSeen, markRuleNoticesSeen } from "~/server/services/admin/automation/log.server";
import { automationOverview, automationQueueCounts } from "~/server/services/admin/automation/overview.server";
import { activateRule, dryRunRule, getRule, listRules, pauseRule, saveRule } from "~/server/services/admin/automation/rules.server";
import { runAutomation } from "~/server/services/admin/automation/runner.server";
import { createDraftOrder, dismissSuggestion, draftOrderForm, listSuggestions, scanStockOuts } from "~/server/services/admin/automation/suggestions.server";
import { suggestTopic, ticketSuggestions } from "~/server/services/admin/automation/tickets.server";
import { parseRuleFilters, parseRunFilters, parseSuggestionFilters, parseForecastFilters } from "~/server/services/admin/automation/types";
import { cancelPurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { createSupplier } from "~/server/services/admin/purchasing/suppliers.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  await seedDemo(t.db, NOW - 120 * DAY_MS);
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

type Person = { id: string; actor: EmployeeActor };
async function person(role: DefaultRoleKey, extra: Partial<EmployeeActor> = {}): Promise<Person> {
  const id = await make.employee({ name: `${role} ${make.next("p")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const permissions = role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  return { id, actor: { kind: "employee", id, permissions, label: role, ...extra } };
}
async function custom(permissions: Permission[], extra: Partial<EmployeeActor> = {}): Promise<Person> {
  const id = await make.employee({ name: `custom ${make.next("c")}` });
  return { id, actor: { kind: "employee", id, permissions: new Set<string>(permissions), label: "custom", ...extra } };
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
const fieldsOf = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.fields ?? {};
const key = () => `k_${newId("idem").slice(4)}_0123456789`;
const count = async (table: string, where = "1 = 1") => Number((await t.d1.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())?.n ?? 0);

let owner: Person;
let managerA: Person;
let managerB: Person;
let finance: Person;
let clerk: Person;
let cashier: Person;
let support: Person;
let worker: Person;

beforeAll(async () => {
  owner = await person("owner");
  managerA = await person("manager");
  managerB = await person("manager");
  finance = await person("finance");
  clerk = await person("inventory");
  cashier = await person("cashier");
  support = await person("support");
  worker = await person("fulfillment");
}, 60_000);

const orderRule = (overrides: Partial<RuleRaw> = {}, match: Record<string, unknown> = {}): RuleRaw => ({
  name: `طلبات كبيرة ${make.next("r")}`,
  event: "order.placed",
  match: { channel: "web", paymentMethods: ["cod"], minTotal: "٥٠٠٠٠٠", ...match },
  actions: { staff_task: { assigneeId: worker.id, priority: "high", dueHours: "٤", note: "اتصل بالعميل" }, notify: { audience: "automation.workflow.read" }, flag_order: true },
  ...overrides,
});

async function order(at: number, overrides: Partial<typeof orders.$inferInsert> = {}, price = 600_000) {
  const product = await make.product({ priceIqd: price, stock: 5 });
  return make.order([{ variantId: product.variantId, sku: product.sku, unitPriceIqd: price }], { placedAt: at, channel: "web", paymentMethod: "cod", ...overrides });
}

/** A rule saved by A, dry-run by A and switched on by B at `at`. */
async function activeRule(raw: RuleRaw, at: number): Promise<string> {
  const { ruleId } = await saveRule(t.db, managerA.actor, { definition: raw, idempotencyKey: key() }, at - 3 * HOUR_MS);
  let row = await t.db.select().from(workflows).where(eq(workflows.id, ruleId)).get();
  await dryRunRule(t.db, managerA.actor, { ruleId, days: 7, expectedUpdatedAt: row!.updatedAt }, at - 2 * HOUR_MS);
  row = await t.db.select().from(workflows).where(eq(workflows.id, ruleId)).get();
  await activateRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: row!.updatedAt, reason: "راجعتُ المحاكاة" }, at);
  return ruleId;
}
const updatedAt = async (ruleId: string) => (await t.db.select({ updatedAt: workflows.updatedAt }).from(workflows).where(eq(workflows.id, ruleId)).get())!.updatedAt;

// ───────────────────────────────────────────────────────────────── pure

describe("the fixed catalogue (pure)", () => {
  const orderFacts: OrderFacts = { ref: "TT-1", channel: "web", paymentMethod: "cod", totalIqd: 600_000, governorateId: "gov_baghdad", status: "new", reviewStatus: "none", isDemo: false };
  test("orders: channel, payment method, minimum total, governorate and demo records, the first failing condition named", () => {
    const match: OrderMatch = { channel: "web", paymentMethods: ["cod"], minTotalIqd: 500_000, governorateId: null, includeDemo: false };
    expect(evaluate("order.placed", orderFacts, match)).toEqual({ matched: true });
    expect(evaluate("order.placed", { ...orderFacts, channel: "pos" }, match)).toEqual({ matched: false, failed: "channel" });
    expect(evaluate("order.placed", { ...orderFacts, paymentMethod: "wallet" }, match)).toEqual({ matched: false, failed: "paymentMethods" });
    expect(evaluate("order.placed", { ...orderFacts, totalIqd: 499_999 }, match)).toEqual({ matched: false, failed: "minTotal" });
    expect(evaluate("order.placed", orderFacts, { ...match, governorateId: "gov_basra" })).toEqual({ matched: false, failed: "governorate" });
    expect(evaluate("order.placed", { ...orderFacts, isDemo: true }, match)).toEqual({ matched: false, failed: "demo" });
    expect(evaluate("order.placed", { ...orderFacts, isDemo: true }, { ...match, includeDemo: true })).toEqual({ matched: true });
  });
  test("stock, tickets and prices", () => {
    const stock: StockFacts = { variantId: "v", sku: "S", locationId: "loc_main", locationCode: "MAIN", available: 1, reorderPoint: 5, incoming: 3, productKind: "game", isDemo: false };
    expect(evaluate("stock.below_reorder", stock, { locationId: null, productKinds: ["game"], onlyNothingIncoming: false, includeDemo: false }).matched).toBe(true);
    expect(evaluate("stock.below_reorder", stock, { locationId: null, productKinds: [], onlyNothingIncoming: true, includeDemo: false })).toEqual({ matched: false, failed: "incoming" });
    expect(evaluate("stock.below_reorder", stock, { locationId: "loc_other", productKinds: [], onlyNothingIncoming: false, includeDemo: false })).toEqual({ matched: false, failed: "location" });
    const ticket: TicketFacts = { ref: "SUP-1", status: "open", priority: "high", category: "payment", assignedTo: null, waitingSince: NOW, isDemo: false };
    const ticketMatch = { hours: 4, priorities: ["high" as const], categories: [], unassignedOnly: true, includeDemo: false };
    expect(evaluate("ticket.waiting", ticket, ticketMatch, NOW + 3 * HOUR_MS)).toEqual({ matched: false, failed: "hours" });
    expect(evaluate("ticket.waiting", ticket, ticketMatch, NOW + 4 * HOUR_MS).matched).toBe(true);
    expect(evaluate("ticket.waiting", { ...ticket, assignedTo: "emp_x" }, ticketMatch, NOW + 5 * HOUR_MS)).toEqual({ matched: false, failed: "unassigned" });
    const price: PriceFacts = { variantId: "v", sku: "S", oldPriceIqd: 100_000, newPriceIqd: 85_000, source: "manual", isDemo: false };
    expect(changeBpsOf(100_000, 85_000)).toBe(-1500);
    expect(changeBpsOf(null, 85_000)).toBeNull();
    expect(evaluate("price.changed", price, { direction: "down", minChangeBps: 1000, includeDemo: false }).matched).toBe(true);
    expect(evaluate("price.changed", price, { direction: "up", minChangeBps: null, includeDemo: false })).toEqual({ matched: false, failed: "direction" });
    expect(evaluate("price.changed", price, { direction: "any", minChangeBps: 2000, includeDemo: false })).toEqual({ matched: false, failed: "minChange" });
  });
  test("the builder: Arabic-Indic and Persian digits, every field error at once, actions an event does not allow, demo flag", () => {
    expect(latinDigits("٥٠٠٬٠٠٠")).toBe("500000");
    expect(parseWhole("۱۲")).toBe(12);
    expect(parseWhole("12.5")).toBeNull();
    expect(parseWhole("")).toBeUndefined();
    const parsed = parseDefinition({ name: "طلبات", event: "order.placed", match: { minTotal: "٥٠٠٠٠٠", paymentMethods: ["cod", "cod"] }, actions: { staff_task: { assigneeId: "emp_1", dueHours: "۴" } } });
    expect(parsed.match).toMatchObject({ minTotalIqd: 500_000, paymentMethods: ["cod"], channel: "any" });
    expect(parsed.actions).toEqual([{ type: "staff_task", params: { assigneeId: "emp_1", priority: "normal", dueHours: 4, note: null } }]);
    const errors = toAppError(
      (() => {
        try {
          parseDefinition({ name: "x", event: "ticket.waiting", match: { hours: "0" }, actions: { notify: { audience: "orders.order.read" }, staff_task: { assigneeId: "" } } });
        } catch (error) {
          return error;
        }
      })(),
    )?.fields;
    expect(errors).toMatchObject({ name: "too_short", hours: "out_of_range", notifyAudience: "invalid", taskAssignee: "required" });
    expect(() => parseDefinition({ name: "مخزون", event: "stock.below_reorder", match: {}, actions: { flag_order: true } })).toThrow();
    const notAllowed = toAppError(
      (() => {
        try {
          parseDefinition({ name: "مخزون", event: "stock.below_reorder", match: {}, actions: { flag_order: true } });
        } catch (error) {
          return error;
        }
      })(),
    );
    expect(notAllowed?.fields?.actions).toBe("action_not_allowed");
    const none = toAppError(
      (() => {
        try {
          parseDefinition({ name: "بلا إجراء", event: "price.changed", match: {}, actions: {} });
        } catch (error) {
          return error;
        }
      })(),
    );
    expect(none?.fields?.actions).toBe("action_required");
  });
  test("a form round trip, and a refused form shown again as typed", () => {
    const form = new FormData();
    for (const [name, value] of [
      ["name", "تذاكر"],
      ["event", "ticket.waiting"],
      ["hours", "٦"],
      ["priorities", "urgent"],
      ["unassignedOnly", "on"],
      ["act_notify", "on"],
      ["notifyAudience", "automation.suggestion.read"],
    ] as const)
      form.append(name, value);
    const parsed = parseDefinition(ruleRawFromForm(form));
    expect(parsed.match).toEqual({ hours: 6, priorities: ["urgent"], categories: [], unassignedOnly: true, includeDemo: false });
    expect(parsed.actions).toEqual([{ type: "notify", params: { audience: "automation.suggestion.read" } }]);
    form.set("hours", "lots");
    expect(looseValues(ruleRawFromForm(form))).toMatchObject({ event: "ticket.waiting", name: "تذاكر", match: { hours: 4, priorities: ["urgent"] } });
  });
  test("19.03 keyword rules: normalised like the routing rules, first topic wins, the word named", () => {
    expect(suggestTopic("أرسلت الحوالة أمس ولم تتأكد")).toEqual({ category: "payment", keyword: "حوالة" });
    expect(suggestTopic("الجهاز ما يشتغل بعد التحديث")).toEqual({ category: "repair", keyword: "ما يشتغل" });
    expect(suggestTopic("my order is late")?.category).toBe("shipping");
    expect(suggestTopic("مرحبا")).toBeNull();
    expect(new Set(KEYWORD_RULES.map((rule) => rule.category)).size).toBe(KEYWORD_RULES.length);
  });
  test("19.05 the forecast method: short history, no recent sales, the moving average, the season index bounded", () => {
    expect(forecastOf({ monthly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 6, 9], historyMonths: 2, releaseAt: null, preorderUnits: 0, now: NOW }).status).toBe("short_history");
    expect(forecastOf({ monthly: [5, 5, 5, 5, 5, 5, 5, 5, 5, 0, 0, 0], historyMonths: 12, releaseAt: null, preorderUnits: 0, now: NOW }).status).toBe("no_sales");
    const plain = forecastOf({ monthly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 6, 9], historyMonths: 4, releaseAt: null, preorderUnits: 0, now: NOW });
    expect(plain).toMatchObject({ status: "forecast", movingAverage: 6, seasonalIndex: null, forecast: 6 });
    const seasonal = forecastOf({ monthly: [2, 30, 2, 2, 2, 2, 2, 2, 2, 6, 6, 6], historyMonths: 12, releaseAt: NOW + 10 * DAY_MS, preorderUnits: 4, now: NOW });
    expect(seasonal).toMatchObject({ status: "forecast", movingAverage: 6, seasonalIndex: Math.round(FORECAST.indexMax * 100), sameMonthLastYear: 30, forecast: 12, launch: "upcoming" });
    expect(historyMonthsOf(null, NOW)).toBe(0);
    expect(historyMonthsOf(monthStart(NOW, -3), NOW)).toBe(3);
    expect(historyMonthsOf(monthStart(NOW, -3) + 1, NOW)).toBe(2);
    expect(monthKey(Date.UTC(2026, 11, 31, 22, 0, 0))).toBe("2027-01");
  });
  test("a ticket's waiting episodes: from the opening or a customer's message to the next staff reply", () => {
    const episodes = waitingEpisodes({ createdAt: 0, endedAt: null }, [
      { authorKind: "customer", createdAt: 10 },
      { authorKind: "employee", createdAt: 20 },
      { authorKind: "employee", createdAt: 25 },
      { authorKind: "customer", createdAt: 30 },
    ], 100);
    expect(episodes).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: null },
    ]);
    expect(waitingEpisodes({ createdAt: 0, endedAt: 50 }, [], 100)).toEqual([{ start: 0, end: 50 }]);
  });
});

// ───────────────────────────────────────────────────────────────── authorization

describe("authorization per role", () => {
  test("rules: readers, writers, branch limits; checked before the input", async () => {
    for (const who of [owner, managerA]) expect((await listRules(t.db, who.actor, parseRuleFilters(new URLSearchParams()), NOW)).page).toBe(1);
    for (const who of [finance, clerk, cashier, support]) expect(await code(() => listRules(t.db, who.actor, parseRuleFilters(new URLSearchParams()), NOW))).toBe("forbidden");
    expect(await code(() => saveRule(t.db, finance.actor, { definition: {} as RuleRaw }, NOW))).toBe("forbidden");
    const limited = await person("manager", { branchId: "br_x" });
    expect(await code(() => saveRule(t.db, limited.actor, { definition: orderRule(), idempotencyKey: key() }, NOW))).toBe("branch_limited");
    expect(await code(() => runAutomation(t.db, NOW, { triggeredBy: limited.actor }))).toBe("branch_limited");
    expect(await code(() => runAutomation(t.db, NOW, { triggeredBy: clerk.actor }))).toBe("forbidden");
  });
  test("suggestions, forecast, anomalies, tickets and notices each need their own permission", async () => {
    expect((await listSuggestions(t.db, clerk.actor, parseSuggestionFilters(new URLSearchParams()), "ar")).page).toBe(1);
    expect(await code(() => listSuggestions(t.db, support.actor, parseSuggestionFilters(new URLSearchParams()), "ar"))).toBe("forbidden");
    expect(await code(() => scanStockOuts(t.db, clerk.actor, NOW))).toBe("forbidden");
    expect((await demandForecast(t.db, clerk.actor, parseForecastFilters(new URLSearchParams()), "ar", NOW)).page).toBe(1);
    expect(await code(() => demandForecast(t.db, cashier.actor, parseForecastFilters(new URLSearchParams()), "ar", NOW))).toBe("forbidden");
    expect((await unusualTransactions(t.db, finance.actor, { demo: false }, "ar", NOW)).checks.length).toBe(4);
    expect(await code(() => unusualTransactions(t.db, clerk.actor, { demo: false }, "ar", NOW))).toBe("forbidden");
    expect((await ticketSuggestions(t.db, managerA.actor, { view: "all" }, NOW)).rows).toBeDefined();
    const rulesOnly = await custom(["automation.workflow.read"]);
    expect(await code(() => ticketSuggestions(t.db, rulesOnly.actor, { view: "all" }, NOW))).toBe("forbidden");
    // 19.03: a phone number a customer typed into a subject is masked without customer.phone.read_full
    await t.db.insert(supportTickets).values({ id: newId("tkt"), ref: make.next("SUP"), subject: "حوالة ما وصلت اتصلوا 07701234567", category: "order", status: "open", createdAt: NOW, updatedAt: NOW, lastMessageAt: NOW });
    const reader = await custom(["automation.workflow.read", "support.ticket.read"]);
    const masked = (await ticketSuggestions(t.db, reader.actor, { view: "all" }, NOW)).rows.find((row) => row.subject.includes("حوالة"));
    expect(masked?.subject).not.toContain("07701234567");
    expect(masked?.suggested).toMatchObject({ category: "payment" });
    expect((await ticketSuggestions(t.db, managerA.actor, { view: "all" }, NOW)).rows.find((row) => row.subject.includes("حوالة"))?.subject).toContain("07701234567");
    expect(await listNotices(t.db, cashier.actor, NOW)).toEqual([]);
    expect(await code(() => markNoticeSeen(t.db, cashier.actor, { runId: "wfr_abcdefghijklmnop" }, NOW))).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────── 19.01 / 19.07

describe("rules: versions, the dry run and four eyes", () => {
  test("creating is idempotent on the form's key and audited with the definition", async () => {
    const formKey = key();
    const raw = orderRule();
    const first = await saveRule(t.db, managerA.actor, { definition: raw, idempotencyKey: formKey }, NOW);
    const again = await saveRule(t.db, managerA.actor, { definition: raw, idempotencyKey: formKey }, NOW + 1000);
    expect(again).toEqual({ ruleId: first.ruleId, version: 1, replayed: true, stopped: false });
    expect(await code(() => saveRule(t.db, managerA.actor, { definition: { ...raw, name: "اسم آخر" }, idempotencyKey: formKey }, NOW))).toBe("idempotency_mismatch");
    const row = await t.db.select().from(workflows).where(eq(workflows.id, first.ruleId)).get();
    expect(row?.status).toBe("draft");
    expect(readStored(row!).meta).toMatchObject({ version: 1, author: { id: managerA.id } });
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, first.ruleId), eq(auditEvents.action, "automation.rule.create")));
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ version: 1, event: "order.placed", match: { minTotalIqd: 500_000 } });
  });

  test("a dry run counts what would happen and writes only its summary and samples; then four eyes switch it on", async () => {
    const base = NOW + 10 * DAY_MS;
    const matching = await order(base - 3 * DAY_MS);
    await order(base - 3 * DAY_MS, {}, 100_000); // under the minimum
    await order(base - 2 * DAY_MS, { isDemo: true }); // demo
    await order(base - 2 * DAY_MS, { channel: "pos" }); // another channel
    const { ruleId } = await saveRule(t.db, managerA.actor, { definition: orderRule(), idempotencyKey: key() }, base);
    expect(await code(() => activateRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: base, reason: "تفعيل" }, base))).toBe("dry_run_required");
    const tasksBefore = await count("staff_tasks");
    const result = await dryRunRule(t.db, managerA.actor, { ruleId, days: 7, expectedUpdatedAt: base }, base + 1000);
    expect(result.matched).toBeGreaterThanOrEqual(1);
    expect(result.failed).toMatchObject({ minTotal: expect.any(Number), demo: expect.any(Number), channel: expect.any(Number) });
    expect(result.actions.staff_task?.would).toBe(result.matched);
    expect(await count("staff_tasks")).toBe(tasksBefore);
    expect((await t.db.select({ reviewStatus: orders.reviewStatus }).from(orders).where(eq(orders.id, matching.orderId)).get())?.reviewStatus).toBe("none");
    const samples = await t.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ruleId), eq(workflowRuns.isDryRun, true)));
    expect(samples.length).toBe(Math.min(result.matched, 50));
    expect(samples.every((sample) => sample.actionsLog?.every((entry) => entry.outcome === "would" || entry.outcome === "would_skip"))).toBe(true);
    const detail = await getRule(t.db, managerB.actor, ruleId, "ar", base + 2000);
    expect(detail.status).toBe("dry_run");
    expect(detail.dryRun).toMatchObject({ version: 1, current: true, fresh: true });
    expect(detail.can.activate).toBe(true);
    expect((await getRule(t.db, managerA.actor, ruleId, "ar", base + 2000)).can.activateBlocked).toBe("author_cannot_activate");
    // a stale tab, then the author, then a second person
    expect(await code(() => activateRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: base, reason: "تفعيل" }, base + 3000))).toBe("rule_changed");
    const stamp = await updatedAt(ruleId);
    expect(await code(() => activateRule(t.db, managerA.actor, { ruleId, expectedUpdatedAt: stamp, reason: "تفعيل" }, base + 3000))).toBe("author_cannot_activate");
    expect(await fieldsOf(() => activateRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: stamp, reason: "" }, base + 3000))).toEqual({ reason: "reason_required" });
    expect(await activateRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: stamp, reason: "راجعتُ العينات" }, base + 3000)).toEqual({ status: "active", replayed: false });
    expect(await activateRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: stamp, reason: "مرة ثانية" }, base + 4000)).toEqual({ status: "active", replayed: true });
    expect(await count("audit_events", `entity_id = '${ruleId}' AND action = 'automation.rule.activate'`)).toBe(1);
  });

  test("a saved change is a new version, back to draft (an active rule stops), and needs a new dry run", async () => {
    const at = NOW + 20 * DAY_MS;
    const ruleId = await activeRule(orderRule(), at);
    const stamp = await updatedAt(ruleId);
    expect(await fieldsOf(() => saveRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: stamp, definition: orderRule(), reason: "" }, at + 1000))).toEqual({ reason: "reason_required" });
    const before = (await getRule(t.db, managerB.actor, ruleId, "ar", at)).name;
    expect(await fieldsOf(() => saveRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: stamp, definition: orderRule({ name: before }), reason: "لا شيء" }, at + 1000))).toEqual({ _: "no_change" });
    const saved = await saveRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: stamp, definition: orderRule({ name: before }, { minTotal: "700000" }), reason: "رفع الحد" }, at + 1000);
    expect(saved).toMatchObject({ version: 2, stopped: true });
    const detail = await getRule(t.db, managerA.actor, ruleId, "ar", at + 2000);
    expect(detail).toMatchObject({ status: "draft", version: 2 });
    expect(detail.dryRun?.current).toBe(false);
    expect(detail.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(detail.versions[0].reason).toBe("رفع الحد");
    // the author of v2 is B now: A may switch it on after a dry run, B may not
    let row = await updatedAt(ruleId);
    await dryRunRule(t.db, managerB.actor, { ruleId, days: 30, expectedUpdatedAt: row }, at + 3000);
    row = await updatedAt(ruleId);
    expect(await code(() => activateRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: row, reason: "تفعيل" }, at + 4000))).toBe("author_cannot_activate");
    // a dry run older than 7 days is not enough
    expect(await code(() => activateRule(t.db, managerA.actor, { ruleId, expectedUpdatedAt: row, reason: "تفعيل" }, at + 8 * DAY_MS))).toBe("dry_run_stale");
    expect(await activateRule(t.db, managerA.actor, { ruleId, expectedUpdatedAt: row, reason: "تفعيل" }, at + 5000)).toMatchObject({ status: "active" });
    row = await updatedAt(ruleId);
    expect(await code(() => pauseRule(t.db, clerk.actor, { ruleId, expectedUpdatedAt: row, reason: "إيقاف" }, at + 6000))).toBe("forbidden");
    expect(await pauseRule(t.db, managerB.actor, { ruleId, expectedUpdatedAt: row, reason: "مهام كثيرة" }, at + 6000)).toMatchObject({ status: "paused" });
    expect((await getRule(t.db, managerB.actor, ruleId, "ar", at + 7000)).pause?.reason).toBe("مهام كثيرة");
  });
});

// ───────────────────────────────────────────────────────────────── the runner and 19.08

describe("the runner", () => {
  const MONEY_AND_STOCK = ["stock_movements", "stock_levels", "journal_entries", "journal_lines", "wallet_ledger", "payments", "refunds", "price_changes", "cost_layers", "purchase_orders"];
  const snapshot = async () => Object.fromEntries(await Promise.all(MONEY_AND_STOCK.map(async (table) => [table, await count(table)] as const)));

  test("once per rule and event, never before it was switched on; a task, a notice and a review flag — nothing moves", async () => {
    const at = NOW + 40 * DAY_MS;
    const early = await order(at - HOUR_MS);
    const ruleId = await activeRule(orderRule(), at);
    const matching = await order(at + HOUR_MS);
    await order(at + HOUR_MS, {}, 50_000);
    const held = await order(at + 2 * HOUR_MS, { reviewStatus: "blocked" });
    const levels = await t.db.select().from(stockLevels);
    const before = await snapshot();
    const statusesBefore = await t.db.select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus }).from(orders);
    const first = await runAutomation(t.db, at + 3 * HOUR_MS, { ruleId, scan: false });
    expect(first.error).toBeNull();
    const runs = await t.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ruleId), eq(workflowRuns.isDryRun, false)));
    expect(runs.map((run) => run.refId).sort()).toEqual([matching.orderId, held.orderId].sort());
    expect(runs.some((run) => run.refId === early.orderId)).toBe(false);
    const ran = runs.find((run) => run.refId === matching.orderId)!;
    expect(ran.status).toBe("awaiting_approval");
    const task = await t.db.select().from(staffTasks).where(eq(staffTasks.id, `tsk_${ran.id.slice(4)}`)).get();
    expect(task).toMatchObject({ assignedTo: worker.id, priority: "high", status: "open", createdBy: "system:automation.run", refType: null });
    expect(task?.title).toContain(matching.ref);
    expect(task?.dueAt).toBe(at + 3 * HOUR_MS + 4 * HOUR_MS);
    expect((await t.db.select({ reviewStatus: orders.reviewStatus }).from(orders).where(eq(orders.id, matching.orderId)).get())?.reviewStatus).toBe("needs_review");
    const onHold = runs.find((run) => run.refId === held.orderId)!;
    expect(onHold.status).toBe("succeeded");
    expect(onHold.actionsLog?.find((entry) => entry.type === "flag_order")).toMatchObject({ outcome: "skipped", reason: "order_on_hold" });
    expect((await t.db.select({ reviewStatus: orders.reviewStatus }).from(orders).where(eq(orders.id, held.orderId)).get())?.reviewStatus).toBe("blocked");
    // twice in a row, and two at once: still one run (and one task) per event
    await Promise.all([runAutomation(t.db, at + 4 * HOUR_MS, { ruleId, scan: false }), runAutomation(t.db, at + 4 * HOUR_MS, { ruleId, scan: false })]);
    expect(await count("workflow_runs", `workflow_id = '${ruleId}' AND is_dry_run = 0`)).toBe(2);
    expect(await count("staff_tasks", `id = 'tsk_${ran.id.slice(4)}'`)).toBe(1);
    expect(await count("audit_events", `action = 'automation.rule.run' AND entity_id = '${ruleId}'`)).toBe(2);
    // 19.08: no stock, money, price or order state moved
    expect(await snapshot()).toEqual(before);
    expect(await t.db.select().from(stockLevels)).toEqual(levels);
    const statusesAfter = await t.db.select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus }).from(orders);
    expect(statusesAfter).toEqual(statusesBefore);
    expect((await getRule(t.db, managerA.actor, ruleId, "ar", at)).runCount).toBe(2);
  });

  test("notices: for holders of the permission until each marks it seen; the log reads them", async () => {
    const at = NOW + 50 * DAY_MS;
    const ruleId = await activeRule(orderRule({ actions: { notify: { audience: "automation.suggestion.read" } } }), at);
    const placed = await order(at + HOUR_MS);
    await runAutomation(t.db, at + 2 * HOUR_MS, { ruleId, scan: false });
    const run = (await t.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ruleId), eq(workflowRuns.refId, placed.orderId), eq(workflowRuns.isDryRun, false))).get())!;
    expect(run.status).toBe("succeeded");
    const forClerk = await listNotices(t.db, clerk.actor, at + 3 * HOUR_MS);
    expect(forClerk.map((notice) => notice.runId)).toContain(run.id);
    expect(await listNotices(t.db, support.actor, at + 3 * HOUR_MS)).toEqual([]);
    expect(await countNotices(t.db, support.actor, at)).toBeNull();
    const clerkCount = await countNotices(t.db, clerk.actor, at + 3 * HOUR_MS);
    expect(await markNoticeSeen(t.db, clerk.actor, { runId: run.id }, at + 3 * HOUR_MS)).toEqual({ replayed: false });
    expect(await markNoticeSeen(t.db, clerk.actor, { runId: run.id }, at + 3 * HOUR_MS)).toEqual({ replayed: true });
    expect(await countNotices(t.db, clerk.actor, at + 3 * HOUR_MS)).toBe((clerkCount ?? 0) - 1);
    // a manager also holds the permission and still sees it, grouped by rule; "mark all as seen" for that rule
    expect((await listNotices(t.db, managerB.actor, at + 3 * HOUR_MS)).map((notice) => notice.runId)).toContain(run.id);
    const groups = await listNoticeGroups(t.db, managerB.actor, at + 3 * HOUR_MS);
    expect(groups.find((group) => group.ruleId === ruleId)).toMatchObject({ count: 1, items: [{ runId: run.id }] });
    expect(await markRuleNoticesSeen(t.db, managerB.actor, { ruleId }, at + 3 * HOUR_MS)).toEqual({ marked: 1 });
    expect((await listNoticeGroups(t.db, managerB.actor, at + 3 * HOUR_MS)).some((group) => group.ruleId === ruleId)).toBe(false);
    expect(await code(() => markRuleNoticesSeen(t.db, managerB.actor, { ruleId }, at + 3 * HOUR_MS))).toBe("notice_unknown");
    expect(await code(() => markNoticeSeen(t.db, finance.actor, { runId: run.id }, at))).toBe("notice_unknown");
    const log = await listRuns(t.db, managerA.actor, parseRunFilters(new URLSearchParams(`rule=${ruleId}`)), at + 3 * HOUR_MS);
    expect(log.rows.map((row) => row.id)).toContain(run.id);
    const one = await getRun(t.db, managerA.actor, run.id);
    expect(one.event).toMatchObject({ type: "order.placed", label: placed.ref, href: `/admin/orders/${placed.ref}` });
    expect((await getRun(t.db, await custom(["automation.workflow.read"]).then((who) => who.actor), run.id)).event.href).toBeNull();
  });

  test("an inactive assignee fails the run; demo records only when the rule asks; a broken rule never runs", async () => {
    const at = NOW + 60 * DAY_MS;
    const helper = await person("fulfillment");
    const ruleId = await activeRule(orderRule({ actions: { staff_task: { assigneeId: helper.id, priority: "normal" } } }, { includeDemo: "" }), at);
    await t.db.update(employees).set({ status: "disabled" }).where(eq(employees.id, helper.id));
    const placed = await order(at + HOUR_MS);
    const demo = await order(at + HOUR_MS, { isDemo: true });
    const result = await runAutomation(t.db, at + 2 * HOUR_MS, { ruleId, scan: false });
    const run = (await t.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ruleId), eq(workflowRuns.refId, placed.orderId), eq(workflowRuns.isDryRun, false))).get())!;
    expect(run).toMatchObject({ status: "failed", error: "assignee_inactive" });
    expect(await count("staff_tasks", `id = 'tsk_${run.id.slice(4)}'`)).toBe(0);
    expect(await count("workflow_runs", `workflow_id = '${ruleId}' AND ref_id = '${demo.orderId}'`)).toBe(0);
    expect(result.stats.failedRuns).toBeGreaterThanOrEqual(1);
    const broken = newId("wfl");
    await t.db.insert(workflows).values({ id: broken, name: "broken", triggerEvent: "order.placed", conditions: { version: 1 }, actions: [{ type: "refund_everything" }], status: "active", createdAt: at, updatedAt: at });
    const after = await runAutomation(t.db, at + 3 * HOUR_MS, { scan: false });
    expect(after.stats.brokenRules).toBeGreaterThanOrEqual(1);
    expect(await count("workflow_runs", `workflow_id = '${broken}'`)).toBe(0);
  });

  test("tickets waiting and price changes", async () => {
    const at = NOW + 70 * DAY_MS;
    const ticketRule = await activeRule({ name: "تذاكر تنتظر", event: "ticket.waiting", match: { hours: "2" }, actions: { notify: { audience: "automation.workflow.read" } } }, at);
    const ticketId = newId("tkt");
    await t.db.insert(supportTickets).values({ id: ticketId, ref: make.next("SUP"), subject: "وين طلبي", category: "order", priority: "normal", status: "open", createdAt: at - HOUR_MS, updatedAt: at - HOUR_MS, lastMessageAt: at - HOUR_MS });
    await t.db.insert(ticketMessages).values({ id: newId("tmsg"), ticketId, authorKind: "customer", body: "وين طلبي؟", createdAt: at - HOUR_MS });
    await runAutomation(t.db, at + 30 * 60_000, { ruleId: ticketRule, scan: false });
    const ticketRuns = () => count("workflow_runs", `workflow_id = '${ticketRule}' AND ref_id = '${ticketId}' AND is_dry_run = 0`);
    expect(await ticketRuns()).toBe(0); // 1.5 h: not yet
    await runAutomation(t.db, at + 2 * HOUR_MS, { ruleId: ticketRule, scan: false });
    expect(await ticketRuns()).toBe(1);
    await runAutomation(t.db, at + 3 * HOUR_MS, { ruleId: ticketRule, scan: false });
    expect(await ticketRuns()).toBe(1); // the same wait
    await t.db.insert(ticketMessages).values({ id: newId("tmsg"), ticketId, authorKind: "employee", authorId: support.id, body: "قيد التوصيل", createdAt: at + 4 * HOUR_MS });
    await t.db.insert(ticketMessages).values({ id: newId("tmsg"), ticketId, authorKind: "customer", body: "ما زلت أنتظر", createdAt: at + 5 * HOUR_MS });
    await runAutomation(t.db, at + 8 * HOUR_MS, { ruleId: ticketRule, scan: false });
    expect(await ticketRuns()).toBe(2); // a new wait

    const priceRule = await activeRule({ name: "تخفيض كبير", event: "price.changed", match: { direction: "down", minChangePercent: "١٠" }, actions: { notify: { audience: "automation.workflow.read" } } }, at);
    const product = await make.product({ priceIqd: 100_000 });
    const big = newId("pch");
    await t.db.insert(priceChanges).values([
      { id: big, variantId: product.variantId, oldPriceIqd: 100_000, newPriceIqd: 80_000, status: "applied", createdAt: at + HOUR_MS },
      { id: newId("pch"), variantId: product.variantId, oldPriceIqd: 80_000, newPriceIqd: 76_000, status: "applied", createdAt: at + 2 * HOUR_MS },
    ]);
    await runAutomation(t.db, at + 3 * HOUR_MS, { ruleId: priceRule, scan: false });
    const priceRuns = await t.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, priceRule), eq(workflowRuns.isDryRun, false)));
    expect(priceRuns.map((run) => run.refId)).toEqual([big]);
  });
});

// ───────────────────────────────────────────────────────────────── 19.02

describe("19.02 stock-out suggestions → a draft purchase order", () => {
  async function lowSku(point = 5, qty = 10) {
    const product = await make.product({ priceIqd: 90_000, stock: 2 });
    await t.db.update(stockLevels).set({ reorderPoint: point, reorderQty: qty }).where(and(eq(stockLevels.variantId, product.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)));
    return product;
  }
  const suggestionOf = (variantId: string) => t.db.select().from(reorderSuggestions).where(eq(reorderSuggestions.variantId, variantId));

  test("one suggestion per SKU and stock episode, from 04's numbers; dismissed with a reason it does not come back", async () => {
    const sku = await lowSku();
    const scan = await scanStockOuts(t.db, managerA.actor, NOW);
    expect(scan.created).toBeGreaterThanOrEqual(1);
    const [suggestion] = await suggestionOf(sku.variantId);
    expect(suggestion).toMatchObject({ status: "open", suggestedQty: 10 });
    expect(suggestion.basis).toMatchObject({ status: "below_reorder", available: 2, reorderPoint: 5, reorderQty: 10, source: "scan", demo: false });
    expect((await scanStockOuts(t.db, managerA.actor, NOW + 1000)).created).toBe(0);
    expect(await suggestionOf(sku.variantId)).toHaveLength(1);
    const page = await listSuggestions(t.db, clerk.actor, parseSuggestionFilters(new URLSearchParams(`q=${sku.sku}`)), "ar");
    expect(page.rows[0]).toMatchObject({ variant: { sku: sku.sku }, qty: 10, status: "open" });
    expect(JSON.stringify(page)).not.toMatch(/unitCost|costIqd|landed|"minor"/);
    expect(await fieldsOf(() => dismissSuggestion(t.db, managerA.actor, { suggestionId: suggestion.id, reason: "" }, NOW))).toEqual({ reason: "reason_required" });
    expect(await code(() => dismissSuggestion(t.db, clerk.actor, { suggestionId: suggestion.id, reason: "لن نبيعه" }, NOW))).toBe("forbidden");
    expect(await dismissSuggestion(t.db, managerA.actor, { suggestionId: suggestion.id, reason: "لن نبيعه" }, NOW)).toEqual({ replayed: false });
    expect(await dismissSuggestion(t.db, managerA.actor, { suggestionId: suggestion.id, reason: "لن نبيعه" }, NOW)).toEqual({ replayed: true });
    await scanStockOuts(t.db, managerA.actor, NOW + 2000);
    const after = await suggestionOf(sku.variantId);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("dismissed");
    expect(after[0].basis).toMatchObject({ dismissReason: "لن نبيعه" });
    // a demo SKU gives a demo suggestion
    const demoSku = await make.product({ priceIqd: 90_000, stock: 0, isDemo: true });
    await t.db.update(stockLevels).set({ reorderPoint: 3, reorderQty: 6 }).where(eq(stockLevels.variantId, demoSku.variantId));
    await scanStockOuts(t.db, managerA.actor, NOW + 3000);
    expect((await suggestionOf(demoSku.variantId))[0]?.basis).toMatchObject({ demo: true, status: "out" });
  });

  test("open suggestions become ONE draft order through 09: permissions, idempotent, linked, reopened when 09 cancels it", async () => {
    const a = await lowSku(5, 8);
    const b = await lowSku(4, 6);
    await scanStockOuts(t.db, managerA.actor, NOW);
    const ids = [...(await suggestionOf(a.variantId)), ...(await suggestionOf(b.variantId))].map((row) => row.id);
    const { supplierId } = await createSupplier(t.db, managerA.actor, { code: make.next("SUP").toUpperCase(), name: "مورّد الاختبار", currency: "IQD", leadTimeDays: "5", paymentTerms: "نقداً" }, NOW);
    const form = await draftOrderForm(t.db, managerA.actor, ids, "ar");
    expect(form.lines.map((line) => line.qty).sort()).toEqual([6, 8]);
    expect(form.missingPermissions).toEqual([]);
    const blind = await draftOrderForm(t.db, (await custom(["automation.suggestion.approve", "automation.suggestion.read"])).actor, ids, "ar");
    expect(blind.missingPermissions).toEqual(expect.arrayContaining(["purchasing.po.create", "cost.read"]));
    expect(blind.lines.every((line) => line.lastUnitCost === null)).toBe(true);
    const formKey = key();
    const input = { suggestionIds: ids, supplierId, locationId: DEFAULT_LOCATION_ID, currency: "IQD", notes: "", lines: ids.map((id) => ({ suggestionId: id, qty: "", unitCost: "٢٥٠٠٠" })), idempotencyKey: formKey };
    const noCost = await custom(["automation.suggestion.approve", "purchasing.po.create"]);
    expect(await code(() => createDraftOrder(t.db, noCost.actor, input, NOW))).toBe("forbidden");
    expect(await code(() => createDraftOrder(t.db, clerk.actor, input, NOW))).toBe("forbidden");
    const made = await createDraftOrder(t.db, managerA.actor, input, NOW, "ar");
    expect(made).toMatchObject({ replayed: false, linked: 2 });
    const po = await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, made.poId)).get();
    expect(po).toMatchObject({ status: "draft", supplierId, isDemo: false });
    const linked = await t.db.select().from(reorderSuggestions).where(eq(reorderSuggestions.purchaseOrderId, made.poId));
    expect(linked.map((row) => row.status)).toEqual(["approved", "approved"]);
    expect(await createDraftOrder(t.db, managerA.actor, input, NOW + 1000, "ar")).toMatchObject({ poId: made.poId, replayed: true, linked: 0 });
    expect(await count("purchase_orders", `id = '${made.poId}'`)).toBe(1);
    // nothing in stock or the books moved
    expect(await count("stock_movements", `ref_id = '${made.poId}'`)).toBe(0);
    // 09 cancels the draft: the next scan opens the suggestions again
    await cancelPurchaseOrder(t.db, managerA.actor, { poId: made.poId, reason: "مورّد آخر" }, NOW + 2000);
    const reopened = await scanStockOuts(t.db, managerA.actor, NOW + 3000);
    expect(reopened.reopened).toBeGreaterThanOrEqual(2);
    expect((await suggestionOf(a.variantId))[0]).toMatchObject({ status: "open", purchaseOrderId: null });
  });

  test("a stock rule's purchase suggestion is the same suggestion (never a second one)", async () => {
    const at = NOW + 80 * DAY_MS;
    const sku = await lowSku(5, 12);
    const ruleId = await activeRule({ name: "مخزون منخفض", event: "stock.below_reorder", match: {}, actions: { suggest_purchase: true, notify: { audience: "automation.suggestion.read" } } }, at);
    await runAutomation(t.db, at + HOUR_MS, { ruleId, scan: false });
    const run = await t.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ruleId), eq(workflowRuns.refId, `${sku.variantId}:${DEFAULT_LOCATION_ID}`), eq(workflowRuns.isDryRun, false))).get();
    expect(run?.status).toBe("awaiting_approval");
    expect(run?.actionsLog?.find((entry) => entry.type === "suggest_purchase")).toMatchObject({ outcome: "done", detail: { qty: 12 } });
    await scanStockOuts(t.db, managerA.actor, at + 2 * HOUR_MS);
    expect(await suggestionOf(sku.variantId)).toHaveLength(1);
    await runAutomation(t.db, at + 3 * HOUR_MS, { ruleId, scan: false });
    expect(await count("workflow_runs", `workflow_id = '${ruleId}' AND ref_id = '${sku.variantId}:${DEFAULT_LOCATION_ID}' AND is_dry_run = 0`)).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── 19.04 / 19.05

describe("19.04 unusual transactions", () => {
  test("large refunds and discounts by their thresholds; cost jumps only with cost.read; other modules only for their readers", async () => {
    const big = await order(NOW - 2 * DAY_MS, {}, 900_000);
    const payment = await make.payment(big.orderId, big.totalIqd);
    await t.d1.prepare("INSERT INTO refunds (id, order_id, payment_id, amount_iqd, method, reason, status, created_at) VALUES (?, ?, ?, ?, 'original', 'test', 'pending', ?)").bind(newId("rfd"), big.orderId, payment, 400_000, NOW - DAY_MS).run();
    const product = await make.product({ priceIqd: 200_000 });
    await make.order([{ variantId: product.variantId, sku: product.sku, unitPriceIqd: 200_000 }], { placedAt: NOW - DAY_MS, discountIqd: 60_000 });
    await t.db.insert(costLayers).values([
      { id: newId("cly"), variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qtyRemaining: 1, qtyReceived: 1, unitCostIqd: 100_000, receivedAt: NOW - 40 * DAY_MS, source: "purchase" },
      { id: newId("cly"), variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qtyRemaining: 1, qtyReceived: 1, unitCostIqd: 150_000, receivedAt: NOW - 5 * DAY_MS, source: "purchase" },
    ]);
    const hub = await unusualTransactions(t.db, managerA.actor, { demo: false }, "ar", NOW);
    const byCheck = Object.fromEntries(hub.checks.map((check) => [check.check, check]));
    expect(byCheck["refund.large"].findings.map((finding) => finding.label)).toContain(big.ref);
    expect(byCheck["order.discount_high"].findings.some((finding) => finding.values.discountIqd === 60_000)).toBe(true);
    expect(byCheck["cost.jump"].findings.some((finding) => finding.label === product.sku && finding.values.changeBps === 5000)).toBe(true);
    expect(hub.finance).not.toBeNull();
    expect(hub.purchasing).not.toBeNull();
    const reader = await custom(["automation.anomaly.read"]);
    const blind = await unusualTransactions(t.db, reader.actor, { demo: false }, "ar", NOW);
    expect(blind.checks.find((check) => check.check === "cost.jump")).toMatchObject({ status: "needs_cost", findings: [] });
    expect(JSON.stringify(blind)).not.toMatch(/unitCostIqd|previousIqd/);
    expect(blind.finance).toBeNull();
    expect(blind.purchasing).toBeNull();
  });
});

describe("19.05 demand forecast", () => {
  test("short history says so; a year of real sales gives the moving average and the season index; stored for next month", async () => {
    const product = await make.product({ priceIqd: 70_000, stock: 50 });
    const movements: (typeof stockMovements.$inferInsert)[] = [{ id: newId("smv"), variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, kind: "receive", qtyDelta: 500, actorKind: "system", at: monthStart(NOW, -14) }];
    for (let offset = 1; offset <= 12; offset++) movements.push({ id: newId("smv"), variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -(offset === 11 ? 20 : 4), actorKind: "system", at: monthStart(NOW, -offset) + DAY_MS });
    for (const movement of movements) await t.db.insert(stockMovements).values(movement);
    const fresh = await make.product({ priceIqd: 70_000, stock: 5 });
    await t.db.insert(stockMovements).values({ id: newId("smv"), variantId: fresh.variantId, locationId: DEFAULT_LOCATION_ID, kind: "receive", qtyDelta: 5, actorKind: "system", at: NOW - 10 * DAY_MS });
    const page = await demandForecast(t.db, clerk.actor, parseForecastFilters(new URLSearchParams(`q=${product.sku}`)), "ar", NOW);
    const row = page.rows.find((candidate) => candidate.variant.id === product.variantId)!;
    expect(row.historyMonths).toBe(12);
    expect(row.result).toMatchObject({ status: "forecast", movingAverage: 4, sameMonthLastYear: 20 });
    expect(row.result.seasonalIndex).toBe(Math.round((20 / ((11 * 4 + 20) / 12)) * 100) > 200 ? 200 : Math.round((20 / ((11 * 4 + 20) / 12)) * 100));
    const short = (await demandForecast(t.db, clerk.actor, parseForecastFilters(new URLSearchParams(`q=${fresh.sku}`)), "ar", NOW)).rows.find((candidate) => candidate.variant.id === fresh.variantId)!;
    expect(short.result).toMatchObject({ status: "short_history", forecast: null });
    const stored = await storeDemandForecasts(t.db, NOW);
    expect(stored.stats.stored).toBeGreaterThanOrEqual(1);
    const again = await storeDemandForecasts(t.db, NOW + 1000);
    expect(again.stats.stored).toBe(stored.stats.stored);
    const saved = await t.d1.prepare("SELECT qty_forecast AS qty, method FROM demand_forecasts WHERE variant_id = ? AND period = ?").bind(product.variantId, monthKey(NOW, 1)).all<{ qty: number; method: string }>();
    expect(saved.results).toHaveLength(1);
    expect(saved.results[0]).toMatchObject({ qty: row.result.forecast, method: "moving_average_3m_seasonal" });
  });
});

describe("the module's home and the admin bell", () => {
  test("counts for those they concern, null for the others", async () => {
    const at = NOW + 90 * DAY_MS;
    const { ruleId } = await saveRule(t.db, managerA.actor, { definition: orderRule(), idempotencyKey: key() }, at);
    await dryRunRule(t.db, managerA.actor, { ruleId, days: 7, expectedUpdatedAt: at }, at + 1000);
    const forB = await automationQueueCounts(t.db, managerB.actor, at + 2000);
    const forA = await automationQueueCounts(t.db, managerA.actor, at + 2000);
    expect(forB.rulesToActivate).toBe((forA.rulesToActivate ?? 0) + 1);
    expect(forB.suggestions).toBeGreaterThanOrEqual(0);
    expect(await automationQueueCounts(t.db, cashier.actor, at)).toEqual({ suggestions: null, rulesToActivate: null, notices: null });
    const clerkCounts = await automationQueueCounts(t.db, clerk.actor, at);
    expect(clerkCounts.suggestions).toBeNull();
    expect(clerkCounts.rulesToActivate).toBeNull();
    const overview = await automationOverview(t.db, finance.actor, at);
    expect(overview.figures.rules).toBeNull();
    expect(overview.access.anomalies).toBe(true);
    const ownerView = await automationOverview(t.db, owner.actor, at);
    expect(ownerView.figures.rules?.dry_run).toBeGreaterThanOrEqual(1);
  });
});

