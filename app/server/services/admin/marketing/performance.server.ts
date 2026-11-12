/**
 * Admin 16.07 — CAC, ROAS and LTV, each with its written definition (docs/metrics.md §8) and the source of every
 * figure on the page.
 *
 *   performanceReport(db, actor, range, now)        marketing.report.read
 *   performanceCsvRows(report)                      the same figures as rows (the route adds the header and audits the export)
 *
 *   SPEND      entered by staff per campaign and month (recordSpend: an invoice, an ad account's bill). Ad spend is
 *              measured nowhere else; a month without an entry has NO spend figure (never 0).
 *   CUSTOMER   a person: the account, else the account that claimed the guest checkout, else the phone number of
 *              the order. A qualifying order is real (not demo), not cancelled, and money arrived for it (paid > 0).
 *   NEW        a person whose FIRST qualifying order falls in the month (Baghdad).
 *   CAC        spend of the month ÷ new customers of the month (blended: every campaign, every new customer).
 *   ROAS       paid sales of the orders attributed to a campaign ÷ the campaign's spend — attributed only when the
 *              order carries the source (links.server.ts); none does today, so ROAS is "not available", never 0.
 *   LTV        average of Σ (paid − refunded) over a person's qualifying orders to date — money that arrived and
 *              stayed (docs/metrics.md §3 "Paid sales", per person). Revenue-based: no cost or profit enters it.
 *
 * No cost, landed cost, margin or profit is read anywhere in this module, so nothing here needs cost.read or
 * profit.read; a profit-based LTV belongs to the reports module (18), from the journal (metrics §4).
 */
import { sql } from "drizzle-orm";
import type { Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { attributedByCampaign } from "./links.server";
import { assertAny, num, SECTION_READ } from "./shared.server";
import { addMonths, baghdadMonth, monthStart, monthsBetween, ratio, type CampaignChannelKey, type MonthRange, type SpendEntry } from "./types";

export type MonthFigures = {
  period: string;
  spendIqd: number | null;
  spendEntries: number;
  newCustomers: number;
  cacIqd: number | null;
  attributedOrders: number;
  attributedPaidIqd: number;
};

export type CampaignFigures = {
  id: string;
  name: string;
  channel: CampaignChannelKey;
  isDemo: boolean;
  spendIqd: number | null;
  spendEntries: number;
  budgetIqd: number | null;
  attributedOrders: number;
  attributedPaidIqd: number;
  roas: number | null;
};

export type PerformanceReport = {
  range: MonthRange;
  months: MonthFigures[];
  campaigns: CampaignFigures[];
  totals: { spendIqd: number | null; spendEntries: number; newCustomers: number; cacIqd: number | null; attributedOrders: number; attributedPaidIqd: number; roas: number | null };
  ltv: {
    /** People with at least one qualifying order, ever. */
    customers: number;
    avgPaidIqd: number | null;
    avgOrders: number | null;
    /** People acquired in the range (their first qualifying order in it). */
    cohort: number;
    cohortAvgPaidIqd: number | null;
  };
  ltvToCac: number | null;
  sources: { attributionCaptured: boolean; qualifyingOrders: number; spendCampaigns: number };
};

type CampaignSpendRow = { id: string; name: string; channel: CampaignChannelKey; is_demo: number; budget_iqd: number | null; content: string | null };

function spendOf(text: string | null): SpendEntry[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as { spend?: unknown };
    return Array.isArray(value.spend) ? (value.spend as SpendEntry[]).filter((entry) => entry && typeof entry.period === "string" && Number.isSafeInteger(entry.amountIqd)) : [];
  } catch {
    return [];
  }
}

