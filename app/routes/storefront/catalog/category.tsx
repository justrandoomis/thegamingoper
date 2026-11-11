/**
 * /c/:category — a category hub (DESIGN.md §8.2 header, §8.3 list): the compact stage (lit in the category's
 * platform colour when it has exactly one, or in the colour of the one platform the shopper filters by), the chip
 * rail (sub-categories; for a leaf category the platforms or the devices), the product list with filters, sorts and
 * "show more", then shortcuts to the hubs of the devices its products fit.
 * The used-devices category belongs to the used marketplace: /c/<used> redirects to /used.
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/category";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useFormat, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listProducts, scopePicks } from "~/server/services/catalog/listing.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { RecommendationShelves } from "~/routes/storefront/devices/components/RecommendationShelves";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { LocaleLink } from "~/i18n/react";
import { isPlatform } from "~/ui/PlatformLed";
import { ChipRail, DeviceShortcuts, HubHeader, PlatformName, type RailOption } from "./components/Hub";
import { ListingView } from "./components/ListingView";
import { CompareTray } from "./components/CompareTray";
import { useListingNav } from "./components/use-listing-nav";
import { LISTING_SORTS, filtersOf, readListingQuery } from "./listing-model";
import { PAGE_SLUG, listOf, withCursorFallback } from "./list.server";
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

  const picks = result.total === 0 && result.scopeTotal > 0 ? await scopePicks(db, ctx.locale, { kind: "category", slug }, { limit: 3, now: ctx.now }) : [];
  const t = serverT(ctx.locale, "catalog");
  const category = result.hub.category;
  const session = await getCustomer(ctx, db);
  return {
    list: listOf(result),
    hub: result.hub,
    picks,
    // the devices area's shelf from the shopper's own signals (context "search") — consent only, streamed
    recommendations: recommendationsFor(
      db,
      { cookie: ctx.cookie, customerId: session?.customer.id ?? null },
      { locale: ctx.locale, context: "search", platformSlugs: category.platform ? [category.platform] : undefined, personalOnly: true, now: ctx.now },
      8,
    ),
    meta: { title: category.name, description: t("meta.category", { name: category.name, n: String(result.scopeTotal) }) },
    i18n: messagesFor(ctx.locale, "catalog"),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description });

export default function CategoryPage({ loaderData }: Route.ComponentProps) {
  const { list, hub, picks } = loaderData;
  const t = useT("catalog");
  const f = useFormat();
  const nav = useListingNav({ sorts: LISTING_SORTS });
  const category = hub.category!;
  const chosen = nav.query.platforms.length === 1 ? nav.query.platforms[0] : null;
  const gel = chosen && isPlatform(chosen) ? chosen : category.platform && isPlatform(category.platform) ? category.platform : null;

  // the chip rail: sub-categories; for a leaf category the platforms, else the devices
  let rail: { label: string; options: RailOption[]; selected: string | null; allCount: number; hrefFor: (value: string | null) => string } | null = null;
  if (list.facets.categories.length > 0) {
    rail = {
      label: t("hub.subcategories"),
      options: list.facets.categories.map((option) => ({ value: option.value, label: option.label, count: option.count })),
      selected: nav.query.category,
      allCount: list.facets.without.category,
      hrefFor: (value) => nav.href({ category: value }),
    };
  } else if (list.facets.platforms.length >= 2) {
    rail = {
      label: t("hub.platforms"),
      options: list.facets.platforms.map((option) => ({ value: option.value, label: <PlatformName slug={option.value} fallback={option.label} />, count: option.count })),
      selected: nav.query.platforms.length === 1 ? nav.query.platforms[0] : null,
      allCount: list.facets.without.platforms,
      hrefFor: (value) => nav.href({ platforms: value ? [value] : [] }),
    };
  } else if (list.facets.devices.length >= 2) {
    rail = {
      label: t("hub.devicesRail"),
      options: list.facets.devices.map((option) => ({ value: option.value, label: option.label, count: option.count })),
      selected: nav.query.device,
      allCount: list.facets.without.device,
      hrefFor: (value) => nav.href({ device: value }),
    };
  }

  const crumbs = [{ label: t("hub.home"), href: "/" }, ...category.trail.map((crumb) => ({ label: crumb.name, href: `/c/${crumb.slug}` })), { label: category.name }];

  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-6 pb-12 pt-3">
      <HubHeader crumbs={crumbs} title={category.name} count={t("hub.products", { count: list.scopeTotal, n: f.number(list.scopeTotal) })} gel={gel} artKey={category.artKey} />
      {list.scopeTotal === 0 ? (
        <EmptyState
          layout="stack"
          title={t("hub.emptyTitle")}
          text={t("hub.emptyText")}
          action={
            <Key as={LocaleLink} to="/search">
              {t("hub.emptyAction")}
            </Key>
          }
        />
      ) : (
        <>
          {rail ? <ChipRail label={rail.label} options={rail.options} selected={rail.selected} allCount={rail.allCount} hrefFor={rail.hrefFor} /> : null}
          <ListingView
            list={list}
            nav={nav}
            scope="category"
            sorts={LISTING_SORTS}
            heading={t("hub.resultsHeading", { name: category.name })}
            zero={{ title: t("zero.title"), text: t("zero.text") }}
            picks={picks}
            picksTitle={t("zero.picksCategory")}
          />
          <DeviceShortcuts devices={hub.devices} title={t("hub.devicesByCategory")} note={t("hub.devicesByCategoryNote")} />
        </>
      )}
      <RecommendationShelves result={loaderData.recommendations} source="search" />
      <CompareTray />
    </div>
  );
}
