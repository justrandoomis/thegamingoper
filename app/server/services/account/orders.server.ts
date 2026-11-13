/**
 * «طلباتي» by state (account `/account/orders?show=open|done|closed`, Design v2.1 — the client's reference «طلباتي»
 * with its filter chips): the customer's own orders, newest first, keyset-paged like the commerce core's
 * listOrdersForCustomer (whose rows and view builder it reads — nothing here decides or writes anything), narrowed to
 * one group of states, and how many orders each group holds (the chips' counts).
 *
 *   const page = await listOwnOrders(db, customerId, locale, { show: "open", cursor, limit: 10 });
 *   page.items · page.total (in the group) · page.nextCursor · page.counts.{all,open,done,closed}
 *
 * The groups follow the order's life (Design System v2 §6.11): «قيد التنفيذ» = placed, awaiting or reviewing payment,
 * confirmed, being prepared or on its way; «سُلّمت» = delivered; «ملغاة ومُرجعة» = cancelled or returned. Must not
 * import "cloudflare:workers".
 */
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { OrderStatus, Paged } from "~/lib/dto";
import type { Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { orders } from "~/server/db/schema";
import type { OrderSummary } from "~/server/services/orders/types";
import { buildOrderSummaries } from "~/server/services/orders/view.server";
import { GROUP_OF, statusesOf, type OrderShow } from "./types";

// the groups themselves are client-safe (the page's chips read them): ./types
export { GROUP_OF, ORDER_GROUPS, orderShow, statusesOf, type OrderGroup, type OrderShow } from "./types";

export type OwnOrdersPage = Paged<OrderSummary> & { show: OrderShow; counts: Record<OrderShow, number> };

const CURSOR = /^(\d{1,16}):([A-Za-z0-9_.:-]{1,128})$/;

/** The customer's orders in one group (or all), newest first, `limit` (1–50, default 10) after `cursor`. Reads only. */
export async function listOwnOrders(db: Db, customerId: string, locale: Locale, page: { show?: OrderShow; cursor?: string | null; limit?: number } = {}): Promise<OwnOrdersPage> {
  const show = page.show ?? "all";
  const limit = Math.min(Math.max(Math.floor(page.limit ?? 10), 1), 50);
  const cursor = page.cursor ? CURSOR.exec(page.cursor) : null;
  const mine = eq(orders.customerId, customerId);
  const scope: SQL | undefined = show === "all" ? mine : and(mine, inArray(orders.status, statusesOf(show)));
  const after = cursor ? or(lt(orders.placedAt, Number(cursor[1])), and(eq(orders.placedAt, Number(cursor[1])), lt(orders.id, cursor[2]))) : undefined;
  const [rows, byStatus] = await Promise.all([
    db
      .select()
      .from(orders)
      .where(after ? and(scope, after) : scope)
      .orderBy(desc(orders.placedAt), desc(orders.id))
      .limit(limit + 1),
    db.select({ status: orders.status, n: sql<number>`count(*)` }).from(orders).where(mine).groupBy(orders.status),
  ]);
  const counts: Record<OrderShow, number> = { all: 0, open: 0, done: 0, closed: 0 };
  for (const row of byStatus) {
    const n = Number(row.n ?? 0);
    counts.all += n;
    const group = GROUP_OF[row.status as OrderStatus];
    if (group) counts[group] += n;
  }
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: await buildOrderSummaries(db, pageRows, locale),
    total: counts[show],
    nextCursor: rows.length > limit && last ? `${last.placedAt}:${last.id}` : null,
    show,
    counts,
  };
}
