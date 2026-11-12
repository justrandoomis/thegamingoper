import { useRef } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/performance";
import { useFormat } from "~/i18n/react";
import { performanceReport, type CarrierPerformance, type EmployeePerformance as StaffRow, type SupplierPerformance } from "~/server/services/admin/reports/performance.server";
import { parsePerformanceParams, PERFORMANCE_VIEWS, reportSearch, SUPPORT_DAYS, type PerformanceParams } from "~/server/services/admin/reports/types";
import type { SupportMetrics } from "~/server/services/admin/support/metrics.server";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Status } from "~/ui/Tag";
import { reportsMeta } from "./meta";
import { openReports, orRespond } from "./reports.server";
import { ChoiceLinks, Code, DemoShown, Kpi, Kpis, Money, Name, NeedsPermission, Note, Num, PageHead, Pair, Pct, RangeBar, RangeLabel, ReportActions, ResponsiveTable, Section, usePeriodLabel, usePrintInLight, useRepT } from "./ui";

/**
 * /admin/reports/performance — 18.05: suppliers (module 09's rating), employees (module 15's month performance:
 * counter sales, refunds on them, packing — no cost, no pay), shipping (parcels handed over in the range: delivery
 * success, first-attempt success, failed tries, days to deliver, cash-on-delivery settlement time — computed here,
 * no carrier charge) and customer service (module 14's first response and resolution times). Each section never shows
 * more than its module would: the employees and service sections need staff.performance.read / support.metrics.read.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReports(context, "reports.performance.read");
  const params = parsePerformanceParams(new URL(request.url).searchParams, now);
  const report = await orRespond(() => performanceReport(db, actor, params, locale, now));
  return { report, params, now };
}

export const meta: Route.MetaFunction = (args) => reportsMeta(args, "performance.title");

/** Minutes as "45 min" or "3.5 h". */
function Duration({ minutes }: { minutes: number | null | undefined }) {
  const t = useRepT();
  const f = useFormat();
  if (minutes === null || minutes === undefined) return <span className="text-ink-2">—</span>;
  return <bdi className="nums whitespace-nowrap">{minutes < 60 ? t("common.minutesShort", { n: f.number(minutes) }) : t("common.hoursShort", { n: f.number(Math.round((minutes / 60) * 10) / 10) })}</bdi>;
}

