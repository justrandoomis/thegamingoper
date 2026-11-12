import { useLayoutEffect, type RefObject } from "react";

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
  /** Pixels taken off both ends of the item (the tabs' underline sits inside the tab's padding). */
  inset?: number;
};

/** Where an item sits along a track, from the track's inline start (pure; exported for tests). */
export function indicatorBox(
  track: { clientWidth: number },
  item: { offsetLeft: number; offsetWidth: number },
  rtl: boolean,
  inset = 0,
): { x: number; width: number } {
  const width = Math.max(0, item.offsetWidth - 2 * inset);
  const start = (rtl ? track.clientWidth - item.offsetLeft - item.offsetWidth : item.offsetLeft) + inset;
  return { x: Math.round(rtl ? -start : start), width: Math.round(width) };
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
      const box = indicatorBox(element, item, rtl, inset);
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
    place();
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
