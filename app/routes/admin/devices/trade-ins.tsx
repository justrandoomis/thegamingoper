import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/trade-ins";
import { throwAsResponse } from "~/server/errors";
import type { DevicesAccess } from "~/server/services/admin/devices/shared.server";
import { listTradeIns } from "~/server/services/admin/devices/tradeins.server";
import { parseTradeInFilters, TRADE_IN_STATUS_LIST, TRADE_IN_VIEWS, tradeInSearch, type TradeInListRow } from "~/server/services/admin/devices/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { openDevices } from "./devices.server";
import { DEVICES_LAYOUT_ID, devicesMeta } from "./meta";
import { DemoNote, Money, Name, PhoneText, Ref, TradeInBadge, useDevicesT, When } from "./ui";

/**
 * /admin/devices/trade-ins — every trade-in request (storefront and counter) with saved views and filters in the URL
 * (work without JavaScript): a dense table on desktop, cards on phones, pages of 25. Phones are masked without
 * customer.phone.read_full (a partial-digit search needs it too).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openDevices(context, ["devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"]);
  const filters = parseTradeInFilters(new URL(request.url).searchParams);
  try {
    return { page: await listTradeIns(db, actor, filters, locale, now), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "tradeIns.title");

export default function TradeInsPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const navigation = useNavigation();
  const layout = useRouteLoaderData(DEVICES_LAYOUT_ID) as { access?: DevicesAccess } | undefined;
  const { page, filters } = loaderData;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/devices/trade-ins";
  const filtered = Boolean(filters.q || filters.status || filters.from || filters.to);
  const columns: DataColumn<TradeInListRow>[] = [
    {
      key: "ref",
      header: t("tradeIns.col.ref"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <Link to={`/admin/devices/trade-ins/${row.ref}`} className="adm-link">
            <Ref value={row.ref} />
          </Link>
          <span className="type-caption text-ink-2">
            <When at={row.createdAt} />
          </span>
        </span>
      ),
    },
    { key: "device", header: t("tradeIns.col.device"), cell: (row) => <Name text={row.device} /> },
    {
      key: "customer",
      header: t("tradeIns.col.customer"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <span>{row.contactName ?? t("noName")}</span>
          <span className="type-caption text-ink-2">
            <PhoneText phone={row.phone} />
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: t("tradeIns.col.status"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <TradeInBadge status={row.status} expired={row.offerExpired} />
          {row.status === "inspection_scheduled" && row.inspectionAt ? (
            <span className="type-caption text-ink-2">
              <When at={row.inspectionAt} />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "estimate",
      header: t("tradeIns.col.estimate"),
      numeric: true,
      cell: (row) =>
        row.estimate ? (
          <span className="whitespace-nowrap">
            <Money iqd={row.estimate.minIqd} /> – <Money iqd={row.estimate.maxIqd} />
          </span>
        ) : (
          <span className="type-caption text-ink-2">{t("tradeIns.noEstimate")}</span>
        ),
    },
    {
      key: "offer",
      header: t("tradeIns.col.offer"),
      numeric: true,
      cell: (row) =>
        row.offerIqd !== null ? (
          <span className="grid whitespace-nowrap py-1">
            <Money iqd={row.offerIqd} className="type-strong" />
            {row.offerExpiresAt && row.status === "offered" ? (
              <span className="type-caption text-ink-2">
                {t("tradeIns.until")} <When at={row.offerExpiresAt} style="date" />
              </span>
            ) : null}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "source",
      header: t("tradeIns.col.source"),
      cell: (row) => (
        <span className="inline-flex flex-wrap gap-1">
          <span className="dev-tag">{t(row.counter ? "source.counter" : "source.online")}</span>
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
  ];

  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("tradeIns.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("tradeIns.lead")}</p>
        {layout?.access?.tradeInspect ? (
          <div>
            <Key as={Link} to="/admin/devices/trade-ins/new" icon="plus" variant="ink">
              {t("counter.open")}
            </Key>
          </div>
        ) : null}
      </header>

      <section className="adm-section" aria-labelledby="tradeins-list">
        <h2 id="tradeins-list" className="sr-only">
          {t("tradeIns.title")}
        </h2>
        <nav aria-label={t("list.viewsLabel")} className="flex flex-wrap gap-2">
          {/* "to pay" is a person's own queue: only for those who confirm wipes or pay out */}
          {TRADE_IN_VIEWS.filter((view) => view !== "to_pay" || layout?.access?.tradePayout || layout?.access?.verify || filters.view === "to_pay").map((view) => {
            const active = filters.view === view && !filtered;
            return (
              <Key key={view} as={Link} to={`/admin/devices/trade-ins${tradeInSearch({ view })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`tradeIns.views.${view}`)}
              </Key>
            );
          })}
        </nav>

        <Disclosure summary={t("list.filters")} variant="panel" defaultOpen={filtered}>
          <Form method="get" action="/admin/devices/trade-ins" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
            <TextField name="q" label={t("list.search")} hint={t("tradeIns.searchHint")} defaultValue={filters.q} type="search" />
            <Select name="status" label={t("list.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("list.any") }, ...TRADE_IN_STATUS_LIST.map((status) => ({ value: status, label: t(`status.${status}`) }))]} />
            <TextField name="from" type="date" label={t("list.from")} defaultValue={filters.from ?? ""} ltr />
            <TextField name="to" type="date" label={t("list.to")} defaultValue={filters.to ?? ""} ltr />
            <div className="flex items-end gap-2">
              <Key type="submit" variant="ink" icon="funnel">
                {t("list.apply")}
              </Key>
              <Key as={Link} to="/admin/devices/trade-ins">
                {t("list.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>

        <p className="type-caption text-ink-2" aria-live="polite">
          {t("list.count", { count: page.total })}
        </p>

        {page.rows.length === 0 ? (
          <EmptyState
            title={filtered || filters.view !== "all" ? t("list.emptyFiltered") : t("tradeIns.empty")}
            text={filtered || filters.view !== "all" ? t("list.emptyFilteredHint") : t("tradeIns.emptyHint")}
            icon="swap"
            action={!filtered && filters.view === "all" && layout?.access?.tradeInspect ? <Key as={Link} to="/admin/devices/trade-ins/new" icon="plus">{t("counter.open")}</Key> : undefined}
          />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("tradeIns.title")}
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.ref}
                busy={busy}
                maxHeight={null}
                footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => tradeInSearch({ ...filters, page: n }) || "?"} />}
              />
            </div>
            <div className="md:hidden">
              <ul className="dev-cards" aria-label={t("tradeIns.title")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <Link to={`/admin/devices/trade-ins/${row.ref}`} className="dev-card">
                      <span className="dev-card__top">
                        <span className="type-strong">
                          <Ref value={row.ref} />
                        </span>
                        <TradeInBadge status={row.status} expired={row.offerExpired} />
                      </span>
                      <span className="type-body">
                        <Name text={row.device} />
                      </span>
                      <span className="dev-card__top type-caption text-ink-2">
                        <span>
                          {row.contactName ?? t("noName")} · <PhoneText phone={row.phone} />
                        </span>
                        <When at={row.createdAt} />
                      </span>
                      <span className="dev-card__top type-caption">
                        <span>{row.offerIqd !== null ? t("tradeIns.col.offer") : t("tradeIns.col.estimate")}</span>
                        {row.offerIqd !== null ? (
                          <Money iqd={row.offerIqd} className="type-strong" />
                        ) : row.estimate ? (
                          <span>
                            <Money iqd={row.estimate.minIqd} /> – <Money iqd={row.estimate.maxIqd} />
                          </span>
                        ) : (
                          <span className="text-ink-2">{t("tradeIns.noEstimate")}</span>
                        )}
                      </span>
                      <span className="inline-flex flex-wrap gap-1">
                        <span className="dev-tag">{t(row.counter ? "source.counter" : "source.online")}</span>
                        <DemoNote show={row.isDemo} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => tradeInSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
