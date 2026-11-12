import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/gift-cards";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { checkGiftCardRedemption, decideGiftCard, expireGiftCards, issueGiftCard, listGiftCards, redeemGiftCard, withdrawGiftCardRequest } from "~/server/services/admin/promotions/giftcards.server";
import { SECTION_READ } from "~/server/services/admin/promotions/shared.server";
import { GIFT_CARD, GIFT_CARD_STATUS_TONE, GIFT_CARD_VIEWS, endOfBaghdadDay, giftCardSearch, parseGiftCardFilters, parseWhole, type GiftCardRow } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { promotionsDataKey } from "./env.server";
import { promotionsMeta } from "./meta";
import { openPromotions, respond, runIntent, text } from "./promotions.server";
import { OnceCode } from "./gift-code";
import { Boundary, ConfirmAction, DemoNote, Failure, Kpis, Money, newKey, Notice, Section, ToneStatus, useIntent, usePromotionsT, When } from "./ui";

/**
 * /admin/promotions/gift-cards — 08.07: the settlement (issued, outstanding, redeemed — checked against the wallet
 * ledger —, expired, void, waiting for a second person), issuing a card (its code shown once, printable), the
 * requests to decide, redeeming a card into a customer's wallet (once), marking cards past their date as expired, and
 * every card (views and search by the last four characters or the note, in the URL). No code is ever in this list.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, SECTION_READ.giftCards);
  const filters = parseGiftCardFilters(new URL(request.url).searchParams);
  try {
    return { page: await listGiftCards(db, actor, filters, now), filters, dataKeyReady: Boolean(promotionsDataKey()) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, SECTION_READ.giftCards);
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { issue: ["promotions.gift_card.issue"], decide: ["promotions.gift_card.manage"], withdraw: [], check: ["promotions.gift_card.manage"], redeem: ["promotions.gift_card.manage"], expire: ["promotions.gift_card.manage"] }, async (intent) => {
      const { actor } = session;
      switch (intent) {
        case "check":
          return { ok: true, intent, ...(await checkGiftCardRedemption(db, actor, { code: text(form, "code"), phone: text(form, "phone") }, ctx.now)) };
        case "issue":
          return { ok: true, intent, ...(await issueGiftCard(db, actor, promotionsDataKey(), { amountIqd: text(form, "amountIqd"), expiresOn: text(form, "expiresOn"), note: text(form, "note"), idempotencyKey: text(form, "idempotencyKey") }, ctx.now, { demo: ctx.storeMode === "demo" })) };
        case "decide":
          return { ok: true, intent, ...(await decideGiftCard(db, actor, promotionsDataKey(), { approvalId: text(form, "approvalId"), decision: text(form, "decision"), note: text(form, "note") }, ctx.now)) };
        case "withdraw":
          return { ok: true, intent, ...(await withdrawGiftCardRequest(db, actor, { approvalId: text(form, "approvalId") }, ctx.now)) };
        case "redeem":
          return { ok: true, intent, ...(await redeemGiftCard(db, actor, { code: text(form, "code"), phone: text(form, "phone"), idempotencyKey: text(form, "idempotencyKey") }, ctx.now)) };
        case "expire":
          return { ok: true, intent, ...(await expireGiftCards(db, actor, ctx.now)) };
      }
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "gift.title");

export default function GiftCardsPage({ loaderData }: Route.ComponentProps) {
  const t = usePromotionsT();
  const f = useFormat();
  const { page, filters, dataKeyReady } = loaderData;
  const s = page.settlement;
  const columns: DataColumn<GiftCardRow>[] = [
    {
      key: "card",
      header: t("gift.col.card"),
      cell: (row) => (
        <Link to={`/admin/promotions/gift-cards/${row.id}`} className="adm-link">
          <bdi dir="ltr" className="nums">
            …{row.hint ?? "????"}
          </bdi>
        </Link>
      ),
    },
    { key: "status", header: t("gift.col.status"), cell: (row) => <span className="inline-flex items-center gap-1"><ToneStatus tone={GIFT_CARD_STATUS_TONE[row.status]}>{t(`gift.status.${row.status}`)}</ToneStatus><DemoNote show={row.isDemo} /></span> },
    { key: "amount", header: t("gift.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} /> },
    { key: "balance", header: t("gift.col.balance"), numeric: true, cell: (row) => <Money iqd={row.balanceIqd} /> },
    { key: "expires", header: t("gift.col.expires"), cell: (row) => (row.expiresAt ? <When at={row.expiresAt} style="date" /> : t("gift.noExpiry")) },
    { key: "issued", header: t("gift.col.issued"), cell: (row) => <span className="grid"><When at={row.createdAt} style="date" /><span className="type-caption text-ink-2">{row.createdBy ?? "—"}</span></span> },
    { key: "redeemed", header: t("gift.col.redeemed"), cell: (row) => (row.redeemedAt ? <span className="grid"><When at={row.redeemedAt} style="date" /><span className="type-caption text-ink-2">{row.redeemedBy ?? "—"}</span></span> : "—") },
    { key: "note", header: t("gift.col.note"), cell: (row) => <span className="line-clamp-2 type-caption">{row.note ?? "—"}</span> },
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "08.07" })}</p>
        <h1 className="adm-title">{t("gift.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("gift.lead")}</p>
      </header>
      <Boundary>{t("gift.boundary")}</Boundary>
      {!dataKeyReady ? (
        <div className="prm-block">
          <Notice tone="warn" icon="warning">
            {t("errors.data_key_missing")}
          </Notice>
        </div>
      ) : null}

      <Section id="prm-settlement" title={t("gift.settlement.title")} lead={t("gift.settlement.lead")}>
        <Kpis
          items={[
            { label: t("gift.settlement.issued"), value: <Money iqd={s.issued.iqd} />, note: t("gift.settlement.cards", { count: s.issued.count }) },
            { label: t("gift.settlement.outstanding"), value: <Money iqd={s.outstanding.iqd} />, note: t("gift.settlement.cards", { count: s.outstanding.count }) },
            { label: t("gift.settlement.redeemed"), value: <Money iqd={s.redeemed.iqd} />, note: t("gift.settlement.cards", { count: s.redeemed.count }) },
            { label: t("gift.settlement.expired"), value: <Money iqd={s.expired.iqd} />, note: t("gift.settlement.cards", { count: s.expired.count }) },
          ]}
        />
        <dl className="prm-ledger prm-panel">
          <div>
            <dt>{t("gift.settlement.wallet")}</dt>
            <dd>
              <Money iqd={s.walletCreditsIqd} />
            </dd>
          </div>
          <div>
            <dt>{t("gift.settlement.void")}</dt>
            <dd>
              <Money iqd={s.void.iqd} /> <span className="text-ink-2">({f.number(s.void.count)})</span>
            </dd>
          </div>
          <div>
            <dt>{t("gift.settlement.pending")}</dt>
            <dd>
              <Money iqd={s.pendingRequests.iqd} /> <span className="text-ink-2">({f.number(s.pendingRequests.count)})</span>
            </dd>
          </div>
        </dl>
        {s.balanced ? <Notice icon="check-circle">{t("gift.settlement.balanced")}</Notice> : <Notice tone="warn" icon="warning">{t("gift.settlement.mismatch", { cards: f.iqd(s.redeemed.iqd), wallet: f.iqd(s.walletCreditsIqd) })}</Notice>}
        {page.can.manage && s.expiredWaiting > 0 ? (
          <ConfirmAction intent="expire" label={t("gift.expire")} title={t("gift.expireQ")} consequence={t("gift.expireWhat", { count: s.expiredWaiting })} confirmLabel={t("gift.expire")} reason={false} icon="hourglass" doneKey="done.expired" />
        ) : null}
      </Section>

      <div className="prm-layout">
        <div className="prm-main">
          {page.pending.length ? (
            <Section id="prm-gift-pending" title={t("gift.pending.title")}>
              <ul className="prm-cards">
                {page.pending.map((request) => (
                  <li key={request.approvalId} className={request.canDecide ? "prm-card prm-panel--decide" : "prm-card"}>
                    <span className="prm-card__top">
                      <Money iqd={request.amountIqd} className="type-strong" />
                      <span className="type-caption text-ink-2">
                        {t("common.requestedBy", { name: request.requestedBy ?? "—" })} · <When at={request.requestedAt} />
                      </span>
                    </span>
                    {request.note ? <span className="type-body">{request.note}</span> : null}
                    <span className="type-caption text-ink-2">{request.expiresAt ? t("gift.expiresOn", { date: f.date(request.expiresAt) }) : t("gift.noExpiry")}</span>
                    {request.mine ? (
                      <span className="prm-actions">
                        <Notice>{t("common.yourRequest")}</Notice>
                        <ConfirmAction intent="withdraw" label={t("common.withdraw")} title={t("common.withdrawQ")} consequence={t("gift.pending.withdrawWhat")} confirmLabel={t("common.withdraw")} values={{ approvalId: request.approvalId }} reason={false} doneKey="done.withdrawn" />
                      </span>
                    ) : request.canDecide ? (
                      <DecideGift approvalId={request.approvalId} amountIqd={request.amountIqd} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          <Section id="prm-gift-list" title={t("gift.listTitle")}>
            <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
              {GIFT_CARD_VIEWS.map((view) => {
                const active = filters.view === view;
                return (
                  <Key key={view} as={Link} to={`/admin/promotions/gift-cards${giftCardSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                    {t(`gift.views.${view}`)} <bdi className="nums text-ink-2">{page.counts[view] ?? 0}</bdi>
                  </Key>
                );
              })}
            </nav>
            <Form method="get" action="/admin/promotions/gift-cards" className="flex flex-wrap items-end gap-2">
              {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
              <TextField name="q" label={t("gift.search")} hint={t("gift.searchHint")} defaultValue={filters.q} type="search" maxLength={40} className="min-w-[14rem] flex-1" />
              <Key type="submit" icon="magnifying-glass">
                {t("common.apply")}
              </Key>
            </Form>
            {page.rows.length === 0 ? (
              <EmptyState title={t("gift.empty")} text={page.can.issue ? t("gift.emptyHint") : t("gift.emptyHintRead")} icon="gift" />
            ) : (
              <>
                <div className="hidden md:block">
                  <DataTable caption={t("gift.listTitle")} columns={columns} rows={page.rows} rowKey={(row) => row.id} maxHeight={null} footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => giftCardSearch({ ...filters, page: n }) || "?"} />} />
                </div>
                <ul className="prm-cards md:hidden">
                  {page.rows.map((row) => (
                    <li key={row.id}>
                      <Link to={`/admin/promotions/gift-cards/${row.id}`} className="prm-card">
                        <span className="prm-card__top">
                          <bdi dir="ltr" className="nums type-strong">
                            …{row.hint ?? "????"}
                          </bdi>
                          <ToneStatus tone={GIFT_CARD_STATUS_TONE[row.status]}>{t(`gift.status.${row.status}`)}</ToneStatus>
                        </span>
                        <span className="prm-card__top">
                          <Money iqd={row.amountIqd} />
                          <span className="type-caption text-ink-2">{row.expiresAt ? t("gift.expiresOn", { date: f.date(row.expiresAt) }) : t("gift.noExpiry")}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>
        </div>
        <aside className="prm-side" aria-label={t("common.side")}>
          {page.can.issue ? <IssueForm disabled={!dataKeyReady} /> : null}
          {page.can.manage ? <RedeemForm /> : null}
          <Section id="prm-gift-rules" title={t("gift.rules.title")}>
            <Notice icon="seal-check">{t("gift.rules.second", { solo: f.iqd(GIFT_CARD.soloIqd), day: f.iqd(GIFT_CARD.soloDayIqd) })}</Notice>
            <Notice icon="lock">{t("gift.rules.codes")}</Notice>
            <Notice icon="wallet">{t("gift.rules.redeem")}</Notice>
          </Section>
        </aside>
      </div>
    </>
  );
}

/**
 * Issuing creates what the store owes: the form asks first (a confirm dialog with the amount and the expiry), then
 * sends the form with its idempotency key. Input the server would refuse is sent without asking, so its field errors
 * appear in place.
 */
