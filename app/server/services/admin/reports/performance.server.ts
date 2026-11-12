/**
 * Admin 18.05 — performance of suppliers, employees, shipping and customer service (reports.performance.read).
 * Each section reuses the module that owns the definition, and never shows more than that module would:
 *
 *   suppliers  module 09's rating (supplierRatings: on time, defects, score and grade, lead time) over ITS window
 *              (RATING.windowDays, 365 days up to now) — quantities only, never a price or a cost
 *   employees  module 15's performance for the month of the range — staff.performance.read, checked by module 15 (its
 *              branch limit too); no cost or margin is read there. Only what this report shows leaves the server:
 *              counter sales, units, refunds on them, basket and packing — module 15's pay (commissions) and
 *              attendance stay on its own page (review 2026-11-12: they were in the page's data)
 *   shipping   computed here from the parcels handed to a carrier in the range (no module defines these yet; the
 *              dictionary lists them): delivered and returned, delivery success = delivered ÷ (delivered + returned),
 *              first-attempt success = delivered without a failed try ÷ delivered, failed tries, days to deliver, and
 *              cash-on-delivery settlement time = settled − delivered (median), what still waits for a settlement.
 *              No carrier charge is read (cost data).
 *   support    module 14's service metrics (supportMetrics: first response, resolution, within SLA, backlog, by agent)
 *              for 7 / 30 / 90 days — support.metrics.read, checked by module 14
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import type { Permission } from "~/server/permissions";
import { supplierRatings } from "../purchasing/rating.server";
import { RATING, type SupplierRating } from "../purchasing/rules";
import { performance as staffPerformance, type PerformanceRow as StaffPerformanceRow, type PerformanceView as StaffPerformance } from "../staff/performance.server";
import { supportMetrics, type SupportMetrics } from "../support/metrics.server";
import { median, share } from "../support/types";
import { assertReport, num } from "./shared.server";
import { DAY_MS, PERFORMANCE_VIEWS, periodOf, type PerformanceParams, type PerformanceView, type RangeFilter } from "./types";

/** Parcels a shipping section reads at most (the page says when there were more). */
export const MAX_PARCELS = 20_000;

export type SupplierPerformance = { id: string; code: string; name: string; status: string; isDemo: boolean; rating: SupplierRating; canOpen: boolean };

export type CarrierPerformance = {
  carrierId: string | null;
  name: string | null;
  sent: number;
  delivered: number;
  returned: number;
  /** Still on the way, failed and waiting, or back at the store not received yet. */
  open: number;
  successRate: number | null;
  firstAttemptRate: number | null;
  failedAttempts: number;
  medianDeliveryDays: number | null;
  cod: { delivered: number; settled: number; medianSettleDays: number | null; awaiting: number; oldestAwaitingDays: number | null };
};

export type ShippingPerformance = { rows: CarrierPerformance[]; total: CarrierPerformance; truncated: boolean };

/** One employee's month as this report shows it (module 15's figures, without its pay and attendance). */
export type EmployeePerformance = Pick<StaffPerformanceRow, "employee" | "sales" | "packed">;

export type PerformanceReport = {
  view: PerformanceView;
  range: Pick<RangeFilter, "from" | "to" | "period" | "demo">;
  /** Which sections this viewer may open (the owning module's permission), and what they lack. */
  sections: Record<PerformanceView, { open: boolean; needs: Permission | null }>;
  suppliers: { rows: SupplierPerformance[]; windowDays: number; minReceipts: number } | null;
  employees: { period: string; rows: EmployeePerformance[]; totals: StaffPerformance["totals"] } | null;
  shipping: ShippingPerformance | null;
  support: { days: number; metrics: SupportMetrics } | null;
};

const SECTION_NEEDS: Record<PerformanceView, Permission | null> = { suppliers: null, employees: "staff.performance.read", shipping: null, support: "support.metrics.read" };

export function performanceSections(actor: Actor): PerformanceReport["sections"] {
  return Object.fromEntries(
    PERFORMANCE_VIEWS.map((view) => {
      const needs = SECTION_NEEDS[view];
      const open = needs === null || can(actor, needs);
      return [view, { open, needs: open ? null : needs }];
    }),
  ) as PerformanceReport["sections"];
}

/** Suppliers with module 09's rating, best score first (no score — too little history — last). */
export async function supplierPerformance(db: Db, actor: Actor, demo: boolean, now: number): Promise<SupplierPerformance[]> {
  assertReport(actor, "performance");
  const rows = await db.all<{ id: string; code: string; name: string; status: string; isDemo: number }>(sql`
    SELECT id, code, name, status, is_demo AS isDemo FROM suppliers WHERE (is_demo = 0 OR ${demo ? 1 : 0} = 1) ORDER BY name`);
  const ratings = await supplierRatings(db, rows.map((row) => row.id), now);
  const canOpen = can(actor, "purchasing.supplier.read");
  return rows
    .map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status, isDemo: Boolean(row.isDemo), rating: ratings.get(row.id) as SupplierRating, canOpen }))
    .filter((row) => row.rating)
    .sort((a, b) => (b.rating.score ?? -1) - (a.rating.score ?? -1) || b.rating.receipts - a.rating.receipts || a.name.localeCompare(b.name, "ar"));
}

function emptyCarrier(carrierId: string | null, name: string | null): CarrierPerformance {
  return { carrierId, name, sent: 0, delivered: 0, returned: 0, open: 0, successRate: null, firstAttemptRate: null, failedAttempts: 0, medianDeliveryDays: null, cod: { delivered: 0, settled: 0, medianSettleDays: null, awaiting: 0, oldestAwaitingDays: null } };
}

