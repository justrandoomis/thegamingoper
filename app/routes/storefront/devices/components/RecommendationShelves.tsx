/**
 * Recommendation shelves on any storefront page — the devices area's engine (services/recommendations.server →
 * recommendationsFor → getRecommendations), streamed by the page's loader and drawn here in the v2 look (Design System
 * v2 §4.22, §2.11): the kit's shelf (`SectionHead` with the engine's honest reason line, then a native scroll-snap
 * rail on phones and whole cards from 1024 — never a carousel with arrows), the kit's frameless cards with the
 * neutral add button, the cards inflating in as they arrive (<Bubble>, from .94, 45 ms apart).
 *
 *   loader   recommendations: recommendationsFor(db, { cookie: ctx.cookie, customerId }, { locale, context: "product", productId }, 8)
 *            — NOT awaited: the page never waits for its suggestions (the promise never rejects; a failure is ok:false)
 *   page     <RecommendationShelves key={product.id} result={loaderData.recommendations} source="product" />
 *            <RecommendationShelves … layout="column" />          a narrower column (cart, order): at most four cards
 *            <RecommendationShelves … placeholder={{ title, reason, loading }} />   reserve the shelf while it streams
 *
 * Every shelf keeps the engine's honest title and reason line ("متوافقة مع Switch 2، وتحقّقنا من ذلك", "اختيارات
 * المتجر", "حسب ما تصفّحته… بموافقتك") and its hard compatibility filter; nothing is added or re-ranked here. A shelf
 * with fewer than three cards is not drawn (the kit's rule).
 *
 * States:
 *   pending   nothing by default — most pages may get no shelf at all, and a placeholder that collapses into nothing
 *             would move the page; pass `placeholder` when a shelf is expected: the same geometry with empty wells
 *             (`aria-busy`, a status line for screen readers), never a grey skeleton
 *   arrived   the cards inflate into place (reduced motion and the low tier: they appear); a newer answer (other filters
 *             on a hub) replaces the shelves only once it has arrived, so a list being filtered never flickers — give
 *             the component a `key` when it stands for another thing (another product) so old shelves never show
 *   empty     nothing — no element at all (also when every shelf has fewer than three cards, which the kit does not draw)
 *   failure   the kit's ErrorState in the shelves' place with a retry (revalidates the page; offline: the offline
 *             sentence, and the retry waits for the connection instead of failing the page — ./retry.ts); the rest of
 *             the page stands
 * Clicks on its cards are "click" signals with the shelf's key as the source — only with consent (./signals.ts). No
 * React Suspense here on purpose: a revealed boundary that suspends again would hold the whole navigation (hub
 * filters) until the suggestions arrive.
 */
import { useEffect, useId, useState, type MouseEvent } from "react";

import type { ProductCardData, Shelf } from "~/lib/dto";
import { Bubble, BubbleGroup } from "~/motion";
import type { RecommendationResult } from "~/server/services/recommendations.server";
import { readConsent } from "~/routes/storefront/home/personal";
import { cx } from "~/ui/cx";
import { ErrorState } from "~/ui/ErrorState";
import { ProductCard, ProductCardPlaceholder } from "~/ui/ProductCard";
import { Rail } from "~/ui/Rail";
import { SectionHead } from "~/ui/SectionHead";
import { ShelfRail } from "~/ui/ShelfRail";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { drawableShelves } from "./format";
import { useSafeRetry } from "./retry";
import { sendRecommendationEvent } from "./signals";

export type { RecommendationResult };

export type ShelfLayout = "page" | "column";

/** What a pending shelf shows while it streams in: the title and reason it will most likely carry. */
export type ShelfPlaceholderProps = {
  title: string;
  reason?: string | null;
  /** Said to screen readers while it loads ("نحضّر الإكسسوارات المتوافقة…"). */
  loading?: string;
};

