/**
 * After the sale, as the customer sees it (brief §3.10 "returns, warranties"): read-only views of the customer's own
 * records. Nothing here creates a return or a warranty claim — no storefront service for that exists yet, so the
 * pages send the customer to support with the order reference (an honest path, not a form that goes nowhere).
 *
 *   const warranties = await listWarranties(db, customerId, locale, ctx.now);     // started at delivery by the commerce core
 *   const requests = await listReturnRequests(db, customerId);                    // RMAs opened by staff (admin module 12)
 *   const { orders, windowDays } = await listReturnableOrders(db, customerId, locale, ctx.now);
 *
 * Warranties: `transitionOrder(…, "delivered")` writes one row per sold unit; `products.warranty_months` is still empty
 * until the store sets its own terms (docs/STATUS.md open item 15), so most customers have none yet. The state is
 * computed from the dates (a row past its end date reads "expired" even before a job updates it).
 * Return window: the store's general setting `returns.window_days` from delivery. Category rules (`return_policies`)
 * may differ — the page says so and links the returns policy instead of promising a date per item.
 * Must not import "cloudflare:workers".
 */
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { orderItems, orders, returns, warranties } from "~/server/db/schema";
import { getSetting } from "~/server/settings.server";
import type { ReturnableOrder, ReturnRequestView, WarrantyView } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The customer's warranties, the ones still running first. */
export async function listWarranties(db: Db, customerId: string, locale: Locale, now: number): Promise<WarrantyView[]> {
  const rows = await db
    .select({
      id: warranties.id,
      startsAt: warranties.startsAt,
      endsAt: warranties.endsAt,
      status: warranties.status,
      terms: warranties.terms,
      name: orderItems.nameSnapshot,
      orderRef: orders.ref,
      orderCustomer: orders.customerId,
    })
    .from(warranties)
    .innerJoin(orderItems, eq(orderItems.id, warranties.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(warranties.customerId, customerId))
    .orderBy(desc(warranties.endsAt), desc(warranties.id))
    .limit(100);
  const views: WarrantyView[] = rows.map((row) => ({
    id: row.id,
    // The reference only when the order is the customer's own (it always is for their warranties; belt and braces).
    orderRef: row.orderCustomer === customerId ? row.orderRef : null,
    itemName: pick(row.name, locale),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    state: row.status === "void" ? "void" : row.endsAt < now ? "expired" : "active",
    terms: row.terms ? pick(row.terms, locale) || null : null,
  }));
  const rank = { active: 0, expired: 1, void: 2 } as const;
  return views.sort((a, b) => rank[a.state] - rank[b.state] || b.endsAt - a.endsAt);
}

/** Return requests (RMAs) of the customer, newest first. Staff notes never leave the server. */
export async function listReturnRequests(db: Db, customerId: string): Promise<ReturnRequestView[]> {
  const rows = await db
    .select({
      rma: returns.rma,
      status: returns.status,
      reasonCode: returns.reasonCode,
      requestedResolution: returns.requestedResolution,
      resolution: returns.resolution,
      rejectReason: returns.rejectReason,
      createdAt: returns.createdAt,
      orderRef: orders.ref,
      orderCustomer: orders.customerId,
    })
    .from(returns)
    .innerJoin(orders, eq(orders.id, returns.orderId))
    .where(eq(returns.customerId, customerId))
    .orderBy(desc(returns.createdAt), desc(returns.id))
    .limit(50);
  return rows.map((row) => ({
    rma: row.rma,
    orderRef: row.orderCustomer === customerId ? row.orderRef : null,
    status: row.status,
    reasonCode: row.reasonCode,
    requestedResolution: row.requestedResolution,
    resolution: row.resolution,
    rejectReason: row.status === "rejected" ? row.rejectReason : null,
    createdAt: row.createdAt,
  }));
}

/** Delivered orders still inside the store's general return window, newest delivery first. */
export async function listReturnableOrders(db: Db, customerId: string, locale: Locale, now: number): Promise<{ orders: ReturnableOrder[]; windowDays: number }> {
  const windowDays = await getSetting(db, "returns.window_days");
  const cutoff = now - windowDays * DAY_MS;
  const rows = await db
    .select({ id: orders.id, ref: orders.ref, deliveredAt: orders.deliveredAt })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.status, "delivered"), gte(orders.deliveredAt, cutoff)))
    .orderBy(desc(orders.deliveredAt), desc(orders.id))
    .limit(20);
  const delivered = rows.filter((row): row is typeof row & { deliveredAt: number } => row.deliveredAt !== null);
  const items = delivered.length
    ? await db
        .select({ orderId: orderItems.orderId, name: orderItems.nameSnapshot, qty: orderItems.qty })
        .from(orderItems)
        .where(inArray(orderItems.orderId, delivered.map((row) => row.id)))
        .orderBy(asc(orderItems.id))
    : [];
  return {
    windowDays,
    orders: delivered.map((row) => {
      const lines = items.filter((item) => item.orderId === row.id);
      return {
        ref: row.ref,
        deliveredAt: row.deliveredAt,
        windowEndsAt: row.deliveredAt + windowDays * DAY_MS,
        firstItemName: lines[0] ? pick(lines[0].name, locale) : "",
        itemCount: lines.reduce((sum, line) => sum + line.qty, 0),
      };
    }),
  };
}
