/**
 * ops — branches, sales channels, integrations, API keys, webhooks, inbound events, workflow
 * automation, bulk import/export jobs and saved reports (admin modules 18, 19 and 21).
 *
 * Nothing here implies a working third-party connection: an `integrations` row stays `disabled`
 * until real credentials are configured, and its secret is stored encrypted (`secret_enc`, DATA_KEY).
 * Inbound webhooks are deduplicated on `inbound_events.id` ("<provider>:<event id>"), so a
 * re-delivered event cannot create a second order or journal entry (ARCHITECTURE §7.3).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { L10n } from "~/lib/locales";
import { at, flag, id, json, l10n, type Ref } from "../columns";
import { files } from "./core";
import { districts, governorates } from "./shipping";

// ───────────────────────────────────────────────────────────────── branches and channels (21.01, 21.06)

export const branches = sqliteTable(
  "branches",
  {
    id: id(),
    code: text("code").notNull(),
    name: l10n("name").notNull(),
    governorateId: text("governorate_id").references((): Ref => governorates.id),
    districtId: text("district_id").references((): Ref => districts.id),
    addressText: text("address_text"),
    phone: text("phone"),
    /** Opening hours as entered by the owner; shown as written. */
    hours: json<L10n>("hours"),
    isActive: flag("is_active").notNull().default(true),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("branches_code_uq").on(t.code),
    index("branches_governorate_idx").on(t.governorateId),
    index("branches_district_idx").on(t.districtId),
  ],
);
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;

