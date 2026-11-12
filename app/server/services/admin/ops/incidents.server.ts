/**
 * Admin 23.05 — the incident centre (ops.incident.read to see, ops.incident.manage to act).
 *
 * An incident (`incidents`, ref INC-0001… from the gap-free counter "incident") has a severity (sev1 most severe), a
 * status (open → investigating → mitigated → resolved), when it started and when it was recorded, a responsible OWNER
 * and a TARGET date for its resolution — the owner's task about it (`staff_tasks`, ref "incident", due at the end of the
 * target day, Baghdad), so it also shows in that person's task list — the date it was RESOLVED and its post-mortem
 * (root cause and what changes, `root_cause`; required to resolve it). Its timeline is the people's updates
 * (`incident_updates`) and the audited changes (owner and target, severity, details, links).
 *
 * Links keep the original reference, never a name (blueprint entity rule): a consistency finding or a job run is linked
 * by its id in an audit event (`ops.incident.link` / `.unlink`, with a snapshot so the evidence outlives the 90-day job
 * history); an error report through its own column (`error_reports.incident_id`) and the same audit events. The schema
 * has no link table for findings and runs (requested from the schema owner). Linking needs the permission to read that
 * kind of record (`LINK_READ`), so a link by id never describes what the employee may not open; the retention purge
 * keeps an error report an incident is about.
 *
 * Every change is one guarded batch with its audit event (`ops.incident.*`): status moves check the status the form
 * saw (`incident_changed` otherwise), edits check the version the form saw (`updated_at`).
 */
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditRow } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { auditEvents, consistencyFindings, errorReports, incidentUpdates, incidents, jobRuns, staffTasks, type Incident } from "~/server/db/schema";
import { batchSql, expectChanged, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, conflict, invalid, notFound } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { employeeHolds, employeeNames, entityKey, entityViews, findingScope, opsAccess, staffHolding } from "./shared.server";
import {
  DAY_MS,
  INCIDENTS_PAGE_SIZE,
  INCIDENT_MOVES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TARGET_DAYS,
  INCIDENT_VIEWS,
  LINK_KINDS,
  MINUTE_MS,
  addDays,
  baghdadDateTime,
  baghdadDay,
  baghdadDayEnd,
  dayOf,
  likePatterns,
  type IncidentFilters,
  type IncidentRow,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentView,
  type LinkKind,
  type LinkView,
  type Person,
  type TimelineItem,
} from "./types";

export const INCIDENT_TASK_REF = "incident";
export const INCIDENT_SEQUENCE = "incident";
export const INCIDENT_ACTIONS = {
  create: "ops.incident.create",
  update: "ops.incident.update",
  resolve: "ops.incident.resolve",
  reopen: "ops.incident.reopen",
  owner: "ops.incident.owner",
  severity: "ops.incident.severity",
  edit: "ops.incident.edit",
  link: "ops.incident.link",
  unlink: "ops.incident.unlink",
} as const;

/** Audited changes the timeline shows from the audit trail (status moves and notes come from incident_updates). */
const TIMELINE_ACTIONS: readonly string[] = [INCIDENT_ACTIONS.owner, INCIDENT_ACTIONS.severity, INCIDENT_ACTIONS.edit, INCIDENT_ACTIONS.link, INCIDENT_ACTIONS.unlink];

const OPEN_TASK = ["open", "in_progress"] as const;
const priorityOf = (severity: IncidentSeverity): "urgent" | "high" | "normal" | "low" => (severity === "sev1" ? "urgent" : severity === "sev2" ? "high" : severity === "sev3" ? "normal" : "low");
/** A start "now" may be a few minutes ahead of the server's clock on a phone. */
const CLOCK_SKEW_MS = 5 * MINUTE_MS;

// ───────────────────────────────────────────────────────────────── reading

type TaskFact = { refId: string; assignedTo: string | null; dueAt: number | null; status: string };

/** The owner's latest task per incident (open first) — the target date. */
async function tasksOf(db: Db, ids: readonly string[]): Promise<Map<string, TaskFact>> {
  const out = new Map<string, TaskFact>();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db
      .select({ refId: staffTasks.refId, assignedTo: staffTasks.assignedTo, dueAt: staffTasks.dueAt, status: staffTasks.status })
      .from(staffTasks)
      .where(and(eq(staffTasks.refType, INCIDENT_TASK_REF), inArray(staffTasks.refId, ids.slice(i, i + 90))))
      .orderBy(sql`CASE WHEN ${staffTasks.status} IN ('open', 'in_progress') THEN 0 ELSE 1 END`, desc(staffTasks.createdAt), desc(staffTasks.id));
    for (const row of rows) if (row.refId && !out.has(row.refId)) out.set(row.refId, { refId: row.refId, assignedTo: row.assignedTo, dueAt: row.dueAt, status: row.status });
  }
  return out;
}

async function rowsOf(db: Db, list: readonly Incident[], now: number): Promise<IncidentRow[]> {
  const tasks = await tasksOf(db, list.map((row) => row.id));
  const names = await employeeNames(db, list.map((row) => row.ownerId));
  return list.map((row) => {
    const task = tasks.get(row.id);
    const targetAt = task?.dueAt ?? null;
    return {
      id: row.id,
      ref: row.ref,
      title: row.title,
      severity: row.severity as IncidentSeverity,
      status: row.status as IncidentStatus,
      owner: row.ownerId ? { id: row.ownerId, name: names.get(row.ownerId) ?? row.ownerId } : null,
      targetAt,
      overdue: row.status !== "resolved" && targetAt !== null && targetAt < now,
      startedAt: row.startedAt,
      detectedAt: row.detectedAt,
      mitigatedAt: row.mitigatedAt,
      resolvedAt: row.resolvedAt,
      updatedAt: row.updatedAt,
    };
  });
}

