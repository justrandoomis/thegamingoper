import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { getArt, isPhoto, type PhotoKind } from "~/art";
import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { ImageRef } from "~/lib/dto";
import { SharedElement } from "~/motion";
import { cx } from "./cx";
import { fadeElement, useModalLayer, useOverlayRoot, usePresence, usePrimeLayers } from "./Dialog";
import { IconKey } from "./IconKey";
import type { Gel } from "./PlatformLed";
import { ProductImage } from "./ProductCard";
import { useKeepInView } from "./reveal";
import { useControllable, useRovingRadio } from "./roving";
import { Stage } from "./Stage";

/**
 * The product page's gallery — Design System v2 §4.14: the NEUTRAL stage (the product ground; 1:1 and full bleed on
 * phones, 4:3 with --r-xl from 768, 5:4 from 1024), straight, big, standing on the floor line. No tilt, no halo, no
 * platform light, no kind captions. Inside the stage only the counter chip «1 من 6» (bottom-start) and the full-screen
 * button (top-end). The thumbnails sit BELOW the stage: 56px (76 from 1024) on the product ground, the chosen one with a
 * 2px ink ring and a 2px gap, a radiogroup with roving tabindex.
 *
 *   <Gallery name={p.name} items={p.media.map((image) => ({ image }))} sharedName={`product-image:${p.id}`} priority />
 *   <Gallery name={u.name} items={photos} evidence="used" sharedName={`used-image:${u.id}`} />
 *
 * Swipe the picture sideways or press ← → on it (both follow the reading direction); the thumbnails move with the arrow
 * keys. Tapping the picture (or the full-screen button) opens the viewer: an opaque layer (--ground), the picture with
 * double-tap and button zoom (pinch is the browser's own), the thumbnails in a solid strip, close at 44px; Escape and
 * focus return. Used units: the unit's own photos first; when a picture is not the unit, one line under the stage
 * says so («صورة توضيحية — ليست صورة الجهاز نفسه»).
 *
 * 1.0 props are accepted and ignored: `gel`, `top`, `flush`; `caption` is used only for the thumbnails' names.
 */
export type GalleryItem = {
  image: ImageRef;
  /** Words for this view (the thumbnail's accessible name). Default: from the photo's kind. */
  caption?: string;
};

export type GalleryProps = {
  /** Product name — the alt text when an image has none, and the viewer's title. */
  name: string;
  items: readonly GalleryItem[];
  /** The card this page opens from: `product-image:${id}` (ProductCard's default) or `used-image:${id}`. */
  sharedName?: string;
  /** "used": the honesty line under the stage when a picture is an illustration. */
  evidence?: "product" | "used";
  /** The first picture is the page's LCP element. */
  priority?: boolean;
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  /** 1.0 — ignored. */
  gel?: Gel | null;
  /** 1.0 — ignored (no orbs on the stage). */
  top?: ReactNode;
  /** 1.0 — ignored. */
  flush?: boolean;
  className?: string;
};

const KIND_KEY: Record<PhotoKind, string> = {
  hero: "hero",
  angle: "angle",
  detail: "detail",
  "in-box": "inBox",
  "box-art": "boxArt",
  screenshot: "screenshot",
};

/** Next index after a step, kept inside the list (no wrap: the end of a swipe is the end). Pure. */
export function stepIndex(index: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  const target = Number.isFinite(index) ? Math.trunc(index) + Math.trunc(delta) : 0;
  return Math.min(total - 1, Math.max(0, target));
}

/**
 * A horizontal swipe as a step: +1 (next), −1 (previous) or 0 (not a swipe). "Next" is a swipe toward the reading
 * start — leftward in English, rightward in Arabic and Kurdish. Pure.
 */
export function swipeStep(dx: number, dy: number, rtl: boolean, threshold = 48): -1 | 0 | 1 {
  if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  const towardStart = rtl ? dx > 0 : dx < 0;
  return towardStart ? 1 : -1;
}

/** ← / → on a focused gallery as a step, following the reading direction (→ is "next" in English). Pure. */
export function arrowStep(key: string, rtl: boolean): -1 | 0 | 1 {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return 0;
  return key === (rtl ? "ArrowLeft" : "ArrowRight") ? 1 : -1;
}

