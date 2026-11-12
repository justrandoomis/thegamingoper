/**
 * Admin 18.04 — cohorts, repeat purchases and customer value (reports.customer.read).
 *
 * A purchase is module 07's: an order of an account (not a guest) the store was paid for and did not pay back in full
 * (paid − refunded > 0), never a cancelled one; what it is worth is what the store kept (paid − refunded). Merged and
 * erased accounts are left out, as module 07 leaves them out of its segments. Demo orders only when the range asks.
 *
 *   cohorts   customers grouped by the Baghdad month of their FIRST purchase, for first purchases in the range; each
 *             row follows the cohort for COHORT_MONTHS months: the share of its customers who bought in that month
 *             (month 0 = the first month, 100 % by definition; a month not reached yet is "—", never 0 %)
 *   repeat    of the customers whose first purchase is in the range: how many bought again (ever, up to now), the
 *             median days to the second purchase, purchases and kept IQD per customer
 *   value     every customer with a purchase (lifetime, now): module 07's RFM segment (rfmOf — its rules, its map), how
 *             many, what they are worth, the repeat share. The stored segments (module 07's recompute) stay its own.
 * Guests (a phone without an account) cannot be followed over time: their purchases in the range are counted apart.
 * Aggregates only — no name, phone or order reaches this report.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { rfmOf, RFM_SEGMENTS, type RfmSegment } from "../customers/types";
import { median } from "../support/types";
import { assertReport, num } from "./shared.server";
import { bpsOfShare, COHORT_MONTHS, DAY_MS, periodOf, shiftPeriod, type CustomerParams, type RangeFilter } from "./types";

const BAGHDAD_MS = 3 * 60 * 60 * 1000;

export type CohortRow = {
  /** "YYYY-MM" of the first purchase. */
  cohort: string;
  customers: number;
  /** Share of the cohort that bought in month k after the first (k = 0 … COHORT_MONTHS − 1); null = not reached yet. */
  retention: (number | null)[];
  /** Customers who bought in month k (null = not reached yet). */
  buyers: (number | null)[];
  /** Kept IQD per customer of the cohort, up to now. */
  valuePerCustomerIqd: number;
};

export type RepeatFacts = {
  customers: number;
  repeaters: number;
  repeatBps: number | null;
  medianDaysToSecond: number | null;
  purchasesPerCustomer: number | null;
  valuePerCustomerIqd: number | null;
};

export type SegmentValue = { segment: RfmSegment; customers: number; keptIqd: number; avgKeptIqd: number | null; shareBps: number | null };

export type CustomerReport = {
  view: CustomerParams["view"];
  range: Pick<RangeFilter, "from" | "to" | "period" | "demo">;
  cohorts: CohortRow[];
  repeat: RepeatFacts;
  /** Guest purchases in the range (not followed over time). */
  guestPurchases: number;
  /** value view only */
  value: { customers: number; keptIqd: number; avgKeptIqd: number | null; medianKeptIqd: number | null; repeatBps: number | null; segments: SegmentValue[] } | null;
};

function purchasesCte(demo: boolean): SQL {
  return sql`p AS (
    SELECT o.customer_id AS c, o.placed_at AS at, o.paid_iqd - o.refunded_iqd AS kept
    FROM orders AS o JOIN customers AS cu ON cu.id = o.customer_id
    WHERE o.customer_id IS NOT NULL AND o.status <> 'cancelled' AND o.paid_iqd > o.refunded_iqd AND (o.is_demo = 0 OR ${demo ? 1 : 0} = 1)
      AND cu.status NOT IN ('merged', 'deleted'))`;
}

