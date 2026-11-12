import { data } from "react-router";

import type { Route } from "./+types/order";
import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getOrderForCustomer, normalizeOrderRef } from "~/server/services/orders/manage.server";
import type { OrderLineView, OrderView } from "~/server/services/orders/types";
import { DemoNote } from "~/ui/DemoNote";
import { Disclosure } from "~/ui/Disclosure";
import { Key } from "~/ui/Key";
import { OrderSummary, type SummaryLine } from "~/ui/OrderSummary";
import { Price } from "~/ui/Price";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { requireSignedIn } from "./account.server";
import { CopyKey, Notice } from "./components/FormBits";
import { OrderRail, OrderStatusLine, PaymentStatusLine, splitOption } from "./components/OrderBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { amount, grouped, HANDOFF } from "./components/text";

/**
 * One of the customer's orders — the commerce core's OrderView (getOrderForCustomer): another customer's reference is
 * simply "not found". The page reuses the order-status template of Design System v2 §6.11: the order number (type-code)
 * with a copy key and the «طلب تجريبي» tag, the five real states, the next step by payment, one summary card, payment
 * and delivery side by side, and «سؤال عن طلبك؟». Uploading a transfer photo happens on the checkout area's
 * /order/<ref> (the signed-in owner opens it without a token); returns and questions go to a person.
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
  const lines: SummaryLine[] = order.lines.map((line) => {
    const { name, option } = splitOption(line.name);
    return { id: line.id, name, optionsLabel: lineFacts(line, option), lineTotalIqd: line.lineTotalIqd, image: line.image };
  });

  /** The option value only, then the pieces in words, the unit price, the warranty as sold and what was refunded. */
  function lineFacts(line: OrderLineView, option: string | null): string {
    const facts = option ? [option] : [];
    facts.push(t("orders.pieces", { count: line.qty }));
    if (line.qty > 1) facts.push(t("order.unitPrice", { price: amount(iqdText(f, line.unitPriceIqd)) }));
    if (line.warranty) facts.push("months" in line.warranty ? t("order.warrantyMonths", { count: line.warranty.months }) : t("order.warrantyDays", { count: line.warranty.days }));
    if (line.refundedQty > 0) facts.push(t("order.refundedQty", { count: f.number(line.refundedQty) }));
    return facts.join(" · ");
  }

  return (
    <>
      <PageHead back={{ to: "/account/orders", label: t("order.back"), order: 1, nav: "rise" }} title={t("order.title")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="type-sm text-ink-2">{t("order.number")}</span>
          <bdi dir="ltr" className="type-code text-ink">
            {order.ref}
          </bdi>
          <CopyKey value={order.ref} label={t("order.copyRef")} />
          {order.isDemo ? <DemoNote variant="tag" what="order" /> : null}
        </div>
        <p className="type-sm text-ink-2">{t("order.placed", { date: f.dateTime(order.placedAt) })}</p>
      </PageHead>

      <section aria-labelledby="order-status-title" className="acct-card">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id="order-status-title" className="acct-card__title">
            {t("order.statusTitle")}
          </h2>
          <OrderStatusLine status={order.status} size="lg" />
        </div>
        {order.status === "cancelled" ? (
          <p className="type-body text-ink-2">{t("order.cancelledOn", { date: f.date(order.cancelledAt ?? order.placedAt, "long") })}</p>
        ) : order.status === "returned" ? (
          <p className="type-body text-ink-2">{t("order.returnedNote")}</p>
        ) : (
          <OrderRail status={order.status} className="pt-2" />
        )}
      </section>

      <NextStep order={order} now={loaderData.now} />

      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_20rem] 2xl:items-start">
        <div className="grid min-w-0 content-start gap-6">
          <OrderSummary
            subtotalIqd={order.totals.subtotalIqd}
            discountIqd={order.totals.discountIqd}
            shippingIqd={order.totals.shippingIqd}
            totalIqd={order.totals.totalIqd}
            count={order.itemCount}
            coupon={order.coupon ? { code: order.coupon.code, label: order.coupon.code } : null}
            lines={lines}
            approx="off"
            demo={order.isDemo}
          />

          {order.shipments.length > 0 ? (
            <section aria-labelledby="order-shipping-title" className="acct-card">
              <h2 id="order-shipping-title" className="acct-card__title">
                {t("order.shipments")}
              </h2>
              <ul className="grid gap-3">
                {order.shipments.map((shipment, index) => (
                  <li key={index} className="grid gap-1">
                    <Status tone={shipment.status === "delivered" ? "ok" : shipment.status === "failed" ? "bad" : "info"}>{t(`shipment.${shipment.status}`)}</Status>
                    {shipment.carrierName ? <span className="type-sm text-ink">{shipment.carrierName}</span> : null}
                    {shipment.trackingNo ? (
                      <span className="type-sm text-ink-2">
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
                      <TextLink as="a" href={shipment.trackingUrl} external className="justify-self-start">
                        {t("order.carrierPage")}
                      </TextLink>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {order.timeline.length > 0 ? (
            <Disclosure summary={t("order.history")} variant="panel">
              <ol className="grid gap-3">
                {order.timeline.map((step, index) => (
                  <li key={`${step.kind}-${step.at}-${index}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                    <span className="type-sm-strong text-ink">{t(`timeline.${step.kind}`)}</span>
                    <time className="type-xs text-ink-2" dateTime={new Date(step.at).toISOString()}>
                      {f.dateTime(step.at)}
                    </time>
                  </li>
                ))}
              </ol>
            </Disclosure>
          ) : null}
        </div>

        <div className="grid content-start gap-6 lg:grid-cols-2 2xl:grid-cols-1">
          <section aria-labelledby="order-payment-title" className="acct-card">
            <h2 id="order-payment-title" className="acct-card__title">
              {t("order.payment")}
            </h2>
            <dl className="acct-dl">
              <div>
                <dt>{t("order.method")}</dt>
                <dd>{t(`methods.${order.payment.method ?? "none"}`)}</dd>
              </div>
              <div>
                <dt>{t("order.paymentStatus")}</dt>
                <dd>
                  <PaymentStatusLine status={order.payment.status} />
                </dd>
              </div>
              <div>
                <dt>{t("order.due")}</dt>
                <dd>
                  <Price amountIqd={order.payment.amountDueIqd} size="sm" approx="off" as="span" />
                </dd>
              </div>
              {order.payment.paidIqd > 0 ? (
                <div>
                  <dt>{t("order.paid")}</dt>
                  <dd>
                    <Price amountIqd={order.payment.paidIqd} size="sm" approx="off" as="span" />
                  </dd>
                </div>
              ) : null}
              {order.payment.refundedIqd > 0 ? (
                <div>
                  <dt>{t("order.refunded")}</dt>
                  <dd>
                    <Price amountIqd={order.payment.refundedIqd} size="sm" approx="off" as="span" />
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section aria-labelledby="order-delivery-title" className="acct-card">
            <h2 id="order-delivery-title" className="acct-card__title">
              {t("order.delivery")}
            </h2>
            <div className="grid gap-1">
              <p className="type-sm-strong text-ink">
                {order.contact.name ? <>{order.contact.name} · </> : null}
                <bdi dir="ltr" className="nums">
                  {order.contact.phoneMasked}
                </bdi>
              </p>
              <p className="type-sm text-ink-2">{[order.delivery.governorate, order.delivery.district, order.delivery.area].filter(Boolean).join("، ")}</p>
              {order.delivery.address ? <p className="type-sm text-ink-2">{order.delivery.address}</p> : null}
              {order.delivery.notes ? <p className="type-xs text-ink-2">{order.delivery.notes}</p> : null}
            </div>
            {order.delivery.preferredDay ? (
              <div className="grid gap-1 border-t border-line pt-3">
                <p className="type-sm-strong text-ink">
                  {order.delivery.preferredWindow && order.delivery.preferredWindow !== "any"
                    ? t("order.preferredWindow", { day: preferredDay(f, order.delivery.preferredDay), window: t(`windows.${order.delivery.preferredWindow}`) })
                    : t("order.preferred", { day: preferredDay(f, order.delivery.preferredDay) })}
                </p>
                <p className="type-xs text-ink-2">{t("order.preferredNote")}</p>
              </div>
            ) : null}
          </section>

          {order.refunds.length > 0 ? (
            <section aria-labelledby="order-refunds-title" className="acct-card">
              <h2 id="order-refunds-title" className="acct-card__title">
                {t("order.refunds")}
              </h2>
              <ul className="grid">
                {order.refunds.map((refund, index) => (
                  <li key={index} className="flex items-start justify-between gap-3 border-b border-line py-2 first:pt-0 last:border-b-0 last:pb-0">
                    <span className="grid gap-0.5">
                      <span className="type-sm-strong text-ink">{t(`order.refundTo.${refund.method}`)}</span>
                      <span className="type-xs text-ink-2">
                        {f.date(refund.at, "long")} · {t(`order.refundStatus.${refund.status}`)}
                      </span>
                    </span>
                    <Price amountIqd={refund.amountIqd} size="sm" approx="off" as="span" />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="order-help-title" className="acct-card lg:col-span-2 2xl:col-span-1">
            <h2 id="order-help-title" className="acct-card__title">
              {t("order.helpTitle")}
            </h2>
            <p className="type-sm text-ink-2">
              {fillNodes(t("order.helpText"), {
                ref: (
                  <bdi key="ref" dir="ltr" className="nums">
                    {order.ref}
                  </bdi>
                ),
              })}
            </p>
            <div className="flex flex-wrap gap-x-6">
              <TextLink as={LocaleLink} to={HANDOFF} icon="chat-circle" arrow={false}>
                {t("common.talk")}
              </TextLink>
              {order.status === "delivered" ? (
                <TextLink as={LocaleLink} to="/account/returns" icon="arrow-counter-clockwise" arrow={false}>
                  {t("order.askReturn")}
                </TextLink>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/** "2026-11-14" → a date in the visitor's language (noon Baghdad, so the calendar day never shifts). */
function preferredDay(f: ReturnType<typeof useFormat>, day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  return f.date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 9), "long");
}

/**
 * What the shopper has to do about the order now, by payment (§6.11): cash on delivery says when they pay; a transfer
 * shows the store's details, the deadline and the ONE primary «ارفع صورة الحوالة» (the upload lives on /order/<ref>);
 * a photo under review, a rejected photo and a missed deadline each say so. Nothing once the order is closed.
 */
function NextStep({ order, now }: { order: OrderView; now: number }) {
  const t = useT("account");
  const f = useFormat();
  const { payment } = order;
  if (order.status === "cancelled" || order.status === "returned" || order.status === "delivered") return null;

  if (payment.canUploadProof) {
    const instructions = payment.instructions;
    const rows =
      instructions?.method === "bank_transfer"
        ? [
            { label: t("order.card"), value: instructions.accountNumber, code: true },
            { label: t("order.recipient"), value: instructions.recipientName, code: false },
          ]
        : instructions?.method === "zaincash"
          ? [{ label: t("order.zainNumber"), value: instructions.number, code: true }]
          : [];
    return (
      <section aria-labelledby="order-next-title" className="acct-card">
        <h2 id="order-next-title" className="acct-card__title">
          {t("order.next.title")}
        </h2>
        {payment.proof.status === "rejected" && payment.proof.rejectReason ? (
          <p role="alert" className="form-alert flex items-start gap-1.5">
            <Icon name="warning-circle" size={20} className="mt-0.5 shrink-0" />
            <span>{t("order.next.rejected", { reason: payment.proof.rejectReason })}</span>
          </p>
        ) : null}
        <p className="type-body text-ink">{t("order.next.transfer", { amount: amount(iqdText(f, payment.amountDueIqd)) })}</p>
        {rows.length > 0 ? (
          <div className="grid rounded-sm border border-line px-4">
            {rows.map((row) => (
              <div key={row.label} className="acct-copy">
                <div className="grid min-w-0 gap-0.5">
                  <span className="acct-copy__label">{row.label}</span>
                  {row.code ? (
                    <bdi dir="ltr" className="type-code text-ink">
                      {grouped(row.value)}
                    </bdi>
                  ) : (
                    <span className="type-sm-strong text-ink">{row.value}</span>
                  )}
                </div>
                <CopyKey value={row.value} label={t("order.copyField", { field: row.label })} />
              </div>
            ))}
          </div>
        ) : null}
        {payment.dueAt ? <p className="type-sm text-ink-2">{t("order.next.dueBy", { date: f.dateTime(payment.dueAt) })}</p> : null}
        <Key as={LocaleLink} to={`/order/${order.ref}`} variant="primary" icon="upload-simple" className="justify-self-start">
          {t("order.next.upload")}
        </Key>
      </section>
    );
  }

  if (payment.proof.status === "submitted" && (order.status === "payment_review" || payment.status === "pending_verification")) {
    return (
      <Notice tone="warn" title={t("order.next.title")}>
        {t("order.next.review")}
      </Notice>
    );
  }

  // A transfer still awaited after its deadline: say so instead of instructions that no longer apply.
  if (order.status === "awaiting_payment" && payment.dueAt !== null && payment.dueAt <= now) {
    return (
      <Notice tone="warn" title={t("order.next.title")}>
        {t("order.next.closed")}
      </Notice>
    );
  }

  if (payment.method === "cod" && payment.status === "cod_due") {
    const total = amount(iqdText(f, payment.amountDueIqd || order.totals.totalIqd));
    return <Notice title={t("order.next.title")}>{order.status === "new" ? t("order.next.cod", { total }) : t("order.next.codLater", { total })}</Notice>;
  }
  return null;
}
