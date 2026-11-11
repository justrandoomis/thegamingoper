import { useState } from "react";
import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/index";
import { Icon } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { can } from "~/server/actor";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listOrders, type OrderCounts } from "~/server/services/admin/orders/list.server";
import {
  LIST_FLAGS,
  LIST_SORTS,
  listSearch,
  ORDER_STATUS_LIST,
  parseListFilters,
  PAYMENT_METHOD_LIST,
  PAYMENT_STATUS_LIST,
  SAVED_VIEWS,
  type OrderListFilters,
  type OrderListRow,
} from "~/server/services/admin/orders/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { adminMeta } from "../shell/meta";
import { DemoNote, FlagTags, Money, Num, OrderStatusBadge, PaymentBadge, PhoneText, Ref, ReviewBadge, useOrdersT, When } from "./ui";

/**
 * /admin/orders — the order list (05.01 statuses, entry to 05.02) and the module's front page: what waits for this
 * employee, saved views, filters in the URL (work without JavaScript), a dense table on desktop and cards on phones,
 * batch printing of the selected orders (05.06), CSV export (cost columns only for cost.read), and the module's
 * blueprint status.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.read");
  const url = new URL(request.url);
  const filters = parseListFilters(url.searchParams);
  const page = await listOrders(db, actor, filters, ctx.locale, ctx.now);
  return {
    page,
    search: url.search,
    can: { export: can(actor, "orders.order.export"), print: can(actor, "orders.document.print") },
  };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.orders"));

type LayoutData = { counts: OrderCounts | null };

export default function OrdersIndex({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const locale = useLocale();
  const navigation = useNavigation();
  const layout = useRouteLoaderData("routes/admin/orders/layout") as LayoutData | undefined;
  const counts = layout?.counts ?? null;
  const { page, can: allowed } = loaderData;
  const filters = page.filters;
  const [selected, setSelected] = useState<string[]>([]);
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/orders";
  const blueprint = blueprintModule("05");

  const sortHref = (key: string, dir: "asc" | "desc") => {
    const sort = key === "total" ? (dir === "asc" ? "total_asc" : "total_desc") : dir === "asc" ? "placed_asc" : "placed_desc";
    return `/admin/orders${listSearch({ ...filters, sort, page: 1 })}`;
  };
  const currentSort = filters.sort.startsWith("total") ? { key: "total", dir: filters.sort.endsWith("asc") ? ("asc" as const) : ("desc" as const) } : { key: "placed", dir: filters.sort.endsWith("asc") ? ("asc" as const) : ("desc" as const) };
  const printHref = (kind: string, ids: readonly string[]) => `/admin/orders/print?kind=${kind}&${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`;

  const columns: DataColumn<OrderListRow>[] = [
    {
      key: "ref",
      header: t("list.col.ref"),
      cell: (row) => (
        <Link to={`/admin/orders/${row.ref}`} className="adm-link whitespace-nowrap">
          <Ref value={row.ref} />
        </Link>
      ),
    },
    {
      key: "placed",
      header: t("list.col.placed"),
      sortable: true,
      firstDir: "desc",
      cell: (row) => (
        <span className="whitespace-nowrap">
          <When at={row.placedAt} />
        </span>
      ),
    },
    {
      key: "customer",
      header: t("list.col.customer"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <span>{row.contactName ?? t("list.noName")}</span>
          <span className="type-caption text-ink-2">
            <PhoneText phone={row.phone} />
          </span>
        </span>
      ),
    },
    { key: "governorate", header: t("list.col.governorate"), cell: (row) => row.governorate ?? "—" },
    { key: "units", header: t("list.col.units"), numeric: true, cell: (row) => <Num value={row.units} /> },
    { key: "total", header: t("list.col.total"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => <Num value={row.totalIqd} /> },
    {
      key: "status",
      header: t("list.col.status"),
      cell: (row) => (
        <span className="whitespace-nowrap">
          <OrderStatusBadge status={row.status} />
        </span>
      ),
    },
    {
      key: "payment",
      header: t("list.col.payment"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <PaymentBadge status={row.paymentStatus} method={row.paymentMethod} />
        </span>
      ),
    },
    {
      key: "flags",
      header: t("list.col.flags"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <ReviewBadge status={row.reviewStatus} />
          <FlagTags flags={row.flags} max={2} />
          {row.isPreorder ? <span className="ord-flag">{t("list.preorder")}</span> : null}
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
    { key: "assigned", header: t("list.col.assigned"), cell: (row) => <span className="whitespace-nowrap">{row.assignedTo?.name ?? "—"}</span> },
  ];

  const active = (view: (typeof SAVED_VIEWS)[number]) => listSearch(view.filters as Partial<OrderListFilters>) === listSearch({ ...filters, page: 1, sort: "placed_desc" });

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrow", { id: "05", priority: blueprint?.priority ?? "P0" })}</p>
        {/* the blueprint names the module in ar and en only: Sorani uses the module's own title */}
        <h1 className="adm-title">{blueprint && locale !== "ckb" ? blueprint[locale === "en" ? "en" : "ar"] : t("title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("lead")}</p>
      </header>

      <QueueCards counts={counts} />

      <section className="adm-section" aria-labelledby="orders-list">
        <div className="adm-section__head">
          <h2 id="orders-list" className="adm-h2">
            {t("list.title")}
          </h2>
          {allowed.export ? (
            <Key as="a" href={`/admin/orders/export${listSearch({ ...filters, page: 1 })}`} size="sm" icon="download-simple" download>
              {t("list.export")}
            </Key>
          ) : null}
        </div>

        <nav aria-label={t("list.views")} className="flex flex-wrap gap-2">
          {SAVED_VIEWS.map((view) => (
            <Key key={view.id} as={Link} to={`/admin/orders${listSearch(view.filters as Partial<OrderListFilters>)}`} size="sm" held={active(view)} aria-current={active(view) ? "true" : undefined}>
              {t(`views.${view.id}`)}
            </Key>
          ))}
        </nav>

        <Disclosure summary={t("list.filters")} variant="panel" defaultOpen={hasFilters(filters)}>
          <Form method="get" action="/admin/orders" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField name="q" label={t("list.search")} hint={t("list.searchHint")} defaultValue={filters.q} type="search" />
            <Select
              name="status"
              label={t("list.col.status")}
              defaultValue={filters.status.length === 1 ? filters.status[0] : ""}
              options={[{ value: "", label: t("list.any") }, ...ORDER_STATUS_LIST.map((status) => ({ value: status, label: t(`status.${status}`) }))]}
            />
            <Select
              name="payment"
              label={t("list.paymentStatus")}
              defaultValue={filters.payment.length === 1 ? filters.payment[0] : ""}
              options={[{ value: "", label: t("list.any") }, ...PAYMENT_STATUS_LIST.map((status) => ({ value: status, label: t(`payment.${status}`) }))]}
            />
            <Select
              name="method"
              label={t("list.method")}
              defaultValue={filters.method.length === 1 ? filters.method[0] : ""}
              options={[{ value: "", label: t("list.any") }, ...PAYMENT_METHOD_LIST.map((method) => ({ value: method, label: t(`method.${method}`) }))]}
            />
            <Select
              name="gov"
              label={t("list.col.governorate")}
              defaultValue={filters.governorate ?? ""}
              options={[{ value: "", label: t("list.any") }, ...page.governorates.map((gov) => ({ value: gov.id, label: gov.name }))]}
            />
            <TextField name="from" type="date" label={t("list.from")} defaultValue={filters.from ?? ""} ltr />
            <TextField name="to" type="date" label={t("list.to")} defaultValue={filters.to ?? ""} ltr />
            <Select
              name="assigned"
              label={t("list.assigned")}
              defaultValue={filters.assigned ?? ""}
              options={[
                { value: "", label: t("list.anyone") },
                { value: "me", label: t("list.assignedMe") },
                { value: "unassigned", label: t("list.unassigned") },
              ]}
            />
            <fieldset className="grid gap-1 sm:col-span-2">
              <legend className="type-label">{t("list.flags")}</legend>
              <div className="flex flex-wrap gap-x-4">
                {LIST_FLAGS.map((flag) => (
                  <Checkbox key={flag} name="flag" value={flag} label={t(`list.flag.${flag}`)} defaultChecked={filters.flags.includes(flag)} />
                ))}
              </div>
            </fieldset>
            <Select name="sort" label={t("list.sort")} defaultValue={filters.sort} options={LIST_SORTS.map((sort) => ({ value: sort, label: t(`list.sortBy.${sort}`) }))} />
            <div className="flex items-end gap-2">
              <Key type="submit" variant="ink" icon="funnel">
                {t("list.apply")}
              </Key>
              <Key as={Link} to="/admin/orders">
                {t("list.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>

        <p className="type-caption text-ink-2" aria-live="polite">
          {t("list.count", { count: page.total })}
        </p>

        {page.rows.length === 0 ? (
          <EmptyState title={hasFilters(filters) ? t("list.emptyFiltered") : t("list.empty")} text={hasFilters(filters) ? t("list.emptyFilteredHint") : t("list.emptyHint")} icon="package" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("list.title")}
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.ref}
                sort={currentSort}
                sortHref={(next) => sortHref(next.key, next.dir)}
                selected={allowed.print ? selected : undefined}
                onSelectedChange={allowed.print ? setSelected : undefined}
                bulkActions={
                  allowed.print
                    ? (ids) => (
                        <>
                          <Key as={Link} to={printHref("invoice", ids)} size="sm" icon="receipt">
                            {t("list.printInvoices")}
                          </Key>
                          <Key as={Link} to={printHref("packing", ids)} size="sm" icon="clipboard-text">
                            {t("list.printPacking")}
                          </Key>
                          <Key as={Link} to={printHref("label", ids)} size="sm" icon="printer">
                            {t("list.printLabels")}
                          </Key>
                        </>
                      )
                    : undefined
                }
                busy={busy}
                maxHeight={null}
                footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => listSearch({ ...filters, page: n }) || "?"} />}
              />
            </div>
            <div className="md:hidden">
              <ul className="ord-cards" aria-label={t("list.title")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <OrderCard row={row} />
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => listSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
      </section>

      <ModuleFunctions moduleId="05" />
    </>
  );
}

function hasFilters(filters: OrderListFilters): boolean {
  return Boolean(filters.q || filters.status.length || filters.payment.length || filters.method.length || filters.governorate || filters.from || filters.to || filters.flags.length || filters.assigned);
}

function OrderCard({ row }: { row: OrderListRow }) {
  const t = useOrdersT();
  return (
    <Link to={`/admin/orders/${row.ref}`} className="ord-card">
      <span className="ord-card__top">
        <span className="type-strong">
          <Ref value={row.ref} />
        </span>
        <OrderStatusBadge status={row.status} />
      </span>
      <span className="ord-card__top type-body">
        <span>{row.contactName ?? t("list.noName")}</span>
        <Money iqd={row.totalIqd} className="type-strong" />
      </span>
      <span className="ord-card__top type-caption text-ink-2">
        <When at={row.placedAt} />
        <span>{row.governorate ?? "—"}</span>
      </span>
      <PaymentBadge status={row.paymentStatus} method={row.paymentMethod} />
      {row.flags.length || row.reviewStatus !== "none" || row.isDemo ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          <ReviewBadge status={row.reviewStatus} />
          <FlagTags flags={row.flags} max={2} />
          <DemoNote show={row.isDemo} />
        </span>
      ) : null}
    </Link>
  );
}

