/**
 * 11.02 — carriers (delivery companies and the store's own drivers), what each charges per governorate and service
 * level, and choosing a carrier for a parcel by zone, cost and service level.
 *
 *   await saveCarrier(db, actor, { code: "WASEET", name: "…", kind: "third_party", codSupported: true, codFeeBps: 100 }, now)
 *   await saveCarrierRate(db, actor, { carrierId, governorateId, serviceLevel: "standard", costIqd: 4000, etaDaysMin: 1, etaDaysMax: 2 }, now)
 *   await applyCarrierRate(db, actor, { carrierId, governorateIds, serviceLevel, costIqd, … }, now)   one rate, many governorates
 *   const options = await carrierOptions(db, { governorateId, codAmountIqd })                         ranked, cheapest first
 *
 * NO COURIER API IS CONNECTED. A carrier here is a record: who they are, how to reach them, their public tracking page
 * (a URL with {tracking_no}, shown to the shopper), whether they collect cash and what they keep from it, and their
 * rates. Booking a pickup happens by phone or on the carrier's own portal; the admin records what was agreed. A
 * carrier's rate is what the CARRIER charges the store — never the shopper's fee (11.01). Carrier rates are operating
 * data the people who choose carriers need (shipping.shipment.create / shipping.carrier.manage); the delivery margin
 * per parcel (fee charged − carrier cost) is profit data and appears only with profit.read.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { formatIraqPhone, normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { carrierZones, carriers, governorates, orders, payments, shipments, CARRIER_KINDS, type Carrier } from "~/server/db/schema";
import { isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { ETA_MAX_DAYS, IN_FLIGHT, SERVICE_LEVELS, codFeeFor, type CarrierOption, type ServiceLevel } from "./rules";
import { canSeeCarrierCost, ID_PATTERN } from "./shared.server";

const idSchema = z.string().regex(ID_PATTERN, "invalid");

function assertCanRead(actor: Actor) {
  if (!can(actor, "shipping.carrier.manage") && !can(actor, "shipping.shipment.read")) throw forbidden("shipping.carrier.manage");
}

const optionalLine = (max: number) =>
  z
    .string()
    .overwrite(cleanLine)
    .trim()
    .max(max, "too_long")
    .optional()
    .transform((value) => value || null);

/** "https://…{tracking_no}…" — https only, the placeholder required. */
const trackingTemplate = z
  .string()
  .trim()
  .max(300, "too_long")
  .optional()
  .transform((value) => value || null)
  .refine((value) => {
    if (value === null) return true;
    if (!value.includes("{tracking_no}")) return false;
    try {
      return new URL(value.replace("{tracking_no}", "X1")).protocol === "https:";
    } catch {
      return false;
    }
  }, "tracking_template_invalid");

export const CarrierInput = z.object({
  /** Present: the carrier to change. */
  carrierId: idSchema.optional(),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,19}$/, "code_invalid"),
  name: z.string().overwrite(cleanLine).trim().min(2, "required").max(80, "too_long"),
  kind: z.enum(CARRIER_KINDS),
  contactName: optionalLine(80),
  phone: z
    .string()
    .trim()
    .max(30, "too_long")
    .optional()
    .transform((value, ctx) => {
      if (!value) return null;
      const e164 = normalizeIraqPhone(value);
      if (!e164) {
        ctx.addIssue({ code: "custom", message: "phone_invalid" });
        return z.NEVER;
      }
      return e164;
    }),
  trackingUrlTemplate: trackingTemplate,
  codSupported: z.boolean(),
  codFeeIqd: z.number().int("invalid").min(0, "too_small").max(1_000_000, "too_big").nullable().optional(),
  /** Basis points of the collected cash (100 = 1 %), at most 50 %. */
  codFeeBps: z.number().int("invalid").min(0, "too_small").max(5_000, "too_big").nullable().optional(),
  notes: z
    .string()
    .overwrite(cleanBlock)
    .trim()
    .max(1000, "too_long")
    .optional()
    .transform((value) => value || null),
});
export type CarrierInput = z.input<typeof CarrierInput>;

