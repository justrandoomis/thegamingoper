import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/campaigns";
import { throwAsResponse } from "~/server/errors";
import { listCampaigns } from "~/server/services/admin/marketing/campaigns.server";
import { SECTION_READ, type MarketingAccess } from "~/server/services/admin/marketing/shared.server";
import { CAMPAIGN_CHANNEL_LIST, CAMPAIGN_STATE_TONE, CAMPAIGN_VIEWS, campaignSearch, isMessageChannel, parseCampaignFilters, type CampaignRow } from "~/server/services/admin/marketing/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { MARKETING_LAYOUT_ID, marketingMeta } from "./meta";
import { openMarketing } from "./marketing.server";
import { Code, DemoTag, Money, Notice, Num, Section, ToneStatus, useMarketingT, When } from "./ui";

/**
 * /admin/marketing/campaigns — 16.01: every campaign with its state (draft, waiting for a second person, approved,
 * due, released — held in the outbox —, tracked, closed), its audience channel, what was held for it, budget and
 * spend. Saved views, search, channel and demo in the URL (GET form, works without JavaScript); a table from 768px,
 * cards below.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openMarketing(context, SECTION_READ.campaigns);
  const filters = parseCampaignFilters(new URL(request.url).searchParams);
  try {
    return { page: await listCampaigns(db, actor, filters, now), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, "campaigns.title");

export default function CampaignsPage({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const navigation = useNavigation();
  const layout = useRouteLoaderData(MARKETING_LAYOUT_ID) as { access: MarketingAccess } | undefined;
  const manage = layout?.access.campaignsManage ?? false;
  const send = layout?.access.campaignsSend ?? false;
  const { page, filters } = loaderData;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/marketing/campaigns";
  const filtered = Boolean(filters.q) || filters.view !== "all" || filters.channel !== null;
  const views = CAMPAIGN_VIEWS.filter((view) => view !== "decide" || send);

  const columns: DataColumn<CampaignRow>[] = [
    {
      key: "name",
      header: t("campaigns.col.name"),
      cell: (row) => (
        <span className="grid py-1">
          <Link to={`/admin/marketing/campaigns/${row.id}`} className="adm-link">
            {row.name}
          </Link>
          {row.utmCampaign ? <Code value={row.utmCampaign} className="type-caption text-ink-2" /> : null}
        </span>
      ),
    },
    {
      key: "state",
      header: t("campaigns.col.state"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <ToneStatus tone={CAMPAIGN_STATE_TONE[row.state]}>{t(`state.${row.state}`)}</ToneStatus>
          <DemoTag show={row.isDemo} />
        </span>
      ),
    },
    { key: "channel", header: t("campaigns.col.channel"), cell: (row) => t(`channel.${row.channel}`) },
    { key: "held", header: t("campaigns.col.held"), numeric: true, cell: (row) => (isMessageChannel(row.channel) ? <Num value={row.held} /> : <span className="text-ink-2">—</span>) },
    {
      key: "when",
      header: t("campaigns.col.when"),
      cell: (row) =>
        !isMessageChannel(row.channel) ? (
          <span className="text-ink-2">—</span>
        ) : row.scheduledAt ? (
          <span className="whitespace-nowrap">
            <When at={row.scheduledAt} />
          </span>
        ) : (
          <span className="text-ink-2">{t("campaigns.asSoonAsApproved")}</span>
        ),
    },
    { key: "budget", header: t("campaigns.col.budget"), numeric: true, cell: (row) => <Money iqd={row.budgetIqd} none={t("common.notSet")} /> },
    { key: "spend", header: t("campaigns.col.spend"), numeric: true, cell: (row) => (row.spendIqd !== 0 ? <Money iqd={row.spendIqd} /> : <span className="text-ink-2">{t("common.noneEntered")}</span>) },
    { key: "updated", header: t("campaigns.col.updated"), cell: (row) => <span className="whitespace-nowrap"><When at={row.updatedAt} style="date" /></span> },
  ];

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "16.01" })}</p>
        <h1 className="adm-title">{t("campaigns.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("campaigns.lead")}</p>
        {manage ? (
          <div className="mkt-actions">
            <Key as={Link} to="/admin/marketing/campaigns/new" icon="plus">
              {t("campaigns.new")}
            </Key>
          </div>
        ) : null}
      </header>

      <Section id="mkt-campaigns" title={t("campaigns.listTitle")}>
        <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
          {views.map((view) => {
            const active = filters.view === view;
            return (
              <Key key={view} as={Link} to={`/admin/marketing/campaigns${campaignSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`campaigns.views.${view}`)} <bdi className="nums text-ink-2">{page.counts[view] ?? 0}</bdi>
              </Key>
            );
          })}
        </nav>

        <Disclosure summary={t("common.filters")} variant="panel" defaultOpen={Boolean(filters.q) || filters.channel !== null || filters.demo}>
          <Form method="get" action="/admin/marketing/campaigns" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
            <TextField name="q" label={t("campaigns.search")} hint={t("campaigns.searchHint")} defaultValue={filters.q} type="search" maxLength={80} />
            <Select name="channel" label={t("campaigns.col.channel")} defaultValue={filters.channel ?? ""} options={[{ value: "", label: t("common.all") }, ...CAMPAIGN_CHANNEL_LIST.map((channel) => ({ value: channel, label: t(`channel.${channel}`) }))]} />
            <div className="flex items-end">
              <Checkbox name="demo" value="1" label={t("common.includeDemo")} defaultChecked={filters.demo} />
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Key type="submit" icon="funnel">
                {t("common.apply")}
              </Key>
              <Key as={Link} to="/admin/marketing/campaigns">
                {t("common.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>

        <p className="type-caption text-ink-2" aria-live="polite">
          {t("common.count", { count: page.total })}
        </p>

        {page.rows.length === 0 ? (
          <EmptyState
            title={filtered ? t("campaigns.emptyFiltered") : t("campaigns.empty")}
            text={filtered ? t("common.emptyFilteredHint") : manage ? t("campaigns.emptyHint") : t("campaigns.emptyHintRead")}
            icon="paper-plane-tilt"
            action={
              filtered ? (
                <Key as={Link} to="/admin/marketing/campaigns">
                  {t("common.clear")}
                </Key>
              ) : manage ? (
                <Key as={Link} to="/admin/marketing/campaigns/new" icon="plus">
                  {t("campaigns.new")}
                </Key>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("campaigns.listTitle")}
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.name}
                busy={busy}
                maxHeight={null}
                footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => campaignSearch({ ...filters, page: n }) || "?"} />}
              />
            </div>
            <div className="md:hidden">
              <ul className="mkt-cards" aria-label={t("campaigns.listTitle")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <Link to={`/admin/marketing/campaigns/${row.id}`} className="mkt-card">
                      <span className="mkt-card__top">
                        <span className="type-strong">{row.name}</span>
                        <ToneStatus tone={CAMPAIGN_STATE_TONE[row.state]}>{t(`state.${row.state}`)}</ToneStatus>
                      </span>
                      <span className="mkt-card__top type-body text-ink-2">
                        <span>{t(`channel.${row.channel}`)}</span>
                        {isMessageChannel(row.channel) ? <span>{t("campaigns.heldLine", { count: row.held ?? 0 })}</span> : null}
                      </span>
                      {isMessageChannel(row.channel) ? <span className="type-caption text-ink-2">{row.scheduledAt ? <When at={row.scheduledAt} /> : t("campaigns.asSoonAsApproved")}</span> : null}
                      <DemoTag show={row.isDemo} />
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => campaignSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
        <Notice icon="seal-check">{t("campaigns.rule")}</Notice>
      </Section>
    </>
  );
}
