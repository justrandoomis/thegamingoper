/**
 * Admin module 15 "staff" (Employees & HR) — the client-safe half: constants, statuses and their tones, URL state of
 * every list (filters, sort and page live in the URL, so lists work without script and survive Back), the parsing of
 * typed numbers (Arabic-Indic and Persian digits accepted) and the view models the pages render.
 *
 * Days and months are Asia/Baghdad (the finance module's helpers: baghdadDay, dayStart, periodOf, periodRange), weeks
 * start on Saturday (the Iraqi retail week). Money is integer IQD. Nothing here imports server code.
 */
import { baghdadDay, dayStart, DAY_MS, isDay, isPeriod, latinDigits, parseAmount, periodOf, shiftPeriod } from "../finance/types";

export { baghdadDay, dayStart, DAY_MS, isDay, isPeriod, periodOf, periodRange, shiftPeriod } from "../finance/types";

export const STAFF_NS = "admin-staff";
export const PAGE_SIZE = 25;

/** A clock-in this many minutes after the shift's start counts as late. */
export const LATE_GRACE_MINUTES = 10;
/** A clock-in may open this long before a shift starts and still belong to it. */
export const CLOCK_IN_EARLY_MS = 2 * 60 * 60 * 1000;
/** The longest working shift that can be planned (an overnight shift included). */
export const MAX_SHIFT_MS = 16 * 60 * 60 * 1000;
/** The longest single attendance record (forgotten clock-outs are corrected by a manager). */
export const MAX_ATTENDANCE_MS = 18 * 60 * 60 * 1000;
/** Leave: at most this many days in one request; sick leave may be recorded up to this many days after it began. */
export const MAX_LEAVE_DAYS = 60;
export const LEAVE_BACKDATE_DAYS = 30;
/** Planning horizon of the schedule: a shift at most this many days ahead. */
export const SCHEDULE_AHEAD_DAYS = 120;
/** The largest single amount the module accepts (a salary, an advance, a bonus): 100 million IQD. */
export const MAX_PAY_IQD = 100_000_000;

// ───────────────────────────────────────────────────────────────── statuses

export const SHIFT_STATUS_LIST = ["scheduled", "completed", "missed", "cancelled"] as const;
export type ShiftStatusKey = (typeof SHIFT_STATUS_LIST)[number];
export const LEAVE_KIND_LIST = ["annual", "sick", "unpaid", "other"] as const;
export type LeaveKindKey = (typeof LEAVE_KIND_LIST)[number];
export const LEAVE_STATUS_LIST = ["pending", "approved", "rejected", "cancelled"] as const;
export type LeaveStatusKey = (typeof LEAVE_STATUS_LIST)[number];
export const TASK_PRIORITY_LIST = ["low", "normal", "high", "urgent"] as const;
export type TaskPriorityKey = (typeof TASK_PRIORITY_LIST)[number];
export const TASK_STATUS_LIST = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatusKey = (typeof TASK_STATUS_LIST)[number];
export const COMMISSION_BASIS_LIST = ["sales", "profit"] as const;
export type CommissionBasisKey = (typeof COMMISSION_BASIS_LIST)[number];
export const COMMISSION_STATUS_LIST = ["accrued", "approved", "paid", "void"] as const;
export type CommissionStatusKey = (typeof COMMISSION_STATUS_LIST)[number];
export const RUN_STATUS_LIST = ["draft", "approved", "paid", "void"] as const;
export type RunStatusKey = (typeof RUN_STATUS_LIST)[number];
export const ADVANCE_STATUS_LIST = ["pending", "open", "settled", "rejected"] as const;
export type AdvanceStatusKey = (typeof ADVANCE_STATUS_LIST)[number];
export const PAID_FROM_LIST = ["cash", "bank_clearing"] as const;
export type PaidFromKey = (typeof PAID_FROM_LIST)[number];
export const RULE_SCOPE_LIST = ["everyone", "role", "employee"] as const;
export type RuleScopeKey = (typeof RULE_SCOPE_LIST)[number];
export const CHANNEL_LIST = ["web", "pos"] as const;
export const PRODUCT_KIND_LIST = ["console", "game", "controller", "headset", "storage", "accessory", "digital", "part", "bundle"] as const;
/** How an attendance record was made: by the employee, at the till, or by a manager. */
export const ATTENDANCE_METHOD_LIST = ["self", "pos", "manager"] as const;

