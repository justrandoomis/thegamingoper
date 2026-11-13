/**
 * Coupons (docs/CONTRACTS.md §1, admin blueprint 08.02).
 *
 *   const result = await evaluateCoupon(db, { code: "demo10", subtotalIqd, lines, customerId, phoneE164 }, now);
 *   if (result.ok) discount = result.discountIqd; else show `coupon_${result.reason}`;
 *
 * evaluateCoupon only READS. It never reserves a use: the redemption row (`coupon_redemptions`) is
 * written by placeOrder in the order batch, and the limits are counted from those rows (voided
 * redemptions — cancelled orders — free their use again).
 *
 * The checks, in the order their reasons are reported:
 *   not_found       no coupon with that code (case-insensitive), or it is switched off
 *   not_started     starts_at is in the future
 *   expired         ends_at has passed (a coupon is valid while now < ends_at)
 *   usage_limit     total redemptions reached usage_limit
 *   customer_limit  this customer (by customer id OR phone number) reached per_customer_limit
 *   not_applicable  nothing in the cart matches the conditions (platforms, categories — including
 *                   sub-categories —, products, product kinds, customer segments, channel, first order
 *                   only, minimum quantity), or the cart is empty. A DEMO coupon (is_demo) counts demo
 *                   goods only: it never discounts a real product (review 2026-11-12)
 *   min_subtotal    the cart subtotal is below min_subtotal_iqd (a DEMO coupon: its demo goods' subtotal).
 *                   This refusal also says how far the cart is (client round 1, wave C — «أضف منتجات بقيمة …»):
 *                   `minimumIqd` (min_subtotal_iqd), `countedIqd` (what counts toward it) and `moreIqd`
 *                   (what is still missing, > 0), so no page counts it a second time with its own copy of the rules
 *
 * `label` is the coupon's own words (`coupons.description`, else the code). The description is ONE text, written once by
 * the admin in the store's language (Arabic) — not an L10n: the pages show it on Arabic pages only and never in a
 * summary row (checkout review, round 1). Descriptions in every language are a module 08 feature for later.
 *
 * Who the shopper is may not be known yet (a guest in the cart has given no phone). Then the
 * per-customer limit and "first order only" cannot be checked and the coupon applies provisionally;
 * checkout evaluates again with the phone number and drops it if it no longer applies.
 *
 * The discount: `fixed` = value IQD; `percent` = value basis points of the eligible lines' subtotal
 * (rounded half up to a whole dinar), capped by max_discount_iqd. It never exceeds the eligible
 * subtotal nor the cart subtotal, and is always a whole number of dinars.
 */
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { bpsOf } from "~/lib/money";
import { toLatinDigits } from "~/lib/phone";
import type { Db } from "~/server/db/drizzle.server";
import { categories, couponRedemptions, coupons, customerSegmentMembers, orders, products, variants, type Coupon, type CouponConditions } from "~/server/db/schema";

export const COUPON_REJECTIONS = ["not_found", "expired", "not_started", "min_subtotal", "usage_limit", "customer_limit", "not_applicable"] as const;
export type CouponRejection = (typeof COUPON_REJECTIONS)[number];

/** Error keys shown for a refused coupon: `coupon_<reason>`. */
export const COUPON_ERROR_KEYS = COUPON_REJECTIONS.map((reason) => `coupon_${reason}` as const);

export type CouponLine = { variantId: string; qty: number; unitPriceIqd: number };

export type EvaluateCouponInput = {
  code: string;
  /** Subtotal of the purchasable lines, in IQD. */
  subtotalIqd: number;
  lines: readonly CouponLine[];
  customerId?: string | null;
  phoneE164?: string | null;
  /** Where the order is placed; coupons may be limited to channels. Default "web". */
  channel?: "web" | "pos";
};

/**
 * A refused coupon and why. Below its minimum (`min_subtotal`) it also says the minimum, what counts toward it (the
 * cart's subtotal — a DEMO coupon: its demo goods alone) and what is still missing, in whole dinars (moreIqd > 0).
 */
export type CouponRefusal =
  | { ok: false; reason: Exclude<CouponRejection, "min_subtotal"> }
  | { ok: false; reason: "min_subtotal"; minimumIqd: number; countedIqd: number; moreIqd: number };

