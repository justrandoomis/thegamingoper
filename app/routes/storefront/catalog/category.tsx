/**
 * /c/:category — a category hub (Design System v2 §6.3): no colour band — a title row (h1, the count, the delivery
 * line), then one chip row (the platforms with their dots; for a department of one platform its sub-departments, else
 * the devices its products fit), the product list with filters, sorts and «اعرض المزيد», then the hubs of the devices
 * its products fit. An empty department says so and shows what arrived lately.
 * The used-devices category belongs to the used marketplace: /c/<used> redirects to /used.
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/category";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import { RecommendationShelves } from "~/routes/storefront/devices/components/RecommendationShelves";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getNewArrivals } from "~/server/services/catalog/cards.server";
import { listProducts, scopePicks } from "~/server/services/catalog/listing.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { isPlatform } from "~/ui/PlatformLed";
import { ShelfRail } from "~/ui/ShelfRail";
import { ChipRow, DeviceShortcuts, KeepInView, TitleRow, useHubLead, type RailOption } from "./components/Hub";
import { ListingView } from "./components/ListingView";
import { useListingNav, useOfflineHold } from "./components/use-listing-nav";
import { LISTING_SORTS, filtersOf, readListingQuery, type FilterGroup } from "./listing-model";
import { PAGE_SLUG, arrivalsShelf, listOf, wishedOf, withCursorFallback } from "./list.server";
import "./catalog.css";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const slug = params.category;
  if (!PAGE_SLUG.test(slug)) throw data({ error: "not_found" }, { status: 404 });
  const url = new URL(request.url);
  const query = readListingQuery(url.searchParams);
  const db = getDb();
  const result = await withCursorFallback(url, query.cursor !== null, () =>
    listProducts(db, ctx.locale, { scope: { kind: "category", slug }, filters: filtersOf(query), sort: query.sort, cursor: query.cursor, cumulative: true, now: ctx.now }),
  );
  if (!result || !result.hub.category) throw data({ error: "not_found" }, { status: 404 });
  if (result.hub.category.kind === "used") throw redirect(localePath("/used", ctx.locale));

  const picks = result.total === 0 && result.scopeTotal > 0 ? await scopePicks(db, ctx.locale, { kind: "category", slug }, { limit: 4, now: ctx.now }) : [];
  // an empty department: what arrived lately, so the page still leads somewhere (the shelf says «وصل حديثاً»: no «جديد»)
  const arrivals = result.scopeTotal === 0 ? arrivalsShelf(await getNewArrivals(db, ctx.locale, { limit: 8, now: ctx.now })) : [];
  const t = serverT(ctx.locale, "catalog");
  const category = result.hub.category;
  const session = await getCustomer(ctx, db);
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
    meta: { title: category.name, description: t("meta.category", { name: category.name, n: String(result.scopeTotal) }) },
    i18n: messagesFor(ctx.locale, "catalog"),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description });

export default function CategoryPage({ loaderData }: Route.ComponentProps) {
  const { list, hub, picks, arrivals, wished } = loaderData;
  const t = useT("catalog");
  const ui = useT("ui");
  const f = useFormat();
  const nav = useListingNav({ sorts: LISTING_SORTS });
  const hold = useOfflineHold();
  const lead = useHubLead();
  const category = hub.category!;

  // the chip row: the platforms (dots) first; for a department of one platform its sub-departments, else its devices
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
      options: list.facets.categories.map((option) => ({ value: option.value, label: option.label, count: option.count })),
      selected: nav.query.category,
      allCount: list.facets.without.category,
      hrefFor: (value) => nav.href({ category: value }),
    };
  } else if (list.facets.devices.length >= 2 || nav.query.device) {
    rail = {
      label: t("hub.devicesRail"),
      group: "device",
      options: list.facets.devices.map((option) => ({ value: option.value, label: option.label, count: option.count })),
      selected: nav.query.device,
      allCount: list.facets.without.device,
      hrefFor: (value) => nav.href({ device: value }),
    };
  }

  const crumbs = [{ label: t("hub.home"), href: "/" }, ...category.trail.map((crumb) => ({ label: crumb.name, href: `/c/${crumb.slug}` })), { label: category.name }];
  const count = t("hub.products", { count: list.scopeTotal, n: f.number(list.scopeTotal) });

  return (
    <div className="page catalog-page" onClickCapture={hold}>
      <TitleRow crumbs={crumbs} title={category.name} count={list.scopeTotal > 0 ? count : null} lead={lead} />
      {list.scopeTotal === 0 ? (
        <>
          <EmptyState
            layout="stack"
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
            <KeepInView className="catalog-after">
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
          />
          <DeviceShortcuts layout="grid" devices={hub.devices} title={t("hub.devicesByCategory")} note={t("hub.devicesByCategoryNote")} id="catalog-devices-title" slot="grid" className="catalog-after" />
        </>
      )}
      <RecommendationShelves result={loaderData.recommendations} source="search" className="catalog-after" />
    </div>
  );
}
