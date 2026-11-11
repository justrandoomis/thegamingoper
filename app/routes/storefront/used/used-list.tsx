/**
 * /used — the used marketplace (brief §5, DESIGN.md §8.3 list, §9.5 used card, §9.7 filters). Every card is one
 * inspected unit: its grade, its battery when measurable, its store warranty and — always — what its picture is
 * (a real photo of the unit, or "صورة توضيحية" for the demo units that only have the maker's photo of the model).
 *
 * URL state: platform, model, grade, storage, location (repeatable), min, max, warranty, sort, page — shareable and
 * kept by Back. Filters apply at once; the list dims while the next page of results loads (never a skeleton).
 * States: default · filtered · zero results (with the way out) · nothing listed at all · a page past the end ·
 * filters that failed to load (the list still shows) · offline (the shell's banner).
 */
import { useState } from "react";
import { useLocation, useNavigation, useNavigate } from "react-router";

import type { Route } from "./+types/used-list";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocalePath, useT } from "~/i18n/react";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { activeFilterCount, getUsedFacets, listUsedUnits, parseUsedFilters, USED_PAGE_SIZE } from "~/server/services/used.server";
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { ErrorState } from "~/ui/ErrorState";
import { Select } from "~/ui/Field";
import { GRADES, GradeTag, gradeKey } from "~/ui/GradeBadge";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { HrefLink, Pagination } from "~/ui/Pagination";
import { Sheet } from "~/ui/Sheet";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { ActiveFilters, FilterForm, PlatformRail, searchWith, USED_PATH } from "./components/UsedFilters";
import { useUsedT } from "./i18n";

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const filters = parseUsedFilters(new URL(request.url).searchParams);
  const [page, facets] = await Promise.all([
    listUsedUnits(db, ctx.locale, { ...filters, limit: USED_PAGE_SIZE }),
    // The filters are a side panel: if they fail, the list still shows and the panel says so with a retry.
    getUsedFacets(db, ctx.locale).catch((error: unknown) => {
      console.error("[used] filter options failed", error);
      return null;
    }),
  ]);
  const t = serverT(ctx.locale, "used");
  return {
    page,
    facets,
    filters,
    activeCount: activeFilterCount(filters),
    pageSize: USED_PAGE_SIZE,
    meta: { title: t("list.metaTitle"), description: t("list.metaDescription"), page: filters.page ?? 1 },
    i18n: messagesFor(ctx.locale, "used", "errors"),
  };
}

export const meta: Route.MetaFunction = (args) =>
  shellMeta(args, {
    title: args.loaderData?.meta.title,
    description: args.loaderData?.meta.description,
    canonicalSearch: args.loaderData && args.loaderData.meta.page > 1 ? `?page=${args.loaderData.meta.page}` : undefined,
  });

const SORTS = ["newest", "price_asc", "price_desc"] as const;

