import { useId, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { CURRENCIES } from "~/lib/money";
import { cx } from "./cx";
import { Price } from "./Price";
import { isIqd } from "./PriceTag";
import { Status } from "./Tag";

/**
 * The order summary on paper (docs/DESIGN.md §8.5, §9.11, brief §4): subtotal, discount, delivery, total — tabular
 * figures, the label at the start and the amount at the end, never animated. The total is always in Iraqi dinars
 * (the payable figure); when the shopper chose another display currency a labelled approximation sits under it
 * ("≈ $… · الدفع بالدينار العراقي"). Every number comes from the server (CartView / OrderView) — nothing is added
 * up here. Before anything is drawn the figures are checked (whole dinars, discount ≤ subtotal, total = subtotal −
 * discount + delivery): if they do not reconcile the total is replaced by an explicit error row — never NaN, never
 * a guessed number, never a zero.
 *
 *   <OrderSummary {...editor.view} pending={editor.pending} />                         the cart (CartView spreads in)
 *   <OrderSummary {...cart} shipping="governorate" approx="off" title={null} />         checkout, fee of the chosen governorate
 *   <OrderSummary {...cart} shipping="unserved" />                                      governorate not served (block checkout)
 *   <OrderSummary {...view}>{couponField}</OrderSummary>                                children go under the rows
 *
 * Delivery: a known fee before a governorate is chosen is the flat fee ("لكل المحافظات", brief §4: 5,000 IQD to every
 * governorate); `shipping="governorate"` once one is chosen; `"pending"` when no fee is known yet; `"unserved"` when
 * the chosen governorate is not delivered to (the cart service returns `shippingIqd: null` then).
 */
export type OrderSummaryProps = {
  subtotalIqd: number;
  discountIqd: number;
  shippingIqd: number | null;
  totalIqd: number;
  /** Units in the order — "(3 قطع)" after the subtotal. */
  count?: number;
  coupon?: { code: string; label: string } | null;
  /** How the delivery line reads. Default: "flat" when a fee is known, else "pending". */
  shipping?: "flat" | "governorate" | "pending" | "unserved";
  /** A change is in flight: "جارٍ تحديث المجموع" (the figures stay still — money never animates). */
  pending?: boolean;
  /** The converted approximation under the total. Default "auto" (only when the display currency is not IQD). */
  approx?: "auto" | "off";
  /** Heading; default "ملخص الطلب". `null` renders none (the page already has one). */
  title?: ReactNode | null;
  headingLevel?: 2 | 3;
  /** Under the rows (a coupon field, the commit key on wide screens). */
  children?: ReactNode;
  className?: string;
};

export type SummaryFigures = Pick<OrderSummaryProps, "subtotalIqd" | "discountIqd" | "shippingIqd" | "totalIqd">;

/**
 * Do the figures reconcile? Whole, non-negative dinars; discount ≤ subtotal; total = subtotal − discount + delivery
 * (delivery counted as 0 when unknown — the server's rule, orders/totals.ts). Pure.
 */
export function totalsReconcile({ subtotalIqd, discountIqd, shippingIqd, totalIqd }: SummaryFigures): boolean {
  if (!isIqd(subtotalIqd) || !isIqd(discountIqd) || !isIqd(totalIqd)) return false;
  if (shippingIqd !== null && !isIqd(shippingIqd)) return false;
  if (discountIqd > subtotalIqd) return false;
  return totalIqd === subtotalIqd - discountIqd + (shippingIqd ?? 0);
}

export function OrderSummary({
  subtotalIqd,
  discountIqd,
  shippingIqd,
  totalIqd,
  count,
  coupon = null,
  shipping,
  pending = false,
  approx = "auto",
  title,
  headingLevel = 2,
  children,
  className,
}: OrderSummaryProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  const ok = totalsReconcile({ subtotalIqd, discountIqd, shippingIqd, totalIqd });
  const mode = shipping ?? (shippingIqd === null ? "pending" : "flat");
  const items = typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? t("summary.items", { count, n: f.number(count) }) : null;
  const currency = CURRENCIES.IQD.symbol[f.locale];

  const amount = (value: number) => (isIqd(value) ? <Price amountIqd={value} size="sm" approx="off" as="span" /> : <Broken />);

  return (
    <section aria-labelledby={title === null ? undefined : headingId} aria-busy={pending || undefined} className={cx("grid gap-3 rounded-lg bg-paper p-4", className)} data-reconciled={ok ? undefined : "false"}>
      {title === null ? null : (
        <Heading id={headingId} className="type-sub text-ink">
          {title ?? t("summary.title")}
        </Heading>
      )}
      <dl className="grid gap-2.5">
        <Row label={<>{t("summary.subtotal")} {items ? <span className="text-ink-2">{items}</span> : null}</>}>{amount(subtotalIqd)}</Row>
        {discountIqd !== 0 || coupon ? (
          <Row label={coupon ? t("summary.coupon", { code: "⁦" + coupon.code + "⁩" }) : t("summary.discount")} note={coupon?.label}>
            {isIqd(discountIqd) ? (
              <span className="price price--sm">
                <bdi className="price__num">−{f.number(discountIqd)}</bdi>
                <span className="price__cur">{currency}</span>
              </span>
            ) : (
              <Broken />
            )}
          </Row>
        ) : null}
        <Row label={t("summary.shipping")} note={mode === "flat" ? t("summary.shippingFlat") : mode === "pending" ? t("summary.shippingPending") : null}>
          {mode === "unserved" ? (
            <Status tone="bad">{t("summary.shippingUnavailable")}</Status>
          ) : shippingIqd === null ? (
            <span className="type-caption text-ink-2">—</span>
          ) : (
            amount(shippingIqd)
          )}
        </Row>
      </dl>
      <div className="border-t border-line pt-3">
        {ok ? (
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <p className="type-strong text-ink">{t("summary.total")}</p>
            <div className="grid justify-items-end text-end">
              <Price amountIqd={totalIqd} size="lg" approx={approx} rateDetails={false} />
            </div>
          </div>
        ) : (
          <p role="alert" className="flex items-start gap-2 type-label font-semibold text-red-ink">
            <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0" />
            <span>{t("summary.error")}</span>
          </p>
        )}
        {pending ? (
          <p className="mt-1 type-caption text-ink-2" aria-live="polite">
            {t("summary.updating")}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, note, children }: { label: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-x-4">
      <dt className="min-w-0 type-label text-ink">
        {label}
        {note ? <span className="block type-caption text-ink-2">{note}</span> : null}
      </dt>
      <dd className="shrink-0 text-end">{children}</dd>
    </div>
  );
}

/** A figure that is not a whole number of dinars: said, not shown. */
function Broken() {
  const t = useT("ui-shop");
  return (
    <span className="inline-flex items-center gap-1 type-caption font-medium text-red-ink">
      <Icon name="warning-circle" size={16} />
      {t("price.invalid")}
    </span>
  );
}
