/**
 * The customer's delivery addresses (brief §3.10 "multiple addresses"), read by the checkout to prefill.
 *
 *   const list = await listAddresses(db, customerId, locale);                 // default first
 *   const { id } = await saveAddress(db, actor, form, ctx.now);              // create (no id) or update (id)
 *   await setDefaultAddress(db, actor, id, ctx.now);  await deleteAddress(db, actor, id, ctx.now);
 *   const geography = await listGeography(db, locale);                       // governorates → districts for the form
 *
 * Fields follow the checkout (brief §4): governorate (required, from the shipping service's list), district
 * (optional, must belong to the governorate), area / neighbourhood (required), detailed address (required), plus an
 * optional label, recipient, phone and notes. At most MAX_ADDRESSES per customer. One address is the default: the
 * first one saved becomes it, choosing another moves it, deleting it passes it to the newest remaining one.
 *
 * Ownership is part of every query: another customer's address id is simply "not found".
 * Errors (AppError): invalid (400, fields), not_found (404), address_limit (409), unauthorized (401).
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import type { CustomerActor } from "~/server/actor";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { addresses, districts, governorates } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, unauthorized } from "~/server/errors";
import { getShippingFee, listDistricts, listGovernorates } from "~/server/services/shipping/fees.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import type { AddressView, GeographyOption } from "./types";

export const MAX_ADDRESSES = 10;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);
/** Free text: control, bidi-override and invisible characters are removed first (~/server/text.server). */
const optionalText = (max: number, multiline = false) => z.preprocess(blank, z.string().overwrite(multiline ? cleanBlock : cleanLine).trim().max(max, "too_long").optional());

export const AddressInput = z.object({
  id: z.preprocess(blank, z.string().regex(ID, "invalid").optional()),
  label: optionalText(40),
  recipientName: z.preprocess(blank, z.string().overwrite(cleanLine).trim().min(2, "too_short").max(80, "too_long").optional()),
  // Checked with the other fields, so a form gets every problem at once.
  phone: z.preprocess(
    blank,
    z
      .string()
      .trim()
      .max(40, "phone_invalid")
      .refine((value) => normalizeIraqPhone(value) !== null, "phone_invalid")
      .optional(),
  ),
  governorateId: z.preprocess(blank, z.string({ error: "required" }).regex(ID, "invalid")),
  districtId: z.preprocess(blank, z.string().regex(ID, "invalid").optional()),
  areaText: z.preprocess(blank, z.string({ error: "required" }).overwrite(cleanLine).trim().min(2, "too_short").max(120, "too_long")),
  addressText: z.preprocess(blank, z.string({ error: "required" }).overwrite(cleanBlock).trim().min(5, "too_short").max(300, "too_long")),
  notes: optionalText(300, true),
  makeDefault: z.preprocess((value) => value === true || value === "1" || value === "on" || value === "true", z.boolean()).optional(),
});
export type AddressInput = z.input<typeof AddressInput>;

function requireActor(actor: CustomerActor): string {
  if (actor?.kind !== "customer" || !actor.id) throw unauthorized();
  return actor.id;
}

/**
 * Governorates delivery is offered to, each with its active districts, in display order — from the shipping service
 * (the checkout's own lists), so an address can only name a place the checkout accepts.
 */
export async function listGeography(db: Db, locale: Locale): Promise<GeographyOption[]> {
  const options = await listGovernorates(db, locale);
  const districtLists = await Promise.all(options.map((governorate) => listDistricts(db, locale, governorate.id)));
  return options.map((governorate, index) => ({ id: governorate.id, name: governorate.name, districts: districtLists[index] }));
}

/** The customer's addresses: the default first, then the most recently changed. */
export async function listAddresses(db: Db, customerId: string, locale: Locale): Promise<AddressView[]> {
  const rows = await db
    .select({
      address: addresses,
      governorateName: governorates.name,
      districtName: districts.name,
    })
    .from(addresses)
    .innerJoin(governorates, eq(governorates.id, addresses.governorateId))
    .leftJoin(districts, eq(districts.id, addresses.districtId))
    .where(eq(addresses.customerId, customerId))
    .orderBy(desc(addresses.isDefault), desc(addresses.updatedAt), desc(addresses.id));
  return rows.map(({ address, governorateName, districtName }) => ({
    id: address.id,
    label: address.label,
    recipientName: address.recipientName,
    phoneE164: address.phoneE164,
    governorateId: address.governorateId,
    governorateName: pick(governorateName, locale),
    districtId: address.districtId,
    districtName: districtName ? pick(districtName, locale) : null,
    areaText: address.areaText,
    addressText: address.addressText,
    notes: address.notes,
    isDefault: address.isDefault,
  }));
}

