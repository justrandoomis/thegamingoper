/**
 * Admin 15.01 and 15.07 — the employee directory, one employee's file (HR facts, roles and the permissions they
 * actually hold, read-only), the salary (payroll permissions only), and access revocation on termination with the
 * employee's sessions and sign-in log.
 *
 * Roles are edited in ONE place, module 20's role editor (/admin/security/roles): this module shows each employee's
 * effective permissions — every permission their roles grant, the protected-data ones marked, and which role grants
 * it — and links there. Accounts are created and given passwords only by the sign-in service (app/server/auth/**),
 * which has no function for a new employee yet (CONTRACTS §4 "15 staff" lists the request): nothing here writes an
 * account, a password, a role or a session row.
 *
 * Termination is the auth service's disableEmployee (staff.manage, a reason; the employee is locked out on their next
 * request and every session ends — audited there as staff.employee.disable), then this module's own housekeeping in
 * one batch: future shifts cancelled, pending leave requests cancelled, an open attendance record closed.
 *
 * Errors: not_found, forbidden, invalid (fields), employee_changed, employee_inactive, own_account_here,
 * target_more_privileged (403), salary_self_change (403), and the auth service's cannot_disable_self, last_owner,
 * employee_not_active.
 */
import { and, asc, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { pick, type Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import { disableEmployee, listEmployeeSessions } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import { attendance, auditEvents, authEvents, employeeRoles, employeeSessions, employees, leaveRequests, rolePermissions, roles, shifts } from "~/server/db/schema";
import { expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError } from "~/server/errors";
import { FIELD_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS, PERMISSION_DEFS, WILDCARD_PERMISSION, expandPermissions, type Permission } from "~/server/permissions";
import { canSeeModule } from "~/routes/admin/shell/access.server";
import { deviceOf, holdsAll, storedPermissionsOf } from "../security/shared.server";
import { authEventView, endAllStaffSessions, endStaffSession } from "../security/staff.server";
import { actorId, assertAny, assertReach, assertReachOf, branchLimit, branchNames, cleanLine, employeeFacts, IdSchema, peopleById, Reason, rolesOf, staffAccess, wholeIqd } from "./shared.server";
import { ADVANCE_APPROVAL_KIND, MAX_PAY_IQD, PAGE_SIZE, periodOf, periodRange, type EmployeeFilters, type EmployeeRow, type PermissionGroupView, type RoleRef, type SessionRow, type SignInRow } from "./types";

const READERS = ["staff.employee.read", "staff.manage"] as const;

function escapeLike(text: string): string {
  return `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

// ───────────────────────────────────────────────────────────────── the directory

export type EmployeePage = {
  rows: EmployeeRow[];
  total: number;
  page: number;
  pageCount: number;
  counts: { active: number; disabled: number; demo: number };
  roles: RoleRef[];
};

export async function listEmployees(db: Db, actor: Actor, filters: EmployeeFilters, locale: Locale): Promise<EmployeePage> {
  assertAny(actor, READERS);
  const limit = branchLimit(actor);
  const where: SQL[] = [];
  // an employee limited to a branch sees the staff of that branch only (the counts too)
  if (limit) where.push(eq(employees.branchId, limit));
  if (filters.status) where.push(eq(employees.status, filters.status));
  if (filters.demo === "real") where.push(eq(employees.isDemo, false));
  if (filters.demo === "demo") where.push(eq(employees.isDemo, true));
  if (filters.role) where.push(sql`EXISTS (SELECT 1 FROM employee_roles er WHERE er.employee_id = ${employees.id} AND er.role_id = ${filters.role})`);
  if (filters.q) {
    const text = escapeLike(filters.q);
    where.push(or(sql`${employees.name} LIKE ${text} ESCAPE '\\'`, sql`${employees.email} LIKE ${text.toLowerCase()} ESCAPE '\\'`, sql`${employees.jobTitle} LIKE ${text} ESCAPE '\\'`) as SQL);
  }
  const condition = where.length ? and(...where) : undefined;
  const order =
    filters.sort === "newest"
      ? [desc(employees.createdAt), asc(employees.name)]
      : filters.sort === "last_login"
        ? [sql`${employees.lastLoginAt} IS NULL`, desc(employees.lastLoginAt), asc(employees.name)]
        : [asc(employees.status), asc(employees.name)];
  const [rows, count, counts, roleRows] = await Promise.all([
    db
      .select({
        id: employees.id,
        name: employees.name,
        email: employees.email,
        jobTitle: employees.jobTitle,
        status: employees.status,
        branchId: employees.branchId,
        lastLoginAt: employees.lastLoginAt,
        createdAt: employees.createdAt,
        disabledAt: employees.disabledAt,
        isDemo: employees.isDemo,
      })
      .from(employees)
      .where(condition)
      .orderBy(...order)
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)` }).from(employees).where(condition).get(),
    db.all<{ active: number; disabled: number; demo: number }>(
      sql`SELECT coalesce(sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active, coalesce(sum(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END), 0) AS disabled, coalesce(sum(is_demo), 0) AS demo FROM employees ${limit ? sql`WHERE branch_id = ${limit}` : sql``}`,
    ),
    db.select({ id: roles.id, key: roles.key, name: roles.name }).from(roles).orderBy(asc(roles.key)),
  ]);
  const [roleMap, branchMap] = await Promise.all([
    rolesOf(
      db,
      rows.map((row) => row.id),
      locale,
    ),
    branchNames(
      db,
      rows.map((row) => row.branchId),
      locale,
    ),
  ]);
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map((row) => ({ ...row, roles: roleMap.get(row.id) ?? [], branch: row.branchId ? (branchMap.get(row.branchId) ?? row.branchId) : null })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: { active: Number(counts[0]?.active ?? 0), disabled: Number(counts[0]?.disabled ?? 0), demo: Number(counts[0]?.demo ?? 0) },
    roles: roleRows.map((row) => ({ id: row.id, key: row.key, name: pick(row.name, locale) })),
  };
}

