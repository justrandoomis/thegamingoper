import { Form, Link, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/simulate";
import { useFormat } from "~/i18n/react";
import { PRODUCT_KINDS } from "~/server/db/schema";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { parseSimulation, simulateDiscount, REFUND_HISTORY_DAYS, SIM_MAX_ROWS, type SimRow } from "~/server/services/admin/pricing/simulate.server";
import { platformOptions } from "~/server/services/admin/pricing/prices.server";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { FieldGroup, Radio, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { requirePricing } from "./route.server";
import { Iqd, iqdText, MarginStatus, PageHead, Pct, pricingMeta, RowLink, usePricingT, withSearch } from "./shared";

/**
 * /admin/pricing/simulate — a discount's effect on each SKU's NET margin (03.06): landed cost, the discount, refunds
 * (history or an assumption), payment/channel fees and the commission rules, before and after, per unit and over the
 * stock on hand. The form is a GET form: the simulation is a shareable URL and works without JavaScript.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db, "pricing.simulation.run");
  const url = new URL(request.url);
  const { params, errors } = parseSimulation(url.searchParams);
  const result = params.ready ? await simulateDiscount(db, actor, params, ctx.locale, ctx.now) : null;
  return { params, errors, result, platforms: result?.platforms ?? (await platformOptions(db, ctx.locale)), kinds: [...PRODUCT_KINDS], historyDays: REFUND_HISTORY_DAYS, maxRows: SIM_MAX_ROWS };
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "simulate.title");

export default function Simulate({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const f = useFormat();
  const { params, errors, result } = loaderData;
  const { search } = useLocation();
  const navigation = useNavigation();
  const loading = navigation.state === "loading" && navigation.location?.pathname === "/admin/pricing/simulate";

  const columns: DataColumn<SimRow>[] = [
    {
      key: "sku",
      header: t("col.sku"),
      cell: (row) => (
        <span className="grid min-w-[12rem]">
          <RowLink to={`/admin/pricing/skus/${row.variantId}`}>
            <bdi dir="ltr">{row.sku}</bdi>
          </RowLink>
          <span className="type-caption text-ink-2">{row.name}</span>
        </span>
      ),
    },
    { key: "price", header: t("col.priceIqd"), numeric: true, cell: (row) => <Iqd value={row.priceIqd} /> },
    { key: "net", header: t("col.netPriceIqd"), numeric: true, cell: (row) => <Iqd value={row.netPriceIqd} /> },
    { key: "stock", header: t("col.onHand"), numeric: true, cell: (row) => f.number(row.onHand) },
    {
      key: "refund",
      header: t("col.refunds"),
      numeric: true,
      cell: (row) => (
        <span className="grid justify-items-end">
          <Pct bps={row.refund.rateBps} />
          <span className="type-caption text-ink-2">{t(`simulate.refundSource.${row.refund.source}`)}</span>
        </span>
      ),
    },
    {
      key: "commission",
      header: t("col.commission"),
      numeric: true,
      cell: (row) => (row.commission.rule ? <Pct bps={row.commission.salesBps + row.commission.profitBps} /> : <span className="type-caption text-ink-2">{t("simulate.noRule")}</span>),
    },
  ];
  if (result?.access.cost) columns.push({ key: "landed", header: t("col.landedIqd"), numeric: true, cell: (row) => <Iqd value={row.landedIqd ?? null} /> });
  if (result?.access.profit) {
    columns.push(
      { key: "before", header: t("col.profitBefore"), numeric: true, cell: (row) => <Iqd value={row.before?.profitIqd ?? null} />, negative: (row) => (row.before?.profitIqd ?? 0) < 0 },
      { key: "after", header: t("col.profitAfter"), numeric: true, cell: (row) => <Iqd value={row.after?.profitIqd ?? null} />, negative: (row) => (row.after?.profitIqd ?? 0) < 0 },
      { key: "state", header: t("col.netMarginAfter"), cell: (row) => (row.after ? <MarginStatus state={row.after.state} bps={row.after.marginBps} /> : null) },
    );
  }

  return (
    <>
      <PageHead title={t("simulate.title")} lead={t("simulate.lead")} />

      <Form method="get" className="mb-6 grid gap-4 rounded-sm bg-paper p-4 shadow-[inset_0_0_0_1px_var(--line)]" aria-label={t("simulate.formLabel")}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField name="q" type="search" label={t("filters.search")} defaultValue={params.q} hint={t("filters.searchHint")} />
          <Select name="kind" label={t("filters.kind")} defaultValue={params.kind ?? ""} options={[{ value: "", label: t("filters.all") }, ...loaderData.kinds.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))]} />
          <Select name="platform" label={t("filters.platform")} defaultValue={params.platform ?? ""} options={[{ value: "", label: t("filters.all") }, ...loaderData.platforms.map((platform) => ({ value: platform.slug, label: platform.name }))]} />
          <Select name="ch" label={t("simulate.channel")} defaultValue={params.channel} options={[{ value: "web", label: t("simulate.channelWeb") }, { value: "pos", label: t("simulate.channelPos") }]} />
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <FieldGroup legend={t("simulate.discount")} error={errors.dv ? t(`errors.${errors.dv}`) : undefined}>
            <Radio row name="dk" value="percent" label={t("simulate.percent")} defaultChecked={params.discountKind === "percent"} />
            <Radio row name="dk" value="fixed" label={t("simulate.fixed")} defaultChecked={params.discountKind === "fixed"} />
            <TextField name="dv" label={t("simulate.value")} inputMode="decimal" ltr defaultValue={params.discountText} required hint={t("simulate.valueHint")} />
          </FieldGroup>
          <FieldGroup legend={t("simulate.refunds")} error={errors.rr ? t(`errors.${errors.rr}`) : undefined}>
            <Radio row name="rb" value="history" label={t("simulate.refundHistory", { days: loaderData.historyDays })} defaultChecked={params.refunds === "history"} />
            <Radio row name="rb" value="none" label={t("simulate.refundNone")} defaultChecked={params.refunds === "none"} />
            <Radio row name="rb" value="assume" label={t("simulate.refundAssume")} defaultChecked={params.refunds === "assume"} />
            <TextField name="rr" label={t("simulate.refundRate")} inputMode="decimal" ltr defaultValue={params.refundText} end="%" optional />
          </FieldGroup>
          <FieldGroup legend={t("simulate.fees")} error={errors.fee ? t(`errors.${errors.fee}`) : undefined}>
            <TextField name="fee" label={t("simulate.feeRate")} inputMode="decimal" ltr defaultValue={params.feeText} end="%" optional hint={t("simulate.feeHint")} />
            <p className="type-caption text-ink-2">{t("simulate.commissionNote")}</p>
          </FieldGroup>
        </div>
        <div className="flex flex-wrap gap-2">
          <Key type="submit" variant="ink" icon="percent" loading={loading}>
            {t("simulate.run")}
          </Key>
          <Key as={Link} to="/admin/pricing/simulate" variant="quiet">
            {t("filters.clear")}
          </Key>
          {result ? (
            <Key as="a" href={`/admin/pricing/export/simulate${search}`} download icon="download-simple">
              {t("common.exportCsv")}
            </Key>
          ) : null}
        </div>
      </Form>

      {!result ? (
        <EmptyState icon="percent" title={t("simulate.emptyTitle")} text={t("simulate.emptyText")} />
      ) : result.totals.skus === 0 ? (
        <EmptyState icon="magnifying-glass" title={t("skus.emptyTitle")} text={t("skus.emptyText")} />
      ) : (
        <>
          <section className="adm-section" aria-labelledby="sim-totals">
            <h2 id="sim-totals" className="adm-h2">
              {t("simulate.totals", { skus: result.totals.skus, units: result.totals.units })}
            </h2>
            <div className="adm-grid">
              <div className="adm-card">
                <p className="type-caption text-ink-2">{t("simulate.retail")}</p>
                <p className="type-kpi nums">{iqdText(f, result.totals.retailAfterIqd)}</p>
                <p className="type-caption text-ink-2">{t("simulate.before", { value: iqdText(f, result.totals.retailBeforeIqd) })}</p>
              </div>
              {result.totals.profitAfterIqd !== undefined ? (
                <div className={(result.totals.profitAfterIqd ?? 0) < 0 ? "adm-card adm-card--act" : "adm-card"}>
                  <p className="type-caption text-ink-2">{t("simulate.profit")}</p>
                  <p className={`type-kpi nums ${(result.totals.profitAfterIqd ?? 0) < 0 ? "text-red-ink" : ""}`}>{iqdText(f, result.totals.profitAfterIqd)}</p>
                  <p className="type-caption text-ink-2">{t("simulate.before", { value: iqdText(f, result.totals.profitBeforeIqd ?? null) })}</p>
                  {result.totals.uncostedSkus ? <p className="type-caption text-red-ink">{t("simulate.uncosted", { count: result.totals.uncostedSkus })}</p> : null}
                </div>
              ) : (
                <div className="adm-card">
                  <p className="type-caption text-ink-2">{t("simulate.profit")}</p>
                  <p className="type-body text-ink">{t("simulate.noProfitAccess")}</p>
                </div>
              )}
              {result.totals.belowMinAfter !== undefined ? (
                <div className={(result.totals.belowMinAfter ?? 0) + (result.totals.lossAfter ?? 0) > 0 ? "adm-card adm-card--act" : "adm-card"}>
                  <p className="type-caption text-ink-2">{t("simulate.flags")}</p>
                  <p className="type-kpi nums">{f.number((result.totals.belowMinAfter ?? 0) + (result.totals.lossAfter ?? 0))}</p>
                  <p className="type-caption text-ink-2">{t("simulate.flagsNote", { loss: result.totals.lossAfter ?? 0, below: result.totals.belowMinAfter ?? 0 })}</p>
                </div>
              ) : null}
            </div>
            {result.rulesFound === 0 ? <p className="type-caption text-ink-2">{t("simulate.noRules")}</p> : null}
            {result.truncated ? <p className="type-caption text-ink-2">{t("simulate.truncated", { max: loaderData.maxRows })}</p> : null}
            <p className="type-caption text-ink-2">{t("simulate.method")}</p>
          </section>
          <DataTable caption={t("simulate.title")} columns={columns} rows={result.rows} rowKey={(row) => row.variantId} busy={loading} footer={<Pagination page={result.page} pageCount={result.pageCount} href={(n) => withSearch(search, { page: n })} />} />
        </>
      )}
    </>
  );
}
