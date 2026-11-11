/**
 * core — settings, the immutable audit trail, files, the notification outbox, rate limits and
 * the operational tables behind admin module 23 (jobs, errors, incidents, consistency checks).
 *
 * [A] = append-only: SQL triggers in drizzle/0001_invariants.sql reject UPDATE and DELETE.
 *
 * Not declared here on purpose (plain SQL, see drizzle/0001_invariants.sql and 0002_search.sql):
 *   _tx_guard      batch guard table used by ~/server/db/tx.server
 *   search_index   FTS5 product search table used by ~/server/db/search.server
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ACTOR_KINDS, NOW_MS, at, flag, id, json, type Ref } from "../columns";

// ───────────────────────────────────────────────────────────────── settings

/** Key/value store configuration (ARCHITECTURE §10). `value` is any JSON value. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: at("updated_at").notNull(),
  /** Employee id; null for seeded defaults. */
  updatedBy: text("updated_by"),
});
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;

/**
 * Gap-free counters for human document numbers (invoice numbers, …):
 * `UPDATE sequences SET value = value + 1 WHERE name = ? RETURNING value` inside the writing batch.
 */
export const sequences = sqliteTable("sequences", {
  name: text("name").primaryKey(),
  value: integer("value").notNull().default(0),
});
export type Sequence = typeof sequences.$inferSelect;

// ───────────────────────────────────────────────────────────────── audit [A]

/**
 * [A] Immutable audit trail. `seq` gives a strict order for the hash chain in `audit_seals`;
 * `id` is the public identifier. Written through ~/server/audit.server only.
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    at: at("at").notNull(),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    /** Display name at the time of the event (names change, the trail must not). */
    actorLabel: text("actor_label"),
    /** `<module>.<resource>.<verb>` e.g. "inventory.stock.adjust". */
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    summary: text("summary"),
    before: json<unknown>("before"),
    after: json<unknown>("after"),
    reason: text("reason"),
    ip: text("ip"),
    requestId: text("request_id"),
  },
  (t) => [
    uniqueIndex("audit_events_id_uq").on(t.id),
    index("audit_events_entity_idx").on(t.entityType, t.entityId, t.seq),
    index("audit_events_actor_idx").on(t.actorKind, t.actorId, t.seq),
    index("audit_events_action_idx").on(t.action, t.seq),
    index("audit_events_at_idx").on(t.at),
    index("audit_events_request_idx").on(t.requestId),
  ],
);
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;

