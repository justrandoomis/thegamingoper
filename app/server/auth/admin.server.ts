/**
 * Employee authentication for the admin: email + password, then a TOTP code when the employee has
 * two-step verification on; the session behind the `tt_adm` cookie; and the first-owner bootstrap.
 *
 *   // every admin loader and action
 *   const { employee, actor } = await requireEmployee(ctx, db, "orders.payment.verify");
 *   await verifyPayment(db, actor, input, ctx.now);          // services check again with assertCan
 *
 *   // /admin/login action
 *   const result = await signInEmployee(ctx, db, { email, password });
 *   if (result.status === "mfa_required") …show the code field…   // then verifyEmployeeMfa(ctx, db, { code }, env)
 *
 * Argument order: functions that read or set the session cookie take `(ctx, db, …)`; the others
 * take `db` first. Functions that need a secret take it as a parameter — pass `env` from
 * "cloudflare:workers" (this module does not import it).
 *
 * What a session is
 *   · a random token in the httpOnly, SameSite=Strict cookie `tt_adm`, scoped to Path=/admin;
 *     only its SHA-256 is stored (`employee_sessions.id_hash`)
 *   · valid for 12 hours, and only while used at least every 2 hours
 *   · checked against the database on every request: revoking the row, or disabling the employee,
 *     takes effect on their very next click
 *   · half-open after the password when two-step verification is on: it can only be used to submit
 *     the code, for 10 minutes; the token is replaced when the code is accepted
 *
 * Lockout: 5 failed passwords for one email lock that email until the 15-minute window ends
 * (the correct password is refused too). 6 wrong codes end the half-open session.
 */
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { data, redirectDocument } from "react-router";
import { z } from "zod";
import { newId, randomToken, sha256Hex, timingSafeEqual } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { assertCan, can, systemActor, type Actor, type EmployeeActor } from "../actor";
import { auditStatement } from "../audit.server";
import { TOTP_DEFAULTS, decryptSecret, encryptSecret, findRecoveryCode, generateRecoveryCodes, generateTotpSecret, hashPassword, hashRecoveryCode, needsRehash, otpauthUri, verifyPassword, verifyTotp } from "../crypto.server";
import type { BatchStatement, Db } from "../db/drizzle.server";
import { employeeRoles, employeeSessions, employees, rolePermissions, roles } from "../db/schema";
import { expectChanged, expectThat, isDbError, runBatch } from "../db/tx.server";
import { AppError, conflict, invalid, notFound, rateLimited, unauthorized } from "../errors";
import { roleId, type Permission } from "../permissions";
import { RATE_LIMITS, claimOnce, enforceRateLimit, limitKey, peekRateLimit, rateLimit, resetRateLimit } from "../ratelimit.server";
import { EMPLOYEE_PASSWORD_MIN, authEventStatement, originOf, passwordField, readSessionToken, safeNextPath, sessionCookie, sessionIdHash, type AuthCtx, type AuthSecrets, type SessionSummary } from "./common.server";
import { existingDefaultRoles, seedRolesStatements } from "./seed-roles";

export { safeNextPath } from "./common.server";
export type { AuthCtx, AuthSecrets, SessionSummary } from "./common.server";

export const ADMIN_COOKIE = "tt_adm";
export const ADMIN_COOKIE_PATH = "/admin";
export const ADMIN_LOGIN_PATH = "/admin/login";
export const ADMIN_SESSION_HOURS = 12;
export const ADMIN_IDLE_HOURS = 2;

/**
 * The cookie is set for two paths. React Router loads the data of the `/admin` index route from
 * `/admin.data`, and browsers match cookie paths by whole segments: `/admin.data` is not "under"
 * `/admin`, so a cookie for Path=/admin alone would be missing on that one request and the admin
 * home would bounce to the sign-in page on every client-side visit.
 */
const ADMIN_COOKIE_PATHS = [ADMIN_COOKIE_PATH, `${ADMIN_COOKIE_PATH}.data`] as const;

const SESSION_MS = ADMIN_SESSION_HOURS * 60 * 60 * 1000;
const IDLE_MS = ADMIN_IDLE_HOURS * 60 * 60 * 1000;
const PENDING_MFA_MS = 10 * 60 * 1000;
/** `last_seen_at` is written at most this often. */
const TOUCH_AFTER_MS = 5 * 60 * 1000;
const TOTP_PERIOD_MS = TOTP_DEFAULTS.periodSec * 1000;

export type EmployeeProfile = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  jobTitle: string | null;
  locale: Locale;
  /** Branch the employee is limited to; null = all branches. */
  branchId: string | null;
  totpEnabled: boolean;
  passwordChangedAt: number | null;
};

export type EmployeeSession = {
  employee: EmployeeProfile;
  /** Pass to services. Holds the permissions of all the employee's roles and the request's origin. */
  actor: EmployeeActor & { permissions: ReadonlySet<string> };
  /** Keys of the employee's roles ("owner", "cashier", …). */
  roles: string[];
  session: { id: string; createdAt: number; expiresAt: number; mfaOk: boolean };
};

