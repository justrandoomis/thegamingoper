/**
 * Supplier claims (admin 09.06): shortages, damaged or defective goods, wrong items, price disputes and returns to the
 * supplier — recorded against the supplier (and its order / receipt when known), followed through
 * open → submitted → accepted | rejected → credited → closed (rules.ts CLAIM_TRANSITIONS), and counted in the
 * supplier's defect rate (09.08).
 *
 *   const { claimId } = await createClaim(db, actor, { receiptId, kind: "damage", lines: [{ code: "SKU", qty: "2" }], idempotencyKey }, now);
 *   await moveClaim(db, actor, { claimId, to: "submitted", note }, now);
 *   await returnClaimGoods(db, actor, { claimId, locationId }, now);   // the goods leave stock through the core
 *
 * GOODS GOING BACK (return, defect, damage, wrong item): units REFUSED AT INSPECTION never entered stock — a claim tied
 * to a receipt carries them first (`refused` on its lines, set when the claim is made: the receipt's refused units of
 * that SKU not yet carried by its other claims), and they go back without a stock movement. The rest leave stock
 * through the commerce core — adjustStock(−units, kind "adjust", reason "CLM-… [<token>.<line>] → <supplier>: …") per
 * line, which needs inventory.stock.adjust as well, consumes the FIFO layers and writes the movement with reason, actor
 * and time. A claim tied to a receipt (or an order) sends back from stock at most the units that receipt (order) put
 * into stock, less what its other claims sent back (`return_exceeds_received`); a claim tied to the supplier alone is
 * limited by the shelf. The lines are marked in the claim first (a compare-and-set on the claim's items), so a double
 * submit or two people at once move the goods once; a return that stopped half way can be resumed after
 * POSTING_LEASE_MS (a line whose movement exists — same marker, actor and time — is not moved again). Serial-tracked
 * units cannot leave stock this way: the core has no single-serial operation yet (`serial_tracked`, requested) —
 * refused ones go back. Returns are not posted to the books: adjustStock does not post, and the core gives no FIFO
 * cost back to post with (requested: Dr accounts payable / Cr inventory).
 * An employee limited to a branch acts on the claims of their branch's receipts and orders only (403 otherwise).
 *
 * Amounts are supplier cost data [P]: typed and shown only with cost.read; without it the server prices a claim from its
 * order's unit costs (a price dispute needs cost.read). Permissions: purchasing.claim.manage (+ inventory.stock.adjust
 * to return goods). Error codes: forbidden (403), not_found (404), invalid (400), claim_transition, claim_not_open,
 * return_in_progress, nothing_to_return, return_exceeds_received, serial_tracked, insufficient_stock, location_invalid (409).
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { serverT } from "~/i18n/i18n.server";
import { randomToken } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { purchaseOrders, receipts, supplierClaims, suppliers, SUPPLIER_CLAIM_KINDS, type SupplierClaimKind, type SupplierClaimStatus } from "~/server/db/schema";
import { expectChanged, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { adjustStock } from "~/server/services/inventory/stock.server";
import { defaultRateMicros } from "../pricing/costs.server";
import { CLAIM_FILTERS, CLAIM_STATUS_LIST, CLAIM_TRANSITIONS, MAX_DOC_IQD, MAX_LINES, MAX_QTY, POSTING_LEASE_MS, RETURNABLE_CLAIM_KINDS, baghdadDate, decimalsOf, isCostCurrency, normalizeDigits, parseCount, parseDecimal, toIqd } from "./rules";
import { ID_PATTERN, PAGE_SIZE, actorId, assertAll, assertRecordBranch, branchCondition, cleanQuery, historyOf, idField, idFromKey, keyField, likePattern, optionalText, pageOf, reasonField, resolveVariantCodes, usableLocation, variantsById, type HistoryEntry, type VariantLabel } from "./shared.server";

export const CLAIM_ERROR_KEYS = ["claim_transition", "claim_not_open", "return_in_progress", "nothing_to_return", "return_exceeds_received", "serial_unknown", "claim_not_returnable", "amount_required"] as const;

/**
 * Once goods went back: where, when, by whom — and `stock`, the units that left stock (the others were refused at
 * inspection and never in it; marks written before the review have no `stock`: all their units left stock).
 */
type ReturnMark = { token: string; qty: number; stock?: number; locationId: string; at: number; by: string | null; done: boolean };
/** A claim line as stored (the schema's items JSON); `refused`: of its units, those refused at inspection on the claim's receipt. */
type ClaimItem = { variantId: string; qty: number; serialId?: string; serial?: string; refused?: number; returned?: ReturnMark };

function parseItems(text: string | null): ClaimItem[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as ClaimItem[]).filter((item) => item && typeof item.variantId === "string") : [];
  } catch {
    return [];
  }
}

const stockOfMark = (mark: ReturnMark) => mark.stock ?? mark.qty;
/** The units of a line refused at inspection: as stored, else (a line returned before the review) what did not leave stock. */
const refusedOf = (item: ClaimItem) => item.refused ?? (item.returned ? Math.max(0, item.qty - Math.min(item.qty, stockOfMark(item.returned))) : 0);

