import { data } from "react-router";

import type { Route } from "./+types/order";
import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getOrderForCustomer, normalizeOrderRef } from "~/server/services/orders/manage.server";
import type { OrderView } from "~/server/services/orders/types";
import { DemoNote } from "~/ui/DemoNote";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { OrderSummary } from "~/ui/OrderSummary";
import { Price } from "~/ui/Price";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { requireSignedIn } from "./account.server";
import { CopyKey, FormNotice } from "./components/FormBits";
import { OrderStatusLine, PaymentStatusLine } from "./components/OrderBits";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { amount } from "./components/text";

/**
 * One of the customer's orders — the commerce core's OrderView (getOrderForCustomer): another customer's reference is
 * simply "not found". Payment actions (uploading a transfer photo) live on the order page of the checkout area
 * (/order/<ref>); this page links there. Returns and problems go to support with the reference.
 */
export const handle = { nav: "rise" } satisfies MotionHandle;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const ref = normalizeOrderRef(params.ref);
  const order = ref ? await getOrderForCustomer(db, customer.id, ref, ctx.locale, ctx.now) : null;
  if (!order) throw data({ error: "not_found" }, { status: 404 });
  return { order, now: ctx.now };
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "order", { ref: args.loaderData?.order.ref ?? "" });