export type CarrierRow = {
  id: string;
  code: string;
  name: string;
  kind: Carrier["kind"];
  phone: string | null;
  contactName: string | null;
  isActive: boolean;
  isDemo: boolean;
  codSupported: boolean;
  /** What the carrier keeps from the cash it collects — carrier cost: only for canSeeCarrierCost, absent otherwise. */
  codFeeIqd?: number | null;
  codFeeBps?: number | null;
  trackingUrlTemplate: string | null;
  notes: string | null;
  zones: number;
  onRoad: number;
  /** Cash the carrier's couriers collected on delivered parcels not settled yet (pending cash-on-delivery payments). */
  codOutstandingIqd: number;
};

/** Every carrier with its numbers: governorates priced, parcels on the road, cash not settled yet. */
export async function listCarriers(db: Db, actor: Actor): Promise<CarrierRow[]> {
  assertCanRead(actor);
  const [rows, zoneCounts, roadCounts, outstanding] = await Promise.all([
    db.select().from(carriers).orderBy(sql`${carriers.isActive} DESC`, asc(carriers.name)),
    db
      .select({ carrierId: carrierZones.carrierId, n: sql<number>`count(DISTINCT ${carrierZones.governorateId})` })
      .from(carrierZones)
      .where(eq(carrierZones.isActive, true))
      .groupBy(carrierZones.carrierId),
    db
      .select({ carrierId: shipments.carrierId, n: sql<number>`count(*)` })
      .from(shipments)
      .where(and(isNotNull(shipments.carrierId), inArray(shipments.status, [...IN_FLIGHT])))
      .groupBy(shipments.carrierId),
    codOutstandingByCarrier(db),
  ]);
  const costVisible = canSeeCarrierCost(actor);
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    phone: row.phone ? formatIraqPhone(row.phone) : null,
    contactName: row.contactName,
    isActive: row.isActive,
    isDemo: row.isDemo,
    codSupported: row.codSupported,
    ...(costVisible ? { codFeeIqd: row.codFeeIqd, codFeeBps: row.codFeeBps } : {}),
    trackingUrlTemplate: row.trackingUrlTemplate,
    notes: row.notes,
    zones: Number(zoneCounts.find((entry) => entry.carrierId === row.id)?.n ?? 0),
    onRoad: Number(roadCounts.find((entry) => entry.carrierId === row.id)?.n ?? 0),
    codOutstandingIqd: outstanding.get(row.id) ?? 0,
  }));
}

/**
 * Per carrier: the cash of delivered parcels whose cash-on-delivery payment is still pending and that no settlement
 * holds yet (the carrier still has it). The parcel that carries an order's cash is its first live parcel.
 */
export async function codOutstandingByCarrier(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ carrierId: shipments.carrierId, amountIqd: sql<number>`sum(${payments.amountIqd})` })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .innerJoin(payments, and(eq(payments.orderId, orders.id), eq(payments.method, "cod"), eq(payments.status, "pending")))
    .where(
      and(
        isNotNull(shipments.carrierId),
        eq(shipments.status, "delivered"),
        isNull(shipments.codSettledAt),
        sql`NOT EXISTS (SELECT 1 FROM cod_settlement_items i WHERE i.shipment_id = ${shipments.id})`,
        sql`${shipments.id} = (SELECT s2.id FROM shipments s2 WHERE s2.order_id = ${shipments.orderId} AND s2.status <> 'cancelled' ORDER BY s2.created_at, s2.id LIMIT 1)`,
      ),
    )
    .groupBy(shipments.carrierId);
  return new Map(rows.filter((row) => row.carrierId).map((row) => [row.carrierId as string, Number(row.amountIqd ?? 0)]));
}

export type CarrierDetail = {
  carrier: CarrierRow;
  /** One row per governorate: the rate of each service level (null = not served); `costIqd` only for canSeeCarrierCost. */
  rates: { governorateId: string; governorate: string; isActive: boolean; levels: Record<ServiceLevel, { costIqd?: number; etaDaysMin: number | null; etaDaysMax: number | null; isActive: boolean } | null> }[];
  can: { manage: boolean; cost: boolean };
};

