/**
 * Stock — availability, reservations, sale commits, adjustments, receipts, serials and used units
 * (docs/CONTRACTS.md §1, ARCHITECTURE §7.1–7.2). The one place that moves `stock_levels`.
 *
 *   const availability = await getAvailability(db, ["var_ps5-slim-disc"]);        // Map → { available, state }
 *   await runBatch(db, [insertOrder, ...reserveStatements(db, { orderId, lines, expiresAt, actor, now }), audit]);
 *   await releaseOrderReservations(db, actor, orderId, "cancelled", now);          // cancel / expiry / rejection
 *   await commitOrderReservations(db, actor, orderId, now);                        // on shipment: FIFO cost, 'sale' movements
 *   await expireReservations(db, now);                                             // scheduled job
 *
 * RULES
 *   · available = Σ over sellable, active locations of max(on_hand − reserved, 0). A location that
 *     is oversold (negative, allowed by an authorised adjustment) does not eat into the free units
 *     of another location: a reservation is always taken from free units, so this is exactly what
 *     reserveStatements can reserve. Shoppers never see the number, only the state.
 *   · state: out_of_stock at 0; low_stock at or below the reorder point (Σ of the reorder points
 *     set on the sellable levels; 3 when none is set); otherwise in_stock. This module never answers
 *     "preorder" — pre-orders are an order-flow decision (products.preorder_release_at).
 *   · Bundles (variants with `bundle_items`) have no stock of their own: their availability is how
 *     many complete sets the components allow, and reserving a bundle reserves its components.
 *     One level only: a component is a stocked variant, not another bundle.
 *   · Reservations never oversell. A shortage aborts the whole batch with TT:INSUFFICIENT_STOCK:<line
 *     variant id> (the stock_levels trigger is the backstop for anything else), which toAppError
 *     turns into AppError("insufficient_stock", 409, { detail: variantId }).
 *   · Every change to stock_levels is written together with its stock_movements rows in ONE batch.
 *     Movements, cost layers and costs are [P]: never returned to shoppers.
 *   · Selling into negative stock (oversell) is only possible through adjustStock by an employee
 *     holding inventory.oversell.authorize who asks for it explicitly, with a reason.
 *
 * Used units are one-of-a-kind and outside the quantity counts of new stock: they are reserved and
 * sold through their status (listed → reserved → sold) by guarded updates, never through stock_levels.
 *
 * Authorization: adjustStock and receiveStock check permissions themselves. The reservation
 * primitives (reserve / release / commit / serials) are building blocks of the order services,
 * which authorize the action (place, cancel, ship) before calling them; the actor is recorded on
 * every movement and audit event.
 *
 * This module must not import "cloudflare:workers" (tests run it against a local D1).
 */
import { and, asc, eq, gte, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { StockState } from "~/lib/dto";
import { newId } from "~/lib/ids";
import { actorRef, assertCan, canAny, systemActor, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  bundleItems,
  costLayers,
  inventoryLocations,
  orderItemSerials,
  orderItems,
  serials,
  stockLevels,
  stockMovements,
  stockReservations,
  usedUnits,
  variantCosts,
  variants,
  type NewCostLayer,
  type NewSerial,
  type NewStockMovement,
} from "~/server/db/schema";
import { batchSql, chunkRows, expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { costOfSlices, takeFifo, type CostLayerState, type FifoSlice } from "./fifo";

// ───────────────────────────────────────────────────────────────── constants and shared bits

/** Low-stock threshold when no reorder point is set. */
export const DEFAULT_LOW_STOCK = 3;

/** Error keys this module produces (translated through `errors.<key>` by whoever owns those strings). */
export const STOCK_ERROR_KEYS = ["insufficient_stock", "serial_not_available", "serial_count_exceeds_qty", "used_unit_not_available", "serial_tracked", "serials_required", "serials_count", "serials_duplicate", "serials_not_tracked", "serial_duplicate"] as const;

export type Availability = { available: number; state: StockState };

/** Ids in this codebase: prefixed ULIDs ("var_01J…") or the seeds' readable ids ("var_ps5-slim-disc"). */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");

/** A table name or alias inside raw SQL (only ever a constant from this file). */
const tableAlias = (alias: string) => sql.raw(alias);

function assertId(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${what}: invalid id ${JSON.stringify(value)}`);
  return value;
}

function assertTime(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${what}: expected epoch milliseconds, got ${String(value)}`);
  return value;
}

/** The state shoppers see for an available quantity. */
export function stockStateOf(available: number, lowThreshold: number = DEFAULT_LOW_STOCK): StockState {
  if (available <= 0) return "out_of_stock";
  return available <= lowThreshold ? "low_stock" : "in_stock";
}

// ───────────────────────────────────────────────────────────────── availability

/**
 * Availability of each variant (duplicates and unknown ids are fine; unknown ids come back as
 * out of stock). Never send `available` to shoppers — show `state`.
 */
export async function getAvailability(db: Db, variantIds: readonly string[]): Promise<Map<string, Availability>> {
  const ids = [...new Set(variantIds.filter((value) => typeof value === "string" && value.length > 0))];
  const result = new Map<string, Availability>();
  if (ids.length === 0) return result;
  const idsJson = JSON.stringify(ids);

  const componentQuery = db
    .select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty })
    .from(bundleItems)
    .where(sql`${bundleItems.bundleVariantId} IN (SELECT value FROM json_each(${idsJson}))`);
  const levelQuery = db
    .select({
      variantId: stockLevels.variantId,
      // Aliased: inside db.batch Drizzle maps rows by column name.
      free: sql<number>`sum(max(${stockLevels.onHand} - ${stockLevels.reserved}, 0))`.as("free"),
      reorderSum: sql<number | null>`sum(${stockLevels.reorderPoint})`.as("reorder_sum"),
      reorderCount: sql<number>`count(${stockLevels.reorderPoint})`.as("reorder_count"),
    })
    .from(stockLevels)
    .innerJoin(inventoryLocations, eq(inventoryLocations.id, stockLevels.locationId))
    .where(
      and(
        eq(inventoryLocations.isSellable, true),
        eq(inventoryLocations.isActive, true),
        sql`${stockLevels.variantId} IN (SELECT value FROM json_each(${idsJson}) UNION SELECT component_variant_id FROM bundle_items WHERE bundle_variant_id IN (SELECT value FROM json_each(${idsJson})))`,
      ),
    )
    .groupBy(stockLevels.variantId);
  const [components, levels] = await db.batch([componentQuery, levelQuery]);

  const byVariant = new Map(levels.map((row) => [row.variantId, row]));
  const componentsOf = new Map<string, { componentId: string; qty: number }[]>();
  for (const row of components) {
    const list = componentsOf.get(row.bundleId) ?? [];
    list.push({ componentId: row.componentId, qty: row.qty });
    componentsOf.set(row.bundleId, list);
  }

  for (const id of ids) {
    const parts = componentsOf.get(id);
    if (parts && parts.length > 0) {
      // Complete sets only: the scarcest component decides.
      const sets = Math.min(...parts.map((part) => Math.floor(Math.max(0, Number(byVariant.get(part.componentId)?.free ?? 0)) / Math.max(1, part.qty))));
      result.set(id, { available: sets, state: stockStateOf(sets, DEFAULT_LOW_STOCK) });
      continue;
    }
    const row = byVariant.get(id);
    const available = Math.max(0, Number(row?.free ?? 0));
    const threshold = row && Number(row.reorderCount) > 0 ? Number(row.reorderSum ?? 0) : DEFAULT_LOW_STOCK;
    result.set(id, { available, state: stockStateOf(available, threshold) });
  }
  return result;
}

