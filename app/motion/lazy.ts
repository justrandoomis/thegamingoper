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
import type { CartReceivedDetail, FlyOptions } from "./fly";
import type { MaterializeOptions } from "./materialize";
import type { MorphOrigin } from "./morph";
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

function cartTarget(): Element | null {
  for (const candidate of document.querySelectorAll("[data-cart-target]")) {
    const rect = candidate.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return candidate;
  }
  return null;
}

/**
 * Fly a copy of `source` (a product image, a tile) along an arc into the cart.
 *
 * Call it in the same handler that adds the item — it returns immediately and never blocks or delays the cart
 * update. The element marked `data-cart-target` squishes and its `[data-cart-badge]` bumps when the puck lands, and
 * a bubbling `tt:cart-received` CustomEvent ({ detail: { flown } }) is dispatched on it. Rapid taps each get their own
 * flight (at most four at once; the rest land instantly). Under reduced motion there is no flight: the event fires
 * straight away.
 */
export function flyToCart(source: Element, options: FlyOptions = {}): void {
  if (typeof window === "undefined") return;
  const target = options.target ?? cartTarget();
  const extras = loaded;
  if (extras && target && getMotionTier() !== "reduced") {
    extras.fly(source, target, options);
    return;
  }
  if (!extras) preloadExtras();
  options.onArrive?.();
  (target ?? document).dispatchEvent(new CustomEvent<CartReceivedDetail>("tt:cart-received", { bubbles: true, detail: { flown: false } }));
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
 * Switch the theme with a reveal that starts at `origin` (the control that was pressed, or a point).
 * A soft-edged circle grows from the control; without an origin (or at the 'lite' tier) a light sweep crosses the
 * screen. Text is legible in every frame because each pixel is entirely one theme. Scroll position and all state are
 * untouched — nothing navigates, nothing remounts. Instant when motion is reduced or view transitions are missing.
 */
export function themeMorph(next: Theme, origin?: MorphOrigin): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const extras = loaded;
  const unchanged = document.documentElement.dataset.theme === resolveTheme(next);
  if (!extras || unchanged || getMotionTier() === "reduced") {
    if (!extras) preloadExtras();
    applyTheme(next);
    return Promise.resolve();
  }
  return extras.themeReveal(() => applyTheme(next), origin, resolveTheme(next) === "dark");
}

/**
 * Run a language-changing navigation with the direction morph: the page slides out toward the old reading
 * direction's end and the new one comes in from its start while `dir` flips.
 *
 *   directionMorph(() => navigate(switchLocalePath(pathname, search, hash, "en"), { replace: true, preventScrollReset: true }));
 *
 * `preventScrollReset` keeps the scroll position; the route stays mounted, so form state survives.
 * (`useDirectionMorph()` does exactly this for you.)
 */
export function directionMorph(run: () => void | Promise<void>): void {
  setNavIntent({ nav: "direction" });
  void run();
}

/**
 * A menu, popover or toast grows out of what opened it (scale + opacity from the trigger's position).
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

/** The reverse: resolves when the element has shrunk away — unmount it then. */
export function dematerialize(element: HTMLElement, options?: MaterializeOptions): Promise<void> {
  const extras = loaded;
  if (!extras) return Promise.resolve();
  return extras.dematerialize(element, options);
}
