/**
 * Admin module 18 "reports" — its services on a real local D1, with one month of known business (June 2026):
 *
 *   · sales (18.01): every breakdown (day, channel, branch, platform) plus "not attributed" adds up to the core's
 *     revenueRecognised to the dinar; the order's amounts are split over its lines exactly (a refund by the items it
 *     names); operational figures as docs/metrics.md §3 defines them; demo rows only when asked
 *   · margin (18.02): metrics §4 "profit of one order" per line, checked by hand; cost / profit fields ABSENT without
 *     cost.read / profit.read (never 0, never null-masked); uncosted units and unknown carrier charges counted
 *   · ABC (18.03), cohorts and repeat purchases (18.04), shipping performance and the sections' own permissions (18.05)
 *   · saved reports (18.06): permissions, normalised parameters, idempotent saving, owner-only changes, stale guard,
 *     reason, audit; exports: formula-safe CSV, a valid XLSX package, protected columns absent, audited
 *   · the dictionary (18.07) holds every metric of docs/metrics.md §3–§6 under its own name
 *   · authorization: every report refuses a role without its permission and an employee limited to a branch
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { auditEvents, branches, carriers, commissions, customers, deliveryAttempts, orders, platforms, products, refundItems, refunds, savedReports, shipments, stockMovements, suppliers } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, type Permission } from "~/server/permissions";
import { journalStatements, postCogs, postRefund, postReturnedGoods, postSale } from "~/server/services/accounting/post.server";
import { revenueRecognised } from "~/server/services/accounting/reports.server";
import { customerReport, monthsBetween } from "~/server/services/admin/reports/customers.server";
import { METRICS } from "~/server/services/admin/reports/dictionary";
import { exportReport } from "~/server/services/admin/reports/export.server";
import { abcRows, classify } from "~/server/services/admin/reports/inventory.server";
import { marginReport, marginRows } from "~/server/services/admin/reports/margin.server";
import { performanceReport, shippingPerformance } from "~/server/services/admin/reports/performance.server";
import { splitAmount } from "~/server/services/admin/reports/revenue.server";
import { salesReport } from "~/server/services/admin/reports/sales.server";
import { deleteSavedReport, listSavedReports, saveReport, updateSavedReport } from "~/server/services/admin/reports/saved.server";
import { parseCustomerParams, parseInventoryParams, parseMarginParams, parsePerformanceParams, parseSalesParams, savedParamsOf, type SalesDimension } from "~/server/services/admin/reports/types";
import { columnName, crc32, toXlsx, zipStored } from "~/server/services/admin/reports/xlsx";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
/** Noon in Baghdad on a day of 2026. */
const at = (month: number, day: number) => Date.UTC(2026, month - 1, day, 9, 0, 0);
const JUNE = "period=2026-06";

let t: TestDb;
let make: Fixtures;
const role = (key: "owner" | "manager" | "finance" | "inventory" | "support" | "cashier", id = newId("emp")): EmployeeActor => ({ kind: "employee", id, permissions: defaultRolePermissions(key), label: key });
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

