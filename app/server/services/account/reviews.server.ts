/**
 * A customer's review of what they received — the storefront's door to the review hub's model (admin 16.06,
 * ~/server/services/admin/marketing/reviews.server; the `reviews` table): on the account's order page each product of
 * a DELIVERED order can be reviewed once by its buyer, with a rating (1–5) and an optional short text. It is saved
 * `pending` and is never shown anywhere until staff approve it in /admin/marketing/reviews; the store then counts
 * approved reviews from verified purchases only (~/server/services/reviews.server, the cards' rating).
 *
 *   const slots = await listOrderReviewSlots(db, customerId, orderRef);           // per product: still open, or the review
 *   const saved = await submitLineReview(db, actor, { orderItemId, rating, body }, { now, locale });
 *
 * The rules, each checked again INSIDE the write (a guarded insert), so a race cannot slip past them:
 *   · only the buyer — the line belongs to an order of this customer (anyone else: "not found", nothing told);
 *   · only delivered — the order's status is `delivered`, the same test staff's approval repeats;
 *   · new items only — a used unit is one device with its own condition: a review of it would land on the product's
 *     page as the product's (review_used_unit);
 *   · once — one review per product per customer (the table's unique index), so once per line; a second line of the
 *     same product (another order, another option) shows the first review;
 *   · a demo order is not a real purchase: its review reaches the staff queue but is NOT a verified purchase
 *     (`is_verified_purchase = 0`), so staff cannot approve it and the store never counts it — the reviews table has no
 *     demo flag on purpose, and a rating from a demo order must never pass for a real one;
 *   · rate-limited per customer and per network address (REVIEW_WRITES; failed attempts count too).
 * The text is cleaned like every shopper's text (control and bidi-override characters out) and the author is never
 * part of anything the store shows. Audited (customers.review.submit: the rating, never the text).
 *
 * Errors: invalid (fields rating → review_rating_required, body → review_too_short / review_too_long),
 * review_line_unknown (404), review_used_unit · review_not_delivered · review_exists · customer_unavailable (409),
 * rate_limited (429). Must not import "cloudflare:workers".
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import type { CustomerActor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { batchSql, expectChanged, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, unauthorized } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { cleanBlock } from "~/server/text.server";
import { OWN_REJECT_CODES, REVIEW_LIMITS, type OwnRejectCode, type OwnReview, type ReviewSlot } from "./types";

/** Reviews sent (and refused) per customer and per network address: room for a whole order, nothing for a flood. */
export const REVIEW_WRITES: RateLimitRule = { limit: 20, windowSec: 60 * 60 };

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const blank = (value: unknown) => (value === null || (typeof value === "string" && value.trim() === "") ? undefined : value);
/** "4" (or ٤ / ۴, or a number) → 4; anything else stays as it is for zod to refuse. */
function ratingOf(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const latin = value
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return /^\d$/.test(latin) ? Number(latin) : value === "" ? undefined : value;
}

export const LineReviewInput = z.object({
  rating: z.preprocess(ratingOf, z.number({ error: "review_rating_required" }).int("review_rating_required").min(1, "review_rating_required").max(5, "review_rating_required")),
  body: z.preprocess(blank, z.string({ error: "invalid" }).overwrite(cleanBlock).trim().min(REVIEW_LIMITS.bodyMin, "review_too_short").max(REVIEW_LIMITS.body, "review_too_long").optional()),
});
/** `orderItemId`: the line; `orderRef` (optional): the order whose page sent it — a line of another order is "unknown". */
export type LineReviewInput = z.input<typeof LineReviewInput> & { orderItemId?: unknown; orderRef?: unknown };

/**
 * The language a review is written in, for `lang` where staff read it: the page's, unless the text plainly says
 * otherwise (Arabic letters typed on /en, or only Latin letters on an Arabic or Sorani page). Pure.
 */
