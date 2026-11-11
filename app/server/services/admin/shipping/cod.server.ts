/**
 * 11.04 — cash-on-delivery settlements with carriers: what each carrier's couriers collected on delivered parcels,
 * what the carrier charges, what it actually remitted, and the difference.
 *
 *   const list = await listSettlements(db, actor, { status, carrier }, locale);                shipping.cod.settle
 *   const parcels = await eligibleParcels(db, actor, carrierId, locale);                      parcels not settled yet
 *   const { settlementId } = await createSettlement(db, actor, { carrierId, shipmentIds, idempotencyKey }, now);
 *   await updateSettlementItem(db, actor, { settlementId, shipmentId, amountIqd, feeIqd, reason }, now);   draft only
 *   await submitCodSettlement(…) / reconcileCodSettlement(…)         ← the commerce core (orders/shipments.server.ts)
 *   await disputeSettlement / reopenSettlement / discardSettlement(…)
 *
 * A settlement is a DRAFT while it is put together from the carrier's statement: delivered parcels with the cash
 * collected (prefilled with the cash-on-delivery amount due) and every completed parcel (delivered or back) with the
 * carrier's charge (its rate when the waybill was made, plus the carrier's cash fee). A parcel belongs to one settlement
 * only (UNIQUE in the database). Submitting fixes the amount the carrier remitted; reconciling records the cash through
 * recordCodCollection and posts the journal entry — both in the commerce core, where the two-person rule for a
 * difference lives. Nothing here moves money.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { publicRef, sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { auditEvents, carriers, codSettlementItems, codSettlements, files, governorates, orders, shipments } from "~/server/db/schema";
import { expectChanged, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { SETTLEMENT_CORRECTION_ACTION, settlementNeedsSecondPerson, settlementPreparers } from "~/server/services/orders/shipments.server";
import { codOutstandingByCarrier } from "./carriers.server";
import { codFeeFor, parcelCode, parcelNumberOf, settlementTotals, type CodSettlementStatus, type SettlementItemView, type SettlementView } from "./rules";
import { codPayments, codViewOf, employeeNames, fileUrl, firstParcels, ID_PATTERN } from "./shared.server";

const idSchema = z.string().regex(ID_PATTERN, "invalid");
const reasonSchema = z.string().trim().min(3, "required").max(500, "too_long");

export type SettlementListRow = {
  id: string;
  ref: string;
  status: CodSettlementStatus;
  carrier: string;
  parcels: number;
  expectedIqd: number;
  feesIqd: number;
  receivedIqd: number | null;
  varianceIqd: number | null;
  createdAt: number;
  reconciledAt: number | null;
};

export type SettlementFilters = { status: CodSettlementStatus | "all"; carrier: string | null };

export function parseSettlementFilters(params: URLSearchParams): SettlementFilters {
  const status = params.get("status");
  const carrier = params.get("carrier");
  return {
    status: status && ["draft", "submitted", "reconciled", "disputed", "all"].includes(status) ? (status as SettlementFilters["status"]) : "all",
    carrier: carrier && ID_PATTERN.test(carrier) ? carrier : null,
  };
}

/** Settlements, newest first, with their totals (a draft has no amount received yet). */
export async function listSettlements(db: Db, actor: Actor, filters: SettlementFilters): Promise<SettlementListRow[]> {
  assertCan(actor, "shipping.cod.settle");
  const rows = await db
    .select({
      id: codSettlements.id,
      ref: codSettlements.ref,
      status: codSettlements.status,
      carrier: carriers.name,
      expectedIqd: codSettlements.expectedIqd,
      feesIqd: codSettlements.feesIqd,
      receivedIqd: codSettlements.receivedIqd,
      varianceIqd: codSettlements.varianceIqd,
      createdAt: codSettlements.createdAt,
      reconciledAt: codSettlements.reconciledAt,
      parcels: sql<number>`(SELECT count(*) FROM cod_settlement_items i WHERE i.settlement_id = ${codSettlements.id})`,
    })
    .from(codSettlements)
    .innerJoin(carriers, eq(carriers.id, codSettlements.carrierId))
    .where(and(filters.status === "all" ? undefined : eq(codSettlements.status, filters.status), filters.carrier ? eq(codSettlements.carrierId, filters.carrier) : undefined))
    .orderBy(desc(codSettlements.createdAt), desc(codSettlements.id))
    .limit(200);
  return rows.map((row) => {
    const known = row.status !== "draft";
    return { ...row, parcels: Number(row.parcels ?? 0), receivedIqd: known ? row.receivedIqd : null, varianceIqd: known ? row.varianceIqd : null };
  });
}

