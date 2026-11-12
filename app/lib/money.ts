/**
 * Money — client-safe helpers. All stored amounts are INTEGER Iraqi dinars (IQD).
 * Never use floating point for totals: add/multiply integers only.
 *
 * Display currencies other than IQD are approximations for the shopper's convenience.
 * The payable currency is always IQD and the UI must say so wherever a converted
 * amount is shown (see <Price> in the UI kit).
 */
import { LOCALES, type Locale } from "./locales";

export type CurrencyCode = "IQD" | "USD";
export const CURRENCIES: Record<CurrencyCode, { code: CurrencyCode; decimals: number; symbol: Record<Locale, string> }> = {
  IQD: { code: "IQD", decimals: 0, symbol: { ar: "د.ع", en: "IQD", ckb: "د.ع" } },
  USD: { code: "USD", decimals: 2, symbol: { ar: "$", en: "$", ckb: "$" } },
};

export function isCurrency(value: unknown): value is CurrencyCode {
  return value === "IQD" || value === "USD";
}

/** Exchange-rate snapshot handed to the client by the root loader. */
export type FxSnapshot = {
  /** How many IQD one unit of the quote currency costs, e.g. 1 USD = 1310 IQD. Integer. */
  iqdPerUnit: Record<Exclude<CurrencyCode, "IQD">, number>;
  /** Human-readable source label configured in admin (e.g. "TamTam store rate"). */
  source: string;
  /** Epoch ms when the rate was last set. */
  updatedAt: number;
};

export function assertIqd(amount: number): number {
  if (!Number.isSafeInteger(amount)) throw new Error(`Invalid IQD amount: ${amount}`);
  return amount;
}

/** Sum integer IQD amounts; throws on NaN/Infinity/non-integers instead of propagating them. */
export function sumIqd(amounts: readonly number[]): number {
  let total = 0;
  for (const a of amounts) total += assertIqd(a);
  return assertIqd(total);
}

/** Percentage of an IQD amount in basis points (1% = 100 bps), rounded half-up to a whole dinar. */
export function bpsOf(amountIqd: number, bps: number): number {
  assertIqd(amountIqd);
  if (!Number.isSafeInteger(bps)) throw new Error(`Invalid bps: ${bps}`);
  return Math.round((amountIqd * bps) / 10_000);
}

/** IQD prices are shown rounded to 250 (the smallest note in circulation) when configured. */
export function roundToStep(amountIqd: number, step = 250): number {
  return Math.round(assertIqd(amountIqd) / step) * step;
}

/** Convert IQD to a display currency's minor units (e.g. cents). Returns null if no rate. */
export function convertFromIqd(amountIqd: number, to: CurrencyCode, fx: FxSnapshot | null): number | null {
  assertIqd(amountIqd);
  if (to === "IQD") return amountIqd;
  const rate = fx?.iqdPerUnit[to];
  if (!rate || rate <= 0) return null;
  const factor = 10 ** CURRENCIES[to].decimals;
  return Math.round((amountIqd * factor) / rate);
}

export type NumberingSystem = "latn" | "arab";

/** Format an amount given in the currency's minor units. */
export function formatMoney(
  minor: number,
  currency: CurrencyCode,
  locale: Locale,
  numbering: NumberingSystem = "latn",
): string {
  const { decimals, symbol } = CURRENCIES[currency];
  const value = minor / 10 ** decimals;
  const digits = new Intl.NumberFormat(`${LOCALES[locale].bcp47}-u-nu-${numbering}`, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  const sym = symbol[locale];
  if (currency === "USD") return `${sym}${digits}`;
  // The figure first in every language (DESIGN.md §11): "749,000 د.ع", "749,000 IQD" — joined by a no-break space
  // (Design System v2 §2.6) so a figure never ends one line and its currency starts the next.
  return `${digits} ${sym}`;
}