function IssueForm({ disabled }: { disabled: boolean }) {
  const t = usePromotionsT();
  const f = useFormat();
  const [formKey, setFormKey] = useState(newKey);
  const [issued, setIssued] = useState<{ code: string; amountIqd: number } | null>(null);
  const [ask, setAsk] = useState<{ data: FormData; amountIqd: number; expiresAt: number | null } | null>(null);
  const { fetcher, pending, message, fields: errors } = useIntent(
    "issue",
    (result) => (result.status === "requested" ? "done.requested" : "done.issued"),
    (result) => {
      if (typeof result.code === "string") setIssued({ code: result.code, amountIqd: ask?.amountIqd ?? 0 });
      setAsk(null);
      setFormKey(newKey());
    },
  );
  return (
    <Section id="prm-issue" title={t("gift.issue.title")} lead={t("gift.issue.lead", { min: f.iqd(GIFT_CARD.minIqd), max: f.iqd(GIFT_CARD.maxIqd) })}>
      {issued ? <OnceCode code={issued.code} amountIqd={issued.amountIqd} /> : null}
      <ConfirmDialog
        open={ask !== null}
        onClose={() => setAsk(null)}
        title={t("gift.issue.q", { amount: f.iqd(ask?.amountIqd ?? 0) })}
        consequence={ask && ask.amountIqd > GIFT_CARD.soloIqd ? t("gift.issue.whatSecond", { solo: f.iqd(GIFT_CARD.soloIqd) }) : t("gift.issue.what", { day: f.iqd(GIFT_CARD.soloDayIqd) })}
        confirmLabel={t("gift.issue.save")}
        impact={ask ? [{ label: t("gift.issue.impactAmount"), value: `+${f.iqd(ask.amountIqd)}` }, { label: t("gift.issue.expires"), value: ask.expiresAt ? f.date(ask.expiresAt) : t("gift.noExpiry") }] : undefined}
        pending={pending}
        error={message}
        onConfirm={() => {
          if (ask) fetcher.submit(ask.data, { method: "post" });
        }}
      />
      <fetcher.Form
        method="post"
        className="prm-form"
        noValidate
        key={formKey}
        onSubmit={(event) => {
          const data = new FormData(event.currentTarget);
          const amountIqd = parseWhole(String(data.get("amountIqd") ?? ""));
          const expiresOn = String(data.get("expiresOn") ?? "").trim();
          const expiresAt = expiresOn ? endOfBaghdadDay(expiresOn) : null;
          // what the server refuses anyway goes straight to it, so the fields say what is wrong
          if (amountIqd === null || String(data.get("note") ?? "").trim().length < 3 || (expiresOn && expiresAt === null)) return;
          event.preventDefault();
          setAsk({ data, amountIqd, expiresAt });
        }}
      >
        <input type="hidden" name="intent" value="issue" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        <TextField name="amountIqd" label={t("gift.issue.amount")} hint={t("gift.issue.amountHint")} inputMode="numeric" required error={errors.amountIqd} />
        <TextField name="expiresOn" type="date" label={t("gift.issue.expires")} hint={t("gift.issue.expiresHint", { days: GIFT_CARD.maxValidDays })} error={errors.expiresOn} />
        <TextArea name="note" label={t("gift.issue.note")} hint={t("gift.issue.noteHint")} required rows={2} maxLength={300} error={errors.note} />
        <Failure message={message} />
        <div>
          <Key type="submit" loading={pending} disabled={disabled} icon="gift">
            {t("gift.issue.save")}
          </Key>
        </div>
      </fetcher.Form>
    </Section>
  );
}