export async function getCarrier(db: Db, actor: Actor, carrierId: string, locale: Locale): Promise<CarrierDetail> {
  assertCanRead(actor);
  const rows = await listCarriers(db, actor);
  const carrier = rows.find((row) => row.id === carrierId);
  if (!carrier) throw notFound("carrier");
  const [govs, rates] = await Promise.all([
    db.select({ id: governorates.id, name: governorates.name, isActive: governorates.isActive }).from(governorates).orderBy(asc(governorates.sort)),
    db.select().from(carrierZones).where(eq(carrierZones.carrierId, carrier.id)),
  ]);
  const costVisible = canSeeCarrierCost(actor);
  return {
    carrier,
    rates: govs.map((gov) => {
      const levels = Object.fromEntries(
        SERVICE_LEVELS.map((level) => {
          const rate = rates.find((row) => row.governorateId === gov.id && row.serviceLevel === level);
          return [level, rate ? { ...(costVisible ? { costIqd: rate.costIqd } : {}), etaDaysMin: rate.etaDaysMin, etaDaysMax: rate.etaDaysMax, isActive: rate.isActive } : null];
        }),
      ) as CarrierDetail["rates"][number]["levels"];
      return { governorateId: gov.id, governorate: pick(gov.name, locale), isActive: gov.isActive, levels };
    }),
    can: { manage: can(actor, "shipping.carrier.manage"), cost: costVisible },
  };
}

/** Creates a carrier or changes one (code unique; audited with before and after). `demo` marks a demo record. */
export async function saveCarrier(db: Db, actor: Actor, raw: CarrierInput, now: number, options: { demo?: boolean } = {}): Promise<{ carrierId: string; created: boolean }> {
  assertCan(actor, "shipping.carrier.manage");
  const input = CarrierInput.parse(raw);
  const values = {
    code: input.code,
    name: input.name,
    kind: input.kind,
    contactName: input.contactName,
    phone: input.phone,
    trackingUrlTemplate: input.trackingUrlTemplate,
    codSupported: input.codSupported,
    codFeeIqd: input.codSupported ? (input.codFeeIqd ?? null) : null,
    codFeeBps: input.codSupported ? (input.codFeeBps ?? null) : null,
    notes: input.notes,
  };
  try {
    if (input.carrierId) {
      const current = await db.select().from(carriers).where(eq(carriers.id, input.carrierId)).get();
      if (!current) throw notFound("carrier");
      await runBatch(db, [
        db.update(carriers).set(values).where(eq(carriers.id, current.id)),
        auditStatement(db, { actor, action: "shipping.carrier.update", entityType: "carrier", entityId: current.id, before: pickCarrier(current), after: values, at: now }),
      ]);
      return { carrierId: current.id, created: false };
    }
    const id = newId("car");
    await runBatch(db, [
      db.insert(carriers).values({ id, ...values, isActive: true, isDemo: options.demo ?? false, createdAt: now }),
      auditStatement(db, { actor, action: "shipping.carrier.create", entityType: "carrier", entityId: id, after: values, at: now }),
    ]);
    return { carrierId: id, created: true };
  } catch (error) {
    if (isUniqueViolation(error, "carriers.code")) throw invalid({ code: "code_taken" });
    throw error;
  }
}

function pickCarrier(row: Carrier) {
  return {
    code: row.code,
    name: row.name,
    kind: row.kind,
    contactName: row.contactName,
    phone: row.phone,
    trackingUrlTemplate: row.trackingUrlTemplate,
    codSupported: row.codSupported,
    codFeeIqd: row.codFeeIqd,
    codFeeBps: row.codFeeBps,
    notes: row.notes,
  };
}

export const CarrierActiveInput = z.object({ carrierId: idSchema, isActive: z.boolean(), reason: z.string().trim().min(3, "required").max(500, "too_long") });
export type CarrierActiveInput = z.input<typeof CarrierActiveInput>;

