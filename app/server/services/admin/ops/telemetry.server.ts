/**
 * Admin 23.01 / 23.02 — what the app itself records about its errors and its speed, honestly and cheaply.
 *
 * There is no APM or analytics provider. Cloudflare keeps the full picture outside the app (Workers Logs, the Worker's
 * metrics, D1's metrics — the pages say where to look). In the app, NOTHING is written per request:
 *
 *   errors   one upsert per error into `error_reports`, grouped by a fingerprint (source + route + the message with
 *            its numbers and ids blanked + the first stack frame), so a repeat costs one row update. Texts are scrubbed
 *            before they are stored: phone numbers masked, e-mail addresses, long numbers and token-like strings
 *            removed, URLs reduced to their path. A resolved error that happens again is open again; an ignored one
 *            stays ignored (its count still grows).
 *   speed    one upsert per SLOW or FAILED request into `perf_rollups` (per Baghdad day, area, route pattern, metric,
 *            device): count, sum, maximum, how many were poor. Fast requests are never written, so this gives slow
 *            and failed counts, not rates — the totals are Cloudflare's.
 *
 * Both are bounded per isolate (ISOLATE_WRITES_PER_MINUTE): beyond that, errors are counted in memory and added to the
 * fingerprint's next write, speed samples are dropped. Retention: rows not seen for TELEMETRY_RETENTION_DAYS are
 * deleted (`purgeOpsTelemetry`, meant for the daily retention job; until that job calls it, every 100th write runs it).
 *
 * Reading: `listErrors` / `getErrorReport` (ops.error.read), `setErrorStatus` (ops.error.resolve, with a reason,
 * audited), `performanceView` (ops.performance.read).
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditRow, maskPhonesIn } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, errorReports, incidents, perfRollups } from "~/server/db/schema";
import { chunkRows, expectChanged, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { auditActorOf, employeeNames, opsAccess } from "./shared.server";
import {
  BULK_MAX,
  DAY_MS,
  ERRORS_PAGE_SIZE,
  ERROR_LEVELS,
  ERROR_SOURCES,
  ERROR_VIEWS,
  ERROR_WINDOW_MS,
  MINUTE_MS,
  PERF_THRESHOLDS,
  PERF_WINDOW_DAYS,
  TELEMETRY_RETENTION_DAYS,
  addDays,
  baghdadDay,
  likePatterns,
  type ErrorFilters,
  type ErrorLevel,
  type ErrorRow,
  type ErrorSource,
  type ErrorStatus,
  type ErrorView,
  type HistoryEvent,
  type PerfArea,
  type PerfFilters,
  type PerfMetric,
  type PerfRow,
} from "./types";

export const ERROR_ACTIONS = { resolved: "ops.error.resolve", ignored: "ops.error.ignore", open: "ops.error.reopen" } as const;

// ───────────────────────────────────────────────────────────────── scrubbing

/** Removes what must never be stored from a text: phones (masked), e-mails, card-like numbers, tokens, secrets in URLs. */
export function scrubText(text: string, max: number): string {
  let out = maskPhonesIn(text);
  out = out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]");
  out = out.replace(/([?&;](?:t|token|key|code|secret|session|password|auth|sig|signature)=)[^&\s#;]*/gi, "$1[redacted]");
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, "[number]");
  out = out.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[token]");
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** A URL or path reduced to its path (no query, no fragment, no origin), scrubbed, at most 300 characters. */
export function pathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let path = url;
  try {
    path = new URL(url, "https://app.invalid").pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? "";
  }
  path = path.replace(/\.data$/, "");
  return path ? scrubText(path, 300) : null;
}

