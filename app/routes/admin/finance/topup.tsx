import { useState } from "react";
import { Link, useActionData, useNavigation, useSubmit } from "react-router";

import type { Route } from "./+types/topup";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { decideTopup, getTopupReview } from "~/server/services/admin/finance/wallets.server";
import { parseAmount } from "~/server/services/admin/finance/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { TextField } from "~/ui/Field";
import { Glass } from "~/ui/Glass";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { CustomerName } from "../shell/CustomerName";
import { customerProfileId } from "../shell/access.server";
import { amount, failed, financeT, ok, openFinance, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { Code, DemoTag, Ledger, Money, Note, PageHead, Section, StateTag, useFinT, When } from "./ui";

/**
 * /admin/finance/wallets/topups/:topupId — one wallet top-up request, decided by a person (10.07, DESIGN.md §10 "mobile
 * approvals"): the transfer's photo at full width (a private file, only with payment_proof.read), what the customer
 * declared and what really arrived, re-used proof or reference warnings (staff only), the customer's wallet, and a
 * task bar: reject with a reason the customer reads, or approve — above the limit a second person confirms. The credit
 * goes through creditWallet (kind "topup", key "topup:<id>"): never twice.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, now } = await openFinance(context, "finance.wallet.read");
  const review = await orRespond(() => getTopupReview(db, actor, params.topupId, (id) => `/admin/finance/wallets/topups/${id}/proof`, now));
  // the name opens the customer's profile for staff who may open it (customers.customer.read), text otherwise
  return { review, customerProfileId: customerProfileId(actor, review.customerId) };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openFinance(context, "customers.wallet.adjust");
  const form = await request.formData();
  const decision = text(form, "decision") as "approve" | "reject" | "return";
  const t = financeT(req.locale);
  try {
    const result = await decideTopup(req.db, req.actor, { topupId: params.topupId, decision, amountIqd: decision === "approve" ? amount(form, "amountIqd") : undefined, note: text(form, "note") || undefined }, req.now);
    return ok({ intent: decision, status: result.status, message: t(`topup.done.${result.status}`) });
  } catch (error) {
    return failed(error, req.locale, decision);
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "topup.title");

export default function TopupReviewPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>() as { ok: boolean; message?: string; status?: string; fields?: Record<string, string> } | undefined;
  const { review } = loaderData;
  const declared = review.declaredAmountIqd ?? review.amountIqd;
  const [mode, setMode] = useState<"approve" | "reject" | "return" | null>(null);
  const [received, setReceived] = useState(String(review.firstApproval?.amountIqd ?? declared));
  const typed = parseAmount(received) ?? Number.NaN;
  const pending = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const error = actionData && !actionData.ok ? (actionData.message ?? Object.values(actionData.fields ?? {})[0] ?? null) : null;
  const decidable = review.status === "pending_verification";
  const finishing = review.status === "approved" && review.notCredited;
  const firstByMe = review.firstApproval?.byMe ?? false;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHead
        eyebrow={
          <Link to="/admin/finance/wallets" className="adm-link">
            {t("topup.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t("topup.title")} <Code>{review.ref}</Code>
            <DemoTag show={Boolean(review.customer?.isDemo)} />
          </span>
        }
        lead={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StateTag group="topup" value={review.status} label={t(`topupStatus.${review.status}`)} />
            {t(`method.${review.method}`)} · <CustomerName profileId={loaderData.customerProfileId}>{review.customer?.name ?? t("common.noName")}</CustomerName>
            {review.customer?.phone ? <bdi dir="ltr">{review.customer.phone.display}</bdi> : null}
          </span>
        }
      />

      {actionData?.ok ? (
        <Note icon="check-circle" tone="ok">
          <p>{actionData.message}</p>
        </Note>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start">
      {review.proofUrl ? (
        <a href={review.proofUrl} target="_blank" rel="noreferrer" className="block" aria-label={t("topup.openProof")}>
          <img src={review.proofUrl} alt={t("topup.proofAlt", { ref: review.ref })} width={1200} height={1600} className="fin-proof" />
        </a>
      ) : (
        <Note icon="lock" tone="warn">
          <p>{review.hasProof ? t("topup.noProofAccess") : t("topup.noProof")}</p>
        </Note>
      )}

      <div className="grid gap-4">
      <Section id="topup-amounts" title={t("topup.amounts")}>
        <Ledger
          className="adm-card"
          rows={[
            { label: t("topup.declared"), value: <Money iqd={declared} />, strong: true },
            { label: t("topup.reference"), value: review.reference ? <Code>{review.reference}</Code> : "—" },
            { label: t("topup.sentAt"), value: <When at={review.createdAt} /> },
            { label: t("topup.balance"), value: <Money iqd={review.balanceIqd} />, hint: t("topup.approvedBefore", { count: review.approvedBefore }) },
            ...(review.status !== "pending_verification" ? [{ label: t("topup.credited"), value: <Money iqd={review.amountIqd} /> }] : []),
          ]}
        />
        {review.flags.sameProof ? (
          <p className="adm-notice adm-notice--warn" role="alert">
            <Icon name="warning" size={18} />
            <span>{t("topup.sameProof", { count: review.flags.sameProof })}</span>
          </p>
        ) : null}
        {review.flags.sameReference ? (
          <p className="adm-notice adm-notice--warn" role="alert">
            <Icon name="warning" size={18} />
            <span>{t("topup.sameReference", { count: review.flags.sameReference })}</span>
          </p>
        ) : null}
        {review.firstApproval ? (
          <Note icon="users" tone={firstByMe ? "info" : "warn"}>
            <p>{t("topup.firstApproval", { name: review.firstApproval.by ?? "—", amount: f.iqd(review.firstApproval.amountIqd) })}</p>
            {review.firstApproval.note ? <p className="type-caption">{review.firstApproval.note}</p> : null}
            <p className="type-caption">{firstByMe ? t("topup.waitingSecond") : t("topup.youConfirm")}</p>
          </Note>
        ) : review.needsTwo && decidable ? (
          <Note icon="users">
            <p>{t("topup.needsTwo", { limit: f.iqd(review.threshold) })}</p>
            {review.soloApprovedIqd > 0 ? <p className="type-caption">{t("topup.soloSoFar", { amount: f.iqd(review.soloApprovedIqd) })}</p> : null}
          </Note>
        ) : null}
        {review.status === "rejected" && review.rejectReason ? (
          <Note icon="x-circle">
            <p>{t("topup.rejectedWith", { reason: review.rejectReason })}</p>
          </Note>
        ) : null}
        {review.verifiedBy ? (
          <p className="type-caption text-ink-2">
            {t("topup.decidedBy", { name: review.verifiedBy })} · <When at={review.verifiedAt} />
          </p>
        ) : null}
        {finishing ? (
          <Note tone="bad" icon="warning">
            <p>{t("topup.notCreditedNote")}</p>
          </Note>
        ) : null}
      </Section>

      {review.canDecide && (decidable || finishing) ? (
        // lint-design: allow glass-in-list — the sticky task bar follows the facts; it is not inside a list's map()
        <Glass className="fin-taskbar" edge="bottom" data-adm-sticky-end>
          {decidable ? (
            review.firstApproval && !firstByMe ? (
              <Key icon="arrow-counter-clockwise" onClick={() => setMode("return")}>
                {t("topup.return")}
              </Key>
            ) : null
          ) : null}
          {decidable ? (
            <Key icon="x" className="enabled:[--on:var(--red-ink)]" onClick={() => setMode("reject")}>
              {t("topup.reject")}
            </Key>
          ) : null}
          <Key variant="commit" icon="seal-check" disabled={firstByMe && decidable} onClick={() => setMode("approve")}>
            {finishing ? t("topups.finishCredit") : review.firstApproval && !firstByMe ? t("topup.confirm") : t("topup.approve")}
          </Key>
        </Glass>
      ) : !review.canDecide && decidable ? (
        <Note icon="lock">
          <p>{t("topup.cannotDecide")}</p>
        </Note>
      ) : null}
      </div>
      </div>

      {mode ? (
        <ConfirmDialog
          open
          onClose={() => setMode(null)}
          tone={mode === "approve" ? "commit" : "destructive"}
          title={t(`topup.${mode}Q`, { ref: review.ref })}
          consequence={mode === "approve" ? (!finishing && !review.firstApproval && typed > review.soloRoomIqd ? t("topup.approveFirstWhat") : t("topup.approveWhat")) : t(`topup.${mode}What`)}
          confirmLabel={mode === "approve" ? (finishing ? t("topups.finishCredit") : review.firstApproval ? t("topup.confirm") : t("topup.approve")) : t(`topup.${mode}`)}
          impact={
            mode === "approve"
              ? [
                  { label: t("topup.declared"), value: f.iqd(declared) },
                  { label: t("topup.received"), value: Number.isFinite(typed) ? f.iqd(typed) : "—" },
                  { label: t("topup.balanceAfter"), value: Number.isFinite(typed) ? f.iqd(review.balanceIqd + typed) : "—" },
                ]
              : undefined
          }
          reason={
            mode === "approve"
              ? typed !== declared && !review.firstApproval
                ? { label: t("topup.differenceNote"), hint: t("topup.differenceHint"), minLength: 3 }
                : { label: t("common.noteOptional"), noteRequired: false, minLength: 0 }
              : { label: mode === "reject" ? t("topup.rejectReason") : t("common.reason"), hint: mode === "reject" ? t("topup.rejectHint") : undefined, minLength: 3 }
          }
          pending={pending}
          error={error}
          onConfirm={({ reason }) => submit({ decision: mode, amountIqd: received, note: reason }, { method: "post" })}
        >
          {mode === "approve" && !finishing ? (
            <TextField
              label={t("topup.received")}
              hint={review.firstApproval ? t("topup.receivedLocked") : t("topup.receivedHint")}
              inputMode="numeric"
              value={received}
              readOnly={Boolean(review.firstApproval)}
              onChange={(event) => setReceived(event.target.value)}
              ltr
              end={<span className="type-caption">{t("common.iqd")}</span>}
            />
          ) : null}
          {mode === "approve" && Number.isFinite(typed) && typed !== declared ? <Status tone="warn">{t("topup.amountDiffers", { declared: f.iqd(declared), received: f.iqd(typed) })}</Status> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
