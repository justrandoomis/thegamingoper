/**
 * Variance alerts (admin 09.07) and the module's home figures. Alerts are read from the records, never stored: they
 * disappear when the cause is dealt with (an invoice approved with a reason or voided, a claim opened and closed, an
 * order closed, goods received).
 *
 *   invoice_qty     an invoice bills more units than were received (three-way match)
 *   invoice_price   an invoice's unit cost differs from the order's, or its charges (shipping + other, with the
 *                   order's other invoices) exceed the order's                                    [P] cost.read only
 *   rejected        units refused at inspection on a posted receipt (last 90 days) — and whether a claim covers them
 *   over_received   an order line received more than was ordered (two receipts drafted at once, or a correction)
 *   short_closed    an order closed with units missing (last 90 days)
 *   late            an open order whose expected day has passed with units still missing
 *
 * Quantity alerts need purchasing.po.read; price alerts cost.read as well; links to invoices only for those who may
 * open them. Error codes: forbidden (403).
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import { shapedBySql } from "./orders.server";
import { ALERT_KINDS, DAY_MS, OPEN_PO_STATUSES, endOfBaghdadDay, type MatchDiscrepancy, type ReceiptState } from "./rules";
import { PAGE_SIZE, actorId, branchCondition, pageOf, variantsById, type VariantLabel } from "./shared.server";

export { ALERT_KINDS };
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertFilters = { kind: AlertKind | "all"; page: number };

export function parseAlertFilters(params: URLSearchParams): AlertFilters {
  const kind = params.get("kind");
  return { kind: (ALERT_KINDS as readonly string[]).includes(kind ?? "") ? (kind as AlertKind) : "all", page: pageOf(params.get("page")) };
}

export type Alert = {
  id: string;
  kind: AlertKind;
  at: number;
  supplier: { id: string; name: string };
  po: { id: string; ref: string } | null;
  receipt: { id: string; ref: string } | null;
  invoice: { id: string; invoiceNo: string; open: boolean } | null;
  variant: VariantLabel | null;
  /** Units: ordered / received / billed / refused / missing, as the kind needs. */
  ordered?: number | null;
  received?: number | null;
  invoiced?: number | null;
  rejected?: number;
  missing?: number;
  reason?: string | null;
  expectedAt?: number | null;
  /** A claim already raised for it. */
  claim?: { id: string; ref: string; status: string } | null;
  /** [P] invoice_price only: unit costs — or, with `charges`, the order's shipping + other and what was billed. */
  currency?: string;
  poUnitCostMinor?: number;
  invoiceUnitCostMinor?: number;
  charges?: boolean;
};

export type AlertPage = { rows: Alert[]; total: number; page: number; pageCount: number; counts: Record<AlertKind | "all", number> };

function assertAlertReader(actor: Actor): void {
  if (!canAny(actor, ["purchasing.po.read", "purchasing.invoice.manage", "purchasing.claim.manage"])) throw forbidden("purchasing.po.read");
}