/** A route pattern as stored: the matched pattern ("admin/ops/consistency/:findingId"), with a leading slash. */
export function routeOf(pattern: string | null | undefined): string | null {
  if (!pattern) return null;
  const clean = pattern.trim().replace(/\.data$/, "").replace(/^\/*/, "/").replace(/\/+$/, "") || "/";
  return /^[\w/:*.\-[\]()?]{1,200}$/.test(clean) ? clean : null;
}

/** The message with what varies between occurrences blanked (numbers, ids, hashes, quoted values). */
function normalizeForFingerprint(message: string): string {
  return message
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, "'…'")
    .replace(/\b[a-z]{2,8}_[0-9A-Za-z]{10,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .slice(0, 300);
}

/** The first stack frame that names a place in our code, without line and column. */
function topFrame(stack: string | null | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n").slice(0, 12)) {
    const text = line.trim();
    if (!/^at\s|@/.test(text)) continue;
    return text
      .replace(/\?[^\s):]*/g, "")
      .replace(/:\d+(:\d+)?/g, "")
      .replace(/[A-Za-z0-9_-]{8}\.(js|mjs)/g, "<chunk>.$1")
      .slice(0, 200);
  }
  return "";
}

// ───────────────────────────────────────────────────────────────── bounded writes (per isolate)

export const ISOLATE_WRITES_PER_MINUTE = 60;
const budget = { windowStart: 0, used: 0 };
/** Error occurrences not written because the isolate's budget was spent, by fingerprint (added to the next write). */
const pendingCounts = new Map<string, number>();
let writesSincePurge = 0;

function takeBudget(now: number): boolean {
  const window = Math.floor(now / MINUTE_MS);
  if (budget.windowStart !== window) {
    budget.windowStart = window;
    budget.used = 0;
  }
  if (budget.used >= ISOLATE_WRITES_PER_MINUTE) return false;
  budget.used++;
  return true;
}

/** For tests: forget the isolate's budget and pending counts. */
export function resetTelemetryBudget(): void {
  budget.windowStart = 0;
  budget.used = 0;
  pendingCounts.clear();
  writesSincePurge = 0;
}

async function maybePurge(db: Db, now: number): Promise<void> {
  writesSincePurge++;
  if (writesSincePurge < 100) return;
  writesSincePurge = 0;
  try {
    await purgeOpsTelemetry(db, now);
  } catch (error) {
    console.error("[ops] telemetry purge failed", error);
  }
}

// ───────────────────────────────────────────────────────────────── recording errors (23.01)

export const ErrorReportInput = z.object({
  source: z.enum(ERROR_SOURCES),
  level: z.enum(ERROR_LEVELS).optional(),
  message: z.string().min(1).max(20_000),
  stack: z.string().max(50_000).optional(),
  route: z.string().max(400).optional(),
  url: z.string().max(4000).optional(),
  release: z.string().max(80).optional(),
  sample: z
    .object({
      requestId: z.string().max(100).optional(),
      status: z.number().int().min(0).max(999).optional(),
      device: z.string().max(40).optional(),
      browser: z.string().max(40).optional(),
      actorKind: z.string().max(20).optional(),
      phase: z.string().max(40).optional(),
    })
    .optional(),
});
export type ErrorReportInput = z.input<typeof ErrorReportInput>;

/**
 * Records one occurrence of an error (one upsert). Returns `{ recorded: false }` when the isolate's write budget is
 * spent (the occurrence is counted in memory and added to the next write of the same fingerprint). Never throws for
 * bad input from a browser: invalid reports are dropped (`{ recorded: false }`).
 */
export async function recordError(db: Db, raw: unknown, now: number): Promise<{ recorded: boolean; id: string | null; fingerprint: string | null }> {
  const parsed = ErrorReportInput.safeParse(raw);
  if (!parsed.success) return { recorded: false, id: null, fingerprint: null };
  const input = parsed.data;
  const route = routeOf(input.route);
  const message = scrubText(input.message.trim() || "(no message)", 500);
  const stack = input.stack ? scrubText(input.stack.split("\n").slice(0, 25).join("\n"), 4000) : null;
  const fingerprint = (await sha256Hex(`${input.source}|${route ?? ""}|${normalizeForFingerprint(message)}|${topFrame(stack)}`)).slice(0, 32);
  if (!takeBudget(now)) {
    pendingCounts.set(fingerprint, (pendingCounts.get(fingerprint) ?? 0) + 1);
    return { recorded: false, id: null, fingerprint };
  }
  const extra = pendingCounts.get(fingerprint) ?? 0;
  pendingCounts.delete(fingerprint);
  const occurrences = 1 + extra;
  const level: ErrorLevel = input.level ?? "error";
  const sample = input.sample ? Object.fromEntries(Object.entries(input.sample).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, typeof value === "string" ? scrubText(value, 100) : value])) : null;
  const id = newId("err");
  await db
    .insert(errorReports)
    .values({
      id,
      fingerprint,
      source: input.source,
      level,
      message,
      stack,
      route,
      url: pathOf(input.url),
      release: input.release ? scrubText(input.release, 80) : null,
      sample,
      count: occurrences,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "open",
    })
    .onConflictDoUpdate({
      target: errorReports.fingerprint,
      set: {
        count: sql`${errorReports.count} + ${occurrences}`,
        lastSeenAt: now,
        message,
        stack,
        url: pathOf(input.url),
        sample,
        level: sql`CASE WHEN ${errorReports.level} = 'fatal' OR excluded.level = 'fatal' THEN 'fatal' WHEN ${errorReports.level} = 'error' OR excluded.level = 'error' THEN 'error' ELSE 'warning' END`,
        // A resolved error that happens again is open again; an ignored one stays ignored.
        status: sql`CASE WHEN ${errorReports.status} = 'resolved' THEN 'open' ELSE ${errorReports.status} END`,
        resolvedAt: sql`CASE WHEN ${errorReports.status} = 'resolved' THEN NULL ELSE ${errorReports.resolvedAt} END`,
        resolvedBy: sql`CASE WHEN ${errorReports.status} = 'resolved' THEN NULL ELSE ${errorReports.resolvedBy} END`,
      },
    });
  await maybePurge(db, now);
  const row = await db.select({ id: errorReports.id }).from(errorReports).where(eq(errorReports.fingerprint, fingerprint)).get();
  return { recorded: true, id: row?.id ?? id, fingerprint };
}

