/**
 * Admin module 04 (inventory) — the adversarial review (2026-11-11). Each test is an attack on the module's services
 * or on the core-level transfers file it added, written before the fix:
 *   · races: a transfer receipt against a shortfall close (both ways), two counts started at once for one location,
 *     a manual release against the start of packing — simulated by running the other request just before the
 *     service's write batch (`beforeBatch`)
 *   · no serial registered twice by changing its letter case (blueprint acceptance #1)
 *   · a receipt whose inspection record fails after the units went in is not received again on retry
 *   · the two-person rule of counts survives a re-count by a colleague; the home page never asks a supervisor to
 *     approve their own count; blind counting carries no system quantity in the counter's data
 *   · an employee limited to a branch cannot release stock held at another branch
 *   · confirm dialogs show the real impact: the value of the units a shortfall writes off, every unit an order holds
 *   · a count whose approval stopped half way cannot be cancelled as "nothing posted"; after a recount a line posted
 *     before posts only its new difference; an approval stops when the count is sent back meanwhile (it used to post
 *     every line and answer "replayed"); a hand-typed reason that looks like a count's posting is refused
 *   · second pass: a location switched off while a transfer to it ships (the goods would be stranded); the movement
 *     log never reaches a role without inventory.movement.read through a SKU's page or a unit's history; the counts
 *     list does not tell a counter how many lines differ while the count is blind
 * Runs against a real local D1 with the real triggers.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, branches, cycleCountLines, cycleCounts, inventoryLocations, orders, serials, stockLevels, stockMovements, stockTransferItems, variantCosts } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import { CONSISTENCY_CHECKS } from "~/server/jobs.server";
import { defaultRolePermissions, type DefaultRoleKey } from "~/server/permissions";
import { inventoryOverview } from "~/server/services/admin/inventory/analytics.server";
import { approveCount, cancelCount, createCount, getCount, listCounts, recordCounts, sendBackCount, submitCount } from "~/server/services/admin/inventory/counts.server";
import { newReceivingSession, receiveLine } from "~/server/services/admin/inventory/receiving.server";
import { updateLocation } from "~/server/services/admin/inventory/locations.server";
import { listReservations, releaseReservationsOfOrder } from "~/server/services/admin/inventory/reservations.server";
import { getSerialHistory } from "~/server/services/admin/inventory/serials.server";
import { adjustFromAdmin, getVariantStock } from "~/server/services/admin/inventory/stock.server";
import { getTransfer } from "~/server/services/admin/inventory/transfers.server";
import { receiveStock, reserveStatements } from "~/server/services/inventory/stock.server";
import { closeTransferShortfall, createTransfer, receiveTransfer, shipTransfer } from "~/server/services/inventory/transfers.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
const MAIN = DEFAULT_LOCATION_ID;
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

async function addLocation(options: { branchId?: string | null } = {}) {
  const id = newId("loc");
  await t.db.insert(inventoryLocations).values({ id, code: make.next("LOC"), name: "Test location", kind: "warehouse", isSellable: true, isActive: true, branchId: options.branchId ?? null });
  return id;
}

/** A product received through the core (movements and cost layers, so the stock checks stay clean). */
async function stocked(qty: number, unitCostIqd: number, options: { locationId?: string; serials?: string[] } = {}) {
  const product = await make.product({ trackSerials: Boolean(options.serials) });
  await receiveStock(t.db, SYSTEM, { variantId: product.variantId, locationId: options.locationId ?? MAIN, qty, unitCostIqd, serials: options.serials, ref: "fixture" }, NOW - DAY);
  return product;
}

async function level(variantId: string, locationId: string) {
  return (await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId))).get()) ?? { onHand: 0, reserved: 0, incoming: 0, allowOversell: false };
}

async function stockFindings(variantIds: string[]) {
  const findings = [];
  for (const check of CONSISTENCY_CHECKS.filter((entry) => entry.key.startsWith("stock."))) findings.push(...(await check.run(t.db)));
  return findings.filter((finding) => variantIds.some((id) => finding.entityId?.startsWith(`${id}@`)));
}

