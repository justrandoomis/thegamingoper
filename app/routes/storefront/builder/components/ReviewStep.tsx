/**
 * Step 4 — the review (docs/switch-builder.md §6.8), from the server's quote (builder.server.ts quoteBuilderPlan:
 * catalogue prices and availability read now; the cart prices the order itself).
 *
 * Lines (data-tour="review-lines"): the console or «جهازك»; the card, «بطاقتك» or «بدون بطاقة»; TamTam's cartridges;
 * the digital games (the eShop total of those TamTam has a price for, and the ones still without one); the eShop cards
 * that cover that total when TamTam sells them. One red figure: «الإجمالي», the orderable lines' sum.
 *
 * Notes (data-tour="review-notes"): what TamTam cannot sell now, the games without a price, and how digital games are
 * bought — the shopper redeems the eShop card on a US Nintendo Account, then buys the game on the eShop. After a refused
 * add, each line says why (cart-client cartErrorKey) and nothing has changed in the cart.
 */
import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import type { BuilderPlan, BuilderQuote, QuoteLine } from "~/lib/switch-builder/types";
import { BidiText, isolate } from "~/ui/BidiText";
import { cartErrorKey } from "~/ui/cart-client";
import { cx } from "~/ui/cx";
import { ErrorState } from "~/ui/ErrorState";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { Price } from "~/ui/Price";
import { Render } from "~/ui/Stage";
import { cardLabel, usdText, useBuilderT } from "../lib/format";
import type { LibraryEntry } from "../lib/library";
import type { AddAllRefusal } from "./AddAllKey";
import { keepDashes, MODEL_ART } from "./DeviceStep";

export type QuoteView = {
  status: "idle" | "loading" | "ready" | "error";
  quote: BuilderQuote | null;
  offline: boolean;
  retry: () => void;
};

export type ReviewStepProps = {
  plan: BuilderPlan;
  byId: ReadonlyMap<string, LibraryEntry>;
  quote: QuoteView;
  refusal: AddAllRefusal | null;
};

/** The words for a list of titles in the page's language («A، B وC» is the shop's style: a comma list). */
function listOf(titles: readonly string[], locale: string): string {
  return titles.map((title) => isolate(title)).join(locale === "en" ? ", " : "، ");
}

