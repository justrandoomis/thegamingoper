/**
 * Renders tokens.ts as CSS custom properties. The output is pasted into motion.css between the
 * `@generated tokens` markers by `npx tsx app/motion/__checks__/gen-css.mjs`; tests/motion.test.ts checks
 * that the stylesheet matches, so retuning tokens.ts without regenerating fails loudly.
 * Pure module (build-time only; not imported by the app).
 */
import { springEasing } from "./spring";
import { bubble, durations, easings, press, springs } from "./tokens";

export const TOKENS_START = "/* @generated tokens:start — edit app/motion/tokens.ts, then run: npx tsx app/motion/__checks__/gen-css.mjs */";
export const TOKENS_END = "/* @generated tokens:end */";

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function renderTokenCss(): string {
  const base: string[] = [];
  for (const [name, ms] of Object.entries(durations)) base.push(`  --motion-duration-${kebab(name)}: ${ms}ms;`);
  for (const [name, curve] of Object.entries(easings)) base.push(`  --motion-ease-${kebab(name)}: ${curve};`);
  for (const [name, depth] of Object.entries(press)) {
    base.push(`  --motion-press-${name}-scale: ${depth.scale};`);
    base.push(`  --motion-press-${name}-sink: ${depth.sink}px;`);
  }
  base.push(`  --motion-bubble-from: ${bubble.fromScale};`);
  base.push(`  --motion-stagger-step: ${bubble.staggerStep}ms;`);

  const fallback: string[] = [];
  const linear: string[] = [];
  for (const [name, spring] of Object.entries(springs)) {
    const { easing, duration } = springEasing(spring);
    // Browsers without linear() get a plain ease-out of the same length.
    fallback.push(`  --motion-spring-${name}: ${easings.out};`);
    fallback.push(`  --motion-spring-${name}-duration: ${duration}ms;`);
    linear.push(`    --motion-spring-${name}: ${easing};`);
  }

  return [
    TOKENS_START,
    ":root {",
    ...base,
    ...fallback,
    "}",
    "@supports (animation-timing-function: linear(0, 1)) {",
    "  :root {",
    ...linear,
    "  }",
    "}",
    TOKENS_END,
  ].join("\n");
}

/** Replace the generated block inside a stylesheet's source. Throws when the markers are missing. */
export function replaceTokenBlock(css: string): string {
  const start = css.indexOf(TOKENS_START);
  const end = css.indexOf(TOKENS_END);
  if (start < 0 || end < 0 || end < start) throw new Error("motion.css is missing the @generated tokens markers");
  return css.slice(0, start) + renderTokenCss() + css.slice(end + TOKENS_END.length);
}
