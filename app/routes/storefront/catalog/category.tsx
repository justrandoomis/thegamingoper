/**
 * /c/:category — a category hub (Design System v2 §6.3; v2.1 «Clay & Glass»): no colour band — the glass head (the
 * department's kind icon on its clay tile, the h1, the count and the delivery line, the department's photo from 768,
 * a one-platform department in its platform's light), then one chip row with icons (the platforms with their device
 * glyphs in their colours; for a department of one platform its sub-departments with their kind icons, else the
 * devices its products fit), the product list with filters, sorts and «اعرض المزيد», then the row of soft device tiles
 * its products fit. An empty department says so on the soft card and shows what arrived lately.
 * The used-devices category belongs to the used marketplace: /c/<used> redirects to /used.
 *
 * The content module (admin 17) reaches the page: the category's banners at the top (`category_top`, getStoreBanners),
 * the filter groups in the order staff gave this category (else the default arrangement, else the page's own), the
 * title, description and noindex staff wrote for search engines (`categories.seo`), and — for a category that does
 * not exist (any more) — a redirect staff set for its address before the 404.
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/category";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import { StoreBanners } from "~/routes/storefront/content/components/StoreBanners";
import { redirectIfMoved } from "~/routes/storefront/content/redirect.server";
import { RecommendationShelves } from "~/routes/storefront/devices/components/RecommendationShelves";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getNewArrivals } from "~/server/services/catalog/cards.server";
import { listProducts, scopePicks } from "~/server/services/catalog/listing.server";
import { getStoreBanners, type ShopBanner } from "~/server/services/content.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { isPlatform } from "~/ui/PlatformLed";
import { ShelfRail } from "~/ui/ShelfRail";
import { ChipRow, DeviceRow, KeepInView, TitleRow, kindIconOf, useHubLead, useKindIcon, type RailOption } from "./components/Hub";
import { ListingView } from "./components/ListingView";
import { useListingNav, useOfflineHold } from "./components/use-listing-nav";
import { LISTING_SORTS, filtersOf, readListingQuery, type FilterGroup } from "./listing-model";
import { PAGE_SLUG, arrivalsShelf, categoryCmsOf, filterOrderOf, listOf, wishedOf, withCursorFallback } from "./list.server";
import "./catalog.css";

export async function loader({ params, request, context, url: pageUrl }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const slug = params.category;
  const db = getDb();
  if (!PAGE_SLUG.test(slug)) {
    await redirectIfMoved(db, pageUrl, ctx);
    throw data({ error: "not_found" }, { status: 404 });
  }
  const url = new URL(request.url);
  const query = readListingQuery(url.searchParams);
  // the list, and the content module's side of the page beside it (it needs only the slug): the category's id — for its
  // banners and its filter arrangement — and its SEO words
  const [result, cms] = await Promise.all([
    withCursorFallback(url, query.cursor !== null, () =>
      listProducts(db, ctx.locale, { scope: { kind: "category", slug }, filters: filtersOf(query), sort: query.sort, cursor: query.cursor, cumulative: true, now: ctx.now }),
    ),
    categoryCmsOf(db, slug, ctx.locale),
  ]);
  if (!result || !result.hub.category) {
    // a category whose address staff redirected in the content module goes there (same-site only), else 404
    await redirectIfMoved(db, pageUrl, ctx);
    throw data({ error: "not_found" }, { status: 404 });
  }
  if (result.hub.category.kind === "used") throw redirect(localePath("/used", ctx.locale));
  // everything else the page reads, in one round: the staff's filter order and banners, the picks of a list filtered to
  // nothing, the arrivals of an empty department (so the page still leads somewhere: the shelf says «وصل حديثاً», no
  // «جديد») and the shopper (for the hearts)
  const [filterOrder, banners, picks, arrivals, session] = await Promise.all([
    filterOrderOf(db, cms?.id ?? null),
    cms
      ? getStoreBanners(db, ctx.locale, "category_top", { now: ctx.now, categoryId: cms.id, origins: [ctx.origin] }).catch((error: unknown): ShopBanner[] => {
          console.error("[catalog] banners not read", error);
          return [];
        })
      : Promise.resolve([] as ShopBanner[]),
    result.total === 0 && result.scopeTotal > 0 ? scopePicks(db, ctx.locale, { kind: "category", slug }, { limit: 4, now: ctx.now }) : Promise.resolve([]),
    result.scopeTotal === 0 ? getNewArrivals(db, ctx.locale, { limit: 8, now: ctx.now }).then(arrivalsShelf) : Promise.resolve([]),
    getCustomer(ctx, db),
  ]);
  const t = serverT(ctx.locale, "catalog");
  const category = result.hub.category;
  const customerId = session?.customer.id ?? null;
  return {
    list: listOf(result),
    hub: result.hub,
    picks,
    arrivals,
    wished: await wishedOf(db, ctx, customerId, [...result.items, ...picks, ...arrivals].map((card) => card.id)),
    // the devices area's shelf from the shopper's own signals (context "search") — consent only, streamed
    recommendations: recommendationsFor(
      db,
      { cookie: ctx.cookie, customerId },
      { locale: ctx.locale, context: "search", platformSlugs: category.platform ? [category.platform] : undefined, personalOnly: true, now: ctx.now },
      8,
    ),
    filterOrder,
    banners,
    // what staff wrote for search engines wins over the page's own words (content module 17.04, categories.seo)
    meta: {
      title: cms?.seo.title ?? category.name,
      description: cms?.seo.description ?? t("meta.category", { name: category.name, n: String(result.scopeTotal) }),
      noindex: cms?.seo.noindex ?? false,
    },
    i18n: messagesFor(ctx.locale, "catalog"),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description, noindex: args.loaderData?.meta.noindex });

export default function CategoryPage({ loaderData }: Route.ComponentProps) {
  const { list, hub, picks, arrivals, wished, banners, filterOrder } = loaderData;
  const t = useT("catalog");
  const ui = useT("ui");
  const f = useFormat();
  const nav = useListingNav({ sorts: LISTING_SORTS });
  const hold = useOfflineHold();
  const lead = useHubLead();
  const kindIcon = useKindIcon();
  const category = hub.category!;

  // the chip row: the platforms (their device glyphs in their colours) first; for a department of one platform its
  // sub-departments (kind icons), else its devices
  let rail: { label: string; group: FilterGroup; options: RailOption[]; selected: string | null; allCount: number; hrefFor: (value: string | null) => string } | null = null;
  if (list.facets.platforms.length >= 2 || nav.query.platforms.length > 0) {
    rail = {
      label: t("hub.platforms"),
      group: "platforms",
      options: list.facets.platforms.map((option) => ({ value: option.value, label: isPlatform(option.value) ? ui(`platform.${option.value}`) : option.label, count: option.count, platform: isPlatform(option.value) ? option.value : undefined })),
      selected: nav.query.platforms.length === 1 ? nav.query.platforms[0] : null,
      allCount: list.facets.without.platforms,
      hrefFor: (value) => nav.href({ platforms: value ? [value] : [] }),
    };
  } else if (list.facets.categories.length >= 2 || nav.query.category) {
    rail = {
      label: t("hub.subcategories"),
      group: "category",
      options: list.facets.categories.map((option) => ({ value: option.value, label: option.label, count: option.count, icon: kindIcon(option.value) })),
      selected: nav.query.category,
      allCount: list.facets.without.category,
      hrefFor: (value) => nav.href({ category: value }),
    };
  } else if (list.facets.devices.length >= 2 || nav.query.device) {
    rail = {
      label: t("hub.devicesRail"),
      group: "device",
      options: list.facets.devices.map((option) => ({ value: option.value, label: option.label, count: option.count, platform: isPlatform(option.platform) ? option.platform : undefined })),
      selected: nav.query.device,
      allCount: list.facets.without.device,
      hrefFor: (value) => nav.href({ device: value }),
    };
  }

  const crumbs = [{ label: t("hub.home"), href: "/" }, ...category.trail.map((crumb) => ({ label: crumb.name, href: `/c/${crumb.slug}` })), { label: category.name }];
  const count = t("hub.products", { count: list.scopeTotal, n: f.number(list.scopeTotal) });

  return (
    <div className="page catalog-page" onClickCapture={hold}>
      <TitleRow
        crumbs={crumbs}
        title={category.name}
        count={list.scopeTotal > 0 ? count : null}
        lead={lead}
        icon={kindIconOf(category.slug, category.kind)}
        art={category.artKey}
        gel={isPlatform(category.platform) ? category.platform : null}
      />
      <StoreBanners banners={banners} label={t("banners.label")} ctaFallback={t("banners.open")} className="mb-6" />
      {list.scopeTotal === 0 ? (
        <>
          {/* v2.1: on the kit's soft card, the department's kind icon large on its disc */}
          <EmptyState
            layout="stack"
            panel
            art={<Icon name={kindIconOf(category.slug, category.kind)} size={48} className="text-red-ink" />}
            title={t("hub.emptyTitle")}
            text={t("hub.emptyText")}
            action={
              <Key variant="primary" as={LocaleLink} to="/search">
                {t("hub.emptyAction")}
              </Key>
            }
          />
          {/* the page's width, not the empty state's reading column: whole cards from 1024 */}
          {arrivals.length >= 3 ? (
            <KeepInView className="catalog-after" reveal>
              <ShelfRail shelf={{ key: "arrivals", title: t("search.newTitle"), reason: t("search.newReason"), items: arrivals }} />
            </KeepInView>
          ) : null}
        </>
      ) : (
        <>
          {rail ? <ChipRow label={rail.label} options={rail.options} selected={rail.selected} allCount={rail.allCount} hrefFor={rail.hrefFor} /> : null}
          <ListingView
            list={list}
            nav={nav}
            scope="category"
            sorts={LISTING_SORTS}
            heading={t("hub.resultsHeading", { name: category.name })}
            zero={{ title: t("zero.title"), text: t("zero.text") }}
            picks={picks}
            picksTitle={t("zero.picksCategory")}
            elsewhere={rail ? [rail.group] : []}
            wished={wished}
            filterOrder={filterOrder}
          />
          {/* the device hubs its products fit: the same soft tiles as a platform hub's row, full names (no platform beside them) */}
          <DeviceRow devices={hub.devices} title={t("hub.devicesByCategory")} note={t("hub.devicesByCategoryNote")} id="catalog-devices-title" slot="row" reveal className="catalog-after" />
        </>
      )}
      <RecommendationShelves result={loaderData.recommendations} source="search" className="catalog-after" />
    </div>
  );
}
