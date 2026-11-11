/**
 * Goods received against a purchase order (admin 09.04): partial receipts with inspection, posted into stock through
 * the commerce core and into the books through the core's posting.
 *
 *   const { receiptId } = await createReceipt(db, clerk, { poId, supplierDocNo, lines: [{ poItemId, received: "10",
 *                                                          rejected: "1", rejectReason: "علبة مكسورة", serials }], idempotencyKey }, now);
 *   // landed costs (09.05) are added and spread on the DRAFT through pricing's addLandedCost / allocateLandedCost
 *   await postReceipt(db, clerk, { receiptId }, now);
 *
 * A DRAFT receipt holds what was counted: received, refused at inspection (with the reason) and accepted units per order
 * line, the serial numbers scanned for tracked SKUs, and the unit cost at the order's rate [P] — the server works it
 * out from the order (a clerk without cost.read never sees it). qty_accepted is set on the draft so landed costs
 * spread over the units that go into stock. Lines are not edited: a wrong draft is cancelled and counted again.
 *
 * POSTING (one call, three steps, crash-safe):
 *   1. claim   — one batch: draft → posted with `received_by = "posting:<token>"` and `posted_at = now` (the lease),
 *                guarded on the order being open, no unallocated landed-cost bill, the draft still a draft. From here
 *                pricing refuses landed-cost changes (`receipt_posted`), so the lines are read again after it: a bill
 *                spread just before the claim reaches the layers.
 *   2. stock   — per accepted line, receiveStock(…, { ref: { type: "receipt_item", id: line }, unitCostIqd: landed unit
 *                cost, else unit cost, serials }) — the core writes on_hand, the FIFO layer, serials, the 'receive'
 *                movement with its reason (receipt · order · supplier · delivery note) and its audit event. A line whose
 *                'receive' movement exists is never received again; the lease is checked before each line.
 *   3. finish  — one batch: the lease marker is swapped for the poster (exactly once — the guard), po_items.qty_received
 *                += accepted, the order turns partially received / received, the order's open invoices are matched
 *                again, the journal entry postStockReceipt(Dr inventory, Cr accounts payable — the value of the
 *                'receive' movements, i.e. the FIFO layers, demo flag from the order; key "receipt:<id>:receipt") and
 *                the audit event.
 *   A posting that stopped half way stays "posting": after POSTING_LEASE_MS anyone allowed may resume it (the lease is
 *   taken over with a compare-and-set on the marker and its time); finished lines are skipped. If step 2 fails before
 *   any line moved, the receipt goes back to draft so it can be corrected.
 *
 * Receiving more than is still outstanding on the order line is refused at the draft (over_receipt) — checked again
 * inside the draft's write batch against the order line and the other open receipts, so two drafts made at once cannot
 * over-receive either.
 * Permissions: purchasing.receipt.create (draft, post, cancel); reads purchasing.po.read or receipt.create.
 * Error codes: forbidden (403), not_found (404), invalid (400; over_receipt, serials_*), po_not_open, location_invalid,
 * cost_unknown, nothing_to_receive, receipt_not_draft, receipt_has_bills, landed_unallocated, posting_in_progress,
 * receipt_cancelled, serial_duplicate, period_closed, insufficient_stock (409).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { randomToken } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import { fiscalPeriodOf } from "~/server/db/journal.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { poItems, purchaseOrders, receiptItems, receipts, suppliers } from "~/server/db/schema";
import { chunkRows, expectChanged, expectThat, isDbError, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound, toAppError } from "~/server/errors";
import { mapPostingError, postStockReceipt, postedBy } from "~/server/services/accounting/post.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { getReceiptLanded, type LandedBillView } from "../pricing/landed.server";
import { rematchStatements } from "./invoices.server";
import { RECEIPT_FILTERS, MAX_LINES, MAX_QTY, OPEN_PO_STATUSES, POSTING_LEASE_MS, POSTING_PREFIX, baghdadDate, normalizeDigits, parseBaghdadDay, parseCount, receiptStateOf, toIqd, type ReceiptState } from "./rules";
import { PAGE_SIZE, actorId, assertRecordBranch, branchCondition, cleanQuery, employeeNames, historyOf, idField, idFromKey, keyField, likePattern, optionalText, pageOf, reasonField, usableLocation, variantsById, type HistoryEntry, type VariantLabel } from "./shared.server";

export const RECEIPT_ERROR_KEYS = ["over_receipt", "nothing_to_receive", "receipt_not_draft", "receipt_has_bills", "landed_unallocated", "posting_in_progress", "receipt_cancelled", "cost_unknown", "reject_reason_required", "rejected_exceeds"] as const;

function assertReceiptReader(actor: Actor): void {
  if (!canAny(actor, ["purchasing.po.read", "purchasing.receipt.create"])) throw forbidden("purchasing.po.read");
}

// ───────────────────────────────────────────────────────────────── the receiving form

export type ReceiveFormLine = { poItemId: string; variant: VariantLabel; qtyOrdered: number; qtyReceived: number; qtyPending: number; available: number };

/** What can still be received on an order, per line (ordered − received − in receipts not posted yet). No costs. */
export async function receiveFormFor(db: Db, actor: Actor, poId: string, locale: Locale) {
  assertCan(actor, "purchasing.receipt.create");
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  const [supplier, location, lines, pending] = await Promise.all([
    db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, order.supplierId)).get(),
    order.locationId ? db.all<{ id: string; code: string; name: string }>(sql`SELECT id, code, name FROM inventory_locations WHERE id = ${order.locationId}`) : Promise.resolve([]),
    db.select().from(poItems).where(eq(poItems.poId, order.id)).orderBy(asc(poItems.id)),
    pendingByItem(db, order.id),
  ]);
  const labels = await variantsById(
    db,
    lines.map((line) => line.variantId),
    locale,
  );
  return {
    order: { id: order.id, ref: order.ref, status: order.status, expectedAt: order.expectedAt },
    open: (OPEN_PO_STATUSES as readonly string[]).includes(order.status),
    supplier: supplier ?? { id: order.supplierId, code: "", name: "" },
    location: location[0] ?? null,
    lines: lines.map((line): ReceiveFormLine => {
      const pendingQty = pending.get(line.id) ?? 0;
      return { poItemId: line.id, variant: labels.get(line.variantId)!, qtyOrdered: line.qtyOrdered, qtyReceived: line.qtyReceived, qtyPending: pendingQty, available: Math.max(0, line.qtyOrdered - line.qtyReceived - pendingQty) };
    }),
  };
}

