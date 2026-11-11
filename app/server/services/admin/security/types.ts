/**
 * Admin module 20 "security" — client-safe pieces: the URL state of every list (filters and pages work without
 * JavaScript), thresholds of the alerts, intervals of the periodic checks, the error keys, and the view-model types the
 * route modules render. No server imports here (route components import this file).
 */
import type { Permission } from "~/server/permissions";

export const SECURITY_ERROR_KEYS = [
  "reason_required",
  "own_account_here",
  "two_step_not_on",
  "role_locked",
  "role_changed",
  "own_role",
  "own_roles",
  "wildcard_owner_only",
  "grant_exceeds_own",
  "revoke_exceeds_own",
  "target_more_privileged",
  "role_key_taken",
  "no_change",
  "roles_changed",
  "last_owner",
  "branch_unknown",
  "reviewer_involved",
  "restore_test_future",
  "chain_verify_failed",
] as const;

/** The field-level permissions (same list as FIELD_PERMISSIONS in ~/server/permissions — a test keeps them equal). */
export const FIELD_KEYS = ["cost.read", "profit.read", "customer.phone.read_full", "payment_proof.read", "digital_code.reveal"] as const;

/** A role nobody reviewed for this long is due again (20.07). */
export const ACCESS_REVIEW_INTERVAL_DAYS = 90;
/** A restore test older than this is due again (20.05). */
export const RESTORE_TEST_INTERVAL_DAYS = 90;
/** Cloudflare D1 Time Travel keeps this many days of history on the Workers Paid plan (7 on the free plan). */
export const TIME_TRAVEL_DAYS = 30;

/** When a sign-in pattern becomes an alert (20.08). Each alert names its rule and its numbers, never a guess. */
export const SIGNIN_THRESHOLDS = {
  /** Failed passwords or codes for one email or phone in the window. */
  identifierFailures: 5,
  /** Failed attempts from one address in the window. */
  ipFailures: 10,
  /** Emails that match no account, typed from one address in the window (spraying). */
  unknownFromIp: 5,
  /** Wrong second-step codes for one employee in the window. */
  mfaFailures: 3,
  /** A sign-in from an address this employee has not signed in from in the last … days. */
  newAddressDays: 90,
} as const;

export const SIGNIN_RULES = ["lockout", "identifier_failures", "ip_failures", "unknown_spray", "disabled_account", "mfa_failures", "two_step_off_refused", "new_address"] as const;
export type SigninRule = (typeof SIGNIN_RULES)[number];

/** When a refund is shown for a second look (20.08). */
export const REFUND_THRESHOLDS = {
  /** A refund of at least this amount. */
  highValueIqd: 1_000_000,
  /** One employee asked for at least this many refunds within 24 hours. */
  burstCount: 3,
  /** The order's customer (or phone) had at least this many other refunds within 90 days. */
  repeatCount: 2,
} as const;

export const REFUND_SIGNALS = ["high_value", "other_method", "one_person", "burst", "repeat_customer"] as const;
export type RefundSignal = (typeof REFUND_SIGNALS)[number];
export const REFUND_REVIEW_OUTCOMES = ["cleared", "suspicious"] as const;
export type RefundReviewOutcome = (typeof REFUND_REVIEW_OUTCOMES)[number];

export const ACCESS_REVIEW_OUTCOMES = ["confirmed", "changes_needed"] as const;
export type AccessReviewOutcome = (typeof ACCESS_REVIEW_OUTCOMES)[number];

export const RESTORE_METHODS = ["time_travel_new_db", "time_travel_in_place", "export_import"] as const;
export type RestoreMethod = (typeof RESTORE_METHODS)[number];
export const RESTORE_RESULTS = ["passed", "failed"] as const;
export type RestoreResult = (typeof RESTORE_RESULTS)[number];

// ───────────────────────────────────────────────────────────────── URL state

const PAGE_MAX = 10_000;

/** Arabic-Indic and Persian digits as 0–9 (a page number or a count typed on an Arabic keyboard). */
export function latinDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

export function pageOf(params: URLSearchParams): number {
  const value = Number(latinDigits(params.get("page") ?? "1"));
  return Number.isSafeInteger(value) && value >= 1 && value <= PAGE_MAX ? value : 1;
}

/** A free-text query: trimmed, at most 100 characters. */
export function queryOf(params: URLSearchParams, name = "q"): string {
  return (params.get(name) ?? "").trim().slice(0, 100);
}

