/**
 * Requests for quotation (admin 09.02): what the store wants to buy (SKUs and quantities), the quotes suppliers send
 * back (unit price per line, quantity they can supply, lead time and warranty — per quote or per line, valid until),
 * the comparison side by side, and the award: the winning quote becomes a draft purchase order (09.03).
 *
 *   const { rfqId } = await createRfq(db, actor, { title, neededBy, lines: [{ code: "SKU", qty: "10" }], idempotencyKey }, now);
 *   await recordQuote(db, actor, { rfqId, supplierId, currency: "USD", leadTimeDays: "14", warrantyMonths: "12",
 *                                  lines: [{ rfqItemId, unitCost: "455.00" }] }, now);
 *   const { poId } = await awardQuote(db, actor, { rfqId, quoteId, locationId, idempotencyKey }, now);
 *
 * Comparison: each quote's total for what it covers, in its currency and in IQD at the store's rate of the day (a
 * currency the store keeps no rate for shows no IQD figure — "no rate", never a guess); coverage (lines quoted / lines
 * asked, units available); the quote's lead time (else the slowest line) and warranty (else the shortest line). The
 * cheapest complete quote, the fastest and the longest warranty are marked. An expired quote (valid until passed) is
 * shown but cannot be awarded.
 *
 * Quote prices are supplier cost data [P]: recording, seeing and awarding them needs cost.read. Permissions:
 * purchasing.rfq.manage (+ purchasing.po.create to award). Error codes: forbidden (403), not_found (404), invalid (400),
 * rfq_closed, supplier_not_active, quote_expired, fx_rate_required (409).
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { rfqItems, rfqQuoteItems, rfqQuotes, rfqs, suppliers, RFQ_STATUSES, type RfqStatus } from "~/server/db/schema";
import { chunkRows, expectChanged, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { defaultRateMicros } from "../pricing/costs.server";
import { insertOrderStatements, type PlannedOrder } from "./orders.server";
import { RFQ_FILTERS, DAY_MS, MAX_DOC_IQD, MAX_LINES, MAX_QTY, baghdadDate, decimalsOf, endOfBaghdadDay, isCostCurrency, parseBaghdadDay, parseCount, parseDecimal, parseRateMicros, poTotals, poTotalsOrNull, toIqd } from "./rules";
import { PAGE_SIZE, actorId, assertAll, cleanQuery, employeeNames, historyOf, idField, idFromKey, keyField, likePattern, optionalText, pageOf, reasonField, resolveVariantCodes, usableLocation, variantsById, type HistoryEntry, type VariantLabel } from "./shared.server";

export const RFQ_ERROR_KEYS = ["rfq_closed", "quote_expired", "quote_not_received", "quote_empty"] as const;

const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const count = z.union([z.string(), z.number()]).optional();

/** A whole number field that may be empty: null when empty, a field error when not a number in range. */
function optionalCount(value: unknown, field: string, max: number, fields: Record<string, string>): number | null {
  const parsed = parseCount(value);
  if (parsed === undefined) return null;
  if (Number.isNaN(parsed) || parsed < 0) {
    fields[field] = "invalid";
    return null;
  }
  if (parsed > max) {
    fields[field] = "too_big";
    return null;
  }
  return parsed;
}

// ───────────────────────────────────────────────────────────────── create, send, cancel

export const RfqLineInput = z.object({ code: z.string().trim().max(120, "too_long").optional().default(""), qty: count });
export const CreateRfqInput = z.object({
  title: z.string({ error: "required" }).trim().min(3, "too_short").max(160, "too_long"),
  neededBy: z.string().trim().max(20).optional(),
  notes: optionalText(1000),
  lines: z.array(RfqLineInput).max(MAX_LINES, "too_many"),
  idempotencyKey: keyField,
});

