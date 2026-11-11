import { useEffect, useState } from "react";
import { data, Form, Link, useFetcher, useLocation } from "react-router";

import type { Route } from "./+types/changes";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { cancelPriceChange, decidePriceChange, impactsFor, listChanges, type ChangeStatus, type ChangeView, type RequestImpact } from "~/server/services/admin/pricing/prices.server";
import { Chip } from "~/ui/Chip";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { failure, formObject, requirePricing } from "./route.server";
import { ByLine, failureOf, Iqd, iqdText, PageHead, pctText, pricingMeta, RowLink, useArrow, usePricingT, withSearch } from "./shared";

const STATUSES: ChangeStatus[] = ["applied", "pending", "rejected", "cancelled"];

/**
 * /admin/pricing/changes — the approval queue (mobile-first cards: approve or reject with the impact shown first; the
 * requester may only withdraw) and the full price-change log with filters in the URL and a CSV export (03.05).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db);
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "history" ? ("history" as const) : ("pending" as const);
  const status = url.searchParams.get("status");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1;
  const [result, waiting] = await Promise.all([
    listChanges(db, actor, { tab, q, status: tab === "history" && STATUSES.includes(status as ChangeStatus) ? (status as ChangeStatus) : null, page, limit: tab === "pending" ? 100 : 50 }, ctx.locale),
    tab === "pending" ? Promise.resolve(null) : listChanges(db, actor, { tab: "pending", limit: 1 }, ctx.locale),
  ]);
  const impacts = tab === "pending" ? await impactsFor(db, actor, result.items, ctx.now) : {};
  return {
    tab,
    q,
    status: tab === "history" && STATUSES.includes(status as ChangeStatus) ? status : "",
    result,
    waitingCount: tab === "pending" ? result.total : (waiting?.total ?? 0),
    impacts,
    canApprove: can(actor, "pricing.price.approve"),
    canOverride: can(actor, "pricing.discount.override"),
    seesMargins: can(actor, "profit.read"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "approve" && intent !== "reject" && intent !== "cancel") throw data({ error: "not_found" }, { status: 404 });
  const { actor } = await requirePricing(ctx, db, intent === "cancel" ? "pricing.price.update" : "pricing.price.approve");
  const fields = formObject(form);
  try {
    if (intent === "cancel") return { ok: true as const, intent, result: await cancelPriceChange(db, actor, { requestId: fields.requestId, note: fields.note }, ctx.now) };
    return { ok: true as const, intent, result: await decidePriceChange(db, actor, { requestId: fields.requestId, decision: intent, note: fields.note }, ctx.locale, ctx.now) };
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "changes.title");

type LoaderData = Route.ComponentProps["loaderData"];

export default function PriceChanges({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const { search } = useLocation();
  const { tab } = loaderData;
  return (
    <>
      <PageHead
        title={t("changes.title")}
        lead={t("changes.lead")}
        actions={
          tab === "history" ? (
            <Key as="a" href={`/admin/pricing/export/changes${search}`} download icon="download-simple" size="sm">
              {t("common.exportCsv")}
            </Key>
          ) : null
        }
      />
      <nav aria-label={t("changes.tabs")} className="mb-4 flex flex-wrap gap-2">
        <Chip as={Link} to="?tab=pending" selected={tab === "pending"}>
          {t("changes.tabPending", { count: loaderData.waitingCount })}
        </Chip>
        <Chip as={Link} to="?tab=history" selected={tab === "history"}>
          {t("changes.tabHistory")}
        </Chip>
      </nav>
      {tab === "pending" ? <Queue data={loaderData} /> : <HistoryTable data={loaderData} />}
    </>
  );
}

/* ───────────────────────────── the queue ───────────────────────────── */

function impactRows(t: ReturnType<typeof usePricingT>, f: ReturnType<typeof useFormat>, change: ChangeView, impact: RequestImpact | undefined, arrow: string): ImpactRow[] {
  const drop = change.oldPriceIqd ? Math.trunc(((change.newPriceIqd - change.oldPriceIqd) * 10_000) / change.oldPriceIqd) : null;
  const rows: ImpactRow[] = [
    { label: t("impact.price"), value: `${iqdText(f, change.oldPriceIqd)} ${arrow} ${iqdText(f, change.newPriceIqd)}` },
    { label: t("impact.change"), value: pctText(f, drop, true), negative: (drop ?? 0) < 0 },
    { label: t("impact.compareAt"), value: change.newCompareAtIqd !== null ? iqdText(f, change.newCompareAtIqd) : t("impact.none") },
  ];
  if (impact) {
    // The 10 % limit counts from the highest price of the last 30 days: show it when it is above the request's old price.
    if (impact.referencePriceIqd > (change.oldPriceIqd ?? impact.referencePriceIqd)) {
      rows.push({ label: t("impact.reference"), value: `${iqdText(f, impact.referencePriceIqd)} · ${pctText(f, impact.referenceDropBps === null ? null : -impact.referenceDropBps, true)}`, negative: (impact.referenceDropBps ?? 0) > 0 });
    }
    rows.push({ label: t("impact.stockValue", { count: impact.onHand }), value: iqdText(f, impact.stockValueDeltaIqd, true), negative: impact.stockValueDeltaIqd < 0 });
    if (impact.marginAfterBps !== undefined) {
      rows.push({ label: t("impact.margin"), value: `${pctText(f, impact.marginBeforeBps ?? null)} ${arrow} ${pctText(f, impact.marginAfterBps ?? null)}`, negative: (impact.marginAfterBps ?? 0) < (impact.marginBeforeBps ?? 0) });
      rows.push({ label: t("impact.floor"), value: iqdText(f, impact.floorIqd ?? null) });
    }
  }
  return rows;
}

