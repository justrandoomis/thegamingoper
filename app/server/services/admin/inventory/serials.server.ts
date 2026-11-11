/**
 * Admin module 04 — serial numbers: find a unit and read its whole history (supports 04.03 scanning and blueprint
 * acceptance #1, "no single serial is sold twice").
 *
 *   const page = await findSerials(db, actor, { q: "S01F…", status: "in_stock", page: 1 }, locale);
 *   const unit = await getSerialHistory(db, actor, serialId, locale);
 *
 * Serial numbers are private: everything here needs inventory.serial.read (and inventory.stock.read). A serial's cost
 * [P] is returned only for cost.read, its movements only for inventory.movement.read (the log's permission). The
 * history shows every movement of the unit and every order line it was
 * attached to — at most one attachment is ever open (order_item_serials.serial_id is unique while not released, and
 * the serials_status_guard trigger lets a unit become 'sold' only from in_stock or reserved).
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { SERIAL_STATUSES, type SerialStatus } from "~/server/db/schema";
import { notFound } from "~/server/errors";
import { PAGE_SIZE, cleanQuery, labelOf, likePattern, locationTree, pageOf, type VariantLabel } from "./shared.server";
import { movementSelect, movementViews, type MovementRow, type MovementView } from "./stock.server";

export type SerialFilters = { q: string; status: SerialStatus | null; location: string | null; page: number };

export function parseSerialFilters(params: URLSearchParams): SerialFilters {
  const status = params.get("status") as SerialStatus | null;
  return {
    q: cleanQuery(params.get("q")),
    status: status && (SERIAL_STATUSES as readonly string[]).includes(status) ? status : null,
    location: params.get("location")?.match(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) ? params.get("location") : null,
    page: pageOf(params.get("page")),
  };
}

export type SerialRow = { id: string; serial: string; status: SerialStatus; variant: VariantLabel; locationCode: string | null; source: string; usedUnit: boolean; orderRef: string | null; transferRef: string | null; updatedAt: number };

type LabelRow = { id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number };

export async function findSerials(db: Db, actor: Actor, filters: SerialFilters, locale: Locale): Promise<{ rows: SerialRow[]; total: number; page: number; pageCount: number; counts: Record<string, number> }> {
  assertCan(actor, "inventory.stock.read");
  assertCan(actor, "inventory.serial.read");
  const parts = [] as ReturnType<typeof sql>[];
  if (filters.q) parts.push(sql`(s.serial LIKE ${likePattern(filters.q)} ESCAPE '\\' OR v.sku LIKE ${likePattern(filters.q)} ESCAPE '\\')`);
  if (filters.status) parts.push(sql`s.status = ${filters.status}`);
  if (filters.location) parts.push(sql`s.location_id = ${filters.location}`);
  const where = parts.length ? sql.join(parts, sql` AND `) : sql`1 = 1`;
  const [rows, totals, counts, tree] = await Promise.all([
    db.all<LabelRow & { serialId: string; serial: string; status: SerialStatus; locationId: string | null; source: string; usedUnitId: string | null; orderRef: string | null; transferRef: string | null; updatedAt: number }>(sql`
      SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive,
             s.id AS serialId, s.serial AS serial, s.status AS status, s.location_id AS locationId, s.source AS source, u.id AS usedUnitId,
             (SELECT o.ref FROM order_item_serials AS ois JOIN order_items AS oi ON oi.id = ois.order_item_id JOIN orders AS o ON o.id = oi.order_id WHERE ois.serial_id = s.id AND ois.released_at IS NULL LIMIT 1) AS orderRef,
             (SELECT t.ref FROM stock_transfer_items AS i JOIN stock_transfers AS t ON t.id = i.transfer_id WHERE i.serial_id = s.id AND t.status = 'in_transit' LIMIT 1) AS transferRef,
             s.updated_at AS updatedAt
      FROM serials AS s JOIN variants AS v ON v.id = s.variant_id JOIN products AS p ON p.id = v.product_id LEFT JOIN used_units AS u ON u.serial_id = s.id
      WHERE ${where} ORDER BY s.updated_at DESC, s.serial LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM serials AS s JOIN variants AS v ON v.id = s.variant_id WHERE ${where}`),
    db.all<{ status: string; n: number }>(sql`SELECT status, count(*) AS n FROM serials GROUP BY status`),
    locationTree(db),
  ]);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const total = Number(totals[0]?.n ?? 0);
  return {
    rows: rows.map((row) => ({
      id: row.serialId,
      serial: row.serial,
      status: row.status,
      variant: labelOf(row, locale),
      locationCode: row.locationId ? (byId.get(row.locationId)?.code ?? row.locationId) : null,
      source: row.source,
      usedUnit: row.usedUnitId !== null,
      orderRef: row.orderRef,
      transferRef: row.transferRef,
      updatedAt: row.updatedAt,
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.n)])),
  };
}

export type SerialHistory = {
  serial: SerialRow & { createdAt: number; notes: string | null; sourceRef: string | null };
  attachments: { orderRef: string; orderStatus: string; attachedAt: number; releasedAt: number | null }[];
  /** The unit's rows of the movement log: present only with inventory.movement.read. */
  movements?: MovementView[];
  /** [P] cost.read only */
  costIqd?: number | null;
};