export type CouponEvaluation = { ok: true; couponId: string; code: string; label: string; discountIqd: number } | CouponRefusal;

const MAX_CODE_LENGTH = 64;

/** The form a code is compared in: trimmed, Latin digits, upper case. Null when it cannot be a code. */
export function normalizeCouponCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const value = toLatinDigits(code).trim().replace(/\s+/g, "").toUpperCase();
  if (value.length === 0 || value.length > MAX_CODE_LENGTH) return null;
  return value;
}

function assertMoney(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`evaluateCoupon: ${what} must be a whole number of dinars ≥ 0, got ${String(value)}`);
}

const refuse = (reason: Exclude<CouponRejection, "min_subtotal">): CouponEvaluation => ({ ok: false, reason });

const hasAny = (list: readonly string[] | undefined): list is readonly string[] => Array.isArray(list) && list.length > 0;

/** Lines that satisfy the product-level conditions of a coupon (a demo coupon: demo goods only). */
async function eligibleLines(db: Db, conditions: CouponConditions, lines: readonly CouponLine[], demoOnly = false): Promise<CouponLine[]> {
  const productFilters = hasAny(conditions.platformIds) || hasAny(conditions.categoryIds) || hasAny(conditions.productIds) || hasAny(conditions.productKinds);
  if (!productFilters && !demoOnly) return [...lines];
  const variantIds = [...new Set(lines.map((line) => line.variantId))];
  if (variantIds.length === 0) return [];
  const rows = await db
    .select({ variantId: variants.id, productId: products.id, platformId: products.platformId, categoryId: products.categoryId, kind: products.kind, isDemo: products.isDemo })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(sql`${variants.id} IN (SELECT value FROM json_each(${JSON.stringify(variantIds)}))`);
  const byVariant = new Map(rows.map((row) => [row.variantId, row]));

  // A coupon for a category also covers its sub-categories.
  let ancestorsOf: (categoryId: string | null) => Set<string> = (categoryId) => new Set(categoryId ? [categoryId] : []);
  if (hasAny(conditions.categoryIds)) {
    const tree = await db.select({ id: categories.id, parentId: categories.parentId }).from(categories);
    const parent = new Map(tree.map((row) => [row.id, row.parentId]));
    ancestorsOf = (categoryId) => {
      const seen = new Set<string>();
      for (let current = categoryId; current && !seen.has(current); current = parent.get(current) ?? null) seen.add(current);
      return seen;
    };
  }

  return lines.filter((line) => {
    const product = byVariant.get(line.variantId);
    if (!product) return false;
    if (demoOnly && !product.isDemo) return false;
    if (hasAny(conditions.productIds) && !conditions.productIds.includes(product.productId)) return false;
    if (hasAny(conditions.productKinds) && !conditions.productKinds.includes(product.kind)) return false;
    if (hasAny(conditions.platformIds) && (!product.platformId || !conditions.platformIds.includes(product.platformId))) return false;
    if (hasAny(conditions.categoryIds)) {
      const chain = ancestorsOf(product.categoryId);
      if (!conditions.categoryIds.some((categoryId) => chain.has(categoryId))) return false;
    }
    return true;
  });
}

