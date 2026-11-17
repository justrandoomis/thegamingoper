/**
 * Drawn moments (app/ui/sakuga, docs/DESIGN.md §7.4) and the kit's small requests of the 2026-11-17 polish round.
 *
 * The moments: pure plans (short, anchored, mirrored in RTL, no lettering), the palette from the --fx-* tokens, the
 * guards (server, reduced motion, no matchMedia), the vendored core's licence and its lazy, client-only load, the canvas's
 * CSS (never a target, under the toasts, never printed), and every hook in the kit. The small requests: crumbs that keep
 * their words, the compatibility note at 16 up to 1023, the gloss gone under more contrast, the admin's 44px hit areas,
 * a clay checkbox row, a quiet disabled option icon, names that keep their tokens in the order summary — and the areas'
 * local overrides gone.
 *
 *   npm test -- tests/sakuga.test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { messagesFor } from "~/i18n/i18n.server";
import { LOCALES, localePath, type Locale } from "~/lib/locales";
import { Checkbox, OptionCard } from "~/ui/Field";
import { OrderSummary } from "~/ui/OrderSummary";
import { canDraw, paletteFrom, sakuga } from "~/ui/sakuga/fx";
import { LETTERING, MOMENT_MS, planAdded, planCheck, planComplete, planEnd, planRate, planToast, planToggle, type Box, type Plan } from "~/ui/sakuga/plans";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The bodies of every `@media <query> {…}` block of a stylesheet, joined (braces matched). */
function media(css: string, query: string): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(`@media ${query}`, from);
    if (at < 0) break;
    let i = css.indexOf("{", at) + 1;
    const start = i;
    for (let depth = 1; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push(css.slice(start, i - 1));
    from = i;
  }
  return out.join("\n");
}
/** The declarations of every rule whose selector is exactly `selector`. */
function decls(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1].trim().replace(/\s+/g, " ") === selector) out.push(m[2]);
  return out.join(";");
}

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

/* a key 180×48, a checkbox box 20×20, a switch track 44×26, a toast 380×72, the success mark 72×72, a progress bar 300×6 */
const KEY: Box = { x: 500, y: 400, w: 180, h: 48 };
const CARD_ADD: Box = { x: 500, y: 400, w: 40, h: 40 };
const BOX: Box = { x: 300, y: 300, w: 20, h: 20 };
const TRACK: Box = { x: 300, y: 300, w: 44, h: 26 };
const TOAST: Box = { x: 700, y: 120, w: 380, h: 72 };
const MARK: Box = { x: 200, y: 200, w: 72, h: 72 };
const BAR: Box = { x: 400, y: 500, w: 300, h: 6 };
const STARS: Box[] = [0, 1, 2, 3, 4].map((i) => ({ x: 100 + i * 36, y: 600, w: 28, h: 28 }));

const plans = (rtl: boolean): Record<string, Plan> => ({
  added: planAdded(KEY, rtl),
  addedCard: planAdded(CARD_ADD, rtl),
  check: planCheck(BOX, true, rtl),
  uncheck: planCheck(BOX, false, rtl),
  on: planToggle(TRACK, true, rtl),
  off: planToggle(TRACK, false, rtl),
  rate3: planRate(STARS.slice(0, 3), rtl),
  rate5: planRate(STARS, rtl),
  toast: planToast(TOAST, rtl),
  complete: planComplete(MARK, rtl),
  bar: planComplete(BAR, rtl),
});