export const CHANNEL_KINDS = ["online", "pos", "marketplace", "social"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * Sales channels. "web" and "pos" are built in (seeded, `is_system`) and match `orders.channel`;
 * further rows describe channels the owner adds later (marketplaces, social selling).
 */
export const channels = sqliteTable(
  "channels",
  {
    id: id(),
    key: text("key").notNull(),
    name: l10n("name").notNull(),
    kind: text("kind", { enum: CHANNEL_KINDS }).notNull().default("online"),
    isActive: flag("is_active").notNull().default(true),
    isSystem: flag("is_system").notNull().default(false),
    config: json<Record<string, unknown>>("config"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [uniqueIndex("channels_key_uq").on(t.key)],
);
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;

// ───────────────────────────────────────────────────────────────── integrations (21.05)

export const INTEGRATION_KINDS = ["payment", "shipping", "messaging", "marketplace", "accounting", "ai", "other"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
/** `disabled` until credentials exist; `sandbox` and `live` are set by an admin after a successful test call. */
export const INTEGRATION_STATUSES = ["disabled", "sandbox", "live"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const integrations = sqliteTable(
  "integrations",
  {
    id: id(),
    kind: text("kind", { enum: INTEGRATION_KINDS }).notNull(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: INTEGRATION_STATUSES }).notNull().default("disabled"),
    /** Non-secret settings (sender id, endpoint region…). */
    config: json<Record<string, unknown>>("config"),
    /** Credentials encrypted with DATA_KEY (AES-256-GCM). Never returned to the browser. */
    secretEnc: text("secret_enc"),
    lastOkAt: at("last_ok_at"),
    lastError: text("last_error"),
    lastErrorAt: at("last_error_at"),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [uniqueIndex("integrations_provider_uq").on(t.kind, t.provider)],
);
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;

// ───────────────────────────────────────────────────────────────── API keys and webhooks (21.03, 21.04)

/** API keys with scoped permissions. Only the sha256 of the key is stored; `prefix` identifies it in lists. */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    /** Permission strings the key may use — the same vocabulary as role permissions. */
    scopes: json<string[]>("scopes").notNull(),
    rateLimitPerMin: integer("rate_limit_per_min"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    lastUsedAt: at("last_used_at"),
    expiresAt: at("expires_at"),
    revokedAt: at("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_key_hash_uq").on(t.keyHash), index("api_keys_prefix_idx").on(t.prefix)],
);
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

/** Outgoing webhook subscriptions. Payloads are signed with the (encrypted) secret. */
export const webhooks = sqliteTable(
  "webhooks",
  {
    id: id(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    secretEnc: text("secret_enc").notNull(),
    /** Event names subscribed to, e.g. ["order.confirmed", "stock.low"]. */
    events: json<string[]>("events").notNull(),
    isActive: flag("is_active").notNull().default(true),
    failureCount: integer("failure_count").notNull().default(0),
    lastSuccessAt: at("last_success_at"),
    lastFailureAt: at("last_failure_at"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [index("webhooks_active_idx").on(t.isActive)],
);
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "succeeded", "failed", "gave_up"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** Delivery attempts with retry state. UNIQUE (webhook, event id) makes retries safe: one event, one delivery row. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: id(),
    webhookId: text("webhook_id")
      .notNull()
      .references((): Ref => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    eventId: text("event_id").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    status: text("status", { enum: WEBHOOK_DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: at("next_attempt_at"),
    responseStatus: integer("response_status"),
    lastError: text("last_error"),
    createdAt: at("created_at").notNull(),
    deliveredAt: at("delivered_at"),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_event_uq").on(t.webhookId, t.eventId),
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_created_at_idx").on(t.createdAt),
  ],
);
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;

export const INBOUND_EVENT_STATUSES = ["received", "processed", "ignored", "failed"] as const;
export type InboundEventStatus = (typeof INBOUND_EVENT_STATUSES)[number];

/**
 * Events received from providers. The primary key is "<provider>:<event id>": inserting it in the
 * same batch as the event's effects makes processing exactly-once.
 */
export const inboundEvents = sqliteTable(
  "inbound_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventType: text("event_type"),
    payload: json<Record<string, unknown>>("payload"),
    signatureOk: flag("signature_ok").notNull().default(false),
    status: text("status", { enum: INBOUND_EVENT_STATUSES }).notNull().default("received"),
    error: text("error"),
    receivedAt: at("received_at").notNull(),
    processedAt: at("processed_at"),
  },
  (t) => [index("inbound_events_provider_idx").on(t.provider, t.receivedAt), index("inbound_events_status_idx").on(t.status, t.receivedAt)],
);
export type InboundEvent = typeof inboundEvents.$inferSelect;
export type NewInboundEvent = typeof inboundEvents.$inferInsert;

// ───────────────────────────────────────────────────────────────── workflow automation (19.01, 19.07, 19.08)

/** `dry_run` records what a rule would have done without doing it; a rule must pass a dry run before it can be `active`. */
export const WORKFLOW_STATUSES = ["draft", "dry_run", "active", "paused"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export type WorkflowAction = { type: string; params?: Record<string, unknown> };

/**
 * Event + condition + action rules. Actions that move money or change prices beyond the configured
 * limits never run on their own: they create a row in `approvals` (`requires_approval`).
 */
export const workflows = sqliteTable(
  "workflows",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description"),
    /** Event name that triggers the rule, e.g. "stock.low", "order.placed", "ticket.created". */
    triggerEvent: text("trigger_event").notNull(),
    conditions: json<Record<string, unknown>>("conditions"),
    actions: json<WorkflowAction[]>("actions").notNull(),
    status: text("status", { enum: WORKFLOW_STATUSES }).notNull().default("draft"),
    requiresApproval: flag("requires_approval").notNull().default(false),
    runCount: integer("run_count").notNull().default(0),
    lastRunAt: at("last_run_at"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [index("workflows_trigger_idx").on(t.triggerEvent, t.status)],
);
export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;

export const WORKFLOW_RUN_STATUSES = ["skipped", "succeeded", "failed", "awaiting_approval"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** Execution log of a workflow (one row per triggering event). */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: id(),
    workflowId: text("workflow_id")
      .notNull()
      .references((): Ref => workflows.id, { onDelete: "cascade" }),
    refType: text("ref_type"),
    refId: text("ref_id"),
    event: json<Record<string, unknown>>("event"),
    isDryRun: flag("is_dry_run").notNull().default(false),
    status: text("status", { enum: WORKFLOW_RUN_STATUSES }).notNull(),
    /** What each action did (or would have done in a dry run). */
    actionsLog: json<Array<Record<string, unknown>>>("actions_log"),
    error: text("error"),
    startedAt: at("started_at").notNull(),
    finishedAt: at("finished_at"),
  },
  (t) => [index("workflow_runs_workflow_idx").on(t.workflowId, t.startedAt), index("workflow_runs_ref_idx").on(t.refType, t.refId)],
);
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;

// ───────────────────────────────────────────────────────────────── import / export / reports (02.06, 18.06)

export const IMPORT_JOB_STATUSES = ["uploaded", "validated", "applied", "failed", "rolled_back"] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/**
 * Bulk CSV imports with a preview of errors before anything is written, and a recorded undo.
 * `rollback` holds what is needed to restore the previous values of the rows the import touched.
 */
export const importJobs = sqliteTable(
  "import_jobs",
  {
    id: id(),
    /** "products", "prices", "stock", "statement_lines", … */
    kind: text("kind").notNull(),
    fileId: text("file_id").references((): Ref => files.id),
    status: text("status", { enum: IMPORT_JOB_STATUSES }).notNull().default("uploaded"),
    totalRows: integer("total_rows"),
    validRows: integer("valid_rows"),
    appliedRows: integer("applied_rows"),
    /** Per-row problems found by validation: `[{ row, field, message }]`. */
    errors: json<Array<{ row: number; field?: string; message: string }>>("errors"),
    rollback: json<Record<string, unknown>>("rollback"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    appliedAt: at("applied_at"),
    rolledBackAt: at("rolled_back_at"),
  },
  (t) => [index("import_jobs_kind_idx").on(t.kind, t.createdAt), index("import_jobs_file_idx").on(t.fileId)],
);
export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Saved report definitions and optional delivery schedule. */
export const savedReports = sqliteTable(
  "saved_reports",
  {
    id: id(),
    /** Which report, e.g. "sales.by_day", "margin.by_sku", "inventory.turnover". */
    reportKey: text("report_key").notNull(),
    name: text("name").notNull(),
    params: json<Record<string, unknown>>("params"),
    /** e.g. `{ every: "week", weekday: 0, hour: 9 }` in Asia/Baghdad; null = run on demand only. */
    schedule: json<Record<string, unknown>>("schedule"),
    /** Employee ids who receive the scheduled export. */
    recipients: json<string[]>("recipients"),
    format: text("format", { enum: EXPORT_FORMATS }).notNull().default("csv"),
    ownerId: text("owner_id"),
    isShared: flag("is_shared").notNull().default(false),
    lastRunAt: at("last_run_at"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [index("saved_reports_owner_idx").on(t.ownerId), index("saved_reports_key_idx").on(t.reportKey)],
);
export type SavedReport = typeof savedReports.$inferSelect;
export type NewSavedReport = typeof savedReports.$inferInsert;

export const EXPORT_JOB_STATUSES = ["queued", "running", "ready", "failed", "expired"] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

/**
 * Generated export files. `included_protected` records whether the requester held cost.read /
 * profit.read at export time — protected columns are absent from the file otherwise.
 */
export const exportJobs = sqliteTable(
  "export_jobs",
  {
    id: id(),
    reportKey: text("report_key").notNull(),
    savedReportId: text("saved_report_id").references((): Ref => savedReports.id, { onDelete: "set null" }),
    params: json<Record<string, unknown>>("params"),
    format: text("format", { enum: EXPORT_FORMATS }).notNull().default("csv"),
    status: text("status", { enum: EXPORT_JOB_STATUSES }).notNull().default("queued"),
    includedProtected: flag("included_protected").notNull().default(false),
    fileId: text("file_id").references((): Ref => files.id),
    rowCount: integer("row_count"),
    error: text("error"),
    requestedBy: text("requested_by"),
    createdAt: at("created_at").notNull(),
    finishedAt: at("finished_at"),
    expiresAt: at("expires_at"),
  },
  (t) => [
    index("export_jobs_requested_by_idx").on(t.requestedBy, t.createdAt),
    index("export_jobs_status_idx").on(t.status, t.createdAt),
    index("export_jobs_saved_report_idx").on(t.savedReportId),
    index("export_jobs_file_idx").on(t.fileId),
  ],
);
export type ExportJob = typeof exportJobs.$inferSelect;
export type NewExportJob = typeof exportJobs.$inferInsert;
