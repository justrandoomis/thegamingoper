/**
 * Admin module 01 "dashboard" (the command centre) against a real local D1:
 *
 *   · periods: today / week (Saturday first) / month to date, and the same span before them (month cut at its end)
 *   · KPI cards exactly as docs/metrics.md defines them: paid sales (payments − refunds paid in the span; a transfer
 *     waiting for verification never counts), orders placed, open orders now and at the same moment before (from each
 *     order's own history), average basket; demo rows only on request; a branch's figures
 *   · net profit = finance's profitAndLoss, only for cost.read + profit.read, never per branch
 *   · the urgent tiles count exactly the rows their link's list shows that employee (the module's own list)
 *   · the funnel: carts → orders → paid → delivered, demo carts left out, the counter apart, no web for a branch
 *   · the activity feed: only listed actions, each by its module's read permission; reasons of cost families withheld
 *     without cost.read; branch-limited employees lose branch-scoped lines; only price fields of a snapshot
 *   · global search: each group by its module's permission and field rules (masked phones, digits only with
 *     customer.phone.read_full, availability only with inventory.stock.read, no cost anywhere)
 *   · the role views and cards per role; the routes with real signed-in sessions (403s, the home for an employee
 *     without any role, streamed cards that resolve and never reject)
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loader as activityLoader } from "~/routes/admin/dashboard/activity";
import { loader as homeLoader } from "~/routes/admin/dashboard/admin-home";
import { dashboardAdminRoutes } from "~/routes/admin/dashboard/routes";
import { loader as searchLoader } from "~/routes/admin/dashboard/search";
import { gateRuleOf } from "~/routes/admin/shell/gate.server";
import type { EmployeeActor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { branches, carts, employeeRoles, orderEvents, refunds, serials, statementLines, supportTickets } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { profitAndLoss } from "~/server/services/accounting/reports.server";
import { activityFeed, readableActions } from "~/server/services/admin/dashboard/activity.server";
import { criticalTicketsAlert, lateOrdersAlert, lowStockAlert, unmatchedPaymentsAlert, unmatchedRange } from "~/server/services/admin/dashboard/alerts.server";
import { FEED_ACTIONS, FEED_RULES } from "~/server/services/admin/dashboard/feed";
import { funnelCard } from "~/server/services/admin/dashboard/funnel.server";
import { resultCard, salesCard } from "~/server/services/admin/dashboard/kpis.server";
import { inboxCard, moneyCard, stockCard } from "~/server/services/admin/dashboard/roles.server";
import { globalSearch } from "~/server/services/admin/dashboard/search.server";
import { dashboardAccess, effectiveBranch, settle, viewAccess } from "~/server/services/admin/dashboard/shared.server";
import { cleanQuery, compare, dashboardSearch, DAY_MS, parseDashboardFilters, periodSpans, weekStartOf, type DashboardFilters } from "~/server/services/admin/dashboard/types";
import { listStatementLines } from "~/server/services/admin/finance/settlements.server";
import { listStock, parseStockFilters } from "~/server/services/admin/inventory/stock.server";
import { listOrders } from "~/server/services/admin/orders/list.server";
import { parseListFilters } from "~/server/services/admin/orders/types";
import { listInbox } from "~/server/services/admin/support/inbox.server";
import { parseInboxFilters } from "~/server/services/admin/support/types";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const ORIGIN = "http://localhost:5173";
const HOUR = 60 * 60 * 1000;
const BAGHDAD = 3 * HOUR;
let t: TestDb;
let make: Fixtures;

const actorOf = (role: DefaultRoleKey, extra: Partial<EmployeeActor> = {}): EmployeeActor => ({ kind: "employee", id: `emp_dash_${role}`, permissions: defaultRolePermissions(role), label: role, ...extra });
const custom = (permissions: Permission[], extra: Partial<EmployeeActor> = {}): EmployeeActor => ({ kind: "employee", id: "emp_dash_custom", permissions, label: "custom", ...extra });
const filters = (patch: Partial<DashboardFilters> = {}): DashboardFilters => ({ period: "today", view: "overview", demo: false, branch: null, ...patch });
const keysOf = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) for (const item of value) keysOf(item, found);
  else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) {
    found.push(key);
    keysOf(inner, found);
  }
  return found;
};
const COST_KEY = /cost|margin|profit|landed|acquisition|proof|hash|token|secret/i;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, TEST_NOW);
  await seedRoles(t.db, TEST_NOW);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── periods and URL state

describe("periods and comparison (01.04)", () => {
  test("today, this week from Saturday and this month, each against the same span of the period before (Iraq time)", () => {
    const now = TEST_NOW; // 10 November 2026, 09:00 Baghdad
    const today = periodSpans("today", now);
    expect(today.current).toEqual({ from: Date.UTC(2026, 10, 10) - BAGHDAD, to: now + 1 });
    expect(today.previous).toEqual({ from: today.current.from - DAY_MS, to: today.current.from - DAY_MS + (now + 1 - today.current.from) });

    const week = periodSpans("week", now);
    expect(new Date(week.current.from + BAGHDAD).getUTCDay()).toBe(6); // a Saturday
    expect(new Date(week.current.from + BAGHDAD).getUTCHours()).toBe(0);
    expect(now - week.current.from).toBeLessThan(7 * DAY_MS);
    expect(week.previous.from).toBe(week.current.from - 7 * DAY_MS);
    expect(week.previous.to - week.previous.from).toBe(week.current.to - week.current.from);
    // a Saturday is the first day of its own week
    expect(weekStartOf(week.current.from + HOUR)).toBe(week.current.from);

    const month = periodSpans("month", now);
    expect(month.current.from).toBe(Date.UTC(2026, 10, 1) - BAGHDAD);
    expect(month.previous.from).toBe(Date.UTC(2026, 9, 1) - BAGHDAD);
    expect(month.previous.to - month.previous.from).toBe(month.current.to - month.current.from);

    // 31 March against February: the span before is cut at the month's end, never into March
    const march31 = Date.UTC(2026, 2, 31, 9) - BAGHDAD;
    const cut = periodSpans("month", march31);
    expect(cut.previous).toEqual({ from: Date.UTC(2026, 1, 1) - BAGHDAD, to: Date.UTC(2026, 2, 1) - BAGHDAD });
    // just after midnight in Baghdad (21:00 UTC the day before) the day is already the new one
    const lateUtc = Date.UTC(2026, 10, 10, 21, 30);
    expect(periodSpans("today", lateUtc).current.from).toBe(Date.UTC(2026, 10, 11) - BAGHDAD);
  });

  test("a comparison is never invented: unknown figures give none, a zero before gives no ratio", () => {
    expect(compare(150, 100)).toEqual({ delta: 50, ratioBps: 5000 });
    expect(compare(50, 100)).toEqual({ delta: -50, ratioBps: -5000 });
    expect(compare(10, 0)).toEqual({ delta: 10, ratioBps: null });
    expect(compare(0, 0)).toEqual({ delta: 0, ratioBps: null });
    expect(compare(null, 10)).toBeNull();
    expect(compare(10, null)).toBeNull();
    expect(compare(-20, -40)).toEqual({ delta: 20, ratioBps: 5000 });
  });

  test("the page's URL state: unknown values dropped, defaults left out of links", () => {
    expect(parseDashboardFilters(new URLSearchParams("period=week&view=finance&demo=1&branch=br_1"))).toEqual({ period: "week", view: "finance", demo: true, branch: "br_1" });
    expect(parseDashboardFilters(new URLSearchParams("period=year&view=boss&demo=yes&branch=%3Cscript%3E"))).toEqual({ period: "today", view: "overview", demo: false, branch: null });
    expect(dashboardSearch(filters())).toBe("");
    expect(dashboardSearch(filters({ period: "month", demo: true }))).toBe("?period=month&demo=1");
    expect(cleanQuery("  ٠٧٧٠ ۱۲۳‮٤٥٦٧  ")).toBe("0770 1234567");
    expect(cleanQuery("x".repeat(200))).toHaveLength(60);
    expect(cleanQuery(42)).toBe("");
  });

  test("a card's failure resolves to { ok: false } — it never rejects (the page says so, never a 0)", async () => {
    const failing = await settle("test", async () => {
      throw new Error("boom");
    });
    expect(failing).toEqual({ ok: false });
    expect(await settle("test", async () => 7)).toEqual({ ok: true, data: 7 });
  });
});

// ───────────────────────────────────────────────────────────────── KPIs (01.01)

describe("KPI cards follow docs/metrics.md (01.01)", () => {
  let branchId: string;
  beforeAll(async () => {
    const now = TEST_NOW;
    branchId = "br_dash_test";
    await t.db.insert(branches).values({ id: branchId, code: "DASH-1", name: { ar: "فرع الاختبار" }, createdAt: now });
    const product = await make.product({ priceIqd: 100_000, stock: 50 });
    const at = (ms: number) => ({ placedAt: ms });
    // A: today, paid by cash on delivery, then partly refunded — delivered (not open)
    const a = await make.order([{ ...product, unitPriceIqd: 100_000 }], { ...at(now - HOUR), status: "delivered" });
    const payA = await make.payment(a.orderId, a.totalIqd, { method: "cod", status: "paid", paidAt: now - 30 * 60 * 1000 });
    await t.db.insert(refunds).values({ id: "rfd_dash_a", orderId: a.orderId, paymentId: payA, amountIqd: 20_000, method: "cash", status: "paid", createdAt: now - 15 * 60 * 1000, paidAt: now - 10 * 60 * 1000 });
    // B: today, a transfer waiting for verification — not paid sales; a branch's order; open (confirmed)
    const b = await make.order([{ ...product, unitPriceIqd: 200_000 }], { ...at(now - 2 * HOUR), status: "confirmed", discountIqd: 10_000, branchId });
    await make.payment(b.orderId, b.totalIqd, { method: "bank_transfer", status: "pending_verification" });
    // C: today, cancelled — an order placed, not in the basket
    await make.order([{ ...product, unitPriceIqd: 50_000 }], { ...at(now - 3 * HOUR), status: "cancelled" });
    // D: yesterday before the same time, paid then — the span before; shipped (open, no history recorded)
    const d = await make.order([{ ...product, unitPriceIqd: 300_000 }], { ...at(now - 25 * HOUR), status: "shipped" });
    await make.payment(d.orderId, d.totalIqd, { method: "cod", status: "paid", paidAt: now - 24.5 * HOUR });
    // yesterday AFTER the same time: in neither span
    const late = await make.order([{ ...product, unitPriceIqd: 70_000 }], { ...at(now - 20 * HOUR), status: "delivered" });
    await make.payment(late.orderId, late.totalIqd, { method: "cod", status: "paid", paidAt: now - 20 * HOUR });
    // E: today, demo — left out unless asked for
    const e = await make.order([{ ...product, unitPriceIqd: 900_000 }], { ...at(now - HOUR), status: "delivered", isDemo: true });
    await make.payment(e.orderId, e.totalIqd, { method: "cod", status: "paid", paidAt: now - HOUR });
    // F: placed 3 days ago as "new", delivered 2 hours ago — open yesterday at this time, not now
    const f = await make.order([{ ...product }], { ...at(now - 3 * DAY_MS), status: "delivered" });
    await t.db.insert(orderEvents).values([
      { id: "oev_dash_f1", orderId: f.orderId, kind: "placed", data: { status: "new" }, actorKind: "system", at: now - 3 * DAY_MS },
      { id: "oev_dash_f2", orderId: f.orderId, kind: "status_changed", data: { from: "new", to: "delivered" }, actorKind: "system", at: now - 2 * HOUR },
    ]);
    // G: cancelled 30 hours ago — open neither then nor now
    const g = await make.order([{ ...product }], { ...at(now - 3 * DAY_MS), status: "cancelled" });
    await t.db.insert(orderEvents).values([
      { id: "oev_dash_g1", orderId: g.orderId, kind: "placed", data: { status: "awaiting_payment" }, actorKind: "system", at: now - 3 * DAY_MS },
      { id: "oev_dash_g2", orderId: g.orderId, kind: "status_changed", data: { from: "awaiting_payment", to: "cancelled" }, actorKind: "system", at: now - 30 * HOUR },
    ]);
    // H: no history at all (imported), being prepared — counted with its status as it is
    await make.order([{ ...product }], { ...at(now - 5 * DAY_MS), status: "preparing" });
  });

  test("paid sales, orders placed, open orders and the average basket — now and at the same moment yesterday", async () => {
    const card = await salesCard(t.db, actorOf("finance"), filters(), TEST_NOW);
    // 105,000 arrived for A minus its 20,000 refund; B's transfer is not verified; E is demo
    expect(card.paidSales).toEqual({ current: 85_000, previous: 305_000 });
    expect(card.ordersPlaced).toEqual({ current: 3, previous: 1 });
    // (100,000 − 0 + 200,000 − 10,000) ÷ 2 — the cancelled order and delivery fees left out
    expect(card.averageBasket).toEqual({ current: 145_000, previous: 300_000 });
    // now: B (confirmed), D (shipped), H (preparing); yesterday at this time: D, F (still new then), H
    expect(card.openOrders).toEqual({ current: 3, previous: 3 });
  });

  test("demo rows only when asked for, and a branch's own orders only", async () => {
    const withDemo = await salesCard(t.db, actorOf("finance"), filters({ demo: true }), TEST_NOW);
    expect(withDemo.paidSales.current).toBe(85_000 + 905_000);
    expect(withDemo.ordersPlaced.current).toBe(4);
    const branch = await salesCard(t.db, actorOf("finance"), filters({ branch: branchId }), TEST_NOW);
    expect(branch.ordersPlaced).toEqual({ current: 1, previous: 0 });
    expect(branch.paidSales).toEqual({ current: 0, previous: 0 });
    expect(branch.averageBasket).toEqual({ current: 190_000, previous: null });
  });

  test("the cards need dashboard.sales.read; net profit needs cost.read AND profit.read and is finance's own figure", async () => {
    await expect(salesCard(t.db, actorOf("inventory"), filters(), TEST_NOW)).rejects.toMatchObject({ status: 403 });
    await expect(resultCard(t.db, custom(["dashboard.sales.read", "cost.read"]), filters(), TEST_NOW)).rejects.toMatchObject({ status: 403 });
    await expect(resultCard(t.db, custom(["dashboard.sales.read", "profit.read"]), filters(), TEST_NOW)).rejects.toMatchObject({ status: 403 });
    const finance = actorOf("finance");
    const card = await resultCard(t.db, finance, filters({ period: "month" }), TEST_NOW);
    const spans = periodSpans("month", TEST_NOW);
    const pnl = await profitAndLoss(t.db, finance, { from: spans.current.from, to: spans.current.to, includeDemo: false });
    expect(card.current?.netIqd).toBe(pnl.profit?.netIqd);
    expect(card.current?.netRevenueIqd).toBe(pnl.revenue.netIqd);
    expect(card.perBranch).toBe(false);
    const perBranch = await resultCard(t.db, finance, filters({ branch: branchId }), TEST_NOW);
    expect(perBranch).toMatchObject({ perBranch: true, current: null, previous: null });
  });
});

// ───────────────────────────────────────────────────────────────── access per role (01.05)

describe("each card only for holders of its permission (01.05)", () => {
  test("built-in roles", () => {
    const of = (role: DefaultRoleKey) => dashboardAccess(actorOf(role));
    // the cashier reads stock (inventory.stock.read): the warehouse figures are theirs; no alerts, no sales, no activity
    expect(of("cashier")).toMatchObject({ overview: true, sales: false, result: false, alerts: false, lateOrders: false, lowStock: false, funnel: false, activity: false, money: false, stock: true, toPack: false, inbox: false, search: true });
    expect(of("finance")).toMatchObject({ sales: true, result: true, unmatchedPayments: true, lateOrders: true, money: true, wallet: true, activity: true, funnel: false, criticalTickets: false, inbox: false });
    expect(of("inventory")).toMatchObject({ sales: false, result: false, lowStock: true, stock: true, lateOrders: true, unmatchedPayments: false, toPack: true, activity: false });
    // support reads stock to answer customers: the warehouse view is theirs too (by permission, not by role name)
    expect(of("support")).toMatchObject({ sales: false, result: false, criticalTickets: true, inbox: true, lateOrders: true, lowStock: true, stock: true, activity: false, unmatchedPayments: false });
    expect(of("manager")).toMatchObject({ sales: true, result: true, funnel: true, activity: true, unmatchedPayments: true, lowStock: true, criticalTickets: true, money: true, stock: true, inbox: true });
    expect(viewAccess(of("cashier"))).toEqual({ overview: true, finance: false, warehouse: true, support: false });
    expect(viewAccess(of("content"))).toEqual({ overview: true, finance: false, warehouse: false, support: false });
    expect(viewAccess(of("finance"))).toEqual({ overview: true, finance: true, warehouse: true, support: false });
    expect(viewAccess(of("support"))).toEqual({ overview: true, finance: false, warehouse: true, support: true });
    expect(viewAccess(of("fulfillment"))).toEqual({ overview: true, finance: false, warehouse: true, support: false });
    // no role: nothing of the dashboard (the home still shows what waits and the sections)
    expect(Object.values(dashboardAccess(custom([])))).not.toContain(true);
  });

  test("an employee limited to a branch always gets their branch; others the one they ask for when it exists", () => {
    const options = [{ id: "br_a", code: "A", name: "A" }];
    expect(effectiveBranch(actorOf("finance", { branchId: "br_b" }), "br_a", options)).toEqual({ branch: "br_b", locked: true });
    expect(effectiveBranch(actorOf("finance"), "br_a", options)).toEqual({ branch: "br_a", locked: false });
    expect(effectiveBranch(actorOf("finance"), "br_zz", options)).toEqual({ branch: null, locked: false });
  });
});

// ───────────────────────────────────────────────────────────────── urgent action centre (01.02)

describe("the urgent tiles count what their link's list shows (01.02)", () => {
  beforeAll(async () => {
    const now = TEST_NOW;
    const low = await make.product({ priceIqd: 40_000, stock: 2 });
    void low;
    await t.db.insert(statementLines).values([
      { id: "stl_dash_1", source: "bank_card", occurredAt: now - DAY_MS, amountIqd: 50_000, reference: "BT-1", dedupeHash: "dash-1", status: "unmatched", createdAt: now },
      // older than the list's longest range: counted by no tile (the list would not show it)
      { id: "stl_dash_2", source: "zaincash", occurredAt: now - 500 * DAY_MS, amountIqd: 25_000, reference: "ZC-1", dedupeHash: "dash-2", status: "unmatched", createdAt: now },
    ]);
    await t.db.insert(supportTickets).values([
      { id: "tkt_dash_1", ref: "SP-DASH0001", subject: "الجهاز لا يعمل بعد التسليم", priority: "urgent", status: "open", phoneE164: "+9647701112233", firstResponseDueAt: now - HOUR, createdAt: now - 3 * HOUR, updatedAt: now - 3 * HOUR },
      { id: "tkt_dash_2", ref: "SP-DASH0002", subject: "سؤال عن الضمان", priority: "normal", status: "open", firstResponseDueAt: now + 5 * HOUR, createdAt: now - HOUR, updatedAt: now - HOUR },
      { id: "tkt_dash_3", ref: "SP-DASH0003", subject: "مغلقة", priority: "urgent", status: "closed", createdAt: now - DAY_MS, updatedAt: now - DAY_MS },
    ]);
  });

  test("late orders, mismatched payments, low stock and urgent tickets: the number is the list's total for that employee", async () => {
    const manager = actorOf("manager");
    const now = TEST_NOW;
    const late = await lateOrdersAlert(t.db, manager, "ar", now);
    const lateList = await listOrders(t.db, manager, parseListFilters(new URL(late.href, ORIGIN).searchParams), "ar", now);
    expect(late.count).toBe(lateList.total);
    expect(late.href).toMatch(/^\/admin\/orders\?/);

    const unmatched = await unmatchedPaymentsAlert(t.db, manager, now);
    const range = unmatchedRange(now);
    const lines = await listStatementLines(t.db, manager, { ...range, source: null, status: "unmatched", q: "", page: 1 });
    expect(unmatched.count).toBe(lines.total);
    expect(unmatched.count).toBe(1);
    expect(unmatched.href).toBe(`/admin/finance/settlements?from=${range.from}&to=${range.to}&status=unmatched`);
    expect(unmatched.rows[0]).toMatchObject({ label: "BT-1", code: "bank_card", amountIqd: 50_000 });

    const low = await lowStockAlert(t.db, manager, "ar");
    const stock = await listStock(t.db, manager, parseStockFilters(new URL(low.href, ORIGIN).searchParams), "ar");
    expect(low.count).toBe(stock.total);
    expect(low.count).toBeGreaterThan(0);
    expect(low.rows[0]?.qty).toBeLessThanOrEqual(3);

    const tickets = await criticalTicketsAlert(t.db, manager, now);
    const inbox = await listInbox(t.db, manager, parseInboxFilters(new URL(tickets.href, ORIGIN).searchParams), now);
    expect(tickets.count).toBe(inbox.total);
    expect(tickets.count).toBe(1);
    expect(tickets.rows[0]).toMatchObject({ label: "SP-DASH0001", code: "late" });
    expect(tickets.extra?.count).toBe(inbox.counts.late);
  });

  test("a tile is refused without its module's permission (the page never asks: dashboardAccess)", async () => {
    await expect(lateOrdersAlert(t.db, actorOf("cashier"), "ar", TEST_NOW)).rejects.toMatchObject({ status: 403 });
    await expect(unmatchedPaymentsAlert(t.db, actorOf("support"), TEST_NOW)).rejects.toMatchObject({ status: 403 });
    await expect(lowStockAlert(t.db, custom(["inventory.stock.read"]), "ar")).rejects.toMatchObject({ status: 403 }); // no dashboard.alerts.read
    await expect(criticalTicketsAlert(t.db, actorOf("finance"), TEST_NOW)).rejects.toMatchObject({ status: 403 });
  });

  test("no tile, row or role card carries a cost, a margin or a full phone", async () => {
    const support = actorOf("support");
    const tiles = [await lateOrdersAlert(t.db, support, "ar", TEST_NOW), await criticalTicketsAlert(t.db, support, TEST_NOW)];
    const inventory = actorOf("inventory");
    tiles.push(await lowStockAlert(t.db, inventory, "ar"));
    const stock = await stockCard(t.db, inventory, TEST_NOW);
    const all = JSON.stringify([tiles, stock]);
    expect(keysOf(JSON.parse(all)).filter((key) => COST_KEY.test(key))).toEqual([]);
    expect(all).not.toContain("+9647701112233");
  });
});

// ───────────────────────────────────────────────────────────────── role cards (01.05)

describe("role cards", () => {
  test("money held and owed: metrics §5, the wallet only with finance.wallet.read, links only to pages the employee may open", async () => {
    const card = await moneyCard(t.db, actorOf("finance"), { demo: false });
    expect(card.transfersAwaiting.count).toBeGreaterThanOrEqual(1);
    expect(card.walletLiability).not.toBeNull();
    expect(card.links).toMatchObject({ cod: "/admin/finance/settlements", transfers: "/admin/orders/proofs", refunds: "/admin/orders/refunds", wallet: "/admin/finance/wallets" });
    const reader = await moneyCard(t.db, custom(["finance.report.read"]), { demo: false });
    expect(reader.walletLiability).toBeNull();
    expect(reader.links).toEqual({ cod: null, transfers: null, refunds: null, wallet: null });
    await expect(moneyCard(t.db, actorOf("support"), { demo: false })).rejects.toMatchObject({ status: 403 });
  });

  test("stock: the inventory module's figures, decisions only for who may take them; inbox: the support views", async () => {
    const inventory = await stockCard(t.db, actorOf("inventory"), TEST_NOW);
    expect(inventory.countsToApprove).toBeNull(); // the inventory role cannot approve counts
    expect(inventory.toPack).not.toBeNull();
    const reader = await stockCard(t.db, custom(["inventory.stock.read"]), TEST_NOW);
    expect(reader.toPack).toBeNull();
    expect(reader.transfersInTransit).toBeNull();
    const inbox = await inboxCard(t.db, actorOf("support"), TEST_NOW);
    expect(inbox.late).toBeGreaterThanOrEqual(1);
    expect(inbox.unassigned).not.toBeNull();
    const readOnly = await inboxCard(t.db, custom(["support.ticket.read"]), TEST_NOW);
    expect(readOnly.unassigned).toBeNull();
    await expect(inboxCard(t.db, actorOf("finance"), TEST_NOW)).rejects.toMatchObject({ status: 403 });
  });
});

// ───────────────────────────────────────────────────────────────── funnel (01.03)

describe("the funnel from real records (01.03)", () => {
  test("carts → orders → paid → delivered in one cohort; demo carts left out; the counter apart; no web for a branch", async () => {
    const now = TEST_NOW;
    const product = await make.product({ priceIqd: 60_000, stock: 20 });
    const paidDelivered = await make.order([{ ...product }], { placedAt: now - HOUR, status: "delivered", paidIqd: 65_000, deliveredAt: now - 30 * 60 * 1000 });
    const paidOnly = await make.order([{ ...product }], { placedAt: now - HOUR, status: "confirmed", paidIqd: 65_000 });
    const demoOrder = await make.order([{ ...product }], { placedAt: now - HOUR, status: "confirmed", isDemo: true });
    const counter = await make.order([{ ...product }], { placedAt: now - HOUR, status: "delivered", channel: "pos", paidIqd: 65_000, deliveredAt: now - HOUR, contactPhoneE164: null });
    void counter;
    const cart = (id: string, createdAt: number, convertedOrderId: string | null = null) => ({ id, tokenHash: `hash-${id}`, createdAt, updatedAt: createdAt, convertedOrderId });
    await t.db.insert(carts).values([
      cart("crt_dash_1", now - 2 * HOUR, paidDelivered.orderId),
      cart("crt_dash_2", now - 2 * HOUR, paidOnly.orderId),
      cart("crt_dash_3", now - 2 * HOUR),
      cart("crt_dash_4", now - 2 * HOUR),
      cart("crt_dash_5", now - 2 * HOUR, demoOrder.orderId),
      cart("crt_dash_6", now - 26 * HOUR), // yesterday, before the same time
    ]);
    const card = await funnelCard(t.db, actorOf("manager"), filters(), now);
    expect(card.web?.current).toEqual({ carts: 4, orders: 2, paid: 2, delivered: 1 });
    expect(card.web?.previous.carts).toBe(1);
    expect(card.counter.current).toMatchObject({ carts: null, orders: 1, paid: 1, delivered: 1 });
    const withDemo = await funnelCard(t.db, actorOf("manager"), filters({ demo: true }), now);
    expect(withDemo.web?.current).toMatchObject({ carts: 5, orders: 3 });
    const branch = await funnelCard(t.db, actorOf("manager"), filters({ branch: "br_dash_test" }), now);
    expect(branch.web).toBeNull();
    await expect(funnelCard(t.db, actorOf("finance"), filters(), now)).rejects.toMatchObject({ status: 403 });
  });
});

// ───────────────────────────────────────────────────────────────── activity feed (01.07)

describe("the activity feed (01.07)", () => {
  beforeAll(async () => {
    const now = TEST_NOW;
    const owner: EmployeeActor = { kind: "employee", id: "emp_dash_owner", permissions: ["*"], label: "مالك الاختبار" };
    const product = await make.product({ priceIqd: 500_000 });
    const event = (action: string, extra: Record<string, unknown> = {}, at = now) => audit(t.db, { actor: owner, action, at, ...extra });
    await event("catalog.product.update", { entityType: "product", entityId: product.productId }, now - 7_000);
    await event("pricing.price.change", { entityType: "variant", entityId: product.variantId, summary: product.sku, before: { priceIqd: 500_000, compareAtIqd: null, costIqd: 410_000 }, after: { priceIqd: 450_000, changeId: "pch_x", marginBps: 1200 }, reason: "عرض الأسبوع" }, now - 6_000);
    await event("returns.rma.approve", { entityType: "return", entityId: "ret_dash", summary: "RMA-DASH0001", before: { status: "requested" }, after: { status: "approved" } }, now - 5_000);
    await event("purchasing.po.approve", { entityType: "purchase_order", entityId: "po_dash", summary: "PO-DASH0001", reason: "سعر المورد 1,200 دولار" }, now - 4_000);
    await event("finance.expense.approve", { entityType: "expense", entityId: "exp_dash", after: { amountIqd: 120_000 } }, now - 3_000);
    await event("staff.leave.approve", { entityType: "leave_request", entityId: "lvr_dash" }, now - 2_000);
    await event("settings.change.approve", { entityType: "setting", entityId: "returns.window_days" }, now - 1_000);
  });

  test("only listed actions, each line by the module permission of its record", async () => {
    const all = await activityFeed(t.db, { kind: "employee", id: "emp_dash_owner", permissions: ["*"] }, { kind: null, before: null });
    const actions = all.lines.map((line) => line.action);
    expect(actions).toEqual(expect.arrayContaining(["pricing.price.change", "returns.rma.approve", "purchasing.po.approve", "finance.expense.approve", "staff.leave.approve", "settings.change.approve"]));
    expect(actions).not.toContain("catalog.product.update");
    for (const action of actions) expect(FEED_ACTIONS).toContain(action);
    // newest first
    expect(all.lines.map((line) => line.seq)).toEqual([...all.lines.map((line) => line.seq)].sort((a, b) => b - a));

    // the support role has no dashboard.activity.read; given it, they see what their other permissions open
    const support = await activityFeed(t.db, custom([...defaultRolePermissions("support"), "dashboard.activity.read"]), { kind: null, before: null });
    expect(support.lines.map((line) => line.action)).toEqual(["returns.rma.approve"]);
    // kinds come from the rules the reader has (orders.order.read opens refund and transfer decisions), not from lines
    expect(support.kinds).toEqual(["return", "approval"]);

    const finance = await activityFeed(t.db, actorOf("finance"), { kind: null, before: null });
    expect(finance.lines.map((line) => line.action)).toEqual(expect.arrayContaining(["pricing.price.change", "returns.rma.approve", "purchasing.po.approve", "finance.expense.approve", "staff.leave.approve", "settings.change.approve"]));

    await expect(activityFeed(t.db, actorOf("cashier"), { kind: null, before: null })).rejects.toMatchObject({ status: 403 });
  });

  test("a price change shows the selling price before and after — never the rest of the snapshot; links and labels", async () => {
    const page = await activityFeed(t.db, actorOf("manager"), { kind: "price", before: null });
    const line = page.lines.find((entry) => entry.action === "pricing.price.change");
    expect(line?.price).toEqual({ fromIqd: 500_000, toIqd: 450_000 });
    expect(line?.record.href).toMatch(/^\/admin\/pricing\/skus\//);
    expect(line?.record.label).toMatch(/^SKU-/);
    expect(line?.reason).toBe("عرض الأسبوع");
    expect(page.lines.every((entry) => entry.kind === "price")).toBe(true);
    expect(keysOf(page).filter((key) => COST_KEY.test(key))).toEqual([]);
    const ret = (await activityFeed(t.db, actorOf("manager"), { kind: "return", before: null })).lines[0];
    expect(ret?.record).toEqual({ entity: "return", label: "RMA-DASH0001", href: "/admin/returns/RMA-DASH0001" });
  });

  test("a cost family's reason is withheld without cost.read; a branch-limited employee loses branch-scoped lines", async () => {
    const buyer = custom(["dashboard.overview.read", "dashboard.activity.read", "purchasing.po.read"]);
    const po = (await activityFeed(t.db, buyer, { kind: null, before: null })).lines.find((line) => line.action === "purchasing.po.approve");
    expect(po?.reason).toBeNull();
    const withCost = (await activityFeed(t.db, custom(["dashboard.overview.read", "dashboard.activity.read", "purchasing.po.read", "cost.read"]), { kind: null, before: null })).lines.find((line) => line.action === "purchasing.po.approve");
    expect(withCost?.reason).toBe("سعر المورد 1,200 دولار");

    const limited = actorOf("manager", { branchId: "br_dash_test" });
    const actions = (await activityFeed(t.db, limited, { kind: null, before: null })).lines.map((line) => line.action);
    expect(actions).not.toContain("purchasing.po.approve");
    expect(actions).not.toContain("staff.leave.approve");
    expect(actions).toContain("returns.rma.approve");
    expect(readableActions(limited, null).actions.filter((action) => FEED_RULES[action]?.branchScoped)).toEqual([]);
  });

  test("older pages continue where the last one stopped", async () => {
    const owner: EmployeeActor = { kind: "employee", id: "emp_dash_owner", permissions: ["*"] };
    const first = await activityFeed(t.db, owner, { kind: null, before: null }, 2);
    expect(first.lines).toHaveLength(2);
    expect(first.next).toBe(first.lines[1]?.seq);
    const second = await activityFeed(t.db, owner, { kind: null, before: first.next }, 2);
    expect(second.lines[0]?.seq).toBeLessThan(first.lines[1]?.seq ?? 0);
    const everything = await activityFeed(t.db, owner, { kind: null, before: null }, 100);
    expect([...first.lines, ...second.lines].map((line) => line.id)).toEqual(everything.lines.slice(0, 4).map((line) => line.id));
  });
});

// ───────────────────────────────────────────────────────────────── global search (01.06)

describe("global search (01.06)", () => {
  let orderRef: string;
  let serialText: string;
  let sku: string;
  const phone = "+9647705550101";
  beforeAll(async () => {
    const now = TEST_NOW;
    const product = await make.product({ priceIqd: 800_000, stock: 4, trackSerials: true });
    sku = product.sku;
    const customerId = await make.customer({ name: "رنا البصري", phoneE164: phone });
    const order = await make.order([{ ...product }], { customerId, contactName: "رنا البصري", contactPhoneE164: phone, status: "confirmed", placedAt: now - HOUR });
    orderRef = order.ref;
    serialText = "SN-DASH-77001";
    await t.db.insert(serials).values({ id: "ser_dash_1", serial: serialText, variantId: product.variantId, status: "in_stock", source: "purchase", costIqd: 610_000 });
    await t.db.insert(supportTickets).values({ id: "tkt_dash_s", ref: "SP-DASHSRCH", subject: "طلب تبديل جهاز", priority: "high", status: "open", phoneE164: phone, contactName: "رنا البصري", createdAt: now - HOUR, updatedAt: now - HOUR });
  });

  test("each group only for holders of its module's permission (null = not searched, [] = nothing found)", async () => {
    const cashier = await globalSearch(t.db, actorOf("cashier"), { q: "رنا" }, "ar", TEST_NOW);
    expect(cashier.groups.orders).toBeNull();
    expect(cashier.groups.tickets).toBeNull();
    expect(cashier.groups.customers?.length).toBeGreaterThan(0);
    const inventory = await globalSearch(t.db, actorOf("inventory"), { q: "رنا" }, "ar", TEST_NOW);
    expect(inventory.groups.customers).toBeNull();
    expect(inventory.groups.orders?.map((hit) => hit.ref)).toContain(orderRef);
    const support = await globalSearch(t.db, actorOf("support"), { q: "SP-DASHSRCH" }, "ar", TEST_NOW);
    expect(support.groups.tickets?.map((hit) => hit.ref)).toEqual(["SP-DASHSRCH"]);
    expect(support.groups.serials).toBeNull();
    await expect(globalSearch(t.db, custom(["orders.order.read"]), { q: "x" }, "ar", TEST_NOW)).rejects.toMatchObject({ status: 403 });
  });

  test("phones masked without customer.phone.read_full, and part of a number finds nothing for them", async () => {
    const cashier = await globalSearch(t.db, actorOf("cashier"), { q: "رنا" }, "ar", TEST_NOW);
    const hit = cashier.groups.customers?.find((entry) => entry.name === "رنا البصري");
    expect(hit?.phone?.full).toBe(false);
    expect(JSON.stringify(cashier)).not.toContain("5550101");
    const digits = await globalSearch(t.db, actorOf("cashier"), { q: "5550101" }, "ar", TEST_NOW);
    expect(digits.groups.customers).toEqual([]);
    const support = await globalSearch(t.db, actorOf("support"), { q: "5550101" }, "ar", TEST_NOW);
    expect(support.groups.customers?.[0]?.phone).toEqual({ display: expect.stringContaining("555"), full: true });
    expect(support.groups.orders?.map((entry) => entry.ref)).toContain(orderRef);
    // a whole number typed with Arabic-Indic digits works for everyone who searches orders
    const arabic = await globalSearch(t.db, actorOf("inventory"), { q: "٠٧٧٠٥٥٥٠١٠١" }, "ar", TEST_NOW);
    expect(arabic.groups.orders?.map((entry) => entry.ref)).toContain(orderRef);
    expect(arabic.groups.orders?.[0]?.phone?.full).toBe(false);
  });

  test("SKUs and serials never carry a cost; what is available only with inventory.stock.read; quick actions by permission", async () => {
    const content = await globalSearch(t.db, actorOf("content"), { q: sku }, "ar", TEST_NOW);
    expect(content.groups.skus?.[0]).toMatchObject({ sku, priceIqd: 800_000, available: null });
    expect(content.groups.skus?.[0]?.actions.map((action) => action.key)).toEqual(["product"]);
    const inventory = await globalSearch(t.db, actorOf("inventory"), { q: sku }, "ar", TEST_NOW);
    expect(inventory.groups.skus?.[0]?.available).toBe(4);
    expect(inventory.groups.skus?.[0]?.actions.map((action) => action.key)).toEqual(["product", "stock"]);
    const serial = await globalSearch(t.db, actorOf("inventory"), { q: serialText.toLowerCase() }, "ar", TEST_NOW);
    expect(serial.groups.serials?.[0]).toMatchObject({ serial: serialText, status: "in_stock" });
    expect(serial.groups.serials?.[0]?.actions.map((action) => action.key)).toEqual(["serial", "registry"]);
    const manager = await globalSearch(t.db, actorOf("manager"), { q: serialText }, "ar", TEST_NOW);
    expect(keysOf(manager).filter((key) => COST_KEY.test(key))).toEqual([]);
    expect(JSON.stringify(manager)).not.toContain("610000");
    // the orders module's own pack page only where packing is allowed
    const packer = await globalSearch(t.db, actorOf("fulfillment"), { q: orderRef }, "ar", TEST_NOW);
    expect(packer.groups.orders?.[0]?.actions.map((action) => action.key)).toEqual(["open", "pack"]);
    expect(packer.links.orders).toBe(`/admin/orders?q=${encodeURIComponent(orderRef)}`);
  });

  test("nothing typed or too little: no search, every allowed group empty", async () => {
    const short = await globalSearch(t.db, actorOf("support"), { q: "ر" }, "ar", TEST_NOW);
    expect(short.tooShort).toBe(true);
    expect(short.groups).toEqual({ orders: [], customers: [], skus: [], serials: null, tickets: [] });
    const empty = await globalSearch(t.db, actorOf("support"), { q: "   " }, "ar", TEST_NOW);
    expect(empty.tooShort).toBe(false);
    expect(empty.links.orders).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── routes with real sessions

describe("routes", () => {
  type Person = { id: string; cookie: string };
  const people: Record<string, Person> = {};

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

  async function person(key: string, role: DefaultRoleKey | null): Promise<Person> {
    const password = "dashboard-routes-test-password";
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next("dash")}@dash.test`;
    const id = await make.employee({ email, name: key, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    if (role) await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
    const setCookies: string[] = [];
    const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
    const result = await signInEmployee(ctx, t.db, { email, password });
    if (result.status !== "signed_in") throw new Error("sign-in failed");
    return { id, cookie: setCookies.map((line) => line.split("; ")[0]).find((value) => value.startsWith("tt_adm=") && value.length > 10) ?? "" };
  }

  beforeAll(async () => {
    for (const [key, role] of [
      ["owner", "owner"],
      ["finance", "finance"],
      ["inventory", "inventory"],
      ["cashier", "cashier"],
      ["none", null],
    ] as const)
      people[key] = await person(key, role);
  }, 120_000);

  async function run(cookie: string, path: string, fn: (args: never) => unknown): Promise<unknown> {
    const request = new Request(`${ORIGIN}${path}`, { headers: { cookie, origin: ORIGIN, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Edg/130" } });
    const context = new RouterContextProvider();
    try {
      let out: unknown;
      await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
        out = await fn({ request, context, params: {}, url: new URL(request.url), pattern: path } as never);
        return out instanceof Response ? out : new Response(null);
      });
      return out;
    } catch (error) {
      return error;
    }
  }
  const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);
  type Home = { cards: Record<string, Promise<{ ok: boolean; data?: unknown }>>; views: Record<string, boolean>; overview: boolean };
  const resolved = async (home: Home) => Object.fromEntries(await Promise.all(Object.entries(home.cards).map(async ([key, promise]) => [key, await promise] as const)));

  test("the routes sit under /admin/dashboard (the gate gives them to module 01), the home is the index", () => {
    expect(dashboardAdminRoutes.map((entry) => entry.index ? "(index)" : entry.path)).toEqual(["(index)", "dashboard/search", "dashboard/activity"]);
    expect(gateRuleOf("admin/dashboard/search")).toEqual({ kind: "module", module: "dashboard" });
    expect(gateRuleOf("admin/dashboard/activity")).toEqual({ kind: "module", module: "dashboard" });
  });

  test("the home: every employee gets it; each card only for its permission; every card resolves, none rejects", async () => {
    const none = (await run(people.none.cookie, "/admin", homeLoader as never)) as Home;
    expect(statusOf(none)).toBe(200);
    expect(none.overview).toBe(false);
    expect(Object.keys(none.cards)).toEqual([]);

    const cashier = (await run(people.cashier.cookie, "/admin", homeLoader as never)) as Home;
    expect(Object.keys(cashier.cards)).toEqual([]);

    const finance = (await run(people.finance.cookie, "/admin", homeLoader as never)) as Home;
    expect(Object.keys(finance.cards).sort()).toEqual(["activity", "late", "lowStock", "result", "sales", "unmatched"]);
    const financeCards = await resolved(finance);
    for (const [key, value] of Object.entries(financeCards)) expect(value.ok, key).toBe(true);

    const inventory = (await run(people.inventory.cookie, "/admin", homeLoader as never)) as Home;
    expect(Object.keys(inventory.cards).sort()).toEqual(["late", "lowStock"]);
    const warehouse = (await run(people.inventory.cookie, "/admin?view=warehouse", homeLoader as never)) as Home;
    expect(Object.keys(warehouse.cards).sort()).toEqual(["late", "lowStock", "stock"]);
    // a view the employee does not have falls back to the overview
    const notTheirs = (await run(people.inventory.cookie, "/admin?view=finance", homeLoader as never)) as Home & { filters: DashboardFilters };
    expect(notTheirs.filters.view).toBe("overview");
    for (const home of [inventory, warehouse]) {
      const cards = await resolved(home);
      expect(keysOf(cards).filter((key) => COST_KEY.test(key)), "inventory").toEqual([]);
    }

    const owner = (await run(people.owner.cookie, "/admin?view=finance&period=month", homeLoader as never)) as Home;
    expect(Object.keys(owner.cards).sort()).toEqual(["activity", "money", "result", "sales", "unmatched"]);
    const ownerCards = await resolved(owner);
    expect((ownerCards.result as { ok: true; data: { current: unknown } }).data.current).not.toBeNull();
  });

  test("search and activity: 403 without their permission, the page with it", async () => {
    expect(statusOf(await run(people.none.cookie, "/admin/dashboard/search?q=TT", searchLoader as never))).toBe(403);
    const cashier = (await run(people.cashier.cookie, "/admin/dashboard/search?q=%D8%B1%D9%86%D8%A7", searchLoader as never)) as { results: { groups: Record<string, unknown> } };
    expect(statusOf(cashier)).toBe(200);
    expect(cashier.results.groups.orders).toBeNull();
    expect(statusOf(await run(people.cashier.cookie, "/admin/dashboard/activity", activityLoader as never))).toBe(403);
    const finance = (await run(people.finance.cookie, "/admin/dashboard/activity?kind=approval", activityLoader as never)) as { page: { lines: { kind: string }[] } };
    expect(statusOf(finance)).toBe(200);
    expect(finance.page.lines.every((line) => line.kind === "approval")).toBe(true);
  });
});
