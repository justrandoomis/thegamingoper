/**
 * Admin 20.08 (part 2) — refund reviews (security.fraud.review): a second look at refunds after the fact, separate
 * from the two-person approval the commerce core already enforces (approveRefund refuses the requester).
 *
 * Every refund of the last 90 days is checked against fixed signals, each with its numbers (types.ts
 * REFUND_THRESHOLDS): a high amount; money sent another way than it came (cash or wallet instead of the original
 * method); one person both asking and issuing (a refund at or below the approval threshold is issued at once); one
 * employee asking for several refunds within 24 hours; a customer or phone with other refunds within 90 days.
 * A reviewer records "cleared" or "suspicious" with a note — an audit event on the refund — and may never review a
 * refund they asked for or approved (four eyes). Nothing here moves money: refunds are the commerce core's.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, can, type Actor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { refunds } from "~/server/db/schema";
import { AppError, notFound } from "~/server/errors";
import { actorIdOf, employeeNames } from "./shared.server";
import { DAY_MS, REFUND_REVIEW_OUTCOMES, REFUND_THRESHOLDS, type RefundFilters, type RefundReviewState, type RefundSignal } from "./types";

const PAGE_SIZE = 25;
const LOOKBACK_DAYS = 90;
export const REFUND_REVIEW_ACTION = "security.refund.review";

export type RefundReviewRow = {
  id: string;
  orderRef: string;
  amountIqd: number;
  method: string;
  paymentMethod: string;
  status: string;
  reason: string | null;
  createdAt: number;
  createdBy: string | null;
  createdById: string | null;
  approvedBy: string | null;
  approvedById: string | null;
  signals: RefundSignal[];
  review: RefundReviewState;
  /** False when this reviewer asked for or approved it. */
  canReview: boolean;
};

type Raw = {
  id: string;
  orderId: string;
  ref: string;
  amountIqd: number;
  method: string;
  paymentMethod: string;
  status: string;
  reason: string | null;
  createdAt: number;
  createdBy: string | null;
  approvedBy: string | null;
  customerId: string | null;
  phone: string | null;
};

async function reviewsOf(db: Db, ids: readonly string[]): Promise<Map<string, RefundReviewState>> {
  const out = new Map<string, RefundReviewState>();
  if (ids.length === 0) return out;
  const rows = await db.all<{ entityId: string; at: number; actorLabel: string | null; after: string | null; reason: string | null }>(sql`
    SELECT entity_id AS entityId, at, actor_label AS actorLabel, after, reason FROM audit_events
    WHERE action = ${REFUND_REVIEW_ACTION} AND entity_type = 'refund' AND entity_id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) ORDER BY seq DESC`);
  for (const row of rows) {
    if (out.has(row.entityId)) continue;
    const after = (row.after ? JSON.parse(row.after) : {}) as { outcome?: string };
    out.set(row.entityId, { outcome: after.outcome === "suspicious" ? "suspicious" : "cleared", note: row.reason, by: row.actorLabel, at: Number(row.at) });
  }
  return out;
}

function signalsOf(row: Raw, all: readonly Raw[]): RefundSignal[] {
  const out: RefundSignal[] = [];
  if (row.amountIqd >= REFUND_THRESHOLDS.highValueIqd) out.push("high_value");
  if (row.method !== "original") out.push("other_method");
  if (row.status === "paid" && (row.approvedBy === null || row.approvedBy === row.createdBy)) out.push("one_person");
  if (row.createdBy && all.filter((other) => other.createdBy === row.createdBy && Math.abs(other.createdAt - row.createdAt) <= DAY_MS).length >= REFUND_THRESHOLDS.burstCount) out.push("burst");
  const sameBuyer = all.filter((other) => other.orderId !== row.orderId && ((row.customerId && other.customerId === row.customerId) || (row.phone && other.phone === row.phone)));
  if (sameBuyer.length >= REFUND_THRESHOLDS.repeatCount) out.push("repeat_customer");
  return out;
}

export type RefundReviewPage = { rows: RefundReviewRow[]; total: number; page: number; pageCount: number; counts: { flagged: number; unreviewed: number; suspicious: number; all: number } };

