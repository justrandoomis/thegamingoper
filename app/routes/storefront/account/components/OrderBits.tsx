import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { OrderStatus, PaymentStatus } from "~/lib/dto";
import { MotionLink } from "~/motion";
import type { OrderSummary as OrderSummaryRow } from "~/server/services/orders/types";
import { BidiText } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { DemoNote } from "~/ui/DemoNote";
import { Niche } from "~/ui/Niche";
import { Price } from "~/ui/Price";
import { ProductImage } from "~/ui/ProductCard";
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

/**
 * A state as the kit's dot and words; `pill` (v2.1, the reference «طلباتي»): on its tone's tint in a pill — the words
 * and the dot still say it, never the colour alone.
 */
export function StatusPill({ tone, size, className, children }: { tone: StatusTone; size?: "md" | "lg"; className?: string; children: ReactNode }) {
  return (
    <span className={cx("acct-pill", tone !== "neutral" && tone !== "out" && tone !== "soon" && `acct-pill--${tone}`, size === "lg" && "acct-pill--lg", className)}>
      <Status tone={tone} size={size}>
        {children}
      </Status>
    </span>
  );
}

export function OrderStatusLine({ status, size, pill = false, className }: { status: OrderStatus; size?: "md" | "lg"; pill?: boolean; className?: string }) {
  const t = useT("account");
  if (pill) {
    return (
      <StatusPill tone={ORDER_TONE[status]} size={size} className={className}>
        {t(`status.${status}`)}
      </StatusPill>
    );
  }
  return (
    <Status tone={ORDER_TONE[status]} size={size} className={className}>
      {t(`status.${status}`)}
    </Status>
  );
}

export function PaymentStatusLine({ status, pill = false, className }: { status: PaymentStatus; pill?: boolean; className?: string }) {
  const t = useT("account");
  if (pill) {
    return (
      <StatusPill tone={PAYMENT_TONE[status]} className={className}>
        {t(`payment.${status}`)}
      </StatusPill>
    );
  }
  return (
    <Status tone={PAYMENT_TONE[status]} className={className}>
      {t(`payment.${status}`)}
    </Status>
  );
}

type RootStore = { storeMode?: string };

/**
 * An order line's name as sold is "<product> — <option>" (orders/place.server lineName): the summary shows the product's
 * name and, under it, the option value only (Design System v2 §4.13). Pure.
 */
export function splitOption(snapshot: string): { name: string; option: string | null } {
  const at = snapshot.indexOf(" — ");
  if (at <= 0) return { name: snapshot, option: null };
  const option = snapshot.slice(at + 3).trim();
  return { name: snapshot.slice(0, at).trim(), option: option || null };
}

/**
 * One order (Design v2.1, the reference «طلباتي»): a soft card that is one link rising into the order — its picture in
 * the well, the order number with its state in a tinted pill, what was bought (the product's name, «قطعتان»), the
 * date and the total, and a chevron toward the reading end. A demo order is marked only once the store is live (in
 * demo mode the strip already says every order is a demo).
 */
export function OrderRow({ order }: { order: OrderSummaryRow }) {
  const t = useT("account");
  const f = useFormat();
  const root = useRouteLoaderData("root") as RootStore | undefined;
  const demoMark = order.isDemo && root?.storeMode !== "demo";
  return (
    <MotionLink to={`/account/orders/${order.ref}`} nav="rise" className="surface lift acct-order" data-press="soft">
      <Niche as="span" size="sm" aria-hidden="true">
        {order.image ? <ProductImage image={order.image} alt="" sizes="88px" /> : null}
      </Niche>
      <span className="acct-order__body">
        <span className="acct-order__top">
          <span className="acct-order__ref" dir="ltr">
            {order.ref}
          </span>
          <OrderStatusLine status={order.status} pill />
        </span>
        <span className="acct-order__what line-clamp-1">
          <BidiText text={splitOption(order.firstItemName).name} />
          {order.itemCount > 1 ? <> · {t("orders.pieces", { count: order.itemCount })}</> : null}
        </span>
        <span className="acct-order__meta">
          <time dateTime={new Date(order.placedAt).toISOString()}>{f.date(order.placedAt)}</time>
          <span aria-hidden="true">·</span>
          <Price amountIqd={order.totalIqd} size="sm" approx="off" as="span" />
          {demoMark ? <DemoNote variant="tag" what="order" /> : null}
        </span>
      </span>
      <Icon name="caret-right" size={20} className="acct-order__go" />
    </MotionLink>
  );
}

/**
 * The five real states of an order, in the order a shopper lives them (Design System v2 §6.11) — the order page draws
 * them with the kit's status rail (ProgressSteps variant="status"; a delivered order is done throughout).
 */
export const ORDER_RAIL = ["received", "confirmed", "preparing", "shipped", "delivered"] as const;

/** Where an order stands on the rail; null for an order that left it (cancelled, returned). Pure. */
export function railIndex(status: OrderStatus): number | null {
  switch (status) {
    case "new":
    case "awaiting_payment":
    case "payment_review":
      return 0;
    case "confirmed":
      return 1;
    case "preparing":
      return 2;
    case "shipped":
      return 3;
    case "delivered":
      return 4;
    default:
      return null;
  }
}
