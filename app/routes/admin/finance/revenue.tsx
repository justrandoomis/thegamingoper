import { Link } from "react-router";

import type { Route } from "./+types/revenue";
import { useFormat } from "~/i18n/react";
import { realisedVsPending, salesDeductions } from "~/server/services/admin/finance/revenue.server";
import { parseRange, rangeSearch } from "~/server/services/admin/finance/types";
import { EmptyState } from "~/ui/EmptyState";
import { openFinance, orRespond } from "./finance.server";
import { financeMeta } from "./meta";
import { Bps, Code, DemoTag, Kpi, Ledger, Money, Note, PageHead, RangeBar, Section, useFinT, When } from "./ui";

/**
 * /admin/finance/revenue — 10.03 realised revenue (the journal: orders delivered in the range) against the orders not
 * delivered yet (paid in advance or still to collect), and 10.04 cost of goods [cost.read], discounts and the coupons
 * behind them, refunds and goods that came back, gross margin [cost.read + profit.read]. finance.report.read. Figures
 * follow docs/metrics.md; demo data is left out unless asked for.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openFinance(context, "finance.report.read");
  const range = parseRange(new URL(request.url).searchParams, now);
  const [position, deductions] = await orRespond(() => Promise.all([realisedVsPending(db, actor, range), salesDeductions(db, actor, range)]));
  return { position, deductions, range, now };
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "revenue.title");

export default function RevenuePage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const { position, deductions, range, now } = loaderData;
  const r = position.realised;
  const statusLink = (status: string) => `/admin/orders?status=${status}`;

  return (
    <>
      <PageHead title={t("revenue.title")} lead={t("revenue.lead")} />
      <RangeBar range={range} action="/admin/finance/revenue" now={now} />

      <Section id="rev-realised" title={t("revenue.realised")} className="mt-5">
        <div className="fin-kpis">
          <Kpi icon="trend-up" label={t("revenue.netRevenue")} value={<Money iqd={r.netIqd} />} hint={t("revenue.ordersRecognised", { count: r.ordersRecognised })} />
          <Kpi icon="hourglass" label={t("revenue.pendingTotal")} value={<Money iqd={position.pending.totalIqd} />} hint={t("revenue.pendingCount", { count: position.pending.count })} />
          <Kpi icon="hand-coins" label={t("revenue.advances")} value={<Money iqd={position.pending.paidIqd} />} hint={t("revenue.advancesHint")} />
          <Kpi icon="truck" label={t("revenue.deliveredUnpaid")} value={<Money iqd={position.deliveredUnpaid.iqd} />} hint={t("revenue.deliveredUnpaidHint", { count: position.deliveredUnpaid.count })} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="adm-card content-start">
            <h3 className="adm-h3">{t("revenue.recognisedTitle")}</h3>
            <Ledger
              rows={[
                { label: t("pl.revenue"), value: <Money iqd={r.grossIqd} /> },
                { label: t("pl.discounts"), value: <Money iqd={-r.discountsIqd} /> },
                { label: t("pl.refunds"), value: <Money iqd={-r.refundsIqd} /> },
                { label: t("pl.netRevenue"), value: <Money iqd={r.netIqd} />, strong: true },
                { label: t("pl.shippingIncome"), value: <Money iqd={r.shippingIncomeIqd} />, hint: t("pl.shippingIncomeHint") },
              ]}
            />
          </div>
          <div className="adm-card content-start">
            <h3 className="adm-h3">{t("revenue.pendingTitle")}</h3>
            <Ledger
              rows={[
                ...position.pending.rows.map((row) => ({
                  label: (
                    <Link to={statusLink(row.status)} className="adm-link">
                      {t(`orderStatus.${row.status}`)} ({f.number(row.count)})
                    </Link>
                  ),
                  value: <Money iqd={row.totalIqd} />,
                  hint: row.paidIqd ? t("revenue.ofWhichPaid", { amount: f.iqd(row.paidIqd) }) : undefined,
                })),
                { label: t("revenue.pendingAll"), value: <Money iqd={position.pending.totalIqd} />, strong: true },
                { label: t("revenue.unpaid"), value: <Money iqd={position.pending.unpaidIqd} />, indent: true },
              ]}
            />
          </div>
        </div>
        <Note>
          <p>{t("revenue.whenRecognised")}</p>
          <p>{t("revenue.customerControl", { amount: f.iqd(Math.abs(position.customerControlIqd)), side: t(position.customerControlIqd >= 0 ? "revenue.owed" : "revenue.advanced") })}</p>
        </Note>
        {position.latest.length ? (
          <div className="adm-card content-start">
            <h3 className="adm-h3">{t("revenue.latest")}</h3>
            <ul className="grid gap-1">
              {position.latest.map((order) => (
                <li key={order.ref} className="flex flex-wrap items-baseline justify-between gap-2 type-body">
                  <Link to={`/admin/orders/${order.ref}`} className="adm-link">
                    <Code>{order.ref}</Code>
                  </Link>
                  <span className="flex items-baseline gap-2">
                    <When at={order.deliveredAt} />
                    <Money iqd={order.totalIqd} />
                    <DemoTag show={order.isDemo} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState title={t("revenue.noneDelivered")} text={range.demo ? undefined : t("revenue.noneDeliveredHint")} icon="truck" />
        )}
      </Section>

      <Section id="rev-deductions" title={t("revenue.deductions")}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="adm-card content-start">
            <h3 className="adm-h3">{t("revenue.costTitle")}</h3>
            {deductions.cost ? (
              <Ledger
                rows={[
                  { label: t("pl.netRevenue"), value: <Money iqd={deductions.revenue.netIqd} /> },
                  { label: t("pl.cogs"), value: <Money iqd={-deductions.cost.cogsIqd} />, hint: t("pl.cogsHint") },
                  ...(deductions.margin
                    ? [
                        { label: t("pl.grossProfit"), value: <Money iqd={deductions.margin.grossIqd} />, strong: true },
                        { label: t("pl.grossMargin"), value: <Bps value={deductions.margin.marginBps} /> },
                      ]
                    : []),
                  { label: t("revenue.restocked"), value: <Money iqd={deductions.cost.restockedIqd} />, hint: t("revenue.restockedHint") },
                  { label: t("revenue.writtenOff"), value: <Money iqd={deductions.cost.writtenOffIqd} /> },
                ]}
              />
            ) : (
              <Note icon="lock">
                <p>{t("common.needsCost")}</p>
              </Note>
            )}
            {deductions.cost && deductions.cost.uncostedUnits > 0 ? (
              <Note tone="warn" icon="warning">
                <p>{t("pl.uncosted", { count: deductions.cost.uncostedUnits })}</p>
              </Note>
            ) : null}
            {deductions.cost && !deductions.margin ? <p className="type-caption text-ink-2">{t("common.needsProfit")}</p> : null}
          </div>
          <div className="adm-card content-start">
            <h3 className="adm-h3">{t("revenue.discountsTitle")}</h3>
            <Ledger
              rows={[
                { label: t("pl.discounts"), value: <Money iqd={deductions.revenue.discountsIqd} />, strong: true },
                ...deductions.coupons.map((coupon) => ({ label: <span><Code>{coupon.code}</Code> ({f.number(coupon.count)})</span>, value: <Money iqd={coupon.iqd} />, indent: true })),
                { label: t("revenue.otherDiscounts"), value: <Money iqd={deductions.otherDiscountsIqd} />, indent: true, hint: t("revenue.otherDiscountsHint") },
              ]}
            />
            {deductions.coupons.length === 0 ? <p className="type-caption text-ink-2">{t("revenue.noCoupons")}</p> : null}
          </div>
          <div className="adm-card content-start">
            <h3 className="adm-h3">{t("revenue.refundsTitle")}</h3>
            <Ledger
              rows={[
                { label: t("pl.refunds"), value: <Money iqd={deductions.revenue.refundsIqd} />, strong: true, hint: t("pl.refundsHint") },
                ...deductions.refunds.map((refund) => ({ label: `${t(`refundMethod.${refund.method}`)} (${f.number(refund.count)})`, value: <Money iqd={refund.iqd} />, indent: true })),
                { label: t("revenue.refundsPaid"), value: <Money iqd={deductions.refundsPaidIqd} /> },
                { label: t("revenue.pendingRefunds", { count: deductions.pendingRefunds.count }), value: <Money iqd={deductions.pendingRefunds.iqd} /> },
              ]}
            />
            <p className="type-caption">
              <Link to="/admin/orders/refunds" className="adm-link">
                {t("revenue.openRefunds")}
              </Link>
            </p>
          </div>
        </div>
      </Section>
      <p className="type-caption text-ink-2">
        <Link to={`/admin/finance/reports${rangeSearch(range)}`} className="adm-link">
          {t("revenue.toPl")}
        </Link>
      </p>
    </>
  );
}
