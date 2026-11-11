/**
 * Goods of a return after delivery (admin module 12, RMA) — commerce core, added by admin 12 returns on 2026-11-11
 * (docs/CONTRACTS.md §1 "returns/receive.server.ts"; tests in tests/admin-returns-receive.test.ts). It builds on the
 * core's own builders and invariants: planReturnedGoods (only what left can come back, cost slices of the order's own
 * 'sale' movements, serial links released with `order_item_serials.released_at`), FIFO cost layers, append-only
 * movements, journal postings through accounting/post.server, guarded updates, audit by the caller in the same batch.
 *
 *   // at inspection: one return line comes back into sellable stock, into quarantine (a NON-sellable location), or is written off
 *   const goods = await returnGoodsStatements(db, { orderId, lines: [{ orderItemId, qty: 1, serialIds: [serialId] }], to: { kind: "quarantine", locationId }, actor, now, key: `return_item:${itemId}`, refType: "return", refId: returnId, reason: "RMA-…: …" });
 *   await runBatch(db, [guardedItemUpdate, expectChanged(db), ...goods.statements, audit]);
 *
 *   // later: a quarantined unit goes back on sale (after refurbishment), is written off, or leaves to its supplier
 *   await exitQuarantine(db, actor, { variantId, fromLocationId, qty: 1, serialIds, to: { kind: "stock", locationId }, refType: "return_item", refId, reason, key }, now, (plan) => [...myGuardsAndAudit]);
 *
 *   // the refund of a return keeps its original reference (refunds.return_id)
 *   await runBatch(db, [...linkRefundStatements(db, { refundId, returnId, orderId }), …]);
 *
 * RULES
 *   · Only goods of a DELIVERED order come back here (a parcel that never arrived is the shipped → returned transition
 *     of orders/manage.server). What came back never exceeds what left (planReturnedGoods + its in-batch guard).
 *   · restock     on_hand += qty at a SELLABLE, active location (default: where the units left from); serials in_stock.
 *     quarantine  the same movements into a NON-sellable, active location (not counted as available, so never sold
 *                 or reserved); serial-tracked units get status 'returned' there, so the packing station cannot scan
 *                 them into an order (assignSerialsStatements takes in_stock serials only). Cost: a 'return' layer at
 *                 the quarantine location — the units are still ours, at the cost they left with.
 *     scrap       a 'return' + 'damage' pair (on hand unchanged), serials scrapped.
 *     Books: postReturnedGoods — Dr inventory (restocked and quarantined cost) and Dr inventory adjustments (scrapped
 *     cost), Cr cost of goods sold, once per `key` (`<key>:goods`).
 *   · Leaving quarantine (exitQuarantine): on_hand −= qty at the quarantine location (guarded: never below what is
 *     reserved there), FIFO layers of that location consumed (guarded, re-planned on a race):
 *       stock     'transfer_out' / 'transfer_in' pairs, on_hand += qty at a sellable location, a twin layer per costed
 *                 slice (same unit cost), serials 'returned' → in_stock at the new location;
 *       scrap     'damage' movements, serials scrapped; Dr inventory adjustments / Cr inventory (known cost);
 *       supplier  'adjust' movements with the supplier reference, serials 'in_repair' with no location (with the
 *                 supplier); Dr accounts payable / Cr inventory (known cost — a debit note on the supplier).
 *     Unknown costs stay unknown (never zero): uncosted units are counted and posted at nothing.
 *   · Who: receiving returned goods needs returns.rma.inspect; back to stock returns.rma.inspect; a write-off
 *     returns.rma.inspect AND inventory.stock.adjust; to the supplier returns.supplier_return.manage. Costs in the
 *     results are [P]: callers must not hand them to actors without cost.read.
 *
 * Errors (AppError): forbidden (403), not_found (404), invalid (400; fields: locationId = location_invalid |
 * location_not_quarantine, items = serials_required | serial_not_on_line | invalid, serialIds = serials_count |
 * serial_not_in_quarantine), return_not_delivered · return_exceeds_shipped · insufficient_stock · period_closed ·
 * already_posted (409).
 *
 * Must not import "cloudflare:workers".
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { actorRef, assertCan, type Actor } from "~/server/actor";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { costLayers, inventoryLocations, journalEntries, orderItems, orders, refunds, serials, stockLevels, stockMovements, usedUnits, variantCosts, variants, type NewCostLayer, type NewStockMovement } from "~/server/db/schema";
import { batchSql, chunkRows, expectChanged, isDbError, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { cogsPostingKey, journalStatements, mapPostingError, postReturnedGoods, postedBy } from "../accounting/post.server";
import { takeFifo } from "../inventory/fifo";
import { planReturnedGoods } from "../orders/returns.server";

export const RETURN_GOODS_ERROR_KEYS = ["return_not_delivered", "return_exceeds_shipped", "location_invalid", "location_not_quarantine", "serials_required", "serial_not_on_line", "serials_count", "serial_not_in_quarantine", "insufficient_stock"] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");

// ───────────────────────────────────────────────────────────────── returned goods (at inspection)

export type ReturnGoodsTarget = { kind: "restock"; locationId?: string | null } | { kind: "quarantine"; locationId: string } | { kind: "scrap" };
export type ReturnGoodsLine = { orderItemId: string; qty: number; serialIds?: readonly string[] };

export type ReturnGoodsPlan = {
  statements: BatchStatement[];
  /** Units that came back (new stock units and used units). */
  units: number;
  /** Units without a known cost (posted at nothing, never at zero cost by guess). */
  uncostedUnits: number;
  /** [P] Known cost put back into stock or quarantine. */
  restockedCostIqd: number;
  /** [P] Known cost written off. */
  scrappedCostIqd: number;
};

