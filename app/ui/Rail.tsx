import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";

import { useT } from "~/i18n/react";
import { useRail } from "~/motion";
import { cx } from "./cx";
import { IconKey } from "./IconKey";

/**
 * Rail — one row of things that scrolls sideways (DESIGN.md §8: a shelf is a section head, then one grid or rail).
 * Scrolling is native: scroll-snap with the platform's own momentum and rubber band, never scroll-jacking (the
 * Motion Engine's useRail). The rail is one tab stop: ← → move an item (mirrored in RTL), Page Up / Down a screen,
 * Home / End the ends. From 1024px two small round keys step through it; each hides at its end. An edge fade in
 * the colour of the surface behind says "there is more this way" — opacity only, never glass, never a scroll
 * listener (IntersectionObserver watches the first and last items).
 *
 *   <Rail aria-label={t("newArrivals")}>
 *     {cards.map((card) => <ProductCard key={card.id} card={card} />)}
 *   </Rail>
 *   <Rail aria-labelledby={headingId} itemClassName="w-[132px]" fade="paper">…</Rail>
 *
 * Each child becomes one <li> (a snap point) sized by `itemClassName` (default: two and a peek on a phone, about
 * six on a desktop). Cards in a rail carry no light and no glass.
 */
export type RailProps = {
  children: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** The step keys from 1024px. Default true. */
  keys?: boolean;
  /** The surface the rail sits on, for the edge fade: "ground" (default), "paper", "niche", or false for none. */
  fade?: "ground" | "paper" | "niche" | false;
  /** Sizes each item. Default: 43% · 30% from 600 · 23% from 768 · 18.6% from 1024 · 15.4% from 1200. */
  itemClassName?: string;
  /** Items lean as they enter and leave (the engine's tilt; full motion tier, LTR only today). */
  tilt?: boolean;
  /** On the outer box. */
  className?: string;
  /** On the scrolling list (padding, gap). */
  railClassName?: string;
};

const ITEM = "flex w-[43%] sm:w-[30%] md:w-[23%] lg:w-[18.6%] xl:w-[15.4%]";

export function Rail({ children, keys = true, fade = "ground", itemClassName = ITEM, tilt = false, className, railClassName, ...aria }: RailProps) {
  const t = useT("ui-overlays");
  const rail = useRail<HTMLUListElement>({ tilt });
  const items = Children.toArray(children); // drops null, undefined and booleans; keys each child
  // Server and first paint: assume more lies ahead (the usual case); the observer corrects it after hydration.
  const [edges, setEdges] = useState({ start: true, end: false });
  const scroller = rail.props.ref;

  useEffect(() => {
    const list = scroller.current;
    const first = list?.firstElementChild;
    const last = list?.lastElementChild;
    if (!list || !first || !last || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        setEdges((previous) => {
          let next = previous;
          for (const entry of entries) {
            const whole = entry.isIntersecting && entry.intersectionRatio > 0.97;
            if (entry.target === first && next.start !== whole) next = { ...next, start: whole };
            if (entry.target === last && next.end !== whole) next = { ...next, end: whole };
          }
          return next;
        });
      },
      { root: list, threshold: [0, 0.5, 0.97, 1] },
    );
    observer.observe(first);
    if (last !== first) observer.observe(last);
    return () => observer.disconnect();
  }, [scroller, items.length]);

  const surface = fade ? `var(--${fade})` : null;
  return (
    <div className={cx("relative min-w-0", className)}>
      <ul
        {...rail.props}
        role="list"
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        className={cx(rail.props.className, "gap-card rounded-sm", railClassName)}
      >
        {items.map((child, index) => (
          <li key={isValidElement(child) && child.key !== null ? child.key : index} className={itemClassName}>
            {child}
          </li>
        ))}
      </ul>
      {surface ? (
        <>
          <span
            aria-hidden="true"
            className={cx("pointer-events-none absolute inset-y-0 start-0 w-8 transition-opacity duration-(--t-micro)", edges.start ? "opacity-0" : "opacity-100")}
            style={{ backgroundImage: `linear-gradient(calc(90deg * var(--dir)), ${surface}, transparent)` }}
          />
          <span
            aria-hidden="true"
            className={cx("pointer-events-none absolute inset-y-0 end-0 w-8 transition-opacity duration-(--t-micro)", edges.end ? "opacity-0" : "opacity-100")}
            style={{ backgroundImage: `linear-gradient(calc(-90deg * var(--dir)), ${surface}, transparent)` }}
          />
        </>
      ) : null}
      {keys ? (
        <>
          <IconKey
            icon="arrow-left"
            size="sm"
            label={t("rail.previous")}
            tabIndex={-1}
            onClick={() => rail.step(false)}
            className={cx("absolute start-1 top-1/2 hidden -translate-y-1/2 lg:inline-flex", edges.start && "invisible")}
          />
          <IconKey
            icon="arrow-right"
            size="sm"
            label={t("rail.next")}
            tabIndex={-1}
            onClick={() => rail.step(true)}
            className={cx("absolute end-1 top-1/2 hidden -translate-y-1/2 lg:inline-flex", edges.end && "invisible")}
          />
        </>
      ) : null}
    </div>
  );
}
