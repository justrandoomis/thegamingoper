import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT, type Formatters } from "~/i18n/react";
import type { OrderLineView, OrderView } from "~/server/services/orders/types";
import { cx } from "~/ui/cx";
import { Disclosure } from "~/ui/Disclosure";
import { Note, type NoteTone } from "~/ui/Note";
import { OrderSummary } from "~/ui/OrderSummary";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { orderStage, splitLineName } from "../checkout-form";
import { Adjustments, summaryCoupon, withFlash } from "./Adjustments";
import { Fact, Typed } from "./Fact";
import { DigitalCodes } from "./DigitalCodes";
import { OrderStages } from "./OrderStages";
import { ProofSection, type JustSent } from "./ProofSection";
import { TransferDetails } from "./TransferDetails";

/**
 * One order as its shopper sees it — the order status template of Design System v2 §6.11 (v2.1, client round 1: the
 * new order screen), shared by the order page and /track:
 *   · the status rail (./OrderStages, which the account's order page draws too) — the five real stages (استلمنا · تأكيد
 *     · تجهيز · في الطريق · تم التسليم), each with its icon in a circle (reached ones ink, the next ones raised clay),
 *     joined by a line that fills up to where the order is (it draws itself once under full motion; reduced motion: drawn);
 *   · the next step as the kit's Note, its tone by the order's state (cash on delivery: «سنؤكد طلبك قبل تجهيزه. تدفع …
 *     نقداً عند الاستلام.»; a transfer: where to send it, the deadline and the proof uploader, then «بانتظار التحقق»
 *     until a person approves it);
 *   · the shipments, ONE summary card (the items with their pictures, the totals with «الإجمالي» the one red figure and
 *     every discount in the saving colour, then the payment and the delivery — icon rows — side by side from 1024) and
 *     the dated history behind a disclosure.
 * Everything comes from the commerce core's OrderView (statuses, amounts, instructions from settings); nothing is
 * computed here but words.
 *
 * `mode`: "owner" — the confirmation link or the signed-in owner (a proof can be uploaded); "tracked" — found by
 * reference + phone on /track (read-only: uploading needs the confirmation link, the core's rule).
 * Payment words are precise: a transfer is «بانتظار التحقق» until a person approves it — never "paid" before.
 */
export type OrderDetailsProps = {
  order: OrderView;
  mode: "owner" | "tracked";
  /** Owner mode: what the proof upload sends to prove access (the token, or nothing for a signed-in owner). */
  access?: { ref: string; token: string | null };
  /** The stored transfer proof's picture (owner mode), shown again after a reload — a private path the file route authorizes. */
  proofUrl?: string | null;
  /** An account's order opened with its link: its digital codes open for the owner signed in (the core's rule) — say so. */
  codesSignIn?: boolean;
  /** Heading level of the sections (the page's own heading is above them). */
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
  cancelled: "neutral",
  returned: "neutral",
};

