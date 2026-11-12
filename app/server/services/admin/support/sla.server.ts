/**
 * SLA policies (14.05's clock): how long a ticket of a priority (and optionally a category) may wait for its first
 * response and for its resolution — and the due times they give the tickets.
 *
 *   const policies = await listSlaPolicies(db, actor);                                    // support.ticket.read
 *   await saveSlaPolicy(db, actor, { priority: "high", firstResponseMinutes: 240, resolutionMinutes: 1440, … }, now);
 *   await applySlaToOpenTickets(db, actor, now);                                          // tickets with no due times
 *   const due = await dueTimesFor(db, "high", "payment", ticket.createdAt);              // the storefront's rule
 *
 * The rule is the one the storefront's ticket service applies when a shopper opens a ticket: the active policy for the
 * ticket's priority AND category wins over the one for its priority and any category; due = created + minutes.
 * Calendar time (24/7, no business hours), and the clock does not stop while waiting for the customer — the page
 * says so. A change to a policy gives NEW tickets their times; open tickets keep theirs, except those that have none
 * yet, which `applySlaToOpenTickets` fills in (one audited batch). Only one active policy per priority × category.
 *
 * Who: reading — support.ticket.read (agents see their targets); changing — support.routing.manage.
 * Errors: forbidden (403), not_found (404), invalid (400), policy_duplicate · rule_changed · nothing_to_apply (409).
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { slaPolicies, supportTickets, TICKET_CATEGORIES, TICKET_PRIORITIES, type SlaPolicy, type TicketCategory, type TicketPriority } from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { cleanLine } from "~/server/text.server";
import { isId } from "./shared.server";
import { OPEN_TICKET_STATUSES, PRIORITY_RANK, SLA_LIMITS, SUGGESTED_SLA } from "./types";

export type SlaPolicyRow = {
  id: string;
  /** The policy as this page saw it (policyVersion): its form sends it back, and a policy changed meanwhile is refused. */
  version: string;
  name: string;
  priority: TicketPriority;
  category: TicketCategory | null;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  isActive: boolean;
};

const MINUTE = 60_000;

/** The policy that applies to a ticket of this priority and category (category-specific first), or null. */
export async function policyFor(db: Db, priority: TicketPriority, category: TicketCategory): Promise<SlaPolicy | null> {
  const row = await db
    .select()
    .from(slaPolicies)
    .where(and(eq(slaPolicies.isActive, true), eq(slaPolicies.priority, priority), or(eq(slaPolicies.category, category), isNull(slaPolicies.category))))
    .orderBy(desc(sql`${slaPolicies.category} IS NOT NULL`), asc(slaPolicies.id))
    .get();
  return row ?? null;
}

export type DueTimes = { firstResponseDueAt: number | null; resolutionDueAt: number | null; policyId: string | null };

export function dueFrom(policy: Pick<SlaPolicy, "id" | "firstResponseMinutes" | "resolutionMinutes"> | null, createdAt: number): DueTimes {
  if (!policy) return { firstResponseDueAt: null, resolutionDueAt: null, policyId: null };
  return { firstResponseDueAt: createdAt + policy.firstResponseMinutes * MINUTE, resolutionDueAt: createdAt + policy.resolutionMinutes * MINUTE, policyId: policy.id };
}

export async function dueTimesFor(db: Db, priority: TicketPriority, category: TicketCategory, createdAt: number): Promise<DueTimes> {
  return dueFrom(await policyFor(db, priority, category), createdAt);
}

/** A policy's version: a hash of everything its form can change (a form built from an older version is refused). */
export async function policyVersion(policy: Pick<SlaPolicy, "name" | "priority" | "category" | "firstResponseMinutes" | "resolutionMinutes" | "isActive">): Promise<string> {
  return (await sha256Hex(JSON.stringify([policy.name, policy.priority, policy.category ?? null, policy.firstResponseMinutes, policy.resolutionMinutes, Boolean(policy.isActive)]))).slice(0, 24);
}

/** SQL: an open ticket without due times that an active policy covers (what applySlaToOpenTickets can fill). */
const FILLABLE = sql`EXISTS (SELECT 1 FROM sla_policies AS p WHERE p.is_active = 1 AND p.priority = ${supportTickets.priority} AND (p.category = ${supportTickets.category} OR p.category IS NULL))`;
const WITHOUT_DUE = and(inArray(supportTickets.status, [...OPEN_TICKET_STATUSES]), isNull(supportTickets.firstResponseDueAt), isNull(supportTickets.resolutionDueAt));