const openTaskDue = sql`(SELECT t.due_at FROM staff_tasks AS t WHERE t.ref_type = ${INCIDENT_TASK_REF} AND t.ref_id = ${incidents.id} AND t.status IN ('open', 'in_progress') ORDER BY t.created_at DESC LIMIT 1)`;

function viewCondition(view: IncidentView, me: string, now: number): SQL | undefined {
  switch (view) {
    case "active":
      return ne(incidents.status, "resolved");
    case "mine":
      return and(ne(incidents.status, "resolved"), eq(incidents.ownerId, me));
    case "overdue":
      return and(ne(incidents.status, "resolved"), sql`${openTaskDue} < ${now}`);
    case "resolved":
      return eq(incidents.status, "resolved");
    default:
      return undefined;
  }
}

export type IncidentsPage = { rows: IncidentRow[]; total: number; page: number; pageCount: number; counts: Record<IncidentView, number> };

export async function listIncidents(db: Db, actor: Actor, filters: IncidentFilters, now: number): Promise<IncidentsPage> {
  assertCan(actor, "ops.incident.read");
  const me = actor.kind === "employee" ? actor.id : "-";
  // Every filter but the view: they decide the rows AND the view chips' counts (a chip's link keeps these filters).
  const base: SQL[] = [];
  if (filters.severity) base.push(eq(incidents.severity, filters.severity));
  if (filters.q) {
    const text = likePatterns(filters.q).flatMap((pattern) => [sql`${incidents.ref} LIKE ${pattern} ESCAPE '\\'`, sql`${incidents.title} LIKE ${pattern} ESCAPE '\\'`]);
    base.push(or(...text) as SQL);
  }
  const view = viewCondition(filters.view, me, now);
  const condition = and(...(view ? [view] : []), ...base);
  const baseCondition = base.length ? and(...base) : undefined;
  const order =
    filters.sort === "started"
      ? [desc(incidents.startedAt), desc(incidents.id)]
      : filters.sort === "target"
        ? [sql`${openTaskDue} IS NULL`, sql`${openTaskDue}`, desc(incidents.startedAt)]
        : [sql`CASE ${incidents.status} WHEN 'resolved' THEN 1 ELSE 0 END`, sql`CASE ${incidents.severity} WHEN 'sev1' THEN 0 WHEN 'sev2' THEN 1 WHEN 'sev3' THEN 2 ELSE 3 END`, desc(incidents.startedAt), desc(incidents.id)];
  const [totalRow, list, countRow] = await Promise.all([
    db.select({ n: count() }).from(incidents).where(condition).get(),
    db
      .select()
      .from(incidents)
      .where(condition)
      .orderBy(...order)
      .limit(INCIDENTS_PAGE_SIZE)
      .offset((filters.page - 1) * INCIDENTS_PAGE_SIZE),
    db
      .select({
        active: sql<number>`coalesce(sum(CASE WHEN ${incidents.status} <> 'resolved' THEN 1 ELSE 0 END), 0)`,
        mine: sql<number>`coalesce(sum(CASE WHEN ${incidents.status} <> 'resolved' AND ${incidents.ownerId} = ${me} THEN 1 ELSE 0 END), 0)`,
        overdue: sql<number>`coalesce(sum(CASE WHEN ${incidents.status} <> 'resolved' AND ${openTaskDue} < ${now} THEN 1 ELSE 0 END), 0)`,
        resolved: sql<number>`coalesce(sum(CASE WHEN ${incidents.status} = 'resolved' THEN 1 ELSE 0 END), 0)`,
        total: count(),
      })
      .from(incidents)
      .where(baseCondition)
      .get(),
  ]);
  const c = countRow;
  const counts = Object.fromEntries(INCIDENT_VIEWS.map((v) => [v, Number(v === "all" ? (c?.total ?? 0) : (c?.[v] ?? 0))])) as Record<IncidentView, number>;
  const total = Number(totalRow?.n ?? 0);
  return { rows: await rowsOf(db, list, now), total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / INCIDENTS_PAGE_SIZE)), counts };
}

type LinkFact = { kind: LinkKind; id: string; label: string; at: number; by: string | null };

/** The links an incident holds now: its link events minus its unlink events, in the order they were made. */
function foldLinks(events: readonly (typeof auditEvents.$inferSelect)[]): Map<string, LinkFact> {
  const out = new Map<string, LinkFact>();
  for (const event of events) {
    if (event.action !== INCIDENT_ACTIONS.link && event.action !== INCIDENT_ACTIONS.unlink) continue;
    const after = (event.after ?? {}) as { kind?: string; id?: string; label?: string };
    if (!after.kind || !(LINK_KINDS as readonly string[]).includes(after.kind) || !after.id) continue;
    const key = `${after.kind}:${after.id}`;
    if (event.action === INCIDENT_ACTIONS.unlink) out.delete(key);
    else if (!out.has(key)) out.set(key, { kind: after.kind as LinkKind, id: after.id, label: after.label ?? after.id, at: event.at, by: event.actorLabel });
  }
  return out;
}

/**
 * The incidents a finding or a job run is linked to now (its latest link event is newer than its latest unlink event).
 * For the finding's and the run's own pages.
 */
export async function incidentsLinkedTo(db: Db, kind: LinkKind, id: string): Promise<{ id: string; ref: string; title: string; status: string }[]> {
  const event = (action: string) => sql`
    SELECT max(a.seq) FROM audit_events AS a WHERE a.action = ${action} AND a.entity_type = 'incident' AND a.entity_id = i.id
      AND json_extract(a.after, '$.kind') = ${kind} AND json_extract(a.after, '$.id') = ${id}`;
  return db.all<{ id: string; ref: string; title: string; status: string }>(sql`
    SELECT i.id AS id, i.ref AS ref, i.title AS title, i.status AS status FROM incidents AS i
    WHERE coalesce((${event(INCIDENT_ACTIONS.link)}), 0) > coalesce((${event(INCIDENT_ACTIONS.unlink)}), 0)
    ORDER BY i.started_at DESC`);
}

