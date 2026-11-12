/**
 * Admin 19.05 — the demand forecast of every active SKU (automation.suggestion.read), by the method in forecast.ts, with
 * its inputs: monthly units sold (12 full Baghdad months + this month so far), the months of history, the release date
 * from the catalogue (`attributes.catalogue.releaseDate`, else the pre-order release) and units on open pre-orders.
 *
 *   await demandForecast(db, actor, parseForecastFilters(params), locale, now);
 *   await storeDemandForecasts(db, now);   // the daily job: next month's figure per SKU into `demand_forecasts`
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { demandForecasts } from "~/server/db/schema";
import { chunkRows, runBatch } from "~/server/db/tx.server";
import { baghdadMidnight } from "../../catalog/product-types";
import { OPEN_STATUSES } from "../orders/types";
import { FORECAST, forecastOf, historyMonthsOf, monthKey, monthStart, type ForecastResult } from "./forecast";
import { recordHref, skuName } from "./shared.server";
import { PAGE_SIZE, type ForecastFilters, type ForecastView } from "./types";

const num = (value: unknown) => Number(value ?? 0);
const OPEN_LIST = sql.raw(OPEN_STATUSES.map((status) => `'${status}'`).join(", "));

export type ForecastRow = {
  variant: { id: string; sku: string; name: string; href: string | null };
  /** Units sold in the last 12 full months (oldest first) and this month so far. */
  monthly: number[];
  months: string[];
  thisMonth: number;
  historyMonths: number;
  available: number;
  releaseAt: number | null;
  preorderUnits: number;
  result: ForecastResult;
  demo: boolean;
};

export type ForecastPage = { rows: ForecastRow[]; total: number; page: number; pageCount: number; counts: Record<ForecastView, number>; nextMonth: string; months: string[] };

type Base = { id: string; sku: string; title: string | null; productName: string; releaseDate: string | null; preorderReleaseAt: number | null; isDemo: number; firstAt: number | null; available: number; preorders: number };

/** Every active SKU with stock history or a coming release, with its forecast. */
async function computeAll(db: Db, now: number): Promise<{ rows: Omit<ForecastRow, "variant">[]; bases: Base[]; months: string[] }> {
  const start = monthStart(now, -FORECAST.windowMonths);
  const bases = await db.all<Base>(sql`
    WITH first AS (SELECT variant_id, min(at) AS first_at FROM stock_movements GROUP BY variant_id),
         lv AS (SELECT s.variant_id, SUM(max(s.on_hand - s.reserved, 0)) AS available FROM stock_levels AS s JOIN inventory_locations AS l ON l.id = s.location_id AND l.is_sellable = 1 AND l.is_active = 1 GROUP BY s.variant_id),
         pre AS (SELECT oi.variant_id, SUM(oi.qty) AS units FROM order_items AS oi JOIN orders AS o ON o.id = oi.order_id WHERE o.is_preorder = 1 AND o.status IN (${OPEN_LIST}) AND oi.variant_id IS NOT NULL GROUP BY oi.variant_id)
    SELECT v.id AS id, v.sku AS sku, v.title AS title, p.name AS productName, json_extract(p.attributes, '$.catalogue.releaseDate') AS releaseDate, p.preorder_release_at AS preorderReleaseAt,
           p.is_demo AS isDemo, first.first_at AS firstAt, coalesce(lv.available, 0) AS available, coalesce(pre.units, 0) AS preorders
    FROM variants AS v JOIN products AS p ON p.id = v.product_id
    LEFT JOIN first ON first.variant_id = v.id LEFT JOIN lv ON lv.variant_id = v.id LEFT JOIN pre ON pre.variant_id = v.id
    WHERE v.is_active = 1 AND p.status <> 'archived' AND p.kind <> 'bundle'
      AND (first.first_at IS NOT NULL OR p.preorder_release_at > ${now} OR json_extract(p.attributes, '$.catalogue.releaseDate') >= ${monthKey(now, -2)})
    ORDER BY v.sku`);
  const sales = await db.all<{ variantId: string; month: string; units: number }>(sql`
    SELECT m.variant_id AS variantId, strftime('%Y-%m', (m.at + 10800000) / 1000, 'unixepoch') AS month, SUM(-m.qty_delta) AS units
    FROM stock_movements AS m WHERE m.kind = 'sale' AND m.at >= ${start} AND m.at <= ${now} GROUP BY m.variant_id, month`);
  const byVariant = new Map<string, Map<string, number>>();
  for (const row of sales) {
    const months = byVariant.get(row.variantId) ?? new Map<string, number>();
    months.set(row.month, num(row.units));
    byVariant.set(row.variantId, months);
  }
  const months = Array.from({ length: FORECAST.windowMonths }, (_, index) => monthKey(now, index - FORECAST.windowMonths));
  const current = monthKey(now);
  const rows = bases.map((base) => {
    const units = byVariant.get(base.id) ?? new Map<string, number>();
    const monthly = months.map((month) => units.get(month) ?? 0);
    const releaseAt = (base.releaseDate ? baghdadMidnight(base.releaseDate) : null) ?? (base.preorderReleaseAt === null ? null : num(base.preorderReleaseAt));
    const historyMonths = historyMonthsOf(base.firstAt === null ? null : num(base.firstAt), now);
    const result = forecastOf({ monthly, historyMonths, releaseAt, preorderUnits: num(base.preorders), now });
    return { monthly, months, thisMonth: units.get(current) ?? 0, historyMonths, available: num(base.available), releaseAt, preorderUnits: num(base.preorders), result, demo: base.isDemo === 1 };
  });
  return { rows, bases, months };
}

