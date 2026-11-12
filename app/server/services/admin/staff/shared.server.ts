/**
 * Admin module 15 "staff" — what every service of the module shares: who may do what (staffAccess), the zod pieces of
 * its inputs, names of employees and roles for views, and "who took part" in a record (the audit trail, for the
 * two-person rules). Server only.
 */
import { and, asc, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { pick, type Locale } from "~/lib/locales";
import { assertBranch, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, branches, employeeRoles, employees, roles } from "~/server/db/schema";
import { AppError, forbidden, notFound } from "~/server/errors";
import { PERMISSIONS, PERMISSION_DEFS, type Permission } from "~/server/permissions";
import type { ByView, PersonRef, RoleRef } from "./types";

/** Every permission of the module's group (staff.*), in catalogue order. */
export const STAFF_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((permission) => PERMISSION_DEFS[permission].group === "staff");

export type StaffAccess = {
  /** staff.manage — HR profile, termination. */
  manage: boolean;
  /** staff.employee.read — the directory. */
  read: boolean;
  schedule: boolean;
  attendance: boolean;
  leave: boolean;
  tasks: boolean;
  commissions: boolean;
  payrollRead: boolean;
  payrollRun: boolean;
  payrollApprove: boolean;
  performance: boolean;
  approvals: boolean;
  /** Field-level: profit and margin (profit-based commission plans and their bases). */
  profit: boolean;
  /** Sessions and the sign-in log of other employees (15.07). */
  sessions: boolean;
  signIns: boolean;
  revoke: boolean;
  /** Limited to one branch: works only with the staff of that branch, and never with the store-wide payroll. */
  limited: boolean;
  /** Derived: who may open which section. */
  directory: boolean;
  roster: boolean;
  attendanceView: boolean;
  leaveView: boolean;
  tasksView: boolean;
  commissionView: boolean;
  payrollView: boolean;
};

export function staffAccess(actor: Actor): StaffAccess {
  const has = (permission: Permission) => can(actor, permission);
  const manage = has("staff.manage");
  const read = has("staff.employee.read");
  const schedule = has("staff.schedule.manage");
  const attendance = has("staff.attendance.manage");
  const leave = has("staff.leave.approve");
  const tasks = has("staff.task.manage");
  const commissions = has("staff.commission.manage");
  const payrollRead = has("staff.payroll.read");
  const payrollRun = has("staff.payroll.run");
  const payrollApprove = has("staff.payroll.approve");
  const limited = branchLimit(actor) !== null;
  return {
    manage,
    read,
    schedule,
    attendance,
    leave,
    tasks,
    commissions,
    payrollRead,
    payrollRun,
    payrollApprove,
    performance: has("staff.performance.read"),
    approvals: has("staff.approval.read"),
    profit: has("profit.read"),
    sessions: manage || has("security.session.read"),
    signIns: manage || has("security.auth_event.read"),
    revoke: has("security.session.revoke"),
    limited,
    directory: read || manage,
    roster: read || schedule || attendance,
    attendanceView: attendance || schedule,
    leaveView: leave || read,
    tasksView: tasks || read,
    commissionView: commissions || payrollRead,
    payrollView: (payrollRead || payrollRun || payrollApprove) && !limited,
  };
}

/** Throws forbidden unless the actor holds at least one of the permissions. */
export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions.join("|"));
}

// ───────────────────────────────────────────────────────────────── branch limits

/**
 * The branch an employee is limited to (module 20 sets it; actor.branchId), or null. A limited employee works with
 * the staff of THAT branch only: never someone of another branch, nor someone of the whole store (no branch) — the
 * same rule as canAccessBranch, applied to the employee a record belongs to (review 2026-11-12).
 */
export function branchLimit(actor: Actor): string | null {
  return actor.kind === "employee" ? (actor.branchId ?? null) : null;
}

/** Throws forbidden("branch") (403) unless the actor may work with that employee's records. */
export function assertReach(actor: Actor, employee: { branchId: string | null }): void {
  assertBranch(actor, employee.branchId);
}