// ───────────────────────────────────────────────────────────────── recording speed (23.02)

export const DEVICES = ["mobile", "tablet", "desktop", "unknown"] as const;
export type Device = (typeof DEVICES)[number];

/** The device class of a User-Agent (recognition only, for grouping). */
export function deviceOf(userAgent: string | null | undefined): Device {
  const ua = userAgent ?? "";
  if (!ua) return "unknown";
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(ua)) return "mobile";
  if (/Windows|Macintosh|Mac OS X|Linux|CrOS|X11/i.test(ua)) return "desktop";
  return "unknown";
}

export const PerfSampleInput = z.object({
  area: z.enum(["admin", "storefront"]),
  route: z.string().max(400),
  kind: z.enum(["server", "load", "nav"]),
  ms: z.number().int().min(0).max(10 * 60 * 1000),
  status: z.number().int().min(0).max(999).optional(),
  device: z.enum(DEVICES).optional(),
});
export type PerfSampleInput = z.input<typeof PerfSampleInput>;

/** The metric a sample belongs to, or null when it is neither slow nor failed (then nothing is written). */
export function perfMetricOf(sample: { kind: "server" | "load" | "nav"; ms: number; status?: number }): PerfMetric | null {
  if (sample.kind === "server" && (sample.status ?? 0) >= 500) return "server_failed";
  const threshold = PERF_THRESHOLDS[sample.kind];
  if (sample.ms < threshold.slowMs) return null;
  return sample.kind === "server" ? "server_slow" : sample.kind === "load" ? "load_slow" : "nav_slow";
}

