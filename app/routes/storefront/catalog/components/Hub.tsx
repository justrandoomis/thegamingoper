/**
 * Hub parts (Design System v2 §6.2, §6.3): the platform hub's colour band (the platform's surface with its hardware
 * bleeding off the inline end; a model switcher inside it from 1024), the title row of category hubs and search
 * results, the chip row (links, so it works without script and keeps the URL the state), the device tiles
 * ("everything about your device" → /device/<model>, the devices area's hubs) and the used shelf of a platform hub.
 */
import type { FocusEvent, ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import type { UsedUnitCardData } from "~/lib/dto";
import { useFormat, useT } from "~/i18n/react";
import { MotionLink, SharedElement } from "~/motion";
import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { Band } from "~/ui/Band";
import { Breadcrumbs, type Crumb } from "~/ui/Breadcrumbs";
import { CategoryTile } from "~/ui/CategoryTile";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { HrefLink } from "~/ui/Pagination";
import { isPlatform, type Platform } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { ShelfRail } from "~/ui/ShelfRail";
import { Render } from "~/ui/Stage";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import type { DeviceShortcut } from "../listing-model";

/**
 * A row that scrolls sideways: bring the control that takes the keyboard's focus fully into view. (Chromium's own
 * focus scrolling leaves every third chip of a right-to-left `.chips--rail.chips--bleed` row mostly off-screen.) A row
 * that snaps (the device tiles, the kit's shelf rail) rests only where an item starts: "nearest" would be pulled back
 * to the previous snap point with the focused item cut off, so there the focused item is brought to the row's start.
 */
export function keepInView(event: FocusEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
  const row = target.parentElement?.closest<HTMLElement>(".catalog-devices__rail, .chips--rail, .rail");
  if (row && getComputedStyle(row).scrollSnapType !== "none") {
    // the row's own item — its snap point — to the row's start
    const item = [...row.children].find((child) => child.contains(target)) ?? target;
    item.scrollIntoView({ block: "nearest", inline: "start" });
    return;
  }
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** A kit shelf on this area's pages: its rail keeps a card focused with Tab in view (the kit's does not yet; requested). */
export function KeepInView({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("min-w-0", className)} onFocus={keepInView}>
      {children}
    </div>
  );
}

/**
 * The hub lead line: «التوصيل 5,000 د.ع لكل المحافظات، والدفع عند الاستلام» — the fee and the cash-on-delivery switch
 * come from the store's settings (the layout's shell data); null when the shell data is not there.
 */
export function useHubLead(): string | null {
  const t = useT("catalog");
  const f = useFormat();
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData | null } | undefined;
  const shell = layout?.shell;
  if (!shell || !Number.isSafeInteger(shell.deliveryFeeIqd) || shell.deliveryFeeIqd < 0) return null;
  const fee = iqdText(f, shell.deliveryFeeIqd);
  return shell.payments.cod ? t("hub.lead", { fee }) : t("hub.leadNoCod", { fee });
}

/** «كل شيء عن أجهزة PlayStation» — one string per platform (the handheld platform reads «الأجهزة المحمولة»). */
export function useDevicesTitle(): (slug: string, name: string) => string {
  const t = useT("catalog");
  return (slug, name) => (isPlatform(slug) ? t(`hub.devices.${slug}`) : t("hub.devices.generic", { name }));
}

export type HubBandProps = {
  platform: Platform;
  /** The platform's name in the design system's words ("PlayStation", «الأجهزة المحمولة»). */
  title: string;
  /** «42 منتجاً». */
  count: string;
  /** The delivery (and cash-on-delivery) line; null when unknown. */
  lead: string | null;
  /** The platform's lead device photo (a cut-out). */
  art: string | null;
  /** The platform's device models: the switcher inside the band from 1024. */
  devices: DeviceShortcut[];
  /** Names the switcher («كل شيء عن أجهزة PlayStation»). */
  devicesLabel: string;
  crumbs: Crumb[];
};

