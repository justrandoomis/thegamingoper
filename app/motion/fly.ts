/**
 * Fly to cart (loaded on demand through ./extras; the public entry is `flyToCart` in ./lazy). DESIGN.md §7.2:
 *
 *  1. The caller has already updated the cart count, the cart state and the aria-live message (state first).
 *  2. A 22px red clay bead (`.fly`) leaves the product image and travels a quadratic arc — control point halfway
 *     across, 70px above the higher end — to the cart bead, shrinking to .55. 420 ms + 0.3 ms per px, at most 600 ms.
 *  3. The cart bead receives it with a squish: scale(1.4, .68) → (.88, 1.16) → 1 over 340 ms.
 *  4. Rapid taps each get a bead, at most three in flight; further taps go straight to the count (the bead squishes).
 *  5. On failure (`revert()` on the returned handle) the bead returns along the same arc to where it came from.
 *
 * The source is never moved. One WAAPI animation per flight (transform keyframes along the arc) — compositor only.
 * `options.image` flies a copy of the product picture instead of the bead (the brief's "thumbnail becomes an icon").
 */
import { getMotionTier } from "./env";
import { arcControl, flightMs, quadBezier, type Point } from "./physics";
import { fly as tokens } from "./tokens";

export type FlyOptions = {
  /** Fly a picture instead of the bead: a URL, an element to copy (img / svg / canvas / picture), or true for the source's own picture. */
  image?: string | Element | true;
  /** Where to land. Default: the first visible element marked `data-cart-target` (its `[data-cart-badge]` is the bead). */
  target?: Element | null;
  /** Runs when the bead lands — or straight away when no flight is played (reduced motion, no target, cap reached). */
  onArrive?: () => void;
};

/** Returned by `flyToCart`. */
export type FlyHandle = {
  /**
   * The add failed: the bead returns along the same arc to where it came from (mid-flight it simply turns back).
   * Roll the count back and show the message yourself — this is only the motion. Safe to call more than once.
   */
  revert(): void;
};

export type CartReceivedDetail = { /** false when the arrival was announced without a flight */ flown: boolean };

export const NO_FLIGHT: FlyHandle = { revert() {} };

let layer: HTMLElement | null = null;
let airborne = 0;

function flightLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement("div");
  layer.className = "tt-fly-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  return layer;
}

function pictureOf(source: Element, image: string | Element | true): Element {
  if (typeof image === "string") {
    const img = document.createElement("img");
    img.decoding = "sync";
    img.alt = "";
    img.src = image;
    return img;
  }
  const original = image !== true ? image : source.matches("img, picture, svg, canvas") ? source : (source.querySelector("img, picture, svg, canvas") ?? source);
  if (original instanceof HTMLCanvasElement) {
    const canvas = document.createElement("canvas");
    canvas.width = original.width;
    canvas.height = original.height;
    canvas.getContext("2d")?.drawImage(original, 0, 0);
    return canvas;
  }
  const copy = original.cloneNode(true) as Element;
  for (const node of [copy, ...copy.querySelectorAll("[id], [data-share], [data-press], [data-pressed]")]) {
    node.removeAttribute("id");
    node.removeAttribute("data-share");
    node.removeAttribute("data-press");
    node.removeAttribute("data-pressed");
  }
  if (copy instanceof HTMLImageElement) {
    copy.loading = "eager";
    copy.decoding = "sync"; // same URL as the source: comes from the memory cache, painted in the first frame
    copy.alt = "";
  }
  return copy;
}

/** The cart bead: `[data-cart-badge]` inside the target when it is showing (an empty cart may hide it), else the target. */
function beadOf(target: Element): Element {
  const badge = target.querySelector("[data-cart-badge]");
  if (!badge) return target;
  const rect = badge.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? badge : target;
}

/** The cart bead's squish (DESIGN.md §7.2). Skipped under reduced motion. */
export function squish(target: Element | null): void {
  if (!target || getMotionTier() === "reduced") return;
  beadOf(target).animate(
    [{ transform: "scale(1)" }, { transform: "scale(1.4, 0.68)", offset: 0.3 }, { transform: "scale(0.88, 1.16)", offset: 0.62 }, { transform: "scale(1)" }],
    { duration: tokens.squishMs, easing: "ease-out" },
  );
}

