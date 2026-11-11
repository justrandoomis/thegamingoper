/**
 * Admin module 06 "pos" — adversarial review (2026-11-11). Each test below failed on the builder's code:
 *
 *   · BLIND COUNT: a supervisor working a till got their OWN drawer's expected cash, cash sales and difference (shift
 *     report, the till's shift, the shifts list, the "sales of this shift" total, the close result) — so they could
 *     count exactly the expected figure and close with no difference, and no second person would ever look
 *   · a sale rung up NOW on a drawer that was already counted (a till tab left open after closing the shift) was
 *     recorded as a "late" sale and moved the counted shift's difference by cash that was never in the count
 *   · "accept the prices the customer paid" (meant for a sale queued offline) worked for an online sale: a manager could
 *     ring up any price that no discount report would ever show
 *   · a cash move or a shift opening whose key came back with other figures answered "recorded" (replayed) silently
 *   · a register switched off just before a shift's write still got an open shift (race before the write batch)
 *   · a bundle's discount was never held to its components' cost (the margin floor skipped bundles)
 *   · the till's customer lookup handed the wallet balance to roles without customers.wallet.read (module 07 hides it)
 *   · field errors reached the till as raw keys ("card_reference_required") instead of sentences
 *   · printing: the till printed through a hidden frame that X-Frame-Options: DENY never loads, and any number of
 *     unmarked "originals" printed in the first 15 minutes — now the first print is the original (recorded once,
 *     also for two at once) and every later one a recorded copy (pos.receipt.reprint)
 *   · discarding a queued offline sale (goods gone, cash in the drawer, nothing in the books) needed only
 *     pos.sale.create — the cashier who took the money erased the record; and a body that was not an object was a 500
 *   · an unknown item id was answered "the used device is no longer available"
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { action as apiAction } from "~/routes/admin/pos/till-api";
import { posT } from "~/routes/admin/pos/pos.server";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, bundleItems, customers, employeeRoles, inventoryLocations, orders, posRegisters, posShifts, stockLevels, variantCosts } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { saveRegister } from "~/server/services/admin/pos/registers.server";
import { createSale, discardQueuedSale, findCustomer, getReceipt, listSales, printReceipt, syncSales, type SaleRequestInput } from "~/server/services/admin/pos/sale.server";
import { closeShift, listShifts, moveCash, myShift, openShift, shiftReport } from "~/server/services/admin/pos/shifts.server";
import { parseSaleFilters, parseShiftFilters } from "~/server/services/admin/pos/types";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { creditWallet } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const system = systemActor("test.admin-pos-review");
const ctx = { locale: "ar" as const, storeMode: "live" as const };
let t: TestDb;
let make: Fixtures;
let storeId: string;
const staff: Partial<Record<DefaultRoleKey, EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "cashier"] as const) staff[key] = await employee(key);
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
const as = (key: DefaultRoleKey): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
const custom = (permissions: Permission[], id: string): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions) });

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return (toAppError(error) ?? error) as AppError;
  }
  throw new Error("expected a failure");
}

const code = () => `RV-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`;
async function register(): Promise<{ id: string; code: string }> {
  const value = code();
  const result = await saveRegister(t.db, as("manager"), { code: value, name: "Till", locationId: storeId, isActive: true }, NOW);
  return { id: result.registerId, code: value };
}

/** An open shift of `who` on a new register (an earlier open shift of theirs is closed first). */
async function shiftOf(who: EmployeeActor, float = 50_000): Promise<string> {
  const open = await t.db.select({ id: posShifts.id }).from(posShifts).where(and(eq(posShifts.openedBy, who.id), eq(posShifts.status, "open"))).get();
  if (open) await closeShift(t.db, who, { shiftId: open.id, countedCashIqd: 0 }, NOW);
  return (await openShift(t.db, who, { registerId: (await register()).id, openingFloatIqd: float, idempotencyKey: randomToken(16) }, NOW)).shiftId;
}