export function reviewLocale(page: Locale, body: string | null | undefined): Locale {
  if (!body) return page;
  const arabicScript = /[؀-ۿ]/.test(body);
  const latin = /[A-Za-z]/.test(body);
  if (page === "en" && arabicScript) return "ar";
  if (page !== "en" && !arabicScript && latin) return "en";
  return page;
}

/** A stored `reject_reason` ("code" or "code:staff note") → the code the customer may read; never the note. Pure. */
export function ownRejectCode(stored: string | null | undefined): OwnRejectCode | null {
  if (!stored) return null;
  const at = stored.indexOf(":");
  const code = (at === -1 ? stored : stored.slice(0, at)).trim();
  return (OWN_REJECT_CODES as readonly string[]).includes(code) ? (code as OwnRejectCode) : null;
}

const num = (value: unknown) => Number(value ?? 0);

type ReviewRow = { id: string; product_id: string; order_item_id: string | null; rating: number; body: string | null; status: OwnReview["status"]; is_verified_purchase: number; created_at: number; reject_reason: string | null };

function ownReview(row: ReviewRow, orderItemId: string): OwnReview {
  return {
    id: row.id,
    rating: Math.min(5, Math.max(1, Math.trunc(num(row.rating)))),
    body: row.body?.trim() || null,
    status: row.status,
    verified: num(row.is_verified_purchase) === 1,
    createdAt: num(row.created_at),
    rejectCode: row.status === "rejected" ? ownRejectCode(row.reject_reason) : null,
    here: row.order_item_id === orderItemId,
  };
}

/**
 * The products of one of the customer's DELIVERED orders they may review, in the order's line order: one slot per
 * product (the line that holds the review, else the product's first line), used units left out. Each slot is open
 * (`review: null`) or carries the customer's own review — written from this order or an earlier one. Another
 * customer's order, an unknown reference or an order not delivered: no slots.
 */