/** A location a returned unit may go to: sellable for restock, NOT sellable for quarantine; always active. */
async function checkLocation(db: Db, locationId: string, sellable: boolean): Promise<void> {
  const location = ID_PATTERN.test(locationId)
    ? await db.select({ id: inventoryLocations.id, isSellable: inventoryLocations.isSellable, isActive: inventoryLocations.isActive }).from(inventoryLocations).where(eq(inventoryLocations.id, locationId)).get()
    : undefined;
  if (!location || !location.isActive) throw invalid({ locationId: "location_invalid" });
  if (location.isSellable !== sellable) throw invalid({ locationId: sellable ? "location_invalid" : "location_not_quarantine" });
}

async function journalExists(db: Db, key: string): Promise<boolean> {
  const row = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.idempotencyKey, key)).get();
  return row !== undefined;
}

/**
 * The statements that bring returned goods of a delivered order back (see the file header). Builds, never runs: the
 * caller adds its own guarded record update and audit event to the same batch. Needs returns.rma.inspect.
 */
export async function returnGoodsStatements(
  db: Db,
  input: { orderId: string; lines: readonly ReturnGoodsLine[]; to: ReturnGoodsTarget; actor: Actor; now: number; key: string; refType: string; refId: string; reason: string },
): Promise<ReturnGoodsPlan> {
  assertCan(input.actor, "returns.rma.inspect");
  const order = ID_PATTERN.test(input.orderId) ? await db.select().from(orders).where(eq(orders.id, input.orderId)).get() : undefined;
  if (!order) throw notFound("order");
  if (order.status !== "delivered" && order.status !== "returned") throw new AppError("return_not_delivered", 409, { detail: order.status });
  if (input.to.kind === "restock" && input.to.locationId) await checkLocation(db, input.to.locationId, true);
  if (input.to.kind === "quarantine") await checkLocation(db, input.to.locationId, false);

  const disposition = input.to.kind === "scrap" ? "scrap" : "restock";
  const locationId = input.to.kind === "scrap" ? null : (input.to.locationId ?? null);
  const plan = await planReturnedGoods(db, {
    orderId: order.id,
    lines: input.lines.map((line) => ({ orderItemId: line.orderItemId, qty: line.qty, disposition, serialIds: line.serialIds })),
    actor: input.actor,
    now: input.now,
    reason: input.reason,
    locationId,
  });
  const statements = [...plan.statements];

  if (input.to.kind === "quarantine") {
    // Serial-tracked units (and a used device's serial) wait in quarantine as 'returned', never as in_stock.
    const lineIds = input.lines.map((line) => line.orderItemId);
    const usedSerials = lineIds.length
      ? await db
          .select({ serialId: usedUnits.serialId })
          .from(orderItems)
          .innerJoin(usedUnits, eq(usedUnits.id, orderItems.usedUnitId))
          .where(inArray(orderItems.id, lineIds))
      : [];
    const serialIds = [...new Set([...input.lines.flatMap((line) => line.serialIds ?? []), ...usedSerials.map((row) => row.serialId).filter((id): id is string => typeof id === "string")])];
    if (serialIds.length > 0) {
      const json = JSON.stringify(serialIds);
      statements.push(
        batchSql(db, sql`UPDATE serials SET status = 'returned', location_id = ${input.to.locationId}, updated_at = ${input.now} WHERE id IN (SELECT value FROM json_each(${json})) AND status = 'in_stock'`),
        expectChanged(db, serialIds.length, { code: "SERIAL_NOT_RETURNABLE", detail: input.refId }),
      );
    }
  }

  const cogsPosted = await journalExists(db, cogsPostingKey(order.id));
  statements.push(
    ...postReturnedGoods(db, {
      key: input.key,
      refType: input.refType,
      refId: input.refId,
      orderId: order.id,
      ref: order.ref,
      restockedCostIqd: plan.restockedCostIqd,
      scrappedCostIqd: plan.scrappedCostIqd,
      cogsPosted,
      at: input.now,
      createdBy: postedBy(input.actor),
      isDemo: order.isDemo,
    }),
  );
  return { statements, units: plan.units, uncostedUnits: plan.uncostedUnits, restockedCostIqd: plan.restockedCostIqd, scrappedCostIqd: plan.scrappedCostIqd };
}