/** Accepted units of each order line in receipts that are not posted yet (draft, or posting). */
async function pendingByItem(db: Db, poId: string, exceptReceiptId?: string): Promise<Map<string, number>> {
  const rows = await db.all<{ poItemId: string; qty: number }>(sql`
    SELECT ri.po_item_id AS poItemId, SUM(ri.qty_accepted) AS qty FROM receipt_items AS ri JOIN receipts AS r ON r.id = ri.receipt_id
    WHERE r.po_id = ${poId} AND (r.status = 'draft' OR (r.status = 'posted' AND r.received_by LIKE 'posting:%'))
      ${exceptReceiptId ? sql`AND r.id <> ${exceptReceiptId}` : sql``}
    GROUP BY ri.po_item_id`);
  return new Map(rows.map((row) => [row.poItemId, Number(row.qty)]));
}

// ───────────────────────────────────────────────────────────────── create a draft

const count = z.union([z.string(), z.number()]).optional();
export const ReceiptLineInput = z.object({
  poItemId: idField,
  received: count,
  rejected: count,
  rejectReason: optionalText(300),
  serials: z.array(z.string().trim().max(100, "too_long")).max(MAX_QTY).optional(),
});
export const CreateReceiptInput = z.object({
  poId: idField,
  supplierDocNo: optionalText(80),
  receivedOn: z.string().trim().max(20).optional(),
  notes: optionalText(500),
  lines: z.array(ReceiptLineInput).max(MAX_LINES, "too_many"),
  idempotencyKey: keyField,
});

/** Serial numbers already registered (any letter case) or scanned on another open receipt. */
async function takenSerials(db: Db, serialsUpper: readonly string[], exceptReceiptId: string | null): Promise<string[]> {
  if (serialsUpper.length === 0) return [];
  const list = JSON.stringify([...new Set(serialsUpper)]);
  const [registered, scanned] = await Promise.all([
    db.all<{ serial: string }>(sql`SELECT upper(serial) AS serial FROM serials WHERE upper(serial) IN (SELECT value FROM json_each(${list}))`),
    db.all<{ serial: string }>(sql`
      SELECT upper(j.value) AS serial FROM receipt_items AS ri JOIN receipts AS r ON r.id = ri.receipt_id, json_each(ri.serials_scanned) AS j
      WHERE ri.serials_scanned IS NOT NULL AND (r.status = 'draft' OR (r.status = 'posted' AND r.received_by LIKE 'posting:%'))
        ${exceptReceiptId ? sql`AND r.id <> ${exceptReceiptId}` : sql``}
        AND upper(j.value) IN (SELECT value FROM json_each(${list}))`),
  ]);
  return [...new Set([...registered, ...scanned].map((row) => row.serial))];
}

