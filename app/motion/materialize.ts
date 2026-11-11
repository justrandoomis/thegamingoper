/**
 * materialize / dematerialize — menus, popovers and toasts grow out of the thing that opened them and shrink back.
 * (Loaded on demand through ./extras; the public entries are in ./lazy.)
 *
 * Scale + opacity only, from the trigger's position. Interruptible: calling one while the other is running
 * continues from the current look. Reduced motion: opacity only.
 */
import { getMotionTier } from "./env";
import { lastPointer } from "./pointer";
import { springTiming } from "./timing";
import { durations, easings } from "./tokens";

export type MaterializeOptions = {
  /** Where it grows from: the trigger element or a viewport point. Default: the last press, else the element's centre. */
  from?: Element | { x: number; y: number } | null;
};

type Look = { opacity: string; scale: string };

const running = new WeakMap<Element, Animation[]>();

/** If the element is mid-animation, read how it looks right now and stop — the next animation starts from there. */
function interrupt(element: HTMLElement): Look | null {
  const animations = running.get(element);
  if (!animations) return null;
  const style = getComputedStyle(element);
  const look = { opacity: style.opacity, scale: style.scale === "none" ? "1" : style.scale };
  for (const animation of animations) animation.cancel();
  running.delete(element);
  return look;
}

function setOrigin(element: HTMLElement, from: MaterializeOptions["from"]): void {
  let point: { x: number; y: number } | null = null;
  if (from instanceof Element) {
    const rect = from.getBoundingClientRect();
    point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  } else if (from) {
    point = from;
  } else {
    point = lastPointer();
  }
  if (!point) return;
  const rect = element.getBoundingClientRect();
  // Clamp to the element's box (plus a little) so a far-away trigger does not make it fly across the screen.
  const x = Math.min(Math.max(point.x - rect.left, -24), rect.width + 24);
  const y = Math.min(Math.max(point.y - rect.top, -24), rect.height + 24);
  element.style.transformOrigin = `${Math.round(x)}px ${Math.round(y)}px`;
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
  if (!reduced && !look) setOrigin(element, options.from);
  const animations = [
    element.animate([{ opacity: look?.opacity ?? "0" }, { opacity: "1" }], { duration: reduced ? 100 : durations.quick, easing: easings.out }),
  ];
  if (!reduced) animations.push(element.animate([{ scale: look?.scale ?? "0.9" }, { scale: "1" }], springTiming("gentle")));
  return play(element, animations);
}

/** Resolves when the element is fully gone — remove it from the DOM then. It stays hidden until you do. */
export function dematerialize(element: HTMLElement, options: MaterializeOptions = {}): Promise<void> {
  const look = interrupt(element);
  const reduced = getMotionTier() === "reduced";
  if (!reduced && options.from !== undefined) setOrigin(element, options.from);
  const duration = reduced ? 80 : durations.quick;
  const timing = { duration, easing: easings.in, fill: "forwards" as const };
  const animations = [element.animate(look ? [{ opacity: look.opacity }, { opacity: "0" }] : { opacity: "0" }, timing)];
  if (!reduced) animations.push(element.animate(look ? [{ scale: look.scale }, { scale: "0.94" }] : { scale: "0.94" }, timing));
  return play(element, animations);
}