/** Whole months from one "YYYY-MM" to another. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

type Facts = { c: string; firstAt: number; secondAt: number | null; lastAt: number; purchases: number; kept: number };

async function customerFacts(db: Db, demo: boolean, firstIn: { from: number; to: number } | null): Promise<Facts[]> {
  const rows = await db.all<{ c: string; firstAt: number; secondAt: number | null; lastAt: number; purchases: number; kept: number }>(sql`
    WITH ${purchasesCte(demo)},
    ranked AS (SELECT c, at, kept, row_number() OVER (PARTITION BY c ORDER BY at) AS n FROM p)
    SELECT c, min(at) AS firstAt, max(CASE WHEN n = 2 THEN at END) AS secondAt, max(at) AS lastAt, count(*) AS purchases, coalesce(sum(kept), 0) AS kept
    FROM ranked GROUP BY c
    ${firstIn ? sql`HAVING min(at) >= ${firstIn.from} AND min(at) < ${firstIn.to}` : sql``}`);
  return rows.map((row) => ({ c: row.c, firstAt: num(row.firstAt), secondAt: row.secondAt === null ? null : num(row.secondAt), lastAt: num(row.lastAt), purchases: num(row.purchases), kept: num(row.kept) }));
}

function repeatOf(facts: readonly Facts[]): RepeatFacts {
  const customers = facts.length;
  const repeaters = facts.filter((row) => row.purchases >= 2).length;
  const gaps = facts.filter((row) => row.secondAt !== null).map((row) => Math.round(((row.secondAt as number) - row.firstAt) / DAY_MS));
  const purchases = facts.reduce((sum, row) => sum + row.purchases, 0);
  const kept = facts.reduce((sum, row) => sum + row.kept, 0);
  return {
    customers,
    repeaters,
    repeatBps: bpsOfShare(repeaters, customers),
    medianDaysToSecond: median(gaps),
    purchasesPerCustomer: customers > 0 ? purchases / customers : null,
    valuePerCustomerIqd: customers > 0 ? Math.round(kept / customers) : null,
  };
}

/** 18.04 — the cohorts of the range (or the value of every customer), the repeat facts and the guests. */
export async function customerReport(db: Db, actor: Actor, params: CustomerParams, now: number): Promise<CustomerReport> {
  assertReport(actor, "customers");
  const { range } = params;
  const demo = range.demo;
  const scope = { from: range.fromMs, to: range.toMs };
  const nowMonth = periodOf(now);
  const [cells, firstFacts, guests, allFacts] = await Promise.all([
    params.view === "cohorts"
      ? db.all<{ cohort: string; month: string; buyers: number; kept: number }>(sql`
          WITH ${purchasesCte(demo)},
          first AS (SELECT c, min(at) AS first_at FROM p GROUP BY c HAVING min(at) >= ${scope.from} AND min(at) < ${scope.to})
          SELECT strftime('%Y-%m', (f.first_at + ${BAGHDAD_MS}) / 1000, 'unixepoch') AS cohort,
                 strftime('%Y-%m', (p.at + ${BAGHDAD_MS}) / 1000, 'unixepoch') AS month,
                 count(DISTINCT p.c) AS buyers, coalesce(sum(p.kept), 0) AS kept
          FROM p JOIN first AS f ON f.c = p.c
          GROUP BY cohort, month`)
      : Promise.resolve([]),
    customerFacts(db, demo, scope),
    db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM orders AS o
      WHERE o.customer_id IS NULL AND o.status <> 'cancelled' AND o.paid_iqd > o.refunded_iqd AND o.placed_at >= ${scope.from} AND o.placed_at < ${scope.to} AND (o.is_demo = 0 OR ${demo ? 1 : 0} = 1)`),
    params.view === "value" ? customerFacts(db, demo, null) : Promise.resolve(null),
  ]);

  const cohorts = new Map<string, CohortRow & { kept: number }>();
  for (const cell of cells) {
    const row = cohorts.get(cell.cohort) ?? { cohort: cell.cohort, customers: 0, retention: [], buyers: [], valuePerCustomerIqd: 0, kept: 0 };
    const k = monthsBetween(cell.cohort, cell.month);
    if (k === 0) row.customers = num(cell.buyers);
    if (k >= 0 && k < COHORT_MONTHS) row.buyers[k] = num(cell.buyers);
    row.kept += num(cell.kept);
    cohorts.set(cell.cohort, row);
  }
  const cohortRows: CohortRow[] = [...cohorts.values()]
    .sort((a, b) => a.cohort.localeCompare(b.cohort))
    .map((row) => {
      const reached = Math.min(COHORT_MONTHS, monthsBetween(row.cohort, nowMonth) + 1);
      const buyers: (number | null)[] = Array.from({ length: COHORT_MONTHS }, (_, k) => (k < reached ? (row.buyers[k] ?? 0) : null));
      return {
        cohort: row.cohort,
        customers: row.customers,
        buyers,
        retention: buyers.map((count) => (count === null || row.customers === 0 ? null : count / row.customers)),
        valuePerCustomerIqd: row.customers > 0 ? Math.round(row.kept / row.customers) : 0,
      };
    });

  let value: CustomerReport["value"] = null;
  if (allFacts) {
    const bySegment = new Map<RfmSegment, { customers: number; kept: number }>();
    for (const fact of allFacts) {
      const segment = rfmOf({ purchases: fact.purchases, monetaryIqd: fact.kept, lastPurchaseAt: fact.lastAt }, now).segment;
      const entry = bySegment.get(segment) ?? { customers: 0, kept: 0 };
      entry.customers += 1;
      entry.kept += fact.kept;
      bySegment.set(segment, entry);
    }
    const customers = allFacts.length;
    const keptIqd = allFacts.reduce((sum, fact) => sum + fact.kept, 0);
    value = {
      customers,
      keptIqd,
      avgKeptIqd: customers > 0 ? Math.round(keptIqd / customers) : null,
      medianKeptIqd: median(allFacts.map((fact) => fact.kept)),
      repeatBps: bpsOfShare(allFacts.filter((fact) => fact.purchases >= 2).length, customers),
      segments: RFM_SEGMENTS.filter((segment) => segment !== "none").map((segment) => {
        const entry = bySegment.get(segment) ?? { customers: 0, kept: 0 };
        return { segment, customers: entry.customers, keptIqd: entry.kept, avgKeptIqd: entry.customers > 0 ? Math.round(entry.kept / entry.customers) : null, shareBps: bpsOfShare(entry.customers, customers) };
      }),
    };
  }

  return {
    view: params.view,
    range: { from: range.from, to: range.to, period: range.period, demo: range.demo },
    cohorts: cohortRows,
    repeat: repeatOf(firstFacts),
    guestPurchases: num(guests[0]?.n),
    value,
  };
}

/** The months a cohort table spans from its first column ("YYYY-MM", k = 0 …) — for column titles. */
export function cohortMonthLabel(cohort: string, k: number): string {
  return shiftPeriod(cohort, k);
}