/** The kind of the `approvals` row an advance request is (module 15's own). */
export const ADVANCE_APPROVAL_KIND = "staff_advance";

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";

export const TONES = {
  shift: { scheduled: "info", completed: "ok", missed: "bad", cancelled: "neutral" },
  leave: { pending: "warn", approved: "ok", rejected: "bad", cancelled: "neutral" },
  task: { open: "info", in_progress: "warn", done: "ok", cancelled: "neutral" },
  priority: { low: "neutral", normal: "info", high: "warn", urgent: "bad" },
  commission: { accrued: "info", approved: "warn", paid: "ok", void: "neutral" },
  run: { draft: "warn", approved: "info", paid: "ok", void: "neutral" },
  advance: { pending: "warn", open: "info", settled: "ok", rejected: "neutral" },
  employee: { active: "ok", disabled: "bad" },
} as const satisfies Record<string, Record<string, Tone>>;

/**
 * Error codes of the module (texts: admin-staff → errors.*; the shared ones — approver_is_requester, last_owner,
 * cannot_disable_self, employee_not_active, period_closed, already_posted, idempotency_mismatch — live in "errors").
 */
export const STAFF_ERROR_KEYS = [
  "shift_overlap",
  "shift_not_scheduled",
  "shift_in_past",
  "employee_inactive",
  "already_clocked_in",
  "not_clocked_in",
  "attendance_self_approval",
  "attendance_changed",
  "leave_overlap",
  "leave_not_pending",
  "leave_self_decision",
  "task_not_open",
  "task_managed_elsewhere",
  "task_not_yours",
  "rule_ended",
  "rule_changed",
  "profit_basis_needs_permission",
  "run_open_exists",
  "run_not_draft",
  "run_not_approved",
  "run_changed",
  "run_self_approval",
  "run_empty",
  "run_mixed_demo",
  "net_negative",
  "advance_not_pending",
  "advance_self_decision",
  "advance_beneficiary",
  "advance_not_in_run",
  "target_more_privileged",
  "own_account_here",
  "commission_sync_busy",
] as const;
export type StaffErrorKey = (typeof STAFF_ERROR_KEYS)[number];

// ───────────────────────────────────────────────────────────────── days, weeks, numbers

/** A day `n` days after `day` ("YYYY-MM-DD"). */
export function addDays(day: string, n: number): string {
  return baghdadDay(dayStart(day) + n * DAY_MS + 12 * 60 * 60 * 1000);
}

/** The Saturday that starts the week of `day` (Saturday … Friday). */
export function weekStartOf(day: string): string {
  const weekday = new Date(dayStart(day) + 12 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000).getUTCDay(); // 0 = Sunday … 6 = Saturday
  return addDays(day, -((weekday + 1) % 7));
}

/** The seven days of the week that starts on `start`. */
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** Whole days from `from` to `to` inclusive (0 when `to` is before `from`). */
export function daySpan(from: string, to: string): number {
  const span = Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1;
  return Math.max(0, span);
}

/** The first and last day of a month "YYYY-MM". */
export function monthDays(period: string): { first: string; last: string; count: number } {
  const first = `${period}-01`;
  const last = addDays(`${shiftPeriod(period, 1)}-01`, -1);
  return { first, last, count: daySpan(first, last) };
}

