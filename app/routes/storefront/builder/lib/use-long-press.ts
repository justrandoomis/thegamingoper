/**
 * Press-and-hold on a game card opens its details (docs/switch-builder.md §6.5).
 *
 *   const hold = useLongPress({ onLongPress: () => openSheet(game.id) });
 *   <button type="button" aria-pressed={chosen} onClick={toggle} {...hold}>…</button>
 *
 * Rules: the hold fires after 450 ms; it is cancelled by a movement of more than 6 CSS px, by `pointercancel` (the
 * browser took the gesture for a scroll), by leaving the element, by any scroll and by the tab being hidden. Only the
 * primary pointer counts (a second finger is a pinch, not a hold) and only the main mouse button. No haptics
 * (DESIGN.md §7.0: the haptic is for the primary add only).
 *
 * After it fires, the click that belongs to the release is swallowed — WHEREVER it lands. The hold opens a modal sheet,
 * so by the release the page is inert and the sheet's scrim lies over the card: a release click there would close the
 * sheet it just opened (iOS sends one). So for that one click a capturing listener on the window eats it before React
 * sees it, and the card's own `onClickCapture` does the same where no window exists. The swallow is forgotten
 * LONG_PRESS_CLICK_WINDOW_MS after the pointer comes up anywhere (Android sends no click after a long press), on the
 * next press anywhere (a quick tap on the sheet's own keys), and at the latest after LONG_PRESS_SWALLOW_MAX_MS — so a
 * later tap or a keyboard activation of the card (Enter on the focus the sheet gives back) is never eaten. While it
 * lasts, the touch context menu is prevented too;
 * the touch long-press menu on the card itself always is (a mouse's right click keeps the browser's menu).
 *
 * The card's CSS should also say `-webkit-touch-callout: none; user-select: none` (no iOS picture callout or text
 * selection under a held finger) and its picture `draggable={false}` — `LONG_PRESS_STYLE` below, or the same
 * declarations in builder.css. Keyboard and screen-reader users open the same sheet with the card's info key.
 *
 * The timing lives in `createLongPress` (pure: no React; the window is passed in) so it is tested with fake timers
 * (tests/switch-builder-sheet.test.ts); `useLongPress` only keeps one controller per card.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type MouseEvent, type PointerEvent } from "react";

export interface LongPressOptions {
  onLongPress: () => void;
  /** Hold time before it fires (default 450 ms). */
  delayMs?: number;
  /** Movement that cancels the hold, in CSS px (default 6). */
  moveTolerancePx?: number;
  disabled?: boolean;
}

/** Spread these on the card's button. After a long press fires, the click that follows is swallowed. */
export interface LongPressHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
}

export const LONG_PRESS_DELAY_MS = 450;
export const LONG_PRESS_MOVE_TOLERANCE_PX = 6;
/** After the release, how long the click that belongs to a fired hold may take to arrive (iOS sends it late). */
export const LONG_PRESS_CLICK_WINDOW_MS = 400;
/** A swallow never outlives this, even if no release is ever seen (a finger held on and on). */
export const LONG_PRESS_SWALLOW_MAX_MS = 10_000;