async function stocked(options: { qty?: number; price?: number; landed?: number } = {}) {
  const product = await make.product({ priceIqd: options.price ?? 100_000 });
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: storeId, qty: options.qty ?? 5, unitCostIqd: 60_000, ref: "test" }, NOW);
  if (options.landed !== undefined) await t.db.insert(variantCosts).values({ variantId: product.variantId, currency: "IQD", unitCostMinor: options.landed, landedCostIqd: options.landed, updatedAt: NOW });
  return product;
}

const sale = (shiftId: string, lines: SaleRequestInput["lines"], payments: SaleRequestInput["payments"], extra: Partial<SaleRequestInput> = {}): SaleRequestInput => ({ idempotencyKey: randomToken(18), shiftId, customer: null, lines, payments, ...extra });
const line = (variantId: string, unitPriceIqd: number, extra: Partial<SaleRequestInput["lines"][number]> = {}) => ({ variantId, qty: 1, unitPriceIqd, discountIqd: 0, serials: [], ...extra });
const cash = (amountIqd: number) => [{ method: "pos_cash" as const, amountIqd }];

type Batch = (statements: unknown) => Promise<unknown>;
/** The same database, except that `hook` runs once just before the `nth` db.batch call: a competing request. */
function beforeBatch(db: Db, nth: number, hook: () => PromiseLike<unknown>): Db {
  let calls = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: unknown) => {
          calls += 1;
          if (calls === nth) await hook();
          return (target.batch as unknown as Batch).call(target, statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("admin 06 pos — adversarial review", () => {
  test("blind count: a supervisor's OWN drawer is counted blind too — report, till, list, the shift's sales total, the close", async () => {
    const shiftId = await shiftOf(as("manager"), 50_000);
    const item = await stocked({ qty: 3, price: 30_000 });
    await createSale(t.db, as("manager"), sale(shiftId, [line(item.variantId, 30_000)], cash(30_000)), ctx, NOW);

    const own = await shiftReport(t.db, as("manager"), shiftId, "ar");
    expect(own.cash).toEqual({ expectedIqd: null, salesIqd: null, refundsIqd: null, payInIqd: null, payOutIqd: null, dropIqd: null });
    expect(own.byMethod).toBeNull();
    expect(own.sales.totalIqd).toBeNull();
    expect(own.moves.some((move) => move.kind === "sale")).toBe(false);
    expect(JSON.stringify(own)).not.toMatch(/80000|30000/);
    const till = await myShift(t.db, as("manager"), "ar");
    expect(till?.sales.totalIqd ?? null).toBeNull();
    expect((await listSales(t.db, as("manager"), parseSaleFilters(new URLSearchParams({ shift: shiftId })), "ar")).totals).toBeNull();
    // another supervisor sees the drawer
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).cash.expectedIqd).toBe(80_000);
    expect((await listSales(t.db, as("finance"), parseSaleFilters(new URLSearchParams({ shift: shiftId })), "ar")).totals).toEqual({ count: 1, totalIqd: 30_000 });

    const closed = await closeShift(t.db, as("manager"), { shiftId, countedCashIqd: 75_000 }, NOW);
    expect(closed).toEqual({ needsReview: true, varianceIqd: null, replayed: false });
    const row = (await listShifts(t.db, as("manager"), parseShiftFilters(new URLSearchParams({ mine: "1" })), "ar")).rows.find((entry) => entry.id === shiftId);
    expect(row).toMatchObject({ expectedCashIqd: null, varianceIqd: null });
    expect((await shiftReport(t.db, as("manager"), shiftId, "ar")).varianceIqd).toBeNull();
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).varianceIqd).toBe(-5_000);
  });

  test("a sale rung up now on a counted drawer is refused; only a sale queued offline lands in it", async () => {
    const shiftId = await shiftOf(as("cashier"), 50_000);
    const item = await stocked({ qty: 3, price: 20_000 });
    await closeShift(t.db, as("cashier"), { shiftId, countedCashIqd: 50_000 }, NOW);
    // the till tab was left open after the shift was closed in another tab
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, [line(item.variantId, 20_000)], cash(20_000)), ctx, NOW + 1_000))).code).toBe("pos_shift_not_open");
    expect(await t.db.select({ expected: posShifts.expectedCashIqd, variance: posShifts.varianceIqd }).from(posShifts).where(eq(posShifts.id, shiftId)).get()).toEqual({ expected: 50_000, variance: 0 });
    expect((await t.db.select().from(orders).where(eq(orders.posShiftId, shiftId))).length).toBe(0);
    // a sale the device queued while offline (before the count) still lands, and moves the counted figures
    const late = await createSale(t.db, as("cashier"), sale(shiftId, [line(item.variantId, 20_000)], cash(20_000), { offlineCreatedAt: NOW - 60_000 }), ctx, NOW + 2_000);
    expect(late.lateForClosedShift).toBe(true);
  });

  test("accepting the prices a customer paid is for a sale queued offline only — never a way to ring up any price online", async () => {
    const shiftId = await shiftOf(as("manager"));
    const item = await stocked({ qty: 3, price: 100_000 });
    const online = sale(shiftId, [line(item.variantId, 10_000)], cash(10_000), { acceptChargedPrices: true, overrideReason: "سعر خاص للزبون" });
    expect(await failureOf(createSale(t.db, as("manager"), online, ctx, NOW))).toMatchObject({ code: "price_changed" });
    expect((await t.db.select().from(orders).where(eq(orders.posShiftId, shiftId))).length).toBe(0);
    const offline = { ...online, idempotencyKey: randomToken(18), lines: [line(item.variantId, 95_000)], payments: cash(95_000), offlineCreatedAt: NOW - 60_000 };
    expect((await createSale(t.db, as("manager"), offline, ctx, NOW)).totalIqd).toBe(95_000);
  });

  test("a key that comes back with other figures is refused (cash move, opening a shift), the same figures are a replay", async () => {
    const shiftId = await shiftOf(as("cashier"), 100_000);
    const key = randomToken(16);
    await moveCash(t.db, as("cashier"), { shiftId, kind: "drop", amountIqd: 10_000, reason: "إلى الخزنة", idempotencyKey: key }, NOW);
    expect((await failureOf(moveCash(t.db, as("cashier"), { shiftId, kind: "drop", amountIqd: 20_000, reason: "إلى الخزنة", idempotencyKey: key }, NOW))).code).toBe("idempotency_mismatch");
    expect((await failureOf(moveCash(t.db, as("cashier"), { shiftId, kind: "pay_in", amountIqd: 10_000, reason: "فكّة", idempotencyKey: key }, NOW))).code).toBe("idempotency_mismatch");
    expect(await moveCash(t.db, as("cashier"), { shiftId, kind: "drop", amountIqd: 10_000, reason: "إلى الخزنة", idempotencyKey: key }, NOW)).toEqual({ replayed: true });

    const who = await employee("cashier");
    const [a, b] = [await register(), await register()];
    const openKey = randomToken(16);
    const opened = await openShift(t.db, who, { registerId: a.id, openingFloatIqd: 10_000, idempotencyKey: openKey }, NOW);
    expect((await failureOf(openShift(t.db, who, { registerId: b.id, openingFloatIqd: 10_000, idempotencyKey: openKey }, NOW))).code).toBe("idempotency_mismatch");
    expect((await failureOf(openShift(t.db, who, { registerId: a.id, openingFloatIqd: 25_000, idempotencyKey: openKey }, NOW))).code).toBe("idempotency_mismatch");
    expect(await openShift(t.db, who, { registerId: a.id, openingFloatIqd: 10_000, idempotencyKey: openKey }, NOW)).toEqual({ shiftId: opened.shiftId, replayed: true });
  });

  test("race: a register switched off just before the shift's write never gets an open shift", async () => {
    const who = await employee("cashier");
    const till = await register();
    const racing = beforeBatch(t.db, 1, () => saveRegister(t.db, as("manager"), { registerId: till.id, code: till.code, name: "Till", locationId: storeId, isActive: false, reason: "مغلق للصيانة" }, NOW));
    const refused = await failureOf(openShift(racing, who, { registerId: till.id, openingFloatIqd: 0, idempotencyKey: randomToken(16) }, NOW));
    expect(refused.code).toBe("pos_register_inactive");
    expect(await t.db.select().from(posShifts).where(and(eq(posShifts.registerId, till.id), eq(posShifts.status, "open"))).get()).toBeUndefined();
    expect((await t.db.select({ active: posRegisters.isActive }).from(posRegisters).where(eq(posRegisters.id, till.id)).get())?.active).toBe(false);
  });

  test("a bundle's discount is held to the cost of its components (the margin floor)", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const a = await stocked({ qty: 2, price: 60_000, landed: 48_000 });
    const b = await stocked({ qty: 2, price: 60_000, landed: 48_000 });
    const bundle = await make.product({ kind: "bundle", priceIqd: 100_000 });
    await t.db.insert(bundleItems).values([
      { bundleVariantId: bundle.variantId, componentVariantId: a.variantId, qty: 1 },
      { bundleVariantId: bundle.variantId, componentVariantId: b.variantId, qty: 1 },
    ]);
    // 5 % is within the cashier's 10 %, but 95,000 is under the 96,000 the two components cost
    const under = sale(shiftId, [line(bundle.variantId, 100_000, { discountIqd: 5_000 })], cash(95_000), { discountReason: "عرض المحل" });
    expect((await failureOf(createSale(t.db, as("cashier"), under, ctx, NOW))).code).toBe("discount_below_floor");
    expect((await createSale(t.db, as("cashier"), sale(shiftId, [line(bundle.variantId, 100_000, { discountIqd: 3_000 })], cash(97_000), { discountReason: "عرض المحل" }), ctx, NOW)).totalIqd).toBe(97_000);
  });

  test("the till's customer lookup shows the wallet balance only to roles with customers.wallet.read", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, system, { customerId, amountIqd: 20_000, kind: "adjustment", reason: "test", idempotencyKey: `t:${randomToken(8)}` }, NOW);
    const phone = (await t.db.select({ phone: customers.phoneE164 }).from(customers).where(eq(customers.id, customerId)).get())?.phone as string;
    const cashierHit = await findCustomer(t.db, as("cashier"), { phone });
    expect(cashierHit).toMatchObject({ id: customerId, walletIqd: null });
    expect(JSON.stringify(cashierHit)).not.toMatch(/20000/);
    expect((await findCustomer(t.db, as("manager"), { phone }))?.walletIqd).toBe(20_000);
    // the cashier still takes a wallet payment for the customer at the counter (the server checks the balance)
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 2, price: 50_000 });
    const paid = await createSale(t.db, as("cashier"), sale(shiftId, [line(item.variantId, 50_000)], [{ method: "pos_cash", amountIqd: 30_000 }, { method: "wallet", amountIqd: 20_000 }], { customer: { id: customerId } }), ctx, NOW);
    expect(paid.totalIqd).toBe(50_000);
  });

  test("field errors reach the till as sentences in its language, not as keys", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 2, price: 40_000 });
    const en = posT("en");
    const [result] = await syncSales(t.db, as("cashier"), { sales: [sale(shiftId, [line(item.variantId, 40_000)], [{ method: "pos_card", amountIqd: 40_000 }], { offlineCreatedAt: NOW - 1_000 })] }, ctx, NOW, en);
    expect(result?.outcome).toMatchObject({ ok: false, code: "card_reference_required" });
    const fields = result?.outcome.ok === false ? (result.outcome.fields ?? {}) : {};
    expect(fields["payments.0.reference"]).toBe(en("errors.card_reference_required"));
    expect(fields["payments.0.reference"]).not.toBe("card_reference_required");
  });

  test("printing: the first print is the original (recorded once, also for two at once); every later print is a recorded copy", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 5, price: 25_000 });
    const sold = await createSale(t.db, as("cashier"), sale(shiftId, [line(item.variantId, 25_000)], cash(25_000)), ctx, NOW);
    expect((await getReceipt(t.db, as("cashier"), sold.ref, "ar")).printed).toBe(false);
    const original = await printReceipt(t.db, as("cashier"), sold.ref, NOW + 1_000);
    expect(original).toMatchObject({ copy: 0, receipt: { ref: sold.ref, printed: true, copies: 0 } });
    // a second print within the same minute is a COPY, marked and recorded
    const copy = await printReceipt(t.db, as("cashier"), sold.ref, NOW + 2_000);
    expect(copy).toMatchObject({ copy: 1, receipt: { copies: 1 } });
    const orderId = (await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, sold.ref)).get())?.id as string;
    const events = await t.db.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, orderId));
    expect(events.filter((event) => event.action === "pos.receipt.print")).toHaveLength(1);
    expect(events.filter((event) => event.action === "pos.receipt.reprint")).toHaveLength(1);

    // two prints at once: one original, one copy
    const other = await createSale(t.db, as("cashier"), sale(shiftId, [line(item.variantId, 25_000)], cash(25_000)), ctx, NOW);
    const both = await Promise.all([printReceipt(t.db, as("cashier"), other.ref, NOW), printReceipt(t.db, as("cashier"), other.ref, NOW)]);
    expect(both.map((entry) => entry.copy).sort()).toEqual([0, 1]);

    // a supervisor without the reprint permission prints the original once, never a copy
    const third = await createSale(t.db, as("cashier"), sale(shiftId, [line(item.variantId, 25_000)], cash(25_000)), ctx, NOW);
    const reviewer = custom(["pos.shift.review"], as("finance").id);
    expect((await printReceipt(t.db, reviewer, third.ref, NOW)).copy).toBe(0);
    expect((await failureOf(printReceipt(t.db, reviewer, third.ref, NOW))).status).toBe(403);
  });

  test("discarding a queued offline sale: a supervisor, with a reason; the trail keeps what was dropped; a recorded sale is not discarded", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const item = await stocked({ qty: 2, price: 15_000 });
    const queued = sale(shiftId, [line(item.variantId, 15_000)], cash(15_000), { offlineCreatedAt: NOW - 60_000 });
    expect((await failureOf(discardQueuedSale(t.db, as("cashier"), { key: queued.idempotencyKey, reason: "بيع مكرر على الجهاز", sale: queued }, NOW))).status).toBe(403);
    expect((await failureOf(discardQueuedSale(t.db, as("manager"), { key: queued.idempotencyKey, reason: "x", sale: queued }, NOW))).fields).toMatchObject({ reason: expect.any(String) });
    await discardQueuedSale(t.db, as("manager"), { key: queued.idempotencyKey, reason: "بيع مكرر على الجهاز", sale: queued }, NOW);
    const event = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "pos.offline.discard"), eq(auditEvents.entityType, "pos_offline_sale"))).get();
    expect(event?.reason).toBe("بيع مكرر على الجهاز");
    expect(JSON.stringify(event?.after)).toMatch(item.sku);
    expect(JSON.stringify(event?.after)).toMatch(/15000/);
    // a key the server recorded as a sale is not "discarded" (its sync answers with the sale)
    const recorded = sale(shiftId, [line(item.variantId, 15_000)], cash(15_000));
    await createSale(t.db, as("cashier"), recorded, ctx, NOW);
    expect((await failureOf(discardQueuedSale(t.db, as("manager"), { key: recorded.idempotencyKey, reason: "تجربة الحذف", sale: recorded }, NOW))).code).toBe("sale_recorded");
  });

  test("a scanned serial leaves from where it is: the shelf's count drops, not the store's (counts keep matching serials)", async () => {
    const shelfId = newId("loc");
    await t.db.insert(inventoryLocations).values({ id: shelfId, code: `SHELF-${randomToken(4)}`, name: "Shelf", kind: "bin", parentId: storeId, isSellable: true });
    const shiftId = await shiftOf(as("cashier"));
    const product = await make.product({ priceIqd: 300_000, trackSerials: true });
    const onShelf = `SN-${randomToken(6).toUpperCase()}`;
    const atStore = [`SN-${randomToken(6).toUpperCase()}`, `SN-${randomToken(6).toUpperCase()}`];
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: shelfId, qty: 1, unitCostIqd: 200_000, serials: [onShelf], ref: "test" }, NOW);
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: storeId, qty: 2, unitCostIqd: 200_000, serials: atStore, ref: "test" }, NOW);
    await createSale(t.db, as("cashier"), sale(shiftId, [line(product.variantId, 300_000, { serials: [onShelf] })], cash(300_000)), ctx, NOW);
    const levels = await t.db.select({ locationId: stockLevels.locationId, onHand: stockLevels.onHand }).from(stockLevels).where(eq(stockLevels.variantId, product.variantId));
    expect(levels.find((row) => row.locationId === shelfId)?.onHand).toBe(0);
    expect(levels.find((row) => row.locationId === storeId)?.onHand).toBe(2);
  });

  test("serial numbers typed with Arabic-Indic or Persian digits are read as the same serial", async () => {
    const shiftId = await shiftOf(as("cashier"));
    const product = await make.product({ priceIqd: 250_000, trackSerials: true });
    const digits = String(1_000_000 + Math.floor(Math.random() * 8_000_000));
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: storeId, qty: 2, unitCostIqd: 150_000, serials: [`SN-${digits}`, `SN-${digits}9`], ref: "test" }, NOW);
    const arabic = `SN-${digits.replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)] as string)}`;
    const persian = `SN-${digits.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)] as string)}۹`;
    const sold = await createSale(t.db, as("cashier"), sale(shiftId, [line(product.variantId, 250_000, { qty: 2, serials: [arabic, persian] })], cash(500_000)), ctx, NOW);
    expect(sold.totalIqd).toBe(500_000);
  });

  test("an unknown item is not_found — not 'the used device is no longer available'", async () => {
    const shiftId = await shiftOf(as("cashier"));
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, [line("var_does_not_exist", 10_000)], cash(10_000)), ctx, NOW))).code).toBe("not_found");
  });
});

