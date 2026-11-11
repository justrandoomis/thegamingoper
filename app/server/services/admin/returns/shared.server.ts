/**
 * Small server helpers shared by the services of admin module 12 (returns): lookups that every action starts with,
 * how a phone may be shown to this employee, who is who, the locations returned goods can go to, and what a returned
 * unit was worth to the customer (its share of what the order charged).
 */
import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertBranch, canAccessBranch, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, inventoryLocations, orderItems, refundItems, refunds, repairEvents, returnItems, returns, type Order, type ReturnRequest } from "~/server/db/schema";
import { invalid, notFound } from "~/server/errors";
import { employeeNames, phoneFor } from "../orders/shared.server";
import { allocateAmount } from "../pricing/rules";
import type { PhoneView } from "./types";

export { employeeNames };

/** "0771 234 5678" with customer.phone.read_full, "0771 ••• ••78" without. */
export function phoneView(actor: Actor, e164: string | null | undefined): PhoneView | null {
  return phoneFor(actor, e164);
}

/** "rma-7k4m2q9x " → "RMA-7K4M2Q9X"; null for anything that cannot be an RMA reference. */
export function normalizeRma(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const value = ref.trim().toUpperCase();
  return /^RMA-[A-Z0-9]{4,16}$/.test(value) ? value : null;
}

export async function returnByRma(db: Db, rma: string): Promise<ReturnRequest> {
  const ref = normalizeRma(rma);
  const row = ref ? await db.select().from(returns).where(eq(returns.rma, ref)).get() : undefined;
  if (!row) throw notFound("return");
  return row;
}

export async function returnById(db: Db, id: string): Promise<ReturnRequest> {
  const row = typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) ? await db.select().from(returns).where(eq(returns.id, id)).get() : undefined;
  if (!row) throw notFound("return");
  return row;
}

/** Who opened the RMA (the actor of its creation audit event): the second person rule needs it. */
export async function openerOf(db: Db, returnId: string): Promise<string | null> {
  const row = await db
    .select({ actorKind: auditEvents.actorKind, actorId: auditEvents.actorId })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "return"), eq(auditEvents.entityId, returnId), eq(auditEvents.action, "returns.rma.create")))
    .orderBy(asc(auditEvents.seq))
    .get();
  return row?.actorKind === "employee" ? row.actorId : null;
}

export type LocationOption = { id: string; code: string; name: string };

/**
 * Active locations this employee may put returned goods into: sellable ones (restock) and non-sellable ones
 * (quarantine). An employee limited to a branch gets that branch's locations only (assertLocationBranch decides).
 */
export async function returnLocations(db: Db, actor: Actor): Promise<{ sellable: LocationOption[]; quarantine: LocationOption[] }> {
  const rows = (
    await db
      .select({ id: inventoryLocations.id, code: inventoryLocations.code, name: inventoryLocations.name, isSellable: inventoryLocations.isSellable, branchId: inventoryLocations.branchId })
      .from(inventoryLocations)
      .where(eq(inventoryLocations.isActive, true))
      .orderBy(asc(inventoryLocations.code))
      .limit(300)
  ).filter((row) => canAccessBranch(actor, row.branchId));
  return {
    sellable: rows.filter((row) => row.isSellable).map(({ id, code, name }) => ({ id, code, name })),
    quarantine: rows.filter((row) => !row.isSellable).map(({ id, code, name }) => ({ id, code, name })),
  };
}

/** True for an employee limited to one branch (actor.branchId): they work with that branch's locations only. */
export const branchLimited = (actor: Actor): boolean => actor.kind === "employee" && actor.branchId != null;

/**
 * Goods of a return go into, or leave, a location only when the employee may work with its branch (403 otherwise);
 * an unknown location is a field error. The core checks the location's kind (sellable / quarantine) itself.
 */
export async function assertLocationBranch(db: Db, actor: Actor, locationId: string): Promise<void> {
  const row = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(locationId) ? await db.select({ branchId: inventoryLocations.branchId }).from(inventoryLocations).where(eq(inventoryLocations.id, locationId)).get() : undefined;
  if (!row) throw invalid({ locationId: "location_invalid" });
  assertBranch(actor, row.branchId);
}

/** The repair ticket a kept unit of a return gets (one per RMA line, so a retry finds the same ticket). */
export async function returnRepairId(itemId: string): Promise<string> {
  return `rep_${(await sha256Hex(`return:${itemId}`)).slice(0, 26)}`;
}

/**
 * RMA lines kept by their customer ("keep") whose repair under the RMA failed — the ticket was declared unrepairable
 * (final: it can only be handed back from there). Their money may go back through the RMA; any other kept unit's may not.
 */
