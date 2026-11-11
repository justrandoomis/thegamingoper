/**
 * Core-level stock transfers (app/server/services/inventory/transfers.server.ts, blueprint 04.07): drafts move
 * nothing; shipping takes units off the source with FIFO cost slices and puts them "in transit"; receiving (whole or
 * partial) brings them in with their original cost layers; shortfalls are written off; everything is idempotent,
 * audited, permission- and branch-checked, and keeps the database's stock invariants (levels = Σ movements,
 * reserved = Σ active reservations, no serial sold twice). Runs against a real local D1 with the real triggers.
 */
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { auditEvents, branches, costLayers, inventoryLocations, serials, stockLevels, stockMovements, stockTransferItems, stockTransfers, usedUnits, variantCosts } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { mapDbError, runBatch } from "~/server/db/tx.server";
import { isAppError } from "~/server/errors";
import { CONSISTENCY_CHECKS } from "~/server/jobs.server";
import { defaultRolePermissions, type DefaultRoleKey } from "~/server/permissions";
import { adjustStock, assignSerialsStatements, receiveStock, reserveStatements } from "~/server/services/inventory/stock.server";
import { cancelTransfer, closeTransferShortfall, createTransfer, fillLayers, receiveTransfer, shipTransfer } from "~/server/services/inventory/transfers.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const SYSTEM = systemActor("test");
let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

const role = (key: DefaultRoleKey, extra: Partial<EmployeeActor> = {}): EmployeeActor => ({ kind: "employee", id: newId("emp"), permissions: defaultRolePermissions(key), label: key, ...extra });
const key = () => `k_${newId("idem").slice(4)}`;

async function addLocation(options: { code?: string; branchId?: string | null; sellable?: boolean; active?: boolean } = {}) {
  const id = newId("loc");
  await t.db.insert(inventoryLocations).values({ id, code: options.code ?? make.next("LOC"), name: "Test location", kind: "warehouse", isSellable: options.sellable ?? true, isActive: options.active ?? true, branchId: options.branchId ?? null });
  return id;
}

/** A product received through the core (movements and cost layers, so the stock checks stay clean). */
async function stocked(qty: number, unitCostIqd: number, options: { locationId?: string; serials?: string[] } = {}) {
  const product = await make.product({ trackSerials: Boolean(options.serials) });
  await receiveStock(t.db, SYSTEM, { variantId: product.variantId, locationId: options.locationId ?? DEFAULT_LOCATION_ID, qty, unitCostIqd, serials: options.serials, ref: "test-receipt" }, NOW);
  return product;
}

async function level(variantId: string, locationId: string) {
  return (await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId))).get()) ?? { onHand: 0, reserved: 0, incoming: 0, allowOversell: false };
}

async function layersAt(variantId: string, locationId: string) {
  return t.db.select().from(costLayers).where(and(eq(costLayers.variantId, variantId), eq(costLayers.locationId, locationId))).orderBy(costLayers.receivedAt, costLayers.id);
}

async function stockFindings(variantIds: string[]) {
  const findings = [];
  for (const check of CONSISTENCY_CHECKS.filter((entry) => entry.key.startsWith("stock."))) findings.push(...(await check.run(t.db)));
  return findings.filter((finding) => variantIds.some((id) => finding.entityId?.startsWith(`${id}@`)));
}