// ───────────────────────────────────────────────────────────────── cookies

function setAdminCookies(ctx: AuthCtx, token: string, maxAgeSec: number): void {
  for (const path of ADMIN_COOKIE_PATHS) ctx.setCookie(sessionCookie(ctx, ADMIN_COOKIE, token, { maxAgeSec, sameSite: "Strict", path }));
}

const clearAdminCookies = (ctx: AuthCtx) => setAdminCookies(ctx, "", 0);

// ───────────────────────────────────────────────────────────────── session lookup

function sessionQuery(db: Db, idHash: string) {
  return db
    .select({
      idHash: employeeSessions.idHash,
      mfaOk: employeeSessions.mfaOk,
      createdAt: employeeSessions.createdAt,
      lastSeenAt: employeeSessions.lastSeenAt,
      expiresAt: employeeSessions.expiresAt,
      revokedAt: employeeSessions.revokedAt,
      employeeId: employees.id,
      email: employees.email,
      name: employees.name,
      phone: employees.phone,
      jobTitle: employees.jobTitle,
      locale: employees.locale,
      branchId: employees.branchId,
      status: employees.status,
      totpEnabled: employees.totpEnabled,
      passwordChangedAt: employees.passwordChangedAt,
    })
    .from(employeeSessions)
    .innerJoin(employees, eq(employees.id, employeeSessions.employeeId))
    .where(eq(employeeSessions.idHash, idHash))
    .limit(1);
}

/** Roles and their permissions for the employee behind a session. One row per (role, permission). */
function grantsQuery(db: Db, idHash: string) {
  return db
    .select({ role: roles.key, permission: rolePermissions.permission })
    .from(employeeSessions)
    .innerJoin(employeeRoles, eq(employeeRoles.employeeId, employeeSessions.employeeId))
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(eq(employeeSessions.idHash, idHash));
}

type SessionRow = Awaited<ReturnType<typeof sessionQuery>>[number];
type Loaded = { state: "none" } | { state: "pending_mfa"; row: SessionRow } | { state: "active"; session: EmployeeSession };

const NONE: Loaded = { state: "none" };
/** One lookup per request (keyed by the request context object). */
const lookups = new WeakMap<object, Promise<Loaded>>();

async function loadByHash(ctx: AuthCtx, db: Db, idHash: string): Promise<Loaded> {
  // One round trip: the session with its employee, and that employee's grants.
  const [sessions, grants] = await db.batch([sessionQuery(db, idHash), grantsQuery(db, idHash)]);
  const row = sessions[0];
  const dead = !row || row.revokedAt !== null || row.expiresAt <= ctx.now || ctx.now - row.lastSeenAt > IDLE_MS;
  // A disabled employee is locked out on the next request, whatever their sessions say.
  if (dead || row.status !== "active") return NONE;
  if (row.totpEnabled && !row.mfaOk) return { state: "pending_mfa", row };

  if (ctx.now - row.lastSeenAt > TOUCH_AFTER_MS) {
    await db
      .update(employeeSessions)
      .set({ lastSeenAt: ctx.now })
      .where(and(eq(employeeSessions.idHash, idHash), isNull(employeeSessions.revokedAt)));
  }

  const permissions = new Set<string>();
  const roleKeys = new Set<string>();
  for (const grant of grants) {
    roleKeys.add(grant.role);
    if (grant.permission) permissions.add(grant.permission);
  }
  return {
    state: "active",
    session: {
      employee: {
        id: row.employeeId,
        email: row.email,
        name: row.name,
        phone: row.phone,
        jobTitle: row.jobTitle,
        locale: row.locale,
        branchId: row.branchId,
        totpEnabled: row.totpEnabled,
        passwordChangedAt: row.passwordChangedAt,
      },
      actor: { kind: "employee", id: row.employeeId, permissions, branchId: row.branchId, label: row.name, ...originOf(ctx) },
      roles: [...roleKeys],
      session: { id: row.idHash, createdAt: row.createdAt, expiresAt: row.expiresAt, mfaOk: row.mfaOk },
    },
  };
}

async function loadFromCookie(ctx: AuthCtx, db: Db): Promise<Loaded> {
  const token = readSessionToken(ctx, ADMIN_COOKIE);
  if (!token) return NONE;
  const loaded = await loadByHash(ctx, db, await sessionIdHash(token));
  // A cookie that no longer opens anything is removed, so it is not looked up again.
  if (loaded.state === "none") clearAdminCookies(ctx);
  return loaded;
}

function load(ctx: AuthCtx, db: Db): Promise<Loaded> {
  let pending = lookups.get(ctx);
  if (!pending) {
    pending = loadFromCookie(ctx, db);
    lookups.set(ctx, pending);
  }
  return pending;
}

/** The signed-in employee of this request (fully signed in, second step included), or null. */
export async function getEmployee(ctx: AuthCtx, db: Db): Promise<EmployeeSession | null> {
  const loaded = await load(ctx, db);
  return loaded.state === "active" ? loaded.session : null;
}

