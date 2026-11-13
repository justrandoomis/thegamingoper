/**
 * A list whose filters hide every product (Design System v2 §6.2 states; v2.1: on the kit's soft card, the funnel
 * large on its disc): «لا منتجات بهذه الفلاتر», the view's one primary «امسح الفلاتر» (a choice made in the chip row
 * stays), the filter whose removal alone shows products (with how many) on its own lines under the key, then a few
 * products of the scope that can be bought now. Its own module: the filter sheet's primary belongs to another view
 * (the sheet).
 */
import { useId, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import type { ProductCardData } from "~/lib/dto";
import { useFormat, useT } from "~/i18n/react";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { HrefLink } from "~/ui/Pagination";
import { ProductCard } from "~/ui/ProductCard";
import { TextLink } from "~/ui/TextLink";
import { NO_FILTERS, activeGroups, withoutGroup, type FilterGroup } from "../listing-model";
import { keepElsewhere, useFilterLabel, type ListingData } from "./listing-parts";
import type { ListingNav } from "./use-listing-nav";

export type ZeroResultsProps = {
  list: ListingData;
  nav: ListingNav;
  zero: { title: ReactNode; text: ReactNode; extra?: ReactNode };
  picks: ProductCardData[];
  picksTitle: string;
  elsewhere: readonly FilterGroup[];
  wished: Set<string>;
  hearts: boolean;
};

export function ZeroResults({ list, nav, zero, picks, picksTitle, elsewhere, wished, hearts }: ZeroResultsProps) {
  const t = useT("catalog");
  const f = useFormat();
  const label = useFilterLabel(list.facets);
  const filters = list.filters;
  const groups = activeGroups(filters);
  const picksId = useId();
  const nearest =
    list.relax.length > 0 ? (
      <div className="catalog-zero__nearest">
        <p className="type-sm-strong text-ink">{t("zero.nearest")}</p>
        <ul role="list" className="grid">
          {list.relax.slice(0, 3).map((entry) => {
            const words =
              entry.group === "platforms"
                ? filters.platforms.map((platform) => label("platforms", filters, platform)).join("، ")
                : entry.group === "formats"
                  ? filters.formats.map((format) => label("formats", filters, format)).join("، ")
                  : label(entry.group, filters);
            return (
              <li key={entry.group}>
                <TextLink as={HrefLink} to={nav.href(withoutGroup(filters, entry.group))}>
                  {t("zero.remove", { label: words, count: entry.count, n: f.number(entry.count) })}
                </TextLink>
              </li>
            );
          })}
        </ul>
      </div>
    ) : null;
  return (
    <div className="catalog-zero">
      {/* the funnel large on its disc, on the soft card: what happened, the one key, then the nearest way back */}
      <EmptyState
        layout="stack"
        panel
        art={<Icon name="funnel" size={44} className="text-red-ink" />}
        title={zero.title}
        text={zero.text}
        headingLevel={3}
        action={
          groups.length > 0 || nearest ? (
            <>
              {groups.length > 0 ? (
                <Key variant="primary" as={HrefLink} to={nav.href({ ...NO_FILTERS, ...keepElsewhere(nav.query, elsewhere) })} icon="x">
                  {t("zero.clearAll")}
                </Key>
              ) : null}
              {nearest}
            </>
          ) : undefined
        }
      />
      {zero.extra}
      {picks.length > 0 ? (
        <section aria-labelledby={picksId} className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <h3 id={picksId} className="type-h3 text-ink">
            {picksTitle}
          </h3>
          <ul role="list" className="catalog-grid">
            {picks.map((card) => (
              <li key={card.id} className="catalog-grid__item">
                <ProductCard card={card} slot="picks" headingLevel={4} wishlist={hearts} wished={wished.has(card.id)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
