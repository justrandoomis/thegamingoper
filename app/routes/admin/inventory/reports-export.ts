import type { Route } from "./+types/reports-export";
import { inventoryReportCsv, parseReportFilters } from "~/server/services/admin/inventory/analytics.server";
import { csvHeaders } from "~/server/services/admin/inventory/csv";
import { baghdadDate } from "~/server/services/admin/inventory/shared.server";
import { inventoryT, openInventory } from "./inventory.server";

/**
 * GET /admin/inventory/reports/export?report=dead|turnover|flow&days=… — the report as CSV (04.12), column titles in
 * the admin's language. Money columns only for cost.read (blueprint acceptance #5). Never cached.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.report.read");
  const t = inventoryT(locale);
  const filters = parseReportFilters(new URL(request.url).searchParams);
  const headers = {
    sku: t("common.sku"),
    product: t("common.product"),
    onHand: t("common.onHand"),
    lastSale: t("reports.lastSale"),
    lastReceipt: t("reports.lastReceipt"),
    valueIqd: t("common.value"),
    unlayered: t("costing.unlayered"),
    sold: t("reports.sold"),
    onHandStart: t("reports.start"),
    onHandEnd: t("reports.end"),
    averageOnHand: t("reports.average"),
    turnover: t("reports.turnover"),
    daysOfInventory: t("reports.daysOfInventory"),
    cogsIqd: t("reports.cogs"),
    received: t("reports.received"),
    returned: t("reports.returned"),
    net: t("reports.net"),
  };
  const csv = await inventoryReportCsv(db, actor, filters, locale, now, headers);
  return new Response(csv, { headers: csvHeaders(`inventory-${filters.report}-${filters.days}d-${baghdadDate(now)}.csv`) });
}
