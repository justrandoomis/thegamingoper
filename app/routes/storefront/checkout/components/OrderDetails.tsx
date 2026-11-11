import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT, type Formatters } from "~/i18n/react";
import type { OrderLineView, OrderView } from "~/server/services/orders/types";
import { cx } from "~/ui/cx";
import { Niche } from "~/ui/Niche";
import { OrderSummary } from "~/ui/OrderSummary";
import { PriceTag, fillNodes } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { ProofSection, type JustSent } from "./ProofSection";
import { TransferDetails } from "./TransferDetails";

/**
 * One order as its shopper sees it (brief §4, DESIGN.md §9.16 "pending review", §9.18): what is happening now and
 * what to do next, the payment — for a transfer the instructions and the proof uploader — the steps so far, the
 * items and totals, the delivery details, shipments and refunds. Everything comes from the commerce core's OrderView
 * (statuses, amounts, instructions from settings); nothing is computed here.
 *
 * `mode`: "owner" — the confirmation link or the signed-in owner (a proof can be uploaded); "tracked" — found by
 * reference + phone on /track (read-only: uploading needs the confirmation link, the core's rule).
 * Payment words are precise: a transfer is "بانتظار التحقق" until a person approves it — never "paid" before.
 */
export type OrderDetailsProps = {
  order: OrderView;
  mode: "owner" | "tracked";
  /** Owner mode: what the proof upload sends to prove access (the token, or nothing for a signed-in owner). */
  access?: { ref: string; token: string | null };
  /** Heading level of the sections (the page's h1 is above them). */
  headingLevel?: 2 | 3;
  className?: string;
};

const STATUS_TONE: Record<OrderView["status"], StatusTone> = {
  new: "info",
  awaiting_payment: "warn",
  payment_review: "warn",
  confirmed: "ok",
  preparing: "info",
  shipped: "info",
  delivered: "ok",
  cancelled: "bad",
  returned: "neutral",
};

const TIMELINE_ICON: Partial<Record<string, IconName>> = {
  placed: "receipt",
  proof_submitted: "upload-simple",
  payment_rejected: "x-circle",
  payment_verified: "seal-check",
  cod_collected: "money",
  confirmed: "check-circle",
  preparing: "package",
  shipped: "truck",
  delivered: "house",
  cancelled: "x-circle",
  returned: "arrow-counter-clockwise",
  refunded: "hand-coins",
};

/** A Baghdad-time stamp; formatted on both sides with the same Intl data, the attribute is only a guard for ICU drift. */
export function When({ at, f, kind = "dateTime" }: { at: number; f: Formatters; kind?: "dateTime" | "date" }) {
  return (
    <time dateTime={new Date(at).toISOString()} suppressHydrationWarning>
      {kind === "date" ? f.date(at) : f.dateTime(at)}
    </time>
  );
}

const isTransfer = (method: string | null) => method === "bank_transfer" || method === "zaincash";

