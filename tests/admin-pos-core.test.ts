/**
 * The commerce-core file of admin 06 (point of sale): app/server/services/orders/pos-sale.server.ts — placePosSale on a
 * real local D1 (tests/helpers/db.ts) with the built-in roles:
 *
 *   · a cash sale is one order (channel pos, delivered, paid) whose units leave the REGISTER'S store location only
 *     (reserve → commit: a committed reservation, 'reserve' + FIFO 'sale' movements, layers consumed), with the
 *     drawer's cash movement, the payment, the receipt RC-…, and balanced books (payment, revenue, cost of goods) —
 *     the daily consistency checks find nothing afterwards
 *   · units promised to web orders are never sold at the till; an oversell needs inventory.oversell.authorize
 *   · idempotency: the same key returns the first sale (also two at once); the same key with other content is refused
 *   · serials: required, at this store, sold once; warranties per serial; a used device sells with its own serial
 *   · mixed payments add up exactly; change; the wallet needs an account and never overdraws
 *   · the shift: someone else's drawer is refused; a counted (closed, unreviewed) shift takes a late sale and its
 *     expected cash / variance move; a reviewed shift is final
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import {
  bundleItems,
  cashMovements,
  employeeRoles,
  inventoryLocations,
  invoices,
  journalEntries,
  journalLines,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  posRegisters,
  posShifts,
  products,
  serials,
  stockLevels,
  stockMovements,
  stockReservations,
  usedUnits,
  walletLedger,
  warranties,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import type { AppError } from "~/server/errors";
import { CONSISTENCY_CHECKS } from "~/server/jobs.server";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { getAvailability, receiveStock, reserveStatements } from "~/server/services/inventory/stock.server";
import { placePosSale, posSaleTotals, type PosSaleInput } from "~/server/services/orders/pos-sale.server";
import { creditWallet } from "~/server/services/wallet.server";
import { runBatch } from "~/server/db/tx.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const system = systemActor("test.admin-pos-core");
let t: TestDb;
let make: Fixtures;
let storeId: string;
let shelfId: string;
let otherStoreId: string;
let registerId: string;
const staff: Partial<Record<DefaultRoleKey | "cashier2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "inventory", "cashier", "content"] as const) staff[key] = await employee(key);
  staff.cashier2 = await employee("cashier");
  storeId = newId("loc");
  shelfId = newId("loc");
  otherStoreId = newId("loc");
  await t.db.insert(inventoryLocations).values([
    { id: storeId, code: `SHOP-${randomToken(4)}`, name: "Shop", kind: "store", isSellable: true },
    { id: otherStoreId, code: `SHOP2-${randomToken(4)}`, name: "Other shop", kind: "store", isSellable: true },
  ]);
  await t.db.insert(inventoryLocations).values({ id: shelfId, code: `SHELF-${randomToken(4)}`, name: "Shelf", kind: "bin", parentId: storeId, isSellable: true });
  registerId = newId("reg");
  await t.db.insert(posRegisters).values({ id: registerId, code: `R-${randomToken(3)}`, name: "Till 1", locationId: storeId, isActive: true, createdAt: NOW });
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key };
}
const as = (key: keyof typeof staff): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected a failure");
}

/** A shift of the cashier on the test register (a new register when one is open already). */
async function openShift(owner: EmployeeActor, options: { register?: string } = {}): Promise<string> {
  let register = options.register ?? registerId;
  const open = await t.db.select({ id: posShifts.id }).from(posShifts).where(and(eq(posShifts.registerId, register), eq(posShifts.status, "open"))).get();
  if (open) {
    register = newId("reg");
    await t.db.insert(posRegisters).values({ id: register, code: `R-${randomToken(3)}`, name: "Till", locationId: storeId, isActive: true, createdAt: NOW });
  }
  const id = newId("psh");
  await t.db.insert(posShifts).values({ id, registerId: register, openedBy: owner.id, openedAt: NOW, openingFloatIqd: 50_000, status: "open" });
  return id;
}