export type RecommendationShelvesProps = {
  /** The loader's streamed answer (or an answer already at hand). */
  result: Promise<RecommendationResult> | RecommendationResult | null | undefined;
  /** Signal source prefix, usually the context ("product", "cart", "home"…). */
  source: string;
  /** Heading level of the shelf titles (default 2; the cards' names are one level below). */
  headingLevel?: 2 | 3;
  /** `sizes` of the card pictures. */
  sizes?: string;
  /** "page" (default): the kit's rail across the page · "column": a narrower column (cart, order) — four cards from 1024px. */
  layout?: ShelfLayout;
  /** Reserve the shelf's geometry while the answer streams in (default: nothing until it is here). */
  placeholder?: ShelfPlaceholderProps;
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

export function RecommendationShelves({ result, source, headingLevel, sizes, layout = "page", placeholder, className }: RecommendationShelvesProps) {
  const value = useArrived(result);
  const { retry, retrying } = useSafeRetry();
  if (!value) return result && placeholder ? <ShelfPlaceholder {...placeholder} headingLevel={headingLevel} layout={layout} className={className} /> : null;
  if (!value.ok) {
    return <ErrorState className={className} onRetry={retry} retrying={retrying} />;
  }
  // a shelf of fewer than three cards is not drawn (the kit's rule): with none left, no element at all — an empty box
  // would still take a gap in the host page's layout
  const shelves = drawableShelves(value.shelves);
  if (shelves.length === 0) return null;

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
      <ShelfStack shelves={shelves} headingLevel={headingLevel} sizes={sizes} layout={layout} />
    </div>
  );
}

/* ───────────────────────────── the pieces (the device hub's streamed setup shelf draws with them too) ───────────────────────────── */

/** Cards in a narrower column (cart, order): at most four whole cards from 1024 (the kit's rail is five from 1280). */
const COLUMN_RAIL = "2xl:grid-cols-4 2xl:[&>li:nth-child(5)]:hidden";
const COLUMN_SIZES = "(min-width: 1024px) 200px, (min-width: 768px) 30vw, 46vw";

/**
 * Arrived shelves: each one the kit's shelf, its cards inflating in (a Bubble per card; a group per shelf staggers
 * them 45 ms apart). Bubbles decide once, at mount: hydrated HTML is simply there, content that arrives later inflates.
 * The bubble is a grid cell around the card — a flex box would collapse the card's inline-size container to nothing.
 */
export function ShelfStack({ shelves, headingLevel = 2, sizes, layout = "page" }: { shelves: readonly Shelf<ProductCardData>[]; headingLevel?: 2 | 3; sizes?: string; layout?: ShelfLayout }) {
  const cardLevel = headingLevel === 3 ? 4 : 3;
  return (
    <>
      {shelves.map((shelf) => (
        <BubbleGroup key={shelf.key} stagger className="min-w-0">
          {layout === "column" ? (
            <ColumnShelf shelf={shelf} headingLevel={headingLevel} sizes={sizes ?? COLUMN_SIZES} cardLevel={cardLevel} />
          ) : (
            <ShelfRail
              shelf={shelf}
              headingLevel={headingLevel}
              renderItem={(card, index) => (
                <Bubble index={index} className="grid h-full">
                  <ProductCard card={card} slot={shelf.key} sizes={sizes} headingLevel={cardLevel} />
                </Bubble>
              )}
            />
          )}
        </BubbleGroup>
      ))}
    </>
  );
}

/** The kit's shelf (SectionHead + Rail) with at most four cards across from 1024 — for a column narrower than the page. */
function ColumnShelf({ shelf, headingLevel, sizes, cardLevel }: { shelf: Shelf<ProductCardData>; headingLevel: 2 | 3; sizes: string; cardLevel: 3 | 4 }) {
  const id = useId();
  if (shelf.items.length < 3) return null;
  return (
    <section aria-labelledby={id} className="min-w-0" data-shelf={shelf.key}>
      <SectionHead id={id} title={shelf.title} reason={shelf.reason} headingLevel={headingLevel} />
      <Rail aria-labelledby={id} railClassName={COLUMN_RAIL}>
        {shelf.items.map((card, index) => (
          <Bubble key={card.id} index={index} className="grid h-full">
            <ProductCard card={card} slot={shelf.key} sizes={sizes} headingLevel={cardLevel} />
          </Bubble>
        ))}
      </Rail>
    </section>
  );
}

/**
 * A shelf that is on its way: its head, then the rail's exact geometry with empty wells (the kit's
 * ProductCardPlaceholder — the well colour, the reserved lines; no grey skeleton). Inert: nothing in it can be focused.
 */
export function ShelfPlaceholder({ title, reason, loading, headingLevel = 2, layout = "page", className }: ShelfPlaceholderProps & { headingLevel?: 2 | 3; layout?: ShelfLayout; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} aria-busy="true" className={cx("min-w-0", className)}>
      <SectionHead id={id} title={title} reason={reason ?? undefined} headingLevel={headingLevel} />
      {loading ? <VisuallyHidden role="status">{loading}</VisuallyHidden> : null}
      <div aria-hidden="true" inert>
        <Rail railClassName={layout === "column" ? COLUMN_RAIL : undefined}>
          {Array.from({ length: 5 }, (_, index) => (
            <ProductCardPlaceholder key={index} className="h-full" />
          ))}
        </Rail>
      </div>
    </section>
  );
}
