/**
 * Admin 07.03 — a customer's addresses, contact methods and notification preferences, read and changed by staff.
 *
 *   await getContactView(db, actor, customerId, locale)                          customers.customer.read
 *   await updateCustomerDetails(db, actor, { customerId, name, email, locale, reason, expectedUpdatedAt }, now)
 *   await saveCustomerAddress(db, actor, { customerId, id?, …address, reason, expectedUpdatedAt? }, now)
 *   await deleteCustomerAddress / setCustomerDefaultAddress(db, actor, { customerId, addressId, reason, expectedUpdatedAt? }, now)
 *   await setCustomerChannels(db, actor, { customerId, sms, whatsapp, email, reason, expectedUpdatedAt? }, now)   customers.customer.update
 *
 * Same rules as the customer's own account pages (the account area's AddressInput and geography: an address can only
 * name a governorate and district the checkout accepts; at most MAX_ADDRESSES; one default), plus what staff work
 * needs: a reason, an audit event with before/after (phones masked by the audit trail), and a guard so two people
 * editing the same customer do not overwrite each other (customer_changed): every form sends the `updated_at` it
 * showed — the customer's for the details and the channels, the address's for an address — and a form read before
 * someone else's change is refused (review 2026-11-11: only the details form did; a stale channels or address form
 * overwrote the newer change). The limit of addresses and the single default are decided inside the batch.
 *
 * The account phone is the sign-in identity and is not edited here: moving it needs the customer to confirm a code on
 * the new number, which needs an SMS provider (none is configured). An address phone without
 * customer.phone.read_full is shown masked; leaving it empty keeps the number on file.
 * Channel choices are stored; nothing can be delivered until a provider is connected (`providers` says so).
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { addresses, customers } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { AddressInput, listAddresses, listGeography, MAX_ADDRESSES } from "~/server/services/account/addresses.server";
import { getPreferences } from "~/server/services/account/preferences.server";
import type { GeographyOption } from "~/server/services/account/types";
import { getShippingFee, listDistricts } from "~/server/services/shipping/fees.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { changeableCustomer, customerById, ID, phoneView } from "./shared.server";
import type { PhoneView } from "./types";

export { MAX_ADDRESSES };

export type ContactAddress = {
  id: string;
  label: string | null;
  recipientName: string | null;
  phone: PhoneView | null;
  governorateId: string;
  governorateName: string;
  districtId: string | null;
  districtName: string | null;
  areaText: string | null;
  addressText: string;
  notes: string | null;
  isDefault: boolean;
  /** As the form read it (sent back as expectedUpdatedAt). */
  updatedAt: number;
};

export type ContactView = {
  customerId: string;
  name: string | null;
  email: string | null;
  locale: string;
  phone: PhoneView | null;
  phoneVerifiedAt: number | null;
  updatedAt: number;
  addresses: ContactAddress[];
  geography: GeographyOption[];
  channels: { sms: boolean; whatsapp: boolean; email: boolean };
  /** Channels with a delivery provider (none today). */
  providers: { sms: boolean; whatsapp: boolean; email: boolean };
  canEdit: boolean;
  readOnly: boolean;
};

export async function getContactView(db: Db, actor: Actor, customerId: string, locale: Locale): Promise<ContactView> {
  assertCan(actor, "customers.customer.read");
  const row = await customerById(db, customerId);
  const fullPhone = can(actor, "customer.phone.read_full");
  const [list, geography, prefs, stamps] = await Promise.all([
    listAddresses(db, row.id, locale),
    listGeography(db, locale),
    getPreferences(db, row.id),
    db.select({ id: addresses.id, updatedAt: addresses.updatedAt }).from(addresses).where(eq(addresses.customerId, row.id)),
  ]);
  const stampOf = new Map(stamps.map((stamp) => [stamp.id, stamp.updatedAt]));
  return {
    customerId: row.id,
    name: row.name,
    email: row.email,
    locale: row.locale,
    phone: phoneView(row.phoneE164, fullPhone),
    phoneVerifiedAt: row.phoneVerifiedAt ?? null,
    updatedAt: row.updatedAt,
    addresses: list.map(({ phoneE164, ...address }) => ({ ...address, phone: phoneView(phoneE164, fullPhone), updatedAt: stampOf.get(address.id) ?? 0 })),
    geography,
    channels: prefs.channels,
    providers: prefs.providers,
    canEdit: can(actor, "customers.customer.update") && row.status !== "merged" && row.status !== "deleted",
    readOnly: row.status === "merged" || row.status === "deleted",
  };
}