function Queue({ data: loaderData }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const arrow = useArrow();
  const items = loaderData.result.items;
  const fetcher = useFetcher<typeof action>();
  const [dialog, setDialog] = useState<{ change: ChangeView; intent: "approve" | "reject" | "cancel" } | null>(null);
  const failed = failureOf(fetcher.data);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      setDialog(null);
      toast.success(t(`changes.done.${fetcher.data.intent}`));
    }
  }, [fetcher.state, fetcher.data, t]);

  if (items.length === 0) return <EmptyState icon="seal-check" title={t("changes.emptyTitle")} text={t("changes.emptyText")} action={<Key as={Link} to="/admin/pricing/skus">{t("nav.skus")}</Key>} />;

  return (
    <>
      <ul role="list" className="grid gap-3 lg:grid-cols-2">
        {items.map((change) => {
          const impact = loaderData.impacts[change.id];
          const needsOverride = change.needsOverride ?? impact?.needsOverride ?? false;
          const mayDecide = loaderData.canApprove && !change.mine && (!needsOverride || loaderData.canOverride);
          return (
            <li key={change.id} className="adm-card adm-card--act">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="grid">
                  <RowLink to={`/admin/pricing/skus/${change.variantId}`}>
                    <bdi dir="ltr">{change.sku}</bdi>
                  </RowLink>
                  <span className="type-caption text-ink-2">{change.name}</span>
                </span>
                <span className="grid justify-items-end">
                  <span className="type-strong">
                    <Iqd value={change.oldPriceIqd} strike /> <Iqd value={change.newPriceIqd} />
                  </span>
                  {change.newCompareAtIqd !== null ? <span className="type-caption text-ink-2">{t("changes.wasShown", { price: iqdText(f, change.newCompareAtIqd) })}</span> : null}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {change.mode === "clearance" ? <Status tone="info">{t("sku.modeClearance")}</Status> : null}
                {change.reasons.map((reason) => (
                  <Status key={reason} tone={reason === "below_cost" || reason === "below_min_margin" ? "bad" : "warn"}>
                    {t(`reason.${reason}`)}
                  </Status>
                ))}
                {needsOverride && loaderData.seesMargins ? <Status tone="bad">{t("changes.needsOverride")}</Status> : null}
              </div>
              {impact && impact.marginAfterBps !== undefined ? (
                <p className="type-caption text-ink">
                  {t("changes.marginLine", { before: pctText(f, impact.marginBeforeBps ?? null), after: pctText(f, impact.marginAfterBps ?? null) })}
                </p>
              ) : null}
              {impact && !impact.current ? (
                <p className="type-caption text-red-ink" role="note">
                  {t("changes.stale")}
                </p>
              ) : null}
              {change.reason ? (
                <p className="type-body text-ink">
                  <span className="text-ink-2">{t("col.reason")}: </span>
                  {change.reason}
                </p>
              ) : null}
              <ByLine name={change.requestedBy?.name} at={change.createdAt} />
              <div className="flex flex-wrap gap-2 pt-1">
                {mayDecide ? (
                  <>
                    <Key size="sm" variant="ink" onClick={() => setDialog({ change, intent: "approve" })} disabled={impact ? !impact.current : false}>
                      {t("changes.approve")}
                    </Key>
                    <Key size="sm" onClick={() => setDialog({ change, intent: "reject" })}>
                      <span className="text-red-ink">{t("changes.reject")}</span>
                    </Key>
                  </>
                ) : null}
                {change.mine ? (
                  <Key size="sm" onClick={() => setDialog({ change, intent: "cancel" })}>
                    {t("changes.cancel")}
                  </Key>
                ) : null}
              </div>
              {change.mine ? <p className="type-caption text-ink-2">{t("changes.ownRequest")}</p> : null}
              {!change.mine && loaderData.canApprove && needsOverride && !loaderData.canOverride ? <p className="type-caption text-ink-2">{t("changes.overrideMissing")}</p> : null}
            </li>
          );
        })}
      </ul>
      {dialog ? (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          tone={dialog.intent === "approve" ? "neutral" : "destructive"}
          title={t(`changes.${dialog.intent}Title`, { sku: dialog.change.sku })}
          consequence={t(`changes.${dialog.intent}Consequence`)}
          confirmLabel={t(`changes.${dialog.intent}`)}
          impact={impactRows(t, f, dialog.change, loaderData.impacts[dialog.change.id], arrow)}
          reason={dialog.intent === "reject" ? { minLength: 3, label: t("changes.rejectReason"), hint: t("changes.rejectHint") } : { noteRequired: false, label: t("common.note") }}
          pending={fetcher.state !== "idle"}
          error={failed ? (failed.message ?? t("errors.generic")) : undefined}
          onConfirm={({ reason }) => fetcher.submit({ intent: dialog.intent, requestId: dialog.change.id, note: reason }, { method: "post" })}
        />
      ) : null}
    </>
  );
}

