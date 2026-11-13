import type { ComponentPropsWithRef, CSSProperties, ElementType, ReactNode } from "react";

import { cx } from "./cx";
import type { Gel } from "./PlatformLed";

/**
 * The showcase band — Design System v2 §2.10c, §4.18: colour light belongs to showcases. In the light theme a band is a
 * colour surface (crimson, or a platform colour) with ONE radial light behind the hardware; in the dark theme it is a
 * lit cabinet (charcoal + rim + the brand's or platform's light behind the hardware and a floor pool). The copy never
 * sits on the light core; text on the band is solid white in light, ink / ink-2 in dark (set by the band).
 *
 *   <Band kind="hero" media={<Render name="nintendo-switch-2--1" alt="" priority />} contact>
 *     <h2 className="type-display">العب على<br /><bdi>Nintendo&nbsp;Switch&nbsp;2</bdi></h2>
 *     …price, <DemoNote variant="tag" what="price" onColor />, <Key variant="onBand">…</Key>
 *   </Band>
 *   <Band kind="platform" platform="playstation" as={LocaleLink} to="/platform/playstation" media={<img …/>}>…</Band>
 *   <Band kind="device" platform="nintendo" media={…}>…</Band>          the device-hub head
 *   <Band kind="wallet">…</Band>                                        crimson, no light (light) · cabinet (dark)
 *   <Band kind="wallet" gloss>…</Band>                                  the reference's glossy «محفظتي» card (v2.1)
 *
 * Anatomy: the base, a pre-painted light layer (pointer-events: none; only its opacity ever moves: .86 → 1 under the
 * pointer, dark only), a hardware layer clipped at the sides and the bottom only — so the hardware can stand above the
 * band's top edge and bleed off its inline end — and the copy. Focus rings inside a light-theme band are white.
 * Headline rule (§4.18): the Arabic line and the Latin name share one direction and edge — put the name in a <bdi>
 * after a <br />, never a separate `dir="ltr"` block.
 */
export type BandKind = "hero" | "platform" | "device" | "wallet";

export type BandOwnProps = {
  kind: BandKind;
  /** The platform of a platform band or device head (its surface, wall, dot and cabinet light). */
  platform?: Gel;
  /** The hardware layer (a cut-out). Placed at the inline end by default; `mediaClassName` places it yourself. */
  media?: ReactNode;
  mediaClassName?: string;
  /** Classes for the copy layer (the wrapper above the light and the hardware): its layout. */
  contentClassName?: string;
  /** The contact ellipse under the hero product. */
  contact?: boolean;
  /** wallet: the reference's glossy «محفظتي» card — the specular top band, a sheen at the inline end, the tiles' rim. */
  gloss?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

export type BandProps<C extends ElementType = "section"> = BandOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof BandOwnProps | "as">;

const KIND_CLASS: Record<BandKind, string> = {
  hero: "band--hero",
  platform: "band--platform",
  device: "band--device",
  wallet: "band--wallet",
};

/**
 * Where the hardware sits by default: the inline end, standing on the bottom edge (it may rise above the top). The
 * hero on phones: a 220px box at the top centre, so the copy starts below it (give the copy `max-md:pt-[230px]`) and
 * never sits on the product or its light.
 */
const MEDIA_CLASS: Record<BandKind, string> = {
  hero: "absolute inset-y-0 end-0 w-1/2 max-md:inset-x-0 max-md:bottom-auto max-md:h-[220px] max-md:w-auto",
  platform: "absolute -top-4 bottom-0 end-[-4%] w-[46%] lg:w-[40%]",
  device: "absolute -top-6 bottom-0 end-0 w-1/2",
  wallet: "hidden",
};

/** Clipped at the sides and the bottom only, so the hardware can break out of the top edge. */
const CLIP: Record<BandKind, string> = {
  hero: "[clip-path:inset(-56px_0_0_0_round_0_0_var(--r-xl)_var(--r-xl))]",
  platform: "[clip-path:inset(-56px_0_0_0_round_0_0_var(--r-lg)_var(--r-lg))]",
  device: "[clip-path:inset(-56px_0_0_0_round_0_0_var(--r-xl)_var(--r-xl))]",
  wallet: "",
};

export function Band<C extends ElementType = "section">({ as, kind, platform, media, mediaClassName, contentClassName, contact = false, gloss = false, className, style, children, ...rest }: BandProps<C>) {
  const Tag: ElementType = as ?? "section";
  return (
    <Tag {...rest} className={cx("band", KIND_CLASS[kind], gloss && "band--gloss", className)} data-gel={platform} data-band={kind} style={style}>
      <span className="band__light" aria-hidden="true" />
      {media ? (
        <span className={cx("pointer-events-none z-0", CLIP[kind], mediaClassName ?? MEDIA_CLASS[kind])}>
          <span className="render-slot absolute inset-0">{media}</span>
          {contact ? <span className="band__contact" aria-hidden="true" /> : null}
        </span>
      ) : contact ? (
        <span className="band__contact" aria-hidden="true" />
      ) : null}
      <div className={cx("relative z-1 min-w-0", contentClassName)}>{children}</div>
    </Tag>
  );
}
