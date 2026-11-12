/**
 * «أضف بطاقة هدية إلى محفظتك» — the account's door to module 08's guarded gift-card redemption (never a second path):
 * the customer checks a card (its amount, nothing redeemed) and redeems it into their OWN wallet; the wallet then pays
 * at checkout like any other balance.
 *
 *   const card = await checkOwnGiftCard(db, actor, { code }, now);                       // → { amountIqd, hint, expiresAt }
 *   const done = await redeemOwnGiftCard(db, actor, { code, idempotencyKey }, now);      // → { amountIqd, replayed }
 *
 * module 08's checkGiftCardRedemption / redeemGiftCard do the work with the customer as the actor (their own wallet
 * only, by id — the module refuses anything else): the card guarded `active → redeemed` once, the wallet credit
 * (kind "gift_card", key "gift_card:<card>") and its posting in ONE batch, a demo card never into a real account, the
 * customer still active inside the batch, wrong codes counted per customer. Here, on top: every attempt counts per
 * customer and per network address (GIFT_ATTEMPTS), so a code cannot be guessed from the storefront either.
 *
 * Errors: invalid (fields.code), gift_card_unknown (404), gift_card_used · gift_card_void · gift_card_expired ·
 * gift_card_not_active · gift_card_demo_mismatch · customer_unavailable (409), rate_limited (429).
 * Must not import "cloudflare:workers".
 */
import type { CustomerActor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { invalid } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { checkGiftCardRedemption, normalizeGiftCode, redeemGiftCard } from "~/server/services/admin/promotions/giftcards.server";

/** Checks and redemptions together, per customer and per address: generous for a person holding cards, tight for guessing. */
export const GIFT_ATTEMPTS: RateLimitRule = { limit: 10, windowSec: 10 * 60 };

const KEY = /^[A-Za-z0-9_-]{8,128}$/;

function codeOf(raw: unknown): string {
  const code = typeof raw === "string" ? normalizeGiftCode(raw.slice(0, 64)) : "";
  if (code.length === 0) throw invalid({ code: "required" });
  if (code.length < 8 || code.length > 32) throw invalid({ code: "gift_card_unknown" });
  return code;
}

async function countAttempt(db: Db, actor: CustomerActor, now: number): Promise<void> {
  await enforceRateLimit(db, await limitKey("account-gift", "customer", actor.id), GIFT_ATTEMPTS, now);
  if (actor.ip) await enforceRateLimit(db, await limitKey("account-gift", "ip", actor.ip), GIFT_ATTEMPTS, now);
}

/** What a card would add to the customer's wallet (reads only; counts as an attempt). */
export async function checkOwnGiftCard(db: Db, actor: CustomerActor, raw: { code?: unknown }, now: number): Promise<{ amountIqd: number; hint: string | null; expiresAt: number | null }> {
  const code = codeOf(raw.code);
  await countAttempt(db, actor, now);
  const card = await checkGiftCardRedemption(db, actor, { code, customerId: actor.id }, now);
  return { amountIqd: card.amountIqd, hint: card.hint, expiresAt: card.expiresAt };
}

/** Redeems a card into the customer's own wallet (module 08's batch). The same form sent twice answers its first result. */
export async function redeemOwnGiftCard(db: Db, actor: CustomerActor, raw: { code?: unknown; idempotencyKey?: unknown }, now: number): Promise<{ amountIqd: number; replayed: boolean }> {
  const code = codeOf(raw.code);
  const key = typeof raw.idempotencyKey === "string" && KEY.test(raw.idempotencyKey) ? raw.idempotencyKey : null;
  if (!key) throw invalid({ code: "invalid" });
  await countAttempt(db, actor, now);
  const done = await redeemGiftCard(db, actor, { code, customerId: actor.id, idempotencyKey: key }, now);
  return { amountIqd: done.amountIqd, replayed: done.replayed };
}
