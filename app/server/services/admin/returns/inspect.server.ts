/**
 * Inspection and grading of returned units (blueprint 12.03) and the quarantine that follows for units that are not
 * sellable as they are (12.07: refurbish, return to supplier). Goods move ONLY through the commerce core
 * (services/returns/receive.server.ts → planReturnedGoods, FIFO layers, journal postings).
 *
 *   await inspectItem(db, actor, { returnId, itemId, condition: "defective", decision: "return_to_supplier", locationId: quarantineId, serial: "SN…", notes }, now);
 *   const q = await listQuarantine(db, actor, locale, now);
 *   await resolveQuarantine(db, actor, { itemId, to: "stock", locationId, reason }, now);
 *
 * INSPECTION (returns.rma.inspect), one unit (RMA line) at a time, each in ONE batch:
 *   · a serial-tracked unit is identified by scanning its serial: another serial than the one sold on that line is
 *     refused and recorded (`returns.rma.serial_mismatch`, a fraud signal) — the store never takes in a swapped unit;
 *   · the grade (sellable / opened / defective / damaged), the inspector's notes and the decision are stored on the
 *     line, guarded so two inspectors cannot both inspect it;
 *   · restock → sellable stock (default: where it left from); refurbish / return_to_supplier → a quarantine location
 *     (not sellable); scrap → written off; keep → no goods move (the unit stays the customer's);
 *   · goods taken back void the unit's running warranty ("returned: RMA-…"); the first inspection marks the RMA
 *     received, the last one inspected.
 * QUARANTINE: units refurbished or waiting for their supplier, with the days they have waited against SLA.quarantineDays;
 *   back on sale (returns.rma.inspect), written off (+ inventory.stock.adjust), or sent to the supplier
 *   (returns.supplier_return.manage) — the last one opens a supplier claim (kind "return", purchasing 09.06) whose
 *   reference travels on the stock movements.
 * BRANCHES: an employee limited to a branch puts goods into, and takes them out of, that branch's locations only (403
 *   otherwise); restocking "where the unit left from" needs a named location from them (that place may be another
 *   branch's); their quarantine list shows their branch's units.
 *
 * Errors: forbidden (403), not_found (404), invalid (400; fields serial = serial_mismatch | required, locationId,
 * supplierId, reason), item_inspected · rma_changed · serial_mismatch · return_exceeds_shipped · insufficient_stock ·
 * quarantine_resolved · no_suppliers (409).
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { assertCan, can, canAccessBranch, canAny, type Actor } from "~/server/actor";
import { audit, auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { auditEvents, inventoryLocations, orderItems, returnItems, returns, serials, stockMovements, supplierClaims, suppliers, warranties } from "~/server/db/schema";
import { batchSql, expectChanged, expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { exitQuarantine, returnGoodsStatements, translateReturnGoodsError, type ReturnGoodsTarget } from "~/server/services/returns/receive.server";
import { DAY_MS, assertLocationBranch, branchLimited, lineName, returnById, returnLocations } from "./shared.server";
import { CONDITION_LIST, DECISION_LIST, SLA, decisionAction, type Condition, type Decision, type QuarantineRow } from "./types";

export const INSPECT_ERROR_KEYS = ["item_inspected", "serial_mismatch", "quarantine_resolved", "no_suppliers"] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID, "invalid");

/** A serial as a person scans or types it: upper case, no spaces. */
export const normalizeSerial = (value: string) => value.toUpperCase().replace(/\s+/g, "");

export const InspectInput = z.object({
  returnId: idSchema,
  itemId: idSchema,
  condition: z.enum(CONDITION_LIST, "required"),
  decision: z.enum(DECISION_LIST, "required"),
  /** restock: a sellable location (optional, default where it left from); refurbish / return_to_supplier: a quarantine location. */
  locationId: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((value) => value || undefined),
  /** The serial scanned from the unit (required for serial-tracked units). */
  serial: z.string().trim().max(60, "too_long").optional(),
  notes: z.string().trim().max(1000, "too_long").optional(),
});
export type InspectInput = z.input<typeof InspectInput>;

