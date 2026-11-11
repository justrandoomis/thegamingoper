/**
 * The sections of the order page (/admin/orders/:ref). Every change is a POST to the page's action (one intent each)
 * through a fetcher; money and stock changes open the confirm-with-reason dialog that shows their impact first.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useFetcher } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { parseIqd, type HistoryEntry, type OrderDetail, type PaymentView, type RefundView, type TransitionOption } from "~/server/services/admin/orders/types";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import type { OrderActionResult } from "./order.server";
import { Facts, Failure, FlagExplanations, Money, newKey, PhoneText, Ref, Section, useOrdersT, When } from "./ui";

type Fetched = OrderActionResult | undefined;

/** A fetcher for one intent: its failure sentence, and a toast + `onDone` when it succeeded. */
function useIntent(intent: string, onDone?: () => void) {
  const fetcher = useFetcher<OrderActionResult>();
  const t = useOrdersT();
  const result = fetcher.data as Fetched;
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok && result.intent === intent) {
      toast.success(t(result.replayed ? "done.replayed" : `done.${intent}`));
      onDone?.();
    }
  }, [fetcher.state, result, intent, onDone, t]);
  const failure = result && !result.ok && (result.intent === intent || result.intent === null) ? result : null;
  return { fetcher, pending: fetcher.state !== "idle", failure, message: failure ? (failure.message ?? t(`errors.${failure.code}`)) : null };
}

// ───────────────────────────────────────────────────────────────── status transitions (05.01)