/** A failed returned-goods or quarantine batch as the AppError a screen can show; anything unexpected unchanged. */
export function translateReturnGoodsError(error: unknown): unknown {
  const posting = mapPostingError(error);
  if (posting) return posting;
  const info = mapDbError(error);
  switch (info?.code) {
    case "RETURN_EXCEEDS_SHIPPED":
    case "SERIAL_NOT_RETURNABLE":
      return new AppError("return_exceeds_shipped", 409, { detail: info.detail, cause: error });
    case "STOCK_CHANGED":
    case "INSUFFICIENT_STOCK":
      return new AppError("insufficient_stock", 409, { detail: info.detail, cause: error });
    case "QUARANTINE_SERIAL_CHANGED":
      return new AppError("serial_not_in_quarantine", 409, { detail: info.detail, fields: { serialIds: "serial_not_in_quarantine" }, cause: error });
    default:
      return toAppError(error) ?? error;
  }
}

// ───────────────────────────────────────────────────────────────── leaving quarantine

export const QUARANTINE_EXITS = ["stock", "scrap", "supplier"] as const;
export type QuarantineExit = (typeof QUARANTINE_EXITS)[number];

export const QuarantineExitInput = z.object({
  variantId: idSchema,
  /** The quarantine location the units sit in. */
  fromLocationId: idSchema,
  qty: z.number().int("invalid").min(1, "too_small").max(1000, "too_big"),
  /** Serial-tracked variants: one serial per unit, each 'returned' at `fromLocationId`. */
  serialIds: z.array(idSchema).max(1000).optional(),
  to: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("stock"), locationId: idSchema }),
    z.object({ kind: z.literal("scrap") }),
    z.object({ kind: z.literal("supplier"), reference: z.string().trim().min(1, "required").max(120, "too_long") }),
  ]),
  /** What the movements and the posting point at ("return_item" + its id). */
  refType: z.string().trim().min(1).max(40),
  refId: idSchema,
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
  /** One posting per exit: `<key>:exit` (a retry cannot post twice). */
  key: z.string().trim().min(8).max(200),
});
export type QuarantineExitInput = z.input<typeof QuarantineExitInput>;

export type QuarantineExitPlan = {
  statements: BatchStatement[];
  units: number;
  /** [P] Known cost of the units that moved (null when none of it is known). */
  costIqd: number | null;
  uncostedUnits: number;
};

function exitPermissions(actor: Actor, to: QuarantineExit): void {
  if (to === "supplier") return assertCan(actor, "returns.supplier_return.manage");
  assertCan(actor, "returns.rma.inspect");
  if (to === "scrap") assertCan(actor, "inventory.stock.adjust");
}

