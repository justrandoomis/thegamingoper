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
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { GLYPH_GROUPS, GLYPH_NAMES, Icon, isGlyph } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import ui from "~/i18n/messages/ui";
import { LOCALES, localePath, type Locale } from "~/lib/locales";
import { countAt, countUpPlan, countUpStart, initialRevealState, lateArrivals, revealDelay, revealEnabled } from "~/motion";
import { Band } from "~/ui/Band";
import { Blocks } from "~/ui/Blocks";
import { autoplayWaits, carouselHold, carouselMove, keyDelta, stepIndex, type CarouselHold } from "~/ui/Carousel";
import { CategoryTiles } from "~/ui/CategoryTile";
import { Chip } from "~/ui/Chip";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, OptionCard } from "~/ui/Field";
import { indicatorBox } from "~/ui/indicator";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { discountRows, OrderSummary } from "~/ui/OrderSummary";
import { PlatformTiles } from "~/ui/PlatformTile";
import { Price } from "~/ui/Price";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { Rail } from "~/ui/Rail";
import { revealProps } from "~/ui/reveal";
import { Status } from "~/ui/Tag";
import { Tabs } from "~/ui/Tabs";
import { ledgerLook } from "~/ui/WalletBalance";
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
    // fix round 2026-11-13: through --font-key (Kufam; Plex in Sorani, below)
    expect(tokens).toMatch(/--type-button:\s*600 var\(--fs-button\) \/ 1\.25 var\(--font-key\)/);
    expect(tokens).toMatch(/--font-key:\s*var\(--font-display\)/);
    expect(tokens).toMatch(/--type-button-sm:\s*600 var\(--fs-button-sm\) \/ 1\.25 var\(--font-text\)/);
    expect(tokens).toMatch(/--fs-button:\s*16px/);
    expect(tokens).toMatch(/--w-figure:\s*700/);
  });

  it("Sorani headings and key labels are Plex 600 until a native reader approves Kufam's ە (changed on purpose 2026-11-13)", () => {
    // Kufam's cmap has every Sorani letter (next test), but it draws the final ە as a small detached stroke
    // («یارمـ~تی»): brief G1's default — Plex 600 for ckb headings — stands until a Sorani reader says otherwise
    const ckb = block(tokens, ":lang(ckb)");
    expect(ckb).toMatch(/--font-head:\s*var\(--font-text\)/);
    expect(ckb).toMatch(/--font-key:\s*var\(--font-text\)/);
    // figures stay Kufam in every language (digits only)
    expect(tokens).toMatch(/--type-price:\s*var\(--w-figure\) var\(--price-md\) \/ 1\.2 var\(--font-display\)/);
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

  it("carousel moves (fix round 2026-11-13): only the next or previous slide slides; anything further fades and jumps", () => {
    // the autoplay wrap from the 6th banner to the 1st scrolled back past all six (−6400 → 0 over 1.5 s at 1440)
    expect(carouselMove(5, 0, "full")).toBe("fade");
    expect(carouselMove(0, 5, "full")).toBe("fade");
    // a dot two slides away, Home / End
    expect(carouselMove(1, 3, "full")).toBe("fade");
    // the neighbours still slide
    expect(carouselMove(2, 3, "full")).toBe("smooth");
    expect(carouselMove(3, 2, "full")).toBe("smooth");
    // two slides: the wrap IS the neighbour
    expect(carouselMove(1, 0, "full")).toBe("smooth");
    // re-aligning on the slide in view after a half swipe
    expect(carouselMove(2, 2, "full")).toBe("smooth");
    // reduced motion and the lite tier: every move is an instant jump
    expect(carouselMove(5, 0, "reduced")).toBe("jump");
    expect(carouselMove(2, 3, "reduced")).toBe("jump");
    expect(carouselMove(2, 3, "lite")).toBe("jump");
  });

  it("carousel: a key pressed in a dialog the carousel opened (a React portal) does not move the slides", () => {
    const source = read("app/ui/Carousel.tsx");
    expect(source).toMatch(/onKeyDown: \(event\) => \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(!event\.currentTarget\.contains\(event\.target as Node\)\) return;/);
  });

  it("carousel: the jump past snap points suspends snapping (Chromium stops even an instant scroll at a snap-stop: always slide)", () => {
    const source = read("app/ui/Carousel.tsx");
    expect(source).toMatch(/scrollSnapType = "none"/);
    // a user's fling still stops at the next slide: the kit keeps `always`
    expect(decls(pieces, ".carousel__slide")).toMatch(/scroll-snap-stop:\s*always/);
  });

  it("carousel controls: 44px clay circles (G2), the pause key only once the page is live, the dots' hit area 44px", () => {
    const source = read("app/ui/Carousel.tsx");
    expect(source).toMatch(/size = "md"/);
    expect(tokens).toMatch(/--target:\s*44px/);
    expect(decls(pieces, ".carousel__dot")).toMatch(/inline-size:\s*var\(--target\)/);
    expect(decls(pieces, ".carousel__dot")).toMatch(/block-size:\s*var\(--target\)/);
    // the focus ring is drawn on the visible shape (the dot or the pill), not a thin box through the pill
    expect(decls(pieces, ".carousel__dot:focus-visible")).toMatch(/outline:\s*none/);
    expect(decls(pieces, ".carousel__dot:focus-visible::before, .carousel__dot:focus-visible::after")).toMatch(/outline:\s*var\(--focus-w\) solid var\(--focus\)/);
    // the progress look of the current dot while autoplay runs (CarouselDots progress)
    expect(pieces).toMatch(/\.carousel__dots\[data-run\] > \.carousel__dot\[aria-current="true"\]::after\s*\{[^}]*animation:\s*carousel-dot-fill/);
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

  it("count-up playOnLoad (fix round 2026-11-13, note 12): the page's one focus figure counts on a direct open too, from 70%", () => {
    // the offer on /trade-in/:ref and the rewards balance opened from a link never counted (server-rendered + on screen)
    expect(countUpPlan({ serverRendered: true, visible: true, full: true, playOnLoad: true })).toEqual({ show: "from", count: "now" });
    expect(countUpPlan({ serverRendered: true, visible: true, full: false, playOnLoad: true })).toEqual({ show: "final", count: "never" });
    expect(countUpStart({ value: 350_000, from: 0, serverRendered: true, playOnLoad: true })).toBe(245_000);
    // never down to 0 on a server-rendered page; a client mount still counts from `from`
    expect(countUpStart({ value: 350_000, from: 0, serverRendered: false, playOnLoad: true })).toBe(0);
    expect(countUpStart({ value: 2_000, from: 0, serverRendered: true, playOnLoad: false })).toBe(0);
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

/*
 * The fix round (2026-11-13): five auditors checked the store against the client's notes; the kit's defects, fixed.
 * Pure rules first, then the server's markup of the pieces (a router stub gives them the store's words), then the
 * stylesheet rules that carry the visual fixes. The carousel's moves are above ("review fixes").
 */
describe("fix round 2026-11-13", () => {
  const renderKit = (element: ReactElement, locale: Locale = "ar") => {
    const Page: ComponentType = () => element;
    const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "*", Component: Page }] }]);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: [localePath("/kit", locale)],
        hydrationData: { loaderData: { root: { locale, dir: LOCALES[locale].dir, fx: null, i18n: messagesFor(locale, "ui", "ui-shop", "ui-card", "ui-overlays") } } },
      }),
    );
  };

  it("tabs: 15px labels (16px on the lg row), the before's 3px underline; a page inside a tab's section says aria-current=true", () => {
    expect(tokens).toMatch(/--type-tab-label:\s*500 15px \/ 1\.4 var\(--font-text\)/);
    expect(tokens).toMatch(/--type-tab-label-lg:\s*500 16px \/ 1\.4 var\(--font-text\)/);
    // the phone tab bar's small label under its icons keeps its own role
    expect(tokens).toMatch(/--type-tab:\s*400 var\(--fs-xs\)/);
    const items = [
      { value: "help", label: "مركز المساعدة", href: "/support" },
      { value: "repair", label: "احجز صيانة", href: "/support/repair" },
    ];
    const page = renderKit(createElement(Tabs, { "aria-label": "الدعم", value: "help", items }));
    expect(page).toMatch(/aria-current="page"[^>]*>|aria-current="page"/);
    expect(page).toContain("[font:var(--type-tab-label)]");
    expect(page).toContain("min-h-11");
    const section = renderKit(createElement(Tabs, { "aria-label": "الدعم", value: "help", items, section: true, size: "lg" }));
    expect(section).toContain('aria-current="true"');
    expect(section).not.toContain('aria-current="page"');
    expect(section).toContain("[font:var(--type-tab-label-lg)]");
    expect(section).toContain("min-h-12");
    expect(decls(pieces, ".tabs__ind")).toMatch(/block-size:\s*var\(--tab-ind, 2px\)/);
  });

  it("order summary: the discount's parts sit in its place (before delivery and the total), never twice, nothing after the total but how it is paid", () => {
    const parts = [
      { key: "coupon", icon: "ticket" as const, label: "رمز الخصم DEMO10", amountIqd: 25_000 },
      { key: "points", icon: "star" as const, label: "1,000 نقطة مستبدلة", amountIqd: 10_000 },
    ];
    expect(discountRows(35_000, parts)).toBe(parts);
    // parts that do not add up to the server's discount are not shown: the one «الخصم» row is
    expect(discountRows(30_000, parts)).toBeNull();
    expect(discountRows(0, [])).toBeNull();
    expect(discountRows(5, [{ key: "x", label: "x", amountIqd: 5.5 }])).toBeNull();

    const html = renderKit(
      createElement(
        OrderSummary,
        { subtotalIqd: 140_000, discountIqd: 35_000, shippingIqd: 5_000, totalIqd: 110_000, discountParts: parts, couponField: createElement("input", { "aria-label": "code" }) },
        createElement("p", { className: "split" }, "من المحفظة"),
      ),
    );
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    // subtotal · DEMO10 · points · delivery · total · the split · the coupon question
    const order = [at("المجموع الفرعي"), at("DEMO10"), at("نقطة مستبدلة"), at("التوصيل"), at("الإجمالي"), at('class="split"'), at("لديك رمز خصم؟")];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the parts replace the single row: «الخصم» is not drawn, and nothing with a minus sign follows the total
    expect(html).not.toContain(">الخصم<");
    expect(html.slice(at("الإجمالي")).includes("−")).toBe(false);
    expect(html.match(/summary__row summary__row--saving/g)).toHaveLength(2);
    // the coupon question has a caret
    expect(html).toMatch(/<summary><span>لديك رمز خصم؟<\/span><svg[^>]*summary__caret/);
    // one discount, no parts: one «الخصم» row in the saving colour with its icon
    const single = renderKit(createElement(OrderSummary, { subtotalIqd: 100_000, discountIqd: 10_000, shippingIqd: 5_000, totalIqd: 95_000 }));
    expect(single.match(/summary__row--saving/g)).toHaveLength(1);
    expect(single).toContain("الخصم");
    expect(decls(components, ".summary__row--saving, .summary__row--saving .price")).toMatch(/color:\s*var\(--ok\)/);
  });

  it("key labels keep Arabic marks: the clip box is taller than the line (the tanween of «عنواناً», the kasras of «جارٍ»)", () => {
    // measured in Edge (work/C-fix-design/keymarks.mjs): every mark of 9 labels × 3 key sizes inside the clip box
    const label = decls(materials, ".key__label");
    expect(label).toMatch(/overflow:\s*hidden/);
    expect(label).toMatch(/padding-block:\s*0\.45em/);
    expect(label).toMatch(/margin-block:\s*-0\.45em/);
    const html = renderKit(createElement(Key, { variant: "primary" }, "أضف عنواناً"));
    expect(html).toContain('<span class="bidi key__label">أضف عنواناً</span>');
  });

  it("a confirmation's two keys share the row by their own widths on phones (a long label is never cut to «احذف العن…»)", () => {
    const dialog = read("app/ui/Dialog.tsx");
    expect(dialog.match(/className="flex-auto sm:flex-none"/g)).toHaveLength(2);
    expect(dialog).not.toMatch(/className="flex-1 sm:flex-none"/);
  });

  it("the ambient light never widens the page: by default it reaches above and below its box, not past its sides", () => {
    expect(decls(materials, ".glow::before, .glow-layer")).toMatch(/inset:\s*var\(--glow-inset, -12% 0\)/);
  });

  it("phone breadcrumbs keep each crumb on one line (base.css's li text-wrap: pretty set it back to wrap)", () => {
    expect(base).toMatch(/li,\s*dd,\s*blockquote\s*\{[^}]*text-wrap:\s*pretty/);
    expect(decls(pieces, ".crumbs--phone .crumbs__list > li")).toMatch(/white-space:\s*nowrap/);
    expect(pieces).toMatch(/animation-timeline:\s*scroll\(self inline\)/);
  });

  it("notes: the line variant at the reading size (16px, line height 1.75) with its icon on the first line; a danger tone", () => {
    expect(decls(pieces, ".note--line .note__text")).toMatch(/font:\s*var\(--type-read\)/);
    expect(decls(pieces, ".note--line .note__icon")).toMatch(/block-size:\s*calc\(var\(--fs-read\) \* var\(--lh-read\)\)/);
    const danger = renderToStaticMarkup(createElement(Note, { tone: "danger", title: "توقف فوراً" }, "افصل الجهاز."));
    expect(danger).toMatch(/^<div class="note note--danger">/);
    expect(danger).toContain('data-icon="warning-circle"');
    expect(decls(pieces, ".note--danger")).toMatch(/--note-ink:\s*var\(--danger\)/);
    expect(decls(pieces, ".note--danger .note__title")).toMatch(/color:\s*var\(--danger\)/);
  });

  it("content callouts render as the one Note pattern (G5): tinted circle, the tone said first to screen readers, no landmark", () => {
    const html = renderKit(createElement(Blocks, { blocks: [{ type: "callout", tone: "warning", title: "قبل أن تشتري", text: "لا تبيع Valve الجهاز في العراق." }] }));
    expect(html).toContain('class="note note--warning"');
    expect(html).toMatch(/<p class="note__title"><span class="sr-only">تنبيه: <\/span>قبل أن تشتري<\/p>/);
    expect(html).not.toContain("<aside");
    expect(html).not.toContain('class="callout');
    const plain = renderKit(createElement(Blocks, { blocks: [{ type: "callout", tone: "danger", text: "افصل الجهاز." }] }));
    expect(plain).toContain('class="note note--danger"');
    expect(plain).toMatch(/<div class="note__text"><span class="sr-only">خطر: <\/span>افصل الجهاز\.<\/div>/);
  });

  it("support rows: the title at the before's 16–17px (one line at 390), the 44px disc on phones", () => {
    expect(components).toMatch(/\.entry--row \.entry__title\s*\{\s*font:\s*var\(--w-head\) 17px \/ 1\.4 var\(--font-head\);\s*text-wrap:\s*balance;/);
    expect(components).toMatch(/@media \(max-width: 47\.99rem\)\s*\{[\s\S]*?\.entry--row \.entry__disc\s*\{\s*--disc:\s*44px;[\s\S]*?\.entry--row \.entry__title\s*\{\s*font-size:\s*16px;/);
  });

  it("reading text on phones (G7): the release band's lead, the inspection report, the grade legend; and the utility exists", () => {
    // wave A documented `type-read` and wave B used it on 29 elements, but the utility class itself was missing
    expect(uncommented(read("app/styles/theme.css"))).toMatch(/@utility type-read\s*\{\s*font:\s*var\(--type-read\);/);
    expect(decls(components, ".release__lead")).toMatch(/font:\s*var\(--type-read\)/);
    expect(decls(components, ".inspect__row")).toMatch(/font:\s*var\(--type-read\)/);
    expect(read("app/ui/InspectionCard.tsx").match(/type-read[^"]*lg:type-sm/g)?.length).toBeGreaterThanOrEqual(5);
    expect(read("app/ui/GradeBadge.tsx")).toMatch(/<dd className="type-read text-ink-2 lg:type-sm">/);
  });

  it("the grade legend keeps clear of the shell's fixed bars (it ran over «أضف إلى السلة» at 390)", () => {
    const badge = read("app/ui/GradeBadge.tsx");
    expect(badge).toMatch(/measure\("--shell-top"\)/);
    expect(badge).toMatch(/measure\("--shell-bottom"\)/);
  });

  it("one-line option cards sit in the middle of their 64px card; one picture has no «1 من 1» counter", () => {
    expect(decls(components, ".choice--row:not(:has(.choice__hint))")).toMatch(/align-items:\s*center/);
    expect(read("app/ui/Gallery.tsx")).toMatch(/total > 1 \? \(/);
  });

  it("«صورة توضيحية» never runs past a narrow well: it wraps, and under a /used row's 96px well it sits beneath the photo", () => {
    const photo = decls(components, ".tag--photo");
    expect(photo).toMatch(/white-space:\s*normal/);
    expect(photo).toMatch(/max-inline-size:\s*100%/);
    expect(read("app/ui/UsedUnitCard.tsx")).toMatch(/row && !real \? <Tag kind="photo" className="tag--under justify-self-start" \/>/);
  });

  it("segmented options: a real 44px target (the ::after counts from the padding box: 1px border + the track's 2px)", () => {
    expect(decls(components, ".seg__opt::after")).toMatch(/inset:\s*-3px 0/);
  });

  it("the compact platform tile keeps its sheen behind the hardware and deepens the words' side (white «PlayStation» ≥ 4.5)", () => {
    const light = decls(materials, ".ptile--compact .ptile__light");
    expect(light).toMatch(/radial-gradient\(28% 60% at calc\(50% \+ 34% \* var\(--dir\)\) 58%, var\(--tile-sheen\)/);
    expect(light).toMatch(/linear-gradient\(calc\(90deg \* var\(--dir\)\), var\(--tile-words-shade\) 0%, var\(--tile-words-shade-mid\) 45%/);
    expect(light).toBeTruthy();
    expect(tokens).toMatch(/--tile-words-shade:\s*rgb\(0 0 0 \/ 0\.12\)/);
  });

  it("the white on-band key says its words in the band's deep colour on a platform band", () => {
    expect(decls(materials, ":where([data-gel]) .key--on-band")).toMatch(/--on:\s*var\(--plat-deep, var\(--on-band-label\)\)/);
  });

  it("step rails: the before's labelled rail (32px discs, Kufam numerals, the word under each); a status rail with stage icons", () => {
    const steps = [{ label: "الجهاز", href: "/trade-in" }, { label: "الحالة" }, { label: "الصور" }, { label: "التقدير" }, { label: "الفحص" }];
    const under = renderKit(createElement(ProgressSteps, { steps, current: 1, labels: "under" }));
    expect(under).toContain('class="steps-under"');
    expect(under.match(/class="steps-under__item"/g)).toHaveLength(5);
    expect(under).toMatch(/<a[^>]*class="step"[^>]*data-state="done"/);
    expect(under).toContain('aria-current="step"');
    for (const label of ["الجهاز", "الحالة", "الصور", "التقدير", "الفحص"]) expect(under).toContain(label);
    expect(under).not.toContain("sr-only\">الحالة");
    expect(decls(components, ".steps-under .step__n")).toMatch(/inline-size:\s*32px/);
    expect(decls(components, ".steps-under .step__n")).toMatch(/font:\s*var\(--w-figure\) 16px \/ 1 var\(--font-display\)/);
    const status = renderKit(createElement(ProgressSteps, { variant: "status", current: 2, steps: [{ label: "استلمنا", icon: "receipt" }, { label: "تأكيد", icon: "seal-check" }, { label: "تجهيز", icon: "package" }, { label: "في الطريق", icon: "truck" }, { label: "تم التسليم", icon: "house" }] }));
    expect(status).toContain('class="steps-status"');
    expect(status.match(/class="steps-status__disc"/g)).toHaveLength(5);
    expect(status).toMatch(/data-state="current" aria-current="step"/);
  });

  it("chips take a kind icon (the check takes its place when chosen); keys can wrap or be compact; a state can be a pill", () => {
    const chip = renderKit(createElement(Chip, { icon: "kind-controller", count: 12, children: "أذرع التحكم" }));
    expect(chip).toContain('class="key__icon"');
    expect(chip).toContain('data-glyph="kind-controller"');
    expect(materials).toMatch(/\.key:is\(\[aria-checked="true"\], \[aria-pressed="true"\], \[data-held\], :has\(> input:checked\)\) \.key__icon\s*\{\s*display:\s*none/);
    expect(renderKit(createElement(Key, { wrap: true }, "لەگەڵ کارمەندێک قسە بکە"))).toMatch(/class="key key--secondary key--wrap"/);
    expect(renderKit(createElement(Key, { fit: "compact" }, "قبوڵ"))).toMatch(/key--compact/);
    expect(decls(materials, ".key--wrap .key__label")).toMatch(/text-wrap:\s*balance/);
    expect(renderToStaticMarkup(createElement(Status, { tone: "warn", pill: true, children: "بانتظار الدفع" }))).toBe('<span class="status status--warn status--pill">بانتظار الدفع</span>');
  });

  it("empty states: the stack icon at 44px in its disc; a panel that spans its column", () => {
    const html = renderKit(createElement(EmptyState, { layout: "stack", panel: true, wide: true, icon: "magnifying-glass", title: "لا نتائج" }));
    expect(html).toContain('class="empty empty--panel empty--wide"');
    expect(html).toMatch(/width="44" height="44"/);
    expect(decls(pieces, ".empty--panel.empty--wide")).toMatch(/max-inline-size:\s*none/);
  });

  it("option cards: a clay face and an icon disc; a checkbox row with its hint inside", () => {
    const card = renderKit(createElement(OptionCard, { clay: true, icon: "wallet", name: "payout", value: "wallet", label: "إلى المحفظة", hint: "فوراً بعد الفحص" }));
    expect(card).toMatch(/class="choice choice--radio choice--row choice--clay"/);
    expect(card).toContain('class="choice__icon"');
    const check = renderKit(createElement(Checkbox, { row: true, name: "works", label: "الجهاز يعمل", hint: "يُفحص عند الاستلام" }));
    expect(check).toMatch(/class="choice choice--row choice--check"/);
    expect(check).toMatch(/<span class="choice__hint"[^>]*>يُفحص عند الاستلام<\/span>/);
    expect(check).not.toContain('class="field__hint"');
  });

  it("the glossy wallet band; the ledger rows' kind discs and coloured signs (as the account's history)", () => {
    expect(renderKit(createElement(Band, { kind: "wallet", gloss: true }, "x"))).toMatch(/class="band band--wallet band--gloss"/);
    expect(ledgerLook({ kind: "topup", amountIqd: 5_000 })).toEqual({ icon: "plus", tone: "ok" });
    expect(ledgerLook({ kind: "purchase", amountIqd: -5_000 })).toEqual({ icon: "shopping-cart-simple", tone: "red" });
    expect(ledgerLook({ kind: "adjustment", amountIqd: -1 })).toEqual({ icon: "storefront", tone: "red" });
    expect(decls(components, '.ledger__amount[data-sign="credit"]')).toMatch(/color:\s*var\(--ok\)/);
  });

  it("a toast's kind icon is drawn inline (an offline toast's sprite icon came out blank)", () => {
    const toast = read("app/ui/Toast.tsx");
    for (const name of ["status-info", "status-ok", "status-warning", "status-error"]) {
      expect(toast).toContain(`"${name}"`);
      expect(GLYPH_NAMES).toContain(name);
    }
    expect(renderToStaticMarkup(createElement(Icon, { name: "status-warning" }))).toMatch(/data-glyph="status-warning"/);
  });

  it("a price can count up once (the offer): the server renders the final figure", () => {
    const html = renderKit(createElement(Price, { amountIqd: 350_000, size: "xl", countUp: "load", approx: "off" }));
    expect(html).toMatch(/class="price__num"><span class="count">/);
    expect(html).toContain('<span class="count__final" aria-hidden="true">350,000</span>');
    expect(html).toContain('<span class="count__live" aria-hidden="true">350,000</span>');
  });

  it("rails and tile grids can reveal their items one after another; late cards of a stagger row arrive as a batch", () => {
    const card = createElement("a", { href: "/p/a" }, "a");
    expect(renderKit(createElement(Rail, { reveal: true, "aria-label": "x", children: card }))).toContain('data-reveal="stagger"');
    expect(renderKit(createElement(PlatformTiles, { reveal: true, children: "x" }))).toContain('data-reveal="stagger"');
    expect(renderKit(createElement(CategoryTiles, { reveal: true, children: "x" }))).toContain('data-reveal="stagger"');
    expect(renderKit(createElement(Rail, { "aria-label": "x", children: card }))).not.toContain("data-reveal");
    const row = { id: "row" };
    const other = { id: "other" };
    const a = { el: "a" };
    const b = { el: "b" };
    const marked = { el: "marked" };
    const records = [
      { target: row, addedNodes: [a, "text", b] },
      { target: other, addedNodes: [{ el: "c" }] },
      { target: row, addedNodes: [marked, a] },
    ];
    const isEl = (n: unknown) => typeof n === "object" && n !== null && "el" in n;
    expect(lateArrivals(records, (r) => r === row, isEl, (n) => n === marked)).toEqual([a, b]);
  });
});
