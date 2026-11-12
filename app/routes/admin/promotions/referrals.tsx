import { useState } from "react";
import { Link, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/referrals";
import { throwAsResponse } from "~/server/errors";
import { issueReferralCode, listReferrals, recordReferral, rejectReferral, rewardReferral, setReferralCodeActive } from "~/server/services/admin/promotions/referrals.server";
import { SECTION_READ, type PromotionsAccess } from "~/server/services/admin/promotions/shared.server";
import { REFERRAL, REFERRAL_STATUS_TONE, REFERRAL_VIEWS, parseReferralFilters, referralSearch, type ReferralCodeRow, type ReferralRow } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { PROMOTIONS_LAYOUT_ID, promotionsMeta } from "./meta";
import { openPromotions, respond, runIntent, text } from "./promotions.server";
import { Boundary, Code, ConfirmAction, Failure, newKey, Notice, Num, PhoneText, Section, Tag, ToneStatus, useIntent, usePromotionsT, When } from "./ui";

/**
 * /admin/promotions/referrals — 08.05: the abuse rules in words, the referrals to review with their signals (same
 * address, same device, an existing customer, the order's state), rewarding (points to the referrer, once; never by
 * whoever recorded it) and rejecting (with a reason), recording a referral told at the counter, and every customer's
 * code with its uses and cap.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, SECTION_READ.referrals);
  const filters = parseReferralFilters(new URL(request.url).searchParams);
  try {
    return { page: await listReferrals(db, actor, filters, now), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.referral.manage");
  const form = await request.formData();
  const manage = ["promotions.referral.manage"] as const;
  return respond(
    await runIntent(ctx, session, form, { issue: manage, code: manage, record: manage, reward: manage, reject: manage }, async (intent) => {
      const { actor } = session;
      switch (intent) {
        case "issue":
          return { ok: true, intent, ...(await issueReferralCode(db, actor, { phone: text(form, "phone"), maxUses: text(form, "maxUses") }, ctx.now)) };
        case "code":
          return { ok: true, intent, ...(await setReferralCodeActive(db, actor, { codeId: text(form, "codeId"), active: text(form, "active") === "1", reason: text(form, "reason") }, ctx.now)) };
        case "record":
          return { ok: true, intent, ...(await recordReferral(db, actor, { code: text(form, "code"), phone: text(form, "phone"), orderRef: text(form, "orderRef"), note: text(form, "note"), idempotencyKey: text(form, "idempotencyKey") }, ctx.now)) };
        case "reward":
          return { ok: true, intent, ...(await rewardReferral(db, actor, { referralId: text(form, "referralId"), note: text(form, "note") }, ctx.now)) };
        case "reject":
          return { ok: true, intent, ...(await rejectReferral(db, actor, { referralId: text(form, "referralId"), reason: text(form, "reason") }, ctx.now)) };
      }
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "referrals.title");

export default function ReferralsPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const layout = useRouteLoaderData(PROMOTIONS_LAYOUT_ID) as { access: PromotionsAccess } | undefined;
  const { page, filters } = loaderData;
  const manage = page.can.manage;
  const codeColumns: DataColumn<ReferralCodeRow>[] = [
    { key: "code", header: t("referrals.c.code"), cell: (row) => <Code value={row.code} /> },
    { key: "customer", header: t("referrals.c.customer"), cell: (row) => <span className="grid">{layout?.access.customers ? <Link to={`/admin/customers/${row.customerId}`} className="adm-link">{row.customer ?? t("common.noName")}</Link> : (row.customer ?? t("common.noName"))}<span className="type-caption text-ink-2"><PhoneText phone={row.phone} /></span></span> },
    { key: "uses", header: t("referrals.c.uses"), numeric: true, cell: (row) => <span className="whitespace-nowrap"><Num value={row.uses} />{row.maxUses !== null ? <span className="text-ink-2"> / <Num value={row.maxUses} /></span> : null}</span> },
    { key: "state", header: t("referrals.c.state"), cell: (row) => (row.isActive ? <ToneStatus tone="ok">{t("referrals.c.on")}</ToneStatus> : <ToneStatus tone="out">{t("referrals.c.off")}</ToneStatus>) },
    { key: "created", header: t("referrals.c.created"), cell: (row) => <When at={row.createdAt} style="date" /> },
    ...(manage
      ? [
          {
            key: "switch",
            header: <span className="sr-only">{t("referrals.c.switch")}</span>,
            cell: (row: ReferralCodeRow) => (
              <ConfirmAction
                intent="code"
                label={row.isActive ? t("referrals.c.turnOff") : t("referrals.c.turnOn")}
                title={row.isActive ? t("referrals.c.offQ", { code: row.code }) : t("referrals.c.onQ", { code: row.code })}
                consequence={row.isActive ? t("referrals.c.offWhat") : t("referrals.c.onWhat")}
                confirmLabel={row.isActive ? t("referrals.c.turnOff") : t("referrals.c.turnOn")}
                values={{ codeId: row.id, active: row.isActive ? "0" : "1" }}
                tone={row.isActive ? "destructive" : "neutral"}
                variant="ghost"
                doneKey="done.saved"
              />
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "08.05" })}</p>
        <h1 className="adm-title">{t("referrals.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("referrals.lead", { points: REFERRAL.rewardPoints })}</p>
      </header>
      <Boundary>{t("referrals.boundary")}</Boundary>
      <div className="prm-layout">
        <div className="prm-main">
          <Section id="prm-ref-list" title={t("referrals.listTitle")}>
            <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
              {REFERRAL_VIEWS.map((view) => {
                const active = filters.view === view;
                return (
                  <Key key={view} as={Link} to={`/admin/promotions/referrals${referralSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                    {t(`referrals.views.${view}`)} <bdi className="nums text-ink-2">{page.counts[view] ?? 0}</bdi>
                  </Key>
                );
              })}
            </nav>
            {page.rows.length === 0 ? (
              <EmptyState title={t("referrals.empty")} text={manage ? t("referrals.emptyHint") : t("referrals.emptyHintRead")} icon="users" />
            ) : (
              <ul className="prm-cards" aria-label={t("referrals.listTitle")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <ReferralCard row={row} manage={manage} />
                  </li>
                ))}
              </ul>
            )}
            <Pagination page={page.page} pageCount={page.pageCount} href={(n) => referralSearch({ ...filters, page: n }) || "?"} />
          </Section>
          <Section id="prm-ref-codes" title={t("referrals.codes", { count: page.codeTotal })}>
            {page.codes.length === 0 ? <p className="type-body text-ink-2">{t("referrals.noCodes")}</p> : <DataTable caption={t("referrals.codes", { count: page.codeTotal })} columns={codeColumns} rows={page.codes} rowKey={(row) => row.id} maxHeight="28rem" />}
            {/* the count is every code; the list holds the newest 50 — said, never implied */}
            {page.codeTotal > page.codes.length ? <p className="type-caption text-ink-2">{t("common.newestOf", { shown: page.codes.length, total: page.codeTotal })}</p> : null}
          </Section>
        </div>
        <aside className="prm-side" aria-label={t("common.side")}>
          <Section id="prm-ref-rules" title={t("referrals.rules.title")}>
            <ul className="grid gap-2">
              {(["self", "phone", "cap", "order"] as const).map((rule) => (
                <li key={rule}>
                  <Notice icon="shield-check">{t(`referrals.rules.${rule}`, { n: REFERRAL.defaultMaxUses })}</Notice>
                </li>
              ))}
              <li>
                <Notice icon="eye">{t("referrals.rules.signals", { days: REFERRAL.deviceWindowDays })}</Notice>
              </li>
            </ul>
          </Section>
          {manage ? <RecordForm /> : null}
          {manage ? <IssueForm /> : null}
        </aside>
      </div>
    </>
  );
}

