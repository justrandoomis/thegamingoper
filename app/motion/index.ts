/**
 * TamTam Motion Engine — public API. Import from "~/motion"; everything else in this folder is internal.
 * Full guide with examples: docs/MOTION.md. Specification: docs/DESIGN.md §7. Live reference: /motion.
 *
 * Always loaded (small): tokens, tier, <MotionRoot>, page transitions, shared elements, bubbles, number morph.
 * Loaded on demand (one chunk, fetched at idle): fly-to-cart, sheet physics, menus, theme cross-fade, rail behaviour.
 */

// Tokens (DESIGN.md §7.1) and the same springs as Web Animations timing. `bubble` is the arrival grammar
// (fromScale .94, 45 ms stagger, six slots) for code that animates arriving content itself (a FLIP of results).
export { durations, easings, springs, press, haptics, travel, bubble } from "./tokens";
export type { DurationName, EasingName, HapticKind, PressKind, Spring, SpringName } from "./tokens";
export { springTiming } from "./timing";
export type { SpringTiming } from "./timing";
// The spring solver itself (springValue, springVelocity, springKeyframes, springEasing) is deliberately not
// re-exported here so it stays out of the always-loaded bundle: import it from "~/motion/spring" when a
// gesture needs to hand its velocity to a spring.

// Environment: quality tier, the shopper's override, haptics. MOTION_TIER_SCRIPT is also importable on its own
// from "~/motion/tier-script" (the document head needs nothing else).
export { getMotionOverride, getMotionTier, haptic, setMotionOverride, useMotionTier, useReducedMotion } from "./env";
export type { MotionTier } from "./env";
export { MOTION_TIER_SCRIPT } from "./tier-script";

// Mount once in a layout.
export { MotionRoot } from "./root";

// Navigation grammar.
export { MotionLink, PageTransition, useDirectionMorph, useNavIntent } from "./nav";
export type { MotionHandle, MotionLinkProps, PageTransitionProps } from "./nav";
export type { NavKind, NavName } from "./nav-plan";

// Shared elements, arriving content, numbers.
export { SharedElement } from "./shared";
export type { SharedElementProps } from "./shared";
export { Bubble, BubbleGroup, useHydrating } from "./bubble";
export type { BubbleGroupProps, BubbleProps } from "./bubble";
export { NumberMorph } from "./number";
export type { NumberMorphProps } from "./number";

// Imperative pieces (implementation loads on demand; each call is instant either way).
export { dematerialize, directionMorph, flyToCart, materialize, themeMorph } from "./lazy";
export type { CartReceivedDetail, FlyHandle, FlyOptions } from "./fly";
export type { MaterializeOptions } from "./materialize";
export type { MorphOrigin } from "./morph";

// Sheets, rails, ambient motion.
export { useSheet } from "./sheet-hook";
export type { SheetHandle, SheetOptions } from "./sheet-hook";
export type { SheetEdge } from "./sheet";
export { useRail } from "./rail-hook";
export type { RailHandle, RailOptions } from "./rail-hook";
export { useAmbient } from "./ambient";