/** Records what arrived as a draft receipt (see the header). The form's key decides the id: a double submit is one receipt. */
export async function createReceipt(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ receiptId: string; ref: string; replayed: boolean }> {
  assertCan(actor, "purchasing.receipt.create");
  const input = CreateReceiptInput.parse(raw);
  const receiptId = await idFromKey("rcp", actor, input.idempotencyKey);
  const existing = await db.select({ id: receipts.id, ref: receipts.ref }).from(receipts).where(eq(receipts.id, receiptId)).get();
  if (existing) return { receiptId: existing.id, ref: existing.ref, replayed: true };
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)).get();
  if (!order) throw notFound("purchase_order");
  await assertRecordBranch(db, actor, order.locationId);
  if (!(OPEN_PO_STATUSES as readonly string[]).includes(order.status)) throw new AppError("po_not_open", 409);
  const location = await usableLocation(db, actor, order.locationId);
  const fields: Record<string, string> = {};
  let receivedAt = now;
  if (input.receivedOn && input.receivedOn.trim() !== "" && input.receivedOn.trim() !== baghdadDate(now)) {
    const day = parseBaghdadDay(input.receivedOn);
    if (day === null) fields.receivedOn = "invalid";
    else if (day > now) fields.receivedOn = "in_future";
    else if (day + 86_400_000 < order.createdAt) fields.receivedOn = "before_order";
    else receivedAt = day + 12 * 3_600_000;
  }
  const [orderLines, pending] = await Promise.all([db.select().from(poItems).where(eq(poItems.poId, order.id)), pendingByItem(db, order.id)]);
  const byId = new Map(orderLines.map((line) => [line.id, line]));
  const labels = await variantsById(
    db,
    orderLines.map((line) => line.variantId),
    "ar",
  );
  type Planned = { poItemId: string; variantId: string; received: number; rejected: number; accepted: number; rejectReason: string | null; serials: string[] | null; unitCostMinor: number; unitCostIqd: number };
  const planned: Planned[] = [];
  const allSerials: string[] = [];
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
    const received = parseCount(line.received) ?? 0;
    const rejected = parseCount(line.rejected) ?? 0;
    if (Number.isNaN(received) || received < 0 || received > MAX_QTY) {
      fields[`${at}.received`] = "invalid";
      continue;
    }
    if (Number.isNaN(rejected) || rejected < 0) {
      fields[`${at}.rejected`] = "invalid";
      continue;
    }
    if (received === 0) {
      if (rejected > 0) fields[`${at}.rejected`] = "rejected_exceeds";
      continue;
    }
    if (rejected > received) {
      fields[`${at}.rejected`] = "rejected_exceeds";
      continue;
    }
    if (rejected > 0 && (line.rejectReason ?? "").length < 3) fields[`${at}.rejectReason`] = "reject_reason_required";
    const accepted = received - rejected;
    const available = Math.max(0, item.qtyOrdered - item.qtyReceived - (pending.get(item.id) ?? 0));
    if (accepted > available) fields[`${at}.received`] = "over_receipt";
    const tracked = labels.get(item.variantId)?.trackSerials ?? false;
    const serials = (line.serials ?? []).map((value) => normalizeDigits(value).trim()).filter(Boolean);
    if (tracked && accepted > 0) {
      if (serials.length === 0) fields[`${at}.serials`] = "serials_required";
      else if (serials.length !== accepted) fields[`${at}.serials`] = "serials_count";
      else if (new Set(serials.map((value) => value.toUpperCase())).size !== serials.length) fields[`${at}.serials`] = "serials_duplicate";
    } else if (!tracked && serials.length > 0) fields[`${at}.serials`] = "serials_not_tracked";
    const unitCostIqd = toIqd(item.unitCostMinor, order.currency, order.fxRateMicros);
    if (unitCostIqd === null) throw new AppError("cost_unknown", 409);
    allSerials.push(...(tracked ? serials : []));
    planned.push({ poItemId: item.id, variantId: item.variantId, received, rejected, accepted, rejectReason: rejected > 0 ? line.rejectReason : null, serials: tracked && accepted > 0 ? serials : null, unitCostMinor: item.unitCostMinor, unitCostIqd });
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  if (planned.length === 0) throw new AppError("nothing_to_receive", 409, { fields: { lines: "nothing_to_receive" } });
  if (new Set(allSerials.map((value) => value.toUpperCase())).size !== allSerials.length) throw invalid({ serials: "serials_duplicate" });
  const taken = await takenSerials(
    db,
    allSerials.map((value) => value.toUpperCase()),
    null,
  );
  if (taken.length > 0) throw new AppError("serial_duplicate", 409, { detail: taken.slice(0, 10).join(", "), fields: { serials: "serial_duplicate" } });

  const ref = `REC-${receiptId.slice(4, 12).toUpperCase()}`;
  const rows = planned.map((line, index) => ({
    id: `${receiptId}.${index + 1}`,
    receiptId,
    poItemId: line.poItemId,
    variantId: line.variantId,
    qtyReceived: line.received,
    qtyAccepted: line.accepted,
    qtyRejected: line.rejected,
    rejectReason: line.rejectReason,
    unitCostMinor: line.unitCostMinor,
    unitCostIqd: line.unitCostIqd,
    landedUnitCostIqd: null,
    serialsScanned: line.serials,
  }));
  try {
    await runBatch(db, [
      expectThat(db, sql`(SELECT status FROM purchase_orders WHERE id = ${order.id}) IN ('approved', 'sent', 'partially_received')`, { code: "PO_NOT_OPEN", detail: order.id }),
      // Another draft written since the form was checked (two clerks at once) must not take the same units again.
      ...planned
        .filter((line) => line.accepted > 0)
        .map((line) =>
          expectThat(
            db,
            sql`(SELECT qty_ordered - qty_received FROM po_items WHERE id = ${line.poItemId})
                - coalesce((SELECT SUM(ri.qty_accepted) FROM receipt_items AS ri JOIN receipts AS r ON r.id = ri.receipt_id
                            WHERE ri.po_item_id = ${line.poItemId} AND (r.status = 'draft' OR (r.status = 'posted' AND r.received_by LIKE 'posting:%'))), 0) >= ${line.accepted}`,
            { code: "OVER_RECEIPT", detail: line.poItemId },
          ),
        ),
      db.insert(receipts).values({ id: receiptId, ref, poId: order.id, supplierId: order.supplierId, locationId: location.id, status: "draft", supplierDocNo: input.supplierDocNo, notes: input.notes, receivedBy: actorId(actor), receivedAt, postedAt: null, createdAt: now }),
      ...chunkRows(receiptItems, rows).map((part) => db.insert(receiptItems).values(part)),
      auditStatement(db, {
        actor,
        action: "purchasing.receipt.create",
        entityType: "receipt",
        entityId: receiptId,
        summary: `${ref} · ${order.ref}`,
        // The arrival day counts in the supplier's on-time rating: a day typed in the past is kept with the receipt.
        after: { poRef: order.ref, location: location.code, supplierDocNo: input.supplierDocNo, receivedAt, backdated: receivedAt !== now, lines: planned.map((line) => ({ poItemId: line.poItemId, received: line.received, rejected: line.rejected, accepted: line.accepted, rejectReason: line.rejectReason, serials: line.serials?.length ?? 0 })) },
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "receipts.id")) return { receiptId, ref, replayed: true };
    if (isDbError(error, "PO_NOT_OPEN")) throw new AppError("po_not_open", 409, { cause: error });
    if (isDbError(error, "OVER_RECEIPT")) throw invalid({ [`lines.${mapDbError(error)?.detail ?? ""}.received`]: "over_receipt" });
    throw toAppError(error) ?? error;
  }
  return { receiptId, ref, replayed: false };
}

export const CancelReceiptInput = z.object({ receiptId: idField, reason: reasonField });

/** Cancels a draft (nothing has moved). A draft with landed-cost bills keeps them until they are removed in pricing. */
export async function cancelReceipt(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "purchasing.receipt.create");
  const input = CancelReceiptInput.parse(raw);
  const receipt = await db.select().from(receipts).where(eq(receipts.id, input.receiptId)).get();
  if (!receipt) throw notFound("receipt");
  await assertRecordBranch(db, actor, receipt.locationId);
  if (receipt.status === "cancelled") return { replayed: true };
  if (receipt.status !== "draft") throw new AppError("receipt_not_draft", 409);
  await runBatch(db, [
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM landed_costs WHERE receipt_id = ${receipt.id})`, { code: "RECEIPT_HAS_BILLS", detail: receipt.id }),
    db
      .update(receipts)
      .set({ status: "cancelled" })
      .where(and(eq(receipts.id, receipt.id), eq(receipts.status, "draft"))),
    expectChanged(db, 1, { code: "RECEIPT_CHANGED", detail: receipt.id }),
    auditStatement(db, { actor, action: "purchasing.receipt.cancel", entityType: "receipt", entityId: receipt.id, summary: receipt.ref, before: { status: "draft" }, after: { status: "cancelled" }, reason: input.reason, at: now }),
  ]).catch((error) => {
    if (isDbError(error, "RECEIPT_HAS_BILLS")) throw new AppError("receipt_has_bills", 409, { cause: error });
    if (isDbError(error, "RECEIPT_CHANGED")) throw new AppError("receipt_not_draft", 409, { cause: error });
    throw toAppError(error) ?? error;
  });
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── post

export const PostReceiptInput = z.object({ receiptId: idField });

/** A 'receive' movement exists for each of these receipt lines (the core wrote it with the line as reference). */
async function movedLines(db: Db, lineIds: readonly string[]): Promise<Map<string, { qty: number; value: number | null }>> {
  if (lineIds.length === 0) return new Map();
  const rows = await db.all<{ refId: string; qty: number; value: number | null; uncosted: number }>(sql`
    SELECT ref_id AS refId, SUM(qty_delta) AS qty, SUM(qty_delta * unit_cost_iqd) AS value, SUM(CASE WHEN unit_cost_iqd IS NULL THEN 1 ELSE 0 END) AS uncosted
    FROM stock_movements WHERE kind = 'receive' AND ref_type = 'receipt_item' AND ref_id IN (SELECT value FROM json_each(${JSON.stringify([...lineIds])}))
    GROUP BY ref_id`);
  return new Map(rows.map((row) => [row.refId, { qty: Number(row.qty), value: Number(row.uncosted) > 0 || row.value === null ? null : Number(row.value) }]));
}

async function assertPeriodOpen(db: Db, now: number): Promise<void> {
  const rows = await db.all<{ status: string }>(sql`SELECT status FROM fiscal_periods WHERE period = ${fiscalPeriodOf(now)}`);
  if (rows[0]?.status === "closed") throw new AppError("period_closed", 409, { detail: fiscalPeriodOf(now) });
}

export type PostResult = { units: number; resumed: boolean; replayed: boolean };

/** Posts a draft receipt into stock and the books (see the header), or resumes an interrupted posting. */
export async function postReceipt(db: Db, actor: Actor, raw: unknown, now: number): Promise<PostResult> {
  assertCan(actor, "purchasing.receipt.create");
  const input = PostReceiptInput.parse(raw);
  const receipt = await db.select().from(receipts).where(eq(receipts.id, input.receiptId)).get();
  if (!receipt) throw notFound("receipt");
  await assertRecordBranch(db, actor, receipt.locationId);
  const state = receiptStateOf(receipt);
  if (state === "cancelled") throw new AppError("receipt_cancelled", 409);
  if (state === "posted") return { units: 0, resumed: false, replayed: true };
  if (!receipt.poId) throw new AppError("po_not_open", 409);
  const order = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, receipt.poId)).get();
  if (!order) throw notFound("purchase_order");
  const supplier = await db.select({ code: suppliers.code }).from(suppliers).where(eq(suppliers.id, order.supplierId)).get();
  const readLines = () => db.select().from(receiptItems).where(eq(receiptItems.receiptId, receipt.id)).orderBy(asc(receiptItems.id));
  let lines = await readLines();
  const marker = `${POSTING_PREFIX}${randomToken(9)}`;
  const me = actorId(actor);
  let accepted = lines.filter((line) => line.qtyAccepted > 0);
  let resumed = false;

  if (state === "draft") {
    if (!(OPEN_PO_STATUSES as readonly string[]).includes(order.status)) throw new AppError("po_not_open", 409);
    await usableLocation(db, actor, receipt.locationId);
    await assertPeriodOpen(db, now);
    const draftBills = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM landed_costs WHERE receipt_id = ${receipt.id} AND status = 'draft'`);
    if (Number(draftBills[0]?.n ?? 0) > 0) throw new AppError("landed_unallocated", 409);
    const serialsUpper = accepted.flatMap((line) => (line.serialsScanned ?? []).map((value) => value.toUpperCase()));
    const taken = await takenSerials(db, serialsUpper, receipt.id);
    if (taken.length > 0) throw new AppError("serial_duplicate", 409, { detail: taken.slice(0, 10).join(", "), fields: { serials: "serial_duplicate" } });
    await runBatch(db, [
      expectThat(db, sql`(SELECT status FROM purchase_orders WHERE id = ${order.id}) IN ('approved', 'sent', 'partially_received')`, { code: "PO_NOT_OPEN", detail: order.id }),
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM landed_costs WHERE receipt_id = ${receipt.id} AND status = 'draft')`, { code: "LANDED_UNALLOCATED", detail: receipt.id }),
      db
        .update(receipts)
        .set({ status: "posted", receivedBy: marker, postedAt: now })
        .where(and(eq(receipts.id, receipt.id), eq(receipts.status, "draft"))),
      expectChanged(db, 1, { code: "RECEIPT_CHANGED", detail: receipt.id }),
      auditStatement(db, { actor, action: "purchasing.receipt.post_start", entityType: "receipt", entityId: receipt.id, summary: `${receipt.ref} · ${order.ref}`, before: { status: "draft" }, after: { status: "posting" }, at: now }),
    ]).catch(async (error) => {
      if (isDbError(error, "PO_NOT_OPEN")) throw new AppError("po_not_open", 409, { cause: error });
      if (isDbError(error, "LANDED_UNALLOCATED")) throw new AppError("landed_unallocated", 409, { cause: error });
      if (isDbError(error, "RECEIPT_CHANGED")) throw new AppError("posting_in_progress", 409, { cause: error });
      throw toAppError(error) ?? error;
    });
  } else {
    // "posting": someone started and has not finished. Only after the lease may another attempt take over.
    if ((receipt.postedAt ?? 0) + POSTING_LEASE_MS > now) throw new AppError("posting_in_progress", 409);
    await runBatch(db, [
      db
        .update(receipts)
        .set({ receivedBy: marker, postedAt: now })
        .where(and(eq(receipts.id, receipt.id), eq(receipts.status, "posted"), eq(receipts.receivedBy, receipt.receivedBy ?? ""), eq(receipts.postedAt, receipt.postedAt ?? 0))),
      expectChanged(db, 1, { code: "RECEIPT_CHANGED", detail: receipt.id }),
      auditStatement(db, { actor, action: "purchasing.receipt.post_resume", entityType: "receipt", entityId: receipt.id, summary: `${receipt.ref} · ${order.ref}`, at: now }),
    ]).catch((error) => {
      if (isDbError(error, "RECEIPT_CHANGED")) throw new AppError("posting_in_progress", 409, { cause: error });
      throw toAppError(error) ?? error;
    });
    resumed = true;
  }

  // The lease is ours and the receipt is no longer a draft, so its landed costs are frozen (pricing refuses changes):
  // read the lines again — a bill spread between the first read and the claim is carried into the layers.
  lines = await readLines();
  accepted = lines.filter((line) => line.qtyAccepted > 0);

  // Step 2 — stock, line by line, through the core.
  const reason = [receipt.ref, order.ref, supplier?.code ?? null, receipt.supplierDocNo ? `#${receipt.supplierDocNo}` : null].filter(Boolean).join(" · ");
  let moved = await movedLines(
    db,
    accepted.map((line) => line.id),
  );
  for (const line of accepted) {
    if (moved.has(line.id)) continue;
    const holder = await db.select({ receivedBy: receipts.receivedBy }).from(receipts).where(eq(receipts.id, receipt.id)).get();
    if (holder?.receivedBy !== marker) throw new AppError("posting_in_progress", 409);
    const unitCostIqd = line.landedUnitCostIqd ?? line.unitCostIqd;
    try {
      if (unitCostIqd === null) throw new AppError("cost_unknown", 409, { detail: line.id });
      await receiveStock(
        db,
        actor,
        { variantId: line.variantId, locationId: receipt.locationId, qty: line.qtyAccepted, unitCostIqd, serials: line.serialsScanned && line.serialsScanned.length > 0 ? line.serialsScanned : undefined, ref: { type: "receipt_item", id: line.id }, reason },
        now,
      );
    } catch (error) {
      // Nothing of this receipt moved: back to draft (with its first recorder when known), so it can be corrected.
      const anyMoved = (await movedLines(
        db,
        accepted.map((entry) => entry.id),
      )).size;
      if (anyMoved === 0) {
        await runBatch(db, [
          db
            .update(receipts)
            .set({ status: "draft", receivedBy: state === "draft" ? receipt.receivedBy : me, postedAt: null })
            .where(and(eq(receipts.id, receipt.id), eq(receipts.receivedBy, marker))),
          auditStatement(db, { actor, action: "purchasing.receipt.post_failed", entityType: "receipt", entityId: receipt.id, summary: receipt.ref, after: { status: "draft", error: toAppError(error)?.code ?? "unexpected" }, at: now }),
        ]);
      }
      throw error;
    }
  }

  // Step 3 — finish once: order quantities and status, invoice match, journal entry, audit.
  moved = await movedLines(
    db,
    accepted.map((line) => line.id),
  );
  const missing = accepted.find((line) => moved.get(line.id)?.qty !== line.qtyAccepted);
  if (missing) throw new AppError("posting_in_progress", 409, { detail: missing.id });
  const values = accepted.map((line) => moved.get(line.id)?.value ?? null);
  const valueIqd = values.every((value) => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const added = new Map<string, number>();
  for (const line of accepted) if (line.poItemId) added.set(line.poItemId, (added.get(line.poItemId) ?? 0) + line.qtyAccepted);
  const units = accepted.reduce((sum, line) => sum + line.qtyAccepted, 0);
  const statements: BatchStatement[] = [
    db
      .update(receipts)
      .set({ receivedBy: me, postedAt: now })
      .where(and(eq(receipts.id, receipt.id), eq(receipts.receivedBy, marker))),
    expectChanged(db, 1, { code: "POSTING_LOST", detail: receipt.id }),
  ];
  for (const [poItemId, qty] of added) {
    statements.push(
      db
        .update(poItems)
        .set({ qtyReceived: sql`${poItems.qtyReceived} + ${qty}` })
        .where(and(eq(poItems.id, poItemId), eq(poItems.poId, order.id))),
    );
  }
  statements.push(
    db
      .update(purchaseOrders)
      .set({ status: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM po_items WHERE po_id = ${order.id} AND qty_received < qty_ordered) THEN 'received' ELSE 'partially_received' END`, updatedAt: now })
      .where(and(eq(purchaseOrders.id, order.id), sql`${purchaseOrders.status} IN ('approved', 'sent', 'partially_received')`)),
    ...(await rematchStatements(db, order.id, added)),
  );
  if (valueIqd !== null && valueIqd > 0) {
    statements.push(
      ...postStockReceipt(db, {
        at: now,
        createdBy: postedBy(actor),
        isDemo: order.isDemo,
        refType: "receipt",
        refId: receipt.id,
        amountIqd: valueIqd,
        creditAccount: "accounts_payable",
        memo: `Stock received ${receipt.ref} · PO ${order.ref}${supplier ? ` · ${supplier.code}` : ""}`,
      }),
    );
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: "purchasing.receipt.post",
      entityType: "receipt",
      entityId: receipt.id,
      summary: `${receipt.ref} · ${order.ref}`,
      before: { status: "posting" },
      after: { status: "posted", units, rejected: lines.reduce((sum, line) => sum + line.qtyRejected, 0), lines: accepted.length, journal: valueIqd !== null && valueIqd > 0, uncosted: valueIqd === null },
      at: now,
    }),
  );
  await runBatch(db, statements).catch((error) => {
    if (isDbError(error, "POSTING_LOST")) throw new AppError("posting_in_progress", 409, { cause: error });
    const posting = mapPostingError(error);
    if (posting) throw posting;
    throw toAppError(error) ?? error;
  });
  return { units, resumed, replayed: false };
}

// ───────────────────────────────────────────────────────────────── reading

export { RECEIPT_FILTERS };
export type ReceiptFilter = (typeof RECEIPT_FILTERS)[number];
export type ReceiptFilters = { state: ReceiptFilter; q: string; page: number };

export function parseReceiptFilters(params: URLSearchParams): ReceiptFilters {
  const state = params.get("state");
  return { state: (RECEIPT_FILTERS as readonly string[]).includes(state ?? "") ? (state as ReceiptFilter) : "all", q: cleanQuery(params.get("q")), page: pageOf(params.get("page")) };
}

const stateCondition = (state: ReceiptFilter) => {
  switch (state) {
    case "open":
      return sql`(r.status = 'draft' OR (r.status = 'posted' AND r.received_by LIKE 'posting:%'))`;
    case "draft":
      return sql`r.status = 'draft'`;
    case "posting":
      return sql`r.status = 'posted' AND r.received_by LIKE 'posting:%'`;
    case "posted":
      return sql`r.status = 'posted' AND (r.received_by IS NULL OR r.received_by NOT LIKE 'posting:%')`;
    case "cancelled":
      return sql`r.status = 'cancelled'`;
    default:
      return sql`1 = 1`;
  }
};

export type ReceiptRow = { id: string; ref: string; state: ReceiptState; po: { id: string; ref: string } | null; supplier: { id: string; name: string } | null; location: string; receivedAt: number | null; units: number; accepted: number; rejected: number; createdAt: number };

export async function listReceipts(db: Db, actor: Actor, filters: ReceiptFilters): Promise<{ rows: ReceiptRow[]; total: number; page: number; pageCount: number; counts: Record<ReceiptFilter, number> }> {
  assertReceiptReader(actor);
  const base = [branchCondition(actor, sql`r.location_id`)];
  if (filters.q) {
    const like = likePattern(filters.q);
    base.push(sql`(r.ref LIKE ${like} ESCAPE '\\' OR coalesce(r.supplier_doc_no, '') LIKE ${like} ESCAPE '\\' OR coalesce(po.ref, '') LIKE ${like} ESCAPE '\\' OR coalesce(s.name, '') LIKE ${like} ESCAPE '\\')`);
  }
  const from = sql`receipts AS r LEFT JOIN purchase_orders AS po ON po.id = r.po_id LEFT JOIN suppliers AS s ON s.id = r.supplier_id JOIN inventory_locations AS l ON l.id = r.location_id`;
  const countRows = await Promise.all(
    RECEIPT_FILTERS.map(async (state) => {
      const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM ${from} WHERE ${sql.join([...base, stateCondition(state)], sql` AND `)}`);
      return [state, Number(rows[0]?.n ?? 0)] as const;
    }),
  );
  const counts = Object.fromEntries(countRows) as Record<ReceiptFilter, number>;
  const total = counts[filters.state];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<{ id: string; ref: string; status: string; receivedBy: string | null; poId: string | null; poRef: string | null; supplierId: string | null; supplierName: string | null; location: string; receivedAt: number | null; units: number; accepted: number; rejected: number; createdAt: number }>(sql`
    SELECT r.id AS id, r.ref AS ref, r.status AS status, r.received_by AS receivedBy, po.id AS poId, po.ref AS poRef, s.id AS supplierId, s.name AS supplierName, l.code AS location,
           r.received_at AS receivedAt, r.created_at AS createdAt,
           coalesce((SELECT SUM(qty_received) FROM receipt_items WHERE receipt_id = r.id), 0) AS units,
           coalesce((SELECT SUM(qty_accepted) FROM receipt_items WHERE receipt_id = r.id), 0) AS accepted,
           coalesce((SELECT SUM(qty_rejected) FROM receipt_items WHERE receipt_id = r.id), 0) AS rejected
    FROM ${from} WHERE ${sql.join([...base, stateCondition(filters.state)], sql` AND `)}
    ORDER BY r.created_at DESC, r.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      ref: row.ref,
      state: receiptStateOf(row),
      po: row.poId && row.poRef ? { id: row.poId, ref: row.poRef } : null,
      supplier: row.supplierId && row.supplierName ? { id: row.supplierId, name: row.supplierName } : null,
      location: row.location,
      receivedAt: row.receivedAt,
      units: Number(row.units),
      accepted: Number(row.accepted),
      rejected: Number(row.rejected),
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    counts,
  };
}

export type ReceiptLine = {
  id: string;
  poItemId: string | null;
  variant: VariantLabel;
  qtyOrdered: number | null;
  qtyReceived: number;
  qtyAccepted: number;
  qtyRejected: number;
  rejectReason: string | null;
  /** In stock already (its 'receive' movement exists). */
  inStock: boolean;
  /** Only with inventory.serial.read. */
  serials?: string[];
  /** [P] */
  unitCostMinor?: number | null;
  unitCostIqd?: number | null;
  landedUnitCostIqd?: number | null;
};

export type ReceiptDetail = {
  receipt: {
    id: string;
    ref: string;
    state: ReceiptState;
    po: { id: string; ref: string; status: string; currency: string } | null;
    supplier: { id: string; code: string; name: string } | null;
    location: { id: string; code: string; name: string };
    supplierDocNo: string | null;
    notes: string | null;
    receivedAt: number | null;
    receivedBy: string | null;
    postedAt: number | null;
    createdAt: number;
    /** While posting: when the lease ends and whether this person may resume now. */
    posting: { since: number; resumableAt: number; resumable: boolean } | null;
  };
  lines: ReceiptLine[];
  units: { received: number; accepted: number; rejected: number; inStock: number };
  /** [P] value of the goods at the order's rate, of the landed bills, and what was posted. */
  money?: { goodsIqd: number | null; landedIqd: number; postedIqd: number | null };
  /** Landed-cost bills (cost.read + landed-cost permission). */
  bills?: LandedBillView[];
  claims: { id: string; ref: string; kind: string; status: string }[];
  history: HistoryEntry[];
  can: { post: boolean; resume: boolean; cancel: boolean; landed: boolean; claim: boolean };
};

export async function getReceipt(db: Db, actor: Actor, receiptId: string, locale: Locale, now: number): Promise<ReceiptDetail> {
  assertReceiptReader(actor);
  const receipt = await db.select().from(receipts).where(eq(receipts.id, receiptId)).get();
  if (!receipt) throw notFound("receipt");
  await assertRecordBranch(db, actor, receipt.locationId);
  const withCost = can(actor, "cost.read");
  const landedAccess = withCost && canAny(actor, ["purchasing.landed_cost.allocate", "pricing.cost.update"]);
  const [order, supplier, location, lines, claims, history] = await Promise.all([
    receipt.poId ? db.select().from(purchaseOrders).where(eq(purchaseOrders.id, receipt.poId)).get() : Promise.resolve(undefined),
    receipt.supplierId ? db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, receipt.supplierId)).get() : Promise.resolve(undefined),
    db.all<{ id: string; code: string; name: string }>(sql`SELECT id, code, name FROM inventory_locations WHERE id = ${receipt.locationId}`),
    db.select().from(receiptItems).where(eq(receiptItems.receiptId, receipt.id)).orderBy(asc(receiptItems.id)),
    db.all<{ id: string; ref: string; kind: string; status: string }>(sql`SELECT id, ref, kind, status FROM supplier_claims WHERE receipt_id = ${receipt.id} ORDER BY created_at DESC`),
    historyOf(db, "receipt", receipt.id, 20),
  ]);
  const orderLines = order ? await db.select({ id: poItems.id, qtyOrdered: poItems.qtyOrdered }).from(poItems).where(eq(poItems.poId, order.id)) : [];
  const [labels, moved] = await Promise.all([
    variantsById(
      db,
      lines.map((line) => line.variantId),
      locale,
    ),
    movedLines(
      db,
      lines.map((line) => line.id),
    ),
  ]);
  const state = receiptStateOf(receipt);
  const recorder = state === "posting" ? null : receipt.receivedBy;
  const names = await employeeNames(db, [recorder]);
  const lineViews: ReceiptLine[] = lines.map((line) => {
    const view: ReceiptLine = {
      id: line.id,
      poItemId: line.poItemId,
      variant: labels.get(line.variantId) ?? { id: line.variantId, sku: line.variantId, barcode: null, name: line.variantId, productName: line.variantId, variantTitle: "", trackSerials: false, isActive: false },
      qtyOrdered: orderLines.find((item) => item.id === line.poItemId)?.qtyOrdered ?? null,
      qtyReceived: line.qtyReceived,
      qtyAccepted: line.qtyAccepted,
      qtyRejected: line.qtyRejected,
      rejectReason: line.rejectReason,
      inStock: moved.has(line.id),
    };
    if (can(actor, "inventory.serial.read") && line.serialsScanned && line.serialsScanned.length > 0) view.serials = line.serialsScanned;
    return withCost ? { ...view, unitCostMinor: line.unitCostMinor, unitCostIqd: line.unitCostIqd, landedUnitCostIqd: line.landedUnitCostIqd } : view;
  });
  let landed: Awaited<ReturnType<typeof getReceiptLanded>> | null = null;
  if (landedAccess) landed = await getReceiptLanded(db, actor, receipt.id, locale);
  let postedIqd: number | null = null;
  if (withCost && state === "posted") {
    const rows = await db.all<{ amount: number | null }>(sql`
      SELECT SUM(jl.debit_iqd) AS amount FROM journal_entries AS je JOIN journal_lines AS jl ON jl.entry_id = je.id WHERE je.idempotency_key = ${`receipt:${receipt.id}:receipt`}`);
    postedIqd = rows[0]?.amount === null || rows[0]?.amount === undefined ? null : Number(rows[0].amount);
  }
  const goodsIqd = lines.every((line) => line.unitCostIqd !== null) ? lines.reduce((sum, line) => sum + (line.unitCostIqd ?? 0) * line.qtyAccepted, 0) : null;
  const leaseEnds = (receipt.postedAt ?? 0) + POSTING_LEASE_MS;
  const detail: ReceiptDetail = {
    receipt: {
      id: receipt.id,
      ref: receipt.ref,
      state,
      po: order ? { id: order.id, ref: order.ref, status: order.status, currency: order.currency } : null,
      supplier: supplier ?? null,
      location: location[0] ?? { id: receipt.locationId, code: receipt.locationId, name: "" },
      supplierDocNo: receipt.supplierDocNo,
      notes: receipt.notes,
      receivedAt: receipt.receivedAt,
      receivedBy: recorder ? (names.get(recorder) ?? null) : null,
      postedAt: state === "posted" ? receipt.postedAt : null,
      createdAt: receipt.createdAt,
      posting: state === "posting" ? { since: receipt.postedAt ?? receipt.createdAt, resumableAt: leaseEnds, resumable: now >= leaseEnds } : null,
    },
    lines: lineViews,
    units: {
      received: lines.reduce((sum, line) => sum + line.qtyReceived, 0),
      accepted: lines.reduce((sum, line) => sum + line.qtyAccepted, 0),
      rejected: lines.reduce((sum, line) => sum + line.qtyRejected, 0),
      inStock: lines.filter((line) => moved.has(line.id)).reduce((sum, line) => sum + (moved.get(line.id)?.qty ?? 0), 0),
    },
    claims,
    history,
    can: {
      post: state === "draft" && can(actor, "purchasing.receipt.create"),
      resume: state === "posting" && now >= leaseEnds && can(actor, "purchasing.receipt.create"),
      cancel: state === "draft" && can(actor, "purchasing.receipt.create"),
      landed: landedAccess && state === "draft",
      claim: can(actor, "purchasing.claim.manage") && state === "posted",
    },
  };
  if (withCost) {
    // cost.read covers landed cost: the bills' total is shown even to someone who may not see or spread the bills —
    // never a zero that would turn the posted value's difference into "rounding".
    const landedTotal = landed ? landed.bills.reduce((sum, bill) => sum + bill.amountIqd, 0) : Number((await db.all<{ n: number | null }>(sql`SELECT coalesce(SUM(amount_iqd), 0) AS n FROM landed_costs WHERE receipt_id = ${receipt.id}`))[0]?.n ?? 0);
    detail.money = { goodsIqd, landedIqd: landedTotal, postedIqd };
  }
  if (landed) detail.bills = landed.bills;
  return detail;
}