export function Gallery({ name, items, sharedName, evidence = "product", priority = false, index, defaultIndex = 0, onIndexChange, className }: GalleryProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const [rawCurrent, setCurrent] = useControllable<number>(index, defaultIndex, onIndexChange);
  const total = items.length;
  const current = stepIndex(rawCurrent, 0, total);
  const [viewerOpen, setViewerOpen] = useState(false);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const swallowClick = useRef(false);
  const changed = useRef(false);

  const go = (next: number) => {
    const target = stepIndex(next, 0, total);
    if (target === current) return;
    changed.current = true;
    setCurrent(target);
  };

  const captionOf = (item: GalleryItem | undefined): string => {
    if (!item) return "";
    if (item.caption) return item.caption;
    if (evidence === "used") return t(item.image.isIllustration ? "gallery.illustration" : "gallery.real");
    const art = item.image.artKey ? getArt(item.image.artKey) : undefined;
    return t(`gallery.kinds.${isPhoto(art) ? KIND_KEY[art.kind] : "photo"}`);
  };

  if (total === 0) {
    // nothing to show is said plainly: the empty ground keeps the page's geometry
    return <Stage size="pdp" className={className} />;
  }

  const item = items[current];
  const count = t("gallery.count", { n: f.number(current + 1), total: f.number(total) });
  const illustrationOnUsed = evidence === "used" && item.image.isIllustration;

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = swipeStep(event.clientX - start.x, event.clientY - start.y, rtl);
    if (step === 0) return;
    swallowClick.current = true;
    go(current + step);
  };
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      event.preventDefault();
      return;
    }
    setViewerOpen(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = arrowStep(event.key, getComputedStyle(event.currentTarget).direction === "rtl");
    if (step === 0) return;
    event.preventDefault();
    go(current + step);
  };

  const stage = (
    <Stage
      size="pdp"
      count={
        <bdi className="nums" aria-live={changed.current ? "polite" : undefined}>
          {count}
        </bdi>
      }
      tools={<IconKey icon="corners-out" variant="onImage" label={t("buy.fullscreen")} aria-haspopup="dialog" onClick={() => setViewerOpen(true)} />}
    >
      <button
        type="button"
        className="grid size-full cursor-zoom-in touch-pan-y touch-pinch-zoom items-end justify-items-center"
        aria-label={t("gallery.open", { caption: captionOf(item) })}
        aria-haspopup="dialog"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = null)}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <ProductImage image={item.image} alt={item.image.alt || name} sizes="(min-width: 1024px) 714px, (min-width: 768px) 92vw, 100vw" priority={priority && current === 0} />
      </button>
    </Stage>
  );

  return (
    <div className={cx("gallery", className)}>
      {sharedName ? (
        <SharedElement name={sharedName} target>
          {stage}
        </SharedElement>
      ) : (
        stage
      )}
      {illustrationOnUsed ? (
        <p className="flex items-start gap-1.5 type-xs-strong text-warn" data-evidence="illustration">
          <Icon name="image" size={16} className="mt-0.5 shrink-0" />
          <span>{t("gallery.illustration")}</span>
        </p>
      ) : null}
      {total > 1 ? <Thumbs name={name} items={items} index={current} onIndex={go} captionOf={captionOf} /> : null}
      <GalleryViewer open={viewerOpen} onClose={() => setViewerOpen(false)} name={name} items={items} index={current} onIndex={go} captionOf={captionOf} />
    </div>
  );
}

/**
 * The thumbnails: a radiogroup of 56px (76 from 1024) wells; roving tabindex; arrows follow the reading direction. A
 * row wider than its box scrolls sideways (never the page), and the chosen thumbnail is kept in view.
 */
function Thumbs({ name, items, index, onIndex, captionOf, className }: { name: string; items: readonly GalleryItem[]; index: number; onIndex: (index: number) => void; captionOf: (item: GalleryItem | undefined) => string; className?: string }) {
  const t = useT("ui-shop");
  const f = useFormat();
  const row = useRef<HTMLDivElement>(null);
  const values = items.map((_, i) => String(i));
  const { itemProps } = useRovingRadio({ values, value: String(index), onChange: (value) => onIndex(Number(value)) });
  useKeepInView(row, '[aria-checked="true"]', index);
  return (
    <div ref={row} role="radiogroup" aria-label={t("gallery.label", { name })} className={cx("thumbs", className)}>
      {items.map((entry, i) => (
        <button key={i} type="button" className="thumb" data-press="soft" aria-label={t("gallery.thumb", { n: f.number(i + 1), caption: captionOf(entry) })} {...itemProps(i)}>
          <span className="render-slot place-items-center">
            <ProductImage image={entry.image} alt="" sizes="76px" fit="cover" />
          </span>
        </button>
      ))}
    </div>
  );
}

