-- TamTam Games — product full-text search (FTS5).
--
-- Hand-written; used through app/server/db/search.server.ts (normalizeSearchText, searchIndexStatements,
-- searchProductIds). One row per product and locale; the text columns hold NORMALIZED text.
--
-- Tokenizer: trigram — matches any substring of 3+ characters in any script, which suits Arabic and
-- Kurdish (attached articles and prefixes) and tolerates partial words. Verified on the SQLite build
-- that runs D1 locally (workerd). If a target database ever reports "no such tokenizer: trigram",
-- replace the tokenize line with
--     tokenize = "unicode61 remove_diacritics 2"
-- and switch ftsMatchQuery() in app/server/db/search.server.ts to prefix queries ("term"*).
--
-- This table is derived data and can be rebuilt from products at any time. `wrangler d1 export`
-- cannot export virtual tables: drop search_index before an export and re-run this file after.
CREATE VIRTUAL TABLE `search_index` USING fts5(
	product_id UNINDEXED,
	locale UNINDEXED,
	name,
	keywords,
	body,
	tokenize = 'trigram'
);
