/**
 * Support tickets from the storefront (docs/CONTRACTS.md §3, support row): a shopper asks a person for help.
 *
 *   const ticket = await createSupportTicket(db, who, { idempotencyKey, phone, contactName, subject, message, category }, ctx.now, { store, photos });
 *   // → { ticketId, ref: "SP-7K4M2Q9X", accessToken, replayed }
 *
 * Rules
 *   · A phone number is required (an Iraqi mobile, normalised to E.164): staff answer by phone or WhatsApp. No SMS is
 *     sent — no provider is configured — so the page says "we contact you", never "we sent you a message".
 *   · Idempotent: the form carries a random key; the ticket's access-token hash is derived from it, a guard in the
 *     creating batch refuses a second row, and a retry with the same key returns the first ticket (`replayed: true`).
 *     The same key with another phone number is refused (`idempotency_conflict`).
 *   · Rate limited per IP and per phone (SUPPORT_LIMITS). Photos are private files (JPEG/PNG/WebP, ≤ 8 MB, metadata
 *     removed), at most MAX_SUPPORT_PHOTOS, attached to the first message.
 *   · The SLA clock starts from the active SLA policy for the ticket's priority and category, when one exists.
 *   · One batch: guard, file rows, ticket, messages, audit event. Requests made in demo mode are flagged is_demo.
 *
 * Errors (AppError): invalid (fields: phone, contactName, subject, message, photos, idempotencyKey), rate_limited,
 * idempotency_conflict.
 */
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef, timingSafeEqual } from "~/lib/ids";
import { DEFAULT_LOCALE, isLocale, type Locale } from "~/lib/locales";
import { maskPhone, normalizeIraqPhone } from "~/lib/phone";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { files, slaPolicies, supportTickets, ticketMessages, TICKET_CATEGORIES, type NewSupportTicket, type NewTicketMessage, type TicketCategory, type TicketChannel } from "~/server/db/schema";
import { expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { conflict, invalid, zodFieldErrors } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import type { BlobStore } from "~/server/storage.server";
import type { UploadSource } from "~/server/uploads.server";
import {
  SUPPORT_LIMITS,
  TICKET_REF_PREFIX,
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
  type StoredPhoto,
  type SupportWho,
} from "./common.server";
import type { CreatedTicket } from "./types";

/** Every code the support services throw to a shopper — each has a text in the "errors" namespace. */
export const SUPPORT_ERROR_KEYS = [
  "invalid",
  "required",
  "too_short",
  "too_long",
  "too_big",
  "phone_invalid",
  "preferred_day_invalid",
  "rate_limited",
  "idempotency_conflict",
  "not_found",
  "upload_missing",
  "upload_too_large",
  "upload_type",
  "upload_corrupt",
  "upload_dimensions",
] as const;

/** Free text: control, bidi-override and invisible characters are removed first (~/server/text.server). */
export const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .overwrite(multiline ? cleanBlock : cleanLine)
    .trim()
    .max(max, "too_long")
    .optional()
    .transform((value) => (value ? value : undefined));

export const SupportTicketInput = z.object({
  idempotencyKey: z.string().refine(isIdempotencyKey, "invalid"),
  phone: z.string().trim().min(1, "required").max(40, "phone_invalid"),
  contactName: optionalText(80),
  subject: z.string().overwrite(cleanLine).trim().min(3, "too_short").max(140, "too_long"),
  message: optionalText(4000, true),
  category: z.enum(TICKET_CATEGORIES).default("other"),
  /** The shopper's language: staff answer in it. */
  locale: z.string().optional(),
});
export type SupportTicketInput = z.input<typeof SupportTicketInput>;

/** Validated ticket input, the phone in E.164. */
export type ParsedTicket = Omit<z.output<typeof SupportTicketInput>, "phone" | "locale"> & { phoneE164: string; locale: Locale };

/** E.164 of a typed phone, or the field error key. */
export function phoneOf(raw: unknown): { phoneE164: string } | { error: "required" | "phone_invalid" } {
  const text = typeof raw === "string" ? raw : "";
  const phoneE164 = normalizeIraqPhone(text);
  if (phoneE164) return { phoneE164 };
  return { error: text.trim() ? "phone_invalid" : "required" };
}

/** zod + the phone rule, every field problem at once. */
export function parseTicketInput(raw: unknown): ParsedTicket {
  const parsed = SupportTicketInput.safeParse(raw ?? {});
  const fields = parsed.success ? {} : zodFieldErrors(parsed.error);
  const phone = phoneOf((raw as { phone?: unknown } | null)?.phone);
  if (!fields.phone && "error" in phone) fields.phone = phone.error;
  if (!parsed.success || "error" in phone || Object.keys(fields).length > 0) throw invalid(fields);
  const { phone: _typed, locale, ...rest } = parsed.data;
  return { ...rest, phoneE164: phone.phoneE164, locale: isLocale(locale) ? locale : DEFAULT_LOCALE };
}

/** Both limits: per IP and per phone (every attempt counts, so neither can be used to flood staff). */
export async function enforceSupportLimits(db: Db, scope: string, ip: string | null, phoneE164: string, now: number): Promise<void> {
  await enforceRateLimit(db, await limitKey(scope, "ip", ip), SUPPORT_LIMITS.createIp, now);
  await enforceRateLimit(db, await limitKey(scope, "phone", phoneE164), SUPPORT_LIMITS.createPhone, now);
}

/** The ticket already created with this access-token hash, as a replay (or a conflict when the phone differs). */
export async function existingTicket(db: Db, tokenHash: string, phoneE164: string, accessToken: string): Promise<CreatedTicket | null> {
  const row = await db.select({ id: supportTickets.id, ref: supportTickets.ref, phone: supportTickets.phoneE164 }).from(supportTickets).where(eq(supportTickets.accessTokenHash, tokenHash)).get();
  if (!row) return null;
  if (row.phone !== phoneE164) throw conflict("idempotency_conflict", "support ticket key reused with another phone");
  return { ticketId: row.id, ref: row.ref, accessToken, replayed: true };
}

/** First-response and resolution due times from the most specific active SLA policy (this category, then any). */
async function slaDue(db: Db, priority: NonNullable<NewSupportTicket["priority"]>, category: TicketCategory, now: number): Promise<{ firstResponseDueAt: number | null; resolutionDueAt: number | null }> {
  const policy = await db
    .select({ first: slaPolicies.firstResponseMinutes, resolve: slaPolicies.resolutionMinutes })
    .from(slaPolicies)
    .where(and(eq(slaPolicies.isActive, true), eq(slaPolicies.priority, priority), or(eq(slaPolicies.category, category), isNull(slaPolicies.category))))
    .orderBy(desc(sql`${slaPolicies.category} IS NOT NULL`))
    .get();
  if (!policy) return { firstResponseDueAt: null, resolutionDueAt: null };
  return { firstResponseDueAt: now + policy.first * 60_000, resolutionDueAt: now + policy.resolve * 60_000 };
}

export type TicketExtras = {
  channel: TicketChannel;
  /** Assistant conversation handed to staff (its summary becomes the internal note). */
  assistantSessionId?: string | null;
  /** A note for staff only (never shown to the shopper). */
  internalNote?: string | null;
  tags?: string[];
  photos?: readonly StoredPhoto[];
};

/**
 * The statements that create ticket `ticketId` (ticket, first message with the photos, internal note, audit event) —
 * for callers that create it together with other rows in ONE batch (the assistant handoff). Put the idempotency guard
 * (ticketGuard) and the photos' `files` rows (fileRowStatements) before them.
 */
export async function planSupportTicket(db: Db, who: SupportWho, input: ParsedTicket, ticket: { id: string; ref: string; tokenHash: string }, now: number, extras: TicketExtras): Promise<BatchStatement[]> {
  const priority = "normal" as const;
  const due = await slaDue(db, priority, input.category, now);
  const photoIds = (extras.photos ?? []).map((photo) => photo.id);

  const row: NewSupportTicket = {
    id: ticket.id,
    ref: ticket.ref,
    customerId: who.customerId,
    contactName: input.contactName ?? null,
    phoneE164: input.phoneE164,
    channel: extras.channel,
    subject: input.subject,
    category: input.category,
    priority,
    status: "open",
    assistantSessionId: extras.assistantSessionId ?? null,
    firstResponseDueAt: due.firstResponseDueAt,
    resolutionDueAt: due.resolutionDueAt,
    tags: extras.tags && extras.tags.length > 0 ? extras.tags : null,
    locale: input.locale,
    accessTokenHash: ticket.tokenHash,
    lastMessageAt: now,
    isDemo: who.storeMode === "demo",
    createdAt: now,
    updatedAt: now,
  };
  const messages: NewTicketMessage[] = [];
  if (input.message || photoIds.length > 0) {
    messages.push({ id: newId("tmg"), ticketId: ticket.id, authorKind: "customer", authorId: who.customerId, body: input.message ?? "", attachments: photoIds.length > 0 ? photoIds : null, isInternal: false, createdAt: now });
  }
  if (extras.internalNote) {
    messages.push({ id: newId("tmg"), ticketId: ticket.id, authorKind: extras.assistantSessionId ? "assistant" : "system", authorId: null, body: extras.internalNote, attachments: null, isInternal: true, createdAt: now + 1 });
  }

  const statements: BatchStatement[] = [db.insert(supportTickets).values(row)];
  if (messages.length > 0) statements.push(db.insert(ticketMessages).values(messages));
  statements.push(
    auditStatement(db, {
      actor: actorOf(who),
      action: "support.ticket.create",
      entityType: "support_ticket",
      entityId: ticket.id,
      summary: `${ticket.ref} · ${extras.channel} · ${input.category}`,
      after: { ref: ticket.ref, channel: extras.channel, category: input.category, photos: photoIds.length, assistantSessionId: extras.assistantSessionId ?? null },
      at: now,
    }),
  );
  return statements;
}

/** The guard that opens a creating batch: no ticket with this access-token hash may exist yet. */
export function ticketGuard(db: Db, tokenHash: string): BatchStatement {
  return expectThat(db, sql`NOT EXISTS (SELECT 1 FROM support_tickets WHERE access_token_hash = ${tokenHash})`, "SUPPORT_TICKET_EXISTS");
}

export function fileRowStatements(db: Db, photos: readonly StoredPhoto[]): BatchStatement[] {
  return photos.length > 0 ? [db.insert(files).values([...photos])] : [];
}

export function newTicketIdentity(): { id: string; ref: string } {
  return { id: newId("stk"), ref: publicRef(TICKET_REF_PREFIX) };
}

export type TicketReceipt = { ref: string; createdAt: number; phoneMasked: string; status: string; isDemo: boolean };

/**
 * What the page that receives the shopper after a ticket was opened may show: the reference, when, and the masked
 * phone — only with the access token handed out when it was created. Anything else (a wrong token, an unknown ref) → null.
 */
export async function getTicketByAccessToken(db: Db, ref: unknown, token: unknown): Promise<TicketReceipt | null> {
  const normalized = normalizeSupportRef(ref, TICKET_REF_PREFIX);
  if (!normalized || !isAccessToken(token)) return null;
  const row = await db
    .select({ ref: supportTickets.ref, createdAt: supportTickets.createdAt, phone: supportTickets.phoneE164, status: supportTickets.status, hash: supportTickets.accessTokenHash, isDemo: supportTickets.isDemo })
    .from(supportTickets)
    .where(eq(supportTickets.ref, normalized))
    .get();
  if (!row?.hash || !timingSafeEqual(row.hash, await accessTokenHash(token))) return null;
  return { ref: row.ref, createdAt: row.createdAt, phoneMasked: row.phone ? maskPhone(row.phone) : "", status: row.status, isDemo: row.isDemo };
}

/** Creates a support ticket for a shopper (see the file header). */
export async function createSupportTicket(
  db: Db,
  who: SupportWho,
  raw: unknown,
  now: number,
  options: { store?: BlobStore; photos?: readonly UploadSource[]; channel?: Extract<TicketChannel, "web" | "assistant"> } = {},
): Promise<CreatedTicket> {
  const input = parseTicketInput(raw);
  const sources = photoSources(options.photos ?? []);
  if (sources.length > 0 && !options.store) throw new Error("createSupportTicket: photos need a blob store");

  await enforceSupportLimits(db, "support_ticket", who.ip, input.phoneE164, now);

  const accessToken = await supportAccessToken("ticket", input.idempotencyKey);
  const tokenHash = await accessTokenHash(accessToken);
  const replay = await existingTicket(db, tokenHash, input.phoneE164, accessToken);
  if (replay) return replay;

  const images = await preparePhotos(sources);
  const ticket = { ...newTicketIdentity(), tokenHash };
  const photos = images.length > 0 && options.store ? await storePhotos(options.store, images, { kind: "support_photo", ownerType: "support_ticket", ownerId: ticket.id, createdBy: actorOf(who), now }) : [];

  try {
    const statements = await planSupportTicket(db, who, input, ticket, now, { channel: options.channel ?? "web", photos, tags: ["storefront"] });
    await runBatch(db, [ticketGuard(db, tokenHash), ...fileRowStatements(db, photos), ...statements]);
  } catch (error) {
    if (options.store) await discardPhotos(options.store, photos);
    if (isDbError(error, "SUPPORT_TICKET_EXISTS")) {
      const existing = await existingTicket(db, tokenHash, input.phoneE164, accessToken);
      if (existing) return existing;
    }
    throw error;
  }
  return { ticketId: ticket.id, ref: ticket.ref, accessToken, replayed: false };
}
