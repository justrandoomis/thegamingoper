/**
 * The command centre's small trend — client-safe shapes (the data comes from ./trend.server.ts, the reports module's
 * own "sales by day"). Days are Baghdad days, oldest first; the last one is today, still running.
 */

/** Days on the trend, today included. */
export const TREND_DAYS = 14;

export type TrendDay = { day: string; at: number; placed: number; today: boolean };

/** Orders placed per day (docs/metrics.md §3, the KPI's own definition) and the daily report it comes from. */
export type OrdersTrend = { days: TrendDay[]; href: string; demo: boolean };
