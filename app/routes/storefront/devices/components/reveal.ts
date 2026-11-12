/**
 * Keep a focused or current item of a sideways-scrolling row fully in view (WCAG 2.4.11 inside a scroller): browsers
 * leave a partly visible item where it is when it takes focus, and know nothing of a sticky column that covers the
 * row's start. Scrolls the ROW only (never the page), in both reading directions.
 *
 *   revealInline(row, chip)                                  the hub's section chips
 *   revealInline(region, link, { start: stickyColumnWidth })  the comparison table (its first column is sticky)
 */
export function revealInline(row: HTMLElement, item: HTMLElement, { start = 0, behavior = "auto" }: { start?: number; behavior?: ScrollBehavior } = {}): void {
  if (row.scrollWidth <= row.clientWidth) return;
  const box = row.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  const rtl = getComputedStyle(row).direction === "rtl";
  const air = 16;
  // the part of the row a reader can see: the sticky start column (right in RTL) is not part of it
  const left = box.left + (rtl ? 0 : start) + air;
  const right = box.right - (rtl ? start : 0) - air;
  if (rect.left < left) row.scrollBy({ left: rect.left - left, behavior });
  else if (rect.right > right) row.scrollBy({ left: rect.right - right, behavior });
}
