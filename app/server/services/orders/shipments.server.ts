/**
 * Parcels kept in step with their order, and cash-on-delivery settlements with carriers — commerce-core level, added
 * by admin 11 "shipping" on 2026-11-11 (docs/CONTRACTS.md §1 "orders/shipments.server.ts"; tests:
 * tests/admin-shipping-core.test.ts).
 *
 *   await deliverParcel(db, actor, { shipmentId, receivedByName, proofFileId, from: "out_for_delivery" }, now);
 *   await returnParcels(db, actor, { orderId, reason, goods: [{ orderItemId, qty, disposition: "scrap" }] }, now);
 *   await syncParcels(db, actor, orderId, now);       // after any transitionOrder: the parcels follow the order
 *   await submitCodSettlement(db, actor, { settlementId, receivedIqd, note }, now);
 *   await reconcileCodSettlement(db, actor, { settlementId, receivedInto: "bank_clearing", reason }, now);
 *
 * WHY THIS FILE. transitionOrder (./manage.server) moves an order with its stock and money in one batch but never
 * touches the `shipments` rows (parcels). The admin orders module (05) lets its own status changes pull the parcels
 * along; this file does the same for the shipping module's parcel-level moves and gives every other caller one
 * function that brings an order's parcels in line with its status (syncParcels). The order always moves FIRST
 * (through transitionOrder — its permissions, guards, stock, warranties and postings), then the parcels follow in a
 * second, guarded and idempotent batch with deterministic event ids (the same ids the orders module writes, so the two
 * never duplicate an event). A follow-up that did not run is repaired by calling the same function again.
 *
 * PARCELS
 *   deliverParcel   (shipping.shipment.update; the LAST undelivered parcel also needs orders.fulfillment.deliver)
 *                   One parcel delivered. When every other live parcel is delivered too, the order moves
 *                   shipped → delivered first (warranties start, revenue and cost of goods are posted). An order on
 *                   HOLD (review_status "blocked", module 05's rule) is not delivered: order_on_hold. A proof photo
 *                   (private file, kind "delivery_proof") and the receiver's name are kept on the parcel; the try is a
 *                   `delivery_attempts` row with outcome "delivered".
 *   returnParcels   (shipping.attempt.manage — the core's permission for shipped → returned) The parcels of a shipped
 *                   order came back undelivered: first the parcels on the road become `returning` in a guarded batch
 *                   (no parcel of the order delivered — a delivery racing the return lands before it and refuses it, or
 *                   after it and finds nothing deliverable), then the order moves to `returned` with the goods per line
 *                   (restock or scrap), the unpaid cash-on-delivery payment is cancelled and paid payments get a pending
 *                   refund (the core's rules), then every in-flight parcel is `returned`. Refused when a parcel of the
 *                   order was delivered (parcel_partly_delivered): the core has no partial return of a shipped order —
 *                   deliver the order and take the other parcel's goods back through a return (module 12).
 *   syncParcels     (shipping.shipment.update) Parcels follow the order's status: shipped → pending/packed handed
 *                   over; delivered → in-flight parcels delivered; cancelled → pending/packed cancelled; returned
 *                   undelivered (no delivered_at) → in-flight parcels returned. Returns how many parcels moved.
 *
 * CASH-ON-DELIVERY SETTLEMENTS (cod_settlements / cod_settlement_items; built as drafts by the shipping module)
 *   submitCodSettlement     (shipping.cod.settle) draft → submitted: the amount the carrier remitted is fixed
 *                           (negative = the store paid the carrier), the totals are recomputed from the parcels and
 *                           stored; a variance needs a note.
 *   reconcileCodSettlement  (shipping.cod.settle; recording cash collections needs orders.payment.record, a collected
 *                           amount other than the one due orders.payment.override + reason — recordCodCollection's
 *                           rules) submitted → reconciled. TWO PEOPLE when the books take a difference — a non-zero
 *                           variance, or a parcel whose cash or carrier charge was corrected by hand (audit action
 *                           SETTLEMENT_CORRECTION_ACTION): the reconciler is nobody who created, corrected or submitted
 *                           the settlement (settlement_self_reconcile, 403) and gives a reason (variance_note_required).
 *                           A settlement exactly as the system prefilled it may be reconciled by its preparer.
 *                           First every parcel's cash still `pending` is recorded
 *                           through recordCodCollection (idempotent: a repeat is a no-op), then ONE batch: the
 *                           settlement reconciled (guarded on its status and totals), each parcel's cod_settled_at and
 *                           its actual carrier charge (shipments.cost_iqd = the item's fee), an event per parcel, the
 *                           journal entry and an audit event. The posting (postCodSettlement, idempotency key
 *                           "cod_settlement:<id>"):
 *                             Dr cash / bank clearing     received   (Cr when the store paid the carrier)
 *                             Dr shipping costs [6100]     fees       (what carriers charged: docs/metrics.md §4)
 *                             Dr/Cr cash over/short        −variance  (short = debit, over = credit)
 *                             Cr cash [1000]               expected   (the cash recordCodCollection booked as collected)
 *                           The chart has no "cash held by couriers" account, so collected cash sits in `cash` until
 *                           the carrier's settlement moves it (requested from the accounting owner).
 *
 * Error keys: forbidden, invalid, not_found, shipment_changed, shipment_not_deliverable, order_not_shipped,
 * order_on_hold, parcel_partly_delivered, proof_file_invalid (field), settlement_not_draft, settlement_not_submitted,
 * settlement_empty, settlement_changed, settlement_self_reconcile (403), settlement_mixed_demo, settlement_item_invalid,
 * settlement_amount_mismatch, variance_note_required (field), period_closed, plus transitionOrder's and
 * recordCodCollection's codes (order_changed, return_exceeds_shipped, amount_mismatch, override_reason_required …).
 *
 * Must not import "cloudflare:workers".
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { auditEvents, carriers, codSettlementItems, codSettlements, deliveryAttempts, files, orders, payments, shipmentEvents, shipments, SHIPMENT_STATUSES, type Order, type Shipment } from "~/server/db/schema";
import { batchSql, expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { journalStatements, mapPostingError, postedBy, type PostingContext } from "../accounting/post.server";
import { recordCodCollection } from "../payments/payments.server";
import { transitionOrder } from "./manage.server";
import { RETURN_DISPOSITIONS } from "./returns.server";

/** Error keys this module produces (besides the core's own: forbidden, invalid, not_found, order_changed, period_closed…). */
export const SHIPMENT_ERROR_KEYS = [
  "shipment_changed",
  "shipment_not_deliverable",
  "order_not_shipped",
  "order_on_hold",
  "parcel_partly_delivered",
  "proof_file_invalid",
  "settlement_not_draft",
  "settlement_not_submitted",
  "settlement_empty",
  "settlement_changed",
  "settlement_self_reconcile",
  "settlement_mixed_demo",
  "settlement_item_invalid",
  "settlement_amount_mismatch",
  "variance_note_required",
] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "too_long")
    .optional()
    .transform((value) => value || undefined);

