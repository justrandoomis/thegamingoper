/**
 * Small server helpers shared by the admin orders services: who is who (employee names by id), how a phone may be
 * shown to this employee, governorate names, and the order lookups every action starts with.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import { formatIraqPhone, maskPhone } from "~/lib/phone";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { employeeRoles, employees, governorates, orders, rolePermissions, type Order } from "~/server/db/schema";
import { notFound } from "~/server/errors";
import { normalizeOrderRef } from "~/server/services/orders/manage.server";
import type { EmployeeRef, PhoneView } from "./types";

/** "0771 234 5678" with customer.phone.read_full, "0771 ••• ••78" without. The full number never leaves otherwise. */
export function phoneFor(actor: Actor, e164: string | null | undefined): PhoneView | null {
  if (!e164) return null;
  return can(actor, "customer.phone.read_full") ? { display: formatIraqPhone(e164), full: true, e164 } : { display: maskPhone(e164), full: false };
}

/** Names of employees (and "system:<job>" / "customer:<id>" markers) for history lines. */
export async function employeeNames(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0 && !id.includes(":")))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  for (let i = 0; i < wanted.length; i += 90) {
    const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, wanted.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, row.name);
  }
  return out;
}

export async function governorateNames(db: Db, locale: Locale): Promise<{ id: string; name: string }[]> {
  const rows = await db.select({ id: governorates.id, name: governorates.name, sort: governorates.sort }).from(governorates).orderBy(governorates.sort);
  return rows.map((row) => ({ id: row.id, name: pick(row.name, locale) }));
}

/** The order by its public reference, or 404. */
export async function orderByRef(db: Db, ref: string): Promise<Order> {
  const normalized = normalizeOrderRef(ref);
  const order = normalized ? await db.select().from(orders).where(eq(orders.ref, normalized)).get() : undefined;
  if (!order) throw notFound("order");
  return order;
}

export async function orderById(db: Db, orderId: string): Promise<Order> {
  const order = typeof orderId === "string" && orderId ? await db.select().from(orders).where(eq(orders.id, orderId)).get() : undefined;
  if (!order) throw notFound("order");
  return order;
}

/**
 * Active employees who may pack orders (their roles grant orders.fulfillment.pack, or everything): who an order can be
 * assigned to (05.03).
 */
export async function packers(db: Db): Promise<EmployeeRef[]> {
  const rows = await db
    .selectDistinct({ id: employees.id, name: employees.name })
    .from(employees)
    .innerJoin(employeeRoles, eq(employeeRoles.employeeId, employees.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, employeeRoles.roleId))
    .where(and(eq(employees.status, "active"), isNull(employees.disabledAt), sql`${rolePermissions.permission} IN ('orders.fulfillment.pack', '*')`))
    .orderBy(employees.name);
  return rows;
}

/** A short, safe excerpt of an event's data for the history (strings, numbers, booleans; never cost). */
const HIDDEN_KEYS = new Set(["cost", "costIqd", "cogsIqd", "unitCostIqd", "restockedCostIqd", "scrappedCostIqd", "accessToken"]);
export function safeData(value: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (HIDDEN_KEYS.has(key) || /cost/i.test(key)) continue;
    if (entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") out[key] = typeof entry === "string" ? entry.slice(0, 300) : entry;
    else if (Array.isArray(entry)) out[key] = entry.length;
  }
  return out;
}
