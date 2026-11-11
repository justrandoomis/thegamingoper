/**
 * The DEMO catalogue in display order (the first entries are the newest for "new arrivals").
 * 51 products: 11 consoles and handheld PCs, 6 controllers, 2 headsets, 4 storage items,
 * 6 accessories, 16 physical games, 3 wallet top-ups and 3 spare parts.
 */
import type { ProductKind } from "../../../schema";
import { CONSOLE_PRODUCTS } from "./consoles";
import { CONTROLLER_PRODUCTS, HEADSET_PRODUCTS } from "./controllers";
import { DIGITAL_PRODUCTS, PART_PRODUCTS } from "./digital";
import { GAME_PRODUCTS } from "./games";
import { ACCESSORY_PRODUCTS, STORAGE_PRODUCTS } from "./storage";
import type { ProductSeed, VariantSeed } from "./types";

export type { ProductSeed, VariantSeed } from "./types";

export const DEMO_PRODUCTS: readonly ProductSeed[] = [
  ...CONSOLE_PRODUCTS,
  ...CONTROLLER_PRODUCTS,
  ...HEADSET_PRODUCTS,
  ...STORAGE_PRODUCTS,
  ...ACCESSORY_PRODUCTS,
  ...GAME_PRODUCTS,
  ...DIGITAL_PRODUCTS,
  ...PART_PRODUCTS,
];

/**
 * Placeholder commercial defaults per product kind.
 *   reorderPoint      at or below this many units the item is "low on stock"
 *   minMarginBps      a price may not be published below this margin (admin 03.03)
 *   targetMarginBps   the margin the placeholder cost is derived from
 */
export const KIND_DEFAULTS: Record<ProductKind, { reorderPoint: number; minMarginBps: number; targetMarginBps: number }> = {
  console: { reorderPoint: 2, minMarginBps: 300, targetMarginBps: 800 },
  controller: { reorderPoint: 3, minMarginBps: 700, targetMarginBps: 1500 },
  headset: { reorderPoint: 2, minMarginBps: 800, targetMarginBps: 1700 },
  storage: { reorderPoint: 3, minMarginBps: 700, targetMarginBps: 1600 },
  accessory: { reorderPoint: 4, minMarginBps: 1200, targetMarginBps: 3000 },
  game: { reorderPoint: 3, minMarginBps: 800, targetMarginBps: 1700 },
  digital: { reorderPoint: 0, minMarginBps: 200, targetMarginBps: 500 },
  part: { reorderPoint: 3, minMarginBps: 1500, targetMarginBps: 4000 },
  bundle: { reorderPoint: 0, minMarginBps: 300, targetMarginBps: 800 },
};

export type VariantRef = { product: ProductSeed; variant: VariantSeed; index: number };

const variantIndex = new Map<string, VariantRef>();
const productIndex = new Map<string, ProductSeed>();
for (const product of DEMO_PRODUCTS) {
  if (productIndex.has(product.slug)) throw new Error(`Demo seed: duplicate product slug "${product.slug}"`);
  productIndex.set(product.slug, product);
  product.variants.forEach((variant, index) => {
    if (variantIndex.has(variant.sku)) throw new Error(`Demo seed: duplicate SKU "${variant.sku}"`);
    variantIndex.set(variant.sku, { product, variant, index });
  });
}

export function productBySlug(slug: string): ProductSeed {
  const product = productIndex.get(slug);
  if (!product) throw new Error(`Demo seed: unknown product "${slug}"`);
  return product;
}

export function variantBySku(sku: string): VariantRef {
  const ref = variantIndex.get(sku);
  if (!ref) throw new Error(`Demo seed: unknown SKU "${sku}"`);
  return ref;
}

/** Every variant of the catalogue, with its product. */
export const DEMO_VARIANTS: readonly VariantRef[] = [...variantIndex.values()];
