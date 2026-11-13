/**
 * Hub parts (Design System v2 §6.2, §6.3; v2.1 «Clay & Glass», client note 4): the platform hub's colour band (glossy
 * platform-colour glass in the kit's `.band--platform`, the hardware breaking out of its top, the platform's light on
 * the floor around it), the glass head of category hubs, search and compare (an icon tile, the h1, the count), the
 * chip row with kind icons (links, so it works without script and keeps the URL the state), the device row
 * ("everything about your device" → /device/<model>, the devices area's hubs: the before's soft tiles with the device
 * pictures) and the used shelf of a platform hub.
 */
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import type { UsedUnitCardData } from "~/lib/dto";
import { useDir, useFormat, useT } from "~/i18n/react";
import { MotionLink, SharedElement, useRail } from "~/motion";
import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";
import type { NavCategory, ShellData } from "~/routes/storefront/shell/types";
import { Band } from "~/ui/Band";
import { hasRtl } from "~/ui/BidiText";
import { Breadcrumbs, type Crumb } from "~/ui/Breadcrumbs";
import { CategoryTile } from "~/ui/CategoryTile";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { IconKey } from "~/ui/IconKey";
import { Note } from "~/ui/Note";
import { HrefLink } from "~/ui/Pagination";
import { isPlatform, type Platform } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { revealProps } from "~/ui/reveal";
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

/**
 * A kit shelf on this area's pages: its rail keeps a card focused with Tab in view (the kit's does not yet; requested).
 * `reveal`: the shelf fades up as it first arrives (v2.1 G6 — below the fold only; the engine skips anything on screen).
 */
export function KeepInView({ className, reveal = false, children }: { className?: string; reveal?: boolean; children: ReactNode }) {
  return (
    <div className={cx("min-w-0", className)} onFocus={keepInView} {...(reveal ? revealProps() : {})}>
      {children}
    </div>
  );
}

/** The layout's navigation data (platforms with their devices, departments with their kinds). */
export function useShellNav() {
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData | null } | undefined;
  return layout?.shell?.nav ?? null;
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

// ───────────────────────────────────────────────────────────────── icons (v2.1 G4: kind icons, device glyphs)

/** A department kind (categories.kind — the navigation group) → its kind icon. VR has no kind glyph: the sprite's eye. */
const KIND_ICON: Readonly<Record<string, IconName>> = {
  consoles: "kind-console",
  handhelds: "device-handheld",
  games: "kind-game",
  controllers: "kind-controller",
  headsets: "kind-headset",
  storage: "kind-storage",
  charging: "kind-charging",
  accessories: "kind-accessory",
  vr: "eye",
  digital: "kind-topup",
  parts: "kind-repair",
  used: "kind-used",
  repair: "kind-repair",
};

/** A department staff added under a kind the map does not know: its slug's words decide (else the grid). */
const SLUG_HINTS: readonly (readonly [RegExp, IconName])[] = [
  [/handheld/, "device-handheld"],
  [/console/, "kind-console"],
  [/game/, "kind-game"],
  [/controller|gamepad|joy-?con/, "kind-controller"],
  [/headset|headphone|audio/, "kind-headset"],
  [/storage|ssd|memory|micro-?sd/, "kind-storage"],
  [/charg|power|battery/, "kind-charging"],
  [/gift|subscription|digital|top-?up/, "kind-topup"],
  [/(^|-)vr(-|$)|virtual/, "eye"],
  [/part|repair|spare/, "kind-repair"],
  [/used/, "kind-used"],
  [/access/, "kind-accessory"],
];

/** A department's kind icon from its kind, else its slug. */
export function kindIconOf(slug: string, kind?: string | null): IconName {
  if (kind && KIND_ICON[kind]) return KIND_ICON[kind];
  for (const [pattern, icon] of SLUG_HINTS) if (pattern.test(slug)) return icon;
  return "squares-four";
}

/** A platform's device silhouette (never a logo — the owner has not given logo rights, DESIGN.md §14). */
export const deviceGlyph = (platform: Platform): IconName => `device-${platform}`;

/**
 * Each department's kind icon, by slug: the navigation's kinds (a sub-department belongs to its parent's kind), then
 * the slug's words. The layout's shell data carries the tree on every storefront page.
 */