export async function listSlaPolicies(db: Db, actor: Actor): Promise<{ policies: SlaPolicyRow[]; missing: { open: number; withoutDue: number; fillable: number }; canManage: boolean }> {
  assertCan(actor, "support.ticket.read");
  const [rows, missing] = await Promise.all([
    db.select().from(slaPolicies),
    db
      .select({
        open: sql<number>`count(*)`,
        withoutDue: sql<number>`sum(CASE WHEN ${supportTickets.firstResponseDueAt} IS NULL AND ${supportTickets.resolutionDueAt} IS NULL THEN 1 ELSE 0 END)`,
        // the ones "give them their due times" can fill: a policy covers their priority and topic
        fillable: sql<number>`sum(CASE WHEN ${supportTickets.firstResponseDueAt} IS NULL AND ${supportTickets.resolutionDueAt} IS NULL AND ${FILLABLE} THEN 1 ELSE 0 END)`,
      })
      .from(supportTickets)
      .where(inArray(supportTickets.status, [...OPEN_TICKET_STATUSES]))
      .get(),
  ]);
  const versions = await Promise.all(rows.map((row) => policyVersion(row)));
  const policies = rows
    .map((row, index) => ({ id: row.id, version: versions[index], name: row.name, priority: row.priority, category: row.category ?? null, firstResponseMinutes: row.firstResponseMinutes, resolutionMinutes: row.resolutionMinutes, isActive: row.isActive }))
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));
  return { policies, missing: { open: Number(missing?.open ?? 0), withoutDue: Number(missing?.withoutDue ?? 0), fillable: Number(missing?.fillable ?? 0) }, canManage: can(actor, "support.routing.manage") };
}


const minutes = z.number("invalid").int("invalid").min(SLA_LIMITS.minMinutes, "too_small").max(SLA_LIMITS.maxMinutes, "too_big");

export const SlaPolicyInput = z
  .object({
    id: z.string().trim().max(128).optional(),
    /** The version of the policy the form was built from (required to change an existing policy; policyVersion). */
    version: z.string().trim().max(64).optional(),
    name: z.string().overwrite(cleanLine).trim().min(2, "required").max(SLA_LIMITS.nameMax, "too_long"),
    priority: z.enum(TICKET_PRIORITIES, "invalid"),
    category: z.preprocess((value) => (value === "" ? null : value), z.enum(TICKET_CATEGORIES, "invalid").nullable()),
    firstResponseMinutes: minutes,
    resolutionMinutes: minutes,
    isActive: z.boolean().default(true),
    reason: z.string().overwrite(cleanLine).trim().min(3, "reason_required").max(500, "too_long"),
  })
  .refine((value) => value.resolutionMinutes >= value.firstResponseMinutes, { path: ["resolutionMinutes"], message: "resolution_before_response" });

/** Creates or changes a policy (one active policy per priority × category), audited with before and after. */
export async function saveSlaPolicy(db: Db, actor: Actor, raw: z.input<typeof SlaPolicyInput>, now: number): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "support.routing.manage");
  const input = SlaPolicyInput.parse(raw);
  const existing = input.id ? await db.select().from(slaPolicies).where(eq(slaPolicies.id, isId(input.id) ? input.id : "")).get() : undefined;
  if (input.id && !existing) throw notFound("sla_policy");
  // a form built from an older version would silently undo whatever changed since
  if (existing && input.version !== (await policyVersion(existing))) throw new AppError("rule_changed", 409, { detail: existing.id });
  const id = existing?.id ?? newId("sla");
  const values = { name: input.name, priority: input.priority, category: input.category, firstResponseMinutes: input.firstResponseMinutes, resolutionMinutes: input.resolutionMinutes, isActive: input.isActive };
  const duplicate = input.isActive
    ? expectThat(
        db,
        sql`NOT EXISTS (SELECT 1 FROM sla_policies WHERE is_active = 1 AND priority = ${input.priority} AND ${input.category === null ? sql`category IS NULL` : sql`category = ${input.category}`} AND id <> ${id})`,
        "SLA_DUPLICATE",
      )
    : null;
  const statements: BatchStatement[] = [];
  if (duplicate) statements.push(duplicate);
  if (existing) {
    statements.push(
      db
        .update(slaPolicies)
        .set(values)
        .where(
          and(
            eq(slaPolicies.id, id),
            eq(slaPolicies.name, existing.name),
            eq(slaPolicies.priority, existing.priority),
            existing.category === null ? isNull(slaPolicies.category) : eq(slaPolicies.category, existing.category),
            eq(slaPolicies.firstResponseMinutes, existing.firstResponseMinutes),
            eq(slaPolicies.resolutionMinutes, existing.resolutionMinutes),
            eq(slaPolicies.isActive, existing.isActive),
          ),
        ),
      expectChanged(db, 1, "RULE_CHANGED"),
    );
  } else {
    statements.push(db.insert(slaPolicies).values({ id, ...values }));
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: existing ? "support.sla.update" : "support.sla.create",
      entityType: "sla_policy",
      entityId: id,
      summary: input.name,
      before: existing ? { priority: existing.priority, category: existing.category, firstResponseMinutes: existing.firstResponseMinutes, resolutionMinutes: existing.resolutionMinutes, isActive: existing.isActive } : null,
      after: values,
      reason: input.reason,
      at: now,
    }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "SLA_DUPLICATE")) throw new AppError("policy_duplicate", 409, { fields: { priority: "policy_duplicate" } });
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409, { detail: id });
    throw error;
  }
  return { id, created: !existing };
}

