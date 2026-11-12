import { Form, Link, useLocation } from "react-router";

import type { Route } from "./+types/banners";
import { listBanners, parseBannerFilters, type BannerListRow } from "~/server/services/admin/cms/banners.server";
import { BANNER_PLACEMENTS, BANNER_VIEWS, CATEGORY_PLACEMENT_PREFIX, queryString } from "~/server/services/admin/cms/rules";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { cmsMeta } from "./meta";
import { openCms, orRespond } from "./cms.server";
import { Code, DemoTag, LinkChips, PageHead, Pager, ResponsiveList, StateBadge, When, useCmsT, usePlacementLabel } from "./ui";

/**
 * /admin/cms/banners — 17.01 / 17.02: every banner with where it stands, whether it runs now, its window (Iraq time)
 * and its link; views, placement and words in the URL (works without JavaScript); table from 768px, cards below.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCms(context, "cms.banner.manage");
  const filters = parseBannerFilters(new URL(request.url).searchParams);
  return { list: await orRespond(() => listBanners(db, actor, filters, locale, now)), filters };
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "banners.title");

export default function BannersPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { list, filters } = loaderData;
  const { search } = useLocation();
  const placementLabel = usePlacementLabel();
  const hrefFor = (view: string) => queryString({ view, placement: filters.placement, q: filters.q }, { view: "all" }) || "?";
  const empty = (
    <EmptyState
      icon="image"
      title={list.stored === 0 ? t("banners.empty") : t("common.noMatch")}
      text={list.stored === 0 ? t("banners.emptyText") : t("common.noMatchText")}
      action={
        list.stored === 0 ? (
          <Key as={Link} to="/admin/cms/banners/new" size="sm" icon="plus">
            {t("banners.new")}
          </Key>
        ) : undefined
      }
    />
  );
  return (
    <>
      <PageHead
        title={t("banners.title")}
        lead={t("banners.lead")}
        actions={
          <Key as={Link} to="/admin/cms/banners/new" size="sm" icon="plus">
            {t("banners.new")}
          </Key>
        }
      />
      <div className="grid gap-3">
        <LinkChips label={t("banners.views")} items={BANNER_VIEWS.map((view) => ({ value: view, label: t(`banners.view.${view}`), href: hrefFor(view), selected: filters.view === view, count: list.counts[view] }))} />
        <Form method="get" className="cms-filters" preventScrollReset>
          {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <Select
            name="placement"
            label={t("banners.placement")}
            defaultValue={filters.placement ?? ""}
            options={[
              { value: "", label: t("common.all") },
              ...BANNER_PLACEMENTS.map((value) => ({ value, label: t(`placement.${value}`) })),
              ...list.categories.map((category) => ({ value: `${CATEGORY_PLACEMENT_PREFIX}${category.id}`, label: t("placement.category", { name: category.name }) })),
            ]}
          />
          <TextField name="q" label={t("common.search")} defaultValue={filters.q} />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
        <ResponsiveList<BannerListRow>
          caption={t("banners.title")}
          rows={list.rows}
          rowKey={(row) => row.id}
          empty={empty}
          columns={[
            {
              key: "title",
              header: t("banners.bannerTitle"),
              cell: (row) => (
                <span className="flex flex-wrap items-center gap-1.5">
                  <Link to={`/admin/cms/banners/${row.id}`} className="adm-link">
                    {row.title || "—"}
                  </Link>
                  <DemoTag show={row.isDemo} />
                </span>
              ),
            },
            { key: "placement", header: t("banners.placement"), cell: (row) => placementLabel(row) },
            { key: "state", header: t("common.state"), cell: (row) => <StateBadge state={row.state} /> },
            {
              key: "window",
              header: t("common.window"),
              cell: (row) => (
                <span className="type-caption">
                  <When at={row.startsAt} /> → <When at={row.endsAt} />
                </span>
              ),
            },
            { key: "link", header: t("banners.link"), cell: (row) => (row.link ? <Code>{row.link}</Code> : "—") },
            { key: "updated", header: t("common.updated"), cell: (row) => <When at={row.updatedAt} /> },
          ]}
          card={(row) => (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link to={`/admin/cms/banners/${row.id}`} className="adm-link type-strong">
                  {row.title || "—"}
                </Link>
                <StateBadge state={row.state} />
              </div>
              <p className="type-caption text-ink-2">{placementLabel(row)}</p>
              <p className="type-caption">
                <When at={row.startsAt} /> → <When at={row.endsAt} />
              </p>
              {row.link ? <Code className="type-caption">{row.link}</Code> : null}
              <DemoTag show={row.isDemo} />
            </>
          )}
          footer={<Pager page={list.page} pageCount={list.pageCount} search={search} />}
        />
      </div>
    </>
  );
}
