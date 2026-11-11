/**
 * Spring maths. Closed-form damped harmonic oscillator (unit mass), so a spring can be evaluated at any
 * time without stepping — which is what makes hand-off and interruption exact:
 *
 *   springValue(spring, t, { from, to, velocity })      position at t seconds
 *   springVelocity(spring, t, …)                        velocity at t (units per second)
 *   springDuration(spring, …)                           seconds until it is visually at rest
 *   springEasing(spring)                                { easing: "linear(…)", duration: ms } for CSS / WAAPI
 *   springKeyframes(spring, { from, to, velocity })     sampled values for a WAAPI animation that carries velocity
 *
 * Pure module: no DOM, safe on the server.
 */
import type { Spring } from "./tokens";

export type SpringMotion = {
  /** Start value. Default 0. */
  from?: number;
  /** Rest value. Default 1. */
  to?: number;
  /** Initial velocity in value-units per second (positive moves toward larger values). Default 0. */
  velocity?: number;
};

type Solved = { value: (t: number) => number; velocity: (t: number) => number };

/** Solve x'' + 2ζω x' + ω² x = 0 for the displacement from rest, y0 = from − to, y'(0) = velocity. */
function solve(spring: Spring, y0: number, v0: number): Solved {
  const omega = (2 * Math.PI) / Math.max(spring.response, 1e-4);
  const zeta = Math.max(spring.dampingRatio, 0);

  if (zeta < 1 - 1e-6) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const a = y0;
    const b = (v0 + zeta * omega * y0) / wd;
    const decay = zeta * omega;
    return {
      value: (t) => Math.exp(-decay * t) * (a * Math.cos(wd * t) + b * Math.sin(wd * t)),
      velocity: (t) => {
        const e = Math.exp(-decay * t);
        const cos = Math.cos(wd * t);
        const sin = Math.sin(wd * t);
        return e * (-decay * (a * cos + b * sin) + wd * (b * cos - a * sin));
      },
    };
  }

  if (zeta <= 1 + 1e-6) {
    const c = v0 + omega * y0;
    return {
      value: (t) => Math.exp(-omega * t) * (y0 + c * t),
      velocity: (t) => Math.exp(-omega * t) * (c - omega * (y0 + c * t)),
    };
  }

  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - root);
  const r2 = -omega * (zeta + root);
  const c1 = (v0 - r2 * y0) / (r1 - r2);
  const c2 = y0 - c1;
  return {
    value: (t) => c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t),
    velocity: (t) => c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t),
  };
}

function solved(spring: Spring, motion: SpringMotion): { s: Solved; to: number } {
  const from = motion.from ?? 0;
  const to = motion.to ?? 1;
  return { s: solve(spring, from - to, motion.velocity ?? 0), to };
}

/** Position of the spring `t` seconds after release. */
export function springValue(spring: Spring, t: number, motion: SpringMotion = {}): number {
  const { s, to } = solved(spring, motion);
  return to + s.value(Math.max(t, 0));
}

/** Velocity of the spring `t` seconds after release, in value-units per second. */
export function springVelocity(spring: Spring, t: number, motion: SpringMotion = {}): number {
  return solved(spring, motion).s.velocity(Math.max(t, 0));
}

const STEP = 1 / 120;
const MAX_SECONDS = 3;

/**
 * Seconds until the spring stays within `precision` of rest. `precision` is in value-units:
 * leave it undefined for normalized 0 → 1 springs (0.2 % of the travel), pass 0.5 for pixels.
 */
export function springDuration(spring: Spring, motion: SpringMotion = {}, precision?: number): number {
  const from = motion.from ?? 0;
  const to = motion.to ?? 1;
  const eps = precision ?? Math.max(Math.abs(to - from), 1e-6) * 0.002;
  const { s } = solved(spring, motion);
  let last = 0;
  for (let t = 0; t <= MAX_SECONDS; t += STEP) {
    if (Math.abs(s.value(t)) > eps) last = t;
  }
  return Math.min(last + STEP, MAX_SECONDS);
}

export type SpringEasing = {
  /** CSS timing function, e.g. `linear(0, 0.21 4.2%, …, 1)`. */
  easing: string;
  /** Duration in ms that the easing was computed for. */
  duration: number;
};

function round(value: number, digits: number): string {
  const s = value.toFixed(digits);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Ramer–Douglas–Peucker on (x, y) points: keeps the fewest stops that stay within `tolerance` of the curve. */
function simplify(points: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    let worst = 0;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = points[i];
      // Vertical distance to the chord: `linear()` interpolates along x, so that is the error that shows.
      const onChord = ay + ((by - ay) * (x - ax)) / (bx - ax);
      const d = Math.abs(y - onChord);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

const easingCache = new Map<string, SpringEasing>();

/**
 * A spring as a CSS `linear()` easing plus the duration it needs. Works in `transition`, `animation`
 * and `element.animate({ … }, { easing, duration })`. Normalized: 0 at the start, 1 at rest; overshoot
 * shows up as values above 1.
 */
export function springEasing(spring: Spring, options: { tolerance?: number } = {}): SpringEasing {
  const tolerance = options.tolerance ?? 0.002;
  const key = `${spring.response}|${spring.dampingRatio}|${tolerance}`;
  const cached = easingCache.get(key);
  if (cached) return cached;

  const seconds = springDuration(spring);
  // Sampled at 500 Hz before simplifying: a quick spring curves hard in its first few milliseconds, and
  // straight segments between coarser samples would be off by more than the tolerance there.
  const count = Math.max(Math.ceil(seconds * 500), 2);
  const { s } = solved(spring, {});
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= count; i++) {
    const x = i / count;
    points.push([x, i === count ? 1 : 1 + s.value(x * seconds)]);
  }
  points[0] = [0, 0];
  const stops = simplify(points, tolerance);
  const body = stops
    .map(([x, y], i) => (i === 0 || i === stops.length - 1 ? round(y, 4) : `${round(y, 4)} ${round(x * 100, 2)}%`))
    .join(", ");
  const result = { easing: `linear(${body})`, duration: Math.round(seconds * 1000) };
  easingCache.set(key, result);
  return result;
}

export type SpringKeyframes = {
  /** Values sampled at equal time steps from release to rest; the last one is exactly `to`. */
  values: number[];
  /** Duration in ms. */
  duration: number;
};

/**
 * Sample a spring that starts with a velocity (a flicked sheet, a thrown puck) into evenly spaced values.
 * Feed them to WAAPI with `easing: "linear"` so the settle runs on the compositor; because the spring is
 * closed-form, `springValue`/`springVelocity` give the exact state at `animation.currentTime` if the
 * animation is interrupted.
 */
export function springKeyframes(spring: Spring, motion: SpringMotion, options: { precision?: number; fps?: number } = {}): SpringKeyframes {
  const to = motion.to ?? 1;
  const seconds = Math.max(springDuration(spring, motion, options.precision ?? 0.5), STEP);
  const frames = Math.max(Math.round(seconds * (options.fps ?? 60)), 2);
  const { s } = solved(spring, motion);
  const values: number[] = [];
  for (let i = 0; i < frames; i++) values.push(to + s.value((i / frames) * seconds));
  values.push(to);
  return { values, duration: Math.round(seconds * 1000) };
}
