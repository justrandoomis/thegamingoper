/**
 * Admin module 18 "reports" — the adversarial review (2026-11-12). Every test here failed on the builder's code:
 *
 *   1. free text: a saved report's name, a saved search and a deletion reason kept bidi overrides, invisible and
 *      control characters — a SHARED name could show colleagues something else than it says, and so could the audit
 *      trail; a name made only of such characters passed as a name
 *   2. digits: a report URL with Arabic-Indic or Persian digits ("period=٢٠٢٦-٠٦", "days=٣٠", a month field the browser
 *      shows as text) silently opened the CURRENT month — and "save this view" saved that month
 *   3. the XLSX of module 04's dead stock / turnover turned SKUs and names made of digits into numbers ("000123" → 123)
 *   4. an employee limited to a branch was offered every report (menu, cards, the dictionary's links, saved reports)
 *      only to meet a 403
 *   5. a refund paid BEFORE delivery that names its items reaches the books inside the sale's own posting; sales by
 *      platform and ABC spread it over every line by value while the margin report followed the items — two reports,
 *      two answers for the same SKU
 *   6. the margin file: under a search its "total" row summed every SKU of the range, not the rows above it; and its
 *      "orders without a carrier charge" total held the incomplete orders (an uncosted counter sale counted as a
 *      missing carrier charge)
 *   7. the margin page's search form dropped the ascending sort
 *   8. "this range has more than 5234 orders" when it had exactly 5234 (the count is the range's, the limit 5,000)
 *   9. the employees section sent module 15's pay (commissions) and attendance to the browser — the page and its
 *      notes say "no pay"
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import { newId } from "~/lib/ids";
import ReportsHome from "~/routes/admin/reports/index";
import ReportsLayout from "~/routes/admin/reports/layout";
import MarginPage from "~/routes/admin/reports/margin";
import { REPORTS_LAYOUT_ID } from "~/routes/admin/reports/meta";
import { reportsT } from "~/routes/admin/reports/reports.server";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { auditEvents, branches, carriers, platforms, products, refundItems, refunds, savedReports, shipments, stockMovements, variants } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, type Permission } from "~/server/permissions";
import { postCogs, postRefund, postSale } from "~/server/services/accounting/post.server";
import { revenueRecognised } from "~/server/services/accounting/reports.server";
import { exportReport } from "~/server/services/admin/reports/export.server";
import { abcRows } from "~/server/services/admin/reports/inventory.server";
import { marginReport, marginRows } from "~/server/services/admin/reports/margin.server";
import { performanceReport } from "~/server/services/admin/reports/performance.server";
import { salesReport } from "~/server/services/admin/reports/sales.server";
import { deleteSavedReport, listSavedReports, saveReport, updateSavedReport } from "~/server/services/admin/reports/saved.server";
import { reportsAccess } from "~/server/services/admin/reports/shared.server";
import { MAX_LINE_ORDERS, parseCustomerParams, parseInventoryParams, parseMarginParams, parsePerformanceParams, parseSalesParams, savedParamsOf } from "~/server/services/admin/reports/types";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
/** Noon in Baghdad on a day of 2026. */
const at = (month: number, day: number) => Date.UTC(2026, month - 1, day, 9, 0, 0);
const JUNE = "period=2026-06";

let t: TestDb;
let make: Fixtures;
const role = (key: "owner" | "manager" | "finance", id = newId("emp")): EmployeeActor => ({ kind: "employee", id, permissions: defaultRolePermissions(key), label: key });
const custom = (permissions: Permission[], id = newId("emp")): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions) });

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

