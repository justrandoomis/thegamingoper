/**
 * Supplier rating (admin 09.08) — computed, never typed: on-time deliveries and defects over the last
 * RATING.windowDays, from the module's own records.
 *
 *   on time      units of posted receipts that arrived by the end of their order's expected day (Iraq time) ÷ units
 *                that were due: on time + late + still missing after the expected day (open orders) + never came
 *                (orders closed short after their expected day — closing an order does not erase the shortfall)
 *   defects      units refused at inspection + units of defect / damage / wrong-item claims beyond what inspection
 *                had already refused on the same receipt, ÷ units delivered
 *   score        60 × on-time rate + 40 × (1 − defect rate) — grades A ≥ 90 · B ≥ 75 · C ≥ 60 · D (rules.ts)
 *   lead time    days from ordering (sent, else approved) to each receipt, against the lead time on the profile
 *
 * With fewer than RATING.minReceipts posted receipts in the window there is no score: the page says so. Quantities
 * only — nothing here is cost data.
 */
import { sql } from "drizzle-orm";
import type { Db } from "~/server/db/drizzle.server";
import { DAY_MS, DEFECT_CLAIM_KINDS, OPEN_PO_STATUSES, POSTING_PREFIX, RATING, endOfBaghdadDay, rateSupplier, type RatingFacts, type SupplierRating } from "./rules";

const json = (values: readonly string[]) => JSON.stringify([...new Set(values)]);

