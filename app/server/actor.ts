/**
 * Who is acting — passed to every service, checked with `can` / `assertCan`, recorded by the audit trail.
 *
 *   const { actor } = await requireEmployee(ctx, db, "inventory.stock.adjust");   // routes: ~/server/auth/admin.server
 *   await adjustStock(db, actor, input, ctx.now);
 *
 *   export async function adjustStock(db: Db, actor: Actor, raw: unknown, now: number) {
 *     assertCan(actor, "inventory.stock.adjust");            // throws AppError("forbidden", 403)
 *     const withCost = can(actor, "cost.read");               // field-level: select [P] columns only when true
 *     …
 *   }
 *
 * Rules
 *   · Only employees hold permissions. Guests and customers never pass `can()`: what a customer may
 *     do is decided by ownership (`order.customerId === actor.id`) inside the service.
 *   · `{ kind: "system", job }` is the server itself (cron jobs, the first-run setup, seeds). It passes
 *     every check — never build one from request input.
 *   · Actors may carry where the request came from (`ip`, `requestId`) and a display `label`; the audit
 *     trail stores them, so services do not have to thread the request context through.
 */
import { forbidden } from "./errors";
import { PERMISSIONS, WILDCARD_PERMISSION, isPermission, type Permission } from "./permissions";

/** Where a request came from. Filled in by the auth helpers; optional everywhere else. */
export type RequestOrigin = { ip?: string | null; requestId?: string | null };

export type GuestActor = { kind: "guest" } & RequestOrigin;
export type CustomerActor = { kind: "customer"; id: string; label?: string | null } & RequestOrigin;
export type EmployeeActor = {
  kind: "employee";
  id: string;
  /** Permission strings from the employee's roles ("*" = everything). A Set or a plain array. */
  permissions: ReadonlySet<string> | readonly string[];
  /** Branch the employee is limited to; null / undefined = all branches. */
  branchId?: string | null;
  label?: string | null;
} & RequestOrigin;
export type SystemActor = { kind: "system"; job: string };

export type Actor = GuestActor | CustomerActor | EmployeeActor | SystemActor;

export const GUEST: GuestActor = Object.freeze({ kind: "guest" });

/** The server acting on its own: `systemActor("reservations.expire")`. */
export function systemActor(job: string): SystemActor {
  return { kind: "system", job };
}

function holds(permissions: EmployeeActor["permissions"], permission: string): boolean {
  return typeof (permissions as ReadonlySet<string>).has === "function" ? (permissions as ReadonlySet<string>).has(permission) : (permissions as readonly string[]).includes(permission);
}

/** True when the actor holds the permission. */
export function can(actor: Actor, permission: Permission): boolean {
  if (actor.kind === "system") return true;
  if (actor.kind !== "employee") return false;
  return holds(actor.permissions, permission) || holds(actor.permissions, WILDCARD_PERMISSION);
}

export function canAny(actor: Actor, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => can(actor, permission));
}

export function canAll(actor: Actor, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => can(actor, permission));
}

/** Throws AppError("forbidden", 403) unless the actor holds the permission. */
export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw forbidden(permission);
}

/** True when the actor may work with records of that branch (employees can be limited to one). */
export function canAccessBranch(actor: Actor, branchId: string | null | undefined): boolean {
  if (actor.kind === "system") return true;
  if (actor.kind !== "employee") return false;
  return actor.branchId == null || actor.branchId === branchId;
}

export function assertBranch(actor: Actor, branchId: string | null | undefined): void {
  if (!canAccessBranch(actor, branchId)) throw forbidden("branch");
}

/** The concrete permissions an actor holds, in catalogue order (for navigation and role screens). */
export function permissionsOf(actor: Actor): Permission[] {
  if (actor.kind === "system") return [...PERMISSIONS];
  if (actor.kind !== "employee") return [];
  if (holds(actor.permissions, WILDCARD_PERMISSION)) return [...PERMISSIONS];
  const held = new Set<string>(actor.permissions);
  return PERMISSIONS.filter((permission) => held.has(permission) && isPermission(permission));
}

/** The `actor_kind` / `actor_id` pair stored by audit events, stock movements, ledgers and order events. */
export function actorRef(actor: Actor): { actorKind: Actor["kind"]; actorId: string | null } {
  switch (actor.kind) {
    case "guest":
      return { actorKind: "guest", actorId: null };
    case "system":
      return { actorKind: "system", actorId: actor.job };
    default:
      return { actorKind: actor.kind, actorId: actor.id };
  }
}
