import type { ComponentPropsWithRef, CSSProperties, ElementType, ReactNode } from "react";

import { cx } from "./cx";

/**
 * The niche (docs/DESIGN.md §6.3, §9.5): THE flat card surface — no border, no shadow, no gradient, no material.
 * Its colour is the image placeholder (the space and the colour are there from the first paint, so nothing shifts
 * and there is no grey skeleton). The same object as the stage, without light.
 *
 *   Product card image (3:2, tag zone top-start, render slot from 30px down)
 *     <Niche as={MotionLink} nav="zoom" to={`/p/${slug}`} aria-label={name} tag={<Tag kind="new" />}>
 *       <Render name={art} alt="" />
 *     </Niche>
 *   Category card (1:1, never a tag)            <Niche ratio="1/1" tagZone={false}>…</Niche>
 *   Used device: a real photo filling the niche <Niche fill><img src={photo} width={…} height={…} alt={…} /></Niche>
 *   Info panel / empty state (no aspect ratio)  <Niche variant="panel" className="flex items-center gap-3 p-3">…</Niche>
 *
 * Exactly one tag per card, and it states a fact. Cards in lists carry no light and no glass.
 */
export type NicheOwnProps = {
  /** "card" (default): an image niche with an aspect-ratio slot. "panel": a flat tonal panel for content. */
  variant?: "card" | "panel";
  /** Aspect ratio of a card niche: "3/2" (default, product cards), "1/1" (category cards), or any CSS ratio. */
  ratio?: string | number;
  /** The one tag, placed top-start in its reserved zone. */
  tag?: ReactNode;
  /** Keep the 30px tag zone above the render (default true; category cards never have tags). */
  tagZone?: boolean;
  /** Children fill the whole niche (object-fit: cover) — real photos of used units. */
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

export type NicheProps<C extends ElementType = "div"> = NicheOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof NicheOwnProps | "as">;

export function Niche<C extends ElementType = "div">({ as, variant = "card", ratio = "3/2", tag, tagZone = true, fill = false, className, style, children, ...rest }: NicheProps<C>) {
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
    <Tag {...rest} className={cx("niche", !tagZone && "niche--untagged", className)} style={{ "--ratio": ratioValue, ...style } as CSSProperties}>
      {tag ? <span className="niche__tag">{tag}</span> : null}
      {fill ? <span className="niche__fill">{children}</span> : <span className="niche__slot render-slot">{children}</span>}
    </Tag>
  );
}
