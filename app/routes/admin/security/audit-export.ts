import type { Route } from "./+types/audit-export";
import { exportAuditCsv } from "~/server/services/admin/security/audit-log.server";
import { baghdadDay, parseAuditFilters } from "~/server/services/admin/security/types";
import { sec } from "./security.server";

/**
 * GET /admin/security/audit/export — the audit view as CSV (UTF-8 with BOM, opens in Excel), the same filters as the
 * page, at most 5,000 events; cost and margin left out for employees without cost.read / profit.read, as on screen.
 * The export itself is an audit event. Resource route: no component.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await sec.open(context, "audit.read");
  const filters = parseAuditFilters(new URL(request.url).searchParams);
  const result = await sec.orRespond(() => exportAuditCsv(db, actor, filters, now));
  return new Response(result.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tamtam-audit-${baghdadDay(now)}.csv"`,
      "Cache-Control": "no-store",
      "X-Rows": String(result.rows),
      ...(result.truncated ? { "X-Truncated": "1" } : {}),
    },
  });
}
