/**
 * <MotionRoot /> — mount once in a layout (inside the router). Renders nothing; installs a handful of delegated,
 * passive listeners on the document so individual components need none:
 *
 *   press feedback      any element with data-press="clay|soft|icon" gets data-pressed on pointer-down (and Space/Enter),
 *                       removed on release, cancel, or when the pointer leaves it; motion.css does the rest.
 *                       data-haptic[="tap|select|success|warning|error"] adds a vibration where supported.
 *   interruption        any touch, key press or wheel while a view transition is animating ends that transition,
 *                       so the page is live at once and React is not left waiting for an animation.
 *   shared elements     a press inside a link/button claims the <SharedElement>s it contains.
 *   tier                <html data-motion="full|lite|reduced"> and, for the low-end tier, class fx-low (DESIGN.md
 *                       §6.5), kept in sync with the OS setting, device signals, measured jank and the override.
 *   ambient             <html data-motion-hidden> while the tab is hidden, data-motion-lowpower on low battery.
 *
 * Mounting it twice is harmless (reference counted).
 */
import { useEffect } from "react";
import { getMotionTier, haptic, subscribeMotionTier } from "./env";
import { preloadExtras } from "./lazy";
import { clearNavIntent } from "./nav-state";
import { notePointer, setMotionLive } from "./pointer";
import { claimWithin, rememberArmed } from "./share-registry";
import { haptics, type HapticKind } from "./tokens";
import { endActiveTransition, isTransitionActive } from "./vt";
import "./motion.css";

const PRESS = "[data-press]";
const CLAIM_SCOPE = "a[href], button, [data-share-scope]";
/** How far (px) a finger may wander outside a pressed element before the press is cancelled. */
const LEAVE_SLOP = 12;

type BatteryLike = { charging: boolean; level: number; addEventListener(type: string, listener: () => void): void };