/** SQL: the employee `employeeId` (a column) is within the actor's reach; undefined when nothing limits the actor. */
export function reachSql(actor: Actor, employeeId: SQLWrapper): SQL | undefined {
  const limit = branchLimit(actor);
  return limit ? sql`${employeeId} IN (SELECT reach.id FROM employees AS reach WHERE reach.branch_id = ${limit})` : undefined;
}

/** Throws forbidden("branch") (403) for the employee `employeeId` when it is out of the actor's reach (or unknown). */
export async function assertReachOf(db: Db, actor: Actor, employeeId: string | null): Promise<void> {
  if (!branchLimit(actor)) return;
  const row = employeeId && ID.test(employeeId) ? await db.select({ branchId: employees.branchId }).from(employees).where(eq(employees.id, employeeId)).get() : undefined;
  assertReach(actor, { branchId: row?.branchId ?? null });
}

/** A payroll run covers every branch: only an employee without a branch limit prepares, reads, approves or pays one. */
export function assertWholeStore(actor: Actor): void {
  if (branchLimit(actor)) throw forbidden("branch");
}

/** The employee id of the actor, or null for the system. */
export function actorId(actor: Actor): string | null {
  return actor.kind === "employee" ? actor.id : null;
}

/** The id stored as `created_by` / `requested_by`: the employee, or "system:<job>". */
export function stamp(actor: Actor): string {
  if (actor.kind === "employee") return actor.id;
  if (actor.kind === "system") return `system:${actor.job}`;
  return actor.kind;
}

// ───────────────────────────────────────────────────────────────── input pieces

export const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
export const IdSchema = z.string({ error: "required" }).trim().min(1, "required").regex(ID, "invalid");
/** A client-made idempotency key: 16–128 URL-safe characters. */
export const KeySchema = z.string({ error: "required" }).trim().regex(/^[A-Za-z0-9_-]{16,128}$/, "invalid");

/** Control characters out, surrounding space trimmed. */
export const cleanLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
export const cleanBlock = (value: string) => value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\r\n?/g, "\n").trim();

export const Reason = z.string({ error: "required" }).overwrite(cleanBlock).min(3, "reason_required").max(500, "too_long");
export const OptionalNote = z
  .string()
  .overwrite(cleanBlock)
  .max(500, "too_long")
  .nullish()
  .transform((value) => value || null);

/** A whole number of IQD, ≥ 0 and ≤ max. NaN (what parseWhole returns for a typo) is "invalid". */
export const wholeIqd = (max: number) =>
  z
    .number({ error: "required" })
    .refine((value) => !Number.isNaN(value), "invalid")
    .refine((value) => Number.isSafeInteger(value), "invalid")
    .refine((value) => value >= 0, "too_small")
    .refine((value) => value <= max, "too_big");

// ───────────────────────────────────────────────────────────────── people

export type EmployeeFacts = {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled";
  branchId: string | null;
  jobTitle: string | null;
  baseSalaryIqd: number | null;
  createdAt: number;
  disabledAt: number | null;
  isDemo: boolean;
};

export async function employeeFacts(db: Db, employeeId: string): Promise<EmployeeFacts> {
  if (!ID.test(employeeId)) throw notFound("employee");
  const row = await db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      status: employees.status,
      branchId: employees.branchId,
      jobTitle: employees.jobTitle,
      baseSalaryIqd: employees.baseSalaryIqd,
      createdAt: employees.createdAt,
      disabledAt: employees.disabledAt,
      isDemo: employees.isDemo,
    })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .get();
  if (!row) throw notFound("employee");
  return row;
}

/** An employee who still works here (active), or 409 employee_inactive. */
export async function activeEmployee(db: Db, employeeId: string): Promise<EmployeeFacts> {
  const row = await employeeFacts(db, employeeId);
  if (row.status !== "active") throw new AppError("employee_inactive", 409, { fields: { employeeId: "employee_inactive" } });
  return row;
}

