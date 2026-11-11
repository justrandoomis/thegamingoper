import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/used";
import { Icon } from "~/art/Icon";
import { throwAsResponse } from "~/server/errors";
import { listUsedUnits } from "~/server/services/admin/devices/used.server";
import { GRADE_LIST, parseUsedFilters, USED_STATUS_LIST, USED_VIEWS, usedSearch, type UsedListRow } from "~/server/services/admin/devices/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { openDevices } from "./devices.server";
import { devicesMeta } from "./meta";
import { DemoNote, GradeTag, Money, Name, Ref, UsedBadge, useDevicesT, When } from "./ui";

/**
 * /admin/devices/used — every used unit from intake to sold, with what each one still lacks before it can be listed
 * (checklist, ownership, wipe, real photos). Saved views and filters in the URL; a table on desktop, cards on phones.
 * The acquisition cost [P] is a column only for cost.read (absent from the data otherwise).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openDevices(context, ["devices.registry.read", "devices.used.intake", "devices.used.inspect", "devices.used.grade", "devices.used.list", "devices.ownership.verify"]);
  const filters = parseUsedFilters(new URL(request.url).searchParams);
  try {
    return { page: await listUsedUnits(db, actor, filters, locale), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "used.title");

function Evidence({ row }: { row: UsedListRow }) {
  const t = useDevicesT();
  const items = [
    { ok: row.checklistComplete, key: "checklist" },
    { ok: row.ownershipChecked, key: "ownership" },
    { ok: row.dataWiped, key: "wipe" },
    { ok: row.realPhotos > 0, key: "photos" },
  ];
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map((item) => (
        <span key={item.key} className="dev-tag" title={t(`used.evidence.${item.key}`)}>
          <Icon name={item.ok ? "check" : "minus"} size={13} className={item.ok ? "text-ok" : "text-ink-2"} />
          {t(`used.evidenceShort.${item.key}`)}
        </span>
      ))}
    </span>
  );
}

export default function UsedPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const navigation = useNavigation();
  const { page, filters } = loaderData;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/devices/used";
  const filtered = Boolean(filters.q || filters.status || filters.grade);
  const columns: DataColumn<UsedListRow>[] = [
    {
      key: "unit",
      header: t("used.col.unit"),
      cell: (row) => (
        <span className="grid py-1">
          <Link to={`/admin/devices/used/${row.id}`} className="adm-link">
            <Name text={row.name} />
          </Link>
          <span className="type-caption text-ink-2">
            <Ref value={row.sku} />
            {row.serial ? (
              <>
                {" "}
                · <Ref value={row.serial} />
              </>
            ) : null}
          </span>
        </span>
      ),
    },
    { key: "grade", header: t("used.col.grade"), cell: (row) => <GradeTag grade={row.grade} /> },
    {
      key: "status",
      header: t("used.col.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <UsedBadge status={row.status} />
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
    { key: "evidence", header: t("used.col.evidence"), cell: (row) => <Evidence row={row} /> },
    { key: "price", header: t("used.col.price"), numeric: true, cell: (row) => (row.priceIqd > 0 ? <Money iqd={row.priceIqd} /> : <span className="type-caption text-ink-2">{t("used.unpriced")}</span>) },
    ...(page.withCost ? [{ key: "cost", header: t("used.col.cost"), numeric: true, cell: (row: UsedListRow) => <Money iqd={row.acquisitionCostIqd ?? null} /> } satisfies DataColumn<UsedListRow>] : []),
    { key: "source", header: t("used.col.source"), cell: (row) => (row.tradeInRef ? <Ref value={row.tradeInRef} /> : t(`source.${row.source}`)) },
    { key: "updated", header: t("used.col.updated"), cell: (row) => <span className="whitespace-nowrap"><When at={row.updatedAt} /></span> },
  ];
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("used.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("used.lead")}</p>
      </header>

      <section className="adm-section" aria-labelledby="used-list">
        <h2 id="used-list" className="sr-only">
          {t("used.title")}
        </h2>
        <nav aria-label={t("list.viewsLabel")} className="flex flex-wrap gap-2">
          {USED_VIEWS.map((view) => {
            const active = filters.view === view && !filtered;
            return (
              <Key key={view} as={Link} to={`/admin/devices/used${usedSearch({ view })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`used.views.${view}`)}
              </Key>
            );
          })}
        </nav>

        <Disclosure summary={t("list.filters")} variant="panel" defaultOpen={filtered}>
          <Form method="get" action="/admin/devices/used" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
            <TextField name="q" label={t("list.search")} hint={t("used.searchHint")} defaultValue={filters.q} type="search" />
            <Select name="status" label={t("list.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("list.any") }, ...USED_STATUS_LIST.map((status) => ({ value: status, label: t(`usedStatus.${status}`) }))]} />
            <Select name="grade" label={t("used.col.grade")} defaultValue={filters.grade ?? ""} options={[{ value: "", label: t("list.any") }, ...GRADE_LIST.map((grade) => ({ value: grade, label: `${grade} · ${t(`gradeWord.${grade}`)}` }))]} />
            <div className="flex items-end gap-2">
              <Key type="submit" variant="ink" icon="funnel">
                {t("list.apply")}
              </Key>
              <Key as={Link} to="/admin/devices/used">
                {t("list.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>

        <p className="type-caption text-ink-2" aria-live="polite">
          {t("list.count", { count: page.total })}
        </p>

        {page.rows.length === 0 ? (
          <EmptyState title={filtered || filters.view !== "all" ? t("list.emptyFiltered") : t("used.empty")} text={filtered || filters.view !== "all" ? t("list.emptyFilteredHint") : t("used.emptyHint")} icon="game-controller" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("used.title")} columns={columns} rows={page.rows} rowKey={(row) => row.id} rowLabel={(row) => row.slug} busy={busy} maxHeight={null} footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => usedSearch({ ...filters, page: n }) || "?"} />} />
            </div>
            <div className="md:hidden">
              <ul className="dev-cards" aria-label={t("used.title")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <Link to={`/admin/devices/used/${row.id}`} className="dev-card">
                      <span className="dev-card__top">
                        <span className="type-strong">
                          <Name text={row.name} />
                        </span>
                        <UsedBadge status={row.status} />
                      </span>
                      <span className="dev-card__top type-caption text-ink-2">
                        <Ref value={row.sku} />
                        <GradeTag grade={row.grade} />
                      </span>
                      <span className="dev-card__top type-body">
                        <span>{t("used.col.price")}</span>
                        {row.priceIqd > 0 ? <Money iqd={row.priceIqd} className="type-strong" /> : <span className="type-caption text-ink-2">{t("used.unpriced")}</span>}
                      </span>
                      {page.withCost ? (
                        <span className="dev-card__top type-caption">
                          <span>{t("used.col.cost")}</span>
                          <Money iqd={row.acquisitionCostIqd ?? null} />
                        </span>
                      ) : null}
                      <Evidence row={row} />
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => usedSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
