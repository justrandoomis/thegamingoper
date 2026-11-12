/**
 * Admin 19.01 — the execution log (`workflow_runs`): every run of every rule with the event, the version that ran and
 * what each action did; dry-run rows are the samples of the latest dry run of each rule. And the notices: a run whose
 * "notify" action addressed holders of a permission, shown to them until each marks it seen (an audit event per
 * person — the run itself is never edited).
 *
 *   await listRuns(db, actor, parseRunFilters(params), now);   // automation.workflow.read
 *   await listNotices(db, actor, now);                          // the notices for this employee's permissions
 *   await markNoticeSeen(db, actor, { runId }, now);
 */
import { sql } from "drizzle-orm";
import { sha256Hex } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid } from "~/server/errors";
import { DAY_MS, NOTICE_AUDIENCES, NOTICE_DAYS, isEventType, type ActionLogEntry, type NoticeAudience, type RunStatus } from "./catalog";
import { employeeNames, recordHref } from "./shared.server";
import { PAGE_SIZE, type NoticeView, type RunFilters, type RunPage, type RunView } from "./types";

const num = (value: unknown) => Number(value ?? 0);

export type RunRow = { id: string; workflowId: string; ruleName: string; refType: string | null; refId: string | null; event: unknown; isDryRun: number | boolean; status: string; actionsLog: unknown; error: string | null; startedAt: number };

const parse = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/** A run as the pages show it: links only where the employee may open them. */
export function runView(actor: Actor, row: RunRow, names: Map<string, { name: string }>): RunView {
  const event = parse<Record<string, unknown>>(row.event, {});
  const facts = parse<Record<string, unknown>>(event.facts, {});
  const entries = parse<ActionLogEntry[]>(row.actionsLog, []);
  const type = isEventType(event.type) ? event.type : null;
  const label = typeof event.label === "string" ? event.label : null;
  const ref = typeof facts.ref === "string" ? facts.ref : label;
  return {
    id: row.id,
    ruleId: row.workflowId,
    ruleName: row.ruleName,
    isDryRun: row.isDryRun === true || row.isDryRun === 1,
    status: row.status as RunStatus,
    at: num(row.startedAt),
    event: {
      type,
      key: typeof event.key === "string" ? event.key : null,
      label,
      at: typeof event.at === "number" ? event.at : null,
      version: typeof event.version === "number" ? event.version : null,
      href: recordHref(actor, row.refType, { ref, variantId: typeof facts.variantId === "string" ? facts.variantId : null }),
      isDemo: event.isDemo === true,
      facts: facts as Record<string, string | number | boolean | null>,
    },
    actions: (Array.isArray(entries) ? entries : []).map((entry) => {
      const detail = entry.detail ?? {};
      let href: string | null = null;
      let who: string | null = null;
      if (entry.type === "staff_task") {
        href = detail.taskId ? recordHref(actor, "staff_task", {}) : null;
        who = typeof detail.assigneeId === "string" ? (names.get(detail.assigneeId)?.name ?? null) : null;
      } else if (entry.type === "flag_order") {
        href = entry.outcome === "done" && can(actor, "orders.risk.review") ? "/admin/orders/review" : null;
      } else if (entry.type === "suggest_purchase") {
        href = detail.suggestionId && can(actor, "automation.suggestion.read") ? "/admin/automation/suggestions" : null;
      }
      return { ...entry, href, who };
    }),
    error: row.error,
  };
}

export async function namesForRuns(db: Db, rows: readonly RunRow[]) {
  const ids: string[] = [];
  for (const row of rows) for (const entry of parse<ActionLogEntry[]>(row.actionsLog, [])) if (entry?.type === "staff_task" && typeof entry.detail?.assigneeId === "string") ids.push(entry.detail.assigneeId);
  return employeeNames(db, ids);
}