async function linkViews(db: Db, actor: Actor, incidentId: string, facts: Map<string, LinkFact>): Promise<LinkView[]> {
  const access = opsAccess(actor);
  // errors: the column is the truth for a report that exists (an error report holds one incident; the audit gives who
  // and when); a linked report that no longer exists keeps its snapshot, like a purged run (the evidence stays named)
  const linkedErrorIds = [...facts.values()].filter((link) => link.kind === "error").map((link) => link.id);
  const errorRows = await db
    .select({ id: errorReports.id, status: errorReports.status, message: errorReports.message, source: errorReports.source, incidentId: errorReports.incidentId })
    .from(errorReports)
    .where(linkedErrorIds.length ? or(eq(errorReports.incidentId, incidentId), inArray(errorReports.id, linkedErrorIds.slice(0, 90))) : eq(errorReports.incidentId, incidentId));
  const mine = errorRows.filter((row) => row.incidentId === incidentId);
  for (const row of mine) if (!facts.has(`error:${row.id}`)) facts.set(`error:${row.id}`, { kind: "error", id: row.id, label: `${row.source} · ${row.message.slice(0, 120)}`, at: 0, by: null });
  for (const row of errorRows) if (row.incidentId !== incidentId) facts.delete(`error:${row.id}`);
  const list = [...facts.values()];
  const findingIds = list.filter((link) => link.kind === "finding").map((link) => link.id);
  const runIds = list.filter((link) => link.kind === "run").map((link) => link.id);
  const scope = findingScope(actor);
  const [findings, runs] = await Promise.all([
    findingIds.length
      ? db
          .select({ id: consistencyFindings.id, status: consistencyFindings.status, visible: scope ? sql<number>`CASE WHEN ${scope} THEN 1 ELSE 0 END` : sql<number>`1` })
          .from(consistencyFindings)
          .where(inArray(consistencyFindings.id, findingIds))
      : Promise.resolve([]),
    runIds.length ? db.select({ id: jobRuns.id, status: jobRuns.status }).from(jobRuns).where(inArray(jobRuns.id, runIds)) : Promise.resolve([]),
  ]);
  const findingState = new Map(findings.map((row) => [row.id, row.status]));
  const findingVisible = new Set(findings.filter((row) => Number(row.visible) === 1).map((row) => row.id));
  const runState = new Map(runs.map((row) => [row.id, row.status]));
  const errorState = new Map(mine.map((row) => [row.id, row.status]));
  return list.map((link) => {
    const state = link.kind === "finding" ? (findingState.get(link.id) ?? null) : link.kind === "run" ? (runState.get(link.id) ?? null) : (errorState.get(link.id) ?? null);
    const href =
      state === null
        ? null
        : link.kind === "finding"
          ? access.consistency && findingVisible.has(link.id)
            ? `/admin/ops/consistency/${encodeURIComponent(link.id)}`
            : null
          : link.kind === "run"
            ? access.jobs
              ? `/admin/ops/jobs/runs/${encodeURIComponent(link.id)}`
              : null
            : access.errors
              ? `/admin/ops/errors/${encodeURIComponent(link.id)}`
              : null;
    return { kind: link.kind, id: link.id, label: link.label, href, state, at: link.at, by: link.by };
  });
}

export type IncidentDetail = {
  incident: IncidentRow & { summary: string | null; impact: string | null; rootCause: string | null; createdBy: string | null; createdAt: number };
  timeline: TimelineItem[];
  links: LinkView[];
  /** Who may own it (holders of ops.incident.read); empty without ops.incident.manage. */
  owners: Person[];
  /** The next status moves an update may make (resolving has its own form). */
  moves: IncidentStatus[];
};

export async function getIncident(db: Db, actor: Actor, ref: string, now: number): Promise<IncidentDetail> {
  assertCan(actor, "ops.incident.read");
  const row = await db.select().from(incidents).where(eq(incidents.ref, ref.toUpperCase())).get();
  if (!row) throw notFound("incident");
  const access = opsAccess(actor);
  const [[view], updates, events, owners] = await Promise.all([
    rowsOf(db, [row], now),
    db.select().from(incidentUpdates).where(eq(incidentUpdates.incidentId, row.id)).orderBy(asc(incidentUpdates.createdAt), asc(incidentUpdates.id)),
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "incident"), eq(auditEvents.entityId, row.id)))
      .orderBy(asc(auditEvents.seq))
      .limit(500),
    access.manageIncidents ? staffHolding(db, "ops.incident.read") : Promise.resolve([] as Person[]),
  ]);
  const names = await employeeNames(db, [row.createdBy, ...updates.map((update) => update.createdBy)]);
  const timeline: TimelineItem[] = [
    ...updates.map((update): TimelineItem => ({ kind: "update", id: update.id, at: update.createdAt, by: update.createdBy ? (names.get(update.createdBy) ?? update.createdBy) : null, status: (update.status as IncidentStatus | null) ?? null, note: update.note })),
    ...events
      .filter((event) => TIMELINE_ACTIONS.includes(event.action))
      .map((event): TimelineItem => ({ kind: "event", id: event.id, at: event.at, by: event.actorLabel, action: event.action, reason: event.reason, before: (event.before as Record<string, unknown> | null) ?? null, after: (event.after as Record<string, unknown> | null) ?? null })),
  ].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "update" ? -1 : 1) || a.id.localeCompare(b.id));
  const links = await linkViews(db, actor, row.id, foldLinks(events));
  return {
    incident: { ...view, summary: row.summary, impact: row.impact, rootCause: row.rootCause, createdBy: row.createdBy ? (names.get(row.createdBy) ?? row.createdBy) : null, createdAt: row.createdAt },
    timeline,
    links,
    owners,
    moves: [...INCIDENT_MOVES[row.status as IncidentStatus]],
  };
}

