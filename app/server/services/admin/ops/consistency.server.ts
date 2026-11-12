/**
 * Admin 23.06 — the daily consistency checks (`consistency.daily`, 00:30 UTC = 03:30 Baghdad; app/server/jobs.server.ts):
 * stock levels against their movements and reservations, the wallet ledger against its account and below zero,
 * journal entries that do not balance or lines without an entry, orders against their lines, payments and refunds,
 * paid money and delivered orders without their postings. The job writes `consistency_findings` (one row per problem,
 * updated while it persists, closed by the job when it is gone, opened again when a closed one comes back).
 *
 * This module explains each finding, gives it to a person (a `staff_tasks` row about the finding, with an optional due
 * day — the finding becomes "acknowledged"), and closes it with a reason: "resolved" (the cause was corrected where it
 * lives — the next daily run opens it again if the problem is still there) or "false positive" (the check is wrong for
 * this case; the job leaves it closed). It NEVER changes the data the check compared: corrections happen in the module
 * that owns the record (a counted stock adjustment, a reversing journal entry, a refund…), which the finding links to.
 *
 * Numbers of checks that can be cost data (journal entries can be cost-of-goods or inventory postings) reach only
 * holders of cost.read; profit-named numbers need profit.read too; wallet amounts need customers.wallet.read or
 * finance.wallet.read — in page data, history and search alike. An employee limited to a branch sees, counts, takes and
 * closes only findings about that branch's records (`findingScope`); a finding goes only to someone who may open it.
 * Every change is one guarded batch with an audit event per finding (`ops.finding.assign|resolve|dismiss|reopen`).
 */
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { assertCan, type Actor } from "~/server/actor";
import { auditRow } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, consistencyFindings, employees, jobRuns, staffTasks, type ConsistencyFinding as FindingRecord } from "~/server/db/schema";
import { chunkRows, expectChanged, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { CONSISTENCY_CHECKS } from "~/server/jobs.server";
import { incidentsLinkedTo } from "./incidents.server";
import { actorOf, auditActorOf, cutProtected, employeeHolds, employeeNames, entityKey, entityViews, findingBranchSql, findingScope, opsAccess, staffHolding } from "./shared.server";
import {
  BULK_MAX,
  CHECK_META,
  FINDINGS_PAGE_SIZE,
  FINDING_VIEWS,
  addDays,
  baghdadDay,
  baghdadDayEnd,
  checkAreaOf,
  dayOf,
  isCostCheck,
  isProfitCheck,
  isWalletCheck,
  likePatterns,
  type FindingFilters,
  type FindingRow,
  type FindingSeverity,
  type FindingStatus,
  type FindingView,
  type HistoryEvent,
  type Person,
} from "./types";

/** `staff_tasks.ref_type` of a finding given to a person. */
export const FINDING_TASK_REF = "consistency_finding";
export const FINDING_ACTIONS = { assign: "ops.finding.assign", resolve: "ops.finding.resolve", dismiss: "ops.finding.dismiss", reopen: "ops.finding.reopen" } as const;

const ACTIVE: FindingStatus[] = ["open", "acknowledged"];
const OPEN_TASK_STATUSES = ["open", "in_progress"] as const;

type Access = ReturnType<typeof opsAccess>;

/** True when this employee may not read the numbers of the check (cost, profit, wallet money). */
export function withheldFor(checkKey: string, access: Pick<Access, "cost" | "profit" | "wallet">): boolean {
  return (isCostCheck(checkKey) && !access.cost) || (isProfitCheck(checkKey) && !access.profit) || (isWalletCheck(checkKey) && !access.wallet);
}

type OpenTask = { id: string; refId: string; assignedTo: string | null; dueAt: number | null };

async function openTasksOf(db: Db, findingIds: readonly string[]): Promise<Map<string, OpenTask>> {
  const out = new Map<string, OpenTask>();
  for (let i = 0; i < findingIds.length; i += 90) {
    const rows = await db
      .select({ id: staffTasks.id, refId: staffTasks.refId, assignedTo: staffTasks.assignedTo, dueAt: staffTasks.dueAt })
      .from(staffTasks)
      .where(and(eq(staffTasks.refType, FINDING_TASK_REF), inArray(staffTasks.refId, findingIds.slice(i, i + 90)), inArray(staffTasks.status, [...OPEN_TASK_STATUSES])))
      .orderBy(desc(staffTasks.createdAt), desc(staffTasks.id));
    for (const row of rows) if (row.refId && !out.has(row.refId)) out.set(row.refId, { id: row.id, refId: row.refId, assignedTo: row.assignedTo, dueAt: row.dueAt });
  }
  return out;
}

/** Rows as the screens show them: numbers withheld where needed, the record's label and link, who has it. */
async function shape(db: Db, actor: Actor, rows: readonly FindingRecord[]): Promise<FindingRow[]> {
  const access = opsAccess(actor);
  const [tasks, entities] = await Promise.all([openTasksOf(db, rows.map((row) => row.id)), entityViews(db, actor, rows.map((row) => ({ type: row.entityType, id: row.entityId })))]);
  const names = await employeeNames(db, [...rows.map((row) => row.resolvedBy), ...[...tasks.values()].map((task) => task.assignedTo)]);
  return rows.map((row) => {
    const hidden = withheldFor(row.checkKey, access);
    const cut = hidden ? { value: null, withheld: true } : cutProtected(row.details, access);
    const task = tasks.get(row.id);
    return {
      id: row.id,
      checkKey: row.checkKey,
      area: checkAreaOf(row.checkKey),
      known: row.checkKey in CHECK_META,
      severity: row.severity as FindingSeverity,
      status: row.status as FindingStatus,
      entity: entities.get(entityKey(row.entityType, row.entityId)) ?? { type: row.entityType, id: row.entityId, label: row.entityId, href: null },
      message: hidden ? null : row.message,
      details: cut.value,
      withheld: hidden || cut.withheld,
      occurrences: row.occurrences,
      detectedAt: row.detectedAt,
      lastSeenAt: row.lastSeenAt,
      runId: row.runId,
      assignee: task?.assignedTo ? { id: task.assignedTo, name: names.get(task.assignedTo) ?? task.assignedTo, dueAt: task.dueAt, taskId: task.id } : null,
      resolvedBy: actorOf(row.resolvedBy, names),
      resolvedAt: row.resolvedAt,
      resolutionNote: row.resolutionNote,
    };
  });
}

function viewCondition(view: FindingView): SQL | undefined {
  if (view === "all") return undefined;
  if (view === "active") return inArray(consistencyFindings.status, ACTIVE);
  return eq(consistencyFindings.status, view);
}

const openTaskExists = (assignee?: string) =>
  assignee
    ? sql`EXISTS (SELECT 1 FROM staff_tasks AS t WHERE t.ref_type = ${FINDING_TASK_REF} AND t.ref_id = ${consistencyFindings.id} AND t.status IN ('open', 'in_progress') AND t.assigned_to = ${assignee})`
    : sql`EXISTS (SELECT 1 FROM staff_tasks AS t WHERE t.ref_type = ${FINDING_TASK_REF} AND t.ref_id = ${consistencyFindings.id} AND t.status IN ('open', 'in_progress'))`;

export type LastCheckRun = { id: string; at: number; status: string; findings: Record<string, number> | null; failedChecks: number | null; error: string | null } | null;

/** The daily job's latest run (when, how it ended, how many problems each check found). */
export async function lastCheckRun(db: Db): Promise<LastCheckRun> {
  const row = await db.select().from(jobRuns).where(eq(jobRuns.job, "consistency.daily")).orderBy(desc(jobRuns.startedAt), desc(jobRuns.id)).limit(1).get();
  if (!row) return null;
  const stats = (row.stats ?? {}) as { findings?: Record<string, number>; failedChecks?: number };
  return { id: row.id, at: row.startedAt, status: row.status, findings: stats.findings && typeof stats.findings === "object" ? stats.findings : null, failedChecks: typeof stats.failedChecks === "number" ? stats.failedChecks : null, error: row.error };
}

export type FindingsPage = {
  rows: FindingRow[];
  total: number;
  page: number;
  pageCount: number;
  counts: Record<FindingView, number>;
  checks: string[];
  lastRun: LastCheckRun;
  /** Who a finding may be given to (holders of ops.consistency.read); empty without ops.consistency.resolve. */
  assignees: Person[];
};

/** The findings with their filters (50 a page): severity first by default, the newest sighting first inside. */
export async function listFindings(db: Db, actor: Actor, filters: FindingFilters): Promise<FindingsPage> {
  assertCan(actor, "ops.consistency.read");
  const access = opsAccess(actor);
  const seen = db.selectDistinct({ key: consistencyFindings.checkKey }).from(consistencyFindings).limit(200);
  // Every filter but the view: they decide the rows AND the view chips' counts (a chip's link keeps these filters).
  const base: SQL[] = [];
  const scope = findingScope(actor);
  if (scope) base.push(scope);
  if (filters.severity) base.push(eq(consistencyFindings.severity, filters.severity));
  if (filters.check) base.push(eq(consistencyFindings.checkKey, filters.check));
  if (filters.assignee === "none") base.push(sql`NOT ${openTaskExists()}`);
  else if (filters.assignee === "me") base.push(openTaskExists(actor.kind === "employee" ? actor.id : "-"));
  else if (filters.assignee) base.push(openTaskExists(filters.assignee));
  const seenChecks = await seen;
  const checks = [...new Set([...CONSISTENCY_CHECKS.map((check) => check.key), ...seenChecks.map((row) => row.key)])].sort();
  if (filters.q) {
    const patterns = likePatterns(filters.q);
    const text: SQL[] = patterns.flatMap((pattern) => [sql`${consistencyFindings.entityId} LIKE ${pattern} ESCAPE '\\'`, sql`${consistencyFindings.checkKey} LIKE ${pattern} ESCAPE '\\'`]);
    // The job's sentence carries the numbers: searched only in the checks whose numbers this employee may read
    // (cost, profit, wallet money) — a check this list does not know is not searched by its sentence.
    const message = or(...patterns.map((pattern) => sql`${consistencyFindings.message} LIKE ${pattern} ESCAPE '\\'`)) as SQL;
    if (access.cost && access.profit && access.wallet) text.push(message);
    else {
      const readable = checks.filter((check) => !withheldFor(check, access));
      if (readable.length) text.push(and(message, inArray(consistencyFindings.checkKey, readable)) as SQL);
    }
    base.push(or(...text) as SQL);
  }
  const view = viewCondition(filters.view);
  const condition = and(...(view ? [view] : []), ...base);
  const baseCondition = base.length ? and(...base) : undefined;
  const order =
    filters.sort === "last_seen"
      ? [desc(consistencyFindings.lastSeenAt), desc(consistencyFindings.id)]
      : filters.sort === "detected"
        ? [desc(consistencyFindings.detectedAt), desc(consistencyFindings.id)]
        : filters.sort === "occurrences"
          ? [desc(consistencyFindings.occurrences), desc(consistencyFindings.lastSeenAt), desc(consistencyFindings.id)]
          : [sql`CASE ${consistencyFindings.severity} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`, desc(consistencyFindings.lastSeenAt), desc(consistencyFindings.id)];
  const [totalRow, rows, byStatus, lastRun, assignees] = await Promise.all([
    db.select({ n: count() }).from(consistencyFindings).where(condition).get(),
    db
      .select()
      .from(consistencyFindings)
      .where(condition)
      .orderBy(...order)
      .limit(FINDINGS_PAGE_SIZE)
      .offset((filters.page - 1) * FINDINGS_PAGE_SIZE),
    db.select({ status: consistencyFindings.status, n: count() }).from(consistencyFindings).where(baseCondition).groupBy(consistencyFindings.status),
    lastCheckRun(db),
    access.resolveFindings ? staffHolding(db, "ops.consistency.read") : Promise.resolve([] as Person[]),
  ]);
  const statusCount = new Map(byStatus.map((row) => [row.status, Number(row.n)]));
  const counts = Object.fromEntries(
    FINDING_VIEWS.map((v) => [v, v === "all" ? [...statusCount.values()].reduce((a, b) => a + b, 0) : v === "active" ? (statusCount.get("open") ?? 0) + (statusCount.get("acknowledged") ?? 0) : (statusCount.get(v) ?? 0)]),
  ) as Record<FindingView, number>;
  const total = Number(totalRow?.n ?? 0);
  return { rows: await shape(db, actor, rows), total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / FINDINGS_PAGE_SIZE)), counts, checks, lastRun, assignees };
}

