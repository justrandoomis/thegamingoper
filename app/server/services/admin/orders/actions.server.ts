/**
 * What staff do to an order from the admin — thin wrappers around the commerce core (CONTRACTS §1) plus the module's
 * own rules. Nothing here writes stock, money or an order's status itself: those go through transitionOrder,
 * verifyPayment, recordCodCollection, createRefund / approveRefund and editOrder, which authorize, validate, guard and
 * audit them in one batch.
 *
 *   await changeOrderStatus(db, actor, orderId, { to: "cancelled", reason, from: "confirmed" }, now)
 *   await verifyProof(db, actor, paymentId, { approve: true, receivedAmountIqd }, now)
 *   await collectCod(db, actor, orderId, { amountIqd }, now)
 *   await requestRefund(db, actor, { orderId, paymentId, amountIqd, method, reason, idempotencyKey }, now)
 *   await decideRefund(db, actor, refundId, { approve: false, note }, now)
 *   await addNote(db, actor, orderId, { text }, now)
 *   await setPreorder(db, actor, orderId, { isPreorder: true, expectedDay: "2027-02-04", reason }, now)
 *
 * The module's own rules, on top of the core:
 *   · an order on HOLD (05.09 review) is not moved forward (confirmed, preparing, shipped, delivered): order_on_hold
 *   · SHIPPING needs every line verified at the packing station (04.11): packing_incomplete
 *   · after a status change the order's parcels and packing tasks follow, and the customer gets a HELD message (no
 *     provider) — these run after the core's batch, guarded and idempotent, so a retry repairs a missing one
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { actorRef, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { carriers, orderEvents, orders, payments, refunds, type Order } from "~/server/db/schema";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { canTransition } from "~/server/services/orders/state";
import { recordCodCollection, verifyPayment } from "~/server/services/payments/payments.server";
import { approveRefund, createRefund } from "~/server/services/refunds.server";
import { closeTasksStatement, packProgress, parcelsDeliveredStatements, parcelsShippedStatements } from "./fulfillment.server";
import { notifyOrderContact, ORDER_TEMPLATES } from "./notify.server";
import { orderById } from "./shared.server";
import { ORDER_STATUS_LIST, validDay } from "./types";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
const FORWARD = new Set(["confirmed", "preparing", "shipped", "delivered"]);

export const StatusChangeInput = z.object({
  to: z.enum(ORDER_STATUS_LIST),
  /** The status the employee saw: when the order has moved on since, nothing happens (order_changed). */
  from: z.enum(ORDER_STATUS_LIST).optional(),
  reason: z
    .string()
    .trim()
    .max(500, "too_long")
    .optional()
    .transform((value) => value || undefined),
  trackingNo: z
    .string()
    .trim()
    .max(80, "too_long")
    .optional()
    .transform((value) => value || null),
  carrierId: z
    .union([z.literal(""), idSchema])
    .optional()
    .transform((value) => value || null),
});
export type StatusChangeInput = z.input<typeof StatusChangeInput>;

/** Moves an order (05.01) through the core's state machine, then lets parcels, tasks and notifications follow. */
export async function changeOrderStatus(db: Db, actor: Actor, orderId: string, raw: StatusChangeInput, now: number): Promise<{ status: Order["status"]; replayed: boolean }> {
  const input = StatusChangeInput.parse(raw);
  const order = await orderById(db, orderId);
  if (order.status === input.to) return { status: order.status, replayed: true };
  if (input.from && order.status !== input.from) throw new AppError("order_changed", 409, { detail: `${order.status}, expected ${input.from}` });
  if (order.reviewStatus === "blocked" && FORWARD.has(input.to)) throw new AppError("order_on_hold", 409, { detail: order.id });
  if (input.to === "shipped" && canTransition(order.status, "shipped")) {
    assertCan(actor, "orders.fulfillment.ship");
    const progress = await packProgress(db, order.id);
    if (!progress.complete) throw new AppError("packing_incomplete", 409, { detail: order.id });
    if (input.carrierId) {
      const carrier = await db.select({ id: carriers.id }).from(carriers).where(and(eq(carriers.id, input.carrierId), eq(carriers.isActive, true))).get();
      if (!carrier) throw invalid({ carrierId: "invalid" });
    }
  }

  await transitionOrder(db, actor, order.id, input.to, { reason: input.reason, from: input.from ?? order.status }, now);

  // What follows the core's batch (idempotent: deterministic ids, guarded updates, outbox dedupe keys).
  const follow: BatchStatement[] = [];
  if (input.to === "shipped") follow.push(...parcelsShippedStatements(db, actor, order.id, { trackingNo: input.trackingNo, carrierId: input.carrierId }, now));
  if (input.to === "delivered") follow.push(...parcelsDeliveredStatements(db, actor, order.id, now));
  if (input.to === "cancelled") {
    follow.push(
      closeTasksStatement(db, order.id, "cancelled", now),
      batchSql(db, sql`UPDATE shipments SET status = 'cancelled', updated_at = ${now} WHERE order_id = ${order.id} AND status IN ('pending', 'packed')`),
    );
  }
  if (input.to === "returned" && order.status === "shipped") {
    follow.push(batchSql(db, sql`UPDATE shipments SET status = 'returned', returned_at = ${now}, updated_at = ${now} WHERE order_id = ${order.id} AND status IN ('handed_over', 'in_transit', 'out_for_delivery', 'failed', 'returning')`));
  }
  if (follow.length) await runBatch(db, follow);

  const template =
    input.to === "confirmed"
      ? ORDER_TEMPLATES.confirmed
      : input.to === "shipped"
        ? ORDER_TEMPLATES.shipped
        : input.to === "delivered"
          ? ORDER_TEMPLATES.delivered
          : input.to === "cancelled"
            ? ORDER_TEMPLATES.cancelled
            : input.to === "returned"
              ? ORDER_TEMPLATES.returned
              : null;
  if (template) await notifyOrderContact(db, order, template, { status: input.to, trackingNo: input.to === "shipped" ? input.trackingNo : null }, `status:${input.to}`, now);
  return { status: input.to, replayed: false };
}

