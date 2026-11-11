/**
 * 05.07 — pre-orders: orders marked as pre-orders by staff (expected date, delay updates — ./actions.server
 * setPreorder) and open orders that contain a product whose release date is still ahead (catalogue
 * `products.preorder_release_at`), with the deposit the catalogue sets for it.
 *
 * Deposits are SHOWN, not taken: checkout charges the whole order (one payment row for the total), so a deposit
 * payment needs a split payment in the commerce core and the checkout (requested; 05.07 is partial).
 */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { orderItems, orders, products, variants } from "~/server/db/schema";

export type PreorderRow = {
  id: string;
  ref: string;
  status: string;
  placedAt: number;
  isPreorder: boolean;
  expectedAt: number | null;
  /** The latest catalogue release date among the order's products, if any is still ahead. */
  releaseAt: number | null;
  /** Σ catalogue deposit × quantity for those products (what a deposit would be), null when none is set. */
  depositIqd: number | null;
  totalIqd: number;
  paidIqd: number;
  overdue: boolean;
  items: string[];
  isDemo: boolean;
};

const OPEN = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing"] as const;

export async function listPreorders(db: Db, actor: Actor, locale: Locale, now: number): Promise<{ rows: PreorderRow[]; canManage: boolean }> {
  assertCan(actor, "orders.order.read");
  const upcoming = sql`EXISTS (SELECT 1 FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id WHERE oi.order_id = ${orders.id} AND p.preorder_release_at > ${now})`;
  const rows = await db
    .select({ id: orders.id, ref: orders.ref, status: orders.status, placedAt: orders.placedAt, isPreorder: orders.isPreorder, expectedAt: orders.expectedAt, totalIqd: orders.totalIqd, paidIqd: orders.paidIqd, isDemo: orders.isDemo })
    .from(orders)
    .where(and(inArray(orders.status, [...OPEN]), or(eq(orders.isPreorder, true), upcoming)))
    .orderBy(asc(sql`coalesce(${orders.expectedAt}, ${orders.placedAt})`), asc(orders.id))
    .limit(300);
  const lines = rows.length
    ? await db
        .select({ orderId: orderItems.orderId, name: orderItems.nameSnapshot, qty: orderItems.qty, releaseAt: products.preorderReleaseAt, depositIqd: products.preorderDepositIqd })
        .from(orderItems)
        .innerJoin(variants, eq(variants.id, orderItems.variantId))
        .innerJoin(products, eq(products.id, variants.productId))
        .where(
          inArray(
            orderItems.orderId,
            rows.map((row) => row.id),
          ),
        )
    : [];
  return {
    canManage: can(actor, "orders.preorder.manage"),
    rows: rows.map((row) => {
      const mine = lines.filter((line) => line.orderId === row.id);
      const ahead = mine.filter((line) => (line.releaseAt ?? 0) > now);
      const releaseAt = ahead.length ? Math.max(...ahead.map((line) => line.releaseAt ?? 0)) : null;
      const deposits = ahead.filter((line) => line.depositIqd !== null);
      return {
        ...row,
        releaseAt,
        depositIqd: deposits.length ? deposits.reduce((sum, line) => sum + (line.depositIqd ?? 0) * line.qty, 0) : null,
        overdue: row.isPreorder && row.expectedAt !== null && row.expectedAt < now,
        items: mine.map((line) => `${pick(line.name, locale)} × ${line.qty}`),
      };
    }),
  };
}
