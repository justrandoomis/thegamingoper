import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useT } from "~/i18n/react";
import { useSheet, type SheetEdge } from "~/motion";
import { cx } from "./cx";
import { Dialog, OverlayHostContext, useModalLayer, useOverlayRoot, usePresence, usePrimeLayers } from "./Dialog";
import { Glass } from "./Glass";
import { IconKey } from "./IconKey";

/**
 * Sheets (docs/DESIGN.md §9.14, motion §7.2): bottom-anchored on phones; a glass header strip (`.glass--bottom`, top
 * corners `--r-xl`) with a grab handle, the title and a round clay close key; an opaque body that scrolls inside;
 * at most 90% of the viewport high. Used for filters, the governorate picker, quick preview, variant choice and
 * reason codes.
 *
 *   const [open, setOpen] = useState(false);
 *   <Key onClick={() => setOpen(true)} aria-haspopup="dialog">{t("governorate")}</Key>
 *   <Sheet open={open} onClose={() => setOpen(false)} title={t("chooseGovernorate")} presentation="picker">
 *     {governorates.map((g) => …option row…)}
 *   </Sheet>
 *
 *   <Sheet open={filters} onClose={close} title={t("filters")} description={t("results", { count })}
 *          presentation="side" snapPoints={[0.5, 1]}
 *          footer={<><Key onClick={clear}>{t("clearAll")}</Key><Key variant="ink" onClick={close}>{t("show", { count })}</Key></>}>
 *     …chip groups…
 *   </Sheet>
 *
 * presentation   "sheet" (default) a bottom sheet at every width · "side" a bottom sheet on phones and a 420px side
 *                panel from the inline-end edge from `sideFrom` (768 by default — cart and filters, §8.11; pass 1024
 *                where a screen asks for it) · "picker" a bottom sheet on phones and a centred dialog (max 520) from
 *                768 (governorate, variant, reason codes; §8.11).
 *
 * Motion comes from the engine's useSheet: it rises on the `sheet` spring, follows the finger 1:1 when the header is
 * dragged, keeps the finger's velocity on release (snap points, flick away), rubber-bands past the top; the scrim
 * fades with how open it is. Reduced motion: a 120ms fade; dragging still works. Only the header strip is glass.
 *
 * Focus moves into the sheet and is trapped, Escape / the scrim / the close key / Android's back close it, focus
 * returns to the opener, the page behind is inert and keeps its scroll position without a layout shift (shared with
 * <Dialog>), and the sheet takes the opener's density. `open` is the state: when it turns false the sheet springs away
 * and unmounts afterwards. A drag or flick past the lowest snap point calls `onClose` when the sheet has left. Client
 * only: nothing renders on the server. Props and examples: docs/ui/overlays.md.
 */
