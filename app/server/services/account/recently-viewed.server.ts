/**
 * Recently viewed products (brief §3.10, §6) — kept ONLY with personalization consent.
 *
 *   await recordRecentlyViewed(db, { customerId, cartToken }, productId, ctx.now, { consent });   // product page (integration pass)
 *   const cards = await listRecentlyViewed(db, who, locale, ctx.now);                             // account overview
 *   await clearRecentlyViewed(db, who);                                                           // "clear history"
 *
 * Consent: the caller passes the current answer (`consent`): the shell's `personalizationConsent` (the `tt_consent`
 * cookie, which the account settings keep in step with the account's answer). Without it nothing is written, and
 * withdrawing consent in the settings deletes what was kept. Owners as for the wishlist: the account when signed in,
 * otherwise sha256 of the cart token (nothing is recorded for a guest without a cart). At most MAX_RECENTLY_VIEWED
 * rows per owner; the oldest go first.
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import type { ProductCardData } from "~/lib/dto";
import { newId, sha256Hex } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { products, recentlyViewed } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { getCardsByIds } from "~/server/services/catalog/cards.server";

export const MAX_RECENTLY_VIEWED = 30;

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type ViewerWho = { customerId: string | null; cartToken: string | null };

async function ownerWhere(who: ViewerWho) {
  if (who.customerId && ID.test(who.customerId)) return { where: eq(recentlyViewed.customerId, who.customerId), owner: { customerId: who.customerId, cartTokenHash: null } };
  if (who.cartToken && TOKEN.test(who.cartToken)) {
    const hash = await sha256Hex(who.cartToken);
    return { where: and(isNull(recentlyViewed.customerId), eq(recentlyViewed.cartTokenHash, hash)), owner: { customerId: null, cartTokenHash: hash } };
  }
  return null;
}

/** Remembers a product view — only with consent, only for a published product. Returns whether it was stored. */
export async function recordRecentlyViewed(db: Db, who: ViewerWho, productId: string, now: number, options: { consent: boolean }): Promise<boolean> {
  if (options?.consent !== true || typeof productId !== "string" || !ID.test(productId)) return false;
  const found = await ownerWhere(who);
  if (!found) return false;
  const product = await db.select({ status: products.status }).from(products).where(eq(products.id, productId)).get();
  if (!product || product.status !== "published") return false;
  const existing = await db
    .select({ id: recentlyViewed.id })
    .from(recentlyViewed)
    .where(and(found.where, eq(recentlyViewed.productId, productId)))
    .get();
  const keep = db.select({ id: recentlyViewed.id }).from(recentlyViewed).where(found.where).orderBy(desc(recentlyViewed.viewedAt), desc(recentlyViewed.id)).limit(MAX_RECENTLY_VIEWED);
  await runBatch(db, [
    existing
      ? db.update(recentlyViewed).set({ viewedAt: now }).where(eq(recentlyViewed.id, existing.id))
      : db.insert(recentlyViewed).values({ id: newId("rvw"), ...found.owner, productId, viewedAt: now }).onConflictDoNothing(),
    db.delete(recentlyViewed).where(and(found.where, notInArray(recentlyViewed.id, keep))),
  ]);
  return true;
}

/** Product ids viewed recently, newest first. */
export async function listRecentlyViewedIds(db: Db, who: ViewerWho, limit = 12): Promise<string[]> {
  const found = await ownerWhere(who);
  if (!found) return [];
  const rows = await db
    .select({ productId: recentlyViewed.productId })
    .from(recentlyViewed)
    .where(found.where)
    .orderBy(desc(recentlyViewed.viewedAt), desc(recentlyViewed.id))
    .limit(Math.min(Math.max(limit, 1), MAX_RECENTLY_VIEWED));
  return rows.map((row) => row.productId);
}

/** Cards of recently viewed products that are still in the catalogue. */
export async function listRecentlyViewed(db: Db, who: ViewerWho, locale: Locale, now: number, limit = 12): Promise<ProductCardData[]> {
  const ids = await listRecentlyViewedIds(db, who, limit);
  return ids.length ? getCardsByIds(db, locale, ids, { now }) : [];
}

/** Forgets the owner's history. Returns how many rows went. */
export async function clearRecentlyViewed(db: Db, who: ViewerWho): Promise<number> {
  const found = await ownerWhere(who);
  if (!found) return 0;
  const rows = await db.delete(recentlyViewed).where(found.where).returning({ id: recentlyViewed.id });
  return rows.length;
}

/** On sign-in, with consent: the guest's history (under the cart token) joins the account's. */
export async function mergeGuestRecentlyViewed(db: Db, customerId: string, cartToken: string | null): Promise<void> {
  if (!ID.test(customerId) || !cartToken || !TOKEN.test(cartToken)) return;
  const hash = await sha256Hex(cartToken);
  const guestRows = and(isNull(recentlyViewed.customerId), eq(recentlyViewed.cartTokenHash, hash));
  const accountHas = db.select({ productId: recentlyViewed.productId }).from(recentlyViewed).where(eq(recentlyViewed.customerId, customerId));
  await runBatch(db, [
    db.update(recentlyViewed).set({ customerId, cartTokenHash: null }).where(and(guestRows, notInArray(recentlyViewed.productId, accountHas))),
    db.delete(recentlyViewed).where(guestRows),
  ]);
}
