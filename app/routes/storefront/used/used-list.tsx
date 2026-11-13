/**
 * /used — «المستعمل والمفحوص», the used marketplace (Design System v2 §6.8, §4.12; listing behaviour §6.3). Every row is
 * one inspected unit: its grade, its battery when measurable, its store warranty and — always — what its picture is
 * (the unit's own photo once staff published one, else «صورة توضيحية»). No add to cart from the list: the unit's page
 * shows the inspection first.
 *
 * Layout: a title row (h1 + how many units + one line); phones: the platform chips, a toolbar (count · «الفلاتر» ·
 * «الترتيب») with the filter and sort sheets, and — once the toolbar has scrolled away — the same two keys as a pill
 * above the tab bar; from 1024 a 264px sticky sidebar of checkbox rows and the sort select; the results as used rows
 * (two columns of rows from 1024, v2 §4.12); then the trade-in entry and how a used device is prepared.
 *
 * URL state: platform, model, grade, storage, location (repeatable), min, max, warranty, sort, page (how many pages of
 * 24 are shown — «اعرض المزيد» adds the next one) — shareable and kept by Back. Filters apply at once; the list dims
 * (aria-busy) while the next results load and the new rows bubble in (never a skeleton).
 * States: default · filtered · zero results (with the way out) · nothing listed at all · filters that failed to load
 * (the list still shows) · offline (the shell's banner; the filters and the sort are disabled, with a line saying so).
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/used-list";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { Bubble, BubbleGroup } from "~/motion";
import { canonicalSearch } from "~/routes/storefront/shell/chrome";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { activeFilterCount, getUsedFacets, listUsedUnits, MAX_USED_PAGE_SIZE, parseUsedFilters, USED_PAGE_SIZE } from "~/server/services/used.server";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { EntryCard } from "~/ui/EntryCard";
import { ErrorState } from "~/ui/ErrorState";
import { FactList } from "~/ui/FactList";
import { GRADES, GradeTag, gradeKey } from "~/ui/GradeBadge";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { HrefLink, ShowMore } from "~/ui/Pagination";
import { revealProps } from "~/ui/reveal";
import { Sheet } from "~/ui/Sheet";
import { TextLink } from "~/ui/TextLink";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { ActiveFilters, clearedHref, FilterForm, FilterSheetShow, PlatformRail, searchWith, SortList, SortSelect, USED_PATH } from "./components/UsedFilters";
import { useUsedT } from "./i18n";
import "./used.css";

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const filters = parseUsedFilters(new URL(request.url).searchParams);
  // «اعرض المزيد» adds a page of 24; at most this many pages are shown at once.
  const maxPages = Math.max(1, Math.floor(MAX_USED_PAGE_SIZE / USED_PAGE_SIZE));
  const pages = Math.min(maxPages, filters.page ?? 1);
  const [list, facets] = await Promise.all([
    // Pages accumulate: page 3 is the first 72 units, so «اعرض المزيد» adds to the list instead of replacing it.
    listUsedUnits(db, ctx.locale, { ...filters, page: 1, limit: pages * USED_PAGE_SIZE }),
    // The filters are a side panel: if they fail, the list still shows and the panel says so with a retry.
    getUsedFacets(db, ctx.locale).catch((error: unknown) => {
      console.error("[used] filter options failed", error);
      return null;
    }),
  ]);
  const t = serverT(ctx.locale, "used");
  return {
    list,
    facets,
    filters,
    pages,
    maxPages,
    pageSize: USED_PAGE_SIZE,
    activeCount: activeFilterCount(filters),
    meta: { title: t("list.metaTitle"), description: t("list.metaDescription") },
    i18n: messagesFor(ctx.locale, "used", "errors"),
  };
}

// Every filtered or longer view is the same list: the canonical page is /used (no query kept).
export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description });

export default function UsedList({ loaderData }: Route.ComponentProps) {
  const { list, facets, filters, pages, maxPages, pageSize, activeCount } = loaderData;
  const t = useUsedT();
  const f = useFormat();
  const navigation = useNavigation();
  const location = useLocation();
  const [sheet, setSheet] = useState<"filters" | "sort" | null>(null);
  // Offline: the filters and the sort wait for the connection, and a line under the toolbar says so (v2 §6.17).
  const online = useOnline();

  // The list dims (never a skeleton) while the next results of this same page load.
  const busy = navigation.state === "loading" && navigation.location?.pathname === location.pathname;
  // Rows that arrive after the page is on screen (other filters, «اعرض المزيد») bubble in; the first rows are just there.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const arrived = mounted.current;
  const search = canonicalSearch(location.search);
  const groupKey = searchWith(search, () => {});

  const listed = facets?.total ?? (activeCount === 0 ? list.total : null);
  const nothingListed = list.total === 0 && activeCount === 0;

  // Below 1024, once the toolbar has scrolled away, «الفلاتر | الترتيب» floats above the tab bar (v2 §6.3); it goes
  // when the toolbar is back on screen. (The header covers the top 64px: a toolbar under it counts as gone.)
  const toolbar = useRef<HTMLDivElement>(null);
  const [pastToolbar, setPastToolbar] = useState(false);
  useEffect(() => {
    const element = toolbar.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    // gone = out of the (header-shrunk) viewport ABOVE it; a toolbar still below the fold does not count
    const observer = new IntersectionObserver(([entry]) => setPastToolbar(!entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0) + 1), { rootMargin: "-64px 0px 0px 0px" });
    observer.observe(element);
    return () => {
      observer.disconnect();
      setPastToolbar(false);
    };
  }, [nothingListed]);
  const resultsText = t("list.count", { count: list.total, n: f.number(list.total) });
  const moreHref = list.items.length < list.total && pages < maxPages ?`?${new URLSearchParams([...new URLSearchParams(search)].filter(([name]) => name !== "page").concat([["page", String(pages + 1)]])).toString()}` : null;

  let results;
  if (nothingListed) {
    results = (
      <EmptyState
        layout="stack"
        title={t("list.empty")}
        text={t("list.emptyText")}
        action={
          <Key as={LocaleLink} to="/trade-in" variant="primary" iconEnd="arrow-right">
            {t("list.tradeIn.title")}
          </Key>
        }
        recovery={
          <Key as={LocaleLink} to="/" variant="ghost">
            {t("list.shopNew")}
          </Key>
        }
      />
    );
  } else if (list.total === 0) {
    // v2 §4.23: one primary (the way out of these filters) and one recovery link
    results = (
      <EmptyState
        layout="stack"
        icon="magnifying-glass"
        headingLevel={3}
        title={t("list.emptyFiltered")}
        text={t("list.emptyFilteredText")}
        action={
          // lint-design: allow primary-count — this empty state and the "nothing listed" one above are never on screen together
          <Key as={HrefLink} to={clearedHref(filters)} variant="primary" disabled={!online} preventScrollReset>
            {t("list.clearFilters")}
          </Key>
        }
        recovery={
          <TextLink as={LocaleLink} to="/">
            {t("list.shopNew")}
          </TextLink>
        }
      />
    );
  } else {
    results = (
      <BubbleGroup as="ul" key={groupKey} className={cx("used-rows", busy && "opacity-60")} aria-busy={busy || undefined} aria-labelledby="used-results">
        {list.items.map((unit, index) => (
          <Bubble as="li" key={unit.id} always={arrived} className="min-w-0">
            <UsedUnitCard unit={unit} layout="row" priority={index === 0} headingLevel={3} className="used-row" />
          </Bubble>
        ))}
      </BubbleGroup>
    );
  }

  const filtersFailed = <ErrorState title={t("list.facetsFailed")} retryHref={`${USED_PATH}${search}`} />;

  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-section pt-4 pb-6 lg:pt-6">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:gap-6">
        <Breadcrumbs items={[{ label: t("unit.crumbs.home"), href: "/" }, { label: t("list.title") }]} />
        <header className="grid gap-1">
          <h1 className="type-h1 text-ink">{t("list.title")}</h1>
          <p className="type-sm text-ink-2">
            {/* the store-wide count only while no filter is on: the toolbar says how many match the filters (QA
                2026-11-12: «6 أجهزة» above «لا أجهزة» on one screen) */}
            {listed !== null && listed > 0 && activeCount === 0 ? <span className="font-semibold text-ink">{t("list.count", { count: listed, n: f.number(listed) })} · </span> : null}
            {t("list.lead")}
          </p>
        </header>

        {nothingListed ? (
          results
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[16.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
            <aside className="used-sidebar hidden lg:block" aria-label={t("filter.title")}>
              {facets ? <FilterForm layout="sidebar" facets={facets} filters={filters} idPrefix="used-side" /> : filtersFailed}
            </aside>

            <section aria-labelledby="used-results" className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
              <h2 id="used-results" className="sr-only">
                {t("list.results")}
              </h2>
              {facets ? <PlatformRail facets={facets} filters={filters} className="lg:hidden" /> : null}
              <div ref={toolbar} className="used-toolbar">
                <p className="type-sm-strong text-ink" role="status">
                  {busy ? t("list.updating") : resultsText}
                </p>
                <div className="flex items-center gap-2">
                  <Key size="sm" icon="sliders-horizontal" className="lg:hidden" aria-haspopup="dialog" onClick={() => setSheet("filters")} disabled={!online} data-used-filters="">
                    {activeCount > 0 ? t("list.filtersOn", { count: f.number(activeCount) }) : t("list.filters")}
                  </Key>
                  {list.total > 1 ? (
                    <>
                      <Key size="sm" icon="sort-ascending" className="lg:hidden" aria-haspopup="dialog" onClick={() => setSheet("sort")} disabled={!online}>
                        {t("list.sortShort")}
                      </Key>
                      <SortSelect filters={filters} className="max-lg:hidden" />
                    </>
                  ) : null}
                </div>
              </div>
              {!online ? (
                <p className="type-sm text-ink-2" role="status">
                  {t("list.offline")}
                </p>
              ) : null}
              <ActiveFilters facets={facets} filters={filters} />
              {results}
              {list.total > pageSize ? (
                <ShowMore
                  shown={list.items.length}
                  total={list.total}
                  href={moreHref}
                  loading={busy}
                  label={t("list.more", { count: Math.min(pageSize, list.total - list.items.length), n: f.number(Math.min(pageSize, list.total - list.items.length)) })}
                />
              ) : null}
            </section>
          </div>
        )}
      </div>

      {nothingListed ? null : <TradeInEntry art={list.items.find((item) => item.image.artKey)?.image.artKey ?? null} />}
      <HowWeInspect />

      {/* «الفلاتر | الترتيب» above the tab bar once the toolbar has scrolled away (below 1024; the sidebar is there from 1024). */}
      {!nothingListed && pastToolbar ? (
        <div className="used-dock lg:hidden" data-pill="">
          <div className="used-pill" role="group" aria-label={t("list.controls")}>
            <button type="button" className="used-pill__key" aria-haspopup="dialog" onClick={() => setSheet("filters")} disabled={!online} data-press="soft">
              {activeCount > 0 ? t("list.filtersOn", { count: f.number(activeCount) }) : t("list.filters")}
            </button>
            {list.total > 1 ? (
              <button type="button" className="used-pill__key" aria-haspopup="dialog" onClick={() => setSheet("sort")} disabled={!online} data-press="soft">
                {t("list.sortShort")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <Sheet
        open={sheet === "filters"}
        onClose={() => setSheet(null)}
        title={t("filter.title")}
        description={resultsText}
        footer={
          <>
            <Key as={HrefLink} to={clearedHref(filters)} variant="ghost" preventScrollReset>
              {t("filter.clear")}
            </Key>
            <FilterSheetShow total={list.total} onShow={() => setSheet(null)} />
          </>
        }
      >
        {facets ? <FilterForm layout="sheet" facets={facets} filters={filters} idPrefix="used-sheet" /> : filtersFailed}
      </Sheet>
      <Sheet open={sheet === "sort"} onClose={() => setSheet(null)} title={t("list.sortLabel")} presentation="sheet">
        <SortList filters={filters} onPick={() => setSheet(null)} />
      </Sheet>
    </div>
  );
}

/** The way from buying used to selling: the trade-in entry (v2 §4.25). */
function TradeInEntry({ art }: { art: string | null }) {
  const t = useUsedT();
  return (
    <section aria-label={t("list.tradeIn.title")} {...revealProps()}>
      <EntryCard to="/trade-in" headingLevel={2} title={t("list.tradeIn.title")} text={t("list.tradeIn.text")} cta={t("list.tradeIn.action")} art={art ?? "mascot"} />
    </section>
  );
}

/** What "inspected" means here: three facts and the four grades in words (brief §5: explicit grades, checklist, warranty). */
function HowWeInspect() {
  const t = useUsedT();
  const shop = useT("ui-shop");
  return (
    <section aria-labelledby="used-how" className="panel grid gap-5 p-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10 lg:p-8" {...revealProps()}>
      <div className="grid content-start gap-3">
        <h2 id="used-how" className="type-h2 text-ink">
          {t("list.how.title")}
        </h2>
        <FactList
          plain
          facts={[
            { icon: "seal-check", title: t("list.how.grade"), text: t("list.how.gradeText") },
            { icon: "clipboard-text", title: t("list.how.inspect"), text: t("list.how.inspectText") },
            { icon: "shield-check", title: t("list.how.warranty"), text: t("list.how.warrantyText") },
          ]}
        />
      </div>
      <div className="grid content-start gap-3 border-t border-line pt-5 lg:border-t-0 lg:border-s lg:ps-10 lg:pt-0">
        <h3 className="type-h3 text-ink">{t("list.how.grades")}</h3>
        <dl className="grid gap-4 sm:grid-cols-2">
          {GRADES.map((grade) => (
            <div key={grade} className="grid justify-items-start gap-1.5">
              <dt>
                <GradeTag grade={grade} />
              </dt>
              <dd className="type-sm text-ink-2">{shop(`grade.hints.${gradeKey(grade)}`)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
