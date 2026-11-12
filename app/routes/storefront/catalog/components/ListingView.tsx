/**
 * A product list as every catalog page shows it (Design System v2 §6.2, §6.3): from 1024 a sticky filter sidebar
 * (264px) at the inline start beside the results; below 1024 the filters live in a sheet (a bottom sheet on phones, a
 * side sheet from 768). The results column: the toolbar (the count, the sort's explanation, the sort control — and
 * below 1024 «الفلاتر (2)» and «الترتيب»), the active filters as removable chips, the grid of product cards (2 → 3 →
 * 3 beside the sidebar → 4 from 1280), «اعرض المزيد» with its progress, and — when nothing matches — the recovery:
 * «امسح الفلاتر», the filter to remove (with what it would show), then a few products to go on with.
 *
 * Everything is a URL (listing-model.ts): chips and «اعرض المزيد» are links and the filters are a GET form, so the list
 * works without script; the sheet, the sort menu and the floating «الفلاتر | الترتيب» pill (it appears above the tab
 * bar once the toolbar has scrolled away) are the script's conveniences. While new results load, the old ones stay
 * usable (marked busy) and every control already shows its new state; when the results land, cards that stayed
 * slide to their new place and new ones grow in (use-flip.ts). Filtering never blocks.
 */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation } from "react-router";

import type { ProductCardData } from "~/lib/dto";
import { useFormat, useT } from "~/i18n/react";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { Menu, type MenuTriggerProps } from "~/ui/Menu";
import { useOnline } from "~/ui/OfflineBanner";
import { HrefLink, ShowMore } from "~/ui/Pagination";
import { ProductCard } from "~/ui/ProductCard";
import { Sheet } from "~/ui/Sheet";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { LISTING_PAGE_SIZE, NO_FILTERS, activeGroups, withoutGroup, type FilterGroup, type ListingFacets, type ListingFilters, type ListingQuery, type ListingSort } from "../listing-model";
import { CatalogDock } from "./CompareTray";
import { FilterPanel } from "./FilterPanel";
import { keepElsewhere, useFilterLabel, type ListingData } from "./listing-parts";
import { useFlip } from "./use-flip";
import type { ListingNav } from "./use-listing-nav";
import { ZeroResults } from "./ZeroResults";

export type { ListingData };

export type ListingViewProps = {
  list: ListingData;
  nav: ListingNav;
  scope: "category" | "platform" | "search";
  sorts: readonly ListingSort[];
  /** Zero results: what to say, and what to offer after the filters. */
  zero: { title: ReactNode; text: ReactNode; extra?: ReactNode };
  /** Zero results: a few products to go on with, and their honest heading. */
  picks: ProductCardData[];
  picksTitle: string;
  /** Section heading (visually hidden) — names the list for screen readers. */
  heading: string;
  /** Filter groups the page's chip row offers: not repeated in the filters. */
  elsewhere?: readonly FilterGroup[];
  /** Phones: a block inside the grid after its first two rows (the platform hub's device tiles). */
  inline?: ReactNode;
  /** Ids of the shopper's wishlist among these cards: the cards show the heart. Null: no hearts. */
  wished?: readonly string[] | null;
};

/** Cards before the phone's inline block: two rows of two. */
const INLINE_AFTER = 4;

