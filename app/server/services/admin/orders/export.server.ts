/**
 * CSV export of the filtered order list (orders.order.export) — the same filters as the list (URL state).
 *
 * Blueprint acceptance #5: cost and margin columns EXIST only for cost.read (and profit.read for the margin): for anyone
 * else they are not in the file at all, not even as empty columns. Phones are masked without customer.phone.read_full.
 * Every export is audited (who, which filters, how many rows). At most 5,000 rows; cells that could start a formula
 * in a spreadsheet are neutralised.
 */
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { governorates, orderItems, orders } from "~/server/db/schema";
import { listWhere } from "./list.server";
import { phoneFor } from "./shared.server";
import type { OrderListFilters } from "./types";

export const EXPORT_LIMIT = 5000;

const BAGHDAD_OFFSET = 3 * 60 * 60 * 1000;
const baghdad = (ms: number) => new Date(ms + BAGHDAD_OFFSET).toISOString().slice(0, 16).replace("T", " ");

/** One CSV cell: quoted, and a leading = + - @ (a spreadsheet formula) defused with an apostrophe. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export type ExportHeaders = Record<string, string>;

/** The CSV text (UTF-8 with BOM so spreadsheet programs read Arabic correctly) and its row count. */
export async function exportOrdersCsv(db: Db, actor: Actor, filters: OrderListFilters, headers: ExportHeaders, locale: Locale, now: number): Promise<{ csv: string; rows: number }> {
  assertCan(actor, "orders.order.export");
  const withCost = can(actor, "cost.read");
  const withMargin = withCost && can(actor, "profit.read");
  const where = listWhere(filters, actor, now);
  const order = filters.sort === "placed_asc" ? [asc(orders.placedAt)] : filters.sort === "total_desc" ? [desc(orders.totalIqd)] : filters.sort === "total_asc" ? [asc(orders.totalIqd)] : [desc(orders.placedAt)];
  const rows = await db
    .select({
      id: orders.id,
      ref: orders.ref,
      placedAt: orders.placedAt,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentMethod: orders.paymentMethod,
      governorate: governorates.name,
      contactName: orders.contactName,
      phone: orders.contactPhoneE164,
      subtotalIqd: orders.subtotalIqd,
      discountIqd: orders.discountIqd,
      shippingIqd: orders.shippingIqd,
      totalIqd: orders.totalIqd,
      paidIqd: orders.paidIqd,
      refundedIqd: orders.refundedIqd,
      isDemo: orders.isDemo,
      units: sql<number>`(SELECT coalesce(sum(oi.qty), 0) FROM order_items oi WHERE oi.order_id = ${orders.id})`,
    })
    .from(orders)
    .leftJoin(governorates, eq(governorates.id, orders.governorateId))
    .where(where)
    .orderBy(...order)
    .limit(EXPORT_LIMIT);

  // [P] the cost of each order's lines (snapshot at sale) — selected only for cost.read.
  const costs = new Map<string, number | null>();
  if (withCost && rows.length) {
    for (let i = 0; i < rows.length; i += 90) {
      const ids = rows.slice(i, i + 90).map((row) => row.id);
      const costRows = await db
        .select({
          orderId: orderItems.orderId,
          cost: sql<number>`coalesce(sum(${orderItems.costSnapshotIqd} * ${orderItems.qty}), 0)`,
          unknown: sql<number>`sum(CASE WHEN ${orderItems.costSnapshotIqd} IS NULL THEN 1 ELSE 0 END)`,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids))
        .groupBy(orderItems.orderId);
      for (const row of costRows) costs.set(row.orderId, Number(row.unknown) > 0 ? null : Number(row.cost));
    }
  }

  const columns = ["ref", "placedAt", "status", "paymentStatus", "paymentMethod", "governorate", "contactName", "phone", "units", "subtotalIqd", "discountIqd", "shippingIqd", "totalIqd", "paidIqd", "refundedIqd", "demo"];
  if (withCost) columns.push("costIqd");
  if (withMargin) columns.push("marginIqd");
  const lines = [columns.map((key) => csvCell(headers[key] ?? key)).join(",")];
  for (const row of rows) {
    const cost = withCost ? (costs.get(row.id) ?? null) : undefined;
    const cells: (string | number | null)[] = [
      row.ref,
      baghdad(row.placedAt),
      row.status,
      row.paymentStatus,
      row.paymentMethod,
      row.governorate ? pick(row.governorate, locale) : null,
      row.contactName,
      phoneFor(actor, row.phone)?.display ?? null,
      Number(row.units),
      row.subtotalIqd,
      row.discountIqd,
      row.shippingIqd,
      row.totalIqd,
      row.paidIqd,
      row.refundedIqd,
      row.isDemo ? 1 : 0,
    ];
    // An unknown cost is an empty cell, never a zero (a financial error is not hidden behind 0). A cancelled or
    // returned order sold nothing: its margin cell is empty too (not a loss of its whole cost).
    if (withCost) cells.push(cost ?? null);
    if (withMargin) cells.push(cost === null || cost === undefined || row.status === "cancelled" || row.status === "returned" ? null : row.subtotalIqd - row.discountIqd - row.refundedIqd - cost);
    lines.push(cells.map(csvCell).join(","));
  }
  await audit(db, {
    actor,
    action: "orders.order.export",
    entityType: "order",
    summary: `${rows.length} orders exported`,
    after: { rows: rows.length, filters: { ...filters, q: filters.q ? "[set]" : "" }, withCost, withMargin },
    at: now,
  });
  return { csv: `﻿${lines.join("\r\n")}\r\n`, rows: rows.length };
}