/** Where a claim's goods came from: the receipt's location, else the order's (null: the supplier alone). */
async function claimLocation(db: Db, claim: { receiptId: string | null; poId: string | null }): Promise<string | null> {
  if (claim.receiptId) {
    const row = await db.select({ locationId: receipts.locationId }).from(receipts).where(eq(receipts.id, claim.receiptId)).get();
    if (row) return row.locationId;
  }
  if (claim.poId) {
    const row = await db.select({ locationId: purchaseOrders.locationId }).from(purchaseOrders).where(eq(purchaseOrders.id, claim.poId)).get();
    if (row) return row.locationId;
  }
  return null;
}

/**
 * Units refused at inspection on a receipt, per SKU, less those the receipt's other claims already carry: what a new
 * claim's lines of that SKU carry first (they never entered stock, so they go back without leaving it).
 */
async function refusedLeft(db: Db, receiptId: string, exceptClaimId: string | null): Promise<Map<string, number>> {
  const [rejected, claims] = await Promise.all([
    db.all<{ variantId: string; n: number }>(sql`SELECT variant_id AS variantId, SUM(qty_rejected) AS n FROM receipt_items WHERE receipt_id = ${receiptId} GROUP BY variant_id`),
    db.all<{ items: string | null }>(sql`SELECT items FROM supplier_claims WHERE receipt_id = ${receiptId} ${exceptClaimId ? sql`AND id <> ${exceptClaimId}` : sql``}`),
  ]);
  const left = new Map(rejected.map((row) => [row.variantId, Number(row.n)]));
  for (const claim of claims) {
    for (const item of parseItems(claim.items)) {
      const refused = refusedOf(item);
      if (refused > 0) left.set(item.variantId, Math.max(0, (left.get(item.variantId) ?? 0) - refused));
    }
  }
  return left;
}

/** Gives each line its refused units, SKU by SKU in line order, from what is left (mutates `left`). */
function carryRefused<T extends { variantId: string; qty: number }>(items: readonly T[], left: Map<string, number>): number[] {
  return items.map((item) => {
    const free = left.get(item.variantId) ?? 0;
    const refused = Math.min(item.qty, free);
    left.set(item.variantId, free - refused);
    return refused;
  });
}

/**
 * Per line of a claim: the units refused at inspection (never in stock) and those that leave stock when the goods go
 * back. Lines stored before the review have no `refused`: a claim tied to a receipt gives them their share now.
 */
async function claimSplit(db: Db, claim: { id: string; kind: SupplierClaimKind; receiptId: string | null }, items: readonly ClaimItem[]): Promise<{ refused: number; stock: number }[]> {
  const legacy = items.some((item) => item.refused === undefined && !item.returned);
  const left = legacy && claim.receiptId && RETURNABLE_CLAIM_KINDS.includes(claim.kind) ? await refusedLeft(db, claim.receiptId, claim.id) : new Map<string, number>();
  // This claim's own lines that already went back (or carry their share) take theirs first.
  for (const item of items) if (item.returned || item.refused !== undefined) left.set(item.variantId, Math.max(0, (left.get(item.variantId) ?? 0) - refusedOf(item)));
  return items.map((item) => {
    if (item.returned) {
      const stock = Math.min(item.qty, stockOfMark(item.returned));
      return { refused: item.qty - stock, stock };
    }
    const refused = item.refused ?? carryRefused([item], left)[0];
    return { refused, stock: item.qty - refused };
  });
}

/** Per SKU: the units a receipt (or an order) put into stock — posted receipts only. */
async function acceptedInto(db: Db, scope: { receiptId: string } | { poId: string }): Promise<Map<string, number>> {
  const rows =
    "receiptId" in scope
      ? await db.all<{ variantId: string; n: number }>(sql`
          SELECT ri.variant_id AS variantId, SUM(ri.qty_accepted) AS n FROM receipt_items AS ri JOIN receipts AS r ON r.id = ri.receipt_id
          WHERE r.id = ${scope.receiptId} AND r.status = 'posted' AND (r.received_by IS NULL OR r.received_by NOT LIKE 'posting:%') GROUP BY ri.variant_id`)
      : await db.all<{ variantId: string; n: number }>(sql`SELECT variant_id AS variantId, SUM(qty_received) AS n FROM po_items WHERE po_id = ${scope.poId} GROUP BY variant_id`);
  return new Map(rows.map((row) => [row.variantId, Number(row.n)]));
}

/** Per SKU: units that left stock through the returns of the receipt's (the order's) claims, but `claimId`'s. */
async function returnedFrom(db: Db, scope: { receiptId: string } | { poId: string }, exceptClaimId: string): Promise<Map<string, number>> {
  const rows = await db.all<{ items: string | null }>(sql`
    SELECT items FROM supplier_claims WHERE ${"receiptId" in scope ? sql`receipt_id = ${scope.receiptId}` : sql`po_id = ${scope.poId}`} AND id <> ${exceptClaimId}`);
  const out = new Map<string, number>();
  for (const row of rows) for (const item of parseItems(row.items)) if (item.returned) out.set(item.variantId, (out.get(item.variantId) ?? 0) + stockOfMark(item.returned));
  return out;
}

// ───────────────────────────────────────────────────────────────── create

