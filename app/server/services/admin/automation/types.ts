/**
 * Admin module 19 "automation" — URL state of the module's lists and the view models its pages render. Client-safe.
 *
 *   const filters = parseRuleFilters(new URL(request.url).searchParams);   // status, event, q, page
 *   <Link to={`/admin/automation/rules${ruleSearch({ ...filters, page: 2 })}`}>
 */
import {
  ACTION_TYPES,
  EVENT_TYPES,
  RULE_STATUSES,
  RUN_STATUSES,
  SUGGESTION_STATUSES,
  type ActionLogEntry,
  type ActionType,
  type EventType,
  type NoticeAudience,
  type RuleAction,
  type RuleMatch,
  type RuleStatus,
  type RunStatus,
  type SuggestionStatus,
} from "./catalog";

export const PAGE_SIZE = 25;

/** Error codes of the module's own services (texts: admin-automation → errors.*). */
export const AUTOMATION_ERROR_KEYS = [
  "rule_changed",
  "rule_not_found",
  "dry_run_required",
  "dry_run_stale",
  "author_cannot_activate",
  "rule_not_activatable",
  "rule_not_active",
  "rule_not_paused",
  "branch_limited",
  "suggestion_changed",
  "suggestion_not_open",
  "suggestions_mixed",
  "nothing_selected",
  "too_many",
  "notice_unknown",
  "idempotency_mismatch",
] as const;
export type AutomationErrorKey = (typeof AUTOMATION_ERROR_KEYS)[number];

