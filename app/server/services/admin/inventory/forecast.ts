/**
 * Reorder point, days of cover and the stock-out forecast (04.06) — pure arithmetic over REAL sales, with no database.
 *
 *   const rate = salesRate({ unitsSold: 12, windowDays: 30, historyDays: 90 });   // { perDay: 0.4, days: 30, basis: "sales" }
 *   const plan = coverPlan({ available: 8, incoming: 0, reorderPoint: 5, reorderQty: null, rate, now });
 *
 * Rules (a forecast is not a fact — the page always shows the inputs beside it):
 *   · The rate is units that actually left in sales ('sale' movements) per day over the window, counted from the
 *     variant's first stock movement when that is more recent than the window start.
 *   · Fewer than MIN_HISTORY_DAYS days of history, or no sale at all in the window → no rate, no days of cover and no
 *     stock-out date: the honest answer is "not enough history", never infinity and never zero.
 *   · Days of cover = available ÷ rate, rounded down. The stock-out date is today + days of cover.
 *   · Suggested quantity = the reorder quantity set by staff, or else enough for TARGET_COVER_DAYS at the rate minus
 *     what is available and on the way; null when there is no rate and no reorder quantity.
 */

export const MIN_HISTORY_DAYS = 7;
export const TARGET_COVER_DAYS = 30;
/** Days of cover at or below which a variant is flagged as running out soon. */
export const SOON_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SalesRate =
  | { basis: "sales"; perDay: number; unitsSold: number; days: number }
  | { basis: "no_sales"; perDay: null; unitsSold: 0; days: number }
  | { basis: "too_little_history"; perDay: null; unitsSold: number; days: number };

/**
 * Sales per day over the last `windowDays`, limited to the days the variant has existed in stock (`historyDays`:
 * days since its first stock movement; null = never had stock).
 */
export function salesRate(input: { unitsSold: number; windowDays: number; historyDays: number | null }): SalesRate {
  const unitsSold = Math.max(0, Math.floor(Number.isFinite(input.unitsSold) ? input.unitsSold : 0));
  const history = input.historyDays === null || !Number.isFinite(input.historyDays) ? 0 : Math.max(0, input.historyDays);
  const days = Math.min(input.windowDays, Math.floor(history));
  if (days < MIN_HISTORY_DAYS) return { basis: "too_little_history", perDay: null, unitsSold, days };
  if (unitsSold === 0) return { basis: "no_sales", perDay: null, unitsSold: 0, days };
  return { basis: "sales", perDay: unitsSold / days, unitsSold, days };
}

export type CoverStatus = "out" | "below_reorder" | "soon" | "ok" | "no_forecast";

export type CoverPlan = {
  status: CoverStatus;
  /** Whole days the available stock lasts at the rate; null without a rate. */
  daysOfCover: number | null;
  /** Epoch ms of the day it runs out; null without a rate. */
  stockOutAt: number | null;
  /** Units to order now; null when nothing can be suggested honestly. */
  suggestedQty: number | null;
  /** Below (or at) the reorder point, counting what is on the way. */
  belowReorder: boolean;
};

export function coverPlan(input: { available: number; incoming: number; reorderPoint: number | null; reorderQty: number | null; rate: SalesRate; now: number }): CoverPlan {
  const available = Math.max(0, Math.floor(input.available));
  const incoming = Math.max(0, Math.floor(input.incoming));
  const belowReorder = input.reorderPoint !== null && available + incoming <= input.reorderPoint;
  const perDay = input.rate.perDay;
  const daysOfCover = perDay !== null && perDay > 0 ? Math.floor(available / perDay) : null;
  const stockOutAt = daysOfCover === null ? null : input.now + daysOfCover * DAY_MS;

  let suggestedQty: number | null = null;
  if (input.reorderQty !== null && input.reorderQty > 0) {
    suggestedQty = belowReorder || (daysOfCover !== null && daysOfCover <= SOON_DAYS) || available === 0 ? input.reorderQty : 0;
  } else if (perDay !== null && perDay > 0) {
    suggestedQty = Math.max(0, Math.ceil(TARGET_COVER_DAYS * perDay) - available - incoming);
  }

  let status: CoverStatus;
  if (available === 0) status = "out";
  else if (belowReorder) status = "below_reorder";
  else if (daysOfCover === null) status = "no_forecast";
  else if (daysOfCover <= SOON_DAYS) status = "soon";
  else status = "ok";
  return { status, daysOfCover, stockOutAt, suggestedQty, belowReorder };
}
