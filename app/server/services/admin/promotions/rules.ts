/**
 * Admin module 08 — the rules that decide, pure and client-safe (tests/admin-promotions.test.ts "rules").
 *
 *   discountApprovalReasons(terms)        why a coupon's / a rule's terms need a second person (DISCOUNT_LIMITS)
 *   couponStateOf(row, used, pending, now) live · scheduled · pending · off · expired · exhausted
 *   termsFingerprint(terms)                the stable text an approval approves (sorted keys and lists)
 *   evaluateRule(terms, cart)              what an automatic discount rule would give one cart (the dry run, 08.02)
 *   flashStateOf(sale, pending, now)       draft · pending · scheduled · active · ended · cancelled
 *   pointsFor(order, multiplierBps)        points an order earns (08.04): 1 per 1,000 IQD of goods paid and kept
 *   expiredUnconsumed(credits, debits, at) points that expired unused, first in first out
 *   experimentDecision(results, rule)      whether the predefined decision rule can be read yet (08.08)
 *
 * Nothing here changes a checkout total: the commerce core applies coupons today, and the rest only once its cart
 * totals call into rules like these (docs/areas/admin-promotions.md "Requests").
 */
import {
  DISCOUNT_LIMITS,
  LOYALTY,
  METRIC_BETTER,
  type ApprovalReason,
  type CouponState,
  type CouponTerms,
  type DiscountLimits,
  type DryRunSkip,
  type ExperimentMetric,
  type FlashState,
  type RuleState,
  type RuleTerms,
  type VariantResult,
} from "./types";

// ───────────────────────────────────────────────────────────────── terms and approvals

type DiscountShape = { kind: string; value: number | null; maxDiscountIqd: number | null; usageLimit?: number | null; perCustomerLimit?: number | null; tiers?: { bps: number }[] };

/** The most one order can get from these terms, in IQD; null = no ceiling (a percentage without a cap). */
export function perOrderCeiling(terms: DiscountShape): number | null {
  if (terms.kind === "fixed") return terms.maxDiscountIqd !== null ? Math.min(terms.value ?? 0, terms.maxDiscountIqd) : (terms.value ?? 0);
  if (terms.kind === "free_shipping") return terms.maxDiscountIqd;
  return terms.maxDiscountIqd;
}

/** The highest percentage the terms can give (basis points); null for amount-only kinds. */
function topBps(terms: DiscountShape): number | null {
  if (terms.kind === "percent") return terms.value ?? 0;
  if (terms.kind === "tiered") return Math.max(0, ...(terms.tiers ?? []).map((tier) => tier.bps));
  if (terms.kind === "bogo") return null;
  return null;
}

/**
 * Why these terms need a second person (pricing.discount.override): a percentage above 20 %, more than 50,000 IQD
 * off one order (or no ceiling at all), and — for coupons — no usage limit of any kind. Empty = the person who
 * writes them may switch them on.
 */
export function discountApprovalReasons(terms: DiscountShape, options: { coupon?: boolean; limits?: DiscountLimits } = {}): ApprovalReason[] {
  // the limits in force (the setting promotions.discount_limits — programRules); DISCOUNT_LIMITS when left out
  const limits = options.limits ?? DISCOUNT_LIMITS;
  const reasons: ApprovalReason[] = [];
  const bps = topBps(terms);
  if (bps !== null && bps > limits.percentBps) reasons.push("percent_over");
  const ceiling = perOrderCeiling(terms);
  const percentLike = terms.kind === "percent" || terms.kind === "tiered" || terms.kind === "bogo";
  if (ceiling === null && (percentLike || terms.kind === "free_shipping")) {
    // free shipping without a ceiling is bounded by the flat fee itself
    if (terms.kind !== "free_shipping") reasons.push("uncapped");
  } else if (ceiling !== null && ceiling > limits.perOrderIqd) reasons.push("amount_over");
  if (options.coupon && (terms.usageLimit ?? null) === null && (terms.perCustomerLimit ?? null) === null) reasons.push("no_limits");
  return reasons;
}

