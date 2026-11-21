/**
 * Step 4 — the review (docs/switch-builder.md §6.8), from the server's quote (builder.server.ts quoteBuilderPlan:
 * catalogue prices and availability read now; the cart prices the order itself).
 *
 * Lines (data-tour="review-lines"): the console or «جهازك»; the card, «بطاقتك» or «بدون بطاقة»; TamTam's cartridges;
 * the digital games (the eShop total of those TamTam has a price for, with the oldest day staff checked a price behind
 * it, and the ones still without one); the eShop cards that cover that total when TamTam sells them — and when the
 * cards in stock cover only part of it, a plain sentence with both amounts. One red figure: «الإجمالي», the orderable
 * lines' sum.
 *
 * Notes (data-tour="review-notes"): what TamTam cannot sell now, the games without a price (by name once the list has
 * named them — while it loads, how many and «نحمّل أسماء هذه الألعاب…»; never a store slug), how digital games are
 * bought — the shopper adds the eShop card's value to a US Nintendo Account, then buys the game on the eShop — and, when
 * a newer game list was published since the page was opened, the reload notice. After a refused add, each line says why
 * (cart-client cartErrorKey) and nothing has changed in the cart; the page asks for the quote again at once, and the
 * reasons stay until it answers.
 *
 * Above the lines, at every width: when the chosen games no longer fit (a smaller card or console was chosen after
 * them — below 1024 no space bar is on this screen), the over-full warning with both figures and the ways out («بطاقة
 * أكبر», «غيّر الألعاب»); and when another version of this plan was put in the cart during this visit, a reminder to
 * check the cart before adding again, so nothing is doubled.
 */
import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { PlanUsage } from "~/lib/switch-builder/plan";
import { digitsToTell } from "~/lib/switch-builder/storage";
import type { BuilderPlan, BuilderQuote, LibraryExtras, QuoteLine } from "~/lib/switch-builder/types";
import { BidiText, isolate } from "~/ui/BidiText";
import { cartErrorKey } from "~/ui/cart-client";
import { cx } from "~/ui/cx";
import { ErrorState } from "~/ui/ErrorState";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { Price } from "~/ui/Price";
import { fillNodes } from "~/ui/PriceTag";
import { Render } from "~/ui/Stage";
import { TextLink } from "~/ui/TextLink";
import { cardLabel, gbText, shortfallText, usdText, useBuilderT } from "../lib/format";
import type { LibraryEntry } from "../lib/library";
import { stepHref } from "../lib/steps";
import { NOTHING_ID, type AddAllRefusal } from "./AddAllKey";
import { keepDashes, MODEL_ART } from "./DeviceStep";
import { LibraryUpdated } from "./LibraryUpdated";

export type QuoteView = {
  status: "idle" | "loading" | "ready" | "error";
  quote: BuilderQuote | null;
  offline: boolean;
  retry: () => void;
};

/** Whether something the review shows besides the quote is here: "ready" · "loading" · "unavailable" (it did not load). */
export type ReviewFacts = "ready" | "loading" | "unavailable";