/** When the password was accepted and the code is still owed: who is signing in. Null otherwise. */
export async function getPendingMfa(ctx: AuthCtx, db: Db): Promise<{ employeeId: string; email: string; expiresAt: number } | null> {
  const loaded = await load(ctx, db);
  return loaded.state === "pending_mfa" ? { employeeId: loaded.row.employeeId, email: loaded.row.email, expiresAt: loaded.row.expiresAt } : null;
}

/**
 * The signed-in employee and their actor — for every admin loader and action.
 *   · nobody signed in (or the second step is still owed) → document redirect to /admin/login
 *     (`redirectDocument`: the sign-in page sits behind a Cloudflare challenge a data fetch cannot pass)
 *   · signed in without `permission` → a 403 response (rendered by the error boundary)
 * `next` is the admin path to return to after signing in.
 */
export async function requireEmployee(ctx: AuthCtx, db: Db, permission?: Permission, options: { next?: string | null } = {}): Promise<EmployeeSession> {
  const session = await getEmployee(ctx, db);
  if (!session) {
    const next = options.next ? safeNextPath(options.next, "", ADMIN_COOKIE_PATH) : "";
    throw redirectDocument(next ? `${ADMIN_LOGIN_PATH}?next=${encodeURIComponent(next)}` : ADMIN_LOGIN_PATH);
  }
  if (permission && !can(session.actor, permission)) throw data({ error: "forbidden", permission }, { status: 403 });
  return session;
}

// ───────────────────────────────────────────────────────────────── sign-in

const SignInInput = z.object({
  email: z.string({ error: "required" }).trim().toLowerCase().min(1, "required").max(200, "email_invalid"),
  password: z.string({ error: "required" }).min(1, "required"),
});

const invalidCredentials = () => new AppError("invalid_credentials", 401, { fields: { password: "invalid_credentials" } });
const mfaInvalid = () => new AppError("mfa_invalid", 401, { fields: { code: "mfa_invalid" } });
const totpContext = (employeeId: string) => `employee:${employeeId}:totp`;

function sessionInsert(db: Db, ctx: AuthCtx, idHash: string, employeeId: string, mfaOk: boolean, expiresAt: number): BatchStatement {
  return db.insert(employeeSessions).values({
    idHash,
    employeeId,
    mfaOk,
    createdAt: ctx.now,
    lastSeenAt: ctx.now,
    expiresAt,
    ip: ctx.ip,
    userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 300) : null,
  });
}

function revokeByHash(db: Db, idHash: string, now: number): BatchStatement {
  return db
    .update(employeeSessions)
    .set({ revokedAt: now })
    .where(and(eq(employeeSessions.idHash, idHash), isNull(employeeSessions.revokedAt)));
}

/**
 * The stored id of whatever session the request's cookie points at, or null. (Returns the id, not a
 * revoke statement: a query builder returned from an async function would be awaited — executed on
 * the spot instead of inside the caller's batch.)
 */
async function cookieSessionId(ctx: AuthCtx): Promise<string | null> {
  const token = readSessionToken(ctx, ADMIN_COOKIE);
  return token ? sessionIdHash(token) : null;
}

export type AdminSignInResult = { status: "signed_in"; session: EmployeeSession } | { status: "mfa_required"; expiresAt: number };

/**
 * Step one: email and password. Throws AppError:
 *   `invalid_credentials` (401)  unknown email, wrong password, no password set, or a disabled account — indistinguishable
 *   `locked_out` (429)           five failures for this email; `retryAfterSec` says how long
 *   `rate_limited` (429)         too many attempts from this address
 */
