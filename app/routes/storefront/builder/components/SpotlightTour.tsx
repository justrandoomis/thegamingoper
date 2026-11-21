/**
 * A spotlight guide over a rendered page (docs/switch-builder.md §6.7): the page dims, the part being explained stays
 * lit and ringed, and an opaque note beside it says what the part means. The builder drives it through
 * ./BuilderTour (useBuilderTour); this component only shows one guide.
 *
 *   <SpotlightTour steps={[{ target: "meter", title, text }, …]} index={i} labels={…} leaving={!open}
 *                  onNext={…} onBack={…} onSkip={…} onFinish={…} onMissing={(target) => …} onExited={…} />
 *
 * How it is drawn (DESIGN.md: no box-shadow spread, no animated clip-path, only transform and opacity move):
 *   · the dim is one --scrim layer with a `clip-path: path(evenodd, …)` cut-out — the viewport minus a rounded hole
 *     around the part (8px of air), measured with getBoundingClientRect (physical px, so it is right in RTL too);
 *   · a 2px --focus ring sits just outside the hole; the scrim and the ring are one layer, and between two parts the
 *     old layer fades out while the new one fades in (two layers take turns) — the clip itself never animates;
 *   · the note is an opaque --paper card with the counter «2 من 5», «تخطَّ» first, the title, the text, a screen-reader
 *     line naming the lit part, and «السابق» / «التالي» («أنهِ الدليل» on the last part). It is placed beside the hole
 *     with the menus' own placement (~/ui/Menu placeMenu); when neither side has room it docks at the screen edge away
 *     from the part and the hole is trimmed so the two never overlap. The first note is there from the first frame
 *     (only the dim fades in); later notes arrive with the menus' 8px drop (materialize).
 * Each part is brought into view first (scrollIntoView works under the modal layer's scroll lock; the page's
 * scroll-padding keeps it clear of the sticky header and the task bar), and everything is measured again on resize,
 * on scroll, when the part or the note changes size and when the fonts arrive. When the guide closes the page goes back
 * to the scroll position it had. A part that left the page is reported (`onMissing`) so the guide skips it.
 *
 * Behaviour comes from the kit's modal layer (~/ui/Dialog useOverlayRoot + useModalLayer): the page behind is inert and
 * does not scroll, the focus moves to the note (a labelled dialog) and is trapped, Escape and Android's back skip, and
 * the focus goes back to what opened it (the «?» key). ← / → move through the parts in the reading direction. Tapping
 * the dim does nothing. Reduced motion: fades only (fadeElement / materialize turn into 120ms cross-fades).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { materialize } from "~/motion";
import { fadeElement, useModalLayer, useOverlayRoot } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { placeMenu } from "~/ui/Menu";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import "../builder-sheet.css";

export type SpotlightStep = {
  /** The `data-tour` value of the part to light. */
  target: string;
  title: string;
  text: string;
};

export type SpotlightLabels = {
  next: string;
  back: string;
  skip: string;
  finish: string;
  /** «2 من 5». */
  count: (n: number, total: number) => string;
  /** The screen-reader line that names the lit part: «الجزء المُضاء من الصفحة: …». */
  highlighted: (name: string) => string;
};

export type SpotlightTourProps = {
  steps: readonly SpotlightStep[];
  index: number;
  labels: SpotlightLabels;
  /** The guide was closed: it fades out, then calls `onExited`. */
  leaving: boolean;
  onNext: () => void;
  onBack: () => void;
  /** «تخطَّ», Escape, Android's back. */
  onSkip: () => void;
  /** The last part's «أنهِ الدليل». */
  onFinish: () => void;
  /** The part on screen is not on the page (any more). */
  onMissing: (target: string) => void;
  onExited: () => void;
};

/* ───────────────────────────── geometry (pure) ───────────────────────────── */

export type Box = { left: number; top: number; right: number; bottom: number };