function ReferralCard({ row, manage }: { row: ReferralRow; manage: boolean }) {
  const t = usePromotionsT();
  const open = row.status === "pending" || row.status === "qualified";
  return (
    <div className={open && row.qualifies ? "prm-card prm-panel--decide" : "prm-card"}>
      <span className="prm-card__top">
        <span className="inline-flex items-center gap-2">
          <Code value={row.code} />
          <span className="type-body text-ink-2">{t("referrals.byLine", { name: row.referrer ?? t("common.noName") })}</span>
        </span>
        <ToneStatus tone={REFERRAL_STATUS_TONE[row.status]}>{t(`referrals.status.${row.status}`)}</ToneStatus>
      </span>
      <span className="type-body">
        {t("referrals.referred")} <PhoneText phone={row.referredPhone} />
        {row.referred ? ` · ${row.referred}` : ""}
        {row.orderRef ? (
          <>
            {" · "}
            <Code value={row.orderRef} />
          </>
        ) : null}
      </span>
      <span className="type-caption text-ink-2">
        <When at={row.createdAt} />
        {row.recordedBy ? ` · ${t("referrals.recordedBy", { name: row.recordedBy })}` : ""}
      </span>
      {row.signals.length ? (
        <span className="prm-tags">
          {row.signals.map((signal) => (
            <Tag key={signal} icon={signal.startsWith("order_") ? "clock" : "warning"} warn={!signal.startsWith("order_")}>
              {t(`referrals.signal.${signal}`)}
            </Tag>
          ))}
        </span>
      ) : null}
      {row.rejectReason ? <span className="type-caption text-ink-2">{t("common.reasonWas", { reason: row.rejectReason })}</span> : null}
      {manage && open ? (
        <span className="prm-actions">
          {row.recordedByMe ? (
            <Notice>{t("referrals.mineNote")}</Notice>
          ) : (
            <ConfirmAction
              intent="reward"
              label={t("referrals.reward")}
              title={t("referrals.rewardQ")}
              consequence={row.qualifies ? t("referrals.rewardWhat", { points: REFERRAL.rewardPoints, name: row.referrer ?? "—" }) : t("referrals.notYet")}
              confirmLabel={t("referrals.reward")}
              values={{ referralId: row.id }}
              impact={[{ label: t("referrals.impact.points"), value: `+${REFERRAL.rewardPoints}` }, ...(row.signals.length ? [{ label: t("referrals.impact.signals"), value: String(row.signals.length) }] : [])]}
              reasonField="note"
              reasonLabel={t("common.note")}
              disabled={!row.qualifies}
              icon="check-circle"
              doneKey="done.rewarded"
            />
          )}
          <ConfirmAction intent="reject" label={t("referrals.reject")} title={t("referrals.rejectQ")} consequence={t("referrals.rejectWhat")} confirmLabel={t("referrals.reject")} values={{ referralId: row.id }} tone="destructive" variant="ghost" icon="x-circle" doneKey="done.rejected" />
        </span>
      ) : null}
    </div>
  );
}

