/**
 * Admin 06 point of sale — what each page may show and do for an employee, and small shared reads.
 * Authorization lives in the services (assertCan); these flags only decide what a page offers.
 */
import { inArray } from "drizzle-orm";
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { employees } from "~/server/db/schema";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";

/** Any of these opens the module's pages (the shell's gate already requires one pos.* permission). */
export const POS_READERS: readonly Permission[] = [
  "pos.sale.create",
  "pos.sale.refund",
  "pos.discount.apply",
  "pos.shift.open",
  "pos.shift.close",
  "pos.shift.review",
  "pos.cash.move",
  "pos.receipt.reprint",
  "pos.register.manage",
];

export type PosAccess = {
  sell: boolean;
  discount: boolean;
  /** pricing.discount.override: beyond the cashier's limit and under the margin floor; accept an offline price. */
  override: boolean;
  /** inventory.oversell.authorize: record goods that left although the system had promised them elsewhere. */
  oversell: boolean;
  open: boolean;
  close: boolean;
  review: boolean;
  cash: boolean;
  reprint: boolean;
  registers: boolean;
  /** customers.customer.read: find the buyer's account by phone. */
  customers: boolean;
  /** inventory.serial.read: serial numbers on receipts and in lookups. */
  serials: boolean;
  /** customers.wallet.read: the buyer's wallet balance at the till (otherwise the customer says how much). */
  wallet: boolean;
  /** orders.order.read: the link from a receipt to its order in module 05. */
  orders: boolean;
  /** cost.read — never used by this module's views; kept so tests can prove nothing depends on it. */
  cost: boolean;
};

export function posAccess(actor: Actor): PosAccess {
  return {
    sell: can(actor, "pos.sale.create"),
    discount: can(actor, "pos.discount.apply"),
    override: can(actor, "pricing.discount.override"),
    oversell: can(actor, "inventory.oversell.authorize"),
    open: can(actor, "pos.shift.open"),
    close: can(actor, "pos.shift.close"),
    review: can(actor, "pos.shift.review"),
    cash: can(actor, "pos.cash.move"),
    reprint: can(actor, "pos.receipt.reprint"),
    registers: can(actor, "pos.register.manage"),
    customers: can(actor, "customers.customer.read"),
    serials: can(actor, "inventory.serial.read"),
    wallet: can(actor, "customers.wallet.read"),
    orders: can(actor, "orders.order.read"),
    cost: can(actor, "cost.read"),
  };
}

/** Throws forbidden unless the actor holds one of the permissions. */
export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions[0]);
}

export function actorIdOf(actor: Actor): string | null {
  return actor.kind === "employee" ? actor.id : actor.kind === "system" ? `system:${actor.job}` : null;
}

/** Employee id → display name (the trail keeps ids; names are read at display time). */
export async function employeeNames(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export const person = (names: Map<string, string>, id: string | null | undefined) => (id ? { id, name: names.get(id) ?? id } : null);

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const KEY_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