export type FindingDetail = {
  finding: FindingRow;
  history: HistoryEvent[];
  /** The incidents it belongs to — only for an employee who may read incidents (empty otherwise). */
  incidents: { id: string; ref: string; title: string; status: string }[];
  /** The run that saw it last; `href` only for an employee who may open the jobs pages. */
  run: { id: string; status: string; startedAt: number; href: string | null } | null;
  assignees: Person[];
};

/** One finding: what it is, what the job saw, who has it, its history and the incidents it belongs to. */
export async function getFinding(db: Db, actor: Actor, findingId: string): Promise<FindingDetail> {
  assertCan(actor, "ops.consistency.read");
  const access = opsAccess(actor);
  const row = await db
    .select({ finding: consistencyFindings, branch: sql<string | null>`${findingBranchSql}` })
    .from(consistencyFindings)
    .where(and(eq(consistencyFindings.id, findingId), findingScope(actor)))
    .get()
    .then((found) => found && { ...found.finding, branchId: found.branch ?? null });
  if (!row) throw notFound("finding");
  const [finding] = await shape(db, actor, [row]);
  const [events, incidents, run, assignees] = await Promise.all([
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "consistency_finding"), eq(auditEvents.entityId, findingId)))
      .orderBy(asc(auditEvents.seq))
      .limit(200),
    access.incidents ? incidentsLinkedTo(db, "finding", findingId) : Promise.resolve([]),
    row.runId ? db.select({ id: jobRuns.id, status: jobRuns.status, startedAt: jobRuns.startedAt }).from(jobRuns).where(eq(jobRuns.id, row.runId)).get() : Promise.resolve(undefined),
    access.resolveFindings ? staffHolding(db, "ops.consistency.read", { branchOf: row.branchId }) : Promise.resolve([] as Person[]),
  ]);
  const hidden = withheldFor(row.checkKey, access);
  const history: HistoryEvent[] = events.map((event) => ({
    id: event.id,
    at: event.at,
    action: event.action,
    by: auditActorOf(event),
    reason: event.reason,
    // the snapshots of a finding carry only statuses, people and days — never the check's numbers
    before: hidden ? null : cutProtected(event.before as Record<string, unknown> | null, access).value,
    after: hidden ? null : cutProtected(event.after as Record<string, unknown> | null, access).value,
  }));
  return { finding, history, incidents, run: run ? { ...run, href: access.jobs ? `/admin/ops/jobs/runs/${encodeURIComponent(run.id)}` : null } : null, assignees };
}