/** The scenario's ids. */
const s = {
  ps: "plt_rep_ps",
  nin: "plt_rep_nin",
  branch: "brn_rep_1",
  carrier: "car_rep_1",
  o1: "",
  o2: "",
  l1: "",
  l2: "",
  l3: "",
  p1: { variantId: "", sku: "" },
  p2: { variantId: "", sku: "" },
  p3: { variantId: "", sku: "" },
  c1: "",
  c2: "",
  owner: role("owner"),
};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  const db = t.db;
  const base = { createdBy: "system:test", isDemo: false };

  await runBatch(db, [
    db.insert(platforms).values({ id: s.ps, slug: "rep-ps", name: { ar: "PlayStation", en: "PlayStation" } }),
    db.insert(platforms).values({ id: s.nin, slug: "rep-nin", name: { ar: "Nintendo", en: "Nintendo" } }),
    db.insert(branches).values({ id: s.branch, code: "BGD-1", name: { ar: "فرع الكرادة", en: "Karrada branch" }, createdAt: NOW }),
    db.insert(carriers).values({ id: s.carrier, code: "REP-C", name: "ناقل التقارير", createdAt: NOW }),
  ]);
  const p1 = await make.product({ priceIqd: 500_000, stock: 5 });
  const p2 = await make.product({ priceIqd: 100_000, stock: 5, kind: "game" });
  const p3 = await make.product({ priceIqd: 50_000, stock: 5, kind: "accessory" });
  await db.update(products).set({ platformId: s.ps }).where(eq(products.id, p1.productId));
  await db.update(products).set({ platformId: s.nin }).where(eq(products.id, p2.productId));
  s.p1 = p1;
  s.p2 = p2;
  s.p3 = p3;
  s.c1 = await make.customer();
  s.c2 = await make.customer();
  const merged = await make.customer({ status: "merged" });

  // O1 — web, placed 8 June, 500,000 × 1 + 100,000 × 2 = 700,000, discount 70,000, delivery 5,000 → 635,000, paid,
  // shipped 9 June, delivered 10 June; 90,000 refunded on 15 June for one of the two games, which came back
  const o1 = await make.order([{ ...p1, qty: 1, unitPriceIqd: 500_000 }, { ...p2, qty: 2, unitPriceIqd: 100_000 }], { customerId: s.c1, discountIqd: 70_000, status: "delivered", placedAt: at(6, 8), paidIqd: 635_000, refundedIqd: 90_000 });
  s.o1 = o1.orderId;
  [s.l1, s.l2] = o1.itemIds;
  const pay1 = await make.payment(o1.orderId, 635_000, { method: "cod", status: "paid", paidAt: at(6, 10) });
  const refund1 = newId("rfd");
  await runBatch(db, [
    db.insert(refunds).values({ id: refund1, orderId: o1.orderId, paymentId: pay1, amountIqd: 90_000, method: "cash", reason: "game returned", status: "paid", createdAt: at(6, 15), paidAt: at(6, 15) }),
    db.insert(refundItems).values({ refundId: refund1, orderItemId: s.l2, qty: 1 }),
    db.insert(stockMovements).values([
      { id: newId("mov"), variantId: p1.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -1, unitCostIqd: 400_000, refType: "order", refId: o1.orderId, actorKind: "system", actorId: "test", at: at(6, 9) },
      { id: newId("mov"), variantId: p2.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -2, unitCostIqd: 60_000, refType: "order", refId: o1.orderId, actorKind: "system", actorId: "test", at: at(6, 9) },
      { id: newId("mov"), variantId: p2.variantId, locationId: DEFAULT_LOCATION_ID, kind: "return", qtyDelta: 1, unitCostIqd: 60_000, refType: "order", refId: o1.orderId, actorKind: "system", actorId: "test", at: at(6, 15) },
    ]),
    ...postSale(db, { ...base, at: at(6, 10), orderId: o1.orderId, ref: o1.ref, subtotalIqd: 700_000, discountIqd: 70_000, shippingIqd: 5_000, totalIqd: 635_000 }),
    ...postCogs(db, { ...base, at: at(6, 10), orderId: o1.orderId, ref: o1.ref, cogsIqd: 520_000 }),
    ...postRefund(db, { ...base, at: at(6, 15), refundId: refund1, orderId: o1.orderId, ref: o1.ref, amountIqd: 90_000, paidFrom: "cash", revenueRecognized: true }),
    ...postReturnedGoods(db, { ...base, at: at(6, 15), key: `test:${refund1}`, refType: "return", refId: "rtn_rep_1", orderId: o1.orderId, ref: o1.ref, restockedCostIqd: 60_000, scrappedCostIqd: 0, cogsPosted: true }),
  ]);
  const employee = await make.employee();
  const s1 = newId("shp");
  await runBatch(db, [
    db.insert(commissions).values({ id: newId("com"), employeeId: employee, orderId: o1.orderId, orderItemId: s.l1, basis: "sales", baseAmountIqd: 500_000, rateBps: 200, amountIqd: 10_000, period: "2026-06", createdAt: at(6, 10) }),
    db.insert(shipments).values({ id: s1, orderId: o1.orderId, carrierId: s.carrier, status: "delivered", codAmountIqd: 635_000, costIqd: 7_000, shippedAt: at(6, 9), deliveredAt: at(6, 10), codSettledAt: at(6, 14), createdAt: at(6, 9), updatedAt: at(6, 14) }),
    db.insert(deliveryAttempts).values([
      { id: newId("dat"), shipmentId: s1, attemptNo: 1, outcome: "no_answer", attemptedAt: at(6, 9) },
      { id: newId("dat"), shipmentId: s1, attemptNo: 2, outcome: "delivered", attemptedAt: at(6, 10) },
    ]),
  ]);

  // O2 — a counter sale at the branch, 20 June: 50,000 × 2, no discount, no delivery, units without any cost
  const o2 = await make.order([{ ...p3, qty: 2, unitPriceIqd: 50_000 }], { channel: "pos", branchId: s.branch, status: "delivered", placedAt: at(6, 20), shippingIqd: 0, paidIqd: 100_000 });
  s.o2 = o2.orderId;
  [s.l3] = o2.itemIds;
  await make.payment(o2.orderId, 100_000, { method: "pos_cash", status: "paid", paidAt: at(6, 20) });
  await runBatch(db, [
    db.insert(stockMovements).values({ id: newId("mov"), variantId: p3.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -2, unitCostIqd: null, reason: "no_cost_layer_uncosted", refType: "order", refId: o2.orderId, actorKind: "system", actorId: "test", at: at(6, 20) }),
    ...postSale(db, { ...base, at: at(6, 20), orderId: o2.orderId, ref: o2.ref, subtotalIqd: 100_000, discountIqd: 0, shippingIqd: 0, totalIqd: 100_000 }),
  ]);

  // a manual entry on sales revenue (belongs to no order), a cancelled order, a later purchase, a merged account's
  // purchase, a demo order, two more parcels
  await runBatch(db, journalStatements(db, { at: at(6, 25), memo: "manual revenue", refType: "manual", refId: "man_rep", createdBy: "system:test", lines: [{ accountCode: "cash", debitIqd: 1_000 }, { accountCode: "sales_revenue", creditIqd: 1_000 }] }));
  await make.order([{ ...p3, qty: 1, unitPriceIqd: 50_000 }], { status: "cancelled", placedAt: at(6, 22) });
  await make.order([{ ...p2, qty: 1, unitPriceIqd: 100_000 }], { customerId: s.c1, status: "confirmed", placedAt: at(7, 3), paidIqd: 105_000 });
  await make.order([{ ...p3, qty: 1, unitPriceIqd: 45_000 }], { customerId: s.c2, status: "confirmed", placedAt: at(6, 25), paidIqd: 50_000 });
  await make.order([{ ...p3, qty: 1, unitPriceIqd: 45_000 }], { customerId: merged, status: "confirmed", placedAt: at(6, 26), paidIqd: 50_000 });
  const demo = await make.order([{ ...p1, qty: 1, unitPriceIqd: 999_000 }], { customerId: s.c2, isDemo: true, status: "delivered", placedAt: at(6, 11), paidIqd: 1_004_000 });
  await runBatch(db, postSale(db, { createdBy: "system:test", isDemo: true, at: at(6, 12), orderId: demo.orderId, ref: demo.ref, subtotalIqd: 999_000, discountIqd: 0, shippingIqd: 5_000, totalIqd: 1_004_000 }));
  const returned = await make.order([{ ...p3, qty: 1, unitPriceIqd: 50_000 }], { status: "returned", placedAt: at(6, 10) });
  const open = await make.order([{ ...p3, qty: 1, unitPriceIqd: 50_000 }], { status: "shipped", placedAt: at(6, 11) });
  await runBatch(db, [
    db.insert(shipments).values({ id: newId("shp"), orderId: returned.orderId, carrierId: s.carrier, status: "returned", shippedAt: at(6, 11), createdAt: at(6, 11), updatedAt: at(6, 13) }),
    db.insert(shipments).values({ id: newId("shp"), orderId: open.orderId, carrierId: s.carrier, status: "in_transit", shippedAt: at(6, 12), createdAt: at(6, 12), updatedAt: at(6, 12) }),
    db.insert(shipments).values({ id: newId("shp"), orderId: demo.orderId, carrierId: s.carrier, status: "delivered", shippedAt: at(6, 12), deliveredAt: at(6, 12), createdAt: at(6, 12), updatedAt: at(6, 12) }),
  ]);
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── 18.01

