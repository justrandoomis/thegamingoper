/**
 * Fulfilment — 05.03 (assign a packer, task list, serial scan before handover), 04.11 (pick → pack → ship with
 * scanning that verifies the right item and serial) and 05.04 (parcels).
 *
 *   await assignOrder(db, actor, orderId, { employeeId }, now);                      orders.order.assign
 *   const view = await getPackView(db, actor, ref, locale, now);                       orders.fulfillment.pack
 *   const result = await scanCode(db, actor, orderId, { code, scanId }, now);          orders.fulfillment.pack
 *   await manualVerify(db, actor, orderId, { orderItemId, reason, scanId }, now);      orders.fulfillment.pack
 *   await splitParcel(db, actor, orderId, { lines: [{ orderItemId, qty }] }, now);     orders.fulfillment.pack
 *   await markPacked(db, actor, orderId, now);                                         orders.fulfillment.pack
 *   await recordDeliveryProof(db, actor, orderId, { fileId, receivedByName }, now);   orders.fulfillment.deliver | shipping.proof.manage
 *
 * HOW A SCAN IS JUDGED (a barcode / QR scanner is a keyboard: it types the code into the focused field and presses
 * Enter — no driver, no integration):
 *   1. a SERIAL number of a serial-tracked unit → attached to the matching line with the core's assignSerialsStatements
 *      (sold once, right variant, not held for another order or a trade-in device — the database refuses otherwise).
 *      A used device's line takes only THAT unit's serial: new stock of the same model shares its variant, and the
 *      core would accept a new unit's serial there (the shopper paid a used price)
 *   2. a SKU or a variant BARCODE of a line without serials → one unit of that line verified
 *      (a serial-tracked item cannot be verified by its barcode: "scan the serial number"). Units are counted per
 *      item: a bundle is verified component by component, so scanning one component again is refused once the
 *      bundle holds its number of it ("line_complete") and never stands in for another component
 *   3. anything else → refused as "not in this order", and the refused scan is written down too
 * Each accepted or refused scan is a shipment event (append-only) of the order's parcel; a scan carries a client
 * `scanId`, so the same scan sent twice (a double Enter, a retry) counts once.
 *
 * PARCELS (05.04): the first scan creates parcel 1 holding every line; staff can move units into further parcels
 * (each with its own packing slip and label). All parcels of an order leave together: the commerce core commits an
 * order's stock in one step (transitionOrder → shipped), so shipping part of an order ahead of the rest needs a partial
 * commit in the core (requested; 05.04 is partial).
 *
 * SHIP: shipOrder (in ./actions.server) requires every line verified here, then calls transitionOrder.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  bundleItems,
  carriers,
  files,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  serials,
  shipmentEvents,
  shipmentItems,
  shipments,
  staffTasks,
  usedUnits,
  variants,
  type Order,
} from "~/server/db/schema";
import { batchSql, expectChanged, isDbError, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid } from "~/server/errors";
import { assignSerialsStatements } from "~/server/services/inventory/stock.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { employeeNames, orderById, orderByRef, packers } from "./shared.server";
import { PACKABLE_STATUSES, type EmployeeRef, type ParcelView } from "./types";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
const scanIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "invalid");

/** Parcel ids are deterministic per order and number, so two first scans at once create ONE parcel 1. */
export const parcelId = (orderId: string, number: number) => `shp_${orderId}_${number}`;
const parcelNumber = (orderId: string, shipmentId: string) => {
  const match = new RegExp(`^shp_${orderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)$`).exec(shipmentId);
  return match ? Number(match[1]) : 0;
};

// ───────────────────────────────────────────────────────────────── progress

export type LineProgress = {
  orderItemId: string;
  variantId: string;
  usedUnitId: string | null;
  sku: string;
  barcode: string | null;
  name: string;
  qty: number;
  /** Units that must be verified by their serial number (serial-tracked parts, used devices with a serial). */
  serialUnits: number;
  /** Units verified by a barcode / SKU scan (or confirmed by hand with a reason). */
  scanUnits: number;
  serialsScanned: { id: string; serial: string }[];
  scanned: number;
  /** Serial-tracked variants of this line (the line's own, or its bundle's components). */
  trackedVariantIds: string[];
  /** A used device's line: the serial of THAT unit, the only one it takes (new stock shares the variant). */
  usedSerialId: string | null;
  /** Variants whose barcode / SKU verifies a unit of this line. */
  scanVariantIds: string[];
  /**
   * Per variant verified by barcode / SKU: the units this line needs of it and how many are verified. A bundle is
   * verified component by component — scanning one component again never stands in for another.
   */
  scanNeeds: { variantId: string; units: number; scanned: number }[];
  complete: boolean;
};

export type PackProgress = { lines: LineProgress[]; complete: boolean; started: boolean };

