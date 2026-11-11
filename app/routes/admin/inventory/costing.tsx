import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/costing";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { listCostLayers, parseCostingFilters } from "~/server/services/admin/inventory/analytics.server";
import { locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, Kpi, Money, Note, Num, PageHead, Pair, ResponsiveList, RowLink, When, useInvT, withSearch } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/costing — FIFO cost layers per received batch (04.10). [P]: the whole page needs cost.read (the
 * loader refuses everyone else with 403 before any cost is read). The costing policy in force is stated on the page:
 * FIFO per location; weighted average is not implemented.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "cost.read");
  const filters = parseCostingFilters(new URL(request.url).searchParams);
  try {
    // The service also needs inventory.stock.read: a role with cost.read alone gets the 403, not a 500.
    const [page, tree] = await Promise.all([listCostLayers(db, actor, filters, locale), locationTree(db)]);
    return { page, filters, locations: locationOptions(tree, { includeInactive: true }) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "costing.title");

export default function Costing({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { search } = useLocation();
  const { page, filters, locations } = loaderData;
  return (
    <>
      <PageHead title={t("costing.title")} lead={t("costing.lead")} />
      <Note icon="scales" className="mb-4">
        {t("costing.policy")}
      </Note>
      <div className="inv-kpis mb-4">
        <Kpi wide label={t("costing.value")} value={<Money iqd={page.summary.valueIqd} />} />
        <Kpi label={t("costing.layered")} value={f.number(page.summary.layeredUnits)} />
        <Kpi label={t("costing.unlayered")} value={f.number(page.summary.unlayeredUnits)} />
        <Kpi label={t("costing.withoutCost")} value={f.number(page.summary.variantsWithoutCost)} />
        <Kpi label={t("costing.openLayers")} value={f.number(page.summary.openLayers)} />
      </div>
      <Form method="get" className="adm-card mb-4 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_auto_auto] md:items-end">
        <TextField name="q" type="search" label={t("stock.searchLabel")} defaultValue={filters.q} ltr={false} />
        <Select name="location" label={t("common.location")} defaultValue={filters.location ?? ""} options={[{ value: "", label: t("common.allLocations") }, ...locations.map((option) => ({ value: option.value, label: option.label }))]} />
        <div className="pb-1">
          <input type="hidden" name="open" value="0" />
          <Checkbox name="open" value="1" label={t("costing.onlyOpen")} defaultChecked={filters.open} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Key type="submit" variant="ink" icon="funnel">
            {t("common.apply")}
          </Key>
          {search && search !== "?" ? (
            <Link to="/admin/inventory/costing" className="adm-link type-label">
              {t("common.clear")}
            </Link>
          ) : null}
        </div>
      </Form>
      <ResponsiveList
        caption={t("costing.caption")}
        rows={page.rows}
        rowKey={(row) => row.id}
        columns={[
          { key: "sku", header: t("common.sku"), cell: (row) => <RowLink to={`/admin/inventory/stock/${row.variant.id}`}><Code>{row.variant.sku}</Code></RowLink> },
          { key: "name", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant.name}</span> },
          { key: "location", header: t("common.location"), cell: (row) => <Code>{row.locationCode}</Code> },
          { key: "received", header: t("item.receivedAt"), cell: (row) => <When at={row.receivedAt} kind="date" /> },
          { key: "source", header: t("item.source"), cell: (row) => t(`sources.${row.source}`) },
          { key: "qtyReceived", header: t("item.qtyReceived"), numeric: true, cell: (row) => <Num value={row.qtyReceived} /> },
          { key: "qtyRemaining", header: t("item.qtyRemaining"), numeric: true, cell: (row) => <Num value={row.qtyRemaining} /> },
          { key: "unitCost", header: t("item.unitCost"), numeric: true, cell: (row) => <Num value={row.unitCostIqd} /> },
          { key: "value", header: t("common.value"), numeric: true, cell: (row) => <Num value={row.valueIqd} /> },
        ]}
        card={(row) => (
          <>
            <p className="type-strong">{row.variant.name}</p>
            <p className="type-caption text-ink-2">
              <Code>{row.variant.sku}</Code> · <Code>{row.locationCode}</Code> · <When at={row.receivedAt} kind="date" />
            </p>
            <Pair label={t("item.qtyRemaining")}>
              <Num value={row.qtyRemaining} /> / <Num value={row.qtyReceived} />
            </Pair>
            <Pair label={t("item.unitCost")}>
              <Num value={row.unitCostIqd} />
            </Pair>
            <Pair label={t("common.value")}>
              <Num value={row.valueIqd} />
            </Pair>
          </>
        )}
        empty={<EmptyState icon="stack" title={t("costing.empty")} />}
        footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
      />
    </>
  );
}
