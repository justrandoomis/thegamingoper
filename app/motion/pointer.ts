/**
 * Shared, browser-only pointer state: where the last press happened (so content can inflate from the finger)
 * and whether the engine is live (hydrated). Written by <MotionRoot>, read by <Bubble>, materialize, zoom origins.
 */
export type PointerPoint = { x: number; y: number; t: number };

let last: PointerPoint | null = null;
let live = false;

export function notePointer(x: number, y: number): void {
  last = { x, y, t: performance.now() };
}

/** The most recent press position in viewport px, if it happened within `maxAgeMs`. */
export function lastPointer(maxAgeMs = 1200): PointerPoint | null {
  if (!last || performance.now() - last.t > maxAgeMs) return null;
  return last;
}

/** True once <MotionRoot> has mounted on the client: content that mounts from now on arrived after the first paint. */
export function isMotionLive(): boolean {
  return live;
}

export function setMotionLive(value: boolean): void {
  live = value;
}
