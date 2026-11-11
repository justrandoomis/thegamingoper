/**
 * Admin 20.02 — roles and what they grant (module permissions, the field-level ones that decide whether cost, profit,
 * full phone numbers, proof images or digital codes leave the server at all, and branch limits), and who holds them.
 *
 * Rules (each checked here AND, where another request could change the facts in between, inside the write's batch):
 *   · `staff.manage` for every change (the owner only, by default); reading needs staff.manage,
 *     security.access_review.perform or security.session.read.
 *   · Only the owner role holds the wildcard "*": it cannot be edited, and "*" is never granted to another role.
 *   · No one changes a role they hold, or their own roles (no self-escalation, no locking oneself out).
 *   · No one grants what they do not hold themselves: permissions added to a role, and roles given to an employee,
 *     must be within the actor's own permissions (the owner's wildcard covers everything). Taking away needs the same
 *     (review 2026-11-11): permissions removed from a role, and roles taken from an employee — so only an owner takes
 *     the owner role from an owner — and a branch limit is never put on someone who holds more than the actor.
 *   · The last active owner keeps the owner role.
 *   · Every change carries a reason and the version the editor saw (role_changed / roles_changed when it moved on),
 *     and is one batch with its audit event (before, after, added, removed, the members it reaches). Permissions are
 *     read on every request, so a change takes effect on the next click of everyone who holds the role.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, permissionsOf, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { branches, employeeRoles, employees, rolePermissions, roles } from "~/server/db/schema";
import { chunkRows, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { DEFAULT_ROLE_KEYS, FIELD_PERMISSIONS, PERMISSIONS, WILDCARD_PERMISSION, expandPermissions, isPermission, permissionGroups, type Permission } from "~/server/permissions";
import { actorIdOf, assertAny, holdsAll, storedPermissionsOf } from "./shared.server";
import { ACCESS_REVIEW_INTERVAL_DAYS, DAY_MS, type AccessReviewView, type PermissionGroupView, type RoleRef } from "./types";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const Reason = z.string({ error: "required" }).trim().min(3, "reason_required").max(500, "too_long");
const READ: Permission[] = ["staff.manage", "security.access_review.perform", "security.session.read"];

/** The sorted stored permissions of a role, joined: what an editor saw (`*` for the owner). */
export const fingerprintOf = (stored: readonly string[]) => [...stored].sort().join(",");

/** The sorted ids of a role's members, joined: who a reviewer saw holding it. */
export const membersFingerprintOf = (memberIds: readonly string[]) => [...memberIds].sort().join(",");

const fingerprintSql = (roleId: string) => sql`coalesce((SELECT group_concat(permission, ',') FROM (SELECT permission FROM role_permissions WHERE role_id = ${roleId} ORDER BY permission)), '')`;

const isField = (permission: string) => (FIELD_PERMISSIONS as readonly string[]).includes(permission);

export type RoleRow = RoleRef & {
  description: string | null;
  isSystem: boolean;
  isOwner: boolean;
  members: number;
  activeMembers: number;
  withoutTwoStep: number;
  /** null for the owner's wildcard ("everything"). */
  permissionCount: number | null;
  field: Permission[];
  lastReview: AccessReviewView | null;
  reviewDue: boolean;
};

/** Latest access review per role (audit events "security.access_review.complete"). */
export async function lastReviews(db: Db, roleIds: readonly string[]): Promise<Map<string, AccessReviewView>> {
  const out = new Map<string, AccessReviewView>();
  if (roleIds.length === 0) return out;
  const rows = await db.all<{ entityId: string; at: number; actorLabel: string | null; after: string | null; reason: string | null }>(sql`
    SELECT entity_id AS entityId, at, actor_label AS actorLabel, after, reason FROM audit_events
    WHERE action = 'security.access_review.complete' AND entity_type = 'role' AND entity_id IN (SELECT value FROM json_each(${JSON.stringify(roleIds)}))
    ORDER BY seq DESC`);
  for (const row of rows) {
    if (out.has(row.entityId)) continue;
    const after = (row.after ? JSON.parse(row.after) : {}) as { outcome?: string; permissions?: number; members?: number };
    out.set(row.entityId, { at: Number(row.at), by: row.actorLabel, outcome: after.outcome === "changes_needed" ? "changes_needed" : "confirmed", note: row.reason, permissions: Number(after.permissions ?? 0), members: Number(after.members ?? 0) });
  }
  return out;
}

