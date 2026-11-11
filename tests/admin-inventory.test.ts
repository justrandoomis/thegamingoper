/**
 * Admin module 04 — Inventory and warehouses (owner: admin inventory). Services in
 * app/server/services/admin/inventory/** and the module's route loaders, against a real local D1 with the demo
 * catalogue (seedDemo) and fixtures of their own:
 *   · authorization per built-in role, and field-level cost hiding in views, JSON and CSV (blueprint acceptance #5)
 *   · locations (levels, codes, in-use protection), receiving with inspection and serials, counts (blind counting,
 *     two-person approval, oversell exceptions, idempotent posting), reservations and their manual release,
 *     reorder points and forecasts, adjustments and the documented oversell exception, serials, reports, costing
 *   · the pure helpers (forecast arithmetic, Code 128, CSV)
 * Fixtures are chosen by their properties, never by a hard-coded slug.
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { loader as movementsExportLoader } from "~/routes/admin/inventory/movements-export";
import { loader as scanLoader } from "~/routes/admin/inventory/scan";
import { loader as stockLoader } from "~/routes/admin/inventory/stock";
import { CODE128_PATTERNS, code128, decodeCode128, isCode128B } from "~/routes/admin/inventory/components/code128";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { auditEvents, cycleCountLines, employeeRoles, inventoryLocations, orders, serials, stockLevels, stockMovements, variantCosts } from "~/server/db/schema";
import { demoId, seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { mapDbError, runBatch } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { inventoryOverview, inventoryReport, inventoryReportCsv, listCostLayers, listReorder } from "~/server/services/admin/inventory/analytics.server";
import { approveCount, cancelCount, createCount, getCount, listCounts, recordCounts, sendBackCount, submitCount } from "~/server/services/admin/inventory/counts.server";
import { csvCell, toCsv } from "~/server/services/admin/inventory/csv";
import { coverPlan, salesRate } from "~/server/services/admin/inventory/forecast";
import { createLocation, listLocations, locationLabels, updateLocation } from "~/server/services/admin/inventory/locations.server";
import { listMovements, movementsCsv, parseMovementFilters } from "~/server/services/admin/inventory/movements.server";
import { getReceivingSession, lookupCode, newReceivingSession, receiveLine } from "~/server/services/admin/inventory/receiving.server";
import { listReservations, releaseReservationsOfOrder } from "~/server/services/admin/inventory/reservations.server";
import { findSerials, getSerialHistory } from "~/server/services/admin/inventory/serials.server";
import { adjustFromAdmin, getVariantStock, listOversell, listStock, parseStockFilters, setReorderPoint } from "~/server/services/admin/inventory/stock.server";
import { commitOrderReservations, receiveStock, reserveStatements, assignSerialsStatements } from "~/server/services/inventory/stock.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
const SYSTEM = systemActor("test");
let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  await seedDemo(t.db, NOW - 120 * DAY);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

type Staff = { id: string; email: string; password: string; actor: EmployeeActor };
async function staff(role: DefaultRoleKey, extra: Partial<EmployeeActor> = {}): Promise<Staff> {
  const password = "inventory-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next(role)}@inventory.test`;
  const id = await make.employee({ email, name: `${role} tester`, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password, actor: { kind: "employee", id, permissions: defaultRolePermissions(role), label: `${role} tester`, ...extra } };
}
const key = () => `k_${newId("idem").slice(4)}`;

async function thrown(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const code = async (run: () => Promise<unknown>) => {
  const error = await thrown(run);
  return toAppError(error)?.code ?? String(error);
};

async function addLocation(options: { code?: string; sellable?: boolean } = {}) {
  const id = newId("loc");
  await t.db.insert(inventoryLocations).values({ id, code: options.code ?? make.next("LOC"), name: "Test location", kind: "warehouse", isSellable: options.sellable ?? true });
  return id;
}
async function stocked(qty: number, unitCostIqd: number, options: { locationId?: string; serials?: string[]; at?: number; standardCostIqd?: number } = {}) {
  const product = await make.product({ trackSerials: Boolean(options.serials) });
  if (options.standardCostIqd !== undefined) await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: 1, landedCostIqd: options.standardCostIqd, updatedAt: NOW });
  if (qty > 0) await receiveStock(t.db, SYSTEM, { variantId: product.variantId, locationId: options.locationId ?? DEFAULT_LOCATION_ID, qty, unitCostIqd, serials: options.serials, ref: "fixture" }, options.at ?? NOW);
  return product;
}
async function level(variantId: string, locationId = DEFAULT_LOCATION_ID) {
  return (await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId))).get()) ?? { onHand: 0, reserved: 0, allowOversell: false, reorderPoint: null, reorderQty: null, incoming: 0 };
}
async function reserve(variantId: string, qty: number, extra: Partial<typeof orders.$inferInsert> = {}) {
  const order = await make.order([{ variantId, sku: "fixture", qty, priceIqd: 100_000 }], extra);
  await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId, qty }], expiresAt: extra.status === "awaiting_payment" ? NOW + 3_600_000 : null, actor: SYSTEM, now: NOW }));
  return order;
}
/** Deep search for protected keys anywhere in a result. */
const leaksCost = (value: unknown) => /"(valueIqd|unitCostIqd|costIqd|cogsIqd|unlayeredUnits|standardCostIqd|cost)"/.test(JSON.stringify(value));

