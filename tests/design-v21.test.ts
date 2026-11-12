/**
 * Design v2.1 "Clay & Glass" — the client's first feedback round (docs/DESIGN.md §15): the before's fonts are back
 * (Kufam + Plex 400/500/600, two preloads, Sorani in Kufam), keys are clay again (a glossy red primary, clay secondary,
 * chips and icon circles, the quantity tray), cards are soft raised surfaces, glass is real in the dark theme, platform
 * tiles stay vivid in both themes, and the new pieces (Note, Carousel, Reveal, CountUp, SuccessMark, sliding
 * indicators, device and kind glyphs) behave. What they look like is checked in Chromium on /design-system
 * (#clay-glass, light and dark side by side).
 *
 *   npm test -- tests/design-v21.test.ts
 */
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GLYPH_GROUPS, GLYPH_NAMES, Icon, isGlyph } from "~/art/Icon";
import ui from "~/i18n/messages/ui";
import { countAt, countUpPlan, initialRevealState, revealDelay, revealEnabled } from "~/motion";
import { autoplayWaits, carouselHold, keyDelta, stepIndex, type CarouselHold } from "~/ui/Carousel";
import { indicatorBox } from "~/ui/indicator";
import { Note } from "~/ui/Note";
import { revealProps } from "~/ui/reveal";
import { criticalFonts, FONT_FILES } from "~/styles/fonts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = uncommented(read("app/styles/tokens.css"));
const base = uncommented(read("app/styles/base.css"));
const fontsCss = uncommented(read("app/styles/fonts.css"));
const materials = uncommented(read("app/styles/materials.css"));
const components = uncommented(read("app/styles/components.css"));
const pieces = uncommented(read("app/styles/pieces.css"));

/** The declarations of every rule whose selector list is exactly `selector` (flat; @media bodies walked into). */
function decls(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1].trim().replace(/\s+/g, " ") === selector) out.push(m[2]);
  return out.join(";");
}
/** The body of a top-level block whose selector is exactly `selector` (the theme blocks of tokens.css). */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i);
  }
  return "";
}
const light = block(tokens, ':root,\n[data-theme="light"]');
const dark = block(tokens, '[data-theme="dark"]');

