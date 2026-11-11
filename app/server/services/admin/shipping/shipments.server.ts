/**
 * 11.03 / 11.05 / 11.06 — parcels on their way: waybill and tracking number, pickup, courier statuses, failed tries and
 * retries, delivery with proof of receipt, parcels coming back, documented packing of sensitive devices, and the
 * printed waybills and pickup manifests.
 *
 *   const page = await listShipments(db, actor, parseShipmentFilters(params), locale, now);       shipping.shipment.read
 *   const parcel = await getShipment(db, actor, shipmentId, locale, now);                           shipping.shipment.read
 *   await saveWaybill(db, actor, { shipmentId, carrierId, serviceLevel, trackingNo? }, now);        shipping.shipment.create
 *   await assignByRule(db, actor, { shipmentIds, serviceLevel }, now);                              shipping.shipment.create
 *   await pickupParcels(db, actor, { shipmentIds }, now);              shipping.shipment.update + orders.fulfillment.ship
 *   await moveParcels(db, actor, { shipmentIds, to: "in_transit" }, now);                           shipping.shipment.update
 *   await recordAttempt(db, actor, { shipmentId, outcome: "no_answer", nextAttemptDay }, now);      shipping.attempt.manage
 *   await deliverShipment(db, actor, { shipmentId, receivedByName, fileId }, now);   core deliverParcel (+ .deliver)
 *   await receiveReturn(db, actor, { shipmentId, reason, lines }, now);              core returnParcels (attempt.manage)
 *   await addPackingPhoto(db, actor, { shipmentId, fileId, note }, now);                            shipping.proof.manage
 *   const n = await countFailedDeliveries(db, actor);                the admin shell's queue (null without .attempt.manage)
 *
 * Parcels are the `shipments` rows the orders module (05) creates at its packing station (ids shp_<order>_<n>, scans
 * in shipment_events). This module adds the carrier, service level, tracking number, carrier charge and cash to
 * collect (the WAYBILL), and follows the parcel to the door. Anything that moves an order — shipping it at pickup,
 * delivering it, taking it back — goes through the orders module's changeOrderStatus (its hold and scan-verified
 * packing rules) or the commerce core (orders/shipments.server.ts → transitionOrder); the plain courier statuses
 * (in transit, out for delivery, failed try, on its way back) touch the parcel only. Every change is a shipment
 * event (append-only) and an audit event with the actor and the reason.
 *
 * NO COURIER API IS CONNECTED: statuses are typed or scanned by staff (a scanner types the waybill code into the
 * search field), the tracking number is the carrier's typed number or the store's waybill number (order reference +
 * parcel number), and the waybill is printed by the browser.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { formatIraqPhone } from "~/lib/phone";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  carriers,
  codSettlementItems,
  codSettlements,
  deliveryAttempts,
  districts,
  files,
  governorates,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  serials,
  shipmentEvents,
  shipmentItems,
  shipments,
} from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { changeOrderStatus } from "~/server/services/admin/orders/actions.server";
import { notifyOrderContact, ORDER_TEMPLATES } from "~/server/services/admin/orders/notify.server";
import { safeData } from "~/server/services/admin/orders/shared.server";
import { deliverParcel, parcelsOutOfStep, returnParcels, settlementNeedsSecondPerson, settlementPreparers, syncParcels } from "~/server/services/orders/shipments.server";
import { activeCarrier, carrierOptions, carrierRate } from "./carriers.server";
import {
  AT_STORE,
  DELIVERABLE,
  FAILURE_OUTCOMES,
  FINAL,
  IN_FLIGHT,
  ON_ROAD,
  SERVICE_LEVELS,
  SHIPMENT_PAGE_SIZE,
  SIMPLE_MOVES,
  canMove,
  inList,
  isServiceLevel,
  parcelCode,
  parcelNumberOf,
  parseParcelCode,
  type AttemptView,
  type CodView,
  type ParcelEvent,
  type ServiceLevel,
  type ShipmentDetail,
  type ShipmentFilters,
  type ShipmentListPage,
  type ShipmentListRow,
  type ShipmentStatus,
  type SimpleMove,
} from "./rules";
import { baghdadDay, canSeeCarrierCost, codPayments, codViewOf, dayOf, documentedSql, employeeNames, eventDataFor, fileUrl, firstParcels, ID_PATTERN, orderOf, parcelById, phoneFor, sensitiveSql } from "./shared.server";

const idSchema = z.string().regex(ID_PATTERN, "invalid");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "too_long")
    .optional()
    .transform((value) => value || undefined);
const statusSchema = z.enum(["pending", "packed", "handed_over", "in_transit", "out_for_delivery", "delivered", "failed", "returning", "returned", "cancelled"]);
const OPEN: readonly ShipmentStatus[] = ["pending", "packed", "handed_over", "in_transit", "out_for_delivery", "failed", "returning"];

// ───────────────────────────────────────────────────────────────── the list (11.03)

function statusCondition(status: ShipmentFilters["status"]): SQL | undefined {
  if (status === "all") return undefined;
  if (status === "open") return inArray(shipments.status, [...OPEN]);
  if (status === "on_road") return inArray(shipments.status, [...ON_ROAD]);
  return eq(shipments.status, status);
}

function searchCondition(raw: string): SQL | undefined {
  const q = raw.toUpperCase().replace(/\s+/g, "");
  if (!q) return undefined;
  const code = parseParcelCode(q);
  if (code) return and(eq(orders.ref, code.ref), sql`${shipments.id} = 'shp_' || ${orders.id} || '_' || ${String(code.number)}`);
  // D1 refuses LIKE patterns over ~50 bytes; a prefix of plain characters is enough to find a reference or a number.
  const prefix = q.replace(/[^A-Z0-9-]/g, "").slice(0, 30);
  return or(eq(orders.ref, q), sql`upper(${shipments.trackingNo}) = ${q}`, prefix ? like(orders.ref, `${prefix}%`) : undefined, prefix ? sql`upper(${shipments.trackingNo}) LIKE ${`${prefix}%`}` : undefined);
}

function flagCondition(flag: ShipmentFilters["flag"]): SQL | undefined {
  switch (flag) {
    case "no_waybill":
      return isNull(shipments.carrierId);
    case "undocumented":
      return and(sql`${sensitiveSql}`, isNull(shipments.packingFileId), inArray(shipments.status, [...AT_STORE]));
    case "cod_unsettled":
      return and(inArray(shipments.status, ["delivered", "returned"]), isNotNull(shipments.carrierId), isNull(shipments.codSettledAt), sql`NOT EXISTS (SELECT 1 FROM cod_settlement_items i WHERE i.shipment_id = ${shipments.id})`);
    case "attempts":
      return sql`EXISTS (SELECT 1 FROM delivery_attempts da WHERE da.shipment_id = ${shipments.id} AND da.outcome <> 'delivered')`;
    default:
      return undefined;
  }
}

/** 11.03 — parcels with their carrier, tracking, money and progress; filters in the URL, 25 a page. */
export async function listShipments(db: Db, actor: Actor, filters: ShipmentFilters, locale: Locale, now: number): Promise<ShipmentListPage> {
  assertCan(actor, "shipping.shipment.read");
  void now;
  const where = and(
    statusCondition(filters.status),
    filters.carrier === "none" ? isNull(shipments.carrierId) : filters.carrier ? eq(shipments.carrierId, filters.carrier) : undefined,
    filters.governorate ? eq(orders.governorateId, filters.governorate) : undefined,
    searchCondition(filters.q),
    flagCondition(filters.flag),
  );
  const order = filters.sort === "created_asc" ? [asc(shipments.createdAt), asc(shipments.id)] : filters.sort === "updated_desc" ? [desc(shipments.updatedAt), desc(shipments.id)] : [desc(shipments.createdAt), desc(shipments.id)];
  const [total, rows, counts, govs] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(shipments).innerJoin(orders, eq(orders.id, shipments.orderId)).where(where).get(),
    db
      .select({
        id: shipments.id,
        orderId: shipments.orderId,
        status: shipments.status,
        carrierId: shipments.carrierId,
        carrierName: carriers.name,
        trackingNo: shipments.trackingNo,
        createdAt: shipments.createdAt,
        shippedAt: shipments.shippedAt,
        deliveredAt: shipments.deliveredAt,
        codSettledAt: shipments.codSettledAt,
        ref: orders.ref,
        orderStatus: orders.status,
        paymentMethod: orders.paymentMethod,
        paidIqd: orders.paidIqd,
        totalIqd: orders.totalIqd,
        governorateId: orders.governorateId,
        isDemo: orders.isDemo,
        sensitive: sensitiveSql,
        documented: documentedSql,
        attempts: sql<number>`(SELECT count(*) FROM delivery_attempts da WHERE da.shipment_id = "shipments"."id" AND da.outcome <> 'delivered')`,
        nextAttemptAt: sql<number | null>`(SELECT da.next_attempt_at FROM delivery_attempts da WHERE da.shipment_id = "shipments"."id" ORDER BY da.attempt_no DESC LIMIT 1)`,
        inSettlement: sql<number>`EXISTS (SELECT 1 FROM cod_settlement_items i WHERE i.shipment_id = "shipments"."id")`,
      })
      .from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .leftJoin(carriers, eq(carriers.id, shipments.carrierId))
      .where(where)
      .orderBy(...order)
      .limit(SHIPMENT_PAGE_SIZE)
      .offset((filters.page - 1) * SHIPMENT_PAGE_SIZE),
    db
      .select({
        open: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} IN ('pending','packed','handed_over','in_transit','out_for_delivery','failed','returning') THEN 1 ELSE 0 END), 0)`,
        onRoad: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} IN ('handed_over','in_transit','out_for_delivery') THEN 1 ELSE 0 END), 0)`,
        packed: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} = 'packed' THEN 1 ELSE 0 END), 0)`,
        failed: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} = 'failed' THEN 1 ELSE 0 END), 0)`,
        returning: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} = 'returning' THEN 1 ELSE 0 END), 0)`,
      })
      .from(shipments)
      .get(),
    db.select({ id: governorates.id, name: governorates.name }).from(governorates),
  ]);
  const orderIds = [...new Set(rows.map((row) => row.orderId))];
  const [first, cod] = await Promise.all([firstParcels(db, orderIds), codPayments(db, orderIds)]);
  const count = Number(total?.n ?? 0);
  return {
    rows: rows.map(
      (row): ShipmentListRow => ({
        id: row.id,
        number: parcelNumberOf(row.orderId, row.id),
        code: parcelCode(row.ref, parcelNumberOf(row.orderId, row.id) || 1),
        orderId: row.orderId,
        ref: row.ref,
        orderStatus: row.orderStatus,
        status: row.status,
        carrier: row.carrierId ? { id: row.carrierId, name: row.carrierName ?? row.carrierId } : null,
        trackingNo: row.trackingNo,
        governorate: row.governorateId ? pickName(govs, row.governorateId, locale) : null,
        cod: codViewOf({ id: row.orderId, paymentMethod: row.paymentMethod, paidIqd: row.paidIqd, totalIqd: row.totalIqd, status: row.orderStatus }, row.id, first.get(row.orderId), cod.get(row.orderId)),
        sensitive: Boolean(row.sensitive),
        documented: Boolean(row.documented),
        attempts: Number(row.attempts ?? 0),
        nextAttemptAt: row.nextAttemptAt === null ? null : Number(row.nextAttemptAt),
        settled: row.codSettledAt !== null || Boolean(row.inSettlement),
        createdAt: row.createdAt,
        shippedAt: row.shippedAt,
        deliveredAt: row.deliveredAt,
        isDemo: row.isDemo,
      }),
    ),
    total: count,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(count / SHIPMENT_PAGE_SIZE)),
    filters,
    counts: { open: Number(counts?.open ?? 0), on_road: Number(counts?.onRoad ?? 0), packed: Number(counts?.packed ?? 0), failed: Number(counts?.failed ?? 0), returning: Number(counts?.returning ?? 0) },
  };
}

const pickName = (rows: { id: string; name: L10n }[], id: string, locale: Locale) => {
  const row = rows.find((entry) => entry.id === id);
  return row ? pick(row.name, locale) : null;
};

/** A scanned or typed code → the parcel: the waybill code (REF-n), a tracking number, an order reference, a parcel id. */
export async function lookupParcel(db: Db, actor: Actor, raw: string): Promise<string | null> {
  assertCan(actor, "shipping.shipment.read");
  const value = typeof raw === "string" ? raw.trim().slice(0, 80) : "";
  if (!value) return null;
  if (ID_PATTERN.test(value) && value.startsWith("shp_")) {
    const row = await db.select({ id: shipments.id }).from(shipments).where(eq(shipments.id, value)).get();
    if (row) return row.id;
  }
  const code = parseParcelCode(value);
  if (code) {
    const row = await db
      .select({ id: shipments.id })
      .from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .where(and(eq(orders.ref, code.ref), sql`${shipments.id} = 'shp_' || ${orders.id} || '_' || ${String(code.number)}`))
      .get();
    if (row) return row.id;
  }
  const byTracking = await db.select({ id: shipments.id }).from(shipments).where(sql`upper(${shipments.trackingNo}) = ${value.toUpperCase()}`).orderBy(desc(shipments.createdAt)).get();
  if (byTracking) return byTracking.id;
  const byRef = await db
    .select({ id: shipments.id })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(eq(orders.ref, value.toUpperCase()), ne(shipments.status, "cancelled")))
    .orderBy(asc(shipments.createdAt), asc(shipments.id))
    .get();
  return byRef?.id ?? null;
}

// ───────────────────────────────────────────────────────────────── one parcel

/** The service level a parcel's waybill was made for (its latest "waybill" event), or null. */
async function serviceLevelOf(db: Db, shipmentId: string): Promise<ServiceLevel | null> {
  const row = await db
    .select({ data: shipmentEvents.data })
    .from(shipmentEvents)
    .where(and(eq(shipmentEvents.shipmentId, shipmentId), eq(shipmentEvents.kind, "waybill")))
    .orderBy(desc(shipmentEvents.at), desc(shipmentEvents.id))
    .get();
  const level = row?.data?.serviceLevel;
  return isServiceLevel(level) ? level : null;
}

function trackingUrl(template: string | null, trackingNo: string | null): string | null {
  if (!template || !trackingNo || !template.includes("{tracking_no}")) return null;
  const url = template.replace("{tracking_no}", encodeURIComponent(trackingNo));
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** 11.03 / 11.05 / 11.06 — the parcel page. */
export async function getShipment(db: Db, actor: Actor, shipmentId: string, locale: Locale, now: number): Promise<ShipmentDetail & { carrierOptions: Awaited<ReturnType<typeof carrierOptions>> }> {
  assertCan(actor, "shipping.shipment.read");
  void now;
  const parcel = await parcelById(db, shipmentId);
  const order = await orderOf(db, parcel.orderId);
  const [carrier, siblings, items, events, attempts, settlementRow, gov, dist, sensitive, level, outOfStep, orderLines] = await Promise.all([
    parcel.carrierId ? db.select().from(carriers).where(eq(carriers.id, parcel.carrierId)).get() : Promise.resolve(undefined),
    db
      .select({ id: shipments.id, status: shipments.status, costIqd: shipments.costIqd, carrierId: shipments.carrierId, createdAt: shipments.createdAt })
      .from(shipments)
      .where(eq(shipments.orderId, order.id))
      .orderBy(asc(shipments.createdAt), asc(shipments.id)),
    db
      .select({ orderItemId: shipmentItems.orderItemId, qty: shipmentItems.qty, name: orderItems.nameSnapshot, sku: orderItems.sku })
      .from(shipmentItems)
      .innerJoin(orderItems, eq(orderItems.id, shipmentItems.orderItemId))
      .where(eq(shipmentItems.shipmentId, parcel.id))
      .orderBy(asc(orderItems.id)),
    db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, parcel.id)).orderBy(asc(shipmentEvents.at), asc(shipmentEvents.id)),
    db.select().from(deliveryAttempts).where(eq(deliveryAttempts.shipmentId, parcel.id)).orderBy(asc(deliveryAttempts.attemptNo)),
    db
      .select({ id: codSettlements.id, ref: codSettlements.ref, status: codSettlements.status })
      .from(codSettlementItems)
      .innerJoin(codSettlements, eq(codSettlements.id, codSettlementItems.settlementId))
      .where(eq(codSettlementItems.shipmentId, parcel.id))
      .get(),
    order.governorateId ? db.select({ name: governorates.name }).from(governorates).where(eq(governorates.id, order.governorateId)).get() : Promise.resolve(undefined),
    order.districtId ? db.select({ name: districts.name }).from(districts).where(eq(districts.id, order.districtId)).get() : Promise.resolve(undefined),
    db.select({ value: sensitiveSql }).from(shipments).where(eq(shipments.id, parcel.id)).get(),
    serviceLevelOf(db, parcel.id),
    parcelsOutOfStep(db, order),
    db.select({ id: orderItems.id, name: orderItems.nameSnapshot, sku: orderItems.sku, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(asc(orderItems.id)),
  ]);
  const live = siblings.filter((row) => row.status !== "cancelled");
  const firstLive = live[0]?.id;
  const cod = (await codPayments(db, [order.id])).get(order.id);
  const codView: CodView = codViewOf({ id: order.id, paymentMethod: order.paymentMethod, paidIqd: order.paidIqd, totalIqd: order.totalIqd, status: order.status }, parcel.id, firstLive, cod);
  const lineIds = (items.length ? items : orderLines.map((line) => ({ orderItemId: line.id }))).map((line) => line.orderItemId);
  const serialRows =
    can(actor, "inventory.serial.read") && lineIds.length
      ? await db
          .select({ orderItemId: orderItemSerials.orderItemId, serial: serials.serial })
          .from(orderItemSerials)
          .innerJoin(serials, eq(serials.id, orderItemSerials.serialId))
          .where(and(inArray(orderItemSerials.orderItemId, lineIds), isNull(orderItemSerials.releasedAt)))
      : null;
  const names = await employeeNames(db, [...events.map((event) => event.actorId), ...attempts.map((attempt) => attempt.recordedBy)]);
  const packingPhotos = events
    .filter((event) => event.kind === "packing_photo" && typeof event.data?.fileId === "string")
    .map((event) => ({ fileId: String(event.data?.fileId), url: fileUrl(String(event.data?.fileId)), note: typeof event.data?.note === "string" ? event.data.note : null, at: event.at }));
  const number = parcelNumberOf(order.id, parcel.id) || 1;
  const status = parcel.status;
  const access = {
    waybill: can(actor, "shipping.shipment.create"),
    update: can(actor, "shipping.shipment.update"),
    attempts: can(actor, "shipping.attempt.manage"),
    proof: can(actor, "shipping.proof.manage"),
    ship: can(actor, "orders.fulfillment.ship"),
    deliver: can(actor, "orders.fulfillment.deliver"),
  };
  const othersUndelivered = live.some((row) => row.id !== parcel.id && row.status !== "delivered");
  const costs = live.map((row) => row.costIqd);
  const detail: ShipmentDetail & { carrierOptions: Awaited<ReturnType<typeof carrierOptions>> } = {
    id: parcel.id,
    code: parcelCode(order.ref, number),
    number,
    parcels: live.map((row) => ({ id: row.id, number: parcelNumberOf(order.id, row.id) || 1, status: row.status })),
    status,
    updatedAt: parcel.updatedAt,
    carrier: carrier ? { id: carrier.id, name: carrier.name, kind: carrier.kind, phone: carrier.phone ? formatIraqPhone(carrier.phone) : null, trackingUrl: trackingUrl(carrier.trackingUrlTemplate, parcel.trackingNo) } : null,
    serviceLevel: level,
    trackingNo: parcel.trackingNo,
    ...(canSeeCarrierCost(actor) ? { costIqd: parcel.costIqd } : {}),
    cod: codView,
    settlement: settlementRow ? { id: settlementRow.id, ref: settlementRow.ref, status: settlementRow.status } : null,
    codSettledAt: parcel.codSettledAt,
    order: {
      id: order.id,
      ref: order.ref,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      totalIqd: order.totalIqd,
      shippingIqd: order.shippingIqd,
      onHold: order.reviewStatus === "blocked",
      isDemo: order.isDemo,
      preferredDay: order.preferredDay,
      preferredWindow: order.preferredWindow,
    },
    recipient: {
      name: order.contactName,
      phone: phoneFor(actor, order.contactPhoneE164),
      governorateId: order.governorateId,
      governorate: gov ? pick(gov.name, locale) : null,
      district: dist ? pick(dist.name, locale) : null,
      area: order.areaText,
      address: order.addressText,
      notes: order.notes,
    },
    items: (items.length ? items.map((item) => ({ orderItemId: item.orderItemId, name: item.name, sku: item.sku, qty: item.qty })) : orderLines.map((line) => ({ orderItemId: line.id, name: line.name, sku: line.sku, qty: line.qty }))).map((item) => ({
      orderItemId: item.orderItemId,
      name: pick(item.name, locale),
      sku: item.sku,
      qty: item.qty,
      ...(serialRows ? { serials: serialRows.filter((row) => row.orderItemId === item.orderItemId).map((row) => row.serial) } : {}),
    })),
    sensitive: Boolean(sensitive?.value),
    packingPhotos,
    proof: parcel.proofFileId ? { url: fileUrl(parcel.proofFileId), receivedByName: parcel.receivedByName } : null,
    receivedByName: parcel.receivedByName,
    failureReason: parcel.failureReason,
    events: events.map(
      (event): ParcelEvent => ({ id: event.id, kind: event.kind, note: event.note, at: event.at, actor: event.actorId ? (names.get(event.actorId) ?? (event.actorKind === "system" ? event.actorId : null)) : null, data: eventDataFor(actor, safeData(event.data)) }),
    ),
    attempts: attempts.map(
      (attempt): AttemptView => ({
        attemptNo: attempt.attemptNo,
        outcome: attempt.outcome,
        reason: attempt.reason,
        notes: attempt.notes,
        nextAttemptAt: attempt.nextAttemptAt,
        attemptedAt: attempt.attemptedAt,
        recordedBy: attempt.recordedBy ? (names.get(attempt.recordedBy) ?? null) : null,
        proofUrl: attempt.proofFileId ? fileUrl(attempt.proofFileId) : null,
      }),
    ),
    createdAt: parcel.createdAt,
    shippedAt: parcel.shippedAt,
    deliveredAt: parcel.deliveredAt,
    returnedAt: parcel.returnedAt,
    outOfStep: outOfStep > 0,
    returnLines: orderLines.map((line) => ({ orderItemId: line.id, name: pick(line.name, locale), sku: line.sku, qty: line.qty })),
    pickupBlock: live.some((row) => inList(row.status, AT_STORE) && !row.carrierId) ? "no_waybill" : sensitive?.value && !parcel.packingFileId && inList(status, AT_STORE) ? "undocumented" : null,
    can: {
      waybill: access.waybill && (inList(status, AT_STORE) || inList(status, [...ON_ROAD])),
      pickup: access.update && access.ship && status === "packed" && (order.status === "confirmed" || order.status === "preparing" || order.status === "shipped"),
      move: access.update && inList(status, [...IN_FLIGHT]),
      attempt: access.attempts && inList(status, [...IN_FLIGHT]),
      deliver: access.update && inList(status, [...DELIVERABLE]) && (order.status === "delivered" || access.deliver || othersUndelivered),
      deliverOrder: access.deliver,
      proof: access.proof && !inList(status, ["returned", "cancelled"]),
      receiveReturn: access.attempts && inList(status, [...IN_FLIGHT]) && order.status === "shipped",
      print: true,
      sync: access.update && outOfStep > 0,
    },
    carrierOptions: access.waybill ? await carrierOptions(db, { governorateId: order.governorateId, codAmountIqd: codView.kind === "collect" ? codView.amountIqd : 0 }) : [],
  };
  if (can(actor, "profit.read")) {
    // The fee charged to the shopper minus what the carriers charge for the order's parcels; unknown while a cost is missing.
    detail.deliveryMarginIqd = costs.some((cost) => cost === null) ? null : order.shippingIqd - costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  }
  return detail;
}

// ───────────────────────────────────────────────────────────────── waybill (11.02 / 11.03)

export const WaybillInput = z.object({
  shipmentId: idSchema,
  carrierId: idSchema,
  serviceLevel: z.enum(SERVICE_LEVELS),
  /** The carrier's own tracking number; empty: the parcel keeps its number, or gets the store's waybill number. */
  trackingNo: z
    .string()
    .trim()
    .max(60, "too_long")
    .optional()
    .transform((value) => (value ? value.replace(/\s+/g, "") : undefined))
    .refine((value) => value === undefined || /^[A-Za-z0-9][A-Za-z0-9_./-]{2,59}$/.test(value), "tracking_invalid"),
  /** What the carrier charges for this parcel; default: its rate for the governorate and level. */
  costIqd: z.number().int("invalid").min(0, "too_small").max(10_000_000, "too_big").optional(),
  /** Required when a parcel already on the road changes carrier or number. */
  reason: optionalText(500),
  from: statusSchema.optional(),
});
export type WaybillInput = z.input<typeof WaybillInput>;

/** The cash a parcel collects for its order now (0 when it collects nothing). */
async function cashToCollect(db: Db, parcel: { id: string; orderId: string }): Promise<number> {
  const order = await orderOf(db, parcel.orderId);
  const [first, cod] = await Promise.all([firstParcels(db, [order.id]), codPayments(db, [order.id])]);
  const view = codViewOf({ id: order.id, paymentMethod: order.paymentMethod, paidIqd: order.paidIqd, totalIqd: order.totalIqd, status: order.status }, parcel.id, first.get(order.id), cod.get(order.id));
  return view.kind === "collect" ? view.amountIqd : 0;
}

/**
 * 11.02 / 11.03 — the parcel's waybill: carrier, service level, tracking number (typed, else the store's waybill number
 * REF-n), the carrier's charge and the cash to collect. Before pickup it can change freely; on the road a change of
 * carrier or number needs a reason. A parcel that collects cash goes only with a carrier that collects cash.
 */
export async function saveWaybill(db: Db, actor: Actor, raw: WaybillInput, now: number): Promise<{ trackingNo: string; costIqd: number | null; replayed: boolean }> {
  assertCan(actor, "shipping.shipment.create");
  const input = WaybillInput.parse(raw);
  const parcel = await parcelById(db, input.shipmentId);
  if (input.from && parcel.status !== input.from) throw new AppError("shipment_changed", 409, { detail: `${parcel.status}, expected ${input.from}` });
  const onRoad = inList(parcel.status, [...ON_ROAD]);
  if (!inList(parcel.status, AT_STORE) && !onRoad) throw new AppError("waybill_locked", 409, { detail: parcel.status });
  const order = await orderOf(db, parcel.orderId);
  const carrier = await activeCarrier(db, input.carrierId);
  const collect = await cashToCollect(db, parcel);
  if (collect > 0 && !carrier.codSupported) throw new AppError("carrier_no_cod", 409, { detail: carrier.id, fields: { carrierId: "carrier_no_cod" } });
  const number = parcelNumberOf(order.id, parcel.id) || 1;
  const trackingNo = input.trackingNo ?? parcel.trackingNo ?? parcelCode(order.ref, number);
  const costIqd = input.costIqd ?? (await carrierRate(db, carrier.id, order.governorateId, input.serviceLevel)) ?? (parcel.carrierId === carrier.id ? parcel.costIqd : null);
  const level = await serviceLevelOf(db, parcel.id);
  if (parcel.carrierId === carrier.id && parcel.trackingNo === trackingNo && parcel.costIqd === costIqd && level === input.serviceLevel && parcel.codAmountIqd === collect) return { trackingNo, costIqd, replayed: true };
  const changesRoute = parcel.carrierId !== null && (parcel.carrierId !== carrier.id || parcel.trackingNo !== trackingNo);
  if (onRoad && changesRoute && (input.reason ?? "").length < 3) throw invalid({ reason: "required" });
  const taken = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(and(eq(shipments.carrierId, carrier.id), sql`upper(${shipments.trackingNo}) = ${trackingNo.toUpperCase()}`, ne(shipments.id, parcel.id)))
    .get();
  if (taken) throw invalid({ trackingNo: "tracking_taken" });
  const { actorKind, actorId } = actorRef(actor);
  const after = { carrierId: carrier.id, carrier: carrier.name, serviceLevel: input.serviceLevel, trackingNo, costIqd, codAmountIqd: collect };
  try {
    await runBatch(db, [
      // checked again inside the batch: another parcel given the same number at the same moment (no unique index)
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM shipments WHERE carrier_id = ${carrier.id} AND upper(tracking_no) = ${trackingNo.toUpperCase()} AND id <> ${parcel.id})`, { code: "TRACKING_TAKEN", detail: parcel.id }),
      db
        .update(shipments)
        .set({ carrierId: carrier.id, trackingNo, costIqd, codAmountIqd: collect, updatedAt: now })
        .where(and(eq(shipments.id, parcel.id), eq(shipments.status, parcel.status), eq(shipments.updatedAt, parcel.updatedAt))),
      expectChanged(db, 1, { code: "SHIPMENT_CHANGED", detail: parcel.id }),
      db.insert(shipmentEvents).values({ id: newId("sev"), shipmentId: parcel.id, kind: "waybill", note: input.reason ?? null, data: after, actorKind, actorId, at: now }),
      auditStatement(db, {
        actor,
        action: "shipping.shipment.waybill",
        entityType: "shipment",
        entityId: parcel.id,
        summary: `${order.ref}: waybill ${trackingNo}`,
        before: { carrierId: parcel.carrierId, trackingNo: parcel.trackingNo, costIqd: parcel.costIqd, serviceLevel: level },
        after,
        reason: input.reason ?? null,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "TRACKING_TAKEN")) throw invalid({ trackingNo: "tracking_taken" });
    if (isDbError(error, "SHIPMENT_CHANGED")) throw new AppError("shipment_changed", 409, { detail: parcel.id, cause: error });
    throw error;
  }
  return { trackingNo, costIqd, replayed: false };
}

