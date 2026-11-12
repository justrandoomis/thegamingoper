/**
 * Admin 18.02 — net margin per SKU after discounts, refunds, delivery and fees (reports.margin.read).
 *
 *   const report = await marginReport(db, actor, parseMarginParams(url.searchParams, now), locale);
 *
 * It is docs/metrics.md §4 "Profit of one order" — (subtotal − discount − refunds of it) − its COGS − its commissions −
 * (its carrier cost − its delivery fee) — for every order whose sale was recognised (delivered: its "order:<id>:sale"
 * posting) in the range, as of now, split over the order's lines exactly to the dinar (pricing 03's allocateAmount):
 *   · revenue      the line's own total (unit price × qty − line discount)
 *   · discount     the order's discount, by line value
 *   · refunds      every paid refund of the order: by the items it names, otherwise by line value
 *   · COGS         [cost.read] the FIFO landed cost the units left with (the order's own 'sale' stock movements: cost
 *                  layers = purchase price + freight, customs and other landed costs allocated by pricing 03 at
 *                  receipt; the variant's standard landed cost where no layer was left), less the cost of units that
 *                  came back ('return' movements, restocked or scrapped — both credit COGS); a used device at its
 *                  acquisition cost. A unit with no cost is "uncosted": it adds nothing and is counted.
 *   · delivery     [cost.read] the shipping subsidy: what the carrier charged for the order's parcels (shipments.cost_iqd,
 *                  COD fees included once the settlement is reconciled) − the delivery fee charged, by line value. A
 *                  parcel without a recorded charge is counted as "carrier cost not recorded" (the books carry the fee
 *                  as income until then too).
 *   · commissions  [cost.read + profit.read] commissions on the line (net of clawbacks; void ones left out)
 *   · net profit   [cost.read + profit.read] net revenue − COGS − commissions − delivery; margin = profit ÷ net revenue
 * Payment-processing fees are not part of it: no gateway is configured and card-terminal fees are not recorded.
 * Fields a viewer may not see are ABSENT from the result (never 0, never null-masked) — loader data, CSV and print.
 * The books for the same dates (profitAndLoss, period-based) are returned beside it: they differ by timing (a refund,
 * a return, a commission or a carrier charge posted in another month than the delivery).
 */
import { sql, type SQL } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { profitAndLoss } from "~/server/services/accounting/reports.server";
import { costBasisFor } from "../pricing/facts.server";
import { splitAmount } from "./revenue.server";
import { assertReport, l10nText, num } from "./shared.server";
import { bpsOfShare, latinDigits, MAX_LINE_ORDERS, PAGE_SIZE, type MarginParams, type MarginSort, type RangeFilter } from "./types";

export type MarginRow = {
  key: string;
  variantId: string | null;
  used: boolean;
  sku: string;
  name: string;
  orders: number;
  /** Units sold less the units that came back. */
  units: number;
  revenueIqd: number;
  discountsIqd: number;
  refundsIqd: number;
  netRevenueIqd: number;
  /** cost.read */
  cogsIqd?: number;
  uncostedUnits?: number;
  shippingSubsidyIqd?: number;
  carrierUnknownOrders?: number;
  /** cost.read — pricing 03's landed cost per unit today (cost layers aside), for the page's rows only. */
  landedCostIqd?: number | null;
  /** cost.read + profit.read */
  commissionsIqd?: number;
  netProfitIqd?: number;
  netMarginBps?: number | null;
};

/**
 * Totals of a set of rows. `orders` counts each delivered order once (an order spans SKUs); with cost.read
 * `carrierUnknownOrders` counts the orders without a recorded carrier charge and `incompleteOrders` those whose profit
 * is incomplete (an uncosted unit or an unrecorded carrier charge) — two different figures (review 2026-11-12).
 */
export type MarginTotals = Omit<MarginRow, "key" | "variantId" | "used" | "sku" | "name" | "landedCostIqd"> & { incompleteOrders?: number };

/** Which orders each row is made of, and which orders are incomplete — server-side only (never sent to a page). */
export type MarginOrderSets = { ordersOf: ReadonlyMap<string, ReadonlySet<string>>; carrierUnknown: ReadonlySet<string>; incomplete: ReadonlySet<string> };