export async function listRoles(db: Db, actor: Actor, locale: Locale, now: number): Promise<RoleRow[]> {
  assertAny(actor, READ);
  const [rows, grants, members] = await Promise.all([
    db.select().from(roles).orderBy(asc(roles.isSystem), asc(roles.key)),
    db.select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission }).from(rolePermissions),
    db.all<{ roleId: string; members: number; active: number; noTwoStep: number }>(sql`
      SELECT er.role_id AS roleId, count(*) AS members, sum(CASE WHEN e.status = 'active' THEN 1 ELSE 0 END) AS active,
             sum(CASE WHEN e.status = 'active' AND e.totp_enabled = 0 THEN 1 ELSE 0 END) AS noTwoStep
      FROM employee_roles er JOIN employees e ON e.id = er.employee_id GROUP BY er.role_id`),
  ]);
  const reviews = await lastReviews(
    db,
    rows.map((row) => row.id),
  );
  const order = new Map<string, number>(DEFAULT_ROLE_KEYS.map((key, index) => [key, index]));
  return rows
    .map((row) => {
      const stored = grants.filter((grant) => grant.roleId === row.id).map((grant) => grant.permission);
      const wildcard = stored.includes(WILDCARD_PERMISSION);
      const concrete = expandPermissions(stored);
      const count = members.find((entry) => entry.roleId === row.id);
      const review = reviews.get(row.id) ?? null;
      return {
        id: row.id,
        key: row.key,
        name: pick(row.name, locale),
        description: row.description ? pick(row.description, locale) : null,
        isSystem: row.isSystem,
        isOwner: row.key === "owner",
        members: Number(count?.members ?? 0),
        activeMembers: Number(count?.active ?? 0),
        withoutTwoStep: Number(count?.noTwoStep ?? 0),
        permissionCount: wildcard ? null : concrete.size,
        field: FIELD_PERMISSIONS.filter((permission) => concrete.has(permission)),
        lastReview: review,
        reviewDue: !review || now - review.at > ACCESS_REVIEW_INTERVAL_DAYS * DAY_MS,
      };
    })
    .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99) || a.key.localeCompare(b.key));
}

export type RoleDetail = {
  role: RoleRef & { nameL10n: L10n; description: string | null; isSystem: boolean; isOwner: boolean };
  /** Stored permissions (the owner: ["*"]). */
  stored: string[];
  fingerprint: string;
  /** The members' sorted ids, joined — what an access review was made against (membersFingerprintOf). */
  membersFingerprint: string;
  groups: PermissionGroupView[];
  members: { id: string; name: string; email: string; status: "active" | "disabled"; twoStep: boolean; lastLoginAt: number | null }[];
  can: { edit: boolean; review: boolean };
  /** Why the actor cannot edit it (when they could otherwise). */
  locked: "owner" | "own_role" | null;
  /** Permissions this actor may grant or take away (their own); others are shown, never changed. */
  grantable: Permission[];
  reviews: AccessReviewView[];
};

