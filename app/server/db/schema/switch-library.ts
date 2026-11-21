/**
 * switch-library — TamTam's own data for the Switch bundle builder's game library (docs/switch-builder.md §4).
 *
 * The library's game LIST is open data shipped as static files (public/library/switch/, from Wikidata CC0); this table
 * holds only what TamTam staff add per game in /admin/catalog/switch-library: the measured sizes, the eShop price they
 * checked, an official YouTube trailer id, an uploaded picture, a short description, and a Metacritic score ONLY when
 * TamTam holds the Metacritic licence. One row per library game; a game without a row simply has none of these yet.
 *
 * Sizes are BYTES (the admin types "16.5" GB as the console shows it; 1 GB = 1024³ bytes). Dates are ISO strings
 * (YYYY-MM-DD) because they describe when a figure was checked, not an event time.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { at, flag, json } from "../columns";
import { files } from "./core";

export type SwitchLibraryDescription = Partial<Record<"ar" | "en" | "ckb", string>>;

export const switchLibraryEntries = sqliteTable(
  "switch_library_entries",
  {
    /** Library game id = Nintendo US store slug from Wikidata P8084, e.g. "hades-switch". */
    gameId: text("game_id").primaryKey(),
    /** Full installed size of the digital game (base + latest update, no DLC), bytes. */
    sizeBytes: integer("size_bytes"),
    /** Space a cartridge copy needs on the console (updates + DLC data), bytes. */
    cartridgeBytes: integer("cartridge_bytes"),
    sizeAsOf: text("size_as_of"),
    /** Nintendo eShop (US) price checked by staff, US cents. */
    priceUsdCents: integer("price_usd_cents"),
    priceAsOf: text("price_as_of"),
    /** 11-character YouTube video id of an official trailer. */
    trailerYoutubeId: text("trailer_youtube_id"),
    /** An uploaded public picture (files.visibility = 'public'), served at /media/<storage key>. */
    imageFileId: text("image_file_id").references(() => files.id),
    description: json<SwitchLibraryDescription>("description"),
    /** Licensed Metacritic figures — only when TamTam holds the Metacritic licence. */
    metacriticScore: integer("metacritic_score"),
    metacriticReviews: integer("metacritic_reviews"),
    metacriticAsOf: text("metacritic_as_of"),
    isHidden: flag("is_hidden").notNull().default(false),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
    /** Employee id of the last change. */
    updatedBy: text("updated_by"),
  },
  (t) => [
    index("switch_library_entries_updated_idx").on(t.updatedAt),
    // every foreign key column leads an index (tests/db-invariants.test.ts): a picture's deletion checks this table
    index("switch_library_entries_image_idx").on(t.imageFileId),
    check("switch_library_entries_size_ck", sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} > 0`),
    check("switch_library_entries_cartridge_ck", sql`${t.cartridgeBytes} IS NULL OR ${t.cartridgeBytes} >= 0`),
    check("switch_library_entries_price_ck", sql`${t.priceUsdCents} IS NULL OR ${t.priceUsdCents} >= 0`),
    check("switch_library_entries_score_ck", sql`${t.metacriticScore} IS NULL OR (${t.metacriticScore} BETWEEN 0 AND 100)`),
    check("switch_library_entries_reviews_ck", sql`${t.metacriticReviews} IS NULL OR ${t.metacriticReviews} >= 0`),
  ],
);
export type SwitchLibraryEntry = typeof switchLibraryEntries.$inferSelect;
export type NewSwitchLibraryEntry = typeof switchLibraryEntries.$inferInsert;
