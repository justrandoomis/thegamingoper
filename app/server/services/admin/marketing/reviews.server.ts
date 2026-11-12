/**
 * Admin 16.06 — the review hub: staff approve or reject what customers wrote; the storefront shows APPROVED reviews
 * from VERIFIED purchases only (reviews.server.ts: `status = 'approved' AND is_verified_purchase = 1`).
 *
 *   listReviews(db, actor, filters, locale)          marketing.review.moderate
 *   moderateReview(db, actor, raw, now)              marketing.review.moderate — approve / reject with a reason code
 *   pendingReviewCount(db, actor)                    for the bell and the module's front page
 *
 * Never an invented rating: there is no way to create, edit or re-rate a review here (and the table has no demo flag
 * on purpose). Approving needs the purchase to hold up NOW, inside the write: the review's order line belongs to an
 * order of the same customer, of the same product, and that order was delivered. A negative review is never a reason
 * to reject — the reason codes are abuse, personal data, off topic, spam, not about the product, other (with a note).
 * The author's name is shown only to staff who may open customer profiles (customers.customer.read).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { batchSql, expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid } from "~/server/errors";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { actorId, assertAny, employeeNames, ID, num, SECTION_READ } from "./shared.server";
import { REJECT_CODES, REVIEW_VIEWS, type RejectCode, type ReviewFilters, type ReviewView } from "./types";

export type ReviewRow = {
  id: string;
  productId: string;
  productName: string;
  productSlug: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  status: "pending" | "approved" | "rejected";
  verified: boolean;
  /** The purchase holds up now (delivered order of this customer and product). */
  purchaseOk: boolean;
  orderRef: string | null;
  author: { name: string | null; profileId: string | null };
  locale: string | null;
  createdAt: number;
  moderatedBy: string | null;
  moderatedAt: number | null;
  rejectCode: RejectCode | null;
  rejectNote: string | null;
};

const PURCHASE_OK = sql`EXISTS (
  SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN variants v ON v.id = oi.variant_id
  WHERE oi.id = r.order_item_id AND o.customer_id = r.customer_id AND v.product_id = r.product_id AND o.status = 'delivered')`;

function viewWhere(view: ReviewView) {
  return view === "all" ? sql`1 = 1` : sql`r.status = ${view}`;
}

function splitReason(text: string | null): { code: RejectCode | null; note: string | null } {
  if (!text) return { code: null, note: null };
  const at = text.indexOf(":");
  const code = (at === -1 ? text : text.slice(0, at)) as RejectCode;
  if (!(REJECT_CODES as readonly string[]).includes(code)) return { code: "other", note: text };
  return { code, note: at === -1 ? null : text.slice(at + 1).trim() || null };
}

export type ReviewListPage = { rows: ReviewRow[]; total: number; page: number; pageCount: number; counts: Record<ReviewView, number>; shown: { count: number; average: number | null; products: number } };

export async function listReviews(db: Db, actor: Actor, filters: ReviewFilters, locale: Locale): Promise<ReviewListPage> {
  assertAny(actor, SECTION_READ.reviews);
  const rating = filters.rating ? sql`r.rating = ${filters.rating}` : sql`1 = 1`;
  const verified = filters.verified === "yes" ? sql`r.is_verified_purchase = 1` : filters.verified === "no" ? sql`r.is_verified_purchase = 0` : sql`1 = 1`;
  const search = filters.q ? sql`(r.title LIKE ${`%${filters.q}%`} OR r.body LIKE ${`%${filters.q}%`} OR p.name LIKE ${`%${filters.q}%`})` : sql`1 = 1`;
  const base = sql`${rating} AND ${verified} AND ${search}`;
  const [countRow] = await db.all<Record<string, number>>(sql`
    SELECT COUNT(*) AS all_n, SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN r.status = 'approved' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END) AS rejected
    FROM reviews r JOIN products p ON p.id = r.product_id WHERE ${base}`);
  const counts = Object.fromEntries(REVIEW_VIEWS.map((view) => [view, num(countRow?.[view === "all" ? "all_n" : view])])) as Record<ReviewView, number>;
  const total = counts[filters.view];
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<{
    id: string;
    product_id: string;
    product_name: string;
    product_slug: string | null;
    rating: number;
    title: string | null;
    body: string | null;
    status: "pending" | "approved" | "rejected";
    is_verified_purchase: number;
    purchase_ok: number;
    order_ref: string | null;
    customer_id: string;
    customer_name: string | null;
    locale: string | null;
    created_at: number;
    moderated_by: string | null;
    moderated_at: number | null;
    reject_reason: string | null;
  }>(sql`
    SELECT r.id, r.product_id, p.name AS product_name, p.slug AS product_slug, r.rating, r.title, r.body, r.status, r.is_verified_purchase,
      CASE WHEN ${PURCHASE_OK} THEN 1 ELSE 0 END AS purchase_ok,
      (SELECT o.ref FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = r.order_item_id) AS order_ref,
      r.customer_id, cu.name AS customer_name, r.locale, r.created_at, r.moderated_by, r.moderated_at, r.reject_reason
    FROM reviews r JOIN products p ON p.id = r.product_id LEFT JOIN customers cu ON cu.id = r.customer_id
    WHERE ${base} AND ${viewWhere(filters.view)}
    ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`);
  const names = await employeeNames(db, rows.map((row) => row.moderated_by));
  const showNames = can(actor, "customers.customer.read");
  const [shown] = await db.all<{ n: number; average: number | null; products: number }>(
    sql`SELECT COUNT(*) AS n, AVG(rating) AS average, COUNT(DISTINCT product_id) AS products FROM reviews WHERE status = 'approved' AND is_verified_purchase = 1`,
  );
  return {
    rows: rows.map((row) => {
      let name: L10n = { ar: row.product_id };
      try {
        name = JSON.parse(row.product_name) as L10n;
      } catch {
        /* keep the id */
      }
      const reason = splitReason(row.reject_reason);
      return {
        id: row.id,
        productId: row.product_id,
        productName: pick(name, locale) || row.product_id,
        productSlug: row.product_slug,
        rating: Math.min(5, Math.max(1, num(row.rating))),
        title: row.title,
        body: row.body,
        status: row.status,
        verified: num(row.is_verified_purchase) === 1,
        purchaseOk: num(row.purchase_ok) === 1,
        orderRef: row.order_ref,
        author: { name: showNames ? row.customer_name : null, profileId: customerProfileId(actor, row.customer_id) },
        locale: row.locale,
        createdAt: num(row.created_at),
        moderatedBy: row.moderated_by ? (names.get(row.moderated_by) ?? null) : null,
        moderatedAt: row.moderated_at === null ? null : num(row.moderated_at),
        rejectCode: reason.code,
        rejectNote: reason.note,
      };
    }),
    total,
    page,
    pageCount,
    counts,
    shown: { count: num(shown?.n), average: shown && num(shown.n) > 0 && shown.average !== null ? Math.round(Number(shown.average) * 10) / 10 : null, products: num(shown?.products) },
  };
}

