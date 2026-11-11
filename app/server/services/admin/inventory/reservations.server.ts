/**
 * Admin module 04 — stock held for orders (04.08): every reservation with its order, its expiry (unpaid transfer
 * orders) or "held until shipped or cancelled", and a manual release.
 *
 *   const page = await listReservations(db, actor, parseReservationFilters(url.searchParams), locale, now);
 *   await releaseReservationsOfOrder(db, actor, { orderId, reason }, now);
 *
 * Expiry is automatic: the scheduled job `inventory.reservations.expire` (every 5 minutes, app/server/jobs.server.ts)
 * releases holds whose time has passed, and `orders.expire_unpaid` cancels transfer orders whose proof never came.
 * A manual release goes through the commerce core's releaseOrderReservations (stock back to available, 'release'
 * movements, the order's used devices back on sale, an audit event) and is refused for orders being packed or
 * already gone (`release_not_allowed`): their stock is tied to packed serials or has left — checked again inside the
 * release's batch, so packing that starts meanwhile wins. The order keeps its status — an order that will not be
 * fulfilled is cancelled in the orders module. Needs inventory.reservation.release and a reason; an employee limited
 * to a branch releases only stock held at that branch's locations.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Locale } from "~/lib/locales";
import { assertBranch, assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { listJobRuns } from "~/server/jobs.server";
import { releaseOrderReservationsStatements } from "~/server/services/inventory/stock.server";
import { PAGE_SIZE, cleanQuery, locationTree, pageOf, variantLabels, type VariantLabel } from "./shared.server";

export const RESERVATION_ERROR_KEYS = ["release_not_allowed", "nothing_to_release"] as const;
/** Orders whose stock may be released by hand: not yet packed. */
export const RELEASABLE_ORDER_STATUSES = ["new", "awaiting_payment", "payment_review", "confirmed"] as const;

export const RESERVATION_STATUS_FILTERS = ["active", "expiring", "expired", "released", "committed", "all"] as const;
export type ReservationStatusFilter = (typeof RESERVATION_STATUS_FILTERS)[number];
export type ReservationFilters = { status: ReservationStatusFilter; q: string; page: number };

export function parseReservationFilters(params: URLSearchParams): ReservationFilters {
  const status = params.get("status") as ReservationStatusFilter | null;
  return { status: status && RESERVATION_STATUS_FILTERS.includes(status) ? status : "active", q: cleanQuery(params.get("q")), page: pageOf(params.get("page")) };
}

/** "Expiring soon" = an active hold that ends within this window. */
export const EXPIRING_WINDOW_MS = 60 * 60 * 1000;

export type ReservationRow = {
  id: string;
  orderId: string;
  orderRef: string;
  orderStatus: string;
  paymentMethod: string;
  variant: VariantLabel | null;
  variantId: string;
  locationCode: string;
  qty: number;
  status: "active" | "committed" | "released" | "expired";
  createdAt: number;
  expiresAt: number | null;
  releasedAt: number | null;
  releasable: boolean;
};

export type ReservationPage = {
  rows: ReservationRow[];
  total: number;
  page: number;
  pageCount: number;
  summary: { active: number; units: number; expiring: number; held: number };
  /**
   * Units each order on this page holds now, across all its active reservations and locations — what a manual release
   * returns to available (the release dialog's impact), whatever the page's filter or paging shows of the order.
   */
  orderUnits: Record<string, number>;
  /** The last run of the expiry job (ops.job.read only). */
  lastExpiryRun?: { status: string; startedAt: number; finishedAt: number | null; released: number | null } | null;
};

