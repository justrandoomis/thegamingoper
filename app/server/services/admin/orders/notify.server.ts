/**
 * Customer notifications of an order (05.06 / 05.08) — written to the outbox, never sent here.
 *
 * NO SMS, WHATSAPP OR EMAIL PROVIDER IS CONFIGURED (~/server/outbox.server): every message is stored as `held` and
 * the order page says so ("محجوزة — لا يوجد مزوّد رسائل، لم يُرسل شيء"). Nothing claims it was delivered. When the
 * integrations module connects a provider, the same rows become `queued` and the outbox job sends them.
 *
 * One message per event and order (`dedupeKey`), so a retried request never notifies twice. The payload carries the
 * order reference and the facts of the event — never cost data, never a token.
 */
import type { Db } from "~/server/db/drizzle.server";
import type { Order } from "~/server/db/schema";
import { enqueueMessage } from "~/server/outbox.server";

export const ORDER_TEMPLATES = {
  confirmed: "order_confirmed",
  shipped: "order_shipped",
  delivered: "order_delivered",
  cancelled: "order_cancelled",
  returned: "order_returned",
  paymentVerified: "payment_verified",
  paymentRejected: "payment_rejected",
  preorderDate: "preorder_date_changed",
  edited: "order_edited",
} as const;
export type OrderTemplate = (typeof ORDER_TEMPLATES)[keyof typeof ORDER_TEMPLATES];

/** Holds an SMS to the order's contact phone. Returns the outbox row id (an existing one for a repeat), or null without a phone. */
export async function notifyOrderContact(
  db: Db,
  order: Pick<Order, "id" | "ref" | "contactPhoneE164" | "locale" | "customerId">,
  template: OrderTemplate,
  payload: Record<string, string | number | null>,
  dedupeKey: string,
  now: number,
): Promise<string | null> {
  if (!order.contactPhoneE164) return null;
  const result = await enqueueMessage(db, {
    channel: "sms",
    recipient: order.contactPhoneE164,
    template,
    payload: { ref: order.ref, ...payload },
    locale: order.locale,
    customerId: order.customerId,
    refType: "order",
    refId: order.id,
    dedupeKey: `order:${order.id}:${dedupeKey}`,
    now,
  });
  return result.id;
}
