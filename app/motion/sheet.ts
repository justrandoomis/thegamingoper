/**
 * Sheet physics (loaded on demand through ./extras; the public entry is the `useSheet` hook in ./sheet-hook).
 *
 * A bottom sheet is one element translated along Y. Positions are "how far it is pushed down", in px:
 *   0 = fully open … height = fully closed.  Snap points are open fractions of the sheet's own height.
 *
 *  - Drag: pointer-captured, 1:1 from the grab offset, rubber-band past the most open point.
 *  - Release: velocity from the last ~100 ms; momentum is projected to choose the snap point being aimed at.
 *  - Settle: the `sheet` spring, starting with the finger's velocity, sampled into one WAAPI animation (compositor).
 *  - Interrupt: grabbing a settling sheet reads its exact position from the closed-form spring and carries on.
 *  - Reduced motion: no travel — it is placed, with a short fade.
 */
import { getMotionTier } from "./env";
import { pickSnap, rubberBandClamp, velocityFrom, type Sample } from "./physics";
import { springKeyframes, springValue, springVelocity } from "./spring";
import { sheet as tokens, springs } from "./tokens";

export type SheetOptions = {
  /** Open fractions of the sheet's height, e.g. [0.5, 1]. Default [1]. */
  snapPoints?: readonly number[];
  /** Index into snapPoints to open at. Default: the most open one. */
  initialSnap?: number;
  /** The sheet was dismissed (dragged or flicked down, or `close()`): unmount it. Without it the sheet cannot be dismissed. */
  onClose?: () => void;
  /** It came to rest at snapPoints[index]. */
  onSnap?: (index: number) => void;
};

export type SheetController = {
  /** Spring to snapPoints[index]. */
  snapTo(index: number): void;
  /** Spring down and call onClose. */
  close(): void;
  destroy(): void;
};

type Settle = { animation: Animation; from: number; to: number; velocity: number; index: number };

export function createSheet(
  element: HTMLElement,
  getOptions: () => SheetOptions,
  extra: { backdrop?: HTMLElement | null; animateIn?: boolean } = {},
): SheetController {
  const backdrop = extra.backdrop ?? null;
  let height = element.offsetHeight || 1;
  let y = height; // current push-down in px
  let settle: Settle | null = null;
  let backdropAnimation: Animation | null = null;
  let drag: { pointerId: number; grab: number; samples: Sample[]; moved: boolean; startY: number } | null = null;
  let destroyed = false;

  const fractions = (): number[] => {
    const points = getOptions().snapPoints;
    const list = points && points.length > 0 ? [...points] : [1];
    return list.map((f) => Math.min(Math.max(f, 0.05), 1)).sort((a, b) => a - b);
  };
  /** Push-down px for each snap point, most open first is last (ascending fractions → descending px). */
  const offsets = (): number[] => fractions().map((f) => (1 - f) * height);
  const dismissible = () => typeof getOptions().onClose === "function";

  const place = (value: number) => {
    y = value;
    element.style.translate = `0 ${value.toFixed(1)}px`;
    if (backdrop) backdrop.style.opacity = String(Math.min(Math.max(1 - value / height, 0), 1));
  };

  const stopSettle = () => {
    if (!settle) return;
    // Exact state at this instant from the closed-form spring — no style read, no layout.
    const seconds = Number(settle.animation.currentTime ?? 0) / 1000;
    const motion = { from: settle.from, to: settle.to, velocity: settle.velocity };
    const position = springValue(springs.sheet, seconds, motion);
    settle.animation.cancel();
    backdropAnimation?.cancel();
    backdropAnimation = null;
    settle = null;
    place(position);
    return springVelocity(springs.sheet, seconds, motion);
  };

  const rest = (index: number) => {
    if (index < 0) getOptions().onClose?.();
    else getOptions().onSnap?.(index);
  };

  /** `index` −1 means closed. */
  const settleTo = (index: number, velocity: number) => {
    stopSettle();
    const to = index < 0 ? height : offsets()[index];
    if (getMotionTier() === "reduced") {
      place(to);
      if (index >= 0) element.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 120, easing: "linear" });
      rest(index);
      return;
    }
    const from = y;
    const { values, duration } = springKeyframes(springs.sheet, { from, to, velocity });
    const animation = element.animate(
      values.map((v) => ({ translate: `0 ${v.toFixed(1)}px` })),
      { duration, easing: "linear" },
    );
    if (backdrop) {
      backdropAnimation = backdrop.animate(
        values.map((v) => ({ opacity: Math.min(Math.max(1 - v / height, 0), 1) })),
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
    drag = { pointerId: event.pointerId, grab: event.clientY - y, samples: [{ t: event.timeStamp, v: y }], moved: false, startY: event.clientY };
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // pointer already gone
    }
    element.setAttribute("data-sheet-dragging", "");
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < tokens.slop) return;
    drag.moved = true;
    const points = offsets();
    const mostOpen = points[points.length - 1];
    const lowest = dismissible() ? height : points[0];
    place(rubberBandClamp(event.clientY - drag.grab, mostOpen, lowest, height));
    drag.samples.push({ t: event.timeStamp, v: y });
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
    const candidates = dismissible() ? [...points, height] : points;
    const chosen = pickSnap(candidates, y, velocity);
    settleTo(chosen >= points.length ? -1 : chosen, velocity);
  };

  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const next = element.offsetHeight || 1;
    if (next === height || drag) return;
    const index = settle ? settle.index : nearestIndex();
    height = next;
    if (settle) settleTo(index, 0);
    else if (index >= 0) place(offsets()[index]);
  }) : null;

  const nearestIndex = (): number => {
    const points = offsets();
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i] - y) < Math.abs(points[best] - y)) best = i;
    return best;
  };

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
    place(height);
    settleTo(initial, 0);
  }

  return {
    snapTo(index) {
      if (destroyed) return;
      const count = fractions().length;
      settleTo(Math.min(Math.max(index, 0), count - 1), 0);
    },
    close() {
      if (destroyed) return;
      if (!dismissible()) return;
      settleTo(-1, 0);
    },
    destroy() {
      destroyed = true;
      settle?.animation.cancel();
      backdropAnimation?.cancel();
      settle = null;
      resize?.disconnect();
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
    },
  };
}