function RecordForm() {
  const t = usePromotionsT();
  const [formKey, setFormKey] = useState(newKey);
  const { fetcher, pending, message, fields: errors } = useIntent("record", "done.recorded", () => setFormKey(newKey()));
  return (
    <Disclosure summary={t("referrals.record.title")} variant="panel">
      <fetcher.Form method="post" className="prm-form" noValidate key={formKey}>
        <input type="hidden" name="intent" value="record" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        <TextField name="code" label={t("referrals.record.code")} required ltr autoCapitalize="characters" error={errors.code} />
        <TextField name="phone" type="tel" label={t("referrals.record.phone")} required error={errors.phone} />
        <TextField name="orderRef" label={t("referrals.record.order")} hint={t("referrals.record.orderHint")} ltr error={errors.orderRef} />
        <TextArea name="note" label={t("referrals.record.note")} hint={t("referrals.record.noteHint")} required rows={2} maxLength={500} error={errors.note} />
        <Failure message={message} />
        <div>
          <Key type="submit" loading={pending} icon="plus">
            {t("referrals.record.save")}
          </Key>
        </div>
      </fetcher.Form>
    </Disclosure>
  );
}

function IssueForm() {
  const t = usePromotionsT();
  const { fetcher, pending, message, fields: errors, data } = useIntent("issue", (result) => (result.replayed ? "done.codeExists" : "done.codeIssued"));
  return (
    <Disclosure summary={t("referrals.issue.title")} variant="panel">
      <fetcher.Form method="post" className="prm-form" noValidate>
        <input type="hidden" name="intent" value="issue" />
        <TextField name="phone" type="tel" label={t("referrals.issue.phone")} hint={t("referrals.issue.phoneHint")} required error={errors.phone} />
        <TextField name="maxUses" label={t("referrals.issue.cap")} hint={t("referrals.issue.capHint", { n: REFERRAL.defaultMaxUses, max: REFERRAL.maxUsesCap })} inputMode="numeric" error={errors.maxUses} />
        <Failure message={message} />
        <div>
          <Key type="submit" loading={pending} icon="ticket">
            {t("referrals.issue.save")}
          </Key>
        </div>
      </fetcher.Form>
      {data && typeof data.code === "string" ? (
        <p className="type-body" aria-live="polite">
          {t("referrals.issue.done")} <span className="prm-secret">{data.code}</span>
        </p>
      ) : null}
    </Disclosure>
  );
}
