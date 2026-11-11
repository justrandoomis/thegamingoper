/**
 * Pricing rules (admin module 03) — pure functions: no database, no server imports, no floats in money.
 * The services load the facts and call these; tests call them directly.
 *
 *   marginBps(price, cost)                 margin on the selling price, floored (never overstated)
 *   priceForMargin(cost, bps)              lowest price on the 250 IQD step that keeps a margin
 *   evaluatePriceChange(…)                 which approval rules a price change trips (03.03, 03.05, 03.07)
 *   priceSegments / compareAtCheck         the "was" price rule: a previous price must have been charged 90 days
 *   allocateAmount / planAllocation        landed cost spread over receipt lines, exact to the dinar (03.02)
 *   suggestPrice                           the advisory suggestion: deterministic rules, never applied by itself (03.08)
 *   simulateUnit                           a discount's effect on one unit's net profit (03.06)
 *   purchaseCostIqd                        a supplier-currency cost at a dated rate, exactly (03.01)
 */

export const BPS = 10_000;
/** IQD prices move in steps of the smallest note in circulation. */
export const PRICE_STEP_IQD = 250;
/** A price cut of more than this (basis points of the reference price) needs a second person (03.05). */
export const DROP_APPROVAL_BPS = 1_000;
/**
 * …measured from the highest price in force during this many days (the window starts again at a price a second
 * person approved), so a deep cut cannot be sliced into small steps that each stay inside the limit.
 */
export const DROP_WINDOW_DAYS = 30;
/** A "was" price must have been charged this many days in a row (the seed's rule, app/server/db/seed/demo/pricing.ts). */
export const COMPARE_AT_MIN_DAYS = 90;
/** …inside this many days before today. */
export const COMPARE_AT_LOOKBACK_DAYS = 365;
/** Stock with no sale for this long, older than this, is "slow" for the suggestion and the clearance list. */
export const SLOW_STOCK_DAYS = 90;
/** The suggestion's markdown for slow stock, in basis points of the price. */
export const SLOW_STOCK_MARKDOWN_BPS = 500;
export const DAY_MS = 86_400_000;
/** Highest price a form accepts (100 million IQD): a typo guard, far above anything the store sells. */
export const MAX_PRICE_IQD = 100_000_000;

// ───────────────────────────────────────────────────────────────── margins

/** Margin on the selling price in basis points, (price − cost) ÷ price, rounded DOWN. Null when the price is 0. */
export function marginBps(priceIqd: number, costIqd: number): number | null {
  if (!(priceIqd > 0)) return null;
  return Math.floor(((priceIqd - costIqd) * BPS) / priceIqd);
}

/** The lowest price on the step whose margin is at least `bps` (cost ÷ (1 − margin), rounded up to the step). */
export function priceForMargin(costIqd: number, bps: number, step = PRICE_STEP_IQD): number {
  if (!(bps < BPS)) throw new RangeError("A margin must be below 100%");
  const exact = Math.ceil((Math.max(0, costIqd) * BPS) / (BPS - bps));
  let price = Math.max(step, Math.ceil(exact / step) * step);
  // Integer rounding can leave the floored margin one point short: step up until it holds.
  while ((marginBps(price, costIqd) ?? -Infinity) < bps) price += step;
  return price;
}

export const roundDownToStep = (value: number, step = PRICE_STEP_IQD) => Math.floor(value / step) * step;
export const roundUpToStep = (value: number, step = PRICE_STEP_IQD) => Math.ceil(value / step) * step;
export const isOnStep = (value: number, step = PRICE_STEP_IQD) => Number.isSafeInteger(value) && value % step === 0;

/** Basis points of an amount, rounded half away from zero (the same as `bpsOf` in ~/lib/money, without its checks). */
export const bpsAmount = (amountIqd: number, bps: number) => Math.round((amountIqd * bps) / BPS);

// ───────────────────────────────────────────────────────────────── price change rules (03.03, 03.05, 03.07)

/** Why a price change cannot simply be applied by the person who asks for it. */
export const CHANGE_REASONS = ["drop_over_limit", "compare_at_new", "below_min_margin", "below_cost", "cost_unknown", "clearance"] as const;
export type ChangeReason = (typeof CHANGE_REASONS)[number];