export type EligibleParcel = SettlementItemView & { suggestedFeeIqd: number; feeKnown: boolean };

/**
 * The carrier's completed parcels (delivered or back at the store) that no settlement holds: the cash each delivered
 * one brought (its order's cash-on-delivery amount, on the order's first parcel) and the carrier's suggested charge.
 */
export async function eligibleParcels(db: Db, actor: Actor, carrierId: string, locale: Locale): Promise<{ carrier: { id: string; name: string; codFeeIqd: number | null; codFeeBps: number | null }; parcels: EligibleParcel[] }> {
  assertCan(actor, "shipping.cod.settle");
  const carrier = await db.select().from(carriers).where(eq(carriers.id, idSchema.parse(carrierId))).get();
  if (!carrier) throw notFound("carrier");
  const rows = await db
    .select({ parcel: shipments, ref: orders.ref, paymentMethod: orders.paymentMethod, paidIqd: orders.paidIqd, totalIqd: orders.totalIqd, orderStatus: orders.status, governorateId: orders.governorateId, isDemo: orders.isDemo })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(eq(shipments.carrierId, carrier.id), inArray(shipments.status, ["delivered", "returned"]), isNull(shipments.codSettledAt), sql`NOT EXISTS (SELECT 1 FROM cod_settlement_items i WHERE i.shipment_id = ${shipments.id})`))
    .orderBy(asc(shipments.deliveredAt), asc(shipments.returnedAt), asc(shipments.id))
    .limit(300);
  const orderIds = [...new Set(rows.map((row) => row.parcel.orderId))];
  const [first, cod, govs] = await Promise.all([firstParcels(db, orderIds), codPayments(db, orderIds), db.select({ id: governorates.id, name: governorates.name }).from(governorates)]);
  return {
    carrier: { id: carrier.id, name: carrier.name, codFeeIqd: carrier.codFeeIqd, codFeeBps: carrier.codFeeBps },
    parcels: rows.map((row) => {
      const { parcel } = row;
      const view = codViewOf({ id: parcel.orderId, paymentMethod: row.paymentMethod, paidIqd: row.paidIqd, totalIqd: row.totalIqd, status: row.orderStatus }, parcel.id, first.get(parcel.orderId), cod.get(parcel.orderId));
      const payment = cod.get(parcel.orderId);
      const carries = parcel.status === "delivered" && (view.kind === "collect" || view.kind === "collected");
      const amountIqd = carries ? (view as { amountIqd: number }).amountIqd : 0;
      const suggestedFeeIqd = suggestedCharge(parcel.costIqd, amountIqd, carrier);
      const gov = row.governorateId ? govs.find((entry) => entry.id === row.governorateId) : undefined;
      return {
        shipmentId: parcel.id,
        code: parcelCode(row.ref, parcelNumberOf(parcel.orderId, parcel.id) || 1),
        orderId: parcel.orderId,
        ref: row.ref,
        status: parcel.status,
        governorate: gov ? pick(gov.name, locale) : null,
        completedAt: parcel.deliveredAt ?? parcel.returnedAt,
        dueIqd: carries ? (payment?.amountIqd ?? null) : null,
        paymentStatus: carries ? (payment?.status ?? null) : null,
        amountIqd,
        feeIqd: suggestedFeeIqd,
        rateIqd: parcel.costIqd,
        suggestedFeeIqd,
        feeKnown: parcel.costIqd !== null,
        isDemo: row.isDemo,
      };
    }),
  };
}

