-- 2026-11-20 — the PC platform (storefront section «الكمبيوتر» / "PC" / «کۆمپیوتەر», /platform/pc).
--
-- Production D1 was filled by the owner-sheet SQL (commit fecb070) and is not re-seeded, so this file brings it to what
-- the seed now writes (app/server/db/seed/demo/devices.ts, catalog/products/*.json "platform": "pc"):
--   1. the "pc" platform: created when missing, else activated, with its names, the teal accent ("pc" — the
--      --gel-pc / --plat-pc tokens of this release) and the monitor photo for its tile;
--   2. the PC-only gear joins it (products.platform_id) — only products that have no platform today, so a platform
--      staff gave a product by hand is never overwritten;
--   3. those products' search words gain the PC keywords (products.search_keywords and their search_index rows), as
--      the seed writes them (search.ts PLATFORM_KEYWORDS.pc).
-- Multi-platform products whose researched compatibility names the Windows PC (headsets, the HyperX Alloy keyboard,
-- the QuadCast, the JYS USB hub …) need nothing here: the PC page lists them by that rule once the platform is active.
--
-- Idempotent: every statement is guarded, so a second run changes nothing. No BEGIN/COMMIT (D1 runs a file as one
-- unit and rejects explicit transactions). Run the code release that knows the "pc" accent FIRST, then:
--   npx wrangler d1 execute DB --remote --file scripts/sql/2026-11-20-pc-platform.sql

-- 1. the platform ──────────────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO platforms (id, slug, name, accent, sort, art_key, is_active)
SELECT 'plt_pc', 'pc', '{"ar":"الكمبيوتر","en":"PC","ckb":"کۆمپیوتەر"}', 'pc',
       (SELECT COALESCE(MAX(sort), 0) + 10 FROM platforms), 'asus-tuf-gaming-vg279qm5a--1', 1
WHERE NOT EXISTS (SELECT 1 FROM platforms WHERE slug = 'pc');

UPDATE platforms
SET name = '{"ar":"الكمبيوتر","en":"PC","ckb":"کۆمپیوتەر"}', accent = 'pc', art_key = 'asus-tuf-gaming-vg279qm5a--1', is_active = 1
WHERE slug = 'pc'
  AND (is_active IS NOT 1 OR accent IS NOT 'pc' OR art_key IS NOT 'asus-tuf-gaming-vg279qm5a--1'
       OR name IS NOT '{"ar":"الكمبيوتر","en":"PC","ckb":"کۆمپیوتەر"}');

-- 2. the PC gear ───────────────────────────────────────────────────────────────────────────────────────────────────
-- keyboards (6), mice (3), mouse pads (3), monitors (2), microphones (2), speakers (2), gaming chairs (5),
-- gaming glasses (1), lighting (2), the budget PC gamepad (1) — 27 products.

UPDATE products
SET platform_id = (SELECT id FROM platforms WHERE slug = 'pc'), updated_at = unixepoch() * 1000
WHERE platform_id IS NULL
  AND slug IN (
    'gameon-aerox-gomk60-rs', 'razer-blackwidow-v3-mini-hyperspeed', 'razer-pbt-keycap-upgrade-set',
    'redragon-eisa-k686-pro-se', 'redragon-fizz-k617-he', 'redragon-ucal-k673-pro',
    'hyperx-pulsefire-surge', 'redragon-k1ng-m724', 'redragon-storm-pro-m808-ks',
    '1esport-mouse-pad-90x40', 'redragon-p032-flick-xl', 'redragon-p041-xeon-xl',
    'asus-tuf-gaming-vg249qm1a', 'asus-tuf-gaming-vg279qm5a',
    'maono-dm30', 'redragon-gm306',
    'redragon-stentor-gs500', 'redragon-yorick-gs511',
    'dxracer-craft-starswar-edition', 'dxracer-drifting-series', 'dxracer-formula-series', 'dxracer-master-series', 'dxracer-prince-series',
    'gunnar-gaming-glasses',
    'twisted-minds-rgb-led-strip',
    'generic-pc-gamepad'
  );

-- 3. search words ──────────────────────────────────────────────────────────────────────────────────────────────────
-- Every product on the PC platform whose words do not have them yet ("computer windows" is the guard).

UPDATE products
SET search_keywords = json_object(
      'ar', trim(COALESCE(json_extract(search_keywords, '$.ar'), '') || ' حاسوب كمبيوتر ويندوز بي سي'),
      'en', trim(COALESCE(json_extract(search_keywords, '$.en'), '') || ' pc computer windows'),
      'ckb', trim(COALESCE(json_extract(search_keywords, '$.ckb'), '') || ' کۆمپیوتەر ویندۆز پی سی'))
WHERE platform_id = (SELECT id FROM platforms WHERE slug = 'pc')
  AND COALESCE(json_extract(search_keywords, '$.en'), '') NOT LIKE '%computer windows%';

-- the search documents: the Arabic and Kurdish ones carry the English words too (search-index.server.ts)
UPDATE search_index
SET keywords = trim(COALESCE(keywords, '') || ' حاسوب كمبيوتر ويندوز بي سي pc computer windows')
WHERE locale = 'ar'
  AND product_id IN (SELECT id FROM products WHERE platform_id = (SELECT id FROM platforms WHERE slug = 'pc'))
  AND COALESCE(keywords, '') NOT LIKE '%computer windows%';

UPDATE search_index
SET keywords = trim(COALESCE(keywords, '') || ' pc computer windows')
WHERE locale = 'en'
  AND product_id IN (SELECT id FROM products WHERE platform_id = (SELECT id FROM platforms WHERE slug = 'pc'))
  AND COALESCE(keywords, '') NOT LIKE '%computer windows%';

UPDATE search_index
SET keywords = trim(COALESCE(keywords, '') || ' کۆمپیوتەر ویندۆز پی سی pc computer windows')
WHERE locale = 'ckb'
  AND product_id IN (SELECT id FROM products WHERE platform_id = (SELECT id FROM platforms WHERE slug = 'pc'))
  AND COALESCE(keywords, '') NOT LIKE '%computer windows%';