// ───────────────────────────────────────────────────────────────── reservations

export type ReserveLine = { variantId: string; qty: number };
export type ReserveInput = {
  orderId: string;
  /** Order lines of NEW stock (not used units). Bundle lines reserve their components. */
  lines: readonly ReserveLine[];
  /** When an unpaid hold ends (transfer orders); null = held until shipped or cancelled. */
  expiresAt: number | null;
  actor: Actor;
  now: number;
};

/** What each line needs from stock, with bundles expanded into components (SQL, used inside the batch). */
function needCte(linesJson: string): SQL {
  return sql`lines(variant_id, qty) AS (
      SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]') FROM json_each(${linesJson}) AS j
    ),
    need(variant_id, qty) AS (
      SELECT x.variant_id, SUM(x.qty) FROM (
        SELECT COALESCE(b.component_variant_id, l.variant_id) AS variant_id, l.qty * COALESCE(b.qty, 1) AS qty
        FROM lines AS l LEFT JOIN bundle_items AS b ON b.bundle_variant_id = l.variant_id
      ) AS x
      GROUP BY x.variant_id
    )`;
}

/**
 * Batch statements that reserve stock for an order: `stock_reservations` rows, `reserved += qty` on
 * the levels they come from, and one 'reserve' movement per row. Synchronous on purpose — put the
 * result inside the order's own batch.
 *
 * Inside the batch, each needed variant is taken from the sellable locations with the most free
 * units first (several locations when one is not enough). If the free units cannot cover a line,
 * a guard aborts the WHOLE batch with TT:INSUFFICIENT_STOCK:<line variant id>, so nothing of the
 * order is stored. Two orders racing for the last unit: the batches run one after the other, the
 * second finds nothing free and fails.
 */
export function reserveStatements(db: Db, input: ReserveInput): BatchStatement[] {
  const orderId = assertId(input.orderId, "reserveStatements.orderId");
  const now = assertTime(input.now, "reserveStatements.now");
  const expiresAt = input.expiresAt === null ? null : assertTime(input.expiresAt, "reserveStatements.expiresAt");
  if (!Array.isArray(input.lines)) throw new Error("reserveStatements: lines must be an array");
  const merged = new Map<string, number>();
  for (const line of input.lines) {
    const variantId = assertId(line?.variantId, "reserveStatements.lines.variantId");
    if (!Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > 100_000) throw new Error(`reserveStatements: invalid qty ${String(line.qty)} for ${variantId}`);
    merged.set(variantId, (merged.get(variantId) ?? 0) + line.qty);
  }
  if (merged.size === 0) return [];

  const linesJson = JSON.stringify([...merged].map(([variantId, qty]) => [variantId, qty]));
  const resBase = newId("res");
  const prefix = `${resBase}.`;
  const movBase = newId("mov");
  const { actorKind, actorId } = actorRef(input.actor);
  /** The reservation rows THIS call inserts (ids `<resBase>.<n>`). */
  const mine = (alias: string) => sql`${tableAlias(alias)}.order_id = ${orderId} AND substr(${tableAlias(alias)}.id, 1, ${prefix.length}) = ${prefix}`;

  const statements: BatchStatement[] = [
    batchSql(
      db,
      sql`WITH ${needCte(linesJson)},
        pool AS (
          SELECT s.variant_id, s.location_id, max(s.on_hand - s.reserved, 0) AS free,
                 ROW_NUMBER() OVER (PARTITION BY s.variant_id ORDER BY max(s.on_hand - s.reserved, 0) DESC, loc.sort, loc.id) AS rank
          FROM stock_levels AS s JOIN inventory_locations AS loc ON loc.id = s.location_id
          WHERE loc.is_sellable = 1 AND loc.is_active = 1 AND s.variant_id IN (SELECT variant_id FROM need)
        ),
        fill AS (
          SELECT p.variant_id, p.location_id, p.rank,
                 min(p.free, max(n.qty - coalesce(SUM(p.free) OVER (PARTITION BY p.variant_id ORDER BY p.rank ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0)) AS take
          FROM pool AS p JOIN need AS n ON n.variant_id = p.variant_id
        )
      INSERT INTO stock_reservations (id, order_id, variant_id, location_id, qty, status, expires_at, created_at)
      SELECT ${resBase} || '.' || ROW_NUMBER() OVER (ORDER BY f.variant_id, f.rank), ${orderId}, f.variant_id, f.location_id, f.take, 'active', ${expiresAt}, ${now}
      FROM fill AS f
      WHERE f.take > 0`,
    ),
  ];

  // One guard per line: every variant the line needs (its components, for a bundle) is fully covered.
  for (const variantId of merged.keys()) {
    statements.push(
      expectThat(
        db,
        sql`NOT EXISTS (
          WITH ${needCte(linesJson)}
          SELECT 1 FROM need AS n
          WHERE n.variant_id IN (
                  SELECT component_variant_id FROM bundle_items WHERE bundle_variant_id = ${variantId}
                  UNION ALL
                  SELECT ${variantId} WHERE NOT EXISTS (SELECT 1 FROM bundle_items WHERE bundle_variant_id = ${variantId})
                )
            AND n.qty > (SELECT coalesce(SUM(r.qty), 0) FROM stock_reservations AS r WHERE ${mine("r")} AND r.variant_id = n.variant_id)
        )`,
        { code: "INSUFFICIENT_STOCK", detail: variantId },
      ),
    );
  }

  statements.push(
    batchSql(
      db,
      sql`UPDATE stock_levels
        SET reserved = reserved + (SELECT SUM(r.qty) FROM stock_reservations AS r WHERE ${mine("r")} AND r.variant_id = stock_levels.variant_id AND r.location_id = stock_levels.location_id),
            updated_at = ${now}
        WHERE EXISTS (SELECT 1 FROM stock_reservations AS r WHERE ${mine("r")} AND r.variant_id = stock_levels.variant_id AND r.location_id = stock_levels.location_id)`,
    ),
    batchSql(
      db,
      sql`INSERT INTO stock_movements (id, variant_id, location_id, kind, qty_delta, reserved_delta, ref_type, ref_id, reason, actor_kind, actor_id, at)
        SELECT ${movBase} || substr(r.id, ${prefix.length}), r.variant_id, r.location_id, 'reserve', 0, r.qty, 'order', r.order_id, NULL, ${actorKind}, ${actorId}, ${now}
        FROM stock_reservations AS r
        WHERE ${mine("r")}`,
    ),
  );
  return statements;
}

