/**
 * The customer's points, membership and referral code (account `/account/rewards`; module 08's records, read here for
 * their owner only — what the account shows, never what decides anything: the commerce core prices, module 08 posts).
 *
 *   const rewards = await getRewards(db, customerId, locale, now);
 *   const { code } = await issueOwnReferralCode(db, actor, now);      // module 08's issueReferralCode, for the customer
 *
 * Points: the balance (the ledger's sum), what they are worth at checkout (the programme's point value in force), what
 * expires within 30 days (module 08's FIFO rule: credits that expire by then minus every debit so far), the next
 * expiry, and the history (newest first, 50 rows; an order's reference only for the customer's own orders). The earn
 * rule in words comes from the programme (1 point per whole 1,000 IQD of goods paid and kept, after delivery and the
 * return window). Membership: the active one, its tier's written benefits as the checkout applies them (a discount
 * within the store's limits, free delivery, a points multiplier), its end. Referral: the customer's own code, its uses
 * and cap, switched on or off. Must not import "cloudflare:workers".
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import type { CustomerActor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { loyaltyLedger, membershipTiers, memberships, orders, referralCodes, refunds } from "~/server/db/schema";
import { programRules } from "~/server/services/admin/promotions/program.server";
import { issueReferralCode } from "~/server/services/admin/promotions/referrals.server";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PointsEntryView = {
  id: string;
  kind: "earn" | "redeem" | "expire" | "adjust" | "reversal";
  points: number;
  at: number;
  /** The order it belongs to (earned on, redeemed in, given back for), when it is the customer's own. */
  orderRef: string | null;
  /** Referral rewards and redemption returns read differently from an order's earn. */
  refType: string | null;
  expiresAt: number | null;
};

export type RewardsView = {
  points: {
    balance: number;
    pointValueIqd: number;
    valueIqd: number;
    /** Points that expire within 30 days (first in, first out). */
    expiringSoon: number;
    /** When the next credit expires (null when none will). */
    nextExpiryAt: number | null;
    pointsPerThousandIqd: number;
    expiryDays: number;
    entries: PointsEntryView[];
  };
  membership: { tier: string; endsAt: number | null; discountBps: number | null; appliedBps: number | null; perOrderIqd: number; freeShipping: boolean; multiplierBps: number | null } | null;
  referral: { code: string; uses: number; maxUses: number | null; active: boolean; rewardPoints: number } | null;
  /** The reward a referrer earns (programme in force), for the invitation sentence when no code exists yet. */
  referralRewardPoints: number;
};

const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0));

