/**
 * 21.03 / 21.04 Outgoing webhooks — the registry, the queue, signing, delivery with retries, and the honest boundary.
 *
 * REGISTRY (channels.webhook.manage)
 *   createWebhook(db, actor, dataKey, raw, now) → { webhookId, secret, replayed }   the signing secret ("whsec_…") is
 *       returned ONCE and stored encrypted with DATA_KEY (context "webhook:<id>:secret"); a resubmitted form returns
 *       secret: null. The address must be https on port 443 with a public host name — no IP literal, no credentials, no
 *       localhost or private suffix (checkWebhookUrl).
 *   updateWebhook · setWebhookActive · rotateWebhookSecret (a new secret, once; the old one stops at once) · sendPing
 *   Creating a webhook, changing its address or events, or resuming a paused one hands the store's order references
 *   and totals to an outside address: it needs orders.order.read (orders_read_required, 403 — the hierarchy rule, as
 *   for an API key's scopes) and no branch limit (forbidden "branch": the events are every branch's). Pausing never.
 *
 * QUEUE — a delivery row per (webhook, event); UNIQUE (webhook_id, event_id) makes queuing idempotent
 *   queueOrderEvents(db, now) — the commerce core's order events (placed; confirmed, shipped, delivered, cancelled,
 *       returned) that happened after the webhook was created (at most WEBHOOK_LOOKBACK_MS back), each queued once
 *       however often it runs (ON CONFLICT DO NOTHING). Payload: the order's reference, channel, status and totals —
 *       never a customer's name, phone or address, never cost; demo orders say "demo": true. A run reads only events
 *       not queued yet for the webhook, so a burst larger than one scan is caught up over the next runs.
 *   queueNow(db, actor, now) — the same, run by a person from the admin (audited).
 *
 * DELIVERY — deliverWebhooks(db, { dataKey, transport }, now)
 *   Each attempt is claimed first (attempts n → n + 1 and back to "pending" in one guarded write), so two runs never
 *   send the same attempt and a person cannot make an attempt that is being sent due again; a succeeded delivery is
 *   never sent again; failures wait WEBHOOK_BACKOFF_MINUTES and give up after WEBHOOK_MAX_ATTEMPTS. Every request
 *   carries the delivery id and the event id for the receiver to drop a repeat, and
 *   "X-TamTam-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">".
 *   THE BOUNDARY: no transport is configured. Sending to an outside address safely needs a resolver that refuses
 *   private, loopback, link-local and metadata addresses after DNS resolution and pins what it checked — the Worker
 *   cannot pin an address for fetch — so nothing is ever sent: deliveries wait as "pending" and the run reports
 *   "no_transport". A transport passed in (tests; later a vetted relay) must check isPublicAddress() itself.
 *
 * RETRY — retryDelivery(db, actor, { deliveryId, reason }, now): a failed or given-up delivery is due again (the same
 *   row, the same ids — never a second delivery of the event), audited. One whose attempt is out (claimed, "pending")
 *   is not retryable: guarded on the status and the attempt count read, inside the write.
 *
 * Errors: webhook_changed, webhook_inactive, delivery_not_retryable, data_key_missing (503), idempotency_mismatch,
 * invalid (fields), forbidden, not_found. Must not import "cloudflare:workers".
 */
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, randomToken } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import { decryptSecret, encryptSecret, hmacSha256Hex } from "~/server/crypto.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { webhookDeliveries, webhooks } from "~/server/db/schema";
import { chunkRows, expectChanged, expectThat, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { IdSchema, IdempotencyKey, Reason, assertAny, assertWholeStore, employeeNames, fingerprintOf, guardError, isWholeStore, keyedId } from "./shared.server";
import {
  DELIVERY_PAGE_SIZE,
  DELIVERY_STATUS_LIST,
  PING_EVENT,
  WEBHOOK_BACKOFF_MINUTES,
  WEBHOOK_CLAIM_MS,
  WEBHOOK_EVENTS,
  WEBHOOK_LOOKBACK_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_URL_MAX,
  type DeliveryFilters,
  type DeliveryStatus,
  type PersonRef,
  type WebhookEvent,
} from "./types";

const MANAGE = "channels.webhook.manage";
export const DELIVERY_READERS = ["channels.webhook.manage", "channels.integration.read", "channels.integration.manage"] as const;
const GUARDS: Record<string, [string, number]> = { WEBHOOK_CHANGED: ["webhook_changed", 409], DELIVERY_NOT_RETRYABLE: ["delivery_not_retryable", 409], WEBHOOK_INACTIVE: ["webhook_inactive", 409] };

const secretContext = (webhookId: string) => `webhook:${webhookId}:secret`;
const newSecret = () => `whsec_${randomToken(32)}`;

/** What its events carry is the store's orders (references, totals): only who may read them points a webhook at an address. */
export const ORDERS_READ = "orders.order.read";

/** May this employee create a webhook, change where one sends and what it hears, or resume one? (the page offers it only then) */
export function canPointWebhooks(actor: Actor): boolean {
  return can(actor, MANAGE) && can(actor, ORDERS_READ) && isWholeStore(actor);
}

function assertMayPoint(actor: Actor): void {
  assertWholeStore(actor);
  if (!can(actor, ORDERS_READ)) throw new AppError("orders_read_required", 403, { detail: ORDERS_READ });
}

function requireDataKey(dataKey: string | null | undefined): string {
  if (!dataKey) throw new AppError("data_key_missing", 503);
  return dataKey;
}

// ───────────────────────────────────────────────────────────────── addresses

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".private", ".test", ".example", ".invalid", ".onion", ".arpa", ".localdomain"];