type ReleaseOptions = { status: "released" | "expired"; reason: string | null; actor: Actor; now: number };

/** Statements that release every reservation matched by `filter` (an SQL condition on the given table alias). */
function releaseMatching(db: Db, filter: (alias: string) => SQL, options: ReleaseOptions): BatchStatement[] {
  const movBase = newId("mov");
  const { actorKind, actorId } = actorRef(options.actor);
  return [
    // Movements and levels first: they read the rows that are still active.
    batchSql(
      db,
      sql`INSERT INTO stock_movements (id, variant_id, location_id, kind, qty_delta, reserved_delta, ref_type, ref_id, reason, actor_kind, actor_id, at)
        SELECT ${movBase} || '.' || ROW_NUMBER() OVER (ORDER BY r.id), r.variant_id, r.location_id, 'release', 0, -r.qty, 'order', r.order_id, ${options.reason}, ${actorKind}, ${actorId}, ${options.now}
        FROM stock_reservations AS r
        WHERE ${filter("r")}`,
    ),
    batchSql(
      db,
      sql`UPDATE stock_levels
        SET reserved = reserved - (SELECT SUM(r.qty) FROM stock_reservations AS r WHERE ${filter("r")} AND r.variant_id = stock_levels.variant_id AND r.location_id = stock_levels.location_id),
            updated_at = ${options.now}
        WHERE EXISTS (SELECT 1 FROM stock_reservations AS r WHERE ${filter("r")} AND r.variant_id = stock_levels.variant_id AND r.location_id = stock_levels.location_id)`,
    ),
    batchSql(db, sql`UPDATE stock_reservations SET status = ${options.status}, released_at = ${options.now} WHERE ${filter("stock_reservations")}`),
  ];
}

/**
 * Statements that put an order's used units back on sale (reserved → listed, their serial back to
 * in_stock). A unit that another live order holds is left alone, so a repeated release cannot free
 * a unit someone else has reserved since.
 */
function releaseUsedUnitsOfOrderStatements(db: Db, orderId: string, now: number): BatchStatement[] {
  const units = sql`(
    SELECT oi.used_unit_id FROM order_items AS oi
    WHERE oi.order_id = ${orderId} AND oi.used_unit_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM order_items AS other JOIN orders AS o ON o.id = other.order_id
        WHERE other.used_unit_id = oi.used_unit_id AND other.order_id <> ${orderId} AND o.status NOT IN ('cancelled', 'returned')
      )
  )`;
  return [
    batchSql(db, sql`UPDATE serials SET status = 'in_stock', updated_at = ${now} WHERE status = 'reserved' AND id IN (SELECT serial_id FROM used_units WHERE status = 'reserved' AND serial_id IS NOT NULL AND id IN ${units})`),
    batchSql(db, sql`UPDATE used_units SET status = 'listed', updated_at = ${now} WHERE status = 'reserved' AND id IN ${units}`),
  ];
}

function checkReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) throw invalid({ reason: "required" });
  return reason.trim().slice(0, 500);
}

/**
 * Statements that release everything an order holds — its active stock reservations (status
 * 'released', reserved −= qty, 'release' movements) and its reserved used units — plus an audit
 * event. Synchronous: put them in the cancel / rejection batch. Releasing twice is harmless.
 */
export function releaseOrderReservationsStatements(db: Db, input: { orderId: string; actor: Actor; reason: string; now: number }): BatchStatement[] {
  const orderId = assertId(input.orderId, "releaseOrderReservations.orderId");
  const now = assertTime(input.now, "releaseOrderReservations.now");
  const reason = checkReason(input.reason);
  const active = (alias: string) => sql`${tableAlias(alias)}.order_id = ${orderId} AND ${tableAlias(alias)}.status = 'active'`;
  return [
    ...releaseMatching(db, active, { status: "released", reason, actor: input.actor, now }),
    ...releaseUsedUnitsOfOrderStatements(db, orderId, now),
    auditStatement(db, { actor: input.actor, action: "inventory.reservation.release", entityType: "order", entityId: orderId, reason, at: now }),
  ];
}

/** Releases everything an order holds (cancel / expiry / rejection). Returns how many stock reservations were released. */
export async function releaseOrderReservations(db: Db, actor: Actor, orderId: string, reason: string, now: number): Promise<{ released: number }> {
  const statements = releaseOrderReservationsStatements(db, { orderId, actor, reason, now });
  const results = await runBatch(db, statements);
  return { released: changesOf(results[2]) };
}

