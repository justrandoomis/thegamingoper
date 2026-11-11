/**
 * Purchase orders (admin 09.03): draft → submit → (within the spending limit: approved | above it: a second person
 * decides) → sent → partially received → received → closed; cancelled while nothing was received.
 *
 *   const { poId } = await savePurchaseOrder(db, actor, { supplierId, locationId, currency: "USD", fxRate: "1310",
 *                                                         expectedOn: "2026-11-20", lines: [{ code: "SKU", qty: "5", unitCost: "450.00" }], idempotencyKey }, now);
 *   await submitPurchaseOrder(db, actor, { poId, version }, now);   // → "approved" | "pending_approval"
 *   await decidePurchaseOrder(db, other, { poId, decision: "approve" }, now);
 *
 * RULES
 *   · Prices are supplier cost data [P]: writing an order (and seeing its amounts) needs cost.read as well as
 *     purchasing.po.create; deciding one needs purchasing.po.approve + cost.read. Without cost.read an order shows its
 *     quantities only — the amounts are absent from every result, not blank.
 *   · The spending limit (rules.ts PO_SPENDING_LIMIT_IQD; the order weighs its IQD total at the HIGHER of its own dated
 *     rate and the store's rate of the day, so a rate typed low never brings it under the limit): at or below it the
 *     requester's submission approves the order; above it an `approvals` row (kind "purchase_order") waits for someone
 *     holding purchasing.po.approve who did not create, edit or submit the order (approver_is_requester, 403). What the
 *     same person approved within the limit for the same supplier in the last SPLIT_WINDOW_DAYS counts with the order
 *     (an order split into pieces still meets a second person; the batch re-checks the sum). The decision is bound to
 *     the request the approver saw (`approvalId`) and to the total it was asked for: the order cannot change while it
 *     waits (only drafts are edited), and the batch re-checks it. A supplier blocked or made inactive meanwhile is not
 *     approved (supplier_not_active).
 *   · Lines are SKUs (typed or scanned: SKU, barcode or variant id) — never a bundle (it has no stock of its own); one
 *     line per SKU. Amounts are integers in the currency's minor units; the IQD total uses the order's dated rate
 *     (default: the store's USD rate of the day) and BigInt rounding (exact).
 *   · Every write is one batch with its audit event and a guard on the state it was decided on (`updated_at`,
 *     status): a stale tab or a double submit gets po_changed / the same result again (replayed), never a second order.
 *   · Inventory's "incoming" column reads po_items.qty_ordered − qty_received of approved / sent / partially received
 *     orders; receipts (receipts.server.ts) keep qty_received and the status current.
 * Error codes: forbidden (403), approver_is_requester (403), not_found (404), invalid (400), supplier_not_active,
 * location_invalid, po_changed, po_not_draft, po_not_pending, po_not_open, po_has_receipts, po_has_invoices, receipts_open (409).
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, inventoryLocations, poItems, purchaseOrders, rfqs, rfqQuotes, supplierContacts, suppliers, type PurchaseOrderStatus } from "~/server/db/schema";
import { chunkRows, expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { defaultRateMicros } from "../pricing/costs.server";
import {
  MAX_DOC_IQD,
  MAX_LINES,
  MAX_QTY,
  OPEN_PO_STATUSES,
  PO_SPENDING_LIMIT_IQD,
  PO_VIEWS,
  PO_SORTS,
  SPLIT_WINDOW_DAYS,
  baghdadDate,
  decimalsOf,
  endOfBaghdadDay,
  isCostCurrency,
  isLate,
  needsApproval,
  parseBaghdadDay,
  parseCount,
  parseDecimal,
  parseRateMicros,
  poTotals,
  poTotalsOrNull,
  receiptStateOf,
  toIqd,
  DAY_MS,
  type PoView,
  type ReceiptState,
} from "./rules";
import {
  ID_PATTERN,
  PAGE_SIZE,
  actorId,
  assertAll,
  assertRecordBranch,
  branchCondition,
  cleanQuery,
  employeeNames,
  historyOf,
  idField,
  idFromKey,
  keyField,
  likePattern,
  optionalText,
  pageOf,
  reasonField,
  resolveVariantCodes,
  usableLocation,
  variantsById,
  type HistoryEntry,
  type VariantLabel,
} from "./shared.server";

export const PO_ERROR_KEYS = ["supplier_not_active", "po_changed", "po_not_draft", "po_not_pending", "po_not_open", "po_has_receipts", "po_has_invoices", "receipts_open", "approver_is_requester", "fx_rate_required", "unknown_code", "bundle_not_purchasable", "duplicate_line", "expected_past"] as const;

// ───────────────────────────────────────────────────────────────── planning an order (shared by save and award)

const amountField = z.union([z.string(), z.number()]).optional();
export const PoLineInput = z.object({ code: z.string().trim().max(120, "too_long").optional().default(""), qty: amountField, unitCost: amountField });

export const SavePoInput = z.object({
  poId: z.string().trim().regex(ID_PATTERN, "invalid").optional(),
  version: z.coerce.number().int().optional(),
  supplierId: idField,
  locationId: idField,
  currency: z.string({ error: "required" }).trim().toUpperCase().refine(isCostCurrency, "invalid"),
  fxRate: amountField,
  expectedOn: z.string().trim().max(20, "invalid").optional(),
  paymentTerms: optionalText(120),
  notes: optionalText(1000),
  shipping: amountField,
  other: amountField,
  lines: z.array(PoLineInput).max(MAX_LINES, "too_many"),
  idempotencyKey: keyField.optional(),
});
export type SavePoInput = z.input<typeof SavePoInput>;

export type PlannedOrder = {
  supplier: { id: string; code: string; name: string };
  location: { id: string; code: string };
  currency: string;
  fxRateMicros: number;
  expectedAt: number | null;
  shippingMinor: number;
  otherMinor: number;
  lines: { variantId: string; qty: number; unitCostMinor: number; sku: string }[];
  subtotalMinor: number;
  totalMinor: number;
  totalIqd: number;
};

const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/** Validates an order as a form describes it; every problem comes back at once as field errors. */
export async function planOrder(db: Db, actor: Actor, input: z.output<typeof SavePoInput>, now: number, locale: Locale): Promise<PlannedOrder> {
  const fields: Record<string, string> = {};
  const supplier = await db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name, status: suppliers.status }).from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
  if (!supplier) fields.supplierId = "not_found";
  else if (supplier.status !== "active") fields.supplierId = "supplier_not_active";
  let location: { id: string; code: string } | null = null;
  try {
    location = await usableLocation(db, actor, input.locationId);
  } catch (error) {
    const app = toAppError(error);
    if (!app || app.status === 403) throw error;
    fields.locationId = "location_invalid";
  }
  const currency = input.currency;
  const decimals = decimalsOf(currency);
  let fxRateMicros = 1_000_000;
  if (currency !== "IQD") {
    const typed = blank(input.fxRate) ? null : parseRateMicros(input.fxRate);
    if (!blank(input.fxRate) && (typed === null || typed <= 0)) fields.fxRate = "invalid";
    else {
      const rate = typed ?? (await defaultRateMicros(db, currency, baghdadDate(now)));
      if (rate === null || rate <= 0) fields.fxRate = "fx_rate_required";
      else fxRateMicros = rate;
    }
  }
  let expectedAt: number | null = null;
  if (!blank(input.expectedOn)) {
    expectedAt = parseBaghdadDay(input.expectedOn);
    if (expectedAt === null) fields.expectedOn = "invalid";
    else if (endOfBaghdadDay(expectedAt) <= now) fields.expectedOn = "expected_past";
    else if (expectedAt > now + 400 * DAY_MS) fields.expectedOn = "too_big";
  }
  const money = (value: unknown, field: string) => {
    if (blank(value)) return 0;
    const parsed = parseDecimal(value, decimals);
    if (parsed === null) fields[field] = "invalid";
    return parsed ?? 0;
  };
  const shippingMinor = money(input.shipping, "shipping");
  const otherMinor = money(input.other, "other");

  const typed = input.lines.map((line, index) => ({ ...line, index })).filter((line) => !(blank(line.code) && blank(line.qty) && blank(line.unitCost)));
  if (typed.length === 0) fields.lines = "po_empty";
  const { found } = await resolveVariantCodes(
    db,
    typed.map((line) => line.code),
    locale,
  );
  const lines: PlannedOrder["lines"] = [];
  const seen = new Map<string, number>();
  for (const line of typed) {
    const at = `lines.${line.index}`;
    const variant = line.code ? found.get(line.code.trim()) : undefined;
    if (!line.code) fields[`${at}.code`] = "required";
    else if (!variant) fields[`${at}.code`] = "unknown_code";
    else if (variant.isBundle) fields[`${at}.code`] = "bundle_not_purchasable";
    else if (seen.has(variant.id)) fields[`${at}.code`] = "duplicate_line";
    const qty = parseCount(line.qty);
    if (qty === undefined) fields[`${at}.qty`] = "required";
    else if (Number.isNaN(qty) || qty < 1) fields[`${at}.qty`] = "invalid";
    else if (qty > MAX_QTY) fields[`${at}.qty`] = "too_big";
    const cost = blank(line.unitCost) ? undefined : parseDecimal(line.unitCost, decimals);
    if (cost === undefined) fields[`${at}.unitCost`] = "required";
    else if (cost === null) fields[`${at}.unitCost`] = "invalid";
    if (variant && !variant.isBundle && !seen.has(variant.id)) seen.set(variant.id, line.index);
    if (variant && qty !== undefined && !Number.isNaN(qty) && qty >= 1 && qty <= MAX_QTY && typeof cost === "number") lines.push({ variantId: variant.id, qty, unitCostMinor: cost, sku: variant.sku });
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const totals = poTotalsOrNull(lines, shippingMinor, otherMinor);
  if (!totals) throw invalid({ lines: "too_big" });
  const { subtotalMinor, totalMinor } = totals;
  const totalIqd = toIqd(totalMinor, currency, fxRateMicros);
  if (totalIqd === null || !Number.isSafeInteger(totalIqd) || totalIqd > MAX_DOC_IQD) throw invalid({ lines: "too_big" });
  return { supplier: { id: supplier!.id, code: supplier!.code, name: supplier!.name }, location: location!, currency, fxRateMicros, expectedAt, shippingMinor, otherMinor, lines, subtotalMinor, totalMinor, totalIqd };
}

