/**
 * Delivery fees and the delivery geography (ARCHITECTURE §7.7, brief §4).
 *
 *   const fee = await getShippingFee(db, "gov_basra");          // 5,000 — the flat fee
 *   const governorates = await listGovernorates(db, "ar");      // checkout <select>
 *   const districts = await listDistricts(db, "ar", "gov_basra");
 *
 * The rule: delivery costs the flat fee in settings (`shipping.flat_fee_iqd`, 5,000 IQD) to EVERY
 * active governorate. Rows in `shipping_rates` with `is_override = 1` change that only while an
 * admin has switched on `shipping.overrides_enabled`; with the switch off they are ignored, whatever
 * they say. Rows with `is_override = 0` are informational and never change the fee.
 *
 * With overrides on, the fee of a governorate is (first match wins):
 *   1. the newest active override row for that governorate (whole governorate: district_id IS NULL),
 *   2. the newest active override row for all governorates (governorate_id IS NULL, district_id IS NULL),
 *   3. the flat fee.
 * District-level override rows are not applied: the checkout contract prices by governorate only.
 *
 * A governorate that does not exist or is inactive (delivery paused) gets
 * AppError("shipping_unavailable", 409, { fields: { governorateId } }) — never a guessed fee.
 * No delivery-time promise is made here: estimated days are optional, admin-entered columns.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { districts, governorates, shippingRates } from "~/server/db/schema";
import { AppError } from "~/server/errors";
import { getSettings } from "~/server/settings.server";

/** Error keys this module produces (translated through `errors.<key>` by whoever owns those strings). */
export const SHIPPING_ERROR_KEYS = ["shipping_unavailable"] as const;

export type GovernorateOption = { id: string; slug: string; name: string };
export type DistrictOption = { id: string; name: string };

function unavailable(governorateId: string): AppError {
  return new AppError("shipping_unavailable", 409, { fields: { governorateId: "shipping_unavailable" }, detail: governorateId });
}

/** The flat fee and whether overrides apply, from settings. */
export async function getShippingPolicy(db: Db): Promise<{ flatFeeIqd: number; overridesEnabled: boolean }> {
  const values = await getSettings(db, ["shipping.flat_fee_iqd", "shipping.overrides_enabled"]);
  return { flatFeeIqd: values["shipping.flat_fee_iqd"], overridesEnabled: values["shipping.overrides_enabled"] };
}

/**
 * Delivery fee in IQD for an order to `governorateId`. Throws AppError("shipping_unavailable", 409)
 * when the governorate is unknown or not active.
 */
export async function getShippingFee(db: Db, governorateId: string): Promise<number> {
  if (typeof governorateId !== "string" || governorateId.length === 0 || governorateId.length > 100) throw unavailable(String(governorateId));
  const [governorate, policy] = await Promise.all([
    db.select({ id: governorates.id, isActive: governorates.isActive }).from(governorates).where(eq(governorates.id, governorateId)).get(),
    getShippingPolicy(db),
  ]);
  if (!governorate || !governorate.isActive) throw unavailable(governorateId);
  if (!policy.overridesEnabled) return policy.flatFeeIqd;

  const forGovernorate = await db
    .select({ feeIqd: shippingRates.feeIqd })
    .from(shippingRates)
    .where(and(eq(shippingRates.governorateId, governorateId), isNull(shippingRates.districtId), eq(shippingRates.isOverride, true), eq(shippingRates.isActive, true)))
    .orderBy(desc(shippingRates.updatedAt), desc(shippingRates.id))
    .limit(1)
    .get();
  if (forGovernorate) return forGovernorate.feeIqd;

  const forAll = await db
    .select({ feeIqd: shippingRates.feeIqd })
    .from(shippingRates)
    .where(and(isNull(shippingRates.governorateId), isNull(shippingRates.districtId), eq(shippingRates.isOverride, true), eq(shippingRates.isActive, true)))
    .orderBy(desc(shippingRates.updatedAt), desc(shippingRates.id))
    .limit(1)
    .get();
  return forAll ? forAll.feeIqd : policy.flatFeeIqd;
}

/** Governorates delivery is offered to, in display order, named in `locale`. */
export async function listGovernorates(db: Db, locale: Locale): Promise<GovernorateOption[]> {
  const rows = await db
    .select({ id: governorates.id, slug: governorates.slug, name: governorates.name })
    .from(governorates)
    .where(eq(governorates.isActive, true))
    .orderBy(asc(governorates.sort), asc(governorates.slug));
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: pick(row.name, locale) }));
}

/**
 * Active districts of an active governorate, in display order. An unknown or inactive governorate
 * has none (the checkout then shows the governorate as unavailable through getShippingFee).
 */
export async function listDistricts(db: Db, locale: Locale, governorateId: string): Promise<DistrictOption[]> {
  if (typeof governorateId !== "string" || governorateId.length === 0 || governorateId.length > 100) return [];
  const rows = await db
    .select({ id: districts.id, name: districts.name })
    .from(districts)
    .innerJoin(governorates, eq(governorates.id, districts.governorateId))
    .where(and(eq(districts.governorateId, governorateId), eq(districts.isActive, true), eq(governorates.isActive, true)))
    .orderBy(asc(districts.sort), asc(districts.id));
  return rows.map((row) => ({ id: row.id, name: pick(row.name, locale) }));
}
