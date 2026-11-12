import { Link } from "react-router";

import type { Route } from "./+types/orders";
import { useFormat } from "~/i18n/react";
import { ordersByChannel } from "~/server/services/admin/channels/sales.server";
import { parseRange, type ChannelOrderSummary } from "~/server/services/admin/channels/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { RangeForm, lastMonths } from "./components/Range";
import { ChannelName, Code, Money, Note, Num, PageHead, Pair, ResponsiveList, Section, StatusText, When, useChT } from "./components/ui";
import { ch } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/orders — 21.02: the orders of every channel in one place for a period (orders.order.read): placed,
 * open, delivered, cancelled, returned, GMV and the average basket (docs/metrics.md §3), each channel linked to the list
 * that shows its orders — module 05's order list holds the online store's and the POS's orders together; the POS's
 * sales list (06) holds the till's. A marketplace channel shows that no order can arrive from it (not connected).
 * Demo orders are left out unless the period asks for them (&demo=1).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args, "orders.order.read");
  const range = parseRange(new URL(args.request.url).searchParams, req.now);
  const rows = await ch.orRespond(() => ordersByChannel(req.db, req.actor, range, req.locale));
  return { rows, range: { period: range.period, from: range.from, to: range.to, demo: range.demo }, months: lastMonths(new Date(req.now + 3 * 3_600_000).toISOString().slice(0, 7)) };
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "orders.title");

export default function OrdersByChannelPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { rows, range, months } = loaderData;
  const total = rows.reduce((sum, row) => sum + row.placed, 0);
  const listCell = (row: ChannelOrderSummary) =>
    row.list ? (
      <Link to={row.list} className="adm-link">
        {t(row.key === "pos" && row.list.startsWith("/admin/pos") ? "orders.openSales" : "orders.openList")}
      </Link>
    ) : (
      <span className="text-ink-2">{row.connected ? t("orders.noAccess") : t("sales.notConnected")}</span>
    );
  const columns: DataColumn<ChannelOrderSummary>[] = [
    {
      key: "channel",
      header: t("orders.col.channel"),
      cell: (row) => <ChannelName name={row.name} channelKey={row.key} />,
    },
    { key: "placed", header: t("orders.col.placed"), numeric: true, cell: (row) => <Num value={row.placed} /> },
    { key: "open", header: t("orders.col.open"), numeric: true, cell: (row) => <Num value={row.open} /> },
    { key: "delivered", header: t("orders.col.delivered"), numeric: true, cell: (row) => <Num value={row.delivered} /> },
    { key: "cancelled", header: t("orders.col.cancelled"), numeric: true, cell: (row) => <Num value={row.cancelled} /> },
    { key: "returned", header: t("orders.col.returned"), numeric: true, cell: (row) => <Num value={row.returned} /> },
    { key: "gmv", header: t("orders.col.gmv"), numeric: true, cell: (row) => <Money iqd={row.gmvIqd} /> },
    { key: "basket", header: t("orders.col.basket"), numeric: true, cell: (row) => <Money iqd={row.averageBasketIqd} /> },
    { key: "last", header: t("orders.col.last"), cell: (row) => <When at={row.lastPlacedAt} /> },
    { key: "list", header: t("orders.col.list"), cell: listCell },
  ];
  return (
    <>
      <PageHead title={t("orders.title")} lead={t("orders.lead")} />
      <Section id="ch-orders-range" title={t("range.title")} aside={<span className="type-caption text-ink-2">{t("range.shown", { from: range.from, to: range.to })}</span>}>
        <RangeForm range={range} months={months} path="/admin/channels/orders" />
        {range.demo ? (
          <Note tone="warn" icon="warning">
            <p>{t("range.demoNote")}</p>
          </Note>
        ) : null}
      </Section>
      <Section id="ch-orders" title={t("orders.list")} aside={<span className="type-caption text-ink-2">{t("orders.total", { count: total })}</span>}>
        <ResponsiveList
          caption={t("orders.list")}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.key}
          empty={<EmptyState icon="receipt" title={t("orders.empty")} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">
                  {row.name} · <Code>{row.key}</Code>
                </span>
                {row.connected ? null : <StatusText tone="warn">{t("sales.notConnected")}</StatusText>}
              </div>
              <Pair label={t("orders.col.placed")}>
                <Num value={row.placed} />
              </Pair>
              <Pair label={t("orders.col.open")}>
                <Num value={row.open} />
              </Pair>
              <Pair label={t("orders.col.delivered")}>
                <Num value={row.delivered} />
              </Pair>
              <Pair label={t("orders.col.cancelled")}>{`${f.number(row.cancelled)} · ${t("orders.col.returned")} ${f.number(row.returned)}`}</Pair>
              <Pair label={t("orders.col.gmv")}>
                <Money iqd={row.gmvIqd} />
              </Pair>
              <Pair label={t("orders.col.basket")}>
                <Money iqd={row.averageBasketIqd} />
              </Pair>
              <Pair label={t("orders.col.list")}>{listCell(row)}</Pair>
            </>
          )}
        />
        {total === 0 ? <p className="type-body text-ink-2">{t("orders.nonePeriod")}</p> : null}
        <Note icon="info">
          <p>{t("orders.unifiedNote")}</p>
          <p>{t("orders.marketplaceNote")}</p>
        </Note>
      </Section>
    </>
  );
}