export async function getRole(db: Db, actor: Actor, roleId: string, locale: Locale): Promise<RoleDetail> {
  assertAny(actor, READ);
  if (!ID.test(roleId)) throw notFound("role");
  const row = await db.select().from(roles).where(eq(roles.id, roleId)).get();
  if (!row) throw notFound("role");
  const [grants, memberRows, reviewRows] = await Promise.all([
    db.select({ permission: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, row.id)),
    db
      .select({ id: employees.id, name: employees.name, email: employees.email, status: employees.status, twoStep: employees.totpEnabled, lastLoginAt: employees.lastLoginAt })
      .from(employeeRoles)
      .innerJoin(employees, eq(employees.id, employeeRoles.employeeId))
      .where(eq(employeeRoles.roleId, row.id))
      .orderBy(asc(employees.status), asc(employees.name)),
    db.all<{ at: number; actorLabel: string | null; after: string | null; reason: string | null }>(sql`
      SELECT at, actor_label AS actorLabel, after, reason FROM audit_events WHERE action = 'security.access_review.complete' AND entity_type = 'role' AND entity_id = ${row.id} ORDER BY seq DESC LIMIT 10`),
  ]);
  const stored = grants.map((grant) => grant.permission);
  const isOwner = row.key === "owner";
  const mine = actorIdOf(actor);
  const holds = mine !== null && memberRows.some((member) => member.id === mine);
  const locked = isOwner ? "owner" : holds ? "own_role" : null;
  const mineAll = new Set<string>(permissionsOf(actor));
  return {
    role: { id: row.id, key: row.key, name: pick(row.name, locale), nameL10n: row.name, description: row.description ? pick(row.description, locale) : null, isSystem: row.isSystem, isOwner },
    stored,
    fingerprint: fingerprintOf(stored),
    membersFingerprint: membersFingerprintOf(memberRows.map((member) => member.id)),
    groups: permissionGroups().map((group) => ({
      key: group.key,
      module: group.module,
      label: pick(group.label, locale),
      permissions: group.permissions.map((permission) => ({ key: permission.key, label: pick(permission.label, locale), field: isField(permission.key) })),
    })),
    members: memberRows,
    can: { edit: can(actor, "staff.manage") && locked === null, review: can(actor, "security.access_review.perform") },
    locked: can(actor, "staff.manage") ? locked : null,
    grantable: PERMISSIONS.filter((permission) => mineAll.has(permission)),
    reviews: reviewRows.map((review) => {
      const after = (review.after ? JSON.parse(review.after) : {}) as { outcome?: string; permissions?: number; members?: number };
      return { at: Number(review.at), by: review.actorLabel, outcome: after.outcome === "changes_needed" ? "changes_needed" : "confirmed", note: review.reason, permissions: Number(after.permissions ?? 0), members: Number(after.members ?? 0) };
    }),
  };
}

const SaveInput = z.object({
  roleId: z.string().regex(ID, "invalid"),
  permissions: z.array(z.string().max(80)).max(400),
  fingerprint: z.string().max(20_000),
  reason: Reason,
});

/** Replaces a role's permissions. Returns what was added and removed. */
export async function saveRolePermissions(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ added: Permission[]; removed: Permission[]; members: number }> {
  assertCan(actor, "staff.manage");
  const input = SaveInput.parse(raw);
  const row = await db.select().from(roles).where(eq(roles.id, input.roleId)).get();
  if (!row) throw notFound("role");
  if (row.key === "owner") throw new AppError("role_locked", 409);
  if (input.permissions.includes(WILDCARD_PERMISSION)) throw new AppError("wildcard_owner_only", 403);
  const unknown = input.permissions.filter((permission) => !isPermission(permission));
  if (unknown.length > 0) throw invalid({ permissions: "invalid" }, unknown.join(","));
  const memberRows = await db.select({ employeeId: employeeRoles.employeeId }).from(employeeRoles).where(eq(employeeRoles.roleId, row.id));
  const mine = actorIdOf(actor);
  if (mine && memberRows.some((member) => member.employeeId === mine)) throw new AppError("own_role", 403);

  const current = (await db.select({ permission: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, row.id))).map((grant) => grant.permission);
  if (fingerprintOf(current) !== input.fingerprint) throw new AppError("role_changed", 409);
  const next = [...new Set(input.permissions)] as Permission[];
  const added = next.filter((permission) => !current.includes(permission));
  const removed = current.filter((permission) => !next.includes(permission as Permission)) as Permission[];
  if (added.length === 0 && removed.length === 0) throw invalid({ permissions: "no_change" });
  if (!holdsAll(actor, added)) throw new AppError("grant_exceeds_own", 403, { detail: added.filter((permission) => !holdsAll(actor, [permission])).join(",") });
  // taking away needs what giving needs: nobody strips a role of permissions they could never have granted
  if (!holdsAll(actor, removed)) throw new AppError("revoke_exceeds_own", 403, { detail: removed.filter((permission) => !holdsAll(actor, [permission])).join(",") });

  const statements: BatchStatement[] = [
    expectThat(db, sql`${fingerprintSql(row.id)} = ${input.fingerprint}`, { code: "ROLE_CHANGED", detail: row.id }),
    ...(removed.length ? [db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, row.id), inArray(rolePermissions.permission, removed)))] : []),
    ...chunkRows(
      rolePermissions,
      added.map((permission) => ({ roleId: row.id, permission })),
    ).map((chunk) => db.insert(rolePermissions).values(chunk)),
    auditStatement(db, {
      actor,
      action: "security.role.update",
      entityType: "role",
      entityId: row.id,
      summary: row.key,
      before: { permissions: [...current].sort() },
      after: { permissions: [...next].sort(), added, removed, fieldAdded: added.filter(isField), fieldRemoved: removed.filter(isField), members: memberRows.length },
      reason: input.reason,
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (mapDbError(error)?.code === "ROLE_CHANGED") throw new AppError("role_changed", 409);
    throw error;
  }
  return { added, removed, members: memberRows.length };
}

