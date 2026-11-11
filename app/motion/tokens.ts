/**
 * TamTam Motion Engine — tokens. The script-side copy of docs/DESIGN.md §7.1 (same names, same values);
 * app/styles/tokens.css is the stylesheet-side copy (`--t-*`, `--ease-*`, `--spring-*`). tests/motion.test.ts
 * fails when this file, motion.css's generated block and tokens.css disagree.
 *
 * Springs are described the way a designer feels them, not the way an integrator needs them:
 *   response      seconds for one undamped oscillation — smaller is quicker
 *   dampingRatio  1 = no overshoot, < 1 = overshoot, the lower the bouncier
 *   settleMs      the time it takes to come within 0.2 % of rest (DESIGN.md's `--spring-*-t`)
 *
 * `spring.ts` turns a preset into a CSS `linear()` easing and into WAAPI keyframes; after retuning, regenerate
 * motion.css with `npx tsx app/motion/__checks__/gen-css.mjs`.
 *
 * Pure module: no DOM, safe on the server.
 */

export type Spring = {
  response: number;
  dampingRatio: number;
  /** Settle time in ms (within 0.2 % of rest). Computed from the spring when absent. */
  settleMs?: number;
};

const PRESS = { response: 0.16, dampingRatio: 0.62, settleMs: 260 } as const;
const SQUISH = { response: 0.26, dampingRatio: 0.5, settleMs: 510 } as const;
const INFLATE = { response: 0.28, dampingRatio: 0.68, settleMs: 430 } as const;
const SETTLE = { response: 0.3, dampingRatio: 1, settleMs: 410 } as const;
const SHEET = { response: 0.3, dampingRatio: 0.86, settleMs: 390 } as const;

export const springs = {
  /** Key release, chip and thumbnail settle, toggle. 8 % overshoot. */
  press: PRESS,
  /** The cart bead receiving a product, socket refill. Small objects only. 16 % overshoot. */
  squish: SQUISH,
  /** Content inflating into reserved space, render swap on the stage, intro layers. 5 % overshoot. */
  inflate: INFLATE,
  /** Shared-element zoom, sideways push, anything large. No overshoot: large things never overshoot. */
  settle: SETTLE,
  /** Sheets, menus, drag release (carries the finger's velocity). 0.5 % overshoot. */
  sheet: SHEET,
  /** @deprecated Earlier name of `press`. */
  snappy: PRESS,
  /** @deprecated Earlier name of `inflate`. */
  gentle: INFLATE,
  /** @deprecated Earlier name of `squish`. */
  bouncy: SQUISH,
  /** @deprecated Earlier name of `settle`. */
  fly: SETTLE,
} as const satisfies Record<string, Spring>;

export type SpringName = keyof typeof springs;

/** The five springs of DESIGN.md §7.1, without the earlier aliases. */
export const SPRING_NAMES = ["press", "squish", "inflate", "settle", "sheet"] as const satisfies readonly SpringName[];

/** Durations in milliseconds (DESIGN.md §7.1). Nothing outside the intro lasts longer than 600 ms. */
export const durations = {
  /** Press-down; feedback must be visible within this. */
  press: 80,
  /** Anything leaving. */
  exit: 140,
  /** Chips, toggles, digit roll. */
  micro: 160,
  /** Key release (fallback curve). */
  release: 180,
  /** Theme cross-fade. */
  theme: 200,
  /** Menus in, language in (DESIGN.md §7.2). */
  base: 220,
  /** Inflate (fallback curve). */
  reveal: 240,
  /** Sheets and menus (fallback curve). */
  sheet: 280,
  /** Shared-element zoom and push (fallback curve). */
  page: 320,
  /** Fly to cart, nominal. A real flight takes 420 ms + 0.3 ms per px of distance, at most 600 ms (`fly` below). */
  fly: 460,
  /** @deprecated Earlier name of `press`. */
  instant: 80,
  /** @deprecated Earlier name of `exit`. */
  quick: 140,
  /** @deprecated Not part of DESIGN.md; the engine no longer uses it. */
  slow: 480,
} as const;

export type DurationName = keyof typeof durations;

