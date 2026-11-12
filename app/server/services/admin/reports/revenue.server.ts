/**
 * Admin module 18 — the journal's revenue, attributed. The ONE place this module splits docs/metrics.md §3's revenue
 * figures (revenue, discounts, refunds, shipping income) across days, channels, branches and order lines. It never
 * defines revenue again: it reads exactly the lines accounting/reports.server.ts's revenueRecognised reads — the
 * accounts of the four system families (an accountant's sub-account counts with its parent: familyIds/systemRoots of
 * the core), lines joined to their entry header, demo entries only when asked — and the reports check that their rows
 * plus what could not be attributed add up to the core's own totals to the dinar.
 *
 *   const totals = await revenueRecognised(db, scope);              // the core (accounting/reports.server.ts)
 *   const byDay = await revenueByDimension(db, scope, "day");       // Map<"2026-11-03", figures>
 *   const lines = await revenueByLine(db, scope);                    // each order line's share (platform, SKU, ABC)
 *
 * Attribution rules (also on the dictionary page, /admin/reports/dictionary):
 *   · an entry belongs to an order when it is the order's own posting (ref "order": the sale at delivery) or a refund
 *     of it (ref "refund" → refunds.order_id); anything else (a manual entry on a revenue account) is "not attributed"
 *     and is shown as such, never dropped
 *   · day = the Baghdad day of the entry; channel and branch = the order's (a web order has no branch: "online store")
 *   · an order's amounts are split over its lines exactly to the dinar (pricing 03's allocateAmount): revenue,
 *     discounts and shipping income by line value; a refund that names its items by those items' value, otherwise by
 *     line value — a refund paid BEFORE delivery too: it reaches the revenue accounts inside the sale's own posting
 *     (Dr sales refunds at recognition, docs/metrics.md §2), split refund by refund the same way (review 2026-11-12:
 *     it was spread by line value, so sales by platform and ABC disagreed with the margin report)
 *   · units = the units of the orders recognised in the range, less the units that came back (stock movements of kind
 *     "return"); a returned used device is not subtracted (no movement records it)
 *
 * Must not import "cloudflare:workers".
 */
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "~/server/db/drizzle.server";
import type { SystemAccountKey } from "~/server/db/schema";
import { chartOfAccounts, systemRoots, type JournalScope } from "~/server/services/accounting/reports.server";
import { allocateAmount } from "../pricing/rules";
import { num } from "./shared.server";
import { MAX_LINE_ORDERS, NO_REVENUE, type RevenueFigures } from "./types";

export const REVENUE_FAMILIES = ["sales_revenue", "sales_discounts", "sales_refunds", "shipping_income"] as const satisfies readonly SystemAccountKey[];
type Family = (typeof REVENUE_FAMILIES)[number];

const BAGHDAD_MS = 3 * 60 * 60 * 1000;

/** [[accountId, family], …] of every account in the four revenue families, as one JSON parameter. */
async function familyJson(db: Db): Promise<string> {
  const chart = await chartOfAccounts(db);
  const roots = systemRoots(chart);
  const pairs: [string, Family][] = [];
  for (const account of chart) {
    const root = roots.get(account.id);
    if (root && (REVENUE_FAMILIES as readonly string[]).includes(root)) pairs.push([account.id, root as Family]);
  }
  return JSON.stringify(pairs);
}

/**
 * The entries in scope that touch a revenue family, each with the order it belongs to (null = not attributable).
 * Same scope rules as the core's scopeConditions: [from, to), demo entries only with includeDemo.
 */
function entriesCte(fam: string, scope: Required<Pick<JournalScope, "from" | "to">> & { includeDemo?: boolean }): SQL {
  const demo = scope.includeDemo ? 1 : 0;
  return sql`
    fam AS (SELECT json_extract(value, '$[0]') AS account_id, json_extract(value, '$[1]') AS family FROM json_each(${fam})),
    ent AS (
      SELECT e.id AS id, e.at AS at, e.ref_type AS ref_type, e.ref_id AS ref_id, e.idempotency_key AS ikey,
             CASE WHEN e.ref_type = 'order' THEN e.ref_id
                  WHEN e.ref_type = 'refund' THEN (SELECT r.order_id FROM refunds AS r WHERE r.id = e.ref_id) END AS order_id
      FROM journal_entries AS e
      WHERE e.at >= ${scope.from} AND e.at < ${scope.to} AND (e.is_demo = 0 OR ${demo} = 1)
        AND EXISTS (SELECT 1 FROM journal_lines AS jl JOIN fam AS f2 ON f2.account_id = jl.account_id WHERE jl.entry_id = e.id)
    )`;
}

