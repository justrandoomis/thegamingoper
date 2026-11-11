import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/invoices";
import { listInvoices, parseInvoiceFilters } from "~/server/services/admin/purchasing/invoices.server";
import { INVOICE_FILTERS } from "~/server/services/admin/purchasing/rules";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, Day, LinkChips, Minor, Money, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, usePurT, withSearch } from "./components/kit";
import { purchasingMeta } from "./meta";
import { assertCostReader } from "./order-form.server";
import { openPurchasing } from "./purchasing.server";

/**
 * /admin/purchasing/invoices — supplier invoices and their three-way match (09.04, 09.07): open (matched or with
 * variances), approved, void; search in the URL. Supplier cost data: purchasing.invoice.manage and cost.read.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor } = await openPurchasing(context, "purchasing.invoice.manage");
  assertCostReader(actor);
  const filters = parseInvoiceFilters(new URL(request.url).searchParams);
  return { page: await listInvoices(db, actor, filters), filters };
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "invoices.title");

export default function Invoices({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const { search } = useLocation();
  const { page, filters } = loaderData;
  return (
    <>
      <PageHead title={t("invoices.title")} lead={t("invoices.lead")} />
      <Section id="invoices-list" title={t("invoices.caption")}>
        <LinkChips label={t("common.status")} items={INVOICE_FILTERS.map((status) => ({ value: status, label: t(`invoices.filters.${status}`), href: withSearch(search, { status }), selected: filters.status === status, count: page.counts[status] }))} />
        <Form method="get" className="flex flex-wrap items-end gap-3" role="search">
          <input type="hidden" name="status" value={filters.status} />
          <TextField name="q" type="search" label={t("common.search")} defaultValue={filters.q} placeholder={t("invoices.searchHint")} className="min-w-[14rem] flex-1" />
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList
          caption={t("invoices.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "no", header: t("invoice.number"), cell: (row) => <RowLink to={`/admin/purchasing/invoices/${row.id}`}><Code>{row.invoiceNo}</Code></RowLink> },
            { key: "supplier", header: t("common.supplier"), cell: (row) => row.supplier.name },
            { key: "po", header: t("common.order"), cell: (row) => (row.po ? <RowLink to={`/admin/purchasing/orders/${row.po.id}`}><Code>{row.po.ref}</Code></RowLink> : "—") },
            { key: "status", header: t("common.status"), cell: (row) => <StateTag group="invoice" value={row.status} label={t(`invoiceStatus.${row.status}`)} /> },
            { key: "variances", header: t("invoice.variances"), numeric: true, cell: (row) => <Num value={row.variances} className={row.variances > 0 ? "text-red-ink" : undefined} /> },
            { key: "total", header: t("order.total"), numeric: true, cell: (row) => <Minor minor={row.totalMinor} currency={row.currency} /> },
            { key: "totalIqd", header: t("order.totalIqd"), numeric: true, cell: (row) => <Money iqd={row.totalIqd} /> },
            { key: "due", header: t("invoice.dueOn"), cell: (row) => <Day value={row.dueOn} /> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/purchasing/invoices/${row.id}`} className="adm-link type-strong">
                  <Code>{row.invoiceNo}</Code>
                </Link>
                <StateTag group="invoice" value={row.status} label={t(`invoiceStatus.${row.status}`)} />
              </div>
              <p className="type-body">
                <bdi>{row.supplier.name}</bdi> {row.po ? <>· <Code>{row.po.ref}</Code></> : null}
              </p>
              <Pair label={t("order.total")}>
                <Minor minor={row.totalMinor} currency={row.currency} />
              </Pair>
              {row.variances > 0 ? (
                <Pair label={t("invoice.variances")}>
                  <span className="text-red-ink">
                    <Num value={row.variances} />
                  </span>
                </Pair>
              ) : null}
            </>
          )}
          empty={<EmptyState icon="file-text" title={filters.q ? t("invoices.emptyFiltered") : t("invoices.empty")} text={t("invoices.emptyHint")} />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
        />
      </Section>
    </>
  );
}