const matchesView = (row: { result: ForecastResult }, view: ForecastView) =>
  view === "all" ? true : view === "forecast" ? row.result.status === "forecast" : view === "short" ? row.result.status !== "forecast" : row.result.launch !== null;

export async function demandForecast(db: Db, actor: Actor, filters: ForecastFilters, locale: Locale, now: number): Promise<ForecastPage> {
  assertCan(actor, "automation.suggestion.read");
  const { rows, bases, months } = await computeAll(db, now);
  const q = filters.q.toLowerCase();
  const all = rows.map((row, index) => {
    const base = bases[index];
    const name = skuName(base.productName, base.title, locale);
    return { ...row, variant: { id: base.id, sku: base.sku, name, href: recordHref(actor, "variant", { variantId: base.id }) } } as ForecastRow;
  });
  const searched = q ? all.filter((row) => row.variant.sku.toLowerCase().includes(q) || row.variant.name.toLowerCase().includes(q)) : all;
  const counts = { all: searched.length, forecast: 0, short: 0, launch: 0 } as Record<ForecastView, number>;
  for (const row of searched) {
    if (matchesView(row, "forecast")) counts.forecast++;
    if (matchesView(row, "short")) counts.short++;
    if (matchesView(row, "launch")) counts.launch++;
  }
  const rank = (row: ForecastRow) => (row.result.launch === "upcoming" ? 0 : row.result.status === "forecast" ? 1 : row.result.launch === "recent" ? 2 : 3);
  const filtered = searched.filter((row) => matchesView(row, filters.view)).sort((a, b) => rank(a) - rank(b) || (b.result.forecast ?? -1) - (a.result.forecast ?? -1) || a.variant.sku.localeCompare(b.variant.sku));
  const offset = (filters.page - 1) * PAGE_SIZE;
  return { rows: filtered.slice(offset, offset + PAGE_SIZE), total: filtered.length, page: filters.page, pageCount: Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), counts, nextMonth: monthKey(now, 1), months };
}

/** Next month's forecast of every SKU that has one, kept in `demand_forecasts` with its method and inputs (the daily job). */
export async function storeDemandForecasts(db: Db, now: number): Promise<{ status: "succeeded" | "skipped"; stats: Record<string, number>; error: null }> {
  const { rows, bases } = await computeAll(db, now);
  const period = monthKey(now, 1);
  const values = rows
    .map((row, index) => ({ row, base: bases[index] }))
    .filter(({ row }) => row.result.status === "forecast" && row.result.forecast !== null)
    .map(({ row, base }) => ({
      id: `dfc_${base.id}_${period}`.slice(0, 64),
      variantId: base.id,
      period,
      qtyForecast: row.result.forecast as number,
      method: row.result.seasonalIndex === null ? "moving_average_3m" : "moving_average_3m_seasonal",
      inputs: { monthly: row.monthly, months: row.months, historyMonths: row.historyMonths, movingAverage: row.result.movingAverage, seasonalIndex: row.result.seasonalIndex, sameMonthLastYear: row.result.sameMonthLastYear, demo: row.demo },
      createdAt: now,
    }));
  if (!values.length) return { status: "skipped", stats: { stored: 0, skus: rows.length }, error: null };
  await runBatch(
    db,
    chunkRows(demandForecasts, values).map((chunk) =>
      db
        .insert(demandForecasts)
        .values(chunk)
        .onConflictDoUpdate({ target: [demandForecasts.variantId, demandForecasts.period, demandForecasts.method], set: { qtyForecast: sql`excluded.qty_forecast`, inputs: sql`excluded.inputs`, createdAt: sql`excluded.created_at` } }),
    ),
  );
  return { status: "succeeded", stats: { stored: values.length, skus: rows.length }, error: null };
}
