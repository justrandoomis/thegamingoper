/**
 * Admin module 23 — the front page (what waits for a person, the figures, per permission), the counts the admin bell
 * may show (`opsQueueCounts`, for the shell owner), and the backup monitor (23.04).
 *
 * Backups (23.04): the database is Cloudflare D1, whose Time Travel keeps its history without anything to run; restores
 * are done with wrangler by the owner, never from the app, and module 20 records the restore TESTS as evidence at
 * /admin/security/backups. This module does not duplicate that: it shows the age of the last passed test, whether one
 * is due, and the daily seal of the audit trail (whose head hash the Worker writes to its logs, the off-site anchor),
 * and links to module 20 for whoever may record a test there.
 */
import { desc, eq } from "drizzle-orm";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { auditSeals, jobRuns } from "~/server/db/schema";
import { restoreTestAge } from "~/server/services/admin/security/backups.server";
import { RESTORE_TEST_INTERVAL_DAYS, TIME_TRAVEL_DAYS } from "~/server/services/admin/security/types";
import { findingCounts, lastCheckRun, type LastCheckRun } from "./consistency.server";
import { incidentCounts } from "./incidents.server";
import { jobsNeedingAttention, jobsOverview, outboxOverview, type OutboxOverview } from "./job-monitor.server";
import { opsAccess, type OpsAccess } from "./shared.server";
import { errorCounts, perfCounts } from "./telemetry.server";
import type { JobView } from "./types";

export type BackupsMonitor = {
  restore: { ageDays: number | null; due: boolean; intervalDays: number };
  seal: { at: number; status: string; error: string | null } | null;
  lastSeal: { createdAt: number; toSeq: number } | null;
  timeTravelDays: number;
  /** May record a restore test at /admin/security/backups (module 20). */
  canRecord: boolean;
};

/** 23.04 — how fresh the evidence is (ops.backup.read). Recording a test stays with module 20. */
export async function backupsMonitor(db: Db, actor: Actor, now: number): Promise<BackupsMonitor> {
  assertCan(actor, "ops.backup.read");
  const [restore, seal, lastSeal] = await Promise.all([
    restoreTestAge(db, now),
    db.select({ at: jobRuns.startedAt, status: jobRuns.status, error: jobRuns.error }).from(jobRuns).where(eq(jobRuns.job, "audit.seal")).orderBy(desc(jobRuns.startedAt)).limit(1).get(),
    db.select({ createdAt: auditSeals.createdAt, toSeq: auditSeals.toSeq }).from(auditSeals).orderBy(desc(auditSeals.toSeq)).limit(1).get(),
  ]);
  return {
    restore: { ...restore, intervalDays: RESTORE_TEST_INTERVAL_DAYS },
    seal: seal ? { at: seal.at, status: seal.status, error: seal.error } : null,
    lastSeal: lastSeal ?? null,
    timeTravelDays: TIME_TRAVEL_DAYS,
    canRecord: can(actor, "security.backup.manage"),
  };
}

export type OpsOverview = {
  access: OpsAccess;
  jobs: { attention: JobView[]; total: number; healthy: number; nextDaily: number | null; nextFrequent: number | null } | null;
  outbox: OutboxOverview | null;
  findings: { active: number; critical: number; warning: number; info: number; unassignedCritical: number; lastRun: LastCheckRun } | null;
  incidents: { active: number; mine: number; overdue: number; mineOverdue: number } | null;
  errors: { open: number; seen24h: number } | null;
  performance: { slow: number; failed: number } | null;
  backups: BackupsMonitor | null;
};

/** Everything the front page shows, each part only for an employee who may see it (null otherwise). */
export async function opsOverview(db: Db, actor: Actor, now: number): Promise<OpsOverview> {
  const access = opsAccess(actor);
  const [jobs, outbox, findings, lastRun, incidents, errors, performance, backups] = await Promise.all([
    access.jobs ? jobsOverview(db, actor, now) : Promise.resolve(null),
    access.jobs ? outboxOverview(db, actor) : Promise.resolve(null),
    findingCounts(db, actor),
    access.consistency ? lastCheckRun(db) : Promise.resolve(null),
    incidentCounts(db, actor, now),
    errorCounts(db, actor, now),
    perfCounts(db, actor, now),
    access.backups ? backupsMonitor(db, actor, now) : Promise.resolve(null),
  ]);
  return {
    access,
    jobs: jobs
      ? {
          attention: jobsNeedingAttention(jobs.jobs),
          total: jobs.jobs.filter((job) => job.known).length,
          healthy: jobs.jobs.filter((job) => job.known && (job.health === "ok" || job.health === "skipped" || job.health === "running")).length,
          nextDaily: jobs.crons.find((cron) => cron.cron === "30 0 * * *")?.nextAt ?? null,
          nextFrequent: jobs.crons.find((cron) => cron.cron === "*/5 * * * *")?.nextAt ?? null,
        }
      : null,
    outbox,
    findings: findings ? { ...findings, lastRun } : null,
    incidents,
    errors,
    performance,
    backups,
  };
}

/**
 * What the admin bell may count for this employee (for shell/queues.server.ts; each null when it does not concern them):
 *   criticalFindings  open critical findings nobody has yet (within the employee's branch)  ops.consistency.resolve  → /admin/ops/consistency?severity=critical&assignee=none
 *   failingJobs       jobs whose last run failed, is stuck, or late                         ops.job.run              → /admin/ops/jobs?view=attention
 *   overdueIncidents  open incidents past their target date (a manager acts on any of them) ops.incident.manage      → /admin/ops/incidents?view=overdue
 * Each count is the number of rows its link lists for that employee.
 */
export async function opsQueueCounts(db: Db, actor: Actor, now: number): Promise<{ criticalFindings: number | null; failingJobs: number | null; overdueIncidents: number | null }> {
  const access = opsAccess(actor);
  const [findings, jobs, incidents] = await Promise.all([
    access.resolveFindings ? findingCounts(db, actor) : Promise.resolve(null),
    access.runJobs ? jobsOverview(db, actor, now) : Promise.resolve(null),
    access.manageIncidents ? incidentCounts(db, actor, now) : Promise.resolve(null),
  ]);
  return {
    criticalFindings: findings ? findings.unassignedCritical : null,
    failingJobs: jobs ? jobsNeedingAttention(jobs.jobs).length : null,
    overdueIncidents: incidents ? incidents.overdue : null,
  };
}
