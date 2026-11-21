# Switch bundle builder — contract (v1, 2026-11-21)

`/build/switch` lets a shopper plan a Nintendo Switch 1 purchase: **console → memory card → games → review**, with a
space bar that refuses a game that does not fit, then puts every part TamTam sells into the cart in one go.
Owner request (2026-11-21): device choice (Switch OLED…), memory 64/128/256/512GB/1TB, a library of Switch 1 games
with their FULL installed size (after updates, not only the download), a remaining-space bar, tap = select / tap again =
unselect, press-and-hold = an Apple-style details sheet (description, video, pictures, score, size, genres…), search,
filters (price, size…), and a skippable spotlight guide (screen dims, the explained part stays visible).

Research behind every decision: `D:/tt-tmp/switch-lib/reports/` — `ui-kit.md`, `commerce.md`, `platform.md`
(code maps) and `storage-facts.md`, `sizes.md`, `scores.md`, `nintendo-us.md` (data sources and rules).

## 1. Non-negotiable rules

1. **Legitimate purchases only.** Games are bought as TamTam cartridges or on Nintendo eShop with eShop cards.
   Nothing is preinstalled or copied. Never write "modded", "jailbroken", "hacked", "preinstalled", «مهكر», «تهكير»,
   «محمّلة مسبقاً» or similar anywhere (copy, comments, test names, ids).
2. **No data from Nintendo's or Metacritic's sites.** Do not fetch, scrape, hotlink or copy anything from
   nintendo.com (any region), assets.nintendo.com, ec.nintendo.com, store-jp.nintendo.com or metacritic.com:
   no text, pictures, trailers, prices, sizes or scores. (Nintendo ToS §4A/§6 + robots.txt reservation of rights;
   Fandom/Metacritic ToS.) Plain `<a href>` links OUT to a game's eShop page or Metacritic page are fine.
3. **Open data, with attribution.** The game list comes from **Wikidata (CC0)**. Descriptions may come from
   **Wikipedia lead extracts (CC BY-SA 4.0)**, always shown with "Wikipedia" + article link + licence link.
4. **TamTam's own data** (sizes measured on TamTam consoles, eShop prices checked by staff, official YouTube trailer
   ids, uploaded pictures, TamTam descriptions, and Metacritic scores ONLY when TamTam holds the Metacritic licence)
   is entered in `/admin/catalog/switch-library` and stored in D1 `switch_library_entries`.
5. **No invented facts.** A game without a TamTam size cannot join the space bar ("size not added yet"). No guessed
   sizes, prices, scores, stock or delivery promises. Money is integer IQD; USD prices are labelled eShop prices
   with their "as of" date.
6. TamTam's architecture rules apply (CLAUDE.md, docs/ARCHITECTURE.md, docs/DESIGN.md): ar/en/ckb for every string,
   tokens only, logical CSS, services own rules, `*.server.ts` for server code, one owner per file.

## 2. What exists already (lead, 2026-11-21)

- Worktree `D:/tt-tmp/wt-switch` (branch `switch-builder`), dev server **http://localhost:5180** (own local D1,
  demo seed + dev accounts). Do not start/stop dev servers; if it answers 500 because of a broken import, fix your own
  files or wait — never edit another owner's file.
- `app/lib/switch-builder/types.ts` — every shared shape (LibraryGame, GameDetails, LibraryList/Chunk, LibraryExtras,
  LibraryExtrasPayload, CapacityConfig, BuilderPlan, BuilderStep, CatalogOption, BuilderCatalog, QuoteLine, BuilderQuote).
- `app/lib/switch-builder/storage.ts` — capacity maths (DEFAULT_CAPACITY, sanitizeCapacity, capacityOf, spaceNeeded,
  usageOf, fits, toGiB, digitsToTell, bytesFromGiB). Use it; do not re-implement it.
- `app/server/db/schema/switch-library.ts` + migration `drizzle/0006_switch_library_entries.sql` (applied locally).
- Route `/build/switch` registered (`app/routes/storefront/builder/routes.ts`, spread into storefront `_routes.ts`)
  with a placeholder module.
- **Stubs with final signatures** (owners replace the bodies, never the signatures): `builder.server.ts`
  (loadBuilderCatalog, parsePlan, quoteBuilderPlan), `app/server/services/switch-library.server.ts` (getLibraryExtras),
  `components/GameSheet.tsx` (GameSheetProps), `components/BuilderTour.tsx` (useBuilderTour), `lib/use-long-press.ts`
  (useLongPress), `library.manifest.ts` (LIBRARY_LIST_FILE…), `app/ui/cart-client.ts` → `addManyToCart`.

