/**
 * Commerce-core file app/server/services/returns/receive.server.ts (added by admin 12 returns) on a real local D1:
 * goods of a delivered order coming back through a return (restock / quarantine / scrap) with the serial link
 * released (order_item_serials.released_at) and the books posted once; units leaving quarantine (back on sale, written
 * off, to the supplier) with FIFO layers, guarded levels and serial states; who may do what; and the refund link.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { costLayers, inventoryLocations, journalEntries, orderItemSerials, orderItems, payments, refunds, returns, serials, stockLevels, stockMovements, variantCosts } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { assignSerialsStatements, getAvailability, receiveStock } from "~/server/services/inventory/stock.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { recordCodCollection } from "~/server/services/payments/payments.server";
import { createRefund } from "~/server/services/refunds.server";
import { exitQuarantine, linkRefundStatements, returnGoodsStatements, translateReturnGoodsError, type ReturnGoodsTarget } from "~/server/services/returns/receive.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const system = systemActor("test.admin-returns-receive");

let t: TestDb;
let make: Fixtures;
let quarantineId: string;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  quarantineId = newId("loc");
  await t.db.insert(inventoryLocations).values({ id: quarantineId, code: `Q-${randomToken(4)}`, name: "Returns quarantine", kind: "warehouse", isSellable: false });
});
afterAll(async () => {
  await t?.dispose();
});

const role = (key: DefaultRoleKey): EmployeeActor => ({ kind: "employee", id: `emp_${key}`, permissions: defaultRolePermissions(key), label: key });
const custom = (permissions: Permission[]): EmployeeActor => ({ kind: "employee", id: "emp_custom", permissions: new Set(permissions) });

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

async function stocked(priceIqd: number, qty: number, unitCostIqd: number, options: { trackSerials?: boolean } = {}) {
  const product = await make.product({ priceIqd, trackSerials: options.trackSerials });
  const serialNumbers = options.trackSerials ? Array.from({ length: qty }, (_, i) => `RS-${product.sku}-${i + 1}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd, serials: serialNumbers, ref: `rcv-${product.sku}` }, NOW);
  await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: unitCostIqd, landedCostIqd: unitCostIqd, updatedAt: NOW }).onConflictDoNothing();
  return { ...product, serials: serialNumbers ?? [] };
}

/** A COD order taken all the way to delivery through the core (serials attached at packing). */
async function delivered(lines: { variantId: string; qty: number }[]) {
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId: null, locale: "ar" }, line, NOW)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId: null, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  const order = await placeOrder(
    t.db,
    { cartToken: token, customer: null, locale: "ar", ip: null, storeMode: "live" },
    { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة", addressText: "شارع 62، عمارة 4", marketingConsent: false, paymentMethod: "cod", expectedTotalIqd: view.totalIqd },
    NOW,
  );
  await transitionOrder(t.db, system, order.orderId, "confirmed", {}, NOW);
  await transitionOrder(t.db, system, order.orderId, "preparing", {}, NOW);
  const items = await t.db.select().from(orderItems).where(eq(orderItems.orderId, order.orderId));
  for (const item of items) {
    const free = await t.db.select({ id: serials.id }).from(serials).where(and(eq(serials.variantId, item.variantId), eq(serials.status, "in_stock"))).limit(item.qty);
    if (free.length) await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: item.id, serialIds: free.map((row) => row.id), actor: system, now: NOW }));
  }
  await transitionOrder(t.db, system, order.orderId, "shipped", {}, NOW);
  await recordCodCollection(t.db, system, order.orderId, order.totalIqd, NOW);
  await transitionOrder(t.db, system, order.orderId, "delivered", {}, NOW);
  return { ...order, items };
}

async function bring(orderId: string, line: { orderItemId: string; qty: number; serialIds?: string[] }, to: ReturnGoodsTarget, actor: EmployeeActor | ReturnType<typeof systemActor> = role("inventory")) {
  const key = `return_item:${newId("rti")}`;
  const goods = await returnGoodsStatements(t.db, { orderId, lines: [line], to, actor, now: NOW, key, refType: "return", refId: newId("ret"), reason: "RMA-TEST: inspected" });
  try {
    await runBatch(t.db, goods.statements);
  } catch (error) {
    throw translateReturnGoodsError(error);
  }
  return { goods, key };
}

