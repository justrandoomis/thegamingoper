import { useEffect, useMemo, useRef, useState } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/wallet";
import { Icon } from "~/art/Icon";
import { useFormat, useLocalePath, useT } from "~/i18n/react";
import { newId } from "~/lib/ids";
import { CURRENCIES } from "~/lib/money";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { cancelWalletTopup, getTopupDestinations, listWalletTopups, requestWalletTopup, TOPUP_MAX_IQD, TOPUP_MIN_IQD } from "~/server/services/account/topups.server";
import type { TopupView } from "~/server/services/account/types";
import { listWalletEntries } from "~/server/services/wallet.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { FieldGroup, Radio, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ShowMore } from "~/ui/Pagination";
import { iqdText } from "~/ui/PriceTag";
import { ProofUploader } from "~/ui/ProofUploader";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { WalletBalance } from "~/ui/WalletBalance";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { AnswerNotice, CopyKey, fieldError, FormNotice, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { amount, ltr } from "./components/text";
import { uploadTopupProof } from "./components/uploadProof";
import { usePagedList } from "./components/usePagedList";
import { useAccountData } from "./layout";

/**
 * The wallet (brief §4 B, DESIGN §9.19): the balance is the ledger's sum (wallet.server), the ledger itself, and
 * top-up REQUESTS — a bank-card or Zain Cash transfer with its photo, pending until an employee approves it in the
 * admin. Nothing on this page credits the wallet.
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

export const meta: Route.MetaFunction = (args) => accountMeta(args, "wallet");

const TOPUP_TONE: Record<TopupView["status"], StatusTone> = { pending_verification: "warn", approved: "ok", rejected: "bad", cancelled: "neutral" };

export default function Wallet({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const account = useAccountData();
  const ledger = usePagedList(loaderData.entries, (next: Awaited<ReturnType<typeof loader>>) => next.entries);
  const balance = account?.wallet.balanceIqd ?? null;
  const pending = account?.wallet.pendingIqd ?? 0;

  return (
    <>
      <PageHead title={t("wallet.title")} lead={t("wallet.lead")} />
      <WalletBalance
        balanceIqd={balance}
        pendingIqd={pending}
        entries={ledger.items}
        headingLevel={2}
        footer={ledger.more ? <ShowMore shown={ledger.items.length} total={ledger.total} onMore={ledger.more} loading={ledger.loading} label={t("wallet.olderEntries")} /> : null}
      />
      <TopupForm destinations={loaderData.destinations} limits={loaderData.limits} attempt={loaderData.attempt} />
      <TopupList topups={loaderData.topups} />
    </>
  );
}

type Destinations = Awaited<ReturnType<typeof loader>>["destinations"];

function TopupForm({ destinations, limits, attempt }: { destinations: Destinations; limits: { min: number; max: number }; attempt: string }) {
  const t = useT("account");
  const f = useFormat();
  const href = useLocalePath();
  const fetcher = useFetcher<typeof action>();
  const methods = useMemo(
    () => [
      { value: "bank_transfer" as const, enabled: destinations.bankTransfer.enabled },
      { value: "zaincash" as const, enabled: destinations.zaincash.enabled },
    ],
    [destinations],
  );
  const firstEnabled = methods.find((method) => method.enabled)?.value ?? null;
  const [method, setMethod] = useState(firstEnabled);
  const [fileId, setFileId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const handled = useRef<unknown>(null);
  const answer = (fetcher.data ?? null) as (ActionAnswer & { intent?: string | null; done?: string; ref?: string }) | null;
  const failed = answer && answer.ok === false && answer.intent === "topup" ? answer : null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok && answer.done === "topup") {
      toast.success(t("wallet.sent", { ref: ltr(String(answer.ref ?? "")) }));
      setFileId(null);
      setRound((value) => value + 1);
    }
  }, [fetcher.state, answer, t]);

  if (!firstEnabled) {
    return (
      <Section id="topup" title={t("wallet.topupTitle")}>
        <FormNotice tone="info">{t("wallet.noMethods")}</FormNotice>
      </Section>
    );
  }

  const destination =
    method === "bank_transfer" ? (
      <dl className="grid gap-2">
        <DestinationRow label={t("wallet.account")} value={destinations.bankTransfer.accountNumber} copyLabel={t("wallet.copyField", { field: t("wallet.account") })} ltrValue />
        <DestinationRow label={t("wallet.recipient")} value={destinations.bankTransfer.recipientName} copyLabel={t("wallet.copyField", { field: t("wallet.recipient") })} />
      </dl>
    ) : (
      <dl className="grid gap-2">
        <DestinationRow label={t("wallet.zainNumber")} value={destinations.zaincash.number} copyLabel={t("wallet.copyField", { field: t("wallet.zainNumber") })} ltrValue />
      </dl>
    );

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    if (uploading) {
      event.preventDefault();
      setMissing(t("wallet.proofUploading"));
    } else if (!fileId) {
      event.preventDefault();
      setMissing(t("wallet.proofMissing"));
    } else setMissing(null);
  };

  return (
    <Section id="topup" title={t("wallet.topupTitle")}>
      <p className="max-w-[62ch] type-body text-ink-2">{t("wallet.topupLead")}</p>
      <fetcher.Form key={round} method="post" className="grid gap-5 rounded-lg bg-paper p-4 sm:p-6" noValidate onSubmit={submit}>
        <input type="hidden" name="intent" value="topup" />
        <input type="hidden" name="idempotencyKey" value={attempt} />
        <input type="hidden" name="fileId" value={fileId ?? ""} />
        {failed && failed.code !== "invalid" ? <AnswerNotice answer={failed} /> : null}
        <FieldGroup legend={t("wallet.method")} required error={fieldError(failed, "method")}>
          {methods.map((option) => (
            <Radio
              key={option.value}
              row
              name="method"
              value={option.value}
              checked={method === option.value}
              disabled={!option.enabled}
              onChange={() => setMethod(option.value)}
              label={option.value === "bank_transfer" ? t("wallet.bank") : t("wallet.zain")}
              hint={option.enabled ? undefined : t("wallet.methodOff")}
            />
          ))}
        </FieldGroup>
        <div className="grid gap-3 rounded-md bg-niche p-4">{destination}</div>
        <p className="flex items-start gap-2 type-caption text-ink-2">
          <Icon name="shield-check" size={18} className="mt-0.5 shrink-0 text-info" />
          <span>{t("wallet.fraud")}</span>
        </p>
        <TextField
          name="declaredAmountIqd"
          inputMode="numeric"
          autoComplete="off"
          label={t("wallet.amount")}
          hint={t("wallet.amountHint", { min: amount(iqdText(f, limits.min)), max: amount(iqdText(f, limits.max)) })}
          required
          end={<span className="type-caption text-ink-2">{CURRENCIES.IQD.symbol[f.locale]}</span>}
          error={fieldError(failed, "declaredAmountIqd")}
        />
        <TextField name="reference" ltr autoComplete="off" label={t("wallet.reference")} hint={t("wallet.referenceHint")} optional error={fieldError(failed, "reference")} />
        <div className="grid gap-2">
          <span className="field__label">
            {t("wallet.proof")}
            <span className="field__mark" aria-hidden="true">
              {" *"}
            </span>
          </span>
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
          {missing || fieldError(failed, "fileId") ? (
            <p className="flex items-start gap-1.5 type-caption font-medium text-red-ink" role="alert">
              <Icon name="warning-circle" size={16} className="mt-0.5 shrink-0" />
              {missing ?? fieldError(failed, "fileId")}
            </p>
          ) : null}
        </div>
        <SubmitKey pending={fetcher.state !== "idle"} icon="paper-plane-tilt" className="justify-self-start">
          {t("wallet.submit")}
        </SubmitKey>
      </fetcher.Form>
    </Section>
  );
}

function DestinationRow({ label, value, copyLabel, ltrValue = false }: { label: string; value: string; copyLabel: string; ltrValue?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="grid min-w-0">
        <dt className="type-caption text-ink-2">{label}</dt>
        <dd className="type-sub text-ink">
          {ltrValue ? (
            <bdi dir="ltr" className="nums">
              {value}
            </bdi>
          ) : (
            value
          )}
        </dd>
      </div>
      <CopyKey value={value} label={copyLabel} />
    </div>
  );
}

function TopupList({ topups }: { topups: TopupView[] }) {
  const t = useT("account");
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const [cancelling, setCancelling] = useState<TopupView | null>(null);
  const handled = useRef<unknown>(null);
  const answer = (fetcher.data ?? null) as (ActionAnswer & { intent?: string | null; done?: string }) | null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok && answer.done === "cancel") {
      setCancelling(null);
      toast.success(t("wallet.cancelled"));
    }
  }, [fetcher.state, answer, t]);

  const error = answer && answer.ok === false && answer.intent === "cancel" ? answer.message : undefined;

  return (
    <Section id="topups" title={t("wallet.requestsTitle")}>
      {topups.length === 0 ? (
        <p className="rounded-lg bg-niche p-4 type-body text-ink-2">{t("wallet.requestsEmpty")}</p>
      ) : (
        <ul className="grid gap-2">
          {topups.map((topup) => (
            <li key={topup.id} className="grid gap-2 rounded-lg bg-paper p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <div className="grid min-w-0 gap-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 type-label text-ink">
                  <bdi dir="ltr" className="nums">
                    {topup.ref}
                  </bdi>
                  <span aria-hidden="true">·</span>
                  <span>{t(`methods.${topup.method}`)}</span>
                </p>
                <p className="type-caption text-ink-2">
                  {f.dateTime(topup.createdAt)}
                  {topup.declaredAmountIqd !== null ? <> · {t("wallet.declared", { amount: amount(iqdText(f, topup.declaredAmountIqd)) })}</> : null}
                </p>
                <Status tone={TOPUP_TONE[topup.status]}>{t(`wallet.topupStatus.${topup.status}`)}</Status>
                {topup.status === "approved" ? <p className="type-caption text-ink-2">{t("wallet.credited", { amount: amount(iqdText(f, topup.amountIqd)) })}</p> : null}
                {topup.rejectReason ? <p className="type-caption text-red-ink">{t("wallet.reason", { reason: topup.rejectReason })}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {topup.proofPath ? (
                  <TextLink as="a" href={topup.proofPath} external>
                    {t("wallet.viewProof")}
                  </TextLink>
                ) : null}
                {topup.status === "pending_verification" ? (
                  <Key size="sm" variant="quiet" icon="x-circle" onClick={() => setCancelling(topup)}>
                    {t("wallet.cancel")}
                  </Key>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        tone="destructive"
        title={t("wallet.cancelQ", { ref: ltr(cancelling?.ref ?? "") })}
        consequence={t("wallet.cancelWhat")}
        confirmLabel={t("wallet.cancel")}
        cancelLabel={t("common.cancel")}
        pending={fetcher.state !== "idle"}
        error={error}
        onConfirm={() => {
          if (cancelling) fetcher.submit({ intent: "cancel", topupId: cancelling.id }, { method: "post" });
        }}
      />
    </Section>
  );
}