/** Records one slow or failed request / page load (one upsert); fast ones are not written at all. */
export async function recordPerfSample(db: Db, raw: unknown, now: number): Promise<{ recorded: boolean; metric: PerfMetric | null }> {
  const parsed = PerfSampleInput.safeParse(raw);
  if (!parsed.success) return { recorded: false, metric: null };
  const sample = parsed.data;
  const metric = perfMetricOf(sample);
  const route = routeOf(sample.route);
  if (!metric || !route) return { recorded: false, metric };
  if (!takeBudget(now)) return { recorded: false, metric };
  const poor = sample.ms >= PERF_THRESHOLDS[sample.kind].poorMs ? 1 : 0;
  const day = baghdadDay(now);
  const device = sample.device ?? "unknown";
  await db
    .insert(perfRollups)
    .values({ day, area: sample.area, route, metric, device, samples: 1, sumValue: sample.ms, maxValue: sample.ms, good: 0, needsImprovement: poor ? 0 : 1, poor, updatedAt: now })
    .onConflictDoUpdate({
      target: [perfRollups.day, perfRollups.area, perfRollups.route, perfRollups.metric, perfRollups.device],
      set: {
        samples: sql`${perfRollups.samples} + 1`,
        sumValue: sql`${perfRollups.sumValue} + ${sample.ms}`,
        maxValue: sql`max(${perfRollups.maxValue}, ${sample.ms})`,
        needsImprovement: sql`${perfRollups.needsImprovement} + ${poor ? 0 : 1}`,
        poor: sql`${perfRollups.poor} + ${poor}`,
        updatedAt: now,
      },
    });
  await maybePurge(db, now);
  return { recorded: true, metric };
}

/** Retention: errors not seen for TELEMETRY_RETENTION_DAYS, speed days older than that. Bounded rounds of 500. */
export async function purgeOpsTelemetry(db: Db, now: number): Promise<{ errors: number; perf: number }> {
  const cutoff = now - TELEMETRY_RETENTION_DAYS * DAY_MS;
  const oldestDay = addDays(baghdadDay(now), -TELEMETRY_RETENTION_DAYS);
  const changes = (result: unknown) => Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
  let errors = 0;
  let perf = 0;
  for (let round = 0; round < 20; round++) {
    // an error report an incident is about is the incident's evidence: kept as long as the incident (its link is the column)
    const stale = db
      .select({ id: errorReports.id })
      .from(errorReports)
      .where(and(lt(errorReports.lastSeenAt, cutoff), isNull(errorReports.incidentId)))
      .limit(500);
    const n = changes(await db.delete(errorReports).where(and(inArray(errorReports.id, stale), isNull(errorReports.incidentId))).run());
    errors += n;
    if (n < 500) break;
  }
  for (let round = 0; round < 20; round++) {
    const n = changes(await db.run(sql`DELETE FROM perf_rollups WHERE rowid IN (SELECT rowid FROM perf_rollups WHERE day < ${oldestDay} LIMIT 500)`));
    perf += n;
    if (n < 500) break;
  }
  return { errors, perf };
}

// ───────────────────────────────────────────────────────────────── reading errors

type ErrorRecord = typeof errorReports.$inferSelect;

async function errorRows(db: Db, actor: Actor, rows: readonly ErrorRecord[]): Promise<ErrorRow[]> {
  const incidentIds = [...new Set(rows.map((row) => row.incidentId).filter((id): id is string => !!id))];
  const [refs, names] = await Promise.all([
    incidentIds.length ? db.select({ id: incidents.id, ref: incidents.ref }).from(incidents).where(inArray(incidents.id, incidentIds)) : Promise.resolve([]),
    employeeNames(db, rows.map((row) => row.resolvedBy)),
  ]);
  const refOf = new Map(refs.map((row) => [row.id, row.ref]));
  // the incident's page only for those who may open it (otherwise its reference, without a link)
  const incidentPage = can(actor, "ops.incident.read");
  return rows.map((row) => ({
    id: row.id,
    source: row.source as ErrorSource,
    level: row.level as ErrorLevel,
    status: row.status as ErrorStatus,
    message: row.message,
    route: row.route,
    url: row.url,
    count: row.count,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    incident:
      row.incidentId && refOf.has(row.incidentId)
        ? { id: row.incidentId, ref: refOf.get(row.incidentId) as string, href: incidentPage ? `/admin/ops/incidents/${encodeURIComponent(refOf.get(row.incidentId) as string)}` : null }
        : null,
    resolvedBy: row.resolvedBy ? (names.get(row.resolvedBy) ?? row.resolvedBy) : null,
    resolvedAt: row.resolvedAt,
  }));
}

