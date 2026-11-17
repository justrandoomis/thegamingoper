/**
 * Drawn moments, site-wide (docs/DESIGN.md §7.4 "Every control", the owner's 2026-11-17 "effects on almost every button
 * and pages widely"): the press mapping per kit component (one `data-fx` attribute, one delegated listener), the new
 * plans (short, anchored, mirrored in RTL), keyboard parity (the listener reacts to `click`, which Enter and Space fire
 * too), the guards (reduced motion, lite, admin, `[data-fx="off"]`, print), the card tilt, the caret dust, the CSS
 * layer (transform/opacity only, full tier only), and the page transition's slide with its opt-outs.
 *
 *   npx vitest run tests/sakuga-press.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { messagesFor } from "~/i18n/i18n.server";
import { LOCALES, localePath, type Locale } from "~/lib/locales";
import { CarouselDots } from "~/ui/Carousel";
import { Chip, ChipGroup } from "~/ui/Chip";
import { Radio, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key, keyFx } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { canDraw, sakuga } from "~/ui/sakuga/fx";
import { MOMENT_MS, planDot, planDust, planEnd, planEnter, planLand, planPress, planTick, planWish, type Box, type Plan } from "~/ui/sakuga/plans";
import { caretPoint, installMoments, pressOf, tiltOf, TYPE_GAP_MS, type MomentsFx } from "~/ui/sakuga/press";
import { Stepper } from "~/ui/Stepper";
import { TextLink } from "~/ui/TextLink";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

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
/** The data-fx values of every element in some markup, in order. */
const fxIn = (html: string) => [...html.matchAll(/data-fx="([^"]*)"/g)].map((m) => m[1]);

/* ───────────────────────────── a tiny DOM stand-in for the delegated listener ───────────────────────────── */