describe("1 · the moments are short, small and anchored", () => {
  it("every moment ends within 600 ms (DESIGN.md §7.1), in both directions", () => {
    expect(MOMENT_MS).toBe(600);
    for (const rtl of [false, true]) {
      for (const [name, plan] of Object.entries(plans(rtl))) {
        expect(plan.length, name).toBeGreaterThan(0);
        expect(planEnd(plan), name).toBeLessThanOrEqual(MOMENT_MS);
        for (const step of plan) expect(step.o.life, `${name} ${step.fx}`).toBeGreaterThan(0);
      }
    }
  });

  it("every effect starts on or beside its control (within 60px of its box)", () => {
    const near = (plan: Plan, b: Box) =>
      plan.every((step) => Math.abs(step.x - b.x) <= b.w / 2 + 60 && Math.abs(step.y - b.y) <= b.h / 2 + 60);
    for (const rtl of [false, true]) {
      const p = plans(rtl);
      expect(near(p.added, KEY)).toBe(true);
      expect(near(p.check, BOX)).toBe(true);
      expect(near(p.on, TRACK)).toBe(true);
      expect(near(p.toast, TOAST)).toBe(true);
      expect(near(p.complete, MARK)).toBe(true);
      expect(near(p.bar, BAR)).toBe(true);
      expect(near(p.rate5, { x: 172, y: 600, w: 172, h: 28 })).toBe(true);
    }
  });

  it("the end-side pieces mirror in RTL (the glint off the key's end corner, the switch's landing, the bar's end)", () => {
    const glint = (plan: Plan) => plan.find((step) => step.fx === "kira");
    expect(glint(planAdded(KEY, false))!.x).toBeGreaterThan(KEY.x);
    expect(glint(planAdded(KEY, true))!.x).toBeLessThan(KEY.x);
    const splash = (plan: Plan) => plan.find((step) => step.fx === "splash");
    expect(splash(planToggle(TRACK, true, false))!.x).toBeGreaterThan(TRACK.x);
    expect(splash(planToggle(TRACK, true, true))!.x).toBeLessThan(TRACK.x);
    const ring = (plan: Plan) => plan.find((step) => step.fx === "ring");
    expect(ring(planComplete(BAR, false))!.x).toBe(BAR.x + BAR.w / 2);
    expect(ring(planComplete(BAR, true))!.x).toBe(BAR.x - BAR.w / 2);
    // a round mark completes round its centre
    expect(ring(planComplete(MARK, true))!.x).toBe(MARK.x);
  });

  it("unticking or switching off is one small puff; ticking is the drawn reaction", () => {
    expect(planCheck(BOX, false, false).map((s) => s.fx)).toEqual(["puff"]);
    expect(planToggle(TRACK, false, false).map((s) => s.fx)).toEqual(["puff"]);
    // off: the puff where the knob comes back to — the inline start
    expect(planToggle(TRACK, false, false)[0].x).toBeLessThan(TRACK.x);
    expect(planToggle(TRACK, false, true)[0].x).toBeGreaterThan(TRACK.x);
    expect(planCheck(BOX, true, false).filter((s) => s.fx === "slash")).toHaveLength(2);
  });

  it("stars light one after another, 45 ms apart; five stars add a ring and chips; none draws nothing", () => {
    const three = planRate(STARS.slice(0, 3), false).filter((s) => s.fx === "ticks");
    expect(three.map((s) => s.at)).toEqual([0, 45, 90]);
    expect(planRate(STARS.slice(0, 3), false).some((s) => s.fx === "ring")).toBe(false);
    expect(planRate(STARS, false).some((s) => s.fx === "ring")).toBe(true);
    expect(planRate([], false)).toEqual([]);
  });

  it("draws no lettering: the katakana sound effects stay off (the owner's switch)", () => {
    expect(LETTERING).toBe(false);
    for (const plan of Object.values(plans(true))) expect(plan.some((s) => s.fx === "sfx")).toBe(false);
  });
});