function itemRows(poId: string, plan: PlannedOrder) {
  return plan.lines.map((line) => ({ id: newId("poi"), poId, variantId: line.variantId, qtyOrdered: line.qty, qtyReceived: 0, unitCostMinor: line.unitCostMinor }));
}

/** Statements that insert a new draft order (save and the RFQ award share them). */
export function insertOrderStatements(db: Db, actor: Actor, args: { poId: string; ref: string; plan: PlannedOrder; paymentTerms: string | null; notes: string | null; rfqQuoteId?: string | null; isDemo?: boolean; now: number }): BatchStatement[] {
  const { plan, now } = args;
  const items = itemRows(args.poId, plan);
  return [
    db.insert(purchaseOrders).values({
      id: args.poId,
      ref: args.ref,
      supplierId: plan.supplier.id,
      rfqQuoteId: args.rfqQuoteId ?? null,
      status: "draft",
      currency: plan.currency,
      fxRateMicros: plan.fxRateMicros,
      fxDate: baghdadDate(now),
      subtotalMinor: plan.subtotalMinor,
      shippingMinor: plan.shippingMinor,
      otherMinor: plan.otherMinor,
      totalMinor: plan.totalMinor,
      totalIqd: plan.totalIqd,
      locationId: plan.location.id,
      expectedAt: plan.expectedAt,
      paymentTerms: args.paymentTerms,
      notes: args.notes,
      isDemo: args.isDemo ?? false,
      createdBy: actorId(actor),
      createdAt: now,
      updatedAt: now,
    }),
    ...chunkRows(poItems, items).map((rows) => db.insert(poItems).values(rows)),
    auditStatement(db, {
      actor,
      action: "purchasing.po.create",
      entityType: "purchase_order",
      entityId: args.poId,
      summary: `${args.ref} · ${plan.supplier.code}`,
      after: { ref: args.ref, supplier: plan.supplier.code, location: plan.location.code, lines: plan.lines.map((line) => ({ sku: line.sku, qty: line.qty })), rfqQuoteId: args.rfqQuoteId ?? null },
      at: now,
    }),
  ];
}

/**
 * Creates a draft (no poId; the form's idempotency key decides the id, so a double submit returns the first order) or
 * replaces a draft's header and lines (poId + version = its updated_at).
 */
