import { useEffect, useMemo, useState } from "react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";

import type { Route } from "./+types/product-list";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { bulkUpdateProducts, categoryOptions, listProducts, parseProductFilters, platformOptions, productsByExactCode } from "~/server/services/admin/catalog/product.server";
import type { ProductListRow } from "~/server/services/admin/catalog/product.server";
import { ADMIN_STATUSES, LICENSE_TYPE_LIST, MEDIA_FORMAT_LIST, PRODUCT_KIND_LIST, PRODUCT_SORTS, type AdminStatus } from "~/server/services/admin/catalog/rules";
import { bulkChangeStatus } from "~/server/services/admin/catalog/workflow.server";
import { ConfirmDialog, Dialog } from "~/ui/Dialog";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { PlatformLabel, isPlatform } from "~/ui/PlatformLed";
import { Status } from "~/ui/Tag";
import { ModuleFunctions } from "../blueprint-status";
import { adminMeta } from "../shell/meta";
import { catalogRequest, formObject, runIntent } from "./catalog.server";
import { FailureNotice, FilterFields, PriceRange, StatusBadge, Thumb, isFailure, useAnswerToast, useCatalogT, useFieldError, useKindLabel } from "./components/ui";

/**
 * /admin/catalog — every product: search (name, SKU, barcode, model number — a barcode scanner types into the
 * search field and Enter opens the product it names), filters and sorting in the URL (a GET form: works without
 * JavaScript, survives Back), readiness per product (02.03), bulk field edits and bulk publishing actions (02.05,
 * 02.06), CSV export. Archived products appear only under their own status.
 */
