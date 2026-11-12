/**
 * Admin module 06 "pos" (owner: admin pos) — the services under app/server/services/admin/pos and the route glue of
 * app/routes/admin/pos, on a real local D1 (tests/helpers/db.ts) with the built-in roles. The core's own rules
 * (placePosSale) are in tests/admin-pos-core.test.ts.
 *
 *   · authorization per role (cashier, manager, finance, inventory, content) and the branch limit
 *   · registers: managers only, a store location, never moved or switched off under an open shift, double submits
 *   · shifts: one drawer per employee and per register, replayed keys, pay-outs never below zero, the BLIND count
 *     (the drawer's owner never receives what the system expected — result, report, list), two people approve a
 *     difference which is posted once to cash over/short
 *   · the till: prices checked against the server's (price lists for the point of sale apply), discounts limited by
 *     permission (limit, margin floor, reason), card slips, the wallet only for a looked-up account and never offline,
 *     serial numbers resolved, offline sales synced twice recorded once, a stock conflict resolved by an oversell
 *   · no cost data in any till, receipt or list result; serials on receipts only with inventory.serial.read
 *   · route loaders: 403 for a role without a POS permission; the till API refuses a role that cannot sell
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { loader as homeLoader } from "~/routes/admin/pos/index";
import { failure as posFailure } from "~/routes/admin/pos/pos.server";
import { loader as sellLoader } from "~/routes/admin/pos/sell";
import { loader as apiLoader } from "~/routes/admin/pos/till-api";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { auditEvents, employeeRoles, inventoryLocations, journalEntries, journalLines, orders, posShifts, priceListItems, priceLists, stockLevels, variantCosts } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, accountId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { listRegisters, saveRegister } from "~/server/services/admin/pos/registers.server";
import { catalogSnapshot, createSale, findCustomer, getReceipt, listSales, lookupItem, recordReprint, searchItems, syncSales, type SaleRequestInput } from "~/server/services/admin/pos/sale.server";
import { closeShift, countReviewable, listShifts, moveCash, myShift, openShift, reviewShift, shiftReport } from "~/server/services/admin/pos/shifts.server";
import { CASHIER_DISCOUNT_LIMIT_BPS, parseShiftFilters, parseSaleFilters, parseWhole, parsePercentBps } from "~/server/services/admin/pos/types";
import { setSetting, settingDefault } from "~/server/settings.server";
import { receiveStock, reserveStatements } from "~/server/services/inventory/stock.server";
import { creditWallet } from "~/server/services/wallet.server";
import { runBatch } from "~/server/db/tx.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const system = systemActor("test.admin-pos");
const ctx = { locale: "ar" as const, storeMode: "live" as const };
let t: TestDb;
let make: Fixtures;
let storeId: string;
const staff: Partial<Record<DefaultRoleKey | "cashier2" | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "inventory", "cashier", "content"] as const) staff[key] = await employee(key);
  staff.cashier2 = await employee("cashier");
  staff.manager2 = await employee("manager");
  storeId = newId("loc");
  await t.db.insert(inventoryLocations).values({ id: storeId, code: `SHOP-${randomToken(4)}`, name: "Shop", kind: "store", isSellable: true });
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
const custom = (permissions: Permission[], id = as("cashier").id): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions) });

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return (toAppError(error) ?? error) as AppError;
  }
  throw new Error("expected a failure");
}

/** A register at the test store (a new one per call: one open shift per register). */
async function register(): Promise<string> {
  const result = await saveRegister(t.db, as("manager"), { code: `T-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`, name: "Till", locationId: storeId, isActive: true }, NOW);
  return result.registerId;
}

/** An open shift of `who` on a new register. */
async function shiftOf(who: EmployeeActor, float = 50_000): Promise<string> {
  // one open shift per employee: close an earlier one first
  const open = await t.db.select({ id: posShifts.id }).from(posShifts).where(and(eq(posShifts.openedBy, who.id), eq(posShifts.status, "open"))).get();
  if (open) await closeShift(t.db, who.permissions instanceof Set && who.permissions.has("pos.shift.close") ? who : as("manager"), { shiftId: open.id, countedCashIqd: 0 }, NOW);
  const result = await openShift(t.db, who, { registerId: await register(), openingFloatIqd: float, idempotencyKey: randomToken(16) }, NOW);
  return result.shiftId;
}