// ───────────────────────────────────────────────────────────────── changes

const Ids = z.array(z.string().trim().min(1).max(64)).min(1, "nothing_selected").max(BULK_MAX, "too_many");

export const AssignFindingsInput = z.object({
  ids: Ids,
  assigneeId: z.string({ error: "assignee_invalid" }).trim().min(1, "assignee_invalid").max(64, "assignee_invalid"),
  dueDay: z.string().trim().max(20).optional(),
  note: z.string().trim().max(500, "too_long").optional(),
});

/** The findings by id — only those this employee may see (branch limit); one missing or out of reach → not_found. */
async function readFindings(db: Db, actor: Actor, ids: readonly string[]): Promise<FindingRecord[]> {
  const rows = await db
    .select()
    .from(consistencyFindings)
    .where(and(inArray(consistencyFindings.id, [...ids]), findingScope(actor)));
  if (rows.length !== ids.length) throw notFound("finding");
  return rows;
}

const priorityOf = (severity: string): "urgent" | "high" | "normal" => (severity === "critical" ? "urgent" : severity === "warning" ? "high" : "normal");

/**
 * Gives findings to a person (ops.consistency.resolve): each becomes "acknowledged", the person gets a task about it
 * (`staff_tasks`, ref "consistency_finding", due at the end of `dueDay` in Baghdad when given) and an earlier person's
 * open task about it is cancelled. Only open or acknowledged findings; the person must be an active employee who may
 * read findings. A finding already with that person and due day is left as it is (a resubmission changes nothing).
 */
