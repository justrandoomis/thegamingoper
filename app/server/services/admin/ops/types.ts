/**
 * Admin module 23 "ops" (technical operations) — client-safe pieces: error keys, thresholds, the URL state of every
 * list (filters, sort and page work without JavaScript), Baghdad dates, what each consistency check is about, and the
 * view-model types the route modules render. No server imports here (route components import this file).
 */

export const OPS_NS = "admin-ops";

export const OPS_ERROR_KEYS = [
  "reason_required",
  "job_unknown",
  "job_running",
  "finding_changed",
  "finding_not_open",
  "finding_not_closed",
  "assignee_invalid",
  "due_invalid",
  "incident_changed",
  "incident_resolved",
  "incident_not_resolved",
  "owner_invalid",
  "target_invalid",
  "started_invalid",
  "resolved_invalid",
  "postmortem_required",
  "link_invalid",
  "link_exists",
  "link_missing",
  "error_changed",
  "too_many",
  "nothing_selected",
  "no_change",
] as const;
export type OpsErrorKey = (typeof OPS_ERROR_KEYS)[number];

// ───────────────────────────────────────────────────────────────── limits and thresholds

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** A frequent (every 5 minutes) job with no run for this long has missed three ticks: its trigger is not firing. */
export const FREQUENT_LATE_MS = 16 * MINUTE_MS;
/** A daily job with no run for this long missed its 03:30 run. */
export const DAILY_LATE_MS = 26 * HOUR_MS;
/** A run still "running" after this long died without recording its end (the Worker was stopped). */
export const RUN_STUCK_MS = 30 * MINUTE_MS;

/** At most this many records in one bulk action (each record is a few statements of ONE batch). */
export const BULK_MAX = 25;

export const RUNS_PAGE_SIZE = 50;
export const FINDINGS_PAGE_SIZE = 50;
export const INCIDENTS_PAGE_SIZE = 25;
export const ERRORS_PAGE_SIZE = 50;
export const OUTBOX_PAGE_SIZE = 50;

/**
 * What the app records about speed (23.02): never every request — one upsert per SLOW or FAILED request only.
 *   server   time the Worker spent on an admin request (document or data), from the module middleware
 *   load     a full page load in the browser (navigation timing), from the client reporter
 *   nav      a client-side navigation (link → the new page shown), from the client reporter
 * At or above `poor` a sample also counts as poor.
 */
export const PERF_THRESHOLDS = {
  server: { slowMs: 1000, poorMs: 3000 },
  load: { slowMs: 3000, poorMs: 6000 },
  nav: { slowMs: 2000, poorMs: 5000 },
} as const;
export const PERF_METRICS = ["server_slow", "server_failed", "load_slow", "nav_slow"] as const;
export type PerfMetric = (typeof PERF_METRICS)[number];

/** Recorded errors and speed samples are deleted after this long without a new occurrence (retention). */
export const TELEMETRY_RETENTION_DAYS = 90;

/** What one employee's browser may report (errors + slow loads) per window; more is refused with 429 and not stored. */
export const TELEMETRY_RATE = { limit: 30, windowSec: 10 * 60 } as const;

// ───────────────────────────────────────────────────────────────── statuses and tones

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";

export const JOB_HEALTHS = ["ok", "failing", "late", "stuck", "running", "skipped", "never"] as const;
export type JobHealth = (typeof JOB_HEALTHS)[number];
export const JOB_HEALTH_TONE: Record<JobHealth, Tone> = { ok: "ok", failing: "bad", late: "warn", stuck: "bad", running: "info", skipped: "info", never: "neutral" };

export const RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_STATUS_TONE: Record<RunStatus, Tone> = { running: "info", succeeded: "ok", failed: "bad", skipped: "neutral" };
export const RUN_ORIGINS = ["cron", "manual", "event"] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

