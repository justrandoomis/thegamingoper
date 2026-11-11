/**
 * Admin module 04 — stock per SKU and per location (04.01), one variant's whole picture, reorder points (04.06) and
 * the oversell exceptions (04.09).
 *
 *   const page = await listStock(db, actor, parseStockFilters(url.searchParams), locale);
 *   const item = await getVariantStock(db, actor, variantId, locale, now);
 *   await setReorderPoint(db, actor, { variantId, locationId, reorderPoint: 5, reorderQty: 20 }, now);
 *
 * Figures (the same rules as the commerce core's getAvailability):
 *   on hand     units physically at the location(s) — including units promised to orders
 *   reserved    units promised to orders (active reservations)
 *   available   what the storefront can still sell: Σ over sellable, active locations of max(on hand − reserved, 0)
 *   free        at ONE location: on hand − reserved (negative = oversold, allowed only by an authorised exception)
 *   incoming    units on the way: in-transit transfers to the location(s) plus open purchase-order lines
 *               (approved, sent or partially received) — quantities only, never a supplier price
 *
 * [P] cost data (FIFO value, cost layers, movement unit costs) is selected only when can(actor, "cost.read"); for
 * everyone else the fields are absent from the result, not null.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Locale } from "~/lib/locales";
import { assertBranch, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { inventoryLocations, stockLevels, variants } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { claimOnce, resetRateLimit } from "~/server/ratelimit.server";
import { DEFAULT_LOW_STOCK, adjustStock } from "~/server/services/inventory/stock.server";
import { coverPlan, salesRate, type CoverPlan, type SalesRate } from "./forecast";
import { COUNT_POSTING_REASON, DAY_MS, PAGE_SIZE, actorView, cleanQuery, employeeNames, labelOf, likePattern, locationTree, pageOf, variantLabels, type ActorView, type LocationNode, type VariantLabel } from "./shared.server";

// ───────────────────────────────────────────────────────────────── list

export const STOCK_STATES = ["all", "in_stock", "low", "out", "oversold", "incoming", "below_reorder", "tracked"] as const;
export type StockStateFilter = (typeof STOCK_STATES)[number];
export const STOCK_SORTS = ["sku", "name", "on_hand", "available", "reserved", "incoming"] as const;
export type StockSort = (typeof STOCK_SORTS)[number];

export type StockFilters = { q: string; location: string | null; state: StockStateFilter; sort: StockSort; dir: "asc" | "desc"; page: number };

export function parseStockFilters(params: URLSearchParams): StockFilters {
  const state = params.get("state") as StockStateFilter | null;
  const sort = params.get("sort") as StockSort | null;
  return {
    q: cleanQuery(params.get("q")),
    location: params.get("location")?.match(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) ? params.get("location") : null,
    state: state && STOCK_STATES.includes(state) ? state : "all",
    sort: sort && STOCK_SORTS.includes(sort) ? sort : "sku",
    dir: params.get("dir") === "desc" ? "desc" : "asc",
    page: pageOf(params.get("page")),
  };
}

export type StockRow = VariantLabel & {
  onHand: number;
  reserved: number;
  /** All locations: available to sell. One location: free (on hand − reserved, may be negative). */
  available: number;
  incoming: number;
  reorderPoint: number | null;
  /** Levels whose free quantity is below zero. */
  oversoldLevels: number;
  state: "in_stock" | "low" | "out" | "oversold";
  /** [P] FIFO value of the layered units; only with cost.read. */
  valueIqd?: number;
  /** [P] Units on hand that no cost layer covers (their value is unknown); only with cost.read. */
  unlayeredUnits?: number;
};

export type StockPage = { rows: StockRow[]; total: number; page: number; pageCount: number; location: LocationNode | null; totals: { onHand: number; reserved: number; available: number; incoming: number } };

