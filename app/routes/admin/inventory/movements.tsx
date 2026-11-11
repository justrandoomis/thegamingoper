import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/movements";
import { can } from "~/server/actor";
import { listMovements, parseMovementFilters } from "~/server/services/admin/inventory/movements.server";
import { locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { STOCK_MOVEMENT_KINDS } from "~/server/db/schema";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, Note, Num, PageHead, Pair, ResponsiveList, RowLink, When, useInvT, withSearch } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/movements — the stock movement log (04.04): every receipt, sale, reservation, transfer, damage,
 * adjustment and count with its reason, reference, actor and time. Read-only (the database refuses UPDATE and
 * DELETE on stock_movements). Filters in the URL; CSV export of the same filters. Serial numbers only for
 * inventory.serial.read, unit costs only for cost.read — absent from the data otherwise.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.movement.read");
  const orders = can(actor, "orders.order.read");
  const filters = parseMovementFilters(new URL(request.url).searchParams);
  const [page, tree] = await Promise.all([listMovements(db, actor, filters, locale), locationTree(db)]);
  return { page, filters, locations: locationOptions(tree, { includeInactive: true }), kinds: [...STOCK_MOVEMENT_KINDS], orders };
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "movements.title");

type Row = Route.ComponentProps["loaderData"]["page"]["rows"][number];

function refHref(row: Row, orders: boolean): string | null {
  if (!row.refId) return null;
  if (row.refType === "order" && orders && row.refLabel) return `/admin/orders/${row.refLabel}`;
  if (row.refType === "transfer") return `/admin/inventory/transfers/${row.refId}`;
  if (row.refType === "cycle_count") return `/admin/inventory/counts/${row.refId}`;
  if (row.refType === "stock_receipt") return `/admin/inventory/receive?session=${row.refId}`;
  return null;
}

export default function Movements({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const { search } = useLocation();
  const { page, filters, locations, kinds } = loaderData;
  const exportHref = `/admin/inventory/movements/export${search && search !== "?" ? search : ""}`;

  const Ref = ({ row }: { row: Row }) => {
    if (!row.refType) return <>—</>;
    const label = (
      <>
        {t(`refTypes.${row.refType}`)} {row.refLabel ? <Code>{row.refLabel}</Code> : null}
      </>
    );
    const href = refHref(row, loaderData.orders);
    return href ? <RowLink to={href}>{label}</RowLink> : <span>{label}</span>;
  };
  const reasonOf = (row: Row) => row.reason ?? (row.refType ? t("movements.kindReason", { kind: t(`kinds.${row.kind}`), ref: row.refLabel ?? "" }) : "—");

  const columns: DataColumn<Row>[] = [
    { key: "at", header: t("common.when"), cell: (row) => <When at={row.at} /> },
    { key: "kind", header: t("movements.kind"), cell: (row) => t(`kinds.${row.kind}`) },
    { key: "sku", header: t("common.sku"), cell: (row) => <RowLink to={`/admin/inventory/stock/${row.variantId}`}><Code>{row.variant?.sku ?? row.variantId}</Code></RowLink> },
    { key: "product", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant?.name ?? "—"}</span> },
    { key: "location", header: t("common.location"), cell: (row) => <Code>{row.locationCode}</Code> },
    { key: "qty", header: t("movements.change"), numeric: true, cell: (row) => <Num value={row.qtyDelta} signed />, negative: (row) => row.qtyDelta < 0 },
    { key: "reserved", header: t("movements.reservedChange"), numeric: true, cell: (row) => (row.reservedDelta === 0 ? "—" : <Num value={row.reservedDelta} signed />) },
    { key: "ref", header: t("common.reference"), cell: (row) => <Ref row={row} /> },
    { key: "reason", header: t("common.reason"), cell: (row) => <span className="line-clamp-2 min-w-[14rem]">{reasonOf(row)}</span> },
    { key: "actor", header: t("common.by"), cell: (row) => row.actor.name ?? t(`actorKinds.${row.actor.kind}`) },
  ];
  if (page.withSerials) columns.push({ key: "serial", header: t("movements.serial"), cell: (row) => (row.serial ? <Code>{row.serial}</Code> : "—") });
  if (page.withCost) columns.push({ key: "unitCost", header: t("movements.unitCost"), numeric: true, cell: (row) => <Num value={row.unitCostIqd ?? null} /> });

  return (
    <>
      <PageHead
        title={t("movements.title")}
        lead={t("movements.lead")}
        actions={
          <Key as="a" href={exportHref} icon="download-simple" download>
            {t("common.exportCsv")}
          </Key>
        }
      />
      <Note icon="lock" className="mb-4">
        {t("movements.immutable")}
      </Note>

      <Form method="get" className="adm-card mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto] xl:items-end" aria-label={t("common.search")}>
        <TextField name="q" type="search" label={page.withSerials ? t("movements.searchLabel") : t("movements.searchLabelNoSerial")} defaultValue={filters.q} ltr={false} />
        <Select name="kind" label={t("movements.kind")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("movements.anyKind") }, ...kinds.map((kind) => ({ value: kind, label: t(`kinds.${kind}`) }))]} />
        <Select name="location" label={t("common.location")} defaultValue={filters.location ?? ""} options={[{ value: "", label: t("common.allLocations") }, ...locations.map((option) => ({ value: option.value, label: option.label }))]} />
        <TextField name="from" type="date" label={t("common.fromDate")} defaultValue={filters.from ?? ""} />
        <TextField name="to" type="date" label={t("common.toDate")} defaultValue={filters.to ?? ""} />
        <div className="flex flex-wrap items-center gap-2">
          <Key type="submit" variant="ink" icon="funnel">
            {t("common.apply")}
          </Key>
          {search && search !== "?" ? (
            <Link to="/admin/inventory/movements" className="adm-link type-label">
              {t("common.clear")}
            </Link>
          ) : null}
        </div>
      </Form>

      <p className="mb-3 type-caption text-ink-2" aria-live="polite">
        {t("common.results", { count: page.total })} · {t("movements.csvLimit")}
      </p>

      <ResponsiveList
        caption={t("movements.caption")}
        columns={columns}
        rows={page.rows}
        rowKey={(row) => row.id}
        empty={<EmptyState icon="magnifying-glass" title={t("movements.empty")} text={t("common.emptyFilterHint")} />}
        card={(row) => (
          <>
            <div className="flex items-start justify-between gap-2">
              <p className="type-strong">
                {t(`kinds.${row.kind}`)} · <Num value={row.qtyDelta} signed />
              </p>
              <span className="type-caption text-ink-2">
                <When at={row.at} />
              </span>
            </div>
            <p className="type-body">{row.variant?.name ?? "—"}</p>
            <p className="type-caption text-ink-2">
              <Code>{row.variant?.sku ?? ""}</Code> · <Code>{row.locationCode}</Code>
            </p>
            <Pair label={t("common.reference")}>
              <Ref row={row} />
            </Pair>
            <Pair label={t("common.reason")}>{reasonOf(row)}</Pair>
            <Pair label={t("common.by")}>{row.actor.name ?? t(`actorKinds.${row.actor.kind}`)}</Pair>
            {page.withSerials && row.serial ? (
              <Pair label={t("movements.serial")}>
                <Code>{row.serial}</Code>
              </Pair>
            ) : null}
            {page.withCost ? (
              <Pair label={t("movements.unitCost")}>
                <Num value={row.unitCostIqd ?? null} />
              </Pair>
            ) : null}
          </>
        )}
        footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
      />
    </>
  );
}
