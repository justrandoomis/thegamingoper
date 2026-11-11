/**
 * Sheet physics (loaded on demand through ./extras; the public entry is the `useSheet` hook in ./sheet-hook).
 *
 * A sheet is one element translated along one axis: up from the bottom edge (phones), or in from the inline-end edge
 * (tablet and desktop cart and filters, DESIGN.md §7.2). Positions are "how far it is pushed toward its edge", in px:
 *   0 = fully open … size = fully closed.  Snap points are open fractions of the sheet's own size.
 *
 *  - Drag: pointer-captured, 1:1 from the grab offset, rubber-band past the most open point.
 *  - Release: velocity from the last ~100 ms; momentum is projected to choose the snap point being aimed at.
 *  - Settle: the `sheet` spring, starting with the finger's velocity, sampled into one WAAPI animation (compositor).
 *  - Interrupt: grabbing a settling sheet reads its exact position from the closed-form spring and carries on.
 *  - Reduced motion: it appears and disappears with a 120 ms fade; dragging still works, release places it.
 */
import { getMotionTier } from "./env";
import { pickSnap, rubberBandClamp, velocityFrom, type Sample } from "./physics";
import { springKeyframes, springValue, springVelocity } from "./spring";
import { sheet as tokens, springs } from "./tokens";

export type SheetEdge = "bottom" | "inline-end";

export type SheetOptions = {
  /** Open fractions of a bottom sheet's height, e.g. [0.5, 1]. Default [1]. A side sheet always rests fully open. */
  snapPoints?: readonly number[];
  /** Index into snapPoints to open at. Default: the most open one. */
  initialSnap?: number;
  /** The sheet was dismissed (dragged or flicked away, Escape, or `close()`): unmount it. Without it the sheet cannot be dismissed. */
  onClose?: () => void;
  /** It came to rest at snapPoints[index]. */
  onSnap?: (index: number) => void;
};

export type SheetController = {
  /** Spring to snapPoints[index]. */
  snapTo(index: number): void;
  /** Spring away and call onClose. */
  close(): void;
  destroy(): void;
};

type Settle = { animation: Animation; from: number; to: number; velocity: number; index: number };

