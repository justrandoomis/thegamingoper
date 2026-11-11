/**
 * Small server helpers shared by the services of admin module 11 (shipping): what this employee may do here, how a
 * parcel's cash-on-delivery position is read from the order's payment, which parcels hold a "sensitive" device, and
 * the private-file URLs of the module.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { orders, payments, shipments } from "~/server/db/schema";
import { notFound } from "~/server/errors";
import { parcelNumberOf, type CodView } from "./rules";

export { employeeNames, phoneFor } from "~/server/services/admin/orders/shared.server";

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Carrier rates and charges — what the store pays its delivery suppliers — are cost data. They reach the people who
 * choose carriers (shipping.shipment.create), manage them (shipping.carrier.manage), settle with them
 * (shipping.cod.settle) or see cost (cost.read); a role that only reads parcels (support, stock) never receives them,
 * not in page data, JSON or history (blueprint acceptance #5).
 */
export function canSeeCarrierCost(actor: Actor): boolean {
  return can(actor, "shipping.shipment.create") || can(actor, "shipping.carrier.manage") || can(actor, "shipping.cod.settle") || can(actor, "cost.read");
}

/** An event's data as a reader of parcels may see it: the carrier's charge only for canSeeCarrierCost. */
export function eventDataFor(actor: Actor, data: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  if (canSeeCarrierCost(actor)) return data;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) if (!CARRIER_COST_KEYS.has(key)) out[key] = value;
  return out;
}
const CARRIER_COST_KEYS = new Set(["feeIqd", "codFeeIqd", "costIqd", "suggestedFeeIqd"]);

/** What the module's screens may show and offer to this employee (the services check each action again). */
export function shippingAccess(actor: Actor) {
  return {
    carrierCost: canSeeCarrierCost(actor),
    read: can(actor, "shipping.shipment.read"),
    waybill: can(actor, "shipping.shipment.create"),
    update: can(actor, "shipping.shipment.update"),
    attempts: can(actor, "shipping.attempt.manage"),
    proof: can(actor, "shipping.proof.manage"),
    carriers: can(actor, "shipping.carrier.manage"),
    zones: can(actor, "shipping.zone.manage"),
    rates: can(actor, "shipping.rate.manage"),
    fee: can(actor, "settings.shipping.manage"),
    cod: can(actor, "shipping.cod.settle"),
    ship: can(actor, "orders.fulfillment.ship"),
    deliver: can(actor, "orders.fulfillment.deliver"),
    recordCod: can(actor, "orders.payment.record"),
    profit: can(actor, "profit.read"),
    serials: can(actor, "inventory.serial.read"),
    audit: can(actor, "audit.read"),
  };
}
export type ShippingAccess = ReturnType<typeof shippingAccess>;

/** Private files of the module are served by /admin/shipping/files/:fileId. */
export const fileUrl = (fileId: string) => `/admin/shipping/files/${encodeURIComponent(fileId)}`;

/**
 * A SQL condition "this parcel holds a sensitive device": a serial-tracked unit (also inside a bundle), a used device,
 * or a console. Parcels without item rows are judged by their order's lines.
 */
export const sensitiveSql = sql<number>`(
  EXISTS (SELECT 1 FROM shipment_items si JOIN order_items oi ON oi.id = si.order_item_id JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
          WHERE si.shipment_id = "shipments"."id" AND (v.track_serials = 1 OR oi.used_unit_id IS NOT NULL OR p.kind = 'console'
            OR EXISTS (SELECT 1 FROM bundle_items b JOIN variants cv ON cv.id = b.component_variant_id WHERE b.bundle_variant_id = v.id AND cv.track_serials = 1)))
  OR (NOT EXISTS (SELECT 1 FROM shipment_items si2 WHERE si2.shipment_id = "shipments"."id")
      AND EXISTS (SELECT 1 FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
                  WHERE oi.order_id = "shipments"."order_id" AND (v.track_serials = 1 OR oi.used_unit_id IS NOT NULL OR p.kind = 'console')))
)`;

/** A parcel's packing is documented when a packing photo is on it. */
export const documentedSql = sql<number>`("shipments"."packing_file_id" IS NOT NULL)`;

/** The first live parcel of each order (it carries the order's cash on delivery, as the orders module's labels say). */
export async function firstParcels(db: Db, orderIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (orderIds.length === 0) return out;
  for (let i = 0; i < orderIds.length; i += 90) {
    const rows = await db
      .select({ id: shipments.id, orderId: shipments.orderId })
      .from(shipments)
      .where(and(inArray(shipments.orderId, orderIds.slice(i, i + 90)), ne(shipments.status, "cancelled")))
      .orderBy(asc(shipments.createdAt), asc(shipments.id));
    for (const row of rows) if (!out.has(row.orderId)) out.set(row.orderId, row.id);
  }
  return out;
}

type OrderMoney = { id: string; paymentMethod: string | null; paidIqd: number; totalIqd: number; status: string };

/** The cash-on-delivery payments (newest, not cancelled) of these orders. */
export async function codPayments(db: Db, orderIds: readonly string[]): Promise<Map<string, { id: string; status: string; amountIqd: number }>> {
  const out = new Map<string, { id: string; status: string; amountIqd: number; createdAt: number }>();
  for (let i = 0; i < orderIds.length; i += 90) {
    const rows = await db
      .select({ id: payments.id, orderId: payments.orderId, status: payments.status, amountIqd: payments.amountIqd, createdAt: payments.createdAt })
      .from(payments)
      .where(and(inArray(payments.orderId, orderIds.slice(i, i + 90)), eq(payments.method, "cod"), ne(payments.status, "cancelled")));
    for (const row of rows) {
      const seen = out.get(row.orderId);
      if (!seen || row.createdAt > seen.createdAt || (row.createdAt === seen.createdAt && row.id > seen.id)) out.set(row.orderId, row);
    }
  }
  return out;
}

/** How the courier handles money for this parcel (file header of rules.ts → CodView). */
export function codViewOf(order: OrderMoney, shipmentId: string, firstParcel: string | undefined, payment: { status: string; amountIqd: number } | undefined): CodView {
  if (order.paymentMethod === "cod" && payment) {
    if (shipmentId !== firstParcel) return { kind: "with_first" };
    if (payment.status === "paid") return { kind: "collected", amountIqd: payment.amountIqd };
    if (payment.status === "pending") return { kind: "collect", amountIqd: payment.amountIqd };
  }
  if (order.paidIqd >= order.totalIqd && order.totalIqd > 0) return { kind: "prepaid" };
  return { kind: "unpaid" };
}

/** The parcel row, or 404. */
export async function parcelById(db: Db, shipmentId: string) {
  const parcel = ID_PATTERN.test(shipmentId) ? await db.select().from(shipments).where(eq(shipments.id, shipmentId)).get() : undefined;
  if (!parcel) throw notFound("shipment");
  return parcel;
}

export async function orderOf(db: Db, orderId: string) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw notFound("order");
  return order;
}

/** "YYYY-MM-DD" (a Baghdad day) → epoch ms of 09:00 that day in Baghdad; null when not a real date. */
export function baghdadDay(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const at = Date.UTC(y, m - 1, d, 6, 0, 0);
  const check = new Date(at);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return at;
}

/** The Baghdad calendar day of a time ("YYYY-MM-DD"). */
export function dayOf(at: number): string {
  return new Date(at + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