const EXPIRE_BATCH = 200;
const EXPIRE_ROUNDS = 5;

/**
 * Scheduled job: releases active stock reservations whose `expires_at` has passed (status
 * 'expired'), up to 1,000 per call, oldest first. Only stock is released here — what happens to the
 * order (cancel, reminder) and to used units it holds is the order flow's decision.
 */
export async function expireReservations(db: Db, now: number): Promise<{ released: number }> {
  assertTime(now, "expireReservations.now");
  const actor = systemActor("inventory.reservations.expire");
  let released = 0;
  for (let round = 0; round < EXPIRE_ROUNDS; round++) {
    const due = await db
      .select({ id: stockReservations.id, orderId: stockReservations.orderId })
      .from(stockReservations)
      .where(and(eq(stockReservations.status, "active"), isNotNull(stockReservations.expiresAt), lte(stockReservations.expiresAt, now)))
      .orderBy(asc(stockReservations.expiresAt), asc(stockReservations.id))
      .limit(EXPIRE_BATCH);
    if (due.length === 0) break;
    const idsJson = JSON.stringify(due.map((row) => row.id));
    const chosen = (alias: string) => sql`${tableAlias(alias)}.id IN (SELECT value FROM json_each(${idsJson})) AND ${tableAlias(alias)}.status = 'active'`;
    const statements = [
      ...releaseMatching(db, chosen, { status: "expired", reason: "reservation_expired", actor, now }),
      // Every chosen row must still have been active; otherwise someone released one meanwhile — start over.
      expectChanged(db, due.length, { code: "RESERVATION_CHANGED", detail: "expire" }),
      auditStatement(db, {
        actor,
        action: "inventory.reservation.expire",
        entityType: "stock_reservation",
        summary: `${due.length} expired reservation(s) released`,
        after: { reservationIds: due.map((row) => row.id), orderIds: [...new Set(due.map((row) => row.orderId))] },
        at: now,
      }),
    ];
    try {
      await runBatch(db, statements);
    } catch (error) {
      if (isDbError(error, "RESERVATION_CHANGED")) continue;
      throw error;
    }
    released += due.length;
    if (due.length < EXPIRE_BATCH) break;
  }
  return { released };
}

// ───────────────────────────────────────────────────────────────── commit (shipment)

export type CommitResult = {
  /** Stock reservations committed. */
  reservations: number;
  /** Units of new stock that left (sum of committed quantities). */
  units: number;
  /** Used units sold. */
  usedUnits: number;
  /** [P] Cost of goods sold: FIFO layers, standard cost where no layer was left, used units' acquisition cost. Null when any unit's cost is unknown. */
  cogsIqd: number | null;
  /** Units no cost layer covered (costed at the standard cost, or uncosted). */
  unitsWithoutLayer: number;
};

type CommitPlan = { statements: BatchStatement[]; result: CommitResult };

const EMPTY_COMMIT: CommitResult = { reservations: 0, units: 0, usedUnits: 0, cogsIqd: 0, unitsWithoutLayer: 0 };

/**
 * Reads the order's active reservations and reserved used units, works out the FIFO cost, and
 * returns the statements that commit them (for a shipment batch built by the order service) with
 * the result they will have. The statements are guarded: if anything they rely on changed before the
 * batch runs, the batch fails with RESERVATION_CHANGED / COST_LAYER_CHANGED / USED_UNIT_CHANGED and
 * the caller plans again (commitOrderReservations does that for you).
 */
