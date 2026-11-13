import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { data, useFetcher, useNavigate, useRevalidator, useSearchParams } from "react-router";

import type { Route } from "./+types/wallet";
import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useLocalePath, useT, type Formatters } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import { newId } from "~/lib/ids";
import { CURRENCIES } from "~/lib/money";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { checkOwnGiftCard, redeemOwnGiftCard } from "~/server/services/account/giftcards.server";
import { cancelWalletTopup, getTopupDestinations, listWalletTopups, requestWalletTopup, TOPUP_MAX_IQD, TOPUP_MIN_IQD } from "~/server/services/account/topups.server";
import type { TopupView } from "~/server/services/account/types";
import { listWalletEntries, type WalletEntryView } from "~/server/services/wallet.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { FieldGroup, OptionCard, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";
import { ShowMore } from "~/ui/Pagination";
import { Price } from "~/ui/Price";
import { iqdText, isIqd } from "~/ui/PriceTag";
import { ProofUploader } from "~/ui/ProofUploader";
import { type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { ActivityList, MetaLine, orderRefText, type ActivityItem } from "./components/Activity";
import { sectionOrder } from "./components/AccountNav";
import { CopyKey, fieldError, FormFailure, Notice, rescueFocus, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { MoneyCard } from "./components/MoneyCard";
import { StatusPill } from "./components/OrderBits";
import { PageHead, Section } from "./components/PageHead";
import { QuickTiles } from "./components/QuickTiles";
import { accountMeta } from "./components/meta";
import { signedText, walletLook } from "./components/rewards-view";
import { amount, grouped, HANDOFF, ltr } from "./components/text";
import { uploadTopupProof } from "./components/uploadProof";
import { usePagedList } from "./components/usePagedList";
import { useAccountData } from "./layout";

/**
 * The wallet (Design System v2 §4.24, §6.12; v2.1 — the client's reference card «محفظتي»): the balance on the glossy
 * money card — the ledger's sum (wallet.server) — with top-ups under review on its foot; quick tiles «اشحن الرصيد»
 * (only while a method is on) · «بطاقة هدية» · «طلبات الشحن»; the history as rows with the kind's disc and the signed
 * amount (+ green, − red), an order's row opening the order; the gift card; the top-up REQUESTS with their status in
 * a tinted pill. The top-up itself is its own step (`?topup=1`, not a form under the balance): a Mastercard-card or Zain Cash
 * transfer with its photo, pending until a staff member approves it in the admin. Nothing on this page credits the
 * wallet.
 */
export const handle = { nav: "push", order: sectionOrder("wallet") } satisfies MotionHandle;

const CURSOR = /^\d{1,16}:[A-Za-z0-9_.:-]{1,128}$/;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const cursor = new URL(request.url).searchParams.get("cursor");
  const [entries, topups, destinations] = await Promise.all([
    listWalletEntries(db, customer.id, { cursor: cursor && CURSOR.test(cursor) ? cursor : null, limit: 20 }),
    listWalletTopups(db, customer.id, 10),
    getTopupDestinations(db),
  ]);
  // One key per attempt: a retry of the same attempt replays it; the next page load starts a new one.
  return { entries, topups, destinations, limits: { min: TOPUP_MIN_IQD, max: TOPUP_MAX_IQD }, attempt: newId("tku") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireSignedIn(request, ctx, db);
  const fields = formFields(await request.formData());
  try {
    if (fields.intent === "topup") {
      const { topup } = await requestWalletTopup(db, actor, { method: fields.method, declaredAmountIqd: fields.declaredAmountIqd, reference: fields.reference, fileId: fields.fileId, idempotencyKey: fields.idempotencyKey }, ctx.now);
      return data({ ok: true as const, done: "topup" as const, ref: topup.ref });
    }
    if (fields.intent === "cancel") {
      await cancelWalletTopup(db, actor, fields.topupId ?? "", ctx.now);
      return data({ ok: true as const, done: "cancel" as const });
    }
    // a gift card into this wallet: checked first (its amount, nothing changes), then redeemed (module 08's batch)
    if (fields.intent === "gift_check") {
      const card = await checkOwnGiftCard(db, actor, { code: fields.code }, ctx.now);
      return data({ ok: true as const, done: "gift_check" as const, amountIqd: card.amountIqd, expiresAt: card.expiresAt, code: fields.code ?? "" });
    }
    if (fields.intent === "gift_redeem") {
      const done = await redeemOwnGiftCard(db, actor, { code: fields.code, idempotencyKey: fields.idempotencyKey }, ctx.now);
      return data({ ok: true as const, done: "gift_redeem" as const, amountIqd: done.amountIqd });
    }
    return data({ ok: false as const, code: "invalid" }, { status: 400 });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data({ ...failure, intent: fields.intent ?? null }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, new URLSearchParams(args.location.search).get("topup") === "1" ? "topup" : "wallet");

const TOPUP_TONE: Record<TopupView["status"], StatusTone> = { pending_verification: "warn", approved: "ok", rejected: "bad", cancelled: "neutral" };

export default function Wallet({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("account");
  const tShop = useT("ui-shop");
  const f = useFormat();
  const [params] = useSearchParams();
  const account = useAccountData();
  const ledger = usePagedList(loaderData.entries, (next: Awaited<ReturnType<typeof loader>>) => next.entries);
  const { destinations } = loaderData;
  const anyMethod = destinations.bankTransfer.enabled || destinations.zaincash.enabled;

  if (params.get("topup") === "1" && anyMethod) {
    return (
      <>
        <PageHead back={{ to: "/account/wallet", label: t("wallet.back"), order: sectionOrder("wallet") }} title={t("wallet.topupTitle")} lead={t("wallet.topupLead")} />
        <ol className="acct-tsteps" aria-label={t("wallet.topupTitle")}>
          {(["send", "upload", "check"] as const).map((step, index) => (
            <li key={step}>
              <span className="clay-disc nums" aria-hidden="true">
                {f.number(index + 1)}
              </span>
              {t(`wallet.steps.${step}`)}
            </li>
          ))}
        </ol>
        <TopupForm destinations={destinations} limits={loaderData.limits} attempt={loaderData.attempt} />
      </>
    );
  }

  const balance = account?.wallet.balanceIqd ?? null;
  const pending = account?.wallet.pendingIqd ?? 0;
  return (
    <>
      <PageHead title={t("wallet.title")} lead={t("wallet.lead")} />
      <div className="acct-hero glow glow--wide">
        <MoneyCard
          id="wallet-card"
          label={tShop("wallet.label")}
          icon="wallet"
          figure={balance !== null && isIqd(balance) ? <Price amountIqd={balance} size="xl" tone="onColor" approx="off" as="span" /> : <span className="type-sm-strong">{tShop("wallet.error")}</span>}
          foot={
            isIqd(pending) && pending > 0 ? (
              <>
                <Icon name="hourglass" size={18} />
                <span>{tShop("wallet.pending", { amount: amount(iqdText(f, pending)) })}</span>
              </>
            ) : null
          }
        />
        <QuickTiles
          label={t("wallet.actions.label")}
          tiles={[
            ...(anyMethod ? [{ key: "topup", icon: "plus" as const, label: t("wallet.actions.topup"), to: "/account/wallet?topup=1" }] : []),
            { key: "gift", icon: "gift", label: t("wallet.actions.gift"), href: "#gift-card" },
            { key: "requests", icon: "receipt", label: t("wallet.actions.requests"), href: "#topups" },
          ]}
        />
      </div>
      {!anyMethod ? (
        <Notice
          icon="chat-circle"
          action={
            <TextLink as={LocaleLink} to={HANDOFF}>
              {t("common.talk")}
            </TextLink>
          }
        >
          {t("wallet.noMethods")}
        </Notice>
      ) : null}
      <Section id="activity" anchor title={tShop("wallet.ledger")}>
        {ledger.items.length === 0 ? (
          <Note icon="wallet">{tShop("wallet.empty")}</Note>
        ) : (
          <div className="grid gap-3">
            <ActivityList items={ledger.items.map((entry) => walletItem(entry, t, tShop, f))} label={tShop("wallet.ledger")} />
            {ledger.more ? <ShowMore shown={ledger.items.length} total={ledger.total} onMore={ledger.more} loading={ledger.loading} label={t("wallet.olderEntries")} /> : null}
          </div>
        )}
      </Section>
      <GiftCardForm attempt={loaderData.attempt} posted={(actionData ?? null) as GiftAnswer | null} />
      <TopupList topups={loaderData.topups} />
    </>
  );
}

/** One wallet entry as a history row: the kind's disc, its words and date, the signed amount (+ green, − red). */
function walletItem(entry: WalletEntryView, t: TFunction, tShop: TFunction, f: Formatters): ActivityItem {
  const look = walletLook(entry);
  const signed = signedText(entry.amountIqd, f.number);
  return {
    id: entry.id,
    icon: look.icon,
    tone: look.tone,
    title: tShop(`wallet.kinds.${entry.kind}`),
    // when and for which order: whole parts of one line (never a dot left at a line's end), the date written as in the
    // points history and on the order cards
    meta: <MetaLine parts={[<time key="at" dateTime={new Date(entry.at).toISOString()}>{f.date(entry.at, "medium")}</time>, entry.orderRef ? orderRefText(t, entry.orderRef) : null]} />,
    amount: (
      <>
        <bdi dir="ltr">{signed.text}</bdi> <span className="acct-act__cur">{CURRENCIES.IQD.symbol[f.locale]}</span>
      </>
    ),
    sign: signed.sign,
    to: entry.orderRef ? `/account/orders/${entry.orderRef}` : undefined,
  };
}

/**
 * «بطاقة هدية» (module 08's gift cards, redeemed through its own guarded redemption — account/giftcards.server): the
 * code, «تحقق من البطاقة» (the amount, nothing changes), then a confirm dialog «أضف … إلى محفظتك؟» — once confirmed the
 * card's whole value is in the wallet (the balance above updates) and pays at checkout like any other balance.
 */
type GiftAnswer = ActionAnswer & { done?: string; amountIqd?: number; expiresAt?: number | null; code?: string; intent?: string | null };

function GiftCardForm({ attempt, posted }: { attempt: string; posted: GiftAnswer | null }) {
  const t = useT("account");
  const f = useFormat();
  const checker = useFetcher<typeof action>();
  const redeemer = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [code, setCode] = useState("");
  const [card, setCard] = useState<{ code: string; amountIqd: number; expiresAt: number | null } | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  // one redemption key per card: a double click replays the first answer, the next card gets its own
  const round = useRef(0);
  const handled = useRef<unknown>(null);
  const redeemed = useRef<unknown>(null);
  const checked = (checker.data ?? null) as GiftAnswer | null;
  const done = (redeemer.data ?? null) as GiftAnswer | null;

  useEffect(() => {
    if (checker.state !== "idle" || !checked || handled.current === checked) return;
    handled.current = checked;
    if (checked.ok && checked.done === "gift_check" && typeof checked.amountIqd === "number") {
      setRedeemError(null);
      setCard({ code: String(checked.code ?? code), amountIqd: checked.amountIqd, expiresAt: checked.expiresAt ?? null });
    }
  }, [checker.state, checked, code]);
  useEffect(() => {
    if (redeemer.state !== "idle" || !done || redeemed.current === done) return;
    redeemed.current = done;
    if (done.ok && done.done === "gift_redeem") {
      round.current += 1;
      setCard(null);
      setCode("");
      toast.success(t("gift.added", { amount: amount(iqdText(f, Number(done.amountIqd ?? 0))) }));
      // the balance on the band (the layout's figure) is read again
      void revalidator.revalidate();
    } else if (!done.ok) setRedeemError(done.message ?? t("common.errorText"));
  }, [redeemer.state, done, t, f, revalidator]);

  // Without script the forms post as documents: the page answers with the check (a plain confirm form) or the result.
  const postedCheck = posted?.ok && posted.done === "gift_check" && typeof posted.amountIqd === "number" ? posted : null;
  const postedFailure = posted && posted.ok === false && (posted.intent === "gift_check" || posted.intent === "gift_redeem") ? posted : null;
  const checkFailed = checked && checked.ok === false ? checked : postedFailure;
  return (
    <Section id="gift-card" anchor title={t("gift.title")} reason={t("gift.lead")}>
      {posted?.ok && posted.done === "gift_redeem" ? (
        <Notice tone="ok">
          <p>{t("gift.added", { amount: amount(iqdText(f, Number(posted.amountIqd ?? 0))) })}</p>
        </Notice>
      ) : null}
      {postedCheck ? (
        <form method="post" className="acct-card acct-narrow">
          <input type="hidden" name="intent" value="gift_redeem" />
          <input type="hidden" name="code" value={String(postedCheck.code ?? "")} />
          <input type="hidden" name="idempotencyKey" value={`${attempt}-gift`} />
          <p className="type-body-strong text-ink">{t("gift.confirmQ", { amount: amount(iqdText(f, postedCheck.amountIqd ?? 0)) })}</p>
          <p className="type-sm text-ink-2">{t("gift.confirmWhat")}</p>
          <Key type="submit" variant="primary" icon="gift" className="justify-self-start">
            {t("gift.confirm")}
          </Key>
        </form>
      ) : null}
      <checker.Form method="post" className="acct-card acct-narrow" noValidate>
        <input type="hidden" name="intent" value="gift_check" />
        <FormFailure answer={checkFailed && !checkFailed.fields ? checkFailed : null} />
        <TextField
          id="gift-code"
          name="code"
          ltr
          autoComplete="off"
          maxLength={40}
          label={t("gift.code")}
          hint={t("gift.codeHint")}
          required
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
          error={fieldError(checkFailed, "code")}
        />
        <SubmitKey pending={checker.state !== "idle"} icon="gift">
          {t("gift.check")}
        </SubmitKey>
      </checker.Form>
      <ConfirmDialog
        open={card !== null}
        onClose={() => setCard(null)}
        title={t("gift.confirmQ", { amount: amount(iqdText(f, card?.amountIqd ?? 0)) })}
        consequence={[t("gift.confirmWhat"), card?.expiresAt ? t("gift.expires", { date: f.date(card.expiresAt, "long") }) : null].filter(Boolean).join(" ")}
        confirmLabel={t("gift.confirm")}
        cancelLabel={t("common.cancel")}
        pending={redeemer.state !== "idle"}
        error={redeemError ?? undefined}
        onConfirm={() => {
          if (!card) return;
          setRedeemError(null);
          redeemer.submit({ intent: "gift_redeem", code: card.code, idempotencyKey: `${attempt}-gift${round.current}` }, { method: "post" });
        }}
      />
    </Section>
  );
}

type Destinations = Awaited<ReturnType<typeof loader>>["destinations"];

function TopupForm({ destinations, limits, attempt }: { destinations: Destinations; limits: { min: number; max: number }; attempt: string }) {
  const t = useT("account");
  const f = useFormat();
  const href = useLocalePath();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const methods = useMemo(
    () => [
      { value: "bank_transfer" as const, enabled: destinations.bankTransfer.enabled, label: t("wallet.bank"), hint: t("wallet.bankHint") },
      { value: "zaincash" as const, enabled: destinations.zaincash.enabled, label: t("wallet.zain"), hint: t("wallet.zainHint") },
    ],
    [destinations, t],
  );
  const firstEnabled = methods.find((method) => method.enabled)?.value ?? null;
  const [method, setMethod] = useState(firstEnabled);
  const [fileId, setFileId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const handled = useRef<unknown>(null);
  const answer = (fetcher.data ?? null) as (ActionAnswer & { intent?: string | null; done?: string; ref?: string }) | null;
  const failed = answer && answer.ok === false && answer.intent === "topup" ? answer : null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok && answer.done === "topup") {
      toast.success(t("wallet.sent", { ref: ltr(String(answer.ref ?? "")) }));
      // Back to the wallet: the new request is listed there, «بانتظار التحقق».
      navigate(href("/account/wallet"), { replace: true, preventScrollReset: false });
    }
  }, [fetcher.state, answer, t, navigate, href]);

  const rows =
    method === "bank_transfer"
      ? [
          { label: t("wallet.account"), value: destinations.bankTransfer.accountNumber, code: true },
          { label: t("wallet.recipient"), value: destinations.bankTransfer.recipientName, code: false },
        ]
      : [{ label: t("wallet.zainNumber"), value: destinations.zaincash.number, code: true }];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (uploading) {
      event.preventDefault();
      setMissing(t("wallet.proofUploading"));
    } else if (!fileId) {
      event.preventDefault();
      setMissing(t("wallet.proofMissing"));
      document.getElementById("topup-proof")?.focus();
    } else setMissing(null);
  };

  const proofError = missing ?? fieldError(failed, "fileId");

  return (
    <fetcher.Form method="post" className="acct-card acct-narrow" noValidate onSubmit={submit}>
      <input type="hidden" name="intent" value="topup" />
      <input type="hidden" name="idempotencyKey" value={attempt} />
      <input type="hidden" name="fileId" value={fileId ?? ""} />
      <FormFailure
        answer={failed}
        fields={[
          { name: "method", id: "topup-method", label: t("wallet.method") },
          { name: "declaredAmountIqd", id: "topup-amount", label: t("wallet.amount") },
          { name: "reference", id: "topup-reference", label: t("wallet.reference") },
          { name: "fileId", id: "topup-proof", label: t("wallet.proof") },
        ]}
      />
      <FieldGroup legend={t("wallet.method")} required error={fieldError(failed, "method")}>
        {methods.map((option, index) => (
          <OptionCard
            key={option.value}
            id={index === 0 ? "topup-method" : undefined}
            name="method"
            value={option.value}
            checked={method === option.value}
            disabled={!option.enabled}
            onChange={() => setMethod(option.value)}
            label={option.label}
            hint={option.enabled ? option.hint : t("wallet.methodOff")}
          />
        ))}
      </FieldGroup>

      <section aria-labelledby="topup-send-title" className="grid gap-1">
        <h2 id="topup-send-title" className="type-sm-strong text-ink">
          {t("wallet.sendTo")}
        </h2>
        <div className="grid rounded-sm border border-line px-4">
          {rows.map((row) => (
            <div key={row.label} className="acct-copy">
              <div className="grid min-w-0 gap-0.5">
                <span className="acct-copy__label">{row.label}</span>
                {row.code ? (
                  <bdi dir="ltr" className="type-code text-ink">
                    {grouped(row.value)}
                  </bdi>
                ) : (
                  <span className="type-sm-strong text-ink">{row.value}</span>
                )}
              </div>
              <CopyKey value={row.value} label={t("wallet.copyField", { field: row.label })} />
            </div>
          ))}
        </div>
      </section>

      <Notice flat>{t("wallet.fraud")}</Notice>

      <TextField
        id="topup-amount"
        name="declaredAmountIqd"
        inputMode="numeric"
        autoComplete="off"
        label={t("wallet.amount")}
        hint={t("wallet.amountHint", { min: amount(iqdText(f, limits.min)), max: amount(iqdText(f, limits.max)) })}
        required
        end={<span className="type-sm text-ink-2">{CURRENCIES.IQD.symbol[f.locale]}</span>}
        error={fieldError(failed, "declaredAmountIqd")}
      />
      <TextField id="topup-reference" name="reference" ltr autoComplete="off" label={t("wallet.reference")} hint={t("wallet.referenceHint")} optional error={fieldError(failed, "reference")} />

      <div className="field" data-invalid={proofError ? "" : undefined}>
        <span className="field__label" id="topup-proof-label">
          {t("wallet.proof")}
          <span className="field__mark" aria-hidden="true">
            {" *"}
          </span>
        </span>
        <div id="topup-proof" tabIndex={-1} aria-labelledby="topup-proof-label" className="outline-none">
          <ProofUploader
            onUpload={async (file, controls) => {
              setUploading(true);
              setMissing(null);
              const result = await uploadTopupProof(href("/account/wallet/proof"), file, controls);
              setUploading(false);
              if (result.ok) {
                setFileId(result.fileId);
                return { ok: true, previewUrl: result.previewUrl };
              }
              setFileId(null);
              return { ok: false, code: result.code };
            }}
          />
        </div>
        <p className="field__error" aria-live="polite">
          {proofError ? (
            <>
              <Icon name="warning-circle" size={16} />
              <span>{proofError}</span>
            </>
          ) : null}
        </p>
      </div>

      <SubmitKey variant="primary" pending={fetcher.state !== "idle"} icon="paper-plane-tilt">
        {t("wallet.submit")}
      </SubmitKey>
    </fetcher.Form>
  );
}

function TopupList({ topups }: { topups: TopupView[] }) {
  const t = useT("account");
  const online = useOnline();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const [cancelling, setCancelling] = useState<TopupView | null>(null);
  const handled = useRef<unknown>(null);
  const cancelled = useRef<string | null>(null);
  const revalidator = useRevalidator();
  const answer = (fetcher.data ?? null) as (ActionAnswer & { intent?: string | null; done?: string }) | null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok && answer.done === "cancel") {
      setCancelling(null);
      toast.success(t("wallet.cancelled"));
      // Its «ألغِ الطلب» key is gone with the dialog: focus lands on the request, which now says «ألغيته».
      if (cancelled.current) rescueFocus(`topup-${cancelled.current}`);
    } else if (!answer.ok) {
      // A refusal (staff approved it meanwhile, another tab cancelled it) means the list is out of date: the dialog
      // says why, and the list behind it is read again — a refused answer does not revalidate by itself.
      void revalidator.revalidate();
    }
  }, [fetcher.state, answer, t, revalidator]);

  const error = answer && answer.ok === false && answer.intent === "cancel" ? answer.message : undefined;

  return (
    <Section id="topups" anchor title={t("wallet.requestsTitle")}>
      {topups.length === 0 ? (
        <p className="type-read text-ink-2">{t("wallet.requestsEmpty")}</p>
      ) : (
        <ul className="acct-rows">
          {topups.map((topup) => (
            <li key={topup.id} id={`topup-${topup.id}`} tabIndex={-1} className="acct-row items-start">
              <span className="clay-disc" aria-hidden="true">
                <Icon name={topup.method === "zaincash" ? "device-mobile" : "credit-card"} size={20} />
              </span>
              <div className="acct-row__body">
                <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <bdi dir="ltr" className="acct-row__title nums">
                      {topup.ref}
                    </bdi>
                    <span className="acct-row__meta">{t(`methods.${topup.method}`)}</span>
                  </span>
                  <StatusPill tone={TOPUP_TONE[topup.status]}>{t(`wallet.topupStatus.${topup.status}`)}</StatusPill>
                </p>
                {/* one idea per line: when it was sent, then what was declared */}
                <p className="acct-row__meta">{f.dateTime(topup.createdAt)}</p>
                {topup.declaredAmountIqd !== null ? <p className="acct-row__meta">{t("wallet.declared", { amount: amount(iqdText(f, topup.declaredAmountIqd)) })}</p> : null}
                {topup.status === "approved" ? <p className="type-xs-strong text-ok">{t("wallet.credited", { amount: amount(iqdText(f, topup.amountIqd)) })}</p> : null}
                {topup.rejectReason ? <p className="type-xs-strong text-danger">{t("wallet.reason", { reason: topup.rejectReason })}</p> : null}
                {topup.proofPath || topup.status === "pending_verification" ? (
                  <div className="flex flex-wrap items-center gap-x-5 pt-1">
                    {topup.proofPath ? (
                      <TextLink as="a" href={topup.proofPath} external>
                        {t("wallet.viewProof")}
                      </TextLink>
                    ) : null}
                    {topup.status === "pending_verification" ? (
                      <Key size="sm" variant="ghost" icon="x-circle" aria-haspopup="dialog" disabled={!online} aria-label={t("wallet.cancelNamed", { ref: topup.ref })} onClick={() => setCancelling(topup)}>
                        {t("wallet.cancel")}
                      </Key>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => {
          // After a refusal the list may have lost the key that opened the dialog: focus then lands on the request.
          if (cancelling) rescueFocus(`topup-${cancelling.id}`);
          setCancelling(null);
        }}
        tone="destructive"
        title={t("wallet.cancelQ", { ref: ltr(cancelling?.ref ?? "") })}
        consequence={t("wallet.cancelWhat")}
        confirmLabel={t("wallet.cancel")}
        cancelLabel={t("common.cancel")}
        pending={fetcher.state !== "idle"}
        error={error}
        onConfirm={() => {
          if (!cancelling) return;
          cancelled.current = cancelling.id;
          fetcher.submit({ intent: "cancel", topupId: cancelling.id }, { method: "post" });
        }}
      />
    </Section>
  );
}