export const RuleInput = z.object({ shipmentIds: z.array(idSchema).min(1, "required").max(100), serviceLevel: z.enum(SERVICE_LEVELS) });
export type RuleInput = z.input<typeof RuleInput>;

/**
 * 11.02 — the rule-based choice: each parcel still at the store without a carrier gets the cheapest active carrier
 * that serves its governorate at that service level (and collects cash when the parcel does). Parcels no carrier
 * serves are left for a person, with the reason.
 */
export async function assignByRule(db: Db, actor: Actor, raw: RuleInput, now: number): Promise<{ assigned: number; skipped: { id: string; code: string; reason: string }[] }> {
  assertCan(actor, "shipping.shipment.create");
  const input = RuleInput.parse(raw);
  let assigned = 0;
  const skipped: { id: string; code: string; reason: string }[] = [];
  for (const shipmentId of [...new Set(input.shipmentIds)]) {
    const parcel = await db.select().from(shipments).where(eq(shipments.id, shipmentId)).get();
    if (!parcel) continue;
    const order = await orderOf(db, parcel.orderId);
    const code = parcelCode(order.ref, parcelNumberOf(order.id, parcel.id) || 1);
    if (!inList(parcel.status, AT_STORE)) {
      skipped.push({ id: parcel.id, code, reason: "not_at_store" });
      continue;
    }
    if (parcel.carrierId) {
      skipped.push({ id: parcel.id, code, reason: "has_carrier" });
      continue;
    }
    const collect = await cashToCollect(db, parcel);
    const best = (await carrierOptions(db, { governorateId: order.governorateId, serviceLevel: input.serviceLevel, codAmountIqd: collect })).find((option) => option.eligible);
    if (!best) {
      skipped.push({ id: parcel.id, code, reason: "no_carrier" });
      continue;
    }
    await saveWaybill(db, actor, { shipmentId: parcel.id, carrierId: best.carrierId, serviceLevel: input.serviceLevel }, now);
    assigned++;
  }
  return { assigned, skipped };
}

