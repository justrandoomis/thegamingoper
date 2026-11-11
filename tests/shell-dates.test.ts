/**
 * Dates for people (app/lib/dates.ts — what useFormat().date / .dateTime print).
 *
 * Sorani is assembled by hand because the ICU of Chromium and of workerd has no Kurdish data (Intl falls back to
 * English month names on a Kurdish page). Node's full ICU does carry CLDR's Sorani data, so where it is available the
 * hand-made text is compared with it (one deliberate difference: December is spelled like January).
 */
import { describe, expect, it } from "vitest";
import { BAGHDAD_OFFSET_MS, CKB_MONTHS, CKB_WEEKDAYS, formatDate, formatDateTime, formatWeekday, formatWeekdayDay, type DateStyle } from "~/lib/dates";
import type { NumberingSystem } from "~/lib/money";

/** An instant given as Baghdad wall-clock time (UTC+3). */
const baghdad = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour, minute) - BAGHDAD_OFFSET_MS;

const LATIN = /[A-Za-z]/;

describe("Sorani dates", () => {
  it("names every month in Sorani, never in English", () => {
    for (let month = 1; month <= 12; month++) {
      const ms = baghdad(2026, month, 15);
      for (const style of ["short", "medium", "long"] as DateStyle[]) expect(formatDate(ms, style, "ckb", "latn"), `${month} ${style}`).not.toMatch(LATIN);
      expect(formatDate(ms, "long", "ckb", "latn")).toBe(`15ی ${CKB_MONTHS[month - 1]}ی 2026`);
      expect(formatDate(ms, "medium", "ckb", "latn")).toBe(`2026 ${CKB_MONTHS[month - 1]} 15`);
    }
    expect(CKB_MONTHS).toEqual(["کانوونی دووەم", "شوبات", "ئازار", "نیسان", "ئایار", "حوزەیران", "تەمووز", "ئاب", "ئەیلوول", "تشرینی یەکەم", "تشرینی دووەم", "کانوونی یەکەم"]);
  });

  it("follows CLDR's Sorani patterns: short, medium, long, and date with time", () => {
    const ms = baghdad(2026, 11, 13, 15, 5);
    expect(formatDate(ms, "short", "ckb", "latn")).toBe("13/11/2026");
    expect(formatDate(ms, "medium", "ckb", "latn")).toBe("2026 تشرینی دووەم 13");
    expect(formatDate(ms, "long", "ckb", "latn")).toBe("13ی تشرینی دووەمی 2026");
    expect(formatDateTime(ms, "ckb", "latn")).toBe("2026 تشرینی دووەم 13 3:05 د.ن");
    expect(formatDate(baghdad(2027, 1, 5), "short", "ckb", "latn")).toBe("05/01/2027");
  });

  it("writes the shopper's numerals", () => {
    const ms = baghdad(2026, 1, 5, 9, 7);
    expect(formatDate(ms, "long", "ckb", "arab")).toBe("٥ی کانوونی دووەمی ٢٠٢٦");
    expect(formatDate(ms, "short", "ckb", "arab")).toBe("٠٥/٠١/٢٠٢٦");
    expect(formatDateTime(ms, "ckb", "arab")).toBe("٢٠٢٦ کانوونی دووەم ٥ ٩:٠٧ ب.ن");
    expect(formatDate(ms, "medium", "ckb", "arab")).not.toMatch(/[0-9]/);
  });

  it("reads the day and the hour on Iraq's clock, with a 12-hour clock like CLDR", () => {
    // 21:30 UTC on 4 January is 00:30 on 5 January in Baghdad
    const lateUtc = Date.UTC(2026, 0, 4, 21, 30);
    expect(formatDate(lateUtc, "long", "ckb", "latn")).toBe("5ی کانوونی دووەمی 2026");
    expect(formatDateTime(lateUtc, "ckb", "latn")).toBe("2026 کانوونی دووەم 5 12:30 ب.ن");
    expect(formatDateTime(baghdad(2026, 1, 5, 12, 0), "ckb", "latn")).toBe("2026 کانوونی دووەم 5 12:00 د.ن");
    expect(formatDateTime(baghdad(2026, 1, 5, 23, 59), "ckb", "latn")).toBe("2026 کانوونی دووەم 5 11:59 د.ن");
    // the last day of the year, at its last minute in Baghdad
    expect(formatDate(baghdad(2026, 12, 31, 23, 59), "long", "ckb", "latn")).toBe("31ی کانوونی یەکەمی 2026");
  });

  it("names a day to choose with its weekday", () => {
    // 2026-11-15 is a Sunday
    expect(formatWeekday(baghdad(2026, 11, 15), "ckb")).toBe("یەکشەممە");
    expect(formatWeekdayDay(baghdad(2026, 11, 15), "ckb", "latn")).toBe("یەکشەممە، 15ی تشرینی دووەم");
    // a calendar day kept as midnight UTC is read on the UTC clock
    expect(formatWeekdayDay(Date.UTC(2026, 10, 20), "ckb", "latn", { timeZone: "UTC" })).toBe("ھەینی، 20ی تشرینی دووەم");
    expect(CKB_WEEKDAYS.length).toBe(7);
  });
});

