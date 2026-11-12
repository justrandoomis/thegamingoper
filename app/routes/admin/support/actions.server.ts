/**
 * The intents of the module's pages, in one testable place: each checks its own permission BEFORE anything of the
 * form is read (a role that may not do it gets 403, never a field error that reveals what exists), then calls the
 * service, which checks again. Routes only open the request and turn failures into data (support.server.ts).
 *
 *   const result = await ticketIntent(db, actor, ref, form, now, { locale, storeMode });   // { ok: true, intent, … }
 */
import { canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden, invalid, toAppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { escalateTicket, returnEscalation } from "~/server/services/admin/support/escalation.server";
import { previewCannedReply } from "~/server/services/admin/support/replies.server";
import { routeTicket, routeWaitingTickets } from "~/server/services/admin/support/routing.server";
import { ticketByRef } from "~/server/services/admin/support/shared.server";
import { addInternalNote, assignTicket, assignTickets, changeTicketStatus, linkTicket, recordInboundMessage, replyToTicket, triageTicket } from "~/server/services/admin/support/tickets.server";
import { ESCALATION_KINDS, INBOUND_VIA, REPLY_THEN, REPLY_VIA, TICKET_STATUSES, type EscalationKind, type InboundVia, type ReplyThen, type ReplyVia, type TicketStatus } from "~/server/services/admin/support/types";
import { all, checked, text } from "./support.server";

const oneOf = <T extends string>(list: readonly T[], value: string): T | undefined => ((list as readonly string[]).includes(value) ? (value as T) : undefined);

function need(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions[0]);
}

/** What each ticket intent needs (any of). */
export const TICKET_INTENT_PERMISSIONS: Record<string, readonly Permission[]> = {
  reply: ["support.ticket.reply"],
  note: ["support.ticket.reply"],
  inbound: ["support.ticket.reply"],
  preview: ["support.ticket.reply"],
  status: ["support.ticket.reply", "support.ticket.close"],
  link: ["support.ticket.reply"],
  take: ["support.ticket.reply"],
  assign: ["support.ticket.assign"],
  triage: ["support.ticket.assign"],
  route: ["support.ticket.assign"],
  escalate: ["support.ticket.escalate"],
  return_escalation: ["support.ticket.read"],
};

export type IntentResult = { ok: true; intent: string; replayed?: boolean; [key: string]: unknown };