## 3. Storage maths (storage.ts)

- Bytes everywhere; shown as «GB» = bytes / 1024³ with one decimal (what the console and the eShop show).
- Card label sizes are decimal. Usable = label × 10⁹ × 0.985. Headroom kept free on the card for updates =
  clamp(5 % × usable, 2 GB, 8 GB). Plannable on the card = usable − headroom
  (64→55.8, 128→111.6, 256→226.8, 512→461.7, 1TB→909.4 GB — the 8 GB cap applies from 256GB up).
- System memory usable: OLED 54.0, Switch 25.9, Lite 25.9 GB; 2.0 GB reserved for saves/screenshots/system updates.
- Total plannable = (internal − reserve) + (card − headroom). The console fills the card, then system memory.
- Game need: digital = `sizeBytes` (base + latest update, no DLC); cartridge = `cartridgeBytes` ?? `sizeBytes` (say
  "counted at full size until we measure it" when the fallback is used). Saves never count on the card.
- Fit check on exact bytes; refusal text shows both figures with `digitsToTell`.
- Constants come from the setting `builder.switch.capacity` (sanitizeCapacity) so staff can enter real readings.
- The owner's example (games of 250 GB "on a 256 GB card"): the card gives 226.8 GB to games, plus the console's own
  free memory (52.0 GB on an OLED, 23.9 GB on a Switch or Lite) — never the 256 printed on the card; the guide says why.
- A cartridge measured at 0 bytes needs no extra space (0 is a measurement; only a missing figure is "not measured").

## 4. Data

### 4.1 Open list (data owner)

- Source: Wikidata SPARQL (CC0; https://query.wikidata.org/sparql, generic descriptive User-Agent with no names or
  project data, gzip, sequential queries). Items with P400 = Q19610114 (Nintendo Switch) AND a Nintendo eShop ID
  (P8084) ending in `-switch` (Switch 1 product); keep video games and compilations, drop DLC/expansions/series/esports
  /editions-without-own-slug. Starter queries: `D:/tt-tmp/switch-lib/scripts/scores/rq/` (see `reports/scores.md`).
- Per game (`LibraryGame`): id = the P8084 slug; qid; title (en, else mul); titleAr/titleCkb (labels); year/released
  (Switch-qualified P577 first); publishers (P123 labels); genres (P136 mapped onto GENRE_KEYS through P279*);
  modes (P404 → single/multi/coop/online); popularity (sitelinks); metacriticSlug (P12054, preferred rank); aliases
  (en/ar altLabels + P179 series labels); chunk index.
- Details (`GameDetails`): developers (P178), series, opencriticId (P2864), Wikipedia lead extracts for en/ar/ckb
  articles (REST summary endpoint, plain text ≤ ~900 chars cut at a sentence end, title, url, asOf).
- Build: `scripts/switch-library/` (fetch → `catalog/switch-library/*.json` committed snapshot → build) writes
  `public/library/switch/list.<h8>.json` (LibraryList) and `public/library/switch/d/<n>.<h8>.json` (LibraryChunk,
  ~64 chunks by stable hash of id), deletes stale hashed files, regenerates `library.manifest.ts`.
  `public/_headers`: `/library/*` immutable. Never import the JSON through TypeScript/Vite.
- Budget: list ≤ 350 KB brotli; a chunk ≤ 60 KB brotli.

### 4.2 TamTam's data (data owner: read path + API; admin owner: editing)

- Table `switch_library_entries` (lead created it). `getLibraryExtras(db)` maps rows → `LibraryExtrasPayload`
  (`extras` keyed by game id; image → `imageKey` = the public file's storage key served at `/media/<key>` with its
  width/height; hidden rows included with `hidden: true`), plus `capacity` = sanitizeCapacity(setting) and `rev`
  (max updated_at + row count).
- `GET /api/switch-library` (resource route, `app/routes/api/switch-library.ts`): JSON payload,
  `Cache-Control: public, max-age=60`; cached at the edge for 60 s (integration owner adds it to edge-cache).
- Setting `builder.switch.capacity` (JSON, default DEFAULT_CAPACITY) in `app/server/settings.server.ts`.

## 5. Commerce (commerce owner)

