/**
 * Admin 20.07 — the retention and deletion policy as the code runs it, and the periodic access review.
 *
 * RETENTION (read-only): the periods are the scheduled jobs' constants (app/server/jobs.server.ts RETENTION_DAYS and
 * the areas' own purges), run every night by the `retention` job; changing one is a code change, so the page shows them
 * and the last run's counts, never a form that would pretend to change them. What is never deleted is listed too:
 * the audit trail, the ledgers and the order history are append-only by design.
 *
 * ACCESS REVIEW (security.access_review.perform): per role, a person confirms that its permissions and members are
 * still right (or records what must change), with a note. Each review is an audit event that keeps the fingerprint of
 * the permissions and the member list it saw; a role is due again ACCESS_REVIEW_INTERVAL_DAYS after its last review.
 */
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, type Actor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { employeeRoles, employees, jobRuns, rolePermissions, roles } from "~/server/db/schema";
import { AppError, notFound } from "~/server/errors";
import { RETENTION_DAYS, type JobName } from "~/server/jobs.server";
import { UNUSED_TOPUP_PROOF_MAX_AGE_SEC } from "~/server/services/account/topups.server";
import { RECOMMENDATION_EVENT_RETENTION_DAYS } from "~/server/services/recommendations.server";
import { TELEMETRY_RETENTION_DAYS } from "~/server/services/admin/ops/types";
import { ASSISTANT_RETENTION_DAYS } from "~/server/services/support/assistant.server";
import { TRADE_IN_DRAFT_MAX_AGE_SEC } from "~/server/services/tradein.server";
import { fingerprintOf, membersFingerprintOf } from "./roles.server";
import { assertAny } from "./shared.server";
import { ACCESS_REVIEW_OUTCOMES } from "./types";

const DAY_SEC = 24 * 60 * 60;

export type RetentionRow = {
  key: string;
  days: number;
  after: "end" | "created" | "expiry";
  /** The scheduled job that deletes it (the nightly `retention` job, or the purge's own job since 2026-11-11). */
  job: RetentionJob;
  /** What that job's last run deleted of it (null: never ran here, or its count is not in the run's stats). */
  deleted: number | null;
};

/** The jobs that delete data on this page's periods: the nightly retention job and the purges that run on their own. */
export const RETENTION_JOBS = ["retention", "recommendations.events.purge", "tradein.drafts.purge", "ops.telemetry.purge"] as const satisfies readonly JobName[];
export type RetentionJob = (typeof RETENTION_JOBS)[number];

export type RetentionRun = { job: RetentionJob; at: number; status: string; error: string | null };

export type RetentionView = {
  rows: RetentionRow[];
  /** The nightly retention job's last run (kept for the existing card). */
  lastRun: { at: number; status: string; stats: Record<string, unknown> | null; error: string | null } | null;
  /** The last run of every job on this page, in RETENTION_JOBS order (a job that never ran here is left out). */
  runs: RetentionRun[];
};

const countIn = (stats: Record<string, unknown> | null | undefined, ...keys: string[]): number | null => {
  if (!stats) return null;
  let total = 0;
  for (const key of keys) {
    const value = stats[key];
    if (typeof value !== "number") return null;
    total += value;
  }
  return total;
};

/**
 * The periods and what their purges deleted last time. Follow-up 2026-11-12: every count came from the `retention`
 * run's stats, but the recommendation-signal and trade-in-draft purges (and the ops telemetry purge) have their own
 * jobs since 2026-11-11 — those rows never showed a count. Each row now reads the last run of the job that deletes it.
 */
