/**
 * Routing (14.03): rules by topic (category, channel, keywords), priority and agent capacity, and the engine that
 * applies them — with the reason a ticket went where it went written into the audit trail (the ticket page puts it into
 * words: "rule «Payments» matched category: payment — assigned to Sara, 3 of 10 open tickets").
 *
 *   const page = await listRoutingRules(db, actor);                                   // rules + every agent's load
 *   await saveRoutingRule(db, actor, { name, categories, keywords, agents, capacity, team, setPriority, … }, now);
 *   const decision = await routeTicket(db, actor, { ticketId }, now);                 // one ticket (support.ticket.assign)
 *   await routeWaitingTickets(db, systemActor("support.route"), now);                 // every open, unrouted ticket
 *
 * A rule's row: `conditions` holds the match lists (types.ts RuleConditions) AND the assignment pool (`agents`, employee
 * ids) with its `capacity` (most open tickets per agent); `team` is the queue the ticket joins; `set_priority` raises or
 * lowers its priority (and with it the SLA due times). `assign_to` is left empty: a pool of one is a fixed assignment.
 * Rules run in `sort` order and the first match wins. The pool's agent with the fewest open tickets under the capacity
 * gets the ticket — checked again INSIDE the batch (a guard counts that agent's open tickets), so two tickets routed at
 * the same moment cannot push an agent over the limit; with the pool full the ticket waits in the team's queue.
 * "Waiting to be routed" = open, nobody holds it, no team, and no routing decision recorded yet — so a ticket no rule
 * matched is not tried again on every run (an assigner may route it again by hand).
 *
 * Who: reading the rules — support.ticket.assign or support.routing.manage; changing them — support.routing.manage;
 * routing a ticket — support.ticket.assign (or the system).
 * Errors: forbidden (403), not_found (404), invalid (400), rule_changed · ticket_changed · pool_empty (409).
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { auditEvents, supportTickets, ticketMessages, ticketRoutingRules, TICKET_CATEGORIES, TICKET_CHANNELS, TICKET_PRIORITIES, type SupportTicket, type TicketRoutingRule } from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { cleanLine } from "~/server/text.server";
import { agentsOf, employeeNames, isId, openLoadSql, openLoads, ticketAudit, ticketById } from "./shared.server";
import { dueTimesFor } from "./sla.server";
import {
  DEFAULT_CAPACITY,
  OPEN_TICKET_STATUSES,
  RULE_LIMITS,
  normalizeTeam,
  pickAgent,
  ruleMatches,
  type AgentLoad,
  type PersonRef,
  type RouteDecision,
  type RuleConditions,
  type TicketCategory,
  type TicketChannel,
  type TicketPriority,
} from "./types";

export const ROUTE_ACTION = "support.ticket.route";

export type RoutingRuleRow = {
  id: string;
  /** The rule as this page saw it (ruleVersion): its forms send it back, and a rule changed meanwhile is refused. */
  version: string;
  name: string;
  sort: number;
  isActive: boolean;
  team: string | null;
  setPriority: TicketPriority | null;
  categories: TicketCategory[];
  channels: TicketChannel[];
  priorities: TicketPriority[];
  keywords: string[];
  pool: PersonRef[];
  /** Pool members who can no longer answer tickets (disabled, role changed): kept on the rule, skipped when routing. */
  inactive: string[];
  capacity: number;
};

/** A stored rule's conditions, read defensively (a hand-edited row cannot break routing). */
export function conditionsOf(rule: Pick<TicketRoutingRule, "conditions">): RuleConditions {
  const raw = (rule.conditions ?? {}) as Record<string, unknown>;
  const list = <T extends string>(value: unknown, allowed: readonly T[]): T[] => (Array.isArray(value) ? value.filter((entry): entry is T => typeof entry === "string" && (allowed as readonly string[]).includes(entry)) : []);
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").slice(0, 30) : []);
  const capacity = typeof raw.capacity === "number" && Number.isInteger(raw.capacity) && raw.capacity >= 1 ? Math.min(raw.capacity, RULE_LIMITS.capacityMax) : DEFAULT_CAPACITY;
  return {
    categories: list(raw.categories ?? raw.category, TICKET_CATEGORIES),
    channels: list(raw.channels ?? raw.channel, TICKET_CHANNELS),
    priorities: list(raw.priorities ?? raw.priority, TICKET_PRIORITIES),
    keywords: strings(raw.keywords),
    agents: strings(raw.agents).filter(isId),
    capacity,
  };
}

