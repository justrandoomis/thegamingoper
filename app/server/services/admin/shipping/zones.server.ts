/**
 * 11.01 — delivery zones (Iraq's governorates and their districts), the delivery fee and delivery estimates.
 *
 *   const zones = await listZones(db, actor, "ar");
 *   await setFlatFee(db, actor, { feeIqd: 6000, expectedFeeIqd: 5000, reason }, now);        settings.shipping.manage
 *   await setOverridesEnabled(db, actor, { enabled: true, expected: false, reason }, now);  settings.shipping.manage
 *   await setOverrideFee(db, actor, { governorateId, feeIqd: 7000, expectedIqd: null, reason }, now);  shipping.rate.manage
 *   await setGovernorateAvailability(db, actor, { governorateId, isActive: false, reason }, now);       shipping.zone.manage
 *   await setGovernorateEta(db, actor, { governorateId, etaDaysMin: 1, etaDaysMax: 3 }, now);           shipping.zone.manage
 *   await saveDistrict / setDistrictActive(…)                                                           shipping.zone.manage
 *
 * THE FEE (ARCHITECTURE §7.7): checkout charges the flat fee of `settings["shipping.flat_fee_iqd"]` (5,000 IQD) to every
 * active governorate. Override rows (`shipping_rates.is_override = 1`) change that only while
 * `shipping.overrides_enabled` is on — the rule lives in shipping/fees.server.ts (getShippingFee) and `effectiveFee`
 * (./rules) mirrors it for the impact previews (tests compare the two). Both settings change through setSetting
 * (settings.server: its permission, a reason, an audit event with before and after in the same batch). Orders already
 * placed keep the fee they were charged; carts show the new fee at their next look. Override rows are never deleted: a
 * new fee deactivates the previous row and adds a new one, so the history stays.
 *
 * ESTIMATES are optional, admin-entered day ranges ("usually 1–3 days"); the store calls the shopper to confirm a
 * delivery day, so an estimate is never a promise. A paused governorate is refused at checkout (shipping_unavailable);
 * orders already placed to it keep going. Districts keep their id when renamed (orders and addresses point at the id).
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { carrierZones, carriers, districts, employees, governorates, orders, settings, shippingRates } from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { setSetting } from "~/server/settings.server";
import { cleanLine } from "~/server/text.server";
import { getShippingPolicy } from "~/server/services/shipping/fees.server";
import { ETA_MAX_DAYS, effectiveFee, feeChanges, type FeeChange, type FeePolicy, type ServiceLevel } from "./rules";
import { canSeeCarrierCost, ID_PATTERN } from "./shared.server";

const idSchema = z.string().regex(ID_PATTERN, "invalid");
const reasonSchema = z.string().trim().min(3, "required").max(500, "too_long");
const OPEN_STATUSES = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped"] as const;

function assertCanRead(actor: Actor) {
  if (!can(actor, "shipping.shipment.read") && !can(actor, "shipping.zone.manage") && !can(actor, "shipping.rate.manage") && !can(actor, "shipping.carrier.manage")) throw forbidden("shipping.shipment.read");
}

export type ZoneRow = {
  id: string;
  slug: string;
  name: string;
  names: L10n;
  isActive: boolean;
  etaDaysMin: number | null;
  etaDaysMax: number | null;
  districts: { active: number; total: number };
  /** The active governorate override (whatever the switch says), null when none. */
  overrideIqd: number | null;
  /** What checkout charges now; null while delivery to it is paused. */
  feeIqd: number | null;
  openOrders: number;
};

export type ZonesOverview = {
  policy: FeePolicy & { updatedAt: number | null; updatedBy: string | null };
  rows: ZoneRow[];
  can: { zones: boolean; rates: boolean; fee: boolean };
};

type OverrideRow = { id: string; governorateId: string | null; feeIqd: number; updatedAt: number };

/** The active override rows for whole governorates and for all, newest first (district rows are not applied). */
async function activeOverrides(db: Db): Promise<OverrideRow[]> {
  return db
    .select({ id: shippingRates.id, governorateId: shippingRates.governorateId, feeIqd: shippingRates.feeIqd, updatedAt: shippingRates.updatedAt })
    .from(shippingRates)
    .where(and(eq(shippingRates.isOverride, true), eq(shippingRates.isActive, true), isNull(shippingRates.districtId)))
    .orderBy(desc(shippingRates.updatedAt), desc(shippingRates.id));
}