export async function getSerialHistory(db: Db, actor: Actor, serialId: string, locale: Locale): Promise<SerialHistory> {
  assertCan(actor, "inventory.stock.read");
  assertCan(actor, "inventory.serial.read");
  const rows = await db.all<LabelRow & { serialId: string; serial: string; status: SerialStatus; locationId: string | null; source: string; sourceRef: string | null; notes: string | null; usedUnitId: string | null; createdAt: number; updatedAt: number; costIqd: number | null }>(sql`
    SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive,
           s.id AS serialId, s.serial AS serial, s.status AS status, s.location_id AS locationId, s.source AS source, s.source_ref AS sourceRef, s.notes AS notes,
           u.id AS usedUnitId, s.created_at AS createdAt, s.updated_at AS updatedAt, s.cost_iqd AS costIqd
    FROM serials AS s JOIN variants AS v ON v.id = s.variant_id JOIN products AS p ON p.id = v.product_id LEFT JOIN used_units AS u ON u.serial_id = s.id
    WHERE s.id = ${serialId}`);
  const row = rows[0];
  if (!row) throw notFound("serial");
  // The movement log (reasons, who did what) is inventory.movement.read's, also for one unit.
  const withMovements = can(actor, "inventory.movement.read");
  const [attachments, movementRows, transferRows, tree] = await Promise.all([
    db.all<{ orderRef: string; orderStatus: string; attachedAt: number; releasedAt: number | null }>(sql`
      SELECT o.ref AS orderRef, o.status AS orderStatus, ois.attached_at AS attachedAt, ois.released_at AS releasedAt
      FROM order_item_serials AS ois JOIN order_items AS oi ON oi.id = ois.order_item_id JOIN orders AS o ON o.id = oi.order_id
      WHERE ois.serial_id = ${serialId} ORDER BY ois.attached_at`),
    withMovements ? db.all<MovementRow>(movementSelect(sql`m.serial_id = ${serialId}`, 200)) : Promise.resolve([] as MovementRow[]),
    db.all<{ ref: string }>(sql`SELECT t.ref AS ref FROM stock_transfer_items AS i JOIN stock_transfers AS t ON t.id = i.transfer_id WHERE i.serial_id = ${serialId} AND t.status = 'in_transit' LIMIT 1`),
    locationTree(db),
  ]);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const withCost = can(actor, "cost.read");
  const history: SerialHistory = {
    serial: {
      id: row.serialId,
      serial: row.serial,
      status: row.status,
      variant: labelOf(row, locale),
      locationCode: row.locationId ? (byId.get(row.locationId)?.code ?? row.locationId) : null,
      source: row.source,
      usedUnit: row.usedUnitId !== null,
      orderRef: attachments.find((entry) => entry.releasedAt === null)?.orderRef ?? null,
      transferRef: transferRows[0]?.ref ?? null,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      notes: row.notes,
      sourceRef: row.sourceRef,
    },
    attachments,
  };
  if (withMovements) history.movements = await movementViews(db, [...movementRows].reverse(), { withCost, withSerials: true, byId });
  if (withCost) history.costIqd = row.costIqd;
  return history;
}