// ───────────────────────────────────────────────────────────────── pickup (the order ships)

export const PickupInput = z.object({ shipmentIds: z.array(idSchema).min(1, "required").max(100) });
export type PickupInput = z.input<typeof PickupInput>;

export type PickupResult = { shipped: string[]; failed: { ref: string; code: string; detail?: string }[] };

/**
 * 11.03 — the courier picks the parcels up. Every live parcel of their order needs a waybill, and a parcel with a
 * sensitive device its packing photo (11.06); then the ORDER ships through the orders module (changeOrderStatus: its
 * hold rule and the scan-verified packing of every unit, then the core's transitionOrder commits the stock) and its
 * parcels are handed over. All parcels of an order leave together (the core commits an order's stock in one step).
 */
export async function pickupParcels(db: Db, actor: Actor, raw: PickupInput, now: number): Promise<PickupResult> {
  assertCan(actor, "shipping.shipment.update");
  assertCan(actor, "orders.fulfillment.ship");
  const input = PickupInput.parse(raw);
  const picked = await db.select({ id: shipments.id, orderId: shipments.orderId }).from(shipments).where(inArray(shipments.id, [...new Set(input.shipmentIds)]));
  const orderIds = [...new Set(picked.map((row) => row.orderId))];
  const result: PickupResult = { shipped: [], failed: [] };
  for (const orderId of orderIds) {
    const order = await orderOf(db, orderId);
    try {
      const parcels = await db
        .select({ id: shipments.id, status: shipments.status, carrierId: shipments.carrierId, packingFileId: shipments.packingFileId, sensitive: sensitiveSql })
        .from(shipments)
        .where(and(eq(shipments.orderId, order.id), ne(shipments.status, "cancelled")));
      const atStore = parcels.filter((parcel) => inList(parcel.status, AT_STORE));
      if (atStore.length === 0) throw new AppError("shipment_not_at_store", 409, { detail: order.ref });
      const noWaybill = atStore.filter((parcel) => !parcel.carrierId).map((parcel) => parcelCode(order.ref, parcelNumberOf(order.id, parcel.id) || 1));
      if (noWaybill.length) throw new AppError("waybill_missing", 409, { detail: noWaybill.join(", ") });
      const undocumented = atStore.filter((parcel) => Boolean(parcel.sensitive) && !parcel.packingFileId).map((parcel) => parcelCode(order.ref, parcelNumberOf(order.id, parcel.id) || 1));
      if (undocumented.length) throw new AppError("packing_undocumented", 409, { detail: undocumented.join(", ") });
      if (order.status === "shipped") await syncParcels(db, actor, order.id, now);
      else await changeOrderStatus(db, actor, order.id, { to: "shipped", from: order.status }, now);
      // the cash to collect as the courier took it (the order cannot change any more once shipped)
      const first = (await firstParcels(db, [order.id])).get(order.id);
      const collect = first ? await cashToCollect(db, { id: first, orderId: order.id }) : 0;
      if (first) await db.update(shipments).set({ codAmountIqd: collect }).where(eq(shipments.id, first));
      result.shipped.push(order.ref);
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      if (!appError) throw error;
      result.failed.push({ ref: order.ref, code: appError.code, detail: appError.code === "waybill_missing" || appError.code === "packing_undocumented" ? appError.detail : undefined });
    }
  }
  return result;
}