/** Curves (DESIGN.md §7.1): fallbacks for the springs where `linear()` is unsupported, and the non-spring moves. */
export const easings = {
  /** Fallback for `settle` and `sheet`; entrances. */
  settle: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  /** Fallback for `press`, `squish` and `inflate`. */
  squish: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  /** Exits. */
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  /** Symmetric moves: push, digit roll, light cross-fade. */
  water: "cubic-bezier(0.4, 0, 0.2, 1)",
  /** @deprecated Earlier name; now the same curve as `settle`. */
  out: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  /** @deprecated Earlier name; now the same curve as `exit`. */
  in: "cubic-bezier(0.4, 0, 1, 1)",
  /** @deprecated Earlier name; now the same curve as `water`. */
  inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
  /** @deprecated Earlier name; now the same curve as `settle`. */
  emphasized: "cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

export type EasingName = keyof typeof easings;

/**
 * Where `linear()` is unsupported each spring runs as a curve with a duration token (DESIGN.md §7.1:
 * "the cubic-bezier fallbacks below are used with the duration tokens").
 */
export const springFallbacks: Record<(typeof SPRING_NAMES)[number], { easing: EasingName; duration: DurationName }> = {
  press: { easing: "squish", duration: "release" },
  squish: { easing: "squish", duration: "reveal" },
  inflate: { easing: "squish", duration: "reveal" },
  settle: { easing: "settle", duration: "page" },
  sheet: { easing: "settle", duration: "sheet" },
};

/**
 * Page transitions. When content becomes ready to show while a page transition is still animating, the rest of
 * the animation plays `hurry` times faster so the content is not held back for it.
 */
export const page = { hurry: 4 } as const;

/** Distances of the navigation grammar, in px (DESIGN.md §7.2). */
export const travel = {
  /** Sideways push: each view slides this far. */
  push: 24,
  /** Language switch: the content slides this far toward the new reading direction's start. */
  direction: 16,
  /** Menus drop from their trigger by this much. */
  menu: 8,
  /** A sheet-like child page rises by this much. */
  rise: 48,
  /** The default page fade settles in from this far below. */
  fade: 8,
} as const;

/**
 * Press feedback (`data-press` values). `scale` is the pressed scale, `sink` the downward shift in px.
 * The design system's keys (DESIGN.md §6.1, app/styles/materials.css) set `--press-scale: 1; --press-sink: 0` on
 * `.key[data-press]` and move only their cap on the engine's `data-pressed`, so the wall never moves.
 */
export const press = {
  clay: { scale: 0.97, sink: 1 },
  soft: { scale: 0.98, sink: 0 },
  icon: { scale: 0.94, sink: 0 },
} as const;

export type PressKind = keyof typeof press;

/**
 * Content arriving (Bubble, DESIGN.md "inflate"): from scale .94 with opacity 0 → 1 on the `inflate` spring,
 * 45 ms apart, at most six items staggered (the rest appear with the sixth). A custom step is capped so the
 * whole wave never takes longer than `staggerMax`. (Design System v2 §2.11: .94, was .86 — v2 cards are open, with no
 * box to inflate, so a deep scale read as a jump.)
 */
export const bubble = { fromScale: 0.94, staggerStep: 45, staggerSlots: 6, staggerMax: 400 } as const;

/** Sheet physics. */
export const sheet = {
  /** UIScrollView's normal deceleration rate, per millisecond. */
  decelerationRate: 0.998,
  /** Rubber-band stiffness past the ends (0.55 is the iOS constant). */
  rubber: 0.55,
  /** Drag distance in px before a press on the handle becomes a drag. */
  slop: 6,
  /** Reduced motion: a sheet appears and disappears with a fade this long (DESIGN.md §7.3). */
  reducedFade: 120,
  /** At or above this viewport width (px) `edge: "auto"` sheets come from the inline-end edge (tablet and desktop). */
  sideFrom: 768,
} as const;

/** Fly to cart (DESIGN.md §7.2). */
export const fly = {
  /** Bead diameter in px, and the scale it lands at. */
  bead: 22,
  endScale: 0.55,
  /** The arc's control point sits this far (px) above the higher of the two ends, halfway across. */
  lift: 70,
  /** Duration: base + perPx × distance, at most max (ms). */
  baseMs: 420,
  perPxMs: 0.3,
  maxMs: 600,
  easing: "cubic-bezier(0.4, 0, 0.6, 1)",
  /** Beads in flight at once; further taps go straight to the count. */
  maxConcurrent: 3,
  /** The cart bead's squish on arrival: scale(1.4, .68) → (.88, 1.16) → 1. */
  squishMs: 340,
} as const;

/**
 * Low-end tier (DESIGN.md §6.5): chosen from device signals before first paint, and at runtime after
 * `longFrames` animation frames longer than `longFrameMs` inside one transition (sticky for the session).
 * `smallScreen`: a device whose shorter screen side is below this many px is a phone.
 */
export const lowEnd = { longFrameMs: 50, longFrames: 3, smallScreen: 768 } as const;

/** Idle motion starts this long after the page loaded (DESIGN.md §7.2 "Idle motion policy"). */
export const ambient = { startAfterMs: 2000 } as const;

/** Vibration patterns in ms (navigator.vibrate). Restrained on purpose; `tap` is DESIGN.md's commit-key haptic. */
export const haptics = {
  tap: 8,
  select: 12,
  success: [10, 40, 18],
  warning: [18, 60, 18],
  error: [28, 50, 28, 50, 28],
} as const;

export type HapticKind = keyof typeof haptics;
