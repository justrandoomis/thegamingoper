import { Fragment, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT, type Formatters } from "~/i18n/react";
import { CURRENCIES } from "~/lib/money";
import { cx } from "./cx";
import { Price, type PriceProps } from "./Price";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * The commerce price line (docs/DESIGN.md §9.11) built on <Price>: ink, Kufam 700, tabular figures, never red,
 * never animated. A reduction is the old price in ink-2 with a line through it before the price, and the saving as
 * plain words ("توفّر 50,000 د.ع") — never a tag or a colour. On the product page the delivery fee is stated beside
 * the price, not further down.
 *
 *   <PriceTag priceIqd={749000} />                                        a card (17px)
 *   <PriceTag priceIqd={1049000} compareAtIqd={1099000} />                a genuine reduction
 *   <PriceTag size="page" priceIqd={899000} deliveryIqd={fee}             product page: price at the start, the
 *             aside={<StockNote stock="in_stock" detail={warranty} />} />  delivery line and stock at the end
 *   <SavingNote priceIqd={…} compareAtIqd={…} />                          the saving, for a card's fact line
 *
 * Amounts are integer IQD. A value that is not (NaN, a fraction, a negative number) renders an explicit
 * "تعذّر عرض السعر" instead of a number — never a zero, never a crash (SafePrice).
 */
export const isIqd = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * An amount of dinars inside a sentence, written the way <Price> writes it: the number, then the currency label
 * ("5,000 د.ع", "5,000 IQD" — DESIGN.md §9.11 and the copy in §11). Wrap it in <bdi> or U+2066…U+2069.
 */
export function iqdText(f: Pick<Formatters, "number" | "locale">, amountIqd: number): string {
  return `${f.number(amountIqd)} ${CURRENCIES.IQD.symbol[f.locale]}`;
}

/** Put React nodes where a translated template has {placeholders}: fillNodes(t("price.delivery"), { price: <bdi>…</bdi> }). */
export function fillNodes(template: string, vars: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const index = match.index ?? 0;
    if (index > last) out.push(template.slice(last, index));
    const name = match[1];
    out.push(name in vars ? <Fragment key={`${name}@${index}`}>{vars[name]}</Fragment> : match[0]);
    last = index + match[0].length;
  }
  if (last < template.length) out.push(template.slice(last));
  return out;
}

export type SafePriceProps = Omit<PriceProps, "amountIqd" | "compareAtIqd"> & { amountIqd: unknown; compareAtIqd?: unknown };

/** <Price> that refuses to show a broken amount: an explicit message in red-ink words instead. */
export function SafePrice({ amountIqd, compareAtIqd = null, ...rest }: SafePriceProps) {
  const t = useT("ui-shop");
  if (!isIqd(amountIqd) || (compareAtIqd !== null && compareAtIqd !== undefined && !isIqd(compareAtIqd))) {
    return (
      <span className={cx("inline-flex items-center gap-1 type-caption font-medium text-red-ink", rest.className)}>
        <Icon name="warning-circle" size={16} />
        {t("price.invalid")}
      </span>
    );
  }
  return <Price {...rest} amountIqd={amountIqd} compareAtIqd={compareAtIqd as number | null} />;
}

export type PriceTagProps = {
  priceIqd: number;
  /** The previous price — only a genuine reduction (shown when higher than the price). */
  compareAtIqd?: number | null;
  /** card 17px (default) · line 15px (cart rows) · page 28/34px with the delivery line and `aside`. */
  size?: "card" | "line" | "page";
  /** Product pages: the delivery fee stated beside the price. Pass the configured fee; nothing is assumed. */
  deliveryIqd?: number | null;
  /** Product pages: under the delivery line (usually <StockNote>). */
  aside?: ReactNode;
  /** Say "توفّر …" under the price. Default: on for `page`; cards put it in the fact line (<SavingNote>). */
  showSaving?: boolean;
  /** The converted line (when the shopper chose another display currency). Default "auto". */
  approx?: "auto" | "off";
  className?: string;
};

export function PriceTag({ priceIqd, compareAtIqd = null, size = "card", deliveryIqd = null, aside, showSaving, approx = "auto", className }: PriceTagProps) {
  if (size === "card" && isIqd(priceIqd) && isIqd(compareAtIqd) && compareAtIqd > priceIqd) {
    // A two-up card on a phone has no room for both figures on one line next to the socket: the old price sits
    // above the price (still before it in reading order), small, ink-2, struck through.
    return <CardReduction priceIqd={priceIqd} compareAtIqd={compareAtIqd} approx={approx} className={className} />;
  }
  if (size !== "page") {
    return <SafePrice amountIqd={priceIqd} compareAtIqd={compareAtIqd} size={size === "line" ? "sm" : "md"} approx={approx} className={className} />;
  }
  const saving = (showSaving ?? true) ? <SavingNote priceIqd={priceIqd} compareAtIqd={compareAtIqd} /> : null;
  const hasEnd = isIqd(deliveryIqd) || aside;
  return (
    <div className={cx("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <div className="grid min-w-0 gap-0.5">
        <SafePrice amountIqd={priceIqd} compareAtIqd={compareAtIqd} size="xl" approx={approx} />
        {saving}
      </div>
      {hasEnd ? (
        <div className="grid min-w-0 justify-items-end gap-0.5 pb-1 text-end">
          {isIqd(deliveryIqd) ? <DeliveryNote feeIqd={deliveryIqd} /> : null}
          {aside}
        </div>
      ) : null}
    </div>
  );
}

function CardReduction({ priceIqd, compareAtIqd, approx, className }: { priceIqd: number; compareAtIqd: number; approx: "auto" | "off"; className?: string }) {
  const ui = useT("ui");
  const f = useFormat();
  return (
    <span className={cx("inline-grid justify-items-start gap-0.5", className)}>
      <span className="leading-none">
        <VisuallyHidden>{ui("price.was")} </VisuallyHidden>
        <s className="price__was">
          <bdi>{f.number(compareAtIqd)}</bdi>
        </s>
      </span>
      <span>
        <VisuallyHidden>{ui("price.now")} </VisuallyHidden>
        <Price amountIqd={priceIqd} size="md" approx={approx} as="span" />
      </span>
    </span>
  );
}

/** "توفّر 70,000 د.ع" — plain words in ink-2, kept on one line; nothing when there is no genuine reduction. */
export function SavingNote({ priceIqd, compareAtIqd, className }: { priceIqd: number; compareAtIqd?: number | null; className?: string }) {
  const t = useT("ui-shop");
  const f = useFormat();
  if (!isIqd(priceIqd) || !isIqd(compareAtIqd) || compareAtIqd <= priceIqd) return null;
  return (
    <span className={cx("type-caption whitespace-nowrap text-ink-2", className)}>
      {fillNodes(t("price.saving"), { amount: <bdi className="nums">{iqdText(f, compareAtIqd - priceIqd)}</bdi> })}
    </span>
  );
}

/** "التوصيل 5,000 د.ع لكل المحافظات" (DESIGN.md §11 copy 3). The fee comes from settings through the loader. */
export function DeliveryNote({ feeIqd, className }: { feeIqd: number; className?: string }) {
  const t = useT("ui-shop");
  const f = useFormat();
  if (!isIqd(feeIqd)) return null;
  return <span className={cx("type-caption text-ink-2", className)}>{fillNodes(t("price.delivery"), { price: <bdi className="nums">{iqdText(f, feeIqd)}</bdi> })}</span>;
}
