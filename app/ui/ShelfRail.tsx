import { useId, type ReactNode } from "react";

import { LocaleLink, useT } from "~/i18n/react";
import type { ProductCardData, Shelf } from "~/lib/dto";
import { useRail } from "~/motion";
import { cx } from "./cx";
import { IconKey } from "./IconKey";
import { ProductCard } from "./ProductCard";
import { TextLink } from "./TextLink";

/**
 * A shelf (docs/DESIGN.md §8 "floor, stage, keys, shelf"): a section head at the start — the title and the honest
 * reason it is shown (`Shelf.reason`: "متوافق مع Nintendo Switch 2", "اقتراحات المتجر"; never "customers also
 * bought" without real data) — the one "view all" link at the end, then one rail of cards.
 *
 *   <ShelfRail shelf={shelf} href="/c/new-arrivals" />                              Shelf<ProductCardData>
 *   <ShelfRail shelf={usedShelf} renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" />} />
 *
 * The rail is the Motion Engine's (`useRail`): native scroll-snap with the platform's momentum, ← → that follow the
 * reading direction when focused, Home/End, an edge bump for mouse and keys; the step keys appear from 1024px.
 * Items are cards of a fixed share of the rail: 2 and a peek on a phone, 6 on a desktop. An empty shelf renders
 * nothing (or `emptyText`) — never placeholder products.
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
  className?: string;
};

export function ShelfRail<T extends { id: string }>({ shelf, href, viewAllLabel, renderItem, headingLevel = 2, emptyText, className }: ShelfRailProps<T>) {
  const t = useT("ui-shop");
  const id = useId();
  const rail = useRail<HTMLDivElement>();
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
        <div className="flex shrink-0 items-center gap-3">
          {href ? (
            <TextLink as={LocaleLink} to={href}>
              {viewAllLabel ?? t("shelf.viewAll")}
            </TextLink>
          ) : null}
          {shelf.items.length > 4 ? (
            <span className="hidden items-center gap-2 lg:flex">
              <IconKey icon="arrow-left" size="sm" label={t("shelf.previous")} onClick={() => rail.step(false)} />
              <IconKey icon="arrow-right" size="sm" label={t("shelf.next")} onClick={() => rail.step(true)} />
            </span>
          ) : null}
        </div>
      </div>
      {shelf.items.length === 0 ? (
        <p className="rounded-lg bg-niche px-4 py-6 type-body text-ink-2">{emptyText}</p>
      ) : (
        <div {...rail.props} aria-labelledby={id} className={cx(rail.props.className, "-mx-1 gap-card px-1 pt-1 pb-3")}>
          {shelf.items.map((item, index) => (
            <div key={item.id} className="flex w-[43%] sm:w-[30%] md:w-[23%] lg:w-[18.6%] xl:w-[15.4%]">
              {draw(item, index)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