/** The account's rewards page (file header). Reads only; the customer's own rows only. */
export async function getRewards(db: Db, customerId: string, locale: Locale, now: number): Promise<RewardsView> {
  const soon = now + 30 * DAY_MS;
  const [program, sums, rows, credits, membership, code] = await Promise.all([
    programRules(db),
    db
      .select({
        balance: sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)`,
        soon: sql<number>`coalesce(sum(CASE WHEN ${loyaltyLedger.points} > 0 AND ${loyaltyLedger.expiresAt} IS NOT NULL AND ${loyaltyLedger.expiresAt} <= ${soon} THEN ${loyaltyLedger.points} ELSE 0 END), 0)`,
        debits: sql<number>`coalesce(sum(CASE WHEN ${loyaltyLedger.points} < 0 THEN -${loyaltyLedger.points} ELSE 0 END), 0)`,
      })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.customerId, customerId))
      .get(),
    db
      .select({ id: loyaltyLedger.id, kind: loyaltyLedger.kind, points: loyaltyLedger.points, at: loyaltyLedger.at, refType: loyaltyLedger.refType, refId: loyaltyLedger.refId, expiresAt: loyaltyLedger.expiresAt })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.customerId, customerId))
      .orderBy(desc(loyaltyLedger.at), desc(loyaltyLedger.id))
      .limit(50),
    // the credits that can expire, oldest expiry first (for the FIFO walk below)
    db
      .select({ points: loyaltyLedger.points, expiresAt: loyaltyLedger.expiresAt })
      .from(loyaltyLedger)
      .where(and(eq(loyaltyLedger.customerId, customerId), sql`${loyaltyLedger.points} > 0`, sql`${loyaltyLedger.expiresAt} IS NOT NULL`))
      .orderBy(loyaltyLedger.expiresAt)
      .limit(2000),
    db
      .select({ endsAt: memberships.endsAt, name: membershipTiers.name, benefits: membershipTiers.benefits })
      .from(memberships)
      .innerJoin(membershipTiers, eq(membershipTiers.id, memberships.tierId))
      .where(and(eq(memberships.customerId, customerId), eq(memberships.status, "active"), sql`${memberships.startsAt} <= ${now}`, sql`(${memberships.endsAt} IS NULL OR ${memberships.endsAt} > ${now})`, eq(membershipTiers.isActive, true)))
      .orderBy(desc(memberships.startsAt))
      .get(),
    db.select().from(referralCodes).where(eq(referralCodes.customerId, customerId)).get(),
  ]);

  // order references: earn / redeem rows point at the order, a redemption's return at the order or one of its refunds
  const orderIds = new Set(rows.filter((row) => row.refType === "order" && row.refId).map((row) => row.refId as string));
  const refundIds = rows.filter((row) => row.refType === "redeem" && row.refId).map((row) => row.refId as string);
  const refundOrders = refundIds.length ? await db.select({ id: refunds.id, orderId: refunds.orderId }).from(refunds).where(inArray(refunds.id, refundIds)) : [];
  for (const id of refundIds) orderIds.add(id);
  for (const row of refundOrders) orderIds.add(row.orderId);
  const own = orderIds.size ? await db.select({ id: orders.id, ref: orders.ref }).from(orders).where(and(inArray(orders.id, [...orderIds]), eq(orders.customerId, customerId))) : [];
  const refOf = new Map(own.map((row) => [row.id, row.ref]));
  const orderOfRefund = new Map(refundOrders.map((row) => [row.id, row.orderId]));

  const balance = Math.max(0, num(sums?.balance));
  // The next date points really expire (module 08's FIFO rule: every debit used the oldest credits first): the first
  // future expiry by which the credits that expire exceed everything spent — not merely the oldest credit's date,
  // whose points may long be used.
  let nextExpiryAt: number | null = null;
  let expiring = 0;
  for (const credit of credits) {
    expiring += num(credit.points);
    if (credit.expiresAt !== null && credit.expiresAt > now && expiring > num(sums?.debits)) {
      nextExpiryAt = num(credit.expiresAt);
      break;
    }
  }
  const benefits = membership?.benefits ?? null;
  const discountBps = typeof benefits?.discountBps === "number" && benefits.discountBps > 0 ? benefits.discountBps : null;
  const multiplierBps = typeof benefits?.pointsMultiplierBps === "number" && benefits.pointsMultiplierBps > 10_000 ? benefits.pointsMultiplierBps : null;
  return {
    points: {
      balance,
      pointValueIqd: program.loyalty.pointValueIqd,
      valueIqd: balance * program.loyalty.pointValueIqd,
      expiringSoon: Math.min(balance, Math.max(0, num(sums?.soon) - num(sums?.debits))),
      nextExpiryAt: balance > 0 ? nextExpiryAt : null,
      pointsPerThousandIqd: program.loyalty.pointsPerThousandIqd,
      expiryDays: program.loyalty.expiryDays,
      entries: rows.map((row) => {
        const orderId = row.refType === "order" ? row.refId : row.refType === "redeem" && row.refId ? (refOf.has(row.refId) ? row.refId : (orderOfRefund.get(row.refId) ?? null)) : null;
        return { id: row.id, kind: row.kind, points: row.points, at: row.at, orderRef: orderId ? (refOf.get(orderId) ?? null) : null, refType: row.refType, expiresAt: row.expiresAt };
      }),
    },
    membership: membership
      ? {
          tier: pick(membership.name, locale),
          endsAt: membership.endsAt,
          discountBps,
          // what the checkout applies: never above the store's discount limits in force (orders/promotions.ts)
          appliedBps: discountBps === null ? null : Math.min(discountBps, program.limits.percentBps),
          perOrderIqd: program.limits.perOrderIqd,
          freeShipping: benefits?.freeShipping === true,
          multiplierBps,
        }
      : null,
    referral: code ? { code: code.code, uses: code.uses, maxUses: code.maxUses, active: code.isActive, rewardPoints: program.referral.rewardPoints } : null,
    referralRewardPoints: program.referral.rewardPoints,
  };
}

/** The customer's own referral code — module 08's issueReferralCode for the customer (asking again returns the same code). */
export async function issueOwnReferralCode(db: Db, actor: CustomerActor, now: number): Promise<{ code: string; replayed: boolean }> {
  const issued = await issueReferralCode(db, actor, { customerId: actor.id }, now);
  return { code: issued.code, replayed: issued.replayed };
}
