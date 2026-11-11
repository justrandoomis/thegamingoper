/**
 * Who may do what in the pricing module (admin 03). Permissions come from ~/server/permissions; this file only
 * groups them. Services check them with assertCan / assertAny — hiding a key is never the control.
 *
 * Field permissions decide which numbers leave the server at all (ARCHITECTURE §5.1, CONTRACTS §4):
 *   cost.read     purchase cost, currency and rate, landed cost, FIFO layers, acquisition cost of used units
 *   profit.read   margins, the minimum and target margin, floors, profit in simulations
 * A margin together with a price reveals the cost, so give profit.read only to roles that may know cost.
 */
import { can, type Actor } from "~/server/actor";
import { forbidden } from "~/server/errors";
import { PERMISSION_DEFS, PERMISSIONS, type Permission } from "~/server/permissions";

/** Every permission of the pricing group (the module is visible with any of them). */
export const PRICING_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((permission) => PERMISSION_DEFS[permission].group === "pricing");

export function canAny(actor: Actor, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => can(actor, permission));
}

/** Throws AppError("forbidden", 403) naming the first permission unless the actor holds at least one of them. */
export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions[0]);
}

export const canUsePricing = (actor: Actor) => canAny(actor, PRICING_PERMISSIONS);
export const assertPricing = (actor: Actor) => assertAny(actor, PRICING_PERMISSIONS);

export type FieldAccess = { cost: boolean; profit: boolean };

export const fieldAccess = (actor: Actor): FieldAccess => ({ cost: can(actor, "cost.read"), profit: can(actor, "profit.read") });

/** The employee id stored in requested_by / approved_by / created_by columns (null for the system). */
export const actorId = (actor: Actor): string | null => (actor.kind === "employee" || actor.kind === "customer" ? actor.id : null);
