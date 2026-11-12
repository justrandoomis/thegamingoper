import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/warranties";
import { throwAsResponse } from "~/server/errors";
import { listWarranties } from "~/server/services/admin/returns/warranty.server";
import { parseWarrantyFilters, WARRANTY_VIEWS, warrantySearch, type WarrantyRow } from "~/server/services/admin/returns/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { returnsMeta } from "./meta";
import { openReturns } from "./returns.server";
import { CustomerName } from "../shell/CustomerName";
import { Num, PhoneText, Ref, useReturnsT, When, WarrantyBadge } from "./ui";

/**
 * /admin/returns/warranties — the store's warranties (12.06): running, ending within 30 days, expired, voided; search by
 * order, serial or the full phone number (URL state, works without JavaScript). Each row opens the warranty with its
 * service history, replaced parts and the maker's warranty shown apart.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context, ["returns.warranty.read", "returns.warranty.manage"]);
  try {
    return { page: await listWarranties(db, actor, parseWarrantyFilters(new URL(request.url).searchParams), locale, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, "warranties.title");

export default function Warranties({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const navigation = useNavigation();
  const { page } = loaderData;
  const filters = page.filters;
  const columns: DataColumn<WarrantyRow>[] = [
    {
      key: "item",
      header: t("warranties.col.item"),
      cell: (row) => (
        <Link to={`/admin/returns/warranties/${row.id}`} className="adm-link">
          {row.itemName}
        </Link>
      ),
    },
    { key: "order", header: t("warranties.col.order"), cell: (row) => <Ref value={row.orderRef} /> },
    { key: "serial", header: t("warranties.col.serial"), cell: (row) => (row.serial ? <Ref value={row.serial} /> : "—") },
    {
      key: "customer",
      header: t("warranties.col.customer"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <span>
            <CustomerName profileId={row.customerProfileId}>{row.customerName ?? "—"}</CustomerName>
          </span>
          <span className="type-caption text-ink-2">
            <PhoneText phone={row.phone} />
          </span>
        </span>
      ),
    },
    { key: "starts", header: t("warranties.col.starts"), cell: (row) => <When at={row.startsAt} style="date" /> },
    { key: "ends", header: t("warranties.col.ends"), cell: (row) => <When at={row.endsAt} style="date" /> },
    { key: "state", header: t("warranties.col.state"), cell: (row) => <span className="whitespace-nowrap"><WarrantyBadge state={row.state} />{row.isUsed ? <span className="ret-tag ms-2">{t("warranties.used")}</span> : null}</span> },
    { key: "repairs", header: t("warranties.col.repairs"), numeric: true, cell: (row) => <Num value={row.repairs} /> },
  ];
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("warranties.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("warranties.lead")}</p>
      </header>
      <nav aria-label={t("warranties.viewsLabel")} className="flex flex-wrap gap-2">
        {WARRANTY_VIEWS.map((view) => (
          <Key key={view} as={Link} to={`/admin/returns/warranties${warrantySearch({ view })}`} size="sm" held={filters.view === view && !filters.q} aria-current={filters.view === view && !filters.q ? "true" : undefined}>
            {t(`warranties.views.${view}`)}
          </Key>
        ))}
      </nav>
      <Form method="get" action="/admin/returns/warranties" className="flex flex-wrap items-end gap-2">
        {filters.view !== "active" ? <input type="hidden" name="view" value={filters.view} /> : null}
        <TextField name="q" type="search" label={t("warranties.search")} hint={t("warranties.searchHint")} defaultValue={filters.q} className="min-w-[16rem] flex-1" />
        <Key type="submit" variant="ink" icon="magnifying-glass">
          {t("warranties.apply")}
        </Key>
      </Form>
      <p className="type-caption text-ink-2" aria-live="polite">
        {t("warranties.count", { count: page.total })}
      </p>
      {page.rows.length === 0 ? (
        <EmptyState title={filters.q ? t("warranties.emptyFiltered") : t("warranties.empty")} text={filters.q ? undefined : t("warranties.emptyHint")} icon="certificate" />
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable
              caption={t("warranties.title")}
              columns={columns}
              rows={page.rows}
              rowKey={(row) => row.id}
              busy={navigation.state === "loading"}
              maxHeight={null}
              footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => warrantySearch({ ...filters, page: n }) || "?"} />}
            />
          </div>
          <div className="md:hidden">
            <ul className="ret-cards" aria-label={t("warranties.title")}>
              {page.rows.map((row) => (
                <li key={row.id}>
                  <Link to={`/admin/returns/warranties/${row.id}`} className="ret-card">
                    <span className="ret-card__top">
                      <span className="type-strong">{row.itemName}</span>
                      <WarrantyBadge state={row.state} />
                    </span>
                    <span className="ret-card__top type-caption text-ink-2">
                      <Ref value={row.orderRef} />
                      {row.serial ? <Ref value={row.serial} /> : null}
                    </span>
                    <span className="type-caption">
                      <When at={row.startsAt} style="date" /> – <When at={row.endsAt} style="date" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Pagination page={page.page} pageCount={page.pageCount} href={(n) => warrantySearch({ ...filters, page: n }) || "?"} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