/** A host name that can only mean a public server: no IP literal (any notation the URL parser understands), a dot, a real-looking top-level name. */
function isPublicHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.startsWith("[") || host.includes(":")) return false; // IPv6 literal
  if (/^[0-9.]+$/.test(host)) return false; // IPv4 literal (the parser turns 0x7f.1 and 2130706433 into one)
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{1,59}$/.test(tld);
}

/** The address as it will be stored, or the field key that refuses it. */
export function checkWebhookUrl(raw: string): { url: string } | { error: string } {
  const value = raw.trim();
  if (!value) return { error: "required" };
  if (value.length > WEBHOOK_URL_MAX) return { error: "too_long" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "url_invalid" };
  }
  if (url.protocol !== "https:") return { error: "url_https" };
  if (url.username || url.password) return { error: "url_credentials" };
  if (url.port && url.port !== "443") return { error: "url_port" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicHostname(host)) return { error: "url_host" };
  url.hash = "";
  return { url: url.toString() };
}

const IPV4_BLOCKED: readonly [number, number][] = [
  [0x00000000, 8], // "this" network
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT (also 100.100.100.200, a cloud metadata address)
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, 169.254.169.254 metadata
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved, broadcast
];

function ipv4Number(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}

/**
 * True only for an address a webhook may be sent to: a transport resolves the host name, checks EVERY address with
 * this, connects only to one it checked, and follows no redirect. Refuses private, loopback, link-local, carrier NAT,
 * metadata, documentation, multicast and reserved ranges, IPv4-mapped forms of them, and IPv6 local ranges.
 */