/** What has been verified of each line of an order (serials attached + scans recorded). */
export async function packProgress(db: Db, orderId: string, locale: Locale = "ar"): Promise<PackProgress> {
  const items = await db
    .select({
      id: orderItems.id,
      variantId: orderItems.variantId,
      usedUnitId: orderItems.usedUnitId,
      sku: orderItems.sku,
      name: orderItems.nameSnapshot,
      qty: orderItems.qty,
      barcode: variants.barcode,
      trackSerials: variants.trackSerials,
    })
    .from(orderItems)
    .innerJoin(variants, eq(variants.id, orderItems.variantId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  if (items.length === 0) return { lines: [], complete: false, started: false };
  const itemIds = items.map((item) => item.id);
  const variantIds = [...new Set(items.map((item) => item.variantId))];
  const usedIds = items.flatMap((item) => (item.usedUnitId ? [item.usedUnitId] : []));
  const [components, attached, scans, used] = await Promise.all([
    db
      .select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty, tracked: variants.trackSerials })
      .from(bundleItems)
      .innerJoin(variants, eq(variants.id, bundleItems.componentVariantId))
      .where(inArray(bundleItems.bundleVariantId, variantIds)),
    db
      .select({ orderItemId: orderItemSerials.orderItemId, serialId: serials.id, serial: serials.serial })
      .from(orderItemSerials)
      .innerJoin(serials, eq(serials.id, orderItemSerials.serialId))
      .where(and(inArray(orderItemSerials.orderItemId, itemIds), isNull(orderItemSerials.releasedAt))),
    db
      .select({ data: shipmentEvents.data, kind: shipmentEvents.kind })
      .from(shipmentEvents)
      .innerJoin(shipments, eq(shipments.id, shipmentEvents.shipmentId))
      .where(and(eq(shipments.orderId, orderId), inArray(shipmentEvents.kind, ["scan", "scan_manual"]))),
    usedIds.length ? db.select({ id: usedUnits.id, serialId: usedUnits.serialId }).from(usedUnits).where(inArray(usedUnits.id, usedIds)) : Promise.resolve([]),
  ]);
  const usedSerial = new Map(used.map((row) => [row.id, row.serialId]));
  // Units verified per line: by the variant a scan matched, and "loose" units without one (confirmed by hand, or
  // scans recorded before the variant was written down) that fill whatever the line still misses.
  const scanCount = new Map<string, Map<string, number>>();
  const looseCount = new Map<string, number>();
  for (const scan of scans) {
    const itemId = typeof scan.data?.orderItemId === "string" ? scan.data.orderItemId : null;
    if (!itemId || scan.data?.serialId) continue;
    const units = typeof scan.data?.units === "number" && scan.data.units > 0 ? scan.data.units : 1;
    const variantId = scan.kind === "scan" && typeof scan.data?.variantId === "string" ? scan.data.variantId : null;
    if (variantId) {
      const perVariant = scanCount.get(itemId) ?? new Map<string, number>();
      perVariant.set(variantId, (perVariant.get(variantId) ?? 0) + units);
      scanCount.set(itemId, perVariant);
    } else looseCount.set(itemId, (looseCount.get(itemId) ?? 0) + units);
  }

  const lines: LineProgress[] = items.map((item) => {
    const parts = components.filter((row) => row.bundleId === item.variantId);
    let serialUnits = 0;
    const trackedVariantIds: string[] = [];
    const needs = new Map<string, number>();
    const need = (variantId: string, units: number) => needs.set(variantId, (needs.get(variantId) ?? 0) + units);
    if (item.usedUnitId) {
      if (usedSerial.get(item.usedUnitId)) {
        serialUnits = 1;
        trackedVariantIds.push(item.variantId);
      } else need(item.variantId, 1);
    } else if (parts.length > 0) {
      for (const part of parts) {
        if (part.tracked) {
          serialUnits += part.qty * item.qty;
          trackedVariantIds.push(part.componentId);
        } else need(part.componentId, part.qty * item.qty);
      }
    } else if (item.trackSerials) {
      serialUnits = item.qty;
      trackedVariantIds.push(item.variantId);
    } else need(item.variantId, item.qty);
    const perVariant = scanCount.get(item.id);
    let loose = looseCount.get(item.id) ?? 0;
    const scanNeeds = [...needs].map(([variantId, units]) => {
      const direct = perVariant?.get(variantId) ?? 0;
      // a scan recorded under a variant this line does not need (older data) still counts, as a loose unit
      return { variantId, units, scanned: Math.min(direct, units) };
    });
    for (const [variantId, count] of perVariant ?? []) if (!needs.has(variantId)) loose += count;
    for (const entry of scanNeeds) {
      const take = Math.min(loose, entry.units - entry.scanned);
      entry.scanned += take;
      loose -= take;
    }
    const scanUnits = scanNeeds.reduce((sum, entry) => sum + entry.units, 0);
    const scanVariantIds = scanNeeds.map((entry) => entry.variantId);
    const lineSerials = attached.filter((row) => row.orderItemId === item.id).map((row) => ({ id: row.serialId, serial: row.serial }));
    const scanned = scanNeeds.reduce((sum, entry) => sum + entry.scanned, 0);
    return {
      orderItemId: item.id,
      variantId: item.variantId,
      usedUnitId: item.usedUnitId,
      sku: item.sku,
      barcode: item.barcode,
      name: pick(item.name, locale),
      qty: item.qty,
      serialUnits,
      scanUnits,
      serialsScanned: lineSerials,
      scanned,
      trackedVariantIds,
      usedSerialId: item.usedUnitId ? (usedSerial.get(item.usedUnitId) ?? null) : null,
      scanVariantIds,
      scanNeeds,
      complete: lineSerials.length >= serialUnits && scanned >= scanUnits,
    };
  });
  return { lines, complete: lines.every((line) => line.complete), started: scans.length > 0 || attached.length > 0 };
}

// ───────────────────────────────────────────────────────────────── parcels

/** Statements that create parcel 1 (if missing) and put every unit no parcel holds yet into it. Idempotent. */
async function defaultParcelStatements(db: Db, order: Order, actor: Actor, now: number): Promise<BatchStatement[]> {
  const id = parcelId(order.id, 1);
  const { actorId } = actorRef(actor);
  return [
    batchSql(
      db,
      sql`INSERT INTO shipments (id, order_id, status, cod_amount_iqd, created_by, created_at, updated_at)
        VALUES (${id}, ${order.id}, 'pending', 0, ${actorId}, ${now}, ${now}) ON CONFLICT(id) DO NOTHING`,
    ),
    // Every line's units that are not in any parcel go to parcel 1.
    batchSql(
      db,
      sql`INSERT INTO shipment_items (shipment_id, order_item_id, qty)
        SELECT ${id}, oi.id, oi.qty - coalesce((SELECT sum(si.qty) FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
                                                WHERE si.order_item_id = oi.id AND s.order_id = ${order.id} AND s.status <> 'cancelled'), 0)
        FROM order_items oi
        WHERE oi.order_id = ${order.id}
          AND oi.qty - coalesce((SELECT sum(si.qty) FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
                                 WHERE si.order_item_id = oi.id AND s.order_id = ${order.id} AND s.status <> 'cancelled'), 0) > 0
        ON CONFLICT(shipment_id, order_item_id) DO UPDATE SET qty = shipment_items.qty + excluded.qty`,
    ),
  ];
}

