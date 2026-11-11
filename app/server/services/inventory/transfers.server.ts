/**
 * Stock transfers — moving stock between locations (warehouses, shops and the aisles, shelves and bins inside them)
 * with an in-transit state (admin module 04.07; docs/CONTRACTS.md §1 "inventory/transfers.server.ts").
 * A core-level module: it moves `stock_levels`, so it follows every rule of ./stock.server.ts.
 *
 *   const { transferId } = await createTransfer(db, actor, { fromLocationId, toLocationId, lines: [{ variantId, qty }], idempotencyKey }, now);
 *   await shipTransfer(db, actor, { transferId, serials: [{ itemId, serials: ["SN-1"] }] }, now);           // draft → in_transit
 *   await receiveTransfer(db, actor, { transferId, lines: [{ itemId, qty: 2 }], serials: ["SN-1"], idempotencyKey }, now);
 *   await closeTransferShortfall(db, actor, { transferId, reason, idempotencyKey }, now);                // what never arrived
 *   await cancelTransfer(db, actor, { transferId, reason }, now);                                        // drafts only
 *   const { units, valueIqd } = await shortfallValue(db, actor, transferId);                            // [P] what a close would write off
 *
 * RULES
 *   · A draft moves nothing. Shipping takes the units off the source in ONE batch: on_hand −= qty with one
 *     'transfer_out' movement per FIFO slice (per serial for serial-tracked units) carrying its unit cost [P], the
 *     source's cost layers consumed oldest first, and `incoming += qty` at the destination. Units promised to orders
 *     never leave: the batch requires on_hand − qty ≥ reserved at the source → insufficient_stock (409).
 *   · Cost layers travel with the units. Every source layer slice gets a twin at the destination with the same unit
 *     cost, received_at, source and receipt item, holding 0 units until they arrive (id `<transfer>.L.<variant>.<n>`),
 *     so FIFO keeps the original age of each batch. Units that had no layer at the source arrive without one and are
 *     costed like every unlayered unit (fifo.ts): the variant's standard landed cost, or unknown — never zero.
 *   · Receiving (whole or partial, as often as goods arrive): on_hand += qty, incoming −= qty, 'transfer_in'
 *     movements, the destination layers filled in FIFO order. The transfer is 'received' once every line has arrived.
 *   · Serial-tracked units travel by serial number. Shipped serials go from in_stock at the source to 'intake' with
 *     no location — not sellable and not packable, because a serial is sold only from in_stock / reserved (the
 *     serials_status_guard trigger) — and back to in_stock at the destination when they are scanned in. A used
 *     device's serial never travels here (it moves with its used unit), and neither does a serial held for an order.
 *   · A shortfall — units that never arrived — is closed with a reason: for each missing unit a 'transfer_in' and a
 *     'damage' movement at the destination (on_hand unchanged, the loss recorded at its unit cost [P]); missing
 *     serials become 'scrapped'. Needs inventory.transfer.receive AND inventory.stock.adjust (it writes stock off).
 *   · Idempotent. Creation: the idempotency key decides the transfer id (a repeat returns the first transfer).
 *     Shipping and cancelling are guarded status changes (a repeat answers replayed: true). Receipts and shortfall
 *     closes build their idempotency key into their movement ids: a repeat finds them (or meets the primary key in
 *     the batch) and answers replayed: true without moving anything twice.
 *   · Receipts and shortfall closes exclude each other: a receipt's batch requires the transfer to be still in
 *     transit (a shortfall closed meanwhile wrote those units off), and a close's batch requires that nothing arrived
 *     since it was read (else it reads again and writes off only what is still missing).
 *     Tests: tests/admin-inventory-adversarial.test.ts.
 *   · Every change writes an audit event in the same batch. An employee limited to a branch acts only on locations
 *     of that branch: the source to create, ship and cancel; the destination to receive and close a shortfall.
 *   · Every movement carries a reason ("TR-XXXX: MAIN → SHOP"), a reference (ref_type 'transfer', the transfer id),
 *     the actor and the time (blueprint acceptance #3).
 *
 * Errors (AppError codes; texts under `errors.<code>`): invalid (fields: required, too_long,
 * transfer_same_location, serials_required, serials_count, serials_duplicate, serials_not_tracked), forbidden,
 * not_found, location_invalid, insufficient_stock, serial_not_available, transfer_not_draft,
 * transfer_not_in_transit, transfer_changed, transfer_receive_exceeds, transfer_serial_mismatch,
 * transfer_nothing_missing.
 *
 * This module must not import "cloudflare:workers" (tests run it against a local D1).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef, sha256Hex } from "~/lib/ids";
import { actorRef, assertCan, canAccessBranch, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  costLayers,
  inventoryLocations,
  serials,
  stockLevels,
  stockMovements,
  stockTransferItems,
  stockTransfers,
  usedUnits,
  variantCosts,
  variants,
  type NewCostLayer,
  type NewStockMovement,
  type NewStockTransferItem,
} from "~/server/db/schema";
import { batchSql, chunkRows, expectChanged, expectThat, isDbError, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { takeFifo, type CostLayerState, type FifoSlice } from "./fifo";

/** Error keys this module produces besides the generic ones (translated through `errors.<key>`). */
export const TRANSFER_ERROR_KEYS = [
  "transfer_same_location",
  "transfer_not_draft",
  "transfer_not_in_transit",
  "transfer_changed",
  "transfer_receive_exceeds",
  "transfer_serial_mismatch",
  "transfer_nothing_missing",
  "location_invalid",
  "insufficient_stock",
  "serial_not_available",
  "serials_required",
  "serials_count",
  "serials_duplicate",
  "serials_not_tracked",
] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
/** Client-generated idempotency keys: 16–64 URL-safe characters. */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "invalid");
const serialSchema = z.string().trim().min(1, "required").max(100, "too_long");
const MAX_LINES = 200;
const MAX_QTY = 100_000;

// ───────────────────────────────────────────────────────────────── inputs