/** A product with `qty` units received at the store (cost layer at `cost`). */
async function stocked(options: { qty?: number; cost?: number; price?: number; serials?: number; at?: string; warrantyMonths?: number } = {}) {
  const product = await make.product({ priceIqd: options.price ?? 100_000, trackSerials: Boolean(options.serials) });
  if (options.warrantyMonths) await t.db.update(products).set({ warrantyMonths: options.warrantyMonths }).where(eq(products.id, product.productId));
  const qty = options.serials ?? options.qty ?? 5;
  const numbers = options.serials ? Array.from({ length: options.serials }, () => `SN-${randomToken(6)}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: options.at ?? storeId, qty, unitCostIqd: options.cost ?? 60_000, serials: numbers, ref: "test" }, NOW);
  const serialIds = numbers ? (await t.db.select({ id: serials.id, serial: serials.serial }).from(serials).where(eq(serials.variantId, product.variantId))).map((row) => row.id) : [];
  return { ...product, serialIds };
}

const key = () => randomToken(18);
function sale(shiftId: string, lines: PosSaleInput["lines"], payments: PosSaleInput["payments"], extra: Partial<PosSaleInput> = {}): PosSaleInput {
  return { idempotencyKey: key(), shiftId, lines, payments, ...extra };
}

describe("placePosSale", () => {
  test("a cash sale leaves the store only, commits its reservation, pays the drawer and balances the books", async () => {
    const shiftId = await openShift(as("cashier"));
    const item = await stocked({ qty: 4, cost: 60_000, price: 100_000 });
    await receiveStock(t.db, system, { variantId: item.variantId, locationId: DEFAULT_LOCATION_ID, qty: 9, unitCostIqd: 55_000, ref: "test" }, NOW);
    const before = await getAvailability(t.db, [item.variantId]);

    const result = await placePosSale(t.db, as("cashier"), sale(shiftId, [{ variantId: item.variantId, qty: 2, unitPriceIqd: 100_000 }], [{ method: "pos_cash", amountIqd: 200_000, tenderedIqd: 250_000 }]), NOW);
    expect(result).toMatchObject({ totalIqd: 200_000, changeIqd: 50_000, replayed: false, lateForClosedShift: false });
    expect(result.receiptNumber).toMatch(/^RC-\d{6}$/);

    const order = await t.db.select().from(orders).where(eq(orders.id, result.orderId)).get();
    expect(order).toMatchObject({ channel: "pos", status: "delivered", paymentStatus: "paid", paidIqd: 200_000, posShiftId: shiftId, registerId, cashierId: as("cashier").id, shippingIqd: 0 });
    const levels = await t.db.select().from(stockLevels).where(eq(stockLevels.variantId, item.variantId));
    expect(levels.find((row) => row.locationId === storeId)?.onHand).toBe(2);
    expect(levels.find((row) => row.locationId === DEFAULT_LOCATION_ID)?.onHand).toBe(9);
    expect((await getAvailability(t.db, [item.variantId])).get(item.variantId)?.available).toBe((before.get(item.variantId)?.available ?? 0) - 2);

    const reservations = await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, result.orderId));
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ status: "committed", qty: 2, locationId: storeId });
    const movements = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refType, "order"), eq(stockMovements.refId, result.orderId)));
    expect(movements.map((row) => row.kind).sort()).toEqual(["reserve", "sale"]);
    expect(movements.find((row) => row.kind === "sale")).toMatchObject({ qtyDelta: -2, reservedDelta: -2, unitCostIqd: 60_000, locationId: storeId });

    const cash = await t.db.select().from(cashMovements).where(eq(cashMovements.orderId, result.orderId));
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ kind: "sale", amountIqd: 200_000, shiftId });
    const pay = await t.db.select().from(payments).where(eq(payments.orderId, result.orderId));
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ method: "pos_cash", status: "paid", amountIqd: 200_000, verifiedBy: as("cashier").id, posShiftId: shiftId });

    const entries = await t.db.select().from(journalEntries).where(eq(journalEntries.refId, result.orderId));
    expect(entries.map((entry) => entry.idempotencyKey).sort()).toEqual([`order:${result.orderId}:cogs`, `order:${result.orderId}:sale`]);
    const paymentEntry = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `payment:${pay[0]?.id}:received`)).get();
    expect(paymentEntry).toBeTruthy();
    const cogsLines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entries.find((entry) => entry.idempotencyKey?.endsWith(":cogs"))?.id ?? ""));
    expect(cogsLines.reduce((sum, line) => sum + line.debitIqd, 0)).toBe(120_000);

    const receipt = await t.db.select().from(invoices).where(and(eq(invoices.orderId, result.orderId), eq(invoices.kind, "receipt"))).get();
    expect(receipt?.number).toBe(result.receiptNumber);
    expect(JSON.stringify(receipt?.data)).not.toMatch(/cost/i);

    const findings = [];
    for (const check of CONSISTENCY_CHECKS) findings.push(...(await check.run(t.db)));
    expect(findings).toEqual([]);
  });

  test("units promised to a web order are never sold at the till; an oversell needs the authorisation", async () => {
    const shiftId = await openShift(as("cashier"));
    const item = await stocked({ qty: 1 });
    const web = await make.order([{ ...item, qty: 1 }]);
    await runBatch(t.db, reserveStatements(t.db, { orderId: web.orderId, lines: [{ variantId: item.variantId, qty: 1 }], expiresAt: null, actor: system, now: NOW }));

    const refused = await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000 }], [{ method: "pos_cash", amountIqd: 100_000 }]), NOW));
    expect(refused.code).toBe("insufficient_stock");
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000 }], [{ method: "pos_cash", amountIqd: 100_000 }], { allowOversell: true }), NOW))).status).toBe(403);

    const managerShift = await openShift(as("manager"));
    const result = await placePosSale(t.db, as("manager"), sale(managerShift, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000 }], [{ method: "pos_cash", amountIqd: 100_000 }], { allowOversell: true, reason: "sold before the web order arrived" }), NOW);
    expect(result.replayed).toBe(false);
    const level = await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, item.variantId), eq(stockLevels.locationId, storeId))).get();
    expect(level).toMatchObject({ onHand: 0, reserved: 1, allowOversell: true });
  });

  test("the same key returns the first sale, also for two at once; other content with the key is refused", async () => {
    const shiftId = await openShift(as("cashier"));
    const item = await stocked({ qty: 3 });
    const input = sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000 }], [{ method: "pos_cash", amountIqd: 100_000 }]);
    const [a, b] = await Promise.all([placePosSale(t.db, as("cashier"), input, NOW), placePosSale(t.db, as("cashier"), input, NOW)]);
    expect(a.orderId).toBe(b.orderId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const again = await placePosSale(t.db, as("cashier"), input, NOW + 60_000);
    expect(again).toMatchObject({ orderId: a.orderId, replayed: true, receiptNumber: a.receiptNumber });
    expect((await t.db.select().from(orders).where(eq(orders.posShiftId, shiftId))).length).toBe(1);
    const level = await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, item.variantId), eq(stockLevels.locationId, storeId))).get();
    expect(level?.onHand).toBe(2);
    const other = await failureOf(placePosSale(t.db, as("cashier"), { ...input, lines: [{ variantId: item.variantId, qty: 2, unitPriceIqd: 100_000 }], payments: [{ method: "pos_cash", amountIqd: 200_000 }] }, NOW));
    expect(other.code).toBe("idempotency_conflict");
  });

  test("serials: required, at this store, sold once; a warranty per serial", async () => {
    const shiftId = await openShift(as("cashier"));
    const tracked = await stocked({ serials: 2, warrantyMonths: 12, price: 700_000, cost: 500_000 });
    const elsewhere = await stocked({ serials: 1, at: otherStoreId });
    const line = (serialIds: string[]) => [{ variantId: tracked.variantId, qty: 1, unitPriceIqd: 700_000, serialIds }];
    const pay = [{ method: "pos_cash" as const, amountIqd: 700_000 }];
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, line([]), pay), NOW))).code).toBe("serials_required");
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, [{ variantId: elsewhere.variantId, qty: 1, unitPriceIqd: 100_000, serialIds: elsewhere.serialIds }], [{ method: "pos_cash", amountIqd: 100_000 }]), NOW))).code).toMatch(/insufficient_stock|serial_not_available/);

    const first = await placePosSale(t.db, as("cashier"), sale(shiftId, line([tracked.serialIds[0] as string]), pay), NOW);
    const serial = await t.db.select().from(serials).where(eq(serials.id, tracked.serialIds[0] as string)).get();
    expect(serial?.status).toBe("sold");
    const item = await t.db.select().from(orderItems).where(eq(orderItems.orderId, first.orderId)).get();
    expect((await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, item?.id ?? ""))).map((row) => row.serialId)).toEqual([tracked.serialIds[0]]);
    const warranty = await t.db.select().from(warranties).where(eq(warranties.orderItemId, item?.id ?? ""));
    expect(warranty).toHaveLength(1);
    expect(warranty[0]?.serialId).toBe(tracked.serialIds[0]);

    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, line([tracked.serialIds[0] as string]), pay), NOW))).code).toBe("serial_not_available");
  });

  test("a used device sells with its own serial and its warranty days", async () => {
    const shiftId = await openShift(as("cashier"));
    const model = await make.product({ priceIqd: 400_000, trackSerials: true });
    const serialId = newId("ser");
    await t.db.insert(serials).values({ id: serialId, serial: `USED-${randomToken(6)}`, variantId: model.variantId, status: "in_stock", locationId: storeId, source: "trade_in", createdAt: NOW, updatedAt: NOW });
    const unitId = newId("usd");
    await t.db.insert(usedUnits).values({ id: unitId, slug: make.next("used"), variantId: model.variantId, serialId, grade: "A", priceIqd: 420_000, acquisitionCostIqd: 300_000, warrantyDays: 30, locationId: storeId, status: "listed", isDemo: true, createdAt: NOW, updatedAt: NOW });
    const result = await placePosSale(t.db, as("cashier"), sale(shiftId, [{ usedUnitId: unitId, qty: 1, unitPriceIqd: 420_000 }], [{ method: "pos_cash", amountIqd: 420_000 }]), NOW);
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("sold");
    expect((await t.db.select().from(serials).where(eq(serials.id, serialId)).get())?.status).toBe("sold");
    const item = await t.db.select().from(orderItems).where(eq(orderItems.orderId, result.orderId)).get();
    expect(item).toMatchObject({ usedUnitId: unitId, warrantyDays: 30 });
    expect((await t.db.select().from(warranties).where(eq(warranties.orderItemId, item?.id ?? ""))).map((row) => row.serialId)).toEqual([serialId]);
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, [{ usedUnitId: unitId, qty: 1, unitPriceIqd: 420_000 }], [{ method: "pos_cash", amountIqd: 420_000 }]), NOW))).code).toBe("used_unit_not_available");
  });

  test("a bundle takes its components from the store", async () => {
    const shiftId = await openShift(as("cashier"));
    const a = await stocked({ qty: 2, cost: 10_000 });
    const b = await stocked({ qty: 2, cost: 20_000 });
    const bundle = await make.product({ kind: "bundle", priceIqd: 50_000 });
    await t.db.insert(bundleItems).values([
      { bundleVariantId: bundle.variantId, componentVariantId: a.variantId, qty: 1 },
      { bundleVariantId: bundle.variantId, componentVariantId: b.variantId, qty: 1 },
    ]);
    const result = await placePosSale(t.db, as("cashier"), sale(shiftId, [{ variantId: bundle.variantId, qty: 2, unitPriceIqd: 50_000 }], [{ method: "pos_cash", amountIqd: 100_000 }]), NOW);
    for (const part of [a, b]) {
      const level = await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, part.variantId), eq(stockLevels.locationId, storeId))).get();
      expect(level?.onHand).toBe(0);
    }
    const cogs = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `order:${result.orderId}:cogs`)).get();
    const cogsLines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, cogs?.id ?? ""));
    expect(cogsLines.reduce((sum, line) => sum + line.debitIqd, 0)).toBe(60_000);
  });

  test("mixed payments add up exactly; the wallet needs an account and never overdraws", async () => {
    const shiftId = await openShift(as("cashier"));
    const item = await stocked({ qty: 5, price: 300_000 });
    const customerId = await make.customer();
    await creditWallet(t.db, system, { customerId, amountIqd: 50_000, kind: "adjustment", reason: "test credit", idempotencyKey: `test:${randomToken(8)}` }, NOW);
    const line = [{ variantId: item.variantId, qty: 1, unitPriceIqd: 300_000 }];
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, line, [{ method: "pos_cash", amountIqd: 100_000 }]), NOW))).code).toBe("payment_total_mismatch");
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, line, [{ method: "pos_cash", amountIqd: 250_000 }, { method: "wallet", amountIqd: 50_000 }]), NOW))).code).toBe("wallet_requires_account");
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, line, [{ method: "pos_cash", amountIqd: 200_000 }, { method: "wallet", amountIqd: 100_000 }], { customerId }), NOW))).code).toBe("wallet_insufficient");
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(shiftId, line, [{ method: "pos_cash", amountIqd: 300_000, tenderedIqd: 200_000 }]), NOW))).code).toBe("cash_tendered_short");

    const result = await placePosSale(
      t.db,
      as("cashier"),
      sale(shiftId, line, [{ method: "pos_cash", amountIqd: 150_000, tenderedIqd: 160_000 }, { method: "pos_card", amountIqd: 100_000, reference: "SLIP-2231" }, { method: "wallet", amountIqd: 50_000 }], { customerId }),
      NOW,
    );
    expect(result.changeIqd).toBe(10_000);
    const rows = await t.db.select().from(payments).where(eq(payments.orderId, result.orderId));
    expect(rows.map((row) => `${row.method}:${row.amountIqd}`).sort()).toEqual(["pos_card:100000", "pos_cash:150000", "wallet:50000"]);
    expect(rows.find((row) => row.method === "pos_card")?.reference).toBe("SLIP-2231");
    const ledger = await t.db.select().from(walletLedger).where(eq(walletLedger.customerId, customerId));
    expect(ledger.reduce((sum, row) => sum + row.amountIqd, 0)).toBe(0);
    const cash = await t.db.select().from(cashMovements).where(eq(cashMovements.orderId, result.orderId));
    expect(cash.map((row) => row.amountIqd)).toEqual([150_000]);
    const findings = [];
    for (const check of CONSISTENCY_CHECKS) findings.push(...(await check.run(t.db)));
    expect(findings).toEqual([]);
  });

  test("the shift: never someone else's drawer; a counted shift takes a late sale; a reviewed one is final", async () => {
    const item = await stocked({ qty: 5 });
    const mine = await openShift(as("cashier"));
    const line = [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000 }];
    const pay = [{ method: "pos_cash" as const, amountIqd: 100_000 }];
    expect((await failureOf(placePosSale(t.db, as("cashier2"), sale(mine, line, pay), NOW))).status).toBe(403);
    expect((await failureOf(placePosSale(t.db, as("content"), sale(mine, line, pay), NOW))).status).toBe(403);

    await t.db.update(posShifts).set({ status: "closed", closedBy: as("cashier").id, closedAt: NOW, countedCashIqd: 150_000, expectedCashIqd: 50_000, varianceIqd: 100_000 }).where(eq(posShifts.id, mine));
    const late = await placePosSale(t.db, as("cashier"), sale(mine, line, pay, { offlineCreatedAt: NOW - 3_600_000 }), NOW);
    expect(late.lateForClosedShift).toBe(true);
    const shift = await t.db.select().from(posShifts).where(eq(posShifts.id, mine)).get();
    expect(shift).toMatchObject({ expectedCashIqd: 150_000, varianceIqd: 0 });
    expect((await t.db.select().from(orders).where(eq(orders.id, late.orderId)).get())?.offlineCreatedAt).toBe(NOW - 3_600_000);

    await t.db.update(posShifts).set({ approvedBy: as("manager").id }).where(eq(posShifts.id, mine));
    expect((await failureOf(placePosSale(t.db, as("cashier"), sale(mine, line, pay), NOW))).code).toBe("pos_shift_reviewed");
  });

  test("totals are exact and a discount never exceeds its price", () => {
    expect(posSaleTotals({ lines: [{ unitPriceIqd: 100_000, qty: 2, discountIqd: 5_000 }], orderDiscountIqd: 15_000 })).toMatchObject({ subtotalIqd: 195_000, totalIqd: 180_000, lineDiscountIqd: 5_000 });
    expect(() => posSaleTotals({ lines: [{ unitPriceIqd: 1_000, qty: 1, discountIqd: 2_000 }] })).toThrow();
    expect(() => posSaleTotals({ lines: [{ unitPriceIqd: 1_000, qty: 1 }], orderDiscountIqd: 2_000 })).toThrow();
  });
});