/** The next-step note: its tone (only the circle is tinted) and its icon, by the order's state. */
const NEXT_LOOK: Record<OrderView["status"], { tone: NoteTone; icon: IconName }> = {
  new: { tone: "info", icon: "receipt" },
  awaiting_payment: { tone: "warning", icon: "hourglass" },
  payment_review: { tone: "info", icon: "hourglass" },
  confirmed: { tone: "success", icon: "seal-check" },
  preparing: { tone: "info", icon: "package" },
  shipped: { tone: "info", icon: "truck" },
  delivered: { tone: "success", icon: "check-circle" },
  cancelled: { tone: "neutral", icon: "x-circle" },
  returned: { tone: "neutral", icon: "arrow-counter-clockwise" },
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

/** Each payment method's icon (never a brand logo). */
const METHOD_ICON: Record<string, IconName> = { cod: "money", wallet: "wallet", bank_transfer: "credit-card", zaincash: "device-mobile" };

/** A Baghdad-time stamp; formatted on both sides with the same Intl data, the attribute is only a guard for ICU drift. */
export function When({ at, f, kind = "dateTime" }: { at: number; f: Formatters; kind?: "dateTime" | "date" }) {
  return (
    <time dateTime={new Date(at).toISOString()} suppressHydrationWarning>
      {kind === "date" ? f.date(at, "long") : f.dateTime(at)}
    </time>
  );
}

const isTransfer = (method: string | null) => method === "bank_transfer" || method === "zaincash";

export function OrderDetails({ order, mode, access, proofUrl = null, codesSignIn = false, headingLevel = 2, className }: OrderDetailsProps) {
  const t = useT("checkout");
  const f = useFormat();
  const H = `h${headingLevel}` as const;
  /** The payment and the delivery sit inside the summary card: one level under its heading. */
  const Sub = headingLevel === 2 ? "h3" : "h4";
  const [justSent, setJustSent] = useState<JustSent | null>(null);
  // A preview made from the shopper's own file lives until the page goes away.
  useEffect(() => () => (justSent ? URL.revokeObjectURL(justSent.previewUrl) : undefined), [justSent]);

  const payment = order.payment;
  const transfer = isTransfer(payment.method);
  const iqd = (amount: number) => <bdi className="nums font-semibold text-ink">{f.iqd(amount)}</bdi>;
  const stage = orderStage(order.status);

  return (
    <div className={cx("co-order-body", className)}>
      {/* ── where the order is: the five real stages, a line that fills up to it ── */}
      {stage !== null ? (
        <section aria-labelledby={`${order.ref}-stages`} className="grid gap-4">
          <H id={`${order.ref}-stages`} className="type-h3 text-ink">
            {t("order.stages.label")}
          </H>
          <OrderStages stage={stage} />
        </section>
      ) : null}

      {/* ── the next step, by payment ── */}
      <section aria-labelledby={`${order.ref}-next`} className="grid gap-3">
        <H id={`${order.ref}-next`} className="type-h3 text-ink">
          {t("order.nextHeading")}
        </H>
        <NextStep order={order} />
        {transfer && order.status === "awaiting_payment" && payment.instructions ? (
          <>
            <div className="co-card">
              <TransferDetails destination={payment.instructions} amountIqd={payment.amountDueIqd} orderRef={order.ref} />
            </div>
            {payment.canUploadProof && mode === "owner" && access ? (
              <ProofSection order={order} access={access} onSent={setJustSent} headingLevel={headingLevel === 2 ? 3 : 2} />
            ) : payment.canUploadProof ? (
              <Note variant="line" icon="link">
                {t("order.payment.trackedUpload")}
              </Note>
            ) : null}
          </>
        ) : null}
        {transfer && order.status === "payment_review" ? <SubmittedProof order={order} justSent={justSent} storedUrl={mode === "owner" ? proofUrl : null} /> : null}
      </section>

      {/* ── digital codes: once paid, behind the token or the owner's session (revealed one at a time, audited) ── */}
      {order.digital && order.digital.length > 0 ? (
        <DigitalCodes lines={order.digital} mode={mode} token={access?.token ?? null} signInRef={codesSignIn ? order.ref : null} closed={order.status === "cancelled" || order.status === "returned"} headingLevel={headingLevel} />
      ) : null}

      {/* ── shipments ── */}
      {order.shipments.length > 0 ? (
        <section aria-labelledby={`${order.ref}-shipments`} className="grid gap-3">
          <H id={`${order.ref}-shipments`} className="type-h3 text-ink">
            {t("order.shipment.heading")}
          </H>
          {order.shipments.map((shipment, index) => (
            <div key={`${shipment.trackingNo ?? "s"}:${index}`} className="co-card grid gap-2">
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span className="type-sm-strong text-ink">{shipment.carrierName ?? t("order.shipment.carrierUnknown")}</span>
                <Status tone={shipment.status === "delivered" ? "ok" : shipment.status === "failed" || shipment.status === "returned" ? "bad" : "info"}>{t(`order.shipment.status.${shipment.status}`)}</Status>
              </p>
              {shipment.trackingNo ? (
                <p className="flex flex-wrap items-center gap-x-2 type-sm text-ink-2">
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

      {/* ── one summary card: items and totals, then payment and delivery side by side from 1024 ── */}
      <OrderSummary
        title={t("order.summary.heading")}
        headingLevel={headingLevel}
        lines={order.lines.map((line) => {
          // the name as sold is "<product> — <option>": the name, then the option value with the line's facts (§4.13)
          const { name, option } = splitLineName(line.name);
          const facts = lineFacts(line, t, f);
          // (not isolated: the page's direction orders «Nintendo Switch 2 Edition (نسخة فيزيائية)» as the cart line does)
          return withFlash({ id: line.id, name, optionsLabel: option ? `${option} · ${facts}` : facts, lineTotalIqd: line.lineTotalIqd, image: line.image }, order.adjustments?.flash[line.id], t, f);
        })}
        subtotalIqd={order.totals.subtotalIqd}
        discountIqd={order.totals.discountIqd}
        shippingIqd={order.totals.shippingIqd}
        totalIqd={order.totals.totalIqd}
        count={order.itemCount}
        coupon={summaryCoupon(order.adjustments?.discounts, order.coupon ? { code: order.coupon.code, label: "" } : null)}
        shipping="governorate"
        approx="off"
      >
        {/* every discount as charged, the waived delivery, a split payment's wallet part */}
        <Adjustments
          discounts={order.adjustments?.discounts ?? []}
          waiver={order.adjustments?.shippingWaiver ?? null}
          split={(order.walletPaidIqd ?? 0) > 0 ? { walletIqd: order.walletPaidIqd ?? 0, restIqd: order.totals.totalIqd - (order.walletPaidIqd ?? 0) } : null}
        />
        <div className="co-pair">
          <section aria-labelledby={`${order.ref}-payment`} className="grid content-start gap-3">
            <Sub id={`${order.ref}-payment`} className="type-sm-strong text-ink">
              {t("order.payment.heading")}
            </Sub>
            <dl className="co-facts">
              <Fact icon={(payment.method && METHOD_ICON[payment.method]) || "wallet"} label={t("payment.legend")}>
                <span className="grid justify-items-start gap-1.5">
                  <span className="font-semibold">{payment.method ? t(`order.payment.method.${payment.method}`) : t("order.payment.method.none")}</span>
                  <Status tone={paymentTone(order)}>{paymentStatusText(order, t)}</Status>
                </span>
              </Fact>
            </dl>
            {payment.amountDueIqd > 0 && order.status !== "cancelled" ? <p className="type-sm text-ink-2">{fillNodes(t("order.payment.due"), { amount: iqd(payment.amountDueIqd) })}</p> : null}
            {payment.paidIqd > 0 ? <p className="type-sm text-ink-2">{fillNodes(t("order.payment.paid"), { amount: iqd(payment.paidIqd) })}</p> : null}
            {payment.refundedIqd > 0 ? <p className="type-sm text-ink-2">{fillNodes(t("order.payment.refunded"), { amount: iqd(payment.refundedIqd) })}</p> : null}
          </section>
          <section aria-labelledby={`${order.ref}-delivery`} className="grid content-start gap-3">
            <Sub id={`${order.ref}-delivery`} className="type-sm-strong text-ink">
              {t("order.delivery.heading")}
            </Sub>
            <dl className="co-facts">
              {order.contact.name ? (
                <Fact icon="user" label={t("order.delivery.recipient")}>
                  <Typed>{order.contact.name}</Typed>
                </Fact>
              ) : null}
              <Fact icon="phone" label={t("order.delivery.phone")}>
                <bdi dir="ltr" className="nums">
                  {order.contact.phoneMasked}
                </bdi>
              </Fact>
              <Fact icon="map-pin" label={t("order.delivery.place")}>
                <Typed>{[order.delivery.governorate, order.delivery.district, order.delivery.area].filter(Boolean).join(" · ")}</Typed>
              </Fact>
              {order.delivery.address ? (
                <Fact icon="house" label={t("order.delivery.address")}>
                  <Typed>{order.delivery.address}</Typed>
                </Fact>
              ) : null}
              {order.delivery.notes ? (
                <Fact icon="chat-circle" label={t("order.delivery.notes")}>
                  <Typed>{order.delivery.notes}</Typed>
                </Fact>
              ) : null}
              {order.delivery.preferredDay || (order.delivery.preferredWindow && order.delivery.preferredWindow !== "any") ? (
                <Fact icon="clock" label={t("order.delivery.preference")}>
                  <span className="grid gap-0.5">
                    <span>
                      {[
                        order.delivery.preferredDay ? (
                          // "YYYY-MM-DD" in Baghdad: midday UTC is the same day there.
                          <time key="d" dateTime={order.delivery.preferredDay} suppressHydrationWarning>
                            {f.date(Date.parse(`${order.delivery.preferredDay}T12:00:00Z`), "long")}
                          </time>
                        ) : null,
                        order.delivery.preferredWindow && order.delivery.preferredWindow !== "any" ? <span key="w">{t(`windows.${order.delivery.preferredWindow}`)}</span> : null,
                      ]
                        .filter(Boolean)
                        .flatMap((node, index) => (index === 0 ? [node] : [" · ", node]))}
                    </span>
                    <span className="type-xs text-ink-2">{t("address.timingNote")}</span>
                  </span>
                </Fact>
              ) : null}
            </dl>
          </section>
        </div>
      </OrderSummary>

      {/* ── refunds ── */}
      {order.refunds.length > 0 ? (
        <section aria-labelledby={`${order.ref}-refunds`} className="grid gap-3">
          <H id={`${order.ref}-refunds`} className="type-h3 text-ink">
            {t("order.refunds.heading")}
          </H>
          <ul className="co-card grid">
            {order.refunds.map((refund, index) => (
              <li key={`${refund.at}:${index}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0">
                <span className="type-sm-strong text-ink">
                  {iqd(refund.amountIqd)} · {t(`order.refunds.method.${refund.method}`)}
                </span>
                <Status tone={refund.status === "paid" ? "ok" : "warn"}>{t(`order.refunds.status.${refund.status}`)}</Status>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── what happened so far, with dates (behind a disclosure: the stages above say where it is) ── */}
      {order.timeline.length > 0 ? (
        <Disclosure summary={t("order.timeline.heading")} icon="clock">
          <ol className="grid">
            {order.timeline.map((event, index) => (
              <li key={`${event.kind}:${event.at}:${index}`} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
                <span className="clay-disc co-fact__icon--static" aria-hidden="true">
                  <Icon name={TIMELINE_ICON[event.kind] ?? "check"} size={18} />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="type-sm-strong text-ink">{t(`order.timeline.${event.kind}`)}</span>
                  <span className="type-xs text-ink-2">
                    <When at={event.at} f={f} />
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** The order's state and the next step, in words (never colour alone) — the kit's Note, its tone by the state. */
function NextStep({ order }: { order: OrderView }) {
  const t = useT("checkout");
  const f = useFormat();
  const payment = order.payment;
  const iqd = (amount: number) => <bdi className="nums font-semibold text-ink">{f.iqd(amount)}</bdi>;
  let next: ReactNode = null;
  // cash still to collect (an order of 0 — all points and free delivery — is placed paid: nothing to hand over)
  if (order.status === "new" && payment.method === "cod" && payment.status === "cod_due") {
    next = fillNodes(t("order.next.cod"), { total: iqd(payment.amountDueIqd || order.totals.totalIqd) });
  } else if (order.status === "awaiting_payment") {
    if (payment.canUploadProof) {
      const key = payment.proof.status === "rejected" ? "order.next.rejected" : "order.next.transfer";
      next = fillNodes(t(key), { total: iqd(payment.amountDueIqd), deadline: payment.dueAt !== null ? <b className="font-semibold text-ink"><When at={payment.dueAt} f={f} /></b> : "" });
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
  const look = NEXT_LOOK[order.status];
  return (
    <Note tone={look.tone} icon={look.icon} title={t(`order.status.${order.status}`)} aria-live="polite" className="co-next">
      {next}
    </Note>
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

/**
 * The proof under review: the words, what the shopper declared, and its picture — the one just sent (this visit), or,
 * after a reload, the stored one through the private-file route (CONTRACTS §1 "Showing a stored proof back").
 */
function SubmittedProof({ order, justSent, storedUrl = null }: { order: OrderView; justSent: JustSent | null; storedUrl?: string | null }) {
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
    <div ref={panel} tabIndex={-1} className="co-card grid gap-2 outline-none" data-proof="submitted">
      <Status tone="warn" size="lg">
        {t("proof.submitted.title")}
      </Status>
      <p className="type-read text-ink">{t("proof.submitted.text")}</p>
      {proof.declaredAmountIqd !== null ? <p className="type-sm text-ink-2">{fillNodes(t("proof.submitted.amount"), { amount: <bdi className="nums">{f.iqd(proof.declaredAmountIqd)}</bdi> })}</p> : null}
      {proof.submittedAt !== null ? (
        <p className="type-sm text-ink-2">{fillNodes(t("proof.submitted.at"), { date: <When at={proof.submittedAt} f={f} /> })}</p>
      ) : null}
      {justSent ? (
        <span className="flex items-center gap-3">
          <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-sm bg-niche">
            <img src={justSent.previewUrl} width={64} height={64} alt={t("proof.submitted.preview")} className="size-full object-cover" />
          </span>
          <bdi className="min-w-0 truncate type-xs text-ink-2">{justSent.name}</bdi>
        </span>
      ) : storedUrl ? (
        <a href={storedUrl} target="_blank" rel="noopener" className="flex items-center gap-3 justify-self-start rounded-sm">
          <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-sm bg-niche">
            <img src={storedUrl} width={64} height={64} alt={t("proof.submitted.preview")} className="size-full object-cover" loading="lazy" decoding="async" />
          </span>
          <span className="type-xs text-ink-2 underline underline-offset-4">{t("proof.submitted.preview")}</span>
        </a>
      ) : null}
    </div>
  );
}

/** What a line of the order says under its name: quantity, unit price (more than one), grade, warranty, refunds. */
function lineFacts(line: OrderLineView, t: (key: string, vars?: Record<string, string | number>) => string, f: Formatters): string {
  return [
    t("order.items.qty", { count: line.qty, n: f.number(line.qty) }),
    line.qty > 1 ? t("order.items.unit", { price: "⁨" + iqdText(f, line.unitPriceIqd) + "⁩" }) : null,
    line.grade ? t("order.items.grade", { grade: line.grade }) : null,
    line.warranty ? ("months" in line.warranty ? t("order.items.warrantyMonths", { count: line.warranty.months, n: f.number(line.warranty.months) }) : t("order.items.warrantyDays", { count: line.warranty.days, n: f.number(line.warranty.days) })) : null,
    line.refundedQty > 0 ? t("order.items.refunded", { count: line.refundedQty, n: f.number(line.refundedQty) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