export type MarginReport = {
  range: Pick<RangeFilter, "from" | "to" | "period" | "demo">;
  access: { cost: boolean; profit: boolean };
  tooMany: { orders: number } | null;
  /** Orders whose sale was recognised in the range. */
  orders: number;
  totals: MarginTotals;
  /** The books for the same dates (period figures: accounting/reports.server.ts profitAndLoss, its field rules). */
  books: { netRevenueIqd: number; cogsIqd?: number; netProfitIqd?: number };
  rows: MarginRow[];
  sort: MarginSort;
  dir: "asc" | "desc";
  q: string;
  page: number;
  pageCount: number;
  total: number;
};

type Scope = { from: number; to: number; includeDemo: boolean };

function soldCte(scope: Scope): SQL {
  const demo = scope.includeDemo ? 1 : 0;
  return sql`sold AS (
    SELECT e.ref_id AS order_id FROM journal_entries AS e
    WHERE e.ref_type = 'order' AND e.idempotency_key LIKE 'order:%:sale' AND e.at >= ${scope.from} AND e.at < ${scope.to} AND (e.is_demo = 0 OR ${demo} = 1)
    GROUP BY e.ref_id)`;
}

type Line = { id: string; orderId: string; variantId: string | null; usedUnitId: string | null; sku: string; name: unknown; productName: unknown; qty: number; totalIqd: number };
type Acc = {
  orders: Set<string>;
  units: number;
  revenue: number;
  discounts: number;
  refunds: number;
  cogs: number;
  uncosted: number;
  subsidy: number;
  carrierUnknown: Set<string>;
  commissions: number;
};

const NO_SETS: MarginOrderSets = { ordersOf: new Map(), carrierUnknown: new Set(), incomplete: new Set() };

