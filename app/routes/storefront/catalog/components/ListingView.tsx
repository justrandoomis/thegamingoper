/**
 * A product list as every catalog page shows it (DESIGN.md §8.3): a sticky row with the count, the sort and the
 * filter key; the active filters as removable chips; the grid of product cards (2 → 3 → 4 → 5 columns); "show more";
 * and, when nothing matches, the recovery: the filter to remove (with what it would show), then three picks.
 *
 * Everything is a URL (listing-model.ts): chips and "show more" are links, so the list works without script; the
 * filter sheet and the sort menu are the script-only conveniences, and a native GET form (filters and sort) replaces
 * them without script. While new results load, the old ones stay usable (marked busy) and the chips already show
 * their new state; when the results land, cards that stayed slide to their new place and new ones inflate.
 */
import { useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";

import type { ProductCardData } from "~/lib/dto";
import { useFormat, useT } from "~/i18n/react";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Menu } from "~/ui/Menu";
import { useOnline } from "~/ui/OfflineBanner";
import { HrefLink, ShowMore } from "~/ui/Pagination";
import { isPlatform } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { ProductCard } from "~/ui/ProductCard";
import { Sheet } from "~/ui/Sheet";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { NO_FILTERS, activeGroups, withoutGroup, type FilterGroup, type ListingFacets, type ListingFilters, type ListingQuery, type ListingSort } from "../listing-model";
import { FilterPanel } from "./FilterPanel";
import { InPageDir } from "./InPageDir";
import { useFlip } from "./use-flip";
import type { ListingNav } from "./use-listing-nav";

/** What a page's loader hands the list (a ListingResult without the hub). */
export type ListingData = {
  items: ProductCardData[];
  total: number;
  nextCursor: string | null;
  offset: number;
  sort: ListingSort;
  filters: ListingFilters;
  scopeTotal: number;
  facets: ListingFacets;
  relax: { group: FilterGroup; count: number }[];
};

export type ListingViewProps = {
  list: ListingData;
  nav: ListingNav;
  scope: "category" | "platform" | "search";
  sorts: readonly ListingSort[];
  /** Zero results: what to say, and what to offer after the filters (search: the shorter queries). */
  zero: { title: ReactNode; text: ReactNode; extra?: ReactNode };
  /** Zero results: a few products to go on with, and their honest heading. */
  picks: ProductCardData[];
  picksTitle: string;
  /** Section heading (visually hidden) — names the list for screen readers. */
  heading: string;
};

/** Words for one active filter value. */
export function useFilterLabel(facets: ListingFacets) {
  const t = useT("catalog");
  const ui = useT("ui");
  const f = useFormat();
  return (group: FilterGroup, filters: ListingFilters, value?: string): string => {
    switch (group) {
      case "platforms": {
        const slug = value ?? "";
        return isPlatform(slug) ? ui(`platform.${slug}`) : (facets.platforms.find((option) => option.value === slug)?.label ?? slug);
      }
      case "category":
        return facets.categories.find((option) => option.value === filters.category)?.label ?? t("filter.categoryOther");
      case "device":
        return facets.devices.find((option) => option.value === filters.device)?.label ?? t("filter.deviceOther");
      case "price":
        return filters.priceMin === null
          ? t("filter.priceUpTo", { max: iqdText(f, filters.priceMax ?? 0) })
          : filters.priceMax === null
            ? t("filter.priceFrom", { min: iqdText(f, filters.priceMin) })
            : t("filter.priceBetween", { min: iqdText(f, filters.priceMin), max: iqdText(f, filters.priceMax) });
      case "inStock":
        return t("filter.inStock");
      case "deals":
        return t("filter.deals");
      case "arabic":
        return filters.arabic ? t(`filter.arabicLevel.${filters.arabic}`) : "";
      case "formats":
        return value ? t(`filter.formatValue.${value}`) : "";
    }
  };
}

