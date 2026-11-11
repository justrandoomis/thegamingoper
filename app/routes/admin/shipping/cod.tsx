import { Link, useLocation } from "react-router";

import type { Route } from "./+types/cod";
import { useFormat } from "~/i18n/react";
import { listSettlements, parseSettlementFilters, settlementBacklog } from "~/server/services/admin/shipping/cod.server";
import { SETTLEMENT_STATUS_LIST } from "~/server/services/admin/shipping/rules";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Code, LinkChips, Money, Note, PageHead, Pair, ResponsiveList, RowLink, Section, SettlementStatus, When, useShipT, withSearch } from "./components/kit";
import { shippingMeta } from "./meta";
import { openShipping } from "./shipping.server";

/**
 * /admin/shipping/cod — 11.04: cash-on-delivery settlements with carriers. Per carrier: the completed parcels no
 * settlement holds yet and the cash its couriers still hold; the settlements by status (a draft is being put together
 * from the carrier's statement; submitted waits for reconciliation — by a second person when there is a difference;
 * reconciled is in the books; disputed waits for the carrier).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor } = await openShipping(context, "shipping.cod.settle");
  const filters = parseSettlementFilters(new URL(request.url).searchParams);
  const [backlog, settlements] = await Promise.all([settlementBacklog(db, actor), listSettlements(db, actor, filters)]);
  return { backlog, settlements, filters };
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "cod.title");

export default function CodPage({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const f = useFormat();
  const { search } = useLocation();
  const { backlog, settlements, filters } = loaderData;
  return (
    <>
      <PageHead title={t("cod.title")} lead={t("cod.lead")} />
      <Note>
        <p>{t("cod.rule")}</p>
        <p>{t("cod.books")}</p>
      </Note>

      <Section id="backlog" title={t("cod.backlog")}>
        {backlog.length === 0 ? (
          <EmptyState icon="hand-coins" title={t("cod.backlogEmpty")} />
        ) : (
          <ul role="list" className="adm-grid">
            {backlog.map((row) => (
              <li key={row.carrierId} className="adm-card">
                <p className="type-strong">{row.name}</p>
                <Pair label={t("cod.parcelsWaiting")}>{f.number(row.parcels)}</Pair>
                <Pair label={t("cod.cashHeld")}>
                  <Money iqd={row.cashIqd} />
                </Pair>
                <div>
                  <Key size="sm" as={Link} to={`/admin/shipping/cod/new?carrier=${encodeURIComponent(row.carrierId)}`} icon="plus">
                    {t("cod.newFor")}
                  </Key>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="settlements" title={t("cod.settlements")}>
        <LinkChips
          label={t("common.status")}
          items={[{ value: "all", label: t("common.all") }, ...SETTLEMENT_STATUS_LIST.map((status) => ({ value: status, label: t(`settlementStatus.${status}`) }))].map((item) => ({
            ...item,
            href: withSearch(search, { status: item.value === "all" ? null : item.value }),
            selected: filters.status === item.value,
          }))}
        />
        <ResponsiveList
          caption={t("cod.settlements")}
          rows={settlements}
          rowKey={(row) => row.id}
          columns={[
            { key: "ref", header: t("cod.ref"), cell: (row) => <RowLink to={`/admin/shipping/cod/${encodeURIComponent(row.id)}`}><Code>{row.ref}</Code></RowLink> },
            { key: "carrier", header: t("common.carrier"), cell: (row) => row.carrier },
            { key: "status", header: t("common.status"), cell: (row) => <SettlementStatus status={row.status} /> },
            { key: "parcels", header: t("cod.parcels"), numeric: true, cell: (row) => f.number(row.parcels) },
            { key: "expected", header: t("cod.expected"), numeric: true, cell: (row) => <Money iqd={row.expectedIqd} /> },
            { key: "fees", header: t("cod.fees"), numeric: true, cell: (row) => <Money iqd={row.feesIqd} /> },
            { key: "received", header: t("cod.received"), numeric: true, cell: (row) => <Money iqd={row.receivedIqd} unknown={t("cod.notYet")} /> },
            { key: "variance", header: t("cod.variance"), numeric: true, cell: (row) => <Money iqd={row.varianceIqd} unknown={t("cod.notYet")} signed /> },
            { key: "created", header: t("cod.created"), cell: (row) => <When at={row.createdAt} /> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/shipping/cod/${encodeURIComponent(row.id)}`} className="adm-link type-strong">
                  <Code>{row.ref}</Code>
                </Link>
                <SettlementStatus status={row.status} />
              </div>
              <Pair label={t("common.carrier")}>{row.carrier}</Pair>
              <Pair label={t("cod.expected")}>
                <Money iqd={row.expectedIqd} />
              </Pair>
              <Pair label={t("cod.variance")}>
                <Money iqd={row.varianceIqd} unknown={t("cod.notYet")} signed />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="scales" title={t("cod.empty")} />}
        />
      </Section>
    </>
  );
}
