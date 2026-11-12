/**
 * Escalation (14.07): a financial or a warranty complaint goes to a person who holds the permission that decides it —
 * refunds (orders.refund.approve, module 05) for money, warranties (returns.warranty.manage, module 12) for a warranty —
 * and who can open the ticket (support.ticket.read). Never the person who escalates it.
 *
 *   const targets = await escalationTargets(db, actor);                  // { financial: [...], warranty: [...] }
 *   await escalateTicket(db, actor, { ticketId, kind: "financial", toEmployeeId, reason }, now);
 *   await returnEscalation(db, actor, { ticketId, outcome: "Refund R-… approved in Orders" }, now);
 *
 * NOTHING IS PAID OR RETURNED HERE. The person it is escalated to decides in Orders (a refund through createRefund /
 * approveRefund, two people) or in Returns (an RMA, a warranty decision), then hands the ticket back with what was
 * decided; the agent tells the customer. While a ticket is escalated only that person may resolve or close it (the
 * ticket service checks, also inside its write), and the customer's profile counts it as an open complaint (module 07).
 * Escalating raises the priority to at least "high" (with that priority's SLA due times) and puts the ticket back in
 * the staff's court ("pending_staff"). One guarded batch, audited (kind, to whom, why): the target's authority (active,
 * the kind's permission, ticket reading) and the ticket's status, holder and priority are checked again inside it.
 *
 * Who: escalating — support.ticket.escalate. An escalated ticket stays with its holder: only they, or a "cover" (a
 * holder of support.ticket.escalate AND the kind's permission who is NOT the person who escalated it — the requester
 * never settles their own request), may hand it back or pass it on to someone else.
 * Errors: forbidden (403), not_found (404), invalid (400), escalation_target · escalation_self · escalation_open ·
 * not_escalated · ticket_closed · ticket_changed (409).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, supportTickets, type SupportTicket } from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden } from "~/server/errors";
import { cleanBlock } from "~/server/text.server";
import { holdersOf, holdsSql, ticketAudit, ticketById } from "./shared.server";
import { dueTimesFor } from "./sla.server";
import { ESCALATION_KINDS, ESCALATION_PERMISSION, PRIORITY_RANK, isOpenTicket, type EscalationKind, type PersonRef, type TicketPriority } from "./types";

/** Who can receive each kind of escalation (never the asking employee). */
export async function escalationTargets(db: Db, actor: Actor): Promise<Record<EscalationKind, PersonRef[]>> {
  assertCan(actor, "support.ticket.escalate");
  const me = actor.kind === "employee" ? actor.id : null;
  const [financial, warranty] = await Promise.all(ESCALATION_KINDS.map((kind) => holdersOf(db, [ESCALATION_PERMISSION[kind], "support.ticket.read"])));
  return { financial: financial.filter((person) => person.id !== me), warranty: warranty.filter((person) => person.id !== me) };
}

export type EscalationTrail = {
  /** The kind of the latest escalation. */
  kind: EscalationKind | null;
  /** Who escalated it last. */
  by: string | null;
  /** Everyone who escalated it (or passed it on) since it was last handed back — none of them may settle it as a cover. */
  escalators: string[];
};

/** The ticket's current escalation from its audit trail: its kind, who escalated it, and everyone who did since the last hand-back. */
export async function lastEscalation(db: Db, ticketId: string): Promise<EscalationTrail | null> {
  const rows = await db
    .select({ action: auditEvents.action, after: auditEvents.after, actorKind: auditEvents.actorKind, actorId: auditEvents.actorId })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "support_ticket"), eq(auditEvents.entityId, ticketId), inArray(auditEvents.action, ["support.ticket.escalate", "support.ticket.escalation_return"])))
    .orderBy(asc(auditEvents.seq))
    .limit(200);
  return escalationTrail(rows);
}