/** What the "new incident" form needs: who may own it, the suggested target day per severity, the records to link. */
export async function incidentFormOptions(db: Db, actor: Actor, now: number, prefill: { kind: LinkKind; id: string }[]): Promise<{ owners: Person[]; targets: Record<IncidentSeverity, string>; links: { kind: LinkKind; id: string; label: string }[]; today: string }> {
  assertCan(actor, "ops.incident.manage");
  const today = baghdadDay(now);
  // only records this employee may read are described (a link by id never reveals what the employee cannot open)
  const readable = prefill.filter((link) => can(actor, LINK_READ[link.kind])).slice(0, 20);
  const [owners, links] = await Promise.all([staffHolding(db, "ops.incident.read"), resolveLinks(db, actor, readable).catch(() => [])]);
  const targets = Object.fromEntries(INCIDENT_SEVERITIES.map((severity) => [severity, addDays(today, INCIDENT_TARGET_DAYS[severity])])) as Record<IncidentSeverity, string>;
  return { owners, targets, links: links.map(({ kind, id, label }) => ({ kind, id, label })), today };
}

/** What linking a record needs besides ops.incident.manage: the permission to read that kind of record. */
export const LINK_READ: Record<LinkKind, Permission> = { finding: "ops.consistency.read", run: "ops.job.read", error: "ops.error.read" };

/** The kinds of record this employee may link (the incident page offers only these). */
export const linkableKinds = (actor: Actor): LinkKind[] => LINK_KINDS.filter((kind) => can(actor, LINK_READ[kind]));

/**
 * Linkable records by kind and id → their snapshot label (and the error's current incident). The employee must be
 * allowed to read each kind (`forbidden`); unknown ids — and findings outside the employee's branch — are refused.
 */
async function resolveLinks(db: Db, actor: Actor, wanted: readonly { kind: LinkKind; id: string }[]): Promise<{ kind: LinkKind; id: string; label: string; incidentId?: string | null }[]> {
  const unique = [...new Map(wanted.map((link) => [`${link.kind}:${link.id}`, link])).values()];
  for (const kind of new Set(unique.map((link) => link.kind))) assertCan(actor, LINK_READ[kind]);
  const findingIds = unique.filter((link) => link.kind === "finding").map((link) => link.id);
  const runIds = unique.filter((link) => link.kind === "run").map((link) => link.id);
  const errorIds = unique.filter((link) => link.kind === "error").map((link) => link.id);
  const [findings, runs, errors] = await Promise.all([
    findingIds.length
      ? db
          .select({ id: consistencyFindings.id, checkKey: consistencyFindings.checkKey, entityType: consistencyFindings.entityType, entityId: consistencyFindings.entityId })
          .from(consistencyFindings)
          .where(and(inArray(consistencyFindings.id, findingIds), findingScope(actor)))
      : Promise.resolve([]),
    runIds.length ? db.select({ id: jobRuns.id, job: jobRuns.job, status: jobRuns.status, startedAt: jobRuns.startedAt }).from(jobRuns).where(inArray(jobRuns.id, runIds)) : Promise.resolve([]),
    errorIds.length ? db.select({ id: errorReports.id, source: errorReports.source, message: errorReports.message, incidentId: errorReports.incidentId }).from(errorReports).where(inArray(errorReports.id, errorIds)) : Promise.resolve([]),
  ]);
  const entities = await entityViews(db, actor, findings.map((row) => ({ type: row.entityType, id: row.entityId })));
  return unique.map((link) => {
    if (link.kind === "finding") {
      const row = findings.find((entry) => entry.id === link.id);
      if (!row) throw invalid({ links: "link_invalid" }, link.id);
      return { ...link, label: `${row.checkKey} · ${entities.get(entityKey(row.entityType, row.entityId))?.label ?? row.entityId ?? ""}` };
    }
    if (link.kind === "run") {
      const row = runs.find((entry) => entry.id === link.id);
      if (!row) throw invalid({ links: "link_invalid" }, link.id);
      return { ...link, label: `${row.job} · ${new Date(row.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC · ${row.status}` };
    }
    const row = errors.find((entry) => entry.id === link.id);
    if (!row) throw invalid({ links: "link_invalid" }, link.id);
    return { ...link, label: `${row.source} · ${row.message.slice(0, 120)}`, incidentId: row.incidentId };
  });
}

// ───────────────────────────────────────────────────────────────── creating

/** A required text: empty → "required", shorter than `min` → `error`, longer than `max` → "too_long". */
const Text = (min: number, max: number, error = "too_short") => z.string({ error: "required" }).trim().min(1, "required").min(min, error).max(max, "too_long");

export const CreateIncidentInput = z.object({
  title: Text(3, 160),
  severity: z.enum(INCIDENT_SEVERITIES, { error: "required" }),
  summary: Text(10, 4000),
  impact: z.string().trim().max(2000, "too_long").optional(),
  ownerId: z.string({ error: "owner_invalid" }).trim().min(1, "owner_invalid").max(64, "owner_invalid"),
  startedAt: z.string().trim().max(30).optional(),
  targetDay: z.string({ error: "target_invalid" }).trim().min(1, "target_invalid").max(20, "target_invalid"),
  links: z
    .array(z.object({ kind: z.enum(LINK_KINDS), id: z.string().trim().min(1).max(64) }))
    .max(20, "too_many")
    .optional(),
  idempotencyKey: z.string({ error: "invalid" }).trim().min(16, "invalid").max(128, "invalid"),
});

function targetOf(value: string, now: number): { day: string; at: number } {
  const day = dayOf(value);
  const today = baghdadDay(now);
  if (!day || day < today || day > addDays(today, 365)) throw invalid({ targetDay: "target_invalid" });
  return { day, at: baghdadDayEnd(day) };
}

function startedOf(value: string | undefined, now: number): number {
  if (!value) return now;
  const at = baghdadDateTime(value);
  if (at === null || at > now + CLOCK_SKEW_MS || at < now - 366 * DAY_MS) throw invalid({ startedAt: "started_invalid" });
  return at;
}