describe("sales (18.01): the books split, never redefined", () => {
  test("every breakdown plus 'not attributed' adds up to revenueRecognised to the dinar", async () => {
    const core = await revenueRecognised(t.db, { from: Date.UTC(2026, 5, 1) - 3 * 3600_000, to: Date.UTC(2026, 6, 1) - 3 * 3600_000 });
    expect(core).toMatchObject({ grossIqd: 801_000, discountsIqd: 70_000, refundsIqd: 90_000, shippingIncomeIqd: 5_000, netIqd: 641_000, ordersRecognised: 2 });
    for (const by of ["day", "channel", "branch", "platform"] as SalesDimension[]) {
      const report = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(`${JUNE}&by=${by}`), NOW), "ar", NOW, { all: true });
      expect(report.consistent, by).toBe(true);
      expect(report.totals).toMatchObject({ grossIqd: 801_000, netIqd: 641_000, refundsIqd: 90_000, discountsIqd: 70_000, shippingIqd: 5_000 });
      const net = report.rows.reduce((sum, row) => sum + row.revenue.netIqd, 0) + report.unattributed.netIqd;
      expect(net, by).toBe(641_000);
    }
  });

  test("channel, branch and day rows; the manual entry is shown apart", async () => {
    const channel = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(`${JUNE}&by=channel`), NOW), "ar", NOW);
    const web = channel.rows.find((row) => row.key === "web");
    const pos = channel.rows.find((row) => row.key === "pos");
    expect(web?.revenue).toEqual({ grossIqd: 700_000, discountsIqd: 70_000, refundsIqd: 90_000, shippingIqd: 5_000, netIqd: 540_000 });
    expect(pos?.revenue.netIqd).toBe(100_000);
    expect(channel.unattributed.netIqd).toBe(1_000);
    const branch = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(`${JUNE}&by=branch`), NOW), "en", NOW);
    expect(branch.rows.find((row) => row.key === s.branch)).toMatchObject({ name: "Karrada branch", revenue: { netIqd: 100_000 }, units: 2 });
    expect(branch.rows.find((row) => row.key === "~web")?.label).toEqual({ kind: "branch", id: null, channel: "web" });
    const day = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(`${JUNE}&by=day`), NOW), "ar", NOW);
    expect(day.total).toBe(30);
    expect(day.pageCount).toBe(1);
    expect(day.rows.find((row) => row.key === "2026-06-10")?.revenue).toMatchObject({ grossIqd: 700_000, discountsIqd: 70_000, shippingIqd: 5_000 });
    expect(day.rows.find((row) => row.key === "2026-06-15")?.revenue.refundsIqd).toBe(90_000);
    expect(day.rows.find((row) => row.key === "2026-06-25")?.revenue.grossIqd).toBe(1_000);
    expect(day.unattributed.netIqd).toBe(0);
  });

  test("platform: an order's amounts split over its lines exactly; a refund follows the item it names", async () => {
    const report = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(`${JUNE}&by=platform`), NOW), "en", NOW);
    const ps = report.rows.find((row) => row.key === s.ps);
    const nin = report.rows.find((row) => row.key === s.nin);
    const none = report.rows.find((row) => row.key === "~none");
    // discount 70,000 by value 5:2; delivery 5,000 → 3,571 / 1,429 (the dinar left goes to the larger remainder)
    expect(ps?.revenue).toEqual({ grossIqd: 500_000, discountsIqd: 50_000, refundsIqd: 0, shippingIqd: 3_571, netIqd: 450_000 });
    expect(nin?.revenue).toEqual({ grossIqd: 200_000, discountsIqd: 20_000, refundsIqd: 90_000, shippingIqd: 1_429, netIqd: 90_000 });
    expect(none?.revenue.netIqd).toBe(100_000);
    expect([ps?.units, nin?.units, none?.units]).toEqual([1, 1, 2]);
    expect(ps?.name).toBe("PlayStation");
    expect(report.unattributed.grossIqd).toBe(1_000);
    expect(report.consistent).toBe(true);
  });

  test("operational figures follow docs/metrics.md §3; demo rows only when asked", async () => {
    const report = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(JUNE), NOW), "ar", NOW);
    // placed in June (real): O1, O2, the cancelled one, C2's, the merged account's, the returned and the open one
    expect(report.operations.placed).toBe(7);
    expect(report.operations.cancelled).toBe(1);
    expect(report.operations.paidSalesIqd).toBe(635_000 + 100_000 - 90_000);
    expect(report.operations.refundRateBps).toBe(Math.round((90_000 * 10_000) / 735_000));
    expect(report.operations.returnRateBps).toBe(2_000);
    expect(report.operations.unitsSold).toBe(4);
    expect(report.operations.cancellationBps).toBe(Math.round(10_000 / 7));
    const withDemo = await salesReport(t.db, s.owner, parseSalesParams(new URLSearchParams(`${JUNE}&demo=1`), NOW), "ar", NOW);
    expect(withDemo.totals.grossIqd).toBe(801_000 + 999_000);
    expect(withDemo.operations.placed).toBe(8);
    expect(withDemo.consistent).toBe(true);
  });

  test("splitAmount is exact to the dinar, signed, and falls back when the weights are zero", () => {
    const shares = splitAmount(5_000, [
      { id: "a", weight: 500_000 },
      { id: "b", weight: 200_000 },
    ]);
    expect(Object.fromEntries(shares)).toEqual({ a: 3_571, b: 1_429 });
    expect(Object.fromEntries(splitAmount(-10, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }]))).toEqual({ a: -5, b: -5 });
    expect(Object.fromEntries(splitAmount(7, [{ id: "a", weight: 0 }, { id: "b", weight: 0 }], [{ id: "a", weight: 3 }, { id: "b", weight: 4 }]))).toEqual({ a: 3, b: 4 });
  });
});

