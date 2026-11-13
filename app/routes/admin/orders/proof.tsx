import { useState } from "react";
import { data, Link, redirect, useActionData, useNavigation, useSubmit } from "react-router";

import type { Route } from "./+types/proof";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { verifyProof } from "~/server/services/admin/orders/actions.server";
import { getProofReview } from "~/server/services/admin/orders/queues.server";
import { parseIqd } from "~/server/services/admin/orders/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { TextField } from "~/ui/Field";
import { Glass } from "~/ui/Glass";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ordersMeta } from "./meta";
import { CustomerName } from "../shell/CustomerName";
import { amountOf, failure, text, urls } from "./common.server";
import { DemoNote, Facts, Money, PhoneText, Ref, useOrdersT, When } from "./ui";

/**
 * /admin/orders/proofs/:paymentId — one transfer proof, decided by a person (DESIGN.md §10 "mobile approvals"): the
 * picture at full width (only with payment_proof.read — it is a private file, served by its own route), what the
 * shopper declared against what is due and what arrived, the duplicate warning (staff only), and a task bar with
 * "reject with the reason" and "approve". verifyPayment refuses an amount that differs unless the verifier holds
 * orders.payment.override and writes why.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.payment.verify");
  try {
    return { review: await getProofReview(db, actor, params.paymentId, urls.proofImage) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.payment.verify");
  const form = await request.formData();
  try {
    const approve = text(form, "approve") === "1";
    await verifyProof(db, actor, params.paymentId, { approve, receivedAmountIqd: approve ? amountOf(form, "receivedAmountIqd") : undefined, note: text(form, "note") || undefined }, ctx.now);
    return redirect(`/admin/orders/proofs?done=${encodeURIComponent(text(form, "ref"))}`);
  } catch (error) {
    const result = failure(error, ctx.locale, "verify");
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "proofs.title");

export default function ProofReviewPage({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const f = useFormat();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const { review } = loaderData;
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const proof = review.current;
  const [received, setReceived] = useState(String(proof?.declaredAmountIqd ?? review.dueIqd));
  const typed = parseIqd(received) ?? Number.NaN;
  const differs = proof !== null && (proof.declaredAmountIqd !== review.dueIqd || typed !== review.dueIqd);
  const pending = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const error = actionData && !actionData.ok ? (actionData.message ?? t(`errors.${actionData.code}`)) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/orders/proofs" className="adm-link">
            {t("proofs.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-2">
          {t("proofs.reviewTitle")} <Ref value={review.order.ref} />
          <DemoNote show={review.order.isDemo} />
        </h1>
        <p className="type-body text-ink-2">
          {t(`method.${review.method}`)} · <PhoneText phone={review.order.phone} /> · <CustomerName profileId={review.order.customerProfileId}>{review.order.contactName ?? t("list.noName")}</CustomerName>
        </p>
      </header>

      {!proof ? (
        <p className="adm-notice" role="status">
          <Icon name="info" size={18} />
          <span>{t("proofs.nothingWaiting", { status: t(`paymentRow.${review.status}`) })}</span>
        </p>
      ) : (
        <>
          {proof.imageUrl ? (
            <a href={proof.imageUrl} target="_blank" rel="noreferrer" className="block" aria-label={t("proof.openFull")}>
              <img src={proof.imageUrl} alt={t("proof.alt", { ref: review.order.ref })} width={1200} height={1600} className="ord-proof" />
            </a>
          ) : (
            <p className="adm-notice adm-notice--warn" role="note">
              <Icon name="lock" size={18} />
              <span>{t("proof.noImageAccess")}</span>
            </p>
          )}

          <section className="adm-section mt-4" aria-labelledby="proof-amounts">
            <h2 id="proof-amounts" className="adm-h2">
              {t("proofs.amounts")}
            </h2>
            <dl className="ord-ledger adm-card">
              <div>
                <dt>{t("proof.due")}</dt>
                <dd className="type-strong">
                  <Money iqd={review.dueIqd} />
                </dd>
              </div>
              <div>
                <dt>{t("proof.declared")}</dt>
                <dd className="type-strong">
                  <Money iqd={proof.declaredAmountIqd} />
                </dd>
              </div>
            </dl>
            {proof.declaredAmountIqd === review.dueIqd ? <Status tone="ok">{t("proof.matches")}</Status> : <Status tone="warn">{t("proof.mismatchAmounts", { declared: f.iqd(proof.declaredAmountIqd), due: f.iqd(review.dueIqd) })}</Status>}
            {proof.duplicateOf ? (
              <p className="adm-notice adm-notice--warn" role="alert">
                <Icon name="warning" size={18} />
                <span>
                  {t("proof.duplicate")}{" "}
                  {proof.duplicateOf.orderRef ? (
                    <Link to={`/admin/orders/${proof.duplicateOf.orderRef}`} className="adm-link">
                      <Ref value={proof.duplicateOf.orderRef} />
                    </Link>
                  ) : null}
                </span>
              </p>
            ) : null}
            {review.order.onHold ? (
              <p className="adm-notice adm-notice--bad" role="alert">
                <Icon name="lock" size={18} />
                <span>{t("errors.order_on_hold")}</span>
              </p>
            ) : null}
            <Facts
              rows={[
                { label: t("proof.submittedAt"), value: <When at={proof.createdAt} /> },
                { label: t("detail.reference"), value: <bdi dir="ltr">{proof.reference}</bdi>, hidden: !proof.reference },
                { label: t("proof.shopperNote"), value: proof.note, hidden: !proof.note },
                { label: t("detail.total"), value: <Money iqd={review.order.totalIqd} /> },
              ]}
            />
          </section>

          {review.history.length ? (
            <section className="adm-section" aria-labelledby="proof-history">
              <h2 id="proof-history" className="adm-h2">
                {t("proofs.history")}
              </h2>
              <ul className="grid gap-2">
                {review.history.map((item) => (
                  <li key={item.id} className="type-body">
                    {t(`proof.${item.status}`)} · <Money iqd={item.declaredAmountIqd} /> · <When at={item.createdAt} />
                    {item.reviewNote ? <span className="type-caption text-ink-2"> — {item.reviewNote}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* lint-design: allow glass-in-list — the sticky task bar follows the earlier-proofs list; it is not inside its .map() */}
          <Glass className="ord-taskbar" edge="bottom" data-adm-sticky-end>
            <Key icon="x" className="enabled:[--on:var(--red-ink)]" onClick={() => setMode("reject")}>
              {t("proof.reject")}
            </Key>
            <Key variant="commit" icon="seal-check" disabled={review.order.onHold} onClick={() => setMode("approve")}>
              {t("proof.approve")}
            </Key>
          </Glass>

          {mode ? (
            <ConfirmDialog
              open
              onClose={() => setMode(null)}
              tone={mode === "approve" ? "commit" : "destructive"}
              title={t(mode === "approve" ? "proof.approveQ" : "proof.rejectQ", { ref: review.order.ref })}
              consequence={t(mode === "approve" ? "proof.approveWhat" : "proof.rejectWhat")}
              confirmLabel={t(mode === "approve" ? "proof.approve" : "proof.reject")}
              impact={
                mode === "approve"
                  ? [
                      { label: t("proof.due"), value: f.iqd(review.dueIqd) },
                      { label: t("proof.declared"), value: f.iqd(proof.declaredAmountIqd) },
                      { label: t("proof.received"), value: Number.isFinite(typed) ? f.iqd(typed) : "—" },
                    ]
                  : undefined
              }
              reason={
                mode === "reject"
                  ? { label: t("proof.rejectReason"), hint: t("proof.rejectHint"), minLength: 3 }
                  : differs
                    ? { label: t("proof.overrideReason"), hint: review.canOverride ? t("proof.overrideHint") : t("proof.noOverride") }
                    : { noteRequired: false, label: t("dialog.noteOptional") }
              }
              pending={pending}
              error={error}
              onConfirm={({ reason }) => submit({ approve: mode === "approve" ? "1" : "0", receivedAmountIqd: received, note: reason, ref: review.order.ref }, { method: "post" })}
            >
              {mode === "approve" ? <TextField label={t("proof.received")} hint={t("proof.receivedHint")} inputMode="numeric" value={received} onChange={(event) => setReceived(event.target.value)} ltr end={<span className="type-caption">{t("iqd")}</span>} /> : null}
            </ConfirmDialog>
          ) : null}
        </>
      )}
    </div>
  );
}