/**
 * The suggested targets (types.ts SUGGESTED_SLA) as four policies, one per priority — only where no active policy for
 * that priority and any category exists yet. One batch, audited; a second call adds nothing (nothing_to_apply).
 */
export async function adoptSuggestedSla(db: Db, actor: Actor, raw: { reason?: string }, now: number): Promise<{ added: number }> {
  assertCan(actor, "support.routing.manage");
  const reason = z.string().overwrite(cleanLine).trim().min(3, "reason_required").max(500, "too_long").parse(raw.reason ?? "");
  const active = await db.select({ priority: slaPolicies.priority }).from(slaPolicies).where(and(eq(slaPolicies.isActive, true), isNull(slaPolicies.category)));
  const have = new Set(active.map((row) => row.priority));
  const rows = SUGGESTED_SLA.filter((entry) => !have.has(entry.priority)).map((entry) => ({ id: newId("sla"), name: entry.priority, priority: entry.priority, category: null, firstResponseMinutes: entry.firstResponseMinutes, resolutionMinutes: entry.resolutionMinutes, isActive: true }));
  if (rows.length === 0) throw new AppError("nothing_to_apply", 409);
  const statements: BatchStatement[] = [];
  for (const row of rows) {
    statements.push(expectThat(db, sql`NOT EXISTS (SELECT 1 FROM sla_policies WHERE is_active = 1 AND priority = ${row.priority} AND category IS NULL)`, "SLA_DUPLICATE"), db.insert(slaPolicies).values(row));
  }
  statements.push(auditStatement(db, { actor, action: "support.sla.adopt", entityType: "sla_policy", entityId: null, summary: `${rows.length}`, after: rows.map(({ priority, firstResponseMinutes, resolutionMinutes }) => ({ priority, firstResponseMinutes, resolutionMinutes })), reason, at: now }));
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "SLA_DUPLICATE")) throw new AppError("policy_duplicate", 409);
    throw error;
  }
  return { added: rows.length };
}

/**
 * Gives the open tickets that have no due times yet the ones their policy sets now (from when each ticket was opened)
 * — exactly the tickets the page counts as "fillable" (a policy covers their priority and topic); those without a
 * policy keep waiting for one. A ticket that already has a time keeps it. Up to 500 per call, each update guarded on
 * "still without due times".
 */
export async function applySlaToOpenTickets(db: Db, actor: Actor, raw: { reason?: string }, now: number): Promise<{ updated: number; withoutPolicy: number }> {
  assertCan(actor, "support.routing.manage");
  const reason = z.string().overwrite(cleanLine).trim().min(3, "reason_required").max(500, "too_long").parse(raw.reason ?? "");
  const [tickets, policies, uncovered] = await Promise.all([
    db
      .select({ id: supportTickets.id, ref: supportTickets.ref, priority: supportTickets.priority, category: supportTickets.category, createdAt: supportTickets.createdAt })
      .from(supportTickets)
      .where(and(WITHOUT_DUE, FILLABLE))
      .orderBy(asc(supportTickets.createdAt))
      .limit(500),
    db.select().from(slaPolicies).where(eq(slaPolicies.isActive, true)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(supportTickets)
      .where(and(WITHOUT_DUE, sql`NOT ${FILLABLE}`))
      .get(),
  ]);
  const pick = (priority: TicketPriority, category: TicketCategory) =>
    policies.find((policy) => policy.priority === priority && policy.category === category) ?? policies.find((policy) => policy.priority === priority && policy.category === null) ?? null;
  const updates: { id: string; ref: string; due: DueTimes }[] = [];
  let withoutPolicy = Number(uncovered?.n ?? 0);
  for (const ticket of tickets) {
    const due = dueFrom(pick(ticket.priority, ticket.category), ticket.createdAt);
    if (due.policyId) updates.push({ id: ticket.id, ref: ticket.ref, due });
    else withoutPolicy++;
  }
  if (updates.length === 0) throw new AppError("nothing_to_apply", 409, { detail: `${withoutPolicy} without a policy` });
  const statements: BatchStatement[] = updates.map((entry) =>
    db
      .update(supportTickets)
      .set({ firstResponseDueAt: entry.due.firstResponseDueAt, resolutionDueAt: entry.due.resolutionDueAt, updatedAt: now })
      .where(and(eq(supportTickets.id, entry.id), isNull(supportTickets.firstResponseDueAt), isNull(supportTickets.resolutionDueAt))),
  );
  statements.push(
    auditStatement(db, {
      actor,
      action: "support.sla.apply",
      entityType: "sla_policy",
      entityId: null,
      summary: `${updates.length}`,
      after: { tickets: updates.slice(0, 100).map((entry) => ({ ref: entry.ref, policyId: entry.due.policyId, firstResponseDueAt: entry.due.firstResponseDueAt, resolutionDueAt: entry.due.resolutionDueAt })), count: updates.length },
      reason,
      at: now,
    }),
  );
  await runBatch(db, statements);
  return { updated: updates.length, withoutPolicy };
}
