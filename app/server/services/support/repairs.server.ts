/**
 * Repair requests from the storefront (docs/CONTRACTS.md §3, support row) and their status page.
 *
 *   const repair = await createRepairTicket(db, who, raw, ctx.now, { store, photos });   // → { ticketId, ref: "RP-…", accessToken, replayed }
 *   const view = await getRepairByAccessToken(db, locale, ref, token);                 // the link we give after sending
 *   const view = await lookupRepair(db, locale, { ref, phone }, { ip }, ctx.now);      // reference + phone, rate-limited
 *
 * What a request holds (repair_tickets + its first repair_events row):
 *   · the device: a published device model of ours, or the shopper's own words when it is not in the list;
 *   · an optional serial number, PRIVATE: stored as typed (serial_text), linked to our serial registry (and an active
 *     warranty of that unit) when it matches — never shown back, never on a public page;
 *   · the problem in the shopper's words (10–2,000 characters), up to MAX_SUPPORT_PHOTOS private photos;
 *   · a contact phone (required) and name (optional);
 *   · how they would like to hand the device over (drop it off / be picked up) and a preferred day and time window —
 *     PREFERENCES ONLY: nothing is booked and the page promises no call (Design System v2 §9). Stored in the
 *     "submitted" event's data (repair_tickets has no columns for them). The storefront form offers the period alone
 *     (PreferencePicker rules: no day until the owner configures dispatch days); a day is still accepted.
 *
 * A diagnosis is only ever made by a technician who has the device; a quote must be approved by the shopper before
 * chargeable work starts (repair_tickets.quote_approved_at). The status view shows status changes and the quote —
 * never the serial, internal notes, parts or costs that were not quoted.
 *
 * Status changes made by staff are read from repair_events rows of kind "status" whose data carries the new status as
 * `to` (or `status`); the current status always ends the timeline.
 *
 * Errors (AppError): invalid (fields: device, deviceText, serial, issue, phone, contactName, handover, preferredDay,
 * preferredWindow, photos, idempotencyKey), rate_limited, idempotency_conflict.
 */
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef, timingSafeEqual } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { deviceModels, files, repairEvents, repairTickets, serials, warranties, type NewRepairEvent, type NewRepairTicket, type RepairSource } from "~/server/db/schema";
import { expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { conflict, invalid, zodFieldErrors } from "~/server/errors";
import { enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import type { BlobStore } from "~/server/storage.server";
import { cleanBlock } from "~/server/text.server";
import type { UploadSource } from "~/server/uploads.server";
import {
  REPAIR_REF_PREFIX,
  SUPPORT_LIMITS,
  accessTokenHash,
  actorOf,
  discardPhotos,
  isAccessToken,
  isIdempotencyKey,
  normalizeSupportRef,
  photoSources,
  preparePhotos,
  storePhotos,
  supportAccessToken,
  validPreferredDay,
  type SupportWho,
} from "./common.server";
import { enforceSupportLimits, optionalText, phoneOf } from "./tickets.server";
import { DEVICE_OTHER } from "./state";
import { PREFERRED_WINDOWS, REPAIR_HANDOVERS, REPAIR_STATUS_LIST, type CreatedTicket, type PreferredWindow, type RepairHandover, type RepairStatusKey, type RepairStatusView } from "./types";

const emptyToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);

export const RepairInput = z.object({
  idempotencyKey: z.string().refine(isIdempotencyKey, "invalid"),
  /** A device model slug, or "other" with `deviceText`. */
  device: z.string().trim().min(1, "required").max(64, "invalid"),
  deviceText: optionalText(120),
  serial: optionalText(40),
  issue: z.string().overwrite(cleanBlock).trim().min(10, "too_short").max(2000, "too_long"),
  phone: z.string().trim().min(1, "required").max(40, "phone_invalid"),
  contactName: optionalText(80),
  handover: z.preprocess(emptyToUndefined, z.enum(REPAIR_HANDOVERS, "invalid").optional()),
  preferredDay: z.preprocess(emptyToUndefined, z.string().max(10, "preferred_day_invalid").optional()),
  preferredWindow: z.preprocess(emptyToUndefined, z.enum(PREFERRED_WINDOWS, "invalid").optional()),
  /** Where the request started: the repair page, or the assistant's "book a repair". */
  source: z.preprocess(emptyToUndefined, z.enum(["storefront", "assistant"]).optional()),
});
export type RepairInput = z.input<typeof RepairInput>;

/** A serial as a person types it: letters, digits and dashes; spaces removed; upper case. */
const SERIAL = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
export function normalizeSerial(value: string | undefined): string | null | "invalid" {
  if (!value) return null;
  const text = value.toUpperCase().replace(/\s+/g, "");
  return SERIAL.test(text) ? text : "invalid";
}

type ParsedRepair = Omit<z.output<typeof RepairInput>, "phone" | "serial"> & { phoneE164: string; serial: string | null; deviceModelId: string | null };

/** zod, then the rules that need the catalogue or the clock — every field problem is reported at once. */
async function parseRepair(db: Db, raw: unknown, now: number): Promise<ParsedRepair> {
  const parsed = RepairInput.safeParse(raw ?? {});
  const fields = parsed.success ? {} : zodFieldErrors(parsed.error);
  const value = (name: string): string => {
    const entry = (raw as Record<string, unknown> | null)?.[name];
    return typeof entry === "string" ? entry.trim() : "";
  };
  const phone = phoneOf(value("phone"));
  if (!fields.phone && "error" in phone) fields.phone = phone.error;

  const device = value("device");
  let deviceModelId: string | null = null;
  if (device === DEVICE_OTHER) {
    const text = value("deviceText");
    if (!fields.deviceText && text.length < 2) fields.deviceText = text ? "too_short" : "required";
  } else if (device && !fields.device) {
    const model = await db.select({ id: deviceModels.id }).from(deviceModels).where(and(eq(deviceModels.slug, device), eq(deviceModels.status, "published"))).get();
    if (model) deviceModelId = model.id;
    else fields.device = "invalid";
  }
  const serial = normalizeSerial(value("serial") || undefined);
  if (serial === "invalid" && !fields.serial) fields.serial = "invalid";
  const day = value("preferredDay");
  if (day && !fields.preferredDay && !validPreferredDay(day, now)) fields.preferredDay = "preferred_day_invalid";
  if (!parsed.success || "error" in phone || Object.keys(fields).length > 0) throw invalid(fields);

  const input = parsed.data;
  return { ...input, deviceText: input.device === DEVICE_OTHER ? input.deviceText : undefined, phoneE164: phone.phoneE164, serial: serial === "invalid" ? null : serial, deviceModelId };
}

async function existingRepair(db: Db, tokenHash: string, phoneE164: string, accessToken: string): Promise<CreatedTicket | null> {
  const row = await db.select({ id: repairTickets.id, ref: repairTickets.ref, phone: repairTickets.phoneE164 }).from(repairTickets).where(eq(repairTickets.accessTokenHash, tokenHash)).get();
  if (!row) return null;
  if (row.phone !== phoneE164) throw conflict("idempotency_conflict", "repair key reused with another phone");
  return { ticketId: row.id, ref: row.ref, accessToken, replayed: true };
}

/** Our own unit, when the typed serial is in the registry — and its warranty while it runs. Never shown to the shopper. */
async function registryMatch(db: Db, serial: string | null, now: number): Promise<{ serialId: string | null; warrantyId: string | null }> {
  if (!serial) return { serialId: null, warrantyId: null };
  const unit = await db.select({ id: serials.id }).from(serials).where(eq(serials.serial, serial)).get();
  if (!unit) return { serialId: null, warrantyId: null };
  const warranty = await db
    .select({ id: warranties.id })
    .from(warranties)
    .where(and(eq(warranties.serialId, unit.id), eq(warranties.status, "active"), sql`${warranties.endsAt} >= ${now}`))
    .get();
  return { serialId: unit.id, warrantyId: warranty?.id ?? null };
}

/** Creates a repair request (see the file header). Idempotent on the form's key; rate limited per IP and phone. */
export async function createRepairTicket(db: Db, who: SupportWho, raw: unknown, now: number, options: { store?: BlobStore; photos?: readonly UploadSource[] } = {}): Promise<CreatedTicket> {
  const input = await parseRepair(db, raw, now);
  const sources = photoSources(options.photos ?? []);
  if (sources.length > 0 && !options.store) throw new Error("createRepairTicket: photos need a blob store");

  await enforceSupportLimits(db, "repair_create", who.ip, input.phoneE164, now);

  const accessToken = await supportAccessToken("repair", input.idempotencyKey);
  const tokenHash = await accessTokenHash(accessToken);
  const replay = await existingRepair(db, tokenHash, input.phoneE164, accessToken);
  if (replay) return replay;

  const images = await preparePhotos(sources);
  const id = newId("rep");
  const ref = publicRef(REPAIR_REF_PREFIX);
  const actor = actorOf(who);
  const { serialId, warrantyId } = await registryMatch(db, input.serial, now);
  const photos = images.length > 0 && options.store ? await storePhotos(options.store, images, { kind: "repair_photo", ownerType: "repair_ticket", ownerId: id, createdBy: actor, now }) : [];
  const source: RepairSource = input.source === "assistant" ? "assistant" : "storefront";

  const ticket: NewRepairTicket = {
    id,
    ref,
    customerId: who.customerId,
    phoneE164: input.phoneE164,
    deviceModelId: input.deviceModelId,
    serialId,
    warrantyId,
    issue: input.issue,
    status: "submitted",
    contactName: input.contactName ?? null,
    serialText: input.serial,
    deviceText: input.deviceText ?? null,
    source,
    isWarranty: false,
    accessTokenHash: tokenHash,
    isDemo: who.storeMode === "demo",
    createdAt: now,
    updatedAt: now,
  };
  const submitted: NewRepairEvent = {
    id: newId("rev"),
    ticketId: id,
    kind: "submitted",
    note: null,
    data: { status: "submitted", handover: input.handover ?? null, preferredDay: input.preferredDay ?? null, preferredWindow: input.preferredWindow ?? null, photos: photos.map((photo) => photo.id), source },
    actorKind: actor.kind === "customer" ? "customer" : "guest",
    actorId: who.customerId,
    at: now,
  };

  try {
    await runBatch(db, [
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM repair_tickets WHERE access_token_hash = ${tokenHash})`, "REPAIR_TICKET_EXISTS"),
      ...(photos.length > 0 ? [db.insert(files).values([...photos])] : []),
      db.insert(repairTickets).values(ticket),
      db.insert(repairEvents).values(submitted),
      auditStatement(db, {
        actor,
        action: "support.repair.create",
        entityType: "repair_ticket",
        entityId: id,
        summary: `${ref} · ${source}`,
        after: { ref, source, deviceModelId: input.deviceModelId, deviceText: input.deviceText ?? null, hasSerial: input.serial !== null, linkedToOurUnit: serialId !== null, photos: photos.length, handover: input.handover ?? null, preferredDay: input.preferredDay ?? null, preferredWindow: input.preferredWindow ?? null },
        at: now,
      }),
    ]);
  } catch (error) {
    if (options.store) await discardPhotos(options.store, photos);
    if (isDbError(error, "REPAIR_TICKET_EXISTS")) {
      const existing = await existingRepair(db, tokenHash, input.phoneE164, accessToken);
      if (existing) return existing;
    }
    throw error;
  }
  return { ticketId: id, ref, accessToken, replayed: false };
}

// ───────────────────────────────────────────────────────────────── status

type RepairRow = typeof repairTickets.$inferSelect;

const isStatus = (value: unknown): value is RepairStatusKey => typeof value === "string" && (REPAIR_STATUS_LIST as readonly string[]).includes(value);

async function buildRepairView(db: Db, locale: Locale, row: RepairRow): Promise<RepairStatusView> {
  const [device, events, photoCount] = await Promise.all([
    row.deviceModelId ? db.select({ slug: deviceModels.slug, name: deviceModels.name, artKey: deviceModels.artKey }).from(deviceModels).where(eq(deviceModels.id, row.deviceModelId)).get() : Promise.resolve(undefined),
    db.select({ kind: repairEvents.kind, data: repairEvents.data, at: repairEvents.at }).from(repairEvents).where(eq(repairEvents.ticketId, row.id)).orderBy(asc(repairEvents.at), asc(repairEvents.id)),
    db
      .select({ n: count() })
      .from(files)
      .where(and(eq(files.ownerType, "repair_ticket"), eq(files.ownerId, row.id), isNull(files.deletedAt)))
      .get(),
  ]);

  const first = events.find((event) => event.kind === "submitted")?.data ?? {};
  const timeline: RepairStatusView["timeline"] = [];
  for (const event of events) {
    const to = event.kind === "submitted" ? "submitted" : event.kind === "status" ? (event.data?.to ?? event.data?.status) : null;
    if (isStatus(to) && timeline[timeline.length - 1]?.status !== to) timeline.push({ status: to, at: event.at });
  }
  const current: RepairStatusKey = isStatus(row.status) ? row.status : "submitted";
  if (timeline[timeline.length - 1]?.status !== current) timeline.push({ status: current, at: row.updatedAt });

  const handover = (REPAIR_HANDOVERS as readonly string[]).includes(first.handover as string) ? (first.handover as RepairHandover) : null;
  const window = (PREFERRED_WINDOWS as readonly string[]).includes(first.preferredWindow as string) ? (first.preferredWindow as PreferredWindow) : null;
  return {
    ref: row.ref,
    status: current,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    device: device ? { slug: device.slug, name: pick(device.name, locale), artKey: device.artKey } : null,
    deviceText: row.deviceText,
    issue: row.issue,
    handover,
    preferredDay: typeof first.preferredDay === "string" ? first.preferredDay : null,
    preferredWindow: window,
    photoCount: Number(photoCount?.n ?? 0),
    quoteIqd: row.quoteIqd ?? null,
    quoteApproved: row.quoteApprovedAt !== null,
    costIqd: row.costIqd ?? null,
    isWarranty: row.isWarranty,
    timeline,
    isDemo: row.isDemo,
  };
}

/** The page we send the shopper to after a request: reference + the access token from that request. */
export async function getRepairByAccessToken(db: Db, locale: Locale, ref: unknown, token: unknown): Promise<RepairStatusView | null> {
  const normalized = normalizeSupportRef(ref, REPAIR_REF_PREFIX);
  if (!normalized || !isAccessToken(token)) return null;
  const row = await db.select().from(repairTickets).where(eq(repairTickets.ref, normalized)).get();
  if (!row || !row.accessTokenHash) return null;
  const hash = await accessTokenHash(token);
  if (!timingSafeEqual(row.accessTokenHash, hash)) return null;
  return buildRepairView(db, locale, row);
}

/**
 * Status by reference AND phone. Malformed input is a field error (it reveals nothing); after that a wrong reference
 * and a wrong phone get the same answer (null), and every attempt counts against two limits — per IP and per
 * reference — so neither phones nor references can be enumerated. Over a limit: AppError("rate_limited", 429).
 */
export async function lookupRepair(db: Db, locale: Locale, input: { ref: unknown; phone: unknown }, ctx: { ip: string | null }, now: number): Promise<RepairStatusView | null> {
  const ref = normalizeSupportRef(input?.ref, REPAIR_REF_PREFIX);
  const phoneText = typeof input?.phone === "string" ? input.phone : "";
  const phone = normalizeIraqPhone(phoneText);
  const fields: Record<string, string> = {};
  if (!ref) fields.ref = typeof input?.ref === "string" && input.ref.trim() ? "invalid" : "required";
  if (!phone) fields.phone = phoneText.trim() ? "phone_invalid" : "required";
  if (Object.keys(fields).length > 0) throw invalid(fields);

  await enforceRateLimit(db, await limitKey("repair_lookup", "ip", ctx?.ip), SUPPORT_LIMITS.lookupIp, now);
  await enforceRateLimit(db, await limitKey("repair_lookup", "ref", ref), SUPPORT_LIMITS.lookupRef, now);

  const row = await db.select().from(repairTickets).where(eq(repairTickets.ref, ref as string)).get();
  // Compare even when there is no ticket (same length as a real number), so both kinds of miss cost the same.
  const stored = row?.phoneE164 ?? "+0000000000000";
  if (!timingSafeEqual(stored, phone as string) || !row) return null;
  return buildRepairView(db, locale, row);
}

export { REPAIR_HANDOVERS, PREFERRED_WINDOWS };