describe("G1 · the before's fonts (Kufam + IBM Plex Sans Arabic)", () => {
  it("ships Kufam (Arabic + Latin, variable) and Plex 400 / 500 / 600; the files exist at the sizes the budget records", () => {
    const families = new Set(FONT_FILES.map((f) => f.family));
    expect([...families].sort()).toEqual(["IBM Plex Sans Arabic", "Kufam Variable"]);
    expect(FONT_FILES.filter((f) => f.family === "IBM Plex Sans Arabic" && f.script === "Arab").map((f) => f.weight).sort()).toEqual(["400", "500", "600"]);
    for (const file of FONT_FILES) {
      const size = statSync(path.join(ROOT, "public", file.href)).size;
      expect(size, file.href).toBe(file.bytes);
      expect(fontsCss, file.href).toContain(file.href);
    }
    expect(read("public/fonts/OFL-Kufam.txt")).toMatch(/SIL OPEN FONT LICENSE/i);
  });

  it("preloads exactly Plex 400 + Kufam of the page's script", () => {
    for (const script of ["Arab", "Latn"] as const) {
      const files = criticalFonts(script);
      expect(files).toHaveLength(2);
      expect(files.map((f) => `${f.family} ${f.weight}`).sort()).toEqual(["IBM Plex Sans Arabic 400", "Kufam Variable 400 900"]);
      expect(files.every((f) => f.script === script)).toBe(true);
    }
  });

  it("the display face is Kufam with metric-adjusted fallbacks; Noto Kufi is gone from the styles", () => {
    expect(tokens).toMatch(/--font-display:\s*"Kufam Variable", "Kufam Fallback", "Kufam Fallback Noto"/);
    expect(fontsCss).toMatch(/font-family:\s*"Kufam Fallback";/);
    expect(fontsCss).toMatch(/font-family:\s*"Kufam Fallback Noto";/);
    expect(fontsCss).not.toMatch(/Noto Kufi/);
    expect(tokens).not.toMatch(/Noto Kufi/);
  });

  it("key labels are Kufam at 16px (the 40px key keeps Plex 600 14px, under Kufam's 15px floor); prices are Kufam 700", () => {
    expect(tokens).toMatch(/--type-button:\s*600 var\(--fs-button\) \/ 1\.25 var\(--font-display\)/);
    expect(tokens).toMatch(/--type-button-sm:\s*600 var\(--fs-button-sm\) \/ 1\.25 var\(--font-text\)/);
    expect(tokens).toMatch(/--fs-button:\s*16px/);
    expect(tokens).toMatch(/--w-figure:\s*700/);
  });

  it("Sorani headings use Kufam (it has every Sorani letter) — no fallback to the text face", () => {
    const ckb = block(tokens, ":lang(ckb)");
    expect(ckb).toMatch(/--font-head:\s*var\(--font-display\)/);
    expect(ckb).not.toMatch(/--font-text/);
  });

  it("Kufam's Arabic file draws every Sorani letter (cmap) and shapes Sorani words without a missing glyph", async () => {
    // fontkit ships no type declarations: loaded through require, typed here
    const fontkit = createRequire(import.meta.url)("fontkit") as { create: (buffer: Buffer) => { hasGlyphForCodePoint(c: number): boolean; layout(text: string): { glyphs: Array<{ id: number }> } } };
    const font = fontkit.create(readFileSync(path.join(ROOT, "public/fonts/kufam-arabic-wght.70d76d8d.woff2")));
    for (const letter of ["ڕ", "ڵ", "ۆ", "ێ", "ە", "ھ", "ڤ", "پ", "چ", "ژ", "گ", "ک", "ی", "ئ"]) {
      expect(font.hasGlyphForCodePoint(letter.codePointAt(0) as number), letter).toBe(true);
    }
    for (const word of ["پلاتفۆرمەکەت هەڵبژێرە", "گەیاندن", "ڕێنمایی", "ئامێرەکە"]) {
      expect(font.layout(word).glyphs.some((g) => g.id === 0), word).toBe(false);
    }
  });

  it("reading text has its own role: 16px, line height ≥ 1.7 in Arabic", () => {
    expect(tokens).toMatch(/--fs-read:\s*16px/);
    expect(tokens).toMatch(/--lh-read:\s*1\.75/);
    expect(tokens).toMatch(/--type-read:\s*400 var\(--fs-read\) \/ var\(--lh-read\) var\(--font-text\)/);
  });
});

