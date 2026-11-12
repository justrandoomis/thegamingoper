# Catalog area — hubs, search, compare

Owner: catalog area. Design System v2 (`design-v2-spec.md`) §6.2 platform hub, §6.3 category hub and listing behaviour,
§6.4 search, §6.5 compare; brief §3.3, §3.5, §3.6.
Files: `app/routes/storefront/catalog/**`, `app/routes/api/search-suggest.ts`, `app/i18n/messages/catalog.ts`,
`tests/catalog-listing.test.ts`, `tests/search.test.ts`. The read layer (`app/server/services/catalog/**`,
`app/server/services/search.server.ts`) belongs to the data owner: changes there are requests.

## Routes

| Path | What |
|---|---|
| `/platform/:platform` | the platform's colour band (`Band kind="platform"`, 104px on phones, 160px from 1024 with the switcher: h1, «42 منتجاً · التوصيل 5,000 د.ع لكل المحافظات، والدفع عند الاستلام», the hardware off the inline end; from 1024 a model switcher of paper tiles → `/device/<model>`, at most 3 + «كل الأجهزة (n)»), the departments as link chips with counts, the list, "everything about the device" (phones: a sideways row inside the grid after its first two rows, its title an h3 so the cards after it stay under the list's h2; from 768 a grid after the list, `#catalog-devices`), the platform's used units (≥ 3). Unknown or inactive → 404. Sibling hubs push sideways in platform order (`handle`) |
| `/c/:category` | title row (breadcrumbs from 768, h1, count · delivery line), one chip row (platforms with dots when the list has ≥ 2; else sub-departments; else devices), the list, then the hubs of the devices its products fit. Empty department → EmptyState «لا منتجات في هذا القسم بعد» + «ابحث في المتجر» + «وصل حديثاً». The `used` kind → 302 `/used` |
| `/search` | start: the field in the page (focused from 1024 only), «اقتراحات» chips (the platforms' device models — names, never "most searched"), recent searches (this device, consent-aware) and the «إعدادات البحث» row, the four compact platform tiles and the department tiles with the hubs' counts, the devices area's shelves |
| `/search?q=` | the listing template, h1 «نتائج «q»»; a corrected spelling shows its results under the corrected words with «بحثت عن «q»، ولم نجد شيئاً بهذه الكتابة…»; «اذهب مباشرة إلى» jumps; department chips. Nothing matches → EmptyState «لم نجد نتائج لـ «q»» + «هل تقصد:» (the shorter queries that find something) + platform and department tiles + «وصل حديثاً» (8 arrivals, no «جديد») — no sort, no filters |
| `/compare?ids=a&ids=b` | ≤ 4 of one kind. Product headers stay under the header while the rows scroll (96px well with the 44×44 «أزل» right beside it, name, price with the neutral `CardAddButton` right after it — never pushed to the column's far end, where they sat next to the neighbouring product); the corner offers «أضف منتجاً (حتى 4)» (→ the same-kind suggestions, whose «قارن» key wraps under them at 320px); «اعرض الفروق فقط» beside its label, from two products; «غير موثّق» where the research says nothing. Phones: two product columns, each spec's name a full-width row above its values (three or four products scroll sideways); from 768 a sticky first column. `/compare` without ids reopens the list this device keeps |
| `GET /api/search/suggest?q=&locale=` | `{ suggestions: { label, href, hint?, image?, priceIqd?, kindLabel? }[], total? }` ≤ 8 rows — the service's rows unchanged, product rows add the art key, the price (left out while sold out) and the kind label; `total` = what `/search?q=` lists for the same words, whenever the query is long enough to search. 120/min per IP → 429; `Cache-Control: public, max-age=60` |

## The list (`components/ListingView.tsx`)

- From 1024: a sticky 264px filter sidebar at the inline start (it scrolls on its own when taller than the window)
  beside the results; the grid is 2 → 3 (768) → 3 beside the sidebar → 4 (1280). Below 1024 the filters are the kit's
  `Sheet` (bottom on phones, side from 768) with «امسح الكل» (ghost) and the primary «اعرض 24 منتجاً» (live count).
- Toolbar: the count; from 1024 also «المتوفر أولاً، ثم «قريباً»، ثم ما نفد» while the sort is «المقترَح»; the sort
  menu («الترتيب: المقترَح» from 1024, «الترتيب» below, the explanation in its caption); below 1024 «الفلاتر (2)».
  Once the toolbar has scrolled away (below 1024) a pill «الفلاتر | الترتيب» floats above the tab bar — solid paper
  with the float shadow, because the header and the tab bar are the viewport's two live glass panes. While it (or the
  compare tray) shows, the page's bottom scroll padding grows by the dock's measured height (`--catalog-dock` on the
  root, set by `CatalogDock`), so focus never lands under it. The tray keeps «قارن (3)» whole: overlapping
  thumbnails, and where the words do not fit one line (English and Sorani on phones) «قارن الآن» and its × take a
  second line together.
- The filter form shows a group of six or fewer short values (≤ 20 characters) as chips holding native checkboxes or
  radios — in the sheet and the no-script panel, as in prototype A's sheet; the 264px sidebar keeps rows, where two
  chips with a dot and a count do not fit side by side.
- Filters (`components/FilterPanel.tsx`) are ONE native GET form used three ways (sidebar, sheet, no script):
  التوفر (switch «المتوفر الآن», «تخفيض حقيقي»), المنصة (dots), القسم, يعمل مع, السعر (two fields + ready ranges),
  دعم العربية, نوع النسخة — 44px rows, each value with how many products choosing it gives; a group with one option and
  nothing chosen is hidden, and the group the page's chip row offers is not repeated (its value rides along as a hidden
  field). With script every change navigates at once; without it the form submits (sort included).
