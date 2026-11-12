/**
 * /search?q= — search (Design System v2 §6.4). Typo-tolerant, synonym-aware (ar / en / ckb) and category-aware ("go
 * straight to" the platform, department or device hub the words name; results by department as a chip row), with the
 * same filters, sorts and «اعرض المزيد» as the hubs.
 *
 *   start (no query)   the field in the page (focused on wide screens), suggestion chips, the recent searches kept on
 *                      this device (consent-aware) with the small «إعدادات البحث» row, then every platform and
 *                      department to browse, then the devices area's shelves.
 *   results            the listing template with the query in the h1; a corrected spelling shows its results under
 *                      the corrected words and says what was typed.
 *   zero results       «لم نجد نتائج لـ «…»» with what to try, «هل تقصد» (the shorter queries that do find something),
 *                      the platform tiles and «وصل حديثاً» — no sort and no filters. (Filters that hide every match get
 *                      the hubs' recovery instead: the filter to remove.)
 *
 * Counted anonymously in `search_query_stats` (first page of a plain search; bots and queries that may hold personal
 * data are not counted).
 */
import { isbot } from "isbot";
import { useEffect } from "react";

import type { Route } from "./+types/search";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { RecommendationShelves } from "~/routes/storefront/devices/components/RecommendationShelves";
import { CONSENT_COOKIE, PLATFORMS_COOKIE, parsePlatformList } from "~/routes/storefront/home/personal";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { normalizeSearchText } from "~/server/db/search.server";
import { getNewArrivals } from "~/server/services/catalog/cards.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { MAX_QUERY_LENGTH, recordSearchQuery, searchProducts } from "~/server/services/search.server";
import { EmptyState } from "~/ui/EmptyState";
import { ShelfRail } from "~/ui/ShelfRail";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { ChipRow, KeepInView, TitleRow } from "./components/Hub";
import { CompareTray } from "./components/CompareTray";
import { ListingView } from "./components/ListingView";
import { BrowseStore, DidYouMean, SearchJumps, SearchStart } from "./components/SearchParts";
import { useRecentSearches } from "./components/recent-searches";
import { useListingNav, useOfflineHold } from "./components/use-listing-nav";
import { SEARCH_SORTS, activeGroups, filtersOf, readListingQuery } from "./listing-model";
import { arrivalsShelf, filterOrderOf, listOf, storeBrowse, wishedOf, withCursorFallback } from "./list.server";
import "./catalog.css";

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const t = serverT(ctx.locale, "catalog");
  const i18n = messagesFor(ctx.locale, "catalog");
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const who = { cookie: ctx.cookie, customerId: session?.customer.id ?? null };
  if (!normalizeSearchText(q)) {
    // Nothing searched yet: the devices area's shelves for "search" — the shopper's own (with consent), else the
    // store's picks for their platforms, each saying which it is. Streamed, never awaited.
    const consent = ctx.cookie(CONSENT_COOKIE) === "1";
    const platformSlugs = consent ? parsePlatformList(ctx.cookie(PLATFORMS_COOKIE)) : [];
    const recommendations = recommendationsFor(db, who, { locale: ctx.locale, context: "search", platformSlugs, now: ctx.now }, 8);
    const browse = await storeBrowse(db, ctx.locale, ctx.now);
    return { q: "", result: null, browse, arrivals: [], wished: null, filterOrder: null, recommendations, meta: { title: t("meta.searchStart"), description: t("meta.search") }, i18n };
  }

  const query = readListingQuery(url.searchParams, SEARCH_SORTS);
  // the listing filters in the order staff gave every listing (content module 17.03; null: the page's own) — read beside
  // the search, not after it (filterOrderOf never rejects)
  const filterOrderRead = filterOrderOf(db, null);
  const result = await withCursorFallback(url, query.cursor !== null, () =>
    searchProducts(db, ctx.locale, q, { filters: filtersOf(query), sort: query.sort, cursor: query.cursor, cumulative: true, now: ctx.now }),
  );

  // anonymous statistics: the first page of a plain search, never a bot (filters, sorts and "show more" are not new searches)
  if (!query.cursor && query.sort === null && activeGroups(query).length === 0 && !isbot(ctx.userAgent)) {
    try {
      await recordSearchQuery(db, { locale: ctx.locale, q, total: result.total, now: ctx.now });
    } catch (error) {
      console.error("[catalog] search statistics not recorded", error);
    }
  }

  const noMatch = result.total === 0 && result.zeroResultHelp?.reason === "no_match";
  // both shelves of picks are titled «وصل حديثاً» (they are the newest arrivals in stock): no card repeats «جديد»
  const help = result.zeroResultHelp ? { ...result.zeroResultHelp, picks: arrivalsShelf(result.zeroResultHelp.picks) } : result.zeroResultHelp;
  // nothing matched the words: a shelf's worth of arrivals (the service's three picks fill a third of a desktop row)
  const arrivals = noMatch ? arrivalsShelf(await getNewArrivals(db, ctx.locale, { limit: 8, now: ctx.now })) : [];
  const shown = [...result.items, ...(help?.picks ?? []), ...arrivals].map((card) => card.id);
  return {
    q,
    result: { ...listOf(result), zeroResultHelp: help },
    // the zero-result page offers the platforms (with the hubs' counts) and what arrived lately
    browse: noMatch ? await storeBrowse(db, ctx.locale, ctx.now) : null,
    arrivals,
    wished: await wishedOf(db, ctx, who.customerId, shown),
    filterOrder: await filterOrderRead,
    // below real results only: the shopper's own shelf, with consent (zero results already offer picks of their own)
    recommendations: result.total > 0 ? recommendationsFor(db, who, { locale: ctx.locale, context: "search", personalOnly: true, now: ctx.now }, 8) : null,
    meta: { title: t("meta.searchTitle", { q }), description: t("meta.search") },
    i18n,
  };
}