/** An ISO day ("2026-11-21") as a time at noon UTC (the same calendar day in Iraq and on the server), else null. */
function dayOf(iso: string | undefined): number | null {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The oldest day staff checked an eShop price behind the digital total: the priced digital games are the plan's games
 * that are neither a cartridge line nor unpriced (the quote's own split). Null when no date is known (yet). Pure.
 */
export function eshopPricesAsOf(plan: BuilderPlan, quote: BuilderQuote, byId: ReadonlyMap<string, LibraryEntry>): number | null {
  const cartridges = new Set(quote.lines.flatMap((line) => (line.kind === "cartridge" && line.gameId ? [line.gameId] : [])));
  const unpriced = new Set(quote.digital.unpricedIds);
  let oldest: number | null = null;
  for (const game of plan.games) {
    if (cartridges.has(game.id) || unpriced.has(game.id)) continue;
    const day = dayOf(byId.get(game.id)?.extras?.priceAsOf);
    if (day !== null && (oldest === null || day < oldest)) oldest = day;
  }
  return oldest;
}

export function ReviewStep({ plan, byId, quote, refusal }: ReviewStepProps) {
  const t = useBuilderT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const locale = useLocale();

  if (quote.status === "error") {
    return (
      <div className="sb-step">
        <ErrorState title={t("review.quoteError")} text={quote.offline ? t("review.offline") : undefined} onRetry={quote.retry} retryLabel={t("review.retry")} offline={quote.offline} alert />
      </div>
    );
  }
  const q = quote.quote;
  if (!q) {
    return (
      <div className="sb-step">
        <div className="sb-review surface sb-review--pending" aria-busy="true">
          <p className="sb-loading__text" role="status">
            {t("review.quoteLoading")}
          </p>
        </div>
      </div>
    );
  }

  const problemOf = (line: QuoteLine): string | null => {
    const problem = refusal?.problems.find((item) => item.variantId === line.variantId);
    return problem ? shop(cartErrorKey(problem.code)) : null;
  };
  const stateOf = (line: QuoteLine): string | null => (line.orderable ? null : t(`review.lineState.${line.reason ?? "unavailable"}`));
  const deviceLine = q.lines.find((line) => line.kind === "device") ?? null;
  const cardLine = q.lines.find((line) => line.kind === "card") ?? null;
  const cartridges = q.lines.filter((line) => line.kind === "cartridge");
  const eshop = q.lines.filter((line) => line.kind === "eshop");
  const deviceNotSold = q.notSold.find((item) => item.kind === "device") ?? null;
  const cardNotSold = q.notSold.find((item) => item.kind === "card") ?? null;
  const modelName = t(`device.models.${plan.device.model}`);
  const digitalCount = q.digital.pricedCount + q.digital.unpricedIds.length;
  // a USD price is said with its "as of" date (docs/switch-builder.md §1.5): the total, with the oldest check behind it
  const pricesAsOf = q.digital.pricedCount > 0 ? eshopPricesAsOf(plan, q, byId) : null;
  const unpricedTitles = q.digital.unpricedIds.map((id) => byId.get(id)?.game.title ?? id);
  const orderable = q.lines.some((line) => line.orderable);
  const notes: ReactNode[] = [];
  if (deviceNotSold && !plan.device.owned) notes.push(<Note key="device" icon="storefront">{t("review.notes.deviceNotSold", { name: modelName })}</Note>);
  if (cardNotSold) notes.push(<Note key="card" icon="sim-card">{t("review.notes.cardNotSold", { size: cardLabel(cardNotSold.sizeGB ?? plan.card.sizeGB) })}</Note>);
  if (unpricedTitles.length > 0) notes.push(<Note key="unpriced" icon="tag">{t("review.notes.unpriced", { titles: listOf(unpricedTitles, locale) })}</Note>);
  if (digitalCount > 0) notes.push(<Note key="digital" icon="kind-topup">{t("review.notes.howDigital")}</Note>);
  if (digitalCount > 0 && q.digital.pricedCount > 0 && !q.digital.cardsSold) notes.push(<Note key="cards" icon="info">{t("review.notes.noEshopCards")}</Note>);

  const line = (row: QuoteLine) => (
    <LineRow
      key={`${row.kind}:${row.variantId}:${row.gameId ?? ""}`}
      art={row.art}
      icon={row.kind === "eshop" ? "kind-topup" : row.kind === "cartridge" ? "kind-game" : "kind-console"}
      title={row.name}
      detail={row.variantTitle}
      qty={row.qty}
      price={row.unitPriceIqd > 0 ? <Price amountIqd={row.unitPriceIqd * row.qty} size="sm" as="span" approx="off" /> : null}
      state={stateOf(row)}
      problem={problemOf(row)}
    />
  );

  return (
    <div className="sb-step">
      <section className="sb-review surface" data-tour="review-lines" aria-labelledby="sb-review-lines">
        <h2 id="sb-review-lines" className="sb-h2">
          {t("review.linesTitle")}
        </h2>
        <ul className="sb-lines">
          {deviceLine ? (
            line(deviceLine)
          ) : (
            <LineRow
              art={MODEL_ART[plan.device.model]}
              icon="kind-console"
              title={plan.device.owned ? t("review.deviceOwned", { name: modelName }) : t("review.deviceNotSold", { name: modelName })}
              muted
            />
          )}
          {cardLine ? (
            line(cardLine)
          ) : (
            <LineRow
              icon="kind-storage"
              title={plan.card.sizeGB === 0 ? t("review.cardNone") : plan.card.owned ? t("review.cardOwned", { size: cardLabel(plan.card.sizeGB) }) : `${t("review.card")} ${cardLabel(plan.card.sizeGB)}`}
              detail={cardNotSold ? t("memory.notSold") : undefined}
              muted
            />
          )}
          {cartridges.map(line)}
          {digitalCount > 0 ? (
            <LineRow
              icon="game-controller"
              title={t("review.digitalTitle")}
              detail={
                <>
                  {q.digital.pricedCount > 0 ? (
                    <span className="block nums">{t("review.digitalPriced", { count: q.digital.pricedCount, n: f.number(q.digital.pricedCount), total: usdText(f, q.digital.pricedCents) })}</span>
                  ) : null}
                  {pricesAsOf !== null ? <span className="block nums">{t("review.pricesAsOf", { count: q.digital.pricedCount, date: f.date(pricesAsOf) })}</span> : null}
                  {q.digital.unpricedIds.length > 0 ? (
                    <span className="block nums">{t("review.digitalUnpriced", { count: q.digital.unpricedIds.length, n: f.number(q.digital.unpricedIds.length) })}</span>
                  ) : null}
                </>
              }
              muted
            />
          ) : null}
          {eshop.map(line)}
        </ul>
        {/* the cards in stock may cover only part of the digital total: say so, never imply they cover it all */}
        {q.digital.cardsSold && q.digital.cardsCents > 0 ? (
          <p className="sb-review__cover nums">
            {q.digital.cardsCents < q.digital.pricedCents
              ? t("review.eshopCardsPartial", { value: usdText(f, q.digital.cardsCents), total: usdText(f, q.digital.pricedCents) })
              : t("review.eshopCards", { value: usdText(f, q.digital.cardsCents) })}
          </p>
        ) : null}
        <div className="sb-review__total">
          <span className="sb-review__total-label">{t("review.total")}</span>
          <Price amountIqd={q.totalIqd} tone="total" size="lg" />
        </div>
        {refusal ? (
          <p className="sb-review__refused" role="alert">
            <Icon name="warning-circle" size={20} />
            {refusal.problems.length > 0 ? t("review.refused") : t("review.refusedGeneric", { reason: shop(cartErrorKey(refusal.code)) })}
          </p>
        ) : null}
        {!orderable ? <p className="sb-review__nothing">{t("review.nothing")}</p> : null}
      </section>

      {/* only when there is something to say: an empty section would leave the guide pointing at nothing */}
      {notes.length > 0 ? (
        <section className="sb-notes" data-tour="review-notes" aria-label={t("review.notesTitle")}>
          {notes}
        </section>
      ) : null}
    </div>
  );
}

function LineRow({
  art,
  icon,
  title,
  detail,
  qty = 1,
  price = null,
  state = null,
  problem = null,
  muted = false,
}: {
  art?: string;
  icon: IconName;
  title: string;
  detail?: ReactNode;
  qty?: number;
  price?: ReactNode;
  state?: string | null;
  problem?: string | null;
  muted?: boolean;
}) {
  const t = useBuilderT();
  const f = useFormat();
  return (
    <li className={cx("sb-line", muted && "sb-line--muted")} data-problem={problem ? "" : undefined}>
      {art ? (
        <Niche as="span" size="sm" className="sb-line__art">
          <Render name={art} alt="" sizes="56px" />
        </Niche>
      ) : (
        <span className="sb-line__glyph" aria-hidden="true">
          <Icon name={icon} size={24} />
        </span>
      )}
      <span className="sb-line__text">
        <span className="sb-line__name">
          <BidiText text={keepDashes(title)} />
        </span>
        {detail ? <span className="sb-line__detail">{typeof detail === "string" ? <BidiText text={detail} /> : detail}</span> : null}
        {state ? <span className="sb-line__state">{state}</span> : null}
        {problem ? <span className="sb-line__problem">{problem}</span> : null}
      </span>
      {price ? (
        <span className="sb-line__price">
          {qty > 1 ? <span className="sb-line__qty nums">{t("review.qty", { n: f.number(qty) })}</span> : null}
          {price}
        </span>
      ) : null}
    </li>
  );
}
