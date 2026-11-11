/**
 * Landed cost (admin 03.02; purchasing 09.05 calls the same functions when it receives goods): freight, customs,
 * insurance, fees and commissions billed for a receipt, spread over the receipt's lines so that each unit carries
 * its share — exactly: the shares of a bill add up to the bill to the dinar (rules.ts → planAllocation).
 *
 *   const { landedCostId } = await addLandedCost(db, actor, { receiptId, kind: "freight", currency: "USD", amount: "420",
 *                                                             fxRate: "1310", method: "by_value", reason, idempotencyKey }, now);
 *   const plan = await previewAllocation(db, actor, { landedCostId }, now);          // shares per line, nothing written
 *   await allocateLandedCost(db, actor, { landedCostId, updateVariantCosts: true }, now);
 *
 * Purchasing (09) may also build the statements into its own receiving batch: allocationStatements(db, …).
 *
 * WHAT ALLOCATING WRITES (one batch, receipt still a draft — guarded):
 *   landed_cost_allocations   one row per line (replacing the bill's earlier shares), amount + per unit
 *   landed_costs.status       "allocated"
 *   receipt_items             landed_unit_cost_iqd = unit_cost_iqd + Σ per-unit shares of every allocated bill
 *   variant_costs (optional)  the SKU's landed cost becomes this receipt's landed unit cost (the cost it was bought at
 *                             now), keeping its margin rules; the supplier currency and rate come from the line and PO
 *   audit_events              before/after per line
 * The goods are then received with that landed unit cost (receiveStock(…, unitCostIqd)), so the FIFO layers and the
 * cost of goods sold carry it. A receipt that is already POSTED is refused (`receipt_posted`): its layers exist, and
 * revaluing them is a commerce-core operation that does not exist yet (requested, docs/areas/admin-pricing.md).
 *
 * REMOVING a bill takes its shares off the lines; a SKU whose landed cost is still the one this receipt's line gave it
 * follows the line back (a cost typed in since is left alone). Allocating and removing are guarded on the receipt's
 * other allocated bills: two people spreading two bills at once cannot drop each other's share (`cost_changed`).
 *
 * Permissions: cost.read and (pricing.cost.update or purchasing.landed_cost.allocate); an employee limited to a branch
 * works only on receipts of that branch's locations (403). A bill is acted on through its own receipt only: pass
 * `receiptId` (the page does) and a bill of another receipt is not found. Everything here is [P].
 * Error codes: forbidden (403), not_found (404), invalid (400; amount too_big above MAX_BILL_IQD), receipt_posted (409),
 * allocation_basis_zero, line_value_missing, line_weight_missing, manual_sum_mismatch, manual_line_unknown (409),
 * cost_changed (409).
 */
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertBranch, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  inventoryLocations,
  landedCostAllocations,
  landedCosts,
  LANDED_COST_KINDS,
  products,
  purchaseOrders,
  receiptItems,
  receipts,
  suppliers,
  variantCosts,
  variants,
  type LandedCostKind,
} from "~/server/db/schema";
import { expectThat, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { actorId, assertAny } from "./access";
import { chunks, costRowsFor } from "./facts.server";
import { baghdadDate } from "./fx.server";
import { ALLOCATION_METHODS, AllocationError, COST_CURRENCIES, isCostCurrency, parseDecimal, parseRateMicros, planAllocation, purchaseCostIqd, type AllocationLine, type AllocationMethod, type CostCurrency, type PlannedShare } from "./rules";

/** The largest bill a form accepts (10 billion IQD): a typo guard that keeps every amount an exact integer. */
export const MAX_BILL_IQD = 10_000_000_000;

function assertLandedAccess(actor: Actor): void {
  assertCan(actor, "cost.read");
  assertAny(actor, ["pricing.cost.update", "purchasing.landed_cost.allocate"]);
}

/** The branch a receipt belongs to (through its location), or undefined when the receipt does not exist. */
async function receiptBranch(db: Db, receiptId: string): Promise<{ branchId: string | null } | undefined> {
  return db.select({ branchId: inventoryLocations.branchId }).from(receipts).innerJoin(inventoryLocations, eq(inventoryLocations.id, receipts.locationId)).where(eq(receipts.id, receiptId)).get();
}

/**
 * The other allocated bills of a receipt as "count:Σ amount:Σ per unit" — in SQL for a batch guard, and from the rows a
 * plan was made on. A difference means another bill was spread or removed meanwhile.
 */
const othersFingerprintSql = (receiptId: string, billId: string): SQL =>
  sql`(select count(*) || ':' || coalesce(sum(a.amount_iqd), 0) || ':' || coalesce(sum(a.per_unit_iqd), 0) from landed_cost_allocations a join landed_costs c on c.id = a.landed_cost_id where c.receipt_id = ${receiptId} and c.status = 'allocated' and c.id <> ${billId})`;

function othersGuard(db: Db, context: BillContext): BatchStatement {
  return expectThat(db, sql`${othersFingerprintSql(context.receipt.id, context.bill.id)} = ${context.othersFingerprint}`, { code: "COST_CHANGED", detail: context.receipt.id });
}

const toAllocationError = (error: unknown): unknown => (error instanceof AllocationError ? new AppError(error.code, 409, { detail: error.lineId }) : error);

// ───────────────────────────────────────────────────────────────── reading

export type ReceiptSummary = {
  id: string;
  ref: string;
  status: "draft" | "posted" | "cancelled";
  supplier: string | null;
  poRef: string | null;
  location: string;
  receivedAt: number | null;
  createdAt: number;
  lines: number;
  units: number;
  /** Σ units × purchase unit cost in IQD; null when a line has no unit cost yet. */
  goodsIqd: number | null;
  billsIqd: number;
  billsDraft: number;
  billsAllocated: number;
};

export async function listReceiptsForLanded(db: Db, actor: Actor, filters: { status?: "draft" | "posted" | null; q?: string; limit?: number }, _locale: Locale): Promise<ReceiptSummary[]> {
  assertLandedAccess(actor);
  const conditions = [ne(receipts.status, "cancelled")];
  // An employee limited to a branch sees the receipts of that branch's locations only (SECURITY §7).
  if (actor.kind === "employee" && actor.branchId) conditions.push(eq(inventoryLocations.branchId, actor.branchId));
  if (filters.status) conditions.push(eq(receipts.status, filters.status));
  if (filters.q) conditions.push(sql`(${receipts.ref} like ${`%${filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`} escape '\\' or ${receipts.supplierDocNo} like ${`%${filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`} escape '\\')`);
  const rows = await db
    .select({
      id: receipts.id,
      ref: receipts.ref,
      status: receipts.status,
      supplier: suppliers.name,
      poRef: purchaseOrders.ref,
      location: inventoryLocations.code,
      receivedAt: receipts.receivedAt,
      createdAt: receipts.createdAt,
      lines: sql<number>`(select count(*) from receipt_items ri where ri.receipt_id = ${receipts.id})`,
      units: sql<number>`(select coalesce(sum(case when ri.qty_accepted > 0 then ri.qty_accepted else ri.qty_received end), 0) from receipt_items ri where ri.receipt_id = ${receipts.id})`,
      goodsIqd: sql<number | null>`(select case when count(*) = count(ri.unit_cost_iqd) then sum(ri.unit_cost_iqd * (case when ri.qty_accepted > 0 then ri.qty_accepted else ri.qty_received end)) end from receipt_items ri where ri.receipt_id = ${receipts.id})`,
      billsIqd: sql<number>`(select coalesce(sum(lc.amount_iqd), 0) from landed_costs lc where lc.receipt_id = ${receipts.id})`,
      billsDraft: sql<number>`(select count(*) from landed_costs lc where lc.receipt_id = ${receipts.id} and lc.status = 'draft')`,
      billsAllocated: sql<number>`(select count(*) from landed_costs lc where lc.receipt_id = ${receipts.id} and lc.status = 'allocated')`,
    })
    .from(receipts)
    .leftJoin(suppliers, eq(suppliers.id, receipts.supplierId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receipts.poId))
    .innerJoin(inventoryLocations, eq(inventoryLocations.id, receipts.locationId))
    .where(and(...conditions))
    .orderBy(desc(receipts.createdAt))
    .limit(Math.min(filters.limit ?? 100, 200));
  return rows.map((row) => ({ ...row, lines: Number(row.lines), units: Number(row.units), goodsIqd: row.goodsIqd === null ? null : Number(row.goodsIqd), billsIqd: Number(row.billsIqd), billsDraft: Number(row.billsDraft), billsAllocated: Number(row.billsAllocated) }));
}

export type ReceiptLineView = {
  id: string;
  variantId: string;
  sku: string;
  name: string;
  qty: number;
  qtyReceived: number;
  qtyAccepted: number;
  unitCostIqd: number | null;
  unitCostMinor: number | null;
  weightGrams: number | null;
  landedUnitCostIqd: number | null;
};

export type LandedBillView = {
  id: string;
  kind: LandedCostKind;
  description: string | null;
  currency: string;
  amountMinor: number;
  fxRateMicros: number | null;
  amountIqd: number;
  method: AllocationMethod;
  status: "draft" | "allocated";
  createdAt: number;
  shares: { lineId: string; amountIqd: number; perUnitIqd: number }[];
};

export type ReceiptLanded = {
  receipt: ReceiptSummary & { supplierDocNo: string | null; currency: string | null; fxRateMicros: number | null };
  lines: ReceiptLineView[];
  bills: LandedBillView[];
  editable: boolean;
};

async function loadLines(db: Db, receiptId: string, locale: Locale): Promise<ReceiptLineView[]> {
  const rows = await db
    .select({
      id: receiptItems.id,
      variantId: receiptItems.variantId,
      sku: variants.sku,
      name: products.name,
      qtyReceived: receiptItems.qtyReceived,
      qtyAccepted: receiptItems.qtyAccepted,
      unitCostIqd: receiptItems.unitCostIqd,
      unitCostMinor: receiptItems.unitCostMinor,
      weightGrams: variants.weightGrams,
      landedUnitCostIqd: receiptItems.landedUnitCostIqd,
    })
    .from(receiptItems)
    .innerJoin(variants, eq(variants.id, receiptItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(receiptItems.receiptId, receiptId))
    .orderBy(asc(variants.sku), asc(receiptItems.id));
  return rows.map((row) => ({ ...row, name: pick(row.name, locale), qty: row.qtyAccepted > 0 ? row.qtyAccepted : row.qtyReceived }));
}

export async function getReceiptLanded(db: Db, actor: Actor, receiptId: string, locale: Locale): Promise<ReceiptLanded> {
  assertLandedAccess(actor);
  const header = await db
    .select({ receipt: receipts, supplier: suppliers.name, poRef: purchaseOrders.ref, currency: purchaseOrders.currency, fxRateMicros: purchaseOrders.fxRateMicros, location: inventoryLocations.code, branchId: inventoryLocations.branchId })
    .from(receipts)
    .leftJoin(suppliers, eq(suppliers.id, receipts.supplierId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receipts.poId))
    .innerJoin(inventoryLocations, eq(inventoryLocations.id, receipts.locationId))
    .where(eq(receipts.id, receiptId))
    .get();
  if (!header) throw notFound("receipt");
  assertBranch(actor, header.branchId);
  const [lines, bills] = await Promise.all([loadLines(db, receiptId, locale), db.select().from(landedCosts).where(eq(landedCosts.receiptId, receiptId)).orderBy(asc(landedCosts.createdAt))]);
  const shares = bills.length ? await db.select().from(landedCostAllocations).where(inArray(landedCostAllocations.landedCostId, bills.map((bill) => bill.id))) : [];
  const units = lines.reduce((sum, line) => sum + line.qty, 0);
  const goodsIqd = lines.every((line) => line.unitCostIqd !== null) ? lines.reduce((sum, line) => sum + line.unitCostIqd! * line.qty, 0) : null;
  return {
    receipt: {
      id: header.receipt.id,
      ref: header.receipt.ref,
      status: header.receipt.status,
      supplier: header.supplier,
      poRef: header.poRef,
      location: header.location,
      receivedAt: header.receipt.receivedAt,
      createdAt: header.receipt.createdAt,
      lines: lines.length,
      units,
      goodsIqd,
      billsIqd: bills.reduce((sum, bill) => sum + bill.amountIqd, 0),
      billsDraft: bills.filter((bill) => bill.status === "draft").length,
      billsAllocated: bills.filter((bill) => bill.status === "allocated").length,
      supplierDocNo: header.receipt.supplierDocNo,
      currency: header.currency,
      fxRateMicros: header.fxRateMicros,
    },
    lines,
    bills: bills.map((bill) => ({
      id: bill.id,
      kind: bill.kind,
      description: bill.description,
      currency: bill.currency,
      amountMinor: bill.amountMinor,
      fxRateMicros: bill.fxRateMicros,
      amountIqd: bill.amountIqd,
      method: bill.method,
      status: bill.status,
      createdAt: bill.createdAt,
      shares: shares.filter((share) => share.landedCostId === bill.id).map((share) => ({ lineId: share.receiptItemId, amountIqd: share.amountIqd, perUnitIqd: share.perUnitIqd })),
    })),
    editable: header.receipt.status === "draft",
  };
}

// ───────────────────────────────────────────────────────────────── bills

export const LandedCostInput = z.object({
  receiptId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  kind: z.enum(LANDED_COST_KINDS, { error: "invalid" }),
  description: z.string().trim().max(200, "too_long").optional().default(""),
  currency: z.string({ error: "required" }).trim().toUpperCase().refine(isCostCurrency, "invalid"),
  amount: z.union([z.string(), z.number()], { error: "required" }),
  fxRate: z.union([z.string(), z.number()]).optional(),
  method: z.enum(ALLOCATION_METHODS, { error: "invalid" }).default("by_value"),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
  idempotencyKey: z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid"),
});

/** Adds a bill (draft) to a receipt that is not posted yet. A repeat with the same key returns the first bill. */
export async function addLandedCost(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ landedCostId: string; amountIqd: number; replayed: boolean }> {
  assertLandedAccess(actor);
  const input = LandedCostInput.parse(raw);
  const who = actor.kind === "employee" ? actor.id : actor.kind === "system" ? actor.job : "unknown";
  const id = `lnc_${(await sha256Hex(`${who}:${input.idempotencyKey}`)).slice(0, 26)}`;
  const existing = await db.select({ id: landedCosts.id, amountIqd: landedCosts.amountIqd }).from(landedCosts).where(eq(landedCosts.id, id)).get();
  if (existing) return { landedCostId: existing.id, amountIqd: existing.amountIqd, replayed: true };
  const currency = input.currency as CostCurrency;
  const decimals = COST_CURRENCIES[currency];
  const fields: Record<string, string> = {};
  const amountMinor = parseDecimal(input.amount, decimals);
  if (input.amount === "") fields.amount = "required";
  else if (amountMinor === null || amountMinor <= 0) fields.amount = "invalid";
  let rate = 1_000_000;
  if (currency !== "IQD") {
    const parsed = input.fxRate === undefined || input.fxRate === "" ? null : parseRateMicros(input.fxRate);
    if (parsed === null || parsed <= 0) fields.fxRate = input.fxRate === undefined || input.fxRate === "" ? "required" : "invalid";
    else rate = parsed;
  }
  if (Object.keys(fields).length) throw invalid(fields);
  const amountIqd = purchaseCostIqd(amountMinor!, decimals, rate);
  // A typo guard: beyond it the shares could no longer be exact integers.
  if (!Number.isSafeInteger(amountIqd) || amountIqd > MAX_BILL_IQD) throw invalid({ amount: "too_big" });
  if (amountIqd <= 0) throw invalid({ amount: "invalid" });
  const receipt = await db
    .select({ id: receipts.id, ref: receipts.ref, status: receipts.status, branchId: inventoryLocations.branchId })
    .from(receipts)
    .innerJoin(inventoryLocations, eq(inventoryLocations.id, receipts.locationId))
    .where(eq(receipts.id, input.receiptId))
    .get();
  if (!receipt) throw notFound("receipt");
  assertBranch(actor, receipt.branchId);
  if (receipt.status !== "draft") throw new AppError("receipt_posted", 409, { detail: receipt.id });
  try {
    await runBatch(db, [
      expectThat(db, sql`(select status from receipts where id = ${receipt.id}) = 'draft'`, { code: "RECEIPT_POSTED", detail: receipt.id }),
      db.insert(landedCosts).values({
        id,
        receiptId: receipt.id,
        kind: input.kind,
        description: input.description || null,
        currency,
        amountMinor: amountMinor!,
        fxRateMicros: currency === "IQD" ? null : rate,
        amountIqd,
        method: input.method,
        status: "draft",
        createdBy: actorId(actor),
        createdAt: now,
      }),
      auditStatement(db, { actor, action: "pricing.landed.add", entityType: "receipt", entityId: receipt.id, summary: receipt.ref, after: { landedCostId: id, kind: input.kind, currency, amountMinor, fxRateMicros: rate, amountIqd, method: input.method }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "landed_costs.id")) return { landedCostId: id, amountIqd, replayed: true };
    throw toAppError(error) ?? error;
  }
  return { landedCostId: id, amountIqd, replayed: false };
}

export type BillContext = {
  bill: typeof landedCosts.$inferSelect;
  receipt: typeof receipts.$inferSelect;
  po: { currency: string; fxRateMicros: number | null } | null;
  lines: ReceiptLineView[];
  /** Per-unit shares of the OTHER allocated bills, per line. */
  otherPerUnit: Map<string, number>;
  /** "count:Σ amount:Σ per unit" of those shares when the context was read (the batch guard compares it). */
  othersFingerprint: string;
};

/**
 * One bill with its receipt, lines and the other bills' shares — what allocating or removing it is planned on.
 * Checks the landed-cost permissions and the employee's branch; with `receiptId`, a bill of another receipt is not
 * found. Purchasing (09) uses it to build allocationStatements() into its own receiving batch.
 */
export async function loadBillContext(db: Db, actor: Actor, landedCostId: string, receiptId?: string): Promise<BillContext> {
  assertLandedAccess(actor);
  const bill = await db.select().from(landedCosts).where(eq(landedCosts.id, landedCostId)).get();
  if (!bill || (receiptId !== undefined && bill.receiptId !== receiptId)) throw notFound("landed_cost");
  const receipt = await db.select().from(receipts).where(eq(receipts.id, bill.receiptId)).get();
  if (!receipt) throw notFound("receipt");
  assertBranch(actor, (await receiptBranch(db, receipt.id))?.branchId ?? null);
  const po = receipt.poId ? ((await db.select({ currency: purchaseOrders.currency, fxRateMicros: purchaseOrders.fxRateMicros }).from(purchaseOrders).where(eq(purchaseOrders.id, receipt.poId)).get()) ?? null) : null;
  const lines = await loadLines(db, receipt.id, "ar");
  const others = await db
    .select({ receiptItemId: landedCostAllocations.receiptItemId, amountIqd: landedCostAllocations.amountIqd, perUnitIqd: landedCostAllocations.perUnitIqd })
    .from(landedCostAllocations)
    .innerJoin(landedCosts, eq(landedCosts.id, landedCostAllocations.landedCostId))
    .where(and(eq(landedCosts.receiptId, receipt.id), eq(landedCosts.status, "allocated"), ne(landedCosts.id, bill.id)));
  const otherPerUnit = new Map<string, number>();
  for (const row of others) otherPerUnit.set(row.receiptItemId, (otherPerUnit.get(row.receiptItemId) ?? 0) + row.perUnitIqd);
  const sum = (pick: (row: (typeof others)[number]) => number) => others.reduce((total, row) => total + pick(row), 0);
  const othersFingerprint = `${others.length}:${sum((row) => row.amountIqd)}:${sum((row) => row.perUnitIqd)}`;
  return { bill, receipt, po, lines, otherPerUnit, othersFingerprint };
}

/** The receipt the page shows: a bill of another receipt is not found from there. */
const receiptIdField = z.string().trim().min(1).max(120).optional();

export const AllocateInput = z.object({
  landedCostId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  receiptId: receiptIdField,
  /** For method "manual": IQD per receipt line (receipt_items.id). */
  manual: z.record(z.string(), z.number().int().min(0)).optional(),
  /** Make each SKU's landed cost this receipt's landed unit cost (default true). */
  updateVariantCosts: z.boolean().optional().default(true),
  reason: z.string().trim().max(500, "too_long").optional().default(""),
});

export type AllocationPreview = {
  landedCostId: string;
  amountIqd: number;
  method: AllocationMethod;
  shares: (PlannedShare & { sku: string; qty: number; unitCostIqd: number | null; landedBeforeIqd: number | null; landedAfterIqd: number | null })[];
};

function lineAllocation(lines: readonly ReceiptLineView[]): AllocationLine[] {
  return lines.map((line) => ({ id: line.id, qty: line.qty, unitCostIqd: line.unitCostIqd, weightGrams: line.weightGrams }));
}

function previewOf(context: BillContext, manual?: Record<string, number>): AllocationPreview {
  let shares: PlannedShare[];
  try {
    shares = planAllocation(context.bill.amountIqd, context.bill.method, lineAllocation(context.lines), manual);
  } catch (error) {
    throw toAllocationError(error);
  }
  return {
    landedCostId: context.bill.id,
    amountIqd: context.bill.amountIqd,
    method: context.bill.method,
    shares: shares.map((share) => {
      const line = context.lines.find((candidate) => candidate.id === share.lineId)!;
      const after = line.unitCostIqd === null ? null : line.unitCostIqd + (context.otherPerUnit.get(line.id) ?? 0) + share.perUnitIqd;
      return { ...share, sku: line.sku, qty: line.qty, unitCostIqd: line.unitCostIqd, landedBeforeIqd: line.landedUnitCostIqd, landedAfterIqd: after };
    }),
  };
}

/** The shares a bill would get, nothing written. */
export async function previewAllocation(db: Db, actor: Actor, raw: unknown): Promise<AllocationPreview> {
  assertLandedAccess(actor);
  const input = AllocateInput.parse(raw);
  return previewOf(await loadBillContext(db, actor, input.landedCostId, input.receiptId), input.manual);
}

/**
 * The statements that allocate one bill (for purchasing's own receiving batch, or allocateLandedCost below).
 * `context` comes from loadBillContext and `preview` from previewAllocation / the same plan; the batch refuses to run
 * when the receipt is no longer a draft or another bill of it was spread or removed since the context was read.
 */
export function allocationStatements(
  db: Db,
  args: { context: BillContext; preview: AllocationPreview; updateVariantCosts: boolean; costRows: Map<string, typeof variantCosts.$inferSelect>; actor: Actor; reason: string; now: number },
): BatchStatement[] {
  const { context, preview, actor, now } = args;
  const statements: BatchStatement[] = [
    expectThat(db, sql`(select status from receipts where id = ${context.receipt.id}) = 'draft'`, { code: "RECEIPT_POSTED", detail: context.receipt.id }),
    othersGuard(db, context),
    db.delete(landedCostAllocations).where(eq(landedCostAllocations.landedCostId, context.bill.id)),
  ];
  for (const part of chunks(preview.shares, 20)) {
    statements.push(
      db.insert(landedCostAllocations).values(
        part.map((share) => ({ id: newId("lca"), landedCostId: context.bill.id, receiptItemId: share.lineId, amountIqd: share.amountIqd, perUnitIqd: share.perUnitIqd })),
      ),
    );
  }
  statements.push(db.update(landedCosts).set({ status: "allocated" }).where(eq(landedCosts.id, context.bill.id)));
  const fxDate = baghdadDate(context.receipt.receivedAt ?? now);
  const touched: { variantId: string; before: number | null; after: number | null }[] = [];
  for (const share of preview.shares) {
    statements.push(db.update(receiptItems).set({ landedUnitCostIqd: share.landedAfterIqd }).where(and(eq(receiptItems.id, share.lineId), eq(receiptItems.receiptId, context.receipt.id))));
    const line = context.lines.find((candidate) => candidate.id === share.lineId)!;
    if (args.updateVariantCosts && share.landedAfterIqd !== null && share.landedAfterIqd > 0) {
      const current = args.costRows.get(line.variantId) ?? null;
      const currency = context.po?.currency && isCostCurrency(context.po.currency) ? context.po.currency : "IQD";
      const unitCostMinor = currency === "IQD" ? (line.unitCostIqd ?? 0) : (line.unitCostMinor ?? null);
      if (unitCostMinor === null) continue;
      const values = {
        currency,
        unitCostMinor,
        fxRateMicros: currency === "IQD" ? 1_000_000 : context.po?.fxRateMicros ?? null,
        fxDate,
        landedCostIqd: share.landedAfterIqd,
        updatedBy: actorId(actor),
        updatedAt: now,
      };
      statements.push(db.insert(variantCosts).values({ variantId: line.variantId, ...values }).onConflictDoUpdate({ target: variantCosts.variantId, set: values }));
      touched.push({ variantId: line.variantId, before: current?.landedCostIqd ?? null, after: share.landedAfterIqd });
    }
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: "pricing.landed.allocate",
      entityType: "receipt",
      entityId: context.receipt.id,
      summary: context.receipt.ref,
      before: { landedCostId: context.bill.id, status: context.bill.status, lines: preview.shares.map((share) => ({ lineId: share.lineId, landedUnitCostIqd: share.landedBeforeIqd })) },
      after: { landedCostId: context.bill.id, amountIqd: preview.amountIqd, method: preview.method, shares: preview.shares.map((share) => ({ lineId: share.lineId, sku: share.sku, amountIqd: share.amountIqd, perUnitIqd: share.perUnitIqd, landedUnitCostIqd: share.landedAfterIqd })), variantCosts: touched },
      reason: args.reason || null,
      at: now,
    }),
  );
  return statements;
}

/** Spreads one bill over its receipt's lines and stores the result (see the header). Repeating it re-plans and rewrites the same shares. */
export async function allocateLandedCost(db: Db, actor: Actor, raw: unknown, now: number): Promise<AllocationPreview> {
  assertLandedAccess(actor);
  const input = AllocateInput.parse(raw);
  const context = await loadBillContext(db, actor, input.landedCostId, input.receiptId);
  if (context.receipt.status !== "draft") throw new AppError("receipt_posted", 409, { detail: context.receipt.id });
  const preview = previewOf(context, input.manual);
  const costRows = new Map<string, typeof variantCosts.$inferSelect>();
  if (input.updateVariantCosts) {
    const ids = [...new Set(context.lines.map((line) => line.variantId))];
    for (const part of chunks(ids)) for (const row of await db.select().from(variantCosts).where(inArray(variantCosts.variantId, part))) costRows.set(row.variantId, row);
  }
  await runBatch(db, allocationStatements(db, { context, preview, updateVariantCosts: input.updateVariantCosts, costRows, actor, reason: input.reason, now })).catch((error) => {
    throw toAppError(error) ?? error;
  });
  return preview;
}

export const RemoveBillInput = z.object({
  landedCostId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  receiptId: receiptIdField,
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
});

/**
 * Removes a bill from a draft receipt, with its shares; the lines' landed unit costs are recomputed without it. A SKU
 * whose landed cost is still the one this line gave it (allocating with updateVariantCosts) follows the line back;
 * a SKU cost changed since then is left as it is.
 */
export async function removeLandedCost(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertLandedAccess(actor);
  const input = RemoveBillInput.parse(raw);
  const context = await loadBillContext(db, actor, input.landedCostId, input.receiptId);
  if (context.receipt.status !== "draft") throw new AppError("receipt_posted", 409, { detail: context.receipt.id });
  const own = await db.select().from(landedCostAllocations).where(eq(landedCostAllocations.landedCostId, context.bill.id));
  const statements: BatchStatement[] = [
    expectThat(db, sql`(select status from receipts where id = ${context.receipt.id}) = 'draft'`, { code: "RECEIPT_POSTED", detail: context.receipt.id }),
    othersGuard(db, context),
    db.delete(landedCostAllocations).where(eq(landedCostAllocations.landedCostId, context.bill.id)),
    db.delete(landedCosts).where(eq(landedCosts.id, context.bill.id)),
  ];
  const lines = own.map((share) => context.lines.find((candidate) => candidate.id === share.receiptItemId)).filter((line): line is ReceiptLineView => line !== undefined);
  const costs = await costRowsFor(db, lines.map((line) => line.variantId));
  const touched: { variantId: string; before: number; after: number }[] = [];
  for (const line of lines) {
    const others = context.otherPerUnit.get(line.id) ?? 0;
    const landedAfter = line.unitCostIqd === null ? null : line.unitCostIqd + others;
    statements.push(db.update(receiptItems).set({ landedUnitCostIqd: landedAfter }).where(eq(receiptItems.id, line.id)));
    // The SKU still carries this line's landed cost (with the bill): it follows the line back. The row is guarded on
    // that value, so a cost typed in meanwhile is never overwritten.
    const cost = costs.get(line.variantId);
    if (cost && line.landedUnitCostIqd !== null && cost.landedCostIqd === line.landedUnitCostIqd && landedAfter !== null && landedAfter > 0 && landedAfter !== cost.landedCostIqd && !touched.some((entry) => entry.variantId === line.variantId)) {
      statements.push(
        db
          .update(variantCosts)
          .set({ landedCostIqd: landedAfter, updatedBy: actorId(actor), updatedAt: now })
          .where(and(eq(variantCosts.variantId, line.variantId), eq(variantCosts.landedCostIqd, cost.landedCostIqd))),
      );
      touched.push({ variantId: line.variantId, before: cost.landedCostIqd, after: landedAfter });
    }
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: "pricing.landed.remove",
      entityType: "receipt",
      entityId: context.receipt.id,
      summary: context.receipt.ref,
      before: { landedCostId: context.bill.id, kind: context.bill.kind, amountIqd: context.bill.amountIqd, status: context.bill.status, shares: own.map((share) => ({ lineId: share.receiptItemId, amountIqd: share.amountIqd })) },
      after: touched.length > 0 ? { variantCosts: touched } : null,
      reason: input.reason,
      at: now,
    }),
  );
  await runBatch(db, statements).catch((error) => {
    throw toAppError(error) ?? error;
  });
}
