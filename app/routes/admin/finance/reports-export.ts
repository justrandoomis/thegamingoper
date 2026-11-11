import type { Route } from "./+types/reports-export";
import { pick } from "~/lib/locales";
import { auditStatement } from "~/server/audit.server";
import { runBatch } from "~/server/db/tx.server";
import { cashFlow, profitAndLoss } from "~/server/services/accounting/reports.server";
import { csvHeaders, toCsv, type CsvCell } from "~/server/services/admin/inventory/csv";
import { parseRange } from "~/server/services/admin/finance/types";
import { financeT, openFinance, orRespond } from "./finance.server";

/**
 * GET /admin/finance/reports/export?view=pl|cash&… — the profit and loss or the cash flow of the range as CSV
 * (10.06), with exactly the figures the page shows THIS employee: cost lines only for cost.read, profit lines only for
 * cost.read + profit.read, the cash flow only for cost.read (blueprint acceptance #5). Audited, never cached.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.report.read");
  const t = financeT(locale);
  const params = new URL(request.url).searchParams;
  const range = parseRange(params, now);
  const scope = { from: range.fromMs, to: range.toMs, includeDemo: range.demo };
  const view = params.get("view") === "cash" ? "cash" : "pl";
  const rows: CsvCell[][] = [[t("export.line"), t("export.amount")]];
  if (view === "pl") {
    const pl = await orRespond(() => profitAndLoss(db, actor, scope));
    const r = pl.revenue;
    rows.push([t("pl.revenue"), r.grossIqd], [t("pl.discounts"), -r.discountsIqd], [t("pl.refunds"), -r.refundsIqd], [t("pl.netRevenue"), r.netIqd]);
    for (const line of r.otherIncome) rows.push([`${line.code} ${pick(line.name, locale)}`, line.amountIqd]);
    if (pl.cost) rows.push([t("pl.cogs"), -pl.cost.cogsIqd]);
    if (pl.profit) rows.push([t("pl.grossProfit"), pl.profit.grossIqd]);
    rows.push([t("pl.commissions"), -pl.expenses.commissionsIqd], [t("pl.shippingCosts"), -pl.expenses.shippingCostsIqd], [t("pl.shippingIncome"), r.shippingIncomeIqd], [t("pl.shippingSubsidy"), -pl.expenses.shippingSubsidyIqd]);
    if (pl.profit) rows.push([t("pl.netProfit"), pl.profit.netIqd]);
    if (pl.cost) rows.push([t("pl.inventoryAdjustments"), -pl.cost.inventoryAdjustmentsIqd]);
    rows.push([t("pl.cashOverShort"), -pl.expenses.cashOverShortIqd]);
    for (const line of pl.expenses.operating) rows.push([`${line.code} ${pick(line.name, locale)}`, -line.amountIqd]);
    if (pl.profit) rows.push([t("pl.operatingResult"), pl.profit.operatingIqd]);
  } else {
    const cash = await orRespond(() => cashFlow(db, actor, scope));
    rows.push([t("cash.opening"), cash.openingIqd]);
    for (const row of cash.rows) {
      if (row.inflowIqd) rows.push([`${t(`cash.category.${row.category}`)} (+)`, row.inflowIqd]);
      if (row.outflowIqd) rows.push([`${t(`cash.category.${row.category}`)} (−)`, -row.outflowIqd]);
    }
    rows.push([t("cash.closing"), cash.closingIqd]);
  }
  await runBatch(db, [auditStatement(db, { actor, action: "finance.report.export", entityType: "report", entityId: view, after: { from: range.from, to: range.to, demo: range.demo }, at: now })]);
  return new Response(toCsv(rows), { headers: csvHeaders(`${view === "pl" ? "profit-and-loss" : "cash-flow"}-${range.from}-${range.to}.csv`) });
}
