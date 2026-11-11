import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { Art } from "~/art/Art";
import { artAspect, parseArtName, type ArtView } from "~/art";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { Glass } from "./Glass";
import type { Gel } from "./PlatformLed";
import { Price } from "./Price";

/**
 * The Lit Stage (docs/DESIGN.md §2, §6.4) — the signature. A product never stands on a podium or sits in a card:
 * its render floats (slight tilt, a contact shadow) on a flat tonal stage inside ONE pool of its platform's light.
 * A static-glass price tag hangs off the rim beside the one red key.
 *
 *   <Stage size="hero" gel="playstation"
 *          tag={<StageTag name="PlayStation 5 Pro" priceIqd={1099000} />}
 *          action={<Key variant="commit" icon={<AddGlyph />} onClick={add}>{t("add")}</Key>}>
 *     <Render name="playstation-5-pro--1" alt="PlayStation 5 Pro" priority sizes="(min-width: 1200px) 540px, 70vw" />
 *   </Stage>
 *
 *   <Stage size="product" gel="handheld" flush top={<Orbs />} bottom={<Gallery />}>…</Stage>
 *   <Stage size="compact" gel="xbox">…</Stage>                 hub header; text sits on the floor beside it
 *
 * Sizes: hero 194 → 452px (home), product 318 → 520px (product page; the key bank becomes the thumbnails),
 * compact 132 → 160px (hubs). Product cards use <Niche> — the same object without light.
 * Changing `gel` cross-fades two pre-painted light layers (opacity only); a new <Render name> inflates into its box.
 * Rules: one lit stage per screen on mobile; light only for clay renders (never used-device photos); `gel="brand"`
 * only for store-wide campaigns; text never sits on the light — only on the glass tag.
 */
export type StageSize = "hero" | "product" | "compact";

export type StageProps = {
  size?: StageSize;
  /** The light. `null` = an unlit stage. */
  gel?: Gel | null;
  /** The render(s) — usually one <Render>. */
  children?: ReactNode;
  /** Static-glass tag hanging off the rim (usually <StageTag>). */
  tag?: ReactNode;
  /** The commit key on the rim, beside the tag. */
  action?: ReactNode;
  /** Chrome inside the stage, along its top edge (back / cart orbs). */
  top?: ReactNode;
  /** Inside the stage along its bottom edge (gallery caption, thumbnails, count). */
  bottom?: ReactNode;
  /** Square top corners: a product stage that touches the top of the screen. */
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
};

type LightLayer = { id: number; gel: Gel; leaving: boolean; entering: boolean };

export function Stage({ size = "hero", gel = null, children, tag, action, top, bottom, flush = false, className, style }: StageProps) {
  const layers = useLightLayers(gel);
  const band = tag || action;
  return (
    <div className={cx("stage-frame", className)} style={style}>
      <div className={cx("stage", `stage--${size}`, flush && "stage--flush")} data-gel={gel ?? undefined}>
        {layers.map((layer) => (
          <div
            key={layer.id}
            className="stage__layer"
            data-gel={layer.gel}
            data-leaving={layer.leaving ? "" : undefined}
            data-entering={layer.entering ? "" : undefined}
            aria-hidden="true"
          >
            <div className="stage__light">
              <i className="stage__halo" />
              <i className="stage__spot" />
            </div>
            <i className="stage__pool" />
          </div>
        ))}
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

/** Pre-painted light layers: a new gel fades in over 260ms while the old one fades out (110ms), then is dropped. */
function useLightLayers(gel: Gel | null): LightLayer[] {
  const [state, setState] = useState<{ gel: Gel | null; layers: LightLayer[] }>(() => ({
    gel,
    layers: gel ? [{ id: 0, gel, leaving: false, entering: false }] : [],
  }));
  if (state.gel !== gel) {
    const nextId = (state.layers.at(-1)?.id ?? -1) + 1;
    const kept = state.layers.filter((layer) => !layer.leaving).map((layer) => ({ ...layer, leaving: true, entering: false }));
    setState({ gel, layers: gel ? [...kept, { id: nextId, gel, leaving: false, entering: true }] : kept });
  }
  const hasLeaving = state.layers.some((layer) => layer.leaving);
  useEffect(() => {
    if (!hasLeaving) return;
    const timer = setTimeout(() => {
      setState((current) => ({ ...current, layers: current.layers.filter((layer) => !layer.leaving) }));
    }, 140);
    return () => clearTimeout(timer);
  }, [hasLeaving, state.gel]);
  return state.layers;
}

export type StageTagProps = {
  /** Product name (Latin names stay Latin, isolated). */
  name: ReactNode;
  priceIqd: number;
  className?: string;
};

/**
 * The glass price tag on the stage's rim: name above, price below (flat ink; the dinar only). The name keeps to one
 * line of whole words; a seven-digit price steps down to 17px on a phone-width stage (`data-long`), so the commit key
 * beside it keeps its whole label (components.css, "the band").
 */
export function StageTag({ name, priceIqd, className }: StageTagProps) {
  return (
    <Glass variant="static" className={cx("gtag", className)} data-long={priceIqd >= 1_000_000 ? "" : undefined}>
      <span className="gtag__name">
        <BidiLabel>{name}</BidiLabel>
      </span>
      <Price amountIqd={priceIqd} size="lg" approx="off" as="span" />
    </Glass>
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
  /** Only the first picture above the fold (the home hero is the LCP element). */
  priority?: boolean;
  /** Tilt in degrees. Default: the container's (stage −3°, niche 0°). */
  pose?: number;
  /** The percent-based contact shadow under the object. Default on. */
  shadow?: boolean;
  className?: string;
};

/**
 * One clay render in a box sized by its aspect ratio (from the art manifest), fitted inside the slot it sits in —
 * no per-product layout numbers. Use inside <Stage>, <Niche> or a thumbnail key.
 * A render whose `name` changes after the first paint inflates into its box; the first paint never animates.
 */
export function Render({ name, view, alt, sizes, priority = false, pose, shadow = true, className }: RenderProps) {
  const target = parseArtName(name, view);
  const aspect = artAspect(target.key, target.view) ?? artAspect(target.key) ?? 1;
  const [first] = useState(name);
  const [changed, setChanged] = useState(false);
  if (!changed && name !== first) setChanged(true);
  const style = { "--aspect": aspect, ...(pose !== undefined ? { "--pose": `${pose}deg` } : null) } as CSSProperties;
  return (
    <span key={name} className={cx("render", !shadow && "render--flat", className)} style={style} data-enter={changed ? "" : undefined}>
      <Art name={target.key} view={target.view} alt={alt} sizes={sizes} priority={priority} />
    </span>
  );
}
