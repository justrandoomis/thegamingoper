/**
 * 21.03 API keys — scoped, expiring keys for the read-only API (api.server.ts), managed with channels.api_key.manage
 * (the owner by default; docs/SECURITY.md §7).
 *
 *   listApiKeys(db, actor, now)                                  never a hash, never a key
 *   createApiKey(db, actor, raw, now) → { keyId, key, prefix, replayed }
 *       the key ("ttk_<8>_<43>", 256 random bits) is returned ONCE; only its SHA-256 is stored. A resubmitted form
 *       names the same key (its id comes from the form's idempotency key) and returns key: null — it cannot be shown
 *       again. Scopes: API_SCOPES only, and only ones the creator holds (scope_not_held, 403); never by an employee
 *       limited to a branch (forbidden "branch": the API reads every branch). Every key expires.
 *   revokeApiKey(db, actor, raw, now) → { changed }              a revoked key never works again
 *   verifyApiKey(db, presented, now) → VerifiedKey | null        the API's check: well-formed, known, not revoked, not
 *       expired, and its creator could still make it — an active account without a branch limit ("suspended"
 *       otherwise); the key's scopes are only those the creator's roles grant NOW (the hierarchy rule, SECURITY §7:
 *       a key never outlives what its creator may hand out — an employee who leaves takes their keys with them)
 *
 * Creating and revoking write an audit event (name, prefix, scopes, expiry — never the key or its hash). Errors:
 * scope_not_held, idempotency_mismatch, invalid (fields), forbidden, not_found. Must not import "cloudflare:workers".
 */
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { randomToken, sha256Hex } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { apiKeys } from "~/server/db/schema";
import { expectChanged, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { WILDCARD_PERMISSION } from "~/server/permissions";
import { IdSchema, IdempotencyKey, Reason, DAY_MS, assertWholeStore, employeeNames, keyedId, wholeNumber } from "./shared.server";
import { API_EXPIRY_CHOICES, API_EXPIRY_DEFAULT, API_KEY_PREFIX, API_RATE_DEFAULT, API_RATE_MAX, API_SCOPES, type ApiKeyState, type ApiScope, type PersonRef } from "./types";

const MANAGE = "channels.api_key.manage";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** "ttk_" + 8 Crockford characters + "_" + 43 URL-safe characters (32 random bytes). */
const KEY_SHAPE = /^ttk_[0-9A-HJKMNP-TV-Z]{8}_[A-Za-z0-9_-]{43}$/;

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  createdBy: PersonRef;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  state: ApiKeyState;
};

export type VerifiedKey = { id: string; name: string; prefix: string; scopes: ReadonlySet<string>; rateLimitPerMin: number };

/** `creatorStands`: the key's creator could still make it (see creatorStandsSql); a key without a creator always does. */
export function apiKeyState(row: { expiresAt: number | null; revokedAt: number | null }, now: number, creatorStands = true): ApiKeyState {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt !== null && row.expiresAt <= now) return "expired";
  if (!creatorStands) return "suspended";
  return "active";
}

/**
 * SQL over `api_keys`: the key's creator could still make it — an active account without a branch limit — or the key
 * has no creator (made by the system). What the scopes are worth is decided per request (creatorGrants).
 */
export const creatorStandsSql = sql`(api_keys.created_by IS NULL OR EXISTS (SELECT 1 FROM employees AS creator WHERE creator.id = api_keys.created_by AND creator.status = 'active' AND creator.branch_id IS NULL))`;

/**
 * What the key's creator may hand out now: null when the account is gone, disabled or limited to a branch (the key
 * stops); else the permissions their roles grant — none while a role requires two-step verification they have not set
 * up (the session would hold none either, auth/admin.server.ts). One query.
 */