// ───────────────────────────────────────────────────────────────── effective permissions (15.01, read-only)

/**
 * Every permission an employee's roles grant, grouped by module in blueprint order, the protected-data ones marked,
 * each with the roles that grant it ("*" — the owner's wildcard — grants every one).
 */
export async function effectivePermissions(db: Db, employeeId: string, locale: Locale): Promise<{ count: number; all: boolean; field: Permission[]; groups: PermissionGroupView[] }> {
  const rows = await db
    .select({ roleId: roles.id, roleName: roles.name, permission: rolePermissions.permission })
    .from(employeeRoles)
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(eq(employeeRoles.employeeId, employeeId));
  const grantedBy = new Map<Permission, Set<string>>();
  let all = false;
  for (const row of rows) {
    const roleName = pick(row.roleName, locale);
    const concrete = row.permission === WILDCARD_PERMISSION ? PERMISSIONS : expandPermissions([row.permission]);
    if (row.permission === WILDCARD_PERMISSION) all = true;
    for (const permission of concrete) grantedBy.set(permission, (grantedBy.get(permission) ?? new Set()).add(roleName));
  }
  const field = new Set<string>(FIELD_PERMISSIONS);
  const lang = locale === "en" ? "en" : "ar";
  const groups: PermissionGroupView[] = PERMISSION_GROUPS.map((group) => ({
    key: group.key,
    module: group.module,
    label: group[lang],
    permissions: PERMISSIONS.filter((key) => PERMISSION_DEFS[key].group === group.key && grantedBy.has(key)).map((key) => ({
      key,
      label: PERMISSION_DEFS[key][lang],
      field: field.has(key),
      roles: [...(grantedBy.get(key) ?? [])].sort(),
    })),
  })).filter((group) => group.permissions.length > 0);
  return { count: grantedBy.size, all, field: FIELD_PERMISSIONS.filter((permission) => grantedBy.has(permission)), groups };
}

// ───────────────────────────────────────────────────────────────── one employee

