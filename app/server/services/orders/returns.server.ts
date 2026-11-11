/**
 * Goods coming back from an order that was shipped — restocked or scrapped, as the caller decides
 * (a refund after inspection, or a parcel the courier brought back). Builds the statements for the
 * caller's batch; never runs anything itself.
 *
 *   const plan = await planReturnedGoods(db, { orderId, lines: [{ orderItemId, qty: 1, disposition: "restock" }], actor, now, reason: "refund:<id>" });
 *   await runBatch(db, [...plan.statements, ...postReturnedGoods(db, { …plan costs… })]);
 *
 * RULES
 *   · Only what left can come back: per stock variant, units returned (Σ 'return' movements of the
 *     order) never exceed units sold (Σ 'sale' movements of the order). Checked here and again by a
 *     guard inside the batch (TT:RETURN_EXCEEDS_SHIPPED:<variant id>) against concurrent returns.
 *   · Bundles come back as their components (the stock that left).
 *   · Costs [P] come from the order's own 'sale' movements, last units first (the units that left
 *     last come back first), so a restocked unit re-enters FIFO at the cost it left with: a new
 *     'return' cost layer. A unit whose cost was unknown comes back without a layer.
 *   · restock: on_hand += qty at the location it left from (or `locationId`), 'return' movements,
 *     serials back to in_stock.  scrap: a 'return' and a 'damage' movement (on hand unchanged),
 *     serials scrapped.  Serial links on the order line are released (released_at), keeping history.
 *   · Serial-tracked units are returned by serial: pass `serialIds`, or omit them when the whole
 *     line comes back (all its attached serials are taken).
 *   · Used units go to status 'returned' (the devices team inspects and lists them again); their
 *     serial goes back to in_stock (restock) or scrapped (scrap). Cost: the acquisition cost.
 *
 * Must not import "cloudflare:workers".
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "~/lib/ids";
import { actorRef, type Actor } from "~/server/actor";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { bundleItems, costLayers, inventoryLocations, orderItemSerials, orderItems, serials, stockLevels, stockMovements, usedUnits, variants, type NewStockMovement } from "~/server/db/schema";
import { batchSql, chunkRows, expectChanged, expectThat } from "~/server/db/tx.server";
import { AppError, invalid } from "~/server/errors";

export const RETURN_DISPOSITIONS = ["restock", "scrap"] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export type ReturnLine = { orderItemId: string; qty: number; disposition: ReturnDisposition; serialIds?: readonly string[] };

export type ReturnPlan = {
  statements: BatchStatement[];
  /** [P] Known cost of the units put back into stock. */
  restockedCostIqd: number;
  /** [P] Known cost of the units written off. */
  scrappedCostIqd: number;
  /** Units that came back without a known cost. */
  uncostedUnits: number;
  /** Units that came back (new stock units + used units). */
  units: number;
};

export const RETURN_ERROR_KEYS = ["return_exceeds_shipped", "serials_required", "serial_not_on_line", "location_invalid"] as const;

type Slice = { locationId: string; unitCostIqd: number | null; qty: number };

/** Takes `qty` units from the END of the sale slices, after skipping `skip` units already returned. */
function lastUnits(sales: readonly Slice[], skip: number, qty: number): Slice[] {
  const out: Slice[] = [];
  let toSkip = skip;
  let left = qty;
  for (let i = sales.length - 1; i >= 0 && left > 0; i--) {
    let available = sales[i].qty;
    const skipped = Math.min(available, toSkip);
    available -= skipped;
    toSkip -= skipped;
    if (available <= 0) continue;
    const take = Math.min(available, left);
    out.push({ locationId: sales[i].locationId, unitCostIqd: sales[i].unitCostIqd, qty: take });
    left -= take;
  }
  return out;
}