export async function createRfq(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale = "ar"): Promise<{ rfqId: string; ref: string; replayed: boolean }> {
  assertCan(actor, "purchasing.rfq.manage");
  const input = CreateRfqInput.parse(raw);
  const rfqId = await idFromKey("rfq", actor, input.idempotencyKey);
  const existing = await db.select({ id: rfqs.id, ref: rfqs.ref }).from(rfqs).where(eq(rfqs.id, rfqId)).get();
  if (existing) return { rfqId, ref: existing.ref, replayed: true };
  const fields: Record<string, string> = {};
  let neededBy: number | null = null;
  if (!blank(input.neededBy)) {
    neededBy = parseBaghdadDay(input.neededBy);
    if (neededBy === null) fields.neededBy = "invalid";
    else if (endOfBaghdadDay(neededBy) <= now) fields.neededBy = "expected_past";
  }
  const typed = input.lines.map((line, index) => ({ ...line, index })).filter((line) => !(blank(line.code) && blank(line.qty)));
  if (typed.length === 0) fields.lines = "required";
  const { found } = await resolveVariantCodes(
    db,
    typed.map((line) => line.code),
    locale,
  );
  const items: { variantId: string; qty: number; sku: string }[] = [];
  for (const line of typed) {
    const at = `lines.${line.index}`;
    const variant = line.code ? found.get(line.code.trim()) : undefined;
    if (!line.code) fields[`${at}.code`] = "required";
    else if (!variant) fields[`${at}.code`] = "unknown_code";
    else if (variant.isBundle) fields[`${at}.code`] = "bundle_not_purchasable";
    else if (items.some((item) => item.variantId === variant.id)) fields[`${at}.code`] = "duplicate_line";
    const qty = parseCount(line.qty);
    if (qty === undefined) fields[`${at}.qty`] = "required";
    else if (Number.isNaN(qty) || qty < 1) fields[`${at}.qty`] = "invalid";
    else if (qty > MAX_QTY) fields[`${at}.qty`] = "too_big";
    if (variant && !variant.isBundle && !items.some((item) => item.variantId === variant.id) && qty !== undefined && !Number.isNaN(qty) && qty >= 1 && qty <= MAX_QTY) items.push({ variantId: variant.id, qty, sku: variant.sku });
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const ref = `RFQ-${rfqId.slice(4, 12).toUpperCase()}`;
  try {
    await runBatch(db, [
      db.insert(rfqs).values({ id: rfqId, ref, title: input.title, status: "draft", neededBy, notes: input.notes, createdBy: actorId(actor), createdAt: now }),
      ...chunkRows(
        rfqItems,
        items.map((item, index) => ({ id: `${rfqId}.${index + 1}`, rfqId, variantId: item.variantId, qty: item.qty })),
      ).map((rows) => db.insert(rfqItems).values(rows)),
      auditStatement(db, { actor, action: "purchasing.rfq.create", entityType: "rfq", entityId: rfqId, summary: `${ref} · ${input.title}`, after: { title: input.title, lines: items.map((item) => ({ sku: item.sku, qty: item.qty })) }, at: now }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "rfqs.id")) return { rfqId, ref, replayed: true };
    throw toAppError(error) ?? error;
  }
  return { rfqId, ref, replayed: false };
}

export const RfqIdInput = z.object({ rfqId: idField });

/** The request went out to suppliers (outside the system: email, WhatsApp, phone). */
export async function markRfqSent(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "purchasing.rfq.manage");
  const input = RfqIdInput.parse(raw);
  const rfq = await db.select().from(rfqs).where(eq(rfqs.id, input.rfqId)).get();
  if (!rfq) throw notFound("rfq");
  if (rfq.status !== "draft") return { replayed: true };
  await runBatch(db, [
    db
      .update(rfqs)
      .set({ status: "sent" })
      .where(and(eq(rfqs.id, rfq.id), eq(rfqs.status, "draft"))),
    auditStatement(db, { actor, action: "purchasing.rfq.send", entityType: "rfq", entityId: rfq.id, summary: rfq.ref, before: { status: "draft" }, after: { status: "sent" }, at: now }),
  ]);
  return { replayed: false };
}

export const CancelRfqInput = z.object({ rfqId: idField, reason: reasonField });

export async function cancelRfq(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "purchasing.rfq.manage");
  const input = CancelRfqInput.parse(raw);
  const rfq = await db.select().from(rfqs).where(eq(rfqs.id, input.rfqId)).get();
  if (!rfq) throw notFound("rfq");
  if (rfq.status === "cancelled") return { replayed: true };
  if (rfq.status === "awarded") throw new AppError("rfq_closed", 409);
  await runBatch(db, [
    db
      .update(rfqs)
      .set({ status: "cancelled", closedAt: now })
      .where(and(eq(rfqs.id, rfq.id), eq(rfqs.status, rfq.status))),
    expectChanged(db, 1, { code: "RFQ_CLOSED", detail: rfq.id }),
    auditStatement(db, { actor, action: "purchasing.rfq.cancel", entityType: "rfq", entityId: rfq.id, summary: rfq.ref, before: { status: rfq.status }, after: { status: "cancelled" }, reason: input.reason, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "RFQ_CLOSED")) throw new AppError("rfq_closed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── quotes

export const QuoteLineInput = z.object({ rfqItemId: idField, unitCost: count, qtyAvailable: count, leadTimeDays: count, warrantyMonths: count });
export const RecordQuoteInput = z.object({
  rfqId: idField,
  supplierId: idField,
  currency: z.string({ error: "required" }).trim().toUpperCase().refine(isCostCurrency, "invalid"),
  leadTimeDays: count,
  warrantyMonths: count,
  validUntil: z.string().trim().max(20).optional(),
  notes: optionalText(1000),
  lines: z.array(QuoteLineInput).max(MAX_LINES, "too_many"),
});

/** Records (or replaces) one supplier's quote for the request. Lines left without a price are "not quoted". */
export async function recordQuote(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ quoteId: string; replaced: boolean }> {
  assertAll(actor, ["purchasing.rfq.manage", "cost.read"]);
  const input = RecordQuoteInput.parse(raw);
  const rfq = await db.select().from(rfqs).where(eq(rfqs.id, input.rfqId)).get();
  if (!rfq) throw notFound("rfq");
  if (rfq.status === "awarded" || rfq.status === "cancelled") throw new AppError("rfq_closed", 409);
  const fields: Record<string, string> = {};
  const supplier = await db.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
  if (!supplier) fields.supplierId = "not_found";
  else if (supplier.status !== "active") fields.supplierId = "supplier_not_active";
  const decimals = decimalsOf(input.currency);
  const leadTimeDays = optionalCount(input.leadTimeDays, "leadTimeDays", 365, fields);
  const warrantyMonths = optionalCount(input.warrantyMonths, "warrantyMonths", 120, fields);
  let validUntil: number | null = null;
  if (!blank(input.validUntil)) {
    validUntil = parseBaghdadDay(input.validUntil);
    if (validUntil === null) fields.validUntil = "invalid";
  }
  const items = await db.select().from(rfqItems).where(eq(rfqItems.rfqId, rfq.id));
  const byId = new Map(items.map((item) => [item.id, item]));
  const lines: { rfqItemId: string; unitCostMinor: number; qtyAvailable: number | null; leadTimeDays: number | null; warrantyMonths: number | null; qty: number }[] = [];
  for (const line of input.lines) {
    const item = byId.get(line.rfqItemId);
    const at = `lines.${line.rfqItemId}`;
    if (!item) {
      fields[at] = "not_found";
      continue;
    }
    if (blank(line.unitCost)) continue;
    const unitCostMinor = parseDecimal(line.unitCost, decimals);
    if (unitCostMinor === null) {
      fields[`${at}.unitCost`] = "invalid";
      continue;
    }
    const qtyAvailable = optionalCount(line.qtyAvailable, `${at}.qtyAvailable`, MAX_QTY, fields);
    lines.push({ rfqItemId: item.id, unitCostMinor, qtyAvailable, leadTimeDays: optionalCount(line.leadTimeDays, `${at}.leadTimeDays`, 365, fields), warrantyMonths: optionalCount(line.warrantyMonths, `${at}.warrantyMonths`, 120, fields), qty: item.qty });
  }
  if (lines.length === 0 && Object.keys(fields).length === 0) fields.lines = "quote_empty";
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const covered = lines.map((line) => ({ qty: line.qtyAvailable === null ? line.qty : Math.min(line.qty, line.qtyAvailable), unitCostMinor: line.unitCostMinor }));
  const totals = poTotalsOrNull(covered, 0, 0);
  // A typo guard, as on orders: a quote whose total cannot be an exact integer is a field error, never a crash.
  if (!totals) throw invalid({ lines: "too_big" });
  const { subtotalMinor } = totals;
  const previous = await db.select().from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfq.id), eq(rfqQuotes.supplierId, supplier!.id))).get();
  if (previous && previous.status !== "received") throw new AppError("rfq_closed", 409);
  const quoteId = previous?.id ?? `${rfq.id}.q.${supplier!.id}`.slice(0, 120);
  const statements: BatchStatement[] = [];
  if (previous) {
    statements.push(
      db.delete(rfqQuoteItems).where(eq(rfqQuoteItems.quoteId, previous.id)),
      db
        .update(rfqQuotes)
        .set({ currency: input.currency, totalMinor: subtotalMinor, leadTimeDays, warrantyMonths, validUntil, notes: input.notes, receivedAt: now, createdBy: actorId(actor) })
        .where(and(eq(rfqQuotes.id, previous.id), eq(rfqQuotes.status, "received"))),
      expectChanged(db, 1, { code: "RFQ_CLOSED", detail: rfq.id }),
    );
  } else {
    statements.push(db.insert(rfqQuotes).values({ id: quoteId, rfqId: rfq.id, supplierId: supplier!.id, currency: input.currency, totalMinor: subtotalMinor, leadTimeDays, warrantyMonths, validUntil, notes: input.notes, status: "received", receivedAt: now, createdBy: actorId(actor) }));
  }
  statements.push(
    ...chunkRows(
      rfqQuoteItems,
      lines.map((line, index) => ({ id: `${quoteId}.${index + 1}`, quoteId, rfqItemId: line.rfqItemId, unitCostMinor: line.unitCostMinor, qtyAvailable: line.qtyAvailable, leadTimeDays: line.leadTimeDays, warrantyMonths: line.warrantyMonths })),
    ).map((rows) => db.insert(rfqQuoteItems).values(rows)),
    db
      .update(rfqs)
      .set({ status: "quoted" })
      .where(and(eq(rfqs.id, rfq.id), inArray(rfqs.status, ["draft", "sent", "quoted"]))),
    expectChanged(db, 1, { code: "RFQ_CLOSED", detail: rfq.id }),
    auditStatement(db, {
      actor,
      action: previous ? "purchasing.rfq.quote.replace" : "purchasing.rfq.quote.record",
      entityType: "rfq",
      entityId: rfq.id,
      summary: `${rfq.ref} · ${supplier!.code}`,
      after: { supplier: supplier!.code, currency: input.currency, lines: lines.length, leadTimeDays, warrantyMonths },
      at: now,
    }),
  );
  await runBatch(db, statements).catch((error) => {
    if (isDbError(error, "RFQ_CLOSED")) throw new AppError("rfq_closed", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { quoteId, replaced: Boolean(previous) };
}

export const AwardInput = z.object({ rfqId: idField, quoteId: idField, locationId: idField, fxRate: count, expectedOn: z.string().trim().max(20).optional(), idempotencyKey: keyField });

/** Awards one quote: the request closes, the other quotes are declined and a DRAFT purchase order is created from it. */
export async function awardQuote(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ poId: string; replayed: boolean }> {
  assertAll(actor, ["purchasing.rfq.manage", "purchasing.po.create", "cost.read"]);
  const input = AwardInput.parse(raw);
  const poId = await idFromKey("po", actor, input.idempotencyKey);
  const already = await db.all<{ id: string }>(sql`SELECT id FROM purchase_orders WHERE id = ${poId}`);
  if (already[0]) return { poId, replayed: true };
  const rfq = await db.select().from(rfqs).where(eq(rfqs.id, input.rfqId)).get();
  if (!rfq) throw notFound("rfq");
  if (rfq.status === "awarded" || rfq.status === "cancelled") throw new AppError("rfq_closed", 409);
  const quote = await db.select().from(rfqQuotes).where(and(eq(rfqQuotes.id, input.quoteId), eq(rfqQuotes.rfqId, rfq.id))).get();
  if (!quote) throw notFound("rfq_quote");
  if (quote.status !== "received") throw new AppError("quote_not_received", 409);
  if (quote.validUntil !== null && now >= endOfBaghdadDay(quote.validUntil)) throw new AppError("quote_expired", 409);
  const supplier = await db.select().from(suppliers).where(eq(suppliers.id, quote.supplierId)).get();
  if (!supplier || supplier.status !== "active") throw new AppError("supplier_not_active", 409);
  const location = await usableLocation(db, actor, input.locationId);
  const fields: Record<string, string> = {};
  let fxRateMicros = 1_000_000;
  if (quote.currency !== "IQD") {
    const typed = blank(input.fxRate) ? null : parseRateMicros(input.fxRate);
    if (!blank(input.fxRate) && (typed === null || typed <= 0)) fields.fxRate = "invalid";
    const rate = typed ?? (await defaultRateMicros(db, quote.currency, baghdadDate(now)));
    if (rate === null || rate <= 0) fields.fxRate = fields.fxRate ?? "fx_rate_required";
    else fxRateMicros = rate;
  }
  let expectedAt: number | null = quote.leadTimeDays !== null ? Math.floor((now + quote.leadTimeDays * DAY_MS + 3 * 3_600_000) / DAY_MS) * DAY_MS - 3 * 3_600_000 : null;
  if (!blank(input.expectedOn)) {
    expectedAt = parseBaghdadDay(input.expectedOn);
    if (expectedAt === null) fields.expectedOn = "invalid";
    else if (endOfBaghdadDay(expectedAt) <= now) fields.expectedOn = "expected_past";
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const [items, quoted] = await Promise.all([db.select().from(rfqItems).where(eq(rfqItems.rfqId, rfq.id)), db.select().from(rfqQuoteItems).where(eq(rfqQuoteItems.quoteId, quote.id))]);
  const labels = await variantsById(
    db,
    items.map((item) => item.variantId),
    "ar",
  );
  const lines = quoted
    .map((line) => {
      const item = items.find((candidate) => candidate.id === line.rfqItemId);
      if (!item) return null;
      const qty = line.qtyAvailable === null ? item.qty : Math.min(item.qty, line.qtyAvailable);
      return qty > 0 ? { variantId: item.variantId, qty, unitCostMinor: line.unitCostMinor, sku: labels.get(item.variantId)?.sku ?? item.variantId } : null;
    })
    .filter((line): line is NonNullable<typeof line> => line !== null);
  if (lines.length === 0) throw new AppError("quote_empty", 409);
  const totals = poTotalsOrNull(lines, 0, 0);
  if (!totals) throw invalid({ lines: "too_big" });
  const { subtotalMinor, totalMinor } = totals;
  const totalIqd = toIqd(totalMinor, quote.currency, fxRateMicros);
  if (totalIqd === null || totalIqd > MAX_DOC_IQD) throw invalid({ lines: "too_big" });
  const plan: PlannedOrder = { supplier: { id: supplier.id, code: supplier.code, name: supplier.name }, location: { id: location.id, code: location.code }, currency: quote.currency, fxRateMicros, expectedAt, shippingMinor: 0, otherMinor: 0, lines, subtotalMinor, totalMinor, totalIqd };
  const ref = `PO-${poId.slice(3, 11).toUpperCase()}`;
  try {
    await runBatch(db, [
      db
        .update(rfqs)
        .set({ status: "awarded", awardedQuoteId: quote.id, closedAt: now })
        .where(and(eq(rfqs.id, rfq.id), inArray(rfqs.status, ["draft", "sent", "quoted"]))),
      expectChanged(db, 1, { code: "RFQ_CLOSED", detail: rfq.id }),
      db
        .update(rfqQuotes)
        .set({ status: "accepted" })
        .where(and(eq(rfqQuotes.id, quote.id), eq(rfqQuotes.status, "received"))),
      expectChanged(db, 1, { code: "RFQ_CLOSED", detail: quote.id }),
      db
        .update(rfqQuotes)
        .set({ status: "rejected" })
        .where(and(eq(rfqQuotes.rfqId, rfq.id), ne(rfqQuotes.id, quote.id), eq(rfqQuotes.status, "received"))),
      ...insertOrderStatements(db, actor, { poId, ref, plan, paymentTerms: supplier.paymentTerms, notes: `${rfq.ref} · ${rfq.title}`.slice(0, 1000), rfqQuoteId: quote.id, now }),
      auditStatement(db, { actor, action: "purchasing.rfq.award", entityType: "rfq", entityId: rfq.id, summary: `${rfq.ref} → ${supplier.code}`, after: { quoteId: quote.id, supplier: supplier.code, poId, poRef: ref }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "RFQ_CLOSED")) throw new AppError("rfq_closed", 409, { cause: error });
    if (isUniqueViolation(error, "purchase_orders.id")) return { poId, replayed: true };
    throw toAppError(error) ?? error;
  }
  return { poId, replayed: false };
}

// ───────────────────────────────────────────────────────────────── reading

export { RFQ_FILTERS };
export type RfqFilter = (typeof RFQ_FILTERS)[number];
export type RfqFilters = { status: RfqFilter; q: string; page: number };

export function parseRfqFilters(params: URLSearchParams): RfqFilters {
  const status = params.get("status");
  return { status: (RFQ_FILTERS as readonly string[]).includes(status ?? "") ? (status as RfqFilter) : "open", q: cleanQuery(params.get("q")), page: pageOf(params.get("page")) };
}

export type RfqRow = { id: string; ref: string; title: string; status: RfqStatus; neededBy: number | null; lines: number; quotes: number; createdAt: number; createdBy: string | null; awardedTo: string | null };

export async function listRfqs(db: Db, actor: Actor, filters: RfqFilters): Promise<{ rows: RfqRow[]; total: number; page: number; pageCount: number; counts: Record<RfqFilter, number> }> {
  assertCan(actor, "purchasing.rfq.manage");
  const base = [sql`1 = 1`];
  if (filters.q) {
    const like = likePattern(filters.q);
    base.push(sql`(q.ref LIKE ${like} ESCAPE '\\' OR q.title LIKE ${like} ESCAPE '\\')`);
  }
  const statusCondition = (status: RfqFilter) => (status === "all" ? sql`1 = 1` : status === "open" ? sql`q.status IN ('draft', 'sent', 'quoted')` : sql`q.status = ${status}`);
  const countRows = await Promise.all(
    RFQ_FILTERS.map(async (status) => {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM rfqs AS q WHERE ${sql.join([...base, statusCondition(status)], sql` AND `)}`);
      return [status, Number(rows[0]?.n ?? 0)] as const;
    }),
  );
  const counts = Object.fromEntries(countRows) as Record<RfqFilter, number>;
  const total = counts[filters.status];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<{ id: string; ref: string; title: string; status: RfqStatus; neededBy: number | null; lines: number; quotes: number; createdAt: number; createdBy: string | null; awardedTo: string | null }>(sql`
    SELECT q.id AS id, q.ref AS ref, q.title AS title, q.status AS status, q.needed_by AS neededBy, q.created_at AS createdAt, q.created_by AS createdBy,
           (SELECT count(*) FROM rfq_items WHERE rfq_id = q.id) AS lines, (SELECT count(*) FROM rfq_quotes WHERE rfq_id = q.id) AS quotes,
           (SELECT s.name FROM rfq_quotes AS rq JOIN suppliers AS s ON s.id = rq.supplier_id WHERE rq.id = q.awarded_quote_id) AS awardedTo
    FROM rfqs AS q WHERE ${sql.join([...base, statusCondition(filters.status)], sql` AND `)}
    ORDER BY q.created_at DESC, q.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`);
  const names = await employeeNames(
    db,
    rows.map((row) => row.createdBy),
  );
  return { rows: rows.map((row) => ({ ...row, lines: Number(row.lines), quotes: Number(row.quotes), createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null })), total, page, pageCount, counts };
}

export type QuoteLineView = { rfqItemId: string; unitCostMinor?: number; qtyAvailable: number | null; leadTimeDays: number | null; warrantyMonths: number | null };
export type QuoteView = {
  id: string;
  supplier: { id: string; code: string; name: string; status: string };
  currency: string;
  status: "received" | "accepted" | "rejected" | "expired";
  validUntil: number | null;
  expired: boolean;
  leadTimeDays: number | null;
  warrantyMonths: number | null;
  notes: string | null;
  receivedAt: number;
  lines: QuoteLineView[];
  /** Lines quoted ÷ lines asked; units the supplier can supply ÷ units asked. */
  coverage: { lines: number; units: number; complete: boolean };
  /** The quote's lead time, else its slowest line; warranty: the quote's, else its shortest line. */
  lead: number | null;
  warranty: number | null;
  /** [P] */
  totalMinor?: number;
  totalIqd?: number | null;
  best?: { price: boolean; lead: boolean; warranty: boolean };
};

export type RfqDetail = {
  rfq: { id: string; ref: string; title: string; status: RfqStatus; neededBy: number | null; notes: string | null; createdAt: number; createdBy: string | null; closedAt: number | null; awardedQuoteId: string | null; poId: string | null };
  items: { id: string; variant: VariantLabel; qty: number }[];
  quotes: QuoteView[];
  history: HistoryEntry[];
  can: { quote: boolean; award: boolean; send: boolean; cancel: boolean };
};

export async function getRfq(db: Db, actor: Actor, rfqId: string, locale: Locale, now: number): Promise<RfqDetail> {
  assertCan(actor, "purchasing.rfq.manage");
  const rfq = await db.select().from(rfqs).where(eq(rfqs.id, rfqId)).get();
  if (!rfq) throw notFound("rfq");
  const withCost = can(actor, "cost.read");
  const [items, quotes, history, poRows] = await Promise.all([
    db.select().from(rfqItems).where(eq(rfqItems.rfqId, rfq.id)).orderBy(asc(rfqItems.id)),
    db.select().from(rfqQuotes).where(eq(rfqQuotes.rfqId, rfq.id)).orderBy(asc(rfqQuotes.receivedAt)),
    historyOf(db, "rfq", rfq.id, 20),
    rfq.awardedQuoteId ? db.all<{ id: string }>(sql`SELECT id FROM purchase_orders WHERE rfq_quote_id = ${rfq.awardedQuoteId} ORDER BY created_at LIMIT 1`) : Promise.resolve([]),
  ]);
  const [quoteLines, supplierRows, labels, names] = await Promise.all([
    quotes.length ? db.select().from(rfqQuoteItems).where(inArray(rfqQuoteItems.quoteId, quotes.map((quote) => quote.id))) : Promise.resolve([]),
    quotes.length ? db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name, status: suppliers.status }).from(suppliers).where(inArray(suppliers.id, quotes.map((quote) => quote.supplierId))) : Promise.resolve([]),
    variantsById(
      db,
      items.map((item) => item.variantId),
      locale,
    ),
    employeeNames(db, [rfq.createdBy]),
  ]);
  const rates = new Map<string, number | null>();
  for (const currency of new Set(quotes.map((quote) => quote.currency))) rates.set(currency, await defaultRateMicros(db, currency, baghdadDate(now)));
  const unitsAsked = items.reduce((sum, item) => sum + item.qty, 0);
  const views: QuoteView[] = quotes.map((quote) => {
    const lines = quoteLines.filter((line) => line.quoteId === quote.id);
    const covered = lines.map((line) => {
      const item = items.find((candidate) => candidate.id === line.rfqItemId);
      return { qty: item ? (line.qtyAvailable === null ? item.qty : Math.min(item.qty, line.qtyAvailable)) : 0, unitCostMinor: line.unitCostMinor };
    });
    const units = covered.reduce((sum, line) => sum + line.qty, 0);
    const lineLeads = lines.map((line) => line.leadTimeDays).filter((value): value is number => value !== null);
    const lineWarranty = lines.map((line) => line.warrantyMonths).filter((value): value is number => value !== null);
    const supplier = supplierRows.find((row) => row.id === quote.supplierId) ?? { id: quote.supplierId, code: "", name: "", status: "active" };
    const view: QuoteView = {
      id: quote.id,
      supplier,
      currency: quote.currency,
      status: quote.status,
      validUntil: quote.validUntil,
      expired: quote.validUntil !== null && now >= endOfBaghdadDay(quote.validUntil),
      leadTimeDays: quote.leadTimeDays,
      warrantyMonths: quote.warrantyMonths,
      notes: quote.notes,
      receivedAt: quote.receivedAt,
      lines: lines.map((line) => ({ rfqItemId: line.rfqItemId, ...(withCost ? { unitCostMinor: line.unitCostMinor } : {}), qtyAvailable: line.qtyAvailable, leadTimeDays: line.leadTimeDays, warrantyMonths: line.warrantyMonths })),
      coverage: { lines: lines.length / Math.max(1, items.length), units: units / Math.max(1, unitsAsked), complete: lines.length === items.length && units === unitsAsked },
      lead: quote.leadTimeDays ?? (lineLeads.length ? Math.max(...lineLeads) : null),
      warranty: quote.warrantyMonths ?? (lineWarranty.length ? Math.min(...lineWarranty) : null),
    };
    if (withCost) {
      const totalMinor = poTotals(covered, 0, 0).totalMinor;
      view.totalMinor = totalMinor;
      view.totalIqd = toIqd(totalMinor, quote.currency, rates.get(quote.currency) ?? null);
    }
    return view;
  });
  const live = views.filter((view) => !view.expired && view.status !== "rejected");
  const complete = live.filter((view) => view.coverage.complete && view.totalIqd !== null && view.totalIqd !== undefined);
  const cheapest = withCost && complete.length > 0 ? Math.min(...complete.map((view) => view.totalIqd as number)) : null;
  const fastest = live.map((view) => view.lead).filter((value): value is number => value !== null);
  const longest = live.map((view) => view.warranty).filter((value): value is number => value !== null);
  for (const view of views) {
    if (!live.includes(view)) continue;
    view.best = {
      price: cheapest !== null && view.coverage.complete && view.totalIqd === cheapest,
      lead: fastest.length > 1 && view.lead === Math.min(...fastest),
      warranty: longest.length > 1 && view.warranty === Math.max(...longest),
    };
  }
  const open = rfq.status === "draft" || rfq.status === "sent" || rfq.status === "quoted";
  return {
    rfq: { id: rfq.id, ref: rfq.ref, title: rfq.title, status: rfq.status, neededBy: rfq.neededBy, notes: rfq.notes, createdAt: rfq.createdAt, createdBy: rfq.createdBy ? (names.get(rfq.createdBy) ?? null) : null, closedAt: rfq.closedAt, awardedQuoteId: rfq.awardedQuoteId, poId: poRows[0]?.id ?? null },
    items: items.map((item) => ({ id: item.id, variant: labels.get(item.variantId)!, qty: item.qty })),
    quotes: views,
    history,
    can: {
      quote: open && withCost,
      award: open && withCost && can(actor, "purchasing.po.create") && views.some((view) => view.status === "received" && !view.expired),
      send: rfq.status === "draft",
      cancel: open,
    },
  };
}