/** The cart reacts (squish when a bead arrived, or for a tap over the cap) and the public event is dispatched. */
export function receive(target: Element | null, flown: boolean, onArrive?: () => void, squishIt = flown): void {
  onArrive?.();
  if (squishIt) squish(target);
  (target ?? document).dispatchEvent(new CustomEvent<CartReceivedDetail>("tt:cart-received", { bubbles: true, detail: { flown } }));
}

function centreOf(rect: DOMRect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function onScreen(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/** 13 transform keyframes along the arc (DESIGN.md mock), shrinking from `fromScale` to `toScale`. */
function arcKeyframes(start: Point, end: Point, fromScale: number, toScale: number): Keyframe[] {
  const control = arcControl(start, end);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12;
    const point = quadBezier(start, control, end, u);
    const scale = fromScale + (toScale - fromScale) * u;
    frames.push({ transform: `translate(${(point.x - start.x).toFixed(1)}px, ${(point.y - start.y).toFixed(1)}px) scale(${scale.toFixed(3)})` });
  }
  return frames;
}

/** Start one flight. Returns immediately; every flight is independent of the others. */
export function fly(source: Element, target: Element, options: FlyOptions = {}): FlyHandle {
  const from = source.getBoundingClientRect();
  const bead = beadOf(target);
  const to = bead.getBoundingClientRect();
  if (airborne >= tokens.maxConcurrent || !onScreen(from) || !onScreen(to)) {
    // Over the cap (or nothing to fly between): straight to the count — the cart bead still acknowledges the tap.
    receive(target, false, options.onArrive, airborne >= tokens.maxConcurrent);
    return NO_FLIGHT;
  }

  const start = centreOf(from);
  const end = centreOf(to);
  const duration = flightMs(Math.hypot(end.x - start.x, end.y - start.y));
  const element = document.createElement("i");
  let fromScale = 1;
  if (options.image) {
    // A picture puck: starts at the source's size and shrinks to the bead's.
    const side = Math.max(Math.min(from.width, from.height), tokens.bead);
    element.className = "tt-fly tt-fly--picture";
    element.style.cssText = `left:${(start.x - side / 2).toFixed(1)}px;top:${(start.y - side / 2).toFixed(1)}px;width:${side}px;height:${side}px`;
    element.appendChild(pictureOf(source, options.image));
    fromScale = 1;
    const endScale = (tokens.bead * tokens.endScale) / side;
    return launch(element, arcKeyframes(start, end, fromScale, endScale), duration, target, options);
  }
  // DESIGN.md's bead: 22px, red clay, centred on the start point (the `.fly` class carries the look).
  element.className = "fly tt-fly";
  // lint-design: allow physical — viewport pixel coordinates of a fixed flying bead (client rects are physical in RTL too)
  element.style.left = `${start.x.toFixed(1)}px`;
  element.style.top = `${start.y.toFixed(1)}px`;
  return launch(element, arcKeyframes(start, end, fromScale, tokens.endScale), duration, target, options);
}

function launch(element: HTMLElement, keyframes: Keyframe[], duration: number, target: Element, options: FlyOptions): FlyHandle {
  flightLayer().appendChild(element);
  airborne++;
  const animation = element.animate(keyframes, { duration, easing: tokens.easing, fill: "forwards" });
  let landed = false;
  let returning = false;
  const land = () => {
    if (landed) return;
    landed = true;
    airborne--;
    element.remove();
    if (!returning) receive(target, true, options.onArrive);
  };
  animation.finished.then(land, land);
  // Safety net: animations do not advance in a hidden tab, but the cart must still be told and the bead removed.
  const timer = setTimeout(() => {
    if (!landed) animation.finish();
  }, duration + 80);

  return {
    revert() {
      if (returning) return;
      returning = true;
      if (!landed) {
        // Still in the air: it turns round and goes back the way it came.
        clearTimeout(timer);
        animation.reverse();
        setTimeout(() => {
          if (!landed) animation.finish();
        }, duration + 80);
        return;
      }
      if (getMotionTier() === "reduced") return;
      // Already landed: a bead leaves the cart and flies the same arc backwards to where it started.
      const back = element.cloneNode(true) as HTMLElement;
      flightLayer().appendChild(back);
      const reversed = keyframes.slice().reverse().map((frame) => ({ transform: frame.transform }));
      const flight = back.animate(reversed, { duration, easing: tokens.easing, fill: "forwards" });
      const done = () => back.remove();
      flight.finished.then(done, done);
      setTimeout(done, duration + 80);
    },
  };
}