export async function parcelsOf(db: Db, orderId: string, locale: Locale, proofUrl: (fileId: string) => string): Promise<ParcelView[]> {
  const rows = await db
    .select({
      id: shipments.id,
      status: shipments.status,
      trackingNo: shipments.trackingNo,
      carrier: carriers.name,
      packedBy: shipments.packedBy,
      shippedAt: shipments.shippedAt,
      deliveredAt: shipments.deliveredAt,
      receivedByName: shipments.receivedByName,
      proofFileId: shipments.proofFileId,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .leftJoin(carriers, eq(carriers.id, shipments.carrierId))
    .where(eq(shipments.orderId, orderId))
    .orderBy(asc(shipments.createdAt), asc(shipments.id));
  if (rows.length === 0) return [];
  const items = await db
    .select({ shipmentId: shipmentItems.shipmentId, orderItemId: shipmentItems.orderItemId, qty: shipmentItems.qty, verifiedAt: shipmentItems.verifiedAt, name: orderItems.nameSnapshot, sku: orderItems.sku })
    .from(shipmentItems)
    .innerJoin(orderItems, eq(orderItems.id, shipmentItems.orderItemId))
    .where(
      inArray(
        shipmentItems.shipmentId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(orderItems.id));
  const names = await employeeNames(
    db,
    rows.map((row) => row.packedBy),
  );
  return rows.map((row, index) => ({
    id: row.id,
    number: parcelNumber(orderId, row.id) || index + 1,
    status: row.status,
    trackingNo: row.trackingNo,
    carrier: row.carrier ?? null,
    packedBy: row.packedBy ? (names.get(row.packedBy) ?? row.packedBy) : null,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
    receivedByName: row.receivedByName,
    proofUrl: row.proofFileId ? proofUrl(row.proofFileId) : null,
    items: items.filter((item) => item.shipmentId === row.id).map((item) => ({ orderItemId: item.orderItemId, name: pick(item.name, locale), sku: item.sku, qty: item.qty, verifiedAt: item.verifiedAt })),
  }));
}

// ───────────────────────────────────────────────────────────────── the fulfilment queue (05.03)

export type FulfillmentRow = {
  id: string;
  ref: string;
  status: string;
  placedAt: number;
  confirmedAt: number | null;
  units: number;
  serialUnits: number;
  assignedTo: EmployeeRef | null;
  onHold: boolean;
  isDemo: boolean;
  governorate: string | null;
  packed: boolean;
};

/** Orders to pick and pack: confirmed or being prepared, split into mine / nobody's / someone else's. Oldest first. */
export async function listFulfillment(db: Db, actor: Actor, locale: Locale): Promise<{ mine: FulfillmentRow[]; unassigned: FulfillmentRow[]; others: FulfillmentRow[]; packers: EmployeeRef[] | null }> {
  if (!can(actor, "orders.fulfillment.pack") && !can(actor, "orders.order.assign")) throw forbidden("orders.fulfillment.pack");
  const rows = await db
    .select({
      id: orders.id,
      ref: orders.ref,
      status: orders.status,
      placedAt: orders.placedAt,
      confirmedAt: orders.confirmedAt,
      assignedTo: orders.assignedTo,
      reviewStatus: orders.reviewStatus,
      isDemo: orders.isDemo,
      governorate: sql<string | null>`(SELECT json_extract(g.name, ${`$.${locale}`}) FROM governorates g WHERE g.id = "orders"."governorate_id")`,
      governorateAr: sql<string | null>`(SELECT json_extract(g.name, '$.ar') FROM governorates g WHERE g.id = "orders"."governorate_id")`,
      units: sql<number>`(SELECT coalesce(sum(oi.qty), 0) FROM order_items oi WHERE oi.order_id = "orders"."id")`,
      serialUnits: sql<number>`(SELECT coalesce(sum(oi.qty), 0) FROM order_items oi JOIN variants v ON v.id = oi.variant_id WHERE oi.order_id = "orders"."id" AND v.track_serials = 1)`,
      packed: sql<number>`EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = "orders"."id" AND s.status = 'packed')`,
    })
    .from(orders)
    .where(inArray(orders.status, [...PACKABLE_STATUSES]))
    .orderBy(asc(sql`coalesce(${orders.confirmedAt}, ${orders.placedAt})`), asc(orders.id))
    .limit(300);
  const names = await employeeNames(
    db,
    rows.map((row) => row.assignedTo),
  );
  const me = actor.kind === "employee" ? actor.id : null;
  const out = { mine: [] as FulfillmentRow[], unassigned: [] as FulfillmentRow[], others: [] as FulfillmentRow[] };
  for (const row of rows) {
    const entry: FulfillmentRow = {
      id: row.id,
      ref: row.ref,
      status: row.status,
      placedAt: row.placedAt,
      confirmedAt: row.confirmedAt,
      units: Number(row.units),
      serialUnits: Number(row.serialUnits),
      assignedTo: row.assignedTo ? { id: row.assignedTo, name: names.get(row.assignedTo) ?? row.assignedTo } : null,
      onHold: row.reviewStatus === "blocked",
      isDemo: row.isDemo,
      governorate: row.governorate ?? row.governorateAr,
      packed: Boolean(Number(row.packed)),
    };
    if (!row.assignedTo) out.unassigned.push(entry);
    else if (row.assignedTo === me) out.mine.push(entry);
    else out.others.push(entry);
  }
  return { ...out, packers: can(actor, "orders.order.assign") ? await packers(db) : null };
}

export const AssignInput = z.object({ employeeId: z.union([z.literal(""), idSchema]).nullish().transform((value) => value || null) });
export type AssignInput = z.input<typeof AssignInput>;

const ASSIGNABLE = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing"] as const;

/**
 * Gives the order to a packer (or takes it back: employeeId null) with a task in their list (`staff_tasks`, ref
 * order). A reassignment cancels the previous open task. The packer must be active and allowed to pack.
 */
export async function assignOrder(db: Db, actor: Actor, orderId: string, raw: AssignInput, now: number): Promise<{ assignedTo: string | null; replayed: boolean }> {
  assertCan(actor, "orders.order.assign");
  const input = AssignInput.parse(raw);
  const order = await orderById(db, orderId);
  if (!(ASSIGNABLE as readonly string[]).includes(order.status)) throw new AppError("assign_not_open", 409, { detail: order.status });
  if (order.assignedTo === input.employeeId) return { assignedTo: order.assignedTo, replayed: true };
  if (input.employeeId) {
    const allowed = (await packers(db)).some((employee) => employee.id === input.employeeId);
    if (!allowed) throw invalid({ employeeId: "assignee_not_packer" });
  }
  const { actorKind, actorId } = actorRef(actor);
  const statements: BatchStatement[] = [
    db
      .update(orders)
      .set({ assignedTo: input.employeeId, updatedAt: now })
      .where(and(eq(orders.id, order.id), order.assignedTo === null ? isNull(orders.assignedTo) : eq(orders.assignedTo, order.assignedTo))),
    expectChanged(db, 1, { code: "ORDER_CHANGED", detail: order.id }),
    db
      .update(staffTasks)
      .set({ status: "cancelled", completedAt: now })
      .where(and(eq(staffTasks.refType, "order"), eq(staffTasks.refId, order.id), inArray(staffTasks.status, ["open", "in_progress"]))),
  ];
  if (input.employeeId) {
    statements.push(
      db.insert(staffTasks).values({
        id: newId("tsk"),
        title: `جهّز الطلب ${order.ref}`,
        description: "pick-pack-ship",
        assignedTo: input.employeeId,
        priority: "normal",
        status: "open",
        refType: "order",
        refId: order.id,
        createdBy: actorId,
        createdAt: now,
      }),
    );
  }
  statements.push(
    db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "assigned", data: { from: order.assignedTo, to: input.employeeId }, actorKind, actorId, at: now }),
    auditStatement(db, { actor, action: "orders.order.assign", entityType: "order", entityId: order.id, summary: `${order.ref}: assigned`, before: { assignedTo: order.assignedTo }, after: { assignedTo: input.employeeId }, at: now }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "ORDER_CHANGED")) throw new AppError("order_changed", 409, { detail: order.id, cause: error });
    throw error;
  }
  return { assignedTo: input.employeeId, replayed: false };
}