/** "?a=1&b=2" from the non-empty values, or "" when there is none. */
export function searchOf(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  const out = params.toString();
  return out ? `?${out}` : "";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A calendar day "YYYY-MM-DD" (typed with any digits), or null. */
export function dayOf(value: string | null | undefined): string | null {
  const text = latinDigits(value ?? "").trim();
  if (!DAY.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== text ? null : text;
}

/** Asia/Baghdad is UTC+3 all year. */
export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** The first instant of a Baghdad calendar day. */
export const baghdadDayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - BAGHDAD_OFFSET_MS;
/** The Baghdad calendar day of an instant. */
export const baghdadDay = (at: number) => new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

export type StaffFilters = { twoStep: "on" | "off" | null; status: "active" | "disabled" | null; role: string | null; q: string; page: number };
export function parseStaffFilters(params: URLSearchParams): StaffFilters {
  const twoStep = params.get("twostep");
  const status = params.get("status");
  const role = params.get("role");
  return {
    twoStep: twoStep === "on" || twoStep === "off" ? twoStep : null,
    status: status === "active" || status === "disabled" ? status : null,
    role: role && /^[A-Za-z0-9_-]{1,64}$/.test(role) ? role : null,
    q: queryOf(params),
    page: pageOf(params),
  };
}
export const staffSearch = (filters: StaffFilters, page?: number) => searchOf({ twostep: filters.twoStep, status: filters.status, role: filters.role, q: filters.q, page: page && page > 1 ? page : null });

export type AuditFilters = { q: string; module: string | null; actor: string | null; entityType: string | null; entityId: string | null; from: string | null; to: string | null; page: number };
export function parseAuditFilters(params: URLSearchParams): AuditFilters {
  const module = params.get("module");
  const actor = params.get("actor");
  const entityType = params.get("type");
  const entityId = params.get("entity");
  return {
    q: queryOf(params),
    module: module && /^[a-z_]{2,32}$/.test(module) ? module : null,
    actor: actor && /^[A-Za-z0-9_:.-]{1,128}$/.test(actor) ? actor : null,
    entityType: entityType && /^[a-z_]{2,64}$/.test(entityType) ? entityType : null,
    entityId: entityId && entityId.trim() ? entityId.trim().slice(0, 200) : null,
    from: dayOf(params.get("from")),
    to: dayOf(params.get("to")),
    page: pageOf(params),
  };
}
export const auditSearch = (filters: AuditFilters, page?: number) =>
  searchOf({ q: filters.q, module: filters.module, actor: filters.actor, type: filters.entityType, entity: filters.entityId, from: filters.from, to: filters.to, page: page && page > 1 ? page : null });

export const SIGNIN_WINDOWS = ["24h", "7d", "30d"] as const;
export type SigninWindow = (typeof SIGNIN_WINDOWS)[number];
export const WINDOW_MS: Record<SigninWindow, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };
export type SigninFilters = { window: SigninWindow; outcome: "failed" | "succeeded" | null; subject: "employee" | "customer" | null; kind: string | null; q: string; page: number };
export function parseSigninFilters(params: URLSearchParams): SigninFilters {
  const window = params.get("window");
  const outcome = params.get("outcome");
  const subject = params.get("subject");
  const kind = params.get("kind");
  return {
    window: (SIGNIN_WINDOWS as readonly string[]).includes(window ?? "") ? (window as SigninWindow) : "7d",
    outcome: outcome === "failed" || outcome === "succeeded" ? outcome : null,
    subject: subject === "employee" || subject === "customer" ? subject : null,
    kind: kind && /^[a-z_]{2,32}$/.test(kind) ? kind : null,
    q: queryOf(params),
    page: pageOf(params),
  };
}
export const signinSearch = (filters: SigninFilters, page?: number) =>
  searchOf({ window: filters.window === "7d" ? null : filters.window, outcome: filters.outcome, subject: filters.subject, kind: filters.kind, q: filters.q, page: page && page > 1 ? page : null });

export const REFUND_VIEWS = ["flagged", "unreviewed", "suspicious", "all"] as const;
export type RefundView = (typeof REFUND_VIEWS)[number];
export type RefundFilters = { view: RefundView; page: number };
export function parseRefundFilters(params: URLSearchParams): RefundFilters {
  const view = params.get("view");
  return { view: (REFUND_VIEWS as readonly string[]).includes(view ?? "") ? (view as RefundView) : "flagged", page: pageOf(params) };
}

// ───────────────────────────────────────────────────────────────── view models

export type RoleRef = { id: string; key: string; name: string };
export type PersonRef = { id: string; name: string } | null;

export type StaffRow = {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled";
  roles: RoleRef[];
  twoStep: boolean;
  lastLoginAt: number | null;
  liveSessions: number;
  isDemo: boolean;
};

export type SessionView = {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  browser: string | null;
  system: string | null;
  mfaOk: boolean;
  current: boolean;
};

export type AuthEventView = {
  id: string;
  at: number;
  subjectKind: "employee" | "customer";
  subjectId: string | null;
  subjectName: string | null;
  /** What was typed: an email, or a phone shown in full only with customer.phone.read_full. */
  identifier: string | null;
  identifierMasked: boolean;
  kind: string;
  success: boolean;
  /** Reason codes from the auth services (never a secret): unknown_email, bad_password, disabled, … */
  reason: string | null;
  ip: string | null;
  browser: string | null;
  system: string | null;
};

export type SigninAlert = { rule: SigninRule; key: string; count: number; lastAt: number; identifier: string | null; identifierMasked: boolean; ip: string | null; subjectId: string | null; subjectName: string | null };

export type PermissionChoice = { key: Permission; label: string; field: boolean };
export type PermissionGroupView = { key: string; module: string | null; label: string; permissions: PermissionChoice[] };

export type RefundReviewState = { outcome: RefundReviewOutcome; note: string | null; by: string | null; at: number } | null;

export type AccessReviewView = { at: number; by: string | null; outcome: AccessReviewOutcome; note: string | null; permissions: number; members: number };