/** All rows of the report (every SKU), with the access the viewer has — the page pages them, the export takes them all. */
export async function marginRows(
  db: Db,
  actor: Actor,
  range: RangeFilter,
  locale: Locale,
): Promise<{ tooMany: { orders: number } | null; orders: number; rows: MarginRow[]; totals: MarginTotals; access: { cost: boolean; profit: boolean }; sets: MarginOrderSets }> {
  assertReport(actor, "margin");
  const cost = can(actor, "cost.read");
  const profit = cost && can(actor, "profit.read");
  const access = { cost, profit };
  const scope: Scope = { from: range.fromMs, to: range.toMs, includeDemo: range.demo };
  const sold = soldCte(scope);
  const counted = await db.all<{ n: number }>(sql`WITH ${sold} SELECT count(*) AS n FROM sold`);
  const orders = num(counted[0]?.n);
  if (orders > MAX_LINE_ORDERS) return { tooMany: { orders }, orders, rows: [], totals: emptyTotals(access), access, sets: NO_SETS };

  const none = Promise.resolve([] as never[]);
  const [orderRows, lineRows, refunds, refundItems, returned, sales, usedCosts, parcels, commissions] = await Promise.all([
    db.all<{ id: string; channel: string; discount: number; shipping: number }>(sql`
      WITH ${sold} SELECT o.id AS id, o.channel AS channel, o.discount_iqd AS discount, o.shipping_iqd AS shipping FROM sold JOIN orders AS o ON o.id = sold.order_id`),
    db.all<Line>(sql`
      WITH ${sold}
      SELECT oi.id AS id, oi.order_id AS orderId, coalesce(oi.variant_id, uu.variant_id) AS variantId, oi.used_unit_id AS usedUnitId,
             coalesce(v.sku, oi.sku, '') AS sku, oi.name_snapshot AS name, p.name AS productName, oi.qty AS qty, oi.total_iqd AS totalIqd
      FROM sold JOIN order_items AS oi ON oi.order_id = sold.order_id
      LEFT JOIN used_units AS uu ON uu.id = oi.used_unit_id
      LEFT JOIN variants AS v ON v.id = coalesce(oi.variant_id, uu.variant_id)
      LEFT JOIN products AS p ON p.id = v.product_id
      ORDER BY oi.order_id, oi.id`),
    db.all<{ id: string; orderId: string; amount: number }>(sql`
      WITH ${sold} SELECT r.id AS id, r.order_id AS orderId, r.amount_iqd AS amount FROM refunds AS r JOIN sold ON sold.order_id = r.order_id WHERE r.status = 'paid'`),
    db.all<{ refundId: string; orderItemId: string; qty: number }>(sql`
      WITH ${sold} SELECT ri.refund_id AS refundId, ri.order_item_id AS orderItemId, ri.qty AS qty
      FROM refund_items AS ri JOIN refunds AS r ON r.id = ri.refund_id JOIN sold ON sold.order_id = r.order_id WHERE r.status = 'paid'`),
    // units that came back, with the cost they came back at [P] (selected only for cost.read)
    cost
      ? db.all<{ orderId: string; variantId: string; qty: number; costIqd: number; uncosted: number }>(sql`
          WITH ${sold} SELECT m.ref_id AS orderId, m.variant_id AS variantId, coalesce(sum(m.qty_delta), 0) AS qty,
                 coalesce(sum(CASE WHEN m.unit_cost_iqd IS NOT NULL THEN m.qty_delta * m.unit_cost_iqd END), 0) AS costIqd,
                 coalesce(sum(CASE WHEN m.unit_cost_iqd IS NULL THEN m.qty_delta END), 0) AS uncosted
          FROM stock_movements AS m JOIN sold ON sold.order_id = m.ref_id WHERE m.ref_type = 'order' AND m.kind = 'return' GROUP BY m.ref_id, m.variant_id`)
      : db.all<{ orderId: string; variantId: string; qty: number; costIqd: number; uncosted: number }>(sql`
          WITH ${sold} SELECT m.ref_id AS orderId, m.variant_id AS variantId, coalesce(sum(m.qty_delta), 0) AS qty, 0 AS costIqd, 0 AS uncosted
          FROM stock_movements AS m JOIN sold ON sold.order_id = m.ref_id WHERE m.ref_type = 'order' AND m.kind = 'return' GROUP BY m.ref_id, m.variant_id`),
    cost
      ? db.all<{ orderId: string; variantId: string; qty: number; costIqd: number; uncosted: number }>(sql`
          WITH ${sold} SELECT m.ref_id AS orderId, m.variant_id AS variantId, coalesce(sum(-m.qty_delta), 0) AS qty,
                 coalesce(sum(CASE WHEN m.unit_cost_iqd IS NOT NULL THEN -m.qty_delta * m.unit_cost_iqd END), 0) AS costIqd,
                 coalesce(sum(CASE WHEN m.unit_cost_iqd IS NULL THEN -m.qty_delta END), 0) AS uncosted
          FROM stock_movements AS m JOIN sold ON sold.order_id = m.ref_id WHERE m.ref_type = 'order' AND m.kind = 'sale' GROUP BY m.ref_id, m.variant_id`)
      : none,
    cost
      ? db.all<{ lineId: string; costIqd: number | null }>(sql`
          WITH ${sold} SELECT oi.id AS lineId, uu.acquisition_cost_iqd AS costIqd FROM sold JOIN order_items AS oi ON oi.order_id = sold.order_id JOIN used_units AS uu ON uu.id = oi.used_unit_id`)
      : none,
    cost
      ? db.all<{ orderId: string; parcels: number; unknown: number; costIqd: number }>(sql`
          WITH ${sold} SELECT s.order_id AS orderId, count(*) AS parcels, coalesce(sum(CASE WHEN s.cost_iqd IS NULL THEN 1 ELSE 0 END), 0) AS unknown, coalesce(sum(s.cost_iqd), 0) AS costIqd
          FROM shipments AS s JOIN sold ON sold.order_id = s.order_id WHERE s.status <> 'cancelled' GROUP BY s.order_id`)
      : none,
    profit
      ? db.all<{ orderId: string; orderItemId: string | null; amount: number }>(sql`
          WITH ${sold} SELECT c.order_id AS orderId, c.order_item_id AS orderItemId, coalesce(sum(c.amount_iqd), 0) AS amount
          FROM commissions AS c JOIN sold ON sold.order_id = c.order_id WHERE c.status <> 'void' GROUP BY c.order_id, c.order_item_id`)
      : none,
  ]);

  const linesOf = groupBy(
    lineRows.map((line) => ({ ...line, qty: num(line.qty), totalIqd: num(line.totalIqd) })),
    (line) => line.orderId,
  );
  const refundsOf = groupBy(refunds, (refund) => refund.orderId);
  const itemsOf = groupBy(refundItems, (item) => item.refundId);
  const returnedOf = groupBy(returned, (row) => row.orderId);
  const salesOf = groupBy(sales, (row) => row.orderId);
  const usedCost = new Map(usedCosts.map((row) => [row.lineId, row.costIqd === null ? null : num(row.costIqd)]));
  const parcelsOf = new Map(parcels.map((row) => [row.orderId, { parcels: num(row.parcels), unknown: num(row.unknown), costIqd: num(row.costIqd) }]));
  const commissionsOf = groupBy(commissions, (row) => row.orderId);

  const groups = new Map<string, { variantId: string | null; used: boolean; sku: string; name: string; acc: Acc }>();
  const incomplete = new Set<string>();
  const carrierUnknownOrders = new Set<string>();

  for (const order of orderRows) {
    const lines = linesOf.get(order.id) ?? [];
    if (lines.length === 0) continue;
    const byValue = lines.map((line) => ({ id: line.id, weight: line.totalIqd }));
    const byQty = lines.map((line) => ({ id: line.id, weight: line.qty }));
    const share = (amount: number, weights = byValue) => splitAmount(amount, weights, byValue.some((entry) => entry.weight > 0) ? byValue : byQty);

    const discount = share(num(order.discount));
    const refund = new Map<string, number>(lines.map((line) => [line.id, 0]));
    for (const r of refundsOf.get(order.id) ?? []) {
      const items = (itemsOf.get(r.id) ?? []).filter((item) => lines.some((line) => line.id === item.orderItemId));
      const weights = items.length
        ? lines.map((line) => {
            const qty = items.filter((item) => item.orderItemId === line.id).reduce((sum, item) => sum + num(item.qty), 0);
            return { id: line.id, weight: line.qty > 0 ? (qty * line.totalIqd) / line.qty : 0 };
          })
        : byValue;
      for (const [id, amount] of share(num(r.amount), weights)) refund.set(id, (refund.get(id) ?? 0) + amount);
    }

    // units back per variant (and their cost), units sold per variant (and their cost) — new stock lines only
    const stockLines = lines.filter((line) => !line.usedUnitId);
    const units = new Map<string, number>(lines.map((line) => [line.id, line.qty]));
    const cogs = new Map<string, number>(lines.map((line) => [line.id, 0]));
    const uncosted = new Map<string, number>(lines.map((line) => [line.id, 0]));
    const linesFor = (variantId: string) => stockLines.filter((line) => line.variantId === variantId);
    const ownMovements = new Set<string>([...(salesOf.get(order.id) ?? []), ...(returnedOf.get(order.id) ?? [])].map((row) => row.variantId));
    // a component of a bundle (or a variant no line names): its cost goes to the lines that moved no stock of their own
    const orphanTargets = () => {
      const without = stockLines.filter((line) => !line.variantId || !ownMovements.has(line.variantId));
      const targets = without.length ? without : lines;
      return targets.map((line) => ({ id: line.id, weight: line.totalIqd }));
    };
    // a variant's amount goes to the lines of that variant by quantity, a component's to the lines without stock of their own
    const spread = (variantId: string, amount: number, into: Map<string, number>) => {
      if (amount === 0) return;
      const own = linesFor(variantId);
      const weights = own.length ? own.map((line) => ({ id: line.id, weight: line.qty })) : orphanTargets();
      for (const [id, part] of splitAmount(amount, weights)) into.set(id, (into.get(id) ?? 0) + part);
    };
    for (const row of returnedOf.get(order.id) ?? []) {
      const own = linesFor(row.variantId);
      if (own.length) {
        for (const [id, qty] of splitAmount(Math.max(0, num(row.qty)), own.map((line) => ({ id: line.id, weight: line.qty })))) units.set(id, Math.max(0, (units.get(id) ?? 0) - qty));
      }
      if (cost) {
        spread(row.variantId, -num(row.costIqd), cogs);
        spread(row.variantId, -num(row.uncosted), uncosted);
      }
    }
    if (cost) {
      for (const row of salesOf.get(order.id) ?? []) {
        spread(row.variantId, num(row.costIqd), cogs);
        spread(row.variantId, num(row.uncosted), uncosted);
      }
      for (const line of lines) {
        if (!line.usedUnitId) continue;
        const known = usedCost.get(line.id);
        if (known === null || known === undefined) uncosted.set(line.id, (uncosted.get(line.id) ?? 0) + line.qty);
        else cogs.set(line.id, (cogs.get(line.id) ?? 0) + known);
      }
    }

    // delivery: carrier charge − delivery fee (a counter sale has neither)
    let subsidy = new Map<string, number>();
    let carrierUnknown = false;
    if (cost) {
      const p = parcelsOf.get(order.id);
      carrierUnknown = order.channel !== "pos" && (!p || p.parcels === 0 || p.unknown > 0);
      subsidy = share((p?.costIqd ?? 0) - num(order.shipping));
    }
    const commission = new Map<string, number>(lines.map((line) => [line.id, 0]));
    if (profit) {
      for (const row of commissionsOf.get(order.id) ?? []) {
        if (row.orderItemId && commission.has(row.orderItemId)) commission.set(row.orderItemId, (commission.get(row.orderItemId) ?? 0) + num(row.amount));
        else for (const [id, amount] of share(num(row.amount))) commission.set(id, (commission.get(id) ?? 0) + amount);
      }
    }

    let orderIncomplete = carrierUnknown;
    for (const line of lines) {
      const used = Boolean(line.usedUnitId);
      const key = `${line.variantId ?? line.sku}|${used ? "used" : "new"}`;
      const group = groups.get(key) ?? {
        variantId: line.variantId,
        used,
        sku: line.sku,
        name: l10nText(line.productName, locale) || l10nText(line.name, locale) || line.sku,
        acc: { orders: new Set<string>(), units: 0, revenue: 0, discounts: 0, refunds: 0, cogs: 0, uncosted: 0, subsidy: 0, carrierUnknown: new Set<string>(), commissions: 0 },
      };
      const acc = group.acc;
      acc.orders.add(order.id);
      acc.units += units.get(line.id) ?? 0;
      acc.revenue += line.totalIqd;
      acc.discounts += discount.get(line.id) ?? 0;
      acc.refunds += refund.get(line.id) ?? 0;
      acc.cogs += cogs.get(line.id) ?? 0;
      acc.uncosted += uncosted.get(line.id) ?? 0;
      acc.subsidy += subsidy.get(line.id) ?? 0;
      acc.commissions += commission.get(line.id) ?? 0;
      if (carrierUnknown) acc.carrierUnknown.add(order.id);
      if ((uncosted.get(line.id) ?? 0) > 0) orderIncomplete = true;
      groups.set(key, group);
    }
    if (cost && orderIncomplete) incomplete.add(order.id);
    if (cost && carrierUnknown) carrierUnknownOrders.add(order.id);
  }

  const rows: MarginRow[] = [...groups.entries()].map(([key, group]) => rowOf(key, group, access));
  const sets: MarginOrderSets = { ordersOf: new Map([...groups.entries()].map(([key, group]) => [key, group.acc.orders])), carrierUnknown: carrierUnknownOrders, incomplete };
  const totals = marginTotals(rows, sets, access);
  return { tooMany: null, orders, rows, totals, access, sets };
}