/** Marks the order's open tasks done (after it ships) or cancelled (after a cancellation). */
export function closeTasksStatement(db: Db, orderId: string, status: "done" | "cancelled", now: number): BatchStatement {
  return db
    .update(staffTasks)
    .set({ status, completedAt: now })
    .where(and(eq(staffTasks.refType, "order"), eq(staffTasks.refId, orderId), inArray(staffTasks.status, ["open", "in_progress"])));
}

// ───────────────────────────────────────────────────────────────── packing view

export type PackView = {
  id: string;
  ref: string;
  status: string;
  onHold: boolean;
  isDemo: boolean;
  assignedTo: EmployeeRef | null;
  progress: PackProgress;
  parcels: ParcelView[];
  canShip: boolean;
  canAssign: boolean;
  packers: EmployeeRef[] | null;
  /** Refused scans of this order (the trail of wrong items), newest first. */
  rejected: { code: string; at: number; reason: string }[];
};

export async function getPackView(db: Db, actor: Actor, ref: string, locale: Locale, proofUrl: (fileId: string) => string): Promise<PackView> {
  assertCan(actor, "orders.fulfillment.pack");
  const order = await orderByRef(db, ref);
  const [progress, parcels, rejectedRows, names] = await Promise.all([
    packProgress(db, order.id, locale),
    parcelsOf(db, order.id, locale, proofUrl),
    db
      .select({ data: shipmentEvents.data, at: shipmentEvents.at })
      .from(shipmentEvents)
      .innerJoin(shipments, eq(shipments.id, shipmentEvents.shipmentId))
      .where(and(eq(shipments.orderId, order.id), eq(shipmentEvents.kind, "scan_rejected")))
      .orderBy(sql`${shipmentEvents.at} DESC`)
      .limit(10),
    employeeNames(db, [order.assignedTo]),
  ]);
  return {
    id: order.id,
    ref: order.ref,
    status: order.status,
    onHold: order.reviewStatus === "blocked",
    isDemo: order.isDemo,
    assignedTo: order.assignedTo ? { id: order.assignedTo, name: names.get(order.assignedTo) ?? order.assignedTo } : null,
    progress,
    parcels,
    canShip: can(actor, "orders.fulfillment.ship"),
    canAssign: can(actor, "orders.order.assign"),
    packers: can(actor, "orders.order.assign") ? await packers(db) : null,
    rejected: rejectedRows.map((row) => ({ code: String(row.data?.code ?? ""), at: row.at, reason: String(row.data?.reason ?? "not_in_order") })),
  };
}

// ───────────────────────────────────────────────────────────────── scanning

