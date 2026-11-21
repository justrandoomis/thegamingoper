/**
 * The builder's figures as the shopper reads them (client-safe). Sizes are bytes everywhere and shown as the console
 * shows them: «GB» = bytes / 1024³ with one decimal (two when one decimal would print the same figure for two
 * different sizes: ~/lib/switch-builder/storage digitsToTell). eShop prices are US dollars, labelled as eShop prices
 * where they are shown. Each figure is a first-strong isolate inside its sentence, its unit joined by a no-break
 * space, so «16.5 GB» and «$59.99» never split or reorder in Arabic and Sorani text.
 */
import { useT, type Formatters } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import { formatMoney } from "~/lib/money";
import { GIB, toGiB } from "~/lib/switch-builder/storage";
import { isolate } from "~/ui/BidiText";

const NBSP = " ";

/** «16.5 GB» — one decimal by default (the console's own rounding, half up). */
export function gbText(f: Pick<Formatters, "number">, bytes: number, digits: 0 | 1 | 2 = 1): string {
  const value = digits === 0 ? Math.floor(bytes / GIB) : toGiB(bytes, digits);
  return isolate(`${f.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${NBSP}GB`);
}

/**
 * A shortfall («تنقص 4.1 GB»): rounded UP, so it is never understated, with two decimals under 0.1 GB (a game 40 MB
 * too big says «0.04 GB», never «0.0 GB»); at least 0.01 GB.
 */
export function shortfallText(f: Pick<Formatters, "number">, bytes: number): string {
  const digits = bytes < 0.1 * GIB ? 2 : 1;
  const factor = 10 ** digits;
  // (a millionth of a step forgiven: a figure typed in GB, stored as whole bytes, lands a hair above itself)
  const value = Math.max(1, Math.ceil((bytes / GIB) * factor - 1e-6)) / factor;
  return isolate(`${f.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${NBSP}GB`);
}

/** «≈ 223 GB» — whole GB, rounded down (a space figure is never rounded up). */
export function approxGbText(f: Pick<Formatters, "number">, bytes: number): string {
  return isolate(`≈${NBSP}${f.number(Math.floor(bytes / GIB))}${NBSP}GB`);
}

/** «$59.99» — an eShop (US) price in US cents. */
export function usdText(f: Pick<Formatters, "locale" | "numbering">, cents: number): string {
  return isolate(formatMoney(cents, "USD", f.locale, f.numbering));
}

/** A card's label size: «256GB», «1TB» (decimal, as printed on the card). */
export function cardLabel(sizeGB: number): string {
  return sizeGB >= 1000 ? `${sizeGB / 1000}TB` : `${sizeGB}GB`;
}

/** The builder's strings (app/i18n/messages/switch-builder.ts). */
export function useBuilderT(): TFunction {
  return useT("switch-builder");
}