export async function savePurchaseOrder(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale = "ar", options: { demo?: boolean } = {}): Promise<{ poId: string; ref: string; replayed: boolean }> {
  assertAll(actor, ["purchasing.po.create", "cost.read"]);
  const input = SavePoInput.parse(raw);
  if (!input.poId) {
    if (!input.idempotencyKey) throw invalid({ idempotencyKey: "required" });
    const poId = await idFromKey("po", actor, input.idempotencyKey);
    const existing = await db.select({ id: purchaseOrders.id, ref: purchaseOrders.ref }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get();
    if (existing) return { poId: existing.id, ref: existing.ref, replayed: true };
    const plan = await planOrder(db, actor, input, now, locale);
    const ref = `PO-${poId.slice(3, 11).toUpperCase()}`;
    try {
      await runBatch(db, insertOrderStatements(db, actor, { poId, ref, plan, paymentTerms: input.paymentTerms, notes: input.notes, isDemo: options.demo, now }));
    } catch (error) {
      if (isUniqueViolation(error, "purchase_orders.id")) {
        const row = await db.select({ ref: purchaseOrders.ref }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get();
        return { poId, ref: row?.ref ?? ref, replayed: true };
      }
      throw toAppError(error) ?? error;
    }
    return { poId, ref, replayed: false };
  }
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  if (order.status !== "draft") throw new AppError("po_not_draft", 409);
  if (input.version === undefined || order.updatedAt !== input.version) throw new AppError("po_changed", 409);
  const plan = await planOrder(db, actor, input, now, locale);
  const before = await db.select({ variantId: poItems.variantId, qty: poItems.qtyOrdered }).from(poItems).where(eq(poItems.poId, order.id));
  const items = itemRows(order.id, plan);
  await runBatch(db, [
    db
      .update(purchaseOrders)
      .set({
        supplierId: plan.supplier.id,
        currency: plan.currency,
        fxRateMicros: plan.fxRateMicros,
        fxDate: baghdadDate(now),
        subtotalMinor: plan.subtotalMinor,
        shippingMinor: plan.shippingMinor,
        otherMinor: plan.otherMinor,
        totalMinor: plan.totalMinor,
        totalIqd: plan.totalIqd,
        locationId: plan.location.id,
        expectedAt: plan.expectedAt,
        paymentTerms: input.paymentTerms,
        notes: input.notes,
        updatedAt: now,
      })
      .where(and(eq(purchaseOrders.id, order.id), eq(purchaseOrders.status, "draft"), eq(purchaseOrders.updatedAt, input.version))),
    expectChanged(db, 1, { code: "PO_CHANGED", detail: order.id }),
    db.delete(poItems).where(eq(poItems.poId, order.id)),
    ...chunkRows(poItems, items).map((rows) => db.insert(poItems).values(rows)),
    auditStatement(db, {
      actor,
      action: "purchasing.po.update",
      entityType: "purchase_order",
      entityId: order.id,
      summary: order.ref,
      before: { supplierId: order.supplierId, locationId: order.locationId, lines: before.length, units: before.reduce((sum, line) => sum + line.qty, 0) },
      after: { supplier: plan.supplier.code, location: plan.location.code, lines: plan.lines.map((line) => ({ sku: line.sku, qty: line.qty })) },
      at: now,
    }),
  ]).catch((error) => {
    if (isDbError(error, "PO_CHANGED")) throw new AppError("po_changed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { poId: order.id, ref: order.ref, replayed: false };
}

// ───────────────────────────────────────────────────────────────── submit, decide, send, cancel, close

/** Orders approved within the limit by their own submitter (no approval row, approved_by set) in the window. */
const selfApprovedWhere = (supplierId: string, approvedBy: string, now: number, exceptPoId: string) => sql`
  supplier_id = ${supplierId} AND approved_by = ${approvedBy} AND approval_id IS NULL
  AND status IN ('approved', 'sent', 'partially_received', 'received', 'closed')
  AND approved_at > ${now - SPLIT_WINDOW_DAYS * DAY_MS} AND id <> ${exceptPoId}`;

type LimitOrder = { currency: string; totalMinor: number; totalIqd: number | null };

/** The store's rate of the day per currency (IQD per unit × 10⁶; null when the store keeps none). */
async function storeRates(db: Db, currencies: Iterable<string>, now: number): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const currency of new Set(currencies)) out.set(currency, await defaultRateMicros(db, currency, baghdadDate(now)));
  return out;
}

/**
 * What an order weighs against the spending limit: its IQD total at the higher of its own dated rate and the store's
 * rate of the day — a rate typed low (by mistake or not) never brings an order under the limit.
 */
function limitValueOf(order: LimitOrder, rates: ReadonlyMap<string, number | null>): number {
  const atStore = toIqd(order.totalMinor, order.currency, rates.get(order.currency) ?? null);
  return Math.max(order.totalIqd ?? 0, atStore ?? 0);
}

/**
 * What this person approved within the limit for this supplier in the last SPLIT_WINDOW_DAYS (other orders), weighed
 * as the limit weighs it: it counts with the next order they submit, so an order split into pieces below the limit
 * still meets a second person. `count` lets the write check that no other piece was approved meanwhile.
 */
export async function limitWindow(db: Db, supplierId: string, approvedBy: string | null, now: number, exceptPoId: string): Promise<{ count: number; iqd: number }> {
  if (!approvedBy) return { count: 0, iqd: 0 };
  const rows = await db.all<LimitOrder>(sql`SELECT currency, total_minor AS totalMinor, total_iqd AS totalIqd FROM purchase_orders WHERE ${selfApprovedWhere(supplierId, approvedBy, now, exceptPoId)}`);
  const rates = await storeRates(
    db,
    rows.map((row) => row.currency),
    now,
  );
  return { count: rows.length, iqd: rows.reduce((sum, row) => sum + limitValueOf({ currency: row.currency, totalMinor: Number(row.totalMinor), totalIqd: row.totalIqd === null ? null : Number(row.totalIqd) }, rates), 0) };
}

/** How the limit sees a draft now: its own weight, the window's, the total at the store's rate, and the verdict. */
export type LimitCheck = { orderIqd: number; storeRateIqd: number | null; windowIqd: number; windowCount: number; needsApproval: boolean };

async function limitCheckOf(db: Db, order: LimitOrder & { supplierId: string; id: string }, approvedBy: string | null, now: number): Promise<LimitCheck> {
  const [rates, window] = await Promise.all([storeRates(db, [order.currency], now), limitWindow(db, order.supplierId, approvedBy, now, order.id)]);
  const orderIqd = limitValueOf(order, rates);
  const storeRateIqd = order.currency === "IQD" ? null : toIqd(order.totalMinor, order.currency, rates.get(order.currency) ?? null);
  return { orderIqd, storeRateIqd, windowIqd: window.iqd, windowCount: window.count, needsApproval: needsApproval(orderIqd, PO_SPENDING_LIMIT_IQD, window.iqd) };
}

/** Audit actions after which an employee may no longer decide the order's approval: they shaped or asked for it. */
const SHAPING_ACTIONS = ["purchasing.po.create", "purchasing.po.update", "purchasing.po.submit"] as const;

/** True when the employee created, edited or submitted the order (any version of it). */
async function shapedOrder(db: Db, poId: string, employeeId: string | null): Promise<boolean> {
  if (!employeeId) return false;
  const rows = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM audit_events
    WHERE entity_type = 'purchase_order' AND entity_id = ${poId} AND actor_id = ${employeeId}
      AND action IN (SELECT value FROM json_each(${JSON.stringify(SHAPING_ACTIONS)}))`);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** SQL: the order `po` was created, edited or submitted by this employee (the home page's approval count). */
export function shapedBySql(employeeId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM audit_events AS ae WHERE ae.entity_type = 'purchase_order' AND ae.entity_id = po.id AND ae.actor_id = ${employeeId}
    AND ae.action IN (SELECT value FROM json_each(${JSON.stringify(SHAPING_ACTIONS)})))`;
}

export const SubmitInput = z.object({ poId: idField, version: z.coerce.number().int(), note: z.string().trim().max(500, "too_long").optional() });

/** Submits a draft: within the spending limit it is approved at once; above it, it waits for a second person. */
export async function submitPurchaseOrder(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "approved" | "pending_approval"; replayed: boolean }> {
  assertAll(actor, ["purchasing.po.create", "cost.read"]);
  const input = SubmitInput.parse(raw);
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  if (order.status === "approved" || order.status === "pending_approval") return { status: order.status, replayed: true };
  if (order.status !== "draft") throw new AppError("po_not_draft", 409);
  if (order.updatedAt !== input.version) throw new AppError("po_changed", 409);
  const lines = await db.select().from(poItems).where(eq(poItems.poId, order.id));
  if (lines.length === 0) throw invalid({ lines: "po_empty" });
  const supplier = await db.select({ status: suppliers.status, code: suppliers.code }).from(suppliers).where(eq(suppliers.id, order.supplierId)).get();
  if (!supplier || supplier.status !== "active") throw new AppError("supplier_not_active", 409, { fields: { supplierId: "supplier_not_active" } });
  await usableLocation(db, actor, order.locationId);
  const { subtotalMinor, totalMinor } = poTotals(
    lines.map((line) => ({ qty: line.qtyOrdered, unitCostMinor: line.unitCostMinor })),
    order.shippingMinor,
    order.otherMinor,
  );
  const totalIqd = toIqd(totalMinor, order.currency, order.fxRateMicros);
  if (totalIqd === null) throw invalid({ fxRate: "fx_rate_required" });
  const me = actorId(actor);
  const check = await limitCheckOf(db, { id: order.id, supplierId: order.supplierId, currency: order.currency, totalMinor, totalIqd }, me, now);
  const windowIqd = check.windowIqd;
  const guarded = and(eq(purchaseOrders.id, order.id), eq(purchaseOrders.status, "draft"), eq(purchaseOrders.updatedAt, input.version));
  const statements: BatchStatement[] = [];
  let status: "approved" | "pending_approval";
  if (!check.needsApproval) {
    status = "approved";
    statements.push(
      // Another piece approved by this person meanwhile (a second tab) must not slip under the limit: the write checks
      // that the window still holds the orders it was weighed with.
      ...(me ? [expectThat(db, sql`(SELECT count(*) FROM purchase_orders WHERE ${selfApprovedWhere(order.supplierId, me, now, order.id)}) = ${check.windowCount}`, { code: "PO_CHANGED", detail: order.id })] : []),
      db.update(purchaseOrders).set({ status, subtotalMinor, totalMinor, totalIqd, approvedBy: me, approvedAt: now, approvalId: null, updatedAt: now }).where(guarded),
      expectChanged(db, 1, { code: "PO_CHANGED", detail: order.id }),
      auditStatement(db, { actor, action: "purchasing.po.submit", entityType: "purchase_order", entityId: order.id, summary: order.ref, before: { status: "draft" }, after: { status, withinLimit: true, windowIqd }, reason: input.note || null, at: now }),
    );
  } else {
    status = "pending_approval";
    const approvalId = newId("apr");
    statements.push(
      db.insert(approvals).values({
        id: approvalId,
        kind: "purchase_order",
        entityType: "purchase_order",
        entityId: order.id,
        requestedBy: me ?? "unknown",
        payload: {
          ref: order.ref,
          totalIqd,
          totalMinor,
          currency: order.currency,
          limitIqd: PO_SPENDING_LIMIT_IQD,
          windowIqd,
          windowDays: SPLIT_WINDOW_DAYS,
          // The order's rate is below the store's: what it weighs at the store's rate of the day.
          ...(check.orderIqd > totalIqd ? { storeRateIqd: check.orderIqd } : {}),
        },
        status: "pending",
        reason: input.note || null,
        requiredPermission: "purchasing.po.approve",
        createdAt: now,
      }),
      db.update(purchaseOrders).set({ status, subtotalMinor, totalMinor, totalIqd, approvalId, updatedAt: now }).where(guarded),
      expectChanged(db, 1, { code: "PO_CHANGED", detail: order.id }),
      auditStatement(db, { actor, action: "purchasing.po.submit", entityType: "purchase_order", entityId: order.id, summary: order.ref, before: { status: "draft" }, after: { status, approvalId, withinLimit: false, windowIqd }, reason: input.note || null, at: now }),
    );
  }
  await runBatch(db, statements).catch((error) => {
    if (isDbError(error, "PO_CHANGED")) throw new AppError("po_changed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { status, replayed: false };
}

export const DecideInput = z.object({
  poId: idField,
  decision: z.enum(["approve", "reject"], { error: "invalid" }),
  note: z.string().trim().max(500, "too_long").optional(),
  /** The request the approver saw on the page: a newer request (sent back, changed, asked again) is not decided by it. */
  approvalId: z.string().trim().regex(ID_PATTERN, "invalid").optional(),
});

/** A second person approves an order above the limit, or sends it back to draft with a reason. */
export async function decidePurchaseOrder(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: PurchaseOrderStatus; replayed: boolean }> {
  assertAll(actor, ["purchasing.po.approve", "cost.read"]);
  const input = DecideInput.parse(raw);
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  const approval = order.approvalId ? await db.select().from(approvals).where(eq(approvals.id, order.approvalId)).get() : undefined;
  if (input.approvalId !== undefined && approval?.id !== input.approvalId) throw new AppError("po_changed", 409);
  if (order.status !== "pending_approval" || !approval || approval.status !== "pending") {
    if (approval && approval.decidedBy === actorId(actor) && approval.status === (input.decision === "approve" ? "approved" : "rejected")) return { status: order.status, replayed: true };
    throw new AppError("po_not_pending", 409);
  }
  const me = actorId(actor);
  if (approval.requestedBy === me || order.createdBy === me || (await shapedOrder(db, order.id, me))) throw new AppError("approver_is_requester", 403);
  if (input.decision === "reject" && (input.note ?? "").length < 3) throw invalid({ note: "reason_short" });
  const approve = input.decision === "approve";
  if (approve) {
    const supplier = await db.select({ status: suppliers.status }).from(suppliers).where(eq(suppliers.id, order.supplierId)).get();
    if (!supplier || supplier.status !== "active") throw new AppError("supplier_not_active", 409, { fields: { supplierId: "supplier_not_active" } });
  }
  const totalIqd = Number((approval.payload as { totalIqd?: number } | null)?.totalIqd ?? order.totalIqd);
  await runBatch(db, [
    ...(approve ? [expectThat(db, sql`(SELECT status FROM suppliers WHERE id = ${order.supplierId}) = 'active'`, { code: "SUPPLIER_NOT_ACTIVE", detail: order.supplierId })] : []),
    db
      .update(approvals)
      .set({ status: approve ? "approved" : "rejected", decidedBy: me, decidedAt: now, decisionNote: input.note || null })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "PO_CHANGED", detail: approval.id }),
    db
      .update(purchaseOrders)
      .set(approve ? { status: "approved", approvedBy: me, approvedAt: now, updatedAt: now } : { status: "draft", updatedAt: now })
      .where(and(eq(purchaseOrders.id, order.id), eq(purchaseOrders.status, "pending_approval"), eq(purchaseOrders.totalIqd, totalIqd))),
    expectChanged(db, 1, { code: "PO_CHANGED", detail: order.id }),
    auditStatement(db, {
      actor,
      action: approve ? "purchasing.po.approve" : "purchasing.po.reject",
      entityType: "purchase_order",
      entityId: order.id,
      summary: order.ref,
      before: { status: "pending_approval", requestedBy: approval.requestedBy },
      after: { status: approve ? "approved" : "draft", approvalId: approval.id },
      reason: input.note || null,
      at: now,
    }),
  ]).catch((error) => {
    if (isDbError(error, "SUPPLIER_NOT_ACTIVE")) throw new AppError("supplier_not_active", 409, { fields: { supplierId: "supplier_not_active" }, cause: error });
    if (isDbError(error, "PO_CHANGED")) throw new AppError("po_changed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { status: approve ? "approved" : "draft", replayed: false };
}

export const SentInput = z.object({ poId: idField });

/** The approved order went to the supplier (by email, WhatsApp or on paper — outside the system). */
export async function markOrderSent(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "purchasing.po.create");
  const input = SentInput.parse(raw);
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  if (order.sentAt !== null && order.status !== "approved") return { replayed: true };
  if (order.status !== "approved") throw new AppError("po_not_open", 409);
  await runBatch(db, [
    db
      .update(purchaseOrders)
      .set({ status: "sent", sentAt: now, updatedAt: now })
      .where(and(eq(purchaseOrders.id, order.id), eq(purchaseOrders.status, "approved"))),
    expectChanged(db, 1, { code: "PO_CHANGED", detail: order.id }),
    auditStatement(db, { actor, action: "purchasing.po.send", entityType: "purchase_order", entityId: order.id, summary: order.ref, before: { status: "approved" }, after: { status: "sent" }, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "PO_CHANGED")) throw new AppError("po_changed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { replayed: false };
}

export const BulkSentInput = z.object({ poIds: z.array(idField).min(1, "required").max(50, "too_many") });

/** "Mark as sent" for several approved orders (the list's bulk action); orders in another state are skipped. */
export async function markOrdersSent(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ sent: number; skipped: number }> {
  assertCan(actor, "purchasing.po.create");
  const input = BulkSentInput.parse(raw);
  let sent = 0;
  let skipped = 0;
  for (const poId of [...new Set(input.poIds)]) {
    try {
      const result = await markOrderSent(db, actor, { poId }, now);
      if (result.replayed) skipped++;
      else sent++;
    } catch (error) {
      const app = toAppError(error);
      if (!app || app.status === 403) throw error;
      skipped++;
    }
  }
  return { sent, skipped };
}

export const CancelInput = z.object({ poId: idField, reason: reasonField });

/**
 * Cancels an order on which nothing was received (no receipt other than cancelled ones) and nothing is billed (no invoice
 * other than void ones: an advance bill is voided or settled first); a waiting approval is withdrawn.
 */
export async function cancelPurchaseOrder(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "purchasing.po.create");
  const input = CancelInput.parse(raw);
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  if (order.status === "cancelled") return { replayed: true };
  if (!["draft", "pending_approval", "approved", "sent"].includes(order.status)) throw new AppError("po_not_open", 409);
  const receipts = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM receipts WHERE po_id = ${order.id} AND status <> 'cancelled'`);
  if (Number(receipts[0]?.n ?? 0) > 0) throw new AppError("po_has_receipts", 409);
  // A supplier's invoice on the order (an advance bill) would stay payable for an order that no longer exists: it is
  // voided first (or settled through a claim), then the order is cancelled.
  const invoices = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM supplier_invoices WHERE po_id = ${order.id} AND status <> 'void'`);
  if (Number(invoices[0]?.n ?? 0) > 0) throw new AppError("po_has_invoices", 409);
  const statements: BatchStatement[] = [
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM receipts WHERE po_id = ${order.id} AND status <> 'cancelled')`, { code: "PO_HAS_RECEIPTS", detail: order.id }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM supplier_invoices WHERE po_id = ${order.id} AND status <> 'void')`, { code: "PO_HAS_INVOICES", detail: order.id }),
    db
      .update(purchaseOrders)
      .set({ status: "cancelled", cancelledAt: now, cancelReason: input.reason, updatedAt: now })
      .where(and(eq(purchaseOrders.id, order.id), eq(purchaseOrders.status, order.status))),
    expectChanged(db, 1, { code: "PO_CHANGED", detail: order.id }),
  ];
  if (order.status === "pending_approval" && order.approvalId) {
    statements.push(db.update(approvals).set({ status: "rejected", decidedBy: actorId(actor), decidedAt: now, decisionNote: `withdrawn: ${input.reason}`.slice(0, 500) }).where(and(eq(approvals.id, order.approvalId), eq(approvals.status, "pending"))));
  }
  statements.push(auditStatement(db, { actor, action: "purchasing.po.cancel", entityType: "purchase_order", entityId: order.id, summary: order.ref, before: { status: order.status }, after: { status: "cancelled" }, reason: input.reason, at: now }));
  await runBatch(db, statements).catch((error) => {
    if (isDbError(error, "PO_HAS_RECEIPTS")) throw new AppError("po_has_receipts", 409, { cause: error });
    if (isDbError(error, "PO_HAS_INVOICES")) throw new AppError("po_has_invoices", 409, { cause: error });
    if (isDbError(error, "PO_CHANGED")) throw new AppError("po_changed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { replayed: false };
}

export const CloseInput = z.object({ poId: idField, reason: z.string().trim().max(500, "too_long").optional() });

/**
 * Closes a received or partially received order: what is still missing is no longer expected (it leaves the
 * "incoming" column). A shortfall needs a reason; open (draft or posting) receipts must be finished first.
 */
export async function closePurchaseOrder(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ outstanding: number; replayed: boolean }> {
  assertCan(actor, "purchasing.po.create");
  const input = CloseInput.parse(raw);
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  if (order.status === "closed") return { outstanding: 0, replayed: true };
  if (order.status !== "partially_received" && order.status !== "received") throw new AppError("po_not_open", 409);
  const outstandingRows = await db.all<{ n: number }>(sql`SELECT coalesce(SUM(max(qty_ordered - qty_received, 0)), 0) AS n FROM po_items WHERE po_id = ${order.id}`);
  const outstanding = Number(outstandingRows[0]?.n ?? 0);
  if (outstanding > 0 && (input.reason ?? "").length < 3) throw invalid({ reason: "reason_short" });
  await runBatch(db, [
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM receipts WHERE po_id = ${order.id} AND (status = 'draft' OR (status = 'posted' AND received_by LIKE 'posting:%')))`, { code: "RECEIPTS_OPEN", detail: order.id }),
    db
      .update(purchaseOrders)
      .set({ status: "closed", updatedAt: now })
      .where(and(eq(purchaseOrders.id, order.id), eq(purchaseOrders.status, order.status))),
    expectChanged(db, 1, { code: "PO_CHANGED", detail: order.id }),
    auditStatement(db, { actor, action: "purchasing.po.close", entityType: "purchase_order", entityId: order.id, summary: order.ref, before: { status: order.status }, after: { status: "closed", outstanding }, reason: input.reason || null, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "RECEIPTS_OPEN")) throw new AppError("receipts_open", 409, { cause: error });
    if (isDbError(error, "PO_CHANGED")) throw new AppError("po_changed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { outstanding, replayed: false };
}

// ───────────────────────────────────────────────────────────────── list

export { PO_SORTS };
export type PoSort = (typeof PO_SORTS)[number];
export type PoFilters = { view: PoView; supplier: string | null; q: string; sort: PoSort; dir: "asc" | "desc"; page: number };

export function parsePoFilters(params: URLSearchParams): PoFilters {
  const view = params.get("view");
  const sort = params.get("sort");
  const supplier = params.get("supplier");
  return {
    view: (PO_VIEWS as readonly string[]).includes(view ?? "") ? (view as PoView) : "open",
    supplier: supplier && ID_PATTERN.test(supplier) ? supplier : null,
    q: cleanQuery(params.get("q")),
    sort: (PO_SORTS as readonly string[]).includes(sort ?? "") ? (sort as PoSort) : "created",
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    page: pageOf(params.get("page")),
  };
}

function viewCondition(view: PoView, now: number) {
  switch (view) {
    case "open":
      return sql`po.status IN ('approved', 'sent', 'partially_received')`;
    case "pending_approval":
      return sql`po.status = 'pending_approval'`;
    case "draft":
      return sql`po.status = 'draft'`;
    case "late":
      return sql`po.status IN ('approved', 'sent', 'partially_received') AND po.expected_at IS NOT NULL AND po.expected_at + ${DAY_MS} <= ${now}`;
    case "received":
      return sql`po.status = 'received'`;
    case "closed":
      return sql`po.status IN ('closed', 'cancelled')`;
    default:
      return sql`1 = 1`;
  }
}

export type PoRow = {
  id: string;
  ref: string;
  status: PurchaseOrderStatus;
  supplier: { id: string; code: string; name: string };
  location: string | null;
  expectedAt: number | null;
  late: boolean;
  units: number;
  unitsReceived: number;
  createdAt: number;
  createdBy: string | null;
  /** [P] */
  currency?: string;
  totalMinor?: number;
  totalIqd?: number | null;
};
export type PoPage = { rows: PoRow[]; total: number; page: number; pageCount: number; counts: Record<PoView, number> };

export async function listPurchaseOrders(db: Db, actor: Actor, filters: PoFilters, now: number): Promise<PoPage> {
  assertCan(actor, "purchasing.po.read");
  const withCost = can(actor, "cost.read");
  const base = [branchCondition(actor, sql`po.location_id`)];
  if (filters.supplier) base.push(sql`po.supplier_id = ${filters.supplier}`);
  if (filters.q) {
    const like = likePattern(filters.q);
    base.push(sql`(po.ref LIKE ${like} ESCAPE '\\' OR s.name LIKE ${like} ESCAPE '\\' OR s.code LIKE ${like} ESCAPE '\\')`);
  }
  const where = sql.join([...base, viewCondition(filters.view, now)], sql` AND `);
  const order = { created: sql`po.created_at`, expected: sql`coalesce(po.expected_at, 9e15)`, ref: sql`po.ref`, supplier: sql`s.name` }[filters.sort];
  const direction = filters.dir === "asc" ? sql`ASC` : sql`DESC`;
  const counts = await Promise.all(
    PO_VIEWS.map(async (view) => {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM purchase_orders AS po JOIN suppliers AS s ON s.id = po.supplier_id WHERE ${sql.join([...base, viewCondition(view, now)], sql` AND `)}`);
      return [view, Number(rows[0]?.n ?? 0)] as const;
    }),
  );
  const total = Object.fromEntries(counts)[filters.view] ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<{ id: string; ref: string; status: PurchaseOrderStatus; supplierId: string; supplierCode: string; supplierName: string; location: string | null; expectedAt: number | null; units: number; unitsReceived: number; createdAt: number; createdBy: string | null; currency: string; totalMinor: number; totalIqd: number | null }>(sql`
    SELECT po.id AS id, po.ref AS ref, po.status AS status, s.id AS supplierId, s.code AS supplierCode, s.name AS supplierName, l.code AS location,
           po.expected_at AS expectedAt, po.created_at AS createdAt, po.created_by AS createdBy, po.currency AS currency, po.total_minor AS totalMinor, po.total_iqd AS totalIqd,
           coalesce((SELECT SUM(qty_ordered) FROM po_items WHERE po_id = po.id), 0) AS units, coalesce((SELECT SUM(qty_received) FROM po_items WHERE po_id = po.id), 0) AS unitsReceived
    FROM purchase_orders AS po JOIN suppliers AS s ON s.id = po.supplier_id LEFT JOIN inventory_locations AS l ON l.id = po.location_id
    WHERE ${where}
    ORDER BY ${order} ${direction}, po.id ${direction}
    LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`);
  const names = await employeeNames(
    db,
    rows.map((row) => row.createdBy),
  );
  return {
    rows: rows.map((row) => {
      const view: PoRow = {
        id: row.id,
        ref: row.ref,
        status: row.status,
        supplier: { id: row.supplierId, code: row.supplierCode, name: row.supplierName },
        location: row.location,
        expectedAt: row.expectedAt,
        late: isLate(row, now),
        units: Number(row.units),
        unitsReceived: Number(row.unitsReceived),
        createdAt: row.createdAt,
        createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
      };
      return withCost ? { ...view, currency: row.currency, totalMinor: row.totalMinor, totalIqd: row.totalIqd } : view;
    }),
    total,
    page,
    pageCount,
    counts: Object.fromEntries(counts) as Record<PoView, number>,
  };
}

// ───────────────────────────────────────────────────────────────── one order

export type PoLineView = {
  id: string;
  variant: VariantLabel;
  qtyOrdered: number;
  qtyReceived: number;
  /** In receipts not posted yet (draft or posting). */
  qtyPending: number;
  qtyInvoiced: number;
  outstanding: number;
  /** [P] */
  unitCostMinor?: number;
  lineTotalMinor?: number;
};

export type ApprovalView = {
  id: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: string | null;
  requestedById: string;
  requestedAt: number;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
  /**
   * [P] the total asked for, the limit, what the requester had approved alone for the supplier that week, and —
   * when the order's rate was below the store's — what it weighed at the store's rate.
   */
  totalIqd?: number;
  limitIqd?: number;
  windowIqd?: number;
  storeRateIqd?: number;
};

export type OrderDetail = {
  order: {
    id: string;
    ref: string;
    status: PurchaseOrderStatus;
    supplier: { id: string; code: string; name: string; status: string; currency: string };
    location: { id: string; code: string; name: string } | null;
    currency: string;
    expectedAt: number | null;
    late: boolean;
    paymentTerms: string | null;
    notes: string | null;
    createdAt: number;
    createdBy: string | null;
    updatedAt: number;
    approvedAt: number | null;
    approvedBy: string | null;
    sentAt: number | null;
    cancelledAt: number | null;
    cancelReason: string | null;
    isDemo: boolean;
    rfq: { id: string; ref: string } | null;
    /** [P] */
    fxRateMicros?: number | null;
    subtotalMinor?: number;
    shippingMinor?: number;
    otherMinor?: number;
    totalMinor?: number;
    totalIqd?: number | null;
  };
  lines: PoLineView[];
  units: { ordered: number; received: number; pending: number; outstanding: number };
  approvals: ApprovalView[];
  receipts: { id: string; ref: string; state: ReceiptState; receivedAt: number | null; units: number; rejected: number }[];
  invoices: { id: string; invoiceNo: string; status: string; issuedOn: string | null; totalMinor?: number }[];
  claims: { id: string; ref: string; kind: string; status: string }[];
  history: HistoryEntry[];
  /** [P] the spending limit, for the approval card. */
  limitIqd?: number;
  /**
   * [P] A draft only: what this employee approved within the limit for the same supplier in the last
   * SPLIT_WINDOW_DAYS — it counts with this order when they submit it — and the whole check (the order weighed at
   * the higher of its rate and the store's rate of the day).
   */
  limitUsedIqd?: number;
  limitCheck?: LimitCheck;
  /** [P] The store's rate of the day for the order's currency (null: none kept, or IQD). */
  storeRateMicros?: number | null;
  can: {
    edit: boolean;
    submit: boolean;
    decide: boolean;
    send: boolean;
    cancel: boolean;
    /** Nothing received, but a supplier invoice stands (an advance bill): it is voided before the order is cancelled. */
    cancelBlockedByInvoice: boolean;
    close: boolean;
    receive: boolean;
    invoice: boolean;
    claim: boolean;
    /** The employee created, edited or submitted the order: someone else decides. */
    ownRequest: boolean;
  };
};

export async function getPurchaseOrder(db: Db, actor: Actor, poId: string, locale: Locale, now: number): Promise<OrderDetail> {
  assertCan(actor, "purchasing.po.read");
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  const withCost = can(actor, "cost.read");
  const [supplier, location, lines, approvalRows, receiptRows, pendingRows, invoicedRows, invoiceRows, claimRows, rfqRow, history] = await Promise.all([
    db.select().from(suppliers).where(eq(suppliers.id, order.supplierId)).get(),
    order.locationId ? db.select({ id: inventoryLocations.id, code: inventoryLocations.code, name: inventoryLocations.name }).from(inventoryLocations).where(eq(inventoryLocations.id, order.locationId)).get() : Promise.resolve(undefined),
    db.select().from(poItems).where(eq(poItems.poId, order.id)).orderBy(asc(poItems.id)),
    db.select().from(approvals).where(and(eq(approvals.entityType, "purchase_order"), eq(approvals.entityId, order.id))).orderBy(desc(approvals.createdAt)),
    db.all<{ id: string; ref: string; status: string; receivedBy: string | null; receivedAt: number | null; units: number; rejected: number }>(sql`
      SELECT r.id AS id, r.ref AS ref, r.status AS status, r.received_by AS receivedBy, r.received_at AS receivedAt,
             coalesce((SELECT SUM(qty_received) FROM receipt_items WHERE receipt_id = r.id), 0) AS units, coalesce((SELECT SUM(qty_rejected) FROM receipt_items WHERE receipt_id = r.id), 0) AS rejected
      FROM receipts AS r WHERE r.po_id = ${order.id} ORDER BY r.created_at DESC`),
    db.all<{ poItemId: string; qty: number }>(sql`
      SELECT ri.po_item_id AS poItemId, SUM(ri.qty_accepted) AS qty FROM receipt_items AS ri JOIN receipts AS r ON r.id = ri.receipt_id
      WHERE r.po_id = ${order.id} AND (r.status = 'draft' OR (r.status = 'posted' AND r.received_by LIKE 'posting:%')) GROUP BY ri.po_item_id`),
    db.all<{ poItemId: string; qty: number }>(sql`
      SELECT ii.po_item_id AS poItemId, SUM(ii.qty) AS qty FROM supplier_invoice_items AS ii JOIN supplier_invoices AS i ON i.id = ii.invoice_id
      WHERE i.po_id = ${order.id} AND i.status <> 'void' GROUP BY ii.po_item_id`),
    db.all<{ id: string; invoiceNo: string; status: string; issuedOn: string | null; totalMinor: number }>(sql`SELECT id, invoice_no AS invoiceNo, status, issued_on AS issuedOn, total_minor AS totalMinor FROM supplier_invoices WHERE po_id = ${order.id} ORDER BY created_at DESC`),
    db.all<{ id: string; ref: string; kind: string; status: string }>(sql`SELECT id, ref, kind, status FROM supplier_claims WHERE po_id = ${order.id} ORDER BY created_at DESC`),
    order.rfqQuoteId
      ? db.select({ id: rfqs.id, ref: rfqs.ref }).from(rfqQuotes).innerJoin(rfqs, eq(rfqs.id, rfqQuotes.rfqId)).where(eq(rfqQuotes.id, order.rfqQuoteId)).get()
      : Promise.resolve(undefined),
    historyOf(db, "purchase_order", order.id, 30),
  ]);
  const [labels, names] = await Promise.all([
    variantsById(
      db,
      lines.map((line) => line.variantId),
      locale,
    ),
    employeeNames(db, [order.createdBy, order.approvedBy, ...approvalRows.flatMap((row) => [row.requestedBy, row.decidedBy])]),
  ]);
  const pending = new Map(pendingRows.map((row) => [row.poItemId, Number(row.qty)]));
  const invoiced = new Map(invoicedRows.map((row) => [row.poItemId, Number(row.qty)]));
  const lineViews: PoLineView[] = lines.map((line) => {
    const view: PoLineView = {
      id: line.id,
      variant: labels.get(line.variantId) ?? { id: line.variantId, sku: line.variantId, barcode: null, name: line.variantId, productName: line.variantId, variantTitle: "", trackSerials: false, isActive: false },
      qtyOrdered: line.qtyOrdered,
      qtyReceived: line.qtyReceived,
      qtyPending: pending.get(line.id) ?? 0,
      qtyInvoiced: invoiced.get(line.id) ?? 0,
      outstanding: Math.max(0, line.qtyOrdered - line.qtyReceived),
    };
    return withCost ? { ...view, unitCostMinor: line.unitCostMinor, lineTotalMinor: line.unitCostMinor * line.qtyOrdered } : view;
  });
  const me = actorId(actor);
  const waiting = approvalRows.find((row) => row.status === "pending" && row.id === order.approvalId);
  const mine = Boolean(waiting) && (waiting?.requestedBy === me || order.createdBy === me || (await shapedOrder(db, order.id, me)));
  // A draft: how the spending limit would see it if this employee submitted it now.
  const limitCheck = withCost && order.status === "draft" ? await limitCheckOf(db, { id: order.id, supplierId: order.supplierId, currency: order.currency, totalMinor: order.totalMinor, totalIqd: order.totalIqd }, me, now) : undefined;
  const storeRateMicros = withCost && order.currency !== "IQD" ? await defaultRateMicros(db, order.currency, baghdadDate(now)) : null;
  const open = (OPEN_PO_STATUSES as readonly string[]).includes(order.status);
  const units = {
    ordered: lineViews.reduce((sum, line) => sum + line.qtyOrdered, 0),
    received: lineViews.reduce((sum, line) => sum + line.qtyReceived, 0),
    pending: lineViews.reduce((sum, line) => sum + line.qtyPending, 0),
    outstanding: lineViews.reduce((sum, line) => sum + line.outstanding, 0),
  };
  const receipts = receiptRows.map((row) => ({ id: row.id, ref: row.ref, state: receiptStateOf(row), receivedAt: row.receivedAt, units: Number(row.units), rejected: Number(row.rejected) }));
  const liveReceipts = receipts.some((row) => row.state !== "cancelled");
  const liveInvoices = invoiceRows.some((row) => row.status !== "void");
  const openReceipts = receipts.some((row) => row.state === "draft" || row.state === "posting");
  const detail: OrderDetail = {
    order: {
      id: order.id,
      ref: order.ref,
      status: order.status,
      supplier: { id: order.supplierId, code: supplier?.code ?? "", name: supplier?.name ?? "", status: supplier?.status ?? "active", currency: supplier?.currency ?? order.currency },
      location: location ?? null,
      currency: order.currency,
      expectedAt: order.expectedAt,
      late: isLate(order, now),
      paymentTerms: order.paymentTerms,
      notes: order.notes,
      createdAt: order.createdAt,
      createdBy: order.createdBy ? (names.get(order.createdBy) ?? null) : null,
      updatedAt: order.updatedAt,
      approvedAt: order.approvedAt,
      approvedBy: order.approvedBy ? (names.get(order.approvedBy) ?? null) : null,
      sentAt: order.sentAt,
      cancelledAt: order.cancelledAt,
      cancelReason: order.cancelReason,
      isDemo: order.isDemo,
      rfq: rfqRow ?? null,
      ...(withCost ? { fxRateMicros: order.fxRateMicros, subtotalMinor: order.subtotalMinor, shippingMinor: order.shippingMinor, otherMinor: order.otherMinor, totalMinor: order.totalMinor, totalIqd: order.totalIqd } : {}),
    },
    lines: lineViews,
    units,
    approvals: approvalRows.map((row) => {
      const payload = (row.payload ?? {}) as { totalIqd?: number; limitIqd?: number; windowIqd?: number; storeRateIqd?: number };
      const view: ApprovalView = {
        id: row.id,
        status: row.status,
        requestedBy: names.get(row.requestedBy) ?? null,
        requestedById: row.requestedBy,
        requestedAt: row.createdAt,
        reason: row.reason,
        decidedBy: row.decidedBy ? (names.get(row.decidedBy) ?? null) : null,
        decidedAt: row.decidedAt,
        decisionNote: row.decisionNote,
      };
      return withCost ? { ...view, totalIqd: payload.totalIqd, limitIqd: payload.limitIqd, ...(payload.windowIqd ? { windowIqd: payload.windowIqd } : {}), ...(payload.storeRateIqd ? { storeRateIqd: payload.storeRateIqd } : {}) } : view;
    }),
    receipts,
    invoices: can(actor, "purchasing.invoice.manage") && withCost ? invoiceRows.map((row) => ({ id: row.id, invoiceNo: row.invoiceNo, status: row.status, issuedOn: row.issuedOn, totalMinor: row.totalMinor })) : [],
    claims: claimRows,
    history,
    ...(withCost ? { limitIqd: PO_SPENDING_LIMIT_IQD, storeRateMicros } : {}),
    ...(limitCheck ? { limitUsedIqd: limitCheck.windowIqd, limitCheck } : {}),
    can: {
      edit: order.status === "draft" && withCost && can(actor, "purchasing.po.create"),
      submit: order.status === "draft" && withCost && can(actor, "purchasing.po.create") && lines.length > 0,
      decide: order.status === "pending_approval" && Boolean(waiting) && withCost && can(actor, "purchasing.po.approve") && !mine,
      send: order.status === "approved" && can(actor, "purchasing.po.create"),
      cancel: ["draft", "pending_approval", "approved", "sent"].includes(order.status) && !liveReceipts && !liveInvoices && can(actor, "purchasing.po.create"),
      close: (order.status === "partially_received" || order.status === "received") && !openReceipts && can(actor, "purchasing.po.create"),
      receive: open && can(actor, "purchasing.receipt.create") && units.outstanding - units.pending > 0,
      invoice: ["approved", "sent", "partially_received", "received", "closed"].includes(order.status) && can(actor, "purchasing.invoice.manage") && withCost,
      claim: can(actor, "purchasing.claim.manage") && order.status !== "draft" && order.status !== "pending_approval",
      ownRequest: mine,
      cancelBlockedByInvoice: ["draft", "pending_approval", "approved", "sent"].includes(order.status) && !liveReceipts && liveInvoices && can(actor, "purchasing.po.create"),
    },
  };
  return detail;
}

/** The order as a printable document; prices only for cost.read (a goods list for everyone else). */
export async function purchaseOrderDocument(db: Db, actor: Actor, poId: string, locale: Locale, now: number) {
  const detail = await getPurchaseOrder(db, actor, poId, locale, now);
  const [supplier, contact] = await Promise.all([
    db.select().from(suppliers).where(eq(suppliers.id, detail.order.supplier.id)).get(),
    db.select().from(supplierContacts).where(and(eq(supplierContacts.supplierId, detail.order.supplier.id), eq(supplierContacts.isPrimary, true))).get(),
  ]);
  return {
    detail,
    supplier: supplier ? { name: supplier.name, legalName: supplier.legalName, code: supplier.code, country: supplier.country, phone: supplier.phone, email: supplier.email, address: supplier.address, paymentTerms: supplier.paymentTerms } : null,
    contact: contact ? { name: contact.name, phone: contact.phone, email: contact.email } : null,
  };
}

/** Orders that can receive goods (for pickers): open, in the employee's branch. */
export async function openOrderOptions(db: Db, actor: Actor): Promise<{ value: string; label: string }[]> {
  assertCan(actor, "purchasing.po.read");
  const rows = await db.all<{ id: string; ref: string; supplier: string }>(sql`
    SELECT po.id AS id, po.ref AS ref, s.name AS supplier FROM purchase_orders AS po JOIN suppliers AS s ON s.id = po.supplier_id
    WHERE po.status IN ('approved', 'sent', 'partially_received', 'received', 'closed') AND ${branchCondition(actor, sql`po.location_id`)}
    ORDER BY po.created_at DESC LIMIT 200`);
  return rows.map((row) => ({ value: row.id, label: `${row.ref} · ${row.supplier}` }));
}

/** Existence + status of a few orders (bulk forms). */
export async function orderStatuses(db: Db, poIds: readonly string[]): Promise<Map<string, PurchaseOrderStatus>> {
  if (poIds.length === 0) return new Map();
  const rows = await db.select({ id: purchaseOrders.id, status: purchaseOrders.status }).from(purchaseOrders).where(inArray(purchaseOrders.id, [...poIds]));
  return new Map(rows.map((row) => [row.id, row.status]));
}
