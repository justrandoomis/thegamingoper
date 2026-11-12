/**
 * Dates for people — the formatting behind `useFormat().date` / `.dateTime` (client-safe, pure; ~/i18n/react).
 * Always Iraq time: Asia/Baghdad is UTC+3 all year (no daylight saving since 2008), so its wall clock is ms + 3 h.
 *
 * EVERY DATE IS DAY FIRST (Design System v2 §2.6 and §10), in every language:
 *   formatDate(ms, "short" | "medium", "ar")   → "05/01/2025" (numeric, no bidi marks — one left-to-right run)
 *   formatDate(ms, "long", "ar", "latn")       → Intl's Arabic ("5 كانون الثاني 2025")
 *   formatDate(ms, "medium" | "long", "en")    → "5 Jan 2025" / "5 January 2025" (Intl's en-IQ is month first)
 *   formatDate(ms, "medium" | "long", "ckb")   → "5ی کانوونی دووەمی 2025"
 *   formatDateTime(ms, "ckb", "arab")          → "٥ی کانوونی دووەمی ٢٠٢٥، ٣:٠٠ د.ن"
 *   formatDateTime(ms, "en", "latn")           → "5 Jan 2025, 3:00 PM"
 *   formatWeekdayDay(ms, "ckb", "latn")        → "یەکشەممە، 5ی کانوونی دووەم"   (a day to choose: weekday + date)
 *
 * WHY SORANI AND ENGLISH ARE DONE BY HAND: Kurdish (ckb) is missing from the ICU builds of Chromium and of workerd
 * (the server), so Intl answers a Kurdish page in English ("November 13, 2026"); and English through Intl is month
 * first. Text built here is the same on the server and in every browser, so it hydrates unchanged. Sorani uses
 * CLDR's names and its long pattern "dی MMMMی y" for medium and long (CLDR's medium "y MMM d" is year first), its
 * date and time "…، h:mm a" (ب.ن / د.ن), weekday + day "EEEE، dی MMMM"; short is the shared numeric "dd/MM/y".
 * One difference from CLDR on purpose: December is "کانوونی یەکەم", spelled like January ("کانوونی دووەم"); CLDR
 * writes "کانونی یەکەم". The same code runs on the server and in the browser, so Kurdish dates hydrate unchanged.
 * The Sorani names and patterns still need a native reader (docs/STATUS.md).
 */
import { LOCALES, type Locale } from "./locales";
import type { NumberingSystem } from "./money";

export type DateStyle = "short" | "medium" | "long";

/** Asia/Baghdad's offset from UTC (no daylight saving). */
export const BAGHDAD_OFFSET_MS = 3 * 3_600_000;

/** Gregorian month names in Sorani, January first (CLDR "ckb", December spelled like January). */
export const CKB_MONTHS = [
  "کانوونی دووەم",
  "شوبات",
  "ئازار",
  "نیسان",
  "ئایار",
  "حوزەیران",
  "تەمووز",
  "ئاب",
  "ئەیلوول",
  "تشرینی یەکەم",
  "تشرینی دووەم",
  "کانوونی یەکەم",
] as const;

/** Weekday names in Sorani, Sunday first (the order of Date#getUTCDay; CLDR "ckb"). */
export const CKB_WEEKDAYS = ["یەکشەممە", "دووشەممە", "سێشەممە", "چوارشەممە", "پێنجشەممە", "ھەینی", "شەممە"] as const;

/** Before noon / after noon (CLDR "ckb" abbreviated day periods). */
const CKB_AM = "ب.ن";
const CKB_PM = "د.ن";

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

/** Digits of a whole number in the chosen numerals, zero-padded to `length`; no grouping (years, days, minutes). */
function digits(value: number, numbering: NumberingSystem, length = 1): string {
  const text = String(Math.trunc(Math.abs(value))).padStart(length, "0");
  return numbering === "arab" ? text.replace(/[0-9]/g, (digit) => ARABIC_INDIC[Number(digit)]) : text;
}

type WallClock = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