function readable(actor: Actor): void {
  if (!canAny(actor, ["support.ticket.assign", "support.routing.manage"])) throw forbidden("support.routing.manage");
}

/**
 * A rule's version: a hash of everything its form can change (name, conditions with the pool and capacity, team,
 * priority, place, on/off). The page sends the version it showed; a different one means someone changed the rule
 * meanwhile, and saving over it would silently undo their change (rule_changed).
 */
export async function ruleVersion(rule: Pick<TicketRoutingRule, "name" | "conditions" | "team" | "setPriority" | "sort" | "isActive">): Promise<string> {
  return (await sha256Hex(JSON.stringify([rule.name, rule.conditions ?? null, rule.team ?? null, rule.setPriority ?? null, rule.sort, Boolean(rule.isActive)]))).slice(0, 24);
}

export async function listRoutingRules(db: Db, actor: Actor): Promise<{ rules: RoutingRuleRow[]; agents: AgentLoad[]; teams: string[]; canManage: boolean; waiting: number }> {
  readable(actor);
  const [rules, agents, teamRows, waiting] = await Promise.all([
    db.select().from(ticketRoutingRules).orderBy(asc(ticketRoutingRules.sort), asc(ticketRoutingRules.id)),
    agentsOf(db),
    db.selectDistinct({ team: supportTickets.team }).from(supportTickets).where(sql`${supportTickets.team} IS NOT NULL`).limit(50),
    countWaitingToRoute(db),
  ]);
  const loads = await openLoads(
    db,
    agents.map((agent) => agent.id),
  );
  const agentIds = new Set(agents.map((agent) => agent.id));
  const pooled = [...new Set(rules.flatMap((rule) => conditionsOf(rule).agents ?? []))];
  const names = await employeeNames(db, pooled);
  const versions = await Promise.all(rules.map((rule) => ruleVersion(rule)));
  const teams = new Set<string>();
  for (const row of teamRows) if (row.team) teams.add(row.team);
  for (const rule of rules) if (rule.team) teams.add(rule.team);
  return {
    rules: rules.map((rule, index) => {
      const conditions = conditionsOf(rule);
      const pool = conditions.agents ?? [];
      return {
        id: rule.id,
        version: versions[index],
        name: rule.name,
        sort: rule.sort,
        isActive: rule.isActive,
        team: rule.team,
        setPriority: rule.setPriority,
        categories: conditions.categories ?? [],
        channels: conditions.channels ?? [],
        priorities: conditions.priorities ?? [],
        keywords: conditions.keywords ?? [],
        pool: pool.map((id) => ({ id, name: names.get(id) ?? id })),
        inactive: pool.filter((id) => !agentIds.has(id)),
        capacity: conditions.capacity ?? DEFAULT_CAPACITY,
      };
    }),
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, open: loads.get(agent.id) ?? 0 })),
    teams: [...teams].sort(),
    canManage: can(actor, "support.routing.manage"),
    waiting,
  };
}

// ───────────────────────────────────────────────────────────────── editing rules

const listOf = <T extends string>(allowed: readonly T[]) => z.array(z.enum(allowed as unknown as [T, ...T[]], "invalid")).max(20, "too_big").default([]);