export async function loader({ context, url }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await catalogRequest(context, "catalog.product.read");
  const filters = parseProductFilters(url.searchParams);
  // A scanner sends the barcode and Enter: one exact match opens the product.
  if (/^\d{8,14}$/.test(filters.q) && filters.page === 1) {
    const products = await productsByExactCode(db, actor, filters.q);
    if (products.length === 1) throw redirect(`/admin/catalog/products/${products[0]}?scanned=${encodeURIComponent(filters.q)}`);
  }
  const [result, platforms, categories] = await Promise.all([listProducts(db, actor, filters, locale, now), platformOptions(db, locale), categoryOptions(db, locale)]);
  return {
    filters,
    result,
    platforms,
    categories,
    can: {
      create: can(actor, "catalog.product.create"),
      bulkEdit: can(actor, "catalog.product.import") && can(actor, "catalog.product.update"),
      export: can(actor, "catalog.product.export"),
      review: can(actor, "catalog.product.update"),
      publish: can(actor, "catalog.product.publish"),
      archive: can(actor, "catalog.product.archive"),
    },
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.product.read");
  const form = formObject(await request.formData());
  const ids = Array.isArray(form.ids) ? form.ids : typeof form.ids === "string" ? [form.ids] : [];
  return runIntent(req, form.intent, {
    bulk_update: async () => {
      const outcome = await bulkUpdateProducts(req.db, req.actor, { ids, set: form.set ?? {}, reason: form.reason }, req.now);
      return { updated: outcome.updated.length, skipped: outcome.skipped.length };
    },
    bulk_status: async () => {
      const outcome = await bulkChangeStatus(req.db, req.actor, { ids, action: form.action, reason: form.reason }, req.now);
      return { updated: outcome.changed.length, skipped: outcome.skipped.length };
    },
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.catalog"));

/** The list URL with some parameters changed (and the page reset unless it is the page that changes). */
function withParams(filters: Route.ComponentProps["loaderData"]["filters"], change: Record<string, string | null>): string {
  const params = new URLSearchParams();
  const current: Record<string, string | null> = {
    q: filters.q || null,
    status: filters.status,
    platform: filters.platform,
    category: filters.category,
    kind: filters.kind,
    incomplete: filters.incomplete ? "1" : null,
    sort: filters.sort === "updated" ? null : filters.sort,
    page: null,
  };
  for (const [key, value] of Object.entries({ ...current, ...change })) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/admin/catalog?${query}` : "/admin/catalog";
}

export default function ProductList({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const kindLabel = useKindLabel();
  const navigation = useNavigation();
  const { filters, result, platforms, categories, can: allowed } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<null | "fields" | "submit_review" | "hide" | "archive">(null);
  const bulk = useFetcher<typeof action>({ key: "catalog-bulk" });
  const bulkData = bulk.data as unknown;
  const fieldError = useFieldError(bulkData);
  useAnswerToast(bulk, (data) => t("list.bulkDone", { updated: f.number(Number(data.updated ?? 0)), skipped: f.number(Number(data.skipped ?? 0)) }));

  const loading = navigation.state === "loading" && navigation.location?.pathname === "/admin/catalog";
  const filtered = Boolean(filters.q || filters.status || filters.platform || filters.category || filters.kind || filters.incomplete);
  const visibleIds = useMemo(() => new Set(result.rows.map((row) => row.id)), [result.rows]);
  const chosen = selected.filter((id) => visibleIds.has(id));
  // What a bulk hide / archive does to the store: the chosen products on it now leave it; their stock stays.
  const chosenRows = result.rows.filter((row) => chosen.includes(row.id));
  const leaving = (action: "hide" | "archive") => chosenRows.filter((row) => row.storedStatus === "published" || (action === "archive" && row.live)).length;
  const chosenUnits = chosenRows.reduce((sum, row) => sum + row.available, 0);

  const close = () => setDialog(null);
  const submitBulk = (intent: "bulk_update" | "bulk_status", fields: Record<string, string>) => {
    const data = new FormData();
    data.set("intent", intent);
    for (const id of chosen) data.append("ids", id);
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    bulk.submit(data, { method: "post" });
  };
  // Close the dialog and clear the selection once the request has gone through.
  useEffect(() => {
    if (bulk.state === "idle" && bulk.data && !isFailure(bulk.data)) {
      setDialog(null);
      setSelected([]);
    }
  }, [bulk.state, bulk.data]);

  const columns: DataColumn<ProductListRow>[] = [
    {
      key: "product",
      header: t("list.colProduct"),
      cell: (row) => (
        <span className="flex min-w-[16rem] items-center gap-3 py-1.5">
          <Thumb image={row.image} size={40} />
          <span className="grid min-w-0 gap-0.5">
            <Link to={`/admin/catalog/products/${row.id}`} className="adm-link line-clamp-2">
              <bdi>{row.name}</bdi>
            </Link>
            <span className="type-caption text-ink-2">
              <bdi dir="ltr">{row.skus.length > 0 ? row.skus.slice(0, 2).join(" · ") : row.slug}</bdi>
              {row.skus.length > 2 ? <bdi dir="ltr"> +{row.skus.length - 2}</bdi> : null}
            </span>
          </span>
        </span>
      ),
    },
    { key: "kind", header: t("list.colKind"), cell: (row) => <span className="whitespace-nowrap">{kindLabel(row.kind)}</span> },
    {
      key: "platform",
      header: t("list.colPlatform"),
      cell: (row) =>
        row.platform ? (
          isPlatform(row.platform.accent) ? (
            <PlatformLabel platform={row.platform.accent} label={row.platform.name} />
          ) : (
            <span>{row.platform.name}</span>
          )
        ) : (
          <span className="text-ink-2">{t("list.multiPlatform")}</span>
        ),
    },
    { key: "status", header: t("list.colStatus"), cell: (row) => <StatusBadge status={row.status} publishAt={row.publishAt} live={row.live} /> },
    {
      key: "ready",
      header: t("list.colReady"),
      cell: (row) =>
        row.complete ? (
          <Status tone="ok" className="whitespace-nowrap">{t("list.ready")}</Status>
        ) : (
          <span title={row.missing.map((key) => (key.startsWith("custom:") ? t("requirement.custom", { name: key.slice(7) }) : t(`requirement.${key}`))).join("، ")}>
            <Status tone="warn" className="whitespace-nowrap">{t("list.missing", { count: row.missing.length })}</Status>
          </span>
        ),
    },
    { key: "price", header: t("list.colPrice"), numeric: true, cell: (row) => <PriceRange min={row.priceMin} max={row.priceMax} /> },
    { key: "stock", header: t("list.colStock"), numeric: true, cell: (row) => <bdi className="nums">{f.number(row.available)}</bdi> },
    { key: "updated", header: t("list.colUpdated"), cell: (row) => <span className="whitespace-nowrap nums text-ink-2">{f.date(row.updatedAt, "short")}</span> },
  ];

  const statusChips: (AdminStatus | null)[] = [null, ...ADMIN_STATUSES];
  const allCount = ADMIN_STATUSES.filter((status) => status !== "archived").reduce((sum, status) => sum + result.statusCounts[status], 0);

  return (
    <>
      <header className="adm-page-head">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="adm-title">{t("title")}</h1>
          <div className="flex flex-wrap gap-2">
            {allowed.export ? (
              <>
                <Key as="a" href={`/admin/catalog/export?${new URLSearchParams({ level: "products", ...(filters.q ? { q: filters.q } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.platform ? { platform: filters.platform } : {}), ...(filters.category ? { category: filters.category } : {}) })}`} icon="download-simple" variant="quiet">
                  {t("list.exportProducts")}
                </Key>
                <Key as="a" href={`/admin/catalog/export?${new URLSearchParams({ level: "variants", ...(filters.q ? { q: filters.q } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.platform ? { platform: filters.platform } : {}), ...(filters.category ? { category: filters.category } : {}) })}`} icon="download-simple" variant="quiet">
                  {t("list.exportVariants")}
                </Key>
              </>
            ) : null}
            {allowed.create ? (
              <Key as={Link} to="/admin/catalog/new" variant="ink" icon="plus">
                {t("list.new")}
              </Key>
            ) : null}
          </div>
        </div>
        <p className="max-w-[70ch] type-body text-ink-2">{t("list.lead")}</p>
      </header>

      <section className="adm-section" aria-label={t("list.searchLabel")}>
        <nav aria-label={t("list.status")} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] md:flex-wrap md:overflow-visible [&::-webkit-scrollbar]:hidden">
          {statusChips.map((status) => {
            const active = filters.status === status;
            const count = status === null ? allCount : result.statusCounts[status];
            return (
              <Key key={status ?? "all"} as={Link} to={withParams(filters, { status })} size="sm" held={active} aria-current={active ? "page" : undefined} className="shrink-0">
                {status === null ? t("common.all") : t(`status.${status}`)} <bdi className="nums text-ink-2">{f.number(count)}</bdi>
              </Key>
            );
          })}
          <Key as={Link} to={withParams(filters, { incomplete: filters.incomplete ? null : "1" })} size="sm" held={filters.incomplete} icon="warning" className="shrink-0">
            {t("list.incomplete")} <bdi className="nums text-ink-2">{f.number(result.incompleteCount)}</bdi>
          </Key>
        </nav>

        <Form method="get" className="grid items-end gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,4fr)_auto]" preventScrollReset>
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
          {filters.incomplete ? <input type="hidden" name="incomplete" value="1" /> : null}
          <TextField label={t("list.searchLabel")} hint={t("list.searchHint")} name="q" type="search" defaultValue={filters.q} autoComplete="off" enterKeyHint="search" />
          <FilterFields active={[filters.platform, filters.category, filters.kind].filter(Boolean).length + (filters.sort !== "updated" ? 1 : 0)}>
            <Select
              label={t("list.platform")}
              name="platform"
              defaultValue={filters.platform ?? ""}
              options={[{ value: "", label: t("common.all") }, ...platforms.map((platform) => ({ value: platform.slug, label: platform.name })), { value: "none", label: t("list.multiPlatform") }]}
            />
            <Select label={t("list.category")} name="category" defaultValue={filters.category ?? ""} options={[{ value: "", label: t("common.all") }, ...categories.map((category) => ({ value: category.id, label: category.label }))]} />
            <Select label={t("list.kind")} name="kind" defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("common.all") }, ...PRODUCT_KIND_LIST.map((kind) => ({ value: kind, label: kindLabel(kind) }))]} />
            <Select
              label={t("list.sort")}
              name="sort"
              defaultValue={filters.sort}
              options={PRODUCT_SORTS.map((sort) => ({ value: sort, label: t(`list.sort${sort[0].toUpperCase()}${sort.slice(1)}`) }))}
            />
          </FilterFields>
          <div className="flex gap-2 self-center">
            <Key type="submit" variant="ink" icon="magnifying-glass">
              {t("common.apply")}
            </Key>
            {filtered ? (
              <Key as={Link} to="/admin/catalog">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
      </section>

      <section className="adm-section" aria-labelledby="catalog-results">
        <div className="adm-section__head">
          <h2 id="catalog-results" className="adm-h2">
            {t("list.shown", { count: result.total })}
          </h2>
          {!filters.status ? <p className="type-caption text-ink-2">{t("list.archivedHidden")}</p> : null}
        </div>
        {isFailure(bulkData) ? <FailureNotice result={bulkData} /> : null}

        {result.rows.length === 0 ? (
          <EmptyState
            icon={filtered ? "magnifying-glass" : "package"}
            title={filtered ? t("list.emptyTitle") : t("list.emptyAll")}
            text={filtered ? t("list.emptyText") : undefined}
            action={
              filtered ? (
                <Key as={Link} to="/admin/catalog">
                  {t("common.clear")}
                </Key>
              ) : allowed.create ? (
                <Key as={Link} to="/admin/catalog/new" icon="plus">
                  {t("list.new")}
                </Key>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("list.caption")}
                columns={columns}
                rows={result.rows}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.name}
                busy={loading}
                selected={allowed.bulkEdit || allowed.review || allowed.publish || allowed.archive ? chosen : undefined}
                onSelectedChange={allowed.bulkEdit || allowed.review || allowed.publish || allowed.archive ? setSelected : undefined}
                bulkActions={() => (
                  <>
                    {allowed.bulkEdit ? (
                      <Key size="sm" icon="pencil-simple" onClick={() => setDialog("fields")}>
                        {t("list.bulkSet")}
                      </Key>
                    ) : null}
                    {allowed.review ? (
                      <Key size="sm" onClick={() => setDialog("submit_review")}>
                        {t("action.submit_review")}
                      </Key>
                    ) : null}
                    {allowed.publish ? (
                      <Key size="sm" icon="eye-slash" onClick={() => setDialog("hide")}>
                        {t("action.hide")}
                      </Key>
                    ) : null}
                    {allowed.archive ? (
                      <Key size="sm" icon="trash" className="[--on:var(--red-ink)]" onClick={() => setDialog("archive")}>
                        {t("action.archive")}
                      </Key>
                    ) : null}
                  </>
                )}
                footer={<Pagination page={result.page} pageCount={result.pageCount} href={(page) => withParams(filters, { page: String(page) })} />}
              />
            </div>
            <ul role="list" className="grid gap-2 md:hidden">
              {result.rows.map((row) => (
                <li key={row.id}>
                  <Link to={`/admin/catalog/products/${row.id}`} className="adm-card flex items-center gap-3 no-underline">
                    <Thumb image={row.image} size={56} />
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="type-strong line-clamp-2 text-ink">
                        <bdi>{row.name}</bdi>
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <StatusBadge status={row.status} publishAt={row.publishAt} live={row.live} />
                        {row.complete ? <Status tone="ok" className="whitespace-nowrap">{t("list.ready")}</Status> : <Status tone="warn" className="whitespace-nowrap">{t("list.missing", { count: row.missing.length })}</Status>}
                      </span>
                      <span className="flex flex-wrap items-baseline justify-between gap-2 type-caption text-ink-2">
                        <span>
                          {kindLabel(row.kind)} · {t("list.variants", { count: row.activeVariants })}
                        </span>
                        <span className="type-label text-ink">
                          <PriceRange min={row.priceMin} max={row.priceMax} />
                        </span>
                      </span>
                    </span>
                    <Icon name="caret-right" size={18} className="text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
            <div className="md:hidden">
              <Pagination page={result.page} pageCount={result.pageCount} href={(page) => withParams(filters, { page: String(page) })} />
            </div>
            {allowed.bulkEdit || allowed.publish ? <p className="hidden type-caption text-ink-2 md:block">{t("list.selectHint")}</p> : null}
          </>
        )}
      </section>

      <BulkFieldsDialog open={dialog === "fields"} count={chosen.length} categories={categories} pending={bulk.state !== "idle"} error={isFailure(bulkData) && bulkData.intent === "bulk_update" ? (bulkData.message ?? t("errors.invalid")) : undefined} fieldError={fieldError} onClose={close} onSubmit={(fields) => submitBulk("bulk_update", fields)} />
      {(["submit_review", "hide", "archive"] as const).map((action) => (
        <ConfirmDialog
          key={action}
          open={dialog === action}
          onClose={close}
          tone={action === "archive" ? "destructive" : "neutral"}
          title={t(`list.bulkQ.${action}`, { products: t("list.shown", { count: chosen.length }) })}
          consequence={t(`list.bulkDo.${action}`)}
          confirmLabel={t(`action.${action}`)}
          cancelLabel={t("common.cancel")}
          impact={[
            { label: t("list.bulkTitle"), value: t("list.shown", { count: chosen.length }) },
            ...(action === "submit_review"
              ? []
              : [
                  { label: t("impact.storefront"), value: t("impact.bulkLive", { count: f.number(leaving(action)) }) },
                  { label: t("impact.stock"), value: t("impact.stockSame", { count: f.number(chosenUnits) }) },
                ]),
            { label: t("impact.prices"), value: t("impact.pricesSame") },
          ]}
          reason={action === "submit_review" ? undefined : { label: t("common.reason"), hint: t("common.reasonHint") }}
          pending={bulk.state !== "idle"}
          error={isFailure(bulkData) && bulkData.intent === "bulk_status" ? (bulkData.message ?? t("errors.invalid")) : undefined}
          onConfirm={({ reason }) => submitBulk("bulk_status", { action, reason })}
        />
      ))}

      <ModuleFunctions moduleId="02" />
    </>
  );
}

type BulkFieldsProps = {
  open: boolean;
  count: number;
  categories: { id: string; label: string }[];
  pending: boolean;
  error?: string;
  fieldError: (name: string) => string | undefined;
  onClose: () => void;
  onSubmit: (fields: Record<string, string>) => void;
};

function BulkFieldsDialog({ open, count, categories, pending, error, fieldError, onClose, onSubmit }: BulkFieldsProps) {
  const t = useCatalogT();
  const [nothing, setNothing] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("list.bulkSetTitle", { count })}
      description={t("list.bulkSetLead")}
      dismissible={!pending}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const fields: Record<string, string> = {};
        for (const [key, value] of data.entries()) if (typeof value === "string" && value.trim() !== "") fields[key] = value.trim();
        const setKeys = Object.keys(fields).filter((key) => key.startsWith("set."));
        if (setKeys.length === 0) {
          setNothing(true);
          return;
        }
        setNothing(false);
        onSubmit(fields);
      }}
      footer={
        <>
          <Key onClick={onClose} disabled={pending} className="flex-1 sm:flex-none">
            {t("common.cancel")}
          </Key>
          <Key type="submit" variant="ink" loading={pending} className="flex-1 sm:flex-none">
            {t("common.apply")}
          </Key>
        </>
      }
    >
      <div className="grid gap-3">
        <Select name="set.categoryId" label={t("editor.category")} options={[{ value: "", label: "—" }, ...categories.map((category) => ({ value: category.id, label: category.label }))]} defaultValue="" error={fieldError("set.categoryId")} />
        <TextField name="set.brand" label={t("editor.brand")} maxLength={80} error={fieldError("set.brand")} />
        <TextField name="set.warrantyMonths" label={t("editor.warranty")} hint={t("editor.warrantyHint")} inputMode="numeric" error={fieldError("set.warrantyMonths")} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField name="set.ageRating" label={t("editor.ageRating")} hint={t("editor.ageRatingHint")} maxLength={40} error={fieldError("set.ageRating")} />
          <TextField name="set.region" label={t("editor.region")} hint={t("editor.regionHint")} maxLength={40} error={fieldError("set.region")} />
          <Select name="set.licenseType" label={t("editor.licenseType")} options={[{ value: "", label: "—" }, ...LICENSE_TYPE_LIST.map((value) => ({ value, label: t(`editor.license.${value}`) }))]} defaultValue="" />
          <Select name="set.mediaFormat" label={t("editor.mediaFormat")} options={[{ value: "", label: "—" }, ...MEDIA_FORMAT_LIST.map((value) => ({ value, label: t(`editor.media.${value}`) }))]} defaultValue="" />
        </div>
        <TextField name="reason" label={t("common.reason")} hint={t("common.reasonHint")} required error={fieldError("reason")} />
        {nothing ? (
          <p role="alert" className="type-caption text-red-ink">
            {t("list.bulkNothing")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="type-caption text-red-ink">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
