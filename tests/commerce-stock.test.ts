/**
 * Commerce core, part 1 — stock: availability, reservations (shortage, races, bundles), release,
 * expiry, FIFO commit, adjustments, receipts, serials and used units; plus shipping fees and the
 * pure totals guard. Runs against a real local D1 (tests/helpers/db.ts) with the real triggers.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import {
  auditEvents,
  bundleItems,
  costLayers,
  inventoryLocations,
  orderItemSerials,
  serials,
  settings,
  shippingRates,
  stockLevels,
  stockMovements,
  stockReservations,
  usedUnits,
  variantCosts,
  governorates,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, IRAQ_GOVERNORATES, governorateId } from "~/server/db/seed/reference";
import { mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, isAppError, toAppError } from "~/server/errors";
import { costOfSlices, takeFifo } from "~/server/services/inventory/fifo";
import {
  adjustStock,
  assignSerialsStatements,
  commitOrderReservations,
  expireReservations,
  getAvailability,
  receiveStock,
  releaseOrderReservations,
  releaseUsedUnitStatements,
  reserveStatements,
  reserveUsedUnitStatements,
  stockStateOf,
} from "~/server/services/inventory/stock.server";
import { TotalsError, computeTotals } from "~/server/services/orders/totals";
import { getShippingFee, listDistricts, listGovernorates } from "~/server/services/shipping/fees.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MINUTE = 60_000;

let t: TestDb;
let make: Fixtures;

const SYSTEM = systemActor("test");
const employee = (...permissions: string[]): EmployeeActor => ({ kind: "employee", id: newId("emp"), permissions, label: "Stock tester" });

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t.dispose();
});

/** Stock level of a variant at a location (main location by default). */
async function level(variantId: string, locationId = DEFAULT_LOCATION_ID) {
  return t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId))).get();
}

async function addLocation(options: { sellable?: boolean; active?: boolean; sort?: number } = {}) {
  const id = newId("loc");
  await t.db.insert(inventoryLocations).values({ id, code: make.next("LOC"), name: "Test shelf", kind: "warehouse", isSellable: options.sellable ?? true, isActive: options.active ?? true, sort: options.sort ?? 50 });
  return id;
}

async function putStock(variantId: string, locationId: string, onHand: number, extra: Partial<typeof stockLevels.$inferInsert> = {}) {
  await t.db
    .insert(stockLevels)
    .values({ variantId, locationId, onHand, ...extra })
    .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { onHand, ...extra } });
}

/** Runs a batch and returns the AppError it failed with. */
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

async function newOrder(variantId: string, sku: string, qty = 1) {
  return make.order([{ variantId, sku, qty }]);
}

// ───────────────────────────────────────────────────────────────── pure helpers

describe("pure helpers", () => {
  test("stock states", () => {
    expect(stockStateOf(0)).toBe("out_of_stock");
    expect(stockStateOf(-2)).toBe("out_of_stock");
    expect(stockStateOf(3)).toBe("low_stock");
    expect(stockStateOf(4)).toBe("in_stock");
    expect(stockStateOf(5, 5)).toBe("low_stock");
    expect(stockStateOf(1, 0)).toBe("in_stock");
  });

  test("FIFO takes the oldest layer first and falls back to the standard cost", () => {
    const layers = [
      { id: "a", qtyRemaining: 2, unitCostIqd: 100 },
      { id: "b", qtyRemaining: 3, unitCostIqd: 120 },
    ];
    const first = takeFifo(layers, 3, 150);
    expect(first).toEqual([
      { layerId: "a", qty: 2, unitCostIqd: 100, fallback: false },
      { layerId: "b", qty: 1, unitCostIqd: 120, fallback: false },
    ]);
    expect(costOfSlices(first)).toBe(320);
    const second = takeFifo(layers, 4, 150);
    expect(second).toEqual([
      { layerId: "b", qty: 2, unitCostIqd: 120, fallback: false },
      { layerId: null, qty: 2, unitCostIqd: 150, fallback: true },
    ]);
    expect(costOfSlices(takeFifo([], 1, null))).toBeNull();
  });

  test("totals are integer arithmetic and refuse anything else", () => {
    expect(computeTotals({ lines: [{ unitPriceIqd: 749_000, qty: 1 }, { unitPriceIqd: 30_000, qty: 2 }], discountIqd: 25_000, shippingIqd: 5_000 })).toEqual({
      subtotalIqd: 809_000,
      discountIqd: 25_000,
      shippingIqd: 5_000,
      totalIqd: 789_000,
    });
    expect(computeTotals({ lines: [], discountIqd: 0, shippingIqd: 0 })).toEqual({ subtotalIqd: 0, discountIqd: 0, shippingIqd: 0, totalIqd: 0 });
    const bad = [
      { lines: [{ unitPriceIqd: Number.NaN, qty: 1 }], discountIqd: 0, shippingIqd: 0 },
      { lines: [{ unitPriceIqd: 1000, qty: 1.5 }], discountIqd: 0, shippingIqd: 0 },
      { lines: [{ unitPriceIqd: 1000, qty: 0 }], discountIqd: 0, shippingIqd: 0 },
      { lines: [{ unitPriceIqd: -1, qty: 1 }], discountIqd: 0, shippingIqd: 0 },
      { lines: [{ unitPriceIqd: 1000.5, qty: 1 }], discountIqd: 0, shippingIqd: 0 },
      { lines: [{ unitPriceIqd: Number.POSITIVE_INFINITY, qty: 1 }], discountIqd: 0, shippingIqd: 0 },
      { lines: [{ unitPriceIqd: 1000, qty: 1 }], discountIqd: -5, shippingIqd: 0 },
      { lines: [{ unitPriceIqd: 1000, qty: 1 }], discountIqd: 1001, shippingIqd: 0 },
      { lines: [{ unitPriceIqd: 1000, qty: 1 }], discountIqd: 0, shippingIqd: Number.NaN },
      { lines: [{ unitPriceIqd: Number.MAX_SAFE_INTEGER, qty: 2 }], discountIqd: 0, shippingIqd: 0 },
    ];
    for (const input of bad) expect(() => computeTotals(input)).toThrow(TotalsError);
  });
});