- `loadBuilderCatalog(db, locale, now)` → `BuilderCatalog`, from the live catalogue rules (published/scheduled-live
  product, active variant, free units > 0 → orderable; never stock counts):
  - devices: published consoles linked to dvm_switch-oled / dvm_switch / dvm_switch-lite (today only the OLED, 2
    colours); null for a model TamTam does not sell.
  - cards: storage products with a verified compatibility rule for Switch 1 models and `options.storage` ∈
    64GB/128GB/256GB/512GB/1TB; per size the cheapest orderable variant, else any (orderable false). microSD Express
    products only with their "works at UHS-I speed on Switch 1" note — or not at all.
  - cartridges: published physical games for Switch 1 (game.platforms ∋ switch|switch-oled|switch-lite; never
    switch-2-only such as the 2026 Ocarina of Time remake) whose `attributes.sources` holds the nintendo.com US urlKey
    = library id.
  - eshop: US wallet top-up variants (`options.value` "N USD") that are buyable; `sold:false` when none (today the
    eShop card product is archived demo data).
- `parsePlan(raw)` (zod; PLAN_LIMITS) and `quoteBuilderPlan(db, locale, plan, extras, now)` → `BuilderQuote`:
  console line (when not owned and a variant is chosen), card line (when not owned and sold), cartridge lines, and
  eShop card lines covering the digital games that have a TamTam price (`app/lib/switch-builder/eshop-mix.ts`:
  smallest overshoot, then fewest cards, within availability — computed on the server).
- Atomic multi-add: `addManyToCart(db, request, {items}, now)` in `cart.server.ts` (validate all, one `db.batch`,
  price once; any refusal writes nothing and returns per-item problems), `/api/cart` `intent=add_many`
  (`items` = JSON `[{variantId, qty}]`, counted once against the rate limit), `cart-client.ts addManyToCart()`
  (header count follows; no toast — the caller shows one).
- Memory sizes: add SanDisk Extreme 64/128/512GB/1TB variants (real model numbers from SanDisk's own pages; inactive,
  price 0, no stock) to `catalog/products/sandisk-extreme-microsd.json`, and a guarded idempotent
  `scripts/sql/2026-11-21-switch-builder.sql` for production (the lead runs it at deploy). The owner prices them.

## 6. The page (storefront-ui owner; §6.5–6.7 sheet-and-tour owner)

### 6.1 Shape
- One URL per step: `/build/switch` (device), `?step=memory|games|review`. Handle like the trade-in wizard
  (`chrome: search has step ? "task" : "store"`, `nav: "push"`, `group: "switch-builder"`, `order` from the step).
  `shouldRevalidate`: no loader re-run for a step change.
- Loader: `loadBuilderCatalog` + messages (`switch-builder`, `switch-builder-sheet`, `errors`) + meta (noindex unless
  `SWITCH_BUILDER_PUBLIC` in `flags.ts` is true, and always for `?step=`). The loader must not read cookies (the
  page is edge-cached for anonymous visitors).
- Action `intent=quote` (`plan` = JSON) → `quoteBuilderPlan` with extras from `getLibraryExtras`.
- The plan lives in localStorage `tt.sb.plan.v1` (restored AFTER hydration — SSR renders the empty plan); "Start over".
- `<ProgressSteps labels="under">` (data-tour="steps"); focus the step's h1 on step change; StepKeys («رجوع» /
  primary «تابع») in `<TaskBar>` below 1024 px, in a sticky aside from 1024 px (never two sticky bars at one edge).
- Footer note on the games step: «معلومات الألعاب من Wikidata (CC0)، والأوصاف من Wikipedia (CC BY-SA 4.0)» + links.

### 6.2 Device step
- «أشتري جهازاً من طمطم» / «عندي جهاز Switch» (data-tour="device-mode"). Buy: the models TamTam sells now, with
  photo (`<Art>`), colour variants, price, stock state (data-tour="device-list"). Have: all three models (OLED,
  Switch, Lite) to set the capacity; no console line in the cart. Lite note: handheld only.

### 6.3 Memory step
- Options: «بدون بطاقة», 64GB, 128GB, 256GB, 512GB, 1TB (data-tour="card-list"), each with its plannable space
  («≈ 223 GB للألعاب», data-tour="card-usable" on the first) and price, or «غير متوفر في طمطم حالياً» (still
  choosable for planning). «عندي بطاقة» toggle (data-tour="card-owned"). Follow the catalogue's own Arabic word
  for memory cards.

### 6.4 Games step
- Library: fetch `LIBRARY_LIST_FILE` (start at idle on the earlier steps) + `/api/switch-library`; merge; hide
  `hidden` games. States: loading, error + retry, offline, empty search.
- Meter (data-tour="meter"): used · kept free for updates · left; `role="meter"`; colour ink → --warn → --danger
  (never brand red); over-capacity message after a smaller card was chosen.
- Search (data-tour="search"): title, Arabic title, aliases, publishers; Arabic folding (port the pure
  `normalizeSearchText` to `app/lib/switch-builder/search.ts`); debounce ~150 ms.