/** Stock per variant, across all active locations or at one location, filtered, sorted and paged in SQL. */
export async function listStock(db: Db, actor: Actor, filters: StockFilters, locale: Locale): Promise<StockPage> {
  assertCan(actor, "inventory.stock.read");
  const withCost = can(actor, "cost.read");
  const tree = await locationTree(db);
  const location = filters.location ? (tree.find((node) => node.id === filters.location) ?? null) : null;
  const loc = location?.id ?? null;

  const levelWhere = loc ? sql`s.location_id = ${loc}` : sql`l.is_active = 1`;
  const transferWhere = loc ? sql`t.to_location_id = ${loc}` : sql`1 = 1`;
  const poWhere = loc ? sql`p.location_id = ${loc}` : sql`1 = 1`;
  const availableExpr = loc ? sql`s.on_hand - s.reserved` : sql`CASE WHEN l.is_sellable = 1 AND l.is_active = 1 THEN max(s.on_hand - s.reserved, 0) ELSE 0 END`;
  const ctes = sql`
    lv AS (
      SELECT s.variant_id, SUM(s.on_hand) AS on_hand, SUM(s.reserved) AS reserved, SUM(${availableExpr}) AS available,
             SUM(CASE WHEN s.on_hand - s.reserved < 0 THEN 1 ELSE 0 END) AS oversold,
             SUM(s.reorder_point) AS reorder_sum, COUNT(s.reorder_point) AS reorder_count
      FROM stock_levels AS s JOIN inventory_locations AS l ON l.id = s.location_id
      WHERE ${levelWhere}
      GROUP BY s.variant_id
    ),
    tr AS (
      SELECT i.variant_id, SUM(i.qty - i.qty_received) AS qty
      FROM stock_transfer_items AS i JOIN stock_transfers AS t ON t.id = i.transfer_id
      WHERE t.status = 'in_transit' AND ${transferWhere}
      GROUP BY i.variant_id
    ),
    po AS (
      SELECT pi.variant_id, SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS qty
      FROM po_items AS pi JOIN purchase_orders AS p ON p.id = pi.po_id
      WHERE p.status IN ('approved', 'sent', 'partially_received') AND ${poWhere}
      GROUP BY pi.variant_id
    ),
    base AS (
      SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, pr.name AS productName,
             v.track_serials AS trackSerials, v.is_active AS isActive,
             coalesce(lv.on_hand, 0) AS onHand, coalesce(lv.reserved, 0) AS reserved, coalesce(lv.available, 0) AS available,
             coalesce(lv.oversold, 0) AS oversold, coalesce(tr.qty, 0) + coalesce(po.qty, 0) AS incoming,
             CASE WHEN coalesce(lv.reorder_count, 0) > 0 THEN lv.reorder_sum ELSE NULL END AS reorderPoint,
             json_extract(pr.name, '$.ar') AS nameAr, json_extract(pr.name, '$.en') AS nameEn
      FROM variants AS v JOIN products AS pr ON pr.id = v.product_id
      LEFT JOIN lv ON lv.variant_id = v.id LEFT JOIN tr ON tr.variant_id = v.id LEFT JOIN po ON po.variant_id = v.id
    )`;

  const conditions: ReturnType<typeof sql>[] = [];
  if (filters.q) {
    const like = likePattern(filters.q);
    conditions.push(sql`(sku LIKE ${like} ESCAPE '\\' OR nameAr LIKE ${like} ESCAPE '\\' OR nameEn LIKE ${like} ESCAPE '\\' OR barcode = ${filters.q})`);
  }
  // One location: only what has (or had) a level there, or is on its way there.
  if (loc) conditions.push(sql`(id IN (SELECT variant_id FROM stock_levels WHERE location_id = ${loc}) OR incoming > 0)`);
  const threshold = sql`coalesce(reorderPoint, ${DEFAULT_LOW_STOCK})`;
  switch (filters.state) {
    case "in_stock":
      conditions.push(sql`available > ${threshold}`);
      break;
    case "low":
      conditions.push(sql`available > 0 AND available <= ${threshold}`);
      break;
    case "out":
      conditions.push(sql`available <= 0`);
      break;
    case "oversold":
      conditions.push(sql`oversold > 0`);
      break;
    case "incoming":
      conditions.push(sql`incoming > 0`);
      break;
    case "below_reorder":
      conditions.push(sql`reorderPoint IS NOT NULL AND available + incoming <= reorderPoint`);
      break;
    case "tracked":
      conditions.push(sql`trackSerials = 1`);
      break;
    default:
      break;
  }
  const where = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const column = { sku: sql`sku`, name: sql`coalesce(nameAr, sku)`, on_hand: sql`onHand`, available: sql`available`, reserved: sql`reserved`, incoming: sql`incoming` }[filters.sort];
  const order = filters.dir === "desc" ? sql`${column} DESC, sku ASC` : sql`${column} ASC, sku ASC`;
  const offset = (filters.page - 1) * PAGE_SIZE;

  type Row = { id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number; onHand: number; reserved: number; available: number; oversold: number; incoming: number; reorderPoint: number | null };
  const [rows, counts] = await Promise.all([
    db.all<Row>(sql`WITH ${ctes} SELECT * FROM base ${where} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    db.all<{ total: number; onHand: number; reserved: number; available: number; incoming: number }>(
      sql`WITH ${ctes} SELECT count(*) AS total, coalesce(sum(onHand), 0) AS onHand, coalesce(sum(reserved), 0) AS reserved, coalesce(sum(max(available, 0)), 0) AS available, coalesce(sum(incoming), 0) AS incoming FROM base ${where}`,
    ),
  ]);

  let values = new Map<string, { value: number; layered: number }>();
  if (withCost && rows.length > 0) {
    const ids = JSON.stringify(rows.map((row) => row.id));
    const layerWhere = loc ? sql`location_id = ${loc}` : sql`location_id IN (SELECT id FROM inventory_locations WHERE is_active = 1)`;
    const layerRows = await db.all<{ variantId: string; value: number; layered: number }>(sql`
      SELECT variant_id AS variantId, coalesce(sum(qty_remaining * unit_cost_iqd), 0) AS value, coalesce(sum(qty_remaining), 0) AS layered
      FROM cost_layers WHERE variant_id IN (SELECT value FROM json_each(${ids})) AND ${layerWhere} AND qty_remaining > 0
      GROUP BY variant_id`);
    values = new Map(layerRows.map((row) => [row.variantId, { value: Number(row.value), layered: Number(row.layered) }]));
  }

  const out: StockRow[] = rows.map((row) => {
    const label = labelOf(row, locale);
    const reorderPoint = row.reorderPoint === null ? null : Number(row.reorderPoint);
    const available = Number(row.available);
    const lowAt = reorderPoint ?? DEFAULT_LOW_STOCK;
    const state: StockRow["state"] = Number(row.oversold) > 0 ? "oversold" : available <= 0 ? "out" : available <= lowAt ? "low" : "in_stock";
    const base: StockRow = { ...label, onHand: Number(row.onHand), reserved: Number(row.reserved), available, incoming: Number(row.incoming), reorderPoint, oversoldLevels: Number(row.oversold), state };
    if (withCost) {
      const value = values.get(row.id) ?? { value: 0, layered: 0 };
      base.valueIqd = value.value;
      base.unlayeredUnits = Math.max(0, Number(row.onHand) - value.layered);
    }
    return base;
  });
  const total = Number(counts[0]?.total ?? 0);
  return {
    rows: out,
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    location,
    totals: { onHand: Number(counts[0]?.onHand ?? 0), reserved: Number(counts[0]?.reserved ?? 0), available: Number(counts[0]?.available ?? 0), incoming: Number(counts[0]?.incoming ?? 0) },
  };
}

// ───────────────────────────────────────────────────────────────── one variant

export type LevelView = {
  location: Pick<LocationNode, "id" | "code" | "name" | "path" | "level" | "isSellable" | "isActive">;
  onHand: number;
  reserved: number;
  free: number;
  incoming: number;
  reorderPoint: number | null;
  reorderQty: number | null;
  allowOversell: boolean;
  /** [P] only with cost.read */
  valueIqd?: number;
  unlayeredUnits?: number;
};

export type ReservationView = { id: string; orderId: string; orderRef: string; orderStatus: string; locationCode: string; qty: number; createdAt: number; expiresAt: number | null };
export type TransferLink = { id: string; ref: string; status: string; fromCode: string; toCode: string; qty: number; qtyReceived: number };
export type SerialView = { id: string; serial: string; status: string; locationCode: string | null; source: string; usedUnit: boolean; orderRef: string | null; updatedAt: number };
export type MovementView = {
  id: string;
  at: number;
  kind: string;
  locationCode: string;
  qtyDelta: number;
  reservedDelta: number;
  refType: string | null;
  refId: string | null;
  refLabel: string | null;
  reason: string | null;
  actor: ActorView;
  serial?: string | null;
  unitCostIqd?: number | null;
};
export type CostLayerView = { id: string; locationCode: string; receivedAt: number; source: string; qtyReceived: number; qtyRemaining: number; unitCostIqd: number };

export type VariantStock = {
  variant: VariantLabel & { priceIqd: number };
  levels: LevelView[];
  totals: { onHand: number; reserved: number; available: number; incoming: number; reorderPoint: number | null };
  reservations: ReservationView[];
  transfers: TransferLink[];
  /** Present only with inventory.serial.read. */
  serials?: { rows: SerialView[]; counts: Record<string, number>; total: number };
  /** The latest movements (the log's reasons and who did them): present only with inventory.movement.read. */
  movements?: MovementView[];
  forecast: { rate30: SalesRate; rate90: SalesRate; plan: CoverPlan; sold30: number; sold90: number; firstMovementAt: number | null };
  /** [P] Present only with cost.read. */
  cost?: { layers: CostLayerView[]; valueIqd: number; unlayeredUnits: number; standardCostIqd: number | null };
};

/** Everything about one variant's stock, for its page. 404 for an unknown variant. */
export async function getVariantStock(db: Db, actor: Actor, variantId: string, locale: Locale, now: number): Promise<VariantStock> {
  assertCan(actor, "inventory.stock.read");
  const withCost = can(actor, "cost.read");
  const withSerials = can(actor, "inventory.serial.read");
  // The movement log (reasons, who did what) is inventory.movement.read's, also when it is a SKU's latest rows.
  const withMovements = can(actor, "inventory.movement.read");
  const variantRows = await db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number; priceIqd: number }>(sql`
    SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive, v.price_iqd AS priceIqd
    FROM variants AS v JOIN products AS p ON p.id = v.product_id WHERE v.id = ${variantId}`);
  const variantRow = variantRows[0];
  if (!variantRow) throw notFound("variant");
  const tree = await locationTree(db);
  const byId = new Map(tree.map((node) => [node.id, node]));

  const [levelRows, incomingRows, reservationRows, transferRows, movementRows, soldRows, firstRows] = await Promise.all([
    db.select().from(stockLevels).where(eq(stockLevels.variantId, variantId)),
    db.all<{ locationId: string; qty: number }>(sql`
      SELECT t.to_location_id AS locationId, SUM(i.qty - i.qty_received) AS qty FROM stock_transfer_items AS i JOIN stock_transfers AS t ON t.id = i.transfer_id
      WHERE i.variant_id = ${variantId} AND t.status = 'in_transit' GROUP BY t.to_location_id
      UNION ALL
      SELECT coalesce(p.location_id, '') AS locationId, SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS qty FROM po_items AS pi JOIN purchase_orders AS p ON p.id = pi.po_id
      WHERE pi.variant_id = ${variantId} AND p.status IN ('approved', 'sent', 'partially_received') GROUP BY p.location_id`),
    db.all<{ id: string; orderId: string; orderRef: string; orderStatus: string; locationId: string; qty: number; createdAt: number; expiresAt: number | null }>(sql`
      SELECT r.id AS id, r.order_id AS orderId, o.ref AS orderRef, o.status AS orderStatus, r.location_id AS locationId, r.qty AS qty, r.created_at AS createdAt, r.expires_at AS expiresAt
      FROM stock_reservations AS r JOIN orders AS o ON o.id = r.order_id
      WHERE r.variant_id = ${variantId} AND r.status = 'active' ORDER BY r.created_at DESC LIMIT 100`),
    db.all<{ id: string; ref: string; status: string; fromId: string; toId: string; qty: number; qtyReceived: number }>(sql`
      SELECT t.id AS id, t.ref AS ref, t.status AS status, t.from_location_id AS fromId, t.to_location_id AS toId, SUM(i.qty) AS qty, SUM(i.qty_received) AS qtyReceived
      FROM stock_transfers AS t JOIN stock_transfer_items AS i ON i.transfer_id = t.id
      WHERE i.variant_id = ${variantId} AND t.status IN ('draft', 'in_transit') GROUP BY t.id ORDER BY t.created_at DESC LIMIT 50`),
    withMovements ? db.all<MovementRow>(movementSelect(sql`m.variant_id = ${variantId}`, 25)) : Promise.resolve([] as MovementRow[]),
    db.all<{ sold30: number; sold90: number }>(sql`
      SELECT coalesce(sum(CASE WHEN at >= ${now - 30 * DAY_MS} THEN -qty_delta ELSE 0 END), 0) AS sold30, coalesce(sum(-qty_delta), 0) AS sold90
      FROM stock_movements WHERE variant_id = ${variantId} AND kind = 'sale' AND at >= ${now - 90 * DAY_MS} AND at <= ${now}`),
    db.all<{ first: number | null }>(sql`SELECT min(at) AS first FROM stock_movements WHERE variant_id = ${variantId}`),
  ]);

  const incomingAt = new Map<string, number>();
  for (const row of incomingRows) incomingAt.set(row.locationId, (incomingAt.get(row.locationId) ?? 0) + Number(row.qty));
  const locationView = (id: string) => {
    const node = byId.get(id);
    return node
      ? { id: node.id, code: node.code, name: node.name, path: node.path, level: node.level, isSellable: node.isSellable, isActive: node.isActive }
      : { id, code: id, name: id, path: id, level: "warehouse" as const, isSellable: false, isActive: false };
  };

  let layers: CostLayerView[] = [];
  let standardCostIqd: number | null = null;
  if (withCost) {
    const [layerRows, standardRows] = await Promise.all([
      db.all<{ id: string; locationId: string; receivedAt: number; source: string; qtyReceived: number; qtyRemaining: number; unitCostIqd: number }>(sql`
        SELECT id, location_id AS locationId, received_at AS receivedAt, source, qty_received AS qtyReceived, qty_remaining AS qtyRemaining, unit_cost_iqd AS unitCostIqd
        FROM cost_layers WHERE variant_id = ${variantId} ORDER BY received_at, id`),
      db.all<{ landed: number | null }>(sql`SELECT landed_cost_iqd AS landed FROM variant_costs WHERE variant_id = ${variantId}`),
    ]);
    layers = layerRows.map((row) => ({ id: row.id, locationCode: byId.get(row.locationId)?.code ?? row.locationId, receivedAt: row.receivedAt, source: row.source, qtyReceived: row.qtyReceived, qtyRemaining: row.qtyRemaining, unitCostIqd: row.unitCostIqd }));
    standardCostIqd = standardRows[0]?.landed ?? null;
  }
  const layeredAt = new Map<string, { value: number; units: number }>();
  if (withCost) {
    const raw = await db.all<{ locationId: string; value: number; units: number }>(sql`
      SELECT location_id AS locationId, coalesce(sum(qty_remaining * unit_cost_iqd), 0) AS value, coalesce(sum(qty_remaining), 0) AS units
      FROM cost_layers WHERE variant_id = ${variantId} AND qty_remaining > 0 GROUP BY location_id`);
    for (const row of raw) layeredAt.set(row.locationId, { value: Number(row.value), units: Number(row.units) });
  }

  const levels: LevelView[] = levelRows
    .map((row) => {
      const view: LevelView = {
        location: locationView(row.locationId),
        onHand: row.onHand,
        reserved: row.reserved,
        free: row.onHand - row.reserved,
        incoming: incomingAt.get(row.locationId) ?? 0,
        reorderPoint: row.reorderPoint ?? null,
        reorderQty: row.reorderQty ?? null,
        allowOversell: row.allowOversell,
      };
      if (withCost) {
        const layered = layeredAt.get(row.locationId) ?? { value: 0, units: 0 };
        view.valueIqd = layered.value;
        view.unlayeredUnits = Math.max(0, row.onHand - layered.units);
      }
      return view;
    })
    .sort((a, b) => a.location.path.localeCompare(b.location.path));

  const available = levels.reduce((sum, level) => sum + (level.location.isSellable && level.location.isActive ? Math.max(level.free, 0) : 0), 0);
  const reorderPoints = levels.map((level) => level.reorderPoint).filter((value): value is number => value !== null);
  const reorderQtys = levels.map((level) => level.reorderQty).filter((value): value is number => value !== null);
  const totals = {
    onHand: levels.filter((level) => level.location.isActive).reduce((sum, level) => sum + level.onHand, 0),
    reserved: levels.reduce((sum, level) => sum + level.reserved, 0),
    available,
    incoming: [...incomingAt.values()].reduce((sum, qty) => sum + qty, 0),
    reorderPoint: reorderPoints.length ? reorderPoints.reduce((a, b) => a + b, 0) : null,
  };

  const firstMovementAt = firstRows[0]?.first ?? null;
  const historyDays = firstMovementAt === null ? null : (now - firstMovementAt) / DAY_MS;
  const sold30 = Number(soldRows[0]?.sold30 ?? 0);
  const sold90 = Number(soldRows[0]?.sold90 ?? 0);
  const rate30 = salesRate({ unitsSold: sold30, windowDays: 30, historyDays });
  const rate90 = salesRate({ unitsSold: sold90, windowDays: 90, historyDays });
  const rate = rate30.basis === "sales" ? rate30 : rate90;
  const plan = coverPlan({ available, incoming: totals.incoming, reorderPoint: totals.reorderPoint, reorderQty: reorderQtys.length ? reorderQtys.reduce((a, b) => a + b, 0) : null, rate, now });

  const result: VariantStock = {
    variant: { ...labelOf(variantRow, locale), priceIqd: variantRow.priceIqd },
    levels,
    totals,
    reservations: reservationRows.map((row) => ({ ...row, locationCode: byId.get(row.locationId)?.code ?? row.locationId })),
    transfers: transferRows.map((row) => ({ id: row.id, ref: row.ref, status: row.status, fromCode: byId.get(row.fromId)?.code ?? row.fromId, toCode: byId.get(row.toId)?.code ?? row.toId, qty: Number(row.qty), qtyReceived: Number(row.qtyReceived) })),
    forecast: { rate30, rate90, plan, sold30, sold90, firstMovementAt },
  };
  if (withMovements) result.movements = await movementViews(db, movementRows, { withCost, withSerials, byId });
  if (withSerials) {
    const [serialRows, serialCounts] = await Promise.all([
      db.all<{ id: string; serial: string; status: string; locationId: string | null; source: string; usedUnitId: string | null; orderRef: string | null; updatedAt: number }>(sql`
        SELECT s.id AS id, s.serial AS serial, s.status AS status, s.location_id AS locationId, s.source AS source, u.id AS usedUnitId,
               (SELECT o.ref FROM order_item_serials AS ois JOIN order_items AS oi ON oi.id = ois.order_item_id JOIN orders AS o ON o.id = oi.order_id
                 WHERE ois.serial_id = s.id AND ois.released_at IS NULL LIMIT 1) AS orderRef,
               s.updated_at AS updatedAt
        FROM serials AS s LEFT JOIN used_units AS u ON u.serial_id = s.id
        WHERE s.variant_id = ${variantId} ORDER BY CASE s.status WHEN 'in_stock' THEN 0 WHEN 'reserved' THEN 1 WHEN 'intake' THEN 2 ELSE 3 END, s.serial LIMIT 200`),
      db.all<{ status: string; n: number }>(sql`SELECT status, count(*) AS n FROM serials WHERE variant_id = ${variantId} GROUP BY status`),
    ]);
    const counts: Record<string, number> = {};
    for (const row of serialCounts) counts[row.status] = Number(row.n);
    result.serials = {
      rows: serialRows.map((row) => ({ id: row.id, serial: row.serial, status: row.status, locationCode: row.locationId ? (byId.get(row.locationId)?.code ?? row.locationId) : null, source: row.source, usedUnit: row.usedUnitId !== null, orderRef: row.orderRef, updatedAt: row.updatedAt })),
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    };
  }
  if (withCost) {
    const valueIqd = levels.reduce((sum, level) => sum + (level.valueIqd ?? 0), 0);
    const unlayeredUnits = levels.reduce((sum, level) => sum + (level.unlayeredUnits ?? 0), 0);
    result.cost = { layers, valueIqd, unlayeredUnits, standardCostIqd };
  }
  return result;
}

// ───────────────────────────────────────────────────────────────── movements (shared with the log)

export type MovementRow = {
  id: string;
  at: number;
  kind: string;
  variantId: string;
  locationId: string;
  serialId: string | null;
  serial: string | null;
  qtyDelta: number;
  reservedDelta: number;
  unitCostIqd: number | null;
  refType: string | null;
  refId: string | null;
  reason: string | null;
  actorKind: string;
  actorId: string | null;
};

/** SELECT of movements with their serial number; `unit_cost_iqd` is read but dropped for actors without cost.read. */
export function movementSelect(where: ReturnType<typeof sql>, limit: number, offset = 0) {
  return sql`
    SELECT m.id AS id, m.at AS at, m.kind AS kind, m.variant_id AS variantId, m.location_id AS locationId, m.serial_id AS serialId,
           s.serial AS serial, m.qty_delta AS qtyDelta, m.reserved_delta AS reservedDelta, m.unit_cost_iqd AS unitCostIqd,
           m.ref_type AS refType, m.ref_id AS refId, m.reason AS reason, m.actor_kind AS actorKind, m.actor_id AS actorId
    FROM stock_movements AS m LEFT JOIN serials AS s ON s.id = m.serial_id
    WHERE ${where}
    ORDER BY m.at DESC, m.id DESC
    LIMIT ${limit} OFFSET ${offset}`;
}

/** Human labels of movement references: order refs, transfer refs, count refs, receipt sessions. */
export async function refLabels(db: Db, rows: readonly { refType: string | null; refId: string | null }[]): Promise<Map<string, string>> {
  const ids = (type: string) => JSON.stringify([...new Set(rows.filter((row) => row.refType === type && row.refId).map((row) => row.refId as string))]);
  const [orderRows, transferRows, countRows] = await Promise.all([
    db.all<{ id: string; ref: string }>(sql`SELECT id, ref FROM orders WHERE id IN (SELECT value FROM json_each(${ids("order")}))`),
    db.all<{ id: string; ref: string }>(sql`SELECT id, ref FROM stock_transfers WHERE id IN (SELECT value FROM json_each(${ids("transfer")}))`),
    db.all<{ id: string; ref: string }>(sql`SELECT id, ref FROM cycle_counts WHERE id IN (SELECT value FROM json_each(${ids("cycle_count")}))`),
  ]);
  const out = new Map<string, string>();
  for (const row of orderRows) out.set(`order:${row.id}`, row.ref);
  for (const row of transferRows) out.set(`transfer:${row.id}`, row.ref);
  for (const row of countRows) out.set(`cycle_count:${row.id}`, row.ref);
  for (const row of rows) if (row.refType === "stock_receipt" && row.refId) out.set(`stock_receipt:${row.refId}`, row.refId);
  return out;
}

export async function movementViews(db: Db, rows: readonly MovementRow[], options: { withCost: boolean; withSerials: boolean; byId: Map<string, LocationNode> }): Promise<MovementView[]> {
  const [names, labels] = await Promise.all([employeeNames(db, rows.filter((row) => row.actorKind === "employee").map((row) => row.actorId)), refLabels(db, rows)]);
  return rows.map((row) => {
    const view: MovementView = {
      id: row.id,
      at: row.at,
      kind: row.kind,
      locationCode: options.byId.get(row.locationId)?.code ?? row.locationId,
      qtyDelta: row.qtyDelta,
      reservedDelta: row.reservedDelta,
      refType: row.refType,
      refId: row.refId,
      refLabel: row.refType && row.refId ? (labels.get(`${row.refType}:${row.refId}`) ?? null) : null,
      reason: row.reason,
      actor: actorView(row.actorKind, row.actorId, names),
    };
    if (options.withSerials) view.serial = row.serial;
    if (options.withCost) view.unitCostIqd = row.unitCostIqd;
    return view;
  });
}

// ───────────────────────────────────────────────────────────────── adjustments (04.09)

export const AdminAdjustInput = z.object({
  variantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid"),
  locationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid"),
  kind: z.enum(["adjust", "damage"]),
  direction: z.enum(["add", "remove"]),
  qty: z.number().int("invalid").min(1, "too_small").max(100_000, "too_big"),
  reason: z.string().trim().min(3, "too_short").max(500, "too_long"),
  /** [P] honoured only for employees with cost.read (added units only). */
  unitCostIqd: z.number().int("invalid").min(0, "too_small").max(1_000_000_000, "too_big").optional(),
  allowOversell: z.boolean().optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "invalid"),
});

/**
 * An adjustment or a damage write-off from the admin, through the commerce core's adjustStock (which checks
 * inventory.stock.adjust, and inventory.oversell.authorize for an oversell). Adds what the core does not: a
 * double-submit guard (the idempotency key is claimed once; a repeat answers `replayed: true`), the cost of
 * found units is taken only from employees who may see costs, and a reason that starts like a count's posting
 * ("CC-… [") is refused (`reason_reserved`) — the inventory role both counts and adjusts.
 */
export async function adjustFromAdmin(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "inventory.stock.adjust");
  const input = AdminAdjustInput.parse(raw);
  if (input.kind === "damage" && input.direction === "add") throw new AppError("invalid", 400, { fields: { direction: "invalid" } });
  // A count's postings are found by their reason: a hand-typed one may not pass for one (the approval would skip it).
  if (COUNT_POSTING_REASON.test(input.reason)) throw new AppError("invalid", 400, { fields: { reason: "reason_reserved" } });
  // An employee limited to a branch adjusts only that branch's locations.
  const location = await db.select({ branchId: inventoryLocations.branchId }).from(inventoryLocations).where(eq(inventoryLocations.id, input.locationId)).limit(1);
  if (location[0]) assertBranch(actor, location[0].branchId);
  const claim = `inv-adjust:${actor.kind === "employee" ? actor.id : actor.kind}:${input.idempotencyKey}`;
  if (!(await claimOnce(db, claim, 0))) return { replayed: true };
  try {
    await adjustStock(
      db,
      actor,
      {
        variantId: input.variantId,
        locationId: input.locationId,
        delta: input.direction === "add" ? input.qty : -input.qty,
        reason: input.reason,
        kind: input.kind,
        unitCostIqd: input.direction === "add" && can(actor, "cost.read") ? input.unitCostIqd : undefined,
        allowOversell: input.allowOversell === true ? true : undefined,
      },
      now,
    );
  } catch (error) {
    await resetRateLimit(db, claim);
    throw error;
  }
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── reorder points (04.06)

export const SetReorderInput = z.object({
  variantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid"),
  locationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid"),
  /** null clears it (the default low-stock threshold applies again). */
  reorderPoint: z.number().int("invalid").min(0, "too_small").max(100_000, "too_big").nullable(),
  reorderQty: z.number().int("invalid").min(1, "too_small").max(100_000, "too_big").nullable(),
});

/**
 * Sets the reorder point and the suggested order quantity of a variant at a location. Touches only those two
 * planning columns of the level (never on hand, reserved, incoming or the oversell flag), creating an empty level
 * when the variant has none there yet. Needs inventory.reorder.manage. Audited.
 */
export async function setReorderPoint(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "inventory.reorder.manage");
  const input = SetReorderInput.parse(raw);
  const [variantRows, locationRows, levelRows] = await db.batch([
    db.select({ id: variants.id }).from(variants).where(eq(variants.id, input.variantId)),
    db.select({ id: inventoryLocations.id, isActive: inventoryLocations.isActive, branchId: inventoryLocations.branchId }).from(inventoryLocations).where(eq(inventoryLocations.id, input.locationId)),
    db
      .select({ reorderPoint: stockLevels.reorderPoint, reorderQty: stockLevels.reorderQty })
      .from(stockLevels)
      .where(and(eq(stockLevels.variantId, input.variantId), eq(stockLevels.locationId, input.locationId))),
  ]);
  if (!variantRows[0]) throw notFound("variant");
  if (!locationRows[0] || !locationRows[0].isActive) throw new AppError("location_invalid", 409, { fields: { locationId: "location_invalid" } });
  assertBranch(actor, locationRows[0].branchId);
  const before = levelRows[0] ?? { reorderPoint: null, reorderQty: null };
  if ((before.reorderPoint ?? null) === input.reorderPoint && (before.reorderQty ?? null) === input.reorderQty) return { changed: false };
  await runBatch(db, [
    db
      .insert(stockLevels)
      .values({ variantId: input.variantId, locationId: input.locationId, onHand: 0, reserved: 0, reorderPoint: input.reorderPoint, reorderQty: input.reorderQty, updatedAt: now })
      .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { reorderPoint: input.reorderPoint, reorderQty: input.reorderQty, updatedAt: now } }),
    auditStatement(db, {
      actor,
      action: "inventory.reorder.set",
      entityType: "variant",
      entityId: input.variantId,
      before: { locationId: input.locationId, reorderPoint: before.reorderPoint ?? null, reorderQty: before.reorderQty ?? null },
      after: { locationId: input.locationId, reorderPoint: input.reorderPoint, reorderQty: input.reorderQty },
      at: now,
    }),
  ]);
  return { changed: true };
}

// ───────────────────────────────────────────────────────────────── oversell exceptions (04.09)

export type OversoldLevel = { variant: VariantLabel; location: Pick<LocationNode, "id" | "code" | "name" | "path">; onHand: number; reserved: number; free: number; allowOversell: boolean };
export type OversellAuthorization = { id: string; at: number; variantId: string; sku: string; name: string; locationCode: string; delta: number; onHandAfter: number | null; reservedAfter: number | null; reason: string | null; actor: string | null };

/**
 * Levels that are oversold now (on hand below what is promised to orders) and the history of the authorised
 * exceptions behind them: every adjustment that took available stock below zero, with who allowed it and why.
 */
export async function listOversell(db: Db, actor: Actor, locale: Locale): Promise<{ levels: OversoldLevel[]; authorizations: OversellAuthorization[] }> {
  assertCan(actor, "inventory.stock.read");
  const tree = await locationTree(db);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const [levelRows, auditRows] = await Promise.all([
    db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number; locationId: string; onHand: number; reserved: number; allowOversell: number }>(sql`
      SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive,
             s.location_id AS locationId, s.on_hand AS onHand, s.reserved AS reserved, s.allow_oversell AS allowOversell
      FROM stock_levels AS s JOIN variants AS v ON v.id = s.variant_id JOIN products AS p ON p.id = v.product_id
      WHERE s.on_hand - s.reserved < 0 OR s.allow_oversell = 1
      ORDER BY s.on_hand - s.reserved, v.sku LIMIT 200`),
    db.all<{ id: string; at: number; entityId: string; after: string | null; reason: string | null; actorLabel: string | null }>(sql`
      SELECT id, at, entity_id AS entityId, after, reason, actor_label AS actorLabel FROM audit_events
      WHERE action IN ('inventory.stock.adjust', 'inventory.stock.damage') AND json_extract(after, '$.oversell') = 1
      ORDER BY seq DESC LIMIT 100`),
  ]);
  const labels = new Map<string, VariantLabel>();
  const variantIds = auditRows.map((row) => row.entityId);
  if (variantIds.length) {
    const rows = await db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number }>(sql`
      SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive
      FROM variants AS v JOIN products AS p ON p.id = v.product_id WHERE v.id IN (SELECT value FROM json_each(${JSON.stringify(variantIds)}))`);
    for (const row of rows) labels.set(row.id, labelOf(row, locale));
  }
  const location = (id: string) => {
    const node = byId.get(id);
    return { id, code: node?.code ?? id, name: node?.name ?? id, path: node?.path ?? id };
  };
  return {
    levels: levelRows.map((row) => ({ variant: labelOf(row, locale), location: location(row.locationId), onHand: row.onHand, reserved: row.reserved, free: row.onHand - row.reserved, allowOversell: Boolean(row.allowOversell) })),
    authorizations: auditRows.map((row) => {
      let after: { locationId?: string; delta?: number; onHand?: number; reserved?: number } = {};
      try {
        after = row.after ? (JSON.parse(row.after) as typeof after) : {};
      } catch {
        after = {};
      }
      const label = labels.get(row.entityId);
      return {
        id: row.id,
        at: row.at,
        variantId: row.entityId,
        sku: label?.sku ?? row.entityId,
        name: label?.name ?? "",
        locationCode: after.locationId ? location(after.locationId).code : "—",
        delta: Number(after.delta ?? 0),
        onHandAfter: typeof after.onHand === "number" ? after.onHand : null,
        reservedAfter: typeof after.reserved === "number" ? after.reserved : null,
        reason: row.reason,
        actor: row.actorLabel,
      };
    }),
  };
}

/** The most recent movements across the store (for the module's home page). */
export async function recentMovements(db: Db, actor: Actor, limit: number, locale: Locale): Promise<(MovementView & { variant: VariantLabel | null })[]> {
  assertCan(actor, "inventory.movement.read");
  const tree = await locationTree(db);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const rows = await db.all<MovementRow>(movementSelect(sql`1 = 1`, limit));
  const views = await movementViews(db, rows, { withCost: false, withSerials: can(actor, "inventory.serial.read"), byId });
  const labels = await variantLabels(db, rows.map((row) => row.variantId), locale);
  return views.map((view, index) => ({ ...view, variant: labels.get(rows[index].variantId) ?? null }));
}
