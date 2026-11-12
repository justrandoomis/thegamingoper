import type { Route } from "./+types/performance-csv";
import { audit } from "~/server/audit.server";
import { throwAsResponse } from "~/server/errors";
import { csvHeaders, toCsv, type CsvCell } from "~/server/services/admin/inventory/csv";
import { performanceCsvRows, performanceReport } from "~/server/services/admin/marketing/performance.server";
import { SECTION_READ } from "~/server/services/admin/marketing/shared.server";
import { parseMonthRange } from "~/server/services/admin/marketing/types";
import { marketingT, openMarketing } from "./marketing.server";

/**
 * GET /admin/marketing/performance/csv?from=YYYY-MM&to=YYYY-MM[&demo=1] — the performance report (16.07) as CSV: one
 * row per month, then one row per campaign, with the employee's headers. Needs marketing.report.read; no cost or
 * profit figure exists in it; an empty cell is a figure that cannot be computed (never 0). Audited; never cached.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openMarketing(context, SECTION_READ.performance);
  const t = marketingT(locale);
  const range = parseMonthRange(new URL(request.url).searchParams, now);
  try {
    const report = await performanceReport(db, actor, range, now);
    const { months, campaigns } = performanceCsvRows(report);
    const rows: CsvCell[][] = [
      [t("performance.csv.month"), t("performance.csv.spend"), t("performance.csv.entries"), t("performance.csv.newCustomers"), t("performance.csv.cac"), t("performance.csv.attributedOrders"), t("performance.csv.attributedPaid")],
      ...months,
      [],
      [t("performance.csv.campaign"), t("performance.csv.channel"), t("performance.csv.spend"), t("performance.csv.entries"), t("performance.csv.budget"), t("performance.csv.attributedOrders"), t("performance.csv.attributedPaid"), t("performance.csv.roas")],
      ...campaigns,
      [],
      [t("performance.csv.ltvCohort"), report.ltv.cohortAvgPaidIqd === null ? "" : Math.round(report.ltv.cohortAvgPaidIqd), t("performance.csv.people"), report.ltv.cohort],
      [t("performance.csv.ltvAll"), report.ltv.avgPaidIqd === null ? "" : Math.round(report.ltv.avgPaidIqd), t("performance.csv.people"), report.ltv.customers],
      [t("performance.csv.note")],
    ];
    await audit(db, { actor, action: "marketing.report.export", entityType: "marketing_report", entityId: `${range.from}..${range.to}`, after: { from: range.from, to: range.to, demo: range.demo, months: months.length, campaigns: campaigns.length }, at: now });
    return new Response(toCsv(rows), { headers: csvHeaders(`marketing-${range.from}-${range.to}.csv`) });
  } catch (error) {
    throwAsResponse(error);
  }
}
