import { useState } from "react";
import { Link } from "react-router";

import { useFormat } from "~/i18n/react";
import type { PayoutRow } from "~/server/services/admin/finance/wallets.server";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ActionDialog, DemoTag, Money, StateTag, useFinT, When } from "./ui";

/**
 * Wallet payouts (10.07, 2026-11-13): money OUT of a customer's wallet, asked in module 07 and decided here by a second
 * person. A card per request — the waiting ones raised (a person must decide them), the decided ones flat; the person
 * who asked sees "someone else decides" and no keys. Approving shows the amount, how it is paid and the balance after
 * first, binds the decision to the amount on the card (the server refuses another figure) and asks for a bank
 * transfer's reference when the request did not carry one; rejecting needs a reason.
 */
/** A ledger row's kind as a person reads it: a payout or a transfer between two accounts is not a bare "adjustment". */
export function entryKindLabel(t: (key: string) => string, row: { kind: string; refType: string | null }): string {
  if (row.refType === "wallet_payout") return t("walletKind.payout");
  if (row.refType === "wallet_transfer") return t("walletKind.transfer");
  return t(`walletKind.${row.kind}`);
}

export function PayoutList({ rows, canDecide, showCustomer = true, emptyHint }: { rows: readonly PayoutRow[]; canDecide: boolean; showCustomer?: boolean; emptyHint?: string }) {
  const t = useFinT();
  const [deciding, setDeciding] = useState<{ row: PayoutRow; decision: "approve" | "reject" } | null>(null);
  if (rows.length === 0) return <EmptyState title={t("payouts.empty")} text={emptyHint ?? t("payouts.emptyHint")} icon="hand-coins" />;
  return (
    <>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => (
          <li key={row.id}>
            <PayoutCard row={row} showCustomer={showCustomer} canDecide={canDecide} onDecide={(decision) => setDeciding({ row, decision })} />
          </li>
        ))}
      </ul>
      {deciding ? <PayoutDecision row={deciding.row} decision={deciding.decision} onClose={() => setDeciding(null)} /> : null}
    </>
  );
}

function PayoutCard({ row, showCustomer, canDecide, onDecide }: { row: PayoutRow; showCustomer: boolean; canDecide: boolean; onDecide: (decision: "approve" | "reject") => void }) {
  const t = useFinT();
  const f = useFormat();
  const waiting = row.status === "pending";
  const short = waiting && row.balanceIqd < row.amountIqd;
  return (
    <article className={waiting && !row.mine && canDecide ? "adm-card adm-card--act" : "adm-card"} aria-label={t("payouts.cardLabel", { amount: f.iqd(row.amountIqd) })}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {showCustomer ? (
          <Link to={`/admin/finance/wallets/${row.customerId}`} className="adm-link">
            {row.customer?.name ?? t("common.noName")}
          </Link>
        ) : (
          <span className="type-strong">{t(`payouts.method.${row.method}`)}</span>
        )}
        <span className="inline-flex flex-wrap items-center gap-1">
          <StateTag group="approval" value={row.status} label={t(`payouts.status.${row.status}`)} />
          {row.customer?.isDemo ? <DemoTag show /> : null}
        </span>
      </div>
      <p className="type-kpi nums">
        <Money iqd={row.amountIqd} />
      </p>
      {showCustomer ? <p className="type-caption text-ink-2">{t(`payouts.method.${row.method}`)}</p> : null}
      {row.reference ? (
        <p className="type-caption text-ink-2">
          {t("payouts.reference")} <bdi dir="ltr">{row.reference}</bdi>
        </p>
      ) : null}
      <p className="type-body">{row.reason}</p>
      <p className="type-caption text-ink-2">
        <bdi>{row.mine ? t("payouts.askedByYou") : t("payouts.askedBy", { name: `⁨${row.requestedBy ?? "—"}⁩` })}</bdi> · <When at={row.createdAt} />
      </p>
      {waiting ? (
        <p className={short ? "type-caption text-red-ink" : "type-caption text-ink-2"}>
          {t("payouts.balanceNow")} <Money iqd={row.balanceIqd} />
          {short ? ` — ${t("payouts.short")}` : null}
        </p>
      ) : null}
      {row.decidedBy ? (
        <p className="type-caption text-ink-2">
          <bdi>{t(row.status === "approved" ? "payouts.paidBy" : "payouts.rejectedBy", { name: `⁨${row.decidedBy ?? "—"}⁩` })}</bdi> · <When at={row.decidedAt} />
          {row.decisionNote ? ` — ${row.decisionNote}` : ""}
        </p>
      ) : null}
      {row.status === "approved" && !row.entryId ? <Status tone="bad">{t("payouts.noEntry")}</Status> : null}
      {waiting ? (
        row.mine ? (
          <p className="type-caption text-ink-2">{t("payouts.mine")}</p>
        ) : canDecide ? (
          <div className="flex flex-wrap gap-2">
            <Key size="sm" className="enabled:[--on:var(--red-ink)]" onClick={() => onDecide("reject")}>
              {t("payouts.reject")}
            </Key>
            <Key size="sm" variant="ink" icon="seal-check" onClick={() => onDecide("approve")} disabled={short}>
              {t("payouts.approve")}
            </Key>
          </div>
        ) : (
          <p className="type-caption text-ink-2">{t("payouts.cannotDecide")}</p>
        )
      ) : null}
    </article>
  );
}

function PayoutDecision({ row, decision, onClose }: { row: PayoutRow; decision: "approve" | "reject"; onClose: () => void }) {
  const t = useFinT();
  const f = useFormat();
  const [reference, setReference] = useState(row.reference ?? "");
  const approve = decision === "approve";
  const needsReference = approve && row.method === "bank_transfer" && !row.reference;
  return (
    <ActionDialog
      open
      onClose={onClose}
      fetcherKey={`payout-${row.id}`}
      tone={approve ? "commit" : "destructive"}
      title={t(approve ? "payouts.approveQ" : "payouts.rejectQ")}
      consequence={t(approve ? (row.method === "cash" ? "payouts.approveCash" : "payouts.approveBank") : "payouts.rejectWhat")}
      confirmLabel={t(approve ? "payouts.approve" : "payouts.reject")}
      impact={
        approve
          ? [
              { label: t("payouts.impactAmount"), value: f.iqd(row.amountIqd) },
              { label: t("payouts.impactMethod"), value: t(`payouts.method.${row.method}`) },
              { label: t("payouts.impactAfter"), value: f.iqd(row.balanceIqd - row.amountIqd) },
            ]
          : undefined
      }
      reason={approve ? { label: t("common.noteOptional"), noteRequired: false, minLength: 0 } : { label: t("common.reason"), minLength: 3 }}
      fields={{ intent: "payout", approvalId: row.id, decision, amountIqd: String(row.amountIqd), reference }}
    >
      {needsReference ? (
        <TextField name="reference" label={t("payouts.referenceLabel")} hint={t("payouts.referenceHint")} required autoComplete="off" maxLength={100} value={reference} onChange={(event) => setReference(event.currentTarget.value)} />
      ) : null}
    </ActionDialog>
  );
}
