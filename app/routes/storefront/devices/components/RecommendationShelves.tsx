/**
 * Recommendation shelves on any storefront page (the integration pass) — the devices area's engine
 * (services/recommendations.server → recommendationsFor → getRecommendations), streamed by the page's loader:
 *
 *   loader   recommendations: recommendationsFor(db, { cookie: ctx.cookie, customerId }, { locale, context: "product", productId }, 8)
 *            — NOT awaited: the page never waits for its suggestions (the promise never rejects; a failure is ok:false)
 *   page     <RecommendationShelves key={product.id} result={loaderData.recommendations} source="product" />
 *
 * Every shelf keeps the engine's honest title and reason line ("متوافقة مع Switch 2، وتحقّقنا من ذلك", "اختيارات
 * المتجر", "حسب ما تصفّحته… بموافقتك") and its hard compatibility filter; nothing is added or re-ranked here.
 *
 * States: nothing is drawn until the answer is here (no placeholder that could collapse into nothing — most pages may
 * get no shelf at all), then the cards inflate in (<Bubble>, DESIGN.md §7.2 — content that arrives). A newer answer
 * (other filters on a hub) replaces the shelves only once it has arrived, so a list being filtered never flickers;
 * give it a `key` when it stands for another thing (another product) so old shelves never show under the new page.
 * A failure is the kit's ErrorState in the shelves' place with a retry (revalidates the page); the rest of the page
 * stands. Reduced motion: the engine's rules (no inflate). Clicks on its cards are "click" signals with the shelf's
 * key as the source — only with consent (./signals.ts). No React Suspense here on purpose: a revealed boundary that
 * suspends again would hold the whole navigation (hub filters) until the suggestions arrive.
 */
import { useEffect, useId, useState, type MouseEvent } from "react";
import { useRevalidator } from "react-router";

import type { ProductCardData, Shelf } from "~/lib/dto";
import { Bubble, BubbleGroup } from "~/motion";
import type { RecommendationResult } from "~/server/services/recommendations.server";
import { cx } from "~/ui/cx";
import { ErrorState } from "~/ui/ErrorState";
import { ProductCard } from "~/ui/ProductCard";
import { Rail } from "~/ui/Rail";
import { ShelfRail } from "~/ui/ShelfRail";
import { readConsent } from "~/routes/storefront/home/personal";
import { sendRecommendationEvent } from "./signals";

export type { RecommendationResult };

export type RecommendationShelvesProps = {
  /** The loader's streamed answer (or an answer already at hand). */
  result: Promise<RecommendationResult> | RecommendationResult | null | undefined;
  /** Signal source prefix, usually the context ("product", "cart", "home"…). */
  source: string;
  /** Heading level of the shelf titles (default 2). */
  headingLevel?: 2 | 3;
  /** `sizes` of the card pictures. */
  sizes?: string;
  /** "page" (default): the kit's rail across the page · "column": a narrower column (cart, order) — four cards from 1024px. */
  layout?: "page" | "column";
  className?: string;
};

const isPromise = (value: unknown): value is Promise<RecommendationResult> => typeof (value as { then?: unknown } | null)?.then === "function";

/** The answer once it is here; the previous one stays until a newer one arrives (none asked for: nothing shown). */
function useArrived(result: RecommendationShelvesProps["result"]): RecommendationResult | null {
  const [value, setValue] = useState<RecommendationResult | null>(() => (result && !isPromise(result) ? result : null));
  useEffect(() => {
    if (!result) {
      setValue(null);
      return;
    }
    if (!isPromise(result)) {
      setValue(result);
      return;
    }
    let live = true;
    result.then(
      (answer) => {
        if (live) setValue(answer);
      },
      () => {
        // recommendationsFor never rejects; a stream cut short (streamTimeout, a dropped connection) can
        if (live) setValue({ ok: false, shelves: [] });
      },
    );
    return () => {
      live = false;
    };
  }, [result]);
  return value;
}

export function RecommendationShelves({ result, source, headingLevel, sizes, layout = "page", className }: RecommendationShelvesProps) {
  const value = useArrived(result);
  const revalidator = useRevalidator();
  if (!value) return null;
  if (!value.ok) {
    return <ErrorState className={className} onRetry={() => void revalidator.revalidate()} retrying={revalidator.state === "loading"} />;
  }
  if (value.shelves.length === 0) return null;

  /** A card opened from a shelf: the "click" signal of that shelf (this device's consent as it is now; the server checks again). */
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (readConsent() !== true) return;
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest<HTMLElement>("[data-product]");
    if (!card || !target?.closest("a[href]") || !event.currentTarget.contains(card)) return;
    const productId = card.dataset.product;
    const shelf = card.closest<HTMLElement>("[data-shelf]")?.dataset.shelf ?? source;
    const from = shelf.startsWith(`${source}:`) ? shelf : `${source}:${shelf}`;
    if (productId) sendRecommendationEvent({ kind: "click", productId, source: from.slice(0, 64) });
  };

  return (
    // listens to the links inside (a keyboard activation of a link is a click too); the div itself is not a control
    <div onClick={onClick} className={cx("grid min-w-0 gap-section", className)}>
      {value.shelves.map((shelf: Shelf<ProductCardData>) => (
        <BubbleGroup key={shelf.key} stagger>
          {layout === "column" ? (
            <ColumnShelf shelf={shelf} headingLevel={headingLevel} sizes={sizes ?? COLUMN_SIZES} />
          ) : (
            <ShelfRail
              shelf={shelf}
              headingLevel={headingLevel}
              renderItem={(card, index) => (
                <Bubble index={index} className="flex w-full">
                  <ProductCard card={card} slot={shelf.key} sizes={sizes} />
                </Bubble>
              )}
            />
          )}
        </BubbleGroup>
      ))}
    </div>
  );
}

/** A narrower column (cart, order) from 1024px: four cards across, so price and socket keep one row (~/ui/ProductCard). */
const COLUMN_ITEM = "flex w-[43%] sm:w-[30%] md:w-[23%] lg:w-[23.5%]";
const COLUMN_SIZES = "(min-width: 1024px) 200px, (min-width: 768px) 23vw, (min-width: 640px) 30vw, 43vw";

/** The kit's shelf (title, honest reason, one rail) with column-sized cards — the same markup as ~/ui/ShelfRail. */
function ColumnShelf({ shelf, headingLevel = 2, sizes }: { shelf: Shelf<ProductCardData>; headingLevel?: 2 | 3; sizes: string }) {
  const id = useId();
  const Heading = `h${headingLevel}` as const;
  if (shelf.items.length === 0) return null;
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-3" data-shelf={shelf.key}>
      <div className="grid min-w-0 gap-0.5">
        <Heading id={id} className="type-section text-ink">
          {shelf.title}
        </Heading>
        {shelf.reason ? <p className="type-caption text-ink-2">{shelf.reason}</p> : null}
      </div>
      <Rail aria-labelledby={id} itemClassName={COLUMN_ITEM} railClassName="-mx-1 scroll-px-1 px-1 pt-1 pb-3">
        {shelf.items.map((card, index) => (
          <Bubble key={card.id} index={index} className="flex w-full">
            <ProductCard card={card} slot={shelf.key} sizes={sizes} />
          </Bubble>
        ))}
      </Rail>
    </section>
  );
}