function targetOf(decision: Decision, locationId: string | undefined): ReturnGoodsTarget | null {
  switch (decision) {
    case "restock":
      return { kind: "restock", locationId: locationId ?? null };
    case "refurbish":
    case "return_to_supplier":
      if (!locationId) throw invalid({ locationId: "required" });
      return { kind: "quarantine", locationId };
    case "scrap":
      return { kind: "scrap" };
    case "keep":
      return null;
  }
}

/** Inspects one unit of an RMA (see the file header). Repeating the same inspection is a no-op (`replayed`). */
export async function inspectItem(db: Db, actor: Actor, raw: InspectInput, now: number): Promise<{ replayed: boolean; status: string }> {
  assertCan(actor, "returns.rma.inspect");
  const input = InspectInput.parse(raw);
  const ret = await returnById(db, input.returnId);
  const item = await db
    .select({ id: returnItems.id, orderItemId: returnItems.orderItemId, qty: returnItems.qty, serialId: returnItems.serialId, condition: returnItems.condition, inspectedBy: returnItems.inspectedBy, restockAction: returnItems.restockAction, lineQty: orderItems.qty, usedUnitId: orderItems.usedUnitId })
    .from(returnItems)
    .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
    .where(and(eq(returnItems.id, input.itemId), eq(returnItems.returnId, ret.id)))
    .get();
  if (!item) throw notFound("return_item");
  if (item.inspectedBy) {
    if (item.condition === input.condition && (item.restockAction ?? "keep") === input.decision) return { replayed: true, status: ret.status };
    throw new AppError("item_inspected", 409, { detail: item.id });
  }
  if (!["approved", "in_transit", "received"].includes(ret.status)) throw new AppError("rma_changed", 409, { detail: ret.status });

  if (item.serialId) {
    const unit = await db.select({ serial: serials.serial }).from(serials).where(eq(serials.id, item.serialId)).get();
    const scanned = normalizeSerial(input.serial ?? "");
    if (!scanned) throw invalid({ serial: "required" });
    if (!unit || normalizeSerial(unit.serial) !== scanned) {
      // Recorded on its own (the inspection itself is refused): a swapped unit is a fraud signal for this RMA.
      await audit(db, { actor, action: "returns.rma.serial_mismatch", entityType: "return", entityId: ret.id, summary: ret.rma, after: { itemId: item.id, expectedSerialId: item.serialId, scannedSerial: scanned.slice(0, 60) }, at: now });
      throw new AppError("serial_mismatch", 409, { fields: { serial: "serial_mismatch" } });
    }
  }

  // A used device goes back to the devices team (status "returned", re-inspected and listed by module 13) or is written off.
  if (item.usedUnitId && (input.decision === "refurbish" || input.decision === "return_to_supplier")) throw invalid({ decision: "used_unit_decision" });
  const target = targetOf(input.decision, input.locationId);
  if (target && target.kind !== "scrap") {
    if (target.locationId) await assertLocationBranch(db, actor, target.locationId);
    else if (branchLimited(actor)) throw invalid({ locationId: "required" });
  }
  const actorId = actor.kind === "employee" ? actor.id : actor.kind === "system" ? `system:${actor.job}` : null;
  const statements: BatchStatement[] = [
    db
      .update(returnItems)
      .set({ condition: input.condition, inspectedBy: actorId, notes: input.notes || null, restockAction: decisionAction(input.decision), restockedAt: target ? now : null })
      .where(and(eq(returnItems.id, item.id), isNull(returnItems.inspectedBy))),
    expectChanged(db, 1, { code: "ITEM_INSPECTED", detail: item.id }),
  ];
  if (target) {
    const goods = await returnGoodsStatements(db, {
      orderId: ret.orderId,
      lines: [{ orderItemId: item.orderItemId, qty: item.qty, serialIds: item.serialId ? [item.serialId] : undefined }],
      to: target,
      actor,
      now,
      key: `return_item:${item.id}`,
      refType: "return",
      refId: ret.id,
      reason: `${ret.rma}: ${input.condition} → ${input.decision}`,
    });
    statements.push(...goods.statements);
    // The unit is the store's again: its warranty ends (a whole line without serials only when every unit came back).
    if (item.serialId) {
      statements.push(
        db
          .update(warranties)
          .set({ status: "void", voidReason: `returned: ${ret.rma}` })
          .where(and(eq(warranties.orderItemId, item.orderItemId), eq(warranties.serialId, item.serialId), eq(warranties.status, "active"))),
      );
    } else if (item.qty >= item.lineQty) {
      statements.push(
        db
          .update(warranties)
          .set({ status: "void", voidReason: `returned: ${ret.rma}` })
          .where(and(eq(warranties.orderItemId, item.orderItemId), eq(warranties.status, "active"))),
      );
    }
  }
  statements.push(
    batchSql(
      db,
      sql`UPDATE returns SET
            status = CASE WHEN NOT EXISTS (SELECT 1 FROM return_items WHERE return_id = ${ret.id} AND inspected_by IS NULL) THEN 'inspected' ELSE 'received' END,
            received_at = coalesce(received_at, ${now}),
            inspected_at = CASE WHEN NOT EXISTS (SELECT 1 FROM return_items WHERE return_id = ${ret.id} AND inspected_by IS NULL) THEN ${now} ELSE inspected_at END,
            updated_at = ${now}
          WHERE id = ${ret.id} AND status IN ('approved', 'in_transit', 'received')`,
    ),
    expectChanged(db, 1, { code: "RMA_CHANGED", detail: ret.id }),
    auditStatement(db, {
      actor,
      action: "returns.rma.inspect",
      entityType: "return",
      entityId: ret.id,
      summary: ret.rma,
      before: { status: ret.status },
      after: { itemId: item.id, condition: input.condition, decision: input.decision, locationId: target && target.kind !== "scrap" ? (target.locationId ?? null) : null, units: item.qty, serialId: item.serialId },
      reason: input.notes || null,
      at: now,
    }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "ITEM_INSPECTED")) {
      const again = await db.select({ condition: returnItems.condition, restockAction: returnItems.restockAction }).from(returnItems).where(eq(returnItems.id, item.id)).get();
      if (again?.condition === input.condition && (again.restockAction ?? "keep") === input.decision) return { replayed: true, status: ret.status };
      throw new AppError("item_inspected", 409, { detail: item.id, cause: error });
    }
    if (isDbError(error, "RMA_CHANGED")) throw new AppError("rma_changed", 409, { detail: ret.id, cause: error });
    throw translateReturnGoodsError(error);
  }
  const after = await db.select({ status: returns.status }).from(returns).where(eq(returns.id, ret.id)).get();
  return { replayed: false, status: after?.status ?? ret.status };
}

