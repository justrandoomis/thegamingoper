import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { data, useFetcher, useNavigate, useRevalidator, useSearchParams } from "react-router";

import type { Route } from "./+types/wallet";
import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useLocalePath, useT } from "~/i18n/react";
import { newId } from "~/lib/ids";
import { CURRENCIES } from "~/lib/money";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { cancelWalletTopup, getTopupDestinations, listWalletTopups, requestWalletTopup, TOPUP_MAX_IQD, TOPUP_MIN_IQD } from "~/server/services/account/topups.server";
import type { TopupView } from "~/server/services/account/types";
import { listWalletEntries } from "~/server/services/wallet.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { FieldGroup, OptionCard, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { ShowMore } from "~/ui/Pagination";
import { iqdText } from "~/ui/PriceTag";
import { ProofUploader } from "~/ui/ProofUploader";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { WalletBalance } from "~/ui/WalletBalance";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { CopyKey, fieldError, FormFailure, Notice, rescueFocus, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { amount, grouped, HANDOFF, ltr } from "./components/text";
import { uploadTopupProof } from "./components/uploadProof";
import { usePagedList } from "./components/usePagedList";
import { useAccountData } from "./layout";

/**
 * The wallet (Design System v2 §4.24, §6.12): the balance on the wallet band — the ledger's sum (wallet.server) — with
 * top-ups under review on their own line and «اشحن الرصيد»; the ledger as flat rows; the top-up REQUESTS with their
 * status. The top-up itself is its own step (`?topup=1`, not a form under the balance): a Mastercard-card or Zain Cash
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
    return data({ ok: false as const, code: "invalid" }, { status: 400 });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data({ ...failure, intent: fields.intent ?? null }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, new URLSearchParams(args.location.search).get("topup") === "1" ? "topup" : "wallet");

const TOPUP_TONE: Record<TopupView["status"], StatusTone> = { pending_verification: "warn", approved: "ok", rejected: "bad", cancelled: "neutral" };

export default function Wallet({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const [params] = useSearchParams();
  const account = useAccountData();
  const ledger = usePagedList(loaderData.entries, (next: Awaited<ReturnType<typeof loader>>) => next.entries);
  const { destinations } = loaderData;
  const anyMethod = destinations.bankTransfer.enabled || destinations.zaincash.enabled;

  if (params.get("topup") === "1" && anyMethod) {
    return (
      <>
        <PageHead back={{ to: "/account/wallet", label: t("wallet.back"), order: sectionOrder("wallet") }} title={t("wallet.topupTitle")} lead={t("wallet.topupLead")} />
        <ol className="flex flex-wrap gap-x-6 gap-y-2" aria-label={t("wallet.topupTitle")}>
          {(["send", "upload", "check"] as const).map((step, index) => (
            <li key={step} className="flex items-center gap-2 type-sm-strong text-ink">
              <span className="grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] border-line-strong type-xs-strong nums" aria-hidden="true">
                {index + 1}
              </span>
              {t(`wallet.steps.${step}`)}
            </li>
          ))}
        </ol>
        <TopupForm destinations={destinations} limits={loaderData.limits} attempt={loaderData.attempt} />
      </>
    );
  }

  return (
    <>
      <PageHead title={t("wallet.title")} lead={t("wallet.lead")} />
      <WalletBalance
        balanceIqd={account?.wallet.balanceIqd ?? null}
        pendingIqd={account?.wallet.pendingIqd ?? 0}
        entries={ledger.items}
        headingLevel={2}
        topupHref={anyMethod ? "/account/wallet?topup=1" : undefined}
        footer={ledger.more ? <ShowMore shown={ledger.items.length} total={ledger.total} onMore={ledger.more} loading={ledger.loading} label={t("wallet.olderEntries")} /> : null}
      />
      {!anyMethod ? (
        <Notice>
          <p>{t("wallet.noMethods")}</p>
          <TextLink as={LocaleLink} to={HANDOFF} icon="chat-circle" arrow={false}>
            {t("common.talk")}
          </TextLink>
        </Notice>
      ) : null}
      <TopupList topups={loaderData.topups} />
    </>
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

      <Notice>{t("wallet.fraud")}</Notice>

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
    <Section id="topups" title={t("wallet.requestsTitle")}>
      {topups.length === 0 ? (
        <p className="type-sm text-ink-2">{t("wallet.requestsEmpty")}</p>
      ) : (
        <ul className="acct-rows">
          {topups.map((topup) => (
            <li key={topup.id} id={`topup-${topup.id}`} tabIndex={-1} className="acct-row flex-wrap items-start">
              <div className="acct-row__body">
                <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <bdi dir="ltr" className="acct-row__title nums">
                      {topup.ref}
                    </bdi>
                    <span className="acct-row__meta">{t(`methods.${topup.method}`)}</span>
                  </span>
                  <Status tone={TOPUP_TONE[topup.status]}>{t(`wallet.topupStatus.${topup.status}`)}</Status>
                </p>
                <p className="acct-row__meta">
                  {f.dateTime(topup.createdAt)}
                  {topup.declaredAmountIqd !== null ? <> · {t("wallet.declared", { amount: amount(iqdText(f, topup.declaredAmountIqd)) })}</> : null}
                </p>
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