/** Reasons that need `pricing.discount.override` on top of `pricing.price.approve`. */
export const OVERRIDE_REASONS: ReadonlySet<ChangeReason> = new Set<ChangeReason>(["below_min_margin", "below_cost"]);

export const CHANGE_MODES = ["standard", "clearance"] as const;
export type ChangeMode = (typeof CHANGE_MODES)[number];

/** What a price is measured against: the SKU's own landed cost, or the sum of its components' for a bundle. */
export type CostBasis = { landedIqd: number; minMarginBps: number | null; targetMarginBps: number | null; source: "own" | "bundle" };

export type ChangeInput = {
  oldPriceIqd: number;
  newPriceIqd: number;
  oldCompareAtIqd: number | null;
  newCompareAtIqd: number | null;
  cost: CostBasis | null;
  mode: ChangeMode;
  /** The highest price of the drop window (dropReferencePrice); the old price when not given. */
  referencePriceIqd?: number | null;
};

export type ChangeEvaluation = {
  reasons: ChangeReason[];
  needsApproval: boolean;
  /** The approver must also hold pricing.discount.override. */
  needsOverride: boolean;
  /** Size of a cut in basis points of the old price (negative for a rise); null when the old price was 0. */
  dropBps: number | null;
  /** The price the discount limit is measured from: the highest price of the drop window (never under the old price). */
  referencePriceIqd: number;
  /** The cut measured from that price, in basis points (negative for a rise); null when it is 0. */
  referenceDropBps: number | null;
  marginBeforeBps: number | null;
  marginAfterBps: number | null;
  /** Lowest price allowed without an override: the minimum-margin price, or the landed cost in clearance. Null without a cost. */
  floorIqd: number | null;
};

export function evaluatePriceChange(input: ChangeInput): ChangeEvaluation {
  const { oldPriceIqd, newPriceIqd, cost, mode } = input;
  const reasons: ChangeReason[] = [];
  const dropBps = oldPriceIqd > 0 ? Math.trunc(((oldPriceIqd - newPriceIqd) * BPS) / oldPriceIqd) : null;
  const reference = Math.max(oldPriceIqd, input.referencePriceIqd ?? oldPriceIqd);
  // Exact comparison (no rounding): a cut of more than the limit from the highest price of the window.
  if (newPriceIqd < reference && (reference - newPriceIqd) * BPS > DROP_APPROVAL_BPS * reference) reasons.push("drop_over_limit");
  if (input.newCompareAtIqd !== null && input.newCompareAtIqd !== input.oldCompareAtIqd) reasons.push("compare_at_new");

  let floorIqd: number | null = null;
  if (cost) {
    const minimumMet = mode === "standard" && cost.minMarginBps !== null ? (marginBps(newPriceIqd, cost.landedIqd) ?? -Infinity) >= cost.minMarginBps : true;
    if (newPriceIqd < cost.landedIqd) reasons.push("below_cost");
    else if (!minimumMet) reasons.push("below_min_margin");
    floorIqd = mode === "standard" && cost.minMarginBps !== null && cost.minMarginBps < BPS ? priceForMargin(cost.landedIqd, cost.minMarginBps) : cost.landedIqd;
  } else if (newPriceIqd !== oldPriceIqd) {
    // Without a cost the minimum profit cannot be checked: a second person decides (03.03).
    reasons.push("cost_unknown");
  }
  if (mode === "clearance") reasons.push("clearance");

  return {
    reasons,
    needsApproval: reasons.length > 0,
    needsOverride: reasons.some((reason) => OVERRIDE_REASONS.has(reason)),
    dropBps,
    referencePriceIqd: reference,
    referenceDropBps: reference > 0 ? Math.trunc(((reference - newPriceIqd) * BPS) / reference) : null,
    marginBeforeBps: cost ? marginBps(oldPriceIqd, cost.landedIqd) : null,
    marginAfterBps: cost ? marginBps(newPriceIqd, cost.landedIqd) : null,
    floorIqd,
  };
}