/** For a held card: no iOS callout over its picture, no text selection under the finger. */
export const LONG_PRESS_STYLE: CSSProperties = { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" };

/** The parts of a pointer event the timing reads (a React or DOM PointerEvent fits). */
export type PressPoint = {
  pointerId: number;
  pointerType: string;
  button: number;
  isPrimary?: boolean;
  clientX: number;
  clientY: number;
};

/** The parts of a click or contextmenu event the controller may cancel. */
export type Cancelable = { preventDefault(): void; stopPropagation(): void };

export interface LongPressController {
  down(event: PressPoint): void;
  move(event: PressPoint): void;
  /** The pointer came up over the element. */
  up(): void;
  /** `pointercancel`, `pointerleave`. */
  cancel(): void;
  contextMenu(event: Cancelable): void;
  /** Call from the capture phase of `click` on the element: swallows the click that follows a fired hold. */
  click(event: Cancelable): void;
  dispose(): void;
  /** A hold is being timed now. */
  readonly pressing: boolean;
  /** A hold fired and its click has not been swallowed or forgotten yet. */
  readonly swallowing: boolean;
}

type Timer = ReturnType<typeof setTimeout>;
const CAPTURE = { capture: true } as const;
const PASSIVE_CAPTURE = { capture: true, passive: true } as const;

/**
 * The hold's timing. `read` returns the current options (a hook passes its latest props); `windowTarget` receives the
 * capturing listeners: `scroll` while a hold is timed, `click` / `pointerdown` / `pointerup` / `pointercancel` /
 * `contextmenu` while a fired hold's click is awaited (default: `window` in a browser, none elsewhere).
 */
export function createLongPress(
  read: () => LongPressOptions,
  windowTarget: EventTarget | null = typeof window === "undefined" ? null : window,
): LongPressController {
  let timer: Timer | null = null;
  let start: { id: number; x: number; y: number } | null = null;
  let swallow = false;
  let forget: Timer | null = null;
  let lifetime: Timer | null = null;
  /** The last press came from a finger or a pen: its context menu is the long-press menu, never wanted here. */
  let touchLike = false;
  let timing = false;
  let awaiting = false;

  const onScroll = () => stopTiming();
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") stopTiming();
  };
  const onWindowClick = (event: Event) => {
    if (!swallow) return;
    event.preventDefault();
    event.stopPropagation();
    clearSwallow();
  };
  const onWindowRelease = () => forgetSoon();
  /** A new press anywhere (a tap on the sheet's keys): the hold's click is not coming any more. A second finger of the
   *  same hand is not a new press. */
  const onWindowPress = (event: Event) => {
    if ((event as { isPrimary?: boolean }).isPrimary === false) return;
    clearSwallow();
  };
  const onWindowMenu = (event: Event) => {
    if (swallow) event.preventDefault();
  };

  /** Listeners while a hold is timed. */
  const watchTiming = (on: boolean) => {
    if (timing === on) return;
    timing = on;
    const hasDocument = typeof document !== "undefined" && windowTarget !== null;
    if (on) {
      windowTarget?.addEventListener("scroll", onScroll, PASSIVE_CAPTURE);
      if (hasDocument) document.addEventListener("visibilitychange", onVisibility);
    } else {
      windowTarget?.removeEventListener("scroll", onScroll, CAPTURE);
      if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
    }
  };

  /** Listeners while a fired hold's click is awaited. */
  const watchRelease = (on: boolean) => {
    if (awaiting === on || !windowTarget) return;
    awaiting = on;
    if (on) {
      windowTarget.addEventListener("click", onWindowClick, CAPTURE);
      windowTarget.addEventListener("pointerdown", onWindowPress, PASSIVE_CAPTURE);
      windowTarget.addEventListener("pointerup", onWindowRelease, PASSIVE_CAPTURE);
      windowTarget.addEventListener("pointercancel", onWindowRelease, PASSIVE_CAPTURE);
      windowTarget.addEventListener("contextmenu", onWindowMenu, CAPTURE);
    } else {
      windowTarget.removeEventListener("click", onWindowClick, CAPTURE);
      windowTarget.removeEventListener("pointerdown", onWindowPress, CAPTURE);
      windowTarget.removeEventListener("pointerup", onWindowRelease, CAPTURE);
      windowTarget.removeEventListener("pointercancel", onWindowRelease, CAPTURE);
      windowTarget.removeEventListener("contextmenu", onWindowMenu, CAPTURE);
    }
  };

  function stopTiming() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    start = null;
    watchTiming(false);
  }

  function clearSwallow() {
    if (forget !== null) clearTimeout(forget);
    if (lifetime !== null) clearTimeout(lifetime);
    forget = null;
    lifetime = null;
    swallow = false;
    watchRelease(false);
  }

  /** The finger or button is up: the click of a fired hold comes now or never. */
  function forgetSoon() {
    if (!swallow) return;
    if (forget !== null) clearTimeout(forget);
    forget = setTimeout(clearSwallow, LONG_PRESS_CLICK_WINDOW_MS);
  }

  function fire() {
    timer = null;
    start = null;
    watchTiming(false);
    const options = read();
    if (options.disabled) return;
    swallow = true;
    watchRelease(true);
    lifetime = setTimeout(clearSwallow, LONG_PRESS_SWALLOW_MAX_MS);
    options.onLongPress();
  }

  return {
    down(event) {
      if (read().disabled) return;
      touchLike = event.pointerType !== "mouse";
      if (event.isPrimary === false) {
        // a second finger: a pinch or a two-finger scroll, not a hold
        stopTiming();
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) return;
      // a new press: the click of an earlier hold is no longer coming
      clearSwallow();
      stopTiming();
      start = { id: event.pointerId, x: event.clientX, y: event.clientY };
      watchTiming(true);
      timer = setTimeout(fire, read().delayMs ?? LONG_PRESS_DELAY_MS);
    },
    move(event) {
      if (!start || event.pointerId !== start.id) return;
      const tolerance = read().moveTolerancePx ?? LONG_PRESS_MOVE_TOLERANCE_PX;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > tolerance) stopTiming();
    },
    up() {
      stopTiming();
      forgetSoon();
    },
    cancel() {
      stopTiming();
      forgetSoon();
    },
    contextMenu(event) {
      if (read().disabled) return;
      if (start !== null || swallow || touchLike) event.preventDefault();
    },
    click(event) {
      if (!swallow) return;
      event.preventDefault();
      event.stopPropagation();
      clearSwallow();
    },
    dispose() {
      stopTiming();
      clearSwallow();
    },
    get pressing() {
      return start !== null;
    },
    get swallowing() {
      return swallow;
    },
  };
}

export function useLongPress(options: LongPressOptions): LongPressHandlers {
  const latest = useRef(options);
  // before any event of the new render can run (a press timed across a re-render reads the newest callback)
  useLayoutEffect(() => {
    latest.current = options;
  });
  const controller = useRef<LongPressController | null>(null);
  if (controller.current === null) controller.current = createLongPress(() => latest.current);
  useEffect(() => {
    const own = controller.current;
    return () => own?.dispose();
  }, []);

  return useMemo<LongPressHandlers>(() => {
    const press = () => controller.current as LongPressController;
    return {
      onPointerDown: (event) => press().down(event),
      onPointerMove: (event) => press().move(event),
      onPointerUp: () => press().up(),
      onPointerCancel: () => press().cancel(),
      onPointerLeave: () => press().cancel(),
      onContextMenu: (event) => press().contextMenu(event),
      onClickCapture: (event) => press().click(event),
    };
  }, []);
}
