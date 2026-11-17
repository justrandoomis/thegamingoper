import { getMotionTier } from "~/motion/env";
import type { Box, FxName, Plan, PressKind, Step } from "./plans";

/**
 * Drawn moments — sakuga-style reactions at six key moments (docs/DESIGN.md §7.4; the owner's decision 2026-11-17,
 * "effects on key moments"). The Clay & Glass controls stay exactly as they are; at the moment one of them CONFIRMS
 * something, a few hand-drawn effects (puffs, chips, slashes, a splash, wedges, a glint) play around it for at most
 * 600 ms, in the brand red family, on one canvas over the page:
 *
 *   sakuga.added(keyEl)              a server-confirmed add to the cart (AddToCartKey, the card add button)
 *   sakuga.check(boxEl, checked)     a checkbox the shopper ticked (Field <Checkbox>; unticking: one small puff)
 *   sakuga.toggle(trackEl, on)       a switch the shopper flipped (Field <Switch>)
 *   sakuga.rate(starEls, n)          a star rating chosen (the account's «قيّم ما استلمته»; five stars: a ring)
 *   sakuga.toast(cardEl)             a toast landing (Toast; not the error kind — an error is no celebration)
 *   sakuga.complete(el)              progress completing (<SuccessMark> once, a proof upload reaching 100%)
 *
 * The rules, all enforced here so a caller cannot get them wrong:
 *  - decoration only: the state change, the announcement and focus never wait for it, and it never takes input (the
 *    canvas is `pointer-events: none`, aria-hidden, print-hidden — app/styles/pieces.css `.sakuga-fx`);
 *  - never on the server, and nothing at all under `prefers-reduced-motion`, on the engine's lite or reduced tier,
 *    without `matchMedia`, in a hidden tab, in the admin (`[data-density="admin"]`) or under `[data-fx="off"]`;
 *  - the vendored core (./core.js, MIT) and the choreography (./plans.ts) are fetched with one dynamic import on the
 *    first moment — their own chunks, never in a route's initial bundle (this file is all a page carries: the guards
 *    and the measuring). A moment whose code arrives more than LATE_MS after it is dropped, not drawn late;
 *  - recoloured on every moment from the --fx-* tokens of the control's own theme (tokens.css: light and dark), so a
 *    dark island draws dark-theme effects; anchored to the control's box in page coordinates, mirrored in RTL.
 */

/** The first moment waits for the code at most this long; later it is dropped (it would no longer belong to the tap). */
export const LATE_MS = 350;
/** The same control again within this many ms draws nothing more (a double tap is not two celebrations). */
const AGAIN_MS = 120;

/* ───────────────────────────── the palette (pure) ───────────────────────────── */

export type Palette = { fill: string; shade: string; line: string; accent: string; ink: string; sfx: [string, string] };

/** The core's palette from the --fx-* tokens (read through `read`, e.g. a computed style); null when any is missing. */
export function paletteFrom(read: (name: string) => string): Palette | null {
  const fill = read("--fx-fill").trim();
  const shade = read("--fx-shade").trim();
  const line = read("--fx-line").trim();
  const accent = read("--fx-accent").trim();
  const ink = read("--fx-ink").trim();
  if (!fill || !shade || !line || !accent || !ink) return null;
  return { fill, shade, line, accent, ink, sfx: [ink, fill] };
}

/* ───────────────────────────── the browser side ───────────────────────────── */

type CoreOptions = Record<string, number | string | boolean>;
type CoreDraw = (x: number, y: number, options?: CoreOptions) => void;
/** What ./core.js puts on `window.SakugaFX` (the part this module uses). */
export type SakugaApi = {
  readonly P: Palette;
  readonly calm: boolean;
  later: (ms: number, run: () => void) => void;
  sfx: (name: string, x: number, y: number, options?: CoreOptions) => void;
} & Record<Exclude<FxName, "sfx">, CoreDraw>;

declare global {
  interface Window {
    SakugaFX?: SakugaApi;
  }
}

type Plans = typeof import("./plans");
type Loaded = { api: SakugaApi; plans: Plans };

/** Where the moments never play: the dense admin, and any subtree that opts out. */
const OFF = '[data-density="admin"], [data-fx="off"]';

/** Whether a moment may draw now (browser, motion allowed, full tier, visible tab, not opted out). */
export function canDraw(anchor?: Element | null): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (anchor && anchor.closest(OFF)) return false;
  if (document.visibilityState === "hidden") return false;
  return getMotionTier() === "full";
}

let loading: Promise<Loaded | null> | null = null;

/** Fetch the core and the plans once (their own chunks). A failed fetch (offline, a new deploy) may be retried later. */
function load(): Promise<Loaded | null> {
  if (!loading) {
    loading = Promise.all([import("./core.js"), import("./plans")]).then(
      ([, plans]) => (window.SakugaFX ? { api: window.SakugaFX, plans } : null),
      () => {
        loading = null;
        return null;
      },
    );
  }
  return loading;
}

const lastAt = new WeakMap<Element, number>();

function boxOf(element: Element): Box | null {
  const r = element.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  // off screen (scrolled away, or a proof upload finishing behind the fold): nothing to see
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null;
  return { x: r.left + window.scrollX + r.width / 2, y: r.top + window.scrollY + r.height / 2, w: r.width, h: r.height };
}

