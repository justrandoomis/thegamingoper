import { Form, Link, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/stock";
import { useFormat } from "~/i18n/react";
import { listStock, parseStockFilters, STOCK_STATES } from "~/server/services/admin/inventory/stock.server";
import { locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, Money, Num, PageHead, Pair, ResponsiveList, RowLink, StateTag, useInvT, withSearch } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/stock — on hand, reserved, available and incoming per SKU (04.01), across all locations or at one,
 * searched, filtered, sorted and paged in the URL (works without JavaScript). The FIFO value column exists only for
 * employees with cost.read — for everyone else it is absent from the loader's data, not blank.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.stock.read");
  const filters = parseStockFilters(new URL(request.url).searchParams);
  const [page, tree] = await Promise.all([listStock(db, actor, filters, locale), locationTree(db)]);
  return { page, filters, locations: locationOptions(tree, { includeInactive: true }), states: STOCK_STATES };
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "stock.title");

type Row = Route.ComponentProps["loaderData"]["page"]["rows"][number];

export default function StockList({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { search } = useLocation();
  const navigation = useNavigation();
  const { page, filters, locations, states } = loaderData;
  const oneLocation = page.location !== null;
  const withCost = page.rows.some((row) => row.valueIqd !== undefined);

  const columns: DataColumn<Row>[] = [
    { key: "sku", header: t("common.sku"), sortable: true, cell: (row) => <RowLink to={`/admin/inventory/stock/${row.id}`}><Code>{row.sku}</Code></RowLink> },
    { key: "name", header: t("common.product"), sortable: true, cell: (row) => <span className="line-clamp-2 min-w-[14rem]">{row.name}</span> },
    { key: "on_hand", header: t("common.onHand"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <Num value={row.onHand} /> },
    { key: "reserved", header: t("common.reserved"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <Num value={row.reserved} /> },
    { key: "available", header: oneLocation ? t("common.free") : t("common.available"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <Num value={row.available} />, negative: (row) => row.available < 0 },
    { key: "incoming", header: t("common.incoming"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <Num value={row.incoming} /> },
    { key: "reorder", header: t("common.reorderPoint"), numeric: true, cell: (row) => <Num value={row.reorderPoint} /> },
    { key: "state", header: t("common.status"), cell: (row) => <StateTag group="stock" value={row.state} label={t(`stockState.${row.state}`)} /> },
  ];
  if (withCost) columns.push({ key: "value", header: t("common.value"), numeric: true, cell: (row) => <ValueCell row={row} /> });

  const title = page.location ? `${t("stock.title")} · ${page.location.code}` : t("stock.title");
  return (
    <>
      <PageHead title={title} lead={t("stock.lead")} />

      <Form method="get" className="adm-card mb-4 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto] md:items-end" aria-label={t("common.search")}>
        <TextField name="q" label={t("stock.searchLabel")} placeholder={t("stock.searchPlaceholder")} defaultValue={filters.q} type="search" ltr={false} />
        <Select
          name="location"
          label={t("common.location")}
          defaultValue={filters.location ?? ""}
          options={[{ value: "", label: t("common.allLocations") }, ...locations.map((option) => ({ value: option.value, label: option.label }))]}
        />
        <Select name="state" label={t("stock.state")} defaultValue={filters.state} options={states.map((state) => ({ value: state, label: t(`stock.states.${state}`) }))} />
        <div className="flex flex-wrap items-center gap-2">
          <Key type="submit" variant="ink" icon="funnel" loading={navigation.state === "loading" && navigation.location?.pathname === "/admin/inventory/stock"}>
            {t("common.apply")}
          </Key>
          {filters.q || filters.location || filters.state !== "all" ? (
            <Link to="/admin/inventory/stock" className="adm-link type-label">
              {t("common.clear")}
            </Link>
          ) : null}
        </div>
      </Form>

      <p className="mb-3 type-caption text-ink-2" aria-live="polite">
        <bdi className="nums">
          {t("stock.summary", {
            skus: t("common.results", { count: page.total }),
            onHand: f.number(page.totals.onHand),
            reserved: f.number(page.totals.reserved),
            available: f.number(page.totals.available),
            incoming: f.number(page.totals.incoming),
          })}
        </bdi>
      </p>

      <ResponsiveList
        caption={t("stock.caption")}
        columns={columns}
        rows={page.rows}
        rowKey={(row) => row.id}
        sort={{ key: filters.sort, dir: filters.dir }}
        search={search}
        empty={<EmptyState icon="magnifying-glass" title={t("stock.empty")} text={t("stock.emptyHint")} />}
        card={(row) => (
          <>
            <div className="flex items-start justify-between gap-2">
              <Link to={`/admin/inventory/stock/${row.id}`} className="adm-link type-strong">
                {row.name}
              </Link>
              <StateTag group="stock" value={row.state} label={t(`stockState.${row.state}`)} />
            </div>
            <p className="type-caption text-ink-2">
              <Code>{row.sku}</Code>
            </p>
            <Pair label={t("common.onHand")}>
              <Num value={row.onHand} />
            </Pair>
            <Pair label={t("common.reserved")}>
              <Num value={row.reserved} />
            </Pair>
            <Pair label={oneLocation ? t("common.free") : t("common.available")}>
              <Num value={row.available} />
            </Pair>
            {row.incoming > 0 ? (
              <Pair label={t("common.incoming")}>
                <Num value={row.incoming} />
              </Pair>
            ) : null}
            {row.valueIqd !== undefined ? (
              <Pair label={t("common.value")}>
                <ValueCell row={row} />
              </Pair>
            ) : null}
          </>
        )}
        footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
      />
      <p className="mt-3 type-caption text-ink-2">
        {oneLocation ? t("stock.freeHint") : t("stock.availableHint")} {t("stock.incomingHint")}
      </p>
    </>
  );
}

function ValueCell({ row }: { row: Row }) {
  const t = useInvT();
  return (
    <span className="grid justify-items-end">
      <Money iqd={row.valueIqd} />
      {row.unlayeredUnits ? <span className="type-caption text-ink-2">{t("common.unlayered", { count: row.unlayeredUnits })}</span> : null}
    </span>
  );
}
