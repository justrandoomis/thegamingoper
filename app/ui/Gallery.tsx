import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";

import { getArt, isPhoto, type PhotoKind } from "~/art";
import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { ImageRef } from "~/lib/dto";
import { SharedElement } from "~/motion";
import { cx } from "./cx";
import { Glass } from "./Glass";
import { IconKey } from "./IconKey";
import { KeyBank, useControllable } from "./KeyBank";
import type { Gel } from "./PlatformLed";
import { ProductImage } from "./ProductCard";
import { Stage } from "./Stage";

/**
 * The product page's gallery on the Lit Stage (docs/DESIGN.md §2, §9.6, reference b.png): the picture floats in its
 * platform's light; underneath, inside the stage, the caption of the current view at the start, the thumbnail keys
 * in a well in the middle (the current one held down with an ink ring) and "1 من 4" at the end.
 *
 *   <Gallery name={p.name} items={p.media.map((image) => ({ image }))} gel="handheld" flush
 *            sharedName={`product-image:${p.id}`} priority top={<StageOrbs />} />
 *   <Gallery name={u.name} items={photos} evidence="used" sharedName={`used-image:${u.id}`} />   never lit
 *
 * Swipe the picture sideways (direction follows the reading direction), use the thumbnails (arrow keys, Home/End),
 * or ← → on the focused picture. Tapping the picture opens the full-screen viewer: an opaque floor, the same
 * thumbnail keys in a glass strip, the close key at the end, double-tap or the zoom key to look closer (pinch zoom
 * is the browser's own). The viewer is a native modal <dialog>: focus moves in and is trapped, Escape closes it and
 * focus returns to the picture.
 *
 * Captions come from the catalogue photo's kind ("الصورة الرئيسية", "محتويات العلبة", "الغلاف" …) unless you pass
 * one. `evidence="used"` labels every picture as a photo of this unit or, honestly, "صورة توضيحية — ليست صورة
 * الجهاز نفسه" — order real defect photos first (DESIGN.md §9.6).
 */
export type GalleryItem = {
  image: ImageRef;
  /** Words for this view ("الواجهة"). Default: from the photo's kind, or the evidence label for used units. */
  caption?: string;
};

