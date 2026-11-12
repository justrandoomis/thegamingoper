/**
 * Admin module 19 — the module's front page (what waits for this employee, the figures each may see) and the counts
 * the admin bell can show (`automationQueueCounts`, for the shell owner):
 *
 *   suggestions      open reorder suggestions — for automation.suggestion.approve (→ /admin/automation/suggestions)
 *   rulesToActivate  rules whose fresh dry run waits for someone to switch them on, never the author of their version
 *                    — for automation.workflow.activate without a branch limit (→ /admin/automation/rules?ready=1,
 *                    which lists exactly those)
 *   notices          notices of the last 14 days for one of the employee's permissions, not yet marked seen by them
 *                    (→ /admin/automation#notices)
 * Each is null when it does not concern the employee. The front page's "failed in 24 hours" and "runs in 24 hours"
 * open /admin/automation/runs with the same window (AUTOMATION_LINKS).
 */
import { sql } from "drizzle-orm";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { DAY_MS } from "./catalog";
import { countNotices, listNoticeGroups, type NoticeGroup } from "./log.server";
import { countActivatable } from "./rules.server";
import { automationAccess, type AutomationAccess } from "./shared.server";
import { AUTOMATION_LINKS } from "./types";

const num = (value: unknown) => Number(value ?? 0);

export type AutomationOverview = {
  access: AutomationAccess;
  waiting: { suggestions: number | null; activatable: number | null; failedRuns: number | null };
  notices: NoticeGroup[] | null;
  figures: {
    rules: { active: number; dry_run: number; draft: number; paused: number } | null;
    runs24h: number | null;
    tasks7d: number | null;
    lastRunAt: number | null;
    lastJobAt: number | null;
    openSuggestions: number | null;
  };
};

export async function automationOverview(db: Db, actor: Actor, now: number): Promise<AutomationOverview> {
  const access = automationAccess(actor);
  const [ruleCounts, runs, failed, tasks, lastJob, suggestions, activatable, notices] = await Promise.all([
    access.rules ? db.all<{ status: string; n: number }>(sql`SELECT status, count(*) AS n FROM workflows GROUP BY status`) : Promise.resolve(null),
    access.rules ? db.all<{ n: number; last: number | null }>(sql`SELECT count(*) AS n, max(started_at) AS last FROM workflow_runs WHERE is_dry_run = 0 AND started_at >= ${now - DAY_MS}`) : Promise.resolve(null),
    access.rules ? db.all<{ n: number }>(sql`SELECT count(*) AS n FROM workflow_runs WHERE is_dry_run = 0 AND status = 'failed' AND started_at >= ${now - DAY_MS}`) : Promise.resolve(null),
    access.rules ? db.all<{ n: number }>(sql`SELECT count(*) AS n FROM staff_tasks WHERE created_by = 'system:automation.run' AND created_at >= ${now - 7 * DAY_MS}`) : Promise.resolve(null),
    access.rules || access.suggestions ? db.all<{ at: number | null }>(sql`SELECT max(started_at) AS at FROM job_runs WHERE job = 'automation.run'`) : Promise.resolve(null),
    access.suggestions ? db.all<{ n: number }>(sql`SELECT count(*) AS n FROM reorder_suggestions WHERE status = 'open'`) : Promise.resolve(null),
    countActivatable(db, actor, now),
    listNoticeGroups(db, actor, now),
  ]);
  const byStatus = new Map((ruleCounts ?? []).map((row) => [row.status, num(row.n)]));
  return {
    access,
    waiting: {
      suggestions: access.approve && suggestions ? num(suggestions[0]?.n) : null,
      activatable,
      failedRuns: failed ? num(failed[0]?.n) : null,
    },
    notices: can(actor, "automation.workflow.read") || can(actor, "automation.suggestion.read") || can(actor, "automation.anomaly.read") ? notices : null,
    figures: {
      rules: ruleCounts ? { active: byStatus.get("active") ?? 0, dry_run: byStatus.get("dry_run") ?? 0, draft: byStatus.get("draft") ?? 0, paused: byStatus.get("paused") ?? 0 } : null,
      runs24h: runs ? num(runs[0]?.n) : null,
      tasks7d: tasks ? num(tasks[0]?.n) : null,
      lastRunAt: runs && runs[0]?.last ? num(runs[0].last) : null,
      lastJobAt: lastJob && lastJob[0]?.at ? num(lastJob[0].at) : null,
      openSuggestions: suggestions ? num(suggestions[0]?.n) : null,
    },
  };
}

/** The admin bell's counts for this employee (each null when it does not concern them). */
export async function automationQueueCounts(db: Db, actor: Actor, now: number): Promise<{ suggestions: number | null; rulesToActivate: number | null; notices: number | null }> {
  const [suggestions, rulesToActivate, notices] = await Promise.all([
    can(actor, "automation.suggestion.approve") && can(actor, "automation.suggestion.read") ? db.all<{ n: number }>(sql`SELECT count(*) AS n FROM reorder_suggestions WHERE status = 'open'`) : Promise.resolve(null),
    countActivatable(db, actor, now),
    countNotices(db, actor, now),
  ]);
  return { suggestions: suggestions ? num(suggestions[0]?.n) : null, rulesToActivate, notices };
}

/** Where each count of the bell leads — the list there shows exactly what the count counted (AUTOMATION_LINKS). */
export const QUEUE_HREFS = {
  suggestions: AUTOMATION_LINKS.suggestions,
  rulesToActivate: AUTOMATION_LINKS.rulesToActivate,
  notices: AUTOMATION_LINKS.notices,
} as const;

