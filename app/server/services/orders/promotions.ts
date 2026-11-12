/**
 * Promotions at checkout — the PURE part (no database, safe in tests and on the client): how a priced cart's
 * discounts are decided from module 08's records (docs/CONTRACTS.md §1 "orders/promotions"). The database side —
 * reading the records, the statements of placeOrder's batch, giving an allowance and points back — is
 * ./promotions.server.ts.
 *
 *   const outcome = applyDiscounts({ lines, subtotalIqd, shippingFeeIqd, coupon, rules, segmentIds, member, points, limits, now });
 *   // → { discounts, discountIqd, shippingIqd, shippingWaiver, coupon, couponDropped, pointsUsed }
 *
 * THE ORDER (each step on what the previous ones left of the goods; never more than the goods — CHECK-safe):
 *   1. flash prices are already the lines' unit prices (flashLineCap decides how many units a sale still sells);
 *   2. automatic rules (module 08's own evaluator, `evaluateRule`, on the lines a rule may see — a demo rule only
 *      on demo goods): every STACKABLE rule adds up (priority first); the best NON-stackable rule competes with
 *      «stackable rules + the coupon» and the shopper gets the better of the two (a tie keeps the coupon the shopper
 *      typed). A non-stackable rule that wins drops the coupon — said as `couponDropped` (the coupon stays stored);
 *   3. the coupon (evaluated by the core's evaluateCoupon on the same lines), on what the rules left;
 *   4. the membership discount (an active membership's tier `discountBps`) on what is left — capped by the store's
 *      discount limits in force (module 08's `DISCOUNT_LIMITS` / the setting promotions.discount_limits: at most
 *      `percentBps`, at most `perOrderIqd` per order): no second person approves a tier's discount yet, so the core
 *      never applies more than a person may give alone;
 *   5. redeemed points: what the shopper asked for, never more than the balance nor than the goods left
 *      (points × `pointValueIqd`, whole dinars);
 *   6. delivery: free for a member whose tier says so (the whole fee), else the best free-delivery rule (its cap);
 *      free delivery applies whatever the stacking (module 08's `stackedChange`: stacking is about the goods).
 */
import { evaluateRule, type CartLineFacts } from "~/server/services/admin/promotions/rules";
import type { DiscountLimits, RuleTerms } from "~/server/services/admin/promotions/types";
import type { DiscountLineView, ShippingWaiverView } from "./types";

/** A running flash sale's offer on one variant (what is left of its allowance, and of this shopper's limit). */
export type FlashOffer = {
  itemId: string;
  saleId: string;
  /** The sale's name in the request's language. */
  label: string;
  salePriceIqd: number;
  /** Units the allowance still has (qty_limit − qty_sold); null = no allowance (stock only). */
  left: number | null;
  /** Units this shopper may still buy at the sale's price; null = no per-customer limit. */
  perCustomerLeft: number | null;
  perCustomerLimit: number | null;
  endsAt: number;
  isDemo: boolean;
};

/**
 * How many units of a line the flash price may cover now (0 = the sale gives this line nothing): the allowance left
 * and this shopper's limit. A demo sale prices demo goods only; a sale price that is not below the regular price is no
 * sale. Pure.
 */
export function flashLineCap(offer: FlashOffer | null | undefined, regularPriceIqd: number, productIsDemo: boolean): number {
  if (!offer) return 0;
  if (offer.isDemo && !productIsDemo) return 0;
  if (!(offer.salePriceIqd < regularPriceIqd)) return 0;
  const left = offer.left ?? Number.POSITIVE_INFINITY;
  const mine = offer.perCustomerLeft ?? Number.POSITIVE_INFINITY;
  const cap = Math.min(left, mine);
  return Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : Number.MAX_SAFE_INTEGER;
}

/** An automatic rule as the checkout reads it (a live `promotions` row). */
export type RuleOffer = { id: string; label: string; terms: RuleTerms; isDemo: boolean };

/** The signed-in customer's active membership, when its tier gives a benefit at checkout. */
export type MemberOffer = { membershipId: string; tierId: string; label: string; discountBps: number | null; freeShipping: boolean };