export const VerifyProofInput = z.object({
  approve: z.boolean(),
  receivedAmountIqd: z.number().int("invalid").min(1, "too_small").max(1_000_000_000, "too_big").optional(),
  note: z
    .string()
    .trim()
    .max(500, "too_long")
    .optional()
    .transform((value) => value || undefined),
});
export type VerifyProofInput = z.input<typeof VerifyProofInput>;

/** Where an action was sent from: an order page acts only on that order's payments and refunds. */
export type OrderScope = { orderId?: string };

/**
 * Approves or rejects the waiting proof of a transfer payment (verifyPayment: declared AND received amounts must equal
 * what is due, otherwise orders.payment.override and a reason). An order on hold cannot be approved. With
 * `scope.orderId` (an order page) a payment of another order is not_found.
 */
export async function verifyProof(db: Db, actor: Actor, paymentId: string, raw: VerifyProofInput, now: number, scope: OrderScope = {}) {
  assertCan(actor, "orders.payment.verify");
  const input = VerifyProofInput.parse(raw);
  const payment = await db.select({ orderId: payments.orderId }).from(payments).where(eq(payments.id, paymentId)).get();
  if (scope.orderId !== undefined && payment?.orderId !== scope.orderId) throw notFound("payment");
  if (payment && input.approve) {
    const order = await orderById(db, payment.orderId);
    if (order.reviewStatus === "blocked") throw new AppError("order_on_hold", 409, { detail: order.id });
  }
  const result = await verifyPayment(db, actor, paymentId, { approve: input.approve, receivedAmountIqd: input.receivedAmountIqd, note: input.note }, now);
  if (!result.replayed && payment) {
    const order = await orderById(db, payment.orderId);
    if (result.status === "paid") await notifyOrderContact(db, order, ORDER_TEMPLATES.paymentVerified, { paymentId }, `payment:${paymentId}:verified`, now);
    else await notifyOrderContact(db, order, ORDER_TEMPLATES.paymentRejected, { paymentId, reason: input.note ?? null }, `payment:${paymentId}:rejected:${now}`, now);
  }
  return result;
}

export const CodInput = z.object({
  amountIqd: z.number().int("invalid").min(1, "too_small").max(1_000_000_000, "too_big"),
  reason: z
    .string()
    .trim()
    .max(500, "too_long")
    .optional()
    .transform((value) => value || undefined),
});
export type CodInput = z.input<typeof CodInput>;

/** Cash collected on delivery (recordCodCollection; a different amount needs orders.payment.override and a reason). */
export async function collectCod(db: Db, actor: Actor, orderId: string, raw: CodInput, now: number) {
  const input = CodInput.parse(raw);
  return recordCodCollection(db, actor, orderId, input.amountIqd, now, { reason: input.reason });
}

export const RefundRequestInput = z.object({
  orderId: idSchema,
  paymentId: idSchema,
  amountIqd: z.number().int("invalid").min(1, "too_small").max(10_000_000_000, "too_big"),
  method: z.enum(["original", "wallet", "cash"]),
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
  reference: z
    .string()
    .trim()
    .max(100, "too_long")
    .optional()
    .transform((value) => value || undefined),
  idempotencyKey: z.string().trim().min(8, "too_short").max(200, "too_long"),
});
export type RefundRequestInput = z.input<typeof RefundRequestInput>;

/** A refund request (createRefund: never above what is refundable on the payment; above the threshold it waits for a second person). */
export async function requestRefund(db: Db, actor: Actor, raw: RefundRequestInput, now: number) {
  const input = RefundRequestInput.parse(raw);
  return createRefund(db, actor, { orderId: input.orderId, paymentId: input.paymentId, amountIqd: input.amountIqd, method: input.method, reason: input.reason, reference: input.reference, idempotencyKey: input.idempotencyKey }, now);
}

export const RefundDecisionInput = z.object({
  approve: z.boolean(),
  note: z
    .string()
    .trim()
    .max(500, "too_long")
    .optional()
    .transform((value) => value || null),
  reference: z
    .string()
    .trim()
    .max(100, "too_long")
    .optional()
    .transform((value) => value || null),
});
export type RefundDecisionInput = z.input<typeof RefundDecisionInput>;