type ParcelStatus = Shipment["status"];
const DELIVERABLE: readonly ParcelStatus[] = ["handed_over", "in_transit", "out_for_delivery", "failed"];
/** With the courier and still deliverable: what returnParcels takes off the road before the order moves. */
const ON_THE_ROAD: readonly ParcelStatus[] = DELIVERABLE;
const IN_FLIGHT: readonly ParcelStatus[] = ["handed_over", "in_transit", "out_for_delivery", "failed", "returning"];
const AT_STORE: readonly ParcelStatus[] = ["pending", "packed"];

const inSql = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** Deterministic ids of the one-per-parcel events (shared with the admin orders module's follow-ups). */
export const parcelEventId = {
  handover: (shipmentId: string) => `sev_${shipmentId}_handover`,
  delivered: (shipmentId: string) => `sev_${shipmentId}_delivered`,
  returned: (shipmentId: string) => `sev_${shipmentId}_returned`,
  cancelled: (shipmentId: string) => `sev_${shipmentId}_cancelled`,
  codSettled: (shipmentId: string) => `sev_${shipmentId}_cod_settled`,
};

async function loadParcel(db: Db, shipmentId: string): Promise<{ parcel: Shipment; order: Order }> {
  const parcel = await db.select().from(shipments).where(eq(shipments.id, shipmentId)).get();
  if (!parcel) throw notFound("shipment");
  const order = await db.select().from(orders).where(eq(orders.id, parcel.orderId)).get();
  if (!order) throw notFound("order");
  return { parcel, order };
}

// ───────────────────────────────────────────────────────────────── parcels follow the order

/**
 * Statements that bring an order's parcels in line with the order's status (idempotent, guarded by the parcels'
 * statuses; events with deterministic ids). For callers that already hold the order row.
 */
export function syncParcelsStatements(db: Db, actor: Actor, order: Pick<Order, "id" | "status" | "shippedAt" | "deliveredAt">, now: number): BatchStatement[] {
  const { actorKind, actorId } = actorRef(actor);
  const event = (suffix: string, kind: string, statuses: readonly ParcelStatus[]) =>
    batchSql(
      db,
      sql`INSERT INTO shipment_events (id, shipment_id, kind, note, data, actor_kind, actor_id, at)
        SELECT 'sev_' || s.id || ${`_${suffix}`}, s.id, ${kind}, NULL, NULL, ${actorKind}, ${actorId}, ${now}
        FROM shipments s WHERE s.order_id = ${order.id} AND s.status IN (${inSql(statuses)})
        ON CONFLICT(id) DO NOTHING`,
    );
  switch (order.status) {
    case "shipped":
      return [
        event("handover", "handed_over", AT_STORE),
        batchSql(db, sql`UPDATE shipments SET status = 'handed_over', shipped_at = coalesce(shipped_at, ${order.shippedAt ?? now}), updated_at = ${now} WHERE order_id = ${order.id} AND status IN (${inSql(AT_STORE)})`),
      ];
    case "delivered":
      return [
        event("delivered", "delivered", [...AT_STORE, ...IN_FLIGHT]),
        batchSql(
          db,
          sql`UPDATE shipments SET status = 'delivered', delivered_at = coalesce(delivered_at, ${order.deliveredAt ?? now}), updated_at = ${now}
            WHERE order_id = ${order.id} AND status IN (${inSql([...AT_STORE, ...IN_FLIGHT])})`,
        ),
      ];
    case "cancelled":
      return [
        event("cancelled", "cancelled", AT_STORE),
        batchSql(db, sql`UPDATE shipments SET status = 'cancelled', updated_at = ${now} WHERE order_id = ${order.id} AND status IN (${inSql(AT_STORE)})`),
      ];
    case "returned":
      // Returned AFTER delivery: the goods came back through a return (module 12), not with the courier — the
      // parcels stay delivered. Returned undelivered: the parcels on the road came back.
      if (order.deliveredAt) return [];
      return [
        event("returned", "returned", IN_FLIGHT),
        batchSql(db, sql`UPDATE shipments SET status = 'returned', returned_at = coalesce(returned_at, ${now}), updated_at = ${now} WHERE order_id = ${order.id} AND status IN (${inSql(IN_FLIGHT)})`),
      ];
    default:
      return [];
  }
}

/** How many of the order's parcels are out of step with its status (what syncParcels would move). */
export async function parcelsOutOfStep(db: Db, order: Pick<Order, "id" | "status" | "deliveredAt">): Promise<number> {
  const target: readonly ParcelStatus[] =
    order.status === "shipped" ? AT_STORE : order.status === "delivered" ? [...AT_STORE, ...IN_FLIGHT] : order.status === "cancelled" ? AT_STORE : order.status === "returned" && !order.deliveredAt ? IN_FLIGHT : [];
  if (target.length === 0) return 0;
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(shipments)
    .where(and(eq(shipments.orderId, order.id), inArray(shipments.status, [...target])))
    .get();
  return Number(row?.n ?? 0);
}

/** Brings the order's parcels in line with its status (a follow-up that did not run). Returns the parcels moved. */
export async function syncParcels(db: Db, actor: Actor, orderId: string, now: number): Promise<{ moved: number }> {
  assertCan(actor, "shipping.shipment.update");
  const order = await db.select().from(orders).where(eq(orders.id, idSchema.parse(orderId))).get();
  if (!order) throw notFound("order");
  const moved = await parcelsOutOfStep(db, order);
  if (moved === 0) return { moved: 0 };
  await runBatch(db, [
    ...syncParcelsStatements(db, actor, order, now),
    auditStatement(db, { actor, action: "shipping.shipment.sync", entityType: "order", entityId: order.id, summary: `${order.ref}: parcels follow ${order.status}`, after: { status: order.status, parcels: moved }, at: now }),
  ]);
  return { moved };
}

// ───────────────────────────────────────────────────────────────── delivered

export const DeliverParcelInput = z.object({
  shipmentId: idSchema,
  receivedByName: optionalText(100),
  proofFileId: idSchema.optional(),
  note: optionalText(500),
  /** The parcel status the employee saw: when it moved on since, nothing happens (shipment_changed). */
  from: z.enum(SHIPMENT_STATUSES).optional(),
});
export type DeliverParcelInput = z.input<typeof DeliverParcelInput>;

/** A private proof-of-delivery photo stored for this order (or not yet owned). */
async function proofFileFor(db: Db, fileId: string, orderId: string): Promise<{ id: string }> {
  const file = await db
    .select({ id: files.id, kind: files.kind, visibility: files.visibility, ownerType: files.ownerType, ownerId: files.ownerId })
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)))
    .get();
  if (!file || file.kind !== "delivery_proof" || file.visibility !== "private" || (file.ownerType !== null && !(file.ownerType === "order" && file.ownerId === orderId))) {
    throw invalid({ file: "proof_file_invalid" });
  }
  return { id: file.id };
}

