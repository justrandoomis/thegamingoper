import { useState } from "react";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import type { TillRefundRow, TillRefundView } from "~/server/services/admin/pos/refunds.server";
import { parseWhole } from "~/server/services/admin/pos/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { Failure, Money, newKey, Notice, Ref, useIntent, usePosT, When } from "./ui";

/**
 * Cash back at the till (2026-11-13) — the receipt page's panel. The cash a sale took is paid back from the asker's own
 * open drawer: at once when the owner's threshold allows, otherwise once a second person approves it (here: the cash
 * then leaves the drawer named when it was asked). A refund approved outside the till moved no drawer; it says so, and
 * the cash handed over from the drawer can be recorded afterwards. Card and wallet payments go back through the order.
 * The confirmation shows the amount, the drawer and whether it waits, first (blueprint: money needs a confirmation
 * and a reason). Screen only.
 */
export function TillRefundPanel({ saleRef, view }: { saleRef: string; view: TillRefundView }) {
  const t = usePosT();
  const f = useFormat();
  const refundable = view.cash.reduce((sum, payment) => sum + payment.refundableIqd, 0);
  return (
    <section className="pos-panel" aria-labelledby="till-refund-head">
      <h2 id="till-refund-head" className="flex items-center gap-2 type-sub">
        <Icon name="arrow-counter-clockwise" size={20} />
        {t("tillRefund.title")}
      </h2>
      <p className="type-caption text-ink-2">{t("tillRefund.lead")}</p>
      {view.cash.length ? (
        <ul className="grid gap-1">
          {view.cash.map((payment) => (
            <li key={payment.paymentId} className="pos-code">
              <span className="type-body">
                {t("tillRefund.cashPaid")} <Money iqd={payment.amountIqd} />
              </span>
              <span className="type-caption text-ink-2">
                {t("tillRefund.left")} <Money iqd={payment.refundableIqd} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">{t("tillRefund.noCash")}</p>
      )}
      {view.otherMethods.length ? <p className="type-caption text-ink-2">{t("tillRefund.otherMethods")}</p> : null}
      {view.canAsk && refundable > 0 && view.myDrawer ? <AskRefund saleRef={saleRef} view={view} drawer={view.myDrawer} /> : null}
      {view.askBlocked === "no_drawer" && refundable > 0 ? (
        <Notice tone="info" icon="lock">
          {t("tillRefund.noDrawer")}
        </Notice>
      ) : null}
      {view.askBlocked === "no_right" ? (
        <Notice tone="info" icon="lock">
          {t("tillRefund.noRight")}
        </Notice>
      ) : null}
      <p className="type-caption text-ink-2">{view.thresholdIqd > 0 ? t("tillRefund.threshold", { amount: f.iqd(view.thresholdIqd) }) : t("tillRefund.thresholdZero")}</p>
      {view.refunds.length ? (
        <ul className="grid gap-2" aria-label={t("tillRefund.listLabel")}>
          {view.refunds.map((row) => (
            <li key={row.id}>
              <RefundRow saleRef={saleRef} row={row} canApprove={view.canApprove} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AskRefund({ saleRef, view, drawer }: { saleRef: string; view: TillRefundView; drawer: { shiftId: string; register: string } }) {
  const t = usePosT();
  const f = useFormat();
  const payable = view.cash.filter((payment) => payment.refundableIqd > 0);
  const [open, setOpen] = useState(false);
  const [paymentId, setPaymentId] = useState(payable[0]?.paymentId ?? "");
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState("");
  const { fetcher, pending, message, fields } = useIntent("refund", (result) => (result.status === "paid" ? "tillRefund.donePaid" : "tillRefund.doneWaiting"), () => setOpen(false));
  const chosen = payable.find((payment) => payment.paymentId === paymentId) ?? payable[0];
  const start = () => {
    setKey(newKey());
    setAmount(String(chosen?.refundableIqd ?? ""));
    setOpen(true);
  };
  const typed = parseWhole(amount);
  const waits = !(typed !== null && typed > 0 && typed <= view.thresholdIqd);
  return (
    <>
      <div className="pos-actions">
        <Key icon="arrow-counter-clockwise" onClick={start}>
          {t("tillRefund.ask", { register: drawer.register })}
        </Key>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("tillRefund.askTitle")}
        consequence={waits ? t("tillRefund.askWaits") : t("tillRefund.askNow")}
        confirmLabel={waits ? t("tillRefund.askKeyWaits") : t("tillRefund.askKeyNow")}
        impact={[
          { label: t("tillRefund.impactSale"), value: saleRef },
          { label: t("tillRefund.impactDrawer"), value: drawer.register },
          { label: t("tillRefund.impactWhen"), value: waits ? t("tillRefund.whenWaits") : t("tillRefund.whenNow") },
        ]}
        reason={{ label: t("tillRefund.reason"), hint: t("tillRefund.reasonHint") }}
        pending={pending}
        error={fields.amountIqd || fields.paymentId ? null : message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "refund", shiftId: drawer.shiftId, paymentId: chosen?.paymentId ?? "", amountIqd: amount, reason, key }, { method: "post" })}
      >
        {payable.length > 1 ? (
          <Select
            name="paymentId"
            label={t("tillRefund.payment")}
            value={chosen?.paymentId ?? ""}
            onChange={(event) => setPaymentId(event.currentTarget.value)}
            options={payable.map((payment) => ({ value: payment.paymentId, label: `${t("tillRefund.cashPaid")} ${f.iqd(payment.amountIqd)}` }))}
            error={fields.paymentId}
          />
        ) : null}
        <TextField
          name="amountIqd"
          label={t("tillRefund.amount")}
          hint={t("tillRefund.amountHint", { max: f.iqd(chosen?.refundableIqd ?? 0) })}
          inputMode="numeric"
          autoComplete="off"
          required
          value={amount}
          onChange={(event) => setAmount(event.currentTarget.value)}
          error={fields.amountIqd}
          end={<span className="type-caption">{t("tillRefund.iqd")}</span>}
        />
      </ConfirmDialog>
    </>
  );
}

const TONE: Record<string, "ok" | "warn" | "neutral" | "bad"> = { paid: "ok", pending: "warn", rejected: "neutral", cancelled: "neutral" };

function RefundRow({ saleRef, row, canApprove }: { saleRef: string; row: TillRefundRow; canApprove: boolean }) {
  const t = usePosT();
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  const decide = useIntent("refund-decide", (result) => (result.status === "paid" ? (result.fromDrawer ? "tillRefund.doneApproved" : "tillRefund.doneApprovedNoDrawer") : "tillRefund.doneRejected"), () => setDeciding(null));
  const drawerPay = useIntent("refund-drawer", "tillRefund.doneDrawer");
  const waiting = row.status === "pending";
  const lateDrawer = row.status === "paid" && row.method === "cash" && !row.fromDrawer && row.drawer?.open;
  return (
    <article className={waiting && canApprove && !row.mine && row.drawer ? "adm-card adm-card--act" : "adm-card"}>
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <Money iqd={row.amountIqd} className="type-strong" />
        <Status tone={TONE[row.status] ?? "neutral"}>{t(`tillRefund.status.${row.status}`)}</Status>
      </p>
      {row.reason ? <p className="type-body">{row.reason}</p> : null}
      <p className="type-caption text-ink-2">
        <bdi>{row.mine ? t("tillRefund.askedByYou") : t("tillRefund.askedBy", { name: `⁨${row.requestedBy ?? "—"}⁩` })}</bdi> · <When at={row.createdAt} />
      </p>
      <p className="type-caption text-ink-2">
        {row.drawer ? (
          row.fromDrawer ? (
            <>
              {t("tillRefund.fromDrawer")} <Ref value={row.drawer.register} />
            </>
          ) : waiting ? (
            <>
              {t("tillRefund.drawerWhenApproved")} <Ref value={row.drawer.register} />
              {row.drawer.open ? null : ` — ${t("tillRefund.drawerClosed")}`}
            </>
          ) : row.status === "paid" ? (
            t("tillRefund.paidElsewhere")
          ) : null
        ) : (
          t("tillRefund.notAtTill")
        )}
      </p>
      {waiting && row.drawer ? (
        row.mine ? (
          <p className="type-caption text-ink-2">{t("tillRefund.mine")}</p>
        ) : canApprove ? (
          <div className="pos-actions">
            <Key size="sm" className="enabled:[--on:var(--red-ink)]" onClick={() => setDeciding("reject")}>
              {t("tillRefund.reject")}
            </Key>
            <Key size="sm" variant="ink" icon="seal-check" disabled={!row.drawer.open} onClick={() => setDeciding("approve")}>
              {t("tillRefund.approve", { register: row.drawer.register })}
            </Key>
          </div>
        ) : null
      ) : null}
      {lateDrawer && row.drawer ? (
        <div className="grid gap-1">
          <Key size="sm" icon="money" loading={drawerPay.pending} onClick={() => drawerPay.fetcher.submit({ intent: "refund-drawer", refundId: row.id }, { method: "post" })}>
            {t("tillRefund.recordDrawer", { register: row.drawer.register })}
          </Key>
          <Failure message={drawerPay.message} />
        </div>
      ) : null}
      <ConfirmDialog
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        tone={deciding === "approve" ? "commit" : "destructive"}
        title={deciding === "approve" ? t("tillRefund.approveQ") : t("tillRefund.rejectQ")}
        consequence={deciding === "approve" ? t("tillRefund.approveWhat", { register: row.drawer?.register ?? "" }) : t("tillRefund.rejectWhat")}
        confirmLabel={deciding === "approve" ? t("tillRefund.approve", { register: row.drawer?.register ?? "" }) : t("tillRefund.reject")}
        impact={deciding === "approve" ? [{ label: t("tillRefund.impactSale"), value: saleRef }, { label: t("tillRefund.impactDrawer"), value: row.drawer?.register ?? "—" }] : undefined}
        reason={deciding === "approve" ? { label: t("tillRefund.noteOptional"), noteRequired: false, minLength: 0 } : { label: t("tillRefund.reason"), minLength: 3 }}
        pending={decide.pending}
        error={decide.message}
        onConfirm={({ reason }) => decide.fetcher.submit({ intent: "refund-decide", refundId: row.id, decision: deciding ?? "reject", reason }, { method: "post" })}
      />
    </article>
  );
}