/**
 * The totals of these rows: amounts summed, each delivered order counted once, the orders without a carrier charge
 * and the incomplete ones among them (cost.read) — so a total row under a searched list adds up to that list.
 */
export function marginTotals(rows: readonly MarginRow[], sets: MarginOrderSets, access: { cost: boolean; profit: boolean }): MarginTotals {
  const totals = totalsOf(rows, access);
  const orders = new Set<string>();
  for (const row of rows) for (const id of sets.ordersOf.get(row.key) ?? []) orders.add(id);
  totals.orders = orders.size;
  if (access.cost) {
    totals.carrierUnknownOrders = [...orders].filter((id) => sets.carrierUnknown.has(id)).length;
    totals.incompleteOrders = [...orders].filter((id) => sets.incomplete.has(id)).length;
  }
  return totals;
}

function rowOf(key: string, group: { variantId: string | null; used: boolean; sku: string; name: string; acc: Acc }, access: { cost: boolean; profit: boolean }): MarginRow {
  const a = group.acc;
  const netRevenueIqd = a.revenue - a.discounts - a.refunds;
  const row: MarginRow = { key, variantId: group.variantId, used: group.used, sku: group.sku, name: group.name, orders: a.orders.size, units: a.units, revenueIqd: a.revenue, discountsIqd: a.discounts, refundsIqd: a.refunds, netRevenueIqd };
  if (access.cost) {
    row.cogsIqd = a.cogs;
    row.uncostedUnits = a.uncosted;
    row.shippingSubsidyIqd = a.subsidy;
    row.carrierUnknownOrders = a.carrierUnknown.size;
  }
  if (access.profit) {
    row.commissionsIqd = a.commissions;
    row.netProfitIqd = netRevenueIqd - a.cogs - a.commissions - a.subsidy;
    row.netMarginBps = bpsOfShare(row.netProfitIqd, netRevenueIqd);
  }
  return row;
}

