/**
 * 21.02 Orders by channel and 21.06 profitability per channel — read only, from the same tables and the same
 * definitions as every other screen (docs/metrics.md):
 *
 *   ordersByChannel(db, actor, range, locale)        orders.order.read — placed, open, delivered, cancelled, returned,
 *                                                    GMV and the average basket per channel (metrics §3), with the list
 *                                                    that shows them (module 05's order list; the POS's sales list)
 *   channelProfitability(db, actor, range, locale)   channels.report.read — the journal's revenue, discounts, refunds and
 *                                                    shipping income per channel; COGS and carrier costs with cost.read;
 *                                                    gross profit, the channel's contribution and margins with cost.read
 *                                                    AND profit.read (as the finance core decides: profit minus revenue
 *                                                    would reveal cost). An absent figure is null, never 0.
 *
 * How a posting finds its channel: its entry's reference — an order (sale, cost of goods, goods back), a refund, a
 * return, a return line or a payment (→ its order's channel; POS orders also by the register's branch), a carriers'
 * cash-on-delivery settlement (→ the channel of its parcels' orders when they share one), a till's shift (→ POS).
 * Everything else on the same accounts (manual entries, expenses, payroll) is "not attributed" — shown, never spread
 * over the channels — and commissions are booked store-wide with payroll runs. The channels, the unattributed part
 * and the commissions add up to the finance core's profit and loss for the same range (profitAndLoss), which the
 * page shows next to them. Demo postings are left out unless the range asks for them (metrics §1).
 *
 * Both cover the whole store (every channel, every branch, the store's net profit): an employee limited to a branch is
 * refused (forbidden "branch", as the reports of module 18 do).
 *
 * Must not import "cloudflare:workers".
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import type { SystemAccountKey } from "~/server/db/schema";
import { chartOfAccounts, profitAndLoss, systemRoots } from "~/server/services/accounting/reports.server";
import { OPEN_STATUSES, listSearch } from "~/server/services/admin/orders/types";
import { branchNames } from "./branches.server";
import { channelNames } from "./channels.server";
import { assertWholeStore } from "./shared.server";
import type { ChannelOrderSummary, ChannelProfitRow, ChannelProfitability, RangeFilter } from "./types";

const SALES_LIST_READERS = ["pos.shift.review", "pos.receipt.reprint", "pos.sale.create"] as const;

type Scope = Pick<RangeFilter, "fromMs" | "toMs" | "demo" | "from" | "to">;

const num = (value: unknown) => Number(value ?? 0);

// ───────────────────────────────────────────────────────────────── 21.02 orders by channel

export async function ordersByChannel(db: Db, actor: Actor, range: Scope, locale: Locale): Promise<ChannelOrderSummary[]> {
  assertCan(actor, "orders.order.read");
  assertWholeStore(actor);
  const open = sql.join(
    OPEN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const [names, rows] = await Promise.all([
    channelNames(db, locale),
    db.all<{ channel: string; placed: number; open: number; delivered: number; cancelled: number; returned: number; gmv: number; basket: number; kept: number; last: number | null }>(sql`
      SELECT channel,
             count(*) AS placed,
             coalesce(sum(CASE WHEN status IN (${open}) THEN 1 ELSE 0 END), 0) AS open,
             coalesce(sum(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
             coalesce(sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
             coalesce(sum(CASE WHEN status = 'returned' THEN 1 ELSE 0 END), 0) AS returned,
             coalesce(sum(CASE WHEN status <> 'cancelled' THEN total_iqd ELSE 0 END), 0) AS gmv,
             coalesce(sum(CASE WHEN status <> 'cancelled' THEN subtotal_iqd - discount_iqd ELSE 0 END), 0) AS basket,
             coalesce(sum(CASE WHEN status <> 'cancelled' THEN 1 ELSE 0 END), 0) AS kept,
             max(placed_at) AS last
      FROM orders
      WHERE placed_at >= ${range.fromMs} AND placed_at < ${range.toMs} ${range.demo ? sql`` : sql`AND is_demo = 0`}
      GROUP BY channel`),
  ]);
  const byKey = new Map(rows.map((row) => [row.channel, row]));
  const keys = [...names.keys()];
  for (const row of rows) if (!names.has(row.channel)) keys.push(row.channel);
  // module 05's list for the same Baghdad days the figures count (it lists every channel together; demo orders tagged)
  const ordersList = `/admin/orders${listSearch({ from: range.from, to: range.to })}`;
  return keys.map((key) => {
    const row = byKey.get(key);
    const info = names.get(key) ?? { name: key, connected: key === "web" || key === "pos" };
    const kept = num(row?.kept);
    const list = key === "pos" && canAny(actor, SALES_LIST_READERS) ? "/admin/pos/sales" : info.connected ? ordersList : null;
    return {
      key,
      name: info.name,
      connected: info.connected,
      placed: num(row?.placed),
      open: num(row?.open),
      delivered: num(row?.delivered),
      cancelled: num(row?.cancelled),
      returned: num(row?.returned),
      gmvIqd: num(row?.gmv),
      averageBasketIqd: kept > 0 ? Math.round(num(row?.basket) / kept) : null,
      lastPlacedAt: row?.last == null ? null : num(row.last),
      list,
    };
  });
}

// ───────────────────────────────────────────────────────────────── 21.06 profitability per channel

type Family = "sales_revenue" | "shipping_income" | "sales_discounts" | "sales_refunds" | "cogs" | "shipping_costs" | "commissions";
const FAMILIES: readonly Family[] = ["sales_revenue", "shipping_income", "sales_discounts", "sales_refunds", "cogs", "shipping_costs", "commissions"];

type Sums = Record<Family, { debit: number; credit: number }>;
const emptySums = (): Sums => Object.fromEntries(FAMILIES.map((family) => [family, { debit: 0, credit: 0 }])) as Sums;

/** Debits and credits of the profit accounts, per channel and (for the POS) per branch, over the entries in the range. */
async function attributedSums(db: Db, scope: Scope): Promise<{ channel: string | null; branchId: string | null; accountId: string; debit: number; credit: number }[]> {
  return db.all(sql`
    WITH scoped AS (
      SELECT e.id, e.ref_type, e.ref_id FROM journal_entries AS e
      WHERE e.at >= ${scope.fromMs} AND e.at < ${scope.toMs} ${scope.demo ? sql`` : sql`AND e.is_demo = 0`}
    ),
    attributed AS (
      SELECT s.id AS entryId,
        CASE s.ref_type
          WHEN 'order' THEN s.ref_id
          WHEN 'refund' THEN (SELECT r.order_id FROM refunds AS r WHERE r.id = s.ref_id)
          WHEN 'return' THEN (SELECT rt.order_id FROM returns AS rt WHERE rt.id = s.ref_id)
          WHEN 'return_item' THEN (SELECT rt.order_id FROM return_items AS ri JOIN returns AS rt ON rt.id = ri.return_id WHERE ri.id = s.ref_id)
          WHEN 'payment' THEN (SELECT p.order_id FROM payments AS p WHERE p.id = s.ref_id)
        END AS orderId,
        CASE s.ref_type
          WHEN 'cod_settlement' THEN (
            SELECT CASE WHEN count(DISTINCT o2.channel) = 1 THEN min(o2.channel) END
            FROM cod_settlement_items AS i JOIN shipments AS sh ON sh.id = i.shipment_id JOIN orders AS o2 ON o2.id = sh.order_id
            WHERE i.settlement_id = s.ref_id)
          WHEN 'pos_shift' THEN 'pos'
        END AS directChannel,
        CASE s.ref_type
          WHEN 'pos_shift' THEN (SELECT reg.branch_id FROM pos_shifts AS ps JOIN pos_registers AS reg ON reg.id = ps.register_id WHERE ps.id = s.ref_id)
        END AS directBranch
      FROM scoped AS s
    )
    SELECT coalesce(o.channel, a.directChannel) AS channel,
           CASE WHEN coalesce(o.channel, a.directChannel) = 'pos' THEN coalesce(o.branch_id, a.directBranch) END AS branchId,
           l.account_id AS accountId,
           coalesce(sum(l.debit_iqd), 0) AS debit,
           coalesce(sum(l.credit_iqd), 0) AS credit
    FROM journal_lines AS l
    JOIN attributed AS a ON a.entryId = l.entry_id
    LEFT JOIN orders AS o ON o.id = a.orderId
    GROUP BY 1, 2, 3`);
}