export async function commitOrderReservationsStatements(db: Db, actor: Actor, orderId: string, now: number): Promise<CommitPlan> {
  assertId(orderId, "commitOrderReservations.orderId");
  assertTime(now, "commitOrderReservations.now");
  const { actorKind, actorId } = actorRef(actor);

  // Two plain queries, not one db.batch: inside a batch Drizzle maps rows by column NAME, and this
  // join has two columns called "id" (order_items.id, used_units.id), which would shift every field.
  const [reservations, usedLines] = await Promise.all([
    db
      .select({ id: stockReservations.id, variantId: stockReservations.variantId, locationId: stockReservations.locationId, qty: stockReservations.qty })
      .from(stockReservations)
      .where(and(eq(stockReservations.orderId, orderId), eq(stockReservations.status, "active")))
      .orderBy(asc(stockReservations.id)),
    db
      .select({ orderItemId: orderItems.id, usedUnitId: usedUnits.id, variantId: usedUnits.variantId, serialId: usedUnits.serialId, costIqd: usedUnits.acquisitionCostIqd })
      .from(orderItems)
      .innerJoin(usedUnits, eq(usedUnits.id, orderItems.usedUnitId))
      .where(and(eq(orderItems.orderId, orderId), eq(usedUnits.status, "reserved")))
      .orderBy(asc(orderItems.id)),
  ]);
  if (reservations.length === 0 && usedLines.length === 0) return { statements: [], result: { ...EMPTY_COMMIT } };

  const variantIds = [...new Set(reservations.map((row) => row.variantId))];
  const variantsJson = JSON.stringify(variantIds);
  const [layers, standard] =
    variantIds.length === 0
      ? [[], []]
      : await db.batch([
          db
            .select({ id: costLayers.id, variantId: costLayers.variantId, locationId: costLayers.locationId, qtyRemaining: costLayers.qtyRemaining, unitCostIqd: costLayers.unitCostIqd })
            .from(costLayers)
            .where(and(sql`${costLayers.variantId} IN (SELECT value FROM json_each(${variantsJson}))`, sql`${costLayers.qtyRemaining} > 0`))
            .orderBy(asc(costLayers.receivedAt), asc(costLayers.id)),
          db
            .select({ variantId: variantCosts.variantId, landedCostIqd: variantCosts.landedCostIqd })
            .from(variantCosts)
            .where(sql`${variantCosts.variantId} IN (SELECT value FROM json_each(${variantsJson}))`),
        ]);

  const queues = new Map<string, CostLayerState[]>();
  for (const layer of layers) {
    const key = `${layer.variantId}|${layer.locationId}`;
    const queue = queues.get(key) ?? [];
    queue.push({ id: layer.id, qtyRemaining: layer.qtyRemaining, unitCostIqd: layer.unitCostIqd });
    queues.set(key, queue);
  }
  const standardCost = new Map(standard.map((row) => [row.variantId, row.landedCostIqd]));

  const movementRows: NewStockMovement[] = [];
  const layerTakes = new Map<string, number>();
  const levelTakes = new Map<string, { variantId: string; locationId: string; qty: number }>();
  const allSlices: FifoSlice[] = [];
  let units = 0;
  for (const reservation of reservations) {
    const key = `${reservation.variantId}|${reservation.locationId}`;
    const slices = takeFifo(queues.get(key) ?? [], reservation.qty, standardCost.get(reservation.variantId) ?? null);
    slices.forEach((slice, index) => {
      allSlices.push(slice);
      if (slice.layerId) layerTakes.set(slice.layerId, (layerTakes.get(slice.layerId) ?? 0) + slice.qty);
      movementRows.push({
        id: `${reservation.id}.sale.${index + 1}`,
        variantId: reservation.variantId,
        locationId: reservation.locationId,
        kind: "sale",
        qtyDelta: -slice.qty,
        reservedDelta: -slice.qty,
        unitCostIqd: slice.unitCostIqd,
        refType: "order",
        refId: orderId,
        reason: slice.fallback ? (slice.unitCostIqd === null ? "no_cost_layer_uncosted" : "no_cost_layer_standard_cost") : null,
        actorKind,
        actorId,
        at: now,
      });
    });
    const level = levelTakes.get(key) ?? { variantId: reservation.variantId, locationId: reservation.locationId, qty: 0 };
    level.qty += reservation.qty;
    levelTakes.set(key, level);
    units += reservation.qty;
  }

  const statements: BatchStatement[] = [];
  for (const [layerId, take] of layerTakes) {
    statements.push(
      db
        .update(costLayers)
        .set({ qtyRemaining: sql`${costLayers.qtyRemaining} - ${take}` })
        .where(and(eq(costLayers.id, layerId), gte(costLayers.qtyRemaining, take))),
      expectChanged(db, 1, { code: "COST_LAYER_CHANGED", detail: layerId }),
    );
  }
  if (reservations.length > 0) {
    const idsJson = JSON.stringify(reservations.map((row) => row.id));
    statements.push(
      batchSql(db, sql`UPDATE stock_reservations SET status = 'committed', released_at = ${now} WHERE id IN (SELECT value FROM json_each(${idsJson})) AND status = 'active'`),
      expectChanged(db, reservations.length, { code: "RESERVATION_CHANGED", detail: orderId }),
    );
  }
  for (const level of levelTakes.values()) {
    statements.push(
      db
        .update(stockLevels)
        .set({ onHand: sql`${stockLevels.onHand} - ${level.qty}`, reserved: sql`${stockLevels.reserved} - ${level.qty}`, updatedAt: now })
        .where(and(eq(stockLevels.variantId, level.variantId), eq(stockLevels.locationId, level.locationId))),
      expectChanged(db, 1, { code: "RESERVATION_CHANGED", detail: `${level.variantId}@${level.locationId}` }),
    );
  }
  for (const rows of chunkRows(stockMovements, movementRows)) statements.push(db.insert(stockMovements).values(rows));

  let usedCost: number | null = 0;
  for (const line of usedLines) {
    statements.push(
      db
        .update(usedUnits)
        .set({ status: "sold", soldOrderItemId: line.orderItemId, soldAt: now, updatedAt: now })
        .where(and(eq(usedUnits.id, line.usedUnitId), eq(usedUnits.status, "reserved"))),
      expectChanged(db, 1, { code: "USED_UNIT_CHANGED", detail: line.usedUnitId }),
    );
    if (line.serialId) {
      // The packer may already have scanned it (assignSerialsStatements); otherwise attach it now.
      statements.push(
        batchSql(db, sql`UPDATE serials SET status = 'sold', updated_at = ${now} WHERE id = ${line.serialId} AND status IN ('in_stock', 'reserved')`),
        batchSql(
          db,
          sql`INSERT INTO order_item_serials (order_item_id, serial_id, attached_at, attached_by)
            SELECT ${line.orderItemId}, ${line.serialId}, ${now}, ${actorId}
            WHERE NOT EXISTS (SELECT 1 FROM order_item_serials WHERE serial_id = ${line.serialId} AND released_at IS NULL)`,
        ),
        expectThat(
          db,
          sql`EXISTS (SELECT 1 FROM order_item_serials WHERE order_item_id = ${line.orderItemId} AND serial_id = ${line.serialId} AND released_at IS NULL)
            AND (SELECT status FROM serials WHERE id = ${line.serialId}) = 'sold'`,
          { code: "SERIAL_NOT_AVAILABLE", detail: line.serialId },
        ),
      );
    }
    usedCost = usedCost === null || line.costIqd === null ? null : usedCost + line.costIqd;
  }

  const stockCost = costOfSlices(allSlices);
  const result: CommitResult = {
    reservations: reservations.length,
    units,
    usedUnits: usedLines.length,
    cogsIqd: stockCost === null || usedCost === null ? null : stockCost + usedCost,
    unitsWithoutLayer: allSlices.filter((slice) => slice.layerId === null).reduce((sum, slice) => sum + slice.qty, 0),
  };
  statements.push(
    auditStatement(db, {
      actor,
      action: "inventory.reservation.commit",
      entityType: "order",
      entityId: orderId,
      after: { reservations: result.reservations, units: result.units, usedUnits: result.usedUnits, unitsWithoutLayer: result.unitsWithoutLayer },
      at: now,
    }),
  );
  return { statements, result };
}

/**
 * On shipment: on_hand −= qty and reserved −= qty for every active reservation of the order,
 * 'sale' movements carrying the FIFO unit cost [P], cost layers consumed oldest first, reservations
 * marked 'committed', and reserved used units marked sold (with their serial attached). Returns the
 * cost of goods sold for the journal [P] — keep it on the server. Retries when a concurrent sale
 * consumed the same cost layer first; committing an order twice commits nothing the second time.
 */