type ViewerProps = {
  open: boolean;
  onClose: () => void;
  name: string;
  items: readonly GalleryItem[];
  index: number;
  onIndex: (index: number) => void;
  captionOf: (item: GalleryItem | undefined) => string;
};

/** The full-screen viewer: mounted while open or leaving; a layer of the shared modal stack (./Dialog). */
function GalleryViewer(props: ViewerProps) {
  usePrimeLayers();
  const [present, exited] = usePresence(props.open);
  if (!present) return null;
  return <ViewerLayer {...props} leaving={!props.open} onExited={exited} />;
}

function ViewerLayer({ onClose, name, items, index, onIndex, captionOf, leaving, onExited }: ViewerProps & { leaving: boolean; onExited: () => void }) {
  const t = useT("ui-shop");
  const f = useFormat();
  const root = useOverlayRoot();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const closeKey = useRef<HTMLButtonElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const exitedRef = useRef(onExited);
  useLayoutEffect(() => {
    exitedRef.current = onExited;
  });

  useModalLayer({ root, host, active: !leaving, onEscape: onClose, initialFocus: () => closeKey.current });

  // In and out with opacity only (reduced motion: a 120ms fade).
  useLayoutEffect(() => {
    if (!host) return;
    if (!leaving) {
      void fadeElement(host, 1);
      return;
    }
    let cancelled = false;
    void fadeElement(host, 0).then(() => {
      if (!cancelled) exitedRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [host, leaving]);

  // A new picture starts unzoomed.
  useEffect(() => setZoomed(false), [index]);

  if (!root) return null;
  const item = items[index];

  const toggleZoom = (at?: { x: number; y: number }) => {
    const box = scroller.current;
    const next = !zoomed;
    setZoomed(next);
    if (!box || !next) return;
    // Keep the point that was tapped under the finger: the content doubles, so scroll to twice its offset.
    requestAnimationFrame(() => {
      const rect = box.getBoundingClientRect();
      const x = at ? at.x - rect.left : rect.width / 2;
      const y = at ? at.y - rect.top : rect.height / 2;
      box.scrollTo({ left: x * 2 - rect.width / 2, top: y * 2 - rect.height / 2 });
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[role="radiogroup"]')) return; // the thumbnails move by themselves
    const step = arrowStep(event.key, getComputedStyle(event.currentTarget).direction === "rtl");
    if (step === 0) return;
    event.preventDefault();
    onIndex(stepIndex(index, step, items.length));
  };

  // One column as wide as the screen (minmax(0, 1fr), never the thumbnails' width): the bar, the picture and the strip
  // all fit a 360px phone; the strip scrolls sideways inside its own row (QA 2026-11-12: six thumbnails made the column
  // 416px wide and pushed the close key off a 360px screen).
  return createPortal(
    <div
      ref={setHost}
      role="dialog"
      aria-modal="true"
      aria-label={t("gallery.viewer", { name })}
      onKeyDown={onKeyDown}
      inert={leaving || undefined}
      className="viewer fixed inset-0 z-(--z-dialog) grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] bg-floor text-ink opacity-0"
    >
      <div className="viewer__bar flex min-w-0 items-center justify-between gap-3 pt-[max(8px,var(--safe-top))] pb-2">
        <p className="min-w-0 truncate type-sm-strong text-ink-2">
          <bdi className="nums">{t("gallery.count", { n: f.number(index + 1), total: f.number(items.length) })}</bdi>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <IconKey icon="magnifying-glass" label={t(zoomed ? "gallery.zoomOut" : "gallery.zoomIn")} held={zoomed} onClick={() => toggleZoom()} />
          <IconKey ref={closeKey} icon="x" label={t("gallery.close")} onClick={onClose} />
        </div>
      </div>
      <div ref={scroller} className="relative min-w-0 overflow-auto overscroll-contain" onDoubleClick={(event) => toggleZoom({ x: event.clientX, y: event.clientY })}>
        <div className={cx("grid place-items-center p-4", zoomed ? "h-[200%] w-[200%] cursor-zoom-out" : "size-full cursor-zoom-in")}>
          <span className="render-slot size-full place-items-center">
            <ProductImage image={item.image} alt={item.image.alt || name} sizes={zoomed ? "200vw" : "100vw"} />
          </span>
        </div>
      </div>
      <div className="min-w-0 border-t border-line bg-paper pt-2 pb-[max(8px,var(--safe-bottom))]">
        <Thumbs name={name} items={items} index={index} onIndex={onIndex} captionOf={captionOf} className="thumbs--viewer" />
      </div>
    </div>,
    root,
  );
}
