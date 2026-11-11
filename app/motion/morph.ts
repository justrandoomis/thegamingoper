/**
 * Theme morph (loaded on demand through ./extras; the public entry is `themeMorph` in ./lazy).
 *
 * DESIGN.md §7.2 "the light changes, not the objects": a view transition that we own swaps data-theme and
 * cross-fades the two snapshots over 200 ms on the water curve, so nothing repaints per frame and nothing moves.
 * Fixed chrome fades with the page. A cross-fade between a light and a dark page passes through low contrast for a
 * few frames around its middle; check-system.mjs measures how long (docs/MOTION.md).
 */
import { runTransition, supportsViewTransitions } from "./vt";

export type MorphOrigin = Element | { x: number; y: number } | null | undefined;

/**
 * Switch the theme by calling `apply` inside a 200 ms cross-fade. Falls back to calling `apply` directly when view
 * transitions are unavailable or one of ours is already running.
 */
export function themeCrossFade(apply: () => void): Promise<void> {
  const root = document.documentElement;
  if (!supportsViewTransitions() || root.hasAttribute("data-morph")) {
    apply();
    return Promise.resolve();
  }
  root.setAttribute("data-morph", "theme");
  const cleanup = (): void => {
    root.removeAttribute("data-morph");
  };
  return runTransition(apply).then(cleanup, cleanup);
}
