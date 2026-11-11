import type { CSSProperties, ReactNode } from "react";

import { useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";

/**
 * The platform cue (docs/DESIGN.md §0 law 3, §6.4). A platform exists only as a coloured light: the glow on a
 * stage and this 16 × 5 LED, ALWAYS beside the platform's name written as text. Platform colour is never a
 * surface, a border, a button colour or a card tint, and no official logo is drawn anywhere.
 *
 *   <PlatformLabel platform="playstation" />                       LED + "PlayStation"
 *   <PlatformLabel platform="handheld" label={category.name} />    LED + your own text
 *   <PlatformLed platform="xbox" solid />                          the LED alone (the name must be right beside it)
 *   <PlatformGlyph platform="nintendo" />                          neutral device pictogram for platform keys
 *
 * `data-gel` sets `--gel` for a whole subtree: put it on a stage, a key or a nav link and every LED inside lights
 * in that platform's colour.
 */
export const PLATFORMS = ["nintendo", "playstation", "xbox", "handheld"] as const;
export type Platform = (typeof PLATFORMS)[number];
/** A light colour: one of the platforms, or "brand" (store-wide campaigns only). */
export type Gel = Platform | "brand";

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export type PlatformLedProps = {
  /** Omit to inherit the light of the surrounding `data-gel` subtree. */
  platform?: Gel;
  /** Full brightness (nav links, product meta). Default: half, like an idle key. */
  solid?: boolean;
  /** Lit with a glow — the chosen platform. Keys with aria-checked/aria-pressed light their LED by themselves. */
  on?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function PlatformLed({ platform, solid = false, on = false, className, style }: PlatformLedProps) {
  return <i className={cx("led", solid && "led--solid", on && "is-on", className)} data-gel={platform} style={style} aria-hidden="true" />;
}

export type PlatformLabelProps = {
  platform: Gel;
  /** Visible name. Default: the platform's own name (Latin brand names stay Latin; "handheld" is translated). */
  label?: string;
  /** Show the device pictogram after the LED. */
  glyph?: boolean;
  className?: string;
};

export function PlatformLabel({ platform, label, glyph = false, className }: PlatformLabelProps) {
  const t = useT("ui");
  const text = label ?? (platform === "brand" ? "" : t(`platform.${platform}`));
  return (
    <span className={cx("plat", className)} data-gel={platform}>
      <PlatformLed solid />
      {glyph && platform !== "brand" ? <PlatformGlyph platform={platform} size={18} className="plat__glyph" /> : null}
      <BidiLabel>{text}</BidiLabel>
    </span>
  );
}

/** Neutral device silhouettes (never logos), so a platform is recognisable without reading Latin (§4). */
const GLYPHS: Record<Platform, ReactNode> = {
  nintendo: (
    <>
      <rect x="2.6" y="6.8" width="18.8" height="10.4" rx="3.2" />
      <path d="M7.4 6.8v10.4M16.6 6.8v10.4" />
    </>
  ),
  playstation: (
    <>
      <path d="M8.9 20 8 5.9c-.1-1.4.6-2.4 1.8-2.4h4.4c1.2 0 1.9 1 1.8 2.4L15.1 20" />
      <path d="M12 3.5V20M6.2 20.4h11.6" />
    </>
  ),
  xbox: (
    <>
      <path d="M7 6.4 12 4l5 2.4v11.4L12 20.4l-5-2.6z" />
      <path d="M7 6.4l5 2.5 5-2.5M12 8.9v11.5" />
    </>
  ),
  handheld: (
    <>
      <rect x="2.4" y="6.9" width="19.2" height="10.2" rx="3.6" />
      <rect x="7.5" y="9.1" width="9" height="5.8" rx="1" />
      <path d="M4.9 10.6h.2M18.9 13.4h.2" />
    </>
  ),
};

export function PlatformGlyph({ platform, size = 22, className }: { platform: Platform; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cx("shrink-0", className)}
    >
      {GLYPHS[platform]}
    </svg>
  );
}