function emptyTotals(access: { cost: boolean; profit: boolean }): MarginTotals {
  return totalsOf([], access);
}

function totalsOf(rows: readonly MarginRow[], access: { cost: boolean; profit: boolean }): MarginTotals {
  const sum = (pick: (row: MarginRow) => number | undefined) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const totals: MarginTotals = {
    orders: 0,
    units: sum((row) => row.units),
    revenueIqd: sum((row) => row.revenueIqd),
    discountsIqd: sum((row) => row.discountsIqd),
    refundsIqd: sum((row) => row.refundsIqd),
    netRevenueIqd: sum((row) => row.netRevenueIqd),
  };
  if (access.cost) {
    totals.cogsIqd = sum((row) => row.cogsIqd);
    totals.uncostedUnits = sum((row) => row.uncostedUnits);
    totals.shippingSubsidyIqd = sum((row) => row.shippingSubsidyIqd);
  }
  if (access.profit) {
    totals.commissionsIqd = sum((row) => row.commissionsIqd);
    totals.netProfitIqd = sum((row) => row.netProfitIqd);
    totals.netMarginBps = bpsOfShare(totals.netProfitIqd, totals.netRevenueIqd);
  }
  return totals;
}

const SORT_VALUE: Record<MarginSort, (row: MarginRow) => number> = {
  profit: (row) => row.netProfitIqd ?? 0,
  margin: (row) => row.netMarginBps ?? Number.NEGATIVE_INFINITY,
  revenue: (row) => row.netRevenueIqd,
  units: (row) => row.units,
};

