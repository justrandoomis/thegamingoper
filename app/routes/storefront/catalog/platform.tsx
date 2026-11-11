/**
 * /platform/:platform — a platform hub (DESIGN.md §8.2): the compact stage in the platform's light with its lead
 * device, the departments of the platform as a chip rail, "everything about your device" (→ /device/<model>), the
 * product list (every product RESEARCHED for the platform — multi-platform games and headsets included, see
 * listing.server.ts) with filters, sorts and "show more", and the platform's listed used units.
 * Platform hubs are siblings: moving between them pushes sideways in reading order (handle below).
 */
import { data, useLocation } from "react-router";

import type { Route } from "./+types/platform";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getUsedSpotlight } from "~/server/services/catalog/cards.server";
import { listProducts, scopePicks } from "~/server/services/catalog/listing.server";
import { ErrorState } from "~/ui/ErrorState";
import { isPlatform, PLATFORMS } from "~/ui/PlatformLed";
import { ChipRail, DeviceShortcuts, HubHeader, UsedShelf } from "./components/Hub";
import { CompareTray } from "./components/CompareTray";
import { ListingView } from "./components/ListingView";
import { useListingNav } from "./components/use-listing-nav";
import { LISTING_SORTS, filtersOf, readListingQuery } from "./listing-model";
import { PAGE_SLUG, listOf, withCursorFallback } from "./list.server";
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
  const picks = result.total === 0 && result.scopeTotal > 0 ? await scopePicks(db, ctx.locale, { kind: "platform", slug }, { limit: 3, now: ctx.now }) : [];
  const t = serverT(ctx.locale, "catalog");
  const platform = result.hub.platform;
  const ui = serverT(ctx.locale, "ui");
  const name = isPlatform(platform.slug) ? ui(`platform.${platform.slug}`) : platform.name;
  return {
    list: listOf(result),
    hub: result.hub,
    used,
    picks,
    meta: { title: name, description: t("meta.platform", { name, n: String(result.scopeTotal) }) },
    i18n: messagesFor(ctx.locale, "catalog"),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description });

export default function PlatformPage({ loaderData }: Route.ComponentProps) {
  const { list, hub, used, picks } = loaderData;
  const t = useT("catalog");
  const ui = useT("ui");
  const f = useFormat();
  const nav = useListingNav({ sorts: LISTING_SORTS });
  const location = useLocation();
  const platform = hub.platform!;
  const gel = isPlatform(platform.slug) ? platform.slug : null;
  const name = isPlatform(platform.slug) ? ui(`platform.${platform.slug}`) : platform.name;

  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-6 pb-12 pt-3">
      <HubHeader
        crumbs={[{ label: t("hub.home"), href: "/" }, { label: name }]}
        title={name}
        led={gel}
        count={t("hub.products", { count: list.scopeTotal, n: f.number(list.scopeTotal) })}
        gel={gel}
        artKey={platform.artKey}
      />
      <ChipRail
        label={t("hub.subcategories")}
        options={list.facets.categories.map((option) => ({ value: option.value, label: option.label, count: option.count }))}
        selected={nav.query.category}
        allCount={list.facets.without.category}
        hrefFor={(value) => nav.href({ category: value })}
      />
      <DeviceShortcuts devices={hub.devices} title={t("hub.devicesTitle", { name })} note={t("hub.devicesNote")} />
      <ListingView
        list={list}
        nav={nav}
        scope="platform"
        sorts={LISTING_SORTS}
        heading={t("hub.resultsHeading", { name })}
        zero={{ title: t("zero.title"), text: t("zero.text") }}
        picks={picks}
        picksTitle={t("zero.picksPlatform", { name })}
      />
      {used ? (
        <UsedShelf units={used} title={t("hub.used")} href={`/used?platform=${platform.slug}`} viewAll={t("hub.usedAll")} />
      ) : (
        // partial data: the used shelf could not be read; the rest of the page stands
        <ErrorState title={t("hub.usedFailed")} retryHref={location.search || "?"} minHeight="96px" />
      )}
      <CompareTray />
    </div>
  );
}