const ModerateInput = z.object({
  reviewId: z.string().regex(ID, "invalid"),
  decision: z.enum(["approve", "reject"], { error: "required" }),
  expectedStatus: z.enum(["pending", "approved", "rejected"], { error: "invalid" }),
  code: z.preprocess((value) => (value === "" || value === null ? undefined : value), z.enum(REJECT_CODES, { error: "reason_required" }).optional()),
  note: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().max(300, "too_long")),
});
export type ModerateReviewInput = z.input<typeof ModerateInput>;

/** Approves (verified purchase, re-checked inside the write) or rejects (a reason code; "other" needs a note) a review. */
export async function moderateReview(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "approved" | "rejected" }> {
  assertAny(actor, ["marketing.review.moderate"]);
  const input = ModerateInput.parse(raw ?? {});
  const row = (await db.all<{ id: string; status: string; is_verified_purchase: number; purchase_ok: number; product_id: string }>(sql`
    SELECT r.id, r.status, r.is_verified_purchase, CASE WHEN ${PURCHASE_OK} THEN 1 ELSE 0 END AS purchase_ok, r.product_id FROM reviews r WHERE r.id = ${input.reviewId}`))[0];
  if (!row) throw new AppError("not_found", 404);
  if (row.status !== input.expectedStatus) throw new AppError("review_changed", 409);
  const approve = input.decision === "approve";
  if (approve && row.status === "approved") throw new AppError("review_changed", 409);
  if (!approve && row.status === "rejected") throw new AppError("review_changed", 409);
  if (approve) {
    if (num(row.is_verified_purchase) !== 1) throw new AppError("review_not_verified", 409);
    if (num(row.purchase_ok) !== 1) throw new AppError("purchase_not_verified", 409);
  } else {
    if (!input.code) throw invalid({ code: "reason_required" });
    if (input.code === "other" && input.note.length < 3) throw invalid({ note: "reason_required" });
  }
  const me = actorId(actor);
  const rejectReason = approve ? null : input.note ? `${input.code}:${input.note}` : (input.code as string);
  const update = approve
    ? sql`UPDATE reviews SET status = 'approved', moderated_by = ${me}, moderated_at = ${now}, reject_reason = NULL
        WHERE id = ${row.id} AND status = ${input.expectedStatus} AND is_verified_purchase = 1 AND EXISTS (
          SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN variants v ON v.id = oi.variant_id
          WHERE oi.id = reviews.order_item_id AND o.customer_id = reviews.customer_id AND v.product_id = reviews.product_id AND o.status = 'delivered')`
    : sql`UPDATE reviews SET status = 'rejected', moderated_by = ${me}, moderated_at = ${now}, reject_reason = ${rejectReason} WHERE id = ${row.id} AND status = ${input.expectedStatus}`;
  try {
    await runBatch(db, [
      batchSql(db, update),
      expectChanged(db, 1, "REVIEW_CHANGED"),
      auditStatement(db, {
        actor,
        action: approve ? "marketing.review.approve" : "marketing.review.reject",
        entityType: "review",
        entityId: row.id,
        before: { status: row.status },
        after: { status: approve ? "approved" : "rejected", productId: row.product_id, code: approve ? null : input.code },
        reason: approve ? input.note || null : input.note || input.code || null,
        at: now,
      }),
    ]);
  } catch (error) {
    if (mapDbError(error)?.code !== "REVIEW_CHANGED") throw error;
    // which guard failed: someone decided it meanwhile, or (approving) the purchase no longer holds up
    const now2 = (await db.all<{ status: string }>(sql`SELECT status FROM reviews WHERE id = ${row.id}`))[0];
    throw new AppError(approve && now2?.status === input.expectedStatus ? "purchase_not_verified" : "review_changed", 409);
  }
  return { status: approve ? "approved" : "rejected" };
}

/** Reviews waiting for a decision, for staff who may decide them; null otherwise. */
export async function pendingReviewCount(db: Db, actor: Actor): Promise<number | null> {
  if (!can(actor, "marketing.review.moderate")) return null;
  const [row] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending'`);
  return num(row?.n);
}