const reason = z.preprocess((value) => (value === null ? undefined : value), z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "required").max(500, "too_long"));
const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);
/** The `updated_at` the form showed (the pages always send it; a caller that reads and writes at once may leave it out). */
const expectedStamp = z.preprocess(blank, z.coerce.number({ error: "invalid" }).int("invalid").nonnegative("invalid").optional());
const stale = () => new AppError("customer_changed", 409);

export const UpdateDetailsInput = z.object({
  customerId: z.string().regex(ID, "invalid"),
  name: z.preprocess(blank, z.string().overwrite(cleanLine).trim().min(2, "too_short").max(80, "too_long").optional()),
  email: z.preprocess(blank, z.string().trim().toLowerCase().max(200, "too_long").email("email_invalid").optional()),
  locale: z.enum(["ar", "en", "ckb"], { error: "invalid" }),
  reason,
  /** `updated_at` of the customer as the form showed it. */
  expectedUpdatedAt: z.coerce.number().int().nonnegative(),
});
export type UpdateDetailsInput = z.input<typeof UpdateDetailsInput>;

function changed(error: unknown): never {
  if (mapDbError(error)?.code === "CUSTOMER_CHANGED") throw new AppError("customer_changed", 409);
  throw error;
}

/** Name, e-mail and language of messages. Refused when someone else changed the customer since the form was read. */
export async function updateCustomerDetails(db: Db, actor: Actor, raw: UpdateDetailsInput, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "customers.customer.update");
  const input = UpdateDetailsInput.parse(raw);
  const row = await changeableCustomer(db, input.customerId);
  if (row.updatedAt !== input.expectedUpdatedAt) throw new AppError("customer_changed", 409);
  const next = { name: input.name ?? null, email: input.email ?? null, locale: input.locale };
  const before = { name: row.name, email: row.email, locale: row.locale };
  if (before.name === next.name && before.email === next.email && before.locale === next.locale) return { changed: false };
  await runBatch(db, [
    db
      .update(customers)
      .set({ ...next, updatedAt: Math.max(now, row.updatedAt + 1) })
      .where(and(eq(customers.id, row.id), eq(customers.updatedAt, row.updatedAt), sql`${customers.status} IN ('active', 'blocked')`)),
    expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "customers.customer.update", entityType: "customer", entityId: row.id, before, after: next, reason: input.reason, at: now }),
  ]).catch(changed);
  return { changed: true };
}

export const StaffAddressInput = AddressInput.extend({ customerId: z.string().regex(ID, "invalid"), reason, expectedUpdatedAt: expectedStamp });
export type StaffAddressInput = z.input<typeof StaffAddressInput>;

/** The place must be one the checkout accepts: an active governorate and one of its active districts. */
async function checkPlace(db: Db, governorateId: string, districtId: string | undefined): Promise<void> {
  try {
    await getShippingFee(db, governorateId);
  } catch (error) {
    if (error instanceof AppError && (error.code === "shipping_unavailable" || error.code === "not_found")) throw invalid({ governorateId: "shipping_unavailable" });
    throw error;
  }
  if (districtId && !(await listDistricts(db, "ar", governorateId)).some((district) => district.id === districtId)) throw invalid({ districtId: "district_invalid" });
}

