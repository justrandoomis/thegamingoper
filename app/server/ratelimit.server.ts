/**
 * Rate limiting — fixed-window counters in the `rate_limits` table (D1, not KV: KV's free tier
 * allows very few writes). One statement per check, atomic, and a blocked caller costs no write.
 *
 *   const key = await limitKey("signin", "phone", phoneE164);          // identifiers are hashed, never stored raw
 *   const verdict = await rateLimit(db, key, RATE_LIMITS.signIn, ctx.now);
 *   if (!verdict.ok) throw rateLimited(verdict.retryAfterSec);
 *
 *   await enforceRateLimit(db, await limitKey("upload", "ip", ctx.ip), RATE_LIMITS.upload, ctx.now);   // same, throwing
 *
 * This is the application's own limit, per phone / account / IP (an IPv6 caller: its /64, and its /48 with
 * WIDE_NETWORK_FACTOR × the limit). Cloudflare's edge rate limiting (docs/SECURITY.md) sits in front of it and absorbs
 * floods before they reach the Worker.
 *
 * Windows are aligned to the clock (a 15-minute window runs :00–:15, :15–:30, …), so a caller can
 * spend the limit at the end of one window and again at the start of the next. Limits below are
 * chosen with that in mind.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { sha256Hex } from "~/lib/ids";
import type { Db } from "./db/drizzle.server";
import { rateLimits } from "./db/schema";
import { rateLimited } from "./errors";

export type RateLimitRule = {
  /** Requests allowed per window. */
  limit: number;
  windowSec: number;
};

export type RateLimitResult = {
  ok: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window ends; 0 when the request was allowed. */
  retryAfterSec: number;
};

/** Presets. "Per" says what the key should identify. */
export const RATE_LIMITS = {
  /** Customer sign-in attempts per phone number. */
  signIn: { limit: 8, windowSec: 15 * 60 },
  /** Sign-in attempts per IP, across all accounts. */
  signInIp: { limit: 40, windowSec: 15 * 60 },
  /** New accounts per IP. */
  signUpIp: { limit: 10, windowSec: 60 * 60 },
  /** FAILED admin sign-ins per email before the account is locked for the rest of the window. */
  adminSignInFailures: { limit: 5, windowSec: 15 * 60 },
  /** Admin sign-in attempts per IP. */
  adminSignInIp: { limit: 20, windowSec: 15 * 60 },
  /** Second-factor attempts per employee. */
  mfaVerify: { limit: 6, windowSec: 10 * 60 },
  /** First-run setup attempts per IP. */
  setup: { limit: 5, windowSec: 60 * 60 },
  /** One-time codes requested per phone number. */
  otpRequest: { limit: 3, windowSec: 10 * 60 },
  /** One-time codes requested per IP. */
  otpRequestIp: { limit: 12, windowSec: 60 * 60 },
  /** Guest order lookups (reference + phone) per IP. */
  orderLookup: { limit: 10, windowSec: 15 * 60 },
  /** Guest order lookups per order reference, whoever asks. */
  orderLookupRef: { limit: 10, windowSec: 60 * 60 },
  /** Orders placed per IP or per phone. */
  checkout: { limit: 10, windowSec: 10 * 60 },
  /** Files uploaded per IP or per account. */
  upload: { limit: 20, windowSec: 10 * 60 },
} as const satisfies Record<string, RateLimitRule>;

function windowOf(rule: RateLimitRule, now: number): { start: number; ms: number } {
  if (!Number.isSafeInteger(rule.limit) || rule.limit < 1) throw new Error(`rateLimit: limit must be a positive integer, got ${rule.limit}`);
  if (!Number.isSafeInteger(rule.windowSec) || rule.windowSec < 1) throw new Error(`rateLimit: windowSec must be a positive integer, got ${rule.windowSec}`);
  const ms = rule.windowSec * 1000;
  return { start: Math.floor(now / ms) * ms, ms };
}

const retryAfter = (window: { start: number; ms: number }, now: number) => Math.max(1, Math.ceil((window.start + window.ms - now) / 1000));

/**
 * IPv6 subscribers often hold more than one /64: a home or business line gets a /56 or a /48, and a tunnel broker hands
 * out a /48 for free — 65,536 /64s. So a per-IP key of an IPv6 caller also counts the /48 around it, against
 * WIDE_NETWORK_FACTOR times the rule's limit (security review, second pass): one subscriber can no longer multiply a
 * per-IP limit by more than this factor, while unrelated people sharing a provider's /48 keep a generous budget together.
 */