export async function planReturnedGoods(
  db: Db,
  input: { orderId: string; lines: readonly ReturnLine[]; actor: Actor; now: number; reason: string; locationId?: string | null },
): Promise<ReturnPlan> {
  const plan: ReturnPlan = { statements: [], restockedCostIqd: 0, scrappedCostIqd: 0, uncostedUnits: 0, units: 0 };
  const lines = input.lines.filter((line) => line.qty > 0);
  if (lines.length === 0) return plan;
  const { actorKind, actorId } = actorRef(input.actor);
  const lineIds = [...new Set(lines.map((line) => line.orderItemId))];
  if (lineIds.length !== lines.length) throw invalid({ items: "invalid" }, "an order line may be returned once per call");

  const [items, attached, saleRows] = await Promise.all([
    db
      .select({ id: orderItems.id, orderId: orderItems.orderId, variantId: orderItems.variantId, usedUnitId: orderItems.usedUnitId, qty: orderItems.qty })
      .from(orderItems)
      .where(inArray(orderItems.id, lineIds)),
    db
      .select({ orderItemId: orderItemSerials.orderItemId, serialId: orderItemSerials.serialId, variantId: serials.variantId, status: serials.status })
      .from(orderItemSerials)
      .innerJoin(serials, eq(serials.id, orderItemSerials.serialId))
      .where(and(inArray(orderItemSerials.orderItemId, lineIds), isNull(orderItemSerials.releasedAt))),
    db
      .select({ variantId: stockMovements.variantId, locationId: stockMovements.locationId, kind: stockMovements.kind, qtyDelta: stockMovements.qtyDelta, unitCostIqd: stockMovements.unitCostIqd, at: stockMovements.at, id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.refType, "order"), eq(stockMovements.refId, input.orderId), inArray(stockMovements.kind, ["sale", "return"])))
      .orderBy(stockMovements.at, stockMovements.id),
  ]);
  const itemById = new Map(items.map((item) => [item.id, item]));
  for (const line of lines) {
    const item = itemById.get(line.orderItemId);
    if (!item || item.orderId !== input.orderId) throw invalid({ items: "invalid" }, `order item ${line.orderItemId} is not on this order`);
    if (!Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > item.qty) throw invalid({ items: "invalid" }, `bad quantity for ${line.orderItemId}`);
    if (item.usedUnitId && line.qty !== 1) throw invalid({ items: "invalid" });
  }

  // What each line is made of in stock terms (bundles → components) and which variants track serials.
  const variantIds = [...new Set(items.filter((item) => !item.usedUnitId).map((item) => item.variantId))];
  const components = variantIds.length
    ? await db.select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, variantIds))
    : [];
  const componentsOf = new Map<string, { componentId: string; qty: number }[]>();
  for (const row of components) componentsOf.set(row.bundleId, [...(componentsOf.get(row.bundleId) ?? []), { componentId: row.componentId, qty: row.qty }]);
  const stockVariantIds = [...new Set([...variantIds.filter((id) => !componentsOf.has(id)), ...components.map((row) => row.componentId)])];
  const tracked = new Set(
    stockVariantIds.length
      ? (await db.select({ id: variants.id }).from(variants).where(and(inArray(variants.id, stockVariantIds), eq(variants.trackSerials, true)))).map((row) => row.id)
      : [],
  );

  // Sold and already-returned units per variant, with the cost slices of what was sold.
  const sales = new Map<string, Slice[]>();
  const returned = new Map<string, number>();
  for (const row of saleRows) {
    if (row.kind === "sale" && row.qtyDelta < 0) sales.set(row.variantId, [...(sales.get(row.variantId) ?? []), { locationId: row.locationId, unitCostIqd: row.unitCostIqd, qty: -row.qtyDelta }]);
    if (row.kind === "return" && row.qtyDelta > 0) returned.set(row.variantId, (returned.get(row.variantId) ?? 0) + row.qtyDelta);
  }

  if (input.locationId) {
    const location = await db.select({ id: inventoryLocations.id, isActive: inventoryLocations.isActive }).from(inventoryLocations).where(eq(inventoryLocations.id, input.locationId)).get();
    if (!location || !location.isActive) throw invalid({ locationId: "location_invalid" });
  }

  const movements: NewStockMovement[] = [];
  const levelAdds = new Map<string, { variantId: string; locationId: string; qty: number }>();
  const touchedVariants = new Set<string>();
  const movement = (variantId: string, locationId: string, kind: "return" | "damage" | "transfer_out" | "transfer_in", qty: number, unitCostIqd: number | null, serialId: string | null): NewStockMovement => ({
    id: newId("mov"),
    variantId,
    locationId,
    serialId,
    kind,
    qtyDelta: qty,
    reservedDelta: 0,
    unitCostIqd,
    refType: "order",
    refId: input.orderId,
    reason: input.reason,
    actorKind,
    actorId,
    at: input.now,
  });

  for (const line of lines) {
    const item = itemById.get(line.orderItemId)!;
    const restock = line.disposition === "restock";
    const lineSerials = attached.filter((row) => row.orderItemId === item.id);

    if (item.usedUnitId) {
      const unit = await db.select({ id: usedUnits.id, status: usedUnits.status, serialId: usedUnits.serialId, costIqd: usedUnits.acquisitionCostIqd }).from(usedUnits).where(eq(usedUnits.id, item.usedUnitId)).get();
      if (!unit || unit.status !== "sold") throw new AppError("return_exceeds_shipped", 409, { detail: item.usedUnitId });
      plan.statements.push(
        db.update(usedUnits).set({ status: "returned", updatedAt: input.now }).where(and(eq(usedUnits.id, unit.id), eq(usedUnits.status, "sold"))),
        expectChanged(db, 1, { code: "RETURN_EXCEEDS_SHIPPED", detail: unit.id }),
      );
      if (unit.serialId) {
        plan.statements.push(
          batchSql(db, sql`UPDATE serials SET status = ${restock ? "in_stock" : "scrapped"}, updated_at = ${input.now} WHERE id = ${unit.serialId} AND status = 'sold'`),
          batchSql(db, sql`UPDATE order_item_serials SET released_at = ${input.now} WHERE order_item_id = ${item.id} AND serial_id = ${unit.serialId} AND released_at IS NULL`),
        );
      }
      if (unit.costIqd === null) plan.uncostedUnits += 1;
      else if (restock) plan.restockedCostIqd += unit.costIqd;
      else plan.scrappedCostIqd += unit.costIqd;
      plan.units += 1;
      continue;
    }

    const parts = componentsOf.get(item.variantId) ?? [{ componentId: item.variantId, qty: 1 }];
    let chosenSerials: { serialId: string; variantId: string }[] = [];
    const trackedUnits = parts.filter((part) => tracked.has(part.componentId)).reduce((sum, part) => sum + part.qty * line.qty, 0);
    if (trackedUnits > 0) {
      if (line.serialIds && line.serialIds.length > 0) {
        const wanted = [...new Set(line.serialIds)];
        chosenSerials = wanted.map((serialId) => {
          const row = lineSerials.find((entry) => entry.serialId === serialId);
          if (!row) throw invalid({ items: "serial_not_on_line" }, serialId);
          return { serialId, variantId: row.variantId };
        });
      } else if (lineSerials.length === trackedUnits) {
        chosenSerials = lineSerials.map((row) => ({ serialId: row.serialId, variantId: row.variantId }));
      } else {
        throw invalid({ items: "serials_required" }, item.id);
      }
      for (const part of parts.filter((entry) => tracked.has(entry.componentId))) {
        if (chosenSerials.filter((entry) => entry.variantId === part.componentId).length !== part.qty * line.qty) throw invalid({ items: "serials_required" }, item.id);
      }
      if (chosenSerials.length !== trackedUnits) throw invalid({ items: "serials_required" }, item.id);
    }

    for (const part of parts) {
      const variantId = part.componentId;
      const units = part.qty * line.qty;
      const sold = (sales.get(variantId) ?? []).reduce((sum, slice) => sum + slice.qty, 0);
      const already = returned.get(variantId) ?? 0;
      if (already + units > sold) throw new AppError("return_exceeds_shipped", 409, { detail: variantId });
      const slices = lastUnits(sales.get(variantId) ?? [], already, units);
      returned.set(variantId, already + units);
      touchedVariants.add(variantId);

      const serialQueue = chosenSerials.filter((entry) => entry.variantId === variantId).map((entry) => entry.serialId);
      for (const slice of slices) {
        const locationId = input.locationId ?? slice.locationId;
        if (slice.unitCostIqd === null) plan.uncostedUnits += slice.qty;
        else if (restock) plan.restockedCostIqd += slice.unitCostIqd * slice.qty;
        else plan.scrappedCostIqd += slice.unitCostIqd * slice.qty;
        plan.units += slice.qty;
        // Serial-tracked units move one by one, so every movement names its unit.
        const perUnit = tracked.has(variantId) ? serialQueue.splice(0, slice.qty).map((serialId) => ({ serialId, qty: 1 })) : [{ serialId: null as string | null, qty: slice.qty }];
        for (const unit of perUnit) {
          movements.push(movement(variantId, slice.locationId, "return", unit.qty, slice.unitCostIqd, unit.serialId));
          if (!restock) movements.push(movement(variantId, slice.locationId, "damage", -unit.qty, slice.unitCostIqd, unit.serialId));
        }
        if (restock) {
          if (locationId !== slice.locationId) {
            // Returned to another location: it arrives where it left from and is moved over in the same batch.
            for (const unit of perUnit) {
              movements.push(movement(variantId, slice.locationId, "transfer_out", -unit.qty, slice.unitCostIqd, unit.serialId));
              movements.push(movement(variantId, locationId, "transfer_in", unit.qty, slice.unitCostIqd, unit.serialId));
            }
          }
          const key = `${variantId}|${locationId}`;
          const add = levelAdds.get(key) ?? { variantId, locationId, qty: 0 };
          add.qty += slice.qty;
          levelAdds.set(key, add);
          if (slice.unitCostIqd !== null) {
            plan.statements.push(
              db.insert(costLayers).values({ id: newId("cly"), variantId, locationId, qtyRemaining: slice.qty, qtyReceived: slice.qty, unitCostIqd: slice.unitCostIqd, receivedAt: input.now, receiptItemId: null, source: "return" }),
            );
          }
        }
      }
    }

    if (chosenSerials.length > 0) {
      const idsJson = JSON.stringify(chosenSerials.map((entry) => entry.serialId));
      const location = input.locationId ?? null;
      plan.statements.push(
        restock
          ? batchSql(db, sql`UPDATE serials SET status = 'in_stock', location_id = coalesce(${location}, location_id), updated_at = ${input.now} WHERE id IN (SELECT value FROM json_each(${idsJson})) AND status = 'sold'`)
          : batchSql(db, sql`UPDATE serials SET status = 'scrapped', updated_at = ${input.now} WHERE id IN (SELECT value FROM json_each(${idsJson})) AND status = 'sold'`),
        expectChanged(db, chosenSerials.length, { code: "SERIAL_NOT_RETURNABLE", detail: item.id }),
        batchSql(db, sql`UPDATE order_item_serials SET released_at = ${input.now} WHERE order_item_id = ${item.id} AND released_at IS NULL AND serial_id IN (SELECT value FROM json_each(${idsJson}))`),
        expectChanged(db, chosenSerials.length, { code: "SERIAL_NOT_RETURNABLE", detail: item.id }),
      );
    }
  }

  for (const add of levelAdds.values()) {
    plan.statements.push(
      db
        .insert(stockLevels)
        .values({ variantId: add.variantId, locationId: add.locationId, onHand: add.qty, reserved: 0, updatedAt: input.now })
        .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { onHand: sql`${stockLevels.onHand} + ${add.qty}`, updatedAt: input.now } }),
    );
  }
  for (const rows of chunkRows(stockMovements, movements)) plan.statements.push(db.insert(stockMovements).values(rows));
  // Against concurrent returns of the same order: never more back than went out.
  for (const variantId of touchedVariants) {
    plan.statements.push(
      expectThat(
        db,
        sql`(SELECT coalesce(sum(qty_delta), 0) FROM stock_movements WHERE ref_type = 'order' AND ref_id = ${input.orderId} AND variant_id = ${variantId} AND kind = 'return')
          <= (SELECT coalesce(-sum(qty_delta), 0) FROM stock_movements WHERE ref_type = 'order' AND ref_id = ${input.orderId} AND variant_id = ${variantId} AND kind = 'sale')`,
        { code: "RETURN_EXCEEDS_SHIPPED", detail: variantId },
      ),
    );
  }
  return plan;
}
