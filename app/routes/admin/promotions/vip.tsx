import { useRef } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/vip";
import { useFormat, useLocale } from "~/i18n/react";
import { pick } from "~/lib/locales";
import { throwAsResponse } from "~/server/errors";
import { SECTION_READ } from "~/server/services/admin/promotions/shared.server";
import { MEMBER_VIEWS, bpsToPercent, parseVipFilters, vipSearch, type EligibleRow, type MemberRow, type TierRow } from "~/server/services/admin/promotions/types";
import { closeEndedMemberships, endMembership, grantMembership, saveTier, vipPage } from "~/server/services/admin/promotions/vip.server";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { promotionsMeta } from "./meta";
import { fields, openPromotions, respond, runIntent, text } from "./promotions.server";
import { Arrow, ConfirmAction, Failure, Notice, PhoneText, SectionState, Section, Tag, ToneStatus, useIntent, usePromotionsT, When, useProgram } from "./ui";

/**
 * /admin/promotions/vip — 08.06: the tiers with their written benefits and shipping terms, the members, and the
 * customers module 07's rule labels VIP who hold no membership yet (granting one is a person's decision with a
 * reason). The online checkout applies the member discount — at most the discount limits in force, so a tier above
 * them says how much is applied — and free delivery; the multiplier counts when points are posted; early access is
 * written but read by nothing, and the till applies no benefit (the note, checkout-state.ts).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now, locale } = await openPromotions(context, SECTION_READ.vip);
  const filters = parseVipFilters(new URL(request.url).searchParams);
  try {
    return { page: await vipPage(db, actor, now, locale, filters), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.membership.manage");
  const form = await request.formData();
  const manage = ["promotions.membership.manage"] as const;
  return respond(
    await runIntent(ctx, session, form, { tier: manage, grant: manage, end: manage, close: manage }, async (intent) => {
      const { actor } = session;
      switch (intent) {
        case "tier":
          return { ok: true, intent, ...(await saveTier(db, actor, fields(form), ctx.now)) };
        case "grant":
          return { ok: true, intent, ...(await grantMembership(db, actor, { customerId: text(form, "customerId"), tierId: text(form, "tierId"), days: text(form, "days"), reason: text(form, "reason") }, ctx.now)) };
        case "end":
          return { ok: true, intent, ...(await endMembership(db, actor, { membershipId: text(form, "membershipId"), reason: text(form, "reason") }, ctx.now)) };
        case "close":
          return { ok: true, intent, ...(await closeEndedMemberships(db, actor, ctx.now)) };
      }
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "vip.title");

export default function VipPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const f = useFormat();
  const { page, filters } = loaderData;
  const manage = page.can.manage;
  const activeTiers = page.tiers.filter((tier) => tier.isActive);
  const memberColumns: DataColumn<MemberRow>[] = [
    { key: "customer", header: t("vip.m.customer"), cell: (row) => <span className="grid">{page.can.seeProfiles ? <Link to={`/admin/customers/${row.customerId}`} className="adm-link">{row.customer ?? t("common.noName")}</Link> : (row.customer ?? t("common.noName"))}<span className="type-caption text-ink-2"><PhoneText phone={row.phone} /></span></span> },
    { key: "tier", header: t("vip.m.tier"), cell: (row) => row.tier },
    { key: "status", header: t("vip.m.status"), cell: (row) => <ToneStatus tone={row.status === "active" ? "ok" : "out"}>{t(`vip.status.${row.status}`)}</ToneStatus> },
    { key: "since", header: t("vip.m.since"), cell: (row) => <When at={row.startsAt} style="date" /> },
    { key: "until", header: t("vip.m.until"), cell: (row) => (row.endsAt ? <When at={row.endsAt} style="date" /> : t("vip.noEnd")) },
    { key: "by", header: t("vip.m.by"), cell: (row) => row.grantedBy ?? t(`vip.source.${row.source}`) },
    ...(manage
      ? [
          {
            key: "end",
            header: <span className="sr-only">{t("vip.end")}</span>,
            cell: (row: MemberRow) =>
              row.status === "active" ? <ConfirmAction intent="end" label={t("vip.end")} title={t("vip.endQ", { name: row.customer ?? "—" })} consequence={t("vip.endWhat")} confirmLabel={t("vip.end")} values={{ membershipId: row.id }} tone="destructive" variant="ghost" doneKey="done.ended" /> : null,
          },
        ]
      : []),
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "08.06" })}</p>
        <h1 className="adm-title">{t("vip.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("vip.lead")}</p>
      </header>
      <SectionState id="vip" />
      <Section id="prm-tiers" title={t("vip.tiers")}>
        {page.tiers.length === 0 ? <p className="type-body text-ink-2">{manage ? t("vip.noTiers") : t("vip.noTiersRead")}</p> : null}
        <div className="adm-grid">
          {page.tiers.map((tier) => (
            <TierCard key={tier.id} tier={tier} manage={manage} />
          ))}
        </div>
        {manage ? (
          <Disclosure summary={t("vip.newTier")} variant="panel">
            <TierForm tier={null} />
          </Disclosure>
        ) : null}
      </Section>
      <div className="prm-layout">
        <div className="prm-main">
          <Section id="prm-eligible" title={t("vip.eligible", { count: page.eligibleTotal })} lead={t("vip.eligibleLead")}>
            {page.eligible.length === 0 ? (
              <p className="type-body text-ink-2">{t("vip.noEligible")}</p>
            ) : (
              <ul className="prm-rows">
                {page.eligible.map((row) => (
                  <EligibleItem key={row.customerId} row={row} tiers={activeTiers} manage={manage} seeProfiles={page.can.seeProfiles} />
                ))}
              </ul>
            )}
            {/* the count is everyone eligible; the list holds the newest 50 — said, never implied */}
            {page.eligibleTotal > page.eligible.length ? <p className="type-caption text-ink-2">{t("common.newestOf", { shown: page.eligible.length, total: page.eligibleTotal })}</p> : null}
          </Section>
          <Section id="prm-members" title={t(page.memberView === "current" ? "vip.members" : "vip.endedMembers", { count: page.memberTotal })}>
            <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
              {MEMBER_VIEWS.map((view) => {
                const held = page.memberView === view;
                return (
                  <Key key={view} as={Link} to={`/admin/promotions/vip${vipSearch({ members: view, page: 1 })}`} size="sm" held={held} aria-current={held ? "true" : undefined}>
                    {t(`vip.views.${view}`)} <bdi className="nums text-ink-2">{page.memberCounts[view]}</bdi>
                  </Key>
                );
              })}
            </nav>
            {page.members.length === 0 ? (
              <p className="type-body text-ink-2">{page.memberView === "current" ? t("vip.noMembers") : t("vip.noEnded")}</p>
            ) : (
              <>
                <div className="hidden md:block">
                  <DataTable
                    caption={t(page.memberView === "current" ? "vip.members" : "vip.endedMembers", { count: page.memberTotal })}
                    columns={memberColumns}
                    rows={page.members}
                    rowKey={(row) => row.id}
                    maxHeight={null}
                    footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => vipSearch({ ...filters, page: n }) || "?"} />}
                  />
                </div>
                <ul className="prm-cards md:hidden">
                  {page.members.map((row) => (
                    <li key={row.id} className="prm-card">
                      <span className="prm-card__top">
                        <span className="type-strong">{page.can.seeProfiles ? <Link to={`/admin/customers/${row.customerId}`} className="adm-link">{row.customer ?? t("common.noName")}</Link> : (row.customer ?? t("common.noName"))}</span>
                        <ToneStatus tone={row.status === "active" ? "ok" : "out"}>{t(`vip.status.${row.status}`)}</ToneStatus>
                      </span>
                      <span className="type-caption text-ink-2">
                        <PhoneText phone={row.phone} />
                      </span>
                      <span className="type-body">
                        {row.tier} · <When at={row.startsAt} style="date" />
                        <Arrow />
                        {row.endsAt ? <When at={row.endsAt} style="date" /> : t("vip.noEnd")}
                      </span>
                      <span className="type-caption text-ink-2">{row.grantedBy ?? t(`vip.source.${row.source}`)}</span>
                      {manage && row.status === "active" ? (
                        <span>
                          <ConfirmAction intent="end" label={t("vip.end")} title={t("vip.endQ", { name: row.customer ?? "—" })} consequence={t("vip.endWhat")} confirmLabel={t("vip.end")} values={{ membershipId: row.id }} tone="destructive" variant="ghost" doneKey="done.ended" />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="md:hidden">
                  <Pagination page={page.page} pageCount={page.pageCount} href={(n) => vipSearch({ ...filters, page: n }) || "?"} />
                </div>
              </>
            )}
          </Section>
        </div>
        <aside className="prm-side" aria-label={t("common.side")}>
          <Section id="prm-vip-rule" title={t("vip.rule.title")}>
            {/* module 07's rule as it is in force (the setting customers.flag_rules), never a fixed sentence */}
            <Notice icon="star">{t("vip.rule.text", { amount: f.iqd(page.rule.spendIqd), purchases: f.number(page.rule.purchases), span: t("daySpan", { count: page.rule.windowDays }) })}</Notice>
            <Notice icon="info">{t("vip.rule.decide")}</Notice>
          </Section>
          {manage ? (
            <div className="prm-panel">
              <p className="adm-h3">{t("vip.close.title")}</p>
              <p className="type-body text-ink-2">{t("vip.close.what", { count: page.endedWaiting })}</p>
              <ConfirmAction intent="close" label={t("vip.close.go")} title={t("vip.close.q")} consequence={t("vip.close.consequence")} confirmLabel={t("vip.close.go")} reason={false} disabled={page.endedWaiting === 0} icon="hourglass" doneKey={(result) => (Number(result.expired) > 0 ? "done.closed" : "done.nothing")} />
            </div>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function TierCard({ tier, manage }: { tier: TierRow; manage: boolean }) {
  const t = usePromotionsT();
  const f = useFormat();
  const locale = useLocale();
  const program = useProgram();
  const b = tier.benefits;
  // the checkout gives a member at most the discount limits in force (orders/promotions.ts step 4): say what applies
  const capped = b.discountBps !== null && b.discountBps > program.limits.percentBps;
  return (
    <article className="adm-card">
      <p className="flex flex-wrap items-center gap-2 type-strong">
        {pick(tier.name, locale)}
        <bdi dir="ltr" className="type-caption text-ink-2">
          {tier.key}
        </bdi>
        {tier.isActive ? null : <ToneStatus tone="out">{t("vip.tierOff")}</ToneStatus>}
      </p>
      <span className="prm-tags">
        {b.discountBps ? (
          <Tag icon="percent" warn={capped}>
            {capped ? t("vip.b.discountCapped", { percent: bpsToPercent(b.discountBps), cap: bpsToPercent(program.limits.percentBps) }) : t("vip.b.discount", { percent: bpsToPercent(b.discountBps) })}
          </Tag>
        ) : null}
        {b.freeShipping ? <Tag icon="truck">{t("vip.b.freeShipping")}</Tag> : null}
        {/* 15,000 bps → "1.5", 20,000 → "2" (it read "2.0": only one trailing zero was dropped) */}
        {b.pointsMultiplierBps ? <Tag icon="coins">{t("vip.b.multiplier", { factor: (b.pointsMultiplierBps / 10_000).toFixed(2).replace(/\.?0+$/, "") })}</Tag> : null}
        {/* written on the tier, read by nothing yet (checkout-state.ts): said on the tag itself */}
        {b.earlyAccess ? (
          <Tag icon="plugs-connected" warn>
            {t("vip.b.earlyAccess")}
          </Tag>
        ) : null}
      </span>
      {b.notes ? <p className="type-body text-ink-2">{pick(b.notes, locale)}</p> : null}
      <p className="type-caption text-ink-2">
        {t("vip.tierMembers", { count: tier.members, n: f.number(tier.members) })} · {tier.durationDays ? t("vip.tierDays", { count: tier.durationDays, n: f.number(tier.durationDays) }) : t("vip.tierNoEnd")}
      </p>
      {manage ? (
        <Disclosure summary={t("vip.editTier")} variant="row">
          <TierForm tier={tier} />
        </Disclosure>
      ) : null}
    </article>
  );
}

function TierForm({ tier }: { tier: TierRow | null }) {
  const t = usePromotionsT();
  const f = useFormat();
  const program = useProgram();
  const { fetcher, pending, message, fields: errors } = useIntent("tier", (result) => (result.created ? "done.created" : result.changed ? "done.saved" : "done.nothing"));
  const b = tier?.benefits;
  return (
    <fetcher.Form method="post" className="prm-form" noValidate>
      <input type="hidden" name="intent" value="tier" />
      {tier ? (
        <>
          <input type="hidden" name="tierId" value={tier.id} />
          <input type="hidden" name="expected" value={tier.fingerprint} />
        </>
      ) : null}
      <div className="prm-grid">
        <TextField name="key" label={t("vip.f.key")} hint={t("vip.f.keyHint")} defaultValue={tier?.key ?? ""} required ltr error={errors.key} />
        <TextField name="nameAr" label={t("vip.f.nameAr")} defaultValue={tier?.name.ar ?? ""} required maxLength={60} error={errors.nameAr} />
        <TextField name="nameEn" label={t("vip.f.nameEn")} defaultValue={tier?.name.en ?? ""} maxLength={60} ltr lang="en" error={errors.nameEn} />
        <TextField name="discount" label={t("vip.f.discount")} hint={t("vip.f.discountHint", { percent: bpsToPercent(program.limits.percentBps), amount: f.iqd(program.limits.perOrderIqd) })} defaultValue={b?.discountBps ? bpsToPercent(b.discountBps) : ""} inputMode="decimal" error={errors.discount} />
        <TextField name="multiplier" label={t("vip.f.multiplier")} hint={t("vip.f.multiplierHint")} defaultValue={b?.pointsMultiplierBps ? (b.pointsMultiplierBps / 10_000).toFixed(2) : ""} inputMode="decimal" error={errors.multiplier} />
        <TextField name="durationDays" label={t("vip.f.duration")} hint={t("vip.f.durationHint")} defaultValue={tier?.durationDays ?? ""} inputMode="numeric" error={errors.durationDays} />
        <TextField name="sort" label={t("vip.f.sort")} defaultValue={tier?.sort ?? 0} inputMode="numeric" error={errors.sort} />
        <div className="grid content-end gap-2">
          <Checkbox name="freeShipping" label={t("vip.f.freeShipping")} defaultChecked={b?.freeShipping ?? false} />
          <Checkbox name="earlyAccess" label={t("vip.f.earlyAccess")} hint={t("vip.f.earlyAccessHint")} defaultChecked={b?.earlyAccess ?? false} />
          <Checkbox name="isActive" label={t("vip.f.active")} defaultChecked={tier?.isActive ?? true} />
        </div>
        <TextArea name="notesAr" label={t("vip.f.notesAr")} hint={t("vip.f.notesHint")} defaultValue={b?.notes?.ar ?? ""} required rows={3} maxLength={600} className="prm-span" error={errors.notesAr} />
        <TextArea name="notesEn" label={t("vip.f.notesEn")} defaultValue={b?.notes?.en ?? ""} rows={2} maxLength={600} dir="ltr" className="prm-span" error={errors.notesEn} />
        <TextArea name="reason" label={t("common.reason")} hint={t("common.reasonHint")} required rows={2} maxLength={500} className="prm-span" error={errors.reason} />
      </div>
      <Failure message={message} />
      <div>
        <Key type="submit" loading={pending} icon="floppy-disk">
          {tier ? t("vip.saveTier") : t("vip.createTier")}
        </Key>
      </div>
    </fetcher.Form>
  );
}

function EligibleItem({ row, tiers, manage, seeProfiles }: { row: EligibleRow; tiers: readonly TierRow[]; manage: boolean; seeProfiles: boolean }) {
  const t = usePromotionsT();
  const f = useFormat();
  const locale = useLocale();
  const tierRef = useRef<HTMLSelectElement | null>(null);
  const daysRef = useRef<HTMLInputElement | null>(null);
  return (
    <li className="prm-row">
      <span className="grid min-w-0">
        {seeProfiles ? (
          <Link to={`/admin/customers/${row.customerId}`} className="adm-link">
            {row.customer ?? t("common.noName")}
          </Link>
        ) : (
          <span className="type-strong">{row.customer ?? t("common.noName")}</span>
        )}
        <span className="type-caption text-ink-2">
          <PhoneText phone={row.phone} />
        </span>
        <span className="type-caption text-ink-2">
          {/* the window is a setting (any 1–3650 days): its noun agrees with the number (daySpan) */}
          {row.flags.map((flag) => t(`vip.flag.${flag.id}`, { ...flag.vars, amount: typeof flag.vars.amount === "number" ? f.iqd(flag.vars.amount) : (flag.vars.amount ?? ""), span: typeof flag.vars.days === "number" ? t("daySpan", { count: flag.vars.days }) : "" })).join(" · ")}
        </span>
      </span>
      {manage && tiers.length ? (
        <ConfirmAction
          intent="grant"
          label={t("vip.grant")}
          title={t("vip.grantQ", { name: row.customer ?? "—" })}
          consequence={t("vip.grantWhat")}
          confirmLabel={t("vip.grant")}
          values={{ customerId: row.customerId }}
          extra={() => ({ tierId: tierRef.current?.value ?? "", days: daysRef.current?.value ?? "" })}
          icon="star"
          doneKey="done.granted"
        >
          <div className="grid gap-3">
            <Select ref={tierRef} name="tierId" label={t("vip.m.tier")} options={tiers.map((tier) => ({ value: tier.id, label: pick(tier.name, locale) }))} />
            <TextField ref={daysRef} name="days" label={t("vip.f.duration")} hint={t("vip.f.grantDaysHint")} inputMode="numeric" />
          </div>
        </ConfirmAction>
      ) : manage ? (
        <span className="type-caption text-ink-2">{t("vip.needTier")}</span>
      ) : null}
    </li>
  );
}