export async function assignFindings(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ assigned: number; unchanged: number }> {
  assertCan(actor, "ops.consistency.resolve");
  const input = AssignFindingsInput.parse(raw);
  const ids = [...new Set(input.ids)];
  let dueAt: number | null = null;
  let dueDay: string | null = null;
  if (input.dueDay) {
    const today = baghdadDay(now);
    dueDay = dayOf(input.dueDay);
    if (!dueDay || dueDay < today || dueDay > addDays(today, 365)) throw invalid({ dueDay: "due_invalid" });
    dueAt = baghdadDayEnd(dueDay);
  }
  if (!(await employeeHolds(db, input.assigneeId, "ops.consistency.read"))) throw invalid({ assigneeId: "assignee_invalid" });
  const rows = await readFindings(db, actor, ids);
  // the person must be able to open what they are given: someone limited to a branch takes only that branch's findings
  const assignee = await db.select({ branchId: employees.branchId }).from(employees).where(eq(employees.id, input.assigneeId)).get();
  if (assignee?.branchId) {
    const outside = await db
      .select({ id: consistencyFindings.id })
      .from(consistencyFindings)
      .where(and(inArray(consistencyFindings.id, ids), sql`NOT coalesce(${findingBranchSql} = ${assignee.branchId}, 0)`))
      .limit(1)
      .get();
    if (outside) throw invalid({ assigneeId: "assignee_invalid" });
  }
  const closed = rows.find((row) => !ACTIVE.includes(row.status as FindingStatus));
  if (closed) throw new AppError("finding_not_open", 409, { detail: closed.id });
  const tasks = await openTasksOf(db, ids);
  const change = rows.filter((row) => {
    const task = tasks.get(row.id);
    return !(row.status === "acknowledged" && task && task.assignedTo === input.assigneeId && task.dueAt === dueAt);
  });
  if (change.length === 0) return { assigned: 0, unchanged: rows.length };
  const changeIds = change.map((row) => row.id);
  const [entities, names] = await Promise.all([
    entityViews(db, actor, change.map((row) => ({ type: row.entityType, id: row.entityId }))),
    employeeNames(db, [input.assigneeId, ...change.map((row) => tasks.get(row.id)?.assignedTo)]),
  ]);
  const createdBy = actor.kind === "employee" ? actor.id : null;
  const taskRows = change.map((row) => ({
    id: newId("tsk"),
    title: `23.06 ${row.checkKey} — ${entities.get(entityKey(row.entityType, row.entityId))?.label ?? row.entityId ?? ""}`.slice(0, 200),
    description: input.note || null,
    assignedTo: input.assigneeId,
    priority: priorityOf(row.severity),
    status: "open" as const,
    dueAt,
    refType: FINDING_TASK_REF,
    refId: row.id,
    createdBy,
    createdAt: now,
  }));
  const auditRows = change.map((row) =>
    auditRow({
      actor,
      action: FINDING_ACTIONS.assign,
      entityType: "consistency_finding",
      entityId: row.id,
      summary: `${row.checkKey} given to ${names.get(input.assigneeId) ?? input.assigneeId}`,
      before: { status: row.status, assigneeId: tasks.get(row.id)?.assignedTo ?? null, assignee: names.get(tasks.get(row.id)?.assignedTo ?? "") ?? null, dueAt: tasks.get(row.id)?.dueAt ?? null },
      after: { status: "acknowledged", assigneeId: input.assigneeId, assignee: names.get(input.assigneeId) ?? null, dueDay },
      reason: input.note || null,
      at: now,
    }),
  );
  await runBatch(db, [
    db
      .update(consistencyFindings)
      .set({ status: "acknowledged" })
      .where(and(inArray(consistencyFindings.id, changeIds), inArray(consistencyFindings.status, ACTIVE), findingScope(actor))),
    expectChanged(db, changeIds.length, { code: "FINDING_CHANGED" }),
    db
      .update(staffTasks)
      .set({ status: "cancelled", completedAt: now })
      .where(and(eq(staffTasks.refType, FINDING_TASK_REF), inArray(staffTasks.refId, changeIds), inArray(staffTasks.status, [...OPEN_TASK_STATUSES]))),
    ...chunkRows(staffTasks, taskRows).map((chunk) => db.insert(staffTasks).values(chunk)),
    ...chunkRows(auditEvents, auditRows).map((chunk) => db.insert(auditEvents).values(chunk)),
  ]);
  return { assigned: change.length, unchanged: rows.length - change.length };
}

