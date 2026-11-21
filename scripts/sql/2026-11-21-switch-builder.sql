-- 2026-11-21 — the Switch bundle builder's memory sizes: SanDisk Extreme microSDXC 64GB, 128GB, 512GB and 1TB.
--
-- The builder (/build/switch, docs/switch-builder.md §5) plans with memory cards of 64GB, 128GB, 256GB, 512GB and 1TB.
-- catalog/products/sandisk-extreme-microsd.json now lists those sizes of the card (model numbers and UPCs from
-- SanDisk's own US product page, retrieved 2026-11-21); production holds only its 256GB variant (owner's sheet row
-- 173, an unpriced draft). This file adds the four other sizes exactly as the owner-sheet import writes a variant that
-- is not on the owner's sheet: SWITCHED OFF (is_active = 0), PRICE 0, NO STOCK (no stock_levels row, no movement), not
-- the default, after the 256GB in the catalogue's order (sort 1–4). Nothing else changes: not the product (its text,
-- status, pictures, search words), not the 256GB variant, no cost, no price change, no stock.
--
-- The owner makes a size buyable in the admin — its cost, then its price (/admin/pricing/skus/:variantId), the
-- product's warranty_months (storage completeness), switch the variant on, receive stock, publish — and only then
-- does the builder offer it (an inactive or unpriced variant is never offered, never shown with a price).
--
-- Guarded and idempotent: a size is added only while the product exists and has no variant with that SKU or id, nor
-- any variant of that storage size (a size staff added by hand is left alone). The admin's storage option is free
-- text, so the size is compared the way the builder reads it (builder.server.ts cardSizeOf): case and spaces do not
-- count ("64 gb" is 64GB) and 1TB is also "1000GB". A second run changes nothing. No
-- BEGIN/COMMIT (D1 runs a file as one unit and rejects explicit transactions). Run:
--   npx wrangler d1 execute DB --remote --file scripts/sql/2026-11-21-switch-builder.sql
-- Check (expect the 256GB as it was, then 64GB, 128GB, 512GB and 1TB with price_iqd 0, is_active 0, is_default 0):
--   npx wrangler d1 execute DB --remote --command "SELECT sku, json_extract(options, '$.storage') AS size, price_iqd, is_active, is_default, sort FROM variants WHERE product_id = (SELECT id FROM products WHERE slug = 'sandisk-extreme-microsd') ORDER BY sort"

-- 64GB · SDSQXAH-064G-GN6MA · UPC 619659193409
INSERT INTO variants (id, product_id, sku, barcode, title, options, price_iqd, compare_at_iqd, is_default, is_active, track_serials, sort, weight_grams, created_at, updated_at)
SELECT 'var_sandisk-extreme-64', p.id, 'SANDISK-EXTREME-64', '619659193409', '{"ar":"64GB","en":"64GB","ckb":"64GB"}', '{"storage":"64GB","model":"SDSQXAH-064G-GN6MA"}',
       0, NULL, 0, 0, 0, 1, NULL, unixepoch() * 1000, unixepoch() * 1000
FROM products AS p
WHERE p.slug = 'sandisk-extreme-microsd'
  AND NOT EXISTS (SELECT 1 FROM variants AS v WHERE v.sku = 'SANDISK-EXTREME-64' OR v.id = 'var_sandisk-extreme-64')
  AND NOT EXISTS (SELECT 1 FROM variants AS v WHERE v.product_id = p.id AND replace(upper(CASE WHEN json_valid(v.options) THEN json_extract(v.options, '$.storage') END), ' ', '') = '64GB');

-- 128GB · SDSQXAA-128G-GN6MA · UPC 619659188450
INSERT INTO variants (id, product_id, sku, barcode, title, options, price_iqd, compare_at_iqd, is_default, is_active, track_serials, sort, weight_grams, created_at, updated_at)
SELECT 'var_sandisk-extreme-128', p.id, 'SANDISK-EXTREME-128', '619659188450', '{"ar":"128GB","en":"128GB","ckb":"128GB"}', '{"storage":"128GB","model":"SDSQXAA-128G-GN6MA"}',
       0, NULL, 0, 0, 0, 2, NULL, unixepoch() * 1000, unixepoch() * 1000
FROM products AS p
WHERE p.slug = 'sandisk-extreme-microsd'
  AND NOT EXISTS (SELECT 1 FROM variants AS v WHERE v.sku = 'SANDISK-EXTREME-128' OR v.id = 'var_sandisk-extreme-128')
  AND NOT EXISTS (SELECT 1 FROM variants AS v WHERE v.product_id = p.id AND replace(upper(CASE WHEN json_valid(v.options) THEN json_extract(v.options, '$.storage') END), ' ', '') = '128GB');

-- 512GB · SDSQXAV-512G-GN6MA · UPC 619659189648
INSERT INTO variants (id, product_id, sku, barcode, title, options, price_iqd, compare_at_iqd, is_default, is_active, track_serials, sort, weight_grams, created_at, updated_at)
SELECT 'var_sandisk-extreme-512', p.id, 'SANDISK-EXTREME-512', '619659189648', '{"ar":"512GB","en":"512GB","ckb":"512GB"}', '{"storage":"512GB","model":"SDSQXAV-512G-GN6MA"}',
       0, NULL, 0, 0, 0, 3, NULL, unixepoch() * 1000, unixepoch() * 1000
FROM products AS p
WHERE p.slug = 'sandisk-extreme-microsd'
  AND NOT EXISTS (SELECT 1 FROM variants AS v WHERE v.sku = 'SANDISK-EXTREME-512' OR v.id = 'var_sandisk-extreme-512')
  AND NOT EXISTS (SELECT 1 FROM variants AS v WHERE v.product_id = p.id AND replace(upper(CASE WHEN json_valid(v.options) THEN json_extract(v.options, '$.storage') END), ' ', '') = '512GB');

-- 1TB · SDSQXAV-1T00-GN6MA · UPC 619659188474
INSERT INTO variants (id, product_id, sku, barcode, title, options, price_iqd, compare_at_iqd, is_default, is_active, track_serials, sort, weight_grams, created_at, updated_at)
SELECT 'var_sandisk-extreme-1tb', p.id, 'SANDISK-EXTREME-1TB', '619659188474', '{"ar":"1TB","en":"1TB","ckb":"1TB"}', '{"storage":"1TB","model":"SDSQXAV-1T00-GN6MA"}',
       0, NULL, 0, 0, 0, 4, NULL, unixepoch() * 1000, unixepoch() * 1000
FROM products AS p
WHERE p.slug = 'sandisk-extreme-microsd'
  AND NOT EXISTS (SELECT 1 FROM variants AS v WHERE v.sku = 'SANDISK-EXTREME-1TB' OR v.id = 'var_sandisk-extreme-1tb')
  AND NOT EXISTS (SELECT 1 FROM variants AS v WHERE v.product_id = p.id AND replace(upper(CASE WHEN json_valid(v.options) THEN json_extract(v.options, '$.storage') END), ' ', '') IN ('1TB', '1000GB'));
