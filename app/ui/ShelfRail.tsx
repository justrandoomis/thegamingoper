import { Fragment, useId, type ReactNode } from "react";

import { LocaleLink, useT } from "~/i18n/react";
import type { ProductCardData, Shelf } from "~/lib/dto";
import { cx } from "./cx";
import { ProductCard } from "./ProductCard";
import { Rail, type RailProps } from "./Rail";
import { TextLink } from "./TextLink";

/**
 * A shelf (docs/DESIGN.md §8 "floor, stage, keys, shelf"): a section head at the start — the title and the honest
 * reason it is shown (`Shelf.reason`: "متوافق مع Nintendo Switch 2", "اقتراحات المتجر"; never "customers also
 * bought" without real data) — the one "view all" link at the end, then one rail of cards.
 *
 *   <ShelfRail shelf={shelf} href="/c/new-arrivals" />                              Shelf<ProductCardData>
 *   <ShelfRail shelf={usedShelf} renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" />} />
 *
 * The rail is ~/ui/Rail: native scroll-snap with the platform's momentum, ← → that follow the reading direction
 * when focused, Home/End, the step keys from 1024px and an edge fade. Items are cards of a fixed share of the rail:
 * 2 and a peek on a phone, 6 on a desktop. An empty shelf renders nothing (or `emptyText`) — never placeholder
 * products. Each card gets `slot={shelf.key}`, so the same product on two shelves of one page morphs from the right one.
 */
export type ShelfRailProps<T extends { id: string }> = {
  shelf: Shelf<T>;
  /** "View all" destination (locale-less path). No link without it. */
  href?: string | null;
  viewAllLabel?: ReactNode;
  /** Draws one item. Default: <ProductCard card={item} slot={shelf.key} />. */
  renderItem?: (item: T, index: number) => ReactNode;
  /** Heading level of the title (default 2). */
  headingLevel?: 2 | 3;
  /** Shown (in place of the rail) when the shelf has no items; without it an empty shelf renders nothing. */
  emptyText?: ReactNode;
  /** The surface under the shelf, for the rail's edge fade (default "ground"). */
  fade?: RailProps["fade"];
  className?: string;
};

export function ShelfRail<T extends { id: string }>({ shelf, href, viewAllLabel, renderItem, headingLevel = 2, emptyText, fade = "ground", className }: ShelfRailProps<T>) {
  const t = useT("ui-shop");
  const id = useId();
  const Heading = `h${headingLevel}` as const;
  if (shelf.items.length === 0 && !emptyText) return null;
  const draw = renderItem ?? ((item: T) => <ProductCard card={item as unknown as ProductCardData} slot={shelf.key} />);

  return (
    <section aria-labelledby={id} className={cx("grid min-w-0 gap-3", className)} data-shelf={shelf.key}>
      <div className="flex items-end justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <Heading id={id} className="type-section text-ink">
            {shelf.title}
          </Heading>
          {shelf.reason ? <p className="type-caption text-ink-2">{shelf.reason}</p> : null}
        </div>
        {href ? (
          <TextLink as={LocaleLink} to={href} className="shrink-0">
            {viewAllLabel ?? t("shelf.viewAll")}
          </TextLink>
        ) : null}
      </div>
      {shelf.items.length === 0 ? (
        <p className="rounded-lg bg-niche px-4 py-6 type-body text-ink-2">{emptyText}</p>
      ) : (
        // 4px of room on every side for focus rings and the socket's wall; scroll-padding keeps snapping inside it.
        <Rail aria-labelledby={id} fade={fade} railClassName="-mx-1 scroll-px-1 px-1 pt-1 pb-3">
          {shelf.items.map((item, index) => (
            <Fragment key={item.id}>{draw(item, index)}</Fragment>
          ))}
        </Rail>
      )}
    </section>
  );
}
