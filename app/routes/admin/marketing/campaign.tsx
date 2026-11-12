import { useState } from "react";
import { Link, useNavigate, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/campaign";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { notFound, throwAsResponse } from "~/server/errors";
import { campaignFormOptions, cancelCampaign, closeCampaign, decideCampaign, getCampaign, listRecipients, recordSpend, releaseCampaign, saveCampaign, submitCampaign, withdrawCampaign } from "~/server/services/admin/marketing/campaigns.server";
import { createLink } from "~/server/services/admin/marketing/links.server";
import { SECTION_READ, type MarketingAccess } from "~/server/services/admin/marketing/shared.server";
import {
  BODY_MAX,
  CAMPAIGN_CHANNEL_LIST,
  CAMPAIGN_STATE_TONE,
  CAMPAIGN_VARIABLES,
  MESSAGE_CHANNELS,
  MESSAGE_LOCALES,
  SEND_LIMITS,
  SUBJECT_MAX,
  TRACKING_CHANNELS,
  baghdadMonth,
  consentSourceKey,
  isMessageChannel,
  latinDigits,
  normalizeMonth,
  parseAudienceQuery,
  parseWhole,
  toLocalInput,
  type AudiencePreview,
  type AudienceQuery,
  type CampaignDetail,
  type MessageChannel,
  type RecipientRow,
  type RecipientSample,
} from "~/server/services/admin/marketing/types";
import { CustomerName } from "~/routes/admin/shell/CustomerName";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { MARKETING_LAYOUT_ID, marketingMeta } from "./meta";
import { fields, openMarketing, respond, runIntent, text } from "./marketing.server";
import { Boundary, ChoiceList, Code, ConfirmAction, ConfirmSubmit, DemoTag, ExclusionRows, Facts, Failure, History, Kpis, Money, Notice, Num, PhoneText, Section, Tag, ToneStatus, useFormKey, useIntent, useMarketingT, When } from "./ui";

/**
 * /admin/marketing/campaigns/:campaignId — 16.01 one campaign (":campaignId" = "new" opens the empty form): the
 * draft (audience from module 07's segment and/or what people bought, the text in each language with its safe
 * variables, schedule, budget), who it would reach NOW and why others are left out, the request for a second person
 * (approve / reject — never the requester nor anyone who wrote it; withdraw for the requester), the release when its
 * time has come (messages HELD in the outbox: no provider), the recipients, the campaign's links (16.04), the spend
 * entered per month (16.07) and the history.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const creating = params.campaignId === "new";
  const { db, actor, locale, now, origin } = await openMarketing(context, creating ? "marketing.campaign.manage" : SECTION_READ.campaigns);
  const url = new URL(request.url);
  try {
    if (creating) return { page: null, recipients: null, options: await campaignFormOptions(db, actor, locale), prefill: parseAudienceQuery(url.searchParams), canLink: false };
    const page = await getCampaign(db, actor, params.campaignId, locale, now, origin);
    const hasRecipients = page.campaign.recipients.held + page.campaign.recipients.pending + page.campaign.recipients.sent + page.campaign.recipients.failed + page.campaign.recipients.skipped > 0;
    const recipients = hasRecipients ? await listRecipients(db, actor, params.campaignId, Number(latinDigits(url.searchParams.get("rpage") ?? "1")) || 1) : null;
    return { page, recipients, options: page.options, prefill: null, canLink: can(actor, "marketing.utm.manage") };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, session, ctx, origin } = await openMarketing(context, SECTION_READ.campaigns);
  const form = await request.formData();
  const campaignId = params.campaignId === "new" ? undefined : params.campaignId;
  return respond(
    await runIntent(
      ctx,
      session,
      form,
      {
        save: ["marketing.campaign.manage"],
        submit: ["marketing.campaign.manage"],
        withdraw: ["marketing.campaign.manage"],
        decide: ["marketing.campaign.send"],
        release: ["marketing.campaign.send"],
        cancel: ["marketing.campaign.manage"],
        close: ["marketing.campaign.manage"],
        spend: ["marketing.campaign.manage"],
        link: ["marketing.utm.manage"],
      },
      async (intent) => {
        const { actor } = session;
        // every intent but "save" works on this page's campaign only (the empty form has none)
        if (intent !== "save" && !campaignId) throw notFound("campaign");
        const id = campaignId as string;
        switch (intent) {
          case "save": {
            const result = await saveCampaign(db, actor, { ...fields(form, ["platformIds"]), campaignId, guests: form.get("guests") === "on" || form.get("guests") === "1" }, ctx.now, { demo: ctx.storeMode === "demo" });
            return { ok: true, intent, ...result };
          }
          case "submit": {
            const result = await submitCampaign(db, actor, { campaignId: id, expectedUpdatedAt: text(form, "expectedUpdatedAt"), note: text(form, "note") }, ctx.now);
            return { ok: true, intent, ...result };
          }
          case "withdraw":
            return { ok: true, intent, ...(await withdrawCampaign(db, actor, { campaignId: id, approvalId: text(form, "approvalId") }, ctx.now)) };
          case "decide": {
            const result = await decideCampaign(db, actor, { campaignId: id, approvalId: text(form, "approvalId"), decision: text(form, "decision"), fingerprint: text(form, "fingerprint"), note: text(form, "note") }, ctx.now);
            return { ok: true, intent, ...result };
          }
          case "release": {
            const result = await releaseCampaign(db, actor, { campaignId: id }, ctx.now, origin);
            return { ok: true, intent, ...result };
          }
          case "cancel":
            return { ok: true, intent, ...(await cancelCampaign(db, actor, { campaignId: id, reason: text(form, "reason") }, ctx.now)) };
          case "close":
            return { ok: true, intent, ...(await closeCampaign(db, actor, { campaignId: id, reason: text(form, "reason") }, ctx.now)) };
          case "spend": {
            const result = await recordSpend(db, actor, { campaignId: id, period: text(form, "period"), amountIqd: text(form, "amountIqd"), reference: text(form, "reference"), note: text(form, "note"), idempotencyKey: text(form, "idempotencyKey"), expectedUpdatedAt: text(form, "expectedUpdatedAt") }, ctx.now);
            return { ok: true, intent, ...result };
          }
          case "link": {
            const result = await createLink(db, actor, { ...fields(form), campaignId: id }, ctx.now, origin);
            return { ok: true, intent, ...result };
          }
        }
      },
    ),
  );
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, args.params.campaignId === "new" ? "campaign.newTitle" : null, undefined, args.loaderData?.page?.campaign.name ?? null);

export default function CampaignPage({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const { page, recipients, options, prefill, canLink } = loaderData;
  const layout = useRouteLoaderData(MARKETING_LAYOUT_ID) as { access: MarketingAccess } | undefined;

  if (!page) {
    return (
      <>
        <header className="adm-page-head">
          <p className="adm-eyebrow">
            <Link to="/admin/marketing/campaigns" className="adm-link">
              {t("campaigns.title")}
            </Link>
          </p>
          <h1 className="adm-title">{t("campaign.newTitle")}</h1>
          <p className="max-w-[75ch] type-body text-ink-2">{t("campaign.newLead")}</p>
        </header>
        <Boundary>{t("campaign.boundary", { max: SEND_LIMITS.maxPerWindow, days: SEND_LIMITS.windowDays })}</Boundary>
        <CampaignForm campaign={null} options={options} prefill={prefill} />
      </>
    );
  }

  const { campaign, preview, rendered } = page;
  const message = isMessageChannel(campaign.channel);
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/marketing/campaigns" className="adm-link">
            {t("campaigns.title")}
          </Link>
        </p>
        <h1 className="adm-title">{campaign.name}</h1>
        <div className="mkt-actions">
          <ToneStatus tone={CAMPAIGN_STATE_TONE[campaign.state]}>{t(`state.${campaign.state}`)}</ToneStatus>
          <Tag icon={message ? "chat-circle" : "chart-line"}>{t(`channel.${campaign.channel}`)}</Tag>
          <DemoTag show={campaign.isDemo} />
        </div>
      </header>

      {message ? <Boundary>{t("campaign.boundary", { max: SEND_LIMITS.maxPerWindow, days: SEND_LIMITS.windowDays })}</Boundary> : null}

      <div className="mkt-layout">
        <div className="mkt-main">
          {campaign.can.edit ? (
            <Section id="mkt-edit" title={t("campaign.editTitle")}>
              <CampaignForm campaign={campaign} options={options} prefill={null} />
            </Section>
          ) : (
            <Section id="mkt-facts" title={t("campaign.factsTitle")}>
              <CampaignFacts campaign={campaign} options={options} />
            </Section>
          )}

          {message && preview ? <AudienceSection preview={preview} /> : null}

          {message ? (
            <Section id="mkt-message" title={t("campaign.messageTitle")} lead={t("campaign.messageLead")}>
              {Object.keys(rendered).length === 0 ? (
                <p className="type-body text-ink-2">{t("campaign.noText")}</p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {MESSAGE_LOCALES.filter((lang) => rendered[lang]).map((lang) => (
                    <div key={lang} className="grid gap-1">
                      <p className="type-caption text-ink-2">{t(`lang.${lang}`)}</p>
                      <div className="mkt-message" lang={lang} dir={lang === "en" ? "ltr" : "rtl"}>
                        {rendered[lang]?.subject ? <strong>{rendered[lang]?.subject}</strong> : null}
                        <span>{rendered[lang]?.body}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Notice icon="info">{t("campaign.variablesNote")}</Notice>
            </Section>
          ) : null}

          {campaign.content.release ? <ReleaseSection campaign={campaign} /> : null}
          {recipients ? <RecipientsSection recipients={recipients} /> : null}

          <LinksSection campaign={campaign} canLink={canLink} />
          <SpendSection campaign={campaign} manage={layout?.access.spend ?? false} />

          <Section id="mkt-history" title={t("common.history")}>
            <History rows={campaign.history} />
          </Section>
        </div>
        <aside className="mkt-side" aria-label={t("campaign.sideLabel")}>
          <DecisionPanel campaign={campaign} preview={preview} />
          <ActionsPanel campaign={campaign} preview={preview} />
        </aside>
      </div>
    </>
  );
}

// ───────────────────────────────────────────────────────────────── the form

function CampaignForm({ campaign, options, prefill }: { campaign: CampaignDetail | null; options: { segments: { id: string; name: string; members: number; computedAt: number | null }[]; platforms: { id: string; name: string }[] }; prefill: AudienceQuery | null }) {
  const t = useMarketingT();
  const f = useFormat();
  const navigate = useNavigate();
  const key = useFormKey();
  const [channel, setChannel] = useState<string>(campaign?.channel ?? "sms");
  const message = isMessageChannel(channel);
  const { fetcher, pending, message: failureText, fields: errors } = useIntent(
    "save",
    (result) => (result.replayed ? "done.replayed" : campaign ? "done.saved" : "done.created"),
    (result) => {
      if (!campaign && typeof result.campaignId === "string") navigate(`/admin/marketing/campaigns/${result.campaignId}`);
    },
  );
  const content = campaign?.content;
  const audience = content?.audience ?? (prefill ? { segmentId: prefill.segmentId, platformIds: prefill.platformIds, boughtFrom: prefill.boughtFrom, boughtTo: prefill.boughtTo, guests: prefill.guests } : null);
  const channelOptions = (campaign ? (isMessageChannel(campaign.channel) ? MESSAGE_CHANNELS : TRACKING_CHANNELS) : CAMPAIGN_CHANNEL_LIST).map((value) => ({ value, label: t(`channel.${value}`) }));
  return (
    <fetcher.Form method="post" className="mkt-form" noValidate>
      <input type="hidden" name="intent" value="save" />
      {campaign ? <input type="hidden" name="expectedUpdatedAt" value={campaign.updatedAt} /> : <input type="hidden" name="idempotencyKey" value={key} />}
      <div className="mkt-grid mkt-grid--3">
        <TextField name="name" label={t("campaign.f.name")} hint={t("campaign.f.nameHint")} defaultValue={campaign?.name ?? ""} required maxLength={120} error={errors.name} className="mkt-span" />
        <Select name="channel" label={t("campaign.f.channel")} hint={campaign ? t("campaign.f.channelLocked") : t("campaign.f.channelHint")} value={channel} onChange={(event) => setChannel(event.currentTarget.value)} options={channelOptions} error={errors.channel} />
        {message ? (
          <TextField name="scheduledAt" type="datetime-local" label={t("campaign.f.scheduledAt")} hint={t("campaign.f.scheduledAtHint")} defaultValue={toLocalInput(campaign?.scheduledAt)} error={errors.scheduledAt} />
        ) : (
          <>
            <TextField name="startsOn" type="date" label={t("campaign.f.startsOn")} defaultValue={content?.startsOn ?? ""} error={errors.startsOn} />
            <TextField name="endsOn" type="date" label={t("campaign.f.endsOn")} defaultValue={content?.endsOn ?? ""} error={errors.endsOn} />
          </>
        )}
        <TextField name="budgetIqd" label={t("campaign.f.budget")} hint={t("campaign.f.budgetHint")} defaultValue={campaign?.budgetIqd ?? ""} inputMode="numeric" error={errors.budgetIqd} />
        <TextField name="utmCampaign" label={t("campaign.f.utm")} hint={t("campaign.f.utmHint")} defaultValue={campaign?.utmCampaign ?? ""} maxLength={60} ltr error={errors.utmCampaign} />
      </div>

      {message ? (
        <fieldset className="mkt-form">
          <legend className="adm-h3">{t("campaign.f.audience")}</legend>
          <p className="type-caption text-ink-2">{t("campaign.f.audienceHint")}</p>
          <div className="mkt-grid mkt-grid--3">
            <Select
              name="segmentId"
              label={t("campaign.f.segment")}
              hint={t("campaign.f.segmentHint")}
              defaultValue={audience?.segmentId ?? ""}
              options={[{ value: "", label: t("campaign.f.noSegment") }, ...options.segments.map((segment) => ({ value: segment.id, label: t("campaign.f.segmentOption", { name: segment.name, n: f.number(segment.members) }) }))]}
              error={errors.segmentId}
            />
            <ChoiceList name="platformIds" legend={t("campaign.f.platforms")} hint={t("campaign.f.platformsHint")} options={options.platforms.map((platform) => ({ value: platform.id, label: platform.name }))} selected={audience?.platformIds ?? []} error={errors.platformIds} />
            <div className="grid content-start gap-3">
              <TextField name="boughtFrom" type="date" label={t("campaign.f.boughtFrom")} defaultValue={audience?.boughtFrom ?? ""} error={errors.boughtFrom} />
              <TextField name="boughtTo" type="date" label={t("campaign.f.boughtTo")} defaultValue={audience?.boughtTo ?? ""} error={errors.boughtTo} />
              <Checkbox name="guests" label={t("campaign.f.guests")} hint={t("campaign.f.guestsHint")} defaultChecked={audience?.guests ?? true} />
            </div>
          </div>
        </fieldset>
      ) : null}

      {message ? (
        <fieldset className="mkt-form">
          <legend className="adm-h3">{t("campaign.f.text")}</legend>
          <p className="type-caption text-ink-2">{t("campaign.f.textHint", { variables: CAMPAIGN_VARIABLES.map((name) => `{${name}}`).join(" "), max: BODY_MAX[channel as MessageChannel] })}</p>
          <div className="mkt-grid">
            {MESSAGE_LOCALES.map((lang) => (
              <div key={lang} className="grid content-start gap-3">
                {channel === "email" ? (
                  <TextField
                    name={`subject${lang === "ar" ? "Ar" : lang === "en" ? "En" : "Ckb"}`}
                    label={t("campaign.f.subject", { lang: t(`lang.${lang}`) })}
                    defaultValue={content?.subject?.[lang] ?? ""}
                    maxLength={SUBJECT_MAX}
                    required={lang === "ar"}
                    dir={lang === "en" ? "ltr" : "rtl"}
                    error={errors[`subject${lang === "ar" ? "Ar" : lang === "en" ? "En" : "Ckb"}`]}
                  />
                ) : null}
                <TextArea
                  name={`body${lang === "ar" ? "Ar" : lang === "en" ? "En" : "Ckb"}`}
                  label={t("campaign.f.body", { lang: t(`lang.${lang}`) })}
                  hint={lang === "ar" ? t("campaign.f.bodyArHint") : t("campaign.f.bodyOtherHint")}
                  defaultValue={content?.body?.[lang] ?? ""}
                  rows={4}
                  maxLength={BODY_MAX[channel as MessageChannel]}
                  required={lang === "ar"}
                  dir={lang === "en" ? "ltr" : "rtl"}
                  lang={lang}
                  error={errors[`body${lang === "ar" ? "Ar" : lang === "en" ? "En" : "Ckb"}`]}
                />
              </div>
            ))}
            {campaign ? (
              <Select
                name="linkId"
                label={t("campaign.f.link")}
                hint={campaign.links.length === 0 ? t("campaign.f.linkNone") : t("campaign.f.linkHint")}
                defaultValue={content?.linkId ?? ""}
                options={[{ value: "", label: t("campaign.f.noLink") }, ...campaign.links.map((link) => ({ value: link.id, label: `${link.targetPath} · ${link.source}/${link.medium}` }))]}
                error={errors.linkId}
              />
            ) : (
              <Notice icon="link">{t("campaign.f.linkLater")}</Notice>
            )}
          </div>
        </fieldset>
      ) : null}

      <TextArea name="notes" label={t("campaign.f.notes")} hint={t("campaign.f.notesHint")} defaultValue={content?.notes ?? ""} rows={2} maxLength={500} error={errors.notes} />
      <Failure message={failureText} />
      <div className="mkt-actions">
        <Key type="submit" loading={pending} icon={campaign ? "floppy-disk" : "plus"}>
          {campaign ? t("campaign.save") : t("campaign.create")}
        </Key>
      </div>
    </fetcher.Form>
  );
}

function CampaignFacts({ campaign, options }: { campaign: CampaignDetail; options: { segments: { id: string; name: string }[]; platforms: { id: string; name: string }[] } }) {
  const t = useMarketingT();
  const audience = campaign.content.audience;
  const message = isMessageChannel(campaign.channel);
  const platformNames = (audience?.platformIds ?? []).map((id) => options.platforms.find((platform) => platform.id === id)?.name ?? id);
  return (
    <Facts
      rows={[
        { label: t("campaign.f.channel"), value: t(`channel.${campaign.channel}`) },
        { label: t("campaign.f.segment"), value: audience?.segmentId ? (options.segments.find((segment) => segment.id === audience.segmentId)?.name ?? audience.segmentId) : t("campaign.f.noSegment"), hidden: !message },
        { label: t("campaign.f.platforms"), value: platformNames.length > 0 ? platformNames.join("، ") : t("campaign.anyPlatform"), hidden: !message },
        {
          label: t("campaign.bought"),
          value: audience?.boughtFrom || audience?.boughtTo ? `${audience?.boughtFrom ?? "…"} – ${audience?.boughtTo ?? "…"}` : t("campaign.anyTime"),
          hidden: !message,
        },
        { label: t("campaign.f.guests"), value: audience?.guests === false ? t("common.no") : t("common.yes"), hidden: !message },
        { label: t("campaign.f.scheduledAt"), value: campaign.scheduledAt ? <When at={campaign.scheduledAt} /> : t("campaigns.asSoonAsApproved"), hidden: !message },
        { label: t("campaign.f.startsOn"), value: campaign.content.startsOn ?? "—", hidden: message },
        { label: t("campaign.f.endsOn"), value: campaign.content.endsOn ?? "—", hidden: message },
        { label: t("campaign.f.budget"), value: <Money iqd={campaign.budgetIqd} none={t("common.notSet")} /> },
        { label: t("campaign.f.utm"), value: campaign.utmCampaign ? <Code value={campaign.utmCampaign} /> : "—" },
        { label: t("campaign.f.notes"), value: campaign.content.notes ?? "—" },
      ]}
    />
  );
}

// ───────────────────────────────────────────────────────────────── audience

function AudienceSection({ preview }: { preview: AudiencePreview }) {
  const t = useMarketingT();
  const excluded = Object.values(preview.excluded).reduce((sum, n) => sum + n, 0);
  const columns: DataColumn<RecipientSample>[] = [
    { key: "name", header: t("audience.col.name"), cell: (row) => <CustomerName profileId={row.profileId}>{row.name ?? t("audience.noName")}</CustomerName> },
    { key: "contact", header: t("audience.col.contact"), cell: (row) => (row.email ? <Code value={row.email} /> : <PhoneText phone={row.phone} />) },
    { key: "kind", header: t("audience.col.kind"), cell: (row) => (row.guest ? t("audience.guest") : t("audience.account")) },
    { key: "consent", header: t("audience.col.consent"), cell: (row) => (row.consentAt ? <span className="whitespace-nowrap"><When at={row.consentAt} style="date" /> · {t(`consentSource.${consentSourceKey(row.consentSource)}`)}</span> : "—") },
  ];
  return (
    <Section id="mkt-audience" title={t("audience.title")} lead={t("audience.lead")}>
      <Kpis
        items={[
          { label: t("audience.candidates"), value: <Num value={preview.candidates} />, note: t("audience.candidatesNote") },
          { label: t("audience.eligible"), value: <Num value={preview.eligible} />, note: t("audience.eligibleNote") },
          { label: t("audience.excluded"), value: <Num value={excluded} />, note: t("audience.excludedNote") },
        ]}
      />
      {preview.segment ? (
        <Notice icon="users">
          {t("audience.segmentNote", { name: preview.segment.name, n: preview.segment.members })} {preview.segment.computedAt ? <When at={preview.segment.computedAt} /> : t("audience.neverComputed")}
        </Notice>
      ) : null}
      {preview.truncated ? <Notice tone="warn" icon="warning">{t("audience.truncated")}</Notice> : null}
      <Disclosure summary={t("audience.whyOut")} variant="panel" defaultOpen={excluded > 0 && preview.eligible === 0}>
        <ExclusionRows excluded={preview.excluded} />
      </Disclosure>
      {preview.sample.length > 0 ? (
        <>
          <p className="type-label">{t("audience.sample", { count: preview.sample.length })}</p>
          <div className="hidden md:block">
            <DataTable caption={t("audience.sampleCaption")} columns={columns} rows={preview.sample} rowKey={(row) => row.key} maxHeight={null} />
          </div>
          <ul className="mkt-cards md:hidden" aria-label={t("audience.sampleCaption")}>
            {preview.sample.map((row) => (
              <li key={row.key} className="mkt-card">
                <span className="mkt-card__top">
                  <span className="type-strong">{row.name ?? t("audience.noName")}</span>
                  <span className="type-caption text-ink-2">{row.guest ? t("audience.guest") : t("audience.account")}</span>
                </span>
                <span className="type-body">{row.email ? <Code value={row.email} /> : <PhoneText phone={row.phone} />}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="type-body text-ink-2">{t("audience.nobody")}</p>
      )}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── release and recipients

function ReleaseSection({ campaign }: { campaign: CampaignDetail }) {
  const t = useMarketingT();
  const release = campaign.content.release;
  if (!release) return null;
  return (
    <Section id="mkt-release" title={t("release.title")} lead={t("release.lead")}>
      <Kpis
        items={[
          { label: t("release.held"), value: <Num value={release.held} />, note: t("release.heldNote") },
          { label: t("release.skipped"), value: <Num value={release.skipped} />, note: t("release.skippedNote") },
        ]}
      />
      <Facts
        rows={[
          { label: t("release.at"), value: <When at={release.at} /> },
          { label: t("recipients.col.status"), value: release.complete ? t("release.complete") : t("release.incomplete") },
        ]}
      />
      <Disclosure summary={t("audience.whyOut")} variant="panel">
        <ExclusionRows excluded={release.excluded} />
      </Disclosure>
    </Section>
  );
}

function RecipientsSection({ recipients }: { recipients: { rows: RecipientRow[]; total: number; page: number; pageCount: number } }) {
  const t = useMarketingT();
  const columns: DataColumn<RecipientRow>[] = [
    { key: "name", header: t("audience.col.name"), cell: (row) => <CustomerName profileId={row.profileId}>{row.name ?? t("audience.noName")}</CustomerName> },
    { key: "contact", header: t("audience.col.contact"), cell: (row) => (row.email ? <Code value={row.email} /> : <PhoneText phone={row.phone} />) },
    { key: "status", header: t("recipients.col.status"), cell: (row) => <ToneStatus tone={row.status === "skipped_no_consent" ? "neutral" : row.status === "sent" ? "ok" : row.status === "failed" ? "bad" : "info"}>{t(`recipients.status.${row.status}`)}</ToneStatus> },
  ];
  const href = (n: number) => `?rpage=${n}#mkt-recipients`;
  return (
    <Section id="mkt-recipients" title={t("recipients.title")} lead={t("recipients.lead", { count: recipients.total })}>
      <div className="hidden md:block">
        <DataTable caption={t("recipients.title")} columns={columns} rows={recipients.rows} rowKey={(row) => row.id} maxHeight={null} footer={<Pagination page={recipients.page} pageCount={recipients.pageCount} href={href} />} />
      </div>
      <div className="md:hidden">
        <ul className="mkt-cards" aria-label={t("recipients.title")}>
          {recipients.rows.map((row) => (
            <li key={row.id} className="mkt-card">
              <span className="mkt-card__top">
                <span className="type-strong">{row.name ?? t("audience.noName")}</span>
                <span className="type-caption">{t(`recipients.status.${row.status}`)}</span>
              </span>
              <span className="type-body">{row.email ? <Code value={row.email} /> : <PhoneText phone={row.phone} />}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <Pagination page={recipients.page} pageCount={recipients.pageCount} href={href} />
        </div>
      </div>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── links and spend

function LinksSection({ campaign, canLink }: { campaign: CampaignDetail; canLink: boolean }) {
  const t = useMarketingT();
  const key = useFormKey();
  const [formKey, setFormKey] = useState(key);
  const { fetcher, pending, message, fields: errors } = useIntent("link", "done.linkCreated", () => setFormKey(`${key}-${Date.now()}`));
  const defaultSource = isMessageChannel(campaign.channel) ? campaign.channel : campaign.channel === "ads" ? "ads" : campaign.channel === "social" ? "instagram" : "offline";
  const defaultMedium = isMessageChannel(campaign.channel) ? "message" : campaign.channel === "offline" ? "print" : "paid";
  return (
    <Section id="mkt-links" title={t("links.campaignTitle")} lead={t("links.campaignLead")}>
      {campaign.links.length === 0 ? (
        <p className="type-body text-ink-2">{t("links.noneForCampaign")}</p>
      ) : (
        <ul className="mkt-rows">
          {campaign.links.map((link) => (
            <li key={link.id} className="mkt-row">
              <span className="grid min-w-0 gap-1">
                <span className="type-strong">
                  <Code value={link.targetPath} /> · {link.source}/{link.medium}
                </span>
                <span className="mkt-url" dir="ltr">
                  {link.url}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {canLink && campaign.state !== "cancelled" ? (
        <Disclosure summary={t("links.makeForCampaign")} variant="panel" defaultOpen={campaign.links.length === 0}>
          <fetcher.Form key={formKey} method="post" className="mkt-form" noValidate>
            <input type="hidden" name="intent" value="link" />
            <input type="hidden" name="idempotencyKey" value={formKey.replace(/[^A-Za-z0-9_-]/g, "")} />
            <div className="mkt-grid">
              <TextField name="targetPath" label={t("links.f.path")} hint={t("links.f.pathHint")} defaultValue="/" required ltr maxLength={300} error={errors.targetPath} />
              <TextField name="source" label={t("links.f.source")} hint={t("links.f.sourceHint")} defaultValue={defaultSource} required ltr maxLength={60} error={errors.source} />
              <TextField name="medium" label={t("links.f.medium")} hint={t("links.f.mediumHint")} defaultValue={defaultMedium} required ltr maxLength={60} error={errors.medium} />
              <TextField name="content" label={t("links.f.content")} hint={t("links.f.contentHint")} ltr maxLength={60} error={errors.content} />
            </div>
            <Failure message={message} />
            <div className="mkt-actions">
              <Key type="submit" icon="link" loading={pending}>
                {t("links.create")}
              </Key>
            </div>
          </fetcher.Form>
        </Disclosure>
      ) : null}
      <Notice icon="info">{t("links.captureNote")}</Notice>
    </Section>
  );
}

function SpendSection({ campaign, manage }: { campaign: CampaignDetail; manage: boolean }) {
  const t = useMarketingT();
  const f = useFormat();
  const key = useFormKey();
  const [formKey, setFormKey] = useState(key);
  const { fetcher, message, fields: errors } = useIntent("spend", "done.spendRecorded", () => setFormKey(`${key}${Date.now()}`));
  const entries = [...(campaign.content.spend ?? [])].sort((a, b) => b.period.localeCompare(a.period) || b.at - a.at);
  /** The typed entry, when it can be read (the server decides in the end). */
  const typed = (form: FormData) => {
    const amount = parseWhole(String(form.get("amountIqd") ?? ""), { negative: true });
    const period = normalizeMonth(form.get("period"));
    return amount === undefined || Number.isNaN(amount) || amount === 0 || !period ? null : { amount, period };
  };
  /** What the entry changes: the month's spend and the campaign's total, before and after. */
  const impact = (form: FormData) => {
    const entry = typed(form);
    if (!entry) return [];
    const month = entries.filter((item) => item.period === entry.period).reduce((sum, item) => sum + item.amountIqd, 0);
    return [
      // a non-breaking hyphen keeps "2026-11" on one line
      { label: t("spend.impact.month", { month: entry.period.replace("-", "‑") }), value: t("spend.impact.fromTo", { from: f.iqd(month), to: f.iqd(month + entry.amount) }), negative: entry.amount < 0 },
      { label: t("spend.impact.total"), value: t("spend.impact.fromTo", { from: f.iqd(campaign.spendIqd), to: f.iqd(campaign.spendIqd + entry.amount) }), negative: entry.amount < 0 },
    ];
  };
  // the campaign's name isolated (FSI … PDI): an Arabic name inside an English sentence keeps its own direction
  const consequence = (form: FormData) => (typed(form) ? t("spend.confirmWhat", { name: `⁨${campaign.name}⁩` }) : t("spend.impact.unreadable"));
  return (
    <Section id="mkt-spend" title={t("spend.title")} lead={t("spend.lead")}>
      <Facts
        rows={[
          { label: t("spend.total"), value: entries.length > 0 ? <Money iqd={campaign.spendIqd} /> : t("common.noneEntered") },
          { label: t("campaign.f.budget"), value: <Money iqd={campaign.budgetIqd} none={t("common.notSet")} /> },
        ]}
      />
      {campaign.budgetIqd !== null && campaign.spendIqd > campaign.budgetIqd ? <Notice tone="warn" icon="warning">{t("spend.overBudget")}</Notice> : null}
      {entries.length === 0 ? (
        <p className="type-body text-ink-2">{t("spend.none")}</p>
      ) : (
        <ul className="mkt-rows">
          {entries.map((entry) => (
            <li key={entry.id} className="mkt-row">
              <span className="grid gap-0.5">
                <span className="type-strong nums">
                  <bdi>{entry.period}</bdi>
                </span>
                <span className="type-caption text-ink-2">
                  {entry.note}
                  {entry.reference ? (
                    <>
                      {" · "}
                      <Code value={entry.reference} />
                    </>
                  ) : null}
                </span>
              </span>
              <Money iqd={entry.amountIqd} className="type-strong" />
            </li>
          ))}
        </ul>
      )}
      {manage ? (
        <Disclosure summary={t("spend.add")} variant="panel" defaultOpen={false}>
          <fetcher.Form key={formKey} method="post" className="mkt-form" noValidate>
            <input type="hidden" name="intent" value="spend" />
            <input type="hidden" name="idempotencyKey" value={formKey} />
            <input type="hidden" name="expectedUpdatedAt" value={campaign.updatedAt} />
            <div className="mkt-grid">
              <TextField name="period" type="month" label={t("spend.f.period")} defaultValue={baghdadMonth(Date.now())} required error={errors.period} />
              <TextField name="amountIqd" label={t("spend.f.amount")} hint={t("spend.f.amountHint")} inputMode="numeric" required error={errors.amountIqd} />
              <TextField name="reference" label={t("spend.f.reference")} hint={t("spend.f.referenceHint")} maxLength={80} ltr error={errors.reference} />
              <TextField name="note" label={t("spend.f.note")} hint={t("spend.f.noteHint")} required maxLength={300} error={errors.note} />
            </div>
            <Failure message={message} />
            <div className="mkt-actions">
              <ConfirmSubmit fetcher={fetcher} label={t("spend.record")} title={t("spend.confirmQ")} consequence={consequence} confirmLabel={t("spend.record")} impact={impact} icon="plus" />
            </div>
          </fetcher.Form>
        </Disclosure>
      ) : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── the side: decisions and actions

function DecisionPanel({ campaign, preview }: { campaign: CampaignDetail; preview: AudiencePreview | null }) {
  const t = useMarketingT();
  const approval = campaign.approval;
  if (!approval) {
    if (campaign.lastDecision?.status === "rejected" && campaign.state === "draft") {
      return (
        <div className="mkt-panel">
          <p className="adm-h3">{t("decide.lastRejected")}</p>
          <p className="type-body text-ink-2">{t("decide.rejectedBy", { name: campaign.lastDecision.by ?? t("common.someone") })}</p>
          {campaign.lastDecision.note ? <p className="type-body">{campaign.lastDecision.note === "withdrawn" ? t("decide.withdrawnNote") : campaign.lastDecision.note}</p> : null}
        </div>
      );
    }
    return null;
  }
  const impact = preview
    ? [
        { label: t("decide.impact.held"), value: t("decide.impact.heldValue", { count: preview.eligible }) },
        { label: t("decide.impact.excluded"), value: t("decide.impact.excludedValue", { count: Object.values(preview.excluded).reduce((sum, n) => sum + n, 0) }) },
      ]
    : [{ label: t("decide.impact.tracking"), value: t("decide.impact.trackingValue") }];
  return (
    <div className={approval.canDecide ? "mkt-panel mkt-panel--decide" : "mkt-panel"}>
      <p className="adm-h3">{t("decide.title")}</p>
      <p className="type-body text-ink-2">{t("decide.askedBy", { name: approval.requestedByName ?? t("common.someone") })}</p>
      <p className="type-caption text-ink-2">
        <When at={approval.createdAt} />
      </p>
      {approval.reason ? <p className="type-body">{approval.reason}</p> : null}
      {approval.canDecide ? (
        <div className="mkt-actions">
          <ConfirmAction
            intent="decide"
            label={t("decide.approve")}
            title={t("decide.approveQ")}
            consequence={isMessageChannel(campaign.channel) ? t("decide.approveWhat") : t("decide.approveWhatTracking")}
            confirmLabel={t("decide.approve")}
            values={{ approvalId: approval.id, decision: "approve", fingerprint: campaign.fingerprint }}
            impact={impact}
            reason={{ label: t("decide.note"), noteRequired: false, minLength: 0 }}
            reasonField="note"
            icon="seal-check"
            doneKey="done.approved"
          />
          <ConfirmAction
            intent="decide"
            label={t("decide.reject")}
            title={t("decide.rejectQ")}
            consequence={t("decide.rejectWhat")}
            confirmLabel={t("decide.reject")}
            values={{ approvalId: approval.id, decision: "reject", fingerprint: campaign.fingerprint }}
            reasonField="note"
            tone="destructive"
            icon="x-circle"
            doneKey="done.rejected"
          />
        </div>
      ) : approval.blockedBy ? (
        <Notice icon="lock">{t(`decide.blocked.${approval.blockedBy}`)}</Notice>
      ) : (
        <Notice icon="info">{t("decide.waiting")}</Notice>
      )}
      {campaign.can.withdraw ? (
        <ConfirmAction intent="withdraw" label={t("decide.withdraw")} title={t("decide.withdrawQ")} consequence={t("decide.withdrawWhat")} confirmLabel={t("decide.withdraw")} values={{ approvalId: approval.id }} reason={false} variant="ghost" icon="arrow-u-up-left" doneKey="done.withdrawn" />
      ) : null}
    </div>
  );
}

function ActionsPanel({ campaign, preview }: { campaign: CampaignDetail; preview: AudiencePreview | null }) {
  const t = useMarketingT();
  const can = campaign.can;
  if (!can.submit && !can.release && !can.cancel && !can.close) return null;
  const message = isMessageChannel(campaign.channel);
  return (
    <div className="mkt-panel">
      <p className="adm-h3">{t("actions.title")}</p>
      {can.submit ? (
        <>
          <p className="type-body text-ink-2">{message ? t("actions.submitWhy") : t("actions.submitWhyTracking")}</p>
          <ConfirmAction
            intent="submit"
            label={t("actions.submit")}
            title={t("actions.submitQ")}
            consequence={t("actions.submitWhat")}
            confirmLabel={t("actions.submit")}
            values={{ expectedUpdatedAt: String(campaign.updatedAt) }}
            impact={preview ? [{ label: t("decide.impact.held"), value: t("decide.impact.heldValue", { count: preview.eligible }) }] : undefined}
            reason={{ label: t("actions.submitNote"), noteRequired: false, minLength: 0 }}
            reasonField="note"
            icon="paper-plane-tilt"
            doneKey="done.submitted"
          />
        </>
      ) : null}
      {can.release ? (
        <>
          <p className="type-body text-ink-2">{t("actions.releaseWhy")}</p>
          <ConfirmAction
            intent="release"
            label={campaign.state === "released" ? t("actions.releaseRest") : t("actions.release")}
            title={t("actions.releaseQ")}
            consequence={t("actions.releaseWhat")}
            confirmLabel={t("actions.release")}
            impact={preview ? [{ label: t("decide.impact.held"), value: t("decide.impact.heldValue", { count: preview.eligible }) }, { label: t("actions.sent"), value: t("actions.sentValue") }] : undefined}
            reason={false}
            icon="paper-plane-tilt"
            doneKey={(result) => (Number(result.held) > 0 ? "done.released" : "done.releasedNone")}
          />
        </>
      ) : campaign.state === "scheduled" ? (
        <Notice icon="clock">{t("actions.notDue")}</Notice>
      ) : null}
      {can.close ? (
        <ConfirmAction intent="close" label={t("actions.close")} title={t("actions.closeQ")} consequence={message ? t("actions.closeWhat") : t("actions.closeWhatTracking")} confirmLabel={t("actions.close")} reason={{ label: t("actions.closeNote"), noteRequired: false, minLength: 0 }} icon="check-circle" doneKey="done.closed" />
      ) : null}
      {can.cancel ? (
        <ConfirmAction intent="cancel" label={t("actions.cancel")} title={t("actions.cancelQ")} consequence={t("actions.cancelWhat")} confirmLabel={t("actions.cancel")} tone="destructive" variant="ghost" icon="x-circle" doneKey="done.cancelled" />
      ) : null}
    </div>
  );
}
