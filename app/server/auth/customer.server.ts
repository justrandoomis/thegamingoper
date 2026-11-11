/**
 * Customer accounts: sign-up and sign-in with an Iraqi phone number and a password, and the
 * session behind the `tt_sid` cookie.
 *
 *   const session = await getCustomer(ctx, db);            // null for guests — checkout never needs an account
 *   const { customer, actor } = await requireCustomer(ctx, db, { next: "/account/orders" });   // redirects guests to sign-in
 *
 *   // actions
 *   try { await signInCustomer(ctx, db, { phone, password }); return redirect(…); }
 *   catch (error) { const failure = actionError(error, t); return data(failure, { status: failure.status }); }
 *
 * Argument order: functions that read or set the session cookie take `(ctx, db, …)`; everything
 * else in ~/server takes `db` first.
 *
 * Sessions: a random token in an httpOnly, SameSite=Lax cookie; only its SHA-256 is stored. They
 * last 30 days from the last visit (the expiry slides, written at most once an hour), end when the
 * customer signs out, changes the password (all other devices) or is blocked, and can be listed and
 * revoked one by one.
 *
 * PHONE NUMBERS ARE NOT VERIFIED AT SIGN-UP: no SMS provider is configured, so anyone can register
 * any number. `customer.phoneVerified` says whether a one-time code confirmed it. Do not attach
 * guest orders to an account, and do not show order data by phone, unless it is true.
 *
 * One-time codes: `requestOtp` / `verifyOtp` (re-exported from ./otp.server) and
 * `confirmCustomerPhone`, which marks the signed-in customer's phone as verified.
 */
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { redirect } from "react-router";
import { z } from "zod";
import { newId, randomToken } from "~/lib/ids";
import { DEFAULT_LOCALE, LOCALE_CODES, localePath, type Locale } from "~/lib/locales";
import { maskPhone, normalizeIraqPhone } from "~/lib/phone";
import type { CustomerActor } from "../actor";
import { hashPassword, needsRehash, verifyPassword } from "../crypto.server";
import type { BatchStatement, Db } from "../db/drizzle.server";
import { customerSessions, customers } from "../db/schema";
import { isUniqueViolation, runBatch } from "../db/tx.server";
import { AppError, invalid, rateLimited, unauthorized } from "../errors";
import { RATE_LIMITS, enforceRateLimit, limitKey, rateLimit } from "../ratelimit.server";
import { CUSTOMER_PASSWORD_MIN, authEventStatement, originOf, passwordField, readSessionToken, safeNextPath, sessionCookie, sessionIdHash, type AuthCtx, type SessionSummary } from "./common.server";
import { verifyOtp, type OtpOptions } from "./otp.server";

export { safeNextPath } from "./common.server";
export type { AuthCtx, AuthSecrets, SessionSummary } from "./common.server";
export { requestOtp, verifyOtp, OTP_DIGITS, OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "./otp.server";
export type { OtpOptions, OtpPurpose, RequestOtpInput, RequestOtpResult, VerifiedOtp, VerifyOtpInput } from "./otp.server";

export const CUSTOMER_COOKIE = "tt_sid";
export const CUSTOMER_SESSION_DAYS = 30;
/** Where requireCustomer() sends guests (locale prefix added automatically). */
export const CUSTOMER_LOGIN_PATH = "/account/login";

const SESSION_MS = CUSTOMER_SESSION_DAYS * 24 * 60 * 60 * 1000;
/** The sliding expiry is written at most this often, to keep database writes rare. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

export type CustomerProfile = {
  id: string;
  name: string | null;
  phoneE164: string;
  /** "0771 ••• ••52" — what the shell shows. */
  phoneMasked: string;
  /** True once a one-time code confirmed the number (see the note at the top of this file). */
  phoneVerified: boolean;
  email: string | null;
  locale: Locale;
  vipTier: string | null;
};

export type CustomerSession = {
  customer: CustomerProfile;
  /** Pass to services: `{ kind: "customer", id }` with the request's origin for the audit trail. */
  actor: CustomerActor;
  session: { id: string; createdAt: number; expiresAt: number };
};

// ───────────────────────────────────────────────────────────────── session lookup

/** One lookup per request, shared by every loader that asks (keyed by the request context object). */
const lookups = new WeakMap<object, Promise<CustomerSession | null>>();

