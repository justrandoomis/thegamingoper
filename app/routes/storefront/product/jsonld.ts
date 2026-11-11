/**
 * schema.org Product data for the product page (pure, client-safe), serialised for a
 * <script type="application/ld+json">. Honest by construction:
 *   · no aggregateRating unless real approved verified-purchase reviews exist (and then their true numbers);
 *   · no `offers` while the store is in demo mode — the prices and stock are placeholders, and a search engine must not
 *     show them as an offer;
 *   · availability only from the variant's stock state.
 * `<`, `>`, `&`, U+2028 and U+2029 are escaped, so text from the catalogue can never close the script element.
 */
import { localePath, type Locale } from "~/lib/locales";
import type { ProductDetail, ReviewSummary, VariantDetail } from "~/server/services/catalog/product-types";

const AVAILABILITY: Record<VariantDetail["stock"], string> = {
  in_stock: "https://schema.org/InStock",
  low_stock: "https://schema.org/LimitedAvailability",
  out_of_stock: "https://schema.org/OutOfStock",
  preorder: "https://schema.org/PreOrder",
};

export type ProductJsonLdInput = {
  product: Pick<ProductDetail, "name" | "slug" | "description" | "short" | "brand" | "categories">;
  variant: VariantDetail;
  reviews: ReviewSummary;
  /** Absolute origin ("https://tamtamgames.com"). */
  origin: string;
  locale: Locale;
  /** Absolute or site-relative picture URL (the share image). */
  image: string | null;
  storeMode: "demo" | "live";
};

export function productJsonLd({ product, variant, reviews, origin, locale, image, storeMode }: ProductJsonLdInput): Record<string, unknown> {
  const url = new URL(localePath(`/p/${product.slug}`, locale), origin).href;
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    url,
    sku: variant.sku,
  };
  const description = product.description ?? product.short;
  if (description) data.description = description;
  if (image) data.image = [new URL(image, origin).href];
  if (product.brand) data.brand = { "@type": "Brand", name: product.brand };
  if (variant.modelNumber) data.mpn = variant.modelNumber;
  const category = product.categories.at(-1)?.name;
  if (category) data.category = category;
  if (reviews.count > 0 && reviews.average !== null) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: reviews.average,
      reviewCount: reviews.count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  if (storeMode === "live") {
    data.offers = {
      "@type": "Offer",
      url,
      priceCurrency: "IQD",
      price: variant.priceIqd,
      availability: AVAILABILITY[variant.stock],
    };
  }
  return data;
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** JSON that is safe inside <script type="application/ld+json">. */
export function jsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\u2029");
}