describe("numeric dates are day first in every language (Design System v2 §2.6)", () => {
  const ms = baghdad(2026, 11, 13, 15, 5);
  const BIDI_MARKS = /[‎‏؜]/;
  it("short everywhere, and Arabic medium, print dd/MM/y with no bidi marks", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      expect(formatDate(ms, "short", locale, "latn")).toBe("13/11/2026");
      expect(formatDate(ms, "short", locale, "arab")).toBe("١٣/١١/٢٠٢٦");
    }
    expect(formatDate(ms, "medium", "ar", "latn")).toBe("13/11/2026");
    expect(formatDate(baghdad(2027, 1, 5), "medium", "ar", "latn")).toBe("05/01/2027");
    expect(formatDate(ms, "medium", "ar", "arab")).not.toMatch(BIDI_MARKS);
  });
  it("Arabic date and time: the numeric date, then Intl's time", () => {
    for (const numbering of ["latn", "arab"] as NumberingSystem[]) {
      const time = new Intl.DateTimeFormat(`ar-IQ-u-nu-${numbering}`, { timeStyle: "short", timeZone: "Asia/Baghdad" }).format(ms);
      expect(formatDateTime(ms, "ar", numbering)).toBe(`${numbering === "arab" ? "١٣/١١/٢٠٢٦" : "13/11/2026"}، ${time}`);
    }
    expect(formatDateTime(ms, "ar", "latn")).toMatch(/^13\/11\/2026، /);
  });
});

describe("dates with a month name go through Intl in Arabic and English", () => {
  const ms = baghdad(2026, 11, 13, 15, 5);
  it("prints what Intl prints, in Iraq time", () => {
    for (const numbering of ["latn", "arab"] as NumberingSystem[]) {
      expect(formatDate(ms, "long", "ar", numbering)).toBe(new Intl.DateTimeFormat(`ar-IQ-u-nu-${numbering}`, { dateStyle: "long", timeZone: "Asia/Baghdad" }).format(ms));
      for (const style of ["medium", "long"] as DateStyle[]) {
        expect(formatDate(ms, style, "en", numbering)).toBe(new Intl.DateTimeFormat(`en-IQ-u-nu-${numbering}`, { dateStyle: style, timeZone: "Asia/Baghdad" }).format(ms));
      }
      expect(formatDateTime(ms, "en", numbering)).toBe(new Intl.DateTimeFormat(`en-IQ-u-nu-${numbering}`, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Baghdad" }).format(ms));
    }
    expect(formatDate(ms, "long", "en", "latn")).toBe("November 13, 2026");
  });
});

/** Node ships full ICU (with CLDR's Sorani); some builds do not — then this comparison is skipped. */
const icuHasSorani = new Intl.DateTimeFormat("ckb").resolvedOptions().locale.startsWith("ckb");

describe.skipIf(!icuHasSorani)("Sorani matches CLDR as a full ICU prints it", () => {
  // CLDR spells December "کانونی یەکەم"; we spell it like January
  const cldr = (text: string) => text.replace("کانونی یەکەم", "کانوونی یەکەم");

  it("for every month, style, numeral system and both halves of the day", () => {
    for (let month = 1; month <= 12; month++) {
      for (const [day, hour, minute] of [
        [1, 0, 5],
        [9, 11, 59],
        [28, 12, 0],
        [17, 21, 45],
      ]) {
        const ms = baghdad(2025, month, day, hour, minute);
        for (const numbering of ["latn", "arab"] as NumberingSystem[]) {
          const tag = `ckb-IQ-u-nu-${numbering}`;
          // "short" is left out: numeric dates are day first by design (CLDR's Sorani "y-MM-dd" is year first)
          for (const style of ["medium", "long"] as DateStyle[]) {
            const icu = cldr(new Intl.DateTimeFormat(tag, { dateStyle: style, timeZone: "Asia/Baghdad" }).format(ms));
            expect(formatDate(ms, style, "ckb", numbering), `${month}/${day} ${style} ${numbering}`).toBe(icu);
          }
          const icu = cldr(new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Baghdad" }).format(ms));
          expect(formatDateTime(ms, "ckb", numbering), `${month}/${day} ${hour}:${minute} ${numbering}`).toBe(icu);
          const weekdayDay = cldr(new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Baghdad" }).format(ms));
          expect(formatWeekdayDay(ms, "ckb", numbering)).toBe(weekdayDay);
        }
      }
    }
  });
});
