/**
 * /platform/:platform — a platform hub (Design System v2 §6.2; v2.1 client note 4): the band — glossy platform-colour
 * glass with its hardware breaking out of the top and the platform's light on the floor around it — then "everything
 * about your device" (the before's row of soft device tiles → /device/<model>, short names: the platform's name is in
 * the band), the departments as chips with their kind icons and counts, the product list (every product RESEARCHED for
 * the platform — multi-platform games and headsets included, see listing.server.ts) with filters that say how many
 * results each choice gives, sorts and «اعرض المزيد», and the platform's used units. Products start on the first phone
 * screen (390 × 844: the first cards' pictures under the toolbar). Platform hubs are siblings: moving between them
 * pushes sideways in reading order (handle).
 */
import { data, useLocation } from "react-router";

import type { Route } from "./+types/platform";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { RecommendationShelves } from "~/routes/storefront/devices/components/RecommendationShelves";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getUsedSpotlight } from "~/server/services/catalog/cards.server";
import { listProducts, scopePicks } from "~/server/services/catalog/listing.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { ErrorState } from "~/ui/ErrorState";
import { isPlatform, PLATFORMS } from "~/ui/PlatformLed";
import { ChipRow, DeviceRow, HubBand, TitleRow, UsedShelf, useDevicesTitle, useHubLead, useKindIcon } from "./components/Hub";
import { ListingView } from "./components/ListingView";
import { useListingNav, useOfflineHold } from "./components/use-listing-nav";
import { LISTING_SORTS, filtersOf, readListingQuery } from "./listing-model";
import { PAGE_SLUG, filterOrderOf, listOf, wishedOf, withCursorFallback } from "./list.server";
import "./catalog.css";

export const handle = {
  nav: "push",
  order: ({ params }) => {
    const index = (PLATFORMS as readonly string[]).indexOf(params.platform ?? "");
    return index === -1 ? null : index;
  },
} satisfies MotionHandle;

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const slug = params.platform;
  if (!PAGE_SLUG.test(slug)) throw data({ error: "not_found" }, { status: 404 });
  const url = new URL(request.url);
  const query = readListingQuery(url.searchParams);
  const db = getDb();
  // the platform is the page: a platform filter in the URL means nothing here
  const filters = { ...filtersOf(query), platforms: [] };
  const result = await withCursorFallback(url, query.cursor !== null, () =>
    listProducts(db, ctx.locale, { scope: { kind: "platform", slug }, filters, sort: query.sort, cursor: query.cursor, cumulative: true, now: ctx.now }),
  );
  if (!result || !result.hub.platform) throw data({ error: "not_found" }, { status: 404 });

  // secondary parts: a failure here leaves the page usable (the list above is what the shopper came for)
  let used: Awaited<ReturnType<typeof getUsedSpotlight>> | null = null;
  try {
    used = await getUsedSpotlight(db, ctx.locale, { platform: slug, limit: 8 });
  } catch (error) {
    console.error("[catalog] used shelf failed", error);
  }
  const picks = result.total === 0 && result.scopeTotal > 0 ? await scopePicks(db, ctx.locale, { kind: "platform", slug }, { limit: 4, now: ctx.now }) : [];
  const t = serverT(ctx.locale, "catalog");
  const platform = result.hub.platform;
  const ui = serverT(ctx.locale, "ui");
  const name = isPlatform(platform.slug) ? ui(`platform.${platform.slug}`) : platform.name;
  // the listing filters in the order staff gave every listing (content module 17.03; null: the page's own)
  const [session, filterOrder] = await Promise.all([getCustomer(ctx, db), filterOrderOf(db, null)]);
  const customerId = session?.customer.id ?? null;
  return {
    list: listOf(result),
    hub: result.hub,
    filterOrder,
    used,
    picks,
    wished: await wishedOf(db, ctx, customerId, [...result.items, ...picks].map((card) => card.id)),
    // the devices area's shelf from the shopper's own signals (context "search") — consent only, streamed; the
    // store's picks are left out: the list above already is the platform's catalogue
    recommendations: recommendationsFor(db, { cookie: ctx.cookie, customerId }, { locale: ctx.locale, context: "search", platformSlugs: [platform.slug], personalOnly: true, now: ctx.now }, 8),
    meta: { title: name, description: t("meta.platform", { name, n: String(result.scopeTotal) }) },
    i18n: messagesFor(ctx.locale, "catalog"),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description });

export default function PlatformPage({ loaderData }: Route.ComponentProps) {
  const { list, hub, used, picks, wished, recommendations, filterOrder } = loaderData;
  const t = useT("catalog");
  const ui = useT("ui");
  const f = useFormat();
  const nav = useListingNav({ sorts: LISTING_SORTS });
  const hold = useOfflineHold();
  const location = useLocation();
  const lead = useHubLead();
  const devicesTitle = useDevicesTitle();
  const kindIcon = useKindIcon();
  const platform = hub.platform!;
  const known = isPlatform(platform.slug) ? platform.slug : null;
  const name = known ? ui(`platform.${known}`) : platform.name;
  const count = t("hub.products", { count: list.scopeTotal, n: f.number(list.scopeTotal) });
  const crumbs = [{ label: t("hub.home"), href: "/" }, { label: name }];

  return (
    <div className="page catalog-page" onClickCapture={hold}>
      {known ? (
        <HubBand platform={known} title={name} count={count} lead={lead} art={platform.artKey} crumbs={crumbs} />
      ) : (
        <TitleRow crumbs={crumbs} title={name} count={count} lead={lead} icon="squares-four" />
      )}
      {/* the before's «كل شيء عن أجهزة PlayStation» row, right under the band: the band names the platform, so short names */}
      <DeviceRow devices={hub.devices} title={devicesTitle(platform.slug, name)} note={t("hub.devicesNote")} id="catalog-devices-title" slot="row" names="short" />
      <ChipRow
        label={t("hub.subcategories")}
        options={list.facets.categories.map((option) => ({ value: option.value, label: option.label, count: option.count, icon: kindIcon(option.value) }))}
        selected={nav.query.category}
        allCount={list.facets.without.category}
        hrefFor={(value) => nav.href({ category: value })}
      />
      <ListingView
        list={list}
        nav={nav}
        scope="platform"
        sorts={LISTING_SORTS}
        heading={t("hub.resultsHeading", { name })}
        zero={{ title: t("zero.title"), text: t("zero.text") }}
        picks={picks}
        picksTitle={t("zero.picksPlatform", { name })}
        elsewhere={list.facets.categories.length >= 2 || nav.query.category ? ["category"] : []}
        wished={wished}
        filterOrder={filterOrder}
      />
      {used ? (
        used.length >= 3 ? (
          <UsedShelf units={used} title={t("hub.used")} reason={t("hub.usedReason")} href={`/used?platform=${platform.slug}`} viewAll={t("hub.usedAll")} className="catalog-after" />
        ) : null
      ) : (
        // partial data: the used shelf could not be read; the rest of the page stands
        <ErrorState title={t("hub.usedFailed")} retryHref={location.search || "?"} minHeight="96px" className="catalog-after" />
      )}
      <RecommendationShelves result={recommendations} source="search" className="catalog-after" />
    </div>
  );
}
