import type { Route } from "./+types/export";
import { throwAsResponse } from "~/server/errors";
import { csvHeaders, toCsv } from "~/server/services/admin/inventory/csv";
import { exportCustomersCsv, MAX_EXPORT_ROWS } from "~/server/services/admin/customers/list.server";
import { parseCustomerFilters } from "~/server/services/admin/customers/types";
import { customersT, openCustomers } from "./customers.server";

/**
 * GET /admin/customers/export?… — the customer list as CSV with the list's filters and order (07.01), at most
 * MAX_EXPORT_ROWS rows (a last row says when it was cut). Needs customers.customer.read AND customers.customer.export;
 * phones are masked without customer.phone.read_full, exactly as on screen; every export is audited; never cached.
 * No cost or profit column exists in it ("spent" is what the store kept: paid minus refunded).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCustomers(context, "customers.customer.export");
  const t = customersT(locale);
  const filters = parseCustomerFilters(new URL(request.url).searchParams);
  try {
    const result = await exportCustomersCsv(db, actor, filters, now, {
      header: [t("export.id"), t("export.name"), t("export.phone"), t("export.email"), t("export.status"), t("export.joined"), t("export.orders"), t("export.purchases"), t("export.spent"), t("export.lastOrder"), t("export.segment"), t("export.flags"), t("export.demo")],
      status: (status) => t(`status.${status}`),
      segment: (segment) => (segment ? t(`segment.${segment}.name`) : ""),
      flag: (id) => t(`flags.rules.${id}.title`),
    });
    const rows: (string | number | null)[][] = [result.header, ...result.rows];
    if (result.truncated) rows.push([t("export.truncated", { count: MAX_EXPORT_ROWS })]);
    const day = new Date(now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return new Response(toCsv(rows), { headers: csvHeaders(`customers-${day}.csv`) });
  } catch (error) {
    throwAsResponse(error);
  }
}