export async function listOrderReviewSlots(db: Db, customerId: string, orderRef: string): Promise<ReviewSlot[]> {
  if (!ID.test(customerId) || typeof orderRef !== "string" || !ID.test(orderRef)) return [];
  const lines = await db.all<{ id: string; product_id: string }>(sql`
    SELECT oi.id, v.product_id FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN variants v ON v.id = oi.variant_id
    WHERE o.ref = ${orderRef} AND o.customer_id = ${customerId} AND o.status = 'delivered' AND oi.used_unit_id IS NULL
    ORDER BY oi.rowid`);
  if (lines.length === 0) return [];
  const productIds = [...new Set(lines.map((line) => line.product_id))];
  const reviews = await db.all<ReviewRow>(sql`
    SELECT id, product_id, order_item_id, rating, body, status, is_verified_purchase, created_at, reject_reason FROM reviews
    WHERE customer_id = ${customerId} AND product_id IN (${sql.join(
      productIds.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  const byProduct = new Map(reviews.map((row) => [row.product_id, row]));
  const lineIds = new Set(lines.map((line) => line.id));
  const slots: ReviewSlot[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.product_id)) continue;
    const review = byProduct.get(line.product_id) ?? null;
    // the line that holds the review stands for its product, wherever it sits in the order
    const holder = review?.order_item_id && lineIds.has(review.order_item_id) ? review.order_item_id : line.id;
    seen.add(line.product_id);
    slots.push({ orderItemId: holder, productId: line.product_id, review: review ? ownReview(review, holder) : null });
  }
  return slots;
}

type LineFacts = { order_item_id: string; product_id: string; used_unit_id: string | null; order_status: string; is_demo: number };

/**
 * Saves the buyer's review of one delivered order line as `pending` (see the rules above). Returns the new review's
 * id and whether it counts as a verified purchase (false for a demo order: it is never published).
 */
export async function submitLineReview(
  db: Db,
  actor: CustomerActor,
  raw: LineReviewInput,
  options: { now: number; locale: Locale },
): Promise<{ id: string; status: "pending"; verified: boolean }> {
  if (actor?.kind !== "customer" || !actor.id) throw unauthorized();
  const customerId = actor.id;
  const orderItemId = typeof raw?.orderItemId === "string" && ID.test(raw.orderItemId) ? raw.orderItemId : null;
  const orderRef = raw?.orderRef === undefined || raw.orderRef === null ? null : typeof raw.orderRef === "string" && ID.test(raw.orderRef) ? raw.orderRef : "";
  const input = LineReviewInput.parse(raw ?? {});
  if (!orderItemId || orderRef === "") throw new AppError("review_line_unknown", 404);
  const { now } = options;

  // every attempt counts — a refused one too (probing other customers' lines costs the same as writing)
  await enforceRateLimit(db, await limitKey("account-review", "customer", customerId), REVIEW_WRITES, now);
  if (actor.ip) await enforceRateLimit(db, await limitKey("account-review", "ip", actor.ip), REVIEW_WRITES, now);

  const line = (
    await db.all<LineFacts>(sql`
      SELECT oi.id AS order_item_id, v.product_id, oi.used_unit_id, o.status AS order_status, o.is_demo FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN variants v ON v.id = oi.variant_id
      WHERE oi.id = ${orderItemId} AND o.customer_id = ${customerId} AND (${orderRef} IS NULL OR o.ref = ${orderRef})`)
  )[0];
  if (!line) throw new AppError("review_line_unknown", 404);
  if (line.used_unit_id) throw new AppError("review_used_unit", 409);
  if (line.order_status !== "delivered") throw new AppError("review_not_delivered", 409);
  const customer = (await db.all<{ status: string }>(sql`SELECT status FROM customers WHERE id = ${customerId}`))[0];
  if (!customer) throw unauthorized();
  if (customer.status !== "active") throw new AppError("customer_unavailable", 409, { detail: customer.status });
  const earlier = (await db.all<{ id: string }>(sql`SELECT id FROM reviews WHERE customer_id = ${customerId} AND product_id = ${line.product_id}`))[0];
  if (earlier) throw new AppError("review_exists", 409);

  const id = newId("rev");
  const isDemo = num(line.is_demo) === 1;
  const verified = !isDemo;
  const body = input.body ?? null;
  try {
    await runBatch(db, [
      // written only while every rule still holds at this moment (the order may have been returned meanwhile)
      batchSql(
        db,
        sql`INSERT INTO reviews (id, product_id, customer_id, order_item_id, rating, title, body, status, is_verified_purchase, created_at, locale)
          SELECT ${id}, ${line.product_id}, ${customerId}, ${orderItemId}, ${input.rating}, NULL, ${body}, 'pending', ${verified ? 1 : 0}, ${now}, ${reviewLocale(options.locale, body)}
          WHERE EXISTS (
            SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN variants v ON v.id = oi.variant_id
            WHERE oi.id = ${orderItemId} AND o.customer_id = ${customerId} AND o.status = 'delivered' AND oi.used_unit_id IS NULL
              AND v.product_id = ${line.product_id} AND o.is_demo = ${isDemo ? 1 : 0})
          AND EXISTS (SELECT 1 FROM customers WHERE id = ${customerId} AND status = 'active')`,
      ),
      expectChanged(db, 1, "REVIEW_LINE_CHANGED"),
      auditStatement(db, {
        actor,
        action: "customers.review.submit",
        entityType: "review",
        entityId: id,
        after: { productId: line.product_id, orderItemId, rating: input.rating, verified, status: "pending", withText: body !== null },
        at: now,
      }),
    ]);
  } catch (error) {
    // two sends at the same moment: the table's unique index (one review per product per customer) let one through
    if (isUniqueViolation(error)) throw new AppError("review_exists", 409);
    if (mapDbError(error)?.code !== "REVIEW_LINE_CHANGED") throw error;
    const status = (await db.all<{ status: string }>(sql`SELECT status FROM customers WHERE id = ${customerId}`))[0]?.status;
    throw status === "active" ? new AppError("review_not_delivered", 409) : new AppError("customer_unavailable", 409);
  }
  return { id, status: "pending", verified };
}
