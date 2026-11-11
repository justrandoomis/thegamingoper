/**
 * Public entry points whose implementation lives in the on-demand chunk (./extras).
 *
 * The rule: an interaction never waits for code. Each function below does its instant part right away and
 * only adds the animation when the chunk is already here (<MotionRoot> fetches it at idle, so in practice it is).
 * If it is not, the outcome is the reduced-motion one — correct, just not animated — and the chunk is requested
 * for next time.
 */
import { resolveTheme, setPrefs, type Theme } from "~/lib/prefs";
import { getMotionTier } from "./env";
import type { CartReceivedDetail, FlyHandle, FlyOptions } from "./fly";
import type { MaterializeOptions } from "./materialize";
import type { MorphOrigin } from "./morph";
import { armAnchors } from "./nav";
import { setNavIntent } from "./nav-state";

type Extras = typeof import("./extras");

let loading: Promise<Extras> | null = null;
let loaded: Extras | null = null;

/** Fetch the on-demand chunk (idempotent). */
export function loadExtras(): Promise<Extras> {
  if (!loading) {
    loading = import("./extras").then((module) => {
      loaded = module;
      return module;
    });
    loading.catch(() => {
      loading = null; // offline or a deploy changed the chunk name: allow a later retry
    });
  }
  return loading;
}

export function preloadExtras(): void {
  void loadExtras().catch(() => {});
}

/** The chunk if it has arrived, without waiting. */
export function readyExtras(): Extras | null {
  return loaded;
}

/**
 * Where the bead lands: the first `[data-cart-target]` in document order that is on screen, else the first one that is
 * drawn at all (a hidden copy — display: none at this width — never receives a bead).
 */
function cartTarget(): Element | null {
  let drawn: Element | null = null;
  for (const candidate of document.querySelectorAll("[data-cart-target]")) {
    const rect = candidate.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth) return candidate;
    drawn ??= candidate;
  }
  return drawn;
}

const NOTHING: FlyHandle = { revert() {} };

/** No flight: the arrival is announced at once (`onArrive`, then `tt:cart-received` with `flown: false`). */
function arriveWithoutFlight(target: Element | null, options: FlyOptions): void {
  options.onArrive?.();
  (target ?? document).dispatchEvent(new CustomEvent<CartReceivedDetail>("tt:cart-received", { bubbles: true, detail: { flown: false } }));
}

/**
 * No cart is drawn at the moment of the tap — a shell may draw its cart bead (and with it the landing target) only once
 * the cart holds something, and the count changes in the same handler. Look again in the next task, after the page has
 * rendered the new count; fly if a cart is there now, else announce the arrival without a flight.
 */
function flyWhenDrawn(extras: Extras, source: Element, options: FlyOptions): FlyHandle {
  let flight: FlyHandle | null = null;
  let reverted = false;
  setTimeout(() => {
    if (reverted) return; // the add failed before anything flew: nothing to take back, the cart is not told
    const target = cartTarget();
    if (target && source.isConnected) flight = extras.fly(source, target, options);
    else arriveWithoutFlight(target, options);
  }, 0);
  return {
    revert() {
      reverted = true;
      flight?.revert();
    },
  };
}

/**
 * Fly a red bead from `source` (the product image) along an arc into the cart (DESIGN.md §7.2, Design System v2 §2.11).
 *
 * Call it in the same handler that adds the item, after updating the count — it returns immediately and never
 * blocks or delays the cart update. The bead lands on the cart bead: `[data-cart-badge]` inside the first on-screen
 * `[data-cart-target]` (the target itself while it shows no bead); the bead squishes when it lands, and a bubbling
 * `tt:cart-received` CustomEvent ({ detail: { flown } }) is dispatched on the target. Contract for the shell: put
 * `data-cart-target` on the cart button, which is drawn at every count, and `data-cart-badge` on its bead. Rapid taps
 * each get a bead, at most three in flight; further taps go straight to the count.
 * Reduced motion: no flight, the event fires straight away. If the add fails, call `revert()` on the returned
 * handle: the bead returns along the same arc (roll the count back and show the message yourself).
 */
export function flyToCart(source: Element, options: FlyOptions = {}): FlyHandle {
  if (typeof window === "undefined") return NOTHING;
  const target = options.target ?? cartTarget();
  const extras = loaded;
  const animate = extras !== null && getMotionTier() !== "reduced";
  if (animate && target) return extras.fly(source, target, options);
  // No cart drawn yet (the caller did not name one): it may appear with the new count.
  if (animate && !options.target) return flyWhenDrawn(extras, source, options);
  if (!extras) preloadExtras();
  arriveWithoutFlight(target, options);
  return NOTHING;
}

function applyTheme(next: Theme): void {
  const root = document.documentElement;
  // The attribute is what the stylesheet reads; set it now so the view transition captures the new theme.
  // (The root route's own effect sets the same values a moment later.)
  root.dataset.theme = resolveTheme(next);
  if (next === "system") root.dataset.themeSource = "system";
  else delete root.dataset.themeSource;
  setPrefs({ theme: next });
}

/**
 * Switch the theme with a 200 ms cross-fade of two snapshots (DESIGN.md §7.2: "the light changes, not the objects").
 * Nothing moves and nothing repaints per frame; scroll position and all state are untouched. Instant at the low-end
 * tier, under reduced motion, and without View Transitions. `origin` is accepted for compatibility and not used.
 */
export function themeMorph(next: Theme, origin?: MorphOrigin): Promise<void> {
  void origin;
  if (typeof window === "undefined") return Promise.resolve();
  const extras = loaded;
  const unchanged = document.documentElement.dataset.theme === resolveTheme(next);
  if (!extras || unchanged || getMotionTier() !== "full") {
    if (!extras) preloadExtras();
    applyTheme(next);
    return Promise.resolve();
  }
  return extras.themeCrossFade(() => applyTheme(next));
}

/**
 * Run a language-changing navigation with the direction morph: the content slides 16px toward the new reading
 * direction's start and cross-fades while `dir` flips; fixed chrome cross-fades in place; `data-motion-anchor`
 * elements stay where they are. Instant at the lite and reduced tiers.
 *
 *   directionMorph(() => navigate(switchLocalePath(pathname, search, hash, "en"), { replace: true, preventScrollReset: true }));
 *
 * `preventScrollReset` keeps the scroll position; the route stays mounted, so form state survives.
 * (`useDirectionMorph()` does exactly this for you.)
 */
export function directionMorph(run: () => void | Promise<void>): void {
  setNavIntent({ nav: "direction" });
  armAnchors();
  void run();
}

/**
 * A menu, popover or toast drops in from what opened it (8px of travel and opacity, 220 ms).
 * Call right after the element is in the DOM; resolves when it has arrived.
 */
export function materialize(element: HTMLElement, options?: MaterializeOptions): Promise<void> {
  const extras = loaded;
  if (!extras) {
    preloadExtras();
    return Promise.resolve();
  }
  return extras.materialize(element, options);
}

/** The reverse (140 ms): resolves when the element has gone — unmount it then. */
export function dematerialize(element: HTMLElement, options?: MaterializeOptions): Promise<void> {
  const extras = loaded;
  if (!extras) return Promise.resolve();
  return extras.dematerialize(element, options);
}