async function creatorGrants(db: Db, employeeId: string): Promise<ReadonlySet<string> | null> {
  const rows = await db.all<{ status: string; branchId: string | null; totp: number; permission: string | null; requiresMfa: number | null }>(sql`
    SELECT e.status AS status, e.branch_id AS branchId, e.totp_enabled AS totp, rp.permission AS permission, r.requires_mfa AS requiresMfa
    FROM employees AS e
    LEFT JOIN employee_roles AS er ON er.employee_id = e.id
    LEFT JOIN roles AS r ON r.id = er.role_id
    LEFT JOIN role_permissions AS rp ON rp.role_id = r.id
    WHERE e.id = ${employeeId}`);
  const first = rows[0];
  if (!first || first.status !== "active" || first.branchId) return null;
  if (rows.some((row) => Boolean(row.requiresMfa)) && !first.totp) return new Set();
  return new Set(rows.map((row) => row.permission).filter((permission): permission is string => typeof permission === "string"));
}

function randomPrefix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const byte of bytes) out += CROCKFORD[byte % 32];
  return `${API_KEY_PREFIX}${out}`;
}

export async function listApiKeys(db: Db, actor: Actor, now: number): Promise<{ rows: ApiKeyRow[]; counts: Record<ApiKeyState, number> }> {
  assertCan(actor, MANAGE);
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      rateLimitPerMin: apiKeys.rateLimitPerMin,
      createdBy: apiKeys.createdBy,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      creatorStands: sql<number>`${creatorStandsSql}`,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt))
    .limit(200);
  const names = await employeeNames(db, rows.map((row) => row.createdBy));
  const counts: Record<ApiKeyState, number> = { active: 0, suspended: 0, expired: 0, revoked: 0 };
  const out = rows.map((row): ApiKeyRow => {
    const state = apiKeyState(row, now, Boolean(row.creatorStands));
    counts[state] += 1;
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      rateLimitPerMin: row.rateLimitPerMin ?? API_RATE_DEFAULT,
      createdBy: row.createdBy ? { id: row.createdBy, name: names.get(row.createdBy) ?? row.createdBy } : null,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      state,
    };
  });
  return { rows: out, counts };
}

const CreateApiKeyInput = z.object({
  name: z.string({ error: "required" }).trim().min(2, "required").max(80, "too_long"),
  scopes: z.array(z.string()).max(API_SCOPES.length * 2).default([]),
  expiresInDays: z.preprocess(
    (value) => wholeNumber(value) ?? API_EXPIRY_DEFAULT,
    z.number({ error: "expiry_invalid" }).refine((value) => (API_EXPIRY_CHOICES as readonly number[]).includes(value), "expiry_invalid"),
  ),
  rateLimitPerMin: z.preprocess((value) => wholeNumber(value) ?? API_RATE_DEFAULT, z.number({ error: "rate_invalid" }).int("rate_invalid").min(1, "rate_invalid").max(API_RATE_MAX, "rate_invalid")),
  reason: Reason,
  idempotencyKey: IdempotencyKey,
});

const RevokeInput = z.object({ keyId: IdSchema, reason: Reason });