/** The fee policy as checkout applies it, with the newest all-governorates override. */
export async function feePolicy(db: Db): Promise<FeePolicy & { overrides: Map<string, number> }> {
  const [policy, rows] = await Promise.all([getShippingPolicy(db), activeOverrides(db)]);
  const overrides = new Map<string, number>();
  let allOverrideIqd: number | null = null;
  for (const row of rows) {
    if (row.governorateId === null) {
      if (allOverrideIqd === null) allOverrideIqd = row.feeIqd;
    } else if (!overrides.has(row.governorateId)) overrides.set(row.governorateId, row.feeIqd);
  }
  return { flatFeeIqd: policy.flatFeeIqd, overridesEnabled: policy.overridesEnabled, allOverrideIqd, overrides };
}

/** 11.01 — every governorate with its availability, fee in effect, estimate and districts. */
export async function listZones(db: Db, actor: Actor, locale: Locale): Promise<ZonesOverview> {
  assertCanRead(actor);
  const [policy, govs, districtCounts, openCounts, flatRow] = await Promise.all([
    feePolicy(db),
    db.select().from(governorates).orderBy(asc(governorates.sort), asc(governorates.slug)),
    db
      .select({ governorateId: districts.governorateId, total: sql<number>`count(*)`, active: sql<number>`sum(CASE WHEN ${districts.isActive} = 1 THEN 1 ELSE 0 END)` })
      .from(districts)
      .groupBy(districts.governorateId),
    db
      .select({ governorateId: orders.governorateId, n: sql<number>`count(*)` })
      .from(orders)
      .where(inArray(orders.status, [...OPEN_STATUSES]))
      .groupBy(orders.governorateId),
    db.select({ updatedAt: settings.updatedAt, updatedBy: settings.updatedBy }).from(settings).where(eq(settings.key, "shipping.flat_fee_iqd")).get(),
  ]);
  const updatedBy = flatRow?.updatedBy ? await db.select({ name: employees.name }).from(employees).where(eq(employees.id, flatRow.updatedBy)).get() : undefined;
  return {
    policy: { flatFeeIqd: policy.flatFeeIqd, overridesEnabled: policy.overridesEnabled, allOverrideIqd: policy.allOverrideIqd, updatedAt: flatRow?.updatedAt ?? null, updatedBy: updatedBy?.name ?? null },
    rows: govs.map((gov) => {
      const counts = districtCounts.find((row) => row.governorateId === gov.id);
      const overrideIqd = policy.overrides.get(gov.id) ?? null;
      return {
        id: gov.id,
        slug: gov.slug,
        name: pick(gov.name, locale),
        names: gov.name,
        isActive: gov.isActive,
        etaDaysMin: gov.etaDaysMin,
        etaDaysMax: gov.etaDaysMax,
        districts: { active: Number(counts?.active ?? 0), total: Number(counts?.total ?? 0) },
        overrideIqd,
        feeIqd: gov.isActive ? effectiveFee(policy, overrideIqd) : null,
        openOrders: Number(openCounts.find((row) => row.governorateId === gov.id)?.n ?? 0),
      };
    }),
    can: { zones: can(actor, "shipping.zone.manage"), rates: can(actor, "shipping.rate.manage"), fee: can(actor, "settings.shipping.manage") },
  };
}

export type ZoneDetail = {
  zone: ZoneRow;
  policy: FeePolicy;
  districts: { id: string; name: string; names: L10n; isActive: boolean; sort: number; openOrders: number; seeded: boolean }[];
  overrideHistory: { id: string; feeIqd: number; isActive: boolean; note: string | null; updatedAt: number; updatedBy: string | null }[];
  /** The carriers serving the governorate; `costIqd` (what the carrier charges the store) only for canSeeCarrierCost. */
  carrierRates: { carrierId: string; carrier: string; isActive: boolean; serviceLevel: ServiceLevel; costIqd?: number; etaDaysMin: number | null; etaDaysMax: number | null; rateActive: boolean }[];
  can: { zones: boolean; rates: boolean; fee: boolean; cost: boolean };
};