/** Rows matching `q` (a SKU or a name, Arabic-Indic digits as 0–9) in the requested order. */
export function sortMarginRows(rows: readonly MarginRow[], options: { sort: MarginSort; dir: "asc" | "desc"; q: string }): MarginRow[] {
  const q = latinDigits(options.q).trim().toLowerCase();
  const matching = q ? rows.filter((row) => row.sku.toLowerCase().includes(q) || row.name.toLowerCase().includes(q)) : [...rows];
  const value = SORT_VALUE[options.sort];
  const sign = options.dir === "asc" ? 1 : -1;
  return matching.sort((a, b) => sign * (value(a) - value(b)) || b.netRevenueIqd - a.netRevenueIqd || a.sku.localeCompare(b.sku));
}

/** A sort the viewer may use: profit and margin only with cost.read + profit.read. */
export function marginSortFor(requested: MarginSort | null, access: { profit: boolean }): MarginSort {
  if (requested && (access.profit || (requested !== "profit" && requested !== "margin"))) return requested;
  return access.profit ? "profit" : "revenue";
}

/** 18.02 — one page of SKUs with the range's totals and the books for the same dates. */
export async function marginReport(db: Db, actor: Actor, params: MarginParams, locale: Locale): Promise<MarginReport> {
  assertReport(actor, "margin");
  const scope = { from: params.range.fromMs, to: params.range.toMs, includeDemo: params.range.demo };
  const [result, pl] = await Promise.all([marginRows(db, actor, params.range, locale), profitAndLoss(db, actor, scope)]);
  const sort = marginSortFor(params.sort, result.access);
  const sorted = sortMarginRows(result.rows, { sort, dir: params.dir, q: params.q });
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(params.page, pageCount);
  const rows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (result.access.cost) {
    const ids = [...new Set(rows.map((row) => row.variantId).filter((id): id is string => Boolean(id)))];
    const basis = ids.length ? await costBasisFor(db, ids) : new Map();
    for (const row of rows) row.landedCostIqd = row.used || !row.variantId ? null : (basis.get(row.variantId)?.landedIqd ?? null);
  }
  const totals = { ...result.totals, orders: result.orders };
  const books: MarginReport["books"] = { netRevenueIqd: pl.revenue.netIqd };
  if (pl.cost) books.cogsIqd = pl.cost.cogsIqd;
  if (pl.profit) books.netProfitIqd = pl.profit.netIqd;
  return {
    range: { from: params.range.from, to: params.range.to, period: params.range.period, demo: params.range.demo },
    access: result.access,
    tooMany: result.tooMany,
    orders: result.orders,
    totals,
    books,
    rows,
    sort,
    dir: params.dir,
    q: params.q,
    page,
    pageCount,
    total: sorted.length,
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
