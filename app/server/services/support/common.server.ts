/**
 * Shared pieces of the support services: who is asking, references, idempotency and guest access tokens, the
 * preferred-day rule, rate limits, and the private photo pipeline used by repair requests and messages to staff.
 *
 * Must not import "cloudflare:workers": routes pass the blob store (`kvBlobStore(env.KV)`) in.
 */
import { sha256Hex } from "~/lib/ids";
import { toLatinDigits } from "~/lib/phone";
import type { Actor } from "~/server/actor";
import type { NewFileRecord } from "~/server/db/schema";
import { AppError } from "~/server/errors";
import type { RateLimitRule } from "~/server/ratelimit.server";
import { storeBlob, type BlobStore } from "~/server/storage.server";
import { processImageUpload, type ProcessedImage, type UploadSource } from "~/server/uploads.server";
import { MAX_SUPPORT_PHOTOS } from "./types";

/** The person behind a support request: a signed-in customer or a guest, and where the request came from. */
export type SupportWho = {
  customerId: string | null;
  ip: string | null;
  requestId?: string | null;
  /** Requests made while the store is in demo mode are flagged is_demo, like orders. */
  storeMode: "demo" | "live";
};

export function actorOf(who: SupportWho): Actor {
  return who.customerId ? { kind: "customer", id: who.customerId, ip: who.ip, requestId: who.requestId ?? null } : { kind: "guest", ip: who.ip, requestId: who.requestId ?? null };
}

// ───────────────────────────────────────────────────────────────── references and tokens

/** Repair tickets: "RP-7K4M2Q9X". Support tickets: "SP-…" (publicRef alphabet: no 0/O, 1/I/L, U). */
export const REPAIR_REF_PREFIX = "RP";
export const TICKET_REF_PREFIX = "SP";

/**
 * A reference as typed by a person: Arabic-Indic digits, lower case, spaces and a missing dash are forgiven.
 * Returns null when it cannot be one of ours.
 */
export function normalizeSupportRef(value: unknown, prefix: string): string | null {
  if (typeof value !== "string") return null;
  const compact = toLatinDigits(value).toUpperCase().replace(/[\s\u200e\u200f\u2066-\u2069]+/g, "");
  const match = new RegExp(`^${prefix}-?([2-9A-HJ-NP-TV-Z]{6,12})$`).exec(compact);
  return match ? `${prefix}-${match[1]}` : null;
}

const KEY = /^[A-Za-z0-9_-]{32,128}$/;

/** Idempotency keys are random 256-bit tokens written into the form by the loader (never chosen by a person). */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && KEY.test(value);
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The guest access token of a request made with this idempotency key (only its sha256 is stored, in
 * `access_token_hash`). Derived, so a retry with the same key finds the same request — the stored hash doubles as the
 * idempotency marker, and a guard in the creating batch makes two simultaneous submissions produce one row.
 */
export async function supportAccessToken(kind: "repair" | "ticket", idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tamtam.support.${kind}.access.v1|${idempotencyKey}`));
  return base64Url(new Uint8Array(digest));
}

export const isAccessToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);

export async function accessTokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}

// ───────────────────────────────────────────────────────────────── preferred day (a preference, never a promise)

const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const PREFERRED_DAY_SPAN = 30;

/** "YYYY-MM-DD" of a moment in Baghdad (UTC+3, no daylight saving). */
export const baghdadDay = (at: number) => new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

/** A preferred day may be today up to 30 days ahead (Baghdad calendar). */
export function validPreferredDay(day: string, now: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return false;
  return day >= baghdadDay(now) && day <= baghdadDay(now + PREFERRED_DAY_SPAN * DAY_MS);
}

/** The next `count` days from today (Baghdad), as "YYYY-MM-DD" — the choices the repair form offers. */
export function nextDays(now: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => baghdadDay(now + i * DAY_MS));
}

// ───────────────────────────────────────────────────────────────── rate limits (the application's own, per IP and per phone)

export const SUPPORT_LIMITS = {
  /** New repair requests or messages to staff per IP. */
  createIp: { limit: 10, windowSec: 60 * 60 },
  /** … per phone number. */
  createPhone: { limit: 5, windowSec: 60 * 60 },
  /** Repair status lookups (reference + phone) per IP. */
  lookupIp: { limit: 10, windowSec: 15 * 60 },
  /** … per reference, whoever asks. */
  lookupRef: { limit: 10, windowSec: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;

// ───────────────────────────────────────────────────────────────── photos (private)

/** The uploaded files of a form field, without the empty entry a browser sends when nothing was chosen. */
export function photoSources(values: readonly UploadSource[]): UploadSource[] {
  return values.filter((value) => value != null && typeof value !== "string" && !(value instanceof Blob && value.size === 0));
}

/**
 * Checks every photo (size, real type, structure, dimensions; metadata such as GPS position removed). Throws
 * AppError("invalid") with `fields.photos` = the first problem ("upload_type", "upload_too_large", … or "too_big"
 * for more than MAX_SUPPORT_PHOTOS).
 */
export async function preparePhotos(sources: readonly UploadSource[]): Promise<ProcessedImage[]> {
  if (sources.length > MAX_SUPPORT_PHOTOS) throw new AppError("invalid", 400, { fields: { photos: "too_big" }, detail: `${sources.length} photos` });
  const images: ProcessedImage[] = [];
  for (const source of sources) {
    try {
      images.push(await processImageUpload(source));
    } catch (error) {
      if (error instanceof AppError && error.fields?.file) throw new AppError("invalid", 400, { fields: { photos: error.fields.file }, detail: error.detail });
      throw error;
    }
  }
  return images;
}

export type StoredPhoto = NewFileRecord & { id: string; storageKey: string };

/**
 * Puts the cleaned photos in private storage and returns their `files` rows for the caller's batch. If that batch
 * fails, call discardPhotos() so no bytes are left that nothing points at.
 */
export async function storePhotos(
  store: BlobStore,
  images: readonly ProcessedImage[],
  options: { kind: string; ownerType: string; ownerId: string; createdBy: Actor; now: number },
): Promise<StoredPhoto[]> {
  const rows: StoredPhoto[] = [];
  try {
    for (const image of images) {
      rows.push(
        await storeBlob(store, {
          bytes: image.bytes,
          mime: image.mime,
          visibility: "private",
          kind: options.kind,
          width: image.width,
          height: image.height,
          sha256: image.sha256,
          ownerType: options.ownerType,
          ownerId: options.ownerId,
          createdBy: options.createdBy,
          originalName: image.originalName,
          now: options.now,
        }),
      );
    }
  } catch (error) {
    await discardPhotos(store, rows);
    throw error;
  }
  return rows;
}

export async function discardPhotos(store: BlobStore, rows: readonly StoredPhoto[]): Promise<void> {
  await Promise.all(rows.map((row) => store.delete(row.storageKey).catch(() => {})));
}
