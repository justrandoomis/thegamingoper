/**
 * Renders tokens.ts as CSS custom properties. The output is pasted into motion.css between the
 * `@generated tokens` markers by `npx tsx app/motion/__checks__/gen-css.mjs`; tests/motion.test.ts checks
 * that the stylesheet matches, so retuning tokens.ts without regenerating fails loudly.
 * Pure module (build-time only; not imported by the app).
 */
import { springEasing } from "./spring";
import { bubble, durations, easings, press, SPRING_NAMES, springFallbacks, springs, travel, type SpringName } from "./tokens";

export const TOKENS_START = "/* @generated tokens:start — edit app/motion/tokens.ts, then run: npx tsx app/motion/__checks__/gen-css.mjs */";
export const TOKENS_END = "/* @generated tokens:end */";

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The DESIGN.md name of a spring preset (aliases such as `gentle` resolve to `inflate`). */
export function canonicalSpring(name: SpringName): (typeof SPRING_NAMES)[number] {
  const spring = springs[name];
  return SPRING_NAMES.find((candidate) => springs[candidate] === spring)!;
}

/** Earlier token names are written as references to the DESIGN.md token they now equal, not as copies. */
const EASING_ALIASES: Record<string, string> = { out: "settle", in: "exit", inOut: "water", emphasized: "settle" };
const DURATION_ALIASES: Record<string, string> = { instant: "press", quick: "exit" };

export function renderTokenCss(): string {
  const base: string[] = [];
  for (const [name, ms] of Object.entries(durations)) {
    const alias = DURATION_ALIASES[name];
    base.push(alias ? `  --motion-duration-${kebab(name)}: var(--motion-duration-${alias});` : `  --motion-duration-${kebab(name)}: ${ms}ms;`);
  }
  for (const [name, curve] of Object.entries(easings)) {
    const alias = EASING_ALIASES[name];
    base.push(alias ? `  --motion-ease-${kebab(name)}: var(--motion-ease-${alias});` : `  --motion-ease-${kebab(name)}: ${curve};`);
  }
  for (const [name, depth] of Object.entries(press)) {
    base.push(`  --motion-press-${name}-scale: ${depth.scale};`);
    base.push(`  --motion-press-${name}-sink: ${depth.sink}px;`);
  }
  base.push(`  --motion-bubble-from: ${bubble.fromScale};`);
  base.push(`  --motion-stagger-step: ${bubble.staggerStep}ms;`);
  for (const [name, px] of Object.entries(travel)) base.push(`  --motion-travel-${name}: ${px}px;`);

  const fallback: string[] = [];
  const linear: string[] = [];
  for (const name of Object.keys(springs) as SpringName[]) {
    const canonical = canonicalSpring(name);
    if (canonical !== name) {
      fallback.push(`  --motion-spring-${name}: var(--motion-spring-${canonical});`);
      fallback.push(`  --motion-spring-${name}-duration: var(--motion-spring-${canonical}-duration);`);
      continue;
    }
    const { easing, duration } = springEasing(springs[name]);
    // Without linear(): the DESIGN.md fallback curve with its duration token.
    const plain = springFallbacks[canonical];
    fallback.push(`  --motion-spring-${name}: ${easings[plain.easing]};`);
    fallback.push(`  --motion-spring-${name}-duration: ${durations[plain.duration]}ms;`);
    linear.push(`    --motion-spring-${name}: ${easing};`);
    linear.push(`    --motion-spring-${name}-duration: ${duration}ms;`);
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