// ───────────────────────────────────────────────────────────────── availability

describe("availability", () => {
  test("sums free units over sellable, active locations and reports a state", async () => {
    const p = await make.product({ stock: 5 });
    const shelf = await addLocation();
    const backroom = await addLocation({ sellable: false });
    const closed = await addLocation({ active: false });
    await putStock(p.variantId, shelf, 4, { reserved: 1 });
    await putStock(p.variantId, backroom, 50);
    await putStock(p.variantId, closed, 50);
    const map = await getAvailability(t.db, [p.variantId, p.variantId, "var_does_not_exist"]);
    expect(map.get(p.variantId)).toEqual({ available: 8, state: "in_stock" });
    expect(map.get("var_does_not_exist")).toEqual({ available: 0, state: "out_of_stock" });
    expect((await getAvailability(t.db, [])).size).toBe(0);
  });

  test("low stock uses the reorder point, or 3 when none is set", async () => {
    const a = await make.product({ stock: 3 });
    const b = await make.product({ stock: 6 });
    await t.db.update(stockLevels).set({ reorderPoint: 6 }).where(eq(stockLevels.variantId, b.variantId));
    const c = await make.product({ stock: 0 });
    const map = await getAvailability(t.db, [a.variantId, b.variantId, c.variantId]);
    expect(map.get(a.variantId)?.state).toBe("low_stock");
    expect(map.get(b.variantId)?.state).toBe("low_stock");
    expect(map.get(c.variantId)?.state).toBe("out_of_stock");
  });

  test("an oversold location does not eat into another location's free units", async () => {
    const p = await make.product({ stock: 0 });
    const other = await addLocation();
    await putStock(p.variantId, DEFAULT_LOCATION_ID, 1, { reserved: 3, allowOversell: true });
    await putStock(p.variantId, other, 2);
    expect((await getAvailability(t.db, [p.variantId])).get(p.variantId)).toEqual({ available: 2, state: "low_stock" });
  });

  test("a bundle offers as many complete sets as its components allow", async () => {
    const consoleItem = await make.product({ stock: 5 });
    const game = await make.product({ kind: "game", stock: 2 });
    const bundle = await make.product({ stock: 0 });
    await t.db.insert(bundleItems).values([
      { bundleVariantId: bundle.variantId, componentVariantId: consoleItem.variantId, qty: 1 },
      { bundleVariantId: bundle.variantId, componentVariantId: game.variantId, qty: 2 },
    ]);
    expect((await getAvailability(t.db, [bundle.variantId])).get(bundle.variantId)).toEqual({ available: 1, state: "low_stock" });
  });
});

// ───────────────────────────────────────────────────────────────── reservations

