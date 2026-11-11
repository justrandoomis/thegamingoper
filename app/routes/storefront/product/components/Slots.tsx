/**
 * Integration slots — places on the product page that other areas fill once they land (docs/CONTRACTS.md §3, "cross-
 * area UI is wired by the integration pass"). Each renders NOTHING today, on purpose: this area does not import
 * modules that may not exist yet, and it does not fake their content.
 *
 *   <CompatibilitySlot productId />       devices area: getCompatibilityForProduct(db, locale, productId)
 *                                         → { deviceSlug, deviceName, status, note }[] — render with ~/ui/CompatBadge
 *                                         ("يعمل مع"; "unverified" is a real answer). Loader: add the call next to
 *                                         getProductDetail and pass the rows in.
 *   <RecommendationsSlot productId />     devices area: getRecommendations(db, { locale, context: "product", productId,
 *                                         consent, … }, limit) → Shelf<ProductCardData>[] — render each with
 *                                         ~/ui/ShelfRail (its `reason` is already honest).
 *   <DeviceHubSlot deviceModel />         devices area: the "everything about this device" link (/device/<slug>) as a
 *                                         row link with the device's picture (DESIGN.md §8.2).
 *   wished                                account area: getWishlistIds(db, { customerId, cartToken }) in the loader →
 *                                         <WishlistKey initial={wished.has(product.id)} /> (today: false).
 *
 * The props are the data each slot will need, so wiring is a change in this file and the loader only.
 */
import type { ReactNode } from "react";

export type CompatibilitySlotProps = {
  productId: string;
  children?: ReactNode;
};
export type RecommendationsSlotProps = {
  productId: string;
  children?: ReactNode;
};
export type DeviceHubSlotProps = {
  deviceModel: { slug: string; name: string } | null;
  children?: ReactNode;
};

/** "يعمل مع" — compatibility statuses of this product (devices area). Renders its children when the pass provides them. */
export function CompatibilitySlot({ children }: CompatibilitySlotProps) {
  return children ? <>{children}</> : null;
}

/** "يكمّل جهازك" — compatibility-checked, stock-aware recommendation shelves (devices area). */
export function RecommendationsSlot({ children }: RecommendationsSlotProps) {
  return children ? <>{children}</> : null;
}

/** The device hub link for products that ARE a device (devices area owns /device/:model). */
export function DeviceHubSlot({ children }: DeviceHubSlotProps) {
  return children ? <>{children}</> : null;
}
