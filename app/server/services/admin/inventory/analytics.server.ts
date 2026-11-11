/**
 * Admin module 04 — the numbers behind decisions: reorder and stock-out forecast (04.06), cost layers per batch
 * (04.10), dead stock, turnover and sales versus inbound (04.12), and the module's home overview.
 *
 * Every figure comes from the stock tables as they are: units from `stock_levels`, sales from 'sale' movements
 * (units that left with a shipped order), inbound from 'receive' (and 'return') movements. No invented history —
 * where there is none the answer says so. [P] money (FIFO value, COGS, layer costs) is computed only for cost.read;
 * cost layers need it outright.
 *
 * Costing policy: FIFO per location — what the commerce core implements (fifo.ts). Units with no cost layer are
 * costed at the variant's standard landed cost, or reported as unknown; weighted average is not implemented.
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { DEFAULT_LOW_STOCK } from "~/server/services/inventory/stock.server";
import { toCsv, type CsvCell } from "./csv";
import { coverPlan, salesRate, type CoverPlan, type SalesRate } from "./forecast";
import { DAY_MS, PAGE_SIZE, baghdadDate, cleanQuery, inventoryAccess, labelOf, likePattern, locationTree, pageOf, type InventoryAccess, type VariantLabel } from "./shared.server";

type LabelRow = { id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number };
const LABEL_COLUMNS = sql`v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive`;

// ───────────────────────────────────────────────────────────────── reorder and forecast (04.06)

export const REORDER_FILTERS = ["attention", "below_reorder", "soon", "out", "no_forecast", "all"] as const;
export type ReorderFilter = (typeof REORDER_FILTERS)[number];

export function parseReorderFilters(params: URLSearchParams): { show: ReorderFilter; q: string; page: number } {
  const show = params.get("show") as ReorderFilter | null;
  return { show: show && REORDER_FILTERS.includes(show) ? show : "attention", q: cleanQuery(params.get("q")), page: pageOf(params.get("page")) };
}

export type ReorderRow = {
  variant: VariantLabel;
  available: number;
  incoming: number;
  reorderPoint: number | null;
  reorderQty: number | null;
  sold30: number;
  sold90: number;
  rate: SalesRate;
  plan: CoverPlan;
};

/**
 * Every active variant with its cover: available to sell, on the way, the reorder point (sum over the locations that
 * set one), sales in the last 30 and 90 days, the rate used (30 days when it has sales, else 90), days of cover,
 * stock-out date and a suggested quantity. Sorted by urgency. Needs inventory.stock.read.
 */