// ───────────────────────────────────────────────────────────────── 18.02

describe("net margin per SKU (18.02): metrics §4 'profit of one order', split over its lines", () => {
  test("each SKU's figures by hand; the SKUs of one order add up to its profit", async () => {
    const result = await marginRows(t.db, s.owner, parseMarginParams(new URLSearchParams(JUNE), NOW).range, "ar");
    expect(result.orders).toBe(2);
    const byVariant = (variantId: string) => result.rows.find((row) => row.variantId === variantId);
    // P1: 500,000 − 50,000 discount; cost 400,000; commission 10,000; delivery (7,000 − 5,000) × 5/7 → 1,429
    expect(byVariant(s.p1.variantId)).toMatchObject({ units: 1, revenueIqd: 500_000, discountsIqd: 50_000, refundsIqd: 0, netRevenueIqd: 450_000, cogsIqd: 400_000, commissionsIqd: 10_000, shippingSubsidyIqd: 1_429, netProfitIqd: 38_571 });
    // P2: 200,000 − 20,000 − the 90,000 refund of its item; cost 120,000 − 60,000 that came back; delivery 571
    expect(byVariant(s.p2.variantId)).toMatchObject({ units: 1, netRevenueIqd: 90_000, cogsIqd: 60_000, commissionsIqd: 0, shippingSubsidyIqd: 571, netProfitIqd: 29_429 });
    // O1's profit = (700,000 − 70,000 − 90,000) − 460,000 − 10,000 − (7,000 − 5,000) = 68,000
    expect((byVariant(s.p1.variantId)?.netProfitIqd ?? 0) + (byVariant(s.p2.variantId)?.netProfitIqd ?? 0)).toBe(68_000);
    // P3 (the counter sale): no cost known — counted, adds nothing; the order is incomplete
    expect(byVariant(s.p3.variantId)).toMatchObject({ units: 2, netRevenueIqd: 100_000, cogsIqd: 0, uncostedUnits: 2, carrierUnknownOrders: 0, netProfitIqd: 100_000 });
    expect(result.totals).toMatchObject({ netRevenueIqd: 640_000, cogsIqd: 460_000, commissionsIqd: 10_000, shippingSubsidyIqd: 2_000, netProfitIqd: 168_000, incompleteOrders: 1 });
    expect(result.totals.netMarginBps).toBe(Math.round((168_000 * 10_000) / 640_000));
  });

  test("cost and profit fields are ABSENT without their permissions — page data and export alike", async () => {
    const reader = custom(["reports.margin.read", "reports.export.create"]);
    const page = await marginReport(t.db, reader, parseMarginParams(new URLSearchParams(JUNE), NOW), "ar");
    expect(page.access).toEqual({ cost: false, profit: false });
    const json = JSON.stringify(page);
    for (const key of ["cogsIqd", "netProfitIqd", "commissionsIqd", "shippingSubsidyIqd", "landedCostIqd", "netMarginBps", "uncostedUnits"]) expect(json).not.toContain(`"${key}"`);
    expect(page.books.cogsIqd).toBeUndefined();
    expect(page.books.netProfitIqd).toBeUndefined();
    expect(page.sort).toBe("revenue");
    // cost without profit: cost of goods yes, profit no (profit minus revenue would reveal… nothing more, but the rule is the core's)
    const costOnly = await marginReport(t.db, custom(["reports.margin.read", "cost.read"]), parseMarginParams(new URLSearchParams(`${JUNE}&sort=profit`), NOW), "ar");
    expect(costOnly.rows.some((row) => row.cogsIqd !== undefined)).toBe(true);
    expect(JSON.stringify(costOnly)).not.toContain('"netProfitIqd"');
    expect(costOnly.sort).toBe("revenue");
    const file = await exportReport(t.db, reader, { key: "margin", format: "csv", params: new URLSearchParams(JUNE) }, "en", NOW, (key) => key);
    expect(String(file.body)).not.toMatch(/col\.cogsIqd|col\.netProfitIqd|col\.commissionsIqd/);
    expect(String(file.body)).toContain("col.netRevenueIqd");
  });

  test("the page: sorted by profit for the owner, today's landed cost from pricing beside the page's rows, the books for the same dates", async () => {
    const page = await marginReport(t.db, s.owner, parseMarginParams(new URLSearchParams(JUNE), NOW), "ar");
    expect(page.sort).toBe("profit");
    expect(page.rows[0].variantId).toBe(s.p3.variantId);
    expect(page.rows.every((row) => "landedCostIqd" in row)).toBe(true);
    expect(page.books.netRevenueIqd).toBe(641_000);
    expect(page.books.cogsIqd).toBe(460_000);
    const searched = await marginReport(t.db, s.owner, parseMarginParams(new URLSearchParams(`${JUNE}&q=${encodeURIComponent(s.p2.sku)}`), NOW), "ar");
    expect(searched.rows.map((row) => row.variantId)).toEqual([s.p2.variantId]);
  });
});

