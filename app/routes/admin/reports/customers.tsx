import { useRef, type CSSProperties } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/customers";
import { can } from "~/server/actor";
import { customerReport, type CohortRow, type SegmentValue } from "~/server/services/admin/reports/customers.server";
import { COHORT_MONTHS, CUSTOMER_VIEWS, parseCustomerParams, reportSearch } from "~/server/services/admin/reports/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { reportsMeta } from "./meta";
import { openReports, orRespond } from "./reports.server";
import { Bps, ChoiceLinks, DemoShown, Kpi, Kpis, Money, Note, Num, PageHead, Pair, Pct, RangeBar, RangeLabel, ReportActions, ResponsiveTable, Section, ShareBar, usePeriodLabel, usePrintInLight, useRepT } from "./ui";

/**
 * /admin/reports/customers — 18.04: cohorts by the month of the first purchase with the share that bought again in
 * each later month, repeat purchases and value per customer, and every customer's value by module 07's RFM segment
 * (its rules: rfmOf). A purchase is module 07's (paid and not paid back in full, never cancelled); aggregates only —
 * no name or phone. Range, view and demo switch in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openReports(context, "reports.customer.read");
  const params = parseCustomerParams(new URL(request.url).searchParams, now);
  const report = await orRespond(() => customerReport(db, actor, params, now));
  return { report, params, now, canOpenSegments: can(actor, "customers.customer.read") };
}

export const meta: Route.MetaFunction = (args) => reportsMeta(args, "customers.title");

export default function CustomersReportPage({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const { report, params, now, canOpenSegments } = loaderData;
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  const demoHref = `/admin/reports/customers${reportSearch("customers", { ...params, range: { ...params.range, demo: !params.range.demo } })}`;
  const r = report.repeat;
  return (
    <div ref={sheet} className="rep-print">
      <PageHead eyebrow={t("customers.eyebrow")} title={t("customers.title")} lead={t("customers.lead")} actions={<ReportActions report="customers" search={reportSearch("customers", params)} />} />
      <p className="rep-print-only type-body">
        {t(`customers.view.${params.view}`)} · <RangeLabel range={params.range} />
      </p>
      <ChoiceLinks label={t("customers.views")} options={CUSTOMER_VIEWS.map((value) => ({ value, label: t(`customers.view.${value}`) }))} current={params.view} href={(view) => `/admin/reports/customers${reportSearch("customers", { ...params, view })}`} />
      <div className="mt-3 grid gap-3">
        {params.view === "cohorts" ? <RangeBar range={params.range} action="/admin/reports/customers" now={now} /> : (
          <Key as={Link} to={demoHref} size="sm" icon={params.range.demo ? "x" : "plus"} className="justify-self-start">
            {params.range.demo ? t("range.hideDemo") : t("range.demo")}
          </Key>
        )}
        <DemoShown range={params.range} href={demoHref} />
      </div>

      {params.view === "cohorts" ? (
        <>
          <Section id="customers-repeat" title={t("customers.repeatTitle")}>
            <Kpis label={t("customers.repeatTitle")}>
              <Kpi label={t("customers.newCustomers")} value={<Num value={r.customers} />} hint={t("customers.newCustomersHint")} />
              <Kpi label={t("customers.repeatRate")} value={<Bps value={r.repeatBps} />} hint={t("customers.repeaters", { count: r.repeaters })} />
              <Kpi label={t("customers.daysToSecond")} value={<Num value={r.medianDaysToSecond} />} hint={t("customers.daysToSecondHint")} />
              <Kpi label={t("customers.purchasesPerCustomer")} value={<Num value={r.purchasesPerCustomer} digits={2} />} />
              <Kpi label={t("customers.valuePerCustomer")} value={<Money iqd={r.valuePerCustomerIqd} />} hint={t("customers.keptHint")} />
              <Kpi label={t("customers.guests")} value={<Num value={report.guestPurchases} />} hint={t("customers.guestsHint")} />
            </Kpis>
          </Section>
          <Section id="customers-cohorts" title={t("customers.cohortsTitle")}>
            <p className="type-caption text-ink-2">{t("customers.cohortsLead")}</p>
            {report.cohorts.length === 0 ? (
              <EmptyState
                icon="users"
                title={t("customers.cohortsEmpty")}
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
              <CohortTable rows={report.cohorts} />
            )}
          </Section>
        </>
      ) : report.value ? (
        <ValueView value={report.value} canOpenSegments={canOpenSegments} />
      ) : null}

      <Section id="customers-rules" title={t("common.howComputed")}>
        <Note>
          <p>{t("customers.rule")}</p>
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

function CohortTable({ rows }: { rows: CohortRow[] }) {
  const t = useRepT();
  const month = usePeriodLabel();
  return (
    <>
      <div className="rep-table hidden overflow-x-auto md:block" role="region" aria-label={t("customers.cohortsTitle")} tabIndex={0}>
        <table className="rep-cohorts w-full">
          <caption className="sr-only">{t("customers.cohortsTitle")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("col.cohort")}</th>
              <th scope="col">{t("col.customers")}</th>
              {Array.from({ length: COHORT_MONTHS }, (_, k) => (
                <th key={k} scope="col">
                  {t("customers.monthN", { n: k })}
                </th>
              ))}
              <th scope="col">{t("col.valuePerCustomerIqd")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.cohort}>
                <th scope="row">{month(row.cohort)}</th>
                <td>
                  <Num value={row.customers} />
                </td>
                {row.retention.map((value, k) =>
                  value === null ? (
                    <td key={k} data-empty="">
                      —
                    </td>
                  ) : (
                    <td key={k} data-level="" style={{ "--level": value } as CSSProperties}>
                      <Pct value={value} />
                    </td>
                  ),
                )}
                <td>
                  <Money iqd={row.valuePerCustomerIqd} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul role="list" aria-label={t("customers.cohortsTitle")} className="rep-cards grid gap-2 md:hidden">
        {rows.map((row) => (
          <li key={row.cohort} className="adm-card gap-1.5">
            <p className="type-strong">{month(row.cohort)}</p>
            <Pair label={t("col.customers")}>
              <Num value={row.customers} />
            </Pair>
            {[1, 2, 3].map((k) => (
              <Pair key={k} label={t("customers.monthN", { n: k })}>
                <Pct value={row.retention[k] ?? null} />
              </Pair>
            ))}
            <Pair label={t("col.valuePerCustomerIqd")}>
              <Money iqd={row.valuePerCustomerIqd} />
            </Pair>
          </li>
        ))}
      </ul>
    </>
  );
}

function ValueView({ value, canOpenSegments }: { value: NonNullable<Awaited<ReturnType<typeof customerReport>>["value"]>; canOpenSegments: boolean }) {
  const t = useRepT();
  const columns: DataColumn<SegmentValue>[] = [
    { key: "segment", header: t("col.segment"), cell: (row) => <span>{t(`segment.${row.segment}`)}</span> },
    { key: "customers", header: t("col.customers"), numeric: true, cell: (row) => <Num value={row.customers} /> },
    { key: "share", header: t("col.sharePct"), numeric: true, cell: (row) => <ShareBar value={row.shareBps === null ? null : row.shareBps / 10_000} /> },
    { key: "kept", header: t("col.keptIqd"), numeric: true, cell: (row) => <Money iqd={row.keptIqd} /> },
    { key: "avg", header: t("col.avgKeptIqd"), numeric: true, cell: (row) => <Money iqd={row.avgKeptIqd} unknown={t("customers.noCustomers")} /> },
  ];
  return (
    <>
      <Section id="customers-value" title={t("customers.valueTitle")}>
        <Kpis label={t("customers.valueTitle")}>
          <Kpi label={t("customers.withPurchase")} value={<Num value={value.customers} />} />
          <Kpi label={t("customers.keptTotal")} value={<Money iqd={value.keptIqd} />} hint={t("customers.keptHint")} />
          <Kpi label={t("customers.valuePerCustomer")} value={<Money iqd={value.avgKeptIqd} />} />
          <Kpi label={t("customers.medianValue")} value={<Money iqd={value.medianKeptIqd} />} />
          <Kpi label={t("customers.repeatRate")} value={<Bps value={value.repeatBps} />} />
        </Kpis>
      </Section>
      <Section
        id="customers-segments"
        title={t("customers.segmentsTitle")}
        aside={
          canOpenSegments ? (
            <Link to="/admin/customers/segments" className="adm-link">
              {t("customers.toSegments")}
            </Link>
          ) : null
        }
      >
        <p className="type-caption text-ink-2">{t("customers.segmentsLead")}</p>
        {value.customers === 0 ? (
          <EmptyState icon="users" title={t("customers.valueEmpty")} />
        ) : (
          <ResponsiveTable
            caption={t("customers.segmentsTitle")}
            columns={columns}
            rows={value.segments}
            rowKey={(row) => row.segment}
            card={(row) => (
              <>
                <p className="type-strong">{t(`segment.${row.segment}`)}</p>
                <Pair label={t("col.customers")}>
                  <Num value={row.customers} />
                </Pair>
                <Pair label={t("col.keptIqd")}>
                  <Money iqd={row.keptIqd} />
                </Pair>
                <Pair label={t("col.avgKeptIqd")}>
                  <Money iqd={row.avgKeptIqd} unknown={t("customers.noCustomers")} />
                </Pair>
              </>
            )}
          />
        )}
      </Section>
    </>
  );
}