/** One governorate: districts, its override history, the carriers' rates there. */
export async function getZone(db: Db, actor: Actor, governorateId: string, locale: Locale): Promise<ZoneDetail> {
  assertCanRead(actor);
  const overview = await listZones(db, actor, locale);
  const zone = overview.rows.find((row) => row.id === governorateId);
  if (!zone) throw notFound("governorate");
  const costVisible = canSeeCarrierCost(actor);
  const [districtRows, openByDistrict, history, rates] = await Promise.all([
    db.select().from(districts).where(eq(districts.governorateId, zone.id)).orderBy(asc(districts.sort), asc(districts.id)),
    db
      .select({ districtId: orders.districtId, n: sql<number>`count(*)` })
      .from(orders)
      .where(and(eq(orders.governorateId, zone.id), inArray(orders.status, [...OPEN_STATUSES])))
      .groupBy(orders.districtId),
    db
      .select({ id: shippingRates.id, feeIqd: shippingRates.feeIqd, isActive: shippingRates.isActive, note: shippingRates.note, updatedAt: shippingRates.updatedAt, updatedBy: employees.name })
      .from(shippingRates)
      .leftJoin(employees, eq(employees.id, shippingRates.updatedBy))
      .where(and(eq(shippingRates.governorateId, zone.id), eq(shippingRates.isOverride, true), isNull(shippingRates.districtId)))
      .orderBy(desc(shippingRates.updatedAt), desc(shippingRates.id))
      .limit(20),
    db
      .select({
        carrierId: carriers.id,
        carrier: carriers.name,
        isActive: carriers.isActive,
        serviceLevel: carrierZones.serviceLevel,
        costIqd: carrierZones.costIqd,
        etaDaysMin: carrierZones.etaDaysMin,
        etaDaysMax: carrierZones.etaDaysMax,
        rateActive: carrierZones.isActive,
      })
      .from(carrierZones)
      .innerJoin(carriers, eq(carriers.id, carrierZones.carrierId))
      .where(eq(carrierZones.governorateId, zone.id))
      .orderBy(asc(carrierZones.costIqd), asc(carriers.name)),
  ]);
  return {
    zone,
    policy: overview.policy,
    districts: districtRows.map((row) => ({
      id: row.id,
      name: pick(row.name, locale),
      names: row.name,
      isActive: row.isActive,
      sort: row.sort,
      seeded: row.slug !== null,
      openOrders: Number(openByDistrict.find((entry) => entry.districtId === row.id)?.n ?? 0),
    })),
    overrideHistory: history.map((row) => ({ ...row, updatedBy: row.updatedBy ?? null })),
    // without cost the list is by carrier name (cheapest first would still tell who costs less)
    carrierRates: (costVisible ? rates : [...rates].sort((a, b) => a.carrier.localeCompare(b.carrier) || a.serviceLevel.localeCompare(b.serviceLevel))).map(({ costIqd, ...row }) => ({
      ...row,
      serviceLevel: row.serviceLevel as ServiceLevel,
      ...(costVisible ? { costIqd } : {}),
    })),
    can: { ...overview.can, cost: costVisible },
  };
}

// ───────────────────────────────────────────────────────────────── the fee

export const FlatFeeInput = z.object({
  feeIqd: z.number().int("invalid").min(0, "too_small").max(1_000_000, "too_big"),
  /** The fee the employee saw: when it changed since, nothing is saved (fee_changed). */
  expectedFeeIqd: z.number().int("invalid").min(0).max(1_000_000),
  reason: reasonSchema,
});
export type FlatFeeInput = z.input<typeof FlatFeeInput>;

/** The flat fee checkout charges (through setSetting: permission, reason, audit). Returns the governorates whose fee changed. */
export async function setFlatFee(db: Db, actor: Actor, raw: FlatFeeInput, now: number): Promise<{ changes: FeeChange[]; replayed: boolean }> {
  assertCan(actor, "settings.shipping.manage");
  const input = FlatFeeInput.parse(raw);
  const [before, zones] = await Promise.all([feePolicy(db), zoneFeeRows(db)]);
  if (before.flatFeeIqd === input.feeIqd) return { changes: [], replayed: true };
  if (before.flatFeeIqd !== input.expectedFeeIqd) throw new AppError("fee_changed", 409, { detail: `${before.flatFeeIqd}, expected ${input.expectedFeeIqd}` });
  const changes = feeChanges(withOverrides(zones, before.overrides), before, { ...before, flatFeeIqd: input.feeIqd });
  await setSetting(db, actor, "shipping.flat_fee_iqd", input.feeIqd, input.reason, now);
  return { changes, replayed: false };
}

export const OverridesSwitchInput = z.object({ enabled: z.boolean(), expected: z.boolean(), reason: reasonSchema });
export type OverridesSwitchInput = z.input<typeof OverridesSwitchInput>;