export const CloseFindingsInput = z.object({
  ids: Ids,
  outcome: z.enum(["resolved", "false_positive"], { error: "invalid" }),
  reason: z.string({ error: "reason_required" }).trim().min(3, "reason_required").max(1000, "too_long"),
});

/**
 * Closes findings with a reason (ops.consistency.resolve): "resolved" — the cause was corrected in the module that owns
 * the record (the next daily run opens it again if the problem is still there; its task is done) — or "false_positive"
 * — the check does not apply to this case (the job keeps it closed; its task is cancelled). Nothing the check compared
 * is changed here. Findings already closed the same way are left as they are (a resubmission changes nothing).
 */
export async function closeFindings(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ closed: number; unchanged: number }> {
  assertCan(actor, "ops.consistency.resolve");
  const input = CloseFindingsInput.parse(raw);
  const ids = [...new Set(input.ids)];
  const rows = await readFindings(db, actor, ids);
  const other = rows.find((row) => !ACTIVE.includes(row.status as FindingStatus) && row.status !== input.outcome);
  if (other) throw new AppError("finding_not_open", 409, { detail: other.id });
  const change = rows.filter((row) => ACTIVE.includes(row.status as FindingStatus));
  if (change.length === 0) return { closed: 0, unchanged: rows.length };
  const changeIds = change.map((row) => row.id);
  const tasks = await openTasksOf(db, changeIds);
  const by = actor.kind === "employee" ? actor.id : actor.kind === "system" ? `system:${actor.job}` : null;
  const auditRows = change.map((row) =>
    auditRow({
      actor,
      action: input.outcome === "resolved" ? FINDING_ACTIONS.resolve : FINDING_ACTIONS.dismiss,
      entityType: "consistency_finding",
      entityId: row.id,
      summary: `${row.checkKey} ${input.outcome}`,
      before: { status: row.status, assigneeId: tasks.get(row.id)?.assignedTo ?? null },
      after: { status: input.outcome },
      reason: input.reason,
      at: now,
    }),
  );
  await runBatch(db, [
    db
      .update(consistencyFindings)
      .set({ status: input.outcome, resolvedBy: by, resolvedAt: now, resolutionNote: input.reason })
      .where(and(inArray(consistencyFindings.id, changeIds), inArray(consistencyFindings.status, ACTIVE), findingScope(actor))),
    expectChanged(db, changeIds.length, { code: "FINDING_CHANGED" }),
    db
      .update(staffTasks)
      .set({ status: input.outcome === "resolved" ? "done" : "cancelled", completedAt: now })
      .where(and(eq(staffTasks.refType, FINDING_TASK_REF), inArray(staffTasks.refId, changeIds), inArray(staffTasks.status, [...OPEN_TASK_STATUSES]))),
    ...chunkRows(auditEvents, auditRows).map((chunk) => db.insert(auditEvents).values(chunk)),
  ]);
  return { closed: change.length, unchanged: rows.length - change.length };
}

