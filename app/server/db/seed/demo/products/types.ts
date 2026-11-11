/**
 * Shape of a DEMO catalogue entry. `seedDemo` turns each one into its `products`, `variants`,
 * `variant_costs`, `media`, `stock_levels` (+ opening movement, cost layer, serials), `bundle_items`
 * and `search_index` rows.
 *
 * Prices are placeholders in whole IQD, multiples of 250. `compareAtIqd` is set only where a
 * reduced-price demo is useful. Barcodes are left out: we do not know the real ones.
 */
import type { LicenseType, MediaFormat, ProductKind, Specs } from "../../../schema";
import type { PlatformSlug } from "../devices";
import type { T3 } from "../text";

export type VariantSeed = {
  sku: string;
  /** Shown next to the product name ("نسخة الأقراص · 1TB"). Omitted when there is one variant and nothing to add. */
  title?: T3;
  /** Machine values of the options that tell variants apart: `{ color: "white", storage: "1TB" }`. */
  options?: Record<string, string>;
  priceIqd: number;
  compareAtIqd?: number;
  /** Units on hand at the main location. 0 = shown as out of stock. */
  stock: number;
  /** At or below this, the item counts as low on stock. Defaults per product kind. */
  reorderPoint?: number;
  /** `false` = no cost row, so the "cost not entered" state can be seen in the admin. */
  cost?: false;
  /** Pictures of this variant only (colour variants). */
  art?: string[];
  /** A bundle: selling it moves stock of these component SKUs. It has no stock or cost of its own. */
  bundle?: Array<{ sku: string; qty: number }>;
};

export type ProductSeed = {
  slug: string;
  kind: ProductKind;
  name: T3;
  /** One line under the name. */
  short: T3;
  description: T3;
  brand?: string;
  platform?: PlatformSlug;
  /** The device model a console IS, or the single model a part or accessory is made for. */
  deviceModel?: string;
  /** Slug of the deepest fitting category. */
  category: string;
  /** Merged over the device model's spec sheet for consoles. */
  specs?: Specs;
  /** Placeholder store warranty for new items. */
  warrantyMonths?: number;
  ageRating?: string;
  region?: string;
  licenseType?: LicenseType;
  mediaFormat?: MediaFormat;
  /** Gallery, main picture first. Art names from scripts/art/catalog.json ("switch-2", "switch-2@front"). */
  art: string[];
  /** Nicknames and transliterations shoppers type, per language. */
  keywords?: Partial<T3>;
  /** Every unit is tracked by serial number (consoles and handheld PCs). */
  trackSerials?: boolean;
  variants: VariantSeed[];
};