export function isPublicAddress(ip: string): boolean {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = ipv4Number(value);
  if (v4 !== null) return !IPV4_BLOCKED.some(([base, bits]) => Math.floor(v4 / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  if (!value.includes(":")) return false;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPublicAddress(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(value)) return false; // IPv4-mapped in hex: refuse rather than decode
  if (value === "::" || value === "::1") return false;
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7 (fd00:ec2::254 metadata)
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (value.startsWith("2001:db8") || value.startsWith("64:ff9b") || value.startsWith("100:") || value.startsWith("2002:")) return false; // documentation, NAT64, discard, 6to4
  return (first & 0xe000) === 0x2000; // global unicast 2000::/3 only
}

// ───────────────────────────────────────────────────────────────── signing

export type SignedWebhookRequest = { url: string; headers: Record<string, string>; body: string };
export type WebhookTransport = { send(request: SignedWebhookRequest): Promise<{ status: number }> };

/** The signature header of a body sent at `now` (seconds in `t`). */
export async function signatureFor(secret: string, body: string, now: number): Promise<string> {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

/** What a receiver checks: the signature over "<t>.<body>" with its secret, and that `t` is within `toleranceSec`. */
export async function verifyWebhookSignature(secret: string, header: string, body: string, now: number, toleranceSec = 300): Promise<boolean> {
  const parts = new Map(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1") ?? "";
  if (!Number.isSafeInteger(t) || Math.abs(Math.floor(now / 1000) - t) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ───────────────────────────────────────────────────────────────── reading

export type WebhookRow = {
  id: string;
  name: string;
  url: string;
  host: string;
  events: WebhookEvent[];
  isActive: boolean;
  failureCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  createdBy: PersonRef;
  createdAt: number;
  counts: Record<DeliveryStatus, number>;
  fingerprint: string;
};

export type DeliveryRow = {
  id: string;
  webhookId: string;
  webhookName: string;
  event: string;
  eventId: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
  ref: string | null;
};

const eventsOf = (value: unknown): WebhookEvent[] => (Array.isArray(value) ? value.filter((event): event is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(event as string)) : []);
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function webhookFingerprint(row: { name: string; url: string; events: unknown; isActive: boolean }): Promise<string> {
  return fingerprintOf([row.name, row.url, eventsOf(row.events), row.isActive]);
}

async function deliveryCountsBy(db: Db, webhookIds: readonly string[]): Promise<Map<string, Record<DeliveryStatus, number>>> {
  const out = new Map<string, Record<DeliveryStatus, number>>(webhookIds.map((id) => [id, { pending: 0, succeeded: 0, failed: 0, gave_up: 0 }]));
  if (webhookIds.length === 0) return out;
  const rows = await db
    .select({ webhookId: webhookDeliveries.webhookId, status: webhookDeliveries.status, n: sql<number>`count(*)` })
    .from(webhookDeliveries)
    .where(inArray(webhookDeliveries.webhookId, [...webhookIds]))
    .groupBy(webhookDeliveries.webhookId, webhookDeliveries.status);
  for (const row of rows) {
    const counts = out.get(row.webhookId);
    if (counts) counts[row.status] = Number(row.n);
  }
  return out;
}

export async function listWebhooks(db: Db, actor: Actor): Promise<WebhookRow[]> {
  assertCan(actor, MANAGE);
  const rows = await db.select().from(webhooks).orderBy(desc(webhooks.isActive), asc(webhooks.name)).limit(100);
  const [counts, names] = await Promise.all([
    deliveryCountsBy(
      db,
      rows.map((row) => row.id),
    ),
    employeeNames(
      db,
      rows.map((row) => row.createdBy),
    ),
  ]);
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      host: hostOf(row.url),
      events: eventsOf(row.events),
      isActive: row.isActive,
      failureCount: row.failureCount,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      createdBy: row.createdBy ? { id: row.createdBy, name: names.get(row.createdBy) ?? row.createdBy } : null,
      createdAt: row.createdAt,
      counts: counts.get(row.id) ?? { pending: 0, succeeded: 0, failed: 0, gave_up: 0 },
      fingerprint: await webhookFingerprint(row),
    })),
  );
}

export async function getWebhook(db: Db, actor: Actor, webhookId: string): Promise<WebhookRow & { deliveries: DeliveryRow[] }> {
  assertCan(actor, MANAGE);
  const row = await db.select().from(webhooks).where(eq(webhooks.id, webhookId)).get();
  if (!row) throw notFound("webhook");
  const [counts, names, page] = await Promise.all([deliveryCountsBy(db, [row.id]), employeeNames(db, [row.createdBy]), listDeliveries(db, actor, { status: null, webhook: row.id, page: 1 })]);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    host: hostOf(row.url),
    events: eventsOf(row.events),
    isActive: row.isActive,
    failureCount: row.failureCount,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    createdBy: row.createdBy ? { id: row.createdBy, name: names.get(row.createdBy) ?? row.createdBy } : null,
    createdAt: row.createdAt,
    counts: counts.get(row.id) ?? { pending: 0, succeeded: 0, failed: 0, gave_up: 0 },
    fingerprint: await webhookFingerprint(row),
    deliveries: page.rows,
  };
}

export async function listDeliveries(db: Db, actor: Actor, filters: DeliveryFilters): Promise<{ rows: DeliveryRow[]; total: number; page: number; pageCount: number; counts: Record<DeliveryStatus, number> }> {
  assertAny(actor, DELIVERY_READERS);
  // the payload's order reference is an order's: shown only to who may read orders (null otherwise, never sent)
  const withRef = can(actor, ORDERS_READ);
  const conditions = [filters.status ? eq(webhookDeliveries.status, filters.status) : undefined, filters.webhook ? eq(webhookDeliveries.webhookId, filters.webhook) : undefined].filter(Boolean);
  const where = conditions.length ? and(...conditions) : undefined;
  const [totalRow, statusRows] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(webhookDeliveries).where(where).get(),
    db
      .select({ status: webhookDeliveries.status, n: sql<number>`count(*)` })
      .from(webhookDeliveries)
      .where(filters.webhook ? eq(webhookDeliveries.webhookId, filters.webhook) : undefined)
      .groupBy(webhookDeliveries.status),
  ]);
  const total = Number(totalRow?.n ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / DELIVERY_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db
    .select({
      id: webhookDeliveries.id,
      webhookId: webhookDeliveries.webhookId,
      webhookName: webhooks.name,
      event: webhookDeliveries.event,
      eventId: webhookDeliveries.eventId,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      nextAttemptAt: webhookDeliveries.nextAttemptAt,
      responseStatus: webhookDeliveries.responseStatus,
      lastError: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
      deliveredAt: webhookDeliveries.deliveredAt,
      ref: withRef ? sql<string | null>`json_extract(${webhookDeliveries.payload}, '$.data.order.ref')` : sql<string | null>`NULL`,
    })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(where)
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(DELIVERY_PAGE_SIZE)
    .offset((page - 1) * DELIVERY_PAGE_SIZE);
  const counts: Record<DeliveryStatus, number> = { pending: 0, succeeded: 0, failed: 0, gave_up: 0 };
  for (const row of statusRows) counts[row.status] = Number(row.n);
  return { rows: rows.map((row) => ({ ...row, ref: row.ref ?? null })), total, page, pageCount, counts };
}