export default function PerformancePage({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const { report, params, now } = loaderData;
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  const state: PerformanceParams = { ...params, view: report.view };
  const demoHref = `/admin/reports/performance${reportSearch("performance", { ...state, range: { ...params.range, demo: !params.range.demo } })}`;
  const section = report.sections[report.view];
  return (
    <div ref={sheet} className="rep-print">
      <PageHead eyebrow={t("performance.eyebrow")} title={t("performance.title")} lead={t("performance.lead")} actions={<ReportActions report="performance" search={reportSearch("performance", state)} exportable={section.open} />} />
      <p className="rep-print-only type-body">
        {t(`performance.view.${report.view}`)} · <RangeLabel range={params.range} />
      </p>
      <ChoiceLinks label={t("performance.views")} options={PERFORMANCE_VIEWS.map((value) => ({ value, label: t(`performance.view.${value}`) }))} current={report.view} href={(view) => `/admin/reports/performance${reportSearch("performance", { ...state, view })}`} />
      <div className="mt-3 grid gap-3">
        {report.view === "shipping" || report.view === "employees" ? <RangeBar range={params.range} action="/admin/reports/performance" keep={{ view: report.view }} now={now} /> : null}
        {report.view === "support" ? (
          <ChoiceLinks label={t("performance.supportDays")} options={SUPPORT_DAYS.map((value) => ({ value, label: t("inventory.lastDays", { count: value }) }))} current={params.days} href={(days) => `/admin/reports/performance${reportSearch("performance", { ...state, days })}`} />
        ) : null}
        <DemoShown range={params.range} href={demoHref} />
      </div>
      {!section.open && section.needs ? (
        <div className="mt-4">
          <NeedsPermission permission={section.needs}>{t(`performance.needs.${report.view}`)}</NeedsPermission>
        </div>
      ) : null}
      {report.suppliers ? <SuppliersView rows={report.suppliers.rows} windowDays={report.suppliers.windowDays} minReceipts={report.suppliers.minReceipts} demo={params.range.demo} demoHref={demoHref} /> : null}
      {report.employees ? <EmployeesView period={report.employees.period} rows={report.employees.rows} /> : null}
      {report.shipping ? <ShippingView rows={report.shipping.rows} total={report.shipping.total} truncated={report.shipping.truncated} /> : null}
      {report.support ? <SupportView metrics={report.support.metrics} /> : null}
      <Section id="performance-rules" title={t("common.howComputed")}>
        <Note>
          <p>{t(`performance.rule.${report.view}`)}</p>
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

const GRADE_TONE = { A: "ok", B: "ok", C: "warn", D: "bad" } as const;

function SuppliersView({ rows, windowDays, minReceipts, demo, demoHref }: { rows: SupplierPerformance[]; windowDays: number; minReceipts: number; demo: boolean; demoHref: string }) {
  const t = useRepT();
  const name = (row: SupplierPerformance) => (row.canOpen ? <Link to={`/admin/purchasing/suppliers/${row.id}`} className="adm-link"><Name text={row.name} /></Link> : <Name text={row.name} />);
  const grade = (row: SupplierPerformance) => (row.rating.grade ? <Status tone={GRADE_TONE[row.rating.grade]}>{t("performance.grade", { grade: row.rating.grade })}</Status> : <span className="type-caption text-ink-2">{t("performance.notEnough")}</span>);
  const columns: DataColumn<SupplierPerformance>[] = [
    { key: "name", header: t("col.supplier"), cell: (row) => <span className="grid">{name(row)}<span className="type-caption text-ink-2"><Code>{row.code}</Code></span></span> },
    { key: "grade", header: t("col.grade"), cell: grade },
    { key: "score", header: t("col.score"), numeric: true, cell: (row) => <Num value={row.rating.score} /> },
    { key: "onTime", header: t("col.onTimePct"), numeric: true, cell: (row) => <Pct value={row.rating.onTimeRate} /> },
    { key: "defects", header: t("col.defectPct"), numeric: true, cell: (row) => <Pct value={row.rating.defectRate} /> },
    { key: "receipts", header: t("col.receipts"), numeric: true, cell: (row) => <Num value={row.rating.receipts} /> },
    { key: "lead", header: t("col.leadDays"), numeric: true, cell: (row) => <Num value={row.rating.avgLeadDays} digits={1} /> },
    { key: "promised", header: t("col.promisedLeadDays"), numeric: true, cell: (row) => <Num value={row.rating.promisedLeadDays} /> },
  ];
  return (
    <Section id="performance-suppliers" title={t("performance.view.suppliers")}>
      <p className="type-caption text-ink-2">{t("performance.suppliersLead", { days: windowDays, min: minReceipts })}</p>
      <ResponsiveTable
        caption={t("performance.view.suppliers")}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        card={(row) => (
          <>
            <p className="type-strong">{name(row)}</p>
            {grade(row)}
            <Pair label={t("col.onTimePct")}>
              <Pct value={row.rating.onTimeRate} />
            </Pair>
            <Pair label={t("col.defectPct")}>
              <Pct value={row.rating.defectRate} />
            </Pair>
            <Pair label={t("col.receipts")}>
              <Num value={row.rating.receipts} />
            </Pair>
          </>
        )}
        empty={<EmptyState icon="factory" title={t("performance.suppliersEmpty")} text={demo ? undefined : t("common.emptyRangeDemo")} action={demo ? undefined : <Link to={demoHref} className="adm-link">{t("range.demo")}</Link>} />}
      />
    </Section>
  );
}

function EmployeesView({ period, rows }: { period: string; rows: StaffRow[] }) {
  const t = useRepT();
  const month = usePeriodLabel();
  const columns: DataColumn<StaffRow>[] = [
    { key: "name", header: t("col.employee"), cell: (row) => <Name text={row.employee.name} /> },
    { key: "orders", header: t("col.orders"), numeric: true, cell: (row) => <Num value={row.sales.orders} /> },
    { key: "units", header: t("col.units"), numeric: true, cell: (row) => <Num value={row.sales.units} /> },
    { key: "net", header: t("col.netSalesIqd"), numeric: true, cell: (row) => <Money iqd={row.sales.netIqd} /> },
    { key: "refunds", header: t("col.refundsIqd"), numeric: true, cell: (row) => <Money iqd={row.sales.refundsIqd ? -row.sales.refundsIqd : 0} /> },
    { key: "refundedOrders", header: t("col.refundedOrders"), numeric: true, cell: (row) => <Num value={row.sales.refundedOrders} /> },
    { key: "basket", header: t("col.basketIqd"), numeric: true, cell: (row) => <Money iqd={row.sales.basketIqd} /> },
    { key: "packed", header: t("col.packed"), numeric: true, cell: (row) => <Num value={row.packed} /> },
  ];
  return (
    <Section id="performance-employees" title={t("performance.employeesTitle", { month: month(period) })}>
      <p className="type-caption text-ink-2">{t("performance.employeesLead")}</p>
      <ResponsiveTable
        caption={t("performance.view.employees")}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.employee.id}
        card={(row) => (
          <>
            <p className="type-strong"><Name text={row.employee.name} /></p>
            <Pair label={t("col.netSalesIqd")}>
              <Money iqd={row.sales.netIqd} />
            </Pair>
            <Pair label={t("col.refundsIqd")}>
              <Money iqd={row.sales.refundsIqd ? -row.sales.refundsIqd : 0} />
            </Pair>
            <Pair label={t("col.packed")}>
              <Num value={row.packed} />
            </Pair>
          </>
        )}
        empty={<EmptyState icon="user-gear" title={t("performance.employeesEmpty")} />}
      />
    </Section>
  );
}

function ShippingView({ rows, total, truncated }: { rows: CarrierPerformance[]; total: CarrierPerformance; truncated: boolean }) {
  const t = useRepT();
  const columns: DataColumn<CarrierPerformance>[] = [
    { key: "carrier", header: t("col.carrier"), cell: (row) => (row.name ? <Name text={row.name} /> : <span>{t("performance.noCarrier")}</span>) },
    { key: "sent", header: t("col.sent"), numeric: true, cell: (row) => <Num value={row.sent} /> },
    { key: "delivered", header: t("col.delivered"), numeric: true, cell: (row) => <Num value={row.delivered} /> },
    { key: "returned", header: t("col.returned"), numeric: true, cell: (row) => <Num value={row.returned} /> },
    { key: "success", header: t("col.successPct"), numeric: true, cell: (row) => <Pct value={row.successRate} /> },
    { key: "first", header: t("col.firstAttemptPct"), numeric: true, cell: (row) => <Pct value={row.firstAttemptRate} /> },
    { key: "failed", header: t("col.failedAttempts"), numeric: true, cell: (row) => <Num value={row.failedAttempts} /> },
    { key: "days", header: t("col.deliveryDays"), numeric: true, cell: (row) => <Num value={row.medianDeliveryDays} digits={1} /> },
    { key: "settle", header: t("col.settleDays"), numeric: true, cell: (row) => <Num value={row.cod.medianSettleDays} digits={1} /> },
    { key: "awaiting", header: t("col.codAwaiting"), numeric: true, cell: (row) => <Num value={row.cod.awaiting} /> },
  ];
  return (
    <>
      <Section id="performance-shipping-totals" title={t("performance.shippingTotals")}>
        {truncated ? (
          <Note icon="warning" tone="warn">
            <p>{t("performance.truncated")}</p>
          </Note>
        ) : null}
        <Kpis label={t("performance.shippingTotals")}>
          <Kpi label={t("col.sent")} value={<Num value={total.sent} />} hint={t("performance.openHint", { count: total.open })} />
          <Kpi label={t("col.successPct")} value={<Pct value={total.successRate} />} hint={t("performance.successHint", { delivered: total.delivered, returned: total.returned })} />
          <Kpi label={t("col.firstAttemptPct")} value={<Pct value={total.firstAttemptRate} />} />
          <Kpi label={t("col.failedAttempts")} value={<Num value={total.failedAttempts} />} />
          <Kpi label={t("col.deliveryDays")} value={<Num value={total.medianDeliveryDays} digits={1} />} hint={t("performance.medianHint")} />
          <Kpi label={t("col.settleDays")} value={<Num value={total.cod.medianSettleDays} digits={1} />} hint={t("performance.settledHint", { settled: total.cod.settled, delivered: total.cod.delivered })} />
          <Kpi label={t("col.codAwaiting")} value={<Num value={total.cod.awaiting} />} hint={total.cod.oldestAwaitingDays === null ? undefined : t("performance.oldestHint", { count: total.cod.oldestAwaitingDays })} />
        </Kpis>
      </Section>
      <Section id="performance-shipping" title={t("performance.byCarrier")}>
        <ResponsiveTable
          caption={t("performance.byCarrier")}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.carrierId ?? "none"}
          card={(row) => (
            <>
              <p className="type-strong">{row.name ? <Name text={row.name} /> : t("performance.noCarrier")}</p>
              <Pair label={t("col.sent")}>
                <Num value={row.sent} />
              </Pair>
              <Pair label={t("col.successPct")}>
                <Pct value={row.successRate} />
              </Pair>
              <Pair label={t("col.firstAttemptPct")}>
                <Pct value={row.firstAttemptRate} />
              </Pair>
              <Pair label={t("col.settleDays")}>
                <Num value={row.cod.medianSettleDays} digits={1} />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="truck" title={t("performance.shippingEmpty")} text={t("common.emptyRangeDemo")} />}
        />
      </Section>
    </>
  );
}

function SupportView({ metrics }: { metrics: SupportMetrics }) {
  const t = useRepT();
  const tickets = metrics.tickets;
  type Agent = SupportMetrics["byAgent"][number];
  const columns: DataColumn<Agent>[] = [
    { key: "name", header: t("col.agent"), cell: (row) => <Name text={row.name} /> },
    { key: "answered", header: t("col.answered"), numeric: true, cell: (row) => <Num value={row.answered} /> },
    { key: "first", header: t("col.firstResponse"), numeric: true, cell: (row) => <Duration minutes={row.firstResponse.median} /> },
    { key: "resolved", header: t("col.resolved"), numeric: true, cell: (row) => <Num value={row.resolved} /> },
    { key: "resolution", header: t("col.resolution"), numeric: true, cell: (row) => <Duration minutes={row.resolution.median} /> },
  ];
  return (
    <>
      <Section id="performance-support-totals" title={t("performance.supportTotals")}>
        {metrics.truncated ? (
          <Note icon="warning" tone="warn">
            <p>{t("performance.truncated")}</p>
          </Note>
        ) : null}
        <Kpis label={t("performance.supportTotals")}>
          <Kpi label={t("performance.created")} value={<Num value={tickets.created} />} />
          <Kpi label={t("col.firstResponse")} value={<Duration minutes={tickets.firstResponse.median} />} hint={t("performance.p90", { value: tickets.firstResponse.p90 === null ? "—" : String(tickets.firstResponse.p90) })} />
          <Kpi label={t("performance.withinSla")} value={<Pct value={tickets.firstResponse.withinSla} />} hint={t("performance.withinSlaHint", { count: tickets.firstResponse.withDue })} />
          <Kpi label={t("col.resolution")} value={<Duration minutes={tickets.resolution.median} />} />
          <Kpi label={t("performance.resolvedInSla")} value={<Pct value={tickets.resolution.withinSla} />} />
          <Kpi label={t("performance.notAnswered")} value={<Num value={tickets.notAnswered} />} hint={t("performance.notAnsweredLate", { count: tickets.notAnsweredLate })} />
          <Kpi label={t("performance.backlog")} value={<Num value={metrics.backlog.open} />} hint={t("performance.backlogLate", { count: metrics.backlog.late })} />
          <Kpi label={t("performance.csat")} value={metrics.satisfaction.collected ? <Num value={metrics.satisfaction.average} digits={1} /> : <span className="text-ink-2">—</span>} hint={metrics.satisfaction.collected ? undefined : t("performance.csatNone")} />
        </Kpis>
      </Section>
      <Section id="performance-support" title={t("performance.byAgent")}>
        <ResponsiveTable
          caption={t("performance.byAgent")}
          columns={columns}
          rows={metrics.byAgent}
          rowKey={(row) => row.id}
          card={(row) => (
            <>
              <p className="type-strong"><Name text={row.name} /></p>
              <Pair label={t("col.answered")}>
                <Num value={row.answered} />
              </Pair>
              <Pair label={t("col.firstResponse")}>
                <Duration minutes={row.firstResponse.median} />
              </Pair>
              <Pair label={t("col.resolution")}>
                <Duration minutes={row.resolution.median} />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="lifebuoy" title={t("performance.supportEmpty")} />}
        />
      </Section>
    </>
  );
}