export type SheetProps = {
  open: boolean;
  /** Asked to close: set `open` to false. */
  onClose: () => void;
  /** Names the sheet (h2 in the header strip). */
  title: ReactNode;
  /** One line under the title (a result count, the fee rule). */
  description?: ReactNode;
  children: ReactNode;
  /** Pinned under the body: at most two keys, e.g. "امسح الكل" and "اعرض 24 منتجاً" (not red — it commits nothing). */
  footer?: ReactNode;
  presentation?: "sheet" | "side" | "picker";
  /** Viewport width (px) from which `presentation="side"` is a side panel. Default 768. */
  sideFrom?: number;
  /** Bottom sheets: open fractions of the sheet's height, e.g. [0.5, 1]. Default [1]. */
  snapPoints?: readonly number[];
  /** Index into the snap points (ascending) to open at. Default: the most open one. */
  initialSnap?: number;
  /** What to focus when it opens. Default: [autofocus], else the sheet itself (the title is read). */
  initialFocus?: RefObject<HTMLElement | null> | (() => HTMLElement | null | undefined);
  /** No body padding (lists with full-bleed rows). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
};

const WIDE = "(min-width: 48rem)";

export function Sheet(props: SheetProps) {
  usePrimeLayers();
  // A picker becomes a centred dialog on wide screens; decided when it opens, so a resize never swaps it mid-way.
  const [lastOpen, setLastOpen] = useState(false);
  const [wideAtOpen, setWideAtOpen] = useState(false);
  let wide = wideAtOpen;
  if (props.open !== lastOpen) {
    setLastOpen(props.open);
    if (props.open) {
      wide = typeof window !== "undefined" && window.matchMedia(WIDE).matches;
      setWideAtOpen(wide);
    }
  }
  const asDialog = props.presentation === "picker" && wide;
  const [present, exited] = usePresence(props.open && !asDialog);

  if (asDialog) {
    return (
      <Dialog
        open={props.open}
        onClose={props.onClose}
        title={props.title}
        header="glass"
        footer={props.footer}
        initialFocus={props.initialFocus}
        className={props.className}
        bodyClassName={cx(props.flush && "px-0 sm:px-0", props.bodyClassName)}
      >
        {props.description ? <p className="type-caption text-ink-2">{props.description}</p> : null}
        {props.children}
      </Dialog>
    );
  }
  if (!present) return null;
  return <SheetLayer {...props} leaving={!props.open} onExited={exited} />;
}

type LayerProps = SheetProps & { leaving: boolean; onExited: () => void };

/** Waits for the portal root (it exists only after hydration), so the sheet and its physics mount together. */
function SheetLayer(props: LayerProps) {
  const root = useOverlayRoot();
  return root ? <SheetPortal {...props} root={root} /> : null;
}

function SheetPortal({
  root,
  onClose,
  title,
  description,
  children,
  footer,
  presentation = "sheet",
  sideFrom = 768,
  snapPoints,
  initialSnap,
  initialFocus,
  flush = false,
  className,
  bodyClassName,
  leaving,
  onExited,
}: LayerProps & { root: HTMLElement }) {
  const t = useT("ui");
  const to = useT("ui-overlays");
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const [edge] = useState<SheetEdge>(() =>
    presentation === "side" && typeof window !== "undefined" && window.innerWidth >= sideFrom ? "inline-end" : "bottom",
  );
  const points = edge === "bottom" && snapPoints && snapPoints.length > 0 ? [...snapPoints].sort((a, b) => a - b) : [1];
  const mostOpen = points.length - 1;
  const openAt = Math.min(Math.max(initialSnap ?? mostOpen, 0), mostOpen);
  const [snap, setSnap] = useState(openAt);

  const latest = useRef({ onClose, onExited });
  useLayoutEffect(() => {
    latest.current = { onClose, onExited };
  });
  /** onClose once per opening, however many ways the shopper asks. */
  const requested = useRef(false);
  /** The sheet has fully left (the engine's own close finished). */
  const finished = useRef(false);
  const requestClose = () => {
    if (requested.current) return;
    requested.current = true;
    latest.current.onClose();
  };

  const sheet = useSheet({
    edge,
    snapPoints: points,
    initialSnap: openAt,
    manageFocus: false, // focus, Tab and Escape belong to the shared modal-layer stack (a dialog may open on top)
    onClose: () => {
      finished.current = true;
      requestClose();
      latest.current.onExited();
    },
    onSnap: setSnap,
  });

  useModalLayer({
    root,
    host,
    active: !leaving,
    onEscape: requestClose,
    initialFocus: () => (typeof initialFocus === "function" ? initialFocus() : initialFocus?.current),
  });

  // `open` turned false: spring away (the engine calls onClose → onExited at rest). Reopened mid-way: come back.
  const wasLeaving = useRef(false);
  useLayoutEffect(() => {
    if (leaving) {
      requested.current = true;
      if (!finished.current) sheet.close();
    } else if (wasLeaving.current) {
      requested.current = false;
      sheet.snapTo(openAt);
    }
    wasLeaving.current = leaving;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to `leaving` only
  }, [leaving]);

  const bottom = edge === "bottom";
  const canResize = bottom && points.length > 1;
  const expanded = snap >= mostOpen;

  return createPortal(
    <OverlayHostContext value={host}>
      <div ref={setHost} className="fixed inset-0 z-(--z-sheet)" inert={leaving || undefined}>
        <div
          ref={(element) => {
            sheet.backdropRef.current = element;
          }}
          className="absolute inset-0 bg-(--scrim)"
          aria-hidden="true"
          onClick={requestClose}
        />
        <section
          ref={sheet.ref as RefObject<HTMLElement | null>}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          data-layer-panel=""
          className={cx(
            "tt-sheet fixed flex flex-col text-ink outline-none",
            bottom ? "inset-x-0 bottom-0 max-h-[90dvh] rounded-t-xl shadow-e5" : "inset-y-0 end-0 h-dvh w-[min(420px,100vw)] rounded-s-xl",
            className,
          )}
        >
          <Glass edge="bottom" className={cx("relative z-[1] shrink-0", bottom ? "rounded-t-xl" : "rounded-ss-xl")}>
            <div {...sheet.handleProps} className="flex min-h-[77px] items-center pb-2.5 pe-[calc(var(--gutter)+56px)] ps-(--gutter) pt-[21px]">
              {canResize ? (
                <button
                  type="button"
                  className="absolute inset-x-0 top-0 mx-auto grid h-[22px] w-16 justify-center pt-[9px] hit-44"
                  aria-label={expanded ? to("sheet.collapse") : to("sheet.expand")}
                  aria-expanded={expanded}
                  onClick={() => sheet.snapTo(expanded ? 0 : mostOpen)}
                >
                  <span className="block h-[5px] w-10 rounded-[3px] bg-ink opacity-[.28]" aria-hidden="true" />
                </button>
              ) : bottom ? (
                <span className="absolute inset-x-0 top-[9px] mx-auto block h-[5px] w-10 rounded-[3px] bg-ink opacity-[.28]" aria-hidden="true" />
              ) : null}
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="type-sub">
                  {title}
                </h2>
                {description ? (
                  <p id={descriptionId} className="type-caption text-ink-2">
                    {description}
                  </p>
                ) : null}
              </div>
            </div>
            <IconKey icon="x" label={t("close")} onClick={requestClose} className="absolute end-(--gutter) top-[21px]" />
          </Glass>
          <div className={cx("flex min-h-0 flex-1 flex-col bg-floor", !bottom && "rounded-es-xl")}>
            <div
              className={cx(
                "min-h-0 flex-1 overflow-y-auto overscroll-contain",
                !flush && "px-(--gutter) pt-3",
                footer ? (flush ? "" : "pb-3") : "pb-[calc(var(--safe-bottom)+16px)]",
                bodyClassName,
              )}
            >
              {children}
            </div>
            {footer ? (
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line px-(--gutter) pb-[calc(var(--safe-bottom)+12px)] pt-3 [&>*]:flex-1">
                {footer}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </OverlayHostContext>,
    root,
  );
}