export const ScanInput = z.object({
  code: z.string().trim().min(1, "required").max(120, "too_long"),
  /** One per scan, generated by the page: the same scan sent twice counts once. */
  scanId: scanIdSchema,
});
export type ScanInput = z.input<typeof ScanInput>;

export type ScanOutcome =
  | { ok: true; kind: "serial"; orderItemId: string; serial: string; scanned: number; expected: number; replayed: boolean }
  | { ok: true; kind: "unit"; orderItemId: string; scanned: number; expected: number; replayed: boolean }
  | { ok: true; kind: "already"; orderItemId: string; serial: string }
  | { ok: false; code: "not_in_order" | "scan_serial_instead" | "line_complete" | "serial_not_available" | "serial_wrong_item"; orderItemId?: string };

const SCAN_STATUSES: readonly string[] = PACKABLE_STATUSES;

async function packableOrder(db: Db, actor: Actor, orderId: string, now: number): Promise<Order> {
  let order = await orderById(db, orderId);
  if (!SCAN_STATUSES.includes(order.status)) throw new AppError("pack_not_open", 409, { detail: order.status });
  if (order.reviewStatus === "blocked") throw new AppError("order_on_hold", 409, { detail: order.id });
  // Starting to pick moves a confirmed order to "preparing" (the core's transition, same permission).
  if (order.status === "confirmed") {
    await transitionOrder(db, actor, order.id, "preparing", { from: "confirmed" }, now);
    order = await orderById(db, orderId);
  }
  return order;
}

/** The event id of a scan: one per (order, scanId), so a repeat is a no-op. */
async function scanEventId(orderId: string, scanId: string): Promise<string> {
  return `sev_${(await sha256Hex(`${orderId}|${scanId}`)).slice(0, 32)}`;
}

/** Records one scan at the packing station (file header). */
export async function scanCode(db: Db, actor: Actor, orderId: string, raw: ScanInput, now: number): Promise<ScanOutcome> {
  assertCan(actor, "orders.fulfillment.pack");
  const input = ScanInput.parse(raw);
  const eventId = await scanEventId(orderId, input.scanId);
  const seen = await db.select({ data: shipmentEvents.data, kind: shipmentEvents.kind }).from(shipmentEvents).where(eq(shipmentEvents.id, eventId)).get();
  if (seen) {
    const itemId = String(seen.data?.orderItemId ?? "");
    if (seen.kind === "scan_rejected") return { ok: false, code: (seen.data?.reason as "not_in_order") ?? "not_in_order" };
    return seen.data?.serial
      ? { ok: true, kind: "serial", orderItemId: itemId, serial: String(seen.data.serial), scanned: 0, expected: 0, replayed: true }
      : { ok: true, kind: "unit", orderItemId: itemId, scanned: 0, expected: 0, replayed: true };
  }

  const order = await packableOrder(db, actor, orderId, now);
  const progress = await packProgress(db, order.id);
  const code = input.code;
  const parcel = parcelId(order.id, 1);
  const { actorKind, actorId } = actorRef(actor);
  const parcelStatements = await defaultParcelStatements(db, order, actor, now);
  const event = (kind: string, data: Record<string, unknown>) => db.insert(shipmentEvents).values({ id: eventId, shipmentId: parcel, kind, data, actorKind, actorId, at: now });
  const refuse = async (reason: Exclude<ScanOutcome, { ok: true }>["code"], orderItemId?: string): Promise<ScanOutcome> => {
    try {
      await runBatch(db, [...parcelStatements, event("scan_rejected", { code: code.slice(0, 120), reason, orderItemId: orderItemId ?? null })]);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return { ok: false, code: reason, orderItemId };
  };

  // 1. a serial number
  const serial = await db.select({ id: serials.id, serial: serials.serial, variantId: serials.variantId, status: serials.status }).from(serials).where(sql`upper(${serials.serial}) = upper(${code})`).get();
  if (serial) {
    const mine = progress.lines.find((line) => line.serialsScanned.some((entry) => entry.id === serial.id));
    if (mine) return { ok: true, kind: "already", orderItemId: mine.orderItemId, serial: serial.serial };
    // A used device's line takes its own unit only (a new unit of the same model shares the variant, and the core's
    // serial statement would accept it); the unit's serial goes to its line, never to a new-stock line.
    const own = progress.lines.find((line) => line.usedSerialId === serial.id);
    const candidates = own ? [own] : progress.lines.filter((line) => line.usedUnitId === null && line.trackedVariantIds.includes(serial.variantId));
    if (candidates.length === 0) return refuse("serial_wrong_item");
    const line = candidates.find((entry) => entry.serialsScanned.length < entry.serialUnits);
    if (!line) return refuse("line_complete", candidates[0]?.orderItemId);
    const scanned = line.serialsScanned.length + 1;
    const statements: BatchStatement[] = [
      ...parcelStatements,
      ...assignSerialsStatements(db, { orderItemId: line.orderItemId, serialIds: [serial.id], actor, now }),
      event("scan", { orderItemId: line.orderItemId, serialId: serial.id, serial: serial.serial, code: code.slice(0, 120) }),
      db
        .update(shipmentItems)
        .set({ pickedBy: actorId, pickedAt: now, ...(scanned >= line.serialUnits && line.scanned >= line.scanUnits ? { verifiedAt: now } : {}) })
        .where(and(eq(shipmentItems.orderItemId, line.orderItemId), sql`${shipmentItems.shipmentId} IN (SELECT id FROM shipments WHERE order_id = ${order.id})`)),
      db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "serial_scanned", data: { orderItemId: line.orderItemId, serial: serial.serial }, actorKind, actorId, at: now }),
    ];
    try {
      await runBatch(db, statements);
    } catch (error) {
      if (isUniqueViolation(error, "shipment_events.id")) return { ok: true, kind: "serial", orderItemId: line.orderItemId, serial: serial.serial, scanned, expected: line.serialUnits, replayed: true };
      const info = mapDbError(error);
      if (info?.code === "SERIAL_NOT_AVAILABLE" || info?.kind === "unique") return refuse("serial_not_available", line.orderItemId);
      if (info?.code === "SERIAL_COUNT_EXCEEDS_QTY") return refuse("line_complete", line.orderItemId);
      throw error;
    }
    return { ok: true, kind: "serial", orderItemId: line.orderItemId, serial: serial.serial, scanned, expected: line.serialUnits, replayed: false };
  }

  // 2. a SKU or a barcode
  const variant = await db
    .select({ id: variants.id, trackSerials: variants.trackSerials })
    .from(variants)
    .where(sql`upper(${variants.sku}) = upper(${code}) OR ${variants.barcode} = ${code}`)
    .all();
  const variantIds = new Set(variant.map((row) => row.id));
  const byScan = progress.lines.filter((line) => line.scanVariantIds.some((id) => variantIds.has(id)));
  if (byScan.length === 0) {
    if (progress.lines.some((line) => line.trackedVariantIds.some((id) => variantIds.has(id)))) return refuse("scan_serial_instead");
    return refuse("not_in_order");
  }
  // The first line that still needs THIS item (a bundle needs each component in its own number).
  let target: { line: LineProgress; variantId: string } | null = null;
  for (const entry of byScan) {
    const open = entry.scanNeeds.find((need) => variantIds.has(need.variantId) && need.scanned < need.units);
    if (open) {
      target = { line: entry, variantId: open.variantId };
      break;
    }
  }
  if (!target) return refuse("line_complete", byScan[0]?.orderItemId);
  const { line } = target;
  const scanned = line.scanned + 1;
  try {
    await runBatch(db, [
      ...parcelStatements,
      event("scan", { orderItemId: line.orderItemId, variantId: target.variantId, code: code.slice(0, 120), units: 1 }),
      db
        .update(shipmentItems)
        .set({ pickedBy: actorId, pickedAt: now, ...(scanned >= line.scanUnits && line.serialsScanned.length >= line.serialUnits ? { verifiedAt: now } : {}) })
        .where(and(eq(shipmentItems.orderItemId, line.orderItemId), sql`${shipmentItems.shipmentId} IN (SELECT id FROM shipments WHERE order_id = ${order.id})`)),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "shipment_events.id")) return { ok: true, kind: "unit", orderItemId: line.orderItemId, scanned, expected: line.scanUnits, replayed: true };
    throw error;
  }
  return { ok: true, kind: "unit", orderItemId: line.orderItemId, scanned, expected: line.scanUnits, replayed: false };
}

