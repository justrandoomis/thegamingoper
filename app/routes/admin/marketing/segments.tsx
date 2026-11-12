import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/segments";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { exploreAudience } from "~/server/services/admin/marketing/audience.server";
import { SECTION_READ, type MarketingAccess } from "~/server/services/admin/marketing/shared.server";
import { audienceSearch, parseAudienceQuery, type RecipientSample } from "~/server/services/admin/marketing/types";
import { CustomerName } from "~/routes/admin/shell/CustomerName";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { MARKETING_LAYOUT_ID, marketingMeta } from "./meta";
import { openMarketing } from "./marketing.server";
import { ChoiceList, ExclusionRows, Kpis, Notice, Num, PhoneText, Section, useMarketingT, When } from "./ui";

/**
 * /admin/marketing/segments — 16.03: who bought which gaming platform when (accepted orders, Baghdad days), narrowed
 * by module 07's stored segments (reused, never recomputed here), and how many of them may be messaged now under the
 * rules of 16.01 (consent, open account, limits — counted on SMS). Everything is in the URL (GET form, works without
 * JavaScript); "start a campaign with this audience" carries it to a new campaign.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openMarketing(context, SECTION_READ.segments);
  const query = parseAudienceQuery(new URL(request.url).searchParams);
  try {
    return { result: await exploreAudience(db, actor, query, locale, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, "segments.title");

export default function SegmentsPage({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const f = useFormat();
  const navigation = useNavigation();
  const layout = useRouteLoaderData(MARKETING_LAYOUT_ID) as { access: MarketingAccess } | undefined;
  const { result } = loaderData;
  const { query, preview } = result;
  const busy = navigation.state === "loading";
  const excluded = Object.values(preview.excluded).reduce((sum, n) => sum + n, 0);
  const columns: DataColumn<RecipientSample>[] = [
    { key: "name", header: t("audience.col.name"), cell: (row) => <CustomerName profileId={row.profileId}>{row.name ?? t("audience.noName")}</CustomerName> },
    { key: "phone", header: t("audience.col.contact"), cell: (row) => <PhoneText phone={row.phone} /> },
    { key: "kind", header: t("audience.col.kind"), cell: (row) => (row.guest ? t("audience.guest") : t("audience.account")) },
    { key: "consent", header: t("audience.col.consent"), cell: (row) => (row.consentAt ? <When at={row.consentAt} style="date" /> : "—") },
  ];
  const maxBuyers = Math.max(1, ...result.byPlatform.map((row) => row.buyers));
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "16.03" })}</p>
        <h1 className="adm-title">{t("segments.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("segments.lead")}</p>
      </header>

      <Section id="mkt-explore" title={t("segments.filterTitle")}>
        <Form method="get" action="/admin/marketing/segments" className="mkt-form">
          <div className="mkt-grid mkt-grid--3">
            <ChoiceList name="platform" legend={t("campaign.f.platforms")} hint={t("campaign.f.platformsHint")} options={result.platforms.map((platform) => ({ value: platform.id, label: platform.name }))} selected={query.platformIds} />
            <div className="grid content-start gap-3">
              <TextField name="from" type="date" label={t("campaign.f.boughtFrom")} defaultValue={query.boughtFrom ?? ""} />
              <TextField name="to" type="date" label={t("campaign.f.boughtTo")} defaultValue={query.boughtTo ?? ""} />
            </div>
            <div className="grid content-start gap-3">
              <Select
                name="segment"
                label={t("campaign.f.segment")}
                hint={t("campaign.f.segmentHint")}
                defaultValue={query.segmentId ?? ""}
                options={[{ value: "", label: t("campaign.f.noSegment") }, ...result.segments.map((segment) => ({ value: segment.id, label: t("campaign.f.segmentOption", { name: segment.name, n: f.number(segment.members) }) }))]}
              />
              <input type="hidden" name="f" value="1" />
              <Checkbox name="guests" value="1" label={t("campaign.f.guests")} hint={t("campaign.f.guestsHint")} defaultChecked={query.guests} />
              <Checkbox name="demo" value="1" label={t("common.demoPeople")} defaultChecked={query.demo} />
            </div>
          </div>
          <div className="mkt-actions">
            <Key type="submit" icon="funnel" loading={busy}>
              {t("common.apply")}
            </Key>
            <Key as={Link} to="/admin/marketing/segments">
              {t("common.clear")}
            </Key>
            {layout?.access.campaignsManage ? (
              <Key as={Link} to={`/admin/marketing/campaigns/new${audienceSearch(query)}`} icon="paper-plane-tilt">
                {t("segments.startCampaign")}
              </Key>
            ) : null}
          </div>
        </Form>
      </Section>

      <Section id="mkt-explore-result" title={t("segments.resultTitle")} lead={t("segments.resultLead")}>
        <Kpis
          items={[
            { label: t("audience.candidates"), value: <Num value={preview.candidates} />, note: t("audience.candidatesNote") },
            { label: t("segments.reachable"), value: <Num value={preview.eligible} />, note: t("segments.reachableNote") },
            { label: t("audience.excluded"), value: <Num value={excluded} />, note: t("audience.excludedNote") },
          ]}
        />
        {preview.segment ? (
          <Notice icon="users">
            {t("audience.segmentNote", { name: preview.segment.name, n: preview.segment.members })} {preview.segment.computedAt ? <When at={preview.segment.computedAt} /> : t("audience.neverComputed")}
          </Notice>
        ) : null}
        {preview.truncated ? <Notice tone="warn" icon="warning">{t("audience.truncated")}</Notice> : null}
        <div className="mkt-layout">
          <div className="mkt-main">
            <div className="grid gap-2">
              <p className="adm-h3">{t("segments.byPlatform")}</p>
              {result.byPlatform.length === 0 ? (
                <p className="type-body text-ink-2">{t("segments.noBuyers")}</p>
              ) : (
                <ul className="mkt-rows">
                  {result.byPlatform.map((row) => (
                    <li key={row.platformId ?? "none"} className="mkt-row">
                      <span className="type-body">{row.name || t("segments.noPlatform")}</span>
                      <span className="flex items-center gap-2">
                        <span className="mkt-bar" aria-hidden="true">
                          <span style={{ inlineSize: `${Math.round((row.buyers / maxBuyers) * 100)}%` }} />
                        </span>
                        <Num value={row.buyers} className="type-strong" />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="type-caption text-ink-2">{t("segments.byPlatformNote")}</p>
            </div>
          </div>
          <div className="mkt-side">
            <p className="adm-h3">{t("audience.whyOut")}</p>
            <ExclusionRows excluded={preview.excluded} />
          </div>
        </div>
        {preview.sample.length === 0 ? (
          <EmptyState icon="users" title={t("segments.empty")} text={t("segments.emptyHint")} />
        ) : (
          <>
            <p className="type-label">{t("audience.sample", { count: preview.sample.length })}</p>
            <div className="hidden md:block">
              <DataTable caption={t("audience.sampleCaption")} columns={columns} rows={preview.sample} rowKey={(row) => row.key} maxHeight={null} busy={busy} />
            </div>
            <ul className="mkt-cards md:hidden" aria-label={t("audience.sampleCaption")}>
              {preview.sample.map((row) => (
                <li key={row.key} className="mkt-card">
                  <span className="mkt-card__top">
                    <span className="type-strong">{row.name ?? t("audience.noName")}</span>
                    <span className="type-caption text-ink-2">{row.guest ? t("audience.guest") : t("audience.account")}</span>
                  </span>
                  <PhoneText phone={row.phone} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </>
  );
}
