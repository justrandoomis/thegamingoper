/**
 * Admin module 04 — the stock movement log (04.04): every stock-in, sale, transfer, damage, adjustment, count and
 * reservation, with its reason, reference, actor and time. Read-only by construction: `stock_movements` is
 * append-only (database triggers refuse UPDATE and DELETE), and this module offers no way to change a row.
 *
 *   const page = await listMovements(db, actor, parseMovementFilters(url.searchParams), locale);
 *   const csv = await movementsCsv(db, actor, filters, locale);   // the same filters, up to 10,000 rows
 *
 * Filters live in the URL: text (SKU, product name, reference, or a serial number for inventory.serial.read),
 * kind, location, from / to (Iraq days), page. The unit cost [P] is selected and exported only for cost.read;
 * serial numbers only for inventory.serial.read. Needs inventory.movement.read.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { STOCK_MOVEMENT_KINDS, type StockMovementKind } from "~/server/db/schema";
import { toCsv, type CsvCell } from "./csv";
import { BAGHDAD_OFFSET_MS, DAY_MS, PAGE_SIZE, cleanQuery, likePattern, locationTree, pageOf, parseBaghdadDate, variantLabels, type VariantLabel } from "./shared.server";
import { movementSelect, movementViews, type MovementRow, type MovementView } from "./stock.server";

export type MovementFilters = { q: string; kind: StockMovementKind | null; location: string | null; from: string | null; to: string | null; ref: string | null; page: number };

export function parseMovementFilters(params: URLSearchParams): MovementFilters {
  const kind = params.get("kind") as StockMovementKind | null;
  const from = params.get("from");
  const to = params.get("to");
  return {
    q: cleanQuery(params.get("q")),
    kind: kind && (STOCK_MOVEMENT_KINDS as readonly string[]).includes(kind) ? kind : null,
    location: params.get("location")?.match(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) ? params.get("location") : null,
    from: parseBaghdadDate(from) === null ? null : from,
    to: parseBaghdadDate(to) === null ? null : to,
    ref: params.get("ref")?.match(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) ? params.get("ref") : null,
    page: pageOf(params.get("page")),
  };
}

function whereOf(filters: MovementFilters, withSerials: boolean): SQL {
  const parts: SQL[] = [];
  if (filters.kind) parts.push(sql`m.kind = ${filters.kind}`);
  if (filters.location) parts.push(sql`m.location_id = ${filters.location}`);
  const from = parseBaghdadDate(filters.from);
  const to = parseBaghdadDate(filters.to);
  if (from !== null) parts.push(sql`m.at >= ${from}`);
  if (to !== null) parts.push(sql`m.at < ${to + DAY_MS}`);
  if (filters.ref) parts.push(sql`m.ref_id = ${filters.ref}`);
  if (filters.q) {
    const like = likePattern(filters.q);
    const textMatch = sql`m.variant_id IN (
        SELECT v.id FROM variants AS v JOIN products AS p ON p.id = v.product_id
        WHERE v.sku LIKE ${like} ESCAPE '\\' OR v.barcode = ${filters.q} OR json_extract(p.name, '$.ar') LIKE ${like} ESCAPE '\\' OR json_extract(p.name, '$.en') LIKE ${like} ESCAPE '\\'
      )
      OR m.ref_id IN (SELECT id FROM orders WHERE ref = upper(${filters.q}))
      OR m.ref_id IN (SELECT id FROM stock_transfers WHERE ref = upper(${filters.q}))
      OR m.ref_id IN (SELECT id FROM cycle_counts WHERE ref = upper(${filters.q}))
      OR m.ref_id = upper(${filters.q})`;
    // A serial number only finds its movements for those who may see serial numbers.
    parts.push(withSerials ? sql`(${textMatch} OR m.serial_id IN (SELECT id FROM serials WHERE upper(serial) = upper(${filters.q})))` : sql`(${textMatch})`);
  }
  return parts.length ? sql.join(parts, sql` AND `) : sql`1 = 1`;
}

export type MovementLogRow = MovementView & { variant: VariantLabel | null; variantId: string };
export type MovementPage = { rows: MovementLogRow[]; total: number; page: number; pageCount: number; withCost: boolean; withSerials: boolean };

export async function listMovements(db: Db, actor: Actor, filters: MovementFilters, locale: Locale): Promise<MovementPage> {
  assertCan(actor, "inventory.movement.read");
  const withCost = can(actor, "cost.read");
  const withSerials = can(actor, "inventory.serial.read");
  const where = whereOf(filters, withSerials);
  const [rows, counts, tree] = await Promise.all([
    db.all<MovementRow>(movementSelect(where, PAGE_SIZE, (filters.page - 1) * PAGE_SIZE)),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM stock_movements AS m WHERE ${where}`),
    locationTree(db),
  ]);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const [views, labels] = await Promise.all([movementViews(db, rows, { withCost, withSerials, byId }), variantLabels(db, rows.map((row) => row.variantId), locale)]);
  const total = Number(counts[0]?.n ?? 0);
  return {
    rows: views.map((view, index) => ({ ...view, variantId: rows[index].variantId, variant: labels.get(rows[index].variantId) ?? null })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    withCost,
    withSerials,
  };
}

export const CSV_LIMIT = 10_000;

/**
 * The log as CSV with the same filters. Columns: time (Iraq), kind, SKU, product, location, quantity change,
 * reserved change, reference type, reference, reason, actor kind, actor — plus serial (inventory.serial.read) and
 * unit cost IQD (cost.read). Headers are in the admin's language (`headers`).
 */
export async function movementsCsv(db: Db, actor: Actor, filters: MovementFilters, locale: Locale, headers: Record<string, string>): Promise<{ csv: string; rows: number; truncated: boolean }> {
  assertCan(actor, "inventory.movement.read");
  const withCost = can(actor, "cost.read");
  const withSerials = can(actor, "inventory.serial.read");
  const rows = await db.all<MovementRow>(movementSelect(whereOf(filters, withSerials), CSV_LIMIT + 1));
  const truncated = rows.length > CSV_LIMIT;
  const used = rows.slice(0, CSV_LIMIT);
  const tree = await locationTree(db);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const [views, labels] = await Promise.all([movementViews(db, used, { withCost, withSerials, byId }), variantLabels(db, used.map((row) => row.variantId), locale)]);
  const head: CsvCell[] = [headers.at, headers.kind, headers.sku, headers.product, headers.location, headers.qty, headers.reserved, headers.refType, headers.ref, headers.reason, headers.actorKind, headers.actor];
  if (withSerials) head.push(headers.serial);
  if (withCost) head.push(headers.unitCost);
  const lines: CsvCell[][] = [head];
  views.forEach((view, index) => {
    const label = labels.get(used[index].variantId);
    const time = new Date(view.at + BAGHDAD_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19);
    const line: CsvCell[] = [time, view.kind, label?.sku ?? used[index].variantId, label?.name ?? "", view.locationCode, view.qtyDelta, view.reservedDelta, view.refType, view.refLabel ?? view.refId, view.reason, view.actor.kind, view.actor.name ?? view.actor.id];
    if (withSerials) line.push(view.serial ?? "");
    if (withCost) line.push(view.unitCostIqd ?? "");
    lines.push(line);
  });
  return { csv: toCsv(lines), rows: used.length, truncated };
}