async function assertOwner(db: Db, ownerId: string): Promise<void> {
  if (!(await employeeHolds(db, ownerId, "ops.incident.read"))) throw invalid({ ownerId: "owner_invalid" });
}

/** The owner's task about the incident, its title from the incident's own ref and title (read inside the batch). */
function ownerTaskStatement(db: Db, input: { incidentId: string; ownerId: string; dueAt: number; severity: IncidentSeverity; createdBy: string | null; now: number }): BatchStatement {
  return batchSql(
    db,
    sql`INSERT INTO staff_tasks (id, title, description, assigned_to, priority, status, due_at, ref_type, ref_id, created_by, created_at)
      SELECT ${newId("tsk")}, substr(i.ref || ' — ' || i.title, 1, 200), NULL, ${input.ownerId}, ${priorityOf(input.severity)}, 'open', ${input.dueAt}, ${INCIDENT_TASK_REF}, i.id, ${input.createdBy}, ${input.now}
      FROM incidents AS i WHERE i.id = ${input.incidentId}`,
  );
}

const cancelOwnerTasks = (db: Db, incidentId: string, now: number, status: "cancelled" | "done" = "cancelled") =>
  db
    .update(staffTasks)
    .set({ status, completedAt: now })
    .where(and(eq(staffTasks.refType, INCIDENT_TASK_REF), eq(staffTasks.refId, incidentId), inArray(staffTasks.status, [...OPEN_TASK])));

const byOf = (actor: Actor) => (actor.kind === "employee" ? actor.id : actor.kind === "system" ? `system:${actor.job}` : null);

/**
 * Opens an incident (ops.incident.manage) with its owner (who may read incidents) and target day, optionally linked to
 * findings, job runs and errors. A resubmitted form opens it once (the id comes from the form's key).
 */
export async function createIncident(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ incidentId: string; ref: string; replayed: boolean }> {
  assertCan(actor, "ops.incident.manage");
  const input = CreateIncidentInput.parse(raw);
  const by = byOf(actor);
  const incidentId = `inc_${(await sha256Hex(`ops.incident|${by ?? ""}|${input.idempotencyKey}`)).slice(0, 26)}`;
  /** The same form sent again opens nothing new; the same key with other details is refused, never answered with the first. */
  const replay = async () => {
    const row = await db.select({ ref: incidents.ref, title: incidents.title, severity: incidents.severity, ownerId: incidents.ownerId }).from(incidents).where(eq(incidents.id, incidentId)).get();
    if (!row) return null;
    if (row.title !== input.title || row.severity !== input.severity || row.ownerId !== input.ownerId) throw new AppError("idempotency_mismatch", 409, { detail: row.ref });
    return { incidentId, ref: row.ref, replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const startedAt = startedOf(input.startedAt, now);
  const target = targetOf(input.targetDay, now);
  await assertOwner(db, input.ownerId);
  const links = await resolveLinks(db, actor, input.links ?? []);
  const takenError = links.find((link) => link.kind === "error" && link.incidentId);
  if (takenError) throw new AppError("link_exists", 409, { fields: { links: "link_exists" }, detail: takenError.id });

  const statements: BatchStatement[] = [
    batchSql(db, sql`INSERT INTO sequences (name, value) VALUES (${INCIDENT_SEQUENCE}, 0) ON CONFLICT(name) DO NOTHING`),
    batchSql(db, sql`UPDATE sequences SET value = value + 1 WHERE name = ${INCIDENT_SEQUENCE}`),
    batchSql(
      db,
      sql`INSERT INTO incidents (id, ref, title, severity, status, summary, impact, root_cause, owner_id, started_at, detected_at, mitigated_at, resolved_at, created_by, created_at, updated_at)
        SELECT ${incidentId}, 'INC-' || printf('%04d', s.value), ${input.title}, ${input.severity}, 'open', ${input.summary}, ${input.impact || null}, NULL, ${input.ownerId}, ${startedAt}, ${now}, NULL, NULL, ${by}, ${now}, ${now}
        FROM sequences AS s WHERE s.name = ${INCIDENT_SEQUENCE}`,
    ),
    expectChanged(db, 1, { code: "INCIDENT_CHANGED", detail: incidentId }),
    db.insert(incidentUpdates).values({ id: newId("inu"), incidentId, status: "open", note: input.summary, createdBy: by, createdAt: now }),
    ownerTaskStatement(db, { incidentId, ownerId: input.ownerId, dueAt: target.at, severity: input.severity, createdBy: by, now }),
    expectChanged(db, 1, { code: "INCIDENT_CHANGED", detail: incidentId }),
  ];
  for (const link of links.filter((entry) => entry.kind === "error")) {
    statements.push(db.update(errorReports).set({ incidentId }).where(and(eq(errorReports.id, link.id), isNull(errorReports.incidentId))), expectChanged(db, 1, { code: "LINK_EXISTS", detail: link.id }));
  }
  statements.push(
    db.insert(auditEvents).values(
      auditRow({
        actor,
        action: INCIDENT_ACTIONS.create,
        entityType: "incident",
        entityId: incidentId,
        summary: `${input.severity} ${input.title}`,
        after: { title: input.title, severity: input.severity, ownerId: input.ownerId, startedAt, targetDay: target.day, impact: input.impact || null, links: links.map(({ kind, id }) => ({ kind, id })) },
        at: now,
      }),
    ),
    // every link is its own event, whenever it was made (the finding's and the run's pages look them up)
    ...links.map((link) =>
      db.insert(auditEvents).values(auditRow({ actor, action: INCIDENT_ACTIONS.link, entityType: "incident", entityId: incidentId, summary: `+ ${link.kind} ${link.id}`, after: { kind: link.kind, id: link.id, label: link.label }, at: now })),
    ),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay();
      if (again) return again;
    }
    throw error;
  }
  const row = await db.select({ ref: incidents.ref }).from(incidents).where(eq(incidents.id, incidentId)).get();
  return { incidentId, ref: row?.ref ?? "", replayed: false };
}

// ───────────────────────────────────────────────────────────────── changing

/**
 * The incident a page's form acts on (ops.incident.manage): the one the page's own reference names. A form that names
 * another incident is refused (`invalid`), so a POST to one incident's page never changes a different one.
 */
export async function incidentIdForPage(db: Db, actor: Actor, ref: string, formIncidentId: string | null | undefined): Promise<string> {
  assertCan(actor, "ops.incident.manage");
  const row = await db.select({ id: incidents.id }).from(incidents).where(eq(incidents.ref, ref.toUpperCase())).get();
  if (!row) throw notFound("incident");
  if (formIncidentId && formIncidentId !== row.id) throw invalid({ incidentId: "invalid" });
  return row.id;
}

async function readIncident(db: Db, incidentId: string): Promise<Incident> {
  const row = await db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!row) throw notFound("incident");
  return row;
}

