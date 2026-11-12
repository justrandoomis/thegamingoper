/**
 * Admin 23.03 — background jobs and the message queue.
 *
 * Reads what the scheduler already records: every run of every job is a `job_runs` row (app/server/jobs.server.ts —
 * read only here; the job list and the schedules come from there, so a job added to it shows up without a change in
 * this module). For each job: its cron (the same expressions wrangler.jsonc triggers — a test keeps them equal), when
 * it is due next, its last run, its last success, failures over 7 days, the failures in a row, and whether it is late
 * (its trigger stopped firing) or stuck (a run that never recorded its end). The outbox is read the same way: what is
 * held for lack of a provider, queued, sent or failed — recipients masked, payloads never read.
 *
 * One action: run a job now (ops.job.run) — the same code the cron runs (`runJob`, origin "manual", the employee as
 * `triggered_by`), with a reason and an idempotency key (a resubmitted form runs it once), refused while a run of the
 * same job is in progress, and audited (`ops.job.run`). What the run would change is shown first (`jobPreview`).
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "~/lib/ids";
import { maskPhone, normalizeIraqPhone } from "~/lib/phone";
import { assertCan, type Actor } from "~/server/actor";
import { auditRow } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, jobRuns, orders, outbox, products, stockReservations } from "~/server/db/schema";
import { expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, conflict, notFound } from "~/server/errors";
import { CONSISTENCY_CHECKS, JOB_NAMES, RETENTION_DAYS, SCHEDULES, runJob, type JobName, type ScheduledJobsEnv } from "~/server/jobs.server";
import { RECOMMENDATION_EVENT_RETENTION_DAYS } from "~/server/services/recommendations.server";
import { getSetting } from "~/server/settings.server";
import { incidentsLinkedTo } from "./incidents.server";
import { cutProtected, employeeNames, entityViews, entityKey, opsAccess } from "./shared.server";
import { scrubText } from "./telemetry.server";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  OUTBOX_PAGE_SIZE,
  RUNS_PAGE_SIZE,
  RUN_STUCK_MS,
  type ImpactLine,
  type JobHealth,
  type JobPreview,
  type JobRunView,
  type JobView,
  type OutboxChannel,
  type OutboxFilters,
  type OutboxRow,
  type OutboxStatus,
  type RunFilters,
  type RunOrigin,
  type RunStatus,
} from "./types";

/** The pseudo-job the scheduler records when a cron expression it does not know fires. */
export const SCHEDULER_JOB = "scheduler";

export const RUN_JOB_ACTION = "ops.job.run";

// ───────────────────────────────────────────────────────────────── cron arithmetic (UTC, as Cloudflare fires them)

function fieldValues(field: string, size: number): number[] | null {
  if (field === "*") return Array.from({ length: size }, (_, i) => i);
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n < size ? Array.from({ length: Math.ceil(size / n) }, (_, i) => i * n).filter((v) => v < size) : null;
  }
  const out: number[] = [];
  for (const part of field.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > to || to >= size) return null;
    for (let v = from; v <= to; v++) out.push(v);
  }
  return out;
}

/**
 * The next time a cron expression fires after `after` (minute and hour fields: `*`, `*\/n`, `n`, `a-b`, lists; the day,
 * month and weekday fields must be `*`). Null for anything else — the page then shows the expression as written.
 */
export function nextCronRun(cron: string, after: number): number | null {
  const [minute, hour, dom, month, dow, extra] = cron.trim().split(/\s+/);
  if (extra !== undefined || dom !== "*" || month !== "*" || dow !== "*" || minute === undefined || hour === undefined) return null;
  const minutes = fieldValues(minute, 60);
  const hours = fieldValues(hour, 24);
  if (!minutes || !hours) return null;
  let t = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < 2 * 24 * 60; i++, t += MINUTE_MS) {
    const d = new Date(t);
    if (minutes.includes(d.getUTCMinutes()) && hours.includes(d.getUTCHours())) return t;
  }
  return null;
}