// ───────────────────────────────────────────────────────────────── the "was" price (compare-at) rule

/** A price that was in effect over [from, to). */
export type PriceSegment = { priceIqd: number; from: number; to: number };
/**
 * An applied change: from `at` the price was `newPriceIqd` (it had been `oldPriceIqd`). `approved`: a second person
 * decided it (it starts a new drop window).
 */
export type AppliedChange = { at: number; oldPriceIqd: number | null; newPriceIqd: number; approved?: boolean };

/**
 * The prices a SKU had over time, rebuilt backwards from today's price and its applied changes (oldest first or
 * not — they are sorted here). Before the first known change the SKU had that change's old price since it was
 * created; neighbouring segments with the same price are merged.
 */
export function priceSegments(currentPriceIqd: number, createdAt: number, changes: readonly AppliedChange[], now: number): PriceSegment[] {
  const sorted = [...changes].filter((change) => change.at <= now).sort((a, b) => a.at - b.at);
  const segments: PriceSegment[] = [];
  let to = now;
  let price = currentPriceIqd;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const change = sorted[i];
    const from = Math.max(change.at, createdAt);
    if (from < to) segments.unshift({ priceIqd: price, from, to });
    to = Math.min(to, from);
    price = change.oldPriceIqd ?? change.newPriceIqd;
  }
  if (createdAt < to) segments.unshift({ priceIqd: price, from: createdAt, to });
  const merged: PriceSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.priceIqd === segment.priceIqd && last.to === segment.from) last.to = segment.to;
    else merged.push({ ...segment });
  }
  return merged;
}

/**
 * The price a cut is measured from (03.05): the highest price in force at any moment of the last DROP_WINDOW_DAYS,
 * today's included. The window starts again at the last change a second person approved, so an approved reduction
 * is the new starting point. Without this, ten cuts of 10 % would each pass the limit.
 */
export function dropReferencePrice(currentPriceIqd: number, createdAt: number, changes: readonly AppliedChange[], now: number): number {
  let from = now - DROP_WINDOW_DAYS * DAY_MS;
  for (const change of changes) if (change.approved && change.at <= now && change.at > from) from = change.at;
  let highest = currentPriceIqd;
  for (const segment of priceSegments(currentPriceIqd, createdAt, changes, now)) if (segment.to > from && segment.priceIqd > highest) highest = segment.priceIqd;
  return highest;
}

export type CompareAtCheck = { ok: true; days: number } | { ok: false; days: number };

/**
 * A "was" price is honest only when the SKU really sold at exactly that price for COMPARE_AT_MIN_DAYS days in a row,
 * while on sale (`onSaleFrom`: when the product was published; null = never), within the last
 * COMPARE_AT_LOOKBACK_DAYS. `days` is the longest qualifying run found, rounded down.
 */
export function compareAtCheck(valueIqd: number, segments: readonly PriceSegment[], onSaleFrom: number | null, now: number): CompareAtCheck {
  if (onSaleFrom === null) return { ok: false, days: 0 };
  const windowStart = Math.max(onSaleFrom, now - COMPARE_AT_LOOKBACK_DAYS * DAY_MS);
  let longest = 0;
  for (const segment of segments) {
    if (segment.priceIqd !== valueIqd) continue;
    const span = Math.min(segment.to, now) - Math.max(segment.from, windowStart);
    if (span > longest) longest = span;
  }
  const days = Math.floor(longest / DAY_MS);
  return { ok: days >= COMPARE_AT_MIN_DAYS, days };
}

// ───────────────────────────────────────────────────────────────── landed cost allocation (03.02)

export const ALLOCATION_METHODS = ["by_value", "by_qty", "by_weight", "manual"] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

export class AllocationError extends Error {
  readonly code: "allocation_basis_zero" | "line_value_missing" | "line_weight_missing" | "manual_sum_mismatch" | "manual_line_unknown";
  readonly lineId?: string;
  constructor(code: AllocationError["code"], lineId?: string) {
    super(lineId ? `${code}:${lineId}` : code);
    this.name = "AllocationError";
    this.code = code;
    this.lineId = lineId;
  }
}