// ───────────────────────────────────────────────────────────────── registry changes

const Events = z
  .array(z.string())
  .max(WEBHOOK_EVENTS.length * 2)
  .default([])
  .transform((values) => [...new Set(values.map((value) => value.trim()).filter(Boolean))]);

const WebhookFields = z.object({
  name: z.string({ error: "required" }).trim().min(2, "required").max(80, "too_long"),
  url: z.string({ error: "required" }).trim().max(WEBHOOK_URL_MAX + 10, "too_long"),
  events: Events,
});
const CreateInput = WebhookFields.extend({ reason: Reason, idempotencyKey: IdempotencyKey });
const UpdateInput = WebhookFields.extend({ webhookId: IdSchema, fingerprint: z.string().trim().min(1, "required").max(64), reason: Reason });
const SetActiveInput = z.object({ webhookId: IdSchema, active: z.boolean(), reason: Reason });
const RotateInput = z.object({ webhookId: IdSchema, reason: Reason });
const RetryInput = z.object({ deliveryId: IdSchema, reason: Reason });

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw invalid(zodFieldErrors(result.error));
  return result.data;
}

function checkFields(input: z.output<typeof WebhookFields>): { url: string; events: WebhookEvent[] } {
  const fields: Record<string, string> = {};
  const url = checkWebhookUrl(input.url);
  if ("error" in url) fields.url = url.error;
  if (input.events.length === 0) fields.events = "events_required";
  else if (!input.events.every((event) => (WEBHOOK_EVENTS as readonly string[]).includes(event))) fields.events = "event_unknown";
  if (Object.keys(fields).length) throw invalid(fields);
  return { url: (url as { url: string }).url, events: input.events as WebhookEvent[] };
}

/** What the audit trail keeps of an address: its host (a path may carry the receiver's own token). */
const urlForAudit = (url: string) => ({ host: hostOf(url), pathHidden: true });

