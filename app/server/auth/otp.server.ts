/**
 * One-time codes sent to a phone — the boundary for phone verification.
 *
 * NO SMS PROVIDER IS CONFIGURED, so today a requested code is generated and stored (hashed) but
 * cannot reach the phone: the message is recorded in the outbox as `held` and `requestOtp()` says
 * so (`delivery: "held"`). Screens must tell the shopper the truth in that case — never "we sent
 * you a code". In development only (`ctx.isDev`) the code is returned as `devCode` so the flows that
 * depend on it can be exercised; in production it never leaves the server.
 *
 *   const sent = await requestOtp(ctx, db, { phone, purpose: "verify_phone" }, { secret: env.SESSION_SECRET });
 *   // … the person types the code …
 *   const proof = await verifyOtp(ctx, db, { id: sent.id, phone, purpose: "verify_phone", code }, { secret: env.SESSION_SECRET });
 *
 * Rules: 6 digits, valid 5 minutes, at most 5 guesses per code, a new request cancels the previous
 * code for the same phone and purpose, 3 requests per phone per 10 minutes. Only a keyed hash of the
 * code is stored (HMAC with SESSION_SECRET when given — pass it), and the outbox row never contains
 * the code. A code is bound to its phone, purpose and optional `ref` (e.g. an order reference).
 */
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { newId, sha256Hex, timingSafeEqual } from "~/lib/ids";
import { normalizeIraqPhone, toLatinDigits } from "~/lib/phone";
import { hmacSha256Hex, randomDigits } from "../crypto.server";
import type { Db } from "../db/drizzle.server";
import { otpCodes } from "../db/schema";
import { AppError, invalid } from "../errors";
import { NO_PROVIDERS, sendOrHold, type MessageProviders } from "../outbox.server";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "../ratelimit.server";
import { authEventStatement, type AuthCtx } from "./common.server";

export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;

/** What a code unlocks. Open vocabulary (lower_snake_case); these are the ones in use. */
export type OtpPurpose = "login" | "verify_phone" | "password_reset" | "order_lookup" | "claim_orders" | (string & {});

export type OtpOptions = {
  /** SESSION_SECRET: makes the stored hash useless without the Worker's secret. */
  secret?: string | null;
  /** Delivery providers by channel. None exist yet — see ~/server/outbox.server. */
  providers?: MessageProviders;
};

export type RequestOtpInput = { phone: string; purpose: OtpPurpose; ref?: string | null };

export type RequestOtpResult = {
  id: string;
  phoneE164: string;
  expiresAt: number;
  /**
   * held   no provider is configured: the code was NOT sent
   * sent   handed to the provider
   * failed the provider refused it
   */
  delivery: "held" | "sent" | "failed";
  /** Development only. Never present when `ctx.isDev` is false. */
  devCode?: string;
};

const PURPOSE_PATTERN = /^[a-z][a-z_]{1,31}$/;

function otpHash(secret: string | null | undefined, id: string, phone: string, purpose: string, code: string): Promise<string> {
  const message = `tamtam.otp.v1|${id}|${phone}|${purpose}|${code}`;
  return secret ? hmacSha256Hex(secret, message) : sha256Hex(message);
}

function parseTarget(input: { phone: string; purpose: string }): { phoneE164: string; purpose: string } {
  const phoneE164 = normalizeIraqPhone(input.phone);
  if (!phoneE164) throw invalid({ phone: "phone_invalid" });
  if (typeof input.purpose !== "string" || !PURPOSE_PATTERN.test(input.purpose)) throw new Error(`OTP purpose must be lower_snake_case, got "${String(input.purpose)}"`);
  return { phoneE164, purpose: input.purpose };
}

const otpInvalid = () => new AppError("otp_invalid", 400, { fields: { code: "otp_invalid" } });

/**
 * Creates a code for a phone and hands it to the SMS channel (which, today, holds it).
 * Throws AppError `invalid` (fields.phone) or `rate_limited`.
 */
