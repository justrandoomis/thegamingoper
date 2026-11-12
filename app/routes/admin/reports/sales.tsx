import { useRef } from "react";
import { Link, useLocation } from "react-router";

import type { Route } from "./+types/sales";
import { useFormat } from "~/i18n/react";
import { salesReport } from "~/server/services/admin/reports/sales.server";
import { MAX_LINE_ORDERS, parseSalesParams, reportSearch, SALES_DIMENSIONS, type SalesRow } from "~/server/services/admin/reports/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { reportsMeta } from "./meta";
import { openReports, orRespond } from "./reports.server";
import { Bps, ChoiceLinks, DayName, DemoShown, Kpi, Kpis, Money, Note, Num, PageHead, Pair, RangeBar, RangeLabel, ReportActions, ResponsiveTable, Section, usePrintInLight, useRepT, withSearch } from "./ui";

/**
 * /admin/reports/sales — 18.01: sales by day, platform, branch and channel (reports.sales.read). The totals are the
 * books' (accounting/reports.server.ts revenueRecognised: revenue at delivery, discounts, refunds, shipping income) and
 * the operational figures of docs/metrics.md §3 (orders placed, GMV, average basket, cancellations, paid sales, refund
 * and return rates); every row splits the same journal lines and the rows plus "not attributed" add up to the books —
 * the page says so when they do not. Range, dimension and page in the URL; demo rows only when asked; printable; CSV
 * and XLSX for reports.export.create. No cost anywhere.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReports(context, "reports.sales.read");
  const params = parseSalesParams(new URL(request.url).searchParams, now);
  const report = await orRespond(() => salesReport(db, actor, params, locale, now));
  return { report, params, now };
}

export const meta: Route.MetaFunction = (args) => reportsMeta(args, "sales.title");

export default function SalesPage({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const f = useFormat();
  const { search } = useLocation();
  const { report, params, now } = loaderData;
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  const by = report.by;
  const platform = by === "platform";
  const ops = report.operations;
  const totals = report.totals;
  const nothing = ops.placed === 0 && totals.grossIqd === 0 && totals.refundsIqd === 0 && totals.shippingIqd === 0 && report.unattributed.grossIqd === 0;
  const dimensionHref = (value: (typeof SALES_DIMENSIONS)[number]) => `/admin/reports/sales${reportSearch("sales", { ...params, by: value, page: 1 })}`;
  const demoHref = `/admin/reports/sales${reportSearch("sales", { ...params, range: { ...params.range, demo: !params.range.demo }, page: 1 })}`;

  const label = (row: SalesRow) => {
    switch (row.label.kind) {
      case "day":
        return <DayName day={row.label.day} />;
      case "channel":
        return <span>{t(`channel.${row.label.channel}`)}</span>;
      case "branch":
        return <span>{row.label.id ? (row.name ?? row.label.id) : t(row.label.channel === "pos" ? "sales.branchNone" : "sales.online")}</span>;
      default:
        return <span>{row.label.id ? (row.name ?? row.label.id) : t("sales.noPlatform")}</span>;
    }
  };

  const columns: DataColumn<SalesRow>[] = [
    { key: "label", header: t(`sales.by.${by}`), cell: label },
    { key: "placed", header: t("col.placed"), numeric: true, cell: (row) => <Num value={row.placed} /> },
    ...(platform
      ? []
      : ([
          { key: "gmv", header: t("col.gmvIqd"), numeric: true, cell: (row) => <Money iqd={row.gmvIqd} /> },
          { key: "cancelled", header: t("col.cancelled"), numeric: true, cell: (row) => <Num value={row.cancelled} /> },
        ] as DataColumn<SalesRow>[])),
    { key: "recognised", header: t("col.recognised"), numeric: true, cell: (row) => <Num value={row.ordersRecognised} /> },
    { key: "revenue", header: t("col.revenueIqd"), numeric: true, cell: (row) => <Money iqd={row.revenue.grossIqd} /> },
    { key: "discounts", header: t("col.discountsIqd"), numeric: true, cell: (row) => <Money iqd={row.revenue.discountsIqd ? -row.revenue.discountsIqd : 0} /> },
    { key: "refunds", header: t("col.refundsIqd"), numeric: true, cell: (row) => <Money iqd={row.revenue.refundsIqd ? -row.revenue.refundsIqd : 0} /> },
    { key: "net", header: t("col.netRevenueIqd"), numeric: true, cell: (row) => <b className="font-semibold"><Money iqd={row.revenue.netIqd} /></b> },
    { key: "shipping", header: t("col.shippingIqd"), numeric: true, cell: (row) => <Money iqd={row.revenue.shippingIqd} /> },
    { key: "units", header: t("col.units"), numeric: true, cell: (row) => <Num value={row.units} /> },
  ];

  return (
    <div ref={sheet} className="rep-print">
      <PageHead eyebrow={t("sales.eyebrow")} title={t("sales.title")} lead={t("sales.lead")} actions={<ReportActions report="sales" search={reportSearch("sales", { ...params, page: 1 })} />} />
      <p className="rep-print-only type-body">
        {t(`sales.by.${by}`)} · <RangeLabel range={report.range} />
      </p>
      <RangeBar range={params.range} action="/admin/reports/sales" keep={{ by: by === "day" ? null : by }} now={now} />
      <div className="mt-3">
        <ChoiceLinks label={t("sales.dimension")} options={SALES_DIMENSIONS.map((value) => ({ value, label: t(`sales.by.${value}`) }))} current={by} href={dimensionHref} />
      </div>
      <div className="mt-4 grid gap-3">
        <DemoShown range={params.range} href={demoHref} />
        {!report.consistent ? (
          <Note icon="warning-circle" tone="bad">
            <p>{t("sales.inconsistent")}</p>
          </Note>
        ) : null}
      </div>

      <Section id="sales-totals" title={t("sales.totals")}>
        <Kpis label={t("sales.totals")}>
          <Kpi label={t("kpi.netRevenue")} value={<Money iqd={totals.netIqd} />} hint={t("kpi.netRevenueHint")} />
          <Kpi label={t("kpi.revenue")} value={<Money iqd={totals.grossIqd} />} hint={t("kpi.recognisedOrders", { count: totals.ordersRecognised })} />
          <Kpi label={t("kpi.discountsRefunds")} value={<Money iqd={-(totals.discountsIqd + totals.refundsIqd)} />} hint={t("kpi.discountsRefundsHint", { discounts: f.iqd(totals.discountsIqd), refunds: f.iqd(totals.refundsIqd) })} />
          <Kpi label={t("kpi.placed")} value={<Num value={ops.placed} />} hint={t("kpi.cancelledHint", { count: ops.cancelled })} />
          <Kpi label={t("kpi.gmv")} value={<Money iqd={ops.gmvIqd} />} hint={t("kpi.gmvHint")} />
          <Kpi label={t("kpi.aov")} value={<Money iqd={ops.aovIqd} unknown={t("kpi.aovNone")} />} hint={t("kpi.aovHint")} />
          <Kpi label={t("kpi.cancellationRate")} value={<Bps value={ops.cancellationBps} />} />
          <Kpi label={t("kpi.paidSales")} value={<Money iqd={ops.paidSalesIqd} />} hint={t("kpi.paidSalesHint")} />
          <Kpi label={t("kpi.refundRate")} value={<Bps value={ops.refundRateBps} />} hint={t("kpi.refundRateHint")} />
          <Kpi label={t("kpi.returnRate")} value={<Bps value={ops.returnRateBps} />} hint={t("kpi.returnRateHint")} />
          <Kpi label={t("kpi.units")} value={<Num value={ops.unitsSold} />} hint={t("kpi.unitsHint")} />
          <Kpi label={t("kpi.shippingIncome")} value={<Money iqd={totals.shippingIqd} />} />
        </Kpis>
      </Section>

      <Section id="sales-rows" title={t("sales.rowsTitle", { by: t(`sales.by.${by}`) })}>
        {report.tooMany ? (
          <Note icon="warning" tone="warn">
            <p>{t("common.tooMany", { count: f.number(report.tooMany.orders), max: f.number(MAX_LINE_ORDERS) })}</p>
          </Note>
        ) : nothing ? (
          <EmptyState
            icon="chart-line"
            title={t("sales.empty")}
            text={params.range.demo ? t("common.emptyRange") : t("common.emptyRangeDemo")}
            action={
              params.range.demo ? undefined : (
                <Key as={Link} to={demoHref} size="sm" icon="plus">
                  {t("range.demo")}
                </Key>
              )
            }
          />
        ) : (
          <ResponsiveTable
            caption={t("sales.rowsTitle", { by: t(`sales.by.${by}`) })}
            columns={columns}
            rows={report.rows}
            rowKey={(row) => row.key}
            card={(row) => (
              <>
                <p className="type-strong">{label(row)}</p>
                <Pair label={t("col.netRevenueIqd")}>
                  <Money iqd={row.revenue.netIqd} />
                </Pair>
                <Pair label={t("col.revenueIqd")}>
                  <Money iqd={row.revenue.grossIqd} />
                </Pair>
                <Pair label={t("col.placed")}>
                  <Num value={row.placed} />
                </Pair>
                <Pair label={t("col.units")}>
                  <Num value={row.units} />
                </Pair>
              </>
            )}
            footer={
              <>
                {report.pageCount > 1 ? <Pagination page={report.page} pageCount={report.pageCount} href={(n) => withSearch(search, { page: n })} /> : null}
                <dl className="rep-ledger adm-card">
                  {report.unattributed.grossIqd || report.unattributed.discountsIqd || report.unattributed.refundsIqd || report.unattributed.shippingIqd ? (
                    <div>
                      <dt>
                        {t("sales.unattributed")}
                        <span className="block type-caption text-ink-2">{t("sales.unattributedHint")}</span>
                      </dt>
                      <dd>
                        <Money iqd={report.unattributed.netIqd} />
                      </dd>
                    </div>
                  ) : null}
                  <div className="rep-ledger__total">
                    <dt>
                      {t("sales.totalBooks")}
                      <span className="block type-caption text-ink-2">{report.consistent ? t("sales.consistent") : t("sales.inconsistent")}</span>
                    </dt>
                    <dd>
                      <Money iqd={totals.netIqd} />
                    </dd>
                  </div>
                </dl>
              </>
            }
          />
        )}
      </Section>

      <Section id="sales-rules" title={t("common.howComputed")}>
        <Note>
          <p>{t(`sales.rule.${by}`)}</p>
          <p>
            {t("common.definitions")}{" "}
            <Link to="/admin/reports/dictionary" className="adm-link">
              {t("dictionary.title")}
            </Link>
          </p>
        </Note>
      </Section>
    </div>
  );
}
