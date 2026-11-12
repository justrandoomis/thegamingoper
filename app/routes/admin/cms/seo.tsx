import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/seo";
import { listSeo, parseSeoFilters, type SeoRow } from "~/server/services/admin/cms/seo.server";
import { SEO_ENTITY_TYPES, SEO_ISSUES, queryString } from "~/server/services/admin/cms/rules";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { openCms, orRespond } from "./cms.server";
import { Code, LinkChips, PageHead, Pager, ResponsiveList, useCmsT } from "./ui";

/**
 * /admin/cms/seo — 17.04: what search engines are given for every product, category and page — the title and
 * description the storefront renders (written, or taken from the name and the description) — and its issues: missing,
 * too long or short, a title another page uses too, kept out of search engines. Filters in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openCms(context, "cms.seo.manage");
  const filters = parseSeoFilters(new URL(request.url).searchParams);
  return { list: await orRespond(() => listSeo(db, actor, filters, locale)), filters };
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "seo.title");

function editHref(row: SeoRow): string {
  return row.type === "page" ? `/admin/cms/pages/${row.id}` : `/admin/cms/seo/${row.type}/${row.id}`;
}

function Issues({ row }: { row: SeoRow }) {
  const t = useCmsT();
  if (row.issues.length === 0) return <Status tone="ok">{t("seo.fine")}</Status>;
  return (
    <span className="flex flex-wrap gap-1">
      {row.issues.map((issue) => (
        <Status key={issue} tone={issue === "noindex" ? "info" : issue === "title_missing" || issue === "description_missing" ? "bad" : "warn"}>
          {t(`seo.issue.${issue}`)}
        </Status>
      ))}
    </span>
  );
}

export default function SeoPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { list, filters } = loaderData;
  const { search } = useLocation();
  const href = (issue: string | null) => queryString({ type: filters.type, issue, q: filters.q }) || "?";
  return (
    <>
      <PageHead title={t("seo.title")} lead={t("seo.lead")} />
      <div className="grid gap-3">
        <LinkChips
          label={t("seo.issues")}
          items={[{ value: "all", label: t("common.all"), href: href(null), selected: filters.issue === null, count: list.counts.all }, ...SEO_ISSUES.map((issue) => ({ value: issue, label: t(`seo.issue.${issue}`), href: href(issue), selected: filters.issue === issue, count: list.counts[issue] }))]}
        />
        <Form method="get" className="cms-filters" preventScrollReset>
          {filters.issue ? <input type="hidden" name="issue" value={filters.issue} /> : null}
          <Select name="type" label={t("seo.type")} defaultValue={filters.type ?? ""} options={[{ value: "", label: t("common.all") }, ...SEO_ENTITY_TYPES.map((type) => ({ value: type, label: t(`seo.types.${type}`) }))]} />
          <TextField name="q" label={t("common.search")} defaultValue={filters.q} />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList<SeoRow>
          caption={t("seo.title")}
          rows={list.rows}
          rowKey={(row) => `${row.type}:${row.id}`}
          empty={<EmptyState icon="magnifying-glass" title={t("common.noMatch")} text={t("common.noMatchText")} />}
          columns={[
            {
              key: "name",
              header: t("seo.entry"),
              cell: (row) => (
                <span className="grid gap-0.5">
                  <Link to={editHref(row)} className="adm-link">
                    {row.name}
                  </Link>
                  <span className="type-caption text-ink-2">
                    {t(`seo.types.${row.type}`)} · <Code>{row.path}</Code>
                  </span>
                </span>
              ),
            },
            {
              key: "title",
              header: t("seo.searchTitle"),
              cell: (row) => (
                <span className="grid gap-0.5">
                  <span>{row.title || "—"}</span>
                  <span className="type-caption text-ink-2">{row.titleWritten ? t("seo.written") : t("seo.fromName")}</span>
                </span>
              ),
            },
            {
              key: "description",
              header: t("seo.searchDescription"),
              cell: (row) => (
                <span className="grid gap-0.5">
                  <span className="line-clamp-2">{row.description ?? "—"}</span>
                  <span className="type-caption text-ink-2">{row.description ? (row.descriptionWritten ? t("seo.written") : t("seo.fromText")) : t("seo.none")}</span>
                </span>
              ),
            },
            { key: "issues", header: t("seo.issues"), cell: (row) => <Issues row={row} /> },
          ]}
          card={(row) => (
            <>
              <Link to={editHref(row)} className="adm-link type-strong">
                {row.name}
              </Link>
              <p className="type-caption text-ink-2">
                {t(`seo.types.${row.type}`)} · <Code>{row.path}</Code>
              </p>
              <p className="type-body">{row.title || "—"}</p>
              <Issues row={row} />
            </>
          )}
          footer={<Pager page={list.page} pageCount={list.pageCount} search={search} />}
        />
      </div>
    </>
  );
}
