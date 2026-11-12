/**
 * The command centre's v2.1 arrangement (client note 12) against a real local D1 and the server renderer:
 *
 *   · the header's quick actions: each only for holders of the permission its page's own loader asks for
 *   · every KPI that links opens a list that counts the same records — the orders list (demo rows or a live store,
 *     no branch), the sales report (its own operational figures), profit and loss — and none links where its list
 *     would count something else
 *   · the 14-day trend is the reports module's own "sales by day": today's column is the KPI's own "orders placed",
 *     only for who may open that report for the whole company, never with a branch filter
 *   · the to-do tiles carry their severity in words (never colour alone): urgent for late orders and urgent tickets,
 *     "needs a look" for mismatched payments and low stock, nothing raised when nothing waits
 *   · the comparison chip is green only when the change is good for the store, red-ink when bad, neutral for open
 *     orders, and says the whole sentence to screen readers; the server renders every figure's final value (the
 *     count-up never ships a 0 in its place)
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import dashboardMessages from "~/i18n/messages/admin-dashboard";
import type { Locale } from "~/lib/locales";
import { KpiBody, KpiMoney, KpiRow, TileLoading, TrendChart, UrgentTile, figureFit, tileSeverity } from "~/routes/admin/dashboard/components/cards";
import { CountUp, DeltaChip, Money } from "~/routes/admin/dashboard/components/kit";
import { kpiLinks, mayOpenProfitAndLoss, quickActions } from "~/routes/admin/dashboard/home.server";
import { TREND_DAYS } from "~/routes/admin/dashboard/trend";
import { mayShowTrend, ordersTrend, trendRange } from "~/routes/admin/dashboard/trend.server";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { defaultRolePermissions, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { profitAndLoss } from "~/server/services/accounting/reports.server";
import { resultCard, salesCard } from "~/server/services/admin/dashboard/kpis.server";
import { DAY_MS, periodSpans, type AlertTile, type DashboardFilters } from "~/server/services/admin/dashboard/types";
import { baghdadDay, parseRange } from "~/server/services/admin/finance/types";
import { listOrders } from "~/server/services/admin/orders/list.server";
import { parseListFilters } from "~/server/services/admin/orders/types";
import { salesReport } from "~/server/services/admin/reports/sales.server";
import { parseSalesParams } from "~/server/services/admin/reports/types";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const ORIGIN = "http://localhost:5173";
const HOUR = 60 * 60 * 1000;
let t: TestDb;
let make: Fixtures;

const actorOf = (role: DefaultRoleKey, extra: Partial<EmployeeActor> = {}): EmployeeActor => ({ kind: "employee", id: `emp_home_${role}`, permissions: defaultRolePermissions(role), label: role, ...extra });
const custom = (permissions: Permission[], extra: Partial<EmployeeActor> = {}): EmployeeActor => ({ kind: "employee", id: "emp_home_custom", permissions, label: "custom", ...extra });
const filters = (patch: Partial<DashboardFilters> = {}): DashboardFilters => ({ period: "today", view: "overview", demo: false, branch: null, ...patch });

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, TEST_NOW);
  await seedRoles(t.db, TEST_NOW);
  // today: a delivered and paid order, an open one, a demo order; yesterday and a week ago: one each
  const product = await make.product({ priceIqd: 120_000, stock: 40 });
  const a = await make.order([{ ...product, unitPriceIqd: 120_000 }], { placedAt: TEST_NOW - HOUR, status: "delivered" });
  await make.payment(a.orderId, a.totalIqd, { method: "cod", status: "paid", paidAt: TEST_NOW - 30 * 60 * 1000 });
  await make.order([{ ...product, unitPriceIqd: 90_000 }], { placedAt: TEST_NOW - 2 * HOUR, status: "confirmed" });
  const demo = await make.order([{ ...product, unitPriceIqd: 300_000 }], { placedAt: TEST_NOW - HOUR, status: "shipped", isDemo: true });
  await make.payment(demo.orderId, demo.totalIqd, { method: "cod", status: "paid", paidAt: TEST_NOW - HOUR });
  await make.order([{ ...product }], { placedAt: TEST_NOW - 26 * HOUR, status: "delivered" });
  await make.order([{ ...product }], { placedAt: TEST_NOW - 7 * DAY_MS, status: "cancelled" });
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

describe("the header's quick actions (client note 12)", () => {
  test("a new sale only for pos.sale.create, a new product only for catalog.product.create", () => {
    expect(quickActions(actorOf("cashier"))).toEqual({ sale: true, product: false });
    expect(quickActions(actorOf("content"))).toEqual({ sale: false, product: true });
    expect(quickActions(actorOf("owner"))).toEqual({ sale: true, product: true });
    expect(quickActions(custom(["dashboard.overview.read"]))).toEqual({ sale: false, product: false });
  });
});

describe("every KPI that links opens a list counting the same records", () => {
  test("the orders list only where it lists exactly the orders counted: demo rows included or a live store, never for a branch", () => {
    const manager = actorOf("manager");
    expect(kpiLinks(manager, filters(), "demo", TEST_NOW)).toMatchObject({ orders: null, open: null });
    expect(kpiLinks(manager, filters({ demo: true }), "demo", TEST_NOW).orders).toBe(`/admin/orders?from=${baghdadDay(TEST_NOW)}&to=${baghdadDay(TEST_NOW)}`);
    expect(kpiLinks(manager, filters(), "live", TEST_NOW).open).toMatch(/^\/admin\/orders\?status=new&status=awaiting_payment/);
    expect(kpiLinks(manager, filters({ demo: true, branch: "br_x" }), "live", TEST_NOW)).toEqual({ sales: null, orders: null, open: null, net: null });
    // the period's first day: this week from Saturday, this month from the 1st
    const week = periodSpans("week", TEST_NOW);
    expect(kpiLinks(manager, filters({ period: "week", demo: true }), "demo", TEST_NOW).orders).toContain(`from=${baghdadDay(week.current.from)}`);
    // no permission, no link
    const reader = custom(["dashboard.overview.read", "dashboard.sales.read"]);
    expect(kpiLinks(reader, filters({ demo: true }), "live", TEST_NOW)).toEqual({ sales: null, orders: null, open: null, net: null });
    // the sales report refuses an employee limited to a branch: no link to it
    expect(kpiLinks(actorOf("manager", { branchId: "br_x" }), filters(), "live", TEST_NOW).sales).toBeNull();
  });

  test("with the demo rows: the orders list's total is the figure, open orders too", async () => {
    const manager = actorOf("manager");
    const f = filters({ demo: true });
    const card = await salesCard(t.db, manager, f, TEST_NOW);
    const links = kpiLinks(manager, f, "demo", TEST_NOW);
    const placed = await listOrders(t.db, manager, parseListFilters(new URL(links.orders ?? "/", ORIGIN).searchParams), "ar", TEST_NOW);
    expect(placed.total).toBe(card.ordersPlaced.current);
    const open = await listOrders(t.db, manager, parseListFilters(new URL(links.open ?? "/", ORIGIN).searchParams), "ar", TEST_NOW);
    expect(open.total).toBe(card.openOrders.current);
  });

  test("the sales report for the same days shows the same paid sales, orders placed and average basket — with and without demo rows", async () => {
    const manager = actorOf("manager");
    for (const demo of [false, true]) {
      for (const period of ["today", "week", "month"] as const) {
        const f = filters({ demo, period });
        const card = await salesCard(t.db, manager, f, TEST_NOW);
        const link = kpiLinks(manager, f, "demo", TEST_NOW).sales;
        expect(link, `${period} ${demo}`).not.toBeNull();
        const report = await salesReport(t.db, manager, parseSalesParams(new URL(link ?? "/", ORIGIN).searchParams, TEST_NOW), "ar", TEST_NOW);
        expect(report.operations.paidSalesIqd, `${period} ${demo}`).toBe(card.paidSales.current);
        expect(report.operations.placed, `${period} ${demo}`).toBe(card.ordersPlaced.current);
        expect(report.operations.aovIqd, `${period} ${demo}`).toBe(card.averageBasket.current);
      }
    }
  });

  test("profit and loss for the same days is the net profit figure", async () => {
    const finance = actorOf("finance");
    const f = filters({ period: "month" });
    const card = await resultCard(t.db, finance, f, TEST_NOW);
    const range = parseRange(new URL(kpiLinks(finance, f, "demo", TEST_NOW).net ?? "/", ORIGIN).searchParams, TEST_NOW);
    const pnl = await profitAndLoss(t.db, finance, { from: range.fromMs, to: range.toMs, includeDemo: range.demo });
    expect(pnl.profit?.netIqd).toBe(card.current?.netIqd);
  });
});

describe("the 14-day trend is the sales report's own orders per day", () => {
  test("14 Baghdad days ending today; today's column is the KPI's own orders placed, with and without demo rows", async () => {
    const manager = actorOf("manager");
    for (const demo of [false, true]) {
      const trend = await ordersTrend(t.db, manager, { demo }, "ar", TEST_NOW);
      expect(trend.days).toHaveLength(TREND_DAYS);
      expect(trend.days.at(-1)).toMatchObject({ day: baghdadDay(TEST_NOW), today: true });
      expect(trend.days.filter((day) => day.today)).toHaveLength(1);
      const card = await salesCard(t.db, manager, filters({ demo }), TEST_NOW);
      expect(trend.days.at(-1)?.placed).toBe(card.ordersPlaced.current);
      // yesterday's whole day, and the cancelled order a week ago still counts as placed (any status)
      expect(trend.days.at(-2)?.placed).toBe(1);
      expect(trend.days.at(-8)?.placed).toBe(1);
      expect(trend.href).toBe(`/admin/reports/sales?from=${trendRange(TEST_NOW, demo).from}&to=${baghdadDay(TEST_NOW)}${demo ? "&demo=1" : ""}`);
    }
  });

  test("only for who may open the report for the whole company, never with a branch filter", async () => {
    expect(mayShowTrend(actorOf("finance"), { branch: null })).toBe(true);
    expect(mayShowTrend(actorOf("finance"), { branch: "br_x" })).toBe(false);
    expect(mayShowTrend(actorOf("manager", { branchId: "br_x" }), { branch: null })).toBe(false);
    expect(mayShowTrend(custom(["dashboard.overview.read", "dashboard.sales.read"]), { branch: null })).toBe(false);
    await expect(ordersTrend(t.db, custom(["dashboard.overview.read", "dashboard.sales.read"]), { demo: false }, "ar", TEST_NOW)).rejects.toMatchObject({ status: 403 });
  });
});

// ───────────────────────────────────────────────────────────────── server render

/** A component as the server renders it, with the admin-dashboard strings. */
function render(node: () => ReactNode, locale: Locale = "en"): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "admin", Component: () => node() }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/admin"],
      hydrationData: {
        loaderData: {
          root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui") },
          page: { i18n: messagesFor(locale, "admin-dashboard") },
        },
      },
    }),
  );
}

