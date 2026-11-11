/**
 * Installs the built-in roles (owner, manager, finance, inventory, fulfillment, support, cashier,
 * content) with their default permissions from ~/server/permissions.
 *
 *   await seedRoles(db, now);                    // insert what is missing
 *   await seedRoles(db, now, { reset: true });   // also put the built-in roles back to their defaults
 *
 * Idempotent, and careful about what it leaves alone: a role that already exists keeps the
 * permissions it has (the owner may have edited them — re-granting a permission that was taken
 * away would be a security regression). Only the owner role is always topped up with its wildcard,
 * so the owner can never end up locked out of new features.
 *
 * Worker-safe and script-safe: no Node APIs, no "cloudflare:workers".
 */
import { inArray } from "drizzle-orm";
import type { BatchStatement, Db } from "../db/drizzle.server";
import { rolePermissions, roles } from "../db/schema";
import { chunkRows, runBatch } from "../db/tx.server";
import { DEFAULT_ROLES, DEFAULT_ROLE_KEYS, WILDCARD_PERMISSION, roleId, type DefaultRoleKey } from "../permissions";

export type SeedRolesResult = {
  /** Roles created by this call. */
  created: DefaultRoleKey[];
  /** Roles that were already there (left as they are unless `reset`). */
  existing: DefaultRoleKey[];
};

export type SeedRolesOptions = {
  /** Restore the built-in roles' permissions to the defaults, dropping any edits. */
  reset?: boolean;
};

/** Ids of the built-in roles that already exist, by key. */
export async function existingDefaultRoles(db: Db): Promise<Map<DefaultRoleKey, string>> {
  const rows = await db.select({ id: roles.id, key: roles.key }).from(roles).where(inArray(roles.key, [...DEFAULT_ROLE_KEYS]));
  return new Map(rows.map((row) => [row.key as DefaultRoleKey, row.id]));
}

/**
 * The statements seedRoles() runs, for callers that need them inside their own batch (the
 * first-owner setup). `existing` is the result of existingDefaultRoles().
 */
export function seedRolesStatements(db: Db, now: number, existing: ReadonlyMap<DefaultRoleKey, string>, options: SeedRolesOptions = {}): BatchStatement[] {
  const statements: BatchStatement[] = [];
  for (const role of DEFAULT_ROLES) {
    const existingId = existing.get(role.key);
    const id = existingId ?? roleId(role.key);
    if (!existingId) {
      statements.push(db.insert(roles).values({ id, key: role.key, name: role.name, description: role.description, isSystem: true, createdAt: now }).onConflictDoNothing());
    }
    const install = !existingId || options.reset === true;
    if (existingId && options.reset === true) {
      statements.push(db.delete(rolePermissions).where(inArray(rolePermissions.roleId, [id])));
    }
    const permissions = install ? role.permissions : role.key === "owner" ? [WILDCARD_PERMISSION] : [];
    const rows = permissions.map((permission) => ({ roleId: id, permission }));
    for (const chunk of chunkRows(rolePermissions, rows)) {
      statements.push(db.insert(rolePermissions).values(chunk).onConflictDoNothing());
    }
  }
  return statements;
}

export async function seedRoles(db: Db, now: number, options: SeedRolesOptions = {}): Promise<SeedRolesResult> {
  const existing = await existingDefaultRoles(db);
  // One batch = one transaction: all built-in roles are there afterwards, or nothing changed.
  await runBatch(db, seedRolesStatements(db, now, existing, options));
  return {
    created: DEFAULT_ROLE_KEYS.filter((key) => !existing.has(key)),
    existing: DEFAULT_ROLE_KEYS.filter((key) => existing.has(key)),
  };
}