/** Keywords typed as one text: separated by commas (Latin or Arabic) or new lines. */
export function splitKeywords(text: string): string[] {
  const out: string[] = [];
  for (const part of cleanLine(text.replace(/[\r\n]+/g, ",")).split(/[,،؛;]+/)) {
    const word = part.trim().replace(/\s+/g, " ");
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

export const RoutingRuleInput = z.object({
  id: z.string().trim().max(128).optional(),
  /** The version of the rule the form was built from (required to change an existing rule; ruleVersion). */
  version: z.string().trim().max(64).optional(),
  name: z.string().overwrite(cleanLine).trim().min(2, "required").max(RULE_LIMITS.nameMax, "too_long"),
  categories: listOf(TICKET_CATEGORIES),
  channels: listOf(TICKET_CHANNELS),
  priorities: listOf(TICKET_PRIORITIES),
  keywords: z.string().max(2000, "too_long").default(""),
  agents: z.array(z.string().trim().max(128)).max(RULE_LIMITS.agents, "too_big").default([]),
  capacity: z.number("invalid").int("invalid").min(RULE_LIMITS.capacityMin, "too_small").max(RULE_LIMITS.capacityMax, "too_big").default(DEFAULT_CAPACITY),
  team: z.string().trim().max(40, "too_long").default(""),
  setPriority: z.preprocess((value) => (value === "" ? null : value), z.enum(TICKET_PRIORITIES, "invalid").nullable().default(null)),
  isActive: z.boolean().default(true),
  reason: z.string().overwrite(cleanLine).trim().min(3, "reason_required").max(500, "too_long"),
});

/** Creates or changes a rule. The pool must be people who can answer tickets; a rule must do something. */
export async function saveRoutingRule(db: Db, actor: Actor, raw: z.input<typeof RoutingRuleInput>, now: number): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "support.routing.manage");
  const input = RoutingRuleInput.parse(raw);
  const keywords = splitKeywords(input.keywords);
  const fields: Record<string, string> = {};
  if (keywords.length > RULE_LIMITS.keywords) fields.keywords = "too_big";
  if (keywords.some((word) => word.length > RULE_LIMITS.keywordLength)) fields.keywords = "too_long";
  const team = input.team ? normalizeTeam(input.team) : null;
  if (input.team && !team) fields.team = "invalid";
  const pool = [...new Set(input.agents.filter((id) => id !== ""))];
  if (pool.some((id) => !isId(id))) fields.agents = "invalid";
  if (pool.length > 0) {
    const eligible = await agentsOf(db, pool);
    if (eligible.length !== pool.length) fields.agents = "assignee_not_agent";
  }
  if (!team && pool.length === 0 && !input.setPriority) fields.team = "rule_does_nothing";
  if (Object.keys(fields).length > 0) throw invalid(fields);

  const existing = input.id ? await db.select().from(ticketRoutingRules).where(eq(ticketRoutingRules.id, isId(input.id) ? input.id : "")).get() : undefined;
  if (input.id && !existing) throw notFound("routing_rule");
  // a form built from an older version would silently undo whatever changed since (another pool, keywords, team)
  if (existing && input.version !== (await ruleVersion(existing))) throw new AppError("rule_changed", 409, { detail: existing.id });
  const conditions: RuleConditions = {
    categories: input.categories,
    channels: input.channels,
    priorities: input.priorities,
    keywords,
    agents: pool,
    capacity: input.capacity,
  };
  const id = existing?.id ?? newId("rtr");
  let sort = existing?.sort ?? 10;
  if (!existing) {
    const last = await db.select({ max: sql<number | null>`max(${ticketRoutingRules.sort})` }).from(ticketRoutingRules).get();
    sort = Number(last?.max ?? 0) + 10;
  }
  const values = { name: input.name, conditions, assignTo: null, team, setPriority: input.setPriority, sort, isActive: input.isActive };
  const statements: BatchStatement[] = existing
    ? [
        db
          .update(ticketRoutingRules)
          .set(values)
          .where(
            and(
              eq(ticketRoutingRules.id, id),
              eq(ticketRoutingRules.name, existing.name),
              eq(ticketRoutingRules.sort, existing.sort),
              eq(ticketRoutingRules.isActive, existing.isActive),
              existing.team === null ? isNull(ticketRoutingRules.team) : eq(ticketRoutingRules.team, existing.team),
              existing.setPriority === null ? isNull(ticketRoutingRules.setPriority) : eq(ticketRoutingRules.setPriority, existing.setPriority),
            ),
          ),
        expectChanged(db, 1, "RULE_CHANGED"),
      ]
    : [db.insert(ticketRoutingRules).values({ id, ...values })];
  statements.push(
    auditStatement(db, {
      actor,
      action: existing ? "support.routing.update" : "support.routing.create",
      entityType: "routing_rule",
      entityId: id,
      summary: input.name,
      before: existing ? { name: existing.name, conditions: existing.conditions, team: existing.team, setPriority: existing.setPriority, isActive: existing.isActive } : null,
      after: { name: input.name, conditions, team, setPriority: input.setPriority, isActive: input.isActive },
      reason: input.reason,
      at: now,
    }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409, { detail: id });
    throw error;
  }
  return { id, created: !existing };
}