export async function commitOrderReservations(db: Db, actor: Actor, orderId: string, now: number): Promise<CommitResult> {
  for (let attempt = 1; ; attempt++) {
    const plan = await commitOrderReservationsStatements(db, actor, orderId, now);
    if (plan.statements.length === 0) return plan.result;
    try {
      await runBatch(db, plan.statements);
      return plan.result;
    } catch (error) {
      const retryable = isDbError(error, "COST_LAYER_CHANGED") || isDbError(error, "RESERVATION_CHANGED") || isDbError(error, "USED_UNIT_CHANGED");
      if (retryable && attempt < 3) continue;
      throw error;
    }
  }
}

// ───────────────────────────────────────────────────────────────── adjustments and receipts

export const AdjustStockInput = z.object({
  variantId: idSchema,
  locationId: idSchema,
  /** Signed change to on_hand. */
  delta: z
    .number()
    .int("invalid")
    .refine((value) => value !== 0, "invalid")
    .refine((value) => Math.abs(value) <= 100_000, "too_big"),
  reason: z.string().trim().min(3, "too_short").max(500, "too_long"),
  /** 'damage' records a write-off (negative delta only). */
  kind: z.enum(["adjust", "damage"]).default("adjust"),
  /** Cost per unit of units found (positive delta); creates a cost layer. Without it the units have no layer. */
  unitCostIqd: z.number().int().min(0).max(1_000_000_000).optional(),
  /**
   * Explicit request to take available stock below zero (units already promised to orders). Needs
   * inventory.oversell.authorize; without this flag such an adjustment is refused as insufficient_stock.
   */
  allowOversell: z.boolean().optional(),
});
export type AdjustStockInput = z.input<typeof AdjustStockInput>;

/**
 * Corrects the quantity on hand of a variant at a location (count differences, damage, found units),
 * with a 'adjust' / 'damage' movement, FIFO cost layers consumed for removed units [P], and an audit
 * event with the reason. Needs inventory.stock.adjust.
 *   · on_hand never goes below 0 → insufficient_stock (409).
 *   · Taking on_hand below what is reserved for orders is an oversell: it needs `allowOversell: true`
 *     AND inventory.oversell.authorize (403 without it); the level is then marked allow_oversell.
 *   · Serial-tracked variants change through their serials (receiveStock with serials, serial
 *     operations), never by a bare number → serial_tracked (409).
 */
export async function adjustStock(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "inventory.stock.adjust");
  const input = AdjustStockInput.parse(raw);
  assertTime(now, "adjustStock.now");
  if (input.kind === "damage" && input.delta > 0) throw invalid({ delta: "invalid" }, "damage needs a negative delta");
  if (input.unitCostIqd !== undefined && input.delta < 0) throw invalid({ unitCostIqd: "invalid" }, "a cost is only taken for units added");
  const { actorKind, actorId } = actorRef(actor);

  for (let attempt = 1; ; attempt++) {
    const [variant, location, level, layers, standard] = await db.batch([
      db.select({ id: variants.id, trackSerials: variants.trackSerials }).from(variants).where(eq(variants.id, input.variantId)),
      db.select({ id: inventoryLocations.id }).from(inventoryLocations).where(eq(inventoryLocations.id, input.locationId)),
      db
        .select({ onHand: stockLevels.onHand, reserved: stockLevels.reserved, allowOversell: stockLevels.allowOversell })
        .from(stockLevels)
        .where(and(eq(stockLevels.variantId, input.variantId), eq(stockLevels.locationId, input.locationId))),
      db
        .select({ id: costLayers.id, qtyRemaining: costLayers.qtyRemaining, unitCostIqd: costLayers.unitCostIqd })
        .from(costLayers)
        .where(and(eq(costLayers.variantId, input.variantId), eq(costLayers.locationId, input.locationId), sql`${costLayers.qtyRemaining} > 0`))
        .orderBy(asc(costLayers.receivedAt), asc(costLayers.id)),
      db.select({ landedCostIqd: variantCosts.landedCostIqd }).from(variantCosts).where(eq(variantCosts.variantId, input.variantId)),
    ]);
    if (!variant[0]) throw notFound("variant");
    if (!location[0]) throw notFound("location");
    if (variant[0].trackSerials) throw new AppError("serial_tracked", 409, { detail: input.variantId });

    const before = level[0] ?? { onHand: 0, reserved: 0, allowOversell: false };
    const onHand = before.onHand + input.delta;
    if (onHand < 0) throw new AppError("insufficient_stock", 409, { detail: input.variantId, fields: { delta: "insufficient_stock" } });
    // Only taking units away can oversell; adding to an oversold level always helps.
    const oversell = input.delta < 0 && onHand - before.reserved < 0;
    if (oversell) {
      if (input.allowOversell !== true) throw new AppError("insufficient_stock", 409, { detail: input.variantId, fields: { delta: "insufficient_stock" } });
      assertCan(actor, "inventory.oversell.authorize");
    }

    const statements: BatchStatement[] = [];
    const movements: NewStockMovement[] = [];
    if (input.delta > 0) {
      statements.push(
        db
          .insert(stockLevels)
          .values({ variantId: input.variantId, locationId: input.locationId, onHand: input.delta, reserved: 0, updatedAt: now })
          .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { onHand: sql`${stockLevels.onHand} + ${input.delta}`, updatedAt: now } }),
      );
      if (input.unitCostIqd !== undefined) {
        const layer: NewCostLayer = { id: newId("cly"), variantId: input.variantId, locationId: input.locationId, qtyRemaining: input.delta, qtyReceived: input.delta, unitCostIqd: input.unitCostIqd, receivedAt: now, receiptItemId: null, source: "adjustment" };
        statements.push(db.insert(costLayers).values(layer));
      }
      movements.push({ id: newId("mov"), variantId: input.variantId, locationId: input.locationId, kind: input.kind, qtyDelta: input.delta, reservedDelta: 0, unitCostIqd: input.unitCostIqd ?? null, refType: "adjustment", refId: null, reason: input.reason, actorKind, actorId, at: now });
    } else {
      const removed = -input.delta;
      statements.push(
        db
          .update(stockLevels)
          .set({ onHand: sql`${stockLevels.onHand} - ${removed}`, ...(oversell ? { allowOversell: true } : {}), updatedAt: now })
          .where(and(eq(stockLevels.variantId, input.variantId), eq(stockLevels.locationId, input.locationId), gte(stockLevels.onHand, removed))),
        expectChanged(db, 1, { code: "INSUFFICIENT_STOCK", detail: input.variantId }),
      );
      const slices = takeFifo(layers, removed, standard[0]?.landedCostIqd ?? null);
      const takes = new Map<string, number>();
      for (const slice of slices) {
        if (slice.layerId) takes.set(slice.layerId, (takes.get(slice.layerId) ?? 0) + slice.qty);
        movements.push({ id: newId("mov"), variantId: input.variantId, locationId: input.locationId, kind: input.kind, qtyDelta: -slice.qty, reservedDelta: 0, unitCostIqd: slice.unitCostIqd, refType: "adjustment", refId: null, reason: input.reason, actorKind, actorId, at: now });
      }
      for (const [layerId, take] of takes) {
        statements.push(
          db
            .update(costLayers)
            .set({ qtyRemaining: sql`${costLayers.qtyRemaining} - ${take}` })
            .where(and(eq(costLayers.id, layerId), gte(costLayers.qtyRemaining, take))),
          expectChanged(db, 1, { code: "COST_LAYER_CHANGED", detail: layerId }),
        );
      }
    }
    for (const rows of chunkRows(stockMovements, movements)) statements.push(db.insert(stockMovements).values(rows));
    statements.push(
      auditStatement(db, {
        actor,
        action: input.kind === "damage" ? "inventory.stock.damage" : "inventory.stock.adjust",
        entityType: "variant",
        entityId: input.variantId,
        before: { locationId: input.locationId, onHand: before.onHand, reserved: before.reserved, allowOversell: before.allowOversell },
        after: { locationId: input.locationId, onHand, reserved: before.reserved, allowOversell: oversell || before.allowOversell, delta: input.delta, oversell },
        reason: input.reason,
        at: now,
      }),
    );
    try {
      await runBatch(db, statements);
      return;
    } catch (error) {
      if (isDbError(error, "COST_LAYER_CHANGED") && attempt < 3) continue;
      throw error;
    }
  }
}

