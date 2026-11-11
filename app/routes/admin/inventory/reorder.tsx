import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/reorder";
import { useFormat } from "~/i18n/react";
import { REORDER_FILTERS, listReorder, parseReorderFilters } from "~/server/services/admin/inventory/analytics.server";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, LinkChips, Note, Num, PageHead, Pair, ResponsiveList, RowLink, StateTag, useInvT, withSearch } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/reorder — reorder points, days of cover and the stock-out forecast (04.06) from real sales
 * ('sale' movements = units that left with shipped orders), with the inputs beside every forecast and an honest
 * "not enough history" where there is none. Reorder points are set on each SKU's page (inventory.reorder.manage).
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.stock.read");
  const filters = parseReorderFilters(new URL(request.url).searchParams);
  return { page: await listReorder(db, actor, filters, locale, now), filters, shows: [...REORDER_FILTERS] };
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "reorder.title");

type Row = Route.ComponentProps["loaderData"]["page"]["rows"][number];

export default function Reorder({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { search } = useLocation();
  const { page, filters, shows } = loaderData;
  const rate = (row: Row) => (row.rate.perDay !== null ? t("common.perDay", { rate: f.number(row.rate.perDay, { maximumFractionDigits: 2 }) }) : row.rate.basis === "no_sales" ? t("reorder.noSales") : t("reorder.noHistory"));
  const cover = (row: Row) => (row.plan.daysOfCover === null ? "—" : t("common.days", { count: row.plan.daysOfCover }));

  return (
    <>
      <PageHead title={t("reorder.title")} lead={t("reorder.lead")} />
      <Note icon="info" className="mb-4">
        <strong className="type-strong">{t("reorder.method")}</strong>
        <span>{t("reorder.methodText")}</span>
      </Note>
      <div className="mb-4 grid gap-3">
        <LinkChips label={t("common.status")} items={shows.map((show) => ({ value: show, label: t(`reorder.filters.${show}`), href: withSearch(search, { show }), selected: filters.show === show, count: page.counts[show] }))} />
        <Form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="show" value={filters.show} />
          <TextField name="q" type="search" label={t("stock.searchLabel")} defaultValue={filters.q} className="min-w-[16rem] flex-1" ltr={false} />
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.search")}
          </Key>
          {filters.q ? (
            <Link to={withSearch(search, { q: null })} className="adm-link type-label">
              {t("common.clear")}
            </Link>
          ) : null}
        </Form>
      </div>
      <ResponsiveList
        caption={t("reorder.caption")}
        rows={page.rows}
        rowKey={(row) => row.variant.id}
        columns={[
          { key: "sku", header: t("common.sku"), cell: (row) => <RowLink to={`/admin/inventory/stock/${row.variant.id}`}><Code>{row.variant.sku}</Code></RowLink> },
          { key: "name", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant.name}</span> },
          { key: "available", header: t("common.available"), numeric: true, cell: (row) => <Num value={row.available} /> },
          { key: "incoming", header: t("common.incoming"), numeric: true, cell: (row) => <Num value={row.incoming} /> },
          { key: "point", header: t("common.reorderPoint"), numeric: true, cell: (row) => <Num value={row.reorderPoint} /> },
          { key: "sold30", header: t("reorder.sold30"), numeric: true, cell: (row) => <Num value={row.sold30} /> },
          { key: "sold90", header: t("reorder.sold90"), numeric: true, cell: (row) => <Num value={row.sold90} /> },
          { key: "rate", header: t("reorder.rate"), cell: rate },
          { key: "cover", header: t("reorder.cover"), cell: cover },
          { key: "stockOut", header: t("reorder.stockOut"), cell: (row) => (row.plan.stockOutAt === null ? "—" : f.date(row.plan.stockOutAt)) },
          { key: "suggested", header: t("reorder.suggested"), numeric: true, cell: (row) => <Num value={row.plan.suggestedQty} /> },
          { key: "status", header: t("common.status"), cell: (row) => <StateTag group="reorder" value={row.plan.status} label={t(`reorder.statuses.${row.plan.status}`)} /> },
        ]}
        card={(row) => (
          <>
            <div className="flex items-start justify-between gap-2">
              <Link to={`/admin/inventory/stock/${row.variant.id}`} className="adm-link type-strong">
                {row.variant.name}
              </Link>
              <StateTag group="reorder" value={row.plan.status} label={t(`reorder.statuses.${row.plan.status}`)} />
            </div>
            <p className="type-caption text-ink-2">
              <Code>{row.variant.sku}</Code>
            </p>
            <Pair label={t("common.available")}>
              <Num value={row.available} />
            </Pair>
            <Pair label={t("reorder.rate")}>{rate(row)}</Pair>
            <Pair label={t("reorder.cover")}>{cover(row)}</Pair>
            <Pair label={t("reorder.suggested")}>
              <Num value={row.plan.suggestedQty} />
            </Pair>
          </>
        )}
        empty={<EmptyState icon="chart-line" title={t("reorder.empty")} />}
        footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
      />
      <p className="mt-3 type-caption text-ink-2">{t("reorder.poNote")}</p>
    </>
  );
}
