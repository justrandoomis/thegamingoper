/**
 * Admin 07.07 — the communication log of a customer, linked to their orders, without sensitive financial data.
 *
 *   await listCommunication(db, actor, { customerId, orderRef? }, now)                       customers.communication.read
 *   await logContact(db, actor, { customerId, channel, direction, orderRef?, summary }, now) customers.customer.note
 *
 * Two kinds of rows, newest first:
 *   · messages the store wrote to the customer — the outbox (`outbox`): every order notification and one-time-code
 *     request for the customer, their orders or their number. NO PROVIDER IS CONFIGURED: they are `held`, and the log
 *     says "not sent" — never "delivered". Only the facts of the event are shown (MESSAGE_SAFE_FIELDS: status,
 *     tracking number, expected day…); amounts, payment ids, references, the reason a transfer was refused and any
 *     other field are left out and counted as hidden. One-time codes never rest in the outbox at all.
 *   · contacts staff logged by hand (a call from the shop's phone, a WhatsApp chat, a visit): an append-only audit
 *     event "customers.contact.log" (who, when, channel, direction, the order it is about, a short summary). A summary
 *     with a card or account number (12+ digits in a row) is refused.
 * Recipients' phones follow customer.phone.read_full.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, customers, orders, outbox } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { AppError, invalid } from "~/server/errors";
import { cleanBlock } from "~/server/text.server";
import { changeableCustomer, customerById, employeeNames, hasLongDigitRun, ID, phoneView } from "./shared.server";
import { CONTACT_CHANNELS, CONTACT_DIRECTIONS, MESSAGE_SAFE_FIELDS, type ContactChannel, type ContactDirection, type PhoneView } from "./types";

export const CONTACT_ACTION = "customers.contact.log";
const LOG_LIMIT = 100;

export type MessageRow = {
  kind: "message";
  id: string;
  channel: string;
  template: string;
  status: "held" | "queued" | "sent" | "failed";
  recipient: PhoneView | null;
  orderRef: string | null;
  at: number;
  sentAt: number | null;
  /** Safe facts of the event, by field name. */
  facts: { field: string; value: string }[];
  /** Fields left out (amounts, payment ids, references, reasons…). */
  hidden: number;
};
export type ContactRow = { kind: "contact"; id: string; channel: ContactChannel; direction: ContactDirection; orderRef: string | null; summary: string; by: string | null; at: number };
export type CommunicationRow = MessageRow | ContactRow;

export type CommunicationLog = {
  rows: CommunicationRow[];
  orders: { ref: string; placedAt: number }[];
  orderRef: string | null;
  canLog: boolean;
  readOnly: boolean;
  truncated: boolean;
};

const safe = new Set<string>(MESSAGE_SAFE_FIELDS);

function factsOf(payload: Record<string, unknown> | null | undefined): { facts: MessageRow["facts"]; hidden: number } {
  const facts: MessageRow["facts"] = [];
  let hidden = 0;
  for (const [field, value] of Object.entries(payload ?? {})) {
    if (field === "ref") continue; // shown as the order link
    if (safe.has(field) && (typeof value === "string" || typeof value === "number") && String(value).length <= 80) facts.push({ field, value: String(value) });
    else if (value !== null && value !== undefined) hidden++;
  }
  return { facts, hidden };
}

