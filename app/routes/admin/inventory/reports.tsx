import type { ReactNode } from "react";
import { Form, useLocation } from "react-router";

import type { Route } from "./+types/reports";
import { useFormat } from "~/i18n/react";
import { REPORT_KINDS, REPORT_PERIODS, inventoryReport, parseReportFilters, type DeadStockRow, type FlowRow, type TurnoverRow } from "~/server/services/admin/inventory/analytics.server";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Tabs } from "~/ui/Tabs";
import { Code, Kpi, Money, Num, PageHead, Pair, ResponsiveList, RowLink, When, useInvT, withSearch } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/reports — dead stock, stock turnover and sales versus inbound (04.12), from the actual movements,
 * for a chosen period, with CSV export. Money columns (value at cost, cost of goods sold) exist only for cost.read.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.report.read");
  const filters = parseReportFilters(new URL(request.url).searchParams);
  return { report: await inventoryReport(db, actor, filters, locale, now), filters, kinds: [...REPORT_KINDS], periods: [...REPORT_PERIODS] };
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "reports.title");

export default function Reports({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { search } = useLocation();
  const { report, filters, kinds, periods } = loaderData;
  const exportHref = `/admin/inventory/reports/export${withSearch(search, { page: null })}`;
  const pagination = <Pagination page={report.page} pageCount={report.pageCount} href={(n) => withSearch(search, { page: n })} />;
  const product = (variant: { id: string; sku: string; name: string }) => <RowLink to={`/admin/inventory/stock/${variant.id}`}><Code>{variant.sku}</Code></RowLink>;

  let body: ReactNode = null;
  if (report.report === "dead") {
    const withCost = report.summary.valueIqd !== undefined;
    const columns: DataColumn<DeadStockRow>[] = [
      { key: "sku", header: t("common.sku"), cell: (row) => product(row.variant) },
      { key: "name", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant.name}</span> },
      { key: "onHand", header: t("common.onHand"), numeric: true, cell: (row) => <Num value={row.onHand} /> },
      { key: "lastSale", header: t("reports.lastSale"), cell: (row) => (row.lastSaleAt === null ? t("reports.neverSold") : <When at={row.lastSaleAt} kind="date" />) },
      { key: "lastReceipt", header: t("reports.lastReceipt"), cell: (row) => <When at={row.lastReceiptAt} kind="date" /> },
    ];
    if (withCost) columns.push({ key: "value", header: t("common.value"), numeric: true, cell: (row) => <Money iqd={row.valueIqd} /> });
    body = (
      <>
        <p className="type-caption text-ink-2">{t("reports.deadLead")}</p>
        <div className="inv-kpis">
          <Kpi label={t("reports.variants")} value={f.number(report.summary.variants)} />
          <Kpi label={t("reports.units")} value={f.number(report.summary.units)} />
          {withCost ? <Kpi wide label={t("common.value")} value={<Money iqd={report.summary.valueIqd} />} hint={report.summary.unlayeredUnits ? t("common.unlayered", { count: report.summary.unlayeredUnits }) : undefined} /> : null}
        </div>
        <ResponsiveList
          caption={t("reports.kinds.dead")}
          rows={report.rows}
          rowKey={(row) => row.variant.id}
          columns={columns}
          card={(row) => (
            <>
              <p className="type-strong">{row.variant.name}</p>
              <Pair label={t("common.onHand")}>
                <Num value={row.onHand} />
              </Pair>
              <Pair label={t("reports.lastSale")}>{row.lastSaleAt === null ? t("reports.neverSold") : <When at={row.lastSaleAt} kind="date" />}</Pair>
            </>
          )}
          empty={<EmptyState icon="hourglass" title={t("reports.emptyDead")} />}
          footer={pagination}
        />
      </>
    );
  } else if (report.report === "turnover") {
    const withCost = report.summary.cogsIqd !== undefined;
    const columns: DataColumn<TurnoverRow>[] = [
      { key: "sku", header: t("common.sku"), cell: (row) => product(row.variant) },
      { key: "name", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant.name}</span> },
      { key: "sold", header: t("reports.sold"), numeric: true, cell: (row) => <Num value={row.sold} /> },
      { key: "start", header: t("reports.start"), numeric: true, cell: (row) => <Num value={row.onHandStart} /> },
      { key: "end", header: t("reports.end"), numeric: true, cell: (row) => <Num value={row.onHandEnd} /> },
      { key: "average", header: t("reports.average"), numeric: true, cell: (row) => f.number(row.averageOnHand, { maximumFractionDigits: 1 }) },
      { key: "turnover", header: t("reports.turnover"), numeric: true, cell: (row) => (row.turnover === null ? "—" : f.number(row.turnover, { maximumFractionDigits: 2 })) },
      { key: "days", header: t("reports.daysOfInventory"), numeric: true, cell: (row) => (row.daysOfInventory === null ? "—" : f.number(Math.round(row.daysOfInventory))) },
    ];
    if (withCost) columns.push({ key: "cogs", header: t("reports.cogs"), numeric: true, cell: (row) => <Money iqd={row.cogsIqd} /> });
    body = (
      <>
        <p className="type-caption text-ink-2">{t("reports.turnoverLead")}</p>
        <div className="inv-kpis">
          <Kpi label={t("reports.sold")} value={f.number(report.summary.sold)} />
          <Kpi label={t("reports.average")} value={f.number(report.summary.averageOnHand, { maximumFractionDigits: 1 })} />
          <Kpi label={t("reports.turnover")} value={report.summary.turnover === null ? "—" : f.number(report.summary.turnover, { maximumFractionDigits: 2 })} />
          {withCost ? <Kpi wide label={t("reports.cogs")} value={<Money iqd={report.summary.cogsIqd} />} /> : null}
        </div>
        <ResponsiveList
          caption={t("reports.kinds.turnover")}
          rows={report.rows}
          rowKey={(row) => row.variant.id}
          columns={columns}
          card={(row) => (
            <>
              <p className="type-strong">{row.variant.name}</p>
              <Pair label={t("reports.sold")}>
                <Num value={row.sold} />
              </Pair>
              <Pair label={t("reports.turnover")}>{row.turnover === null ? "—" : f.number(row.turnover, { maximumFractionDigits: 2 })}</Pair>
            </>
          )}
          empty={<EmptyState icon="chart-line" title={t("reports.empty")} />}
          footer={pagination}
        />
      </>
    );
  } else {
    const max = Math.max(1, ...report.buckets.map((bucket) => Math.max(bucket.sold, bucket.received + bucket.returned)));
    const columns: DataColumn<FlowRow>[] = [
      { key: "sku", header: t("common.sku"), cell: (row) => product(row.variant) },
      { key: "name", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant.name}</span> },
      { key: "sold", header: t("reports.sold"), numeric: true, cell: (row) => <Num value={row.sold} /> },
      { key: "received", header: t("reports.received"), numeric: true, cell: (row) => <Num value={row.received} /> },
      { key: "returned", header: t("reports.returned"), numeric: true, cell: (row) => <Num value={row.returned} /> },
      { key: "net", header: t("reports.net"), numeric: true, cell: (row) => <Num value={row.net} signed />, negative: (row) => row.net < 0 },
    ];
    body = (
      <>
        <p className="type-caption text-ink-2">{t("reports.flowLead")}</p>
        <div className="inv-kpis">
          <Kpi label={t("reports.sold")} value={f.number(report.summary.sold)} />
          <Kpi label={t("reports.received")} value={f.number(report.summary.received)} />
          <Kpi label={t("reports.returned")} value={f.number(report.summary.returned)} />
        </div>
        <figure className="grid gap-2">
          <figcaption className="flex flex-wrap items-center gap-4 type-caption text-ink-2">
            <span>{t("reports.chart")}</span>
            <span>
              <span className="inv-swatch inv-chart__bar--sold" /> {t("reports.chartSold")}
            </span>
            <span>
              <span className="inv-swatch inv-chart__bar--in" /> {t("reports.chartReceived")}
            </span>
          </figcaption>
          <div className="inv-chart" role="img" aria-label={`${t("reports.chart")}: ${report.buckets.map((bucket) => `${bucket.label} ${bucket.sold}/${bucket.received + bucket.returned}`).join(" · ")}`}>
            {report.buckets.map((bucket) => (
              <div key={bucket.start} className="inv-chart__group" title={`${bucket.label}: ${bucket.sold} / ${bucket.received + bucket.returned}`}>
                <span className="inv-chart__bar inv-chart__bar--sold" style={{ blockSize: `${(bucket.sold / max) * 100}%` }} />
                <span className="inv-chart__bar inv-chart__bar--in" style={{ blockSize: `${((bucket.received + bucket.returned) / max) * 100}%` }} />
              </div>
            ))}
          </div>
        </figure>
        <ResponsiveList
          caption={t("reports.kinds.flow")}
          rows={report.rows}
          rowKey={(row) => row.variant.id}
          columns={columns}
          card={(row) => (
            <>
              <p className="type-strong">{row.variant.name}</p>
              <Pair label={t("reports.sold")}>
                <Num value={row.sold} />
              </Pair>
              <Pair label={t("reports.received")}>
                <Num value={row.received} />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="chart-bar" title={t("reports.empty")} />}
          footer={pagination}
        />
      </>
    );
  }

  return (
    <>
      <PageHead
        title={t("reports.title")}
        lead={t("reports.lead")}
        actions={
          <Key as="a" href={exportHref} icon="download-simple" download>
            {t("common.exportCsv")}
          </Key>
        }
      />
      <Tabs aria-label={t("reports.title")} value={filters.report} items={kinds.map((kind) => ({ value: kind, label: t(`reports.kinds.${kind}`), href: withSearch(search, { report: kind }) }))} className="mb-4" />
      <Form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="report" value={filters.report} />
        <Select name="days" label={t("reports.period")} defaultValue={String(filters.days)} options={periods.map((days) => ({ value: String(days), label: t("reports.periodDays", { days }) }))} className="min-w-[12rem]" />
        <Key type="submit" variant="ink">
          {t("common.apply")}
        </Key>
      </Form>
      <div className="grid gap-4">{body}</div>
    </>
  );
}