/* ───────────────────────────── the log ───────────────────────────── */

function HistoryTable({ data: loaderData }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const { search } = useLocation();
  const { result } = loaderData;
  const columns: DataColumn<ChangeView>[] = [
    { key: "date", header: t("col.date"), cell: (row) => <bdi className="nums">{f.dateTime(row.createdAt)}</bdi> },
    {
      key: "sku",
      header: t("col.sku"),
      cell: (row) => (
        <span className="grid">
          <RowLink to={`/admin/pricing/skus/${row.variantId}`}>
            <bdi dir="ltr">{row.sku}</bdi>
          </RowLink>
          <span className="type-caption text-ink-2">{row.name}</span>
        </span>
      ),
    },
    { key: "old", header: t("col.oldPriceIqd"), numeric: true, cell: (row) => <Iqd value={row.oldPriceIqd} /> },
    { key: "new", header: t("col.newPriceIqd"), numeric: true, cell: (row) => <Iqd value={row.newPriceIqd} /> },
    { key: "was", header: t("col.compareAtIqd"), numeric: true, cell: (row) => <Iqd value={row.newCompareAtIqd} /> },
    {
      key: "status",
      header: t("col.status"),
      cell: (row) => (
        <span className="grid">
          <Status tone={row.status === "applied" ? "ok" : row.status === "pending" ? "warn" : "neutral"}>{t(`changes.status.${row.status}`)}</Status>
          <span className="type-caption text-ink-2">
            {t(`changes.kind.${row.kind}`)}
            {row.mode === "clearance" ? ` · ${t("sku.modeClearance")}` : ""}
            {row.source !== "manual" ? ` · ${t(`changes.source.${row.source}`)}` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "people",
      header: t("col.people"),
      cell: (row) => (
        <span className="grid">
          <span className="type-caption">{t("changes.requestedBy", { name: row.requestedBy?.name ?? "—" })}</span>
          {row.decidedBy ? <span className="type-caption">{t("changes.decidedBy", { name: row.decidedBy.name })}</span> : null}
        </span>
      ),
    },
    { key: "reason", header: t("col.reason"), cell: (row) => <span className="block max-w-[22rem] type-caption">{[row.reason, row.decisionNote].filter(Boolean).join(" — ")}</span> },
  ];
  return (
    <>
      <Form method="get" className="mb-4 grid gap-3 rounded-sm bg-paper p-3 shadow-[inset_0_0_0_1px_var(--line)] sm:grid-cols-[2fr_1fr_auto]" role="search" aria-label={t("changes.filters")}>
        <input type="hidden" name="tab" value="history" />
        <TextField name="q" type="search" label={t("filters.search")} defaultValue={loaderData.q} />
        <Select name="status" label={t("col.status")} defaultValue={loaderData.status ?? ""} options={[{ value: "", label: t("filters.all") }, ...STATUSES.map((status) => ({ value: status, label: t(`changes.status.${status}`) }))]} />
        <div className="flex items-end gap-2">
          <Key type="submit" variant="ink" icon="funnel">
            {t("filters.apply")}
          </Key>
        </div>
      </Form>
      <p className="mb-3 type-caption text-ink-2" role="status">
        {t("changes.count", { count: result.total })}
      </p>
      <DataTable
        caption={t("changes.historyCaption")}
        columns={columns}
        rows={result.items}
        rowKey={(row) => row.id}
        empty={<p className="p-4 type-body text-ink-2">{t("changes.historyEmpty")}</p>}
        footer={<Pagination page={result.page} pageCount={result.pageCount} href={(n) => withSearch(search, { page: n })} />}
      />
    </>
  );
}