// ───────────────────────────────────────────────────────────────── pure helpers

describe("forecast arithmetic", () => {
  test("no rate without enough history or without sales — never infinity, never zero", () => {
    expect(salesRate({ unitsSold: 4, windowDays: 30, historyDays: 3 })).toMatchObject({ basis: "too_little_history", perDay: null });
    expect(salesRate({ unitsSold: 0, windowDays: 30, historyDays: 400 })).toMatchObject({ basis: "no_sales", perDay: null, days: 30 });
    expect(salesRate({ unitsSold: 12, windowDays: 30, historyDays: 400 })).toMatchObject({ basis: "sales", perDay: 0.4, days: 30 });
    // a variant stocked 10 days ago: the rate is over those 10 days, not 30
    expect(salesRate({ unitsSold: 5, windowDays: 30, historyDays: 10 })).toMatchObject({ basis: "sales", perDay: 0.5, days: 10 });
  });
  test("cover, stock-out date, reorder point and the suggested quantity", () => {
    const rate = salesRate({ unitsSold: 30, windowDays: 30, historyDays: 90 });
    expect(coverPlan({ available: 20, incoming: 0, reorderPoint: null, reorderQty: null, rate, now: NOW })).toEqual({ status: "ok", daysOfCover: 20, stockOutAt: NOW + 20 * DAY, suggestedQty: 10, belowReorder: false });
    expect(coverPlan({ available: 5, incoming: 0, reorderPoint: null, reorderQty: null, rate, now: NOW }).status).toBe("soon");
    expect(coverPlan({ available: 5, incoming: 2, reorderPoint: 8, reorderQty: 24, rate, now: NOW })).toMatchObject({ status: "below_reorder", suggestedQty: 24, belowReorder: true });
    expect(coverPlan({ available: 0, incoming: 0, reorderPoint: null, reorderQty: null, rate, now: NOW }).status).toBe("out");
    const none = salesRate({ unitsSold: 0, windowDays: 30, historyDays: 2 });
    expect(coverPlan({ available: 9, incoming: 0, reorderPoint: null, reorderQty: null, rate: none, now: NOW })).toEqual({ status: "no_forecast", daysOfCover: null, stockOutAt: null, suggestedQty: null, belowReorder: false });
  });
});

describe("Code 128 labels and CSV", () => {
  test("every symbol is 11 modules (stop 13) and labels decode back to their code", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((pattern, index) => expect([...pattern].reduce((sum, d) => sum + Number(d), 0)).toBe(index === 106 ? 13 : 11));
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    for (const value of ["MAIN", "MAIN-A01-S02-B03", "DEMO_SHOP.2", "Z9"]) {
      const symbol = code128(value);
      expect(decodeCode128(symbol.widths)).toBe(value);
      expect(symbol.modules).toBe(symbol.widths.reduce((sum, width) => sum + width, 0) + 20);
    }
    expect(isCode128B("مخزن")).toBe(false);
    expect(() => code128("")).toThrow();
  });
  test("CSV cells never run as formulas; quotes and commas are escaped; Excel gets a BOM", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(toCsv([["SKU", "كمية"], ["X", 1]])).toBe("﻿SKU,كمية\r\nX,1\r\n");
  });
});

// ───────────────────────────────────────────────────────────────── authorization and cost hiding