export const CreateTransferInput = z.object({
  fromLocationId: idSchema,
  toLocationId: idSchema,
  lines: z
    .array(z.object({ variantId: idSchema, qty: z.number().int("invalid").min(1, "too_small").max(MAX_QTY, "too_big") }))
    .min(1, "required")
    .max(MAX_LINES, "too_big"),
  notes: z.string().trim().max(500, "too_long").optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateTransferInput = z.input<typeof CreateTransferInput>;

export const ShipTransferInput = z.object({
  transferId: idSchema,
  /** Serial numbers scanned for the serial-tracked lines: one per unit of the line. */
  serials: z
    .array(z.object({ itemId: idSchema, serials: z.array(serialSchema).max(MAX_QTY) }))
    .max(MAX_LINES)
    .optional(),
});
export type ShipTransferInput = z.input<typeof ShipTransferInput>;

export const ReceiveTransferInput = z.object({
  transferId: idSchema,
  /** Units that arrived, for lines without serial numbers. */
  lines: z
    .array(z.object({ itemId: idSchema, qty: z.number().int("invalid").min(0, "too_small").max(MAX_QTY, "too_big") }))
    .max(MAX_LINES * 10)
    .optional(),
  /** Serial numbers scanned at the destination. */
  serials: z.array(serialSchema).max(MAX_QTY).optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type ReceiveTransferInput = z.input<typeof ReceiveTransferInput>;

export const CloseShortfallInput = z.object({
  transferId: idSchema,
  reason: z.string().trim().min(3, "too_short").max(500, "too_long"),
  idempotencyKey: idempotencyKeySchema,
});
export type CloseShortfallInput = z.input<typeof CloseShortfallInput>;

export const CancelTransferInput = z.object({
  transferId: idSchema,
  reason: z.string().trim().min(3, "too_short").max(500, "too_long"),
});
export type CancelTransferInput = z.input<typeof CancelTransferInput>;

// ───────────────────────────────────────────────────────────────── shared reads

type LocationRow = { id: string; code: string; isActive: boolean; branchId: string | null };
type TransferRow = typeof stockTransfers.$inferSelect;
type ItemRow = typeof stockTransferItems.$inferSelect;

function assertTime(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${what}: expected epoch milliseconds, got ${String(value)}`);
  return value;
}

/** The location, and active. */
function activeLocation(location: LocationRow | undefined, field: string): LocationRow {
  if (!location || !location.isActive) throw new AppError("location_invalid", 409, { fields: { [field]: "location_invalid" }, detail: location?.id });
  return location;
}

/** The location, active, and within the actor's branch. */
function usableLocation(location: LocationRow | undefined, actor: Actor, field: string): LocationRow {
  const active = activeLocation(location, field);
  if (!canAccessBranch(actor, active.branchId)) throw forbidden("branch");
  return active;
}

async function loadTransfer(db: Db, transferId: string): Promise<{ transfer: TransferRow; items: ItemRow[]; from: LocationRow; to: LocationRow }> {
  const [transferRows, itemRows] = await db.batch([
    db.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)),
    db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId)).orderBy(asc(stockTransferItems.id)),
  ]);
  const transfer = transferRows[0];
  if (!transfer) throw notFound("transfer");
  const locations = await db
    .select({ id: inventoryLocations.id, code: inventoryLocations.code, isActive: inventoryLocations.isActive, branchId: inventoryLocations.branchId })
    .from(inventoryLocations)
    .where(inArray(inventoryLocations.id, [transfer.fromLocationId, transfer.toLocationId]));
  const byId = new Map(locations.map((row) => [row.id, row]));
  const from = byId.get(transfer.fromLocationId);
  const to = byId.get(transfer.toLocationId);
  if (!from || !to) throw notFound("location");
  return { transfer, items: itemRows, from, to };
}

/** The reason every movement of a transfer carries: "TR-7K4M2Q9X: MAIN → SHOP-1". */
function movementReason(transfer: Pick<TransferRow, "ref">, from: LocationRow, to: LocationRow, extra?: string | null): string {
  const base = `${transfer.ref}: ${from.code} → ${to.code}`;
  return (extra ? `${base} · ${extra}` : base).slice(0, 500);
}

/** A short, stable tag of an idempotency key, safe inside ids (hex). */
async function keyTag(key: string): Promise<string> {
  return (await sha256Hex(`transfer-key:${key}`)).slice(0, 20);
}

/** True when a movement id with this prefix exists (a receipt or close that already ran). */
async function movementsExist(db: Db, prefix: string): Promise<boolean> {
  const row = await db
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(sql`substr(${stockMovements.id}, 1, ${prefix.length}) = ${prefix}`)
    .limit(1);
  return row.length > 0;
}

function mapTransferError(error: unknown): never {
  if (isDbError(error, "INSUFFICIENT_STOCK")) {
    throw new AppError("insufficient_stock", 409, { fields: { lines: "insufficient_stock" }, detail: mapDbError(error)?.detail, cause: error });
  }
  if (isDbError(error, "SERIAL_NOT_AVAILABLE")) throw new AppError("serial_not_available", 409, { fields: { serials: "serial_not_available" }, cause: error });
  if (isDbError(error, "TRANSFER_CHANGED") || isDbError(error, "COST_LAYER_CHANGED")) throw new AppError("transfer_changed", 409, { cause: error });
  throw error;
}

// ───────────────────────────────────────────────────────────────── create

export type CreateTransferResult = { transferId: string; ref: string; replayed: boolean };

/**
 * Creates a draft transfer (nothing moves yet). Lines of the same variant are merged. The source must hold the
 * quantity free of reservations now (checked again, in the batch, when it ships). Needs inventory.transfer.create.
 */
export async function createTransfer(db: Db, actor: Actor, raw: unknown, now: number): Promise<CreateTransferResult> {
  assertCan(actor, "inventory.transfer.create");
  const input = CreateTransferInput.parse(raw);
  assertTime(now, "createTransfer.now");
  if (input.fromLocationId === input.toLocationId) throw invalid({ toLocationId: "transfer_same_location" });
  const { actorKind, actorId } = actorRef(actor);
  const transferId = `trf_${(await sha256Hex(`transfer:${actorKind}:${actorId ?? ""}:${input.idempotencyKey}`)).slice(0, 26)}`;

  const existing = await db.select({ id: stockTransfers.id, ref: stockTransfers.ref }).from(stockTransfers).where(eq(stockTransfers.id, transferId)).limit(1);
  if (existing[0]) return { transferId, ref: existing[0].ref, replayed: true };

  const merged = new Map<string, number>();
  for (const line of input.lines) merged.set(line.variantId, (merged.get(line.variantId) ?? 0) + line.qty);
  const variantIds = [...merged.keys()];
  for (const qty of merged.values()) if (qty > MAX_QTY) throw invalid({ lines: "too_big" });

  const [locationRows, variantRows, levelRows] = await db.batch([
    db
      .select({ id: inventoryLocations.id, code: inventoryLocations.code, isActive: inventoryLocations.isActive, branchId: inventoryLocations.branchId })
      .from(inventoryLocations)
      .where(inArray(inventoryLocations.id, [input.fromLocationId, input.toLocationId])),
    db.select({ id: variants.id }).from(variants).where(inArray(variants.id, variantIds)),
    db
      .select({ variantId: stockLevels.variantId, onHand: stockLevels.onHand, reserved: stockLevels.reserved })
      .from(stockLevels)
      .where(and(eq(stockLevels.locationId, input.fromLocationId), inArray(stockLevels.variantId, variantIds))),
  ]);
  const locations = new Map(locationRows.map((row) => [row.id, row]));
  const from = usableLocation(locations.get(input.fromLocationId), actor, "fromLocationId");
  // Any active destination: a branch employee may send stock to another branch, only the receiver must belong there.
  activeLocation(locations.get(input.toLocationId), "toLocationId");
  const known = new Set(variantRows.map((row) => row.id));
  for (const variantId of variantIds) if (!known.has(variantId)) throw invalid({ lines: "not_found" }, variantId);
  const free = new Map(levelRows.map((row) => [row.variantId, row.onHand - row.reserved]));
  for (const [variantId, qty] of merged) {
    if ((free.get(variantId) ?? 0) < qty) throw new AppError("insufficient_stock", 409, { fields: { lines: "insufficient_stock" }, detail: variantId });
  }

  const ref = publicRef("TR");
  const items: NewStockTransferItem[] = variantIds.map((variantId) => ({ id: newId("tri"), transferId, variantId, serialId: null, qty: merged.get(variantId) ?? 0, qtyReceived: 0, notes: null }));
  const statements: BatchStatement[] = [
    db.insert(stockTransfers).values({
      id: transferId,
      ref,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      status: "draft",
      notes: input.notes ?? null,
      requestedBy: actorId,
      createdAt: now,
    }),
    ...chunkRows(stockTransferItems, items).map((rows) => db.insert(stockTransferItems).values(rows)),
    auditStatement(db, {
      actor,
      action: "inventory.transfer.create",
      entityType: "stock_transfer",
      entityId: transferId,
      summary: `${ref}: ${from.code} → ${locations.get(input.toLocationId)?.code ?? ""}`,
      after: { ref, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, lines: items.map((item) => ({ variantId: item.variantId, qty: item.qty })) },
      reason: input.notes ?? null,
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    // The same key submitted twice at once: the second insert meets the first transfer's primary key.
    if (isUniqueViolation(error, "stock_transfers.id")) {
      const row = await db.select({ ref: stockTransfers.ref }).from(stockTransfers).where(eq(stockTransfers.id, transferId)).limit(1);
      if (row[0]) return { transferId, ref: row[0].ref, replayed: true };
    }
    throw error;
  }
  return { transferId, ref, replayed: false };
}

// ───────────────────────────────────────────────────────────────── ship

/** The FIFO slices of one variant leaving the source, and which destination layer each layered slice becomes. */
type ShipPlan = { variantId: string; qty: number; slices: (FifoSlice & { destLayerId: string | null })[] };

/**
 * Dispatches a draft: draft → in_transit. Serial-tracked lines need their serial numbers (`serials`, one per unit);
 * each becomes a line of its own. Needs inventory.transfer.create. Shipping a transfer that already left answers
 * `replayed: true`.
 */
export async function shipTransfer(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "inventory.transfer.create");
  const input = ShipTransferInput.parse(raw);
  assertTime(now, "shipTransfer.now");
  const { actorKind, actorId } = actorRef(actor);

  for (let attempt = 1; ; attempt++) {
    const { transfer, items, from, to } = await loadTransfer(db, input.transferId);
    if (transfer.status === "in_transit" || transfer.status === "received") return { replayed: true };
    if (transfer.status !== "draft") throw new AppError("transfer_not_draft", 409, { detail: transfer.id });
    usableLocation(from, actor, "fromLocationId");
    if (!to.isActive) throw new AppError("location_invalid", 409, { fields: { toLocationId: "location_invalid" } });

    const variantIds = [...new Set(items.map((item) => item.variantId))];
    const [variantRows, levelRows, layerRows, standardRows] = await db.batch([
      db.select({ id: variants.id, trackSerials: variants.trackSerials }).from(variants).where(inArray(variants.id, variantIds)),
      db
        .select({ variantId: stockLevels.variantId, onHand: stockLevels.onHand, reserved: stockLevels.reserved })
        .from(stockLevels)
        .where(and(eq(stockLevels.locationId, from.id), inArray(stockLevels.variantId, variantIds))),
      db
        .select({ id: costLayers.id, variantId: costLayers.variantId, qtyRemaining: costLayers.qtyRemaining, unitCostIqd: costLayers.unitCostIqd, receivedAt: costLayers.receivedAt, receiptItemId: costLayers.receiptItemId, source: costLayers.source })
        .from(costLayers)
        .where(and(eq(costLayers.locationId, from.id), inArray(costLayers.variantId, variantIds), sql`${costLayers.qtyRemaining} > 0`))
        .orderBy(asc(costLayers.receivedAt), asc(costLayers.id)),
      db.select({ variantId: variantCosts.variantId, landedCostIqd: variantCosts.landedCostIqd }).from(variantCosts).where(inArray(variantCosts.variantId, variantIds)),
    ]);
    const tracked = new Map(variantRows.map((row) => [row.id, row.trackSerials]));

    // ── serial numbers for the serial-tracked lines
    const given = new Map((input.serials ?? []).map((entry) => [entry.itemId, entry.serials.map((value) => value.trim())]));
    for (const itemId of given.keys()) if (!items.some((item) => item.id === itemId)) throw invalid({ serials: "transfer_serial_mismatch" }, itemId);
    const wanted: { item: ItemRow; numbers: string[] }[] = [];
    const allNumbers: string[] = [];
    for (const item of items) {
      const numbers = given.get(item.id) ?? [];
      if (!tracked.get(item.variantId)) {
        if (numbers.length > 0) throw invalid({ serials: "serials_not_tracked" }, item.id);
        continue;
      }
      if (item.serialId) continue;
      if (numbers.length === 0) throw invalid({ serials: "serials_required" }, item.id);
      if (numbers.length !== item.qty) throw invalid({ serials: "serials_count" }, item.id);
      wanted.push({ item, numbers });
      allNumbers.push(...numbers);
    }
    const upper = allNumbers.map((value) => value.toUpperCase());
    if (new Set(upper).size !== upper.length) throw invalid({ serials: "serials_duplicate" });
    const serialRows =
      upper.length === 0
        ? []
        : await db
            .select({ id: serials.id, serial: serials.serial, variantId: serials.variantId, status: serials.status, locationId: serials.locationId, usedUnitId: usedUnits.id })
            .from(serials)
            .leftJoin(usedUnits, eq(usedUnits.serialId, serials.id))
            .where(sql`upper(${serials.serial}) IN (SELECT value FROM json_each(${JSON.stringify(upper)}))`);
    const serialByNumber = new Map(serialRows.map((row) => [row.serial.toUpperCase(), row]));
    /** Serial ids per item, in the order they were scanned. */
    const serialIdsOf = new Map<string, string[]>();
    for (const { item, numbers } of wanted) {
      const ids: string[] = [];
      for (const number of numbers) {
        const row = serialByNumber.get(number.toUpperCase());
        if (!row || row.variantId !== item.variantId) throw invalid({ serials: "transfer_serial_mismatch" }, number);
        if (row.status !== "in_stock" || row.locationId !== from.id || row.usedUnitId !== null) throw new AppError("serial_not_available", 409, { fields: { serials: "serial_not_available" }, detail: row.id });
        ids.push(row.id);
      }
      serialIdsOf.set(item.id, ids);
    }
    // Lines that already name their serial (none today, but the schema allows it).
    for (const item of items) if (item.serialId) serialIdsOf.set(item.id, [item.serialId]);

    // ── quantities and FIFO slices per variant
    const qtyOf = new Map<string, number>();
    for (const item of items) qtyOf.set(item.variantId, (qtyOf.get(item.variantId) ?? 0) + item.qty);
    const free = new Map(levelRows.map((row) => [row.variantId, row.onHand - row.reserved]));
    for (const [variantId, qty] of qtyOf) {
      if ((free.get(variantId) ?? 0) < qty) throw new AppError("insufficient_stock", 409, { fields: { lines: "insufficient_stock" }, detail: variantId });
    }
    const layerInfo = new Map(layerRows.map((row) => [row.id, row]));
    const queues = new Map<string, CostLayerState[]>();
    for (const layer of layerRows) {
      const queue = queues.get(layer.variantId) ?? [];
      queue.push({ id: layer.id, qtyRemaining: layer.qtyRemaining, unitCostIqd: layer.unitCostIqd });
      queues.set(layer.variantId, queue);
    }
    const standard = new Map(standardRows.map((row) => [row.variantId, row.landedCostIqd]));
    const plans: ShipPlan[] = [];
    for (const [variantId, qty] of qtyOf) {
      let layerIndex = 0;
      const slices = takeFifo(queues.get(variantId) ?? [], qty, standard.get(variantId) ?? null).map((slice) => ({
        ...slice,
        destLayerId: slice.layerId ? `${transfer.id}.L.${variantId}.${++layerIndex}` : null,
      }));
      plans.push({ variantId, qty, slices });
    }

    // ── the batch
    const reason = movementReason(transfer, from, to);
    const statements: BatchStatement[] = [
      db
        .update(stockTransfers)
        .set({ status: "in_transit", shippedBy: actorId, shippedAt: now })
        .where(and(eq(stockTransfers.id, transfer.id), eq(stockTransfers.status, "draft"))),
      expectChanged(db, 1, { code: "TRANSFER_CHANGED", detail: transfer.id }),
    ];
    // Serial-tracked lines become one line per serial.
    for (const { item } of wanted) {
      const ids = serialIdsOf.get(item.id) ?? [];
      statements.push(db.delete(stockTransferItems).where(and(eq(stockTransferItems.id, item.id), eq(stockTransferItems.transferId, transfer.id))));
      const rows: NewStockTransferItem[] = ids.map((serialId, index) => ({ id: `${item.id}.${index + 1}`, transferId: transfer.id, variantId: item.variantId, serialId, qty: 1, qtyReceived: 0, notes: null }));
      for (const chunk of chunkRows(stockTransferItems, rows)) statements.push(db.insert(stockTransferItems).values(chunk));
    }
    for (const plan of plans) {
      statements.push(
        db
          .update(stockLevels)
          .set({ onHand: sql`${stockLevels.onHand} - ${plan.qty}`, updatedAt: now })
          // Units held for orders stay where they are: the source keeps at least what is reserved.
          .where(and(eq(stockLevels.variantId, plan.variantId), eq(stockLevels.locationId, from.id), sql`${stockLevels.onHand} - ${plan.qty} >= ${stockLevels.reserved}`)),
        expectChanged(db, 1, { code: "INSUFFICIENT_STOCK", detail: plan.variantId }),
        db
          .insert(stockLevels)
          .values({ variantId: plan.variantId, locationId: to.id, onHand: 0, reserved: 0, incoming: plan.qty, updatedAt: now })
          .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { incoming: sql`${stockLevels.incoming} + ${plan.qty}`, updatedAt: now } }),
      );
    }
    for (const ids of serialIdsOf.values()) {
      for (const serialId of ids) {
        statements.push(
          batchSql(
            db,
            sql`UPDATE serials SET status = 'intake', location_id = NULL, updated_at = ${now}
                WHERE id = ${serialId} AND status = 'in_stock' AND location_id = ${from.id}
                  AND NOT EXISTS (SELECT 1 FROM used_units AS u WHERE u.serial_id = serials.id)`,
          ),
          expectChanged(db, 1, { code: "SERIAL_NOT_AVAILABLE", detail: serialId }),
        );
      }
    }
    const takes = new Map<string, number>();
    const newLayers: NewCostLayer[] = [];
    for (const plan of plans) {
      for (const slice of plan.slices) {
        if (!slice.layerId || !slice.destLayerId) continue;
        takes.set(slice.layerId, (takes.get(slice.layerId) ?? 0) + slice.qty);
        const origin = layerInfo.get(slice.layerId);
        newLayers.push({
          id: slice.destLayerId,
          variantId: plan.variantId,
          locationId: to.id,
          qtyRemaining: 0,
          qtyReceived: slice.qty,
          unitCostIqd: slice.unitCostIqd ?? 0,
          receivedAt: origin?.receivedAt ?? now,
          receiptItemId: origin?.receiptItemId ?? null,
          source: origin?.source ?? "adjustment",
        });
      }
    }
    for (const [layerId, take] of takes) {
      statements.push(
        db
          .update(costLayers)
          .set({ qtyRemaining: sql`${costLayers.qtyRemaining} - ${take}` })
          .where(and(eq(costLayers.id, layerId), sql`${costLayers.qtyRemaining} >= ${take}`)),
        expectChanged(db, 1, { code: "COST_LAYER_CHANGED", detail: layerId }),
      );
    }
    for (const chunk of chunkRows(costLayers, newLayers)) statements.push(db.insert(costLayers).values(chunk));

    // One movement per slice; serial-tracked units get one per serial, each costed by the slice it came from.
    const movements: NewStockMovement[] = [];
    let n = 0;
    for (const plan of plans) {
      const serialQueue = items.filter((item) => item.variantId === plan.variantId).flatMap((item) => serialIdsOf.get(item.id) ?? []);
      for (const slice of plan.slices) {
        const sliceReason = slice.fallback ? `${reason} · ${slice.unitCostIqd === null ? "no_cost_layer_uncosted" : "no_cost_layer_standard_cost"}` : reason;
        if (serialQueue.length > 0) {
          for (let unit = 0; unit < slice.qty; unit++) {
            movements.push({ id: `${transfer.id}.out.${++n}`, variantId: plan.variantId, locationId: from.id, serialId: serialQueue.shift() ?? null, kind: "transfer_out", qtyDelta: -1, reservedDelta: 0, unitCostIqd: slice.unitCostIqd, refType: "transfer", refId: transfer.id, reason: sliceReason, actorKind, actorId, at: now });
          }
        } else {
          movements.push({ id: `${transfer.id}.out.${++n}`, variantId: plan.variantId, locationId: from.id, serialId: null, kind: "transfer_out", qtyDelta: -slice.qty, reservedDelta: 0, unitCostIqd: slice.unitCostIqd, refType: "transfer", refId: transfer.id, reason: sliceReason, actorKind, actorId, at: now });
        }
      }
    }
    for (const chunk of chunkRows(stockMovements, movements)) statements.push(db.insert(stockMovements).values(chunk));
    statements.push(
      auditStatement(db, {
        actor,
        action: "inventory.transfer.ship",
        entityType: "stock_transfer",
        entityId: transfer.id,
        summary: reason,
        before: { status: "draft" },
        after: { status: "in_transit", lines: plans.map((plan) => ({ variantId: plan.variantId, qty: plan.qty })), serials: [...serialIdsOf.values()].flat().length },
        at: now,
      }),
    );

    try {
      await runBatch(db, statements);
      return { replayed: false };
    } catch (error) {
      // A sale took the same cost layer between the read and the write, or someone shipped it first: read again.
      if ((isDbError(error, "COST_LAYER_CHANGED") || isDbError(error, "TRANSFER_CHANGED")) && attempt < 3) continue;
      mapTransferError(error);
    }
  }
}

// ───────────────────────────────────────────────────────────────── receive and shortfall

type DestLayer = { id: string; qtyReceived: number; unitCostIqd: number };

/**
 * How `units` more units of a variant fill the transfer's destination layers, given that `before` units of it have
 * arrived already. Layers fill in FIFO order; units beyond the layered ones have no layer.
 */
export function fillLayers(layers: readonly DestLayer[], before: number, units: number): { layerId: string | null; qty: number; unitCostIqd: number | null }[] {
  const out: { layerId: string | null; qty: number; unitCostIqd: number | null }[] = [];
  let skip = before;
  let left = units;
  for (const layer of layers) {
    if (left === 0) break;
    const room = layer.qtyReceived;
    if (skip >= room) {
      skip -= room;
      continue;
    }
    const take = Math.min(room - skip, left);
    skip = 0;
    left -= take;
    out.push({ layerId: layer.id, qty: take, unitCostIqd: layer.unitCostIqd });
  }
  if (left > 0) out.push({ layerId: null, qty: left, unitCostIqd: null });
  return out;
}

type Arrival = { item: ItemRow; qty: number };

/** Destination layers of a transfer, per variant, in the order they were cut (= FIFO order). */
async function destinationLayers(db: Db, transferId: string, toLocationId: string): Promise<Map<string, DestLayer[]>> {
  const prefix = `${transferId}.L.`;
  const rows = await db
    .select({ id: costLayers.id, variantId: costLayers.variantId, qtyReceived: costLayers.qtyReceived, unitCostIqd: costLayers.unitCostIqd })
    .from(costLayers)
    .where(and(eq(costLayers.locationId, toLocationId), sql`substr(${costLayers.id}, 1, ${prefix.length}) = ${prefix}`));
  const out = new Map<string, DestLayer[]>();
  const index = (id: string) => Number(id.slice(id.lastIndexOf(".") + 1)) || 0;
  for (const row of rows.sort((a, b) => index(a.id) - index(b.id))) {
    const list = out.get(row.variantId) ?? [];
    list.push({ id: row.id, qtyReceived: row.qtyReceived, unitCostIqd: row.unitCostIqd });
    out.set(row.variantId, list);
  }
  return out;
}

/**
 * Records goods that arrived at the destination: lines without serials by quantity (`lines`), serial-tracked
 * units by scanning their serial numbers (`serials`). Partial receipts are fine; the transfer becomes 'received'
 * when every line has fully arrived. Needs inventory.transfer.receive.
 */
export async function receiveTransfer(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ received: number; complete: boolean; replayed: boolean }> {
  assertCan(actor, "inventory.transfer.receive");
  const input = ReceiveTransferInput.parse(raw);
  assertTime(now, "receiveTransfer.now");
  const { actorKind, actorId } = actorRef(actor);
  const tag = await keyTag(input.idempotencyKey);
  const prefix = `${input.transferId}.in.${tag}.`;

  for (let attempt = 1; ; attempt++) {
    const { transfer, items, from, to } = await loadTransfer(db, input.transferId);
    if (await movementsExist(db, prefix)) return { received: 0, complete: transfer.status === "received", replayed: true };
    if (transfer.status !== "in_transit") throw new AppError("transfer_not_in_transit", 409, { detail: transfer.id });
    usableLocation(to, actor, "toLocationId");

    // ── what arrived, per line
    const qtyByItem = new Map<string, number>();
    for (const line of input.lines ?? []) {
      if (line.qty === 0) continue;
      const item = items.find((candidate) => candidate.id === line.itemId);
      if (!item) throw invalid({ lines: "transfer_serial_mismatch" }, line.itemId);
      if (item.serialId) throw invalid({ lines: "serials_required" }, line.itemId);
      qtyByItem.set(item.id, (qtyByItem.get(item.id) ?? 0) + line.qty);
    }
    const numbers = (input.serials ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean);
    if (new Set(numbers).size !== numbers.length) throw invalid({ serials: "serials_duplicate" });
    if (numbers.length > 0) {
      const serialItems = items.filter((item) => item.serialId);
      const serialRows = serialItems.length
        ? await db
            .select({ id: serials.id, serial: serials.serial })
            .from(serials)
            .where(inArray(serials.id, serialItems.map((item) => item.serialId as string)))
        : [];
      const itemBySerialNumber = new Map(serialRows.map((row) => [row.serial.toUpperCase(), serialItems.find((item) => item.serialId === row.id)]));
      for (const number of numbers) {
        const item = itemBySerialNumber.get(number);
        if (!item) throw invalid({ serials: "transfer_serial_mismatch" }, number);
        if (item.qtyReceived >= item.qty) throw new AppError("transfer_receive_exceeds", 409, { fields: { serials: "transfer_receive_exceeds" }, detail: number });
        qtyByItem.set(item.id, 1);
      }
    }
    if (qtyByItem.size === 0) throw invalid({ lines: "required" });
    const arrivals: Arrival[] = [];
    for (const [itemId, qty] of qtyByItem) {
      const item = items.find((candidate) => candidate.id === itemId) as ItemRow;
      if (item.qtyReceived + qty > item.qty) throw new AppError("transfer_receive_exceeds", 409, { fields: { lines: "transfer_receive_exceeds" }, detail: itemId });
      arrivals.push({ item, qty });
    }

    const plan = await planArrivals(db, transfer.id, to.id, items, arrivals);
    const reason = movementReason(transfer, from, to);
    const statements: BatchStatement[] = [
      // Still in transit when the units land: a shortfall closed since the read has written them off already, so they
      // must not come in a second time (the transfer is read again and the receipt refused).
      expectThat(db, sql`(SELECT status FROM stock_transfers WHERE id = ${transfer.id}) = 'in_transit'`, { code: "TRANSFER_CHANGED", detail: transfer.id }),
    ];
    for (const { item, qty } of arrivals) {
      statements.push(
        db
          .update(stockTransferItems)
          .set({ qtyReceived: sql`${stockTransferItems.qtyReceived} + ${qty}` })
          .where(and(eq(stockTransferItems.id, item.id), eq(stockTransferItems.transferId, transfer.id), sql`${stockTransferItems.qtyReceived} + ${qty} <= ${stockTransferItems.qty}`)),
        expectChanged(db, 1, { code: "TRANSFER_CHANGED", detail: item.id }),
      );
    }
    for (const [variantId, units] of plan.unitsByVariant) {
      statements.push(
        db
          .insert(stockLevels)
          .values({ variantId, locationId: to.id, onHand: units, reserved: 0, incoming: 0, updatedAt: now })
          .onConflictDoUpdate({
            target: [stockLevels.variantId, stockLevels.locationId],
            set: {
              onHand: sql`${stockLevels.onHand} + ${units}`,
              incoming: sql`max(${stockLevels.incoming} - ${units}, 0)`,
              // Units arriving can make an oversold level whole again: the stock trigger then guards it again.
              allowOversell: sql`CASE WHEN ${stockLevels.onHand} + ${units} - ${stockLevels.reserved} >= 0 THEN 0 ELSE ${stockLevels.allowOversell} END`,
              updatedAt: now,
            },
          }),
      );
    }
    for (const [layerId, add] of plan.layerFills) {
      statements.push(
        db
          .update(costLayers)
          .set({ qtyRemaining: sql`${costLayers.qtyRemaining} + ${add}` })
          .where(and(eq(costLayers.id, layerId), sql`${costLayers.qtyRemaining} + ${add} <= ${costLayers.qtyReceived}`)),
        expectChanged(db, 1, { code: "COST_LAYER_CHANGED", detail: layerId }),
      );
    }
    for (const { item } of arrivals) {
      if (!item.serialId) continue;
      statements.push(
        db
          .update(serials)
          .set({ status: "in_stock", locationId: to.id, updatedAt: now })
          .where(and(eq(serials.id, item.serialId), eq(serials.status, "intake"))),
        expectChanged(db, 1, { code: "TRANSFER_CHANGED", detail: item.serialId }),
      );
    }
    const movements: NewStockMovement[] = plan.slices.map((slice, index) => ({
      id: `${prefix}${index + 1}`,
      variantId: slice.variantId,
      locationId: to.id,
      serialId: slice.serialId,
      kind: "transfer_in",
      qtyDelta: slice.qty,
      reservedDelta: 0,
      unitCostIqd: slice.unitCostIqd,
      refType: "transfer",
      refId: transfer.id,
      reason,
      actorKind,
      actorId,
      at: now,
    }));
    for (const chunk of chunkRows(stockMovements, movements)) statements.push(db.insert(stockMovements).values(chunk));
    const received = arrivals.reduce((sum, arrival) => sum + arrival.qty, 0);
    const complete = items.every((item) => item.qtyReceived + (qtyByItem.get(item.id) ?? 0) >= item.qty);
    // Decided by the database, not by what was read: two partial receipts at once still close the transfer.
    statements.push(
      batchSql(
        db,
        sql`UPDATE stock_transfers SET status = 'received', received_by = ${actorId}, received_at = ${now}
            WHERE id = ${transfer.id} AND status = 'in_transit'
              AND NOT EXISTS (SELECT 1 FROM stock_transfer_items AS i WHERE i.transfer_id = ${transfer.id} AND i.qty_received < i.qty)`,
      ),
    );
    statements.push(
      auditStatement(db, {
        actor,
        action: "inventory.transfer.receive",
        entityType: "stock_transfer",
        entityId: transfer.id,
        summary: reason,
        after: { received, complete, lines: arrivals.map((arrival) => ({ itemId: arrival.item.id, variantId: arrival.item.variantId, qty: arrival.qty })) },
        at: now,
      }),
    );

    try {
      await runBatch(db, statements);
      const after = complete ? [{ status: "received" as const }] : await db.select({ status: stockTransfers.status }).from(stockTransfers).where(eq(stockTransfers.id, transfer.id)).limit(1);
      return { received, complete: after[0]?.status === "received", replayed: false };
    } catch (error) {
      if (isUniqueViolation(error, "stock_movements.id") || isDbError(error, "IMMUTABLE", "stock_movements")) {
        return { received: 0, complete: false, replayed: true };
      }
      if ((isDbError(error, "TRANSFER_CHANGED") || isDbError(error, "COST_LAYER_CHANGED")) && attempt < 3) continue;
      mapTransferError(error);
    }
  }
}

type ArrivalPlan = {
  unitsByVariant: Map<string, number>;
  layerFills: Map<string, number>;
  slices: { variantId: string; serialId: string | null; qty: number; unitCostIqd: number | null }[];
};

/** Costs and layer fills of units arriving (or written off) for a transfer, in FIFO order per variant. */
async function planArrivals(db: Db, transferId: string, toLocationId: string, items: readonly ItemRow[], arrivals: readonly Arrival[]): Promise<ArrivalPlan> {
  const layersByVariant = await destinationLayers(db, transferId, toLocationId);
  const variantIds = [...new Set(arrivals.map((arrival) => arrival.item.variantId))];
  const standardRows = variantIds.length ? await db.select({ variantId: variantCosts.variantId, landedCostIqd: variantCosts.landedCostIqd }).from(variantCosts).where(inArray(variantCosts.variantId, variantIds)) : [];
  const standard = new Map(standardRows.map((row) => [row.variantId, row.landedCostIqd]));
  const unitsByVariant = new Map<string, number>();
  const layerFills = new Map<string, number>();
  const slices: ArrivalPlan["slices"] = [];
  for (const variantId of variantIds) {
    const before = items.filter((item) => item.variantId === variantId).reduce((sum, item) => sum + item.qtyReceived, 0);
    const mine = arrivals.filter((arrival) => arrival.item.variantId === variantId);
    const units = mine.reduce((sum, arrival) => sum + arrival.qty, 0);
    unitsByVariant.set(variantId, units);
    const fills = fillLayers(layersByVariant.get(variantId) ?? [], before, units);
    const serialQueue = mine.filter((arrival) => arrival.item.serialId).map((arrival) => arrival.item.serialId as string);
    for (const fill of fills) {
      if (fill.layerId) layerFills.set(fill.layerId, (layerFills.get(fill.layerId) ?? 0) + fill.qty);
      // Units that had no layer at the source arrive without one: costed at the standard cost, or unknown.
      const unitCostIqd = fill.layerId ? fill.unitCostIqd : (standard.get(variantId) ?? null);
      if (serialQueue.length > 0) {
        for (let unit = 0; unit < fill.qty; unit++) slices.push({ variantId, serialId: serialQueue.shift() ?? null, qty: 1, unitCostIqd });
      } else {
        slices.push({ variantId, serialId: null, qty: fill.qty, unitCostIqd });
      }
    }
  }
  return { unitsByVariant, layerFills, slices };
}

/**
 * Closes a transfer whose remaining units will not arrive: they are written off at the destination as lost in
 * transit (a 'transfer_in' and a 'damage' movement per unit-slice, at their unit cost [P]; on_hand does not change),
 * missing serials become 'scrapped', incoming drops, and the transfer is 'received'. Needs inventory.transfer.receive
 * and inventory.stock.adjust, and a reason.
 */
export async function closeTransferShortfall(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ lost: number; replayed: boolean }> {
  assertCan(actor, "inventory.transfer.receive");
  assertCan(actor, "inventory.stock.adjust");
  const input = CloseShortfallInput.parse(raw);
  assertTime(now, "closeTransferShortfall.now");
  const { actorKind, actorId } = actorRef(actor);
  const tag = await keyTag(input.idempotencyKey);
  const prefix = `${input.transferId}.lost.${tag}.`;

  for (let attempt = 1; ; attempt++) {
    const { transfer, items, from, to } = await loadTransfer(db, input.transferId);
    if (await movementsExist(db, prefix)) return { lost: 0, replayed: true };
    if (transfer.status !== "in_transit") throw new AppError("transfer_not_in_transit", 409, { detail: transfer.id });
    usableLocation(to, actor, "toLocationId");
    const missing = missingUnits(items);
    if (missing.length === 0) throw new AppError("transfer_nothing_missing", 409, { detail: transfer.id });

    const plan = await planArrivals(db, transfer.id, to.id, items, missing);
    // The 'damage' kind and the transfer reference say what happened; the reason is the employee's own words.
    const reason = movementReason(transfer, from, to, input.reason);
    const receivedSoFar = items.reduce((sum, item) => sum + item.qtyReceived, 0);
    const statements: BatchStatement[] = [
      // Nothing arrived since the read: units received meanwhile are not written off as lost as well (read again).
      expectThat(db, sql`(SELECT coalesce(sum(qty_received), 0) FROM stock_transfer_items WHERE transfer_id = ${transfer.id}) = ${receivedSoFar}`, { code: "TRANSFER_CHANGED", detail: transfer.id }),
      db
        .update(stockTransfers)
        .set({ status: "received", receivedBy: actorId, receivedAt: now })
        .where(and(eq(stockTransfers.id, transfer.id), eq(stockTransfers.status, "in_transit"))),
      expectChanged(db, 1, { code: "TRANSFER_CHANGED", detail: transfer.id }),
    ];
    for (const [variantId, units] of plan.unitsByVariant) {
      statements.push(
        db
          .update(stockLevels)
          .set({ incoming: sql`max(${stockLevels.incoming} - ${units}, 0)`, updatedAt: now })
          .where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, to.id))),
      );
    }
    for (const { item } of missing) {
      if (!item.serialId) continue;
      statements.push(
        db
          .update(serials)
          .set({ status: "scrapped", updatedAt: now, notes: `Lost in transit (${transfer.ref})` })
          .where(and(eq(serials.id, item.serialId), eq(serials.status, "intake"))),
        expectChanged(db, 1, { code: "TRANSFER_CHANGED", detail: item.serialId }),
      );
    }
    // Each lost slice: it reaches the destination's books and leaves them at once, at its unit cost.
    const movements: NewStockMovement[] = [];
    let n = 0;
    for (const slice of plan.slices) {
      const base = { variantId: slice.variantId, locationId: to.id, serialId: slice.serialId, reservedDelta: 0, unitCostIqd: slice.unitCostIqd, refType: "transfer", refId: transfer.id, reason, actorKind, actorId, at: now } as const;
      movements.push({ ...base, id: `${prefix}${++n}`, kind: "transfer_in", qtyDelta: slice.qty });
      movements.push({ ...base, id: `${prefix}${++n}`, kind: "damage", qtyDelta: -slice.qty });
    }
    for (const chunk of chunkRows(stockMovements, movements)) statements.push(db.insert(stockMovements).values(chunk));
    const lost = missing.reduce((sum, entry) => sum + entry.qty, 0);
    statements.push(
      auditStatement(db, {
        actor,
        action: "inventory.transfer.shortfall",
        entityType: "stock_transfer",
        entityId: transfer.id,
        summary: movementReason(transfer, from, to),
        before: { status: "in_transit" },
        after: { status: "received", lost, lines: missing.map((entry) => ({ itemId: entry.item.id, variantId: entry.item.variantId, qty: entry.qty })) },
        reason: input.reason,
        at: now,
      }),
    );
    try {
      await runBatch(db, statements);
      return { lost, replayed: false };
    } catch (error) {
      if (isUniqueViolation(error, "stock_movements.id") || isDbError(error, "IMMUTABLE", "stock_movements")) return { lost: 0, replayed: true };
      // A receipt landed (or completed the transfer) between the read and the write: read again.
      if ((isDbError(error, "TRANSFER_CHANGED") || isDbError(error, "COST_LAYER_CHANGED")) && attempt < 3) continue;
      mapTransferError(error);
    }
  }
}

/** The units of each line that have not arrived (yet). */
function missingUnits(items: readonly ItemRow[]): Arrival[] {
  return items.filter((item) => item.qtyReceived < item.qty).map((item) => ({ item, qty: item.qty - item.qtyReceived }));
}

/**
 * [P] What closing the shortfall of an in-transit transfer would write off right now: the units still missing and
 * their value at cost — the same FIFO slices closeTransferShortfall books (null when any unit's cost is unknown,
 * never a made-up zero). Reads only; needs cost.read. A transfer that is not in transit has nothing missing.
 */
export async function shortfallValue(db: Db, actor: Actor, transferId: string): Promise<{ units: number; valueIqd: number | null }> {
  assertCan(actor, "cost.read");
  const { transfer, items } = await loadTransfer(db, idSchema.parse(transferId));
  const missing = transfer.status === "in_transit" ? missingUnits(items) : [];
  const units = missing.reduce((sum, entry) => sum + entry.qty, 0);
  if (units === 0) return { units: 0, valueIqd: 0 };
  const plan = await planArrivals(db, transfer.id, transfer.toLocationId, items, missing);
  let valueIqd = 0;
  for (const slice of plan.slices) {
    if (slice.unitCostIqd === null) return { units, valueIqd: null };
    valueIqd += slice.qty * slice.unitCostIqd;
  }
  return { units, valueIqd };
}

/** Cancels a draft (nothing has moved). Needs inventory.transfer.create and a reason. A cancelled transfer answers replayed. */
export async function cancelTransfer(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "inventory.transfer.create");
  const input = CancelTransferInput.parse(raw);
  assertTime(now, "cancelTransfer.now");
  const { transfer, from, to } = await loadTransfer(db, input.transferId);
  if (transfer.status === "cancelled") return { replayed: true };
  if (transfer.status !== "draft") throw new AppError("transfer_not_draft", 409, { detail: transfer.id });
  if (!canAccessBranch(actor, from.branchId)) throw forbidden("branch");
  try {
    await runBatch(db, [
      db
        .update(stockTransfers)
        .set({ status: "cancelled", cancelledAt: now })
        .where(and(eq(stockTransfers.id, transfer.id), eq(stockTransfers.status, "draft"))),
      expectChanged(db, 1, { code: "TRANSFER_CHANGED", detail: transfer.id }),
      auditStatement(db, { actor, action: "inventory.transfer.cancel", entityType: "stock_transfer", entityId: transfer.id, summary: movementReason(transfer, from, to), before: { status: "draft" }, after: { status: "cancelled" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "TRANSFER_CHANGED")) {
      const again = await db.select({ status: stockTransfers.status }).from(stockTransfers).where(eq(stockTransfers.id, transfer.id)).limit(1);
      if (again[0]?.status === "cancelled") return { replayed: true };
      throw new AppError("transfer_not_draft", 409, { detail: transfer.id, cause: error });
    }
    throw error;
  }
  return { replayed: false };
}
