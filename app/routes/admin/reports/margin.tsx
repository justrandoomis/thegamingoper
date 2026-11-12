import { useRef } from "react";
import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/margin";
import { useFormat } from "~/i18n/react";
import { marginReport, type MarginRow } from "~/server/services/admin/reports/margin.server";
import { MAX_LINE_ORDERS, parseMarginParams, reportSearch, type MarginSort } from "~/server/services/admin/reports/types";
import type { DataColumn, DataSort } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { reportsMeta } from "./meta";
import { openReports, orRespond } from "./reports.server";
import { Bps, Code, DemoShown, Kpi, Kpis, Money, Name, NeedsPermission, Note, Num, PageHead, Pair, RangeBar, RangeLabel, ReportActions, ResponsiveTable, Section, usePrintInLight, useRepT, withSearch } from "./ui";

/**
 * /admin/reports/margin — 18.02: net margin per SKU after discounts, refunds, delivery and fees (reports.margin.read).
 * docs/metrics.md §4 "Profit of one order" for the orders delivered in the range, split over their lines (the service
 * header has the rules). Revenue figures for every holder of the report; cost of goods and delivery need cost.read,
 * commissions, profit and margin cost.read + profit.read — those columns are absent (not empty) otherwise, in the page,
 * the CSV / XLSX and the print. Beside it the books for the same dates (period figures). Sort, search, page and range
 * in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReports(context, "reports.margin.read");
  const params = parseMarginParams(new URL(request.url).searchParams, now);
  const report = await orRespond(() => marginReport(db, actor, params, locale));
  return { report, params, now };
}

export const meta: Route.MetaFunction = (args) => reportsMeta(args, "margin.title");

export default function MarginPage({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const f = useFormat();
  const { search } = useLocation();
  const { report, params, now } = loaderData;
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  const { access, totals, books } = report;
  const state = { ...params, sort: report.sort, page: 1 };
  const demoHref = `/admin/reports/margin${reportSearch("margin", { ...state, range: { ...params.range, demo: !params.range.demo } })}`;
  const sortHref = (next: DataSort) => `/admin/reports/margin${reportSearch("margin", { ...state, sort: next.key as MarginSort, dir: next.dir })}`;

  const flags = (row: MarginRow) =>
    (row.uncostedUnits ?? 0) > 0 || (row.carrierUnknownOrders ?? 0) > 0 ? (
      <span className="block type-caption text-warn">
        {(row.uncostedUnits ?? 0) > 0 ? t("margin.uncosted", { count: row.uncostedUnits ?? 0 }) : null}
        {(row.uncostedUnits ?? 0) > 0 && (row.carrierUnknownOrders ?? 0) > 0 ? " · " : null}
        {(row.carrierUnknownOrders ?? 0) > 0 ? t("margin.carrierUnknown", { count: row.carrierUnknownOrders ?? 0 }) : null}
      </span>
    ) : null;

  const columns: DataColumn<MarginRow>[] = [
    { key: "sku", header: t("col.sku"), cell: (row) => <Code>{row.sku}</Code> },
    {
      key: "name",
      header: t("col.product"),
      cell: (row) => (
        <span className="block min-w-[12rem]">
          <span className="line-clamp-2"><Name text={row.name} /></span>
          {row.used ? <span className="rep-flag">{t("margin.used")}</span> : null}
          {flags(row)}
        </span>
      ),
    },
    { key: "units", header: t("col.units"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <Num value={row.units} /> },
    { key: "revenue", header: t("col.netRevenueIqd"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <Money iqd={row.netRevenueIqd} /> },
  ];
  // the result first (seen without scrolling at 1440), then what it is made of — each a contribution to the profit:
  // cost and commissions as minus figures, the delivery result signed (a fee above the carrier's charge adds)
  if (access.profit) {
    columns.push(
      { key: "profit", header: t("col.netProfitIqd"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <b className="font-semibold"><Money iqd={row.netProfitIqd} /></b> },
      { key: "margin", header: t("col.netMarginPct"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <Bps value={row.netMarginBps} /> },
    );
  }
  if (access.cost) {
    columns.push(
      {
        key: "cogs",
        header: t("col.cogsIqd"),
        numeric: true,
        cell: (row) => (
          <span className="grid justify-items-end">
            <Money iqd={row.cogsIqd === undefined ? null : -row.cogsIqd} />
            {!row.used ? (
              <span className="type-caption text-ink-2">
                {t("margin.landedNow")} <Money iqd={row.landedCostIqd ?? null} unknown={t("margin.landedUnknown")} />
              </span>
            ) : null}
          </span>
        ),
      },
      { key: "delivery", header: t("col.deliveryIqd"), numeric: true, cell: (row) => <Money iqd={row.shippingSubsidyIqd === undefined ? null : -row.shippingSubsidyIqd} /> },
    );
  }
  if (access.profit) columns.push({ key: "commissions", header: t("col.commissionsIqd"), numeric: true, cell: (row) => <Money iqd={row.commissionsIqd === undefined ? null : -row.commissionsIqd} /> });

  const empty = (
    <EmptyState
      icon="coins"
      title={report.q ? t("margin.noMatch", { q: report.q }) : t("margin.empty")}
      text={params.range.demo ? t("common.emptyRange") : t("common.emptyRangeDemo")}
      action={
        params.range.demo || report.q ? undefined : (
          <Key as={Link} to={demoHref} size="sm" icon="plus">
            {t("range.demo")}
          </Key>
        )
      }
    />
  );

  return (
    <div ref={sheet} className="rep-print">
      <PageHead eyebrow={t("margin.eyebrow")} title={t("margin.title")} lead={t("margin.lead")} actions={<ReportActions report="margin" search={reportSearch("margin", state)} />} />
      <p className="rep-print-only type-body">
        <RangeLabel range={report.range} />
      </p>
      <RangeBar range={params.range} action="/admin/reports/margin" keep={{ sort: params.sort, dir: params.sort && params.dir === "asc" ? "asc" : null, q: params.q || null }} now={now} />
      <div className="mt-4 grid gap-3">
        <DemoShown range={params.range} href={demoHref} />
        {!access.cost ? <NeedsPermission permission="cost.read">{t("margin.needsCost")}</NeedsPermission> : !access.profit ? <NeedsPermission permission="profit.read">{t("margin.needsProfit")}</NeedsPermission> : null}
      </div>

      {report.tooMany ? (
        <Note icon="warning" tone="warn" className="mt-4">
          <p>{t("common.tooMany", { count: f.number(report.tooMany.orders), max: f.number(MAX_LINE_ORDERS) })}</p>
        </Note>
      ) : (
        <>
          <Section id="margin-totals" title={t("margin.totals")}>
            <Kpis label={t("margin.totals")}>
              <Kpi label={t("kpi.deliveredOrders")} value={<Num value={report.orders} />} hint={t("margin.ordersHint")} />
              <Kpi label={t("kpi.netRevenue")} value={<Money iqd={totals.netRevenueIqd} />} hint={t("margin.netRevenueHint")} />
              {access.cost ? <Kpi label={t("kpi.cogs")} value={<Money iqd={totals.cogsIqd === undefined ? null : -totals.cogsIqd} />} hint={t("margin.cogsHint")} /> : null}
              {access.cost ? <Kpi label={t("kpi.delivery")} value={<Money iqd={totals.shippingSubsidyIqd === undefined ? null : -totals.shippingSubsidyIqd} />} hint={t("margin.deliveryHint")} /> : null}
              {access.profit ? <Kpi label={t("kpi.netProfit")} value={<Money iqd={totals.netProfitIqd} />} hint={t("margin.profitHint")} /> : null}
              {access.profit ? <Kpi label={t("kpi.netMargin")} value={<Bps value={totals.netMarginBps} />} /> : null}
              {access.cost ? <Kpi label={t("kpi.incomplete")} value={<Num value={totals.incompleteOrders} />} hint={t("margin.incompleteHint")} /> : null}
            </Kpis>
            <dl className="rep-ledger adm-card">
              <div>
                <dt>
                  {t("margin.books")}
                  <span className="block type-caption text-ink-2">{t("margin.booksHint")}</span>
                </dt>
                <dd>
                  <Money iqd={books.netRevenueIqd} />
                </dd>
              </div>
              {books.cogsIqd !== undefined ? (
                <div>
                  <dt>{t("kpi.cogs")}</dt>
                  <dd>
                    <Money iqd={-books.cogsIqd} />
                  </dd>
                </div>
              ) : null}
              {books.netProfitIqd !== undefined ? (
                <div className="rep-ledger__total">
                  <dt>{t("kpi.netProfit")}</dt>
                  <dd>
                    <Money iqd={books.netProfitIqd} />
                  </dd>
                </div>
              ) : null}
            </dl>
          </Section>

          <Section
            id="margin-rows"
            title={t("margin.rowsTitle")}
            aside={
              <Form method="get" action="/admin/reports/margin" className="flex flex-wrap items-end gap-2">
                {params.range.period ? <input type="hidden" name="period" value={params.range.period} /> : (
                  <>
                    <input type="hidden" name="from" value={params.range.from} />
                    <input type="hidden" name="to" value={params.range.to} />
                  </>
                )}
                {params.range.demo ? <input type="hidden" name="demo" value="1" /> : null}
                {/* the sort the list shows, its direction too: a search keeps the order the employee chose */}
                {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
                {params.sort && params.dir === "asc" ? <input type="hidden" name="dir" value="asc" /> : null}
                <TextField name="q" type="search" label={t("margin.search")} hideLabel placeholder={t("margin.search")} defaultValue={params.q} className="w-56" />
                <Key type="submit" size="sm" icon="magnifying-glass">
                  {t("common.search")}
                </Key>
              </Form>
            }
          >
            <p className="type-caption text-ink-2">
              {t("margin.sortedBy", { sort: t(`margin.sort.${report.sort}`) })} · {t("common.rows", { count: report.total })}
            </p>
            <ResponsiveTable
              caption={t("margin.rowsTitle")}
              columns={columns}
              rows={report.rows}
              rowKey={(row) => row.key}
              sort={{ key: report.sort, dir: report.dir }}
              sortHref={sortHref}
              card={(row) => (
                <>
                  <p className="type-strong">
                    <Name text={row.name} /> {row.used ? <span className="rep-flag">{t("margin.used")}</span> : null}
                  </p>
                  <p className="type-caption text-ink-2">
                    <Code>{row.sku}</Code>
                  </p>
                  <Pair label={t("col.orders")}>
                    <Num value={row.orders} />
                  </Pair>
                  <Pair label={t("col.units")}>
                    <Num value={row.units} />
                  </Pair>
                  <Pair label={t("col.netRevenueIqd")}>
                    <Money iqd={row.netRevenueIqd} />
                  </Pair>
                  {access.cost ? (
                    <Pair label={t("col.cogsIqd")}>
                      <Money iqd={row.cogsIqd === undefined ? null : -row.cogsIqd} />
                    </Pair>
                  ) : null}
                  {access.profit ? (
                    <>
                      <Pair label={t("col.netProfitIqd")}>
                        <Money iqd={row.netProfitIqd} />
                      </Pair>
                      <Pair label={t("col.netMarginPct")}>
                        <Bps value={row.netMarginBps} />
                      </Pair>
                    </>
                  ) : null}
                  {flags(row)}
                </>
              )}
              empty={empty}
              footer={report.pageCount > 1 ? <Pagination page={report.page} pageCount={report.pageCount} href={(n) => withSearch(search, { page: n })} /> : null}
            />
          </Section>
        </>
      )}

      <Section id="margin-rules" title={t("common.howComputed")}>
        <Note>
          <p>{t("margin.rule")}</p>
          <p>{t("margin.feesRule")}</p>
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