/** One removable chip per active filter value, in the order of the filter groups. */
function activeChips(filters: ListingFilters, label: ReturnType<typeof useFilterLabel>, nav: ListingNav): { key: string; label: string; href: string }[] {
  const chips: { key: string; label: string; href: string }[] = [];
  for (const group of activeGroups(filters)) {
    if (group === "platforms") {
      for (const platform of filters.platforms) chips.push({ key: `platform:${platform}`, label: label(group, filters, platform), href: nav.href({ platforms: filters.platforms.filter((p) => p !== platform) }) });
    } else if (group === "formats") {
      for (const format of filters.formats) chips.push({ key: `format:${format}`, label: label(group, filters, format), href: nav.href({ formats: filters.formats.filter((v) => v !== format) }) });
    } else {
      chips.push({ key: group, label: label(group, filters), href: nav.href(withoutGroup(filters, group)) });
    }
  }
  return chips;
}

const noop = () => {};

function ActiveFilters({ filters, facets, nav }: { filters: ListingFilters; facets: ListingFacets; nav: ListingNav }) {
  const t = useT("catalog");
  const label = useFilterLabel(facets);
  const chips = activeChips(filters, label, nav);
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, chips.map((chip) => chip.key).join("|"));
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div ref={ref} className="chips" role="group" aria-label={t("list.active")}>
        {chips.map((chip) => (
          // a real link with the remove semantics: works without script
          <Chip key={chip.key} data-flip={chip.key} as={HrefLink} to={chip.href} onRemove={noop}>
            <InPageDir>{chip.label}</InPageDir>
          </Chip>
        ))}
      </div>
      {chips.length > 1 ? (
        <TextLink as={HrefLink} to={nav.href({ ...NO_FILTERS })} arrow={false} className="type-label">
          {t("list.clearAll")}
        </TextLink>
      ) : null}
    </div>
  );
}

function SortControl({ nav, sorts, sort, disabled }: { nav: ListingNav; sorts: readonly ListingSort[]; sort: ListingSort; disabled: boolean }) {
  const t = useT("catalog");
  return (
    <Menu
      label={t("sort.label")}
      title={t("sort.label")}
      align="end"
      trigger={(props) => (
        <Key {...props} size="sm" icon="sort-ascending" iconEnd="caret-down" disabled={disabled} className="catalog-js-only">
          <VisuallyHidden>{t("sort.label")}: </VisuallyHidden>
          {t(`sort.${sort}`)}
        </Key>
      )}
      items={sorts.map((value) => ({ id: value, kind: "radio" as const, label: t(`sort.${value}`), checked: value === sort, onSelect: () => nav.go({ sort: value === sorts[0] ? null : value }) }))}
    />
  );
}

