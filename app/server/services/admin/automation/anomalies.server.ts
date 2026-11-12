/**
 * Admin 19.04 — unusual transactions and cost variances, by deterministic rules that say their thresholds (no model,
 * no guessing): the module's own four checks, run when the page opens, next to what modules 10 and 09 already find —
 * finance 10.10's anomaly checks (`financeAnomalies`, finance.anomaly.read) and purchasing 09.07's variance alerts
 * (`listAlerts`, a purchasing reader; price variances with cost.read) — each summarised with a link to its page, and
 * absent (not zero) for an employee who may not read it.
 *
 *   refund.large         a refund of the last 30 days of at least REFUND_FLOOR_IQD and REFUND_FACTOR × the median refund
 *                        of the 90 days before (only the floor while there were fewer than MIN_HISTORY refunds)
 *   order.discount_high  an order of the last 30 days whose discount is at least DISCOUNT_SHARE of its lines and
 *                        DISCOUNT_FLOOR_IQD
 *   order.value_outlier  an order of the last 30 days of at least ORDER_FACTOR × the median order of the 90 days before
 *                        (not run with fewer than MIN_ORDERS orders then: "not enough history")
 *   cost.jump            [P] a cost layer received in the last 90 days whose unit cost differs by COST_JUMP_SHARE or more
 *                        from the SKU's previous layer — cost.read only (without it the check says it needs it)
 * Cancelled orders and rejected / cancelled refunds are left out; demo records count only with `demo` (the page's
 * switch), and are marked.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { financeAnomalies } from "../finance/anomalies.server";
import { ALERT_KINDS, listAlerts } from "../purchasing/alerts.server";
import { DAY_MS } from "./catalog";
import { recordHref } from "./shared.server";
import { ANOMALY_RULES, type AnomalyFilters, type OwnCheck, type OwnCheckKey, type OwnFinding } from "./types";

export { ANOMALY_RULES, type OwnCheck, type OwnCheckKey, type OwnFinding };

export type FinanceSummary = { checks: { check: string; status: string; critical: number; warning: number; info: number }[]; stored: number; href: string };
export type PurchasingSummary = { counts: Partial<Record<(typeof ALERT_KINDS)[number], number>>; total: number; withCost: boolean; href: string };

export type AnomalyHub = {
  checks: OwnCheck[];
  /** null: the employee may not read finance's checks (not "nothing found"). */
  finance: FinanceSummary | null;
  purchasing: PurchasingSummary | null;
  ranAt: number;
  demo: boolean;
};

const num = (value: unknown) => Number(value ?? 0);

/** The median of whole numbers (null for none). */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.floor((sorted[middle - 1] + sorted[middle]) / 2);
}