export async function performanceReport(db: Db, actor: Actor, range: MonthRange, now: number): Promise<PerformanceReport> {
  assertAny(actor, SECTION_READ.performance);
  void now;
  const months = monthsBetween(range.from, range.to);
  const fromMs = monthStart(range.from);
  const toMs = monthStart(addMonths(range.to, 1));
  const demo = range.demo ? 1 : 0;

  const [campaignRows, people, attribution, everAttributed] = await Promise.all([
    db.all<CampaignSpendRow>(sql`SELECT id, name, channel, is_demo, budget_iqd, content FROM campaigns WHERE (${demo} = 1 OR is_demo = 0) ORDER BY created_at`),
    db.all<{ person: string; first_at: number; orders: number; net: number }>(sql`
      SELECT person, MIN(placed_at) AS first_at, COUNT(*) AS orders, SUM(paid_iqd - refunded_iqd) AS net FROM (
        SELECT COALESCE(o.customer_id, gc.customer_id, o.contact_phone_e164) AS person, o.placed_at, o.paid_iqd, o.refunded_iqd
        FROM orders o LEFT JOIN guest_contacts gc ON gc.id = o.guest_contact_id
        WHERE (${demo} = 1 OR o.is_demo = 0) AND o.status <> 'cancelled' AND o.paid_iqd > 0)
      WHERE person IS NOT NULL GROUP BY person`),
    attributedByCampaign(db, { fromMs, toMs, includeDemo: range.demo }),
    db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM (SELECT 1 FROM orders WHERE utm_link_id IS NOT NULL OR attribution IS NOT NULL LIMIT 1)`),
  ]);

  // spend per month and per campaign, from the entries staff made
  const monthSpend = new Map<string, { sum: number; entries: number }>();
  const campaigns: CampaignFigures[] = [];
  for (const row of campaignRows) {
    const entries = spendOf(row.content).filter((entry) => entry.period >= range.from && entry.period <= range.to);
    for (const entry of entries) {
      const month = monthSpend.get(entry.period) ?? { sum: 0, entries: 0 };
      month.sum += entry.amountIqd;
      month.entries += 1;
      monthSpend.set(entry.period, month);
    }
    const attributed = attribution.byCampaign.get(row.id);
    const spend = entries.length > 0 ? entries.reduce((sum, entry) => sum + entry.amountIqd, 0) : null;
    if (entries.length === 0 && !attributed) continue;
    campaigns.push({
      id: row.id,
      name: row.name,
      channel: row.channel,
      isDemo: num(row.is_demo) === 1,
      spendIqd: spend,
      spendEntries: entries.length,
      budgetIqd: row.budget_iqd === null ? null : num(row.budget_iqd),
      attributedOrders: attributed?.orders ?? 0,
      attributedPaidIqd: attributed?.paidIqd ?? 0,
      // attribution not captured: no ratio at all (not 0)
      roas: attributed ? ratio(attributed.paidIqd, spend) : null,
    });
  }

  // new customers per month (first qualifying order)
  const newPerMonth = new Map<string, number>();
  let cohort = 0;
  let cohortNet = 0;
  let allNet = 0;
  let allOrders = 0;
  for (const person of people) {
    const first = num(person.first_at);
    allNet += num(person.net);
    allOrders += num(person.orders);
    if (first >= fromMs && first < toMs) {
      const period = baghdadMonth(first);
      newPerMonth.set(period, (newPerMonth.get(period) ?? 0) + 1);
      cohort += 1;
      cohortNet += num(person.net);
    }
  }
  // attributed orders by month: the SAME orders as the campaign rows and the totals (attributed to a campaign —
  // metrics §8); an order whose source matches no campaign is not an attributed order anywhere in this report
  const attributedMonth = new Map<string, { orders: number; paid: number }>();
  for (const order of attribution.orders) {
    const period = baghdadMonth(order.placedAt);
    const entry = attributedMonth.get(period) ?? { orders: 0, paid: 0 };
    entry.orders += 1;
    entry.paid += order.paidIqd;
    attributedMonth.set(period, entry);
  }

  const monthRows: MonthFigures[] = months.map((period) => {
    const spend = monthSpend.get(period);
    const fresh = newPerMonth.get(period) ?? 0;
    return {
      period,
      spendIqd: spend ? spend.sum : null,
      spendEntries: spend?.entries ?? 0,
      newCustomers: fresh,
      cacIqd: spend ? ratio(spend.sum, fresh) : null,
      attributedOrders: attributedMonth.get(period)?.orders ?? 0,
      attributedPaidIqd: attributedMonth.get(period)?.paid ?? 0,
    };
  });
  const spendEntries = monthRows.reduce((sum, row) => sum + row.spendEntries, 0);
  const spendTotal = spendEntries > 0 ? monthRows.reduce((sum, row) => sum + (row.spendIqd ?? 0), 0) : null;
  const newTotal = monthRows.reduce((sum, row) => sum + row.newCustomers, 0);
  const cac = spendTotal === null ? null : ratio(spendTotal, newTotal);
  const attributedPaid = attribution.orders.reduce((sum, order) => sum + order.paidIqd, 0);
  const cohortAvg = cohort > 0 ? cohortNet / cohort : null;
  return {
    range,
    months: monthRows,
    campaigns: campaigns.sort((a, b) => (b.spendIqd ?? 0) - (a.spendIqd ?? 0)),
    totals: {
      spendIqd: spendTotal,
      spendEntries,
      newCustomers: newTotal,
      cacIqd: cac,
      attributedOrders: attribution.orders.length,
      attributedPaidIqd: attributedPaid,
      roas: attribution.orders.length > 0 ? ratio(attributedPaid, spendTotal) : null,
    },
    ltv: {
      customers: people.length,
      avgPaidIqd: people.length > 0 ? allNet / people.length : null,
      avgOrders: people.length > 0 ? allOrders / people.length : null,
      cohort,
      cohortAvgPaidIqd: cohortAvg,
    },
    ltvToCac: cohortAvg !== null && cac !== null ? ratio(cohortAvg, cac) : null,
    sources: { attributionCaptured: num(everAttributed[0]?.n) > 0, qualifyingOrders: allOrders, spendCampaigns: campaigns.filter((entry) => entry.spendEntries > 0).length },
  };
}

/** The report's figures as CSV rows (no header — the route adds it in the employee's language). Empty = "". */
export function performanceCsvRows(report: PerformanceReport): { months: (string | number)[][]; campaigns: (string | number)[][] } {
  const cell = (value: number | null) => (value === null ? "" : Math.round(value));
  const ratioCell = (value: number | null) => (value === null ? "" : value.toFixed(2));
  return {
    months: report.months.map((row) => [row.period, cell(row.spendIqd), row.spendEntries, row.newCustomers, cell(row.cacIqd), row.attributedOrders, row.attributedPaidIqd]),
    campaigns: report.campaigns.map((row) => [row.name, row.channel, cell(row.spendIqd), row.spendEntries, cell(row.budgetIqd), row.attributedOrders, row.attributedPaidIqd, ratioCell(row.roas)]),
  };
}