/** Device models the band's switcher shows (two at 1024–1279, three from 1280); the rest are «كل الأجهزة (n)». */
const SWITCHER_MODELS = 3;

/**
 * The platform hub's head: breadcrumbs (from 768), then the band — the platform's colour (a lit cabinet in the dark
 * theme), the h1 in white, the count and the lead line, the hardware at the inline end. From 1024 the band holds the
 * model switcher: paper tiles with a photo and the model's name, each a link to its device hub.
 */
export function HubBand({ platform, title, count, lead, art, devices, devicesLabel, crumbs }: HubBandProps) {
  const t = useT("catalog");
  const f = useFormat();
  const shown = devices.slice(0, SWITCHER_MODELS);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <Breadcrumbs items={crumbs} />
      <Band
        kind="platform"
        platform={platform}
        as="header"
        className="catalog-band"
        mediaClassName="catalog-band__media"
        contentClassName="catalog-band__content"
        // decorative, like the platform tiles' hardware: never preloaded — the first product card is the page's LCP and
        // takes the one priority slot (ListingView)
        media={art ? <Render name={art} alt="" sizes="(min-width: 1024px) 360px, 44vw" /> : undefined}
        data-motion-anchor=""
      >
        <h1 className="type-h1 catalog-band__title">
          <bdi>{title}</bdi>
        </h1>
        <p className="catalog-band__line">
          <span className="nums">{count}</span>
          {lead ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{lead}</span>
            </>
          ) : null}
        </p>
        {shown.length > 0 ? (
          <nav aria-label={devicesLabel} className="catalog-switcher">
            <ul role="list" className="catalog-switcher__list">
              {shown.map((device, index) => (
                <li key={device.slug} className={cx(index >= 2 && "max-2xl:hidden")}>
                  <MotionLink nav="zoom" to={`/device/${device.slug}`} className="catalog-model" data-press="soft">
                    {/* in the page's direction, not a <bdi>: "PlayStation 5 (الطراز الأصلي 2020)" keeps its brackets */}
                    <span className="catalog-model__name">{device.name}</span>
                    <SharedElement name={`device-image:${device.slug}`} slot="switcher" as="span" className="catalog-model__art">
                      {device.artKey ? (
                        <span className="render-slot absolute inset-[10%]">
                          <Render name={device.artKey} alt="" sizes="40px" />
                        </span>
                      ) : null}
                    </SharedElement>
                  </MotionLink>
                </li>
              ))}
              {devices.length > 2 ? (
                <li className={cx(devices.length <= SWITCHER_MODELS && "2xl:hidden")}>
                  <a href="#catalog-devices" className="catalog-model catalog-model--all" data-press="soft">
                    <span className="catalog-model__name nums">{t("hub.allDevices", { n: f.number(devices.length) })}</span>
                  </a>
                </li>
              ) : null}
            </ul>
          </nav>
        ) : null}
      </Band>
    </div>
  );
}

/**
 * The head of a category hub or of search results: no colour band — breadcrumbs (from 768), the h1, the count and
 * one lead line (the delivery and cash-on-delivery line), then anything else the page puts under it.
 */
export function TitleRow({ crumbs, title, count, lead, children }: { crumbs?: Crumb[]; title: ReactNode; count?: string | null; lead?: string | null; children?: ReactNode }) {
  return (
    <header className="catalog-title">
      {crumbs ? <Breadcrumbs items={crumbs} /> : null}
      <h1 className="type-h1 text-ink">{title}</h1>
      {count || lead ? (
        <p className="catalog-title__line">
          {count ? <span className="nums text-ink">{count}</span> : null}
          {count && lead ? <span aria-hidden="true"> · </span> : null}
          {lead ? <span>{lead}</span> : null}
        </p>
      ) : null}
      {children}
    </header>
  );
}

export type RailOption = { value: string; label: string; count: number; platform?: Platform };

