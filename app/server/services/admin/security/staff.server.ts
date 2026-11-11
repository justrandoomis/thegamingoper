/**
 * Admin 20.01 — staff accounts as security sees them: who has two-step verification (and, per role, who does not),
 * the live sessions of every employee (ended one at a time or all at once, with a reason), resetting someone's
 * two-step verification after a lost phone, and each employee's recent sign-in events.
 *
 * The work is the auth service's (app/server/auth/admin.server.ts): revokeEmployeeSession / revokeAllEmployeeSessions
 * (`security.session.revoke` for someone else's) and resetEmployeeMfa (`security.mfa.manage`), each audited there.
 * This file adds the module's rules: a reason for every action, never one's own account here (that is /admin/me,
 * where ending the session in use and turning two-step off ask for the password), and the views.
 *
 * Not offered, on purpose: requiring two-step verification for a role (the sign-in service would have to enforce it —
 * requested from its owner) and "trusted devices" (sign-in has no "trust this device" step; every sign-in asks for
 * the code, so there is nothing to list).
 */
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { ADMIN_IDLE_HOURS, listEmployeeSessions, resetEmployeeMfa, revokeAllEmployeeSessions, revokeEmployeeSession } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import { authEvents, branches, employeeRoles, employeeSessions, employees, rolePermissions, roles } from "~/server/db/schema";
import { AppError, notFound } from "~/server/errors";
import { FIELD_PERMISSIONS, expandPermissions, type Permission } from "~/server/permissions";
import { actorIdOf, deviceOf, holdsAll, identifierFor, storedPermissionsOf } from "./shared.server";
import type { AuthEventView, RoleRef, SessionView, StaffFilters, StaffRow } from "./types";

const PAGE_SIZE = 25;
const IDLE_MS = ADMIN_IDLE_HOURS * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const Reason = z.string({ error: "required" }).trim().min(3, "reason_required").max(500, "too_long");

/** Live (not revoked, not expired, used in the last 2 hours) sessions of an employee, as SQL. */
const liveSessionsSql = (now: number) =>
  sql<number>`(SELECT count(*) FROM employee_sessions s WHERE s.employee_id = ${employees.id} AND s.revoked_at IS NULL AND s.expires_at > ${now} AND s.last_seen_at > ${now - IDLE_MS})`;

export type StaffPage = {
  rows: StaffRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Two-step coverage, overall and per role (active employees only). */
  coverage: { active: number; withTwoStep: number; byRole: (RoleRef & { members: number; withTwoStep: number })[] };
  roles: RoleRef[];
};

