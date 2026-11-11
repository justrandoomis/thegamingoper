/**
 * One-time codes for the account: resetting a forgotten password and confirming the phone number.
 *
 * THE BOUNDARY: codes travel by SMS, and NO SMS PROVIDER IS CONFIGURED (docs/STATUS.md open item 4). So:
 *   · production — `codeDelivery(false)` is "unavailable": nothing is requested, the screens say that codes cannot be
 *     sent yet and point to the store's contact details. No code is generated, nothing pretends to be sent.
 *   · development — "dev": the code is generated and held in the outbox as usual, and `requestOtp` hands it back as
 *     `devCode` so the flow can be exercised; the screen labels it as a development-only code.
 *   · a provider wired into ~/server/outbox.server later makes it "provider" with no change here.
 *
 *   const sent = await requestPasswordResetCode(ctx, db, { phone }, otp);              // same answer for every number
 *   await resetPasswordWithCode(ctx, db, { phone, code, id, password }, otp);         // signs every device out
 *   const sent = await requestPhoneCode(ctx, db, otp);  await confirmPhoneCode(ctx, db, { code, id }, otp);
 *
 * `otp` is `{ secret: env.SESSION_SECRET }` — passed by the route (services never read the environment).
 * Errors (AppError): invalid (400: fields phone / password / code), otp_invalid (400), otp_unavailable (503),
 * rate_limited (429), unauthorized (401).
 * Must not import "cloudflare:workers".
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { normalizeIraqPhone } from "~/lib/phone";
import { authEventStatement, CUSTOMER_PASSWORD_MIN, passwordField, type AuthCtx } from "~/server/auth/common.server";
import { confirmCustomerPhone, getCustomer, requestOtp, revokeCustomerSessionsStatement, verifyOtp, type OtpOptions } from "~/server/auth/customer.server";
import { hashPassword } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { customers } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { AppError, invalid, unauthorized } from "~/server/errors";
import { initialStatus } from "~/server/outbox.server";
import type { CodeDelivery } from "./types";

/** How a code can reach the customer right now. */
export function codeDelivery(isDev: boolean): CodeDelivery {
  if (initialStatus("sms") === "queued") return "provider";
  return isDev ? "dev" : "unavailable";
}

export type CodeRequest = { id: string; expiresAt: number; phoneMasked: string; delivery: CodeDelivery; devCode: string | null };

function unavailable(): AppError {
  return new AppError("otp_unavailable", 503);
}

function parsePhone(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw invalid({ phone: "required" });
  const phone = normalizeIraqPhone(text);
  if (!phone) throw invalid({ phone: "phone_invalid" });
  return phone;
}

const masked = (e164: string) => {
  const local = e164.replace(/^\+964/, "0");
  return `${local.slice(0, 4)} ••• ••${local.slice(-2)}`;
};

/**
 * Asks for a password-reset code. The answer is the same whether or not an account uses the number, so the form
 * cannot be used to find out who has an account.
 */
export async function requestPasswordResetCode(ctx: AuthCtx, db: Db, raw: { phone?: unknown }, otp: OtpOptions): Promise<CodeRequest> {
  const phone = parsePhone(raw?.phone);
  const delivery = codeDelivery(ctx.isDev === true);
  if (delivery === "unavailable") throw unavailable();
  const sent = await requestOtp(ctx, db, { phone, purpose: "password_reset" }, otp);
  return { id: sent.id, expiresAt: sent.expiresAt, phoneMasked: masked(phone), delivery, devCode: delivery === "dev" ? (sent.devCode ?? null) : null };
}

const ResetInput = z.object({
  password: passwordField(CUSTOMER_PASSWORD_MIN),
  code: z.string({ error: "required" }).trim().min(1, "required").max(20, "otp_invalid"),
  id: z.string().trim().max(128).optional(),
});

/**
 * Sets a new password with a correct reset code and ends every session of the account. A code for a number that has
 * no (active) account fails exactly like a wrong code.
 */
export async function resetPasswordWithCode(ctx: AuthCtx, db: Db, raw: { phone?: unknown; code?: unknown; id?: unknown; password?: unknown }, otp: OtpOptions): Promise<void> {
  const phone = parsePhone(raw?.phone);
  const input = ResetInput.parse({ password: raw?.password, code: raw?.code, id: typeof raw?.id === "string" && raw.id ? raw.id : undefined });
  if (codeDelivery(ctx.isDev === true) === "unavailable") throw unavailable();
  await verifyOtp(ctx, db, { phone, purpose: "password_reset", code: input.code, id: input.id ?? null }, otp);
  const customer = await db.select({ id: customers.id, status: customers.status }).from(customers).where(eq(customers.phoneE164, phone)).get();
  if (!customer || customer.status !== "active") throw new AppError("otp_invalid", 400, { fields: { code: "otp_invalid" } });
  const password = await hashPassword(input.password);
  await runBatch(db, [
    db.update(customers).set({ passwordHash: password.hash, passwordIters: password.iterations, updatedAt: ctx.now }).where(eq(customers.id, customer.id)),
    revokeCustomerSessionsStatement(db, customer.id, ctx.now),
    authEventStatement(db, ctx, { subjectKind: "customer", subjectId: customer.id, identifier: phone, kind: "password_reset", success: true }),
  ]);
}

/** Asks for a code to confirm the signed-in customer's own number. */
export async function requestPhoneCode(ctx: AuthCtx, db: Db, otp: OtpOptions): Promise<CodeRequest> {
  const session = await getCustomer(ctx, db);
  if (!session) throw unauthorized();
  const delivery = codeDelivery(ctx.isDev === true);
  if (delivery === "unavailable") throw unavailable();
  const sent = await requestOtp(ctx, db, { phone: session.customer.phoneE164, purpose: "verify_phone" }, otp);
  return { id: sent.id, expiresAt: sent.expiresAt, phoneMasked: session.customer.phoneMasked, delivery, devCode: delivery === "dev" ? (sent.devCode ?? null) : null };
}

/** Confirms the signed-in customer's number with the code. */
export async function confirmPhoneCode(ctx: AuthCtx, db: Db, raw: { code?: unknown; id?: unknown }, otp: OtpOptions): Promise<void> {
  const code = typeof raw?.code === "string" ? raw.code.trim() : "";
  if (!code) throw invalid({ code: "required" });
  if (codeDelivery(ctx.isDev === true) === "unavailable") throw unavailable();
  await confirmCustomerPhone(ctx, db, { code, id: typeof raw?.id === "string" && raw.id ? raw.id : null }, otp);
}
