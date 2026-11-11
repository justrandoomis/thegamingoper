/**
 * Admin 20.05 — backups, restore tests and the recovery plan (security.backup.manage).
 *
 * What exists, honestly: the database is Cloudflare D1, whose Time Travel keeps a point-in-time history (30 days on the
 * Workers Paid plan, 7 on the free plan) without anything to run; a restore is done by the owner or the lead with
 * wrangler (`wrangler d1 time-travel info|restore`), never from this admin — there is no "back up now" key, because the
 * app cannot make or check a backup itself. Uploaded files live in KV, which has NO point-in-time history: the plan says
 * so. What this module adds is the evidence: each restore test (when, how, into what, how long, passed or failed, what
 * was checked) is recorded as an audit event — append-only, sealed with the rest of the trail — and the page says when
 * the last one passed and when the next is due.
 */
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "~/lib/ids";
import { assertCan, type Actor } from "~/server/actor";
import { auditRow } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, jobRuns } from "~/server/db/schema";
import { isUniqueViolation } from "~/server/db/tx.server";
import { AppError } from "~/server/errors";
import { DAY_MS, RESTORE_METHODS, RESTORE_RESULTS, RESTORE_TEST_INTERVAL_DAYS, baghdadDay, dayOf, latinDigits, type RestoreMethod, type RestoreResult } from "./types";

export const RESTORE_TEST_ACTION = "security.backup.restore_test";

export type RestoreTest = {
  id: string;
  at: number;
  by: string | null;
  testedOn: string;
  method: RestoreMethod;
  pointInTime: string | null;
  restoredTo: string;
  durationMinutes: number | null;
  result: RestoreResult;
  checks: string;
  notes: string | null;
};

export type BackupsView = {
  tests: RestoreTest[];
  lastPassed: RestoreTest | null;
  /** Days since the last passed test (null: never). */
  ageDays: number | null;
  due: boolean;
  /** The daily seal of the audit trail (its head hash goes to the Workers logs for off-site copies). */
  lastSeal: { at: number; status: string } | null;
};

function testOf(row: typeof auditEvents.$inferSelect): RestoreTest | null {
  const after = row.after as Partial<RestoreTest> | null;
  if (!after || typeof after.testedOn !== "string") return null;
  return {
    id: row.id,
    at: row.at,
    by: row.actorLabel,
    testedOn: after.testedOn,
    method: (RESTORE_METHODS as readonly string[]).includes(after.method ?? "") ? (after.method as RestoreMethod) : "time_travel_new_db",
    pointInTime: after.pointInTime ?? null,
    restoredTo: after.restoredTo ?? "",
    durationMinutes: typeof after.durationMinutes === "number" ? after.durationMinutes : null,
    result: after.result === "failed" ? "failed" : "passed",
    checks: after.checks ?? "",
    notes: row.reason,
  };
}

export async function backupsView(db: Db, actor: Actor, now: number): Promise<BackupsView> {
  assertCan(actor, "security.backup.manage");
  const [rows, seal] = await Promise.all([
    db.select().from(auditEvents).where(eq(auditEvents.action, RESTORE_TEST_ACTION)).orderBy(desc(auditEvents.seq)).limit(50),
    db.select({ at: jobRuns.startedAt, status: jobRuns.status }).from(jobRuns).where(eq(jobRuns.job, "audit.seal")).orderBy(desc(jobRuns.startedAt)).limit(1).get(),
  ]);
  const tests = rows.map(testOf).filter((test): test is RestoreTest => test !== null);
  const lastPassed = tests.find((test) => test.result === "passed") ?? null;
  const ageDays = lastPassed ? Math.floor((now - Date.parse(`${lastPassed.testedOn}T12:00:00Z`)) / DAY_MS) : null;
  return { tests, lastPassed, ageDays, due: ageDays === null || ageDays > RESTORE_TEST_INTERVAL_DAYS, lastSeal: seal ?? null };
}

const text = (max: number) => z.string().trim().max(max, "too_long");
const RestoreTestInput = z.object({
  testedOn: z.string({ error: "required" }).transform((value, ctx) => {
    const day = dayOf(value);
    if (!day) {
      ctx.addIssue({ code: "custom", message: value.trim() ? "invalid" : "required" });
      return z.NEVER;
    }
    return day;
  }),
  method: z.enum(RESTORE_METHODS, { error: "required" }),
  pointInTime: text(40).optional(),
  restoredTo: z.string({ error: "required" }).trim().min(2, "required").max(120, "too_long"),
  durationMinutes: z.preprocess((value) => (typeof value === "string" ? (value.trim() === "" ? undefined : Number(latinDigits(value.trim()))) : value), z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(10_000, "too_big").optional()),
  result: z.enum(RESTORE_RESULTS, { error: "required" }),
  checks: z.string({ error: "required" }).trim().min(10, "too_short").max(2000, "too_long"),
  notes: text(1000).optional(),
  idempotencyKey: z.string().trim().min(8, "invalid").max(120, "invalid"),
});

/** Records a restore test as evidence (an append-only audit event). A resubmitted form records it once. */
export async function recordRestoreTest(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string; replayed: boolean }> {
  assertCan(actor, "security.backup.manage");
  const input = RestoreTestInput.parse(raw);
  if (input.testedOn > baghdadDay(now)) throw new AppError("restore_test_future", 400, { fields: { testedOn: "restore_test_future" } });
  const id = `aud_rt_${(await sha256Hex(`restore-test:${input.idempotencyKey}`)).slice(0, 26)}`;
  const row = auditRow({
    id,
    actor,
    action: RESTORE_TEST_ACTION,
    entityType: "backup",
    entityId: input.testedOn,
    summary: `${input.method} → ${input.restoredTo}`,
    after: { testedOn: input.testedOn, method: input.method, pointInTime: input.pointInTime || null, restoredTo: input.restoredTo, durationMinutes: input.durationMinutes ?? null, result: input.result, checks: input.checks },
    reason: input.notes || null,
    at: now,
  });
  try {
    await db.insert(auditEvents).values(row);
  } catch (error) {
    if (isUniqueViolation(error)) return { id, replayed: true };
    throw error;
  }
  return { id, replayed: false };
}

/** For the module's front page: days since the last passed restore test, and whether one is due. */
export async function restoreTestAge(db: Db, now: number): Promise<{ ageDays: number | null; due: boolean }> {
  const rows = await db.all<{ after: string | null }>(sql`SELECT after FROM audit_events WHERE action = ${RESTORE_TEST_ACTION} ORDER BY seq DESC LIMIT 50`);
  for (const row of rows) {
    const after = (row.after ? JSON.parse(row.after) : {}) as { testedOn?: string; result?: string };
    if (after.result === "passed" && typeof after.testedOn === "string") {
      const ageDays = Math.floor((now - Date.parse(`${after.testedOn}T12:00:00Z`)) / DAY_MS);
      return { ageDays, due: ageDays > RESTORE_TEST_INTERVAL_DAYS };
    }
  }
  return { ageDays: null, due: true };
}