const count = z.union([z.string(), z.number()]).optional();
export const ClaimLineInput = z.object({ code: z.string().trim().max(120, "too_long").optional().default(""), qty: count, serial: z.string().trim().max(100, "too_long").optional() });
export const CreateClaimInput = z.object({
  supplierId: z.string().trim().regex(ID_PATTERN, "invalid").optional(),
  poId: z.string().trim().regex(ID_PATTERN, "invalid").optional(),
  receiptId: z.string().trim().regex(ID_PATTERN, "invalid").optional(),
  kind: z.enum(SUPPLIER_CLAIM_KINDS, { error: "invalid" }),
  description: optionalText(1000),
  lines: z.array(ClaimLineInput).max(MAX_LINES, "too_many"),
  amount: count,
  idempotencyKey: keyField,
});

const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/** Records a claim (status open). Linked to a receipt or an order when given; otherwise to the supplier alone. */
export async function createClaim(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale = "ar"): Promise<{ claimId: string; ref: string; replayed: boolean }> {
  assertCan(actor, "purchasing.claim.manage");
  const input = CreateClaimInput.parse(raw);
  const claimId = await idFromKey("clm", actor, input.idempotencyKey);
  const existing = await db.select({ id: supplierClaims.id, ref: supplierClaims.ref }).from(supplierClaims).where(eq(supplierClaims.id, claimId)).get();
  if (existing) return { claimId: existing.id, ref: existing.ref, replayed: true };
  const fields: Record<string, string> = {};
  const receipt = input.receiptId ? await db.select().from(receipts).where(eq(receipts.id, input.receiptId)).get() : undefined;
  if (input.receiptId && !receipt) throw notFound("receipt");
  const poId = receipt?.poId ?? input.poId ?? null;
  const order = poId ? await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get() : undefined;
  if (poId && !order) throw notFound("purchase_order");
  if (input.poId && receipt && receipt.poId !== input.poId) fields.poId = "invalid";
  const supplierId = order?.supplierId ?? receipt?.supplierId ?? input.supplierId ?? null;
  if (!supplierId) throw invalid({ supplierId: "required" });
  if (input.supplierId && input.supplierId !== supplierId) fields.supplierId = "invalid";
  const supplier = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).get();
  if (!supplier) throw notFound("supplier");
  await assertRecordBranch(db, actor, receipt?.locationId ?? order?.locationId ?? null);
  const typed = input.lines.map((line, index) => ({ ...line, index })).filter((line) => !(blank(line.code) && blank(line.qty)));
  if (typed.length === 0) fields.lines = "required";
  const { found } = await resolveVariantCodes(
    db,
    typed.map((line) => line.code),
    locale,
  );
  const items: ClaimItem[] = [];
  for (const line of typed) {
    const at = `lines.${line.index}`;
    const variant = found.get(line.code.trim());
    if (!line.code) fields[`${at}.code`] = "required";
    else if (!variant) fields[`${at}.code`] = "unknown_code";
    const qty = parseCount(line.qty);
    if (qty === undefined) fields[`${at}.qty`] = "required";
    else if (Number.isNaN(qty) || qty < 1) fields[`${at}.qty`] = "invalid";
    else if (qty > MAX_QTY) fields[`${at}.qty`] = "too_big";
    let serial: { id: string; serial: string } | null = null;
    const typedSerial = line.serial ? normalizeDigits(line.serial).trim() : "";
    if (variant && typedSerial) {
      if (!variant.trackSerials) fields[`${at}.serial`] = "serials_not_tracked";
      else {
        const rows = await db.all<{ id: string; serial: string }>(sql`SELECT id, serial FROM serials WHERE upper(serial) = upper(${typedSerial}) AND variant_id = ${variant.id} LIMIT 1`);
        if (!rows[0]) fields[`${at}.serial`] = "serial_unknown";
        else serial = rows[0];
      }
      if (serial && qty !== undefined && qty !== 1) fields[`${at}.qty`] = "invalid";
    }
    if (variant && qty !== undefined && !Number.isNaN(qty) && qty >= 1 && qty <= MAX_QTY) items.push({ variantId: variant.id, qty, ...(serial ? { serialId: serial.id, serial: serial.serial } : {}) });
  }
  const currency = order?.currency ?? supplier.currency;
  let amountMinor: number | null = null;
  if (!blank(input.amount)) {
    if (!can(actor, "cost.read")) throw new AppError("forbidden", 403, { detail: "cost.read" });
    amountMinor = parseDecimal(input.amount, decimalsOf(currency));
    if (amountMinor === null) fields.amount = "invalid";
  } else if (input.kind === "price") {
    fields.amount = "amount_required";
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  // Goods of a receipt that go back: its units refused at inspection (never in stock) are carried first.
  if (receipt && RETURNABLE_CLAIM_KINDS.includes(input.kind)) {
    const shares = carryRefused(items, await refusedLeft(db, receipt.id, null));
    items.forEach((item, index) => {
      item.refused = shares[index];
    });
  }
  if (amountMinor === null && order) {
    // Priced from the order's unit costs when every line is on the order (the server knows; the clerk need not).
    const lines = await db.all<{ variantId: string; unitCostMinor: number }>(sql`SELECT variant_id AS variantId, unit_cost_minor AS unitCostMinor FROM po_items WHERE po_id = ${order.id}`);
    const cost = new Map(lines.map((line) => [line.variantId, Number(line.unitCostMinor)]));
    if (items.every((item) => cost.has(item.variantId))) amountMinor = items.reduce((sum, item) => sum + item.qty * cost.get(item.variantId)!, 0);
  }
  const rate = order?.fxRateMicros ?? (isCostCurrency(currency) ? await defaultRateMicros(db, currency, baghdadDate(now)) : null);
  const amountIqd = amountMinor === null ? null : toIqd(amountMinor, currency, rate);
  // A typo guard, as on orders and invoices: beyond it the amount could no longer be an exact integer.
  if (amountIqd !== null && (!Number.isSafeInteger(amountIqd) || amountIqd > MAX_DOC_IQD)) throw invalid({ amount: "too_big" });
  const ref = `CLM-${claimId.slice(4, 12).toUpperCase()}`;
  try {
    await runBatch(db, [
      db.insert(supplierClaims).values({
        id: claimId,
        ref,
        supplierId: supplier.id,
        poId: order?.id ?? null,
        receiptId: receipt?.id ?? null,
        kind: input.kind,
        status: "open",
        description: input.description,
        items,
        currency,
        amountMinor,
        amountIqd,
        createdBy: actorId(actor),
        createdAt: now,
      }),
      auditStatement(db, {
        actor,
        action: "purchasing.claim.create",
        entityType: "supplier_claim",
        entityId: claimId,
        summary: `${ref} · ${supplier.code}`,
        after: { kind: input.kind, supplier: supplier.code, poRef: order?.ref ?? null, receiptRef: receipt?.ref ?? null, items: items.map((item) => ({ variantId: item.variantId, qty: item.qty, serial: item.serial ?? null })) },
        reason: input.description,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "supplier_claims.id")) return { claimId, ref, replayed: true };
    throw toAppError(error) ?? error;
  }
  return { claimId, ref, replayed: false };
}

/** Lines to start a claim from: a posted receipt's refused units (damage) or an order's missing units (shortage). */
export async function claimPrefill(db: Db, actor: Actor, from: { receiptId?: string | null; poId?: string | null }, locale: Locale): Promise<{ supplierId: string | null; poId: string | null; receiptId: string | null; kind: SupplierClaimKind; lines: { code: string; qty: number; label: string }[]; label: string | null }> {
  assertCan(actor, "purchasing.claim.manage");
  if (from.receiptId) {
    const receipt = await db.select().from(receipts).where(eq(receipts.id, from.receiptId)).get();
    if (!receipt) throw notFound("receipt");
    await assertRecordBranch(db, actor, receipt.locationId);
    const rows = await db.all<{ variantId: string; rejected: number }>(sql`SELECT variant_id AS variantId, SUM(qty_rejected) AS rejected FROM receipt_items WHERE receipt_id = ${receipt.id} GROUP BY variant_id HAVING SUM(qty_rejected) > 0`);
    const labels = await variantsById(
      db,
      rows.map((row) => row.variantId),
      locale,
    );
    return { supplierId: receipt.supplierId, poId: receipt.poId, receiptId: receipt.id, kind: "damage", lines: rows.map((row) => ({ code: labels.get(row.variantId)?.sku ?? row.variantId, qty: Number(row.rejected), label: labels.get(row.variantId)?.name ?? "" })), label: receipt.ref };
  }
  if (from.poId) {
    const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, from.poId)).get();
    if (!order) throw notFound("purchase_order");
    await assertRecordBranch(db, actor, order.locationId);
    const rows = await db.all<{ variantId: string; outstanding: number }>(sql`SELECT variant_id AS variantId, qty_ordered - qty_received AS outstanding FROM po_items WHERE po_id = ${order.id} AND qty_ordered > qty_received`);
    const labels = await variantsById(
      db,
      rows.map((row) => row.variantId),
      locale,
    );
    return { supplierId: order.supplierId, poId: order.id, receiptId: null, kind: "shortage", lines: rows.map((row) => ({ code: labels.get(row.variantId)?.sku ?? row.variantId, qty: Number(row.outstanding), label: labels.get(row.variantId)?.name ?? "" })), label: order.ref };
  }
  return { supplierId: null, poId: null, receiptId: null, kind: "shortage", lines: [], label: null };
}