describe("reservations", () => {
  test("reserve writes reservation rows, reserved counters and movements in the caller's batch", async () => {
    const p = await make.product({ stock: 5 });
    const order = await newOrder(p.variantId, p.sku, 2);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: p.variantId, qty: 2 }], expiresAt: NOW + 30 * MINUTE, actor: SYSTEM, now: NOW }));
    expect(await level(p.variantId)).toMatchObject({ onHand: 5, reserved: 2 });
    const rows = await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order.orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, status: "active", expiresAt: NOW + 30 * MINUTE, createdAt: NOW });
    const moves = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, order.orderId), eq(stockMovements.kind, "reserve")));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ qtyDelta: 0, reservedDelta: 2, refType: "order", actorKind: "system", actorId: "test" });
    expect((await getAvailability(t.db, [p.variantId])).get(p.variantId)?.available).toBe(3);
    expect(reserveStatements(t.db, { orderId: order.orderId, lines: [], expiresAt: null, actor: SYSTEM, now: NOW })).toEqual([]);
  });

  test("a line larger than one location is spread over several, most free first", async () => {
    const p = await make.product({ stock: 2 });
    const second = await addLocation({ sort: 1 });
    await putStock(p.variantId, second, 3);
    const order = await newOrder(p.variantId, p.sku, 4);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: p.variantId, qty: 4 }], expiresAt: null, actor: SYSTEM, now: NOW }));
    expect((await level(p.variantId, second))?.reserved).toBe(3);
    expect((await level(p.variantId))?.reserved).toBe(1);
    const rows = await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order.orderId));
    expect(rows.map((row) => row.qty).sort()).toEqual([1, 3]);
  });

  test("a shortage rolls back the whole batch and reads as insufficient_stock with the variant", async () => {
    const plenty = await make.product({ stock: 10 });
    const scarce = await make.product({ stock: 1 });
    const order = await make.order([
      { variantId: plenty.variantId, sku: plenty.sku, qty: 2 },
      { variantId: scarce.variantId, sku: scarce.sku, qty: 2 },
    ]);
    const marker = newId("aud");
    const failure = await failureOf(
      runBatch(t.db, [
        t.db.insert(auditEvents).values({ id: marker, at: NOW, actorKind: "system", action: "test.batch.marker" }),
        ...reserveStatements(t.db, {
          orderId: order.orderId,
          lines: [
            { variantId: plenty.variantId, qty: 2 },
            { variantId: scarce.variantId, qty: 2 },
          ],
          expiresAt: null,
          actor: SYSTEM,
          now: NOW,
        }),
      ]),
    );
    expect(failure).toMatchObject({ code: "insufficient_stock", status: 409, detail: scarce.variantId });
    expect(await level(plenty.variantId)).toMatchObject({ onHand: 10, reserved: 0 });
    expect(await level(scarce.variantId)).toMatchObject({ onHand: 1, reserved: 0 });
    expect(await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order.orderId))).toHaveLength(0);
    expect(await t.db.select().from(stockMovements).where(eq(stockMovements.refId, order.orderId))).toHaveLength(0);
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.id, marker))).toHaveLength(0);
  });

  test("the stock trigger is the backstop: a direct over-reservation fails the same way", async () => {
    const p = await make.product({ stock: 1 });
    const error = await t.db
      .update(stockLevels)
      .set({ reserved: 2 })
      .where(eq(stockLevels.variantId, p.variantId))
      .then(() => null, (caught: unknown) => caught);
    expect(mapDbError(error)).toMatchObject({ code: "INSUFFICIENT_STOCK", detail: p.variantId });
    expect(toAppError(error)).toMatchObject({ code: "insufficient_stock", status: 409, detail: p.variantId });
  });

  test("two orders racing for the last unit: exactly one wins", async () => {
    const p = await make.product({ stock: 1 });
    const a = await newOrder(p.variantId, p.sku);
    const b = await newOrder(p.variantId, p.sku);
    const attempt = (orderId: string) => runBatch(t.db, reserveStatements(t.db, { orderId, lines: [{ variantId: p.variantId, qty: 1 }], expiresAt: null, actor: SYSTEM, now: NOW }));
    const results = await Promise.allSettled([attempt(a.orderId), attempt(b.orderId)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(toAppError(rejected?.reason)).toMatchObject({ code: "insufficient_stock", detail: p.variantId });
    expect(await level(p.variantId)).toMatchObject({ onHand: 1, reserved: 1 });
    expect(await t.db.select().from(stockReservations).where(eq(stockReservations.variantId, p.variantId))).toHaveLength(1);
  });

  test("a bundle line reserves its components, and a missing component names the bundle", async () => {
    const consoleItem = await make.product({ stock: 2 });
    const game = await make.product({ kind: "game", stock: 1 });
    const bundle = await make.product({ stock: 0 });
    await t.db.insert(bundleItems).values([
      { bundleVariantId: bundle.variantId, componentVariantId: consoleItem.variantId, qty: 1 },
      { bundleVariantId: bundle.variantId, componentVariantId: game.variantId, qty: 1 },
    ]);
    const order = await newOrder(bundle.variantId, bundle.sku);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: bundle.variantId, qty: 1 }], expiresAt: null, actor: SYSTEM, now: NOW }));
    expect((await level(consoleItem.variantId))?.reserved).toBe(1);
    expect((await level(game.variantId))?.reserved).toBe(1);
    expect((await level(bundle.variantId))?.reserved).toBe(0);
    // The game is gone now: a second bundle cannot be reserved, even though one console is left.
    const second = await newOrder(bundle.variantId, bundle.sku);
    const failure = await failureOf(runBatch(t.db, reserveStatements(t.db, { orderId: second.orderId, lines: [{ variantId: bundle.variantId, qty: 1 }], expiresAt: null, actor: SYSTEM, now: NOW })));
    expect(failure).toMatchObject({ code: "insufficient_stock", detail: bundle.variantId });
    expect((await level(consoleItem.variantId))?.reserved).toBe(1);
  });

  test("release returns the units, records movements, and is harmless twice", async () => {
    const p = await make.product({ stock: 4 });
    const order = await newOrder(p.variantId, p.sku, 3);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: p.variantId, qty: 3 }], expiresAt: NOW + MINUTE, actor: SYSTEM, now: NOW }));
    const staff = employee("orders.order.cancel");
    expect(await releaseOrderReservations(t.db, staff, order.orderId, "cancelled by the customer", NOW + 1)).toEqual({ released: 1 });
    expect(await level(p.variantId)).toMatchObject({ onHand: 4, reserved: 0 });
    const [row] = await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order.orderId));
    expect(row).toMatchObject({ status: "released", releasedAt: NOW + 1 });
    const releases = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, order.orderId), eq(stockMovements.kind, "release")));
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ reservedDelta: -3, qtyDelta: 0, reason: "cancelled by the customer", actorKind: "employee", actorId: staff.id });
    expect(await releaseOrderReservations(t.db, staff, order.orderId, "again", NOW + 2)).toEqual({ released: 0 });
    expect(await level(p.variantId)).toMatchObject({ onHand: 4, reserved: 0 });
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, order.orderId), eq(auditEvents.action, "inventory.reservation.release")));
    expect(audit.length).toBe(2);
    await expect(releaseOrderReservations(t.db, staff, order.orderId, "  ", NOW)).rejects.toMatchObject({ code: "invalid" });
  });

  test("expiry releases only reservations whose time has passed", async () => {
    const p = await make.product({ stock: 10 });
    const due = await newOrder(p.variantId, p.sku, 2);
    const later = await newOrder(p.variantId, p.sku, 3);
    const held = await newOrder(p.variantId, p.sku, 1);
    const reserve = (orderId: string, qty: number, expiresAt: number | null) =>
      runBatch(t.db, reserveStatements(t.db, { orderId, lines: [{ variantId: p.variantId, qty }], expiresAt, actor: SYSTEM, now: NOW }));
    await reserve(due.orderId, 2, NOW + 10 * MINUTE);
    await reserve(later.orderId, 3, NOW + 60 * MINUTE);
    await reserve(held.orderId, 1, null);
    expect((await level(p.variantId))?.reserved).toBe(6);

    const first = await expireReservations(t.db, NOW + 30 * MINUTE);
    expect(first.released).toBeGreaterThanOrEqual(1);
    expect((await level(p.variantId))?.reserved).toBe(4);
    const statusOf = async (orderId: string) => (await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, orderId)))[0]?.status;
    expect(await statusOf(due.orderId)).toBe("expired");
    expect(await statusOf(later.orderId)).toBe("active");
    expect(await statusOf(held.orderId)).toBe("active");

    await expireReservations(t.db, NOW + 61 * MINUTE);
    expect(await statusOf(later.orderId)).toBe("expired");
    expect(await statusOf(held.orderId)).toBe("active");
    expect((await level(p.variantId))?.reserved).toBe(1);
    expect(await expireReservations(t.db, NOW + 61 * MINUTE)).toEqual({ released: 0 });
  });
});

