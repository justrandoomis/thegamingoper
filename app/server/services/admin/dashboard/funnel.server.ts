/**
 * Admin 01.03 — the conversion funnel from real records, for the span and the span before (01.04):
 *
 *   web       carts started in the span (a cart exists from the first item added) → became an order (metrics §6
 *             "Cart-to-order conversion": carts.converted_order_id) → that order paid (money arrived: paid_iqd > 0) →
 *             that order delivered (delivered_at set, also when it came back later). One cohort, so every step is a
 *             part of the one before it.
 *   counter   point-of-sale sales rung up in the span: no cart; placed, paid and handed over at once.
 *
 * Not measured, and said so on the chart: visits (no analytics is configured, metrics §6 "Visitor conversion rate")
 * and the shopper's device (neither carts nor orders record it). Channel = where the order was placed (web, counter).
 * Demo: carts carry no demo marker, so without demo rows a cart that became a demo order is left out with its order.
 * A branch filter keeps the counter's sales of that branch; web carts and orders belong to no branch.
 * One round trip (`db.batch`).
 */
import { and, count, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { assertCan, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { carts, orders } from "~/server/db/schema";
import { periodSpans, type DashboardFilters, type FunnelCard, type FunnelCounts, type Span } from "./types";

const num = (value: unknown) => Number(value ?? 0);

export async function funnelCard(db: Db, actor: Actor, filters: DashboardFilters, now: number): Promise<FunnelCard> {
  assertCan(actor, "dashboard.funnel.read");
  const spans = periodSpans(filters.period, now);
  const realOnly = !filters.demo;

  const web = (span: Span) =>
    db
      .select({
        carts: count(),
        orders: sql<number>`coalesce(sum(CASE WHEN ${orders.id} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
        paid: sql<number>`coalesce(sum(CASE WHEN ${orders.paidIqd} > 0 THEN 1 ELSE 0 END), 0)`,
        delivered: sql<number>`coalesce(sum(CASE WHEN ${orders.deliveredAt} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
      })
      .from(carts)
      .leftJoin(orders, and(eq(orders.id, carts.convertedOrderId), realOnly ? eq(orders.isDemo, false) : undefined))
      .where(
        and(
          gte(carts.createdAt, span.from),
          lt(carts.createdAt, span.to),
          realOnly ? sql`NOT EXISTS (SELECT 1 FROM orders AS d WHERE d.id = ${carts.convertedOrderId} AND d.is_demo = 1)` : undefined,
        ),
      );
  const counterScope: SQL[] = [eq(orders.channel, "pos")];
  if (realOnly) counterScope.push(eq(orders.isDemo, false));
  if (filters.branch) counterScope.push(eq(orders.branchId, filters.branch));
  const counter = (span: Span) =>
    db
      .select({
        orders: count(),
        paid: sql<number>`coalesce(sum(CASE WHEN ${orders.paidIqd} > 0 THEN 1 ELSE 0 END), 0)`,
        delivered: sql<number>`coalesce(sum(CASE WHEN ${orders.deliveredAt} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
      })
      .from(orders)
      .where(and(gte(orders.placedAt, span.from), lt(orders.placedAt, span.to), ...counterScope));

  const webCounts = (row: { carts: number; orders: number; paid: number; delivered: number } | undefined): FunnelCounts => ({
    carts: num(row?.carts),
    orders: num(row?.orders),
    paid: num(row?.paid),
    delivered: num(row?.delivered),
  });
  const counterCounts = (row: { orders: number; paid: number; delivered: number } | undefined): FunnelCounts => ({ carts: null, orders: num(row?.orders), paid: num(row?.paid), delivered: num(row?.delivered) });

  if (filters.branch) {
    const [counterNow, counterBefore] = await db.batch([counter(spans.current), counter(spans.previous)]);
    return { spans, web: null, counter: { current: counterCounts(counterNow[0]), previous: counterCounts(counterBefore[0]) }, demo: filters.demo, branch: filters.branch };
  }
  const [webNow, webBefore, counterNow, counterBefore] = await db.batch([web(spans.current), web(spans.previous), counter(spans.current), counter(spans.previous)]);
  return {
    spans,
    web: { current: webCounts(webNow[0]), previous: webCounts(webBefore[0]) },
    counter: { current: counterCounts(counterNow[0]), previous: counterCounts(counterBefore[0]) },
    demo: filters.demo,
    branch: null,
  };
}
