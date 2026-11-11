/**
 * 05.06 — invoices, packing slips and shipping labels, one order or a batch (printed by the browser: print CSS, no
 * printer integration exists or is needed).
 *
 *   await issueInvoices(db, actor, orderIds, now);                                   POST — numbers are issued once
 *   const docs = await printDocuments(db, actor, { kind, orderIds }, locale);       GET — reads only
 *
 * INVOICES are numbered documents (`invoices`, gap-free counter `sequences.invoice` → INV-000001), issued once per order
 * in the issuing batch, guarded so a second request for the same order issues nothing and takes no number. Only
 * orders the store has accepted get one (confirmed, preparing, shipped, delivered, returned). The frozen content
 * (`invoices.data`) is what reprints show: lines, totals, payment method, the customer's name and address — never
 * cost data. The phone on any document is shown in full only to holders of customer.phone.read_full (labels need
 * it; the fulfilment role has it).
 * PACKING SLIPS list what goes in each parcel (SKU, quantity, serials) and nothing about money.
 * LABELS name the recipient, phone, governorate and address, the parcel number, and what the courier does about money:
 * collect the unpaid cash on delivery (on parcel 1 only), nothing for an order PAID IN FULL ("prepaid"), or — for an
 * order not paid (a transfer still awaited) or not shippable (not confirmed, cancelled, returned) — do not hand it
 * over. "No pending cash row" is never read as "prepaid". With the order reference as a Code 128 barcode.
 */
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { districts, governorates, invoices, orderItemSerials, orderItems, orders, payments, serials, shipmentItems, shipments } from "~/server/db/schema";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { phoneFor } from "./shared.server";
import { PRINT_KINDS, type AnyPaymentMethod, type PhoneView, type PrintKind } from "./types";

export { PRINT_KINDS, type PrintKind };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const MAX_BATCH = 50;
const INVOICEABLE = ["confirmed", "preparing", "shipped", "delivered", "returned"] as const;

export const OrderIdsInput = z.array(z.string().regex(ID_PATTERN, "invalid")).min(1, "required").max(MAX_BATCH, "too_big");

type InvoiceData = {
  ref: string;
  placedAt: number;
  contactName: string | null;
  phoneE164: string | null;
  governorate: L10n | null;
  district: L10n | null;
  area: string | null;
  address: string | null;
  paymentMethod: string | null;
  lines: { sku: string; name: L10n; qty: number; unitPriceIqd: number; totalIqd: number }[];
  subtotalIqd: number;
  discountIqd: number;
  shippingIqd: number;
  taxIqd: number;
  totalIqd: number;
  couponCode: string | null;
};

