import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";

import { Art } from "~/art/Art";
import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import type { Platform } from "./PlatformLed";

/**
 * The platform tile — Design System v2 §4.19; v2.1 (DESIGN.md §15.3, client note 3): one of the four doors of the
 * store as VIVID GLOSSY GLASS in both themes (never a grey cabinet): a radial from a lighter tint at the hardware's
 * corner through the platform colour to its deep colour, a white rim and a specular band above the words, a coloured
 * glow on the floor, on a 2px --plat-*-deep wall. White words where the face is the flat colour or deeper (≥ 4.8:1),
 * the hardware at the inline end with one white radial behind it only (never behind the text).
 *
 *   <PlatformTiles>
 *     {platforms.map((p) => <PlatformTile key={p.slug} platform={p.slug} to={`/platform/${p.slug}`} count={p.count} art={p.tileArt} />)}
 *   </PlatformTiles>
 *   <PlatformTile compact platform="xbox" to="/platform/xbox" count={28} art="xbox-series-x--1" />   categories sheet, 404
 *   <PlatformTile as="button" type="button" platform="xbox" selected={on} onClick={toggle} … />   a toggle (the intro)
 *
 * Phones: 2×2, the hardware standing 18px above the tile and the words under it; the words never run into the
 * hardware — a name on two lines («الأجهزة المحمولة») makes its row taller instead. 768–1023: the same composition at
 * the tablet size (the hardware above, the words below) — beside the name, as the spec drew it, the PS5 Slim's white
 * body sat under «PlayStation» (1.48:1) on tiles narrower than ~200px. From 1024: the words at the top start (at most
 * 48% of the tile), the hardware bleeding past the inline end, an arrow disc at the bottom start. Hover (pointer): the
 * cap rises 2px, the hardware 4px and 1.02 on the inflate spring; press: the cap travels onto its wall. Focus: the
 * universal ring outside the tile. The hardware is a 480w cut-out, lazy, `fetchpriority="low"`, never preloaded (the
 * hero image is the page's only preload).
 *
 * `selected` makes the tile a toggle (render it `as="button"`): `aria-pressed`, the cap held down on its wall, a ring
 * inside the face and a check disc at the top start — the state is never colour alone. A toggle has no arrow disc.
 */
export type PlatformTileProps<C extends ElementType = typeof LocaleLink> = {
  platform: Platform;
  /** Where the tile leads (a locale-less path), when `as` is the default LocaleLink. */
  to?: string;
  /** Visible name. Default: the platform's name (ui:platform.*). */
  name?: string;
  /** How many products it has («42 منتجاً»). Omit when unknown — never invented. */
  count?: number | null;
  /** A product photo key for the hardware ("playstation-5-slim--1"), or your own node. */
  art?: string | ReactNode;
  /** 96px tall, the hardware inside the tile (the categories sheet, the 404 page). */
  compact?: boolean;
  /** A toggle (pass `as="button"`): chosen or not. Leave undefined for a door (a link). */
  selected?: boolean;
  as?: C;
  className?: string;
} & Omit<ComponentPropsWithRef<C>, "as" | "className" | "children" | "name">;

/*
 * Below 1024 the hardware stands at the top inline end and the words sit under it. The stylesheet draws the phone
 * geometry; these utilities keep the words clear of the hardware (the cap's top padding reserves the hardware's band,
 * so a two-line name grows the tile instead of running under the picture) and bring the tablet tiles (768–1023) into
 * the same composition.
 */
const CAP_UNDER_HARDWARE = "max-md:pt-18 md:max-lg:justify-end md:max-lg:pt-24";
/*
 * The white sheen goes behind the hardware, never behind the words (§2.10c): below 1024 the hardware stands at the top,
 * so the sheen is centred near the top (24%, a 48% × 50% ellipse that is clear by 59% of the height) instead of at the
 * stylesheet's 62% — where it sat under the name and took «PlayStation» from 4.95:1 to 3.92:1 at 360. The dark
 * cabinet's platform light (the second layer) is unchanged.
 */