export const CreateSettlementInput = z.object({
  carrierId: idSchema,
  shipmentIds: z.array(idSchema).min(1, "required").max(300),
  notes: z
    .string()
    .trim()
    .max(1000, "too_long")
    .optional()
    .transform((value) => value || null),
  /** One per form render: a resubmission returns the same draft. */
  idempotencyKey: z.string().trim().min(8, "too_short").max(200, "too_long"),
});
export type CreateSettlementInput = z.input<typeof CreateSettlementInput>;

/** A draft settlement for these parcels of the carrier, prefilled from the order payments and the carrier's charges. */
export async function createSettlement(db: Db, actor: Actor, raw: CreateSettlementInput, now: number, locale: Locale = "ar"): Promise<{ settlementId: string; ref: string; replayed: boolean }> {
  assertCan(actor, "shipping.cod.settle");
  const input = CreateSettlementInput.parse(raw);
  const { actorId } = actorRef(actor);
  const id = `cst_${(await sha256Hex(`${actorId ?? "system"}:${input.idempotencyKey}`)).slice(0, 26)}`;
  const existing = await db.select({ id: codSettlements.id, ref: codSettlements.ref }).from(codSettlements).where(eq(codSettlements.id, id)).get();
  if (existing) return { settlementId: existing.id, ref: existing.ref, replayed: true };
  const { parcels } = await eligibleParcels(db, actor, input.carrierId, locale);
  const wanted = new Set(input.shipmentIds);
  const chosen = parcels.filter((parcel) => wanted.has(parcel.shipmentId));
  if (chosen.length !== wanted.size) throw new AppError("parcel_not_eligible", 409, { detail: [...wanted].filter((id) => !chosen.some((parcel) => parcel.shipmentId === id)).join(", ") });
  if (new Set(chosen.map((parcel) => parcel.isDemo)).size > 1) throw new AppError("settlement_mixed_demo", 409);
  const totals = settlementTotals(chosen, null);
  const deliveredAt = chosen.map((parcel) => parcel.completedAt).filter((at): at is number => at !== null);
  const ref = publicRef("CS");
  const statements: BatchStatement[] = [
    db.insert(codSettlements).values({
      id,
      ref,
      carrierId: input.carrierId,
      periodFrom: deliveredAt.length ? Math.min(...deliveredAt) : null,
      periodTo: deliveredAt.length ? Math.max(...deliveredAt) : null,
      expectedIqd: totals.expectedIqd,
      feesIqd: totals.feesIqd,
      receivedIqd: 0,
      varianceIqd: 0,
      status: "draft",
      notes: input.notes,
      createdBy: actorId,
      createdAt: now,
    }),
    ...chosen.map((parcel) => db.insert(codSettlementItems).values({ settlementId: id, shipmentId: parcel.shipmentId, amountIqd: parcel.amountIqd, feeIqd: parcel.feeIqd })),
    auditStatement(db, {
      actor,
      action: "shipping.cod.create",
      entityType: "cod_settlement",
      entityId: id,
      summary: `${ref}: draft with ${chosen.length} parcel(s)`,
      after: { carrierId: input.carrierId, parcels: chosen.map((parcel) => parcel.code), expectedIqd: totals.expectedIqd, feesIqd: totals.feesIqd },
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isUniqueViolation(error, "cod_settlements.id")) {
      const again = await db.select({ id: codSettlements.id, ref: codSettlements.ref }).from(codSettlements).where(eq(codSettlements.id, id)).get();
      if (again) return { settlementId: again.id, ref: again.ref, replayed: true };
    }
    if (isUniqueViolation(error, "cod_settlement_items.shipment_id")) throw new AppError("parcel_already_settled", 409, { cause: error });
    throw error;
  }
  return { settlementId: id, ref, replayed: false };
}

/** Recomputes a draft's stored totals from its parcels (in the same batch as the change). */
function totalsStatement(db: Db, settlementId: string) {
  return db
    .update(codSettlements)
    .set({
      expectedIqd: sql`(SELECT coalesce(sum(amount_iqd), 0) FROM cod_settlement_items WHERE settlement_id = ${settlementId})`,
      feesIqd: sql`(SELECT coalesce(sum(fee_iqd), 0) FROM cod_settlement_items WHERE settlement_id = ${settlementId})`,
    })
    .where(and(eq(codSettlements.id, settlementId), eq(codSettlements.status, "draft")));
}

async function draftOf(db: Db, settlementId: string) {
  const settlement = await db.select().from(codSettlements).where(eq(codSettlements.id, idSchema.parse(settlementId))).get();
  if (!settlement) throw notFound("cod_settlement");
  if (settlement.status !== "draft") throw new AppError("settlement_not_draft", 409, { detail: settlement.status });
  return settlement;
}

export const ItemInput = z.object({
  settlementId: idSchema,
  shipmentId: idSchema,
  /** The cash the courier collected for this parcel, as the carrier's statement says. */
  amountIqd: z.number().int("invalid").min(0, "too_small").max(1_000_000_000, "too_big"),
  /** What the carrier charges for the parcel. */
  feeIqd: z.number().int("invalid").min(0, "too_small").max(10_000_000, "too_big"),
  /** Required when the cash collected differs from what was due, or the charge from the carrier's rate and cash fee. */
  reason: z
    .string()
    .trim()
    .max(500, "too_long")
    .optional()
    .transform((value) => value || undefined),
});
export type ItemInput = z.input<typeof ItemInput>;

/** What the carrier should charge for a parcel: its rate on the waybill plus its cash fee on what it collected. */
export function suggestedCharge(parcelCostIqd: number | null, collectedIqd: number, carrier: { codFeeIqd: number | null; codFeeBps: number | null }): number {
  return (parcelCostIqd ?? 0) + codFeeFor(collectedIqd, carrier);
}

/**
 * One parcel's cash and charge in a draft. Cash only on a delivered parcel that carries its order's cash. A correction
 * — cash other than what was due, a charge other than the carrier's rate and cash fee — needs a reason, and makes the
 * settlement a two-person decision at reconciliation (the core's rule; this change is its audit trail).
 */
export async function updateSettlementItem(db: Db, actor: Actor, raw: ItemInput, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "shipping.cod.settle");
  const input = ItemInput.parse(raw);
  const settlement = await draftOf(db, input.settlementId);
  const item = await db
    .select({ amountIqd: codSettlementItems.amountIqd, feeIqd: codSettlementItems.feeIqd, parcel: shipments, paymentMethod: orders.paymentMethod, paidIqd: orders.paidIqd, totalIqd: orders.totalIqd, orderStatus: orders.status, ref: orders.ref })
    .from(codSettlementItems)
    .innerJoin(shipments, eq(shipments.id, codSettlementItems.shipmentId))
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(eq(codSettlementItems.settlementId, settlement.id), eq(codSettlementItems.shipmentId, input.shipmentId)))
    .get();
  if (!item) throw notFound("settlement_item");
  if (item.amountIqd === input.amountIqd && item.feeIqd === input.feeIqd) return { changed: false };
  const orderId = item.parcel.orderId;
  const [first, cod] = await Promise.all([firstParcels(db, [orderId]), codPayments(db, [orderId])]);
  const view = codViewOf({ id: orderId, paymentMethod: item.paymentMethod, paidIqd: item.paidIqd, totalIqd: item.totalIqd, status: item.orderStatus }, item.parcel.id, first.get(orderId), cod.get(orderId));
  const carries = item.parcel.status === "delivered" && (view.kind === "collect" || view.kind === "collected");
  if (!carries && input.amountIqd !== 0) throw invalid({ amountIqd: "settlement_no_cash" });
  if (carries && view.kind === "collected" && input.amountIqd !== view.amountIqd) throw invalid({ amountIqd: "settlement_amount_recorded" });
  if (carries && input.amountIqd === 0) throw invalid({ amountIqd: "settlement_cash_missing" });
  const due = carries ? (view as { amountIqd: number }).amountIqd : 0;
  const carrier = await db.select({ codFeeIqd: carriers.codFeeIqd, codFeeBps: carriers.codFeeBps }).from(carriers).where(eq(carriers.id, settlement.carrierId)).get();
  const suggested = suggestedCharge(item.parcel.costIqd, input.amountIqd, carrier ?? { codFeeIqd: null, codFeeBps: null });
  if ((input.amountIqd !== due || input.feeIqd !== suggested) && (input.reason ?? "").length < 3) throw invalid({ reason: "required" });
  try {
    await runBatch(db, [
      db
        .update(codSettlementItems)
        .set({ amountIqd: input.amountIqd, feeIqd: input.feeIqd })
        .where(and(eq(codSettlementItems.settlementId, settlement.id), eq(codSettlementItems.shipmentId, input.shipmentId), eq(codSettlementItems.amountIqd, item.amountIqd), eq(codSettlementItems.feeIqd, item.feeIqd))),
      expectChanged(db, 1, { code: "SETTLEMENT_CHANGED", detail: settlement.id }),
      totalsStatement(db, settlement.id),
      expectChanged(db, 1, { code: "SETTLEMENT_CHANGED", detail: settlement.id }),
      auditStatement(db, {
        actor,
        action: SETTLEMENT_CORRECTION_ACTION,
        entityType: "cod_settlement",
        entityId: settlement.id,
        summary: `${settlement.ref}: ${parcelCode(item.ref, parcelNumberOf(orderId, item.parcel.id) || 1)}`,
        before: { amountIqd: item.amountIqd, feeIqd: item.feeIqd },
        after: { amountIqd: input.amountIqd, feeIqd: input.feeIqd, dueIqd: due, suggestedFeeIqd: suggested },
        reason: input.reason ?? null,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "SETTLEMENT_CHANGED")) throw new AppError("settlement_changed", 409, { detail: settlement.id, cause: error });
    throw error;
  }
  return { changed: true };
}

export const RemoveItemsInput = z.object({ settlementId: idSchema, shipmentIds: z.array(idSchema).min(1, "required").max(300) });
export type RemoveItemsInput = z.input<typeof RemoveItemsInput>;

/** Takes parcels out of a draft (they become eligible again). */
export async function removeSettlementItems(db: Db, actor: Actor, raw: RemoveItemsInput, now: number): Promise<{ removed: number }> {
  assertCan(actor, "shipping.cod.settle");
  const input = RemoveItemsInput.parse(raw);
  const settlement = await draftOf(db, input.settlementId);
  const present = await db
    .select({ shipmentId: codSettlementItems.shipmentId })
    .from(codSettlementItems)
    .where(and(eq(codSettlementItems.settlementId, settlement.id), inArray(codSettlementItems.shipmentId, input.shipmentIds)));
  if (present.length === 0) return { removed: 0 };
  await runBatch(db, [
    db.delete(codSettlementItems).where(and(eq(codSettlementItems.settlementId, settlement.id), inArray(codSettlementItems.shipmentId, present.map((row) => row.shipmentId)))),
    totalsStatement(db, settlement.id),
    expectChanged(db, 1, { code: "SETTLEMENT_CHANGED", detail: settlement.id }),
    auditStatement(db, { actor, action: "shipping.cod.remove", entityType: "cod_settlement", entityId: settlement.id, after: { removed: present.map((row) => row.shipmentId) }, at: now }),
  ]);
  return { removed: present.length };
}

export const DisputeInput = z.object({ settlementId: idSchema, note: reasonSchema });
export type DisputeInput = z.input<typeof DisputeInput>;

/** A submitted settlement the carrier's numbers do not explain: held as disputed (nothing is posted). */
export async function disputeSettlement(db: Db, actor: Actor, raw: DisputeInput, now: number): Promise<void> {
  assertCan(actor, "shipping.cod.settle");
  const input = DisputeInput.parse(raw);
  const settlement = await db.select().from(codSettlements).where(eq(codSettlements.id, input.settlementId)).get();
  if (!settlement) throw notFound("cod_settlement");
  if (settlement.status === "disputed") return;
  if (settlement.status !== "submitted") throw new AppError("settlement_not_submitted", 409, { detail: settlement.status });
  await runBatch(db, [
    db
      .update(codSettlements)
      .set({ status: "disputed", notes: (settlement.notes ? `${settlement.notes}\n${input.note}` : input.note).slice(0, 2000) })
      .where(and(eq(codSettlements.id, settlement.id), eq(codSettlements.status, "submitted"))),
    expectChanged(db, 1, { code: "SETTLEMENT_CHANGED", detail: settlement.id }),
    auditStatement(db, { actor, action: "shipping.cod.dispute", entityType: "cod_settlement", entityId: settlement.id, before: { status: "submitted" }, after: { status: "disputed", varianceIqd: settlement.varianceIqd }, reason: input.note, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "SETTLEMENT_CHANGED")) throw new AppError("settlement_changed", 409, { detail: settlement.id, cause: error });
    throw error;
  });
}

export const ReopenInput = z.object({ settlementId: idSchema, reason: reasonSchema });
export type ReopenInput = z.input<typeof ReopenInput>;

/** A submitted or disputed settlement back to a draft (parcels and charges can change again; nothing was posted). */
export async function reopenSettlement(db: Db, actor: Actor, raw: ReopenInput, now: number): Promise<void> {
  assertCan(actor, "shipping.cod.settle");
  const input = ReopenInput.parse(raw);
  const settlement = await db.select().from(codSettlements).where(eq(codSettlements.id, input.settlementId)).get();
  if (!settlement) throw notFound("cod_settlement");
  if (settlement.status === "draft") return;
  if (settlement.status !== "submitted" && settlement.status !== "disputed") throw new AppError("settlement_not_submitted", 409, { detail: settlement.status });
  await runBatch(db, [
    db.update(codSettlements).set({ status: "draft" }).where(and(eq(codSettlements.id, settlement.id), eq(codSettlements.status, settlement.status))),
    expectChanged(db, 1, { code: "SETTLEMENT_CHANGED", detail: settlement.id }),
    auditStatement(db, { actor, action: "shipping.cod.reopen", entityType: "cod_settlement", entityId: settlement.id, before: { status: settlement.status }, after: { status: "draft" }, reason: input.reason, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "SETTLEMENT_CHANGED")) throw new AppError("settlement_changed", 409, { detail: settlement.id, cause: error });
    throw error;
  });
}

/** Throws a draft away (its parcels become eligible again). Only drafts: nothing was submitted or posted. */
export async function discardSettlement(db: Db, actor: Actor, raw: ReopenInput, now: number): Promise<void> {
  assertCan(actor, "shipping.cod.settle");
  const input = ReopenInput.parse(raw);
  const settlement = await draftOf(db, input.settlementId);
  const items = await db.select({ shipmentId: codSettlementItems.shipmentId }).from(codSettlementItems).where(eq(codSettlementItems.settlementId, settlement.id));
  await runBatch(db, [
    db.delete(codSettlementItems).where(eq(codSettlementItems.settlementId, settlement.id)),
    db.delete(codSettlements).where(and(eq(codSettlements.id, settlement.id), eq(codSettlements.status, "draft"))),
    expectChanged(db, 1, { code: "SETTLEMENT_CHANGED", detail: settlement.id }),
    auditStatement(db, { actor, action: "shipping.cod.discard", entityType: "cod_settlement", entityId: settlement.id, before: { ref: settlement.ref, parcels: items.map((row) => row.shipmentId), expectedIqd: settlement.expectedIqd, feesIqd: settlement.feesIqd }, reason: input.reason, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "SETTLEMENT_CHANGED")) throw new AppError("settlement_changed", 409, { detail: settlement.id, cause: error });
    throw error;
  });
}

export const StatementInput = z.object({ settlementId: idSchema, fileId: idSchema });

/**
 * Throws what attachStatement would refuse BEFORE a photo is stored: the permission, a settlement that does not exist
 * or is already in the books (the route calls it ahead of the upload, so a refused request keeps no file).
 */
export async function assertStatementOpen(db: Db, actor: Actor, settlementId: string): Promise<void> {
  assertCan(actor, "shipping.cod.settle");
  const settlement = await db.select({ status: codSettlements.status }).from(codSettlements).where(eq(codSettlements.id, idSchema.parse(settlementId))).get();
  if (!settlement) throw notFound("cod_settlement");
  if (settlement.status === "reconciled") throw new AppError("settlement_not_draft", 409, { detail: settlement.status });
}

/** The carrier's statement (a photo, private) on the settlement. */
export async function attachStatement(db: Db, actor: Actor, raw: z.input<typeof StatementInput>, now: number): Promise<void> {
  assertCan(actor, "shipping.cod.settle");
  const input = StatementInput.parse(raw);
  const settlement = await db.select().from(codSettlements).where(eq(codSettlements.id, input.settlementId)).get();
  if (!settlement) throw notFound("cod_settlement");
  if (settlement.status === "reconciled") throw new AppError("settlement_not_draft", 409, { detail: settlement.status });
  const file = await db.select().from(files).where(and(eq(files.id, input.fileId), isNull(files.deletedAt))).get();
  if (!file || file.kind !== "cod_statement" || file.visibility !== "private" || (file.ownerType !== null && !(file.ownerType === "cod_settlement" && file.ownerId === settlement.id))) throw invalid({ file: "file_invalid" });
  await runBatch(db, [
    db.update(codSettlements).set({ statementFileId: file.id }).where(eq(codSettlements.id, settlement.id)),
    db.update(files).set({ ownerType: "cod_settlement", ownerId: settlement.id }).where(eq(files.id, file.id)),
    auditStatement(db, { actor, action: "shipping.cod.statement", entityType: "cod_settlement", entityId: settlement.id, before: { statementFileId: settlement.statementFileId }, after: { statementFileId: file.id }, at: now }),
  ]);
}

/** One settlement with its parcels, totals, who did what, and what this employee may do next. */
export async function getSettlement(db: Db, actor: Actor, settlementId: string, locale: Locale): Promise<SettlementView> {
  assertCan(actor, "shipping.cod.settle");
  const settlement = await db.select().from(codSettlements).where(eq(codSettlements.id, idSchema.parse(settlementId))).get();
  if (!settlement) throw notFound("cod_settlement");
  const carrier = await db.select().from(carriers).where(eq(carriers.id, settlement.carrierId)).get();
  if (!carrier) throw notFound("carrier");
  const rows = await db
    .select({ item: codSettlementItems, parcel: shipments, ref: orders.ref, paymentMethod: orders.paymentMethod, paidIqd: orders.paidIqd, totalIqd: orders.totalIqd, orderStatus: orders.status, governorateId: orders.governorateId, isDemo: orders.isDemo })
    .from(codSettlementItems)
    .innerJoin(shipments, eq(shipments.id, codSettlementItems.shipmentId))
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(codSettlementItems.settlementId, settlement.id))
    .orderBy(asc(orders.ref));
  const orderIds = [...new Set(rows.map((row) => row.parcel.orderId))];
  const [first, cod, govs, preparers, history] = await Promise.all([
    firstParcels(db, orderIds),
    codPayments(db, orderIds),
    db.select({ id: governorates.id, name: governorates.name }).from(governorates),
    settlementPreparers(db, settlement.id),
    db
      .select({ id: auditEvents.id, action: auditEvents.action, actorId: auditEvents.actorId, actorLabel: auditEvents.actorLabel, reason: auditEvents.reason, at: auditEvents.at })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "cod_settlement"), eq(auditEvents.entityId, settlement.id)))
      .orderBy(asc(auditEvents.seq))
      .limit(100),
  ]);
  const submittedBy = preparers.submitter;
  const names = await employeeNames(db, [settlement.createdBy, settlement.reconciledBy, submittedBy, ...history.map((row) => row.actorId)]);
  const items: SettlementItemView[] = rows.map((row) => {
    const view = codViewOf({ id: row.parcel.orderId, paymentMethod: row.paymentMethod, paidIqd: row.paidIqd, totalIqd: row.totalIqd, status: row.orderStatus }, row.parcel.id, first.get(row.parcel.orderId), cod.get(row.parcel.orderId));
    const carries = row.parcel.status === "delivered" && (view.kind === "collect" || view.kind === "collected");
    const payment = cod.get(row.parcel.orderId);
    const gov = row.governorateId ? govs.find((entry) => entry.id === row.governorateId) : undefined;
    return {
      shipmentId: row.parcel.id,
      code: parcelCode(row.ref, parcelNumberOf(row.parcel.orderId, row.parcel.id) || 1),
      orderId: row.parcel.orderId,
      ref: row.ref,
      status: row.parcel.status,
      governorate: gov ? pick(gov.name, locale) : null,
      completedAt: row.parcel.deliveredAt ?? row.parcel.returnedAt,
      dueIqd: carries ? (payment?.amountIqd ?? null) : null,
      paymentStatus: carries ? (payment?.status ?? null) : null,
      amountIqd: row.item.amountIqd,
      feeIqd: row.item.feeIqd,
      rateIqd: row.parcel.costIqd,
      isDemo: row.isDemo,
    };
  });
  const received = settlement.status === "draft" ? null : settlement.receivedIqd;
  const totals = settlementTotals(items, received);
  const { actorId } = actorRef(actor);
  const variance = totals.varianceIqd ?? 0;
  const rule = settlementNeedsSecondPerson({ createdBy: settlement.createdBy, varianceIqd: variance }, preparers, actorId);
  const hasPending = items.some((item) => item.amountIqd > 0 && item.paymentStatus === "pending");
  const canRecord = can(actor, "orders.payment.record");
  const reconcileBlock: "self" | "permission" | null = settlement.status !== "submitted" ? null : rule.needsSecond && rule.involved ? "self" : hasPending && !canRecord ? "permission" : null;
  return {
    id: settlement.id,
    ref: settlement.ref,
    status: settlement.status,
    carrier: { id: carrier.id, name: carrier.name, codFeeIqd: carrier.codFeeIqd, codFeeBps: carrier.codFeeBps },
    periodFrom: settlement.periodFrom,
    periodTo: settlement.periodTo,
    totals,
    receivedIqd: received,
    notes: settlement.notes,
    statementUrl: settlement.statementFileId ? fileUrl(settlement.statementFileId) : null,
    createdBy: settlement.createdBy ? (names.get(settlement.createdBy) ?? null) : null,
    createdAt: settlement.createdAt,
    submittedBy: submittedBy ? (names.get(submittedBy) ?? null) : null,
    reconciledBy: settlement.reconciledBy ? (names.get(settlement.reconciledBy) ?? null) : null,
    reconciledAt: settlement.reconciledAt,
    journalEntryId: settlement.journalEntryId,
    items,
    corrected: preparers.corrected,
    secondPerson: rule.needsSecond,
    history: history.map((row) => ({ id: row.id, action: row.action, actor: row.actorId ? (names.get(row.actorId) ?? row.actorLabel) : row.actorLabel, reason: row.reason, at: row.at })),
    can: {
      edit: settlement.status === "draft",
      submit: settlement.status === "draft" || settlement.status === "disputed",
      reconcile: settlement.status === "submitted" && reconcileBlock === null,
      reconcileReason: reconcileBlock,
      dispute: settlement.status === "submitted",
      reopen: settlement.status === "submitted" || settlement.status === "disputed",
      discard: settlement.status === "draft",
      recordCod: canRecord,
    },
  };
}

/** Per active carrier: parcels waiting for a settlement and the cash its couriers hold (for the settlements page). */
export async function settlementBacklog(db: Db, actor: Actor): Promise<{ carrierId: string; name: string; parcels: number; cashIqd: number }[]> {
  assertCan(actor, "shipping.cod.settle");
  const rows = await db
    .select({
      carrierId: carriers.id,
      name: carriers.name,
      parcels: sql<number>`count(${shipments.id})`,
    })
    .from(carriers)
    .innerJoin(shipments, and(eq(shipments.carrierId, carriers.id), inArray(shipments.status, ["delivered", "returned"]), isNull(shipments.codSettledAt), sql`NOT EXISTS (SELECT 1 FROM cod_settlement_items i WHERE i.shipment_id = ${shipments.id})`))
    .where(isNotNull(carriers.id))
    .groupBy(carriers.id, carriers.name)
    .orderBy(asc(carriers.name));
  const cash = await codOutstandingByCarrier(db);
  return rows.map((row) => ({ carrierId: row.carrierId, name: row.name, parcels: Number(row.parcels ?? 0), cashIqd: cash.get(row.carrierId) ?? 0 }));
}
