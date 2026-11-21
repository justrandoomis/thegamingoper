/**
 * Switch bundle builder — which Nintendo eShop cards cover an amount (pure, client-safe; docs/switch-builder.md §5).
 *
 *   mixEshopCards(5_997, [{ cents: 1_000, max: 5 }, { cents: 2_000, max: 5 }, { cents: 5_000, max: 2 }])
 *   → { cards: [{ cents: 5_000, qty: 1 }, { cents: 1_000, qty: 1 }], totalCents: 6_000, overshootCents: 3, count: 2 }
 *
 * THE RULE, in order:
 *   1. the smallest total at or above the amount (the least money left over on the shopper's account);
 *   2. then the fewest cards;
 *   3. then the fewest different values (fewer cart lines);
 *   4. then more of the larger values (a stable, predictable answer).
 * Within what can be bought of each value: `max` units, and never more than MAX_UNITS_PER_VALUE (a cart line holds at
 * most 10 — MAX_LINE_QTY in cart.server.ts). Null when the cards available cannot reach the amount at all.
 *
 * HOW: an exact dynamic programme over card totals, in steps of the values' greatest common divisor, from 0 up to the
 * amount plus the largest value (an optimal mix never goes further: if it overshot by a whole card or more, dropping
 * its smallest card would still cover the amount). Bounded: at most MAX_VALUES values and MAX_STEPS steps — beyond
 * that the answer is null rather than a slow request. Card values on TamTam are whole US dollars (the catalogue's
 * "N USD" option), so the step is at least 100 cents and real amounts stay far below the bound.
 *
 * The server runs this with the stock it knows (builder.server.ts → quoteBuilderPlan); availability never leaves it.
 */

/** A cart line holds at most this many units (MAX_LINE_QTY in cart.server.ts). */
export const MAX_UNITS_PER_VALUE = 10;
/** At most this many different card values are considered (the largest ones). */
export const MAX_VALUES = 12;
/** Upper bound on the totals the search walks through. */
export const MAX_STEPS = 200_000;

/** One card value on offer: its face value in US cents and how many of it can be bought. */
export type EshopValue = { cents: number; max: number };

export type EshopMix = {
  /** The chosen cards, largest value first; only values with qty > 0. */
  cards: Array<{ cents: number; qty: number }>;
  /** Face value of all chosen cards together (US cents). */
  totalCents: number;
  /** totalCents − the amount: what stays on the account afterwards. */
  overshootCents: number;
  /** Number of cards. */
  count: number;
};

const EMPTY: EshopMix = { cards: [], totalCents: 0, overshootCents: 0, count: 0 };

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** The values usable for a mix: whole positive cents, 1..MAX_UNITS_PER_VALUE units, one entry per value, largest first. */
export function usableValues(values: readonly EshopValue[]): EshopValue[] {
  const byCents = new Map<number, number>();
  for (const value of values) {
    const cents = Number(value?.cents);
    const max = Math.min(MAX_UNITS_PER_VALUE, Math.floor(Number(value?.max)));
    if (!Number.isSafeInteger(cents) || cents <= 0 || !Number.isFinite(max) || max <= 0) continue;
    // a value offered twice counts once, with the larger allowance (the caller sells one variant per value)
    byCents.set(cents, Math.max(byCents.get(cents) ?? 0, max));
  }
  return [...byCents.entries()]
    .map(([cents, max]) => ({ cents, max }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, MAX_VALUES);
}

/**
 * Is the candidate — `base` (counts of the values before `i`) with `k` cards of value `i` — a better mix than
 * `current` for the same total? Fewer cards, then fewer values, then more of the larger values. Positions after `i`
 * are 0 in both (the layer has not reached them), so they never decide.
 */
function candidateBetter(base: Uint8Array, i: number, k: number, count: number, distinct: number, current: Uint8Array, currentCount: number, currentDistinct: number): boolean {
  if (count !== currentCount) return count < currentCount;
  if (distinct !== currentDistinct) return distinct < currentDistinct;
  for (let j = 0; j < i; j++) if (base[j] !== current[j]) return base[j] > current[j];
  return k > current[i];
}

/**
 * The eShop cards that cover `amountCents` (see the rule above), or null when the cards available cannot reach it
 * (or the search would exceed its bound). An amount of 0 or less needs no card.
 */
export function mixEshopCards(amountCents: number, values: readonly EshopValue[]): EshopMix | null {
  if (!Number.isFinite(amountCents)) return null;
  const target = Math.ceil(amountCents);
  if (target <= 0) return EMPTY;
  const offer = usableValues(values);
  if (offer.length === 0) return null;
  const reachable = offer.reduce((sum, value) => sum + value.cents * value.max, 0);
  if (reachable < target) return null;

  const step = offer.reduce((g, value) => gcd(g, value.cents), 0);
  const goal = Math.ceil(target / step);
  // never past the amount + the largest value (see the header), nor past everything on offer
  const limit = Math.min(Math.floor((target + offer[0].cents - 1) / step), Math.floor(reachable / step));
  if (limit < goal || (limit + 1) * offer.length > MAX_STEPS) return null;

  const n = offer.length;
  const units = offer.map((value) => value.cents / step);
  // layer by layer (one value at a time): for every total, the best counts vector found so far
  let counts: Array<Uint8Array | null> = new Array(limit + 1).fill(null);
  let cardCount = new Int32Array(limit + 1);
  let distinct = new Int32Array(limit + 1);
  counts[0] = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const nextCounts: Array<Uint8Array | null> = new Array(limit + 1).fill(null);
    const nextCount = new Int32Array(limit + 1);
    const nextDistinct = new Int32Array(limit + 1);
    for (let total = 0; total <= limit; total++) {
      const base = counts[total];
      if (!base) continue;
      for (let k = 0; k <= offer[i].max; k++) {
        const reached = total + k * units[i];
        if (reached > limit) break;
        const c = cardCount[total] + k;
        const d = distinct[total] + (k > 0 ? 1 : 0);
        const current = nextCounts[reached];
        // compared without allocating; a vector is copied only when it wins its total
        if (current && !candidateBetter(base, i, k, c, d, current, nextCount[reached], nextDistinct[reached])) continue;
        const candidate = base.slice();
        candidate[i] = k;
        nextCounts[reached] = candidate;
        nextCount[reached] = c;
        nextDistinct[reached] = d;
      }
    }
    counts = nextCounts;
    cardCount = nextCount;
    distinct = nextDistinct;
  }

  for (let total = goal; total <= limit; total++) {
    const best = counts[total];
    if (!best) continue;
    const cards = offer.map((value, i) => ({ cents: value.cents, qty: best[i] })).filter((card) => card.qty > 0);
    const totalCents = total * step;
    return { cards, totalCents, overshootCents: totalCents - target, count: cardCount[total] };
  }
  return null;
}

/** Every card on offer at its allowance — the most that can be covered when a full cover is not possible. */
export function allEshopCards(values: readonly EshopValue[]): EshopMix {
  const cards = usableValues(values).map((value) => ({ cents: value.cents, qty: value.max }));
  return { cards, totalCents: cards.reduce((sum, card) => sum + card.cents * card.qty, 0), overshootCents: 0, count: cards.reduce((sum, card) => sum + card.qty, 0) };
}