// ───────────────────────────────────────────────────────────────── courier statuses (11.03 / 11.05)

export const MoveInput = z.object({
  shipmentIds: z.array(idSchema).min(1, "required").max(100),
  to: z.enum(["in_transit", "out_for_delivery", "returning"]),
  note: optionalText(500),
  /** One parcel from its page: the status the employee saw. */
  from: statusSchema.optional(),
});
export type MoveInput = z.input<typeof MoveInput>;

/**
 * Plain courier statuses (no order state behind them): in transit, out for delivery (also a retry after a failed
 * try — 11.05), on its way back. A retry and "on its way back" need shipping.attempt.manage.
 */
export async function moveParcels(db: Db, actor: Actor, raw: MoveInput, now: number): Promise<{ moved: number; skipped: string[] }> {
  assertCan(actor, "shipping.shipment.update");
  const input = MoveInput.parse(raw);
  if (input.to === "returning") assertCan(actor, "shipping.attempt.manage");
  const rows = await db
    .select({ id: shipments.id, status: shipments.status, orderId: shipments.orderId, ref: orders.ref })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(inArray(shipments.id, [...new Set(input.shipmentIds)]));
  if (rows.length === 0) throw notFound("shipment");
  if (input.from && rows.length === 1 && rows[0].status !== input.from) {
    if (rows[0].status === input.to) return { moved: 0, skipped: [] };
    throw new AppError("shipment_changed", 409, { detail: `${rows[0].status}, expected ${input.from}` });
  }
  // A retry (failed → out for delivery) needs shipping.attempt.manage: checked for the whole selection before the first
  // parcel moves, so a refused bulk move moves nothing.
  if (input.to === "out_for_delivery" && rows.some((row) => row.status === "failed")) assertCan(actor, "shipping.attempt.manage");
  const { actorKind, actorId } = actorRef(actor);
  let moved = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    const code = parcelCode(row.ref, parcelNumberOf(row.orderId, row.id) || 1);
    if (row.status === input.to) continue;
    if (!canMove(row.status, input.to as SimpleMove)) {
      skipped.push(code);
      continue;
    }
    try {
      await runBatch(db, [
        db
          .update(shipments)
          .set({ status: input.to, updatedAt: now })
          .where(and(eq(shipments.id, row.id), eq(shipments.status, row.status))),
        expectChanged(db, 1, { code: "SHIPMENT_CHANGED", detail: row.id }),
        db.insert(shipmentEvents).values({ id: newId("sev"), shipmentId: row.id, kind: row.status === "failed" && input.to === "out_for_delivery" ? "retry" : input.to, note: input.note ?? null, data: { from: row.status }, actorKind, actorId, at: now }),
        auditStatement(db, { actor, action: `shipping.shipment.${input.to}`, entityType: "shipment", entityId: row.id, summary: `${code}: ${row.status} → ${input.to}`, before: { status: row.status }, after: { status: input.to }, reason: input.note ?? null, at: now }),
      ]);
      moved++;
    } catch (error) {
      if (!isDbError(error, "SHIPMENT_CHANGED")) throw error;
      skipped.push(code);
    }
  }
  return { moved, skipped };
}

