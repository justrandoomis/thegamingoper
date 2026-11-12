import type { CSSProperties } from "react";

import { useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";

/**
 * The platform dot — Design System v2 §2.4, §4.19. Platform colour is a SURFACE in four places only (the platform
 * tiles, the hub band, the device-hub head, a platform campaign on the hero — ./PlatformTile, ./Band). Everywhere else
 * a platform is an 8px dot in `--dot-*` beside its name written as text (nav, chips, cards, mega menu, filters,
 * compare, admin columns). No drawn platform logos.
 *
 *   <PlatformLabel platform="playstation" />                       dot + "PlayStation" (13/600, ink-2)
 *   <PlatformLabel platform="handheld" label={category.name} />    dot + your own text
 *   <PlatformLed platform="xbox" />                                the dot alone — the name must be right beside it
 *
 * `data-gel` sets `--dot` (and `--plat`, `--plat-deep`, `--gel`) for a whole subtree: put it on a tile, a band or a nav
 * link and every dot inside takes that platform's colour. Dark mode uses the lighter dark-theme dots by itself.
 * 1.0: `solid` and `on` are accepted and ignored (a dot has one brightness). The 1.0 pictograms (`PlatformGlyph`) are
 * gone (§4.2, stage 4): platforms are recognised by name, colour and real photos.
 */
export const PLATFORMS = ["nintendo", "playstation", "xbox", "handheld"] as const;
export type Platform = (typeof PLATFORMS)[number];
/** A platform, or "brand" (store-wide campaigns only). */
export type Gel = Platform | "brand";

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export type PlatformLedProps = {
  /** Omit to take the colour of the surrounding `data-gel` subtree. */
  platform?: Gel;
  /** 1.0 — ignored. */
  solid?: boolean;
  /** 1.0 — ignored. */
  on?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function PlatformLed({ platform, className, style }: PlatformLedProps) {
  return <i className={cx("led", className)} data-gel={platform} style={style} aria-hidden="true" />;
}

export type PlatformLabelProps = {
  platform: Gel;
  /** Visible name. Default: the platform's own name (Latin brand names stay Latin; "handheld" is translated). */
  label?: string;
  /** 1.0 — ignored (pictograms are retired). */
  glyph?: boolean;
  className?: string;
};

export function PlatformLabel({ platform, label, className }: PlatformLabelProps) {
  const t = useT("ui");
  const text = label ?? (platform === "brand" ? "" : t(`platform.${platform}`));
  return (
    <span className={cx("plat", className)} data-gel={platform}>
      <PlatformLed />
      <BidiLabel>{text}</BidiLabel>
    </span>
  );
}