async function heldOrder(lines: { variantId: string; sku: string; qty: number }[], status: "new" | "confirmed" = "confirmed") {
  const order = await make.order(lines, { status });
  await runBatch(t.db, reserveStatements(t.db, { orderId: order.orderId, lines: lines.map((line) => ({ variantId: line.variantId, qty: line.qty })), expiresAt: null, actor: SYSTEM, now: NOW }));
  return order;
}

type Batch = (statements: unknown) => Promise<unknown>;

/**
 * The same database, except that `hook` runs once, just before the `nth` call of db.batch — another request that
 * lands between the service's reads and its write batch.
 */
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

/** The same database, except that the first audit insert after `batches` completed batches fails (a lost connection). */
function auditFailsAfter(db: Db, batches: number): Db {
  let done = 0;
  let failed = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: unknown) => {
          const result = await (target.batch as unknown as Batch).call(target, statements);
          done += 1;
          return result;
        };
      }
      if (prop === "insert") {
        return (table: unknown) => {
          if (!failed && done >= batches && table === auditEvents) {
            failed = true;
            throw new Error("D1_ERROR: Network connection lost.");
          }
          return (target.insert as unknown as (table: unknown) => unknown).call(target, table);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function shippedTransfer(qty: number, unitCostIqd = 40_000) {
  const product = await stocked(qty, unitCostIqd);
  const shop = await addLocation();
  const manager = role("manager");
  const { transferId } = await createTransfer(t.db, manager, { fromLocationId: MAIN, toLocationId: shop, lines: [{ variantId: product.variantId, qty }], idempotencyKey: key() }, NOW);
  await shipTransfer(t.db, manager, { transferId }, NOW + 1_000);
  const [item] = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
  return { product, shop, manager, transferId, item };
}

async function transferLedger(transferId: string) {
  const moves = await t.db.select().from(stockMovements).where(eq(stockMovements.refId, transferId));
  const sum = (kind: string) => moves.filter((row) => row.kind === kind).reduce((total, row) => total + row.qtyDelta, 0);
  return { out: sum("transfer_out"), in: sum("transfer_in"), damage: sum("damage") };
}

// ───────────────────────────────────────────────────────────────── transfers (core-level file)

describe("transfers under concurrency", () => {
  test("a receipt that lands after the shortfall was closed cannot bring the written-off units in again", async () => {
    const { product, shop, manager, transferId, item } = await shippedTransfer(5);
    // The receiver read the transfer while it was in transit; a colleague closes the shortfall before the receipt is written.
    const racing = beforeBatch(t.db, 2, () => closeTransferShortfall(t.db, manager, { transferId, reason: "the van never arrived", idempotencyKey: key() }, NOW + 2_000));
    expect(await code(() => receiveTransfer(racing, role("inventory"), { transferId, lines: [{ itemId: item.id, qty: 3 }], idempotencyKey: key() }, NOW + 3_000))).toBe("transfer_not_in_transit");
    const at = await level(product.variantId, shop);
    expect([at.onHand, at.incoming]).toEqual([0, 0]);
    // 5 left, 5 written off as lost, nothing received on top
    expect(await transferLedger(transferId)).toEqual({ out: -5, in: 5, damage: -5 });
    expect(await stockFindings([product.variantId])).toEqual([]);
  });

  test("a shortfall closed while a receipt lands writes off only what is still missing", async () => {
    const { product, shop, manager, transferId, item } = await shippedTransfer(5);
    const racing = beforeBatch(t.db, 2, () => receiveTransfer(t.db, role("inventory"), { transferId, lines: [{ itemId: item.id, qty: 3 }], idempotencyKey: key() }, NOW + 2_000));
    expect(await closeTransferShortfall(racing, manager, { transferId, reason: "two boxes are missing", idempotencyKey: key() }, NOW + 3_000)).toEqual({ lost: 2, replayed: false });
    const at = await level(product.variantId, shop);
    expect([at.onHand, at.incoming]).toEqual([3, 0]);
    expect(await transferLedger(transferId)).toEqual({ out: -5, in: 5, damage: -2 });
    expect(await stockFindings([product.variantId])).toEqual([]);
  });

  test("the shortfall's financial impact is the value of the missing units, and only for cost.read", async () => {
    const product = await make.product();
    await receiveStock(t.db, SYSTEM, { variantId: product.variantId, locationId: MAIN, qty: 3, unitCostIqd: 100_000, ref: "old-batch" }, NOW - 10 * DAY);
    await receiveStock(t.db, SYSTEM, { variantId: product.variantId, locationId: MAIN, qty: 2, unitCostIqd: 130_000, ref: "new-batch" }, NOW - DAY);
    const shop = await addLocation();
    const manager = role("manager");
    const { transferId } = await createTransfer(t.db, manager, { fromLocationId: MAIN, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 5 }], idempotencyKey: key() }, NOW);
    await shipTransfer(t.db, manager, { transferId }, NOW);
    const [item] = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    await receiveTransfer(t.db, manager, { transferId, lines: [{ itemId: item.id, qty: 3 }], idempotencyKey: key() }, NOW + 1_000);

    const view = await getTransfer(t.db, manager, transferId, "en");
    expect(view.valueIqd).toBe(560_000);
    // the two units still missing are the newer batch: 2 × 130,000 — not the value of the whole transfer
    expect(view.shortfallValueIqd).toBe(260_000);
    const clerkView = await getTransfer(t.db, role("inventory"), transferId, "en");
    expect("shortfallValueIqd" in clerkView).toBe(false);
    expect("valueIqd" in clerkView).toBe(false);

    await closeTransferShortfall(t.db, manager, { transferId, reason: "two units missing", idempotencyKey: key() }, NOW + 2_000);
    const damage = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refId, transferId), eq(stockMovements.kind, "damage")));
    expect(damage.reduce((sum, row) => sum - row.qtyDelta * (row.unitCostIqd ?? 0), 0)).toBe(260_000);
    expect("shortfallValueIqd" in (await getTransfer(t.db, manager, transferId, "en"))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── receiving (04.03)

describe("receiving", () => {
  test("a serial number cannot be registered a second time in other letters (no unit sold twice)", async () => {
    const product = await make.product({ trackSerials: true });
    await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: 1, landedCostIqd: 300_000, updatedAt: NOW });
    const clerk = role("inventory");
    const serial = `${make.next("SN")}-AbC`;
    const line = (numbers: string[]) => ({ sessionRef: newReceivingSession(), locationId: MAIN, variantId: product.variantId, counted: numbers.length, serials: numbers, idempotencyKey: key() });
    await receiveLine(t.db, clerk, line([serial]), NOW);
    expect(await code(() => receiveLine(t.db, clerk, line([serial.toLowerCase()]), NOW))).toBe("serial_duplicate");
    expect(await code(() => receiveLine(t.db, clerk, line([serial.toUpperCase()]), NOW))).toBe("serial_duplicate");
    const rows = await t.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM serials WHERE upper(serial) = upper(${serial})`);
    expect(Number(rows[0]?.n)).toBe(1);
    expect((await level(product.variantId, MAIN)).onHand).toBe(1);
  });

  test("a receipt whose inspection record fails after the units went in is not received again when it is sent again", async () => {
    const product = await make.product();
    await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: 1, landedCostIqd: 20_000, updatedAt: NOW });
    const clerk = role("inventory");
    const input = { sessionRef: newReceivingSession(), locationId: MAIN, variantId: product.variantId, counted: 4, idempotencyKey: key() };
    // receiveStock reads in one batch and writes in a second; the inspection event after it fails
    expect(String(await thrown(() => receiveLine(auditFailsAfter(t.db, 2), clerk, input, NOW)))).toContain("Network connection lost");
    expect((await level(product.variantId, MAIN)).onHand).toBe(4);
    // the employee sees the error and submits the same form again
    expect(await receiveLine(t.db, clerk, input, NOW + 5_000)).toEqual({ accepted: 0, rejected: 0, replayed: true });
    expect((await level(product.variantId, MAIN)).onHand).toBe(4);
  });
});

// ───────────────────────────────────────────────────────────────── counts (04.05)

describe("counts", () => {
  test("a supervisor who counted a line cannot approve the count, even after a colleague re-counted that line", async () => {
    const location = await addLocation();
    const product = await stocked(10, 1_000, { locationId: location });
    const first = role("manager");
    const second = role("manager");
    const { countId } = await createCount(t.db, role("inventory"), { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, first, { countId, lines: [{ variantId: product.variantId, countedQty: 7 }] }, NOW + 1_000);
    await recordCounts(t.db, second, { countId, lines: [{ variantId: product.variantId, countedQty: 7 }] }, NOW + 2_000);
    await submitCount(t.db, second, { countId }, NOW + 3_000);
    const view = await getCount(t.db, first, countId, "en");
    expect([view.canApprove, view.selfInvolved]).toEqual([false, true]);
    expect(await code(() => approveCount(t.db, first, { countId, reason: "matches the shelf" }, NOW + 4_000))).toBe("count_self_approval");
    expect((await level(product.variantId, location)).onHand).toBe(10);
    // a supervisor who took no part approves it
    expect(await approveCount(t.db, role("manager"), { countId, reason: "checked the shelf myself" }, NOW + 5_000)).toMatchObject({ posted: 1 });
    expect((await level(product.variantId, location)).onHand).toBe(7);
  });

  test("two counts started at the same moment for one location: only one stays open", async () => {
    const location = await addLocation();
    await stocked(3, 1_000, { locationId: location });
    const racing = beforeBatch(t.db, 1, () => createCount(t.db, role("inventory"), { locationId: location, mode: "all", idempotencyKey: key() }, NOW));
    expect(await code(() => createCount(racing, role("inventory"), { locationId: location, mode: "all", idempotencyKey: key() }, NOW))).toBe("count_location_busy");
    const open = await t.db.select().from(cycleCounts).where(and(eq(cycleCounts.locationId, location), inArray(cycleCounts.status, ["draft", "counting", "review"])));
    expect(open).toHaveLength(1);
  });

  test("while a count is open, a counter's data carries no system quantity and no difference (blind counting)", async () => {
    const location = await addLocation();
    const plain = await stocked(9, 1_000, { locationId: location });
    const numbers = [make.next("SN"), make.next("SN")];
    const tracked = await stocked(2, 50_000, { locationId: location, serials: numbers });
    const clerk = role("inventory");
    const { countId } = await createCount(t.db, clerk, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, clerk, { countId, lines: [{ variantId: plain.variantId, countedQty: 4 }, { variantId: tracked.variantId, serials: [numbers[0]] }] }, NOW);

    const blind = await getCount(t.db, clerk, countId, "ar");
    expect(blind.showExpected).toBe(false);
    for (const line of blind.lines) {
      expect([line.expected, line.difference, line.onHandNow, line.reservedNow, line.oversell]).toEqual([null, null, null, null, false]);
    }
    expect(blind.summary).toMatchObject({ lines: 2, counted: 2, differences: null, serialDifferences: null, oversell: null, unitsMissing: null, unitsFound: null });
    expect(blind.lines.find((line) => line.variant.id === tracked.variantId)?.serials).toEqual({ seen: [numbers[0].toUpperCase()], missing: [], unexpected: [] });
    expect(JSON.stringify(blind)).not.toContain(numbers[1]);

    // the supervisor sees everything
    const review = await getCount(t.db, role("manager"), countId, "ar");
    expect(review.summary).toMatchObject({ differences: 1, unitsMissing: 5 });
    expect(review.lines.find((line) => line.variant.id === plain.variantId)?.onHandNow).toBe(9);
    expect(review.lines.find((line) => line.variant.id === tracked.variantId)?.serials?.missing).toEqual([numbers[1].toUpperCase()]);
  });

  test("after an approval that posted only part of a count, a recounted line posts its new difference; the count cannot be cancelled as 'nothing posted'", async () => {
    const location = await addLocation();
    const a = await stocked(10, 1_000, { locationId: location });
    const b = await stocked(5, 1_000, { locationId: location });
    const clerk = role("inventory");
    const supervisor = role("manager");
    const { countId } = await createCount(t.db, clerk, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, clerk, { countId, lines: [{ variantId: a.variantId, countedQty: 8 }, { variantId: b.variantId, countedQty: 3 }] }, NOW + 1_000);
    await submitCount(t.db, clerk, { countId }, NOW + 2_000);
    const [first, second] = await t.db.select().from(cycleCountLines).where(eq(cycleCountLines.countId, countId)).orderBy(cycleCountLines.id);
    // The approval posts the first line; before the second one is posted, an order takes 4 of its units (removing 2
    // would now oversell), so the approval stops half way.
    const racing = beforeBatch(t.db, 4, () => heldOrder([{ variantId: second.variantId, sku: "fixture", qty: 4 }]));
    expect(await code(() => approveCount(racing, supervisor, { countId, reason: "variance confirmed" }, NOW + 3_000))).toBe("insufficient_stock");
    expect((await level(first.variantId, location)).onHand).toBe(8);
    // posted adjustments exist: the count can no longer be cancelled as if nothing had been posted
    expect(await code(() => cancelCount(t.db, clerk, { countId, reason: "start again" }, NOW + 3_500))).toBe("count_partially_posted");
    // a recount instead: the first shelf now lacks one more unit, the second is complete
    await sendBackCount(t.db, supervisor, { countId, reason: "recount after the failed approval" }, NOW + 4_000);
    await recordCounts(t.db, clerk, { countId, lines: [{ variantId: first.variantId, countedQty: 7 }, { variantId: second.variantId, countedQty: 5 }] }, NOW + 5_000);
    await submitCount(t.db, clerk, { countId }, NOW + 6_000);
    const review = await getCount(t.db, supervisor, countId, "en");
    expect(review.lines.find((line) => line.id === first.id)).toMatchObject({ difference: -1, posted: false });
    expect(await approveCount(t.db, supervisor, { countId, reason: "recounted" }, NOW + 7_000)).toMatchObject({ posted: 1, replayed: false });
    expect((await level(first.variantId, location)).onHand).toBe(7);
    expect((await level(second.variantId, location)).onHand).toBe(5);
    expect(await stockFindings([a.variantId, b.variantId])).toEqual([]);
  });

  test("an approval stops when the count is sent back meanwhile: at most the line in flight is posted, and it says so", async () => {
    const location = await addLocation();
    const products = [await stocked(10, 1_000, { locationId: location }), await stocked(10, 1_000, { locationId: location }), await stocked(10, 1_000, { locationId: location })];
    const clerk = role("inventory");
    const { countId } = await createCount(t.db, clerk, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, clerk, { countId, lines: products.map((product) => ({ variantId: product.variantId, countedQty: 9 })) }, NOW + 1_000);
    await submitCount(t.db, clerk, { countId }, NOW + 2_000);
    // A colleague sends the count back while the approval is posting its second line (just before that line's write).
    const racing = beforeBatch(t.db, 4, () => sendBackCount(t.db, role("manager"), { countId, reason: "recount aisle 3" }, NOW + 3_000));
    expect(await code(() => approveCount(racing, role("manager"), { countId, reason: "variance confirmed" }, NOW + 3_000))).toBe("count_not_in_review");
    const onHand = await Promise.all(products.map(async (product) => (await level(product.variantId, location)).onHand));
    expect(onHand.filter((qty) => qty === 9)).toHaveLength(2);
    expect(onHand.filter((qty) => qty === 10)).toHaveLength(1);
    const view = await getCount(t.db, role("manager"), countId, "en");
    expect([view.status, view.postedLines]).toEqual(["counting", 2]);
    expect(await stockFindings(products.map((product) => product.variantId))).toEqual([]);
  });

  test("a counter cannot make the approval skip a difference by writing the count's reference into a manual adjustment", async () => {
    const location = await addLocation();
    const product = await stocked(10, 1_000, { locationId: location });
    // the inventory role counts AND may adjust stock by hand
    const clerk = role("inventory");
    const { countId, ref } = await createCount(t.db, clerk, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, clerk, { countId, lines: [{ variantId: product.variantId, countedQty: 7 }] }, NOW + 1_000);
    await submitCount(t.db, clerk, { countId }, NOW + 2_000);
    const [line] = await t.db.select().from(cycleCountLines).where(eq(cycleCountLines.countId, countId));
    // a one-unit "posting" under the count's marker (the marker is matched with LIKE, so in other letters too)
    for (const forged of [`${ref} [${line.id}]: counted 7, expected 10 — done`, `${ref.toLowerCase()} [${line.id}]: done`]) {
      expect(await code(() => adjustFromAdmin(t.db, clerk, { variantId: product.variantId, locationId: location, kind: "adjust", direction: "remove", qty: 1, reason: forged, idempotencyKey: key() }, NOW + 2_500))).toBe("invalid");
    }
    expect((await level(product.variantId, location)).onHand).toBe(10);
    // the supervisor's approval posts the whole difference, and the count can still be cancelled before it
    expect((await getCount(t.db, role("manager"), countId, "en")).postedLines).toBe(0);
    expect(await approveCount(t.db, role("manager"), { countId, reason: "confirmed on the shelf" }, NOW + 3_000)).toMatchObject({ posted: 1 });
    expect((await level(product.variantId, location)).onHand).toBe(7);
  });

  test("the home page does not ask a supervisor to approve a count they started and counted", async () => {
    const location = await addLocation();
    const product = await stocked(5, 1_000, { locationId: location });
    const supervisor = role("manager");
    const { countId } = await createCount(t.db, supervisor, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, supervisor, { countId, lines: [{ variantId: product.variantId, countedQty: 4 }] }, NOW);
    await submitCount(t.db, supervisor, { countId }, NOW);
    const mine = await inventoryOverview(t.db, supervisor, NOW);
    const someoneElse = await inventoryOverview(t.db, role("manager"), NOW);
    expect(someoneElse.decisions.countsToApprove - mine.decisions.countsToApprove).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── reservations (04.08)

describe("reservations", () => {
  test("an employee limited to a branch cannot release stock held at another branch's location", async () => {
    const branchA = newId("brn");
    const branchB = newId("brn");
    await t.db.insert(branches).values([
      { id: branchA, code: make.next("BA"), name: { ar: "فرع أ" }, createdAt: NOW },
      { id: branchB, code: make.next("BB"), name: { ar: "فرع ب" }, createdAt: NOW },
    ]);
    const storeA = await addLocation({ branchId: branchA });
    const product = await stocked(3, 1_000, { locationId: storeA });
    const order = await heldOrder([{ variantId: product.variantId, sku: product.sku, qty: 2 }]);
    expect(await code(() => releaseReservationsOfOrder(t.db, role("inventory", { branchId: branchB }), { orderId: order.orderId, reason: "customer cancelled by phone" }, NOW))).toBe("forbidden");
    expect((await level(product.variantId, storeA)).reserved).toBe(2);
    expect(await releaseReservationsOfOrder(t.db, role("inventory", { branchId: branchA }), { orderId: order.orderId, reason: "customer cancelled by phone" }, NOW)).toEqual({ released: 1 });
    expect((await level(product.variantId, storeA)).reserved).toBe(0);
  });

  test("a release that races the start of packing is refused and the order keeps its stock", async () => {
    const product = await stocked(4, 1_000);
    const order = await heldOrder([{ variantId: product.variantId, sku: product.sku, qty: 2 }]);
    const racing = beforeBatch(t.db, 1, () => t.db.update(orders).set({ status: "preparing" }).where(eq(orders.id, order.orderId)));
    expect(await code(() => releaseReservationsOfOrder(racing, role("inventory"), { orderId: order.orderId, reason: "stuck order" }, NOW))).toBe("release_not_allowed");
    expect((await level(product.variantId, MAIN)).reserved).toBe(2);
  });

  test("the release dialog's impact counts every unit the order holds, not only the rows on the page", async () => {
    const a = await stocked(5, 1_000);
    const b = await stocked(5, 1_000);
    const order = await heldOrder([
      { variantId: a.variantId, sku: a.sku, qty: 2 },
      { variantId: b.variantId, sku: b.sku, qty: 3 },
    ]);
    // searching one SKU shows one of the order's two holds
    const page = await listReservations(t.db, role("inventory"), { status: "active", q: a.sku, page: 1 }, "en", NOW);
    expect(page.rows.map((row) => row.orderId)).toEqual([order.orderId]);
    expect(page.orderUnits[order.orderId]).toBe(5);
  });
});

// ───────────────────────────────────────────────────────────────── locations (04.02)

describe("locations", () => {
  test("a location switched off while a transfer to it ships stays on: the goods could never be received there", async () => {
    const product = await stocked(4, 1_000);
    const shop = await addLocation();
    const manager = role("manager");
    const { transferId } = await createTransfer(t.db, manager, { fromLocationId: MAIN, toLocationId: shop, lines: [{ variantId: product.variantId, qty: 4 }], idempotencyKey: key() }, NOW);
    // The switch-off read the location while nothing was on its way; the transfer leaves before it is written.
    const racing = beforeBatch(t.db, 1, () => shipTransfer(t.db, manager, { transferId }, NOW + 1_000));
    expect(await code(() => updateLocation(racing, manager, { locationId: shop, isActive: false, reason: "closing this shelf" }, NOW + 2_000))).toBe("location_in_use");
    expect((await t.db.select().from(inventoryLocations).where(eq(inventoryLocations.id, shop)))[0]?.isActive).toBe(true);
    // the goods arrive
    const [item] = await t.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
    expect(await receiveTransfer(t.db, role("inventory"), { transferId, lines: [{ itemId: item.id, qty: 4 }], idempotencyKey: key() }, NOW + 3_000)).toMatchObject({ received: 4, complete: true });
  });
});

// ───────────────────────────────────────────────────────────────── what a role may read (second pass)

describe("authorization of the data a page receives", () => {
  test("the movement log stays with inventory.movement.read: a SKU's page and a unit's history carry no movements without it", async () => {
    const numbers = [make.next("SN"), make.next("SN")];
    const product = await stocked(2, 75_000, { serials: numbers });
    // the cashier holds inventory.stock.read and inventory.serial.read, not inventory.movement.read
    const cashier = role("cashier");
    const item = await getVariantStock(t.db, cashier, product.variantId, "en", NOW);
    expect("movements" in item).toBe(false);
    expect("cost" in item).toBe(false);
    const [unit] = await t.db.select().from(serials).where(eq(serials.serial, numbers[0]));
    const history = await getSerialHistory(t.db, cashier, unit.id, "en");
    expect("movements" in history).toBe(false);
    expect("costIqd" in history).toBe(false);
    expect(JSON.stringify([item, history])).not.toContain("75000");
    // the inventory role reads the log (no cost in it); the manager sees the cost too
    const clerkItem = await getVariantStock(t.db, role("inventory"), product.variantId, "en", NOW);
    expect(clerkItem.movements?.length).toBe(2);
    expect(clerkItem.movements?.every((row) => !("unitCostIqd" in row))).toBe(true);
    const managerHistory = await getSerialHistory(t.db, role("manager"), unit.id, "en");
    expect(managerHistory.movements?.[0]).toMatchObject({ kind: "receive", unitCostIqd: 75_000 });
  });

  test("the counts list does not tell a counter how many lines differ while the count is blind", async () => {
    const location = await addLocation();
    const product = await stocked(10, 1_000, { locationId: location });
    const clerk = role("inventory");
    const { countId } = await createCount(t.db, clerk, { locationId: location, mode: "all", idempotencyKey: key() }, NOW);
    await recordCounts(t.db, clerk, { countId, lines: [{ variantId: product.variantId, countedQty: 7 }] }, NOW + 1_000);
    const filters = { status: "open" as const, location, page: 1 };
    // saving, reading the list and saving again until it says 0 would be counting to the system's figure
    expect((await listCounts(t.db, clerk, filters)).rows.find((row) => row.id === countId)?.differences).toBeNull();
    expect((await listCounts(t.db, role("manager"), filters)).rows.find((row) => row.id === countId)?.differences).toBe(1);
    // once submitted the count is no longer blind (as on its own page)
    await submitCount(t.db, clerk, { countId }, NOW + 2_000);
    expect((await listCounts(t.db, clerk, filters)).rows.find((row) => row.id === countId)?.differences).toBe(1);
  });
});
