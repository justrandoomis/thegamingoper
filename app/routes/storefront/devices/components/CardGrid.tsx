import { useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { useT } from "~/i18n/react";
import type { ProductCardData } from "~/lib/dto";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { ProductCard } from "~/ui/ProductCard";
import { expandedGrids, toggleGrid } from "./format";

export type GridItem = { card: ProductCardData; note?: ReactNode };

/**
 * The products of one hub section (editions, compatible accessories and games, parts) — Design System v2 §6.6, §4.11:
 * the kit's frameless cards in whole rows (2 → 3 → 4 → 5 columns), each with its compatibility note under it on one
 * shared line (devices.css: a two-row subgrid per item, so prices align on the pinned foot). Two rows show at first;
 * «اعرض كل الإكسسوارات (18)» opens the rest in place, and appears only when more exist at the current width. A section
 * with ONE item draws it as a `row` card instead (§6.6); an empty one draws nothing — the caller hides its section.
 *
 *   <CardGrid items={editions.map((card) => ({ card }))} slot="versions" anchor="versions" allLabel={t("versions.all", { n })} />
 *
 * The choice lives in the URL (`?all=<slot>`, format.ts), as list state does in the kit (ShowMore): the key is a real
 * link, so it works before JavaScript (the page comes back with the grid open, at `#anchor`), and Back or a reload
 * keep the grid open — so the scroll position they restore still points at the same card. With JavaScript the grid
 * opens at once and the URL follows with a `replace` (the route's shouldRevalidate does not reload anything).
 *
 * `slot` keeps shared-element names apart when one product sits in two sections, and names the grid in the URL; the
 * cards' names are h3 under the section's h2 (h4 under a group's h3).
 */
export function CardGrid({
  items,
  slot,
  anchor,
  allLabel,
  headingLevel = 3,
  className,
}: {
  items: readonly GridItem[];
  slot: string;
  /** The id of the section the grid is in: where a page loaded with the grid open lands. */
  anchor: string;
  allLabel: string;
  headingLevel?: 3 | 4;
  className?: string;
}) {
  const t = useT("devices");
  const listId = useId();
  const location = useLocation();
  const navigate = useNavigate();
  const key = useRef<HTMLAnchorElement>(null);
  // the URL wins whenever it changes (Back, Forward, a link); a tap wins until the URL catches up
  const fromUrl = expandedGrids(location.search).has(slot);
  const [open, setOpen] = useState(fromUrl);
  const [seen, setSeen] = useState(fromUrl);
  if (fromUrl !== seen) {
    setSeen(fromUrl);
    setOpen(fromUrl);
  }
  if (items.length === 0) return null;
  if (items.length === 1) {
    const only = items[0];
    return (
      <div className={cx("grid max-w-[40rem] gap-2", className)}>
        <ProductCard card={only.card} slot={slot} layout="row" headingLevel={headingLevel} />
        {only.note ? <div className="min-w-0 ps-[112px]">{only.note}</div> : null}
      </div>
    );
  }

  const search = toggleGrid(location.search, slot);
  const toggle = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const next = !open;
    setOpen(next);
    void navigate({ pathname: location.pathname, search, hash: location.hash }, { replace: true, preventScrollReset: true });
    // folding a long grid moves the key up: keep it where the eye is
    if (!next) requestAnimationFrame(() => key.current?.scrollIntoView({ block: "nearest" }));
  };

  return (
    <div className={cx("min-w-0", className)}>
      <ul id={listId} role="list" className="devhub-cards" data-collapsed={open ? undefined : ""}>
        {items.map((item) => (
          <li key={item.card.id}>
            <ProductCard card={item.card} slot={slot} headingLevel={headingLevel} />
            {/* the second row of the item's subgrid: its note, or nothing that takes space */}
            {item.note ? <div className="min-w-0">{item.note}</div> : <span aria-hidden="true" />}
          </li>
        ))}
      </ul>
      <div className="devhub-more">
        <Key ref={key} size="sm" as="a" href={`${location.pathname}${search}#${anchor}`} aria-expanded={open} aria-controls={listId} onClick={toggle}>
          {open ? t("more.less") : allLabel}
        </Key>
      </div>
    </div>
  );
}
