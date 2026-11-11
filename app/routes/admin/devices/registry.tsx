import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/registry";
import { throwAsResponse } from "~/server/errors";
import { listRegistry } from "~/server/services/admin/devices/registry.server";
import { CONDITION_LIST, parseRegistryFilters, registrySearch, SERIAL_SOURCE_LIST, SERIAL_STATUS_LIST, type RegistryRow } from "~/server/services/admin/devices/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { openDevices } from "./devices.server";
import { devicesMeta } from "./meta";
import { SourceText } from "./registry-parts";
import { GradeTag, Money, Name, Ref, SerialBadge, useDevicesT, When } from "./ui";

/**
 * /admin/devices/registry — the device registry (13.01): every serial-numbered unit by serial, condition (new / used +
 * grade), where it came from (supplier receipt, trade-in, demo seed), status, location and the order holding it.
 * Filters in the URL; a table on desktop, cards on phones; cost [P] only for cost.read.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openDevices(context, "devices.registry.read");
  const filters = parseRegistryFilters(new URL(request.url).searchParams);
  try {
    return { page: await listRegistry(db, actor, filters, locale), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "registry.title");

export default function RegistryPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const navigation = useNavigation();
  const { page, filters } = loaderData;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/devices/registry";
  const filtered = Boolean(filters.q || filters.status || filters.source || filters.condition);
  const columns: DataColumn<RegistryRow>[] = [
    {
      key: "serial",
      header: t("registry.col.serial"),
      cell: (row) => (
        <Link to={`/admin/devices/registry/${row.id}`} className="adm-link whitespace-nowrap">
          <Ref value={row.serial} />
        </Link>
      ),
    },
    {
      key: "device",
      header: t("registry.col.device"),
      cell: (row) => (
        <span className="grid py-1">
          <Name text={row.name} />
          <span className="type-caption text-ink-2">
            <Ref value={row.sku} />
          </span>
        </span>
      ),
    },
    { key: "condition", header: t("registry.col.condition"), cell: (row) => (row.condition === "used" ? <GradeTag grade={row.grade} /> : <span className="dev-tag">{t("condition.new")}</span>) },
    { key: "status", header: t("registry.col.status"), cell: (row) => <SerialBadge status={row.status} /> },
    { key: "source", header: t("registry.col.source"), cell: (row) => <SourceText source={row.source} /> },
    { key: "location", header: t("registry.col.location"), cell: (row) => (row.location ? <Ref value={row.location} /> : "—") },
    { key: "order", header: t("registry.col.order"), cell: (row) => (row.orderRef ? <Ref value={row.orderRef} /> : "—") },
    ...(page.withCost ? [{ key: "cost", header: t("registry.col.cost"), numeric: true, cell: (row: RegistryRow) => <Money iqd={row.costIqd ?? null} /> } satisfies DataColumn<RegistryRow>] : []),
    { key: "updated", header: t("registry.col.updated"), cell: (row) => <span className="whitespace-nowrap"><When at={row.updatedAt} /></span> },
  ];
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("registry.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("registry.lead")}</p>
        <p className="type-caption text-ink-2">{t("registry.counts", { used: page.counts.used, fresh: page.counts.new })}</p>
      </header>
      <section className="adm-section" aria-labelledby="registry-list">
        <h2 id="registry-list" className="sr-only">
          {t("registry.title")}
        </h2>
        <Disclosure summary={t("list.filters")} variant="panel" defaultOpen={filtered}>
          <Form method="get" action="/admin/devices/registry" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <TextField name="q" label={t("list.search")} hint={t("registry.searchHint")} defaultValue={filters.q} type="search" />
            <Select name="status" label={t("registry.col.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("list.any") }, ...SERIAL_STATUS_LIST.map((status) => ({ value: status, label: t(`serialStatus.${status}`) }))]} />
            <Select name="source" label={t("registry.col.source")} defaultValue={filters.source ?? ""} options={[{ value: "", label: t("list.any") }, ...SERIAL_SOURCE_LIST.map((source) => ({ value: source, label: t(`source.${source}`) }))]} />
            <Select name="condition" label={t("registry.col.condition")} defaultValue={filters.condition ?? ""} options={[{ value: "", label: t("list.any") }, ...CONDITION_LIST.map((condition) => ({ value: condition, label: t(`condition.${condition}`) }))]} />
            <div className="flex items-end gap-2">
              <Key type="submit" variant="ink" icon="funnel">
                {t("list.apply")}
              </Key>
              <Key as={Link} to="/admin/devices/registry">
                {t("list.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>
        <p className="type-caption text-ink-2" aria-live="polite">
          {t("list.count", { count: page.total })}
        </p>
        {page.rows.length === 0 ? (
          <EmptyState title={filtered ? t("list.emptyFiltered") : t("registry.empty")} text={filtered ? t("list.emptyFilteredHint") : t("registry.emptyHint")} icon="barcode" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("registry.title")} columns={columns} rows={page.rows} rowKey={(row) => row.id} rowLabel={(row) => row.serial} busy={busy} maxHeight={null} footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => registrySearch({ ...filters, page: n }) || "?"} />} />
            </div>
            <div className="md:hidden">
              <ul className="dev-cards" aria-label={t("registry.title")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <Link to={`/admin/devices/registry/${row.id}`} className="dev-card">
                      <span className="dev-card__top">
                        <span className="type-strong">
                          <Ref value={row.serial} />
                        </span>
                        <SerialBadge status={row.status} />
                      </span>
                      <span className="type-body">
                        <Name text={row.name} />
                      </span>
                      <span className="dev-card__top type-caption text-ink-2">
                        <span>{row.condition === "used" ? `${t("condition.used")} · ${row.grade ?? "—"}` : t("condition.new")}</span>
                        <span>{row.location ?? "—"}</span>
                      </span>
                      {page.withCost ? (
                        <span className="dev-card__top type-caption">
                          <span>{t("registry.col.cost")}</span>
                          <Money iqd={row.costIqd ?? null} />
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => registrySearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