export type ErrorsPage = { rows: ErrorRow[]; total: number; page: number; pageCount: number; counts: Record<ErrorView, number>; occurrences24h: number };

export async function listErrors(db: Db, actor: Actor, filters: ErrorFilters, now: number): Promise<ErrorsPage> {
  assertCan(actor, "ops.error.read");
  // Every filter but the view: they decide the rows AND the view chips' counts (a chip's link keeps these filters).
  const base: SQL[] = [];
  if (filters.source) base.push(eq(errorReports.source, filters.source));
  if (filters.level) base.push(eq(errorReports.level, filters.level));
  const window = ERROR_WINDOW_MS[filters.window];
  if (window !== null) base.push(gt(errorReports.lastSeenAt, now - window));
  if (filters.q) {
    const text = likePatterns(filters.q).flatMap((pattern) => [sql`${errorReports.message} LIKE ${pattern} ESCAPE '\\'`, sql`${errorReports.route} LIKE ${pattern} ESCAPE '\\'`, sql`${errorReports.url} LIKE ${pattern} ESCAPE '\\'`]);
    base.push(or(...text) as SQL);
  }
  const condition = and(...(filters.view !== "all" ? [eq(errorReports.status, filters.view)] : []), ...base);
  const baseCondition = base.length ? and(...base) : undefined;
  const order =
    filters.sort === "count"
      ? [desc(errorReports.count), desc(errorReports.lastSeenAt)]
      : filters.sort === "first_seen"
        ? [desc(errorReports.firstSeenAt), desc(errorReports.id)]
        : [desc(errorReports.lastSeenAt), desc(errorReports.id)];
  const [totalRow, rows, byStatus, recent] = await Promise.all([
    db.select({ n: count() }).from(errorReports).where(condition).get(),
    db
      .select()
      .from(errorReports)
      .where(condition)
      .orderBy(...order)
      .limit(ERRORS_PAGE_SIZE)
      .offset((filters.page - 1) * ERRORS_PAGE_SIZE),
    db.select({ status: errorReports.status, n: count() }).from(errorReports).where(baseCondition).groupBy(errorReports.status),
    db.select({ n: count() }).from(errorReports).where(gt(errorReports.lastSeenAt, now - DAY_MS)).get(),
  ]);
  const statusCount = new Map(byStatus.map((row) => [row.status, Number(row.n)]));
  const counts = Object.fromEntries(ERROR_VIEWS.map((v) => [v, v === "all" ? [...statusCount.values()].reduce((a, b) => a + b, 0) : (statusCount.get(v) ?? 0)])) as Record<ErrorView, number>;
  const total = Number(totalRow?.n ?? 0);
  return { rows: await errorRows(db, actor, rows), total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / ERRORS_PAGE_SIZE)), counts, occurrences24h: Number(recent?.n ?? 0) };
}

export type ErrorDetail = { error: ErrorRow & { stack: string | null; release: string | null; sample: Record<string, unknown> | null; fingerprint: string }; history: HistoryEvent[] };

export async function getErrorReport(db: Db, actor: Actor, errorId: string): Promise<ErrorDetail> {
  assertCan(actor, "ops.error.read");
  const row = await db.select().from(errorReports).where(eq(errorReports.id, errorId)).get();
  if (!row) throw notFound("error_report");
  const [[view], events] = await Promise.all([
    errorRows(db, actor, [row]),
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "error_report"), eq(auditEvents.entityId, errorId)))
      .orderBy(asc(auditEvents.seq))
      .limit(100),
  ]);
  return {
    error: { ...view, stack: row.stack, release: row.release, sample: (row.sample as Record<string, unknown> | null) ?? null, fingerprint: row.fingerprint },
    history: events.map((event) => ({ id: event.id, at: event.at, action: event.action, by: auditActorOf(event), reason: event.reason, before: event.before, after: event.after })),
  };
}

