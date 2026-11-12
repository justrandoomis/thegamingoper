import { useRef } from "react";

import type { Route } from "./+types/profit";
import { useFormat } from "~/i18n/react";
import { channelProfitability } from "~/server/services/admin/channels/sales.server";
import { parseRange, type ChannelProfitRow } from "~/server/services/admin/channels/types";
import type { DataColumn } from "~/ui/DataTable";
import { DataTable } from "~/ui/DataTable";
import { Key } from "~/ui/Key";
import { RangeForm, lastMonths } from "./components/Range";
import { ChannelName, Code, Kpi, Money, Note, Num, PageHead, Pair, Percent, ResponsiveList, Section, useChT, usePrintInLight } from "./components/ui";
import { ch } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/profit — 21.06: profitability per channel for a period (channels.report.read), from the journal and
 * the definitions of docs/metrics.md: revenue, discounts, refunds, net revenue and delivery income per channel; the cost
 * of goods and carrier costs with cost.read; gross profit, the channel's contribution and the margins with cost.read
 * AND profit.read — the columns are absent (not empty) without them, here, in the loader's data and when printed. The
 * POS splits by branch. What no channel can be named for, and the commissions booked with payroll, are shown on their
 * own lines; together they add up to the store's figures from the finance core (profitAndLoss), shown beside them.
 * Prints as a report (the shell's chrome and the controls left out).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args, "channels.report.read");
  const range = parseRange(new URL(args.request.url).searchParams, req.now);
  const report = await ch.orRespond(() => channelProfitability(req.db, req.actor, range, req.locale));
  return { report, range: { period: range.period, from: range.from, to: range.to, demo: range.demo }, months: lastMonths(new Date(req.now + 3 * 3_600_000).toISOString().slice(0, 7)) };
}

/** A cost shown as what it takes away: minus, never "-0". */
const neg = (value: number | undefined) => (value === undefined ? undefined : value === 0 ? 0 : -value);

export const meta: Route.MetaFunction = (args) => chMeta(args, "profit.title");

