/**
 * Admin 08 — the module's front page figures, each only for an employee who may open its section (null otherwise).
 * Every number is counted from the tables; nothing is estimated.
 */
import { sql } from "drizzle-orm";
import type { Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { flagCondition } from "~/server/services/admin/customers/flags.server";
import { getSetting } from "~/server/settings.server";
import { countDecidable } from "./approvals.server";
import { PROMOTIONS_PERMISSIONS, assertAny, num, promotionsAccess } from "./shared.server";
import { BAGHDAD_OFFSET_MS, DAY_MS, type PromotionsOverview } from "./types";

const one = async (db: Db, query: ReturnType<typeof sql>) => num((await db.all<{ n: number }>(query))[0]?.n);

export async function promotionsOverview(db: Db, actor: Actor, now: number): Promise<PromotionsOverview> {
  assertAny(actor, PROMOTIONS_PERMISSIONS);
  const access = promotionsAccess(actor);
  // the first day of this month in Baghdad
  const local = new Date(now + BAGHDAD_OFFSET_MS);
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - BAGHDAD_OFFSET_MS;
  const pending = (kind: string) => one(db, sql`SELECT count(*) AS n FROM approvals WHERE kind = ${kind} AND status = 'pending'`);
  const vip = flagCondition("vip", now);
  const windowDays = access.points ? await getSetting(db, "returns.window_days") : 7;
  const [coupons, rules, flash, points, referrals, members, giftCards, experiments, decide] = await Promise.all([
    access.coupons
      ? Promise.all([
          one(db, sql`SELECT count(*) AS n FROM coupons AS c WHERE c.is_active = 1 AND (c.starts_at IS NULL OR c.starts_at <= ${now}) AND (c.ends_at IS NULL OR c.ends_at > ${now}) AND (c.usage_limit IS NULL OR (SELECT count(*) FROM coupon_redemptions AS r WHERE r.coupon_id = c.id AND r.voided_at IS NULL) < c.usage_limit)`),
          pending("coupon"),
          one(db, sql`SELECT count(*) AS n FROM coupon_redemptions WHERE voided_at IS NULL AND at >= ${monthStart}`),
        ]).then(([live, waiting, used]) => ({ live, pending: waiting, usedThisMonth: used }))
      : null,
    access.rules ? Promise.all([one(db, sql`SELECT count(*) AS n FROM promotions WHERE is_active = 1 AND (starts_at IS NULL OR starts_at <= ${now}) AND (ends_at IS NULL OR ends_at > ${now})`), pending("promotion_rule")]).then(([live, waiting]) => ({ live, pending: waiting })) : null,
    access.flash
      ? Promise.all([
          one(db, sql`SELECT count(*) AS n FROM flash_sales WHERE status = 'scheduled' AND starts_at <= ${now} AND ends_at > ${now}`),
          one(db, sql`SELECT count(*) AS n FROM flash_sales WHERE status = 'scheduled' AND starts_at > ${now}`),
          pending("flash_sale"),
        ]).then(([running, scheduled, waiting]) => ({ running, scheduled, pending: waiting }))
      : null,
    access.points
      ? Promise.all([
          one(db, sql`SELECT coalesce(sum(points), 0) AS n FROM loyalty_ledger`),
          one(db, sql`SELECT count(*) AS n FROM orders AS o JOIN customers AS c ON c.id = o.customer_id AND c.status IN ('active', 'blocked') WHERE o.status = 'delivered' AND o.delivered_at IS NOT NULL AND o.delivered_at <= ${now - windowDays * DAY_MS} AND min(o.subtotal_iqd - o.discount_iqd, o.paid_iqd - o.refunded_iqd) >= 1000 AND NOT EXISTS (SELECT 1 FROM loyalty_ledger AS l WHERE l.idempotency_key = 'loyalty:earn:' || o.id)`),
        ]).then(([outstanding, ordersWaiting]) => ({ outstanding, ordersWaiting }))
      : null,
    access.referrals ? one(db, sql`SELECT count(*) AS n FROM referral_redemptions WHERE status IN ('pending', 'qualified')`).then((review) => ({ review })) : null,
    access.vip
      ? Promise.all([
          one(db, sql`SELECT count(*) AS n FROM memberships WHERE status = 'active' AND (ends_at IS NULL OR ends_at > ${now})`),
          vip ? one(db, sql`SELECT count(*) AS n FROM customers AS c WHERE c.status = 'active' AND ${vip} AND NOT EXISTS (SELECT 1 FROM memberships AS m WHERE m.customer_id = c.id AND m.status = 'active' AND (m.ends_at IS NULL OR m.ends_at > ${now}))`) : Promise.resolve(0),
        ]).then(([count, eligible]) => ({ members: count, eligible }))
      : null,
    access.giftCards
      ? Promise.all([
          one(db, sql`SELECT coalesce(sum(amount_iqd), 0) AS n FROM gift_cards WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ${now})`),
          one(db, sql`SELECT count(*) AS n FROM gift_cards WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ${now})`),
          pending("gift_card"),
        ]).then(([outstandingIqd, active, waiting]) => ({ outstandingIqd, active, pending: waiting }))
      : null,
    access.experiments ? one(db, sql`SELECT count(*) AS n FROM experiments WHERE area = 'promotion' AND status = 'running'`).then((running) => ({ running })) : null,
    countDecidable(db, actor),
  ]);
  return { coupons, rules, flash, points, referrals, vip: members, giftCards, experiments, decide: decide ?? 0 };
}