const RUN_COLUMNS = sql`r.id AS id, r.workflow_id AS workflowId, w.name AS ruleName, r.ref_type AS refType, r.ref_id AS refId, r.event AS event, r.is_dry_run AS isDryRun,
  r.status AS status, r.actions_log AS actionsLog, r.error AS error, r.started_at AS startedAt`;

/**
 * The execution log, newest first (automation.workflow.read). Filters in the URL: rule, status, real / dry / all, and
 * the last 1 / 7 / 30 days before `now` (the front page's "failed in 24 hours" opens exactly what it counted).
 */
export async function listRuns(db: Db, actor: Actor, filters: RunFilters, now: number): Promise<RunPage> {
  assertCan(actor, "automation.workflow.read");
  const where = sql.join(
    [
      sql`1 = 1`,
      filters.rule ? sql`r.workflow_id = ${filters.rule}` : null,
      filters.status ? sql`r.status = ${filters.status}` : null,
      filters.kind === "real" ? sql`r.is_dry_run = 0` : filters.kind === "dry" ? sql`r.is_dry_run = 1` : null,
      filters.days ? sql`r.started_at >= ${now - filters.days * DAY_MS}` : null,
    ].filter((part): part is ReturnType<typeof sql> => part !== null),
    sql` AND `,
  );
  const [rows, total, rules] = await Promise.all([
    db.all<RunRow>(sql`SELECT ${RUN_COLUMNS} FROM workflow_runs AS r JOIN workflows AS w ON w.id = r.workflow_id WHERE ${where} ORDER BY r.started_at DESC, r.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM workflow_runs AS r WHERE ${where}`),
    db.all<{ id: string; name: string }>(sql`SELECT id, name FROM workflows ORDER BY name, id`),
  ]);
  const names = await namesForRuns(db, rows);
  const count = num(total[0]?.n);
  return { rows: rows.map((row) => runView(actor, row, names)), total: count, page: filters.page, pageCount: Math.max(1, Math.ceil(count / PAGE_SIZE)), rules: rules.map((rule) => ({ value: rule.id, label: rule.name })) };
}

/** One run (automation.workflow.read); not_found for an unknown id. */
export async function getRun(db: Db, actor: Actor, runId: string): Promise<RunView> {
  assertCan(actor, "automation.workflow.read");
  if (!/^wf[rd]_[a-z0-9]{10,40}$/.test(runId)) throw new AppError("not_found", 404);
  const rows = await db.all<RunRow>(sql`SELECT ${RUN_COLUMNS} FROM workflow_runs AS r JOIN workflows AS w ON w.id = r.workflow_id WHERE r.id = ${runId}`);
  const row = rows[0];
  if (!row) throw new AppError("not_found", 404);
  return runView(actor, row, await namesForRuns(db, rows));
}

/** Runs of one rule (the rule's page): the latest real ones, or the samples of its latest dry run. */
export async function runsOfRule(db: Db, actor: Actor, ruleId: string, kind: "real" | "dry", limit: number): Promise<RunView[]> {
  const rows = await db.all<RunRow>(sql`
    SELECT ${RUN_COLUMNS} FROM workflow_runs AS r JOIN workflows AS w ON w.id = r.workflow_id
    WHERE r.workflow_id = ${ruleId} AND r.is_dry_run = ${kind === "dry" ? 1 : 0} ORDER BY ${kind === "dry" ? sql`json_extract(r.event, '$.at') ASC` : sql`r.started_at DESC`}, r.id LIMIT ${limit}`);
  const names = await namesForRuns(db, rows);
  return rows.map((row) => runView(actor, row, names));
}

// ───────────────────────────────────────────────────────────────── notices

const heldAudiences = (actor: Actor): NoticeAudience[] => NOTICE_AUDIENCES.filter((audience) => can(actor, audience));
const actorIdOf = (actor: Actor) => (actor.kind === "employee" ? actor.id : null);

