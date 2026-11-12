/**
 * Tickets (14.01, 14.02): one ticket with everything it is about — the customer (module 07's profile), the order, the
 * product, the warranty, the repair and the return, each kept by its id (the entity rule: never by a name) — and the
 * work on it: replies, internal notes, customer messages staff record, status, priority and category, links, the
 * person who holds it. Escalation is escalation.server.ts, routing routing.server.ts.
 *
 *   const ticket = await getTicket(db, actor, "SP-7K4M2Q9X", locale, now, { file: (id) => `/admin/support/files/${id}` });
 *   await replyToTicket(db, actor, { ticketId, body, via: "whatsapp", then: "pending_customer", idempotencyKey }, now);
 *   await openStaffTicket(db, actor, { channel: "phone", phone, subject, category, message, idempotencyKey }, now, "live");
 *
 * BOUNDARY — messages: no SMS, WhatsApp or e-mail provider is connected. A written reply is stored on the ticket (the
 * shopper reads it on their ticket page when they kept its link) and HELD in the outbox (`held`, never "sent"); a call
 * or a talk at the counter is recorded as such. A message the customer sent on another channel is typed in by staff
 * ("recorded by …, via WhatsApp").
 * Replies are reviewed by the person who records them: a canned reply only fills the composer, and a text that still
 * holds a `{variable}` is refused. The first public reply sets `first_responded_at` (the first-response clock).
 * Every change is one guarded batch (the status / holder the page showed is checked inside it) with its audit event;
 * the ticket page's history is read from those events.
 *
 * Who: reading — support.ticket.read; replying, notes, recorded messages, links, status — support.ticket.reply; closing
 * or reopening a closed ticket — support.ticket.close; assigning, priority, category, team — support.ticket.assign
 * (taking an unassigned ticket for oneself only needs support.ticket.reply). A ticket under escalation is resolved or
 * closed only by the person it was escalated to.
 * Errors: forbidden (403), not_found (404), invalid (400), ticket_changed · transition_not_allowed · ticket_closed ·
 * escalation_open · order_other_customer · warranty_other_order · link_not_found · assignee_not_agent ·
 * take_only_unassigned (409); field keys unfilled_variable, no_phone, no_email, contact_required, reason_required.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef, sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { normalizeIraqPhone, toLatinDigits } from "~/lib/phone";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  assistantMessages,
  assistantSessions,
  auditEvents,
  cannedReplies,
  customers,
  files,
  orderItems,
  orders,
  outbox,
  products,
  repairTickets,
  returns,
  supportTickets,
  ticketMessages,
  variants,
  warranties,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  type NewSupportTicket,
  type NewTicketMessage,
  type SupportTicket,
} from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { outboxStatement } from "~/server/outbox.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { escalationTrail, settlesEscalation } from "./escalation.server";
import { activeRules, decideRoute, eligibleAgents, lastRouteDecision, ROUTE_ACTION } from "./routing.server";
import { agentsOf, employeeNames, isId, normalizeRepairRef, openLoadSql, openLoads, phoneView, ticketAudit, ticketById, ticketByRef } from "./shared.server";
import { dueTimesFor } from "./sla.server";
import {
  ESCALATION_KINDS,
  INBOUND_VIA,
  MESSAGE_VIA,
  OPEN_TICKET_STATUSES,
  REPLY_THEN,
  REPLY_VIA,
  STAFF_CHANNELS,
  STATUS_WITH_REASON,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  isOpenTicket,
  isRepairStatus,
  normalizeTeam,
  slaClock,
  unfilledPlaceholders,
  type AgentLoad,
  type EscalationKind,
  type InboundVia,
  type PersonRef,
  type PhoneView,
  type RepairStatus,
  type ReplyVia,
  type RouteDecision,
  type SlaClock,
  type TicketCategory,
  type TicketChannel,
  type TicketPriority,
  type TicketStatus,
} from "./types";

// ───────────────────────────────────────────────────────────────── view model

export type TicketPhoto = { id: string; url: string };

export type TicketMessageView = {
  kind: "message";
  id: string;
  at: number;
  author: "customer" | "employee" | "system" | "assistant";
  authorName: string | null;
  body: string;
  internal: boolean;
  photos: TicketPhoto[];
  /** How it travelled: a reply's channel, or where a recorded customer message came from. */
  via: ReplyVia | InboundVia | null;
  /** The outbox row of a written reply: always "held" while no provider is connected. */
  outbox: { channel: string; status: string } | null;
  /** The employee who typed in a customer's message. */
  recordedBy: string | null;
  /** The canned reply the text started from (it was reviewed and possibly edited before it was recorded). */
  fromCanned: { edited: boolean } | null;
};

export type TicketEventView = {
  kind: "event";
  id: string;
  at: number;
  action: string;
  actor: { kind: string; name: string | null };
  data: Record<string, string | number | boolean | null>;
  reason: string | null;
};

export type TicketTimelineItem = TicketMessageView | TicketEventView;

export type SlaView = { dueAt: number | null; doneAt: number | null; clock: SlaClock };

export type TicketDetail = {
  id: string;
  ref: string;
  subject: string;
  channel: TicketChannel;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  team: string | null;
  locale: Locale;
  tags: string[];
  isDemo: boolean;
  createdAt: number;
  updatedAt: number;
  contact: { name: string | null; phone: PhoneView | null; email: string | null };
  customer: { id: string; name: string | null; href: string | null } | null;
  /** An account with the ticket's phone when none is linked yet (staff decide). */
  customerSuggestion: { id: string; name: string | null } | null;
  order: { id: string; ref: string; status: string | null; placedAt: number | null; href: string | null } | null;
  product: { id: string; name: string; href: string | null } | null;
  warranty: { id: string; endsAt: number; state: "active" | "expired" | "void"; href: string | null } | null;
  repair: { id: string; ref: string; status: RepairStatus; href: string; workHref: string | null } | null;
  rma: { id: string; rma: string; status: string | null; href: string | null } | null;
  /** The kinds of record this employee may link (each needs its module's read permission). */
  linkable: LinkField[];
  /** Warranties the ticket may be linked to (of its order or its customer). */
  warrantyOptions: { id: string; endsAt: number; label: string }[];
  assistant: { summary: string | null; stored: boolean; messages: { role: string; content: string; confidence: string | null; flags: string[]; sources: number; at: number }[] | null } | null;
  assigned: PersonRef | null;
  sla: { firstResponse: SlaView; resolution: SlaView };
  escalation: { at: number; to: PersonRef | null; reason: string | null; kind: EscalationKind | null; handedBack: boolean } | null;
  routing: { at: number; decision: RouteDecision; bySystem: boolean } | null;
  timeline: TicketTimelineItem[];
  photos: TicketPhoto[];
  transitions: TicketStatus[];
  replyVia: ReplyVia[];
  /** handBack: the escalation's holder, or a cover who did not escalate it (escalation.server.ts settlesEscalation). */
  can: { reply: boolean; assign: boolean; take: boolean; resolve: boolean; close: boolean; escalate: boolean; route: boolean; readOrders: boolean; readCustomers: boolean; returns: boolean; rmaCreate: boolean; handBack: boolean };
  agents: AgentLoad[];
  canned: { id: string; title: string; category: TicketCategory | null }[];
};

// ───────────────────────────────────────────────────────────────── reading

const SAFE_EVENT_KEYS = new Set([
  "from",
  "to",
  "status",
  "priority",
  "category",
  "team",
  "field",
  "kind",
  "via",
  "ref",
  "channel",
  "ruleName",
  "fallback",
  "forced",
  "assignedTo",
  "employeeId",
  "escalatedTo",
  "load",
  "taken",
  "bulk",
  "outcome",
  "firstResponseDueAt",
  "resolutionDueAt",
]);

