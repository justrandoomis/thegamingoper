# Catalog area — hubs, search, compare

Owner: catalog area. Brief §3.3, §3.5, §3.6; DESIGN.md §8.2 hub, §8.3 list, §9.7 filter drawer, §9.8 chips.
Files: `app/routes/storefront/catalog/**`, `app/server/services/catalog/listing.server.ts`, `app/server/services/search.server.ts`,
`app/routes/api/search-suggest.ts`, `app/i18n/messages/catalog.ts`, `tests/catalog-listing.test.ts`, `tests/search.test.ts`.

## Routes

| Path | What |
|---|---|
| `/c/:category` | category hub: compact stage (lit when the department has one platform, or by the one platform filtered), chip rail (sub-categories; for a leaf the platforms, else the devices), the list, device shortcuts. Unknown/inactive → 404; the `used` kind → 302 `/used` |
| `/platform/:platform` | platform hub: stage in the platform's light + LED, department chips, "everything about your device" (→ `/device/<model>`), the list, used shelf (`getUsedSpotlight`). Inactive (`pc`) → 404. Siblings: sideways push in platform order (`handle`) |
| `/search?q=` | results (relevance default), "did you mean" notice, category-aware jumps, results by department (chips), zero-result recovery; empty `q` → recent searches + browse |
| `/compare?ids=a&ids=b` | ≤ 4 products of one kind (ids or slugs; `ids=a,b` accepted), spec rows aligned by key, "only differences", add/remove links, same-kind suggestions |
| `GET /api/search/suggest?q=&locale=` | `{ suggestions: { label, href, hint? }[] }` ≤ 8 (correction, platform/department/device jumps, products). 120/min per IP → 429; `Cache-Control: public, max-age=60` |

List URL grammar (one URL per state, shareable, Back-safe): `platform` (repeatable) `cat` `device` `min` `max` `stock=1` `deals=1`
`arabic=interface|subtitles|voice` `format` (repeatable) `sort` `cursor` (+ `q`). Unknown values are dropped, never an error; a stale
cursor redirects to the first page. Model and helpers: `catalog/listing-model.ts` (client-safe; the services import it).

## How it works

- **Researched platforms** (`listing.server.ts`): own `platform_id`, else the platforms of `attributes.game.platforms`, else of the
  product's verified/partial compatibility rules — exactly the import's `platformsOf`. `listCards` (platform_id only) misses the
  multi-platform games and headsets; the hubs include them (tested).
- **One universe statement** per request (linear CTE chain + correlated subqueries; D1-safe): card price, stock state 0/1/2,
  pre-order, platforms, device fits (listCards' "most specific rule wins"), game facts. Filters, disjunctive facet counts (each
  group counted with the other filters), sorts and the keyset cursor run in memory; the page's cards come from `getCardsByIds`.
  Tested equal to the cards service for every product and to `listCards`' device filter for every model. Fine for hundreds of
  products per scope; thousands would want facets in SQL.
- **"Show more" is cumulative**: `?cursor=X` returns the list from the start through the page after X (≤ 240, then a page alone
  with "back to the start"), so reload and Back keep what was shown, and the same link works without script.
- **Search** (`search.server.ts`): normalise → synonym concepts (sets sharing a spelling merged across ar/en/ckb; greedy longest
  phrase) → one FTS5 trigram statement per group (AND across groups; < 3 chars match word starts) → typo correction only when
  nothing matched (trigram candidates + Damerau–Levenshtein ≤ 1–2) → rank: exact name › starts with › contains, then name word
  coverage (each name word serves one group), then bm25, then availability. "xbox series x" → Series X first; "playstaion" →
  "playstation". Vocabulary cached per isolate for 5 min (`invalidateSearchCaches`).
- **Query stats**: `search_query_stats` (Baghdad day, locale, normalised query → searches, zero_results, last_at), first page of a
  plain search only, never bots, never queries with `@` or 7+ digits. No IP, account or session.
- **Recent searches**: this device only (localStorage), shopper's own switch on `/search`; without a choice they follow
  `personalizationConsent` (on only when true); switching off deletes them; 8 entries, 30 days.

