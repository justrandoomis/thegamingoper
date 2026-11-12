import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { OrderStatus, PaymentStatus } from "~/lib/dto";
import { MotionLink } from "~/motion";
import type { OrderSummary as OrderSummaryRow } from "~/server/services/orders/types";
import { BidiText } from "~/ui/BidiText";
import { DemoNote } from "~/ui/DemoNote";
import { Niche } from "~/ui/Niche";
import { Price } from "~/ui/Price";
import { ProductImage } from "~/ui/ProductCard";
import { Status, type StatusTone } from "~/ui/Tag";
import { VisuallyHidden } from "~/ui/VisuallyHidden";

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

export function OrderStatusLine({ status, size, className }: { status: OrderStatus; size?: "md" | "lg"; className?: string }) {
  const t = useT("account");
  return (
    <Status tone={ORDER_TONE[status]} size={size} className={className}>
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
 * One order in a list (Design System v2 §6.12): a 56px well, the order number, what was bought, the status (dot +
 * words), the date and the total. The whole row is one link that rises into the order. A demo order is marked only
 * once the store is live (in demo mode the strip already says every order is a demo).
 */
export function OrderRow({ order }: { order: OrderSummaryRow }) {
  const t = useT("account");
  const f = useFormat();
  const root = useRouteLoaderData("root") as RootStore | undefined;
  const demoMark = order.isDemo && root?.storeMode !== "demo";
  return (
    <MotionLink to={`/account/orders/${order.ref}`} nav="rise" className="acct-row" data-press="soft">
      <Niche as="span" size="sm" aria-hidden="true">
        {order.image ? <ProductImage image={order.image} alt="" sizes="56px" /> : null}
      </Niche>
      <span className="acct-row__body">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="acct-row__title nums" dir="ltr">
            {order.ref}
          </span>
          <Price amountIqd={order.totalIqd} size="sm" approx="off" as="span" />
        </span>
        <span className="acct-row__meta line-clamp-1">
          <BidiText text={splitOption(order.firstItemName).name} />
          {order.itemCount > 1 ? <> · {t("orders.pieces", { count: order.itemCount })}</> : null}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <OrderStatusLine status={order.status} />
          <span className="acct-row__meta" aria-hidden="true">
            ·
          </span>
          <time className="acct-row__meta" dateTime={new Date(order.placedAt).toISOString()}>
            {f.date(order.placedAt)}
          </time>
          {demoMark ? <DemoNote variant="tag" what="order" /> : null}
        </span>
      </span>
    </MotionLink>
  );
}

/** The five real states of an order, in the order a shopper lives them (Design System v2 §6.11). */
const RAIL = ["received", "confirmed", "preparing", "shipped", "delivered"] as const;

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

/**
 * The order's rail: استلمنا · تأكيد · تجهيز · في الطريق · تم التسليم. Done = an ink disc with a check, current = an ink
 * disc with a paper core (`aria-current="step"`), upcoming = a control-line ring. A delivered order is done throughout.
 */
export function OrderRail({ status, className }: { status: OrderStatus; className?: string }) {
  const t = useT("account");
  const at = railIndex(status);
  if (at === null) return null;
  const finished = status === "delivered";
  return (
    <ol className={className ? `orail ${className}` : "orail"} aria-label={t("order.statusTitle")}>
      {RAIL.map((step, index) => {
        const state = finished || index < at ? "done" : index === at ? "current" : "upcoming";
        return (
          <li key={step} className="orail__step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="orail__dot" aria-hidden="true">
              {state === "done" ? <Icon name="check" size={14} /> : null}
            </span>
            <span className="orail__label">
              {t(`order.rail.${step}`)}
              {state === "done" ? <VisuallyHidden>{` (${t("overview.stepDone")})`}</VisuallyHidden> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