describe("G2 · keys are clay again", () => {
  it("every key stands on a 2px wall with the clay face; ghost keys stay flat", () => {
    const key = decls(materials, ".key");
    expect(key).toMatch(/--wall:\s*2px/);
    expect(key).toMatch(/--face:\s*var\(--key-face\)/);
    expect(key).toMatch(/--cast:\s*var\(--key-cast\)/);
    const ghost = decls(materials, ".key--ghost, .key--quiet, .key--plain");
    expect(ghost).toMatch(/--wall:\s*0px/);
    expect(ghost).toMatch(/--face:\s*transparent/);
  });

  it("the primary is glossy red: a gradient face, a lip, a belly and a red glow; the label sits from the 24% stop down", () => {
    const primary = decls(materials, ".key--primary, .key--red");
    expect(primary).toMatch(/--face:\s*var\(--key-red-face\)/);
    expect(primary).toMatch(/--cast:\s*var\(--key-red-cast\)/);
    expect(light).toMatch(/--key-red-face:\s*linear-gradient\(180deg, var\(--red-gloss-top\) 0%, var\(--red-gloss-mid\) 24%/);
  });

  it("a press sinks the cap onto its wall and shortens the cast (never in the admin)", () => {
    expect(materials).toMatch(/\.key:not\(:where\(\[data-density="admin"\] \*\)\)\[data-pressed\]::before\s*\{\s*box-shadow:\s*var\(--cast-press, var\(--cast\)\)/);
    expect(decls(materials, ".key[data-pressed] > .key__cap, html:not([data-motion-ready]) .key:active > .key__cap")).toMatch(/translateY\(var\(--travel\)\)/);
  });

  it("icon keys are 44px clay circles; chips are clay pills held down when chosen", () => {
    expect(decls(materials, ".key--round")).toMatch(/--h:\s*44px/);
    expect(decls(materials, ".key--chip")).toMatch(/--cast:\s*var\(--key-cast-sm\)/);
    expect(materials).toMatch(/\.key:not\(\.key--round, \.key--ghost, \.key--quiet, \.key--plain\):is\(\[aria-checked="true"\][^{]*> \.key__cap\s*\{\s*transform:\s*translateY\(var\(--travel\)\)/);
  });

  it("the stepper is the before's tray: pressed in, the «+» raised (outside the admin)", () => {
    expect(decls(components, ".stepper")).toMatch(/box-shadow:\s*var\(--tray-shadow\)/);
    expect(components).toMatch(/\.stepper:not\(:where\(\[data-density="admin"\] \*\)\) > \.key:last-of-type:not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*--wall:\s*2px/);
  });
});

describe("G3 · surfaces, glass and the platform colours", () => {
  it("cards are soft raised surfaces; in dark they are faux glass (a white veil on a see-through tint, a rim light, no blur)", () => {
    expect(decls(components, ".pcard")).toMatch(/box-shadow:\s*var\(--e-surface\)/);
    // review 2026-11-12: the veil sits on a translucent tint (was an opaque #1a1b20), so the floor's light shows through
    expect(dark).toMatch(/--card-face:\s*linear-gradient\(180deg, var\(--card-veil\) 0%, var\(--card-veil-low\) 100%\), var\(--card-tint\)/);
    expect(decls(materials, ".surface")).not.toMatch(/backdrop-filter/);
  });

  it("real glass is frosted, rim-lit and falls back to solid without backdrop-filter, under reduced transparency and on the lite tier", () => {
    expect(decls(materials, ".glass--panel")).toMatch(/backdrop-filter:\s*var\(--glass-panel-filter\)/);
    expect(decls(materials, ".surface--glass")).toMatch(/backdrop-filter:\s*var\(--glass-card-filter\)/);
    expect(materials).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
    expect(materials).toMatch(/:is\(\.fx-low, \[data-motion="lite"\]\) \.surface--glass/);
  });

  it("platform tiles stay vivid in the dark theme (never the grey cabinet) and their words are white", () => {
    expect(dark).toMatch(/--tile-mix:\s*100%/);
    expect(dark).toMatch(/--tile-gel-a:\s*0;/);
    expect(decls(materials, ".ptile")).toMatch(/color:\s*var\(--on-color\)/);
    expect(decls(materials, ".ptile__cap")).toMatch(/radial-gradient\(130% 125% at calc\(50% \+ 50% \* var\(--dir\)\) 0%, var\(--plat-hi/);
  });

  it("the ambient light reads the platform's colour inside [data-gel], brand red elsewhere", () => {
    expect(decls(materials, ".glow::before, .glow-layer")).toMatch(/var\(--glow-rgb, var\(--gel, var\(--gel-brand\)\)\)/);
  });
});

describe("G4 · icons: device and kind glyphs through the Icon API", () => {
  it("the four device silhouettes and the ten catalogue kinds exist by name", () => {
    expect(GLYPH_GROUPS.devices).toEqual(["device-nintendo", "device-playstation", "device-xbox", "device-handheld"]);
    expect(GLYPH_GROUPS.kinds).toHaveLength(10);
    for (const name of [...GLYPH_GROUPS.devices, ...GLYPH_GROUPS.kinds, ...GLYPH_GROUPS.media]) expect(GLYPH_NAMES).toContain(name);
    expect(isGlyph("kind-controller")).toBe(true);
    expect(isGlyph("heart")).toBe(false);
  });

  it("a glyph renders inline at 2px on a 24 grid; a sprite icon still uses the sprite", () => {
    const glyph = renderToStaticMarkup(createElement(Icon, { name: "device-playstation" }));
    expect(glyph).toMatch(/viewBox="0 0 24 24"/);
    expect(glyph).toMatch(/stroke-width="2"/);
    expect(glyph).toMatch(/data-glyph="device-playstation"/);
    expect(renderToStaticMarkup(createElement(Icon, { name: "heart" }))).toMatch(/<use href="\/icons\.svg\?r=[^#]+#heart"/);
  });

  it("sprite icons draw at the before's weight (a round-joined stroke on the outline), unless asked not to", () => {
    const base = uncommented(read("app/styles/base.css"));
    expect(decls(base, "svg[data-icon]")).toMatch(/stroke-width:\s*6px/);
    expect(base).toMatch(/\[data-weight="regular"\]/);
  });
});

describe("G5 · Note", () => {
  it("renders the icon circle, a short title, the text and the action on its own line; the tone tints only the circle", () => {
    const html = renderToStaticMarkup(createElement(Note, { tone: "info", title: "طرق الدفع", action: createElement("a", { href: "/x" }, "اعرف المزيد") }, "التحويل يبقى بانتظار التحقق."));
    // review 2026-11-12: a <div> by default — an unnamed <aside> in <main> is a complementary landmark per note
    expect(html).toMatch(/^<div class="note note--info">/);
    expect(html).toMatch(/class="note__icon" aria-hidden="true"/);
    expect(html).toMatch(/<p class="note__title">طرق الدفع<\/p>/);
    expect(html).toMatch(/<div class="note__text">التحويل يبقى بانتظار التحقق\.<\/div>/);
    expect(html).toMatch(/<div class="note__action">/);
    expect(decls(pieces, ".note--info")).toMatch(/--note-tint:\s*var\(--info-tint\)/);
    expect(decls(pieces, ".note")).toMatch(/background:\s*var\(--card-face\)/);
  });

  it("the line variant has no card", () => {
    const html = renderToStaticMarkup(createElement(Note, { variant: "line", icon: "clock" }, "…"));
    expect(html).toMatch(/class="note note--line"/);
    expect(decls(pieces, ".note--line")).toMatch(/box-shadow:\s*none/);
  });
});

describe("G6 · motion helpers", () => {
  it("the carousel wraps or clamps, and the arrow keys follow the reading direction", () => {
    expect(stepIndex(2, 1, 3, true)).toBe(0);
    expect(stepIndex(0, -1, 3, true)).toBe(2);
    expect(stepIndex(2, 1, 3, false)).toBe(2);
    expect(stepIndex(0, -1, 3, false)).toBe(0);
    expect(keyDelta("ArrowLeft", true)).toBe(1); // Arabic: ← is "next"
    expect(keyDelta("ArrowRight", true)).toBe(-1);
    expect(keyDelta("ArrowRight", false)).toBe(1);
    expect(keyDelta("Enter", false)).toBe(0);
  });

  it("the carousel's words exist in all three languages", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const carousel = (ui[locale] as { carousel: Record<string, string> }).carousel;
      for (const key of ["role", "slide", "of", "goTo", "next", "previous", "pause", "play"]) expect(carousel[key], `${locale}.${key}`).toBeTruthy();
    }
  });

  it("the sliding indicator measures from the track's inline start in both directions", () => {
    // a 300px track, an item 60px wide whose left edge is 200px from the track's left
    expect(indicatorBox({ clientWidth: 300 }, { offsetLeft: 200, offsetWidth: 60 }, false)).toEqual({ x: 200, width: 60 });
    // right to left: 40px from the track's right edge → translate 40px toward the left
    expect(indicatorBox({ clientWidth: 300 }, { offsetLeft: 200, offsetWidth: 60 }, true)).toEqual({ x: -40, width: 60 });
    // the tabs' underline sits 12px inside the tab
    expect(indicatorBox({ clientWidth: 300 }, { offsetLeft: 200, offsetWidth: 60 }, false, 12)).toEqual({ x: 212, width: 36 });
  });

  it("a count-up eases out and lands exactly on the value", () => {
    expect(countAt(0, 2000, 0)).toBe(0);
    expect(countAt(0, 2000, 1)).toBe(2000);
    expect(countAt(0, 2000, 2)).toBe(2000);
    expect(countAt(0, 2000, 0.5)).toBeGreaterThan(1000); // fast first
  });

  it("section reveal: only below the fold, never for automation or reduced motion; stagger caps at six steps", () => {
    expect(initialRevealState(1000, 844)).toBe("pending");
    expect(initialRevealState(300, 844)).toBe("shown");
    const env = { tier: "full", webdriver: false, hidden: false, io: true, waapi: true };
    expect(revealEnabled(env)).toBe(true);
    expect(revealEnabled({ ...env, tier: "reduced" })).toBe(false);
    expect(revealEnabled({ ...env, tier: "lite" })).toBe(false);
    expect(revealEnabled({ ...env, webdriver: true })).toBe(false);
    expect([0, 1, 5, 9].map(revealDelay)).toEqual([0, 60, 300, 300]);
    expect(revealProps()).toEqual({ "data-reveal": "" });
    expect(revealProps({ stagger: true })).toEqual({ "data-reveal": "stagger" });
  });

  it("everything new is instant under reduced motion and the store's reduce-motion setting", () => {
    for (const selector of [".carousel__track", ".carousel__parallax"]) expect(pieces).toMatch(new RegExp(`\\[data-motion="reduced"\\] \\${selector}`));
    expect(pieces).toMatch(/\[data-motion="reduced"\] :is\(\.success-mark__disc, \.success-mark__check\)/);
    expect(pieces).toMatch(/\[data-motion="reduced"\] :is\(\.seg__thumb, \.tabs__ind\)/);
    expect(pieces).toMatch(/\[data-motion="reduced"\] details\.disclosure::details-content/);
    // review 2026-11-12: was `:is(.pcard, .pcard::before)` — a pseudo-element inside :is() is dropped, so the hover
    // shadow layer kept its fade under the store's reduce-motion switch
    expect(components).toMatch(/\[data-motion="reduced"\] \.pcard,\s*\[data-motion="reduced"\] \.pcard::before\s*\{\s*transition:\s*none/);
  });

  it("no :is() / :where() list holds a pseudo-element (the browser drops it without a word)", () => {
    for (const [name, css] of Object.entries({ materials, components, pieces, base })) {
      expect(css.match(/:(?:is|where)\([^)]*::[^)]*\)/g), name).toBeNull();
    }
  });
});

/*
 * The foundation review (2026-11-12): defects found in Chromium at 360–1440 and fixed. Behaviour first as pure
 * functions (the hook and the components call them), then the stylesheet rules that carry the visual fixes.
 */
describe("review fixes", () => {
  const still: CarouselHold = { playing: true, hovered: false, focused: false, touching: false };
  const onScreen = { canPlay: true, hidden: false, offscreen: false };

  it("carousel: a vertical wheel over the hero does not stop autoplay; a sideways trackpad swipe does", () => {
    expect(carouselHold(still, { type: "wheel", deltaX: 0, deltaY: 120 }).playing).toBe(true);
    expect(carouselHold(still, { type: "wheel", deltaX: 3, deltaY: -40 }).playing).toBe(true);
    expect(carouselHold(still, { type: "wheel", deltaX: -80, deltaY: 6 }).playing).toBe(false);
  });

  it("carousel: a touch pauses while the finger is down; only a swipe of the track stops autoplay", () => {
    const down = carouselHold(still, { type: "touch", on: true });
    expect(autoplayWaits({ ...onScreen, ...down })).toBe(true);
    // a page scroll that began on the hero: the finger lifts, autoplay goes on
    const up = carouselHold(down, { type: "touch", on: false });
    expect(up.playing).toBe(true);
    expect(autoplayWaits({ ...onScreen, ...up })).toBe(false);
    // the finger moved the track: the shopper took over
    expect(carouselHold(down, { type: "swipe" }).playing).toBe(false);
    // the track moved without a finger on it (an arrow, a dot, autoplay itself): not a swipe
    expect(carouselHold(still, { type: "swipe" }).playing).toBe(true);
  });

  it("carousel: pressing play starts it even while focus or the pointer is inside (the APG rotation control)", () => {
    let s: CarouselHold = { playing: true, hovered: true, focused: true, touching: false };
    expect(autoplayWaits({ ...onScreen, ...s })).toBe(true);
    s = carouselHold(s, { type: "toggle" });
    expect(s.playing).toBe(false);
    s = carouselHold(s, { type: "toggle" });
    expect(s.playing).toBe(true);
    expect(autoplayWaits({ ...onScreen, ...s })).toBe(false);
    // and the reasons it waits on its own still hold
    expect(autoplayWaits({ ...onScreen, ...s, hidden: true })).toBe(true);
    expect(autoplayWaits({ ...onScreen, ...s, canPlay: false })).toBe(true);
  });

  it("carousel dots: the current dot is a true pill (its own layer), not a circle stretched into an ellipse", () => {
    expect(pieces).not.toMatch(/scale:\s*2\.75 1/);
    expect(decls(pieces, ".carousel__dot::after")).toMatch(/inline-size:\s*22px/);
    expect(decls(pieces, '.carousel__dot[aria-current="true"]::after')).toMatch(/opacity:\s*1/);
  });

  it("count-up: a number below the fold waits at its start, so it never shows the final value and drops to zero", () => {
    expect(countUpPlan({ serverRendered: true, visible: false, full: true })).toEqual({ show: "from", count: "on-view" });
    expect(countUpPlan({ serverRendered: true, visible: true, full: true })).toEqual({ show: "final", count: "never" });
    expect(countUpPlan({ serverRendered: false, visible: true, full: true })).toEqual({ show: "from", count: "now" });
    expect(countUpPlan({ serverRendered: false, visible: false, full: false })).toEqual({ show: "final", count: "never" });
  });

  it("the on-band key stands on the band's own deep colour (a red wall showed under it on the blue PlayStation band)", () => {
    expect(decls(materials, ".key--on-band")).toMatch(/--wall-c:\s*var\(--plat-deep, var\(--red-deep\)\)/);
  });

  it("a key inside a field keeps its cast inside the field (the glossy red glow spilled under the support search)", () => {
    expect(decls(components, ".field__end > .key")).toMatch(/--cast:\s*var\(--key-cast-press\)/);
    expect(decls(components, ".field__end > :is(.key--primary, .key--red)")).toMatch(/--cast:\s*var\(--key-red-cast-press\)/);
  });

  it("card foot: the price and the add key keep one row on 360–414 phones in every language", () => {
    // measured in Chromium: before the fix 12 of 24 Arabic and 24 of 24 English feet wrapped at 360
    expect(components).toMatch(/@media \(max-width: 29\.99rem\)\s*\{\s*\.pcard:not\(\.pcard--row, \[data-layout="row"\]\)\s*\{\s*padding:\s*4px;/);
    expect(decls(components, ".pcard__body, .pcard__foot")).toMatch(/padding-inline:\s*0/);
    expect(components).toMatch(/@container pcard \(max-width: 152px\)\s*\{\s*\.pcard \.price\s*\{\s*font-size:\s*var\(--price-sm\);\s*\}\s*\.pcard \.price--long\s*\{\s*font-size:\s*15px;/);
    // the narrowest (147px rail cards at 360): a 36px add key that keeps its 44px hit area
    expect(components).toMatch(/@container pcard \(max-width: 148px\)[\s\S]*?--h:\s*36px;[\s\S]*?inset:\s*-4px;/);
    // a wrap that still happens (400% zoom) puts the key at the reading end in every card alike
    expect(decls(components, '.pcard:not(.pcard--row, [data-layout="row"]) .pcard__foot > :last-child:not(.pcard__status)')).toMatch(/margin-inline-start:\s*auto/);
  });

  it("Note renders a plain block by default; a page names its complementary landmark itself (as=aside + a label)", () => {
    expect(renderToStaticMarkup(createElement(Note, { title: "x" }, "y"))).toMatch(/^<div class="note">/);
    expect(renderToStaticMarkup(createElement(Note, { as: "aside", title: "x" }, "y"))).toMatch(/^<aside class="note">/);
  });

  it("the press-and-lift utility isolates its hover shadow (a parent's background no longer hides it)", () => {
    expect(decls(materials, ".lift")).toMatch(/isolation:\s*isolate/);
  });

  it("dark: the floor carries an ambient colour light on a fixed layer, and the faux glass is see-through (client note 3)", () => {
    expect(dark).toMatch(/--floor-light:\s*radial-gradient\(/);
    expect(light).toMatch(/--floor-light:\s*none/);
    expect(dark).toMatch(/--card-tint:\s*rgb\(\d+ \d+ \d+ \/ 0\.\d+\)/);
    const layer = decls(base, "body::before");
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/z-index:\s*-1/);
    expect(layer).toMatch(/background:\s*var\(--floor-light\)/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    // more contrast: no light on the floor, opaque cards
    expect(base).toMatch(/@media \(prefers-contrast: more\)\s*\{\s*body::before\s*\{\s*display:\s*none/);
  });
});