/** Creates (no `id`) or updates one of the customer's addresses, with a reason. An empty phone keeps the number on file. */
export async function saveCustomerAddress(db: Db, actor: Actor, raw: StaffAddressInput, now: number): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "customers.customer.update");
  const input = StaffAddressInput.parse(raw);
  const row = await changeableCustomer(db, input.customerId);
  let phoneE164: string | null | undefined;
  if (input.phone) {
    phoneE164 = normalizeIraqPhone(input.phone);
    if (!phoneE164) throw invalid({ phone: "phone_invalid" });
  }
  await checkPlace(db, input.governorateId, input.districtId);
  const values = {
    label: input.label ?? null,
    recipientName: input.recipientName ?? null,
    governorateId: input.governorateId,
    districtId: input.districtId ?? null,
    areaText: input.areaText,
    addressText: input.addressText,
    notes: input.notes ?? null,
    updatedAt: now,
  };
  const mine = eq(addresses.customerId, row.id);
  const list = await db.select().from(addresses).where(mine);

  if (input.id) {
    const existing = list.find((address) => address.id === input.id);
    if (!existing) throw notFound("address");
    if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) throw stale();
    const statements: BatchStatement[] = [];
    if (input.makeDefault && !existing.isDefault) statements.push(db.update(addresses).set({ isDefault: false }).where(and(mine, ne(addresses.id, existing.id))));
    // a new stamp even within the same millisecond, so the next stale form is told apart
    const next = { ...values, updatedAt: Math.max(now, existing.updatedAt + 1), ...(phoneE164 !== undefined ? { phoneE164 } : {}), ...(input.makeDefault ? { isDefault: true } : {}) };
    statements.push(db.update(addresses).set(next).where(and(eq(addresses.id, existing.id), mine, eq(addresses.updatedAt, existing.updatedAt))));
    statements.push(expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: existing.id }));
    statements.push(
      auditStatement(db, {
        actor,
        action: "customers.address.update",
        entityType: "customer",
        entityId: row.id,
        before: addressSnapshot(existing),
        after: { ...addressSnapshot({ ...existing, ...next }), addressId: existing.id },
        reason: input.reason,
        at: now,
      }),
    );
    await runBatch(db, statements).catch(changed);
    return { id: existing.id, created: false };
  }

  if (list.length >= MAX_ADDRESSES) throw new AppError("address_limit", 409, { detail: String(MAX_ADDRESSES) });
  const id = newId("adr");
  const isDefault = list.length === 0 || input.makeDefault === true;
  // The limit and the single default hold against an address saved meanwhile (the customer, another employee):
  // both are decided inside the batch, not from the list read above (review 2026-11-11).
  await runBatch(db, [
    expectThat(db, sql`(SELECT count(*) FROM addresses WHERE customer_id = ${row.id}) < ${MAX_ADDRESSES}`, { code: "ADDRESS_LIMIT", detail: row.id }),
    ...(isDefault ? [db.update(addresses).set({ isDefault: false }).where(and(mine, eq(addresses.isDefault, true)))] : []),
    db.insert(addresses).values({ id, customerId: row.id, ...values, phoneE164: phoneE164 ?? null, isDefault, createdAt: now }),
    auditStatement(db, { actor, action: "customers.address.create", entityType: "customer", entityId: row.id, after: { ...addressSnapshot({ ...values, phoneE164: phoneE164 ?? null, isDefault }), addressId: id }, reason: input.reason, at: now }),
  ]).catch((error) => {
    if (mapDbError(error)?.code === "ADDRESS_LIMIT") throw new AppError("address_limit", 409, { detail: String(MAX_ADDRESSES) });
    throw error;
  });
  return { id, created: true };
}

function addressSnapshot(address: { label: string | null; recipientName: string | null; phoneE164: string | null; governorateId: string; districtId: string | null; areaText: string | null; addressText: string; notes: string | null; isDefault: boolean }) {
  return {
    label: address.label,
    recipientName: address.recipientName,
    phone: address.phoneE164,
    governorateId: address.governorateId,
    districtId: address.districtId,
    areaText: address.areaText,
    addressText: address.addressText,
    notes: address.notes,
    isDefault: address.isDefault,
  };
}

export const AddressRefInput = z.object({ customerId: z.string().regex(ID, "invalid"), addressId: z.string().regex(ID, "invalid"), reason, expectedUpdatedAt: expectedStamp });
export type AddressRefInput = z.input<typeof AddressRefInput>;

