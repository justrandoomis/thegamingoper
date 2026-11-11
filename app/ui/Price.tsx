import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { assertIqd, CURRENCIES, type CurrencyCode, type FxSnapshot } from "~/lib/money";
import { NumberMorph } from "~/motion";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * A price (docs/DESIGN.md §9.11): flat ink on paper — Kufam 700, tabular lining figures, the currency label after
 * the figure and never under 11px. Never red, never struck through in red, never animated.
 *
 *   <Price amountIqd={749000} />                                 card size (md)
 *   <Price amountIqd={899000} size="xl" />                       product page; shows the converted line + rate
 *   <Price amountIqd={749000} compareAtIqd={819000} />           old price in ink-2 with a line through it, first
 *   <Price amountIqd={5000} size="sm" as="span" approx="off" />  inline in a sentence
 *
 * The amount is INTEGER Iraqi dinars (a fraction throws). The dinar is always the primary, payable figure. When the
 * shopper has chosen another display currency, a second line shows the conversion — prefixed "≈", followed by
 * "الدفع بالدينار العراقي", never bold — and the rate source and time are one tap away (`rateDetails`, default on
 * for xl). That converted line is the ONLY moving money in the app: its digits roll when the display currency
 * changes (NumberMorph); a new amount appears without motion. Without a configured rate nothing is converted.
 */
export type PriceSize = "xl" | "lg" | "md" | "sm";

export type PriceProps = {
  amountIqd: number;
  /** product page 28/34 · stage tag 21/28 · card 17 · inline 15 (mobile/desktop) */
  size?: PriceSize;
  /** The previous price, shown first with a line through it — only when it is higher than `amountIqd`. */
  compareAtIqd?: number | null;
  /** "auto" (default): add the converted line when the display currency is not IQD. "off": dinar only. */
  approx?: "auto" | "off";
  /** Rate source and update time behind a disclosure under the converted line. Default: on for xl. */
  rateDetails?: boolean;
  /** Element for the price line. Use "span" inside running text (no block line is added then). */
  as?: "p" | "span" | "div";
  className?: string;
};

type RootFx = { fx?: FxSnapshot | null; fxIsDemo?: boolean };

export function Price({ amountIqd, size = "md", compareAtIqd = null, approx = "auto", rateDetails, as = "p", className }: PriceProps) {
  assertIqd(amountIqd);
  const f = useFormat();
  const t = useT("ui");
  const root = useRouteLoaderData("root") as RootFx | undefined;
  const fx = root?.fx ?? null;
  const Line = as;
  const inline = as === "span";

  const was = compareAtIqd !== null && compareAtIqd !== undefined && compareAtIqd > amountIqd ? assertIqd(compareAtIqd) : null;
  const main = (
    <Line className={cx("price", `price--${size}`, className)}>
      {was !== null ? (
        <>
          <VisuallyHidden>{t("price.was")} </VisuallyHidden>
          <s className="price__was">
            <bdi>{f.number(was)}</bdi>
          </s>
          <VisuallyHidden> {t("price.now")} </VisuallyHidden>
        </>
      ) : null}
      <bdi className="price__num">{f.number(amountIqd)}</bdi>
      <span className="price__cur">{CURRENCIES.IQD.symbol[f.locale]}</span>
    </Line>
  );

  if (approx === "off" || f.currency === "IQD") return main;

  const converted = f.moneyParts(amountIqd);
  const Block = inline ? "span" : "div";
  if (!converted.approx) {
    // A display currency is chosen but no rate is configured: say so instead of inventing a number.
    if (size !== "xl" && size !== "lg") return main;
    return (
      <Block className="price-block">
        {main}
        <Block className="price__approx">{t("price.noRate")}</Block>
      </Block>
    );
  }

  // "≈ {amount} · الدفع بالدينار العراقي" with the amount as a rolling, isolated number
  const [before, after = ""] = t("price.approx", { amount: "\u0000" }).split("\u0000");
  const line: ReactNode = (
    <>
      {before}
      <bdi>
        <NumberMorph key={amountIqd} value={amountIqd} format={(v) => f.moneyParts(v).text} />
      </bdi>
      {after}
    </>
  );
  const withDetails = !inline && (rateDetails ?? size === "xl") && fx !== null;
  const currency = converted.currency as Exclude<CurrencyCode, "IQD">;

  return (
    <Block className="price-block">
      {main}
      {withDetails ? (
        <details className="price__fx price__approx">
          <summary>
            <span>{line}</span>
            <Icon name="caret-down" size={14} />
          </summary>
          <p className="price__rate">
            {t("price.rateTitle")}:{" "}
            {/* the equation reads left to right in every language; source and time are isolated runs */}
            <bdi dir="ltr">
              1 {CURRENCIES[currency].code} = {f.number(fx.iqdPerUnit[currency])} {CURRENCIES.IQD.symbol[f.locale]}
            </bdi>
            {" · "}
            <bdi>{fx.source}</bdi>
            {" · "}
            <bdi>{f.dateTime(fx.updatedAt)}</bdi>
            {root?.fxIsDemo ? <> · {t("price.demoRate")}</> : null}
          </p>
        </details>
      ) : (
        <Block className="price__approx">{line}</Block>
      )}
    </Block>
  );
}