export async function retentionView(db: Db, actor: Actor): Promise<RetentionView> {
  assertAny(actor, ["security.retention.manage", "security.access_review.perform", "audit.read"]);
  const lastRuns = await Promise.all(RETENTION_JOBS.map((job) => db.select().from(jobRuns).where(eq(jobRuns.job, job)).orderBy(desc(jobRuns.startedAt)).limit(1).get()));
  const runOf = new Map(RETENTION_JOBS.map((job, index) => [job, lastRuns[index]] as const));
  const statsOf = (job: RetentionJob) => (runOf.get(job)?.stats ?? null) as Record<string, unknown> | null;
  const nightly = statsOf("retention");
  const run = runOf.get("retention");
  return {
    rows: [
      { key: "sessions", days: RETENTION_DAYS.sessions, after: "end", job: "retention", deleted: countIn(nightly, "customerSessions", "employeeSessions") },
      { key: "otpCodes", days: RETENTION_DAYS.otpCodes, after: "expiry", job: "retention", deleted: countIn(nightly, "otpCodes") },
      { key: "authEvents", days: RETENTION_DAYS.authEvents, after: "created", job: "retention", deleted: countIn(nightly, "authEvents") },
      { key: "outbox", days: RETENTION_DAYS.outbox, after: "created", job: "retention", deleted: countIn(nightly, "outbox") },
      { key: "jobRuns", days: RETENTION_DAYS.jobRuns, after: "created", job: "retention", deleted: countIn(nightly, "jobRuns") },
      { key: "recommendationEvents", days: RECOMMENDATION_EVENT_RETENTION_DAYS, after: "created", job: "recommendations.events.purge", deleted: countIn(statsOf("recommendations.events.purge"), "deleted") },
      // the purges' own constants (seconds), so this page never drifts from what the nightly job deletes
      { key: "tradeInDrafts", days: TRADE_IN_DRAFT_MAX_AGE_SEC / DAY_SEC, after: "created", job: "tradein.drafts.purge", deleted: countIn(statsOf("tradein.drafts.purge"), "deleted") },
      { key: "topupProofs", days: UNUSED_TOPUP_PROOF_MAX_AGE_SEC / DAY_SEC, after: "created", job: "retention", deleted: countIn(nightly, "topupProofs") },
      { key: "assistantSessions", days: ASSISTANT_RETENTION_DAYS, after: "created", job: "retention", deleted: countIn(nightly, "assistantSessions") },
      { key: "opsTelemetry", days: TELEMETRY_RETENTION_DAYS, after: "created", job: "ops.telemetry.purge", deleted: countIn(statsOf("ops.telemetry.purge"), "errors", "perf") },
    ],
    lastRun: run ? { at: run.startedAt, status: run.status, stats: run.stats ?? null, error: run.error } : null,
    runs: RETENTION_JOBS.flatMap((job) => {
      const row = runOf.get(job);
      return row ? [{ job, at: row.startedAt, status: row.status, error: row.error }] : [];
    }),
  };
}

const ReviewInput = z.object({
  roleId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid"),
  outcome: z.enum(ACCESS_REVIEW_OUTCOMES, { error: "required" }),
  note: z.string({ error: "required" }).trim().min(3, "reason_required").max(1000, "too_long"),
  /** The role's permission fingerprint the reviewer saw (roles.server fingerprintOf). */
  fingerprint: z.string().max(20_000),
  /** The members the reviewer saw (roles.server membersFingerprintOf): a review confirms who holds the role too. */
  members: z.string({ error: "required" }).max(40_000),
});

/** Records an access review of one role (what it grants and who holds it, as the reviewer saw it). */
export async function performAccessReview(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string }> {
  assertCan(actor, "security.access_review.perform");
  const input = ReviewInput.parse(raw);
  const role = await db.select({ id: roles.id, key: roles.key }).from(roles).where(eq(roles.id, input.roleId)).get();
  if (!role) throw notFound("role");
  const [grants, members] = await Promise.all([
    db.select({ permission: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, role.id)),
    db.select({ id: employees.id, status: employees.status }).from(employeeRoles).innerJoin(employees, eq(employees.id, employeeRoles.employeeId)).where(eq(employeeRoles.roleId, role.id)),
  ]);
  const stored = grants.map((grant) => grant.permission);
  // the review is of what the reviewer saw — its permissions AND its members: a role changed meanwhile (someone given it
  // after the page was opened, too) is reviewed again from its new state
  if (fingerprintOf(stored) !== input.fingerprint || membersFingerprintOf(members.map((member) => member.id)) !== input.members) throw new AppError("role_changed", 409);
  const id = await audit(db, {
    actor,
    action: "security.access_review.complete",
    entityType: "role",
    entityId: role.id,
    summary: role.key,
    after: { outcome: input.outcome, permissions: stored.includes("*") ? -1 : stored.length, members: members.length, activeMembers: members.filter((member) => member.status === "active").length, memberIds: members.map((member) => member.id).sort(), fingerprint: input.fingerprint.slice(0, 4000) },
    reason: input.note,
    at: now,
  });
  return { id };
}

/** For the module's front page: roles whose access review is due (never reviewed, or longer ago than the interval). */
export async function reviewsDue(db: Db, now: number, intervalDays: number): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM roles r WHERE NOT EXISTS (
      SELECT 1 FROM audit_events a WHERE a.action = 'security.access_review.complete' AND a.entity_type = 'role' AND a.entity_id = r.id AND a.at > ${now - intervalDays * 86_400_000})`);
  return Number(rows[0]?.n ?? 0);
}
