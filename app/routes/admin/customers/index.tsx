import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/index";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { customerQueues, listCustomers } from "~/server/services/admin/customers/list.server";
import { CUSTOMER_SORTS, CUSTOMER_STATUS_LIST, CUSTOMER_VIEWS, customerSearch, NEW_ACCOUNT_DAYS, parseCustomerFilters, RFM_SEGMENTS, type CustomerAccess, type CustomerListRow } from "~/server/services/admin/customers/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { adminMeta } from "../shell/meta";
import { openCustomers } from "./customers.server";
import { CUSTOMERS_LAYOUT_ID } from "./meta";
import { CustomerStatusBadge, DemoNote, FlagTags, Money, Num, PhoneText, SegmentBadge, useCustomersT, When } from "./ui";

/**
 * /admin/customers — the module's front page: what waits (privacy requests, open complaints, customers at risk), the
 * customer list (07.01) with saved views for the labels (07.06), the RFM segment filter (07.02), search and sort in
 * the URL (work without JavaScript), a dense table on desktop and cards on phones, the CSV export for those allowed,
 * and the module's blueprint status.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, "customers.customer.read");
  const filters = parseCustomerFilters(new URL(request.url).searchParams);
  try {
    const [page, queues] = await Promise.all([listCustomers(db, actor, filters, now), customerQueues(db, actor, now)]);
    return { page, queues, filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.customers"));

type LayoutData = { access: CustomerAccess; privacy: { open: number; overdue: number } | null };

export default function CustomersIndex({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const navigation = useNavigation();
  const layout = useRouteLoaderData(CUSTOMERS_LAYOUT_ID) as LayoutData | undefined;
  const { page, filters, queues } = loaderData;
  const blueprint = blueprintModule("07");
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/customers";
  const filtered = Boolean(filters.q || filters.status || filters.segment);
  const exportHref = `/admin/customers/export${customerSearch({ ...filters, page: 1 })}`;

  const columns: DataColumn<CustomerListRow>[] = [
    {
      key: "customer",
      header: t("list.col.customer"),
      cell: (row) => (
        <span className="grid py-1">
          <Link to={`/admin/customers/${row.id}`} className="adm-link">
            {row.name ?? t("list.noName")}
          </Link>
          <span className="type-caption text-ink-2">
            <PhoneText phone={row.phone} />
          </span>
        </span>
      ),
    },
    { key: "status", header: t("list.col.status"), cell: (row) => <CustomerStatusBadge status={row.status} /> },
    { key: "orders", header: t("list.col.purchases"), numeric: true, cell: (row) => <Num value={row.purchases} /> },
    { key: "spent", header: t("list.col.spent"), numeric: true, cell: (row) => <Num value={row.spentIqd} /> },
    { key: "last", header: t("list.col.lastOrder"), cell: (row) => <span className="whitespace-nowrap">{row.lastOrderAt ? <When at={row.lastOrderAt} style="date" /> : t("list.never")}</span> },
    { key: "segment", header: t("list.col.segment"), cell: (row) => <SegmentBadge segment={row.segment} /> },
    {
      key: "flags",
      header: t("list.col.flags"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <FlagTags flags={row.flags} />
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
    { key: "joined", header: t("list.col.joined"), cell: (row) => <span className="whitespace-nowrap"><When at={row.createdAt} style="date" /></span> },
  ];

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrow", { id: "07", priority: blueprint?.priority ?? "P0" })}</p>
        <h1 className="adm-title">{t("title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("lead")}</p>
      </header>

      <QueueCards queues={queues} privacy={layout?.privacy ?? null} />

      <section className="adm-section" aria-labelledby="customers-list">
        <div className="adm-section__head">
          <h2 id="customers-list" className="adm-h2">
            {t("list.title")}
          </h2>
          {layout?.access.export ? (
            <Key as="a" href={exportHref} size="sm" icon="download-simple" download>
              {t("list.export")}
            </Key>
          ) : null}
        </div>

        <nav aria-label={t("list.viewsLabel")} className="flex flex-wrap gap-2">
          {CUSTOMER_VIEWS.map((view) => {
            const active = filters.view === view;
            return (
              <Key key={view} as={Link} to={`/admin/customers${customerSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`list.views.${view}`, { days: NEW_ACCOUNT_DAYS })}
              </Key>
            );
          })}
        </nav>

        <Disclosure summary={t("list.filters")} variant="panel" defaultOpen={filtered}>
          <Form method="get" action="/admin/customers" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
            <TextField name="q" label={t("list.search")} hint={layout?.access.fullPhone ? t("list.searchHintFull") : t("list.searchHint")} defaultValue={filters.q} type="search" maxLength={40} />
            <Select name="status" label={t("list.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("list.anyStatus") }, ...CUSTOMER_STATUS_LIST.map((status) => ({ value: status, label: t(`status.${status}`) }))]} />
            <Select name="segment" label={t("list.segment")} hint={page.segmentsComputedAt ? undefined : t("list.segmentNever")} defaultValue={filters.segment ?? ""} options={[{ value: "", label: t("list.anySegment") }, ...RFM_SEGMENTS.map((segment) => ({ value: segment, label: t(`segment.${segment}.name`) }))]} />
            <Select name="sort" label={t("list.sort")} defaultValue={filters.sort} options={CUSTOMER_SORTS.map((sort) => ({ value: sort, label: t(`list.sorts.${sort}`) }))} />
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
              <Key type="submit" variant="ink" icon="funnel">
                {t("list.apply")}
              </Key>
              <Key as={Link} to="/admin/customers">
                {t("list.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>

        <p className="type-caption text-ink-2" aria-live="polite">
          {t("list.count", { count: page.total })}
          {page.segmentsComputedAt ? (
            <>
              {" · "}
              {t("list.segmentsAsOf")} <When at={page.segmentsComputedAt} />
            </>
          ) : null}
        </p>

        {page.rows.length === 0 ? (
          <EmptyState
            title={filtered || filters.view !== "all" ? t("list.emptyFiltered") : t("list.empty")}
            text={filtered || filters.view !== "all" ? t("list.emptyFilteredHint") : t("list.emptyHint")}
            icon="users"
            action={
              filtered || filters.view !== "all" ? (
                <Key as={Link} to="/admin/customers">
                  {t("list.clear")}
                </Key>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("list.title")}
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.name ?? row.id}
                busy={busy}
                maxHeight={null}
                footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => customerSearch({ ...filters, page: n }) || "?"} />}
              />
              <p className="mt-2 type-caption text-ink-2">{t("list.spentNote")}</p>
            </div>
            <div className="md:hidden">
              <ul className="cus-cards" aria-label={t("list.title")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <CustomerCard row={row} />
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => customerSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
      </section>

      <ModuleFunctions moduleId="07" />
    </>
  );
}

function CustomerCard({ row }: { row: CustomerListRow }) {
  const t = useCustomersT();
  return (
    <Link to={`/admin/customers/${row.id}`} className="cus-card">
      <span className="cus-card__top">
        <span className="type-strong">{row.name ?? t("list.noName")}</span>
        <CustomerStatusBadge status={row.status} />
      </span>
      <span className="cus-card__top type-caption text-ink-2">
        <PhoneText phone={row.phone} />
        <span>{t("list.purchases", { count: row.purchases })}</span>
      </span>
      <span className="cus-card__top type-body">
        <span className="text-ink-2">{row.lastOrderAt ? <When at={row.lastOrderAt} style="date" /> : t("list.never")}</span>
        <Money iqd={row.spentIqd} className="type-strong" />
      </span>
      {row.segment || row.flags.length || row.isDemo ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          {row.segment ? <SegmentBadge segment={row.segment} /> : null}
          <FlagTags flags={row.flags} />
          <DemoNote show={row.isDemo} />
        </span>
      ) : null}
    </Link>
  );
}

type Queues = { vip: number; risk: number; complaints: number; blocked: number };

/** What waits for this employee — raised clay only where a person must decide (DESIGN.md §10). */
function QueueCards({ queues, privacy }: { queues: Queues; privacy: { open: number; overdue: number } | null }) {
  const t = useCustomersT();
  const f = useFormat();
  const cards: { id: string; count: number; to: string; icon: IconName; decide: boolean }[] = [
    ...(privacy ? [{ id: "privacy", count: privacy.open, to: "/admin/customers/privacy", icon: "shield-check" as IconName, decide: true }] : []),
    { id: "complaints", count: queues.complaints, to: "/admin/customers?view=complaints", icon: "chat-circle", decide: true },
    { id: "risk", count: queues.risk, to: "/admin/customers?view=risk", icon: "warning", decide: true },
    { id: "vip", count: queues.vip, to: "/admin/customers?view=vip", icon: "star", decide: false },
  ];
  return (
    <section className="adm-section" aria-labelledby="customers-waiting">
      <h2 id="customers-waiting" className="adm-h2">
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
            <p className="type-caption text-ink-2">
              {card.count > 0 ? t(`queues.${card.id}.${card.id === "privacy" && (privacy?.overdue ?? 0) > 0 ? "overdue" : "some"}`, { count: card.count, overdue: privacy?.overdue ?? 0 }) : t(`queues.${card.id}.none`)}
            </p>
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