const s = {
  ps: "plt_rev_ps",
  nin: "plt_rev_nin",
  branch: "brn_rev_1",
  carrier: "car_rev_1",
  a: { variantId: "", sku: "" },
  b: { variantId: "", sku: "" },
  c: { variantId: "", sku: "" },
  o3: "",
  o4: "",
  cashier: "",
  owner: role("owner"),
};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  const db = t.db;
  const base = { createdBy: "system:test", isDemo: false };
  await runBatch(db, [
    db.insert(platforms).values({ id: s.ps, slug: "rev-ps", name: { ar: "PlayStation", en: "PlayStation" } }),
    db.insert(platforms).values({ id: s.nin, slug: "rev-nin", name: { ar: "Nintendo", en: "Nintendo" } }),
    db.insert(branches).values({ id: s.branch, code: "REV-1", name: { ar: "فرع المراجعة", en: "Review branch" }, createdAt: NOW }),
    db.insert(carriers).values({ id: s.carrier, code: "REV-C", name: "ناقل المراجعة", createdAt: NOW }),
  ]);
  const a = await make.product({ priceIqd: 300_000, stock: 3 });
  const b = await make.product({ priceIqd: 100_000, stock: 3, kind: "game" });
  const c = await make.product({ priceIqd: 50_000, stock: 5, kind: "accessory" });
  await db.update(products).set({ platformId: s.ps }).where(eq(products.id, a.productId));
  await db.update(products).set({ platformId: s.nin }).where(eq(products.id, b.productId));
  s.a = a;
  s.b = b;
  s.c = c;
  // dead stock whose SKU and name are made of digits (module 04's report: on hand, never sold)
  const d = await make.product({ priceIqd: 40_000, stock: 4, kind: "game" });
  await db.update(variants).set({ sku: "000123" }).where(eq(variants.id, d.variantId));
  await db.update(products).set({ name: { ar: "1942", en: "1942" } }).where(eq(products.id, d.productId));
  const customer = await make.customer();
  s.cashier = await make.employee();

  // O3 — web, A 300,000 + B 100,000 + delivery 5,000 = 405,000 paid in advance (wallet) on 3 June; B refunded on
  // 4 June BEFORE delivery, the refund naming B (its posting debits customer control); delivered on 6 June: the sale's
  // posting moves that refund to sales refunds (metrics §2). A left stock at 200,000; the carrier charged 6,000.
  const o3 = await make.order([{ ...a, qty: 1, unitPriceIqd: 300_000 }, { ...b, qty: 1, unitPriceIqd: 100_000 }], { customerId: customer, status: "delivered", placedAt: at(6, 3), deliveredAt: at(6, 6), paidIqd: 405_000, refundedIqd: 100_000 });
  s.o3 = o3.orderId;
  const pay3 = await make.payment(o3.orderId, 405_000, { method: "wallet", status: "paid", paidAt: at(6, 3) });
  const refund3 = newId("rfd");
  await runBatch(db, [
    db.insert(refunds).values({ id: refund3, orderId: o3.orderId, paymentId: pay3, amountIqd: 100_000, method: "wallet", reason: "out of stock", status: "paid", createdAt: at(6, 4), paidAt: at(6, 4) }),
    db.insert(refundItems).values({ refundId: refund3, orderItemId: o3.itemIds[1], qty: 1 }),
    db.insert(stockMovements).values({ id: newId("mov"), variantId: a.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -1, unitCostIqd: 200_000, refType: "order", refId: o3.orderId, actorKind: "system", actorId: "test", at: at(6, 5) }),
    db.insert(shipments).values({ id: newId("shp"), orderId: o3.orderId, carrierId: s.carrier, status: "delivered", costIqd: 6_000, shippedAt: at(6, 5), deliveredAt: at(6, 6), createdAt: at(6, 5), updatedAt: at(6, 6) }),
    ...postRefund(db, { ...base, at: at(6, 4), refundId: refund3, orderId: o3.orderId, ref: o3.ref, amountIqd: 100_000, paidFrom: "wallet_liability", revenueRecognized: false }),
    ...postSale(db, { ...base, at: at(6, 6), orderId: o3.orderId, ref: o3.ref, subtotalIqd: 400_000, discountIqd: 0, shippingIqd: 5_000, totalIqd: 405_000, refundedBeforeIqd: 100_000 }),
    ...postCogs(db, { ...base, at: at(6, 6), orderId: o3.orderId, ref: o3.ref, cogsIqd: 200_000 }),
  ]);

  // O4 — a counter sale at the branch, rung up by the cashier on 20 June: C 50,000 × 2, units without any cost (its
  // profit is incomplete; a counter sale has no carrier, so no carrier charge is missing)
  const o4 = await make.order([{ ...c, qty: 2, unitPriceIqd: 50_000 }], { channel: "pos", branchId: s.branch, cashierId: s.cashier, status: "delivered", placedAt: at(6, 20), deliveredAt: at(6, 20), shippingIqd: 0, paidIqd: 100_000 });
  s.o4 = o4.orderId;
  await make.payment(o4.orderId, 100_000, { method: "pos_cash", status: "paid", paidAt: at(6, 20) });
  await runBatch(db, [
    db.insert(stockMovements).values({ id: newId("mov"), variantId: c.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -2, unitCostIqd: null, reason: "no_cost_layer_uncosted", refType: "order", refId: o4.orderId, actorKind: "system", actorId: "test", at: at(6, 20) }),
    ...postSale(db, { ...base, at: at(6, 20), orderId: o4.orderId, ref: o4.ref, subtotalIqd: 100_000, discountIqd: 0, shippingIqd: 0, totalIqd: 100_000 }),
  ]);
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── 1. free text

