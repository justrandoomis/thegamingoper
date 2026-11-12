/**
 * Admin 18.01 — sales by day, platform, branch and channel (reports.sales.read).
 *
 *   const report = await salesReport(db, actor, parseSalesParams(url.searchParams, now), locale, now);
 *
 * The totals are the commerce core's: revenueRecognised (accounting/reports.server.ts, docs/metrics.md §3) for revenue,
 * discounts, refunds, shipping income and net revenue; orders placed, GMV, AOV, cancellations and paid sales from the
 * orders, payments and refunds exactly as §3 defines them. The rows split the same journal lines (./revenue.server.ts)
 * and each row's figures plus "not attributed" add up to the totals — checked on every request (`consistent`).
 * Demo rows are left out unless the range asks for them (§1). No cost is read anywhere in this file.
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import type { Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { revenueRecognised } from "~/server/services/accounting/reports.server";
import { dayStart, baghdadDay, DAY_MS } from "../finance/types";
import { revenueByDimension, revenueByLine, unitsByDimension } from "./revenue.server";
import { assertReport, branchNames, num, platformNames } from "./shared.server";
import { addRevenue, bpsOfShare, DAY_PAGE_SIZE, NO_REVENUE, PAGE_SIZE, sameRevenue, type RevenueFigures, type SalesParams, type SalesReport, type SalesRow } from "./types";

const BAGHDAD_MS = 3 * 60 * 60 * 1000;

type Placed = { placed: number; gmv: number; cancelled: number };

async function placedBy(db: Db, scope: { from: number; to: number; includeDemo: boolean }, dimension: "day" | "channel" | "branch" | "platform"): Promise<Map<string | null, Placed>> {
  const demo = scope.includeDemo ? 1 : 0;
  if (dimension === "platform") {
    const rows = await db.all<{ k: string | null; placed: number }>(sql`
      SELECT p.platform_id AS k, count(DISTINCT o.id) AS placed
      FROM orders AS o JOIN order_items AS oi ON oi.order_id = o.id
      LEFT JOIN used_units AS uu ON uu.id = oi.used_unit_id
      LEFT JOIN variants AS v ON v.id = coalesce(oi.variant_id, uu.variant_id)
      LEFT JOIN products AS p ON p.id = v.product_id
      WHERE o.placed_at >= ${scope.from} AND o.placed_at < ${scope.to} AND (o.is_demo = 0 OR ${demo} = 1)
      GROUP BY k`);
    return new Map(rows.map((row) => [row.k ?? null, { placed: num(row.placed), gmv: 0, cancelled: 0 }]));
  }
  const key =
    dimension === "day"
      ? sql`strftime('%Y-%m-%d', (o.placed_at + ${BAGHDAD_MS}) / 1000, 'unixepoch')`
      : dimension === "channel"
        ? sql`o.channel`
        : sql`coalesce(o.branch_id, '~' || o.channel)`;
  const rows = await db.all<{ k: string; placed: number; gmv: number; cancelled: number }>(sql`
    SELECT ${key} AS k, count(*) AS placed,
           coalesce(sum(CASE WHEN o.status <> 'cancelled' THEN o.total_iqd ELSE 0 END), 0) AS gmv,
           coalesce(sum(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
    FROM orders AS o
    WHERE o.placed_at >= ${scope.from} AND o.placed_at < ${scope.to} AND (o.is_demo = 0 OR ${demo} = 1)
    GROUP BY k`);
  return new Map(rows.map((row) => [row.k, { placed: num(row.placed), gmv: num(row.gmv), cancelled: num(row.cancelled) }]));
}

/** Orders placed, GMV, AOV, cancellations and paid sales of the range (docs/metrics.md §3). */
async function operations(db: Db, scope: { from: number; to: number; includeDemo: boolean }): Promise<Omit<SalesReport["operations"], "unitsSold">> {
  const demo = scope.includeDemo ? 1 : 0;
  const [placed, paid] = await Promise.all([
    db.all<{ placed: number; gmv: number; cancelled: number; basket: number }>(sql`
      SELECT count(*) AS placed,
             coalesce(sum(CASE WHEN o.status <> 'cancelled' THEN o.total_iqd ELSE 0 END), 0) AS gmv,
             coalesce(sum(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
             coalesce(sum(CASE WHEN o.status <> 'cancelled' THEN o.subtotal_iqd - o.discount_iqd ELSE 0 END), 0) AS basket
      FROM orders AS o WHERE o.placed_at >= ${scope.from} AND o.placed_at < ${scope.to} AND (o.is_demo = 0 OR ${demo} = 1)`),
    db.all<{ paid: number; refunded: number; back: number; shipped: number }>(sql`
      SELECT (SELECT coalesce(sum(p.amount_iqd), 0) FROM payments AS p JOIN orders AS o ON o.id = p.order_id
              WHERE p.status = 'paid' AND p.paid_at >= ${scope.from} AND p.paid_at < ${scope.to} AND (o.is_demo = 0 OR ${demo} = 1)) AS paid,
             (SELECT coalesce(sum(r.amount_iqd), 0) FROM refunds AS r JOIN orders AS o ON o.id = r.order_id
              WHERE r.status = 'paid' AND r.paid_at >= ${scope.from} AND r.paid_at < ${scope.to} AND (o.is_demo = 0 OR ${demo} = 1)) AS refunded,
             (SELECT coalesce(sum(m.qty_delta), 0) FROM stock_movements AS m JOIN orders AS o ON o.id = m.ref_id
              WHERE m.ref_type = 'order' AND m.kind = 'return' AND m.at >= ${scope.from} AND m.at < ${scope.to} AND (o.is_demo = 0 OR ${demo} = 1)) AS back,
             (SELECT coalesce(sum(-m.qty_delta), 0) FROM stock_movements AS m JOIN orders AS o ON o.id = m.ref_id
              WHERE m.ref_type = 'order' AND m.kind = 'sale' AND m.at >= ${scope.from} AND m.at < ${scope.to} AND (o.is_demo = 0 OR ${demo} = 1)) AS shipped`),
  ]);
  const p = placed[0];
  const count = num(p?.placed);
  const cancelled = num(p?.cancelled);
  const kept = count - cancelled;
  const paidIqd = num(paid[0]?.paid);
  const refundedIqd = num(paid[0]?.refunded);
  return {
    placed: count,
    gmvIqd: num(p?.gmv),
    cancelled,
    aovIqd: kept > 0 ? Math.round(num(p?.basket) / kept) : null,
    cancellationBps: bpsOfShare(cancelled, count),
    paidSalesIqd: paidIqd - refundedIqd,
    refundRateBps: bpsOfShare(refundedIqd, paidIqd),
    returnRateBps: bpsOfShare(num(paid[0]?.back), num(paid[0]?.shipped)),
  };
}