/** The order moves to delivered when every live parcel is delivered (and the actor may deliver orders). */
async function finishDeliveredOrder(db: Db, actor: Actor, orderId: string, now: number): Promise<boolean> {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order || order.status !== "shipped" || order.reviewStatus === "blocked") return false;
  const parcels = await db.select({ status: shipments.status }).from(shipments).where(and(eq(shipments.orderId, orderId), ne(shipments.status, "cancelled")));
  if (parcels.length === 0 || parcels.some((parcel) => parcel.status !== "delivered")) return false;
  if (!can(actor, "orders.fulfillment.deliver")) return false;
  await transitionOrder(db, actor, orderId, "delivered", { from: "shipped" }, now);
  return true;
}

/**
 * One parcel delivered; the last one moves the order to delivered first (file header). Returns whether the order
 * was delivered by this call. A parcel already delivered is a replay (and finishes the order if that was missed).
 */
export async function deliverParcel(db: Db, actor: Actor, raw: DeliverParcelInput, now: number): Promise<{ orderDelivered: boolean; replayed: boolean }> {
  assertCan(actor, "shipping.shipment.update");
  const input = DeliverParcelInput.parse(raw);
  if (input.receivedByName !== undefined && input.receivedByName.length < 2) throw invalid({ receivedByName: "too_short" });
  const { parcel, order } = await loadParcel(db, input.shipmentId);
  if (parcel.status === "delivered") return { orderDelivered: await finishDeliveredOrder(db, actor, order.id, now), replayed: true };
  if (input.from && parcel.status !== input.from) throw new AppError("shipment_changed", 409, { detail: `${parcel.status}, expected ${input.from}` });
  if (!DELIVERABLE.includes(parcel.status)) throw new AppError("shipment_not_deliverable", 409, { detail: parcel.status });
  if (order.status !== "shipped" && order.status !== "delivered") throw new AppError("order_not_shipped", 409, { detail: order.status });
  if (order.status === "shipped" && order.reviewStatus === "blocked") throw new AppError("order_on_hold", 409, { detail: order.id });
  const file = input.proofFileId ? await proofFileFor(db, input.proofFileId, order.id) : null;

  const others = await db
    .select({ id: shipments.id, status: shipments.status })
    .from(shipments)
    .where(and(eq(shipments.orderId, order.id), ne(shipments.id, parcel.id)));
  const lastOne = others.every((other) => other.status === "delivered" || other.status === "cancelled");
  let orderDelivered = false;
  if (lastOne && order.status === "shipped") {
    assertCan(actor, "orders.fulfillment.deliver");
    await transitionOrder(db, actor, order.id, "delivered", { from: "shipped" }, now);
    orderDelivered = true;
  }

  const previous = await db
    .select({ n: sql<number>`coalesce(max(${deliveryAttempts.attemptNo}), 0)` })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.shipmentId, parcel.id))
    .get();
  const attemptNo = Number(previous?.n ?? 0) + 1;
  const { actorKind, actorId } = actorRef(actor);
  const statements: BatchStatement[] = [
    // the order is still out with the courier (or delivered) at this point of the batch: an order taken back meanwhile
    // (its goods back in stock) never gets a parcel recorded as delivered
    expectThat(db, sql`(SELECT status FROM orders WHERE id = ${order.id}) IN ('shipped', 'delivered')`, { code: "ORDER_NOT_SHIPPED", detail: order.id }),
    db
      .update(shipments)
      .set({ status: "delivered", deliveredAt: now, updatedAt: now, ...(input.receivedByName ? { receivedByName: input.receivedByName } : {}), ...(file ? { proofFileId: file.id } : {}) })
      .where(and(eq(shipments.id, parcel.id), inArray(shipments.status, [...DELIVERABLE]))),
    expectChanged(db, 1, { code: "SHIPMENT_CHANGED", detail: parcel.id }),
    db
      .insert(shipmentEvents)
      .values({ id: parcelEventId.delivered(parcel.id), shipmentId: parcel.id, kind: "delivered", note: input.note ?? null, data: { receivedByName: input.receivedByName ?? null, fileId: file?.id ?? null }, actorKind, actorId, at: now })
      .onConflictDoNothing(),
    db.insert(deliveryAttempts).values({ id: newId("dat"), shipmentId: parcel.id, attemptNo, outcome: "delivered", notes: input.note ?? null, proofFileId: file?.id ?? null, attemptedAt: now, recordedBy: actorId }),
    ...(file ? [db.update(files).set({ ownerType: "order", ownerId: order.id }).where(eq(files.id, file.id))] : []),
    auditStatement(db, {
      actor,
      action: "shipping.shipment.deliver",
      entityType: "shipment",
      entityId: parcel.id,
      summary: `${order.ref}: parcel delivered`,
      before: { status: parcel.status },
      after: { status: "delivered", receivedByName: input.receivedByName ?? null, proofFileId: file?.id ?? null, orderDelivered },
      reason: input.note ?? null,
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "ORDER_NOT_SHIPPED")) {
      const again = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id)).get();
      throw new AppError("order_not_shipped", 409, { detail: again?.status ?? "missing", cause: error });
    }
    if (isDbError(error, "SHIPMENT_CHANGED") || isUniqueViolation(error, "delivery_attempts.attempt_no")) {
      const again = await db.select({ status: shipments.status }).from(shipments).where(eq(shipments.id, parcel.id)).get();
      if (again?.status === "delivered") return { orderDelivered, replayed: !orderDelivered };
      // The order moved on (delivered above) while someone else moved this parcel: bring the parcels in line.
      if (orderDelivered) {
        await runBatch(db, syncParcelsStatements(db, actor, { id: order.id, status: "delivered", shippedAt: order.shippedAt, deliveredAt: now }, now));
        return { orderDelivered, replayed: false };
      }
      throw new AppError("shipment_changed", 409, { detail: again?.status ?? "missing", cause: error });
    }
    throw error;
  }
  // Another parcel of the order was delivered at the same moment by someone who still saw this one on the road.
  if (!orderDelivered && order.status === "shipped") orderDelivered = await finishDeliveredOrder(db, actor, order.id, now);
  return { orderDelivered, replayed: false };
}