// ───────────────────────────────────────────────────────────────── quarantine (12.07)

/** Where each inspected unit went (the inspection's audit event names the location). */
async function inspectionLocations(db: Db, itemIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (itemIds.length === 0) return out;
  const rows = await db
    .select({ after: auditEvents.after })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "returns.rma.inspect"), sql`json_extract(${auditEvents.after}, '$.itemId') IN (SELECT value FROM json_each(${JSON.stringify(itemIds)}))`));
  for (const row of rows) {
    const after = row.after as { itemId?: unknown; locationId?: unknown } | null;
    if (typeof after?.itemId === "string" && typeof after.locationId === "string") out.set(after.itemId, after.locationId);
  }
  return out;
}

export async function listQuarantine(
  db: Db,
  actor: Actor,
  locale: Locale,
  now: number,
): Promise<{ rows: QuarantineRow[]; sellable: { id: string; code: string; name: string }[]; suppliers: { id: string; code: string; name: string }[] | null; can: { release: boolean; scrap: boolean; supplier: boolean } }> {
  if (!canAny(actor, ["returns.rma.inspect", "returns.supplier_return.manage"])) throw forbidden("returns.rma.inspect");
  const rows = await db
    .select({
      id: returnItems.id,
      returnId: returnItems.returnId,
      rma: returns.rma,
      qty: returnItems.qty,
      serialId: returnItems.serialId,
      serial: serials.serial,
      condition: returnItems.condition,
      decision: returnItems.restockAction,
      restockedAt: returnItems.restockedAt,
      notes: returnItems.notes,
      name: orderItems.nameSnapshot,
      sku: orderItems.sku,
      variantId: orderItems.variantId,
    })
    .from(returnItems)
    .innerJoin(returns, eq(returns.id, returnItems.returnId))
    .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
    .leftJoin(serials, eq(serials.id, returnItems.serialId))
    .where(
      and(
        inArray(returnItems.restockAction, ["refurbish", "return_to_supplier"]),
        sql`${returnItems.restockedAt} IS NOT NULL`,
        sql`NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.ref_type = 'return_item' AND m.ref_id = "return_items"."id" AND m.qty_delta < 0)`,
      ),
    )
    .orderBy(asc(returnItems.restockedAt))
    .limit(300);
  const [where, locations, supplierRows] = await Promise.all([
    inspectionLocations(
      db,
      rows.map((row) => row.id),
    ),
    db.select({ id: inventoryLocations.id, code: inventoryLocations.code, name: inventoryLocations.name, branchId: inventoryLocations.branchId }).from(inventoryLocations),
    can(actor, "returns.supplier_return.manage") ? db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.status, "active")).orderBy(asc(suppliers.name)).limit(200) : Promise.resolve(null),
  ]);
  const locationById = new Map(locations.map(({ id, code, name, branchId }) => [id, { location: { id, code, name }, branchId }]));
  const { sellable } = await returnLocations(db, actor);
  // An employee limited to a branch sees (and moves) the units waiting in that branch's quarantine.
  const visible = branchLimited(actor) ? rows.filter((row) => canAccessBranch(actor, locationById.get(where.get(row.id) ?? "")?.branchId ?? null)) : rows;
  return {
    rows: visible.map((row) => {
      const since = row.restockedAt ?? now;
      const dueAt = since + SLA.quarantineDays * DAY_MS;
      const locationId = where.get(row.id) ?? null;
      return {
        itemId: row.id,
        rma: row.rma,
        returnId: row.returnId,
        name: lineName(row.name, locale),
        sku: row.sku,
        variantId: row.variantId,
        qty: row.qty,
        serial: row.serialId ? { id: row.serialId, serial: row.serial ?? "—" } : null,
        condition: (CONDITION_LIST as readonly string[]).includes(row.condition ?? "") ? (row.condition as Condition) : null,
        decision: (row.decision ?? "refurbish") as Decision,
        location: locationId ? (locationById.get(locationId)?.location ?? null) : null,
        since,
        dueAt,
        late: now > dueAt,
        notes: row.notes,
      };
    }),
    sellable,
    suppliers: supplierRows,
    can: {
      release: can(actor, "returns.rma.inspect"),
      scrap: can(actor, "returns.rma.inspect") && can(actor, "inventory.stock.adjust"),
      supplier: can(actor, "returns.supplier_return.manage"),
    },
  };
}