export const ManualVerifyInput = z.object({
  orderItemId: idSchema,
  reason: z.string().trim().min(3, "required").max(300, "too_long"),
  scanId: scanIdSchema,
});
export type ManualVerifyInput = z.input<typeof ManualVerifyInput>;

/**
 * Confirms the remaining units of a line WITHOUT serials by hand (no barcode on the box, a damaged label), with a
 * reason — written as a scan event and audited. Serial-tracked units can only be verified by their serial.
 */
export async function manualVerify(db: Db, actor: Actor, orderId: string, raw: ManualVerifyInput, now: number): Promise<{ units: number; replayed: boolean }> {
  assertCan(actor, "orders.fulfillment.pack");
  const input = ManualVerifyInput.parse(raw);
  const eventId = await scanEventId(orderId, input.scanId);
  const seen = await db.select({ data: shipmentEvents.data }).from(shipmentEvents).where(eq(shipmentEvents.id, eventId)).get();
  if (seen) return { units: Number(seen.data?.units ?? 0), replayed: true };
  const order = await packableOrder(db, actor, orderId, now);
  const progress = await packProgress(db, order.id);
  const line = progress.lines.find((entry) => entry.orderItemId === input.orderItemId);
  if (!line) throw invalid({ orderItemId: "invalid" });
  const units = line.scanUnits - line.scanned;
  if (units <= 0) {
    if (line.serialUnits > line.serialsScanned.length) throw new AppError("scan_serial_instead", 409, { detail: line.orderItemId });
    return { units: 0, replayed: true };
  }
  const { actorKind, actorId } = actorRef(actor);
  await runBatch(db, [
    ...(await defaultParcelStatements(db, order, actor, now)),
    db.insert(shipmentEvents).values({ id: eventId, shipmentId: parcelId(order.id, 1), kind: "scan_manual", data: { orderItemId: line.orderItemId, units, reason: input.reason }, actorKind, actorId, at: now }),
    db
      .update(shipmentItems)
      .set({ pickedBy: actorId, pickedAt: now, ...(line.serialsScanned.length >= line.serialUnits ? { verifiedAt: now } : {}) })
      .where(and(eq(shipmentItems.orderItemId, line.orderItemId), sql`${shipmentItems.shipmentId} IN (SELECT id FROM shipments WHERE order_id = ${order.id})`)),
    db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "verified_by_hand", data: { orderItemId: line.orderItemId, units, reason: input.reason }, actorKind, actorId, at: now }),
    auditStatement(db, { actor, action: "orders.fulfillment.verify_manual", entityType: "order_item", entityId: line.orderItemId, after: { units }, reason: input.reason, at: now }),
  ]);
  return { units, replayed: false };
}

export const SplitInput = z.object({
  lines: z
    .array(z.object({ orderItemId: idSchema, qty: z.number().int("invalid").min(1, "too_small").max(1000, "too_big") }))
    .min(1, "required")
    .max(200),
});
export type SplitInput = z.input<typeof SplitInput>;