// ───────────────────────────────────────────────────────────────── 18.03

describe("ABC (18.03)", () => {
  test("classify: A while the running share before the SKU is under 80 %, B under 95 %, a value of zero or less is C", () => {
    const ranked = classify([
      { key: "a", value: 70 },
      { key: "b", value: 15 },
      { key: "c", value: 10 },
      { key: "d", value: 5 },
      { key: "e", value: 0 },
      { key: "f", value: -3 },
    ]);
    expect(ranked.map((row) => `${row.key}${row.abcClass}`)).toEqual(["aA", "bA", "cB", "dC", "eC", "fC"]);
    expect(ranked[1].cumulative).toBeCloseTo(0.85);
  });

  test("by net revenue of the range — the same figures as sales by platform", async () => {
    const result = await abcRows(t.db, s.owner, parseInventoryParams(new URLSearchParams(JUNE), NOW).range, "revenue", "ar");
    expect(result.rows.map((row) => [row.variantId, row.value, row.abcClass])).toEqual([
      [s.p1.variantId, 450_000, "A"],
      [s.p3.variantId, 100_000, "A"],
      [s.p2.variantId, 90_000, "B"],
    ]);
    expect(result.totalValue).toBe(640_000);
    expect(result.classes.A.skus).toBe(2);
    const units = await abcRows(t.db, s.owner, parseInventoryParams(new URLSearchParams(JUNE), NOW).range, "units", "ar");
    expect(units.rows[0]).toMatchObject({ variantId: s.p3.variantId, value: 2 });
  });
});

// ───────────────────────────────────────────────────────────────── 18.04

describe("cohorts, repeat purchases, value (18.04)", () => {
  test("June's cohort: who came back in July, months not reached yet are null (never 0 %), guests and merged accounts apart", async () => {
    const report = await customerReport(t.db, s.owner, parseCustomerParams(new URLSearchParams(JUNE), NOW), NOW);
    expect(report.cohorts).toHaveLength(1);
    const june = report.cohorts[0];
    expect(june.cohort).toBe("2026-06");
    expect(june.customers).toBe(2);
    expect(june.retention.slice(0, 3)).toEqual([1, 0.5, 0]);
    // November 2026 is month 5: months 6–11 have not come yet
    expect(june.retention.slice(6)).toEqual([null, null, null, null, null, null]);
    expect(report.repeat).toMatchObject({ customers: 2, repeaters: 1, repeatBps: 5_000, medianDaysToSecond: 25, purchasesPerCustomer: 1.5 });
    // kept: C1 (635,000 − 90,000) + 105,000, C2 50,000
    expect(report.repeat.valuePerCustomerIqd).toBe(Math.round((545_000 + 105_000 + 50_000) / 2));
    expect(report.guestPurchases).toBe(1);
    expect(monthsBetween("2026-06", "2027-01")).toBe(7);
  });

  test("value: every customer's RFM segment by module 07's rules; demo orders only when asked", async () => {
    const report = await customerReport(t.db, s.owner, parseCustomerParams(new URLSearchParams(`${JUNE}&view=value`), NOW), NOW);
    expect(report.value?.customers).toBe(2);
    expect(report.value?.segments.reduce((sum, row) => sum + row.customers, 0)).toBe(2);
    expect(report.value?.keptIqd).toBe(545_000 + 105_000 + 50_000);
    const withDemo = await customerReport(t.db, s.owner, parseCustomerParams(new URLSearchParams(`${JUNE}&view=value&demo=1`), NOW), NOW);
    expect(withDemo.value?.keptIqd).toBe(545_000 + 105_000 + 50_000 + 1_004_000);
  });
});