/**
 * The second person's decision on a waiting refund (approveRefund refuses the requester: approver_is_requester). With
 * `scope.orderId` (an order page) a refund of another order is not_found.
 */
export async function decideRefund(db: Db, actor: Actor, refundId: string, raw: RefundDecisionInput, now: number, scope: OrderScope = {}) {
  assertCan(actor, "orders.refund.approve");
  const input = RefundDecisionInput.parse(raw);
  if (scope.orderId !== undefined) {
    const refund = typeof refundId === "string" && refundId ? await db.select({ orderId: refunds.orderId }).from(refunds).where(eq(refunds.id, refundId)).get() : undefined;
    if (refund?.orderId !== scope.orderId) throw notFound("refund");
  }
  return approveRefund(db, actor, refundId, { approve: input.approve, note: input.note, reference: input.reference }, now);
}

export const NoteInput = z.object({ text: z.string().trim().min(2, "required").max(1000, "too_long") });
export type NoteInput = z.input<typeof NoteInput>;

/** An internal note on the order's history (order event + audit). Staff only; never shown to the shopper. */
export async function addNote(db: Db, actor: Actor, orderId: string, raw: NoteInput, now: number): Promise<{ eventId: string }> {
  assertCan(actor, "orders.order.note");
  const input = NoteInput.parse(raw);
  const order = await orderById(db, orderId);
  const { actorKind, actorId } = actorRef(actor);
  const eventId = newId("oev");
  await runBatch(db, [
    db.insert(orderEvents).values({ id: eventId, orderId: order.id, kind: "note", data: { text: input.text }, actorKind, actorId, at: now }),
    auditStatement(db, { actor, action: "orders.order.note", entityType: "order", entityId: order.id, after: { note: input.text.slice(0, 200) }, at: now }),
  ]);
  return { eventId };
}

const BAGHDAD_OFFSET = 3 * 60 * 60 * 1000;

export const PreorderInput = z.object({
  isPreorder: z.boolean(),
  /** Expected availability, a real Baghdad calendar day ("YYYY-MM-DD"); required for a pre-order. */
  expectedDay: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null)
    .refine((value) => value === null || validDay(value) === value, "invalid"),
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
  /** Hold a "new date" message for the customer (no provider: written, not sent). */
  notify: z.boolean().default(true),
});
export type PreorderInput = z.input<typeof PreorderInput>;

const PREORDER_OPEN = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing"] as const;

/**
 * 05.07 — marks an order as a pre-order with its expected date, or changes the date (a delay update: order event
 * "preorder_delayed" and a held message to the customer). Noon in Baghdad on the expected day is stored.
 */
export async function setPreorder(db: Db, actor: Actor, orderId: string, raw: PreorderInput, now: number): Promise<{ expectedAt: number | null; delayed: boolean; replayed: boolean }> {
  assertCan(actor, "orders.preorder.manage");
  const input = PreorderInput.parse(raw);
  if (input.isPreorder && !input.expectedDay) throw invalid({ expectedDay: "required" });
  const order = await orderById(db, orderId);
  if (!(PREORDER_OPEN as readonly string[]).includes(order.status)) throw new AppError("preorder_not_open", 409, { detail: order.status });
  const expectedAt = input.isPreorder && input.expectedDay ? Date.parse(`${input.expectedDay}T12:00:00Z`) - BAGHDAD_OFFSET : null;
  if (order.isPreorder === input.isPreorder && order.expectedAt === expectedAt) return { expectedAt, delayed: false, replayed: true };
  const delayed = order.isPreorder && input.isPreorder && order.expectedAt !== null && expectedAt !== null && expectedAt > order.expectedAt;
  const { actorKind, actorId } = actorRef(actor);
  await runBatch(db, [
    db
      .update(orders)
      .set({ isPreorder: input.isPreorder, expectedAt, updatedAt: now })
      .where(eq(orders.id, order.id)),
    db.insert(orderEvents).values({
      id: newId("oev"),
      orderId: order.id,
      kind: delayed ? "preorder_delayed" : "preorder_updated",
      data: { isPreorder: input.isPreorder, from: order.expectedAt, to: expectedAt, reason: input.reason },
      actorKind,
      actorId,
      at: now,
    }),
    auditStatement(db, {
      actor,
      action: "orders.preorder.update",
      entityType: "order",
      entityId: order.id,
      before: { isPreorder: order.isPreorder, expectedAt: order.expectedAt },
      after: { isPreorder: input.isPreorder, expectedAt },
      reason: input.reason,
      at: now,
    }),
  ]);
  if (input.notify && input.isPreorder && expectedAt !== null) {
    await notifyOrderContact(db, order, ORDER_TEMPLATES.preorderDate, { expectedDay: input.expectedDay, delayed: delayed ? 1 : 0 }, `preorder:${expectedAt}`, now);
  }
  return { expectedAt, delayed, replayed: false };
}

/** Payments of an order by id (for the forms' validation). */
export async function paymentIdsOf(db: Db, orderId: string): Promise<string[]> {
  return (await db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId))).map((row) => row.id);
}