/** [A] Hash-chain checkpoints over `audit_events` (`hash` covers seq from..to and `prev_hash`). */
export const auditSeals = sqliteTable(
  "audit_seals",
  {
    id: id(),
    fromSeq: integer("from_seq").notNull(),
    toSeq: integer("to_seq").notNull(),
    hash: text("hash").notNull(),
    prevHash: text("prev_hash"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [uniqueIndex("audit_seals_from_seq_uq").on(t.fromSeq), uniqueIndex("audit_seals_to_seq_uq").on(t.toSeq)],
);
export type AuditSeal = typeof auditSeals.$inferSelect;
export type NewAuditSeal = typeof auditSeals.$inferInsert;

export const AUTH_SUBJECT_KINDS = ["customer", "employee"] as const;
export type AuthSubjectKind = (typeof AUTH_SUBJECT_KINDS)[number];

/** Sign-in and verification attempts (admin module 20.08). Prunable security log — not the audit trail. */
export const authEvents = sqliteTable(
  "auth_events",
  {
    id: id(),
    subjectKind: text("subject_kind", { enum: AUTH_SUBJECT_KINDS }).notNull(),
    /** Null when the identifier did not match an account. */
    subjectId: text("subject_id"),
    /** What was typed: normalized phone or lower-cased email. */
    identifier: text("identifier"),
    /** e.g. "login", "mfa", "otp", "password_reset", "lockout", "session_revoked". */
    kind: text("kind").notNull(),
    success: flag("success").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    details: json<Record<string, unknown>>("details"),
    at: at("at").notNull(),
  },
  (t) => [
    index("auth_events_subject_idx").on(t.subjectKind, t.subjectId, t.at),
    index("auth_events_identifier_idx").on(t.identifier, t.at),
    index("auth_events_ip_idx").on(t.ip, t.at),
    index("auth_events_at_idx").on(t.at),
  ],
);
export type AuthEvent = typeof authEvents.$inferSelect;
export type NewAuthEvent = typeof authEvents.$inferInsert;

// ───────────────────────────────────────────────────────────────── files

export const FILE_VISIBILITIES = ["public", "private"] as const;
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

/**
 * Metadata for every stored blob (the bytes live behind ~/server/storage.server).
 * Private files (payment proofs, used-device photos before listing, documents) are only served
 * through an authorized route.
 */
export const files = sqliteTable(
  "files",
  {
    id: id(),
    storageKey: text("storage_key").notNull(),
    visibility: text("visibility", { enum: FILE_VISIBILITIES }).notNull().default("private"),
    /** Open vocabulary owned by the storage service, e.g. "payment_proof", "used_photo", "product_image". */
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    ownerType: text("owner_type"),
    ownerId: text("owner_id"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    createdByKind: text("created_by_kind", { enum: ACTOR_KINDS }),
    /** Sanitized original file name, for staff display only. */
    originalName: text("original_name"),
    /** Set when the blob has been removed from storage (retention, privacy request). */
    deletedAt: at("deleted_at"),
  },
  (t) => [
    uniqueIndex("files_storage_key_uq").on(t.storageKey),
    index("files_sha256_idx").on(t.sha256),
    index("files_owner_idx").on(t.ownerType, t.ownerId),
    index("files_kind_idx").on(t.kind, t.createdAt),
  ],
);
export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;

// ───────────────────────────────────────────────────────────────── outbox

export const OUTBOX_CHANNELS = ["sms", "whatsapp", "email", "push"] as const;
export type OutboxChannel = (typeof OUTBOX_CHANNELS)[number];
/** `held` = written but not sent because no provider is configured for the channel (never a fake "sent"). */
export const OUTBOX_STATUSES = ["held", "queued", "sent", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Outgoing customer/staff messages. Also the communication log shown on orders and customers (07.07). */
export const outbox = sqliteTable(
  "outbox",
  {
    id: id(),
    channel: text("channel", { enum: OUTBOX_CHANNELS }).notNull(),
    recipient: text("recipient").notNull(),
    template: text("template").notNull(),
    payload: json<Record<string, unknown>>("payload"),
    status: text("status", { enum: OUTBOX_STATUSES }).notNull().default("held"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: at("created_at").notNull(),
    sentAt: at("sent_at"),
    locale: text("locale"),
    customerId: text("customer_id"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    /** Optional idempotency key: the same notification is never queued twice. */
    dedupeKey: text("dedupe_key"),
    nextAttemptAt: at("next_attempt_at"),
    providerMessageId: text("provider_message_id"),
  },
  (t) => [
    index("outbox_status_idx").on(t.status, t.nextAttemptAt),
    index("outbox_recipient_idx").on(t.recipient, t.createdAt),
    index("outbox_customer_idx").on(t.customerId, t.createdAt),
    index("outbox_ref_idx").on(t.refType, t.refId),
    index("outbox_created_at_idx").on(t.createdAt),
    uniqueIndex("outbox_dedupe_key_uq").on(t.dedupeKey),
  ],
);
export type OutboxMessage = typeof outbox.$inferSelect;
export type NewOutboxMessage = typeof outbox.$inferInsert;

/** Editable message and document templates (admin module 22.04). `outbox.template` refers to `key`. */
export const messageTemplates = sqliteTable(
  "message_templates",
  {
    id: id(),
    key: text("key").notNull(),
    /** An outbox channel, or "print" for invoices, receipts and labels. */
    channel: text("channel").notNull(),
    locale: text("locale").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    /** Names of the variables the body may use — anything else is rejected at save time. */
    variables: json<string[]>("variables"),
    isActive: flag("is_active").notNull().default(true),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [uniqueIndex("message_templates_key_uq").on(t.key, t.channel, t.locale)],
);
export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type NewMessageTemplate = typeof messageTemplates.$inferInsert;

// ───────────────────────────────────────────────────────────────── rate limits

/** Fixed-window counters. Lives in D1 (not KV) because KV's free tier allows very few writes. */
export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limits_window_idx").on(t.windowStart)],
);
export type RateLimit = typeof rateLimits.$inferSelect;
export type NewRateLimit = typeof rateLimits.$inferInsert;

// ───────────────────────────────────────────────────────────────── operations (module 23)

export const JOB_RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];
export const JOB_RUN_ORIGINS = ["cron", "manual", "event"] as const;
export type JobRunOrigin = (typeof JOB_RUN_ORIGINS)[number];

/** One row per execution of a background job (reservation expiry, backups, consistency checks, …). */
export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: id(),
    job: text("job").notNull(),
    status: text("status", { enum: JOB_RUN_STATUSES }).notNull().default("running"),
    /** What started the run. */
    origin: text("origin", { enum: JOB_RUN_ORIGINS }).notNull().default("cron"),
    attempt: integer("attempt").notNull().default(1),
    startedAt: at("started_at").notNull(),
    finishedAt: at("finished_at"),
    durationMs: integer("duration_ms"),
    /** Counters reported by the job, e.g. `{ released: 3 }`. */
    stats: json<Record<string, unknown>>("stats"),
    error: text("error"),
    /** Employee id for manual runs. */
    triggeredBy: text("triggered_by"),
  },
  (t) => [index("job_runs_job_idx").on(t.job, t.startedAt), index("job_runs_status_idx").on(t.status, t.startedAt)],
);
export type JobRun = typeof jobRuns.$inferSelect;
export type NewJobRun = typeof jobRuns.$inferInsert;

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATUSES = ["open", "investigating", "mitigated", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Incident centre (23.05): every incident has an owner and a resolution date. */
export const incidents = sqliteTable(
  "incidents",
  {
    id: id(),
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    severity: text("severity", { enum: INCIDENT_SEVERITIES }).notNull().default("sev3"),
    status: text("status", { enum: INCIDENT_STATUSES }).notNull().default("open"),
    summary: text("summary"),
    impact: text("impact"),
    rootCause: text("root_cause"),
    /** Employee responsible for driving it to resolution. */
    ownerId: text("owner_id"),
    startedAt: at("started_at").notNull(),
    detectedAt: at("detected_at"),
    mitigatedAt: at("mitigated_at"),
    resolvedAt: at("resolved_at"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("incidents_ref_uq").on(t.ref),
    index("incidents_status_idx").on(t.status, t.startedAt),
    index("incidents_owner_idx").on(t.ownerId),
  ],
);
export type Incident = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;

/** Timeline of an incident. */
export const incidentUpdates = sqliteTable(
  "incident_updates",
  {
    id: id(),
    incidentId: text("incident_id")
      .notNull()
      .references((): Ref => incidents.id, { onDelete: "cascade" }),
    status: text("status", { enum: INCIDENT_STATUSES }),
    note: text("note").notNull(),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [index("incident_updates_incident_idx").on(t.incidentId, t.createdAt)],
);
export type IncidentUpdate = typeof incidentUpdates.$inferSelect;
export type NewIncidentUpdate = typeof incidentUpdates.$inferInsert;

export const ERROR_REPORT_SOURCES = ["client", "server", "db", "job", "integration"] as const;
export type ErrorReportSource = (typeof ERROR_REPORT_SOURCES)[number];
export const ERROR_REPORT_LEVELS = ["warning", "error", "fatal"] as const;
export type ErrorReportLevel = (typeof ERROR_REPORT_LEVELS)[number];
export const ERROR_REPORT_STATUSES = ["open", "resolved", "ignored"] as const;
export type ErrorReportStatus = (typeof ERROR_REPORT_STATUSES)[number];

/** Front-end, server and database errors (23.01), grouped by fingerprint so repeats cost one row. */
export const errorReports = sqliteTable(
  "error_reports",
  {
    id: id(),
    fingerprint: text("fingerprint").notNull(),
    source: text("source", { enum: ERROR_REPORT_SOURCES }).notNull(),
    level: text("level", { enum: ERROR_REPORT_LEVELS }).notNull().default("error"),
    message: text("message").notNull(),
    stack: text("stack"),
    route: text("route"),
    url: text("url"),
    release: text("release"),
    /** Context of the most recent occurrence: request id, user agent, actor kind — never personal data. */
    sample: json<Record<string, unknown>>("sample"),
    count: integer("count").notNull().default(1),
    firstSeenAt: at("first_seen_at").notNull(),
    lastSeenAt: at("last_seen_at").notNull(),
    status: text("status", { enum: ERROR_REPORT_STATUSES }).notNull().default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: at("resolved_at"),
    incidentId: text("incident_id").references((): Ref => incidents.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("error_reports_fingerprint_uq").on(t.fingerprint),
    index("error_reports_status_idx").on(t.status, t.lastSeenAt),
    index("error_reports_source_idx").on(t.source, t.lastSeenAt),
    index("error_reports_incident_idx").on(t.incidentId),
  ],
);
export type ErrorReport = typeof errorReports.$inferSelect;
export type NewErrorReport = typeof errorReports.$inferInsert;

export const FINDING_SEVERITIES = ["info", "warning", "critical"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_STATUSES = ["open", "acknowledged", "resolved", "false_positive"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * Results of the daily stock / payment / profit consistency checks (23.06) and of anomaly
 * detection (19.04). `fingerprint` identifies "the same problem" across runs, so a finding that
 * persists is updated (`last_seen_at`, `occurrences`) instead of duplicated.
 */
export const consistencyFindings = sqliteTable(
  "consistency_findings",
  {
    id: id(),
    fingerprint: text("fingerprint").notNull(),
    /** e.g. "stock.levels_vs_movements", "payments.paid_vs_orders", "journal.orphan_lines". */
    checkKey: text("check_key").notNull(),
    severity: text("severity", { enum: FINDING_SEVERITIES }).notNull().default("warning"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    message: text("message").notNull(),
    /** Expected vs. actual numbers and anything else needed to investigate. */
    details: json<Record<string, unknown>>("details"),
    status: text("status", { enum: FINDING_STATUSES }).notNull().default("open"),
    occurrences: integer("occurrences").notNull().default(1),
    detectedAt: at("detected_at").notNull(),
    lastSeenAt: at("last_seen_at").notNull(),
    runId: text("run_id").references((): Ref => jobRuns.id, { onDelete: "set null" }),
    resolvedBy: text("resolved_by"),
    resolvedAt: at("resolved_at"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    uniqueIndex("consistency_findings_fingerprint_uq").on(t.fingerprint),
    index("consistency_findings_status_idx").on(t.status, t.severity, t.lastSeenAt),
    index("consistency_findings_check_idx").on(t.checkKey, t.lastSeenAt),
    index("consistency_findings_entity_idx").on(t.entityType, t.entityId),
    index("consistency_findings_run_idx").on(t.runId),
  ],
);
export type ConsistencyFinding = typeof consistencyFindings.$inferSelect;
export type NewConsistencyFinding = typeof consistencyFindings.$inferInsert;

export const PERF_AREAS = ["storefront", "admin"] as const;
export type PerfArea = (typeof PERF_AREAS)[number];
export const PERF_DEVICES = ["mobile", "tablet", "desktop", "unknown"] as const;
export type PerfDevice = (typeof PERF_DEVICES)[number];

/**
 * Measured page performance and failure rates (23.02), pre-aggregated per day so recording a
 * sample is one upsert. `sum_value` and `max_value` are integers in the metric's unit:
 * milliseconds for timings, value × 1000 for CLS. Rating buckets follow the Web Vitals thresholds.
 */
export const perfRollups = sqliteTable(
  "perf_rollups",
  {
    /** Asia/Baghdad calendar day, "YYYY-MM-DD". */
    day: text("day").notNull(),
    area: text("area", { enum: PERF_AREAS }).notNull(),
    /** Route pattern (never a concrete URL with ids). */
    route: text("route").notNull(),
    /** "LCP" | "INP" | "CLS" | "TTFB" | "server_ms" | "error" … */
    metric: text("metric").notNull(),
    device: text("device", { enum: PERF_DEVICES }).notNull().default("unknown"),
    samples: integer("samples").notNull().default(0),
    sumValue: integer("sum_value").notNull().default(0),
    maxValue: integer("max_value").notNull().default(0),
    good: integer("good").notNull().default(0),
    needsImprovement: integer("needs_improvement").notNull().default(0),
    poor: integer("poor").notNull().default(0),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [primaryKey({ columns: [t.day, t.area, t.route, t.metric, t.device] }), index("perf_rollups_metric_idx").on(t.metric, t.day)],
);
export type PerfRollup = typeof perfRollups.$inferSelect;
export type NewPerfRollup = typeof perfRollups.$inferInsert;