function isDisabled(element: Element): boolean {
  return (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true";
}

function install(): () => void {
  const root = document.documentElement;
  const controller = new AbortController();
  const { signal } = controller;
  const passive = { capture: true, passive: true, signal } as const;

  // --- tier ---------------------------------------------------------------
  const applyTier = () => {
    const tier = getMotionTier();
    root.setAttribute("data-motion", tier);
    root.classList.toggle("fx-low", tier === "lite");
  };
  applyTier();
  const unsubscribe = subscribeMotionTier(applyTier);

  // --- ambient pause ------------------------------------------------------
  const onVisibility = () => root.toggleAttribute("data-motion-hidden", document.visibilityState === "hidden");
  onVisibility();
  document.addEventListener("visibilitychange", onVisibility, { signal });
  const battery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
  if (typeof battery === "function") {
    battery
      .call(navigator)
      .then((b) => {
        const update = () => root.toggleAttribute("data-motion-lowpower", !b.charging && b.level <= 0.2);
        update();
        b.addEventListener("levelchange", update);
        b.addEventListener("chargingchange", update);
      })
      .catch(() => {});
  }

  // --- press feedback -----------------------------------------------------
  let pressed: { element: HTMLElement; pointerId: number; rect: DOMRect } | null = null;
  let keyPressed: HTMLElement | null = null;
  /** A press that landed on <html> because a transition's snapshot covered the page: its click may need forwarding. */
  let rescue: { x: number; y: number; t: number } | null = null;

  const setPressed = (element: HTMLElement) => {
    element.removeAttribute("data-released");
    element.setAttribute("data-pressed", "");
    const kind = element.getAttribute("data-haptic");
    if (kind !== null) haptic(kind in haptics ? (kind as HapticKind) : "tap");
  };
  const clearPressed = (element: HTMLElement) => {
    if (!element.hasAttribute("data-pressed")) return;
    element.removeAttribute("data-pressed");
    // data-released plays the spring back; there is no spring to play under reduced motion.
    if (getMotionTier() !== "reduced") element.setAttribute("data-released", "");
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    const { rect } = pressed;
    const outside =
      event.clientX < rect.left - LEAVE_SLOP ||
      event.clientX > rect.right + LEAVE_SLOP ||
      event.clientY < rect.top - LEAVE_SLOP ||
      event.clientY > rect.bottom + LEAVE_SLOP;
    if (outside) endPress();
  };
  const endPress = () => {
    if (!pressed) return;
    clearPressed(pressed.element);
    pressed = null;
    document.removeEventListener("pointermove", onPointerMove, true);
  };

  const onPointerDown = (event: PointerEvent) => {
    notePointer(event.clientX, event.clientY);
    let target = event.target instanceof Element ? event.target : null;
    rescue = null;
    if (isTransitionActive() && endActiveTransition() && target === root) {
      // The transition's snapshot swallowed the hit test. The transition has been ended: find what the finger is
      // really on (available at once where the browser can skip synchronously, otherwise from the next frame).
      const real = document.elementFromPoint(event.clientX, event.clientY);
      if (real && real !== root) target = real;
      // A touch tap is hit-tested again on release and lands by itself. A mouse or pen click is dispatched to the
      // common ancestor of press and release — <html> — so it is forwarded when it arrives (see onClick).
      if (event.pointerType !== "touch") rescue = { x: event.clientX, y: event.clientY, t: performance.now() };
    }
    if (!target || (event.pointerType === "mouse" && event.button !== 0)) return;
    const scope = target.closest(CLAIM_SCOPE);
    if (scope) claimWithin(scope);
    const element = target.closest<HTMLElement>(PRESS);
    if (!element || isDisabled(element)) return;
    endPress();
    pressed = { element, pointerId: event.pointerId, rect: element.getBoundingClientRect() };
    setPressed(element);
    document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (pressed && event.pointerId === pressed.pointerId) endPress();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Shift" || event.key === "Control" || event.key === "Alt" || event.key === "Meta") return;
    if (isTransitionActive()) endActiveTransition();
    if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const scope = target.closest(CLAIM_SCOPE);
    if (scope) claimWithin(scope);
    const element = target.closest<HTMLElement>(PRESS);
    if (!element || isDisabled(element)) return;
    keyPressed = element;
    setPressed(element);
  };
  const onKeyUp = () => {
    if (!keyPressed) return;
    clearPressed(keyPressed);
    keyPressed = null;
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target === root && rescue && performance.now() - rescue.t < 900 && Math.hypot(event.clientX - rescue.x, event.clientY - rescue.y) < 14) {
      rescue = null;
      let real = document.elementFromPoint(event.clientX, event.clientY);
      while (real && !(real instanceof HTMLElement)) real = real.parentElement; // an SVG glyph inside a button
      if (real instanceof HTMLElement && real !== root) real.click();
      return;
    }
    rescue = null;
    const scope = target.closest(CLAIM_SCOPE);
    if (scope) claimWithin(scope);
    // A plain link must not inherit the transition an earlier <MotionLink> asked for.
    const anchor = target.closest("a[href]");
    if (anchor && !anchor.hasAttribute("data-motion-link")) clearNavIntent();
  };

  const onAnimationEnd = (event: AnimationEvent) => {
    if (event.animationName === "tt-press-out" && event.target instanceof Element) event.target.removeAttribute("data-released");
  };

  const onInterrupt = () => {
    if (isTransitionActive()) endActiveTransition();
  };
  // Capture phase: runs before React Router's own popstate listener, while the page being left is still on screen.
  const onPop = () => {
    rememberArmed();
    onInterrupt();
  };

  document.addEventListener("pointerdown", onPointerDown, passive);
  document.addEventListener("pointerup", onPointerEnd, passive);
  document.addEventListener("pointercancel", onPointerEnd, passive);
  document.addEventListener("keydown", onKeyDown, passive);
  document.addEventListener("keyup", onKeyUp, passive);
  document.addEventListener("click", onClick, { capture: true, signal });
  document.addEventListener("animationend", onAnimationEnd, passive);
  document.addEventListener("animationcancel", onAnimationEnd, passive);
  document.addEventListener("wheel", onInterrupt, passive);
  window.addEventListener("popstate", onPop, { capture: true, signal });
  window.addEventListener("blur", endPress, { signal });

  setMotionLive(true);
  root.setAttribute("data-motion-ready", "");

  // The on-demand half of the engine (fly-to-cart, sheets, morphs, rails) is fetched when the browser is idle,
  // so the first use is instant without it ever being part of the critical bundle.
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  const preload = () => {
    if (!signal.aborted && getMotionTier() !== "reduced") preloadExtras();
  };
  if (typeof idle === "function") idle(preload, { timeout: 4000 });
  else setTimeout(preload, 2000);

  return () => {
    controller.abort();
    document.removeEventListener("pointermove", onPointerMove, true);
    unsubscribe();
    setMotionLive(false);
    for (const name of ["data-motion", "data-motion-hidden", "data-motion-lowpower", "data-motion-ready"]) root.removeAttribute(name);
    root.classList.remove("fx-low");
  };
}

let mounts = 0;
let uninstall: (() => void) | null = null;

export function MotionRoot() {
  useEffect(() => {
    if (mounts++ === 0) uninstall = install();
    return () => {
      if (--mounts === 0) {
        uninstall?.();
        uninstall = null;
      }
    };
  }, []);
  return null;
}