/** The gap between two runs of a cron (null when it cannot be computed). */
export function cronPeriod(cron: string, now: number): number | null {
  const first = nextCronRun(cron, now);
  if (first === null) return null;
  const second = nextCronRun(cron, first);
  return second === null ? null : second - first;
}

/** A job is late when it has not run for three periods (frequent jobs) or a period and two hours (hourly and slower). */
export function lateAfter(period: number): number {
  return period < HOUR_MS ? 3 * period + MINUTE_MS : period + 2 * HOUR_MS;
}

function scheduleOf(job: string): { cron: string; order: number } | null {
  for (const [cron, jobs] of Object.entries(SCHEDULES)) {
    const index = (jobs as readonly string[]).indexOf(job);
    if (index !== -1) return { cron, order: index + 1 };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────── runs

type RunRow = typeof jobRuns.$inferSelect;

function runView(row: RunRow, names: Map<string, string>, access: { cost: boolean; profit: boolean }): JobRunView {
  const cut = cutProtected(row.stats, access);
  return {
    id: row.id,
    job: row.job,
    status: row.status as RunStatus,
    origin: row.origin as RunOrigin,
    attempt: row.attempt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    stats: cut.value,
    statsWithheld: cut.withheld,
    // a job's error can quote what it was working on (an order's phone, an e-mail): scrubbed like the error reports
    error: row.error ? scrubText(row.error, 2000) : null,
    triggeredBy: row.triggeredBy ? (names.get(row.triggeredBy) ?? row.triggeredBy) : null,
  };
}

/**
 * Health from the last run. LATE is measured from the last run the CRON started: a run by hand proves nothing about
 * the trigger, so it never hides a schedule that stopped firing. A job the cron never ran is measured from its first
 * run of any kind (the app was there to be triggered since then).
 */
function healthOf(last: RunRow | null, cronReference: number | null, period: number | null, now: number): { health: JobHealth; late: boolean } {
  if (!last) return { health: "never", late: false };
  const late = period !== null && cronReference !== null && now - cronReference > lateAfter(period);
  if (last.status === "running") return { health: now - last.startedAt > RUN_STUCK_MS ? "stuck" : "running", late };
  if (last.status === "failed") return { health: "failing", late };
  if (late) return { health: "late", late };
  if (last.status === "skipped") return { health: "skipped", late };
  return { health: "ok", late };
}

/** Every job the scheduler knows (plus "scheduler" once it recorded something), with its schedule and health. */
export async function jobsOverview(db: Db, actor: Actor, now: number): Promise<{ jobs: JobView[]; crons: { cron: string; jobs: string[]; nextAt: number | null }[] }> {
  assertCan(actor, "ops.job.read");
  const access = opsAccess(actor);
  const names: string[] = [...JOB_NAMES];
  const scheduler = await db.select({ id: jobRuns.id }).from(jobRuns).where(eq(jobRuns.job, SCHEDULER_JOB)).limit(1).get();
  if (scheduler) names.push(SCHEDULER_JOB);
  const since = now - 7 * DAY_MS;
  // One statement for every job (each sub-select walks the (job, started_at) index from its newest run), one for the
  // last runs themselves, one for the week's failures: three reads however many jobs there are.
  const jobList = sql.join(
    names.map((job) => sql`(${job})`),
    sql`, `,
  );
  const facts = await db.all<{ job: string; lastId: string | null; lastSuccessAt: number | null; lastCronAt: number | null; firstAt: number | null; streak: number }>(sql`
    WITH j(job) AS (VALUES ${jobList})
    SELECT j.job AS job,
      (SELECT id FROM job_runs WHERE job = j.job ORDER BY started_at DESC, id DESC LIMIT 1) AS lastId,
      (SELECT started_at FROM job_runs WHERE job = j.job AND status = 'succeeded' ORDER BY started_at DESC LIMIT 1) AS lastSuccessAt,
      (SELECT started_at FROM job_runs WHERE job = j.job AND origin = 'cron' ORDER BY started_at DESC LIMIT 1) AS lastCronAt,
      (SELECT min(started_at) FROM job_runs WHERE job = j.job) AS firstAt,
      (SELECT count(*) FROM job_runs WHERE job = j.job AND status = 'failed'
         AND started_at > coalesce((SELECT started_at FROM job_runs WHERE job = j.job AND status <> 'failed' ORDER BY started_at DESC LIMIT 1), -1)) AS streak
    FROM j`);
  const lastIds = facts.map((row) => row.lastId).filter((id): id is string => typeof id === "string");
  const [lastRows, failures] = await Promise.all([
    lastIds.length ? db.select().from(jobRuns).where(inArray(jobRuns.id, lastIds)) : Promise.resolve([] as RunRow[]),
    db.select({ job: jobRuns.job, n: count() }).from(jobRuns).where(and(eq(jobRuns.status, "failed"), gt(jobRuns.startedAt, since))).groupBy(jobRuns.job),
  ]);
  const lastById = new Map(lastRows.map((row) => [row.id, row]));
  const factOf = new Map(facts.map((row) => [row.job, row]));
  const failed = new Map(failures.map((row) => [row.job, Number(row.n)]));
  const nameOf = await employeeNames(db, lastRows.map((row) => row.triggeredBy));
  const jobs = names.map((job): JobView => {
    const schedule = scheduleOf(job);
    const period = schedule ? cronPeriod(schedule.cron, now) : null;
    const fact = factOf.get(job);
    const last = (fact?.lastId ? lastById.get(fact.lastId) : undefined) ?? null;
    const cronReference = fact?.lastCronAt ?? fact?.firstAt ?? null;
    const { health } = healthOf(last, cronReference === null ? null : Number(cronReference), period, now);
    return {
      job,
      cron: schedule?.cron ?? null,
      cadence: period === null ? null : period < HOUR_MS ? "frequent" : "daily",
      order: schedule?.order ?? null,
      health,
      last: last ? runView(last, nameOf, access) : null,
      lastSuccessAt: fact?.lastSuccessAt === null || fact?.lastSuccessAt === undefined ? null : Number(fact.lastSuccessAt),
      failures7d: failed.get(job) ?? 0,
      streak: Number(fact?.streak ?? 0),
      nextDueAt: schedule ? nextCronRun(schedule.cron, now) : null,
      known: job !== SCHEDULER_JOB,
    };
  });
  const crons = Object.entries(SCHEDULES).map(([cron, list]) => ({ cron, jobs: [...list], nextAt: nextCronRun(cron, now) }));
  return { jobs, crons };
}

/** One job: its schedule and health, what a run now would do, its latest runs. */
export async function getJob(db: Db, actor: Actor, job: string, now: number): Promise<{ view: JobView; preview: JobPreview; runs: JobRunView[] }> {
  assertCan(actor, "ops.job.read");
  if (!(JOB_NAMES as readonly string[]).includes(job) && job !== SCHEDULER_JOB) throw notFound("job");
  const overview = await jobsOverview(db, actor, now);
  const view = overview.jobs.find((entry) => entry.job === job);
  if (!view) throw notFound("job");
  const [preview, page] = await Promise.all([job === SCHEDULER_JOB ? { job, lines: [], changesData: false } : jobPreview(db, actor, job, now), listRuns(db, actor, { job, status: null, origin: null, page: 1 })]);
  return { view, preview, runs: page.rows.slice(0, 20) };
}

/** The run history with its filters (50 a page, newest first). */
export async function listRuns(db: Db, actor: Actor, filters: RunFilters): Promise<{ rows: JobRunView[]; total: number; page: number; pageCount: number; jobs: string[] }> {
  assertCan(actor, "ops.job.read");
  const access = opsAccess(actor);
  const where: SQL[] = [];
  if (filters.job) where.push(eq(jobRuns.job, filters.job));
  if (filters.status) where.push(eq(jobRuns.status, filters.status));
  if (filters.origin) where.push(eq(jobRuns.origin, filters.origin));
  const condition = where.length ? and(...where) : undefined;
  const [totalRow, rows] = await Promise.all([
    db.select({ n: count() }).from(jobRuns).where(condition).get(),
    db
      .select()
      .from(jobRuns)
      .where(condition)
      .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
      .limit(RUNS_PAGE_SIZE)
      .offset((filters.page - 1) * RUNS_PAGE_SIZE),
  ]);
  const total = Number(totalRow?.n ?? 0);
  const names = await employeeNames(db, rows.map((row) => row.triggeredBy));
  return { rows: rows.map((row) => runView(row, names, access)), total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / RUNS_PAGE_SIZE)), jobs: [...JOB_NAMES] };
}