async function rolesOf(db: Db, employeeIds: readonly string[], locale: Locale): Promise<Map<string, RoleRef[]>> {
  const out = new Map<string, RoleRef[]>();
  if (employeeIds.length === 0) return out;
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

export async function listStaffSecurity(db: Db, actor: Actor, filters: StaffFilters, locale: Locale, now: number): Promise<StaffPage> {
  assertCan(actor, "security.session.read");
  const where: SQL[] = [];
  if (filters.twoStep) where.push(eq(employees.totpEnabled, filters.twoStep === "on"));
  if (filters.status) where.push(eq(employees.status, filters.status));
  if (filters.role) where.push(sql`EXISTS (SELECT 1 FROM employee_roles er WHERE er.employee_id = ${employees.id} AND er.role_id = ${filters.role})`);
  if (filters.q) {
    const text = `%${filters.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(sql`${employees.name} LIKE ${text} ESCAPE '\\'`, sql`${employees.email} LIKE ${text.toLowerCase()} ESCAPE '\\'`) as SQL);
  }
  const condition = where.length ? and(...where) : undefined;
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, count, roleRows, coverage] = await Promise.all([
    db
      .select({ id: employees.id, name: employees.name, email: employees.email, status: employees.status, twoStep: employees.totpEnabled, lastLoginAt: employees.lastLoginAt, isDemo: employees.isDemo, live: liveSessionsSql(now) })
      .from(employees)
      .where(condition)
      // who lacks two-step comes first: that is what a security reviewer acts on
      .orderBy(asc(employees.status), asc(employees.totpEnabled), asc(employees.name))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(employees).where(condition).get(),
    db.select({ id: roles.id, key: roles.key, name: roles.name }).from(roles).orderBy(asc(roles.key)),
    db.all<{ roleId: string | null; members: number; withTwoStep: number }>(sql`
      SELECT er.role_id AS roleId, count(*) AS members, sum(CASE WHEN e.totp_enabled = 1 THEN 1 ELSE 0 END) AS withTwoStep
      FROM employees e LEFT JOIN employee_roles er ON er.employee_id = e.id
      WHERE e.status = 'active' GROUP BY er.role_id`),
  ]);
  const totals = await db.all<{ active: number; withTwoStep: number }>(sql`SELECT count(*) AS active, coalesce(sum(CASE WHEN totp_enabled = 1 THEN 1 ELSE 0 END), 0) AS withTwoStep FROM employees WHERE status = 'active'`);
  const byEmployee = await rolesOf(
    db,
    rows.map((row) => row.id),
    locale,
  );
  const total = Number(count?.n ?? 0);
  const roleList = roleRows.map((row) => ({ id: row.id, key: row.key, name: pick(row.name, locale) }));
  return {
    rows: rows.map((row) => ({ id: row.id, name: row.name, email: row.email, status: row.status, roles: byEmployee.get(row.id) ?? [], twoStep: row.twoStep, lastLoginAt: row.lastLoginAt, liveSessions: Number(row.live ?? 0), isDemo: row.isDemo })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    coverage: {
      active: Number(totals[0]?.active ?? 0),
      withTwoStep: Number(totals[0]?.withTwoStep ?? 0),
      byRole: roleList
        .map((role) => {
          const hit = coverage.find((row) => row.roleId === role.id);
          return { ...role, members: Number(hit?.members ?? 0), withTwoStep: Number(hit?.withTwoStep ?? 0) };
        })
        .filter((role) => role.members > 0),
    },
    roles: roleList,
  };
}

export type StaffDetail = {
  employee: {
    id: string;
    name: string;
    email: string;
    status: "active" | "disabled";
    jobTitle: string | null;
    branch: { id: string; name: string } | null;
    twoStep: boolean;
    lastLoginAt: number | null;
    passwordChangedAt: number | null;
    createdAt: number;
    isDemo: boolean;
  };
  roles: RoleRef[];
  /** The concrete permissions of all their roles ("all" for the owner's wildcard) and the protected-data ones among them. */
  permissions: { count: number; all: boolean; field: Permission[] };
  sessions: SessionView[];
  events: AuthEventView[];
  isSelf: boolean;
  /** This employee holds permissions the viewer does not, and the viewer would otherwise reset their two-step or set their branch. */
  outranked: boolean;
  can: { revoke: boolean; resetTwoStep: boolean; assignRoles: boolean; setBranch: boolean };
  /**
   * For the role and branch forms (staff.manage only), with what each role grants (for the impact of a change) and
   * whether this employee may give or take it (all of its permissions are their own).
   */
  allRoles: (RoleRef & { permissions: string[]; assignable: boolean })[] | null;
  branches: { id: string; name: string }[] | null;
};

/** One employee: sessions, two-step state, roles and what they grant, and the last 20 sign-in events. */
export async function getStaffSecurity(db: Db, actor: Actor, employeeId: string, locale: Locale, now: number, currentSessionId: string | null = null): Promise<StaffDetail> {
  assertCan(actor, "security.session.read");
  if (!ID.test(employeeId)) throw notFound("employee");
  const row = await db.select().from(employees).where(eq(employees.id, employeeId)).get();
  if (!row) throw notFound("employee");
  const manage = can(actor, "staff.manage");
  const [roleMap, grants, sessions, eventRows, branchRow, allRoles, allGrants, branchRows] = await Promise.all([
    rolesOf(db, [row.id], locale),
    db.select({ permission: rolePermissions.permission }).from(employeeRoles).innerJoin(rolePermissions, eq(rolePermissions.roleId, employeeRoles.roleId)).where(eq(employeeRoles.employeeId, row.id)),
    listEmployeeSessions(db, row.id, now, currentSessionId),
    can(actor, "security.auth_event.read") ? db.select().from(authEvents).where(and(eq(authEvents.subjectKind, "employee"), eq(authEvents.subjectId, row.id))).orderBy(desc(authEvents.at)).limit(20) : Promise.resolve([]),
    row.branchId ? db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.id, row.branchId)).get() : Promise.resolve(undefined),
    manage ? db.select({ id: roles.id, key: roles.key, name: roles.name }).from(roles).orderBy(asc(roles.key)) : Promise.resolve(null),
    manage ? db.select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission }).from(rolePermissions) : Promise.resolve(null),
    manage ? db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.isActive, true)).orderBy(asc(branches.code)) : Promise.resolve(null),
  ]);
  const stored = grants.map((grant) => grant.permission);
  const concrete = expandPermissions(stored);
  const isSelf = actorIdOf(actor) === row.id;
  // their second factor and their reach are only for someone who holds at least everything they hold
  const outranked = !holdsAll(actor, stored);
  return {
    employee: {
      id: row.id,
      name: row.name,
      email: row.email,
      status: row.status,
      jobTitle: row.jobTitle,
      branch: branchRow ? { id: branchRow.id, name: pick(branchRow.name, locale) } : row.branchId ? { id: row.branchId, name: row.branchId } : null,
      twoStep: row.totpEnabled,
      lastLoginAt: row.lastLoginAt,
      passwordChangedAt: row.passwordChangedAt,
      createdAt: row.createdAt,
      isDemo: row.isDemo,
    },
    roles: roleMap.get(row.id) ?? [],
    permissions: { count: concrete.size, all: stored.includes("*"), field: FIELD_PERMISSIONS.filter((permission) => concrete.has(permission)) },
    sessions: sessions.map((session) => ({ id: session.id, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, ip: session.ip, ...deviceOf(session.userAgent), mfaOk: session.mfaOk, current: session.current })),
    events: eventRows.map((event) => authEventView(actor, event, row.name)),
    isSelf,
    outranked: !isSelf && outranked && (manage || can(actor, "security.mfa.manage")),
    can: {
      revoke: !isSelf && can(actor, "security.session.revoke"),
      resetTwoStep: !isSelf && row.totpEnabled && can(actor, "security.mfa.manage") && !outranked,
      assignRoles: !isSelf && manage,
      setBranch: !isSelf && manage && !outranked,
    },
    allRoles: allRoles
      ? allRoles.map((role) => {
          const permissions = (allGrants ?? []).filter((grant) => grant.roleId === role.id).map((grant) => grant.permission);
          return { id: role.id, key: role.key, name: pick(role.name, locale), permissions, assignable: holdsAll(actor, permissions) };
        })
      : null,
    branches: branchRows ? branchRows.map((branch) => ({ id: branch.id, name: pick(branch.name, locale) })) : null,
  };
}

export function authEventView(actor: Actor, event: typeof authEvents.$inferSelect, subjectName: string | null): AuthEventView {
  const shown = identifierFor(actor, event.identifier);
  const details = (event.details ?? {}) as Record<string, unknown>;
  const found = [details.reason, details.change, details.method, details.secondStep, details.step, details.purpose].find((value) => typeof value === "string") as string | undefined;
  // "disabled" is a sign-in refusal (a disabled account) except on a two-step change, where it means "turned off"
  const reason = event.kind === "mfa_enroll" && found === "disabled" ? "disabled_change" : found;
  return {
    id: event.id,
    at: event.at,
    subjectKind: event.subjectKind,
    subjectId: event.subjectId,
    subjectName,
    identifier: shown.text,
    identifierMasked: shown.masked,
    kind: event.kind,
    success: event.success,
    reason: reason ?? null,
    ip: event.ip,
    ...deviceOf(event.userAgent),
  };
}

const TargetInput = z.object({ employeeId: z.string().regex(ID, "invalid"), reason: Reason });
const SessionInput = TargetInput.extend({ sessionId: z.string().regex(/^[0-9a-f]{64}$/, "invalid") });

/** Someone else's account only: one's own sessions and two-step setting are managed on /admin/me. */
function notSelf(actor: Actor, employeeId: string): void {
  if (actorIdOf(actor) === employeeId) throw new AppError("own_account_here", 409);
}

async function existing(db: Db, employeeId: string) {
  const row = await db.select({ id: employees.id, totpEnabled: employees.totpEnabled }).from(employees).where(eq(employees.id, employeeId)).get();
  if (!row) throw notFound("employee");
  return row;
}

/** Ends one of an employee's sessions; false when it had already ended. */
export async function endStaffSession(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ ended: boolean }> {
  assertCan(actor, "security.session.revoke");
  const input = SessionInput.parse(raw);
  notSelf(actor, input.employeeId);
  await existing(db, input.employeeId);
  return { ended: await revokeEmployeeSession(db, actor, { employeeId: input.employeeId, sessionId: input.sessionId, reason: input.reason }, now) };
}

/** Ends every session of an employee (half-open sign-ins included): they sign in again on their next click. */
export async function endAllStaffSessions(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ ended: number }> {
  assertCan(actor, "security.session.revoke");
  const input = TargetInput.parse(raw);
  notSelf(actor, input.employeeId);
  await existing(db, input.employeeId);
  const live = await db.select({ n: sql<number>`count(*)` }).from(employeeSessions).where(and(eq(employeeSessions.employeeId, input.employeeId), sql`${employeeSessions.revokedAt} IS NULL`, sql`${employeeSessions.expiresAt} > ${now}`)).get();
  await revokeAllEmployeeSessions(db, actor, { employeeId: input.employeeId, reason: input.reason }, now);
  return { ended: Number(live?.n ?? 0) };
}

/**
 * Removes an employee's two-step verification (lost phone); they are signed out everywhere and enrol again. Never for
 * someone who holds a permission the actor does not (`target_more_privileged`): with a known password, removing the
 * second factor of a stronger account is taking it over (review 2026-11-11).
 */
export async function resetStaffTwoStep(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ reset: true }> {
  assertCan(actor, "security.mfa.manage");
  const input = TargetInput.parse(raw);
  notSelf(actor, input.employeeId);
  const row = await existing(db, input.employeeId);
  if (!holdsAll(actor, await storedPermissionsOf(db, row.id))) throw new AppError("target_more_privileged", 403);
  if (!row.totpEnabled) throw new AppError("two_step_not_on", 409);
  await resetEmployeeMfa(db, actor, { employeeId: input.employeeId, reason: input.reason }, now);
  return { reset: true };
}

/** Employees for the role page and the alerts (id → name), active first. */
export async function staffOptions(db: Db, actor: Actor): Promise<{ id: string; name: string }[]> {
  assertCan(actor, "security.session.read");
  return db.select({ id: employees.id, name: employees.name }).from(employees).orderBy(asc(employees.status), asc(employees.name)).limit(500);
}

/** Counts for the module's front page: active staff, how many have two-step, live sessions now. */
export async function staffCounts(db: Db, actor: Actor, now: number): Promise<{ active: number; withTwoStep: number; liveSessions: number } | null> {
  if (!can(actor, "security.session.read")) return null;
  const [totals, live] = await Promise.all([
    db.all<{ active: number; withTwoStep: number }>(sql`SELECT count(*) AS active, coalesce(sum(CASE WHEN totp_enabled = 1 THEN 1 ELSE 0 END), 0) AS withTwoStep FROM employees WHERE status = 'active'`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM employee_sessions WHERE revoked_at IS NULL AND expires_at > ${now} AND last_seen_at > ${now - IDLE_MS}`),
  ]);
  return { active: Number(totals[0]?.active ?? 0), withTwoStep: Number(totals[0]?.withTwoStep ?? 0), liveSessions: Number(live[0]?.n ?? 0) };
}

