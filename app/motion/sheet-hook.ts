/**
 * useSheet — sheet physics and focus for a sheet component. Mount the sheet when it opens; unmount it in `onClose`.
 *
 *   function CartSheet({ onClose }: { onClose: () => void }) {
 *     const sheet = useSheet({ snapPoints: [0.5, 1], onClose });
 *     return (
 *       <>
 *         <div ref={sheet.backdropRef} className="scrim" onClick={sheet.close} />
 *         <section ref={sheet.ref} className="tt-sheet …" role="dialog" aria-modal="true" aria-label="…">
 *           <div {...sheet.handleProps}><span className="grabber" /></div>
 *           <div className="scrollable-content">…</div>
 *         </section>
 *       </>
 *     );
 *   }
 *
 * - DESIGN.md §7.2: the sheet rises from the bottom edge on the `sheet` spring (from the inline-end edge on tablet and
 *   desktop with `edge: "auto"`, the default); the scrim's opacity follows how open it is. Dragging the handle moves
 *   it 1:1 from where it was grabbed; on release the finger's momentum picks the snap point and the spring starts with
 *   that velocity. Past the most open point it rubber-bands. Grab it mid-flight and it follows the finger again.
 * - Dragged or flicked past the lowest snap point, Escape, or `close()`: it springs away, then `onClose` runs.
 * - Focus (unless `manageFocus: false`): moves into the sheet when it opens (its `[autofocus]` element, else the sheet
 *   itself), Tab and Shift+Tab stay inside, Escape closes, and focus returns to the opener when it unmounts.
 * - Only the handle starts a drag, so the content scrolls natively.
 * - Reduced motion: it appears and disappears with a 120 ms fade; dragging still works.
 *
 * The physics load on demand; if they have not arrived yet the sheet simply shows open and `close()` calls `onClose`.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { loadExtras, readyExtras } from "./lazy";
import type { SheetController, SheetEdge, SheetOptions as SheetPhysics } from "./sheet";
import { sheet as tokens } from "./tokens";

export type SheetOptions = SheetPhysics & {
  /** The edge it comes from. "auto" (default): the bottom on phones, the inline-end edge from 768px wide. */
  edge?: SheetEdge | "auto";
  /** Move focus in, keep Tab inside, close on Escape, return focus on unmount. Default true. */
  manageFocus?: boolean;
};

export type SheetHandle = {
  /** Attach to the sheet element (`.tt-sheet` gives it the positioning; `data-sheet-edge` is set for you). */
  ref: RefObject<HTMLElement | null>;
  /** Optional: attach to the scrim; its opacity follows how open the sheet is. */
  backdropRef: RefObject<HTMLElement | null>;
  /** Spread on the drag handle (the grabber bar, or the whole header). */
  handleProps: { "data-sheet-handle": ""; style: CSSProperties };
  /** The edge this sheet comes from (decided when it mounts). */
  edge: SheetEdge;
  /** Spring to snapPoints[index]. */
  snapTo: (index: number) => void;
  /** Spring away, then `onClose`. */
  close: () => void;
};

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Open sheets, most recent last: only the top one answers Tab and Escape. */
const stack: HTMLElement[] = [];

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

export function useSheet(options: SheetOptions = {}): SheetHandle {
  const ref = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLElement | null>(null);
  const controller = useRef<SheetController | null>(null);
  const latest = useRef(options);
  const [edge] = useState<SheetEdge>(() => {
    const wanted = options.edge ?? "auto";
    if (wanted !== "auto") return wanted;
    return typeof window !== "undefined" && window.innerWidth >= tokens.sideFrom ? "inline-end" : "bottom";
  });

  useLayoutEffect(() => {
    latest.current = options;
  });

  const handle = useMemo<SheetHandle>(
    () => ({
      ref,
      backdropRef,
      handleProps: { "data-sheet-handle": "", style: { touchAction: "none" } },
      edge,
      snapTo: (index) => controller.current?.snapTo(index),
      close: () => {
        if (controller.current) controller.current.close();
        else latest.current.onClose?.();
      },
    }),
    [edge],
  );

  // Physics.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.setAttribute("data-sheet-edge", edge);
    let disposed = false;
    const attach = (extras: NonNullable<ReturnType<typeof readyExtras>>, animateIn: boolean) => {
      if (disposed || !element.isConnected) return;
      controller.current = extras.createSheet(element, () => latest.current, { backdrop: backdropRef.current, animateIn, edge });
    };
    const ready = readyExtras();
    // Before first paint when the physics are already here: the sheet starts closed and springs open.
    if (ready) attach(ready, true);
    else loadExtras().then((extras) => attach(extras, false)).catch(() => {});
    return () => {
      disposed = true;
      controller.current?.destroy();
      controller.current = null;
    };
  }, [edge]);

  // Focus: in on open, trapped while open, back to the opener on close.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || latest.current.manageFocus === false) return;
    const opener = document.activeElement instanceof HTMLElement && !element.contains(document.activeElement) ? document.activeElement : null;
    if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
    stack.push(element);
    (element.querySelector<HTMLElement>("[autofocus]") ?? element).focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== element) return;
      if (event.key === "Escape") {
        event.preventDefault();
        handle.close();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(element);
      const active = document.activeElement;
      if (items.length === 0) {
        event.preventDefault();
        element.focus({ preventScroll: true });
      } else if (!element.contains(active)) {
        event.preventDefault();
        items[0].focus();
      } else if (event.shiftKey && (active === items[0] || active === element)) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && active === items[items.length - 1]) {
        event.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const index = stack.lastIndexOf(element);
      if (index >= 0) stack.splice(index, 1);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [handle]);

  return handle;
}
