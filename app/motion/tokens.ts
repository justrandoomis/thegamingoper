/**
 * TamTam Motion Engine — tokens. The one place to retune how the store moves.
 *
 * Springs are described the way a designer feels them, not the way an integrator needs them:
 *   response      seconds for one undamped oscillation — smaller is quicker
 *   dampingRatio  1 = no overshoot, < 1 = overshoot, the lower the bouncier
 *
 * `spring.ts` turns a preset into a CSS `linear()` easing + duration and into WAAPI keyframes;
 * `npm run`-less generator: `npx tsx app/motion/__checks__/gen-css.ts` rewrites the generated block of
 * motion.css from this file (tests/motion.test.ts fails when the two drift apart).
 *
 * Pure module: no DOM, safe on the server.
 */

export type Spring = { response: number; dampingRatio: number };

export const springs = {
  /** Controls and small state changes: press release, chips, toggles. No visible overshoot. */
  snappy: { response: 0.22, dampingRatio: 0.9 },
  /** Things that arrive: bubbles, shared elements, menus. A whisper of overshoot, like soft clay settling. */
  gentle: { response: 0.34, dampingRatio: 0.72 },
  /** Visible bounce. Momentum only — a flick, a throw, an arrival with speed. Never for a plain state change. */
  bouncy: { response: 0.4, dampingRatio: 0.55 },
  /** Sheets and drawers settling after a drag (takes the finger's velocity). */
  sheet: { response: 0.34, dampingRatio: 0.82 },
  /** Fly-to-cart travel: critically damped, leaves fast and lands softly. */
  fly: { response: 0.42, dampingRatio: 1 },
} as const satisfies Record<string, Spring>;

export type SpringName = keyof typeof springs;

/** Duration palette in milliseconds. Button feedback ≤ 80, micro-interactions 140–220, pages ≤ 320. */
export const durations = {
  instant: 80,
  quick: 140,
  base: 220,
  page: 320,
  slow: 480,
} as const;

export type DurationName = keyof typeof durations;

/** Non-spring curves (CSS timing functions). */
export const easings = {
  /** Fast start, long soft landing — the default for things entering. */
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** Accelerating exit — things leaving get out of the way. */
  in: "cubic-bezier(0.5, 0, 0.9, 0.5)",
  /** Symmetric — things that move from place to place on screen. */
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  /** Long tail, for page-sized movement. */
  emphasized: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

export type EasingName = keyof typeof easings;

/**
 * Page transitions. When content becomes ready to show while a page transition is still animating, the rest of
 * the animation plays `hurry` times faster so the content is not held back for it.
 */
export const page = { hurry: 4 } as const;

/** Press feedback depths (`data-press` values). `scale` is the pressed scale, `sink` the downward shift in px. */
export const press = {
  clay: { scale: 0.97, sink: 1 },
  soft: { scale: 0.98, sink: 0 },
  icon: { scale: 0.94, sink: 0 },
} as const;

export type PressKind = keyof typeof press;

/** Content arriving (Bubble): start scale and the cap on a group's total stagger. */
export const bubble = { fromScale: 0.92, staggerStep: 45, staggerMax: 400 } as const;

/** Sheet physics. */
export const sheet = {
  /** UIScrollView's normal deceleration rate, per millisecond. */
  decelerationRate: 0.998,
  /** Rubber-band stiffness past the ends (0.55 is the iOS constant). */
  rubber: 0.55,
  /** Drag distance in px before a press on the handle becomes a drag. */
  slop: 6,
} as const;

/** Fly-to-cart. */
export const fly = { puck: 44, maxConcurrent: 4, arcMin: 48, arcMax: 180 } as const;

/** Vibration patterns in ms (navigator.vibrate). Restrained on purpose. */
export const haptics = {
  tap: 8,
  select: 12,
  success: [10, 40, 18],
  warning: [18, 60, 18],
  error: [28, 50, 28, 50, 28],
} as const;

export type HapticKind = keyof typeof haptics;
