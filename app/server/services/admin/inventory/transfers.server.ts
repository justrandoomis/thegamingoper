/**
 * Admin module 04 — transfers between branches, warehouses and storage positions (04.07): the lists and the
 * transfer page. Every change goes through the core-level ~/server/services/inventory/transfers.server.ts
 * (createTransfer, shipTransfer, receiveTransfer, closeTransferShortfall, cancelTransfer).
 *
 * Serial numbers on a transfer are shown only with inventory.serial.read; the value of the goods in transit [P]
 * only with cost.read (from the 'transfer_out' movements' unit costs), and so is the value a shortfall close would
 * write off (the core's shortfallValue).
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { AppError, notFound } from "~/server/errors";
import { shortfallValue } from "~/server/services/inventory/transfers.server";
import { PAGE_SIZE, employeeNames, locationTree, pageOf, variantLabels, type LocationNode, type VariantLabel } from "./shared.server";

export const TRANSFER_STATUS_FILTERS = ["open", "draft", "in_transit", "received", "cancelled", "all"] as const;
export type TransferStatusFilter = (typeof TRANSFER_STATUS_FILTERS)[number];
export type TransferFilters = { status: TransferStatusFilter; location: string | null; q: string; page: number };

export function parseTransferFilters(params: URLSearchParams): TransferFilters {
  const status = params.get("status") as TransferStatusFilter | null;
  return {
    status: status && TRANSFER_STATUS_FILTERS.includes(status) ? status : "open",
    location: params.get("location")?.match(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) ? params.get("location") : null,
    q: (params.get("q") ?? "").trim().slice(0, 40),
    page: pageOf(params.get("page")),
  };
}

export type TransferListRow = {
  id: string;
  ref: string;
  status: "draft" | "in_transit" | "received" | "cancelled";
  from: Pick<LocationNode, "id" | "code" | "name">;
  to: Pick<LocationNode, "id" | "code" | "name">;
  lines: number;
  units: number;
  unitsReceived: number;
  createdAt: number;
  shippedAt: number | null;
  receivedAt: number | null;
  requestedBy: string | null;
};

export async function listTransfers(db: Db, actor: Actor, filters: TransferFilters): Promise<{ rows: TransferListRow[]; total: number; page: number; pageCount: number }> {
  assertCan(actor, "inventory.stock.read");
  const parts = [] as ReturnType<typeof sql>[];
  if (filters.status === "open") parts.push(sql`t.status IN ('draft', 'in_transit')`);
  else if (filters.status !== "all") parts.push(sql`t.status = ${filters.status}`);
  if (filters.location) parts.push(sql`(t.from_location_id = ${filters.location} OR t.to_location_id = ${filters.location})`);
  if (filters.q) parts.push(sql`t.ref = upper(${filters.q})`);
  const where = parts.length ? sql.join(parts, sql` AND `) : sql`1 = 1`;
  const [rows, totals, tree] = await Promise.all([
    db.all<{ id: string; ref: string; status: TransferListRow["status"]; fromId: string; toId: string; lines: number; units: number; unitsReceived: number; createdAt: number; shippedAt: number | null; receivedAt: number | null; requestedBy: string | null }>(sql`
      SELECT t.id AS id, t.ref AS ref, t.status AS status, t.from_location_id AS fromId, t.to_location_id AS toId,
             (SELECT count(*) FROM stock_transfer_items AS i WHERE i.transfer_id = t.id) AS lines,
             (SELECT coalesce(sum(qty), 0) FROM stock_transfer_items AS i WHERE i.transfer_id = t.id) AS units,
             (SELECT coalesce(sum(qty_received), 0) FROM stock_transfer_items AS i WHERE i.transfer_id = t.id) AS unitsReceived,
             t.created_at AS createdAt, t.shipped_at AS shippedAt, t.received_at AS receivedAt, t.requested_by AS requestedBy
      FROM stock_transfers AS t WHERE ${where}
      ORDER BY CASE t.status WHEN 'in_transit' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, t.created_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM stock_transfers AS t WHERE ${where}`),
    locationTree(db),
  ]);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const names = await employeeNames(db, rows.map((row) => row.requestedBy));
  const loc = (id: string) => ({ id, code: byId.get(id)?.code ?? id, name: byId.get(id)?.name ?? "" });
  const total = Number(totals[0]?.n ?? 0);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      ref: row.ref,
      status: row.status,
      from: loc(row.fromId),
      to: loc(row.toId),
      lines: Number(row.lines),
      units: Number(row.units),
      unitsReceived: Number(row.unitsReceived),
      createdAt: row.createdAt,
      shippedAt: row.shippedAt,
      receivedAt: row.receivedAt,
      requestedBy: row.requestedBy ? (names.get(row.requestedBy) ?? null) : null,
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export type TransferItemView = { id: string; variant: VariantLabel; qty: number; qtyReceived: number; serialId: string | null; serial?: string | null; serialStatus?: string | null };
export type TransferView = {
  id: string;
  ref: string;
  status: TransferListRow["status"];
  from: Pick<LocationNode, "id" | "code" | "name" | "path">;
  to: Pick<LocationNode, "id" | "code" | "name" | "path">;
  notes: string | null;
  items: TransferItemView[];
  people: { requestedBy: string | null; shippedBy: string | null; receivedBy: string | null };
  times: { createdAt: number; shippedAt: number | null; receivedAt: number | null; cancelledAt: number | null };
  units: number;
  unitsReceived: number;
  /** Units written off as lost when the shortfall was closed. */
  unitsLost: number;
  /** Reason given when it was cancelled or its shortfall closed (from the audit trail). */
  closingReason: string | null;
  /** [P] value of the goods (transfer_out unit costs); null when part of it is unknown. cost.read only. */
  valueIqd?: number | null;
  /**
   * [P] What closing the shortfall now would write off at cost (the missing units' FIFO slices, as the close books
   * them); null when part of it is unknown. cost.read only, and only while units are still in transit.
   */
  shortfallValueIqd?: number | null;
};

