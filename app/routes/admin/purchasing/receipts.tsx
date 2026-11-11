import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/receipts";
import { listReceipts, parseReceiptFilters } from "~/server/services/admin/purchasing/receipts.server";
import { RECEIPT_FILTERS } from "~/server/services/admin/purchasing/rules";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, LinkChips, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT, withSearch } from "./components/kit";
import { purchasingMeta } from "./meta";
import { openPurchasing } from "./purchasing.server";

/**
 * /admin/purchasing/receipts — goods received against purchase orders (09.04): drafts waiting to be posted (and for
 * their landed costs), postings that stopped half way, posted receipts; state and search in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor } = await openPurchasing(context, ["purchasing.po.read", "purchasing.receipt.create"]);
  const filters = parseReceiptFilters(new URL(request.url).searchParams);
  return { page: await listReceipts(db, actor, filters), filters };
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "receipts.title");

export default function Receipts({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const { search } = useLocation();
  const { page, filters } = loaderData;
  return (
    <>
      <PageHead title={t("receipts.title")} lead={t("receipts.lead")} />
      <Section id="receipts-list" title={t("receipts.caption")}>
        <LinkChips label={t("common.status")} items={RECEIPT_FILTERS.map((state) => ({ value: state, label: t(`receipts.filters.${state}`), href: withSearch(search, { state }), selected: filters.state === state, count: page.counts[state] }))} />
        <Form method="get" className="flex flex-wrap items-end gap-3" role="search">
          <input type="hidden" name="state" value={filters.state} />
          <TextField name="q" type="search" label={t("common.search")} defaultValue={filters.q} placeholder={t("receipts.searchHint")} className="min-w-[14rem] flex-1" />
          <Key type="submit" variant="ink" icon="magnifying-glass">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList
          caption={t("receipts.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "ref", header: t("common.reference"), cell: (row) => <RowLink to={`/admin/purchasing/receipts/${row.id}`}><Code>{row.ref}</Code></RowLink> },
            { key: "po", header: t("common.order"), cell: (row) => (row.po ? <RowLink to={`/admin/purchasing/orders/${row.po.id}`}><Code>{row.po.ref}</Code></RowLink> : "—") },
            { key: "supplier", header: t("common.supplier"), cell: (row) => row.supplier?.name ?? "—" },
            { key: "location", header: t("common.location"), cell: (row) => <Code>{row.location}</Code> },
            { key: "state", header: t("common.status"), cell: (row) => <StateTag group="receipt" value={row.state} label={t(`receiptState.${row.state}`)} /> },
            { key: "units", header: t("receipt.units"), numeric: true, cell: (row) => <Num value={row.units} /> },
            { key: "rejected", header: t("receipt.rejected"), numeric: true, cell: (row) => <Num value={row.rejected} className={row.rejected > 0 ? "text-red-ink" : undefined} /> },
            { key: "at", header: t("receipt.receivedAt"), cell: (row) => <When at={row.receivedAt} /> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/purchasing/receipts/${row.id}`} className="adm-link type-strong">
                  <Code>{row.ref}</Code>
                </Link>
                <StateTag group="receipt" value={row.state} label={t(`receiptState.${row.state}`)} />
              </div>
              <p className="type-body">
                {row.supplier?.name ?? "—"} {row.po ? <>· <Code>{row.po.ref}</Code></> : null}
              </p>
              <Pair label={t("receipt.units")}>
                <Num value={row.units} />
                {row.rejected > 0 ? <span className="text-red-ink"> · {t("receipt.rejectedN", { count: row.rejected })}</span> : null}
              </Pair>
              <Pair label={t("receipt.receivedAt")}>
                <When at={row.receivedAt} />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="package" title={filters.q ? t("receipts.emptyFiltered") : t("receipts.empty")} text={t("receipts.emptyHint")} />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
        />
      </Section>
    </>
  );
}
