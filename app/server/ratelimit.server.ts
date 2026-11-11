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
 * This is the application's own limit, per phone / account / IP. Cloudflare's edge rate limiting
 * (docs/SECURITY.md) sits in front of it and absorbs floods before they reach the Worker.
 *
 * Windows are aligned to the clock (a 15-minute window runs :00–:15, :15–:30, …), so a caller can
 * spend the limit at the end of one window and again at the start of the next. Limits below are
 * chosen with that in mind.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
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
 * A rate-limit key that does not store the identifier itself: `scope:kind:<hash>`.
 * `limitKey("signin", "phone", "+9647…")` → "signin:phone:3f2a…". Returns null when the identifier
 * is missing (no client IP in local development): pass that straight to rateLimit(), which then
 * lets the request through.
 */
export async function limitKey(scope: string, kind: string, identifier: string | null | undefined): Promise<string | null> {
  if (identifier == null || identifier === "") return null;
  return `${scope}:${kind}:${(await sha256Hex(`${scope}|${kind}|${identifier}`)).slice(0, 32)}`;
}

/**
 * Counts one request against `key` and says whether it is allowed.
 * A null key means "nothing to identify the caller by" and is always allowed.
 */
export async function rateLimit(db: Db, key: string | null, rule: RateLimitRule, now: number): Promise<RateLimitResult> {
  const window = windowOf(rule, now);
  if (key === null) return { ok: true, remaining: rule.limit, retryAfterSec: 0 };
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

/** rateLimit() that throws AppError("rate_limited", 429) with the wait time when the caller is over the limit. */
export async function enforceRateLimit(db: Db, key: string | null, rule: RateLimitRule, now: number): Promise<void> {
  const verdict = await rateLimit(db, key, rule, now);
  if (!verdict.ok) throw rateLimited(verdict.retryAfterSec, key ?? undefined);
}

/** The state of a key WITHOUT counting a request (e.g. "is this account locked?" before checking a password). */
export async function peekRateLimit(db: Db, key: string | null, rule: RateLimitRule, now: number): Promise<RateLimitResult> {
  const window = windowOf(rule, now);
  if (key === null) return { ok: true, remaining: rule.limit, retryAfterSec: 0 };
  const row = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, window.start)))
    .get();
  const count = row?.count ?? 0;
  if (count >= rule.limit) return { ok: false, remaining: 0, retryAfterSec: retryAfter(window, now) };
  return { ok: true, remaining: rule.limit - count, retryAfterSec: 0 };
}

/** Forgets a key (e.g. failed sign-ins after a successful one). */
export async function resetRateLimit(db: Db, key: string | null): Promise<void> {
  if (key === null) return;
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
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
