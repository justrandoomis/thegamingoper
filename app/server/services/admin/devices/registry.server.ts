/**
 * Admin module 13 — the device registry (13.01): every serial-numbered unit the store has had, by serial number,
 * condition (new, or used with its grade) and where it came from (a supplier's receipt, a trade-in, the demo seed),
 * with its status, location and the order it was sold on.
 *
 *   const page = await listRegistry(db, actor, parseRegistryFilters(url.searchParams), locale);
 *   const unit = await getRegistryDetail(db, actor, serialId, locale);
 *
 * Needs devices.registry.read. Serial numbers are private: this is a staff screen, never a public page. A unit's cost
 * [P] (`serials.cost_iqd`, the movements' unit cost) only with cost.read; its stock movements only with
 * inventory.movement.read (the movement log's own permission). A serial is sold once (the database: a unique link per
 * open sale, a guarded status) — the registry shows which order holds it.
 */
import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import {
  inventoryLocations,
  orderItemSerials,
  orderItems,
  orders,
  products,
  purchaseOrders,
  receiptItems,
  receipts,
  serials,
  stockMovements,
  suppliers,
  tradeIns,
  usedUnits,
  variants,
  warranties,
} from "~/server/db/schema";
import { notFound } from "~/server/errors";
import { ID, PAGE_SIZE, likePattern, variantLabel } from "./shared.server";
import { latinDigits, type RegistryDetail, type RegistryFilters, type RegistryPage, type RegistryRow, type RegistrySource } from "./types";

const DEMO_REF = "demo_seed";

type Row = {
  id: string;
  serial: string;
  status: RegistryRow["status"];
  source: "purchase" | "trade_in";
  sourceRef: string | null;
  notes: string | null;
  costIqd: number | null;
  createdAt: number;
  updatedAt: number;
  sku: string;
  title: unknown;
  name: unknown;
  location: string | null;
  usedUnitId: string | null;
  usedGrade: RegistryRow["grade"];
  usedStatus: string | null;
  usedSlug: string | null;
  orderRef: string | null;
};

const ORDER_REF = sql<string | null>`(SELECT o.ref FROM order_item_serials AS ois JOIN order_items AS oi ON oi.id = ois.order_item_id JOIN orders AS o ON o.id = oi.order_id WHERE ois.serial_id = ${serials.id} AND ois.released_at IS NULL LIMIT 1)`;
/** The used unit a serial belongs to now (the newest, when the store bought the same unit back more than once). */
const USED_ID = sql<string | null>`(SELECT u.id FROM used_units AS u WHERE u.serial_id = ${serials.id} ORDER BY u.created_at DESC LIMIT 1)`;

