/**
 * Admin 10.03 and 10.04 — what was earned and what was given back (finance.report.read):
 *
 *   · realisedVsPending (10.03): revenue the journal recognised in the range (orders delivered — docs/metrics.md §2)
 *     against the orders not delivered yet, split into money already received (an advance, held on customer control)
 *     and money still to come, plus delivered orders whose cash is still with the courier.
 *   · salesDeductions (10.04): cost of goods sold [cost.read], discounts with the coupons behind them, refunds by how
 *     they were paid, goods back to stock or written off [cost.read], and the gross margin [cost.read + profit.read].
 *
 * Every money figure comes from the journal or the order tables exactly as metrics.md defines it; demo rows are left
 * out unless the range asks for them.
 */
import { sql, type SQL } from "drizzle-orm";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { accountSums, chartOfAccounts, familyIds, revenueRecognised, type RevenueSection } from "~/server/services/accounting/reports.server";
import type { RangeFilter } from "./types";

const num = (value: unknown) => Number(value ?? 0);

export const OPEN_ORDER_STATUSES = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped"] as const;

export type PendingRow = { status: (typeof OPEN_ORDER_STATUSES)[number]; count: number; totalIqd: number; paidIqd: number };

export type RevenuePosition = {
  realised: RevenueSection;
  pending: { rows: PendingRow[]; count: number; totalIqd: number; paidIqd: number; unpaidIqd: number };
  /** Delivered (revenue recognised) but the cash on delivery not recorded yet. */
  deliveredUnpaid: { count: number; iqd: number };
  /** Balance of customer control [1020] over every posting in scope: positive = owed by customers (delivered, not
   *  paid), negative = advances (paid, not delivered). */
  customerControlIqd: number;
  /** The latest orders delivered in the range (their revenue is in `realised`). */
  latest: { ref: string; deliveredAt: number; totalIqd: number; isDemo: boolean }[];
};

function demo(range: RangeFilter, alias = "o"): SQL {
  return range.demo ? sql`1 = 1` : sql.raw(`${alias}.is_demo = 0`);
}