// ───────────────────────────────────────────────────────────────── commit (FIFO)

describe("commit on shipment", () => {
  test("consumes the oldest cost layers first and records the cost on 'sale' movements", async () => {
    const p = await make.product({ stock: 5 });
    await t.db.insert(costLayers).values([
      { id: newId("cly"), variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, qtyRemaining: 2, qtyReceived: 2, unitCostIqd: 100_000, receivedAt: NOW - 2 * MINUTE, source: "purchase" },
      { id: newId("cly"), variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, qtyRemaining: 3, qtyReceived: 3, unitCostIqd: 120_000, receivedAt: NOW - MINUTE, source: "purchase" },
    ]);
    const order = await newOrder(p.variantId, p.sku, 3);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: p.variantId, qty: 3 }], expiresAt: null, actor: SYSTEM, now: NOW }));
    const staff = employee("orders.fulfillment.ship");
    const result = await commitOrderReservations(t.db, staff, order.orderId, NOW + 5);
    expect(result).toEqual({ reservations: 1, units: 3, usedUnits: 0, cogsIqd: 320_000, unitsWithoutLayer: 0 });
    expect(await level(p.variantId)).toMatchObject({ onHand: 2, reserved: 0 });
    const layers = await t.db.select().from(costLayers).where(eq(costLayers.variantId, p.variantId)).orderBy(costLayers.receivedAt);
    expect(layers.map((layer) => layer.qtyRemaining)).toEqual([0, 2]);
    const sales = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, order.orderId), eq(stockMovements.kind, "sale")));
    expect(sales.map((move) => [move.qtyDelta, move.reservedDelta, move.unitCostIqd]).sort()).toEqual(
      [
        [-1, -1, 120_000],
        [-2, -2, 100_000],
      ].sort(),
    );
    const [row] = await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order.orderId));
    expect(row.status).toBe("committed");
    // A second commit has nothing left to do.
    expect(await commitOrderReservations(t.db, staff, order.orderId, NOW + 6)).toEqual({ reservations: 0, units: 0, usedUnits: 0, cogsIqd: 0, unitsWithoutLayer: 0 });
    expect(await level(p.variantId)).toMatchObject({ onHand: 2, reserved: 0 });
  });

  test("units without a cost layer take the standard cost, or stay uncosted", async () => {
    const costed = await make.product({ stock: 2 });
    await t.db.insert(variantCosts).values({ variantId: costed.variantId, unitCostMinor: 1, landedCostIqd: 90_000, updatedAt: NOW });
    const uncosted = await make.product({ stock: 1 });
    const order = await make.order([
      { variantId: costed.variantId, sku: costed.sku, qty: 2 },
      { variantId: uncosted.variantId, sku: uncosted.sku, qty: 1 },
    ]);
    await runBatch(
      t.db,
      reserveStatements(t.db, {
        orderId: order.orderId,
        lines: [
          { variantId: costed.variantId, qty: 2 },
          { variantId: uncosted.variantId, qty: 1 },
        ],
        expiresAt: null,
        actor: SYSTEM,
        now: NOW,
      }),
    );
    const result = await commitOrderReservations(t.db, SYSTEM, order.orderId, NOW);
    expect(result).toMatchObject({ reservations: 2, units: 3, cogsIqd: null, unitsWithoutLayer: 3 });
    const sale = await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, costed.variantId), eq(stockMovements.kind, "sale")));
    expect(sale[0]).toMatchObject({ unitCostIqd: 90_000, reason: "no_cost_layer_standard_cost" });
  });
});