export function TransitionBar({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const f = useFormat();
  const [chosen, setChosen] = useState<TransitionOption | null>(null);
  const [tracking, setTracking] = useState("");
  const close = () => setChosen(null);
  const { fetcher, pending, message } = useIntent("transition", close);
  if (order.transitions.length === 0) return null;
  return (
    <section aria-labelledby="order-next" className="adm-section">
      <h2 id="order-next" className="adm-h2">
        {t("detail.next")}
      </h2>
      <div className="ord-actions">
        {order.transitions.map((option) => (
          <span key={option.to} className="inline-grid gap-1">
            <Key
              size="sm"
              icon={option.to === "cancelled" || option.to === "returned" ? "x-circle" : option.to === "shipped" ? "truck" : option.to === "delivered" ? "check-circle" : "arrow-right"}
              disabled={option.blocker !== null}
              aria-describedby={option.blocker ? `blocker-${option.to}` : undefined}
              onClick={() => {
                setTracking("");
                setChosen(option);
              }}
              className={option.to === "cancelled" || option.to === "returned" ? "enabled:[--on:var(--red-ink)]" : undefined}
            >
              {t(`transition.${option.to}`)}
            </Key>
            {option.blocker ? (
              <span id={`blocker-${option.to}`} className="type-caption text-ink-2">
                {t(`errors.${option.blocker}`)}{" "}
                {option.to === "shipped" && order.can.pack ? (
                  <Link to={`/admin/orders/${order.ref}/pack`} className="adm-link">
                    {t("detail.pack")}
                  </Link>
                ) : null}
              </span>
            ) : null}
          </span>
        ))}
      </div>
      {chosen ? (
        <ConfirmDialog
          open
          onClose={close}
          tone={chosen.to === "cancelled" || chosen.to === "returned" ? "destructive" : chosen.to === "shipped" ? "commit" : "neutral"}
          title={t(`transitionQ.${chosen.to}`, { ref: order.ref })}
          consequence={t(`transitionWhat.${chosen.to}`)}
          confirmLabel={t(`transition.${chosen.to}`)}
          impact={impactRows(t, chosen, f)}
          reason={chosen.reasonRequired ? { label: t("dialog.reason"), hint: t("dialog.reasonHint") } : { noteRequired: false, label: t("dialog.noteOptional") }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "transition", to: chosen.to, from: order.status, reason, trackingNo: tracking }, { method: "post" })}
        >
          {chosen.to === "shipped" ? <TextField label={t("ship.tracking")} optional hint={t("ship.trackingHint")} value={tracking} onChange={(event) => setTracking(event.target.value)} ltr /> : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function impactRows(t: ReturnType<typeof useOrdersT>, option: TransitionOption, f: ReturnType<typeof useFormat>): ImpactRow[] {
  const rows: ImpactRow[] = [];
  const { impact } = option;
  if (impact.units > 0) {
    if (option.to === "shipped") rows.push({ label: t("impact.unitsLeave"), value: t("impact.units", { count: impact.units }), negative: true });
    else if (option.to === "cancelled") rows.push({ label: t("impact.unitsReleased"), value: t("impact.units", { count: impact.units }) });
    else rows.push({ label: t("impact.unitsBack"), value: t("impact.units", { count: impact.units }) });
  }
  if (impact.usedUnits > 0) rows.push({ label: option.to === "shipped" ? t("impact.usedSold") : t("impact.usedReleased"), value: t("impact.units", { count: impact.usedUnits }), negative: option.to === "shipped" });
  if (impact.serialsReleased > 0) rows.push({ label: t("impact.serialsReleased"), value: t("impact.units", { count: impact.serialsReleased }) });
  if (impact.pendingRefundIqd > 0) rows.push({ label: t("impact.pendingRefund"), value: f.iqd(impact.pendingRefundIqd), negative: true });
  if (impact.couponFreed) rows.push({ label: t("impact.coupon"), value: t("impact.couponFreed") });
  if (impact.unpaidCancelled) rows.push({ label: t("impact.unpaid"), value: t("impact.unpaidCancelled") });
  if (option.to === "delivered") rows.push({ label: t("impact.books"), value: t("impact.revenueBooked") });
  if (rows.length === 0) rows.push({ label: t("impact.stockMoney"), value: t("impact.none") });
  return rows;
}

// ───────────────────────────────────────────────────────────────── items and totals

export function ItemsSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const f = useFormat();
  const withCost = order.costIqd !== undefined;
  const withMargin = order.marginIqd !== undefined;
  return (
    <Section id="order-items" title={t("detail.items", { count: order.units })}>
      <div className="hidden overflow-x-auto rounded-xs md:block" tabIndex={0} role="region" aria-labelledby="order-items">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t("detail.item")}</th>
              <th scope="col">{t("detail.sku")}</th>
              <th scope="col" className="is-num">
                {t("detail.qty")}
              </th>
              <th scope="col" className="is-num">
                {t("detail.unitPrice")}
              </th>
              <th scope="col" className="is-num">
                {t("detail.lineTotal")}
              </th>
              {withCost ? (
                <th scope="col" className="is-num">
                  {t("detail.unitCost")}
                </th>
              ) : null}
              {withMargin ? (
                <th scope="col" className="is-num">
                  {t("detail.margin")}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line) => (
              <tr key={line.id}>
                <td className="py-2">
                  <span className="grid gap-0.5">
                    <span className="type-strong">{line.name}</span>
                    {line.options ? <span className="type-caption text-ink-2">{line.options}</span> : null}
                    {line.usedUnitId ? <span className="type-caption text-ink-2">{t("detail.usedDevice")}</span> : null}
                    {line.serials.length ? (
                      <span className="type-caption text-ink-2">
                        {t("detail.serials")}:{" "}
                        {line.serials.map((serial, index) => (
                          <span key={serial.id}>
                            {index > 0 ? "، " : ""}
                            <bdi dir="ltr" className={serial.releasedAt ? "line-through" : undefined}>
                              {serial.serial}
                            </bdi>
                          </span>
                        ))}
                      </span>
                    ) : line.trackSerials ? (
                      <span className="type-caption text-warn">{t("detail.serialsMissing")}</span>
                    ) : null}
                    {line.refundedQty > 0 ? <span className="type-caption text-ink-2">{t("detail.refundedQty", { count: line.refundedQty })}</span> : null}
                  </span>
                </td>
                <td className="whitespace-nowrap">
                  <bdi dir="ltr">{line.sku}</bdi>
                </td>
                <td className="is-num">
                  <bdi>{f.number(line.qty)}</bdi>
                </td>
                <td className="is-num">
                  <bdi>{f.number(line.unitPriceIqd)}</bdi>
                </td>
                <td className="is-num">
                  <bdi>{f.number(line.totalIqd)}</bdi>
                </td>
                {withCost ? <td className="is-num">{line.unitCostIqd === null || line.unitCostIqd === undefined ? <span title={t("detail.costUnknown")}>—</span> : <bdi>{f.number(line.unitCostIqd)}</bdi>}</td> : null}
                {withMargin ? (
                  <td className={line.marginIqd !== null && line.marginIqd !== undefined && line.marginIqd < 0 ? "is-num is-negative" : "is-num"}>
                    {line.marginIqd === null || line.marginIqd === undefined ? <span title={t("detail.costUnknown")}>—</span> : <bdi>{f.number(line.marginIqd)}</bdi>}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="ord-cards md:hidden" aria-labelledby="order-items">
        {order.lines.map((line) => (
          <li key={line.id} className="ord-card">
            <p className="type-strong">{line.name}</p>
            {line.options ? <p className="type-caption text-ink-2">{line.options}</p> : null}
            <p className="ord-card__top type-body">
              <span>
                <bdi dir="ltr">{line.sku}</bdi> · {t("detail.qty")} <bdi className="nums">{f.number(line.qty)}</bdi> × <Money iqd={line.unitPriceIqd} />
              </span>
              <Money iqd={line.totalIqd} className="type-strong" />
            </p>
            {line.serials.length ? (
              <p className="type-caption text-ink-2">
                {t("detail.serials")}:{" "}
                {line.serials.map((serial, index) => (
                  <span key={serial.id}>
                    {index > 0 ? "، " : ""}
                    <bdi dir="ltr">{serial.serial}</bdi>
                  </span>
                ))}
              </p>
            ) : line.trackSerials ? (
              <p className="type-caption text-warn">{t("detail.serialsMissing")}</p>
            ) : null}
            {line.unitCostIqd !== undefined ? (
              <p className="type-caption text-ink-2">
                {t("detail.unitCost")}: {line.unitCostIqd === null ? t("detail.costUnknownShort") : <Money iqd={line.unitCostIqd} />}
                {line.marginIqd !== undefined ? (
                  <>
                    {" · "}
                    {t("detail.margin")}: {line.marginIqd === null ? t("detail.costUnknownShort") : <Money iqd={line.marginIqd} negative={line.marginIqd < 0} />}
                  </>
                ) : null}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="type-caption text-ink-2">{t("detail.amountsIqd")}</p>
      <dl className="ord-ledger max-w-sm ms-auto">
        <div>
          <dt>{t("detail.subtotal")}</dt>
          <dd>
            <Money iqd={order.totals.subtotalIqd} />
          </dd>
        </div>
        {order.totals.discountIqd > 0 ? (
          <div>
            <dt>
              {t("detail.discount")} {order.coupon ? <bdi dir="ltr">({order.coupon})</bdi> : null}
            </dt>
            <dd>
              <Money iqd={order.totals.discountIqd} negative />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t("detail.shipping")}</dt>
          <dd>
            <Money iqd={order.totals.shippingIqd} />
          </dd>
        </div>
        <div className="ord-ledger__total">
          <dt>{t("detail.total")}</dt>
          <dd>
            <Money iqd={order.totals.totalIqd} />
          </dd>
        </div>
        <div>
          <dt>{t("detail.paid")}</dt>
          <dd>
            <Money iqd={order.totals.paidIqd} />
          </dd>
        </div>
        {order.totals.refundedIqd > 0 ? (
          <div>
            <dt>{t("detail.refunded")}</dt>
            <dd>
              <Money iqd={order.totals.refundedIqd} negative />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t("detail.due")}</dt>
          <dd>
            <Money iqd={order.totals.dueIqd} />
          </dd>
        </div>
        {order.costIqd !== undefined ? (
          <div>
            <dt>{t("detail.cost")}</dt>
            <dd>{order.costIqd === null ? <span title={t("detail.costUnknown")}>— {t("detail.costUnknownShort")}</span> : <Money iqd={order.costIqd} />}</dd>
          </div>
        ) : null}
        {order.marginIqd !== undefined ? (
          <div>
            <dt>{t("detail.marginTotal")}</dt>
            <dd>{order.marginIqd === null ? <span title={t("detail.costUnknown")}>— {t("detail.costUnknownShort")}</span> : <Money iqd={order.marginIqd} negative={order.marginIqd < 0} />}</dd>
          </div>
        ) : null}
      </dl>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── payments, proofs, COD, refund requests

export function PaymentsSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  return (
    <Section id="order-payments" title={t("detail.payments")}>
      {order.payments.length === 0 ? <p className="type-body text-ink-2">{t("detail.noPayments")}</p> : null}
      <ul className="grid gap-3">
        {order.payments.map((payment) => (
          <li key={payment.id}>
            <PaymentCard order={order} payment={payment} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

const PAYMENT_TONE = { pending: "warn", pending_verification: "warn", paid: "ok", rejected: "bad", cancelled: "neutral" } as const;

function PaymentCard({ order, payment }: { order: OrderDetail; payment: PaymentView }) {
  const t = useOrdersT();
  const f = useFormat();
  const waiting = payment.status === "pending_verification";
  const current = payment.proofs.find((proof) => proof.status === "submitted") ?? null;
  const codCollectable = payment.method === "cod" && payment.status === "pending" && (order.status === "shipped" || order.status === "delivered") && order.can.recordCod;
  return (
    <article className="adm-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="type-strong">{t(`method.${payment.method}`)}</p>
        <Status tone={PAYMENT_TONE[payment.status]}>{t(`paymentRow.${payment.status}`)}</Status>
      </div>
      <Facts
        rows={[
          { label: payment.status === "paid" ? t("detail.received") : t("detail.amountDue"), value: <Money iqd={payment.amountIqd} /> },
          { label: t("detail.declared"), value: payment.declaredAmountIqd !== null ? <Money iqd={payment.declaredAmountIqd} /> : "—", hidden: payment.declaredAmountIqd === null },
          { label: t("detail.reference"), value: <bdi dir="ltr">{payment.reference}</bdi>, hidden: !payment.reference },
          { label: t("detail.verifiedBy"), value: payment.verifiedBy ? `${payment.verifiedBy} · ${payment.verifiedAt ? f.dateTime(payment.verifiedAt) : ""}` : "—", hidden: !payment.verifiedBy },
          { label: t("detail.rejectReason"), value: payment.rejectReason, hidden: !payment.rejectReason },
          { label: t("detail.refundable"), value: <Money iqd={payment.refundableIqd} />, hidden: payment.status !== "paid" },
        ]}
      />
      {payment.proofs.length ? (
        <ul className="grid gap-2">
          {payment.proofs.map((proof) => {
            const mismatch = proof.declaredAmountIqd !== payment.amountIqd && proof.status === "submitted";
            return (
              <li key={proof.id} className="grid gap-1 rounded-xs bg-niche p-3">
                <p className="flex flex-wrap items-center gap-2 type-body">
                  <Icon name="image" size={16} />
                  <span>{t(`proof.${proof.status}`)}</span>
                  <span className="type-caption text-ink-2">
                    <When at={proof.createdAt} />
                  </span>
                </p>
                <p className="type-body">
                  {t("proof.declared")} <Money iqd={proof.declaredAmountIqd} /> · {t("proof.due")} <Money iqd={payment.amountIqd} />
                </p>
                {mismatch ? <Status tone="warn">{t("proof.mismatch")}</Status> : null}
                {proof.duplicateOf ? (
                  <p className="flex items-start gap-1 type-body text-warn" role="note">
                    <Icon name="warning" size={18} className="mt-0.5 flex-none" />
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
                {proof.note ? <p className="type-caption text-ink-2">{t("proof.note", { note: proof.note })}</p> : null}
                {proof.reviewNote ? <p className="type-caption text-ink-2">{t("proof.reviewNote", { note: proof.reviewNote, by: proof.reviewedBy ?? "—" })}</p> : null}
                {proof.imageUrl ? (
                  <a href={proof.imageUrl} target="_blank" rel="noreferrer" className="adm-link inline-flex items-center gap-1">
                    <Icon name="arrow-square-out" size={16} />
                    {t("proof.open")}
                  </a>
                ) : (
                  <p className="type-caption text-ink-2">{t("proof.noImageAccess")}</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="ord-actions">
        {waiting && current && order.can.verify ? (
          <Key as={Link} to={`/admin/orders/proofs/${payment.id}`} size="sm" variant="ink" icon="seal-check">
            {t("proof.review")}
          </Key>
        ) : null}
        {codCollectable ? <CodDialog order={order} payment={payment} /> : null}
        {payment.status === "paid" && payment.refundableIqd > 0 && order.can.refund ? <RefundRequestDialog order={order} payment={payment} /> : null}
      </div>
    </article>
  );
}

function CodDialog({ order, payment }: { order: OrderDetail; payment: PaymentView }) {
  const t = useOrdersT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(payment.amountIqd));
  const { fetcher, pending, message } = useIntent("cod", () => setOpen(false));
  const typed = parseIqd(amount) ?? Number.NaN;
  // anything but the amount due asks for the override reason (an unreadable amount too: the server refuses it)
  const differs = typed !== payment.amountIqd;
  return (
    <>
      <Key size="sm" icon="money" onClick={() => setOpen(true)}>
        {t("cod.record")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("cod.title", { ref: order.ref })}
        consequence={t("cod.what")}
        confirmLabel={t("cod.record")}
        impact={[
          { label: t("cod.due"), value: f.iqd(payment.amountIqd) },
          { label: t("cod.collected"), value: Number.isFinite(typed) ? f.iqd(typed) : "—" },
        ]}
        reason={differs ? { label: t("cod.reason"), hint: order.can.override ? t("cod.overrideHint") : t("cod.noOverride") } : undefined}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "cod", amountIqd: amount, reason }, { method: "post" })}
      >
        <TextField label={t("cod.amount")} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} required ltr end={<span className="type-caption">{t("iqd")}</span>} />
      </ConfirmDialog>
    </>
  );
}

function RefundRequestDialog({ order, payment }: { order: OrderDetail; payment: PaymentView }) {
  const t = useOrdersT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(payment.refundableIqd));
  const [method, setMethod] = useState<"original" | "wallet" | "cash">("original");
  const [reference, setReference] = useState("");
  const [key, setKey] = useState(newKey);
  const { fetcher, pending, message, failure } = useIntent("refund", () => setOpen(false));
  const typed = parseIqd(amount) ?? Number.NaN;
  const transfer = payment.method === "bank_transfer" || payment.method === "zaincash";
  return (
    <>
      <Key
        size="sm"
        icon="hand-coins"
        onClick={() => {
          setAmount(String(payment.refundableIqd));
          setKey(newKey());
          setOpen(true);
        }}
      >
        {t("refund.request")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("refund.title", { ref: order.ref })}
        consequence={t("refund.what")}
        confirmLabel={t("refund.request")}
        impact={[
          { label: t("refund.leaves"), value: Number.isFinite(typed) ? f.iqd(typed) : "—", negative: true },
          { label: t("refund.ceiling"), value: f.iqd(payment.refundableIqd) },
        ]}
        reason={{ label: t("dialog.reason"), hint: t("refund.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "refund", paymentId: payment.id, amountIqd: amount, method, reference, reason, idempotencyKey: key }, { method: "post" })}
      >
        <div className="grid gap-3">
          <TextField label={t("refund.amount")} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} required ltr error={failure?.fields?.amountIqd} end={<span className="type-caption">{t("iqd")}</span>} />
          <Select
            label={t("refund.method")}
            value={method}
            onChange={(event) => setMethod(event.target.value as typeof method)}
            options={[
              { value: "original", label: t(`refund.methods.original_${payment.method}`) },
              ...(order.customer.kind === "customer" ? [{ value: "wallet", label: t("refund.methods.wallet") }] : []),
              { value: "cash", label: t("refund.methods.cash") },
            ]}
          />
          {method === "original" && transfer ? <TextField label={t("refund.reference")} optional hint={t("refund.referenceHint")} value={reference} onChange={(event) => setReference(event.target.value)} ltr /> : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

// ───────────────────────────────────────────────────────────────── refunds (four eyes)

export function RefundsSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  if (order.refunds.length === 0) return null;
  return (
    <Section id="order-refunds" title={t("detail.refunds")}>
      <ul className="grid gap-3">
        {order.refunds.map((refund) => (
          <li key={refund.id}>
            <RefundCard order={order} refund={refund} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

const REFUND_TONE = { pending: "warn", approved: "info", paid: "ok", rejected: "bad", cancelled: "neutral" } as const;

export function RefundCard({ order, refund }: { order: Pick<OrderDetail, "ref" | "can">; refund: RefundView }) {
  const t = useOrdersT();
  return (
    <article className="adm-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="type-strong">
          <Money iqd={refund.amountIqd} /> · {t(`refund.methods.${refund.method === "original" ? "original" : refund.method}`)}
        </p>
        <Status tone={REFUND_TONE[refund.status]}>{t(`refundStatus.${refund.status}`)}</Status>
      </div>
      <Facts
        rows={[
          { label: t("refund.reason"), value: refund.reason ?? "—" },
          { label: t("refund.requestedBy"), value: refund.createdBy ?? "—" },
          { label: t("refund.decidedBy"), value: refund.approvedBy ?? "—", hidden: !refund.approvedBy },
          { label: t("refund.reference"), value: <bdi dir="ltr">{refund.reference}</bdi>, hidden: !refund.reference },
          { label: t("refund.rejectReason"), value: refund.rejectReason, hidden: !refund.rejectReason },
          { label: t("refund.source"), value: refund.source ? t(`refund.sources.${refund.source}`) : "—", hidden: !refund.source },
        ]}
      />
      <p className="type-caption text-ink-2">
        <When at={refund.createdAt} />
      </p>
      {refund.status === "pending" ? (
        refund.mine ? (
          <p className="flex items-center gap-1 type-body text-ink-2">
            <Icon name="users" size={16} />
            {t("refund.mine")}
          </p>
        ) : order.can.approveRefund ? (
          <RefundDecision orderRef={order.ref} refund={refund} />
        ) : (
          <p className="type-caption text-ink-2">{t("refund.waitsApprover")}</p>
        )
      ) : null}
    </article>
  );
}

export function RefundDecision({ orderRef, refund, action }: { orderRef: string; refund: RefundView; action?: string }) {
  const t = useOrdersT();
  const f = useFormat();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [reference, setReference] = useState("");
  const { fetcher, pending, message } = useIntent("refund-decision", () => setMode(null));
  return (
    <div className="ord-actions">
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
          title={t(mode === "approve" ? "refund.approveQ" : "refund.rejectQ", { ref: orderRef })}
          consequence={t(mode === "approve" ? "refund.approveWhat" : "refund.rejectWhat")}
          confirmLabel={t(mode === "approve" ? "refund.approve" : "refund.reject")}
          impact={mode === "approve" ? [{ label: t("refund.leaves"), value: f.iqd(refund.amountIqd), negative: true }] : undefined}
          reason={mode === "reject" ? { label: t("dialog.reason"), hint: t("refund.rejectHint") } : { noteRequired: false, label: t("dialog.noteOptional") }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "refund-decision", refundId: refund.id, approve: mode === "approve" ? "1" : "0", note: reason, reference }, { method: "post", action })}
        >
          {mode === "approve" && refund.needsReference ? (
            <TextField label={t("refund.reference")} required hint={t("refund.referenceRequired")} value={reference} onChange={(event) => setReference(event.target.value)} ltr />
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── parcels and proof of delivery (05.04, 05.08)

export function ParcelsSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const canProof = order.can.deliveryProof && (order.status === "shipped" || order.status === "delivered");
  if (order.parcels.length === 0 && !canProof) return null;
  return (
    <Section id="order-parcels" title={t("detail.parcels")}>
      {order.parcels.length === 0 ? <p className="type-body text-ink-2">{t("detail.noParcels")}</p> : null}
      <ul className="grid gap-3">
        {order.parcels.map((parcel) => (
          <li key={parcel.id} className="adm-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="type-strong">{t("parcel.title", { number: parcel.number })}</p>
              <Status tone={parcel.status === "delivered" ? "ok" : parcel.status === "cancelled" ? "neutral" : "info"}>{t(`parcelStatus.${parcel.status}`)}</Status>
            </div>
            <ul className="type-body">
              {parcel.items.map((item) => (
                <li key={item.orderItemId}>
                  {item.name} × <bdi className="nums">{item.qty}</bdi>
                </li>
              ))}
            </ul>
            <Facts
              rows={[
                { label: t("parcel.tracking"), value: <bdi dir="ltr">{parcel.trackingNo}</bdi>, hidden: !parcel.trackingNo },
                { label: t("parcel.packedBy"), value: parcel.packedBy, hidden: !parcel.packedBy },
                { label: t("parcel.shippedAt"), value: <When at={parcel.shippedAt} />, hidden: !parcel.shippedAt },
                { label: t("parcel.deliveredAt"), value: <When at={parcel.deliveredAt} />, hidden: !parcel.deliveredAt },
                { label: t("parcel.receivedBy"), value: parcel.receivedByName, hidden: !parcel.receivedByName },
              ]}
            />
            {parcel.proofUrl ? (
              <a href={parcel.proofUrl} target="_blank" rel="noreferrer" className="adm-link inline-flex items-center gap-1">
                <Icon name="arrow-square-out" size={16} />
                {t("parcel.openProof")}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      {canProof ? <DeliveryProofForm /> : null}
    </Section>
  );
}

function DeliveryProofForm() {
  const t = useOrdersT();
  const formRef = useRef<HTMLFormElement>(null);
  const { fetcher, pending, failure, message } = useIntent("delivery-proof", () => formRef.current?.reset());
  return (
    <fetcher.Form ref={formRef} method="post" encType="multipart/form-data" className="grid gap-3 rounded-xs bg-niche p-4">
      <input type="hidden" name="intent" value="delivery-proof" />
      <p className="type-strong">{t("parcel.proofTitle")}</p>
      <p className="type-caption text-ink-2">{t("parcel.proofHint")}</p>
      <TextField name="receivedByName" label={t("parcel.receivedBy")} required error={failure?.fields?.receivedByName} />
      <label className="grid gap-1">
        <span className="type-label">{t("parcel.photo")}</span>
        <input type="file" name="file" accept="image/jpeg,image/png,image/webp" required className="type-body" />
      </label>
      <Failure message={message} />
      <div>
        <Key type="submit" size="sm" icon="upload-simple" loading={pending}>
          {t("parcel.saveProof")}
        </Key>
      </div>
    </fetcher.Form>
  );
}

// ───────────────────────────────────────────────────────────────── stock and reservations

export function StockSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  if (order.reservations.length === 0 && order.usedUnits.length === 0) return null;
  return (
    <Section id="order-stock" title={t("detail.stock")}>
      {order.reservations.length ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby="order-stock">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t("detail.sku")}</th>
                <th scope="col">{t("stock.location")}</th>
                <th scope="col" className="is-num">
                  {t("detail.qty")}
                </th>
                <th scope="col">{t("stock.status")}</th>
                <th scope="col">{t("stock.expires")}</th>
              </tr>
            </thead>
            <tbody>
              {order.reservations.map((row) => (
                <tr key={row.id}>
                  <td>
                    <bdi dir="ltr">{row.sku}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.location}</bdi>
                  </td>
                  <td className="is-num">
                    <bdi>{row.qty}</bdi>
                  </td>
                  <td>{t(`reservation.${row.status}`)}</td>
                  <td>{row.expiresAt ? <When at={row.expiresAt} /> : t("stock.noExpiry")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {order.usedUnits.length ? (
        <ul className="type-body">
          {order.usedUnits.map((unit) => (
            <li key={unit.id}>{t("stock.usedUnit", { grade: unit.grade ?? "—", status: t(`usedStatus.${unit.status}`) })}</li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── history and notifications (05.08)

export function HistorySection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const [audit, setAudit] = useState(false);
  const rows = order.history.filter((entry) => audit || entry.source === "order");
  return (
    <Section
      id="order-history"
      title={t("detail.history")}
      action={
        order.can.seeAudit ? (
          <Key size="sm" held={audit} onClick={() => setAudit((value) => !value)}>
            {t("history.showAudit")}
          </Key>
        ) : null
      }
    >
      <ol className="ord-timeline">
        {[...rows].reverse().map((entry) => (
          <HistoryItem key={`${entry.source}-${entry.id}`} entry={entry} />
        ))}
      </ol>
      <p className="type-caption text-ink-2">{t("history.immutable")}</p>
    </Section>
  );
}

function HistoryItem({ entry }: { entry: HistoryEntry }) {
  const t = useOrdersT();
  const f = useFormat();
  const vars: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(entry.data)) {
    if (value === null || value === undefined) continue;
    vars[key] = typeof value === "number" && /iqd|amount|total/i.test(key) ? f.iqd(value) : typeof value === "boolean" ? (value ? 1 : 0) : value;
  }
  if (typeof entry.data.from === "string") vars.fromLabel = t(`status.${entry.data.from}`);
  const key = entry.source === "audit" ? null : `history.${entry.kind}`;
  const sentence = key ? t(key, vars) : `${entry.kind}${entry.data.summary ? ` — ${entry.data.summary}` : ""}`;
  const who = entry.actor.kind === "employee" ? (entry.actor.name ?? t("history.employee")) : t(`history.actor.${entry.actor.kind}`);
  return (
    <li data-actor={entry.actor.kind}>
      <p className="type-body">
        <span className="type-strong">{who}</span> — {sentence === key ? entry.kind : sentence}
      </p>
      <p className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
        <When at={entry.at} />
        {entry.source === "audit" ? <span className="ord-flag">{t("history.audit")}</span> : null}
        {entry.reason ? <span className="ord-reason">{t("history.reason", { reason: entry.reason })}</span> : null}
      </p>
      {typeof entry.data.text === "string" ? <p className="type-body whitespace-pre-line">{entry.data.text}</p> : null}
    </li>
  );
}

export function NotificationsSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  return (
    <Section id="order-notifications" title={t("detail.notifications")}>
      <p className="adm-notice adm-notice--warn" role="note">
        <Icon name="info" size={18} />
        <span>{t("notify.boundary")}</span>
      </p>
      {order.notifications.length === 0 ? (
        <p className="type-body text-ink-2">{t("notify.none")}</p>
      ) : (
        <ul className="grid gap-2">
          {order.notifications.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 type-body">
              <span>
                {templateLabel(t, row.template)} · {t(`notify.channel.${row.channel}`)}
              </span>
              <span className="flex items-center gap-2">
                <Status tone={row.status === "sent" ? "ok" : row.status === "failed" ? "bad" : "neutral"}>{t(`notify.status.${row.status}`)}</Status>
                <span className="type-caption text-ink-2">
                  <When at={row.createdAt} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** A template's name in words, or its key when this module does not know it (another module's message). */
function templateLabel(t: ReturnType<typeof useOrdersT>, template: string): string {
  const key = `notify.template.${template}`;
  const label = t(key);
  return label === key ? template : label;
}

// ───────────────────────────────────────────────────────────────── side column

function SideCard({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="adm-card" aria-labelledby={id}>
      <h2 id={id} className="adm-h3">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function CustomerSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const c = order.customer;
  return (
    <SideCard id="order-customer" title={t("detail.customer")}>
      <Facts
        className="!grid-cols-1"
        rows={[
          { label: t("customer.name"), value: c.name ?? t("list.noName") },
          { label: t("customer.phone"), value: <PhoneText phone={c.phone} /> },
          { label: t("customer.kind"), value: c.kind === "customer" ? t("customer.registered") : t("customer.guest") },
          { label: t("customer.previous"), value: <bdi className="nums">{c.previousOrders}</bdi> },
          { label: t("customer.vip"), value: c.vipTier, hidden: !c.vipTier },
        ]}
      />
      {c.fraudFlag ? (
        <p className="flex items-center gap-1 type-body text-red-ink" role="note">
          <Icon name="warning" size={16} />
          {t("customer.fraudFlag")}
        </p>
      ) : null}
      {c.phone && !c.phone.full ? <p className="type-caption text-ink-2">{t("phoneMasked")}</p> : null}
    </SideCard>
  );
}

export function AddressSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const a = order.address;
  return (
    <SideCard id="order-address" title={t("detail.address")}>
      <Facts
        className="!grid-cols-1"
        rows={[
          { label: t("address.governorate"), value: a.governorate ?? "—" },
          { label: t("address.district"), value: a.district, hidden: !a.district },
          { label: t("address.area"), value: a.area ?? "—" },
          { label: t("address.address"), value: a.address ?? "—" },
          { label: t("address.notes"), value: a.notes, hidden: !a.notes },
          { label: t("address.preferred"), value: [a.preferredDay, a.preferredWindow ? t(`window.${a.preferredWindow}`) : null].filter(Boolean).join(" · "), hidden: !a.preferredDay && !a.preferredWindow },
        ]}
      />
      {a.preferredDay || a.preferredWindow ? <p className="type-caption text-ink-2">{t("address.preferenceNote")}</p> : null}
    </SideCard>
  );
}

/** Orders that can still be given to a packer (assignOrder refuses the others: assign_not_open). */
const ASSIGNABLE_STATUSES: readonly string[] = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing"];

export function AssignmentSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const { fetcher, pending, message } = useIntent("assign");
  return (
    <SideCard id="order-assignment" title={t("detail.assignment")}>
      <p className="type-body">{order.assignedTo ? t("assign.current", { name: order.assignedTo.name }) : t("assign.nobody")}</p>
      {order.can.assign && order.assignable.length && ASSIGNABLE_STATUSES.includes(order.status) ? (
        <fetcher.Form method="post" className="grid gap-2">
          <input type="hidden" name="intent" value="assign" />
          <Select
            name="employeeId"
            label={t("assign.to")}
            defaultValue={order.assignedTo?.id ?? ""}
            options={[{ value: "", label: t("assign.none") }, ...order.assignable.map((employee) => ({ value: employee.id, label: employee.name }))]}
          />
          <Failure message={message} />
          <div>
            <Key type="submit" size="sm" loading={pending}>
              {t("assign.save")}
            </Key>
          </div>
        </fetcher.Form>
      ) : null}
      {order.tasks.length ? (
        <ul className="grid gap-1">
          {order.tasks.map((task) => (
            <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 type-caption">
              <span>{task.assignedTo ?? "—"}</span>
              <Status tone={task.status === "done" ? "ok" : task.status === "cancelled" ? "neutral" : "info"}>{t(`task.${task.status}`)}</Status>
            </li>
          ))}
        </ul>
      ) : null}
    </SideCard>
  );
}

export function ReviewSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const [decision, setDecision] = useState<"clear" | "hold" | "flag" | null>(null);
  const { fetcher, pending, message } = useIntent("review", () => setDecision(null));
  const open = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped"].includes(order.status);
  const canFlag = order.can.review || order.can.note;
  return (
    <SideCard id="order-review" title={t("detail.review")}>
      <FlagExplanations flags={order.review.flags} />
      {order.review.status !== "none" ? (
        <p className="type-caption text-ink-2">
          {t(`reviewStatus.${order.review.status}`)}
          {order.review.reviewedBy ? ` · ${order.review.reviewedBy}` : ""}
          {order.review.reviewedAt ? (
            <>
              {" · "}
              <When at={order.review.reviewedAt} />
            </>
          ) : null}
        </p>
      ) : null}
      {open ? (
        <div className="ord-actions">
          {order.can.review && order.review.status !== "cleared" && (order.review.flags.length > 0 || order.review.status !== "none") ? (
            <Key size="sm" icon="seal-check" onClick={() => setDecision("clear")}>
              {t("review.clear")}
            </Key>
          ) : null}
          {order.can.review && order.review.status !== "blocked" ? (
            <Key size="sm" icon="lock" className="enabled:[--on:var(--red-ink)]" onClick={() => setDecision("hold")}>
              {t("review.hold")}
            </Key>
          ) : null}
          {canFlag && order.review.status === "none" ? (
            <Key size="sm" icon="flag" onClick={() => setDecision("flag")}>
              {t("review.flag")}
            </Key>
          ) : null}
        </div>
      ) : null}
      {decision ? (
        <ConfirmDialog
          open
          onClose={() => setDecision(null)}
          tone={decision === "hold" ? "destructive" : "neutral"}
          title={t(`review.${decision}Q`, { ref: order.ref })}
          consequence={t(`review.${decision}What`)}
          confirmLabel={t(`review.${decision}`)}
          reason={{ label: t("dialog.reason") }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "review", decision, reason }, { method: "post" })}
        />
      ) : null}
    </SideCard>
  );
}

export function PreorderSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const f = useFormat();
  const { fetcher, pending, failure, message } = useIntent("preorder");
  const p = order.preorder;
  const relevant = p.isPreorder || p.releaseAt !== null;
  const editable = order.can.preorder && ["new", "awaiting_payment", "payment_review", "confirmed", "preparing"].includes(order.status);
  if (!relevant && !editable) return null;
  const day = p.expectedAt ? new Date(p.expectedAt + 3 * 3_600_000).toISOString().slice(0, 10) : "";
  return (
    <SideCard id="order-preorder" title={t("detail.preorder")}>
      <Facts
        className="!grid-cols-1"
        rows={[
          { label: t("preorder.isPreorder"), value: p.isPreorder ? t("yes") : t("no") },
          { label: t("preorder.expected"), value: <When at={p.expectedAt} style="date" />, hidden: !p.expectedAt },
          { label: t("preorder.release"), value: <When at={p.releaseAt} style="date" />, hidden: !p.releaseAt },
          { label: t("preorder.deposit"), value: p.depositIqd !== null ? f.iqd(p.depositIqd) : "—", hidden: p.depositIqd === null },
        ]}
      />
      {p.depositIqd !== null ? <p className="type-caption text-ink-2">{t("preorder.depositBoundary")}</p> : null}
      {editable ? (
        <fetcher.Form method="post" className="grid gap-2">
          <input type="hidden" name="intent" value="preorder" />
          <Checkbox name="isPreorder" value="1" label={t("preorder.mark")} defaultChecked={p.isPreorder} />
          <TextField name="expectedDay" type="date" label={t("preorder.expected")} defaultValue={day} ltr error={failure?.fields?.expectedDay} />
          <TextField name="reason" label={t("dialog.reason")} required error={failure?.fields?.reason} />
          <Checkbox name="notify" value="1" label={t("preorder.notify")} defaultChecked />
          <Failure message={failure && !failure.fields ? message : null} />
          <div>
            <Key type="submit" size="sm" loading={pending}>
              {t("preorder.save")}
            </Key>
          </div>
        </fetcher.Form>
      ) : null}
    </SideCard>
  );
}

export function InvoiceSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const { fetcher, pending, message } = useIntent("invoice");
  if (!order.can.print) return null;
  const invoiceable = ["confirmed", "preparing", "shipped", "delivered", "returned"].includes(order.status);
  return (
    <SideCard id="order-invoice" title={t("detail.invoice")}>
      {order.invoice ? (
        <p className="type-body">
          {t("invoice.number")} <bdi dir="ltr">{order.invoice.number}</bdi> · <When at={order.invoice.issuedAt} />
        </p>
      ) : (
        <p className="type-body text-ink-2">{invoiceable ? t("invoice.notIssued") : t("invoice.notYet")}</p>
      )}
      <div className="ord-actions">
        {!order.invoice && invoiceable ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="invoice" />
            <Key type="submit" size="sm" icon="receipt" loading={pending}>
              {t("invoice.issue")}
            </Key>
          </fetcher.Form>
        ) : null}
        <Key as={Link} to={`/admin/orders/print?kind=invoice&id=${order.id}`} size="sm" icon="printer">
          {t("detail.printInvoice")}
        </Key>
      </div>
      <Failure message={message} />
    </SideCard>
  );
}

export function NotesSection({ order }: { order: OrderDetail }) {
  const t = useOrdersT();
  const formRef = useRef<HTMLFormElement>(null);
  const { fetcher, pending, failure, message } = useIntent("note", () => formRef.current?.reset());
  if (!order.can.note) return null;
  return (
    <SideCard id="order-notes" title={t("detail.notes")}>
      <fetcher.Form ref={formRef} method="post" className="grid gap-2">
        <input type="hidden" name="intent" value="note" />
        <TextArea name="text" label={t("note.text")} hint={t("note.hint")} rows={3} required error={failure?.fields?.text} />
        <Failure message={failure && !failure.fields ? message : null} />
        <div>
          <Key type="submit" size="sm" loading={pending}>
            {t("note.add")}
          </Key>
        </div>
      </fetcher.Form>
    </SideCard>
  );
}
