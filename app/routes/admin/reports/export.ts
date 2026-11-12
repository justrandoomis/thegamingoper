import type { Route } from "./+types/export";
import { exportReport, EXPORT_FORMATS, type ExportFormat } from "~/server/services/admin/reports/export.server";
import { isReportKey } from "~/server/services/admin/reports/types";
import { openReports, orRespond, reportsT } from "./reports.server";

/**
 * GET /admin/reports/export?report=<sales|margin|inventory|customers|performance>&format=<csv|xlsx>&<the report's
 * parameters> — 18.06: the report as a file with exactly the figures its page shows THIS employee (cost columns only
 * with cost.read, profit columns only with cost.read + profit.read; blueprint acceptance #5). reports.export.create
 * and the report's own permission; audited; never cached. An unknown report or format is a 404.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReports(context, "reports.export.create");
  const params = new URL(request.url).searchParams;
  const key = params.get("report");
  const format = params.get("format") ?? "csv";
  if (!isReportKey(key) || !(EXPORT_FORMATS as readonly string[]).includes(format)) throw new Response(null, { status: 404 });
  const file = await orRespond(() => exportReport(db, actor, { key, format: format as ExportFormat, params }, locale, now, reportsT(locale)));
  return new Response(file.body, { headers: file.headers });
}
