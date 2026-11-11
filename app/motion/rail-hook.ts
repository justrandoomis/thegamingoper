/**
 * useRail — a horizontal rail that scrolls natively and behaves well everywhere.
 *
 *   const rail = useRail({ tilt: true });
 *   <div {...rail.props} aria-label={t("trending")}>
 *     {items.map((item) => <ProductCard key={item.id} … />)}
 *   </div>
 *   <button onClick={() => rail.step(false)}>‹</button> <button onClick={() => rail.step(true)}>›</button>
 *
 * What you get:
 *  - CSS scroll-snap with the platform's own momentum and touch behaviour (class `tt-rail`); vertical gestures and the
 *    vertical wheel are never captured, so the page scrolls normally over a rail.
 *  - Keyboard: the rail is focusable; ← → move one item (mirrored in RTL), Page Up/Down a screenful, Home/End the ends.
 *  - Edge feedback where the platform has none (mouse, keyboard, the step buttons): a small rubber bump.
 *    Touch devices keep their native overscroll effect.
 *  - `tilt`: items lean slightly as they enter and leave, driven by scroll position on the compositor
 *    (scroll-driven animations; only at the 'full' tier and where the browser supports them).
 *  - Screen readers see a labelled group of ordinary elements — give it an `aria-label`.
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { getMotionTier } from "./env";
import { loadExtras } from "./lazy";
import type { RailController } from "./rail";

export type RailOptions = {
  /** Depth tilt on the items. Default false. */
  tilt?: boolean;
};

export type RailHandle<T extends HTMLElement> = {
  /** Spread on the scrolling element. Add your own className after it if needed (`className={`${rail.props.className} …`}`). */
  props: { ref: RefObject<T | null>; className: string; tabIndex: 0; role: "group"; "data-rail-tilt": "" | undefined };
  /** Scroll one item toward the end (true) or the start (false). */
  step: (forward: boolean) => void;
};

export function useRail<T extends HTMLElement = HTMLDivElement>(options: RailOptions = {}): RailHandle<T> {
  const ref = useRef<T | null>(null);
  const controller = useRef<RailController | null>(null);

  useEffect(() => {
    let disposed = false;
    loadExtras()
      .then((extras) => {
        if (!disposed && ref.current) controller.current = extras.attachRail(ref.current);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      controller.current?.detach();
      controller.current = null;
    };
  }, []);

  const step = useCallback((forward: boolean) => {
    const rail = ref.current;
    if (!rail) return;
    if (controller.current) {
      controller.current.step(forward);
      return;
    }
    // Behaviour chunk not here yet: plain native scrolling by most of a screen.
    const rtl = getComputedStyle(rail).direction === "rtl";
    rail.scrollBy({ left: (forward ? 1 : -1) * (rtl ? -1 : 1) * rail.clientWidth * 0.8, behavior: getMotionTier() === "reduced" ? "auto" : "smooth" });
  }, []);

  const tilt = options.tilt === true;
  return useMemo(
    () => ({ props: { ref, className: "tt-rail", tabIndex: 0 as const, role: "group" as const, "data-rail-tilt": tilt ? ("" as const) : undefined }, step }),
    [tilt, step],
  );
}
