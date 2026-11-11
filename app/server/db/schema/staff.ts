/**
 * staff — employees, roles and permissions, sessions, approval chains, schedules, attendance,
 * commissions and payroll (admin modules 15 and 20).
 *
 * Authorization is enforced in services with assertCan(actor, "<module>.<resource>.<action>");
 * `role_permissions.permission` holds those strings. Disabling an employee
 * (`status = 'disabled'`) must also revoke their sessions (15.07).
 * Salary and payroll amounts are confidential: select them only for actors with payroll permissions.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Locale } from "~/lib/locales";
import { NOW_MS, PRODUCT_KIND_SCOPES, at, flag, id, iqd, json, l10n, type Ref } from "../columns";
import { categories } from "./catalog";
import { orderItems, orders } from "./commerce";
import { branches } from "./ops";

// ───────────────────────────────────────────────────────────────── employees

export const EMPLOYEE_STATUSES = ["active", "disabled"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const employees = sqliteTable(
  "employees",
  {
    id: id(),
    /** Lower-cased sign-in email. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    /** PBKDF2-SHA256 hash including its per-user salt. Null until the employee sets a password. */
    passwordHash: text("password_hash"),
    passwordIters: integer("password_iters"),
    /** TOTP secret encrypted with DATA_KEY (AES-256-GCM). */
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabled: flag("totp_enabled").notNull().default(false),
    /** Hashes of unused recovery codes. */
    recoveryCodes: json<string[]>("recovery_codes"),
    status: text("status", { enum: EMPLOYEE_STATUSES }).notNull().default("active"),
    /** Branch the employee is limited to; null = all branches. */
    branchId: text("branch_id").references((): Ref => branches.id),
    locale: text("locale").$type<Locale>().notNull().default("ar"),
    createdAt: at("created_at").notNull(),
    disabledAt: at("disabled_at"),
    jobTitle: text("job_title"),
    lastLoginAt: at("last_login_at"),
    passwordChangedAt: at("password_changed_at"),
    /** Monthly base salary — confidential. */
    baseSalaryIqd: iqd("base_salary_iqd"),
    isDemo: flag("is_demo").notNull().default(false),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("employees_email_uq").on(t.email),
    index("employees_status_idx").on(t.status),
    index("employees_branch_idx").on(t.branchId),
  ],
);
export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;

export const roles = sqliteTable(
  "roles",
  {
    id: id(),
    key: text("key").notNull(),
    name: l10n("name").notNull(),
    /** Built-in roles cannot be deleted. */
    isSystem: flag("is_system").notNull().default(false),
    description: l10n("description"),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [uniqueIndex("roles_key_uq").on(t.key)],
);
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    roleId: text("role_id")
      .notNull()
      .references((): Ref => roles.id, { onDelete: "cascade" }),
    /** `<module>.<resource>.<action>` or a field-level permission such as "cost.read". */
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] }), index("role_permissions_permission_idx").on(t.permission)],
);
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;

export const employeeRoles = sqliteTable(
  "employee_roles",
  {
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references((): Ref => roles.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by"),
    grantedAt: at("granted_at").notNull().default(NOW_MS),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.roleId] }), index("employee_roles_role_idx").on(t.roleId)],
);
export type EmployeeRole = typeof employeeRoles.$inferSelect;
export type NewEmployeeRole = typeof employeeRoles.$inferInsert;

/** Admin sessions. The primary key is sha256(session token). `mfa_ok` is set after the TOTP step. */
export const employeeSessions = sqliteTable(
  "employee_sessions",
  {
    idHash: text("id_hash").primaryKey(),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id, { onDelete: "cascade" }),
    mfaOk: flag("mfa_ok").notNull().default(false),
    createdAt: at("created_at").notNull(),
    lastSeenAt: at("last_seen_at").notNull(),
    expiresAt: at("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: at("revoked_at"),
  },
  (t) => [index("employee_sessions_employee_idx").on(t.employeeId), index("employee_sessions_expires_idx").on(t.expiresAt)],
);
export type EmployeeSession = typeof employeeSessions.$inferSelect;
export type NewEmployeeSession = typeof employeeSessions.$inferInsert;

