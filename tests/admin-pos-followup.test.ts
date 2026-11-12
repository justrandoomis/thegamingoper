/**
 * Admin module 06 "pos" — module follow-up (2026-11-12). The review's remaining blind-count risks, each test failed
 * on the code before the follow-up:
 *
 *   · a drop or pay-out larger than the drawer was refused `drawer_short` for the drawer's OWNER — a probe of the
 *     expected cash (try 500,000: refused; 400,000: accepted …). The owner's move is now recorded whatever the drawer
 *     holds; a supervisor (who sees the figures) still gets drawer_short
 *   · a late offline sale that brought a counted difference back to 0 took the shift out of review: nobody looked at
 *     it again. Now a late sale keeps it in review until a second person approves it (no posting at 0)
 *   · a supervisor who took over and counted someone else's drawer could see what it should hold (the shift report,
 *     the sales list) and close it with no difference that nobody reviews. A take-over count now always waits for a
 *     second person — never the counter
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, inventoryLocations, journalEntries, posShifts, stockLevels } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { saveRegister } from "~/server/services/admin/pos/registers.server";
import { createSale, type SaleRequestInput } from "~/server/services/admin/pos/sale.server";
import { closeShift, countReviewable, listShifts, moveCash, openShift, reviewShift, shiftReport } from "~/server/services/admin/pos/shifts.server";
import { parseShiftFilters, shiftReviewReasons, shiftStateOf } from "~/server/services/admin/pos/types";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const system = systemActor("test.admin-pos-followup");
const ctx = { locale: "ar" as const, storeMode: "live" as const };
let t: TestDb;
let make: Fixtures;
let storeId: string;
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["manager", "finance", "cashier"] as const) staff[key] = await employee(key);
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

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return (toAppError(error) ?? error) as AppError;
  }
  throw new Error("expected a failure");
}

async function shiftOf(who: EmployeeActor, float = 50_000): Promise<string> {
  const open = await t.db.select({ id: posShifts.id }).from(posShifts).where(and(eq(posShifts.openedBy, who.id), eq(posShifts.status, "open"))).get();
  if (open) await closeShift(t.db, who, { shiftId: open.id, countedCashIqd: 0 }, NOW);
  const register = await saveRegister(t.db, as("manager"), { code: `FU-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`, name: "Till", locationId: storeId, isActive: true }, NOW);
  return (await openShift(t.db, who, { registerId: register.registerId, openingFloatIqd: float, idempotencyKey: randomToken(16) }, NOW)).shiftId;
}

async function stocked(price: number) {
  const product = await make.product({ priceIqd: price });
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: storeId, qty: 5, unitCostIqd: Math.floor(price / 2), ref: "test" }, NOW);
  return product;
}
const sale = (shiftId: string, variantId: string, priceIqd: number, extra: Partial<SaleRequestInput> = {}): SaleRequestInput => ({
  idempotencyKey: randomToken(18),
  shiftId,
  customer: null,
  lines: [{ variantId, qty: 1, unitPriceIqd: priceIqd, discountIqd: 0, serials: [] }],
  payments: [{ method: "pos_cash", amountIqd: priceIqd }],
  ...extra,
});

describe("admin 06 pos — follow-up: the blind count", () => {
  test("the drawer's owner is never refused for an amount (no probe of the expected cash); a supervisor still is", async () => {
    const shiftId = await shiftOf(as("cashier"), 50_000);
    // the drawer is expected to hold 50,000: a 60,000 drop used to come back drawer_short — the probe
    expect(await moveCash(t.db, as("cashier"), { shiftId, kind: "drop", amountIqd: 60_000, reason: "إلى الخزنة", idempotencyKey: randomToken(16) }, NOW)).toEqual({ replayed: false });
    expect(await moveCash(t.db, as("cashier"), { shiftId, kind: "pay_out", amountIqd: 5_000_000, reason: "دفعة للمورد", idempotencyKey: randomToken(16) }, NOW)).toEqual({ replayed: false });
    // a supervisor taking the drawer over sees its figures, so the typo guard stays for them
    expect((await failureOf(moveCash(t.db, as("manager"), { shiftId, kind: "drop", amountIqd: 1_000, reason: "إلى الخزنة", idempotencyKey: randomToken(16) }, NOW))).code).toBe("drawer_short");
    // the owner's count then shows the difference, which a second person reviews
    expect(await closeShift(t.db, as("cashier"), { shiftId, countedCashIqd: 0 }, NOW)).toEqual({ needsReview: true, varianceIqd: null, replayed: false });
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).varianceIqd).toBe(5_010_000);
  });

  test("a late offline sale that brings the difference back to 0 keeps the shift in review; it is approved with no posting", async () => {
    const shiftId = await shiftOf(as("cashier"), 50_000);
    const item = await stocked(20_000);
    // the till sold 20,000 in cash offline; the count (70,000) is right, but the sale has not synced yet
    expect(await closeShift(t.db, as("cashier"), { shiftId, countedCashIqd: 70_000 }, NOW)).toEqual({ needsReview: true, varianceIqd: null, replayed: false });
    const late = await createSale(t.db, as("cashier"), sale(shiftId, item.variantId, 20_000, { offlineCreatedAt: NOW - 60_000 }), ctx, NOW + 5_000);
    expect(late.lateForClosedShift).toBe(true);
    const report = await shiftReport(t.db, as("finance"), shiftId, "ar");
    expect(report).toMatchObject({ varianceIqd: 0, state: "review", canReview: true, reviewReasons: ["late_sale"] });
    expect((await listShifts(t.db, as("finance"), parseShiftFilters(new URLSearchParams({ state: "review" })), "ar")).rows.map((row) => row.id)).toContain(shiftId);
    expect((await listShifts(t.db, as("finance"), parseShiftFilters(new URLSearchParams({ state: "closed" })), "ar")).rows.map((row) => row.id)).not.toContain(shiftId);
    const before = (await countReviewable(t.db, as("finance"))) ?? 0;
    expect(before).toBeGreaterThanOrEqual(1);
    // the owner never learns why (blind count): no reasons, no figures
    expect((await shiftReport(t.db, as("cashier"), shiftId, "ar")).reviewReasons).toBeNull();

    const approved = await reviewShift(t.db, as("finance"), { shiftId, expectedVarianceIqd: 0, note: "البيع المتأخر مطابق للجرد" }, NOW + 10_000);
    expect(approved).toEqual({ replayed: false, journalEntryId: null });
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `pos_shift:${shiftId}:variance`))).toHaveLength(0);
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).state).toBe("closed");
    expect(await countReviewable(t.db, as("finance"))).toBe(before - 1);
    // reviewed: no further late sale lands on it
    expect((await failureOf(createSale(t.db, as("cashier"), sale(shiftId, item.variantId, 20_000, { offlineCreatedAt: NOW - 30_000 }), ctx, NOW + 20_000))).code).toBe("pos_shift_reviewed");
  });

  test("a take-over count waits for a second person even with no difference — never the counter", async () => {
    const shiftId = await shiftOf(as("cashier"), 40_000);
    // the cashier left; a manager takes the drawer over and counts exactly what it should hold
    const closed = await closeShift(t.db, as("manager"), { shiftId, countedCashIqd: 40_000 }, NOW);
    expect(closed).toMatchObject({ needsReview: true, varianceIqd: 0 });
    const report = await shiftReport(t.db, as("finance"), shiftId, "ar");
    expect(report).toMatchObject({ state: "review", varianceIqd: 0, reviewReasons: ["taken_over"], canReview: true });
    const counter = await shiftReport(t.db, as("manager"), shiftId, "ar");
    expect(counter).toMatchObject({ canReview: false, reviewBlocked: "own_shift" });
    expect((await failureOf(reviewShift(t.db, as("manager"), { shiftId, expectedVarianceIqd: 0, note: "عددتها بنفسي" }, NOW))).code).toBe("shift_self_review");
    expect(await reviewShift(t.db, as("manager2"), { shiftId, expectedVarianceIqd: 0, note: "أعدت العد مع المدير" }, NOW)).toEqual({ replayed: false, journalEntryId: null });
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).state).toBe("closed");

    // the owner's own count with no difference closes as before
    const own = await shiftOf(as("cashier"), 10_000);
    expect(await closeShift(t.db, as("cashier"), { shiftId: own, countedCashIqd: 10_000 }, NOW)).toEqual({ needsReview: false, varianceIqd: null, replayed: false });
    expect((await failureOf(reviewShift(t.db, as("finance"), { shiftId: own, expectedVarianceIqd: 0, note: "لا شيء" }, NOW))).code).toBe("shift_not_in_review");
  });

  test("a scanned serial whose shelf has no free unit (all promised to web orders) never comes off another location's count", async () => {
    const shelfId = newId("loc");
    await t.db.insert(inventoryLocations).values({ id: shelfId, code: `SHELF-${randomToken(4)}`, name: "Shelf", kind: "bin", parentId: storeId, isSellable: true });
    const product = await make.product({ priceIqd: 300_000, trackSerials: true });
    const onShelf = `SN-${randomToken(6).toUpperCase()}`;
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: shelfId, qty: 1, unitCostIqd: 200_000, serials: [onShelf], ref: "test" }, NOW);
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: storeId, qty: 2, unitCostIqd: 200_000, serials: [`SN-${randomToken(6).toUpperCase()}`, `SN-${randomToken(6).toUpperCase()}`], ref: "test" }, NOW);
    // the shelf's one unit is promised to a web order
    await t.db.update(stockLevels).set({ reserved: 1 }).where(and(eq(stockLevels.variantId, product.variantId), eq(stockLevels.locationId, shelfId)));
    const levels = async () => new Map((await t.db.select({ locationId: stockLevels.locationId, onHand: stockLevels.onHand }).from(stockLevels).where(eq(stockLevels.variantId, product.variantId))).map((row) => [row.locationId, row.onHand]));
    const line = { variantId: product.variantId, qty: 1, unitPriceIqd: 300_000, discountIqd: 0, serials: [onShelf] };
    const shiftId = await shiftOf(as("manager"));
    // before: sold, and the store's count dropped — the shelf still counted the unit that left, the store missed one it has
    expect((await failureOf(createSale(t.db, as("manager"), { ...sale(shiftId, product.variantId, 300_000), lines: [line] }, ctx, NOW))).code).toBe("insufficient_stock");
    expect(await levels()).toEqual(new Map([[shelfId, 1], [storeId, 2]]));
    // an authorised oversell sells it FROM ITS SHELF (over-promised there, which the oversell report shows)
    await createSale(t.db, as("manager"), { ...sale(shiftId, product.variantId, 300_000), lines: [line], allowOversell: true, overrideReason: "الزبون أمامي والوحدة بيده" }, ctx, NOW);
    expect(await levels()).toEqual(new Map([[shelfId, 0], [storeId, 2]]));
  });

  test("the pure rule: reasons, and the state the till and the lists show", () => {
    const base = { status: "closed", varianceIqd: 0, approvedBy: null, openedBy: "a", closedBy: "a" };
    expect(shiftReviewReasons(base)).toEqual([]);
    expect(shiftStateOf(base)).toBe("closed");
    expect(shiftReviewReasons({ ...base, varianceIqd: -500, closedBy: "b", lateSales: true })).toEqual(["difference", "taken_over", "late_sale"]);
    expect(shiftStateOf({ ...base, closedBy: "b", approvedBy: "c" })).toBe("closed");
    expect(shiftStateOf({ ...base, status: "open", varianceIqd: null, closedBy: null })).toBe("open");
  });
});