/** One run, with the incidents it was linked to (23.05). */
export async function getRun(db: Db, actor: Actor, runId: string): Promise<{ run: JobRunView; incidents: { id: string; ref: string; title: string; status: string }[] }> {
  assertCan(actor, "ops.job.read");
  const row = await db.select().from(jobRuns).where(eq(jobRuns.id, runId)).get();
  if (!row) throw notFound("job_run");
  // the incidents it belongs to only reach people who may read incidents
  const [names, incidents] = await Promise.all([employeeNames(db, [row.triggeredBy]), opsAccess(actor).incidents ? incidentsLinkedTo(db, "run", runId) : Promise.resolve([])]);
  return { run: runView(row, names, opsAccess(actor)), incidents };
}

// ───────────────────────────────────────────────────────────────── what a run would do

const num = (value: unknown) => Number(value ?? 0);

/**
 * What running the job now would touch — counted with the job's own conditions, read only. `changesData` says whether
 * the job changes records other modules own (orders cancelled, stock released, products published, rows deleted).
 */
export async function jobPreview(db: Db, actor: Actor, job: string, now: number): Promise<JobPreview> {
  assertCan(actor, "ops.job.read");
  const lines: ImpactLine[] = [];
  let changesData = true;
  switch (job as JobName) {
    case "orders.expire_unpaid": {
      const hours = await getSetting(db, "checkout.transfer_proof_hours");
      const row = await db
        .select({ n: count() })
        .from(orders)
        .where(
          and(
            eq(orders.status, "awaiting_payment"),
            inArray(orders.paymentMethod, ["bank_transfer", "zaincash"]),
            or(lte(orders.paymentDueAt, now), and(isNull(orders.paymentDueAt), lte(orders.placedAt, now - hours * HOUR_MS))),
          ),
        )
        .get();
      lines.push({ key: "expireUnpaid", count: num(row?.n), vars: { hours } });
      break;
    }
    case "inventory.reservations.expire": {
      const row = await db
        .select({ n: count() })
        .from(stockReservations)
        .where(and(eq(stockReservations.status, "active"), sql`${stockReservations.expiresAt} IS NOT NULL`, lte(stockReservations.expiresAt, now)))
        .get();
      lines.push({ key: "reservations", count: num(row?.n) });
      break;
    }
    case "catalog.publish_due": {
      const row = await db
        .select({ n: count() })
        .from(products)
        .where(and(eq(products.status, "scheduled"), lte(products.publishAt, now)))
        .get();
      lines.push({ key: "publishDue", count: num(row?.n) });
      break;
    }
    case "outbox.deliver": {
      changesData = false;
      const row = await db.select({ n: count() }).from(outbox).where(eq(outbox.status, "queued")).get();
      lines.push({ key: "outboxQueued", count: num(row?.n) }, { key: "noProvider", count: null });
      break;
    }
    case "audit.seal": {
      changesData = false;
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM audit_events WHERE seq > coalesce((SELECT max(to_seq) FROM audit_seals), 0)`);
      lines.push({ key: "unsealed", count: num(rows[0]?.n) });
      break;
    }
    case "ratelimits.cleanup": {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM rate_limits WHERE window_start < ${now - DAY_MS}`);
      lines.push({ key: "rateLimits", count: num(rows[0]?.n) });
      break;
    }
    case "retention": {
      const [auth, mail, runs] = await Promise.all([
        db.all<{ n: number }>(sql`SELECT count(*) AS n FROM auth_events WHERE at < ${now - RETENTION_DAYS.authEvents * DAY_MS}`),
        db.all<{ n: number }>(sql`SELECT count(*) AS n FROM outbox WHERE created_at < ${now - RETENTION_DAYS.outbox * DAY_MS} AND status <> 'queued'`),
        db.all<{ n: number }>(sql`
          SELECT count(*) AS n FROM job_runs AS r WHERE r.started_at < ${now - RETENTION_DAYS.jobRuns * DAY_MS}
            AND EXISTS (SELECT 1 FROM job_runs AS newer WHERE newer.job = r.job AND (newer.started_at > r.started_at OR (newer.started_at = r.started_at AND newer.id > r.id)))`),
      ]);
      lines.push(
        { key: "retentionAuth", count: num(auth[0]?.n), vars: { days: RETENTION_DAYS.authEvents } },
        { key: "retentionOutbox", count: num(mail[0]?.n), vars: { days: RETENTION_DAYS.outbox } },
        { key: "retentionRuns", count: num(runs[0]?.n), vars: { days: RETENTION_DAYS.jobRuns } },
        { key: "retentionSessions", count: null, vars: { days: RETENTION_DAYS.sessions, otp: RETENTION_DAYS.otpCodes } },
      );
      break;
    }
    case "consistency.daily":
      changesData = false;
      lines.push({ key: "checks", count: CONSISTENCY_CHECKS.length });
      break;
    case "recommendations.events.purge": {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM recommendation_events WHERE at < ${now - RECOMMENDATION_EVENT_RETENTION_DAYS * DAY_MS}`);
      lines.push({ key: "recommendationEvents", count: num(rows[0]?.n), vars: { days: RECOMMENDATION_EVENT_RETENTION_DAYS } });
      break;
    }
    case "tradein.drafts.purge":
      lines.push({ key: "tradeinDrafts", count: null });
      break;
    case "devices.tradein_offers.expire": {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM trade_ins WHERE status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at <= ${now}`);
      lines.push({ key: "tradeinOffers", count: num(rows[0]?.n) });
      break;
    }
    case "customers.segments.recompute": {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM customers`);
      lines.push({ key: "segments", count: num(rows[0]?.n) });
      break;
    }
    default:
      lines.push({ key: "unknown", count: null });
      break;
  }
  return { job, lines, changesData };
}

// ───────────────────────────────────────────────────────────────── run now

export const RunJobInput = z.object({
  job: z.string({ error: "required" }).trim().min(1, "required").max(80, "invalid"),
  reason: z.string({ error: "reason_required" }).trim().min(3, "reason_required").max(500, "too_long"),
  idempotencyKey: z.string({ error: "invalid" }).trim().min(16, "invalid").max(128, "invalid"),
});

/**
 * Runs a job now, as its cron would (ops.job.run). The first submission of a form claims its key with the audit event
 * (`ops.job.run`, the reason, the job) BEFORE the job runs; a resubmission finds the claim and returns the run it
 * started (`replayed: true`) instead of running the job again. Refused while a run of the same job is in progress.
 */
export async function runJobNow(db: Db, actor: Actor, raw: unknown, now: number, env?: ScheduledJobsEnv): Promise<{ runId: string | null; status: RunStatus | null; replayed: boolean }> {
  assertCan(actor, "ops.job.run");
  const input = RunJobInput.parse(raw);
  if (!(JOB_NAMES as readonly string[]).includes(input.job)) throw new AppError("job_unknown", 404, { fields: { job: "job_unknown" } });
  const job = input.job as JobName;
  const by = actor.kind === "employee" ? actor.id : null;
  const claimId = `aud_job_${(await sha256Hex(`ops.job.run|${by ?? "system"}|${input.idempotencyKey}`)).slice(0, 26)}`;

  const replay = async () => {
    const claim = await db.select({ at: auditEvents.at, entityId: auditEvents.entityId }).from(auditEvents).where(eq(auditEvents.id, claimId)).get();
    if (!claim) return null;
    // the same form again returns its run; the same key for another job is refused (never answered with the first)
    if (claim.entityId !== job) throw new AppError("idempotency_mismatch", 409, { detail: claim.entityId ?? undefined });
    const run = await db
      .select({ id: jobRuns.id, status: jobRuns.status })
      .from(jobRuns)
      .where(and(eq(jobRuns.job, claim.entityId ?? job), eq(jobRuns.origin, "manual"), by ? eq(jobRuns.triggeredBy, by) : isNull(jobRuns.triggeredBy), eq(jobRuns.startedAt, claim.at)))
      .orderBy(asc(jobRuns.id))
      .limit(1)
      .get();
    return { runId: run?.id ?? null, status: (run?.status as RunStatus | undefined) ?? null, replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  // In flight: a run of this job still running, or a claim by hand (someone else's form, another tab) whose run has not
  // finished — it may not have started yet. Checked INSIDE the claim's batch (follow-up 2026-11-12): two "run now" clicks
  // with different keys both passed a check made before the claim, and both started the job.
  const inFlight = sql`(EXISTS (SELECT 1 FROM job_runs AS r WHERE r.job = ${job} AND r.status = 'running' AND r.started_at > ${now - RUN_STUCK_MS})
    OR EXISTS (SELECT 1 FROM audit_events AS a WHERE a.action = ${RUN_JOB_ACTION} AND a.entity_type = 'job' AND a.entity_id = ${job} AND a.at > ${now - RUN_STUCK_MS}
      AND NOT EXISTS (SELECT 1 FROM job_runs AS f WHERE f.job = a.entity_id AND f.origin = 'manual' AND f.started_at = a.at AND coalesce(f.triggered_by, '') = coalesce(a.actor_id, '') AND f.status <> 'running')))`;
  const busy = await db.all<{ n: number }>(sql`SELECT ${inFlight} AS n`);
  if (Number(busy[0]?.n ?? 0)) throw conflict("job_running", job);

  try {
    await runBatch(db, [
      expectThat(db, sql`NOT ${inFlight}`, { code: "JOB_RUNNING", detail: job }),
      db.insert(auditEvents).values(
        auditRow({ id: claimId, actor, action: RUN_JOB_ACTION, entityType: "job", entityId: job, summary: `${job} run by hand`, after: { job, origin: "manual" }, reason: input.reason, at: now }),
      ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await replay();
      if (again) return again;
    }
    if (isDbError(error, "JOB_RUNNING")) throw conflict("job_running", job);
    throw error;
  }
  const outcome = await runJob(db, job, now, { origin: "manual", triggeredBy: by, env });
  return { runId: outcome.runId, status: outcome.status, replayed: false };
}

// ───────────────────────────────────────────────────────────────── the message queue (outbox)

/** A recipient as ops screens show it: a phone masked, an e-mail as its first letter and domain, anything else hidden. */
export function maskRecipient(recipient: string): string {
  const phone = normalizeIraqPhone(recipient);
  if (phone) return maskPhone(phone);
  const at = recipient.indexOf("@");
  if (at > 0) return `${recipient[0]}•••@${recipient.slice(at + 1)}`;
  return recipient.length > 4 ? `•••${recipient.slice(-4)}` : "•••";
}

export type OutboxOverview = {
  counts: { status: OutboxStatus; channel: OutboxChannel; count: number; oldestAt: number | null }[];
  held: number;
  queued: number;
  failed: number;
  oldestHeldAt: number | null;
  /** The deliver job's last run: skipped with "no_message_provider_configured" means no provider exists. */
  deliver: { status: RunStatus; at: number; reason: string | null } | null;
};

export async function outboxOverview(db: Db, actor: Actor): Promise<OutboxOverview> {
  assertCan(actor, "ops.job.read");
  const [rows, deliver] = await Promise.all([
    db.select({ status: outbox.status, channel: outbox.channel, n: count(), oldest: sql<number | null>`min(${outbox.createdAt})` }).from(outbox).groupBy(outbox.status, outbox.channel),
    db.select({ status: jobRuns.status, at: jobRuns.startedAt, stats: jobRuns.stats }).from(jobRuns).where(eq(jobRuns.job, "outbox.deliver")).orderBy(desc(jobRuns.startedAt)).limit(1).get(),
  ]);
  const counts = rows.map((row) => ({ status: row.status as OutboxStatus, channel: row.channel as OutboxChannel, count: Number(row.n), oldestAt: row.oldest === null ? null : Number(row.oldest) }));
  const sum = (status: OutboxStatus) => counts.filter((row) => row.status === status).reduce((total, row) => total + row.count, 0);
  const heldOldest = counts.filter((row) => row.status === "held" && row.oldestAt !== null).map((row) => row.oldestAt as number);
  const reason = deliver?.stats && typeof (deliver.stats as Record<string, unknown>).reason === "string" ? String((deliver.stats as Record<string, unknown>).reason) : null;
  return {
    counts,
    held: sum("held"),
    queued: sum("queued"),
    failed: sum("failed"),
    oldestHeldAt: heldOldest.length ? Math.min(...heldOldest) : null,
    deliver: deliver ? { status: deliver.status as RunStatus, at: deliver.at, reason } : null,
  };
}

/** Outgoing messages with filters (50 a page, newest first): never the payload, the recipient masked. */
export async function listOutbox(db: Db, actor: Actor, filters: OutboxFilters): Promise<{ rows: OutboxRow[]; total: number; page: number; pageCount: number; templates: string[] }> {
  assertCan(actor, "ops.job.read");
  const where: SQL[] = [];
  if (filters.status) where.push(eq(outbox.status, filters.status));
  if (filters.channel) where.push(eq(outbox.channel, filters.channel));
  if (filters.template) where.push(eq(outbox.template, filters.template));
  const condition = where.length ? and(...where) : undefined;
  const [totalRow, rows, templates] = await Promise.all([
    db.select({ n: count() }).from(outbox).where(condition).get(),
    db
      .select({
        id: outbox.id,
        channel: outbox.channel,
        recipient: outbox.recipient,
        template: outbox.template,
        status: outbox.status,
        attempts: outbox.attempts,
        lastError: outbox.lastError,
        createdAt: outbox.createdAt,
        sentAt: outbox.sentAt,
        nextAttemptAt: outbox.nextAttemptAt,
        refType: outbox.refType,
        refId: outbox.refId,
      })
      .from(outbox)
      .where(condition)
      .orderBy(desc(outbox.createdAt), desc(outbox.id))
      .limit(OUTBOX_PAGE_SIZE)
      .offset((filters.page - 1) * OUTBOX_PAGE_SIZE),
    db.selectDistinct({ template: outbox.template }).from(outbox).orderBy(outbox.template).limit(100),
  ]);
  const refs = await entityViews(
    db,
    actor,
    rows.filter((row) => row.refType && row.refId).map((row) => ({ type: row.refType, id: row.refId })),
  );
  const total = Number(totalRow?.n ?? 0);
  return {
    rows: rows.map((row) => {
      const ref = row.refType && row.refId ? refs.get(entityKey(row.refType, row.refId)) : undefined;
      return {
        id: row.id,
        channel: row.channel as OutboxChannel,
        recipient: maskRecipient(row.recipient),
        template: row.template,
        status: row.status as OutboxStatus,
        attempts: row.attempts,
        // a provider's answer can quote the recipient: scrubbed like the recipient itself is masked
        lastError: row.lastError ? scrubText(row.lastError, 300) : null,
        createdAt: row.createdAt,
        sentAt: row.sentAt,
        nextAttemptAt: row.nextAttemptAt,
        ref: ref ? { type: row.refType ?? "", label: ref.label ?? row.refId ?? "", href: ref.href } : row.refType ? { type: row.refType, label: row.refId ?? "", href: null } : null,
      };
    }),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / OUTBOX_PAGE_SIZE)),
    templates: templates.map((row) => row.template),
  };
}

/** Failed and late jobs right now (the module's front page and the bell): failing, stuck or late. */
export function jobsNeedingAttention(jobs: readonly JobView[]): JobView[] {
  return jobs.filter((job) => job.known && (job.health === "failing" || job.health === "stuck" || job.health === "late"));
}

/** Old runs are kept 90 days by the retention job (the latest of each job always): for the page's note. */
export const RUNS_KEPT_DAYS = RETENTION_DAYS.jobRuns;