type Attrs = Record<string, string>;
class FakeEl {
  parent: FakeEl | null = null;
  disabled = false;
  value = "";
  selectionStart: number | null = null;
  readOnly = false;
  checked = false;
  nextElementSibling: FakeEl | null = null;
  constructor(
    readonly tagName: string,
    readonly attrs: Attrs = {},
    readonly classes: string[] = [],
  ) {}
  get type() {
    return this.attrs.type ?? "";
  }
  getAttribute(name: string) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  hasAttribute(name: string) {
    return name in this.attrs;
  }
  /** Enough of `closest` for the selectors the listener uses: [attr], [attr="v"], .class, tag, and comma lists. */
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const s = part.trim();
      const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
      if (attr) return attr[2] === undefined ? attr[1] in this.attrs : this.attrs[attr[1]] === attr[2];
      if (s.startsWith(".")) return this.classes.includes(s.slice(1));
      return this.tagName.toLowerCase() === s.toLowerCase();
    });
  }
  closest(selector: string): FakeEl | null {
    for (let node: FakeEl | null = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  in(parent: FakeEl): this {
    this.parent = parent;
    return this;
  }
}

type Listener = { type: string; fn: (event: unknown) => void; options: unknown };
function fakeDocument() {
  const listeners: Listener[] = [];
  return {
    listeners,
    addEventListener(type: string, fn: (event: unknown) => void, options: unknown) {
      listeners.push({ type, fn, options });
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire(type: string, event: unknown) {
      for (const l of listeners.filter((x) => x.type === type)) l.fn(event);
    },
  };
}
function recorder() {
  const calls: string[] = [];
  const fx: MomentsFx = {
    warm: () => calls.push("warm"),
    press: (_el, kind) => calls.push(`press:${kind}`),
    wish: (_el, on) => calls.push(`wish:${on}`),
    dot: () => calls.push("dot"),
    dust: () => calls.push("dust"),
    spring: () => calls.push("spring"),
  };
  return { calls, fx };
}

/* ───────────────────────────── 1 · the press mapping per component ───────────────────────────── */

describe("1 · every kit control says which drawn press it gets (one attribute, set in the kit)", () => {
  it("keys: primary and on-band burst; secondary and ghost fan; danger draws nothing", () => {
    expect(keyFx("primary")).toBe("burst");
    expect(keyFx("onBand")).toBe("burst");
    expect(keyFx("secondary")).toBe("fan");
    expect(keyFx("ghost")).toBe("fan");
    expect(keyFx("danger")).toBe("none");
    expect(fxIn(renderKit(createElement(Key, { variant: "primary" }, "x")))).toEqual(["burst"]);
    expect(fxIn(renderKit(createElement(Key, { variant: "commit" }, "x")))).toEqual(["burst"]);
    expect(fxIn(renderKit(createElement(Key, {}, "x")))).toEqual(["fan"]);
    expect(fxIn(renderKit(createElement(Key, { variant: "danger" }, "x")))).toEqual(["none"]);
    // a caller can override it (the add key: its own confirmed moment plays instead)
    expect(fxIn(renderKit(createElement(Key, { variant: "primary", "data-fx": "none" } as never, "x")))).toEqual(["none"]);
  });

  it("icon keys pop; the wishlist heart is its own kind; the card add and the add key keep their confirmed moment", () => {
    expect(fxIn(renderKit(createElement(IconKey, { icon: "x", label: "close" })))).toEqual(["pop"]);
    expect(read("app/ui/WishlistKey.tsx").match(/data-fx="wish"/g)?.length).toBe(2);
    const add = read("app/ui/AddToCartKey.tsx");
    expect(add.match(/data-fx="none"/g)?.length).toBe(2);
  });

  it("chips fan (buttons, inputs and a chip group); pagination keys are keys; carousel dots and thumbnails pop", () => {
    expect(fxIn(renderKit(createElement(Chip, {} as never, "x")))).toEqual(["fan"]);
    expect(fxIn(renderKit(createElement(Chip, { input: "checkbox", name: "c", value: "v" } as never, "x")))).toEqual(["fan"]);
    expect(fxIn(renderKit(createElement(ChipGroup, { options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], "aria-label": "g" })))).toEqual(["fan", "fan"]);
    const pages = fxIn(renderKit(createElement(Pagination, { page: 2, pageCount: 4, onPage: () => {} })));
    expect(pages).toContain("pop"); // the arrows
    expect(pages).toContain("fan"); // the numbers
    const api = { count: 3, index: 0, running: false, autoplay: 0, stop() {}, goTo() {} };
    expect(fxIn(renderKit(createElement(CarouselDots, { api } as never)))).toEqual(["pop", "pop", "pop"]);
    expect(read("app/ui/Gallery.tsx")).toMatch(/className="thumb" data-press="soft" data-fx="pop"/);
  });

  it("menu rows and swatches pop; a text link fans only when it is a button", () => {
    expect(read("app/ui/Menu.tsx")).toMatch(/"data-fx": "pop"/);
    expect(read("app/ui/Swatch.tsx")).toMatch(/data-fx="pop"/);
    expect(fxIn(renderKit(createElement(TextLink, { as: "button", type: "button" } as never, "undo")))).toEqual(["fan"]);
    expect(fxIn(renderKit(createElement(TextLink, { href: "/x" } as never, "more")))).toEqual([]);
  });

  it("the stepper's keys leave it to the stepper (tick + puff on the value, any way it changes)", () => {
    expect(fxIn(renderKit(createElement(Stepper, { defaultValue: 2 })))).toEqual(["none", "none"]);
    const stepper = read("app/ui/Stepper.tsx");
    expect(stepper).toMatch(/sakuga\.tick\(number\.current\)/);
    expect(stepper).toMatch(/sakuga\.spring\(number\.current\)/);
  });

  it("radios and option cards: the dot springs and fans (on change: pointer, Space and the arrow keys alike)", () => {
    expect(fxIn(renderKit(createElement(Radio, { label: "x", name: "r", value: "a" })))).toEqual(["dot"]);
  });

  it("tabs and segmented: the indicator stretches as it slides and lands in wedges (indicator.ts, on a change only)", () => {
    const indicator = read("app/ui/indicator.ts");
    expect(indicator).toMatch(/sakuga\.land\(item, /);
    expect(indicator).toMatch(/sakuga\.spring\(element\.querySelector\(/);
    // never on the first placement, a font swap or a resize: only when the current item changed
    expect(indicator).toMatch(/if \(moved\)/);
  });

  it("text fields carry no attribute: the listener types dust into text and search fields only", () => {
    expect(fxIn(renderKit(createElement(TextField, { label: "x", name: "x" })))).toEqual([]);
  });

  it("the product card tilts under a fine pointer with a glare layer; an empty state has its entrance", () => {
    const card = read("app/ui/ProductCard.tsx");
    expect(card).toMatch(/data-fx-tilt=""/);
    expect(card).toMatch(/className="pcard__glare" aria-hidden="true"/);
    expect(read("app/ui/EmptyState.tsx")).toMatch(/sakuga\.enter\(/);
  });

  it("the cart bead bounces when its count changes (not while a bead is flying in: the fly squishes it)", () => {
    for (const file of ["app/routes/storefront/shell/Header.tsx", "app/routes/storefront/shell/TabBar.tsx"]) expect(read(file), file).toMatch(/useBounce\(/);
    expect(read("app/ui/sakuga/press.ts")).toMatch(/\.tt-fly/);
  });
});

/* ───────────────────────────── 2 · the delegated listener ───────────────────────────── */

describe("2 · one passive delegated listener; keyboard activation draws exactly what a pointer does", () => {
  it("every listener is passive and captured, and uninstalling removes them all", () => {
    const doc = fakeDocument();
    const off = installMoments(doc as never, recorder().fx);
    expect(doc.listeners.length).toBeGreaterThan(0);
    for (const l of doc.listeners) expect(l.options, l.type).toMatchObject({ passive: true, capture: true });
    off();
    expect(doc.listeners).toHaveLength(0);
  });

  it("reacts to click — which Enter and Space fire too — so a keyboard press (detail 0) draws the same as a tap", () => {
    const doc = fakeDocument();
    const { calls, fx } = recorder();
    installMoments(doc as never, fx);
    const key = new FakeEl("BUTTON", { "data-fx": "burst" });
    const label = new FakeEl("SPAN").in(key);
    doc.fire("click", { target: label, detail: 1 });
    doc.fire("click", { target: label, detail: 0 });
    expect(calls).toEqual(["press:burst", "press:burst"]);
    expect(doc.listeners.some((l) => l.type === "keydown" || l.type === "keyup")).toBe(false);
  });

  it("maps each kind, skips disabled controls and non-controls, and finds the control from inside it", () => {
    const doc = fakeDocument();
    const { calls, fx } = recorder();
    installMoments(doc as never, fx);
    const fan = new FakeEl("A", { "data-fx": "fan", href: "/x" });
    const pop = new FakeEl("BUTTON", { "data-fx": "pop" });
    const none = new FakeEl("BUTTON", { "data-fx": "none" });
    const disabled = new FakeEl("BUTTON", { "data-fx": "burst" });
    disabled.disabled = true;
    const ariaDisabled = new FakeEl("A", { "data-fx": "fan", "aria-disabled": "true" });
    const span = new FakeEl("SPAN", { "data-fx": "fan" }); // the pagination's current page: not a control
    const container = new FakeEl("DIV", { "data-fx": "off" });
    for (const target of [fan, pop, none, disabled, ariaDisabled, span, container]) doc.fire("click", { target, detail: 1 });
    expect(calls).toEqual(["press:fan", "press:pop"]);
  });

  it("the wishlist heart draws its burst when it is turning ON (aria-pressed was false), a puff when turning off", () => {
    const doc = fakeDocument();
    const { calls, fx } = recorder();
    installMoments(doc as never, fx);
    doc.fire("click", { target: new FakeEl("BUTTON", { "data-fx": "wish", "aria-pressed": "false" }), detail: 0 });
    doc.fire("click", { target: new FakeEl("BUTTON", { "data-fx": "wish", "aria-pressed": "true" }), detail: 1 });
    expect(calls).toEqual(["wish:true", "wish:false"]);
  });

  it("a pointerdown on a control warms the core (the click's moment is not dropped as late)", () => {
    const doc = fakeDocument();
    const { calls, fx } = recorder();
    installMoments(doc as never, fx);
    doc.fire("pointerdown", { target: new FakeEl("BUTTON", { "data-fx": "fan" }), pointerType: "touch" });
    expect(calls).toEqual(["warm"]);
  });

  it("review: a label-wrapped control (an input chip) whose input is disabled draws nothing — on the label or the input", () => {
    const doc = fakeDocument();
    const { calls, fx } = recorder();
    installMoments(doc as never, fx);
    const label = new FakeEl("LABEL", { "data-fx": "fan" });
    const input = new FakeEl("INPUT", { type: "checkbox" }).in(label);
    input.disabled = true;
    (label as unknown as { control: FakeEl }).control = input;
    const text = new FakeEl("SPAN").in(label);
    doc.fire("click", { target: text, detail: 1 });
    doc.fire("click", { target: input, detail: 1 });
    doc.fire("pointerdown", { target: text, pointerType: "mouse" });
    expect(calls).toEqual([]);
    input.disabled = false;
    doc.fire("click", { target: text, detail: 1 });
    expect(calls).toEqual(["press:fan"]);
  });

  it("review: the stepper ticks only for a step the shopper took, never for a value set from outside (a reset, a server clamp)", () => {
    const stepper = read("app/ui/Stepper.tsx");
    expect(stepper).toMatch(/stepped\.current = true/);
    expect(stepper).toMatch(/if \(!stepped\.current\) return;/);
  });

  it("review: an empty state already on the page when it loads does not pop in after hydration (only one that arrives later)", () => {
    const empty = read("app/ui/EmptyState.tsx");
    expect(empty).toMatch(/data-motion-ready/);
    expect(empty).toMatch(/if \(!arrived\.current\) return;/);
  });

  it("review: the cap's overshoot fits inside the engine's release (data-released is removed when tt-press-out ends)", () => {
    expect(read("app/styles/pieces.css")).toMatch(/fx-squash-out var\(--motion-spring-press-duration\)/);
  });

  it("a radio that becomes checked springs its dot and fans; an unchecked change or a checkbox does not", () => {
    const doc = fakeDocument();
    const { calls, fx } = recorder();
    installMoments(doc as never, fx);
    const label = new FakeEl("LABEL", { "data-fx": "dot" });
    const radio = new FakeEl("INPUT", { type: "radio" }).in(label);
    radio.nextElementSibling = new FakeEl("SPAN", {}, ["choice__box"]);
    radio.checked = true;
    doc.fire("change", { target: radio });
    radio.checked = false;
    doc.fire("change", { target: radio });
    const box = new FakeEl("INPUT", { type: "checkbox" }).in(label);
    box.checked = true;
    doc.fire("change", { target: box });
    expect(calls).toEqual(["spring", "dot"]);
  });

  it("dust only for text and search fields, never a password, a number, a read-only field or a code field", () => {
    expect(pressOf(new FakeEl("BUTTON", { "data-fx": "fan" }) as never)?.fx).toBe("fan");
    const doc = fakeDocument();
    const { calls, fx } = recorder();
    installMoments(doc as never, fx);
    const field = (type: string, extra: Attrs = {}) => {
      const input = new FakeEl("INPUT", { type, ...extra });
      input.value = "abc";
      input.selectionStart = 3;
      return input;
    };
    const readOnly = field("text");
    readOnly.readOnly = true;
    for (const target of [field("password"), field("number"), field("email"), readOnly, field("text", { "data-fx": "none" })]) doc.fire("input", { target, inputType: "insertText" });
    expect(calls).toEqual([]);
  });

  it("typing is throttled per field (at most one puff each TYPE_GAP_MS)", () => {
    expect(TYPE_GAP_MS).toBeGreaterThanOrEqual(60);
    expect(TYPE_GAP_MS).toBeLessThanOrEqual(200);
  });
});

/* ───────────────────────────── 3 · the plans ───────────────────────────── */

const KEY: Box = { x: 500, y: 400, w: 180, h: 48 };
const ICON: Box = { x: 500, y: 400, w: 44, h: 44 };
const TAB: Box = { x: 500, y: 300, w: 96, h: 44 };
const DOT: Box = { x: 300, y: 300, w: 20, h: 20 };
const VALUE: Box = { x: 300, y: 300, w: 32, h: 40 };
const ART: Box = { x: 600, y: 300, w: 132, h: 132 };

const newPlans = (rtl: boolean): Record<string, [Plan, Box]> => ({
  burst: [planPress("burst", KEY, rtl), KEY],
  fan: [planPress("fan", KEY, rtl), KEY],
  pop: [planPress("pop", ICON, rtl), ICON],
  wishOn: [planWish(ICON, true, rtl), ICON],
  wishOff: [planWish(ICON, false, rtl), ICON],
  landRight: [planLand(TAB, 1), TAB],
  landLeft: [planLand(TAB, -1), TAB],
  dot: [planDot(DOT, rtl), DOT],
  dust: [planDust({ x: 420, y: 310 }), { x: 420, y: 310, w: 2, h: 20 }],
  tick: [planTick(VALUE, rtl), VALUE],
  enter: [planEnter(ART, rtl), ART],
});

describe("3 · the new moments are short, small, anchored and mirrored", () => {
  it("every one ends within 600 ms in both directions; none is empty", () => {
    for (const rtl of [false, true])
      for (const [name, [plan]] of Object.entries(newPlans(rtl))) {
        expect(plan.length, name).toBeGreaterThan(0);
        expect(planEnd(plan), `${name} rtl=${rtl}`).toBeLessThanOrEqual(MOMENT_MS);
      }
  });

  it("every effect starts on or beside its control (within 60px of its box)", () => {
    for (const rtl of [false, true])
      for (const [name, [plan, b]] of Object.entries(newPlans(rtl)))
        for (const step of plan) {
          expect(Math.abs(step.x - b.x), `${name} x`).toBeLessThanOrEqual(b.w / 2 + 60);
          expect(Math.abs(step.y - b.y), `${name} y`).toBeLessThanOrEqual(b.h / 2 + 60);
        }
  });

  it("the burst and the fan sit at the key's END corner, so they mirror in RTL; nothing big covers the label", () => {
    for (const kind of ["burst", "fan"] as const) {
      const ltr = planPress(kind, KEY, false);
      const rtl = planPress(kind, KEY, true);
      const lead = (plan: Plan) => plan.find((s) => s.fx === "burst" || s.fx === "ticks")!;
      expect(lead(ltr).x, kind).toBeGreaterThan(KEY.x);
      expect(lead(rtl).x, kind).toBeLessThan(KEY.x);
      expect(lead(rtl).x - KEY.x).toBeCloseTo(-(lead(ltr).x - KEY.x));
    }
    const burst = planPress("burst", KEY, false).find((s) => s.fx === "burst")!;
    expect(Number(burst.o.r)).toBeLessThanOrEqual(22);
  });

  it("the tab indicator lands in wedges at its leading edge, in the direction it travelled (physical, so RTL is right)", () => {
    const right = planLand(TAB, 1).find((s) => s.fx === "ticks")!;
    const left = planLand(TAB, -1).find((s) => s.fx === "ticks")!;
    expect(right.x).toBeGreaterThan(TAB.x);
    expect(left.x).toBeLessThan(TAB.x);
    expect(right.at ?? 0).toBeGreaterThan(0); // after the slide has (nearly) landed
  });

  it("the heart's burst is shapes, no lettering; turning it off is one small puff", () => {
    const on = planWish(ICON, true, false);
    expect(on.map((s) => s.fx)).toEqual(expect.arrayContaining(["shards", "kira"]));
    expect(on.some((s) => s.fx === "sfx")).toBe(false);
    expect(planWish(ICON, false, false).map((s) => s.fx)).toEqual(["puff"]);
  });

  it("typing dust is tiny (one small puff)", () => {
    const dust = planDust({ x: 10, y: 10 });
    expect(dust).toHaveLength(1);
    expect(Number(dust[0].o.size)).toBeLessThanOrEqual(3.5);
  });
});

/* ───────────────────────────── 4 · caret and tilt (pure) ───────────────────────────── */

describe("4 · where the caret is and how far a card tilts", () => {
  const field = { left: 100, right: 400, top: 50, bottom: 98 };
  it("the caret dust sits after the typed text from the field's START edge: the left in LTR, the right in RTL", () => {
    const ltr = caretPoint(field, { start: 16, end: 16 }, 40, false);
    const rtl = caretPoint(field, { start: 16, end: 16 }, 40, true);
    expect(ltr.x).toBe(100 + 16 + 40);
    expect(rtl.x).toBe(400 - 16 - 40);
    expect(ltr.y).toBe(rtl.y);
  });
  it("a long text clamps the caret inside the field's padding box", () => {
    expect(caretPoint(field, { start: 16, end: 16 }, 900, false).x).toBe(400 - 16);
    expect(caretPoint(field, { start: 16, end: 16 }, 900, true).x).toBe(100 + 16);
  });
  it("the tilt is gentle (at most 4°), zero at the centre, and follows the pointer physically (no RTL flip)", () => {
    const rect = { left: 0, top: 0, width: 200, height: 300 };
    expect(tiltOf(rect, 100, 150)).toMatchObject({ rx: 0, ry: 0 });
    const corner = tiltOf(rect, 200, 0);
    expect(Math.abs(corner.rx)).toBeLessThanOrEqual(4);
    expect(Math.abs(corner.ry)).toBeLessThanOrEqual(4);
    expect(corner.ry).toBeGreaterThan(0); // the right edge comes toward the pointer
    expect(corner.rx).toBeGreaterThan(0); // the top edge too
    expect(corner.gx).toBe(200);
    expect(corner.gy).toBe(0);
  });
});

/* ───────────────────────────── 5 · off where it must be ───────────────────────────── */

describe("5 · off under reduced motion, lite, admin, [data-fx=off], print, and on the server", () => {
  const original = { window: globalThis.window, document: globalThis.document };
  afterEach(() => {
    Object.assign(globalThis, original);
  });

  it("the new API does nothing on the server (no window): no throw", () => {
    expect(() => {
      sakuga.press(null, "burst");
      sakuga.wish(null, true);
      sakuga.land(null, 1);
      sakuga.dot(null);
      sakuga.dust(null, { x: 0, y: 0 });
      sakuga.tick(null);
      sakuga.enter(null);
      sakuga.spring(null);
    }).not.toThrow();
  });

  it("nothing inside the admin or a [data-fx=off] subtree, nothing under reduced motion", () => {
    const anchor = (inside: string | null) => ({ closest: (selector: string) => (inside && selector.includes(inside) ? {} : null) });
    Object.assign(globalThis, {
      window: { matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {} }) },
      document: { visibilityState: "visible", documentElement: { getAttribute: () => "full" } },
    });
    expect(canDraw(anchor('[data-density="admin"]') as never)).toBe(false);
    expect(canDraw(anchor('[data-fx="off"]') as never)).toBe(false);
    Object.assign(globalThis, { window: { matchMedia: (q: string) => ({ matches: q.includes("reduce"), addEventListener() {} }) } });
    expect(canDraw(anchor(null) as never)).toBe(false);
  });

  it("the CSS side (squash, stretch, springs, tilt, glare, entrance, bead) lives only under the full tier, never in the admin, and moves transform/opacity only", () => {
    const raw = read("app/styles/pieces.css");
    const at = raw.indexOf("drawn presses");
    expect(at).toBeGreaterThan(-1);
    const block = raw.slice(raw.lastIndexOf("/*", at));
    const rules = uncommented(block).split("@media print")[0];
    for (const m of rules.matchAll(/([^{}@]+)\{[^{}]*\}/g)) {
      const selector = m[1].trim();
      if (!selector || /^(from|to|\d+%)/.test(selector) || selector.startsWith("@")) continue;
      expect(selector, selector).toMatch(/html\[data-motion="full"\]/);
      expect(selector, selector).toMatch(/:not\(\[data-density="admin"\] \*\)|data-density/);
    }
    for (const m of rules.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)) expect(m[1]).not.toMatch(/(?:^|[\s;{])(width|height|top|left|right|bottom|margin|padding|inset)[\w-]*\s*:/);
    // the whole layer sits in a no-preference media query (no flash before the tier script)
    expect(block).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
  });

  it("the canvas and the glare are never printed", () => {
    const pieces = read("app/styles/pieces.css");
    expect(pieces).toMatch(/@media print \{[^}]*\.pcard__glare/);
  });
});

/* ───────────────────────────── 6 · pages: the route slide, its opt-outs ───────────────────────────── */

describe("6 · route transitions slide a little toward the reading direction, and opt out cleanly", () => {
  const motion = read("app/motion/motion.css");
  it("the default (fade) page change slides in from the inline end (mirrored by --motion-dir), back from the start", () => {
    expect(motion).toMatch(/@keyframes tt-fade-slide-in \{\s*from \{[^}]*translate:\s*calc\(var\(--motion-dir\) \* var\((--motion-travel-fadeX)\)\)/);
    expect(motion).toMatch(/\[data-nav="fade"\]\[data-nav-dir="back"\]::view-transition-new\(root\)/);
    expect(read("app/motion/motion.css")).toMatch(/:root\[dir="rtl"\] \{\s*--motion-dir: -1;/);
  });
  it("the sideways part is the full tier's only; reduced motion keeps the 120 ms cross-fade with no travel", () => {
    expect(motion).toMatch(/html\[data-motion="full"\]\[data-nav="fade"\]::view-transition-new\(root\)/);
    expect(motion).toMatch(/html\[data-motion="reduced"\]\[data-nav\]::view-transition-new\(root\) \{\s*transform: none;\s*translate: none;/);
  });
  it("a link can opt out of the page transition with data-nav=\"none\" (React Router's own viewTransition is never used beside it)", () => {
    const root = read("app/motion/root.tsx");
    expect(root).toMatch(/\[data-nav="none"\]/);
    expect(root).toMatch(/optOutNextNav\(\)/);
    const state = read("app/motion/nav-state.ts");
    expect(state).toMatch(/export function optOutNextNav/);
    expect(state).toMatch(/if \(optedOut\(\)\) return null;/);
  });
});
