import { useId, useRef, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { ImageRef } from "~/lib/dto";
import { CURRENCIES } from "~/lib/money";
import { BidiText } from "./BidiText";
import { cx } from "./cx";
import { DemoNote } from "./DemoNote";
import { TextField } from "./Field";
import { Key } from "./Key";
import { Niche } from "./Niche";
import { Price } from "./Price";
import { isIqd } from "./PriceTag";
import { ProductImage } from "./ProductCard";
import { Status } from "./Tag";

/**
 * The order summary — Design System v2 §4.13: a paper card (--r-lg, a hairline). Item lines with 64px wells and the
 * option value only; «المجموع الفرعي», the delivery («التوصيل 5,000 د.ع — لكل المحافظات», or the governorate's
 * state), the coupon disclosure «لديك رمز خصم؟» (a field and a SEPARATE 40px «طبّق»), and «الإجمالي» as the ONE red
 * figure (the `total` tone, price lg). On desktop the commit key sits INSIDE the card under the total (`action`),
 * then the trust line (`trust`) and, in demo mode, «طلب تجريبي: لن يُشحن الطلب ولن يُحصَّل أي مبلغ.» (`demo`). One
 * term for the payable amount everywhere: «الإجمالي».
 *
 * Tabular figures, the label at the start and the amount at the end, never animated. The total is always in Iraqi
 * dinars (the payable figure); with another display currency a labelled approximation sits under it. Every number
 * comes from the server (CartView / OrderView) — nothing is added up here. Before anything is drawn the figures are
 * checked (whole dinars, discount ≤ subtotal, total = subtotal − discount + delivery): if they do not reconcile the
 * total is replaced by an explicit error row — never NaN, never a guessed number, never a zero.
 *
 *   <OrderSummary {...editor.view} pending={editor.pending} couponField={<CouponField onApply={apply} />}
 *                 action={<Key variant="primary" block …>…</Key>} trust={<TrustStrip variant="line" cod returnsTo=… />} demo />
 *   <OrderSummary {...cart} shipping="governorate" approx="off" title={null} lines={cart.lines} />
 *   <OrderSummary {...cart} shipping="unserved" />                                      governorate not served
 *
 * Delivery: a known fee before a governorate is chosen is the flat fee ("لكل المحافظات", brief §4: 5,000 IQD to every
 * governorate); `shipping="governorate"` once one is chosen; `"pending"` when no fee is known yet; `"unserved"` when
 * the chosen governorate is not delivered to (the cart service returns `shippingIqd: null` then).
 *
 * The arrangement (fix round 2026-11-13, client notes 8 and 12 "more arrangement"): subtotal · the discount · delivery
 * · «الإجمالي» — nothing with a minus sign after the total. The discount is ONE row «الخصم» in the saving colour with
 * its icon, or, with `discountParts` (the automatic offer, the coupon, the membership, the redeemed points — the server's
 * figures), one such row per part in its place: each part's icon, its words and «−amount», never the same money twice.
 * Parts that do not add up to `discountIqd` are not shown (the single row is). `shippingNote` replaces the line under
 * «التوصيل» (a waived fee: «مجاني بعضوية ذهبي — كان 5,000 د.ع»). Under the total: `children` (a split payment's parts:
 * from the wallet, the rest), then the coupon question «لديك رمز خصم؟ ›» (a caret says it opens), then the action.
 *
 *   <OrderSummary {...cart} discountParts={[{ key: "coupon", icon: "ticket", label: "رمز الخصم DEMO10", amountIqd: 8250 }]}
 *                 shippingNote={waiver}> <SplitParts … /> </OrderSummary>
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
  /** Item lines with 64px wells and the option value only. */
  lines?: readonly SummaryLine[] | null;
  /** The coupon disclosure «لديك رمز خصم؟» holds this (usually <CouponField>). */
  couponField?: ReactNode;
  /** Inside the card, under the total: the commit key (desktop), «أكّد الطلب · 1,513,750 د.ع» on review. */
  action?: ReactNode;
  /** Under the action: <TrustStrip variant="line" …/>. */
  trust?: ReactNode;
  /** Demo mode: «طلب تجريبي: لن يُشحن الطلب ولن يُحصَّل أي مبلغ.» */
  demo?: boolean;
  /** The discount's parts, each a row in the discount's place (before the delivery and the total), in the saving
   *  colour with its icon. They must add up to `discountIqd`, else the single «الخصم» row is shown. */
  discountParts?: readonly SummaryDiscountPart[] | null;
  /** Under «التوصيل», instead of the default line (a fee waived by a membership or an offer, said in words). */
  shippingNote?: ReactNode;
  /** Directly under the total, before the coupon question and the action: a split payment's parts. */
  children?: ReactNode;
  className?: string;
};

