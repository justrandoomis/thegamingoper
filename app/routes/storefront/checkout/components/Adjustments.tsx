import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { CURRENCIES } from "~/lib/money";
import type { DiscountLineView, FlashPriceView, ShippingWaiverView } from "~/server/services/orders/types";
import { isolate } from "~/ui/BidiText";
import type { SummaryDiscountPart } from "~/ui/OrderSummary";
import { iqdText } from "~/ui/PriceTag";
// its look (.co-adjust) travels with it: the account's order page shows it too
import "../checkout.css";

/** Each kind of discount's icon (client round 1: the discount and points rows clearly coloured and told apart). */
export const DISCOUNT_ICON: Record<DiscountLineView["kind"], IconName> = { rule: "sparkle", coupon: "ticket", member: "seal-check", points: "star" };

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The discount's parts for the kit's order summary (`discountParts`; polish round 2026-11-13 — client notes 8 and 12,
 * "more arrangement": nothing with a minus sign after the total). One row per part in the discount's place, above the
 * delivery and the total, in the saving colour with its kind's icon: the automatic offers, the coupon, the membership
 * discount, the redeemed points — the server's amounts (CartViewData / OrderView), nothing added up here. The kit draws
 * them only when they add up to the discount (else its one «الخصم» row: no amount is ever shown twice). The coupon's own
 * words (the admin's text, in the store's language only) are never a part's words: the coupon field says them.
 *
 *   <OrderSummary {...cart} discountParts={summaryDiscountParts(cart.discounts, t, f)}
 *                 shippingNote={cart.shippingWaiver ? <WaiverNote waiver={cart.shippingWaiver} /> : undefined}>
 *     <Adjustments split={split} />
 *   </OrderSummary>
 */
export function summaryDiscountParts(discounts: readonly DiscountLineView[] | null | undefined, t: Translate, f: ReturnType<typeof useFormat>): SummaryDiscountPart[] {
  return (discounts ?? []).filter((entry) => entry.amountIqd > 0).map((entry, index) => ({ key: `${entry.kind}:${index}`, icon: DISCOUNT_ICON[entry.kind], label: discountLabel(entry, t, f), amountIqd: entry.amountIqd }));
}

/**
 * The delivery a membership or an offer did not charge, in words, under the summary's «التوصيل» (its `shippingNote`):
 * «التوصيل مجاني لعضوية ذهبي» in the saving colour, then «بدلاً من 5,000 د.ع» — the fee it would have been. The row's
 * own figure is what is charged. An offer worth less than the fee is never called free: «خصم 5,000 د.ع على التوصيل: …»
 * and the fee it came off.
 */
export function WaiverNote({ waiver }: { waiver: ShippingWaiverView }) {
  const t = useT("checkout");
  const f = useFormat();
  const words = waiverWords(waiver, t, f);
  return (
    <>
      {/* the fee phrase stays on one line («لە جیاتی» / «5,000 د.ع» read as two ideas) */}
      <span className="text-ok">{words}</span> <span className="whitespace-nowrap">{t("discounts.waiverFee", { fee: isolate(iqdText(f, waiver.feeIqd)) })}</span>
    </>
  );
}

/** A waived delivery's words: «free» only when the whole fee was waived, else what came off it (WaiverNote, Adjustments). */
function waiverWords(waiver: ShippingWaiverView, t: Translate, f: ReturnType<typeof useFormat>): string {
  return waiver.waivedIqd < waiver.feeIqd
    ? t("discounts.waiverPart", { amount: isolate(iqdText(f, waiver.waivedIqd)), label: isolate(waiver.label) })
    : t(waiver.by === "member" ? "discounts.waiverMember" : "discounts.waiverRule", { label: isolate(waiver.label) });
}

/**
 * Under the order summary's total: a split payment's parts (from the wallet, the rest to pay) — the area's pages pass
 * only `split` since the polish round (the parts and the waiver are the kit summary's own rows: summaryDiscountParts,
 * WaiverNote). Given `discounts` or `waiver` it still lists them here as before — every amount as charged, in the saving
 * colour with its kind's icon, the waiver in words —, for a page that has not moved them into the summary's rows yet
 * (the account's order page). Nothing is added up here: the figures are the server's (CartViewData / OrderView).
 */
export function Adjustments({ discounts = [], waiver = null, split = null, className }: { discounts?: readonly DiscountLineView[]; waiver?: ShippingWaiverView | null; split?: { walletIqd: number; restIqd: number } | null; className?: string }) {
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
  // Every part of the discount by its kind, in the saving colour (client round 1) — the kit's row above is the total
  // («الخصم»; `summaryCoupon` no longer names a coupon there when the parts are listed here)
  const breakdown = discounts.length > 0;
  if (!breakdown && !waiver && !split) return null;
  return (
    <div className={className ? `co-adjust ${className}` : "co-adjust"}>
      {breakdown ? (
        <ul className="co-adjust__list" aria-label={t("discounts.label")}>
          {discounts.map((entry, index) => (
            // one line per part: its icon, its name, its amount (G7 "one idea per line"). The coupon's own words — the
            // admin's free text, in the store's language only — are said by the coupon field where the code is managed
            // (CouponForm), never here: on an English or Kurdish page they read as a stray Arabic paragraph.
            <li key={`${entry.kind}:${index}`} className="co-adjust__row co-adjust__row--off">
              <span className="flex min-w-0 items-start gap-1.5">
                <Icon name={DISCOUNT_ICON[entry.kind]} size={16} className="mt-0.5 shrink-0" />
                <span className="min-w-0">{discountLabel(entry, t, f)}</span>
              </span>
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
              {waiverWords(waiver, t, f)}{" "}
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
 * The coupon the kit summary may name on its discount row: only when the discount's parts are not known (an order from
 * before the itemised discounts). Otherwise the summary draws the parts (summaryDiscountParts) — or, when they do not
 * add up to the discount (an order edited after it was placed), its one «الخصم» row, never naming a coupon for money
 * that is not all the coupon's.
 */
export function summaryCoupon<C>(discounts: readonly DiscountLineView[] | undefined, coupon: C | null): C | null {
  return (discounts ?? []).length === 0 ? coupon : null;
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
