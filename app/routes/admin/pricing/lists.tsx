import { useEffect, useState } from "react";
import { data, Link, useFetcher, useNavigate } from "react-router";

import type { Route } from "./+types/lists";
import { useFormat } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listPriceLists, savePriceList, type PriceListSummary } from "~/server/services/admin/pricing/lists.server";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { emptyListForm, ListForm, LIST_STATE_TONE, type ListFormValues } from "./list-form";
import { failure, formObject, requirePricing } from "./route.server";
import { failureOf, PageHead, pricingMeta, RowLink, useArrow, usePricingT } from "./shared";

/**
 * /admin/pricing/lists — price lists per channel, branch and customer segment (03.04). The page says plainly that the
 * storefront and the point of sale do not apply them yet.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db, ["pricing.price_list.manage", "pricing.price.update", "pricing.price.approve", "pricing.discount.override", "pricing.simulation.run"]);
  return await listPriceLists(db, actor, ctx.locale, ctx.now);
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  if (form.get("intent") !== "save") throw data({ error: "not_found" }, { status: 404 });
  const { actor } = await requirePricing(ctx, db, "pricing.price_list.manage");
  try {
    return { ok: true as const, intent: "save", result: await savePriceList(db, actor, formObject(form), ctx.locale, ctx.now) };
  } catch (error) {
    return failure(error, ctx.locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "lists.title");

export default function PriceLists({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const f = useFormat();
  const navigate = useNavigate();
  const arrow = useArrow();
  const { lists, options, canManage } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const [creating, setCreating] = useState(false);
  const [values, setValues] = useState<ListFormValues>(emptyListForm);
  const [open, setOpen] = useState(false);
  const failed = failureOf(fetcher.data);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      setOpen(false);
      setCreating(false);
      toast.success(t("lists.created"));
      navigate(`/admin/pricing/lists/${fetcher.data.result.id}`);
    }
  }, [fetcher.state, fetcher.data, t, navigate]);

  const columns: DataColumn<PriceListSummary>[] = [
    {
      key: "code",
      header: t("lists.code"),
      cell: (row) => (
        <span className="grid">
          <RowLink to={`/admin/pricing/lists/${row.id}`}>
            <bdi dir="ltr">{row.code}</bdi>
          </RowLink>
          <span className="type-caption text-ink-2">{row.name}</span>
        </span>
      ),
    },
    {
      key: "scope",
      header: t("lists.scope"),
      cell: (row) => (
        <span className="grid type-caption">
          <span>{t("lists.channelIs", { value: row.scopeLabels.channel ?? t("lists.any") })}</span>
          <span>{t("lists.branchIs", { value: row.scopeLabels.branch ?? t("lists.any") })}</span>
          <span>{t("lists.segmentIs", { value: row.scopeLabels.segment ?? t("lists.any") })}</span>
        </span>
      ),
    },
    { key: "priority", header: t("lists.priority"), numeric: true, cell: (row) => f.number(row.priority) },
    { key: "items", header: t("lists.items"), numeric: true, cell: (row) => f.number(row.items) },
    {
      key: "state",
      header: t("col.status"),
      cell: (row) => (
        <span className="grid">
          <Status tone={LIST_STATE_TONE[row.state]}>{t(`lists.state.${row.state}`)}</Status>
          {row.startsAt || row.endsAt ? (
            <span className="type-caption text-ink-2">
              {row.startsAt ? f.dateTime(row.startsAt) : "…"} {arrow} {row.endsAt ? f.dateTime(row.endsAt) : "…"}
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t("lists.title")}
        lead={t("lists.lead")}
        actions={
          canManage && !creating ? (
            <Key size="sm" icon="plus" variant="ink" onClick={() => setCreating(true)}>
              {t("lists.new")}
            </Key>
          ) : null
        }
      />
      <p className="mb-4 max-w-[70ch] rounded-sm bg-niche p-3 type-body text-ink" role="note">
        {t("lists.notApplied")}
      </p>

      {creating ? (
        <section className="adm-card mb-6" aria-labelledby="list-new">
          <h2 id="list-new" className="adm-h2">
            {t("lists.new")}
          </h2>
          <ListForm values={values} onChange={setValues} options={options} errors={failed?.fields} onSubmit={() => setOpen(true)} onCancel={() => setCreating(false)} submitLabel={t("lists.create")} />
        </section>
      ) : null}

      {lists.length === 0 ? (
        <EmptyState icon="stack" title={t("lists.emptyTitle")} text={t("lists.emptyText")} action={canManage && !creating ? <Key onClick={() => setCreating(true)}>{t("lists.new")}</Key> : undefined} />
      ) : (
        <DataTable caption={t("lists.title")} columns={columns} rows={lists} rowKey={(row) => row.id} />
      )}

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("lists.createTitle", { code: values.code || "—" })}
        consequence={t("lists.createConsequence")}
        confirmLabel={t("lists.create")}
        reason={{ minLength: 3, label: t("common.reason") }}
        pending={fetcher.state !== "idle"}
        error={failed ? (failed.message ?? Object.values(failed.fields ?? {}).join(" ")) : undefined}
        onConfirm={({ reason }) => fetcher.submit({ intent: "save", ...values, isActive: values.isActive ? "1" : "", reason }, { method: "post" })}
      />
      <p className="mt-4 type-caption text-ink-2">
        <Link to="/admin/pricing/skus" className="adm-link">
          {t("lists.backToSkus")}
        </Link>
      </p>
    </>
  );
}