// ───────────────────────────────────────────────────────────────── returned to the store

export const ReturnParcelsInput = z.object({
  orderId: idSchema,
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
  /** Per line: restock or scrap (default: everything that left comes back and is restocked). */
  goods: z
    .array(
      z.object({
        orderItemId: idSchema,
        qty: z.number().int("invalid").min(1, "too_small").max(1000, "too_big"),
        disposition: z.enum(RETURN_DISPOSITIONS),
        serialIds: z.array(idSchema).max(1000).optional(),
      }),
    )
    .max(200)
    .optional(),
  locationId: idSchema.optional(),
});
export type ReturnParcelsInput = z.input<typeof ReturnParcelsInput>;

/** The parcels of a shipped order came back undelivered (file header). */
export async function returnParcels(db: Db, actor: Actor, raw: ReturnParcelsInput, now: number): Promise<{ parcels: number; replayed: boolean }> {
  assertCan(actor, "shipping.attempt.manage");
  const input = ReturnParcelsInput.parse(raw);
  const order = await db.select().from(orders).where(eq(orders.id, input.orderId)).get();
  if (!order) throw notFound("order");
  if (order.status === "returned") {
    const moved = await parcelsOutOfStep(db, order);
    if (moved > 0) await runBatch(db, syncParcelsStatements(db, actor, order, now));
    return { parcels: moved, replayed: true };
  }
  if (order.status !== "shipped") throw new AppError("order_not_shipped", 409, { detail: order.status });
  const parcels = await db.select({ id: shipments.id, status: shipments.status }).from(shipments).where(eq(shipments.orderId, order.id));
  if (parcels.some((parcel) => parcel.status === "delivered")) throw new AppError("parcel_partly_delivered", 409, { detail: order.id });
  const { actorKind, actorId } = actorRef(actor);

  // The parcels on the road are on their way back from this moment, in one guarded batch BEFORE the order moves: a
  // delivery recorded meanwhile either landed first (the guard refuses the return — its goods are with the customer and
  // must not go back into stock) or finds the parcels no longer deliverable. A return that then fails leaves them
  // "returning", which is what they are; calling this again finishes it.
  try {
    await runBatch(db, [
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM shipments WHERE order_id = ${order.id} AND status = 'delivered')`, { code: "PARCEL_DELIVERED", detail: order.id }),
      batchSql(
        db,
        sql`INSERT INTO shipment_events (id, shipment_id, kind, note, data, actor_kind, actor_id, at)
          SELECT 'sev_' || s.id || '_returning_' || ${String(now)}, s.id, 'returning', ${input.reason}, NULL, ${actorKind}, ${actorId}, ${now}
          FROM shipments s WHERE s.order_id = ${order.id} AND s.status IN (${inSql(ON_THE_ROAD)})
          ON CONFLICT(id) DO NOTHING`,
      ),
      batchSql(db, sql`UPDATE shipments SET status = 'returning', updated_at = ${now} WHERE order_id = ${order.id} AND status IN (${inSql(ON_THE_ROAD)})`),
    ]);
  } catch (error) {
    if (isDbError(error, "PARCEL_DELIVERED")) throw new AppError("parcel_partly_delivered", 409, { detail: order.id, cause: error });
    throw error;
  }

  await transitionOrder(db, actor, order.id, "returned", { reason: input.reason, goods: input.goods, locationId: input.locationId, from: "shipped" }, now);

  const moving = parcels.filter((parcel) => IN_FLIGHT.includes(parcel.status) || AT_STORE.includes(parcel.status));
  await runBatch(db, [
    ...moving.map((parcel) =>
      db
        .insert(shipmentEvents)
        .values({ id: parcelEventId.returned(parcel.id), shipmentId: parcel.id, kind: "returned", note: input.reason, data: { from: parcel.status }, actorKind, actorId, at: now })
        .onConflictDoNothing(),
    ),
    batchSql(
      db,
      sql`UPDATE shipments SET status = 'returned', returned_at = coalesce(returned_at, ${now}), failure_reason = coalesce(failure_reason, ${input.reason}), updated_at = ${now}
        WHERE order_id = ${order.id} AND status IN (${inSql([...AT_STORE, ...IN_FLIGHT])})`,
    ),
    auditStatement(db, {
      actor,
      action: "shipping.shipment.return",
      entityType: "order",
      entityId: order.id,
      summary: `${order.ref}: parcels back at the store`,
      before: { parcels: moving.map((parcel) => ({ id: parcel.id, status: parcel.status })) },
      after: { status: "returned", goods: input.goods ?? "all restocked" },
      reason: input.reason,
      at: now,
    }),
  ]);
  return { parcels: moving.length, replayed: false };
}

// ───────────────────────────────────────────────────────────────── cash-on-delivery settlements

/** Idempotency key of a settlement's journal entry. */
export const codSettlementPostingKey = (settlementId: string) => `cod_settlement:${settlementId}`;

/**
 * The journal entry of a reconciled carrier settlement (file header). Balanced by construction:
 * received + fees − variance = expected, with variance = received − (expected − fees).
 */
export function postCodSettlement(
  db: Db,
  input: PostingContext & {
    id?: string;
    settlementId: string;
    ref: string;
    carrier: string;
    expectedIqd: number;
    feesIqd: number;
    receivedIqd: number;
    receivedInto: "cash" | "bank_clearing";
    reference?: string | null;
  },
): BatchStatement[] {
  const variance = input.receivedIqd - (input.expectedIqd - input.feesIqd);
  return journalStatements(db, {
    id: input.id,
    at: input.at,
    memo: `COD settlement ${input.ref} (${input.carrier})${input.reference ? ` ref ${input.reference}` : ""}`,
    refType: "cod_settlement",
    refId: input.settlementId,
    createdBy: input.createdBy,
    idempotencyKey: codSettlementPostingKey(input.settlementId),
    isDemo: input.isDemo,
    lines: [
      { accountCode: input.receivedInto, debitIqd: input.receivedIqd > 0 ? input.receivedIqd : 0, creditIqd: input.receivedIqd < 0 ? -input.receivedIqd : 0 },
      { accountCode: "shipping_costs", debitIqd: input.feesIqd },
      { accountCode: "cash_over_short", debitIqd: variance < 0 ? -variance : 0, creditIqd: variance > 0 ? variance : 0 },
      { accountCode: "cash", creditIqd: input.expectedIqd },
    ],
  });
}

type ItemFacts = {
  shipmentId: string;
  amountIqd: number;
  feeIqd: number;
  orderId: string;
  ref: string;
  orderStatus: Order["status"];
  paymentMethod: string | null;
  isDemo: boolean;
  parcelStatus: ParcelStatus;
};

async function settlementFacts(db: Db, settlementId: string) {
  const settlement = await db.select().from(codSettlements).where(eq(codSettlements.id, settlementId)).get();
  if (!settlement) throw notFound("cod_settlement");
  const items: ItemFacts[] = await db
    .select({
      shipmentId: codSettlementItems.shipmentId,
      amountIqd: codSettlementItems.amountIqd,
      feeIqd: codSettlementItems.feeIqd,
      orderId: orders.id,
      ref: orders.ref,
      orderStatus: orders.status,
      paymentMethod: orders.paymentMethod,
      isDemo: orders.isDemo,
      parcelStatus: shipments.status,
    })
    .from(codSettlementItems)
    .innerJoin(shipments, eq(shipments.id, codSettlementItems.shipmentId))
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(codSettlementItems.settlementId, settlementId))
    .orderBy(asc(orders.ref), asc(codSettlementItems.shipmentId));
  const expectedIqd = items.reduce((sum, item) => sum + item.amountIqd, 0);
  const feesIqd = items.reduce((sum, item) => sum + item.feeIqd, 0);
  return { settlement, items, expectedIqd, feesIqd };
}

/** Who submitted a settlement last (from the append-only audit trail; null before it was submitted). */
export async function settlementSubmitter(db: Db, settlementId: string): Promise<string | null> {
  const row = await db
    .select({ actorId: auditEvents.actorId })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "shipping.cod.submit"), eq(auditEvents.entityType, "cod_settlement"), eq(auditEvents.entityId, settlementId)))
    .orderBy(desc(auditEvents.seq))
    .limit(1)
    .get();
  return row?.actorId ?? null;
}

/**
 * The audit action of a hand correction of a settlement's parcel (its cash or the carrier's charge changed from what
 * the system prefilled) — written by the shipping module's draft editor (updateSettlementItem) in the same batch as
 * the change, read here: a corrected settlement is a difference for the two-person rule.
 */
export const SETTLEMENT_CORRECTION_ACTION = "shipping.cod.item";

/**
 * Who prepared a settlement's numbers (from the append-only audit trail): its last submitter and everyone who corrected
 * one of its parcels by hand. `corrected` = at least one correction was made.
 */
export async function settlementPreparers(db: Db, settlementId: string): Promise<{ submitter: string | null; correctors: string[]; corrected: boolean }> {
  const [submitter, rows] = await Promise.all([
    settlementSubmitter(db, settlementId),
    db
      .select({ actorId: auditEvents.actorId })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, SETTLEMENT_CORRECTION_ACTION), eq(auditEvents.entityType, "cod_settlement"), eq(auditEvents.entityId, settlementId))),
  ]);
  const correctors = [...new Set(rows.map((row) => row.actorId).filter((id): id is string => typeof id === "string" && id.length > 0))];
  return { submitter, correctors, corrected: rows.length > 0 };
}

/**
 * The two-person rule of a reconciliation: when the books take a difference — a variance, or a parcel whose cash or
 * carrier charge was corrected by hand — nobody who created, corrected or submitted the settlement decides it.
 */
export function settlementNeedsSecondPerson(
  settlement: { createdBy: string | null; varianceIqd: number },
  preparers: { submitter: string | null; correctors: readonly string[]; corrected: boolean },
  actorId: string | null,
): { needsSecond: boolean; involved: boolean } {
  const needsSecond = settlement.varianceIqd !== 0 || preparers.corrected;
  const involved = actorId !== null && (actorId === settlement.createdBy || actorId === preparers.submitter || preparers.correctors.includes(actorId));
  return { needsSecond, involved };
}

export const SubmitSettlementInput = z.object({
  settlementId: idSchema,
  /** What the carrier remitted; negative when the store paid the carrier (its charges were more than the cash). */
  receivedIqd: z.number().int("invalid").min(-1_000_000_000, "too_small").max(10_000_000_000, "too_big"),
  note: optionalText(500),
});
export type SubmitSettlementInput = z.input<typeof SubmitSettlementInput>;

/** draft (or disputed) → submitted, with the amount received and the totals fixed (file header). */
export async function submitCodSettlement(db: Db, actor: Actor, raw: SubmitSettlementInput, now: number): Promise<{ varianceIqd: number; replayed: boolean }> {
  assertCan(actor, "shipping.cod.settle");
  const input = SubmitSettlementInput.parse(raw);
  const { settlement, items, expectedIqd, feesIqd } = await settlementFacts(db, input.settlementId);
  const varianceIqd = input.receivedIqd - (expectedIqd - feesIqd);
  if (settlement.status === "submitted" && settlement.receivedIqd === input.receivedIqd && settlement.varianceIqd === varianceIqd) return { varianceIqd, replayed: true };
  if (settlement.status !== "draft" && settlement.status !== "disputed") throw new AppError("settlement_not_draft", 409, { detail: settlement.status });
  if (items.length === 0) throw new AppError("settlement_empty", 409, { detail: settlement.id });
  if (varianceIqd !== 0 && (input.note ?? "").length < 3) throw invalid({ note: "variance_note_required" });
  const notes = input.note ? (settlement.notes ? `${settlement.notes}\n${input.note}` : input.note).slice(0, 2000) : settlement.notes;
  try {
    await runBatch(db, [
      db
        .update(codSettlements)
        .set({ status: "submitted", expectedIqd, feesIqd, receivedIqd: input.receivedIqd, varianceIqd, notes })
        .where(and(eq(codSettlements.id, settlement.id), eq(codSettlements.status, settlement.status), sql`${codSettlements.expectedIqd} = ${settlement.expectedIqd}`, sql`${codSettlements.feesIqd} = ${settlement.feesIqd}`)),
      expectChanged(db, 1, { code: "SETTLEMENT_CHANGED", detail: settlement.id }),
      // the parcels are exactly the ones read (an item added or changed meanwhile fails the batch)
      expectThat(
        db,
        sql`(SELECT count(*) = ${items.length} AND coalesce(sum(amount_iqd), 0) = ${expectedIqd} AND coalesce(sum(fee_iqd), 0) = ${feesIqd} FROM cod_settlement_items WHERE settlement_id = ${settlement.id})`,
        { code: "SETTLEMENT_CHANGED", detail: settlement.id },
      ),
      auditStatement(db, {
        actor,
        action: "shipping.cod.submit",
        entityType: "cod_settlement",
        entityId: settlement.id,
        summary: `${settlement.ref}: remittance recorded`,
        before: { status: settlement.status, receivedIqd: settlement.receivedIqd },
        after: { status: "submitted", expectedIqd, feesIqd, receivedIqd: input.receivedIqd, varianceIqd, parcels: items.length },
        reason: input.note ?? null,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "SETTLEMENT_CHANGED")) throw new AppError("settlement_changed", 409, { detail: settlement.id, cause: error });
    throw error;
  }
  return { varianceIqd, replayed: false };
}

export const ReconcileSettlementInput = z.object({
  settlementId: idSchema,
  receivedInto: z.enum(["cash", "bank_clearing"]),
  /** Required with a variance, and when a parcel's collected cash differs from what was due. */
  reason: optionalText(500),
  /** The bank transfer's or receipt's reference (goes into the journal memo). */
  reference: optionalText(100),
});
export type ReconcileSettlementInput = z.input<typeof ReconcileSettlementInput>;

/** The cash-on-delivery payment of an order (the newest not cancelled), or null. */
async function codPaymentOf(db: Db, orderId: string) {
  return db
    .select({ id: payments.id, status: payments.status, amountIqd: payments.amountIqd })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.method, "cod"), ne(payments.status, "cancelled")))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .get();
}

/** submitted → reconciled: cash collections recorded, the settlement posted, parcels marked settled (file header). */
export async function reconcileCodSettlement(
  db: Db,
  actor: Actor,
  raw: ReconcileSettlementInput,
  now: number,
): Promise<{ journalEntryId: string | null; codRecorded: number; replayed: boolean }> {
  assertCan(actor, "shipping.cod.settle");
  const input = ReconcileSettlementInput.parse(raw);
  const { settlement, items, expectedIqd, feesIqd } = await settlementFacts(db, input.settlementId);
  if (settlement.status === "reconciled") return { journalEntryId: settlement.journalEntryId, codRecorded: 0, replayed: true };
  if (settlement.status !== "submitted") throw new AppError("settlement_not_submitted", 409, { detail: settlement.status });
  if (items.length === 0) throw new AppError("settlement_empty", 409, { detail: settlement.id });
  const variance = settlement.receivedIqd - (expectedIqd - feesIqd);
  if (expectedIqd !== settlement.expectedIqd || feesIqd !== settlement.feesIqd || variance !== settlement.varianceIqd) throw new AppError("settlement_changed", 409, { detail: settlement.id });
  const { actorId } = actorRef(actor);
  // Two people for every difference the books take: a variance, or a parcel whose cash or carrier charge was corrected
  // by hand (one person could otherwise turn a courier's shortfall into a "carrier charge", make the variance 0 and
  // reconcile alone). Nobody who created, corrected or submitted the settlement decides it, and the decider says why.
  const rule = settlementNeedsSecondPerson({ createdBy: settlement.createdBy, varianceIqd: variance }, await settlementPreparers(db, settlement.id), actorId);
  if (rule.needsSecond) {
    if (actor.kind !== "system" && rule.involved) throw new AppError("settlement_self_reconcile", 403, { detail: settlement.id });
    if ((input.reason ?? "").length < 3) throw invalid({ reason: "variance_note_required" });
  }
  const demo = new Set(items.map((item) => item.isDemo));
  if (demo.size > 1) throw new AppError("settlement_mixed_demo", 409, { detail: settlement.id });

  // The cash each parcel brought: recorded once per order, through the core (orders.payment.record).
  const pending: { orderId: string; amountIqd: number; dueIqd: number }[] = [];
  for (const item of items) {
    if (item.amountIqd === 0) continue;
    const payment = item.paymentMethod === "cod" ? await codPaymentOf(db, item.orderId) : undefined;
    if (!payment || (payment.status !== "pending" && payment.status !== "paid")) throw new AppError("settlement_item_invalid", 409, { detail: item.ref });
    if (payment.status === "paid") {
      if (payment.amountIqd !== item.amountIqd) throw new AppError("settlement_amount_mismatch", 409, { detail: item.ref });
      continue;
    }
    pending.push({ orderId: item.orderId, amountIqd: item.amountIqd, dueIqd: payment.amountIqd });
  }
  if (pending.length > 0) assertCan(actor, "orders.payment.record");
  // recordCodCollection's own rules, checked for EVERY parcel before the first is recorded: a reconciler who may not
  // accept one parcel's different amount records none (no half-recorded settlement depending on the parcels' order).
  if (pending.some((entry) => entry.amountIqd !== entry.dueIqd)) {
    if (!can(actor, "orders.payment.override")) throw new AppError("amount_mismatch", 403, { fields: { amountIqd: "amount_mismatch" }, detail: settlement.id });
    if ((input.reason ?? "").length < 3) throw invalid({ reason: "override_reason_required" });
  }
  for (const entry of pending) {
    await recordCodCollection(db, actor, entry.orderId, entry.amountIqd, now, { reason: entry.amountIqd !== entry.dueIqd ? (input.reason ?? null) : null });
  }

  const carrier = await db.select({ name: carriers.name }).from(carriers).where(eq(carriers.id, settlement.carrierId)).get();
  const entryId = newId("je");
  const posting = postCodSettlement(db, {
    id: entryId,
    settlementId: settlement.id,
    ref: settlement.ref,
    carrier: carrier?.name ?? settlement.carrierId,
    expectedIqd,
    feesIqd,
    receivedIqd: settlement.receivedIqd,
    receivedInto: input.receivedInto,
    reference: input.reference ?? null,
    at: now,
    createdBy: postedBy(actor),
    isDemo: demo.has(true),
  });
  const { actorKind } = actorRef(actor);
  const statements: BatchStatement[] = [
    db
      .update(codSettlements)
      .set({ status: "reconciled", reconciledBy: actorId, reconciledAt: now, journalEntryId: posting.length > 0 ? entryId : null })
      .where(
        and(
          eq(codSettlements.id, settlement.id),
          eq(codSettlements.status, "submitted"),
          sql`${codSettlements.expectedIqd} = ${expectedIqd}`,
          sql`${codSettlements.feesIqd} = ${feesIqd}`,
          sql`${codSettlements.receivedIqd} = ${settlement.receivedIqd}`,
        ),
      ),
    expectChanged(db, 1, { code: "SETTLEMENT_CHANGED", detail: settlement.id }),
    ...items.map((item) => db.update(shipments).set({ codSettledAt: now, costIqd: item.feeIqd, updatedAt: now }).where(eq(shipments.id, item.shipmentId))),
    ...items.map((item) =>
      db
        .insert(shipmentEvents)
        .values({ id: parcelEventId.codSettled(item.shipmentId), shipmentId: item.shipmentId, kind: "cod_settled", note: null, data: { settlementId: settlement.id, ref: settlement.ref, amountIqd: item.amountIqd, feeIqd: item.feeIqd }, actorKind, actorId, at: now })
        .onConflictDoNothing(),
    ),
    ...posting,
    auditStatement(db, {
      actor,
      action: "shipping.cod.reconcile",
      entityType: "cod_settlement",
      entityId: settlement.id,
      summary: `${settlement.ref}: settlement reconciled`,
      before: { status: "submitted" },
      after: { status: "reconciled", expectedIqd, feesIqd, receivedIqd: settlement.receivedIqd, varianceIqd: variance, receivedInto: input.receivedInto, reference: input.reference ?? null, codRecorded: pending.length },
      reason: input.reason ?? null,
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    const postingError = mapPostingError(error);
    if (postingError?.code === "already_posted" || isDbError(error, "SETTLEMENT_CHANGED")) {
      const again = await db.select({ status: codSettlements.status, journalEntryId: codSettlements.journalEntryId }).from(codSettlements).where(eq(codSettlements.id, settlement.id)).get();
      if (again?.status === "reconciled") return { journalEntryId: again.journalEntryId, codRecorded: pending.length, replayed: true };
      throw new AppError("settlement_changed", 409, { detail: settlement.id, cause: error });
    }
    if (postingError) throw postingError;
    throw error;
  }
  return { journalEntryId: posting.length > 0 ? entryId : null, codRecorded: pending.length, replayed: false };
}