const CreateInput = z.object({
  key: z
    .string({ error: "required" })
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{2,31}$/, "role_key_invalid"),
  nameAr: z.string({ error: "required" }).trim().min(2, "required").max(60, "too_long"),
  nameEn: z.string().trim().max(60, "too_long").optional(),
  descriptionAr: z.string().trim().max(200, "too_long").optional(),
  /** Start from another role's permissions (only those the actor holds). */
  copyFrom: z.string().regex(ID, "invalid").optional(),
  reason: Reason,
});

/** A new custom role, empty or a copy of another role's permissions (within the actor's own). */
export async function createRole(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ roleId: string; copied: number; skipped: number }> {
  assertCan(actor, "staff.manage");
  const input = CreateInput.parse(raw);
  if ((DEFAULT_ROLE_KEYS as readonly string[]).includes(input.key)) throw new AppError("role_key_taken", 409, { fields: { key: "role_key_taken" } });
  let copy: string[] = [];
  if (input.copyFrom) {
    const source = await db.select({ key: roles.key }).from(roles).where(eq(roles.id, input.copyFrom)).get();
    if (!source) throw invalid({ copyFrom: "invalid" });
    const stored = (await db.select({ permission: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, input.copyFrom))).map((grant) => grant.permission);
    // the wildcard is the owner's alone: a copy of the owner role is its concrete catalogue
    copy = [...expandPermissions(stored)];
  }
  const kept = copy.filter((permission) => holdsAll(actor, [permission]));
  const roleId = `role_${input.key}`;
  const name: L10n = { ar: input.nameAr, ...(input.nameEn ? { en: input.nameEn } : {}) };
  try {
    await runBatch(db, [
      db.insert(roles).values({ id: roleId, key: input.key, name, description: input.descriptionAr ? { ar: input.descriptionAr } : null, isSystem: false, createdAt: now }),
      ...chunkRows(
        rolePermissions,
        kept.map((permission) => ({ roleId, permission })),
      ).map((chunk) => db.insert(rolePermissions).values(chunk)),
      auditStatement(db, { actor, action: "security.role.create", entityType: "role", entityId: roleId, summary: input.key, after: { key: input.key, name, permissions: kept.sort(), copiedFrom: input.copyFrom ?? null }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (mapDbError(error)?.kind === "unique") throw new AppError("role_key_taken", 409, { fields: { key: "role_key_taken" } });
    throw error;
  }
  return { roleId, copied: kept.length, skipped: copy.length - kept.length };
}

const AssignInput = z.object({
  employeeId: z.string().regex(ID, "invalid"),
  roleIds: z.array(z.string().regex(ID, "invalid")).max(20),
  /** The sorted role ids the form was built on. */
  expected: z.string().max(2000),
  reason: Reason,
});

/** Sets an employee's roles (with what that adds and removes). */
export async function setEmployeeRoles(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ added: string[]; removed: string[]; gained: Permission[]; lost: Permission[] }> {
  assertCan(actor, "staff.manage");
  const input = AssignInput.parse(raw);
  if (actorIdOf(actor) === input.employeeId) throw new AppError("own_roles", 403);
  const employee = await db.select({ id: employees.id, status: employees.status }).from(employees).where(eq(employees.id, input.employeeId)).get();
  if (!employee) throw notFound("employee");
  const wanted = [...new Set(input.roleIds)];
  const roleRows = wanted.length ? await db.select({ id: roles.id, key: roles.key }).from(roles).where(inArray(roles.id, wanted)) : [];
  if (roleRows.length !== wanted.length) throw invalid({ roleIds: "invalid" });
  const current = (await db.select({ roleId: employeeRoles.roleId }).from(employeeRoles).where(eq(employeeRoles.employeeId, employee.id))).map((row) => row.roleId);
  if ([...current].sort().join(",") !== input.expected) throw new AppError("roles_changed", 409);
  const added = wanted.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !wanted.includes(id));
  if (added.length === 0 && removed.length === 0) throw invalid({ roleIds: "no_change" });

  const involved = [...new Set([...current, ...wanted])];
  const grants = involved.length ? await db.select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission }).from(rolePermissions).where(inArray(rolePermissions.roleId, involved)) : [];
  const storedOf = (ids: readonly string[]) => grants.filter((grant) => ids.includes(grant.roleId)).map((grant) => grant.permission);
  // giving a role = granting all of its permissions: never more than the actor holds (the owner role: the wildcard only)
  if (!holdsAll(actor, storedOf(added))) throw new AppError("grant_exceeds_own", 403);
  // and taking one away needs the same: only an owner takes the owner role from an owner (review 2026-11-11)
  if (!holdsAll(actor, storedOf(removed))) throw new AppError("revoke_exceeds_own", 403);
  const before = expandPermissions(storedOf(current));
  const after = expandPermissions(storedOf(wanted));
  const gained = [...after].filter((permission) => !before.has(permission));
  const lost = [...before].filter((permission) => !after.has(permission));
  const ownerRole = roleRows.find((role) => role.key === "owner")?.id ?? (await db.select({ id: roles.id }).from(roles).where(eq(roles.key, "owner")).get())?.id ?? null;
  const losesOwner = ownerRole !== null && removed.includes(ownerRole);

  const id = employee.id;
  try {
    await runBatch(db, [
      expectThat(db, sql`coalesce((SELECT group_concat(role_id, ',') FROM (SELECT role_id FROM employee_roles WHERE employee_id = ${id} ORDER BY role_id)), '') = ${input.expected}`, { code: "ROLES_CHANGED", detail: id }),
      ...(removed.length ? [db.delete(employeeRoles).where(and(eq(employeeRoles.employeeId, id), inArray(employeeRoles.roleId, removed)))] : []),
      ...added.map((roleId) => db.insert(employeeRoles).values({ employeeId: id, roleId, grantedBy: actorIdOf(actor), grantedAt: now })),
      // the store always keeps an active owner
      ...(losesOwner
        ? [expectThat(db, sql`EXISTS (SELECT 1 FROM employees e JOIN employee_roles er ON er.employee_id = e.id JOIN roles r ON r.id = er.role_id WHERE r.key = 'owner' AND e.status = 'active')`, { code: "LAST_OWNER", detail: id })]
        : []),
      auditStatement(db, {
        actor,
        action: "security.employee.roles",
        entityType: "employee",
        entityId: id,
        before: { roles: [...current].sort() },
        after: { roles: [...wanted].sort(), added, removed, gained: gained.length, lost: lost.length, fieldGained: gained.filter(isField), fieldLost: lost.filter(isField) },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    const code = mapDbError(error)?.code;
    if (code === "ROLES_CHANGED") throw new AppError("roles_changed", 409);
    if (code === "LAST_OWNER") throw new AppError("last_owner", 409);
    throw error;
  }
  return { added, removed, gained, lost };
}

const BranchInput = z.object({ employeeId: z.string().regex(ID, "invalid"), branchId: z.string().regex(ID, "invalid").nullable(), reason: Reason });

/** Limits an employee to one branch (or lifts the limit). Services check the branch with canAccessBranch. */
export async function setEmployeeBranch(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "staff.manage");
  const input = BranchInput.parse(raw);
  if (actorIdOf(actor) === input.employeeId) throw new AppError("own_roles", 403);
  const employee = await db.select({ id: employees.id, branchId: employees.branchId }).from(employees).where(eq(employees.id, input.employeeId)).get();
  if (!employee) throw notFound("employee");
  // a branch limit narrows what someone may reach: never set on someone who holds more than the person setting it
  if (!holdsAll(actor, await storedPermissionsOf(db, employee.id))) throw new AppError("target_more_privileged", 403);
  if (input.branchId) {
    const branch = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.id, input.branchId), eq(branches.isActive, true))).get();
    if (!branch) throw new AppError("branch_unknown", 409, { fields: { branchId: "branch_unknown" } });
  }
  if ((employee.branchId ?? null) === input.branchId) return { changed: false };
  await runBatch(db, [
    db.update(employees).set({ branchId: input.branchId, updatedAt: now }).where(eq(employees.id, employee.id)),
    auditStatement(db, { actor, action: "security.employee.branch", entityType: "employee", entityId: employee.id, before: { branchId: employee.branchId ?? null }, after: { branchId: input.branchId }, reason: input.reason, at: now }),
  ]);
  return { changed: true };
}