const tile = (patch: Partial<AlertTile>): AlertTile => ({ id: "late_orders", count: 0, href: "/admin/orders?flag=late", rows: [], extra: null, ...patch });

describe("the to-do tiles say their severity in words", () => {
  test("urgent for late orders and urgent tickets, a look for payments and stock, nothing raised when nothing waits", () => {
    expect(tileSeverity({ id: "late_orders", count: 3 })).toBe("high");
    expect(tileSeverity({ id: "critical_tickets", count: 1 })).toBe("high");
    expect(tileSeverity({ id: "unmatched_payments", count: 2 })).toBe("medium");
    expect(tileSeverity({ id: "low_stock", count: 9 })).toBe("medium");
    expect(tileSeverity({ id: "low_stock", count: 0 })).toBe("clear");
    // no urgent ticket open, but tickets past their due time: a look, not a clean desk
    expect(tileSeverity({ id: "critical_tickets", count: 0, extra: { count: 3, href: "/admin/support?view=late" } })).toBe("medium");
    expect(tileSeverity({ id: "critical_tickets", count: 0, extra: { count: 0, href: "/admin/support?view=late" } })).toBe("clear");

    const words = dashboardMessages.en.urgent.severity;
    const late = render(() => createElement(UrgentTile, { tile: tile({ count: 4 }) }));
    expect(late).toContain('data-severity="high"');
    expect(late).toContain("adm-card--act");
    expect(late).toContain(words.high);
    const stock = render(() => createElement(UrgentTile, { tile: tile({ id: "low_stock", count: 2, href: "/admin/inventory/stock?state=low&sort=available" }) }));
    expect(stock).toContain('data-severity="medium"');
    expect(stock).toContain(words.medium);
    const clear = render(() => createElement(UrgentTile, { tile: tile({ count: 0 }) }));
    expect(clear).toContain('data-severity="clear"');
    expect(clear).not.toContain("adm-card--act");
    expect(clear).toContain(dashboardMessages.en.urgent.late_orders.none);
    // one action each: the list the count comes from
    expect(clear).toContain('href="/admin/orders?flag=late"');
  });
});

