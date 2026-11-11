import { Fragment, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT, type Formatters } from "~/i18n/react";
import type { StockState } from "~/lib/dto";
import { cx } from "./cx";
import { DemoNote } from "./DemoNote";
import { Price, type PriceProps } from "./Price";
import { stockLook, useDemoMode, useStockWords } from "./StockNote";
import { Status } from "./Tag";

/**
 * The commerce price line on top of <Price> — Design System v2 §4.8.
 *
 *   <PriceTag priceIqd={667750} />                                       a card (md 18)
 *   <PriceTag priceIqd={99000} compareAtIqd={115000} />                  a real reduction: sale tone, previous price struck
 *   <PriceTag size="line" priceIqd={…} />                                cart and summary lines (sm 16)
 *   <PriceTag size="page" priceIqd={667750} stock="in_stock" deliveryIqd={fee} demo />
 *        PDP and quick look: price xl + «سعر ومخزون تجريبيان», then «● متوفر · التوصيل 5,000 د.ع لكل المحافظات»
 *
 * Amounts are integer IQD. A value that is not (NaN, a fraction, a negative number) renders an explicit
 * «تعذّر عرض السعر» instead of a number — never a zero, never a crash (SafePrice). Also exported: SavingNote,
 * DeliveryNote, fillNodes, iqdText, isIqd.
 */
export const isIqd = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * An amount of dinars inside a sentence, written the way <Price> writes it: the number, then the currency label
 * ("5,000 د.ع", "5,000 IQD"). It is `f.iqd` (formatMoney puts the figure first in every language), kept as a name so
 * callers read the same everywhere. Wrap it in <bdi> or U+2066…U+2069.
 */
export function iqdText(f: Pick<Formatters, "iqd">, amountIqd: number): string {
  return f.iqd(amountIqd);
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

/** <Price> that refuses to show a broken amount: «تعذّر عرض السعر» in words instead. */
export function SafePrice({ amountIqd, compareAtIqd = null, ...rest }: SafePriceProps) {
  const t = useT("ui-shop");
  if (!isIqd(amountIqd) || (compareAtIqd !== null && compareAtIqd !== undefined && !isIqd(compareAtIqd))) {
    return (
      <span className={cx("inline-flex items-center gap-1 type-xs-strong text-danger", rest.className)}>
        <Icon name="warning-circle" size={16} />
        {t("price.invalid")}
      </span>
    );
  }
  return <Price {...rest} amountIqd={amountIqd} compareAtIqd={compareAtIqd as number | null} />;
}

export type PriceTagProps = {
  priceIqd: number;
  /** The real previous price — only a genuine reduction (shown when higher than the price). */
  compareAtIqd?: number | null;
  /** card md 18 (default) · line sm 16 · page xl with the stock-and-delivery line. */
  size?: "card" | "line" | "page";
  /** Price tone (default: sale with a real previous price, else ink). */
  tone?: PriceProps["tone"];
  /** page: the stock state for the line under the price. */
  stock?: StockState | null;
  /** page: the delivery fee from settings for the line under the price. Nothing is assumed. */
  deliveryIqd?: number | null;
  /** page: «سعر ومخزون تجريبيان» beside the price (demo data in demo mode). */
  demo?: boolean;
  /** page: under the line (a note of your own). */
  aside?: ReactNode;
  /** Say «توفّر …» under the price. Default: on for `page`. */
  showSaving?: boolean;
  /** The converted line (when the shopper chose another display currency). Default "auto". */
  approx?: "auto" | "off";
  className?: string;
};

export function PriceTag({ priceIqd, compareAtIqd = null, size = "card", tone, stock = null, deliveryIqd = null, demo = false, aside, showSaving, approx = "auto", className }: PriceTagProps) {
  if (size !== "page") {
    return <SafePrice amountIqd={priceIqd} compareAtIqd={compareAtIqd} size={size === "line" ? "sm" : "md"} tone={tone} approx={approx} className={className} />;
  }
  const saving = (showSaving ?? true) ? <SavingNote priceIqd={priceIqd} compareAtIqd={compareAtIqd} /> : null;
  return (
    <div className={cx("grid min-w-0 justify-items-start gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SafePrice amountIqd={priceIqd} compareAtIqd={compareAtIqd} size="xl" tone={tone} approx={approx} />
        {demo ? <DemoNote variant="tag" what="priceStock" /> : null}
      </div>
      {saving}
      <PriceLine stock={stock} deliveryIqd={deliveryIqd} />
      {aside}
    </div>
  );
}

/** «● متوفر · التوصيل 5,000 د.ع لكل المحافظات» — 14/600, the dot in the stock colour. Nothing when both are unknown. */
export function PriceLine({ stock, deliveryIqd, className }: { stock?: StockState | null; deliveryIqd?: number | null; className?: string }) {
  const words = useStockWords();
  const demo = useDemoMode();
  const hasFee = isIqd(deliveryIqd);
  if (!stock && !hasFee) return null;
  return (
    <p className={cx("price-line", className)}>
      {stock ? (
        <Status tone={stockLook(stock, demo)} size="lg">
          {words(stock)}
        </Status>
      ) : null}
      {stock && hasFee ? <span aria-hidden="true">·</span> : null}
      {hasFee ? <DeliveryNote feeIqd={deliveryIqd} strong /> : null}
    </p>
  );
}

/** «توفّر 70,000 د.ع» — plain words in ink-2, kept on one line; nothing when there is no genuine reduction. */
export function SavingNote({ priceIqd, compareAtIqd, className }: { priceIqd: number; compareAtIqd?: number | null; className?: string }) {
  const t = useT("ui-shop");
  const f = useFormat();
  if (!isIqd(priceIqd) || !isIqd(compareAtIqd) || compareAtIqd <= priceIqd) return null;
  return (
    <span className={cx("type-xs whitespace-nowrap text-ink-2", className)}>
      {fillNodes(t("price.saving"), { amount: <bdi className="nums">{iqdText(f, compareAtIqd - priceIqd)}</bdi> })}
    </span>
  );
}

/** «التوصيل 5,000 د.ع لكل المحافظات». The fee comes from settings through the loader. `strong`: 14/600 ink (the price line). */
export function DeliveryNote({ feeIqd, strong = false, className }: { feeIqd: number; strong?: boolean; className?: string }) {
  const t = useT("ui-shop");
  const f = useFormat();
  if (!isIqd(feeIqd)) return null;
  return <span className={cx(strong ? "type-sm-strong text-ink" : "type-xs text-ink-2", className)}>{fillNodes(t("price.delivery"), { price: <bdi className="nums">{iqdText(f, feeIqd)}</bdi> })}</span>;
}