export async function listReorder(db: Db, actor: Actor, filters: { show: ReorderFilter; q: string; page: number }, locale: Locale, now: number): Promise<{ rows: ReorderRow[]; total: number; page: number; pageCount: number; counts: Record<ReorderFilter, number> }> {
  assertCan(actor, "inventory.stock.read");
  const textWhere = filters.q ? sql`AND (v.sku LIKE ${likePattern(filters.q)} ESCAPE '\\' OR json_extract(p.name, '$.ar') LIKE ${likePattern(filters.q)} ESCAPE '\\' OR json_extract(p.name, '$.en') LIKE ${likePattern(filters.q)} ESCAPE '\\')` : sql``;
  const rows = await db.all<LabelRow & { available: number; incoming: number; reorderSum: number | null; reorderCount: number; qtySum: number | null; qtyCount: number; sold30: number; sold90: number; firstAt: number | null }>(sql`
    WITH lv AS (
      SELECT s.variant_id,
             SUM(CASE WHEN l.is_sellable = 1 AND l.is_active = 1 THEN max(s.on_hand - s.reserved, 0) ELSE 0 END) AS available,
             SUM(s.reorder_point) AS reorder_sum, COUNT(s.reorder_point) AS reorder_count, SUM(s.reorder_qty) AS qty_sum, COUNT(s.reorder_qty) AS qty_count
      FROM stock_levels AS s JOIN inventory_locations AS l ON l.id = s.location_id GROUP BY s.variant_id
    ),
    tr AS (SELECT i.variant_id, SUM(i.qty - i.qty_received) AS qty FROM stock_transfer_items AS i JOIN stock_transfers AS t ON t.id = i.transfer_id WHERE t.status = 'in_transit' GROUP BY i.variant_id),
    po AS (SELECT pi.variant_id, SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS qty FROM po_items AS pi JOIN purchase_orders AS o ON o.id = pi.po_id WHERE o.status IN ('approved', 'sent', 'partially_received') GROUP BY pi.variant_id),
    sold AS (
      SELECT variant_id, SUM(CASE WHEN at >= ${now - 30 * DAY_MS} THEN -qty_delta ELSE 0 END) AS sold30, SUM(-qty_delta) AS sold90
      FROM stock_movements WHERE kind = 'sale' AND at >= ${now - 90 * DAY_MS} AND at <= ${now} GROUP BY variant_id
    ),
    first AS (SELECT variant_id, min(at) AS first_at FROM stock_movements GROUP BY variant_id)
    SELECT ${LABEL_COLUMNS}, coalesce(lv.available, 0) AS available, coalesce(tr.qty, 0) + coalesce(po.qty, 0) AS incoming,
           lv.reorder_sum AS reorderSum, coalesce(lv.reorder_count, 0) AS reorderCount, lv.qty_sum AS qtySum, coalesce(lv.qty_count, 0) AS qtyCount,
           coalesce(sold.sold30, 0) AS sold30, coalesce(sold.sold90, 0) AS sold90, first.first_at AS firstAt
    FROM variants AS v JOIN products AS p ON p.id = v.product_id
    LEFT JOIN lv ON lv.variant_id = v.id LEFT JOIN tr ON tr.variant_id = v.id LEFT JOIN po ON po.variant_id = v.id
    LEFT JOIN sold ON sold.variant_id = v.id LEFT JOIN first ON first.variant_id = v.id
    WHERE v.is_active = 1 AND p.status <> 'archived' ${textWhere}`);

  const all: ReorderRow[] = rows.map((row) => {
    const historyDays = row.firstAt === null ? null : (now - row.firstAt) / DAY_MS;
    const rate30 = salesRate({ unitsSold: Number(row.sold30), windowDays: 30, historyDays });
    const rate = rate30.basis === "sales" ? rate30 : salesRate({ unitsSold: Number(row.sold90), windowDays: 90, historyDays });
    const reorderPoint = Number(row.reorderCount) > 0 ? Number(row.reorderSum) : null;
    const reorderQty = Number(row.qtyCount) > 0 ? Number(row.qtySum) : null;
    const available = Number(row.available);
    const incoming = Number(row.incoming);
    return { variant: labelOf(row, locale), available, incoming, reorderPoint, reorderQty, sold30: Number(row.sold30), sold90: Number(row.sold90), rate, plan: coverPlan({ available, incoming, reorderPoint, reorderQty, rate, now }) };
  });
  const matches = (row: ReorderRow, show: ReorderFilter) => {
    switch (show) {
      case "attention":
        return row.plan.status === "out" || row.plan.status === "below_reorder" || row.plan.status === "soon";
      case "below_reorder":
        return row.plan.belowReorder;
      case "soon":
        return row.plan.status === "soon";
      case "out":
        return row.plan.status === "out";
      case "no_forecast":
        return row.rate.perDay === null;
      default:
        return true;
    }
  };
  const counts = Object.fromEntries(REORDER_FILTERS.map((show) => [show, all.filter((row) => matches(row, show)).length])) as Record<ReorderFilter, number>;
  const rank = { out: 0, below_reorder: 1, soon: 2, ok: 3, no_forecast: 4 } as const;
  const filtered = all.filter((row) => matches(row, filters.show)).sort((a, b) => rank[a.plan.status] - rank[b.plan.status] || (a.plan.daysOfCover ?? 1e9) - (b.plan.daysOfCover ?? 1e9) || a.variant.sku.localeCompare(b.variant.sku));
  const start = (filters.page - 1) * PAGE_SIZE;
  return { rows: filtered.slice(start, start + PAGE_SIZE), total: filtered.length, page: filters.page, pageCount: Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), counts };
}

// ───────────────────────────────────────────────────────────────── cost layers (04.10) [P]

export type CostLayerRow = { id: string; variant: VariantLabel; locationCode: string; receivedAt: number; source: string; qtyReceived: number; qtyRemaining: number; unitCostIqd: number; valueIqd: number };
export type CostingPage = {
  rows: CostLayerRow[];
  total: number;
  page: number;
  pageCount: number;
  summary: { valueIqd: number; layeredUnits: number; unlayeredUnits: number; variantsWithoutCost: number; openLayers: number };
};