/** Issues the missing invoices of these orders (one number each, once). Returns how many were issued now. */
export async function issueInvoices(db: Db, actor: Actor, rawIds: readonly string[], now: number): Promise<{ issued: number; skipped: number }> {
  assertCan(actor, "orders.document.print");
  const ids = OrderIdsInput.parse([...new Set(rawIds)]);
  const rows = await db
    .select()
    .from(orders)
    .where(and(inArray(orders.id, ids), inArray(orders.status, [...INVOICEABLE]), sql`NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = ${orders.id} AND i.kind = 'invoice')`));
  if (rows.length === 0) return { issued: 0, skipped: ids.length };
  const [lines, govs, dists] = await Promise.all([
    db
      .select({ orderId: orderItems.orderId, sku: orderItems.sku, name: orderItems.nameSnapshot, qty: orderItems.qty, unitPriceIqd: orderItems.unitPriceIqd, totalIqd: orderItems.totalIqd })
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(orderItems.id)),
    db.select({ id: governorates.id, name: governorates.name }).from(governorates),
    db.select({ id: districts.id, name: districts.name }).from(districts),
  ]);
  const statements: BatchStatement[] = [batchSql(db, sql`INSERT INTO sequences (name, value) VALUES ('invoice', 0) ON CONFLICT(name) DO NOTHING`)];
  for (const order of rows) {
    const data: InvoiceData = {
      ref: order.ref,
      placedAt: order.placedAt,
      contactName: order.contactName,
      phoneE164: order.contactPhoneE164,
      governorate: govs.find((row) => row.id === order.governorateId)?.name ?? null,
      district: dists.find((row) => row.id === order.districtId)?.name ?? null,
      area: order.areaText,
      address: order.addressText,
      paymentMethod: order.paymentMethod,
      lines: lines.filter((line) => line.orderId === order.id).map((line) => ({ sku: line.sku, name: line.name, qty: line.qty, unitPriceIqd: line.unitPriceIqd, totalIqd: line.totalIqd })),
      subtotalIqd: order.subtotalIqd,
      discountIqd: order.discountIqd,
      shippingIqd: order.shippingIqd,
      taxIqd: order.taxIqd,
      totalIqd: order.totalIqd,
      couponCode: order.couponCode,
    };
    const id = newId("inv");
    const json = JSON.stringify(data);
    // Issued once, and only from the order as it was read: an order edited (or moved on) meanwhile gets no invoice
    // with stale lines and totals — it is skipped, and the next request reads it again.
    const guard = sql`NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = ${order.id} AND kind = 'invoice')
      AND EXISTS (SELECT 1 FROM orders WHERE id = ${order.id} AND updated_at = ${order.updatedAt} AND total_iqd = ${order.totalIqd})`;
    statements.push(
      // The counter moves only when this order gets its first invoice: no gaps, no second number.
      batchSql(db, sql`UPDATE sequences SET value = value + 1 WHERE name = 'invoice' AND ${guard}`),
      batchSql(
        db,
        sql`INSERT INTO invoices (id, number, kind, order_id, total_iqd, data, issued_at, issued_by)
          SELECT ${id}, 'INV-' || printf('%06d', s.value), 'invoice', ${order.id}, ${order.totalIqd}, ${json}, ${now}, ${actor.kind === "employee" ? actor.id : null}
          FROM sequences s WHERE s.name = 'invoice' AND ${guard}`,
      ),
      auditStatement(db, { actor, action: "orders.document.invoice", entityType: "order", entityId: order.id, summary: `${order.ref}: invoice issued`, after: { invoiceId: id, totalIqd: order.totalIqd }, at: now }),
    );
  }
  await runBatch(db, statements);
  const issued = await db
    .select({ n: sql<number>`count(*)` })
    .from(invoices)
    .where(
      and(
        eq(invoices.issuedAt, now),
        inArray(
          invoices.orderId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .get();
  return { issued: Number(issued?.n ?? 0), skipped: ids.length - Number(issued?.n ?? 0) };
}

export type InvoiceDoc = {
  kind: "invoice";
  orderId: string;
  ref: string;
  status: string;
  isDemo: boolean;
  /** Null: no invoice issued yet (the print page offers to issue it). */
  number: string | null;
  issuedAt: number | null;
  placedAt: number;
  contactName: string | null;
  phone: PhoneView | null;
  governorate: string | null;
  district: string | null;
  area: string | null;
  address: string | null;
  paymentMethod: AnyPaymentMethod | null;
  lines: { sku: string; name: string; qty: number; unitPriceIqd: number; totalIqd: number }[];
  totals: { subtotalIqd: number; discountIqd: number; shippingIqd: number; taxIqd: number; totalIqd: number };
  couponCode: string | null;
  invoiceable: boolean;
};

/** Statuses whose parcel may go to the courier (confirmed and paid or COD-confirmed, being packed, or already out). */
const SHIPPABLE = ["confirmed", "preparing", "shipped"] as const;

export type PackingDoc = {
  kind: "packing";
  orderId: string;
  ref: string;
  status: string;
  /** False: the order is not to be handed to a courier now (not confirmed, cancelled, returned, delivered). */
  shippable: boolean;
  isDemo: boolean;
  parcel: number;
  parcels: number;
  contactName: string | null;
  governorate: string | null;
  lines: { sku: string; name: string; qty: number; serials: string[] }[];
};

export type LabelDoc = {
  kind: "label";
  orderId: string;
  ref: string;
  status: string;
  /** False: the order is not to be handed to a courier now (not confirmed, cancelled, returned, delivered). */
  shippable: boolean;
  /**
   * What the courier does about money: "collect" the unpaid cash on delivery (collectIqd), nothing for an order
   * "prepaid" in full, or — "unpaid" — hand nothing over (a transfer still awaited, a cancelled order).
   */
  payment: "collect" | "prepaid" | "unpaid";
  isDemo: boolean;
  parcel: number;
  parcels: number;
  contactName: string | null;
  phone: PhoneView | null;
  governorate: string | null;
  district: string | null;
  area: string | null;
  address: string | null;
  notes: string | null;
  /** Cash the courier collects (unpaid cash on delivery), else 0. */
  collectIqd: number;
  trackingNo: string | null;
};

export type PrintDoc = InvoiceDoc | PackingDoc | LabelDoc;

/** The documents of a batch, in the order the ids were given. Reads only. */
export async function printDocuments(db: Db, actor: Actor, input: { kind: PrintKind; orderIds: readonly string[] }, locale: Locale): Promise<PrintDoc[]> {
  assertCan(actor, "orders.document.print");
  const kind = z.enum(PRINT_KINDS).parse(input.kind);
  const ids = OrderIdsInput.parse([...new Set(input.orderIds)]);
  const orderRows = await db.select().from(orders).where(inArray(orders.id, ids));
  const byId = new Map(orderRows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (ordered.length === 0) return [];
  const orderIds = ordered.map((row) => row.id);
  const [govs, dists, lines, invoiceRows, parcelRows, parcelItems, serialRows, codRows] = await Promise.all([
    db.select({ id: governorates.id, name: governorates.name }).from(governorates),
    db.select({ id: districts.id, name: districts.name }).from(districts),
    db
      .select({ id: orderItems.id, orderId: orderItems.orderId, sku: orderItems.sku, name: orderItems.nameSnapshot, qty: orderItems.qty, unitPriceIqd: orderItems.unitPriceIqd, totalIqd: orderItems.totalIqd })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds))
      .orderBy(asc(orderItems.id)),
    db
      .select({ orderId: invoices.orderId, number: invoices.number, issuedAt: invoices.issuedAt, data: invoices.data })
      .from(invoices)
      .where(and(inArray(invoices.orderId, orderIds), eq(invoices.kind, "invoice"))),
    db
      .select({ id: shipments.id, orderId: shipments.orderId, trackingNo: shipments.trackingNo, createdAt: shipments.createdAt })
      .from(shipments)
      .where(and(inArray(shipments.orderId, orderIds), notInArray(shipments.status, ["cancelled"])))
      .orderBy(asc(shipments.createdAt), asc(shipments.id)),
    db
      .select({ shipmentId: shipmentItems.shipmentId, orderItemId: shipmentItems.orderItemId, qty: shipmentItems.qty })
      .from(shipmentItems)
      .innerJoin(shipments, eq(shipments.id, shipmentItems.shipmentId))
      .where(inArray(shipments.orderId, orderIds)),
    db
      .select({ orderItemId: orderItemSerials.orderItemId, serial: serials.serial })
      .from(orderItemSerials)
      .innerJoin(serials, eq(serials.id, orderItemSerials.serialId))
      .innerJoin(orderItems, eq(orderItems.id, orderItemSerials.orderItemId))
      .where(and(inArray(orderItems.orderId, orderIds), sql`${orderItemSerials.releasedAt} IS NULL`)),
    db
      .select({ orderId: payments.orderId, amountIqd: payments.amountIqd })
      .from(payments)
      .where(and(inArray(payments.orderId, orderIds), eq(payments.method, "cod"), eq(payments.status, "pending"))),
  ]);
  const name = (rows: { id: string; name: L10n }[], id: string | null) => {
    const row = id ? rows.find((entry) => entry.id === id) : undefined;
    return row ? pick(row.name, locale) : null;
  };

  const docs: PrintDoc[] = [];
  for (const order of ordered) {
    if (kind === "invoice") {
      const issued = invoiceRows.find((row) => row.orderId === order.id);
      const frozen = issued?.data as InvoiceData | undefined;
      const source = frozen ?? null;
      docs.push({
        kind: "invoice",
        orderId: order.id,
        ref: order.ref,
        status: order.status,
        isDemo: order.isDemo,
        number: issued?.number ?? null,
        issuedAt: issued?.issuedAt ?? null,
        placedAt: order.placedAt,
        contactName: source ? source.contactName : order.contactName,
        phone: phoneFor(actor, source ? source.phoneE164 : order.contactPhoneE164),
        governorate: source?.governorate ? pick(source.governorate, locale) : name(govs, order.governorateId),
        district: source?.district ? pick(source.district, locale) : name(dists, order.districtId),
        area: source ? source.area : order.areaText,
        address: source ? source.address : order.addressText,
        paymentMethod: (source ? source.paymentMethod : order.paymentMethod) as AnyPaymentMethod | null,
        lines: source
          ? source.lines.map((line) => ({ sku: line.sku, name: pick(line.name, locale), qty: line.qty, unitPriceIqd: line.unitPriceIqd, totalIqd: line.totalIqd }))
          : lines.filter((line) => line.orderId === order.id).map((line) => ({ sku: line.sku, name: pick(line.name, locale), qty: line.qty, unitPriceIqd: line.unitPriceIqd, totalIqd: line.totalIqd })),
        totals: source
          ? { subtotalIqd: source.subtotalIqd, discountIqd: source.discountIqd, shippingIqd: source.shippingIqd, taxIqd: source.taxIqd, totalIqd: source.totalIqd }
          : { subtotalIqd: order.subtotalIqd, discountIqd: order.discountIqd, shippingIqd: order.shippingIqd, taxIqd: order.taxIqd, totalIqd: order.totalIqd },
        couponCode: source ? source.couponCode : order.couponCode,
        invoiceable: (INVOICEABLE as readonly string[]).includes(order.status),
      });
      continue;
    }
    const orderLines = lines.filter((line) => line.orderId === order.id);
    const parcels = parcelRows.filter((row) => row.orderId === order.id);
    // No parcel record yet: the whole order is one parcel.
    const groups =
      parcels.length > 0
        ? parcels.map((parcel) => ({ trackingNo: parcel.trackingNo, items: parcelItems.filter((item) => item.shipmentId === parcel.id) }))
        : [{ trackingNo: null, items: orderLines.map((line) => ({ shipmentId: "", orderItemId: line.id, qty: line.qty })) }];
    const collect = codRows.filter((row) => row.orderId === order.id).reduce((sum, row) => sum + row.amountIqd, 0);
    const shippable = (SHIPPABLE as readonly string[]).includes(order.status);
    // "Prepaid — collect nothing" only for an order paid in full: no pending cash row is NOT the same as paid
    const payment: LabelDoc["payment"] = !shippable ? "unpaid" : collect > 0 ? "collect" : order.paidIqd >= order.totalIqd ? "prepaid" : "unpaid";
    groups.forEach((group, index) => {
      if (kind === "packing") {
        docs.push({
          kind: "packing",
          orderId: order.id,
          ref: order.ref,
          status: order.status,
          shippable,
          isDemo: order.isDemo,
          parcel: index + 1,
          parcels: groups.length,
          contactName: order.contactName,
          governorate: name(govs, order.governorateId),
          lines: group.items.map((item) => {
            const line = orderLines.find((entry) => entry.id === item.orderItemId);
            return {
              sku: line?.sku ?? "",
              name: line ? pick(line.name, locale) : "",
              qty: item.qty,
              serials: serialRows.filter((row) => row.orderItemId === item.orderItemId).map((row) => row.serial),
            };
          }),
        });
      } else {
        docs.push({
          kind: "label",
          orderId: order.id,
          ref: order.ref,
          status: order.status,
          shippable,
          payment,
          isDemo: order.isDemo,
          parcel: index + 1,
          parcels: groups.length,
          contactName: order.contactName,
          phone: phoneFor(actor, order.contactPhoneE164),
          governorate: name(govs, order.governorateId),
          district: name(dists, order.districtId),
          area: order.areaText,
          address: order.addressText,
          notes: order.notes,
          // The cash to collect goes on the first parcel only, so a courier never collects it twice.
          collectIqd: index === 0 && payment === "collect" ? collect : 0,
          trackingNo: group.trackingNo,
        });
      }
    });
  }
  return docs;
}

/** Order ids for a list of references (the print page accepts either). */
export async function orderIdsForRefs(db: Db, refs: readonly string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const rows = await db
    .select({ id: orders.id, ref: orders.ref })
    .from(orders)
    .where(inArray(orders.ref, [...refs].slice(0, MAX_BATCH)));
  return refs.map((ref) => rows.find((row) => row.ref === ref)?.id).filter((id): id is string => Boolean(id));
}
