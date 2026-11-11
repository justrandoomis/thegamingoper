import type { ComponentPropsWithRef, CSSProperties, ElementType, ReactNode } from "react";

import { cx } from "./cx";

/**
 * The product WELL — Design System v2 §2.10d, §4.11, §7: the one neutral ground every product a shopper judges stands
 * on (flat --niche in light, the neutral lit spot in dark), 1:1, --r-lg, the picture contained and bottom-aligned on
 * one floor line with a CSS contact ellipse under it. No border, no shadow, no platform light. Its colour is the
 * placeholder from the first paint (no grey skeleton).
 *
 *   <Niche as="span" tag={<Tag kind="new" />} fav={<WishlistKey … onImage />}><Render name={art} alt="" /></Niche>
 *   <Niche kind="box">…cover…</Niche>              fit rules by kind: hardware (default) · wide · box · card · used
 *   <Niche fill><img … /></Niche>                  a used unit's own photo filling the well (cover)
 *   <Niche size="sm">…</Niche>                     a small well (cart lines, rows): --r-sm corners
 *   <Niche variant="panel">…</Niche>               1.0's info panel → a paper panel with a hairline
 *
 * Image fit (§7.3): hardware and accessories 9% / 8% / 9.5%; wide objects 14% / 7% / 16%; box art and digital cards at
 * 84% with the art shadow and no ellipse; used units with an illustration raised 10% so the «صورة توضيحية» tag never
 * covers them. `state="out"` dims the picture to 50% (sold out). 1.0's `tagZone` is accepted and ignored.
 */
export type NicheKind = "hardware" | "wide" | "box" | "card" | "used";

export type NicheOwnProps = {
  /** "card" (default): a well with a picture slot. "panel": a paper panel for content (1.0). */
  variant?: "card" | "panel";
  /** Fit rule of the picture. Default hardware. */
  kind?: NicheKind;
  /** Aspect ratio: 1:1 (default — cards, rows, thumbnails, category tiles), or any CSS ratio. */
  ratio?: string | number;
  /** The one badge, top-start. */
  tag?: ReactNode;
  /** The wishlist button, top-end (32px on the photo). */
  fav?: ReactNode;
  /** A corner note on the photo (the «صورة توضيحية» tag), bottom-start. */
  note?: ReactNode;
  /** Sold out: the picture at 50%. */
  state?: "out";
  /** sm: a small well (≤ 120px) with --r-sm corners. */
  size?: "md" | "sm";
  /** 1.0 — ignored (v2 reserves no tag zone). */
  tagZone?: boolean;
  /** Children fill the whole well (object-fit: cover) — real photos of used units. */
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

export type NicheProps<C extends ElementType = "div"> = NicheOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof NicheOwnProps | "as">;

export function Niche<C extends ElementType = "div">({
  as,
  variant = "card",
  kind,
  ratio = "1/1",
  tag,
  fav,
  note,
  state,
  size = "md",
  tagZone: _tagZone,
  fill = false,
  className,
  style,
  children,
  ...rest
}: NicheProps<C>) {
  const Tag: ElementType = as ?? "div";
  if (variant === "panel") {
    return (
      <Tag {...rest} className={cx("niche niche--panel", className)} style={style}>
        {children}
      </Tag>
    );
  }
  const ratioValue = typeof ratio === "number" ? String(ratio) : ratio.replace("/", " / ");
  return (
    <Tag
      {...rest}
      className={cx("niche", size === "sm" && "niche--sm", className)}
      data-kind={kind && kind !== "hardware" ? kind : undefined}
      data-state={state}
      style={ratioValue === "1 / 1" ? style : ({ "--ratio": ratioValue, ...style } as CSSProperties)}
    >
      {fill ? <span className="niche__fill">{children}</span> : <span className="niche__slot render-slot">{children}</span>}
      {tag ? <span className="niche__tag">{tag}</span> : null}
      {note ? <span className="absolute start-2.5 bottom-2.5 z-2 flex">{note}</span> : null}
      {fav ? <span className="niche__fav">{fav}</span> : null}
    </Tag>
  );
}