- Filters (data-tour="filters", a Sheet): genre, players, size range, price range (priced games), "fits the space
  left", "TamTam cartridge", "size added". Sort (Menu, radio rows): popular (default), newest, A–Z, smallest,
  cheapest, score (only when any licensed score exists). Within any sort, plannable games come first.
- Grid: ≤ ~48 cards rendered at once (show more / windowing). Card (first card data-tour="game-card"): picture
  (TamTam upload → `/media/<key>`, cartridge `<Art>`, else a typographic tile from tokens), title (BidiText), year,
  size badge (data-tour="game-size") «16.5 GB» or «لم يُضف الحجم بعد», eShop price if priced, «شريط من طمطم» badge.
  The card is a `<button aria-pressed>`: tap toggles; does-not-fit = aria-disabled + words, and a tap explains with
  both figures and offers «بطاقة أكبر»; unsized = explains. Info `IconKey` (data-tour="game-info") is a SIBLING of
  the button and opens the sheet; press-and-hold (useLongPress) opens it too.
- Chosen list (data-tour="chosen"): phone = a chip that opens a Sheet with the chosen games (remove keys, sizes);
  desktop = the aside list. Default format for a game TamTam sells as an orderable cartridge = cartridge, else digital.

### 6.5 Long press (sheet-and-tour owner) — `useLongPress`: 450 ms, cancel on 6 px movement / pointercancel / scroll,
  prevent the context menu, swallow the click after it fires, `-webkit-touch-callout: none`; no haptics.

### 6.6 Details sheet (sheet-and-tour owner) — `<Sheet presentation="side" sideFrom={768}>` (bottom sheet, drag to
  close on phones; side panel from 768): title (+ Arabic title), year · publisher · developer, genres, players, size
  breakdown (digital size; cartridge space; "as of"; why it is bigger than the download; saves stay on the console),
  eShop price + date, licensed Metacritic score only when present («Metacritic 92 · 120 مراجعة · as of», link),
  description (TamTam's in the page language; else the Wikipedia extract in the page language, else English with
  `lang="en"`, always with attribution), trailer (YouTube id → click-to-load `youtube-nocookie.com` embed; nothing
  loads before the tap), links (eShop page, Metacritic page, Wikipedia), format choice (cartridge/digital) when TamTam
  sells the cartridge, and the foot key «أضف إلى جهازي» / «أزلها» (disabled with the reason when it does not fit or
  has no size). Genre/mode labels: `useT("switch-builder")` keys `genre.<key>` / `mode.<key>` (storefront-ui owns them).

### 6.7 Guide (sheet-and-tour owner) — `useBuilderTour(step, {ready})`: per-step spotlight steps over `data-tour`
  targets (missing targets are skipped): a --scrim layer with a clip-path cut-out (no box-shadow spread), a focus
  ring, an opaque note «2 من 5», «التالي», «تخطَّ» visible from the first frame, Esc/Android back; starts by itself
  the first time each step is shown; «تخطَّ» turns the auto-start off for every step (localStorage `tt.sb.tour.v1`);
  the page's «?» key (data-tour="help") replays the current step. Reduced motion = fades only. Built on the modal
  primitives of `~/ui/Dialog` (useOverlayRoot, useModalLayer, fadeElement) and `placeMenu` from `~/ui/Menu`.
  Targets: steps, help, device-mode, device-list, card-list, card-usable, card-owned, meter, search, filters,
  game-card, game-size, game-info, chosen, continue, review-lines, review-notes, add-all.

### 6.8 Review step
- Lines (data-tour="review-lines"): console or «جهازك»; card or «بطاقتك»/«بدون بطاقة»; cartridges; digital games
  (eShop total of priced ones; unpriced listed); eShop cards covering the total when sold. Notes
  (data-tour="review-notes"): parts TamTam cannot sell now, unpriced games, how digital games are bought (redeem the
  card on a US Nintendo Account, then buy on the eShop). One red figure: the total of orderable lines.
- «أضف الكل إلى السلة» (data-tour="add-all") → `addManyToCart` → `toast.cart` + flyToCart once + «عرض السلة»; a refusal
  shows each line's reason (`cartErrorKey`) and changes nothing.

## 7. Admin (admin owner) — `/admin/catalog/switch-library`
- List (search title/slug, filters: size added / missing, priced, hidden; the open list is fetched on the client and
  merged with the rows), edit form (sizes typed in GB as the console shows them → bytes; as-of dates default to today;
  eShop price in USD; trailer = YouTube URL or id → id; picture upload through the existing public upload path;
  descriptions ar/en/ckb; Metacritic score/reviews/as-of with the note "only with TamTam's Metacritic licence";
  hidden), CSV import (preview → apply) and export. A permission (e.g. `catalog.switch_library.manage`), audit
  events for every change, `admin-switch-library` messages.