export function createSheet(
  element: HTMLElement,
  getOptions: () => SheetOptions,
  extra: { backdrop?: HTMLElement | null; animateIn?: boolean; edge?: SheetEdge } = {},
): SheetController {
  const backdrop = extra.backdrop ?? null;
  const side = extra.edge === "inline-end";
  /** +1 when "toward the edge" is +x / +y on screen; an inline-end sheet in RTL closes toward the left. */
  const sign = side && getComputedStyle(element).direction === "rtl" ? -1 : 1;
  const measure = () => (side ? element.offsetWidth : element.offsetHeight) || 1;
  const pointerAxis = (event: PointerEvent) => (side ? event.clientX * sign : event.clientY);
  let size = measure();
  let position = size;
  let settle: Settle | null = null;
  let backdropAnimation: Animation | null = null;
  let fade: Animation | null = null;
  let drag: { pointerId: number; grab: number; samples: Sample[]; moved: boolean; start: number } | null = null;
  let destroyed = false;

  const fractions = (): number[] => {
    // A side sheet has one resting point, fully open; snap points describe how far a bottom sheet rises.
    const points = side ? undefined : getOptions().snapPoints;
    const list = points && points.length > 0 ? [...points] : [1];
    return list.map((f) => Math.min(Math.max(f, 0.05), 1)).sort((a, b) => a - b);
  };
  /** Push distance (px) for each snap point: ascending fractions → descending px, so the most open is last. */
  const offsets = (): number[] => fractions().map((f) => (1 - f) * size);
  const dismissible = () => typeof getOptions().onClose === "function";
  const transform = (value: number) => (side ? `${(sign * value).toFixed(1)}px 0` : `0 ${value.toFixed(1)}px`);
  const openness = (value: number) => Math.min(Math.max(1 - value / size, 0), 1);

  const place = (value: number) => {
    position = value;
    element.style.translate = transform(value);
    if (backdrop) backdrop.style.opacity = String(openness(value));
  };

  const stopSettle = () => {
    if (!settle) return 0;
    // Exact state at this instant from the closed-form spring — no style read, no layout.
    const seconds = Number(settle.animation.currentTime ?? 0) / 1000;
    const motion = { from: settle.from, to: settle.to, velocity: settle.velocity };
    const value = springValue(springs.sheet, seconds, motion);
    settle.animation.cancel();
    backdropAnimation?.cancel();
    backdropAnimation = null;
    settle = null;
    place(value);
    return springVelocity(springs.sheet, seconds, motion);
  };

  const rest = (index: number) => {
    if (index < 0) getOptions().onClose?.();
    else getOptions().onSnap?.(index);
  };

  /** Reduced motion: no travel. Opening fades in, closing fades out, then it is placed. */
  const placeReduced = (to: number, index: number) => {
    fade?.cancel();
    if (index < 0) {
      fade = element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tokens.reducedFade, easing: "linear", fill: "forwards" });
      if (backdrop) backdrop.animate([{ opacity: backdrop.style.opacity || "1" }, { opacity: 0 }], { duration: tokens.reducedFade, easing: "linear", fill: "forwards" });
      fade.finished.then(
        () => {
          place(to);
          rest(index);
        },
        () => {},
      );
      return;
    }
    const wasClosed = position >= size - 0.5;
    place(to);
    if (wasClosed) {
      fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: tokens.reducedFade, easing: "linear" });
      if (backdrop) backdrop.animate([{ opacity: 0 }, { opacity: backdrop.style.opacity }], { duration: tokens.reducedFade, easing: "linear" });
    }
    rest(index);
  };

  /** `index` −1 means closed. */
  const settleTo = (index: number, velocity: number) => {
    stopSettle();
    const to = index < 0 ? size : offsets()[index];
    if (getMotionTier() === "reduced") {
      placeReduced(to, index);
      return;
    }
    const from = position;
    const { values, duration } = springKeyframes(springs.sheet, { from, to, velocity });
    const animation = element.animate(
      values.map((v) => ({ translate: transform(v) })),
      { duration, easing: "linear" },
    );
    if (backdrop) {
      backdropAnimation = backdrop.animate(
        values.map((v) => ({ opacity: openness(v) })),
        { duration, easing: "linear" },
      );
    }
    const current: Settle = { animation, from, to, velocity, index };
    settle = current;
    // The inline style holds the destination underneath the animation, so nothing jumps when it ends.
    // (If the settle is interrupted, stopSettle() re-places the sheet at its sampled position.)
    place(to);
    animation.finished.then(
      () => {
        if (settle !== current) return;
        settle = null;
        backdropAnimation = null;
        rest(index);
      },
      () => {},
    );
  };

  const handleOf = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    const handle = target.closest("[data-sheet-handle]");
    return handle !== null && element.contains(handle);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (destroyed || drag || !handleOf(event.target) || (event.pointerType === "mouse" && event.button !== 0)) return;
    stopSettle();
    const at = pointerAxis(event);
    drag = { pointerId: event.pointerId, grab: at - position, samples: [{ t: event.timeStamp, v: position }], moved: false, start: at };
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // pointer already gone
    }
    element.setAttribute("data-sheet-dragging", "");
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const at = pointerAxis(event);
    if (!drag.moved && Math.abs(at - drag.start) < tokens.slop) return;
    drag.moved = true;
    const points = offsets();
    const mostOpen = points[points.length - 1];
    const lowest = dismissible() ? size : points[0];
    place(rubberBandClamp(at - drag.grab, mostOpen, lowest, size));
    drag.samples.push({ t: event.timeStamp, v: position });
    if (drag.samples.length > 12) drag.samples.shift();
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { samples, moved } = drag;
    drag = null;
    element.removeAttribute("data-sheet-dragging");
    try {
      element.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    const points = offsets();
    const velocity = moved && event.type !== "pointercancel" ? velocityFrom(samples, event.timeStamp) : 0;
    const candidates = dismissible() ? [...points, size] : points;
    const chosen = pickSnap(candidates, position, velocity);
    settleTo(chosen >= points.length ? -1 : chosen, velocity);
  };

  const nearestIndex = (): number => {
    const points = offsets();
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i] - position) < Math.abs(points[best] - position)) best = i;
    return best;
  };

  const resize =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          const next = measure();
          if (next === size || drag) return;
          const index = settle ? settle.index : nearestIndex();
          size = next;
          if (settle) settleTo(index, 0);
          else if (index >= 0) place(offsets()[index]);
        })
      : null;

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);
  resize?.observe(element);

  // Open: start closed (unless told the sheet is already showing) and spring to the initial snap point.
  const points = fractions();
  const initial = Math.min(Math.max(getOptions().initialSnap ?? points.length - 1, 0), points.length - 1);
  if (extra.animateIn === false) {
    place(offsets()[initial]);
  } else {
    place(size);
    settleTo(initial, 0);
  }

  return {
    snapTo(index) {
      if (destroyed) return;
      const count = fractions().length;
      settleTo(Math.min(Math.max(index, 0), count - 1), 0);
    },
    close() {
      if (destroyed || !dismissible()) return;
      settleTo(-1, 0);
    },
    destroy() {
      destroyed = true;
      settle?.animation.cancel();
      backdropAnimation?.cancel();
      fade?.cancel();
      settle = null;
      resize?.disconnect();
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
    },
  };
}
