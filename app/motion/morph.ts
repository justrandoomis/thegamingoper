/**
 * Theme reveal (loaded on demand through ./extras; the public entry is `themeMorph` in ./lazy).
 *
 * A view transition that we own: the root is captured as "tt-theme-old", the theme is switched, and the root is
 * captured again as "tt-theme-new". Because the names differ, the new theme is a separate layer above the old one.
 * The reveal is transform-only: the new layer's clip box moves (a growing circle from the control, or a sweep across
 * the screen) while the snapshot inside it counter-moves by exactly the inverse, so the picture stands still and only
 * its visible area changes. No clip-path, mask or blur is animated, and every pixel is always fully one theme.
 */
import { getMotionTier } from "./env";
import { durations, easings } from "./tokens";
import { runTransition, supportsViewTransitions } from "./vt";

export type MorphOrigin = Element | { x: number; y: number } | null | undefined;

const GROUP = "::view-transition-group(tt-theme-new)";
const IMAGE = "::view-transition-new(tt-theme-new)";
const VARS = ["--morph-x", "--morph-y", "--morph-r", "--morph-w", "--morph-h", "--morph-glow"];

function pointOf(origin: MorphOrigin): { x: number; y: number } | null {
  if (!origin) return null;
  if (origin instanceof Element) {
    const rect = origin.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return origin;
}

/** Time (0–1) at which a cubic ease-in-out reaches `progress` (0–1). */
function easeInOutInverse(progress: number): number {
  return progress < 0.5 ? Math.cbrt(progress / 4) : 1 - Math.cbrt(2 * (1 - progress)) / 2;
}

/**
 * Keyframes for a clip circle scaling from `start` to 1 and for the picture inside it scaling by the inverse.
 * Stops are spaced geometrically (each 6 % larger than the last): between two stops both sides are interpolated
 * linearly, and with that spacing their product never strays more than 0.09 % from 1 — sub-pixel on a phone.
 */
export function counterScaleKeyframes(start: number, ratio = 1.06): { clip: Keyframe[]; picture: Keyframe[] } {
  const from = Math.min(Math.max(start, 0.005), 0.95);
  const steps = Math.max(Math.ceil(Math.log(1 / from) / Math.log(ratio)), 1);
  const clip: Keyframe[] = [];
  const picture: Keyframe[] = [];
  for (let k = 0; k <= steps; k++) {
    const scale = k === steps ? 1 : from * ratio ** k;
    const offset = k === steps ? 1 : k === 0 ? 0 : easeInOutInverse((scale - from) / (1 - from));
    clip.push({ offset, transform: `scale(${scale.toFixed(5)})` });
    picture.push({ offset, transform: `scale(${(1 / scale).toFixed(5)})` });
  }
  return { clip, picture };
}

function circle(root: HTMLElement, point: { x: number; y: number }): Animation[] {
  const snapshot = getComputedStyle(root, "::view-transition-old(tt-theme-old)");
  const width = parseFloat(snapshot.width) || window.innerWidth;
  const height = parseFloat(snapshot.height) || window.innerHeight;
  const x = Math.min(Math.max(point.x, 0), width);
  const y = Math.min(Math.max(point.y, 0), height);
  const radius = Math.ceil(Math.max(Math.hypot(x, y), Math.hypot(width - x, y), Math.hypot(x, height - y), Math.hypot(width - x, height - y)));
  root.style.setProperty("--morph-x", `${x}px`);
  root.style.setProperty("--morph-y", `${y}px`);
  root.style.setProperty("--morph-r", `${radius}px`);
  root.style.setProperty("--morph-w", `${width}px`);
  root.style.setProperty("--morph-h", `${height}px`);
  const { clip, picture } = counterScaleKeyframes(20 / radius);
  const timing = { duration: durations.slow, easing: "linear", fill: "both" as const };
  return [root.animate(clip, { ...timing, pseudoElement: GROUP }), root.animate(picture, { ...timing, pseudoElement: IMAGE })];
}

function sweep(root: HTMLElement, point: { x: number; y: number } | null): Animation[] {
  // Start from the side the control is on; without one, from the inline start.
  const rtl = getComputedStyle(root).direction === "rtl";
  const fromLeft = point ? point.x < window.innerWidth / 2 : !rtl;
  const sign = fromLeft ? -1 : 1;
  const timing = { duration: durations.slow, easing: easings.emphasized, fill: "both" as const };
  return [
    root.animate([{ transform: `translateX(${sign * 100}%)` }, { transform: "translateX(0)" }], { ...timing, pseudoElement: GROUP }),
    root.animate([{ transform: `translateX(${-sign * 100}%)` }, { transform: "translateX(0)" }], { ...timing, pseudoElement: IMAGE }),
  ];
}

/**
 * Switch the theme by calling `apply` inside a reveal. `toDark` picks the colour of the soft edge.
 * Falls back to calling `apply` directly when view transitions are unavailable or one of ours is already running.
 */
export function themeReveal(apply: () => void, origin: MorphOrigin, toDark: boolean): Promise<void> {
  const root = document.documentElement;
  if (!supportsViewTransitions() || root.hasAttribute("data-morph")) {
    apply();
    return Promise.resolve();
  }
  const point = pointOf(origin);
  const mode = point && getMotionTier() === "full" ? "circle" : "sweep";
  let animations: Animation[] = [];

  root.setAttribute("data-morph", mode);
  root.style.setProperty("--morph-glow", toDark ? "rgb(0 0 0 / 0.45)" : "rgb(255 255 255 / 0.65)");
  root.style.viewTransitionName = "tt-theme-old";

  const cleanup = () => {
    for (const animation of animations) animation.cancel();
    root.removeAttribute("data-morph");
    for (const name of VARS) root.style.removeProperty(name);
    if (root.style.viewTransitionName.startsWith("tt-theme")) root.style.viewTransitionName = "";
  };

  return runTransition(
    () => {
      apply();
      root.style.viewTransitionName = "tt-theme-new";
    },
    () => {
      animations = mode === "circle" && point ? circle(root, point) : sweep(root, point);
    },
  ).then(cleanup, cleanup);
}