export async function failedRepairs(db: Db, itemIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (itemIds.length === 0) return out;
  const byTicket = new Map<string, string>();
  for (const itemId of itemIds) byTicket.set(await returnRepairId(itemId), itemId);
  const rows = await db
    .select({ ticketId: repairEvents.ticketId })
    .from(repairEvents)
    .where(and(inArray(repairEvents.ticketId, [...byTicket.keys()]), eq(repairEvents.kind, "status"), sql`json_extract(${repairEvents.data}, '$.to') = 'unrepairable'`));
  for (const row of rows) {
    const itemId = byTicket.get(row.ticketId);
    if (itemId) out.add(itemId);
  }
  return out;
}

/** May the money of this inspected RMA line go back through the RMA? Units that came back, or kept ones whose repair failed. */
export const refundableLine = (line: { inspectedBy: string | null; restockAction: string | null; id: string }, failed: ReadonlySet<string>): boolean =>
  line.inspectedBy !== null && (line.restockAction !== null || failed.has(line.id));

/**
 * What one unit of each line cost the customer: the line total (its own discount applied) minus the line's share of
 * the order discount, divided by the units — rounded down, so a refund suggestion never exceeds what was charged.
 * Shipping is not part of it.
 */
export async function unitValues(db: Db, order: Pick<Order, "id" | "discountIqd">): Promise<Map<string, number>> {
  return unitValuesFor(db, [order]);
}

/** unitValues for several orders in one query: order item id → value of one unit. */
export async function unitValuesFor(db: Db, list: readonly Pick<Order, "id" | "discountIqd">[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (list.length === 0) return out;
  const lines = await db
    .select({ id: orderItems.id, orderId: orderItems.orderId, qty: orderItems.qty, totalIqd: orderItems.totalIqd })
    .from(orderItems)
    .where(inArray(orderItems.orderId, [...new Set(list.map((order) => order.id))]));
  for (const order of list) {
    const mine = lines.filter((line) => line.orderId === order.id);
    const weightSum = mine.reduce((sum, line) => sum + line.totalIqd, 0);
    const shares = order.discountIqd > 0 && weightSum > 0 ? allocateAmount(order.discountIqd, mine.map((line) => ({ id: line.id, weight: line.totalIqd }))) : new Map<string, number>();
    for (const line of mine) out.set(line.id, Math.floor(Math.max(0, line.totalIqd - (shares.get(line.id) ?? 0)) / Math.max(1, line.qty)));
  }
  return out;
}

/** Refund statuses that no longer count (the database's refund triggers agree). */
export const VOID_REFUND = ["rejected", "cancelled"] as const;
/** Return statuses whose items no longer hold units. */
export const VOID_RETURN = ["rejected", "cancelled"] as const;

/** A refund created by this module for a return: linked by return_id, or (before the link) by its idempotency key. */
export function returnRefundFilter(returnId: string) {
  const prefix = refundKeyPrefix(returnId);
  return or(eq(refunds.returnId, returnId), sql`substr(${refunds.idempotencyKey}, 1, ${prefix.length}) = ${prefix}`);
}

/** Every refund this module requests for a return carries the key "rma:<return id>:<form key>". */
export const refundKeyPrefix = (returnId: string) => `rma:${returnId}:`;

/**
 * Units per order line that are already spoken for: in returns that were not rejected or cancelled, and refunded
 * OUTSIDE any return (a refund of a return counts once, through its return's items).
 */
export async function unitsTaken(db: Db, orderItemIds: readonly string[], exceptReturnId?: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderItemIds.length === 0) return out;
  const [inReturns, refundedOutside] = await Promise.all([
    db
      .select({ orderItemId: returnItems.orderItemId, qty: sql<number>`sum(${returnItems.qty})` })
      .from(returnItems)
      .innerJoin(returns, eq(returns.id, returnItems.returnId))
      .where(and(inArray(returnItems.orderItemId, [...orderItemIds]), notInArray(returns.status, [...VOID_RETURN]), exceptReturnId ? sql`${returns.id} <> ${exceptReturnId}` : undefined))
      .groupBy(returnItems.orderItemId),
    db
      .select({ orderItemId: refundItems.orderItemId, qty: sql<number>`sum(${refundItems.qty})` })
      .from(refundItems)
      .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
      .where(
        and(
          inArray(refundItems.orderItemId, [...orderItemIds]),
          notInArray(refunds.status, [...VOID_REFUND]),
          sql`${refunds.returnId} IS NULL`,
          sql`(${refunds.idempotencyKey} IS NULL OR ${refunds.idempotencyKey} NOT LIKE 'rma:%')`,
        ),
      )
      .groupBy(refundItems.orderItemId),
  ]);
  for (const row of inReturns) out.set(row.orderItemId, (out.get(row.orderItemId) ?? 0) + Number(row.qty));
  for (const row of refundedOutside) out.set(row.orderItemId, (out.get(row.orderItemId) ?? 0) + Number(row.qty));
  return out;
}

/** The name of a line as the order recorded it, in the employee's language. */
export function lineName(snapshot: unknown, locale: Locale): string {
  return snapshot && typeof snapshot === "object" ? pick(snapshot as { ar: string }, locale) : "";
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