export async function listReservations(db: Db, actor: Actor, filters: ReservationFilters, locale: Locale, now: number): Promise<ReservationPage> {
  assertCan(actor, "inventory.stock.read");
  const parts = [] as ReturnType<typeof sql>[];
  switch (filters.status) {
    case "active":
      parts.push(sql`r.status = 'active'`);
      break;
    case "expiring":
      parts.push(sql`r.status = 'active' AND r.expires_at IS NOT NULL AND r.expires_at <= ${now + EXPIRING_WINDOW_MS}`);
      break;
    case "all":
      break;
    default:
      parts.push(sql`r.status = ${filters.status}`);
  }
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    parts.push(sql`(o.ref = upper(${filters.q}) OR r.variant_id IN (SELECT id FROM variants WHERE sku LIKE ${like} ESCAPE '\\'))`);
  }
  const where = parts.length ? sql.join(parts, sql` AND `) : sql`1 = 1`;
  const [rows, totals, summary, tree] = await Promise.all([
    db.all<{ id: string; orderId: string; orderRef: string; orderStatus: string; paymentMethod: string; variantId: string; locationId: string; qty: number; status: ReservationRow["status"]; createdAt: number; expiresAt: number | null; releasedAt: number | null }>(sql`
      SELECT r.id AS id, r.order_id AS orderId, o.ref AS orderRef, o.status AS orderStatus, o.payment_method AS paymentMethod, r.variant_id AS variantId, r.location_id AS locationId,
             r.qty AS qty, r.status AS status, r.created_at AS createdAt, r.expires_at AS expiresAt, r.released_at AS releasedAt
      FROM stock_reservations AS r JOIN orders AS o ON o.id = r.order_id
      WHERE ${where}
      ORDER BY CASE WHEN r.status = 'active' AND r.expires_at IS NOT NULL THEN 0 ELSE 1 END, coalesce(r.expires_at, r.created_at), r.id
      LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM stock_reservations AS r JOIN orders AS o ON o.id = r.order_id WHERE ${where}`),
    db.all<{ active: number; units: number; expiring: number; held: number }>(sql`
      SELECT count(*) AS active, coalesce(sum(qty), 0) AS units,
             sum(CASE WHEN expires_at IS NOT NULL AND expires_at <= ${now + EXPIRING_WINDOW_MS} THEN 1 ELSE 0 END) AS expiring,
             sum(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) AS held
      FROM stock_reservations WHERE status = 'active'`),
    locationTree(db),
  ]);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const orderIds = [...new Set(rows.map((row) => row.orderId))];
  const [labels, unitRows] = await Promise.all([
    variantLabels(db, rows.map((row) => row.variantId), locale),
    orderIds.length
      ? db.all<{ orderId: string; units: number }>(sql`
          SELECT order_id AS orderId, coalesce(sum(qty), 0) AS units FROM stock_reservations
          WHERE status = 'active' AND order_id IN (SELECT value FROM json_each(${JSON.stringify(orderIds)})) GROUP BY order_id`)
      : Promise.resolve([] as { orderId: string; units: number }[]),
  ]);
  const total = Number(totals[0]?.n ?? 0);
  const page: ReservationPage = {
    rows: rows.map((row) => ({
      ...row,
      variant: labels.get(row.variantId) ?? null,
      locationCode: byId.get(row.locationId)?.code ?? row.locationId,
      releasable: row.status === "active" && (RELEASABLE_ORDER_STATUSES as readonly string[]).includes(row.orderStatus),
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    summary: { active: Number(summary[0]?.active ?? 0), units: Number(summary[0]?.units ?? 0), expiring: Number(summary[0]?.expiring ?? 0), held: Number(summary[0]?.held ?? 0) },
    orderUnits: Object.fromEntries(unitRows.map((row) => [row.orderId, Number(row.units)])),
  };
  if (can(actor, "ops.job.read")) {
    const [run] = await listJobRuns(db, "inventory.reservations.expire", 1);
    const released = run?.stats?.released;
    page.lastExpiryRun = run ? { status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt ?? null, released: typeof released === "number" ? released : null } : null;
  }
  return page;
}

export const ReleaseInput = z.object({
  orderId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid"),
  reason: z.string().trim().min(3, "too_short").max(300, "too_long"),
});

/**
 * Releases everything an order holds (its stock and its used devices), by hand, with a reason. An employee limited
 * to a branch releases only stock held at that branch's locations. The order must still be releasable when the
 * release is written (packing may start meanwhile): the batch checks it again and refuses (`release_not_allowed`).
 */
export async function releaseReservationsOfOrder(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ released: number }> {
  assertCan(actor, "inventory.reservation.release");
  const input = ReleaseInput.parse(raw);
  const orders = await db.all<{ id: string; ref: string; status: string }>(sql`SELECT o.id AS id, o.ref AS ref, o.status AS status FROM orders AS o WHERE o.id = ${input.orderId}`);
  const order = orders[0];
  if (!order) throw notFound("order");
  if (!(RELEASABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) throw new AppError("release_not_allowed", 409, { detail: order.status });
  const held = await db.all<{ locationId: string; branchId: string | null }>(sql`
    SELECT DISTINCT r.location_id AS locationId, l.branch_id AS branchId
    FROM stock_reservations AS r JOIN inventory_locations AS l ON l.id = r.location_id
    WHERE r.order_id = ${order.id} AND r.status = 'active'`);
  if (held.length === 0) return { released: 0 };
  for (const row of held) assertBranch(actor, row.branchId);
  const releasable = sql.join(
    RELEASABLE_ORDER_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  try {
    await runBatch(db, [
      expectThat(db, sql`(SELECT status FROM orders WHERE id = ${order.id}) IN (${releasable})`, { code: "ORDER_CHANGED", detail: order.id }),
      ...releaseOrderReservationsStatements(db, { orderId: order.id, actor, reason: `manual: ${input.reason}`, now }),
    ]);
  } catch (error) {
    if (isDbError(error, "ORDER_CHANGED")) throw new AppError("release_not_allowed", 409, { cause: error });
    throw error;
  }
  const released = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM stock_reservations WHERE order_id = ${order.id} AND status = 'released' AND released_at = ${now}`);
  return { released: Number(released[0]?.n ?? 0) };
}
