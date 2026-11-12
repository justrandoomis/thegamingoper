import { Children, isValidElement, useRef, type FocusEvent, type ReactNode } from "react";

import { useRail } from "~/motion";
import { cx } from "./cx";
import { revealInRow } from "./reveal";

/**
 * Rail — Design System v2 §4.22: one row of cards that scrolls sideways on phones with native scroll-snap (the
 * platform's own momentum; the gutter kept as scroll padding: 2.15 cards visible at 390, 3.2 from 768) and becomes a
 * GRID OF WHOLE CARDS from 1024 (4-up, 5-up from 1280) — never a carousel with arrows over cards. One tab stop on
 * phones: ← → move an item (mirrored in RTL), Page Up / Down a screenful, Home / End the ends (the engine's useRail).
 *
 *   <Rail aria-labelledby={headingId}>{cards.map((card) => <ProductCard key={card.id} card={card} />)}</Rail>
 *
 * Each child becomes one <li> (a snap point). A rail with its own item widths (`itemClassName`, 1.0) stays one
 * scrolling row at every width. `keys`, `fade` and `tilt` are 1.0 and ignored: no arrows over content, no edge fades.
 *
 * Keyboard focus never rests on a card that is mostly off-screen (WCAG 2.4.11): a card that takes the focus while part
 * of it is hidden is brought to the rail's start — a snap point, so the mandatory snap does not pull it back (the
 * browser's own "nearest" scroll landed between two snap points and left the card ~80% hidden). Pointer focus never
 * scrolls (a tap must land where it was aimed). The rail itself, a tab stop, draws its focus ring inside its edges:
 * full-bleed on phones, a ring outside would fall off the screen.
 */
export type RailProps = {
  children: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** 1.0 — ignored (arrows, if any, sit in the section head at 44px). */
  keys?: boolean;
  /** 1.0 — ignored. */
  fade?: "ground" | "paper" | "niche" | false;
  /** 1.0: sizes each item and keeps one scrolling row at every width. */
  itemClassName?: string;
  /** 1.0 — ignored. */
  tilt?: boolean;
  /** On the outer box. */
  className?: string;
  /** On the list. */
  railClassName?: string;
};

export function Rail({ children, itemClassName, className, railClassName, ...aria }: RailProps) {
  const rail = useRail<HTMLUListElement>();
  const pointer = useRef(0);
  const items = Children.toArray(children); // drops null, undefined and booleans; keys each child
  const legacy = itemClassName !== undefined;
  const onFocus = (event: FocusEvent<HTMLUListElement>) => {
    const row = event.currentTarget;
    const target = event.target;
    if (target === row || !(target instanceof Element)) return;
    // keyboard focus only: a pointer press focuses a link too, and scrolling then would move the card from under it
    if (performance.now() - pointer.current < 800 || !target.matches(":focus-visible")) return;
    const item = [...row.children].find((child) => child.contains(target));
    if (item) revealInRow(row, item, "start");
  };
  return (
    <div className={cx("min-w-0", className)}>
      <ul
        ref={rail.props.ref}
        tabIndex={rail.props.tabIndex}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        className={cx(legacy ? cx(rail.props.className, "gap-card") : "rail", "focus-visible:-outline-offset-2", railClassName)}
        onFocus={onFocus}
        onPointerDown={() => {
          pointer.current = performance.now();
        }}
      >
        {items.map((child, index) => (
          <li key={isValidElement(child) && child.key !== null ? child.key : index} className={cx("min-w-0 [&>*]:h-full", itemClassName)}>
            {child}
          </li>
        ))}
      </ul>
    </div>
  );
}