export async function signInEmployee(ctx: AuthCtx, db: Db, raw: unknown): Promise<AdminSignInResult> {
  const input = SignInInput.parse(raw);
  await enforceRateLimit(db, await limitKey("admin-signin", "ip", ctx.ip), RATE_LIMITS.adminSignInIp, ctx.now);

  const failures = await limitKey("admin-signin-fail", "email", input.email);
  const lock = await peekRateLimit(db, failures, RATE_LIMITS.adminSignInFailures, ctx.now);
  if (!lock.ok) throw new AppError("locked_out", 429, { retryAfterSec: lock.retryAfterSec });

  const employee = await db.select().from(employees).where(eq(employees.email, input.email)).get();
  const passwordOk = await verifyPassword(input.password, employee?.passwordHash);
  if (!employee || !passwordOk || employee.status !== "active") {
    const counted = await rateLimit(db, failures, RATE_LIMITS.adminSignInFailures, ctx.now);
    const reason = !employee ? "unknown_email" : !passwordOk ? "bad_password" : "disabled";
    const about = { subjectKind: "employee" as const, subjectId: employee?.id ?? null, identifier: input.email };
    await runBatch(db, [
      authEventStatement(db, ctx, { ...about, kind: "login", success: false, details: { reason } }),
      ...(counted.remaining === 0 ? [authEventStatement(db, ctx, { ...about, kind: "lockout", success: false, details: { windowSec: RATE_LIMITS.adminSignInFailures.windowSec } })] : []),
    ]);
    throw invalidCredentials();
  }
  await resetRateLimit(db, failures);

  const needsCode = employee.totpEnabled;
  const token = randomToken();
  const idHash = await sessionIdHash(token);
  const expiresAt = ctx.now + (needsCode ? PENDING_MFA_MS : SESSION_MS);
  const changes: Partial<typeof employees.$inferInsert> = {};
  if (!needsCode) changes.lastLoginAt = ctx.now;
  if (needsRehash(employee.passwordHash)) {
    const upgraded = await hashPassword(input.password);
    changes.passwordHash = upgraded.hash;
    changes.passwordIters = upgraded.iterations;
  }
  const previous = await cookieSessionId(ctx);
  await runBatch(db, [
    sessionInsert(db, ctx, idHash, employee.id, false, expiresAt),
    ...(Object.keys(changes).length > 0 ? [db.update(employees).set(changes).where(eq(employees.id, employee.id))] : []),
    authEventStatement(db, ctx, { subjectKind: "employee", subjectId: employee.id, identifier: input.email, kind: "login", success: true, details: { secondStep: needsCode ? "required" : "off" } }),
    ...(previous ? [revokeByHash(db, previous, ctx.now)] : []),
  ]);

  setAdminCookies(ctx, token, SESSION_MS / 1000);
  const loaded = loadByHash(ctx, db, idHash);
  lookups.set(ctx, loaded);
  const state = await loaded;
  if (state.state === "active") return { status: "signed_in", session: state.session };
  if (state.state === "pending_mfa") return { status: "mfa_required", expiresAt };
  throw new Error("The session that was just created could not be loaded");
}

const MfaInput = z.object({ code: z.string({ error: "required" }).trim().min(1, "required").max(40, "mfa_invalid") });

/** Recovery codes are ten letters and digits; authenticator codes are six digits. */
const looksLikeRecoveryCode = (code: string) => /[A-Za-z]/.test(code) || code.replace(/[\s-]/g, "").length > 8;

type SecondFactor = { ok: true; method: "totp" | "recovery"; statements: BatchStatement[]; recoveryCodesLeft: number | null } | { ok: false };

/** Checks an authenticator code or a recovery code for an employee. A code works once. */
async function checkSecondFactor(ctx: AuthCtx, db: Db, employeeId: string, code: string, secrets: Pick<AuthSecrets, "DATA_KEY">): Promise<SecondFactor> {
  const employee = await db
    .select({ totpSecretEnc: employees.totpSecretEnc, recoveryCodes: employees.recoveryCodes })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .get();
  if (!employee) return { ok: false };

  if (looksLikeRecoveryCode(code)) {
    const stored = employee.recoveryCodes ?? [];
    const index = await findRecoveryCode(code, stored);
    if (index === -1) return { ok: false };
    const remaining = stored.filter((_, position) => position !== index);
    return {
      ok: true,
      method: "recovery",
      recoveryCodesLeft: remaining.length,
      // Compare-and-swap on the stored list: the same code submitted twice at once is accepted once.
      statements: [
        db
          .update(employees)
          .set({ recoveryCodes: remaining })
          .where(and(eq(employees.id, employeeId), eq(employees.recoveryCodes, stored))),
        expectChanged(db, 1, { code: "RECOVERY_CODE_USED", detail: employeeId }),
      ],
    };
  }

  if (!employee.totpSecretEnc) return { ok: false };
  const secret = await decryptSecret(employee.totpSecretEnc, secrets.DATA_KEY, totpContext(employeeId));
  const result = await verifyTotp(secret, code, ctx.now);
  if (!result.ok) return { ok: false };
  // Replay guard: each 30-second step can be used once per employee, even inside the ±1 window.
  if (!(await claimOnce(db, `totp:${employeeId}`, result.step * TOTP_PERIOD_MS))) return { ok: false };
  return { ok: true, method: "totp", statements: [], recoveryCodesLeft: null };
}

/**
 * Step two: the authenticator code (or a recovery code). Needs `DATA_KEY` to read the stored secret.
 * On success the half-open session is replaced by a full one with a new token.
 * Throws AppError: `unauthorized` (no password step in progress), `mfa_invalid` (401, fields.code),
 * `rate_limited` (the half-open session is ended: start again with the password).
 */