export const AttemptInput = z.object({
  shipmentId: idSchema,
  outcome: z.enum(FAILURE_OUTCOMES),
  reason: optionalText(300),
  notes: optionalText(500),
  /** The day the courier tries again (YYYY-MM-DD, Baghdad), today … +30 days. */
  nextAttemptDay: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  from: statusSchema.optional(),
});
export type AttemptInput = z.input<typeof AttemptInput>;

/** 11.05 — a try at the door that did not deliver: what happened, why, and when the next try is planned. */
export async function recordAttempt(db: Db, actor: Actor, raw: AttemptInput, now: number): Promise<{ attemptNo: number; failedAttempts: number; replayed: boolean }> {
  assertCan(actor, "shipping.attempt.manage");
  const input = AttemptInput.parse(raw);
  const parcel = await parcelById(db, input.shipmentId);
  if (input.from && parcel.status !== input.from) throw new AppError("shipment_changed", 409, { detail: `${parcel.status}, expected ${input.from}` });
  if (!inList(parcel.status, [...ON_ROAD])) throw new AppError("shipment_not_on_road", 409, { detail: parcel.status });
  if ((input.outcome === "other" || input.outcome === "damaged") && (input.reason ?? "").length < 3) throw invalid({ reason: "required" });
  let nextAttemptAt: number | null = null;
  if (input.nextAttemptDay) {
    nextAttemptAt = baghdadDay(input.nextAttemptDay);
    const today = dayOf(now);
    const last = dayOf(now + 30 * 24 * 60 * 60 * 1000);
    if (nextAttemptAt === null || input.nextAttemptDay < today || input.nextAttemptDay > last) throw invalid({ nextAttemptDay: "day_invalid" });
  }
  const order = await orderOf(db, parcel.orderId);
  const previous = await db.select({ attemptNo: deliveryAttempts.attemptNo, outcome: deliveryAttempts.outcome }).from(deliveryAttempts).where(eq(deliveryAttempts.shipmentId, parcel.id));
  const attemptNo = Math.max(0, ...previous.map((row) => row.attemptNo)) + 1;
  const failedAttempts = previous.filter((row) => row.outcome !== "delivered").length + 1;
  const { actorKind, actorId } = actorRef(actor);
  const reasonText = [input.outcome, input.reason].filter(Boolean).join(": ");
  try {
    await runBatch(db, [
      db
        .update(shipments)
        .set({ status: "failed", failureReason: reasonText.slice(0, 300), updatedAt: now })
        .where(and(eq(shipments.id, parcel.id), eq(shipments.status, parcel.status))),
      expectChanged(db, 1, { code: "SHIPMENT_CHANGED", detail: parcel.id }),
      db.insert(deliveryAttempts).values({ id: newId("dat"), shipmentId: parcel.id, attemptNo, outcome: input.outcome, reason: input.reason ?? null, notes: input.notes ?? null, nextAttemptAt, attemptedAt: now, recordedBy: actorId }),
      db.insert(shipmentEvents).values({ id: `sev_${parcel.id}_attempt_${attemptNo}`, shipmentId: parcel.id, kind: "attempt_failed", note: input.notes ?? null, data: { attemptNo, outcome: input.outcome, reason: input.reason ?? null, nextAttemptAt }, actorKind, actorId, at: now }),
      auditStatement(db, {
        actor,
        action: "shipping.attempt.record",
        entityType: "shipment",
        entityId: parcel.id,
        summary: `${order.ref}: delivery try ${attemptNo} failed (${input.outcome})`,
        before: { status: parcel.status },
        after: { status: "failed", attemptNo, outcome: input.outcome, nextAttemptAt },
        reason: input.reason ?? null,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "SHIPMENT_CHANGED") || isUniqueViolation(error)) {
      const again = await db.select({ status: shipments.status }).from(shipments).where(eq(shipments.id, parcel.id)).get();
      if (again?.status === "failed") return { attemptNo: attemptNo - 1, failedAttempts: failedAttempts - 1, replayed: true };
      throw new AppError("shipment_changed", 409, { detail: again?.status ?? "missing", cause: error });
    }
    throw error;
  }
  return { attemptNo, failedAttempts, replayed: false };
}

// ───────────────────────────────────────────────────────────────── delivered (proof of receipt, 11.06)

export const DeliverInput = z.object({
  shipmentId: idSchema,
  receivedByName: optionalText(100),
  fileId: idSchema.optional(),
  note: optionalText(500),
  from: statusSchema.optional(),
});
export type DeliverInput = z.input<typeof DeliverInput>;

/**
 * Delivered, through the core's deliverParcel (the last parcel delivers the order). A parcel with a sensitive device
 * needs the receiver's name (11.06 proof of receipt); a photo of the signed waybill is optional and private. The
 * shopper's message is held (no SMS provider), one per order (the orders module's dedupe key).
 */
export async function deliverShipment(db: Db, actor: Actor, raw: DeliverInput, now: number): Promise<{ orderDelivered: boolean; replayed: boolean }> {
  assertCan(actor, "shipping.shipment.update");
  const input = DeliverInput.parse(raw);
  const parcel = await parcelById(db, input.shipmentId);
  if (input.fileId) assertCan(actor, "shipping.proof.manage");
  const sensitive = await db.select({ value: sensitiveSql }).from(shipments).where(eq(shipments.id, parcel.id)).get();
  if (sensitive?.value && parcel.status !== "delivered" && (input.receivedByName ?? "").length < 2) throw invalid({ receivedByName: "receiver_required" });
  const result = await deliverParcel(db, actor, { shipmentId: parcel.id, receivedByName: input.receivedByName, proofFileId: input.fileId, note: input.note, from: input.from }, now);
  if (result.orderDelivered) {
    const order = await orderOf(db, parcel.orderId);
    await notifyOrderContact(db, order, ORDER_TEMPLATES.delivered, { status: "delivered", trackingNo: null }, "status:delivered", now);
  }
  return result;
}

/**
 * What deliverShipment (and the core's deliverParcel) would refuse, checked BEFORE a proof photo is stored — the route
 * calls it ahead of the upload, so a refused delivery keeps no file: the permission, a stale page, a parcel that cannot
 * be delivered from its status, an order not shipped or on hold, a sensitive device without the receiver's name.
 * Returns "replay" for a parcel already delivered (a photo then goes through "proof", not with a repeated delivery).
 */
export async function assertDeliverable(db: Db, actor: Actor, raw: { shipmentId: string; receivedByName?: string; from?: string }): Promise<"deliver" | "replay"> {
  assertCan(actor, "shipping.shipment.update");
  const parcel = await parcelById(db, raw.shipmentId);
  if (parcel.status === "delivered") return "replay";
  if (raw.from && parcel.status !== raw.from) throw new AppError("shipment_changed", 409, { detail: `${parcel.status}, expected ${raw.from}` });
  if (!inList(parcel.status, [...DELIVERABLE])) throw new AppError("shipment_not_deliverable", 409, { detail: parcel.status });
  const order = await orderOf(db, parcel.orderId);
  if (order.status !== "shipped" && order.status !== "delivered") throw new AppError("order_not_shipped", 409, { detail: order.status });
  if (order.status === "shipped" && order.reviewStatus === "blocked") throw new AppError("order_on_hold", 409, { detail: order.id });
  const sensitive = await db.select({ value: sensitiveSql }).from(shipments).where(eq(shipments.id, parcel.id)).get();
  if (sensitive?.value && (raw.receivedByName ?? "").trim().length < 2) throw invalid({ receivedByName: "receiver_required" });
  return "deliver";
}

export const DeliveryProofInput = z.object({ shipmentId: idSchema, fileId: idSchema, receivedByName: z.string().trim().min(2, "required").max(100, "too_long") });
export type DeliveryProofInput = z.input<typeof DeliveryProofInput>;

/** 11.06 — the proof of receipt of a parcel already delivered: the signed waybill's photo and the receiver's name. */
export async function addDeliveryProof(db: Db, actor: Actor, raw: DeliveryProofInput, now: number): Promise<void> {
  assertCan(actor, "shipping.proof.manage");
  const input = DeliveryProofInput.parse(raw);
  const parcel = await parcelById(db, input.shipmentId);
  if (parcel.status !== "delivered") throw new AppError("proof_not_delivered", 409, { detail: parcel.status });
  await ownFile(db, input.fileId, "delivery_proof", "order", parcel.orderId);
  const { actorKind, actorId } = actorRef(actor);
  await runBatch(db, [
    db.update(shipments).set({ proofFileId: input.fileId, receivedByName: input.receivedByName, updatedAt: now }).where(eq(shipments.id, parcel.id)),
    db.update(files).set({ ownerType: "order", ownerId: parcel.orderId }).where(eq(files.id, input.fileId)),
    db.insert(shipmentEvents).values({ id: newId("sev"), shipmentId: parcel.id, kind: "delivery_proof", note: null, data: { fileId: input.fileId, receivedByName: input.receivedByName }, actorKind, actorId, at: now }),
    auditStatement(db, { actor, action: "shipping.shipment.proof", entityType: "shipment", entityId: parcel.id, before: { proofFileId: parcel.proofFileId, receivedByName: parcel.receivedByName }, after: { proofFileId: input.fileId, receivedByName: input.receivedByName }, at: now }),
  ]);
}

/** A private upload of this kind, not owned yet or owned by this record. */
async function ownFile(db: Db, fileId: string, kind: string, ownerType: string, ownerId: string): Promise<void> {
  const file = await db.select({ id: files.id, kind: files.kind, visibility: files.visibility, ownerType: files.ownerType, ownerId: files.ownerId }).from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt))).get();
  if (!file || file.kind !== kind || file.visibility !== "private" || (file.ownerType !== null && !(file.ownerType === ownerType && file.ownerId === ownerId))) throw invalid({ file: "file_invalid" });
}