/** One removable chip per active filter value, in the order of the filter groups. */
function activeChips(filters: ListingFilters, label: ReturnType<typeof useFilterLabel>, nav: ListingNav, elsewhere: readonly FilterGroup[]): { key: string; label: string; href: string }[] {
  const chips: { key: string; label: string; href: string }[] = [];
  for (const group of activeGroups(filters)) {
    // a choice made in the chip row shows there (the chosen chip), not twice
    if (elsewhere.includes(group)) continue;
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

function ActiveFilters({ filters, facets, nav, elsewhere }: { filters: ListingFilters; facets: ListingFacets; nav: ListingNav; elsewhere: readonly FilterGroup[] }) {
  const t = useT("catalog");
  const label = useFilterLabel(facets);
  const chips = activeChips(filters, label, nav, elsewhere);
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, chips.map((chip) => chip.key).join("|"));
  if (chips.length === 0) return null;
  return (
    <div className="catalog-active">
      <div ref={ref} className="chips" role="group" aria-label={t("list.active")}>
        {chips.map((chip) => (
          // a real link with the remove semantics: works without script
          <Chip key={chip.key} data-flip={chip.key} as={HrefLink} to={chip.href} onRemove={noop}>
            {chip.label}
          </Chip>
        ))}
      </div>
      {chips.length > 1 ? (
        <TextLink as={HrefLink} to={nav.href({ ...NO_FILTERS, ...keepElsewhere(nav.query, elsewhere) })} arrow={false}>
          {t("list.clearAll")}
        </TextLink>
      ) : null}
    </div>
  );
}

/** The sort as a menu of radio rows. `compact`: the phone's «الترتيب»; otherwise «الترتيب: المقترَح». */
function SortMenu({ nav, sorts, sort, disabled, compact = false, trigger }: { nav: ListingNav; sorts: readonly ListingSort[]; sort: ListingSort; disabled: boolean; compact?: boolean; trigger?: (props: MenuTriggerProps) => ReactNode }) {
  const t = useT("catalog");
  const explain = sorts.includes("featured") ? (
    <span className="grid gap-0.5">
      <span>{t("sort.label")}</span>
      <span className="type-xs text-ink-2">
        {t("sort.featured")}: {t("sort.featuredNote")}
      </span>
    </span>
  ) : (
    t("sort.label")
  );
  return (
    <Menu
      label={t("sort.label")}
      title={explain}
      align="end"
      trigger={
        trigger ??
        ((props) => (
          <Key {...props} size="sm" icon="sort-ascending" iconEnd="caret-down" disabled={disabled} className="catalog-js-only">
            {compact ? (
              t("sort.label")
            ) : (
              <>
                <span className="lg:hidden">{t("sort.label")}</span>
                <span className="max-lg:hidden">
                  <span className="font-normal text-ink-2">{t("sort.trigger")}</span> {t(`sort.${sort}`)}
                </span>
              </>
            )}
          </Key>
        ))
      }
      items={sorts.map((value) => ({ id: value, kind: "radio" as const, label: t(`sort.${value}`), checked: value === sort, onSelect: () => nav.go({ sort: value === sorts[0] ? null : value }) }))}
    />
  );
}

/** Once the toolbar has scrolled away (below 1024): true. It comes back near the top. */
function useScrolledPast(target: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined") {
      setPast(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setPast(!entry.isIntersecting && entry.boundingClientRect.top < 0), { threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, enabled]);
  return past;
}

export function ListingView({ list, nav, scope, sorts, zero, picks, picksTitle, heading, elsewhere = [], inline, wished = null }: ListingViewProps) {
  const t = useT("catalog");
  const f = useFormat();
  const location = useLocation();
  const online = useOnline();
  const headingId = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const changedInSheet = useRef(false);
  const grid = useRef<HTMLUListElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useFlip(grid, list.items.map((card) => card.id).join("|"));

  const query: ListingQuery = nav.query;
  const sort = query.sort ?? list.sort;
  const activeCount = activeGroups(query).filter((group) => !elsewhere.includes(group)).length;
  const filtersLabel = activeCount > 0 ? t("list.filtersCount", { count: activeCount, n: f.number(activeCount) }) : t("list.filters");
  const resultsText = t("list.results", { count: list.total, n: f.number(list.total) });
  const wishedIds = new Set(wished ?? []);
  const hearts = wished !== null;

  const empty = list.total === 0;
  const pastToolbar = useScrolledPast(toolbar, !empty && !sheetOpen);

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
  const action = location.pathname;
  // the first card's picture is the list's largest paint (measured on the hubs too): eager and preloaded, one per page
  const firstPriority = list.offset === 0;

  // `chips`: short groups as chips in the sheet and the no-script panel; the 264px sidebar keeps rows
  const panel = (onChange: ((change: Partial<ListingQuery>) => void) | undefined, options: { className?: string; chips?: boolean } = {}) => (
    <FilterPanel query={query} facets={list.facets} scope={scope} elsewhere={elsewhere} onChange={onChange} sorts={sorts} sort={sort} hidden={nav.extra} action={action} disabled={!online} chips={options.chips} className={options.className} />
  );

  return (
    <section aria-labelledby={headingId} className="catalog-list">
      <VisuallyHidden as="h2" id={headingId}>
        {heading}
      </VisuallyHidden>
      <div className="catalog-list__layout">
        <aside className="catalog-side" aria-label={t("filter.title")}>
          {panel((change) => nav.go(change))}
        </aside>

        <div className="catalog-results">
          <div ref={toolbar} className="catalog-toolbar">
            <p className="catalog-toolbar__count" aria-live="polite">
              {nav.pending ? t("list.updating") : <span className="nums">{resultsText}</span>}
              {sort === "featured" && !empty ? <span className="catalog-toolbar__why"> · {t("sort.featuredNote")}</span> : null}
            </p>
            <div className="catalog-toolbar__keys">
              <Key size="sm" icon="sliders-horizontal" aria-haspopup="dialog" onClick={openSheet} disabled={!online} className="catalog-js-only lg:hidden">
                {filtersLabel}
              </Key>
              {sorts.length > 1 && !empty ? <SortMenu nav={nav} sorts={sorts} sort={sort} disabled={!online} /> : null}
            </div>
            {!online ? <p className="catalog-toolbar__note">{t("list.offline")}</p> : null}
          </div>

          {/* No script on a phone: the same filters and the sort in a plain GET form (from 1024 the sidebar is that form). */}
          <details className="catalog-nojs catalog-nojs-panel lg:hidden">
            <summary>{t("filter.nojsSummary")}</summary>
            {panel(undefined, { className: "pt-4", chips: true })}
          </details>

          <ActiveFilters filters={query} facets={list.facets} nav={nav} elsewhere={elsewhere} />

          {empty ? (
            <ZeroResults list={list} nav={nav} zero={zero} picks={picks} picksTitle={picksTitle} elsewhere={elsewhere} wished={wishedIds} hearts={hearts} />
          ) : (
            <>
              {pagingAlone ? (
                <p className="type-xs text-ink-2">
                  <span className="nums">{t("list.window", { from: f.number(list.offset + 1), to: f.number(shownTo), total: f.number(list.total) })}</span>{" "}
                  <TextLink as={HrefLink} to={nav.href({})} inline>
                    {t("list.backToStart")}
                  </TextLink>
                </p>
              ) : null}
              <ul ref={grid} role="list" aria-busy={nav.pending || undefined} className={cx("catalog-grid", nav.pending && "catalog-grid--busy")}>
                {list.items.map((card, index) => (
                  <Fragment key={card.id}>
                    <li data-flip={card.id} className="catalog-grid__item">
                      <ProductCard card={card} headingLevel={3} priority={firstPriority && index === 0} wishlist={hearts} wished={wishedIds.has(card.id)} />
                    </li>
                    {inline && !pagingAlone && index === INLINE_AFTER - 1 && list.items.length > INLINE_AFTER ? <li className="catalog-grid__break">{inline}</li> : null}
                  </Fragment>
                ))}
              </ul>
              <ShowMore shown={shownTo} total={list.total} href={moreHref} loading={loadingMore} products step={LISTING_PAGE_SIZE} />
            </>
          )}
        </div>
      </div>

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t("filter.title")}
        description={nav.pending ? t("list.updating") : resultsText}
        presentation="side"
        footer={
          <>
            {activeCount > 0 ? (
              <Key variant="ghost" onClick={() => changeFromSheet({ ...NO_FILTERS, ...keepElsewhere(query, elsewhere) })} className="flex-none!">
                {t("list.clearAll")}
              </Key>
            ) : null}
            <Key variant="primary" onClick={() => setSheetOpen(false)} disabled={list.total === 0 && !nav.pending}>
              {nav.pending ? t("filter.showPending") : t("filter.show", { count: list.total, n: f.number(list.total) })}
            </Key>
          </>
        }
      >
        {panel(changeFromSheet, { chips: true })}
      </Sheet>

      <CatalogDock
        pill={
          pastToolbar ? (
            <div className="catalog-pill" role="group" aria-label={t("list.controls")}>
              <button type="button" className="catalog-pill__key" aria-haspopup="dialog" onClick={openSheet} disabled={!online} data-press="soft">
                {filtersLabel}
              </button>
              {sorts.length > 1 ? (
                <SortMenu
                  nav={nav}
                  sorts={sorts}
                  sort={sort}
                  disabled={!online}
                  compact
                  trigger={(props) => (
                    <button {...props} type="button" className="catalog-pill__key" disabled={!online} data-press="soft">
                      {t("sort.label")}
                    </button>
                  )}
                />
              ) : null}
            </div>
          ) : null
        }
      />
    </section>
  );
}