/** The current escalation from a ticket's audit events in their order (pure: the ticket page reads its events once). */
export function escalationTrail(rows: readonly { action: string; after: unknown; actorKind: string; actorId: string | null }[]): EscalationTrail | null {
  let trail: EscalationTrail | null = null;
  for (const row of rows) {
    if (row.action !== "support.ticket.escalate" && row.action !== "support.ticket.escalation_return") continue;
    if (row.action === "support.ticket.escalation_return") {
      trail = null;
      continue;
    }
    const kind = (row.after as { kind?: unknown } | null)?.kind;
    const by = row.actorKind === "employee" ? row.actorId : null;
    const escalators: string[] = [...((trail as EscalationTrail | null)?.escalators ?? [])];
    if (by && !escalators.includes(by)) escalators.push(by);
    trail = { kind: (ESCALATION_KINDS as readonly string[]).includes(kind as string) ? (kind as EscalationKind) : null, by, escalators };
  }
  return trail;
}

/** The kind of the ticket's latest escalation (from its audit trail), or null. */
export async function escalationKindOf(db: Db, ticketId: string): Promise<EscalationKind | null> {
  return (await lastEscalation(db, ticketId))?.kind ?? null;
}

/**
 * Whether this actor may end or move the ticket's current escalation: the person it is escalated to ("holder"), or a
 * "cover" — someone who holds support.ticket.escalate and the kind's permission and who did not escalate it (nor pass
 * it on) since it was last handed back: the requester never settles their own request.
 */
export function settlesEscalation(actor: Actor, ticket: Pick<SupportTicket, "escalatedTo">, trail: Pick<EscalationTrail, "kind" | "escalators"> | null): "holder" | "cover" | null {
  if (!ticket.escalatedTo) return null;
  const me = actor.kind === "employee" ? actor.id : null;
  if (me !== null && me === ticket.escalatedTo) return "holder";
  const kind = trail?.kind ?? null;
  if (kind === null || !can(actor, "support.ticket.escalate") || !can(actor, ESCALATION_PERMISSION[kind])) return null;
  if (me !== null && (trail?.escalators ?? []).includes(me)) return null;
  return "cover";
}

export const EscalateInput = z.object({
  ticketId: z.string().trim().max(128),
  kind: z.enum(ESCALATION_KINDS, "invalid"),
  toEmployeeId: z.string().trim().min(1, "required").max(128),
  /** What the customer claims and why it needs this person (shown to them first). */
  reason: z.string().overwrite(cleanBlock).trim().min(10, "too_short").max(1000, "too_long"),
  /** Who the page showed as holding the escalation ("" = nobody); a stale page is refused. */
  expected: z.string().trim().max(128).default(""),
});

