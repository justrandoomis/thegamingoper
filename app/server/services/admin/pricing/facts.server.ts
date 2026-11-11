/**
 * Facts the pricing services share: what a SKU costs (its own cost row, or the sum of its components for a bundle),
 * stock on hand, recent sales and refunds, and the age of the oldest stock. Read-only. Everything here is [P] or
 * derived from [P] data — callers decide what leaves the server (access.ts).
 */
import { and, eq, gt, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "~/server/db/drizzle.server";
import { bundleItems, costLayers, orderItems, orders, stockLevels, variantCosts } from "~/server/db/schema";
import type { CostBasis } from "./rules";
import { DAY_MS } from "./rules";

/** At most this many ids per IN (…) list, well under D1's 100 bound parameters. */
const CHUNK = 80;

export function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function inChunks<T>(ids: readonly string[], run: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (const part of chunks(unique)) out.push(...(await run(part)));
  return out;
}

export type CostRow = typeof variantCosts.$inferSelect;

export async function costRowsFor(db: Db, variantIds: readonly string[]): Promise<Map<string, CostRow>> {
  const rows = await inChunks(variantIds, (part) => db.select().from(variantCosts).where(inArray(variantCosts.variantId, part)));
  return new Map(rows.map((row) => [row.variantId, row]));
}

export type BundleComponent = { componentVariantId: string; qty: number };

export async function bundleComponentsFor(db: Db, variantIds: readonly string[]): Promise<Map<string, BundleComponent[]>> {
  const rows = await inChunks(variantIds, (part) =>
    db.select({ bundleVariantId: bundleItems.bundleVariantId, componentVariantId: bundleItems.componentVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, part)),
  );
  const out = new Map<string, BundleComponent[]>();
  for (const row of rows) {
    const list = out.get(row.bundleVariantId) ?? [];
    list.push({ componentVariantId: row.componentVariantId, qty: row.qty });
    out.set(row.bundleVariantId, list);
  }
  return out;
}

/**
 * The cost each SKU is priced against: its own `variant_costs` row; for a bundle without one, the sum of its
 * components' landed costs × quantity (only when EVERY component has a cost — a partial sum would understate it).
 * Null = no cost known: margins cannot be computed and are never shown as 0.
 */
export async function costBasisFor(db: Db, variantIds: readonly string[]): Promise<Map<string, CostBasis | null>> {
  const own = await costRowsFor(db, variantIds);
  const bundles = await bundleComponentsFor(db, variantIds.filter((id) => !own.has(id)));
  const componentIds = [...bundles.values()].flatMap((list) => list.map((component) => component.componentVariantId));
  const componentCosts = componentIds.length ? await costRowsFor(db, componentIds) : new Map<string, CostRow>();
  const out = new Map<string, CostBasis | null>();
  for (const id of variantIds) {
    const row = own.get(id);
    if (row) {
      out.set(id, { landedIqd: row.landedCostIqd, minMarginBps: row.minMarginBps, targetMarginBps: row.targetMarginBps, source: "own" });
      continue;
    }
    const components = bundles.get(id);
    if (components && components.length > 0 && components.every((component) => componentCosts.has(component.componentVariantId))) {
      const landedIqd = components.reduce((sum, component) => sum + componentCosts.get(component.componentVariantId)!.landedCostIqd * component.qty, 0);
      out.set(id, { landedIqd, minMarginBps: null, targetMarginBps: null, source: "bundle" });
      continue;
    }
    out.set(id, null);
  }
  return out;
}

/** Units on hand per SKU, all locations. */
export async function onHandFor(db: Db, variantIds: readonly string[]): Promise<Map<string, number>> {
  const rows = await inChunks(variantIds, (part) =>
    db
      .select({ variantId: stockLevels.variantId, onHand: sql<number>`coalesce(sum(${stockLevels.onHand}), 0)` })
      .from(stockLevels)
      .where(inArray(stockLevels.variantId, part))
      .groupBy(stockLevels.variantId),
  );
  return new Map(rows.map((row) => [row.variantId, Number(row.onHand)]));
}

export type SalesFacts = { unitsSold: number; unitsRefunded: number; soldIqd: number; lastSoldAt: number | null };

/** Orders that count as sales for pricing facts: real (not demo), not cancelled. */
const COUNTED = and(eq(orders.isDemo, false), notInArray(orders.status, ["cancelled"]));

/**
 * Units sold since `since` (orders not cancelled, demo orders excluded — docs/metrics.md §1), units refunded of
 * those lines, the money they brought (line totals) and the last sale.
 */
export async function salesFor(db: Db, variantIds: readonly string[], since: number): Promise<Map<string, SalesFacts>> {
  const rows = await inChunks(variantIds, (part) =>
    db
      .select({
        variantId: orderItems.variantId,
        unitsSold: sql<number>`coalesce(sum(${orderItems.qty}), 0)`,
        unitsRefunded: sql<number>`coalesce(sum(${orderItems.refundedQty}), 0)`,
        soldIqd: sql<number>`coalesce(sum(${orderItems.totalIqd}), 0)`,
        lastSoldAt: sql<number | null>`max(${orders.placedAt})`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(inArray(orderItems.variantId, part), gt(orders.placedAt, since), COUNTED, sql`${orderItems.usedUnitId} IS NULL`))
      .groupBy(orderItems.variantId),
  );
  return new Map(rows.map((row) => [row.variantId, { unitsSold: Number(row.unitsSold), unitsRefunded: Number(row.unitsRefunded), soldIqd: Number(row.soldIqd), lastSoldAt: row.lastSoldAt === null ? null : Number(row.lastSoldAt) }]));
}

/** Age in whole days of the oldest stock still on hand (FIFO layers with units left). [P]-derived. */
export async function oldestStockDaysFor(db: Db, variantIds: readonly string[], now: number): Promise<Map<string, number>> {
  const rows = await inChunks(variantIds, (part) =>
    db
      .select({ variantId: costLayers.variantId, oldest: sql<number>`min(${costLayers.receivedAt})` })
      .from(costLayers)
      .where(and(inArray(costLayers.variantId, part), gt(costLayers.qtyRemaining, 0), isNotNull(costLayers.receivedAt)))
      .groupBy(costLayers.variantId),
  );
  return new Map(rows.map((row) => [row.variantId, Math.max(0, Math.floor((now - Number(row.oldest)) / DAY_MS))]));
}

/** FIFO layers still holding units, oldest first. [P] — only for actors with cost.read. */
export async function openLayersFor(db: Db, variantId: string) {
  return db
    .select({ id: costLayers.id, qtyRemaining: costLayers.qtyRemaining, qtyReceived: costLayers.qtyReceived, unitCostIqd: costLayers.unitCostIqd, receivedAt: costLayers.receivedAt, source: costLayers.source })
    .from(costLayers)
    .where(and(eq(costLayers.variantId, variantId), gt(costLayers.qtyRemaining, 0)))
    .orderBy(costLayers.receivedAt);
}
