# Catalog area — hubs, search, compare

Owner: catalog area. Design System v2 (`design-v2-spec.md`) §6.2 platform hub, §6.3 category hub and listing behaviour,
§6.4 search, §6.5 compare; brief §3.3, §3.5, §3.6.
Files: `app/routes/storefront/catalog/**`, `app/routes/api/search-suggest.ts`, `app/i18n/messages/catalog.ts`,
`tests/catalog-listing.test.ts`, `tests/search.test.ts`. The read layer (`app/server/services/catalog/**`,
`app/server/services/search.server.ts`) belongs to the data owner: changes there are requests (wave B, on the shell's
request and the lead's say: `artKey` on the navigation's device links in `taxonomy.server.ts`, and the optional
`NavLink.artKey` in `types.ts` — nothing else). v2.1 «Clay & Glass»: the section at the end.

## Routes

| Path | What |
|---|---|
| `/platform/:platform` | v2.1 (client note 4): the band — glossy platform-colour glass (`Band kind="platform"`: the platform's colour with its specular edge in light, its deep colour glass with a rim light in dark), the device glyph on a clay disc beside the white h1, «42 منتجاً», the hardware breaking out of the top on its contact shadow, the platform's light on the floor around it (`.glow` in the platform's `data-gel`). Phones: the band holds the name and the count only (at least 112px; the hardware rises 10px, into the air under the header) and the delivery line is the kit's quiet line with its truck right under it (`Note variant="line"`, `.catalog-band-note`); 768–1023: the line in the band; from 1024 the shell's strip says it (136px band). At 320 (400% zoom) the glyph disc gives the name its room. Then "everything about the device" (`DeviceRow`: the before's soft device tiles → `/device/<model>`, short names, `#catalog-devices`), the departments as link chips with kind icons and counts, the list, the platform's used units (≥ 3). The first cards' pictures are on the first phone screen (390 × 844: card top 581px, tab bar 770px; 360 × 760: 594px, tab bar 686px). Unknown or inactive → 404. Sibling hubs push sideways in platform order (`handle`) |
| `/c/:category` | the glass head (breadcrumbs from 768; the department's kind icon on a clay tile, h1, count · delivery line, the department's photo in a warm well from 768; a one-platform department in its platform's light), one chip row with icons (platforms with their device glyphs in their colours when the list has ≥ 2; else sub-departments with kind icons; else devices), the list, then the row of soft device tiles its products fit (full names). Empty department → EmptyState on the soft card (the kind icon large) «لا منتجات في هذا القسم بعد» + «ابحث في المتجر» + «وصل حديثاً». The `used` kind → 302 `/used` |
| `/search` | start: the glass head (h1, the field — focused from 1024 only — and «اقتراحات» chips: the platforms' device models with their device glyphs — names, never "most searched"), recent searches (this device, consent-aware) and the «إعدادات البحث» row, the four compact platform tiles over a soft light and the departments as icon tiles (`CategoryTile icon`) with the hubs' counts, the devices area's shelves |
| `/search?q=` | the listing template under the glass head (the search glass on its tile), h1 «نتائج «q»»; a corrected spelling shows its results under the corrected words with «بحثت عن «q»، ولم نجد شيئاً بهذه الكتابة…» (an info icon); «اذهب مباشرة إلى» as small clay keys with the hub's icon (one sideways row on phones); department chips with kind icons. Nothing matches (v2.1, friendlier) → EmptyState on the soft card over a soft light: the search glass large on its disc, «لم نجد نتائج لـ «q»», what to try, «هل تقصد:» (the shorter queries that find something, chips with counts) and «جرّب أحد هذه:» (six device names, chips), the clay key «العودة إلى الرئيسية»; then platform and department tiles + «وصل حديثاً» (8 arrivals, no «جديد») — no sort, no filters |
| `/compare?ids=a&ids=b` | ≤ 4 of one kind, under the glass head (the scales on their tile, the intro); the table raised like the soft cards but solid paper (its pinned heads and names' column must not be see-through); the same-kind suggestions are soft cards; nothing to compare → EmptyState on the soft card (the scales large). Product headers stay under the header while the rows scroll (96px well with the 44×44 «أزل» right beside it, name, price with the neutral `CardAddButton` right after it — never pushed to the column's far end, where they sat next to the neighbouring product). The key never shrinks and never leaves its own cell: in a narrow column (four products at 768–800, a 360 phone) the well gives way (66px at 768) — it had overhung the column edge and the next header cell covered half of it. Names clamp to two lines with the card title's treatment (`CompareName`: a Latin name on an Arabic page is one left-to-right line at the start edge, so the clamp cuts its logical end; the ellipsis gets 1em of end padding to hang in, offset by a negative margin — Chromium aligns an end-aligned clamped line without its ellipsis and clipped it); the corner offers «أضف منتجاً (حتى 4)» (→ the same-kind suggestions, whose «قارن» key wraps under them at 320px); «اعرض الفروق فقط» beside its label, from two products; «غير موثّق» where the research says nothing. Phones: two product columns, each spec's name a full-width row above its values (three or four products scroll sideways); from 768 a sticky first column. `/compare` without ids reopens the list this device keeps |
| `GET /api/search/suggest?q=&locale=` | `{ suggestions: { label, href, hint?, image?, priceIqd?, kindLabel?, qualifier? }[], total? }` ≤ 8 rows — the service's rows unchanged, product rows add the art key, the price (left out while sold out), the kind label and (v2.1, for the shell) the service's `qualifier` — «نسخة الأقراص», the words a Latin title leaves out, printed on the row's meta line; `total` = what `/search?q=` lists for the same words, whenever the query is long enough to search. 120/min per IP → 429; `Cache-Control: public, max-age=60` |

## The list (`components/ListingView.tsx`)

- From 1024: a sticky 264px filter sidebar at the inline start (it scrolls on its own when taller than the window)
  beside the results; the grid is 2 → 3 (768) → 3 beside the sidebar → 4 (1280). Below 1024 the filters are the kit's
  `Sheet` (bottom on phones, side from 768) with «امسح الكل» (ghost) and the primary «اعرض 24 منتجاً» (live count).
- Toolbar: the count; from 1024 also «المتوفر أولاً، ثم «قريباً»، ثم ما نفد» while the sort is «المقترَح»; the sort
  menu («الترتيب: المقترَح» from 1024, «الترتيب» below, the explanation in its caption); below 1024 «الفلاتر (2)».
  Once the toolbar has scrolled away (below 1024) a pill «الفلاتر | الترتيب» floats above the tab bar — solid paper
  with the float shadow, because the header and the tab bar are the viewport's two live glass panes. While it (or the
  compare tray) shows, the page's bottom scroll padding is the bars + the dock's inset (`--catalog-dock-inset`: 12px on
  phones, 24px from 1024, where the tray floats at the bottom end) + its measured height (`--catalog-dock`, set by
  `CatalogDock`) + 12px of air, so focus never lands under it (92px at 1024–1440; it was 68 and a focused card key
  ended 12px under the tray — QA 2026-11-12). The tray keeps «قارن (3)» whole: overlapping
  thumbnails, and where the words do not fit one line (English and Sorani on phones) «قارن الآن» and its × take a
  second line together.
- The filter form shows a group of six or fewer short values (≤ 20 characters) as chips holding native checkboxes or
  radios — in the sheet and the no-script panel, as in prototype A's sheet; the 264px sidebar keeps rows, where two
  chips with a dot and a count do not fit side by side. v2.1 (polished sheet and sidebar): each group's title carries
  its icon on a small clay disc (التوفر package, المنصة controller, القسم grid, يعمل مع plugs, السعر tag, دعم العربية
  translate, نوع النسخة disc); a department carries its kind icon, a platform its device glyph in its colour, a device
  its own picture on a 32px warm well; every count is a quiet pill at the row's end.
- v2.1 motion: each card below the fold fades up as it first arrives (`data-reveal` on the grid's items — rows come in
  as the shopper scrolls; nothing on the first screen moves; skipped under reduced motion and the lite tier); the used
  shelf, «وصل حديثاً» and the browse sections fade up the same way; FLIP and the bubble still move the cards when the
  results change.
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
| Empty | department without products (`/c/parts` in the demo data): EmptyState + «وصل حديثاً» | zero: the soft card with «هل تقصد:» and «جرّب أحد هذه:» chips and «العودة إلى الرئيسية», tiles, «وصل حديثاً» | EmptyState «لا شيء للمقارنة بعد» (never beside a saved list) — v2.1: every stack EmptyState here (and «لا منتجات بهذه الفلاتر») sits on the kit's soft card (`panel`) with its icon large on the red-tint disc (the department's kind icon, the search glass, the funnel, the scales; the brief's "icon" for a friendlier zero page) |
| Zero with filters | «لا منتجات بهذه الفلاتر» + «امسح الفلاتر» (with ×) + nearest filter under it, on the soft card + picks | — | «لا فروق…» with differences only |
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

v2.1 (wave B, 2026-11-13): `npx vitest run tests/catalog-listing.test.ts tests/search.test.ts` (69) · strict lint (0) ·
the tools in `<scratch>/fb1/work/catalog/`: `flow.mjs` (51 checks: the v2 flows plus the device row, its arrows and a
tile opening its hub, search ar/en/ckb with a typo and a synonym, nothing found and its way out, the header's
suggestions with the qualifier, compare four), `states.mjs` (13: empty department, offline hold and resume, busy,
no script, reduced motion, reveal, card states, compare empty), `focus.mjs` (keyboard walk, 10 pages × 2 themes),
`mirror.mjs` (/en mirrors /ar), `census.mjs` (rendered type), `overflow.mjs`, `shots.mjs` (the matrix: 10 templates at
360/390/768/1024/1440 light and dark in Arabic + 390/1440 English and Sorani) · screenshots `<scratch>/fb1/shots/catalog/`
(`m1/` the matrix, `compare/` the client's before · v2 · now).

Before (v2): `npx vitest run tests/catalog-listing.test.ts tests/search.test.ts` (66) · `node scripts/lint-design.mjs --strict
app/routes/storefront/catalog app/routes/api/search-suggest.ts` (0) · flows: `node <scratch>/work/pages-P2-catalog/flow.mjs`
(chips, sheet, filter at once, Back, show more + reload + Back, every sort, zero results and the way out, sidebar
row, no-script form, the floating pill) · census / focus walk: `<scratch>/work/pages-P2-catalog/tools/` · screenshots
`<scratch>/ux/after/P2-catalog/` (`<page>-<width>-<theme>-<lang>.png`). Review (2026-11-12): its own tools and
screens in `<scratch>/work/pages-P2-catalog-review/` (matrix, flows with and without script, offline, compare,
focus walk, rendered contrast, reflow at 320 and 200%) and `<scratch>/ux/after/P2-catalog-review/`.

## Known gaps

- Console and handheld cards carry «قارن» in the kit card's compare slot (wave G); other kinds compare on their page.
- The kit's `Chip` has no icon prop: the catalog draws a chip's kind icon inside its words (`ChipLabel` in
  `components/Hub.tsx` — after the words in a Latin label's left-to-right island on an Arabic page, so it still stands at
  the chip's start); asked of the kit.
- The reveal arrives card by card as rows scroll in; cards of one row arrive together (the engine staggers only the
  children of one element) — asked of the motion owner.
- Opaque catalogue photos keep the kit's white plate in dark wells: the PS5 (2020) and PS5 Digital (2020) device tiles
  and filter thumbnails (`playstation-5--1`), and box art (by design). Cut-outs are the art owner's.
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

## QA fixes (2026-11-12, after the five-auditor matrix)

| Defect | Fix | Measured after |
|---|---|---|
| Compare names cut at their start on Arabic pages («…e Legend of Zelda –») | `CompareName` (latinName + BidiText, isolate) and an end padding for the ellipsis (catalog.css) | «Nintendo Switch 2 – / The Legend of Zelda…», «… / Nintendo Switch…» at 390 and 768, ar; en unchanged (start-aligned) |
| «أزل» half covered by the next header cell at 768 (four products) | the well flexes (`flex: 0 1 96px`), the key `flex: none` | every key inside its own cell, hit share 1.00 at 360/390/768/800/900/1023/1024/1440, ar and en, 2 and 4 products (`compare-probe.mjs`) |
| Icon (magnifying glass, scales) in the stack empty states | no `icon`: the kit's mascot (search zero, compare empty, filters zero) | the mascot in all three, ar/en, 390/1440 |
| Focused card under the compare tray at 1024/1440 | `--catalog-dock-inset` (24px from 1024) in the scroll padding, +12px air | padding 92px; 0 of 545 Tab stops under the dock (/platform/xbox, /search, /c/games, /platform/nintendo at 1024–1440; 390, 768) |

Known after the fixes: the other clamped Latin names set with `latinName` (the kit's `ProductCard` and `UsedUnitCard`
titles, the shell's mega-menu feature) have the same Chromium ellipsis clip the compare names had — asked of their owners. Tools: `…/scratchpad/work/Q-fix-pages-browse/`
(compare-probe, traycover, empty-shots, clamp); screens: `…/scratchpad/ux/after/Q-fix-pages-browse/`.

## Design v2.1 «Clay & Glass» (wave B, 2026-11-13 — client note 4: "after is better, the before's icons looked better: improve the card look and the icons")

| What | How |
|---|---|
| The platform band | Glossy platform-colour glass (the kit's `.band--platform`), the device glyph on a clay disc beside the white h1, the count, the delivery line with a truck icon below 1024 (the shell's strip says it from there), the hardware larger and breaking out of the top on its contact shadow (`Band contact`), the band's sheen moved behind it (`--light-x`), and the platform's light on the floor around the band (`.glow glow--wide glow--strong` in the platform's `data-gel`; the light's box keeps to the band's width — wider, it reached past the viewport at 768–1024 and scrolled the page sideways) |
| The device row back | `DeviceRow`: «كل شيء عن أجهزة PlayStation» right under the band — the kit's raised category tiles with the device pictures on the warm well (the before's soft tiles), short names on a platform hub (the full name as the tile's title), one sideways row at every width (3.3 tiles on phones, 5.4 from 768, 116/124px tiles from 1024 where seven fit; two clay arrows from 1024 when a row does not fit — the handhelds' eleven), each picture the shared element `device-image:<slug>` into the device hub. Replaces v2's in-grid phone row, the after-list grid and the band's desktop switcher (the same links three times) |
| Chips with icons | `ChipLabel`: a department's kind icon (`kindIconOf`: the navigation's kind, else the slug's words), a platform's device glyph in its colour; «الكل» the grid; a chosen chip shows the kit's check in its place |
| The glass head | `TitleRow` (category hubs, search results and start, compare): a frosted card (`surface--glass`, one per page) over a soft light, the reference's icon tile (a clay square, the red line icon), the h1, the count and the delivery line, the department's photo in a warm well from 768; anything the page adds runs across the card under them |
| The list | each card below the fold fades up as it arrives (`data-reveal`); the filter sheet and sidebar: group titles with icons on small clay discs, kind icons, device pictures on 32px wells, counts as quiet pills |
| Nothing found | the soft card (`EmptyState panel`) over a soft light: the search glass large on its disc, the words, «هل تقصد:» and «جرّب أحد هذه:» chips, the clay key «العودة إلى الرئيسية»; then the platform tiles over a soft light and the departments as icon tiles. The filter-zero, empty-department and empty-compare states take the same card with their own icon (funnel, kind icon, scales) |
| «ابحث عنها كما كتبتها» | the corrected-spelling line now links to `?q=…&typed=1` (the search service's `asTyped`): the words as typed, never corrected, kept through filters, sorts and «اعرض المزيد», not counted as a new search |
| Offline hold | the root's `OfflineNavigationGuard` (app/root.tsx, window capture) cancels every link offline before a page sees it, so since the QA round the hold never held and the toolbar's «نحدّث النتائج حين يعود» was not kept: an offline list change is now held whether or not the guard cancelled it first (`useOfflineHold`) |
| For the shell | `GET /api/search/suggest` rows carry the service's `qualifier`; the navigation's device links carry `artKey` (`device_models.art_key`, `NavLink.artKey` in `services/catalog/types.ts`) — the mega menu shows the device photos |

### Review (wave B, 2026-11-13)

| Defect (found with the reviewer's own shots and probes) | Fix | After |
|---|---|---|
| Phones: the band's two-line delivery line ran into the wide hardware — the Switch 2 and the Steam Deck — at 360–390 in ar, en and ckb (the copy box is 72% of the band, the hardware 38%) | the band holds the name and the count; the line is the kit's quiet line (`Note variant="line" icon="truck"`) right under the band, as its caption; in the band again from 768 (one line beside the hardware), the shell's strip from 1024 | no copy on hardware at 320–1440 in the three languages; the four hubs read like the reference's glossy platform tiles |
| Phones: the PS5 rose 30px above the band, across the header's foot, against the search field (360/390, scroll 0) | it rises 10px, into the 12px of air under the header | hardware top 86px, header foot 84px |
| 320 (400% zoom): «PlayStati / on», «دەستییە / کان» — the h1 broke inside its words beside the disc | the disc is dropped under 360px | whole words at 320 |
| The device row's note at 13px on phones (G7: the smallest text on the page) | the kit's section-head reason size, 14px, at every width | one line at 360 |
| Compare: the facts at 14px, the phone spec names and the «غير موثّق» footnote at 13px (G7: facts are reading text, ≥ 16px on phones) | the values take the reading role (16px / 1.75) — 14px only for a tablet's three or four narrow columns (768–1023); the phone names 14px strong; the footnote is the kit's quiet line with its icon | no running Arabic under 14px; the facts 16px on phones and from 1024 |
| The corrected-spelling line hand-built beside the kit's notes (G5: one pattern for side information) | the kit's `Note variant="line" icon="info"`, «ابحث عنها كما كتبتها» as its action on its own line | same look; `.catalog-typed` removed |
| The floating «الفلاتر · الترتيب» pill: words without the icons the toolbar keys carry | the toolbar keys' icons (sliders, sort) | — |

Tests: `tests/catalog-listing.test.ts` «the platform band on phones» (3: the line once per width range, after the band;
the phone rise ≤ the page's 12px top padding; the 320 rule). Products on the first phone screen: 390 × 844 card top
581px (the builder's 574 — the line under the band costs 7px), 360 × 760 594px (565; the line takes two lines there).
Tools and screens: `<scratch>/fb1/work/catalog-review/`, `<scratch>/fb1/shots/catalog-review/`.

Known after the review:
- ~~From 1024 the device row sits above the list as on the before, so laptops show no product on the first screen
  (first card top: 797px at 1024 × 768, 787px at 1280 × 720 and 1366 × 768, 787px at 1440 × 900 — v2's band switcher put
  them at about 470px). A compact device strip from 1024 (photo beside the short name, one row) would lift the list by
  about 110px — a layout decision for the lead.~~ — the lead decided (decision 3); done in fix-browse, below.
- From a scrolled list at 390 (mobile emulation), opening a card throws an uncaught `InvalidStateError: Transition was
  aborted because of invalid state. Viewport size changed` — the same on `/used`, also under reduced motion, never
  without mobile emulation, and not from a device hub scrolled 1,200px; the view transition's promise is not caught
  (motion engine / React), not the catalog's.

### Fix-browse (wave C, 2026-11-13)

The auditors' defects for the area, fixed (tools `<scratch>/fb1/work/C-fix-browse/`, screens `<scratch>/fb1/shots/C-fix-browse/`):

| Defect | Fix | After |
|---|---|---|
| Lead decision 3 not built: the restored device row (126px photo tiles under a two-line head) put the first product at ~790px on every laptop — none on a 1024 × 768 or 1366 × 768 first screen | from 1024 the row is compact (`catalog.css`): the title and its note on one line (the head's box is `display: contents`, so its text and arrows take their places in the row's grid), 56px clay pills (`--key-face`, `--e-disc`) with the device's picture in a 40px warm circle beside the short name, the two arrows at the row's end; the band is 112px (it was 136: it holds the name and the count from 1024) | first card top 622px at 1024 × 768, 1280 × 720, 1366 × 768 and 1440 × 900 on PlayStation and Xbox; 574px on Nintendo and the handhelds (chips on one row); 500px on category hubs (`layout.mjs`); phones unchanged (tiles) |
| Compare on phones: three or four products showed as two columns that filled the card (the others only by an unannounced sideways scroll); the head did not say how many | the head says «تقارن 3 منتجات من أجهزة الألعاب» (`compare.comparing`, the intro keeps the rule only); 44% columns that snap (`scroll-snap-type: inline mandatory`), so the next one peeks 39–43px; above the table a navigator «تعرض 1–2 من 3» with two clay arrows that move it a column at a time (`CompareNavigator`; hidden from 768) | `cmpnav.mjs` 29/29 in ar 390 (3), en 360 (4), ckb 390 (4) and ar 768 (no navigator) |
| Zero results: «جرّب أحد هذه» was a sideways rail inside the centred card — the second chip cut by the card's edge | `.chips.catalog-chips--panel` wraps, centred, at every width; four chips on phones (a device name is a chip per line there) | no clipped chip at 360 / 390 in ar, en, ckb |
| A sold-out product's suggestion row had no price and no reason | `GET /api/search/suggest` adds `soldOut: true` (no price) to such rows | the shell renders «نفد حالياً» in the price's place — requested |
| A corrected search said the index's folded word: «نتائج «nintendo»», «هل تقصد nintendo» | `list.server.ts displaySpelling()`: each corrected word as the first of the platforms' names, the hubs offered and the products found writes it; the page (`corrected` in the loader data) and the suggestion row use it; links keep the folded words | «نتائج «Nintendo»», «هل تقصد PlayStation» in ar, en, ckb |
| The hubs' phone notes at 14px / 1.5 (G7) | below 768 `.catalog-title__line` and `.catalog-devices__note` take `--type-read` (16px / 1.75) | — |

Tests (written failing first where they guard behaviour): `tests/search.test.ts` — the typo row says «PlayStation» /
«Nintendo» with folded hrefs (the assertion `label: "playstation"` changed on purpose: the label is now the catalogue's
spelling), a sold-out row carries `soldOut: true`; `tests/catalog-listing.test.ts` — the corrected search's `corrected`
in three languages, compare's head and navigator in the server's markup (ar, en, ckb; none for two products), and the
stylesheet's contracts (the compact row and band from 1024, the phone notes, the panel chips, compare's columns).
