# Product catalogue research

One JSON file per product in `catalog/products/<slug>.json`, researched from official manufacturer and publisher pages (checked against a second source), as of the `retrieved` date in each source entry. This folder is the single source of truth for the demo catalogue: `npm run catalog:import` turns it into database seed data, and `npm run catalog:images` turns the downloaded images into the responsive files the storefront serves.

**Prices are not researched.** Shop prices come later from the owner's price file; until then the importer assigns random placeholder prices flagged `is_demo`.

## Rules

- **Facts only, with sources.** Every spec, date, edition, box content and compatibility claim must be supported by an entry in `sources`. Prefer the manufacturer or publisher page; use a second reputable source (another official regional page, Wikipedia, major press) to confirm. Leave a field out rather than guess, and list anything you could not confirm in `verification.unverified`.
- **Status is as of the retrieval date** (2026-11-11 for the first pass): `available`, `preorder` (date announced, orders open), `upcoming` (announced, no orders), `discontinued` (no longer manufactured but still sold), `limited` (limited or store-exclusive edition).
- **Our own words.** `description` and `highlights` are written by us, plainly, from the facts — never copied marketing copy. Specs are facts and may be stated as published.
- **Names.** Official product names stay in their official Latin form in every locale (`Nintendo Switch 2`, `DualSense`, `Grand Theft Auto VI`). Translate only the descriptive words around them (colour, edition, bundle, controller, "Digital Edition" may stay Latin if that is how it is sold).
- **Three languages.** Every `L10n` object has `ar`, `en` and `ckb` (Kurdish Sorani, Arabic script). Natural, plain shop language — no machine-literal phrasing.
- **What customers in Iraq need to know** goes into `highlights`/`specs`/`notes`: storage and what it holds, what is in the box, which devices it works with, online requirements (Nintendo Switch Online, PlayStation Plus, Game Pass), region or account restrictions (gift cards, digital codes), Arabic language support in games (interface / subtitles / voice — say "unknown" if the official page does not state it), whether a Switch 2 physical game is a full cartridge or a **Game-Key Card** (download required), storage size of a game, age rating (PEGI where available, else ESRB), players / co-op.
- **Images.** 2–6 per product from official sources (manufacturer site, official store, publisher press kit). Front/hero first, then angles, what's in the box, details; for games the front box art (pack shot) first. No retailer watermarks, no third-party logos added, no lifestyle photos of people as the first image. Prefer transparent PNG/WebP, at least 1000 px on the long side. Save originals to `.cache/product-images/<slug>/<n>.<ext>` (git-ignored; the `sourceUrl` lets anyone re-download) and record each in `images`.
- **Image rights.** These are manufacturer and publisher marketing images, used to sell their genuine products; record the owner in `credit`. The store owner must confirm usage rights with their distributors before going live.

## Shape

```jsonc
{
  "slug": "nintendo-switch-2",                 // kebab-case, unique, stable
  "group": "nintendo-hardware",                // research group that owns the file
  "kind": "console",                           // console | handheld_pc | game | controller | headset | storage | accessory | vr | digital
  "platform": "nintendo",                      // nintendo | playstation | xbox | pc_handheld | multi
  "brand": "Nintendo",
  "deviceModel": "switch-2",                   // consoles / handhelds: the device this product IS (device hubs, compatibility targets)
  "family": "switch-2",                        // products that are editions of the same device share a family
  "status": "available",
  "releaseDate": "2025-06-05",                 // ISO date of the first release of THIS product/edition (worldwide or note the region in notes)
  "name": { "ar": "Nintendo Switch 2", "en": "Nintendo Switch 2", "ckb": "Nintendo Switch 2" },
  "short": { "ar": "…", "en": "…", "ckb": "…" },           // one fact line for cards: "256GB · شاشة 7.9 بوصة"
  "description": { "ar": "…", "en": "…", "ckb": "…" },     // 2–4 plain sentences, our words
  "highlights": [ { "ar": "…", "en": "…", "ckb": "…" } ],  // 3–6 short facts customers care about
  "specs": [
    { "key": "display", "label": { "ar": "الشاشة", "en": "Display", "ckb": "شاشە" }, "value": { "ar": "…", "en": "…", "ckb": "…" } }
  ],
  "inTheBox": [ { "ar": "…", "en": "…", "ckb": "…" } ],
  "variants": [
    {
      "sku": "NS2-STD",                        // our SKU: short, uppercase, stable
      "title": { "ar": "…", "en": "…", "ckb": "…" },
      "options": { "edition": "Standard", "storage": "256GB", "color": "Black" },
      "modelNumber": "BEE-001",                // manufacturer model number when published
      "barcodes": ["0045496884963"],           // EAN/UPC only when found on an official or major-retailer page; region noted in notes
      "isDefault": true,
      "images": ["nintendo-switch-2--1", "nintendo-switch-2--2"],
      "notes": { "ar": "…", "en": "…", "ckb": "…" }   // optional
    }
  ],
  "game": {                                    // only for kind = game
    "platforms": ["switch-2"],                 // device models it runs on
    "genres": [ { "ar": "…", "en": "…", "ckb": "…" } ],
    "players": "1",                            // "1", "1-4", "1-2 local, 1-12 online"
    "online": { "ar": "…", "en": "…", "ckb": "…" },
    "ageRating": { "pegi": 12, "esrb": "E10+" },
    "arabic": "voice+subtitles+interface",     // or "subtitles+interface" | "interface" | "none" | "unknown"
    "physicalFormat": "cartridge",             // cartridge | game-key-card | disc | code-in-box
    "sizeGb": 24.5,
    "developer": "Nintendo", "publisher": "Nintendo"
  },
  "compatibility": [
    { "deviceModel": "switch-2", "status": "verified", "note": { "ar": "…", "en": "…", "ckb": "…" }, "source": "https://…" }
  ],                                           // status: verified | partial | incompatible | unverified
  "related": [ { "slug": "nintendo-switch-2-pro-controller", "kind": "setup" } ],   // setup | accessory | upsell | alternative
  "images": [
    {
      "key": "nintendo-switch-2--1",           // <slug>--<n>
      "file": ".cache/product-images/nintendo-switch-2/1.png",
      "sourceUrl": "https://assets.nintendo.com/…",
      "sourcePage": "https://www.nintendo.com/…",
      "kind": "hero",                          // hero | angle | detail | in-box | box-art | screenshot
      "alt": { "ar": "…", "en": "…", "ckb": "…" },
      "credit": "Nintendo",
      "width": 1600, "height": 1200, "transparent": true
    }
  ],
  "sources": [ { "url": "https://…", "title": "…", "publisher": "Nintendo", "retrieved": "2026-11-11", "supports": "release date, specs, in the box" } ],
  "notes": { "ar": "…", "en": "…", "ckb": "…" },          // optional: anything else a buyer should know
  "verification": { "checkedBy": "…", "secondSource": true, "unverified": ["…"] }
}
```

Validate with `node scripts/products/validate.mjs [slug…]` — it checks required fields, the three languages, slugs, SKUs, image files and sources.
