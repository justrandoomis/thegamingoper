import { useLayoutEffect, type RefObject } from "react";

/*
 * Rows that scroll sideways (rails, tabs, link segments, chip rows): bring one item fully into view by scrolling the
 * ROW only — never the page — and only when part of it is hidden. Used by ./Rail (keyboard focus), ./Tabs and
 * ./Segmented (the current one on mount and on change).
 */

/**
 * Keep the row's current item (`selector`, e.g. "[aria-current]") in view: on the first paint, when `key` (the current
 * value) changes, once the web fonts have loaded (the words change width, and a row that fitted in the fallback face
 * may not fit in the real one) and when the row itself is resized. A row the shopper scrolled by hand is left alone
 * otherwise.
 */
export function useKeepInView(row: RefObject<HTMLElement | null>, selector: string, key: unknown): void {
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const reveal = () => {
      const item = element.querySelector(selector);
      if (item) revealInRow(element, item, "nearest");
    };
    reveal();
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) reveal();
    });
    let width = element.clientWidth;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (element.clientWidth === width) return;
            width = element.clientWidth;
            reveal();
          });
    observer?.observe(element);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [row, selector, key]);
}

export type RowBox = { left: number; right: number };

/**
 * How far to scroll a row (physical px, the sign of `scrollLeft`) so `item` is fully inside it; 0 when it already is.
 * `align: "start"` brings a hidden item to the row's start edge (where a snapping row has its snap points: a snap
 * row rests only where an item starts, so a "nearest" scroll would be pulled back with the item cut off);
 * "nearest" moves it the least. `padStart` / `padEnd` are the row's scroll padding on its start / end side. Pure.
 */
export function revealDelta(
  row: RowBox,
  item: RowBox,
  options: { rtl: boolean; align: "start" | "nearest"; padStart?: number; padEnd?: number; tolerance?: number },
): number {
  const tolerance = options.tolerance ?? 1;
  const padStart = options.padStart ?? 0;
  const padEnd = options.padEnd ?? 0;
  if (item.left >= row.left - tolerance && item.right <= row.right + tolerance) return 0;
  const startEdge = options.rtl ? row.right - padStart : row.left + padStart;
  const endEdge = options.rtl ? row.left + padEnd : row.right - padEnd;
  const toStart = options.rtl ? item.right - startEdge : item.left - startEdge;
  if (options.align === "start") return Math.round(toStart);
  // nearest: the item's hidden side to its edge; an item wider than the row starts at the start edge
  const width = item.right - item.left;
  if (width >= row.right - row.left - padStart - padEnd) return Math.round(toStart);
  const hiddenLeft = item.left < row.left;
  if (options.rtl) return Math.round(hiddenLeft ? item.left - endEdge : item.right - startEdge);
  return Math.round(hiddenLeft ? item.left - startEdge : item.right - endEdge);
}

/**
 * A focus handler for a row: the item that takes the KEYBOARD focus scrolls fully into the row ("nearest"). Pointer
 * focus never scrolls the row — a press would land on a moving target and its click would be lost.
 */
export function revealFocusedItem(event: { currentTarget: HTMLElement; target: EventTarget }): void {
  const target = event.target;
  if (!(target instanceof Element) || target === event.currentTarget || !target.matches(":focus-visible")) return;
  revealInRow(event.currentTarget, target, "nearest");
}

/** Scroll `row` so `item` (a descendant) is fully visible; instant, the row only. Returns whether it moved. */
export function revealInRow(row: HTMLElement, item: Element, align: "start" | "nearest" = "nearest"): boolean {
  if (row.scrollWidth <= row.clientWidth + 1) return false;
  const style = getComputedStyle(row);
  const rtl = style.direction === "rtl";
  const left = parseFloat(style.scrollPaddingLeft) || 0;
  const right = parseFloat(style.scrollPaddingRight) || 0;
  const box = row.getBoundingClientRect();
  const delta = revealDelta(box, item.getBoundingClientRect(), { rtl, align, padStart: rtl ? right : left, padEnd: rtl ? left : right });
  if (delta === 0) return false;
  row.scrollBy({ left: delta, behavior: "instant" });
  return true;
}
