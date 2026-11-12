import { useRef } from "react";
import { Link, useLocation } from "react-router";

import type { Route } from "./+types/inventory";
import { useFormat } from "~/i18n/react";
import type { DeadStockRow, TurnoverRow } from "~/server/services/admin/inventory/analytics.server";
import { abcReport, stockReport, type AbcReport, type AbcRow, type StockReport } from "~/server/services/admin/reports/inventory.server";
import { ABC_BASES, ABC_CLASSES, INVENTORY_VIEWS, MAX_LINE_ORDERS, parseInventoryParams, reportSearch, STOCK_DAYS, type InventoryParams } from "~/server/services/admin/reports/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { reportsMeta } from "./meta";
import { openReports, orRespond } from "./reports.server";
import { ChoiceLinks, Code, DemoShown, Kpi, Kpis, Money, Name, NeedsPermission, Note, Num, PageHead, Pair, Pct, RangeBar, RangeLabel, ReportActions, ResponsiveTable, Section, ShareBar, usePrintInLight, useRepT, When, withSearch } from "./ui";

/**
 * /admin/reports/inventory — 18.03: ABC analysis (computed here from the range's recognised sales: net revenue or
 * units per SKU, A = the SKUs that make up the first 80 %, B the next 15 %, C the rest — with the units on hand now),
 * and module 04's own stock turnover and dead-stock reports (reused through its service; they need
 * inventory.report.read and follow its cost rule). View, basis, class, period and page in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReports(context, "reports.inventory.read");
  const params = parseInventoryParams(new URL(request.url).searchParams, now);
  const [abc, stock] = await orRespond(() => Promise.all([params.view === "abc" ? abcReport(db, actor, params, locale) : Promise.resolve(null), params.view !== "abc" ? stockReport(db, actor, params, locale, now) : Promise.resolve(null)]));
  return { params, now, abc, stock };
}

export const meta: Route.MetaFunction = (args) => reportsMeta(args, "inventory.title");

export default function InventoryReportPage({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const { params, now, abc, stock } = loaderData;
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  const state = { ...params, page: 1 };
  const viewHref = (view: (typeof INVENTORY_VIEWS)[number]) => `/admin/reports/inventory${reportSearch("inventory", { ...state, view, abcClass: null })}`;
  const exportable = params.view === "abc" || (stock !== null && stock.needs === null);
  return (
    <div ref={sheet} className="rep-print">
      <PageHead eyebrow={t("inventory.eyebrow")} title={t("inventory.title")} lead={t("inventory.lead")} actions={<ReportActions report="inventory" search={reportSearch("inventory", state)} exportable={exportable} />} />
      <p className="rep-print-only type-body">
        {t(`inventory.view.${params.view}`)} · {params.view === "abc" ? <RangeLabel range={params.range} /> : t("inventory.lastDays", { count: params.days })}
      </p>
      <ChoiceLinks label={t("inventory.views")} options={INVENTORY_VIEWS.map((value) => ({ value, label: t(`inventory.view.${value}`) }))} current={params.view} href={viewHref} />
      <div className="mt-3">{params.view === "abc" ? <AbcHead params={params} now={now} /> : <DaysHead params={params} />}</div>
      {abc ? <AbcView report={abc} params={params} /> : null}
      {stock ? <StockView stock={stock} params={params} /> : null}
      <Section id="inventory-rules" title={t("common.howComputed")}>
        <Note>
          <p>{t(params.view === "abc" ? "inventory.rule.abc" : "inventory.rule.stock")}</p>
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

function AbcHead({ params, now }: { params: InventoryParams; now: number }) {
  const t = useRepT();
  const state = { ...params, page: 1 };
  return (
    <div className="grid gap-3">
      <RangeBar range={params.range} action="/admin/reports/inventory" keep={{ basis: params.basis === "revenue" ? null : params.basis, class: params.abcClass }} now={now} />
      <ChoiceLinks label={t("inventory.basis")} options={ABC_BASES.map((value) => ({ value, label: t(`inventory.basisOf.${value}`) }))} current={params.basis} href={(basis) => `/admin/reports/inventory${reportSearch("inventory", { ...state, basis })}`} />
      <DemoShown range={params.range} href={`/admin/reports/inventory${reportSearch("inventory", { ...state, range: { ...params.range, demo: false } })}`} />
    </div>
  );
}

function DaysHead({ params }: { params: InventoryParams }) {
  const t = useRepT();
  const state = { ...params, page: 1 };
  return (
    <div className="grid gap-2">
      <ChoiceLinks label={t("inventory.days")} options={STOCK_DAYS.map((value) => ({ value, label: t("inventory.lastDays", { count: value }) }))} current={params.days} href={(days) => `/admin/reports/inventory${reportSearch("inventory", { ...state, days })}`} />
      <p className="type-caption text-ink-2">{t("inventory.daysNote")}</p>
    </div>
  );
}

function ClassTag({ value }: { value: string }) {
  return (
    <span className="rep-class" data-class={value}>
      {value}
    </span>
  );
}

function AbcView({ report, params }: { report: AbcReport; params: InventoryParams }) {
  const t = useRepT();
  const f = useFormat();
  const { search } = useLocation();
  const state = { ...params, page: 1 };
  if (report.tooMany) {
    return (
      <Note icon="warning" tone="warn" className="mt-4">
        <p>{t("common.tooMany", { count: f.number(report.tooMany.orders), max: f.number(MAX_LINE_ORDERS) })}</p>
      </Note>
    );
  }
  const units = report.basis === "units";
  const columns: DataColumn<AbcRow>[] = [
    { key: "class", header: t("col.class"), cell: (row) => <ClassTag value={row.abcClass} /> },
    { key: "sku", header: t("col.sku"), cell: (row) => (report.canOpenStock && row.variantId && !row.used ? <Link to={`/admin/inventory/stock/${row.variantId}`} className="adm-link"><Code>{row.sku}</Code></Link> : <Code>{row.sku}</Code>) },
    { key: "name", header: t("col.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]"><Name text={row.name} /> {row.used ? <span className="rep-flag">{t("margin.used")}</span> : null}</span> },
    { key: "value", header: units ? t("col.units") : t("col.netRevenueIqd"), numeric: true, cell: (row) => (units ? <Num value={row.value} /> : <Money iqd={row.value} />) },
    { key: "share", header: t("col.sharePct"), numeric: true, cell: (row) => <ShareBar value={row.share} /> },
    { key: "cumulative", header: t("col.cumulativePct"), numeric: true, cell: (row) => <Pct value={row.cumulative} /> },
    { key: "onHand", header: t("col.onHandNow"), numeric: true, cell: (row) => (row.onHand === null || row.onHand === undefined ? <span className="text-ink-2">—</span> : <Num value={row.onHand} className={row.onHand <= 0 && row.abcClass === "A" ? "text-red-ink" : undefined} />) },
  ];
  return (
    <>
      <Section id="abc-classes" title={t("inventory.classes")}>
        <Kpis label={t("inventory.classes")}>
          {ABC_CLASSES.map((c) => (
            <Kpi key={c} label={t(`inventory.class.${c}`)} value={<Num value={report.classes[c].skus} />} hint={t("inventory.classHint", { share: Math.round(report.classes[c].share * 100) })} />
          ))}
          <Kpi label={t("inventory.aOut")} value={<Num value={report.aOutOfStock} />} hint={t("inventory.aOutHint")} />
        </Kpis>
      </Section>
      <Section id="abc-rows" title={t("inventory.abcRows")}>
        <ChoiceLinks
          label={t("inventory.classFilter")}
          options={[{ value: "all", label: t("common.all") }, ...ABC_CLASSES.map((value) => ({ value, label: t(`inventory.class.${value}`) }))]}
          current={report.abcClass ?? "all"}
          href={(value) => `/admin/reports/inventory${reportSearch("inventory", { ...state, abcClass: value === "all" ? null : (value as (typeof ABC_CLASSES)[number]) })}`}
        />
        <ResponsiveTable
          caption={t("inventory.abcRows")}
          columns={columns}
          rows={report.rows}
          rowKey={(row) => row.key}
          card={(row) => (
            <>
              <p className="type-strong flex items-center gap-2">
                <ClassTag value={row.abcClass} /> <Name text={row.name} />
              </p>
              <p className="type-caption text-ink-2">
                <Code>{row.sku}</Code>
              </p>
              <Pair label={units ? t("col.units") : t("col.netRevenueIqd")}>{units ? <Num value={row.value} /> : <Money iqd={row.value} />}</Pair>
              <Pair label={t("col.sharePct")}>
                <Pct value={row.share} />
              </Pair>
              <Pair label={t("col.onHandNow")}>{row.onHand === null || row.onHand === undefined ? "—" : <Num value={row.onHand} />}</Pair>
            </>
          )}
          empty={<EmptyState icon="package" title={t("inventory.abcEmpty")} text={params.range.demo ? t("common.emptyRange") : t("common.emptyRangeDemo")} action={params.range.demo ? undefined : <Key as={Link} to={`/admin/reports/inventory${reportSearch("inventory", { ...state, range: { ...params.range, demo: true } })}`} size="sm" icon="plus">{t("range.demo")}</Key>} />}
          footer={report.pageCount > 1 ? <Pagination page={report.page} pageCount={report.pageCount} href={(n) => withSearch(search, { page: n })} /> : null}
        />
      </Section>
    </>
  );
}

function StockView({ stock, params }: { stock: StockReport; params: InventoryParams }) {
  const t = useRepT();
  const { search } = useLocation();
  if (stock.needs) {
    return (
      <div className="mt-4">
        <NeedsPermission permission={stock.needs}>{t("inventory.needsModule")}</NeedsPermission>
      </div>
    );
  }
  const report = stock.report;
  const pagination = report.pageCount > 1 ? <Pagination page={report.page} pageCount={report.pageCount} href={(n) => withSearch(search, { page: n })} /> : null;
  if (report.report === "dead") {
    const withCost = report.summary.valueIqd !== undefined;
    const columns: DataColumn<DeadStockRow>[] = [
      { key: "sku", header: t("col.sku"), cell: (row) => <Code>{row.variant.sku}</Code> },
      { key: "name", header: t("col.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]"><Name text={row.variant.name} /></span> },
      { key: "onHand", header: t("col.onHand"), numeric: true, cell: (row) => <Num value={row.onHand} /> },
      { key: "lastSale", header: t("col.lastSale"), cell: (row) => (row.lastSaleAt === null ? t("inventory.neverSold") : <When at={row.lastSaleAt} />) },
      { key: "lastReceipt", header: t("col.lastReceipt"), cell: (row) => <When at={row.lastReceiptAt} /> },
    ];
    if (withCost) columns.push({ key: "value", header: t("col.stockValueIqd"), numeric: true, cell: (row) => <Money iqd={row.valueIqd ?? null} /> });
    return (
      <Section id="stock-dead" title={t("inventory.view.dead")}>
        <Kpis label={t("inventory.view.dead")}>
          <Kpi label={t("inventory.deadSkus")} value={<Num value={report.summary.variants} />} />
          <Kpi label={t("inventory.deadUnits")} value={<Num value={report.summary.units} />} />
          {withCost ? <Kpi label={t("col.stockValueIqd")} value={<Money iqd={report.summary.valueIqd ?? null} />} /> : null}
        </Kpis>
        <ResponsiveTable
          caption={t("inventory.view.dead")}
          columns={columns}
          rows={report.rows}
          rowKey={(row) => row.variant.id}
          card={(row) => (
            <>
              <p className="type-strong"><Name text={row.variant.name} /></p>
              <Pair label={t("col.onHand")}>
                <Num value={row.onHand} />
              </Pair>
              <Pair label={t("col.lastSale")}>{row.lastSaleAt === null ? t("inventory.neverSold") : <When at={row.lastSaleAt} />}</Pair>
            </>
          )}
          empty={<EmptyState icon="hourglass" title={t("inventory.deadEmpty", { count: params.days })} />}
          footer={pagination}
        />
      </Section>
    );
  }
  if (report.report !== "turnover") return null;
  const withCost = report.summary.cogsIqd !== undefined;
  const columns: DataColumn<TurnoverRow>[] = [
    { key: "sku", header: t("col.sku"), cell: (row) => <Code>{row.variant.sku}</Code> },
    { key: "name", header: t("col.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]"><Name text={row.variant.name} /></span> },
    { key: "sold", header: t("col.sold"), numeric: true, cell: (row) => <Num value={row.sold} /> },
    { key: "avg", header: t("col.averageOnHand"), numeric: true, cell: (row) => <Num value={row.averageOnHand} digits={1} /> },
    { key: "turnover", header: t("col.turnover"), numeric: true, cell: (row) => <Num value={row.turnover} digits={2} /> },
    { key: "days", header: t("col.daysOfInventory"), numeric: true, cell: (row) => <Num value={row.daysOfInventory} /> },
  ];
  if (withCost) columns.push({ key: "cogs", header: t("col.cogsIqd"), numeric: true, cell: (row) => <Money iqd={row.cogsIqd ?? null} unknown={t("inventory.cogsUnknown")} /> });
  return (
    <Section id="stock-turnover" title={t("inventory.view.turnover")}>
      <Kpis label={t("inventory.view.turnover")}>
        <Kpi label={t("col.sold")} value={<Num value={report.summary.sold} />} />
        <Kpi label={t("col.averageOnHand")} value={<Num value={report.summary.averageOnHand} digits={1} />} />
        <Kpi label={t("col.turnover")} value={<Num value={report.summary.turnover} digits={2} />} hint={t("inventory.turnoverHint", { count: params.days })} />
        {withCost ? <Kpi label={t("col.cogsIqd")} value={<Money iqd={report.summary.cogsIqd ?? null} unknown={t("inventory.cogsUnknown")} />} /> : null}
      </Kpis>
      <ResponsiveTable
        caption={t("inventory.view.turnover")}
        columns={columns}
        rows={report.rows}
        rowKey={(row) => row.variant.id}
        card={(row) => (
          <>
            <p className="type-strong"><Name text={row.variant.name} /></p>
            <Pair label={t("col.sold")}>
              <Num value={row.sold} />
            </Pair>
            <Pair label={t("col.turnover")}>
              <Num value={row.turnover} digits={2} />
            </Pair>
            <Pair label={t("col.daysOfInventory")}>
              <Num value={row.daysOfInventory} />
            </Pair>
          </>
        )}
        empty={<EmptyState icon="package" title={t("inventory.turnoverEmpty")} />}
        footer={pagination}
      />
    </Section>
  );
}