describe("free text in saved reports", () => {
  const RLO = "‮";
  const PDF = "‬";
  const LRI = "⁦";
  const PDI = "⁩";
  const ZWSP = "​";
  const BEL = "\u0007";

  test("a name, a saved search and a reason lose bidi overrides, invisible and control characters before they are judged and stored", async () => {
    const author = role("finance", await make.employee());
    const { id } = await saveReport(t.db, author, { reportKey: "margin", name: `${RLO}fdp.tropeR${PDF} شهري${BEL}`, search: `?${JUNE}&q=${encodeURIComponent(`${LRI}PS5${PDI}${ZWSP}`)}`, shared: true, idempotencyKey: "review-key-0000000000000001" }, NOW);
    const row = await t.db.select().from(savedReports).where(eq(savedReports.id, id)).get();
    expect(row?.name).toBe("fdp.tropeR شهري");
    expect(row?.params).toEqual({ period: "2026-06", q: "PS5" });
    // a name made only of such characters is no name
    const blank = await failureOf(saveReport(t.db, author, { reportKey: "sales", name: `${RLO}${PDF}${ZWSP}${BEL}`, search: "", idempotencyKey: "review-key-0000000000000002" }, NOW));
    expect(blank).toMatchObject({ code: "invalid", status: 400 });
    expect(blank.fields?.name).toBeTruthy();
    // renaming cleans too, and the audit trail holds what the screen shows
    expect(await updateSavedReport(t.db, author, { id, name: `هامش${RLO} حزيران`, shared: true, expectedUpdatedAt: NOW }, NOW + 1)).toEqual({ changed: true });
    const renamed = await t.db.select().from(savedReports).where(eq(savedReports.id, id)).get();
    expect(renamed?.name).toBe("هامش حزيران");
    await deleteSavedReport(t.db, author, { id, reason: `${RLO}لم يعد مطلوباً${PDF}`, expectedUpdatedAt: renamed?.updatedAt ?? 0 }, NOW + 2);
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(events.find((event) => event.action === "reports.saved.delete")?.reason).toBe("لم يعد مطلوباً");
    expect(JSON.stringify(events)).not.toMatch(/[‪-‮⁦-⁩​]/);
  });

  test("a record stored before the rule shows colleagues what it says", async () => {
    const ownerId = await make.employee();
    const id = newId("svr");
    await t.db.insert(savedReports).values({ id, reportKey: "sales", name: `مبيعات${RLO}الشهر`, params: { period: "2026-06", by: `${LRI}platform` }, schedule: null, recipients: null, format: "csv", ownerId, isShared: true, lastRunAt: null, createdAt: NOW, updatedAt: NOW });
    const view = (await listSavedReports(t.db, role("manager"))).find((entry) => entry.id === id);
    expect(view?.name).toBe("مبيعاتالشهر");
    expect(JSON.stringify(view)).not.toMatch(/[‪-‮⁦-⁩]/);
  });
});

// ───────────────────────────────────────────────────────────────── 2. digits

