/**
 * Client-safe i18n hooks. Messages arrive through route loader data under the `i18n` key
 * (see i18n.server.ts → messagesFor); the root loader always provides the "common" namespace.
 *
 *   const t = useT("checkout");
 *   t("title")                      → "إتمام الطلب"
 *   t("items", { count: 3 })        → plural-aware
 *   const f = useFormat();
 *   f.money(749000)                 → "749,000 د.ع" (or the shopper's display currency, marked approximate by <Price>)
 *   <LocaleLink to="/cart">         → "/cart", "/en/cart" or "/ckb/cart" + prefetch on intent
 */
import { useMemo } from "react";
import { Link, NavLink, useMatches, useRouteLoaderData, type LinkProps, type NavLinkProps } from "react-router";
import { formatDate, formatDateTime, type DateStyle } from "~/lib/dates";
import { DEFAULT_LOCALE, LOCALES, localePath, type Dir, type Locale } from "~/lib/locales";
import { convertFromIqd, formatMoney, type CurrencyCode, type FxSnapshot, type NumberingSystem } from "~/lib/money";
import { formatIraqPhone } from "~/lib/phone";
import { usePrefs } from "~/lib/prefs";
import { makeT, type MessageTree, type TFunction } from "./translate";

/** The part of the root loader's data that i18n relies on. Keep in sync with app/root.tsx. */
export type RootI18nData = {
  locale: Locale;
  dir: Dir;
  fx: FxSnapshot | null;
  i18n: Record<string, MessageTree>;
};

function useRoot(): RootI18nData | undefined {
  return useRouteLoaderData("root") as RootI18nData | undefined;
}

export function useLocale(): Locale {
  return useRoot()?.locale ?? DEFAULT_LOCALE;
}

export function useDir(): Dir {
  return LOCALES[useLocale()].dir;
}

/** Translation function for one namespace. The namespace must be returned by a matched route's loader. */
export function useT(namespace: string): TFunction {
  const matches = useMatches();
  const locale = useLocale();
  return useMemo(() => {
    let tree: MessageTree | undefined;
    for (let i = matches.length - 1; i >= 0 && !tree; i--) {
      const data = matches[i].loaderData as { i18n?: Record<string, MessageTree> } | undefined;
      tree = data?.i18n?.[namespace];
    }
    return makeT(tree, locale, namespace);
  }, [matches, locale, namespace]);
}

/** Returns a function that prefixes locale-less paths with the active locale. */
export function useLocalePath(): (path: string) => string {
  const locale = useLocale();
  return useMemo(() => (path: string) => localePath(path, locale), [locale]);
}

type ToProp = { to: string };

/** <Link> that keeps the shopper in their language and prefetches on hover/focus/touch. */
export function LocaleLink({ to, prefetch = "intent", ...rest }: Omit<LinkProps, "to"> & ToProp) {
  const href = useLocalePath();
  return <Link to={/^(https?:|mailto:|tel:|#)/.test(to) ? to : href(to)} prefetch={prefetch} {...rest} />;
}

export function LocaleNavLink({ to, prefetch = "intent", ...rest }: Omit<NavLinkProps, "to"> & ToProp) {
  const href = useLocalePath();
  return <NavLink to={href(to)} prefetch={prefetch} {...rest} />;
}

export type Formatters = {
  locale: Locale;
  currency: CurrencyCode;
  numbering: NumberingSystem;
  /** Format an IQD amount in the shopper's display currency. `approx` is true when converted from IQD. */
  money: (amountIqd: number) => string;
  moneyParts: (amountIqd: number) => { text: string; approx: boolean; currency: CurrencyCode };
  /** Always IQD — use for totals the shopper actually pays. */
  iqd: (amountIqd: number) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  percent: (ratio: number) => string;
  /** Iraq time. Sorani months and patterns come from ~/lib/dates (the browsers' ICU has no Kurdish data). */
  date: (epochMs: number, style?: DateStyle) => string;
  dateTime: (epochMs: number) => string;
  relative: (epochMs: number, nowMs?: number) => string;
  phone: (e164: string) => string;
};

/** Locale-, currency- and numeral-aware formatters. Dates are shown in Iraq time (Asia/Baghdad). */
export function useFormat(): Formatters {
  const root = useRoot();
  const locale = root?.locale ?? DEFAULT_LOCALE;
  const fx = root?.fx ?? null;
  const { currency, numbering } = usePrefs();
  return useMemo(() => {
    const tag = `${LOCALES[locale].bcp47}-u-nu-${numbering}`;
    const iqd = (amount: number) => formatMoney(amount, "IQD", locale, numbering);
    const moneyParts = (amount: number) => {
      const converted = currency === "IQD" ? null : convertFromIqd(amount, currency, fx);
      if (converted === null) return { text: iqd(amount), approx: false, currency: "IQD" as CurrencyCode };
      return { text: formatMoney(converted, currency, locale, numbering), approx: true, currency };
    };
    return {
      locale,
      currency,
      numbering,
      iqd,
      moneyParts,
      money: (amount) => moneyParts(amount).text,
      number: (value, options) => new Intl.NumberFormat(tag, options).format(value),
      percent: (ratio) => new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 1 }).format(ratio),
      date: (ms, style = "medium") => formatDate(ms, style, locale, numbering),
      dateTime: (ms) => formatDateTime(ms, locale, numbering),
      relative: (ms, nowMs = Date.now()) => {
        const rtf = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
        const diff = ms - nowMs;
        const abs = Math.abs(diff);
        if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
        if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
        if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
        return rtf.format(Math.round(diff / 86_400_000), "day");
      },
      phone: formatIraqPhone,
    };
  }, [locale, currency, numbering, fx]);
}
