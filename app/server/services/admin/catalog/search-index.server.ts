/**
 * The search_index rows of one product, built from what the database holds — the same three documents the demo seed
 * writes (app/server/db/seed/demo/search.ts `productSearchDocs`), so a product edited in the admin is indexed exactly
 * like a seeded one:
 *
 *   name       the product name in that language (Arabic when the language has none)
 *   keywords   brand, every SKU, model number and barcode, the product's search keywords in that language — and, in
 *              the Arabic and Kurdish documents, the English keywords too (shoppers mix scripts: "ps5 يد")
 *   body       short line, description and every variant title in that language
 *
 *   const statements = [...productWrites, ...productSearchStatements(db, productId, source)];   // search rows LAST
 *
 * Only products the storefront can find are indexed (published or scheduled — rules.ts `isSearchListed`); for a
 * draft, hidden or archived product the statements REMOVE its rows (searchIndexStatements with no documents).
 * The storefront search filters by status again when it reads, so the index never decides what is for sale.
 *
 * Batch rule (drizzle/README.md): FTS5 writes distort change counts, so these statements go at the very end of a
 * batch and nothing after them is guarded with expectChanged().
 */
import { asc, eq } from "drizzle-orm";
import type { L10n } from "~/lib/locales";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { products, variants } from "~/server/db/schema";
import { searchIndexStatements, type SearchDoc } from "~/server/db/search.server";
import { runBatch } from "~/server/db/tx.server";
import { isSearchListed } from "./rules";

const LOCALES = ["ar", "en", "ckb"] as const;
type IndexLocale = (typeof LOCALES)[number];

/** What one product's documents are built from. */
export type CatalogSearchSource = {
  status: string;
  name: L10n;
  short: L10n | null;
  description: L10n | null;
  brand: string | null;
  searchKeywords: L10n | null;
  attributes: Record<string, unknown> | null;
  /** Variants in display order (sort, then id). */
  variants: ReadonlyArray<{ sku: string; barcode: string | null; options: Record<string, string> | null; title: L10n | null }>;
};

const text = (value: L10n | null | undefined, locale: IndexLocale): string => (value ? (value[locale] ?? "") : "");
const words = (...parts: Array<string | null | undefined>) => parts.filter((part) => typeof part === "string" && part.trim() !== "").join(" ");

/** Every barcode the research recorded for a SKU (attributes.variantBarcodes), else the variant's own. */
function barcodesOf(attributes: Record<string, unknown> | null, sku: string, barcode: string | null): string[] {
  const all = attributes && typeof attributes.variantBarcodes === "object" && attributes.variantBarcodes !== null ? (attributes.variantBarcodes as Record<string, unknown>)[sku] : undefined;
  if (Array.isArray(all) && all.every((code) => typeof code === "string") && all.length > 0) return all as string[];
  return barcode ? [barcode] : [];
}

/** SKUs, model numbers and barcodes of a product, each once, in variant order — staff search by them. */
export function productCodes(source: Pick<CatalogSearchSource, "attributes" | "variants">): string[] {
  const codes = source.variants.flatMap((variant) => [variant.sku, variant.options?.model ?? null, ...barcodesOf(source.attributes, variant.sku, variant.barcode)]);
  return [...new Set(codes.filter((code): code is string => typeof code === "string" && code.trim() !== ""))];
}

/** The three documents (ar, en, ckb) of a product. */
export function catalogSearchDocs(source: CatalogSearchSource): SearchDoc[] {
  const codes = productCodes(source).join(" ");
  return LOCALES.map((locale) => ({
    locale,
    name: text(source.name, locale) || source.name.ar,
    keywords: words(source.brand, codes, text(source.searchKeywords, locale), locale === "en" ? null : text(source.searchKeywords, "en")),
    body: words(text(source.short, locale), text(source.description, locale), ...source.variants.map((variant) => text(variant.title, locale))),
  }));
}

/** Statements that make the index match the product: its rows when it is listed, none otherwise. Put them LAST in the batch. */
export function productSearchStatements(db: Db, productId: string, source: CatalogSearchSource): BatchStatement[] {
  return searchIndexStatements(db, productId, isSearchListed(source.status) ? catalogSearchDocs(source) : []);
}

/** Reads what the documents need for one product (null when it does not exist). */
export async function loadSearchSource(db: Db, productId: string): Promise<CatalogSearchSource | null> {
  const [rows, variantRows] = await db.batch([
    db
      .select({ status: products.status, name: products.name, short: products.short, description: products.description, brand: products.brand, searchKeywords: products.searchKeywords, attributes: products.attributes })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1),
    db
      .select({ sku: variants.sku, barcode: variants.barcode, options: variants.options, title: variants.title })
      .from(variants)
      .where(eq(variants.productId, productId))
      .orderBy(asc(variants.sort), asc(variants.id)),
  ]);
  const row = rows[0];
  if (!row) return null;
  return { ...row, variants: variantRows };
}

/** Rewrites one product's rows from the database as it is now (for repairs and for changes made elsewhere). */
export async function reindexProduct(db: Db, productId: string): Promise<{ indexed: boolean }> {
  const source = await loadSearchSource(db, productId);
  if (!source) {
    await runBatch(db, searchIndexStatements(db, productId, []));
    return { indexed: false };
  }
  await runBatch(db, productSearchStatements(db, productId, source));
  return { indexed: isSearchListed(source.status) };
}