const noticeWhere = (actor: Actor, audiences: readonly NoticeAudience[], now: number) => sql`
  r.is_dry_run = 0 AND r.started_at >= ${now - NOTICE_DAYS * DAY_MS}
  AND EXISTS (SELECT 1 FROM json_each(r.actions_log) AS a WHERE json_extract(a.value, '$.type') = 'notify' AND json_extract(a.value, '$.outcome') = 'done'
              AND json_extract(a.value, '$.detail.audience') IN (${sql.join(
                audiences.map((audience) => sql`${audience}`),
                sql`, `,
              )}))
  AND NOT EXISTS (SELECT 1 FROM audit_events AS e WHERE e.entity_type = 'workflow_run' AND e.entity_id = r.id AND e.action = 'automation.notice.seen' AND e.actor_kind = 'employee' AND e.actor_id = ${actorIdOf(actor) ?? ""})`;

/** One notice as the front page shows it (the audience it reached this employee through). */
function noticeOf(actor: Actor, row: RunRow, audiences: readonly NoticeAudience[]): NoticeView {
  const view = runView(actor, row, new Map());
  const entry = parse<ActionLogEntry[]>(row.actionsLog, []).find((item) => item.type === "notify" && item.outcome === "done" && audiences.includes(item.detail?.audience as NoticeAudience));
  return { runId: row.id, at: view.at, ruleId: row.workflowId, ruleName: row.ruleName, audience: (entry?.detail?.audience as NoticeAudience) ?? audiences[0], event: view.event };
}

/** The notices of the last NOTICE_DAYS days for the permissions this employee holds, not yet marked seen by them. */
export async function listNotices(db: Db, actor: Actor, now: number, limit = 30): Promise<NoticeView[]> {
  const audiences = heldAudiences(actor);
  if (!audiences.length || actor.kind !== "employee") return [];
  const rows = await db.all<RunRow>(sql`SELECT ${RUN_COLUMNS} FROM workflow_runs AS r JOIN workflows AS w ON w.id = r.workflow_id WHERE ${noticeWhere(actor, audiences, now)} ORDER BY r.started_at DESC, r.id DESC LIMIT ${limit}`);
  return rows.map((row) => noticeOf(actor, row, audiences));
}

export type NoticeGroup = { ruleId: string; ruleName: string; count: number; latestAt: number; audience: NoticeAudience; items: NoticeView[] };

/** Notices marked seen per batch by "mark all as seen". */
const SEEN_BATCH = 25;

/**
 * The notices for this employee grouped by rule (the front page): how many — EVERY one, so the groups add up to the
 * bell's `countNotices` — the latest three, newest rule first.
 */
export async function listNoticeGroups(db: Db, actor: Actor, now: number): Promise<NoticeGroup[]> {
  const audiences = heldAudiences(actor);
  if (!audiences.length || actor.kind !== "employee") return [];
  const [groups, latest] = await Promise.all([
    db.all<{ ruleId: string; ruleName: string; n: number; latestAt: number }>(sql`
      SELECT r.workflow_id AS ruleId, w.name AS ruleName, count(*) AS n, max(r.started_at) AS latestAt FROM workflow_runs AS r JOIN workflows AS w ON w.id = r.workflow_id
      WHERE ${noticeWhere(actor, audiences, now)} GROUP BY r.workflow_id ORDER BY latestAt DESC, r.workflow_id`),
    db.all<RunRow>(sql`
      SELECT * FROM (SELECT ${RUN_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY r.workflow_id ORDER BY r.started_at DESC, r.id DESC) AS place
                     FROM workflow_runs AS r JOIN workflows AS w ON w.id = r.workflow_id WHERE ${noticeWhere(actor, audiences, now)})
      WHERE place <= 3 ORDER BY startedAt DESC, id DESC`),
  ]);
  const items = new Map<string, NoticeView[]>();
  for (const row of latest) items.set(row.workflowId, [...(items.get(row.workflowId) ?? []), noticeOf(actor, row, audiences)]);
  return groups.map((group) => {
    const first = items.get(group.ruleId) ?? [];
    return { ruleId: group.ruleId, ruleName: group.ruleName, count: num(group.n), latestAt: num(group.latestAt), audience: first[0]?.audience ?? audiences[0], items: first };
  });
}

