import { data } from "react-router";

import type { Route } from "./+types/export";
import { serverT } from "~/i18n/i18n.server";
import { can } from "~/server/actor";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { fieldAccess } from "~/server/services/admin/pricing/access";
import { bpsCell, csvResponse, toCsv, type CsvCell } from "~/server/services/admin/pricing/csv";
import { allSkuPrices, listChanges, parsePriceFilters, type ChangeStatus } from "~/server/services/admin/pricing/prices.server";
import { parseSimulation, simulateAll } from "~/server/services/admin/pricing/simulate.server";
import { requirePricing } from "./route.server";

/**
 * GET /admin/pricing/export/:kind — CSV of the SKU list (skus), the price-change log (changes) or a discount
 * simulation (simulate), with the same filters as the page and the same field rules: cost columns only for cost.read,
 * margins and profit only for profit.read — absent, not blank. A value that cannot be computed is an empty cell.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  // Every export needs a pricing permission first; each kind then checks its own.
  const { actor } = await requirePricing(ctx, db);
  const url = new URL(request.url);
  const t = serverT(ctx.locale, "admin-pricing");
  const stamp = new Date(ctx.now + 3 * 3600_000).toISOString().slice(0, 10);
  try {
    switch (params.kind) {
      case "skus": {
        const filters = parsePriceFilters(url.searchParams, fieldAccess(actor));
        const { rows, access } = await allSkuPrices(db, actor, filters, ctx.locale);
        const header = [t("csv.sku"), t("csv.product"), t("csv.variant"), t("csv.kind"), t("csv.status"), t("csv.priceIqd"), t("csv.compareAtIqd"), t("csv.onHand"), t("csv.pending")];
        if (access.cost) header.push(t("csv.landedIqd"), t("csv.costSource"));
        if (access.profit) header.push(t("csv.marginPct"), t("csv.minMarginPct"), t("csv.targetMarginPct"), t("csv.marginState"));
        const body = rows.map((row) => {
          const cells: CsvCell[] = [row.sku, row.name, row.variantTitle, t(`kind.${row.kind}`), t(`productStatus.${row.productStatus}`), row.priceIqd, row.compareAtIqd, row.onHand, row.pendingId ? t("csv.yes") : ""];
          if (access.cost) cells.push(row.cost?.landedIqd ?? null, row.cost?.source ? t(`csv.source_${row.cost.source}`) : "");
          if (access.profit) cells.push(bpsCell(row.margin?.bps), bpsCell(row.margin?.minBps), bpsCell(row.margin?.targetBps), row.margin ? t(`margin.state.${row.margin.state}`) : "");
          return cells;
        });
        return csvResponse(`tamtam-prices-${stamp}.csv`, toCsv(header, body));
      }
      case "changes": {
        const status = url.searchParams.get("status") as ChangeStatus | null;
        const result = await listChanges(db, actor, { tab: "history", q: url.searchParams.get("q") ?? "", status: status && ["applied", "pending", "rejected", "cancelled"].includes(status) ? status : null, limit: 200, page: 1 }, ctx.locale);
        const items = [...result.items];
        for (let page = 2; page <= Math.min(result.pageCount, 25); page++) items.push(...(await listChanges(db, actor, { tab: "history", q: url.searchParams.get("q") ?? "", status: status && ["applied", "pending", "rejected", "cancelled"].includes(status) ? status : null, limit: 200, page }, ctx.locale)).items);
        const header = [t("csv.date"), t("csv.sku"), t("csv.product"), t("csv.oldPriceIqd"), t("csv.newPriceIqd"), t("csv.oldCompareAtIqd"), t("csv.newCompareAtIqd"), t("csv.status"), t("csv.mode"), t("csv.source"), t("csv.requestedBy"), t("csv.decidedBy"), t("csv.decidedAt"), t("csv.reason"), t("csv.decisionNote")];
        const body = items.map((row): CsvCell[] => [
          new Date(row.createdAt).toISOString(),
          row.sku,
          row.name,
          row.oldPriceIqd,
          row.newPriceIqd,
          row.oldCompareAtIqd,
          row.newCompareAtIqd,
          t(`changes.status.${row.status}`),
          row.mode === "clearance" ? t("sku.modeClearance") : t("sku.modeStandard"),
          t(`changes.source.${row.source}`),
          row.requestedBy?.name ?? "",
          row.decidedBy?.name ?? "",
          row.decidedAt ? new Date(row.decidedAt).toISOString() : "",
          row.reason,
          row.decisionNote,
        ]);
        return csvResponse(`tamtam-price-changes-${stamp}.csv`, toCsv(header, body));
      }
      case "simulate": {
        await requirePricing(ctx, db, "pricing.simulation.run");
        const { params: simulation, errors } = parseSimulation(url.searchParams);
        if (!simulation.ready || Object.keys(errors).length > 0) throw data({ error: "invalid" }, { status: 400 });
        const result = await simulateAll(db, actor, simulation, ctx.locale, ctx.now);
        const header = [t("csv.sku"), t("csv.product"), t("csv.priceIqd"), t("csv.discountIqd"), t("csv.netPriceIqd"), t("csv.onHand"), t("csv.refundPct"), t("csv.refundSource"), t("csv.commissionPct"), t("csv.feePct")];
        if (can(actor, "cost.read")) header.push(t("csv.landedIqd"));
        if (can(actor, "profit.read")) header.push(t("csv.profitBeforeIqd"), t("csv.marginBeforePct"), t("csv.profitAfterIqd"), t("csv.marginAfterPct"), t("csv.stateAfter"));
        const body = result.rows.map((row) => {
          const cells: CsvCell[] = [
            row.sku,
            row.name,
            row.priceIqd,
            row.discountIqd,
            row.netPriceIqd,
            row.onHand,
            bpsCell(row.refund.rateBps),
            t(`simulate.refundSource.${row.refund.source}`),
            bpsCell(row.commission.salesBps + row.commission.profitBps),
            bpsCell(row.feeBps),
          ];
          if (row.landedIqd !== undefined) cells.push(row.landedIqd);
          if (row.before && row.after) cells.push(row.before.profitIqd, bpsCell(row.before.marginBps), row.after.profitIqd, bpsCell(row.after.marginBps), t(`margin.state.${row.after.state}`));
          return cells;
        });
        return csvResponse(`tamtam-discount-simulation-${stamp}.csv`, toCsv(header, body));
      }
      default:
        throw data({ error: "not_found" }, { status: 404 });
    }
  } catch (error) {
    throwAsResponse(error);
  }
}
