import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/serials";
import { SERIAL_STATUSES } from "~/server/db/schema";
import { throwAsResponse } from "~/server/errors";
import { findSerials, parseSerialFilters } from "~/server/services/admin/inventory/serials.server";
import { locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { Code, PageHead, Pair, ResponsiveList, RowLink, StateTag, When, useInvT, withSearch } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/serials — serial numbers (private: inventory.serial.read): find a unit by its number or SKU and
 * see where it is, its status, the order it was sold to and the transfer it travels in.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.serial.read");
  const filters = parseSerialFilters(new URL(request.url).searchParams);
  try {
    // The service also needs inventory.stock.read: a role with inventory.serial.read alone gets the 403, not a 500.
    const [page, tree] = await Promise.all([findSerials(db, actor, filters, locale), locationTree(db)]);
    return { page, filters, statuses: [...SERIAL_STATUSES], locations: locationOptions(tree, { includeInactive: true }) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "serials.title");

export default function Serials({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const { search } = useLocation();
  const { page, filters, statuses, locations } = loaderData;
  return (
    <>
      <PageHead title={t("serials.title")} lead={t("serials.lead")} />
      <Form method="get" className="adm-card mb-4 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] md:items-end">
        <TextField name="q" type="search" label={t("serials.searchLabel")} defaultValue={filters.q} ltr />
        <Select name="status" label={t("serials.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("serials.anyStatus") }, ...statuses.map((status) => ({ value: status, label: `${t(`serialStatus.${status}`)} (${page.counts[status] ?? 0})` }))]} />
        <Select name="location" label={t("common.location")} defaultValue={filters.location ?? ""} options={[{ value: "", label: t("common.allLocations") }, ...locations.map((option) => ({ value: option.value, label: option.label }))]} />
        <div className="flex flex-wrap items-center gap-2">
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.search")}
          </Key>
          {search && search !== "?" ? (
            <Link to="/admin/inventory/serials" className="adm-link type-label">
              {t("common.clear")}
            </Link>
          ) : null}
        </div>
      </Form>
      <p className="mb-3 type-caption text-ink-2">{t("common.results", { count: page.total })}</p>
      <ResponsiveList
        caption={t("serials.caption")}
        rows={page.rows}
        rowKey={(row) => row.id}
        columns={[
          { key: "serial", header: t("movements.serial"), cell: (row) => <RowLink to={`/admin/inventory/serials/${row.id}`}><Code>{row.serial}</Code></RowLink> },
          { key: "sku", header: t("common.sku"), cell: (row) => <RowLink to={`/admin/inventory/stock/${row.variant.id}`}><Code>{row.variant.sku}</Code></RowLink> },
          { key: "product", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant.name}</span> },
          { key: "status", header: t("serials.status"), cell: (row) => <StateTag group="serial" value={row.status} label={t(`serialStatus.${row.status}`)} /> },
          { key: "location", header: t("common.location"), cell: (row) => (row.locationCode ? <Code>{row.locationCode}</Code> : "—") },
          { key: "order", header: t("serials.order"), cell: (row) => (row.orderRef ? <Code>{row.orderRef}</Code> : "—") },
          { key: "transfer", header: t("serials.transfer"), cell: (row) => (row.transferRef ? <Code>{row.transferRef}</Code> : "—") },
          { key: "used", header: "", cell: (row) => (row.usedUnit ? <Status tone="neutral">{t("serials.usedDevice")}</Status> : null) },
          { key: "updated", header: t("serials.updated"), cell: (row) => <When at={row.updatedAt} /> },
        ]}
        card={(row) => (
          <>
            <div className="flex items-start justify-between gap-2">
              <Link to={`/admin/inventory/serials/${row.id}`} className="adm-link type-strong">
                <Code>{row.serial}</Code>
              </Link>
              <StateTag group="serial" value={row.status} label={t(`serialStatus.${row.status}`)} />
            </div>
            <p className="type-body">{row.variant.name}</p>
            {row.locationCode ? (
              <Pair label={t("common.location")}>
                <Code>{row.locationCode}</Code>
              </Pair>
            ) : null}
            {row.orderRef ? (
              <Pair label={t("serials.order")}>
                <Code>{row.orderRef}</Code>
              </Pair>
            ) : null}
          </>
        )}
        empty={<EmptyState icon="barcode" title={t("serials.empty")} />}
        footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
      />
    </>
  );
}