/** Switches the per-governorate fees on or off (through setSetting). Returns the governorates whose fee changed. */
export async function setOverridesEnabled(db: Db, actor: Actor, raw: OverridesSwitchInput, now: number): Promise<{ changes: FeeChange[]; replayed: boolean }> {
  assertCan(actor, "settings.shipping.manage");
  const input = OverridesSwitchInput.parse(raw);
  const [before, zones] = await Promise.all([feePolicy(db), zoneFeeRows(db)]);
  if (before.overridesEnabled === input.enabled) return { changes: [], replayed: true };
  if (before.overridesEnabled !== input.expected) throw new AppError("fee_changed", 409, { detail: "overrides switch" });
  const changes = feeChanges(withOverrides(zones, before.overrides), before, { ...before, overridesEnabled: input.enabled });
  await setSetting(db, actor, "shipping.overrides_enabled", input.enabled, input.reason, now);
  return { changes, replayed: false };
}

async function zoneFeeRows(db: Db): Promise<{ id: string; name: string; isActive: boolean }[]> {
  const rows = await db.select({ id: governorates.id, name: governorates.name, isActive: governorates.isActive }).from(governorates).orderBy(asc(governorates.sort));
  return rows.map((row) => ({ id: row.id, name: pick(row.name, "ar"), isActive: row.isActive }));
}

const withOverrides = (zones: { id: string; name: string; isActive: boolean }[], overrides: Map<string, number>) => zones.map((zone) => ({ ...zone, overrideIqd: overrides.get(zone.id) ?? null }));

export const OverrideFeeInput = z.object({
  /** null = every governorate (applies where a governorate has no override of its own). */
  governorateId: idSchema.nullable(),
  /** null removes the override. */
  feeIqd: z.number().int("invalid").min(0, "too_small").max(1_000_000, "too_big").nullable(),
  /** The override the employee saw (null = none): when it changed since, nothing is saved (fee_changed). */
  expectedIqd: z.number().int().min(0).max(1_000_000).nullable(),
  reason: reasonSchema,
});
export type OverrideFeeInput = z.input<typeof OverrideFeeInput>;

/**
 * Sets (or removes, with feeIqd null) the override of one governorate or of all. The previous row is deactivated and
 * a new one added — never deleted. Applies at checkout only while overrides are switched on; the result says so.
 */
export async function setOverrideFee(db: Db, actor: Actor, raw: OverrideFeeInput, now: number): Promise<{ changes: FeeChange[]; applies: boolean; replayed: boolean }> {
  assertCan(actor, "shipping.rate.manage");
  const input = OverrideFeeInput.parse(raw);
  if (input.governorateId !== null) {
    const gov = await db.select({ id: governorates.id }).from(governorates).where(eq(governorates.id, input.governorateId)).get();
    if (!gov) throw notFound("governorate");
  }
  const [before, zones] = await Promise.all([feePolicy(db), zoneFeeRows(db)]);
  const current = input.governorateId === null ? before.allOverrideIqd : (before.overrides.get(input.governorateId) ?? null);
  if (current === input.feeIqd) return { changes: [], applies: before.overridesEnabled, replayed: true };
  if (current !== input.expectedIqd) throw new AppError("fee_changed", 409, { detail: `override ${current}, expected ${input.expectedIqd}` });
  const rows = withOverrides(zones, before.overrides);
  const changes =
    input.governorateId === null
      ? feeChanges(rows, before, { ...before, allOverrideIqd: input.feeIqd })
      : feeChanges(rows, before, before, { id: input.governorateId, overrideIqd: input.feeIqd });
  const scope = input.governorateId === null ? isNull(shippingRates.governorateId) : eq(shippingRates.governorateId, input.governorateId);
  const scopeSql = input.governorateId === null ? sql`governorate_id IS NULL` : sql`governorate_id = ${input.governorateId}`;
  const updatedBy = actor.kind === "employee" ? actor.id : null;
  const statements: BatchStatement[] = [
    // the override the employee decided on is still the one in force (someone else's change meanwhile: fee_changed)
    expectThat(
      db,
      current === null
        ? sql`NOT EXISTS (SELECT 1 FROM shipping_rates WHERE ${scopeSql} AND district_id IS NULL AND is_override = 1 AND is_active = 1)`
        : sql`(SELECT fee_iqd FROM shipping_rates WHERE ${scopeSql} AND district_id IS NULL AND is_override = 1 AND is_active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1) = ${current}`,
      { code: "FEE_CHANGED", detail: input.governorateId ?? "all" },
    ),
    db
      .update(shippingRates)
      .set({ isActive: false, updatedAt: now, updatedBy })
      .where(and(scope, isNull(shippingRates.districtId), eq(shippingRates.isOverride, true), eq(shippingRates.isActive, true))),
  ];
  if (input.feeIqd !== null) {
    statements.push(db.insert(shippingRates).values({ id: newId("rate"), governorateId: input.governorateId, feeIqd: input.feeIqd, isOverride: true, isActive: true, districtId: null, note: input.reason, updatedBy, updatedAt: now }));
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: "shipping.rate.update",
      entityType: "governorate",
      entityId: input.governorateId ?? "all",
      summary: input.feeIqd === null ? "delivery fee override removed" : "delivery fee override set",
      before: { overrideIqd: current },
      after: { overrideIqd: input.feeIqd, appliesAtCheckout: before.overridesEnabled, changedGovernorates: changes.length },
      reason: input.reason,
      at: now,
    }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "FEE_CHANGED")) throw new AppError("fee_changed", 409, { detail: `override of ${input.governorateId ?? "all"} changed meanwhile`, cause: error });
    throw error;
  }
  return { changes: before.overridesEnabled ? changes : [], applies: before.overridesEnabled, replayed: false };
}