function flat(value: unknown, prefix = ""): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/cost|hash|token/i.test(key)) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (entry === null || typeof entry === "number" || typeof entry === "boolean") out[name] = entry;
    else if (typeof entry === "string") out[name] = entry.slice(0, 300);
    else if (!prefix && entry && typeof entry === "object" && !Array.isArray(entry)) Object.assign(out, flat(entry, key));
  }
  return out;
}

/** An event's data reduced to what the history may show (no ids of other records beyond people, never cost). */
function eventData(before: unknown, after: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  const a = flat(after);
  const b = flat(before);
  for (const [key, value] of Object.entries(a)) if (SAFE_EVENT_KEYS.has(key.split(".").pop() ?? key) || key.startsWith("agent.") || key.startsWith("matched.")) out[key] = value;
  for (const [key, value] of Object.entries(b)) if (SAFE_EVENT_KEYS.has(key)) out[`before.${key}`] = value;
  return out;
}

/** Events that are shown as messages (their message carries them), not as separate history lines. */
const MESSAGE_ACTIONS = new Set(["support.ticket.reply", "support.ticket.note", "support.ticket.inbound"]);

export async function getTicket(db: Db, actor: Actor, ref: string, locale: Locale, now: number, urls: { file: (id: string) => string }): Promise<TicketDetail> {
  assertCan(actor, "support.ticket.read");
  const ticket = await ticketByRef(db, ref);
  const [messages, events, photos, customer, order, product, warranty, repair, rma, session, suggestion, route] = await Promise.all([
    db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticket.id)).orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id)),
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "support_ticket"), eq(auditEvents.entityId, ticket.id)))
      .orderBy(asc(auditEvents.seq))
      .limit(400),
    db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerType, "support_ticket"), eq(files.ownerId, ticket.id), eq(files.visibility, "private"), isNull(files.deletedAt))),
    ticket.customerId ? db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, ticket.customerId)).get() : Promise.resolve(undefined),
    ticket.orderId ? db.select({ id: orders.id, ref: orders.ref, status: orders.status, placedAt: orders.placedAt }).from(orders).where(eq(orders.id, ticket.orderId)).get() : Promise.resolve(undefined),
    ticket.productId ? db.select({ id: products.id, name: products.name }).from(products).where(eq(products.id, ticket.productId)).get() : Promise.resolve(undefined),
    ticket.warrantyId ? db.select({ id: warranties.id, endsAt: warranties.endsAt, status: warranties.status }).from(warranties).where(eq(warranties.id, ticket.warrantyId)).get() : Promise.resolve(undefined),
    ticket.repairTicketId ? db.select({ id: repairTickets.id, ref: repairTickets.ref, status: repairTickets.status }).from(repairTickets).where(eq(repairTickets.id, ticket.repairTicketId)).get() : Promise.resolve(undefined),
    ticket.returnId ? db.select({ id: returns.id, rma: returns.rma, status: returns.status }).from(returns).where(eq(returns.id, ticket.returnId)).get() : Promise.resolve(undefined),
    ticket.assistantSessionId ? db.select({ id: assistantSessions.id, summary: assistantSessions.summary }).from(assistantSessions).where(eq(assistantSessions.id, ticket.assistantSessionId)).get() : Promise.resolve(undefined),
    !ticket.customerId && ticket.phoneE164 ? db.select({ id: customers.id, name: customers.name }).from(customers).where(and(eq(customers.phoneE164, ticket.phoneE164), eq(customers.status, "active"))).get() : Promise.resolve(undefined),
    lastRouteDecision(db, ticket.id),
  ]);
  const review = can(actor, "support.assistant.review");
  const transcript =
    session && review
      ? await db
          .select({ role: assistantMessages.role, content: assistantMessages.content, confidence: assistantMessages.confidence, flags: assistantMessages.safetyFlags, sources: assistantMessages.sources, at: assistantMessages.createdAt })
          .from(assistantMessages)
          .where(eq(assistantMessages.sessionId, session.id))
          .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id))
          .limit(200)
      : null;
  const outboxIds = messages.map((message) => message.outboxId).filter((id): id is string => typeof id === "string");
  const held = outboxIds.length ? await db.select({ id: outbox.id, channel: outbox.channel, status: outbox.status }).from(outbox).where(inArray(outbox.id, outboxIds.slice(0, 90))) : [];
  const names = await employeeNames(db, [
    ticket.assignedTo,
    ticket.escalatedTo,
    ...messages.map((message) => (message.authorKind === "employee" ? message.authorId : null)),
    ...events.map((event) => (event.actorKind === "employee" ? event.actorId : null)),
    ...events.map((event) => (typeof (event.after as { assignedTo?: unknown } | null)?.assignedTo === "string" ? ((event.after as { assignedTo: string }).assignedTo as string) : null)),
    ...events.map((event) => (typeof (event.after as { escalatedTo?: unknown } | null)?.escalatedTo === "string" ? ((event.after as { escalatedTo: string }).escalatedTo as string) : null)),
  ]);

  // what each message's event says about it (how it travelled, who typed it, a canned reply)
  const byMessage = new Map<string, { via: string | null; recordedBy: string | null; canned: { edited: boolean } | null }>();
  for (const event of events) {
    if (!MESSAGE_ACTIONS.has(event.action)) continue;
    const after = (event.after ?? {}) as { messageId?: unknown; via?: unknown; cannedReplyId?: unknown; edited?: unknown };
    if (typeof after.messageId !== "string") continue;
    byMessage.set(after.messageId, {
      via: typeof after.via === "string" ? after.via : null,
      recordedBy: event.action === "support.ticket.inbound" && event.actorKind === "employee" && event.actorId ? (names.get(event.actorId) ?? null) : null,
      canned: typeof after.cannedReplyId === "string" ? { edited: after.edited === true } : null,
    });
  }
  const photoIds = new Set(photos.map((photo) => photo.id));
  const fileOf = (id: string): TicketPhoto | null => (photoIds.has(id) ? { id, url: urls.file(id) } : null);
  const timeline: TicketTimelineItem[] = [];
  for (const message of messages) {
    const info = byMessage.get(message.id);
    const box = message.outboxId ? held.find((row) => row.id === message.outboxId) : undefined;
    timeline.push({
      kind: "message",
      id: message.id,
      at: message.createdAt,
      author: message.authorKind,
      authorName: message.authorKind === "employee" && message.authorId ? (names.get(message.authorId) ?? null) : null,
      body: message.body,
      internal: message.isInternal,
      photos: (Array.isArray(message.attachments) ? message.attachments : []).map(fileOf).filter((photo): photo is TicketPhoto => photo !== null),
      via: ((info?.via ?? null) as ReplyVia | InboundVia | null) ?? null,
      outbox: box ? { channel: box.channel, status: box.status } : null,
      recordedBy: info?.recordedBy ?? null,
      fromCanned: info?.canned ?? null,
    });
  }
  let escalationKind: EscalationKind | null = null;
  let handedBack = false;
  for (const event of events) {
    if (event.action === "support.ticket.escalate") {
      const kind = (event.after as { kind?: unknown } | null)?.kind;
      escalationKind = (ESCALATION_KINDS as readonly string[]).includes(kind as string) ? (kind as EscalationKind) : null;
      handedBack = false;
    }
    if (event.action === "support.ticket.escalation_return") handedBack = true;
    if (MESSAGE_ACTIONS.has(event.action)) continue;
    timeline.push({
      kind: "event",
      id: event.id,
      at: event.at,
      action: event.action.replace(/^support\.ticket\./, ""),
      actor: { kind: event.actorKind, name: event.actorKind === "employee" && event.actorId ? (names.get(event.actorId) ?? event.actorLabel ?? null) : null },
      data: (() => {
        const data = eventData(event.before, event.after);
        for (const key of ["assignedTo", "escalatedTo", "before.assignedTo"]) {
          const id = data[key];
          if (typeof id === "string") data[`${key}Name`] = names.get(id) ?? null;
        }
        return data;
      })(),
      reason: event.reason,
    });
  }
  // at the same moment: the opening first, then the messages, then the other changes
  const rank = (item: TicketTimelineItem) => (item.kind === "event" ? (item.action === "create" || item.action === "open" ? 0 : 2) : 1);
  timeline.sort((a, b) => a.at - b.at || rank(a) - rank(b));

  const firstReply = messages.find((message) => message.authorKind === "employee" && !message.isInternal)?.createdAt ?? null;
  const status = ticket.status;
  const readOrders = can(actor, "orders.order.read");
  const readCustomers = can(actor, "customers.customer.read");
  const returnsAny = canAny(actor, ["returns.repair.manage", "returns.rma.read", "returns.warranty.read"]);
  const reply = can(actor, "support.ticket.reply");
  const assign = can(actor, "support.ticket.assign");
  const closer = can(actor, "support.ticket.close");
  // while it is escalated to someone else, only that person resolves or closes it (assertNotEscalatedAway)
  const escalatedAway = ticket.escalatedTo !== null && (actor.kind !== "employee" || actor.id !== ticket.escalatedTo);
  const transitions = (TICKET_TRANSITIONS[status] ?? []).filter((to) => ((to === "closed" || status === "closed") ? closer : reply) && !(escalatedAway && (to === "resolved" || to === "closed")));
  const agents = assign ? await agentLoads(db) : [];
  const canned = reply ? await cannedFor(db, ticket.category) : [];
  const warrantyOptions = reply ? await warrantyChoices(db, ticket, locale) : [];
  const replyVia: ReplyVia[] = REPLY_VIA.filter((via) => (via === "whatsapp" || via === "sms" ? Boolean(ticket.phoneE164) : via === "email" ? Boolean(ticket.email) : true));
  const warrantyState = (row: { endsAt: number; status: string }): "active" | "expired" | "void" => (row.status === "void" ? "void" : row.endsAt < now ? "expired" : "active");

  return {
    id: ticket.id,
    ref: ticket.ref,
    subject: ticket.subject,
    channel: ticket.channel,
    category: ticket.category,
    priority: ticket.priority,
    status,
    team: ticket.team,
    locale: (ticket.locale ?? "ar") as Locale,
    tags: Array.isArray(ticket.tags) ? ticket.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12) : [],
    isDemo: ticket.isDemo,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    contact: { name: ticket.contactName, phone: phoneView(actor, ticket.phoneE164), email: ticket.email },
    customer: ticket.customerId ? { id: ticket.customerId, name: readCustomers ? (customer?.name ?? null) : null, href: readCustomers ? `/admin/customers/${encodeURIComponent(ticket.customerId)}` : null } : null,
    customerSuggestion: suggestion && readCustomers ? { id: suggestion.id, name: suggestion.name } : null,
    order: order ? { id: order.id, ref: order.ref, status: readOrders ? order.status : null, placedAt: readOrders ? order.placedAt : null, href: readOrders ? `/admin/orders/${order.ref}` : null } : null,
    product: product ? { id: product.id, name: pick(product.name, locale), href: can(actor, "catalog.product.read") ? `/admin/catalog/products/${encodeURIComponent(product.id)}` : null } : null,
    warranty: warranty ? { id: warranty.id, endsAt: warranty.endsAt, state: warrantyState(warranty), href: can(actor, "returns.warranty.read") ? `/admin/returns/warranties/${encodeURIComponent(warranty.id)}` : null } : null,
    repair: repair && isRepairStatus(repair.status) ? { id: repair.id, ref: repair.ref, status: repair.status, href: `/admin/support/repairs/${repair.ref}`, workHref: returnsAny ? `/admin/returns/repairs/${repair.ref}` : null } : null,
    // the return's status (and its page) only for whoever may read returns — like the order's
    rma: rma ? { id: rma.id, rma: rma.rma, status: can(actor, "returns.rma.read") ? rma.status : null, href: can(actor, "returns.rma.read") ? `/admin/returns/${rma.rma}` : null } : null,
    warrantyOptions,
    linkable: reply ? LINK_FIELDS.filter((field) => can(actor, LINK_READ[field])) : [],
    assistant:
      ticket.channel === "assistant" || ticket.assistantSessionId
        ? {
            summary: session?.summary ?? null,
            stored: Boolean(session),
            messages: transcript
              ? transcript.map((row) => ({
                  role: row.role,
                  content: row.content,
                  confidence: row.confidence ?? null,
                  flags: Array.isArray(row.flags) ? row.flags.filter((flag): flag is string => typeof flag === "string") : [],
                  sources: Array.isArray(row.sources) ? row.sources.length : 0,
                  at: row.at,
                }))
              : null,
          }
        : null,
    assigned: ticket.assignedTo ? { id: ticket.assignedTo, name: names.get(ticket.assignedTo) ?? ticket.assignedTo } : null,
    sla: {
      firstResponse: { dueAt: ticket.firstResponseDueAt, doneAt: ticket.firstRespondedAt ?? firstReply, clock: slaClock(ticket.firstResponseDueAt, ticket.firstRespondedAt ?? firstReply, now) },
      resolution: { dueAt: ticket.resolutionDueAt, doneAt: ticket.resolvedAt, clock: slaClock(ticket.resolutionDueAt, ticket.resolvedAt ?? (status === "closed" ? ticket.closedAt : null), now) },
    },
    escalation: ticket.escalatedAt ? { at: ticket.escalatedAt, to: ticket.escalatedTo ? { id: ticket.escalatedTo, name: names.get(ticket.escalatedTo) ?? ticket.escalatedTo } : null, reason: ticket.escalationReason, kind: escalationKind, handedBack: handedBack || !ticket.escalatedTo } : null,
    routing: route ? { at: route.at, decision: route.decision, bySystem: route.actorKind === "system" } : null,
    timeline,
    photos: photos.map((photo) => ({ id: photo.id, url: urls.file(photo.id) })),
    transitions,
    replyVia,
    can: {
      reply,
      assign,
      take: reply && !ticket.assignedTo && isOpenTicket(status),
      resolve: reply && !escalatedAway,
      close: closer,
      escalate: can(actor, "support.ticket.escalate") && isOpenTicket(status),
      route: assign && isOpenTicket(status),
      readOrders,
      readCustomers,
      returns: returnsAny,
      // the "return request" key opens module 12's form, which needs this permission
      rmaCreate: can(actor, "returns.rma.create"),
      handBack: ticket.escalatedTo !== null && settlesEscalation(actor, ticket, escalationTrail(events)) !== null,
    },
    agents,
    canned,
  };
}