// ───────────────────────────────────────────────────────────────── 18.05

describe("performance (18.05)", () => {
  test("shipping: success, first attempt, failed tries, cash-on-delivery settlement time; demo parcels left out", async () => {
    const result = await shippingPerformance(t.db, s.owner, parsePerformanceParams(new URLSearchParams(JUNE), NOW).range, NOW);
    expect(result.total).toMatchObject({ sent: 3, delivered: 1, returned: 1, open: 1, successRate: 0.5, firstAttemptRate: 0, failedAttempts: 1, medianDeliveryDays: 1 });
    expect(result.total.cod).toMatchObject({ delivered: 1, settled: 1, medianSettleDays: 4, awaiting: 0 });
    expect(result.rows[0].name).toBe("ناقل التقارير");
    expect(JSON.stringify(result)).not.toMatch(/cost/i);
  });

  test("each section needs its owning module's permission too: finance gets suppliers and shipping, not employees or service times", async () => {
    const finance = role("finance");
    const employees = await performanceReport(t.db, finance, parsePerformanceParams(new URLSearchParams(`${JUNE}&view=employees`), NOW), "ar", NOW);
    expect(employees.sections.employees).toEqual({ open: false, needs: "staff.performance.read" });
    expect(employees.employees).toBeNull();
    const support = await performanceReport(t.db, finance, parsePerformanceParams(new URLSearchParams(`${JUNE}&view=support`), NOW), "ar", NOW);
    expect(support.support).toBeNull();
    expect(await failureOf(exportReport(t.db, finance, { key: "performance", format: "csv", params: new URLSearchParams(`${JUNE}&view=support`) }, "ar", NOW, (k) => k))).toMatchObject({ code: "forbidden", status: 403 });
    const owner = await performanceReport(t.db, s.owner, parsePerformanceParams(new URLSearchParams(`${JUNE}&view=employees`), NOW), "ar", NOW);
    expect(owner.employees?.period).toBe("2026-06");
    const supplierId = newId("sup");
    await t.db.insert(suppliers).values({ id: supplierId, code: "REP-S", name: "مورد التقارير", createdAt: NOW, updatedAt: NOW });
    const firstOpen = await performanceReport(t.db, finance, parsePerformanceParams(new URLSearchParams(JUNE), NOW), "ar", NOW);
    expect(firstOpen.view).toBe("suppliers");
    expect(firstOpen.suppliers?.rows.find((row) => row.id === supplierId)?.rating).toMatchObject({ enough: false, score: null, grade: null });
  });
});

// ───────────────────────────────────────────────────────────────── authorization