export async function verifyEmployeeMfa(ctx: AuthCtx, db: Db, raw: unknown, secrets: Pick<AuthSecrets, "DATA_KEY">): Promise<EmployeeSession & { recoveryCodesLeft: number | null }> {
  const input = MfaInput.parse(raw);
  const loaded = await load(ctx, db);
  if (loaded.state !== "pending_mfa") throw unauthorized("no_pending_sign_in");
  const pending = loaded.row;
  const about = { subjectKind: "employee" as const, subjectId: pending.employeeId, identifier: pending.email };

  const attempts = await rateLimit(db, await limitKey("admin-mfa", "employee", pending.employeeId), RATE_LIMITS.mfaVerify, ctx.now);
  if (!attempts.ok) {
    await runBatch(db, [revokeByHash(db, pending.idHash, ctx.now), authEventStatement(db, ctx, { ...about, kind: "lockout", success: false, details: { step: "mfa" } })]);
    clearAdminCookies(ctx);
    lookups.set(ctx, Promise.resolve(NONE));
    throw rateLimited(attempts.retryAfterSec);
  }

  const factor = await checkSecondFactor(ctx, db, pending.employeeId, input.code, secrets);
  if (!factor.ok) {
    await runBatch(db, [authEventStatement(db, ctx, { ...about, kind: "mfa", success: false })]);
    throw mfaInvalid();
  }

  const token = randomToken();
  const idHash = await sessionIdHash(token);
  try {
    await runBatch(db, [
      ...factor.statements,
      sessionInsert(db, ctx, idHash, pending.employeeId, true, ctx.now + SESSION_MS),
      revokeByHash(db, pending.idHash, ctx.now),
      db.update(employees).set({ lastLoginAt: ctx.now }).where(eq(employees.id, pending.employeeId)),
      authEventStatement(db, ctx, { ...about, kind: "mfa", success: true, details: { method: factor.method } }),
    ]);
  } catch (error) {
    if (isDbError(error, "RECOVERY_CODE_USED")) throw mfaInvalid();
    throw error;
  }

  setAdminCookies(ctx, token, SESSION_MS / 1000);
  const reloaded = loadByHash(ctx, db, idHash);
  lookups.set(ctx, reloaded);
  const state = await reloaded;
  if (state.state !== "active") throw new Error("The session that was just created could not be loaded");
  return { ...state.session, recoveryCodesLeft: factor.recoveryCodesLeft };
}

/** Ends this device's admin session and removes the cookie. Safe to call when nobody is signed in. */
export async function signOutEmployee(ctx: AuthCtx, db: Db): Promise<void> {
  const loaded = await load(ctx, db);
  const employeeId = loaded.state === "active" ? loaded.session.employee.id : loaded.state === "pending_mfa" ? loaded.row.employeeId : null;
  const current = await cookieSessionId(ctx);
  if (current) {
    await runBatch(db, [
      revokeByHash(db, current, ctx.now),
      ...(employeeId ? [authEventStatement(db, ctx, { subjectKind: "employee", subjectId: employeeId, kind: "logout", success: true })] : []),
    ]);
  }
  clearAdminCookies(ctx);
  lookups.set(ctx, Promise.resolve(NONE));
}

// ───────────────────────────────────────────────────────────────── two-step verification

async function requireSession(ctx: AuthCtx, db: Db): Promise<EmployeeSession> {
  const session = await getEmployee(ctx, db);
  if (!session) throw unauthorized();
  return session;
}

/**
 * Starts enrolment for the signed-in employee: creates a secret, stores it encrypted (not active
 * yet) and returns it for the authenticator app — `uri` as a QR code, `secret` for typing.
 * Calling it again replaces the pending secret. Throws `mfa_already_enabled` (409) when it is on.
 */
export async function beginTotpEnrollment(ctx: AuthCtx, db: Db, secrets: Pick<AuthSecrets, "DATA_KEY">): Promise<{ secret: string; uri: string }> {
  const { employee } = await requireSession(ctx, db);
  if (employee.totpEnabled) throw conflict("mfa_already_enabled");
  const secret = generateTotpSecret();
  const sealed = await encryptSecret(secret, secrets.DATA_KEY, totpContext(employee.id));
  await db
    .update(employees)
    .set({ totpSecretEnc: sealed, updatedAt: ctx.now })
    .where(and(eq(employees.id, employee.id), eq(employees.totpEnabled, false)));
  return { secret, uri: otpauthUri({ secret, account: employee.email }) };
}

/**
 * Finishes enrolment with a code from the authenticator: turns two-step verification on, signs the
 * employee's other devices out and returns ten recovery codes — the only time they are readable.
 * Throws `mfa_not_pending` (409) or `mfa_invalid` (401, fields.code).
 */
