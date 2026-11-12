/**
 * Server helpers shared by the catalog pages' loaders (thin: parse, call the service, shape).
 */
import { sql } from "drizzle-orm";
import { redirect } from "react-router";

import type { ProductCardData } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db.server";
import { isAppError } from "~/server/errors";
import { getListingFilterOrder } from "~/server/services/admin/cms/navigation.server";
import { LISTING_FILTER_GROUPS } from "~/server/services/admin/cms/rules";
import { wishedAmong, wishlistWho } from "~/server/services/wishlist.server";
import { listProducts } from "~/server/services/catalog/listing.server";
import { FILTER_GROUPS, type FilterGroup, type StoreBrowse } from "./listing-model";

/**
 * The filter groups a listing offers, in the order staff arranged them in the content module (admin 17.03,
 * getListingFilterOrder: the category's own arrangement, else the default one). Null while nothing is arranged — the
 * module answers its default list then — so the panel keeps the page's own order. A read that fails leaves the page's
 * own order too (logged): filters never disappear for it.
 */
export async function filterOrderOf(db: Db, categoryId: string | null): Promise<FilterGroup[] | null> {
  try {
    const order = await getListingFilterOrder(db, categoryId);
    const untouched = order.length === LISTING_FILTER_GROUPS.length && order.every((group, index) => group === LISTING_FILTER_GROUPS[index]);
    if (untouched) return null;
    return order.filter((group): group is FilterGroup => (FILTER_GROUPS as readonly string[]).includes(group));
  } catch (error) {
    console.error("[catalog] filter arrangement not read — the page's own order", error);
    return null;
  }
}

export type CategoryCms = { id: string; seo: { title: string | null; description: string | null; noindex: boolean } };

/**
 * A category's id (for its banners and its filter arrangement) and what staff wrote for search engines in the content
 * module (`categories.seo`, admin 17.04): the title and description in the page's language (Arabic when it has none),
 * and noindex. Null for an unknown slug.
 */
export async function categoryCmsOf(db: Db, slug: string, locale: Locale): Promise<CategoryCms | null> {
  const rows = await db.all<{ id: string; seo: string | null }>(sql`SELECT id, seo FROM categories WHERE slug = ${slug} LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  type StoredSeo = { title?: L10n; description?: L10n; noindex?: unknown };
  const seo = parseSeo<StoredSeo>(row.seo);
  const text = (value: L10n | undefined) => (value && typeof value === "object" ? pick(value, locale).trim() || null : null);
  return { id: row.id, seo: { title: text(seo?.title), description: text(seo?.description), noindex: seo?.noindex === true } };
}

/** A JSON column read defensively: null when empty or malformed. */
function parseSeo<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as T) : null;
  } catch {
    return null;
  }
}

/**
 * The store's platforms and top-level departments with the same counts their hubs show (researched platforms — the
 * multi-platform games and headsets included — and listed products), from one listing of the whole store.
 */
export async function storeBrowse(db: Db, locale: Locale, now: number): Promise<StoreBrowse> {
  const result = await listProducts(db, locale, { scope: { kind: "all" }, limit: 1, now });
  if (!result) return { platforms: [], categories: [] };
  return {
    platforms: result.facets.platforms.map((option) => ({ slug: option.value, count: option.count })),
    categories: result.facets.categories.map((option) => ({ slug: option.value, label: option.label, count: option.count, artKey: option.artKey })),
  };
}

/**
 * Which of these products the shopper keeps in the wishlist (the cards then show a filled heart). Null when it cannot
 * be read — the cards then show no heart at all rather than a wrong one.
 */
export async function wishedOf(db: Db, ctx: { cookie: (name: string) => string | null }, customerId: string | null, productIds: readonly string[]): Promise<string[] | null> {
  try {
    if (productIds.length === 0) return [];
    return [...(await wishedAmong(db, wishlistWho(ctx.cookie, customerId), [...new Set(productIds)]))];
  } catch (error) {
    console.error("[catalog] wishlist not read", error);
    return null;
  }
}

/**
 * The cards of a «وصل حديثاً» shelf: the shelf's title already says they are new, so no card repeats «جديد» (v2 §4.7:
 * never inside that shelf). Every other badge (a real reduction, «قريباً») stays.
 */
export function arrivalsShelf(cards: readonly ProductCardData[]): ProductCardData[] {
  return cards.map((card) => (card.badge === "new" || card.isNew ? { ...card, badge: card.badge === "new" ? null : card.badge, isNew: false } : card));
}

/** A category or platform slug as the URL may carry it (anything else is a 404 without touching the database). */
export const PAGE_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * Runs a list request; a cursor the service refuses (an old link made for another sort, or for a list that has
 * changed since) sends the shopper to the same list without it — the first page — instead of an error.
 */
export async function withCursorFallback<T>(url: URL, hasCursor: boolean, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (hasCursor && isAppError(error, "invalid")) {
      const next = new URL(url);
      next.searchParams.delete("cursor");
      throw redirect(`${next.pathname}${next.search}`);
    }
    throw error;
  }
}

/** The list part of a ListingResult, for the page (the hub travels separately). */
export function listOf<T extends { hub?: unknown }>(result: T): Omit<T, "hub"> {
  const { hub: _hub, ...rest } = result;
  return rest;
}