/** Every alert this actor may see, newest first. */
export async function listAlerts(db: Db, actor: Actor, filters: AlertFilters, locale: Locale, now: number): Promise<AlertPage> {
  assertAlertReader(actor);
  const withCost = can(actor, "cost.read");
  const invoiceAccess = withCost && can(actor, "purchasing.invoice.manage");
  const since = now - 90 * DAY_MS;
  const branch = branchCondition(actor, sql`po.location_id`);
  const [mismatches, rejected, over, short, late, claims] = await Promise.all([
    db.all<{ id: string; invoiceNo: string; status: string; discrepancies: string | null; createdAt: number; currency: string; poId: string | null; poRef: string | null; supplierId: string; supplierName: string }>(sql`
      SELECT i.id AS id, i.invoice_no AS invoiceNo, i.status AS status, i.discrepancies AS discrepancies, i.created_at AS createdAt, i.currency AS currency,
             po.id AS poId, po.ref AS poRef, s.id AS supplierId, s.name AS supplierName
      FROM supplier_invoices AS i JOIN suppliers AS s ON s.id = i.supplier_id LEFT JOIN purchase_orders AS po ON po.id = i.po_id
      WHERE i.status = 'mismatch' AND ${branch} ORDER BY i.created_at DESC LIMIT 200`),
    db.all<{ receiptId: string; receiptRef: string; at: number; variantId: string; received: number; rejected: number; reason: string | null; poId: string | null; poRef: string | null; supplierId: string; supplierName: string }>(sql`
      SELECT r.id AS receiptId, r.ref AS receiptRef, coalesce(r.posted_at, r.created_at) AS at, ri.variant_id AS variantId, ri.qty_received AS received, ri.qty_rejected AS rejected, ri.reject_reason AS reason,
             po.id AS poId, po.ref AS poRef, s.id AS supplierId, s.name AS supplierName
      FROM receipt_items AS ri JOIN receipts AS r ON r.id = ri.receipt_id JOIN suppliers AS s ON s.id = r.supplier_id LEFT JOIN purchase_orders AS po ON po.id = r.po_id
      WHERE ri.qty_rejected > 0 AND r.status = 'posted' AND (r.received_by IS NULL OR r.received_by NOT LIKE 'posting:%') AND coalesce(r.posted_at, r.created_at) >= ${since}
        AND ${branchCondition(actor, sql`r.location_id`)}
      ORDER BY r.created_at DESC LIMIT 200`),
    db.all<{ poId: string; poRef: string; at: number; variantId: string; ordered: number; received: number; supplierId: string; supplierName: string }>(sql`
      SELECT po.id AS poId, po.ref AS poRef, po.updated_at AS at, pi.variant_id AS variantId, pi.qty_ordered AS ordered, pi.qty_received AS received, s.id AS supplierId, s.name AS supplierName
      FROM po_items AS pi JOIN purchase_orders AS po ON po.id = pi.po_id JOIN suppliers AS s ON s.id = po.supplier_id
      WHERE pi.qty_received > pi.qty_ordered AND ${branch} ORDER BY po.updated_at DESC LIMIT 200`),
    db.all<{ poId: string; poRef: string; at: number; variantId: string; ordered: number; received: number; supplierId: string; supplierName: string }>(sql`
      SELECT po.id AS poId, po.ref AS poRef, po.updated_at AS at, pi.variant_id AS variantId, pi.qty_ordered AS ordered, pi.qty_received AS received, s.id AS supplierId, s.name AS supplierName
      FROM po_items AS pi JOIN purchase_orders AS po ON po.id = pi.po_id JOIN suppliers AS s ON s.id = po.supplier_id
      WHERE po.status = 'closed' AND pi.qty_received < pi.qty_ordered AND po.updated_at >= ${since} AND ${branch} ORDER BY po.updated_at DESC LIMIT 200`),
    db.all<{ poId: string; poRef: string; expectedAt: number; missing: number; supplierId: string; supplierName: string }>(sql`
      SELECT po.id AS poId, po.ref AS poRef, po.expected_at AS expectedAt, SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS missing, s.id AS supplierId, s.name AS supplierName
      FROM purchase_orders AS po JOIN po_items AS pi ON pi.po_id = po.id JOIN suppliers AS s ON s.id = po.supplier_id
      WHERE po.status IN (SELECT value FROM json_each(${JSON.stringify(OPEN_PO_STATUSES)})) AND po.expected_at IS NOT NULL AND po.expected_at + ${DAY_MS} <= ${now} AND ${branch}
      GROUP BY po.id HAVING missing > 0 ORDER BY po.expected_at ASC LIMIT 200`),
    db.all<{ id: string; ref: string; status: string; poId: string | null; receiptId: string | null; kind: string }>(sql`SELECT id, ref, status, po_id AS poId, receipt_id AS receiptId, kind FROM supplier_claims WHERE created_at >= ${since - 365 * DAY_MS}`),
  ]);

  const out: Alert[] = [];
  for (const invoice of mismatches) {
    let items: MatchDiscrepancy[] = [];
    try {
      items = invoice.discrepancies ? (JSON.parse(invoice.discrepancies) as typeof items) : [];
    } catch {
      items = [];
    }
    items.forEach((item, index) => {
      const base = { at: invoice.createdAt, supplier: { id: invoice.supplierId, name: invoice.supplierName }, po: invoice.poId && invoice.poRef ? { id: invoice.poId, ref: invoice.poRef } : null, receipt: null, invoice: { id: invoice.id, invoiceNo: invoice.invoiceNo, open: invoiceAccess }, variant: null as VariantLabel | null, claim: null };
      if (item.field === "qty") out.push({ ...base, id: `${invoice.id}:${index}`, kind: "invoice_qty", ordered: item.po, received: item.received, invoiced: item.invoiced, variant: { id: item.variantId } as VariantLabel });
      // Charges billed above the order's shipping + other are a price variance of the whole invoice [P].
      else if (withCost && item.field === "charges") out.push({ ...base, id: `${invoice.id}:${index}`, kind: "invoice_price", charges: true, currency: invoice.currency, poUnitCostMinor: item.po ?? undefined, invoiceUnitCostMinor: item.invoiced ?? undefined });
      else if (withCost) out.push({ ...base, id: `${invoice.id}:${index}`, kind: "invoice_price", variant: { id: item.variantId } as VariantLabel, currency: invoice.currency, poUnitCostMinor: item.po ?? undefined, invoiceUnitCostMinor: item.invoiced ?? undefined });
    });
  }
  const claimFor = (match: (claim: (typeof claims)[number]) => boolean) => {
    const claim = claims.find(match);
    return claim ? { id: claim.id, ref: claim.ref, status: claim.status } : null;
  };
  for (const row of rejected) {
    out.push({
      id: `${row.receiptId}:${row.variantId}`,
      kind: "rejected",
      at: row.at,
      supplier: { id: row.supplierId, name: row.supplierName },
      po: row.poId && row.poRef ? { id: row.poId, ref: row.poRef } : null,
      receipt: { id: row.receiptId, ref: row.receiptRef },
      invoice: null,
      variant: { id: row.variantId } as VariantLabel,
      received: Number(row.received),
      rejected: Number(row.rejected),
      reason: row.reason,
      claim: claimFor((claim) => claim.receiptId === row.receiptId),
    });
  }
  for (const row of over) {
    out.push({ id: `${row.poId}:${row.variantId}:over`, kind: "over_received", at: row.at, supplier: { id: row.supplierId, name: row.supplierName }, po: { id: row.poId, ref: row.poRef }, receipt: null, invoice: null, variant: { id: row.variantId } as VariantLabel, ordered: Number(row.ordered), received: Number(row.received) });
  }
  for (const row of short) {
    out.push({
      id: `${row.poId}:${row.variantId}:short`,
      kind: "short_closed",
      at: row.at,
      supplier: { id: row.supplierId, name: row.supplierName },
      po: { id: row.poId, ref: row.poRef },
      receipt: null,
      invoice: null,
      variant: { id: row.variantId } as VariantLabel,
      ordered: Number(row.ordered),
      received: Number(row.received),
      missing: Number(row.ordered) - Number(row.received),
      claim: claimFor((claim) => claim.poId === row.poId && claim.kind === "shortage"),
    });
  }
  for (const row of late) {
    if (now < endOfBaghdadDay(Number(row.expectedAt))) continue;
    out.push({ id: `${row.poId}:late`, kind: "late", at: endOfBaghdadDay(Number(row.expectedAt)), supplier: { id: row.supplierId, name: row.supplierName }, po: { id: row.poId, ref: row.poRef }, receipt: null, invoice: null, variant: null, expectedAt: Number(row.expectedAt), missing: Number(row.missing) });
  }
  const labels = await variantsById(
    db,
    out.map((alert) => alert.variant?.id ?? "").filter(Boolean),
    locale,
  );
  for (const alert of out) if (alert.variant) alert.variant = labels.get(alert.variant.id) ?? { id: alert.variant.id, sku: alert.variant.id, barcode: null, name: alert.variant.id, productName: alert.variant.id, variantTitle: "", trackSerials: false, isActive: false };
  out.sort((a, b) => b.at - a.at);
  const counts = { all: out.length } as Record<AlertKind | "all", number>;
  for (const kind of ALERT_KINDS) counts[kind] = out.filter((alert) => alert.kind === kind).length;
  const filtered = filters.kind === "all" ? out : out.filter((alert) => alert.kind === filters.kind);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  return { rows: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: filtered.length, page, pageCount, counts };
}