/** What waits for this employee — raised clay only where a person must decide (DESIGN.md §10). */
function QueueCards({ counts }: { counts: OrderCounts | null }) {
  const t = useOrdersT();
  const f = useFormat();
  if (!counts) return null;
  const cards = [
    counts.proofs !== null ? { id: "proofs", count: counts.proofs, to: "/admin/orders/proofs", decide: true, icon: "receipt" as const } : null,
    counts.refunds !== null ? { id: "refunds", count: counts.refunds, to: "/admin/orders/refunds", decide: true, icon: "hand-coins" as const } : null,
    counts.review !== null ? { id: "review", count: counts.review, to: "/admin/orders/review", decide: true, icon: "flag" as const } : null,
    counts.toPack !== null ? { id: "toPack", count: counts.toPack, to: "/admin/orders/fulfillment", decide: false, icon: "package" as const } : null,
    { id: "late", count: counts.late, to: "/admin/orders?flag=late", decide: false, icon: "clock" as const },
  ].filter((card): card is NonNullable<typeof card> => card !== null);
  return (
    <section className="adm-section" aria-labelledby="orders-waiting">
      <h2 id="orders-waiting" className="adm-h2">
        {t("queues.title")}
      </h2>
      <div className="adm-grid">
        {cards.map((card) => (
          <article key={card.id} className={card.decide && card.count > 0 ? "adm-card adm-card--act" : "adm-card"}>
            <p className="flex items-center gap-2 type-caption text-ink-2">
              <Icon name={card.icon} size={16} />
              {t(`queues.${card.id}.label`)}
            </p>
            <p className="type-kpi nums">
              <bdi>{f.number(card.count)}</bdi>
            </p>
            <p className="type-caption text-ink-2">{card.count > 0 ? t(`queues.${card.id}.some`, { count: card.count }) : t(`queues.${card.id}.none`)}</p>
            <div>
              <Key as={Link} to={card.to} size="sm" iconEnd="arrow-right">
                {t(`queues.${card.id}.open`)}
              </Key>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