/** Every agent with the number of open tickets they hold. */
export async function agentLoads(db: Db): Promise<AgentLoad[]> {
  const agents = await agentsOf(db);
  const loads = await openLoads(
    db,
    agents.map((agent) => agent.id),
  );
  return agents.map((agent) => ({ id: agent.id, name: agent.name, open: loads.get(agent.id) ?? 0 }));
}

async function cannedFor(db: Db, category: TicketCategory) {
  const rows = await db
    .select({ id: cannedReplies.id, title: cannedReplies.title, category: cannedReplies.category })
    .from(cannedReplies)
    .where(and(eq(cannedReplies.isActive, true), or(isNull(cannedReplies.category), eq(cannedReplies.category, category))))
    .orderBy(desc(sql`${cannedReplies.category} IS NOT NULL`), asc(cannedReplies.title))
    .limit(60);
  return rows.map((row) => ({ id: row.id, title: row.title, category: row.category ?? null }));
}

/** Warranties of the ticket's order (its lines) or of its customer, newest first. */
async function warrantyChoices(db: Db, ticket: SupportTicket, locale: Locale): Promise<{ id: string; endsAt: number; label: string }[]> {
  const where: SQL[] = [];
  if (ticket.orderId) where.push(sql`${orderItems.orderId} = ${ticket.orderId}`);
  if (ticket.customerId) where.push(sql`${warranties.customerId} = ${ticket.customerId}`);
  if (where.length === 0) return [];
  const rows = await db
    .select({ id: warranties.id, endsAt: warranties.endsAt, name: orderItems.nameSnapshot, orderRef: orders.ref })
    .from(warranties)
    .innerJoin(orderItems, eq(orderItems.id, warranties.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(or(...where))
    .orderBy(desc(warranties.endsAt))
    .limit(20);
  return rows.map((row) => ({ id: row.id, endsAt: row.endsAt, label: `${pick(row.name, locale)} · ${row.orderRef}` }));
}

// ───────────────────────────────────────────────────────────────── helpers for changes

const KEY = z.string().trim().min(8, "invalid").max(200, "invalid");
const reasonText = (min = 3) => z.string().overwrite(cleanLine).trim().min(min, "reason_required").max(1000, "too_long");
const OPEN_SQL = inArray(supportTickets.status, [...OPEN_TICKET_STATUSES]);

async function idFromKey(prefix: string, scope: string, key: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(`support:${scope}:${key}`)).slice(0, 26)}`;
}

function ticketChanged(error: unknown, ticketId: string): never {
  if (isDbError(error, "TICKET_CHANGED")) throw new AppError("ticket_changed", 409, { detail: ticketId, cause: error });
  throw error;
}

/** A ticket under escalation is resolved or closed only by the person it is escalated to. */
function assertNotEscalatedAway(actor: Actor, ticket: SupportTicket): void {
  if (ticket.escalatedTo && (actor.kind !== "employee" || actor.id !== ticket.escalatedTo)) throw new AppError("escalation_open", 409, { detail: ticket.ref });
}

/**
 * For a write that resolves or closes: "the escalation is still what was checked" — an escalation that lands between
 * the check and the write (from pending_staff the status does not change) makes the write fail (ticket_changed).
 */
const sameEscalation = (ticket: Pick<SupportTicket, "escalatedTo">): SQL => (ticket.escalatedTo ? eq(supportTickets.escalatedTo, ticket.escalatedTo) : isNull(supportTickets.escalatedTo));

// ───────────────────────────────────────────────────────────────── replies, notes, recorded messages

export const ReplyInput = z.object({
  ticketId: z.string().trim().max(128),
  body: z.string().overwrite(cleanBlock).trim().min(2, "required").max(4000, "too_long"),
  via: z.enum(REPLY_VIA, "invalid"),
  then: z.enum(REPLY_THEN, "invalid").default("pending_customer"),
  cannedReplyId: z.string().trim().max(128).optional(),
  /** True when the reviewer changed the canned text before recording it. */
  edited: z.boolean().optional(),
  idempotencyKey: KEY,
});

/**
 * A reply to the customer — the first one starts nothing new but stops the first-response clock. A written reply
 * (WhatsApp, SMS, e-mail) is held in the outbox (no provider); a call or a talk in person is recorded as it was.
 * Idempotent on the form's key (a double submit records one reply).
 */
export async function replyToTicket(db: Db, actor: Actor, raw: z.input<typeof ReplyInput>, now: number): Promise<{ messageId: string; status: TicketStatus; held: boolean; replayed: boolean }> {
  assertCan(actor, "support.ticket.reply");
  const input = ReplyInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  const messageId = await idFromKey("tmg", `reply:${ticket.id}`, input.idempotencyKey);
  const existing = await db.select({ id: ticketMessages.id }).from(ticketMessages).where(eq(ticketMessages.id, messageId)).get();
  if (existing) return { messageId, status: ticket.status, held: false, replayed: true };
  if (ticket.status === "closed") throw new AppError("ticket_closed", 409, { detail: ticket.ref });
  const left = unfilledPlaceholders(input.body);
  if (left.length > 0) throw new AppError("invalid", 400, { fields: { body: "unfilled_variable" }, detail: left.join(",") });
  if ((input.via === "whatsapp" || input.via === "sms") && !ticket.phoneE164) throw invalid({ via: "no_phone" });
  if (input.via === "email" && !ticket.email) throw invalid({ via: "no_email" });
  const to: TicketStatus = input.then === "keep" ? ticket.status : input.then;
  if (to === "resolved") assertNotEscalatedAway(actor, ticket);
  let canned: string | null = null;
  if (input.cannedReplyId) {
    const row = isId(input.cannedReplyId) ? await db.select({ id: cannedReplies.id }).from(cannedReplies).where(eq(cannedReplies.id, input.cannedReplyId)).get() : undefined;
    canned = row?.id ?? null;
  }
  const written = (MESSAGE_VIA as readonly string[]).includes(input.via);
  const outboxId = written ? await idFromKey("msg", `reply:${ticket.id}`, input.idempotencyKey) : null;
  const statements: BatchStatement[] = [];
  if (written && outboxId) {
    statements.push(
      outboxStatement(db, {
        id: outboxId,
        channel: input.via as "whatsapp" | "sms" | "email",
        recipient: input.via === "email" ? (ticket.email as string) : (ticket.phoneE164 as string),
        template: "support_reply",
        payload: { ticketRef: ticket.ref, body: input.body },
        locale: ticket.locale,
        customerId: ticket.customerId,
        refType: "support_ticket",
        refId: ticket.id,
        dedupeKey: `support_reply:${messageId}`,
        now,
      }),
    );
  }
  statements.push(
    db.insert(ticketMessages).values({ id: messageId, ticketId: ticket.id, authorKind: "employee", authorId: actor.kind === "employee" ? actor.id : null, body: input.body, attachments: null, isInternal: false, outboxId, createdAt: now }),
    db
      .update(supportTickets)
      .set({
        status: to,
        lastMessageAt: now,
        updatedAt: now,
        firstRespondedAt: sql`COALESCE(${supportTickets.firstRespondedAt}, ${now})`,
        ...(to === "resolved" && ticket.status !== "resolved" ? { resolvedAt: now } : {}),
        ...(ticket.status === "resolved" && to !== "resolved" ? { resolvedAt: null } : {}),
      })
      .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.status, ticket.status), to === "resolved" ? sameEscalation(ticket) : undefined)),
    expectChanged(db, 1, "TICKET_CHANGED"),
    ticketAudit(db, actor, "support.ticket.reply", ticket, now, {
      before: { status: ticket.status },
      after: { messageId, via: input.via, held: written, status: to, cannedReplyId: canned, edited: canned ? input.edited === true : null, firstResponse: ticket.firstRespondedAt === null },
    }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await db.select({ id: ticketMessages.id }).from(ticketMessages).where(eq(ticketMessages.id, messageId)).get();
      if (again) return { messageId, status: ticket.status, held: written, replayed: true };
    }
    ticketChanged(error, ticket.id);
  }
  return { messageId, status: to, held: written, replayed: false };
}

export const NoteInput = z.object({ ticketId: z.string().trim().max(128), body: z.string().overwrite(cleanBlock).trim().min(2, "required").max(4000, "too_long"), idempotencyKey: KEY });

/** An internal note: staff only, never shown to the customer, changes nothing else. */
export async function addInternalNote(db: Db, actor: Actor, raw: z.input<typeof NoteInput>, now: number): Promise<{ messageId: string; replayed: boolean }> {
  assertCan(actor, "support.ticket.reply");
  const input = NoteInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  const messageId = await idFromKey("tmg", `note:${ticket.id}`, input.idempotencyKey);
  if (await db.select({ id: ticketMessages.id }).from(ticketMessages).where(eq(ticketMessages.id, messageId)).get()) return { messageId, replayed: true };
  try {
    await runBatch(db, [
      db.insert(ticketMessages).values({ id: messageId, ticketId: ticket.id, authorKind: "employee", authorId: actor.kind === "employee" ? actor.id : null, body: input.body, attachments: null, isInternal: true, createdAt: now }),
      db.update(supportTickets).set({ updatedAt: now }).where(eq(supportTickets.id, ticket.id)),
      ticketAudit(db, actor, "support.ticket.note", ticket, now, { after: { messageId } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return { messageId, replayed: true };
    throw error;
  }
  return { messageId, replayed: false };
}

export const InboundInput = z.object({ ticketId: z.string().trim().max(128), body: z.string().overwrite(cleanBlock).trim().min(2, "required").max(4000, "too_long"), via: z.enum(INBOUND_VIA, "invalid"), idempotencyKey: KEY });

/**
 * What the customer said on a channel the store reads by hand (a WhatsApp message on the shop's phone, a call, the
 * counter): recorded as the customer's message, with who typed it in and from where. The ticket waits for staff again.
 */
export async function recordInboundMessage(db: Db, actor: Actor, raw: z.input<typeof InboundInput>, now: number): Promise<{ messageId: string; status: TicketStatus; replayed: boolean }> {
  assertCan(actor, "support.ticket.reply");
  const input = InboundInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  const messageId = await idFromKey("tmg", `inbound:${ticket.id}`, input.idempotencyKey);
  if (await db.select({ id: ticketMessages.id }).from(ticketMessages).where(eq(ticketMessages.id, messageId)).get()) return { messageId, status: ticket.status, replayed: true };
  if (ticket.status === "closed") throw new AppError("ticket_closed", 409, { detail: ticket.ref });
  const to: TicketStatus = ticket.status === "open" ? "open" : ticket.status === "resolved" ? "open" : "pending_staff";
  try {
    await runBatch(db, [
      db.insert(ticketMessages).values({ id: messageId, ticketId: ticket.id, authorKind: "customer", authorId: ticket.customerId, body: input.body, attachments: null, isInternal: false, createdAt: now }),
      db
        .update(supportTickets)
        .set({ status: to, lastMessageAt: now, updatedAt: now, ...(ticket.status === "resolved" ? { resolvedAt: null } : {}) })
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.status, ticket.status))),
      expectChanged(db, 1, "TICKET_CHANGED"),
      ticketAudit(db, actor, "support.ticket.inbound", ticket, now, { before: { status: ticket.status }, after: { messageId, via: input.via, status: to } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return { messageId, status: ticket.status, replayed: true };
    ticketChanged(error, ticket.id);
  }
  return { messageId, status: to, replayed: false };
}

// ───────────────────────────────────────────────────────────────── status

export const StatusInput = z.object({
  ticketId: z.string().trim().max(128),
  /** The status the page showed (a stale page is refused). */
  from: z.enum(TICKET_STATUSES, "invalid"),
  to: z.enum(TICKET_STATUSES, "invalid"),
  reason: z.string().overwrite(cleanLine).trim().max(1000, "too_long").optional(),
});

export async function changeTicketStatus(db: Db, actor: Actor, raw: z.input<typeof StatusInput>, now: number): Promise<{ status: TicketStatus; replayed: boolean }> {
  const input = StatusInput.parse(raw);
  assertCan(actor, input.to === "closed" || input.from === "closed" ? "support.ticket.close" : "support.ticket.reply");
  const ticket = await ticketById(db, input.ticketId);
  if (ticket.status === input.to) return { status: input.to, replayed: true };
  if (ticket.status !== input.from) throw new AppError("ticket_changed", 409, { detail: ticket.status });
  if (!TICKET_TRANSITIONS[ticket.status]?.includes(input.to)) throw new AppError("transition_not_allowed", 409, { detail: `${ticket.status}→${input.to}` });
  const reason = input.reason ?? "";
  if (STATUS_WITH_REASON.includes(input.to) && reason.length < 3) throw invalid({ reason: "reason_required" });
  if (input.to === "resolved" || input.to === "closed") assertNotEscalatedAway(actor, ticket);
  const set: Partial<typeof supportTickets.$inferInsert> = { status: input.to, updatedAt: now };
  if (input.to === "resolved") set.resolvedAt = now;
  if (input.to === "closed") set.closedAt = now;
  if (input.to === "open") {
    set.resolvedAt = null;
    set.closedAt = null;
  }
  try {
    await runBatch(db, [
      db
        .update(supportTickets)
        .set(set)
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.status, ticket.status), input.to === "resolved" || input.to === "closed" ? sameEscalation(ticket) : undefined)),
      expectChanged(db, 1, "TICKET_CHANGED"),
      ticketAudit(db, actor, "support.ticket.status", ticket, now, { before: { status: ticket.status }, after: { status: input.to }, reason: reason || null }),
    ]);
  } catch (error) {
    ticketChanged(error, ticket.id);
  }
  return { status: input.to, replayed: false };
}

// ───────────────────────────────────────────────────────────────── triage (priority, category, team)

export const TriageInput = z.object({
  ticketId: z.string().trim().max(128),
  priority: z.enum(TICKET_PRIORITIES, "invalid"),
  category: z.enum(TICKET_CATEGORIES, "invalid"),
  team: z.string().trim().max(40, "too_long").default(""),
  /** updated_at the form was built from (a stale form is refused). */
  expectedUpdatedAt: z.number().int(),
  reason: z.string().overwrite(cleanLine).trim().max(500, "too_long").optional(),
});

/** Priority, category and team; the SLA due times follow the policy of the new priority and category. */
export async function triageTicket(db: Db, actor: Actor, raw: z.input<typeof TriageInput>, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "support.ticket.assign");
  const input = TriageInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  const team = input.team ? normalizeTeam(input.team) : null;
  if (input.team && !team) throw invalid({ team: "invalid" });
  if (ticket.priority === input.priority && ticket.category === input.category && ticket.team === team) return { changed: false };
  if (ticket.updatedAt !== input.expectedUpdatedAt) throw new AppError("ticket_changed", 409, { detail: ticket.id });
  const set: Partial<typeof supportTickets.$inferInsert> = { priority: input.priority, category: input.category, team, updatedAt: now };
  if (ticket.priority !== input.priority || ticket.category !== input.category) {
    const due = await dueTimesFor(db, input.priority, input.category, ticket.createdAt);
    set.firstResponseDueAt = due.firstResponseDueAt;
    set.resolutionDueAt = due.resolutionDueAt;
  }
  try {
    await runBatch(db, [
      db
        .update(supportTickets)
        .set(set)
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.updatedAt, ticket.updatedAt))),
      expectChanged(db, 1, "TICKET_CHANGED"),
      ticketAudit(db, actor, "support.ticket.triage", ticket, now, {
        before: { priority: ticket.priority, category: ticket.category, team: ticket.team, firstResponseDueAt: ticket.firstResponseDueAt, resolutionDueAt: ticket.resolutionDueAt },
        after: { priority: input.priority, category: input.category, team, firstResponseDueAt: set.firstResponseDueAt ?? ticket.firstResponseDueAt, resolutionDueAt: set.resolutionDueAt ?? ticket.resolutionDueAt },
        reason: input.reason || null,
      }),
    ]);
  } catch (error) {
    ticketChanged(error, ticket.id);
  }
  return { changed: true };
}

// ───────────────────────────────────────────────────────────────── links (14.02)

export const LINK_FIELDS = ["customer", "order", "product", "warranty", "repair", "return"] as const;
export type LinkField = (typeof LINK_FIELDS)[number];
/** The permission that lets an employee look up a record of each kind (repair requests are in the inbox already). */
export const LINK_READ: Record<LinkField, Permission> = {
  customer: "customers.customer.read",
  order: "orders.order.read",
  product: "catalog.product.read",
  warranty: "returns.warranty.read",
  repair: "support.ticket.read",
  return: "returns.rma.read",
};
const COLUMN: Record<LinkField, keyof SupportTicket> = { customer: "customerId", order: "orderId", product: "productId", warranty: "warrantyId", repair: "repairTicketId", return: "returnId" };

export const LinkInput = z.object({ ticketId: z.string().trim().max(128), field: z.enum(LINK_FIELDS, "invalid"), value: z.string().trim().max(128).default("") });

/** The record a typed value names (an id, a reference, a SKU or a slug), or null for an empty value (= unlink). */
async function resolveLink(db: Db, field: LinkField, value: string): Promise<{ id: string; customerId?: string | null; orderId?: string | null } | null> {
  if (value === "") return null;
  const text = value.trim();
  // references as people type them: Arabic-Indic or Persian digits, any case
  const upper = toLatinDigits(text).toUpperCase();
  switch (field) {
    case "customer": {
      const phone = normalizeIraqPhone(text);
      const row = await db
        .select({ id: customers.id })
        .from(customers)
        .where(phone ? eq(customers.phoneE164, phone) : eq(customers.id, isId(text) ? text : ""))
        .get();
      return row ? { id: row.id, customerId: row.id } : null;
    }
    case "order": {
      const row = await db.select({ id: orders.id, customerId: orders.customerId }).from(orders).where(eq(orders.ref, upper.slice(0, 40))).get();
      return row ? { id: row.id, customerId: row.customerId, orderId: row.id } : null;
    }
    case "product": {
      const byVariant = await db.select({ id: variants.productId }).from(variants).where(eq(variants.sku, upper.slice(0, 64))).get();
      if (byVariant) return { id: byVariant.id };
      const row = await db
        .select({ id: products.id })
        .from(products)
        .where(or(eq(products.slug, text.toLowerCase().slice(0, 120)), eq(products.id, isId(text) ? text : "")))
        .get();
      return row ? { id: row.id } : null;
    }
    case "warranty": {
      const row = isId(text)
        ? await db.select({ id: warranties.id, customerId: warranties.customerId, orderId: orderItems.orderId }).from(warranties).innerJoin(orderItems, eq(orderItems.id, warranties.orderItemId)).where(eq(warranties.id, text)).get()
        : undefined;
      return row ? { id: row.id, customerId: row.customerId, orderId: row.orderId } : null;
    }
    case "repair": {
      const ref = normalizeRepairRef(text);
      const row = ref ? await db.select({ id: repairTickets.id, customerId: repairTickets.customerId }).from(repairTickets).where(eq(repairTickets.ref, ref)).get() : undefined;
      return row ? { id: row.id, customerId: row.customerId } : null;
    }
    case "return": {
      const row = await db.select({ id: returns.id, customerId: returns.customerId, orderId: returns.orderId }).from(returns).where(eq(returns.rma, upper.slice(0, 40))).get();
      return row ? { id: row.id, customerId: row.customerId, orderId: row.orderId } : null;
    }
  }
}

/** Whose a linked record is: its customer and its order (null when it has none, or for a product). */
export type LinkOwner = { field: LinkField; customerId: string | null; orderId: string | null };

/** The owners of the records a ticket links to (a customer is its own owner; a product has none). */
export async function linkOwners(db: Db, links: Partial<Record<LinkField, string | null>>): Promise<LinkOwner[]> {
  const [order, warranty, rma, repair] = await Promise.all([
    links.order ? db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, links.order)).get() : Promise.resolve(undefined),
    links.warranty
      ? db.select({ customerId: warranties.customerId, orderId: orderItems.orderId }).from(warranties).innerJoin(orderItems, eq(orderItems.id, warranties.orderItemId)).where(eq(warranties.id, links.warranty)).get()
      : Promise.resolve(undefined),
    links.return ? db.select({ customerId: returns.customerId, orderId: returns.orderId }).from(returns).where(eq(returns.id, links.return)).get() : Promise.resolve(undefined),
    links.repair ? db.select({ customerId: repairTickets.customerId }).from(repairTickets).where(eq(repairTickets.id, links.repair)).get() : Promise.resolve(undefined),
  ]);
  const out: LinkOwner[] = [];
  if (links.customer) out.push({ field: "customer", customerId: links.customer, orderId: null });
  if (links.order) out.push({ field: "order", customerId: order?.customerId ?? null, orderId: links.order });
  if (links.warranty) out.push({ field: "warranty", customerId: warranty?.customerId ?? null, orderId: warranty?.orderId ?? null });
  if (links.return) out.push({ field: "return", customerId: rma?.customerId ?? null, orderId: rma?.orderId ?? null });
  if (links.repair) out.push({ field: "repair", customerId: repair?.customerId ?? null, orderId: null });
  return out;
}

/**
 * Whether a record (its customer and order) may join the other links of a ticket: ONE customer and ONE order across
 * all of them, whichever was linked first — "order_other_customer" for a second customer, "warranty_other_order" for a
 * second order (a warranty or a return of another order, or an order other than the warranty's or return's).
 */
export function linkConflict(record: { customerId: string | null; orderId: string | null }, others: readonly LinkOwner[]): "order_other_customer" | "warranty_other_order" | null {
  if (record.customerId && others.some((other) => other.customerId !== null && other.customerId !== record.customerId)) return "order_other_customer";
  if (record.orderId && others.some((other) => other.orderId !== null && other.orderId !== record.orderId)) return "warranty_other_order";
  return null;
}

const LINK_COLUMNS = { customer: supportTickets.customerId, order: supportTickets.orderId, product: supportTickets.productId, warranty: supportTickets.warrantyId, repair: supportTickets.repairTicketId, return: supportTickets.returnId } as const;

/**
 * Links the ticket to one record (or unlinks it). The record is kept by its id. A link that contradicts any other link
 * of the ticket is refused (linkConflict): one customer and one order across the customer, order, warranty, return and
 * repair. The write is guarded on every link the check read, so two links that each passed their own check cannot
 * both land (the later one gets ticket_changed).
 */
export async function linkTicket(db: Db, actor: Actor, raw: z.input<typeof LinkInput>, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "support.ticket.reply");
  const input = LinkInput.parse(raw);
  // looking a record up by its reference tells whether it exists: only for those who may read that kind of record
  if (input.value !== "") assertCan(actor, LINK_READ[input.field]);
  const ticket = await ticketById(db, input.ticketId);
  const column = COLUMN[input.field];
  const current = (ticket[column] as string | null) ?? null;
  const target = await resolveLink(db, input.field, input.value);
  if (input.value !== "" && !target) throw new AppError("invalid", 400, { fields: { value: "link_not_found" } });
  const next = target?.id ?? null;
  if (next === current) return { changed: false };
  if (target) {
    const links: Partial<Record<LinkField, string | null>> = { customer: ticket.customerId, order: ticket.orderId, warranty: ticket.warrantyId, return: ticket.returnId, repair: ticket.repairTicketId };
    delete links[input.field];
    const conflict = linkConflict({ customerId: target.customerId ?? null, orderId: target.orderId ?? null }, await linkOwners(db, links));
    if (conflict) throw new AppError(conflict, 409, { fields: { value: conflict } });
  }
  // every link as it was read: a link changed meanwhile (by another request) fails this write
  const unchanged = (Object.keys(LINK_COLUMNS) as LinkField[]).map((field) => {
    const value = (ticket[COLUMN[field]] as string | null) ?? null;
    return value === null ? isNull(LINK_COLUMNS[field]) : eq(LINK_COLUMNS[field], value);
  });
  try {
    await runBatch(db, [
      db
        .update(supportTickets)
        .set({ ...({ [column]: next } as Partial<typeof supportTickets.$inferInsert>), updatedAt: now })
        .where(and(eq(supportTickets.id, ticket.id), ...unchanged)),
      expectChanged(db, 1, "TICKET_CHANGED"),
      ticketAudit(db, actor, "support.ticket.link", ticket, now, { before: { field: input.field, id: current }, after: { field: input.field, id: next } }),
    ]);
  } catch (error) {
    ticketChanged(error, ticket.id);
  }
  return { changed: true };
}

// ───────────────────────────────────────────────────────────────── assignment

export const AssignInput = z.object({
  ticketId: z.string().trim().max(128),
  /** "" = nobody. */
  employeeId: z.string().trim().max(128).default(""),
  /** Who the page showed as holding it ("" = nobody); a stale page is refused. */
  expected: z.string().trim().max(128).default(""),
  reason: z.string().overwrite(cleanLine).trim().max(500, "too_long").optional(),
});

/**
 * Gives the ticket to an agent (or to nobody). Assigning needs support.ticket.assign; taking an unassigned ticket for
 * oneself needs only support.ticket.reply. The agent must be able to answer tickets. Over a routing rule's capacity is
 * allowed by hand (the page shows the agent's load first) and audited.
 */
export async function assignTicket(db: Db, actor: Actor, raw: z.input<typeof AssignInput>, now: number): Promise<{ changed: boolean }> {
  const input = AssignInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  const me = actor.kind === "employee" ? actor.id : null;
  const taking = input.employeeId !== "" && input.employeeId === me;
  if (!can(actor, "support.ticket.assign")) {
    if (!taking || !can(actor, "support.ticket.reply")) throw forbidden("support.ticket.assign");
    if (ticket.assignedTo) throw new AppError("take_only_unassigned", 409, { detail: ticket.ref });
  }
  const next = input.employeeId || null;
  if ((ticket.assignedTo ?? "") !== input.expected) throw new AppError("ticket_changed", 409, { detail: ticket.id });
  if (ticket.assignedTo === next) return { changed: false };
  if (!isOpenTicket(ticket.status)) throw new AppError("ticket_closed", 409, { detail: ticket.status });
  if (next && (await agentsOf(db, [next])).length === 0) throw new AppError("assignee_not_agent", 409, { fields: { employeeId: "assignee_not_agent" } });
  const load = next ? ((await openLoads(db, [next])).get(next) ?? 0) : null;
  try {
    await runBatch(db, [
      db
        .update(supportTickets)
        .set({ assignedTo: next, updatedAt: now })
        .where(and(eq(supportTickets.id, ticket.id), OPEN_SQL, ticket.assignedTo ? eq(supportTickets.assignedTo, ticket.assignedTo) : isNull(supportTickets.assignedTo))),
      expectChanged(db, 1, "TICKET_CHANGED"),
      ticketAudit(db, actor, "support.ticket.assign", ticket, now, { before: { assignedTo: ticket.assignedTo }, after: { assignedTo: next, load, taken: taking }, reason: input.reason || null }),
    ]);
  } catch (error) {
    ticketChanged(error, ticket.id);
  }
  return { changed: true };
}

/**
 * The inbox's bulk "assign to": each ticket in its own guarded batch; the ones that changed meanwhile are skipped.
 * `expected` (ticket id → who the list showed as holding it, "" = nobody) keeps a stale list from moving a ticket
 * someone took after it was shown: that ticket is skipped too, and the count says so.
 */
export async function assignTickets(db: Db, actor: Actor, raw: { ticketIds?: unknown; employeeId?: string; expected?: Record<string, string> }, now: number): Promise<{ assigned: number; skipped: number }> {
  assertCan(actor, "support.ticket.assign");
  const ids = z.array(z.string().trim().max(128)).min(1, "required").max(50, "too_big").parse(raw.ticketIds);
  const next = (raw.employeeId ?? "").trim() || null;
  if (next && (await agentsOf(db, [next])).length === 0) throw new AppError("assignee_not_agent", 409, { fields: { employeeId: "assignee_not_agent" } });
  const tickets = await db.select().from(supportTickets).where(inArray(supportTickets.id, ids.filter(isId)));
  const shown = raw.expected ?? null;
  let assigned = 0;
  let skipped = ids.length - tickets.length;
  for (const ticket of tickets) {
    const changedSinceShown = shown !== null && (!Object.hasOwn(shown, ticket.id) || (ticket.assignedTo ?? "") !== shown[ticket.id]);
    if (!isOpenTicket(ticket.status) || ticket.assignedTo === next || changedSinceShown) {
      skipped++;
      continue;
    }
    try {
      await runBatch(db, [
        db
          .update(supportTickets)
          .set({ assignedTo: next, updatedAt: now })
          .where(and(eq(supportTickets.id, ticket.id), OPEN_SQL, ticket.assignedTo ? eq(supportTickets.assignedTo, ticket.assignedTo) : isNull(supportTickets.assignedTo))),
        expectChanged(db, 1, "TICKET_CHANGED"),
        ticketAudit(db, actor, "support.ticket.assign", ticket, now, { before: { assignedTo: ticket.assignedTo }, after: { assignedTo: next, bulk: true } }),
      ]);
      assigned++;
    } catch (error) {
      if (isDbError(error, "TICKET_CHANGED")) skipped++;
      else throw error;
    }
  }
  return { assigned, skipped };
}

// ───────────────────────────────────────────────────────────────── a ticket opened by staff

export const StaffTicketInput = z.object({
  channel: z.enum(STAFF_CHANNELS, "invalid"),
  phone: z.string().trim().max(40, "phone_invalid").default(""),
  email: z.string().trim().max(200, "too_long").default(""),
  contactName: z.string().overwrite(cleanLine).trim().max(80, "too_long").default(""),
  subject: z.string().overwrite(cleanLine).trim().min(3, "too_short").max(140, "too_long"),
  category: z.enum(TICKET_CATEGORIES, "invalid").default("other"),
  priority: z.enum(TICKET_PRIORITIES, "invalid").default("normal"),
  /** What the customer said, in their words. */
  message: z.string().overwrite(cleanBlock).trim().max(4000, "too_long").default(""),
  orderRef: z.string().trim().max(40).default(""),
  repairRef: z.string().trim().max(40).default(""),
  /** The language the customer speaks (replies are written in it). */
  locale: z.enum(["ar", "en", "ckb"]).default("ar"),
  /** Take the ticket oneself (otherwise the routing rules decide). */
  takeIt: z.boolean().default(true),
  idempotencyKey: KEY,
});

/**
 * A ticket for a customer who called, wrote on WhatsApp or e-mail, or came to the shop. The contact (an Iraqi mobile or
 * an e-mail) is required; the account with that phone, an order and a repair are linked by their ids. Its SLA due
 * times come from the policies; it is routed by the rules unless the creator takes it. Idempotent on the form's key.
 */
export async function openStaffTicket(db: Db, actor: Actor, raw: z.input<typeof StaffTicketInput>, now: number, storeMode: "demo" | "live" = "live"): Promise<{ ticketId: string; ref: string; replayed: boolean; decision: RouteDecision | null }> {
  assertCan(actor, "support.ticket.reply");
  const input = StaffTicketInput.parse(raw);
  const fields: Record<string, string> = {};
  const phone = input.phone ? normalizeIraqPhone(input.phone) : null;
  if (input.phone && !phone) fields.phone = "phone_invalid";
  const emailParsed = input.email ? z.email().safeParse(input.email.toLowerCase()) : null;
  if (emailParsed && !emailParsed.success) fields.email = "email_invalid";
  if (!input.phone && !input.email) fields.phone = "contact_required";
  // naming an order or a repair looks it up (and would tell whether it exists): only for whoever may read that kind
  if (input.orderRef) assertCan(actor, LINK_READ.order);
  if (input.repairRef) assertCan(actor, LINK_READ.repair);
  const orderRef = input.orderRef ? toLatinDigits(input.orderRef).toUpperCase() : "";
  const order = orderRef ? await db.select({ id: orders.id, customerId: orders.customerId, phone: orders.contactPhoneE164 }).from(orders).where(eq(orders.ref, orderRef)).get() : undefined;
  if (input.orderRef && !order) fields.orderRef = "link_not_found";
  const repairRef = input.repairRef ? normalizeRepairRef(input.repairRef) : null;
  const repair = repairRef ? await db.select({ id: repairTickets.id, customerId: repairTickets.customerId }).from(repairTickets).where(eq(repairTickets.ref, repairRef)).get() : undefined;
  if (input.repairRef && !repair) fields.repairRef = "link_not_found";
  if (Object.keys(fields).length > 0) throw invalid(fields);

  const id = await idFromKey("stk", "staff", input.idempotencyKey);
  const existing = await db.select({ id: supportTickets.id, ref: supportTickets.ref }).from(supportTickets).where(eq(supportTickets.id, id)).get();
  if (existing) return { ticketId: existing.id, ref: existing.ref, replayed: true, decision: null };

  // the account with that phone is linked by itself only for someone who may read customers (the link would say it exists)
  const account = phone && can(actor, LINK_READ.customer) ? await db.select({ id: customers.id }).from(customers).where(and(eq(customers.phoneE164, phone), eq(customers.status, "active"))).get() : undefined;
  const customerId = account?.id ?? (order?.customerId && order.phone && order.phone === phone ? order.customerId : null) ?? repair?.customerId ?? null;
  // one customer across the account, the order and the repair (14.02)
  if (order?.customerId && customerId && order.customerId !== customerId) throw new AppError("order_other_customer", 409, { fields: { orderRef: "order_other_customer" } });
  if (repair?.customerId && customerId && repair.customerId !== customerId) throw new AppError("order_other_customer", 409, { fields: { repairRef: "order_other_customer" } });

  const me = actor.kind === "employee" ? actor.id : null;
  const draft = { category: input.category, channel: input.channel as TicketChannel, priority: input.priority };
  const routing = input.takeIt ? null : await Promise.all([activeRules(db), eligibleAgents(db)]);
  const plan = { id, customerId, phone, email: emailParsed?.success ? emailParsed.data : null, orderId: order?.id ?? null, orderRef: order ? orderRef : null, repairId: repair?.id ?? null, repairRef, me };
  for (let attempt = 0; attempt < 3; attempt++) {
    const decision = routing ? decideRoute(draft, `${input.subject}\n${input.message}`, routing[0], await openLoads(db, [...routing[1].keys()]), routing[1]) : null;
    try {
      return await createStaffTicket(db, actor, input, { ...plan, decision }, now, storeMode);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const again = await db.select({ id: supportTickets.id, ref: supportTickets.ref }).from(supportTickets).where(eq(supportTickets.id, id)).get();
        if (again) return { ticketId: again.id, ref: again.ref, replayed: true, decision: null };
      }
      // the agent filled up meanwhile: decide again with fresh loads (the next agent, or the team's queue)
      if (isDbError(error, "CAPACITY_FULL")) continue;
      throw error;
    }
  }
  throw new AppError("ticket_changed", 409, { detail: "capacity changed while routing" });
}

type StaffTicketPlan = { id: string; customerId: string | null; phone: string | null; email: string | null; orderId: string | null; orderRef: string | null; repairId: string | null; repairRef: string | null; me: string | null; decision: RouteDecision | null };

async function createStaffTicket(db: Db, actor: Actor, input: z.output<typeof StaffTicketInput>, plan: StaffTicketPlan, now: number, storeMode: "demo" | "live"): Promise<{ ticketId: string; ref: string; replayed: boolean; decision: RouteDecision | null }> {
  const { id, customerId, phone, decision } = plan;
  const priority = decision?.priority ?? input.priority;
  const due = await dueTimesFor(db, priority, input.category, now);
  const ref = publicRef("SP");
  const row: NewSupportTicket = {
    id,
    ref,
    customerId,
    contactName: input.contactName || null,
    phoneE164: phone,
    email: plan.email,
    channel: input.channel,
    subject: input.subject,
    category: input.category,
    priority,
    status: "open",
    assignedTo: input.takeIt ? plan.me : (decision?.agent?.id ?? null),
    team: decision?.team ?? null,
    orderId: plan.orderId,
    repairTicketId: plan.repairId,
    firstResponseDueAt: due.firstResponseDueAt,
    resolutionDueAt: due.resolutionDueAt,
    tags: ["staff"],
    locale: input.locale,
    lastMessageAt: now,
    isDemo: storeMode === "demo",
    createdAt: now,
    updatedAt: now,
  };
  const messages: NewTicketMessage[] = input.message ? [{ id: newId("tmg"), ticketId: id, authorKind: "customer", authorId: customerId, body: input.message, attachments: null, isInternal: false, createdAt: now }] : [];
  const created = { id, ref };
  const statements: BatchStatement[] = [];
  if (decision?.agent) statements.push(expectThat(db, sql`${openLoadSql(decision.agent.id)} < ${decision.agent.capacity}`, "CAPACITY_FULL"));
  statements.push(db.insert(supportTickets).values(row));
  if (messages.length) statements.push(db.insert(ticketMessages).values(messages));
  statements.push(
    ticketAudit(db, actor, "support.ticket.open", created, now, {
      summary: `${ref} · ${input.channel} · ${input.category}`,
      after: { ref, channel: input.channel, category: input.category, priority, customerLinked: customerId !== null, order: plan.orderRef, repair: plan.repairRef, assignedTo: row.assignedTo ?? null, firstResponseDueAt: due.firstResponseDueAt },
    }),
  );
  if (decision) statements.push(ticketAudit(db, actor, ROUTE_ACTION, created, now, { after: { ...decision, forced: false } }));
  await runBatch(db, statements);
  return { ticketId: id, ref, replayed: false, decision };
}

// ───────────────────────────────────────────────────────────────── private photos (SECURITY.md §9)

/**
 * A private photo a customer attached to a support ticket or a repair request, for an employee who may read tickets;
 * null otherwise (one 404 for every miss: unknown, public, deleted, another kind of file).
 */
export async function supportPhotoFile(db: Db, actor: Actor, fileId: string): Promise<{ id: string } | null> {
  assertCan(actor, "support.ticket.read");
  if (!isId(fileId)) return null;
  const row = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, fileId), inArray(files.ownerType, ["support_ticket", "repair_ticket"]), eq(files.visibility, "private"), isNull(files.deletedAt)))
    .get();
  return row ?? null;
}

export { TICKET_STATUSES };