const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null => (value !== null && (list as readonly string[]).includes(value) ? (value as T) : null);
const pageOf = (raw: string | null): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
};
const cleanQ = (raw: string | null): string => (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
const search = (entries: [string, string | number | null | undefined | false][]): string => {
  const params = new URLSearchParams();
  for (const [key, value] of entries) if (value !== null && value !== undefined && value !== false && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
};

// ───────────────────────────────────────────────────────────────── rules

/** `ready`: only the rules the viewer may switch on now (a fresh dry run of a version someone else wrote). */
export type RuleFilters = { status: RuleStatus | null; event: EventType | null; q: string; page: number; ready: boolean };
export function parseRuleFilters(params: URLSearchParams): RuleFilters {
  const ready = params.get("ready") === "1";
  return { status: ready ? null : oneOf(RULE_STATUSES, params.get("status")), event: oneOf(EVENT_TYPES, params.get("event")), q: cleanQ(params.get("q")), page: pageOf(params.get("page")), ready };
}
export function ruleSearch(filters: Partial<RuleFilters>): string {
  return search([
    ["status", filters.ready ? null : filters.status],
    ["ready", filters.ready ? 1 : null],
    ["event", filters.event],
    ["q", filters.q],
    ["page", filters.page && filters.page > 1 ? filters.page : null],
  ]);
}

/**
 * Where the module's counts lead: the front page's decisions and figures and the admin bell (QUEUE_HREFS) open these,
 * and each list shows exactly what its count counted (tests/admin-automation-review.test.ts).
 */
export const AUTOMATION_LINKS = {
  suggestions: "/admin/automation/suggestions",
  rulesToActivate: "/admin/automation/rules?ready=1",
  failedRuns: "/admin/automation/runs?status=failed&days=1",
  runs24h: "/admin/automation/runs?days=1",
  notices: "/admin/automation#notices",
} as const;

export type PersonView = { id: string; name: string } | { system: string } | null;

export type DryRunSummary = {
  version: number;
  at: number;
  by: string | null;
  days: number;
  /** Events read in the window, and how many met the conditions. */
  considered: number;
  matched: number;
  /** The window held more events than a dry run reads (DRY_RUN_MAX_EVENTS). */
  truncated: boolean;
  /** Per action: how many it would have done, and how many it would have skipped. */
  actions: Partial<Record<ActionType, { would: number; skip: number }>>;
  /** Why events did not count, per condition. */
  failed: Partial<Record<string, number>>;
  /** Stock rules read the stock as it is now (levels in the past are not rebuilt). */
  stockNow: boolean;
};

export type RuleRow = {
  id: string;
  name: string;
  event: EventType;
  status: RuleStatus;
  version: number;
  demo: boolean;
  actions: ActionType[];
  runCount: number;
  lastRunAt: number | null;
  updatedAt: number;
  author: PersonView;
  /** The current version passed a dry run that is still fresh. */
  dryRunReady: boolean;
};

/** `readyCount`: the rules the viewer may switch on now (null without automation.workflow.activate, or branch-limited). */
export type RulePage = { rows: RuleRow[]; total: number; page: number; pageCount: number; counts: Record<RuleStatus | "all", number>; readyCount: number | null };

export type RuleVersion = { version: number; at: number; by: PersonView; reason: string | null; definition: { event: EventType; match: RuleMatch; actions: RuleAction[]; name: string; description: string | null } | null };

export type RunView = {
  id: string;
  ruleId: string;
  ruleName: string;
  isDryRun: boolean;
  status: RunStatus;
  at: number;
  event: { type: EventType | null; key: string | null; label: string | null; at: number | null; version: number | null; href: string | null; isDemo: boolean; facts: Record<string, string | number | boolean | null> };
  actions: (ActionLogEntry & { href?: string | null; who?: string | null })[];
  error: string | null;
};

export type RuleDetail = {
  id: string;
  name: string;
  description: string | null;
  event: EventType;
  match: RuleMatch;
  actions: RuleAction[];
  status: RuleStatus;
  version: number;
  demo: boolean;
  updatedAt: number;
  createdAt: number;
  author: PersonView;
  activation: { version: number; at: number; by: PersonView } | null;
  pause: { at: number; by: PersonView; reason: string | null } | null;
  dryRun: (DryRunSummary & { byName: PersonView; fresh: boolean; current: boolean }) | null;
  samples: RunView[];
  recent: RunView[];
  runCount: number;
  lastRunAt: number | null;
  versions: RuleVersion[];
  /** Names of the people and places the conditions and actions refer to. */
  names: { assignee: string | null; assigneeActive: boolean; governorate: string | null; location: string | null };
  can: { manage: boolean; dryRun: boolean; activate: boolean; pause: boolean; activateBlocked: "dry_run_required" | "dry_run_stale" | "author_cannot_activate" | "branch_limited" | null };
};

export type RuleFormOptions = {
  employees: { value: string; label: string }[];
  governorates: { value: string; label: string }[];
  locations: { value: string; label: string }[];
};

// ───────────────────────────────────────────────────────────────── runs (the execution log)

export const RUN_KINDS = ["real", "dry", "all"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
/** Runs that started in the last 1 / 7 / 30 days (null: any time). */
export const RUN_DAYS = [1, 7, 30] as const;
export type RunDays = (typeof RUN_DAYS)[number];
export type RunFilters = { rule: string | null; status: RunStatus | null; kind: RunKind; days: RunDays | null; page: number };
const RULE_ID = /^[A-Za-z0-9_-]{3,64}$/;
export function parseRunFilters(params: URLSearchParams): RunFilters {
  const rule = params.get("rule");
  const days = Number(params.get("days"));
  return {
    rule: rule && RULE_ID.test(rule) ? rule : null,
    status: oneOf(RUN_STATUSES, params.get("status")),
    kind: oneOf(RUN_KINDS, params.get("kind")) ?? "real",
    days: (RUN_DAYS as readonly number[]).includes(days) ? (days as RunDays) : null,
    page: pageOf(params.get("page")),
  };
}
export function runSearch(filters: Partial<RunFilters>): string {
  return search([
    ["rule", filters.rule],
    ["status", filters.status],
    ["kind", filters.kind && filters.kind !== "real" ? filters.kind : null],
    ["days", filters.days],
    ["page", filters.page && filters.page > 1 ? filters.page : null],
  ]);
}
export type RunPage = { rows: RunView[]; total: number; page: number; pageCount: number; rules: { value: string; label: string }[] };

// ───────────────────────────────────────────────────────────────── notices

export type NoticeView = { runId: string; at: number; ruleId: string; ruleName: string; audience: NoticeAudience; event: RunView["event"] };

// ───────────────────────────────────────────────────────────────── reorder suggestions (19.02)

export const SUGGESTION_VIEWS = ["open", "approved", "dismissed", "all"] as const;
export type SuggestionView = (typeof SUGGESTION_VIEWS)[number];
export type SuggestionFilters = { view: SuggestionView; q: string; page: number };
export function parseSuggestionFilters(params: URLSearchParams): SuggestionFilters {
  return { view: oneOf(SUGGESTION_VIEWS, params.get("view")) ?? "open", q: cleanQ(params.get("q")), page: pageOf(params.get("page")) };
}
export function suggestionSearch(filters: Partial<SuggestionFilters>): string {
  return search([
    ["view", filters.view && filters.view !== "open" ? filters.view : null],
    ["q", filters.q],
    ["page", filters.page && filters.page > 1 ? filters.page : null],
  ]);
}

export type SuggestionBasis = {
  status: string;
  available: number;
  incoming: number;
  reorderPoint: number | null;
  reorderQty: number | null;
  sold30: number;
  sold90: number;
  rate: { basis: string; perDay: number | null; days: number };
  daysOfCover: number | null;
  stockOutAt: number | null;
  demo: boolean;
  source: "scan" | "rule";
  ruleId?: string | null;
};

export type SuggestionRow = {
  id: string;
  status: SuggestionStatus;
  variant: { id: string; sku: string; name: string };
  qty: number;
  basis: SuggestionBasis | null;
  supplier: { id: string; name: string } | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: PersonView;
  dismissReason: string | null;
  /** The draft order made from it, with its status now (09). */
  order: { id: string; ref: string | null; status: string | null; href: string | null } | null;
  demo: boolean;
};

export type SuggestionPage = {
  rows: SuggestionRow[];
  total: number;
  page: number;
  pageCount: number;
  counts: Record<SuggestionView, number>;
  lastScanAt: number | null;
  /** SKUs that are out / at their reorder point / running out but have no honest quantity (no rate, no reorder quantity) — null without inventory.stock.read. */
  withoutQuantity: number | null;
};

export type DraftOrderLine = { suggestionId: string; variantId: string; sku: string; name: string; qty: number; lastUnitCost: { currency: string; minor: number; decimals: number } | null };
export type DraftOrderForm = {
  lines: DraftOrderLine[];
  suppliers: { value: string; label: string; currency: string }[];
  locations: { value: string; label: string }[];
  supplierId: string | null;
  locationId: string | null;
  currency: string;
  demo: boolean;
  /** Suggestions asked for that are no longer open (decided meanwhile, or unknown). */
  skipped: number;
  missingPermissions: string[];
};

// ───────────────────────────────────────────────────────────────── demand forecast (19.05)

export const FORECAST_VIEWS = ["all", "forecast", "short", "launch"] as const;
export type ForecastView = (typeof FORECAST_VIEWS)[number];
export type ForecastFilters = { view: ForecastView; q: string; page: number };
export function parseForecastFilters(params: URLSearchParams): ForecastFilters {
  return { view: oneOf(FORECAST_VIEWS, params.get("view")) ?? "all", q: cleanQ(params.get("q")), page: pageOf(params.get("page")) };
}
export function forecastSearch(filters: Partial<ForecastFilters>): string {
  return search([
    ["view", filters.view && filters.view !== "all" ? filters.view : null],
    ["q", filters.q],
    ["page", filters.page && filters.page > 1 ? filters.page : null],
  ]);
}

// ───────────────────────────────────────────────────────────────── ticket topics (19.03)

export const TICKET_VIEWS = ["differs", "all"] as const;
export type TicketView = (typeof TICKET_VIEWS)[number];
export type TicketFilters = { view: TicketView; page: number };
export function parseTicketView(params: URLSearchParams): TicketView {
  return params.get("view") === "all" ? "all" : "differs";
}
export function parseTicketFilters(params: URLSearchParams): TicketFilters {
  return { view: parseTicketView(params), page: pageOf(params.get("page")) };
}
/** "?view=all&page=2" (the default view and page 1 left out). */
export function ticketSearch(filters: Partial<TicketFilters>): string {
  return search([
    ["view", filters.view === "all" ? "all" : null],
    ["page", filters.page && filters.page > 1 ? filters.page : null],
  ]);
}

// ───────────────────────────────────────────────────────────────── unusual transactions (19.04)

export type AnomalyFilters = { demo: boolean };

/** The thresholds of the module's own checks (anomalies.server.ts), shown on the page next to what they find. */
export const ANOMALY_RULES = {
  windowDays: 30,
  historyDays: 90,
  refundFloorIqd: 250_000,
  refundFactor: 3,
  minHistory: 5,
  discountShareBps: 2500,
  discountFloorIqd: 25_000,
  orderFactor: 5,
  minOrders: 20,
  costJumpBps: 2500,
  costWindowDays: 90,
  maxFindings: 50,
} as const;

export type OwnCheckKey = "refund.large" | "order.discount_high" | "order.value_outlier" | "cost.jump";
export type OwnFinding = { id: string; at: number; label: string; href: string | null; values: Record<string, number | string | null>; demo: boolean };
/** `findings`: the largest ANOMALY_RULES.maxFindings; `total`: every record the check found (never the listed count alone). */
export type OwnCheck = { check: OwnCheckKey; status: "ok" | "found" | "needs_cost" | "short_history"; threshold: Record<string, number | null>; findings: OwnFinding[]; total: number };
export function parseAnomalyFilters(params: URLSearchParams): AnomalyFilters {
  return { demo: params.get("demo") === "1" };
}

export { ACTION_TYPES, EVENT_TYPES, RULE_STATUSES, RUN_STATUSES, SUGGESTION_STATUSES };