/** The statements that take units out of a quarantine location (see the file header). Builds, never runs. */
export async function quarantineExitStatements(db: Db, actor: Actor, raw: QuarantineExitInput, now: number): Promise<QuarantineExitPlan> {
  const input = QuarantineExitInput.parse(raw);
  exitPermissions(actor, input.to.kind);
  const toLocation = input.to.kind === "stock" ? input.to.locationId : null;
  if (toLocation === input.fromLocationId) throw invalid({ locationId: "location_invalid" });

  const [variant, from, level, layers, standard] = await db.batch([
    db.select({ id: variants.id, trackSerials: variants.trackSerials }).from(variants).where(eq(variants.id, input.variantId)),
    db.select({ id: inventoryLocations.id, isSellable: inventoryLocations.isSellable }).from(inventoryLocations).where(eq(inventoryLocations.id, input.fromLocationId)),
    db.select({ onHand: stockLevels.onHand, reserved: stockLevels.reserved }).from(stockLevels).where(and(eq(stockLevels.variantId, input.variantId), eq(stockLevels.locationId, input.fromLocationId))),
    db
      .select({ id: costLayers.id, qtyRemaining: costLayers.qtyRemaining, unitCostIqd: costLayers.unitCostIqd })
      .from(costLayers)
      .where(and(eq(costLayers.variantId, input.variantId), eq(costLayers.locationId, input.fromLocationId), sql`${costLayers.qtyRemaining} > 0`))
      .orderBy(asc(costLayers.receivedAt), asc(costLayers.id)),
    db.select({ landedCostIqd: variantCosts.landedCostIqd }).from(variantCosts).where(eq(variantCosts.variantId, input.variantId)),
  ]);
  if (!variant[0]) throw notFound("variant");
  if (!from[0]) throw notFound("location");
  if (from[0].isSellable) throw invalid({ locationId: "location_not_quarantine" });
  if (toLocation) await checkLocation(db, toLocation, true);

  const serialIds = [...new Set(input.serialIds ?? [])];
  if (variant[0].trackSerials) {
    if (serialIds.length === 0) throw invalid({ serialIds: "serials_required" });
    if (serialIds.length !== input.qty) throw invalid({ serialIds: "serials_count" });
    const rows = await db
      .select({ id: serials.id, variantId: serials.variantId, status: serials.status, locationId: serials.locationId })
      .from(serials)
      .where(inArray(serials.id, serialIds));
    for (const id of serialIds) {
      const row = rows.find((entry) => entry.id === id);
      if (!row || row.variantId !== input.variantId || row.status !== "returned" || row.locationId !== input.fromLocationId) throw invalid({ serialIds: "serial_not_in_quarantine" }, id);
    }
  } else if (serialIds.length > 0) {
    throw invalid({ serialIds: "serials_not_tracked" });
  }
  const onHand = level[0]?.onHand ?? 0;
  const reserved = level[0]?.reserved ?? 0;
  if (onHand - input.qty < reserved) throw new AppError("insufficient_stock", 409, { detail: input.variantId });

  const { actorKind, actorId } = actorRef(actor);
  const slices = takeFifo(layers, input.qty, standard[0]?.landedCostIqd ?? null);
  const statements: BatchStatement[] = [
    db
      .update(stockLevels)
      .set({ onHand: sql`${stockLevels.onHand} - ${input.qty}`, updatedAt: now })
      .where(and(eq(stockLevels.variantId, input.variantId), eq(stockLevels.locationId, input.fromLocationId), sql`${stockLevels.onHand} - ${input.qty} >= ${stockLevels.reserved}`)),
    expectChanged(db, 1, { code: "STOCK_CHANGED", detail: input.variantId }),
  ];
  const takes = new Map<string, number>();
  for (const slice of slices) if (slice.layerId) takes.set(slice.layerId, (takes.get(slice.layerId) ?? 0) + slice.qty);
  for (const [layerId, take] of takes) {
    statements.push(
      db
        .update(costLayers)
        .set({ qtyRemaining: sql`${costLayers.qtyRemaining} - ${take}` })
        .where(and(eq(costLayers.id, layerId), sql`${costLayers.qtyRemaining} >= ${take}`)),
      expectChanged(db, 1, { code: "COST_LAYER_CHANGED", detail: layerId }),
    );
  }

  const outKind = input.to.kind === "stock" ? "transfer_out" : input.to.kind === "scrap" ? "damage" : "adjust";
  const movements: NewStockMovement[] = [];
  const movement = (locationId: string, kind: NewStockMovement["kind"], qtyDelta: number, unitCostIqd: number | null, serialId: string | null): NewStockMovement => ({
    id: newId("mov"),
    variantId: input.variantId,
    locationId,
    serialId,
    kind,
    qtyDelta,
    reservedDelta: 0,
    unitCostIqd,
    refType: input.refType,
    refId: input.refId,
    reason: input.to.kind === "supplier" ? `${input.reason} (${input.to.reference})` : input.reason,
    actorKind,
    actorId,
    at: now,
  });
  const serialQueue = [...serialIds];
  let costIqd = 0;
  let uncostedUnits = 0;
  const newLayers: NewCostLayer[] = [];
  for (const slice of slices) {
    if (slice.unitCostIqd === null) uncostedUnits += slice.qty;
    else costIqd += slice.unitCostIqd * slice.qty;
    const units = variant[0].trackSerials ? serialQueue.splice(0, slice.qty).map((serialId) => ({ serialId: serialId as string | null, qty: 1 })) : [{ serialId: null as string | null, qty: slice.qty }];
    for (const unit of units) {
      movements.push(movement(input.fromLocationId, outKind, -unit.qty, slice.unitCostIqd, unit.serialId));
      if (toLocation) movements.push(movement(toLocation, "transfer_in", unit.qty, slice.unitCostIqd, unit.serialId));
    }
    if (toLocation && slice.unitCostIqd !== null) {
      newLayers.push({ id: newId("cly"), variantId: input.variantId, locationId: toLocation, qtyRemaining: slice.qty, qtyReceived: slice.qty, unitCostIqd: slice.unitCostIqd, receivedAt: now, receiptItemId: null, source: "return" });
    }
  }
  if (toLocation) {
    statements.push(
      db
        .insert(stockLevels)
        .values({ variantId: input.variantId, locationId: toLocation, onHand: input.qty, reserved: 0, updatedAt: now })
        .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { onHand: sql`${stockLevels.onHand} + ${input.qty}`, updatedAt: now } }),
      ...chunkRows(costLayers, newLayers).map((rows) => db.insert(costLayers).values(rows)),
    );
  }
  for (const rows of chunkRows(stockMovements, movements)) statements.push(db.insert(stockMovements).values(rows));

  if (serialIds.length > 0) {
    const json = JSON.stringify(serialIds);
    const update =
      input.to.kind === "stock"
        ? sql`UPDATE serials SET status = 'in_stock', location_id = ${toLocation}, updated_at = ${now} WHERE id IN (SELECT value FROM json_each(${json})) AND status = 'returned' AND location_id = ${input.fromLocationId}`
        : input.to.kind === "scrap"
          ? sql`UPDATE serials SET status = 'scrapped', updated_at = ${now} WHERE id IN (SELECT value FROM json_each(${json})) AND status = 'returned' AND location_id = ${input.fromLocationId}`
          : sql`UPDATE serials SET status = 'in_repair', location_id = NULL, updated_at = ${now} WHERE id IN (SELECT value FROM json_each(${json})) AND status = 'returned' AND location_id = ${input.fromLocationId}`;
    statements.push(batchSql(db, update), expectChanged(db, serialIds.length, { code: "QUARANTINE_SERIAL_CHANGED", detail: input.refId }));
  }

  // Books: the units leave inventory — written off, or owed back by the supplier. A move to sellable stock stays in inventory.
  if (input.to.kind !== "stock" && costIqd > 0) {
    statements.push(
      ...journalStatements(db, {
        at: now,
        memo: input.to.kind === "scrap" ? `Quarantine write-off ${input.refId}` : `Returned to supplier ${input.to.reference}`,
        refType: input.refType,
        refId: input.refId,
        createdBy: postedBy(actor),
        idempotencyKey: `${input.key}:exit`,
        lines: [
          { accountCode: input.to.kind === "scrap" ? "inventory_adjustments" : "accounts_payable", debitIqd: costIqd },
          { accountCode: "inventory", creditIqd: costIqd },
        ],
      }),
    );
  }
  return { statements, units: input.qty, costIqd: slices.every((slice) => slice.unitCostIqd === null) ? null : costIqd, uncostedUnits };
}