export async function getTransfer(db: Db, actor: Actor, transferId: string, locale: Locale): Promise<TransferView> {
  assertCan(actor, "inventory.stock.read");
  const withSerials = can(actor, "inventory.serial.read");
  const transfers = await db.all<{ id: string; ref: string; status: TransferListRow["status"]; fromId: string; toId: string; notes: string | null; requestedBy: string | null; shippedBy: string | null; receivedBy: string | null; createdAt: number; shippedAt: number | null; receivedAt: number | null; cancelledAt: number | null }>(sql`
    SELECT id, ref, status, from_location_id AS fromId, to_location_id AS toId, notes, requested_by AS requestedBy, shipped_by AS shippedBy, received_by AS receivedBy,
           created_at AS createdAt, shipped_at AS shippedAt, received_at AS receivedAt, cancelled_at AS cancelledAt
    FROM stock_transfers WHERE id = ${transferId}`);
  const transfer = transfers[0];
  if (!transfer) throw notFound("transfer");
  const [items, tree, lostRows, reasonRows] = await Promise.all([
    db.all<{ id: string; variantId: string; qty: number; qtyReceived: number; serialId: string | null; serial: string | null; serialStatus: string | null }>(sql`
      SELECT i.id AS id, i.variant_id AS variantId, i.qty AS qty, i.qty_received AS qtyReceived, i.serial_id AS serialId, s.serial AS serial, s.status AS serialStatus
      FROM stock_transfer_items AS i LEFT JOIN serials AS s ON s.id = i.serial_id WHERE i.transfer_id = ${transferId} ORDER BY i.id`),
    locationTree(db),
    db.all<{ n: number }>(sql`SELECT coalesce(sum(-qty_delta), 0) AS n FROM stock_movements WHERE ref_type = 'transfer' AND ref_id = ${transferId} AND kind = 'damage'`),
    db.all<{ reason: string | null }>(sql`SELECT reason FROM audit_events WHERE entity_type = 'stock_transfer' AND entity_id = ${transferId} AND action IN ('inventory.transfer.cancel', 'inventory.transfer.shortfall') ORDER BY seq DESC LIMIT 1`),
  ]);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const loc = (id: string) => ({ id, code: byId.get(id)?.code ?? id, name: byId.get(id)?.name ?? "", path: byId.get(id)?.path ?? id });
  const [labels, names] = await Promise.all([variantLabels(db, items.map((item) => item.variantId), locale), employeeNames(db, [transfer.requestedBy, transfer.shippedBy, transfer.receivedBy])]);
  const view: TransferView = {
    id: transfer.id,
    ref: transfer.ref,
    status: transfer.status,
    from: loc(transfer.fromId),
    to: loc(transfer.toId),
    notes: transfer.notes,
    items: items.map((item) => {
      const row: TransferItemView = {
        id: item.id,
        variant: labels.get(item.variantId) ?? { id: item.variantId, sku: item.variantId, barcode: null, name: item.variantId, productName: item.variantId, variantTitle: "", trackSerials: false, isActive: false },
        qty: item.qty,
        qtyReceived: item.qtyReceived,
        serialId: item.serialId,
      };
      if (withSerials) {
        row.serial = item.serial;
        row.serialStatus = item.serialStatus;
      }
      return row;
    }),
    people: {
      requestedBy: transfer.requestedBy ? (names.get(transfer.requestedBy) ?? null) : null,
      shippedBy: transfer.shippedBy ? (names.get(transfer.shippedBy) ?? null) : null,
      receivedBy: transfer.receivedBy ? (names.get(transfer.receivedBy) ?? null) : null,
    },
    times: { createdAt: transfer.createdAt, shippedAt: transfer.shippedAt, receivedAt: transfer.receivedAt, cancelledAt: transfer.cancelledAt },
    units: items.reduce((sum, item) => sum + item.qty, 0),
    unitsReceived: items.reduce((sum, item) => sum + item.qtyReceived, 0),
    unitsLost: Number(lostRows[0]?.n ?? 0),
    closingReason: reasonRows[0]?.reason ?? null,
  };
  if (can(actor, "cost.read")) {
    const value = await db.all<{ value: number | null; unknown: number }>(sql`
      SELECT sum(-qty_delta * unit_cost_iqd) AS value, sum(CASE WHEN unit_cost_iqd IS NULL THEN 1 ELSE 0 END) AS unknown
      FROM stock_movements WHERE ref_type = 'transfer' AND ref_id = ${transferId} AND kind = 'transfer_out'`);
    view.valueIqd = transfer.status === "draft" || transfer.status === "cancelled" ? null : Number(value[0]?.unknown ?? 0) > 0 ? null : Number(value[0]?.value ?? 0);
    // The shortfall dialog's financial impact: the value of what would be written off, not of the whole transfer.
    if (transfer.status === "in_transit" && view.unitsReceived < view.units) view.shortfallValueIqd = (await shortfallValue(db, actor, transfer.id)).valueIqd;
  }
  return view;
}