export const ResolveInput = z.object({
  itemId: idSchema,
  to: z.enum(["stock", "scrap", "supplier"], "required"),
  /** Back on sale: a sellable location. */
  locationId: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((value) => value || undefined),
  /** To the supplier: who takes it back. */
  supplierId: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((value) => value || undefined),
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
});
export type ResolveInput = z.input<typeof ResolveInput>;

/** Takes a quarantined unit out (see the file header). One exit per unit, guarded in the batch. */
export async function resolveQuarantine(db: Db, actor: Actor, raw: ResolveInput, now: number): Promise<{ claimRef: string | null; replayed: boolean }> {
  if (!canAny(actor, ["returns.rma.inspect", "returns.supplier_return.manage"])) throw forbidden("returns.rma.inspect");
  const input = ResolveInput.parse(raw);
  const item = await db
    .select({ id: returnItems.id, returnId: returnItems.returnId, qty: returnItems.qty, serialId: returnItems.serialId, decision: returnItems.restockAction, restockedAt: returnItems.restockedAt, variantId: orderItems.variantId, sku: orderItems.sku })
    .from(returnItems)
    .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
    .where(eq(returnItems.id, input.itemId))
    .get();
  if (!item || !item.restockedAt || (item.decision !== "refurbish" && item.decision !== "return_to_supplier" && item.decision !== "restock" && item.decision !== "scrap")) throw notFound("return_item");
  const exited = await db
    .select({ kind: stockMovements.kind })
    .from(stockMovements)
    .where(and(eq(stockMovements.refType, "return_item"), eq(stockMovements.refId, item.id), sql`${stockMovements.qtyDelta} < 0`))
    .get();
  if (exited) {
    const same = (input.to === "stock" && exited.kind === "transfer_out") || (input.to === "scrap" && exited.kind === "damage") || (input.to === "supplier" && exited.kind === "adjust");
    if (same) return { claimRef: null, replayed: true };
    throw new AppError("quarantine_resolved", 409, { detail: item.id });
  }
  if (item.decision !== "refurbish" && item.decision !== "return_to_supplier") throw notFound("return_item");
  const ret = await returnById(db, item.returnId);
  const fromLocationId = (await inspectionLocations(db, [item.id])).get(item.id);
  if (!fromLocationId) throw notFound("location");
  // The unit leaves a branch's quarantine, and goes back on sale at a branch: both must be this employee's.
  await assertLocationBranch(db, actor, fromLocationId);
  if (input.to === "stock" && input.locationId) await assertLocationBranch(db, actor, input.locationId);

  let claim: { id: string; ref: string; supplierId: string } | null = null;
  if (input.to === "supplier") {
    assertCan(actor, "returns.supplier_return.manage");
    if (!input.supplierId) {
      const any = await db.select({ id: suppliers.id }).from(suppliers).limit(1).get();
      if (!any) throw new AppError("no_suppliers", 409, { fields: { supplierId: "no_suppliers" } });
      throw invalid({ supplierId: "required" });
    }
    const supplier = await db.select({ id: suppliers.id, status: suppliers.status }).from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
    if (!supplier || supplier.status !== "active") throw invalid({ supplierId: "invalid" });
    claim = { id: newId("scl"), ref: publicRef("RTV"), supplierId: supplier.id };
  }
  if (input.to === "stock" && !input.locationId) throw invalid({ locationId: "required" });

  const to = input.to === "stock" ? { kind: "stock" as const, locationId: input.locationId as string } : input.to === "scrap" ? { kind: "scrap" as const } : { kind: "supplier" as const, reference: claim?.ref ?? "" };
  const createdBy = actor.kind === "employee" ? actor.id : null;
  await exitQuarantine(
    db,
    actor,
    { variantId: item.variantId, fromLocationId, qty: item.qty, serialIds: item.serialId ? [item.serialId] : undefined, to, refType: "return_item", refId: item.id, reason: `${ret.rma}: ${input.reason}`, key: `return_item:${item.id}` },
    now,
    () => [
      // One exit per unit: a second, concurrent exit of the same item finds the first one's movements here.
      expectThat(db, sql`(SELECT coalesce(-sum(qty_delta), 0) FROM stock_movements WHERE ref_type = 'return_item' AND ref_id = ${item.id} AND qty_delta < 0 AND location_id = ${fromLocationId}) <= ${item.qty}`, {
        code: "QUARANTINE_RESOLVED",
        detail: item.id,
      }),
      db
        .update(returnItems)
        .set({ restockAction: input.to === "stock" ? "restock" : input.to === "scrap" ? "scrap" : "return_to_supplier" })
        .where(eq(returnItems.id, item.id)),
      ...(claim
        ? [
            db.insert(supplierClaims).values({
              id: claim.id,
              ref: claim.ref,
              supplierId: claim.supplierId,
              kind: "return",
              status: "submitted",
              description: `${ret.rma} · ${item.sku}: ${input.reason}`.slice(0, 500),
              items: [{ variantId: item.variantId, qty: item.qty, ...(item.serialId ? { serialId: item.serialId } : {}) }],
              currency: "IQD",
              createdBy,
              createdAt: now,
            }),
          ]
        : []),
      auditStatement(db, {
        actor,
        action: input.to === "stock" ? "returns.quarantine.release" : input.to === "scrap" ? "returns.quarantine.scrap" : "returns.supplier_return.send",
        entityType: "return",
        entityId: ret.id,
        summary: ret.rma,
        before: { itemId: item.id, decision: item.decision, locationId: fromLocationId },
        after: { itemId: item.id, to: input.to, locationId: input.locationId ?? null, claimRef: claim?.ref ?? null },
        reason: input.reason,
        at: now,
      }),
    ],
  ).catch((error: unknown) => {
    if (isDbError(error, "QUARANTINE_RESOLVED")) throw new AppError("quarantine_resolved", 409, { detail: item.id, cause: error });
    throw error;
  });
  return { claimRef: claim?.ref ?? null, replayed: false };
}