function DecideGift({ approvalId, amountIqd }: { approvalId: string; amountIqd: number }) {
  const t = usePromotionsT();
  const f = useFormat();
  const [code, setCode] = useState<string | null>(null);
  return (
    <>
      {code ? <OnceCode code={code} amountIqd={amountIqd} /> : null}
      <span className="prm-actions">
        <ConfirmAction
          intent="decide"
          label={t("common.approve")}
          title={t("gift.pending.approveQ", { amount: f.iqd(amountIqd) })}
          consequence={t("gift.pending.approveWhat")}
          confirmLabel={t("gift.pending.approve")}
          values={{ approvalId, decision: "approve" }}
          impact={[{ label: t("gift.settlement.outstanding"), value: `+${f.iqd(amountIqd)}` }]}
          reasonField="note"
          reasonLabel={t("common.note")}
          tone="commit"
          icon="check-circle"
          doneKey="done.approved"
          onDone={(result) => {
            if (typeof result.code === "string") setCode(result.code);
          }}
        />
        <ConfirmAction intent="decide" label={t("common.reject")} title={t("coupons.pending.rejectQ")} consequence={t("gift.pending.rejectWhat")} confirmLabel={t("common.reject")} values={{ approvalId, decision: "reject" }} reasonField="note" tone="destructive" icon="x-circle" doneKey="done.rejected" />
      </span>
    </>
  );
}