/** Parcels handed to a carrier in the range, per carrier and in total. */
export async function shippingPerformance(db: Db, actor: Actor, range: RangeFilter, now: number): Promise<ShippingPerformance> {
  assertReport(actor, "performance");
  const demo = range.demo ? 1 : 0;
  const [parcels, carriers] = await Promise.all([
    db.all<{ carrierId: string | null; status: string; shippedAt: number; deliveredAt: number | null; cod: number; settledAt: number | null; failed: number }>(sql`
      SELECT s.carrier_id AS carrierId, s.status AS status, s.shipped_at AS shippedAt, s.delivered_at AS deliveredAt,
             coalesce(s.cod_amount_iqd, 0) AS cod, s.cod_settled_at AS settledAt,
             (SELECT count(*) FROM delivery_attempts AS da WHERE da.shipment_id = s.id AND da.outcome <> 'delivered') AS failed
      FROM shipments AS s JOIN orders AS o ON o.id = s.order_id
      WHERE s.shipped_at >= ${range.fromMs} AND s.shipped_at < ${range.toMs} AND s.status <> 'cancelled' AND (o.is_demo = 0 OR ${demo} = 1)
      ORDER BY s.shipped_at
      LIMIT ${MAX_PARCELS + 1}`),
    db.all<{ id: string; name: string }>(sql`SELECT id, name FROM carriers`),
  ]);
  const truncated = parcels.length > MAX_PARCELS;
  const list = truncated ? parcels.slice(0, MAX_PARCELS) : parcels;
  const names = new Map(carriers.map((row) => [row.id, row.name]));
  const groups = new Map<string, typeof list>();
  for (const parcel of list) groups.set(parcel.carrierId ?? "", [...(groups.get(parcel.carrierId ?? "") ?? []), parcel]);
  const measure = (carrierId: string | null, rows: typeof list): CarrierPerformance => {
    const out = emptyCarrier(carrierId, carrierId ? (names.get(carrierId) ?? carrierId) : null);
    const deliveryDays: number[] = [];
    const settleDays: number[] = [];
    let firstTime = 0;
    for (const row of rows) {
      out.sent += 1;
      out.failedAttempts += num(row.failed);
      if (row.status === "delivered") {
        out.delivered += 1;
        if (num(row.failed) === 0) firstTime += 1;
        if (row.deliveredAt !== null) deliveryDays.push(Math.max(0, Math.round(((num(row.deliveredAt) - num(row.shippedAt)) / DAY_MS) * 10) / 10));
        if (num(row.cod) > 0) {
          out.cod.delivered += 1;
          if (row.settledAt !== null) {
            out.cod.settled += 1;
            if (row.deliveredAt !== null) settleDays.push(Math.max(0, Math.round(((num(row.settledAt) - num(row.deliveredAt)) / DAY_MS) * 10) / 10));
          } else {
            out.cod.awaiting += 1;
            const age = row.deliveredAt === null ? null : Math.max(0, Math.floor((now - num(row.deliveredAt)) / DAY_MS));
            if (age !== null) out.cod.oldestAwaitingDays = Math.max(out.cod.oldestAwaitingDays ?? 0, age);
          }
        }
      } else if (row.status === "returned" || row.status === "returning") out.returned += 1;
      else out.open += 1;
    }
    out.successRate = share(out.delivered, out.delivered + out.returned);
    out.firstAttemptRate = share(firstTime, out.delivered);
    out.medianDeliveryDays = medianDays(deliveryDays);
    out.cod.medianSettleDays = medianDays(settleDays);
    return out;
  };
  const rows = [...groups.entries()].map(([key, value]) => measure(key || null, value)).sort((a, b) => b.sent - a.sent || (a.name ?? "~").localeCompare(b.name ?? "~"));
  return { rows, total: measure(null, list), truncated };
}

/** The median of day counts with one decimal (support's median rounds to whole numbers, made for minutes). */
function medianDays(values: number[]): number | null {
  if (values.length === 0) return null;
  const tenths = median(values.map((value) => Math.round(value * 10)));
  return tenths === null ? null : tenths / 10;
}

/** 18.05 — the section asked for (the first this viewer may open when none is named). */
export async function performanceReport(db: Db, actor: Actor, params: PerformanceParams, locale: Locale, now: number): Promise<PerformanceReport> {
  assertReport(actor, "performance");
  const sections = performanceSections(actor);
  const view: PerformanceView = params.view ?? PERFORMANCE_VIEWS.find((entry) => sections[entry].open) ?? "suppliers";
  const range = params.range;
  const base: PerformanceReport = {
    view,
    range: { from: range.from, to: range.to, period: range.period, demo: range.demo },
    sections,
    suppliers: null,
    employees: null,
    shipping: null,
    support: null,
  };
  if (!sections[view].open) return base;
  if (view === "suppliers") base.suppliers = { rows: await supplierPerformance(db, actor, range.demo, now), windowDays: RATING.windowDays, minReceipts: RATING.minReceipts };
  else if (view === "employees") {
    const period = range.period ?? periodOf(range.toMs - 1);
    const month = await staffPerformance(db, actor, { period }, locale, now);
    base.employees = { period, rows: month.rows.map((row) => ({ employee: row.employee, sales: row.sales, packed: row.packed })), totals: month.totals };
  } else if (view === "shipping") base.shipping = await shippingPerformance(db, actor, range, now);
  else base.support = { days: params.days, metrics: await supportMetrics(db, actor, { days: params.days, demo: range.demo }, now) };
  return base;
}
