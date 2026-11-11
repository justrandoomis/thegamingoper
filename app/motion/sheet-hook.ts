/**
 * useSheet — bottom-sheet physics for a sheet component. Mount the sheet when it opens; unmount it in `onClose`.
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
 * - The sheet springs up to `initialSnap` when it mounts. Dragging the handle moves it 1:1 from where it was grabbed;
 *   on release the finger's momentum picks the snap point and the spring settle starts with that velocity.
 *   Past the most open point it rubber-bands. Grab it mid-flight and it follows the finger again.
 * - Dragged or flicked below the lowest snap point (or `close()`): it springs down, then `onClose` runs.
 * - Only the handle starts a drag, so the content scrolls natively. Focus management, the scrim's colour and
 *   Escape belong to the sheet component (call `sheet.close()`).
 * - Reduced motion: it is placed without travel.
 *
 * The physics load on demand; if they have not arrived yet the sheet simply shows fully open and `close()` calls
 * `onClose` directly.
 */
import { useLayoutEffect, useMemo, useRef, type CSSProperties, type RefObject } from "react";
import { loadExtras, readyExtras } from "./lazy";
import type { SheetController, SheetOptions } from "./sheet";

export type { SheetOptions } from "./sheet";

export type SheetHandle = {
  /** Attach to the sheet element (bottom-anchored; `.tt-sheet` gives it the positioning). */
  ref: RefObject<HTMLElement | null>;
  /** Optional: attach to the scrim; its opacity follows how open the sheet is. */
  backdropRef: RefObject<HTMLElement | null>;
  /** Spread on the drag handle (the grabber bar, or the whole header). */
  handleProps: { "data-sheet-handle": ""; style: CSSProperties };
  /** Spring to snapPoints[index]. */
  snapTo: (index: number) => void;
  /** Spring down, then `onClose`. */
  close: () => void;
};

export function useSheet(options: SheetOptions = {}): SheetHandle {
  const ref = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLElement | null>(null);
  const controller = useRef<SheetController | null>(null);
  const latest = useRef(options);

  useLayoutEffect(() => {
    latest.current = options;
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let disposed = false;
    const attach = (extras: NonNullable<ReturnType<typeof readyExtras>>, animateIn: boolean) => {
      if (disposed || !element.isConnected) return;
      controller.current = extras.createSheet(element, () => latest.current, { backdrop: backdropRef.current, animateIn });
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
  }, []);

  return useMemo<SheetHandle>(
    () => ({
      ref,
      backdropRef,
      handleProps: { "data-sheet-handle": "", style: { touchAction: "none" } },
      snapTo: (index) => controller.current?.snapTo(index),
      close: () => {
        if (controller.current) controller.current.close();
        else latest.current.onClose?.();
      },
    }),
    [],
  );
}