## States (brief §12)

Default · loading (results stay usable, `aria-busy`, dimmed; chips switch at once from the pending URL; new cards inflate, kept
ones slide — `use-flip.ts`, full motion tier only) · partial data (used shelf failure → ErrorState, page stands) · empty
department · zero results (nearest filter to remove with its count, clear all, 3 picks: in-stock products of the section / new
arrivals; search adds the corrected spelling and the shorter queries) · offline (sort/filter keys go flat + reason) · validation
(price fields: digits, any numerals, min ≤ max, sentence on the field) · API failure (suggest → no list; loader → shell panel) ·
no script (GET form with filters + sort in `<details>`, chips and paging are links) · reduced motion (no FLIP, in place).

## Real, demo, boundary

Real: every filter, count, sort and match is computed from the database. Demo: prices and stock (seed). Not built here: device
hubs (`/device/*`, devices area — the shortcuts link there), used marketplace (`/used`), product page.

Bidi: chip labels go through `ChipText` (label isolated in the page's direction, then " · count"), device names and compare
cells are plain text in the page's direction — an auto isolate (`<bdi>`, the kit's `BidiText`) splits "PlayStation 5 (الطراز
الأصلي 2020)" at its brackets. Compare links use one `ids=` per product (`?ids=a&ids=b`), search links encode spaces as `+`:
both stay byte-identical when the server re-encodes the query (see Known gaps).

## Cross-area pieces (integration pass, 2026-11-11)

- `CompareToggle` (`catalog/CompareToggle.tsx`) is on the product page (its loader adds `"catalog"` to `messagesFor`).
  Hook/store: `useCompare`, `compareHref`, `addToCompare` (`catalog/compare-client.ts`).
- Cards carry NO compare key — decided: one walled key per card (DESIGN §9.5; the socket is the card's one key, and a
  card with options already opens the quick look there). Comparing starts from a product page or `/compare`'s own
  same-kind suggestions; the tray (`CompareTray`) brings a saved list back.
- `searchProducts(db, locale, q, opts)` → `Paged<ProductCardData> & { suggestions, zeroResultHelp }` (+ facets) for other areas.
- Recommendation shelves (devices area, `recommendationsFor(context: "search")`, streamed, drawn by the shared
  `devices/components/RecommendationShelves` at the bottom): platform and category hubs and search results show only
  the shopper's personal shelf, with consent (the store's picks would repeat the list); search without a query shows
  the personal shelf and the store's picks (for the shopper's platforms when they consented), each with its reason.
  Zero-result searches keep their own picks and get no shelf. A hub's filters never wait for the shelves, and the
  shelves never flicker: a newer answer replaces the old one only once it has arrived.
- Device tiles (`components/Hub.tsx → DeviceShortcuts`) are zoom links whose picture is the shared element
  `device-image:<slug>` — it grows into the device hub's stage.

## Verify

`npx vitest run tests/catalog-listing.test.ts tests/search.test.ts` · `node scripts/lint-design.mjs app/routes/storefront/catalog`
· flows: `node <scratch>/work/catalog/flow.mjs` — 49 checks: chip tap, filter sheet, show more + reload, header suggestions,
no-script form, recent searches (opt-in, delete), compare (differences, remove, tray, reopen), console and overflow on 9 URLs
· screenshots `.shots/catalog/` (390 / 768 / 1440, light / dark, ar / en / ckb, reduced motion).

## Known gaps

- Price filter: two fields + quick ranges, no slider (DESIGN §9.7 asks for one).
- Shell (not ours): the footer's language links are built from the raw `location.search`, while the server re-encodes the
  query (`%20` → `+`, `,` → `%2C`), so a hand-typed URL with either hydrates with a mismatch warning — on every page.
- The shell's per-platform `productCount` leaves out multi-platform products (the hubs count them).
- The kit's `BidiText` (product cards) splits names with Arabic in brackets ("PlayStation 5 Slim (نسخة الأقراص) – 1TB").
- Spec keys differ between researched products of one kind; compare folds only true synonyms per kind (listing.server.ts).
- Sorani copy needs a native reader. Chromium only.
