/**
 * Hub parts (DESIGN.md §8.2): the compact lit stage with the title and the count on its unlit half, the chip rail
 * (sub-categories, or platforms, or devices — links, so they work without script and keep the URL the state), the
 * device shortcuts (→ /device/<model>, the devices area's hubs) and the used shelf of a platform hub.
 */
import type { ReactNode } from "react";

import type { UsedUnitCardData } from "~/lib/dto";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { Breadcrumbs, type Crumb } from "~/ui/Breadcrumbs";
import { Chip } from "~/ui/Chip";
import { Niche } from "~/ui/Niche";
import { HrefLink } from "~/ui/Pagination";
import { PlatformLed, isPlatform, type Gel } from "~/ui/PlatformLed";
import { Rail } from "~/ui/Rail";
import { ShelfRail } from "~/ui/ShelfRail";
import { Render, Stage } from "~/ui/Stage";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import type { DeviceShortcut } from "../listing-model";
import { ChipText } from "./InPageDir";

export type HubHeaderProps = {
  crumbs: Crumb[];
  title: string;
  /** The platform's LED beside the title (platform hubs). */
  led?: Gel | null;
  /** "148 products". */
  count: string;
  /** The stage's light; null = unlit (a category of several platforms). */
  gel: Gel | null;
  artKey: string | null;
};

export function HubHeader({ crumbs, title, led, count, gel, artKey }: HubHeaderProps) {
  return (
    <header className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <Breadcrumbs items={crumbs} />
      <div className="catalog-hub" data-motion-anchor="">
        <Stage size="compact" gel={gel}>
          {artKey ? <Render name={artKey} alt="" sizes="(min-width: 768px) 260px, 45vw" priority /> : null}
        </Stage>
        <div className="catalog-hub__text">
          <h1 className="type-title text-ink">
            {led ? (
              <span className="inline-flex items-center gap-2" data-gel={led}>
                <PlatformLed solid />
                <bdi>{title}</bdi>
              </span>
            ) : (
              <bdi>{title}</bdi>
            )}
          </h1>
          <p className="type-caption text-ink-2">
            <bdi className="nums">{count}</bdi>
          </p>
        </div>
      </div>
    </header>
  );
}

export type RailOption = { value: string; label: ReactNode; count: number };

/** One chip per option plus "all"; each is a link to the list with that choice (selected = held, aria-current). */
export function ChipRail({ label, options, selected, allCount, hrefFor }: { label: string; options: RailOption[]; selected: string | null; allCount: number; hrefFor: (value: string | null) => string }) {
  const t = useT("catalog");
  if (options.length < 2 && selected === null) return null;
  return (
    <nav aria-label={label} className="-mx-1">
      {/* chips keep their width and the row scrolls; 4px of room for the focus ring and the clay wall */}
      <div className="chips chips--rail scroll-px-1 px-1 pt-1 lg:flex-wrap lg:overflow-x-visible [&>*]:shrink-0">
        <Chip as={HrefLink} to={hrefFor(null)} selected={selected === null}>
          <ChipText label={t("hub.all")} count={allCount} />
        </Chip>
        {options.map((option) => (
          <Chip key={option.value} as={HrefLink} to={hrefFor(option.value)} selected={selected === option.value}>
            <ChipText label={option.label} count={option.count} />
          </Chip>
        ))}
      </div>
    </nav>
  );
}

/** A platform's name with its LED (the four known platforms use the design system's names). */
export function PlatformName({ slug, fallback }: { slug: string; fallback: string }) {
  const ui = useT("ui");
  if (!isPlatform(slug)) return <>{fallback}</>;
  return (
    <span className="inline-flex items-center gap-1.5" data-gel={slug}>
      <PlatformLed solid />
      {ui(`platform.${slug}`)}
    </span>
  );
}

/** "Everything about your device": a rail of device tiles → /device/<model>. */
export function DeviceShortcuts({ devices, title, note }: { devices: DeviceShortcut[]; title: string; note: string }) {
  if (devices.length === 0) return null;
  return (
    <section aria-labelledby="catalog-devices" className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
        <h2 id="catalog-devices" className="type-section text-ink">
          {title}
        </h2>
        <p className="type-caption text-ink-2">{note}</p>
      </div>
      <Rail aria-labelledby="catalog-devices" itemClassName="flex w-[31%] sm:w-[23%] md:w-[17%] lg:w-[13.5%] xl:w-[12%]" railClassName="-mx-1 scroll-px-1 px-1 pt-1 pb-2">
        {devices.map((device) => (
          <LocaleLink key={device.slug} to={`/device/${device.slug}`} className="catalog-device" data-press="soft">
            <Niche as="span" ratio="1/1" tagZone={false} className="w-full">
              {device.artKey ? <Render name={device.artKey} alt="" sizes="(min-width: 1024px) 140px, 30vw" /> : null}
            </Niche>
            {/* in the page's direction, not a <bdi>: "PlayStation 5 (الطراز الأصلي 2020)" keeps its brackets right */}
            <span className="type-label text-ink line-clamp-2">{device.name}</span>
          </LocaleLink>
        ))}
      </Rail>
    </section>
  );
}

/** Listed used units of the platform (the used area's marketplace has the rest). */
export function UsedShelf({ units, title, href, viewAll }: { units: UsedUnitCardData[]; title: string; href: string; viewAll: string }) {
  if (units.length === 0) return null;
  return (
    <ShelfRail
      shelf={{ key: "used", title, reason: null, items: units }}
      href={href}
      viewAllLabel={viewAll}
      renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" headingLevel={3} />}
    />
  );
}