export type EmployeeProfile = {
  employee: EmployeeRow & { phone: string | null; twoStep: boolean; passwordChangedAt: number | null; updatedAt: number };
  /** staff.payroll.read only; null otherwise (absent from the page data, never 0). */
  salary: { baseSalaryIqd: number | null; changedAt: number | null; changedBy: string | null; openAdvancesIqd: number; pendingAdvancesIqd: number } | null;
  permissions: Awaited<ReturnType<typeof effectivePermissions>>;
  /** Live sessions (staff.manage or security.session.read); null without. */
  sessions: SessionRow[] | null;
  /** The last 20 sign-in events (staff.manage or security.auth_event.read); null without. */
  signIns: SignInRow[] | null;
  /** This month (Baghdad) at a glance. */
  month: { period: string; shifts: number; attended: number; late: number; leaveDays: number; openTasks: number };
  isSelf: boolean;
  /** This employee holds a permission the viewer does not: the viewer may not terminate them. */
  outranked: boolean;
  links: { roleEditor: boolean; securityPage: boolean };
  can: { editProfile: boolean; setSalary: boolean; terminate: boolean; revoke: boolean };
};

export async function getEmployeeProfile(db: Db, actor: Actor, employeeId: string, locale: Locale, now: number, currentSessionId: string | null = null): Promise<EmployeeProfile> {
  assertAny(actor, READERS);
  const facts = await employeeFacts(db, employeeId);
  assertReach(actor, facts);
  const access = staffAccess(actor);
  const row = await db
    .select({ phone: employees.phone, totpEnabled: employees.totpEnabled, lastLoginAt: employees.lastLoginAt, passwordChangedAt: employees.passwordChangedAt, updatedAt: employees.updatedAt })
    .from(employees)
    .where(eq(employees.id, facts.id))
    .get();
  const period = periodOf(now);
  const range = periodRange(period);
  const [roleMap, branchMap, permissions, stored, sessions, events, salaryEvent, advances, month] = await Promise.all([
    rolesOf(db, [facts.id], locale),
    branchNames(db, [facts.branchId], locale),
    effectivePermissions(db, facts.id, locale),
    storedPermissionsOf(db, facts.id),
    access.sessions ? listEmployeeSessions(db, facts.id, now, currentSessionId) : Promise.resolve(null),
    access.signIns
      ? db
          .select()
          .from(authEvents)
          .where(and(eq(authEvents.subjectKind, "employee"), eq(authEvents.subjectId, facts.id)))
          .orderBy(desc(authEvents.at))
          .limit(20)
      : Promise.resolve(null),
    access.payrollRead
      ? db
          .select({ at: auditEvents.at, actorId: auditEvents.actorId })
          .from(auditEvents)
          .where(and(eq(auditEvents.entityType, "employee"), eq(auditEvents.entityId, facts.id), eq(auditEvents.action, "staff.payroll.salary_set")))
          .orderBy(desc(auditEvents.seq))
          .limit(1)
          .get()
      : Promise.resolve(undefined),
    access.payrollRead
      ? db.all<{ open: number; pending: number }>(sql`SELECT
          coalesce((SELECT sum(amount_iqd) FROM employee_advances WHERE employee_id = ${facts.id} AND status = 'open'), 0) AS open,
          coalesce((SELECT sum(CAST(json_extract(payload, '$.amountIqd') AS INTEGER)) FROM approvals WHERE kind = ${ADVANCE_APPROVAL_KIND} AND entity_id = ${facts.id} AND status = 'pending'), 0) AS pending`)
      : Promise.resolve(null),
    db.all<{ shifts: number; attended: number; late: number; openTasks: number }>(sql`SELECT
        (SELECT count(*) FROM shifts WHERE employee_id = ${facts.id} AND status <> 'cancelled' AND starts_at >= ${range.from} AND starts_at < ${range.to}) AS shifts,
        (SELECT count(DISTINCT shift_id) FROM attendance WHERE employee_id = ${facts.id} AND shift_id IS NOT NULL AND clock_in_at >= ${range.from} AND clock_in_at < ${range.to}) AS attended,
        (SELECT count(*) FROM attendance a JOIN shifts s ON s.id = a.shift_id WHERE a.employee_id = ${facts.id} AND a.clock_in_at >= ${range.from} AND a.clock_in_at < ${range.to} AND a.clock_in_at > s.starts_at + 600000) AS late,
        (SELECT count(*) FROM staff_tasks WHERE assigned_to = ${facts.id} AND status IN ('open', 'in_progress')) AS openTasks`),
  ]);
  const leave = await db
    .select({ startsOn: leaveRequests.startsOn, endsOn: leaveRequests.endsOn })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.employeeId, facts.id), eq(leaveRequests.status, "approved"), sql`${leaveRequests.endsOn} >= ${`${period}-01`}`, sql`${leaveRequests.startsOn} <= ${`${period}-31`}`));
  const leaveDays = countLeaveDaysIn(leave, period);
  const salaryBy = salaryEvent?.actorId ? (await peopleById(db, [salaryEvent.actorId])).get(salaryEvent.actorId)?.name ?? null : null;
  const isSelf = actorId(actor) === facts.id;
  const outranked = !holdsAll(actor, stored);
  return {
    employee: {
      id: facts.id,
      name: facts.name,
      email: facts.email,
      jobTitle: facts.jobTitle,
      status: facts.status,
      roles: roleMap.get(facts.id) ?? [],
      branch: facts.branchId ? (branchMap.get(facts.branchId) ?? facts.branchId) : null,
      lastLoginAt: row?.lastLoginAt ?? null,
      createdAt: facts.createdAt,
      disabledAt: facts.disabledAt,
      isDemo: facts.isDemo,
      phone: row?.phone ?? null,
      twoStep: row?.totpEnabled ?? false,
      passwordChangedAt: row?.passwordChangedAt ?? null,
      updatedAt: row?.updatedAt ?? facts.createdAt,
    },
    salary: access.payrollRead
      ? { baseSalaryIqd: facts.baseSalaryIqd, changedAt: salaryEvent?.at ?? null, changedBy: salaryBy, openAdvancesIqd: Number(advances?.[0]?.open ?? 0), pendingAdvancesIqd: Number(advances?.[0]?.pending ?? 0) }
      : null,
    permissions,
    sessions: sessions ? sessions.map((session) => ({ id: session.id, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, ip: session.ip, ...deviceOf(session.userAgent), mfaOk: session.mfaOk, current: session.current })) : null,
    signIns: events ? events.map((event) => authEventView(actor, event, facts.name)) : null,
    month: { period, shifts: Number(month[0]?.shifts ?? 0), attended: Number(month[0]?.attended ?? 0), late: Number(month[0]?.late ?? 0), leaveDays, openTasks: Number(month[0]?.openTasks ?? 0) },
    isSelf,
    outranked: !isSelf && outranked,
    links: {
      // the role editor opens with staff.manage too (the admin gate's ALSO_OPENED_BY), or with a security reader
      roleEditor: can(actor, "staff.manage") || (canSeeModule(actor, "security") && (can(actor, "security.access_review.perform") || can(actor, "security.session.read"))),
      securityPage: canSeeModule(actor, "security") && can(actor, "security.session.read"),
    },
    can: {
      editProfile: access.manage,
      setSalary: access.payrollRun && !isSelf && facts.status === "active",
      terminate: access.manage && !isSelf && facts.status === "active" && !outranked,
      revoke: access.revoke && !isSelf,
    },
  };
}