/** A stable text for any JSON-like value: object keys sorted, string lists sorted (they are sets). */
export function stableText(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => stableText(item));
    if (value.every((item) => typeof item === "string")) items.sort();
    return `[${items.join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableText(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What an approval approves: the money terms, as stable text (descriptions and names are not terms). */
export const termsFingerprint = (terms: CouponTerms | RuleTerms): string => stableText(terms);

export type CouponStateInput = { isActive: boolean; startsAt: number | null; endsAt: number | null; usageLimit: number | null };

export function couponStateOf(row: CouponStateInput, used: number, pending: boolean, now: number): CouponState {
  if (!row.isActive) return pending ? "pending" : "off";
  if (row.endsAt !== null && now >= row.endsAt) return "expired";
  if (row.usageLimit !== null && used >= row.usageLimit) return "exhausted";
  if (row.startsAt !== null && now < row.startsAt) return "scheduled";
  return "live";
}

export function ruleStateOf(row: { isActive: boolean; startsAt: number | null; endsAt: number | null }, pending: boolean, now: number): RuleState {
  if (!row.isActive) return pending ? "pending" : "off";
  if (row.endsAt !== null && now >= row.endsAt) return "expired";
  if (row.startsAt !== null && now < row.startsAt) return "scheduled";
  return "live";
}

// ───────────────────────────────────────────────────────────────── the dry run of an automatic rule (08.02)

export type CartLineFacts = { variantId: string; productId: string; platformId: string | null; categoryChain: readonly string[]; kind: string; qty: number; unitPriceIqd: number };
export type CartFacts = { channel: string; segmentIds: ReadonlySet<string>; subtotalIqd: number; shippingIqd: number; lines: readonly CartLineFacts[]; placedAt: number };
export type RuleOutcome = { applies: true; eligibleIqd: number; eligibleQty: number; discountIqd: number; shippingDiscountIqd: number } | { applies: false; skip: DryRunSkip };

const any = (list: readonly string[]) => list.length > 0;
const roundHalfUp = (amount: number, bps: number) => Math.floor((amount * bps + 5_000) / 10_000);

/** Whether a line is inside the rule's product scope (platform, category with its sub-categories, product kind). */
export function lineInScope(terms: RuleTerms, line: CartLineFacts): boolean {
  const scope = terms.scope;
  if (any(scope.platformIds) && (!line.platformId || !scope.platformIds.includes(line.platformId))) return false;
  if (any(scope.productKinds) && !scope.productKinds.includes(line.kind)) return false;
  if (any(scope.categoryIds) && !scope.categoryIds.some((id) => line.categoryChain.includes(id))) return false;
  return true;
}

/**
 * What one cart (a recent order, in the dry run) would get from a rule, before stacking with its coupon. Cart-level
 * conditions first (window, channel, segment), then the lines in scope, then the amounts: percent of the eligible
 * lines (half up, to the dinar), a fixed amount (never above them), the best tier reached by quantity, "buy X get Y"
 * (the cheapest eligible units free), or the shipping fee. Capped by max_discount_iqd; never more than the goods.
 */
export function evaluateRule(terms: RuleTerms, cart: CartFacts): RuleOutcome {
  if ((terms.startsAt !== null && cart.placedAt < terms.startsAt) || (terms.endsAt !== null && cart.placedAt >= terms.endsAt)) return { applies: false, skip: "not_in_window" };
  const scope = terms.scope;
  if (any(scope.channels) && !scope.channels.includes(cart.channel)) return { applies: false, skip: "channel" };
  if (any(scope.segmentIds) && !scope.segmentIds.some((id) => cart.segmentIds.has(id))) return { applies: false, skip: "segment" };
  const lines = cart.lines.filter((line) => lineInScope(terms, line));
  if (lines.length === 0) return { applies: false, skip: "no_lines" };
  if (scope.minSubtotalIqd !== null && cart.subtotalIqd < scope.minSubtotalIqd) return { applies: false, skip: "min_subtotal" };
  const eligibleQty = lines.reduce((sum, line) => sum + line.qty, 0);
  const eligibleIqd = lines.reduce((sum, line) => sum + line.unitPriceIqd * line.qty, 0);
  if (scope.minQty !== null && eligibleQty < scope.minQty) return { applies: false, skip: "min_qty" };

  let discount = 0;
  let shipping = 0;
  switch (terms.kind) {
    case "percent":
      discount = roundHalfUp(eligibleIqd, terms.value ?? 0);
      break;
    case "fixed":
      discount = Math.min(terms.value ?? 0, eligibleIqd);
      break;
    case "tiered": {
      const tier = [...terms.tiers].sort((a, b) => b.minQty - a.minQty).find((entry) => eligibleQty >= entry.minQty);
      if (!tier) return { applies: false, skip: "no_tier" };
      discount = roundHalfUp(eligibleIqd, tier.bps);
      break;
    }
    case "bogo": {
      const deal = terms.bogo;
      if (!deal || deal.buy < 1 || deal.get < 1) return { applies: false, skip: "no_tier" };
      const units = lines.flatMap((line) => Array.from({ length: line.qty }, () => line.unitPriceIqd)).sort((a, b) => a - b);
      const free = Math.floor(units.length / (deal.buy + deal.get)) * deal.get;
      if (free === 0) return { applies: false, skip: "min_qty" };
      discount = units.slice(0, free).reduce((sum, price) => sum + price, 0);
      break;
    }
    case "free_shipping":
      shipping = cart.shippingIqd;
      break;
  }
  if (terms.maxDiscountIqd !== null) {
    if (terms.kind === "free_shipping") shipping = Math.min(shipping, terms.maxDiscountIqd);
    else discount = Math.min(discount, terms.maxDiscountIqd);
  }
  discount = Math.max(0, Math.min(discount, eligibleIqd, cart.subtotalIqd));
  shipping = Math.max(0, Math.min(shipping, cart.shippingIqd));
  return { applies: true, eligibleIqd, eligibleQty, discountIqd: discount, shippingDiscountIqd: shipping };
}

/**
 * The change a rule would have made to an order that already carried `existingDiscountIqd` (its coupon): stackable
 * rules add up (never past the goods), others give the better of the two.
 */
export function stackedChange(outcome: Extract<RuleOutcome, { applies: true }>, stackable: boolean, existingDiscountIqd: number, subtotalIqd: number): { goodsIqd: number; shippingIqd: number } {
  const room = Math.max(0, subtotalIqd - existingDiscountIqd);
  const goods = stackable ? Math.min(outcome.discountIqd, room) : Math.max(0, Math.min(outcome.discountIqd, subtotalIqd) - existingDiscountIqd);
  return { goodsIqd: goods, shippingIqd: outcome.shippingDiscountIqd };
}

// ───────────────────────────────────────────────────────────────── flash sales (08.03)

export function flashStateOf(sale: { status: string; startsAt: number; endsAt: number }, pending: boolean, now: number): FlashState {
  if (sale.status === "cancelled") return "cancelled";
  if (sale.status === "ended") return "ended";
  if (sale.status === "draft") return pending ? "pending" : "draft";
  if (now >= sale.endsAt) return "ended";
  if (now >= sale.startsAt) return "active";
  return "scheduled";
}

/** Two windows [a, b) and [c, d) overlap. */
export const windowsOverlap = (a: { startsAt: number; endsAt: number }, b: { startsAt: number; endsAt: number }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

// ───────────────────────────────────────────────────────────────── loyalty (08.04)

/**
 * Points one order earns: 1 point per whole 1,000 IQD of goods paid and kept — paid − refunded, never above the
 * goods (subtotal − discount: shipping earns nothing) — times a membership's multiplier (floored).
 */
export function pointsFor(order: { paidIqd: number; refundedIqd: number; subtotalIqd: number; discountIqd: number }, multiplierBps: number | null = null, pointsPerThousandIqd: number = LOYALTY.pointsPerThousandIqd): number {
  const goods = Math.max(0, order.subtotalIqd - order.discountIqd);
  const kept = Math.max(0, Math.min(goods, order.paidIqd - order.refundedIqd));
  const base = Math.floor(kept / 1_000) * pointsPerThousandIqd;
  if (multiplierBps === null || multiplierBps <= 10_000) return base;
  return Math.floor((base * multiplierBps) / 10_000);
}

/**
 * Points that expired unused by `at`, first in first out: every debit (a redemption, an expiry already posted, a
 * negative adjustment or reversal) consumes the oldest credits first, so what is left of the credits that expired by
 * `at` is max(0, Σ expired credits − Σ debits).
 */
export function expiredUnconsumed(credits: readonly { points: number; expiresAt: number | null }[], debitsTotal: number, at: number): number {
  const expired = credits.filter((credit) => credit.points > 0 && credit.expiresAt !== null && credit.expiresAt <= at).reduce((sum, credit) => sum + credit.points, 0);
  return Math.max(0, expired - Math.abs(debitsTotal));
}

// ───────────────────────────────────────────────────────────────── A/B tests (08.08)

export function metricValue(result: VariantResult, metric: ExperimentMetric): number | null {
  switch (metric) {
    case "orders":
      return result.orders;
    case "net_revenue_iqd":
      return result.netRevenueIqd;
    case "avg_order_iqd":
      return result.avgOrderIqd;
    case "discount_per_order_iqd":
      return result.discountPerOrderIqd;
    case "refund_rate_bps":
      return result.refundRateBps;
  }
}

/**
 * The decision rule written before the test started: every variant must reach `minSample` orders; only then is the
 * leader on the primary metric named. No significance is computed (visitors are not counted, so there is no
 * denominator to test against) — the leader is a reading of the numbers, labelled as such.
 */
export function experimentDecision(results: readonly VariantResult[], metric: ExperimentMetric | null, minSample: number | null): { ready: boolean; leader: string | null; short: { key: string; missing: number }[] } {
  if (!metric || minSample === null || results.length < 2) return { ready: false, leader: null, short: [] };
  const short = results.filter((result) => result.orders < minSample).map((result) => ({ key: result.key, missing: minSample - result.orders }));
  if (short.length > 0) return { ready: false, leader: null, short };
  const better = METRIC_BETTER[metric];
  let leader: string | null = null;
  let best: number | null = null;
  let tie = false;
  for (const result of results) {
    const value = metricValue(result, metric);
    if (value === null) continue;
    if (best === null || (better === "higher" ? value > best : value < best)) {
      best = value;
      leader = result.key;
      tie = false;
    } else if (value === best) tie = true;
  }
  return { ready: true, leader: tie ? null : leader, short: [] };
}
