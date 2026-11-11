import { useEffect, type ComponentPropsWithRef, type ElementType } from "react";

import { cx } from "./cx";

/**
 * Glass — for the eye (docs/DESIGN.md §6.2). THE ONLY WAY to get backdrop-filter in this app
 * (scripts/lint-design.mjs fails any other backdrop-filter).
 *
 *   <Glass as="nav" edge="bottom" className="fixed inset-x-0 bottom-0 …">…tab bar…</Glass>     live frost
 *   <Glass variant="static" className="gtag">…price tag on a stage…</Glass>                     no blur
 *   <Glass variant="solid">…a third overlay while two live panes are up…</Glass>
 *
 * Rules: live glass only on FIXED or STICKY chrome that content really scrolls under — never on anything that
 * scrolls with the page or repeats in a list; at most two live panes in a viewport; always a rounded rectangle
 * (no mask, clip-path or SVG shape); never a wall, never red; blur, tint and shadow never animate. Static glass
 * only over smooth surfaces (floor, stage, light). Secondary text inside glass is automatically on-glass-2.
 * Reduced transparency, the low-end tier and missing backdrop-filter support all fall back to solid.
 */
export type GlassOwnProps = {
  /** live (default, frosted) · static (no blur, over smooth surfaces) · solid (opaque glass colour). */
  variant?: "live" | "static" | "solid";
  /** "bottom" for bars and sheets anchored to the bottom edge: their shadow is thrown upward. */
  edge?: "top" | "bottom";
  className?: string;
};

export type GlassProps<C extends ElementType = "div"> = GlassOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof GlassOwnProps | "as">;

export function Glass<C extends ElementType = "div">({ as, variant = "live", edge = "top", className, ...rest }: GlassProps<C>) {
  const Tag: ElementType = as ?? "div";
  useLiveGlassBudget(variant === "live");
  return <Tag {...rest} className={cx("glass", edge === "bottom" && "glass--bottom", variant === "static" && "glass--static", variant === "solid" && "glass--solid", className)} />;
}

/* Development aid for "at most two live glass panes": counts mounted live panes and warns when a third appears.
   Mounted is a proxy for visible — a hidden pane still counts, which is the point: replace one or go solid. */
let liveGlass = 0;
function useLiveGlassBudget(live: boolean) {
  useEffect(() => {
    if (!live || !import.meta.env.DEV) return;
    liveGlass++;
    if (liveGlass > 2) {
      console.warn(`[Glass] ${liveGlass} live glass panes are mounted. DESIGN.md §6.2 allows two per viewport: make the third variant="solid" or replace one.`);
    }
    return () => {
      liveGlass--;
    };
  }, [live]);
}