/** Days of approved leave that fall inside a month. */
export function countLeaveDaysIn(rows: readonly { startsOn: string; endsOn: string }[], period: string): number {
  const first = `${period}-01`;
  const lastDay = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
  const last = `${period}-${String(lastDay).padStart(2, "0")}`;
  let days = 0;
  for (const row of rows) {
    const from = row.startsOn > first ? row.startsOn : first;
    const to = row.endsOn < last ? row.endsOn : last;
    if (to < from) continue;
    days += Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  }
  return days;
}

// ───────────────────────────────────────────────────────────────── HR facts

const ProfileInput = z.object({
  employeeId: IdSchema,
  jobTitle: z
    .string()
    .overwrite(cleanLine)
    .max(80, "too_long")
    .nullish()
    .transform((value) => value || null),
  phone: z
    .string()
    .overwrite(cleanLine)
    .max(30, "too_long")
    .refine((value) => value === "" || /^[+\d\s()\-٠-٩۰-۹]{6,30}$/.test(value), "phone_invalid")
    .nullish()
    .transform((value) => value || null),
  reason: Reason,
  expectedUpdatedAt: z.number({ error: "required" }).int(),
});

/** Job title and phone (staff.manage), guarded on the row the form showed; audited before/after. */
export async function updateEmployeeProfile(db: Db, actor: Actor, raw: z.input<typeof ProfileInput>, now: number): Promise<{ changed: boolean }> {
  assertAny(actor, ["staff.manage"]);
  const input = ProfileInput.parse(raw);
  const before = await db.select({ jobTitle: employees.jobTitle, phone: employees.phone, updatedAt: employees.updatedAt, branchId: employees.branchId }).from(employees).where(eq(employees.id, input.employeeId)).get();
  if (!before) throw new AppError("not_found", 404, { detail: "employee" });
  assertReach(actor, before);
  if (before.updatedAt !== input.expectedUpdatedAt) throw new AppError("employee_changed", 409);
  if (before.jobTitle === input.jobTitle && before.phone === input.phone) return { changed: false };
  try {
    await runBatch(db, [
      db
        .update(employees)
        .set({ jobTitle: input.jobTitle, phone: input.phone, updatedAt: now })
        .where(and(eq(employees.id, input.employeeId), eq(employees.updatedAt, input.expectedUpdatedAt))),
      expectThat(db, sql`(SELECT updated_at FROM employees WHERE id = ${input.employeeId}) = ${now}`, { code: "EMPLOYEE_CHANGED", detail: input.employeeId }),
      auditStatement(db, { actor, action: "staff.employee.update", entityType: "employee", entityId: input.employeeId, before: { jobTitle: before.jobTitle, phone: before.phone }, after: { jobTitle: input.jobTitle, phone: input.phone }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "EMPLOYEE_CHANGED")) throw new AppError("employee_changed", 409);
    throw error;
  }
  return { changed: true };
}

const SalaryInput = z.object({
  employeeId: IdSchema,
  baseSalaryIqd: wholeIqd(MAX_PAY_IQD).nullable(),
  /** The monthly base the form showed (null: none was set). */
  expectedIqd: z.number().int().nullable(),
  reason: Reason,
});

/**
 * The monthly base salary (staff.payroll.run): never one's own (salary_self_change), only for an active employee,
 * guarded on the value the form showed; audited with before and after under staff.payroll.* (module 20 is asked to
 * withhold those snapshots from readers without staff.payroll.read). A payroll run shows every salary changed since
 * the employee's last paid run, and whoever changed one may not approve that run.
 */
export async function setBaseSalary(db: Db, actor: Actor, raw: z.input<typeof SalaryInput>, now: number): Promise<{ changed: boolean }> {
  assertAny(actor, ["staff.payroll.run"]);
  const input = SalaryInput.parse(raw);
  if (actorId(actor) === input.employeeId) throw new AppError("salary_self_change", 403);
  const facts = await employeeFacts(db, input.employeeId);
  assertReach(actor, facts);
  if (facts.status !== "active") throw new AppError("employee_inactive", 409);
  if (facts.baseSalaryIqd !== input.expectedIqd) throw new AppError("employee_changed", 409);
  if (facts.baseSalaryIqd === input.baseSalaryIqd) return { changed: false };
  try {
    await runBatch(db, [
      db
        .update(employees)
        .set({ baseSalaryIqd: input.baseSalaryIqd, updatedAt: now })
        .where(and(eq(employees.id, facts.id), input.expectedIqd === null ? isNull(employees.baseSalaryIqd) : eq(employees.baseSalaryIqd, input.expectedIqd), eq(employees.status, "active"))),
      expectThat(db, sql`(SELECT updated_at FROM employees WHERE id = ${facts.id}) = ${now}`, { code: "EMPLOYEE_CHANGED", detail: facts.id }),
      auditStatement(db, { actor, action: "staff.payroll.salary_set", entityType: "employee", entityId: facts.id, before: { baseSalaryIqd: facts.baseSalaryIqd }, after: { baseSalaryIqd: input.baseSalaryIqd }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "EMPLOYEE_CHANGED")) throw new AppError("employee_changed", 409);
    throw error;
  }
  return { changed: true };
}

// ───────────────────────────────────────────────────────────────── termination (15.07)

export type TerminationPlan = {
  employee: { id: string; name: string; status: "active" | "disabled" };
  liveSessions: number;
  futureShifts: number;
  pendingLeave: number;
  openAttendance: boolean;
  openTasks: number;
  pendingRequests: number;
  /** staff.payroll.read only. */
  openAdvancesIqd: number | null;
  blockers: ("self" | "outranked" | "inactive")[];
};

export async function terminationPlan(db: Db, actor: Actor, employeeId: string, now: number): Promise<TerminationPlan> {
  assertAny(actor, ["staff.manage"]);
  const facts = await employeeFacts(db, employeeId);
  assertReach(actor, facts);
  const stored = await storedPermissionsOf(db, facts.id);
  const [counts] = await db.all<{ sessions: number; shifts: number; leave: number; open: number; tasks: number; requests: number; advances: number }>(sql`SELECT
      (SELECT count(*) FROM employee_sessions WHERE employee_id = ${facts.id} AND revoked_at IS NULL AND expires_at > ${now}) AS sessions,
      (SELECT count(*) FROM shifts WHERE employee_id = ${facts.id} AND status = 'scheduled' AND starts_at > ${now}) AS shifts,
      (SELECT count(*) FROM leave_requests WHERE employee_id = ${facts.id} AND status = 'pending') AS leave,
      (SELECT count(*) FROM attendance WHERE employee_id = ${facts.id} AND clock_out_at IS NULL) AS open,
      (SELECT count(*) FROM staff_tasks WHERE assigned_to = ${facts.id} AND status IN ('open', 'in_progress')) AS tasks,
      (SELECT count(*) FROM approvals WHERE requested_by = ${facts.id} AND status = 'pending') AS requests,
      coalesce((SELECT sum(amount_iqd) FROM employee_advances WHERE employee_id = ${facts.id} AND status = 'open'), 0) AS advances`);
  const blockers: TerminationPlan["blockers"] = [];
  if (actorId(actor) === facts.id) blockers.push("self");
  if (!holdsAll(actor, stored)) blockers.push("outranked");
  if (facts.status !== "active") blockers.push("inactive");
  return {
    employee: { id: facts.id, name: facts.name, status: facts.status },
    liveSessions: Number(counts?.sessions ?? 0),
    futureShifts: Number(counts?.shifts ?? 0),
    pendingLeave: Number(counts?.leave ?? 0),
    openAttendance: Number(counts?.open ?? 0) > 0,
    openTasks: Number(counts?.tasks ?? 0),
    pendingRequests: Number(counts?.requests ?? 0),
    openAdvancesIqd: can(actor, "staff.payroll.read") ? Number(counts?.advances ?? 0) : null,
    blockers,
  };
}

const TerminateInput = z.object({ employeeId: IdSchema, reason: Reason });

/**
 * Ends an employee's access now (staff.manage, a reason): the sign-in service disables the account and ends every
 * session in one batch (they are refused on their very next request), then this module cancels their future shifts
 * and pending leave and closes an open attendance record. Never one's own account (own_account_here) nor one that
 * holds a permission the actor does not (target_more_privileged) — the auth service enforces its own rules as well.
 * Open tasks stay where they are, flagged on the task list, for a manager to hand over; open advances stay open and
 * are deducted by the next payroll run (the final settlement).
 */
export async function terminateEmployee(db: Db, actor: Actor, raw: z.input<typeof TerminateInput>, now: number): Promise<{ sessionsEnded: number; shiftsCancelled: number; leaveCancelled: number; attendanceClosed: number }> {
  assertAny(actor, ["staff.manage"]);
  const input = TerminateInput.parse(raw);
  if (actorId(actor) === input.employeeId) throw new AppError("own_account_here", 409);
  const facts = await employeeFacts(db, input.employeeId);
  assertReach(actor, facts);
  if (!holdsAll(actor, await storedPermissionsOf(db, facts.id))) throw new AppError("target_more_privileged", 403);
  const live = await db
    .select({ n: sql<number>`count(*)` })
    .from(employeeSessions)
    .where(and(eq(employeeSessions.employeeId, facts.id), isNull(employeeSessions.revokedAt), gt(employeeSessions.expiresAt, now)))
    .get();
  await disableEmployee(db, actor, { employeeId: facts.id, reason: input.reason }, now);

  // Housekeeping: the module's own records. The account is already locked whatever happens here.
  const [future, pending, open] = await Promise.all([
    db.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.employeeId, facts.id), eq(shifts.status, "scheduled"), gt(shifts.startsAt, now))),
    db.select({ id: leaveRequests.id }).from(leaveRequests).where(and(eq(leaveRequests.employeeId, facts.id), eq(leaveRequests.status, "pending"))),
    db.select({ id: attendance.id, clockInAt: attendance.clockInAt }).from(attendance).where(and(eq(attendance.employeeId, facts.id), isNull(attendance.clockOutAt))),
  ]);
  const shiftIds = future.map((row) => row.id);
  const leaveIds = pending.map((row) => row.id);
  const openIds = open.map((row) => row.id);
  if (shiftIds.length || leaveIds.length || openIds.length) {
    await runBatch(db, [
      ...(shiftIds.length ? [db.update(shifts).set({ status: "cancelled" }).where(and(inArray(shifts.id, shiftIds), eq(shifts.status, "scheduled")))] : []),
      ...(leaveIds.length ? [db.update(leaveRequests).set({ status: "cancelled", decidedBy: actorId(actor), decidedAt: now }).where(and(inArray(leaveRequests.id, leaveIds), eq(leaveRequests.status, "pending")))] : []),
      ...(openIds.length ? [db.update(attendance).set({ clockOutAt: now, note: sql`trim(coalesce(${attendance.note}, '') || ' [closed at termination]')` }).where(and(inArray(attendance.id, openIds), isNull(attendance.clockOutAt)))] : []),
      auditStatement(db, {
        actor,
        action: "staff.employee.offboard",
        entityType: "employee",
        entityId: facts.id,
        summary: `${facts.name}: access ended`,
        after: { shiftsCancelled: shiftIds.length, leaveCancelled: leaveIds.length, attendanceClosed: openIds.length },
        reason: input.reason,
        at: now,
      }),
    ]);
  }
  return { sessionsEnded: Number(live?.n ?? 0), shiftsCancelled: shiftIds.length, leaveCancelled: leaveIds.length, attendanceClosed: openIds.length };
}

/** One session of someone else (security.session.revoke, a reason) — module 20's rule, through the sign-in service. */
export async function endEmployeeSession(db: Db, actor: Actor, raw: { employeeId: string; sessionId: string; reason: string }, now: number): Promise<{ ended: boolean }> {
  await assertReachOf(db, actor, raw.employeeId);
  return endStaffSession(db, actor, raw, now);
}

/** Every session of someone else (security.session.revoke, a reason). */
export async function endEmployeeSessions(db: Db, actor: Actor, raw: { employeeId: string; reason: string }, now: number): Promise<{ ended: number }> {
  await assertReachOf(db, actor, raw.employeeId);
  return endAllStaffSessions(db, actor, raw, now);
}
