/**
 * The customer's own profile: name, e-mail and the language the store writes to them in.
 *
 *   const profile = await getProfile(db, customerId);
 *   await updateProfile(db, actor, { name, email, locale }, ctx.now);        // audited
 *
 * The phone number is the account's identity and is NOT editable here: changing it needs a one-time code to the new
 * number, and no SMS provider is configured (docs/STATUS.md open item 4) — the page says so and points to support.
 *
 * Errors (AppError): invalid (400: fields name / email / locale), unauthorized (401: the actor is not this customer),
 * customer_unavailable (409: the account was merged or deleted), rate_limited (429: PROFILE_CHANGES_PER_CUSTOMER).
 * Must not import "cloudflare:workers".
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { LOCALE_CODES, type Locale } from "~/lib/locales";
import { maskPhone } from "~/lib/phone";
import type { CustomerActor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { customers } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { AppError, notFound, unauthorized } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { cleanLine } from "~/server/text.server";
import type { AccountProfile } from "./types";

/**
 * Profile changes a customer may save per hour (security review, second pass): each one writes an audit event, and
 * `audit_events` refuses UPDATE and DELETE. People change a name or an e-mail a few times at most; saving what is
 * already stored writes nothing and does not count.
 */
export const PROFILE_CHANGES_PER_CUSTOMER = { limit: 10, windowSec: 60 * 60 } as const satisfies RateLimitRule;

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,190}\.[^\s@<>()[\]\\,;:"]{2,24}$/;

/** Blank form fields mean "remove it". */
const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

export const UpdateProfileInput = z.object({
  name: z.preprocess(blankToNull, z.string().overwrite(cleanLine).trim().min(2, "too_short").max(80, "too_long").nullable()).optional(),
  email: z.preprocess(
    blankToNull,
    z
      .string()
      .overwrite(cleanLine)
      .trim()
      .max(254, "too_long")
      .transform((value) => value.toLowerCase())
      .refine((value) => EMAIL.test(value), "email_invalid")
      .nullable(),
  ).optional(),
  locale: z.enum(LOCALE_CODES as [Locale, ...Locale[]], { error: "invalid" }).optional(),
});
export type UpdateProfileInput = z.input<typeof UpdateProfileInput>;

function toProfile(row: typeof customers.$inferSelect): AccountProfile {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phoneE164: row.phoneE164,
    phoneMasked: maskPhone(row.phoneE164),
    phoneVerified: row.phoneVerifiedAt !== null,
    locale: row.locale,
    createdAt: row.createdAt,
  };
}

/** The customer's profile, or null when the account does not exist. */
export async function getProfile(db: Db, customerId: string): Promise<AccountProfile | null> {
  const row = await db.select().from(customers).where(eq(customers.id, customerId)).get();
  return row ? toProfile(row) : null;
}

/** Changes name, e-mail and/or message language. Fields left out stay as they are; blank name or e-mail removes it. */
export async function updateProfile(db: Db, actor: CustomerActor, raw: UpdateProfileInput, now: number): Promise<AccountProfile> {
  if (actor?.kind !== "customer" || !actor.id) throw unauthorized();
  const input = UpdateProfileInput.parse(raw);
  const row = await db.select().from(customers).where(eq(customers.id, actor.id)).get();
  if (!row) throw notFound("customer");
  if (row.status === "merged" || row.status === "deleted") throw new AppError("customer_unavailable", 409, { detail: row.status });

  const next = {
    name: input.name === undefined ? row.name : input.name,
    email: input.email === undefined ? row.email : input.email,
    locale: input.locale ?? row.locale,
  };
  const before = { name: row.name, email: row.email, locale: row.locale };
  if (before.name === next.name && before.email === next.email && before.locale === next.locale) return toProfile(row);

  // Every change is an audit event, and audit_events is append-only: a script must not grow it without end.
  await enforceRateLimit(db, await limitKey("profile", "customer", actor.id), PROFILE_CHANGES_PER_CUSTOMER, now);
  await runBatch(db, [
    db.update(customers).set({ ...next, updatedAt: now }).where(eq(customers.id, actor.id)),
    auditStatement(db, { actor, action: "customers.profile.update", entityType: "customer", entityId: actor.id, before, after: next, at: now }),
  ]);
  return toProfile({ ...row, ...next, updatedAt: now });
}
