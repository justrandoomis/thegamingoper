/**
 * INTEGRATION SLOT — recommendation shelves on the cart (context "cart") and on the order page ("post_purchase").
 *
 * The devices area owns `getRecommendations(db, { locale, context, cartVariantIds, consent, … }, limit)` →
 * `Shelf<ProductCardData>[]` (CONTRACTS §3: hard compatibility filter, stock-aware, an honest `reason`). It may not
 * exist yet, so this area does not import it: the integration pass loads the shelves in the page's loader and renders
 * them here with `<ShelfRail shelf={…} />` from ~/ui/ShelfRail (an empty shelf renders nothing — never placeholder
 * products). Until then the slot renders nothing at all.
 */
export type RecommendationsSlotProps = {
  context: "cart" | "post_purchase";
  /** Variants in the cart or the order — what the shelves complete. */
  variantIds: readonly string[];
};

export function RecommendationsSlot(_props: RecommendationsSlotProps) {
  return null;
}