describe("2 · colours from the tokens, light and dark", () => {
  const tokens = uncommented(read("app/styles/tokens.css"));
  const block = (selector: string) => {
    const at = tokens.indexOf(`${selector} {`);
    return tokens.slice(at, tokens.indexOf("\n}", at));
  };

  it("the palette is read from the --fx-* tokens (null when one is missing: nothing is drawn in a foreign palette)", () => {
    const values: Record<string, string> = { "--fx-fill": " #fff", "--fx-shade": "#f9c4ca", "--fx-line": "#9e0b1e", "--fx-accent": "#e5132b", "--fx-ink": "#141518 " };
    expect(paletteFrom((name) => values[name] ?? "")).toEqual({ fill: "#fff", shade: "#f9c4ca", line: "#9e0b1e", accent: "#e5132b", ink: "#141518", sfx: ["#141518", "#fff"] });
    expect(paletteFrom((name) => (name === "--fx-accent" ? "" : (values[name] ?? "")))).toBeNull();
  });

  it("both themes define the five --fx-* tokens in the brand red family; dark has its own fill, shade and outline", () => {
    const light = block('[data-theme="light"]');
    const dark = block('[data-theme="dark"]');
    for (const name of ["--fx-fill", "--fx-shade", "--fx-line", "--fx-accent", "--fx-ink"]) {
      expect(light, name).toMatch(new RegExp(`${name}:`));
      expect(dark, name).toMatch(new RegExp(`${name}:`));
    }
    expect(light).toMatch(/--fx-line: var\(--red-deep\)/);
    expect(light).toMatch(/--fx-accent: var\(--red\)/);
    expect(dark).toMatch(/--fx-line: var\(--red\)/);
    expect(dark.match(/--fx-fill: (#[0-9a-f]+)/)?.[1]).not.toBe(light.match(/--fx-fill: (#[0-9a-f]+)/)?.[1]);
  });

  it("the canvas layer sits over dialogs and under the toasts and the fly bead", () => {
    const z = (name: string) => Number(tokens.match(new RegExp(`${name}: (\\d+)`))?.[1]);
    expect(z("--z-fx")).toBeGreaterThan(z("--z-dialog"));
    expect(z("--z-fx")).toBeLessThan(z("--z-toast"));
    expect(z("--z-fx")).toBeLessThan(z("--z-fly"));
  });
});

describe("3 · never on the server, never under reduced motion, never in the way", () => {
  const original = { window: globalThis.window, document: globalThis.document };
  afterEach(() => {
    Object.assign(globalThis, original);
  });

  it("does nothing on the server: no window, no import, no throw", () => {
    expect(typeof window).toBe("undefined");
    expect(canDraw()).toBe(false);
    expect(() => {
      sakuga.added(null);
      sakuga.check(null, true);
      sakuga.toggle(null, true);
      sakuga.rate([], 5);
      sakuga.toast(null);
      sakuga.complete(null);
      sakuga.warm();
    }).not.toThrow();
  });

  it("is off under prefers-reduced-motion and without matchMedia", () => {
    const stub = (matchMedia: unknown) =>
      Object.assign(globalThis, { window: { matchMedia }, document: { visibilityState: "visible" } });
    stub((query: string) => ({ matches: query.includes("reduce"), addEventListener() {} }));
    expect(canDraw()).toBe(false);
    stub(undefined);
    expect(canDraw()).toBe(false);
  });

  it("the canvas is never a target, sits at --z-fx and is never printed; fixed, it shifts nothing", () => {
    const pieces = uncommented(read("app/styles/pieces.css"));
    const rule = decls(pieces, ".sakuga-fx");
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/z-index:\s*var\(--z-fx\)/);
    expect(decls(media(pieces, "print"), ".sakuga-fx")).toMatch(/display:\s*none !important/);
  });

  it("the canvas's left edge is the viewport's left edge in RTL too (review 2026-11-17)", () => {
    // the core sizes the canvas to innerWidth, which counts a classic scrollbar; in an RTL page inset-inline-start is
    // the right edge, so the canvas hung ~17px past the left edge and every effect drew ~17px off its control. Its own
    // LTR direction maps inset-inline-start to the left, where the core's x = 0 is.
    const rule = decls(uncommented(read("app/styles/pieces.css")), ".sakuga-fx");
    expect(rule).toMatch(/direction:\s*ltr/);
    expect(rule).toMatch(/inset-inline-start:\s*0/);
  });

  it("the core marks its canvas aria-hidden and adds no stylesheet of its own", () => {
    const core = read("app/ui/sakuga/core.js");
    expect(core).toMatch(/setAttribute\('aria-hidden', 'true'\)/);
    expect(core).not.toMatch(/document\.head\.append/);
    expect(core).not.toMatch(/2147483000/);
  });
});

describe("4 · the vendored core: once, licensed, lazy", () => {
  it("carries the MIT licence, the upstream commit and what TamTam changed", () => {
    const core = read("app/ui/sakuga/core.js");
    expect(core).toContain("MIT License");
    expect(core).toContain("Copyright (c) 2026 Justin Finkelman");
    expect(core).toContain("c3dabb1");
    expect(core).toMatch(/What changed from upstream/);
  });

  it("is loaded only by fx.ts, with a dynamic import (its own chunk); no web component or toggle.js ships", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|js|mjs)$/.test(name)) files.push(full);
      }
    };
    walk(path.join(ROOT, "app"));
    const importers = files.filter((file) => /sakuga\/core|["']\.\/core\.js["']/.test(readFileSync(file, "utf8")) && !file.endsWith("core.d.ts"));
    expect(importers.map((file) => path.relative(ROOT, file).replace(/\\/g, "/"))).toEqual(["app/ui/sakuga/fx.ts"]);
    // the plans travel with the core: no file in app/ imports them for real (fx.ts only takes their types)
    const planUsers = files.filter((file) => /from ["'](~\/ui\/sakuga|\.)\/plans["']/.test(readFileSync(file, "utf8")));
    for (const file of planUsers) expect(readFileSync(file, "utf8"), file).toMatch(/import type \{[^}]*\} from ["']\.\/plans["']/);
    const fx = read("app/ui/sakuga/fx.ts");
    expect(fx).toMatch(/Promise\.all\(\[import\("\.\/core\.js"\), import\("\.\/plans"\)\]\)/);
    expect(fx).not.toMatch(/^import (?!type).*(core|plans)/m);
    expect(files.some((file) => /toggle\.js$|sakuga-(button|toggle|checkbox|rating|toast|progress)/.test(file))).toBe(false);
  });
});

describe("5 · the kit's hooks", () => {
  it("a confirmed add plays round the pressed key, measured before onAdded can swap it; the press warms the core", () => {
    const source = read("app/ui/AddToCartKey.tsx");
    const settle = source.slice(source.indexOf("const settle ="), source.indexOf("const run ="));
    expect(settle.indexOf("sakuga.added(key)")).toBeGreaterThan(0);
    expect(settle.indexOf("sakuga.added(key)")).toBeLessThan(settle.indexOf("confirmed?.("));
    // a failure draws nothing
    expect(settle.slice(settle.indexOf("const reason ="))).not.toContain("sakuga");
    expect(source).toMatch(/pressed\.current = event\.currentTarget;\s*sakuga\.warm\(event\.currentTarget\)/);
  });

  it("a checkbox and a switch play on the shopper's change, after the caller's own onChange", () => {
    const field = read("app/ui/Field.tsx");
    expect(field).toMatch(/input\.onChange\?\.\(event\);\s*\/\/[^\n]*\n\s*sakuga\.check\(event\.currentTarget\.nextElementSibling, event\.currentTarget\.checked\)/);
    expect(field).toMatch(/input\.onChange\?\.\(event\);\s*sakuga\.toggle\(event\.currentTarget\.nextElementSibling, event\.currentTarget\.checked\)/);
  });

  it("a toast lands in dust (not an error), a success mark and a finished upload complete, a chosen rating pops", () => {
    expect(read("app/ui/Toast.tsx")).toMatch(/if \(toast\.kind !== "error"\) sakuga\.toast\(element\)/);
    expect(read("app/ui/SuccessMark.tsx")).toMatch(/sakuga\.complete\(mark\.current\)/);
    // review 2026-11-17: the mark is often the page's first moment (an order landing): it starts fetching the core when it
    // mounts, 280 ms ahead, so the moment is not dropped as late (fx.ts LATE_MS)
    expect(read("app/ui/SuccessMark.tsx")).toMatch(/sakuga\.warm\(mark\.current\);\s*const timer/);
    const proof = read("app/ui/ProofUploader.tsx");
    expect(proof.indexOf("sakuga.complete(bar.current)")).toBeLessThan(proof.indexOf('dispatch({ type: "done"'));
    expect(read("app/routes/storefront/account/components/OrderReviews.tsx")).toMatch(/sakuga\.rate\(\[\.\.\.row\.querySelectorAll\("\.acct-star"\)\], n\)/);
  });

  it("a toaster can opt out of the moments (the admin's toasts portal to <body>, outside its density)", () => {
    const source = read("app/ui/Toast.tsx");
    expect(source).toMatch(/fx\?: boolean/);
    expect(source).toMatch(/data-fx=\{fx \? undefined : "off"\}/);
  });

  it("the markup is unchanged where the moments are added (nothing rendered on the server)", () => {
    const html = renderKit(createElement(Checkbox, { label: "x", name: "x" }));
    expect(html).not.toMatch(/sakuga|canvas/);
  });
});

describe("6 · the kit's small requests (polish 2026-11-17)", () => {
  const components = uncommented(read("app/styles/components.css"));
  const materials = uncommented(read("app/styles/materials.css"));

  it("a: every trail keeps each crumb's words on one line", () => {
    expect(decls(components, ".crumbs__list > li")).toMatch(/white-space:\s*nowrap/);
  });

  it("b: the compatibility note reads at 16 up to 1023, and the device hub's override is gone", () => {
    expect(decls(media(components, "(max-width: 63.99rem)"), ".compat-badge__note")).toMatch(/font:\s*var\(--type-read\)/);
    expect(uncommented(read("app/routes/storefront/devices/devices.css"))).not.toMatch(/compat-badge__note/);
  });

  it("c: more contrast takes the gloss's light off every glossy band; the account's own rule is gone", () => {
    expect(decls(media(materials, "(prefers-contrast: more)"), ".band.band--gloss")).toMatch(/background-image:\s*none/);
    expect(uncommented(read("app/routes/storefront/account/account.css"))).not.toMatch(/band--gloss/);
  });

  it("d: the admin's keys keep a 44px hit area with a mouse too; its dense menu rows tile a 44px pitch", () => {
    const admin = uncommented(read("app/styles/admin.css"));
    expect(decls(admin, '[data-density="admin"] .key::after')).toMatch(/inset-block:\s*min\(0px, calc\(\(100% - var\(--target\)\) \/ 2\)\)/);
    expect(media(admin, "(pointer: coarse)")).not.toMatch(/\.key::after/);
    const menu = read("app/ui/Menu.tsx");
    // 36px rows (min-h-9) + 4px above and below = 44; the ::after reaches across the gaps
    expect(menu).toMatch(/admin:pointer-fine:min-h-9/);
    expect(menu).toMatch(/admin:pointer-fine:my-1 admin:pointer-fine:after:absolute admin:pointer-fine:after:inset-x-0 admin:pointer-fine:after:-inset-y-1/);
  });

  it("e: a checkbox row can wear clay (the trade-in's .used-clay is gone); a disabled option's icon goes quiet by itself", () => {
    const html = renderKit(createElement(Checkbox, { label: "x", name: "x", row: true, clay: true }));
    expect(html).toContain('class="choice choice--row choice--check choice--clay"');
    // clay without row means nothing (the face belongs to the row)
    expect(renderKit(createElement(Checkbox, { label: "x", name: "x", clay: true }))).not.toContain("choice--clay");
    expect(read("app/routes/storefront/used/used.css")).not.toMatch(/used-clay|used-payout/);
    expect(read("app/routes/storefront/used/trade-in.tsx")).not.toContain("used-clay");
    expect(decls(components, ".choice:has(> .choice__input:disabled) > .choice__icon")).toMatch(/color:\s*var\(--ink-3\)/);
    const option = renderKit(createElement(OptionCard, { clay: true, icon: "wallet", name: "p", value: "w", label: "x", disabled: true }));
    expect(option).toContain('class="choice__icon"');
  });

  it("f: the order summary keeps a name's tokens whole whoever calls it; checkout's local line-height is gone", () => {
    const html = renderKit(
      createElement(OrderSummary, {
        subtotalIqd: 10_000,
        discountIqd: 0,
        shippingIqd: 0,
        totalIqd: 10_000,
        lines: [{ id: "l1", name: "Xbox Battery + USB-C Cable", optionsLabel: "Switch 2", lineTotalIqd: 10_000 }],
      }),
    );
    expect(html).toContain("USB‑C");
    expect(html).toContain("Switch 2");
    expect(uncommented(read("app/routes/storefront/checkout/checkout.css"))).not.toMatch(/\.co-missing \.key__label/);
  });
});