export function OrderDetails({ order, mode, access, headingLevel = 2, className }: OrderDetailsProps) {
  const t = useT("checkout");
  const f = useFormat();
  const H = `h${headingLevel}` as const;
  const [justSent, setJustSent] = useState<JustSent | null>(null);
  // A preview made from the shopper's own file lives until the page goes away.
  useEffect(() => () => (justSent ? URL.revokeObjectURL(justSent.previewUrl) : undefined), [justSent]);

  const payment = order.payment;
  const transfer = isTransfer(payment.method);
  const iqd = (amount: number) => <bdi className="nums font-semibold">{f.iqd(amount)}</bdi>;

  return (
    <div className={cx("grid gap-5", className)}>
      <StatusPanel order={order} />

      {/* ── payment ── */}
      <section aria-labelledby="order-payment" className="grid gap-3">
        <H id="order-payment" className="type-section text-ink">
          {t("order.payment.heading")}
        </H>
        <div className="grid gap-2 rounded-lg bg-paper p-4">
          <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="type-label text-ink">{payment.method ? t(`order.payment.method.${payment.method}`) : t("order.payment.method.none")}</span>
            <Status tone={paymentTone(order)}>{paymentStatusText(order, t)}</Status>
          </p>
          {payment.amountDueIqd > 0 && order.status !== "cancelled" ? (
            <p className="type-caption text-ink-2">{fillNodes(t("order.payment.due"), { amount: iqd(payment.amountDueIqd) })}</p>
          ) : null}
          {payment.paidIqd > 0 ? <p className="type-caption text-ink-2">{fillNodes(t("order.payment.paid"), { amount: iqd(payment.paidIqd) })}</p> : null}
          {payment.refundedIqd > 0 ? <p className="type-caption text-ink-2">{fillNodes(t("order.payment.refunded"), { amount: iqd(payment.refundedIqd) })}</p> : null}
        </div>

        {transfer && order.status === "awaiting_payment" && payment.instructions ? (
          <div className="grid gap-3">
            {payment.dueAt !== null && payment.canUploadProof ? (
              <p className="flex items-start gap-2 type-body text-ink">
                <Icon name="clock" size={18} className="mt-1 shrink-0 text-warn" />
                <span>{fillNodes(t("order.payment.deadline"), { deadline: <b className="font-semibold"><When at={payment.dueAt} f={f} /></b> })}</span>
              </p>
            ) : null}
            <TransferDetails destination={payment.instructions} amountIqd={payment.amountDueIqd} orderRef={order.ref} />
            {payment.canUploadProof && mode === "owner" && access ? (
              <ProofSection order={order} access={access} onSent={setJustSent} headingLevel={3} />
            ) : payment.canUploadProof ? (
              <p className="flex items-start gap-2 rounded-md bg-niche px-3 py-2.5 type-body text-ink">
                <Icon name="link" size={18} className="mt-1 shrink-0 text-ink-2" />
                {t("order.payment.trackedUpload")}
              </p>
            ) : null}
          </div>
        ) : null}

        {transfer && order.status === "payment_review" ? <SubmittedProof order={order} justSent={justSent} /> : null}
      </section>

      {/* ── what happened so far ── */}
      {order.timeline.length > 0 ? (
        <section aria-labelledby="order-timeline" className="grid gap-3">
          <H id="order-timeline" className="type-section text-ink">
            {t("order.timeline.heading")}
          </H>
          <ol className="grid gap-0 rounded-lg bg-paper px-4 py-1">
            {order.timeline.map((event, index) => (
              <li key={`${event.kind}:${event.at}:${index}`} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-niche text-ink" aria-hidden="true">
                  <Icon name={TIMELINE_ICON[event.kind] ?? "check"} size={16} />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="type-label text-ink">{t(`order.timeline.${event.kind}`)}</span>
                  <span className="type-caption text-ink-2">
                    <When at={event.at} f={f} />
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* ── shipments ── */}
      {order.shipments.length > 0 ? (
        <section aria-labelledby="order-shipments" className="grid gap-3">
          <H id="order-shipments" className="type-section text-ink">
            {t("order.shipment.heading")}
          </H>
          {order.shipments.map((shipment, index) => (
            <div key={`${shipment.trackingNo ?? "s"}:${index}`} className="grid gap-2 rounded-lg bg-paper p-4">
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span className="type-label text-ink">{shipment.carrierName ?? t("order.shipment.carrierUnknown")}</span>
                <Status tone={shipment.status === "delivered" ? "ok" : shipment.status === "failed" || shipment.status === "returned" ? "bad" : "info"}>{t(`order.shipment.status.${shipment.status}`)}</Status>
              </p>
              {shipment.trackingNo ? (
                <p className="flex flex-wrap items-center gap-x-2 type-caption text-ink-2">
                  {t("order.shipment.trackingNo")}{" "}
                  <bdi dir="ltr" className="nums text-ink">
                    {shipment.trackingNo}
                  </bdi>
                </p>
              ) : null}
              {shipment.trackingUrl ? (
                <TextLink href={shipment.trackingUrl} external rel="noopener noreferrer" className="justify-self-start">
                  {t("order.shipment.trackLink")}
                </TextLink>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {/* ── items and totals ── */}
      <section aria-labelledby="order-items" className="grid gap-3">
        <H id="order-items" className="type-section text-ink">
          {t("order.items.heading")}
        </H>
        <ul className="grid gap-2">
          {order.lines.map((line) => (
            <OrderLine key={line.id} line={line} />
          ))}
        </ul>
        <OrderSummary
          subtotalIqd={order.totals.subtotalIqd}
          discountIqd={order.totals.discountIqd}
          shippingIqd={order.totals.shippingIqd}
          totalIqd={order.totals.totalIqd}
          count={order.itemCount}
          coupon={order.coupon ? { code: order.coupon.code, label: "" } : null}
          shipping="governorate"
          title={null}
        />
      </section>

      {/* ── delivery ── */}
      <section aria-labelledby="order-delivery" className="grid gap-3">
        <H id="order-delivery" className="type-section text-ink">
          {t("order.delivery.heading")}
        </H>
        <dl className="grid gap-0 rounded-lg bg-paper px-4 py-1">
          {order.contact.name ? <Fact label={t("order.delivery.recipient")}>{order.contact.name}</Fact> : null}
          <Fact label={t("order.delivery.phone")}>
            <bdi dir="ltr" className="nums">
              {order.contact.phoneMasked}
            </bdi>
          </Fact>
          <Fact label={t("order.delivery.place")}>{[order.delivery.governorate, order.delivery.district, order.delivery.area].filter(Boolean).join(" · ")}</Fact>
          {order.delivery.address ? <Fact label={t("order.delivery.address")}>{order.delivery.address}</Fact> : null}
          {order.delivery.notes ? <Fact label={t("order.delivery.notes")}>{order.delivery.notes}</Fact> : null}
          {order.delivery.preferredDay || order.delivery.preferredWindow ? (
            <Fact label={t("order.delivery.preference")}>
              <span className="grid gap-0.5">
                <span>
                  {[
                    order.delivery.preferredDay ? (
                      // "YYYY-MM-DD" in Baghdad: midday UTC is the same day there.
                      <time key="d" dateTime={order.delivery.preferredDay} suppressHydrationWarning>
                        {f.date(Date.parse(`${order.delivery.preferredDay}T12:00:00Z`), "long")}
                      </time>
                    ) : null,
                    order.delivery.preferredWindow ? <span key="w">{t(`windows.${order.delivery.preferredWindow}`)}</span> : null,
                  ]
                    .filter(Boolean)
                    .flatMap((node, index) => (index === 0 ? [node] : [" · ", node]))}
                </span>
                <span className="type-caption text-ink-2">{t("address.timingHint")}</span>
              </span>
            </Fact>
          ) : null}
        </dl>
      </section>

      {/* ── refunds ── */}
      {order.refunds.length > 0 ? (
        <section aria-labelledby="order-refunds" className="grid gap-3">
          <H id="order-refunds" className="type-section text-ink">
            {t("order.refunds.heading")}
          </H>
          <ul className="grid gap-0 rounded-lg bg-paper px-4 py-1">
            {order.refunds.map((refund, index) => (
              <li key={`${refund.at}:${index}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-3 last:border-b-0">
                <span className="type-label text-ink">
                  {iqd(refund.amountIqd)} · {t(`order.refunds.method.${refund.method}`)}
                </span>
                <Status tone={refund.status === "paid" ? "ok" : "warn"}>{t(`order.refunds.status.${refund.status}`)}</Status>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** What is happening now and the next step, in words (never colour alone). */
function StatusPanel({ order }: { order: OrderView }) {
  const t = useT("checkout");
  const f = useFormat();
  const payment = order.payment;
  const iqd = (amount: number) => <bdi className="nums font-semibold">{f.iqd(amount)}</bdi>;
  let next: ReactNode = null;
  if (order.status === "new" && payment.method === "cod") {
    next = fillNodes(t("order.next.cod"), { phone: <bdi dir="ltr" className="nums">{order.contact.phoneMasked}</bdi>, total: iqd(payment.amountDueIqd || order.totals.totalIqd) });
  } else if (order.status === "awaiting_payment") {
    if (payment.canUploadProof) {
      const key = payment.proof.status === "rejected" ? "order.next.rejected" : "order.next.transfer";
      next = fillNodes(t(key), { total: iqd(payment.amountDueIqd), deadline: payment.dueAt !== null ? <b className="font-semibold"><When at={payment.dueAt} f={f} /></b> : "" });
    } else {
      next = t("order.next.windowClosed");
    }
  } else if (order.status === "payment_review") {
    next = t("order.next.review");
  } else if (order.status === "shipped" && payment.method === "cod" && payment.amountDueIqd > 0) {
    next = fillNodes(t("order.next.shippedCod"), { total: iqd(payment.amountDueIqd) });
  } else if (order.status === "confirmed" && payment.method === "wallet") {
    next = fillNodes(t("order.next.wallet"), { total: iqd(order.totals.totalIqd) });
  } else if (order.status === "cancelled") {
    next = order.refunds.some((refund) => refund.status === "pending") ? t("order.next.cancelledRefund") : t("order.next.cancelled");
  } else {
    next = t(`order.next.${order.status}`);
  }
  return (
    <div className="grid gap-2 rounded-lg bg-paper p-4" aria-live="polite">
      <Status tone={STATUS_TONE[order.status]} className="type-strong">
        {t(`order.status.${order.status}`)}
      </Status>
      <p className="type-body text-ink">{next}</p>
    </div>
  );
}

function paymentTone(order: OrderView): StatusTone {
  const status = order.payment.status;
  if (order.status === "cancelled") return "neutral";
  if (status === "paid") return "ok";
  if (status === "rejected" || order.payment.proof.status === "rejected") return "bad";
  if (status === "pending_verification" || (status === "unpaid" && isTransfer(order.payment.method))) return "warn";
  return "info";
}

function paymentStatusText(order: OrderView, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const payment = order.payment;
  if (order.status === "cancelled" && payment.status !== "refunded" && payment.status !== "partially_refunded" && payment.paidIqd === 0) return t("order.payment.status.cancelled");
  // A transfer waiting for its proof is "awaiting the transfer"; a rejected proof says so until a new one arrives.
  if (isTransfer(payment.method) && order.status === "awaiting_payment") return payment.proof.status === "rejected" ? t("order.payment.status.rejected") : t("order.payment.status.awaiting_transfer");
  return t(`order.payment.status.${payment.status}`);
}

/** The proof under review: the words, what the shopper declared, and the picture they just sent (this visit only). */
function SubmittedProof({ order, justSent }: { order: OrderView; justSent: JustSent | null }) {
  const t = useT("checkout");
  const f = useFormat();
  const proof = order.payment.proof;
  const panel = useRef<HTMLDivElement>(null);
  // Right after an upload the (taller) uploader is replaced by this panel: keep it where the shopper was looking.
  useLayoutEffect(() => {
    if (!justSent) return;
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "center" });
  }, [justSent]);
  return (
    <div ref={panel} tabIndex={-1} className="grid gap-2 rounded-lg bg-paper p-4 outline-none" data-proof="submitted">
      <Status tone="warn" className="font-semibold">
        {t("proof.submitted.title")}
      </Status>
      <p className="type-body text-ink">{t("proof.submitted.text")}</p>
      {proof.declaredAmountIqd !== null ? <p className="type-caption text-ink-2">{fillNodes(t("proof.submitted.amount"), { amount: <bdi className="nums">{f.iqd(proof.declaredAmountIqd)}</bdi> })}</p> : null}
      {proof.submittedAt !== null ? (
        <p className="type-caption text-ink-2">{fillNodes(t("proof.submitted.at"), { date: <When at={proof.submittedAt} f={f} /> })}</p>
      ) : null}
      {justSent ? (
        <span className="flex items-center gap-3">
          <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-md bg-niche">
            <img src={justSent.previewUrl} width={64} height={64} alt={t("proof.submitted.preview")} className="size-full object-cover" />
          </span>
          <bdi className="min-w-0 truncate type-caption text-ink-2">{justSent.name}</bdi>
        </span>
      ) : null}
    </div>
  );
}

function OrderLine({ line }: { line: OrderLineView }) {
  const t = useT("checkout");
  const f = useFormat();
  const facts = [
    line.qty > 1 ? t("order.items.unit", { price: "⁦" + f.iqd(line.unitPriceIqd) + "⁩" }) : null,
    line.grade ? t("order.items.grade", { grade: line.grade }) : null,
    line.warranty ? ("months" in line.warranty ? t("order.items.warrantyMonths", { count: line.warranty.months, n: f.number(line.warranty.months) }) : t("order.items.warrantyDays", { count: line.warranty.days, n: f.number(line.warranty.days) })) : null,
    line.refundedQty > 0 ? t("order.items.refunded", { count: line.refundedQty, n: f.number(line.refundedQty) }) : null,
  ].filter(Boolean);
  return (
    <li className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg bg-paper p-3">
      <Niche as="span" ratio="1/1" tagZone={false} fill={Boolean(line.image.mediaKey) && !line.image.isIllustration} className="rounded-md">
        <ProductImage image={line.image} alt="" sizes="64px" pose={0} shadow={false} fit="cover" />
      </Niche>
      <span className="grid min-w-0 gap-0.5">
        {line.href ? (
          <LocaleLink to={line.href} className="line-clamp-2 rounded-xs type-strong text-ink underline-offset-4 hover:underline">
            <BidiText text={line.name} />
          </LocaleLink>
        ) : (
          <span className="line-clamp-2 type-strong text-ink">
            <BidiText text={line.name} />
          </span>
        )}
        <span className="type-caption text-ink-2">{t("order.items.qty", { count: line.qty, n: f.number(line.qty) })}</span>
        {facts.length > 0 ? <span className="type-caption text-ink-2">{facts.join(" · ")}</span> : null}
      </span>
      <PriceTag size="line" priceIqd={line.lineTotalIqd} approx="off" />
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-line py-3 last:border-b-0">
      <dt className="type-caption text-ink-2">{label}</dt>
      <dd className="min-w-0 break-words type-body text-ink">{children}</dd>
    </div>
  );
}