// ───────────────────────────────────────────────────────────────── adjustments and receipts

describe("adjustments and receipts", () => {
  test("adjusting needs the permission, keeps on_hand ≥ 0, and is audited", async () => {
    const p = await make.product({ stock: 3 });
    const clerk = employee("inventory.stock.adjust");
    await expect(adjustStock(t.db, employee("inventory.stock.read"), { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: -1, reason: "تالف في المخزن" }, NOW)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(adjustStock(t.db, clerk, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: -1, reason: "x" }, NOW)).rejects.toMatchObject({ name: "ZodError" });
    expect(await failureOf(adjustStock(t.db, clerk, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: -4, reason: "جرد" }, NOW))).toMatchObject({ code: "insufficient_stock", status: 409 });

    await adjustStock(t.db, clerk, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: 2, reason: "وجدنا وحدتين في الجرد" }, NOW);
    await adjustStock(t.db, clerk, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: -1, reason: "علبة مكسورة", kind: "damage" }, NOW);
    expect(await level(p.variantId)).toMatchObject({ onHand: 4, reserved: 0 });
    const moves = await t.db.select().from(stockMovements).where(eq(stockMovements.variantId, p.variantId));
    expect(moves.map((move) => [move.kind, move.qtyDelta]).sort()).toEqual([
      ["adjust", 2],
      ["damage", -1],
    ]);
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, p.variantId));
    expect(audit.map((row) => row.action).sort()).toEqual(["inventory.stock.adjust", "inventory.stock.damage"]);
    expect(audit.find((row) => row.action === "inventory.stock.damage")).toMatchObject({ reason: "علبة مكسورة", actorId: clerk.id });
  });

  test("taking stock below what orders hold is an oversell: explicit flag and permission", async () => {
    const p = await make.product({ stock: 2 });
    const order = await newOrder(p.variantId, p.sku, 2);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: p.variantId, qty: 2 }], expiresAt: null, actor: SYSTEM, now: NOW }));
    const clerk = employee("inventory.stock.adjust");
    const input = { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: -1, reason: "وحدة تالفة رغم الحجز", kind: "damage" as const };
    expect(await failureOf(adjustStock(t.db, clerk, input, NOW))).toMatchObject({ code: "insufficient_stock" });
    expect(await failureOf(adjustStock(t.db, clerk, { ...input, allowOversell: true }, NOW))).toMatchObject({ code: "forbidden", detail: "inventory.oversell.authorize" });
    await adjustStock(t.db, employee("inventory.stock.adjust", "inventory.oversell.authorize"), { ...input, allowOversell: true }, NOW);
    expect(await level(p.variantId)).toMatchObject({ onHand: 1, reserved: 2, allowOversell: true });
    expect((await getAvailability(t.db, [p.variantId])).get(p.variantId)).toEqual({ available: 0, state: "out_of_stock" });
    // The flag left on the level does not let a later removal skip the authorization…
    expect(await failureOf(adjustStock(t.db, clerk, { ...input, delta: -1 }, NOW))).toMatchObject({ code: "insufficient_stock" });
    // …while adding units to an oversold level needs nothing special.
    await adjustStock(t.db, clerk, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: 3, reason: "وصلت شحنة" }, NOW);
    expect(await level(p.variantId)).toMatchObject({ onHand: 4, reserved: 2 });
    expect((await getAvailability(t.db, [p.variantId])).get(p.variantId)?.available).toBe(2);
  });

  test("removed units leave the oldest cost layer; serial-tracked variants are refused", async () => {
    const p = await make.product({ stock: 0 });
    const receiver = employee("inventory.stock.receive", "inventory.stock.adjust");
    await receiveStock(t.db, receiver, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, unitCostIqd: 50_000, ref: "PO-1" }, NOW - 2);
    await receiveStock(t.db, receiver, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, unitCostIqd: 70_000, ref: { type: "transfer", id: "TR-9" } }, NOW - 1);
    await adjustStock(t.db, receiver, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: -3, reason: "تلف بالماء", kind: "damage" }, NOW);
    const layers = await t.db.select().from(costLayers).where(eq(costLayers.variantId, p.variantId)).orderBy(costLayers.receivedAt);
    expect(layers.map((layer) => layer.qtyRemaining)).toEqual([0, 1]);
    const damage = await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, p.variantId), eq(stockMovements.kind, "damage")));
    expect(damage.map((move) => [move.qtyDelta, move.unitCostIqd]).sort()).toEqual(
      [
        [-1, 70_000],
        [-2, 50_000],
      ].sort(),
    );
    const tracked = await make.product({ trackSerials: true, stock: 1 });
    expect(await failureOf(adjustStock(t.db, receiver, { variantId: tracked.variantId, locationId: DEFAULT_LOCATION_ID, delta: -1, reason: "تالف" }, NOW))).toMatchObject({ code: "serial_tracked" });
  });

  test("receiving creates the level, a cost layer, serials and movements", async () => {
    const tracked = await make.product({ trackSerials: true });
    const receiver = employee("inventory.stock.receive");
    await expect(receiveStock(t.db, employee("inventory.stock.read"), { variantId: tracked.variantId, locationId: DEFAULT_LOCATION_ID, qty: 1, unitCostIqd: 1, ref: "x" }, NOW)).rejects.toMatchObject({ code: "forbidden" });
    expect(await failureOf(receiveStock(t.db, receiver, { variantId: tracked.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, unitCostIqd: 400_000, ref: "PO-7" }, NOW))).toMatchObject({ code: "invalid", fields: { serials: "serials_required" } });
    expect(await failureOf(receiveStock(t.db, receiver, { variantId: tracked.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, unitCostIqd: 400_000, serials: ["A1"], ref: "PO-7" }, NOW))).toMatchObject({ fields: { serials: "serials_count" } });
    const sn = [make.next("SN"), make.next("SN")];
    await receiveStock(t.db, receiver, { variantId: tracked.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, unitCostIqd: 400_000, serials: sn, ref: { type: "receipt", id: "GRN-1" } }, NOW);
    expect(await level(tracked.variantId)).toMatchObject({ onHand: 2, reserved: 0 });
    const rows = await t.db.select().from(serials).where(eq(serials.variantId, tracked.variantId));
    expect(rows.map((row) => row.serial).sort()).toEqual([...sn].sort());
    expect(rows.every((row) => row.status === "in_stock" && row.costIqd === 400_000)).toBe(true);
    const receives = await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, tracked.variantId), eq(stockMovements.kind, "receive")));
    expect(receives).toHaveLength(2);
    expect(receives.every((move) => move.qtyDelta === 1 && move.serialId !== null && move.refId === "GRN-1")).toBe(true);
    // The same serial number cannot be received twice.
    expect(await failureOf(receiveStock(t.db, receiver, { variantId: tracked.variantId, locationId: DEFAULT_LOCATION_ID, qty: 1, unitCostIqd: 400_000, serials: [sn[0]], ref: "GRN-2" }, NOW))).toMatchObject({ code: "serial_duplicate", status: 409 });
    expect((await level(tracked.variantId))?.onHand).toBe(2);
    const plain = await make.product();
    expect(await failureOf(receiveStock(t.db, receiver, { variantId: plain.variantId, locationId: DEFAULT_LOCATION_ID, qty: 1, unitCostIqd: 1, serials: ["Z"], ref: "x" }, NOW))).toMatchObject({ fields: { serials: "serials_not_tracked" } });
  });
});

