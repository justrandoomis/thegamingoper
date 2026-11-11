/**
 * UI kit rules that live in the stylesheets and in small helpers (docs/ui/core.md, showcase.md): the radio group with
 * nothing chosen, live glass under an open sheet or dialog, the bidi isolate, amounts in sentences, and the Design
 * System v2 helpers — key aliases and press physics, retired pieces, well kinds, release days in Iraq time, the
 * contact card's open/closed state, stock words, and the honest copy in all three languages. What they look like is
 * checked in Chromium on /design-system (#core, #forms, #showcase, #commerce, #overlays) with screenshots.
 *
 *   npm test -- tests/ui-kit.test.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import card from "~/i18n/messages/ui-card";
import overlays from "~/i18n/messages/ui-overlays";
import shop from "~/i18n/messages/ui-shop";
import ui from "~/i18n/messages/ui";
import { LOCALE_CODES, LOCALES } from "~/lib/locales";
import { CURRENCIES, formatMoney } from "~/lib/money";
import { hasContact, openNow } from "~/ui/ContactCard";
import { LAYER_BEHIND } from "~/ui/Dialog";
import { LIVE_GLASS } from "~/ui/Glass";
import { KEY_LOOK, keyPress } from "~/ui/Key";
import { PlatformGlyph } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { releaseDay, wellKind } from "~/ui/ProductCard";
import { daysUntil, iraqDay } from "~/ui/ReleaseBand";
import { StageTag } from "~/ui/Stage";
import { stockLook } from "~/ui/StockNote";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const components = read("../app/styles/components.css");
const materials = read("../app/styles/materials.css");
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("choices: a radio group with nothing chosen", () => {
  it("paints the mixed state for checkboxes only — a radio matches :indeterminate while its group is empty", () => {
    const mixed = components.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]*:indeterminate[^{]*\{/g) ?? [];
    expect(mixed.length).toBeGreaterThan(0);
    for (const selector of mixed) {
      for (const part of selector.replace("{", "").split(",")) {
        if (part.includes(":indeterminate")) expect(part, part.trim()).toMatch(/\[type="checkbox"\]\)?:indeterminate/);
      }
    }
  });
});

describe("the stage band: the commit key keeps its whole label", () => {
  it("wraps instead of cutting: the key never shrinks and keeps the inline end", () => {
    expect(rule(components, ".stage__band")).toMatch(/flex-wrap:\s*wrap/);
    const key = rule(components, ".stage__band > .key");
    expect(key).toMatch(/flex:\s*none/);
    expect(key).toMatch(/margin-inline-start:\s*auto/);
  });

  it("lets the tag give way first: it breaks the line on its price, and its name shortens to whole words", () => {
    const tag = rule(components, ".gtag");
    expect(tag).toMatch(/flex:\s*1 1 0/);
    expect(tag).toMatch(/min-inline-size:\s*min-content/);
    expect(tag).toMatch(/max-inline-size:\s*max-content/);
    const name = rule(components, ".gtag__name");
    expect(name).toMatch(/line-clamp:\s*1/);
    expect(name).not.toMatch(/white-space:\s*nowrap/);
  });

  it("steps a seven-digit price down on a phone-width stage (CSS kept for the 1.0 band until the home migrates)", () => {
    expect(components).toMatch(/@container stage \(max-width: 24rem\) \{\s*\.gtag\[data-long\] \{\s*--price-lg: var\(--price-md\);/);
  });

  // v2 §4.2, §4.14: the glass price tag on the stage is retired — it renders nothing (the price sits beside the action).
  it("retires the stage tag: <StageTag> renders nothing", () => {
    expect(StageTag({ name: "PlayStation 5 Pro", priceIqd: 1_099_000 })).toBeNull();
  });
});

describe("v2 keys (§4.3): one family, 1.0 names as aliases", () => {
  it("renders the 1.0 variant names with the v2 looks", () => {
    expect(KEY_LOOK.commit).toBe("primary");
    expect(KEY_LOOK.clay).toBe("secondary");
    expect(KEY_LOOK.ink).toBe("secondary"); // ink never means action
    expect(KEY_LOOK.quiet).toBe("ghost");
    expect(KEY_LOOK.onBand).toBe("onBand");
  });

  it("gives clay press travel to the primary and on-band keys only; every other key compresses softly", () => {
    expect(keyPress("primary")).toBe("clay");
    expect(keyPress("onBand")).toBe("clay");
    for (const look of ["secondary", "ghost", "danger"] as const) expect(keyPress(look)).toBe("soft");
  });

  it("keeps the admin's 1.0 ink key: `ink` still emits .key--ink, which admin.css re-skins", () => {
    expect(read("../app/ui/Key.tsx")).toMatch(/ink: "key--ink"/);
    expect(read("../app/styles/admin.css")).toMatch(/\[data-density="admin"\] \.key--ink \{/);
  });
});

describe("retired 1.0 pieces (§4.2) keep their exports and render nothing", () => {
  it("draws no platform pictograms", () => {
    expect(PlatformGlyph({ platform: "xbox" })).toBeNull();
  });
});

describe("the product well (§4.11, §7.3): one fit rule per kind", () => {
  const image = (artKey: string) => ({ artKey, mediaKey: null, alt: "", isIllustration: false });
  it("knows box art, digital cards, wide objects and hardware", () => {
    expect(wellKind({ kind: "game", image: image("mario-kart-world--1") })).toBe("box");
    expect(wellKind({ kind: "digital", image: image("playstation-5-slim--1") })).toBe("card");
    expect(wellKind({ kind: "console", image: image("lenovo-legion-go-2--1") })).toBe("wide"); // 1.9:1
    expect(wellKind({ kind: "console", image: image("playstation-5-slim--1") })).toBe("hardware");
  });

  it("writes a release day in Iraq time with Western digits («يصدر 19 تشرين الثاني»)", () => {
    const day = Date.UTC(2026, 10, 18, 21, 0); // 00:00 on 19 November in Baghdad
    expect(releaseDay(day, "ar")).toMatch(/^19 /);
    expect(releaseDay(day, "en")).toMatch(/19/);
    expect(releaseDay(day, "ckb")).toBe("19ی تشرینی دووەم");
  });
});

describe("the release band (§4.21): days are counted in Iraq time", () => {
  it("counts calendar days, not 24-hour spans", () => {
    const now = Date.UTC(2026, 10, 11, 20, 59); // 23:59 on 11 November in Baghdad
    expect(daysUntil(Date.UTC(2026, 10, 11, 21, 1), now)).toBe(1); // 00:01 on the 12th: tomorrow
    expect(daysUntil(Date.UTC(2026, 10, 18, 21, 0), now)).toBe(8);
    expect(daysUntil(now, now)).toBe(0);
    expect(iraqDay(Date.UTC(2026, 10, 18, 21, 0))).toEqual({ day: 19, month: 11, year: 2026 });
  });
});

describe("the contact card (§4.25): only configured channels, open/closed from the schedule", () => {
  it("renders nothing without a channel", () => {
    expect(hasContact(null)).toBe(false);
    expect(hasContact({ hoursText: "10–22" })).toBe(false);
    expect(hasContact({ whatsapp: "9647701234567" })).toBe(true);
  });

  it("computes open now in Iraq time, including a schedule that runs past midnight", () => {
    const at = (h: number) => Date.UTC(2026, 10, 11, h - 3, 0); // a Wednesday (day 3) at h:00 in Baghdad
    const day = [{ days: [3], open: "10:00", close: "22:00" }];
    expect(openNow(day, at(9))).toBe(false);
    expect(openNow(day, at(10))).toBe(true);
    expect(openNow(day, at(22))).toBe(false);
    const late = [{ days: [3], open: "18:00", close: "02:00" }];
    expect(openNow(late, at(23))).toBe(true);
    expect(openNow(late, Date.UTC(2026, 10, 11, 22, 0))).toBe(true); // 01:00 Thursday, still Wednesday's evening
    expect(openNow(null, at(12))).toBeNull();
  });
});

describe("stock words (§4.7): scarcity only from real stock", () => {
  it("reads low stock as in stock in demo mode, and sold out as ink-2, never danger red", () => {
    expect(stockLook("low_stock", true)).toBe("ok");
    expect(stockLook("low_stock", false)).toBe("warn");
    expect(stockLook("out_of_stock")).toBe("out");
    expect(stockLook("preorder")).toBe("soon");
  });
});

describe("words the v2 kit needs exist in all three languages", () => {
  it("says a price aloud in words, and the honest demo, trust and release lines", () => {
    for (const locale of LOCALE_CODES) {
      expect(ui[locale].price.aria).toContain("{amount}");
      expect(shop[locale].demo.priceStock.length).toBeGreaterThan(3);
      expect(shop[locale].trust.delivery).toContain("{price}");
      expect(shop[locale].preference.note.length).toBeGreaterThan(3);
      expect(overlays[locale].pagination.end.length).toBeGreaterThan(3);
    }
    // v2 §9: no call promise, no pre-order, no «دورك.» in the kit's words
    const all = JSON.stringify([ui, shop, card, overlays]);
    expect(all).not.toMatch(/نتصل/);
    expect(all).not.toMatch(/طلب مسبق"/);
    expect(JSON.stringify(shop.ar.preference)).toContain("وقت مفضّل وليس موعداً مؤكداً.");
  });
});

describe("glass under an open sheet or dialog", () => {
  it("turns the covered page's live glass solid (the layer marks the page, not other overlays)", () => {
    expect(LAYER_BEHIND).toBe("data-layer-behind");
    const solid = rule(materials, `:is([${LAYER_BEHIND}] .glass, .glass[${LAYER_BEHIND}]):not(.glass--static)`);
    expect(solid).toMatch(/backdrop-filter:\s*none/);
    expect(solid).toMatch(/background:\s*var\(--glass-solid\)/);
    expect(read("../app/ui/Dialog.tsx")).toMatch(/if \(!child\.hasAttribute\("data-overlay"\)\) child\.setAttribute\(LAYER_BEHIND, ""\)/);
  });

  it("counts as live only frosted panes", () => {
    expect(LIVE_GLASS).toBe(".glass:not(.glass--static):not(.glass--solid)");
  });
});

describe("text helpers", () => {
  it("isolates a label with Arabic script in the page's direction", () => {
    expect(rule(components, ".bidi")).toMatch(/unicode-bidi:\s*isolate/);
  });

  it("writes an amount in a sentence exactly as before, now through f.iqd (figure first, then the currency)", () => {
    for (const locale of LOCALE_CODES) {
      for (const amount of [0, 5000, 25000, 1095000]) {
        const f = { iqd: (value: number) => formatMoney(value, "IQD", locale, "latn") };
        const before = `${new Intl.NumberFormat(`${LOCALES[locale].bcp47}-u-nu-latn`).format(amount)} ${CURRENCIES.IQD.symbol[locale]}`;
        expect(iqdText(f, amount)).toBe(before);
      }
    }
    expect(iqdText({ iqd: (value) => formatMoney(value, "IQD", "ar") }, 25000)).toBe("25,000 د.ع");
  });
});