const bps = (part: number, whole: number) => (whole === 0 ? null : Math.round((part * 10_000) / whole));

export async function channelProfitability(db: Db, actor: Actor, range: Scope, locale: Locale): Promise<ChannelProfitability> {
  assertCan(actor, "channels.report.read");
  assertWholeStore(actor);
  const withCost = can(actor, "cost.read");
  const withProfit = withCost && can(actor, "profit.read");
  const scope = { from: range.fromMs, to: range.toMs, includeDemo: range.demo };
  const demo = range.demo ? sql`` : sql`AND o.is_demo = 0`;

  const [chart, sums, recognised, uncosted, names, pnl] = await Promise.all([
    chartOfAccounts(db),
    attributedSums(db, range),
    db.all<{ channel: string; branchId: string | null; n: number }>(sql`
      SELECT o.channel AS channel, CASE WHEN o.channel = 'pos' THEN o.branch_id END AS branchId, count(*) AS n
      FROM journal_entries AS e JOIN orders AS o ON o.id = e.ref_id
      WHERE e.ref_type = 'order' AND e.idempotency_key LIKE 'order:%:sale' AND e.at >= ${range.fromMs} AND e.at < ${range.toMs}
        ${range.demo ? sql`` : sql`AND e.is_demo = 0`}
      GROUP BY 1, 2`),
    withCost
      ? db.all<{ channel: string; branchId: string | null; units: number }>(sql`
          SELECT o.channel AS channel, CASE WHEN o.channel = 'pos' THEN o.branch_id END AS branchId, coalesce(sum(-m.qty_delta), 0) AS units
          FROM stock_movements AS m JOIN orders AS o ON o.id = m.ref_id AND m.ref_type = 'order'
          WHERE m.kind = 'sale' AND m.unit_cost_iqd IS NULL AND m.at >= ${range.fromMs} AND m.at < ${range.toMs} ${demo}
          GROUP BY 1, 2`)
      : Promise.resolve([]),
    channelNames(db, locale),
    profitAndLoss(db, actor, scope),
  ]);
  const roots = systemRoots(chart);

  // channel → branch ("" for none) → sums of the families
  const buckets = new Map<string, Map<string, Sums>>();
  const unattributed = emptySums();
  for (const row of sums) {
    const family = roots.get(row.accountId) as SystemAccountKey | null | undefined;
    if (!family || !(FAMILIES as readonly string[]).includes(family)) continue;
    const target =
      row.channel === null
        ? unattributed
        : (() => {
            const byBranch = buckets.get(row.channel) ?? new Map<string, Sums>();
            buckets.set(row.channel, byBranch);
            const key = row.branchId ?? "";
            const found = byBranch.get(key) ?? emptySums();
            byBranch.set(key, found);
            return found;
          })();
    target[family as Family].debit += num(row.debit);
    target[family as Family].credit += num(row.credit);
  }
  const recognisedBy = new Map<string, number>();
  for (const row of recognised) recognisedBy.set(`${row.channel}|${row.branchId ?? ""}`, num(row.n));
  const uncostedBy = new Map<string, number>();
  for (const row of uncosted) uncostedBy.set(`${row.channel}|${row.branchId ?? ""}`, num(row.units));

  const figures = (s: Sums) => {
    const gross = s.sales_revenue.credit - s.sales_revenue.debit;
    const discounts = s.sales_discounts.debit - s.sales_discounts.credit;
    const refunds = s.sales_refunds.debit - s.sales_refunds.credit;
    const shippingIncome = s.shipping_income.credit - s.shipping_income.debit;
    const cogs = s.cogs.debit - s.cogs.credit;
    const shippingCosts = s.shipping_costs.debit - s.shipping_costs.credit;
    const net = gross - discounts - refunds;
    return { gross, discounts, refunds, shippingIncome, cogs, shippingCosts, net };
  };
  const merge = (all: Iterable<Sums>): Sums => {
    const out = emptySums();
    for (const s of all) for (const family of FAMILIES) {
      out[family].debit += s[family].debit;
      out[family].credit += s[family].credit;
    }
    return out;
  };

  const keys = [...names.keys()];
  for (const key of buckets.keys()) if (!names.has(key)) keys.push(key);
  const branchIds = [...(buckets.get("pos")?.keys() ?? [])].filter(Boolean);
  for (const row of recognised) if (row.channel === "pos" && row.branchId && !branchIds.includes(row.branchId)) branchIds.push(row.branchId);
  const branchLabel = await branchNames(db, branchIds, locale);

  const rows: ChannelProfitRow[] = keys.map((key) => {
    const byBranch = buckets.get(key) ?? new Map<string, Sums>();
    const f = figures(merge(byBranch.values()));
    const ordersRecognised = [...recognisedBy.entries()].filter(([k]) => k.startsWith(`${key}|`)).reduce((total, [, n]) => total + n, 0);
    const uncostedUnits = [...uncostedBy.entries()].filter(([k]) => k.startsWith(`${key}|`)).reduce((total, [, n]) => total + n, 0);
    const grossProfit = f.net - f.cogs;
    const contribution = grossProfit - (f.shippingCosts - f.shippingIncome);
    const info = names.get(key) ?? { name: key, connected: false };
    const branchKeys = key === "pos" ? [...new Set([...byBranch.keys(), ...[...recognisedBy.keys()].filter((k) => k.startsWith("pos|")).map((k) => k.slice(4))])] : [];
    return {
      key,
      name: info.name,
      connected: info.connected,
      ordersRecognised,
      grossIqd: f.gross,
      discountsIqd: f.discounts,
      refundsIqd: f.refunds,
      netRevenueIqd: f.net,
      shippingIncomeIqd: f.shippingIncome,
      // protected figures: the keys are absent without the permission (never null-masked, never 0)
      ...(withCost ? { cogsIqd: f.cogs, shippingCostsIqd: f.shippingCosts, uncostedUnits } : {}),
      ...(withProfit ? { grossProfitIqd: grossProfit, grossMarginBps: bps(grossProfit, f.net), contributionIqd: contribution, contributionMarginBps: bps(contribution, f.net) } : {}),
      branches: branchKeys
        .map((branchKey) => {
          const b = figures(byBranch.get(branchKey) ?? emptySums());
          return {
            branchId: branchKey || null,
            name: branchKey ? (branchLabel.get(branchKey) ?? branchKey) : null,
            ordersRecognised: recognisedBy.get(`pos|${branchKey}`) ?? 0,
            netRevenueIqd: b.net,
            ...(withCost ? { cogsIqd: b.cogs } : {}),
            ...(withProfit ? { grossProfitIqd: b.net - b.cogs } : {}),
          };
        })
        .sort((a, b) => (a.branchId === null ? 1 : b.branchId === null ? -1 : (a.name ?? "").localeCompare(b.name ?? ""))),
    };
  });

  const u = figures(unattributed);
  const commissions = unattributed.commissions.debit - unattributed.commissions.credit + [...buckets.values()].reduce((total, byBranch) => total + [...byBranch.values()].reduce((sum, s) => sum + s.commissions.debit - s.commissions.credit, 0), 0);
  return {
    range: { from: range.from, to: range.to, demo: range.demo },
    rows,
    unattributed: {
      grossIqd: u.gross,
      discountsIqd: u.discounts,
      refundsIqd: u.refunds,
      shippingIncomeIqd: u.shippingIncome,
      ...(withCost ? { cogsIqd: u.cogs, shippingCostsIqd: u.shippingCosts } : {}),
    },
    ...(withProfit ? { commissionsIqd: commissions } : {}),
    store: {
      netRevenueIqd: pnl.revenue.netIqd,
      ...(withCost && pnl.cost ? { cogsIqd: pnl.cost.cogsIqd } : {}),
      ...(withProfit && pnl.profit ? { netProfitIqd: pnl.profit.netIqd, netMarginBps: pnl.profit.netMarginBps } : {}),
    },
    fields: { cost: withCost, profit: withProfit },
  };
}
