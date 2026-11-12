/**
 * Admin 07 — the module's rules in force (module follow-up 2026-11-12): the settings `customers.rfm_rules`,
 * `customers.flag_rules` and `customers.privacy_due_days` (app/server/settings.server.ts), whose defaults are the
 * constants RFM_RULES, FLAG_RULES and PRIVACY_DUE_DAYS (types.ts). Changed on /admin/settings/keys/<key>; the fraud-risk
 * thresholds are a money-control limit there (a second person decides a change by anyone but the owner).
 *
 *   const rules = await customerRules(db);   // { rfm, flags, privacyDueDays } in the constants' shapes
 */
import type { Db } from "~/server/db/drizzle.server";
import { getSettings, type SettingValue } from "~/server/settings.server";
import type { FlagRules, RfmRules } from "./types";

export type CustomerRules = { rfm: RfmRules; flags: FlagRules; privacyDueDays: number };

/** The stored RFM bounds as RFM_RULES is shaped. */
export function rfmRulesOf(value: SettingValue<"customers.rfm_rules">): RfmRules {
  return {
    recencyDays: [value.recency_5_days, value.recency_4_days, value.recency_3_days, value.recency_2_days],
    frequency: [value.frequency_2, value.frequency_3, value.frequency_4, value.frequency_5],
    monetaryIqd: [value.monetary_2_iqd, value.monetary_3_iqd, value.monetary_4_iqd, value.monetary_5_iqd],
  };
}

/** The stored flag thresholds as FLAG_RULES is shaped. */
export function flagRulesOf(value: SettingValue<"customers.flag_rules">): FlagRules {
  return {
    vipSpendIqd: value.vip_spend_iqd,
    vipPurchases: value.vip_purchases,
    vipWindowDays: value.vip_window_days,
    riskCancelled: value.risk_cancelled,
    riskCancelledDays: value.risk_cancelled_days,
    riskRejectedProofs: value.risk_rejected_proofs,
    riskRejectedDays: value.risk_rejected_days,
    riskReturned: value.risk_returned,
    riskReturnedDays: value.risk_returned_days,
  };
}

/** The three rules in force, in one query. */
export async function customerRules(db: Db): Promise<CustomerRules> {
  const values = await getSettings(db, ["customers.rfm_rules", "customers.flag_rules", "customers.privacy_due_days"]);
  return { rfm: rfmRulesOf(values["customers.rfm_rules"]), flags: flagRulesOf(values["customers.flag_rules"]), privacyDueDays: values["customers.privacy_due_days"] };
}
