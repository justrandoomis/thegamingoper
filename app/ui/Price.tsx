import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { assertIqd, CURRENCIES, type CurrencyCode, type FxSnapshot } from "~/lib/money";
import { CountUp, NumberMorph } from "~/motion";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * A price — Design System v2 §4.8: Kufam 700 figures (tabular; v2.1), the currency after the figure in Plex 600 at the
 * fixed size of its step (never under 12px), joined to it; never animated.
 *
 *   <Price amountIqd={667750} />                                  card (md 18)
 *   <Price amountIqd={667750} size="xl" />                        PDP, hero, wallet balance (30 → 36)
 *   <Price amountIqd={99000} compareAtIqd={115000} />             sale: red-ink, the real previous price struck above it
 *   <Price amountIqd={1513750} size="lg" tone="total" />          the ONE red figure of a summary or task bar
 *   <Price amountIqd={667750} size="xl" tone="onColor" />         white on a band
 *   <Price amountIqd={13000} tone="muted" />                      sold out
 *   <Price amountIqd={5000} size="sm" as="span" approx="off" />   inside a sentence
 *
 * Tones: ink (every selling price) · sale (only with a real previous price — set automatically by `compareAtIqd`) ·
 * total · onColor · muted. Screen readers hear "667,750 دينار عراقي". The amount is INTEGER Iraqi dinars (a fraction
 * throws). When the shopper chose another display currency a second line says "≈ … · الدفع بالدينار العراقي" (never bold,
 * never on a key or a total line); its digits are the only money that moves (NumberMorph). Without a configured rate
 * nothing is converted.
 */
export type PriceSize = "xl" | "lg" | "md" | "sm";
export type PriceTone = "ink" | "sale" | "total" | "onColor" | "muted";

export type PriceProps = {
  amountIqd: number;
  /** xl 30–36 (PDP, hero, wallet) · lg 22–24 (buy bar, totals) · md 18 (cards) · sm 16 (lines, summaries). */
  size?: PriceSize;
  /** Default: "sale" when a real previous price is given, else "ink". */
  tone?: PriceTone;
  /** The real previous price — shown struck above the price, only when it is higher than `amountIqd`. */
  compareAtIqd?: number | null;
  /** "auto" (default): add the converted line when the display currency is not IQD. "off": dinar only. */
  approx?: "auto" | "off";
  /** Rate source and update time behind a disclosure under the converted line. Default: on for xl. */
  rateDetails?: boolean;
  /** Element for the price line. Use "span" inside running text (no block line is added then). */
  as?: "p" | "span" | "div";
  /**
   * v2.1 (G6, client note 12): a figure that is the page's news — a trade-in offer — counts up ONCE (CountUp): the
   * server renders the final figure, the count runs when it first comes into view; "load" also counts on a direct open
   * (from 70%, never from zero). Instant under reduced motion. Never for a price that is merely shown.
   */
  countUp?: boolean | "load";
  className?: string;
};

type RootFx = { fx?: FxSnapshot | null; fxIsDemo?: boolean };

const TONE_CLASS: Record<PriceTone, string | undefined> = {
  ink: undefined,
  sale: "price--sale",
  total: "price--total",
  onColor: "price--on-color",
  muted: "price--muted",
};

export function Price({ amountIqd, size = "md", tone, compareAtIqd = null, approx = "auto", rateDetails, as = "p", countUp = false, className }: PriceProps) {
  assertIqd(amountIqd);
  const f = useFormat();
  const t = useT("ui");
  const root = useRouteLoaderData("root") as RootFx | undefined;
  const fx = root?.fx ?? null;
  const Line = as;
  const inline = as === "span";
  const Block = inline ? "span" : "div";

  const was = compareAtIqd !== null && compareAtIqd !== undefined && compareAtIqd > amountIqd ? assertIqd(compareAtIqd) : null;
  const look = tone ?? (was !== null ? "sale" : "ink");
  const figure = f.number(amountIqd);
  const main = (
    <Line className={cx("price", `price--${size}`, TONE_CLASS[look], amountIqd >= 1_000_000 && "price--long", className)}>
      {was !== null && inline ? <Was amountIqd={was} inline /> : null}
      {/* the figure and «د.ع» are one unbreakable unit (§2.6, §4.8): at 320px they wrapped apart («667,750» / «د.ع») */}
      <span className="price__amount" aria-hidden="true">
        <span className="price__num">{countUp ? <CountUp value={amountIqd} format={f.number} playOnLoad={countUp === "load"} /> : figure}</span>
        <span className="price__cur">{CURRENCIES.IQD.symbol[f.locale]}</span>
      </span>
      <VisuallyHidden>{t("price.aria", { amount: figure })}</VisuallyHidden>
    </Line>
  );
  // the real previous price sits above the price (cards, PDP); inline it goes first
  const withWas =
    was !== null && !inline ? (
      <Block className="price-block">
        <Was amountIqd={was} />
        {main}
      </Block>
    ) : (
      main
    );

  if (approx === "off" || f.currency === "IQD") return withWas;

  const converted = f.moneyParts(amountIqd);
  if (!converted.approx) {
    // A display currency is chosen but no rate is configured: say so instead of inventing a number.
    if (size !== "xl" && size !== "lg") return withWas;
    return (
      <Block className="price-block">
        {withWas}
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
      {withWas}
      {withDetails ? (
        <details className="price__fx price__approx">
          <summary>
            <span>{line}</span>
            <Icon name="caret-down" size={16} />
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

/**
 * The real previous price: 13px ink-2, struck, «السعر قبل التخفيض» for screen readers. Above the price it is a flex row
 * of its own, so its line is the 13px figure's (≈16px), not the page's 16px body line (27px) it would inherit.
 */
function Was({ amountIqd, inline = false }: { amountIqd: number; inline?: boolean }) {
  const t = useT("ui");
  const f = useFormat();
  return (
    <span className={cx("price__was-line", !inline && "flex")}>
      <VisuallyHidden>{t("price.was")} </VisuallyHidden>
      <s className="price__was">
        <bdi>{f.number(amountIqd)}</bdi>
      </s>
      <VisuallyHidden> {t("price.now")}</VisuallyHidden>
    </span>
  );
}