/** id → { name, isDemo } of employees (missing ids are left out). */
export async function peopleById(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, PersonRef & { status: "active" | "disabled"; jobTitle: string | null }>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && ID.test(id)))];
  const out = new Map<string, PersonRef & { status: "active" | "disabled"; jobTitle: string | null }>();
  for (let at = 0; at < wanted.length; at += 90) {
    const rows = await db
      .select({ id: employees.id, name: employees.name, isDemo: employees.isDemo, status: employees.status, jobTitle: employees.jobTitle })
      .from(employees)
      .where(inArray(employees.id, wanted.slice(at, at + 90)));
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

export function personOf(map: Map<string, PersonRef>, id: string): PersonRef {
  const hit = map.get(id);
  return hit ? { id: hit.id, name: hit.name, isDemo: hit.isDemo } : { id, name: id, isDemo: false };
}

/** Who made something, in words: an employee's name, the system, or an id that no longer resolves. */
export function byView(map: Map<string, PersonRef>, id: string | null | undefined): ByView {
  if (!id) return { kind: "unknown", name: null };
  if (id.startsWith("system")) return { kind: "system", name: null };
  const hit = map.get(id);
  return hit ? { kind: "employee", name: hit.name } : { kind: "unknown", name: null };
}

/** The roles of each employee, by key. */
export async function rolesOf(db: Db, employeeIds: readonly string[], locale: Locale): Promise<Map<string, RoleRef[]>> {
  const out = new Map<string, RoleRef[]>();
  for (let at = 0; at < employeeIds.length; at += 90) {
    const rows = await db
      .select({ employeeId: employeeRoles.employeeId, id: roles.id, key: roles.key, name: roles.name })
      .from(employeeRoles)
      .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
      .where(inArray(employeeRoles.employeeId, employeeIds.slice(at, at + 90)))
      .orderBy(asc(roles.key));
    for (const row of rows) out.set(row.employeeId, [...(out.get(row.employeeId) ?? []), { id: row.id, key: row.key, name: pick(row.name, locale) }]);
  }
  return out;
}

export async function branchNames(db: Db, ids: readonly (string | null)[], locale: Locale): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: branches.id, name: branches.name }).from(branches).where(inArray(branches.id, wanted));
  return new Map(rows.map((row) => [row.id, pick(row.name, locale)]));
}

/** Employees a form may name (active first, then by name), at most 500; `branchId`: only the staff of that branch (a limited actor's reach). */
export async function employeeOptions(db: Db, options: { includeDisabled?: boolean; demo?: boolean | null; branchId?: string | null } = {}): Promise<(PersonRef & { status: "active" | "disabled" })[]> {
  const conditions = [];
  if (options.branchId) conditions.push(eq(employees.branchId, options.branchId));
  if (!options.includeDisabled) conditions.push(eq(employees.status, "active"));
  if (options.demo === true) conditions.push(eq(employees.isDemo, true));
  if (options.demo === false) conditions.push(eq(employees.isDemo, false));
  return db
    .select({ id: employees.id, name: employees.name, isDemo: employees.isDemo, status: employees.status })
    .from(employees)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(employees.status), asc(employees.name))
    .limit(500);
}

// ───────────────────────────────────────────────────────────────── two-person rules

/**
 * Everyone who took part in a record according to the audit trail: the employees behind events of `actions` on
 * entity (type, id). The audit trail is append-only, so a part once taken cannot be erased by a later edit.
 */
export async function participants(db: Db, entityType: string, entityId: string, actions: readonly string[]): Promise<Set<string>> {
  if (!actions.length) return new Set();
  const rows = await db
    .select({ actorId: auditEvents.actorId })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId), eq(auditEvents.actorKind, "employee"), inArray(auditEvents.action, [...actions])));
  return new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id)));
}

/** SQL: true when `employeeId` appears in the audit trail of the entity with one of the actions (for guards inside a batch). */
export function tookPartSql(entityType: string, entityId: string, actions: readonly string[], employeeId: string) {
  return sql`EXISTS (SELECT 1 FROM audit_events AS a WHERE a.entity_type = ${entityType} AND a.entity_id = ${entityId}
    AND a.actor_kind = 'employee' AND a.actor_id = ${employeeId} AND a.action IN (${sql.join(
      actions.map((action) => sql`${action}`),
      sql`, `,
    )}))`;
}