/**
 * Turns the "SKU and quantity per line" text of the new-transfer form into lines: "PS5-SLIM 3", "PS5-SLIM ×3" or a
 * scanned code alone (one unit; scanning it again adds one). Codes are SKUs (any case) or barcodes. Unknown codes →
 * AppError("transfer_unknown_codes", 400) with the codes in `detail`.
 */
export async function resolveTransferLines(db: Db, raw: string): Promise<{ variantId: string; qty: number }[]> {
  const wanted = new Map<string, number>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\S+?)(?:\s*[x×*]\s*|\s+)(\d{1,6})$/i.exec(trimmed);
    const code = (match ? match[1] : trimmed).slice(0, 100);
    const qty = match ? Number(match[2]) : 1;
    wanted.set(code, (wanted.get(code) ?? 0) + qty);
  }
  if (wanted.size === 0) throw new AppError("invalid", 400, { fields: { lines: "required" } });
  const codes = [...wanted.keys()];
  const rows = await db.all<{ id: string; sku: string; barcode: string | null }>(sql`
    SELECT id, sku, barcode FROM variants WHERE upper(sku) IN (SELECT upper(value) FROM json_each(${JSON.stringify(codes)})) OR barcode IN (SELECT value FROM json_each(${JSON.stringify(codes)}))`);
  const unknown: string[] = [];
  const out = new Map<string, number>();
  for (const [code, qty] of wanted) {
    const row = rows.find((candidate) => candidate.sku.toUpperCase() === code.toUpperCase()) ?? rows.find((candidate) => candidate.barcode === code);
    if (!row) unknown.push(code);
    else out.set(row.id, (out.get(row.id) ?? 0) + qty);
  }
  if (unknown.length > 0) throw new AppError("transfer_unknown_codes", 400, { fields: { lines: "transfer_unknown_codes" }, detail: unknown.slice(0, 20).join(", ") });
  return [...out].map(([variantId, qty]) => ({ variantId, qty }));
}

/** Serial numbers in stock at a location for the given variants (the ship form's suggestions) — serial.read only. */
export async function serialsAvailableAt(db: Db, actor: Actor, locationId: string, variantIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!can(actor, "inventory.serial.read") || variantIds.length === 0) return out;
  const rows = await db.all<{ variantId: string; serial: string }>(sql`
    SELECT s.variant_id AS variantId, s.serial AS serial FROM serials AS s
    WHERE s.location_id = ${locationId} AND s.status = 'in_stock' AND s.variant_id IN (SELECT value FROM json_each(${JSON.stringify([...variantIds])}))
      AND NOT EXISTS (SELECT 1 FROM used_units AS u WHERE u.serial_id = s.id)
    ORDER BY s.serial LIMIT 500`);
  for (const row of rows) {
    const list = out.get(row.variantId) ?? [];
    list.push(row.serial);
    out.set(row.variantId, list);
  }
  return out;
}

/** What a location can send: variants with free stock there (for the new-transfer form). */
export async function transferableAt(db: Db, actor: Actor, locationId: string, locale: Locale, q: string): Promise<{ variant: VariantLabel; free: number }[]> {
  assertCan(actor, "inventory.stock.read");
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db.all<{ variantId: string; free: number }>(sql`
    SELECT s.variant_id AS variantId, s.on_hand - s.reserved AS free FROM stock_levels AS s JOIN variants AS v ON v.id = s.variant_id JOIN products AS p ON p.id = v.product_id
    WHERE s.location_id = ${locationId} AND s.on_hand - s.reserved > 0
      AND (${q} = '' OR v.sku LIKE ${like} ESCAPE '\\' OR json_extract(p.name, '$.ar') LIKE ${like} ESCAPE '\\' OR json_extract(p.name, '$.en') LIKE ${like} ESCAPE '\\' OR v.barcode = ${q})
    ORDER BY v.sku LIMIT 60`);
  const labels = await variantLabels(db, rows.map((row) => row.variantId), locale);
  return rows.flatMap((row) => {
    const variant = labels.get(row.variantId);
    return variant ? [{ variant, free: Number(row.free) }] : [];
  });
}
