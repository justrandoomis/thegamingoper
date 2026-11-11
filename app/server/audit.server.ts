/**
 * The audit trail — who did what, to which record, why, from where.
 *
 *   await db.batch([
 *     db.update(stockLevels)…,
 *     auditStatement(db, { actor, action: "inventory.stock.adjust", entityType: "variant", entityId, before, after, reason, at: now }),
 *   ]);
 *
 * Put the audit statement in the SAME batch as the change it describes: either both are stored or
 * neither. `audit(db, event)` is for events that stand alone (a sign-in, a failed verification).
 *
 * `audit_events` is append-only (database triggers reject UPDATE, DELETE and an INSERT OR REPLACE
 * that would rewrite an existing event, drizzle/0003_append_only_no_replace.sql). On top of that,
 * `sealAudit()` chains SHA-256 hashes over the events into `audit_seals`, and `verifyAuditChain()`
 * recomputes them: an event that was edited, removed or inserted behind the triggers' back no longer
 * matches its seal. What the chain cannot see: events deleted before they were sealed, and a chain
 * that was rewritten from start to end by someone with full database access — which is why
 * sealAudit() returns the head hash for the caller to log outside the database.
 *
 * Snapshots (`before` / `after`) are redacted on the way in: secrets never, full phone numbers
 * masked. This module must not import "cloudflare:workers".
 */
import { asc, desc, eq, gt, sql } from "drizzle-orm";
import { newId, sha256Hex } from "~/lib/ids";
import { maskPhone, normalizeIraqPhone, toLatinDigits } from "~/lib/phone";
import { actorRef, type Actor, type RequestOrigin } from "./actor";
import type { BatchStatement, Db } from "./db/drizzle.server";
import { auditEvents, auditSeals, type NewAuditEvent } from "./db/schema";
import { isUniqueViolation } from "./db/tx.server";

export type AuditEventInput = {
  actor: Actor;
  /** `<module>.<resource>.<verb>`, e.g. "inventory.stock.adjust", "orders.payment.verify". */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  /** One short human sentence, optional. */
  summary?: string | null;
  /** State before and after the change (any JSON-like value). Redacted before it is stored. */
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Epoch ms — pass the request's `ctx.now`. */
  at: number;
  /** Default: the origin carried by the actor. */
  ip?: string | null;
  requestId?: string | null;
  /** Default: the actor's label (an employee's name at the time). */
  actorLabel?: string | null;
  /** Default: a new id. */
  id?: string;
  /**
   * `{ phones: false }` keeps phone numbers readable — only for values that are public business
   * data (the store's own payment number in a settings change). Secrets are always redacted.
   */
  redact?: { phones?: boolean };
};

// ───────────────────────────────────────────────────────────────── redaction

const REDACTED = "[redacted]";
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 200;
const MAX_STRING_LENGTH = 4000;
const MAX_SNAPSHOT_BYTES = 64 * 1024;

/** Keys whose values are secrets, whatever they contain. Compared on the key in lower case without separators. */
function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    /password|passwd|secret|token|recoverycode|apikey|authorization|cookie|cvv|cvc|cardnumber|privatekey|datakey/.test(k) ||
    k.endsWith("hash") ||
    k.endsWith("enc") ||
    ["otp", "otpcode", "devcode", "verificationcode", "pin", "pan"].includes(k)
  );
}

/** Keys whose values are identifiers that only look like phone numbers. */
function isIdentifierKey(key: string): boolean {
  return /serial|sku|barcode|imei|tracking|reference|(^|_)ref$|Ref$|(^|_)id$|Id$/.test(key);
}

/** +9647XXXXXXXXX, 009647…, 9647… or 07XXXXXXXXX, with optional spaces or dashes; never part of a longer number. */
const PHONE_CANDIDATE = /(?<![\d+])(?:(?:\+|00)?964[\s-]?|0)7[3-9]\d(?:[\s-]?\d){7}(?!\d)/g;