async function stocked(options: { qty?: number; price?: number; cost?: number; serials?: number; landed?: number; minMarginBps?: number } = {}) {
  const product = await make.product({ priceIqd: options.price ?? 100_000, trackSerials: Boolean(options.serials) });
  const numbers = options.serials ? Array.from({ length: options.serials }, () => `SN-${randomToken(6).toUpperCase()}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: storeId, qty: options.serials ?? options.qty ?? 5, unitCostIqd: options.cost ?? 60_000, serials: numbers, ref: "test" }, NOW);
  if (options.landed !== undefined) await t.db.insert(variantCosts).values({ variantId: product.variantId, currency: "IQD", unitCostMinor: options.landed, landedCostIqd: options.landed, minMarginBps: options.minMarginBps ?? null, updatedAt: NOW });
  return { ...product, numbers: numbers ?? [] };
}

const sale = (shiftId: string, lines: SaleRequestInput["lines"], payments: SaleRequestInput["payments"], extra: Partial<SaleRequestInput> = {}): SaleRequestInput => ({ idempotencyKey: randomToken(18), shiftId, customer: null, lines, payments, ...extra });

describe("registers", () => {
  test("only pos.register.manage writes; a store location is required; never moved or switched off under an open shift", async () => {
    expect((await failureOf(saveRegister(t.db, as("cashier"), { code: "X-1", name: "x", locationId: storeId, isActive: true }, NOW))).status).toBe(403);
    expect((await failureOf(saveRegister(t.db, as("manager"), { code: "X-2", name: "Till", locationId: DEFAULT_LOCATION_ID, isActive: true }, NOW))).fields).toMatchObject({ locationId: "location_not_store" });
    expect((await failureOf(saveRegister(t.db, as("manager"), { code: "bad code!", name: "Till", locationId: storeId, isActive: true }, NOW))).fields).toMatchObject({ code: expect.any(String) });
    const code = `R-${randomToken(3).toUpperCase().replace(/[^A-Z0-9]/g, "Y")}`;
    const first = await saveRegister(t.db, as("manager"), { code, name: "Till A", locationId: storeId, isActive: true }, NOW);
    // a double submit of the same form is not a second register
    expect(await saveRegister(t.db, as("manager"), { code, name: "Till A", locationId: storeId, isActive: true }, NOW)).toEqual({ registerId: first.registerId, changed: false });
    expect((await failureOf(saveRegister(t.db, as("manager"), { code, name: "Other", locationId: storeId, isActive: true }, NOW))).code).toBe("code_taken");
    await openShift(t.db, as("cashier2"), { registerId: first.registerId, openingFloatIqd: 0, idempotencyKey: randomToken(16) }, NOW);
    expect((await failureOf(saveRegister(t.db, as("manager"), { registerId: first.registerId, code, name: "Till A", locationId: storeId, isActive: false, reason: "مغلق للصيانة" }, NOW))).code).toBe("register_has_open_shift");
    expect((await failureOf(saveRegister(t.db, as("manager"), { registerId: first.registerId, code, name: "Till B", locationId: storeId, isActive: true }, NOW))).fields).toMatchObject({ reason: "reason_required" });
    expect(await saveRegister(t.db, as("manager"), { registerId: first.registerId, code, name: "Till B", locationId: storeId, isActive: true, reason: "اسم أوضح" }, NOW)).toEqual({ registerId: first.registerId, changed: true });
    const rows = await listRegisters(t.db, as("cashier"), "ar");
    expect(rows.find((row) => row.id === first.registerId)).toMatchObject({ name: "Till B", openShift: expect.any(Object) });
    expect((await failureOf(listRegisters(t.db, as("content"), "ar"))).status).toBe(403);
  });
});

describe("shifts and the drawer", () => {
  test("one drawer per employee and per register; replayed keys; pay-outs never take the drawer below zero", async () => {
    const reg = await register();
    const key = randomToken(16);
    const opened = await openShift(t.db, as("cashier"), { registerId: reg, openingFloatIqd: 40_000, denominations: { "25000": 1, "10000": 1, "5000": 1 }, idempotencyKey: key }, NOW);
    expect(await openShift(t.db, as("cashier"), { registerId: reg, openingFloatIqd: 40_000, idempotencyKey: key }, NOW)).toEqual({ shiftId: opened.shiftId, replayed: true });
    expect((await failureOf(openShift(t.db, as("cashier"), { registerId: await register(), openingFloatIqd: 0, idempotencyKey: randomToken(16) }, NOW))).code).toBe("shift_already_open");
    expect((await failureOf(openShift(t.db, as("manager2"), { registerId: reg, openingFloatIqd: 0, idempotencyKey: randomToken(16) }, NOW))).code).toBe("register_busy");
    expect((await failureOf(openShift(t.db, as("cashier2"), { registerId: await register(), openingFloatIqd: 10_000, denominations: { "5000": 1 }, idempotencyKey: randomToken(16) }, NOW))).fields).toMatchObject({ openingFloatIqd: "count_mismatch" });
    expect((await failureOf(openShift(t.db, as("finance"), { registerId: await register(), openingFloatIqd: 0, idempotencyKey: randomToken(16) }, NOW))).status).toBe(403);

    const moveKey = randomToken(16);
    expect(await moveCash(t.db, as("cashier"), { shiftId: opened.shiftId, kind: "pay_in", amountIqd: 10_000, reason: "فكّة", idempotencyKey: moveKey }, NOW)).toEqual({ replayed: false });
    expect(await moveCash(t.db, as("cashier"), { shiftId: opened.shiftId, kind: "pay_in", amountIqd: 10_000, reason: "فكّة", idempotencyKey: moveKey }, NOW)).toEqual({ replayed: true });
    expect((await failureOf(moveCash(t.db, as("cashier"), { shiftId: opened.shiftId, kind: "drop", amountIqd: 60_000, reason: "إلى الخزنة", idempotencyKey: randomToken(16) }, NOW))).code).toBe("drawer_short");
    await moveCash(t.db, as("cashier"), { shiftId: opened.shiftId, kind: "drop", amountIqd: 50_000, reason: "إلى الخزنة", idempotencyKey: randomToken(16) }, NOW);
    // someone else's drawer: refused; a supervisor may take it over
    expect((await failureOf(moveCash(t.db, as("cashier2"), { shiftId: opened.shiftId, kind: "pay_in", amountIqd: 1_000, reason: "test", idempotencyKey: randomToken(16) }, NOW))).status).toBe(403);
    expect((await failureOf(moveCash(t.db, as("cashier"), { shiftId: opened.shiftId, kind: "drop", amountIqd: 1, reason: "x", idempotencyKey: randomToken(16) }, NOW))).fields).toMatchObject({ reason: "reason_required" });
    const mine = await myShift(t.db, as("cashier"), "ar");
    expect(mine?.id).toBe(opened.shiftId);
    expect(mine?.expectedCashIqd).toBeNull();
    await closeShift(t.db, as("cashier"), { shiftId: opened.shiftId, countedCashIqd: 0 }, NOW);
  });

  test("the blind count: the drawer's owner never receives what the system expected; two people approve the difference, posted once", async () => {
    const shiftId = await shiftOf(as("cashier"), 50_000);
    const item = await stocked({ qty: 3, price: 30_000 });
    await createSale(t.db, as("cashier"), sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 30_000, discountIqd: 0, serials: [] }], [{ method: "pos_cash", amountIqd: 30_000, tenderedIqd: 50_000 }]), ctx, NOW);
    const report = await shiftReport(t.db, as("cashier"), shiftId, "ar");
    expect(report.cash.expectedIqd).toBeNull();
    expect(report.byMethod).toBeNull();
    expect(report.moves.some((move) => move.kind === "sale")).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/80000|80,000/);

    const closed = await closeShift(t.db, as("cashier"), { shiftId, denominations: { "25000": 3 } }, NOW);
    expect(closed).toEqual({ needsReview: true, varianceIqd: null, replayed: false });
    expect(await closeShift(t.db, as("cashier"), { shiftId, denominations: { "25000": 3 } }, NOW)).toMatchObject({ replayed: true, varianceIqd: null });
    const list = await listShifts(t.db, as("cashier"), parseShiftFilters(new URLSearchParams()), "ar");
    expect(list.rows.every((row) => row.expectedCashIqd === null && row.varianceIqd === null)).toBe(true);
    const supervisor = await shiftReport(t.db, as("finance"), shiftId, "ar");
    expect(supervisor).toMatchObject({ expectedCashIqd: 80_000, varianceIqd: -5_000, countedCashIqd: 75_000, state: "review", canReview: true });

    // the cashier cannot review; a reviewer who also closed it cannot either
    expect((await failureOf(reviewShift(t.db, as("cashier"), { shiftId, expectedVarianceIqd: -5_000, note: "عدّ ناقص" }, NOW))).status).toBe(403);
    const managerShift = await shiftOf(as("manager2"), 10_000);
    await closeShift(t.db, as("manager2"), { shiftId: managerShift, countedCashIqd: 9_000 }, NOW);
    expect((await failureOf(reviewShift(t.db, as("manager2"), { shiftId: managerShift, expectedVarianceIqd: -1_000, note: "ورقة ضائعة" }, NOW))).code).toBe("shift_self_review");
    expect((await failureOf(reviewShift(t.db, as("finance"), { shiftId, expectedVarianceIqd: -4_000, note: "عدّ ناقص" }, NOW))).code).toBe("shift_changed");
    expect(await countReviewable(t.db, as("finance"))).toBeGreaterThanOrEqual(2);
    expect(await countReviewable(t.db, as("cashier"))).toBeNull();

    const approved = await reviewShift(t.db, as("finance"), { shiftId, expectedVarianceIqd: -5_000, note: "ورقة 5,000 مفقودة" }, NOW);
    expect(approved.replayed).toBe(false);
    expect(await reviewShift(t.db, as("finance"), { shiftId, expectedVarianceIqd: -5_000, note: "ورقة 5,000 مفقودة" }, NOW)).toMatchObject({ replayed: true });
    const entries = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `pos_shift:${shiftId}:variance`));
    expect(entries).toHaveLength(1);
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entries[0]?.id ?? ""));
    expect(lines.find((line) => line.accountId === accountId("cash_over_short"))?.debitIqd).toBe(5_000);
    expect(lines.find((line) => line.accountId === accountId("cash"))?.creditIqd).toBe(5_000);
    expect((await failureOf(reviewShift(t.db, as("manager"), { shiftId, expectedVarianceIqd: -5_000, note: "مرة ثانية" }, NOW))).code).toBe("shift_not_in_review");
  });
});

describe("the till", () => {
  test("prices are the server's; a price list for the point of sale applies; an offline price needs the override", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 5, price: 100_000 });
    const listId = newId("prl");
    await t.db.insert(priceLists).values({ id: listId, code: `POS-${randomToken(3)}`, name: { ar: "قائمة المحل" }, channel: "pos", priority: 5, isActive: true, createdAt: NOW, updatedAt: NOW });
    await t.db.insert(priceListItems).values({ priceListId: listId, variantId: item.variantId, minQty: 1, priceIqd: 95_000 });
    const hit = await lookupItem(t.db, as("cashier"), { shiftId, code: item.sku.toLowerCase() }, "ar", NOW);
    expect(hit).toMatchObject({ kind: "item", item: { unitPriceIqd: 95_000, basePriceIqd: 100_000, stockHere: 5 } });
    expect((await searchItems(t.db, as("cashier"), { shiftId, q: item.sku.slice(0, 6) }, "ar", NOW)).length).toBeGreaterThan(0);

    const stale = await failureOf(createSale(t.db, as("cashier"), sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000, discountIqd: 0, serials: [] }], [{ method: "pos_cash", amountIqd: 100_000 }]), ctx, NOW));
    expect(stale).toMatchObject({ code: "price_changed", prices: [{ index: 0, unitPriceIqd: 95_000 }], resolvable: null });
    const ok = await createSale(t.db, as("cashier"), sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 95_000, discountIqd: 0, serials: [] }], [{ method: "pos_cash", amountIqd: 95_000 }]), ctx, NOW);
    expect(ok.totalIqd).toBe(95_000);

    // an offline sale rung up at an older price: only an override with a reason records it at that price
    const offline = sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 90_000, discountIqd: 0, serials: [] }], [{ method: "pos_cash", amountIqd: 90_000 }], { offlineCreatedAt: NOW - 60_000 });
    const conflict = await failureOf(createSale(t.db, as("cashier"), offline, ctx, NOW));
    expect(conflict).toMatchObject({ code: "price_changed", resolvable: null });
    expect((await failureOf(createSale(t.db, as("cashier"), { ...offline, acceptChargedPrices: true, overrideReason: "سعر الكتالوج المحفوظ" }, ctx, NOW))).status).toBe(403);
    const managerShift = await shiftOf(as("manager"));
    const managerOffline = { ...offline, shiftId: managerShift, idempotencyKey: randomToken(18) };
    expect(await failureOf(createSale(t.db, as("manager"), managerOffline, ctx, NOW))).toMatchObject({ code: "price_changed", resolvable: "accept_prices" });
    expect((await failureOf(createSale(t.db, as("manager"), { ...managerOffline, acceptChargedPrices: true }, ctx, NOW))).fields).toMatchObject({ overrideReason: "override_reason_required" });
    const accepted = await createSale(t.db, as("manager"), { ...managerOffline, acceptChargedPrices: true, overrideReason: "بيع دون اتصال بسعر الكتالوج المحفوظ" }, ctx, NOW);
    expect(accepted.totalIqd).toBe(90_000);
    const trail = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "pos.sale.create"), eq(auditEvents.entityId, (await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, accepted.ref)).get())?.id ?? "")));
    expect(JSON.stringify(trail[0]?.after)).toMatch(/acceptedPrices/);
  });

  test("discounts: only with pos.discount.apply, within the limit and the margin floor, with a reason; beyond: the override", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 10, price: 100_000, landed: 92_000 });
    const line = (discountIqd: number) => [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000, discountIqd, serials: [] }];
    const pay = (amount: number) => [{ method: "pos_cash" as const, amountIqd: amount }];
    const noDiscount = custom(["pos.sale.create"]);
    expect((await failureOf(createSale(t.db, noDiscount, sale(shiftId, line(5_000), pay(95_000), { discountReason: "عرض" }), ctx, NOW))).code).toBe("discount_not_allowed");
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line(5_000), pay(95_000)), ctx, NOW))).fields).toMatchObject({ discountReason: "discount_reason_required" });
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line(10_001), pay(89_999), { discountReason: "عرض" }), ctx, NOW))).code).toBe("discount_over_limit");
    // under the landed cost (92,000) — within the 10 % limit, yet under the floor
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line(9_000), pay(91_000), { discountReason: "عرض" }), ctx, NOW))).code).toBe("discount_below_floor");
    expect((await createSale(t.db, as("cashier"), sale(shiftId, line(7_000), pay(93_000), { discountReason: "عرض المحل" }), ctx, NOW)).totalIqd).toBe(93_000);
    // a whole-sale discount counts too
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line(0), pay(85_000), { orderDiscountIqd: 15_000, discountReason: "عرض" }), ctx, NOW))).code).toBe("discount_over_limit");
    const managerShift = await shiftOf(as("manager"));
    const deep = await createSale(t.db, as("manager"), sale(managerShift, line(20_000), pay(80_000), { discountReason: "تصفية قطعة معروضة" }), ctx, NOW);
    expect(deep.totalIqd).toBe(80_000);
  });

  test("payments: a card slip is required; the wallet only for a looked-up account, never offline", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 5, price: 60_000 });
    const customerId = await make.customer();
    await creditWallet(t.db, system, { customerId, amountIqd: 20_000, kind: "adjustment", reason: "test", idempotencyKey: `t:${randomToken(8)}` }, NOW);
    const line = [{ variantId: item.variantId, qty: 1, unitPriceIqd: 60_000, discountIqd: 0, serials: [] }];
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line, [{ method: "pos_card", amountIqd: 60_000 }]), ctx, NOW))).code).toBe("card_reference_required");
    const phone = await findCustomerPhone(customerId);
    // a typed phone links the account but does not open the wallet
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line, [{ method: "pos_cash", amountIqd: 40_000 }, { method: "wallet", amountIqd: 20_000 }], { customer: { phone } }), ctx, NOW))).code).toBe("wallet_requires_account");
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line, [{ method: "pos_cash", amountIqd: 40_000 }, { method: "wallet", amountIqd: 20_000 }], { customer: { id: customerId }, offlineCreatedAt: NOW - 1000 }), ctx, NOW))).code).toBe("wallet_offline");
    // the cashier finds the account but not its balance (customers.wallet.read — review 2026-11-11); a manager sees it
    const hitCustomer = await findCustomer(t.db, as("cashier"), { phone: `0${phone.slice(4)}` });
    expect(hitCustomer).toMatchObject({ id: customerId, walletIqd: null });
    expect((await findCustomer(t.db, as("manager"), { phone }))?.walletIqd).toBe(20_000);
    expect(hitCustomer?.phoneMasked).not.toBe(phone);
    expect((await failureOf(findCustomer(t.db, custom(["pos.sale.create"]), { phone }))).status).toBe(403);
    const request = sale(shiftId, line, [{ method: "pos_card", amountIqd: 40_000, reference: "SLIP-7781" }, { method: "wallet", amountIqd: 20_000 }], { customer: { id: customerId } });
    const paid = await createSale(t.db, as("cashier"), request, ctx, NOW);
    expect(paid.totalIqd).toBe(60_000);
    const order = await t.db.select().from(orders).where(eq(orders.ref, paid.ref)).get();
    expect(order?.customerId).toBe(customerId);
    // the response was lost and the till queued the sale as offline: the replay answers with the recorded sale
    const [replay] = await syncSales(t.db, as("cashier"), { sales: [{ ...request, offlineCreatedAt: NOW + 5_000 }] }, ctx, NOW + 10_000);
    expect(replay?.outcome).toMatchObject({ ok: true, ref: paid.ref, replayed: true });
    expect((await t.db.select().from(orders).where(eq(orders.customerId, customerId))).length).toBe(1);
  });

  test("a closed shift: no sale is rung on it; its owner sees their own sales only", async () => {
    const shiftId = await shiftOf(as("cashier2"));
    const item = await stocked({ qty: 2, price: 20_000 });
    const line = [{ variantId: item.variantId, qty: 1, unitPriceIqd: 20_000, discountIqd: 0, serials: [] }];
    const sold = await createSale(t.db, as("cashier2"), sale(shiftId, line, [{ method: "pos_cash", amountIqd: 20_000 }]), ctx, NOW);
    const mine = await listSales(t.db, as("cashier2"), parseSaleFilters(new URLSearchParams()), "ar");
    expect(mine.rows.every((row) => row.shiftId === shiftId)).toBe(true);
    expect(mine.totals).toBeNull();
    expect((await listSales(t.db, as("cashier"), parseSaleFilters(new URLSearchParams()), "ar")).rows.some((row) => row.ref === sold.ref)).toBe(false);
    const all = await listSales(t.db, as("finance"), parseSaleFilters(new URLSearchParams({ shift: shiftId })), "ar");
    expect(all.rows.map((row) => row.ref)).toEqual([sold.ref]);
    await closeShift(t.db, as("cashier2"), { shiftId, countedCashIqd: 70_000 }, NOW);
    // a sale rung up after the count but before the review moves the shift's figures (a late offline sale)
    const late = await createSale(t.db, as("cashier2"), sale(shiftId, line, [{ method: "pos_cash", amountIqd: 20_000 }], { offlineCreatedAt: NOW - 1000 }), ctx, NOW);
    expect(late.lateForClosedShift).toBe(true);
    const report = await shiftReport(t.db, as("finance"), shiftId, "ar");
    expect(report).toMatchObject({ expectedCashIqd: 90_000, varianceIqd: -20_000 });
    expect((await failureOf(moveCash(t.db, as("cashier2"), { shiftId, kind: "pay_in", amountIqd: 1_000, reason: "متأخر", idempotencyKey: randomToken(16) }, NOW))).code).toBe("shift_not_open");
  });

  test("serial numbers scanned at the till are resolved; a sold one is refused", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const console5 = await stocked({ serials: 2, price: 700_000, cost: 500_000 });
    const hit = await lookupItem(t.db, as("cashier"), { shiftId, code: console5.numbers[0] as string }, "ar", NOW);
    expect(hit).toMatchObject({ kind: "item", item: { variantId: console5.variantId, serial: { serial: console5.numbers[0] } } });
    const line = (serial: string) => [{ variantId: console5.variantId, qty: 1, unitPriceIqd: 700_000, discountIqd: 0, serials: [serial.toLowerCase()] }];
    const first = await createSale(t.db, as("cashier"), sale(shiftId, line(console5.numbers[0] as string), [{ method: "pos_cash", amountIqd: 700_000 }]), ctx, NOW);
    expect(first.receiptNumber).toMatch(/^RC-/);
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line(console5.numbers[0] as string), [{ method: "pos_cash", amountIqd: 700_000 }]), ctx, NOW))).code).toBe("serial_not_available");
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line("NOPE-1"), [{ method: "pos_cash", amountIqd: 700_000 }]), ctx, NOW))).code).toBe("serial_unknown");
    expect(await lookupItem(t.db, as("cashier"), { shiftId, code: console5.numbers[0] as string }, "ar", NOW)).toMatchObject({ kind: "serial_unavailable", status: "sold" });
    // the receipt shows the serial only to who may read serials
    const withSerials = await getReceipt(t.db, as("cashier"), first.ref, "ar");
    expect(withSerials.lines[0]?.serials).toEqual([console5.numbers[0]]);
    const noSerialReader = custom(["pos.shift.review"], as("finance").id);
    expect((await getReceipt(t.db, noSerialReader, first.ref, "ar")).lines[0]?.serials).toBeNull();
    // a copy is recorded; another cashier's receipt is not theirs to open
    expect(await recordReprint(t.db, as("cashier"), first.ref, NOW)).toEqual({ copy: 1 });
    expect((await getReceipt(t.db, as("cashier"), first.ref, "ar")).copies).toBe(1);
    expect((await failureOf(getReceipt(t.db, as("cashier2"), first.ref, "ar"))).status).toBe(404);
  });

  test("offline: a queued sale synced twice is recorded once; a stock conflict is resolved by an authorised oversell", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 1, price: 50_000 });
    const queued = sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 50_000, discountIqd: 0, serials: [] }], [{ method: "pos_cash", amountIqd: 50_000 }], { offlineCreatedAt: NOW - 120_000 });
    const [first] = await syncSales(t.db, as("cashier"), { sales: [queued] }, ctx, NOW);
    const [again] = await syncSales(t.db, as("cashier"), { sales: [queued] }, ctx, NOW + 1000);
    expect(first?.outcome).toMatchObject({ ok: true, replayed: false });
    expect(again?.outcome).toMatchObject({ ok: true, replayed: true });
    expect((await t.db.select().from(orders).where(eq(orders.posShiftId, shiftId))).length).toBe(1);
    expect((await t.db.select().from(orders).where(eq(orders.posShiftId, shiftId)).get())?.offlineCreatedAt).toBe(NOW - 120_000);

    // the last unit went to a web order while the till was offline
    const other = await stocked({ qty: 1, price: 40_000 });
    const web = await make.order([{ ...other, qty: 1 }]);
    await runBatch(t.db, reserveStatements(t.db, { orderId: web.orderId, lines: [{ variantId: other.variantId, qty: 1 }], expiresAt: null, actor: system, now: NOW }));
    const late = sale(shiftId, [{ variantId: other.variantId, qty: 1, unitPriceIqd: 40_000, discountIqd: 0, serials: [] }], [{ method: "pos_cash", amountIqd: 40_000 }], { offlineCreatedAt: NOW - 60_000 });
    const [conflict] = await syncSales(t.db, as("cashier"), { sales: [late] }, ctx, NOW);
    expect(conflict?.outcome).toMatchObject({ ok: false, code: "insufficient_stock", resolvable: null });
    // the supervisor who resolves it records it on the cashier's drawer (a take-over) with the oversell right
    const [resolved] = await syncSales(t.db, as("manager"), { sales: [{ ...late, allowOversell: true, overrideReason: "خرجت القطعة قبل طلب الموقع" }] }, ctx, NOW);
    expect(resolved?.outcome).toMatchObject({ ok: true });
    const level = await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, other.variantId), eq(stockLevels.locationId, storeId))).get();
    expect(level).toMatchObject({ onHand: 0, reserved: 1, allowOversell: true });
    // garbage in the queue is a failure of that entry, never a crash
    const [bad] = await syncSales(t.db, as("cashier"), { sales: [{ idempotencyKey: "short", shiftId }] }, ctx, NOW);
    expect(bad?.outcome).toMatchObject({ ok: false, code: "invalid" });
  });

  test("no cost data leaves the server through the till, the catalogue, receipts or lists", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 4, price: 77_000, cost: 54_321, landed: 54_321 });
    const sold = await createSale(t.db, as("cashier"), sale(shiftId, [{ variantId: item.variantId, qty: 2, unitPriceIqd: 77_000, discountIqd: 0, serials: [] }], [{ method: "pos_cash", amountIqd: 154_000 }]), ctx, NOW);
    const outputs = [
      await lookupItem(t.db, as("cashier"), { shiftId, code: item.sku }, "ar", NOW),
      await catalogSnapshot(t.db, as("cashier"), { shiftId }, "ar", NOW),
      await getReceipt(t.db, as("manager"), sold.ref, "ar"),
      await listSales(t.db, as("manager"), parseSaleFilters(new URLSearchParams()), "ar"),
      await shiftReport(t.db, as("manager"), shiftId, "ar"),
    ];
    for (const output of outputs) expect(JSON.stringify(output)).not.toMatch(/54321|54,321|costIqd|landed|cost_snapshot|costSnapshot/);
  });

  test("numbers typed by a person: Arabic-Indic and Persian digits, separators, no fractions", () => {
    expect(parseWhole("١٢٬٥٠٠")).toBe(12_500);
    expect(parseWhole("۲۵,۰۰۰")).toBe(25_000);
    expect(parseWhole("")).toBeNull();
    expect(parseWhole("12.5")).toBeNaN();
    expect(parseWhole("1,2,3")).toBeNaN();
    expect(parsePercentBps("٧٫٥%")).toBe(750);
    expect(parsePercentBps("120")).toBeNaN();
  });
});

describe("the cashier's discount limit is the setting pos.discount_limit_bps (admin 22, 2026-11-11)", () => {
  test("its default is the former constant; the sale's check, its audit trail and the till read the value in force", async () => {
    expect(settingDefault("pos.discount_limit_bps")).toBe(CASHIER_DISCOUNT_LIMIT_BPS);
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 10, price: 100_000, landed: 60_000 });
    const line = (discountIqd: number) => [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000, discountIqd, serials: [] }];
    const pay = (amount: number) => [{ method: "pos_cash" as const, amountIqd: amount }];
    // 12 % is over the default 10 %
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line(12_000), pay(88_000), { discountReason: "عرض" }), ctx, NOW))).code).toBe("discount_over_limit");

    await setSetting(t.db, as("owner"), "pos.discount_limit_bps", 1500, "عروض الموسم", NOW, { expected: CASHIER_DISCOUNT_LIMIT_BPS });
    try {
      const made = await createSale(t.db, as("cashier"), sale(shiftId, line(12_000), pay(88_000), { discountReason: "عرض الموسم" }), ctx, NOW);
      expect(made.totalIqd).toBe(88_000);
      const orderId = (await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, made.ref)).get())?.id ?? "";
      const trail = await t.db.select({ after: auditEvents.after }).from(auditEvents).where(and(eq(auditEvents.action, "pos.sale.create"), eq(auditEvents.entityId, orderId))).get();
      expect(JSON.stringify(trail?.after)).toContain('"discountLimitBps":1500');
      // 16 % is over the new limit too
      expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, line(16_000), pay(84_000), { discountReason: "عرض" }), ctx, NOW))).code).toBe("discount_over_limit");

      // The till checks the same number before it sends a sale.
      const password = "pos-limit-password-1";
      const hashed = await hashPassword(password, 1000);
      const email = `${make.next("till")}@pos.test`;
      const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
      await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId("cashier") });
      const req = request();
      const result = await signInEmployee(req.ctx, t.db, { email, password });
      if (result.status !== "signed_in") throw new Error("sign-in failed");
      const page = new Request("http://localhost:5173/admin/pos/sell", { headers: { cookie: cookieOf(req.setCookies) } });
      const context = new RouterContextProvider();
      let till: unknown = null;
      await requestContextMiddleware({ request: page, context, url: new URL(page.url), pattern: "/", params: {} }, async () => {
        till = await sellLoader({ request: page, context, params: {}, url: new URL(page.url), pattern: "admin/pos/sell" } as never);
        return new Response(null);
      });
      expect(till).toMatchObject({ limitBps: 1500 });
    } finally {
      await setSetting(t.db, as("owner"), "pos.discount_limit_bps", CASHIER_DISCOUNT_LIMIT_BPS, "إعادة الحد", NOW);
    }
  });

  test("the refusal never names a limit other than the one in force: no fixed 10 % in any language (the till's hint shows the setting)", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 4, price: 100_000, landed: 60_000 });
    await setSetting(t.db, as("owner"), "pos.discount_limit_bps", 1500, "عروض الموسم", NOW, { expected: CASHIER_DISCOUNT_LIMIT_BPS });
    try {
      // 16 % against a 15 % limit: refused — and the words the cashier reads must not say the limit is 10 %
      const refused = await failureOf(createSale(t.db, as("cashier"), sale(shiftId, [{ variantId: item.variantId, qty: 1, unitPriceIqd: 100_000, discountIqd: 16_000, serials: [] }], [{ method: "pos_cash", amountIqd: 84_000 }], { discountReason: "عرض" }), ctx, NOW));
      expect(refused.code).toBe("discount_over_limit");
      for (const locale of ["ar", "en", "ckb"] as const) {
        // the till's banner and the line's field error, as the route glue translates them (posT: the module's strings)
        const shown = posFailure(refused, locale, "sale");
        const texts = [shown.message ?? "", ...Object.values(shown.fields ?? {})];
        expect(texts.length, locale).toBeGreaterThan(1);
        for (const text of texts) {
          expect(text, locale).not.toBe("");
          expect(text, locale).not.toMatch(/(^|[^0-9.,])10\s?%|١٠\s?[٪%]/);
          expect(text, locale).not.toMatch(/\{\w+\}/);
        }
      }
    } finally {
      await setSetting(t.db, as("owner"), "pos.discount_limit_bps", CASHIER_DISCOUNT_LIMIT_BPS, "إعادة الحد", NOW);
    }
  });
});

describe("routes", () => {
  test("loaders: 403 for a role without a POS permission; the till API refuses a role that cannot sell", async () => {
    const signedIn = async (key: DefaultRoleKey) => {
      const password = "pos-staff-password-1";
      const hashed = await hashPassword(password, 1000);
      const email = `${make.next(key)}@pos.test`;
      const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
      await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
      const req = request();
      const result = await signInEmployee(req.ctx, t.db, { email, password });
      if (result.status !== "signed_in") throw new Error("sign-in failed");
      return cookieOf(req.setCookies);
    };
    const call = async <T,>(cookie: string, path: string, run: (context: RouterContextProvider, req: Request) => Promise<T>) => {
      const req = new Request(`http://localhost:5173${path}`, { headers: { cookie } });
      const context = new RouterContextProvider();
      try {
        let out: unknown;
        await requestContextMiddleware({ request: req, context, url: new URL(req.url), pattern: "/", params: {} }, async () => {
          out = await run(context, req);
          return new Response(null);
        });
        return out;
      } catch (error) {
        return error;
      }
    };
    const content = await signedIn("content");
    const refused = (await call(content, "/admin/pos", (context, req) => homeLoader({ request: req, context, params: {}, url: new URL(req.url), pattern: "admin/pos" } as never))) as { init?: { status?: number } };
    expect(refused?.init?.status).toBe(403);
    const finance = await signedIn("finance");
    const home = (await call(finance, "/admin/pos", (context, req) => homeLoader({ request: req, context, params: {}, url: new URL(req.url), pattern: "admin/pos" } as never))) as { access: { sell: boolean; review: boolean } };
    expect(home.access).toMatchObject({ sell: false, review: true });
    const api = (await call(finance, "/admin/pos/api/catalog?shift=x", (context, req) => apiLoader({ request: req, context, params: { op: "catalog" }, url: new URL(req.url), pattern: "admin/pos/api/:op" } as never))) as { init?: { status?: number } };
    expect(api?.init?.status).toBe(403);
    const cashier = await signedIn("cashier");
    const notFound = (await call(cashier, "/admin/pos/api/nothing", (context, req) => apiLoader({ request: req, context, params: { op: "nothing" }, url: new URL(req.url), pattern: "admin/pos/api/:op" } as never))) as Response;
    expect(notFound.status).toBe(404);
  });
});

async function findCustomerPhone(customerId: string): Promise<string> {
  const { customers } = await import("~/server/db/schema");
  const row = await t.db.select({ phone: customers.phoneE164 }).from(customers).where(eq(customers.id, customerId)).get();
  return row?.phone as string;
}

function request(): { ctx: RequestCtx; setCookies: string[] } {
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `pos-${randomToken(6)}`,
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
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

function cookieOf(setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