function cookieFor(ctx: AuthCtx, token: string, maxAgeSec: number): string {
  return sessionCookie(ctx, CUSTOMER_COOKIE, token, { maxAgeSec, sameSite: "Lax", path: "/" });
}

/** The session token in this request's cookie, or null. */
export function readCustomerToken(ctx: Pick<AuthCtx, "cookie">): string | null {
  return readSessionToken(ctx, CUSTOMER_COOKIE);
}

/**
 * The query behind a session lookup, as a batch item — the shell loader runs it together with its
 * other queries. Hand the rows to resolveCustomerSession().
 */
export function customerSessionQuery(db: Db, idHash: string) {
  return db
    .select({
      idHash: customerSessions.idHash,
      createdAt: customerSessions.createdAt,
      lastSeenAt: customerSessions.lastSeenAt,
      expiresAt: customerSessions.expiresAt,
      revokedAt: customerSessions.revokedAt,
      customerId: customers.id,
      name: customers.name,
      phoneE164: customers.phoneE164,
      phoneVerifiedAt: customers.phoneVerifiedAt,
      email: customers.email,
      locale: customers.locale,
      vipTier: customers.vipTier,
      status: customers.status,
    })
    .from(customerSessions)
    .innerJoin(customers, eq(customers.id, customerSessions.customerId))
    .where(eq(customerSessions.idHash, idHash))
    .limit(1);
}

export type CustomerSessionRow = Awaited<ReturnType<typeof customerSessionQuery>>[number];

/**
 * Turns the rows of customerSessionQuery() into a session, or null. Clears the cookie when the
 * session is gone (expired, revoked, account blocked) and slides the expiry when it is due.
 */
export async function resolveCustomerSession(ctx: AuthCtx, db: Db, token: string, rows: readonly CustomerSessionRow[]): Promise<CustomerSession | null> {
  const row = rows[0];
  if (!row || row.revokedAt !== null || row.expiresAt <= ctx.now || row.status !== "active") {
    ctx.setCookie(cookieFor(ctx, "", 0));
    return null;
  }
  let expiresAt = row.expiresAt;
  if (ctx.now - row.lastSeenAt > REFRESH_AFTER_MS) {
    expiresAt = ctx.now + SESSION_MS;
    await db
      .update(customerSessions)
      .set({ lastSeenAt: ctx.now, expiresAt })
      .where(and(eq(customerSessions.idHash, row.idHash), isNull(customerSessions.revokedAt)));
    ctx.setCookie(cookieFor(ctx, token, SESSION_MS / 1000));
  }
  return {
    customer: {
      id: row.customerId,
      name: row.name,
      phoneE164: row.phoneE164,
      phoneMasked: maskPhone(row.phoneE164),
      phoneVerified: row.phoneVerifiedAt !== null,
      email: row.email,
      locale: row.locale,
      vipTier: row.vipTier,
    },
    actor: { kind: "customer", id: row.customerId, label: row.name, ...originOf(ctx) },
    session: { id: row.idHash, createdAt: row.createdAt, expiresAt },
  };
}

async function lookup(ctx: AuthCtx, db: Db): Promise<CustomerSession | null> {
  const token = readCustomerToken(ctx);
  if (!token) return null;
  const rows = await customerSessionQuery(db, await sessionIdHash(token));
  return resolveCustomerSession(ctx, db, token, rows);
}

/** The signed-in customer of this request, or null for a guest. Runs one query per request however often it is called. */
export function getCustomer(ctx: AuthCtx, db: Db): Promise<CustomerSession | null> {
  let pending = lookups.get(ctx);
  if (!pending) {
    pending = lookup(ctx, db);
    lookups.set(ctx, pending);
  }
  return pending;
}

/**
 * For the shell loader, which resolves the session inside its own batch: registers that pending
 * result as this request's lookup so getCustomer() reuses it. Returns false (and registers nothing)
 * when a lookup is already running — use getCustomer() then.
 */
export function shareCustomerLookup(ctx: AuthCtx, pending: Promise<CustomerSession | null>): boolean {
  if (lookups.has(ctx)) return false;
  lookups.set(ctx, pending);
  return true;
}

/**
 * The signed-in customer, or a redirect to the sign-in page (`/account/login?next=…`, in the
 * request's language). `next` is the locale-less path to come back to.
 */