async function thrown(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("fillLayers", () => {
  test("fills the transfer's layers oldest first, continuing after what arrived before", () => {
    const layers = [
      { id: "a", qtyReceived: 4, unitCostIqd: 100 },
      { id: "b", qtyReceived: 6, unitCostIqd: 120 },
    ];
    expect(fillLayers(layers, 0, 3)).toEqual([{ layerId: "a", qty: 3, unitCostIqd: 100 }]);
    expect(fillLayers(layers, 3, 3)).toEqual([
      { layerId: "a", qty: 1, unitCostIqd: 100 },
      { layerId: "b", qty: 2, unitCostIqd: 120 },
    ]);
    // beyond the layered units: no layer (costed later at the standard cost, or unknown)
    expect(fillLayers(layers, 8, 4)).toEqual([
      { layerId: "b", qty: 2, unitCostIqd: 120 },
      { layerId: null, qty: 2, unitCostIqd: null },
    ]);
  });
});

describe("transfers", () => {
  test("a draft moves nothing; the same key creates one transfer; roles without the permission are refused", async () => {
    const product = await stocked(10, 400_000);
    const shop = await addLocation({ code: make.next("SHOP") });
    const actor = role("inventory");
    const idempotencyKey = key();
    const input = { fromLocationId: DEFAULT_LOCATION_ID, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 4 }], idempotencyKey };
    const first = await createTransfer(t.db, actor, input, NOW);
    const again = await createTransfer(t.db, actor, input, NOW + 1000);
    expect(again).toEqual({ ...first, replayed: true });
    expect(first.ref).toMatch(/^TR-/);
    const transfer = await t.db.select().from(stockTransfers).where(eq(stockTransfers.id, first.transferId)).get();
    expect(transfer?.status).toBe("draft");
    expect((await level(product.variantId, DEFAULT_LOCATION_ID)).onHand).toBe(10);
    expect((await level(product.variantId, shop)).incoming).toBe(0);
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, first.transferId), eq(auditEvents.action, "inventory.transfer.create"))).all();
    expect(audit).toHaveLength(1);

    for (const denied of ["cashier", "support", "content", "fulfillment"] as const) {
      const error = await thrown(() => createTransfer(t.db, role(denied), { ...input, idempotencyKey: key() }, NOW));
      expect(isAppError(error, "forbidden"), denied).toBe(true);
    }
    expect(isAppError(await thrown(() => createTransfer(t.db, actor, { ...input, toLocationId: DEFAULT_LOCATION_ID, idempotencyKey: key() }, NOW)), "invalid")).toBe(true);
    const closed = await addLocation({ active: false });
    expect(isAppError(await thrown(() => createTransfer(t.db, actor, { ...input, toLocationId: closed, idempotencyKey: key() }, NOW)), "location_invalid")).toBe(true);
    expect(isAppError(await thrown(() => createTransfer(t.db, actor, { ...input, lines: [{ variantId: product.variantId, qty: 11 }], idempotencyKey: key() }, NOW)), "insufficient_stock")).toBe(true);
  });

  test("shipping takes units off the source with their FIFO cost; layers travel with their age; receiving brings them in", async () => {
    const product = await make.product();
    await receiveStock(t.db, SYSTEM, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 3, unitCostIqd: 100_000, ref: "old-batch" }, NOW - 10 * 86_400_000);
    await receiveStock(t.db, SYSTEM, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 5, unitCostIqd: 130_000, ref: "new-batch" }, NOW - 86_400_000);
    const shop = await addLocation();
    const actor = role("inventory");
    const { transferId, ref } = await createTransfer(t.db, actor, { fromLocationId: DEFAULT_LOCATION_ID, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 4 }], idempotencyKey: key() }, NOW);
    expect(await shipTransfer(t.db, actor, { transferId }, NOW + 1000)).toEqual({ replayed: false });
    expect(await shipTransfer(t.db, actor, { transferId }, NOW + 2000)).toEqual({ replayed: true });

    expect((await level(product.variantId, DEFAULT_LOCATION_ID)).onHand).toBe(4);
    const destBefore = await level(product.variantId, shop);
    expect(destBefore.onHand).toBe(0);
    expect(destBefore.incoming).toBe(4);
    const out = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, transferId), eq(stockMovements.kind, "transfer_out"))).orderBy(stockMovements.id);
    expect(out.map((row) => [row.qtyDelta, row.unitCostIqd])).toEqual([
      [-3, 100_000],
      [-1, 130_000],
    ]);
    for (const row of out) {
      expect(row.refType).toBe("transfer");
      expect(row.reason).toContain(ref);
      expect(row.actorKind).toBe("employee");
      expect(row.actorId).toBe(actor.id);
    }
    // the source's oldest layer is used up first; the destination got twins holding nothing yet
    const source = await layersAt(product.variantId, DEFAULT_LOCATION_ID);
    expect(source.map((layer) => layer.qtyRemaining)).toEqual([0, 4]);
    const dest = await layersAt(product.variantId, shop);
    expect(dest.map((layer) => [layer.qtyReceived, layer.qtyRemaining, layer.unitCostIqd, layer.receivedAt])).toEqual([
      [3, 0, 100_000, source[0].receivedAt],
      [1, 0, 130_000, source[1].receivedAt],
    ]);
    const transfer = await t.db.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).get();
    expect(transfer?.status).toBe("in_transit");
    expect(transfer?.shippedBy).toBe(actor.id);

    // a partial receipt, replayed safely, then the rest
    const [item] = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    const receiver = role("inventory");
    const firstKey = key();
    expect(await receiveTransfer(t.db, receiver, { transferId, lines: [{ itemId: item.id, qty: 2 }], idempotencyKey: firstKey }, NOW + 3000)).toEqual({ received: 2, complete: false, replayed: false });
    expect(await receiveTransfer(t.db, receiver, { transferId, lines: [{ itemId: item.id, qty: 2 }], idempotencyKey: firstKey }, NOW + 3500)).toMatchObject({ received: 0, replayed: true });
    let at = await level(product.variantId, shop);
    expect([at.onHand, at.incoming]).toEqual([2, 2]);
    expect((await layersAt(product.variantId, shop)).map((layer) => layer.qtyRemaining)).toEqual([2, 0]);
    // more than is still on the way is refused
    expect(isAppError(await thrown(() => receiveTransfer(t.db, receiver, { transferId, lines: [{ itemId: item.id, qty: 3 }], idempotencyKey: key() }, NOW + 4000)), "transfer_receive_exceeds")).toBe(true);
    expect(await receiveTransfer(t.db, receiver, { transferId, lines: [{ itemId: item.id, qty: 2 }], idempotencyKey: key() }, NOW + 5000)).toMatchObject({ received: 2, complete: true });
    at = await level(product.variantId, shop);
    expect([at.onHand, at.incoming]).toEqual([4, 0]);
    expect((await layersAt(product.variantId, shop)).map((layer) => layer.qtyRemaining)).toEqual([3, 1]);
    const inMoves = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, transferId), eq(stockMovements.kind, "transfer_in")));
    expect(inMoves.reduce((sum, row) => sum + row.qtyDelta, 0)).toBe(4);
    expect(new Set(inMoves.map((row) => row.unitCostIqd))).toEqual(new Set([100_000, 130_000]));
    expect((await t.db.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).get())?.status).toBe("received");

    // a later write-off at the destination costs the oldest batch first: the original 100,000 IQD units
    await adjustStock(t.db, role("manager"), { variantId: product.variantId, locationId: shop, delta: -1, kind: "damage", reason: "dropped box" }, NOW + 6000);
    const damage = await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, product.variantId), eq(stockMovements.locationId, shop), eq(stockMovements.kind, "damage"))).get();
    expect(damage?.unitCostIqd).toBe(100_000);
    expect(await stockFindings([product.variantId])).toEqual([]);
  });

  test("units promised to orders never leave: a reservation that lands before the shipment wins", async () => {
    const product = await stocked(5, 200_000);
    const shop = await addLocation();
    const actor = role("inventory");
    const { transferId } = await createTransfer(t.db, actor, { fromLocationId: DEFAULT_LOCATION_ID, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 4 }], idempotencyKey: key() }, NOW);
    // an order takes 2 of the 5 between the draft and the shipment
    const order = await make.order([{ ...product, qty: 2 }]);
    await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: [{ variantId: product.variantId, qty: 2 }], expiresAt: null, actor: SYSTEM, now: NOW }));
    expect(isAppError(await thrown(() => shipTransfer(t.db, actor, { transferId }, NOW + 1000)), "insufficient_stock")).toBe(true);
    const source = await level(product.variantId, DEFAULT_LOCATION_ID);
    expect([source.onHand, source.reserved]).toEqual([5, 2]);
    expect((await t.db.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).get())?.status).toBe("draft");
    expect(await t.db.select().from(stockMovements).where(eq(stockMovements.refId, transferId))).toHaveLength(0);
    expect(await stockFindings([product.variantId])).toEqual([]);
  });

  test("serial-tracked units travel by serial: not sellable in transit, back in stock at the destination", async () => {
    const numbers = [make.next("SN"), make.next("SN"), make.next("SN")];
    const product = await stocked(3, 600_000, { serials: numbers });
    const shop = await addLocation();
    const actor = role("inventory");
    const { transferId } = await createTransfer(t.db, actor, { fromLocationId: DEFAULT_LOCATION_ID, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 2 }], idempotencyKey: key() }, NOW);
    const [draftItem] = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    // serial numbers are required, one per unit, of this variant and at this location
    expect(isAppError(await thrown(() => shipTransfer(t.db, actor, { transferId }, NOW)), "invalid")).toBe(true);
    expect(isAppError(await thrown(() => shipTransfer(t.db, actor, { transferId, serials: [{ itemId: draftItem.id, serials: [numbers[0]] }] }, NOW)), "invalid")).toBe(true);
    expect(isAppError(await thrown(() => shipTransfer(t.db, actor, { transferId, serials: [{ itemId: draftItem.id, serials: [numbers[0], "NOT-A-SERIAL"] }] }, NOW)), "invalid")).toBe(true);
    await shipTransfer(t.db, actor, { transferId, serials: [{ itemId: draftItem.id, serials: [numbers[0], numbers[1].toLowerCase()] }] }, NOW + 1000);

    const shipped = await t.db.select().from(serials).where(eq(serials.variantId, product.variantId)).orderBy(serials.serial);
    expect(shipped.map((row) => [row.serial, row.status, row.locationId])).toEqual([
      [numbers[0], "intake", null],
      [numbers[1], "intake", null],
      [numbers[2], "in_stock", DEFAULT_LOCATION_ID],
    ]);
    const items = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    expect(items.map((item) => item.qty)).toEqual([1, 1]);
    const out = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, transferId), eq(stockMovements.kind, "transfer_out")));
    expect(out.every((row) => row.qtyDelta === -1 && row.serialId !== null && row.unitCostIqd === 600_000)).toBe(true);

    // a unit in transit cannot be packed into an order (no serial is sold from the truck)
    const order = await make.order([{ ...product, qty: 1 }]);
    const packed = await thrown(() => runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: order.itemIds[0], serialIds: [shipped[0].id], actor: SYSTEM, now: NOW })));
    expect(String(packed)).toContain("SERIAL_NOT_AVAILABLE");

    // scanning in at the destination
    expect(isAppError(await thrown(() => receiveTransfer(t.db, actor, { transferId, serials: [numbers[2]], idempotencyKey: key() }, NOW + 2000)), "invalid")).toBe(true);
    expect(await receiveTransfer(t.db, actor, { transferId, serials: [numbers[0]], idempotencyKey: key() }, NOW + 3000)).toMatchObject({ received: 1, complete: false });
    expect(isAppError(await thrown(() => receiveTransfer(t.db, actor, { transferId, serials: [numbers[0]], idempotencyKey: key() }, NOW + 3500)), "transfer_receive_exceeds")).toBe(true);
    expect(await receiveTransfer(t.db, actor, { transferId, serials: [numbers[1]], idempotencyKey: key() }, NOW + 4000)).toMatchObject({ received: 1, complete: true });
    const arrived = await t.db.select().from(serials).where(eq(serials.variantId, product.variantId)).orderBy(serials.serial);
    expect(arrived.map((row) => [row.status, row.locationId])).toEqual([
      ["in_stock", shop],
      ["in_stock", shop],
      ["in_stock", DEFAULT_LOCATION_ID],
    ]);
    expect([(await level(product.variantId, shop)).onHand, (await level(product.variantId, DEFAULT_LOCATION_ID)).onHand]).toEqual([2, 1]);
    // now it can be sold — once
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: order.itemIds[0], serialIds: [arrived[0].id], actor: SYSTEM, now: NOW + 5000 }));
    const other = await make.order([{ ...product, qty: 1 }]);
    expect(String(await thrown(() => runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: other.itemIds[0], serialIds: [arrived[0].id], actor: SYSTEM, now: NOW + 6000 }))))).toContain("SERIAL_NOT_AVAILABLE");
    expect(await stockFindings([product.variantId])).toEqual([]);
  });

  test("a used device's serial never travels in a transfer", async () => {
    const serial = make.next("USED-SN");
    const product = await stocked(1, 300_000, { serials: [serial] });
    const [row] = await t.db.select().from(serials).where(eq(serials.serial, serial));
    await t.db.insert(usedUnits).values({ id: newId("usd"), slug: make.next("used"), variantId: product.variantId, serialId: row.id, grade: "A", priceIqd: 400_000, status: "intake", isDemo: false, createdAt: NOW, updatedAt: NOW } as typeof usedUnits.$inferInsert);
    const shop = await addLocation();
    const actor = role("inventory");
    const { transferId } = await createTransfer(t.db, actor, { fromLocationId: DEFAULT_LOCATION_ID, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 1 }], idempotencyKey: key() }, NOW);
    const [item] = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    expect(isAppError(await thrown(() => shipTransfer(t.db, actor, { transferId, serials: [{ itemId: item.id, serials: [serial] }] }, NOW)), "serial_not_available")).toBe(true);
    expect((await t.db.select().from(serials).where(eq(serials.id, row.id)).get())?.status).toBe("in_stock");
  });

  test("a shortfall is written off with a reason: the loss is recorded, on hand is not invented", async () => {
    const numbers = [make.next("SN"), make.next("SN")];
    const tracked = await stocked(2, 500_000, { serials: numbers });
    const plain = await stocked(6, 50_000);
    const shop = await addLocation();
    const actor = role("inventory");
    const { transferId } = await createTransfer(
      t.db,
      actor,
      {
        fromLocationId: DEFAULT_LOCATION_ID,
        toLocationId: shop,
        lines: [
          { variantId: tracked.variantId, qty: 2 },
          { variantId: plain.variantId, qty: 5 },
        ],
        idempotencyKey: key(),
      },
      NOW,
    );
    const draft = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    const trackedItem = draft.find((item) => item.variantId === tracked.variantId)!;
    await shipTransfer(t.db, actor, { transferId, serials: [{ itemId: trackedItem.id, serials: numbers }] }, NOW + 1000);
    const plainItem = (await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId))).find((item) => item.variantId === plain.variantId)!;
    await receiveTransfer(t.db, actor, { transferId, lines: [{ itemId: plainItem.id, qty: 3 }], serials: [numbers[0]], idempotencyKey: key() }, NOW + 2000);

    // nothing missing yet is refused; writing off needs the adjust permission too
    const noAdjust: EmployeeActor = { kind: "employee", id: newId("emp"), permissions: ["inventory.transfer.receive"] };
    expect(isAppError(await thrown(() => closeTransferShortfall(t.db, noAdjust, { transferId, reason: "two boxes missing", idempotencyKey: key() }, NOW)), "forbidden")).toBe(true);
    const closeKey = key();
    expect(await closeTransferShortfall(t.db, actor, { transferId, reason: "two boxes and a console missing", idempotencyKey: closeKey }, NOW + 3000)).toEqual({ lost: 3, replayed: false });
    expect(await closeTransferShortfall(t.db, actor, { transferId, reason: "two boxes and a console missing", idempotencyKey: closeKey }, NOW + 3500)).toEqual({ lost: 0, replayed: true });

    expect((await t.db.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).get())?.status).toBe("received");
    const shopPlain = await level(plain.variantId, shop);
    expect([shopPlain.onHand, shopPlain.incoming]).toEqual([3, 0]);
    expect((await level(tracked.variantId, shop)).onHand).toBe(1);
    const lostSerial = await t.db.select().from(serials).where(eq(serials.serial, numbers[1])).get();
    expect(lostSerial?.status).toBe("scrapped");
    const damage = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, transferId), eq(stockMovements.kind, "damage")));
    expect(damage.reduce((sum, row) => sum + row.qtyDelta, 0)).toBe(-3);
    expect(damage.every((row) => row.reason?.includes("two boxes and a console missing"))).toBe(true);
    expect(damage.find((row) => row.variantId === plain.variantId)?.unitCostIqd).toBe(50_000);
    expect(damage.find((row) => row.variantId === tracked.variantId)?.unitCostIqd).toBe(500_000);
    expect(isAppError(await thrown(() => closeTransferShortfall(t.db, actor, { transferId, reason: "again", idempotencyKey: key() }, NOW + 4000)), "transfer_not_in_transit")).toBe(true);
    expect(await stockFindings([plain.variantId, tracked.variantId])).toEqual([]);
  });

  test("drafts can be cancelled; shipped transfers cannot; employees limited to a branch act only on its locations", async () => {
    const product = await stocked(4, 10_000);
    const shop = await addLocation();
    const actor = role("inventory");
    const draft = await createTransfer(t.db, actor, { fromLocationId: DEFAULT_LOCATION_ID, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 1 }], idempotencyKey: key() }, NOW);
    expect(await cancelTransfer(t.db, actor, { transferId: draft.transferId, reason: "made by mistake" }, NOW)).toEqual({ replayed: false });
    expect(await cancelTransfer(t.db, actor, { transferId: draft.transferId, reason: "made by mistake" }, NOW)).toEqual({ replayed: true });
    expect(isAppError(await thrown(() => shipTransfer(t.db, actor, { transferId: draft.transferId }, NOW)), "transfer_not_draft")).toBe(true);
    const shipped = await createTransfer(t.db, actor, { fromLocationId: DEFAULT_LOCATION_ID, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 1 }], idempotencyKey: key() }, NOW);
    await shipTransfer(t.db, actor, { transferId: shipped.transferId }, NOW);
    expect(isAppError(await thrown(() => cancelTransfer(t.db, actor, { transferId: shipped.transferId, reason: "too late" }, NOW)), "transfer_not_draft")).toBe(true);

    // branches
    const branchA = newId("brn");
    const branchB = newId("brn");
    await t.db.insert(branches).values([
      { id: branchA, code: make.next("BA"), name: { ar: "فرع أ" }, createdAt: NOW },
      { id: branchB, code: make.next("BB"), name: { ar: "فرع ب" }, createdAt: NOW },
    ]);
    const storeA = await addLocation({ branchId: branchA });
    const storeB = await addLocation({ branchId: branchB });
    const local = await stocked(3, 10_000, { locationId: storeA });
    const clerkB = role("inventory", { branchId: branchB });
    expect(isAppError(await thrown(() => createTransfer(t.db, clerkB, { fromLocationId: storeA, toLocationId: storeB, lines: [{ variantId: local.variantId, qty: 1 }], idempotencyKey: key() }, NOW)), "forbidden")).toBe(true);
    const clerkA = role("inventory", { branchId: branchA });
    const fromA = await createTransfer(t.db, clerkA, { fromLocationId: storeA, toLocationId: storeB, lines: [{ variantId: local.variantId, qty: 1 }], idempotencyKey: key() }, NOW);
    await shipTransfer(t.db, clerkA, { transferId: fromA.transferId }, NOW);
    const [item] = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, fromA.transferId));
    // only someone at the destination receives it
    expect(isAppError(await thrown(() => receiveTransfer(t.db, clerkA, { transferId: fromA.transferId, lines: [{ itemId: item.id, qty: 1 }], idempotencyKey: key() }, NOW)), "forbidden")).toBe(true);
    expect(await receiveTransfer(t.db, clerkB, { transferId: fromA.transferId, lines: [{ itemId: item.id, qty: 1 }], idempotencyKey: key() }, NOW)).toMatchObject({ complete: true });
  });

  test("units without a cost layer arrive without one and keep the standard-cost rule; movements are immutable", async () => {
    const product = await make.product();
    await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: 5000, landedCostIqd: 70_000, updatedAt: NOW });
    // found units added without a cost: no layer
    await adjustStock(t.db, role("manager"), { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, delta: 2, reason: "found on the shelf" }, NOW);
    const shop = await addLocation();
    const actor = role("inventory");
    const { transferId } = await createTransfer(t.db, actor, { fromLocationId: DEFAULT_LOCATION_ID, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 2 }], idempotencyKey: key() }, NOW);
    await shipTransfer(t.db, actor, { transferId }, NOW);
    expect(await layersAt(product.variantId, shop)).toHaveLength(0);
    const [item] = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    await receiveTransfer(t.db, actor, { transferId, lines: [{ itemId: item.id, qty: 2 }], idempotencyKey: key() }, NOW);
    const moves = await t.db.select().from(stockMovements).where(eq(stockMovements.refId, transferId));
    expect(moves.map((row) => [row.kind, row.qtyDelta, row.unitCostIqd]).sort()).toEqual([
      ["transfer_in", 2, 70_000],
      ["transfer_out", -2, 70_000],
    ]);
    expect(moves.every((row) => row.reason?.includes("no_cost_layer_standard_cost") || row.kind === "transfer_in")).toBe(true);
    // the log refuses edits and deletions
    expect(mapDbError(await thrown(() => t.db.update(stockMovements).set({ qtyDelta: 99 }).where(eq(stockMovements.id, moves[0].id))))?.code).toBe("IMMUTABLE");
    expect(mapDbError(await thrown(() => t.db.delete(stockMovements).where(like(stockMovements.id, `${transferId}%`))))?.code).toBe("IMMUTABLE");
    expect(await stockFindings([product.variantId])).toEqual([]);
  });
});