/** Air between the part and the edge of the hole. */
export const HOLE_PADDING = 8;
/** The hole never touches the screen's edge. */
const HOLE_EDGE = 4;
/** The ring's width, drawn just outside the hole. */
const RING = 2;
const NOTE_GAP = 12;
const NOTE_MARGIN = 16;

/** The air around a part: 8px, less around a small inline part (a figure in a line) so the ring keeps off its neighbours. */
export function holePadding(part: Box): number {
  const side = Math.min(part.right - part.left, part.bottom - part.top);
  return Math.max(4, Math.min(HOLE_PADDING, Math.round(side / 4)));
}

/** The hole around a part's box, with air, kept inside the viewport. Pure. */
export function holeAround(part: Box, view: { width: number; height: number }, padding = holePadding(part)): Box {
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const left = clamp(part.left - padding, HOLE_EDGE, view.width - HOLE_EDGE);
  const top = clamp(part.top - padding, HOLE_EDGE, view.height - HOLE_EDGE);
  const right = clamp(part.right + padding, left, view.width - HOLE_EDGE);
  const bottom = clamp(part.bottom + padding, top, view.height - HOLE_EDGE);
  return { left, top, right, bottom };
}

const n = (value: number) => String(Math.round(value * 10) / 10);

/** The evenodd path of the dim: the whole viewport, minus a rounded rectangle. Pure. */
export function spotlightClip(view: { width: number; height: number }, hole: Box, radius: number): string {
  const r = Math.max(0, Math.min(radius, (hole.right - hole.left) / 2, (hole.bottom - hole.top) / 2));
  const { left: x0, top: y0, right: x1, bottom: y1 } = hole;
  const outer = `M0 0H${n(view.width)}V${n(view.height)}H0Z`;
  const inner =
    `M${n(x0 + r)} ${n(y0)}H${n(x1 - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x1)} ${n(y0 + r)}V${n(y1 - r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x1 - r)} ${n(y1)}H${n(x0 + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x0)} ${n(y1 - r)}V${n(y0 + r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x0 + r)} ${n(y0)}Z`;
  return `path(evenodd, "${outer} ${inner}")`;
}

/* ───────────────────────────── the page's parts ───────────────────────────── */

/** The first part with this `data-tour` value that is on screen (a part may exist twice: the task bar and the aside). */
export function visibleTarget(target: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const element of document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(target)}"]`)) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden") return element;
  }
  return null;
}

/** What a screen reader would call the part: its label, else its words (shortened). */
function nameOf(element: HTMLElement): string {
  const clip = (text: string) => {
    const words = text.replace(/\s+/g, " ").trim();
    return words.length > 120 ? `${words.slice(0, 119)}…` : words;
  };
  const label = element.getAttribute("aria-label");
  if (label && label.trim() !== "") return clip(label);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim() !== "") return clip(text);
  }
  return clip(element.innerText || element.textContent || "");
}

/** The hole's corner: the part's own corner plus the air, at most half the hole. */
function holeRadius(element: HTMLElement, hole: Box, padding: number): number {
  const style = getComputedStyle(element);
  const own = Number.parseFloat(style.borderStartStartRadius || style.borderTopLeftRadius || "0");
  const radius = (Number.isFinite(own) && own > 0 ? own : 12) + padding;
  return Math.min(radius, (hole.right - hole.left) / 2, (hole.bottom - hole.top) / 2);
}

/* ───────────────────────────── the overlay ───────────────────────────── */