export async function listRefundReviews(db: Db, actor: Actor, filters: RefundFilters, now: number): Promise<RefundReviewPage> {
  assertCan(actor, "security.fraud.review");
  const since = now - LOOKBACK_DAYS * DAY_MS;
  const raw = await db.all<Raw>(sql`
    SELECT r.id, r.order_id AS orderId, o.ref, r.amount_iqd AS amountIqd, r.method, p.method AS paymentMethod, r.status, r.reason, r.created_at AS createdAt,
           r.created_by AS createdBy, r.approved_by AS approvedBy, o.customer_id AS customerId, o.contact_phone_e164 AS phone
    FROM refunds r JOIN orders o ON o.id = r.order_id JOIN payments p ON p.id = r.payment_id
    WHERE r.created_at >= ${since} AND r.status <> 'rejected'
    ORDER BY r.created_at DESC LIMIT 2000`);
  const reviews = await reviewsOf(
    db,
    raw.map((row) => row.id),
  );
  const me = actorIdOf(actor);
  const evaluated = raw.map((row) => ({ row, signals: signalsOf(row, raw), review: reviews.get(row.id) ?? null }));
  const counts = {
    flagged: evaluated.filter((entry) => entry.signals.length > 0).length,
    unreviewed: evaluated.filter((entry) => entry.signals.length > 0 && !entry.review).length,
    suspicious: evaluated.filter((entry) => entry.review?.outcome === "suspicious").length,
    all: evaluated.length,
  };
  const visible = evaluated.filter((entry) =>
    filters.view === "all" ? true : filters.view === "flagged" ? entry.signals.length > 0 : filters.view === "unreviewed" ? entry.signals.length > 0 && !entry.review : entry.review?.outcome === "suspicious",
  );
  const pageRows = visible.slice((filters.page - 1) * PAGE_SIZE, filters.page * PAGE_SIZE);
  const names = await employeeNames(db, pageRows.flatMap((entry) => [entry.row.createdBy, entry.row.approvedBy]));
  return {
    rows: pageRows.map(({ row, signals, review }) => ({
      id: row.id,
      orderRef: row.ref,
      amountIqd: Number(row.amountIqd),
      method: row.method,
      paymentMethod: row.paymentMethod,
      status: row.status,
      reason: row.reason,
      createdAt: Number(row.createdAt),
      createdBy: row.createdBy ? (names.get(row.createdBy) ?? row.createdBy) : null,
      createdById: row.createdBy,
      approvedBy: row.approvedBy ? (names.get(row.approvedBy) ?? row.approvedBy) : null,
      approvedById: row.approvedBy,
      signals,
      review,
      canReview: me !== null && me !== row.createdBy && me !== row.approvedBy,
    })),
    total: visible.length,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(visible.length / PAGE_SIZE)),
    counts,
  };
}

const ReviewInput = z.object({
  refundId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, "invalid"),
  outcome: z.enum(REFUND_REVIEW_OUTCOMES, { error: "required" }),
  note: z.string({ error: "required" }).trim().min(3, "reason_required").max(1000, "too_long"),
});

/** Records a reviewer's verdict on a refund (never one they asked for or approved). */
export async function reviewRefund(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string }> {
  assertCan(actor, "security.fraud.review");
  const input = ReviewInput.parse(raw);
  const refund = await db.select({ id: refunds.id, createdBy: refunds.createdBy, approvedBy: refunds.approvedBy, amountIqd: refunds.amountIqd, status: refunds.status, orderId: refunds.orderId }).from(refunds).where(sql`${refunds.id} = ${input.refundId}`).get();
  if (!refund) throw notFound("refund");
  const me = actorIdOf(actor);
  if (me && (me === refund.createdBy || me === refund.approvedBy)) throw new AppError("reviewer_involved", 403);
  const id = await audit(db, { actor, action: REFUND_REVIEW_ACTION, entityType: "refund", entityId: refund.id, summary: refund.orderId, after: { outcome: input.outcome, status: refund.status, amountIqd: refund.amountIqd }, reason: input.note, at: now });
  return { id };
}

/** For the module's front page: flagged refunds of the last 90 days that nobody reviewed yet. */
export async function unreviewedCount(db: Db, actor: Actor, now: number): Promise<number | null> {
  if (!can(actor, "security.fraud.review")) return null;
  return (await listRefundReviews(db, actor, { view: "unreviewed", page: 1 }, now)).counts.unreviewed;
}

