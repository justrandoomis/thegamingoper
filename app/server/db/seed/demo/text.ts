/**
 * Seed text always carries all three storefront languages (Arabic is the source; English and
 * Kurdish Sorani are written alongside it, never machine-filled at runtime).
 */
import type { L10n } from "~/lib/locales";

export type T3 = { ar: string; en: string; ckb: string };

export const SEED_LOCALES = ["ar", "en", "ckb"] as const;
export type SeedLocale = (typeof SEED_LOCALES)[number];

/** Arabic, English, Kurdish (Sorani) — in that order everywhere in the seed. */
export const t3 = (ar: string, en: string, ckb: string): T3 => ({ ar, en, ckb });

/** Product and brand names that are written the same way in every language. */
export const same = (text: string): T3 => ({ ar: text, en: text, ckb: text });

/** Joins localized fragments with a separator, per language. */
export function joinT3(parts: ReadonlyArray<T3 | L10n | null | undefined>, separator = " "): T3 {
  const pick = (locale: SeedLocale) =>
    parts
      .map((part) => (part ? (part[locale] ?? part.ar) : ""))
      .filter(Boolean)
      .join(separator);
  return { ar: pick("ar"), en: pick("en"), ckb: pick("ckb") };
}
