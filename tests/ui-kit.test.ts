/**
 * UI kit rules that live in the stylesheets and in small helpers (docs/ui/core.md): the radio group with nothing
 * chosen, the stage band that never cuts the commit key, live glass under an open sheet or dialog, the bidi isolate,
 * and amounts in sentences. What they look like is checked in Chromium on /design-system (#core-fields,
 * #core-stage, #core-glass) with screenshots.
 *
 *   npm test -- tests/ui-kit.test.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCALE_CODES, LOCALES } from "~/lib/locales";
import { CURRENCIES, formatMoney } from "~/lib/money";
import { LAYER_BEHIND } from "~/ui/Dialog";
import { LIVE_GLASS } from "~/ui/Glass";
import { iqdText } from "~/ui/PriceTag";

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

  it("steps a seven-digit price down on a phone-width stage", () => {
    expect(components).toMatch(/@container stage \(max-width: 24rem\) \{\s*\.gtag\[data-long\] \{\s*--price-lg: var\(--price-md\);/);
    expect(read("../app/ui/Stage.tsx")).toMatch(/data-long=\{priceIqd >= 1_000_000 \? "" : undefined\}/);
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
