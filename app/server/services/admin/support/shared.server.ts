/**
 * Server helpers shared by the services of admin module 14 (support): who may do what, the lookups every action
 * starts with, who the agents are (and how many open tickets each holds), names, phones as this employee may see them,
 * and the audit statement every ticket change carries.
 *
 * Authorization lives here and in each service (assertCan); a hidden button is never the control.
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { canAny, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { employees, supportTickets, type SupportTicket } from "~/server/db/schema";
import { forbidden, notFound } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { employeeNames, phoneFor } from "~/server/services/admin/orders/shared.server";
import { normalizeSupportRef } from "~/server/services/support/common.server";
import { OPEN_TICKET_STATUSES, type PhoneView } from "./types";

export { employeeNames };

/** Every permission of the module's group. */
export const SUPPORT_PERMISSIONS = [
  "support.ticket.read",
  "support.ticket.reply",
  "support.ticket.assign",
  "support.ticket.close",
  "support.ticket.escalate",
  "support.canned_reply.manage",
  "support.routing.manage",
  "support.knowledge.manage",
  "support.knowledge.approve",
  "support.assistant.review",
  "support.metrics.read",
] as const satisfies readonly Permission[];

export type SupportAccess = {
  read: boolean;
  reply: boolean;
  assign: boolean;
  close: boolean;
  escalate: boolean;
  canned: boolean;
  routing: boolean;
  knowledge: boolean;
  approve: boolean;
  assistant: boolean;
  metrics: boolean;
};

/** The sections and actions this employee may use (pages show what this says; services check again). */
export function supportAccess(actor: Actor): SupportAccess {
  return {
    read: can(actor, "support.ticket.read"),
    reply: can(actor, "support.ticket.reply"),
    assign: can(actor, "support.ticket.assign"),
    close: can(actor, "support.ticket.close"),
    escalate: can(actor, "support.ticket.escalate"),
    canned: can(actor, "support.canned_reply.manage"),
    routing: can(actor, "support.routing.manage"),
    knowledge: can(actor, "support.knowledge.manage"),
    approve: can(actor, "support.knowledge.approve"),
    assistant: can(actor, "support.assistant.review"),
    metrics: can(actor, "support.metrics.read"),
  };
}

export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions[0]);
}

export const actorId = (actor: Actor): string | null => (actor.kind === "employee" ? actor.id : null);

/** "0771 234 5678" with customer.phone.read_full, "0771 ••• ••78" without. */
export function phoneView(actor: Actor, e164: string | null | undefined): PhoneView | null {
  return phoneFor(actor, e164);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

export async function ticketById(db: Db, id: unknown): Promise<SupportTicket> {
  const row = isId(id) ? await db.select().from(supportTickets).where(eq(supportTickets.id, id)).get() : undefined;
  if (!row) throw notFound("ticket");
  return row;
}

export const normalizeTicketRef = (ref: unknown): string | null => normalizeSupportRef(ref, "SP");
export const normalizeRepairRef = (ref: unknown): string | null => normalizeSupportRef(ref, "RP");

export async function ticketByRef(db: Db, ref: unknown): Promise<SupportTicket> {
  const normalized = normalizeTicketRef(ref);
  const row = normalized ? await db.select().from(supportTickets).where(eq(supportTickets.ref, normalized)).get() : undefined;
  if (!row) throw notFound("ticket");
  return row;
}

/** SQL: "this employee's roles grant the permission" (or the owner's wildcard). */
export function holdsSql(employeeIdColumn: SQL, permission: Permission): SQL {
  return sql`EXISTS (SELECT 1 FROM employee_roles AS er JOIN role_permissions AS rp ON rp.role_id = er.role_id WHERE er.employee_id = ${employeeIdColumn} AND rp.permission IN (${permission}, '*'))`;
}

/** Active employees whose roles grant EVERY one of the permissions, by name. */
export async function holdersOf(db: Db, permissions: readonly Permission[], ids?: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids && ids.length === 0) return [];
  const conditions: (SQL | undefined)[] = [eq(employees.status, "active"), isNull(employees.disabledAt), ...permissions.map((permission) => holdsSql(sql`${employees.id}`, permission))];
  if (ids) conditions.push(inArray(employees.id, [...ids].slice(0, 90)));
  return db
    .select({ id: employees.id, name: employees.name })
    .from(employees)
    .where(and(...conditions))
    .orderBy(employees.name, employees.id);
}

/** Who may answer tickets — the people a ticket can be assigned to. */
export const agentsOf = (db: Db, ids?: readonly string[]) => holdersOf(db, ["support.ticket.read", "support.ticket.reply"], ids);

/** Open tickets each employee holds (only the ids asked for; missing = 0). */
export async function openLoads(db: Db, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = [...new Set(ids)].slice(0, 90);
  if (wanted.length === 0) return out;
  const rows = await db
    .select({ id: supportTickets.assignedTo, n: sql<number>`count(*)` })
    .from(supportTickets)
    .where(and(inArray(supportTickets.assignedTo, wanted), inArray(supportTickets.status, [...OPEN_TICKET_STATUSES])))
    .groupBy(supportTickets.assignedTo);
  for (const row of rows) if (row.id) out.set(row.id, Number(row.n));
  return out;
}

/** SQL: the number of open tickets an employee holds right now (for guards inside a batch). */
export const openLoadSql = (employeeId: string): SQL =>
  sql`(SELECT count(*) FROM support_tickets WHERE assigned_to = ${employeeId} AND status IN ('open', 'pending_customer', 'pending_staff', 'on_hold'))`;

/** The audit event of a change to a ticket (entity "support_ticket", the ref as its summary). */
export function ticketAudit(
  db: Db,
  actor: Actor,
  action: string,
  ticket: Pick<SupportTicket, "id" | "ref">,
  now: number,
  details: { before?: unknown; after?: unknown; reason?: string | null; summary?: string } = {},
): BatchStatement {
  return auditStatement(db, { actor, action, entityType: "support_ticket", entityId: ticket.id, summary: details.summary ?? ticket.ref, before: details.before, after: details.after, reason: details.reason ?? null, at: now });
}

/** Free text a person typed for staff or a customer: controls, bidi overrides and invisibles removed, trimmed. */
export { cleanBlock, cleanLine } from "~/server/text.server";