export const WIDE_NETWORK_FACTOR = 16;
/** Joins the parts of a key that counts more than one thing (an IPv6 caller's /64 and its /48). Never in a key part. */
const KEY_PARTS = "|";

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail as the last two), or null when it is not one. */
function ipv6Groups(value: string): { groups: number[]; embedded: string | null } | null {
  if (!value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // An embedded IPv4 at the end ("::ffff:203.0.113.9", "64:ff9b::1.2.3.4") stands for the last two groups.
  const last = halves.length === 2 ? tail : head;
  let embedded: string | null = null;
  if (last.length > 0 && last[last.length - 1].includes(".")) {
    embedded = last[last.length - 1];
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(embedded)) return null;
    last.splice(last.length - 1, 1, "0", "0");
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return { groups: groups.map((group) => Number.parseInt(group, 16)), embedded };
}

/** ::ffff:a.b.c.d (also written in hex) — an IPv4 address in IPv6 clothing. */
const isIpv4Mapped = (n: readonly number[]) => n.slice(0, 5).every((part) => part === 0) && n[5] === 0xffff;
const normalizedIp = (ip: string) => ip.trim().toLowerCase().replace(/%.*$/, "");

/**
 * Who an IP address is, for counting: an IPv4 address as it is (an IPv4-mapped IPv6 address is its IPv4), an IPv6
 * address by its /64 network. One subscriber — a home line, a phone — gets a whole /64 and may pick any of its 2^64
 * addresses for each request; counted per address, every per-IP limit could be multiplied at will by rotating them
 * (security review 2026-11). Anything that does not parse as an address is returned unchanged. The /48 around an IPv6
 * address is counted as well (ipWideNetwork, WIDE_NETWORK_FACTOR).
 *
 *   ipIdentity("203.0.113.9")                  → "203.0.113.9"
 *   ipIdentity("2001:db8:1:2:ffff:abcd:12:9")  → "2001:db8:1:2::/64"
 *   ipIdentity("::ffff:203.0.113.9")           → "203.0.113.9"
 */
export function ipIdentity(ip: string): string {
  const value = normalizedIp(ip);
  const parsed = ipv6Groups(value);
  if (!parsed) return value;
  const n = parsed.groups;
  if (isIpv4Mapped(n)) return parsed.embedded ?? `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
  return `${n.slice(0, 4).map((part) => part.toString(16)).join(":")}::/64`;
}

/**
 * The /48 network of an IPv6 address — "2001:db8:1::/48" — or null for IPv4, IPv4-mapped and unparsable values: the
 * wider prefix a single subscriber may hold, counted against WIDE_NETWORK_FACTOR × a per-IP limit.
 */
export function ipWideNetwork(ip: string): string | null {
  const parsed = ipv6Groups(normalizedIp(ip));
  if (!parsed || isIpv4Mapped(parsed.groups)) return null;
  return `${parsed.groups.slice(0, 3).map((part) => part.toString(16)).join(":")}::/48`;
}

const hashedKey = async (scope: string, kind: string, who: string) => `${scope}:${kind}:${(await sha256Hex(`${scope}|${kind}|${who}`)).slice(0, 32)}`;

/**
 * A rate-limit key that does not store the identifier itself: `scope:kind:<hash>`.
 * `limitKey("signin", "phone", "+9647…")` → "signin:phone:3f2a…". Returns null when the identifier
 * is missing (no client IP in local development): pass that straight to rateLimit(), which then
 * lets the request through. For kind "ip" the identifier is the address's identity (ipIdentity: IPv6 by its /64); an
 * IPv6 caller's key also names its /48 (`…|scope:ip48:<hash>`), which rateLimit() counts with WIDE_NETWORK_FACTOR
 * times the limit. Treat a key as opaque: pass it to the functions of this module.
 */
export async function limitKey(scope: string, kind: string, identifier: string | null | undefined): Promise<string | null> {
  if (identifier == null || identifier === "") return null;
  const key = await hashedKey(scope, kind, kind === "ip" ? ipIdentity(identifier) : identifier);
  const wide = kind === "ip" ? ipWideNetwork(identifier) : null;
  return wide ? `${key}${KEY_PARTS}${await hashedKey(scope, "ip48", wide)}` : key;
}

/** The counters a key stands for: its own (the rule as given) and, for an IPv6 caller, the /48 (WIDE_NETWORK_FACTOR × the limit). */
function partsOf(key: string, rule: RateLimitRule): { key: string; rule: RateLimitRule }[] {
  const [own, ...wider] = key.split(KEY_PARTS);
  return [{ key: own, rule }, ...wider.map((part) => ({ key: part, rule: { limit: rule.limit * WIDE_NETWORK_FACTOR, windowSec: rule.windowSec } }))];
}

async function countOne(db: Db, key: string, rule: RateLimitRule, now: number): Promise<RateLimitResult> {
  const window = windowOf(rule, now);
  // One atomic upsert. The counter stops at `limit`: once it is reached the UPDATE matches no row,
  // nothing is written and nothing is returned — that empty result IS the "blocked" answer.
  const rows = await db
    .insert(rateLimits)
    .values({ key, windowStart: window.start, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
      setWhere: lt(rateLimits.count, rule.limit),
    })
    .returning({ count: rateLimits.count });
  const count = rows[0]?.count;
  if (count === undefined) return { ok: false, remaining: 0, retryAfterSec: retryAfter(window, now) };
  return { ok: true, remaining: Math.max(0, rule.limit - count), retryAfterSec: 0 };
}

/**
 * Counts one request against `key` and says whether it is allowed.
 * A null key means "nothing to identify the caller by" and is always allowed.
 * An IPv6 caller's key is counted for its /64 first (a blocked /64 costs no further write), then for its /48.
 */
export async function rateLimit(db: Db, key: string | null, rule: RateLimitRule, now: number): Promise<RateLimitResult> {
  windowOf(rule, now);
  if (key === null) return { ok: true, remaining: rule.limit, retryAfterSec: 0 };
  const [own, ...wider] = partsOf(key, rule);
  const verdict = await countOne(db, own.key, own.rule, now);
  if (!verdict.ok) return verdict;
  for (const part of wider) {
    const wide = await countOne(db, part.key, part.rule, now);
    if (!wide.ok) return wide;
  }
  return verdict;
}

/** rateLimit() that throws AppError("rate_limited", 429) with the wait time when the caller is over the limit. */
export async function enforceRateLimit(db: Db, key: string | null, rule: RateLimitRule, now: number): Promise<void> {
  const verdict = await rateLimit(db, key, rule, now);
  if (!verdict.ok) throw rateLimited(verdict.retryAfterSec, key ?? undefined);
}

/** The state of a key WITHOUT counting a request (e.g. "is this account locked?" before checking a password). */
export async function peekRateLimit(db: Db, key: string | null, rule: RateLimitRule, now: number): Promise<RateLimitResult> {
  windowOf(rule, now);
  if (key === null) return { ok: true, remaining: rule.limit, retryAfterSec: 0 };
  let first: RateLimitResult | null = null;
  for (const part of partsOf(key, rule)) {
    const window = windowOf(part.rule, now);
    const row = await db
      .select({ count: rateLimits.count })
      .from(rateLimits)
      .where(and(eq(rateLimits.key, part.key), eq(rateLimits.windowStart, window.start)))
      .get();
    const count = row?.count ?? 0;
    if (count >= part.rule.limit) return { ok: false, remaining: 0, retryAfterSec: retryAfter(window, now) };
    first ??= { ok: true, remaining: part.rule.limit - count, retryAfterSec: 0 };
  }
  return first ?? { ok: true, remaining: rule.limit, retryAfterSec: 0 };
}

/** Forgets a key (e.g. failed sign-ins after a successful one) — every counter it stands for. */
export async function resetRateLimit(db: Db, key: string | null): Promise<void> {
  if (key === null) return;
  const parts = key.split(KEY_PARTS);
  await db.delete(rateLimits).where(parts.length === 1 ? eq(rateLimits.key, key) : inArray(rateLimits.key, parts));
}

/**
 * "First time wins": true exactly once per (key, slot), false for every later call — atomic, so two
 * simultaneous requests cannot both win. Used as the replay guard for one-time values (a TOTP step).
 * `slot` is stored as the window start, so cleanupRateLimits() removes the marker once it is old.
 */
export async function claimOnce(db: Db, key: string, slot: number): Promise<boolean> {
  const rows = await db.insert(rateLimits).values({ key, windowStart: slot, count: 1 }).onConflictDoNothing().returning({ count: rateLimits.count });
  return rows.length === 1;
}

/** Deletes counters whose window started more than `maxAgeSec` ago (default one day). Run it from a daily job. */
export async function cleanupRateLimits(db: Db, now: number, maxAgeSec = 24 * 60 * 60): Promise<number> {
  const result = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, now - maxAgeSec * 1000))
    .run();
  return result.meta.changes;
}

/** Counters still inside their window, newest first — for an admin "who is being limited" view. Keys are hashed. */
export async function activeRateLimits(db: Db, now: number, sinceSec = 60 * 60, limit = 100): Promise<{ key: string; windowStart: number; count: number }[]> {
  return db
    .select({ key: rateLimits.key, windowStart: rateLimits.windowStart, count: rateLimits.count })
    .from(rateLimits)
    .where(gte(rateLimits.windowStart, now - sinceSec * 1000))
    .orderBy(sql`${rateLimits.windowStart} DESC`)
    .limit(limit);
}