/**
 * Splits `totalIqd` over the weights so the shares add up to the total EXACTLY: each line gets the floor of its
 * exact share, and the dinars left over go to the largest remainders (ties: the earlier line). BigInt inside, so
 * value × amount never loses precision.
 */
export function allocateAmount(totalIqd: number, weights: readonly { id: string; weight: number }[]): Map<string, number> {
  if (!Number.isSafeInteger(totalIqd) || totalIqd < 0) throw new RangeError(`allocateAmount: total must be a non-negative integer, got ${totalIqd}`);
  const sum = weights.reduce((acc, line) => acc + BigInt(Math.max(0, Math.round(line.weight))), 0n);
  const out = new Map<string, number>();
  if (weights.length === 0) return out;
  if (sum === 0n) throw new AllocationError("allocation_basis_zero");
  const total = BigInt(totalIqd);
  let given = 0n;
  const remainders: { id: string; remainder: bigint; index: number }[] = [];
  weights.forEach((line, index) => {
    const w = BigInt(Math.max(0, Math.round(line.weight)));
    const share = (total * w) / sum;
    out.set(line.id, Number(share));
    given += share;
    remainders.push({ id: line.id, remainder: (total * w) % sum, index });
  });
  let left = Number(total - given);
  remainders.sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const entry of remainders) {
    if (left <= 0) break;
    out.set(entry.id, (out.get(entry.id) ?? 0) + 1);
    left--;
  }
  return out;
}

/** A receipt line as the allocation sees it. `qty` = units that carry the cost (accepted, else received). */
export type AllocationLine = { id: string; qty: number; unitCostIqd: number | null; weightGrams: number | null };
export type PlannedShare = { lineId: string; amountIqd: number; perUnitIqd: number };

/**
 * How one landed-cost bill spreads over a receipt's lines. Lines with no units carry nothing. `manual` takes the
 * amounts per line, which must add up to the bill. Throws AllocationError for a basis that cannot be used.
 */
export function planAllocation(amountIqd: number, method: AllocationMethod, lines: readonly AllocationLine[], manual?: Readonly<Record<string, number>>): PlannedShare[] {
  const carrying = lines.filter((line) => line.qty > 0);
  let shares: Map<string, number>;
  if (method === "manual") {
    const given = manual ?? {};
    for (const id of Object.keys(given)) if (!carrying.some((line) => line.id === id)) throw new AllocationError("manual_line_unknown", id);
    let sum = 0;
    shares = new Map();
    for (const line of carrying) {
      const value = given[line.id] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new AllocationError("manual_sum_mismatch", line.id);
      shares.set(line.id, value);
      sum += value;
    }
    if (sum !== amountIqd) throw new AllocationError("manual_sum_mismatch");
  } else {
    const weights = carrying.map((line) => {
      if (method === "by_qty") return { id: line.id, weight: line.qty };
      if (method === "by_value") {
        if (line.unitCostIqd === null) throw new AllocationError("line_value_missing", line.id);
        return { id: line.id, weight: line.unitCostIqd * line.qty };
      }
      if (line.weightGrams === null || line.weightGrams <= 0) throw new AllocationError("line_weight_missing", line.id);
      return { id: line.id, weight: line.weightGrams * line.qty };
    });
    shares = allocateAmount(amountIqd, weights);
  }
  return carrying.map((line) => {
    const amount = shares.get(line.id) ?? 0;
    return { lineId: line.id, amountIqd: amount, perUnitIqd: Math.round(amount / line.qty) };
  });
}

// ───────────────────────────────────────────────────────────────── purchase cost in IQD (03.01)

/** Supplier currencies the cost form accepts, with their minor-unit digits. IQD costs are whole dinars. */
export const COST_CURRENCIES = { IQD: 0, USD: 2, EUR: 2, GBP: 2, AED: 2, TRY: 2, CNY: 2, JPY: 0 } as const;
export type CostCurrency = keyof typeof COST_CURRENCIES;
export const isCostCurrency = (value: unknown): value is CostCurrency => typeof value === "string" && Object.prototype.hasOwnProperty.call(COST_CURRENCIES, value);