## 8. Integration (integration owner)
- CSP: `frame-src https://www.youtube-nocookie.com` (only addition), docs/SECURITY.md, CSP tests.
- Edge cache: `/build/switch` and `/api/switch-library` (anonymous GETs); tests.
- Shell: `build` in shell/chrome.ts SEARCH_KEY_PATH and CATALOGUE; tests.
- `app/routes/storefront/builder/flags.ts`: `export const SWITCH_BUILDER_PUBLIC = false` — entry links (Nintendo
  mega menu, /platform/nintendo, the Switch 1 device hubs, the OLED product page, footer) render only when true.
- Privacy policy: localStorage `tt.sb.plan.v1` / `tt.sb.tour.v1`; YouTube loads only after the shopper taps play.
- docs/STATUS.md row for the builder (truthful: what works, what waits for the owner).

## 9. Ownership

| Owner | Files (create/edit only these) |
|---|---|
| data | `scripts/switch-library/**`, `catalog/switch-library/**`, `public/library/switch/**`, `public/_headers` (one rule), `app/routes/storefront/builder/library.manifest.ts`, `app/server/services/switch-library.server.ts`, `app/routes/api/switch-library.ts` + its line in `app/routes/api/_routes.ts`, `app/server/settings.server.ts` (the one key), `tests/switch-library-data.test.ts`, `tests/switch-library-extras.test.ts` |
| commerce | `app/server/services/cart.server.ts`, `app/routes/api/cart.ts`, `app/ui/cart-client.ts` (addManyToCart), `app/routes/storefront/builder/builder.server.ts`, `app/lib/switch-builder/eshop-mix.ts`, `catalog/products/sandisk-extreme-microsd.json`, `scripts/sql/2026-11-21-switch-builder.sql`, `tests/cart-add-many.test.ts`, `tests/switch-builder-commerce.test.ts` (+ an error key in `app/i18n/messages/errors.ts` if one is needed) |
| storefront-ui | `app/routes/storefront/builder/switch-builder.tsx`, `routes.ts`, `components/**` except the sheet-and-tour files, `lib/**` except `use-long-press.ts`, `builder.css`, `app/lib/switch-builder/search.ts`, `app/lib/switch-builder/plan.ts`, `app/i18n/messages/switch-builder.ts`, `tests/switch-builder-ui.test.ts` |
| sheet-and-tour | `components/GameSheet.tsx`, `components/BuilderTour.tsx`, `components/SpotlightTour.tsx`, `components/TrailerEmbed.tsx`, `components/tour-steps.ts`, `lib/use-long-press.ts`, `builder-sheet.css` (imported by its own components), `app/i18n/messages/switch-builder-sheet.ts`, `tests/switch-builder-sheet.test.ts` |
| admin | `app/routes/admin/catalog/switch-library*.ts(x)`, its lines in `app/routes/admin/catalog/routes.ts` and the catalog module nav, `app/server/services/admin/switch-library.server.ts`, the permission in `app/server/permissions.ts` (+ role grants, + `scripts/sql/2026-11-21-switch-library-perms.sql` if production needs one), `app/i18n/messages/admin-switch-library.ts`, `tests/admin-switch-library.test.ts` |
| integration | `app/server/security.server.ts`, `docs/SECURITY.md`, `workers/edge-cache.ts`, `app/routes/storefront/shell/chrome.ts`, `app/routes/storefront/builder/flags.ts`, the entry-link files (as found), `app/server/services/content.server.ts` + `app/i18n/messages/content.ts` (privacy lines), `docs/STATUS.md`, the tests those files already have, `tests/switch-builder-integration.test.ts` |
| lead | this file, `types.ts`, `storage.ts`, the schema + migration, `app/routes/storefront/_routes.ts`, final integration |

Need a change in a file you do not own? Do not make it: write it under "Requests to other owners" in your report.

## 10. Checks before you finish
`npx tsc -b --pretty false` (fix every error in your files; report others'), `npx vitest run <your tests>`
(+ `tests/i18n.test.ts` when you add strings), `node scripts/lint-design.mjs <your files> --strict` for UI,
`node scripts/shot.mjs http://localhost:5180/... .shots/<name>.png <w> <h> [--dark] [--lang=en|ckb]` at 390 and 1280
(look at the pictures with the Read tool). Run `npx react-router typegen` once after adding a route (retry on
ENOTEMPTY). Do not commit; the lead commits.