const FIGURE_COLUMNS = sql`
  coalesce(sum(CASE WHEN f.family = 'sales_revenue' THEN l.credit_iqd - l.debit_iqd END), 0) AS gross,
  coalesce(sum(CASE WHEN f.family = 'sales_discounts' THEN l.debit_iqd - l.credit_iqd END), 0) AS discounts,
  coalesce(sum(CASE WHEN f.family = 'sales_refunds' THEN l.debit_iqd - l.credit_iqd END), 0) AS refunds,
  coalesce(sum(CASE WHEN f.family = 'shipping_income' THEN l.credit_iqd - l.debit_iqd END), 0) AS shipping`;

function figures(row: { gross: unknown; discounts: unknown; refunds: unknown; shipping: unknown }): RevenueFigures {
  const grossIqd = num(row.gross);
  const discountsIqd = num(row.discounts);
  const refundsIqd = num(row.refunds);
  return { grossIqd, discountsIqd, refundsIqd, shippingIqd: num(row.shipping), netIqd: grossIqd - discountsIqd - refundsIqd };
}

type Scope = { from: number; to: number; includeDemo: boolean };

export type DimensionFigures = RevenueFigures & { ordersRecognised: number };

/**
 * Revenue per Baghdad day / channel / branch of the entries in scope. Keys: "YYYY-MM-DD"; "web" | "pos"; a branch id,
 * "~web" (online store) or "~pos" (a counter sale without a branch). The key null holds what is not attributable.
 */
export async function revenueByDimension(db: Db, scope: Scope, dimension: "day" | "channel" | "branch"): Promise<Map<string | null, DimensionFigures>> {
  const fam = await familyJson(db);
  const key =
    dimension === "day"
      ? sql`strftime('%Y-%m-%d', (ent.at + ${BAGHDAD_MS}) / 1000, 'unixepoch')`
      : dimension === "channel"
        ? sql`o.channel`
        : sql`CASE WHEN o.id IS NULL THEN NULL ELSE coalesce(o.branch_id, '~' || o.channel) END`;
  const rows = await db.all<{ k: string | null; gross: number; discounts: number; refunds: number; shipping: number; orders: number }>(sql`
    WITH ${entriesCte(fam, scope)}
    SELECT ${key} AS k, ${FIGURE_COLUMNS},
           count(DISTINCT CASE WHEN ent.ref_type = 'order' AND ent.ikey LIKE 'order:%:sale' THEN ent.ref_id END) AS orders
    FROM ent JOIN journal_lines AS l ON l.entry_id = ent.id JOIN fam AS f ON f.account_id = l.account_id
    LEFT JOIN orders AS o ON o.id = ent.order_id
    GROUP BY k`);
  return new Map(rows.map((row) => [row.k ?? null, { ...figures(row), ordersRecognised: num(row.orders) }]));
}

/** Units of the orders recognised in scope, less the units that came back — per day / channel / branch (keys as above). */
export async function unitsByDimension(db: Db, scope: Scope, dimension: "day" | "channel" | "branch" | "total"): Promise<Map<string | null, number>> {
  const demo = scope.includeDemo ? 1 : 0;
  const key =
    dimension === "day"
      ? sql`strftime('%Y-%m-%d', (sold.at + ${BAGHDAD_MS}) / 1000, 'unixepoch')`
      : dimension === "channel"
        ? sql`o.channel`
        : dimension === "branch"
          ? sql`coalesce(o.branch_id, '~' || o.channel)`
          : sql`'total'`;
  const sold = sql`sold AS (
      SELECT e.ref_id AS order_id, min(e.at) AS at FROM journal_entries AS e
      WHERE e.ref_type = 'order' AND e.idempotency_key LIKE 'order:%:sale' AND e.at >= ${scope.from} AND e.at < ${scope.to} AND (e.is_demo = 0 OR ${demo} = 1)
      GROUP BY e.ref_id)`;
  const [out, back] = await Promise.all([
    db.all<{ k: string | null; units: number }>(sql`
      WITH ${sold}
      SELECT ${key} AS k, coalesce(sum(oi.qty), 0) AS units FROM sold JOIN orders AS o ON o.id = sold.order_id JOIN order_items AS oi ON oi.order_id = o.id GROUP BY k`),
    db.all<{ k: string | null; units: number }>(sql`
      WITH ${sold}
      SELECT ${key} AS k, coalesce(sum(m.qty_delta), 0) AS units FROM sold JOIN orders AS o ON o.id = sold.order_id
      JOIN stock_movements AS m ON m.ref_type = 'order' AND m.ref_id = o.id AND m.kind = 'return' GROUP BY k`),
  ]);
  const result = new Map<string | null, number>();
  for (const row of out) result.set(row.k ?? null, num(row.units));
  for (const row of back) result.set(row.k ?? null, (result.get(row.k ?? null) ?? 0) - num(row.units));
  return result;
}

