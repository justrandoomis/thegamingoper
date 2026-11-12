import { useEffect, type ComponentPropsWithRef, type ElementType } from "react";

import { cx } from "./cx";

/**
 * Glass — Design System v2 §2.10b; v2.1 "Clay & Glass" (DESIGN.md §15.3): frosted, rim-lit glass on the BARS (the phone
 * header, the desktop header's two rows, the tab bar, the buy bar, task bars, the checkout bar) and on PANELS (sheets,
 * menus, the mega menu, suggestions, floating price tags, carousel controls: `panel`). THE ONLY WAY to get
 * backdrop-filter in this app besides the .surface--glass card (scripts/lint-design.mjs fails any other
 * backdrop-filter). Dialogs and toasts stay opaque. Repeated grid cards never blur: they are faux glass (.surface).
 *
 *   <Glass as="header" className="sticky top-0 …">…</Glass>                                  live frost, the bar edge
 *   <Glass as="nav" edge="bottom" className="fixed inset-x-0 bottom-0 …">…tab bar…</Glass>   floating bars (rim + float)
 *   <Glass panel className="rounded-lg …">…a menu, a floating tag…</Glass>                   a frosted panel
 *   <Glass variant="solid">…</Glass>                                                         the same bar, opaque
 *
 * Rules: live glass only where something really shows through (content scrolling under a bar, the page under a panel,
 * an ambient .glow behind a hero) — never on anything that repeats in a list; at most four live panes in a viewport
 * (two bars, one panel, one hero); never red; blur, tint and shadow never animate; no element with a
 * view-transition-name may contain it. Secondary text on glass is plain --ink-2 (≥ 4.5:1 over black).
 * Reduced transparency, the low-end tier, `prefers-contrast: more` and missing backdrop-filter support all fall back
 * to solid; so does the page's glass under an open sheet or dialog (the modal layer marks the page it covers —
 * ./Dialog, materials.css). 1.0's `variant="static"` is retired (§4.2): it renders an opaque surface.
 */
export type GlassOwnProps = {
  /** live (default, frosted) · solid (opaque glass colour) · static (1.0, retired: opaque). */
  variant?: "live" | "static" | "solid";
  /** v2.1: a frosted panel (menus, sheets, floating tags, carousel controls): the panel tint, the rim, the overlay shadow. */
  panel?: boolean;
  /** "bottom" for bars anchored to the bottom edge and floating pills: the float shadow. */
  edge?: "top" | "bottom";
  className?: string;
};

export type GlassProps<C extends ElementType = "div"> = GlassOwnProps & { as?: C } & Omit<ComponentPropsWithRef<C>, keyof GlassOwnProps | "as">;

export function Glass<C extends ElementType = "div">({ as, variant = "live", edge = "top", panel = false, className, ...rest }: GlassProps<C>) {
  const Tag: ElementType = as ?? "div";
  useLiveGlassBudget(variant === "live");
  return (
    <Tag
      {...rest}
      className={cx("glass", edge === "bottom" && "glass--bottom", panel && "glass--panel", variant === "static" && "glass--static", variant === "solid" && "glass--solid", className)}
    />
  );
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

/* Development aid for "at most four live glass panes per viewport" (v2.1: two bars, one panel, one hero): when a live pane mounts, count the live panes in
   the viewport once it has settled (a sheet has risen, the layer that brought it has marked the page under it).
   Panes of a page under an open layer do not count — they are solid there (materials.css). */
const SETTLE_MS = 500;
/** v2.1: the header's two rows (or the header and the tab bar), one panel (a sheet, a menu), one hero. */
export const LIVE_GLASS_BUDGET = 4;
let checkPending = false;
function checkLiveGlassBudget() {
  if (checkPending) return;
  checkPending = true;
  setTimeout(() => {
    checkPending = false;
    const live = liveGlassPanes(document).filter(inViewport).length;
    if (live > LIVE_GLASS_BUDGET) {
      console.warn(`[Glass] ${live} live glass panes are on screen. DESIGN.md §15.3 allows ${LIVE_GLASS_BUDGET} per viewport: make one variant="solid" or replace it.`);
    }
  }, SETTLE_MS);
}

function useLiveGlassBudget(live: boolean) {
  useEffect(() => {
    if (!live || !import.meta.env.DEV) return;
    checkLiveGlassBudget();
  }, [live]);
}
