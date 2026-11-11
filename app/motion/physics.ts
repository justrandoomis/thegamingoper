/**
 * Gesture and path maths shared by sheets, rails and fly-to-cart. Pure module: no DOM, safe on the server.
 */
import { fly as flyTokens, sheet as sheetTokens } from "./tokens";

/**
 * How far something travelling at `velocity` (px/s) glides before friction stops it — the distance a
 * UIScrollView would coast. Used to pick the snap point a flick is "aiming at" instead of the nearest one.
 */
export function project(velocity: number, decelerationRate: number = sheetTokens.decelerationRate): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Rubber-band resistance: maps how far the finger is past an edge to how far the surface follows.
 * Starts 1:`constant`, eases toward `dimension` and never reaches it. Sign is preserved.
 */
export function rubberBand(offset: number, dimension: number, constant: number = sheetTokens.rubber): number {
  if (dimension <= 0 || offset === 0) return 0;
  const magnitude = Math.abs(offset);
  return Math.sign(offset) * (1 - 1 / ((magnitude * constant) / dimension + 1)) * dimension;
}

/** Clamp `value` to [min, max] with rubber-band give past either end. */
export function rubberBandClamp(value: number, min: number, max: number, dimension: number, constant?: number): number {
  if (value < min) return min + rubberBand(value - min, dimension, constant);
  if (value > max) return max + rubberBand(value - max, dimension, constant);
  return value;
}

/**
 * Choose where a released drag should settle: the snap point closest to where momentum would carry it.
 * `points` and `position` share one axis; `velocity` is in px/s along it. Returns the index into `points`.
 */
export function pickSnap(points: readonly number[], position: number, velocity: number, decelerationRate?: number): number {
  if (points.length === 0) return -1;
  const target = position + project(velocity, decelerationRate);
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i] - target);
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return best;
}

export type Sample = { t: number; v: number };

/**
 * Velocity from the last ~100 ms of pointer samples (ms timestamps, px positions) in px/s.
 * A finger that stopped before lifting (no sample in the last 80 ms) reads as zero.
 */
export function velocityFrom(samples: readonly Sample[], now: number, windowMs = 100, staleMs = 80): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (now - last.t > staleMs) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return ((last.v - first.v) / dt) * 1000;
}

export type Point = { x: number; y: number };

/** Point on a quadratic Bézier curve at t ∈ [0, 1]. */
export function quadBezier(p0: Point, p1: Point, p2: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/**
 * Control point of the fly-to-cart arc (DESIGN.md §7.2): halfway across, `lift` px above the higher of the two
 * ends, so the bead leaves upward and drops into the cart. `lift` 0 with ends at the same height is a straight line.
 */
export function arcControl(from: Point, to: Point, lift: number = flyTokens.lift): Point {
  return {
    x: from.x + (to.x - from.x) * 0.5,
    y: Math.min(from.y, to.y) - lift,
  };
}

/** Flight time in ms for a distance in px: 420 ms + 0.3 ms per px, at most 600 ms (DESIGN.md `--t-fly`). */
export function flightMs(distance: number): number {
  return Math.round(Math.min(flyTokens.maxMs, flyTokens.baseMs + Math.max(distance, 0) * flyTokens.perPxMs));
}

/** `count + 1` points along the arc from `from` to `to` (inclusive of both ends), at parameter values `ease(i / count)`. */
export function samplePath(from: Point, control: Point, to: Point, count: number, ease: (t: number) => number = (t) => t): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= count; i++) out.push(quadBezier(from, control, to, i === count ? 1 : ease(i / count)));
  return out;
}