describe("authorization per role and cost hiding", () => {
  test("a role without inventory permissions is refused everywhere; cashier reads stock but not the log", async () => {
    const content = await staff("content");
    expect(await code(() => listStock(t.db, content.actor, parseStockFilters(new URLSearchParams()), "ar"))).toBe("forbidden");
    expect(await code(() => lookupCode(t.db, content.actor, "MAIN", "ar"))).toBe("forbidden");
    expect(await code(() => listLocations(t.db, content.actor))).toBe("forbidden");
    const cashier = await staff("cashier");
    await expect(listStock(t.db, cashier.actor, parseStockFilters(new URLSearchParams()), "ar")).resolves.toBeTruthy();
    expect(await code(() => listMovements(t.db, cashier.actor, parseMovementFilters(new URLSearchParams()), "ar"))).toBe("forbidden");
    expect(await code(() => inventoryReport(t.db, cashier.actor, { report: "dead", days: 90, page: 1 }, "ar", NOW))).toBe("forbidden");
    expect(await code(() => receiveLine(t.db, cashier.actor, {}, NOW))).toBe("forbidden");
    expect(await code(() => createLocation(t.db, cashier.actor, { kind: "warehouse", code: "NOPE", name: "x" }, NOW))).toBe("forbidden");
  });

  test("cost and value are absent — not blank — for roles without cost.read, in views and in the CSV export", async () => {
    const clerk = await staff("inventory");
    const finance = await staff("finance");
    const filters = parseStockFilters(new URLSearchParams("sort=on_hand&dir=desc"));
    const clerkStock = await listStock(t.db, clerk.actor, filters, "ar");
    const financeStock = await listStock(t.db, finance.actor, filters, "ar");
    expect(clerkStock.rows.length).toBeGreaterThan(0);
    expect(leaksCost(clerkStock)).toBe(false);
    expect(financeStock.rows.every((row) => typeof row.valueIqd === "number")).toBe(true);

    const variantId = financeStock.rows[0].id;
    const clerkItem = await getVariantStock(t.db, clerk.actor, variantId, "ar", NOW);
    expect(clerkItem.cost).toBeUndefined();
    expect(leaksCost(clerkItem)).toBe(false);
    const financeItem = await getVariantStock(t.db, finance.actor, variantId, "en", NOW);
    expect(financeItem.cost?.layers.length).toBeGreaterThan(0);

    const clerkLog = await listMovements(t.db, clerk.actor, parseMovementFilters(new URLSearchParams()), "ar");
    expect(clerkLog.rows.length).toBeGreaterThan(0);
    expect(clerkLog.withCost).toBe(false);
    expect(leaksCost(clerkLog)).toBe(false);
    const headers = { at: "at", kind: "kind", sku: "sku", product: "product", location: "location", qty: "qty", reserved: "reserved", refType: "refType", ref: "ref", reason: "reason", actorKind: "actorKind", actor: "actor", serial: "SERIAL", unitCost: "UNIT_COST" };
    const clerkCsv = await movementsCsv(t.db, clerk.actor, parseMovementFilters(new URLSearchParams()), "ar", headers);
    const financeCsv = await movementsCsv(t.db, finance.actor, parseMovementFilters(new URLSearchParams()), "ar", headers);
    expect(clerkCsv.csv.split("\r\n")[0]).not.toContain("UNIT_COST");
    expect(clerkCsv.csv.split("\r\n")[0]).toContain("SERIAL");
    expect(financeCsv.csv.split("\r\n")[0]).toContain("UNIT_COST");
    // finance has no serial.read: no serial column in its export, no serial numbers in its log
    expect(financeCsv.csv.split("\r\n")[0]).not.toContain("SERIAL");

    expect(await code(() => listCostLayers(t.db, clerk.actor, { q: "", location: null, open: true, page: 1 }, "ar"))).toBe("forbidden");
    const layers = await listCostLayers(t.db, finance.actor, { q: "", location: null, open: true, page: 1 }, "ar");
    expect(layers.rows.length).toBeGreaterThan(0);
    expect(layers.summary.valueIqd).toBeGreaterThan(0);

    const clerkOverview = await inventoryOverview(t.db, clerk.actor, NOW);
    expect(clerkOverview.value).toBeUndefined();
    expect((await inventoryOverview(t.db, finance.actor, NOW)).value?.valueIqd).toBeGreaterThan(0);
    const report = await inventoryReportCsv(t.db, clerk.actor, { report: "dead", days: 30 }, "ar", NOW, { sku: "sku", product: "p", onHand: "o", lastSale: "l", lastReceipt: "r", valueIqd: "VALUE", unlayered: "UNLAYERED" });
    expect(report).not.toContain("VALUE");
  });

  test("serial numbers stay private: the scan lookup says only that a code is a serial to roles without serial.read", async () => {
    const [serial] = await t.db.select().from(serials).where(eq(serials.status, "in_stock")).limit(1);
    const support = await staff("support");
    expect(await lookupCode(t.db, support.actor, serial.serial, "ar")).toEqual({ kind: "serial_hidden" });
    const clerk = await staff("inventory");
    expect(await lookupCode(t.db, clerk.actor, serial.serial.toLowerCase(), "ar")).toMatchObject({ kind: "serial", serialId: serial.id });
    expect(await code(() => findSerials(t.db, support.actor, { q: "", status: null, location: null, page: 1 }, "ar"))).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────── locations (04.02)

describe("locations", () => {
  test("warehouse → aisle → shelf → bin, no deeper; codes and barcodes are unique; labels print the barcode", async () => {
    const clerk = await staff("inventory");
    const store = await createLocation(t.db, clerk.actor, { kind: "store", code: make.next("shop").toUpperCase(), name: "متجر" }, NOW);
    const aisle = await createLocation(t.db, clerk.actor, { kind: "bin", parentId: store.locationId, code: `${store.code}-A1`, name: "ممر" }, NOW);
    const shelf = await createLocation(t.db, clerk.actor, { kind: "bin", parentId: aisle.locationId, code: `${store.code}-A1-S1`, name: "رف", isSellable: false }, NOW);
    const bin = await createLocation(t.db, clerk.actor, { kind: "bin", parentId: shelf.locationId, code: `${store.code}-A1-S1-B1`, name: "صندوق" }, NOW);
    expect(await code(() => createLocation(t.db, clerk.actor, { kind: "bin", parentId: bin.locationId, code: `${store.code}-X`, name: "أعمق" }, NOW))).toBe("location_too_deep");
    expect(await code(() => createLocation(t.db, clerk.actor, { kind: "warehouse", code: store.code, name: "مكرر" }, NOW))).toBe("code_taken");
    expect(await code(() => createLocation(t.db, clerk.actor, { kind: "warehouse", code: "bad code!", name: "x" }, NOW))).toBe("invalid");
    expect(await code(() => createLocation(t.db, clerk.actor, { kind: "bin", code: `${store.code}-ORPHAN`, name: "x" }, NOW))).toBe("invalid");

    const tree = await listLocations(t.db, clerk.actor);
    const levels = Object.fromEntries(tree.filter((node) => node.code.startsWith(store.code)).map((node) => [node.code, node.level]));
    expect(levels).toEqual({ [store.code]: "store", [`${store.code}-A1`]: "aisle", [`${store.code}-A1-S1`]: "shelf", [`${store.code}-A1-S1-B1`]: "bin" });
    // a bin inherits "not for sale" from its shelf
    expect(tree.find((node) => node.id === bin.locationId)?.isSellable).toBe(false);
    const labels = await locationLabels(t.db, clerk.actor, [store.locationId], { withChildren: true });
    expect(labels.map((label) => label.barcode)).toEqual(expect.arrayContaining([store.code, `${store.code}-A1-S1-B1`]));
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, bin.locationId)).all();
    expect(audit.map((row) => row.action)).toContain("inventory.location.create");
  });

  test("a location in use cannot be switched off; switching off needs a reason and is audited", async () => {
    const manager = await staff("manager");
    const created = await createLocation(t.db, manager.actor, { kind: "warehouse", code: make.next("wh").toUpperCase(), name: "مستودع" }, NOW);
    const product = await stocked(2, 1000, { locationId: created.locationId });
    expect(await code(() => updateLocation(t.db, manager.actor, { locationId: created.locationId, isActive: false, reason: "closing" }, NOW))).toBe("location_in_use");
    const empty = await createLocation(t.db, manager.actor, { kind: "warehouse", code: make.next("wh").toUpperCase(), name: "فارغ" }, NOW);
    expect(await code(() => updateLocation(t.db, manager.actor, { locationId: empty.locationId, isActive: false }, NOW))).toBe("invalid");
    await updateLocation(t.db, manager.actor, { locationId: empty.locationId, isActive: false, reason: "not used any more" }, NOW);
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, empty.locationId), eq(auditEvents.action, "inventory.location.deactivate"))).get();
    expect(audit?.reason).toBe("not used any more");
    expect(product.variantId).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────── receiving (04.03)

describe("receiving", () => {
  test("inspection keeps rejected units out; a clerk without cost access receives at the standard landed cost", async () => {
    const clerk = await staff("inventory");
    const product = await stocked(0, 0, { standardCostIqd: 210_000 });
    const sessionRef = newReceivingSession();
    const idempotencyKey = key();
    const input = { sessionRef, locationId: DEFAULT_LOCATION_ID, variantId: product.variantId, counted: 6, rejected: 2, rejectReason: "علب مبللة", reference: "DN-7", unitCostIqd: 1, idempotencyKey };
    expect(await receiveLine(t.db, clerk.actor, input, NOW)).toEqual({ accepted: 4, rejected: 2, replayed: false });
    expect(await receiveLine(t.db, clerk.actor, input, NOW + 1000)).toEqual({ accepted: 0, rejected: 0, replayed: true });
    expect((await level(product.variantId)).onHand).toBe(4);
    const movement = await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, product.variantId), eq(stockMovements.kind, "receive"))).get();
    // the typed cost was ignored (no cost.read): the standard cost became the layer
    expect(movement?.unitCostIqd).toBe(210_000);
    expect(movement?.refType).toBe("stock_receipt");
    expect(movement?.refId).toBe(sessionRef);
    expect(movement?.reason).toContain("رُفض 2 (علب مبللة)");
    expect(movement?.reason).toContain(sessionRef);
    expect(movement?.actorId).toBe(clerk.id);
    const session = await getReceivingSession(t.db, clerk.actor, sessionRef, "ar");
    expect(session.lines).toHaveLength(1);
    expect(session.lines[0]).toMatchObject({ counted: 6, accepted: 4, rejected: 2, rejectReason: "علب مبللة", reference: "DN-7" });
  });

  test("no known cost → refused (never received at zero); a manager types the cost; serials are one per accepted unit", async () => {
    const clerk = await staff("inventory");
    const manager = await staff("manager");
    const product = await stocked(0, 0);
    const base = { sessionRef: newReceivingSession(), locationId: DEFAULT_LOCATION_ID, variantId: product.variantId, counted: 2 };
    expect(await code(() => receiveLine(t.db, clerk.actor, { ...base, idempotencyKey: key() }, NOW))).toBe("cost_unknown");
    expect((await level(product.variantId)).onHand).toBe(0);
    await receiveLine(t.db, manager.actor, { ...base, unitCostIqd: 55_000, idempotencyKey: key() }, NOW);
    expect((await level(product.variantId)).onHand).toBe(2);

    const tracked = await make.product({ trackSerials: true });
    await t.db.insert(variantCosts).values({ variantId: tracked.variantId, unitCostMinor: 1, landedCostIqd: 400_000, updatedAt: NOW });
    const trackedBase = { sessionRef: newReceivingSession(), locationId: DEFAULT_LOCATION_ID, variantId: tracked.variantId, counted: 3, rejected: 1, rejectReason: "شاشة مكسورة" };
    expect(await code(() => receiveLine(t.db, clerk.actor, { ...trackedBase, serials: ["ONE"], idempotencyKey: key() }, NOW))).toBe("invalid");
    expect(await code(() => receiveLine(t.db, clerk.actor, { ...trackedBase, rejected: 4, idempotencyKey: key() }, NOW))).toBe("invalid");
    const numbers = [make.next("SN"), make.next("SN")];
    await receiveLine(t.db, clerk.actor, { ...trackedBase, serials: numbers, idempotencyKey: key() }, NOW);
    expect((await t.db.select().from(serials).where(eq(serials.variantId, tracked.variantId))).map((row) => row.status)).toEqual(["in_stock", "in_stock"]);
    // a serial cannot be registered twice — the second receipt is refused as a whole
    expect(await code(() => receiveLine(t.db, clerk.actor, { ...trackedBase, rejected: 0, counted: 2, serials: [numbers[0], make.next("SN")], idempotencyKey: key() }, NOW))).toBe("serial_duplicate");
    expect((await level(tracked.variantId)).onHand).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────── counts (04.05)

describe("counts", () => {
  test("blind counting, two people, posting through the core with the count's reference, idempotent approval", async () => {
    const location = await addLocation();
    const a = await stocked(10, 30_000, { locationId: location });
    const b = await stocked(4, 20_000, { locationId: location });
    const clerk = await staff("inventory");
    const supervisor = await staff("manager");
    const other = await staff("manager");
    const started = await createCount(t.db, clerk.actor, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    expect(started.lines).toBe(2);
    expect(await code(() => createCount(t.db, clerk.actor, { locationId: location, mode: "all", idempotencyKey: key() }, NOW))).toBe("count_location_busy");

    // blind: the counter does not see what is expected
    const blind = await getCount(t.db, clerk.actor, started.countId, "ar");
    expect(blind.showExpected).toBe(false);
    expect(blind.lines.every((line) => line.expected === null && line.difference === null)).toBe(true);
    expect((await getCount(t.db, supervisor.actor, started.countId, "ar")).showExpected).toBe(true);

    // a sale lands while counting: the expected quantity is taken when the line is counted
    await t.db.update(stockLevels).set({ onHand: 9 }).where(and(eq(stockLevels.variantId, a.variantId), eq(stockLevels.locationId, location)));
    await t.db.insert(stockMovements).values({ id: newId("mov"), variantId: a.variantId, locationId: location, kind: "sale", qtyDelta: -1, actorKind: "system", actorId: "test", at: NOW, refType: "order", reason: "fixture sale" });
    await recordCounts(t.db, clerk.actor, { countId: started.countId, lines: [{ variantId: a.variantId, countedQty: 7 }, { variantId: b.variantId, countedQty: 4 }] }, NOW);
    await submitCount(t.db, clerk.actor, { countId: started.countId }, NOW);
    expect(await code(() => recordCounts(t.db, clerk.actor, { countId: started.countId, lines: [{ variantId: a.variantId, countedQty: 1 }] }, NOW))).toBe("count_not_open");

    // the counter cannot approve (no permission), nor can a supervisor who counted
    expect(await code(() => approveCount(t.db, clerk.actor, { countId: started.countId, reason: "ok" }, NOW))).toBe("forbidden");
    const review = await getCount(t.db, supervisor.actor, started.countId, "ar");
    expect(review.summary).toMatchObject({ differences: 1, unitsMissing: 2, unitsFound: 0 });
    expect(review.canApprove).toBe(true);
    const result = await approveCount(t.db, supervisor.actor, { countId: started.countId, reason: "عُدّ مرتين" }, NOW);
    expect(result).toMatchObject({ posted: 1, replayed: false });
    expect(await approveCount(t.db, other.actor, { countId: started.countId, reason: "again" }, NOW)).toMatchObject({ posted: 0, replayed: true });
    expect((await level(a.variantId, location)).onHand).toBe(7);
    expect((await level(b.variantId, location)).onHand).toBe(4);
    const adjustment = await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, a.variantId), eq(stockMovements.kind, "adjust"))).get();
    expect(adjustment?.reason).toContain(started.ref);
    expect(adjustment?.qtyDelta).toBe(-2);
    expect(adjustment?.actorId).toBe(supervisor.id);
    const approved = await getCount(t.db, other.actor, started.countId, "ar");
    expect(approved.status).toBe("approved");
    expect(approved.lines.find((line) => line.variant.id === a.variantId)?.posted).toBe(true);

    // a supervisor who counted a line cannot approve it
    const second = await createCount(t.db, supervisor.actor, { locationId: location, mode: "skus", skus: [b.sku], idempotencyKey: key() }, NOW);
    await recordCounts(t.db, other.actor, { countId: second.countId, lines: [{ variantId: b.variantId, countedQty: 5 }] }, NOW);
    await submitCount(t.db, other.actor, { countId: second.countId }, NOW);
    expect(await code(() => approveCount(t.db, other.actor, { countId: second.countId, reason: "mine" }, NOW))).toBe("count_self_approval");
    expect(await code(() => approveCount(t.db, supervisor.actor, { countId: second.countId, reason: "mine" }, NOW))).toBe("count_self_approval");
    await sendBackCount(t.db, (await staff("manager")).actor, { countId: second.countId, reason: "count again" }, NOW);
    await cancelCount(t.db, other.actor, { countId: second.countId, reason: "not needed" }, NOW);
    expect((await listCounts(t.db, clerk.actor, { status: "cancelled", location, page: 1 })).rows.map((row) => row.id)).toContain(second.countId);
  });

  test("a difference that removes units promised to orders needs the oversell exception, refused before anything is posted", async () => {
    const location = await addLocation();
    const product = await stocked(3, 10_000, { locationId: location });
    const plain = await stocked(5, 10_000, { locationId: location });
    const order = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 2 }]);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: product.variantId, qty: 2 }], expiresAt: null, actor: SYSTEM, now: NOW }));
    const clerk = await staff("inventory");
    const started = await createCount(t.db, clerk.actor, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, clerk.actor, { countId: started.countId, lines: [{ variantId: product.variantId, countedQty: 0 }, { variantId: plain.variantId, countedQty: 6 }] }, NOW);
    await submitCount(t.db, clerk.actor, { countId: started.countId }, NOW);
    const finance = await staff("finance", {});
    const supervisorNoOversell: EmployeeActor = { ...(await staff("manager")).actor, permissions: [...defaultRolePermissions("manager")].filter((permission) => permission !== "inventory.oversell.authorize") };
    expect(await code(() => approveCount(t.db, supervisorNoOversell, { countId: started.countId, reason: "lost" }, NOW))).toBe("count_oversell_needs_authorization");
    expect(await code(() => approveCount(t.db, supervisorNoOversell, { countId: started.countId, reason: "lost", allowOversell: true }, NOW))).toBe("forbidden");
    // nothing was posted, not even the harmless line
    expect((await level(plain.variantId, location)).onHand).toBe(5);
    expect(finance.id).toBeTruthy();
    const manager = await staff("manager");
    await approveCount(t.db, manager.actor, { countId: started.countId, reason: "box stolen, police report 12", allowOversell: true }, NOW);
    const after = await level(product.variantId, location);
    expect([after.onHand, after.reserved, after.allowOversell]).toEqual([0, 2, true]);
    expect((await level(plain.variantId, location)).onHand).toBe(6);
    const oversell = await listOversell(t.db, manager.actor, "ar");
    expect(oversell.levels.some((row) => row.variant.id === product.variantId && row.free === -2)).toBe(true);
    expect(oversell.authorizations.find((row) => row.variantId === product.variantId)?.reason).toContain("police report 12");
  });

  test("serial-tracked lines show missing and unexpected serials and are not posted", async () => {
    const location = await addLocation();
    const numbers = [make.next("SN"), make.next("SN")];
    const tracked = await stocked(2, 300_000, { locationId: location, serials: numbers });
    const clerk = await staff("inventory");
    const started = await createCount(t.db, clerk.actor, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, clerk.actor, { countId: started.countId, lines: [{ variantId: tracked.variantId, serials: [numbers[0].toLowerCase(), "UNKNOWN-1"] }] }, NOW);
    await submitCount(t.db, clerk.actor, { countId: started.countId }, NOW);
    const manager = await staff("manager");
    const view = await getCount(t.db, manager.actor, started.countId, "ar");
    const line = view.lines[0];
    expect(line.serials?.missing).toEqual([numbers[1].toUpperCase()]);
    expect(line.serials?.unexpected.map((entry) => entry.serial)).toEqual(["UNKNOWN-1"]);
    expect(await approveCount(t.db, manager.actor, { countId: started.countId, reason: "serials checked" }, NOW)).toMatchObject({ posted: 0, serialLines: 1 });
    expect((await level(tracked.variantId, location)).onHand).toBe(2);
    expect(await t.db.select().from(cycleCountLines).where(eq(cycleCountLines.countId, started.countId))).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────── reservations (04.08), adjustments (04.09)

describe("reservations and the oversell exception", () => {
  test("the release returns an order's units to available; refused for orders being packed; needs the permission", async () => {
    const product = await stocked(5, 10_000);
    const order = await reserve(product.variantId, 2, { status: "awaiting_payment" });
    const clerk = await staff("inventory");
    const page = await listReservations(t.db, clerk.actor, { status: "active", q: order.ref, page: 1 }, "ar", NOW);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ orderRef: order.ref, qty: 2, releasable: true, expiresAt: NOW + 3_600_000 });
    expect(await code(async () => releaseReservationsOfOrder(t.db, (await staff("cashier")).actor, { orderId: order.orderId, reason: "stuck" }, NOW))).toBe("forbidden");
    expect(await releaseReservationsOfOrder(t.db, clerk.actor, { orderId: order.orderId, reason: "customer asked" }, NOW)).toEqual({ released: 1 });
    expect((await level(product.variantId)).reserved).toBe(0);
    expect(await releaseReservationsOfOrder(t.db, clerk.actor, { orderId: order.orderId, reason: "again" }, NOW)).toEqual({ released: 0 });
    const packing = await reserve(product.variantId, 1, { status: "preparing" });
    expect(await code(() => releaseReservationsOfOrder(t.db, clerk.actor, { orderId: packing.orderId, reason: "x x x" }, NOW))).toBe("release_not_allowed");
  });

  test("adjustments: oversell only with the permission and an explicit request; double submits post once; costs only from cost.read", async () => {
    const product = await stocked(3, 10_000);
    await reserve(product.variantId, 2);
    const clerk = await staff("inventory");
    const manager = await staff("manager");
    const base = { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, kind: "adjust" as const, direction: "remove" as const, qty: 2, reason: "two units broken in the box" };
    expect(await code(() => adjustFromAdmin(t.db, clerk.actor, { ...base, idempotencyKey: key() }, NOW))).toBe("insufficient_stock");
    expect(await code(() => adjustFromAdmin(t.db, clerk.actor, { ...base, allowOversell: true, idempotencyKey: key() }, NOW))).toBe("forbidden");
    const idempotencyKey = key();
    expect(await adjustFromAdmin(t.db, manager.actor, { ...base, allowOversell: true, idempotencyKey }, NOW)).toEqual({ replayed: false });
    expect(await adjustFromAdmin(t.db, manager.actor, { ...base, allowOversell: true, idempotencyKey }, NOW)).toEqual({ replayed: true });
    expect(await level(product.variantId)).toMatchObject({ onHand: 1, reserved: 2, allowOversell: true });
    // units found again close the exception
    await adjustFromAdmin(t.db, clerk.actor, { ...base, direction: "add", qty: 1, unitCostIqd: 99, idempotencyKey: key() }, NOW);
    expect(await level(product.variantId)).toMatchObject({ onHand: 2, reserved: 2, allowOversell: false });
    const added = await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, product.variantId), eq(stockMovements.qtyDelta, 1), eq(stockMovements.kind, "adjust"))).get();
    expect(added?.unitCostIqd).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── reorder, forecast, reports (04.06, 04.12)

describe("reorder, forecast and reports", () => {
  test("reorder points touch only planning columns; the forecast uses real sales and says when there is no history", async () => {
    const clerk = await staff("inventory");
    const product = await stocked(20, 5_000, { at: NOW - 60 * DAY });
    await setReorderPoint(t.db, clerk.actor, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, reorderPoint: 8, reorderQty: 30 }, NOW);
    expect(await level(product.variantId)).toMatchObject({ onHand: 20, reserved: 0, reorderPoint: 8, reorderQty: 30 });
    expect(await code(async () => setReorderPoint(t.db, (await staff("cashier")).actor, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, reorderPoint: 1, reorderQty: null }, NOW))).toBe("forbidden");
    // 15 units shipped 10 days ago
    const order = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 15 }]);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: product.variantId, qty: 15 }], expiresAt: null, actor: SYSTEM, now: NOW - 10 * DAY }));
    await commitOrderReservations(t.db, SYSTEM, order.orderId, NOW - 10 * DAY);
    const item = await getVariantStock(t.db, clerk.actor, product.variantId, "ar", NOW);
    expect(item.forecast.sold30).toBe(15);
    expect(item.forecast.rate30).toMatchObject({ basis: "sales", perDay: 0.5 });
    expect(item.forecast.plan).toMatchObject({ daysOfCover: 10, belowReorder: true, status: "below_reorder", suggestedQty: 30 });
    const fresh = await stocked(5, 5_000, { at: NOW - DAY });
    const freshItem = await getVariantStock(t.db, clerk.actor, fresh.variantId, "ar", NOW);
    expect(freshItem.forecast.plan).toMatchObject({ daysOfCover: null, stockOutAt: null });
    expect(freshItem.forecast.rate30.basis).toBe("too_little_history");
    const page = await listReorder(t.db, clerk.actor, { show: "all", q: product.sku, page: 1 }, "ar", NOW);
    expect(page.rows[0]?.plan.status).toBe("below_reorder");

    // reports: the shipped units count as sales and the old receipt as inbound
    const flow = await inventoryReport(t.db, clerk.actor, { report: "flow", days: 90, page: 1 }, "ar", NOW);
    expect(flow.report === "flow" && flow.rows.find((row) => row.variant.id === product.variantId)).toMatchObject({ sold: 15, received: 20 });
    const turnover = await inventoryReport(t.db, clerk.actor, { report: "turnover", days: 30, page: 1 }, "ar", NOW);
    const turnoverRow = turnover.report === "turnover" ? turnover.rows.find((row) => row.variant.id === product.variantId) : undefined;
    expect(turnoverRow).toMatchObject({ sold: 15, onHandStart: 20, onHandEnd: 5, averageOnHand: 12.5 });
    expect(turnoverRow && "cogsIqd" in turnoverRow).toBe(false);
    const dead = await inventoryReport(t.db, clerk.actor, { report: "dead", days: 90, page: 1 }, "ar", NOW);
    expect(dead.report === "dead" && dead.total).toBeGreaterThan(0);
    expect(dead.report === "dead" && dead.rows.some((row) => row.variant.id === product.variantId)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── serials (acceptance #1)

describe("serials", () => {
  test("a unit's history shows one open sale at most; a second sale of the same serial is refused", async () => {
    const serial = make.next("SOLD-SN");
    const product = await stocked(1, 500_000, { serials: [serial] });
    const [row] = await t.db.select().from(serials).where(eq(serials.serial, serial));
    const first = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 1 }]);
    const second = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 1 }]);
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: first.itemIds[0], serialIds: [row.id], actor: SYSTEM, now: NOW }));
    expect(mapDbError(await thrown(() => runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: second.itemIds[0], serialIds: [row.id], actor: SYSTEM, now: NOW }))))?.code).toBe("SERIAL_NOT_AVAILABLE");
    const clerk = await staff("inventory");
    const history = await getSerialHistory(t.db, clerk.actor, row.id, "ar");
    expect(history.serial.status).toBe("sold");
    expect(history.attachments.filter((entry) => entry.releasedAt === null).map((entry) => entry.orderRef)).toEqual([first.ref]);
    expect(history.costIqd).toBeUndefined();
    expect((await getSerialHistory(t.db, (await staff("manager")).actor, row.id, "ar")).costIqd).toBe(500_000);
    const found = await findSerials(t.db, clerk.actor, { q: serial, status: null, location: null, page: 1 }, "ar");
    expect(found.rows.map((entry) => [entry.serial, entry.orderRef])).toEqual([[serial, first.ref]]);
  });
});