/** The calendar fields of an instant on a clock `offsetMs` ahead of UTC. */
function wallClock(ms: number, offsetMs: number): WallClock {
  const date = new Date(ms + offsetMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

const intlTag = (locale: Locale, numbering: NumberingSystem) => `${LOCALES[locale].bcp47}-u-nu-${numbering}`;

/**
 * A numeric date, day first in every language: "18/11/2026" (Design System v2 §2.6 — never 2026/11/18). Built by
 * hand: Intl orders English month first ("11/18/26"), and in Arabic it puts a right-to-left mark after each part,
 * which shows the date year first on screen. Without marks the date is one left-to-right run inside Arabic text.
 */
function numericDate(clock: WallClock, numbering: NumberingSystem): string {
  return `${digits(clock.day, numbering, 2)}/${digits(clock.month, numbering, 2)}/${digits(clock.year, numbering)}`;
}

function soraniDate(clock: WallClock, style: DateStyle, numbering: NumberingSystem): string {
  const year = digits(clock.year, numbering);
  const month = CKB_MONTHS[clock.month - 1];
  switch (style) {
    case "short":
      return numericDate(clock, numbering);
    case "medium":
    case "long":
      // Day first (Design System v2 §2.6). CLDR's Sorani medium "y MMM d" is year first; the long form reads right.
      return `${digits(clock.day, numbering)}ی ${month}ی ${year}`;
  }
}

const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** English dates day first, as in Iraq and Britain ("13 Nov 2026", "13 November 2026"); Intl's en-IQ is month first. */
function englishDate(clock: WallClock, style: "medium" | "long", numbering: NumberingSystem): string {
  const month = EN_MONTHS[clock.month - 1];
  return `${digits(clock.day, numbering)} ${style === "medium" ? month.slice(0, 3) : month} ${digits(clock.year, numbering)}`;
}

/** "3:05 PM" — built by hand so the server and every browser print the same text. */
function englishTime(clock: WallClock, numbering: NumberingSystem): string {
  const hour = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
  return `${digits(hour, numbering)}:${digits(clock.minute, numbering, 2)} ${clock.hour < 12 ? "AM" : "PM"}`;
}

/**
 * A date in the page's language and numerals, in Iraq time. Numeric styles — "short" everywhere, and Arabic
 * "medium" (Arabic has no short month names) — are day first, built by hand (numericDate); dates with a month name
 * come from Intl (Arabic and English) or from CLDR's Sorani patterns.
 */
export function formatDate(ms: number, style: DateStyle, locale: Locale, numbering: NumberingSystem): string {
  if (style === "short" || (style === "medium" && locale === "ar")) return numericDate(wallClock(ms, BAGHDAD_OFFSET_MS), numbering);
  if (locale === "ckb") return soraniDate(wallClock(ms, BAGHDAD_OFFSET_MS), style, numbering);
  if (locale === "en") return englishDate(wallClock(ms, BAGHDAD_OFFSET_MS), style, numbering);
  return new Intl.DateTimeFormat(intlTag(locale, numbering), { dateStyle: style, timeZone: "Asia/Baghdad" }).format(ms);
}

/** A date (medium) with its time (hours and minutes), in Iraq time. */
export function formatDateTime(ms: number, locale: Locale, numbering: NumberingSystem): string {
  if (locale === "ckb") {
    const clock = wallClock(ms, BAGHDAD_OFFSET_MS);
    const hour = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
    return `${soraniDate(clock, "medium", numbering)}، ${digits(hour, numbering)}:${digits(clock.minute, numbering, 2)} ${clock.hour < 12 ? CKB_AM : CKB_PM}`;
  }
  if (locale === "ar") {
    // the numeric date (day first, no bidi marks), then Intl's time with its ص / م
    const time = new Intl.DateTimeFormat(intlTag(locale, numbering), { timeStyle: "short", timeZone: "Asia/Baghdad" }).format(ms);
    return `${numericDate(wallClock(ms, BAGHDAD_OFFSET_MS), numbering)}، ${time}`;
  }
  const clock = wallClock(ms, BAGHDAD_OFFSET_MS);
  return `${englishDate(clock, "medium", numbering)}, ${englishTime(clock, numbering)}`;
}

export type CalendarDayOptions = {
  /**
   * The clock the instant is read on: "Asia/Baghdad" (default) for real instants; "UTC" for calendar days kept as
   * midnight UTC (`Date.UTC(y, m, d)`, e.g. "YYYY-MM-DD" choices).
   */
  timeZone?: "Asia/Baghdad" | "UTC";
};

/** The weekday's name alone ("الأحد", "Sunday", "یەکشەممە"). */
export function formatWeekday(ms: number, locale: Locale, options: CalendarDayOptions = {}): string {
  const timeZone = options.timeZone ?? "Asia/Baghdad";
  if (locale === "ckb") return CKB_WEEKDAYS[wallClock(ms, timeZone === "UTC" ? 0 : BAGHDAD_OFFSET_MS).weekday];
  if (locale === "en") return EN_WEEKDAYS[wallClock(ms, timeZone === "UTC" ? 0 : BAGHDAD_OFFSET_MS).weekday];
  return new Intl.DateTimeFormat(intlTag(locale, "latn"), { weekday: "long", timeZone }).format(ms);
}

/** A day to choose or to come on: weekday, day and month ("الأحد، 5 كانون الثاني", "Sunday, January 5", "یەکشەممە، 5ی کانوونی دووەم"). */
export function formatWeekdayDay(ms: number, locale: Locale, numbering: NumberingSystem, options: CalendarDayOptions = {}): string {
  const timeZone = options.timeZone ?? "Asia/Baghdad";
  if (locale === "ckb") {
    const clock = wallClock(ms, timeZone === "UTC" ? 0 : BAGHDAD_OFFSET_MS);
    return `${CKB_WEEKDAYS[clock.weekday]}، ${digits(clock.day, numbering)}ی ${CKB_MONTHS[clock.month - 1]}`;
  }
  if (locale === "en") {
    const clock = wallClock(ms, timeZone === "UTC" ? 0 : BAGHDAD_OFFSET_MS);
    return `${EN_WEEKDAYS[clock.weekday]}, ${digits(clock.day, numbering)} ${EN_MONTHS[clock.month - 1]}`;
  }
  return new Intl.DateTimeFormat(intlTag(locale, numbering), { weekday: "long", day: "numeric", month: "long", timeZone }).format(ms);
}