/** IQD of `minor` units of a currency at `rateMicros` (IQD per unit × 1,000,000), rounded half up. Exact (BigInt). */
export function purchaseCostIqd(minor: number, decimals: number, rateMicros: number): number {
  const numerator = BigInt(minor) * BigInt(rateMicros);
  const denominator = 10n ** BigInt(decimals) * 1_000_000n;
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

/**
 * Parses a typed decimal ("249.99", "٢٤٩٫٩٩", "1,310") into an integer of `decimals` fraction digits. Null when it
 * is not a plain non-negative number or has more fraction digits than allowed.
 */
export function parseDecimal(raw: unknown, decimals: number): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw)
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫]/g, ".")
    .replace(/[,،٬\s]/g, "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  const value = Number(match[1] + fraction.padEnd(decimals, "0"));
  return Number.isSafeInteger(value) ? value : null;
}

/** "12.5" (percent) → 1250 basis points; null when not a number with at most two decimals. */
export const parsePercentBps = (raw: unknown): number | null => parseDecimal(raw, 2);

/** 1250 → "12.5", 1200 → "12" (for form values; display goes through Intl). */
export function bpsToPercentText(bps: number): string {
  const sign = bps < 0 ? "-" : "";
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  return fraction === 0 ? `${sign}${whole}` : `${sign}${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

/** 1310 IQD → the micros a cost row stores (IQD per unit × 1,000,000), from a typed rate with up to 6 decimals. */
export const parseRateMicros = (raw: unknown): number | null => parseDecimal(raw, 6);

// ───────────────────────────────────────────────────────────────── advisory suggestion (03.08)

export const SUGGESTION_RULES = ["cost_plus", "keep_current", "market_match", "market_above", "market_below_floor", "slow_stock"] as const;
export type SuggestionRule = (typeof SUGGESTION_RULES)[number];

export type SuggestionInput = {
  landedIqd: number;
  minMarginBps: number | null;
  targetMarginBps: number | null;
  currentPriceIqd: number;
  /** A competitor or market price the employee typed in; null = none. */
  marketIqd: number | null;
  onHand: number;
  /** Units sold in the last SLOW_STOCK_DAYS (delivered or on their way, not cancelled). */
  soldRecently: number;
  /** Age in days of the oldest stock still on hand; null when unknown. */
  oldestStockDays: number | null;
};

export type Suggestion =
  | { ok: false; reason: "no_target" }
  | {
      ok: true;
      priceIqd: number;
      floorIqd: number;
      targetIqd: number;
      /** The rules that shaped the price, in the order they were applied, each with the price after it. */
      steps: { rule: SuggestionRule; priceIqd: number }[];
      marginBps: number | null;
      /** Change from today's price in basis points (positive = higher). */
      changeBps: number | null;
    };

/**
 * A deterministic price suggestion (no model, no data from outside the store): start at the target-margin price;
 * without a market price, keep today's price when it already meets the target (no reason to cut it); with a market
 * price the employee entered, match it (or stay one step under it when it is above our target), never under the
 * minimum-margin floor; mark slow stock down by 5 % toward the floor. Always a multiple of 250 IQD.
 * It is advice: nothing is changed until a person sends it as a price change, which follows the approval rules.
 */
export function suggestPrice(input: SuggestionInput): Suggestion {
  const targetBps = input.targetMarginBps ?? null;
  if (targetBps === null || targetBps >= BPS) return { ok: false, reason: "no_target" };
  const floorIqd = priceForMargin(input.landedIqd, input.minMarginBps !== null && input.minMarginBps < BPS ? Math.min(input.minMarginBps, targetBps) : 0);
  const targetIqd = Math.max(floorIqd, priceForMargin(input.landedIqd, targetBps));
  const steps: { rule: SuggestionRule; priceIqd: number }[] = [];
  let price = targetIqd;
  steps.push({ rule: "cost_plus", priceIqd: price });

  if ((input.marketIqd === null || input.marketIqd <= 0) && input.currentPriceIqd >= targetIqd && isOnStep(input.currentPriceIqd)) {
    price = input.currentPriceIqd;
    steps.push({ rule: "keep_current", priceIqd: price });
  }

  if (input.marketIqd !== null && input.marketIqd > 0) {
    const market = roundDownToStep(input.marketIqd);
    if (market < floorIqd) {
      price = floorIqd;
      steps.push({ rule: "market_below_floor", priceIqd: price });
    } else if (market <= targetIqd) {
      price = market;
      steps.push({ rule: "market_match", priceIqd: price });
    } else {
      price = Math.max(targetIqd, market - PRICE_STEP_IQD);
      steps.push({ rule: "market_above", priceIqd: price });
    }
  }

  const slow = input.onHand > 0 && input.soldRecently === 0 && input.oldestStockDays !== null && input.oldestStockDays >= SLOW_STOCK_DAYS;
  if (slow) {
    const marked = Math.max(floorIqd, roundDownToStep(price - bpsAmount(price, SLOW_STOCK_MARKDOWN_BPS)));
    if (marked < price) {
      price = marked;
      steps.push({ rule: "slow_stock", priceIqd: price });
    }
  }

  return {
    ok: true,
    priceIqd: price,
    floorIqd,
    targetIqd,
    steps,
    marginBps: marginBps(price, input.landedIqd),
    changeBps: input.currentPriceIqd > 0 ? Math.trunc(((price - input.currentPriceIqd) * BPS) / input.currentPriceIqd) : null,
  };
}

// ───────────────────────────────────────────────────────────────── discount simulation (03.06)

export const DISCOUNT_KINDS = ["percent", "fixed"] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export type SimulationInput = {
  priceIqd: number;
  /** Null: the SKU has no cost — profit cannot be computed and is never shown as 0. */
  landedIqd: number | null;
  discount: { kind: DiscountKind; value: number };
  /** Share of sales refunded, basis points of the net price (the SKU's history or an assumption). */
  refundRateBps: number;
  /** Commission rules that apply: a share of the net price, or of the profit before commission. */
  commission: { salesBps: number; profitBps: number };
  /** Payment or channel fees, basis points of the net price. */
  feeBps: number;
};

export type SimulationSide = {
  discountIqd: number;
  netPriceIqd: number;
  refundIqd: number;
  feeIqd: number;
  commissionIqd: number | null;
  profitIqd: number | null;
  marginBps: number | null;
};

function simulateSide(input: SimulationInput, discountIqd: number): SimulationSide {
  const netPriceIqd = input.priceIqd - discountIqd;
  const refundIqd = bpsAmount(netPriceIqd, input.refundRateBps);
  const feeIqd = bpsAmount(netPriceIqd, input.feeBps);
  if (input.landedIqd === null) {
    // Without a cost a profit-based commission is unknown too; a sales-based one is still exact.
    const commissionIqd = input.commission.profitBps > 0 ? null : bpsAmount(netPriceIqd, input.commission.salesBps);
    return { discountIqd, netPriceIqd, refundIqd, feeIqd, commissionIqd, profitIqd: null, marginBps: null };
  }
  const beforeCommission = netPriceIqd - refundIqd - feeIqd - input.landedIqd;
  const commissionIqd = bpsAmount(netPriceIqd, input.commission.salesBps) + (beforeCommission > 0 ? bpsAmount(beforeCommission, input.commission.profitBps) : 0);
  const profitIqd = beforeCommission - commissionIqd;
  return { discountIqd, netPriceIqd, refundIqd, feeIqd, commissionIqd, profitIqd, marginBps: netPriceIqd > 0 ? Math.floor((profitIqd * BPS) / netPriceIqd) : null };
}

/** One unit before and after the discount: net price, refunds, fees, commission, landed cost → net profit and margin. */
export function simulateUnit(input: SimulationInput): { before: SimulationSide; after: SimulationSide } {
  const raw = input.discount.kind === "percent" ? bpsAmount(input.priceIqd, Math.min(BPS, Math.max(0, input.discount.value))) : Math.max(0, input.discount.value);
  const discountIqd = Math.min(input.priceIqd, raw);
  return { before: simulateSide(input, 0), after: simulateSide(input, discountIqd) };
}