const IncidentId = z.string({ error: "required" }).trim().min(1, "required").max(64, "invalid");

export const IncidentUpdateInput = z.object({
  incidentId: IncidentId,
  note: Text(3, 4000),
  status: z.enum(INCIDENT_STATUSES).optional(),
  expectedStatus: z.enum(INCIDENT_STATUSES, { error: "invalid" }),
});

/** A note on the timeline, optionally moving the status (open → investigating → mitigated, and back to investigating). */
export async function addIncidentUpdate(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: IncidentStatus }> {
  assertCan(actor, "ops.incident.manage");
  const input = IncidentUpdateInput.parse(raw);
  const row = await readIncident(db, input.incidentId);
  const from = row.status as IncidentStatus;
  const to = input.status && input.status !== from ? input.status : null;
  if (to) {
    if (from !== input.expectedStatus) throw conflict("incident_changed", row.id);
    if (!INCIDENT_MOVES[from].includes(to)) throw invalid({ status: "invalid" });
  }
  const by = byOf(actor);
  const statements: BatchStatement[] = to
    ? [
        db
          .update(incidents)
          .set({ status: to, mitigatedAt: to === "mitigated" ? sql`coalesce(${incidents.mitigatedAt}, ${now})` : incidents.mitigatedAt, updatedAt: now })
          .where(and(eq(incidents.id, row.id), eq(incidents.status, from))),
        expectChanged(db, 1, { code: "INCIDENT_CHANGED", detail: row.id }),
      ]
    : [db.update(incidents).set({ updatedAt: now }).where(eq(incidents.id, row.id))];
  statements.push(
    db.insert(incidentUpdates).values({ id: newId("inu"), incidentId: row.id, status: to, note: input.note, createdBy: by, createdAt: now }),
    db.insert(auditEvents).values(auditRow({ actor, action: INCIDENT_ACTIONS.update, entityType: "incident", entityId: row.id, summary: `${row.ref}${to ? ` ${from} → ${to}` : " note"}`, before: { status: from }, after: { status: to ?? from }, reason: input.note.slice(0, 1000), at: now })),
  );
  await runBatch(db, statements);
  return { status: to ?? from };
}

export const ResolveIncidentInput = z.object({
  incidentId: IncidentId,
  resolvedAt: z.string().trim().max(30).optional(),
  rootCause: z.string({ error: "postmortem_required" }).trim().min(20, "postmortem_required").max(8000, "too_long"),
  note: z.string().trim().max(2000, "too_long").optional(),
  expectedStatus: z.enum(INCIDENT_STATUSES, { error: "invalid" }),
});

/** Resolves it: the resolution time (now, or when it really ended — not before it started) and the post-mortem. */
export async function resolveIncident(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "ops.incident.manage");
  const input = ResolveIncidentInput.parse(raw);
  const row = await readIncident(db, input.incidentId);
  if (row.status === "resolved") return { replayed: true };
  if (row.status !== input.expectedStatus) throw conflict("incident_changed", row.id);
  const resolvedAt = input.resolvedAt ? baghdadDateTime(input.resolvedAt) : now;
  if (resolvedAt === null || resolvedAt > now + CLOCK_SKEW_MS || resolvedAt < row.startedAt) throw invalid({ resolvedAt: "resolved_invalid" });
  const by = byOf(actor);
  await runBatch(db, [
    db
      .update(incidents)
      .set({ status: "resolved", resolvedAt, rootCause: input.rootCause, mitigatedAt: sql`coalesce(${incidents.mitigatedAt}, ${resolvedAt})`, updatedAt: now })
      .where(and(eq(incidents.id, row.id), eq(incidents.status, row.status))),
    expectChanged(db, 1, { code: "INCIDENT_CHANGED", detail: row.id }),
    db.insert(incidentUpdates).values({ id: newId("inu"), incidentId: row.id, status: "resolved", note: input.note || input.rootCause.slice(0, 2000), createdBy: by, createdAt: now }),
    cancelOwnerTasks(db, row.id, now, "done"),
    db.insert(auditEvents).values(
      auditRow({ actor, action: INCIDENT_ACTIONS.resolve, entityType: "incident", entityId: row.id, summary: `${row.ref} resolved`, before: { status: row.status, rootCause: row.rootCause }, after: { status: "resolved", resolvedAt, rootCause: input.rootCause }, reason: input.note || null, at: now }),
    ),
  ]);
  return { replayed: false };
}

export const ReopenIncidentInput = z.object({ incidentId: IncidentId, reason: Text(3, 2000, "reason_required"), targetDay: z.string({ error: "target_invalid" }).trim().min(1, "target_invalid").max(20, "target_invalid") });

