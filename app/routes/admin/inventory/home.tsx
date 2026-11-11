import { Link } from "react-router";

import type { Route } from "./+types/home";
import { useFormat } from "~/i18n/react";
import { inventoryOverview } from "~/server/services/admin/inventory/analytics.server";
import { recentMovements } from "~/server/services/admin/inventory/stock.server";
import { Key } from "~/ui/Key";
import { ModuleFunctions } from "../blueprint-status";
import { adminMeta } from "../shell/meta";
import { Code, Kpi, Money, Num, PageHead, ResponsiveList, Pair, RowLink, Section, When, useInvT } from "./components/kit";
import { openInventory } from "./inventory.server";

/**
 * /admin/inventory — the module's home: what waits for a decision (raised cards only when there is something to
 * do), the figures now, quick actions, the latest movements and the blueprint status of functions 04.01–04.12.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.stock.read");
  const overview = await inventoryOverview(db, actor, now);
  const recent = overview.access.movements ? await recentMovements(db, actor, 8, locale) : [];
  return { overview, recent };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.inventory"));

export default function InventoryHome({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { overview, recent } = loaderData;
  const { access, decisions, totals } = overview;
  const cards = [
    { id: "counts", count: access.countApprove ? decisions.countsToApprove : 0, text: t("overview.countsToApprove", { count: decisions.countsToApprove }), href: "/admin/inventory/counts?status=review" },
    { id: "transfers", count: access.transferReceive ? decisions.transfersToReceive : 0, text: t("overview.transfersToReceive", { count: decisions.transfersToReceive }), href: "/admin/inventory/transfers?status=in_transit" },
    { id: "drafts", count: access.transferCreate ? decisions.draftsToShip : 0, text: t("overview.draftsToShip", { count: decisions.draftsToShip }), href: "/admin/inventory/transfers?status=draft" },
    { id: "oversold", count: access.adjust || access.receive ? decisions.oversoldLevels : 0, text: t("overview.oversold", { count: decisions.oversoldLevels }), href: "/admin/inventory/oversell" },
    { id: "expiring", count: decisions.reservationsExpiring, text: t("overview.expiring", { count: decisions.reservationsExpiring }), href: "/admin/inventory/reservations?status=expiring" },
    { id: "reorder", count: decisions.belowReorder, text: t("overview.belowReorder", { count: decisions.belowReorder }), href: "/admin/inventory/reorder?show=below_reorder" },
  ].filter((card) => card.count > 0);

  return (
    <>
      <PageHead eyebrow={`04 · P0`} title={t("overview.title")} lead={t("overview.lead")} />

      <Section id="inv-waiting" title={t("overview.waiting")}>
        {cards.length > 0 ? (
          <div className="adm-grid">
            {cards.map((card) => (
              <article key={card.id} className="adm-card adm-card--act">
                <p className="type-kpi nums">
                  <bdi>{f.number(card.count)}</bdi>
                </p>
                <p className="type-body text-ink">{card.text}</p>
                <div>
                  <Key as={Link} to={card.href} size="sm" iconEnd="arrow-right">
                    {t("overview.openThem")}
                  </Key>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="adm-card">
            <p className="type-strong text-ink">{t("overview.nothingWaiting")}</p>
          </div>
        )}
      </Section>

      <Section id="inv-figures" title={t("overview.figures")}>
        <div className="inv-kpis">
          <Kpi label={t("overview.skusInStock")} value={f.number(totals.skusInStock)} />
          <Kpi label={t("overview.unitsOnHand")} value={f.number(totals.onHand)} />
          <Kpi label={t("overview.unitsReserved")} value={f.number(totals.reserved)} />
          <Kpi label={t("overview.unitsAvailable")} value={f.number(totals.available)} />
          <Kpi label={t("overview.unitsIncoming")} value={f.number(totals.incoming)} />
          <Kpi label={t("overview.lowStock")} value={f.number(totals.low)} />
          <Kpi label={t("overview.outOfStock")} value={f.number(totals.out)} />
          <Kpi label={t("overview.locationsCount")} value={f.number(overview.locations)} />
          {overview.value ? <Kpi wide label={t("overview.stockValue")} value={<Money iqd={overview.value.valueIqd} />} hint={overview.value.unlayeredUnits > 0 ? t("overview.stockValueHint", { count: overview.value.unlayeredUnits }) : undefined} /> : null}
        </div>
      </Section>

      <Section id="inv-quick" title={t("overview.quick")}>
        <div className="flex flex-wrap gap-2">
          {access.receive ? (
            <Key as={Link} to="/admin/inventory/receive" icon="package">
              {t("overview.receiveGoods")}
            </Key>
          ) : null}
          {access.transferCreate ? (
            <Key as={Link} to="/admin/inventory/transfers#new" icon="swap">
              {t("overview.newTransfer")}
            </Key>
          ) : null}
          {access.countPerform ? (
            <Key as={Link} to="/admin/inventory/counts#start" icon="clipboard-text">
              {t("overview.startCount")}
            </Key>
          ) : null}
          <Key as={Link} to="/admin/inventory/locations" icon="barcode">
            {t("overview.printLabels")}
          </Key>
        </div>
      </Section>

      {access.movements ? (
        <Section
          id="inv-recent"
          title={t("overview.recent")}
          aside={
            <Link to="/admin/inventory/movements" className="adm-link type-label">
              {t("overview.seeAll")}
            </Link>
          }
        >
          <ResponsiveList
            caption={t("overview.recent")}
            rows={recent}
            rowKey={(row) => row.id}
            columns={[
              { key: "at", header: t("common.when"), cell: (row) => <When at={row.at} /> },
              { key: "kind", header: t("movements.kind"), cell: (row) => t(`kinds.${row.kind}`) },
              { key: "sku", header: t("common.sku"), cell: (row) => (row.variant ? <RowLink to={`/admin/inventory/stock/${row.variant.id}`}><Code>{row.variant.sku}</Code></RowLink> : "—") },
              { key: "location", header: t("common.location"), cell: (row) => <Code>{row.locationCode}</Code> },
              { key: "qty", header: t("movements.change"), numeric: true, cell: (row) => <Num value={row.qtyDelta} signed />, negative: (row) => row.qtyDelta < 0 },
              { key: "ref", header: t("common.reference"), cell: (row) => (row.refType ? `${t(`refTypes.${row.refType}`)} ${row.refLabel ?? ""}` : "—") },
            ]}
            card={(row) => (
              <>
                <p className="type-strong">
                  {t(`kinds.${row.kind}`)} · <Code>{row.variant?.sku ?? ""}</Code>
                </p>
                <Pair label={t("movements.change")}>
                  <Num value={row.qtyDelta} signed />
                </Pair>
                <Pair label={t("common.when")}>
                  <When at={row.at} />
                </Pair>
              </>
            )}
            empty={<p className="type-body text-ink-2">{t("movements.empty")}</p>}
          />
        </Section>
      ) : null}

      <ModuleFunctions moduleId="04" />
    </>
  );
}
