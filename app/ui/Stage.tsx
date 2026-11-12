import { useState, type CSSProperties, type ReactNode } from "react";

import { Art } from "~/art/Art";
import { artAspect, parseArtName, type ArtView } from "~/art";
import { cx } from "./cx";
import type { Gel } from "./PlatformLed";

/**
 * The product stage — Design System v2 §2.10d, §4.14: the product page's picture on the neutral product ground, bigger.
 * Straight (no tilt), no halo, no pool, no platform light behind a product that is being judged, no glass tag.
 *
 *   <Stage size="pdp" count="1 من 6" tools={<IconKey icon="arrows-out" … variant="onImage" />}>
 *     <Render name="nintendo-switch-2--1" alt="…" priority sizes="(min-width: 1024px) 714px, 100vw" />
 *   </Stage>
 *
 * `pdp`: 1:1 and full bleed below 768, 4:3 with --r-xl from 768, 5:4 from 1024; the image box is inset 8% / 6% / 9%,
 * contained and bottom-aligned on the floor line with the contact ellipse. Inside the stage only the counter chip
 * (bottom-start) and the tools (top-end). ./Gallery builds the product page's stage with thumbnails below it.
 *
 * 1.0 sizes keep their geometry until their areas move to ./Band (hero, hubs, the mega menu's featured tile): `hero`,
 * `product`, `compact` render the same neutral ground; `gel` is accepted and ignored; `tag` and `action` still hang
 * off the rim. 1.0's glass price tag (`StageTag`) is gone (§4.2, stage 4): the price sits beside the action.
 */
export type StageSize = "pdp" | /* 1.0 */ "hero" | "product" | "compact";

export type StageProps = {
  size?: StageSize;
  /** 1.0 — ignored: no platform light behind a product that is being judged. */
  gel?: Gel | null;
  /** The render(s) — usually one <Render>. */
  children?: ReactNode;
  /** pdp: the counter chip «1 من 6», bottom-start. */
  count?: ReactNode;
  /** pdp: icon buttons at the top-end (the full-screen button). */
  tools?: ReactNode;
  /** 1.0: hangs off the rim (the retired price tag). */
  tag?: ReactNode;
  /** 1.0: the key on the rim. */
  action?: ReactNode;
  /** 1.0: chrome inside the stage along its top edge. */
  top?: ReactNode;
  /** 1.0: inside the stage along its bottom edge. */
  bottom?: ReactNode;
  /** 1.0: square top corners. */
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function Stage({ size = "pdp", children, count, tools, tag, action, top, bottom, flush = false, className, style }: StageProps) {
  if (size === "pdp") {
    return (
      <div className={cx("stage stage--pdp", className)} style={style}>
        {/* the object at 8% / 6% / 9% from the stage's edges (§4.14, §7.3): the catalogue's cut-outs carry about 5% of
            transparent margin of their own, so the image box is inset 4% / 2% / 5% — the product then covers ≥60% of
            the stage (52% for Switch 2 at 390 with the box at 8% / 6% / 9%). An opaque photo has no margin of its own
            (and a plate in dark), so it keeps the box at 8% / 6% / 9%. */}
        <div className="stage__slot render-slot inset-[4%_2%_5%] has-[img[data-transparent=false]]:inset-[8%_6%_9%]">{children}</div>
        {count ? <span className="stage__count">{count}</span> : null}
        {tools ? <div className="stage__tools">{tools}</div> : null}
      </div>
    );
  }
  const band = tag || action;
  return (
    <div className={cx("stage-frame", className)} style={style}>
      <div className={cx("stage", `stage--${size}`, flush && "stage--flush")}>
        {top ? <div className="stage__top">{top}</div> : null}
        <div className="stage__slot render-slot">{children}</div>
        {bottom ? <div className="stage__bottom">{bottom}</div> : null}
      </div>
      {band ? (
        <div className="stage__band">
          {tag}
          {action}
        </div>
      ) : null}
    </div>
  );
}

export type RenderProps = {
  /** Art key ("nintendo-switch-2--1", "playstation-5-slim--2"). Unrendered keys show a neutral placeholder of the right shape. */
  name: string;
  view?: ArtView;
  /** What the picture shows, in the page's language; "" when the name is right next to it. */
  alt: string;
  /** `sizes` for the responsive picture — how wide it is drawn. */
  sizes?: string;
  /** Only the first picture above the fold (the page's LCP image). */
  priority?: boolean;
  /** 1.0 — ignored: products are never tilted (`--pose` is 0). */
  pose?: number;
  /** 1.0 — ignored: the contact ellipse belongs to the well or the stage (CSS). */
  shadow?: boolean;
  className?: string;
};

/**
 * One product photo in a box sized by its aspect ratio (from the art manifest), fitted inside the slot it sits in and
 * standing on the floor line — no per-product layout numbers, no tilt, no filter. Use inside <Stage>, <Niche> or a
 * thumbnail. A render whose `name` changes after the first paint inflates into its box; the first paint never animates.
 */
export function Render({ name, view, alt, sizes, priority = false, className }: RenderProps) {
  const target = parseArtName(name, view);
  const aspect = artAspect(target.key, target.view) ?? artAspect(target.key) ?? 1;
  const [first] = useState(name);
  const [changed, setChanged] = useState(false);
  if (!changed && name !== first) setChanged(true);
  const style = { "--aspect": aspect } as CSSProperties;
  return (
    <span key={name} className={cx("render", className)} style={style} data-enter={changed ? "" : undefined}>
      <Art name={target.key} view={target.view} alt={alt} sizes={sizes} priority={priority} />
    </span>
  );
}