/**
 * Runs a quarantine exit with the caller's own statements (record update, guards, audit) AFTER the exit's in the same
 * batch — so a caller's guard sees the exit's movements (e.g. "this item left quarantine at most once") — re-planned up
 * to three times when another request consumed the same cost layers or stock meanwhile. Returns what moved.
 */
export async function exitQuarantine(db: Db, actor: Actor, raw: QuarantineExitInput, now: number, extra: (plan: QuarantineExitPlan) => BatchStatement[] = () => []): Promise<{ units: number; uncostedUnits: number }> {
  for (let attempt = 1; ; attempt++) {
    const plan = await quarantineExitStatements(db, actor, raw, now);
    try {
      await runBatch(db, [...plan.statements, ...extra(plan)]);
      return { units: plan.units, uncostedUnits: plan.uncostedUnits };
    } catch (error) {
      if (attempt < 3 && (isDbError(error, "COST_LAYER_CHANGED") || isDbError(error, "STOCK_CHANGED"))) continue;
      throw translateReturnGoodsError(error);
    }
  }
}

// ───────────────────────────────────────────────────────────────── refunds of a return

/**
 * Links a refund created by createRefund for a return to that return (refunds.return_id), so the money keeps its
 * original reference (blueprint entity rule). Only an unlinked refund of the same order is linked; repeating it is a
 * no-op. Moves no money.
 */
export function linkRefundStatements(db: Db, input: { refundId: string; returnId: string; orderId: string }): BatchStatement[] {
  return [
    db
      .update(refunds)
      .set({ returnId: input.returnId })
      .where(and(eq(refunds.id, input.refundId), eq(refunds.orderId, input.orderId), isNull(refunds.returnId))),
  ];
}