/** "HH:MM" → minutes after midnight, or null. Arabic-Indic / Persian digits accepted. */
export function parseClock(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(latinDigits(raw).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes after midnight → "HH:MM". */
export function clockText(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The Baghdad wall-clock time of an instant, "HH:MM". */
export function clockOf(at: number): string {
  return new Date(at + 3 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

/** A whole number of dinars typed in a field (Arabic-Indic and Persian digits, thousands separators); undefined when empty. */
export function parseWhole(raw: unknown): number | undefined {
  return parseAmount(raw);
}

/**
 * A percentage typed by a person ("2.5", "٢٫٥", "10%") as basis points (250); undefined when empty, NaN when it is
 * not a percentage between 0 and 100 with at most two decimals.
 */
export function parseRateBps(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 && raw <= 10_000 ? raw : Number.NaN;
  if (typeof raw !== "string") return undefined;
  const text = latinDigits(raw).replace(/[\s%٪]/g, "").replace(/٫/g, ".").replace(/,/g, ".");
  if (text === "") return undefined;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return Number.NaN;
  const [whole, fraction = ""] = text.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps <= 10_000 ? bps : Number.NaN;
}

/** Basis points as the percentage people type ("2.5"). */
export function bpsText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

// ───────────────────────────────────────────────────────────────── URL state

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

export function pageOf(params: URLSearchParams): number {
  const raw = Number(latinDigits(params.get("page") ?? "1"));
  return Number.isInteger(raw) && raw >= 1 && raw <= 10_000 ? raw : 1;
}

export function idParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value && ID.test(value) ? value : null;
}

function textParam(params: URLSearchParams, name = "q", max = 60): string {
  return (params.get(name) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function oneOf<T extends string>(list: readonly T[], value: string | null): T | null {
  return value && (list as readonly string[]).includes(value) ? (value as T) : null;
}

/** "?a=1&b=2" from the non-empty values (page 1 left out); "" when nothing is set. */
export function searchOf(values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "" || value === false) continue;
    if (key === "page" && Number(value) <= 1) continue;
    params.set(key, value === true ? "1" : String(value));
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}

export const EMPLOYEE_SORTS = ["name", "newest", "last_login"] as const;
export type EmployeeFilters = { q: string; status: "active" | "disabled" | null; role: string | null; demo: "all" | "real" | "demo"; sort: (typeof EMPLOYEE_SORTS)[number]; page: number };

export function parseEmployeeFilters(params: URLSearchParams): EmployeeFilters {
  return {
    q: textParam(params),
    status: oneOf(["active", "disabled"] as const, params.get("status")),
    role: idParam(params, "role"),
    demo: oneOf(["all", "real", "demo"] as const, params.get("demo")) ?? "all",
    sort: oneOf(EMPLOYEE_SORTS, params.get("sort")) ?? "name",
    page: pageOf(params),
  };
}

export function employeeSearch(filters: EmployeeFilters, page = filters.page): string {
  return searchOf({ q: filters.q, status: filters.status, role: filters.role, demo: filters.demo === "all" ? null : filters.demo, sort: filters.sort === "name" ? null : filters.sort, page });
}

export type RosterFilters = { week: string; employee: string | null };

/** A day or month typed in the URL (a browser without a month picker shows a text field: Arabic-Indic and Persian digits accepted). */
function dateParam(params: URLSearchParams, name: string): string | null {
  const raw = params.get(name);
  return raw === null ? null : latinDigits(raw).trim();
}

export function parseRosterFilters(params: URLSearchParams, now: number): RosterFilters {
  const raw = dateParam(params, "week");
  const day = raw && isDay(raw) ? raw : baghdadDay(now);
  return { week: weekStartOf(day), employee: idParam(params, "employee") };
}

export function rosterSearch(filters: RosterFilters, now: number): string {
  return searchOf({ week: filters.week === weekStartOf(baghdadDay(now)) ? null : filters.week, employee: filters.employee });
}

export type AttendanceFilters = { from: string; to: string; employee: string | null; state: "all" | "open" | "unapproved" | "late"; page: number };

export function parseAttendanceFilters(params: URLSearchParams, now: number): AttendanceFilters {
  const today = baghdadDay(now);
  let from = dateParam(params, "from");
  let to = dateParam(params, "to");
  if (!from || !isDay(from)) from = addDays(today, -6);
  if (!to || !isDay(to)) to = today;
  if (dayStart(to) < dayStart(from)) [from, to] = [to, from];
  if (daySpan(from, to) > 62) from = addDays(to, -61);
  return { from, to, employee: idParam(params, "employee"), state: oneOf(["all", "open", "unapproved", "late"] as const, params.get("state")) ?? "all", page: pageOf(params) };
}

export function attendanceSearch(filters: AttendanceFilters, now: number, page = filters.page): string {
  const today = baghdadDay(now);
  return searchOf({
    from: filters.from === addDays(today, -6) && filters.to === today ? null : filters.from,
    to: filters.from === addDays(today, -6) && filters.to === today ? null : filters.to,
    employee: filters.employee,
    state: filters.state === "all" ? null : filters.state,
    page,
  });
}

export type LeaveFilters = { status: LeaveStatusKey | null; employee: string | null; page: number };

export function parseLeaveFilters(params: URLSearchParams): LeaveFilters {
  const status = params.get("status");
  return { status: status === "all" ? null : (oneOf(LEAVE_STATUS_LIST, status) ?? (status === null ? "pending" : null)), employee: idParam(params, "employee"), page: pageOf(params) };
}

export function leaveSearch(filters: LeaveFilters, page = filters.page): string {
  return searchOf({ status: filters.status === "pending" ? null : (filters.status ?? "all"), employee: filters.employee, page });
}

export type TaskFilters = { status: "active" | TaskStatusKey | "all"; assignee: string | null; mine: boolean; page: number };

export function parseTaskFilters(params: URLSearchParams): TaskFilters {
  const status = params.get("status");
  return {
    status: status === "all" ? "all" : (oneOf(TASK_STATUS_LIST, status) ?? "active"),
    assignee: idParam(params, "assignee"),
    mine: params.get("mine") === "1",
    page: pageOf(params),
  };
}

export function taskSearch(filters: TaskFilters, page = filters.page): string {
  return searchOf({ status: filters.status === "active" ? null : filters.status, assignee: filters.assignee, mine: filters.mine, page });
}

export type PeriodFilter = { period: string };

/** A month "YYYY-MM" from the URL, this month (Baghdad) by default. */
export function parsePeriod(params: URLSearchParams, now: number, name = "period"): string {
  const raw = dateParam(params, name);
  return raw && isPeriod(raw) ? raw : periodOf(now);
}

export type CommissionFilters = { period: string; employee: string | null; page: number };

export function parseCommissionFilters(params: URLSearchParams, now: number): CommissionFilters {
  return { period: parsePeriod(params, now), employee: idParam(params, "employee"), page: pageOf(params) };
}

export type PayrollFilters = { status: RunStatusKey | null; page: number };

export function parsePayrollFilters(params: URLSearchParams): PayrollFilters {
  return { status: oneOf(RUN_STATUS_LIST, params.get("status")), page: pageOf(params) };
}

export type AdvanceFilters = { status: AdvanceStatusKey | null; employee: string | null; page: number };

export function parseAdvanceFilters(params: URLSearchParams): AdvanceFilters {
  return { status: oneOf(ADVANCE_STATUS_LIST, params.get("status")), employee: idParam(params, "employee"), page: pageOf(params) };
}

// ───────────────────────────────────────────────────────────────── view models

export type RoleRef = { id: string; key: string; name: string };
export type PersonRef = { id: string; name: string; isDemo?: boolean };

/** Who acted, in words (an employee's name, the system, a deleted id). */
export type ByView = { kind: "employee" | "system" | "unknown"; name: string | null };

export type EmployeeRow = {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
  status: "active" | "disabled";
  roles: RoleRef[];
  branch: string | null;
  lastLoginAt: number | null;
  createdAt: number;
  disabledAt: number | null;
  isDemo: boolean;
};

export type PermissionView = { key: string; label: string; field: boolean; roles: string[] };
export type PermissionGroupView = { key: string; module: string | null; label: string; permissions: PermissionView[] };

/**
 * What the «add an employee» form offers (staff.manage only): every role, `assignable` when this person holds all it
 * grants (giving one they do not is refused: grant_exceeds_own), `twoStep` when its members must use two-step
 * verification; the active branches; `branch` — the one branch a branch-limited person hires for (no choice then).
 */
export type HireOptions = {
  roles: (RoleRef & { description: string | null; assignable: boolean; twoStep: boolean })[];
  branches: { id: string; name: string }[];
  branch: { id: string; name: string } | null;
};

/**
 * A one-time password-set link, as the person who made it sees it ONCE (the action's answer; never stored, never in a
 * URL of this admin, never in the audit trail): the full address on this store — the token sits in its fragment.
 */
export type HandedLink = { url: string; purpose: "welcome" | "reset"; expiresAt: number };

/** An employee's live session and a sign-in event, as module 20 shows them (its client-safe view types). */
export type { AuthEventView as SignInRow, SessionView as SessionRow } from "../security/types";

export type ShiftCell = { id: string; startsAt: number; endsAt: number; status: ShiftStatusKey; note: string | null; overnight: boolean; attended: "on_time" | "late" | "absent" | "open" | null; onLeave: boolean };
export type RosterRow = { employee: PersonRef; jobTitle: string | null; days: ShiftCell[][]; leaveDays: string[]; plannedMinutes: number };

export type AttendanceRow = {
  id: string;
  employee: PersonRef;
  clockInAt: number;
  clockOutAt: number | null;
  minutes: number | null;
  method: string;
  note: string | null;
  shift: { id: string; startsAt: number; endsAt: number } | null;
  late: boolean;
  lateMinutes: number;
  approvedBy: string | null;
  canApprove: boolean;
  /** A manager may correct it: never one's own record. */
  canCorrect: boolean;
};

export type LeaveRow = {
  id: string;
  employee: PersonRef;
  kind: LeaveKindKey;
  startsOn: string;
  endsOn: string;
  days: number;
  reason: string | null;
  status: LeaveStatusKey;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
  canDecide: boolean;
  canCancel: boolean;
  shiftsAffected: number;
};

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  assignee: PersonRef | null;
  assigneeActive: boolean;
  priority: TaskPriorityKey;
  status: TaskStatusKey;
  dueAt: number | null;
  overdue: boolean;
  ref: { type: string; id: string; href: string | null; label: string | null } | null;
  createdBy: string | null;
  createdAt: number;
  completedAt: number | null;
  /** What this employee may do with it. */
  moves: TaskStatusKey[];
};

export type RuleVersionView = {
  id: string;
  version: number;
  name: string;
  basis: CommissionBasisKey;
  /** Null for a profit-based rule seen without profit.read. */
  rateBps: number | null;
  scope: RuleScopeKey;
  target: string | null;
  productKind: string;
  category: string | null;
  channel: "web" | "pos" | null;
  startsAt: number | null;
  endsAt: number | null;
  createdBy: string | null;
  createdAt: number;
  state: "current" | "scheduled" | "ended";
};
export type RulePlanView = { planId: string; current: RuleVersionView; versions: RuleVersionView[] };

export type CommissionTotals = { employee: PersonRef; earnIqd: number; clawbackIqd: number; netIqd: number; salesIqd: number | null; profitIqd: number | null; rows: number; accruedIqd: number; inRunIqd: number; paidIqd: number };

export type CommissionLine = {
  id: string;
  employee: PersonRef;
  orderRef: string;
  orderId: string;
  kind: "earn" | "clawback";
  basis: CommissionBasisKey;
  /** Null for profit-based rows without profit.read. */
  baseIqd: number | null;
  rateBps: number | null;
  amountIqd: number;
  status: CommissionStatusKey;
  period: string;
  runId: string | null;
  createdAt: number;
};

export type RunRow = { id: string; ref: string; period: string; status: RunStatusKey; employees: number; grossIqd: number; netIqd: number; createdBy: ByView; approvedBy: ByView | null; createdAt: number; approvedAt: number | null; paidAt: number | null; isDemo: boolean; journalEntryId: string | null };

export type RunItemView = {
  employee: PersonRef & { jobTitle: string | null; status: "active" | "disabled" };
  baseIqd: number;
  commissionIqd: number;
  bonusIqd: number;
  advanceDeductionIqd: number;
  otherDeductionIqd: number;
  netIqd: number;
  notes: string | null;
  /** How the base was reached: full month, or so many payable days of the month. */
  basis: { monthlyIqd: number | null; payableDays: number; monthDays: number; unpaidLeaveDays: number; paidElsewhereIqd: number };
  advances: { id: string; amountIqd: number; givenAt: number; reason: string | null }[];
  commissionRows: number;
  salaryChangedAt: number | null;
};

export type AdvanceRow = {
  id: string;
  /** The approvals row for a request; the employee_advances row once paid. */
  kind: "request" | "advance";
  employee: PersonRef;
  amountIqd: number;
  reason: string | null;
  status: AdvanceStatusKey;
  paidFrom: PaidFromKey | null;
  requestedBy: ByView;
  decidedBy: ByView | null;
  createdAt: number;
  decidedAt: number | null;
  settledRun: { id: string; period: string } | null;
  canDecide: boolean;
  canWithdraw: boolean;
};
