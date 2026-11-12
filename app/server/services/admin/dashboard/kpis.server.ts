/**
 * Admin 01.01 — the KPI cards, each against the same span of the period before (01.04), exactly as docs/metrics.md
 * defines them:
 *
 *   paid sales      §3 "Paid sales": Σ payments paid in the span − Σ refunds paid in the span (money that arrived;
 *                   a transfer waiting for verification never counts)
 *   orders placed   §3 "Orders placed": orders with placed_at in the span, any status
 *   open orders     §3 "Open orders": orders now in new … shipped; for the span before, the orders that were in one of
 *                   those statuses at the same moment then — read from each order's own history (its `placed` event
 *                   and its `status_changed` events), never guessed
 *   average basket  §3 "AOV": Σ (subtotal − discount) ÷ orders placed in the span and not cancelled; delivery fees
 *                   excluded; null (not shown) when there is none
 *   net profit      §4 "Net profit", through the finance module's profitAndLoss (accounting/reports.server.ts) — the
 *                   one implementation, which also applies the field rules (cost.read AND profit.read)
 *
 * Demo rows are left out unless the page asks for them (metrics §1). A branch filter keeps the orders of that branch
 * (point-of-sale sales; web orders belong to no branch); the journal is kept for the whole store, so net profit is not
 * available per branch. Each card is ONE round trip (`db.batch`) — or two calls side by side for the profit.
 */
import { and, count, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { assertCan, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { orders, payments, refunds } from "~/server/db/schema";
import { profitAndLoss, type ProfitAndLoss } from "~/server/services/accounting/reports.server";
import { OPEN_STATUSES } from "~/server/services/admin/orders/types";
import { periodSpans, type DashboardFilters, type NetResult, type ResultCard, type SalesCard, type Span } from "./types";

const num = (value: unknown) => Number(value ?? 0);

/** What the figures cover: demo rows only when asked for, one branch when one is chosen. */
function orderScope(filters: Pick<DashboardFilters, "demo" | "branch">): SQL[] {
  const parts: SQL[] = [];
  if (!filters.demo) parts.push(eq(orders.isDemo, false));
  if (filters.branch) parts.push(eq(orders.branchId, filters.branch));
  return parts;
}

const OPEN_LIST = sql.join(
  OPEN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * The status an order had just before `at`: its last status change before then, else the status it was placed with,
 * else — an order with no recorded history at all (imported) — its status now.
 */
function statusAt(at: number): SQL {
  return sql`coalesce(
    (SELECT json_extract(e.data, '$.to') FROM order_events AS e WHERE e.order_id = ${orders.id} AND e.kind = 'status_changed' AND e.at < ${at} ORDER BY e.at DESC, e.id DESC LIMIT 1),
    (SELECT json_extract(e.data, '$.status') FROM order_events AS e WHERE e.order_id = ${orders.id} AND e.kind = 'placed' ORDER BY e.at, e.id LIMIT 1),
    CASE WHEN NOT EXISTS (SELECT 1 FROM order_events AS e WHERE e.order_id = ${orders.id}) THEN ${orders.status} END
  )`;
}

/** 01.01 — paid sales, orders placed, open orders and the average basket, now and in the span before. */
export async function salesCard(db: Db, actor: Actor, filters: DashboardFilters, now: number): Promise<SalesCard> {
  assertCan(actor, "dashboard.sales.read");
  const spans = periodSpans(filters.period, now);
  const scope = orderScope(filters);

  const paidIn = (span: Span) =>
    db
      .select({ iqd: sql<number>`coalesce(sum(${payments.amountIqd}), 0)` })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(and(eq(payments.status, "paid"), gte(payments.paidAt, span.from), lt(payments.paidAt, span.to), ...scope));
  const refundedIn = (span: Span) =>
    db
      .select({ iqd: sql<number>`coalesce(sum(${refunds.amountIqd}), 0)` })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(and(eq(refunds.status, "paid"), gte(refunds.paidAt, span.from), lt(refunds.paidAt, span.to), ...scope));
  const placedIn = (span: Span) =>
    db
      .select({
        placed: count(),
        kept: sql<number>`coalesce(sum(CASE WHEN ${orders.status} <> 'cancelled' THEN 1 ELSE 0 END), 0)`,
        basket: sql<number>`coalesce(sum(CASE WHEN ${orders.status} <> 'cancelled' THEN ${orders.subtotalIqd} - ${orders.discountIqd} ELSE 0 END), 0)`,
      })
      .from(orders)
      .where(and(gte(orders.placedAt, span.from), lt(orders.placedAt, span.to), ...scope));
  const openNow = db
    .select({ n: count() })
    .from(orders)
    .where(and(inArray(orders.status, [...OPEN_STATUSES]), ...scope));
  const openThen = db
    .select({ n: count() })
    .from(orders)
    .where(and(lt(orders.placedAt, spans.previous.to), ...scope, sql`${statusAt(spans.previous.to)} IN (${OPEN_LIST})`));

  const [paidNow, paidBefore, refundedNow, refundedBefore, placedNow, placedBefore, open, openBefore] = await db.batch([
    paidIn(spans.current),
    paidIn(spans.previous),
    refundedIn(spans.current),
    refundedIn(spans.previous),
    placedIn(spans.current),
    placedIn(spans.previous),
    openNow,
    openThen,
  ]);
  const basket = (row: { kept: number; basket: number } | undefined) => (row && num(row.kept) > 0 ? Math.round(num(row.basket) / num(row.kept)) : null);
  return {
    spans,
    paidSales: { current: num(paidNow[0]?.iqd) - num(refundedNow[0]?.iqd), previous: num(paidBefore[0]?.iqd) - num(refundedBefore[0]?.iqd) },
    ordersPlaced: { current: num(placedNow[0]?.placed), previous: num(placedBefore[0]?.placed) },
    openOrders: { current: num(open[0]?.n), previous: num(openBefore[0]?.n) },
    averageBasket: { current: basket(placedNow[0]), previous: basket(placedBefore[0]) },
    demo: filters.demo,
    branch: filters.branch,
  };
}

function netResult(pnl: ProfitAndLoss): NetResult | null {
  if (!pnl.profit || !pnl.cost) return null;
  return {
    netIqd: pnl.profit.netIqd,
    netMarginBps: pnl.profit.netMarginBps,
    netRevenueIqd: pnl.revenue.netIqd,
    uncostedUnits: pnl.cost.uncostedUnits,
    ordersRecognised: pnl.revenue.ordersRecognised,
  };
}

/**
 * 01.01 — net profit of the span and of the span before (metrics §4), recognised at delivery. Needs
 * dashboard.sales.read, cost.read and profit.read: it is absent for everyone else, never a 0.
 */
export async function resultCard(db: Db, actor: Actor, filters: DashboardFilters, now: number): Promise<ResultCard> {
  assertCan(actor, "dashboard.sales.read");
  assertCan(actor, "cost.read");
  assertCan(actor, "profit.read");
  const spans = periodSpans(filters.period, now);
  if (filters.branch) return { spans, current: null, previous: null, perBranch: true, demo: filters.demo };
  const [current, previous] = await Promise.all([
    profitAndLoss(db, actor, { from: spans.current.from, to: spans.current.to, includeDemo: filters.demo }),
    profitAndLoss(db, actor, { from: spans.previous.from, to: spans.previous.to, includeDemo: filters.demo }),
  ]);
  return { spans, current: netResult(current), previous: netResult(previous), perBranch: false, demo: filters.demo };
}