/** Moves a rule one place earlier or later (swaps the two sorts in one guarded batch). */
export async function moveRoutingRule(db: Db, actor: Actor, raw: { ruleId?: string; direction?: string }, now: number): Promise<void> {
  assertCan(actor, "support.routing.manage");
  const rules = await db.select().from(ticketRoutingRules).orderBy(asc(ticketRoutingRules.sort), asc(ticketRoutingRules.id));
  const index = rules.findIndex((rule) => rule.id === raw.ruleId);
  if (index === -1) throw notFound("routing_rule");
  if (raw.direction !== "up" && raw.direction !== "down") throw invalid({ direction: "invalid" });
  const other = rules[raw.direction === "up" ? index - 1 : index + 1];
  if (!other) return;
  const rule = rules[index];
  // equal sorts (a hand-made table) are pulled apart so the swap always changes the order
  const [a, b] = rule.sort === other.sort ? (raw.direction === "up" ? [other.sort - 1, other.sort] : [other.sort + 1, other.sort]) : [other.sort, rule.sort];
  try {
    await runBatch(db, [
      db.update(ticketRoutingRules).set({ sort: a }).where(and(eq(ticketRoutingRules.id, rule.id), eq(ticketRoutingRules.sort, rule.sort))),
      expectChanged(db, 1, "RULE_CHANGED"),
      db.update(ticketRoutingRules).set({ sort: b }).where(and(eq(ticketRoutingRules.id, other.id), eq(ticketRoutingRules.sort, other.sort))),
      expectChanged(db, 1, "RULE_CHANGED"),
      auditStatement(db, { actor, action: "support.routing.move", entityType: "routing_rule", entityId: rule.id, summary: rule.name, before: { sort: rule.sort }, after: { sort: a, swappedWith: other.id }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409, { detail: rule.id });
    throw error;
  }
}

/**
 * Removes a rule (its whole content stays in the audit event). Tickets it routed keep their assignment. With the
 * version the page showed, a rule someone changed meanwhile is not deleted (rule_changed): they look again first.
 */
export async function deleteRoutingRule(db: Db, actor: Actor, raw: { ruleId?: string; reason?: string; version?: string }, now: number): Promise<void> {
  assertCan(actor, "support.routing.manage");
  const reason = z.string().overwrite(cleanLine).trim().min(3, "reason_required").max(500, "too_long").parse(raw.reason ?? "");
  const rule = isId(raw.ruleId) ? await db.select().from(ticketRoutingRules).where(eq(ticketRoutingRules.id, raw.ruleId)).get() : undefined;
  if (!rule) throw notFound("routing_rule");
  if (raw.version !== undefined && raw.version !== (await ruleVersion(rule))) throw new AppError("rule_changed", 409, { detail: rule.id });
  try {
    await runBatch(db, [
      db.delete(ticketRoutingRules).where(and(eq(ticketRoutingRules.id, rule.id), eq(ticketRoutingRules.sort, rule.sort))),
      expectChanged(db, 1, "RULE_CHANGED"),
      auditStatement(db, { actor, action: "support.routing.delete", entityType: "routing_rule", entityId: rule.id, summary: rule.name, before: { name: rule.name, conditions: rule.conditions, team: rule.team, setPriority: rule.setPriority, sort: rule.sort, isActive: rule.isActive }, reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409, { detail: rule.id });
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────── the engine

/** The words a ticket is matched on: its subject and the customer's first message. */
export async function ticketText(db: Db, ticket: Pick<SupportTicket, "id" | "subject">): Promise<string> {
  const first = await db
    .select({ body: ticketMessages.body })
    .from(ticketMessages)
    .where(and(eq(ticketMessages.ticketId, ticket.id), eq(ticketMessages.authorKind, "customer"), eq(ticketMessages.isInternal, false)))
    .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id))
    .get();
  return `${ticket.subject}\n${first?.body ?? ""}`.slice(0, 5000);
}

export type Rules = { rule: TicketRoutingRule; conditions: RuleConditions }[];

export async function activeRules(db: Db): Promise<Rules> {
  const rows = await db.select().from(ticketRoutingRules).where(eq(ticketRoutingRules.isActive, true)).orderBy(asc(ticketRoutingRules.sort), asc(ticketRoutingRules.id));
  return rows.map((rule) => ({ rule, conditions: conditionsOf(rule) }));
}

/**
 * The decision for one ticket: the first matching rule, its team and priority, and the agent of its pool with the
 * fewest open tickets under the capacity (`loads`: open tickets per agent, updated by the caller as it assigns).
 */
export function decideRoute(ticket: Pick<SupportTicket, "category" | "channel" | "priority">, text: string, rules: Rules, loads: Map<string, number>, eligible: Map<string, string>): RouteDecision {
  const facts = { category: ticket.category, channel: ticket.channel, priority: ticket.priority, text };
  for (const { rule, conditions } of rules) {
    const matched = ruleMatches(conditions, facts);
    if (!matched) continue;
    const priority = rule.setPriority ?? null;
    const pool: AgentLoad[] = (conditions.agents ?? []).filter((id) => eligible.has(id)).map((id) => ({ id, name: eligible.get(id) ?? id, open: loads.get(id) ?? 0 }));
    const capacity = conditions.capacity ?? DEFAULT_CAPACITY;
    if ((conditions.agents ?? []).length === 0) return { ruleId: rule.id, ruleName: rule.name, matched, team: rule.team, priority, agent: null, fallback: null };
    const { agent, why } = pickAgent(pool, capacity);
    return { ruleId: rule.id, ruleName: rule.name, matched, team: rule.team, priority, agent: agent ? { ...agent, capacity } : null, fallback: why };
  }
  return { ruleId: null, ruleName: null, matched: null, team: null, priority: null, agent: null, fallback: "no_rule" };
}

/**
 * The statements that apply a decision: the ticket's agent, team and priority (with the SLA due times of the new
 * priority) — guarded on "nobody changed who holds it" and, for an agent, on "still under the capacity" — and the
 * audit event with the whole decision. `force` re-routes a ticket someone already holds.
 */
async function applyStatements(db: Db, actor: Actor, ticket: SupportTicket, decision: RouteDecision, now: number, force: boolean): Promise<BatchStatement[]> {
  const statements: BatchStatement[] = [];
  const set: Partial<typeof supportTickets.$inferInsert> = {};
  if (decision.agent) set.assignedTo = decision.agent.id;
  if (decision.team && decision.team !== ticket.team) set.team = decision.team;
  if (decision.priority && decision.priority !== ticket.priority) {
    set.priority = decision.priority;
    const due = await dueTimesFor(db, decision.priority, ticket.category, ticket.createdAt);
    set.firstResponseDueAt = due.firstResponseDueAt;
    set.resolutionDueAt = due.resolutionDueAt;
  }
  // the capacity is checked again here, inside the batch (an agent who already holds this ticket gains nothing)
  if (decision.agent && decision.agent.id !== ticket.assignedTo) statements.push(expectThat(db, sql`${openLoadSql(decision.agent.id)} < ${decision.agent.capacity}`, "CAPACITY_FULL"));
  const unchanged = and(
    eq(supportTickets.id, ticket.id),
    inArray(supportTickets.status, [...OPEN_TICKET_STATUSES]),
    ticket.assignedTo ? eq(supportTickets.assignedTo, ticket.assignedTo) : isNull(supportTickets.assignedTo),
    force ? undefined : isNull(supportTickets.team),
  );
  if (Object.keys(set).length > 0) {
    statements.push(db.update(supportTickets).set({ ...set, updatedAt: now }).where(unchanged), expectChanged(db, 1, "TICKET_CHANGED"));
  } else {
    // nothing to change: the decision is still recorded once, so the ticket is not tried again on every run
    statements.push(
      expectThat(
        db,
        sql`EXISTS (SELECT 1 FROM support_tickets WHERE id = ${ticket.id} AND status IN ('open', 'pending_customer', 'pending_staff', 'on_hold') AND ${ticket.assignedTo ? sql`assigned_to = ${ticket.assignedTo}` : sql`assigned_to IS NULL`})`,
        "TICKET_CHANGED",
      ),
    );
    if (!force) statements.push(expectThat(db, sql`NOT EXISTS (SELECT 1 FROM audit_events WHERE entity_type = 'support_ticket' AND entity_id = ${ticket.id} AND action = ${ROUTE_ACTION})`, "TICKET_CHANGED"));
  }
  statements.push(
    ticketAudit(db, actor, ROUTE_ACTION, ticket, now, {
      before: { assignedTo: ticket.assignedTo, team: ticket.team, priority: ticket.priority },
      after: { ...decision, forced: force },
    }),
  );
  return statements;
}

export async function eligibleAgents(db: Db): Promise<Map<string, string>> {
  return new Map((await agentsOf(db)).map((agent) => [agent.id, agent.name]));
}

/** Routes one ticket now — by hand, so also one somebody holds or a rule was already tried on. Returns the decision applied. */
export async function routeTicket(db: Db, actor: Actor, raw: { ticketId?: string }, now: number): Promise<RouteDecision> {
  assertCan(actor, "support.ticket.assign");
  const ticket = await ticketById(db, raw.ticketId);
  if (!OPEN_TICKET_STATUSES.includes(ticket.status as (typeof OPEN_TICKET_STATUSES)[number])) throw new AppError("ticket_closed", 409, { detail: ticket.status });
  // routing by hand is always deliberate: it may re-route a ticket someone holds, or one a rule was already tried on
  const force = true;
  const [rules, eligible] = await Promise.all([activeRules(db), eligibleAgents(db)]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = attempt === 0 ? ticket : await ticketById(db, ticket.id);
    const loads = await openLoads(db, [...eligible.keys()]);
    if (fresh.assignedTo) loads.set(fresh.assignedTo, Math.max(0, (loads.get(fresh.assignedTo) ?? 1) - 1));
    const decision = decideRoute(fresh, await ticketText(db, fresh), rules, loads, eligible);
    try {
      await runBatch(db, await applyStatements(db, actor, fresh, decision, now, force));
      return decision;
    } catch (error) {
      if (isDbError(error, "CAPACITY_FULL")) continue;
      if (isDbError(error, "TICKET_CHANGED")) throw new AppError("ticket_changed", 409, { detail: ticket.id });
      throw error;
    }
  }
  throw new AppError("ticket_changed", 409, { detail: "capacity changed while routing" });
}

const waitingWhere = () =>
  and(
    inArray(supportTickets.status, [...OPEN_TICKET_STATUSES]),
    isNull(supportTickets.assignedTo),
    isNull(supportTickets.team),
    sql`NOT EXISTS (SELECT 1 FROM audit_events WHERE entity_type = 'support_ticket' AND entity_id = ${supportTickets.id} AND action = ${ROUTE_ACTION})`,
  );

export async function countWaitingToRoute(db: Db): Promise<number> {
  const row = await db.select({ n: sql<number>`count(*)` }).from(supportTickets).where(waitingWhere()).get();
  return Number(row?.n ?? 0);
}

/**
 * Routes every open ticket nobody holds and no rule was tried on yet, oldest first (at most `limit` per call). For the
 * inbox's "route waiting tickets" key and for a scheduled job (actor = systemActor("support.route")).
 */
export async function routeWaitingTickets(db: Db, actor: Actor, now: number, limit = 50): Promise<{ routed: number; assigned: number; queued: number; unmatched: number; skipped: number }> {
  assertCan(actor, "support.ticket.assign");
  const tickets = await db.select().from(supportTickets).where(waitingWhere()).orderBy(asc(supportTickets.createdAt)).limit(Math.max(1, Math.min(limit, 200)));
  const out = { routed: 0, assigned: 0, queued: 0, unmatched: 0, skipped: 0 };
  if (tickets.length === 0) return out;
  const [rules, eligible] = await Promise.all([activeRules(db), eligibleAgents(db)]);
  const loads = await openLoads(db, [...eligible.keys()]);
  for (const ticket of tickets) {
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      const decision = decideRoute(ticket, await ticketText(db, ticket), rules, loads, eligible);
      try {
        await runBatch(db, await applyStatements(db, actor, ticket, decision, now, false));
        done = true;
        out.routed++;
        if (decision.agent) {
          out.assigned++;
          loads.set(decision.agent.id, (loads.get(decision.agent.id) ?? 0) + 1);
        } else if (decision.ruleId) out.queued++;
        else out.unmatched++;
      } catch (error) {
        if (isDbError(error, "CAPACITY_FULL")) {
          const fresh = await openLoads(db, [...eligible.keys()]);
          for (const [id, n] of fresh) loads.set(id, n);
          continue;
        }
        if (isDbError(error, "TICKET_CHANGED")) {
          out.skipped++;
          done = true;
          continue;
        }
        throw error;
      }
    }
    if (!done) out.skipped++;
  }
  return out;
}

/** The latest routing decision recorded for a ticket (the ticket page's "why it is here"). */
export async function lastRouteDecision(db: Db, ticketId: string): Promise<{ at: number; decision: RouteDecision; actorKind: string } | null> {
  const row = await db
    .select({ at: auditEvents.at, after: auditEvents.after, actorKind: auditEvents.actorKind })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "support_ticket"), eq(auditEvents.entityId, ticketId), eq(auditEvents.action, ROUTE_ACTION)))
    .orderBy(sql`${auditEvents.seq} DESC`)
    .get();
  if (!row?.after || typeof row.after !== "object") return null;
  return { at: row.at, decision: row.after as RouteDecision, actorKind: row.actorKind };
}

/**
 * A dry run: how many of the last open tickets a rule (as typed, not saved) would take — nothing is written. Which
 * tickets they are (reference and subject) only for someone who may read tickets; a rule manager without that
 * permission gets the numbers.
 */
export async function previewRule(db: Db, actor: Actor, raw: Omit<z.input<typeof RoutingRuleInput>, "reason">): Promise<{ checked: number; count: number; matches: { ref: string; subject: string; why: ReturnType<typeof ruleMatches> }[] }> {
  readable(actor);
  const input = RoutingRuleInput.omit({ reason: true }).parse(raw);
  const conditions: RuleConditions = { categories: input.categories, channels: input.channels, priorities: input.priorities, keywords: splitKeywords(input.keywords) };
  const tickets = await db.select().from(supportTickets).where(inArray(supportTickets.status, [...OPEN_TICKET_STATUSES])).orderBy(sql`${supportTickets.createdAt} DESC`).limit(100);
  const matches: { ref: string; subject: string; why: ReturnType<typeof ruleMatches> }[] = [];
  for (const ticket of tickets) {
    const why = ruleMatches(conditions, { category: ticket.category, channel: ticket.channel, priority: ticket.priority, text: await ticketText(db, ticket) });
    if (why) matches.push({ ref: ticket.ref, subject: ticket.subject, why });
  }
  return { checked: tickets.length, count: matches.length, matches: can(actor, "support.ticket.read") ? matches.slice(0, 20) : [] };
}
