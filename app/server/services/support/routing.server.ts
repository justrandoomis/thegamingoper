/**
 * A message to staff is routed the moment it arrives — by the support module's own rules and engine (admin 14.03,
 * routeTicket as the system: topic, channel and keywords, the agent pool and its capacity, the reason in the audit
 * trail). The scheduled job (routeWaitingTickets, every few minutes) still routes whatever this misses.
 *
 *   afterResponse(routeOnArrival(db, ticket.ticketId, ctx.now), "ticket routing");   // after the hand-off's answer
 *
 * Never fails the shopper's request: a ticket that cannot be routed now (no rule, a full pool, a moment's conflict)
 * waits for the job, and the failure is only logged.
 */
import { systemActor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { routeTicket } from "~/server/services/admin/support/routing.server";

/** The routing system actor (the same one the scheduled job routes as). */
export const ROUTING_ACTOR = "support.route";

export async function routeOnArrival(db: Db, ticketId: string, now: number): Promise<"routed" | "waiting"> {
  try {
    await routeTicket(db, systemActor(ROUTING_ACTOR), { ticketId }, now);
    return "routed";
  } catch (error) {
    console.error("[support] routing on arrival failed — the scheduled job routes it", error);
    return "waiting";
  }
}
