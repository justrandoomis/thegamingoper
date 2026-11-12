/**
 * Supplier invoices and the three-way match (admin 09.04, 09.07): an invoice is recorded against its purchase order,
 * line by line, and compared with what was ordered and what was received (accepted into stock):
 *
 *   quantity   units billed (this invoice + the order's other live invoices) > units received   → a variance
 *   price      the invoice's unit cost ≠ the order's (same currency, no tolerance)                → a variance
 *   charges    shipping + other billed (this invoice + the order's other live invoices) > the order's shipping +
 *              other → a variance (field "charges"); an invoice of charges alone (freight billed apart) is allowed
 *
 * Status: `matched` (no variance) or `mismatch` (variances listed in `discrepancies`), recomputed whenever receipts of
 * the order are posted and when the invoice is approved. Approving a matched invoice is one step; approving one with
 * variances accepts them — it needs a reason AND a second person (not the one who recorded it). `void` takes it out
 * of the match. Paying the supplier and the journal entries for price or exchange differences belong to finance (10):
 * this module stops at an approved invoice.
 *
 * Everything here is supplier cost data [P]: every function needs purchasing.invoice.manage AND cost.read.
 * Error codes: forbidden (403), approver_is_requester (403), not_found (404), invalid (400; invoice_no_taken,
 * variance_reason_required), po_not_open, invoice_not_open, invoice_changed (409).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Locale } from "~/lib/locales";
import { type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { poItems, purchaseOrders, supplierInvoiceItems, supplierInvoices, suppliers, SUPPLIER_INVOICE_STATUSES, type InvoiceDiscrepancy, type SupplierInvoiceStatus } from "~/server/db/schema";
import { chunkRows, expectChanged, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import {
  INVOICE_FILTERS,
  MAX_DOC_IQD,
  MAX_LINES,
  MAX_QTY,
  decimalsOf,
  normalizeDigits,
  parseBaghdadDay,
  parseCount,
  parseDecimal,
  parseRateMicros,
  poTotalsOrNull,
  threeWayMatch,
  toIqd,
  type MatchDiscrepancy,
  type MatchInvoiceLine,
  type MatchPoLine,
} from "./rules";
import { PAGE_SIZE, actorId, assertAll, assertRecordBranch, branchCondition, cleanQuery, employeeNames, historyOf, idField, idFromKey, keyField, likePattern, optionalText, pageOf, reasonField, variantsById, type HistoryEntry, type VariantLabel } from "./shared.server";

const PERMISSIONS = ["purchasing.invoice.manage", "cost.read"] as const;

/** The JSON column is typed with the schema's two fields; the match also stores "charges" (rules.ts MatchDiscrepancy). */
const stored = (value: readonly MatchDiscrepancy[]) => value as unknown as InvoiceDiscrepancy[];
const discrepanciesOf = (value: InvoiceDiscrepancy[] | null): MatchDiscrepancy[] => (value ?? []) as unknown as MatchDiscrepancy[];

// ───────────────────────────────────────────────────────────────── matching