// result pages are never indexed (thin, endless); the start page follows the store's setting
export const meta: Route.MetaFunction = (args) =>
  shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description, noindex: Boolean(args.loaderData?.q) });

export default function SearchPage({ loaderData }: Route.ComponentProps) {
  const { q, result, browse, arrivals, wished } = loaderData;
  const t = useT("catalog");
  const nav = useListingNav({ sorts: SEARCH_SORTS, keep: ["q"] });
  const hold = useOfflineHold();
  const recent = useRecentSearches();
  const remember = recent.add;
  // keep the search on this device (when allowed); `remember` is a new function each render, the search is what counts
  useEffect(() => {
    if (q) remember(q);
  }, [q, recent.enabled]);

  if (!result) {
    return (
      <div className="page catalog-page" onClickCapture={hold}>
        <h1 className="type-h1 text-ink">{t("search.title")}</h1>
        <SearchStart browse={browse} />
        <RecommendationShelves result={loaderData.recommendations} source="search" />
        <CompareTray />
      </div>
    );
  }

  const help = result.zeroResultHelp;
  if (result.total === 0 && help?.reason !== "filters") {
    // nothing matches the words: what to try, the shorter queries, the platforms, what arrived lately — no sort, no filters
    return (
      <div className="page catalog-page" onClickCapture={hold}>
        <VisuallyHidden as="h1">{t("search.resultsTitle", { q })}</VisuallyHidden>
        <div className="grid justify-items-center gap-4">
          <EmptyState layout="stack" icon="magnifying-glass" title={<bdi>{t("search.zeroTitle", { q })}</bdi>} text={t("search.zeroText")} />
          <DidYouMean partial={help?.partial ?? []} />
        </div>
        <BrowseStore browse={browse} className="catalog-after" />
        {arrivals.length >= 3 ? (
          <KeepInView className="catalog-after">
            <ShelfRail shelf={{ key: "arrivals", title: t("search.newTitle"), reason: t("search.newReason"), items: arrivals }} />
          </KeepInView>
        ) : null}
        <CompareTray />
      </div>
    );
  }

  const zero = { title: t("zero.title"), text: t("zero.text") };
  const chips = result.facets.categories.length > 1 || nav.query.category !== null;
  const shownQuery = result.correctedQuery ?? q;

  return (
    <div className="page catalog-page" onClickCapture={hold}>
      <TitleRow title={<bdi>{t("search.resultsTitle", { q: shownQuery })}</bdi>}>
        {result.correctedQuery ? (
          <p className="type-sm text-ink-2" role="status">
            <bdi>{t("search.typed", { q })}</bdi>
          </p>
        ) : null}
        <SearchJumps jumps={result.suggestions} />
      </TitleRow>
      {chips ? (
        <ChipRow
          label={t("search.inCategory")}
          options={result.facets.categories.map((option) => ({ value: option.value, label: option.label, count: option.count }))}
          selected={nav.query.category}
          allCount={result.facets.without.category}
          hrefFor={(value) => nav.href({ category: value })}
        />
      ) : null}
      <ListingView
        list={result}
        nav={nav}
        scope="search"
        sorts={SEARCH_SORTS}
        heading={t("search.resultsHeading")}
        zero={zero}
        picks={help?.picks ?? []}
        picksTitle={t("zero.picksSearch")}
        elsewhere={chips ? ["category"] : []}
        wished={wished}
        filterOrder={loaderData.filterOrder}
      />
      <RecommendationShelves result={loaderData.recommendations} source="search" />
    </div>
  );
}
