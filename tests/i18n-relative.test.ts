import { describe, expect, it } from "vitest";

import { soraniRelative } from "~/i18n/react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("soraniRelative — Sorani relative times by hand (no Intl data for ckb)", () => {
  it("reads «ئێستا» under a minute, either way", () => {
    expect(soraniRelative(0, "latn")).toBe("ئێستا");
    expect(soraniRelative(-59_000, "arab")).toBe("ئێستا");
    expect(soraniRelative(59_000, "arab")).toBe("ئێستا");
  });

  it("writes minutes, hours and days ago, in the numbering asked for", () => {
    expect(soraniRelative(-46 * MINUTE, "latn")).toBe("46 خولەک لەمەوبەر");
    expect(soraniRelative(-46 * MINUTE, "arab")).toBe("٤٦ خولەک لەمەوبەر");
    expect(soraniRelative(-3 * HOUR, "arab")).toBe("٣ کاتژمێر لەمەوبەر");
    expect(soraniRelative(-5 * DAY, "latn")).toBe("5 ڕۆژ لەمەوبەر");
  });

  it("says yesterday and tomorrow for one day, and «دوای …» for the future", () => {
    expect(soraniRelative(-DAY, "arab")).toBe("دوێنێ");
    expect(soraniRelative(DAY, "arab")).toBe("سبەینێ");
    expect(soraniRelative(2 * HOUR, "latn")).toBe("دوای 2 کاتژمێر");
  });

  it("is the same on the server and in the browser: no Intl, no clock", () => {
    const a = soraniRelative(-90 * MINUTE, "arab");
    const b = soraniRelative(-90 * MINUTE, "arab");
    expect(a).toBe(b);
    expect(a).toBe("٢ کاتژمێر لەمەوبەر");
  });
});
