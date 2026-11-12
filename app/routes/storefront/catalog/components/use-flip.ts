/**
 * "Chips gently regroup and expand, result cards reflow smoothly; never make the user wait for filtering" (brief §2).
 *
 * FLIP on the children of one container that carry `data-flip="<stable key>"`: after React has committed new
 * content (the new results are ALREADY on screen and usable), every child that stayed slides from where it was to
 * where it is now (`settle` spring, transform only), and every new child grows in from the engine's bubble scale
 * (.94, `inflate` spring, opacity + transform, 45 ms apart, at most six staggered — `bubble` in ~/motion/tokens).
 * Children that left are simply gone. Nothing waits for
 * the animation and nothing is animated off screen.
 *
 *   const ref = useRef<HTMLUListElement>(null);
 *   useFlip(ref, items.map((item) => item.id).join("|"));
 *   <ul ref={ref}>{items.map((item) => <li key={item.id} data-flip={item.id}>…</li>)}</ul>
 *
 * Off at the "lite" and "reduced" motion tiers (DESIGN.md §7.3: content appears in place) and on the first render.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";

import { getMotionTier, springTiming } from "~/motion";
import { bubble } from "~/motion/tokens";

type Box = { x: number; y: number };

const STAGGER_MS = bubble.staggerStep;
const MAX_STAGGERED = bubble.staggerSlots;

function onScreen(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
}

export function useFlip(container: RefObject<HTMLElement | null>, signature: string): void {
  const boxes = useRef<Map<string, Box> | null>(null);
  const width = useRef(0);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const children = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !!child.dataset.flip);
    const next = new Map<string, Box>();
    for (const child of children) {
      const rect = child.getBoundingClientRect();
      next.set(child.dataset.flip!, { x: rect.left - origin.left, y: rect.top - origin.top });
    }
    const previous = boxes.current;
    // A resized container moved everything for another reason: remember, do not animate.
    const resized = Math.abs(origin.width - width.current) > 1;
    boxes.current = next;
    width.current = origin.width;
    if (!previous || resized || getMotionTier() !== "full" || typeof root.animate !== "function") return;

    let entering = 0;
    for (const child of children) {
      if (!onScreen(child)) continue;
      const key = child.dataset.flip!;
      const was = previous.get(key);
      const now = next.get(key)!;
      if (was) {
        const dx = was.x - now.x;
        const dy = was.y - now.y;
        if (Math.abs(dx) + Math.abs(dy) < 1) continue;
        child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], springTiming("settle"));
      } else {
        const delay = Math.min(entering, MAX_STAGGERED - 1) * STAGGER_MS;
        entering++;
        child.animate([{ transform: `scale(${bubble.fromScale})`, opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { ...springTiming("inflate"), delay, fill: "backwards" });
      }
    }
  }, [container, signature]);
}