- Active filters are removable link chips above the grid; «اعرض المزيد» is the kit's `ShowMore` («عرضنا 24 من 42
  منتجاً», a bar, «اعرض 18 منتجاً آخر», «لا يوجد المزيد لعرضه»).
- Zero results with filters (`components/ZeroResults.tsx`): «لا منتجات بهذه الفلاتر», the primary «امسح الفلاتر», the
  filter whose removal alone shows products (with its count), then products of the scope in stock.
- Cards are the kit's `ProductCard` (hearts on: the loader reads which of the page's products are in the shopper's
  wishlist, `wishedOf` in `list.server.ts`; null → no hearts rather than wrong ones). The first card of a list is the
  page's one priority picture (it is the largest paint, measured on the hubs too); the band's hardware is decorative
  and never preloaded.
- Every «وصل حديثاً» shelf (empty department, search with no match, search filters with no match) passes its cards
  through `arrivalsShelf` (`list.server.ts`): no card repeats «جديد» inside a shelf that says it (v2 §4.7).
- Prices in the URL are read as a shopper types them (`readListingQuery` → `parsePriceInput`): the no-script form sends
  «١٠٠٬٠٠٠» as typed, and it filters; links write Western digits back.
- Offline, a tap that changes the list (a chip, «اعرض المزيد», a removable filter, the zero-result recovery) is held
  (`useOfflineHold` in `components/use-listing-nav.ts`, a click-capture handler on each list page): the list stays,
  the toolbar says «لا يوجد اتصال. نحدّث النتائج حين يعود.», and the last held tap is followed when the connection
  is back. Links to other pages navigate as usual.

## How it works (unchanged from 1.0)

- **Researched platforms** (`listing.server.ts`): own `platform_id`, else `attributes.game.platforms`, else verified /
  partial compatibility — the multi-platform games and headsets are on every hub they are researched for.
- **One universe statement** per request; filters, disjunctive facet counts, sorts and the keyset cursor run in memory.
- **«اعرض المزيد» is cumulative**: `?cursor=X` returns the list from the start through the page after X (≤ 240), so
  reload and Back keep what was shown, and the same link works without script.
- **Sort «المقترَح»** (`featured`): can be bought now › coming soon (soonest first) › sold out; on platform hubs the
  platform's own consoles lead (data owner, stage 2).
- **Search** (`search.server.ts`): synonym concepts across ar/en/ckb, trigram typo correction when nothing matched,
  exact-name-first ranking; anonymous `search_query_stats` (first page of a plain search, never bots).
- **Recent searches**: this device only, the shopper's own switch; without a choice they follow the personalisation
  consent; switching off deletes them. `useRecentSearches` is also used by the shell's search field.

## States (spec §6.17)

| State | Hubs / search results | Search start / zero | Compare |
|---|---|---|---|
| Loading | results stay usable, `aria-busy`, dimmed; chips and inputs show the new state at once; cards that stayed slide, new ones grow in from the engine's bubble scale (.94, `use-flip.ts`, full motion tier only) | SSR | SSR |
| Empty | department without products: EmptyState + «وصل حديثاً» | zero: EmptyState, «هل تقصد:», tiles, «وصل حديثاً» | EmptyState «لا شيء للمقارنة بعد» (never beside a saved list) |
| Zero with filters | «لا منتجات بهذه الفلاتر» + «امسح الفلاتر» + nearest filter + picks | — | «لا فروق…» with differences only |
| API failure | the loader → the shell's error panel; the used shelf alone → ErrorState in place, the page stands | suggest endpoint → no list | — |
| Offline | the shell's banner; the filter controls rest with «لا يوجد اتصال. نحدّث النتائج حين يعود.»; chips, «اعرض المزيد» and filter chips are held and followed on reconnect (the list never gives way to the error page) | banner; suggestion chips held the same way | banner |
| Sold out / soon | the card states (kit) | — | «نفد حالياً» / «قريباً» under the price, no add button |
| Demo | the cards' and the strip's own marking | — | — |
| No script | GET form (details on phones, the sidebar from 1024), link chips, link «اعرض المزيد» | the field is a GET form | the empty state; the table works |

## Exports other areas use (signatures kept)