/** One purchasable line, priced (flash prices applied), with what a rule's scope reads. */
export type PricingLine = {
  lineId: string;
  variantId: string;
  productId: string;
  platformId: string | null;
  /** The product's category and its ancestors, nearest first. */
  categoryChain: readonly string[];
  kind: string;
  isDemo: boolean;
  qty: number;
  unitPriceIqd: number;
};

export type CouponOffer = { couponId: string; code: string; label: string; discountIqd: number };

export type DiscountInput = {
  lines: readonly PricingLine[];
  subtotalIqd: number;
  /** The delivery fee the cart charges before any waiver; null = not known (an unserved governorate). */
  shippingFeeIqd: number | null;
  coupon: CouponOffer | null;
  rules: readonly RuleOffer[];
  segmentIds: ReadonlySet<string>;
  member: MemberOffer | null;
  /** Signed-in customers: their balance, a point's worth, and how many points this cart asks to redeem. */
  points: { balance: number; pointValueIqd: number; requested: number } | null;
  limits: DiscountLimits;
  channel?: "web" | "pos";
  now: number;
};

/** An applied discount (the view line plus the ids placeOrder records). */
export type AppliedDiscount = DiscountLineView & { stackable?: boolean };

export type DiscountOutcome = {
  discounts: AppliedDiscount[];
  /** Σ of `discounts` — never more than the subtotal. */
  discountIqd: number;
  /** The delivery fee after the waiver (null stays null). */
  shippingIqd: number | null;
  shippingWaiver: (ShippingWaiverView & { ruleId?: string }) | null;
  /** The coupon as applied (its amount may be below what it would give alone: what the rules left). */
  coupon: CouponOffer | null;
  /** A non-stackable rule gave more than the coupon with the stackable rules: the coupon is not applied. */
  couponDropped: { ruleLabel: string } | null;
  pointsUsed: number;
  /** The most points this cart could redeem now (the balance, and the goods left after the other discounts). */
  pointsMax: number;
};

const sumOf = (lines: readonly PricingLine[]) => lines.reduce((sum, line) => sum + line.unitPriceIqd * line.qty, 0);
/** Basis points of an amount, half up, whole dinars — the coupon's arithmetic (~/lib/money bpsOf). */
const ofBps = (amountIqd: number, bps: number) => Math.round((amountIqd * bps) / 10_000);

const factsOf = (line: PricingLine): CartLineFacts => ({ variantId: line.variantId, productId: line.productId, platformId: line.platformId, categoryChain: line.categoryChain, kind: line.kind, qty: line.qty, unitPriceIqd: line.unitPriceIqd });

