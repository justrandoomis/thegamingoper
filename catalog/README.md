# Product catalogue research

One JSON file per product in `catalog/products/<slug>.json`, researched from official manufacturer and publisher pages (checked against a second source), as of the `retrieved` date in each source entry. This folder is the single source of truth for the demo catalogue: the demo seed (`npm run db:seed`, `npm run db:reset`) imports it into the database (see Import below), and `npm run catalog:images` turns the downloaded images into the responsive files the storefront serves.

**Prices are not researched.** Shop prices come later from the owner's price file; until then the importer assigns random placeholder prices flagged `is_demo`.

## Rules

- **Facts only, with sources.** Every spec, date, edition, box content and compatibility claim must be supported by an entry in `sources`. Prefer the manufacturer or publisher page; use a second reputable source (another official regional page, Wikipedia, major press) to confirm. Leave a field out rather than guess, and list anything you could not confirm in `verification.unverified`.
- **Status is as of the retrieval date** (2026-11-11 for the first pass): `available`, `preorder` (date announced, orders open), `upcoming` (announced, no orders), `discontinued` (no longer manufactured but still sold), `limited` (limited or store-exclusive edition).
- **Our own words.** `description` and `highlights` are written by us, plainly, from the facts — never copied marketing copy. Specs are facts and may be stated as published.
- **Names.** Official product names stay in their official Latin form in every locale (`Nintendo Switch 2`, `DualSense`, `Grand Theft Auto VI`). Translate only the descriptive words around them (colour, edition, bundle, controller, "Digital Edition" may stay Latin if that is how it is sold). A name that **opens with Latin is a Latin title and carries no Arabic-script words** (design v2 spec §4.11: «PlayStation 5 (الطراز الأصلي 2020)» broke into «PlayStation 5 (الطراز» / «الأصلي 2020)» in RTL rows): put those words in `qualifier` («PlayStation 5 Slim · 1TB» + «نسخة الأقراص» — the storefront prints it first on the cards' meta line and under the product page's name), or open the name with them («قرص Samsung 990 PRO NVMe SSD مع مشتت حراري», «سماعة Razer BlackShark V2 X»). A hyphen **inside** a Latin token of a name or a variant title is the non-breaking hyphen U+2011 («USB‑C», «Joy‑Con», «Pokémon Legends: Z‑A», «Spider‑Man», «Game‑Key Card»): carts, checkout and order lines print the stored name as it is, and a plain hyphen let a narrow line break inside the token («…Battery + USB-» / «C Cable», QA 2026-11-13). Search folds it like "-" (shoppers type either); quoted source titles keep the publisher's own hyphen.
- **Variant titles are the option value only** (design v2 spec §4.13): «لجهاز PS5» / "PS5 edition" / «بۆ PS5», «النسخة الدولية» / "International model", «أبيض», "512GB · Robot White" — carts and order lines print them under the product's name, so a title never repeats that name, and an English one starts with a capital. A product with one version that has nothing to choose keeps its own name as the title (no option line is printed then).
- **Three languages.** Every `L10n` object has `ar`, `en` and `ckb` (Kurdish Sorani, Arabic script). Natural, plain shop language — no machine-literal phrasing.
- **What customers in Iraq need to know** goes into `highlights`/`specs`/`notes`: storage and what it holds, what is in the box, which devices it works with, online requirements (Nintendo Switch Online, PlayStation Plus, Game Pass), region or account restrictions (gift cards, digital codes), Arabic language support in games (interface / subtitles / voice — say "unknown" if the official page does not state it), whether a Switch 2 physical game is a full cartridge or a **Game-Key Card** (download required), storage size of a game, age rating (PEGI where available, else ESRB), players / co-op.
- **Images.** 2–6 per product from official sources (manufacturer site, official store, publisher press kit). Front/hero first, then angles, what's in the box, details; for games the front box art (pack shot) first — the 2:3 cover (the store "Poster" / "PORTRAIT_BANNER" art), never square or 16:9 key art (design v2 spec §7.6); for gift cards the card face (kind `hero`; a printed face that fills its frame is accepted by the opaque-photo gate in `scripts/products/image-options.json`). No retailer watermarks, no third-party logos added, no lifestyle photos of people as the first image. Prefer transparent PNG/WebP, at least 1000 px on the long side. Save originals to `.cache/product-images/<slug>/<n>.<ext>` (git-ignored; the `sourceUrl` lets anyone re-download) and record each in `images`.
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
  "qualifier": { "ar": "نسخة الأقراص", "en": "Disc edition", "ckb": "وەشانی دیسک" },  // optional: the words a Latin title leaves out ("" where the name says it); printed first on the meta line
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
      "releaseDate": "2027-02-04",             // optional, only when THIS variant comes out after the product (a new colour, a later platform version); never on the default variant
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
      "view": "back",                          // optional: the picture shows the object's back (ports, stand) — never a tile or lead picture; never the first image
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