export function ListingView({ list, nav, scope, sorts, zero, picks, picksTitle, heading }: ListingViewProps) {
  const t = useT("catalog");
  const f = useFormat();
  const location = useLocation();
  const online = useOnline();
  const [sheetOpen, setSheetOpen] = useState(false);
  const changedInSheet = useRef(false);
  const grid = useRef<HTMLUListElement>(null);
  useFlip(grid, list.items.map((card) => card.id).join("|"));

  const query: ListingQuery = nav.query;
  const sort = query.sort ?? list.sort;
  const activeCount = activeGroups(query).length;
  const filtersLabel = activeCount > 0 ? t("list.filtersCount", { count: activeCount, n: f.number(activeCount) }) : t("list.filters");
  const resultsText = t("list.results", { count: list.total, n: f.number(list.total) });

  const openSheet = () => {
    changedInSheet.current = false;
    setSheetOpen(true);
  };
  // the first change while the sheet is open adds a history entry; the next ones replace it (Back leaves the sheet's
  // whole session in one step)
  const changeFromSheet = (change: Partial<ListingQuery>) => {
    nav.go(change, { replace: changedInSheet.current });
    changedInSheet.current = true;
  };

  const shownTo = list.offset + list.items.length;
  const pagingAlone = list.offset > 0;
  const moreHref = list.nextCursor ? nav.href({ cursor: list.nextCursor }) : null;
  const loadingMore = nav.pending && nav.query.cursor !== null && nav.query.cursor === list.nextCursor;

  return (
    <section aria-labelledby="catalog-results" className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <VisuallyHidden as="h2" id="catalog-results">
        {heading}
      </VisuallyHidden>

      <div className="catalog-toolbar">
        <p className="type-label text-ink" aria-live="polite">
          {nav.pending ? t("list.updating") : <bdi className="nums">{resultsText}</bdi>}
        </p>
        <div className="flex items-center gap-2">
          {sorts.length > 1 ? <SortControl nav={nav} sorts={sorts} sort={sort} disabled={!online} /> : null}
          <Key size="sm" icon="sliders-horizontal" aria-haspopup="dialog" onClick={openSheet} disabled={!online} className="catalog-js-only">
            {filtersLabel}
          </Key>
        </div>
        {!online ? <p className="catalog-toolbar__note type-caption text-ink-2">{t("list.offline")}</p> : null}
      </div>

      {/* No script: the same filters and the sort in a plain GET form. Hidden from the first paint when script runs. */}
      <details className="catalog-nojs panel p-4">
        <summary className="type-label text-ink">{t("filter.nojsSummary")}</summary>
        <div className="pt-4">
          <FilterPanel mode="form" query={query} facets={list.facets} scope={scope} sorts={sorts} sort={sort} hidden={nav.extra} action={location.pathname} />
        </div>
      </details>

      <ActiveFilters filters={query} facets={list.facets} nav={nav} />

      {list.total === 0 ? (
        <ZeroResults list={list} nav={nav} zero={zero} picks={picks} picksTitle={picksTitle} />
      ) : (
        <>
          {pagingAlone ? (
            <p className="type-caption text-ink-2">
              <bdi className="nums">{t("list.window", { from: f.number(list.offset + 1), to: f.number(shownTo), total: f.number(list.total) })}</bdi>{" "}
              <TextLink as={HrefLink} to={nav.href({})} inline>
                {t("list.backToStart")}
              </TextLink>
            </p>
          ) : null}
          <ul ref={grid} role="list" aria-busy={nav.pending || undefined} className={cx("catalog-grid", nav.pending && "catalog-grid--busy")}>
            {list.items.map((card, index) => (
              <li key={card.id} data-flip={card.id} className="flex">
                <ProductCard card={card} headingLevel={3} priority={index === 0 && list.offset === 0 && scope === "search"} />
              </li>
            ))}
          </ul>
          <ShowMore shown={shownTo} total={list.total} href={moreHref} loading={loadingMore} />
        </>
      )}

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t("filter.title")}
        description={nav.pending ? t("list.updating") : resultsText}
        presentation="side"
        footer={
          <>
            {/* content-sized, so "show N products" keeps its words in every language (the footer shares by default) */}
            <Key onClick={() => changeFromSheet({ ...NO_FILTERS })} disabled={activeCount === 0} className="flex-none!">
              {t("list.clearAll")}
            </Key>
            <Key variant="ink" onClick={() => setSheetOpen(false)}>
              {nav.pending ? t("filter.showPending") : t("filter.show", { count: list.total, n: f.number(list.total) })}
            </Key>
          </>
        }
      >
        <FilterPanel mode="live" query={query} facets={list.facets} scope={scope} onChange={changeFromSheet} />
      </Sheet>
    </section>
  );
}

function ZeroResults({ list, nav, zero, picks, picksTitle }: { list: ListingData; nav: ListingNav; zero: ListingViewProps["zero"]; picks: ProductCardData[]; picksTitle: string }) {
  const t = useT("catalog");
  const f = useFormat();
  const label = useFilterLabel(list.facets);
  const filters = list.filters;
  const groups = activeGroups(filters);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <EmptyState
        layout="stack"
        icon="magnifying-glass"
        title={zero.title}
        text={zero.text}
        headingLevel={3}
        action={
          groups.length > 1 ? (
            <Key as={HrefLink} to={nav.href({ ...NO_FILTERS })}>
              {t("zero.clearAll")}
            </Key>
          ) : undefined
        }
      />
      {list.relax.length > 0 ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <p className="type-label text-ink">{t("zero.nearest")}</p>
          <ul role="list" className="grid grid-cols-[minmax(0,1fr)] gap-1">
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
      ) : null}
      {zero.extra}
      {picks.length > 0 ? (
        <section aria-labelledby="catalog-picks" className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <h3 id="catalog-picks" className="type-section text-ink">
            {picksTitle}
          </h3>
          <ul role="list" className="catalog-grid">
            {picks.map((card) => (
              <li key={card.id} className="flex">
                <ProductCard card={card} slot="picks" headingLevel={4} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