// ───────────────────────────────────────────────────────────────── serials and used units

describe("serials and used units", () => {
  async function serialFor(variantId: string, status: "in_stock" | "sold" = "in_stock") {
    const id = newId("ser");
    await t.db.insert(serials).values({ id, serial: make.next("SER"), variantId, status, locationId: DEFAULT_LOCATION_ID, createdAt: NOW, updatedAt: NOW });
    return id;
  }

  test("a serial can be sold once", async () => {
    const p = await make.product({ trackSerials: true, stock: 2 });
    const serialId = await serialFor(p.variantId);
    const first = await newOrder(p.variantId, p.sku);
    const second = await newOrder(p.variantId, p.sku);
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: first.itemIds[0], serialIds: [serialId], actor: SYSTEM, now: NOW }));
    expect((await t.db.select().from(serials).where(eq(serials.id, serialId)).get())?.status).toBe("sold");
    const failure = await failureOf(runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: second.itemIds[0], serialIds: [serialId], actor: SYSTEM, now: NOW })));
    expect(failure).toMatchObject({ code: "serial_not_available", detail: serialId });
    expect(await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.serialId, serialId))).toHaveLength(1);
  });

  test("a serial of another variant, or more serials than units, is refused", async () => {
    const p = await make.product({ trackSerials: true, stock: 2 });
    const other = await make.product({ trackSerials: true, stock: 1 });
    const order = await newOrder(p.variantId, p.sku, 1);
    const foreign = await serialFor(other.variantId);
    expect(await failureOf(runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: order.itemIds[0], serialIds: [foreign], actor: SYSTEM, now: NOW })))).toMatchObject({ code: "serial_not_available" });
    const [a, b] = [await serialFor(p.variantId), await serialFor(p.variantId)];
    expect(await failureOf(runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: order.itemIds[0], serialIds: [a, b], actor: SYSTEM, now: NOW })))).toMatchObject({ code: "serial_count_exceeds_qty" });
    expect((await t.db.select().from(serials).where(eq(serials.id, a)).get())?.status).toBe("in_stock");
  });

  test("a used unit is reserved once, released back to sale, and sold on commit", async () => {
    const p = await make.product({ trackSerials: true });
    const serialId = await serialFor(p.variantId);
    const unitId = newId("usd");
    await t.db.insert(usedUnits).values({ id: unitId, slug: make.next("used"), variantId: p.variantId, serialId, grade: "A", priceIqd: 400_000, acquisitionCostIqd: 300_000, status: "listed", isDemo: true, createdAt: NOW, updatedAt: NOW });
    const order = await make.order([{ variantId: p.variantId, sku: p.sku, usedUnitId: unitId, unitPriceIqd: 400_000 }]);
    await runBatch(t.db, reserveUsedUnitStatements(t.db, { usedUnitId: unitId, orderId: order.orderId, now: NOW }));
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("reserved");
    expect((await t.db.select().from(serials).where(eq(serials.id, serialId)).get())?.status).toBe("reserved");
    const other = await make.order([{ variantId: p.variantId, sku: p.sku, usedUnitId: unitId, unitPriceIqd: 400_000 }]);
    expect(await failureOf(runBatch(t.db, reserveUsedUnitStatements(t.db, { usedUnitId: unitId, orderId: other.orderId, now: NOW })))).toMatchObject({ code: "used_unit_not_available", detail: unitId });

    // The other order holds nothing; releasing it must not free the unit reserved by the first one.
    await releaseOrderReservations(t.db, SYSTEM, other.orderId, "cancelled", NOW);
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("reserved");

    await runBatch(t.db, releaseUsedUnitStatements(t.db, { usedUnitId: unitId, now: NOW }));
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("listed");
    expect((await t.db.select().from(serials).where(eq(serials.id, serialId)).get())?.status).toBe("in_stock");

    const buyer = await make.order([{ variantId: p.variantId, sku: p.sku, usedUnitId: unitId, unitPriceIqd: 400_000 }]);
    await runBatch(t.db, reserveUsedUnitStatements(t.db, { usedUnitId: unitId, orderId: buyer.orderId, now: NOW }));
    const result = await commitOrderReservations(t.db, SYSTEM, buyer.orderId, NOW + 1);
    expect(result).toEqual({ reservations: 0, units: 0, usedUnits: 1, cogsIqd: 300_000, unitsWithoutLayer: 0 });
    expect(await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get()).toMatchObject({ status: "sold", soldOrderItemId: buyer.itemIds[0], soldAt: NOW + 1 });
    expect((await t.db.select().from(serials).where(eq(serials.id, serialId)).get())?.status).toBe("sold");
    expect(await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.serialId, serialId))).toEqual([expect.objectContaining({ orderItemId: buyer.itemIds[0] })]);
  });

  test("cancelling an order puts its used unit back on sale", async () => {
    const p = await make.product({ trackSerials: true });
    const unitId = newId("usd");
    await t.db.insert(usedUnits).values({ id: unitId, slug: make.next("used"), variantId: p.variantId, grade: "B", priceIqd: 250_000, status: "listed", isDemo: true, createdAt: NOW, updatedAt: NOW });
    const order = await make.order([{ variantId: p.variantId, sku: p.sku, usedUnitId: unitId, unitPriceIqd: 250_000 }]);
    await runBatch(t.db, reserveUsedUnitStatements(t.db, { usedUnitId: unitId, orderId: order.orderId, now: NOW }));
    await releaseOrderReservations(t.db, SYSTEM, order.orderId, "payment_rejected", NOW);
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("listed");
  });
});