export const PackingPhotoInput = z.object({ shipmentId: idSchema, fileId: idSchema, note: optionalText(300) });
export type PackingPhotoInput = z.input<typeof PackingPhotoInput>;

/**
 * 11.06 — documented packing: a private photo of the packed parcel (seal, padding, serial label visible) taken before
 * the courier picks it up. A parcel with a sensitive device cannot be picked up without one (pickupParcels).
 */
export async function addPackingPhoto(db: Db, actor: Actor, raw: PackingPhotoInput, now: number): Promise<void> {
  assertCan(actor, "shipping.proof.manage");
  const input = PackingPhotoInput.parse(raw);
  const parcel = await parcelById(db, input.shipmentId);
  if (!inList(parcel.status, AT_STORE)) throw new AppError("packing_after_pickup", 409, { detail: parcel.status });
  await ownFile(db, input.fileId, "packing_photo", "shipment", parcel.id);
  const { actorKind, actorId } = actorRef(actor);
  await runBatch(db, [
    db.update(shipments).set({ packingFileId: input.fileId, updatedAt: now }).where(eq(shipments.id, parcel.id)),
    db.update(files).set({ ownerType: "shipment", ownerId: parcel.id }).where(eq(files.id, input.fileId)),
    db.insert(shipmentEvents).values({ id: newId("sev"), shipmentId: parcel.id, kind: "packing_photo", note: input.note ?? null, data: { fileId: input.fileId, note: input.note ?? null }, actorKind, actorId, at: now }),
    auditStatement(db, { actor, action: "shipping.shipment.packing_photo", entityType: "shipment", entityId: parcel.id, after: { fileId: input.fileId, note: input.note ?? null }, at: now }),
  ]);
}

// ───────────────────────────────────────────────────────────────── back at the store (11.05)

export const ReceiveReturnInput = z.object({
  shipmentId: idSchema,
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
  /** Per order line: back on the shelf or written off (damaged, missing). Default: every line restocked. */
  lines: z.array(z.object({ orderItemId: idSchema, disposition: z.enum(["restock", "scrap"]) })).max(200).optional(),
});
export type ReceiveReturnInput = z.input<typeof ReceiveReturnInput>;

