import { useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher, useLocation } from "react-router";

import type { Route } from "./+types/orders";
import { useFormat } from "~/i18n/react";
import { listPurchaseOrders, markOrdersSent, parsePoFilters } from "~/server/services/admin/purchasing/orders.server";
import { PO_VIEWS } from "~/server/services/admin/purchasing/rules";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { supplierOptions } from "~/server/services/admin/purchasing/suppliers.server";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { toast } from "~/ui/toast-store";
import { Code, LinkChips, Minor, Money, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT, withSearch } from "./components/kit";
import { purchasingMeta } from "./meta";
import { failed, ok, openPurchasing } from "./purchasing.server";

/**
 * /admin/purchasing/orders — purchase orders (09.03): saved views as chips (open, awaiting approval, drafts, late,
 * received, closed, all), search and supplier in the URL (works without JavaScript), a dense table on desktop with a
 * bulk "mark as sent" for approved orders, cards on phones. Amounts only for cost.read (absent otherwise).
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openPurchasing(context, "purchasing.po.read");
  const filters = parsePoFilters(new URL(request.url).searchParams);
  const access = purchasingAccess(actor);
  const [page, suppliers] = await Promise.all([listPurchaseOrders(db, actor, filters, now), access.supplierRead ? supplierOptions(db, actor, { includeInactive: true }) : Promise.resolve([])]);
  return { page, filters, access, suppliers: suppliers.map((option) => ({ value: option.value, label: option.label })) };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.po.create");
  const form = await request.formData();
  try {
    const result = await markOrdersSent(
      db,
      actor,
      { poIds: form.getAll("poId").map((value) => String(value)) },
      now,
    );
    return ok({ intent: "send", sent: result.sent, skipped: result.skipped });
  } catch (error) {
    return failed(error, locale, "send");
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "orders.title");

type Row = Route.ComponentProps["loaderData"]["page"]["rows"][number];

export default function Orders({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const { search } = useLocation();
  const { page, filters, access, suppliers } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useFetcher<typeof action>();
  const sendable = new Set(page.rows.filter((row) => row.status === "approved").map((row) => row.id));
  const sendSelected = (ids: readonly string[]) => {
    const form = new FormData();
    for (const id of ids) if (sendable.has(id)) form.append("poId", id);
    bulk.submit(form, { method: "post" });
    setSelected([]);
  };
  const announced = useRef<unknown>(null);
  useEffect(() => {
    const data = bulk.data;
    if (bulk.state !== "idle" || !data || announced.current === data) return;
    announced.current = data;
    if (data.ok && "sent" in data) toast.success(t("orders.sentCount", { count: Number(data.sent) }));
    else if (!data.ok) toast.error(data.message ?? t("errors.unexpected"));
  }, [bulk.state, bulk.data, t]);

  return (
    <>
      <PageHead
        title={t("orders.title")}
        lead={t("orders.lead")}
        actions={
          access.poCreate && access.cost ? (
            <Key as={Link} to="/admin/purchasing/orders/new" icon="plus" variant="ink">
              {t("orders.new")}
            </Key>
          ) : null
        }
      />
      <Section id="orders-list" title={t("orders.caption")}>
        <LinkChips label={t("orders.views")} items={PO_VIEWS.map((view) => ({ value: view, label: t(`orders.viewNames.${view}`), href: withSearch(search, { view }), selected: filters.view === view, count: page.counts[view] }))} />
        <Form method="get" className="flex flex-wrap items-end gap-3" role="search">
          <input type="hidden" name="view" value={filters.view} />
          <TextField name="q" type="search" label={t("common.search")} defaultValue={filters.q} placeholder={t("orders.searchHint")} className="min-w-[14rem] flex-1" />
          {suppliers.length > 0 ? <Select name="supplier" label={t("common.supplier")} defaultValue={filters.supplier ?? ""} options={[{ value: "", label: t("common.allSuppliers") }, ...suppliers]} /> : null}
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList
          caption={t("orders.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.ref}
          sort={{ key: filters.sort, dir: filters.dir }}
          search={search}
          selected={access.poCreate ? selected : undefined}
          onSelectedChange={access.poCreate ? setSelected : undefined}
          bulkActions={
            access.poCreate
              ? (ids) => (
                  <Key size="sm" icon="paper-plane-tilt" disabled={!ids.some((id) => sendable.has(id))} loading={bulk.state !== "idle"} onClick={() => sendSelected(ids)}>
                    {t("orders.markSent", { count: ids.filter((id) => sendable.has(id)).length })}
                  </Key>
                )
              : undefined
          }
          columns={[
            { key: "ref", header: t("common.reference"), sortable: true, cell: (row: Row) => <RowLink to={`/admin/purchasing/orders/${row.id}`}><Code>{row.ref}</Code></RowLink> },
            { key: "supplier", header: t("common.supplier"), sortable: true, cell: (row: Row) => <bdi className="line-clamp-2 min-w-[9rem]">{row.supplier.name}</bdi> },
            { key: "status", header: t("common.status"), cell: (row: Row) => <StateTag group="po" value={row.status} label={t(`poStatus.${row.status}`)} /> },
            {
              key: "expected",
              header: t("order.expected"),
              sortable: true,
              cell: (row: Row) =>
                row.late ? (
                  <span className="text-red-ink">
                    {t("order.lateSince")} <When at={row.expectedAt} kind="date" />
                  </span>
                ) : (
                  <When at={row.expectedAt} kind="date" />
                ),
            },
            { key: "units", header: t("order.unitsReceivedOf"), numeric: true, cell: (row: Row) => <span><Num value={row.unitsReceived} /> / <Num value={row.units} /></span> },
            ...(access.cost
              ? [
                  { key: "total", header: t("order.total"), numeric: true, cell: (row: Row) => (row.totalMinor !== undefined ? <Minor minor={row.totalMinor} currency={row.currency ?? "IQD"} /> : "—") },
                  { key: "totalIqd", header: t("order.totalIqd"), numeric: true, cell: (row: Row) => <Money iqd={row.totalIqd} unknownLabel={t("order.noRate")} /> },
                ]
              : []),
            { key: "created", header: t("common.created"), sortable: true, firstDir: "desc" as const, cell: (row: Row) => <span>{row.createdBy ?? "—"} · <When at={row.createdAt} kind="date" /></span> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/purchasing/orders/${row.id}`} className="adm-link type-strong">
                  <Code>{row.ref}</Code>
                </Link>
                <StateTag group="po" value={row.status} label={t(`poStatus.${row.status}`)} />
              </div>
              <p className="type-body">
                <bdi>{row.supplier.name}</bdi>
              </p>
              <Pair label={t("order.unitsReceivedOf")}>
                <Num value={row.unitsReceived} /> / <Num value={row.units} />
              </Pair>
              <Pair label={t("order.expected")}>{row.late ? <span className="text-red-ink">{t("order.late")}</span> : <When at={row.expectedAt} kind="date" />}</Pair>
              {access.cost && row.totalMinor !== undefined ? (
                <Pair label={t("order.total")}>
                  <Minor minor={row.totalMinor} currency={row.currency ?? "IQD"} />
                </Pair>
              ) : null}
            </>
          )}
          empty={<EmptyState icon="receipt" title={filters.q || filters.supplier ? t("orders.emptyFiltered") : t(`orders.empty.${filters.view}`)} text={access.poCreate && access.cost && filters.view === "draft" ? t("orders.emptyHint") : undefined} />}
          footer={
            <>
              <p className="type-caption text-ink-2">{t("orders.count", { count: page.total, shown: f.number(page.rows.length) })}</p>
              <Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />
            </>
          }
        />
      </Section>
    </>
  );
}
