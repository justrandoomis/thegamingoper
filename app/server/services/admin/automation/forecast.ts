/**
 * Admin 19.05 — demand forecast by season and game launches: one simple method, explained on the page, with no
 * database (client-safe; tests call it directly).
 *
 *   forecastOf({ monthly: [12 full months, oldest first], historyMonths, releaseAt, preorderUnits, now })
 *
 * THE METHOD (every input is shown next to the result — a forecast is not a fact):
 *   · Sales = units that left with orders ('sale' stock movements, module 04's measure), per Baghdad month.
 *   · Fewer than MIN_HISTORY_MONTHS full months since the SKU's first stock movement → "short history": no number.
 *     No sale in the last MA_MONTHS months → "no recent sales": no number either (never a made-up zero).
 *   · Base = the moving average of the last MA_MONTHS full months.
 *   · Season: with 12 full months of history, next month's index = the units of the same month a year earlier ÷ the
 *     average month of the last 12, kept between INDEX_MIN and INDEX_MAX; without them, no seasonal index (1).
 *   · Forecast for next month = base × index, rounded to whole units.
 *   · Launches: a release date ahead (or within LAUNCH_DAYS behind) from the catalogue marks the SKU, with the units
 *     already pre-ordered — known demand, not a forecast.
 */
export const FORECAST = { windowMonths: 12, maMonths: 3, minHistoryMonths: 3, indexMin: 0.5, indexMax: 2, launchDays: 60 } as const;

const DAY_MS = 86_400_000;

export type ForecastStatus = "forecast" | "short_history" | "no_sales";
export type LaunchState = "upcoming" | "recent" | null;

export type ForecastInput = {
  /** Units sold in each of the last 12 FULL months, oldest first. */
  monthly: readonly number[];
  /** Full months since the SKU's first stock movement (0 when it never had stock). */
  historyMonths: number;
  /** Release (00:00 Baghdad) from the catalogue, or null. */
  releaseAt: number | null;
  /** Units on open pre-orders. */
  preorderUnits: number;
  now: number;
};

export type ForecastResult = {
  status: ForecastStatus;
  /** Units a month, one decimal (null without enough history). */
  movingAverage: number | null;
  /** ×100, e.g. 135 = 35 % above an average month; null without 12 months. */
  seasonalIndex: number | null;
  /** Units the same month sold a year ago (null without 12 months). */
  sameMonthLastYear: number | null;
  /** Whole units for next month; null when there is no honest number. */
  forecast: number | null;
  launch: LaunchState;
};

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

export function launchOf(releaseAt: number | null, now: number): LaunchState {
  if (releaseAt === null || !Number.isFinite(releaseAt)) return null;
  if (releaseAt > now) return "upcoming";
  if (now - releaseAt <= FORECAST.launchDays * DAY_MS) return "recent";
  return null;
}

export function forecastOf(input: ForecastInput): ForecastResult {
  const monthly = Array.from({ length: FORECAST.windowMonths }, (_, index) => Math.max(0, Math.floor(finite(input.monthly[index] ?? 0))));
  const launch = launchOf(input.releaseAt, input.now);
  const history = Math.max(0, Math.floor(finite(input.historyMonths)));
  const empty = { movingAverage: null, seasonalIndex: null, sameMonthLastYear: null, forecast: null, launch };
  if (history < FORECAST.minHistoryMonths) return { status: "short_history", ...empty };
  const recent = monthly.slice(-FORECAST.maMonths);
  const recentUnits = recent.reduce((sum, units) => sum + units, 0);
  if (recentUnits === 0) return { status: "no_sales", ...empty };
  const average = recentUnits / FORECAST.maMonths;
  let index: number | null = null;
  let sameMonth: number | null = null;
  if (history >= FORECAST.windowMonths) {
    // next month a year ago = the second oldest of the last 12 full months
    sameMonth = monthly[1];
    const yearAverage = monthly.reduce((sum, units) => sum + units, 0) / FORECAST.windowMonths;
    if (yearAverage > 0) index = Math.min(FORECAST.indexMax, Math.max(FORECAST.indexMin, sameMonth / yearAverage));
  }
  return {
    status: "forecast",
    movingAverage: Math.round(average * 10) / 10,
    seasonalIndex: index === null ? null : Math.round(index * 100),
    sameMonthLastYear: sameMonth,
    forecast: Math.round(average * (index ?? 1)),
    launch,
  };
}

/** "YYYY-MM" of a Baghdad month, `offset` months from the month of `at`. */
export function monthKey(at: number, offset = 0): string {
  const local = new Date(at + 3 * 3_600_000);
  const date = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Epoch ms of 00:00 Baghdad on the first day of the month `offset` months from the month of `at`. */
export function monthStart(at: number, offset = 0): number {
  const local = new Date(at + 3 * 3_600_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1) - 3 * 3_600_000;
}

/** Full Baghdad months among the last 12 before `now`'s month that began after the SKU's first stock movement. */
export function historyMonthsOf(firstAt: number | null, now: number): number {
  if (firstAt === null || !Number.isFinite(firstAt)) return 0;
  let months = 0;
  for (let offset = 1; offset <= FORECAST.windowMonths; offset++) if (monthStart(now, -offset) >= firstAt) months++;
  return months;
}