describe("report URLs typed with Arabic-Indic or Persian digits", () => {
  test("open the month, the days and the page asked for — never silently the current month", () => {
    expect(parseSalesParams(new URLSearchParams("period=٢٠٢٦-٠٦&by=platform&page=٢"), NOW)).toMatchObject({ range: { period: "2026-06", from: "2026-06-01", to: "2026-06-30" }, by: "platform", page: 2 });
    expect(parseMarginParams(new URLSearchParams("from=۲۰۲۶-۰۶-۰۱&to=۲۰۲۶-۰۶-۰۷"), NOW).range).toMatchObject({ period: null, from: "2026-06-01", to: "2026-06-07" });
    expect(parseInventoryParams(new URLSearchParams("view=dead&days=٣٠"), NOW).days).toBe(30);
    expect(parsePerformanceParams(new URLSearchParams("view=support&days=۷"), NOW).days).toBe(7);
    expect(parseCustomerParams(new URLSearchParams("period=٢٠٢٦-٠٦&demo=١"), NOW).range).toMatchObject({ period: "2026-06", demo: true });
  });

  test("'save this view' keeps the month typed, and the report is that month's", async () => {
    expect(savedParamsOf("sales", new URLSearchParams("period=٢٠٢٦-٠٦&by=channel"), NOW)).toEqual({ period: "2026-06", by: "channel" });
    expect(savedParamsOf("inventory", new URLSearchParams("view=turnover&days=٦٠"), NOW)).toEqual({ period: "2026-11", view: "turnover", days: "60" });
    const typed = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams("period=٢٠٢٦-٠٦"), NOW), "ar", NOW);
    const latin = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(JUNE), NOW), "ar", NOW);
    expect(typed.range.period).toBe("2026-06");
    expect(typed.totals).toEqual(latin.totals);
    expect(typed.totals.grossIqd).toBe(500_000);
  });
});

// ───────────────────────────────────────────────────────────────── 3. XLSX of module 04's views