describe("admin 06 pos — review: the till API", () => {
  test("discard: 403 for a cashier, 400 (not 500) for a body that is not an object", async () => {
    const cashier = await signedIn("cashier");
    const manager = await signedIn("manager");
    const discard = (cookie: string, body: string) => post(cookie, "/admin/pos/api/discard", body, (context, req) => apiAction({ request: req, context, params: { op: "discard" }, url: new URL(req.url), pattern: "admin/pos/api/:op" } as never));
    const refused = (await discard(cashier, JSON.stringify({ key: randomToken(18), reason: "بيع مكرر", sale: null }))) as Response;
    expect(refused.status).toBe(403);
    for (const body of ["null", "[]", "\"text\"", "7"]) {
      const answer = (await discard(manager, body)) as Response;
      expect(answer instanceof Response ? answer.status : 500).toBe(400);
    }
  });
});

// ───────────────────────────────────────────────────────────────── signed-in requests (route modules)

async function signedIn(key: DefaultRoleKey): Promise<string> {
  const password = "pos-review-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next(key)}@pos-review.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  const setCookies: string[] = [];
  const reqCtx: RequestCtx = {
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
  const result = await signInEmployee(reqCtx, t.db, { email, password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair = ""] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function post(cookie: string, path: string, body: string, run: (context: RouterContextProvider, req: Request) => Promise<unknown>): Promise<unknown> {
  const req = new Request(`http://localhost:5173${path}`, { method: "POST", headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" }, body });
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
}
