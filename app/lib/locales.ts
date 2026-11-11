/**
 * Locale registry — the single source of truth for languages, scripts and direction.
 * Client-safe (no server imports).
 *
 * Direction is a property of each locale entry, never inferred from the language:
 * Kurdish is written in Arabic script (Sorani, `ckb`, RTL) in Iraq, but Kurmanji (`kmr`)
 * is commonly written in Latin script (LTR). Add `kmr` here with `dir: "ltr"` when its
 * translation is ready; nothing else needs to change.
 */
export const LOCALES = {
  ar: {
    code: "ar",
    bcp47: "ar-IQ",
    dir: "rtl",
    script: "Arab",
    label: "العربية",
    labelLatin: "Arabic",
    /** URL prefix; the default locale has none. */
    prefix: "",
  },
  en: {
    code: "en",
    bcp47: "en-IQ",
    dir: "ltr",
    script: "Latn",
    label: "English",
    labelLatin: "English",
    prefix: "/en",
  },
  ckb: {
    code: "ckb",
    bcp47: "ckb-IQ",
    dir: "rtl",
    script: "Arab",
    label: "کوردی",
    labelLatin: "Kurdish (Sorani)",
    prefix: "/ckb",
  },
} as const;

export type Locale = keyof typeof LOCALES;
export type Dir = "rtl" | "ltr";
export const DEFAULT_LOCALE: Locale = "ar";
export const LOCALE_CODES = Object.keys(LOCALES) as Locale[];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && value in LOCALES;
}

/** A localized text value stored in the database (JSON column). */
export type L10n = { ar: string; en?: string; ckb?: string };

/** Pick the best available translation; Arabic is always present. */
export function pick(value: L10n | null | undefined, locale: Locale): string {
  if (!value) return "";
  return value[locale] || value.ar || value.en || "";
}

/**
 * Split a pathname into its locale and the locale-less remainder.
 * "/en/cart" → { locale: "en", path: "/cart" } · "/cart" → { locale: "ar", path: "/cart" }
 */
export function splitLocale(pathname: string): { locale: Locale; path: string } {
  const match = /^\/([a-z]{2,3})(?=\/|$)/.exec(pathname);
  if (match && isLocale(match[1]) && match[1] !== DEFAULT_LOCALE) {
    const rest = pathname.slice(match[0].length) || "/";
    return { locale: match[1], path: rest };
  }
  return { locale: DEFAULT_LOCALE, path: pathname || "/" };
}

/**
 * Build a locale-prefixed path. `path` must be locale-less and start with "/". The admin (its language is a
 * cookie, not a URL prefix) and the API never take a prefix, so `<LocaleLink to="/admin/orders">` stays put.
 */
export function localePath(path: string, locale: Locale): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (/^\/(admin|api)(?=[/?#]|$)/.test(clean)) return clean;
  const prefix = LOCALES[locale].prefix;
  if (!prefix) return clean;
  return clean === "/" ? prefix : `${prefix}${clean}`;
}

/** Same page in another language (keeps search and hash). */
export function switchLocalePath(pathname: string, search: string, hash: string, to: Locale): string {
  const { path } = splitLocale(pathname);
  return `${localePath(path, to)}${search}${hash}`;
}
