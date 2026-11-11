/**
 * materialize / dematerialize — menus, popovers and toasts arrive from the thing that opened them and leave the same
 * way (loaded on demand through ./extras; the public entries are in ./lazy).
 *
 * DESIGN.md §7.2: menus are glass, and glass slides: they drop from their trigger with 8px of travel and opacity
 * (`settle` curve, 220 ms in, 140 ms out). The travel points away from the trigger: a menu below its trigger drops
 * down, one above it rises. Interruptible: calling one while the other is running continues from the current look.
 * Reduced motion: opacity only.
 */
import { getMotionTier } from "./env";
import { lastPointer } from "./pointer";
import { durations, easings, travel } from "./tokens";

export type MaterializeOptions = {
  /** What it comes from: the trigger element or a viewport point. Default: the last press, else from above. */
  from?: Element | { x: number; y: number } | null;
};

type Look = { opacity: string; translate: string };

const running = new WeakMap<Element, Animation[]>();
/** The side each element arrived from, so it leaves the same way. */
const arrivedFrom = new WeakMap<Element, number>();

/** If the element is mid-animation, read how it looks right now and stop — the next animation starts from there. */
function interrupt(element: HTMLElement): Look | null {
  const animations = running.get(element);
  if (!animations) return null;
  const style = getComputedStyle(element);
  const look = { opacity: style.opacity, translate: style.translate === "none" ? "0px 0px" : style.translate };
  for (const animation of animations) animation.cancel();
  running.delete(element);
  return look;
}

/** The offset (px) the element travels from: toward its trigger, vertically. */
function offsetFrom(element: HTMLElement, from: MaterializeOptions["from"]): number {
  let point: { x: number; y: number } | null = null;
  if (from instanceof Element) {
    const rect = from.getBoundingClientRect();
    point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  } else if (from) {
    point = from;
  } else {
    point = lastPointer();
  }
  if (!point) return -travel.menu;
  const rect = element.getBoundingClientRect();
  return point.y > rect.top + rect.height / 2 ? travel.menu : -travel.menu;
}

function play(element: HTMLElement, animations: Animation[]): Promise<void> {
  running.set(element, animations);
  return Promise.all(animations.map((a) => a.finished)).then(
    () => {
      // A finished arrival leaves nothing behind; a finished departure stays (fill: forwards) until the caller unmounts.
      if (running.get(element) === animations && animations.every((a) => a.effect?.getComputedTiming().fill !== "forwards")) running.delete(element);
    },
    () => {},
  );
}

/** Call right after the element is in the DOM. Resolves when it has fully arrived. */
export function materialize(element: HTMLElement, options: MaterializeOptions = {}): Promise<void> {
  const look = interrupt(element);
  const reduced = getMotionTier() === "reduced";
  const timing = { duration: reduced ? 120 : durations.base, easing: easings.settle };
  const animations = [element.animate([{ opacity: look?.opacity ?? "0" }, { opacity: "1" }], timing)];
  if (!reduced) {
    const offset = offsetFrom(element, options.from);
    arrivedFrom.set(element, offset);
    const start = look?.translate ?? `0px ${offset}px`;
    animations.push(element.animate([{ translate: start }, { translate: "0px 0px" }], timing));
  }
  return play(element, animations);
}

/** Resolves when the element is fully gone — remove it from the DOM then. It stays hidden until you do. */
export function dematerialize(element: HTMLElement, options: MaterializeOptions = {}): Promise<void> {
  const look = interrupt(element);
  const reduced = getMotionTier() === "reduced";
  const timing = { duration: reduced ? 120 : durations.exit, easing: easings.exit, fill: "forwards" as const };
  const animations = [element.animate(look ? [{ opacity: look.opacity }, { opacity: "0" }] : { opacity: "0" }, timing)];
  if (!reduced) {
    const offset = options.from !== undefined ? offsetFrom(element, options.from) : (arrivedFrom.get(element) ?? -travel.menu);
    const end = `0px ${offset}px`;
    animations.push(element.animate(look ? [{ translate: look.translate }, { translate: end }] : { translate: end }, timing));
  }
  return play(element, animations);
}
