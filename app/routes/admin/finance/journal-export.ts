import type { Route } from "./+types/journal-export";
import { csvHeaders, toCsv } from "~/server/services/admin/inventory/csv";
import { exportJournalLines, type JournalFilters } from "~/server/services/admin/finance/ledger.server";
import { baghdadDay, idParam, parseRange, queryText, REF_TYPES } from "~/server/services/admin/finance/types";
import { financeT, openFinance, orRespond } from "./finance.server";

/**
 * GET /admin/finance/journal/export?… — the journal's lines as CSV with the list's filters (10.01), oldest first, at
 * most 10,000 lines (a last row says when it was cut). The books carry purchase cost, so the export needs
 * finance.journal.read AND cost.read like the page (blueprint acceptance #5); it is audited and never cached.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.journal.read");
  const t = financeT(locale);
  const params = new URL(request.url).searchParams;
  const range = parseRange(params, now);
  const refType = params.get("ref");
  const filters: JournalFilters = { ...range, account: idParam(params, "account"), refType: refType && ([...REF_TYPES, "other"] as string[]).includes(refType) ? refType : null, q: queryText(params), page: 1 };
  const { lines, truncated } = await orRespond(() => exportJournalLines(db, actor, filters, locale, now));
  const rows: (string | number | null)[][] = [
    [t("export.date"), t("export.entry"), t("export.period"), t("export.memo"), t("export.refType"), t("export.refId"), t("export.code"), t("export.account"), t("export.debit"), t("export.credit"), t("export.center"), t("export.by"), t("export.demo")],
    ...lines.map((line) => [baghdadDay(line.at), line.entryId, line.period, line.memo, line.refType, line.refId, line.code, line.account, line.debitIqd, line.creditIqd, line.costCenter, line.by, line.isDemo ? 1 : 0]),
  ];
  if (truncated) rows.push([t("export.truncated")]);
  return new Response(toCsv(rows), { headers: csvHeaders(`journal-${filters.from}-${filters.to}.csv`) });
}
