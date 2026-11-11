import { useEffect, useState } from "react";
import { data, Form, Link, useFetcher, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/skus";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { can } from "~/server/actor";
import { fieldAccess } from "~/server/services/admin/pricing/access";
import { setMarginRulesBulk } from "~/server/services/admin/pricing/costs.server";
import { listSkuPrices, parsePriceFilters, PRICE_VIEWS, type PriceView, type SkuRow } from "~/server/services/admin/pricing/prices.server";
import { PRODUCT_KINDS, PRODUCT_STATUSES } from "~/server/db/schema";
import { Chip } from "~/ui/Chip";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { failure, formObject, requirePricing } from "./route.server";
import { failureOf, Iqd, MarginStatus, PageHead, pricingMeta, RowLink, usePricingT, withSearch } from "./shared";

/**
 * /admin/pricing/skus — every SKU with its price and "was" price, stock, and — for those allowed — landed cost and
 * margin against its rules (03.01, 03.03). Filters, sort and page live in the URL (works without JavaScript); CSV
 * export with the same filters and the same field rules; bulk margin rules for the selected rows (03.03).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db);
  const url = new URL(request.url);
  const filters = parsePriceFilters(url.searchParams, fieldAccess(actor));
  const page = await listSkuPrices(db, actor, filters, ctx.locale);
  const views = PRICE_VIEWS.filter((view) => {
    const need = VIEW_NEEDS[view];
    return !need || (need === "cost" ? page.access.cost : page.access.profit);
  });
  return { page, filters, views, kinds: [...PRODUCT_KINDS], statuses: [...PRODUCT_STATUSES], canBulkMargins: can(actor, "pricing.margin.manage") && can(actor, "profit.read") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const intent = typeof form.get("intent") === "string" ? String(form.get("intent")) : null;
  if (intent !== "bulk-margins") throw data({ error: "not_found" }, { status: 404 });
  const { actor } = await requirePricing(ctx, db, "pricing.margin.manage");
  try {
    const fields = formObject(form);
    const result = await setMarginRulesBulk(db, actor, { variantIds: form.getAll("variantId").map(String), minMargin: fields.minMargin, targetMargin: fields.targetMargin, reason: fields.reason }, ctx.now);
    return { ok: true as const, intent, ...result };
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "skus.title");

const VIEW_NEEDS: Partial<Record<PriceView, "cost" | "profit">> = { below_min: "profit", below_target: "profit", no_cost: "cost" };

export default function SkuPrices({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const f = useFormat();
  const { page, filters, views, kinds, statuses, canBulkMargins } = loaderData;
  const activeFilters = [filters.q, filters.kind, filters.platform, filters.status].filter(Boolean).length;
  const { search } = useLocation();
  const navigation = useNavigation();
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/pricing/skus";
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState(false);
  const [minMargin, setMinMargin] = useState("");
  const [targetMargin, setTargetMargin] = useState("");
  const fetcher = useFetcher<typeof action>();
  const failed = failureOf(fetcher.data);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      setDialog(false);
      setSelected([]);
      toast.success(t("skus.bulkDone", { updated: fetcher.data.updated, skipped: fetcher.data.skipped }));
    }
  }, [fetcher.state, fetcher.data, t]);

  const columns: DataColumn<SkuRow>[] = [
    {
      key: "sku",
      header: t("col.sku"),
      sortable: true,
      cell: (row) => (
        <span className="grid">
          <RowLink to={`/admin/pricing/skus/${row.variantId}`}>
            <bdi dir="ltr">{row.sku}</bdi>
          </RowLink>
          {row.pendingId ? <Status tone="warn">{t("skus.waiting")}</Status> : null}
        </span>
      ),
    },
    {
      key: "name",
      header: t("col.product"),
      sortable: true,
      cell: (row) => (
        <span className="grid min-w-[14rem] max-w-[24rem]">
          <span className="type-body text-ink">{row.name}</span>
          <span className="type-caption text-ink-2">
            {row.variantTitle ? (
              <>
                <bdi>{row.variantTitle}</bdi> ·{" "}
              </>
            ) : null}
            {t(`kind.${row.kind}`)} · {t(`productStatus.${row.productStatus}`)}
            {row.isBundle ? ` · ${t("skus.bundle")}` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "price",
      header: t("col.priceIqd"),
      numeric: true,
      sortable: true,
      firstDir: "desc",
      cell: (row) => (
        <span className="grid justify-items-end">
          <Iqd value={row.priceIqd} />
          {row.compareAtIqd !== null ? <Iqd value={row.compareAtIqd} strike className="type-caption" /> : null}
        </span>
      ),
    },
    { key: "stock", header: t("col.onHand"), numeric: true, sortable: true, firstDir: "desc", cell: (row) => f.number(row.onHand) },
  ];
  if (page.access.cost) {
    columns.push({
      key: "landed",
      header: t("col.landedIqd"),
      numeric: true,
      cell: (row) => (row.cost?.landedIqd === null || row.cost === undefined ? <span title={t("margin.noCostHint")}>—</span> : <Iqd value={row.cost.landedIqd} />),
    });
  }
  if (page.access.profit) {
    columns.push({ key: "margin", header: t("col.margin"), sortable: true, firstDir: "asc", cell: (row) => (row.margin ? <span className="whitespace-nowrap"><MarginStatus state={row.margin.state} bps={row.margin.bps} /></span> : null) });
  }

  const sort = { key: filters.sort, dir: filters.dir };
  const exportHref = `/admin/pricing/export/skus${search || ""}`;

  return (
    <>
      <PageHead
        title={t("skus.title")}
        lead={t("skus.lead")}
        actions={
          <Key as="a" href={exportHref} download icon="download-simple" size="sm">
            {t("common.exportCsv")}
          </Key>
        }
      />

      {/* Phones: the filters fold away so the list comes first; wider screens show them open. Works without JavaScript. */}
      <details className="mb-4 rounded-sm bg-paper shadow-[inset_0_0_0_1px_var(--line)] md:hidden" open={activeFilters > 0}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 type-label text-ink">
          <Icon name="funnel" size={16} />
          {t("skus.filters")}
          {activeFilters > 0 ? <span className="type-caption text-ink-2">({f.number(activeFilters)})</span> : null}
          <Icon name="caret-down" size={16} className="ms-auto" />
        </summary>
        <div className="p-3 pt-0">
          <SkuFilters filters={filters} kinds={kinds} statuses={statuses} platforms={page.platforms} />
        </div>
      </details>
      <div className="mb-4 hidden rounded-sm bg-paper p-3 shadow-[inset_0_0_0_1px_var(--line)] md:block">
        <SkuFilters filters={filters} kinds={kinds} statuses={statuses} platforms={page.platforms} />
      </div>

      <nav aria-label={t("skus.views")} className="chips mb-4 flex flex-wrap gap-2">
        {views.map((view) => (
          <Chip key={view} as={Link} to={withSearch(search, { view: view === "all" ? null : view })} selected={filters.view === view} preventScrollReset>
            {t(`skus.view.${view}`)}
          </Chip>
        ))}
      </nav>

      <p className="mb-3 type-caption text-ink-2" role="status">
        {t("skus.count", { count: page.total })}
        {!page.access.cost ? ` ${t("skus.noCostAccess")}` : !page.access.profit ? ` ${t("skus.noProfitAccess")}` : ""}
      </p>

      {page.rows.length === 0 ? (
        <EmptyState icon="magnifying-glass" title={t("skus.emptyTitle")} text={t("skus.emptyText")} action={<Key as={Link} to="/admin/pricing/skus">{t("filters.clear")}</Key>} />
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable
              caption={t("skus.title")}
              columns={columns}
              rows={page.rows}
              rowKey={(row) => row.variantId}
              rowLabel={(row) => row.sku}
              sort={sort}
              sortHref={(next) => withSearch(search, { sort: next.key, dir: next.dir })}
              selected={canBulkMargins ? selected : undefined}
              onSelectedChange={canBulkMargins ? setSelected : undefined}
              bulkActions={() => (
                <Key size="sm" variant="ink" onClick={() => setDialog(true)}>
                  {t("skus.bulkMargins")}
                </Key>
              )}
              busy={busy}
              footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
            />
          </div>
          <ul role="list" className="grid gap-2 md:hidden" aria-label={t("skus.title")}>
            {page.rows.map((row) => (
              <li key={row.variantId}>
                <Link to={`/admin/pricing/skus/${row.variantId}`} className="adm-card no-underline" prefetch="intent">
                  <span className="flex items-start justify-between gap-3">
                    <span className="grid">
                      <span className="type-strong text-ink">{row.name}</span>
                      <bdi dir="ltr" className="type-caption text-ink-2">
                        {row.sku}
                      </bdi>
                    </span>
                    <span className="grid justify-items-end">
                      <Iqd value={row.priceIqd} className="type-strong" />
                      {row.compareAtIqd !== null ? <Iqd value={row.compareAtIqd} strike className="type-caption" /> : null}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 type-caption text-ink-2">
                    <span>{t("skus.onHandShort", { count: row.onHand })}</span>
                    {row.cost ? (
                      <span>
                        {t("skus.landedLabel")}: <Iqd value={row.cost.landedIqd} />
                      </span>
                    ) : null}
                    {row.margin ? <MarginStatus state={row.margin.state} bps={row.margin.bps} /> : null}
                    {row.pendingId ? <Status tone="warn">{t("skus.waiting")}</Status> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination className="mt-4 md:hidden" page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />
        </>
      )}

      <ConfirmDialog
        open={dialog}
        onClose={() => setDialog(false)}
        title={t("skus.bulkTitle", { count: selected.length })}
        consequence={t("skus.bulkConsequence")}
        confirmLabel={t("skus.bulkConfirm")}
        reason={{ minLength: 3, label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={fetcher.state !== "idle"}
        error={failed ? (failed.fields ? Object.values(failed.fields).join(" ") : (failed.message ?? t("errors.generic"))) : undefined}
        onConfirm={({ reason }) => {
          const body = new FormData();
          body.set("intent", "bulk-margins");
          for (const id of selected) body.append("variantId", id);
          body.set("minMargin", minMargin);
          body.set("targetMargin", targetMargin);
          body.set("reason", reason);
          fetcher.submit(body, { method: "post" });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t("margin.min")} inputMode="decimal" value={minMargin} onChange={(event) => setMinMargin(event.currentTarget.value)} end="%" hint={t("margin.minHint")} error={failed?.fields?.minMargin} />
          <TextField label={t("margin.target")} inputMode="decimal" value={targetMargin} onChange={(event) => setTargetMargin(event.currentTarget.value)} end="%" hint={t("margin.targetHint")} error={failed?.fields?.targetMargin} />
        </div>
      </ConfirmDialog>
    </>
  );
}

type FilterProps = { filters: Route.ComponentProps["loaderData"]["filters"]; kinds: string[]; statuses: string[]; platforms: { slug: string; name: string }[] };

function SkuFilters({ filters, kinds, statuses, platforms }: FilterProps) {
  const t = usePricingT();
  return (
    <Form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]" role="search" aria-label={t("skus.filters")}>
      <TextField name="q" type="search" label={t("filters.search")} defaultValue={filters.q} hint={t("filters.searchHint")} />
      <Select name="kind" label={t("filters.kind")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("filters.all") }, ...kinds.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))]} />
      <Select name="platform" label={t("filters.platform")} defaultValue={filters.platform ?? ""} options={[{ value: "", label: t("filters.all") }, ...platforms.map((platform) => ({ value: platform.slug, label: platform.name }))]} />
      <Select name="status" label={t("filters.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("filters.all") }, ...statuses.map((status) => ({ value: status, label: t(`productStatus.${status}`) }))]} />
      {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
      <div className="flex items-end gap-2">
        <Key type="submit" variant="ink" icon="funnel">
          {t("filters.apply")}
        </Key>
        <Key as={Link} to="/admin/pricing/skus" variant="quiet">
          {t("filters.clear")}
        </Key>
      </div>
    </Form>
  );
}