/** Evaluates a coupon code against a cart or an order being placed. Reads only. */
export async function evaluateCoupon(db: Db, input: EvaluateCouponInput, now: number): Promise<CouponEvaluation> {
  assertMoney(input.subtotalIqd, "subtotalIqd");
  for (const line of input.lines) {
    assertMoney(line.unitPriceIqd, "unitPriceIqd");
    if (!Number.isSafeInteger(line.qty) || line.qty < 1) throw new RangeError(`evaluateCoupon: qty must be a positive whole number, got ${String(line.qty)}`);
  }
  const code = normalizeCouponCode(input.code);
  if (!code) return refuse("not_found");

  const coupon: Coupon | undefined = await db
    .select()
    .from(coupons)
    .where(sql`upper(${coupons.code}) = ${code}`)
    .get();
  if (!coupon || !coupon.isActive) return refuse("not_found");
  if (coupon.startsAt !== null && now < coupon.startsAt) return refuse("not_started");
  if (coupon.endsAt !== null && now >= coupon.endsAt) return refuse("expired");

  const customerId = input.customerId ?? null;
  const phone = input.phoneE164 ?? null;
  const identity = customerId && phone ? or(eq(couponRedemptions.customerId, customerId), eq(couponRedemptions.phoneE164, phone)) : customerId ? eq(couponRedemptions.customerId, customerId) : phone ? eq(couponRedemptions.phoneE164, phone) : null;

  const [used, usedByCustomer] = await Promise.all([
    coupon.usageLimit === null
      ? Promise.resolve(0)
      : db
          .select({ n: sql<number>`count(*)` })
          .from(couponRedemptions)
          .where(and(eq(couponRedemptions.couponId, coupon.id), isNull(couponRedemptions.voidedAt)))
          .get()
          .then((row) => Number(row?.n ?? 0)),
    coupon.perCustomerLimit === null || identity === null
      ? Promise.resolve(0)
      : db
          .select({ n: sql<number>`count(*)` })
          .from(couponRedemptions)
          .where(and(eq(couponRedemptions.couponId, coupon.id), isNull(couponRedemptions.voidedAt), identity))
          .get()
          .then((row) => Number(row?.n ?? 0)),
  ]);
  if (coupon.usageLimit !== null && used >= coupon.usageLimit) return refuse("usage_limit");
  if (coupon.perCustomerLimit !== null && identity !== null && usedByCustomer >= coupon.perCustomerLimit) return refuse("customer_limit");

  const conditions: CouponConditions = coupon.conditions ?? {};
  if (input.lines.length === 0) return refuse("not_applicable");
  if (hasAny(conditions.channels) && !conditions.channels.includes(input.channel ?? "web")) return refuse("not_applicable");
  if (hasAny(conditions.segmentIds)) {
    if (!customerId) return refuse("not_applicable");
    const member = await db
      .select({ segmentId: customerSegmentMembers.segmentId })
      .from(customerSegmentMembers)
      .where(and(eq(customerSegmentMembers.customerId, customerId), sql`${customerSegmentMembers.segmentId} IN (SELECT value FROM json_each(${JSON.stringify(conditions.segmentIds)}))`))
      .get();
    if (!member) return refuse("not_applicable");
  }
  if (conditions.firstOrderOnly === true && (customerId || phone)) {
    const who = customerId && phone ? or(eq(orders.customerId, customerId), eq(orders.contactPhoneE164, phone)) : customerId ? eq(orders.customerId, customerId) : eq(orders.contactPhoneE164, phone as string);
    const previous = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(who, ne(orders.status, "cancelled")))
      .limit(1)
      .get();
    if (previous) return refuse("not_applicable");
  }

  // a demo coupon (the seeded DEMO10 / DEMO5000, one made in demo mode) never discounts real goods — the rule the
  // checkout's demo offers and flash sales follow (review 2026-11-12)
  const eligible = await eligibleLines(db, conditions, input.lines, coupon.isDemo);
  if (eligible.length === 0) return refuse("not_applicable");
  const eligibleQty = eligible.reduce((sum, line) => sum + line.qty, 0);
  if (typeof conditions.minQty === "number" && eligibleQty < conditions.minQty) return refuse("not_applicable");
  let base = 0;
  for (const line of eligible) {
    base += line.unitPriceIqd * line.qty;
    if (!Number.isSafeInteger(base)) throw new RangeError("evaluateCoupon: eligible subtotal is too large");
  }
  // a demo coupon's minimum is reached with demo goods alone (real goods never help it along); a refusal says how far
  if (coupon.minSubtotalIqd !== null) {
    const counted = coupon.isDemo ? base : input.subtotalIqd;
    if (counted < coupon.minSubtotalIqd) return { ok: false, reason: "min_subtotal", minimumIqd: coupon.minSubtotalIqd, countedIqd: counted, moreIqd: coupon.minSubtotalIqd - counted };
  }
  let discount = coupon.kind === "fixed" ? coupon.value : bpsOf(base, coupon.value);
  if (coupon.maxDiscountIqd !== null) discount = Math.min(discount, coupon.maxDiscountIqd);
  discount = Math.max(0, Math.min(discount, base, input.subtotalIqd));

  return { ok: true, couponId: coupon.id, code: coupon.code.toUpperCase(), label: coupon.description?.trim() || coupon.code.toUpperCase(), discountIqd: discount };
}