function selectRows(db: Db) {
  return db
    .select({
      id: serials.id,
      serial: serials.serial,
      status: serials.status,
      source: serials.source,
      sourceRef: serials.sourceRef,
      notes: serials.notes,
      costIqd: serials.costIqd,
      createdAt: serials.createdAt,
      updatedAt: serials.updatedAt,
      sku: variants.sku,
      title: variants.title,
      name: products.name,
      location: inventoryLocations.code,
      usedUnitId: USED_ID,
      orderRef: ORDER_REF,
    })
    .from(serials)
    .innerJoin(variants, eq(variants.id, serials.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(inventoryLocations, eq(inventoryLocations.id, serials.locationId));
}

/** Where each unit came from: the receipt (and its order and supplier), the trade-in, or the demo seed. */
async function sourcesOf(db: Db, rows: readonly { source: string; sourceRef: string | null }[]): Promise<Map<string, RegistrySource>> {
  const out = new Map<string, RegistrySource>();
  const receiptRefs = [...new Set(rows.filter((row) => row.source === "purchase" && row.sourceRef && row.sourceRef !== DEMO_REF).map((row) => row.sourceRef as string))].filter((ref) => ID.test(ref));
  const tradeRefs = [...new Set(rows.filter((row) => row.source === "trade_in" && row.sourceRef && row.sourceRef !== DEMO_REF).map((row) => row.sourceRef as string))].filter((ref) => ID.test(ref));
  if (receiptRefs.length > 0) {
    for (let i = 0; i < receiptRefs.length; i += 80) {
      const chunk = receiptRefs.slice(i, i + 80);
      const found = await db
        .select({ id: receiptItems.id, receiptRef: receipts.ref, poRef: purchaseOrders.ref, supplier: suppliers.name })
        .from(receiptItems)
        .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
        .leftJoin(purchaseOrders, eq(purchaseOrders.id, receipts.poId))
        .leftJoin(suppliers, eq(suppliers.id, receipts.supplierId))
        .where(inArray(receiptItems.id, chunk));
      for (const row of found) out.set(`purchase|${row.id}`, { kind: "receipt", receiptRef: row.receiptRef, poRef: row.poRef ?? null, supplier: row.supplier ?? null });
    }
  }
  if (tradeRefs.length > 0) {
    const found = await db.select({ id: tradeIns.id, ref: tradeIns.ref }).from(tradeIns).where(inArray(tradeIns.id, tradeRefs.slice(0, 90)));
    for (const row of found) out.set(`trade_in|${row.id}`, { kind: "trade_in", tradeInRef: row.ref });
  }
  for (const row of rows) {
    const key = `${row.source}|${row.sourceRef}`;
    if (out.has(key)) continue;
    if (row.sourceRef === DEMO_REF) out.set(key, { kind: "opening", note: "demo" });
    else if (row.source === "trade_in") out.set(key, { kind: "trade_in", tradeInRef: null });
    else out.set(key, { kind: "other", ref: row.sourceRef });
  }
  return out;
}

async function usedOf(db: Db, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const out = new Map<string, { grade: RegistryRow["grade"]; status: string; slug: string }>();
  if (wanted.length === 0) return out;
  const rows = await db.select({ id: usedUnits.id, grade: usedUnits.grade, status: usedUnits.status, slug: usedUnits.slug }).from(usedUnits).where(inArray(usedUnits.id, wanted));
  for (const row of rows) out.set(row.id, { grade: row.grade, status: row.status, slug: row.slug });
  return out;
}

export async function listRegistry(db: Db, actor: Actor, filters: RegistryFilters, locale: Locale): Promise<RegistryPage> {
  assertCan(actor, "devices.registry.read");
  const withCost = can(actor, "cost.read");
  const where: SQL[] = [];
  if (filters.status) where.push(eq(serials.status, filters.status));
  if (filters.source) where.push(eq(serials.source, filters.source));
  if (filters.condition === "used") where.push(sql`EXISTS (SELECT 1 FROM used_units AS u WHERE u.serial_id = ${serials.id})`);
  if (filters.condition === "new") where.push(sql`NOT EXISTS (SELECT 1 FROM used_units AS u WHERE u.serial_id = ${serials.id})`);
  if (filters.q) {
    const upper = latinDigits(filters.q).toUpperCase().replace(/\s+/g, "");
    where.push(
      or(
        sql`upper(replace(${serials.serial}, ' ', '')) LIKE ${likePattern(upper)} ESCAPE '\\'`,
        sql`${variants.sku} LIKE ${likePattern(filters.q)} ESCAPE '\\'`,
        sql`${products.name} LIKE ${likePattern(filters.q)} ESCAPE '\\'`,
        sql`${serials.sourceRef} IN (SELECT id FROM trade_ins WHERE ref = ${filters.q.toUpperCase()})`,
      ) as SQL,
    );
  }
  const condition = where.length ? and(...where) : undefined;
  const [rows, totals, used] = await Promise.all([
    selectRows(db)
      .where(condition)
      .orderBy(desc(serials.updatedAt), asc(serials.serial))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(serials).innerJoin(variants, eq(variants.id, serials.variantId)).innerJoin(products, eq(products.id, variants.productId)).where(condition),
    db.all<{ used: number; total: number }>(sql`SELECT (SELECT count(DISTINCT serial_id) FROM used_units WHERE serial_id IS NOT NULL) AS used, (SELECT count(*) FROM serials) AS total`),
  ]);
  const sources = await sourcesOf(db, rows);
  const units = await usedOf(db, rows.map((row) => row.usedUnitId));
  const total = Number(totals[0]?.n ?? 0);
  const usedCount = Number(used[0]?.used ?? 0);
  return {
    rows: rows.map((row) => toRow(row as unknown as Row, sources, units, withCost, locale)),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    withCost,
    counts: { used: usedCount, new: Math.max(0, Number(used[0]?.total ?? 0) - usedCount) },
  };
}

function toRow(row: Row, sources: Map<string, RegistrySource>, units: Map<string, { grade: RegistryRow["grade"]; status: string; slug: string }>, withCost: boolean, locale: Locale): RegistryRow {
  const unit = row.usedUnitId ? units.get(row.usedUnitId) : undefined;
  const out: RegistryRow = {
    id: row.id,
    serial: row.serial,
    name: variantLabel(row.name, row.title, locale),
    sku: row.sku,
    status: row.status,
    condition: unit ? "used" : "new",
    grade: unit?.grade ?? null,
    usedUnitId: row.usedUnitId,
    source: sources.get(`${row.source}|${row.sourceRef}`) ?? { kind: "other", ref: row.sourceRef },
    location: row.location,
    orderRef: row.orderRef,
    updatedAt: row.updatedAt,
  };
  if (withCost) out.costIqd = row.costIqd;
  return out;
}

export async function getRegistryDetail(db: Db, actor: Actor, serialId: string, locale: Locale): Promise<RegistryDetail> {
  assertCan(actor, "devices.registry.read");
  if (!ID.test(serialId)) throw notFound("serial");
  const withCost = can(actor, "cost.read");
  const row = (await selectRows(db).where(eq(serials.id, serialId)).get()) as unknown as Row | undefined;
  if (!row) throw notFound("serial");
  const [sources, units, trades, attachments, warrantyRows, movementRows] = await Promise.all([
    sourcesOf(db, [row]),
    usedOf(db, [row.usedUnitId]),
    db
      .select({ ref: tradeIns.ref, status: tradeIns.status, at: tradeIns.createdAt })
      .from(tradeIns)
      .where(or(eq(tradeIns.serialId, row.id), sql`json_extract(${tradeIns.inspection}, '$.serial') = ${row.serial.toUpperCase().replace(/\s+/g, "")}`))
      .orderBy(desc(tradeIns.createdAt))
      .limit(20),
    db
      .select({ ref: orders.ref, attachedAt: orderItemSerials.attachedAt, releasedAt: orderItemSerials.releasedAt })
      .from(orderItemSerials)
      .innerJoin(orderItems, eq(orderItems.id, orderItemSerials.orderItemId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(orderItemSerials.serialId, row.id))
      .orderBy(desc(orderItemSerials.attachedAt))
      .limit(20),
    db.select({ id: warranties.id, status: warranties.status, endsAt: warranties.endsAt }).from(warranties).where(eq(warranties.serialId, row.id)).orderBy(desc(warranties.endsAt)).limit(20),
    can(actor, "inventory.movement.read")
      ? db
          .select({ id: stockMovements.id, kind: stockMovements.kind, qtyDelta: stockMovements.qtyDelta, refType: stockMovements.refType, refId: stockMovements.refId, at: stockMovements.at, location: inventoryLocations.code, unitCostIqd: stockMovements.unitCostIqd })
          .from(stockMovements)
          .leftJoin(inventoryLocations, eq(inventoryLocations.id, stockMovements.locationId))
          .where(eq(stockMovements.serialId, row.id))
          .orderBy(desc(stockMovements.at))
          .limit(50)
      : Promise.resolve(null),
  ]);
  const unit = row.usedUnitId ? units.get(row.usedUnitId) : undefined;
  const detail: RegistryDetail = {
    ...toRow(row, sources, units, withCost, locale),
    createdAt: row.createdAt,
    notes: row.notes,
    usedUnit: unit && row.usedUnitId ? { id: row.usedUnitId, slug: unit.slug, status: unit.status as never, grade: unit.grade as never } : null,
    tradeIns: trades,
    orders: attachments,
    warranties: warrantyRows,
  };
  if (movementRows) {
    detail.movements = movementRows.map((movement) => {
      const { unitCostIqd, ...rest } = movement;
      return withCost ? { ...rest, unitCostIqd } : rest;
    });
  }
  return detail;
}

void isNull;
