/**
 * The sections of the RMA page (/admin/returns/:rma). Every change is a POST to the page's action (one intent each)
 * through a fetcher; money and stock changes open the confirm-with-reason dialog that shows their impact first.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { CONDITION_LIST, DECISION_LIST, DEFAULT_DECISION, QUARANTINE_DECISIONS, RESOLUTION_LIST, parseWhole, type Condition, type Decision, type RmaDetail, type RmaItemView, type RmaRefundView } from "~/server/services/admin/returns/types";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { CustomerName } from "../shell/CustomerName";
import { Facts, Failure, FlagExplanations, Money, PhoneText, Ref, RepairStatusBadge, Section, useIntent, useReturnsT, When, WarrantyBadge, newKey } from "./ui";

type Props = { rma: RmaDetail };

// ───────────────────────────────────────────────────────────────── the next step

export function ActionsSection({ rma }: Props) {
  const t = useReturnsT();
  const can = rma.can;
  const any = can.decide || can.transit || can.cancel || can.close || can.refund || can.repair;
  const waitsForMe = can.approveRefund && rma.refunds.some((refund) => (refund.status === "pending" || refund.status === "approved") && !refund.mine);
  return (
    <section className="adm-section" aria-labelledby="rma-actions">
      <h2 id="rma-actions" className="adm-h2">
        {t("detail.actions")}
      </h2>
      <div className="ret-actions">
        {can.decide ? <DecideButtons rma={rma} /> : null}
        {can.transit ? <TransitButton rma={rma} /> : null}
        {can.refund ? <RefundRequest rma={rma} /> : null}
        {can.repair ? <RepairButton rma={rma} /> : null}
        {can.close ? <CloseButton rma={rma} /> : null}
        {can.cancel ? <CancelButton rma={rma} /> : null}
      </div>
      {rma.status === "requested" && can.ownRequest ? (
        <p className="flex items-center gap-1 type-body text-ink-2">
          <Icon name="users" size={16} />
          {t("actions.ownRequest")}
        </p>
      ) : null}
      {waitsForMe ? (
        <p className="flex items-center gap-1 type-body">
          <Icon name="hand-coins" size={16} />
          <a href="#rma-refunds" className="adm-link">
            {t("detail.refundWaitsYou")}
          </a>
        </p>
      ) : null}
      {!any && !waitsForMe && !(rma.status === "requested" && can.ownRequest) ? <p className="type-body text-ink-2">{t("detail.noActions")}</p> : null}
    </section>
  );
}

function DecideButtons({ rma }: Props) {
  const t = useReturnsT();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const { fetcher, pending, message } = useIntent("decide", (result) => (result.status === "approved" ? "done.approved" : "done.rejected"), () => setMode(null));
  return (
    <>
      <Key size="sm" variant="ink" icon="check" onClick={() => setMode("approve")}>
        {t("actions.approve")}
      </Key>
      <Key size="sm" icon="x" className="enabled:[--on:var(--red-ink)]" onClick={() => setMode("reject")}>
        {t("actions.reject")}
      </Key>
      {mode ? (
        <ConfirmDialog
          open
          onClose={() => setMode(null)}
          tone={mode === "approve" ? "neutral" : "destructive"}
          title={t(mode === "approve" ? "actions.approveQ" : "actions.rejectQ", { rma: rma.rma })}
          consequence={t(mode === "approve" ? "actions.approveWhat" : "actions.rejectWhat")}
          confirmLabel={t(mode === "approve" ? "actions.approve" : "actions.reject")}
          reason={mode === "reject" ? { label: t("dialog.reason"), hint: t("actions.rejectHint") } : { noteRequired: false, label: t("dialog.noteOptional") }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "decide", approve: mode === "approve" ? "1" : "0", note: reason }, { method: "post" })}
        />
      ) : null}
    </>
  );
}

function TransitButton(_props: Props) {
  const t = useReturnsT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("transit", "done.transit", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="truck" onClick={() => setOpen(true)}>
        {t("actions.inTransit")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("actions.inTransitQ")}
        consequence={t("actions.inTransitWhat")}
        confirmLabel={t("actions.inTransit")}
        reason={{ noteRequired: false, label: t("dialog.noteOptional") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "transit", note: reason }, { method: "post" })}
      />
    </>
  );
}

function CancelButton({ rma }: Props) {
  const t = useReturnsT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("cancel", "done.cancel", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="x-circle" className="enabled:[--on:var(--red-ink)]" onClick={() => setOpen(true)}>
        {t("actions.cancel")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("actions.cancelQ", { rma: rma.rma })}
        consequence={t("actions.cancelWhat")}
        confirmLabel={t("actions.cancel")}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "cancel", reason }, { method: "post" })}
      />
    </>
  );
}

function CloseButton({ rma }: Props) {
  const t = useReturnsT();
  const [open, setOpen] = useState(false);
  const paid = rma.refunds.some((refund) => refund.status === "paid");
  const initial = rma.resolution ?? (paid ? (rma.refunds.find((refund) => refund.status === "paid")?.method === "wallet" ? "store_credit" : "refund") : rma.repairs.length ? "repair" : "none");
  const [resolution, setResolution] = useState<string>(initial);
  const { fetcher, pending, message, fields } = useIntent("close", "done.close", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="check-circle" onClick={() => setOpen(true)}>
        {t("actions.close")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("actions.closeQ", { rma: rma.rma })}
        consequence={t("actions.closeWhat")}
        confirmLabel={t("actions.close")}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "close", resolution, note: reason }, { method: "post" })}
      >
        <Select label={t("actions.closeResolution")} value={resolution} onChange={(event) => setResolution(event.target.value)} options={RESOLUTION_LIST.map((value) => ({ value, label: t(`resolution.${value}`) }))} error={fields.resolution} />
      </ConfirmDialog>
    </>
  );
}

function RepairButton({ rma }: Props) {
  const t = useReturnsT();
  const kept = rma.items.filter((item) => item.decision === "keep");
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState(kept[0]?.id ?? "");
  const { fetcher, pending, message } = useIntent("repair", "done.repair", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="wrench" onClick={() => setOpen(true)}>
        {t("actions.repair")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("actions.repairQ")}
        consequence={t("actions.repairWhat")}
        confirmLabel={t("actions.repair")}
        reason={{ label: t("actions.repairIssue"), minLength: 10, maxLength: 2000 }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "repair", itemId, issue: reason }, { method: "post" })}
      >
        <Select label={t("actions.repairItem")} value={itemId} onChange={(event) => setItemId(event.target.value)} options={kept.map((item) => ({ value: item.id, label: item.serial ? `${item.name} · ${item.serial.serial}` : item.name }))} />
      </ConfirmDialog>
    </>
  );
}

// ───────────────────────────────────────────────────────────────── refunds (12.04, 12.05)

const TRANSFER_METHODS = ["bank_transfer", "zaincash"];

function RefundRequest({ rma }: Props) {
  const t = useReturnsT();
  const f = useFormat();
  // the units whose money may go back (they came back, or their repair under this RMA failed), not refunded yet
  const refundable = rma.items.filter((item) => item.refundable && item.refundedQty < item.qty);
  const payments = rma.payments.filter((payment) => payment.refundableIqd > 0);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>(refundable.map((item) => item.id));
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? "");
  const [method, setMethod] = useState<"original" | "wallet" | "cash">("original");
  const [reference, setReference] = useState("");
  const [key, setKey] = useState(newKey);
  const suggestion = rma.refundSuggestion;
  const picked = refundable.filter((item) => chosen.includes(item.id));
  const chosenValue = picked.reduce((sum, item) => sum + item.unitValueIqd * (item.qty - item.refundedQty), 0);
  // the policy's restocking fee of exactly these units (the server refuses more than value − fee)
  const fee = picked.reduce((sum, item) => sum + item.feeIqd, 0);
  const payment = payments.find((entry) => entry.id === paymentId);
  const ceiling = Math.max(0, Math.min(chosenValue - fee, payment?.refundableIqd ?? 0));
  const [amount, setAmount] = useState(String(ceiling));
  const typed = parseWhole(amount);
  const { fetcher, pending, message, fields } = useIntent("refund", (result) => (result.status === "paid" ? "done.refundPaid" : "done.refundPending"), () => setOpen(false));
  if (payments.length === 0) return <p className="type-caption text-ink-2">{t("refund.noPayment")}</p>;
  const reset = () => {
    const all = refundable.map((item) => item.id);
    setChosen(all);
    const value = refundable.reduce((sum, item) => sum + item.unitValueIqd * (item.qty - item.refundedQty) - item.feeIqd, 0);
    setAmount(String(Math.max(0, Math.min(value, payments[0]?.refundableIqd ?? 0))));
    setPaymentId(payments[0]?.id ?? "");
    setKey(newKey());
    setOpen(true);
  };
  const impact: ImpactRow[] = [
    { label: t("refund.leaves"), value: typeof typed === "number" && Number.isFinite(typed) ? f.iqd(typed) : "—", negative: true },
    { label: t("refund.ceiling"), value: f.iqd(ceiling) },
  ];
  return (
    <>
      <Key size="sm" variant="ink" icon="hand-coins" onClick={reset}>
        {t("refund.request")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("refund.requestQ", { rma: rma.rma })}
        consequence={t("refund.requestWhat")}
        confirmLabel={t("refund.request")}
        impact={impact}
        reason={{ label: t("refund.reason"), hint: t("refund.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => {
          const form = new FormData();
          form.set("intent", "refund");
          form.set("paymentId", paymentId);
          for (const id of chosen) form.append("itemId", id);
          form.set("amountIqd", amount);
          form.set("method", method);
          form.set("reference", reference);
          form.set("reason", reason);
          form.set("idempotencyKey", key);
          fetcher.submit(form, { method: "post" });
        }}
      >
        <div className="grid gap-3">
          <fieldset className="grid gap-1">
            <legend className="type-label">{t("refund.items")}</legend>
            {refundable.map((item) => (
              <Checkbox
                key={item.id}
                label={`${item.name}${item.serial ? ` · ${item.serial.serial}` : ""} × ${item.qty - item.refundedQty}`}
                checked={chosen.includes(item.id)}
                onChange={(event) => setChosen((current) => (event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))}
              />
            ))}
            <Failure message={fields.itemIds ?? null} />
          </fieldset>
          <Select
            label={t("refund.payment")}
            value={paymentId}
            onChange={(event) => setPaymentId(event.target.value)}
            options={payments.map((entry) => ({ value: entry.id, label: t("refund.paymentOption", { method: t(`method.${entry.method}`), amount: f.iqd(entry.refundableIqd) }) }))}
          />
          <TextField label={t("refund.amount")} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} required ltr error={fields.amountIqd} hint={suggestion ? t("refund.suggestion", { amount: f.iqd(Math.max(0, chosenValue - fee)), value: f.iqd(chosenValue), fee: f.iqd(fee) }) : undefined} end={<span className="type-caption">{t("iqd")}</span>} />
          <Select
            label={t("refund.method")}
            value={method}
            onChange={(event) => setMethod(event.target.value as typeof method)}
            options={[
              { value: "original", label: t("refundMethod.original") },
              ...(rma.customer.hasWallet ? [{ value: "wallet", label: t("refundMethod.wallet") }] : []),
              { value: "cash", label: t("refundMethod.cash") },
            ]}
            hint={rma.customer.hasWallet ? undefined : t("refund.walletNeedsAccount")}
            error={fields.method}
          />
          {method === "original" && payment && TRANSFER_METHODS.includes(payment.method) ? <TextField label={t("refund.reference")} optional hint={t("refund.referenceHint")} value={reference} onChange={(event) => setReference(event.target.value)} ltr error={fields.reference} /> : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

const REFUND_TONE = { pending: "warn", approved: "info", paid: "ok", rejected: "bad", cancelled: "neutral" } as const;

export function RefundsSection({ rma }: Props) {
  const t = useReturnsT();
  return (
    <Section id="rma-refunds" title={t("detail.refunds")}>
      {rma.refunds.length === 0 ? (
        <p className="type-body text-ink-2">{t("detail.refundsEmpty")}</p>
      ) : (
        <ul className="grid gap-3">
          {rma.refunds.map((refund) => (
            <li key={refund.id}>
              <RefundCard rma={rma} refund={refund} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function RefundCard({ rma, refund }: { rma: RmaDetail; refund: RmaRefundView }) {
  const t = useReturnsT();
  const waiting = refund.status === "pending" || refund.status === "approved";
  return (
    <article className={waiting && rma.can.approveRefund && !refund.mine ? "adm-card adm-card--act" : "adm-card"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="type-strong">
          <Money iqd={refund.amountIqd} /> · {t(`refundMethod.${refund.method}`)}
        </p>
        <Status tone={REFUND_TONE[refund.status]}>{t(`refundStatus.${refund.status}`)}</Status>
      </div>
      <Facts
        rows={[
          { label: t("refund.reason"), value: refund.reason ?? "—" },
          { label: t("refund.requestedBy"), value: refund.createdBy ?? "—" },
          { label: t("refund.decidedBy"), value: refund.approvedBy ?? "—", hidden: !refund.approvedBy },
          { label: t("refund.reference"), value: <Ref value={refund.reference ?? ""} />, hidden: !refund.reference },
          { label: t("detail.rejectReason"), value: refund.rejectReason, hidden: !refund.rejectReason },
        ]}
      />
      <p className="type-caption text-ink-2">
        <When at={refund.createdAt} />
      </p>
      {waiting ? (
        refund.mine ? (
          <p className="flex items-center gap-1 type-body text-ink-2">
            <Icon name="users" size={16} />
            {t("refund.mine")}
          </p>
        ) : rma.can.approveRefund ? (
          <RefundDecision rma={rma} refund={refund} />
        ) : (
          <p className="type-caption text-ink-2">{t("refund.waitsApprover")}</p>
        )
      ) : null}
    </article>
  );
}

function RefundDecision({ rma, refund }: { rma: RmaDetail; refund: RmaRefundView }) {
  const t = useReturnsT();
  const f = useFormat();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [reference, setReference] = useState("");
  const { fetcher, pending, message } = useIntent("refund-decision", "done.refundDecision", () => setMode(null));
  return (
    <div className="ret-actions">
      <Key size="sm" variant="ink" icon="check" onClick={() => setMode("approve")}>
        {t("refund.approve")}
      </Key>
      <Key size="sm" icon="x" className="enabled:[--on:var(--red-ink)]" onClick={() => setMode("reject")}>
        {t("refund.reject")}
      </Key>
      {mode ? (
        <ConfirmDialog
          open
          onClose={() => setMode(null)}
          tone={mode === "approve" ? "commit" : "destructive"}
          title={t(mode === "approve" ? "refund.approveQ" : "refund.rejectQ", { rma: rma.rma })}
          consequence={t(mode === "approve" ? "refund.approveWhat" : "refund.rejectWhat")}
          confirmLabel={t(mode === "approve" ? "refund.approve" : "refund.reject")}
          impact={mode === "approve" ? [{ label: t("refund.leaves"), value: f.iqd(refund.amountIqd), negative: true }] : undefined}
          reason={mode === "reject" ? { label: t("dialog.reason"), hint: t("refund.rejectHint") } : { noteRequired: false, label: t("dialog.noteOptional") }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "refund-decision", refundId: refund.id, approve: mode === "approve" ? "1" : "0", note: reason, reference }, { method: "post" })}
        >
          {mode === "approve" && refund.needsReference ? <TextField label={t("refund.reference")} required hint={t("refund.referenceRequired")} value={reference} onChange={(event) => setReference(event.target.value)} ltr /> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── units and their inspection (12.03)

export function ItemsSection({ rma }: Props) {
  const t = useReturnsT();
  return (
    <Section id="rma-items" title={t("detail.items")}>
      <ul className="ret-items">
        {rma.items.map((item) => (
          <li key={item.id} className="ret-item">
            <ItemRow rma={rma} item={item} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

const CONDITION_TONE = { sellable: "ok", opened: "info", defective: "warn", damaged: "bad" } as const;

function ItemRow({ rma, item }: { rma: RmaDetail; item: RmaItemView }) {
  const t = useReturnsT();
  const f = useFormat();
  const inQuarantine = (item.decision === "refurbish" || item.decision === "return_to_supplier") && item.quarantineExit === null;
  return (
    <>
      <div className="ret-item__head">
        <div className="grid gap-0.5">
          <p className="type-strong">
            {item.name} <span className="nums text-ink-2">× {f.number(item.qty)}</span>
          </p>
          <p className="type-caption text-ink-2">
            <Ref value={item.sku} />
            {item.serial ? (
              <>
                {" · "}
                {t("item.serial")} <Ref value={item.serial.serial} />
              </>
            ) : null}
            {" · "}
            {t("item.value")} <Money iqd={item.unitValueIqd} />
          </p>
        </div>
        {item.condition ? <Status tone={CONDITION_TONE[item.condition]}>{t(`condition.${item.condition}`)}</Status> : <Status tone="neutral">{t("item.notInspected")}</Status>}
      </div>
      {item.eligibility ? (
        <p className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
          <span>{t("item.atRequest")}:</span>
          <Status tone={item.eligibility.eligible ? "ok" : "warn"}>{item.eligibility.eligible ? t("eligibility.eligible") : t("eligibility.notEligible")}</Status>
          {item.eligibility.problems.map((problem) => (
            <span key={problem}>{t(`eligibility.problems.${problem}`)}</span>
          ))}
        </p>
      ) : null}
      {item.decision ? (
        <Facts
          rows={[
            { label: t("item.decision"), value: item.quarantineExit ? t(`item.exit.${item.quarantineExit}`) : inQuarantine ? `${t(`decision.${item.decision}`)} · ${t("item.inQuarantine")}` : t(`decision.${item.decision}`) },
            { label: t("item.inspectedBy"), value: item.inspectedBy ?? "—" },
            { label: t("inspect.notes"), value: item.notes ?? "—", hidden: !item.notes },
            { label: t("item.warranty"), value: item.warranty ? <WarrantyLine item={item} /> : t("item.warrantyNone") },
            {
              label: t("detail.refunds"),
              value: [item.refundPaidQty > 0 ? t("item.refunded", { count: item.refundPaidQty, qty: item.qty }) : null, item.refundedQty > item.refundPaidQty ? t("item.refundPending", { count: item.refundedQty - item.refundPaidQty }) : null].filter(Boolean).join(" · "),
              hidden: item.refundedQty === 0,
            },
          ]}
        />
      ) : (
        <p className="type-caption text-ink-2">{item.warranty ? <WarrantyLine item={item} /> : t("item.warrantyNone")}</p>
      )}
      {rma.can.inspect && item.decision === null ? (
        <div>
          <InspectButton rma={rma} item={item} />
        </div>
      ) : null}
    </>
  );
}

function WarrantyLine({ item }: { item: RmaItemView }) {
  const f = useFormat();
  if (!item.warranty) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <WarrantyBadge state={item.warranty.state} />
      <Link to={`/admin/returns/warranties/${item.warranty.id}`} className="adm-link">
        {f.date(item.warranty.endsAt)}
      </Link>
    </span>
  );
}

function InspectButton({ rma, item }: { rma: RmaDetail; item: RmaItemView }) {
  const t = useReturnsT();
  const f = useFormat();
  // a used device goes back to the devices team (or is written off): never a quarantine decision, no location to pick
  const defaultFor = (next: Condition): Decision => (item.used && QUARANTINE_DECISIONS.includes(DEFAULT_DECISION[next]) ? "restock" : DEFAULT_DECISION[next]);
  const [open, setOpen] = useState(false);
  const [serial, setSerial] = useState("");
  const [condition, setCondition] = useState<Condition>("sellable");
  const [decision, setDecision] = useState<Decision>(defaultFor("sellable"));
  const [locationId, setLocationId] = useState("");
  const quarantine = QUARANTINE_DECISIONS.includes(decision);
  const { fetcher, pending, message, fields } = useIntent("inspect", "done.inspect", () => setOpen(false));
  const locations = quarantine ? rma.quarantineLocations : rma.sellableLocations;
  const impact = useMemo<ImpactRow[]>(() => {
    const units = f.number(item.qty);
    const stock =
      decision === "restock" && item.used
        ? t("inspect.impact.used")
        : decision === "restock"
          ? t("inspect.impact.restock", { count: units })
          : quarantine
            ? t("inspect.impact.quarantine", { count: units })
            : decision === "scrap"
              ? t("inspect.impact.scrap", { count: units })
              : t("inspect.impact.keep");
    const rows: ImpactRow[] = [{ label: t("inspect.impact.stock"), value: stock, negative: decision === "scrap" }];
    if (item.warranty?.state === "active") rows.push({ label: t("inspect.impact.warranty"), value: decision === "keep" ? t("inspect.impact.warrantyKept") : t("inspect.impact.warrantyEnds"), negative: decision !== "keep" });
    return rows;
  }, [decision, quarantine, item, t, f]);
  return (
    <>
      <Key
        size="sm"
        icon="magnifying-glass"
        onClick={() => {
          setSerial("");
          setCondition("sellable");
          setDecision(defaultFor("sellable"));
          setLocationId("");
          setOpen(true);
        }}
      >
        {t("item.inspect")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("inspect.title", { name: item.name })}
        consequence={t("inspect.consequence")}
        confirmLabel={t("inspect.confirm")}
        impact={impact}
        reason={{ noteRequired: false, label: t("inspect.notes"), maxLength: 1000 }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "inspect", itemId: item.id, condition, decision, locationId, serial, notes: reason }, { method: "post" })}
      >
        <div className="grid gap-3">
          {item.serial ? <TextField label={t("inspect.scan")} hint={t("inspect.scanHint")} value={serial} onChange={(event) => setSerial(event.target.value)} required ltr autoFocus autoComplete="off" error={fields.serial} /> : null}
          <Select
            label={t("inspect.condition")}
            value={condition}
            onChange={(event) => {
              const next = event.target.value as Condition;
              setCondition(next);
              setDecision(defaultFor(next));
              setLocationId("");
            }}
            hint={t(`conditionHint.${condition}`)}
            options={CONDITION_LIST.map((value) => ({ value, label: t(`condition.${value}`) }))}
          />
          <Select
            label={t("inspect.decision")}
            value={decision}
            onChange={(event) => {
              setDecision(event.target.value as Decision);
              setLocationId("");
            }}
            hint={item.used ? t("inspect.usedHint") : t(`decisionHint.${decision}`)}
            error={fields.decision}
            options={DECISION_LIST.filter((value) => !(item.used && QUARANTINE_DECISIONS.includes(value))).map((value) => ({ value, label: t(`decision.${value}`) }))}
          />
          {(decision === "restock" && !item.used) || quarantine ? (
            quarantine && locations.length === 0 ? (
              <Failure message={t("inspect.noQuarantine")} />
            ) : (
              <Select
                label={t("inspect.location")}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                required={quarantine || !rma.can.restockDefault}
                error={fields.locationId}
                options={[...(quarantine || !rma.can.restockDefault ? [{ value: "", label: t("new.form.choose") }] : [{ value: "", label: t("inspect.locationDefault") }]), ...locations.map((location) => ({ value: location.id, label: `${location.code} · ${location.name}` }))]}
              />
            )
          ) : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

// ───────────────────────────────────────────────────────────────── the rest of the page

export function RepairsSection({ rma }: Props) {
  const t = useReturnsT();
  if (rma.repairs.length === 0) return null;
  return (
    <Section id="rma-repairs" title={t("detail.repairs")}>
      <ul className="grid gap-2">
        {rma.repairs.map((repair) => (
          <li key={repair.id} className="flex flex-wrap items-center gap-2">
            <Link to={`/admin/returns/repairs/${repair.ref}`} className="adm-link">
              <Ref value={repair.ref} />
            </Link>
            <RepairStatusBadge status={repair.status} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function PhotosSection({ rma }: Props) {
  const t = useReturnsT();
  const { fetcher, pending, message } = useIntent("photo", "done.photo");
  return (
    <Section id="rma-photos" title={t("detail.photos")}>
      {rma.photos.length === 0 ? (
        <p className="type-body text-ink-2">{t("detail.photosEmpty")}</p>
      ) : (
        <ul className="ret-photos">
          {rma.photos.map((photo, index) => (
            <li key={photo.id}>
              <a href={photo.url} target="_blank" rel="noreferrer">
                <img src={photo.url} alt={`${rma.rma} · ${index + 1}`} width={photo.width ?? 240} height={photo.height ?? 240} loading="lazy" decoding="async" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {rma.can.addPhoto ? (
        <fetcher.Form method="post" encType="multipart/form-data" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="intent" value="photo" />
          <div className="grid gap-1">
            <label htmlFor="rma-photo" className="type-label">
              {t("actions.addPhoto")}
            </label>
            <input id="rma-photo" name="file" type="file" accept="image/jpeg,image/png,image/webp" required className="type-body" aria-describedby="rma-photo-hint" />
            <p id="rma-photo-hint" className="type-caption text-ink-2">
              {t("actions.photoHint")}
            </p>
          </div>
          <Key type="submit" size="sm" icon="upload-simple" loading={pending}>
            {t("actions.upload")}
          </Key>
          <Failure message={message} />
        </fetcher.Form>
      ) : null}
    </Section>
  );
}

function timelineKey(action: string): string {
  return action.replace(/^returns\./, "").replace(/^orders\./, "").replace(/\./g, "_");
}

export function HistorySection({ rma }: Props) {
  const t = useReturnsT();
  return (
    <Section id="rma-history" title={t("detail.history")}>
      {rma.timeline.length === 0 ? (
        <p className="type-body text-ink-2">{t("detail.historyEmpty")}</p>
      ) : (
        <ol className="ret-timeline">
          {rma.timeline.map((entry) => {
            const key = `timeline.${timelineKey(entry.action)}`;
            const sentence = t(key);
            const who = entry.actor.name ?? (entry.actor.kind === "system" ? t("timeline.system") : entry.actor.kind === "customer" ? t("timeline.customer") : "—");
            return (
              <li key={entry.id} data-actor={entry.actor.kind}>
                <p className="type-body">
                  <span className="type-strong">{who}</span> {sentence === key ? t("timeline.other") : sentence}
                </p>
                <p className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
                  <When at={entry.at} />
                  {entry.reason ? <span className="ret-reason">{entry.reason}</span> : null}
                  {entry.inspection ? <span>{t(`condition.${entry.inspection.condition}`)} · {t(`decision.${entry.inspection.decision}`)}</span> : null}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

export function FactsSection({ rma }: Props) {
  const t = useReturnsT();
  const f = useFormat();
  return (
    <section className="adm-card" aria-labelledby="rma-facts">
      <h2 id="rma-facts" className="adm-h3">
        {t("detail.facts")}
      </h2>
      <Facts
        className="ret-facts--single"
        rows={[
          { label: t("detail.customer"), value: <CustomerName profileId={rma.customer.profileId}>{rma.customer.name ?? (rma.customer.kind === "guest" ? t("detail.guest") : "—")}</CustomerName> },
          { label: t("detail.phone"), value: <PhoneText phone={rma.customer.phone} /> },
          { label: t("detail.reasonCode"), value: rma.reasonCode ? t(`reason.${rma.reasonCode}`) : "—" },
          { label: t("detail.reasonText"), value: rma.reason ?? "—" },
          { label: t("detail.requested"), value: rma.requestedResolution ? t(`resolution.${rma.requestedResolution}`) : "—" },
          { label: t("detail.resolution"), value: rma.resolution ? t(`resolution.${rma.resolution}`) : "—", hidden: !rma.resolution },
          { label: t("detail.rejectReason"), value: rma.rejectReason, hidden: !rma.rejectReason },
          { label: t("detail.staffNote"), value: rma.staffNote, hidden: !rma.staffNote },
          { label: t("detail.created"), value: <When at={rma.createdAt} /> },
          { label: t("detail.createdBy"), value: rma.createdBy ?? "—", hidden: !rma.createdBy },
          { label: t("detail.approvedBy"), value: rma.approvedBy ?? "—", hidden: !rma.approvedBy },
          { label: t("detail.order"), value: t("detail.orderTotals", { paid: f.iqd(rma.order.paidIqd), total: f.iqd(rma.order.totalIqd), refunded: f.iqd(rma.order.refundedIqd) }) },
        ]}
      />
    </section>
  );
}

export function SignalsSection({ rma }: Props) {
  const t = useReturnsT();
  return (
    <section className={rma.flags.length ? "adm-card adm-card--act" : "adm-card"} aria-labelledby="rma-signals">
      <h2 id="rma-signals" className="adm-h3">
        {t("fraud.title")}
      </h2>
      <p className="type-caption text-ink-2">{t("fraud.lead")}</p>
      <FlagExplanations signals={rma.flags} />
    </section>
  );
}

export function NoteSection(_props: Props) {
  const t = useReturnsT();
  const [text, setText] = useState("");
  const { fetcher, pending, message, fields } = useIntent("note", "done.note", () => setText(""));
  return (
    <section className="adm-card" aria-labelledby="rma-note">
      <h2 id="rma-note" className="adm-h3">
        {t("detail.notes")}
      </h2>
      <fetcher.Form method="post" className="grid gap-2">
        <input type="hidden" name="intent" value="note" />
        <TextArea name="text" label={t("actions.note")} hideLabel value={text} onChange={(event) => setText(event.target.value)} rows={3} error={fields.text} />
        <div>
          <Key type="submit" size="sm" icon="paper-plane-tilt" loading={pending}>
            {t("actions.addNote")}
          </Key>
        </div>
        <Failure message={message && !fields.text ? message : null} />
      </fetcher.Form>
    </section>
  );
}