export async function ticketIntent(db: Db, actor: Actor, ref: string, form: FormData, now: number): Promise<IntentResult> {
  const intent = text(form, "intent");
  const permissions = TICKET_INTENT_PERMISSIONS[intent];
  if (!permissions) throw invalid({ intent: "invalid" });
  need(actor, permissions);
  const ticket = await ticketByRef(db, ref);
  const ticketId = ticket.id;
  switch (intent) {
    case "reply": {
      const result = await replyToTicket(
        db,
        actor,
        {
          ticketId,
          body: text(form, "body"),
          via: (oneOf(REPLY_VIA, text(form, "via")) ?? text(form, "via")) as ReplyVia,
          then: (oneOf(REPLY_THEN, text(form, "then")) ?? "pending_customer") as ReplyThen,
          cannedReplyId: text(form, "cannedReplyId") || undefined,
          edited: checked(form, "edited"),
          idempotencyKey: text(form, "idempotencyKey"),
        },
        now,
      );
      return { ok: true, intent, replayed: result.replayed, held: result.held, status: result.status };
    }
    case "note": {
      const result = await addInternalNote(db, actor, { ticketId, body: text(form, "body"), idempotencyKey: text(form, "idempotencyKey") }, now);
      return { ok: true, intent, replayed: result.replayed };
    }
    case "inbound": {
      const result = await recordInboundMessage(db, actor, { ticketId, body: text(form, "body"), via: (oneOf(INBOUND_VIA, text(form, "via")) ?? text(form, "via")) as InboundVia, idempotencyKey: text(form, "idempotencyKey") }, now);
      return { ok: true, intent, replayed: result.replayed, status: result.status };
    }
    case "preview": {
      const preview = await previewCannedReply(db, actor, { ticketId, replyId: text(form, "replyId") });
      return { ok: true, intent, preview };
    }
    case "status": {
      const result = await changeTicketStatus(db, actor, { ticketId, from: (oneOf(TICKET_STATUSES, text(form, "from")) ?? text(form, "from")) as TicketStatus, to: (oneOf(TICKET_STATUSES, text(form, "to")) ?? text(form, "to")) as TicketStatus, reason: text(form, "reason") || undefined }, now);
      return { ok: true, intent, replayed: result.replayed, status: result.status };
    }
    case "link": {
      const result = await linkTicket(db, actor, { ticketId, field: text(form, "field") as never, value: text(form, "value") }, now);
      return { ok: true, intent, changed: result.changed };
    }
    case "take": {
      const me = actor.kind === "employee" ? actor.id : "";
      await assignTicket(db, actor, { ticketId, employeeId: me, expected: "" }, now);
      return { ok: true, intent };
    }
    case "assign": {
      const result = await assignTicket(db, actor, { ticketId, employeeId: text(form, "employeeId"), expected: text(form, "expected"), reason: text(form, "reason") || undefined }, now);
      return { ok: true, intent, changed: result.changed };
    }
    case "triage": {
      const expected = Number(text(form, "expectedUpdatedAt"));
      const result = await triageTicket(db, actor, { ticketId, priority: text(form, "priority") as never, category: text(form, "category") as never, team: text(form, "team"), expectedUpdatedAt: Number.isFinite(expected) ? expected : -1, reason: text(form, "reason") || undefined }, now);
      return { ok: true, intent, changed: result.changed };
    }
    case "route": {
      const decision = await routeTicket(db, actor, { ticketId }, now);
      return { ok: true, intent, decision };
    }
    case "escalate": {
      const result = await escalateTicket(db, actor, { ticketId, kind: (oneOf(ESCALATION_KINDS, text(form, "kind")) ?? text(form, "kind")) as EscalationKind, toEmployeeId: text(form, "toEmployeeId"), reason: text(form, "reason"), expected: text(form, "expected") }, now);
      return { ok: true, intent, priority: result.priority };
    }
    case "return_escalation": {
      await returnEscalation(db, actor, { ticketId, outcome: text(form, "outcome") }, now);
      return { ok: true, intent };
    }
  }
  throw invalid({ intent: "invalid" });
}

/** The inbox's own intents: route the waiting tickets, bulk assign, bulk route. */
export async function inboxIntent(db: Db, actor: Actor, form: FormData, now: number): Promise<IntentResult> {
  const intent = text(form, "intent");
  if (!["route_waiting", "bulk_assign", "bulk_route"].includes(intent)) throw invalid({ intent: "invalid" });
  need(actor, ["support.ticket.assign"]);
  if (intent === "route_waiting") {
    const result = await routeWaitingTickets(db, actor, now);
    return { ok: true, intent, ...result };
  }
  const ids = all(form, "ticketId").slice(0, 50);
  if (ids.length === 0) throw invalid({ ticketId: "required" });
  if (intent === "bulk_assign") {
    // "<ticket id>:<who the list showed as holding it>" per selected row (a stale list skips what changed since)
    const shown = form.getAll("expected").filter((value): value is string => typeof value === "string" && value.includes(":"));
    const expected = shown.length ? Object.fromEntries(shown.map((value) => [value.slice(0, value.indexOf(":")).trim(), value.slice(value.indexOf(":") + 1).trim()])) : undefined;
    const result = await assignTickets(db, actor, { ticketIds: ids, employeeId: text(form, "employeeId"), expected }, now);
    return { ok: true, intent, ...result };
  }
  let routed = 0;
  let skipped = 0;
  for (const ticketId of ids) {
    try {
      await routeTicket(db, actor, { ticketId }, now);
      routed++;
    } catch (error) {
      // a ticket that closed or changed meanwhile is skipped; anything unexpected still fails the request
      if (!toAppError(error)) throw error;
      skipped++;
    }
  }
  return { ok: true, intent, routed, skipped };
}