export async function requireCustomer(ctx: AuthCtx, db: Db, options: { next?: string | null; loginPath?: string } = {}): Promise<CustomerSession> {
  const session = await getCustomer(ctx, db);
  if (session) return session;
  const target = localePath(options.loginPath ?? CUSTOMER_LOGIN_PATH, ctx.locale);
  const next = options.next ? safeNextPath(options.next, "") : "";
  throw redirect(next ? `${target}?next=${encodeURIComponent(next)}` : target);
}

// ───────────────────────────────────────────────────────────────── sign-up, sign-in, sign-out

const SignUpInput = z.object({
  phone: z.string({ error: "required" }).trim().min(1, "required").max(40, "phone_invalid"),
  password: passwordField(CUSTOMER_PASSWORD_MIN),
  name: z.string().trim().min(2, "too_short").max(80, "too_long").optional(),
  locale: z.enum(LOCALE_CODES as [Locale, ...Locale[]]).optional(),
});

const SignInInput = z.object({
  phone: z.string({ error: "required" }).trim().min(1, "required").max(40, "phone_invalid"),
  password: z.string({ error: "required" }).min(1, "required"),
});

const invalidCredentials = () => new AppError("invalid_credentials", 401, { fields: { password: "invalid_credentials" } });

function parsePhone(value: string): string {
  const phoneE164 = normalizeIraqPhone(value);
  if (!phoneE164) throw invalid({ phone: "phone_invalid" });
  return phoneE164;
}

/** Statements that start a session, and the cookie that goes with it. */
async function newSession(ctx: AuthCtx, db: Db, customerId: string): Promise<{ token: string; idHash: string; statement: BatchStatement }> {
  const token = randomToken();
  const idHash = await sessionIdHash(token);
  const statement = db.insert(customerSessions).values({
    idHash,
    customerId,
    createdAt: ctx.now,
    lastSeenAt: ctx.now,
    expiresAt: ctx.now + SESSION_MS,
    ip: ctx.ip,
    userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 300) : null,
  });
  return { token, idHash, statement };
}

/** The stored id of whatever session the request's cookie points at, or null. */
async function cookieSessionId(ctx: AuthCtx): Promise<string | null> {
  const token = readCustomerToken(ctx);
  return token ? sessionIdHash(token) : null;
}

/**
 * Batch item that ends one session. Deliberately NOT async: a query builder returned from an async
 * function would be awaited — that is, executed on the spot instead of inside the batch.
 */
function revokeSessionStatement(db: Db, sessionId: string, now: number): BatchStatement {
  return db
    .update(customerSessions)
    .set({ revokedAt: now })
    .where(and(eq(customerSessions.idHash, sessionId), isNull(customerSessions.revokedAt)));
}

function established(ctx: AuthCtx, row: { id: string; name: string | null; phoneE164: string; phoneVerifiedAt: number | null; email: string | null; locale: Locale; vipTier: string | null }, token: string, idHash: string): CustomerSession {
  ctx.setCookie(cookieFor(ctx, token, SESSION_MS / 1000));
  const session: CustomerSession = {
    customer: { id: row.id, name: row.name, phoneE164: row.phoneE164, phoneMasked: maskPhone(row.phoneE164), phoneVerified: row.phoneVerifiedAt !== null, email: row.email, locale: row.locale, vipTier: row.vipTier },
    actor: { kind: "customer", id: row.id, label: row.name, ...originOf(ctx) },
    session: { id: idHash, createdAt: ctx.now, expiresAt: ctx.now + SESSION_MS },
  };
  lookups.set(ctx, Promise.resolve(session));
  return session;
}

/**
 * Creates an account and signs the customer in. Throws AppError: `invalid` (fields.phone /
 * fields.password / fields.name), `phone_taken` (409, fields.phone), `rate_limited`.
 */
