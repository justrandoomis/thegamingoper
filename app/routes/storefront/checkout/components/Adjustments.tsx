import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { CURRENCIES } from "~/lib/money";
import type { DiscountLineView, FlashPriceView, ShippingWaiverView } from "~/server/services/orders/types";
import { isolate } from "~/ui/BidiText";
import { iqdText } from "~/ui/PriceTag";
// its look (.co-adjust) travels with it: the account's order page shows it too
import "../checkout.css";

/**
 * Every amount as charged, under the order summary's rows (the kit's OrderSummary shows the discount's TOTAL; this says
 * what it is made of): the automatic offers, the coupon, the membership discount, the redeemed points — each «−amount»
 * in the summary's tabular type —, the delivery a membership or an offer waived (in words, with the fee it would have been), and
 * a split payment's parts (from the wallet, the rest). Nothing is added up here: the figures are the server's
 * (CartViewData / OrderView). Shared by the cart, the checkout and the order pages.
 */
export function Adjustments({ discounts, waiver, split, className }: { discounts: readonly DiscountLineView[]; waiver?: ShippingWaiverView | null; split?: { walletIqd: number; restIqd: number } | null; className?: string }) {
  const t = useT("checkout");
  const f = useFormat();
  const currency = CURRENCIES.IQD.symbol[f.locale];
  const minus = (amount: number) => (
    <span className="price price--sm shrink-0">
      <span className="price__num" dir="ltr">
        −{f.number(amount)}
      </span>
      <span className="price__cur">{currency}</span>
    </span>
  );
  // Only what explains the total: one coupon alone is already named by the summary's discount row.
  const breakdown = discounts.length > 1 || discounts.some((entry) => entry.kind !== "coupon");
  if (!breakdown && !waiver && !split) return null;
  return (
    <div className={className ? `co-adjust ${className}` : "co-adjust"}>
      {breakdown ? (
        <ul className="co-adjust__list" aria-label={t("discounts.label")}>
          {discounts.map((entry, index) => (
            <li key={`${entry.kind}:${index}`} className="co-adjust__row">
              <span className="min-w-0">{discountLabel(entry, t, f)}</span>
              {minus(entry.amountIqd)}
            </li>
          ))}
        </ul>
      ) : null}
      {waiver ? (
        // words only: the summary's delivery row already shows what is charged (0), and the discount parts above add up
        // to its discount row — a second «−5,000» here would read as taken off twice
        <p className="co-adjust__row co-adjust__row--ok">
          <span className="flex min-w-0 items-start gap-1.5">
            <Icon name="truck" size={16} className="mt-0.5 shrink-0" />
            <span>
              {t(waiver.by === "member" ? "discounts.waiverMember" : "discounts.waiverRule", { label: isolate(waiver.label) })}{" "}
              <span className="text-ink-2">{t("discounts.waiverFee", { fee: isolate(iqdText(f, waiver.feeIqd)) })}</span>
            </span>
          </span>
        </p>
      ) : null}
      {split ? (
        <dl className="co-adjust__split">
          <div className="co-adjust__row">
            <dt>{t("split.fromWallet")}</dt>
            <dd className="nums">{iqdText(f, split.walletIqd)}</dd>
          </div>
          <div className="co-adjust__row co-adjust__row--strong">
            <dt>{t("split.rest")}</dt>
            <dd className="nums">{iqdText(f, split.restIqd)}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

/**
 * The coupon the kit summary may name on its discount row: only when the coupon IS the whole discount (otherwise the
 * row is «الخصم» — the total — and <Adjustments> lists what it is made of).
 */
export function summaryCoupon<C>(discounts: readonly DiscountLineView[] | undefined, coupon: C | null): C | null {
  const list = discounts ?? [];
  return list.length <= 1 && list.every((entry) => entry.kind === "coupon") ? coupon : null;
}

/** One discount line's words. */
export function discountLabel(entry: DiscountLineView, t: (key: string, vars?: Record<string, string | number>) => string, f: ReturnType<typeof useFormat>): string {
  switch (entry.kind) {
    case "rule":
      return t("discounts.rule", { label: isolate(entry.label) });
    case "coupon":
      return t("discounts.coupon", { code: isolate(entry.code) });
    case "member":
      return t("discounts.member", { label: isolate(entry.label), pct: isolate(f.percent(entry.bps / 10_000)) });
    case "points":
      return t("discounts.points", { count: entry.points, n: f.number(entry.points) });
  }
}

/** A flash-priced line's facts («سعر العرض حتى …، بدلاً من …»), to add to its option value. */
export function flashFacts(flash: FlashPriceView | null | undefined, t: (key: string, vars?: Record<string, string | number>) => string, f: ReturnType<typeof useFormat>): string | null {
  if (!flash) return null;
  return t("discounts.flash", { label: isolate(flash.label), was: isolate(iqdText(f, flash.regularPriceIqd)), date: isolate(f.date(flash.endsAt, "medium")) });
}

/** An option value with a flash sale's facts after it, as one facts line. */
export function withFlash<T extends { optionsLabel: string | null }>(line: T, flash: FlashPriceView | null | undefined, t: (key: string, vars?: Record<string, string | number>) => string, f: ReturnType<typeof useFormat>): T {
  const facts = flashFacts(flash, t, f);
  if (!facts) return line;
  return { ...line, optionsLabel: line.optionsLabel ? `${line.optionsLabel} · ${facts}` : facts };
}