/** Devices on which an employee chose "trust this device" after MFA (20.01). Only the token hash is stored. */
export const employeeTrustedDevices = sqliteTable(
  "employee_trusted_devices",
  {
    id: id(),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: at("created_at").notNull(),
    lastUsedAt: at("last_used_at"),
    expiresAt: at("expires_at").notNull(),
    revokedAt: at("revoked_at"),
  },
  (t) => [uniqueIndex("employee_trusted_devices_token_uq").on(t.tokenHash), index("employee_trusted_devices_employee_idx").on(t.employeeId)],
);
export type EmployeeTrustedDevice = typeof employeeTrustedDevices.$inferSelect;
export type NewEmployeeTrustedDevice = typeof employeeTrustedDevices.$inferInsert;

// ───────────────────────────────────────────────────────────────── approvals

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * Approval requests for discounts above a limit, refunds, stock adjustments, price changes,
 * purchase orders, settings changes… (15.06, 19.08). `payload` is what will be applied on approval.
 */
export const approvals = sqliteTable(
  "approvals",
  {
    id: id(),
    /** e.g. "refund", "price_change", "stock_adjustment", "discount", "purchase_order", "settings". */
    kind: text("kind").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    requestedBy: text("requested_by").notNull(),
    payload: json<Record<string, unknown>>("payload"),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: at("decided_at"),
    /** Why it was requested. */
    reason: text("reason"),
    createdAt: at("created_at").notNull().default(NOW_MS),
    /** Why it was approved or rejected. */
    decisionNote: text("decision_note"),
    /** Permission a decider must hold. */
    requiredPermission: text("required_permission"),
    expiresAt: at("expires_at"),
  },
  (t) => [
    index("approvals_status_idx").on(t.status, t.createdAt),
    index("approvals_entity_idx").on(t.entityType, t.entityId),
    index("approvals_requested_by_idx").on(t.requestedBy, t.createdAt),
    index("approvals_kind_idx").on(t.kind, t.status),
  ],
);
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;

// ───────────────────────────────────────────────────────────────── schedules and attendance (15.02)