export async function confirmTotpEnrollment(ctx: AuthCtx, db: Db, raw: unknown, secrets: Pick<AuthSecrets, "DATA_KEY">): Promise<{ recoveryCodes: string[] }> {
  const input = MfaInput.parse(raw);
  const current = await requireSession(ctx, db);
  const employeeId = current.employee.id;
  const row = await db.select({ totpSecretEnc: employees.totpSecretEnc, totpEnabled: employees.totpEnabled }).from(employees).where(eq(employees.id, employeeId)).get();
  if (!row?.totpSecretEnc || row.totpEnabled) throw conflict("mfa_not_pending");
  await enforceRateLimit(db, await limitKey("admin-mfa", "employee", employeeId), RATE_LIMITS.mfaVerify, ctx.now);

  const secret = await decryptSecret(row.totpSecretEnc, secrets.DATA_KEY, totpContext(employeeId));
  const result = await verifyTotp(secret, input.code, ctx.now);
  if (!result.ok || !(await claimOnce(db, `totp:${employeeId}`, result.step * TOTP_PERIOD_MS))) {
    await runBatch(db, [authEventStatement(db, ctx, { subjectKind: "employee", subjectId: employeeId, kind: "mfa_enroll", success: false })]);
    throw mfaInvalid();
  }

  const recoveryCodes = generateRecoveryCodes();
  const hashes = await Promise.all(recoveryCodes.map(hashRecoveryCode));
  try {
    await runBatch(db, [
      db
        .update(employees)
        .set({ totpEnabled: true, recoveryCodes: hashes, updatedAt: ctx.now })
        .where(and(eq(employees.id, employeeId), eq(employees.totpEnabled, false))),
      expectChanged(db, 1, { code: "MFA_NOT_PENDING", detail: employeeId }),
      // This device just proved it holds the authenticator; every other device must do the same.
      db.update(employeeSessions).set({ mfaOk: true }).where(eq(employeeSessions.idHash, current.session.id)),
      revokeEmployeeSessionsStatement(db, employeeId, ctx.now, current.session.id),
      auditStatement(db, { actor: current.actor, action: "security.mfa.enable", entityType: "employee", entityId: employeeId, at: ctx.now }),
      authEventStatement(db, ctx, { subjectKind: "employee", subjectId: employeeId, kind: "mfa_enroll", success: true }),
    ]);
  } catch (error) {
    if (isDbError(error, "MFA_NOT_PENDING")) throw conflict("mfa_not_pending");
    throw error;
  }
  lookups.delete(ctx);
  return { recoveryCodes };
}

const DisableTotpInput = z.object({ password: z.string({ error: "required" }).min(1, "required"), code: z.string({ error: "required" }).trim().min(1, "required").max(40, "mfa_invalid") });

/**
 * The signed-in employee turns their own two-step verification off. Needs the password AND a
 * current code (or a recovery code). Throws `invalid` (fields.password) or `mfa_invalid`.
 */
export async function disableOwnTotp(ctx: AuthCtx, db: Db, raw: unknown, secrets: Pick<AuthSecrets, "DATA_KEY">): Promise<void> {
  const input = DisableTotpInput.parse(raw);
  const current = await requireSession(ctx, db);
  const employeeId = current.employee.id;
  if (!current.employee.totpEnabled) throw conflict("mfa_not_enabled");
  await enforceRateLimit(db, await limitKey("admin-mfa", "employee", employeeId), RATE_LIMITS.mfaVerify, ctx.now);

  const row = await db.select({ passwordHash: employees.passwordHash }).from(employees).where(eq(employees.id, employeeId)).get();
  if (!(await verifyPassword(input.password, row?.passwordHash))) throw invalid({ password: "invalid_credentials" });
  const factor = await checkSecondFactor(ctx, db, employeeId, input.code, secrets);
  if (!factor.ok) throw mfaInvalid();

  await runBatch(db, [
    db.update(employees).set({ totpEnabled: false, totpSecretEnc: null, recoveryCodes: null, updatedAt: ctx.now }).where(eq(employees.id, employeeId)),
    revokeEmployeeSessionsStatement(db, employeeId, ctx.now, current.session.id),
    auditStatement(db, { actor: current.actor, action: "security.mfa.disable", entityType: "employee", entityId: employeeId, at: ctx.now }),
    authEventStatement(db, ctx, { subjectKind: "employee", subjectId: employeeId, kind: "mfa_enroll", success: true, details: { change: "disabled" } }),
  ]);
  lookups.delete(ctx);
}

