/**
 * Small client-safe helpers of the device hub.
 */
import type { Formatters } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import { isPlatform, type Platform } from "~/ui/PlatformLed";

/** Research dates are calendar days ("2025-06-05"), months ("2025-06") or years ("2017"). */
export type ResearchDate = { kind: "day" | "month" | "year"; text: string; year: string };

/**
 * Gregorian month names in Sorani (CLDR "ckb"). The browsers' and workerd's ICU builds carry no Sorani calendar data,
 * so Intl falls back to English month names on a Kurdish page; these are used instead. Native review pending.
 */
const CKB_MONTHS = ["کانوونی دووەم", "شوبات", "ئازار", "نیسان", "ئایار", "حوزەیران", "تەمووز", "ئاب", "ئەیلوول", "تشرینی یەکەم", "تشرینی دووەم", "کانوونی یەکەم"] as const;

/** A research date in the page's language and numerals (Baghdad calendar). Null when it is not one of the three shapes. */
export function researchDate(value: string | null | undefined, f: Formatters): ResearchDate | null {
  if (!value) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const tag = `${LOCALES[f.locale].bcp47}-u-nu-${f.numbering}`;
  if (f.locale === "ckb") {
    const parts = day ?? /^(\d{4})-(\d{2})$/.exec(value);
    const month = parts ? CKB_MONTHS[Number(parts[2]) - 1] : undefined;
    if (parts && month) {
      const year = f.number(Number(parts[1]), { useGrouping: false });
      return day ? { kind: "day", text: `${f.number(Number(day[3]))}ی ${month} ${year}`, year } : { kind: "month", text: `${month} ${year}`, year };
    }
  }
  if (day) {
    // noon UTC is the same calendar day in Baghdad (UTC+3)
    const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12);
    return { kind: "day", text: f.date(ms, "long"), year: f.number(Number(day[1]), { useGrouping: false }) };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) {
    const ms = Date.UTC(Number(month[1]), Number(month[2]) - 1, 15, 12);
    return { kind: "month", text: new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "Asia/Baghdad" }).format(ms), year: f.number(Number(month[1]), { useGrouping: false }) };
  }
  const year = /^(\d{4})$/.exec(value);
  if (year) {
    const text = f.number(Number(year[1]), { useGrouping: false });
    return { kind: "year", text, year: text };
  }
  return null;
}

/** The platform light for a platform's accent token ("nintendo", …); null for anything else (no light). */
export function gelOf(accent: string | null | undefined): Platform | null {
  return isPlatform(accent) ? accent : null;
}

/** First-strong isolate around a Latin name inside Arabic or Sorani text (U+2068 … U+2069). */
export const isolate = (text: string) => `⁨${text}⁩`;

/** Section ids of the hub, in page order (anchors of the sticky section keys). */
export const HUB_SECTIONS = ["versions", "setup", "compare", "specs", "accessories", "games", "help", "faq", "used"] as const;
export type HubSectionId = (typeof HUB_SECTIONS)[number];

/**
 * A jumped-to section stops below the sticky section keys: the shell's scroll-padding already clears the header
 * (`:root:has(.shell)`), this margin adds the 52px row of keys and a little air.
 */
export const SECTION_SCROLL_MARGIN = "scroll-mt-16";