describe("the XLSX of module 04's stock reports", () => {
  test("SKUs and names made of digits stay text; the figures stay numbers", async () => {
    const file = await exportReport(t.db, s.owner, { key: "inventory", format: "xlsx", params: new URLSearchParams("view=dead&days=30") }, "en", NOW, (key) => key);
    const sheet = unzip(file.body as Uint8Array)["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">000123</t>');
    expect(sheet).toContain('<t xml:space="preserve">1942</t>');
    expect(sheet).not.toContain("<v>123</v>");
    expect(sheet).not.toContain("<v>1942</v>");
    // the dead SKU's units on hand are a number a spreadsheet adds up
    expect(sheet).toMatch(/<c r="C\d+" s="2"><v>4<\/v><\/c>/);
  });
});

// ───────────────────────────────────────────────────────────────── 4. branch-limited employees

describe("an employee limited to a branch", () => {
  test("is offered no report, no export, no saving and no saved report — each would only open on a 403", async () => {
    const limited: EmployeeActor = { ...role("owner"), branchId: s.branch };
    const access = reportsAccess(limited);
    expect(access).toMatchObject({ reports: { sales: false, margin: false, inventory: false, customers: false, performance: false }, saved: false, export: false, wholeCompany: false });
    expect(await failureOf(salesReport(t.db, limited, parseSalesParams(new URLSearchParams(JUNE), NOW), "ar", NOW))).toMatchObject({ code: "forbidden", status: 403 });
    const author = role("finance", await make.employee());
    const { id } = await saveReport(t.db, author, { reportKey: "sales", name: "مبيعات حزيران", search: `?${JUNE}`, shared: true, idempotencyKey: "review-key-0000000000000010" }, NOW);
    expect((await listSavedReports(t.db, role("manager"))).some((view) => view.id === id)).toBe(true);
    expect(await listSavedReports(t.db, limited)).toEqual([]);
    // the whole-company employee keeps everything
    expect(reportsAccess(s.owner)).toMatchObject({ reports: { sales: true, margin: true }, saved: true, export: true, wholeCompany: true });
  });

  test("the module's menu and front page say why instead of offering links that end on a 403", () => {
    const limited: EmployeeActor = { ...role("owner"), branchId: s.branch };
    const access = reportsAccess(limited);
    const html = render(() => createElement(ReportsLayout, { loaderData: { access } } as never), "en", { access }, () => createElement(ReportsHome, { loaderData: { access, saved: [] } } as never), "/admin/reports");
    const en = messagesFor("en", "admin-reports")["admin-reports"] as { common: { branchLimited: string }; home: { noReportsText: string } };
    expect(html).toContain(en.common.branchLimited.replace(/'/g, "&#x27;"));
    // the module's menu and its report cards (the shell's function list below them is the shell's: its links are not
    // the module's to filter — reported to the shell's owner)
    const menu = /<nav aria-label="Reports pages"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    const cards = /<section[^>]*aria-labelledby="reports-list"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(menu).toContain('href="/admin/reports/saved"');
    expect(cards).toContain('href="/admin/reports/dictionary"');
    for (const key of ["sales", "margin", "inventory", "customers", "performance"]) expect(menu + cards, key).not.toContain(`href="/admin/reports/${key}"`);
    expect(cards).not.toContain(en.home.noReportsText.replace(/'/g, "&#x27;"));
  });
});

// ───────────────────────────────────────────────────────────────── 5. a refund paid before delivery

describe("a refund paid before delivery, naming its items", () => {
  test("follows its items in sales by platform and ABC — the same answer as the margin report — and the books still add up", async () => {
    const report = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(`${JUNE}&by=platform`), NOW), "en", NOW, { all: true });
    expect(report.consistent).toBe(true);
    const core = await revenueRecognised(t.db, { from: Date.UTC(2026, 5, 1) - 3 * 3600_000, to: Date.UTC(2026, 6, 1) - 3 * 3600_000 });
    expect(core).toMatchObject({ grossIqd: 500_000, refundsIqd: 100_000, netIqd: 400_000 });
    const ps = report.rows.find((row) => row.key === s.ps);
    const nin = report.rows.find((row) => row.key === s.nin);
    // B was refunded in full: its 100,000 belongs to B, not 75,000 to A and 25,000 to B
    expect(ps?.revenue).toMatchObject({ grossIqd: 300_000, refundsIqd: 0, netIqd: 300_000 });
    expect(nin?.revenue).toMatchObject({ grossIqd: 100_000, refundsIqd: 100_000, netIqd: 0 });
    const margin = await marginRows(t.db, s.owner, parseMarginParams(new URLSearchParams(JUNE), NOW).range, "en");
    expect(margin.rows.find((row) => row.variantId === s.a.variantId)?.netRevenueIqd).toBe(ps?.revenue.netIqd);
    expect(margin.rows.find((row) => row.variantId === s.b.variantId)?.netRevenueIqd).toBe(nin?.revenue.netIqd);
    const abc = await abcRows(t.db, s.owner, parseInventoryParams(new URLSearchParams(JUNE), NOW).range, "revenue", "en");
    expect(abc.rows.find((row) => row.variantId === s.a.variantId)?.value).toBe(300_000);
    expect(abc.rows.find((row) => row.variantId === s.b.variantId)).toMatchObject({ value: 0, abcClass: "C" });
  });
});

// ───────────────────────────────────────────────────────────────── 6. the margin file's total row

describe("the margin file's total row", () => {
  /** The CSV as rows of cells (no quoted commas in this scenario). */
  const csvRows = (body: unknown) => String(body).replace(/^﻿/, "").trim().split("\r\n").map((line) => line.split(","));

  test("adds up to the rows above it under a search, and counts orders without a carrier charge — not the incomplete ones", async () => {
    const all = csvRows((await exportReport(t.db, s.owner, { key: "margin", format: "csv", params: new URLSearchParams(JUNE) }, "en", NOW, (key) => key)).body);
    const header = all[0];
    const col = (name: string) => header.indexOf(name);
    const total = all[all.length - 1];
    expect(total[0]).toBe("margin.total");
    // O4 (a counter sale) is incomplete for its uncosted units, but no carrier charge is missing anywhere
    expect(all.slice(1, -1).every((row) => row[col("col.carrierUnknown")] === "0")).toBe(true);
    expect(total[col("col.carrierUnknown")]).toBe("0");
    expect(total[col("col.uncosted")]).toBe("2");
    // a search keeps A's row, and the total is A's
    const searched = csvRows((await exportReport(t.db, s.owner, { key: "margin", format: "csv", params: new URLSearchParams(`${JUNE}&q=${encodeURIComponent(s.a.sku)}`) }, "en", NOW, (key) => key)).body);
    expect(searched).toHaveLength(3);
    const [, onlyA, sum] = searched;
    for (const name of ["col.orders", "col.units", "col.revenueIqd", "col.netRevenueIqd", "col.cogsIqd", "col.subsidyIqd", "col.netProfitIqd"]) expect(sum[col(name)], name).toBe(onlyA[col(name)]);
    expect(onlyA[col("col.netRevenueIqd")]).toBe("300000");
  });
});

// ───────────────────────────────────────────────────────────────── 7. the margin page's search form

describe("the margin page", () => {
  test("its search form keeps the ascending sort the list shows", async () => {
    const params = parseMarginParams(new URLSearchParams(`${JUNE}&sort=units&dir=asc`), NOW);
    const report = await marginReport(t.db, s.owner, params, "en");
    const html = render(() => createElement(MarginPage, { loaderData: { report, params, now: NOW } } as never), "en");
    const searchForm = html.split("<form").find((chunk) => chunk.includes('type="search"')) ?? "";
    expect(searchForm).toContain('name="sort" value="units"');
    expect(searchForm).toContain('name="dir" value="asc"');
  });
});

// ───────────────────────────────────────────────────────────────── 8. "more than 5234 orders"

describe("the too-many-orders sentence", () => {
  test("states the range's count and the report's limit — never 'more than' the count itself", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const sentence = reportsT(locale)("common.tooMany", { count: 5234, max: MAX_LINE_ORDERS });
      expect(sentence, locale).toContain("5234");
      expect(sentence, locale).toContain(String(MAX_LINE_ORDERS));
    }
    expect(reportsT("en")("common.tooMany", { count: 5234, max: MAX_LINE_ORDERS })).not.toMatch(/more than 5234/);
  });
});

// ───────────────────────────────────────────────────────────────── 9. the employees section

describe("the employees section", () => {
  test("sends counter sales, refunds and packing — not module 15's pay or attendance — even to the owner", async () => {
    const report = await performanceReport(t.db, s.owner, parsePerformanceParams(new URLSearchParams(`${JUNE}&view=employees`), NOW), "en", NOW);
    // what the page receives (its loader returns the report as it is)
    const json = JSON.stringify(report);
    expect(json).toContain(`"id":"${s.cashier}"`);
    expect(json).toContain('"netIqd":100000');
    for (const key of ["commissionIqd", "attendance", "roles", "tasks"]) expect(json, key).not.toContain(`"${key}"`);
    expect(report.employees?.rows.find((row) => row.employee.id === s.cashier)?.sales).toMatchObject({ orders: 1, netIqd: 100_000 });
    const file = String((await exportReport(t.db, s.owner, { key: "performance", format: "csv", params: new URLSearchParams(`${JUNE}&view=employees`) }, "en", NOW, (key) => key)).body);
    expect(file).toContain("100000");
    // the reader without module 15's permission still gets the section's need, not its figures
    const reader = await performanceReport(t.db, custom(["reports.performance.read"]), parsePerformanceParams(new URLSearchParams(`${JUNE}&view=employees`), NOW), "en", NOW);
    expect(reader).toMatchObject({ employees: null, sections: { employees: { open: false, needs: "staff.performance.read" } } });
  });
});

// ───────────────────────────────────────────────────────────────── helpers

/**
 * A page of the module as the server renders it: the root's data (with the admin's strings), the reports layout's
 * (its strings, `layoutData`), Latin digits. Without `layout` the layout route renders only its child.
 */
function render(
  node: () => ReturnType<typeof createElement>,
  locale: "ar" | "en",
  layoutData: { access: ReturnType<typeof reportsAccess> } = { access: reportsAccess(s.owner) },
  page: (() => ReturnType<typeof createElement>) | null = null,
  path = "/admin/reports/margin",
): string {
  const layout = page ? { Component: () => node(), children: [{ id: "page", index: true, Component: () => page() }] } : { children: [{ id: "page", path: "margin", Component: () => node() }] };
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: REPORTS_LAYOUT_ID, path: "admin/reports", ...layout }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [path],
      hydrationData: {
        loaderData: {
          root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui", "admin") },
          [REPORTS_LAYOUT_ID]: { i18n: messagesFor(locale, "admin-reports", "errors"), access: layoutData.access, storeMode: "demo" },
          page: {},
        },
      },
    }),
  );
}

/** Reads a stored (uncompressed) ZIP: name → UTF-8 text. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("no end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: Record<string, string> = {};
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    out[name] = decoder.decode(bytes.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size));
    at += 46 + nameLength + extra + comment;
  }
  return out;
}