export async function createApiKey(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ keyId: string; key: string | null; prefix: string; replayed: boolean }> {
  assertCan(actor, MANAGE);
  // the API reads every branch: a branch-limited employee would hand out more than they may see
  assertWholeStore(actor);
  const parsed = CreateApiKeyInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error));
  const input = parsed.data;
  const scopes = [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (scopes.length === 0) throw invalid({ scopes: "scope_required" });
  if (!scopes.every((scope) => (API_SCOPES as readonly string[]).includes(scope))) throw invalid({ scopes: "scope_unknown" });
  // nobody hands a key more than they hold themselves (docs/SECURITY.md §7, the hierarchy rule)
  const notHeld = scopes.filter((scope) => !can(actor, scope as ApiScope));
  if (notHeld.length) throw new AppError("scope_not_held", 403, { detail: notHeld.join(",") });

  const keyId = await keyedId("apk", actor, input.idempotencyKey);
  const existing = await db.select({ name: apiKeys.name, prefix: apiKeys.prefix }).from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (existing) {
    if (existing.name !== input.name) throw new AppError("idempotency_mismatch", 409);
    return { keyId, key: null, prefix: existing.prefix, replayed: true };
  }
  const prefix = randomPrefix();
  const key = `${prefix}_${randomToken(32)}`;
  const keyHash = await sha256Hex(key);
  const expiresAt = now + input.expiresInDays * DAY_MS;
  try {
    await runBatch(db, [
      db.insert(apiKeys).values({ id: keyId, name: input.name, keyHash, prefix, scopes, rateLimitPerMin: input.rateLimitPerMin, createdBy: actor.kind === "employee" ? actor.id : null, createdAt: now, expiresAt }),
      auditStatement(db, {
        actor,
        action: "channels.api_key.create",
        entityType: "api_key",
        entityId: keyId,
        after: { name: input.name, prefix, scopes, rateLimitPerMin: input.rateLimitPerMin, expiresAt },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "api_keys.id")) return { keyId, key: null, prefix, replayed: true };
    throw error;
  }
  return { keyId, key, prefix, replayed: false };
}

export async function revokeApiKey(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  const parsed = RevokeInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error));
  const input = parsed.data;
  const row = await db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.id, input.keyId)).get();
  if (!row) throw notFound("api_key");
  if (row.revokedAt !== null) return { changed: false };
  try {
    await runBatch(db, [
      db
        .update(apiKeys)
        .set({ revokedAt: now })
        .where(and(eq(apiKeys.id, row.id), isNull(apiKeys.revokedAt))),
      expectChanged(db, 1, { code: "API_KEY_REVOKED", detail: row.id }),
      auditStatement(db, { actor, action: "channels.api_key.revoke", entityType: "api_key", entityId: row.id, before: { name: row.name, prefix: row.prefix }, after: { revokedAt: now }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    // revoked by someone else a moment ago: the result is the same
    if (mapDbError(error)?.code === "API_KEY_REVOKED") return { changed: false };
    throw error;
  }
  return { changed: true };
}

/**
 * The API's check of a presented key. Anything malformed, unknown, revoked, expired or suspended (its creator's account
 * disabled or limited to a branch) is null (one answer). The scopes it carries are those its creator still holds.
 */
export async function verifyApiKey(db: Db, presented: string, now: number): Promise<VerifiedKey | null> {
  if (!KEY_SHAPE.test(presented)) return null;
  const keyHash = await sha256Hex(presented);
  const row = await db
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, rateLimitPerMin: apiKeys.rateLimitPerMin, expiresAt: apiKeys.expiresAt, revokedAt: apiKeys.revokedAt, lastUsedAt: apiKeys.lastUsedAt, createdBy: apiKeys.createdBy })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .get();
  if (!row || apiKeyState(row, now) !== "active") return null;
  // the prefix is part of the key: a hash collision with another key's prefix is not a match
  if (!presented.startsWith(`${row.prefix}_`)) return null;
  // the hierarchy rule over time: a key never carries more than its creator may hand out today
  const held = row.createdBy ? await creatorGrants(db, row.createdBy) : null;
  if (row.createdBy && held === null) return null;
  const stillHeld = (scope: string) => held === null || held.has(scope) || held.has(WILDCARD_PERMISSION);
  // "last used" moves at most once a minute (one write, not one per request)
  if (row.lastUsedAt === null || row.lastUsedAt < now - 60_000) {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(and(eq(apiKeys.id, row.id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, now - 60_000))));
  }
  const scopes = new Set((Array.isArray(row.scopes) ? row.scopes : []).filter((scope): scope is string => typeof scope === "string" && (API_SCOPES as readonly string[]).includes(scope) && stillHeld(scope)));
  return { id: row.id, name: row.name, prefix: row.prefix, scopes, rateLimitPerMin: Math.min(API_RATE_MAX, Math.max(1, row.rateLimitPerMin ?? API_RATE_DEFAULT)) };
}

/** Active keys that expire within `days` (the module's home: replace them in time). Suspended keys are not active. */
export async function keysExpiringSoon(db: Db, now: number, days = 14): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM api_keys WHERE revoked_at IS NULL AND expires_at > ${now} AND expires_at <= ${now + days * DAY_MS} AND ${creatorStandsSql}`);
  return Number(rows[0]?.n ?? 0);
}

/** Keys that work: not revoked, not expired, not suspended — what the list counts as active. */
export async function activeKeyCount(db: Db, now: number): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${now}) AND ${creatorStandsSql}`);
  return Number(rows[0]?.n ?? 0);
}