// ───────────────────────────────────────────────────────────────── shipping

describe("shipping fees", () => {
  test("5,000 IQD to every one of the 19 governorates", async () => {
    expect(IRAQ_GOVERNORATES).toHaveLength(19);
    for (const governorate of IRAQ_GOVERNORATES) expect(await getShippingFee(t.db, governorateId(governorate.slug))).toBe(5_000);
    const list = await listGovernorates(t.db, "en");
    expect(list).toHaveLength(19);
    expect(list[0]).toEqual({ id: "gov_baghdad", slug: "baghdad", name: "Baghdad" });
    expect((await listGovernorates(t.db, "ar"))[0].name).toBe("بغداد");
    const basraDistricts = await listDistricts(t.db, "ckb", governorateId("basra"));
    expect(basraDistricts.length).toBeGreaterThan(0);
    expect(basraDistricts.every((district) => district.id.startsWith("dst_basra_") && district.name.length > 0)).toBe(true);
  });

  test("override rows apply only while overrides are enabled", async () => {
    const basra = governorateId("basra");
    await t.db.insert(shippingRates).values([
      { id: newId("shr"), governorateId: basra, feeIqd: 8_000, isOverride: true, isActive: true, updatedAt: NOW },
      { id: newId("shr"), governorateId: null, feeIqd: 6_000, isOverride: true, isActive: true, updatedAt: NOW },
      { id: newId("shr"), governorateId: governorateId("erbil"), feeIqd: 9_000, isOverride: false, isActive: true, updatedAt: NOW },
      { id: newId("shr"), governorateId: governorateId("duhok"), feeIqd: 9_500, isOverride: true, isActive: false, updatedAt: NOW },
    ]);
    expect(await getShippingFee(t.db, basra)).toBe(5_000);
    expect(await getShippingFee(t.db, governorateId("najaf"))).toBe(5_000);

    await t.db.insert(settings).values({ key: "shipping.overrides_enabled", value: true, updatedAt: NOW }).onConflictDoUpdate({ target: settings.key, set: { value: true } });
    try {
      expect(await getShippingFee(t.db, basra)).toBe(8_000);
      expect(await getShippingFee(t.db, governorateId("najaf"))).toBe(6_000);
      expect(await getShippingFee(t.db, governorateId("erbil"))).toBe(6_000);
      expect(await getShippingFee(t.db, governorateId("duhok"))).toBe(6_000);
    } finally {
      await t.db.update(settings).set({ value: false }).where(eq(settings.key, "shipping.overrides_enabled"));
      await t.db.delete(shippingRates);
    }
    expect(await getShippingFee(t.db, basra)).toBe(5_000);
  });

  test("an inactive or unknown governorate is unavailable, never priced", async () => {
    const halabja = governorateId("halabja");
    await t.db.update(governorates).set({ isActive: false }).where(eq(governorates.id, halabja));
    try {
      expect(await failureOf(getShippingFee(t.db, halabja))).toMatchObject({ code: "shipping_unavailable", status: 409, fields: { governorateId: "shipping_unavailable" } });
      expect((await listGovernorates(t.db, "ar")).some((row) => row.id === halabja)).toBe(false);
      expect(await listDistricts(t.db, "ar", halabja)).toEqual([]);
    } finally {
      await t.db.update(governorates).set({ isActive: true }).where(eq(governorates.id, halabja));
    }
    expect(await failureOf(getShippingFee(t.db, "gov_atlantis"))).toMatchObject({ code: "shipping_unavailable" });
    expect(isAppError(await failureOf(getShippingFee(t.db, "")))).toBe(true);
  });

  test("the flat fee follows the setting", async () => {
    await t.db.insert(settings).values({ key: "shipping.flat_fee_iqd", value: 6_000, updatedAt: NOW }).onConflictDoUpdate({ target: settings.key, set: { value: 6_000 } });
    try {
      expect(await getShippingFee(t.db, governorateId("baghdad"))).toBe(6_000);
    } finally {
      await t.db.update(settings).set({ value: 5_000 }).where(eq(settings.key, "shipping.flat_fee_iqd"));
    }
  });
});

