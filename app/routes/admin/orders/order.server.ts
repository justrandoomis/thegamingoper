/**
 * The order page's action (/admin/orders/:ref) — one POST endpoint, many intents, each handled by a service that
 * checks its own permission (assertCan) and validates its input (zod). Kept apart from the route module so tests
 * can call it with a hand-made session and form. Every id in the form is scoped to the URL's order (a payment or
 * refund of another order is not_found; refund requests are checked by createRefund itself).
 *
 *   transition       changeOrderStatus  (transitionOrder; hold and packing rules)        orders.* per transition
 *   verify           verifyProof        (verifyPayment)                                  orders.payment.verify (+ .override)
 *   cod              collectCod         (recordCodCollection)                            orders.payment.record (+ .override)
 *   refund           requestRefund      (createRefund, idempotency key)                  orders.refund.create
 *   refund-decision  decideRefund       (approveRefund, never the requester)             orders.refund.approve
 *   assign           assignOrder                                                         orders.order.assign
 *   note             addNote                                                             orders.order.note
 *   review           decideReview                                                        orders.risk.review (flag: .note too)
 *   preorder         setPreorder                                                         orders.preorder.manage
 *   invoice          issueInvoices                                                       orders.document.print
 *   delivery-proof   private upload + recordDeliveryProof                                orders.fulfillment.deliver | shipping.proof.manage
 */
import { can } from "~/server/actor";
import type { AuthCtx, EmployeeSession } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import { AppError, forbidden, invalid } from "~/server/errors";
import { saveImageUpload } from "~/server/uploads.server";
import type { BlobStore } from "~/server/storage.server";
import { addNote, changeOrderStatus, collectCod, decideRefund, requestRefund, setPreorder, verifyProof } from "~/server/services/admin/orders/actions.server";
import { issueInvoices } from "~/server/services/admin/orders/documents.server";
import { assignOrder, recordDeliveryProof } from "~/server/services/admin/orders/fulfillment.server";
import { decideReview } from "~/server/services/admin/orders/risk.server";
import { orderByRef } from "~/server/services/admin/orders/shared.server";
import { amountOf, failure, text, type Failure } from "./common.server";

export const ORDER_INTENTS = ["transition", "verify", "cod", "refund", "refund-decision", "assign", "note", "review", "preorder", "invoice", "delivery-proof"] as const;
export type OrderIntent = (typeof ORDER_INTENTS)[number];

export type OrderActionResult = { ok: true; intent: OrderIntent; replayed?: boolean; status?: string } | Failure;

const yes = (value: string) => value === "1" || value === "true" || value === "on";

export async function orderAction(ctx: Pick<AuthCtx, "locale" | "now">, db: Db, session: EmployeeSession, ref: string, form: FormData, store: () => BlobStore): Promise<OrderActionResult> {
  const raw = text(form, "intent");
  const intent = (ORDER_INTENTS as readonly string[]).includes(raw) ? (raw as OrderIntent) : null;
  const { actor } = session;
  const now = ctx.now;
  try {
    const order = await orderByRef(db, ref);
    switch (intent) {
      case "transition": {
        const result = await changeOrderStatus(
          db,
          actor,
          order.id,
          {
            to: text(form, "to") as never,
            from: (text(form, "from") || undefined) as never,
            reason: text(form, "reason") || undefined,
            trackingNo: text(form, "trackingNo") || undefined,
            carrierId: text(form, "carrierId") || undefined,
          },
          now,
        );
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
      case "verify": {
        // Scoped to this page's order: a payment id of another order is not_found.
        const result = await verifyProof(db, actor, text(form, "paymentId"), { approve: yes(text(form, "approve")), receivedAmountIqd: amountOf(form, "receivedAmountIqd"), note: text(form, "note") || undefined }, now, { orderId: order.id });
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
      case "cod": {
        const result = await collectCod(db, actor, order.id, { amountIqd: amountOf(form, "amountIqd") as number, reason: text(form, "reason") || undefined }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "refund": {
        const result = await requestRefund(
          db,
          actor,
          {
            orderId: order.id,
            paymentId: text(form, "paymentId"),
            amountIqd: amountOf(form, "amountIqd") as number,
            method: text(form, "method") as never,
            reason: text(form, "reason"),
            reference: text(form, "reference") || undefined,
            idempotencyKey: text(form, "idempotencyKey"),
          },
          now,
        );
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
      case "refund-decision": {
        const result = await decideRefund(db, actor, text(form, "refundId"), { approve: yes(text(form, "approve")), note: text(form, "note") || undefined, reference: text(form, "reference") || undefined }, now, { orderId: order.id });
        return { ok: true, intent, status: result.status };
      }
      case "assign": {
        const result = await assignOrder(db, actor, order.id, { employeeId: text(form, "employeeId") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "note":
        await addNote(db, actor, order.id, { text: text(form, "text") }, now);
        return { ok: true, intent };
      case "review": {
        const result = await decideReview(db, actor, order.id, { decision: text(form, "decision") as never, reason: text(form, "reason") }, now);
        return { ok: true, intent, status: result.status };
      }
      case "preorder": {
        const result = await setPreorder(db, actor, order.id, { isPreorder: yes(text(form, "isPreorder")), expectedDay: text(form, "expectedDay") || undefined, reason: text(form, "reason"), notify: yes(text(form, "notify") || "1") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "invoice": {
        const result = await issueInvoices(db, actor, [order.id], now);
        return { ok: true, intent, replayed: result.issued === 0 };
      }
      case "delivery-proof": {
        // Authorize before anything is stored: no file of an employee who may not record a proof reaches storage.
        if (!can(actor, "orders.fulfillment.deliver") && !can(actor, "shipping.proof.manage")) throw forbidden("orders.fulfillment.deliver");
        if (order.status !== "shipped" && order.status !== "delivered") throw new AppError("proof_not_shipped", 409, { detail: order.status });
        if (text(form, "receivedByName").trim().length < 2) throw invalid({ receivedByName: "required" });
        const { file } = await saveImageUpload(db, store(), form.get("file"), { visibility: "private", kind: "delivery_proof", ownerType: "order", ownerId: order.id, createdBy: actor, now });
        await recordDeliveryProof(db, actor, order.id, { fileId: file.id, receivedByName: text(form, "receivedByName") }, now);
        return { ok: true, intent };
      }
      default:
        return { ok: false, intent: null, code: "invalid", status: 400 };
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}
