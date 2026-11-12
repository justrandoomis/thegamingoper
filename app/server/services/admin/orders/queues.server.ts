/**
 * The two queues the admin shell counts (shell/queues.server.ts) — mobile-first screens of module 05:
 *
 *   /admin/orders/proofs            transfer proofs awaiting verification            orders.payment.verify
 *   /admin/orders/proofs/:paymentId one proof: image (payment_proof.read), declared vs due vs received, duplicate
 *                                   warning (staff only), approve / reject with a reason
 *   /admin/orders/refunds           refunds awaiting a second person                 orders.refund.approve (or .create
 *                                   to follow one's own requests) — the requester never approves their own
 *
 * Reads only; the decisions go through ./actions.server (verifyProof, decideRefund → the commerce core).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { orders, paymentProofs, payments, refunds } from "~/server/db/schema";
import { forbidden, notFound } from "~/server/errors";
import { getRefundableAmount, refundDestination } from "~/server/services/refunds.server";
import { employeeNames, phoneFor } from "./shared.server";
import type { AnyPaymentMethod, PhoneView, ProofView } from "./types";

export type ProofQueueRow = {
  paymentId: string;
  orderRef: string;
  orderId: string;
  method: AnyPaymentMethod;
  dueIqd: number;
  declaredAmountIqd: number;
  submittedAt: number;
  matches: boolean;
  duplicate: boolean;
  reference: string | null;
  isDemo: boolean;
  onHold: boolean;
};

/** Payments whose proof waits for a decision, oldest first (first in, first verified). */
export async function listProofQueue(db: Db, actor: Actor): Promise<ProofQueueRow[]> {
  assertCan(actor, "orders.payment.verify");
  const rows = await db
    .select({
      paymentId: payments.id,
      method: payments.method,
      dueIqd: payments.amountIqd,
      orderId: orders.id,
      orderRef: orders.ref,
      isDemo: orders.isDemo,
      reviewStatus: orders.reviewStatus,
      declared: paymentProofs.declaredAmountIqd,
      submittedAt: paymentProofs.createdAt,
      duplicateOf: paymentProofs.duplicateOf,
      reference: paymentProofs.reference,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .innerJoin(paymentProofs, and(eq(paymentProofs.paymentId, payments.id), eq(paymentProofs.status, "submitted")))
    .where(eq(payments.status, "pending_verification"))
    .orderBy(asc(paymentProofs.createdAt), asc(payments.id))
    .limit(200);
  const seen = new Set<string>();
  const out: ProofQueueRow[] = [];
  for (const row of rows) {
    if (seen.has(row.paymentId)) continue;
    seen.add(row.paymentId);
    out.push({
      paymentId: row.paymentId,
      orderRef: row.orderRef,
      orderId: row.orderId,
      method: row.method,
      dueIqd: row.dueIqd,
      declaredAmountIqd: row.declared,
      submittedAt: row.submittedAt,
      matches: row.declared === row.dueIqd,
      duplicate: row.duplicateOf !== null,
      reference: row.reference,
      isDemo: row.isDemo,
      onHold: row.reviewStatus === "blocked",
    });
  }
  return out;
}

export type ProofReview = {
  paymentId: string;
  status: string;
  method: AnyPaymentMethod;
  dueIqd: number;
  /** customerProfileId: the buyer's account for a link to their profile — only for staff who may open it. */
  order: { id: string; ref: string; status: string; totalIqd: number; placedAt: number; contactName: string | null; customerProfileId: string | null; phone: PhoneView | null; isDemo: boolean; onHold: boolean };
  /** The proof waiting for a decision (null when there is none any more). */
  current: ProofView | null;
  /** Earlier proofs of this payment (rejected), newest first. */
  history: ProofView[];
  canOverride: boolean;
  canSeeImage: boolean;
};

/** Everything a verifier needs to decide one payment (mobile-first review page). */
export async function getProofReview(db: Db, actor: Actor, paymentId: string, imageUrl: (proofId: string) => string): Promise<ProofReview> {
  assertCan(actor, "orders.payment.verify");
  const payment = await db.select().from(payments).where(eq(payments.id, paymentId)).get();
  if (!payment || (payment.method !== "bank_transfer" && payment.method !== "zaincash")) throw notFound("payment");
  const order = await db.select().from(orders).where(eq(orders.id, payment.orderId)).get();
  if (!order) throw notFound("order");
  const proofs = await db.select().from(paymentProofs).where(eq(paymentProofs.paymentId, payment.id)).orderBy(desc(paymentProofs.createdAt), desc(paymentProofs.id));
  const duplicateIds = proofs.flatMap((proof) => (proof.duplicateOf ? [proof.duplicateOf] : []));
  const duplicates = duplicateIds.length
    ? await db
        .select({ proofId: paymentProofs.id, orderRef: orders.ref })
        .from(paymentProofs)
        .innerJoin(payments, eq(payments.id, paymentProofs.paymentId))
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(inArray(paymentProofs.id, duplicateIds))
    : [];
  const names = await employeeNames(
    db,
    proofs.map((proof) => proof.reviewedBy),
  );
  const seeImage = can(actor, "payment_proof.read");
  const view = (proof: (typeof proofs)[number]): ProofView => ({
    id: proof.id,
    status: proof.status,
    declaredAmountIqd: proof.declaredAmountIqd,
    reference: proof.reference,
    note: proof.note,
    createdAt: proof.createdAt,
    reviewedBy: proof.reviewedBy ? (names.get(proof.reviewedBy) ?? proof.reviewedBy) : null,
    reviewedAt: proof.reviewedAt,
    reviewNote: proof.reviewNote,
    duplicateOf: proof.duplicateOf ? { proofId: proof.duplicateOf, orderRef: duplicates.find((row) => row.proofId === proof.duplicateOf)?.orderRef ?? null } : null,
    ...(seeImage ? { imageUrl: imageUrl(proof.id) } : {}),
  });
  const current = proofs.find((proof) => proof.status === "submitted") ?? null;
  return {
    paymentId: payment.id,
    status: payment.status,
    method: payment.method,
    dueIqd: payment.amountIqd,
    order: {
      id: order.id,
      ref: order.ref,
      status: order.status,
      totalIqd: order.totalIqd,
      placedAt: order.placedAt,
      contactName: order.contactName,
      customerProfileId: customerProfileId(actor, order.customerId),
      phone: phoneFor(actor, order.contactPhoneE164),
      isDemo: order.isDemo,
      onHold: order.reviewStatus === "blocked",
    },
    current: current ? view(current) : null,
    history: proofs.filter((proof) => proof !== current).map(view),
    canOverride: can(actor, "orders.payment.override"),
    canSeeImage: seeImage,
  };
}

/** The proof's private file — only for payment_proof.read (the image route serves it with no-store headers). */
export async function proofFileOf(db: Db, actor: Actor, proofId: string): Promise<{ fileId: string } | null> {
  assertCan(actor, "payment_proof.read");
  const row = await db.select({ fileId: paymentProofs.fileId }).from(paymentProofs).where(eq(paymentProofs.id, proofId)).get();
  return row ?? null;
}

export type RefundQueueRow = {
  refundId: string;
  orderId: string;
  orderRef: string;
  paymentId: string;
  paymentMethod: AnyPaymentMethod;
  amountIqd: number;
  /** What is still refundable on the payment right now (the ceiling the database enforces). */
  refundableIqd: number;
  method: "original" | "wallet" | "cash";
  reason: string | null;
  source: string | null;
  requestedBy: string | null;
  createdAt: number;
  mine: boolean;
  needsReference: boolean;
  isDemo: boolean;
};

/** Refunds waiting for a decision, oldest first, with who asked for them. */
export async function listRefundQueue(db: Db, actor: Actor): Promise<{ rows: RefundQueueRow[]; canApprove: boolean }> {
  if (!canAny(actor, ["orders.refund.approve", "orders.refund.create"])) throw forbidden("orders.refund.approve");
  const rows = await db
    .select({
      refundId: refunds.id,
      orderId: refunds.orderId,
      paymentId: refunds.paymentId,
      amountIqd: refunds.amountIqd,
      method: refunds.method,
      reason: refunds.reason,
      createdBy: refunds.createdBy,
      createdAt: refunds.createdAt,
      orderRef: orders.ref,
      isDemo: orders.isDemo,
      paymentMethod: payments.method,
      source: sql<string | null>`(SELECT json_extract(a.payload, '$.source') FROM approvals a WHERE a.entity_type = 'refund' AND a.entity_id = ${refunds.id} ORDER BY a.created_at DESC LIMIT 1)`,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(eq(refunds.status, "pending"))
    .orderBy(asc(refunds.createdAt), asc(refunds.id))
    .limit(200);
  const me = actor.kind === "employee" ? actor.id : null;
  const canApprove = can(actor, "orders.refund.approve");
  // Without the approval permission an employee follows only the requests they made themselves.
  const visible = canApprove ? rows : rows.filter((row) => row.createdBy === me);
  const names = await employeeNames(
    db,
    visible.map((row) => row.createdBy),
  );
  const refundable = new Map<string, number>();
  for (const row of visible) if (!refundable.has(row.paymentId)) refundable.set(row.paymentId, await getRefundableAmount(db, row.paymentId));
  return {
    canApprove,
    rows: visible.map((row) => ({
      refundId: row.refundId,
      orderId: row.orderId,
      orderRef: row.orderRef,
      paymentId: row.paymentId,
      paymentMethod: row.paymentMethod,
      amountIqd: row.amountIqd,
      refundableIqd: refundable.get(row.paymentId) ?? 0,
      method: row.method,
      reason: row.reason,
      source: row.source,
      requestedBy: row.createdBy ? (names.get(row.createdBy) ?? row.createdBy) : null,
      createdAt: row.createdAt,
      mine: row.createdBy !== null && row.createdBy === me,
      needsReference: refundDestination(row.method, row.paymentMethod).needsReference,
      isDemo: row.isDemo,
    })),
  };
}