const ReasonedTarget = z.object({ employeeId: z.string().min(1), reason: z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long") });

/**
 * An administrator removes an employee's two-step verification (lost phone). Needs
 * `security.mfa.manage`. The employee is signed out everywhere and signs in with the password
 * alone until they enrol again.
 */
export async function resetEmployeeMfa(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "security.mfa.manage");
  const input = ReasonedTarget.parse(raw);
  try {
    await runBatch(db, [
      db.update(employees).set({ totpEnabled: false, totpSecretEnc: null, recoveryCodes: null, updatedAt: now }).where(eq(employees.id, input.employeeId)),
      expectChanged(db, 1, { code: "EMPLOYEE_NOT_FOUND", detail: input.employeeId }),
      revokeEmployeeSessionsStatement(db, input.employeeId, now),
      auditStatement(db, { actor, action: "security.mfa.reset", entityType: "employee", entityId: input.employeeId, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "EMPLOYEE_NOT_FOUND")) throw notFound("employee");
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────── sessions

/** An employee's live sessions, newest activity first. */
export async function listEmployeeSessions(db: Db, employeeId: string, now: number, currentSessionId?: string | null): Promise<(SessionSummary & { mfaOk: boolean })[]> {
  const rows = await db
    .select()
    .from(employeeSessions)
    .where(and(eq(employeeSessions.employeeId, employeeId), isNull(employeeSessions.revokedAt), gt(employeeSessions.expiresAt, now), gt(employeeSessions.lastSeenAt, now - IDLE_MS)))
    .orderBy(desc(employeeSessions.lastSeenAt));
  return rows.map((row) => ({ id: row.idHash, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt, ip: row.ip, userAgent: row.userAgent, current: row.idHash === currentSessionId, mfaOk: row.mfaOk }));
}

/** Batch item: ends every session of an employee, optionally keeping one. Include it whenever an account is disabled or its credentials change. */
export function revokeEmployeeSessionsStatement(db: Db, employeeId: string, now: number, exceptSessionId?: string | null): BatchStatement {
  const theirs = and(eq(employeeSessions.employeeId, employeeId), isNull(employeeSessions.revokedAt));
  return db
    .update(employeeSessions)
    .set({ revokedAt: now })
    .where(exceptSessionId ? and(theirs, ne(employeeSessions.idHash, exceptSessionId)) : theirs);
}

/**
 * Ends one session. Employees may end their own; ending someone else's needs
 * `security.session.revoke`. Recorded in the audit trail. False when the session was not live.
 */
export async function revokeEmployeeSession(db: Db, actor: Actor, input: { employeeId: string; sessionId: string; reason?: string | null }, now: number): Promise<boolean> {
  const own = actor.kind === "employee" && actor.id === input.employeeId;
  if (!own) assertCan(actor, "security.session.revoke");
  try {
    await runBatch(db, [
      db
        .update(employeeSessions)
        .set({ revokedAt: now })
        .where(and(eq(employeeSessions.idHash, input.sessionId), eq(employeeSessions.employeeId, input.employeeId), isNull(employeeSessions.revokedAt))),
      expectChanged(db, 1, { code: "SESSION_NOT_LIVE" }),
      auditStatement(db, { actor, action: "security.session.revoke", entityType: "employee", entityId: input.employeeId, reason: input.reason ?? null, after: { scope: "one" }, at: now }),
    ]);
    return true;
  } catch (error) {
    if (isDbError(error, "SESSION_NOT_LIVE")) return false;
    throw error;
  }
}

/** Ends all of an employee's sessions (same permission rule as revokeEmployeeSession). */
export async function revokeAllEmployeeSessions(db: Db, actor: Actor, input: { employeeId: string; exceptSessionId?: string | null; reason?: string | null }, now: number): Promise<void> {
  const own = actor.kind === "employee" && actor.id === input.employeeId;
  if (!own) assertCan(actor, "security.session.revoke");
  await runBatch(db, [
    revokeEmployeeSessionsStatement(db, input.employeeId, now, input.exceptSessionId),
    auditStatement(db, { actor, action: "security.session.revoke", entityType: "employee", entityId: input.employeeId, reason: input.reason ?? null, after: { scope: "all" }, at: now }),
  ]);
}

// ───────────────────────────────────────────────────────────────── account state

/**
 * Disables an employee: they are locked out on their next request and every session is ended.
 * Needs `staff.manage`. Refuses to disable yourself (`cannot_disable_self`) or the last active
 * owner (`last_owner`) — both 409.
 */
export async function disableEmployee(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "staff.manage");
  const input = ReasonedTarget.parse(raw);
  if (actor.kind === "employee" && actor.id === input.employeeId) throw conflict("cannot_disable_self");
  const id = input.employeeId;
  try {
    await runBatch(db, [
      // Either the target is not an owner, or another active owner remains.
      expectThat(
        db,
        sql`NOT EXISTS (SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = ${id} AND r.key = 'owner')
            OR EXISTS (SELECT 1 FROM employees e JOIN employee_roles er ON er.employee_id = e.id JOIN roles r ON r.id = er.role_id WHERE r.key = 'owner' AND e.status = 'active' AND e.id <> ${id})`,
        { code: "LAST_OWNER", detail: id },
      ),
      db
        .update(employees)
        .set({ status: "disabled", disabledAt: now, updatedAt: now })
        .where(and(eq(employees.id, id), eq(employees.status, "active"))),
      expectChanged(db, 1, { code: "EMPLOYEE_NOT_ACTIVE", detail: id }),
      revokeEmployeeSessionsStatement(db, id, now),
      auditStatement(db, { actor, action: "staff.employee.disable", entityType: "employee", entityId: id, before: { status: "active" }, after: { status: "disabled" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "LAST_OWNER")) throw conflict("last_owner", id);
    if (isDbError(error, "EMPLOYEE_NOT_ACTIVE")) throw conflict("employee_not_active", id);
    throw error;
  }
}

const ChangePasswordInput = z.object({
  currentPassword: z.string({ error: "required" }).min(1, "required"),
  newPassword: passwordField(EMPLOYEE_PASSWORD_MIN),
});

/**
 * The signed-in employee changes their password; their other devices are signed out.
 * Throws AppError: `unauthorized`, `invalid` (fields.currentPassword = "invalid_credentials", fields.newPassword).
 */
export async function changeEmployeePassword(ctx: AuthCtx, db: Db, raw: unknown): Promise<void> {
  const current = await requireSession(ctx, db);
  const input = ChangePasswordInput.parse(raw);
  const employeeId = current.employee.id;
  await enforceRateLimit(db, await limitKey("password", "employee", employeeId), RATE_LIMITS.signIn, ctx.now);

  const row = await db.select({ passwordHash: employees.passwordHash }).from(employees).where(eq(employees.id, employeeId)).get();
  if (!(await verifyPassword(input.currentPassword, row?.passwordHash))) {
    await runBatch(db, [authEventStatement(db, ctx, { subjectKind: "employee", subjectId: employeeId, kind: "password_change", success: false })]);
    throw invalid({ currentPassword: "invalid_credentials" });
  }
  const password = await hashPassword(input.newPassword);
  await runBatch(db, [
    db.update(employees).set({ passwordHash: password.hash, passwordIters: password.iterations, passwordChangedAt: ctx.now, updatedAt: ctx.now }).where(eq(employees.id, employeeId)),
    revokeEmployeeSessionsStatement(db, employeeId, ctx.now, current.session.id),
    auditStatement(db, { actor: current.actor, action: "security.password.change", entityType: "employee", entityId: employeeId, at: ctx.now }),
    authEventStatement(db, ctx, { subjectKind: "employee", subjectId: employeeId, kind: "password_change", success: true }),
  ]);
}

// ───────────────────────────────────────────────────────────────── first owner

const FirstOwnerInput = z.object({
  email: z.string({ error: "required" }).trim().toLowerCase().min(1, "required").max(200, "email_invalid").pipe(z.email("email_invalid")),
  name: z.string({ error: "required" }).trim().min(2, "too_short").max(80, "too_long"),
  password: passwordField(EMPLOYEE_PASSWORD_MIN),
});

export type FirstOwnerOptions = {
  /** `env.SETUP_TOKEN`. Setup is refused when it is not configured. */
  expectedToken: string | null | undefined;
  now: number;
  ip?: string | null;
  requestId?: string | null;
};

/** True while no employee exists — the only time /admin/setup may be shown. */
export async function isSetupAvailable(db: Db): Promise<boolean> {
  const row = await db.select({ n: sql<number>`count(*)` }).from(employees).get();
  return (row?.n ?? 0) === 0;
}

/**
 * Creates the first owner account. Works exactly once: only while the `employees` table is empty
 * (checked inside the same transaction as the insert) and only with the setup token.
 *
 *   await createFirstOwner(db, { setupToken, email, name, password }, { expectedToken: env.SETUP_TOKEN, now: ctx.now, ip: ctx.ip, requestId: ctx.requestId });
 *
 * Also installs the built-in roles. Does not sign anyone in — send the owner to /admin/login.
 * Throws AppError: `setup_disabled` (403, no SETUP_TOKEN configured), `setup_token_invalid` (403,
 * fields.setupToken), `setup_done` (409), `invalid` (fields), `rate_limited`.
 */
export async function createFirstOwner(db: Db, raw: unknown, options: FirstOwnerOptions): Promise<{ employeeId: string }> {
  const expected = options.expectedToken ?? "";
  if (expected.length < 16) throw new AppError("setup_disabled", 403);
  await enforceRateLimit(db, await limitKey("setup", "ip", options.ip), RATE_LIMITS.setup, options.now);

  const provided = typeof (raw as { setupToken?: unknown } | null)?.setupToken === "string" ? (raw as { setupToken: string }).setupToken.trim() : "";
  // Both sides are hashed first, so the comparison takes the same time whatever was typed.
  const tokenOk = timingSafeEqual(await sha256Hex(`tamtam.setup|${provided}`), await sha256Hex(`tamtam.setup|${expected}`));
  if (!tokenOk) throw new AppError("setup_token_invalid", 403, { fields: { setupToken: "setup_token_invalid" } });

  const input = FirstOwnerInput.parse(raw);
  const password = await hashPassword(input.password);
  const employeeId = newId("emp");
  const existingRoles = await existingDefaultRoles(db);
  const ownerRoleId = existingRoles.get("owner") ?? roleId("owner");
  try {
    await runBatch(db, [
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM employees)`, { code: "SETUP_DONE" }),
      ...seedRolesStatements(db, options.now, existingRoles),
      db.insert(employees).values({
        id: employeeId,
        email: input.email,
        name: input.name,
        passwordHash: password.hash,
        passwordIters: password.iterations,
        passwordChangedAt: options.now,
        status: "active",
        createdAt: options.now,
        updatedAt: options.now,
      }),
      db.insert(employeeRoles).values({ employeeId, roleId: ownerRoleId, grantedBy: null, grantedAt: options.now }),
      auditStatement(db, {
        actor: systemActor("admin.setup"),
        action: "staff.employee.bootstrap",
        entityType: "employee",
        entityId: employeeId,
        after: { email: input.email, name: input.name, roles: ["owner"] },
        at: options.now,
        ip: options.ip,
        requestId: options.requestId,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "SETUP_DONE")) throw conflict("setup_done");
    throw error;
  }
  return { employeeId };
}