/** The customer's default address, or null. */
export async function getDefaultAddress(db: Db, customerId: string, locale: Locale): Promise<AddressView | null> {
  const list = await listAddresses(db, customerId, locale);
  return list.find((address) => address.isDefault) ?? list[0] ?? null;
}

/** The place must be one the checkout accepts: an active governorate (shipping service) and one of its active districts. */
async function checkPlace(db: Db, governorateId: string, districtId: string | undefined): Promise<void> {
  try {
    await getShippingFee(db, governorateId);
  } catch (error) {
    if (error instanceof AppError && error.code === "shipping_unavailable") throw invalid({ governorateId: "shipping_unavailable" });
    throw error;
  }
  if (districtId && !(await listDistricts(db, "ar", governorateId)).some((district) => district.id === districtId)) throw invalid({ districtId: "district_invalid" });
}

/** Creates an address (no `id`) or updates one of the customer's. Returns its id. */
export async function saveAddress(db: Db, actor: CustomerActor, raw: AddressInput, now: number): Promise<{ id: string; created: boolean }> {
  const customerId = requireActor(actor);
  const input = AddressInput.parse(raw);
  let phoneE164: string | null = null;
  if (input.phone) {
    phoneE164 = normalizeIraqPhone(input.phone);
    if (!phoneE164) throw invalid({ phone: "phone_invalid" });
  }
  await checkPlace(db, input.governorateId, input.districtId);

  const values = {
    label: input.label ?? null,
    recipientName: input.recipientName ?? null,
    phoneE164,
    governorateId: input.governorateId,
    districtId: input.districtId ?? null,
    areaText: input.areaText,
    addressText: input.addressText,
    notes: input.notes ?? null,
    updatedAt: now,
  };
  const mine = eq(addresses.customerId, customerId);
  const count = Number((await db.select({ n: sql<number>`count(*)` }).from(addresses).where(mine).get())?.n ?? 0);

  if (input.id) {
    const existing = await db.select({ id: addresses.id, isDefault: addresses.isDefault }).from(addresses).where(and(eq(addresses.id, input.id), mine)).get();
    if (!existing) throw notFound("address");
    const statements: BatchStatement[] = [];
    if (input.makeDefault && !existing.isDefault) statements.push(db.update(addresses).set({ isDefault: false }).where(and(mine, ne(addresses.id, input.id))));
    statements.push(db.update(addresses).set({ ...values, ...(input.makeDefault ? { isDefault: true } : {}) }).where(and(eq(addresses.id, input.id), mine)));
    await runBatch(db, statements);
    return { id: input.id, created: false };
  }

  if (count >= MAX_ADDRESSES) throw new AppError("address_limit", 409, { detail: String(MAX_ADDRESSES) });
  const id = newId("adr");
  const isDefault = count === 0 || input.makeDefault === true;
  await runBatch(db, [
    ...(isDefault && count > 0 ? [db.update(addresses).set({ isDefault: false }).where(mine)] : []),
    db.insert(addresses).values({ id, customerId, ...values, isDefault, createdAt: now }),
  ]);
  return { id, created: true };
}

/** Makes one of the customer's addresses the default. */
export async function setDefaultAddress(db: Db, actor: CustomerActor, id: string, now: number): Promise<void> {
  const customerId = requireActor(actor);
  const mine = eq(addresses.customerId, customerId);
  const existing = typeof id === "string" && ID.test(id) ? await db.select({ id: addresses.id }).from(addresses).where(and(eq(addresses.id, id), mine)).get() : undefined;
  if (!existing) throw notFound("address");
  await runBatch(db, [db.update(addresses).set({ isDefault: false }).where(and(mine, ne(addresses.id, id))), db.update(addresses).set({ isDefault: true, updatedAt: now }).where(and(eq(addresses.id, id), mine))]);
}

/** Deletes one of the customer's addresses; the default passes to the newest remaining one. */
export async function deleteAddress(db: Db, actor: CustomerActor, id: string, now: number): Promise<void> {
  const customerId = requireActor(actor);
  const mine = eq(addresses.customerId, customerId);
  const existing = typeof id === "string" && ID.test(id) ? await db.select({ id: addresses.id, isDefault: addresses.isDefault }).from(addresses).where(and(eq(addresses.id, id), mine)).get() : undefined;
  if (!existing) throw notFound("address");
  const statements: BatchStatement[] = [db.delete(addresses).where(and(eq(addresses.id, id), mine))];
  if (existing.isDefault) {
    const heir = await db
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(mine, ne(addresses.id, id)))
      .orderBy(desc(addresses.updatedAt), desc(addresses.id))
      .limit(1)
      .get();
    if (heir) statements.push(db.update(addresses).set({ isDefault: true, updatedAt: now }).where(and(eq(addresses.id, heir.id), mine)));
  }
  await runBatch(db, statements);
}