export async function signUpCustomer(ctx: AuthCtx, db: Db, raw: unknown): Promise<CustomerSession> {
  const input = SignUpInput.parse(raw);
  const phoneE164 = parsePhone(input.phone);
  await enforceRateLimit(db, await limitKey("signup", "ip", ctx.ip), RATE_LIMITS.signUpIp, ctx.now);

  const password = await hashPassword(input.password);
  const id = newId("cus");
  const locale = input.locale ?? ctx.locale ?? DEFAULT_LOCALE;
  const session = await newSession(ctx, db, id);
  const previous = await cookieSessionId(ctx);
  try {
    await runBatch(db, [
      db.insert(customers).values({ id, phoneE164, name: input.name ?? null, passwordHash: password.hash, passwordIters: password.iterations, locale, createdAt: ctx.now, updatedAt: ctx.now, lastLoginAt: ctx.now }),
      session.statement,
      authEventStatement(db, ctx, { subjectKind: "customer", subjectId: id, identifier: phoneE164, kind: "signup", success: true }),
      ...(previous ? [revokeSessionStatement(db, previous, ctx.now)] : []),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "customers.phone_e164")) throw new AppError("phone_taken", 409, { fields: { phone: "phone_taken" } });
    throw error;
  }
  return established(ctx, { id, name: input.name ?? null, phoneE164, phoneVerifiedAt: null, email: null, locale, vipTier: null }, session.token, session.idHash);
}

/**
 * Signs a customer in. Every failure that depends on the account — unknown number, wrong password,
 * no password set — is the same AppError("invalid_credentials", 401) and takes the same time.
 * A blocked account gets `account_blocked` (403), but only after the right password.
 */
export async function signInCustomer(ctx: AuthCtx, db: Db, raw: unknown): Promise<CustomerSession> {
  const input = SignInInput.parse(raw);
  const phoneE164 = parsePhone(input.phone);
  await enforceRateLimit(db, await limitKey("signin", "ip", ctx.ip), RATE_LIMITS.signInIp, ctx.now);
  const verdict = await rateLimit(db, await limitKey("signin", "phone", phoneE164), RATE_LIMITS.signIn, ctx.now);
  if (!verdict.ok) throw rateLimited(verdict.retryAfterSec);

  const customer = await db.select().from(customers).where(eq(customers.phoneE164, phoneE164)).get();
  const passwordOk = await verifyPassword(input.password, customer?.passwordHash);
  if (!customer || !passwordOk || customer.status === "merged" || customer.status === "deleted") {
    await db.batch([authEventStatement(db, ctx, { subjectKind: "customer", subjectId: customer?.id ?? null, identifier: phoneE164, kind: "login", success: false })]);
    throw invalidCredentials();
  }
  if (customer.status !== "active") {
    await db.batch([authEventStatement(db, ctx, { subjectKind: "customer", subjectId: customer.id, identifier: phoneE164, kind: "login", success: false, details: { reason: "blocked" } })]);
    throw new AppError("account_blocked", 403);
  }

  // A hash made with weaker settings than today's is replaced while we have the password.
  const upgraded = needsRehash(customer.passwordHash) ? await hashPassword(input.password) : null;
  const session = await newSession(ctx, db, customer.id);
  const previous = await cookieSessionId(ctx);
  await runBatch(db, [
    session.statement,
    db
      .update(customers)
      .set({ lastLoginAt: ctx.now, ...(upgraded ? { passwordHash: upgraded.hash, passwordIters: upgraded.iterations } : {}) })
      .where(eq(customers.id, customer.id)),
    authEventStatement(db, ctx, { subjectKind: "customer", subjectId: customer.id, identifier: phoneE164, kind: "login", success: true }),
    ...(previous ? [revokeSessionStatement(db, previous, ctx.now)] : []),
  ]);
  return established(ctx, customer, session.token, session.idHash);
}

/** Ends this device's session and removes the cookie. Safe to call when nobody is signed in. */
export async function signOutCustomer(ctx: AuthCtx, db: Db): Promise<void> {
  const current = await cookieSessionId(ctx);
  if (current) await runBatch(db, [revokeSessionStatement(db, current, ctx.now)]);
  ctx.setCookie(cookieFor(ctx, "", 0));
  lookups.set(ctx, Promise.resolve(null));
}

// ───────────────────────────────────────────────────────────────── sessions

/** The customer's live sessions, newest activity first. `current` marks the one making this request. */
export async function listCustomerSessions(db: Db, customerId: string, now: number, currentSessionId?: string | null): Promise<SessionSummary[]> {
  const rows = await db
    .select()
    .from(customerSessions)
    .where(and(eq(customerSessions.customerId, customerId), isNull(customerSessions.revokedAt), gt(customerSessions.expiresAt, now)))
    .orderBy(desc(customerSessions.lastSeenAt));
  return rows.map((row) => ({ id: row.idHash, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt, ip: row.ip, userAgent: row.userAgent, current: row.idHash === currentSessionId }));
}

