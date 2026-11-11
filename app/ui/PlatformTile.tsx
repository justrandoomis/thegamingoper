import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";

import { Art } from "~/art/Art";
import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import type { Platform } from "./PlatformLed";

/**
 * The platform tile — Design System v2 §4.19: the second clay object (a flat --plat-* face on a 2px --plat-*-deep wall)
 * and one of the four doors of the store. White words on the solid colour (4.80–6.65:1), the hardware at the inline end
 * with one white radial behind it only (never behind the text); in the dark theme a lit cabinet with the platform's
 * light behind the hardware and ink words.
 *
 *   <PlatformTiles>
 *     {platforms.map((p) => <PlatformTile key={p.slug} platform={p.slug} to={`/platform/${p.slug}`} count={p.count} art={p.tileArt} />)}
 *   </PlatformTiles>
 *   <PlatformTile compact platform="xbox" to="/platform/xbox" count={28} art="xbox-series-x--1" />   categories sheet, 404
 *
 * Phones: 2×2, the hardware standing 18px above the tile; from 768 four in a row, the hardware bleeding past the inline
 * end; from 1024 an arrow disc at the bottom start. Hover (pointer): the cap rises 2px, the hardware 4px and 1.02 on
 * the inflate spring; press: the cap travels onto its wall. Focus: the universal ring outside the tile. The hardware is
 * a 480w cut-out, lazy, `fetchpriority="low"`, never preloaded (the hero image is the page's only preload).
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
  as?: C;
  className?: string;
} & Omit<ComponentPropsWithRef<C>, "as" | "className" | "children" | "name">;

export function PlatformTile<C extends ElementType = typeof LocaleLink>({ platform, to, name, count, art, compact = false, as, className, ...rest }: PlatformTileProps<C>) {
  const t = useT("ui");
  const shop = useT("ui-shop");
  const f = useFormat();
  const Tag: ElementType = as ?? LocaleLink;
  const label = name ?? t(`platform.${platform}`);
  const hardware =
    typeof art === "string" ? <Art name={art} alt="" sizes="(min-width: 1024px) 240px, (min-width: 768px) 20vw, 40vw" fetchPriority="low" className="ptile__img" /> : art;
  const counted = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  return (
    <Tag {...rest} to={to} className={cx("ptile", compact && "ptile--compact", className)} data-gel={platform} data-press="clay">
      <span className="ptile__cap">
        <span className="ptile__light" aria-hidden="true" />
        <span className="ptile__text">
          <span className="ptile__name">
            <BidiLabel>{label}</BidiLabel>
          </span>
          {counted ? <span className="ptile__count">{shop("tile.count", { count, n: f.number(count) })}</span> : null}
        </span>
        {hardware ? (
          <span className="ptile__hw" aria-hidden="true">
            {hardware}
          </span>
        ) : null}
        {compact ? null : (
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