const SHEEN_BEHIND_HARDWARE =
  // lint-design: allow gel — this is the tile's own light layer (.ptile__light), the stylesheet's two layers restated
  "max-lg:[background:radial-gradient(48%_50%_at_calc(50%+26%*var(--dir))_24%,var(--tile-sheen),transparent_70%),radial-gradient(80%_95%_at_calc(50%+50%*var(--dir))_100%,rgb(var(--gel,var(--gel-brand))/var(--tile-gel-a)),transparent_72%)]";
/* on the hardware layer, so a picture the caller draws itself (`art` as a node: an <img class="ptile__img">) follows too
   (`[&_img]`: an underscore inside a utility's brackets is a space, so the class name cannot be written there) */
const HARDWARE_ABOVE_WORDS =
  "md:max-lg:[&_img]:end-2.5 md:max-lg:[&_img]:top-[-18px] md:max-lg:[&_img]:bottom-auto md:max-lg:[&_img]:h-[106px] md:max-lg:[&_img]:w-[calc(100%-20px)]";

export function PlatformTile<C extends ElementType = typeof LocaleLink>({ platform, to, name, count, art, compact = false, selected, as, className, ...rest }: PlatformTileProps<C>) {
  const t = useT("ui");
  const shop = useT("ui-shop");
  const f = useFormat();
  const Tag: ElementType = as ?? LocaleLink;
  const label = name ?? t(`platform.${platform}`);
  const toggle = selected !== undefined;
  const hardware =
    typeof art === "string" ? <Art name={art} alt="" sizes="(min-width: 1024px) 240px, (min-width: 768px) 20vw, 40vw" fetchPriority="low" className="ptile__img" /> : art;
  const counted = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  return (
    <Tag
      {...rest}
      to={to}
      className={cx("ptile", compact && "ptile--compact", toggle && "text-start", className)}
      data-gel={platform}
      data-press="clay"
      aria-pressed={toggle ? selected : undefined}
    >
      <span
        className={cx(
          "ptile__cap",
          !compact && CAP_UNDER_HARDWARE,
          // chosen: held on its wall, ringed inside the face (white on the colour, ink in the dark cabinet)
          selected && "translate-y-(--wall) outline-3 -outline-offset-7 outline-current",
        )}
      >
        <span className={cx("ptile__light", !compact && SHEEN_BEHIND_HARDWARE)} aria-hidden="true" />
        <span className="ptile__text">
          <span className="ptile__name">
            <BidiLabel>{label}</BidiLabel>
          </span>
          {counted ? <span className="ptile__count">{shop("tile.count", { count, n: f.number(count) })}</span> : null}
        </span>
        {hardware ? (
          <span className={cx("ptile__hw", !compact && HARDWARE_ABOVE_WORDS)} aria-hidden="true">
            {hardware}
          </span>
        ) : null}
        {toggle ? (
          <span
            // the free corner: the top start below 1024 (the words sit at the bottom), the arrow disc's bottom-start
            // place from 1024 (the words sit at the top there)
            className={cx(
              "absolute start-2.5 top-2.5 z-1 grid size-8 place-items-center rounded-full bg-on-color text-[var(--on-white)] transition-[opacity,scale] duration-(--t-micro) lg:start-[22px] lg:top-auto lg:bottom-[18px] lg:size-10",
              selected ? "scale-100 opacity-100" : "scale-60 opacity-0",
            )}
            aria-hidden="true"
          >
            <Icon name="check" size={20} />
          </span>
        ) : compact ? null : (
          <span className="ptile__go" aria-hidden="true">
            <Icon name="arrow-right" size={20} />
          </span>
        )}
      </span>
    </Tag>
  );
}

/** The grid: 2×2 on phones (room above the second row for the hardware), four in a row from 768. */
export function PlatformTiles({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <nav className={cx("ptiles", className)} aria-label={label}>
      {children}
    </nav>
  );
}
