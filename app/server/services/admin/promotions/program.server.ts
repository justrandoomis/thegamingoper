/**
 * Admin 08 — the programme rules in force (module follow-up 2026-11-12): the settings promotions.discount_limits,
 * promotions.loyalty, promotions.referral and promotions.gift_card (app/server/settings.server.ts), whose defaults are
 * the constants DISCOUNT_LIMITS, LOYALTY, REFERRAL and GIFT_CARD (types.ts). All four are money-control limits in the
 * settings module: a change by anyone but the owner (settings.change.approve) waits for a second person.
 *
 *   const program = await programRules(db);   // { limits, loyalty, referral, giftCard } in the constants' shapes
 */
import type { Db } from "~/server/db/drizzle.server";
import { getSettings, type SettingValue } from "~/server/settings.server";
import { GIFT_CARD, LOYALTY, REFERRAL, type DiscountLimits, type GiftCardRules, type LoyaltyRules, type ProgramRules, type ReferralRules } from "./types";

export const PROGRAM_KEYS = ["promotions.discount_limits", "promotions.loyalty", "promotions.referral", "promotions.gift_card"] as const;

export const limitsOf = (value: SettingValue<"promotions.discount_limits">): DiscountLimits => ({ percentBps: value.percent_bps, perOrderIqd: value.per_order_iqd });

export const loyaltyOf = (value: SettingValue<"promotions.loyalty">): LoyaltyRules => ({
  ...LOYALTY,
  pointsPerThousandIqd: value.points_per_thousand_iqd,
  pointValueIqd: value.point_value_iqd,
  expiryDays: value.expiry_days,
  adjustSecondPersonPoints: value.adjust_second_person_points,
  adjustSoloDayPoints: value.adjust_solo_day_points,
});

export const referralOf = (value: SettingValue<"promotions.referral">): ReferralRules => ({ ...REFERRAL, rewardPoints: value.reward_points, defaultMaxUses: value.default_max_uses, deviceWindowDays: value.device_window_days });

export const giftCardOf = (value: SettingValue<"promotions.gift_card">): GiftCardRules => ({
  ...GIFT_CARD,
  minIqd: value.min_iqd,
  maxIqd: value.max_iqd,
  soloIqd: value.solo_iqd,
  soloDayIqd: value.solo_day_iqd,
  maxValidDays: value.max_valid_days,
});

/** The four rule sets in force, in one query. */
export async function programRules(db: Db): Promise<ProgramRules> {
  const values = await getSettings(db, PROGRAM_KEYS);
  return {
    limits: limitsOf(values["promotions.discount_limits"]),
    loyalty: loyaltyOf(values["promotions.loyalty"]),
    referral: referralOf(values["promotions.referral"]),
    giftCard: giftCardOf(values["promotions.gift_card"]),
  };
}
