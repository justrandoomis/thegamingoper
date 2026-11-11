import { Form, Link } from "react-router";

import type { Route } from "./+types/compat-rules";
import { useFormat } from "~/i18n/react";
import { listCompatibilityRules, parseRuleFilters } from "~/server/services/admin/catalog/compatibility.server";
import type { RuleView } from "~/server/services/admin/catalog/compatibility.server";
import { COMPAT_STATUS_LIST } from "~/server/services/admin/catalog/rules";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { catalogRequest } from "./catalog.server";
import { COMPAT_TONE, StatusBadge, useCatalogT } from "./components/ui";

/**
 * /admin/catalog/compatibility — every compatibility rule (02.10), filtered by device, generation or platform, by
 * status and by product; unverified and partial rules first (they are the ones to work on). Rules are edited on
 * their product's page; filters live in the URL.
 */
export async function loader({ context, url }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, "catalog.product.read");
  const filters = parseRuleFilters(url.searchParams);
  return { filters, result: await listCompatibilityRules(db, actor, filters, locale) };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("compat.allTitle"));

function href(filters: Route.ComponentProps["loaderData"]["filters"], change: Record<string, string | null>) {
  const params = new URLSearchParams();
  const values: Record<string, string | null> = { status: filters.status, target: filters.target, q: filters.q || null, page: null, ...change };
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/admin/catalog/compatibility?${query}` : "/admin/catalog/compatibility";
}

export default function CompatibilityRules({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const { filters, result } = loaderData;
  const total = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
  const columns: DataColumn<RuleView>[] = [
    {
      key: "product",
      header: t("compat.colProduct"),
      cell: (rule) => (
        <span className="grid gap-0.5 py-1.5">
          <Link to={`/admin/catalog/products/${rule.productId}/compatibility`} className="adm-link">
            {rule.productName}
          </Link>
          <span className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
            {rule.subjectType === "variant" ? <bdi dir="ltr">{rule.subjectLabel}</bdi> : null}
            <StatusBadge status={rule.productStatus} />
          </span>
        </span>
      ),
    },
    { key: "target", header: t("compat.colTarget"), cell: (rule) => <span className="type-caption">{rule.targetLabel}</span> },
    { key: "status", header: t("compat.colStatus"), cell: (rule) => <Status tone={COMPAT_TONE[rule.status]} className="whitespace-nowrap">{t(`compat.statuses.${rule.status}`)}</Status> },
    {
      key: "note",
      header: t("compat.colNote"),
      cell: (rule) => (
        <span className="grid max-w-[28rem] gap-0.5 py-1.5 type-caption">
          {rule.noteText ? <span>{rule.noteText}</span> : null}
          {rule.source ? (
            <bdi dir="auto" className="truncate text-ink-2">
              {rule.source}
            </bdi>
          ) : null}
          {!rule.noteText && !rule.source ? <span className="text-ink-2">—</span> : null}
        </span>
      ),
    },
    { key: "verified", header: t("compat.colVerified"), cell: (rule) => (rule.status === "verified" && rule.verifiedAt ? <span className="type-caption">{rule.verifiedBy ? t("compat.verifiedBy", { name: rule.verifiedBy, time: f.date(rule.verifiedAt) }) : t("compat.verifiedImported", { time: f.date(rule.verifiedAt) })}</span> : <span className="text-ink-2">—</span>) },
  ];
  return (
    <>
      <header className="adm-page-head">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="adm-title">{t("compat.allTitle")}</h1>
          <Key as={Link} to="/admin/catalog/compare" icon="scales">
            {t("compat.compareLink")}
          </Key>
        </div>
        <p className="max-w-[70ch] type-body text-ink-2">{t("compat.allLead")}</p>
      </header>

      <section className="adm-section">
        <nav aria-label={t("compat.filterStatus")} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] md:flex-wrap [&::-webkit-scrollbar]:hidden">
          <Key as={Link} to={href(filters, { status: null })} size="sm" held={!filters.status} className="shrink-0">
            {t("common.all")} <bdi className="nums text-ink-2">{f.number(total)}</bdi>
          </Key>
          {COMPAT_STATUS_LIST.map((status) => (
            <Key key={status} as={Link} to={href(filters, { status })} size="sm" held={filters.status === status} className="shrink-0">
              {t(`compat.statuses.${status}`)} <bdi className="nums text-ink-2">{f.number(result.counts[status])}</bdi>
            </Key>
          ))}
        </nav>
        <Form method="get" className="grid items-end gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto]" preventScrollReset>
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
          <Select name="target" label={t("compat.filterTarget")} defaultValue={filters.target ?? ""} options={[{ value: "", label: t("common.all") }, ...result.targets.map((target) => ({ value: `${target.type}:${target.id}`, label: target.label }))]} />
          <TextField name="q" type="search" label={t("compat.colProduct")} defaultValue={filters.q} />
          <div className="flex gap-2 self-center">
            <Key type="submit" variant="ink" icon="magnifying-glass">
              {t("common.apply")}
            </Key>
            {filters.target || filters.q || filters.status ? (
              <Key as={Link} to="/admin/catalog/compatibility">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
      </section>

      {result.rules.length === 0 ? (
        <EmptyState icon="question" title={t("compat.empty")} />
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable caption={t("compat.allTitle")} columns={columns} rows={result.rules} rowKey={(rule) => rule.id} footer={<Pagination page={result.page} pageCount={result.pageCount} href={(page) => href(filters, { page: String(page) })} />} />
          </div>
          <ul className="grid gap-2 md:hidden">
            {result.rules.map((rule) => (
              <li key={rule.id} className="adm-card gap-1">
                <Link to={`/admin/catalog/products/${rule.productId}/compatibility`} className="adm-link">
                  {rule.productName}
                </Link>
                <span className="type-caption text-ink-2">{rule.targetLabel}</span>
                <Status tone={COMPAT_TONE[rule.status]}>{t(`compat.statuses.${rule.status}`)}</Status>
                {rule.noteText ? <span className="type-caption">{rule.noteText}</span> : null}
              </li>
            ))}
          </ul>
          <div className="md:hidden">
            <Pagination page={result.page} pageCount={result.pageCount} href={(page) => href(filters, { page: String(page) })} />
          </div>
        </>
      )}
    </>
  );
}
