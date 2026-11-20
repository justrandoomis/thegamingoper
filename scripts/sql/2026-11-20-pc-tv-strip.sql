-- 2026-11-20 follow-up to 2026-11-20-pc-platform.sql: the Wi-Fi TV LED strip is a TV item, not PC gear.
-- Back to no platform (multi-platform), and the PC search words that file appended are taken off again.
-- Idempotent: a second run finds nothing to change.

UPDATE products
SET platform_id = NULL,
    search_keywords = json_object(
      'ar', trim(replace(COALESCE(json_extract(search_keywords, '$.ar'), ''), ' حاسوب كمبيوتر ويندوز بي سي', '')),
      'en', trim(replace(COALESCE(json_extract(search_keywords, '$.en'), ''), ' pc computer windows', '')),
      'ckb', trim(replace(COALESCE(json_extract(search_keywords, '$.ckb'), ''), ' کۆمپیوتەر ویندۆز پی سی', ''))),
    updated_at = unixepoch() * 1000
WHERE slug = 'twisted-minds-wifi-tv-led-strip'
  AND platform_id = (SELECT id FROM platforms WHERE slug = 'pc');

UPDATE search_index
SET keywords = trim(replace(replace(replace(COALESCE(keywords, ''),
      ' حاسوب كمبيوتر ويندوز بي سي pc computer windows', ''),
      ' کۆمپیوتەر ویندۆز پی سی pc computer windows', ''),
      ' pc computer windows', ''))
WHERE product_id = (SELECT id FROM products WHERE slug = 'twisted-minds-wifi-tv-led-strip')
  AND COALESCE(keywords, '') LIKE '%computer windows%';
