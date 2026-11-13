/**
 * Promotions at checkout — the DATABASE side (docs/CONTRACTS.md §1 "orders/promotions"). The commerce core is the only
 * place where module 08's records change a total; module 08 itself only manages them (CONTRACTS §4 "08 promotions").
 *
 *   const facts = await loadPromotionFacts(db, { lines, customerId, phoneE164, locale, now });   // what a pricing reads
 *   // placeOrder's ONE batch:
 *   statements.push(...flashClaimStatements(db, claims, now), promotionsEventStatement(db, { orderId, record, actor, now }),
 *     ...flashLimitGuards(db, claims, who), pointsRedeemStatement(db, {…}), ...referralStatements(db, {…}));
 *   // cancellation (transitionOrder → cancelled): the allowance and the points come back, in its batch
 *   statements.push(...(await releasePromotionsStatements(db, { orderId, ref, actor, now })));
 *   // a refund issued: the redeemed points' share comes back, in the refund's batch (after its orders update)
 *   statements.push(...(await refundPointsStatements(db, { orderId, ref, refundId, amountIqd, actor, now })));
 *   const views = await orderAdjustments(db, [orderId], locale);   // the order page, the invoice
 *
 * WHAT IS READ (loadPromotionFacts): the running flash sale item of each variant (status "scheduled" and starts_at ≤ now
 * < ends_at — module 08's definition — with what is left of its allowance, and of this shopper's per-customer limit:
 * units of the item on this shopper's orders that are not cancelled, by account or by number); the live automatic
 * rules (`promotions`: switched on, inside their window; module 08's `ruleTerms`), highest priority first; the
 * customer's active membership and its tier's benefits; the customer's points balance; the programme rules in force
 * (module 08's `programRules`: a point's worth, the discount limits); the customer's segments; each line's platform,
 * category chain and kind.
 *
 * THE RECORD: placeOrder writes ONE order event of kind "promotions" (append-only) with what was applied — flash claims
 * (sale item, order line, units, sale and regular price, the sale's name and end), discounts (rule ids and names,
 * coupon code, membership tier and bps, points), the delivery waiver, the referral. It is what the order page and the
 * invoice show, what a cancellation gives back and what a per-customer flash limit counts. Never cost data.
 *
 * GIVING BACK (as module 08's ledger rules say — append-only, one idempotency key per fact):
 *   · flash allowance: a cancelled order's claimed units go back to `qty_sold` (never below 0), in the cancel batch —
 *     and, since the review of 2026-11-12, a parcel returned undelivered (shipped → returned: refused at the door) too;
 *     neither counts against a shopper's per-customer limit any more;
 *   · points: a cancelled order's — or a parcel returned undelivered's — redeemed points come back at once
 *     (`loyalty:redeem-return:<order>`), a refund gives back its share of them (`loyalty:redeem-return:<refund>`):
 *     redeemed × refund ⁄ max(order total, paid), and everything left once the order is refunded in full (nothing more
 *     to collect and everything paid gone back) — decided in SQL inside the refund's batch, so two refunds at once
 *     neither give the same points twice nor both miss being the last; never more than were redeemed. The row is kind
 *     "reversal" with ref_type "redeem" (module 08's earn reversals use ref_type "order", which this never touches) and
 *     expires like any credit (`LOYALTY.expiryDays`). Every row's `reason` is a CODE (./loyalty-reasons: "order",
 *     "cancelled", "returned", "refund" with the order's reference), never a sentence: the admin's ledger says it in
 *     its own language (client round 1, wave C);
 *   · referral (security review 2026-11-12): a cancelled order's — or a parcel returned undelivered's — referral is
 *     closed as rejected and its use goes back to the code (module 08's rejectReferral rule: uses − 1, once), in the
 *     same batch; abandoned orders can no longer use up a public code. The number stays referred (UNIQUE).
 *
 * AN ORDER EDIT (orders/edit.server.ts) that re-prices the coupon or the delivery appends a newer "promotions" event
 * (editedPromotionsRecord); every reader takes the LATEST record of an order (review 2026-11-12: the order page's lines
 * added up to the old discount).
 *
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { actorRef, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { categories, customerSegmentMembers, customers, flashSaleItems, flashSales, loyaltyLedger, membershipTiers, memberships, orderEvents, products, promotions, referralCodes, referralRedemptions, variants } from "~/server/db/schema";
import { batchSql, expectChanged, expectThat } from "~/server/db/tx.server";
import { ruleTerms } from "~/server/services/admin/promotions/discounts.server";
import { programRules } from "~/server/services/admin/promotions/program.server";
import { normalizeReferralCode } from "~/server/services/admin/promotions/referrals.server";
import type { DiscountLimits } from "~/server/services/admin/promotions/types";
import { loyaltyReasonText } from "./loyalty-reasons";
import type { FlashOffer, MemberOffer, RuleOffer } from "./promotions";
import type { DiscountLineView, FlashPriceView, OrderAdjustmentsView, ShippingWaiverView } from "./types";

/** The order event that records what promotions an order received. */
export const PROMOTIONS_EVENT = "promotions";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Idempotency keys of the loyalty rows the checkout writes. */
export const pointsRedeemKey = (orderId: string) => `loyalty:redeem:${orderId}`;
export const pointsReturnKey = (orderOrRefundId: string) => `loyalty:redeem-return:${orderOrRefundId}`;