// ───────────────────────────────────────────────────────────────── move

export const MoveClaimInput = z.object({
  claimId: idField,
  to: z.enum(CLAIM_STATUS_LIST as unknown as [SupplierClaimStatus, ...SupplierClaimStatus[]], { error: "invalid" }),
  note: z.string().trim().max(500, "too_long").optional(),
  creditAmount: count,
  creditReference: z.string().trim().max(80, "too_long").optional(),
});

/** Moves a claim along its path; a rejection or closing needs a note, a credit needs the credit note's reference (and its amount, with cost.read). */
export async function moveClaim(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: SupplierClaimStatus; replayed: boolean }> {
  assertCan(actor, "purchasing.claim.manage");
  const input = MoveClaimInput.parse(raw);
  const claim = await db.select().from(supplierClaims).where(eq(supplierClaims.id, input.claimId)).get();
  if (!claim) throw notFound("supplier_claim");
  await assertRecordBranch(db, actor, await claimLocation(db, claim));
  if (claim.status === input.to) return { status: claim.status, replayed: true };
  if (!CLAIM_TRANSITIONS[claim.status].includes(input.to)) throw new AppError("claim_transition", 409, { detail: `${claim.status}→${input.to}` });
  const fields: Record<string, string> = {};
  const note = input.note ?? "";
  if ((input.to === "rejected" || input.to === "closed") && note.length < 3) fields.note = "reason_short";
  let resolution = claim.resolution;
  let creditMinor: number | null = null;
  if (input.to === "credited") {
    if (!input.creditReference || input.creditReference.length < 2) fields.creditReference = "required";
    if (!blank(input.creditAmount)) {
      if (!can(actor, "cost.read")) throw new AppError("forbidden", 403, { detail: "cost.read" });
      creditMinor = parseDecimal(input.creditAmount, decimalsOf(claim.currency));
      if (creditMinor === null) fields.creditAmount = "invalid";
    }
    resolution = [input.creditReference, note || null].filter(Boolean).join(" · ") || resolution;
  } else if (input.to === "rejected" || input.to === "closed") {
    resolution = note || resolution;
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const items = parseItems(JSON.stringify(claim.items ?? []));
  if (input.to === "closed" && items.some((item) => item.returned && !item.returned.done)) throw new AppError("return_in_progress", 409);
  const ended = input.to === "closed" || input.to === "credited" || input.to === "rejected";
  await runBatch(db, [
    db
      .update(supplierClaims)
      .set({ status: input.to, resolution, resolvedAt: ended ? now : claim.resolvedAt })
      .where(and(eq(supplierClaims.id, claim.id), eq(supplierClaims.status, claim.status))),
    expectChanged(db, 1, { code: "CLAIM_CHANGED", detail: claim.id }),
    auditStatement(db, {
      actor,
      action: `purchasing.claim.${input.to}`,
      entityType: "supplier_claim",
      entityId: claim.id,
      summary: claim.ref,
      before: { status: claim.status },
      after: { status: input.to, creditReference: input.creditReference ?? null, ...(creditMinor !== null ? { creditMinor, currency: claim.currency } : {}) },
      reason: note || null,
      at: now,
    }),
  ]).catch((error) => {
    if (isDbError(error, "CLAIM_CHANGED")) throw new AppError("claim_transition", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { status: input.to, replayed: false };
}

// ───────────────────────────────────────────────────────────────── goods back to the supplier

/** `reason`: why and how the goods go back now (a waybill, who collected them) — a stock-out needs one (uxRules). */
export const ReturnGoodsInput = z.object({ claimId: idField, locationId: idField, reason: reasonField });

async function rawItems(db: Db, claimId: string): Promise<string | null> {
  const rows = await db.all<{ items: string | null }>(sql`SELECT items FROM supplier_claims WHERE id = ${claimId}`);
  return rows[0]?.items ?? null;
}

const marker = (ref: string, token: string, index: number) => `${ref} [${token}.${index}]`;

/** A movement the core wrote for one marked line (same marker, actor and time). */
async function lineMoved(db: Db, prefix: string, mark: ReturnMark): Promise<boolean> {
  const rows = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM stock_movements
    WHERE ref_type = 'adjustment' AND at = ${mark.at} AND coalesce(actor_id, '') = ${mark.by ?? ""} AND substr(reason, 1, ${prefix.length}) = ${prefix}`);
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Sends a claim's goods back to the supplier (see the header): refused units without a stock movement, the others out
 * of stock at `locationId` through the core. `returned`: units marked as gone back; `fromStock`: of them, out of stock.
 */
export async function returnClaimGoods(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale = "ar"): Promise<{ returned: number; fromStock: number; replayed: boolean }> {
  assertAll(actor, ["purchasing.claim.manage", "inventory.stock.adjust"]);
  const input = ReturnGoodsInput.parse(raw);
  const claim = await db.select().from(supplierClaims).where(eq(supplierClaims.id, input.claimId)).get();
  if (!claim) throw notFound("supplier_claim");
  await assertRecordBranch(db, actor, await claimLocation(db, claim));
  if (!RETURNABLE_CLAIM_KINDS.includes(claim.kind)) throw new AppError("claim_not_returnable", 409);
  if (!["open", "submitted", "accepted"].includes(claim.status)) throw new AppError("claim_not_open", 409);
  const before = await rawItems(db, claim.id);
  const items = parseItems(before);
  const fresh = (item: ClaimItem) => !item.returned;
  const stale = (item: ClaimItem) => Boolean(item.returned && !item.returned.done && item.returned.at + POSTING_LEASE_MS <= now);
  if (items.some((item) => item.returned && !item.returned.done && !stale(item))) throw new AppError("return_in_progress", 409);
  const pending = items.map((item, index) => ({ item, index })).filter(({ item }) => fresh(item) || stale(item));
  if (pending.length === 0) {
    if (items.length > 0 && items.every((item) => item.returned?.done)) return { returned: 0, fromStock: 0, replayed: true };
    throw new AppError("nothing_to_return", 409);
  }
  const location = await usableLocation(db, actor, input.locationId);
  const labels = await variantsById(
    db,
    pending.map(({ item }) => item.variantId),
    locale,
  );
  // What leaves stock per line: its units less those refused at inspection (never in stock).
  const split = await claimSplit(db, claim, items);
  const stockOf = (index: number) => split[index]?.stock ?? 0;
  const tracked = pending.filter(({ item, index }) => stockOf(index) > 0 && (item.serialId || labels.get(item.variantId)?.trackSerials));
  if (tracked.length > 0) throw new AppError("serial_tracked", 409, { detail: tracked.map(({ item }) => labels.get(item.variantId)?.sku ?? item.variantId).join(", ") });
  // A claim tied to a receipt or an order sends back from stock at most what that document put into it (a receipt's
  // claim is held to its order's total too: the order's own claims may have sent back some of the same units).
  const scopes = [...(claim.receiptId ? [{ receiptId: claim.receiptId }] : []), ...(claim.poId ? [{ poId: claim.poId }] : [])];
  const wanted = new Map<string, number>();
  for (const { item, index } of pending) wanted.set(item.variantId, (wanted.get(item.variantId) ?? 0) + stockOf(index));
  const ownDone = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.returned && !pending.some((entry) => entry.index === index)) ownDone.set(item.variantId, (ownDone.get(item.variantId) ?? 0) + stockOf(index));
  });
  for (const scope of scopes) {
    const [accepted, elsewhere] = await Promise.all([acceptedInto(db, scope), returnedFrom(db, scope, claim.id)]);
    const over = [...wanted].filter(([variantId, qty]) => qty > 0 && (elsewhere.get(variantId) ?? 0) + (ownDone.get(variantId) ?? 0) + qty > (accepted.get(variantId) ?? 0));
    if (over.length > 0) throw new AppError("return_exceeds_received", 409, { detail: over.map(([variantId]) => labels.get(variantId)?.sku ?? variantId).join(", "), fields: { locationId: "return_exceeds_received" } });
  }
  // Lines a stopped return already moved (or that had nothing to move) are only marked, never moved twice.
  const alreadyMoved = new Set<number>();
  for (const { item, index } of pending) if (item.returned && (stockOfMark(item.returned) === 0 || (await lineMoved(db, marker(claim.ref, item.returned.token, index), item.returned)))) alreadyMoved.add(index);
  const toMove = pending.filter(({ index }) => !alreadyMoved.has(index));
  const need = new Map<string, number>();
  for (const { item, index } of toMove) if (stockOf(index) > 0) need.set(item.variantId, (need.get(item.variantId) ?? 0) + stockOf(index));
  if (need.size > 0) {
    const levels = await db.all<{ variantId: string; free: number }>(sql`
      SELECT variant_id AS variantId, on_hand - reserved AS free FROM stock_levels WHERE location_id = ${location.id} AND variant_id IN (SELECT value FROM json_each(${JSON.stringify([...need.keys()])}))`);
    const short = [...need].filter(([variantId, qty]) => (levels.find((row) => row.variantId === variantId)?.free ?? 0) < qty);
    if (short.length > 0) throw new AppError("insufficient_stock", 409, { detail: short.map(([variantId]) => labels.get(variantId)?.sku ?? variantId).join(", "), fields: { locationId: "insufficient_stock" } });
  }
  const token = randomToken(6);
  const me = actorId(actor);
  const marked = items.map((item, index) =>
    pending.some((entry) => entry.index === index)
      ? { ...item, refused: split[index]?.refused ?? 0, returned: alreadyMoved.has(index) ? { ...item.returned!, done: true } : { token, qty: item.qty, stock: stockOf(index), locationId: location.id, at: now, by: me, done: false } }
      : item,
  );
  const markedText = JSON.stringify(marked);
  const supplier = await db.select({ code: suppliers.code }).from(suppliers).where(eq(suppliers.id, claim.supplierId)).get();
  await runBatch(db, [
    db
      .update(supplierClaims)
      .set({ items: marked as typeof claim.items })
      .where(and(eq(supplierClaims.id, claim.id), before === null ? sql`${supplierClaims.items} IS NULL` : sql`${supplierClaims.items} = ${before}`)),
    expectChanged(db, 1, { code: "RETURN_CHANGED", detail: claim.id }),
    auditStatement(db, { actor, action: "purchasing.claim.return_start", entityType: "supplier_claim", entityId: claim.id, summary: `${claim.ref} · ${location.code}`, after: { location: location.code, lines: toMove.map(({ item, index }) => ({ variantId: item.variantId, qty: item.qty, fromStock: stockOf(index) })) }, reason: input.reason, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "RETURN_CHANGED")) throw new AppError("return_in_progress", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  const t = serverT(locale, "admin-purchasing");
  const done = new Set<number>(alreadyMoved);
  let stockMoved = [...alreadyMoved].some((index) => stockOf(index) > 0);
  for (const { item, index } of toMove) {
    // Refused at inspection: they go back without ever having been in stock.
    if (stockOf(index) === 0) {
      done.add(index);
      continue;
    }
    try {
      await adjustStock(db, actor, { variantId: item.variantId, locationId: location.id, delta: -stockOf(index), kind: "adjust", reason: `${marker(claim.ref, token, index)} → ${supplier?.code ?? ""}: ${t("claims.movementReason")} — ${input.reason}`.slice(0, 500) }, now);
      done.add(index);
      stockMoved = true;
    } catch (error) {
      if (!stockMoved) {
        // Nothing went back: the claim's lines are unmarked again, so the return can be tried once more.
        await runBatch(db, [
          db
            .update(supplierClaims)
            .set({ items: items as typeof claim.items })
            .where(and(eq(supplierClaims.id, claim.id), sql`${supplierClaims.items} = ${markedText}`)),
          auditStatement(db, { actor, action: "purchasing.claim.return_failed", entityType: "supplier_claim", entityId: claim.id, summary: claim.ref, after: { error: toAppError(error)?.code ?? "unexpected" }, at: now }),
        ]);
      }
      throw error;
    }
  }
  const final = marked.map((item, index) => (done.has(index) && item.returned ? { ...item, returned: { ...item.returned, done: true } } : item));
  await runBatch(db, [
    db
      .update(supplierClaims)
      .set({ items: final as typeof claim.items })
      .where(and(eq(supplierClaims.id, claim.id), sql`${supplierClaims.items} = ${markedText}`)),
    expectChanged(db, 1, { code: "RETURN_CHANGED", detail: claim.id }),
    auditStatement(db, {
      actor,
      action: "purchasing.claim.return",
      entityType: "supplier_claim",
      entityId: claim.id,
      summary: `${claim.ref} · ${location.code}`,
      after: { location: location.code, units: toMove.reduce((sum, { item }) => sum + item.qty, 0), fromStock: toMove.reduce((sum, { index }) => sum + stockOf(index), 0), lines: toMove.length },
      reason: input.reason,
      at: now,
    }),
  ]).catch((error) => {
    if (isDbError(error, "RETURN_CHANGED")) throw new AppError("return_in_progress", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { returned: toMove.reduce((sum, { item }) => sum + item.qty, 0), fromStock: toMove.reduce((sum, { index }) => sum + stockOf(index), 0), replayed: false };
}

// ───────────────────────────────────────────────────────────────── reading

export { CLAIM_FILTERS };
export type ClaimFilter = (typeof CLAIM_FILTERS)[number];
export type ClaimFilters = { status: ClaimFilter; kind: SupplierClaimKind | null; q: string; page: number };

export function parseClaimFilters(params: URLSearchParams): ClaimFilters {
  const status = params.get("status");
  const kind = params.get("kind");
  return {
    status: (CLAIM_FILTERS as readonly string[]).includes(status ?? "") ? (status as ClaimFilter) : "active",
    kind: (SUPPLIER_CLAIM_KINDS as readonly string[]).includes(kind ?? "") ? (kind as SupplierClaimKind) : null,
    q: cleanQuery(params.get("q")),
    page: pageOf(params.get("page")),
  };
}

export type ClaimRow = { id: string; ref: string; kind: SupplierClaimKind; status: SupplierClaimStatus; supplier: { id: string; code: string; name: string }; po: { id: string; ref: string } | null; receipt: { id: string; ref: string } | null; units: number; returned: number; createdAt: number; amountMinor?: number | null; currency?: string; amountIqd?: number | null };

export async function listClaims(db: Db, actor: Actor, filters: ClaimFilters): Promise<{ rows: ClaimRow[]; total: number; page: number; pageCount: number; counts: Record<ClaimFilter, number> }> {
  assertCan(actor, "purchasing.claim.manage");
  const withCost = can(actor, "cost.read");
  const base = [branchCondition(actor, sql`coalesce(r.location_id, po.location_id)`)];
  if (filters.kind) base.push(sql`c.kind = ${filters.kind}`);
  if (filters.q) {
    const like = likePattern(filters.q);
    base.push(sql`(c.ref LIKE ${like} ESCAPE '\\' OR s.name LIKE ${like} ESCAPE '\\' OR s.code LIKE ${like} ESCAPE '\\' OR coalesce(po.ref, '') LIKE ${like} ESCAPE '\\')`);
  }
  const from = sql`supplier_claims AS c JOIN suppliers AS s ON s.id = c.supplier_id LEFT JOIN purchase_orders AS po ON po.id = c.po_id LEFT JOIN receipts AS r ON r.id = c.receipt_id`;
  const statusCondition = (status: ClaimFilter) => (status === "all" ? sql`1 = 1` : status === "active" ? sql`c.status IN ('open', 'submitted', 'accepted')` : sql`c.status = ${status}`);
  const countRows = await Promise.all(
    CLAIM_FILTERS.map(async (status) => {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM ${from} WHERE ${sql.join([...base, statusCondition(status)], sql` AND `)}`);
      return [status, Number(rows[0]?.n ?? 0)] as const;
    }),
  );
  const counts = Object.fromEntries(countRows) as Record<ClaimFilter, number>;
  const total = counts[filters.status];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<{ id: string; ref: string; kind: SupplierClaimKind; status: SupplierClaimStatus; supplierId: string; supplierCode: string; supplierName: string; poId: string | null; poRef: string | null; receiptId: string | null; receiptRef: string | null; items: string | null; createdAt: number; amountMinor: number | null; currency: string; amountIqd: number | null }>(sql`
    SELECT c.id AS id, c.ref AS ref, c.kind AS kind, c.status AS status, s.id AS supplierId, s.code AS supplierCode, s.name AS supplierName, po.id AS poId, po.ref AS poRef, r.id AS receiptId, r.ref AS receiptRef,
           c.items AS items, c.created_at AS createdAt, c.amount_minor AS amountMinor, c.currency AS currency, c.amount_iqd AS amountIqd
    FROM ${from} WHERE ${sql.join([...base, statusCondition(filters.status)], sql` AND `)}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`);
  return {
    rows: rows.map((row) => {
      const items = parseItems(row.items);
      const view: ClaimRow = {
        id: row.id,
        ref: row.ref,
        kind: row.kind,
        status: row.status,
        supplier: { id: row.supplierId, code: row.supplierCode, name: row.supplierName },
        po: row.poId && row.poRef ? { id: row.poId, ref: row.poRef } : null,
        receipt: row.receiptId && row.receiptRef ? { id: row.receiptId, ref: row.receiptRef } : null,
        units: items.reduce((sum, item) => sum + item.qty, 0),
        returned: items.filter((item) => item.returned?.done).reduce((sum, item) => sum + item.qty, 0),
        createdAt: row.createdAt,
      };
      return withCost ? { ...view, amountMinor: row.amountMinor, currency: row.currency, amountIqd: row.amountIqd } : view;
    }),
    total,
    page,
    pageCount,
    counts,
  };
}