/** Stops offering a carrier for new parcels (parcels already with it keep it) or brings it back. */
export async function setCarrierActive(db: Db, actor: Actor, raw: CarrierActiveInput, now: number): Promise<{ onRoad: number; replayed: boolean }> {
  assertCan(actor, "shipping.carrier.manage");
  const input = CarrierActiveInput.parse(raw);
  const current = await db.select().from(carriers).where(eq(carriers.id, input.carrierId)).get();
  if (!current) throw notFound("carrier");
  const road = await db
    .select({ n: sql<number>`count(*)` })
    .from(shipments)
    .where(and(eq(shipments.carrierId, current.id), inArray(shipments.status, [...IN_FLIGHT])))
    .get();
  const onRoad = Number(road?.n ?? 0);
  if (current.isActive === input.isActive) return { onRoad, replayed: true };
  await runBatch(db, [
    db.update(carriers).set({ isActive: input.isActive }).where(eq(carriers.id, current.id)),
    auditStatement(db, { actor, action: "shipping.carrier.availability", entityType: "carrier", entityId: current.id, before: { isActive: current.isActive }, after: { isActive: input.isActive, onRoad }, reason: input.reason, at: now }),
  ]);
  return { onRoad, replayed: false };
}

const etaDay = z.number().int("invalid").min(0, "too_small").max(ETA_MAX_DAYS, "too_big").nullable().optional();

export const CarrierRateInput = z
  .object({
    carrierId: idSchema,
    governorateIds: z.array(idSchema).min(1, "required").max(30),
    serviceLevel: z.enum(SERVICE_LEVELS),
    /** null removes the rate (the row is switched off, its history kept in the audit trail). */
    costIqd: z.number().int("invalid").min(0, "too_small").max(10_000_000, "too_big").nullable(),
    etaDaysMin: etaDay,
    etaDaysMax: etaDay,
  })
  .refine((value) => value.etaDaysMin == null || value.etaDaysMax == null || value.etaDaysMin <= value.etaDaysMax, { message: "eta_order", path: ["etaDaysMax"] });
export type CarrierRateInput = z.input<typeof CarrierRateInput>;

/** What the carrier charges the store for one service level in one or many governorates (upsert per governorate). */
export async function applyCarrierRate(db: Db, actor: Actor, raw: CarrierRateInput, now: number): Promise<{ changed: number }> {
  assertCan(actor, "shipping.carrier.manage");
  const input = CarrierRateInput.parse(raw);
  const carrier = await db.select({ id: carriers.id }).from(carriers).where(eq(carriers.id, input.carrierId)).get();
  if (!carrier) throw notFound("carrier");
  const govIds = [...new Set(input.governorateIds)];
  const known = await db.select({ id: governorates.id }).from(governorates).where(inArray(governorates.id, govIds));
  if (known.length !== govIds.length) throw invalid({ governorateIds: "invalid" });
  const before = await db
    .select()
    .from(carrierZones)
    .where(and(eq(carrierZones.carrierId, carrier.id), eq(carrierZones.serviceLevel, input.serviceLevel), inArray(carrierZones.governorateId, govIds)));
  const statements: BatchStatement[] = [];
  for (const governorateId of govIds) {
    const current = before.find((row) => row.governorateId === governorateId);
    if (input.costIqd === null) {
      if (current && current.isActive) statements.push(db.update(carrierZones).set({ isActive: false }).where(eq(carrierZones.id, current.id)));
      continue;
    }
    const values = { costIqd: input.costIqd, etaDaysMin: input.etaDaysMin ?? null, etaDaysMax: input.etaDaysMax ?? null, isActive: true };
    if (current && current.costIqd === values.costIqd && current.etaDaysMin === values.etaDaysMin && current.etaDaysMax === values.etaDaysMax && current.isActive) continue;
    statements.push(
      db
        .insert(carrierZones)
        .values({ id: newId("czn"), carrierId: carrier.id, governorateId, serviceLevel: input.serviceLevel, ...values })
        .onConflictDoUpdate({ target: [carrierZones.carrierId, carrierZones.governorateId, carrierZones.serviceLevel], set: values }),
    );
  }
  if (statements.length === 0) return { changed: 0 };
  statements.push(
    auditStatement(db, {
      actor,
      action: "shipping.carrier.rate",
      entityType: "carrier",
      entityId: carrier.id,
      summary: `${input.serviceLevel}: ${govIds.length} governorate(s)`,
      before: before.map((row) => ({ governorateId: row.governorateId, costIqd: row.costIqd, etaDaysMin: row.etaDaysMin, etaDaysMax: row.etaDaysMax, isActive: row.isActive })),
      after: { governorateIds: govIds, serviceLevel: input.serviceLevel, costIqd: input.costIqd, etaDaysMin: input.etaDaysMin ?? null, etaDaysMax: input.etaDaysMax ?? null },
      at: now,
    }),
  );
  await runBatch(db, statements);
  return { changed: statements.length - 1 };
}

