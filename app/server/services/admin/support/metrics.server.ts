/**
 * Service metrics (14.05): first-response and resolution times computed from the tickets' own events — the first
 * public reply staff recorded (ticket_messages: author "employee", not internal), the time it was resolved
 * (`resolved_at`, written by the status change) — against their SLA due times; the backlog now; per agent, category,
 * priority and channel; and repairs (module 12's requests: the first thing staff did, the hand-back).
 *
 *   const metrics = await supportMetrics(db, actor, { days: 30, demo: false }, now);
 *
 * Customer satisfaction is shown ONLY when it is really collected: the store sends no survey (no messaging provider)
 * and the storefront has no rating page, so `csat_rating` stays empty and the metric says "not collected" — never a 0
 * or an invented score. The moment ratings exist they are counted (answered of resolved, the average, the spread).
 * Times are calendar minutes (no business hours); a period with nothing to measure gives null ("—" with the reason),
 * never 0. Demo records are left out unless asked for (the page says which). At most 5,000 tickets per period
 * (`truncated` says when more exist).
 *
 * Who: support.metrics.read.
 */
import { sql } from "drizzle-orm";
import { assertCan, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { employeeNames } from "./shared.server";
import { METRIC_DAYS, median, percentile, share, type MetricDays, type TicketCategory, type TicketChannel, type TicketPriority, type TicketStatus } from "./types";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LIMIT = 5000;

export type DurationStat = {
  /** How many were measured. */
  count: number;
  /** Minutes. */
  median: number | null;
  p90: number | null;
  /** Of those with a due time: the share done by it (0–1), null when none had one. */
  withinSla: number | null;
  withDue: number;
};

export type GroupRow<K extends string> = { key: K; created: number; firstResponse: DurationStat; resolution: DurationStat };

export type SupportMetrics = {
  period: { from: number; to: number; days: MetricDays };
  includeDemo: boolean;
  truncated: boolean;
  tickets: {
    created: number;
    firstResponse: DurationStat;
    resolution: DurationStat;
    notAnswered: number;
    notAnsweredLate: number;
    closedUnresolved: number;
  };
  backlog: { open: number; late: number; byStatus: { status: TicketStatus; n: number }[]; unassigned: number; escalated: number };
  byAgent: { id: string; name: string; answered: number; firstResponse: DurationStat; resolved: number; resolution: DurationStat }[];
  byCategory: GroupRow<TicketCategory>[];
  byPriority: GroupRow<TicketPriority>[];
  byChannel: GroupRow<TicketChannel>[];
  satisfaction: { collected: false; resolved: number } | { collected: true; answered: number; resolved: number; average: number; distribution: [number, number, number, number, number] };
  repairs: { created: number; firstAction: DurationStat; completion: DurationStat; lateNow: number };
};

type Row = {
  id: string;
  channel: TicketChannel;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo: string | null;
  createdAt: number;
  firstDue: number | null;
  resolveDue: number | null;
  resolvedAt: number | null;
  closedAt: number | null;
  csat: number | null;
  firstReply: number | null;
  firstReplyBy: string | null;
};

function stat(pairs: readonly { minutes: number; due: number | null; at: number }[]): DurationStat {
  const values = pairs.map((pair) => pair.minutes);
  const withDue = pairs.filter((pair) => pair.due !== null);
  return { count: values.length, median: median(values), p90: percentile(values, 90), withinSla: share(withDue.filter((pair) => pair.at <= (pair.due as number)).length, withDue.length), withDue: withDue.length };
}

const minutesBetween = (from: number, to: number) => Math.max(0, Math.round((to - from) / MINUTE));

function responses(rows: readonly Row[]) {
  return rows.filter((row) => row.firstReply !== null).map((row) => ({ minutes: minutesBetween(row.createdAt, row.firstReply as number), due: row.firstDue, at: row.firstReply as number }));
}
function resolutions(rows: readonly Row[]) {
  return rows.filter((row) => row.resolvedAt !== null).map((row) => ({ minutes: minutesBetween(row.createdAt, row.resolvedAt as number), due: row.resolveDue, at: row.resolvedAt as number }));
}

function grouped<K extends string>(rows: readonly Row[], keyOf: (row: Row) => K): GroupRow<K>[] {
  const groups = new Map<K, Row[]>();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return [...groups.entries()].map(([key, list]) => ({ key, created: list.length, firstResponse: stat(responses(list)), resolution: stat(resolutions(list)) })).sort((a, b) => b.created - a.created);
}

export function parseMetricDays(value: string | null): MetricDays {
  const n = Number.parseInt(value ?? "", 10);
  return (METRIC_DAYS as readonly number[]).includes(n) ? (n as MetricDays) : 30;
}

export async function supportMetrics(db: Db, actor: Actor, input: { days: MetricDays; demo: boolean }, now: number): Promise<SupportMetrics> {
  assertCan(actor, "support.metrics.read");
  const from = now - input.days * DAY;
  const demo = input.demo ? 1 : 0;
  const [rows, backlog, repairs, repairLate] = await Promise.all([
    db.all<Row>(sql`
      SELECT t.id AS "id", t.channel AS "channel", t.category AS "category", t.priority AS "priority", t.status AS "status", t.assigned_to AS "assignedTo",
        t.created_at AS "createdAt", t.first_response_due_at AS "firstDue", t.resolution_due_at AS "resolveDue", t.resolved_at AS "resolvedAt",
        t.closed_at AS "closedAt", t.csat_rating AS "csat",
        (SELECT min(m.created_at) FROM ticket_messages AS m WHERE m.ticket_id = t.id AND m.author_kind = 'employee' AND m.is_internal = 0) AS "firstReply",
        (SELECT m.author_id FROM ticket_messages AS m WHERE m.ticket_id = t.id AND m.author_kind = 'employee' AND m.is_internal = 0 ORDER BY m.created_at, m.id LIMIT 1) AS "firstReplyBy"
      FROM support_tickets AS t
      WHERE t.created_at >= ${from} AND t.created_at < ${now} AND (t.is_demo = 0 OR ${demo} = 1)
      ORDER BY t.created_at DESC
      LIMIT ${LIMIT + 1}`),
    db.all<{ status: TicketStatus; n: number; late: number; unassigned: number; escalated: number }>(sql`
      SELECT t.status AS "status", count(*) AS "n",
        sum(CASE WHEN (CASE WHEN t.first_responded_at IS NULL THEN t.first_response_due_at ELSE t.resolution_due_at END) < ${now} THEN 1 ELSE 0 END) AS "late",
        sum(CASE WHEN t.assigned_to IS NULL THEN 1 ELSE 0 END) AS "unassigned",
        sum(CASE WHEN t.escalated_to IS NOT NULL THEN 1 ELSE 0 END) AS "escalated"
      FROM support_tickets AS t
      WHERE t.status IN ('open', 'pending_customer', 'pending_staff', 'on_hold') AND (t.is_demo = 0 OR ${demo} = 1)
      GROUP BY t.status`),
    db.all<{ createdAt: number; slaDueAt: number | null; firstAction: number | null; doneAt: number | null }>(sql`
      SELECT r.created_at AS "createdAt", r.sla_due_at AS "slaDueAt",
        (SELECT min(e.at) FROM repair_events AS e WHERE e.ticket_id = r.id AND e.actor_kind = 'employee') AS "firstAction",
        (CASE WHEN r.status IN ('delivered', 'unrepairable', 'cancelled') THEN COALESCE(r.delivered_at, (SELECT max(e.at) FROM repair_events AS e WHERE e.ticket_id = r.id AND e.kind = 'status')) END) AS "doneAt"
      FROM repair_tickets AS r
      WHERE r.created_at >= ${from} AND r.created_at < ${now} AND (r.is_demo = 0 OR ${demo} = 1)
      LIMIT ${LIMIT}`),
    db.get<{ n: number }>(sql`
      SELECT count(*) AS "n" FROM repair_tickets AS r
      WHERE r.status IN ('submitted', 'received', 'diagnosing', 'awaiting_approval', 'awaiting_parts', 'repairing') AND r.sla_due_at < ${now} AND (r.is_demo = 0 OR ${demo} = 1)`),
  ]);
  const truncated = rows.length > LIMIT;
  const list = (truncated ? rows.slice(0, LIMIT) : rows).map((row) => ({ ...row, createdAt: Number(row.createdAt), firstReply: row.firstReply === null ? null : Number(row.firstReply), resolvedAt: row.resolvedAt === null ? null : Number(row.resolvedAt) }));

  const open = new Set<TicketStatus>(["open", "pending_customer", "pending_staff", "on_hold"]);
  const notAnswered = list.filter((row) => row.firstReply === null && open.has(row.status));
  const agentIds = new Set<string>();
  for (const row of list) {
    if (row.firstReplyBy) agentIds.add(row.firstReplyBy);
    if (row.assignedTo) agentIds.add(row.assignedTo);
  }
  const names = await employeeNames(db, [...agentIds]);
  const byAgent = [...agentIds]
    .map((id) => {
      const answered = list.filter((row) => row.firstReplyBy === id);
      const resolved = list.filter((row) => row.assignedTo === id && row.resolvedAt !== null);
      return { id, name: names.get(id) ?? id, answered: answered.length, firstResponse: stat(responses(answered)), resolved: resolved.length, resolution: stat(resolutions(resolved)) };
    })
    .filter((agent) => agent.answered > 0 || agent.resolved > 0)
    .sort((a, b) => b.answered - a.answered || b.resolved - a.resolved || a.name.localeCompare(b.name));

  const rated = list.filter((row) => row.csat !== null && Number(row.csat) >= 1 && Number(row.csat) <= 5);
  const resolvedCount = list.filter((row) => row.resolvedAt !== null).length;
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const row of rated) distribution[Number(row.csat) - 1]++;

  const repairPairs = repairs.map((row) => ({ ...row, createdAt: Number(row.createdAt) }));
  return {
    period: { from, to: now, days: input.days },
    includeDemo: input.demo,
    truncated,
    tickets: {
      created: list.length,
      firstResponse: stat(responses(list)),
      resolution: stat(resolutions(list)),
      notAnswered: notAnswered.length,
      notAnsweredLate: notAnswered.filter((row) => row.firstDue !== null && Number(row.firstDue) < now).length,
      closedUnresolved: list.filter((row) => row.status === "closed" && row.resolvedAt === null).length,
    },
    backlog: {
      open: backlog.reduce((sum, row) => sum + Number(row.n), 0),
      late: backlog.reduce((sum, row) => sum + Number(row.late ?? 0), 0),
      unassigned: backlog.reduce((sum, row) => sum + Number(row.unassigned ?? 0), 0),
      escalated: backlog.reduce((sum, row) => sum + Number(row.escalated ?? 0), 0),
      byStatus: backlog.map((row) => ({ status: row.status, n: Number(row.n) })),
    },
    byAgent,
    byCategory: grouped(list, (row) => row.category),
    byPriority: grouped(list, (row) => row.priority),
    byChannel: grouped(list, (row) => row.channel),
    satisfaction: rated.length === 0 ? { collected: false, resolved: resolvedCount } : { collected: true, answered: rated.length, resolved: resolvedCount, average: Math.round((rated.reduce((sum, row) => sum + Number(row.csat), 0) / rated.length) * 10) / 10, distribution },
    repairs: {
      created: repairPairs.length,
      firstAction: stat(repairPairs.filter((row) => row.firstAction !== null).map((row) => ({ minutes: minutesBetween(row.createdAt, Number(row.firstAction)), due: null, at: Number(row.firstAction) }))),
      completion: stat(repairPairs.filter((row) => row.doneAt !== null).map((row) => ({ minutes: minutesBetween(row.createdAt, Number(row.doneAt)), due: row.slaDueAt === null ? null : Number(row.slaDueAt), at: Number(row.doneAt) }))),
      lateNow: Number(repairLate?.n ?? 0),
    },
  };
}