// ───────────────────────────────────────────────────────────────── governorates and districts

export const AvailabilityInput = z.object({ governorateId: idSchema, isActive: z.boolean(), reason: reasonSchema });
export type AvailabilityInput = z.input<typeof AvailabilityInput>;

/** Pauses or resumes delivery to a governorate (checkout refuses a paused one; open orders keep going). */
export async function setGovernorateAvailability(db: Db, actor: Actor, raw: AvailabilityInput, now: number): Promise<{ openOrders: number; replayed: boolean }> {
  assertCan(actor, "shipping.zone.manage");
  const input = AvailabilityInput.parse(raw);
  const gov = await db.select().from(governorates).where(eq(governorates.id, input.governorateId)).get();
  if (!gov) throw notFound("governorate");
  const open = await db
    .select({ n: sql<number>`count(*)` })
    .from(orders)
    .where(and(eq(orders.governorateId, gov.id), inArray(orders.status, [...OPEN_STATUSES])))
    .get();
  const openOrders = Number(open?.n ?? 0);
  if (gov.isActive === input.isActive) return { openOrders, replayed: true };
  try {
    await runBatch(db, [
      db
        .update(governorates)
        .set({ isActive: input.isActive })
        .where(and(eq(governorates.id, gov.id), eq(governorates.isActive, gov.isActive))),
      expectChanged(db, 1, { code: "ZONE_CHANGED", detail: gov.id }),
      auditStatement(db, {
        actor,
        action: "shipping.zone.availability",
        entityType: "governorate",
        entityId: gov.id,
        summary: `${gov.slug}: delivery ${input.isActive ? "resumed" : "paused"}`,
        before: { isActive: gov.isActive },
        after: { isActive: input.isActive, openOrders },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "ZONE_CHANGED")) return { openOrders, replayed: true };
    throw error;
  }
  return { openOrders, replayed: false };
}

const etaDay = z.number().int("invalid").min(0, "too_small").max(ETA_MAX_DAYS, "too_big").nullable();
export const EtaInput = z
  .object({ governorateId: idSchema, etaDaysMin: etaDay, etaDaysMax: etaDay })
  .refine((value) => (value.etaDaysMin === null) === (value.etaDaysMax === null), { message: "eta_both", path: ["etaDaysMax"] })
  .refine((value) => value.etaDaysMin === null || value.etaDaysMax === null || value.etaDaysMin <= value.etaDaysMax, { message: "eta_order", path: ["etaDaysMax"] });
export type EtaInput = z.input<typeof EtaInput>;

/** The estimate shown as "usually N–M days" (an estimate, confirmed by phone; null clears it). */
export async function setGovernorateEta(db: Db, actor: Actor, raw: EtaInput, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "shipping.zone.manage");
  const input = EtaInput.parse(raw);
  const gov = await db.select().from(governorates).where(eq(governorates.id, input.governorateId)).get();
  if (!gov) throw notFound("governorate");
  if (gov.etaDaysMin === input.etaDaysMin && gov.etaDaysMax === input.etaDaysMax) return { changed: false };
  await runBatch(db, [
    db.update(governorates).set({ etaDaysMin: input.etaDaysMin, etaDaysMax: input.etaDaysMax }).where(eq(governorates.id, gov.id)),
    auditStatement(db, {
      actor,
      action: "shipping.zone.eta",
      entityType: "governorate",
      entityId: gov.id,
      before: { etaDaysMin: gov.etaDaysMin, etaDaysMax: gov.etaDaysMax },
      after: { etaDaysMin: input.etaDaysMin, etaDaysMax: input.etaDaysMax },
      at: now,
    }),
  ]);
  return { changed: true };
}

const districtName = (max: number) => z.string().overwrite(cleanLine).trim().max(max, "too_long");
export const DistrictInput = z.object({
  governorateId: idSchema,
  /** Absent: a new district. */
  districtId: idSchema.optional(),
  nameAr: districtName(80).pipe(z.string().min(2, "required")),
  nameEn: districtName(80).optional(),
  nameCkb: districtName(80).optional(),
  sort: z.number().int("invalid").min(0).max(10_000).optional(),
});
export type DistrictInput = z.input<typeof DistrictInput>;

/** Adds a district to a governorate or renames one (its id never changes). */
export async function saveDistrict(db: Db, actor: Actor, raw: DistrictInput, now: number): Promise<{ districtId: string; created: boolean }> {
  assertCan(actor, "shipping.zone.manage");
  const input = DistrictInput.parse(raw);
  const gov = await db.select({ id: governorates.id }).from(governorates).where(eq(governorates.id, input.governorateId)).get();
  if (!gov) throw notFound("governorate");
  const name: L10n = { ar: input.nameAr, ...(input.nameEn ? { en: input.nameEn } : {}), ...(input.nameCkb ? { ckb: input.nameCkb } : {}) };
  const siblings = await db.select({ id: districts.id, name: districts.name, sort: districts.sort }).from(districts).where(eq(districts.governorateId, gov.id));
  const clash = siblings.find((row) => row.id !== input.districtId && pick(row.name, "ar").trim() === name.ar);
  if (clash) throw invalid({ nameAr: "district_exists" });
  if (input.districtId) {
    const current = siblings.find((row) => row.id === input.districtId);
    if (!current) throw notFound("district");
    await runBatch(db, [
      db
        .update(districts)
        .set({ name, ...(input.sort !== undefined ? { sort: input.sort } : {}) })
        .where(eq(districts.id, current.id)),
      auditStatement(db, { actor, action: "shipping.zone.district", entityType: "district", entityId: current.id, before: { name: current.name, sort: current.sort }, after: { name, sort: input.sort ?? current.sort }, at: now }),
    ]);
    return { districtId: current.id, created: false };
  }
  const id = newId("dst");
  const sort = input.sort ?? Math.max(0, ...siblings.map((row) => row.sort)) + 10;
  await runBatch(db, [
    db.insert(districts).values({ id, governorateId: gov.id, name, sort, isActive: true, slug: null }),
    auditStatement(db, { actor, action: "shipping.zone.district", entityType: "district", entityId: id, after: { governorateId: gov.id, name, sort }, at: now }),
  ]);
  return { districtId: id, created: true };
}

export const DistrictActiveInput = z.object({
  /** The governorate page the change comes from: a district of another governorate is not_found there. */
  governorateId: idSchema.optional(),
  districtId: idSchema,
  isActive: z.boolean(),
  reason: reasonSchema,
});
export type DistrictActiveInput = z.input<typeof DistrictActiveInput>;

/** A district offered at checkout or not (orders already placed keep it). */
export async function setDistrictActive(db: Db, actor: Actor, raw: DistrictActiveInput, now: number): Promise<{ openOrders: number; replayed: boolean }> {
  assertCan(actor, "shipping.zone.manage");
  const input = DistrictActiveInput.parse(raw);
  const district = await db.select().from(districts).where(eq(districts.id, input.districtId)).get();
  if (!district || (input.governorateId !== undefined && district.governorateId !== input.governorateId)) throw notFound("district");
  const open = await db
    .select({ n: sql<number>`count(*)` })
    .from(orders)
    .where(and(eq(orders.districtId, district.id), inArray(orders.status, [...OPEN_STATUSES])))
    .get();
  const openOrders = Number(open?.n ?? 0);
  if (district.isActive === input.isActive) return { openOrders, replayed: true };
  await runBatch(db, [
    db.update(districts).set({ isActive: input.isActive }).where(eq(districts.id, district.id)),
    auditStatement(db, {
      actor,
      action: "shipping.zone.district_availability",
      entityType: "district",
      entityId: district.id,
      before: { isActive: district.isActive },
      after: { isActive: input.isActive, openOrders },
      reason: input.reason,
      at: now,
    }),
  ]);
  return { openOrders, replayed: false };
}