/**
 * The parcel (with its order's other parcels) is back at the store undelivered: the order moves to `returned`
 * through the core (orders/shipments.server.ts → transitionOrder): the goods per line restocked or written off, the
 * unpaid cash-on-delivery payment cancelled, any paid payment gets a pending refund (a second person issues it).
 */
export async function receiveReturn(db: Db, actor: Actor, raw: ReceiveReturnInput, now: number): Promise<{ parcels: number; replayed: boolean }> {
  assertCan(actor, "shipping.attempt.manage");
  const input = ReceiveReturnInput.parse(raw);
  const parcel = await parcelById(db, input.shipmentId);
  const order = await orderOf(db, parcel.orderId);
  let goods: { orderItemId: string; qty: number; disposition: "restock" | "scrap" }[] | undefined;
  if (input.lines?.some((line) => line.disposition === "scrap")) {
    const lines = await db.select({ id: orderItems.id, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, order.id));
    goods = lines.map((line) => ({ orderItemId: line.id, qty: line.qty, disposition: input.lines?.find((entry) => entry.orderItemId === line.id)?.disposition ?? "restock" }));
  }
  const result = await returnParcels(db, actor, { orderId: order.id, reason: input.reason, goods }, now);
  if (!result.replayed) await notifyOrderContact(db, order, ORDER_TEMPLATES.returned, { status: "returned", trackingNo: null }, "status:returned", now);
  return result;
}

// ───────────────────────────────────────────────────────────────── printed documents

export type WaybillDoc = {
  shipmentId: string;
  code: string;
  ref: string;
  number: number;
  parcels: number;
  status: ShipmentStatus;
  orderStatus: string;
  isDemo: boolean;
  carrier: { name: string; phone: string | null } | null;
  serviceLevel: ServiceLevel | null;
  trackingNo: string | null;
  sender: { phone: string | null; address: string | null };
  recipient: { name: string | null; phone: { display: string; full: boolean } | null; governorate: string | null; district: string | null; area: string | null; address: string | null; notes: string | null };
  preferredDay: string | null;
  preferredWindow: string | null;
  cod: CodView;
  contents: { name: string; sku: string; qty: number }[];
  sensitive: boolean;
  /** False: the parcel must not be handed to a courier now (order not confirmed, cancelled, returned, delivered). */
  shippable: boolean;
};

/** Waybills of these parcels (≤ 50), in the order given — what the courier carries; no prices, no cost. */
export async function waybillDocs(db: Db, actor: Actor, shipmentIds: readonly string[], locale: Locale): Promise<WaybillDoc[]> {
  assertCan(actor, "shipping.shipment.read");
  const ids = [...new Set(shipmentIds.filter((id) => ID_PATTERN.test(id)))].slice(0, 50);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ parcel: shipments, order: orders, carrierName: carriers.name, carrierPhone: carriers.phone, sensitive: sensitiveSql })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .leftJoin(carriers, eq(carriers.id, shipments.carrierId))
    .where(inArray(shipments.id, ids));
  const orderIds = [...new Set(rows.map((row) => row.order.id))];
  const [first, cod, govs, dists, items, siblings, contact, levels] = await Promise.all([
    firstParcels(db, orderIds),
    codPayments(db, orderIds),
    db.select({ id: governorates.id, name: governorates.name }).from(governorates),
    db.select({ id: districts.id, name: districts.name }).from(districts).where(inArray(districts.governorateId, [...new Set(rows.map((row) => row.order.governorateId).filter((id): id is string => Boolean(id)))].concat(["-"]))),
    db
      .select({ shipmentId: shipmentItems.shipmentId, name: orderItems.nameSnapshot, sku: orderItems.sku, qty: shipmentItems.qty })
      .from(shipmentItems)
      .innerJoin(orderItems, eq(orderItems.id, shipmentItems.orderItemId))
      .where(inArray(shipmentItems.shipmentId, ids))
      .orderBy(asc(orderItems.id)),
    db
      .select({ orderId: shipments.orderId, n: sql<number>`count(*)` })
      .from(shipments)
      .where(and(inArray(shipments.orderId, orderIds), ne(shipments.status, "cancelled")))
      .groupBy(shipments.orderId),
    getSetting(db, "store.contact"),
    Promise.all(ids.map(async (id) => [id, await serviceLevelOf(db, id)] as const)),
  ]);
  const byId = new Map(rows.map((row) => [row.parcel.id, row]));
  return ids.flatMap((id): WaybillDoc[] => {
    const row = byId.get(id);
    if (!row) return [];
    const { parcel, order } = row;
    const number = parcelNumberOf(order.id, parcel.id) || 1;
    const phone = phoneFor(actor, order.contactPhoneE164);
    return [
      {
        shipmentId: parcel.id,
        code: parcelCode(order.ref, number),
        ref: order.ref,
        number,
        parcels: Number(siblings.find((entry) => entry.orderId === order.id)?.n ?? 1),
        status: parcel.status,
        orderStatus: order.status,
        isDemo: order.isDemo,
        carrier: row.carrierName ? { name: row.carrierName, phone: row.carrierPhone ? formatIraqPhone(row.carrierPhone) : null } : null,
        serviceLevel: levels.find(([entry]) => entry === id)?.[1] ?? null,
        trackingNo: parcel.trackingNo,
        sender: { phone: contact.phone ?? null, address: contact.address ? pick(contact.address, locale) : null },
        recipient: {
          name: order.contactName,
          phone: phone ? { display: phone.display, full: phone.full } : null,
          governorate: order.governorateId ? pickName(govs, order.governorateId, locale) : null,
          district: order.districtId ? pickName(dists, order.districtId, locale) : null,
          area: order.areaText,
          address: order.addressText,
          notes: order.notes,
        },
        preferredDay: order.preferredDay,
        preferredWindow: order.preferredWindow,
        cod: codViewOf({ id: order.id, paymentMethod: order.paymentMethod, paidIqd: order.paidIqd, totalIqd: order.totalIqd, status: order.status }, parcel.id, first.get(order.id), cod.get(order.id)),
        contents: items.filter((item) => item.shipmentId === parcel.id).map((item) => ({ name: pick(item.name, locale), sku: item.sku, qty: item.qty })),
        sensitive: Boolean(row.sensitive),
        shippable: (["confirmed", "preparing", "shipped"] as string[]).includes(order.status) && !inList(parcel.status, [...FINAL]),
      },
    ];
  });
}

export type ManifestDoc = {
  carrier: { id: string; name: string } | null;
  day: string;
  /** `shippable` false: the parcel must not be handed over (finished, its order not confirmed, cancelled or unpaid) — printed as such, no cash. */
  rows: { code: string; trackingNo: string | null; governorate: string | null; status: ShipmentStatus; shippable: boolean; collectIqd: number }[];
  /** Only the parcels the courier takes. */
  totals: { parcels: number; collectIqd: number };
};

/**
 * Pickup manifests of these parcels, one per carrier: what the courier signs for, with the cash to collect. A parcel
 * that must not be handed over (the waybill's "do not hand over") stays on the sheet, marked, outside the totals.
 */
export async function manifestDocs(db: Db, actor: Actor, shipmentIds: readonly string[], locale: Locale, now: number): Promise<ManifestDoc[]> {
  const docs = await waybillDocs(db, actor, shipmentIds, locale);
  const groups = new Map<string, ManifestDoc>();
  const carrierIds = await db
    .select({ id: shipments.id, carrierId: shipments.carrierId })
    .from(shipments)
    .where(inArray(shipments.id, docs.map((doc) => doc.shipmentId).concat(["-"])));
  for (const doc of docs) {
    const carrierId = carrierIds.find((row) => row.id === doc.shipmentId)?.carrierId ?? "none";
    const group = groups.get(carrierId) ?? { carrier: doc.carrier && carrierId !== "none" ? { id: carrierId, name: doc.carrier.name } : null, day: dayOf(now), rows: [], totals: { parcels: 0, collectIqd: 0 } };
    // the same rule as the printed waybill: a finished parcel, an order not to ship or nothing paid nor to collect
    const shippable = doc.shippable && doc.cod.kind !== "unpaid";
    const collectIqd = shippable && doc.cod.kind === "collect" ? doc.cod.amountIqd : 0;
    group.rows.push({ code: doc.code, trackingNo: doc.trackingNo, governorate: doc.recipient.governorate, status: doc.status, shippable, collectIqd });
    if (shippable) {
      group.totals.parcels += 1;
      group.totals.collectIqd += collectIqd;
    }
    groups.set(carrierId, group);
  }
  return [...groups.values()];
}