/** One part of the discount: its words («رمز الخصم DEMO10», «1,000 نقطة مستبدلة»), its icon, the server's amount. */
export type SummaryDiscountPart = { key: string; label: ReactNode; amountIqd: number; icon?: IconName };

export type SummaryLine = { id: string; name: string; optionsLabel?: string | null; lineTotalIqd: number; image?: ImageRef | null };

/**
 * The discount rows to draw (pure; exported for tests): the parts when there are some and they add up to the discount
 * (whole dinars), else the one «الخصم» row (null) — never both, so no amount is shown twice.
 */
export function discountRows(discountIqd: number, parts: readonly SummaryDiscountPart[] | null | undefined): readonly SummaryDiscountPart[] | null {
  if (!parts || parts.length === 0) return null;
  if (!parts.every((part) => isIqd(part.amountIqd) && part.amountIqd > 0)) return null;
  return parts.reduce((sum, part) => sum + part.amountIqd, 0) === discountIqd ? parts : null;
}

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
  lines,
  couponField,
  action,
  trust,
  demo = false,
  discountParts,
  shippingNote,
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
  const parts = discountRows(discountIqd, discountParts);

  const amount = (value: number) => (isIqd(value) ? <Price amountIqd={value} size="sm" approx="off" as="span" /> : <Broken />);
  // a saving: «−8,250 د.ع», the figure first, in the summary's tabular type
  const minus = (value: number) =>
    isIqd(value) ? (
      <span className="price price--sm">
        <span className="price__num" dir="ltr">−{f.number(value)}</span>
        <span className="price__cur">{currency}</span>
      </span>
    ) : (
      <Broken />
    );

  return (
    <section aria-labelledby={title === null ? undefined : headingId} aria-busy={pending || undefined} className={cx("summary", className)} data-reconciled={ok ? undefined : "false"}>
      {title === null ? null : (
        <Heading id={headingId} className="summary__title">
          {title ?? t("summary.title")}
        </Heading>
      )}
      {lines && lines.length > 0 ? (
        <ul className="summary__lines">
          {lines.map((line) => (
            <li key={line.id} className="summary__line">
              <Niche as="span" size="sm" aria-hidden="true">
                {line.image ? <ProductImage image={line.image} alt="" sizes="64px" fit="cover" /> : null}
              </Niche>
              <span className="grid min-w-0">
                <span className="line-clamp-2 type-sm-strong text-ink">
                  <BidiText text={line.name} />
                </span>
                {line.optionsLabel ? <span className="type-xs text-ink-2">{line.optionsLabel}</span> : null}
              </span>
              {isIqd(line.lineTotalIqd) ? <Price amountIqd={line.lineTotalIqd} size="sm" approx="off" as="span" /> : <Broken />}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="summary__rows">
        <Row label={<>{t("summary.subtotal")} {items ? <span className="text-ink-2">{items}</span> : null}</>}>{amount(subtotalIqd)}</Row>
        {parts
          ? // each part of the discount in its place, before the delivery and the total (client notes 8 and 12)
            parts.map((part) => (
              <Row key={part.key} saving icon={part.icon ?? "tag"} label={part.label}>
                {minus(part.amountIqd)}
              </Row>
            ))
          : discountIqd !== 0 || coupon ? (
              <Row saving icon={coupon ? "ticket" : "tag"} label={coupon ? t("summary.coupon", { code: "⁦" + coupon.code + "⁩" }) : t("summary.discount")} note={coupon?.label}>
                {minus(discountIqd)}
              </Row>
            ) : null}
        <Row label={t("summary.shipping")} note={shippingNote ?? (mode === "flat" ? t("summary.shippingFlat") : mode === "pending" ? t("summary.shippingPending") : null)}>
          {mode === "unserved" ? (
            <Status tone="bad">{t("summary.shippingUnavailable")}</Status>
          ) : shippingIqd === null ? (
            <span className="type-xs text-ink-2">—</span>
          ) : (
            amount(shippingIqd)
          )}
        </Row>
        {ok ? (
          <div className="summary__row summary__row--total">
            <dt>{t("summary.total")}</dt>
            <dd className="grid justify-items-end text-end">
              {/* the ONE red figure of a summary (v2 §4.13) */}
              <Price amountIqd={totalIqd} size="lg" tone="total" approx={approx} rateDetails={false} as="span" />
            </dd>
          </div>
        ) : null}
      </dl>
      {ok ? null : (
        <p role="alert" className="flex items-start gap-2 type-sm-strong text-danger">
          <Icon name="warning-circle" size={20} className="shrink-0" />
          <span>{t("summary.error")}</span>
        </p>
      )}
      {pending ? (
        <p className="type-xs text-ink-2" aria-live="polite">
          {t("summary.updating")}
        </p>
      ) : null}
      {/* under the total: how it is paid (a split payment's parts), then the coupon question, then the action */}
      {children}
      {couponField ? (
        <details className="summary__coupon">
          <summary>
            <span>{t("buy.couponQ")}</span>
            {/* says it opens (the client's reference: «كود خصم ›»); turns when open */}
            <Icon name="caret-down" size={18} className="summary__caret" />
          </summary>
          <div className="pt-1">{couponField}</div>
        </details>
      ) : null}
      {action ? <div className="grid">{action}</div> : null}
      {trust}
      {demo ? <DemoNote variant="line">{t("demo.orderLine")}</DemoNote> : null}
    </section>
  );
}

function Row({ label, note, saving = false, icon, children }: { label: ReactNode; note?: ReactNode; saving?: boolean; icon?: IconName; children: ReactNode }) {
  return (
    <div className={cx("summary__row", saving && "summary__row--saving")}>
      <dt className="min-w-0">
        {icon ? (
          <span className="summary__label">
            <Icon name={icon} size={16} className="summary__icon" />
            <span className="min-w-0">{label}</span>
          </span>
        ) : (
          label
        )}
        {note ? <span className="block type-xs text-ink-2">{note}</span> : null}
      </dt>
      <dd className={cx("shrink-0 text-end", !saving && "text-ink")}>{children}</dd>
    </div>
  );
}

/** A figure that is not a whole number of dinars: said, not shown. */
function Broken() {
  const t = useT("ui-shop");
  return (
    <span className="inline-flex items-center gap-1 type-xs-strong text-danger">
      <Icon name="warning-circle" size={16} />
      {t("price.invalid")}
    </span>
  );
}

export type CouponFieldProps = {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Called with the code when «طبّق» is pressed (or the form submits it). */
  onApply?: (code: string) => void;
  error?: ReactNode;
  pending?: boolean;
};

/**
 * The coupon field for <OrderSummary couponField> (v2 §4.13): the code field and a SEPARATE 40px «طبّق» button
 * outside it (never a button inside the field). The checkout owns the request; this is the control.
 */
export function CouponField({ name = "coupon", value, defaultValue, onChange, onApply, error, pending = false }: CouponFieldProps) {
  const t = useT("ui-shop");
  const input = useRef<HTMLInputElement>(null);
  const apply = () => onApply?.((input.current?.value ?? "").trim());
  return (
    <div className="flex items-start gap-2">
      <TextField
        ref={input}
        label={t("buy.coupon")}
        hideLabel
        name={name}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onApply) {
            event.preventDefault();
            apply();
          }
        }}
        ltr
        autoComplete="off"
        error={error}
        className="min-w-0 flex-1"
      />
      <Key size="sm" loading={pending} onClick={apply} className="mt-1.5">
        {t("buy.apply")}
      </Key>
    </div>
  );
}
