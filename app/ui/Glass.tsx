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
 * Reduced transparency, the low-end tier and missing backdrop-filter support all fall back to solid; so does the
 * page's glass under an open sheet or dialog (the modal layer marks the page it covers — ./Dialog, materials.css).
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

/** Live panes: `.glass` that is neither static nor solid, and not on the page under an open sheet or dialog. */
export const LIVE_GLASS = ".glass:not(.glass--static):not(.glass--solid)";
const BEHIND_LAYER = "[data-layer-behind]";

/** The live glass panes in a document that frost something: not on the page under an open sheet or dialog. */
export function liveGlassPanes(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(LIVE_GLASS)).filter((pane) => !pane.closest(BEHIND_LAYER));
}

/** Drawn and inside the viewport (display:none, or a specimen scrolled far away, is not "in a viewport"). */
function inViewport(pane: Element): boolean {
  if (pane.getClientRects().length === 0) return false;
  const box = pane.getBoundingClientRect();
  return box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
}

/* Development aid for "at most two live glass panes per viewport": when a live pane mounts, count the live panes in
   the viewport once it has settled (a sheet has risen, the layer that brought it has marked the page under it).
   Panes of a page under an open layer do not count — they are solid there (materials.css). */
const SETTLE_MS = 500;
let checkPending = false;
function checkLiveGlassBudget() {
  if (checkPending) return;
  checkPending = true;
  setTimeout(() => {
    checkPending = false;
    const live = liveGlassPanes(document).filter(inViewport).length;
    if (live > 2) {
      console.warn(`[Glass] ${live} live glass panes are on screen. DESIGN.md §6.2 allows two per viewport: make the third variant="solid" or replace one.`);
    }
  }, SETTLE_MS);
}

function useLiveGlassBudget(live: boolean) {
  useEffect(() => {
    if (!live || !import.meta.env.DEV) return;
    checkLiveGlassBudget();
  }, [live]);
}
