/**
 * Product reviews as shoppers see them (docs/CONTRACTS.md §3, row "product").
 *
 *   const summary = await getReviewSummary(db, product.id);        // { count, average, distribution }
 *   const latest = await listVerifiedReviews(db, product.id, { limit: 6 });
 *
 * Only APPROVED reviews from VERIFIED PURCHASES count (`status = 'approved' AND is_verified_purchase = 1` — the same
 * rule as the card read layer's rating). Reviews are never seeded or invented (schema/catalog.ts: there is no demo
 * flag on purpose); with none, the summary says count 0 / average null and the page says so in words.
 *
 * Shoppers never see who wrote a review — no name, no phone, no customer id leaves this module.
 * Services take `db` first and never import "cloudflare:workers".
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "~/server/db/drizzle.server";
import { reviews } from "~/server/db/schema";
import type { ReviewSummary, VerifiedReview } from "./catalog/product-types";

export type { ReviewSummary, VerifiedReview };

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EMPTY: ReviewSummary = {
  count: 0,
  average: null,
  distribution: [0, 0, 0, 0, 0],
};

const approvedVerified = (productId: string) => and(eq(reviews.productId, productId), eq(reviews.status, "approved"), eq(reviews.isVerifiedPurchase, true));

/** Count, average and the star distribution of a product's approved, verified-purchase reviews. */
export async function getReviewSummary(db: Db, productId: string): Promise<ReviewSummary> {
  if (typeof productId !== "string" || !ID.test(productId)) return { ...EMPTY, distribution: [...EMPTY.distribution] };
  const rows = await db
    .select({ rating: reviews.rating, n: sql<number>`count(*)`.as("n") })
    .from(reviews)
    .where(approvedVerified(productId))
    .groupBy(reviews.rating);
  const distribution: ReviewSummary["distribution"] = [0, 0, 0, 0, 0];
  let count = 0;
  let total = 0;
  for (const row of rows) {
    const rating = Math.trunc(Number(row.rating));
    const n = Number(row.n);
    // The CHECK constraint keeps ratings in 1–5; anything else would be a broken row, not a review.
    if (rating < 1 || rating > 5 || !Number.isSafeInteger(n) || n <= 0) continue;
    distribution[rating - 1] += n;
    count += n;
    total += rating * n;
  }
  return {
    count,
    average: count > 0 ? Math.round((total / count) * 10) / 10 : null,
    distribution,
  };
}

/** The newest approved, verified-purchase reviews (text only — never the author). */
export async function listVerifiedReviews(db: Db, productId: string, options: { limit?: number } = {}): Promise<VerifiedReview[]> {
  if (typeof productId !== "string" || !ID.test(productId)) return [];
  const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 6)));
  const rows = await db
    .select({
      id: reviews.id,
      rating: reviews.rating,
      title: reviews.title,
      body: reviews.body,
      createdAt: reviews.createdAt,
      locale: reviews.locale,
    })
    .from(reviews)
    .where(approvedVerified(productId))
    .orderBy(desc(reviews.createdAt), desc(reviews.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    rating: Math.min(5, Math.max(1, Math.trunc(row.rating))),
    title: row.title?.trim() || null,
    body: row.body?.trim() || null,
    createdAt: row.createdAt,
    locale: row.locale ?? null,
  }));
}