type RedeemCheck = { amountIqd: number; hint: string | null; expiresAt: number | null; customer: { name: string | null; phone: { display: string; full: boolean } | null } };

/**
 * Redeeming moves money into a wallet: the card is checked first (its amount, whose wallet), then a confirm dialog
 * shows that impact, then the redemption is sent with the form's idempotency key (a double click is one redemption).
 */
function RedeemForm() {
  const t = usePromotionsT();
  const f = useFormat();
  const [formKey, setFormKey] = useState(newKey);
  const [values, setValues] = useState<{ code: string; phone: string } | null>(null);
  const [preview, setPreview] = useState<RedeemCheck | null>(null);
  const redeem = useIntent("redeem", "done.redeemed", () => {
    setPreview(null);
    setValues(null);
    setFormKey(newKey());
  });
  const check = useIntent("check", null, (result) => setPreview(result as unknown as RedeemCheck));
  const errors = { ...check.fields, ...redeem.fields };
  const done = redeem.data && typeof redeem.data.amountIqd === "number" ? redeem.data.amountIqd : null;
  return (
    <Section id="prm-redeem" title={t("gift.redeem.title")} lead={t("gift.redeem.lead")}>
      <check.fetcher.Form
        method="post"
        className="prm-form"
        noValidate
        key={formKey}
        onSubmit={(event) => {
          const form = new FormData(event.currentTarget);
          setValues({ code: String(form.get("code") ?? ""), phone: String(form.get("phone") ?? "") });
        }}
      >
        <input type="hidden" name="intent" value="check" />
        <TextField name="code" label={t("gift.redeem.code")} hint={t("gift.redeem.codeHint")} required ltr autoComplete="off" autoCapitalize="characters" error={errors.code} />
        <TextField name="phone" type="tel" label={t("gift.redeem.phone")} hint={t("gift.redeem.phoneHint")} required error={errors.phone} />
        <Failure message={check.message} />
        <div>
          <Key type="submit" loading={check.pending} icon="wallet">
            {t("gift.redeem.save")}
          </Key>
        </div>
      </check.fetcher.Form>
      <ConfirmDialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={t("gift.redeem.q", { amount: f.iqd(preview?.amountIqd ?? 0) })}
        consequence={t("gift.redeem.what")}
        confirmLabel={t("gift.redeem.confirm")}
        impact={
          preview
            ? [
                { label: t("gift.redeem.card"), value: `…${preview.hint ?? "????"}` },
                { label: t("gift.redeem.wallet"), value: [preview.customer.name ?? t("common.noName"), preview.customer.phone?.display].filter(Boolean).join(" · ") },
                { label: t("gift.redeem.amount"), value: `+${f.iqd(preview.amountIqd)}` },
              ]
            : undefined
        }
        pending={redeem.pending}
        error={redeem.message}
        onConfirm={() => {
          if (values) redeem.submit({ code: values.code, phone: values.phone, idempotencyKey: formKey });
        }}
      />
      {done !== null ? (
        <p className="type-body" aria-live="polite">
          {t("gift.redeem.done", { amount: f.iqd(done) })}
        </p>
      ) : null}
    </Section>
  );
}
