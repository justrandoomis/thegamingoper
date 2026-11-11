import { Form, Link } from "react-router";

import type { Route } from "./+types/landed";
import { useFormat } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { listReceiptsForLanded, type ReceiptSummary } from "~/server/services/admin/pricing/landed.server";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { requirePricing } from "./route.server";
import { Iqd, PageHead, pricingMeta, RowLink, usePricingT } from "./shared";

/**
 * /admin/pricing/landed — receipts and their freight, customs, fees and commissions (03.02). Receipts are created by
 * purchasing (module 09); bills are spread over a receipt's lines before it is posted. Everything here is [P].
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db, "cost.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  try {
    return { receipts: await listReceiptsForLanded(db, actor, { status: status === "draft" || status === "posted" ? status : null, q }, ctx.locale), status: status ?? "", q };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "landed.title");

export default function LandedCosts({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const f = useFormat();
  const { receipts } = loaderData;
  const columns: DataColumn<ReceiptSummary>[] = [
    {
      key: "ref",
      header: t("landed.receipt"),
      cell: (row) => (
        <span className="grid">
          <RowLink to={`/admin/pricing/landed/${row.id}`}>
            <bdi dir="ltr">{row.ref}</bdi>
          </RowLink>
          <span className="type-caption text-ink-2">
            {[row.supplier, row.poRef ? `PO ${row.poRef}` : null, row.location].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    { key: "date", header: t("col.date"), cell: (row) => <bdi className="nums">{f.date(row.receivedAt ?? row.createdAt)}</bdi> },
    { key: "status", header: t("col.status"), cell: (row) => <Status tone={row.status === "draft" ? "warn" : "ok"}>{t(`landed.status.${row.status}`)}</Status> },
    { key: "units", header: t("landed.units"), numeric: true, cell: (row) => f.number(row.units) },
    { key: "goods", header: t("landed.goods"), numeric: true, cell: (row) => <Iqd value={row.goodsIqd} /> },
    { key: "bills", header: t("landed.bills"), numeric: true, cell: (row) => <Iqd value={row.billsIqd} /> },
    {
      key: "state",
      header: t("landed.allocation"),
      cell: (row) =>
        row.billsDraft > 0 ? (
          <Status tone="warn">{t("landed.toAllocate", { count: row.billsDraft })}</Status>
        ) : row.billsAllocated > 0 ? (
          <Status tone="ok">{t("landed.allocated")}</Status>
        ) : (
          <Status tone="neutral">{t("landed.noBills")}</Status>
        ),
    },
  ];
  return (
    <>
      <PageHead title={t("landed.title")} lead={t("landed.lead")} />
      <Form method="get" className="mb-4 grid gap-3 rounded-sm bg-paper p-3 shadow-[inset_0_0_0_1px_var(--line)] sm:grid-cols-[2fr_1fr_auto]" role="search" aria-label={t("landed.filters")}>
        <TextField name="q" type="search" label={t("landed.search")} defaultValue={loaderData.q} ltr />
        <Select
          name="status"
          label={t("col.status")}
          defaultValue={loaderData.status}
          options={[
            { value: "", label: t("filters.all") },
            { value: "draft", label: t("landed.status.draft") },
            { value: "posted", label: t("landed.status.posted") },
          ]}
        />
        <div className="flex items-end">
          <Key type="submit" variant="ink" icon="funnel">
            {t("filters.apply")}
          </Key>
        </div>
      </Form>
      {receipts.length === 0 ? (
        <EmptyState icon="truck" title={t("landed.emptyTitle")} text={t("landed.emptyText")} action={<Key as={Link} to="/admin/pricing/skus">{t("nav.skus")}</Key>} />
      ) : (
        <DataTable caption={t("landed.title")} columns={columns} rows={receipts} rowKey={(row) => row.id} />
      )}
      <p className="mt-4 max-w-[70ch] type-caption text-ink-2">{t("landed.postedNote")}</p>
    </>
  );
}
