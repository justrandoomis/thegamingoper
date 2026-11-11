import type { Route } from "./+types/export";
import { serverT } from "~/i18n/i18n.server";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { exportOrdersCsv } from "~/server/services/admin/orders/export.server";
import { parseListFilters } from "~/server/services/admin/orders/types";
import { ORDERS_NS } from "./common.server";

/**
 * GET /admin/orders/export?<the list's filters> — the filtered orders as CSV (orders.order.export). Cost and margin
 * columns are in the file only for cost.read / profit.read (blueprint acceptance #5); the export is audited.
 */
const HEADER_KEYS = ["ref", "placedAt", "status", "paymentStatus", "paymentMethod", "governorate", "contactName", "phone", "units", "subtotalIqd", "discountIqd", "shippingIqd", "totalIqd", "paidIqd", "refundedIqd", "demo", "costIqd", "marginIqd"];

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.export");
  const t = serverT(ctx.locale, ORDERS_NS);
  const headers = Object.fromEntries(HEADER_KEYS.map((key) => [key, t(`csv.${key}`)]));
  const { csv } = await exportOrdersCsv(db, actor, parseListFilters(new URL(request.url).searchParams), headers, ctx.locale, ctx.now);
  const day = new Date(ctx.now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${day}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