const level = async (variantId: string, locationId: string) => (await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId))).get())?.onHand ?? 0;
const serialRow = async (id: string) => (await t.db.select().from(serials).where(eq(serials.id, id)).get())!;

describe("returned goods at inspection", () => {
  test("restock: the serial is released from its order line, back in stock and sellable again; the books are posted once", async () => {
    const console5 = await stocked(600_000, 2, 450_000, { trackSerials: true });
    const order = await delivered([{ variantId: console5.variantId, qty: 1 }]);
    const item = order.items[0];
    const link = await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, item.id)).get();
    expect(link?.releasedAt).toBeNull();
    const before = await level(console5.variantId, DEFAULT_LOCATION_ID);
    const { goods, key } = await bring(order.orderId, { orderItemId: item.id, qty: 1, serialIds: [link!.serialId] }, { kind: "restock" });
    expect(goods.units).toBe(1);
    expect(goods.restockedCostIqd).toBe(450_000);
    expect((await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, item.id)).get())?.releasedAt).toBe(NOW);
    expect((await serialRow(link!.serialId)).status).toBe("in_stock");
    expect(await level(console5.variantId, DEFAULT_LOCATION_ID)).toBe(before + 1);
    expect((await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `${key}:goods`)).all()).length).toBe(1);
    // the same unit can be sold again: a new order's packing attaches it (UNIQUE only while not released)
    const again = await delivered([{ variantId: console5.variantId, qty: 2 }]);
    const attached = await t.db.select().from(orderItemSerials).where(and(eq(orderItemSerials.orderItemId, again.items[0].id), isNull(orderItemSerials.releasedAt))).all();
    expect(attached.map((row) => row.serialId)).toContain(link!.serialId);
    // and the first return cannot be taken in twice
    expect(await failureOf(bring(order.orderId, { orderItemId: item.id, qty: 1, serialIds: [link!.serialId] }, { kind: "restock" }))).toMatchObject({ code: expect.stringMatching(/return_exceeds_shipped|invalid/) });
  });

  test("quarantine: only a NON-sellable location; the unit waits as 'returned', counts as stock but is never available or packable", async () => {
    const pad = await stocked(90_000, 2, 60_000, { trackSerials: true });
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const item = order.items[0];
    const serialId = (await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, item.id)).get())!.serialId;
    expect(await failureOf(bring(order.orderId, { orderItemId: item.id, qty: 1, serialIds: [serialId] }, { kind: "quarantine", locationId: DEFAULT_LOCATION_ID }))).toMatchObject({ code: "invalid", fields: { locationId: "location_not_quarantine" } });
    const availableBefore = (await getAvailability(t.db, [pad.variantId])).get(pad.variantId)?.available;
    await bring(order.orderId, { orderItemId: item.id, qty: 1, serialIds: [serialId] }, { kind: "quarantine", locationId: quarantineId });
    expect(await serialRow(serialId)).toMatchObject({ status: "returned", locationId: quarantineId });
    expect(await level(pad.variantId, quarantineId)).toBe(1);
    expect((await getAvailability(t.db, [pad.variantId])).get(pad.variantId)?.available).toBe(availableBefore);
    const layer = await t.db.select().from(costLayers).where(and(eq(costLayers.variantId, pad.variantId), eq(costLayers.locationId, quarantineId))).get();
    expect(layer).toMatchObject({ qtyRemaining: 1, unitCostIqd: 60_000, source: "return" });
    // the packing station cannot take a quarantined unit
    const fresh = await make.order([{ variantId: pad.variantId, sku: pad.sku, qty: 1 }]);
    await expect(runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: fresh.itemIds[0], serialIds: [serialId], actor: system, now: NOW }))).rejects.toThrow(/SERIAL_NOT_AVAILABLE/);
  });

  test("scrap: a 'return' + 'damage' pair, on hand unchanged, the serial written off, the cost to inventory adjustments", async () => {
    const cable = await stocked(25_000, 5, 10_000);
    const order = await delivered([{ variantId: cable.variantId, qty: 2 }]);
    const before = await level(cable.variantId, DEFAULT_LOCATION_ID);
    const { goods } = await bring(order.orderId, { orderItemId: order.items[0].id, qty: 1 }, { kind: "scrap" });
    expect(goods.scrappedCostIqd).toBe(10_000);
    expect(await level(cable.variantId, DEFAULT_LOCATION_ID)).toBe(before);
    const kinds = (await t.db.select({ kind: stockMovements.kind }).from(stockMovements).where(and(eq(stockMovements.refId, order.orderId), eq(stockMovements.variantId, cable.variantId))).all()).map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(["sale", "return", "damage"]));
  });

  test("only goods of a delivered order; only an inspector; never more than left", async () => {
    const game = await stocked(70_000, 5, 40_000);
    const order = await delivered([{ variantId: game.variantId, qty: 1 }]);
    expect(await failureOf(bring(order.orderId, { orderItemId: order.items[0].id, qty: 1 }, { kind: "restock" }, role("support")))).toMatchObject({ code: "forbidden", status: 403 });
    await bring(order.orderId, { orderItemId: order.items[0].id, qty: 1 }, { kind: "restock" });
    expect(await failureOf(bring(order.orderId, { orderItemId: order.items[0].id, qty: 1 }, { kind: "restock" }))).toMatchObject({ code: "return_exceeds_shipped" });
    const open = await make.order([{ variantId: game.variantId, sku: game.sku, qty: 1 }]);
    expect(await failureOf(bring(open.orderId, { orderItemId: open.itemIds[0], qty: 1 }, { kind: "restock" }))).toMatchObject({ code: "return_not_delivered" });
  });
});