/** The order's lines as the match sees them (received = accepted into stock), plus `added` units about to be posted. */
async function matchFacts(db: Db, poId: string, excludeInvoiceId: string | null, added: ReadonlyMap<string, number> = new Map()) {
  const others = excludeInvoiceId ? sql`AND i.id <> ${excludeInvoiceId}` : sql``;
  const [lines, billed, order, charges] = await Promise.all([
    db.select().from(poItems).where(eq(poItems.poId, poId)),
    db.all<{ poItemId: string; qty: number }>(sql`
      SELECT ii.po_item_id AS poItemId, SUM(ii.qty) AS qty FROM supplier_invoice_items AS ii JOIN supplier_invoices AS i ON i.id = ii.invoice_id
      WHERE i.po_id = ${poId} AND i.status <> 'void' ${others} AND ii.po_item_id IS NOT NULL
      GROUP BY ii.po_item_id`),
    db.select({ shippingMinor: purchaseOrders.shippingMinor, otherMinor: purchaseOrders.otherMinor }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get(),
    db.all<{ n: number | null }>(sql`SELECT coalesce(SUM(i.shipping_minor + i.other_minor), 0) AS n FROM supplier_invoices AS i WHERE i.po_id = ${poId} AND i.status <> 'void' ${others}`),
  ]);
  const poLines: MatchPoLine[] = lines.map((line) => ({ poItemId: line.id, variantId: line.variantId, qtyOrdered: line.qtyOrdered, qtyReceived: line.qtyReceived + (added.get(line.id) ?? 0), unitCostMinor: line.unitCostMinor }));
  return {
    poLines,
    elsewhere: new Map(billed.map((row) => [row.poItemId, Number(row.qty)])),
    /** Shipping + other the order agreed, and what the order's other live invoices bill of them. */
    orderedChargesMinor: (order?.shippingMinor ?? 0) + (order?.otherMinor ?? 0),
    chargesElsewhereMinor: Number(charges[0]?.n ?? 0),
  };
}

type MatchFacts = Awaited<ReturnType<typeof matchFacts>>;

/** The match of one invoice (its lines and its charges) against the facts read for it. */
function matchOf(facts: MatchFacts, lines: readonly MatchInvoiceLine[], invoiceChargesMinor: number): MatchDiscrepancy[] {
  return threeWayMatch(facts.poLines, lines, facts.elsewhere, { orderedMinor: facts.orderedChargesMinor, billedElsewhereMinor: facts.chargesElsewhereMinor, billedMinor: invoiceChargesMinor });
}

async function invoiceLines(db: Db, invoiceId: string): Promise<MatchInvoiceLine[]> {
  const rows = await db.select().from(supplierInvoiceItems).where(eq(supplierInvoiceItems.invoiceId, invoiceId)).orderBy(asc(supplierInvoiceItems.id));
  return rows.map((row) => ({ poItemId: row.poItemId, variantId: row.variantId, qty: row.qty, unitCostMinor: row.unitCostMinor }));
}

/**
 * Statements that re-run the match of the order's open invoices (matched / mismatch), counting `added` units as
 * received — for the receipt-posting batch, so an invoice that arrived before the goods turns "matched" with them.
 */
export async function rematchStatements(db: Db, poId: string, added: ReadonlyMap<string, number>): Promise<BatchStatement[]> {
  const open = await db
    .select({ id: supplierInvoices.id, status: supplierInvoices.status, shippingMinor: supplierInvoices.shippingMinor, otherMinor: supplierInvoices.otherMinor })
    .from(supplierInvoices)
    .where(and(eq(supplierInvoices.poId, poId), inArray(supplierInvoices.status, ["matched", "mismatch"])));
  const statements: BatchStatement[] = [];
  for (const invoice of open) {
    const facts = await matchFacts(db, poId, invoice.id, added);
    const discrepancies = matchOf(facts, await invoiceLines(db, invoice.id), invoice.shippingMinor + invoice.otherMinor);
    const status: SupplierInvoiceStatus = discrepancies.length > 0 ? "mismatch" : "matched";
    statements.push(
      db
        .update(supplierInvoices)
        .set({ status, discrepancies: stored(discrepancies) })
        .where(and(eq(supplierInvoices.id, invoice.id), inArray(supplierInvoices.status, ["matched", "mismatch"]))),
    );
  }
  return statements;
}

// ───────────────────────────────────────────────────────────────── record

const amount = z.union([z.string(), z.number()]).optional();
export const InvoiceLineInput = z.object({ poItemId: idField, qty: amount, unitCost: amount });
export const RecordInvoiceInput = z.object({
  poId: idField,
  invoiceNo: z
    .string({ error: "required" })
    .trim()
    .transform((value) => normalizeDigits(value))
    .pipe(z.string().min(1, "required").max(60, "too_long")),
  issuedOn: z.string().trim().max(20).optional(),
  dueOn: z.string().trim().max(20).optional(),
  fxRate: amount,
  shipping: amount,
  other: amount,
  lines: z.array(InvoiceLineInput).max(MAX_LINES, "too_many"),
  idempotencyKey: keyField,
});

const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/** Records a supplier invoice against an approved (or later) order and matches it at once. */
export async function recordInvoice(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ invoiceId: string; status: SupplierInvoiceStatus; discrepancies: number; replayed: boolean }> {
  assertAll(actor, PERMISSIONS);
  const input = RecordInvoiceInput.parse(raw);
  const invoiceId = await idFromKey("sinv", actor, input.idempotencyKey);
  const existing = await db.select({ id: supplierInvoices.id, status: supplierInvoices.status, discrepancies: supplierInvoices.discrepancies }).from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).get();
  if (existing) return { invoiceId, status: existing.status, discrepancies: existing.discrepancies?.length ?? 0, replayed: true };
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  if (!["approved", "sent", "partially_received", "received", "closed"].includes(order.status)) throw new AppError("po_not_open", 409);
  const fields: Record<string, string> = {};
  const decimals = decimalsOf(order.currency);
  const taken = await db.select({ id: supplierInvoices.id }).from(supplierInvoices).where(and(eq(supplierInvoices.supplierId, order.supplierId), eq(supplierInvoices.invoiceNo, input.invoiceNo))).get();
  if (taken) fields.invoiceNo = "invoice_no_taken";
  const issuedAt = blank(input.issuedOn) ? null : parseBaghdadDay(input.issuedOn);
  if (!blank(input.issuedOn) && issuedAt === null) fields.issuedOn = "invalid";
  else if (issuedAt !== null && issuedAt > now) fields.issuedOn = "in_future";
  const dueAt = blank(input.dueOn) ? null : parseBaghdadDay(input.dueOn);
  if (!blank(input.dueOn) && dueAt === null) fields.dueOn = "invalid";
  else if (dueAt !== null && issuedAt !== null && dueAt < issuedAt) fields.dueOn = "before_issue";
  let fxRateMicros = order.fxRateMicros ?? (order.currency === "IQD" ? 1_000_000 : null);
  if (order.currency !== "IQD" && !blank(input.fxRate)) {
    const parsed = parseRateMicros(input.fxRate);
    if (parsed === null || parsed <= 0) fields.fxRate = "invalid";
    else fxRateMicros = parsed;
  }
  if (fxRateMicros === null) fields.fxRate = "fx_rate_required";
  const money = (value: unknown, field: string) => {
    if (blank(value)) return 0;
    const parsed = parseDecimal(value, decimals);
    if (parsed === null) fields[field] = "invalid";
    return parsed ?? 0;
  };
  const shippingMinor = money(input.shipping, "shipping");
  const otherMinor = money(input.other, "other");
  const orderLines = await db.select().from(poItems).where(eq(poItems.poId, order.id));
  const byId = new Map(orderLines.map((line) => [line.id, line]));
  const lines: { poItemId: string; variantId: string; qty: number; unitCostMinor: number }[] = [];
  const seen = new Set<string>();
  for (const line of input.lines) {
    const at = `lines.${line.poItemId}`;
    const item = byId.get(line.poItemId);
    if (!item) {
      fields[at] = "not_found";
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const qty = parseCount(line.qty);
    if (qty === undefined || qty === 0) continue;
    if (Number.isNaN(qty) || qty < 0) {
      fields[`${at}.qty`] = "invalid";
      continue;
    }
    if (qty > MAX_QTY) {
      fields[`${at}.qty`] = "too_big";
      continue;
    }
    const cost = blank(line.unitCost) ? null : parseDecimal(line.unitCost, decimals);
    if (cost === null) {
      fields[`${at}.unitCost`] = blank(line.unitCost) ? "required" : "invalid";
      continue;
    }
    lines.push({ poItemId: item.id, variantId: item.variantId, qty, unitCostMinor: cost });
  }
  // An invoice of charges alone (freight billed apart) is an invoice; one with nothing on it is not.
  if (lines.length === 0 && shippingMinor + otherMinor === 0 && Object.keys(fields).length === 0) fields.lines = "invoice_empty";
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const totals = poTotalsOrNull(lines, shippingMinor, otherMinor);
  if (!totals) throw invalid({ lines: "too_big" });
  const { subtotalMinor, totalMinor } = totals;
  const totalIqd = toIqd(totalMinor, order.currency, fxRateMicros);
  if (totalIqd === null || !Number.isSafeInteger(totalIqd) || totalIqd > MAX_DOC_IQD) throw invalid({ lines: "too_big" });
  const discrepancies = matchOf(await matchFacts(db, order.id, null), lines, shippingMinor + otherMinor);
  const status: SupplierInvoiceStatus = discrepancies.length > 0 ? "mismatch" : "matched";
  try {
    await runBatch(db, [
      db.insert(supplierInvoices).values({
        id: invoiceId,
        supplierId: order.supplierId,
        poId: order.id,
        invoiceNo: input.invoiceNo,
        currency: order.currency,
        subtotalMinor,
        shippingMinor,
        otherMinor,
        totalMinor,
        fxRateMicros,
        totalIqd,
        issuedOn: issuedAt === null ? null : input.issuedOn!.trim(),
        dueOn: dueAt === null ? null : input.dueOn!.trim(),
        status,
        discrepancies: stored(discrepancies),
        createdBy: actorId(actor),
        createdAt: now,
      }),
      ...chunkRows(
        supplierInvoiceItems,
        lines.map((line, index) => ({ id: `${invoiceId}.${index + 1}`, invoiceId, poItemId: line.poItemId, receiptItemId: null, variantId: line.variantId, qty: line.qty, unitCostMinor: line.unitCostMinor })),
      ).map((rows) => db.insert(supplierInvoiceItems).values(rows)),
      auditStatement(db, {
        actor,
        action: "purchasing.invoice.record",
        entityType: "supplier_invoice",
        entityId: invoiceId,
        summary: `${input.invoiceNo} · ${order.ref}`,
        after: { invoiceNo: input.invoiceNo, poRef: order.ref, lines: lines.length, units: lines.reduce((sum, line) => sum + line.qty, 0), status, variances: discrepancies.length },
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "supplier_invoices.id")) return { invoiceId, status, discrepancies: discrepancies.length, replayed: true };
    if (isUniqueViolation(error)) throw invalid({ invoiceNo: "invoice_no_taken" });
    throw toAppError(error) ?? error;
  }
  return { invoiceId, status, discrepancies: discrepancies.length, replayed: false };
}

// ───────────────────────────────────────────────────────────────── decide

export const ApproveInvoiceInput = z.object({ invoiceId: idField, reason: z.string().trim().max(500, "too_long").optional() });

/**
 * Approves an invoice. The match is re-run first: with variances the approval accepts them, which needs a reason and
 * someone other than the person who recorded the invoice (four eyes on accepting a difference).
 */
export async function approveInvoice(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean; variances: number }> {
  assertAll(actor, PERMISSIONS);
  const input = ApproveInvoiceInput.parse(raw);
  const invoice = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, input.invoiceId)).get();
  if (!invoice) throw notFound("supplier_invoice");
  const order = await invoiceOrder(db, actor, invoice.poId);
  if (invoice.status === "approved") return { replayed: true, variances: invoice.discrepancies?.length ?? 0 };
  if (invoice.status !== "matched" && invoice.status !== "mismatch") throw new AppError("invoice_not_open", 409);
  const discrepancies = invoice.poId ? await currentDiscrepancies(db, invoice) : discrepanciesOf(invoice.discrepancies);
  if (discrepancies.length > 0) {
    if ((input.reason ?? "").length < 3) throw invalid({ reason: "variance_reason_required" });
    if (invoice.createdBy === actorId(actor)) throw new AppError("approver_is_requester", 403);
  }
  await runBatch(db, [
    db
      .update(supplierInvoices)
      .set({ status: "approved", discrepancies: stored(discrepancies) })
      .where(and(eq(supplierInvoices.id, invoice.id), eq(supplierInvoices.status, invoice.status))),
    expectChanged(db, 1, { code: "INVOICE_CHANGED", detail: invoice.id }),
    auditStatement(db, {
      actor,
      action: "purchasing.invoice.approve",
      entityType: "supplier_invoice",
      entityId: invoice.id,
      summary: `${invoice.invoiceNo}${order ? ` · ${order.ref}` : ""}`,
      before: { status: invoice.status },
      after: { status: "approved", variances: discrepancies.map((item) => ({ variantId: item.variantId, field: item.field, po: item.po, received: item.received, invoiced: item.invoiced })) },
      reason: input.reason || null,
      at: now,
    }),
  ]).catch((error) => {
    if (isDbError(error, "INVOICE_CHANGED")) throw new AppError("invoice_changed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { replayed: false, variances: discrepancies.length };
}

/** The match of a stored invoice now: its lines and charges against its order, receipts and other live invoices. */
async function currentDiscrepancies(db: Db, invoice: { id: string; poId: string | null; shippingMinor: number; otherMinor: number }): Promise<MatchDiscrepancy[]> {
  if (!invoice.poId) return [];
  return matchOf(await matchFacts(db, invoice.poId, invoice.id), await invoiceLines(db, invoice.id), invoice.shippingMinor + invoice.otherMinor);
}

/** The invoice's order (ref, location) after the branch check: an employee limited to a branch acts on its invoices only. */
async function invoiceOrder(db: Db, actor: Actor, poId: string | null) {
  const order = poId ? await db.select({ id: purchaseOrders.id, ref: purchaseOrders.ref, locationId: purchaseOrders.locationId }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get() : undefined;
  await assertRecordBranch(db, actor, order?.locationId ?? null);
  return order;
}

export const RematchInput = z.object({ invoiceId: idField });

/** Runs the match again (e.g. after goods arrived) and stores the result. */
export async function rematchInvoice(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: SupplierInvoiceStatus; variances: number }> {
  assertAll(actor, PERMISSIONS);
  const input = RematchInput.parse(raw);
  const invoice = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, input.invoiceId)).get();
  if (!invoice) throw notFound("supplier_invoice");
  await invoiceOrder(db, actor, invoice.poId);
  if (invoice.status !== "matched" && invoice.status !== "mismatch") throw new AppError("invoice_not_open", 409);
  if (!invoice.poId) return { status: invoice.status, variances: invoice.discrepancies?.length ?? 0 };
  const discrepancies = await currentDiscrepancies(db, invoice);
  const status: SupplierInvoiceStatus = discrepancies.length > 0 ? "mismatch" : "matched";
  await runBatch(db, [
    db
      .update(supplierInvoices)
      .set({ status, discrepancies: stored(discrepancies) })
      .where(and(eq(supplierInvoices.id, invoice.id), inArray(supplierInvoices.status, ["matched", "mismatch"]))),
    auditStatement(db, { actor, action: "purchasing.invoice.rematch", entityType: "supplier_invoice", entityId: invoice.id, summary: invoice.invoiceNo, before: { status: invoice.status }, after: { status, variances: discrepancies.length }, at: now }),
  ]);
  return { status, variances: discrepancies.length };
}

export const VoidInvoiceInput = z.object({ invoiceId: idField, reason: reasonField });

/** Takes an invoice out of the match (entered twice, wrong order, replaced by a credit note). */
export async function voidInvoice(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertAll(actor, PERMISSIONS);
  const input = VoidInvoiceInput.parse(raw);
  const invoice = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, input.invoiceId)).get();
  if (!invoice) throw notFound("supplier_invoice");
  await invoiceOrder(db, actor, invoice.poId);
  if (invoice.status === "void") return { replayed: true };
  if (invoice.status === "paid") throw new AppError("invoice_not_open", 409);
  await runBatch(db, [
    db
      .update(supplierInvoices)
      .set({ status: "void" })
      .where(and(eq(supplierInvoices.id, invoice.id), eq(supplierInvoices.status, invoice.status))),
    expectChanged(db, 1, { code: "INVOICE_CHANGED", detail: invoice.id }),
    auditStatement(db, { actor, action: "purchasing.invoice.void", entityType: "supplier_invoice", entityId: invoice.id, summary: invoice.invoiceNo, before: { status: invoice.status }, after: { status: "void" }, reason: input.reason, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "INVOICE_CHANGED")) throw new AppError("invoice_changed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── reading

export { INVOICE_FILTERS };
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];
export type InvoiceFilters = { status: InvoiceFilter; q: string; page: number };

export function parseInvoiceFilters(params: URLSearchParams): InvoiceFilters {
  const status = params.get("status");
  return { status: (INVOICE_FILTERS as readonly string[]).includes(status ?? "") ? (status as InvoiceFilter) : "open", q: cleanQuery(params.get("q")), page: pageOf(params.get("page")) };
}

export type InvoiceRow = { id: string; invoiceNo: string; status: SupplierInvoiceStatus; supplier: { id: string; code: string; name: string }; po: { id: string; ref: string } | null; issuedOn: string | null; dueOn: string | null; currency: string; totalMinor: number; totalIqd: number | null; variances: number; createdAt: number };

export async function listInvoices(db: Db, actor: Actor, filters: InvoiceFilters): Promise<{ rows: InvoiceRow[]; total: number; page: number; pageCount: number; counts: Record<InvoiceFilter, number> }> {
  assertAll(actor, PERMISSIONS);
  const base = [branchCondition(actor, sql`po.location_id`)];
  if (filters.q) {
    const like = likePattern(filters.q);
    base.push(sql`(i.invoice_no LIKE ${like} ESCAPE '\\' OR s.name LIKE ${like} ESCAPE '\\' OR s.code LIKE ${like} ESCAPE '\\' OR coalesce(po.ref, '') LIKE ${like} ESCAPE '\\')`);
  }
  // "to_accept": the mismatches this employee may accept — never one they recorded (approveInvoice: approver_is_requester);
  // what the bell and the purchasing home count (purchasingQueueCounts.mismatch), so the card opens exactly its rows
  const me = actorId(actor) ?? "";
  const statusCondition = (status: InvoiceFilter) =>
    status === "all" ? sql`1 = 1` : status === "open" ? sql`i.status IN ('matched', 'mismatch')` : status === "to_accept" ? sql`i.status = 'mismatch' AND coalesce(i.created_by, '') <> ${me}` : sql`i.status = ${status}`;
  const from = sql`supplier_invoices AS i JOIN suppliers AS s ON s.id = i.supplier_id LEFT JOIN purchase_orders AS po ON po.id = i.po_id`;
  const countRows = await Promise.all(
    INVOICE_FILTERS.map(async (status) => {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM ${from} WHERE ${sql.join([...base, statusCondition(status)], sql` AND `)}`);
      return [status, Number(rows[0]?.n ?? 0)] as const;
    }),
  );
  const counts = Object.fromEntries(countRows) as Record<InvoiceFilter, number>;
  const total = counts[filters.status];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<{ id: string; invoiceNo: string; status: SupplierInvoiceStatus; supplierId: string; supplierCode: string; supplierName: string; poId: string | null; poRef: string | null; issuedOn: string | null; dueOn: string | null; currency: string; totalMinor: number; totalIqd: number | null; discrepancies: string | null; createdAt: number }>(sql`
    SELECT i.id AS id, i.invoice_no AS invoiceNo, i.status AS status, s.id AS supplierId, s.code AS supplierCode, s.name AS supplierName, po.id AS poId, po.ref AS poRef,
           i.issued_on AS issuedOn, i.due_on AS dueOn, i.currency AS currency, i.total_minor AS totalMinor, i.total_iqd AS totalIqd, i.discrepancies AS discrepancies, i.created_at AS createdAt
    FROM ${from} WHERE ${sql.join([...base, statusCondition(filters.status)], sql` AND `)}
    ORDER BY i.created_at DESC, i.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`);
  return {
    rows: rows.map((row) => {
      let variances = 0;
      try {
        variances = row.discrepancies ? (JSON.parse(row.discrepancies) as unknown[]).length : 0;
      } catch {
        variances = 0;
      }
      return {
        id: row.id,
        invoiceNo: row.invoiceNo,
        status: row.status,
        supplier: { id: row.supplierId, code: row.supplierCode, name: row.supplierName },
        po: row.poId && row.poRef ? { id: row.poId, ref: row.poRef } : null,
        issuedOn: row.issuedOn,
        dueOn: row.dueOn,
        currency: row.currency,
        totalMinor: row.totalMinor,
        totalIqd: row.totalIqd,
        variances,
        createdAt: row.createdAt,
      };
    }),
    total,
    page,
    pageCount,
    counts,
  };
}

export type MatchLineView = {
  poItemId: string | null;
  variant: VariantLabel;
  qtyOrdered: number | null;
  qtyReceived: number | null;
  invoicedElsewhere: number;
  qtyInvoiced: number;
  poUnitCostMinor: number | null;
  invoiceUnitCostMinor: number;
  qtyVariance: boolean;
  priceVariance: boolean;
};

export type InvoiceDetail = {
  invoice: {
    id: string;
    invoiceNo: string;
    status: SupplierInvoiceStatus;
    supplier: { id: string; code: string; name: string };
    po: { id: string; ref: string; status: string; currency: string; totalMinor: number; totalIqd: number | null; shippingMinor: number; otherMinor: number } | null;
    currency: string;
    fxRateMicros: number | null;
    subtotalMinor: number;
    shippingMinor: number;
    otherMinor: number;
    totalMinor: number;
    totalIqd: number | null;
    issuedOn: string | null;
    dueOn: string | null;
    createdAt: number;
    createdBy: string | null;
    createdById: string | null;
  };
  lines: MatchLineView[];
  /** Fresh from the database (what an approval would accept now); `stored` is what was saved last. */
  discrepancies: MatchDiscrepancy[];
  stored: MatchDiscrepancy[];
  /** Shipping + other: what the order agreed and what its other live invoices bill (the charges match). */
  charges: { orderedMinor: number; billedElsewhereMinor: number } | null;
  history: HistoryEntry[];
  can: { approve: boolean; approveNeedsSecondPerson: boolean; rematch: boolean; void: boolean };
};

export async function getInvoice(db: Db, actor: Actor, invoiceId: string, locale: Locale): Promise<InvoiceDetail> {
  assertAll(actor, PERMISSIONS);
  const invoice = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).get();
  if (!invoice) throw notFound("supplier_invoice");
  const [supplier, order] = await Promise.all([
    db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, invoice.supplierId)).get(),
    invoice.poId ? db.select().from(purchaseOrders).where(eq(purchaseOrders.id, invoice.poId)).get() : Promise.resolve(undefined),
  ]);
  await assertRecordBranch(db, actor, order?.locationId ?? null);
  const items = await invoiceLines(db, invoice.id);
  const facts = order ? await matchFacts(db, order.id, invoice.id) : { poLines: [] as MatchPoLine[], elsewhere: new Map<string, number>(), orderedChargesMinor: 0, chargesElsewhereMinor: 0 };
  const fresh = order ? matchOf(facts, items, invoice.shippingMinor + invoice.otherMinor) : discrepanciesOf(invoice.discrepancies);
  const [labels, names, history] = await Promise.all([
    variantsById(db, [...items.map((item) => item.variantId), ...facts.poLines.map((line) => line.variantId)], locale),
    employeeNames(db, [invoice.createdBy]),
    historyOf(db, "supplier_invoice", invoice.id, 20),
  ]);
  const byPoItem = new Map(facts.poLines.map((line) => [line.poItemId, line]));
  const unknownLabel = (id: string): VariantLabel => ({ id, sku: id, barcode: null, name: id, productName: id, variantTitle: "", trackSerials: false, isActive: false });
  const lines: MatchLineView[] = items.map((item) => {
    const po = item.poItemId ? byPoItem.get(item.poItemId) : undefined;
    const elsewhere = item.poItemId ? (facts.elsewhere.get(item.poItemId) ?? 0) : 0;
    return {
      poItemId: item.poItemId,
      variant: labels.get(item.variantId) ?? unknownLabel(item.variantId),
      qtyOrdered: po?.qtyOrdered ?? null,
      qtyReceived: po?.qtyReceived ?? null,
      invoicedElsewhere: elsewhere,
      qtyInvoiced: item.qty,
      poUnitCostMinor: po?.unitCostMinor ?? null,
      invoiceUnitCostMinor: item.unitCostMinor,
      qtyVariance: !po || elsewhere + item.qty > po.qtyReceived,
      priceVariance: Boolean(po) && po!.unitCostMinor !== item.unitCostMinor,
    };
  });
  const open = invoice.status === "matched" || invoice.status === "mismatch";
  return {
    invoice: {
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      status: invoice.status,
      supplier: supplier ?? { id: invoice.supplierId, code: "", name: "" },
      po: order ? { id: order.id, ref: order.ref, status: order.status, currency: order.currency, totalMinor: order.totalMinor, totalIqd: order.totalIqd, shippingMinor: order.shippingMinor, otherMinor: order.otherMinor } : null,
      currency: invoice.currency,
      fxRateMicros: invoice.fxRateMicros,
      subtotalMinor: invoice.subtotalMinor,
      shippingMinor: invoice.shippingMinor,
      otherMinor: invoice.otherMinor,
      totalMinor: invoice.totalMinor,
      totalIqd: invoice.totalIqd,
      issuedOn: invoice.issuedOn,
      dueOn: invoice.dueOn,
      createdAt: invoice.createdAt,
      createdBy: invoice.createdBy ? (names.get(invoice.createdBy) ?? null) : null,
      createdById: invoice.createdBy,
    },
    lines,
    discrepancies: fresh,
    stored: discrepanciesOf(invoice.discrepancies),
    charges: order ? { orderedMinor: facts.orderedChargesMinor, billedElsewhereMinor: facts.chargesElsewhereMinor } : null,
    history,
    can: { approve: open, approveNeedsSecondPerson: open && fresh.length > 0 && invoice.createdBy === actorId(actor), rematch: open, void: invoice.status !== "void" && invoice.status !== "paid" },
  };
}

/** The order's lines for the invoice form: ordered, received, already billed, the order's unit cost [P]. */
export async function invoiceFormFor(db: Db, actor: Actor, poId: string, locale: Locale) {
  assertAll(actor, PERMISSIONS);
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  const supplier = await db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, order.supplierId)).get();
  const { poLines, elsewhere } = await matchFacts(db, order.id, null);
  const labels = await variantsById(
    db,
    poLines.map((line) => line.variantId),
    locale,
  );
  return {
    order: { id: order.id, ref: order.ref, status: order.status, currency: order.currency, fxRateMicros: order.fxRateMicros, shippingMinor: order.shippingMinor, otherMinor: order.otherMinor, totalMinor: order.totalMinor },
    supplier: supplier ?? { id: order.supplierId, code: "", name: "" },
    open: ["approved", "sent", "partially_received", "received", "closed"].includes(order.status),
    lines: poLines.map((line) => ({ ...line, variant: labels.get(line.variantId)!, invoiced: elsewhere.get(line.poItemId) ?? 0, suggestedQty: Math.max(0, line.qtyReceived - (elsewhere.get(line.poItemId) ?? 0)) })),
  };
}

export { SUPPLIER_INVOICE_STATUSES };