export function parseCostingFilters(params: URLSearchParams): { q: string; location: string | null; open: boolean; page: number } {
  // The form sends a hidden open=0 and, when the box is ticked, open=1 as well; no parameter at all = open only.
  const open = params.getAll("open");
  return {
    q: cleanQuery(params.get("q")),
    location: params.get("location")?.match(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) ? params.get("location") : null,
    open: open.length === 0 || open.includes("1"),
    page: pageOf(params.get("page")),
  };
}

/** FIFO cost layers, one per received batch per location, oldest first. Needs inventory.stock.read AND cost.read. */
export async function listCostLayers(db: Db, actor: Actor, filters: { q: string; location: string | null; open: boolean; page: number }, locale: Locale): Promise<CostingPage> {
  assertCan(actor, "inventory.stock.read");
  assertCan(actor, "cost.read");
  const parts = [] as ReturnType<typeof sql>[];
  if (filters.open) parts.push(sql`c.qty_remaining > 0`);
  if (filters.location) parts.push(sql`c.location_id = ${filters.location}`);
  if (filters.q) parts.push(sql`(v.sku LIKE ${likePattern(filters.q)} ESCAPE '\\' OR json_extract(p.name, '$.ar') LIKE ${likePattern(filters.q)} ESCAPE '\\' OR json_extract(p.name, '$.en') LIKE ${likePattern(filters.q)} ESCAPE '\\')`);
  const where = parts.length ? sql.join(parts, sql` AND `) : sql`1 = 1`;
  const [rows, totals, summary, tree] = await Promise.all([
    db.all<LabelRow & { layerId: string; locationId: string; receivedAt: number; source: string; qtyReceived: number; qtyRemaining: number; unitCostIqd: number }>(sql`
      SELECT ${LABEL_COLUMNS}, c.id AS layerId, c.location_id AS locationId, c.received_at AS receivedAt, c.source AS source, c.qty_received AS qtyReceived,
             c.qty_remaining AS qtyRemaining, c.unit_cost_iqd AS unitCostIqd
      FROM cost_layers AS c JOIN variants AS v ON v.id = c.variant_id JOIN products AS p ON p.id = v.product_id
      WHERE ${where} ORDER BY v.sku, c.location_id, c.received_at, c.id LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM cost_layers AS c JOIN variants AS v ON v.id = c.variant_id JOIN products AS p ON p.id = v.product_id WHERE ${where}`),
    db.all<{ value: number; layered: number; onHand: number; open: number; withoutCost: number }>(sql`
      SELECT (SELECT coalesce(sum(c.qty_remaining * c.unit_cost_iqd), 0) FROM cost_layers AS c JOIN inventory_locations AS l ON l.id = c.location_id WHERE l.is_active = 1) AS value,
             (SELECT coalesce(sum(c.qty_remaining), 0) FROM cost_layers AS c JOIN inventory_locations AS l ON l.id = c.location_id WHERE l.is_active = 1) AS layered,
             (SELECT coalesce(sum(max(s.on_hand, 0)), 0) FROM stock_levels AS s JOIN inventory_locations AS l ON l.id = s.location_id WHERE l.is_active = 1) AS onHand,
             (SELECT count(*) FROM cost_layers WHERE qty_remaining > 0) AS open,
             (SELECT count(DISTINCT s.variant_id) FROM stock_levels AS s WHERE s.on_hand > 0
                AND NOT EXISTS (SELECT 1 FROM cost_layers AS c WHERE c.variant_id = s.variant_id AND c.location_id = s.location_id AND c.qty_remaining > 0)
                AND NOT EXISTS (SELECT 1 FROM variant_costs AS vc WHERE vc.variant_id = s.variant_id AND vc.landed_cost_iqd IS NOT NULL)) AS withoutCost`),
    locationTree(db),
  ]);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const total = Number(totals[0]?.n ?? 0);
  const s = summary[0];
  return {
    rows: rows.map((row) => ({
      id: row.layerId,
      variant: labelOf(row, locale),
      locationCode: byId.get(row.locationId)?.code ?? row.locationId,
      receivedAt: row.receivedAt,
      source: row.source,
      qtyReceived: row.qtyReceived,
      qtyRemaining: row.qtyRemaining,
      unitCostIqd: row.unitCostIqd,
      valueIqd: row.qtyRemaining * row.unitCostIqd,
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    summary: {
      valueIqd: Number(s?.value ?? 0),
      layeredUnits: Number(s?.layered ?? 0),
      unlayeredUnits: Math.max(0, Number(s?.onHand ?? 0) - Number(s?.layered ?? 0)),
      variantsWithoutCost: Number(s?.withoutCost ?? 0),
      openLayers: Number(s?.open ?? 0),
    },
  };
}

// ───────────────────────────────────────────────────────────────── reports (04.12)

export const REPORT_KINDS = ["dead", "turnover", "flow"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_PERIODS = [30, 60, 90, 180, 365] as const;

export function parseReportFilters(params: URLSearchParams): { report: ReportKind; days: number; page: number } {
  const report = params.get("report") as ReportKind | null;
  const days = Number(params.get("days"));
  return { report: report && REPORT_KINDS.includes(report) ? report : "dead", days: (REPORT_PERIODS as readonly number[]).includes(days) ? days : 90, page: pageOf(params.get("page")) };
}

export type DeadStockRow = { variant: VariantLabel; onHand: number; lastSaleAt: number | null; lastReceiptAt: number | null; firstStockAt: number | null; valueIqd?: number; unlayeredUnits?: number };
export type TurnoverRow = { variant: VariantLabel; sold: number; onHandStart: number; onHandEnd: number; averageOnHand: number; turnover: number | null; daysOfInventory: number | null; cogsIqd?: number | null };
export type FlowRow = { variant: VariantLabel; sold: number; received: number; returned: number; net: number };
export type FlowBucket = { start: number; label: string; sold: number; received: number; returned: number };

export type ReportData =
  | { report: "dead"; days: number; rows: DeadStockRow[]; total: number; summary: { variants: number; units: number; valueIqd?: number; unlayeredUnits?: number } }
  | { report: "turnover"; days: number; rows: TurnoverRow[]; total: number; summary: { sold: number; averageOnHand: number; turnover: number | null; cogsIqd?: number | null } }
  | { report: "flow"; days: number; rows: FlowRow[]; total: number; buckets: FlowBucket[]; summary: { sold: number; received: number; returned: number } };

/** Dead stock: units on hand with no sale in the last `days` (never sold counts too), oldest last sale first. */
async function deadStock(db: Db, withCost: boolean, days: number, now: number, locale: Locale): Promise<Extract<ReportData, { report: "dead" }> & { allRows: DeadStockRow[] }> {
  const since = now - days * DAY_MS;
  const rows = await db.all<LabelRow & { onHand: number; lastSaleAt: number | null; lastReceiptAt: number | null; firstAt: number | null }>(sql`
    WITH lv AS (SELECT s.variant_id, SUM(s.on_hand) AS on_hand FROM stock_levels AS s JOIN inventory_locations AS l ON l.id = s.location_id WHERE l.is_active = 1 GROUP BY s.variant_id),
    mv AS (
      SELECT variant_id, max(CASE WHEN kind = 'sale' THEN at END) AS last_sale, max(CASE WHEN kind = 'receive' THEN at END) AS last_receipt, min(at) AS first_at
      FROM stock_movements GROUP BY variant_id
    )
    SELECT ${LABEL_COLUMNS}, lv.on_hand AS onHand, mv.last_sale AS lastSaleAt, mv.last_receipt AS lastReceiptAt, mv.first_at AS firstAt
    FROM lv JOIN variants AS v ON v.id = lv.variant_id JOIN products AS p ON p.id = v.product_id LEFT JOIN mv ON mv.variant_id = v.id
    WHERE lv.on_hand > 0 AND (mv.last_sale IS NULL OR mv.last_sale < ${since})
      AND coalesce(mv.first_at, 0) < ${since}
    ORDER BY coalesce(mv.last_sale, 0), lv.on_hand DESC, v.sku`);
  let values = new Map<string, { value: number; layered: number }>();
  if (withCost && rows.length > 0) {
    const layerRows = await db.all<{ variantId: string; value: number; layered: number }>(sql`
      SELECT c.variant_id AS variantId, coalesce(sum(c.qty_remaining * c.unit_cost_iqd), 0) AS value, coalesce(sum(c.qty_remaining), 0) AS layered
      FROM cost_layers AS c JOIN inventory_locations AS l ON l.id = c.location_id
      WHERE l.is_active = 1 AND c.qty_remaining > 0 AND c.variant_id IN (SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.id))})) GROUP BY c.variant_id`);
    values = new Map(layerRows.map((row) => [row.variantId, { value: Number(row.value), layered: Number(row.layered) }]));
  }
  const allRows: DeadStockRow[] = rows.map((row) => {
    const out: DeadStockRow = { variant: labelOf(row, locale), onHand: Number(row.onHand), lastSaleAt: row.lastSaleAt, lastReceiptAt: row.lastReceiptAt, firstStockAt: row.firstAt };
    if (withCost) {
      const value = values.get(row.id) ?? { value: 0, layered: 0 };
      out.valueIqd = value.value;
      out.unlayeredUnits = Math.max(0, Number(row.onHand) - value.layered);
    }
    return out;
  });
  const summary: Extract<ReportData, { report: "dead" }>["summary"] = { variants: allRows.length, units: allRows.reduce((sum, row) => sum + row.onHand, 0) };
  if (withCost) {
    summary.valueIqd = allRows.reduce((sum, row) => sum + (row.valueIqd ?? 0), 0);
    summary.unlayeredUnits = allRows.reduce((sum, row) => sum + (row.unlayeredUnits ?? 0), 0);
  }
  return { report: "dead", days, rows: allRows, allRows, total: allRows.length, summary };
}

/**
 * Turnover in units over the period: units sold ÷ average units on hand, where on hand at the start is rebuilt from
 * today's on hand minus every movement since (exact, because levels are the sum of their movements). Days of
 * inventory = period ÷ turnover. COGS of the period [P] (sale movements' unit costs; null when part is unknown).
 */
async function turnover(db: Db, withCost: boolean, days: number, now: number, locale: Locale): Promise<Extract<ReportData, { report: "turnover" }> & { allRows: TurnoverRow[] }> {
  const since = now - days * DAY_MS;
  const rows = await db.all<LabelRow & { onHandEnd: number; changed: number; sold: number; cogs: number | null; uncosted: number }>(sql`
    WITH lv AS (SELECT s.variant_id, SUM(s.on_hand) AS on_hand FROM stock_levels AS s GROUP BY s.variant_id),
    mv AS (
      SELECT variant_id, SUM(qty_delta) AS changed, SUM(CASE WHEN kind = 'sale' THEN -qty_delta ELSE 0 END) AS sold,
             SUM(CASE WHEN kind = 'sale' THEN -qty_delta * unit_cost_iqd ELSE 0 END) AS cogs,
             SUM(CASE WHEN kind = 'sale' AND unit_cost_iqd IS NULL THEN 1 ELSE 0 END) AS uncosted
      FROM stock_movements WHERE at >= ${since} AND at <= ${now} GROUP BY variant_id
    )
    SELECT ${LABEL_COLUMNS}, coalesce(lv.on_hand, 0) AS onHandEnd, coalesce(mv.changed, 0) AS changed, coalesce(mv.sold, 0) AS sold, mv.cogs AS cogs, coalesce(mv.uncosted, 0) AS uncosted
    FROM variants AS v JOIN products AS p ON p.id = v.product_id LEFT JOIN lv ON lv.variant_id = v.id LEFT JOIN mv ON mv.variant_id = v.id
    WHERE coalesce(lv.on_hand, 0) <> 0 OR coalesce(mv.sold, 0) > 0
    ORDER BY coalesce(mv.sold, 0) DESC, v.sku`);
  const allRows: TurnoverRow[] = rows.map((row) => {
    const onHandEnd = Number(row.onHandEnd);
    const onHandStart = onHandEnd - Number(row.changed);
    const averageOnHand = (Math.max(onHandStart, 0) + Math.max(onHandEnd, 0)) / 2;
    const sold = Number(row.sold);
    const rate = averageOnHand > 0 ? sold / averageOnHand : null;
    const out: TurnoverRow = { variant: labelOf(row, locale), sold, onHandStart, onHandEnd, averageOnHand, turnover: rate, daysOfInventory: rate && rate > 0 ? days / rate : null };
    if (withCost) out.cogsIqd = sold === 0 ? 0 : Number(row.uncosted) > 0 ? null : Number(row.cogs ?? 0);
    return out;
  });
  const sold = allRows.reduce((sum, row) => sum + row.sold, 0);
  const averageOnHand = allRows.reduce((sum, row) => sum + row.averageOnHand, 0);
  const summary: Extract<ReportData, { report: "turnover" }>["summary"] = { sold, averageOnHand, turnover: averageOnHand > 0 ? sold / averageOnHand : null };
  if (withCost) summary.cogsIqd = allRows.some((row) => row.cogsIqd === null) ? null : allRows.reduce((sum, row) => sum + (row.cogsIqd ?? 0), 0);
  return { report: "turnover", days, rows: allRows, allRows, total: allRows.length, summary };
}

/** Sales versus inbound: units sold, received and returned to stock, per variant and per week (Iraq time). */
async function flow(db: Db, days: number, now: number, locale: Locale): Promise<Extract<ReportData, { report: "flow" }> & { allRows: FlowRow[] }> {
  const since = now - days * DAY_MS;
  const bucketDays = days <= 60 ? 7 : days <= 180 ? 14 : 30;
  const [rows, bucketRows] = await Promise.all([
    db.all<LabelRow & { sold: number; received: number; returned: number }>(sql`
      SELECT ${LABEL_COLUMNS},
             SUM(CASE WHEN m.kind = 'sale' THEN -m.qty_delta ELSE 0 END) AS sold,
             SUM(CASE WHEN m.kind = 'receive' THEN m.qty_delta ELSE 0 END) AS received,
             SUM(CASE WHEN m.kind = 'return' THEN m.qty_delta ELSE 0 END) AS returned
      FROM stock_movements AS m JOIN variants AS v ON v.id = m.variant_id JOIN products AS p ON p.id = v.product_id
      WHERE m.at >= ${since} AND m.at <= ${now} AND m.kind IN ('sale', 'receive', 'return')
      GROUP BY v.id ORDER BY sold DESC, received DESC, v.sku`),
    db.all<{ bucket: number; sold: number; received: number; returned: number }>(sql`
      SELECT CAST((m.at - ${since}) / ${bucketDays * DAY_MS} AS INTEGER) AS bucket,
             SUM(CASE WHEN m.kind = 'sale' THEN -m.qty_delta ELSE 0 END) AS sold,
             SUM(CASE WHEN m.kind = 'receive' THEN m.qty_delta ELSE 0 END) AS received,
             SUM(CASE WHEN m.kind = 'return' THEN m.qty_delta ELSE 0 END) AS returned
      FROM stock_movements AS m WHERE m.at >= ${since} AND m.at <= ${now} AND m.kind IN ('sale', 'receive', 'return') GROUP BY bucket`),
  ]);
  const allRows: FlowRow[] = rows.map((row) => ({ variant: labelOf(row, locale), sold: Number(row.sold), received: Number(row.received), returned: Number(row.returned), net: Number(row.received) + Number(row.returned) - Number(row.sold) }));
  const count = Math.ceil(days / bucketDays);
  const buckets: FlowBucket[] = Array.from({ length: count }, (_, index) => {
    const start = since + index * bucketDays * DAY_MS;
    const row = bucketRows.find((entry) => Number(entry.bucket) === index);
    return { start, label: baghdadDate(start), sold: Number(row?.sold ?? 0), received: Number(row?.received ?? 0), returned: Number(row?.returned ?? 0) };
  });
  return {
    report: "flow",
    days,
    rows: allRows,
    allRows,
    total: allRows.length,
    buckets,
    summary: { sold: allRows.reduce((sum, row) => sum + row.sold, 0), received: allRows.reduce((sum, row) => sum + row.received, 0), returned: allRows.reduce((sum, row) => sum + row.returned, 0) },
  };
}

/** One report page. Needs inventory.report.read. */
export async function inventoryReport(db: Db, actor: Actor, filters: { report: ReportKind; days: number; page: number }, locale: Locale, now: number): Promise<ReportData & { page: number; pageCount: number }> {
  assertCan(actor, "inventory.report.read");
  const withCost = can(actor, "cost.read");
  const data = filters.report === "dead" ? await deadStock(db, withCost, filters.days, now, locale) : filters.report === "turnover" ? await turnover(db, withCost, filters.days, now, locale) : await flow(db, filters.days, now, locale);
  const start = (filters.page - 1) * PAGE_SIZE;
  const { allRows: _all, ...rest } = data;
  void _all;
  return { ...rest, rows: data.allRows.slice(start, start + PAGE_SIZE), page: filters.page, pageCount: Math.max(1, Math.ceil(data.total / PAGE_SIZE)) } as ReportData & { page: number; pageCount: number };
}

/** The same report as CSV (all rows). Money columns [P] only for cost.read. `h` are the column titles in the admin's language. */
export async function inventoryReportCsv(db: Db, actor: Actor, filters: { report: ReportKind; days: number }, locale: Locale, now: number, h: Record<string, string>): Promise<string> {
  assertCan(actor, "inventory.report.read");
  const withCost = can(actor, "cost.read");
  const day = (ms: number | null) => (ms === null ? "" : baghdadDate(ms));
  if (filters.report === "dead") {
    const data = await deadStock(db, withCost, filters.days, now, locale);
    const head: CsvCell[] = [h.sku, h.product, h.onHand, h.lastSale, h.lastReceipt];
    if (withCost) head.push(h.valueIqd, h.unlayered);
    return toCsv([head, ...data.allRows.map((row) => [row.variant.sku, row.variant.name, row.onHand, day(row.lastSaleAt), day(row.lastReceiptAt), ...(withCost ? [row.valueIqd ?? "", row.unlayeredUnits ?? ""] : [])])]);
  }
  if (filters.report === "turnover") {
    const data = await turnover(db, withCost, filters.days, now, locale);
    const head: CsvCell[] = [h.sku, h.product, h.sold, h.onHandStart, h.onHandEnd, h.averageOnHand, h.turnover, h.daysOfInventory];
    if (withCost) head.push(h.cogsIqd);
    return toCsv([
      head,
      ...data.allRows.map((row) => [row.variant.sku, row.variant.name, row.sold, row.onHandStart, row.onHandEnd, row.averageOnHand, row.turnover === null ? "" : Number(row.turnover.toFixed(2)), row.daysOfInventory === null ? "" : Math.round(row.daysOfInventory), ...(withCost ? [row.cogsIqd ?? ""] : [])]),
    ]);
  }
  const data = await flow(db, filters.days, now, locale);
  return toCsv([[h.sku, h.product, h.sold, h.received, h.returned, h.net], ...data.allRows.map((row) => [row.variant.sku, row.variant.name, row.sold, row.received, row.returned, row.net])]);
}

// ───────────────────────────────────────────────────────────────── overview (home)

export type InventoryOverview = {
  access: InventoryAccess;
  totals: { skusInStock: number; onHand: number; reserved: number; available: number; incoming: number; low: number; out: number; oversold: number };
  decisions: { countsToApprove: number; transfersToReceive: number; oversoldLevels: number; reservationsExpiring: number; belowReorder: number; draftsToShip: number };
  locations: number;
  /** [P] cost.read only */
  value?: { valueIqd: number; unlayeredUnits: number };
};

export async function inventoryOverview(db: Db, actor: Actor, now: number): Promise<InventoryOverview> {
  assertCan(actor, "inventory.stock.read");
  const access = inventoryAccess(actor);
  // Counts awaiting approval that THIS employee may approve: never one they started or counted (two-person rule).
  const { actorId } = actorRef(actor);
  const tookPart =
    actorId === null
      ? sql`0`
      : sql`(c.started_by IS ${actorId}
          OR EXISTS (SELECT 1 FROM cycle_count_lines AS l WHERE l.count_id = c.id AND l.counted_by IS ${actorId})
          OR EXISTS (SELECT 1 FROM audit_events AS a WHERE a.entity_type = 'cycle_count' AND a.entity_id = c.id AND a.action = 'inventory.count.record' AND a.actor_kind = 'employee' AND a.actor_id = ${actorId}))`;
  const [totals, decisions, locations] = await Promise.all([
    db.all<{ skusInStock: number; onHand: number; reserved: number; available: number; low: number; out: number; oversold: number; incoming: number; belowReorder: number }>(sql`
      WITH lv AS (
        SELECT s.variant_id, SUM(s.on_hand) AS on_hand, SUM(s.reserved) AS reserved,
               SUM(CASE WHEN l.is_sellable = 1 THEN max(s.on_hand - s.reserved, 0) ELSE 0 END) AS available,
               SUM(CASE WHEN s.on_hand - s.reserved < 0 THEN 1 ELSE 0 END) AS oversold,
               CASE WHEN COUNT(s.reorder_point) > 0 THEN SUM(s.reorder_point) ELSE NULL END AS reorder_point
        FROM stock_levels AS s JOIN inventory_locations AS l ON l.id = s.location_id WHERE l.is_active = 1 GROUP BY s.variant_id
      ),
      tr AS (SELECT i.variant_id, SUM(i.qty - i.qty_received) AS qty FROM stock_transfer_items AS i JOIN stock_transfers AS t ON t.id = i.transfer_id WHERE t.status = 'in_transit' GROUP BY i.variant_id),
      po AS (SELECT pi.variant_id, SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS qty FROM po_items AS pi JOIN purchase_orders AS o ON o.id = pi.po_id WHERE o.status IN ('approved', 'sent', 'partially_received') GROUP BY pi.variant_id),
      base AS (
        SELECT v.id, coalesce(lv.on_hand, 0) AS on_hand, coalesce(lv.reserved, 0) AS reserved, coalesce(lv.available, 0) AS available, coalesce(lv.oversold, 0) AS oversold,
               lv.reorder_point AS reorder_point, coalesce(tr.qty, 0) + coalesce(po.qty, 0) AS incoming
        FROM variants AS v JOIN products AS p ON p.id = v.product_id LEFT JOIN lv ON lv.variant_id = v.id LEFT JOIN tr ON tr.variant_id = v.id LEFT JOIN po ON po.variant_id = v.id
        WHERE v.is_active = 1 AND p.status <> 'archived'
      )
      SELECT sum(CASE WHEN on_hand > 0 THEN 1 ELSE 0 END) AS skusInStock, coalesce(sum(on_hand), 0) AS onHand, coalesce(sum(reserved), 0) AS reserved,
             coalesce(sum(available), 0) AS available, coalesce(sum(incoming), 0) AS incoming,
             sum(CASE WHEN available > 0 AND available <= coalesce(reorder_point, ${DEFAULT_LOW_STOCK}) THEN 1 ELSE 0 END) AS low,
             sum(CASE WHEN available <= 0 THEN 1 ELSE 0 END) AS out,
             sum(CASE WHEN oversold > 0 THEN 1 ELSE 0 END) AS oversold,
             sum(CASE WHEN reorder_point IS NOT NULL AND available + incoming <= reorder_point THEN 1 ELSE 0 END) AS belowReorder
      FROM base`),
    db.all<{ countsToApprove: number; transfersToReceive: number; draftsToShip: number; oversoldLevels: number; reservationsExpiring: number }>(sql`
      SELECT (SELECT count(*) FROM cycle_counts AS c WHERE c.status = 'review' AND NOT ${tookPart}) AS countsToApprove,
             (SELECT count(*) FROM stock_transfers WHERE status = 'in_transit') AS transfersToReceive,
             (SELECT count(*) FROM stock_transfers WHERE status = 'draft') AS draftsToShip,
             (SELECT count(*) FROM stock_levels WHERE on_hand - reserved < 0) AS oversoldLevels,
             (SELECT count(*) FROM stock_reservations WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ${now + 60 * 60 * 1000}) AS reservationsExpiring`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM inventory_locations WHERE is_active = 1`),
  ]);
  const t = totals[0];
  const d = decisions[0];
  const overview: InventoryOverview = {
    access,
    totals: { skusInStock: Number(t?.skusInStock ?? 0), onHand: Number(t?.onHand ?? 0), reserved: Number(t?.reserved ?? 0), available: Number(t?.available ?? 0), incoming: Number(t?.incoming ?? 0), low: Number(t?.low ?? 0), out: Number(t?.out ?? 0), oversold: Number(t?.oversold ?? 0) },
    decisions: {
      countsToApprove: Number(d?.countsToApprove ?? 0),
      transfersToReceive: Number(d?.transfersToReceive ?? 0),
      draftsToShip: Number(d?.draftsToShip ?? 0),
      oversoldLevels: Number(d?.oversoldLevels ?? 0),
      reservationsExpiring: Number(d?.reservationsExpiring ?? 0),
      belowReorder: Number(t?.belowReorder ?? 0),
    },
    locations: Number(locations[0]?.n ?? 0),
  };
  if (access.cost) {
    const value = await db.all<{ value: number; layered: number; onHand: number }>(sql`
      SELECT (SELECT coalesce(sum(c.qty_remaining * c.unit_cost_iqd), 0) FROM cost_layers AS c JOIN inventory_locations AS l ON l.id = c.location_id WHERE l.is_active = 1) AS value,
             (SELECT coalesce(sum(c.qty_remaining), 0) FROM cost_layers AS c JOIN inventory_locations AS l ON l.id = c.location_id WHERE l.is_active = 1) AS layered,
             (SELECT coalesce(sum(max(s.on_hand, 0)), 0) FROM stock_levels AS s JOIN inventory_locations AS l ON l.id = s.location_id WHERE l.is_active = 1) AS onHand`);
    overview.value = { valueIqd: Number(value[0]?.value ?? 0), unlayeredUnits: Math.max(0, Number(value[0]?.onHand ?? 0) - Number(value[0]?.layered ?? 0)) };
  }
  return overview;
}
