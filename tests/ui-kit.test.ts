/**
 * UI kit rules that live in the stylesheets and in small helpers (docs/ui/core.md, showcase.md): the radio group with
 * nothing chosen, live glass under an open sheet or dialog, the bidi isolate, amounts in sentences, and the Design
 * System v2 helpers — key aliases and press physics, retired pieces, well kinds, release days in Iraq time, the
 * contact card's open/closed state, stock words, and the honest copy in all three languages. What they look like is
 * checked in Chromium on /design-system (#core, #forms, #showcase, #commerce, #overlays) with screenshots.
 *
 *   npm test -- tests/ui-kit.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
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
import * as led from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { pictureFailed, releaseDay, wellKind } from "~/ui/ProductCard";
import { daysUntil, iraqDay } from "~/ui/ReleaseBand";
import { revealDelta } from "~/ui/reveal";
import * as stage from "~/ui/Stage";
import { stockLook } from "~/ui/StockNote";
import { transferMethods } from "~/ui/TrustStrip";

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

// Stage 4 of the v2 build (spec §4.2, §12): the retired 1.0 pieces nothing imports any more are deleted. The 1.0 key
// names (`commit` / `ink` / `quiet` / `clay`) and <Glass variant="static"> stay while the admin (1.0 materials) uses them.
describe("retired 1.0 pieces (§4.2): deleted once nothing imports them", () => {
  it("has no red socket, no platform bank, no stage price tag and no platform pictograms", () => {
    expect(existsSync(fileURLToPath(new URL("../app/ui/Socket.tsx", import.meta.url)))).toBe(false);
    expect(existsSync(fileURLToPath(new URL("../app/ui/PlatformBank.tsx", import.meta.url)))).toBe(false);
    expect("StageTag" in stage).toBe(false);
    expect("PlatformGlyph" in led).toBe(false);
  });
});

// Polish round (digests: storefront K, admin "UI kit"). What the components draw is checked in Chromium on
// /design-system and on the pages that reported each defect (screenshots and measurements in the K-kit report).
describe("rows that scroll sideways keep the focused or current item in view (rails, tabs, link segments)", () => {
  const row = { left: 0, right: 390 };
  it("moves nothing when the item is already inside", () => {
    expect(revealDelta(row, { left: 16, right: 177 }, { rtl: false, align: "start", padStart: 16 })).toBe(0);
  });

  it("brings a half-hidden card to the rail's start — a snap point, so the snap cannot pull it back", () => {
    // left to right: a card cut at the end edge goes to the start edge (16px of scroll padding)
    expect(revealDelta(row, { left: 362, right: 523 }, { rtl: false, align: "start", padStart: 16 })).toBe(346);
    // right to left (scrollLeft runs negative): a card cut at the left edge comes to the right-hand start edge
    expect(revealDelta(row, { left: -133, right: 28 }, { rtl: true, align: "start", padStart: 16 })).toBe(-346);
  });

  it("moves a tab the least: its hidden side to the row's edge", () => {
    expect(revealDelta(row, { left: 360, right: 420 }, { rtl: false, align: "nearest" })).toBe(30);
    expect(revealDelta(row, { left: -40, right: 20 }, { rtl: false, align: "nearest" })).toBe(-40);
    expect(revealDelta(row, { left: -40, right: 20 }, { rtl: true, align: "nearest" })).toBe(-40);
    expect(revealDelta(row, { left: 360, right: 420 }, { rtl: true, align: "nearest" })).toBe(30);
  });
});

describe("the trust strip names only the transfer methods that are switched on", () => {
  it("says both, one or none", () => {
    expect(transferMethods(true)).toBe("both");
    expect(transferMethods({ zaincash: true, card: true })).toBe("both");
    expect(transferMethods({ zaincash: true })).toBe("zaincash");
    expect(transferMethods({ card: true, zaincash: false })).toBe("card");
    expect(transferMethods({})).toBeNull();
    expect(transferMethods(false)).toBeNull();
    for (const locale of LOCALE_CODES) {
      expect(shop[locale].trust.transferZain.length).toBeGreaterThan(2);
      expect(shop[locale].trust.transferCard.length).toBeGreaterThan(2);
    }
  });
});

describe("a card picture that failed before hydration is found after it", () => {
  it("reads `complete` with no width as failed; a lazy picture not started yet is not", () => {
    expect(pictureFailed({ complete: true, naturalWidth: 0, currentSrc: "/p.avif", src: "/p.avif" })).toBe(true);
    expect(pictureFailed({ complete: false, naturalWidth: 0, currentSrc: "", src: "/p.avif" })).toBe(false);
    expect(pictureFailed({ complete: true, naturalWidth: 480, currentSrc: "/p.avif", src: "/p.avif" })).toBe(false);
    expect(pictureFailed(null)).toBe(false);
  });
});

describe("kit restatements that outweigh the stylesheet (utilities layer)", () => {
  it("draws the PDP stage's image box 4% / 2% / 5% (the cut-outs carry ~5% margin of their own); opaque photos keep 8% / 6% / 9%", () => {
    const source = read("../app/ui/Stage.tsx");
    expect(source).toMatch(/inset-\[4%_2%_5%\]/);
    expect(source).toMatch(/has-\[img\[data-transparent=false\]\]:inset-\[8%_6%_9%\]/);
  });

  it("keeps the tick of a disabled checked checkbox and the ring of a disabled chosen radio", () => {
    const source = read("../app/ui/Field.tsx");
    expect(source).toMatch(/className="choice__input peer"/);
    expect(source).toMatch(/peer-checked:peer-disabled:bg-ink-3/);
    expect(source).toMatch(/peer-checked:peer-disabled:border-ink-3/);
  });

  it("never prints a toast", () => {
    expect(read("../app/ui/Toast.tsx")).toMatch(/lg:w-\[380px\] print:hidden/);
  });

  it("draws the offline banner in the warn treatment of §4.23, told apart from the demo strip by its bar (not the black ribbon §11.7 removed)", () => {
    const source = read("../app/ui/OfflineBanner.tsx");
    expect(source).not.toMatch(/bg-band|text-on-band/);
    const offline = rule(components, ".offline");
    expect(offline).toMatch(/background: var\(--warn-tint\)/);
    expect(offline).toMatch(/color: var\(--warn\)/);
    expect(offline).toMatch(/font: var\(--type-sm-strong\)/);
    expect(offline).toMatch(/border-inline-start: 3px solid var\(--warn\)/);
    // the demo strip keeps its own amber pair and no bar: the two never read as one message
    const strip = rule(components, ".demo-strip");
    expect(strip).toMatch(/background: var\(--demo-bg\)/);
    expect(strip).not.toMatch(/border-inline-start/);
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
    // day first in every language (§2.6, §10): "19 November", never "November 19"
    expect(releaseDay(day, "en")).toBe("19 November");
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

  it("writes an amount in a sentence through f.iqd: figure first, a no-break space, then the currency", () => {
    for (const locale of LOCALE_CODES) {
      for (const amount of [0, 5000, 25000, 1095000]) {
        const f = { iqd: (value: number) => formatMoney(value, "IQD", locale, "latn") };
        const before = `${new Intl.NumberFormat(`${LOCALES[locale].bcp47}-u-nu-latn`).format(amount)}\u00a0${CURRENCIES.IQD.symbol[locale]}`;
        expect(iqdText(f, amount)).toBe(before);
      }
    }
    expect(iqdText({ iqd: (value) => formatMoney(value, "IQD", "ar") }, 25000)).toBe("25,000\u00a0د.ع");
  });
});