const refSchema = z.union([
  z.string().trim().min(1, "required").max(200, "too_long"),
  z.object({ type: z.string().trim().min(1, "required").max(50, "too_long"), id: z.string().trim().min(1, "required").max(200, "too_long") }),
]);

export const ReceiveStockInput = z.object({
  variantId: idSchema,
  locationId: idSchema,
  qty: z.number().int("invalid").min(1, "too_small").max(100_000, "too_big"),
  /** [P] Landed cost per unit; becomes the FIFO cost layer. */
  unitCostIqd: z.number().int("invalid").min(0, "too_small").max(1_000_000_000, "too_big"),
  /** One serial number per unit — required for serial-tracked variants, refused for others. */
  serials: z.array(z.string().trim().min(1, "required").max(100, "too_long")).max(100_000).optional(),
  /** Where the goods come from: a receipt item ({ type: "receipt_item", id }), a transfer, or a free-text reference. */
  ref: refSchema,
  reason: z.string().trim().max(500, "too_long").optional(),
});
export type ReceiveStockInput = z.input<typeof ReceiveStockInput>;

/**
 * Receives goods into a location: on_hand += qty, a FIFO cost layer [P], serial rows for tracked
 * variants (one 'receive' movement per serial, otherwise one for the quantity) and an audit event.
 * Needs inventory.stock.receive (or purchasing.receipt.create for the purchasing flow).
 * A serial number that already exists → serial_duplicate (409).
 */