describe("authorization: every report, every role", () => {
  test("a role without a report's permission is refused (403); an employee limited to a branch is refused too", async () => {
    const support = role("support");
    const params = new URLSearchParams(JUNE);
    expect(await failureOf(salesReport(t.db, support, parseSalesParams(params, NOW), "ar", NOW))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await failureOf(marginReport(t.db, support, parseMarginParams(params, NOW), "ar"))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(abcRows(t.db, support, parseInventoryParams(params, NOW).range, "revenue", "ar"))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(customerReport(t.db, support, parseCustomerParams(params, NOW), NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(performanceReport(t.db, support, parsePerformanceParams(params, NOW), "ar", NOW))).toMatchObject({ code: "forbidden" });
    const salesOnly = custom(["reports.sales.read"]);
    expect(await failureOf(marginReport(t.db, salesOnly, parseMarginParams(params, NOW), "ar"))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(exportReport(t.db, salesOnly, { key: "sales", format: "csv", params }, "ar", NOW, (k) => k))).toMatchObject({ code: "forbidden" });
    const branchLimited: EmployeeActor = { ...role("owner"), branchId: s.branch };
    expect(await failureOf(salesReport(t.db, branchLimited, parseSalesParams(params, NOW), "ar", NOW))).toMatchObject({ code: "forbidden", status: 403 });
    // the default roles: finance and manager open every report; cashier, support, content, fulfillment, inventory none
    for (const key of ["finance", "manager"] as const) await expect(salesReport(t.db, role(key), parseSalesParams(params, NOW), "ar", NOW)).resolves.toBeTruthy();
    for (const key of ["cashier", "inventory"] as const) expect(await failureOf(salesReport(t.db, role(key), parseSalesParams(params, NOW), "ar", NOW))).toMatchObject({ code: "forbidden" });
  });
});

// ───────────────────────────────────────────────────────────────── 18.06

describe("saved reports (18.06)", () => {
  test("saving needs reports.saved.manage AND the report's permission; parameters are normalised; a double submit is one record", async () => {
    const finance = role("finance", await make.employee());
    const key = "saved-key-0000000000000001";
    const first = await saveReport(t.db, finance, { reportKey: "sales", name: "  مبيعات حزيران حسب المنصة ", search: `?${JUNE}&by=platform&page=3&junk=1&demo=1`, shared: true, idempotencyKey: key }, NOW);
    const again = await saveReport(t.db, finance, { reportKey: "sales", name: "مبيعات حزيران حسب المنصة", search: `?${JUNE}&by=platform`, shared: true, idempotencyKey: key }, NOW);
    expect(again).toEqual({ id: first.id, replayed: true });
    const row = await t.db.select().from(savedReports).where(eq(savedReports.id, first.id)).get();
    expect(row?.params).toEqual({ period: "2026-06", by: "platform", demo: "1" });
    expect(row?.name).toBe("مبيعات حزيران حسب المنصة");
    expect(await failureOf(saveReport(t.db, finance, { reportKey: "sales", name: "another", search: "", idempotencyKey: key }, NOW))).toMatchObject({ code: "idempotency_mismatch", status: 409 });
    const noSave = custom(["reports.sales.read"]);
    expect(await failureOf(saveReport(t.db, noSave, { reportKey: "sales", name: "x1", search: "", idempotencyKey: "saved-key-0000000000000002" }, NOW))).toMatchObject({ code: "forbidden" });
    const noReport = custom(["reports.saved.manage", "reports.sales.read"]);
    expect(await failureOf(saveReport(t.db, noReport, { reportKey: "margin", name: "x2", search: "", idempotencyKey: "saved-key-0000000000000003" }, NOW))).toMatchObject({ code: "forbidden" });
    const invalid = await failureOf(saveReport(t.db, finance, { reportKey: "sales", name: "x", search: "", idempotencyKey: "saved-key-0000000000000004" }, NOW));
    expect(invalid).toMatchObject({ code: "invalid", status: 400 });
    expect(invalid.fields?.name).toBe("too_short");
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, first.id));
    expect(audit.map((event) => event.action)).toEqual(["reports.saved.create"]);
  });

  test("a shared report shows to those who may open its report only; only the owner renames, shares or deletes — with the version it saw and a reason", async () => {
    const ownerId = await make.employee();
    const author = role("finance", ownerId);
    const { id } = await saveReport(t.db, author, { reportKey: "margin", name: "هامش الشهر", search: `?${JUNE}&sort=margin`, shared: true, idempotencyKey: "saved-key-0000000000000010" }, NOW);
    const colleague = role("manager");
    const salesOnly = custom(["reports.sales.read"]);
    expect((await listSavedReports(t.db, colleague)).some((view) => view.id === id && !view.mine && view.owner.id === ownerId)).toBe(true);
    expect((await listSavedReports(t.db, salesOnly)).some((view) => view.id === id)).toBe(false);
    const listed = (await listSavedReports(t.db, author)).find((view) => view.id === id);
    expect(listed?.href).toBe("/admin/reports/margin?period=2026-06&sort=margin");
    expect(await failureOf(updateSavedReport(t.db, colleague, { id, name: "سرقة", shared: false, expectedUpdatedAt: NOW }, NOW + 1))).toMatchObject({ code: "saved_not_owner", status: 403 });
    expect(await failureOf(updateSavedReport(t.db, salesOnly, { id, name: "سرقة", shared: false, expectedUpdatedAt: NOW }, NOW + 1))).toMatchObject({ code: "forbidden" });
    expect(await updateSavedReport(t.db, author, { id, name: "هامش حزيران", shared: false, expectedUpdatedAt: NOW }, NOW + 5)).toEqual({ changed: true });
    expect(await failureOf(updateSavedReport(t.db, author, { id, name: "قديم", shared: true, expectedUpdatedAt: NOW }, NOW + 6))).toMatchObject({ code: "saved_changed", status: 409 });
    expect((await listSavedReports(t.db, colleague)).some((view) => view.id === id)).toBe(false);
    // a record the employee cannot see is not found, whoever asks
    expect(await failureOf(deleteSavedReport(t.db, colleague, { id, reason: "تنظيف", expectedUpdatedAt: NOW + 5 }, NOW + 7))).toMatchObject({ code: "not_found", status: 404 });
    expect(await failureOf(deleteSavedReport(t.db, author, { id, reason: "x", expectedUpdatedAt: NOW + 5 }, NOW + 7))).toMatchObject({ code: "invalid" });
    expect(await deleteSavedReport(t.db, author, { id, reason: "لم يعد مطلوباً", expectedUpdatedAt: NOW + 5 }, NOW + 7)).toEqual({ deleted: true });
    expect(await t.db.select().from(savedReports).where(eq(savedReports.id, id)).get()).toBeUndefined();
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audit.map((event) => event.action).sort()).toEqual(["reports.saved.create", "reports.saved.delete", "reports.saved.update"]);
    expect(audit.find((event) => event.action === "reports.saved.delete")?.reason).toBe("لم يعد مطلوباً");
  });

  test("savedParamsOf keeps only what the report's page accepts", () => {
    expect(savedParamsOf("inventory", new URLSearchParams("view=abc&basis=units&class=B&days=60&page=2&period=2026-06"), NOW)).toEqual({ period: "2026-06", basis: "units", class: "B" });
    expect(savedParamsOf("inventory", new URLSearchParams("view=dead&days=60&class=B"), NOW)).toMatchObject({ view: "dead", days: "60" });
    expect(savedParamsOf("sales", new URLSearchParams("by=nonsense&from=2026-06-01&to=2026-06-07"), NOW)).toEqual({ from: "2026-06-01", to: "2026-06-07" });
  });
});