export async function createWebhook(db: Db, actor: Actor, dataKey: string | null | undefined, raw: unknown, now: number): Promise<{ webhookId: string; secret: string | null; replayed: boolean }> {
  assertCan(actor, MANAGE);
  assertMayPoint(actor);
  const input = parse(CreateInput, raw);
  const { url, events } = checkFields(input);
  const webhookId = await keyedId("whk", actor, input.idempotencyKey);
  const existing = await db.select({ name: webhooks.name, url: webhooks.url }).from(webhooks).where(eq(webhooks.id, webhookId)).get();
  if (existing) {
    if (existing.name !== input.name || existing.url !== url) throw new AppError("idempotency_mismatch", 409);
    return { webhookId, secret: null, replayed: true };
  }
  const key = requireDataKey(dataKey);
  const secret = newSecret();
  const secretEnc = await encryptSecret(secret, key, secretContext(webhookId));
  try {
    await runBatch(db, [
      db.insert(webhooks).values({ id: webhookId, name: input.name, url, secretEnc, events, isActive: true, failureCount: 0, createdBy: actor.kind === "employee" ? actor.id : null, createdAt: now }),
      auditStatement(db, { actor, action: "channels.webhook.create", entityType: "webhook", entityId: webhookId, after: { name: input.name, url: urlForAudit(url), events }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "webhooks.id")) return { webhookId, secret: null, replayed: true };
    throw error;
  }
  return { webhookId, secret, replayed: false };
}

export async function updateWebhook(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  assertMayPoint(actor);
  const input = parse(UpdateInput, raw);
  const before = await db.select().from(webhooks).where(eq(webhooks.id, input.webhookId)).get();
  if (!before) throw notFound("webhook");
  if ((await webhookFingerprint(before)) !== input.fingerprint) throw new AppError("webhook_changed", 409);
  const { url, events } = checkFields(input);
  if (before.name === input.name && before.url === url && JSON.stringify(eventsOf(before.events)) === JSON.stringify(events)) return { changed: false };
  try {
    await runBatch(db, [
      db
        .update(webhooks)
        .set({ name: input.name, url, events })
        .where(and(eq(webhooks.id, before.id), eq(webhooks.name, before.name), eq(webhooks.url, before.url), sql`${webhooks.events} = ${JSON.stringify(before.events)}`)),
      expectChanged(db, 1, { code: "WEBHOOK_CHANGED", detail: before.id }),
      auditStatement(db, {
        actor,
        action: "channels.webhook.update",
        entityType: "webhook",
        entityId: before.id,
        before: { name: before.name, url: urlForAudit(before.url), events: eventsOf(before.events) },
        after: { name: input.name, url: urlForAudit(url), events },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

export async function setWebhookActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  const input = parse(SetActiveInput, raw);
  // resuming opens the flow of order data to the outside address again: what pointing a webhook needs; pausing never
  if (input.active) assertMayPoint(actor);
  const before = await db.select({ id: webhooks.id, isActive: webhooks.isActive }).from(webhooks).where(eq(webhooks.id, input.webhookId)).get();
  if (!before) throw notFound("webhook");
  if (before.isActive === input.active) return { changed: false };
  try {
    await runBatch(db, [
      db
        .update(webhooks)
        .set({ isActive: input.active })
        .where(and(eq(webhooks.id, before.id), eq(webhooks.isActive, !input.active))),
      expectChanged(db, 1, { code: "WEBHOOK_CHANGED", detail: before.id }),
      auditStatement(db, { actor, action: input.active ? "channels.webhook.resume" : "channels.webhook.pause", entityType: "webhook", entityId: before.id, before: { isActive: before.isActive }, after: { isActive: input.active }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

export async function rotateWebhookSecret(db: Db, actor: Actor, dataKey: string | null | undefined, raw: unknown, now: number): Promise<{ secret: string }> {
  assertCan(actor, MANAGE);
  const input = parse(RotateInput, raw);
  const before = await db.select({ id: webhooks.id, secretEnc: webhooks.secretEnc }).from(webhooks).where(eq(webhooks.id, input.webhookId)).get();
  if (!before) throw notFound("webhook");
  const key = requireDataKey(dataKey);
  const secret = newSecret();
  const secretEnc = await encryptSecret(secret, key, secretContext(before.id));
  try {
    await runBatch(db, [
      db
        .update(webhooks)
        .set({ secretEnc })
        .where(and(eq(webhooks.id, before.id), eq(webhooks.secretEnc, before.secretEnc))),
      expectChanged(db, 1, { code: "WEBHOOK_CHANGED", detail: before.id }),
      auditStatement(db, { actor, action: "channels.webhook.rotate_secret", entityType: "webhook", entityId: before.id, after: { secretRotated: true }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { secret };
}

/** Queues a "ping" for an active webhook: the receiver's first check that our signature verifies. */
export async function sendPing(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ deliveryId: string }> {
  assertCan(actor, MANAGE);
  const input = parse(z.object({ webhookId: IdSchema }), raw);
  const row = await db.select({ id: webhooks.id, isActive: webhooks.isActive }).from(webhooks).where(eq(webhooks.id, input.webhookId)).get();
  if (!row) throw notFound("webhook");
  if (!row.isActive) throw new AppError("webhook_inactive", 409);
  const deliveryId = newId("whd");
  const eventId = newId("ping");
  try {
    await runBatch(db, [
      db.insert(webhookDeliveries).values({ id: deliveryId, webhookId: row.id, event: PING_EVENT, eventId, payload: { id: eventId, event: PING_EVENT, occurredAt: now, demo: false, data: {} }, status: "pending", attempts: 0, createdAt: now }),
      expectThat(db, sql`EXISTS (SELECT 1 FROM webhooks WHERE id = ${row.id} AND is_active = 1)`, { code: "WEBHOOK_INACTIVE", detail: row.id }),
      auditStatement(db, { actor, action: "channels.webhook.ping", entityType: "webhook", entityId: row.id, after: { deliveryId }, at: now }),
    ]);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { deliveryId };
}

// ───────────────────────────────────────────────────────────────── queue

const ORDER_EVENT_OF: Record<string, WebhookEvent> = { confirmed: "order.confirmed", shipped: "order.shipped", delivered: "order.delivered", cancelled: "order.cancelled", returned: "order.returned" };
const SCAN_LIMIT = 500;
const OVERLAP_MS = 5 * 60_000;

/** Every active webhook's order events since it last heard one (each queued once, whatever happens twice). */
export async function queueOrderEvents(db: Db, now: number): Promise<{ queued: number; scanned: number; webhooks: number }> {
  const active = await db.select({ id: webhooks.id, events: webhooks.events, createdAt: webhooks.createdAt }).from(webhooks).where(eq(webhooks.isActive, true));
  let queued = 0;
  let scanned = 0;
  for (const webhook of active) {
    const wanted = new Set(eventsOf(webhook.events));
    if (wanted.size === 0) continue;
    const cursorRow = await db.all<{ at: number | null }>(sql`
      SELECT max(CAST(json_extract(payload, '$.occurredAt') AS INTEGER)) AS at FROM webhook_deliveries WHERE webhook_id = ${webhook.id} AND event <> ${PING_EVENT}`);
    const cursor = cursorRow[0]?.at ?? null;
    const start = Math.max(webhook.createdAt, now - WEBHOOK_LOOKBACK_MS, cursor === null ? 0 : Number(cursor) - OVERLAP_MS);
    // only the events this webhook hears are read: every row read is queued, so the cursor always moves on
    const statuses = Object.entries(ORDER_EVENT_OF)
      .filter(([, name]) => wanted.has(name))
      .map(([status]) => sql`${status}`);
    const subscribed = sql.join(
      [
        ...(wanted.has("order.placed") ? [sql`e.kind = 'placed'`] : []),
        ...(statuses.length ? [sql`(e.kind = 'status_changed' AND json_extract(e.data, '$.to') IN (${sql.join(statuses, sql`, `)}))`] : []),
      ],
      sql` OR `,
    );
    // only events not queued for this webhook yet: the overlap window re-reads the last minutes, and a burst of more
    // than SCAN_LIMIT events inside it must not be read again and again (the cursor would never move: a stall)
    const events = await db.all<{ id: string; kind: string; toStatus: string | null; at: number; ref: string; channel: string; status: string; paymentStatus: string; totalIqd: number; isDemo: number }>(sql`
      SELECT e.id AS id, e.kind AS kind, json_extract(e.data, '$.to') AS toStatus, e.at AS at, o.ref AS ref, o.channel AS channel, o.status AS status,
             o.payment_status AS paymentStatus, o.total_iqd AS totalIqd, o.is_demo AS isDemo
      FROM order_events AS e JOIN orders AS o ON o.id = e.order_id
      WHERE e.at >= ${start} AND e.at <= ${now} AND (${subscribed})
        AND NOT EXISTS (SELECT 1 FROM webhook_deliveries AS d WHERE d.webhook_id = ${webhook.id} AND d.event_id = e.id)
      ORDER BY e.at, e.id
      LIMIT ${SCAN_LIMIT}`);
    scanned += events.length;
    const rows = events
      .map((event) => {
        const name: WebhookEvent | undefined = event.kind === "placed" ? "order.placed" : ORDER_EVENT_OF[event.toStatus ?? ""];
        if (!name || !wanted.has(name)) return null;
        return {
          id: newId("whd"),
          webhookId: webhook.id,
          event: name,
          eventId: event.id,
          payload: {
            id: event.id,
            event: name,
            occurredAt: Number(event.at),
            demo: Boolean(event.isDemo),
            data: { order: { ref: event.ref, channel: event.channel, status: event.kind === "placed" ? null : event.toStatus, totalIqd: Number(event.totalIqd), currency: "IQD" } },
          },
          status: "pending" as const,
          attempts: 0,
          createdAt: now,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
    if (rows.length === 0) continue;
    const statements: BatchStatement[] = chunkRows(webhookDeliveries, rows).map((chunk) => db.insert(webhookDeliveries).values(chunk).onConflictDoNothing({ target: [webhookDeliveries.webhookId, webhookDeliveries.eventId] }));
    const results = await runBatch(db, statements);
    for (const result of results) queued += Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  }
  return { queued, scanned, webhooks: active.length };
}

/** queueOrderEvents run by a person from the admin (until the scheduled job is registered), audited with its counts. */
export async function queueNow(db: Db, actor: Actor, now: number): Promise<{ queued: number; scanned: number; webhooks: number }> {
  assertCan(actor, MANAGE);
  const result = await queueOrderEvents(db, now);
  await runBatch(db, [auditStatement(db, { actor, action: "channels.webhook.queue", entityType: "webhook", entityId: null, after: result, at: now })]);
  return result;
}

// ───────────────────────────────────────────────────────────────── delivery

export type DeliverRun = { sent: number; failed: number; gaveUp: number; skipped: number; reason: "no_transport" | "data_key_missing" | null };

const backoffMs = (attempts: number) => WEBHOOK_BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), WEBHOOK_BACKOFF_MINUTES.length) - 1] * 60_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

/** Deliveries that are due now (not succeeded, not given up, not claimed by a running attempt) of active webhooks. */
function dueCondition(now: number) {
  return and(inArray(webhookDeliveries.status, ["pending", "failed"]), or(isNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, now)), eq(webhooks.isActive, true));
}

export async function countDue(db: Db, now: number): Promise<number> {
  const row = await db.select({ n: sql<number>`count(*)` }).from(webhookDeliveries).innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId)).where(dueCondition(now)).get();
  return Number(row?.n ?? 0);
}

export async function deliverWebhooks(db: Db, options: { dataKey?: string | null; transport?: WebhookTransport | null }, now: number, limit = 25): Promise<DeliverRun> {
  const run: DeliverRun = { sent: 0, failed: 0, gaveUp: 0, skipped: 0, reason: null };
  if (!options.transport) return { ...run, skipped: await countDue(db, now), reason: "no_transport" };
  if (!options.dataKey) return { ...run, skipped: await countDue(db, now), reason: "data_key_missing" };
  const due = await db
    .select({ id: webhookDeliveries.id, webhookId: webhookDeliveries.webhookId, event: webhookDeliveries.event, eventId: webhookDeliveries.eventId, payload: webhookDeliveries.payload, attempts: webhookDeliveries.attempts, url: webhooks.url, secretEnc: webhooks.secretEnc })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(dueCondition(now))
    .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id))
    .limit(limit);

  for (const delivery of due) {
    const attempts = delivery.attempts + 1;
    // claim: only one run moves attempts from n to n + 1, and the claim keeps it from being due meanwhile. The row is
    // "pending" while the attempt is out, so a person's retry (failed / given up only) cannot make it due a second time
    const claimed = await db
      .update(webhookDeliveries)
      .set({ attempts, status: "pending", nextAttemptAt: now + WEBHOOK_CLAIM_MS })
      .where(
        and(
          eq(webhookDeliveries.id, delivery.id),
          eq(webhookDeliveries.attempts, delivery.attempts),
          inArray(webhookDeliveries.status, ["pending", "failed"]),
          or(isNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, now)),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    if (claimed.length === 0) {
      run.skipped += 1;
      continue;
    }
    let status: number | null = null;
    let failure: string | null = null;
    try {
      const secret = await decryptSecret(delivery.secretEnc, options.dataKey, secretContext(delivery.webhookId));
      const body = JSON.stringify({ ...delivery.payload, deliveryId: delivery.id });
      const response = await options.transport.send({
        url: delivery.url,
        body,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "TamTam-Webhooks/1",
          "X-TamTam-Event": delivery.event,
          "X-TamTam-Event-Id": delivery.eventId,
          "X-TamTam-Delivery": delivery.id,
          "X-TamTam-Signature": await signatureFor(secret, body, now),
        },
      });
      status = response.status;
      if (status < 200 || status >= 300) failure = `HTTP ${status}`;
    } catch (error) {
      failure = errorText(error);
    }
    const mine = and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.attempts, attempts));
    if (failure === null) {
      await runBatch(db, [
        db.update(webhookDeliveries).set({ status: "succeeded", responseStatus: status, deliveredAt: now, lastError: null, nextAttemptAt: null }).where(mine),
        db.update(webhooks).set({ lastSuccessAt: now, failureCount: 0 }).where(eq(webhooks.id, delivery.webhookId)),
      ]);
      run.sent += 1;
    } else {
      const giveUp = attempts >= WEBHOOK_MAX_ATTEMPTS;
      await runBatch(db, [
        db
          .update(webhookDeliveries)
          .set({ status: giveUp ? "gave_up" : "failed", responseStatus: status, lastError: failure, nextAttemptAt: giveUp ? null : now + backoffMs(attempts) })
          .where(mine),
        db
          .update(webhooks)
          .set({ lastFailureAt: now, failureCount: sql`${webhooks.failureCount} + 1` })
          .where(eq(webhooks.id, delivery.webhookId)),
      ]);
      if (giveUp) run.gaveUp += 1;
      else run.failed += 1;
    }
  }
  return run;
}

/** A failed or given-up delivery is due again — the same row and ids, so the receiver can still drop a repeat. */
export async function retryDelivery(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  const input = parse(RetryInput, raw);
  const row = await db.select({ id: webhookDeliveries.id, webhookId: webhookDeliveries.webhookId, status: webhookDeliveries.status, attempts: webhookDeliveries.attempts, event: webhookDeliveries.event }).from(webhookDeliveries).where(eq(webhookDeliveries.id, input.deliveryId)).get();
  if (!row) throw notFound("delivery");
  if (row.status !== "failed" && row.status !== "gave_up") throw new AppError("delivery_not_retryable", 409);
  try {
    await runBatch(db, [
      db
        .update(webhookDeliveries)
        .set({ status: "failed", nextAttemptAt: now })
        .where(and(eq(webhookDeliveries.id, row.id), inArray(webhookDeliveries.status, ["failed", "gave_up"]), eq(webhookDeliveries.attempts, row.attempts))),
      expectChanged(db, 1, { code: "DELIVERY_NOT_RETRYABLE", detail: row.id }),
      auditStatement(db, { actor, action: "channels.webhook.retry", entityType: "webhook_delivery", entityId: row.id, before: { status: row.status, attempts: row.attempts }, after: { status: "failed", due: now, webhookId: row.webhookId, event: row.event }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

/** For the monitor: deliveries by status and the oldest that waits. */
export async function deliveryHealth(db: Db, now: number): Promise<{ counts: Record<DeliveryStatus, number>; oldestPendingAt: number | null; failed24h: number; due: number }> {
  const [rows, oldest, recent, due] = await Promise.all([
    db
      .select({ status: webhookDeliveries.status, n: sql<number>`count(*)` })
      .from(webhookDeliveries)
      .groupBy(webhookDeliveries.status),
    db.select({ at: sql<number | null>`min(${webhookDeliveries.createdAt})` }).from(webhookDeliveries).where(eq(webhookDeliveries.status, "pending")).get(),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM webhook_deliveries WHERE status IN ('failed', 'gave_up') AND created_at >= ${now - 24 * 60 * 60_000}`),
    countDue(db, now),
  ]);
  const counts: Record<DeliveryStatus, number> = { pending: 0, succeeded: 0, failed: 0, gave_up: 0 };
  for (const row of rows) if ((DELIVERY_STATUS_LIST as readonly string[]).includes(row.status)) counts[row.status] = Number(row.n);
  return { counts, oldestPendingAt: oldest?.at == null ? null : Number(oldest.at), failed24h: Number(recent[0]?.n ?? 0), due };
}