Validate with `node scripts/products/validate.mjs [slug…]` — it checks required fields, the three languages, slugs, SKUs, image files and sources, that a Latin-first name carries no Arabic-script words (and the `qualifier` shape), that names and variant titles keep their Latin tokens whole (U+2011, never a plain hyphen inside a token), and that no variant title repeats the product's name or starts an English value with a small letter.

## Import

The demo seed imports this folder directly — there is no generated copy to keep in step. `npm run db:seed`, `npm run db:reset` and the production path `npm run db:seed -- --sql <file>` all read `catalog/products/*.json` at run time, in Node (`app/server/db/seed/demo/catalog/load.ts`); nothing under `catalog/` is imported by a module, so none of it reaches the Worker or the client bundle (`tests/seed.test.ts` checks that no module under `app/` imports it).

After editing a file: `npm run catalog:validate`; if images changed, `node scripts/products/images.mjs --only <slug>`; then `npm run db:seed -- --overwrite` (refreshes names, texts, specs, pictures, compatibility and relations of existing rows; never prices, costs or stock) or `npm run db:reset`. Overwrite does not delete: an image, rule or relation you removed stays until `db:reset`. (A `catalog:import` npm script for that overwrite seed is requested from the lead; it does not exist yet.)

Where the facts go (`app/server/db/seed/demo/import.ts`):

| Catalogue | Database |
|---|---|
| `kind` | `products.kind`: `handheld_pc` → `console` (its device model has `device_kind = handheld_pc`), `vr` → `accessory` in the "vr" category; the research kind stays in `attributes.catalogue.kind` |
| `platform` | `products.platform_id`: `pc_handheld` → the "handheld" platform; `multi` → none (multi-platform games go to the "multiplatform-games" category) |
| `deviceModel` / `family` | the product's `device_model_id`; when one `deviceModel` value is shared by different families (the MSI Claw line), each family is its own device model |
| `specs` | `products.specs` as `{ [key]: { ar, en, ckb, label: { ar, en, ckb } } }`, in research order; the device model gets the specs of the product that is that device |
| `highlights`, `inTheBox`, `notes`, `game`, variant notes, variant release dates, extra barcodes, `sources`, `verification.unverified`, `status`, `releaseDate` | `products.attributes` (`ProductAttributes` in import.ts) |
| `qualifier` | `products.attributes.qualifier`; the read layer (`app/server/services/catalog/card-facts.ts` `qualifierOf`) puts it first on the cards' `subtitle` and the product page's `short`, and hands it to the header suggestions and the mega menu as its own field |
| `game.ageRating` | `products.age_rating`: "PEGI n" first, else "ESRB x" |
| `warranty` spec | stays in `specs` only. `products.warranty_months` is the store's own warranty (the cart copies it into the order, delivery opens a `warranties` record the store must honour), so the import leaves it empty: a maker's limited warranty is not the store's promise |
| `releaseDate` ahead of today | a pre-order: `preorder_release_at`, no stock |
| variant `releaseDate` ahead of today | that variant has no stock until then (the schema has no per-variant pre-order flag) |
| `variants` | `variants`: SKU, title, `options` plus `model` (the maker's model number), first barcode, default flag, research order |
| `images` | `media` rows: `art_key` = the photo key, `kind` image, `is_illustration` 0, alt as researched; a variant with its own set of pictures gets its own rows |
| `compatibility` | `compatibility_rules` on the product, status exactly as researched (`unknown` → `unverified`, never better), `source` = the URL |
| `related` | `product_relations` |

The seed refuses to run, with a message naming the file, when the catalogue cannot be placed: a device key (`deviceModel`, `family`, a compatibility or `game.platforms` key) that is not in `app/server/db/seed/demo/devices.ts` — add the device there (name, platform, generation, device kind, the product that is that device) —, an image without a built photo, a duplicate SKU or slug, a product without exactly one default variant, a related slug that does not exist, a variant `releaseDate` that is malformed, not after the product's, or on the default variant.

What the import adds that research does not cover is demo data (`app/server/db/seed/demo/pricing.ts`, `used.ts`, `sets.ts`): placeholder prices (deterministic per SKU), costs (70–85 % of the price; digital codes 92–96 %, since they sell at face value), a handful of previous prices (only on items sold for at least 90 days), stock, serials, six used units, trade-in guides, and one store set made of two catalogue items. Products and used units carry `is_demo = 1`; prices, costs and stock have no such column and belong to those demo products; stock movements and serials say "DEMO" in their text. A digital variant has 5 units on hand (the last 2 of a discontinued card, `pricing.ts` `demoCodeCount`) and as many DEMO codes ("DEMO-<SKU>-0001", `is_demo = 1`, encrypted with the environment's `DATA_KEY` exactly as module 13 stores an import): `seedDemoDigitalCodes(db, now, { dataKey })` in `app/server/db/seed/demo/codes.ts`, run by the local seed with the local key — never part of the SQL file, whose database has another key.
