import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/links";
import { throwAsResponse } from "~/server/errors";
import { attributionReport, createLink, listLinks, type LinkRow } from "~/server/services/admin/marketing/links.server";
import { SECTION_READ } from "~/server/services/admin/marketing/shared.server";
import { parseDayRange, parseLinkFilters } from "~/server/services/admin/marketing/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { marketingMeta } from "./meta";
import { fields, openMarketing, respond, runIntent } from "./marketing.server";
import { Boundary, Code, Failure, Kpis, Money, Notice, Num, Section, useFormKey, useIntent, useMarketingT, When } from "./ui";

/**
 * /admin/marketing/links — 16.04: build a tracked link to any storefront page (the CMS's path rules), the links with
 * the orders that carry them, and the attribution of sales to campaigns — counted only from orders that really carry
 * their source. The storefront records no source yet, so the page says so instead of showing a share it cannot know.
 * Search, campaign, page and the attribution's dates in the URL (GET forms, work without JavaScript).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now, origin } = await openMarketing(context, SECTION_READ.links);
  const params = new URL(request.url).searchParams;
  const filters = parseLinkFilters(params);
  const range = parseDayRange(params, now, 30);
  try {
    const [links, attribution] = await Promise.all([listLinks(db, actor, filters, origin), attributionReport(db, actor, range, now)]);
    return { links, attribution, filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx, origin } = await openMarketing(context, "marketing.utm.manage");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { create: ["marketing.utm.manage"] }, async (intent) => {
      const result = await createLink(db, session.actor, fields(form), ctx.now, origin);
      return { ok: true, intent, ...result };
    }),
  );
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, "links.title");

export default function LinksPage({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const navigation = useNavigation();
  const { links, attribution, filters } = loaderData;
  const busy = navigation.state === "loading";
  const columns: DataColumn<LinkRow>[] = [
    {
      key: "link",
      header: t("links.col.link"),
      cell: (row) => (
        <span className="grid min-w-0 gap-1 py-1">
          <Code value={row.targetPath} className="type-strong" />
          <span className="mkt-url" dir="ltr">
            {row.url}
          </span>
        </span>
      ),
    },
    {
      key: "utm",
      header: t("links.col.utm"),
      cell: (row) => (
        <span className="grid">
          <bdi dir="ltr">
            {row.source} / {row.medium}
          </bdi>
          {row.campaign ? <Code value={row.campaign} className="type-caption text-ink-2" /> : null}
        </span>
      ),
    },
    { key: "campaign", header: t("links.col.campaign"), cell: (row) => (row.campaignId ? <Link to={`/admin/marketing/campaigns/${row.campaignId}`} className="adm-link">{row.campaignName ?? row.campaignId}</Link> : <span className="text-ink-2">—</span>) },
    { key: "orders", header: t("links.col.orders"), numeric: true, cell: (row) => <Num value={row.orders} /> },
    { key: "clicks", header: t("links.col.clicks"), cell: () => <span className="text-ink-2">{t("links.notMeasured")}</span> },
    { key: "created", header: t("links.col.created"), cell: (row) => <span className="whitespace-nowrap"><When at={row.createdAt} style="date" /></span> },
  ];
  const share = attribution.orders.total > 0 ? Math.round((attribution.orders.attributed / attribution.orders.total) * 100) : null;
  // attributed sales are the campaign-attributed orders' money (docs/metrics.md §8); a source matching no campaign is not
  const attributedPaid = attribution.byCampaign.reduce((sum, row) => sum + row.paidIqd, 0);
  /** A page of the links, keeping the search, the campaign and the attribution's dates. */
  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (n > 1) params.set("page", String(n));
    if (filters.q) params.set("q", filters.q);
    if (filters.campaign) params.set("campaign", filters.campaign);
    params.set("from", attribution.range.from);
    params.set("to", attribution.range.to);
    if (attribution.range.demo) params.set("demo", "1");
    return `?${params.toString()}`;
  };
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "16.04" })}</p>
        <h1 className="adm-title">{t("links.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("links.lead")}</p>
      </header>

      <Boundary>{t("links.boundary")}</Boundary>

      {links.canManage ? <LinkBuilder campaigns={links.campaigns} /> : null}

      <Section id="mkt-links-list" title={t("links.listTitle")}>
        <Form method="get" action="/admin/marketing/links" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField name="q" label={t("links.search")} hint={t("links.searchHint")} defaultValue={filters.q} type="search" maxLength={60} />
          <Select name="campaign" label={t("links.col.campaign")} defaultValue={filters.campaign ?? ""} options={[{ value: "", label: t("common.all") }, ...links.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))]} />
          <div className="flex flex-wrap items-end gap-2">
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            <Key as={Link} to="/admin/marketing/links">
              {t("common.clear")}
            </Key>
          </div>
        </Form>
        <p className="type-caption text-ink-2" aria-live="polite">
          {t("common.count", { count: links.total })}
        </p>
        {links.rows.length === 0 ? (
          <EmptyState icon="link" title={filters.q || filters.campaign ? t("links.emptyFiltered") : t("links.empty")} text={links.canManage ? t("links.emptyHint") : t("links.emptyHintRead")} />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("links.listTitle")} columns={columns} rows={links.rows} rowKey={(row) => row.id} busy={busy} maxHeight={null} footer={<Pagination page={links.page} pageCount={links.pageCount} href={pageHref} />} />
            </div>
            <div className="md:hidden">
              <ul className="mkt-cards" aria-label={t("links.listTitle")}>
                {links.rows.map((row) => (
                  <li key={row.id} className="mkt-card">
                    <span className="mkt-card__top">
                      <Code value={row.targetPath} className="type-strong" />
                      <bdi dir="ltr" className="type-caption">
                        {row.source}/{row.medium}
                      </bdi>
                    </span>
                    <span className="mkt-url" dir="ltr">
                      {row.url}
                    </span>
                    {row.campaignId ? (
                      <Link to={`/admin/marketing/campaigns/${row.campaignId}`} className="adm-link type-caption">
                        {row.campaignName ?? row.campaignId}
                      </Link>
                    ) : null}
                    <span className="type-caption text-ink-2">{t("links.ordersLine", { count: row.orders })}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={links.page} pageCount={links.pageCount} href={pageHref} />
              </div>
            </div>
          </>
        )}
      </Section>

      <Section id="mkt-attribution" title={t("attribution.title")} lead={t("attribution.lead")}>
        <Form method="get" action="/admin/marketing/links#mkt-attribution" className="flex flex-wrap items-end gap-3">
          <TextField name="from" type="date" label={t("common.from")} defaultValue={attribution.range.from} />
          <TextField name="to" type="date" label={t("common.to")} defaultValue={attribution.range.to} />
          <Checkbox name="demo" value="1" label={t("common.includeDemo")} defaultChecked={attribution.range.demo} />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
        <Kpis
          items={[
            { label: t("attribution.orders"), value: <Num value={attribution.orders.total} />, note: t("attribution.ordersNote") },
            { label: t("attribution.attributed"), value: <Num value={attribution.orders.attributed} />, note: share === null ? t("attribution.noOrders") : t("attribution.share", { n: share }) },
            { label: t("attribution.paid"), value: attribution.orders.attributed > 0 ? <Money iqd={attributedPaid} /> : <span className="text-ink-2">{t("common.notAvailable")}</span>, note: t("attribution.paidNote") },
          ]}
        />
        {!attribution.captured ? (
          <Notice icon="plugs-connected" tone="warn">
            {t("attribution.notCaptured")}
          </Notice>
        ) : null}
        {attribution.byCampaign.length === 0 ? (
          <EmptyState icon="chart-bar" title={t("attribution.emptyCampaigns")} text={attribution.captured ? t("attribution.emptyCampaignsHint") : t("attribution.emptyNotCaptured")} />
        ) : (
          <ul className="mkt-rows">
            {attribution.byCampaign.map((row) => (
              <li key={row.campaignId} className="mkt-row">
                <Link to={`/admin/marketing/campaigns/${row.campaignId}`} className="adm-link">
                  {row.name}
                </Link>
                <span className="flex flex-wrap items-baseline gap-3">
                  <span>{t("attribution.ordersLine", { count: row.orders })}</span>
                  <Money iqd={row.paidIqd} className="type-strong" />
                </span>
              </li>
            ))}
          </ul>
        )}
        {attribution.bySource.length > 0 ? (
          <Disclosure summary={t("attribution.bySource")} variant="panel">
            <ul className="mkt-rows">
              {attribution.bySource.map((row) => (
                <li key={`${row.source}|${row.medium ?? ""}`} className="mkt-row">
                  <bdi dir="ltr">
                    {row.source}
                    {row.medium ? ` / ${row.medium}` : ""}
                  </bdi>
                  <span className="flex flex-wrap items-baseline gap-3">
                    <span>{t("attribution.ordersLine", { count: row.orders })}</span>
                    <Money iqd={row.paidIqd} />
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </Section>
    </>
  );
}

function LinkBuilder({ campaigns }: { campaigns: { id: string; name: string; utm: string | null }[] }) {
  const t = useMarketingT();
  const key = useFormKey();
  const [formKey, setFormKey] = useState(key);
  const [made, setMade] = useState<string | null>(null);
  const { fetcher, pending, message, fields: errors } = useIntent("create", "done.linkCreated", (result) => {
    setMade(typeof result.url === "string" ? result.url : null);
    setFormKey(`${key}${Date.now()}`);
  });
  return (
    <Section id="mkt-link-builder" title={t("links.builderTitle")} lead={t("links.builderLead")}>
      <fetcher.Form key={formKey} method="post" className="mkt-form" noValidate>
        <input type="hidden" name="intent" value="create" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        <div className="mkt-grid mkt-grid--3">
          <TextField name="targetPath" label={t("links.f.path")} hint={t("links.f.pathHint")} defaultValue="/" required ltr maxLength={300} error={errors.targetPath} />
          <TextField name="source" label={t("links.f.source")} hint={t("links.f.sourceHint")} required ltr maxLength={60} error={errors.source} />
          <TextField name="medium" label={t("links.f.medium")} hint={t("links.f.mediumHint")} required ltr maxLength={60} error={errors.medium} />
          <Select name="campaignId" label={t("links.f.campaign")} hint={t("links.f.campaignHint")} options={[{ value: "", label: t("links.f.noCampaign") }, ...campaigns.map((campaign) => ({ value: campaign.id, label: campaign.utm ? `${campaign.name} (${campaign.utm})` : campaign.name }))]} error={errors.campaignId} />
          <TextField name="campaign" label={t("links.f.campaignValue")} hint={t("links.f.campaignValueHint")} ltr maxLength={60} error={errors.campaign} />
          <TextField name="content" label={t("links.f.content")} hint={t("links.f.contentHint")} ltr maxLength={60} error={errors.content} />
          <TextField name="term" label={t("links.f.term")} hint={t("links.f.termHint")} ltr maxLength={60} error={errors.term} />
        </div>
        <Failure message={message} />
        <div className="mkt-actions">
          <Key type="submit" icon="link" loading={pending}>
            {t("links.create")}
          </Key>
        </div>
      </fetcher.Form>
      {made ? (
        <div className="grid gap-1" aria-live="polite">
          <p className="type-label">{t("links.made")}</p>
          <span className="mkt-url" dir="ltr">
            {made}
          </span>
        </div>
      ) : null}
    </Section>
  );
}