/** Decides the cart's discounts and delivery waiver (file header). Pure; integers only. */
export function applyDiscounts(input: DiscountInput): DiscountOutcome {
  const goods = Math.max(0, input.subtotalIqd);
  const fee = input.shippingFeeIqd;

  // ── 2. automatic rules (module 08's evaluator)
  type Outcome = { rule: RuleOffer; goodsIqd: number; shippingIqd: number };
  const outcomes: Outcome[] = [];
  for (const rule of input.rules) {
    // a demo rule (seeded or made in demo mode) never discounts real goods
    const lines = rule.isDemo ? input.lines.filter((line) => line.isDemo) : input.lines;
    if (lines.length === 0) continue;
    const result = evaluateRule(rule.terms, { channel: input.channel ?? "web", segmentIds: input.segmentIds, subtotalIqd: sumOf(lines), shippingIqd: fee ?? 0, lines: lines.map(factsOf), placedAt: input.now });
    if (result.applies) outcomes.push({ rule, goodsIqd: result.discountIqd, shippingIqd: result.shippingDiscountIqd });
  }
  const byPriority = (a: Outcome, b: Outcome) => b.rule.terms.priority - a.rule.terms.priority || (a.rule.id < b.rule.id ? -1 : 1);
  const stackable = outcomes.filter((entry) => entry.rule.terms.stackable && entry.goodsIqd > 0).sort(byPriority);
  const single = outcomes.filter((entry) => !entry.rule.terms.stackable && entry.goodsIqd > 0).sort((a, b) => b.goodsIqd - a.goodsIqd || byPriority(a, b))[0] ?? null;

  let left = goods;
  const stacked: (Extract<DiscountLineView, { kind: "rule" }> & { stackable?: boolean })[] = [];
  for (const entry of stackable) {
    const amount = Math.min(entry.goodsIqd, left);
    if (amount <= 0) continue;
    stacked.push({ kind: "rule", ruleId: entry.rule.id, label: entry.rule.label, amountIqd: amount, stackable: true });
    left -= amount;
  }
  // ── 3. the coupon, on what the stackable rules left
  const couponAmount = input.coupon ? Math.max(0, Math.min(input.coupon.discountIqd, left)) : 0;
  const pathCoupon = goods - left + couponAmount;
  const pathSingle = single ? Math.min(single.goodsIqd, goods) : 0;

  let discounts: AppliedDiscount[];
  let coupon: CouponOffer | null = null;
  let couponDropped: DiscountOutcome["couponDropped"] = null;
  if (single && pathSingle > pathCoupon) {
    discounts = [{ kind: "rule", ruleId: single.rule.id, label: single.rule.label, amountIqd: pathSingle, stackable: false }];
    if (input.coupon) couponDropped = { ruleLabel: single.rule.label };
  } else {
    discounts = [...stacked];
    if (input.coupon && couponAmount > 0) {
      coupon = { ...input.coupon, discountIqd: couponAmount };
      discounts.push({ kind: "coupon", code: input.coupon.code, label: input.coupon.label, amountIqd: couponAmount });
    } else if (input.coupon && stacked[0]) {
      // the stackable rules took the whole goods: the coupon has nothing left to discount and uses nothing up
      couponDropped = { ruleLabel: stacked[0].label };
    }
  }
  let used = discounts.reduce((sum, entry) => sum + entry.amountIqd, 0);

  // ── 4. the membership discount, within the store's limits in force
  const member = input.member;
  if (member && member.discountBps !== null && member.discountBps > 0 && goods - used > 0) {
    const bps = Math.min(member.discountBps, input.limits.percentBps);
    const amount = Math.max(0, Math.min(ofBps(goods - used, bps), input.limits.perOrderIqd, goods - used));
    if (amount > 0) {
      discounts.push({ kind: "member", label: member.label, bps, amountIqd: amount });
      used += amount;
    }
  }

  // ── 5. points
  let pointsUsed = 0;
  let pointsMax = 0;
  const points = input.points;
  if (points && points.pointValueIqd > 0) {
    pointsMax = Math.max(0, Math.min(points.balance, Math.floor((goods - used) / points.pointValueIqd)));
    pointsUsed = Math.max(0, Math.min(Math.floor(points.requested), pointsMax));
    if (pointsUsed > 0) {
      const amount = pointsUsed * points.pointValueIqd;
      discounts.push({ kind: "points", points: pointsUsed, amountIqd: amount });
      used += amount;
    }
  }

  // ── 6. delivery
  let shippingWaiver: DiscountOutcome["shippingWaiver"] = null;
  if (fee !== null && fee > 0) {
    if (member?.freeShipping) shippingWaiver = { by: "member", label: member.label, feeIqd: fee, waivedIqd: fee };
    else {
      const best = outcomes.filter((entry) => entry.shippingIqd > 0).sort((a, b) => b.shippingIqd - a.shippingIqd || byPriority(a, b))[0];
      if (best) shippingWaiver = { by: "rule", ruleId: best.rule.id, label: best.rule.label, feeIqd: fee, waivedIqd: Math.min(best.shippingIqd, fee) };
    }
  }
  const shippingIqd = fee === null ? null : fee - (shippingWaiver?.waivedIqd ?? 0);
  return { discounts, discountIqd: Math.min(used, goods), shippingIqd, shippingWaiver, coupon, couponDropped, pointsUsed, pointsMax };
}

/**
 * The points one refund gives back from a redemption: its share of what the order paid — the same rule module 08 uses
 * to take EARNED points back (loyalty.server.ts reversalPoints) — never more than is still to give back. Pure.
 */
export function restoredPointsFor(input: { redeemedPoints: number; restoredSoFar: number; refundIqd: number; paidIqd: number; full: boolean }): number {
  const remaining = Math.max(0, input.redeemedPoints - input.restoredSoFar);
  if (remaining === 0) return 0;
  if (input.full || input.paidIqd <= 0) return remaining;
  const share = Math.floor((input.redeemedPoints * Math.min(input.refundIqd, input.paidIqd)) / input.paidIqd);
  return Math.max(0, Math.min(share, remaining));
}