export function useKindIcon(): (slug: string) => IconName {
  const nav = useShellNav();
  const kinds = new Map<string, string>();
  const walk = (categories: readonly NavCategory[]) => {
    for (const category of categories) {
      kinds.set(category.slug, category.kind);
      for (const child of category.children) kinds.set(child.slug, category.kind);
    }
  };
  walk(nav?.categories ?? []);
  return (slug) => kindIconOf(slug, kinds.get(slug));
}

/**
 * A chip's words with its icon at the chip's start (v2.1: the before's bolder icons). The kit's chip isolates its words
 * in the direction they need (BidiLabel): a Latin label on an Arabic page is a left-to-right island, so there the icon
 * follows the words to stand at the chip's start. A chosen chip shows its check instead (catalog.css). `gel`: the
 * icon in that platform's colour (the device glyph of a platform chip).
 */
export function ChipLabel({ icon, gel, children }: { icon?: IconName | null; gel?: Platform | null; children: string }) {
  const dir = useDir();
  if (!icon) return <>{children}</>;
  const after = dir === "rtl" && !hasRtl(children);
  const glyph = <Icon name={icon} size={18} className={cx("catalog-chip__icon", after && "catalog-chip__icon--after", gel && "catalog-chip__icon--plat")} data-gel={gel ?? undefined} />;
  return after ? (
    <>
      {children}
      {glyph}
    </>
  ) : (
    <>
      {glyph}
      {children}
    </>
  );
}

// ───────────────────────────────────────────────────────────────── the platform band

export type HubBandProps = {
  platform: Platform;
  /** The platform's name in the design system's words ("PlayStation", «الأجهزة المحمولة»). */
  title: string;
  /** «42 منتجاً». */
  count: string;
  /**
   * The delivery (and cash-on-delivery) line; null when unknown. Below 1024 only (from there the shell's strip says it):
   * in the band from 768, a quiet line with its icon under the band on phones.
   */
  lead: string | null;
  /** The platform's lead device photo (a cut-out). */
  art: string | null;
  crumbs: Crumb[];
};

/**
 * The platform hub's head: breadcrumbs (from 768), then the band — glossy platform-colour glass (the kit's
 * `.band--platform`: the platform's colour with its specular edge in light, its deep colour glass with a rim light in
 * dark), the device glyph on a clay disc beside the white h1, the count and the lead line, the hardware at the inline
 * end standing on its contact shadow and breaking out of the top — and the platform's colour light on the floor around
 * it (`.glow` in the platform's `data-gel`), so the glass has something to show.
 *
 * Phones: the band holds the name and the count only, like the reference's glossy platform tiles; the delivery line is
 * the kit's quiet line under it (catalog review, wave B: inside the band its two lines ran into the wide hardware —
 * Switch 2, Steam Deck — at 360–390 in every language).
 */
