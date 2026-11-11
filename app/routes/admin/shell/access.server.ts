/**
 * Which admin modules an employee may see — derived from the permission catalogue (~/server/permissions), never
 * from a hand-kept list:
 *
 *   a module is visible when the actor holds at least one permission of that module's group
 *   (`orders.*` for /admin/orders, `audit.read` and `security.*` for /admin/security, …).
 *
 * The owner (wildcard) sees all 23. Field-level permissions (cost.read, profit.read, …) open no module by themselves.
 * Visibility is the coarse gate the shell enforces for every request (shell/gate.server.ts); every module's own
 * loaders and actions still call requireEmployee(ctx, db, "<permission>") and its services assertCan(…).
 */
import { can, permissionsOf, type Actor } from "~/server/actor";
import { PERMISSION_DEFS, PERMISSIONS, type Permission, type PermissionGroupKey } from "~/server/permissions";
import { ADMIN_MODULE_SLUGS, isAdminModuleSlug, type AdminModuleSlug } from "./modules";

/** The permissions of each module's group, in catalogue order. */
const MODULE_PERMISSIONS: ReadonlyMap<AdminModuleSlug, readonly Permission[]> = new Map(
  ADMIN_MODULE_SLUGS.map((slug) => [slug, PERMISSIONS.filter((permission) => PERMISSION_DEFS[permission].group === (slug as PermissionGroupKey))]),
);

export function modulePermissions(slug: AdminModuleSlug): readonly Permission[] {
  return MODULE_PERMISSIONS.get(slug) ?? [];
}

/** True when the actor holds any permission of the module's group. Unknown slugs are never visible. */
export function canSeeModule(actor: Actor, slug: string): boolean {
  if (!isAdminModuleSlug(slug)) return false;
  return modulePermissions(slug).some((permission) => can(actor, permission));
}

/** The modules the actor may see, in blueprint order. */
export function visibleModules(actor: Actor): AdminModuleSlug[] {
  const held = new Set<string>(permissionsOf(actor));
  return ADMIN_MODULE_SLUGS.filter((slug) => modulePermissions(slug).some((permission) => held.has(permission)));
}
