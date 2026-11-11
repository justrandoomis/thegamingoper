/**
 * Recently viewed products (brief §3.10, §6) — kept ONLY with personalization consent.
 *
 *   await recordRecentlyViewed(db, { customerId, cartToken: null }, productId, ctx.now, { consent });   // POST /api/recently-viewed
 *   await mergeDeviceRecentlyViewed(db, customerId, [{ id, at }], ctx.now, { consent });                // the device's list joins
 *   const cards = await listRecentlyViewed(db, who, locale, ctx.now);                                   // account overview, home
 *   await clearRecentlyViewed(db, who);                                                                 // "clear history"
 *
 * ONE STORE PER SHOPPER (decided by the integration pass, docs/areas/home.md and account.md): a guest's views stay on
 * the device (home's `tt:recent`, never sent here); a signed-in customer's views are kept HERE only. The product page
 * writes exactly one of the two. The first page a customer opens after signing in hands this device's guest list to
 * the account (mergeDeviceRecentlyViewed) and then empties it on the device. The guest rows keyed by the cart token
 * below are still supported (and merged at sign-in) but the storefront no longer writes them.
 *
 * Consent: the caller passes the current answer (`consent`): the shell's `personalizationConsent` (the `tt_consent`
 * cookie, which the account settings keep in step with the account's answer). Without it nothing is written, and
 * withdrawing consent in the settings deletes what was kept. Owners as for the wishlist: the account when signed in,
 * otherwise sha256 of the cart token (nothing is recorded for a guest without a cart). At most MAX_RECENTLY_VIEWED
 * rows per owner; the oldest go first.
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
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

/** A device's list as the browser sends it: product ids with the time they were viewed (home's `tt:recent`). */
export type DeviceRecentEntry = { id: string; at: number };

/** Entries older than this are not taken over from a device (home keeps its list for 90 days). */
const DEVICE_ENTRY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The device's guest list joins a signed-in customer's history — only with consent, only published products. Each
 * product keeps its newest time (a view already in the account is not counted twice), times from the future are taken
 * as now, entries older than 90 days are dropped, and the account keeps at most MAX_RECENTLY_VIEWED rows. One batch.
 * Returns how many entries were taken over (0 without consent).
 */
export async function mergeDeviceRecentlyViewed(db: Db, customerId: string, entries: readonly DeviceRecentEntry[], now: number, options: { consent: boolean }): Promise<number> {
  if (options?.consent !== true || !ID.test(customerId) || !Array.isArray(entries)) return 0;
  const newest = new Map<string, number>();
  for (const entry of entries.slice(0, MAX_RECENTLY_VIEWED)) {
    const id = entry?.id;
    const at = Math.min(Math.trunc(Number(entry?.at)), now);
    if (typeof id !== "string" || !ID.test(id) || !Number.isFinite(at) || now - at > DEVICE_ENTRY_MAX_AGE_MS) continue;
    newest.set(id, Math.max(newest.get(id) ?? 0, at));
  }
  if (newest.size === 0) return 0;
  const published = await db
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, [...newest.keys()]), eq(products.status, "published")));
  const kept = published.map((row) => ({ productId: row.id, viewedAt: newest.get(row.id) ?? now }));
  if (kept.length === 0) return 0;
  const owner = eq(recentlyViewed.customerId, customerId);
  const keep = db.select({ id: recentlyViewed.id }).from(recentlyViewed).where(owner).orderBy(desc(recentlyViewed.viewedAt), desc(recentlyViewed.id)).limit(MAX_RECENTLY_VIEWED);
  await runBatch(db, [
    ...kept.map((row) =>
      db
        .insert(recentlyViewed)
        .values({ id: newId("rvw"), customerId, cartTokenHash: null, productId: row.productId, viewedAt: row.viewedAt })
        .onConflictDoUpdate({
          target: [recentlyViewed.customerId, recentlyViewed.productId],
          targetWhere: sql`${recentlyViewed.customerId} IS NOT NULL`,
          // the account's own newer view wins: a product seen on both sides is one row with its latest time
          set: { viewedAt: sql`max("viewed_at", excluded."viewed_at")` },
        }),
    ),
    db.delete(recentlyViewed).where(and(owner, notInArray(recentlyViewed.id, keep))),
  ]);
  return kept.length;
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