export function HubBand({ platform, title, count, lead, art, crumbs }: HubBandProps) {
  return (
    <div className="catalog-head" data-gel={platform}>
      <Breadcrumbs items={crumbs} />
      <div className="catalog-band-glow glow glow--wide glow--strong">
        <Band
          kind="platform"
          platform={platform}
          as="header"
          className="catalog-band"
          mediaClassName="catalog-band__media"
          contentClassName="catalog-band__content"
          // decorative, like the platform tiles' hardware: never preloaded — the first product card is the page's LCP
          // and takes the one priority slot (ListingView)
          media={art ? <Render name={art} alt="" sizes="(min-width: 1024px) 300px, 40vw" /> : undefined}
          contact={Boolean(art)}
          data-motion-anchor=""
        >
          <div className="catalog-band__name">
            <span className="clay-disc catalog-band__glyph" aria-hidden="true">
              <Icon name={deviceGlyph(platform)} size={24} />
            </span>
            <h1 className="type-h1 catalog-band__title">
              <bdi>{title}</bdi>
            </h1>
          </div>
          <p className="catalog-band__count nums">{count}</p>
          {lead ? (
            <p className="catalog-band__lead">
              <Icon name="truck" size={18} />
              <span>{lead}</span>
            </p>
          ) : null}
        </Band>
      </div>
      {/* phones only (catalog.css): the same line, quiet, under the band */}
      {lead ? (
        <Note variant="line" icon="truck" className="catalog-band-note">
          {lead}
        </Note>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── the glass head (category hubs, search, compare)

export type TitleRowProps = {
  crumbs?: Crumb[];
  title: ReactNode;
  count?: string | null;
  /** The delivery line (below 1024: from there the shell's strip says it). */
  lead?: string | null;
  /** The icon tile at the head's start: the department's kind icon, the search glass, the scales. */
  icon?: IconName | null;
  /** The department's photo at the head's end (a warm well), when it has one. */
  art?: string | null;
  /** One platform's department: its colour light behind the glass. */
  gel?: Platform | null;
  children?: ReactNode;
};

/**
 * The head of a category hub, of search results, of the search start and of compare (v2.1: the same family as the
 * platform band, calmer): breadcrumbs (from 768), then a frosted glass card over a soft colour light (brand red; a
 * one-platform department its platform's) — the reference's icon tile (a clay square with the red line icon) at the
 * start, the h1, the count and the delivery line, and the department's photo in a warm well at the end. Anything else
 * the page puts under the title (the field and its suggestions, the corrected spelling, the jumps, compare's intro)
 * runs across the whole card under them.
 */
export function TitleRow({ crumbs, title, count, lead, icon, art, gel, children }: TitleRowProps) {
  return (
    <header className="catalog-title">
      {crumbs ? <Breadcrumbs items={crumbs} /> : null}
      <div className="catalog-title__glow glow glow--wide" data-gel={gel ?? undefined}>
        <div className={cx("catalog-title__card surface--glass", icon && "catalog-title__card--icon", art && "catalog-title__card--art")}>
          {icon ? (
            <span className="catalog-title__icon" aria-hidden="true">
              <Icon name={icon} size={28} />
            </span>
          ) : null}
          <div className="catalog-title__text">
            <h1 className="type-h1 text-ink">{title}</h1>
            {count || lead ? (
              <p className="catalog-title__line">
                {count ? <span className="nums text-ink">{count}</span> : null}
                {count && lead ? (
                  <span aria-hidden="true" className="catalog-title__sep">
                    {" · "}
                  </span>
                ) : null}
                {lead ? <span className="catalog-title__lead">{lead}</span> : null}
              </p>
            ) : null}
          </div>
          {art ? (
            <span className="catalog-title__art" aria-hidden="true">
              <span className="render-slot absolute inset-[10%]">
                <Render name={art} alt="" sizes="(min-width: 768px) 104px, 72px" />
              </span>
            </span>
          ) : null}
          {children ? <div className="catalog-title__more">{children}</div> : null}
        </div>
      </div>
    </header>
  );
}

// ───────────────────────────────────────────────────────────────── the chip row

export type RailOption = { value: string; label: string; count: number; platform?: Platform; icon?: IconName | null };

/**
 * One chip per option plus «الكل»; each is a link to the list with that choice (chosen = ink, aria-current, the check
 * in place of its icon). v2.1: every chip carries its kind icon (a platform chip its device glyph in the platform's
 * colour). One row that scrolls sideways on phones (the gutter kept), wrapping from 768. Nothing for fewer than two
 * options.
 */
export function ChipRow({ label, options, selected, allCount, hrefFor }: { label: string; options: RailOption[]; selected: string | null; allCount: number; hrefFor: (value: string | null) => string }) {
  const t = useT("catalog");
  if (options.length < 2 && selected === null) return null;
  return (
    <nav aria-label={label} className="min-w-0" onFocus={keepInView}>
      <div className="chips chips--rail chips--bleed catalog-chips">
        <Chip as={HrefLink} to={hrefFor(null)} selected={selected === null} count={allCount}>
          <ChipLabel icon="squares-four">{t("hub.all")}</ChipLabel>
        </Chip>
        {options.map((option) => (
          <Chip key={option.value} as={HrefLink} to={hrefFor(option.value)} selected={selected === option.value} count={option.count}>
            <ChipLabel icon={option.icon ?? (option.platform ? deviceGlyph(option.platform) : null)} gel={option.platform}>
              {option.label}
            </ChipLabel>
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

// ───────────────────────────────────────────────────────────────── the device row

/**
 * "Everything about your device" — the before's row of soft device tiles (client note 4), each a link to its device
 * hub (/device/<model>, the devices area): the kit's raised category tile with the device's picture on the warm well
 * and its name under it. One row at every width that scrolls sideways (snapping, the gutter kept on phones). From 1024
 * the row is compact (lead decision 3, catalog.css): the title and its note on one line, the tiles 56px clay pills with
 * the picture beside the name, and — where it holds more than fit — two 44px clay arrows at its end move it a tile at a
 * time (and ← → work on the row, the engine's useRail). `names="short"` (a platform hub, its name in the band): "PS5
 * Pro", the full name as the tile's title. Each tile's picture is the shared element `device-image:<slug>`: it grows
 * into the device hub's stage.
 */
export function DeviceRow({
  devices,
  title,
  note,
  id,
  slot,
  names = "full",
  headingLevel = 2,
  reveal = false,
  className,
}: {
  devices: DeviceShortcut[];
  title: string;
  note: string;
  id: string;
  slot: string;
  names?: "short" | "full";
  headingLevel?: 2 | 3;
  /** Below the list: fade up as it first arrives. Never on the first screen. */
  reveal?: boolean;
  className?: string;
}) {
  const t = useT("catalog");
  const rail = useRail<HTMLUListElement>();
  const row = rail.props.ref;
  const [ends, setEnds] = useState<{ overflow: boolean; start: boolean; end: boolean }>({ overflow: false, start: true, end: false });
  const measured = useRef("");
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => {
      const span = element.scrollWidth - element.clientWidth;
      const travelled = Math.abs(element.scrollLeft);
      const next = { overflow: span > 1, start: travelled <= 1, end: travelled >= span - 1 };
      const key = `${next.overflow}|${next.start}|${next.end}`;
      if (key === measured.current) return;
      measured.current = key;
      setEnds(next);
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [row, devices.length]);

  const Heading = `h${headingLevel}` as const;
  if (devices.length === 0) return null;
  return (
    <section aria-labelledby={id} className={cx("catalog-devices", className)} id="catalog-devices" {...(reveal ? revealProps() : {})}>
      <div className="catalog-devices__head">
        <div className="catalog-devices__text">
          <Heading id={id} className="catalog-devices__title">
            {title}
          </Heading>
          <p className="catalog-devices__note">{note}</p>
        </div>
        {ends.overflow ? (
          <div className="catalog-devices__keys">
            <IconKey icon="caret-left" label={t("hub.devicesPrev")} onClick={() => rail.step(false)} disabled={ends.start} />
            <IconKey icon="caret-right" label={t("hub.devicesNext")} onClick={() => rail.step(true)} disabled={ends.end} />
          </div>
        ) : null}
      </div>
      <ul ref={row} role="list" className="catalog-devices__rail" onFocus={keepInView}>
        {devices.map((device) => {
          const shown = names === "short" && device.short ? device.short : device.name;
          return (
            <li key={device.slug} className="catalog-devices__item">
              <CategoryTile
                as={MotionLink}
                nav="zoom"
                to={`/device/${device.slug}`}
                title={shown !== device.name ? device.name : undefined}
                className="catalog-device"
                label={<span className="catalog-device__name">{shown}</span>}
                art={
                  <SharedElement name={`device-image:${device.slug}`} slot={slot} as="span" className="render-slot absolute inset-[12%]">
                    {device.artKey ? <Render name={device.artKey} alt="" sizes="(min-width: 1024px) 48px, (min-width: 768px) 18vw, 30vw" /> : null}
                  </SharedElement>
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Listed used units of the platform (≥ 3; the used area's marketplace has the rest). Fades up as it arrives. */
export function UsedShelf({ units, title, reason, href, viewAll, className }: { units: UsedUnitCardData[]; title: string; reason: string; href: string; viewAll: string; className?: string }) {
  return (
    <KeepInView className={className} reveal>
      <ShelfRail shelf={{ key: "used", title, reason, items: units }} href={href} viewAllLabel={viewAll} renderItem={(unit) => <UsedUnitCard unit={unit} slot="used" headingLevel={3} />} />
    </KeepInView>
  );
}