export type GalleryProps = {
  /** Product name — the alt text when an image has none, and the viewer's title. */
  name: string;
  items: readonly GalleryItem[];
  /** The card this page opens from: `product-image:${id}` (ProductCard's default) or `used-image:${id}`. */
  sharedName?: string;
  /** Platform light. Leave null for used units (real photos are never lit). */
  gel?: Gel | null;
  /** "used": every picture is labelled as a real photo of this unit or as an illustration. */
  evidence?: "product" | "used";
  /** Inside the stage along its top edge (back / cart orbs). */
  top?: ReactNode;
  /** Square top corners: the stage touches the top of the screen. */
  flush?: boolean;
  /** The first picture is the page's LCP element. */
  priority?: boolean;
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
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
  return Math.min(total - 1, Math.max(0, index + delta));
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

export function Gallery({ name, items, sharedName, gel = null, evidence = "product", top, flush = false, priority = false, index, defaultIndex = 0, onIndexChange, className }: GalleryProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const [rawCurrent, setCurrent] = useControllable<number>(index, defaultIndex, onIndexChange);
  const total = items.length;
  const current = stepIndex(rawCurrent, 0, total);
  const [viewerOpen, setViewerOpen] = useState(false);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const swallowClick = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);

  const go = (next: number) => {
    const target = stepIndex(next, 0, total);
    if (target !== current) setCurrent(target);
  };

  const captionOf = (item: GalleryItem | undefined): string => {
    if (!item) return "";
    if (item.caption) return item.caption;
    if (evidence === "used") return t(item.image.isIllustration ? "gallery.illustration" : "gallery.real");
    const art = item.image.artKey ? getArt(item.image.artKey) : undefined;
    return t(`gallery.kinds.${isPhoto(art) ? KIND_KEY[art.kind] : "photo"}`);
  };

  if (total === 0) {
    // Nothing to show is said plainly: an unlit, empty stage keeps the page's geometry.
    return <Stage size="product" gel={null} flush={flush} top={top} className={className} />;
  }

  const item = items[current];
  const caption = captionOf(item);
  const count = t("gallery.count", { n: f.number(current + 1), total: f.number(total) });
  const illustrationOnUsed = evidence === "used" && item.image.isIllustration;
  const thumbs = items.map((entry, i) => ({
    value: String(i),
    ariaLabel: t("gallery.thumb", { n: f.number(i + 1), caption: captionOf(entry) }),
    media: <ProductImage image={entry.image} alt="" sizes="56px" shadow={false} pose={0} fit="cover" />,
  }));
  const compact = total > 4;

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
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
    event.preventDefault();
    go(current + (forward ? 1 : -1));
  };

  const bar = (
    <div className={cx("grid items-center gap-x-2.5 gap-y-1.5 type-caption text-ink-2", compact ? "grid-cols-[1fr_auto]" : "grid-cols-[1fr_auto_1fr]")}>
      <span className={cx("min-w-0 truncate", illustrationOnUsed && "font-medium text-warn")} aria-live="polite">
        {caption}
      </span>
      {compact ? (
        <span className="text-end">
          <bdi className="nums">{count}</bdi>
        </span>
      ) : null}
      <div className={cx("min-w-0 overflow-x-auto py-1", compact ? "col-span-2 justify-self-center" : "")}>
        <KeyBank kind="thumb" aria-label={t("gallery.label", { name })} items={thumbs} value={String(current)} onChange={(value) => go(Number(value))} />
      </div>
      {compact ? null : (
        <span className="text-end">
          <bdi className="nums">{count}</bdi>
        </span>
      )}
    </div>
  );

  const stage = (
    <Stage size="product" gel={evidence === "used" ? null : gel} flush={flush} top={top} bottom={bar}>
      <button
        ref={opener}
        type="button"
        className="grid size-full cursor-zoom-in touch-pan-y touch-pinch-zoom items-end justify-items-center rounded-lg"
        aria-label={t("gallery.open", { caption })}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = null)}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <ProductImage
          image={item.image}
          alt={item.image.alt || name}
          sizes="(min-width: 1024px) 560px, (min-width: 768px) 70vw, 82vw"
          priority={priority && current === 0}
          pose={evidence === "used" ? 0 : undefined}
          shadow={evidence === "used" ? false : undefined}
        />
      </button>
    </Stage>
  );

  return (
    <div className={cx("min-w-0", className)}>
      {sharedName ? (
        <SharedElement name={sharedName} target>
          {stage}
        </SharedElement>
      ) : (
        stage
      )}
      {viewerOpen ? (
        <GalleryViewer
          name={name}
          items={items}
          index={current}
          onIndex={go}
          captionOf={captionOf}
          thumbs={thumbs}
          onClose={() => {
            setViewerOpen(false);
            opener.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}

type ViewerProps = {
  name: string;
  items: readonly GalleryItem[];
  index: number;
  onIndex: (index: number) => void;
  captionOf: (item: GalleryItem | undefined) => string;
  thumbs: { value: string; ariaLabel: string; media: ReactNode }[];
  onClose: () => void;
};

/** The full-screen viewer: a native modal dialog on the opaque floor (DESIGN.md §9.6). Mounted while open. */
function GalleryViewer({ name, items, index, onIndex, captionOf, thumbs, onClose }: ViewerProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden"; // the page under the viewer does not scroll
    if (!el.open) el.showModal();
    const onNativeClose = () => close.current();
    el.addEventListener("close", onNativeClose);
    return () => {
      el.removeEventListener("close", onNativeClose);
      root.style.overflow = overflow;
      if (el.open) el.close();
    };
  }, []);

  // A new picture starts unzoomed.
  useEffect(() => setZoomed(false), [index]);

  const item = items[index];
  const caption = captionOf(item);

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

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if ((event.target as Element).closest('[role="radiogroup"]')) return; // the thumbnail keys move by themselves
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
    event.preventDefault();
    onIndex(stepIndex(index, forward ? 1 : -1, items.length));
  };

  return (
    <dialog
      ref={dialog}
      aria-label={t("gallery.viewer", { name })}
      onKeyDown={onKeyDown}
      className="m-0 size-full max-h-none max-w-none overflow-hidden bg-floor p-0 text-ink"
    >
      <div className="grid size-full grid-rows-[auto_minmax(0,1fr)_auto]">
        <div className="flex items-center justify-between gap-3 px-4 pt-[max(12px,var(--safe-top))] pb-2">
          <p className="min-w-0 truncate type-label text-ink-2">
            <bdi className="nums">{t("gallery.count", { n: f.number(index + 1), total: f.number(items.length) })}</bdi> · {caption}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <IconKey icon="magnifying-glass" label={t(zoomed ? "gallery.zoomOut" : "gallery.zoomIn")} held={zoomed} onClick={() => toggleZoom()} />
            <IconKey icon="x" label={t("gallery.close")} onClick={() => dialog.current?.close()} />
          </div>
        </div>
        <div ref={scroller} className="relative overflow-auto overscroll-contain" onDoubleClick={(event) => toggleZoom({ x: event.clientX, y: event.clientY })}>
          <div className={cx("grid place-items-center p-4", zoomed ? "h-[200%] w-[200%] cursor-zoom-out" : "size-full cursor-zoom-in")}>
            <span className="render-slot size-full">
              <ProductImage image={item.image} alt={item.image.alt || name} sizes={zoomed ? "200vw" : "100vw"} pose={0} shadow={false} />
            </span>
          </div>
        </div>
        <Glass edge="bottom" className="flex justify-center rounded-t-xl px-4 pt-3 pb-[max(12px,var(--safe-bottom))]">
          <div className="max-w-full overflow-x-auto py-1">
            <KeyBank kind="thumb" aria-label={t("gallery.label", { name })} items={thumbs} value={String(index)} onChange={(value) => onIndex(Number(value))} />
          </div>
        </Glass>
      </div>
    </dialog>
  );
}
