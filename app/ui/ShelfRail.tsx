import { Fragment, useId, type ReactNode } from "react";

import type { ProductCardData, Shelf } from "~/lib/dto";
import { cx } from "./cx";
import { ProductCard } from "./ProductCard";
import { Rail } from "./Rail";
import { SectionHead } from "./SectionHead";

/**
 * A shelf — Design System v2 §4.22: the section head (the h2 and the HONEST reason it is shown — `Shelf.reason`:
 * «متوافق مع Nintendo Switch 2», «أحدث ما أضفناه، والمتوفر الآن»; never "customers also bought" without real data — and
 * «عرض الكل» at the end), then one rail: a native scroll-snap row on phones (2.15 cards), a grid of whole cards from
 * 1024 (4-up, 5-up from 1280). A shelf with FEWER THAN 3 ITEMS does not render (`minItems`) — never placeholder
 * products; a device hub shows a single item as a row card instead.
 *
 *   <ShelfRail shelf={shelf} href="/c/new-arrivals" />                              Shelf<ProductCardData>
 *   <ShelfRail shelf={usedShelf} renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" />} />
 *   <ShelfRail shelf={shelf} chips={<ChipGroup rail bleed … />} />                  platform chips that filter in place
 *
 * Each card gets `slot={shelf.key}`, so the same product on two shelves of one page morphs from the right one.
 */
export type ShelfRailProps<T extends { id: string }> = {
  shelf: Shelf<T>;
  /** «عرض الكل» destination (locale-less path). No link without it. */
  href?: string | null;
  viewAllLabel?: ReactNode;
  /** Draws one item. Default: <ProductCard card={item} slot={shelf.key} />. */
  renderItem?: (item: T, index: number) => ReactNode;
  /** Heading level of the title (default 2). */
  headingLevel?: 2 | 3;
  /** A chip row under the head (filters the shelf in place). */
  chips?: ReactNode;
  /** Fewer items than this and the shelf does not render. Default 3. */
  minItems?: number;
  /** Shown in place of the rail when the shelf has no items (otherwise an empty shelf renders nothing). */
  emptyText?: ReactNode;
  /** 1.0 — ignored. */
  fade?: unknown;
  className?: string;
};

export function ShelfRail<T extends { id: string }>({ shelf, href, viewAllLabel, renderItem, headingLevel = 2, chips, minItems = 3, emptyText, className }: ShelfRailProps<T>) {
  const id = useId();
  const count = shelf.items.length;
  if (count === 0 && !emptyText) return null;
  if (count > 0 && count < minItems) return null;
  const draw = renderItem ?? ((item: T) => <ProductCard card={item as unknown as ProductCardData} slot={shelf.key} />);

  return (
    <section aria-labelledby={id} className={cx("min-w-0", className)} data-shelf={shelf.key}>
      <SectionHead id={id} title={shelf.title} reason={shelf.reason} href={href ?? undefined} viewAllLabel={viewAllLabel} headingLevel={headingLevel} chips={chips} />
      {count === 0 ? (
        <p className="panel px-4 py-6 type-body text-ink-2">{emptyText}</p>
      ) : (
        <Rail aria-labelledby={id}>
          {shelf.items.map((item, index) => (
            <Fragment key={item.id}>{draw(item, index)}</Fragment>
          ))}
        </Rail>
      )}
    </section>
  );
}