/**
 * One chip per option plus «الكل»; each is a link to the list with that choice (chosen = ink, aria-current). One row
 * that scrolls sideways on phones (the gutter kept), wrapping from 768. Nothing for fewer than two options.
 */
export function ChipRow({ label, options, selected, allCount, hrefFor }: { label: string; options: RailOption[]; selected: string | null; allCount: number; hrefFor: (value: string | null) => string }) {
  const t = useT("catalog");
  if (options.length < 2 && selected === null) return null;
  return (
    <nav aria-label={label} className="min-w-0" onFocus={keepInView}>
      <div className="chips chips--rail chips--bleed catalog-chips">
        <Chip as={HrefLink} to={hrefFor(null)} selected={selected === null} count={allCount}>
          {t("hub.all")}
        </Chip>
        {options.map((option) => (
          <Chip key={option.value} as={HrefLink} to={hrefFor(option.value)} selected={selected === option.value} count={option.count} platform={option.platform}>
            {option.label}
          </Chip>
        ))}
      </div>
    </nav>
  );
}

/** A platform's name with its dot (the four known platforms use the design system's names). */
export function PlatformName({ slug, fallback }: { slug: string; fallback: string }) {
  const ui = useT("ui");
  if (!isPlatform(slug)) return <>{fallback}</>;
  return (
    <span className="plat" data-gel={slug}>
      <i className="led" aria-hidden="true" />
      <span>{ui(`platform.${slug}`)}</span>
    </span>
  );
}

/**
 * "Everything about your device": device tiles → /device/<model>. `layout="rail"` is one row that scrolls sideways
 * (phones, inside the product grid after its first two rows — pass `headingLevel={3}` there: it is a part of the list);
 * `"grid"` is the wrapping grid of category tiles (3 → 6 columns). Each tile's picture is the shared element
 * `device-image:<slug>`: it grows into the device hub's stage.
 */
export function DeviceShortcuts({
  devices,
  title,
  note,
  layout,
  id,
  slot,
  headingLevel = 2,
  className,
}: {
  devices: DeviceShortcut[];
  title: string;
  note: string;
  layout: "rail" | "grid";
  id: string;
  slot: string;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  if (devices.length === 0) return null;
  const tiles = devices.map((device) => (
    <li key={device.slug} className="grid">
      <CategoryTile
        as={MotionLink}
        nav="zoom"
        to={`/device/${device.slug}`}
        label={<span className="line-clamp-2">{device.name}</span>}
        art={
          <SharedElement name={`device-image:${device.slug}`} slot={slot} as="span" className="render-slot absolute inset-[14%]">
            {device.artKey ? <Render name={device.artKey} alt="" sizes="(min-width: 1024px) 160px, (min-width: 768px) 22vw, 30vw" /> : null}
          </SharedElement>
        }
      />
    </li>
  ));
  return (
    <section aria-labelledby={id} className={cx("catalog-devices", className)} id={layout === "grid" ? "catalog-devices" : undefined}>
      <div className="sechead">
        <div className="sechead__text">
          <Heading id={id} className="sechead__title">
            {title}
          </Heading>
          <p className="sechead__reason">{note}</p>
        </div>
      </div>
      <ul role="list" className={layout === "rail" ? "catalog-devices__rail" : "cats"} onFocus={layout === "rail" ? keepInView : undefined}>
        {tiles}
      </ul>
    </section>
  );
}

/** Listed used units of the platform (≥ 3; the used area's marketplace has the rest). */
export function UsedShelf({ units, title, reason, href, viewAll, className }: { units: UsedUnitCardData[]; title: string; reason: string; href: string; viewAll: string; className?: string }) {
  return (
    <KeepInView className={className}>
      <ShelfRail shelf={{ key: "used", title, reason, items: units }} href={href} viewAllLabel={viewAll} renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" headingLevel={3} />} />
    </KeepInView>
  );
}