export default function UsedList({ loaderData }: Route.ComponentProps) {
  const { page, facets, filters, activeCount, pageSize } = loaderData;
  const t = useUsedT();
  const f = useFormat();
  const navigation = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const localePath = useLocalePath();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The list dims (never a skeleton) while the next results load — same page, other query.
  const busy = navigation.state === "loading" && navigation.location?.pathname === location.pathname;
  const current = filters.page ?? 1;
  const pageCount = Math.max(1, Math.ceil(page.total / pageSize));
  const countText = t("list.count", { count: page.total, n: f.number(page.total) });

  const setSort = (sort: string) =>
    navigate(`${localePath(USED_PATH)}${searchWith(location.search, (params) => (sort === "newest" ? params.delete("sort") : params.set("sort", sort)))}`, { replace: true, preventScrollReset: true });

  let results;
  if (page.total === 0 && activeCount === 0) {
    results = (
      <EmptyState
        layout="stack"
        headingLevel={3}
        title={t("list.empty")}
        text={t("list.emptyText")}
        action={
          <Key as={LocaleLink} to="/trade-in" iconEnd="arrow-right">
            {t("list.tradeIn.action")}
          </Key>
        }
      />
    );
  } else if (page.total === 0) {
    results = (
      <EmptyState
        layout="stack"
        icon="magnifying-glass"
        headingLevel={3}
        title={t("list.emptyFiltered")}
        text={t("list.emptyFilteredText")}
        action={
          <Key as={HrefLink} to={USED_PATH} preventScrollReset>
            {t("list.showAll")}
          </Key>
        }
      />
    );
  } else if (page.items.length === 0) {
    results = (
      <EmptyState
        layout="stack"
        headingLevel={3}
        title={t("list.pageEmpty")}
        action={
          <Key as={HrefLink} to={`${USED_PATH}${searchWith(location.search, () => {})}`}>
            {t("list.firstPage")}
          </Key>
        }
      />
    );
  } else {
    results = (
      <ul className={cx("grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-4 md:grid-cols-3 xl:grid-cols-4", busy && "opacity-60")} aria-busy={busy || undefined}>
        {page.items.map((unit, index) => (
          <li key={unit.id} className="flex min-w-0">
            <UsedUnitCard unit={unit} priority={index === 0 && current === 1} headingLevel={3} />
          </li>
        ))}
      </ul>
    );
  }

  const filtersPanel = facets ? (
    <FilterForm facets={facets} filters={filters} idPrefix="used-side" />
  ) : (
    <ErrorState title={t("list.facetsFailed")} retryHref={`${USED_PATH}${location.search}`} />
  );

  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-section pt-4 pb-12 lg:pt-8">
      <header className="grid gap-2">
        <h1 className="type-title text-ink">{t("list.title")}</h1>
        <p className="max-w-[62ch] type-body text-ink-2">{t("list.intro")}</p>
      </header>

      <TradeInRow />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[16.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <aside className="hidden lg:sticky lg:top-[calc(var(--shell-header-h)+var(--s-4))] lg:block lg:max-h-[calc(100dvh-var(--shell-header-h)-var(--s-8))] lg:overflow-y-auto lg:pe-1">
          {filtersPanel}
        </aside>

        <section aria-labelledby="used-results" className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
          <h2 id="used-results" className="sr-only">
            {t("list.results")}
          </h2>
          {facets ? (
            <div className="min-w-0 lg:hidden">
              <PlatformRail facets={facets} filters={filters} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="type-label text-ink-2" role="status">
              {busy ? t("list.updating") : countText}
            </p>
            <div className="flex items-end gap-2">
              {page.total > 1 ? (
                <Select
                  label={t("list.sortLabel")}
                  hideLabel
                  name="sort"
                  value={filters.sort ?? "newest"}
                  onChange={(event) => setSort(event.currentTarget.value)}
                  options={SORTS.map((sort) => ({ value: sort, label: t(`list.sort.${sort}`) }))}
                  className="min-w-[11rem]"
                />
              ) : null}
              <Key icon="sliders-horizontal" className="lg:hidden" aria-haspopup="dialog" onClick={() => setSheetOpen(true)} data-used-filters="">
                {activeCount > 0 ? t("list.filtersOn", { count: f.number(activeCount) }) : t("list.filters")}
              </Key>
            </div>
          </div>
          <ActiveFilters facets={facets} filters={filters} />
          {results}
          <Pagination
            page={current}
            pageCount={pageCount}
            href={(n) => `${USED_PATH}${searchWith(location.search, (params) => (n > 1 ? params.set("page", String(n)) : params.delete("page")))}`}
          />
        </section>
      </div>

      <HowWeInspect />

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t("filter.title")}
        description={countText}
        presentation="side"
        footer={
          <>
            <Key as={HrefLink} to={`${USED_PATH}${filters.sort ? `?sort=${filters.sort}` : ""}`} preventScrollReset>
              {t("filter.clear")}
            </Key>
            <Key variant="ink" onClick={() => setSheetOpen(false)}>
              {page.total > 0 ? t("filter.show", { count: page.total, n: f.number(page.total) }) : t("list.emptyFiltered")}
            </Key>
          </>
        }
      >
        {facets ? <FilterForm facets={facets} filters={filters} idPrefix="used-sheet" /> : <ErrorState title={t("list.facetsFailed")} retryHref={`${USED_PATH}${location.search}`} />}
      </Sheet>
    </div>
  );
}

/** The way from buying used to selling: one flat row link (DESIGN.md §8.2 "row link"). */
function TradeInRow() {
  const t = useUsedT();
  return (
    <Niche variant="panel" as={LocaleLink} to="/trade-in" className="flex min-h-[4.5rem] items-center gap-4 p-4" data-press="soft">
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-well text-ink" aria-hidden="true">
        <Icon name="recycle" size={22} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="type-strong text-ink">{t("list.tradeIn.title")}</span>
        <span className="type-caption text-ink-2">{t("list.tradeIn.text")}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 type-label font-semibold text-ink">
        <span className="hidden sm:inline">{t("list.tradeIn.action")}</span>
        <Icon name="arrow-right" size={18} />
      </span>
    </Niche>
  );
}

/** What "inspected" means here: three short facts and the grades in words (brief §5: explicit grades, checklist, warranty). */
function HowWeInspect() {
  const t = useUsedT();
  const shop = useT("ui-shop");
  const items = [
    { icon: "seal-check" as const, title: t("list.how.grade"), text: t("list.how.gradeText") },
    { icon: "clipboard-text" as const, title: t("list.how.inspect"), text: t("list.how.inspectText") },
    { icon: "shield-check" as const, title: t("list.how.warranty"), text: t("list.how.warrantyText") },
  ];
  return (
    <section aria-labelledby="used-how" className="grid gap-5 rounded-lg bg-paper p-5 sm:p-6">
      <h2 id="used-how" className="type-section text-ink">
        {t("list.how.title")}
      </h2>
      <ul className="grid gap-4 md:grid-cols-3">
        {items.map((item) => (
          <li key={item.title} className="flex items-start gap-3">
            <Icon name={item.icon} size={22} className="mt-0.5 shrink-0 text-ink" />
            <span className="grid gap-0.5">
              <span className="type-strong text-ink">{item.title}</span>
              <span className="type-caption text-ink-2">{item.text}</span>
            </span>
          </li>
        ))}
      </ul>
      <dl className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2 xl:grid-cols-4">
        {GRADES.map((grade) => (
          <div key={grade} className="grid justify-items-start gap-1">
            <dt>
              <GradeTag grade={grade} />
            </dt>
            <dd className="type-caption text-ink-2">{shop(`grade.hints.${gradeKey(grade)}`)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
