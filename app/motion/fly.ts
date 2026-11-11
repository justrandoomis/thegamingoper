/**
 * Fly-to-cart flight (loaded on demand through ./extras; the public entry is `flyToCart` in ./lazy).
 *
 * The source is never moved: a copy of its picture is placed over it in a fixed layer, shrinks to a puck and
 * travels a quadratic Bézier arc to the cart, which receives it with a squish and a badge bump.
 * One WAAPI animation per flight (transform + opacity keyframes sampled along the arc) — compositor only.
 */
import { arcControl, quadBezier, type Point } from "./physics";
import { springValue } from "./spring";
import { getMotionTier } from "./env";
import { durations, easings, fly as tokens, springs } from "./tokens";

export type FlyOptions = {
  /** Picture to fly instead of the source's own: a URL, or an element to copy (img / svg / canvas / picture). */
  image?: string | Element;
  /** Where to land. Default: the first visible element marked `data-cart-target`. */
  target?: Element | null;
  /** Puck diameter in px. */
  size?: number;
  /** Runs when the puck lands — or straight away when no flight is played (reduced motion, no target, cap reached). */
  onArrive?: () => void;
};

export type CartReceivedDetail = { /** false when the arrival was announced without a flight */ flown: boolean };

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

function pictureOf(source: Element, image: FlyOptions["image"]): Element {
  if (typeof image === "string") {
    const img = document.createElement("img");
    img.decoding = "sync";
    img.alt = "";
    img.src = image;
    return img;
  }
  const original = image ?? (source.matches("img, picture, svg, canvas") ? source : (source.querySelector("img, picture, svg, canvas") ?? source));
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

/** The cart reacts: a soft squish on the target, a bump on its badge, and the public event. */
export function receive(target: Element | null, flown: boolean, onArrive?: () => void): void {
  onArrive?.();
  const tier = getMotionTier();
  if (target && flown && tier !== "reduced") {
    if (tier === "full") {
      target.animate(
        [{ scale: "1 1" }, { scale: "1.12 0.9", offset: 0.28 }, { scale: "0.96 1.04", offset: 0.62 }, { scale: "1 1" }],
        { duration: durations.slow, easing: easings.out },
      );
    }
    target.querySelector("[data-cart-badge]")?.animate([{ scale: "1" }, { scale: "1.28", offset: 0.35 }, { scale: "1" }], {
      duration: durations.page,
      easing: easings.out,
    });
  }
  (target ?? document).dispatchEvent(new CustomEvent<CartReceivedDetail>("tt:cart-received", { bubbles: true, detail: { flown } }));
}

function onScreen(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/** Start one flight. Returns immediately; every flight is independent of the others. */
export function fly(source: Element, target: Element, options: FlyOptions = {}): void {
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (airborne >= tokens.maxConcurrent || !onScreen(from) || !onScreen(to)) {
    receive(target, false, options.onArrive);
    return;
  }

  const lite = getMotionTier() === "lite";
  const side = Math.min(from.width, from.height);
  const size = options.size ?? tokens.puck;
  const start: Point = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  const end: Point = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  const control = arcControl(start, end, lite ? 0.5 : 1);
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const duration = Math.round(Math.min(Math.max(300 + distance * 0.4, 360), 640));
  const endScale = Math.min(size / side, 1);

  const puck = document.createElement("div");
  puck.className = "tt-fly";
  puck.style.cssText = `left:${start.x - side / 2}px;top:${start.y - side / 2}px;width:${side}px;height:${side}px`;
  puck.appendChild(pictureOf(source, options.image));

  // Travel follows the `fly` spring (leaves fast, lands softly), trimmed to where it is 98.5 % home.
  const springSeconds = 0.4;
  const reach = springValue(springs.fly, springSeconds);
  const frames = 22;
  const keyframes: Keyframe[] = [];
  for (let i = 0; i <= frames; i++) {
    const time = i / frames;
    const travel = i === frames ? 1 : Math.min(springValue(springs.fly, time * springSeconds) / reach, 1);
    const point = quadBezier(start, control, end, travel);
    const shrink = Math.min(time / 0.55, 1);
    const eased = 1 - (1 - shrink) * (1 - shrink);
    // The last stretch: the cart swallows the puck.
    const absorb = time > 0.86 ? (time - 0.86) / 0.14 : 0;
    const scale = (1 + (endScale - 1) * eased) * (1 - 0.45 * absorb);
    const spin = lite ? 0 : (1 - travel) * -10;
    keyframes.push({
      offset: time,
      opacity: 1 - absorb,
      transform: `translate3d(${(point.x - start.x).toFixed(1)}px, ${(point.y - start.y).toFixed(1)}px, 0) rotate(${spin.toFixed(1)}deg) scale(${scale.toFixed(4)})`,
    });
  }

  flightLayer().appendChild(puck);
  airborne++;
  const animation = puck.animate(keyframes, { duration, easing: "linear", fill: "forwards" });
  let landed = false;
  const land = (flown: boolean) => {
    if (landed) return;
    landed = true;
    airborne--;
    puck.remove();
    receive(target, flown, options.onArrive);
  };
  animation.finished.then(
    () => land(true),
    () => land(false),
  );
  // Safety net: animations do not advance in a hidden tab, but the cart must still be told and the puck removed.
  setTimeout(() => {
    if (!landed) animation.finish();
  }, duration + 60);
}