export async function unusualTransactions(db: Db, actor: Actor, filters: AnomalyFilters, locale: Locale, now: number, options: { others?: boolean } = {}): Promise<AnomalyHub> {
  assertCan(actor, "automation.anomaly.read");
  const R = ANOMALY_RULES;
  const windowStart = now - R.windowDays * DAY_MS;
  const historyStart = windowStart - R.historyDays * DAY_MS;
  const demo = filters.demo ? sql`1 = 1` : sql`o.is_demo = 0`;
  const checks: OwnCheck[] = [];

  // each check lists its largest R.maxFindings and counts ALL it found (the page says "the largest 50 of N")
  const totalOf = async (from: SQL) => num((await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM ${from}`))[0]?.n);

  // refunds
  const refundHistory = await db.all<{ amount: number }>(sql`
    SELECT r.amount_iqd AS amount FROM refunds AS r JOIN orders AS o ON o.id = r.order_id
    WHERE r.status NOT IN ('rejected', 'cancelled') AND r.created_at >= ${historyStart} AND r.created_at < ${windowStart} AND ${demo}`);
  const refundMedian = refundHistory.length >= R.minHistory ? median(refundHistory.map((row) => num(row.amount))) : null;
  const refundThreshold = Math.max(R.refundFloorIqd, refundMedian === null ? 0 : refundMedian * R.refundFactor);
  const refundFrom = sql`refunds AS r JOIN orders AS o ON o.id = r.order_id
    WHERE r.status NOT IN ('rejected', 'cancelled') AND r.created_at >= ${windowStart} AND r.created_at <= ${now} AND r.amount_iqd >= ${refundThreshold} AND ${demo}`;
  const [refunds, refundTotal] = await Promise.all([
    db.all<{ id: string; at: number; amount: number; status: string; ref: string; total: number; isDemo: number }>(sql`
      SELECT r.id AS id, r.created_at AS at, r.amount_iqd AS amount, r.status AS status, o.ref AS ref, o.total_iqd AS total, o.is_demo AS isDemo
      FROM ${refundFrom} ORDER BY r.amount_iqd DESC, r.created_at DESC LIMIT ${R.maxFindings}`),
    totalOf(refundFrom),
  ]);
  checks.push({
    check: "refund.large",
    status: refunds.length ? "found" : "ok",
    threshold: { thresholdIqd: refundThreshold, medianIqd: refundMedian, history: refundHistory.length },
    findings: refunds.map((row) => ({ id: row.id, at: num(row.at), label: row.ref, href: recordHref(actor, "order", { ref: row.ref }), values: { amountIqd: num(row.amount), orderTotalIqd: num(row.total), status: row.status }, demo: row.isDemo === 1 })),
    total: refundTotal,
  });

  // discounts
  const discountFrom = sql`orders AS o
    WHERE o.status <> 'cancelled' AND o.placed_at >= ${windowStart} AND o.placed_at <= ${now} AND o.discount_iqd >= ${R.discountFloorIqd}
      AND o.subtotal_iqd > 0 AND o.discount_iqd * 10000 >= o.subtotal_iqd * ${R.discountShareBps} AND ${demo}`;
  const [discounts, discountTotal] = await Promise.all([
    db.all<{ id: string; ref: string; at: number; subtotal: number; discount: number; channel: string; isDemo: number }>(sql`
      SELECT o.id AS id, o.ref AS ref, o.placed_at AS at, o.subtotal_iqd AS subtotal, o.discount_iqd AS discount, o.channel AS channel, o.is_demo AS isDemo
      FROM ${discountFrom} ORDER BY o.discount_iqd * 10000 / o.subtotal_iqd DESC, o.placed_at DESC LIMIT ${R.maxFindings}`),
    totalOf(discountFrom),
  ]);
  checks.push({
    check: "order.discount_high",
    status: discounts.length ? "found" : "ok",
    threshold: { shareBps: R.discountShareBps, floorIqd: R.discountFloorIqd },
    findings: discounts.map((row) => ({ id: row.id, at: num(row.at), label: row.ref, href: recordHref(actor, "order", { ref: row.ref }), values: { discountIqd: num(row.discount), subtotalIqd: num(row.subtotal), shareBps: Math.floor((num(row.discount) * 10000) / num(row.subtotal)), channel: row.channel }, demo: row.isDemo === 1 })),
    total: discountTotal,
  });

  // order value
  const orderHistory = await db.all<{ total: number }>(sql`SELECT o.total_iqd AS total FROM orders AS o WHERE o.status <> 'cancelled' AND o.placed_at >= ${historyStart} AND o.placed_at < ${windowStart} AND ${demo}`);
  if (orderHistory.length < R.minOrders) {
    checks.push({ check: "order.value_outlier", status: "short_history", threshold: { orders: orderHistory.length, minOrders: R.minOrders }, findings: [], total: 0 });
  } else {
    const orderMedian = median(orderHistory.map((row) => num(row.total))) ?? 0;
    const threshold = orderMedian * R.orderFactor;
    const largeFrom = sql`orders AS o WHERE o.status <> 'cancelled' AND o.placed_at >= ${windowStart} AND o.placed_at <= ${now} AND o.total_iqd >= ${threshold} AND ${demo}`;
    const [large, largeTotal] = await Promise.all([
      db.all<{ id: string; ref: string; at: number; total: number; channel: string; isDemo: number }>(sql`
        SELECT o.id AS id, o.ref AS ref, o.placed_at AS at, o.total_iqd AS total, o.channel AS channel, o.is_demo AS isDemo FROM ${largeFrom} ORDER BY o.total_iqd DESC LIMIT ${R.maxFindings}`),
      totalOf(largeFrom),
    ]);
    checks.push({
      check: "order.value_outlier",
      status: large.length ? "found" : "ok",
      threshold: { thresholdIqd: threshold, medianIqd: orderMedian, orders: orderHistory.length },
      findings: large.map((row) => ({ id: row.id, at: num(row.at), label: row.ref, href: recordHref(actor, "order", { ref: row.ref }), values: { totalIqd: num(row.total), channel: row.channel }, demo: row.isDemo === 1 })),
      total: largeTotal,
    });
  }

  // cost variances [P]
  if (!can(actor, "cost.read")) {
    checks.push({ check: "cost.jump", status: "needs_cost", threshold: { shareBps: R.costJumpBps }, findings: [], total: 0 });
  } else {
    const demoProducts = filters.demo ? sql`1 = 1` : sql`p.is_demo = 0`;
    const jumps = sql`
      WITH ranked AS (
        SELECT c.id, c.variant_id, c.received_at, c.unit_cost_iqd, c.source,
               LAG(c.unit_cost_iqd) OVER (PARTITION BY c.variant_id ORDER BY c.received_at, c.id) AS previous
        FROM cost_layers AS c WHERE c.source IN ('purchase', 'trade_in')
      )
      SELECT r.id AS id, r.variant_id AS variantId, v.sku AS sku, r.received_at AS at, r.unit_cost_iqd AS unitCost, r.previous AS previous, r.source AS source, p.is_demo AS isDemo
      FROM ranked AS r JOIN variants AS v ON v.id = r.variant_id JOIN products AS p ON p.id = v.product_id
      WHERE r.received_at >= ${now - R.costWindowDays * DAY_MS} AND r.received_at <= ${now} AND r.previous IS NOT NULL AND r.previous > 0
        AND abs(r.unit_cost_iqd - r.previous) * 10000 >= r.previous * ${R.costJumpBps} AND ${demoProducts}`;
    const [layers, jumpTotal] = await Promise.all([
      db.all<{ id: string; variantId: string; sku: string; at: number; unitCost: number; previous: number | null; source: string; isDemo: number }>(sql`${jumps} ORDER BY abs(r.unit_cost_iqd - r.previous) * 10000 / r.previous DESC LIMIT ${R.maxFindings}`),
      totalOf(sql`(${jumps})`),
    ]);
    checks.push({
      check: "cost.jump",
      status: layers.length ? "found" : "ok",
      threshold: { shareBps: R.costJumpBps },
      findings: layers.map((row) => ({ id: row.id, at: num(row.at), label: row.sku, href: recordHref(actor, "variant", { variantId: row.variantId }), values: { unitCostIqd: num(row.unitCost), previousIqd: num(row.previous), changeBps: Math.trunc(((num(row.unitCost) - num(row.previous)) * 10000) / num(row.previous)), source: row.source }, demo: row.isDemo === 1 })),
      total: jumpTotal,
    });
  }

  let finance: FinanceSummary | null = null;
  const others = options.others !== false;
  if (others && can(actor, "finance.anomaly.read")) {
    const report = await financeAnomalies(db, actor, now);
    finance = {
      checks: report.checks.map((check) => ({
        check: check.check,
        status: check.status,
        critical: check.findings.filter((finding) => finding.severity === "critical").length,
        warning: check.findings.filter((finding) => finding.severity === "warning").length,
        info: check.findings.filter((finding) => finding.severity === "info").length,
      })),
      stored: report.stored.length,
      href: "/admin/finance/anomalies",
    };
  }
  let purchasing: PurchasingSummary | null = null;
  if (others && canAny(actor, ["purchasing.po.read", "purchasing.invoice.manage", "purchasing.claim.manage"])) {
    const alerts = await listAlerts(db, actor, { kind: "all", page: 1 }, locale, now);
    const counts: PurchasingSummary["counts"] = {};
    for (const kind of ALERT_KINDS) counts[kind] = alerts.counts[kind] ?? 0;
    purchasing = { counts, total: alerts.counts.all ?? alerts.total, withCost: can(actor, "cost.read"), href: "/admin/purchasing/alerts" };
  }
  return { checks, finance, purchasing, ranAt: now, demo: filters.demo };
}

/** Findings of the module's own checks right now (for the module's home), or null without automation.anomaly.read. */
export async function countUnusual(db: Db, actor: Actor, now: number, locale: Locale = "ar"): Promise<number | null> {
  if (!can(actor, "automation.anomaly.read")) return null;
  const hub = await unusualTransactions(db, actor, { demo: false }, locale, now, { others: false });
  return hub.checks.reduce((sum, check) => sum + check.total, 0);
}