function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = dayStart(from); at <= dayStart(to); at += DAY_MS) out.push(baghdadDay(at));
  return out;
}

/** 18.01 — one page of the breakdown (every row with `all`, for the export) with the range's totals. */
export async function salesReport(db: Db, actor: Actor, params: SalesParams, locale: Locale, now: number, options: { all?: boolean } = {}): Promise<SalesReport> {
  assertReport(actor, "sales");
  void now;
  const { range, by } = params;
  const scope = { from: range.fromMs, to: range.toMs, includeDemo: range.demo };

  const [core, ops, unitsTotal, rowsAndRest] = await Promise.all([
    revenueRecognised(db, scope),
    operations(db, scope),
    unitsByDimension(db, scope, "total"),
    buildRows(db, scope, params, locale),
  ]);
  const totals = { grossIqd: core.grossIqd, discountsIqd: core.discountsIqd, refundsIqd: core.refundsIqd, shippingIqd: core.shippingIncomeIqd, netIqd: core.netIqd, ordersRecognised: core.ordersRecognised };
  const { rows, unattributed, tooMany } = rowsAndRest;
  const sum = rows.reduce<RevenueFigures>((acc, row) => addRevenue(acc, row.revenue), { ...NO_REVENUE });
  const consistent = tooMany !== null || sameRevenue(addRevenue(sum, unattributed), totals);
  const size = options.all ? Math.max(1, rows.length) : by === "day" ? DAY_PAGE_SIZE : PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(options.all ? 1 : params.page, pageCount);
  return {
    by,
    range: { from: range.from, to: range.to, period: range.period, demo: range.demo },
    totals,
    operations: { ...ops, unitsSold: unitsTotal.get("total") ?? 0 },
    rows: rows.slice((page - 1) * size, page * size),
    unattributed,
    consistent,
    tooMany,
    page,
    pageCount,
    total: rows.length,
  };
}

