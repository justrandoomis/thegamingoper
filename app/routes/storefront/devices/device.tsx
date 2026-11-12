/**
 * /device/:model — "everything about this device" (brief §3.4; Design System v2 §6.6). docs/areas/devices.md.
 *
 * The loader awaits the hub (services/devices.server.ts → getDeviceHub: one read for the model, one batch of eleven,
 * then the cards) and STREAMS two things the page never waits for: the head's «من …» price (hub.server.ts → the
 * cheapest version that can be ordered now) and the "complete your setup" shelf (services/recommendations.server.ts,
 * context device_hub), which arrive into reserved space. Unknown slugs, drafts and devices of inactive platforms (the
 * generic Windows PC target) are a 404 inside the shell.
 *
 * Page order (§6.6): breadcrumbs (from 768) · the head (Band kind="device") · sticky section chips · editions ·
 * complete your setup · comparison · specs · accessories (compatible ones only) · games · setup and repair ·
 * questions · used. A section with nothing in it is not drawn, and its chip is not offered.
 *
 * URL state: `?all=<grid>` (repeatable) shows a card grid in full — a link, so it works before JavaScript and survives
 * Back and a reload; a change of `all` only never asks the loader again (shouldRevalidate).
 *
 * Shell contract (CONTRACTS §2): no <main> here — the page starts with breadcrumbs and its <h1>; meta through
 * shellMeta (canonical, hreflang, Open Graph, demo noindex), og:image = the device product's share picture.
 */
import { data, useRouteLoaderData, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/device";
import { productShareImage } from "~/art";
import { messagesFor } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { makeT, type MessageTree } from "~/i18n/translate";
import { DEFAULT_LOCALE, isLocale } from "~/lib/locales";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getDeviceHub } from "~/server/services/devices.server";
import { getRecommendations } from "~/server/services/recommendations.server";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { isPlatform } from "~/ui/PlatformLed";
import { CompareSection } from "./components/CompareSection";
import { CompatSection } from "./components/CompatSection";
import { FaqSection } from "./components/FaqSection";
import { accessoryGroups, deviceIn, gelOf, hubSections, onlyGridsChanged, type FromOutcome } from "./components/format";
import { HelpSection } from "./components/HelpSection";
import { HubHead } from "./components/HubHead";
import { SectionNav, type SectionLink } from "./components/SectionNav";
import { SetupShelf, type SetupResult } from "./components/SetupShelf";
import { useShelfSignals } from "./components/signals";
import { SpecSection } from "./components/SpecSection";
import { UsedSection } from "./components/UsedSection";
import { VersionsSection } from "./components/VersionsSection";
import { fromPriceOf } from "./hub.server";
import { LAYOUT_ROUTE_ID, shellMeta } from "../shell/meta";
import "./devices.css";

export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const hub = await getDeviceHub(db, ctx.locale, params.model, { now: ctx.now });
  if (!hub) throw data({ error: "not_found" }, { status: 404 });
  // Streamed, never rejected: a failed read is { failed: true } (the head then shows no price), never a guess.
  const from: Promise<FromOutcome> = fromPriceOf(db, ctx.locale, hub, ctx.now).then(
    (amount) => ({ amount }),
    (error: unknown) => {
      console.error("[devices] the from-price failed", error);
      return { failed: true as const };
    },
  );
  // Streamed, never rejected: a failure becomes { ok: false } and the page shows a retry in that space only.
  // The hub's shelf is about the device, not the shopper — no personal signal is read here (consent: false).
  const setup: Promise<SetupResult> = getRecommendations(db, { locale: ctx.locale, context: "device_hub", deviceModelId: hub.model.id, consent: false, now: ctx.now }, 8)
    .then((shelves) => ({ ok: true as const, shelves }))
    .catch((error: unknown) => {
      console.error("[devices] the setup shelf failed", error);
      return { ok: false as const, shelves: [] };
    });
  return { hub, from, setup, i18n: messagesFor(ctx.locale, "devices") };
}