// ───────────────────────────────────────────────────────────────── the module's front page

export type ShippingOverview = {
  toPrepare: number;
  readyForPickup: number;
  undocumented: number;
  onRoad: number;
  failed: number;
  dueRetry: number;
  returning: number;
  codOutstanding: { parcels: number; amountIqd: number };
  unsettled: number;
  toReconcile: number;
  carriers: number;
};

/** What waits for a person in shipping, for the module's front page. */
export async function shippingOverview(db: Db, actor: Actor, now: number): Promise<ShippingOverview> {
  assertCan(actor, "shipping.shipment.read");
  const endOfToday = (baghdadDay(dayOf(now)) ?? now) + 18 * 60 * 60 * 1000;
  const [counts, codRow, settlementRows, carrierCount] = await Promise.all([
    db
      .select({
        toPrepare: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} IN ('pending','packed') AND ${shipments.carrierId} IS NULL THEN 1 ELSE 0 END), 0)`,
        ready: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} = 'packed' AND ${shipments.carrierId} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
        undocumented: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} IN ('pending','packed') AND ${shipments.packingFileId} IS NULL AND ${sensitiveSql} THEN 1 ELSE 0 END), 0)`,
        onRoad: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} IN ('handed_over','in_transit','out_for_delivery') THEN 1 ELSE 0 END), 0)`,
        failed: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} = 'failed' THEN 1 ELSE 0 END), 0)`,
        dueRetry: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} = 'failed' AND coalesce((SELECT da.next_attempt_at FROM delivery_attempts da WHERE da.shipment_id = "shipments"."id" ORDER BY da.attempt_no DESC LIMIT 1), 0) <= ${endOfToday} THEN 1 ELSE 0 END), 0)`,
        returning: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} = 'returning' THEN 1 ELSE 0 END), 0)`,
        unsettled: sql<number>`coalesce(sum(CASE WHEN ${shipments.status} IN ('delivered','returned') AND ${shipments.carrierId} IS NOT NULL AND ${shipments.codSettledAt} IS NULL AND NOT EXISTS (SELECT 1 FROM cod_settlement_items i WHERE i.shipment_id = "shipments"."id") THEN 1 ELSE 0 END), 0)`,
      })
      .from(shipments)
      .get(),
    db
      .select({ parcels: sql<number>`count(*)`, amountIqd: sql<number>`coalesce(sum(${payments.amountIqd}), 0)` })
      .from(shipments)
      .innerJoin(payments, and(eq(payments.orderId, shipments.orderId), eq(payments.method, "cod"), eq(payments.status, "pending")))
      .where(
        and(
          eq(shipments.status, "delivered"),
          isNotNull(shipments.carrierId),
          sql`NOT EXISTS (SELECT 1 FROM cod_settlement_items i WHERE i.shipment_id = ${shipments.id})`,
          sql`${shipments.id} = (SELECT s2.id FROM shipments s2 WHERE s2.order_id = ${shipments.orderId} AND s2.status <> 'cancelled' ORDER BY s2.created_at, s2.id LIMIT 1)`,
        ),
      )
      .get(),
    can(actor, "shipping.cod.settle")
      ? db.select({ id: codSettlements.id, varianceIqd: codSettlements.varianceIqd, createdBy: codSettlements.createdBy }).from(codSettlements).where(eq(codSettlements.status, "submitted"))
      : Promise.resolve([] as { id: string; varianceIqd: number; createdBy: string | null }[]),
    db.select({ n: sql<number>`count(*)` }).from(carriers).where(eq(carriers.isActive, true)).get(),
  ]);
  // Only what this employee may decide: a settlement with a difference (a variance or a hand correction) is never theirs
  // to reconcile when they prepared, corrected or submitted it (the two-person rule of reconcileCodSettlement).
  const { actorId } = actorRef(actor);
  let toReconcile = 0;
  for (const row of settlementRows) {
    const rule = settlementNeedsSecondPerson(row, await settlementPreparers(db, row.id), actorId);
    if (rule.needsSecond && rule.involved) continue;
    toReconcile++;
  }
  return {
    toPrepare: Number(counts?.toPrepare ?? 0),
    readyForPickup: Number(counts?.ready ?? 0),
    undocumented: Number(counts?.undocumented ?? 0),
    onRoad: Number(counts?.onRoad ?? 0),
    failed: Number(counts?.failed ?? 0),
    dueRetry: Number(counts?.dueRetry ?? 0),
    returning: Number(counts?.returning ?? 0),
    codOutstanding: { parcels: Number(codRow?.parcels ?? 0), amountIqd: Number(codRow?.amountIqd ?? 0) },
    unsettled: Number(counts?.unsettled ?? 0),
    toReconcile,
    carriers: Number(carrierCount?.n ?? 0),
  };
}

export type QueueRow = {
  id: string;
  code: string;
  ref: string;
  status: ShipmentStatus;
  orderStatus: string;
  carrier: string | null;
  trackingNo: string | null;
  recipient: { name: string | null; phone: { display: string; full: boolean; e164?: string } | null; governorate: string | null };
  cod: CodView;
  attempts: { attemptNo: number; outcome: string; reason: string | null; nextAttemptAt: number | null; attemptedAt: number }[];
  failureReason: string | null;
  updatedAt: number;
  isDemo: boolean;
};

/** Failed tries and parcels on their way back (11.05), the oldest decision first — the mobile-first queue. */
export async function attemptsQueue(db: Db, actor: Actor, locale: Locale): Promise<QueueRow[]> {
  assertCan(actor, "shipping.shipment.read");
  const rows = await db
    .select({ parcel: shipments, order: orders, carrierName: carriers.name })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .leftJoin(carriers, eq(carriers.id, shipments.carrierId))
    .where(inArray(shipments.status, ["failed", "returning"]))
    .orderBy(asc(shipments.updatedAt), asc(shipments.id))
    .limit(100);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.parcel.id);
  const orderIds = [...new Set(rows.map((row) => row.order.id))];
  const [attempts, first, cod, govs] = await Promise.all([
    db.select().from(deliveryAttempts).where(inArray(deliveryAttempts.shipmentId, ids)).orderBy(asc(deliveryAttempts.attemptNo)),
    firstParcels(db, orderIds),
    codPayments(db, orderIds),
    db.select({ id: governorates.id, name: governorates.name }).from(governorates),
  ]);
  return rows.map(({ parcel, order, carrierName }) => ({
    id: parcel.id,
    code: parcelCode(order.ref, parcelNumberOf(order.id, parcel.id) || 1),
    ref: order.ref,
    status: parcel.status,
    orderStatus: order.status,
    carrier: carrierName ?? null,
    trackingNo: parcel.trackingNo,
    recipient: { name: order.contactName, phone: phoneFor(actor, order.contactPhoneE164), governorate: order.governorateId ? pickName(govs, order.governorateId, locale) : null },
    cod: codViewOf({ id: order.id, paymentMethod: order.paymentMethod, paidIqd: order.paidIqd, totalIqd: order.totalIqd, status: order.status }, parcel.id, first.get(order.id), cod.get(order.id)),
    attempts: attempts
      .filter((attempt) => attempt.shipmentId === parcel.id && attempt.outcome !== "delivered")
      .map((attempt) => ({ attemptNo: attempt.attemptNo, outcome: attempt.outcome, reason: attempt.reason, nextAttemptAt: attempt.nextAttemptAt, attemptedAt: attempt.attemptedAt })),
    failureReason: parcel.failureReason,
    updatedAt: parcel.updatedAt,
    isDemo: order.isDemo,
  }));
}

/**
 * Failed deliveries waiting for a person's decision — try again or send the parcel back: the raised cards of the
 * attempts page (attemptsQueue's failed parcels; those already on their way back wait for the goods, not a decision).
 * Counted for the admin shell's queue (shell/queues.server.ts), so one count. Null unless the employee may decide them
 * (shipping.attempt.manage) and open that page (shipping.shipment.read).
 */
export async function countFailedDeliveries(db: Db, actor: Actor): Promise<number | null> {
  if (!can(actor, "shipping.attempt.manage") || !can(actor, "shipping.shipment.read")) return null;
  const row = await db.select({ n: sql<number>`count(*)` }).from(shipments).where(eq(shipments.status, "failed")).get();
  return Number(row?.n ?? 0);
}

export { syncParcels };
