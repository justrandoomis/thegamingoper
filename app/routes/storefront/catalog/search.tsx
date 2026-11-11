/**
 * /search?q= — search results (brief §3.5): typo-tolerant, synonym-aware (ar / en / ckb), category-aware ("go
 * straight to" the platform, department or device hub the words name; results by department as a chip rail), with
 * the same filters, sorts and "show more" as the hubs, and zero-result recovery (the corrected spelling, the shorter
 * query, the filter to remove, three new arrivals). Without a query: recent searches (this device only,
 * consent-aware) and everything to browse. Counted anonymously in `search_query_stats` (first page of a plain
 * search; bots and queries that may hold personal data are not counted).
 */
import { isbot } from "isbot";
import { useEffect } from "react";

import type { Route } from "./+types/search";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { normalizeSearchText } from "~/server/db/search.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { MAX_QUERY_LENGTH, recordSearchQuery, searchProducts } from "~/server/services/search.server";
import { RecommendationShelves } from "~/routes/storefront/devices/components/RecommendationShelves";
import { CONSENT_COOKIE, PLATFORMS_COOKIE, parsePlatformList } from "~/routes/storefront/home/personal";
import { ChipRail } from "./components/Hub";
import { CompareTray } from "./components/CompareTray";
import { ListingView } from "./components/ListingView";
import { PartialQueries, SearchJumps, SearchStart } from "./components/SearchParts";
import { useRecentSearches } from "./components/recent-searches";
import { useListingNav } from "./components/use-listing-nav";
import { SEARCH_SORTS, activeGroups, filtersOf, readListingQuery } from "./listing-model";
import { listOf, withCursorFallback } from "./list.server";
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
    return { q: "", result: null, recommendations, meta: { title: t("meta.searchStart"), description: t("meta.search") }, i18n };
  }

  const query = readListingQuery(url.searchParams, SEARCH_SORTS);
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

  return {
    q,
    result: { ...listOf(result) },
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
  const { q, result } = loaderData;
  const t = useT("catalog");
  const nav = useListingNav({ sorts: SEARCH_SORTS, keep: ["q"] });
  const recent = useRecentSearches();
  const remember = recent.add;
  // keep the search on this device (when allowed); `remember` is a new function each render, the search is what counts
  useEffect(() => {
    if (q) remember(q);
  }, [q, recent.enabled]);

  if (!result) {
    return (
      <div className="page grid grid-cols-[minmax(0,1fr)] gap-6 pb-12 pt-5">
        <h1 className="type-title text-ink">{t("search.title")}</h1>
        <SearchStart />
        <RecommendationShelves result={loaderData.recommendations} source="search" className="pt-4" />
      </div>
    );
  }

  const help = result.zeroResultHelp;
  const zero =
    help?.reason === "filters"
      ? { title: t("zero.title"), text: t("zero.text") }
      : { title: t("search.zeroTitle", { q }), text: t("search.zeroText"), extra: <PartialQueries partial={help?.partial ?? []} /> };

  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-5 pb-12 pt-5">
      <header className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <h1 className="type-title text-ink">
          <bdi>{t("search.resultsTitle", { q })}</bdi>
        </h1>
        {result.correctedQuery ? (
          <p className="type-body text-ink-2" role="status">
            <bdi>{t("search.corrected", { q, corrected: result.correctedQuery })}</bdi>
          </p>
        ) : null}
        <SearchJumps jumps={result.suggestions} />
      </header>
      {result.facets.categories.length > 1 || nav.query.category ? (
        <ChipRail
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
      />
      <RecommendationShelves result={loaderData.recommendations} source="search" className="pt-4" />
      <CompareTray />
    </div>
  );
}