export async function escalateTicket(db: Db, actor: Actor, raw: z.input<typeof EscalateInput>, now: number): Promise<{ priority: TicketPriority }> {
  assertCan(actor, "support.ticket.escalate");
  const input = EscalateInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  if (!isOpenTicket(ticket.status)) throw new AppError("ticket_closed", 409, { detail: ticket.status });
  if (actor.kind === "employee" && input.toEmployeeId === actor.id) throw new AppError("escalation_self", 409, { fields: { toEmployeeId: "escalation_self" } });
  if ((ticket.escalatedTo ?? "") !== input.expected) throw new AppError("ticket_changed", 409, { detail: ticket.id });
  // an escalated ticket is passed on only by its holder or a cover — never taken from them by escalating it again
  if (ticket.escalatedTo && settlesEscalation(actor, ticket, await lastEscalation(db, ticket.id)) === null) throw new AppError("escalation_open", 409, { detail: ticket.ref });
  const permission = ESCALATION_PERMISSION[input.kind];
  const target = await holdersOf(db, [permission, "support.ticket.read"], [input.toEmployeeId]);
  if (target.length === 0) throw new AppError("escalation_target", 409, { fields: { toEmployeeId: "escalation_target" } });
  const priority: TicketPriority = PRIORITY_RANK[ticket.priority] <= PRIORITY_RANK.high ? ticket.priority : "high";
  const due = priority !== ticket.priority ? await dueTimesFor(db, priority, ticket.category, ticket.createdAt) : null;
  const targetId = sql`${input.toEmployeeId}`;
  try {
    await runBatch(db, [
      // the target's authority again, inside the write: disabled or stripped of the permission a moment ago = refused
      expectThat(
        db,
        sql`EXISTS (SELECT 1 FROM employees WHERE id = ${input.toEmployeeId} AND status = 'active' AND disabled_at IS NULL AND ${holdsSql(targetId, permission)} AND ${holdsSql(targetId, "support.ticket.read")})`,
        "ESCALATION_TARGET",
      ),
      db
        .update(supportTickets)
        .set({
          escalatedAt: now,
          escalatedTo: input.toEmployeeId,
          escalationReason: input.reason,
          priority,
          status: "pending_staff",
          updatedAt: now,
          ...(due ? { firstResponseDueAt: due.firstResponseDueAt, resolutionDueAt: due.resolutionDueAt } : {}),
        })
        .where(
          and(
            eq(supportTickets.id, ticket.id),
            eq(supportTickets.status, ticket.status),
            // the priority the new one was computed from (a priority raised meanwhile is not lowered)
            eq(supportTickets.priority, ticket.priority),
            ticket.escalatedTo ? eq(supportTickets.escalatedTo, ticket.escalatedTo) : sql`${supportTickets.escalatedTo} IS NULL`,
          ),
        ),
      expectChanged(db, 1, "TICKET_CHANGED"),
      ticketAudit(db, actor, "support.ticket.escalate", ticket, now, {
        before: { status: ticket.status, priority: ticket.priority, escalatedTo: ticket.escalatedTo },
        after: { kind: input.kind, escalatedTo: input.toEmployeeId, priority, status: "pending_staff" },
        reason: input.reason,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "ESCALATION_TARGET")) throw new AppError("escalation_target", 409, { fields: { toEmployeeId: "escalation_target" }, cause: error });
    if (isDbError(error, "TICKET_CHANGED")) throw new AppError("ticket_changed", 409, { detail: ticket.id, cause: error });
    throw error;
  }
  return { priority };
}

export const ReturnEscalationInput = z.object({
  ticketId: z.string().trim().max(128),
  /** What was decided, and where (the refund, the RMA, the warranty decision). */
  outcome: z.string().overwrite(cleanBlock).trim().min(10, "too_short").max(1000, "too_long"),
});

/**
 * The person it was escalated to (or a cover who did not escalate it) hands the ticket back to the agents with the
 * decision; the escalation stays on record.
 */
export async function returnEscalation(db: Db, actor: Actor, raw: z.input<typeof ReturnEscalationInput>, now: number): Promise<void> {
  const input = ReturnEscalationInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  if (!ticket.escalatedTo) throw new AppError("not_escalated", 409, { detail: ticket.ref });
  const last = await lastEscalation(db, ticket.id);
  const kind = last?.kind ?? null;
  if (settlesEscalation(actor, ticket, last) === null) throw forbidden(kind ? ESCALATION_PERMISSION[kind] : "support.ticket.escalate");
  try {
    await runBatch(db, [
      db
        .update(supportTickets)
        .set({ escalatedTo: null, status: isOpenTicket(ticket.status) ? "pending_staff" : ticket.status, updatedAt: now })
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.escalatedTo, ticket.escalatedTo), eq(supportTickets.status, ticket.status))),
      expectChanged(db, 1, "TICKET_CHANGED"),
      ticketAudit(db, actor, "support.ticket.escalation_return", ticket, now, { before: { escalatedTo: ticket.escalatedTo, status: ticket.status }, after: { kind, outcome: input.outcome.slice(0, 300) }, reason: input.outcome }),
    ]);
  } catch (error) {
    if (isDbError(error, "TICKET_CHANGED")) throw new AppError("ticket_changed", 409, { detail: ticket.id, cause: error });
    throw error;
  }
}