// ───────────────────────────────────────────────────────────────── route loaders

describe("route loaders", () => {
  function request(path: string, cookies: Record<string, string> = {}) {
    return new Request(`http://localhost:5173${path}`, { headers: Object.keys(cookies).length ? { Cookie: Object.entries(cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ") } : {} });
  }
  async function signedIn(person: Staff): Promise<Record<string, string>> {
    const jar: Record<string, string> = {};
    const ctx = {
      requestId: "inv-test",
      nonce: "n",
      origin: "http://localhost:5173",
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
      setCookie: (serialized: string) => {
        const [pair] = serialized.split("; ");
        const at = pair.indexOf("=");
        jar[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
      },
    } as unknown as RequestCtx;
    const result = await signInEmployee(ctx, t.db, { email: person.email, password: person.password });
    if (result.status !== "signed_in") throw new Error(`sign-in: ${result.status}`);
    return jar;
  }
  async function run(req: Request, loader: (args: never) => Promise<unknown>, pattern: string, params: Record<string, string> = {}) {
    const context = new RouterContextProvider();
    const url = new URL(req.url);
    try {
      return await requestContextMiddleware({ request: req, context, url, pattern, params }, async () => {
        const result = await loader({ request: req, context, url, pattern, params } as never);
        return result instanceof Response ? result : Response.json(result);
      });
    } catch (error) {
      return error;
    }
  }
  const statusOf = (value: unknown) => (value instanceof Response ? value.status : ((value as { init?: { status?: number } })?.init?.status ?? 0));

  test("the movement export carries the unit cost only for cost.read, and refuses roles without the log", async () => {
    const clerk = await staff("inventory");
    const manager = await staff("manager");
    const content = await staff("content");
    const clerkCsv = (await run(request("/admin/inventory/movements/export", await signedIn(clerk)), movementsExportLoader as never, "admin/inventory/movements/export")) as Response;
    expect(clerkCsv.status).toBe(200);
    expect(clerkCsv.headers.get("Content-Type")).toContain("text/csv");
    expect(clerkCsv.headers.get("Cache-Control")).toContain("no-store");
    const clerkHead = (await clerkCsv.text()).split("\r\n")[0];
    const managerHead = (await ((await run(request("/admin/inventory/movements/export", await signedIn(manager)), movementsExportLoader as never, "admin/inventory/movements/export")) as Response).text()).split("\r\n")[0];
    expect(managerHead.split(",").length).toBe(clerkHead.split(",").length + 1);
    expect(managerHead).toContain("تكلفة القطعة");
    expect(clerkHead).not.toContain("تكلفة القطعة");
    expect(statusOf(await run(request("/admin/inventory/movements/export", await signedIn(content)), movementsExportLoader as never, "admin/inventory/movements/export"))).toBe(403);
  });

  test("the stock page and the scan lookup answer per permission; nobody signed in is sent to sign in", async () => {
    const support = await staff("support");
    const content = await staff("content");
    const page = (await run(request("/admin/inventory/stock?state=oversold", await signedIn(support)), stockLoader as never, "admin/inventory/stock")) as Response;
    const body = (await page.json()) as { page: { rows: unknown[] }; filters: { state: string } };
    expect(body.filters.state).toBe("oversold");
    expect(leaksCost(body)).toBe(false);
    expect(statusOf(await run(request("/admin/inventory/stock", await signedIn(content)), stockLoader as never, "admin/inventory/stock"))).toBe(403);
    const anonymous = await run(request("/admin/inventory/stock"), stockLoader as never, "admin/inventory/stock");
    expect(anonymous instanceof Response && anonymous.headers.get("Location")).toContain("/admin/login");

    const variant = await t.db.query.variants.findFirst({ where: (v, { isNotNull }) => isNotNull(v.barcode) });
    const hit = (await run(request(`/admin/inventory/scan?code=${variant!.barcode}`, await signedIn(support)), scanLoader as never, "admin/inventory/scan")) as Response;
    expect(await hit.json()).toMatchObject({ kind: "variant", matchedBy: "barcode", variant: { id: variant!.id } });
    expect(demoId).toBeTruthy();
  });
});