export async function receiveStock(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  if (!canAny(actor, ["inventory.stock.receive", "purchasing.receipt.create"])) throw forbidden("inventory.stock.receive");
  const input = ReceiveStockInput.parse(raw);
  assertTime(now, "receiveStock.now");
  const ref = typeof input.ref === "string" ? { type: "receipt", id: input.ref } : input.ref;

  const [variant, location] = await db.batch([
    db.select({ id: variants.id, trackSerials: variants.trackSerials }).from(variants).where(eq(variants.id, input.variantId)),
    db.select({ id: inventoryLocations.id }).from(inventoryLocations).where(eq(inventoryLocations.id, input.locationId)),
  ]);
  if (!variant[0]) throw notFound("variant");
  if (!location[0]) throw notFound("location");

  const serialNumbers = input.serials ?? [];
  if (variant[0].trackSerials) {
    if (serialNumbers.length === 0) throw invalid({ serials: "serials_required" });
    if (serialNumbers.length !== input.qty) throw invalid({ serials: "serials_count" });
    if (new Set(serialNumbers.map((value) => value.toUpperCase())).size !== serialNumbers.length) throw invalid({ serials: "serials_duplicate" });
  } else if (serialNumbers.length > 0) {
    throw invalid({ serials: "serials_not_tracked" });
  }

  const { actorKind, actorId } = actorRef(actor);
  const layer: NewCostLayer = {
    id: newId("cly"),
    variantId: input.variantId,
    locationId: input.locationId,
    qtyRemaining: input.qty,
    qtyReceived: input.qty,
    unitCostIqd: input.unitCostIqd,
    receivedAt: now,
    receiptItemId: ref.type === "receipt_item" ? ref.id : null,
    source: "purchase",
  };
  const serialRows: NewSerial[] = serialNumbers.map((serial) => ({
    id: newId("ser"),
    serial,
    variantId: input.variantId,
    status: "in_stock",
    locationId: input.locationId,
    costIqd: input.unitCostIqd,
    source: "purchase",
    sourceRef: ref.id,
    notes: null,
    createdAt: now,
    updatedAt: now,
  }));
  const movement = (qtyDelta: number, serialId: string | null): NewStockMovement => ({
    id: newId("mov"),
    variantId: input.variantId,
    locationId: input.locationId,
    serialId,
    kind: "receive",
    qtyDelta,
    reservedDelta: 0,
    unitCostIqd: input.unitCostIqd,
    refType: ref.type,
    refId: ref.id,
    reason: input.reason ?? null,
    actorKind,
    actorId,
    at: now,
  });
  const movements = serialRows.length > 0 ? serialRows.map((row) => movement(1, row.id)) : [movement(input.qty, null)];

  const statements: BatchStatement[] = [
    db
      .insert(stockLevels)
      .values({ variantId: input.variantId, locationId: input.locationId, onHand: input.qty, reserved: 0, updatedAt: now })
      .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { onHand: sql`${stockLevels.onHand} + ${input.qty}`, updatedAt: now } }),
    db.insert(costLayers).values(layer),
    ...chunkRows(serials, serialRows).map((rows) => db.insert(serials).values(rows)),
    ...chunkRows(stockMovements, movements).map((rows) => db.insert(stockMovements).values(rows)),
    auditStatement(db, {
      actor,
      action: "inventory.stock.receive",
      entityType: "variant",
      entityId: input.variantId,
      after: { locationId: input.locationId, qty: input.qty, serials: serialRows.length, ref },
      reason: input.reason ?? null,
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isUniqueViolation(error, "serials.serial")) throw new AppError("serial_duplicate", 409, { fields: { serials: "serial_duplicate" } });
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────── serials and used units

/**
 * Batch statements that attach physical units to an order line (packing). Guarded per serial: it
 * must be in_stock or reserved and belong to the line's variant (or to a component of the line's
 * bundle) — otherwise the batch aborts with TT:SERIAL_NOT_AVAILABLE:<serial id>. A serial attached
 * elsewhere cannot be attached again (UNIQUE while not released), and a line cannot carry more
 * serials than its units → TT:SERIAL_COUNT_EXCEEDS_QTY:<order item id>.
 */
export function assignSerialsStatements(db: Db, input: { orderItemId: string; serialIds: readonly string[]; actor: Actor; now: number }): BatchStatement[] {
  const orderItemId = assertId(input.orderItemId, "assignSerialsStatements.orderItemId");
  const now = assertTime(input.now, "assignSerialsStatements.now");
  const serialIds = [...new Set(input.serialIds.map((value) => assertId(value, "assignSerialsStatements.serialIds")))];
  if (serialIds.length === 0) return [];
  const { actorId } = actorRef(input.actor);
  const lineVariants = sql`(
    SELECT oi.variant_id FROM order_items AS oi WHERE oi.id = ${orderItemId}
    UNION ALL
    SELECT b.component_variant_id FROM bundle_items AS b JOIN order_items AS oi ON oi.variant_id = b.bundle_variant_id WHERE oi.id = ${orderItemId}
  )`;
  const statements: BatchStatement[] = [];
  for (const serialId of serialIds) {
    statements.push(
      db
        .update(serials)
        .set({ status: "sold", updatedAt: now })
        .where(and(eq(serials.id, serialId), inArray(serials.status, ["in_stock", "reserved"]), sql`${serials.variantId} IN ${lineVariants}`)),
      expectChanged(db, 1, { code: "SERIAL_NOT_AVAILABLE", detail: serialId }),
      db.insert(orderItemSerials).values({ orderItemId, serialId, attachedAt: now, attachedBy: actorId }),
    );
  }
  statements.push(
    expectThat(
      db,
      sql`(SELECT count(*) FROM order_item_serials WHERE order_item_id = ${orderItemId} AND released_at IS NULL)
        <= (SELECT oi.qty * coalesce((SELECT sum(b.qty) FROM bundle_items AS b WHERE b.bundle_variant_id = oi.variant_id), 1) FROM order_items AS oi WHERE oi.id = ${orderItemId})`,
      { code: "SERIAL_COUNT_EXCEEDS_QTY", detail: orderItemId },
    ),
    auditStatement(db, { actor: input.actor, action: "inventory.serial.assign", entityType: "order_item", entityId: orderItemId, after: { serialIds }, at: now }),
  );
  return statements;
}

/**
 * Batch statements that reserve a used unit for an order: listed → reserved (guarded), and its
 * serial in_stock → reserved. Anything else aborts the batch with TT:USED_UNIT_NOT_AVAILABLE:<id>.
 * The link to the order is the order line (`order_items.used_unit_id`), inserted by the caller.
 */
export function reserveUsedUnitStatements(db: Db, input: { usedUnitId: string; orderId: string; now: number }): BatchStatement[] {
  const usedUnitId = assertId(input.usedUnitId, "reserveUsedUnitStatements.usedUnitId");
  assertId(input.orderId, "reserveUsedUnitStatements.orderId");
  const now = assertTime(input.now, "reserveUsedUnitStatements.now");
  const serialOf = sql`(SELECT serial_id FROM used_units WHERE id = ${usedUnitId})`;
  return [
    db
      .update(usedUnits)
      .set({ status: "reserved", updatedAt: now })
      .where(and(eq(usedUnits.id, usedUnitId), eq(usedUnits.status, "listed"))),
    expectChanged(db, 1, { code: "USED_UNIT_NOT_AVAILABLE", detail: usedUnitId }),
    db
      .update(serials)
      .set({ status: "reserved", updatedAt: now })
      .where(and(sql`${serials.id} = ${serialOf}`, eq(serials.status, "in_stock"))),
    expectThat(db, sql`${serialOf} IS NULL OR (SELECT status FROM serials WHERE id = ${serialOf}) = 'reserved'`, { code: "USED_UNIT_NOT_AVAILABLE", detail: usedUnitId }),
  ];
}

/** Puts a reserved used unit back on sale (reserved → listed, serial → in_stock). For a single line; releaseOrderReservations does this for a whole order. */
export function releaseUsedUnitStatements(db: Db, input: { usedUnitId: string; now: number }): BatchStatement[] {
  const usedUnitId = assertId(input.usedUnitId, "releaseUsedUnitStatements.usedUnitId");
  const now = assertTime(input.now, "releaseUsedUnitStatements.now");
  return [
    batchSql(db, sql`UPDATE serials SET status = 'in_stock', updated_at = ${now} WHERE status = 'reserved' AND id = (SELECT serial_id FROM used_units WHERE id = ${usedUnitId} AND status = 'reserved')`),
    db
      .update(usedUnits)
      .set({ status: "listed", updatedAt: now })
      .where(and(eq(usedUnits.id, usedUnitId), eq(usedUnits.status, "reserved"))),
  ];
}

// ───────────────────────────────────────────────────────────────── helpers

/** Rows changed by one statement of a D1 batch (0 when the driver reports nothing). */
function changesOf(result: unknown): number {
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return typeof changes === "number" ? changes : 0;
}