function draw(api: SakugaApi, lettering: boolean, step: Step): void {
  if (step.fx === "sfx") {
    if (lettering && step.word) api.sfx(step.word, step.x, step.y, step.o);
    return;
  }
  // a glint "in the accent" (the wishlist's red glints): the core takes a colour, the plan names the token
  api[step.fx](step.x, step.y, step.o.col === "accent" ? { ...step.o, col: api.P.accent } : step.o);
}

/**
 * Plays a moment around `anchor`. Measures now (the control's box, its direction and its theme's tokens), then plans and
 * draws once the code is here — or drops it when the code is later than LATE_MS.
 */
function play(anchor: Element | null | undefined, build: (plans: Plans, box: Box, rtl: boolean) => Plan, again = false): void {
  if (!anchor || !canDraw(anchor)) return;
  const now = performance.now();
  const before = lastAt.get(anchor);
  if (!again && before !== undefined && now - before < AGAIN_MS) return;
  lastAt.set(anchor, now);
  const box = boxOf(anchor);
  if (!box) return;
  const style = window.getComputedStyle(anchor);
  const palette = paletteFrom((name) => style.getPropertyValue(name));
  if (!palette) return;
  const rtl = style.direction === "rtl";
  void load().then((loaded) => {
    if (!loaded || loaded.api.calm || performance.now() - now > LATE_MS) return;
    const { api, plans } = loaded;
    const plan = build(plans, box, rtl);
    Object.assign(api.P, palette);
    for (const step of plan) {
      if (step.at) api.later(step.at, () => draw(api, plans.LETTERING, step));
      else draw(api, plans.LETTERING, step);
    }
  });
}

export const sakuga = {
  /** Start fetching the code when a moment is likely soon (an add was pressed; the confirmation follows). */
  warm(anchor?: Element | null): void {
    if (canDraw(anchor)) void load();
  },
  added(key: Element | null | undefined): void {
    play(key, (p, box, rtl) => p.planAdded(box, rtl));
  },
  check(box: Element | null | undefined, checked: boolean): void {
    play(box, (p, b, rtl) => p.planCheck(b, checked, rtl));
  },
  toggle(track: Element | null | undefined, on: boolean): void {
    play(track, (p, b, rtl) => p.planToggle(b, on, rtl));
  },
  /** `stars`: the five star elements in order; `n`: the rating chosen (1–5). */
  rate(stars: readonly Element[], n: number): void {
    const chosen = stars.slice(0, Math.max(0, Math.min(5, Math.trunc(n))));
    const last = chosen[chosen.length - 1];
    if (!last || !canDraw(last)) return;
    const boxes = chosen.map(boxOf).filter((box): box is Box => box !== null);
    play(last, (p, _, rtl) => p.planRate(boxes, rtl));
  },
  toast(card: Element | null | undefined): void {
    play(card, (p, b, rtl) => p.planToast(b, rtl));
  },
  complete(element: Element | null | undefined): void {
    play(element, (p, b, rtl) => p.planComplete(b, rtl));
  },

  /* every control (§7.4 "Every control"; ./press.ts delegates the presses, the kit calls the rest) */
  /** A control activated (pointer or keyboard: its click): `burst`, `fan` or `pop` round it. */
  press(control: Element | null | undefined, kind: PressKind): void {
    play(control, (p, b, rtl) => p.planPress(kind, b, rtl));
  },
  /** The wishlist heart: chips and glints when it turns on, a puff when it turns off. */
  wish(heart: Element | null | undefined, on: boolean): void {
    play(heart, (p, b, rtl) => p.planWish(b, on, rtl));
  },
  /** A tab or segment indicator landing under `item`, having slid in physical direction `dir` (+1 right, −1 left). */
  land(item: Element | null | undefined, dir: 1 | -1): void {
    play(item, (p, b) => p.planLand(b, dir));
  },
  /** A radio's dot: a fan of wedges. */
  dot(box: Element | null | undefined): void {
    play(box, (p, b, rtl) => p.planDot(b, rtl));
  },
  /** Typing: a speck of dust at `at` (page coordinates) — the field is the anchor for the guards and the palette. */
  dust(field: Element | null | undefined, at: { x: number; y: number }): void {
    play(field, (p) => p.planDust(at), true);
  },
  /** A quantity changed: wedges over the number, a puff at its foot. */
  tick(value: Element | null | undefined): void {
    play(value, (p, b, rtl) => p.planTick(b, rtl));
  },
  /** An empty state arriving round its art. */
  enter(art: Element | null | undefined): void {
    play(art, (p, b, rtl) => p.planEnter(b, rtl));
  },
  /**
   * The CSS half: restarts the element's `[data-fx-spring]` animation (pieces.css: a radio dot, the stepper's number,
   * the cart bead, an empty state's art). Removed now, set again next frame, so a second change replays it.
   */
  spring(element: Element | null | undefined): void {
    if (!element || !canDraw(element)) return;
    element.removeAttribute("data-fx-spring");
    requestAnimationFrame(() => element.setAttribute("data-fx-spring", ""));
  },
};