describe("leaving quarantine", () => {
  async function quarantined(trackSerials: boolean) {
    const product = await stocked(150_000, 3, 100_000, { trackSerials });
    const order = await delivered([{ variantId: product.variantId, qty: 1 }]);
    const item = order.items[0];
    const serialId = trackSerials ? (await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, item.id)).get())!.serialId : undefined;
    await bring(order.orderId, { orderItemId: item.id, qty: 1, serialIds: serialId ? [serialId] : undefined }, { kind: "quarantine", locationId: quarantineId });
    return { product, serialId, refId: newId("rti") };
  }

  test("back on sale: transfer pair, the cost layer travels, the serial is in stock where it went, available again", async () => {
    const { product, serialId, refId } = await quarantined(true);
    const before = (await getAvailability(t.db, [product.variantId])).get(product.variantId)?.available ?? 0;
    await exitQuarantine(t.db, role("inventory"), { variantId: product.variantId, fromLocationId: quarantineId, qty: 1, serialIds: [serialId!], to: { kind: "stock", locationId: DEFAULT_LOCATION_ID }, refType: "return_item", refId, reason: "RMA-TEST: refurbished", key: `return_item:${refId}` }, NOW);
    expect(await serialRow(serialId!)).toMatchObject({ status: "in_stock", locationId: DEFAULT_LOCATION_ID });
    expect(await level(product.variantId, quarantineId)).toBe(0);
    expect((await getAvailability(t.db, [product.variantId])).get(product.variantId)?.available).toBe(before + 1);
    const moves = await t.db.select({ kind: stockMovements.kind, qty: stockMovements.qtyDelta, cost: stockMovements.unitCostIqd }).from(stockMovements).where(and(eq(stockMovements.refType, "return_item"), eq(stockMovements.refId, refId))).all();
    expect(moves).toEqual(expect.arrayContaining([{ kind: "transfer_out", qty: -1, cost: 100_000 }, { kind: "transfer_in", qty: 1, cost: 100_000 }]));
  });

  test("written off: needs inventory.stock.adjust as well; the loss is posted at the unit's cost", async () => {
    const { product, refId } = await quarantined(false);
    const input = { variantId: product.variantId, fromLocationId: quarantineId, qty: 1, to: { kind: "scrap" as const }, refType: "return_item", refId, reason: "RMA-TEST: beyond repair", key: `return_item:${refId}` };
    expect(await failureOf(exitQuarantine(t.db, custom(["returns.rma.inspect"]), input, NOW))).toMatchObject({ code: "forbidden" });
    await exitQuarantine(t.db, role("inventory"), input, NOW);
    const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `return_item:${refId}:exit`)).get();
    expect(entry).toBeTruthy();
    expect(await level(product.variantId, quarantineId)).toBe(0);
  });

  test("to the supplier: returns.supplier_return.manage; the serial is with the supplier ('in_repair', no location); a second exit is refused by the level guard", async () => {
    const { product, serialId, refId } = await quarantined(true);
    const input = { variantId: product.variantId, fromLocationId: quarantineId, qty: 1, serialIds: [serialId!], to: { kind: "supplier" as const, reference: "RTV-TEST1" }, refType: "return_item", refId, reason: "RMA-TEST: defective", key: `return_item:${refId}` };
    expect(await failureOf(exitQuarantine(t.db, role("inventory"), input, NOW))).toMatchObject({ code: "forbidden" });
    await exitQuarantine(t.db, role("manager"), input, NOW);
    expect(await serialRow(serialId!)).toMatchObject({ status: "in_repair", locationId: null });
    expect(await failureOf(exitQuarantine(t.db, role("manager"), { ...input, key: `return_item:${refId}:again` }, NOW))).toMatchObject({ code: expect.stringMatching(/insufficient_stock|invalid/) });
  });

  test("a sellable location is not a quarantine; serials must be the ones waiting there", async () => {
    const product = await stocked(50_000, 2, 30_000, { trackSerials: true });
    expect(await failureOf(exitQuarantine(t.db, role("manager"), { variantId: product.variantId, fromLocationId: DEFAULT_LOCATION_ID, qty: 1, serialIds: [newId("ser")], to: { kind: "scrap" }, refType: "return_item", refId: newId("rti"), reason: "x-test", key: `return_item:${newId("k")}` }, NOW))).toMatchObject({ code: "invalid" });
    const { serialId } = await quarantined(true);
    expect(await failureOf(exitQuarantine(t.db, role("manager"), { variantId: product.variantId, fromLocationId: quarantineId, qty: 1, serialIds: [serialId!], to: { kind: "scrap" }, refType: "return_item", refId: newId("rti"), reason: "wrong variant", key: `return_item:${newId("k")}` }, NOW))).toMatchObject({ code: "invalid", fields: { serialIds: "serial_not_in_quarantine" } });
  });
});

test("linkRefundStatements links an unlinked refund of the same order only", async () => {
  const cable = await stocked(30_000, 3, 12_000);
  const order = await delivered([{ variantId: cable.variantId, qty: 1 }]);
  const [payment] = await t.db.select().from(payments).where(eq(payments.orderId, order.orderId)).all();
  const refund = await createRefund(t.db, system, { orderId: order.orderId, paymentId: payment.id, amountIqd: 10_000, method: "cash", reason: "test link", idempotencyKey: `link-${randomToken(6)}` }, NOW);
  const returnId = newId("ret");
  await t.db.insert(returns).values({ id: returnId, rma: `RMA-${randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`, orderId: order.orderId, status: "inspected", createdAt: NOW, updatedAt: NOW });
  await runBatch(t.db, linkRefundStatements(t.db, { refundId: refund.refundId, returnId, orderId: "ord_other" }));
  expect((await t.db.select().from(refunds).where(eq(refunds.id, refund.refundId)).get())?.returnId).toBeNull();
  await runBatch(t.db, linkRefundStatements(t.db, { refundId: refund.refundId, returnId, orderId: order.orderId }));
  expect((await t.db.select().from(refunds).where(eq(refunds.id, refund.refundId)).get())?.returnId).toBe(returnId);
});