export type ClaimLineView = {
  index: number;
  variant: VariantLabel;
  qty: number;
  serial?: string;
  /** Of `qty`: refused at inspection (never in stock — they go back without a stock movement) and leaving stock. */
  refused: number;
  fromStock: number;
  returned: { qty: number; location: string; at: number; done: boolean } | null;
};

export type ClaimDetail = {
  claim: {
    id: string;
    ref: string;
    kind: SupplierClaimKind;
    status: SupplierClaimStatus;
    supplier: { id: string; code: string; name: string };
    po: { id: string; ref: string } | null;
    receipt: { id: string; ref: string } | null;
    description: string | null;
    resolution: string | null;
    createdAt: number;
    resolvedAt: number | null;
    currency: string;
    amountMinor?: number | null;
    amountIqd?: number | null;
  };
  lines: ClaimLineView[];
  next: SupplierClaimStatus[];
  returnable: boolean;
  /** A return that stopped half way and may be resumed now. */
  returnState: "none" | "partial" | "done" | "in_progress" | "resumable";
  history: HistoryEntry[];
};

export async function getClaim(db: Db, actor: Actor, claimId: string, locale: Locale, now: number): Promise<ClaimDetail> {
  assertCan(actor, "purchasing.claim.manage");
  const claim = await db.select().from(supplierClaims).where(eq(supplierClaims.id, claimId)).get();
  if (!claim) throw notFound("supplier_claim");
  const [supplier, order, receipt, history] = await Promise.all([
    db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, claim.supplierId)).get(),
    claim.poId ? db.select({ id: purchaseOrders.id, ref: purchaseOrders.ref, locationId: purchaseOrders.locationId }).from(purchaseOrders).where(eq(purchaseOrders.id, claim.poId)).get() : Promise.resolve(undefined),
    claim.receiptId ? db.select({ id: receipts.id, ref: receipts.ref, locationId: receipts.locationId, status: receipts.status, receivedBy: receipts.receivedBy }).from(receipts).where(eq(receipts.id, claim.receiptId)).get() : Promise.resolve(undefined),
    historyOf(db, "supplier_claim", claim.id, 20),
  ]);
  await assertRecordBranch(db, actor, receipt?.locationId ?? order?.locationId ?? null);
  const items = parseItems(JSON.stringify(claim.items ?? []));
  const [labels, split] = await Promise.all([
    variantsById(
      db,
      items.map((item) => item.variantId),
      locale,
    ),
    claimSplit(db, claim, items),
  ]);
  const locationIds = [...new Set(items.map((item) => item.returned?.locationId).filter((id): id is string => Boolean(id)))];
  const locations = locationIds.length ? await db.all<{ id: string; code: string }>(sql`SELECT id, code FROM inventory_locations WHERE id IN (SELECT value FROM json_each(${JSON.stringify(locationIds)}))`) : [];
  const withCost = can(actor, "cost.read");
  const marks = items.map((item) => item.returned).filter((mark): mark is ReturnMark => Boolean(mark));
  const returnState: ClaimDetail["returnState"] =
    marks.length === 0
      ? "none"
      : marks.some((mark) => !mark.done)
        ? marks.some((mark) => !mark.done && mark.at + POSTING_LEASE_MS > now)
          ? "in_progress"
          : "resumable"
        : marks.length === items.length
          ? "done"
          : "partial";
  return {
    claim: {
      id: claim.id,
      ref: claim.ref,
      kind: claim.kind,
      status: claim.status,
      supplier: supplier ?? { id: claim.supplierId, code: "", name: "" },
      po: order ? { id: order.id, ref: order.ref } : null,
      receipt: receipt ? { id: receipt.id, ref: receipt.ref } : null,
      description: claim.description,
      resolution: claim.resolution,
      createdAt: claim.createdAt,
      resolvedAt: claim.resolvedAt,
      currency: claim.currency,
      ...(withCost ? { amountMinor: claim.amountMinor, amountIqd: claim.amountIqd } : {}),
    },
    lines: items.map((item, index) => ({
      index,
      variant: labels.get(item.variantId) ?? { id: item.variantId, sku: item.variantId, barcode: null, name: item.variantId, productName: item.variantId, variantTitle: "", trackSerials: false, isActive: false },
      qty: item.qty,
      ...(item.serial && can(actor, "inventory.serial.read") ? { serial: item.serial } : {}),
      refused: split[index]?.refused ?? 0,
      fromStock: split[index]?.stock ?? item.qty,
      returned: item.returned ? { qty: item.returned.qty, location: locations.find((row) => row.id === item.returned!.locationId)?.code ?? "—", at: item.returned.at, done: item.returned.done } : null,
    })),
    next: [...CLAIM_TRANSITIONS[claim.status]],
    returnable: RETURNABLE_CLAIM_KINDS.includes(claim.kind) && ["open", "submitted", "accepted"].includes(claim.status) && (returnState === "none" || returnState === "partial" || returnState === "resumable"),
    returnState,
    history,
  };
}