export const SHIFT_STATUSES = ["scheduled", "completed", "missed", "cancelled"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

/** Planned working shifts (not POS cash shifts — those are `pos_shifts`). */
export const shifts = sqliteTable(
  "shifts",
  {
    id: id(),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id, { onDelete: "cascade" }),
    branchId: text("branch_id").references((): Ref => branches.id),
    startsAt: at("starts_at").notNull(),
    endsAt: at("ends_at").notNull(),
    status: text("status", { enum: SHIFT_STATUSES }).notNull().default("scheduled"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("shifts_employee_idx").on(t.employeeId, t.startsAt),
    index("shifts_branch_idx").on(t.branchId, t.startsAt),
    check("shifts_times_check", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
export type Shift = typeof shifts.$inferSelect;
export type NewShift = typeof shifts.$inferInsert;

export const attendance = sqliteTable(
  "attendance",
  {
    id: id(),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id, { onDelete: "cascade" }),
    shiftId: text("shift_id").references((): Ref => shifts.id, { onDelete: "set null" }),
    branchId: text("branch_id").references((): Ref => branches.id),
    clockInAt: at("clock_in_at").notNull(),
    clockOutAt: at("clock_out_at"),
    /** "self" | "pos" | "manager" */
    method: text("method").notNull().default("self"),
    note: text("note"),
    approvedBy: text("approved_by"),
  },
  (t) => [
    index("attendance_employee_idx").on(t.employeeId, t.clockInAt),
    index("attendance_shift_idx").on(t.shiftId),
    index("attendance_branch_idx").on(t.branchId, t.clockInAt),
  ],
);
export type AttendanceRecord = typeof attendance.$inferSelect;
export type NewAttendanceRecord = typeof attendance.$inferInsert;

export const LEAVE_KINDS = ["annual", "sick", "unpaid", "other"] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];
export const LEAVE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const leaveRequests = sqliteTable(
  "leave_requests",
  {
    id: id(),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: LEAVE_KINDS }).notNull(),
    /** "YYYY-MM-DD", inclusive. */
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on").notNull(),
    reason: text("reason"),
    status: text("status", { enum: LEAVE_STATUSES }).notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: at("decided_at"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [index("leave_requests_employee_idx").on(t.employeeId, t.startsOn), index("leave_requests_status_idx").on(t.status)],
);
export type LeaveRequest = typeof leaveRequests.$inferSelect;
export type NewLeaveRequest = typeof leaveRequests.$inferInsert;

export const STAFF_TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type StaffTaskPriority = (typeof STAFF_TASK_PRIORITIES)[number];
export const STAFF_TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type StaffTaskStatus = (typeof STAFF_TASK_STATUSES)[number];

/** Tasks assigned to staff, optionally about a specific record (an order to pack, a count to finish). */
export const staffTasks = sqliteTable(
  "staff_tasks",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description"),
    assignedTo: text("assigned_to"),
    priority: text("priority", { enum: STAFF_TASK_PRIORITIES }).notNull().default("normal"),
    status: text("status", { enum: STAFF_TASK_STATUSES }).notNull().default("open"),
    dueAt: at("due_at"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    completedAt: at("completed_at"),
  },
  (t) => [index("staff_tasks_assigned_idx").on(t.assignedTo, t.status, t.dueAt), index("staff_tasks_ref_idx").on(t.refType, t.refId)],
);
export type StaffTask = typeof staffTasks.$inferSelect;
export type NewStaffTask = typeof staffTasks.$inferInsert;

// ───────────────────────────────────────────────────────────────── commissions and payroll (15.03, 15.04)

export const COMMISSION_BASES = ["sales", "profit"] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];

/** Who earns what. The most specific active rule wins (employee, then role, then everyone). */
export const commissionRules = sqliteTable(
  "commission_rules",
  {
    id: id(),
    name: text("name").notNull(),
    basis: text("basis", { enum: COMMISSION_BASES }).notNull().default("sales"),
    rateBps: integer("rate_bps").notNull(),
    employeeId: text("employee_id").references((): Ref => employees.id, { onDelete: "cascade" }),
    roleId: text("role_id").references((): Ref => roles.id, { onDelete: "cascade" }),
    /** "*" = every product kind. */
    productKind: text("product_kind", { enum: PRODUCT_KIND_SCOPES }).notNull().default("*"),
    categoryId: text("category_id").references((): Ref => categories.id, { onDelete: "cascade" }),
    /** "web" | "pos" | null = both. */
    channel: text("channel"),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    isActive: flag("is_active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("commission_rules_employee_idx").on(t.employeeId),
    index("commission_rules_role_idx").on(t.roleId),
    index("commission_rules_category_idx").on(t.categoryId),
    check("commission_rules_rate_check", sql`${t.rateBps} >= 0 AND ${t.rateBps} <= 10000`),
  ],
);
export type CommissionRule = typeof commissionRules.$inferSelect;
export type NewCommissionRule = typeof commissionRules.$inferInsert;

export const COMMISSION_KINDS = ["earn", "clawback"] as const;
export type CommissionKind = (typeof COMMISSION_KINDS)[number];
export const COMMISSION_STATUSES = ["accrued", "approved", "paid", "void"] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

/**
 * Commission earned on an order (or clawed back after a return: negative amount, kind 'clawback').
 * Commissions are part of the profit definition (ARCHITECTURE §7.9).
 */
export const commissions = sqliteTable(
  "commissions",
  {
    id: id(),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    orderItemId: text("order_item_id").references((): Ref => orderItems.id),
    ruleId: text("rule_id").references((): Ref => commissionRules.id, { onDelete: "set null" }),
    kind: text("kind", { enum: COMMISSION_KINDS }).notNull().default("earn"),
    basis: text("basis", { enum: COMMISSION_BASES }).notNull(),
    baseAmountIqd: iqd("base_amount_iqd").notNull(),
    rateBps: integer("rate_bps").notNull(),
    amountIqd: iqd("amount_iqd").notNull(),
    status: text("status", { enum: COMMISSION_STATUSES }).notNull().default("accrued"),
    payrollRunId: text("payroll_run_id").references((): Ref => payrollRuns.id),
    /** "YYYY-MM" the commission belongs to. */
    period: text("period").notNull(),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("commissions_employee_idx").on(t.employeeId, t.period),
    index("commissions_order_idx").on(t.orderId),
    index("commissions_order_item_idx").on(t.orderItemId),
    index("commissions_rule_idx").on(t.ruleId),
    index("commissions_payroll_run_idx").on(t.payrollRunId),
    index("commissions_status_idx").on(t.status, t.period),
  ],
);
export type Commission = typeof commissions.$inferSelect;
export type NewCommission = typeof commissions.$inferInsert;

export const PAYROLL_RUN_STATUSES = ["draft", "approved", "paid", "void"] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const payrollRuns = sqliteTable(
  "payroll_runs",
  {
    id: id(),
    /** "YYYY-MM". */
    period: text("period").notNull(),
    status: text("status", { enum: PAYROLL_RUN_STATUSES }).notNull().default("draft"),
    totalGrossIqd: iqd("total_gross_iqd").notNull().default(0),
    totalNetIqd: iqd("total_net_iqd").notNull().default(0),
    notes: text("notes"),
    approvedBy: text("approved_by"),
    approvedAt: at("approved_at"),
    paidAt: at("paid_at"),
    journalEntryId: text("journal_entry_id"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [index("payroll_runs_period_idx").on(t.period, t.status)],
);
export type PayrollRun = typeof payrollRuns.$inferSelect;
export type NewPayrollRun = typeof payrollRuns.$inferInsert;

/** One employee's pay in a run: net = base + commission + bonus − advance_deduction − other_deduction (CHECK). */
export const payrollItems = sqliteTable(
  "payroll_items",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references((): Ref => payrollRuns.id, { onDelete: "cascade" }),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id),
    baseIqd: iqd("base_iqd").notNull().default(0),
    commissionIqd: iqd("commission_iqd").notNull().default(0),
    bonusIqd: iqd("bonus_iqd").notNull().default(0),
    advanceDeductionIqd: iqd("advance_deduction_iqd").notNull().default(0),
    otherDeductionIqd: iqd("other_deduction_iqd").notNull().default(0),
    netIqd: iqd("net_iqd").notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("payroll_items_run_employee_uq").on(t.runId, t.employeeId),
    index("payroll_items_employee_idx").on(t.employeeId),
    check("payroll_items_net_check", sql`${t.netIqd} = ${t.baseIqd} + ${t.commissionIqd} + ${t.bonusIqd} - ${t.advanceDeductionIqd} - ${t.otherDeductionIqd}`),
  ],
);
export type PayrollItem = typeof payrollItems.$inferSelect;
export type NewPayrollItem = typeof payrollItems.$inferInsert;

export const ADVANCE_STATUSES = ["open", "settled", "void"] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

/** Salary advances, deducted in a later payroll run. */
export const employeeAdvances = sqliteTable(
  "employee_advances",
  {
    id: id(),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id),
    amountIqd: iqd("amount_iqd").notNull(),
    reason: text("reason"),
    status: text("status", { enum: ADVANCE_STATUSES }).notNull().default("open"),
    givenBy: text("given_by"),
    givenAt: at("given_at").notNull(),
    settledRunId: text("settled_run_id").references((): Ref => payrollRuns.id),
    settledAt: at("settled_at"),
  },
  (t) => [
    index("employee_advances_employee_idx").on(t.employeeId, t.status),
    index("employee_advances_run_idx").on(t.settledRunId),
    check("employee_advances_amount_check", sql`${t.amountIqd} > 0`),
  ],
);
export type EmployeeAdvance = typeof employeeAdvances.$inferSelect;
export type NewEmployeeAdvance = typeof employeeAdvances.$inferInsert;

// ───────────────────────────────────────────────────────────────── saved views

/** Saved filters / column layouts of admin tables, per employee or shared with the team. */
export const savedViews = sqliteTable(
  "saved_views",
  {
    id: id(),
    employeeId: text("employee_id")
      .notNull()
      .references((): Ref => employees.id, { onDelete: "cascade" }),
    /** Which table the view belongs to, e.g. "orders", "inventory.levels". */
    scope: text("scope").notNull(),
    name: text("name").notNull(),
    /** `{ filters, sort, columns }` as understood by that table. */
    config: json<Record<string, unknown>>("config").notNull(),
    isDefault: flag("is_default").notNull().default(false),
    isShared: flag("is_shared").notNull().default(false),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [index("saved_views_employee_idx").on(t.employeeId, t.scope), index("saved_views_shared_idx").on(t.scope, t.isShared)],
);
export type SavedView = typeof savedViews.$inferSelect;
export type NewSavedView = typeof savedViews.$inferInsert;