// ───────────────────────────────────────────────────────────────── facts

export type LineFacts = { productId: string; platformId: string | null; categoryChain: string[]; kind: string; isDemo: boolean };

export type PromotionFacts = {
  /** Variant id → its running flash sale offer. */
  flash: Map<string, FlashOffer & { name: L10n }>;
  rules: (RuleOffer & { name: L10n })[];
  member: (MemberOffer & { name: L10n }) | null;
  /** Signed-in customers: their balance and what a point is worth (programme rules in force). */
  points: { balance: number; pointValueIqd: number; expiryDays: number } | null;
  limits: DiscountLimits;
  segmentIds: Set<string>;
  /** Variant id → what a rule's scope reads. */
  lines: Map<string, LineFacts>;
};

const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0));
const inList = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

/**
 * The order's record in force: an order edit that re-prices its coupon or its delivery appends a newer "promotions"
 * event (review 2026-11-12), so readers take the LATEST one — in SQL, this condition on `e` (an order_events row).
 */
const latestRecordSql = sql`NOT EXISTS (SELECT 1 FROM order_events AS later WHERE later.order_id = e.order_id AND later.kind = ${PROMOTIONS_EVENT} AND (later.at > e.at OR (later.at = e.at AND later.id > e.id)))`;
/**
 * Orders whose flash units no longer count against a shopper's limit: cancelled, or returned undelivered (a parcel
 * refused at the door gives its units back like a cancellation — review 2026-11-12).
 */
const claimsCountSql = sql`o.status <> 'cancelled' AND NOT (o.status = 'returned' AND o.delivered_at IS NULL)`;

/**
 * Units of flash sale items on this shopper's orders that still count (not cancelled, not returned undelivered — from
 * each order's latest "promotions" record), by account OR by number — what a per-customer limit counts. Item id → units.
 */
export async function flashUnitsClaimed(db: Db, itemIds: readonly string[], who: { customerId: string | null; phoneE164: string | null }): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (itemIds.length === 0 || (!who.customerId && !who.phoneE164)) return out;
  const person = who.customerId && who.phoneE164 ? sql`(o.customer_id = ${who.customerId} OR o.contact_phone_e164 = ${who.phoneE164})` : who.customerId ? sql`o.customer_id = ${who.customerId}` : sql`o.contact_phone_e164 = ${who.phoneE164}`;
  const rows = await db.all<{ item_id: string; units: number }>(sql`SELECT json_extract(f.value, '$.itemId') AS item_id, coalesce(sum(json_extract(f.value, '$.units')), 0) AS units
    FROM order_events AS e JOIN orders AS o ON o.id = e.order_id, json_each(e.data, '$.flash') AS f
    WHERE e.kind = ${PROMOTIONS_EVENT} AND ${latestRecordSql} AND ${claimsCountSql} AND ${person} AND json_extract(f.value, '$.itemId') IN (${inList(itemIds)})
    GROUP BY item_id`);
  for (const row of rows) out.set(row.item_id, num(row.units));
  return out;
}

/** The SQL of what flashUnitsClaimed counts, for a guard inside a batch (this order's own event included). */
function claimedSql(itemId: string, who: { customerId: string | null; phoneE164: string | null }) {
  const person = who.customerId && who.phoneE164 ? sql`(o.customer_id = ${who.customerId} OR o.contact_phone_e164 = ${who.phoneE164})` : who.customerId ? sql`o.customer_id = ${who.customerId}` : sql`o.contact_phone_e164 = ${who.phoneE164}`;
  return sql`(SELECT coalesce(sum(json_extract(f.value, '$.units')), 0) FROM order_events AS e JOIN orders AS o ON o.id = e.order_id, json_each(e.data, '$.flash') AS f
    WHERE e.kind = ${PROMOTIONS_EVENT} AND ${latestRecordSql} AND ${claimsCountSql} AND ${person} AND json_extract(f.value, '$.itemId') = ${itemId})`;
}