export default function OrderPage({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const f = useFormat();
  const { order } = loaderData;
  const refNode = (
    <bdi key="ref" dir="ltr" className="nums">
      {order.ref}
    </bdi>
  );
  return (
    <>
      <PageHead
        back={{ to: "/account/orders", label: t("order.back"), order: 1, nav: "rise" }}
        title={fillNodes(t("meta.order"), { ref: refNode })}
        lead={t("order.placed", { date: f.dateTime(order.placedAt) })}
        aside={<CopyKey value={order.ref} label={t("order.copyRef")} />}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-paper p-4">
        <OrderStatusLine status={order.status} className="type-label" />
        <PaymentStatusLine status={order.payment.status} />
        {order.isDemo ? <DemoNote compact /> : null}
      </div>
      {order.isDemo ? <FormNotice tone="info">{t("order.demo")}</FormNotice> : null}

      <PaymentAction order={order} now={loaderData.now} />

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-8">
          <Section id="items" title={t("order.items")}>
            <ul className="grid gap-2">
              {order.lines.map((line) => (
                <li key={line.id} className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg bg-paper p-3">
                  <Niche as="span" ratio="1/1" tagZone={false} className="rounded-md" aria-hidden="true">
                    <ProductImage image={line.image} alt="" sizes="64px" pose={0} shadow={false} />
                  </Niche>
                  <div className="grid min-w-0 gap-1">
                    {line.href ? (
                      <LocaleLink to={line.href} className="type-strong text-ink underline-offset-4 hover:underline">
                        <BidiText text={line.name} />
                      </LocaleLink>
                    ) : (
                      <span className="type-strong text-ink">
                        <BidiText text={line.name} />
                      </span>
                    )}
                    <span className="type-caption text-ink-2">
                      {t("order.qty", { qty: f.number(line.qty) })}
                      {line.qty > 1 ? <> · {t("order.unitPrice", { price: amount(iqdText(f, line.unitPriceIqd)) })}</> : null}
                    </span>
                    {line.warranty ? (
                      <span className="flex items-center gap-1 type-caption text-ink-2">
                        <Icon name="shield-check" size={16} />
                        {"months" in line.warranty ? t("order.warrantyMonths", { count: line.warranty.months }) : t("order.warrantyDays", { count: line.warranty.days })}
                      </span>
                    ) : null}
                    {line.refundedQty > 0 ? <Status tone="info">{t("order.refundedQty", { count: f.number(line.refundedQty) })}</Status> : null}
                  </div>
                  <Price amountIqd={line.lineTotalIqd} size="sm" approx="off" as="span" />
                </li>
              ))}
            </ul>
          </Section>

          <Section id="timeline" title={t("order.timeline")}>
            <ol className="grid gap-0 rounded-lg bg-paper p-4">
              {order.timeline.map((step, index) => (
                <li key={`${step.kind}-${step.at}-${index}`} className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 pb-4 last:pb-0">
                  <span className="relative flex justify-center" aria-hidden="true">
                    <span className="mt-1.5 size-2.5 rounded-full bg-ink" />
                    {index < order.timeline.length - 1 ? <span className="absolute inset-y-4 w-px bg-line-strong" /> : null}
                  </span>
                  <span className="grid gap-0.5">
                    <span className="type-label text-ink">{t(`timeline.${step.kind}`)}</span>
                    <time className="type-caption text-ink-2" dateTime={new Date(step.at).toISOString()}>
                      {f.dateTime(step.at)}
                    </time>
                  </span>
                </li>
              ))}
            </ol>
          </Section>

          {order.shipments.length > 0 ? (
            <Section id="shipping" title={t("order.shipments")}>
              <ul className="grid gap-2">
                {order.shipments.map((shipment, index) => (
                  <li key={index} className="grid gap-1 rounded-lg bg-paper p-4">
                    <Status tone={shipment.status === "delivered" ? "ok" : shipment.status === "failed" ? "bad" : "info"}>{t(`shipment.${shipment.status}`)}</Status>
                    {shipment.carrierName ? <span className="type-body text-ink">{shipment.carrierName}</span> : null}
                    {shipment.trackingNo ? (
                      <span className="type-caption text-ink-2">
                        {fillNodes(t("order.trackingNo"), {
                          no: (
                            <bdi key="no" dir="ltr" className="nums">
                              {shipment.trackingNo}
                            </bdi>
                          ),
                        })}
                      </span>
                    ) : null}
                    {shipment.trackingUrl ? (
                      <TextLink as="a" href={shipment.trackingUrl} external>
                        {t("order.carrierPage")}
                      </TextLink>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>

        <div className="grid content-start gap-6">
          <OrderSummary
            subtotalIqd={order.totals.subtotalIqd}
            discountIqd={order.totals.discountIqd}
            shippingIqd={order.totals.shippingIqd}
            totalIqd={order.totals.totalIqd}
            count={order.itemCount}
            coupon={order.coupon ? { code: order.coupon.code, label: order.coupon.code } : null}
            approx="off"
            title={t("order.totals")}
          />

          <section aria-labelledby="payment-title" className="grid gap-2 rounded-lg bg-paper p-4">
            <h2 id="payment-title" className="type-sub text-ink">
              {t("order.payment")}
            </h2>
            <dl className="grid gap-1.5 type-body">
              <Row label={t("order.method")}>{t(`methods.${order.payment.method ?? "none"}`)}</Row>
              <Row label={t("order.paymentStatus")}>
                <PaymentStatusLine status={order.payment.status} />
              </Row>
              <Row label={t("order.due")}>
                <Price amountIqd={order.payment.amountDueIqd} size="sm" approx="off" as="span" />
              </Row>
              {order.payment.paidIqd > 0 ? (
                <Row label={t("order.paid")}>
                  <Price amountIqd={order.payment.paidIqd} size="sm" approx="off" as="span" />
                </Row>
              ) : null}
              {order.payment.refundedIqd > 0 ? (
                <Row label={t("order.refunded")}>
                  <Price amountIqd={order.payment.refundedIqd} size="sm" approx="off" as="span" />
                </Row>
              ) : null}
            </dl>
          </section>

          <section aria-labelledby="delivery-title" className="grid gap-2 rounded-lg bg-paper p-4">
            <h2 id="delivery-title" className="type-sub text-ink">
              {t("order.delivery")}
            </h2>
            <p className="type-body text-ink">
              {order.contact.name ? <>{order.contact.name} · </> : null}
              <bdi dir="ltr" className="nums">
                {order.contact.phoneMasked}
              </bdi>
            </p>
            <p className="type-body text-ink-2">
              {[order.delivery.governorate, order.delivery.district, order.delivery.area].filter(Boolean).join("، ")}
              {order.delivery.address ? (
                <>
                  <br />
                  {order.delivery.address}
                </>
              ) : null}
            </p>
            {order.delivery.notes ? <p className="type-caption text-ink-2">{order.delivery.notes}</p> : null}
            {order.delivery.preferredDay ? (
              <div className="grid gap-1 border-t border-line pt-2">
                <p className="type-label text-ink">
                  {order.delivery.preferredWindow && order.delivery.preferredWindow !== "any"
                    ? t("order.preferredWindow", { day: preferredDay(f, order.delivery.preferredDay), window: t(`windows.${order.delivery.preferredWindow}`) })
                    : t("order.preferred", { day: preferredDay(f, order.delivery.preferredDay) })}
                </p>
                <p className="type-caption text-ink-2">{t("order.preferredNote")}</p>
              </div>
            ) : null}
          </section>

          {order.refunds.length > 0 ? (
            <section aria-labelledby="refunds-title" className="grid gap-2 rounded-lg bg-paper p-4">
              <h2 id="refunds-title" className="type-sub text-ink">
                {t("order.refunds")}
              </h2>
              <ul className="grid gap-2">
                {order.refunds.map((refund, index) => (
                  <li key={index} className="flex items-start justify-between gap-3 border-b border-line pb-2 last:border-b-0 last:pb-0">
                    <span className="grid gap-0.5">
                      <span className="type-label text-ink">{t(`order.refundTo.${refund.method}`)}</span>
                      <span className="type-caption text-ink-2">
                        {f.date(refund.at)} · {t(`order.refundStatus.${refund.status}`)}
                      </span>
                    </span>
                    <Price amountIqd={refund.amountIqd} size="sm" approx="off" as="span" />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="help-title" className="panel grid gap-2 p-4">
            <h2 id="help-title" className="type-sub text-ink">
              {t("order.helpTitle")}
            </h2>
            <p className="type-caption text-ink-2">{t("order.helpText")}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Key as={LocaleLink} to={`/support?order=${encodeURIComponent(order.ref)}`} size="sm" icon="lifebuoy">
                {t("order.help")}
              </Key>
              {order.status === "delivered" ? (
                <Key as={LocaleLink} to={`/support?order=${encodeURIComponent(order.ref)}&topic=return`} size="sm" variant="quiet" icon="arrow-counter-clockwise">
                  {t("order.askReturn")}
                </Key>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="type-caption text-ink-2">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

/** "2026-11-14" → a date in the visitor's language (noon Baghdad, so the calendar day never shifts). */
function preferredDay(f: ReturnType<typeof useFormat>, day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  return f.date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 9), "long");
}

/** What the shopper has to do about the payment now (a transfer to send or a photo to fix), if anything. */
function PaymentAction({ order, now }: { order: OrderView; now: number }) {
  const t = useT("account");
  const f = useFormat();
  const { payment } = order;
  if (payment.proof.status === "submitted" && order.status === "payment_review") {
    return <FormNotice tone="warn">{t("order.proofSubmitted")}</FormNotice>;
  }
  if (!payment.canUploadProof) {
    // A transfer still awaited after its deadline: say so instead of showing instructions that no longer apply.
    const late = order.status === "awaiting_payment" && payment.dueAt !== null && payment.dueAt <= now;
    return late ? <FormNotice tone="warn">{t("order.windowClosed")}</FormNotice> : null;
  }
  const instructions = payment.instructions;
  return (
    <section aria-labelledby="pay-now" className="grid gap-3 rounded-lg border-[1.5px] border-line-strong bg-paper p-4">
      <h2 id="pay-now" className="type-sub text-ink">
        {t("order.payment")}
      </h2>
      {payment.proof.status === "rejected" && payment.proof.rejectReason ? (
        <FormNotice tone="bad">{t("order.proofRejected", { reason: payment.proof.rejectReason })}</FormNotice>
      ) : null}
      {instructions ? (
        <div className="grid gap-1 type-body text-ink">
          <p>{t("order.sendTo", { amount: amount(iqdText(f, payment.amountDueIqd)) })}</p>
          <p className="type-label">
            {instructions.method === "bank_transfer"
              ? fillNodes(t("order.bankTo"), {
                  number: (
                    <bdi key="n" dir="ltr" className="nums">
                      {instructions.accountNumber}
                    </bdi>
                  ),
                  name: instructions.recipientName,
                })
              : fillNodes(t("order.zainTo"), {
                  number: (
                    <bdi key="n" dir="ltr" className="nums">
                      {instructions.number}
                    </bdi>
                  ),
                })}
          </p>
        </div>
      ) : null}
      {payment.dueAt ? <p className="type-caption text-ink-2">{t("order.dueBy", { date: f.dateTime(payment.dueAt) })}</p> : null}
      <Key as={LocaleLink} to={`/order/${order.ref}`} icon="upload-simple" className="justify-self-start">
        {t("order.uploadProof")}
      </Key>
    </section>
  );
}