/** Deletes one of the customer's addresses (orders keep their own copy); the default passes to the newest left. */
export async function deleteCustomerAddress(db: Db, actor: Actor, raw: AddressRefInput, now: number): Promise<void> {
  assertCan(actor, "customers.customer.update");
  const input = AddressRefInput.parse(raw);
  const row = await changeableCustomer(db, input.customerId);
  const mine = eq(addresses.customerId, row.id);
  const existing = await db.select().from(addresses).where(and(eq(addresses.id, input.addressId), mine)).get();
  if (!existing) throw notFound("address");
  if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) throw stale();
  const statements: BatchStatement[] = [db.delete(addresses).where(and(eq(addresses.id, existing.id), mine)), expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: existing.id })];
  if (existing.isDefault) {
    const heir = await db
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(mine, ne(addresses.id, existing.id)))
      .orderBy(desc(addresses.updatedAt), desc(addresses.id))
      .limit(1)
      .get();
    if (heir) statements.push(db.update(addresses).set({ isDefault: true, updatedAt: now }).where(and(eq(addresses.id, heir.id), mine)));
  }
  statements.push(auditStatement(db, { actor, action: "customers.address.delete", entityType: "customer", entityId: row.id, before: { ...addressSnapshot(existing), addressId: existing.id }, reason: input.reason, at: now }));
  await runBatch(db, statements).catch(changed);
}

/** Makes one of the customer's addresses the default. */
export async function setCustomerDefaultAddress(db: Db, actor: Actor, raw: AddressRefInput, now: number): Promise<void> {
  assertCan(actor, "customers.customer.update");
  const input = AddressRefInput.parse(raw);
  const row = await changeableCustomer(db, input.customerId);
  const mine = eq(addresses.customerId, row.id);
  const existing = await db.select({ id: addresses.id, isDefault: addresses.isDefault, updatedAt: addresses.updatedAt }).from(addresses).where(and(eq(addresses.id, input.addressId), mine)).get();
  if (!existing) throw notFound("address");
  if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) throw stale();
  if (existing.isDefault) return;
  await runBatch(db, [
    db.update(addresses).set({ isDefault: false }).where(and(mine, ne(addresses.id, existing.id))),
    db.update(addresses).set({ isDefault: true, updatedAt: now }).where(and(eq(addresses.id, existing.id), mine)),
    expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: existing.id }),
    auditStatement(db, { actor, action: "customers.address.default", entityType: "customer", entityId: row.id, after: { addressId: existing.id }, reason: input.reason, at: now }),
  ]).catch(changed);
}

const flag = z.preprocess((value) => value === true || value === "1" || value === "on" || value === "true", z.boolean());
export const ChannelsInput = z.object({ customerId: z.string().regex(ID, "invalid"), sms: flag.optional(), whatsapp: flag.optional(), email: flag.optional(), reason, expectedUpdatedAt: expectedStamp });
export type StaffChannelsInput = z.input<typeof ChannelsInput>;

/** The channels the customer wants messages about their orders on (stored; delivered once a provider exists). */
export async function setCustomerChannels(db: Db, actor: Actor, raw: StaffChannelsInput, now: number): Promise<{ sms: boolean; whatsapp: boolean; email: boolean }> {
  assertCan(actor, "customers.customer.update");
  const input = ChannelsInput.parse(raw);
  const row = await changeableCustomer(db, input.customerId);
  if (input.expectedUpdatedAt !== undefined && row.updatedAt !== input.expectedUpdatedAt) throw stale();
  const before = row.notificationPrefs ?? {};
  const next = { ...before, sms: input.sms === true, whatsapp: input.whatsapp === true, email: input.email === true };
  await runBatch(db, [
    db
      .update(customers)
      .set({ notificationPrefs: next, updatedAt: Math.max(now, row.updatedAt + 1) })
      .where(and(eq(customers.id, row.id), eq(customers.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "customers.customer.channels", entityType: "customer", entityId: row.id, before: { sms: before.sms === true, whatsapp: before.whatsapp === true, email: before.email === true }, after: { sms: next.sms, whatsapp: next.whatsapp, email: next.email }, reason: input.reason, at: now }),
  ]).catch(changed);
  return { sms: next.sms, whatsapp: next.whatsapp, email: next.email };
}