export function SpotlightTour({ steps, index, labels, leaving, onNext, onBack, onSkip, onFinish, onMissing, onExited }: SpotlightTourProps) {
  const root = useOverlayRoot();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const note = useRef<HTMLDivElement | null>(null);
  const layerA = useRef<HTMLDivElement | null>(null);
  const layerB = useRef<HTMLDivElement | null>(null);
  /** The layer that shows the current part (they take turns). */
  const front = useRef<0 | 1>(0);
  const shown = useRef(false);
  /** Where the page was scrolled when the guide came (it goes back there). */
  const scrollAt = useRef<{ x: number; y: number } | null>(null);
  const [litName, setLitName] = useState("");
  const titleId = useId();
  const textId = useId();
  const litId = useId();
  const step = steps[index] ?? null;
  const last = index >= steps.length - 1;

  const latest = useRef({ step, onMissing, onExited });
  useLayoutEffect(() => {
    latest.current = { step, onMissing, onExited };
  });

  useModalLayer({ root, host, active: !leaving, onEscape: onSkip, initialFocus: () => note.current });

  /** Draws the current part on layer `which`; false when the part is not on screen. */
  const draw = (which: 0 | 1): boolean => {
    const current = latest.current.step;
    const layer = (which === 0 ? layerA : layerB).current;
    const card = note.current;
    if (!host || !layer || !card || !current) return false;
    const element = visibleTarget(current.target);
    if (!element) return false;
    const view = host.getBoundingClientRect();
    const size = { width: view.width, height: view.height };
    const rtl = getComputedStyle(host).direction === "rtl";
    const rect = element.getBoundingClientRect();
    const part = { left: rect.left - view.left, top: rect.top - view.top, right: rect.right - view.left, bottom: rect.bottom - view.top };
    const padding = holePadding(part);
    let hole = holeAround(part, size, padding);

    // the note: beside the hole when one side has room for it, else docked at the edge away from the part
    const noteSize = { width: card.offsetWidth, height: card.offsetHeight };
    const place = placeMenu(hole, noteSize, size, { rtl, align: "start", gap: NOTE_GAP, margin: NOTE_MARGIN });
    if (place.maxHeight >= noteSize.height) {
      card.removeAttribute("data-dock");
      card.style.insetInlineStart = `${place.inlineStart}px`;
      card.style.insetBlockStart = `${place.blockStart}px`;
    } else {
      const dock = (hole.top + hole.bottom) / 2 < size.height / 2 ? "end" : "start";
      card.setAttribute("data-dock", dock);
      card.style.removeProperty("inset-inline-start");
      card.style.removeProperty("inset-block-start");
      const box = card.getBoundingClientRect();
      // the hole stops short of the note (the part is taller than the room the note leaves)
      hole =
        dock === "end"
          ? { ...hole, bottom: Math.max(hole.top + 24, Math.min(hole.bottom, box.top - view.top - NOTE_GAP)) }
          : { ...hole, top: Math.min(hole.bottom - 24, Math.max(hole.top, box.bottom - view.top + NOTE_GAP)) };
    }

    const radius = holeRadius(element, hole, padding);
    const scrim = layer.querySelector<HTMLElement>(".sbt-scrim");
    const ring = layer.querySelector<HTMLElement>(".sbt-ring");
    if (scrim) scrim.style.clipPath = spotlightClip(size, hole, radius);
    if (ring) {
      ring.style.insetInlineStart = `${(rtl ? size.width - hole.right : hole.left) - RING}px`;
      ring.style.insetBlockStart = `${hole.top - RING}px`;
      ring.style.inlineSize = `${hole.right - hole.left + 2 * RING}px`;
      ring.style.blockSize = `${hole.bottom - hole.top + 2 * RING}px`;
      ring.style.setProperty("--sbt-radius", `${radius + RING}px`);
    }
    return true;
  };

  // A new part: bring it into view, draw it on the other layer, cross-fade, move the note and the focus.
  useLayoutEffect(() => {
    if (!host || leaving || !step) return;
    const element = visibleTarget(step.target);
    if (!element) {
      onMissing(step.target);
      return;
    }
    if (scrollAt.current === null) scrollAt.current = { x: window.scrollX, y: window.scrollY };
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const previous = front.current;
    const next: 0 | 1 = shown.current ? (previous === 0 ? 1 : 0) : 0;
    front.current = next;
    draw(next);
    // docked: the part is tall or at an edge — put its top under the header to give the note the rest, and draw again
    if (note.current?.hasAttribute("data-dock")) {
      element.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
      draw(next);
    }
    const incoming = next === 0 ? layerA.current : layerB.current;
    const outgoing = next === 0 ? layerB.current : layerA.current;
    if (incoming) void fadeElement(incoming, 1);
    if (shown.current && outgoing) void fadeElement(outgoing, 0);
    const card = note.current;
    if (card) {
      // the first note is there from the first frame («تخطَّ» with it); the next ones drop in like a menu
      if (shown.current) {
        const box = element.getBoundingClientRect();
        void materialize(card, { from: { x: box.left + box.width / 2, y: box.top + box.height / 2 } });
      }
      card.focus({ preventScroll: true });
    }
    shown.current = true;
    setLitName(nameOf(element));
    // one run per part shown — never on a mere re-render of the page (that would pull the focus back to the note)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw reads the latest props
  }, [host, index, step?.target, leaving]);

  // Keep the cut-out on its part: resize, scroll (rails, the sheet under it), the part or the note changing size, fonts.
  useEffect(() => {
    if (!host || leaving) return;
    let frame = 0;
    const redraw = () => {
      frame = 0;
      if (draw(front.current)) return;
      const current = latest.current.step;
      if (current && !visibleTarget(current.target)) latest.current.onMissing(current.target);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(redraw);
    };
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    const element = step ? visibleTarget(step.target) : null;
    if (element) observer?.observe(element);
    if (note.current) observer?.observe(note.current);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed for each part
  }, [host, index, step?.target, leaving]);

  // Leaving: the page goes back to where it was, the whole guide fades, then it unmounts.
  const wasLeaving = useRef(false);
  useLayoutEffect(() => {
    if (!leaving) {
      if (wasLeaving.current && host) void fadeElement(host, 1); // opened again while it was leaving
      wasLeaving.current = false;
      return;
    }
    wasLeaving.current = true;
    const at = scrollAt.current;
    if (at) window.scrollTo({ left: at.x, top: at.y, behavior: "instant" });
    scrollAt.current = null;
    if (!host) {
      latest.current.onExited();
      return;
    }
    let cancelled = false;
    void fadeElement(host, 0).then(() => {
      if (!cancelled) latest.current.onExited();
    });
    return () => {
      cancelled = true;
    };
  }, [leaving, host]);

  if (!root || !step) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = (event.key === "ArrowRight") !== rtl;
    event.preventDefault();
    if (forward) {
      if (last) onFinish();
      else onNext();
    } else if (index > 0) {
      onBack();
    }
  };

  return createPortal(
    <div ref={setHost} className="sbt" inert={leaving || undefined}>
      <div ref={layerA} className="sbt-layer" aria-hidden="true">
        <div className="sbt-scrim" />
        <div className="sbt-ring" />
      </div>
      <div ref={layerB} className="sbt-layer" aria-hidden="true">
        <div className="sbt-scrim" />
        <div className="sbt-ring" />
      </div>
      <div
        key={index}
        ref={note}
        className="sbt-note"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${textId} ${litId}`}
        tabIndex={-1}
        data-layer-panel=""
        onKeyDown={onKeyDown}
      >
        <div className="sbt-note__head">
          <p className="sbt-note__count nums">{labels.count(index + 1, steps.length)}</p>
          {/* «تخطَّ» is the first stop of the note, there from the first frame */}
          <Key variant="ghost" size="sm" onClick={onSkip} className="sbt-note__skip">
            {labels.skip}
          </Key>
        </div>
        <h2 id={titleId} className="sbt-note__title">
          {step.title}
        </h2>
        <p id={textId} className="sbt-note__text">
          {step.text}
        </p>
        <VisuallyHidden id={litId}>{litName ? labels.highlighted(litName) : ""}</VisuallyHidden>
        <div className="sbt-note__keys">
          {index > 0 ? (
            <Key variant="ghost" size="sm" icon="arrow-left" onClick={onBack}>
              {labels.back}
            </Key>
          ) : null}
          <Key size="sm" iconEnd={last ? undefined : "arrow-right"} onClick={last ? onFinish : onNext}>
            {last ? labels.finish : labels.next}
          </Key>
        </div>
      </div>
    </div>,
    root,
  );
}
