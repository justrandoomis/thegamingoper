/**
 * The privacy-request form of the account (`/account/privacy`) — module 07's service, filed by the customer for their
 * own account: a copy of their data (export), a correction (rectify) or the deletion of the account (delete).
 *
 *   const list = await listOwnPrivacyRequests(db, customerId);
 *   const { ref } = await fileOwnPrivacyRequest(db, actor, { kind, details }, now);
 *
 * Nothing happens by itself: module 07's staff VERIFY the person first (verifyPrivacyRequest — by phone, in person, a
 * document) and then carry it out under the retention rules (orders, payments, the wallet ledger and the audit trail
 * are kept; an account holding money is paid out first, with a second person). The form is rate-limited
 * (PRIVACY_FILINGS per customer, and per network address); module 07 keeps one open request per kind
 * (privacy_open_exists). The request's key is scoped to the customer, so it never meets another person's.
 *
 * Errors: invalid (fields.kind, fields.details), privacy_open_exists (409), rate_limited (429).
 * Must not import "cloudflare:workers".
 */
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { CustomerActor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { privacyRequests } from "~/server/db/schema";
import { invalid, zodFieldErrors } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { createPrivacyRequest } from "~/server/services/admin/customers/privacy.server";
import { cleanBlock } from "~/server/text.server";

/** What a customer may ask for here (an unsubscribe is the settings page's switches). */
export const OWN_PRIVACY_KINDS = ["export", "rectify", "delete"] as const;
export type OwnPrivacyKind = (typeof OWN_PRIVACY_KINDS)[number];

/** Filings per customer and per address per day. */
export const PRIVACY_FILINGS: RateLimitRule = { limit: 5, windowSec: 24 * 60 * 60 };

export type OwnPrivacyRequest = { ref: string; kind: string; status: "open" | "verifying" | "in_progress" | "completed" | "rejected"; createdAt: number; dueAt: number | null; completedAt: number | null };

/** The customer's own requests, newest first (ref, kind, state, dates — never staff notes). */
export async function listOwnPrivacyRequests(db: Db, customerId: string): Promise<OwnPrivacyRequest[]> {
  const rows = await db
    .select({ ref: privacyRequests.ref, kind: privacyRequests.kind, status: privacyRequests.status, createdAt: privacyRequests.createdAt, dueAt: privacyRequests.dueAt, completedAt: privacyRequests.completedAt })
    .from(privacyRequests)
    .where(eq(privacyRequests.customerId, customerId))
    .orderBy(desc(privacyRequests.createdAt))
    .limit(20);
  return rows;
}

export const OwnPrivacyInput = z.object({
  kind: z.enum(OWN_PRIVACY_KINDS, { error: "required" }),
  details: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(1000, "too_long")),
  /** The form's attempt key: the same form sent twice opens one request. */
  attempt: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "invalid"),
});

/** Files a request for the customer's own account (file header). A correction says what to correct. */
export async function fileOwnPrivacyRequest(db: Db, actor: CustomerActor, raw: unknown, now: number): Promise<{ ref: string; replayed: boolean }> {
  const parsed = OwnPrivacyInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error));
  const input = parsed.data;
  if (input.kind === "rectify" && input.details.length < 3) throw invalid({ details: "required" });
  await enforceRateLimit(db, await limitKey("account-privacy", "customer", actor.id), PRIVACY_FILINGS, now);
  if (actor.ip) await enforceRateLimit(db, await limitKey("account-privacy", "ip", actor.ip), PRIVACY_FILINGS, now);
  return createPrivacyRequest(db, actor, { customerId: actor.id, kind: input.kind, details: input.details || undefined, idempotencyKey: `account:${actor.id}:${input.attempt}` }, now);
}