export type ReviewStepProps = {
  plan: BuilderPlan;
  /** The list's games (titles), once the list file has answered. */
  byId: ReadonlyMap<string, LibraryEntry>;
  /** TamTam's data (each eShop price's "as of" day), once GET /api/switch-library has answered. */
  extras: Readonly<Record<string, LibraryExtras>>;
  /** Can the games be named: the list file answered · is loading · did not load. */
  names?: ReviewFacts;
  /** Are the eShop prices' dates here: TamTam's data answered · is loading · did not load. */
  dates?: ReviewFacts;
  /** A newer game list was published after the page was opened (the reload notice). */
  updated?: boolean;
  /** The space bar's figures, when the chosen games' sizes are known: over the space, the warning above the lines. */
  usage?: PlanUsage | null;
  /** A bigger card exists (the warning's «بطاقة أكبر»). */
  biggerCard?: boolean;
  /** Another version of this plan went in the cart during this visit (the reminder above the lines). */
  addedBefore?: boolean;
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
 * that are neither a cartridge line nor unpriced (the quote's own split). Read from TamTam's data alone (no list file
 * needed). Null when no date is known (yet). Pure.
 */
export function eshopPricesAsOf(plan: BuilderPlan, quote: BuilderQuote, extras: Readonly<Record<string, LibraryExtras>>): number | null {
  const cartridges = new Set(quote.lines.flatMap((line) => (line.kind === "cartridge" && line.gameId ? [line.gameId] : [])));
  const unpriced = new Set(quote.digital.unpricedIds);
  let oldest: number | null = null;
  for (const game of plan.games) {
    if (cartridges.has(game.id) || unpriced.has(game.id)) continue;
    const day = dayOf(Object.hasOwn(extras, game.id) ? extras[game.id]?.priceAsOf : undefined);
    if (day !== null && (oldest === null || day < oldest)) oldest = day;
  }
  return oldest;
}

/**
 * The titles of the games the quote has no price for, in its order — or null when any of them cannot be named (the
 * list has not answered, did not load, or no longer has the game): the note then counts them instead. Never the
 * store slug a title stands for. Pure.
 */
export function unpricedTitles(ids: readonly string[], byId: ReadonlyMap<string, LibraryEntry>): string[] | null {
  const titles: string[] = [];
  for (const id of ids) {
    const title = byId.get(id)?.game.title;
    if (typeof title !== "string" || title.trim() === "") return null;
    titles.push(title);
  }
  return titles;
}

/** The warnings above the review's lines (any width): the plan is over its space; another version of it is in the cart. */
function ReviewWarnings({ usage, biggerCard, addedBefore }: { usage: PlanUsage | null; biggerCard: boolean; addedBefore: boolean }) {
  const t = useBuilderT();
  const f = useFormat();
  const over = usage && usage.usage.overBytes > 0 ? usage.usage : null;
  if (!over && !addedBefore) return null;
  const digits = over ? digitsToTell(over.usedBytes, over.plannableBytes) : 1;
  return (
    <>
      {over ? (
        <Note
          tone="warning"
          className="sb-review__warning"
          title={t("meter.over", { over: shortfallText(f, over.usedBytes, over.plannableBytes) })}
          action={
            <span className="sb-review__ways">
              {biggerCard ? (
                <TextLink as={LocaleLink} to={stepHref("memory")}>
                  {t("fit.biggerCard")}
                </TextLink>
              ) : null}
              <TextLink as={LocaleLink} to={stepHref("games")}>
                {t("review.overGames")}
              </TextLink>
            </span>
          }
        >
          <span className="nums">{t("memory.over", { need: gbText(f, over.usedBytes, digits), plannable: gbText(f, over.plannableBytes, digits) })}</span>
        </Note>
      ) : null}
      {addedBefore ? (
        <Note
          tone="info"
          icon="shopping-cart-simple"
          className="sb-review__warning"
          action={
            <TextLink as={LocaleLink} to="/cart">
              {t("review.viewCart")}
            </TextLink>
          }
        >
          {t("review.addedBefore")}
        </Note>
      ) : null}
    </>
  );
}

export function ReviewStep({ plan, byId, extras, names = "ready", dates = "ready", updated = false, usage = null, biggerCard = false, addedBefore = false, quote, refusal }: ReviewStepProps) {
  const t = useBuilderT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const locale = useLocale();
  const warnings = <ReviewWarnings usage={usage} biggerCard={biggerCard} addedBefore={addedBefore} />;

  if (quote.status === "error") {
    // the builder's own words when the connection is gone: the quote is asked again by itself when it is back (the
    // kit's offline sentence would ask the shopper to retry). `offline={false}` keeps the kit from replacing them.
    return (
      <div className="sb-step">
        {warnings}
        <ErrorState title={t("review.quoteError")} text={quote.offline ? t("review.quoteOffline") : undefined} onRetry={quote.retry} retryLabel={t("review.retry")} offline={false} alert />
      </div>
    );
  }
  const q = quote.quote;
  if (!q) {
    return (
      <div className="sb-step">
        {warnings}
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
  // a USD price is said with its "as of" date (docs/switch-builder.md §1.5): the total, with the oldest check behind it;
  // while TamTam's data is on its way the line says so, and without a known day it still says the prices are as checked
  const pricesAsOf = q.digital.pricedCount > 0 && dates === "ready" ? eshopPricesAsOf(plan, q, extras) : null;
  const datesLine =
    q.digital.pricedCount === 0
      ? null
      : pricesAsOf !== null
        ? t("review.pricesAsOf", { count: q.digital.pricedCount, date: f.date(pricesAsOf, "long") })
        : dates === "loading"
          ? t("review.pricesAsOfLoading")
          : t("credits.eshop");
  const unpriced = q.digital.unpricedIds.length;
  // the games without a price, by name — or, until the list names every one of them, how many (never a store slug)
  const titles = unpriced > 0 ? unpricedTitles(q.digital.unpricedIds, byId) : null;
  // the cards in stock may cover only part of the priced digital total: said plainly, with both amounts
  const partialCover = q.digital.cardsSold && q.digital.cardsCents > 0 && q.digital.cardsCents < q.digital.pricedCents;
  const orderable = q.lines.some((line) => line.orderable);
  const notes: ReactNode[] = [];
  if (deviceNotSold && !plan.device.owned) notes.push(<Note key="device" icon="storefront">{t("review.notes.deviceNotSold", { name: modelName })}</Note>);
  if (cardNotSold) notes.push(<Note key="card" icon="sim-card">{t("review.notes.cardNotSold", { size: cardLabel(cardNotSold.sizeGB ?? plan.card.sizeGB) })}</Note>);
  if (unpriced > 0) {
    notes.push(
      <Note key="unpriced" icon="tag">
        {titles ? (
          t("review.notes.unpriced", { titles: listOf(titles, locale) })
        ) : (
          <>
            {t("review.notes.unpricedCount", { count: unpriced, n: f.number(unpriced) })}
            {names === "loading" ? <span className="block">{t("review.notes.namesLoading")}</span> : null}
          </>
        )}
      </Note>,
    );
  }
  if (digitalCount > 0) notes.push(<Note key="digital" icon="kind-topup">{t("review.notes.howDigital")}</Note>);
  if (digitalCount > 0 && q.digital.pricedCount > 0 && !q.digital.cardsSold) notes.push(<Note key="cards" icon="info">{t("review.notes.noEshopCards")}</Note>);
  // a newer game list was published since this page was opened: the names (and the details) come with a reload
  if (updated && plan.games.length > 0) notes.push(<LibraryUpdated key="updated" />);

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
      {warnings}
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
                  {datesLine !== null ? <span className="block nums">{datesLine}</span> : null}
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
        {/* the cards in stock may cover only part of the digital total: said plainly, both amounts in ink (the total's
            date is on the digital games' line above), never implying the cards cover it all */}
        {partialCover ? (
          <Note variant="line" tone="warning" className="sb-review__cover-note nums">
            {fillNodes(t("review.eshopCardsPartial"), {
              value: <b>{usdText(f, q.digital.cardsCents)}</b>,
              total: <b>{usdText(f, q.digital.pricedCents)}</b>,
            })}
          </Note>
        ) : q.digital.cardsSold && q.digital.cardsCents > 0 ? (
          <p className="sb-review__cover nums">{t("review.eshopCards", { value: usdText(f, q.digital.cardsCents) })}</p>
        ) : null}
        <div className="sb-review__total">
          <span className="sb-review__total-label">{t("review.total")}</span>
          <Price amountIqd={q.totalIqd} tone="total" size="lg" />
        </div>
        {refusal ? (
          // an alert when the lines say why (nothing else speaks); a refusal without named lines is said by the error
          // toast that offers the retry, so the sentence here stays quiet
          <p className="sb-review__refused" role={refusal.problems.length > 0 ? "alert" : undefined}>
            <Icon name="warning-circle" size={20} />
            {refusal.problems.length > 0 ? t("review.refused") : t("review.refusedGeneric", { reason: shop(cartErrorKey(refusal.code)) })}
          </p>
        ) : null}
        {/* the add-all key's reason when it is flat (its aria-describedby) */}
        {!orderable ? (
          <p id={NOTHING_ID} className="sb-review__nothing">
            {t("review.nothing")}
          </p>
        ) : null}
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