export async function listCommunication(db: Db, actor: Actor, input: { customerId: string; orderRef?: string | null }, now: number): Promise<CommunicationLog> {
  void now;
  assertCan(actor, "customers.communication.read");
  const row = await customerById(db, input.customerId);
  const merged = await db.select({ id: customers.id, phone: customers.phoneE164 }).from(customers).where(eq(customers.mergedIntoId, row.id));
  const subjectIds = [row.id, ...merged.map((account) => account.id)];
  const phones = [row.phoneE164, ...merged.map((account) => account.phone)].filter((phone) => phone.startsWith("+964"));
  const customerOrders = await db
    .select({ id: orders.id, ref: orders.ref, placedAt: orders.placedAt })
    .from(orders)
    .where(inArray(orders.customerId, subjectIds))
    .orderBy(desc(orders.placedAt));
  const refOf = new Map(customerOrders.map((order) => [order.id, order.ref]));
  const asked = input.orderRef ? input.orderRef.trim().toUpperCase() : null;
  const wanted = asked ? (customerOrders.find((order) => order.ref === asked) ?? null) : null;
  const orderIds = wanted ? [wanted.id] : customerOrders.map((order) => order.id);

  const messageWhere = wanted
    ? and(eq(outbox.refType, "order"), eq(outbox.refId, wanted.id))
    : or(
        inArray(outbox.customerId, subjectIds),
        orderIds.length ? and(eq(outbox.refType, "order"), inArray(outbox.refId, orderIds.slice(0, 80))) : undefined,
        phones.length ? inArray(outbox.recipient, phones) : undefined,
      );
  const [messages, contacts] = await Promise.all([
    db
      .select({ id: outbox.id, channel: outbox.channel, template: outbox.template, status: outbox.status, recipient: outbox.recipient, refType: outbox.refType, refId: outbox.refId, payload: outbox.payload, createdAt: outbox.createdAt, sentAt: outbox.sentAt })
      .from(outbox)
      .where(messageWhere)
      .orderBy(desc(outbox.createdAt), desc(outbox.id))
      .limit(LOG_LIMIT + 1),
    db
      .select({ id: auditEvents.id, after: auditEvents.after, actorId: auditEvents.actorId, actorLabel: auditEvents.actorLabel, at: auditEvents.at })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, CONTACT_ACTION), eq(auditEvents.entityType, "customer"), inArray(auditEvents.entityId, subjectIds)))
      .orderBy(desc(auditEvents.seq))
      .limit(LOG_LIMIT + 1),
  ]);
  const names = await employeeNames(
    db,
    contacts.map((contact) => contact.actorId),
  );
  const fullPhone = can(actor, "customer.phone.read_full");
  const messageRows: MessageRow[] = messages.map((message) => {
    const { facts, hidden } = factsOf(message.payload);
    return {
      kind: "message",
      id: message.id,
      channel: message.channel,
      template: message.template,
      status: message.status,
      recipient: phoneView(message.recipient, fullPhone),
      orderRef: message.refType === "order" && message.refId ? (refOf.get(message.refId) ?? null) : null,
      at: message.createdAt,
      sentAt: message.sentAt ?? null,
      facts,
      hidden,
    };
  });
  const contactRows: ContactRow[] = contacts
    .map((contact): ContactRow => {
      const after = (contact.after ?? {}) as { channel?: string; direction?: string; orderRef?: string | null; summary?: string };
      return {
        kind: "contact",
        id: contact.id,
        channel: (CONTACT_CHANNELS as readonly string[]).includes(after.channel ?? "") ? (after.channel as ContactChannel) : "other",
        direction: after.direction === "inbound" ? "inbound" : "outbound",
        orderRef: after.orderRef ?? null,
        summary: String(after.summary ?? ""),
        by: (contact.actorId && names.get(contact.actorId)) || contact.actorLabel || null,
        at: contact.at,
      };
    })
    .filter((contact) => !wanted || contact.orderRef === wanted.ref);
  const rows = [...messageRows, ...contactRows].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return {
    rows: rows.slice(0, LOG_LIMIT),
    orders: customerOrders.slice(0, 50).map((order) => ({ ref: order.ref, placedAt: order.placedAt })),
    orderRef: wanted?.ref ?? null,
    canLog: can(actor, "customers.customer.note") && row.status !== "merged" && row.status !== "deleted",
    readOnly: row.status === "merged" || row.status === "deleted",
    truncated: messages.length > LOG_LIMIT || contacts.length > LOG_LIMIT || rows.length > LOG_LIMIT,
  };
}

export const LogContactInput = z.object({
  customerId: z.string().regex(ID, "invalid"),
  channel: z.enum(CONTACT_CHANNELS, { error: "required" }),
  direction: z.enum(CONTACT_DIRECTIONS, { error: "required" }),
  orderRef: z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().trim().toUpperCase().max(40, "invalid").optional()),
  summary: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "too_short").max(500, "too_long"),
});
export type LogContactInput = z.input<typeof LogContactInput>;

/** Logs a contact staff had with the customer (append-only), optionally about one of their orders. */
export async function logContact(db: Db, actor: Actor, raw: LogContactInput, now: number): Promise<{ contactId: string }> {
  assertCan(actor, "customers.customer.note");
  const input = LogContactInput.parse(raw);
  if (hasLongDigitRun(input.summary)) throw new AppError("invalid", 400, { fields: { summary: "note_has_card_number" } });
  const row = await changeableCustomer(db, input.customerId);
  let order: { id: string; ref: string } | null = null;
  if (input.orderRef) {
    const merged = await db.select({ id: customers.id }).from(customers).where(eq(customers.mergedIntoId, row.id));
    order =
      (await db
        .select({ id: orders.id, ref: orders.ref })
        .from(orders)
        .where(and(eq(orders.ref, input.orderRef), inArray(orders.customerId, [row.id, ...merged.map((account) => account.id)])))
        .get()) ?? null;
    // Another customer's order (or none): the same answer.
    if (!order) throw invalid({ orderRef: "not_found" });
  }
  const contactId = newId("aud");
  await runBatch(db, [
    auditStatement(db, {
      id: contactId,
      actor,
      action: CONTACT_ACTION,
      entityType: "customer",
      entityId: row.id,
      after: { channel: input.channel, direction: input.direction, orderId: order?.id ?? null, orderRef: order?.ref ?? null, summary: input.summary },
      at: now,
    }),
  ]);
  return { contactId };
}

/** Held messages waiting for a provider, for this customer (the profile's line). */
export async function heldMessageCount(db: Db, customerId: string): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(outbox)
    .where(and(eq(outbox.customerId, customerId), eq(outbox.status, "held")))
    .get();
  return Number(row?.n ?? 0);
}