export async function requestOtp(ctx: AuthCtx, db: Db, input: RequestOtpInput, options: OtpOptions = {}): Promise<RequestOtpResult> {
  const { phoneE164, purpose } = parseTarget(input);
  await enforceRateLimit(db, await limitKey("otp", "ip", ctx.ip), RATE_LIMITS.otpRequestIp, ctx.now);
  await enforceRateLimit(db, await limitKey("otp", "phone", phoneE164), RATE_LIMITS.otpRequest, ctx.now);

  const id = newId("otp");
  const code = randomDigits(OTP_DIGITS);
  const expiresAt = ctx.now + OTP_TTL_MS;
  const ref = input.ref ? String(input.ref).slice(0, 100) : null;

  await db.batch([
    // Only the newest code for a phone and purpose is valid.
    db
      .update(otpCodes)
      .set({ consumedAt: ctx.now })
      .where(and(eq(otpCodes.phoneE164, phoneE164), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt))),
    db.insert(otpCodes).values({ id, phoneE164, purpose, codeHash: await otpHash(options.secret, id, phoneE164, purpose, code), expiresAt, createdAt: ctx.now, ip: ctx.ip, ref }),
    authEventStatement(db, ctx, { subjectKind: "customer", identifier: phoneE164, kind: "otp_request", success: true, details: { purpose } }),
  ]);

  // The code travels to the provider in memory only; the stored message never contains it.
  const message = await sendOrHold(
    db,
    { channel: "sms", recipient: phoneE164, template: "otp", payload: { purpose, expiresAt }, locale: ctx.locale, refType: "otp", refId: id, now: ctx.now },
    { code },
    options.providers ?? NO_PROVIDERS,
  );
  const delivery = message.status === "sent" ? "sent" : message.status === "held" ? "held" : "failed";
  return { id, phoneE164, expiresAt, delivery, ...(ctx.isDev === true ? { devCode: code } : {}) };
}

export type VerifyOtpInput = { phone: string; purpose: OtpPurpose; code: string; /** From requestOtp(); without it the newest code for the phone and purpose is checked. */ id?: string | null };

export type VerifiedOtp = { id: string; phoneE164: string; purpose: string; ref: string | null };

/**
 * Checks a code and consumes it. Every failure is the same AppError("otp_invalid") — wrong code,
 * expired, already used, too many guesses — so the answer reveals nothing about which it was.
 * A code can succeed once: two simultaneous correct submissions yield one success.
 */
export async function verifyOtp(ctx: AuthCtx, db: Db, input: VerifyOtpInput, options: OtpOptions = {}): Promise<VerifiedOtp> {
  const { phoneE164, purpose } = parseTarget(input);
  const code = toLatinDigits(String(input.code ?? "")).replace(/[\s-]/g, "");
  if (!/^\d+$/.test(code) || code.length !== OTP_DIGITS) throw otpInvalid();

  const usable = and(eq(otpCodes.phoneE164, phoneE164), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, ctx.now), lt(otpCodes.attempts, OTP_MAX_ATTEMPTS));
  let id = input.id ?? null;
  if (!id) {
    const newest = await db.select({ id: otpCodes.id }).from(otpCodes).where(usable).orderBy(desc(otpCodes.createdAt), desc(otpCodes.id)).limit(1).get();
    if (!newest) throw otpInvalid();
    id = newest.id;
  }

  // Count the guess first, atomically: the row comes back only while it is still usable.
  const [row] = await db
    .update(otpCodes)
    .set({ attempts: sql`${otpCodes.attempts} + 1` })
    .where(and(eq(otpCodes.id, id), usable))
    .returning({ id: otpCodes.id, codeHash: otpCodes.codeHash, ref: otpCodes.ref });
  if (!row) throw otpInvalid();

  const matches = timingSafeEqual(row.codeHash, await otpHash(options.secret, row.id, phoneE164, purpose, code));
  if (!matches) {
    await db.batch([authEventStatement(db, ctx, { subjectKind: "customer", identifier: phoneE164, kind: "otp_verify", success: false, details: { purpose } })]);
    throw otpInvalid();
  }

  const [consumed] = await db
    .update(otpCodes)
    .set({ consumedAt: ctx.now })
    .where(and(eq(otpCodes.id, row.id), isNull(otpCodes.consumedAt)))
    .returning({ id: otpCodes.id });
  if (!consumed) throw otpInvalid();

  await db.batch([authEventStatement(db, ctx, { subjectKind: "customer", identifier: phoneE164, kind: "otp_verify", success: true, details: { purpose } })]);
  return { id: row.id, phoneE164, purpose, ref: row.ref };
}
