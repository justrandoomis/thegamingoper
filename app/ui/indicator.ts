import { useLayoutEffect, type RefObject } from "react";
import { sakuga } from "./sakuga/fx";

/**
 * A sliding indicator — Design v2.1 G6 ("tab and segmented indicators slide"). One absolutely positioned element
 * inside a track (the segmented control's clay thumb, the tabs' ink underline) is moved under the current item with
 * `translate` (its width is set at once, never animated). The track gets two custom properties and an attribute:
 *
 *   --thumb-x / --thumb-w (or --ind-x / --ind-w)   where the indicator goes, from the track's inline start
 *   data-thumb (or data-ind) = "still" | "live"     "still" on the first placement (no transition), "live" after
 *
 * Before JavaScript has measured (and without it) the attribute is absent and the current item paints itself
 * (pieces.css), so the first paint is right and nothing shifts. Re-measured when the current item changes, when the
 * fonts arrive and when the track is resized. Reduced motion: the stylesheet drops the transition.
 */
export type IndicatorOptions = {
  /** The current item inside the track ("[aria-checked='true'], [aria-current]"). */
  selector: string;
  /** The attribute that marks a measured track. */
  attribute: "data-thumb" | "data-ind";
  /** The custom properties for the start offset and the width. */
  x: "--thumb-x" | "--ind-x";
  w: "--thumb-w" | "--ind-w";
  /** Pixels taken off both ends of the item — or "padding": the item's own inline padding, read when it is measured
   *  (the tabs' underline sits inside the tab's padding, whatever a compact row or a page sets it to). */
  inset?: number | "padding";
};

/** What comes off the item's two ends: the same number at both, or its inline-start and inline-end paddings. */
export type IndicatorInset = number | { start: number; end: number };

/** Where an item sits along a track, from the track's inline start (pure; exported for tests). */
export function indicatorBox(
  track: { clientWidth: number },
  item: { offsetLeft: number; offsetWidth: number },
  rtl: boolean,
  inset: IndicatorInset = 0,
): { x: number; width: number } {
  const { start: before, end: after } = typeof inset === "number" ? { start: inset, end: inset } : inset;
  const width = Math.max(0, item.offsetWidth - before - after);
  const start = (rtl ? track.clientWidth - item.offsetLeft - item.offsetWidth : item.offsetLeft) + before;
  return { x: Math.round(rtl ? -start : start), width: Math.round(width) };
}

/** An item's inline paddings in pixels, from its computed style (pure; exported for tests). */
export function paddingInset(style: { paddingInlineStart: string; paddingInlineEnd: string }): { start: number; end: number } {
  return { start: parseFloat(style.paddingInlineStart) || 0, end: parseFloat(style.paddingInlineEnd) || 0 };
}

export function useSlidingIndicator(track: RefObject<HTMLElement | null>, key: unknown, options: IndicatorOptions): void {
  const { selector, attribute, x, w, inset = 0 } = options;
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const place = () => {
      const item = element.querySelector<HTMLElement>(selector);
      if (!item) {
        element.removeAttribute(attribute);
        return;
      }
      const rtl = getComputedStyle(element).direction === "rtl";
      const box = indicatorBox(element, item, rtl, inset === "padding" ? paddingInset(getComputedStyle(item)) : inset);
      element.style.setProperty(x, `${box.x}px`);
      element.style.setProperty(w, `${box.width}px`);
      if (!element.hasAttribute(attribute)) {
        element.setAttribute(attribute, "still");
        // the next change slides; the first placement never does
        requestAnimationFrame(() => {
          if (element.getAttribute(attribute) === "still") element.setAttribute(attribute, "live");
        });
      }
    };
    // a change of the current item while the indicator is live: it stretches as it slides (CSS, the indicator's
    // [data-fx-spring]) and lands in wedges off its leading edge (DESIGN.md §7.4 "Every control"). Never on the first
    // placement, a font swap or a resize — those re-place it below without passing here.
    const from = element.getAttribute(attribute) === "live" ? parseFloat(element.style.getPropertyValue(x)) : NaN;
    place();
    const to = parseFloat(element.style.getPropertyValue(x));
    const moved = Number.isFinite(from) && Number.isFinite(to) && Math.abs(to - from) >= 1;
    if (moved) {
      const item = element.querySelector(selector);
      sakuga.spring(element.querySelector('[aria-hidden="true"]:is(.seg__thumb, .tabs__ind)'));
      sakuga.land(item, to > from ? 1 : -1);
    }
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) place();
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    observer?.observe(element);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [track, key, selector, attribute, x, w, inset]);
}