/** Opens a resolved incident again (investigating), with a reason and a new target day for its owner. */
export async function reopenIncident(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "ops.incident.manage");
  const input = ReopenIncidentInput.parse(raw);
  const row = await readIncident(db, input.incidentId);
  if (row.status !== "resolved") return { replayed: true };
  const target = targetOf(input.targetDay, now);
  const by = byOf(actor);
  const statements: BatchStatement[] = [
    db.update(incidents).set({ status: "investigating", resolvedAt: null, updatedAt: now }).where(and(eq(incidents.id, row.id), eq(incidents.status, "resolved"))),
    expectChanged(db, 1, { code: "INCIDENT_CHANGED", detail: row.id }),
    db.insert(incidentUpdates).values({ id: newId("inu"), incidentId: row.id, status: "investigating", note: input.reason, createdBy: by, createdAt: now }),
    cancelOwnerTasks(db, row.id, now),
  ];
  if (row.ownerId) statements.push(ownerTaskStatement(db, { incidentId: row.id, ownerId: row.ownerId, dueAt: target.at, severity: row.severity as IncidentSeverity, createdBy: by, now }));
  statements.push(
    db.insert(auditEvents).values(
      auditRow({ actor, action: INCIDENT_ACTIONS.reopen, entityType: "incident", entityId: row.id, summary: `${row.ref} reopened`, before: { status: "resolved", resolvedAt: row.resolvedAt }, after: { status: "investigating", targetDay: target.day }, reason: input.reason, at: now }),
    ),
  );
  await runBatch(db, statements);
  return { replayed: false };
}

export const OwnerInput = z.object({
  incidentId: IncidentId,
  ownerId: z.string({ error: "owner_invalid" }).trim().min(1, "owner_invalid").max(64, "owner_invalid"),
  targetDay: z.string({ error: "target_invalid" }).trim().min(1, "target_invalid").max(20, "target_invalid"),
  reason: Text(3, 1000, "reason_required"),
});

/** A new owner and/or target day (an open incident only): the earlier task is cancelled, the owner gets a new one. */
export async function changeIncidentOwner(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "ops.incident.manage");
  const input = OwnerInput.parse(raw);
  const row = await readIncident(db, input.incidentId);
  if (row.status === "resolved") throw conflict("incident_resolved", row.id);
  const target = targetOf(input.targetDay, now);
  await assertOwner(db, input.ownerId);
  const task = (await tasksOf(db, [row.id])).get(row.id);
  const openTask = task && (OPEN_TASK as readonly string[]).includes(task.status) ? task : null;
  if (row.ownerId === input.ownerId && openTask?.assignedTo === input.ownerId && openTask.dueAt === target.at) return { changed: false };
  const by = byOf(actor);
  const names = await employeeNames(db, [row.ownerId, input.ownerId]);
  await runBatch(db, [
    db.update(incidents).set({ ownerId: input.ownerId, updatedAt: now }).where(and(eq(incidents.id, row.id), ne(incidents.status, "resolved"))),
    expectChanged(db, 1, { code: "INCIDENT_CHANGED", detail: row.id }),
    cancelOwnerTasks(db, row.id, now),
    ownerTaskStatement(db, { incidentId: row.id, ownerId: input.ownerId, dueAt: target.at, severity: row.severity as IncidentSeverity, createdBy: by, now }),
    db.insert(auditEvents).values(
      auditRow({
        actor,
        action: INCIDENT_ACTIONS.owner,
        entityType: "incident",
        entityId: row.id,
        summary: `${row.ref} owner`,
        before: { ownerId: row.ownerId, owner: row.ownerId ? (names.get(row.ownerId) ?? null) : null, targetDay: openTask?.dueAt ? baghdadDay(openTask.dueAt) : null },
        after: { ownerId: input.ownerId, owner: names.get(input.ownerId) ?? null, targetDay: target.day },
        reason: input.reason,
        at: now,
      }),
    ),
  ]);
  return { changed: true };
}

export const SeverityInput = z.object({ incidentId: IncidentId, severity: z.enum(INCIDENT_SEVERITIES, { error: "required" }), reason: Text(3, 1000, "reason_required") });

export async function changeIncidentSeverity(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "ops.incident.manage");
  const input = SeverityInput.parse(raw);
  const row = await readIncident(db, input.incidentId);
  if (row.severity === input.severity) return { changed: false };
  await runBatch(db, [
    db.update(incidents).set({ severity: input.severity, updatedAt: now }).where(and(eq(incidents.id, row.id), eq(incidents.severity, row.severity))),
    expectChanged(db, 1, { code: "INCIDENT_CHANGED", detail: row.id }),
    db
      .update(staffTasks)
      .set({ priority: priorityOf(input.severity) })
      .where(and(eq(staffTasks.refType, INCIDENT_TASK_REF), eq(staffTasks.refId, row.id), inArray(staffTasks.status, [...OPEN_TASK]))),
    db.insert(auditEvents).values(auditRow({ actor, action: INCIDENT_ACTIONS.severity, entityType: "incident", entityId: row.id, summary: `${row.ref} ${row.severity} → ${input.severity}`, before: { severity: row.severity }, after: { severity: input.severity }, reason: input.reason, at: now })),
  ]);
  return { changed: true };
}

export const EditIncidentInput = z.object({
  incidentId: IncidentId,
  title: Text(3, 160),
  summary: Text(10, 4000),
  impact: z.string().trim().max(2000, "too_long").optional(),
  rootCause: z.string().trim().max(8000, "too_long").optional(),
  expectedUpdatedAt: z.coerce.number({ error: "invalid" }).int("invalid"),
  reason: Text(3, 1000, "reason_required"),
});

/** Corrects the title, summary, impact (and, once resolved, the post-mortem) against the version the form saw. */
export async function editIncident(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "ops.incident.manage");
  const input = EditIncidentInput.parse(raw);
  const row = await readIncident(db, input.incidentId);
  if (row.updatedAt !== input.expectedUpdatedAt) throw conflict("incident_changed", row.id);
  const next = { title: input.title, summary: input.summary, impact: input.impact || null, rootCause: row.status === "resolved" ? input.rootCause || row.rootCause : row.rootCause };
  if (row.status === "resolved" && (next.rootCause ?? "").length < 20) throw invalid({ rootCause: "postmortem_required" });
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of ["title", "summary", "impact", "rootCause"] as const) {
    if ((row[key] ?? null) !== (next[key] ?? null)) {
      before[key] = row[key] ?? null;
      after[key] = next[key] ?? null;
    }
  }
  if (Object.keys(after).length === 0) throw new AppError("no_change", 400, { fields: { _: "no_change" } });
  await runBatch(db, [
    db.update(incidents).set({ ...next, updatedAt: now }).where(and(eq(incidents.id, row.id), eq(incidents.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "INCIDENT_CHANGED", detail: row.id }),
    db.insert(auditEvents).values(auditRow({ actor, action: INCIDENT_ACTIONS.edit, entityType: "incident", entityId: row.id, summary: `${row.ref} details`, before, after, reason: input.reason, at: now })),
  ]);
  return { changed: true };
}