/** 05.04 — moves units out of the parcels that hold them into a NEW parcel (before anything is packed). */
export async function splitParcel(db: Db, actor: Actor, orderId: string, raw: SplitInput, now: number): Promise<{ parcelId: string; number: number }> {
  assertCan(actor, "orders.fulfillment.pack");
  const input = SplitInput.parse(raw);
  const order = await packableOrder(db, actor, orderId, now);
  await runBatch(db, await defaultParcelStatements(db, order, actor, now));
  const existing = await db.select({ id: shipments.id, status: shipments.status }).from(shipments).where(eq(shipments.orderId, order.id));
  if (existing.some((row) => row.status !== "pending" && row.status !== "cancelled")) throw new AppError("parcel_packed", 409, { detail: order.id });
  const held = await db
    .select({ shipmentId: shipmentItems.shipmentId, orderItemId: shipmentItems.orderItemId, qty: shipmentItems.qty })
    .from(shipmentItems)
    .where(
      inArray(
        shipmentItems.shipmentId,
        existing.map((row) => row.id),
      ),
    );
  const number = Math.max(1, ...existing.map((row) => parcelNumber(order.id, row.id))) + 1;
  const id = parcelId(order.id, number);
  const { actorKind, actorId } = actorRef(actor);
  const statements: BatchStatement[] = [db.insert(shipments).values({ id, orderId: order.id, status: "pending", codAmountIqd: 0, createdBy: actorId, createdAt: now, updatedAt: now })];
  for (const line of input.lines) {
    let left = line.qty;
    const sources = held.filter((row) => row.orderItemId === line.orderItemId && row.qty > 0);
    const available = sources.reduce((sum, row) => sum + row.qty, 0);
    if (available < line.qty || sources.length === 0) throw invalid({ lines: "split_qty_exceeds" }, line.orderItemId);
    for (const source of sources) {
      if (left <= 0) break;
      const take = Math.min(source.qty, left);
      left -= take;
      statements.push(
        source.qty === take
          ? db.delete(shipmentItems).where(and(eq(shipmentItems.shipmentId, source.shipmentId), eq(shipmentItems.orderItemId, source.orderItemId), eq(shipmentItems.qty, source.qty)))
          : db
              .update(shipmentItems)
              .set({ qty: source.qty - take })
              .where(and(eq(shipmentItems.shipmentId, source.shipmentId), eq(shipmentItems.orderItemId, source.orderItemId), eq(shipmentItems.qty, source.qty))),
        expectChanged(db, 1, { code: "PARCEL_CHANGED", detail: source.shipmentId }),
      );
    }
    statements.push(db.insert(shipmentItems).values({ shipmentId: id, orderItemId: line.orderItemId, qty: line.qty }));
  }
  // A parcel left empty is dropped (cancelled — shipments are never deleted once they existed).
  statements.push(
    batchSql(
      db,
      sql`UPDATE shipments SET status = 'cancelled', updated_at = ${now}
        WHERE order_id = ${order.id} AND status = 'pending' AND id <> ${id} AND NOT EXISTS (SELECT 1 FROM shipment_items si WHERE si.shipment_id = shipments.id)`,
    ),
    db.insert(shipmentEvents).values({ id: newId("sev"), shipmentId: id, kind: "split", data: { lines: input.lines.length }, actorKind, actorId, at: now }),
    db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "parcel_split", data: { parcel: number, lines: input.lines.length }, actorKind, actorId, at: now }),
    auditStatement(db, { actor, action: "orders.fulfillment.split", entityType: "order", entityId: order.id, after: { parcel: id, lines: input.lines }, at: now }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "PARCEL_CHANGED") || isUniqueViolation(error, "shipments.id")) throw new AppError("order_changed", 409, { detail: order.id, cause: error });
    throw error;
  }
  return { parcelId: id, number };
}

/** Every line verified → the order's open parcels are packed (shipment status `packed`, packed_by). */
export async function markPacked(db: Db, actor: Actor, orderId: string, now: number): Promise<{ parcels: number; replayed: boolean }> {
  assertCan(actor, "orders.fulfillment.pack");
  const order = await packableOrder(db, actor, orderId, now);
  const progress = await packProgress(db, order.id);
  if (!progress.complete) throw new AppError("packing_incomplete", 409, { detail: order.id });
  await runBatch(db, await defaultParcelStatements(db, order, actor, now));
  const open = await db.select({ id: shipments.id }).from(shipments).where(and(eq(shipments.orderId, order.id), eq(shipments.status, "pending")));
  if (open.length === 0) return { parcels: 0, replayed: true };
  const { actorKind, actorId } = actorRef(actor);
  await runBatch(db, [
    db
      .update(shipments)
      .set({ status: "packed", packedBy: actorId, updatedAt: now })
      .where(
        and(
          eq(shipments.orderId, order.id),
          eq(shipments.status, "pending"),
          inArray(
            shipments.id,
            open.map((row) => row.id),
          ),
        ),
      ),
    ...open.map((row) => db.insert(shipmentEvents).values({ id: newId("sev"), shipmentId: row.id, kind: "packed", data: null, actorKind, actorId, at: now })),
    db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "packed", data: { parcels: open.length }, actorKind, actorId, at: now }),
    auditStatement(db, { actor, action: "orders.fulfillment.pack", entityType: "order", entityId: order.id, after: { parcels: open.length }, at: now }),
  ]);
  return { parcels: open.length, replayed: false };
}