/** Ends one of the customer's sessions. False when it is not theirs or already over. */
export async function revokeCustomerSession(db: Db, customerId: string, sessionId: string, now: number): Promise<boolean> {
  const rows = await db
    .update(customerSessions)
    .set({ revokedAt: now })
    .where(and(eq(customerSessions.idHash, sessionId), eq(customerSessions.customerId, customerId), isNull(customerSessions.revokedAt)))
    .returning({ id: customerSessions.idHash });
  return rows.length === 1;
}

/** Batch item: ends every session of a customer, optionally keeping one (the device doing it). */
export function revokeCustomerSessionsStatement(db: Db, customerId: string, now: number, exceptSessionId?: string | null): BatchStatement {
  const mine = and(eq(customerSessions.customerId, customerId), isNull(customerSessions.revokedAt));
  return db
    .update(customerSessions)
    .set({ revokedAt: now })
    .where(exceptSessionId ? and(mine, ne(customerSessions.idHash, exceptSessionId)) : mine);
}

/** Ends every session of a customer ("sign out everywhere"; also call it when blocking an account). Returns how many ended. */
export async function revokeAllCustomerSessions(db: Db, customerId: string, now: number, exceptSessionId?: string | null): Promise<number> {
  const mine = and(eq(customerSessions.customerId, customerId), isNull(customerSessions.revokedAt));
  const rows = await db
    .update(customerSessions)
    .set({ revokedAt: now })
    .where(exceptSessionId ? and(mine, ne(customerSessions.idHash, exceptSessionId)) : mine)
    .returning({ id: customerSessions.idHash });
  return rows.length;
}

// ───────────────────────────────────────────────────────────────── password and phone

const ChangePasswordInput = z.object({
  currentPassword: z.string({ error: "required" }).min(1, "required"),
  newPassword: passwordField(CUSTOMER_PASSWORD_MIN),
});

/**
 * Changes the signed-in customer's password and signs every other device out.
 * Throws AppError: `unauthorized`, `invalid` (fields.currentPassword = "invalid_credentials", fields.newPassword), `rate_limited`.
 */
export async function changeCustomerPassword(ctx: AuthCtx, db: Db, raw: unknown): Promise<void> {
  const current = await getCustomer(ctx, db);
  if (!current) throw unauthorized();
  const input = ChangePasswordInput.parse(raw);
  await enforceRateLimit(db, await limitKey("password", "customer", current.customer.id), RATE_LIMITS.signIn, ctx.now);

  const row = await db.select({ passwordHash: customers.passwordHash }).from(customers).where(eq(customers.id, current.customer.id)).get();
  if (!(await verifyPassword(input.currentPassword, row?.passwordHash))) {
    await db.batch([authEventStatement(db, ctx, { subjectKind: "customer", subjectId: current.customer.id, kind: "password_change", success: false })]);
    throw invalid({ currentPassword: "invalid_credentials" });
  }
  const password = await hashPassword(input.newPassword);
  await db.batch([
    db.update(customers).set({ passwordHash: password.hash, passwordIters: password.iterations, updatedAt: ctx.now }).where(eq(customers.id, current.customer.id)),
    revokeCustomerSessionsStatement(db, current.customer.id, ctx.now, current.session.id),
    authEventStatement(db, ctx, { subjectKind: "customer", subjectId: current.customer.id, kind: "password_change", success: true }),
  ]);
}

/**
 * Marks the signed-in customer's phone as verified, given a correct one-time code that was
 * requested for that phone with purpose "verify_phone". Throws `unauthorized` or `otp_invalid`.
 */
export async function confirmCustomerPhone(ctx: AuthCtx, db: Db, input: { code: string; id?: string | null }, options: OtpOptions): Promise<CustomerSession> {
  const current = await getCustomer(ctx, db);
  if (!current) throw unauthorized();
  await verifyOtp(ctx, db, { phone: current.customer.phoneE164, purpose: "verify_phone", code: input.code, id: input.id }, options);
  await db.update(customers).set({ phoneVerifiedAt: ctx.now, updatedAt: ctx.now }).where(eq(customers.id, current.customer.id));
  const session: CustomerSession = { ...current, customer: { ...current.customer, phoneVerified: true } };
  lookups.set(ctx, Promise.resolve(session));
  return session;
}