/** Everything a pricing reads about promotions for these lines and this shopper (file header). Reads only. */
export async function loadPromotionFacts(
  db: Db,
  input: { variantIds: readonly string[]; customerId: string | null; phoneE164: string | null; locale: Locale; now: number },
): Promise<PromotionFacts> {
  const now = input.now;
  const variantIds = [...new Set(input.variantIds)];
  const [program, ruleRows, flashRows, memberRow, balanceRow, segmentRows, lineRows] = await Promise.all([
    programRules(db),
    db
      .select()
      .from(promotions)
      .where(and(eq(promotions.isActive, true), sql`(${promotions.startsAt} IS NULL OR ${promotions.startsAt} <= ${now})`, sql`(${promotions.endsAt} IS NULL OR ${promotions.endsAt} > ${now})`))
      .orderBy(desc(promotions.priority), promotions.createdAt),
    variantIds.length
      ? db
          .select({
            itemId: flashSaleItems.id,
            saleId: flashSales.id,
            name: flashSales.name,
            variantId: flashSaleItems.variantId,
            salePriceIqd: flashSaleItems.salePriceIqd,
            qtyLimit: flashSaleItems.qtyLimit,
            qtySold: flashSaleItems.qtySold,
            perCustomerLimit: flashSaleItems.perCustomerLimit,
            endsAt: flashSales.endsAt,
            isDemo: flashSales.isDemo,
          })
          .from(flashSaleItems)
          .innerJoin(flashSales, eq(flashSales.id, flashSaleItems.flashSaleId))
          .where(and(inArray(flashSaleItems.variantId, variantIds), eq(flashSales.status, "scheduled"), sql`${flashSales.startsAt} <= ${now}`, sql`${flashSales.endsAt} > ${now}`))
      : Promise.resolve([]),
    input.customerId
      ? db
          .select({ id: memberships.id, tierId: membershipTiers.id, name: membershipTiers.name, benefits: membershipTiers.benefits })
          .from(memberships)
          .innerJoin(membershipTiers, eq(membershipTiers.id, memberships.tierId))
          .where(and(eq(memberships.customerId, input.customerId), eq(memberships.status, "active"), sql`${memberships.startsAt} <= ${now}`, sql`(${memberships.endsAt} IS NULL OR ${memberships.endsAt} > ${now})`, eq(membershipTiers.isActive, true)))
          .orderBy(desc(memberships.startsAt))
          .limit(1)
          .get()
      : Promise.resolve(undefined),
    input.customerId ? db.select({ n: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)` }).from(loyaltyLedger).where(eq(loyaltyLedger.customerId, input.customerId)).get() : Promise.resolve(undefined),
    input.customerId ? db.select({ segmentId: customerSegmentMembers.segmentId }).from(customerSegmentMembers).where(eq(customerSegmentMembers.customerId, input.customerId)) : Promise.resolve([]),
    variantIds.length
      ? db
          .select({ variantId: variants.id, productId: products.id, platformId: products.platformId, categoryId: products.categoryId, kind: products.kind, isDemo: products.isDemo })
          .from(variants)
          .innerJoin(products, eq(products.id, variants.productId))
          .where(inArray(variants.id, variantIds))
      : Promise.resolve([]),
  ]);

  // category chains, only when a rule looks at categories
  const rules = ruleRows.map((row) => ({ id: row.id, label: pick(row.name, input.locale), name: row.name, terms: ruleTerms(row), isDemo: row.isDemo }));
  let chainOf = (categoryId: string | null): string[] => (categoryId ? [categoryId] : []);
  if (rules.some((rule) => rule.terms.scope.categoryIds.length > 0)) {
    const tree = await db.select({ id: categories.id, parentId: categories.parentId }).from(categories);
    const parent = new Map(tree.map((row) => [row.id, row.parentId]));
    chainOf = (categoryId) => {
      const seen: string[] = [];
      for (let current = categoryId; current && !seen.includes(current); current = parent.get(current) ?? null) seen.push(current);
      return seen;
    };
  }
  const lines = new Map<string, LineFacts>(lineRows.map((row) => [row.variantId, { productId: row.productId, platformId: row.platformId, categoryChain: chainOf(row.categoryId), kind: row.kind, isDemo: row.isDemo }]));

  // flash: one offer per variant (overlapping sales of a SKU are refused by module 08; the lowest price if ever two)
  const claimed = await flashUnitsClaimed(
    db,
    flashRows.filter((row) => row.perCustomerLimit !== null).map((row) => row.itemId),
    { customerId: input.customerId, phoneE164: input.phoneE164 },
  );
  const flash = new Map<string, FlashOffer & { name: L10n }>();
  for (const row of flashRows) {
    const known = flash.get(row.variantId);
    if (known && known.salePriceIqd <= row.salePriceIqd) continue;
    flash.set(row.variantId, {
      itemId: row.itemId,
      saleId: row.saleId,
      label: pick(row.name, input.locale),
      name: row.name,
      salePriceIqd: row.salePriceIqd,
      left: row.qtyLimit === null ? null : Math.max(0, row.qtyLimit - row.qtySold),
      perCustomerLimit: row.perCustomerLimit,
      perCustomerLeft: row.perCustomerLimit === null ? null : Math.max(0, row.perCustomerLimit - (claimed.get(row.itemId) ?? 0)),
      endsAt: row.endsAt,
      isDemo: row.isDemo,
    });
  }

  const benefits = memberRow?.benefits ?? null;
  const member =
    memberRow && benefits && ((typeof benefits.discountBps === "number" && benefits.discountBps > 0) || benefits.freeShipping === true)
      ? { membershipId: memberRow.id, tierId: memberRow.tierId, label: pick(memberRow.name, input.locale), name: memberRow.name, discountBps: typeof benefits.discountBps === "number" && benefits.discountBps > 0 ? Math.floor(benefits.discountBps) : null, freeShipping: benefits.freeShipping === true }
      : null;

  return {
    flash,
    rules,
    member,
    points: input.customerId ? { balance: Math.max(0, num(balanceRow?.n)), pointValueIqd: program.loyalty.pointValueIqd, expiryDays: program.loyalty.expiryDays } : null,
    limits: program.limits,
    segmentIds: new Set(segmentRows.map((row) => row.segmentId)),
    lines,
  };
}

/**
 * The price a running flash sale sells a variant at now (its allowance not used up), or null — what the cart remembers
 * as the price a line was added at, so a line added during the sale does not say "the price changed". A demo sale
 * prices demo goods only. Reads only.
 */
export async function runningFlashPrice(db: Db, variant: { id: string; priceIqd: number; productIsDemo: boolean }, now: number): Promise<number | null> {
  const row = await db
    .select({ price: sql<number | null>`min(${flashSaleItems.salePriceIqd})` })
    .from(flashSaleItems)
    .innerJoin(flashSales, eq(flashSales.id, flashSaleItems.flashSaleId))
    .where(
      and(
        eq(flashSaleItems.variantId, variant.id),
        eq(flashSales.status, "scheduled"),
        sql`${flashSales.startsAt} <= ${now}`,
        sql`${flashSales.endsAt} > ${now}`,
        sql`(${flashSaleItems.qtyLimit} IS NULL OR ${flashSaleItems.qtySold} < ${flashSaleItems.qtyLimit})`,
        variant.productIsDemo ? sql`1 = 1` : eq(flashSales.isDemo, false),
      ),
    )
    .get();
  const price = row?.price === null || row?.price === undefined ? null : num(row.price);
  return price !== null && price < variant.priceIqd ? price : null;
}

// ───────────────────────────────────────────────────────────────── referral codes (typed at checkout)

export const REFERRAL_ISSUES = ["referral_code_unknown", "referral_code_inactive", "referral_cap_reached", "referral_self", "referral_phone_used"] as const;
export type ReferralIssue = (typeof REFERRAL_ISSUES)[number];

export type ReferralCheck = { ok: true; codeId: string; code: string; referrerId: string } | { ok: false; code: string; issue: ReferralIssue };

/**
 * A referral code as typed (module 08's normalization), checked like module 08's `recordReferral` does: it exists, is
 * switched on and below its cap; with the order's number also not the referrer's own account or number, and a number
 * that was never referred before (one referral per number, UNIQUE). Reads only.
 */
export async function checkReferralCode(db: Db, raw: string, who: { phoneE164: string | null; customerId: string | null }): Promise<ReferralCheck | null> {
  const typed = normalizeReferralCode(String(raw ?? "").slice(0, 40));
  if (!typed) return null;
  if (typed.length < 3 || typed.length > 20) return { ok: false, code: typed, issue: "referral_code_unknown" };
  const row = await db.select().from(referralCodes).where(eq(referralCodes.code, typed)).get();
  if (!row) return { ok: false, code: typed, issue: "referral_code_unknown" };
  if (!row.isActive) return { ok: false, code: row.code, issue: "referral_code_inactive" };
  if (row.maxUses !== null && row.uses >= row.maxUses) return { ok: false, code: row.code, issue: "referral_cap_reached" };
  const referrer = await db.select({ id: customers.id, phone: customers.phoneE164, status: customers.status }).from(customers).where(eq(customers.id, row.customerId)).get();
  if (!referrer || referrer.status !== "active") return { ok: false, code: row.code, issue: "referral_code_inactive" };
  if (who.customerId === referrer.id || (who.phoneE164 !== null && who.phoneE164 === referrer.phone)) return { ok: false, code: row.code, issue: "referral_self" };
  if (who.phoneE164) {
    const used = await db.select({ id: referralRedemptions.id }).from(referralRedemptions).where(eq(referralRedemptions.referredPhoneE164, who.phoneE164)).get();
    if (used) return { ok: false, code: row.code, issue: "referral_phone_used" };
  }
  return { ok: true, codeId: row.id, code: row.code, referrerId: referrer.id };
}

/**
 * The referral of a new order, in placeOrder's batch (module 08's own rules): the code's use counted with its cap
 * guarded (`uses + 1`, still switched on), a `referral_redemptions` row "pending" (a number is referred once —
 * UNIQUE). Module 08 rewards the referrer after delivery and the return window (rewardReferral).
 */
export function referralStatements(db: Db, input: { referralId: string; codeId: string; orderId: string; phoneE164: string; customerId: string | null; now: number }): BatchStatement[] {
  return [
    db
      .update(referralCodes)
      .set({ uses: sql`${referralCodes.uses} + 1` })
      .where(and(eq(referralCodes.id, input.codeId), eq(referralCodes.isActive, true), sql`(${referralCodes.maxUses} IS NULL OR ${referralCodes.uses} < ${referralCodes.maxUses})`)),
    expectChanged(db, 1, { code: "REFERRAL_CAP", detail: input.codeId }),
    db.insert(referralRedemptions).values({ id: input.referralId, referralCodeId: input.codeId, referredCustomerId: input.customerId, referredPhoneE164: input.phoneE164, orderId: input.orderId, status: "pending", createdAt: input.now }),
  ];
}

// ───────────────────────────────────────────────────────────────── the order's record

export type FlashClaim = { itemId: string; saleId: string; orderItemId: string; variantId: string; units: number; salePriceIqd: number; regularPriceIqd: number; endsAt: number; name: L10n; perCustomerLimit: number | null };

/** What the "promotions" order event stores (version 1). Amounts as charged; names as they were. */
export type PromotionsRecord = {
  v: 1;
  flash: FlashClaim[];
  discounts: (
    | { kind: "rule"; ruleId: string; name: L10n; amountIqd: number }
    | { kind: "coupon"; code: string; label: string; amountIqd: number }
    | { kind: "member"; membershipId: string; tierId: string; name: L10n; bps: number; amountIqd: number }
    | { kind: "points"; points: number; amountIqd: number }
  )[];
  shipping: { by: "member" | "rule"; ruleId?: string; membershipId?: string; name: L10n; feeIqd: number; waivedIqd: number } | null;
  referral: { code: string; referralId: string } | null;
};

/** True when the record carries anything worth an event. */
export const hasPromotions = (record: PromotionsRecord) => record.flash.length > 0 || record.discounts.length > 0 || record.shipping !== null || record.referral !== null;

export function promotionsEventStatement(db: Db, input: { orderId: string; record: PromotionsRecord; actor: Actor; now: number }): BatchStatement {
  const { actorKind, actorId } = actorRef(input.actor);
  return db.insert(orderEvents).values({ id: newId("oev"), orderId: input.orderId, kind: PROMOTIONS_EVENT, data: input.record as unknown as Record<string, unknown>, actorKind, actorId, at: input.now });
}

/**
 * The flash allowance claims of a new order, in its batch: `qty_sold + units`, guarded on the sale still running at the
 * same price and the allowance not passing its limit (`qty_sold ≤ qty_limit` is also a CHECK). A claim that fails
 * aborts the order (FLASH_CHANGED: the cart is priced again and the shopper sees the new total).
 */
export function flashClaimStatements(db: Db, claims: readonly FlashClaim[], now: number): BatchStatement[] {
  const statements: BatchStatement[] = [];
  for (const claim of claims) {
    statements.push(
      db
        .update(flashSaleItems)
        .set({ qtySold: sql`${flashSaleItems.qtySold} + ${claim.units}` })
        .where(
          and(
            eq(flashSaleItems.id, claim.itemId),
            eq(flashSaleItems.salePriceIqd, claim.salePriceIqd),
            sql`(${flashSaleItems.qtyLimit} IS NULL OR ${flashSaleItems.qtySold} + ${claim.units} <= ${flashSaleItems.qtyLimit})`,
            sql`EXISTS (SELECT 1 FROM flash_sales AS s WHERE s.id = ${flashSaleItems.flashSaleId} AND s.status = 'scheduled' AND s.starts_at <= ${now} AND s.ends_at > ${now})`,
          ),
        ),
      expectChanged(db, 1, { code: "FLASH_CHANGED", detail: claim.itemId }),
    );
  }
  return statements;
}

/** Per-customer limits, checked AFTER this order's "promotions" event is in the batch (it counts itself). */
export function flashLimitGuards(db: Db, claims: readonly FlashClaim[], who: { customerId: string | null; phoneE164: string | null }): BatchStatement[] {
  if (!who.customerId && !who.phoneE164) return [];
  return claims.filter((claim) => claim.perCustomerLimit !== null).map((claim) => expectThat(db, sql`${claimedSql(claim.itemId, who)} <= ${claim.perCustomerLimit}`, { code: "FLASH_LIMIT", detail: claim.itemId }));
}

/**
 * The redemption of `points` for an order, in its batch (the overdraft trigger refuses more than the balance:
 * TT:LOYALTY_OVERDRAFT). Its reason is the code "order" (./loyalty-reasons: the order's reference — a screen says it
 * in its own language).
 */
export function pointsRedeemStatement(db: Db, input: { orderId: string; ref: string; customerId: string; points: number; actor: Actor; now: number }): BatchStatement {
  const { actorKind, actorId } = actorRef(input.actor);
  return db.insert(loyaltyLedger).values({ id: newId("lyl"), customerId: input.customerId, points: -input.points, kind: "redeem", refType: "order", refId: input.orderId, reason: loyaltyReasonText({ code: "order", ref: input.ref }), expiresAt: null, actorKind, actorId, idempotencyKey: pointsRedeemKey(input.orderId), at: input.now });
}

/** The order's "promotions" record in force (the latest — an order edit appends a re-priced one), or null. */
export async function promotionsRecordOf(db: Db, orderId: string): Promise<PromotionsRecord | null> {
  const row = await db
    .select({ data: orderEvents.data })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.kind, PROMOTIONS_EVENT)))
    .orderBy(desc(orderEvents.at), desc(orderEvents.id))
    .get();
  return row?.data ? (row.data as unknown as PromotionsRecord) : null;
}

/**
 * SQL, for a refund's batch AFTER its own `orders` update: the order is refunded in full NOW — everything it was paid
 * has gone back and no payment of it still waits for money (cash on delivery to collect, a transfer to come or to be
 * checked). Decided at write time, so two refunds issued at the same moment see each other (review 2026-11-12: each
 * decided on its own earlier read, and neither was "the last one").
 */
export function orderRefundedInFullSql(orderId: string) {
  return sql`(EXISTS (SELECT 1 FROM orders WHERE id = ${orderId} AND refunded_iqd >= paid_iqd) AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = ${orderId} AND status IN ('pending', 'pending_verification', 'rejected')))`;
}

/**
 * A loyalty row that gives redeemed points back, decided in SQL inside the batch (two refunds at once cannot both
 * give back the same points, nor both miss being the last): `all` gives back what is left of the redemption (a
 * cancellation, a parcel returned undelivered); `refundIqd` gives back that refund's share of the ORDER — redeemed ×
 * refund ⁄ max(total, paid), so a refund of a split order's wallet part while its cash is still to collect is a share,
 * never everything (review 2026-11-12) — and everything left once the order is refunded in full
 * (orderRefundedInFullSql). Never more than the order redeemed minus what earlier rows gave back; whole points; nothing
 * is written when nothing is left. The points go to the account that holds the order at write time (`customerId` is
 * the fallback for an order without one).
 */
function pointsReturnStatement(
  db: Db,
  input: { orderId: string; customerId: string; give: { all: true } | { refundIqd: number }; key: string; reason: string; expiryDays: number; actor: Actor; now: number },
): BatchStatement {
  const { actorKind, actorId } = actorRef(input.actor);
  const redeemed = sql`(SELECT coalesce(-sum(points), 0) FROM loyalty_ledger WHERE idempotency_key = ${pointsRedeemKey(input.orderId)})`;
  const returned = sql`(SELECT coalesce(sum(points), 0) FROM loyalty_ledger WHERE kind = 'reversal' AND ref_type = 'redeem' AND ref_id IN (SELECT ${input.orderId} UNION ALL SELECT id FROM refunds WHERE order_id = ${input.orderId}))`;
  const left = sql`(${redeemed} - ${returned})`;
  let give = left;
  if (!("all" in input.give)) {
    const refund = Math.max(0, Math.floor(input.give.refundIqd));
    const basis = sql`(SELECT max(total_iqd, paid_iqd) FROM orders WHERE id = ${input.orderId})`;
    const share = sql`(CASE WHEN ${basis} > 0 THEN (${redeemed} * min(CAST(${refund} AS INTEGER), ${basis})) / ${basis} ELSE ${left} END)`;
    give = sql`(CASE WHEN ${orderRefundedInFullSql(input.orderId)} THEN ${left} ELSE min(${share}, ${left}) END)`;
  }
  const points = sql`CAST(${give} AS INTEGER)`;
  // to the account that holds the order NOW (at write time): module 07's merge moves a duplicate's orders to the kept
  // account, and points given back to the merged-away one would be lost (review 2026-11-12)
  const holder = sql`coalesce((SELECT customer_id FROM orders WHERE id = ${input.orderId}), ${input.customerId})`;
  return batchSql(
    db,
    sql`INSERT INTO loyalty_ledger (id, customer_id, points, kind, ref_type, ref_id, reason, expires_at, actor_kind, actor_id, idempotency_key, at)
      SELECT ${newId("lyl")}, ${holder}, ${points}, 'reversal', 'redeem', ${input.key.slice(input.key.lastIndexOf(":") + 1)}, ${input.reason}, ${input.now + input.expiryDays * DAY_MS}, ${actorKind}, ${actorId}, ${input.key}, ${input.now}
      WHERE ${points} > 0 AND NOT EXISTS (SELECT 1 FROM loyalty_ledger WHERE idempotency_key = ${input.key})`,
  );
}

/**
 * A cancellation, or a parcel returned undelivered (in transitionOrder's batch): the flash units the order claimed go
 * back to their allowance, the points it redeemed come back to the customer (file header), and its referral is closed
 * with its use given back to the code — once: the transition is guarded on the order's status, the points row on its key
 * and on what is left, the referral on still being open. Nothing for an order without a record.
 */
export async function releasePromotionsStatements(db: Db, input: { orderId: string; ref: string; actor: Actor; now: number; why?: "cancelled" | "returned" }): Promise<BatchStatement[]> {
  const record = await promotionsRecordOf(db, input.orderId);
  if (!record) return [];
  const statements: BatchStatement[] = [];
  // a code, not a sentence (./loyalty-reasons): "<ref> · cancelled" / "<ref> · returned" — the admin says it in its language
  const reason = loyaltyReasonText({ code: input.why ?? "cancelled", ref: input.ref });
  for (const claim of record.flash) {
    statements.push(batchSql(db, sql`UPDATE flash_sale_items SET qty_sold = qty_sold - min(qty_sold, ${claim.units}) WHERE id = ${claim.itemId}`));
  }
  const points = record.discounts.find((entry) => entry.kind === "points");
  if (points && points.kind === "points" && points.points > 0) {
    const redeem = await db.select({ customerId: loyaltyLedger.customerId }).from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, pointsRedeemKey(input.orderId))).get();
    if (redeem) {
      const program = await programRules(db);
      statements.push(pointsReturnStatement(db, { orderId: input.orderId, customerId: redeem.customerId, give: { all: true }, key: pointsReturnKey(input.orderId), reason, expiryDays: program.loyalty.expiryDays, actor: input.actor, now: input.now }));
    }
  }
  // The referral the order recorded (security review 2026-11-12): an order cancelled — or a parcel refused at the
  // door — referred nobody, so its use goes back to the code and the referral is closed as rejected, the way module
  // 08's rejectReferral closes one (uses − 1 once: guarded on the referral being still open at write time). It used to
  // stay open: ten abandoned cash-on-delivery orders (a guest, any ten numbers) used up a friend's public code for
  // everyone until staff rejected each referral by hand. The number itself stays referred (module 08's UNIQUE rule).
  if (record.referral) {
    const open = await db
      .select({ id: referralRedemptions.id, codeId: referralRedemptions.referralCodeId, status: referralRedemptions.status })
      .from(referralRedemptions)
      .where(and(eq(referralRedemptions.id, record.referral.referralId), eq(referralRedemptions.orderId, input.orderId)))
      .get();
    if (open && (open.status === "pending" || open.status === "qualified")) {
      statements.push(
        batchSql(db, sql`UPDATE referral_codes SET uses = uses - 1 WHERE id = ${open.codeId} AND uses > 0 AND EXISTS (SELECT 1 FROM referral_redemptions WHERE id = ${open.id} AND status IN ('pending', 'qualified'))`),
        batchSql(db, sql`UPDATE referral_redemptions SET status = 'rejected', reject_reason = ${reason} WHERE id = ${open.id} AND status IN ('pending', 'qualified')`),
        auditStatement(db, { actor: input.actor, action: "promotions.referral.reject", entityType: "referral", entityId: open.id, summary: record.referral.code, reason, at: input.now }),
      );
    }
  }
  return statements;
}

/**
 * A refund issued (in its batch, AFTER its `orders` update): the redeemed points' share of it comes back — decided in
 * SQL at write time (pointsReturnStatement: the refund's share of the order, all of the rest once the order is refunded
 * in full; restoredPointsFor in ./promotions is the same rule, pure). `paidIqd` and `full` are no longer read (kept so
 * callers still compile): the batch decides both (review 2026-11-12).
 */
export async function refundPointsStatements(
  db: Db,
  input: { orderId: string; ref: string; refundId: string; amountIqd: number; /** @deprecated decided in the batch */ paidIqd?: number; /** @deprecated decided in the batch */ full?: boolean; actor: Actor; now: number },
): Promise<BatchStatement[]> {
  const redeem = await db.select({ customerId: loyaltyLedger.customerId, points: loyaltyLedger.points }).from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, pointsRedeemKey(input.orderId))).get();
  if (!redeem || redeem.points >= 0 || !(input.amountIqd > 0)) return [];
  const program = await programRules(db);
  return [pointsReturnStatement(db, { orderId: input.orderId, customerId: redeem.customerId, give: { refundIqd: input.amountIqd }, key: pointsReturnKey(input.refundId), reason: loyaltyReasonText({ code: "refund", ref: input.ref, refundId: input.refundId }), expiryDays: program.loyalty.expiryDays, actor: input.actor, now: input.now })];
}

// ───────────────────────────────────────────────────────────────── the views

/** The record as the shopper's views show it (names in the request's language). */
export function adjustmentsView(record: PromotionsRecord, locale: Locale): OrderAdjustmentsView {
  const discounts: DiscountLineView[] = record.discounts.map((entry) => {
    switch (entry.kind) {
      case "rule":
        return { kind: "rule", ruleId: entry.ruleId, label: pick(entry.name, locale), amountIqd: entry.amountIqd };
      case "coupon":
        return { kind: "coupon", code: entry.code, label: entry.label, amountIqd: entry.amountIqd };
      case "member":
        return { kind: "member", label: pick(entry.name, locale), bps: entry.bps, amountIqd: entry.amountIqd };
      case "points":
        return { kind: "points", points: entry.points, amountIqd: entry.amountIqd };
    }
  });
  const shippingWaiver: ShippingWaiverView | null = record.shipping ? { by: record.shipping.by, label: pick(record.shipping.name, locale), feeIqd: record.shipping.feeIqd, waivedIqd: record.shipping.waivedIqd } : null;
  const flash: Record<string, FlashPriceView> = {};
  for (const claim of record.flash) flash[claim.orderItemId] = { label: pick(claim.name, locale), salePriceIqd: claim.salePriceIqd, regularPriceIqd: claim.regularPriceIqd, endsAt: claim.endsAt };
  return { discounts, shippingWaiver, flash, referralCode: record.referral?.code ?? null };
}

/** Order id → what its promotions record in force says (the latest), for these orders (the order page, the invoice). Reads only. */
export async function orderAdjustments(db: Db, orderIds: readonly string[], locale: Locale): Promise<Map<string, OrderAdjustmentsView>> {
  const out = new Map<string, OrderAdjustmentsView>();
  const ids = [...new Set(orderIds)];
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db
      .select({ orderId: orderEvents.orderId, data: orderEvents.data })
      .from(orderEvents)
      .where(and(eq(orderEvents.kind, PROMOTIONS_EVENT), inArray(orderEvents.orderId, ids.slice(i, i + 90))))
      .orderBy(orderEvents.at, orderEvents.id);
    // oldest first: a later record (an order edit) replaces the earlier one
    for (const row of rows) if (row.data) out.set(row.orderId, adjustmentsView(row.data as unknown as PromotionsRecord, locale));
  }
  return out;
}

/**
 * The record an order edit leaves (review 2026-11-12), or null when nothing in it changes: the coupon's line re-priced
 * (or gone when the coupon no longer applies), the delivery waiver on the new governorate's fee. Pure.
 */
export function editedPromotionsRecord(
  record: PromotionsRecord,
  change: { coupon?: { afterIqd: number; lost: boolean } | null; shipping?: { feeIqd: number; waivedIqd: number } | null },
): PromotionsRecord | null {
  let changed = false;
  let discounts = record.discounts;
  if (change.coupon) {
    const coupon = change.coupon;
    discounts = record.discounts.flatMap((entry): PromotionsRecord["discounts"] => {
      if (entry.kind !== "coupon") return [entry];
      if (coupon.lost || coupon.afterIqd <= 0) {
        changed = true;
        return [];
      }
      if (entry.amountIqd === coupon.afterIqd) return [entry];
      changed = true;
      return [{ ...entry, amountIqd: coupon.afterIqd }];
    });
  }
  let shipping = record.shipping;
  if (change.shipping && record.shipping && (record.shipping.feeIqd !== change.shipping.feeIqd || record.shipping.waivedIqd !== change.shipping.waivedIqd)) {
    shipping = { ...record.shipping, feeIqd: change.shipping.feeIqd, waivedIqd: change.shipping.waivedIqd };
    changed = true;
  }
  return changed ? { ...record, discounts, shipping } : null;
}