const seenIdOf = async (runId: string, employeeId: string) => `aud_seen_${(await sha256Hex(`automation.notice.seen|${runId}|${employeeId}`)).slice(0, 24)}`;

/** Marks EVERY notice of one rule seen for this employee (one audit event per notice; ones already seen are kept). */
export async function markRuleNoticesSeen(db: Db, actor: Actor, raw: { ruleId?: unknown }, now: number): Promise<{ marked: number }> {
  const audiences = heldAudiences(actor);
  if (!audiences.length || actor.kind !== "employee") throw new AppError("forbidden", 403);
  const ruleId = typeof raw.ruleId === "string" ? raw.ruleId : "";
  if (!/^wfl_[a-z0-9]{10,40}$/.test(ruleId)) throw invalid({ ruleId: "invalid" });
  const notices = await db.all<{ id: string }>(sql`SELECT r.id AS id FROM workflow_runs AS r WHERE ${noticeWhere(actor, audiences, now)} AND r.workflow_id = ${ruleId} ORDER BY r.started_at DESC, r.id DESC`);
  if (!notices.length) throw new AppError("notice_unknown", 404);
  let marked = 0;
  for (let at = 0; at < notices.length; at += SEEN_BATCH) {
    const chunk = notices.slice(at, at + SEEN_BATCH);
    // the ids first: a query builder returned from an async callback would run on its own, outside the batch
    const ids = await Promise.all(chunk.map((notice) => seenIdOf(notice.id, actor.id)));
    const statements = chunk.map((notice, index) => auditStatement(db, { actor, id: ids[index], action: "automation.notice.seen", entityType: "workflow_run", entityId: notice.id, at: now }));
    try {
      await runBatch(db, statements);
      marked += chunk.length;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // marked meanwhile (another tab): one by one, the ones already seen are replays
      for (const notice of chunk) if (!(await markNoticeSeen(db, actor, { runId: notice.id }, now)).replayed) marked++;
    }
  }
  return { marked };
}

/** Notices waiting for this employee (the admin bell's count), or null without a notice permission. */
export async function countNotices(db: Db, actor: Actor, now: number): Promise<number | null> {
  const audiences = heldAudiences(actor);
  if (!audiences.length || actor.kind !== "employee") return null;
  const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM workflow_runs AS r WHERE ${noticeWhere(actor, audiences, now)}`);
  return num(rows[0]?.n);
}

/** Marks one notice seen for this employee (an audit event; a second mark is a replay). */
export async function markNoticeSeen(db: Db, actor: Actor, raw: { runId?: unknown }, now: number): Promise<{ replayed: boolean }> {
  const audiences = heldAudiences(actor);
  if (!audiences.length || actor.kind !== "employee") throw new AppError("forbidden", 403);
  const runId = typeof raw.runId === "string" ? raw.runId : "";
  if (!/^wfr_[a-z0-9]{10,40}$/.test(runId)) throw invalid({ runId: "invalid" });
  const rows = await db.all<{ actionsLog: unknown }>(sql`SELECT actions_log AS actionsLog FROM workflow_runs WHERE id = ${runId} AND is_dry_run = 0`);
  const entries = parse<ActionLogEntry[]>(rows[0]?.actionsLog, []);
  const mine = entries.some((entry) => entry.type === "notify" && entry.outcome === "done" && audiences.includes(entry.detail?.audience as NoticeAudience));
  if (!mine) throw new AppError("notice_unknown", 404);
  const id = await seenIdOf(runId, actor.id);
  try {
    await runBatch(db, [auditStatement(db, { actor, id, action: "automation.notice.seen", entityType: "workflow_run", entityId: runId, at: now })]);
  } catch (error) {
    if (isUniqueViolation(error)) return { replayed: true };
    throw error;
  }
  return { replayed: false };
}