describe("exports (18.06)", () => {
  test("CSV: the page's figures, formula-safe cells, audited with what it carried", async () => {
    const finance = role("finance");
    const file = await exportReport(t.db, finance, { key: "sales", format: "csv", params: new URLSearchParams(`${JUNE}&by=channel`) }, "en", NOW, (key) => (key === "channel.web" ? "=web+1" : key));
    const text = String(file.body);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("'=web+1");
    expect(text).toContain("641000");
    expect((file.headers as Record<string, string>)["Cache-Control"]).toBe("no-store");
    const events = await t.db.select().from(auditEvents).where(sql`${auditEvents.action} = 'reports.export.create' AND ${auditEvents.actorId} = ${finance.id}`);
    expect(events).toHaveLength(1);
    expect(events[0].after).toMatchObject({ format: "csv", params: { period: "2026-06", by: "channel" }, includedProtected: { cost: false, profit: false } });
    const margin = await exportReport(t.db, finance, { key: "margin", format: "csv", params: new URLSearchParams(JUNE) }, "en", NOW, (key) => key);
    expect(String(margin.body)).toContain("col.netProfitIqd");
    const marginEvent = await t.db.select().from(auditEvents).where(sql`${auditEvents.action} = 'reports.export.create' AND ${auditEvents.entityId} = 'margin' AND ${auditEvents.actorId} = ${finance.id}`);
    expect(marginEvent[0].after).toMatchObject({ includedProtected: { cost: true, profit: true } });
  });

  test("XLSX: a valid package (stored ZIP, CRC-32), text as inline strings — a leading '=' is never a formula", async () => {
    const file = await exportReport(t.db, s.owner, { key: "sales", format: "xlsx", params: new URLSearchParams(`${JUNE}&by=channel`) }, "ar", NOW, (key) => (key === "channel.web" ? "=HYPERLINK(1)" : key));
    const bytes = file.body as Uint8Array;
    const entries = unzip(bytes);
    expect(Object.keys(entries).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = entries["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain("=HYPERLINK(1)");
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("<v>641000</v>");
    expect((file.headers as Record<string, string>)["Content-Type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  test("xlsx helpers", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect([columnName(0), columnName(25), columnName(26), columnName(701), columnName(702)]).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    const plain = toXlsx({ name: "a:b/c", rows: [["x", 1.5, null, "y\u0001"]] });
    expect(unzip(plain)["xl/workbook.xml"]).toContain('name="a b c"');
    expect(unzip(zipStored([{ name: "a.txt", data: new TextEncoder().encode("hello") }]))["a.txt"]).toBe("hello");
  });
});

// ───────────────────────────────────────────────────────────────── 18.07

describe("the metrics dictionary (18.07)", () => {
  test("holds every metric of docs/metrics.md under its own name (every section but the rules, postings and checks), and nothing that is not there", () => {
    const doc = readFileSync(fileURLToPath(new URL("../docs/metrics.md", import.meta.url)), "utf8");
    const names = new Set<string>();
    let section = "";
    for (const line of doc.split(/\r?\n/)) {
      const head = /^## (\d+)\./.exec(line);
      if (head) section = head[1];
      const row = /^\| \*\*(.+?)\*\*/.exec(line);
      // §1 ground rules, §2 when things are recognised (postings) and §7 consistency checks are not metrics
      if (row && section !== "" && !["1", "2", "7"].includes(section)) names.add(`${section}|${row[1]}`);
    }
    const mirrored = new Set(METRICS.flatMap((entry) => (entry.origin.kind === "metrics" ? [`${entry.origin.section}|${entry.origin.docName}`] : [])));
    expect([...mirrored].sort()).toEqual([...names].sort());
    expect(new Set(METRICS.map((entry) => entry.id)).size).toBe(METRICS.length);
  });

  test("every entry has its words in the admin's three languages", async () => {
    const messages = (await import("~/i18n/messages/admin-reports")).default as unknown as Record<string, { dict: { metric: Record<string, { name: string; def: string }> } }>;
    for (const locale of ["ar", "en", "ckb"]) {
      for (const entry of METRICS) {
        expect(messages[locale].dict.metric[entry.id]?.name, `${locale} ${entry.id}`).toBeTruthy();
        expect(messages[locale].dict.metric[entry.id]?.def, `${locale} ${entry.id}`).toBeTruthy();
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── helpers

/** Reads a stored (uncompressed) ZIP: name → UTF-8 text, checking each entry's CRC-32. */
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
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central header");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0) throw new Error("not stored");
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const data = bytes.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out[name] = decoder.decode(data);
    at += 46 + nameLength + extra + comment;
  }
  return out;
}