/** 10.03 — realised revenue of the range against the orders still open now. */
export async function realisedVsPending(db: Db, actor: Actor, range: RangeFilter): Promise<RevenuePosition> {
  assertCan(actor, "finance.report.read");
  const chart = await chartOfAccounts(db);
  const control = familyIds(chart, "cod_receivable");
  const [realised, pending, delivered, sums, latest] = await Promise.all([
    revenueRecognised(db, { from: range.fromMs, to: range.toMs, includeDemo: range.demo }),
    db.all<{ status: PendingRow["status"]; n: number; total: number; paid: number }>(sql`
      SELECT o.status AS status, count(*) AS n, coalesce(sum(o.total_iqd), 0) AS total, coalesce(sum(o.paid_iqd - o.refunded_iqd), 0) AS paid
      FROM orders AS o WHERE o.status IN ('new', 'awaiting_payment', 'payment_review', 'confirmed', 'preparing', 'shipped') AND ${demo(range)}
      GROUP BY o.status`),
    db.all<{ n: number; total: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(o.total_iqd - o.paid_iqd), 0) AS total FROM orders AS o
      WHERE o.status = 'delivered' AND o.paid_iqd < o.total_iqd AND ${demo(range)}`),
    accountSums(db, { includeDemo: range.demo }),
    db.all<{ ref: string; deliveredAt: number; total: number; isDemo: number }>(sql`
      SELECT o.ref, o.delivered_at AS deliveredAt, o.total_iqd AS total, o.is_demo AS isDemo FROM orders AS o
      WHERE o.delivered_at >= ${range.fromMs} AND o.delivered_at < ${range.toMs} AND ${demo(range)}
      ORDER BY o.delivered_at DESC LIMIT 10`),
  ]);
  const rows: PendingRow[] = OPEN_ORDER_STATUSES.map((status) => {
    const row = pending.find((r) => r.status === status);
    return { status, count: num(row?.n), totalIqd: num(row?.total), paidIqd: num(row?.paid) };
  });
  const totalIqd = rows.reduce((t, r) => t + r.totalIqd, 0);
  const paidIqd = rows.reduce((t, r) => t + r.paidIqd, 0);
  let controlIqd = 0;
  for (const id of control) {
    const s = sums.get(id);
    if (s) controlIqd += s.debit - s.credit;
  }
  return {
    realised,
    pending: { rows, count: rows.reduce((t, r) => t + r.count, 0), totalIqd, paidIqd, unpaidIqd: totalIqd - paidIqd },
    deliveredUnpaid: { count: num(delivered[0]?.n), iqd: num(delivered[0]?.total) },
    customerControlIqd: controlIqd,
    latest: latest.map((row) => ({ ref: row.ref, deliveredAt: num(row.deliveredAt), totalIqd: num(row.total), isDemo: Boolean(row.isDemo) })),
  };
}

export type SalesDeductions = {
  revenue: RevenueSection;
  /** cost.read */
  cost: { cogsIqd: number; uncostedUnits: number; restockedIqd: number; writtenOffIqd: number } | null;
  /** cost.read + profit.read */
  margin: { grossIqd: number; marginBps: number | null } | null;
  coupons: { code: string; count: number; iqd: number }[];
  couponsIqd: number;
  /** Discounts recognised that no coupon explains (order-level discounts of other kinds). */
  otherDiscountsIqd: number;
  refunds: { method: string; count: number; iqd: number }[];
  refundsPaidIqd: number;
  pendingRefunds: { count: number; iqd: number };
};

/** 10.04 — cost of goods, discounts and coupons, refunds and returned goods of the range. */
export async function salesDeductions(db: Db, actor: Actor, range: RangeFilter): Promise<SalesDeductions> {
  assertCan(actor, "finance.report.read");
  const withCost = can(actor, "cost.read");
  const withProfit = withCost && can(actor, "profit.read");
  const chart = await chartOfAccounts(db);
  const demoEntry = range.demo ? sql`1 = 1` : sql`e.is_demo = 0`;
  const [revenue, coupons, refunds, pendingRefunds] = await Promise.all([
    revenueRecognised(db, { from: range.fromMs, to: range.toMs, includeDemo: range.demo }),
    db.all<{ code: string; n: number; total: number }>(sql`
      SELECT c.code AS code, count(*) AS n, coalesce(sum(r.amount_iqd), 0) AS total
      FROM coupon_redemptions AS r JOIN coupons AS c ON c.id = r.coupon_id JOIN orders AS o ON o.id = r.order_id
      WHERE r.voided_at IS NULL AND o.delivered_at >= ${range.fromMs} AND o.delivered_at < ${range.toMs} AND ${demo(range)}
      GROUP BY c.code ORDER BY total DESC LIMIT 50`),
    db.all<{ method: string; n: number; total: number }>(sql`
      SELECT r.method AS method, count(*) AS n, coalesce(sum(r.amount_iqd), 0) AS total FROM refunds AS r JOIN orders AS o ON o.id = r.order_id
      WHERE r.status = 'paid' AND r.paid_at >= ${range.fromMs} AND r.paid_at < ${range.toMs} AND ${demo(range)} GROUP BY r.method ORDER BY r.method`),
    db.all<{ n: number; total: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(r.amount_iqd), 0) AS total FROM refunds AS r JOIN orders AS o ON o.id = r.order_id WHERE r.status = 'pending' AND ${demo(range)}`),
  ]);
  const couponsIqd = coupons.reduce((t, row) => t + num(row.total), 0);
  let cost: SalesDeductions["cost"] = null;
  let margin: SalesDeductions["margin"] = null;
  if (withCost) {
    const cogsIds = familyIds(chart, "cogs");
    const inventoryIds = familyIds(chart, "inventory");
    const writeOffIds = familyIds(chart, "inventory_adjustments");
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
    const [cogs, goods, uncosted] = await Promise.all([
      db.all<{ net: number }>(sql`
        SELECT coalesce(sum(l.debit_iqd - l.credit_iqd), 0) AS net FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id
        WHERE l.account_id IN (${list(cogsIds)}) AND e.at >= ${range.fromMs} AND e.at < ${range.toMs} AND ${demoEntry}`),
      db.all<{ restocked: number; written: number }>(sql`
        SELECT coalesce(sum(CASE WHEN l.account_id IN (${list(inventoryIds)}) THEN l.debit_iqd ELSE 0 END), 0) AS restocked,
               coalesce(sum(CASE WHEN l.account_id IN (${list(writeOffIds)}) THEN l.debit_iqd ELSE 0 END), 0) AS written
        FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id
        WHERE e.idempotency_key LIKE '%:goods' AND e.at >= ${range.fromMs} AND e.at < ${range.toMs} AND ${demoEntry}`),
      db.all<{ units: number }>(sql`
        SELECT coalesce(sum(-m.qty_delta), 0) AS units FROM stock_movements AS m LEFT JOIN orders AS o ON o.id = m.ref_id AND m.ref_type = 'order'
        WHERE m.kind = 'sale' AND m.unit_cost_iqd IS NULL AND m.at >= ${range.fromMs} AND m.at < ${range.toMs} AND ${range.demo ? sql`1 = 1` : sql`coalesce(o.is_demo, 0) = 0`}`),
    ]);
    cost = { cogsIqd: num(cogs[0]?.net), uncostedUnits: num(uncosted[0]?.units), restockedIqd: num(goods[0]?.restocked), writtenOffIqd: num(goods[0]?.written) };
    if (withProfit) {
      const grossIqd = revenue.netIqd - cost.cogsIqd;
      margin = { grossIqd, marginBps: revenue.netIqd === 0 ? null : Math.round((grossIqd * 10_000) / revenue.netIqd) };
    }
  }
  return {
    revenue,
    cost,
    margin,
    coupons: coupons.map((row) => ({ code: row.code, count: num(row.n), iqd: num(row.total) })),
    couponsIqd,
    otherDiscountsIqd: revenue.discountsIqd - couponsIqd,
    refunds: refunds.map((row) => ({ method: row.method, count: num(row.n), iqd: num(row.total) })),
    refundsPaidIqd: refunds.reduce((t, row) => t + num(row.total), 0),
    pendingRefunds: { count: num(pendingRefunds[0]?.n), iqd: num(pendingRefunds[0]?.total) },
  };
}
