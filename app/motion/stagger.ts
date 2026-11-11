/**
 * Delay between neighbours in a stagger wave, in ms (one decimal, rounded down), such that the last of `slots`
 * distinct delays never starts later than `maxTotal` after the first.
 * `count` is how many items are known to be in the wave; with 0 or 1 known, every slot is assumed to be used.
 * Pure (unit-tested).
 */
export function staggerStep(count: number, requested: number, maxTotal: number, slots = 6): number {
  const used = count > 1 ? Math.min(count, slots) : slots;
  const step = Math.min(Math.max(requested, 0), maxTotal / (used - 1));
  return Math.floor(step * 10) / 10;
}