export const ErrorStatusInput = z.object({
  ids: z.array(z.string().trim().min(1).max(64)).min(1, "nothing_selected").max(BULK_MAX, "too_many"),
  status: z.enum(["resolved", "ignored", "open"], { error: "invalid" }),
  reason: z.string({ error: "reason_required" }).trim().min(3, "reason_required").max(1000, "too_long"),
});

/**
 * Resolves, ignores or reopens error reports with a reason (ops.error.resolve). Resolve / ignore apply to open errors,
 * reopen to resolved or ignored ones; records already in the target state are left as they are.
 */
export async function setErrorStatus(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: number; unchanged: number }> {
  assertCan(actor, "ops.error.resolve");
  const input = ErrorStatusInput.parse(raw);
  const ids = [...new Set(input.ids)];
  const rows = await db.select().from(errorReports).where(inArray(errorReports.id, ids));
  if (rows.length !== ids.length) throw notFound("error_report");
  const from: ErrorStatus[] = input.status === "open" ? ["resolved", "ignored"] : ["open"];
  const wrong = rows.find((row) => row.status !== input.status && !from.includes(row.status as ErrorStatus));
  if (wrong) throw new AppError("error_changed", 409, { detail: wrong.id });
  const change = rows.filter((row) => row.status !== input.status);
  if (change.length === 0) return { changed: 0, unchanged: rows.length };
  const changeIds = change.map((row) => row.id);
  const by = actor.kind === "employee" ? actor.id : null;
  const auditRowsList = change.map((row) =>
    auditRow({ actor, action: ERROR_ACTIONS[input.status], entityType: "error_report", entityId: row.id, summary: `${row.source} ${row.status} → ${input.status}`, before: { status: row.status }, after: { status: input.status }, reason: input.reason, at: now }),
  );
  await runBatch(db, [
    db
      .update(errorReports)
      .set(input.status === "open" ? { status: "open", resolvedAt: null, resolvedBy: null } : { status: input.status, resolvedAt: now, resolvedBy: by })
      .where(and(inArray(errorReports.id, changeIds), inArray(errorReports.status, from))),
    expectChanged(db, changeIds.length, { code: "ERROR_CHANGED" }),
    ...chunkRows(auditEvents, auditRowsList).map((chunk) => db.insert(auditEvents).values(chunk)),
  ]);
  return { changed: change.length, unchanged: rows.length - change.length };
}

/** For the front page: open errors and occurrences in the last 24 hours. Null without ops.error.read. */
export async function errorCounts(db: Db, actor: Actor, now: number): Promise<{ open: number; seen24h: number } | null> {
  if (!can(actor, "ops.error.read")) return null;
  const [open, seen] = await Promise.all([
    db.select({ n: count() }).from(errorReports).where(eq(errorReports.status, "open")).get(),
    db.select({ n: count() }).from(errorReports).where(gt(errorReports.lastSeenAt, now - DAY_MS)).get(),
  ]);
  return { open: Number(open?.n ?? 0), seen24h: Number(seen?.n ?? 0) };
}

// ───────────────────────────────────────────────────────────────── reading speed

export type PerformanceView = {
  rows: PerfRow[];
  days: { day: string; serverSlow: number; serverFailed: number; loadSlow: number; navSlow: number }[];
  totals: { serverSlow: number; serverFailed: number; loadSlow: number; navSlow: number };
  from: string;
  to: string;
};