export const FINDING_SEVERITIES = ["critical", "warning", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_SEVERITY_TONE: Record<FindingSeverity, Tone> = { critical: "bad", warning: "warn", info: "info" };
export const FINDING_STATUSES = ["open", "acknowledged", "resolved", "false_positive"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const FINDING_STATUS_TONE: Record<FindingStatus, Tone> = { open: "bad", acknowledged: "warn", resolved: "ok", false_positive: "neutral" };

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_SEVERITY_TONE: Record<IncidentSeverity, Tone> = { sev1: "bad", sev2: "bad", sev3: "warn", sev4: "info" };
export const INCIDENT_STATUSES = ["open", "investigating", "mitigated", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_STATUS_TONE: Record<IncidentStatus, Tone> = { open: "bad", investigating: "warn", mitigated: "info", resolved: "ok" };
/** Days until the suggested target date of a new incident, by severity (the person may pick another day). */
export const INCIDENT_TARGET_DAYS: Record<IncidentSeverity, number> = { sev1: 0, sev2: 1, sev3: 3, sev4: 7 };
/** Moves an update may make (resolving has its own form: it needs the resolution time and the post-mortem). */
export const INCIDENT_MOVES: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ["investigating", "mitigated"],
  investigating: ["mitigated"],
  mitigated: ["investigating"],
  resolved: [],
};
export const LINK_KINDS = ["finding", "run", "error"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const ERROR_SOURCES = ["client", "server", "db", "job", "integration"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];
export const ERROR_LEVELS = ["warning", "error", "fatal"] as const;
export type ErrorLevel = (typeof ERROR_LEVELS)[number];
export const ERROR_LEVEL_TONE: Record<ErrorLevel, Tone> = { warning: "warn", error: "bad", fatal: "bad" };
export const ERROR_STATUSES = ["open", "resolved", "ignored"] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];
export const ERROR_STATUS_TONE: Record<ErrorStatus, Tone> = { open: "warn", resolved: "ok", ignored: "neutral" };

export const OUTBOX_STATUSES = ["held", "queued", "sent", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
export const OUTBOX_STATUS_TONE: Record<OutboxStatus, Tone> = { held: "warn", queued: "info", sent: "ok", failed: "bad" };
export const OUTBOX_CHANNELS = ["sms", "whatsapp", "email", "push"] as const;
export type OutboxChannel = (typeof OUTBOX_CHANNELS)[number];

// ───────────────────────────────────────────────────────────────── the consistency checks (23.06)

export type CheckArea = "stock" | "wallet" | "journal" | "orders" | "money" | "other";

/**
 * What the daily checks of `consistency.daily` (app/server/jobs.server.ts) are about. `cost`: its numbers can be cost
 * data (a journal entry can be a cost-of-goods or inventory posting), so they reach only holders of cost.read. A check
 * added to the job later gets the generic explanation and its own English message; its key decides its area.
 */
export const CHECK_META: Readonly<Record<string, { area: CheckArea; cost: boolean }>> = {
  "stock.levels_vs_movements": { area: "stock", cost: false },
  "stock.reserved_vs_reservations": { area: "stock", cost: false },
  "wallet.ledger_vs_journal": { area: "wallet", cost: false },
  "wallet.negative_balance": { area: "wallet", cost: false },
  "journal.unbalanced_entries": { area: "journal", cost: true },
  "journal.orphan_lines": { area: "journal", cost: true },
  "orders.totals_vs_items": { area: "orders", cost: false },
  "orders.paid_vs_payments": { area: "orders", cost: false },
  "money.missing_postings": { area: "money", cost: false },
};

/** Keys whose values are cost or profit data wherever they appear (finding details, job counters). */
export const COST_KEY = /cost|cogs|landed|valuation|inventory_?value|margin|profit/i;
export const PROFIT_KEY = /margin|profit/i;

export function checkAreaOf(checkKey: string): CheckArea {
  const known = CHECK_META[checkKey];
  if (known) return known.area;
  const prefix = checkKey.split(".")[0] ?? "";
  return (["stock", "wallet", "journal", "orders", "money"] as const).find((area) => prefix === area || prefix.startsWith(area)) ?? "other";
}

/** True when the check's numbers are cost data (known checks, or a key that names cost). */
export function isCostCheck(checkKey: string): boolean {
  return CHECK_META[checkKey]?.cost ?? (COST_KEY.test(checkKey) || checkKey.startsWith("journal."));
}

/** True when the check's numbers are profit data. */
export function isProfitCheck(checkKey: string): boolean {
  return PROFIT_KEY.test(checkKey);
}

/**
 * True when the check's numbers are wallet money — a customer's balance, the total the store owes in wallets: they
 * reach only holders of customers.wallet.read or finance.wallet.read (the customer's and finance's wallet pages).
 */
export function isWalletCheck(checkKey: string): boolean {
  return checkAreaOf(checkKey) === "wallet";
}

// ───────────────────────────────────────────────────────────────── digits, days and times (Asia/Baghdad, UTC+3)

/** Arabic-Indic and Persian digits as 0–9 (a page number, a date or a time typed on an Arabic keyboard). */
export function latinDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

export const BAGHDAD_OFFSET_MS = 3 * HOUR_MS;

/** The Baghdad calendar day of an instant, "YYYY-MM-DD". */
export function baghdadDay(ms: number): string {
  return new Date(ms + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A calendar day "YYYY-MM-DD" (typed with any digits), or null. */
export function dayOf(value: string | null | undefined): string | null {
  const text = latinDigits(value ?? "").trim();
  if (!DAY_PATTERN.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== text ? null : text;
}

/** The first instant of a Baghdad calendar day. */
export const baghdadDayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - BAGHDAD_OFFSET_MS;
/** The last millisecond of a Baghdad calendar day (a due date means "by the end of that day"). */
export const baghdadDayEnd = (day: string) => baghdadDayStart(day) + DAY_MS - 1;

/** The calendar day `days` after `day` ("YYYY-MM-DD"; negative goes back). */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/;
/** "YYYY-MM-DDTHH:mm" as typed in a datetime-local field, in Baghdad time → epoch ms (null when not a real time). */
export function baghdadDateTime(value: string | null | undefined): number | null {
  const match = DATETIME_PATTERN.exec(latinDigits(value ?? "").trim());
  if (!match) return null;
  const day = dayOf(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!day || hour > 23 || minute > 59) return null;
  return baghdadDayStart(day) + hour * HOUR_MS + minute * MINUTE_MS;
}

/** An instant as the value of a datetime-local field, in Baghdad time ("YYYY-MM-DDTHH:mm"). */
export function toBaghdadInput(ms: number): string {
  return new Date(ms + BAGHDAD_OFFSET_MS).toISOString().slice(0, 16);
}

// ───────────────────────────────────────────────────────────────── URL state

const PAGE_MAX = 10_000;

export function pageOf(params: URLSearchParams): number {
  const value = Number(latinDigits(params.get("page") ?? "1"));
  return Number.isSafeInteger(value) && value >= 1 && value <= PAGE_MAX ? value : 1;
}

/** A free-text query: trimmed, at most 100 characters. */
export function queryOf(params: URLSearchParams, name = "q"): string {
  return (params.get(name) ?? "").trim().slice(0, 100);
}

/**
 * The LIKE patterns of a typed query (escaped, `ESCAPE '\'`): as typed, and — when it has Arabic-Indic or Persian
 * digits — with them as 0–9, because references, ids and the jobs' sentences are stored with Latin digits
 * ("INC-٠٠٠٧" finds INC-0007; a title written with Arabic digits is still found as typed).
 */
export function likePatterns(query: string): string[] {
  const escape = (text: string) => `%${text.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
  return [...new Set([query, latinDigits(query)])].map(escape);
}

/** "?a=1&b=2" from the non-empty values, or "" when there is none. */
export function searchOf(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  const out = params.toString();
  return out ? `?${out}` : "";
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** A job name or a check key as it may appear in a URL ("orders.expire_unpaid"): lower-case words and dots. */
const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
export const isKeyLike = (value: string | null | undefined): value is string => typeof value === "string" && value.length <= 80 && KEY_PATTERN.test(value);

/** The jobs list: every job, or only those that need attention (failing, stuck, late) — what the bell and the front page count. */
export const JOB_LIST_VIEWS = ["all", "attention"] as const;
export type JobListView = (typeof JOB_LIST_VIEWS)[number];
export const parseJobListView = (params: URLSearchParams): JobListView => oneOf(params.get("view"), JOB_LIST_VIEWS) ?? "all";

export type RunFilters = { job: string | null; status: RunStatus | null; origin: RunOrigin | null; page: number };
export function parseRunFilters(params: URLSearchParams): RunFilters {
  const job = params.get("job");
  return { job: isKeyLike(job) ? job : null, status: oneOf(params.get("status"), RUN_STATUSES), origin: oneOf(params.get("origin"), RUN_ORIGINS), page: pageOf(params) };
}
export const runSearch = (filters: Partial<RunFilters>) => searchOf({ job: filters.job, status: filters.status, origin: filters.origin, page: filters.page && filters.page > 1 ? filters.page : null });

export const FINDING_VIEWS = ["active", "open", "acknowledged", "resolved", "false_positive", "all"] as const;
export type FindingView = (typeof FINDING_VIEWS)[number];
export const FINDING_SORTS = ["severity", "last_seen", "detected", "occurrences"] as const;
export type FindingSort = (typeof FINDING_SORTS)[number];
export type FindingFilters = { view: FindingView; severity: FindingSeverity | null; check: string | null; assignee: string | null; q: string; sort: FindingSort; page: number };
export function parseFindingFilters(params: URLSearchParams): FindingFilters {
  const check = params.get("check");
  const assignee = params.get("assignee");
  return {
    view: oneOf(params.get("view"), FINDING_VIEWS) ?? "active",
    severity: oneOf(params.get("severity"), FINDING_SEVERITIES),
    check: isKeyLike(check) ? check : null,
    assignee: assignee === "me" || assignee === "none" || (assignee !== null && /^[a-z]+_[0-9A-Za-z]{6,40}$/.test(assignee)) ? assignee : null,
    q: queryOf(params),
    sort: oneOf(params.get("sort"), FINDING_SORTS) ?? "severity",
    page: pageOf(params),
  };
}
export const findingSearch = (filters: Partial<FindingFilters>) =>
  searchOf({
    view: filters.view && filters.view !== "active" ? filters.view : null,
    severity: filters.severity,
    check: filters.check,
    assignee: filters.assignee,
    q: filters.q,
    sort: filters.sort && filters.sort !== "severity" ? filters.sort : null,
    page: filters.page && filters.page > 1 ? filters.page : null,
  });

export const INCIDENT_VIEWS = ["active", "mine", "overdue", "resolved", "all"] as const;
export type IncidentView = (typeof INCIDENT_VIEWS)[number];
export const INCIDENT_SORTS = ["severity", "started", "target"] as const;
export type IncidentSort = (typeof INCIDENT_SORTS)[number];
export type IncidentFilters = { view: IncidentView; severity: IncidentSeverity | null; q: string; sort: IncidentSort; page: number };
export function parseIncidentFilters(params: URLSearchParams): IncidentFilters {
  return {
    view: oneOf(params.get("view"), INCIDENT_VIEWS) ?? "active",
    severity: oneOf(params.get("severity"), INCIDENT_SEVERITIES),
    q: queryOf(params),
    sort: oneOf(params.get("sort"), INCIDENT_SORTS) ?? "severity",
    page: pageOf(params),
  };
}
export const incidentSearch = (filters: Partial<IncidentFilters>) =>
  searchOf({
    view: filters.view && filters.view !== "active" ? filters.view : null,
    severity: filters.severity,
    q: filters.q,
    sort: filters.sort && filters.sort !== "severity" ? filters.sort : null,
    page: filters.page && filters.page > 1 ? filters.page : null,
  });

export const ERROR_VIEWS = ["open", "resolved", "ignored", "all"] as const;
export type ErrorView = (typeof ERROR_VIEWS)[number];
export const ERROR_WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type ErrorWindow = (typeof ERROR_WINDOWS)[number];
export const ERROR_WINDOW_MS: Record<ErrorWindow, number | null> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, all: null };
export const ERROR_SORTS = ["last_seen", "count", "first_seen"] as const;
export type ErrorSort = (typeof ERROR_SORTS)[number];
export type ErrorFilters = { view: ErrorView; source: ErrorSource | null; level: ErrorLevel | null; window: ErrorWindow; q: string; sort: ErrorSort; page: number };
export function parseErrorFilters(params: URLSearchParams): ErrorFilters {
  return {
    view: oneOf(params.get("view"), ERROR_VIEWS) ?? "open",
    source: oneOf(params.get("source"), ERROR_SOURCES),
    level: oneOf(params.get("level"), ERROR_LEVELS),
    window: oneOf(params.get("window"), ERROR_WINDOWS) ?? "all",
    q: queryOf(params),
    sort: oneOf(params.get("sort"), ERROR_SORTS) ?? "last_seen",
    page: pageOf(params),
  };
}
export const errorSearch = (filters: Partial<ErrorFilters>) =>
  searchOf({
    view: filters.view && filters.view !== "open" ? filters.view : null,
    source: filters.source,
    level: filters.level,
    window: filters.window && filters.window !== "all" ? filters.window : null,
    q: filters.q,
    sort: filters.sort && filters.sort !== "last_seen" ? filters.sort : null,
    page: filters.page && filters.page > 1 ? filters.page : null,
  });

export type OutboxFilters = { status: OutboxStatus | null; channel: OutboxChannel | null; template: string | null; page: number };
export function parseOutboxFilters(params: URLSearchParams): OutboxFilters {
  const template = params.get("template");
  return { status: oneOf(params.get("status"), OUTBOX_STATUSES), channel: oneOf(params.get("channel"), OUTBOX_CHANNELS), template: isKeyLike(template) ? template : null, page: pageOf(params) };
}
export const outboxSearch = (filters: Partial<OutboxFilters>) => searchOf({ status: filters.status, channel: filters.channel, template: filters.template, page: filters.page && filters.page > 1 ? filters.page : null });

export const PERF_WINDOWS = ["1d", "7d", "30d"] as const;
export type PerfWindow = (typeof PERF_WINDOWS)[number];
export const PERF_WINDOW_DAYS: Record<PerfWindow, number> = { "1d": 1, "7d": 7, "30d": 30 };
export const PERF_AREAS = ["admin", "storefront"] as const;
export type PerfArea = (typeof PERF_AREAS)[number];
export type PerfFilters = { window: PerfWindow; area: PerfArea };
export function parsePerfFilters(params: URLSearchParams): PerfFilters {
  return { window: oneOf(params.get("window"), PERF_WINDOWS) ?? "7d", area: oneOf(params.get("area"), PERF_AREAS) ?? "admin" };
}
export const perfSearch = (filters: Partial<PerfFilters>) => searchOf({ window: filters.window && filters.window !== "7d" ? filters.window : null, area: filters.area && filters.area !== "admin" ? filters.area : null });

// ───────────────────────────────────────────────────────────────── view models

export type Person = { id: string; name: string };

/** Who did something: an employee (by name), the system (a scheduled job) or nobody recorded. */
export type ActorView = { kind: "employee"; name: string } | { kind: "system"; job: string } | null;

export type JobRunView = {
  id: string;
  job: string;
  status: RunStatus;
  origin: RunOrigin;
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  /** Counters the job reported, cost and profit keys cut for employees without the permission. */
  stats: Record<string, unknown> | null;
  /** True when counters were withheld for this employee. */
  statsWithheld: boolean;
  error: string | null;
  triggeredBy: string | null;
};

export type JobView = {
  job: string;
  cron: string | null;
  /** The cron's kind: "frequent" (every 5 minutes), "daily" (00:30 UTC = 03:30 Baghdad), or null (not scheduled). */
  cadence: "frequent" | "daily" | null;
  /** Position in its cron's run order (1 = first). */
  order: number | null;
  health: JobHealth;
  last: JobRunView | null;
  lastSuccessAt: number | null;
  failures7d: number;
  /** Failed runs in a row, newest first, until the last run that did not fail. */
  streak: number;
  /** When the next run is due by its cron (null: not scheduled). */
  nextDueAt: number | null;
  known: boolean;
};

export type ImpactLine = { key: string; count: number | null; vars?: Record<string, string | number> };
export type JobPreview = { job: string; lines: ImpactLine[]; changesData: boolean };

export type OutboxRow = {
  id: string;
  channel: OutboxChannel;
  recipient: string;
  template: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
  nextAttemptAt: number | null;
  ref: { type: string; label: string; href: string | null } | null;
};

export type EntityView = { type: string | null; id: string | null; label: string | null; href: string | null };

export type FindingRow = {
  id: string;
  checkKey: string;
  area: CheckArea;
  known: boolean;
  severity: FindingSeverity;
  status: FindingStatus;
  entity: EntityView;
  /** The job's own sentence (English), null when its numbers are withheld from this employee. */
  message: string | null;
  details: Record<string, unknown> | null;
  /** True when this employee may not see the numbers (cost.read / profit.read). */
  withheld: boolean;
  occurrences: number;
  detectedAt: number;
  lastSeenAt: number;
  runId: string | null;
  assignee: (Person & { dueAt: number | null; taskId: string }) | null;
  resolvedBy: ActorView;
  resolvedAt: number | null;
  resolutionNote: string | null;
};

export type HistoryEvent = { id: string; at: number; action: string; by: ActorView; reason: string | null; before: unknown; after: unknown };

export type IncidentRow = {
  id: string;
  ref: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  owner: Person | null;
  targetAt: number | null;
  overdue: boolean;
  startedAt: number;
  detectedAt: number | null;
  mitigatedAt: number | null;
  resolvedAt: number | null;
  updatedAt: number;
};

export type LinkView = {
  kind: LinkKind;
  id: string;
  label: string;
  href: string | null;
  /** The record's state now (a finding's or error's status, a run's status), null when it no longer exists. */
  state: string | null;
  at: number;
  by: string | null;
};

export type TimelineItem =
  | { kind: "update"; id: string; at: number; by: string | null; status: IncidentStatus | null; note: string }
  | { kind: "event"; id: string; at: number; by: string | null; action: string; reason: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null };

export type ErrorRow = {
  id: string;
  source: ErrorSource;
  level: ErrorLevel;
  status: ErrorStatus;
  message: string;
  route: string | null;
  url: string | null;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** The incident it belongs to; `href` only for an employee who may read incidents. */
  incident: { id: string; ref: string; href: string | null } | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
};

export type PerfRow = {
  route: string;
  serverSlow: { count: number; avgMs: number | null; maxMs: number | null; poor: number };
  serverFailed: { count: number };
  loadSlow: { count: number; avgMs: number | null; maxMs: number | null; poor: number };
  navSlow: { count: number; avgMs: number | null; maxMs: number | null; poor: number };
  devices: Record<string, number>;
};
