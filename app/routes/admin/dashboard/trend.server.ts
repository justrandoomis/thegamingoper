/**
 * The command centre's small trend (admin 01.01): orders placed on each of the last TREND_DAYS Baghdad days, today
 * included and still running. Not a second formula — it is the reports module's own "sales by day" (18.01,
 * services/admin/reports/sales.server.ts `salesReport`, by = "day"): each day's `placed` is docs/metrics.md §3
 * "Orders placed" (any status, demo rows only when the page asks for them), the same definition as the KPI tile it
 * sits in. Read once for the whole window (one report call), streamed on its own like every card.
 *
 *   const trend = await ordersTrend(db, actor, { demo }, locale, now);
 *   // { days: [{ day: "2026-10-30", at, placed, today: false }, …, { day: "2026-11-12", …, today: true }], href }
 *
 * Who gets it: holders of reports.sales.read who see the whole company (`mayOpenReport` — the report refuses a
 * branch-limited employee), on a page without a branch filter (the report has none). Never a cost or a margin.
 */
import type { Locale } from "~/lib/locales";
import type { Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { baghdadDay, DAY_MS, dayStart, parseRange, rangeSearch } from "~/server/services/admin/finance/types";
import { salesReport } from "~/server/services/admin/reports/sales.server";
import { mayOpenReport } from "~/server/services/admin/reports/shared.server";
import { TREND_DAYS, type OrdersTrend, type TrendDay } from "./trend";

/** Whether this employee gets the trend on a page with these filters (the report's own rule; no branch filter). */
export function mayShowTrend(actor: Actor, filters: { branch: string | null }): boolean {
  return filters.branch === null && mayOpenReport(actor, "sales");
}

/** The window of the trend: the last TREND_DAYS Baghdad days up to today, as the report's range. */
export function trendRange(now: number, demo: boolean) {
  const to = baghdadDay(now);
  const from = baghdadDay(dayStart(to) - (TREND_DAYS - 1) * DAY_MS);
  const params = new URLSearchParams({ from, to });
  if (demo) params.set("demo", "1");
  return parseRange(params, now);
}

export async function ordersTrend(db: Db, actor: Actor, filters: { demo: boolean }, locale: Locale, now: number): Promise<OrdersTrend> {
  const range = trendRange(now, filters.demo);
  const report = await salesReport(db, actor, { range, by: "day", page: 1 }, locale, now, { all: true });
  const today = baghdadDay(now);
  const placed = new Map(report.rows.map((row) => [row.label.kind === "day" ? row.label.day : row.key, row.placed ?? 0]));
  const days: TrendDay[] = [];
  for (let at = dayStart(range.from); at <= dayStart(range.to); at += DAY_MS) {
    const day = baghdadDay(at);
    days.push({ day, at, placed: placed.get(day) ?? 0, today: day === today });
  }
  return { days, href: `/admin/reports/sales${rangeSearch(range)}`, demo: filters.demo };
}