/** Showing a card grid in full (`?all=`) is a choice on this page — every card is already here, so nothing is reloaded. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname && onlyGridsChanged(currentUrl.searchParams, nextUrl.searchParams)) return false;
  return defaultShouldRevalidate;
}

export const meta: Route.MetaFunction = (args) => {
  const hub = args.loaderData?.hub;
  if (!hub) return shellMeta(args);
  const rootLocale = (args.matches.find((match) => match?.id === "root")?.loaderData as { locale?: unknown } | undefined)?.locale;
  const locale = isLocale(rootLocale) ? rootLocale : DEFAULT_LOCALE;
  const t = makeT(args.loaderData?.i18n.devices as MessageTree | undefined, locale, "devices");
  const share = hub.mainProductSlug ? productShareImage(hub.mainProductSlug) : undefined;
  return shellMeta(args, { title: t("meta.title", { device: hub.model.name }), description: t("meta.description", { device: hub.model.name }), image: share?.src ?? null });
};

type LayoutData = { shell?: { publicOrigin?: string } };

export default function DeviceHubPage({ loaderData }: Route.ComponentProps) {
  const { hub, from, setup } = loaderData;
  const t = useT("devices");
  const ui = useT("ui");
  // clicks on product cards anywhere on the hub are click-through signals of their shelf (consent only — signals.ts)
  const signals = useShelfSignals("device_hub");
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as LayoutData | undefined;
  const gel = gelOf(hub.model.platform.accent);
  const device = deviceIn(hub.model.name);
  const name = hub.model.name;
  // the four platforms carry the design system's names (Latin brand names stay Latin), others their own
  const platformName = isPlatform(hub.model.platform.slug) ? ui(`platform.${hub.model.platform.slug}`) : hub.model.platform.name;
  const sections: SectionLink[] = hubSections(hub).map((id) => ({ id, label: t(`nav.${id}`) }));

  return (
    // one track that never grows past the page column: wide content (the chips, the comparison table) scrolls inside
    <div ref={signals} className="page grid grid-cols-[minmax(0,1fr)] gap-section pt-4 pb-16">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <Breadcrumbs
          items={[{ label: t("crumbs.home"), href: "/" }, { label: platformName, href: `/platform/${hub.model.platform.slug}` }, { label: name }]}
          jsonLd={layout?.shell?.publicOrigin ? { origin: layout.shell.publicOrigin } : undefined}
        />
        <HubHead hub={hub} gel={gel} platformName={platformName} from={from} />
      </div>
      {/* a direct child of the page's track, so it stays stuck through every section (devices.css pulls it up to the head) */}
      <SectionNav sections={sections} label={t("nav.label", { device })} />
      <VersionsSection hub={hub} />
      {/* keyed by device: moving to a sibling hub mounts a NEW boundary, which shows its placeholder at once instead of
          holding the navigation until the new shelf has streamed in (a transition keeps already revealed content) */}
      <SetupShelf key={hub.model.slug} result={setup} title={t("rec.setup.title", { device })} reason={t("rec.setup.reason", { device })} loading={t("setup.loading", { device })} />
      <CompareSection hub={hub} />
      <SpecSection hub={hub} />
      <CompatSection
        id="accessories"
        title={t("compat.accessoriesTitle", { device })}
        reason={t("compat.accessoriesReason", { device })}
        allLabel={(n) => t("compat.allAccessories", { n })}
        groups={accessoryGroups(hub.accessories)}
        deviceName={name}
      />
      <CompatSection id="games" title={t("compat.gamesTitle", { device })} reason={t("compat.gamesReason", { device })} allLabel={(n) => t("compat.allGames", { n })} groups={hub.games} deviceName={name} />
      <HelpSection hub={hub} platformName={platformName} />
      <FaqSection hub={hub} />
      <UsedSection hub={hub} />
    </div>
  );
}