// ───────────────────────────────────────────────────────────────── home

export type PurchasingOverview = {
  waiting: {
    /** Orders above the limit this employee may decide (not their own); null without the permission. */
    approvals: number | null;
    receiptsDraft: number | null;
    receiptsStuck: number | null;
    invoicesMismatch: number | null;
    claimsOpen: number | null;
    late: number | null;
    alerts: number | null;
  };
  figures: { openOrders: number; unitsIncoming: number; suppliersActive: number; receiptsThisMonth: number; openValueIqd?: number | null };
  recent: { id: string; ref: string; state: ReceiptState | string; at: number; kind: "receipt" | "order"; label: string }[];
};

export async function purchasingOverview(db: Db, actor: Actor, now: number): Promise<PurchasingOverview> {
  const me = actorId(actor) ?? "";
  const withCost = can(actor, "cost.read");
  const poRead = can(actor, "purchasing.po.read");
  const branch = branchCondition(actor, sql`po.location_id`);
  const monthStart = Date.UTC(new Date(now + 3 * 3_600_000).getUTCFullYear(), new Date(now + 3 * 3_600_000).getUTCMonth(), 1) - 3 * 3_600_000;
  const one = async (query: ReturnType<typeof sql>) => Number((await db.all<{ n: number | null }>(query))[0]?.n ?? 0);
  const [approvals, drafts, stuck, mismatch, claims, late, openOrders, incoming, suppliersActive, receiptsMonth, openValue] = await Promise.all([
    can(actor, "purchasing.po.approve") && withCost
      ? one(sql`SELECT count(*) AS n FROM purchase_orders AS po JOIN approvals AS a ON a.id = po.approval_id WHERE po.status = 'pending_approval' AND a.status = 'pending' AND a.requested_by <> ${me} AND coalesce(po.created_by, '') <> ${me} AND NOT ${shapedBySql(me)} AND ${branch}`)
      : Promise.resolve(null),
    can(actor, "purchasing.receipt.create") ? one(sql`SELECT count(*) AS n FROM receipts AS r WHERE r.status = 'draft' AND ${branchCondition(actor, sql`r.location_id`)}`) : Promise.resolve(null),
    can(actor, "purchasing.receipt.create") ? one(sql`SELECT count(*) AS n FROM receipts AS r WHERE r.status = 'posted' AND r.received_by LIKE 'posting:%' AND r.posted_at + ${5 * 60_000} <= ${now} AND ${branchCondition(actor, sql`r.location_id`)}`) : Promise.resolve(null),
    can(actor, "purchasing.invoice.manage") && withCost ? one(sql`SELECT count(*) AS n FROM supplier_invoices AS i LEFT JOIN purchase_orders AS po ON po.id = i.po_id WHERE i.status = 'mismatch' AND ${branch}`) : Promise.resolve(null),
    can(actor, "purchasing.claim.manage")
      ? one(sql`SELECT count(*) AS n FROM supplier_claims AS c LEFT JOIN purchase_orders AS po ON po.id = c.po_id LEFT JOIN receipts AS r ON r.id = c.receipt_id WHERE c.status IN ('open', 'submitted', 'accepted') AND ${branchCondition(actor, sql`coalesce(r.location_id, po.location_id)`)}`)
      : Promise.resolve(null),
    poRead ? one(sql`SELECT count(*) AS n FROM purchase_orders AS po WHERE po.status IN ('approved', 'sent', 'partially_received') AND po.expected_at IS NOT NULL AND po.expected_at + ${DAY_MS} <= ${now} AND ${branch}`) : Promise.resolve(0),
    poRead ? one(sql`SELECT count(*) AS n FROM purchase_orders AS po WHERE po.status IN ('approved', 'sent', 'partially_received') AND ${branch}`) : Promise.resolve(0),
    poRead ? one(sql`SELECT coalesce(SUM(max(pi.qty_ordered - pi.qty_received, 0)), 0) AS n FROM po_items AS pi JOIN purchase_orders AS po ON po.id = pi.po_id WHERE po.status IN ('approved', 'sent', 'partially_received') AND ${branch}`) : Promise.resolve(0),
    can(actor, "purchasing.supplier.read") ? one(sql`SELECT count(*) AS n FROM suppliers WHERE status = 'active'`) : Promise.resolve(0),
    poRead || can(actor, "purchasing.receipt.create") ? one(sql`SELECT count(*) AS n FROM receipts AS r WHERE r.status = 'posted' AND r.posted_at >= ${monthStart} AND ${branchCondition(actor, sql`r.location_id`)}`) : Promise.resolve(0),
    withCost && poRead ? db.all<{ n: number | null; unknown: number }>(sql`SELECT SUM(po.total_iqd) AS n, SUM(CASE WHEN po.total_iqd IS NULL THEN 1 ELSE 0 END) AS unknown FROM purchase_orders AS po WHERE po.status IN ('approved', 'sent', 'partially_received') AND ${branch}`) : Promise.resolve(null),
  ]);
  const recent = poRead || can(actor, "purchasing.receipt.create")
    ? await db.all<{ id: string; ref: string; status: string; receivedBy: string | null; at: number; po: string | null }>(sql`
        SELECT r.id AS id, r.ref AS ref, r.status AS status, r.received_by AS receivedBy, r.created_at AS at, po.ref AS po
        FROM receipts AS r LEFT JOIN purchase_orders AS po ON po.id = r.po_id WHERE ${branchCondition(actor, sql`r.location_id`)} ORDER BY r.created_at DESC LIMIT 6`)
    : [];
  const alerts = poRead ? (await listAlerts(db, actor, { kind: "all", page: 1 }, "ar", now)).total : null;
  const figures: PurchasingOverview["figures"] = { openOrders, unitsIncoming: incoming, suppliersActive, receiptsThisMonth: receiptsMonth };
  if (openValue) figures.openValueIqd = Number(openValue[0]?.unknown ?? 0) > 0 ? null : Number(openValue[0]?.n ?? 0);
  return {
    waiting: { approvals, receiptsDraft: drafts, receiptsStuck: stuck, invoicesMismatch: mismatch, claimsOpen: claims, late: poRead ? late : null, alerts },
    figures,
    recent: recent.map((row) => ({ id: row.id, ref: row.ref, state: row.status === "posted" && row.receivedBy?.startsWith("posting:") ? "posting" : row.status, at: row.at, kind: "receipt" as const, label: row.po ?? "" })),
  };
}