export const ReopenFindingInput = z.object({
  id: z.string().trim().min(1).max(64),
  reason: z.string({ error: "reason_required" }).trim().min(3, "reason_required").max(1000, "too_long"),
});

/** Opens a closed finding again with a reason (ops.consistency.resolve): a wrong "false positive", a fix that did not hold. */
export async function reopenFinding(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "ops.consistency.resolve");
  const input = ReopenFindingInput.parse(raw);
  const [row] = await readFindings(db, actor, [input.id]);
  if (row.status === "open") return { replayed: true };
  if (row.status === "acknowledged") throw new AppError("finding_not_closed", 409, { detail: row.id });
  await runBatch(db, [
    db
      .update(consistencyFindings)
      .set({ status: "open", resolvedBy: null, resolvedAt: null, resolutionNote: null })
      .where(and(eq(consistencyFindings.id, row.id), inArray(consistencyFindings.status, ["resolved", "false_positive"]), findingScope(actor))),
    expectChanged(db, 1, { code: "FINDING_CHANGED", detail: row.id }),
    db.insert(auditEvents).values(
      auditRow({
        actor,
        action: FINDING_ACTIONS.reopen,
        entityType: "consistency_finding",
        entityId: row.id,
        summary: `${row.checkKey} opened again`,
        before: { status: row.status, resolvedBy: row.resolvedBy, resolutionNote: row.resolutionNote },
        after: { status: "open" },
        reason: input.reason,
        at: now,
      }),
    ),
  ]);
  return { replayed: false };
}

/** For the front page and the bell: open problems by severity and the critical ones nobody has. Null without the permission. */
export async function findingCounts(db: Db, actor: Actor): Promise<{ active: number; critical: number; warning: number; info: number; unassignedCritical: number } | null> {
  if (!opsAccess(actor).consistency) return null;
  // the same rows the list shows this employee (its branch limit), so a count equals the list it links to
  const rows = await db
    .select({ severity: consistencyFindings.severity, n: count(), unassigned: sql<number>`sum(CASE WHEN NOT ${openTaskExists()} THEN 1 ELSE 0 END)` })
    .from(consistencyFindings)
    .where(and(inArray(consistencyFindings.status, ACTIVE), findingScope(actor)))
    .groupBy(consistencyFindings.severity);
  const of = (severity: string) => rows.find((row) => row.severity === severity);
  return {
    active: rows.reduce((total, row) => total + Number(row.n), 0),
    critical: Number(of("critical")?.n ?? 0),
    warning: Number(of("warning")?.n ?? 0),
    info: Number(of("info")?.n ?? 0),
    unassignedCritical: Number(of("critical")?.unassigned ?? 0),
  };
}