/** Slow and failed requests and page loads per route over the window (ops.performance.read). */
export async function performanceView(db: Db, actor: Actor, filters: PerfFilters, now: number): Promise<PerformanceView> {
  assertCan(actor, "ops.performance.read");
  const to = baghdadDay(now);
  const from = addDays(to, -(PERF_WINDOW_DAYS[filters.window] - 1));
  const rows = await db
    .select({ day: perfRollups.day, route: perfRollups.route, metric: perfRollups.metric, device: perfRollups.device, samples: perfRollups.samples, sum: perfRollups.sumValue, max: perfRollups.maxValue, poor: perfRollups.poor })
    .from(perfRollups)
    .where(and(eq(perfRollups.area, filters.area as PerfArea), sql`${perfRollups.day} >= ${from}`, sql`${perfRollups.day} <= ${to}`))
    .orderBy(asc(perfRollups.day));
  const byRoute = new Map<string, PerfRow>();
  const empty = () => ({ count: 0, avgMs: null as number | null, maxMs: null as number | null, poor: 0, sum: 0 });
  const acc = new Map<string, { serverSlow: ReturnType<typeof empty>; loadSlow: ReturnType<typeof empty>; navSlow: ReturnType<typeof empty>; failed: number; devices: Record<string, number> }>();
  const days = new Map<string, { day: string; serverSlow: number; serverFailed: number; loadSlow: number; navSlow: number }>();
  for (const row of rows) {
    const entry = acc.get(row.route) ?? { serverSlow: empty(), loadSlow: empty(), navSlow: empty(), failed: 0, devices: {} };
    acc.set(row.route, entry);
    const day = days.get(row.day) ?? { day: row.day, serverSlow: 0, serverFailed: 0, loadSlow: 0, navSlow: 0 };
    days.set(row.day, day);
    entry.devices[row.device] = (entry.devices[row.device] ?? 0) + row.samples;
    if (row.metric === "server_failed") {
      entry.failed += row.samples;
      day.serverFailed += row.samples;
      continue;
    }
    const slot = row.metric === "server_slow" ? entry.serverSlow : row.metric === "load_slow" ? entry.loadSlow : row.metric === "nav_slow" ? entry.navSlow : null;
    if (!slot) continue;
    slot.count += row.samples;
    slot.sum += row.sum;
    slot.maxMs = Math.max(slot.maxMs ?? 0, row.max);
    slot.poor += row.poor;
    if (row.metric === "server_slow") day.serverSlow += row.samples;
    else if (row.metric === "load_slow") day.loadSlow += row.samples;
    else day.navSlow += row.samples;
  }
  const finish = (slot: ReturnType<typeof empty>) => ({ count: slot.count, avgMs: slot.count ? Math.round(slot.sum / slot.count) : null, maxMs: slot.count ? slot.maxMs : null, poor: slot.poor });
  for (const [route, entry] of acc) {
    byRoute.set(route, { route, serverSlow: finish(entry.serverSlow), serverFailed: { count: entry.failed }, loadSlow: finish(entry.loadSlow), navSlow: finish(entry.navSlow), devices: entry.devices });
  }
  const list = [...byRoute.values()].sort((a, b) => b.serverFailed.count * 10 + b.serverSlow.count + b.loadSlow.count + b.navSlow.count - (a.serverFailed.count * 10 + a.serverSlow.count + a.loadSlow.count + a.navSlow.count) || a.route.localeCompare(b.route));
  const totals = list.reduce((sum, row) => ({ serverSlow: sum.serverSlow + row.serverSlow.count, serverFailed: sum.serverFailed + row.serverFailed.count, loadSlow: sum.loadSlow + row.loadSlow.count, navSlow: sum.navSlow + row.navSlow.count }), { serverSlow: 0, serverFailed: 0, loadSlow: 0, navSlow: 0 });
  // every day of the window, also the quiet ones (a gap must read as "nothing slow", not as missing data)
  const allDays: PerformanceView["days"] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) allDays.push(days.get(day) ?? { day, serverSlow: 0, serverFailed: 0, loadSlow: 0, navSlow: 0 });
  return { rows: list, days: allDays, totals, from, to };
}

/** For the front page: slow and failed admin requests over 7 days. Null without ops.performance.read. */
export async function perfCounts(db: Db, actor: Actor, now: number): Promise<{ slow: number; failed: number } | null> {
  if (!opsAccess(actor).performance) return null;
  const from = addDays(baghdadDay(now), -6);
  const rows = await db.all<{ metric: string; n: number }>(sql`SELECT metric, coalesce(sum(samples), 0) AS n FROM perf_rollups WHERE area = 'admin' AND day >= ${from} GROUP BY metric`);
  const of = (metric: string) => Number(rows.find((row) => row.metric === metric)?.n ?? 0);
  return { slow: of("server_slow") + of("load_slow") + of("nav_slow"), failed: of("server_failed") };
}
