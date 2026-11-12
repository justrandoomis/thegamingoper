/**
 * Admin 18.03 — ABC analysis, inventory turnover and dead stock (reports.inventory.read).
 *
 *   ABC        computed here: each SKU's share of the range's value — net revenue recognised in the range (the journal,
 *              split over order lines by ./revenue.server.ts, the same figures as sales by platform) or units sold —
 *              ranked largest first; the SKUs that make up the first 80 % are A, the next 15 % B, the rest C
 *              (ABC_BOUNDS). With the units on hand today (pricing 03's onHandFor), so "an A item with nothing on hand"
 *              is one look.
 *   turnover   module 04's own report (inventoryReport "turnover": units sold ÷ average units on hand, days of
 *   dead stock inventory; "dead": units on hand with no sale in the period) — reused, never recomputed; it needs
 *              inventory.report.read, which module 04's service checks. Its money columns follow its cost.read rule.
 * No cost is read for ABC (net revenue and units are not cost data).
 */
import type { Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { inventoryReport, inventoryReportCsv, type ReportData } from "../inventory/analytics.server";
import { onHandFor } from "../pricing/facts.server";
import { revenueByLine } from "./revenue.server";
import { assertReport, l10nText } from "./shared.server";
import { ABC_BOUNDS, ABC_CLASSES, PAGE_SIZE, type AbcBasis, type AbcClass, type InventoryParams, type RangeFilter } from "./types";

export type AbcRow = {
  key: string;
  variantId: string | null;
  used: boolean;
  sku: string;
  name: string;
  netRevenueIqd: number;
  units: number;
  /** The ranked value (net revenue or units). */
  value: number;
  /** value ÷ Σ positive values (0–1); 0 for a value of zero or below. */
  share: number;
  /** Running share up to and including this SKU. */
  cumulative: number;
  abcClass: AbcClass;
  /** Units on hand today, all locations (page rows only); null for a used device. */
  onHand?: number | null;
};

export type AbcSummary = Record<AbcClass, { skus: number; value: number; share: number }>;

export type AbcReport = {
  basis: AbcBasis;
  range: Pick<RangeFilter, "from" | "to" | "period" | "demo">;
  tooMany: { orders: number } | null;
  totalValue: number;
  classes: AbcSummary;
  /** A-class SKUs with nothing on hand now (new stock only). */
  aOutOfStock: number;
  rows: AbcRow[];
  abcClass: AbcClass | null;
  page: number;
  pageCount: number;
  total: number;
  /** Links to module 04's stock page only for inventory.stock.read. */
  canOpenStock: boolean;
};

/** Ranks and classifies (pure; exported for the tests): A while the running share before the SKU is under 80 %. */
export function classify<T extends { value: number; key: string }>(items: readonly T[]): (T & { share: number; cumulative: number; abcClass: AbcClass })[] {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const sorted = [...items].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  let before = 0;
  return sorted.map((item) => {
    const share = total > 0 && item.value > 0 ? item.value / total : 0;
    const abcClass: AbcClass = item.value <= 0 || total <= 0 ? "C" : before < ABC_BOUNDS.a ? "A" : before < ABC_BOUNDS.b ? "B" : "C";
    before += share;
    return { ...item, share, cumulative: Math.min(1, before), abcClass };
  });
}

/** Every SKU of the range, classified (the page pages them; the export takes them all). */
export async function abcRows(db: Db, actor: Actor, range: RangeFilter, basis: AbcBasis, locale: Locale): Promise<{ tooMany: { orders: number } | null; rows: AbcRow[]; totalValue: number; classes: AbcSummary }> {
  assertReport(actor, "inventory");
  const lines = await revenueByLine(db, { from: range.fromMs, to: range.toMs, includeDemo: range.demo });
  const empty = Object.fromEntries(ABC_CLASSES.map((c) => [c, { skus: 0, value: 0, share: 0 }])) as AbcSummary;
  if (lines.tooMany) return { tooMany: { orders: lines.orders }, rows: [], totalValue: 0, classes: empty };
  const groups = new Map<string, { variantId: string | null; used: boolean; sku: string; name: string; net: number; units: number }>();
  for (const line of lines.lines) {
    const figures = lines.byLine.get(line.id);
    if (!figures) continue;
    const used = Boolean(line.usedUnitId);
    const key = `${line.variantId ?? line.sku}|${used ? "used" : "new"}`;
    const group = groups.get(key) ?? { variantId: line.variantId, used, sku: line.sku, name: l10nText(line.productName, locale) || l10nText(line.name, locale) || line.sku, net: 0, units: 0 };
    group.net += figures.netIqd;
    group.units += figures.units;
    groups.set(key, group);
  }
  const ranked = classify([...groups.entries()].map(([key, group]) => ({ key, ...group, value: basis === "units" ? group.units : group.net })));
  const rows: AbcRow[] = ranked.map((row) => ({ key: row.key, variantId: row.variantId, used: row.used, sku: row.sku, name: row.name, netRevenueIqd: row.net, units: row.units, value: row.value, share: row.share, cumulative: row.cumulative, abcClass: row.abcClass }));
  const totalValue = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  const classes = empty;
  for (const row of rows) {
    classes[row.abcClass].skus += 1;
    classes[row.abcClass].value += row.value;
  }
  for (const c of ABC_CLASSES) classes[c].share = totalValue > 0 ? Math.max(0, classes[c].value) / totalValue : 0;
  return { tooMany: null, rows, totalValue, classes };
}

/** 18.03 ABC — one page, the class summary, and how many A items have nothing on hand. */
export async function abcReport(db: Db, actor: Actor, params: InventoryParams, locale: Locale): Promise<AbcReport> {
  const result = await abcRows(db, actor, params.range, params.basis, locale);
  const filtered = params.abcClass ? result.rows.filter((row) => row.abcClass === params.abcClass) : result.rows;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(params.page, pageCount);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const aStock = result.rows.filter((row) => row.abcClass === "A" && !row.used && row.variantId);
  const ids = [...new Set([...aStock, ...rows].filter((row) => !row.used && row.variantId).map((row) => row.variantId as string))];
  const onHand = ids.length ? await onHandFor(db, ids) : new Map<string, number>();
  for (const row of rows) row.onHand = row.used || !row.variantId ? null : (onHand.get(row.variantId) ?? 0);
  return {
    basis: params.basis,
    range: { from: params.range.from, to: params.range.to, period: params.range.period, demo: params.range.demo },
    tooMany: result.tooMany,
    totalValue: result.totalValue,
    classes: result.classes,
    aOutOfStock: aStock.filter((row) => (onHand.get(row.variantId as string) ?? 0) <= 0).length,
    rows,
    abcClass: params.abcClass,
    page,
    pageCount,
    total: filtered.length,
    canOpenStock: can(actor, "inventory.stock.read"),
  };
}

export type StockReport = { needs: "inventory.report.read" } | { needs: null; report: ReportData & { page: number; pageCount: number } };

/** 18.03 turnover / dead stock — module 04's report, when the viewer holds inventory.report.read (module 04 checks it). */
export async function stockReport(db: Db, actor: Actor, params: InventoryParams, locale: Locale, now: number): Promise<StockReport> {
  assertReport(actor, "inventory");
  if (!can(actor, "inventory.report.read")) return { needs: "inventory.report.read" };
  const report = await inventoryReport(db, actor, { report: params.view === "turnover" ? "turnover" : "dead", days: params.days, page: params.page }, locale, now);
  return { needs: null, report };
}

/** Module 04's CSV of the turnover / dead-stock report (its columns, its cost rule, formula-safe cells). */
export async function stockReportCsv(db: Db, actor: Actor, params: InventoryParams, locale: Locale, now: number, headers: Record<string, string>): Promise<string> {
  assertReport(actor, "inventory");
  return inventoryReportCsv(db, actor, { report: params.view === "turnover" ? "turnover" : "dead", days: params.days }, locale, now, headers);
}
