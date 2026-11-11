import { useEffect, type ComponentPropsWithRef, type ElementType } from "react";

import { cx } from "./cx";

/**
 * Glass v2 — Design System v2 §2.10b: THIN FIXED CHROME ONLY (the phone header, the desktop header's two rows, the tab
 * bar, the buy bar, task bars, the checkout bar and a sheet's header strip). THE ONLY WAY to get backdrop-filter in this
 * app (scripts/lint-design.mjs fails any other backdrop-filter). Panels, menus, sheet bodies, dialogs and toasts are
 * opaque — never glass.
 *
 *   <Glass as="header" className="sticky top-0 …">…</Glass>                                  live frost, the bar edge
 *   <Glass as="nav" edge="bottom" className="fixed inset-x-0 bottom-0 …">…tab bar…</Glass>   floating bars (--e-float)
 *   <Glass variant="solid">…</Glass>                                                         the same bar, opaque
 *
 * Rules: live glass only on FIXED or STICKY chrome that content really scrolls under — never on anything that
 * scrolls with the page or repeats in a list; at most two live panes in a viewport; never red; blur, tint and shadow
 * never animate; no element with a view-transition-name may contain it. Secondary text on glass is plain --ink-2.
 * Reduced transparency, the low-end tier, `prefers-contrast: more` and missing backdrop-filter support all fall back
 * to solid; so does the page's glass under an open sheet or dialog (the modal layer marks the page it covers —
 * ./Dialog, materials.css). 1.0's `variant="static"` is retired (§4.2): it renders an opaque surface.
 */
export type GlassOwnProps = {
  /** live (default, frosted) · solid (opaque glass colour) · static (1.0, retired: opaque). */
  variant?: "live" | "static" | "solid";
  /** "bottom" for bars anchored to the bottom edge and floating pills: the float shadow. */
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
