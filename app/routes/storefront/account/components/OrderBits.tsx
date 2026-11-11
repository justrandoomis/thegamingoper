import { useFormat, useT } from "~/i18n/react";
import type { OrderStatus, PaymentStatus } from "~/lib/dto";
import { MotionLink } from "~/motion";
import type { OrderSummary as OrderSummaryRow } from "~/server/services/orders/types";
import { cx } from "~/ui/cx";
import { DemoNote } from "~/ui/DemoNote";
import { Niche } from "~/ui/Niche";
import { Price } from "~/ui/Price";
import { fillNodes } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { Status, type StatusTone } from "~/ui/Tag";

/** Words and tone of an order's status (dot + words, never colour alone). */
export const ORDER_TONE: Record<OrderStatus, StatusTone> = {
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

export const PAYMENT_TONE: Record<PaymentStatus, StatusTone> = {
  unpaid: "neutral",
  cod_due: "info",
  pending_verification: "warn",
  paid: "ok",
  rejected: "bad",
  partially_refunded: "info",
  refunded: "neutral",
};

export function OrderStatusLine({ status, className }: { status: OrderStatus; className?: string }) {
  const t = useT("account");
  return (
    <Status tone={ORDER_TONE[status]} className={className}>
      {t(`status.${status}`)}
    </Status>
  );
}

export function PaymentStatusLine({ status, className }: { status: PaymentStatus; className?: string }) {
  const t = useT("account");
  return (
    <Status tone={PAYMENT_TONE[status]} className={className}>
      {t(`payment.${status}`)}
    </Status>
  );
}

/** One order in a list: picture, what was bought, reference and date, status, total. The whole row is one link. */
export function OrderRow({ order, headingLevel = 3 }: { order: OrderSummaryRow; headingLevel?: 2 | 3 }) {
  const t = useT("account");
  const f = useFormat();
  const Heading = `h${headingLevel}` as const;
  const more = order.itemCount - 1;
  return (
    <article className="relative grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-paper p-3 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center sm:p-4">
      <Niche as="span" ratio="1/1" tagZone={false} className="row-span-2 self-start rounded-md sm:row-span-1" aria-hidden="true">
        {order.image ? <ProductImage image={order.image} alt="" sizes="80px" pose={0} shadow={false} /> : null}
      </Niche>
      <div className="grid min-w-0 gap-1">
        <Heading className="type-strong text-ink">
          <MotionLink to={`/account/orders/${order.ref}`} nav="rise" className="after:absolute after:inset-0 after:rounded-lg after:content-['']">
            {more > 0 ? fillNodes(t("orders.andMore", { count: more }), { name: <BidiText key="name" text={order.firstItemName} /> }) : <BidiText text={order.firstItemName} />}
          </MotionLink>
        </Heading>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 type-caption text-ink-2">
          <bdi dir="ltr" className="nums">
            {order.ref}
          </bdi>
          <span aria-hidden="true">·</span>
          <span>{t("orders.placed", { date: f.date(order.placedAt) })}</span>
          {order.isDemo ? <DemoNote compact /> : null}
        </p>
        <OrderStatusLine status={order.status} />
      </div>
      <div className={cx("col-start-2 flex items-baseline justify-between gap-2 sm:col-start-3 sm:grid sm:justify-items-end")}>
        <span className="type-caption text-ink-2">{t("orders.total")}</span>
        <Price amountIqd={order.totalIqd} size="sm" approx="off" as="span" />
      </div>
    </article>
  );
}