export const LinkInput = z.object({ incidentId: IncidentId, kind: z.enum(LINK_KINDS, { error: "link_invalid" }), id: z.string({ error: "link_invalid" }).trim().min(1, "link_invalid").max(64, "link_invalid"), reason: z.string().trim().max(1000, "too_long").optional() });

async function currentLinks(db: Db, incidentId: string): Promise<Map<string, LinkFact>> {
  const events = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "incident"), eq(auditEvents.entityId, incidentId), inArray(auditEvents.action, [INCIDENT_ACTIONS.create, INCIDENT_ACTIONS.link, INCIDENT_ACTIONS.unlink])))
    .orderBy(asc(auditEvents.seq));
  return foldLinks(events);
}

/** Links a finding, a job run or an error report to the incident (also a resolved one: the post-mortem's evidence). */
export async function linkToIncident(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "ops.incident.manage");
  const input = LinkInput.parse(raw);
  const row = await readIncident(db, input.incidentId);
  const [link] = await resolveLinks(db, actor, [{ kind: input.kind, id: input.id }]);
  if (link.kind === "error" && link.incidentId === row.id) return { replayed: true };
  if (link.kind === "error" && link.incidentId) throw new AppError("link_exists", 409, { fields: { id: "link_exists" }, detail: link.id });
  if (link.kind !== "error" && (await currentLinks(db, row.id)).has(`${link.kind}:${link.id}`)) return { replayed: true };
  const statements: BatchStatement[] = [];
  if (link.kind === "error") statements.push(db.update(errorReports).set({ incidentId: row.id }).where(and(eq(errorReports.id, link.id), isNull(errorReports.incidentId))), expectChanged(db, 1, { code: "LINK_EXISTS", detail: link.id }));
  statements.push(
    db.update(incidents).set({ updatedAt: now }).where(eq(incidents.id, row.id)),
    db.insert(auditEvents).values(auditRow({ actor, action: INCIDENT_ACTIONS.link, entityType: "incident", entityId: row.id, summary: `${row.ref} + ${link.kind} ${link.id}`, after: { kind: link.kind, id: link.id, label: link.label }, reason: input.reason || null, at: now })),
  );
  await runBatch(db, statements);
  return { replayed: false };
}

export const UnlinkInput = LinkInput.extend({ reason: Text(3, 1000, "reason_required") });

/** Takes a link away again, with a reason (the link event stays in the trail). */
export async function unlinkFromIncident(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "ops.incident.manage");
  const input = UnlinkInput.parse(raw);
  const row = await readIncident(db, input.incidentId);
  const statements: BatchStatement[] = [];
  let label = input.id;
  if (input.kind === "error") {
    const error = await db.select({ incidentId: errorReports.incidentId, message: errorReports.message, source: errorReports.source }).from(errorReports).where(eq(errorReports.id, input.id)).get();
    if (!error || error.incidentId !== row.id) return { replayed: true };
    label = `${error.source} · ${error.message.slice(0, 120)}`;
    statements.push(db.update(errorReports).set({ incidentId: null }).where(and(eq(errorReports.id, input.id), eq(errorReports.incidentId, row.id))), expectChanged(db, 1, { code: "LINK_MISSING", detail: input.id }));
  } else {
    const link = (await currentLinks(db, row.id)).get(`${input.kind}:${input.id}`);
    if (!link) return { replayed: true };
    label = link.label;
  }
  statements.push(
    db.update(incidents).set({ updatedAt: now }).where(eq(incidents.id, row.id)),
    db.insert(auditEvents).values(auditRow({ actor, action: INCIDENT_ACTIONS.unlink, entityType: "incident", entityId: row.id, summary: `${row.ref} − ${input.kind} ${input.id}`, after: { kind: input.kind, id: input.id, label }, reason: input.reason, at: now })),
  );
  await runBatch(db, statements);
  return { replayed: false };
}

/** For the front page and the bell: open incidents, mine, and those past their target. Null without ops.incident.read. */
export async function incidentCounts(db: Db, actor: Actor, now: number): Promise<{ active: number; mine: number; overdue: number; mineOverdue: number } | null> {
  if (!can(actor, "ops.incident.read")) return null;
  const me = actor.kind === "employee" ? actor.id : "-";
  const rows = await db.all<{ active: number; mine: number; overdue: number; mineOverdue: number }>(sql`
    SELECT
      coalesce(sum(CASE WHEN status <> 'resolved' THEN 1 ELSE 0 END), 0) AS active,
      coalesce(sum(CASE WHEN status <> 'resolved' AND owner_id = ${me} THEN 1 ELSE 0 END), 0) AS mine,
      coalesce(sum(CASE WHEN status <> 'resolved' AND ${openTaskDue} < ${now} THEN 1 ELSE 0 END), 0) AS overdue,
      coalesce(sum(CASE WHEN status <> 'resolved' AND owner_id = ${me} AND ${openTaskDue} < ${now} THEN 1 ELSE 0 END), 0) AS mineOverdue
    FROM incidents`);
  const row = rows[0];
  return { active: Number(row?.active ?? 0), mine: Number(row?.mine ?? 0), overdue: Number(row?.overdue ?? 0), mineOverdue: Number(row?.mineOverdue ?? 0) };
}