/** Replaces every Iraqi mobile number in a text with its masked form ("0771 ••• ••52"). */
export function maskPhonesIn(text: string): string {
  // Same length as `text`: each Arabic-Indic or Persian digit becomes one Latin digit.
  const latin = toLatinDigits(text);
  let out = "";
  let last = 0;
  for (const match of latin.matchAll(PHONE_CANDIDATE)) {
    const e164 = normalizeIraqPhone(match[0]);
    if (!e164) continue;
    out += text.slice(last, match.index) + maskPhone(e164);
    last = match.index + match[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

function redactValue(value: unknown, depth: number, maskPhones: boolean): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string": {
      const text = maskPhones ? maskPhonesIn(value) : value;
      return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}… [+${text.length - MAX_STRING_LENGTH} chars]` : text;
    }
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return undefined;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  if (depth >= MAX_DEPTH) return "[nested too deep]";
  if (value instanceof Map) return redactValue(Object.fromEntries(value), depth, maskPhones);
  if (value instanceof Set) return redactValue([...value], depth, maskPhones);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, maskPhones) ?? null);
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
    if (isSecretKey(key)) {
      out[key] = item === null ? null : REDACTED;
      continue;
    }
    out[key] = redactValue(item, depth + 1, maskPhones && !isIdentifierKey(key));
  }
  return out;
}

/**
 * The form in which a snapshot is stored: secrets replaced by "[redacted]" (by key name — password,
 * token, secret, *hash, *enc, otp, recovery codes, api keys, card data), Iraqi phone numbers masked,
 * oversized values shortened. Exported so exports and logs can apply the same rule.
 */
export function redactForAudit(value: unknown, options: { phones?: boolean } = {}): unknown {
  if (value === undefined) return null;
  const redacted = redactValue(value, 0, options.phones !== false);
  const size = JSON.stringify(redacted)?.length ?? 0;
  if (size > MAX_SNAPSHOT_BYTES) {
    const keys = redacted && typeof redacted === "object" && !Array.isArray(redacted) ? Object.keys(redacted).slice(0, 50) : undefined;
    return { _truncated: true, size, ...(keys ? { keys } : {}) };
  }
  return redacted;
}

// ───────────────────────────────────────────────────────────────── writing

const clip = (value: string | null | undefined, max: number): string | null => (value == null || value === "" ? null : value.length > max ? value.slice(0, max) : value);

/** The row an event becomes. Exported for tests and for services that need the id up front. */
export function auditRow(event: AuditEventInput): NewAuditEvent {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(event.action)) throw new Error(`Audit action must look like "module.resource.verb", got "${event.action}"`);
  if (!Number.isSafeInteger(event.at)) throw new Error("Audit event needs `at` (epoch ms)");
  const { actorKind, actorId } = actorRef(event.actor);
  const origin: RequestOrigin = event.actor.kind === "system" ? {} : event.actor;
  const label = event.actorLabel ?? (event.actor.kind === "employee" || event.actor.kind === "customer" ? event.actor.label : event.actor.kind === "system" ? event.actor.job : null);
  const maskPhones = event.redact?.phones !== false;
  return {
    id: event.id ?? newId("aud"),
    at: event.at,
    actorKind,
    actorId,
    actorLabel: clip(label, 200),
    action: event.action,
    entityType: clip(event.entityType, 100),
    entityId: clip(event.entityId, 200),
    summary: clip(event.summary == null ? null : maskPhones ? maskPhonesIn(event.summary) : event.summary, 500),
    before: event.before === undefined ? null : redactForAudit(event.before, event.redact),
    after: event.after === undefined ? null : redactForAudit(event.after, event.redact),
    reason: clip(event.reason == null ? null : maskPhones ? maskPhonesIn(event.reason) : event.reason, 1000),
    ip: clip(event.ip ?? origin.ip, 64),
    requestId: clip(event.requestId ?? origin.requestId, 100),
  };
}

/** One batch item that records the event. Put it in the same `db.batch([...])` as the change. */
export function auditStatement(db: Db, event: AuditEventInput): BatchStatement {
  return db.insert(auditEvents).values(auditRow(event));
}

/** Records a stand-alone event and returns its id. */
export async function audit(db: Db, event: AuditEventInput): Promise<string> {
  const row = auditRow(event);
  await db.insert(auditEvents).values(row);
  return row.id;
}

// ───────────────────────────────────────────────────────────────── hash chain

const CHAIN_DOMAIN = "tamtam.audit.v1";
const EVENT_PAGE = 250;

/**
 * The exact stored columns of an event, in a fixed order. `before` / `after` are read as the raw
 * JSON TEXT in the database, so the hash does not depend on how any JSON library orders keys.
 */
const EVENT_COLUMNS = "seq, id, at, actor_kind, actor_id, actor_label, action, entity_type, entity_id, summary, before, after, reason, ip, request_id";

type ChainHash = { hash: string; count: number; lastSeq: number };

/**
 * hash = H( fold( H(domain | prevHash | fromSeq), events ) | lastSeq | count ), where each event
 * folds in as H(acc + "\n" + JSON([its columns])). Covers content, order and number of the events
 * with fromSeq ≤ seq ≤ toSeq, and links to the previous seal.
 */
async function hashRange(db: Db, prevHash: string | null, fromSeq: number, toSeq: number, limit?: number): Promise<ChainHash> {
  let acc = await sha256Hex(`${CHAIN_DOMAIN}|${prevHash ?? ""}|${fromSeq}`);
  let count = 0;
  let lastSeq = fromSeq - 1;
  for (;;) {
    const page = limit === undefined ? EVENT_PAGE : Math.min(EVENT_PAGE, limit - count);
    if (page <= 0) break;
    const rows = await db.$client
      .prepare(`SELECT ${EVENT_COLUMNS} FROM audit_events WHERE seq > ?1 AND seq <= ?2 ORDER BY seq LIMIT ?3`)
      .bind(lastSeq, toSeq, page)
      .raw<unknown[]>();
    for (const row of rows) {
      acc = await sha256Hex(`${acc}\n${JSON.stringify(row)}`);
      lastSeq = Number(row[0]);
      count++;
    }
    if (rows.length < page) break;
  }
  return { hash: await sha256Hex(`${acc}|${lastSeq}|${count}`), count, lastSeq };
}

export type SealAuditResult = {
  /** Seals written by this call. */
  seals: number;
  /** Events they cover. */
  events: number;
  /** Highest sealed seq afterwards (0 when nothing has ever been sealed). */
  lastSealedSeq: number;
  /** Hash of the newest seal: log it outside the database to anchor the chain. Null when there is no seal. */
  headHash: string | null;
  /** True when unsealed events remain (call again). */
  remaining: boolean;
};

/**
 * Seals every event that is not sealed yet, in consecutive seals of at most `maxEvents` events.
 * Safe to run concurrently and repeatedly: a range is sealed once (UNIQUE from_seq), an empty log
 * or a fully sealed log writes nothing.
 */
export async function sealAudit(db: Db, now: number, options: { maxEvents?: number; maxSeals?: number } = {}): Promise<SealAuditResult> {
  const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 500));
  const maxSeals = Math.max(1, Math.floor(options.maxSeals ?? 10));
  let written = 0;
  let events = 0;

  let head = await db.select({ toSeq: auditSeals.toSeq, hash: auditSeals.hash }).from(auditSeals).orderBy(desc(auditSeals.toSeq)).limit(1).get();
  for (let round = 0; round < maxSeals; round++) {
    const fromSeq = (head?.toSeq ?? 0) + 1;
    const prevHash = head?.hash ?? null;
    const range = await hashRange(db, prevHash, fromSeq, Number.MAX_SAFE_INTEGER, maxEvents);
    if (range.count === 0) break;
    try {
      await db.insert(auditSeals).values({ id: newId("seal"), fromSeq, toSeq: range.lastSeq, hash: range.hash, prevHash, createdAt: now });
    } catch (error) {
      // Another run sealed this range first: continue from whatever is there now.
      if (!isUniqueViolation(error)) throw error;
      head = await db.select({ toSeq: auditSeals.toSeq, hash: auditSeals.hash }).from(auditSeals).orderBy(desc(auditSeals.toSeq)).limit(1).get();
      continue;
    }
    written++;
    events += range.count;
    head = { toSeq: range.lastSeq, hash: range.hash };
  }

  const lastSealedSeq = head?.toSeq ?? 0;
  const unsealed = await db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(gt(auditEvents.seq, lastSealedSeq)).get();
  return { seals: written, events, lastSealedSeq, headHash: head?.hash ?? null, remaining: (unsealed?.n ?? 0) > 0 };
}

export type AuditChainProblem = {
  /**
   * seal_gap   seals do not tile the log (one is missing, or two overlap)
   * seal_link  a seal does not point at the hash of the seal before it
   * seal_hash  the events in the seal's range are not the events that were sealed (edited, removed or inserted)
   */
  kind: "seal_gap" | "seal_link" | "seal_hash";
  sealId: string;
  fromSeq: number;
  toSeq: number;
  detail: string;
};

export type AuditChainReport = {
  /** True when every checked seal still matches its events and its predecessor. */
  ok: boolean;
  sealsChecked: number;
  eventsChecked: number;
  /** Events newer than the last seal: not protected by the chain yet. */
  unsealedEvents: number;
  lastSealedSeq: number;
  /** Hash of the newest seal — compare it with the value logged when it was written. */
  headHash: string | null;
  problems: AuditChainProblem[];
  /** Set when `maxSeals` stopped the check early: pass it as `afterToSeq` to continue. */
  nextAfterToSeq: number | null;
};

/**
 * Recomputes the hash chain and reports every seal that no longer matches.
 * Checks the whole log by default; for a long log, verify in slices with `maxSeals` and the
 * returned `nextAfterToSeq` (each seal costs one or two queries).
 */
export async function verifyAuditChain(db: Db, options: { afterToSeq?: number; maxSeals?: number } = {}): Promise<AuditChainReport> {
  const problems: AuditChainProblem[] = [];
  const maxSeals = options.maxSeals === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(options.maxSeals));
  /** Highest seq covered by the seals accepted so far, and the hash the next seal must link to. */
  let prevTo = 0;
  let prevHash: string | null = null;
  /** from_seq of the last seal read: keyset pagination, so every seal is visited exactly once. */
  let cursor = 0;
  let sealsChecked = 0;
  let eventsChecked = 0;
  let stoppedEarly = false;

  const afterToSeq = Math.max(0, Math.floor(options.afterToSeq ?? 0));
  if (afterToSeq > 0) {
    // Continue after an already verified seal: it is the anchor the next one must link to.
    const anchor = await db.select({ fromSeq: auditSeals.fromSeq, hash: auditSeals.hash }).from(auditSeals).where(eq(auditSeals.toSeq, afterToSeq)).get();
    if (!anchor) throw new Error(`verifyAuditChain: no seal ends at seq ${afterToSeq}`);
    prevTo = afterToSeq;
    prevHash = anchor.hash;
    cursor = anchor.fromSeq;
  }

  outer: for (;;) {
    const seals = await db.select().from(auditSeals).where(gt(auditSeals.fromSeq, cursor)).orderBy(asc(auditSeals.fromSeq)).limit(100);
    if (seals.length === 0) break;
    for (const seal of seals) {
      if (sealsChecked >= maxSeals) {
        stoppedEarly = true;
        break outer;
      }
      cursor = seal.fromSeq;
      const at = { sealId: seal.id, fromSeq: seal.fromSeq, toSeq: seal.toSeq };
      if (seal.fromSeq !== prevTo + 1 || seal.toSeq < seal.fromSeq) {
        problems.push({ kind: "seal_gap", ...at, detail: `expected a seal starting at seq ${prevTo + 1}` });
      }
      if ((seal.prevHash ?? null) !== prevHash) {
        problems.push({ kind: "seal_link", ...at, detail: "prev_hash is not the hash of the previous seal" });
      }
      const range = await hashRange(db, seal.prevHash ?? null, seal.fromSeq, seal.toSeq);
      if (range.hash !== seal.hash) {
        problems.push({ kind: "seal_hash", ...at, detail: `events ${seal.fromSeq}–${seal.toSeq} do not match the seal (${range.count} found)` });
      }
      sealsChecked++;
      eventsChecked += range.count;
      if (seal.toSeq > prevTo) {
        prevTo = seal.toSeq;
        prevHash = seal.hash;
      }
    }
  }

  const head = await db.select({ toSeq: auditSeals.toSeq, hash: auditSeals.hash }).from(auditSeals).orderBy(desc(auditSeals.toSeq)).limit(1).get();
  const lastSealedSeq = head?.toSeq ?? 0;
  const unsealed = await db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(gt(auditEvents.seq, lastSealedSeq)).get();
  return {
    ok: problems.length === 0,
    sealsChecked,
    eventsChecked,
    unsealedEvents: unsealed?.n ?? 0,
    lastSealedSeq,
    headHash: head?.hash ?? null,
    problems,
    nextAfterToSeq: stoppedEarly ? prevTo : null,
  };
}
