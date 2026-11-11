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
import { RETENTION_DAYS } from "~/server/jobs.server";
import { UNUSED_TOPUP_PROOF_MAX_AGE_SEC } from "~/server/services/account/topups.server";
import { RECOMMENDATION_EVENT_RETENTION_DAYS } from "~/server/services/recommendations.server";
import { ASSISTANT_RETENTION_DAYS } from "~/server/services/support/assistant.server";
import { TRADE_IN_DRAFT_MAX_AGE_SEC } from "~/server/services/tradein.server";
import { fingerprintOf, membersFingerprintOf } from "./roles.server";
import { assertAny } from "./shared.server";
import { ACCESS_REVIEW_OUTCOMES } from "./types";

const DAY_SEC = 24 * 60 * 60;

export type RetentionRow = { key: string; days: number; after: "end" | "created" | "expiry" };

export type RetentionView = {
  rows: RetentionRow[];
  lastRun: { at: number; status: string; stats: Record<string, unknown> | null; error: string | null } | null;
};

export async function retentionView(db: Db, actor: Actor): Promise<RetentionView> {
  assertAny(actor, ["security.retention.manage", "security.access_review.perform", "audit.read"]);
  const run = await db.select().from(jobRuns).where(eq(jobRuns.job, "retention")).orderBy(desc(jobRuns.startedAt)).limit(1).get();
  return {
    rows: [
      { key: "sessions", days: RETENTION_DAYS.sessions, after: "end" },
      { key: "otpCodes", days: RETENTION_DAYS.otpCodes, after: "expiry" },
      { key: "authEvents", days: RETENTION_DAYS.authEvents, after: "created" },
      { key: "outbox", days: RETENTION_DAYS.outbox, after: "created" },
      { key: "jobRuns", days: RETENTION_DAYS.jobRuns, after: "created" },
      { key: "recommendationEvents", days: RECOMMENDATION_EVENT_RETENTION_DAYS, after: "created" },
      // the purges' own constants (seconds), so this page never drifts from what the nightly job deletes
      { key: "tradeInDrafts", days: TRADE_IN_DRAFT_MAX_AGE_SEC / DAY_SEC, after: "created" },
      { key: "topupProofs", days: UNUSED_TOPUP_PROOF_MAX_AGE_SEC / DAY_SEC, after: "created" },
      { key: "assistantSessions", days: ASSISTANT_RETENTION_DAYS, after: "created" },
    ],
    lastRun: run ? { at: run.startedAt, status: run.status, stats: run.stats ?? null, error: run.error } : null,
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