/** The rating facts of each supplier (an entry for every id asked, zeros when nothing happened). */
export async function ratingFactsFor(db: Db, supplierIds: readonly string[], now: number): Promise<Map<string, RatingFacts>> {
  const ids = [...new Set(supplierIds.filter(Boolean))];
  const out = new Map<string, RatingFacts>();
  if (ids.length === 0) return out;
  const since = now - RATING.windowDays * DAY_MS;
  const posted = sql`r.status = 'posted' AND (r.received_by IS NULL OR substr(r.received_by, 1, ${POSTING_PREFIX.length}) <> ${POSTING_PREFIX})`;

  const [lines, overdue, shortClosed, claims, suppliers] = await Promise.all([
    db.all<{ supplierId: string; receiptId: string; variantId: string; received: number; rejected: number; receivedAt: number; expectedAt: number | null; orderedAt: number | null }>(sql`
      SELECT po.supplier_id AS supplierId, r.id AS receiptId, ri.variant_id AS variantId, ri.qty_received AS received, ri.qty_rejected AS rejected,
             coalesce(r.received_at, r.posted_at, r.created_at) AS receivedAt, po.expected_at AS expectedAt, coalesce(po.sent_at, po.approved_at) AS orderedAt
      FROM receipts AS r JOIN purchase_orders AS po ON po.id = r.po_id JOIN receipt_items AS ri ON ri.receipt_id = r.id
      WHERE ${posted} AND coalesce(r.received_at, r.posted_at, r.created_at) >= ${since}
        AND po.supplier_id IN (SELECT value FROM json_each(${json(ids)}))`),
    db.all<{ supplierId: string; expectedAt: number; outstanding: number }>(sql`
      SELECT po.supplier_id AS supplierId, po.expected_at AS expectedAt, SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS outstanding
      FROM purchase_orders AS po JOIN po_items AS pi ON pi.po_id = po.id
      WHERE po.status IN (SELECT value FROM json_each(${json(OPEN_PO_STATUSES)})) AND po.expected_at IS NOT NULL AND po.expected_at >= ${since - DAY_MS}
        AND po.supplier_id IN (SELECT value FROM json_each(${json(ids)}))
      GROUP BY po.id`),
    db.all<{ supplierId: string; expectedAt: number; closedAt: number; missing: number }>(sql`
      SELECT po.supplier_id AS supplierId, po.expected_at AS expectedAt, po.updated_at AS closedAt, SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS missing
      FROM purchase_orders AS po JOIN po_items AS pi ON pi.po_id = po.id
      WHERE po.status = 'closed' AND po.expected_at IS NOT NULL AND po.expected_at >= ${since - DAY_MS}
        AND po.supplier_id IN (SELECT value FROM json_each(${json(ids)}))
      GROUP BY po.id`),
    db.all<{ supplierId: string; receiptId: string | null; items: string | null }>(sql`
      SELECT supplier_id AS supplierId, receipt_id AS receiptId, items FROM supplier_claims
      WHERE kind IN (SELECT value FROM json_each(${json(DEFECT_CLAIM_KINDS)})) AND created_at >= ${since}
        AND supplier_id IN (SELECT value FROM json_each(${json(ids)}))`),
    db.all<{ id: string; leadTimeDays: number | null }>(sql`SELECT id, lead_time_days AS leadTimeDays FROM suppliers WHERE id IN (SELECT value FROM json_each(${json(ids)}))`),
  ]);

  for (const id of ids) {
    out.set(id, { receipts: 0, unitsReceived: 0, unitsOnTime: 0, unitsLate: 0, unitsOverdue: 0, unitsShortClosed: 0, defectUnits: 0, leadDays: [], promisedLeadDays: suppliers.find((row) => row.id === id)?.leadTimeDays ?? null });
  }
  const receiptsSeen = new Map<string, Set<string>>();
  const leadByReceipt = new Map<string, { supplierId: string; days: number }>();
  /** Units refused at inspection per receipt and variant (claims raised for them are not counted twice). */
  const rejectedAt = new Map<string, number>();
  for (const line of lines) {
    const facts = out.get(line.supplierId);
    if (!facts) continue;
    const seen = receiptsSeen.get(line.supplierId) ?? new Set<string>();
    seen.add(line.receiptId);
    receiptsSeen.set(line.supplierId, seen);
    const received = Number(line.received);
    const rejected = Number(line.rejected);
    facts.unitsReceived += received;
    facts.defectUnits += rejected;
    rejectedAt.set(`${line.receiptId}|${line.variantId}`, (rejectedAt.get(`${line.receiptId}|${line.variantId}`) ?? 0) + rejected);
    if (line.expectedAt !== null) {
      if (Number(line.receivedAt) < endOfBaghdadDay(Number(line.expectedAt))) facts.unitsOnTime += received;
      else facts.unitsLate += received;
    }
    if (line.orderedAt !== null && !leadByReceipt.has(line.receiptId)) leadByReceipt.set(line.receiptId, { supplierId: line.supplierId, days: Math.max(0, (Number(line.receivedAt) - Number(line.orderedAt)) / DAY_MS) });
  }
  for (const [supplierId, seen] of receiptsSeen) {
    const facts = out.get(supplierId);
    if (facts) facts.receipts = seen.size;
  }
  for (const { supplierId, days } of leadByReceipt.values()) {
    const facts = out.get(supplierId);
    if (facts) (facts.leadDays as number[]).push(Math.round(days * 10) / 10);
  }
  for (const row of overdue) {
    const facts = out.get(row.supplierId);
    if (facts && now >= endOfBaghdadDay(Number(row.expectedAt))) facts.unitsOverdue += Math.max(0, Number(row.outstanding));
  }
  // Closed short after the expected day: the missing units were due and never came. Closed before it, the store
  // decided it no longer needed them — not the supplier's lateness.
  for (const row of shortClosed) {
    const facts = out.get(row.supplierId);
    if (facts && Number(row.closedAt) >= endOfBaghdadDay(Number(row.expectedAt))) facts.unitsShortClosed = (facts.unitsShortClosed ?? 0) + Math.max(0, Number(row.missing));
  }
  for (const claim of claims) {
    const facts = out.get(claim.supplierId);
    if (!facts) continue;
    let items: Array<{ variantId?: string; qty?: number }> = [];
    try {
      items = claim.items ? (JSON.parse(claim.items) as typeof items) : [];
    } catch {
      items = [];
    }
    for (const item of items) {
      const qty = Math.max(0, Math.floor(Number(item.qty ?? 0)));
      const already = claim.receiptId && item.variantId ? (rejectedAt.get(`${claim.receiptId}|${item.variantId}`) ?? 0) : 0;
      const beyond = Math.max(0, qty - already);
      if (claim.receiptId && item.variantId) rejectedAt.set(`${claim.receiptId}|${item.variantId}`, Math.max(0, already - qty));
      facts.defectUnits += beyond;
    }
  }
  return out;
}

/** The rating of each supplier (see the header). */
export async function supplierRatings(db: Db, supplierIds: readonly string[], now: number): Promise<Map<string, SupplierRating>> {
  const facts = await ratingFactsFor(db, supplierIds, now);
  return new Map([...facts].map(([id, value]) => [id, rateSupplier(value)]));
}
