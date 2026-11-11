/**
 * Recommendation shelves on the cart (context "cart") and on the order page ("post_purchase") — wired by the
 * integration pass. The page's loader streams them (not awaited — the cart never waits for its suggestions):
 *
 *   cart    recommendationsFor(db, who, { locale, context: "cart", cartVariantIds }, 8)
 *   order   recommendationsFor(db, who, { locale, context: "post_purchase", cartVariantIds: orderItemsOf(…).variantIds }, 8)
 *
 * The devices area's engine applies the hard compatibility filter (an accessory or game appears only when VERIFIED on
 * a device in the cart or the order), drops what is out of stock and what is already in the cart, and writes each
 * shelf's honest reason line ("يكمّل PS5 الذي في سلتك"); nothing is invented here. Drawn by the shared
 * <RecommendationShelves> (devices area): nothing until the answer is here, the cards inflate in, a failure is a
 * retry panel in the same place. Funnel rule (DESIGN.md §8): the cart and the order stay paper — the shelves sit
 * under the lines, never between the shopper and the commit key.
 */
import { RecommendationShelves, type RecommendationResult } from "~/routes/storefront/devices/components/RecommendationShelves";

export type RecommendationsSlotProps = {
  context: "cart" | "post_purchase";
  /** The loader's streamed answer. */
  result: Promise<RecommendationResult> | RecommendationResult | null;
  className?: string;
};

export function RecommendationsSlot({ context, result, className }: RecommendationsSlotProps) {
  // the cart's and the order's main column is narrower than the page from 1024px: column-sized cards
  return <RecommendationShelves result={result} source={context} layout="column" className={className} />;
}