- `CompareToggle` (`catalog/CompareToggle.tsx`): `product: { id, kind, name, image? }` (image new, optional — it feeds
  the compare tray's thumbnail), `size`, `showLink`, `className`. v2: a 44px ghost text button «قارن» / «في المقارنة».
- `useCompare`, `compareHref`, `addToCompare` (now also `{ name?, image? }`), `syncCompare` (`items?`),
  `rememberCompareThumbs`, `useCompareThumbs`, `readCompareThumbs` (`catalog/compare-client.ts`), and
  `compareAfterAdd(outcome, before, id)` — where «افتح المقارنة» goes after an add (another kind: the new list alone;
  `/compare` compares the first product's kind, so "old ids + new" showed the old list and undid the new one).
- `useRecentSearches` (`components/recent-searches.ts`) — the shell's search field.
- `searchProducts(db, locale, q, opts)` and `suggestSearch` stay the data owner's.

## Verify

`npx vitest run tests/catalog-listing.test.ts tests/search.test.ts` (64) · `node scripts/lint-design.mjs --strict
app/routes/storefront/catalog app/routes/api/search-suggest.ts` (0) · flows: `node <scratch>/work/pages-P2-catalog/flow.mjs`
(chips, sheet, filter at once, Back, show more + reload + Back, every sort, zero results and the way out, sidebar
row, no-script form, the floating pill) · census / focus walk: `<scratch>/work/pages-P2-catalog/tools/` · screenshots
`<scratch>/ux/after/P2-catalog/` (`<page>-<width>-<theme>-<lang>.png`). Review (2026-11-12): its own tools and
screens in `<scratch>/work/pages-P2-catalog-review/` (matrix, flows with and without script, offline, compare,
focus walk, rendered contrast, reflow at 320 and 200%) and `<scratch>/ux/after/P2-catalog-review/`.

## Known gaps

- Cards carry no compare toggle yet: the kit's `ProductCard` has no slot for it (requested). Comparing starts on the
  product page, from `/compare`'s same-kind suggestions, and the tray brings a saved list back.
- The desktop model switcher shows the database's full model names (no short names in the data yet).
- «ابحث عنها كما كتبتها» (spec §6.4) is not offered: the search corrects a spelling only when it found nothing, so the
  link would lead to the same corrected page. It needs an "as typed" option in the search service.
- Facets the spec lists but the data does not have yet: condition (new / used + grade), storage. Price: fields + ready
  ranges, no slider.
- On phones a comparison of three or four scrolls sideways (`overflow-x: auto` with `overflow-y: clip`); the product
  headers stay sticky in Chromium (checked in Edge 157). A browser that does not allow clip beside a scrolling axis
  scrolls the headers away with the rows — not checked on Safari.
- Long lists are not virtualised (spec §6.3 "about 40 cards"): «اعرض المزيد» grows the list to at most 240 cards, then
  shows a page on its own; the store lists about a hundred products today.
- The kit's sideways chip rows do not bring a chip focused with Tab fully into view in RTL; the catalog's rows do it
  themselves (`keepInView` in `components/Hub.tsx`; on the snapping device-tile row it aligns the tile to the row's
  start, or the snap pulled it back half off-screen) until the kit does (requested). The kit's `ShelfRail` (the
  «وصل حديثاً» shelves on phones) still leaves a focused card off-screen — the kit's to fix.
- Sorani copy needs a native reader. Chromium only.

## The content module on the pages (wave G wiring, 2026-11-12; `tests/storefront-wiring.test.ts`)

- **Filter order** (admin 17.03): `filterOrderOf(db, categoryId)` (`list.server.ts`) → the groups to offer, in order — the
  category's own arrangement, else the default one; **null while nothing is arranged** (the panel keeps its own order:
  availability, platform, category, device, price, Arabic, format). `FilterPanel order` / `panelOrder`: availability stands
  where its first named part is, with only the named parts; a group left out is not offered, but a value a link brought still
  filters (its chip removes it) and rides along as a hidden field. Category, platform hub and search all apply it.
- **Category meta** (17.04, `categoryCmsOf`): the title, description and noindex staff wrote in `categories.seo` win.
- **Cost:** the category loader reads `categoryCmsOf` beside the list (it needs only the slug), then the filter order, the
  banners, the picks or arrivals and the shopper in ONE round; search reads its filter order beside the search (review
  2026-11-12: the CMS reads had added two to three sequential round trips).
- **Banners** at the top of a category (`category_top` + the category's own, `getStoreBanners`).
- **Redirects** before both category 404s (`redirectIfMoved`).
- **Kit requests applied:** «قارن» in the card's `compare` slot on console and handheld cards (kind "console"; the tray shows their
  thumbnails); the sort's explanation as the «المقترَح» row's radio `hint`; `use-flip.ts` takes `bubble` from `~/motion`.
- Known: in a grid row that mixes a card with the compare slot and one without, the price rows do not line up (the slot sits
  under the pinned foot) — asked of the kit.