export default function ProfitPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { report, range, months } = loaderData;
  const { fields } = report;
  // printed from a dark screen, the report is still ink on paper
  const printRef = useRef<HTMLDivElement>(null);
  usePrintInLight(printRef);
  const columns: DataColumn<ChannelProfitRow>[] = [
    {
      key: "channel",
      header: t("profit.col.channel"),
      cell: (row) => <ChannelName name={row.name} channelKey={row.key} />,
    },
    { key: "orders", header: t("profit.col.orders"), numeric: true, cell: (row) => <Num value={row.ordersRecognised} /> },
    { key: "gross", header: t("profit.col.gross"), numeric: true, cell: (row) => <Money iqd={row.grossIqd} /> },
    { key: "discounts", header: t("profit.col.discounts"), numeric: true, cell: (row) => <Money iqd={neg(row.discountsIqd)} /> },
    { key: "refunds", header: t("profit.col.refunds"), numeric: true, cell: (row) => <Money iqd={neg(row.refundsIqd)} /> },
    { key: "net", header: t("profit.col.net"), numeric: true, cell: (row) => <Money iqd={row.netRevenueIqd} /> },
    ...(fields.cost ? [{ key: "cogs", header: t("profit.col.cogs"), numeric: true, cell: (row: ChannelProfitRow) => <Money iqd={neg(row.cogsIqd)} /> }] : []),
    ...(fields.profit ? [{ key: "grossProfit", header: t("profit.col.grossProfit"), numeric: true, cell: (row: ChannelProfitRow) => <Money iqd={row.grossProfitIqd} /> }] : []),
    { key: "shipIn", header: t("profit.col.shippingIncome"), numeric: true, cell: (row) => <Money iqd={row.shippingIncomeIqd} /> },
    ...(fields.cost ? [{ key: "shipCost", header: t("profit.col.shippingCosts"), numeric: true, cell: (row: ChannelProfitRow) => <Money iqd={neg(row.shippingCostsIqd)} /> }] : []),
    ...(fields.profit
      ? [
          { key: "contribution", header: t("profit.col.contribution"), numeric: true, cell: (row: ChannelProfitRow) => <Money iqd={row.contributionIqd} /> },
          { key: "margin", header: t("profit.col.margin"), numeric: true, cell: (row: ChannelProfitRow) => <Percent bps={row.contributionMarginBps} /> },
        ]
      : []),
  ];
  const pos = report.rows.find((row) => row.key === "pos");
  const unattributedNet = report.unattributed.grossIqd - report.unattributed.discountsIqd - report.unattributed.refundsIqd;
  const anything = report.rows.some((row) => row.ordersRecognised > 0 || row.netRevenueIqd !== 0) || unattributedNet !== 0;

  return (
    <div className="ch-print" ref={printRef}>
      <PageHead
        title={t("profit.title")}
        lead={t("profit.lead")}
        actions={
          <Key icon="printer" onClick={() => window.print()}>
            {t("profit.print")}
          </Key>
        }
      />
      <p className="type-caption text-ink-2">{t("range.shown", { from: range.from, to: range.to })}</p>
      <Section id="ch-profit-range" title={t("range.title")} className="ch-noprint">
        <RangeForm range={range} months={months} path="/admin/channels/profit" />
      </Section>
      {range.demo ? (
        <Note tone="warn" icon="warning">
          <p>{t("range.demoNote")}</p>
        </Note>
      ) : null}
      {!fields.cost ? (
        <Note icon="eye-slash">
          <p>{t("profit.noCost")}</p>
        </Note>
      ) : !fields.profit ? (
        <Note icon="eye-slash">
          <p>{t("profit.noProfit")}</p>
        </Note>
      ) : null}

      <Section id="ch-profit-channels" title={t("profit.channels")} className="ch-print-block">
        <ResponsiveList
          caption={t("profit.channels")}
          columns={columns}
          rows={report.rows}
          rowKey={(row) => row.key}
          card={(row) => (
            <>
              <span className="type-strong">
                {row.name} · <Code>{row.key}</Code>
              </span>
              <Pair label={t("profit.col.orders")}>
                <Num value={row.ordersRecognised} />
              </Pair>
              <Pair label={t("profit.col.net")}>
                <Money iqd={row.netRevenueIqd} />
              </Pair>
              {fields.cost ? (
                <Pair label={t("profit.col.cogs")}>
                  <Money iqd={neg(row.cogsIqd)} />
                </Pair>
              ) : null}
              {fields.profit ? (
                <Pair label={t("profit.col.grossProfit")}>
                  <Money iqd={row.grossProfitIqd} />
                </Pair>
              ) : null}
              {fields.profit ? (
                <Pair label={t("profit.col.contribution")}>
                  <Money iqd={row.contributionIqd} /> · <Percent bps={row.contributionMarginBps} />
                </Pair>
              ) : null}
              {row.connected ? null : <p className="type-caption text-ink-2">{t("profit.notConnected")}</p>}
            </>
          )}
        />
        {!anything ? <p className="type-body text-ink-2">{t("profit.nothing")}</p> : null}
        {fields.cost && report.rows.some((row) => (row.uncostedUnits ?? 0) > 0) ? (
          <Note tone="warn" icon="warning">
            <p>{t("profit.uncosted", { list: report.rows.filter((row) => (row.uncostedUnits ?? 0) > 0).map((row) => `${row.name}: ${f.number(row.uncostedUnits ?? 0)}`).join(t("common.listSep")) })}</p>
          </Note>
        ) : null}
      </Section>

      {pos && pos.branches.length > 0 ? (
        <Section id="ch-profit-branches" title={t("profit.branches")} className="ch-print-block">
          <DataTable
            caption={t("profit.branches")}
            maxHeight={null}
            rows={pos.branches}
            rowKey={(row) => row.branchId ?? "none"}
            columns={[
              { key: "branch", header: t("profit.col.branch"), cell: (row) => row.name ?? t("profit.noBranch") },
              { key: "orders", header: t("profit.col.orders"), numeric: true, cell: (row) => <Num value={row.ordersRecognised} /> },
              { key: "net", header: t("profit.col.net"), numeric: true, cell: (row) => <Money iqd={row.netRevenueIqd} /> },
              ...(fields.cost ? [{ key: "cogs", header: t("profit.col.cogs"), numeric: true, cell: (row: (typeof pos.branches)[number]) => <Money iqd={neg(row.cogsIqd)} /> }] : []),
              ...(fields.profit ? [{ key: "gp", header: t("profit.col.grossProfit"), numeric: true, cell: (row: (typeof pos.branches)[number]) => <Money iqd={row.grossProfitIqd} /> }] : []),
            ]}
          />
        </Section>
      ) : null}

      <Section id="ch-profit-store" title={t("profit.store")} className="ch-print-block">
        <div className="ch-kpis">
          <Kpi label={t("profit.unattributed")} value={<Money iqd={unattributedNet} />} hint={t("profit.unattributedHint")} />
          {report.commissionsIqd !== undefined ? <Kpi label={t("profit.commissions")} value={<Money iqd={neg(report.commissionsIqd)} />} hint={t("profit.commissionsHint")} /> : null}
          <Kpi label={t("profit.storeNet")} value={<Money iqd={report.store.netRevenueIqd} />} hint={t("profit.storeNetHint")} />
          {report.store.netProfitIqd !== undefined ? <Kpi label={t("profit.storeProfit")} value={<Money iqd={report.store.netProfitIqd} />} hint={<Percent bps={report.store.netMarginBps ?? null} />} /> : null}
        </div>
        <Note icon="info">
          <p>{t("profit.definitions")}</p>
          <p>{t("profit.attribution")}</p>
        </Note>
      </Section>
    </div>
  );
}