describe("figures and their comparison", () => {
  test("the chip: good up, bad down, neutral for open orders; the sentence for screen readers; the earlier figure", () => {
    const up = render(() => createElement(DeltaChip, { figure: { current: 150, previous: 100 }, period: "today" }));
    expect(up).toContain('data-tone="good"');
    expect(up).toContain("Up ⁨50%⁩ on Yesterday");
    // the earlier figure is isolated in the page's direction (left to right here), never first-strong (review: an
    // Arabic negative amount would turn around)
    expect(up).toContain("Yesterday: \u2066100\u2069");
    const down = render(() => createElement(DeltaChip, { figure: { current: 50, previous: 100 }, money: true, period: "week" }));
    expect(down).toContain('data-tone="bad"');
    expect(down).toContain("Down ⁨50%⁩ on Last week");
    const open = render(() => createElement(DeltaChip, { figure: { current: 9, previous: 3 }, period: "today", good: "neither" }));
    expect(open).toContain('data-tone="flat"');
    const zero = render(() => createElement(DeltaChip, { figure: { current: 5, previous: 0 }, period: "month" }));
    expect(zero).toContain(dashboardMessages.en.kpi.noRatio);
    expect(zero).toContain("No ratio: Last month was zero");
    // an unknown figure: no chip, never an invented change
    const unknown = render(() => createElement(DeltaChip, { figure: { current: 5, previous: null }, period: "today" }));
    expect(unknown).not.toContain("dash-delta__chip");
  });

  test("the server renders each figure's final value — the count-up never ships a 0 in its place", () => {
    const html = render(() => createElement(CountUp, { value: 1_250_000, render: (value: number) => createElement(KpiMoney, { iqd: value }) }));
    expect(html).not.toMatch(/>0</);
    expect(html.match(/1,250,000/g)?.length).toBe(2); // the face and the cell it reserves
    expect(html).toContain("dash-money__cur");
  });

  test("a KPI links its figure to its list, with the label, the figure and the list in its accessible name", () => {
    const html = render(() =>
      createElement(KpiBody, { id: "ordersPlaced", label: "New orders", figure: "3", figureText: "3", href: "/admin/orders?from=2026-11-10&to=2026-11-10", openLabel: "Open these days' orders" }),
    );
    expect(html).toContain('href="/admin/orders?from=2026-11-10&amp;to=2026-11-10"');
    expect(html).toContain('aria-label="New orders: 3 — Open these days&#x27; orders"');
    const plain = render(() => createElement(KpiBody, { id: "ordersPlaced", label: "New orders", figure: "3", figureText: "3", href: null }));
    expect(plain).not.toContain("<a ");
  });

  test("a negative amount keeps the figure first in Arabic: its isolate takes the page's direction, never the first strong mark's", () => {
    // ICU writes an Arabic minus as LRM + "-" and the KPI writes "‎−": a first-strong isolate (<bdi> without dir, U+2068)
    // then turns left to right and puts the currency BEFORE the figure in an Arabic line ("د.ع −17,917")
    for (const node of [() => createElement(KpiMoney, { iqd: -17_917 }), () => createElement(Money, { iqd: -17_917 })]) {
      expect(render(node, "ar")).toMatch(/<bdi[^>]* dir="rtl"/);
      expect(render(node, "en")).toMatch(/<bdi[^>]* dir="ltr"/);
    }
    const vs = (html: string) => html.match(/<span class="dash-delta__vs">([^<]*)<\/span>/)?.[1] ?? "";
    const ar = vs(render(() => createElement(DeltaChip, { figure: { current: 5_000, previous: -17_917 }, money: true, period: "today" }), "ar"));
    expect(ar).toContain("17,917");
    expect(ar).toContain("\u2067"); // right-to-left isolate
    expect(ar).not.toContain("\u2068");
    const en = vs(render(() => createElement(DeltaChip, { figure: { current: 5_000, previous: -17_917 }, money: true, period: "today" }), "en"));
    expect(en).toContain("\u2066"); // left-to-right isolate
    expect(en).not.toContain("\u2068");
  });

  test("a figure on its way holds the tile's final height: the new-orders skeleton keeps the trend's place, the tile its key", () => {
    // a promise that never settles: every card stays in its loading state
    const waiting = new Promise<never>(() => undefined);
    const links = { sales: null, orders: null, open: null, net: null };
    const withTrend = render(() => createElement(KpiRow, { sales: waiting, trend: waiting, links, period: "today", here: "" }));
    // four skeleton tiles; only new orders carries the trend's placeholder, and every comparison keeps its chip's line
    expect(withTrend.match(/class="dash-kpi__body dash-loading"/g)).toHaveLength(4);
    expect(withTrend.match(/class="dash-trend dash-loading"/g)).toHaveLength(1);
    expect(withTrend.match(/dash-skel--chip/g)).toHaveLength(4);
    const withoutTrend = render(() => createElement(KpiRow, { sales: waiting, links, period: "today", here: "" }));
    expect(withoutTrend).not.toContain("dash-trend");
    const tile = render(() => createElement(TileLoading, { id: "late_orders" }));
    expect(tile).toContain("dash-tile__foot");
  });

  test("a long amount fits its tile on one line: the wider the figure, the more ems it asks for (the arrow and currency are fixed)", () => {
    const ems = (text: string, linked = false) => Number((figureFit(text, linked) as Record<string, string>)["--fig-em"]);
    const px = (text: string, linked = false) => (figureFit(text, linked) as Record<string, string>)["--fig-px"];
    expect(ems("312,450,000 د.ع")).toBeGreaterThan(ems("12,450,000 د.ع"));
    expect(ems("12,450,000 د.ع")).toBeGreaterThan(ems("450,000 د.ع"));
    // ICU's marks never count; the minus does
    expect(ems("\u200e-17,917 د.ع")).toBeGreaterThan(ems("17,917 د.ع"));
    expect(ems("\u2066\u200e17,917 د.ع\u2069")).toBe(ems("17,917 د.ع"));
    expect(px("12,450,000 د.ع", true)).toBe("35px");
    expect(px("12,450,000 IQD")).toBe("22px");
    expect(px("4")).toBe("0px");
    // the line it styles
    const html = render(() => createElement(KpiBody, { id: "paidSales", label: "Paid sales", figure: "x", figureText: "12,450,000 IQD", href: "/admin/reports/sales" }));
    expect(html).toMatch(/class="dash-kpi__value" style="--fig-em:[\d.]+;--fig-px:42px"/);
  });

  test("the link to profit and loss beside the figures only for who may open it", () => {
    expect(mayOpenProfitAndLoss(actorOf("finance"))).toBe(true);
    expect(mayOpenProfitAndLoss(actorOf("owner"))).toBe(true);
    // the net figure needs cost.read + profit.read; the report itself finance.report.read
    expect(mayOpenProfitAndLoss(custom(["dashboard.overview.read", "dashboard.sales.read", "cost.read", "profit.read"]))).toBe(false);
  });

  test("the trend: one column per day, a table of every value, the link to its report", () => {
    const days = Array.from({ length: TREND_DAYS }, (_, index) => ({ day: baghdadDay(TEST_NOW - (TREND_DAYS - 1 - index) * DAY_MS), at: TEST_NOW - (TREND_DAYS - 1 - index) * DAY_MS, placed: index % 3, today: index === TREND_DAYS - 1 }));
    const html = render(() => createElement(TrendChart, { trend: { days, href: "/admin/reports/sales?from=x&to=y", demo: false } }));
    expect(html.match(/class="dash-trend__col"/g)?.length ?? 0).toBeGreaterThan(0);
    expect(html.match(/<li class="dash-trend__col/g)).toHaveLength(TREND_DAYS);
    expect(html.match(/<tr>/g)).toHaveLength(TREND_DAYS + 1);
    expect(html).toContain('href="/admin/reports/sales?from=x&amp;to=y"');
    expect(html).toContain(dashboardMessages.en.trend.today);
    expect(html).not.toContain(dashboardMessages.en.trend.none);
  });
});