async function buildRows(db: Db, scope: { from: number; to: number; includeDemo: boolean }, params: SalesParams, locale: Locale): Promise<{ rows: SalesRow[]; unattributed: RevenueFigures; tooMany: { orders: number } | null }> {
  const { range, by } = params;
  if (by === "platform") {
    const [lines, placed, names] = await Promise.all([revenueByLine(db, scope), placedBy(db, scope, "platform"), platformNames(db, locale)]);
    if (lines.tooMany) return { rows: [], unattributed: { ...NO_REVENUE }, tooMany: { orders: lines.orders } };
    const groups = new Map<string | null, { revenue: RevenueFigures; units: number; orders: Set<string> }>();
    for (const line of lines.lines) {
      const figures = lines.byLine.get(line.id);
      if (!figures) continue;
      const group = groups.get(line.platformId) ?? { revenue: { ...NO_REVENUE }, units: 0, orders: new Set<string>() };
      group.revenue = addRevenue(group.revenue, figures);
      group.units += figures.units;
      if (lines.sold.has(line.orderId)) group.orders.add(line.orderId);
      groups.set(line.platformId, group);
    }
    for (const key of placed.keys()) if (!groups.has(key)) groups.set(key, { revenue: { ...NO_REVENUE }, units: 0, orders: new Set() });
    const rows: SalesRow[] = [...groups.entries()].map(([id, group]) => ({
      key: id ?? "~none",
      label: { kind: "platform", id },
      name: id ? (names.get(id) ?? id) : null,
      revenue: group.revenue,
      ordersRecognised: group.orders.size,
      units: group.units,
      placed: placed.get(id)?.placed ?? 0,
      gmvIqd: null,
      cancelled: null,
    }));
    rows.sort((a, b) => b.revenue.netIqd - a.revenue.netIqd || (b.placed ?? 0) - (a.placed ?? 0) || (a.name ?? "~").localeCompare(b.name ?? "~"));
    return { rows, unattributed: lines.unattributed, tooMany: null };
  }

  const [revenue, placed, units, names] = await Promise.all([revenueByDimension(db, scope, by), placedBy(db, scope, by), unitsByDimension(db, scope, by), by === "branch" ? branchNames(db, locale) : Promise.resolve(new Map<string, string>())]);
  const unattributed = revenue.get(null) ?? { ...NO_REVENUE, ordersRecognised: 0 };
  const keys: string[] =
    by === "day"
      ? daysOf(range.from, range.to)
      : by === "channel"
        ? ["web", "pos"]
        : [...new Set([...revenue.keys(), ...placed.keys(), ...units.keys()].filter((key): key is string => key !== null))];
  const rows: SalesRow[] = keys.map((key) => {
    const figures = revenue.get(key);
    const place = placed.get(key);
    const label: SalesRow["label"] =
      by === "day" ? { kind: "day", day: key } : by === "channel" ? { kind: "channel", channel: key === "pos" ? "pos" : "web" } : key.startsWith("~") ? { kind: "branch", id: null, channel: key === "~pos" ? "pos" : "web" } : { kind: "branch", id: key, channel: null };
    return {
      key,
      label,
      name: by === "branch" && !key.startsWith("~") ? (names.get(key) ?? key) : null,
      revenue: figures ? { grossIqd: figures.grossIqd, discountsIqd: figures.discountsIqd, refundsIqd: figures.refundsIqd, shippingIqd: figures.shippingIqd, netIqd: figures.netIqd } : { ...NO_REVENUE },
      ordersRecognised: figures?.ordersRecognised ?? 0,
      units: units.get(key) ?? 0,
      placed: place?.placed ?? 0,
      gmvIqd: place?.gmv ?? 0,
      cancelled: place?.cancelled ?? 0,
    };
  });
  if (by === "branch") rows.sort((a, b) => b.revenue.netIqd - a.revenue.netIqd || (b.placed ?? 0) - (a.placed ?? 0) || a.key.localeCompare(b.key));
  const { ordersRecognised: _orders, ...rest } = unattributed;
  void _orders;
  return { rows, unattributed: rest, tooMany: null };
}