/**
 * The carriers that serve a governorate, cheapest first (rate + the cash fee on what the parcel collects), then the
 * shortest estimate. A carrier that does not collect cash is listed but not eligible for a parcel that collects cash.
 */
export async function carrierOptions(db: Db, query: { governorateId: string | null; serviceLevel?: ServiceLevel; codAmountIqd: number }): Promise<CarrierOption[]> {
  if (!query.governorateId) return [];
  const rows = await db
    .select({
      carrierId: carriers.id,
      name: carriers.name,
      kind: carriers.kind,
      codSupported: carriers.codSupported,
      codFeeIqd: carriers.codFeeIqd,
      codFeeBps: carriers.codFeeBps,
      serviceLevel: carrierZones.serviceLevel,
      costIqd: carrierZones.costIqd,
      etaDaysMin: carrierZones.etaDaysMin,
      etaDaysMax: carrierZones.etaDaysMax,
    })
    .from(carrierZones)
    .innerJoin(carriers, eq(carriers.id, carrierZones.carrierId))
    .where(
      and(
        eq(carrierZones.governorateId, query.governorateId),
        eq(carrierZones.isActive, true),
        eq(carriers.isActive, true),
        query.serviceLevel ? eq(carrierZones.serviceLevel, query.serviceLevel) : undefined,
      ),
    );
  const options: CarrierOption[] = rows
    .filter((row) => (SERVICE_LEVELS as readonly string[]).includes(row.serviceLevel))
    .map((row) => {
      const collects = query.codAmountIqd > 0;
      const codFeeIqd = collects && row.codSupported ? codFeeFor(query.codAmountIqd, row) : 0;
      return {
        carrierId: row.carrierId,
        name: row.name,
        kind: row.kind,
        serviceLevel: row.serviceLevel as ServiceLevel,
        costIqd: row.costIqd,
        codFeeIqd,
        totalIqd: row.costIqd + codFeeIqd,
        etaDaysMin: row.etaDaysMin,
        etaDaysMax: row.etaDaysMax,
        codSupported: row.codSupported,
        eligible: !collects || row.codSupported,
      };
    });
  return options.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.totalIqd - b.totalIqd || (a.etaDaysMax ?? 99) - (b.etaDaysMax ?? 99) || a.name.localeCompare(b.name));
}

/** The rate a carrier charges for a governorate and level, or null. */
export async function carrierRate(db: Db, carrierId: string, governorateId: string | null, serviceLevel: ServiceLevel): Promise<number | null> {
  if (!governorateId) return null;
  const row = await db
    .select({ costIqd: carrierZones.costIqd })
    .from(carrierZones)
    .where(and(eq(carrierZones.carrierId, carrierId), eq(carrierZones.governorateId, governorateId), eq(carrierZones.serviceLevel, serviceLevel), eq(carrierZones.isActive, true)))
    .get();
  return row?.costIqd ?? null;
}

/** Active carriers for a select (id, name). */
export async function carrierChoices(db: Db): Promise<{ id: string; name: string; codSupported: boolean }[]> {
  return db.select({ id: carriers.id, name: carriers.name, codSupported: carriers.codSupported }).from(carriers).where(eq(carriers.isActive, true)).orderBy(asc(carriers.name));
}

/** Throws when the carrier does not exist or is switched off. */
export async function activeCarrier(db: Db, carrierId: string) {
  const carrier = await db.select().from(carriers).where(eq(carriers.id, carrierId)).get();
  if (!carrier) throw invalid({ carrierId: "invalid" });
  if (!carrier.isActive) throw new AppError("carrier_inactive", 409, { detail: carrierId, fields: { carrierId: "carrier_inactive" } });
  return carrier;
}
