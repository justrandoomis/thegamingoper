import { useRef } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/performance";
import { throwAsResponse } from "~/server/errors";
import { performanceReport, type CampaignFigures, type MonthFigures } from "~/server/services/admin/marketing/performance.server";
import { SECTION_READ } from "~/server/services/admin/marketing/shared.server";
import { monthRangeSearch, parseMonthRange } from "~/server/services/admin/marketing/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Checkbox, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { marketingMeta } from "./meta";
import { openMarketing } from "./marketing.server";
import { Kpis, Money, Notice, Num, Section, usePrintInLight, useMarketingT } from "./ui";

/**
 * /admin/marketing/performance — 16.07: CAC, ROAS and LTV per month and per campaign, each with its definition
 * (docs/metrics.md §8) and the source of its numbers. Spend is what staff entered on the campaigns (measured nowhere
 * else); attribution only from orders that carry their source (none yet); LTV from real orders. A figure that cannot
 * be computed says why — never 0. The months and demo in the URL; CSV (audited) and a print view.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openMarketing(context, SECTION_READ.performance);
  const range = parseMonthRange(new URL(request.url).searchParams, now);
  try {
    return { report: await performanceReport(db, actor, range, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, "performance.title");

export default function PerformancePage({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const navigation = useNavigation();
  const printRef = useRef<HTMLDivElement | null>(null);
  usePrintInLight(printRef);
  const { report } = loaderData;
  const busy = navigation.state === "loading";
  const notAvailable = (why: string) => <span className="type-body text-ink-2">{why}</span>;

  const monthColumns: DataColumn<MonthFigures>[] = [
    { key: "period", header: t("performance.col.month"), cell: (row) => <bdi className="nums">{row.period}</bdi> },
    { key: "spend", header: t("performance.col.spend"), numeric: true, cell: (row) => (row.spendIqd === null ? <span className="text-ink-2">{t("common.noneEntered")}</span> : <Money iqd={row.spendIqd} />) },
    { key: "new", header: t("performance.col.newCustomers"), numeric: true, cell: (row) => <Num value={row.newCustomers} /> },
    { key: "cac", header: t("performance.col.cac"), numeric: true, cell: (row) => (row.cacIqd === null ? <span className="text-ink-2">{row.spendIqd === null ? t("performance.why.noSpend") : t("performance.why.noNew")}</span> : <Money iqd={row.cacIqd} />) },
    { key: "attributed", header: t("performance.col.attributed"), numeric: true, cell: (row) => <Num value={row.attributedOrders} /> },
  ];
  const campaignColumns: DataColumn<CampaignFigures>[] = [
    { key: "name", header: t("performance.col.campaign"), cell: (row) => <Link to={`/admin/marketing/campaigns/${row.id}`} className="adm-link">{row.name}</Link> },
    { key: "channel", header: t("campaigns.col.channel"), cell: (row) => t(`channel.${row.channel}`) },
    { key: "spend", header: t("performance.col.spend"), numeric: true, cell: (row) => (row.spendIqd === null ? <span className="text-ink-2">{t("common.noneEntered")}</span> : <Money iqd={row.spendIqd} />) },
    { key: "budget", header: t("campaigns.col.budget"), numeric: true, cell: (row) => <Money iqd={row.budgetIqd} none={t("common.notSet")} /> },
    { key: "orders", header: t("performance.col.attributed"), numeric: true, cell: (row) => <Num value={row.attributedOrders} /> },
    { key: "roas", header: t("performance.col.roas"), numeric: true, cell: (row) => (row.roas === null ? <span className="text-ink-2">{report.sources.attributionCaptured ? t("performance.why.noAttributed") : t("performance.why.notCaptured")}</span> : <Num value={row.roas} digits={2} />) },
  ];

  return (
    <div ref={printRef} className="mkt-print">
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "16.07" })}</p>
        <h1 className="adm-title">{t("performance.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("performance.lead", { from: report.range.from, to: report.range.to })}</p>
      </header>

      <div className="mkt-noprint">
        <Form method="get" action="/admin/marketing/performance" className="flex flex-wrap items-end gap-3">
          <TextField name="from" type="month" label={t("common.from")} defaultValue={report.range.from} />
          <TextField name="to" type="month" label={t("common.to")} defaultValue={report.range.to} />
          <Checkbox name="demo" value="1" label={t("common.includeDemo")} defaultChecked={report.range.demo} />
          <Key type="submit" size="sm" icon="funnel" loading={busy}>
            {t("common.apply")}
          </Key>
          <Key as="a" href={`/admin/marketing/performance/csv${monthRangeSearch(report.range)}`} size="sm" icon="download-simple">
            {t("common.csv")}
          </Key>
          <Key size="sm" icon="printer" onClick={() => window.print()}>
            {t("common.print")}
          </Key>
        </Form>
      </div>

      <Section id="mkt-perf-kpis" title={t("performance.summary")}>
        <Kpis
          items={[
            { label: t("performance.spend"), value: report.totals.spendIqd === null ? notAvailable(t("common.noneEntered")) : <Money iqd={report.totals.spendIqd} />, note: t("performance.spendSource", { count: report.totals.spendEntries, n: report.sources.spendCampaigns }) },
            { label: t("performance.newCustomers"), value: <Num value={report.totals.newCustomers} />, note: t("performance.newSource") },
            { label: t("performance.cac"), value: report.totals.cacIqd === null ? notAvailable(report.totals.spendIqd === null ? t("performance.why.noSpend") : t("performance.why.noNew")) : <Money iqd={report.totals.cacIqd} />, note: t("performance.cacDef") },
            { label: t("performance.roas"), value: report.totals.roas === null ? notAvailable(report.sources.attributionCaptured ? t("performance.why.noAttributed") : t("performance.why.notCaptured")) : <Num value={report.totals.roas} digits={2} />, note: t("performance.roasDef") },
            { label: t("performance.ltvCohort"), value: report.ltv.cohortAvgPaidIqd === null ? notAvailable(t("performance.why.noCohort")) : <Money iqd={report.ltv.cohortAvgPaidIqd} />, note: t("performance.ltvCohortNote", { count: report.ltv.cohort }) },
            { label: t("performance.ltvAll"), value: report.ltv.avgPaidIqd === null ? notAvailable(t("performance.why.noCustomers")) : <Money iqd={report.ltv.avgPaidIqd} />, note: t("performance.ltvAllNote", { count: report.ltv.customers }) },
            { label: t("performance.ordersPer"), value: <Num value={report.ltv.avgOrders} digits={1} />, note: t("performance.ordersPerNote") },
            { label: t("performance.ltvToCac"), value: report.ltvToCac === null ? notAvailable(t("performance.why.ratio")) : <Num value={report.ltvToCac} digits={1} />, note: t("performance.ltvToCacDef") },
          ]}
        />
        {!report.sources.attributionCaptured ? (
          <Notice icon="plugs-connected" tone="warn">
            {t("attribution.notCaptured")}
          </Notice>
        ) : null}
      </Section>

      <Section id="mkt-perf-months" title={t("performance.byMonth")}>
        <DataTable caption={t("performance.byMonth")} columns={monthColumns} rows={report.months} rowKey={(row) => row.period} maxHeight={null} />
      </Section>

      <Section id="mkt-perf-campaigns" title={t("performance.byCampaign")} lead={t("performance.byCampaignLead")}>
        {report.campaigns.length === 0 ? (
          <p className="type-body text-ink-2">{t("performance.noCampaigns")}</p>
        ) : (
          <DataTable caption={t("performance.byCampaign")} columns={campaignColumns} rows={report.campaigns} rowKey={(row) => row.id} maxHeight={null} />
        )}
      </Section>

      <Section id="mkt-perf-defs" title={t("performance.definitions")}>
        <ul className="mkt-rows">
          {(["spend", "customer", "new", "cac", "roas", "ltv", "ratio"] as const).map((id) => (
            <li key={id} className="mkt-row">
              <span className="type-strong">{t(`performance.def.${id}.term`)}</span>
              <span className="max-w-[70ch] type-body text-ink-2">{t(`performance.def.${id}.text`)}</span>
            </li>
          ))}
        </ul>
        <Notice icon="info">{t("performance.noCost")}</Notice>
      </Section>
    </div>
  );
}