/** After the order shipped / was delivered: its parcels follow (handed over / delivered), tasks close. */
export function parcelsShippedStatements(db: Db, actor: Actor, orderId: string, input: { trackingNo: string | null; carrierId: string | null }, now: number): BatchStatement[] {
  const { actorKind, actorId } = actorRef(actor);
  return [
    batchSql(
      db,
      sql`INSERT INTO shipment_events (id, shipment_id, kind, note, data, actor_kind, actor_id, at)
        SELECT 'sev_' || s.id || '_handover', s.id, 'handed_over', NULL, NULL, ${actorKind}, ${actorId}, ${now}
        FROM shipments s WHERE s.order_id = ${orderId} AND s.status IN ('pending', 'packed')
        ON CONFLICT(id) DO NOTHING`,
    ),
    batchSql(
      db,
      sql`UPDATE shipments SET status = 'handed_over', shipped_at = ${now}, updated_at = ${now},
          tracking_no = coalesce(tracking_no, ${input.trackingNo}), carrier_id = coalesce(carrier_id, ${input.carrierId}),
          packed_by = coalesce(packed_by, ${actorId})
        WHERE order_id = ${orderId} AND status IN ('pending', 'packed')`,
    ),
    closeTasksStatement(db, orderId, "done", now),
  ];
}

export function parcelsDeliveredStatements(db: Db, actor: Actor, orderId: string, now: number): BatchStatement[] {
  const { actorKind, actorId } = actorRef(actor);
  return [
    batchSql(
      db,
      sql`INSERT INTO shipment_events (id, shipment_id, kind, note, data, actor_kind, actor_id, at)
        SELECT 'sev_' || s.id || '_delivered', s.id, 'delivered', NULL, NULL, ${actorKind}, ${actorId}, ${now}
        FROM shipments s WHERE s.order_id = ${orderId} AND s.status IN ('handed_over', 'in_transit', 'out_for_delivery')
        ON CONFLICT(id) DO NOTHING`,
    ),
    batchSql(db, sql`UPDATE shipments SET status = 'delivered', delivered_at = ${now}, updated_at = ${now} WHERE order_id = ${orderId} AND status IN ('handed_over', 'in_transit', 'out_for_delivery')`),
  ];
}

export const DeliveryProofInput = z.object({
  fileId: idSchema,
  receivedByName: z.string().trim().min(2, "required").max(100, "too_long"),
});
export type DeliveryProofInput = z.input<typeof DeliveryProofInput>;

/**
 * 05.08 — proof of delivery: a PRIVATE photo (the signed slip, the parcel at the door) and the name of the person who
 * received it, on the order's parcels. The file is uploaded by the route (private, kind "delivery_proof") and is only
 * served back to staff who may read orders.
 */
export async function recordDeliveryProof(db: Db, actor: Actor, orderId: string, raw: DeliveryProofInput, now: number): Promise<{ parcels: number }> {
  if (!can(actor, "orders.fulfillment.deliver") && !can(actor, "shipping.proof.manage")) throw forbidden("orders.fulfillment.deliver");
  const input = DeliveryProofInput.parse(raw);
  const order = await orderById(db, orderId);
  if (order.status !== "shipped" && order.status !== "delivered") throw new AppError("proof_not_shipped", 409, { detail: order.status });
  const file = await db.select({ id: files.id, kind: files.kind, visibility: files.visibility, ownerType: files.ownerType, ownerId: files.ownerId }).from(files).where(and(eq(files.id, input.fileId), isNull(files.deletedAt))).get();
  if (!file || file.kind !== "delivery_proof" || file.visibility !== "private" || (file.ownerType !== null && !(file.ownerType === "order" && file.ownerId === order.id))) {
    throw invalid({ file: "proof_file_invalid" });
  }
  const { actorKind, actorId } = actorRef(actor);
  const statements: BatchStatement[] = [];
  const parcels = await db.select({ id: shipments.id }).from(shipments).where(and(eq(shipments.orderId, order.id), sql`${shipments.status} <> 'cancelled'`));
  let targets = parcels.map((row) => row.id);
  if (targets.length === 0) {
    // Shipped without a parcel record (e.g. before this module existed): the proof gets parcel 1.
    const id = parcelId(order.id, 1);
    statements.push(
      batchSql(
        db,
        sql`INSERT INTO shipments (id, order_id, status, cod_amount_iqd, created_by, created_at, updated_at, shipped_at)
          VALUES (${id}, ${order.id}, ${order.status === "delivered" ? "delivered" : "handed_over"}, 0, ${actorId}, ${now}, ${now}, ${order.shippedAt}) ON CONFLICT(id) DO NOTHING`,
      ),
    );
    targets = [id];
  }
  statements.push(
    db
      .update(shipments)
      .set({ proofFileId: file.id, receivedByName: input.receivedByName, updatedAt: now })
      .where(and(eq(shipments.orderId, order.id), inArray(shipments.id, targets))),
    db.update(files).set({ ownerType: "order", ownerId: order.id }).where(eq(files.id, file.id)),
    ...targets.map((id) => db.insert(shipmentEvents).values({ id: newId("sev"), shipmentId: id, kind: "delivery_proof", data: { fileId: file.id, receivedByName: input.receivedByName }, actorKind, actorId, at: now })),
    db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "delivery_proof", data: { receivedByName: input.receivedByName }, actorKind, actorId, at: now }),
    auditStatement(db, { actor, action: "orders.fulfillment.delivery_proof", entityType: "order", entityId: order.id, after: { fileId: file.id, receivedByName: input.receivedByName, parcels: targets.length }, at: now }),
  );
  await runBatch(db, statements);
  return { parcels: targets.length };
}

/** Who may see a parcel's proof photo: anyone who may read orders (it is not a payment document). */
export async function deliveryProofFile(db: Db, actor: Actor, fileId: string): Promise<{ id: string } | null> {
  assertCan(actor, "orders.order.read");
  const row = await db
    .select({ id: files.id })
    .from(files)
    .innerJoin(shipments, eq(shipments.proofFileId, files.id))
    .where(and(eq(files.id, fileId), eq(files.kind, "delivery_proof"), eq(files.visibility, "private"), isNull(files.deletedAt)))
    .get();
  return row ?? null;
}
