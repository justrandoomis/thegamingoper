/**
 * Product full-text search on the FTS5 table `search_index` (drizzle/0002_search.sql):
 *
 *   search_index(product_id UNINDEXED, locale UNINDEXED, name, keywords, body)   tokenize = 'trigram'
 *
 * One row per product and locale. The trigram tokenizer matches any substring of three or more
 * characters in any script, which suits Arabic and Kurdish (prefixes, attached articles) and gives
 * some typo tolerance without stemming. Terms shorter than three characters ("PS", "يد") cannot use
 * the index and are matched with LIKE instead (a scan — fine for a catalogue of this size).
 *
 * Both the indexed text and the query go through normalizeSearchText(), which is what makes
 * "بلايستيشن", "بلايستيشِن", "PlayStation" and "playstation" meet. Always write the index with
 * searchIndexStatements() so the two sides stay in step.
 *
 * The table is derived data: it can be rebuilt from products at any time. (`wrangler d1 export`
 * cannot export virtual tables — drop `search_index` before an export and re-run 0002 after.)
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { BatchStatement, Db } from "./drizzle.server";

/**
 * Column view of the FTS5 table for typed INSERT / DELETE. Declared here, outside the schema
 * folder, so drizzle-kit never tries to create or alter the virtual table.
 */
const searchIndex = sqliteTable("search_index", {
  productId: text("product_id").notNull(),
  locale: text("locale").notNull(),
  name: text("name").notNull(),
  keywords: text("keywords").notNull(),
  body: text("body").notNull(),
});

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Letter variants that people type interchangeably, folded to one form. */
const FOLD: Record<string, string> = {
  "ى": "ي", // alef maqsura
  "ی": "ي", // Farsi / Kurdish yeh
  "ئ": "ي",
  "ک": "ك", // Kurdish / Persian kaf
  "ة": "ه", // teh marbuta
  "ە": "ه", // Kurdish ae
  "ؤ": "و",
  "ٱ": "ا",
  "ـ": "", // tatweel
};

/**
 * Canonical form for indexing and querying: lower-case, Latin digits, no diacritics or tashkeel,
 * unified Arabic/Kurdish letter variants, punctuation turned into single spaces.
 */
export function normalizeSearchText(input: string | null | undefined): string {
  if (!input) return "";
  let out = "";
  // Trademark signs would otherwise glue "tm" / "r" onto the word before them.
  const text = input.replace(/[™®©℠]/g, " ");
  // NFKD splits letters from their marks (é → e + ´, أ → ا + hamza); the marks are dropped below.
  for (const ch of text.normalize("NFKD")) {
    if (/\p{M}/u.test(ch)) continue;
    const folded = FOLD[ch];
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    const arabicDigit = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (arabicDigit !== -1) {
      out += String(arabicDigit);
      continue;
    }
    const persianDigit = PERSIAN_DIGITS.indexOf(ch);
    if (persianDigit !== -1) {
      out += String(persianDigit);
      continue;
    }
    // Zero-width joiners / non-joiners and directional marks disappear; other non-alphanumerics become spaces.
    if (/[​-‏‪-‮⁦-⁩﻿]/u.test(ch)) continue;
    out += /[\p{L}\p{N}]/u.test(ch) ? ch.toLowerCase() : " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Characters (code points) in a term. */
const length = (term: string) => [...term].length;

export type SearchTerms = {
  /** Terms of 3+ characters, usable with FTS5 MATCH. */
  indexed: string[];
  /** Shorter terms, matched with LIKE. */
  short: string[];
};

/** Splits what a shopper typed into normalized terms. At most 8 terms are kept. */
export function searchTerms(input: string): SearchTerms {
  const terms = [...new Set(normalizeSearchText(input).split(" ").filter(Boolean))].slice(0, 8);
  return { indexed: terms.filter((term) => length(term) >= 3), short: terms.filter((term) => length(term) < 3) };
}

/**
 * An FTS5 MATCH expression that requires every 3+ character term (each quoted, so user input can
 * never be read as FTS syntax). Null when no term is long enough for the trigram index.
 */
export function ftsMatchQuery(input: string): string | null {
  const { indexed } = searchTerms(input);
  if (indexed.length === 0) return null;
  return indexed.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
}

export type SearchDoc = {
  locale: string;
  /** Product name in that locale. */
  name: string;
  /** Brand, platform, SKU, synonyms, transliterations… */
  keywords?: string | null;
  /** Short description and other descriptive text. */
  body?: string | null;
};

/**
 * Statements that replace a product's rows in the search index (pass `[]` to remove it, e.g. when
 * the product is unpublished). Put them in the same batch as the product write.
 */
export function searchIndexStatements(db: Db, productId: string, docs: readonly SearchDoc[]): BatchStatement[] {
  const statements: BatchStatement[] = [db.delete(searchIndex).where(eq(searchIndex.productId, productId))];
  for (const doc of docs) {
    const name = normalizeSearchText(doc.name);
    if (!name) continue;
    statements.push(db.insert(searchIndex).values({ productId, locale: doc.locale, name, keywords: normalizeSearchText(doc.keywords), body: normalizeSearchText(doc.body) }));
  }
  return statements;
}

export type SearchHit = {
  productId: string;
  /** Locale of the best-matching row. */
  locale: string;
  /** Lower is better (bm25, name weighted over keywords over body). 0 for LIKE-only matches. */
  rank: number;
};

export type SearchOptions = {
  /** Restrict to one locale's rows. Default: search every locale (shoppers mix languages). */
  locale?: string;
  /** Maximum number of products returned (default 24, capped at 100). */
  limit?: number;
};

/**
 * Product ids matching a free-text query, best first, one hit per product.
 * Callers still apply their own filters (published, in stock, compatibility) on the result.
 */
export async function searchProductIds(db: Db, input: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const { indexed, short } = searchTerms(input);
  if (indexed.length === 0 && short.length === 0) return [];
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 24)), 100);

  const conditions: SQL[] = [];
  const match = ftsMatchQuery(input);
  if (match) conditions.push(sql`search_index MATCH ${match}`);
  for (const term of short) {
    const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conditions.push(sql`(name LIKE ${pattern} ESCAPE '\\' OR keywords LIKE ${pattern} ESCAPE '\\')`);
  }
  if (options.locale) conditions.push(sql`locale = ${options.locale}`);

  // bm25() is only available in a full-text query; LIKE-only searches get rank 0 and keep table order.
  const rank = match ? sql`bm25(search_index, 0.0, 0.0, 10.0, 4.0, 1.0)` : sql`0`;
  // A product has one row per locale: over-fetch, then keep the best row per product.
  const rows = await db.all<{ product_id: string; locale: string; score: number }>(
    sql`SELECT product_id, locale, ${rank} AS score FROM search_index WHERE ${sql.join(conditions, sql` AND `)} ORDER BY score LIMIT ${limit * 3}`,
  );

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.product_id)) continue;
    seen.add(row.product_id);
    hits.push({ productId: row.product_id, locale: row.locale, rank: row.score });
    if (hits.length === limit) break;
  }
  return hits;
}