// ───────────────────────────────────────────────────────────────── per order line

export type OrderLineFacts = {
  id: string;
  orderId: string;
  /** The catalogue variant (a used device's own variant for a used line). */
  variantId: string | null;
  usedUnitId: string | null;
  sku: string;
  /** The line's name as sold (snapshot). */
  name: unknown;
  /** The product's current name. */
  productName: unknown;
  platformId: string | null;
  qty: number;
  totalIqd: number;
};

export type LineRevenue = RevenueFigures & { units: number };

export type LineRevenueResult =
  | { tooMany: true; orders: number }
  | {
      tooMany: false;
      /** Orders with a revenue posting in scope. */
      orders: number;
      /** Orders whose sale (delivery) was recognised in scope. */
      sold: ReadonlySet<string>;
      lines: OrderLineFacts[];
      byLine: Map<string, LineRevenue>;
      /** Revenue postings of no order, or of an order that has no lines. */
      unattributed: RevenueFigures;
    };

/** Splits a signed amount over weights exactly to the dinar; zero weights everywhere → by `fallback`, then equally. */
export function splitAmount(amountIqd: number, weights: readonly { id: string; weight: number }[], fallback?: readonly { id: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>(weights.map((entry) => [entry.id, 0]));
  if (amountIqd === 0 || weights.length === 0) return out;
  const usable = (list: readonly { id: string; weight: number }[] | undefined) => (list && list.some((entry) => Math.round(entry.weight) > 0) ? list : null);
  const basis = usable(weights) ?? usable(fallback) ?? weights.map((entry) => ({ id: entry.id, weight: 1 }));
  const shares = allocateAmount(Math.abs(amountIqd), basis.map((entry) => ({ id: entry.id, weight: Math.max(0, Math.round(entry.weight)) })));
  for (const [id, share] of shares) out.set(id, amountIqd < 0 ? -share : share);
  return out;
}

/**
 * Each order line's share of the revenue in scope (see the header for the rules), with the units recognised.
 * Refused above MAX_LINE_ORDERS orders (`tooMany`): the caller says so instead of showing a partial figure.
 */
export async function revenueByLine(db: Db, scope: Scope): Promise<LineRevenueResult> {
  const fam = await familyJson(db);
  const ctes = entriesCte(fam, scope);
  const counted = await db.all<{ n: number }>(sql`WITH ${ctes} SELECT count(DISTINCT order_id) AS n FROM ent WHERE order_id IS NOT NULL`);
  const orders = num(counted[0]?.n);
  if (orders > MAX_LINE_ORDERS) return { tooMany: true, orders };

  const [amounts, lineRows, refundItems, returned, refundedBefore] = await Promise.all([
    db.all<{ orderId: string | null; refType: string | null; refId: string | null; family: Family; credit: number; debit: number; isSale: number }>(sql`
      WITH ${ctes}
      SELECT ent.order_id AS orderId, ent.ref_type AS refType, ent.ref_id AS refId, f.family AS family,
             coalesce(sum(l.credit_iqd), 0) AS credit, coalesce(sum(l.debit_iqd), 0) AS debit,
             max(CASE WHEN ent.ref_type = 'order' AND ent.ikey LIKE 'order:%:sale' THEN 1 ELSE 0 END) AS isSale
      FROM ent JOIN journal_lines AS l ON l.entry_id = ent.id JOIN fam AS f ON f.account_id = l.account_id
      GROUP BY ent.order_id, ent.ref_type, ent.ref_id, f.family`),
    db.all<{ id: string; orderId: string; variantId: string | null; usedUnitId: string | null; sku: string; name: unknown; productName: unknown; platformId: string | null; qty: number; totalIqd: number }>(sql`
      WITH ${ctes}, ord AS (SELECT DISTINCT order_id FROM ent WHERE order_id IS NOT NULL)
      SELECT oi.id AS id, oi.order_id AS orderId, coalesce(oi.variant_id, uu.variant_id) AS variantId, oi.used_unit_id AS usedUnitId,
             coalesce(oi.sku, v.sku, '') AS sku, oi.name_snapshot AS name, p.name AS productName, p.platform_id AS platformId,
             oi.qty AS qty, oi.total_iqd AS totalIqd
      FROM ord JOIN order_items AS oi ON oi.order_id = ord.order_id
      LEFT JOIN used_units AS uu ON uu.id = oi.used_unit_id
      LEFT JOIN variants AS v ON v.id = coalesce(oi.variant_id, uu.variant_id)
      LEFT JOIN products AS p ON p.id = v.product_id
      ORDER BY oi.order_id, oi.id`),
    db.all<{ refundId: string; orderItemId: string; qty: number }>(sql`
      WITH ${ctes}
      SELECT ri.refund_id AS refundId, ri.order_item_id AS orderItemId, ri.qty AS qty FROM refund_items AS ri
      WHERE ri.refund_id IN (SELECT ref_id FROM ent WHERE ref_type = 'refund')`),
    db.all<{ orderId: string; variantId: string; qty: number }>(sql`
      WITH ${ctes}
      SELECT m.ref_id AS orderId, m.variant_id AS variantId, coalesce(sum(m.qty_delta), 0) AS qty FROM stock_movements AS m
      WHERE m.kind = 'return' AND m.ref_type = 'order' AND m.ref_id IN (SELECT ref_id FROM ent WHERE ref_type = 'order' AND ikey LIKE 'order:%:sale')
      GROUP BY m.ref_id, m.variant_id`),
    // the paid refunds of the orders whose sale is in scope that were issued before delivery: their own posting debits
    // customer control, not a revenue family — the sale's posting carries them to sales refunds
    db.all<{ orderId: string; refundId: string; amount: number; orderItemId: string | null; qty: number | null }>(sql`
      WITH ${ctes}
      SELECT r.order_id AS orderId, r.id AS refundId, r.amount_iqd AS amount, ri.order_item_id AS orderItemId, ri.qty AS qty
      FROM refunds AS r LEFT JOIN refund_items AS ri ON ri.refund_id = r.id
      WHERE r.status = 'paid' AND r.order_id IN (SELECT ref_id FROM ent WHERE ref_type = 'order' AND ikey LIKE 'order:%:sale')
        AND NOT EXISTS (SELECT 1 FROM journal_entries AS re JOIN journal_lines AS rl ON rl.entry_id = re.id JOIN fam AS f3 ON f3.account_id = rl.account_id
                        WHERE re.ref_type = 'refund' AND re.ref_id = r.id AND f3.family = 'sales_refunds')
      ORDER BY r.order_id, r.id`),
  ]);

  const lines: OrderLineFacts[] = lineRows.map((row) => ({ ...row, qty: num(row.qty), totalIqd: num(row.totalIqd) }));
  const linesOf = new Map<string, OrderLineFacts[]>();
  for (const line of lines) linesOf.set(line.orderId, [...(linesOf.get(line.orderId) ?? []), line]);
  type RefundItem = { orderItemId: string; qty: number };
  const itemsOf = new Map<string, RefundItem[]>();
  for (const item of refundItems) itemsOf.set(item.refundId, [...(itemsOf.get(item.refundId) ?? []), { orderItemId: item.orderItemId, qty: num(item.qty) }]);
  // the refunds issued before delivery, per order: each with its amount and the items it names
  const beforeOf = new Map<string, { amount: number; items: RefundItem[] }[]>();
  const beforeById = new Map<string, { amount: number; items: RefundItem[] }>();
  for (const row of refundedBefore) {
    let refund = beforeById.get(row.refundId);
    if (!refund) {
      refund = { amount: num(row.amount), items: [] };
      beforeById.set(row.refundId, refund);
      beforeOf.set(row.orderId, [...(beforeOf.get(row.orderId) ?? []), refund]);
    }
    if (row.orderItemId) refund.items.push({ orderItemId: row.orderItemId, qty: num(row.qty) });
  }
  /** A refund's weights over the order's lines: the value of the items it names; none known → by line value. */
  const refundWeights = (orderLines: readonly OrderLineFacts[], items: readonly RefundItem[], byValue: { id: string; weight: number }[]) => {
    const known = items.filter((item) => orderLines.some((line) => line.id === item.orderItemId));
    if (known.length === 0) return byValue;
    return orderLines.map((line) => {
      const qty = known.filter((item) => item.orderItemId === line.id).reduce((sum, item) => sum + item.qty, 0);
      return { id: line.id, weight: line.qty > 0 ? (qty * line.totalIqd) / line.qty : 0 };
    });
  };

  const byLine = new Map<string, LineRevenue>(lines.map((line) => [line.id, { ...NO_REVENUE, units: 0 }]));
  let unattributed: RevenueFigures = { ...NO_REVENUE };
  const soldOrders = new Set<string>();

  for (const row of amounts) {
    const credit = num(row.credit);
    const debit = num(row.debit);
    const amount = row.family === "sales_revenue" || row.family === "shipping_income" ? credit - debit : debit - credit;
    const orderLines = row.orderId ? (linesOf.get(row.orderId) ?? []) : [];
    if (row.isSale && row.orderId) soldOrders.add(row.orderId);
    if (orderLines.length === 0) {
      unattributed = addFamily(unattributed, row.family, amount);
      continue;
    }
    const byValue = orderLines.map((line) => ({ id: line.id, weight: line.totalIqd }));
    const byQty = orderLines.map((line) => ({ id: line.id, weight: line.qty }));
    const fallback = byValue.some((entry) => entry.weight > 0) ? byValue : byQty;
    let weights = byValue;
    if (row.family === "sales_refunds" && row.refType === "refund" && row.refId) {
      weights = refundWeights(orderLines, itemsOf.get(row.refId) ?? [], byValue);
    } else if (row.family === "sales_refunds" && row.refType === "order" && row.isSale && row.orderId) {
      // the refunds issued before delivery, inside the sale's posting: each split by its own items, and the posted
      // amount by those shares (the posting's amount is theirs, so the split is theirs to the dinar)
      const before = beforeOf.get(row.orderId) ?? [];
      if (before.length > 0) {
        const perLine = new Map<string, number>(orderLines.map((line) => [line.id, 0]));
        for (const refund of before) {
          for (const [id, part] of splitAmount(refund.amount, refundWeights(orderLines, refund.items, byValue), fallback)) perLine.set(id, (perLine.get(id) ?? 0) + part);
        }
        weights = orderLines.map((line) => ({ id: line.id, weight: perLine.get(line.id) ?? 0 }));
      }
    }
    const shares = splitAmount(amount, weights, fallback);
    for (const [lineId, share] of shares) {
      const current = byLine.get(lineId);
      if (current) byLine.set(lineId, { ...addFamily(current, row.family, share), units: current.units });
    }
  }

  // units: the lines of orders whose sale is in scope, less what came back (split over the order's lines of that variant)
  const back = new Map<string, number>(returned.map((row) => [`${row.orderId}|${row.variantId}`, num(row.qty)]));
  for (const orderId of soldOrders) {
    const orderLines = linesOf.get(orderId) ?? [];
    const byVariant = new Map<string, OrderLineFacts[]>();
    for (const line of orderLines) {
      const figures = byLine.get(line.id);
      if (figures) figures.units = line.qty;
      if (line.variantId && !line.usedUnitId) byVariant.set(line.variantId, [...(byVariant.get(line.variantId) ?? []), line]);
    }
    for (const [variantId, variantLines] of byVariant) {
      const returnedQty = Math.max(0, back.get(`${orderId}|${variantId}`) ?? 0);
      if (returnedQty === 0) continue;
      const split = splitAmount(returnedQty, variantLines.map((line) => ({ id: line.id, weight: line.qty })));
      for (const [lineId, qty] of split) {
        const figures = byLine.get(lineId);
        if (figures) figures.units = Math.max(0, figures.units - qty);
      }
    }
  }
  return { tooMany: false, orders, sold: soldOrders, lines, byLine, unattributed };
}

function addFamily(figures: RevenueFigures, family: Family, amount: number): RevenueFigures {
  const next = { ...figures };
  if (family === "sales_revenue") next.grossIqd += amount;
  else if (family === "sales_discounts") next.discountsIqd += amount;
  else if (family === "sales_refunds") next.refundsIqd += amount;
  else next.shippingIqd += amount;
  next.netIqd = next.grossIqd - next.discountsIqd - next.refundsIqd;
  return next;
}
