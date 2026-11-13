# Product area

Owner: product. The product page `/p/:slug` and the quick look (brief §3.7–3.8; Design System v2 spec §6.7, §6.9,
§6.17, §7, §9). Contract row: CONTRACTS.md §3 "product". Rebuilt for Design System v2 on 2026-11-12 (stage 3, P3);
**rebuilt on the before's arrangement for v2.1 "Clay & Glass" on 2026-11-13** (client note 5 — section "v2.1" below;
where it and the v2 text further down disagree, v2.1 wins).

## Files

| File | What |
|---|---|
| `app/routes/storefront/product/product.tsx` | the page: loader, meta (`shellMeta`, `og:image` = `productShareImage`), `handle.shell.tabBar = false`, `shouldRevalidate` (a change of `?v=` only skips the loader), the v2.1 layout (stage card, information column at the inline start from 1024, the brand line `BrandLine`, the fact line), the phone buy bar inside the shell's `<TaskBar>`, JSON-LD |
| `…/components/StageCard.tsx` | v2.1: the kit's `Gallery` as a soft stage card — the round clay keys over it (back: real history Back, else the category; share), the sliding ring of the chosen thumbnail (kit `useSlidingIndicator` on the tray), the step direction of a picture change; pure `stageStep`, `stageGel` (the light's colour), `stageBack` |
| `…/components/BuyStrip.tsx` | v2.1: the phone / tablet bar — the kit's `BuyControls` (clay tray + glossy red «أضف إلى السلة»), «✓ في السلة» + «عرض السلة (n)» after an add (it takes the focus the swapped key had: `handoff.ts`), the kit's `BuyBar bare` words for sold out / coming soon, a failure or offline line above; pure `stripState` |
| `…/product/handoff.ts` | QA wave C: `useFocusHandoff(swapped)` → `{ area, arm }` — when a confirmed add swaps «أضف إلى السلة» for «عرض السلة (n)» (the bar, the quick look's foot), the new key (`data-focus-target`) takes the focus the old one had, without scrolling; never when focus had moved on. Pure core `focusHandoff()`, `FOCUS_TARGET` |
| `…/product/QuickPreview.tsx` | `<QuickPreview slug name card? image? open onClose />` and `fetchPreview(slug, locale, signal?)` — the quick look (export signature unchanged); its foot hands focus to «عرض السلة (n)» after an add, so it stays inside the modal sheet |
| `…/product/preview.ts` | `GET /api/product-preview/:slug?locale=` → `{ ok, product: ProductPreview, i18n }` (404 `{ ok:false, code:"not_found", i18n }`) |
| `…/product/useVariant.ts` | `?v=` handling: `shownDefault`, `variantFor`, `searchFor`, `onlyVariantChanged`, `useVariantInUrl` |
| `…/product/text.ts` | the researched text as the page shows it: `factParts` / `factLine` / `factRow` (+ `FactRow`), `claimsPreorder`, `withoutPreorder`, `proseWithoutPreorder`, `keepTokens` (a name's protected tokens never break — a short token with a digit, a capital or «+», or a unit after a number; the small words of a sentence stay breakable), `isLongName` / `LONG_NAME_CHARS` (the h1 one step down on phones) |
| `…/product/jsonld.ts`, `i18n.tsx`, `product.css` | schema.org data; the strings hook (`useProductT`, `<ProductMessages>`); the stage card (light, tray, ring, keys, picture slide), the 5 + 7 grid with the sticky gallery, the price block's two sides, the fact line, the notes, the bar's slide-in, the reading pairs, the reduced-motion and more-contrast rules |
| `…/components/PriceBlock.tsx` | v2.1: the before's arrangement — price xl (Kufam) with the demo tag and a real saving at the start, the delivery fee note and the stock state (or the release day) at the end, the reason / offline / lifecycle sentences under both; `struckPrice`, `priceLook` (sold out = muted, no saving), `priceSide`, `useDemoStore` |
| `…/components/PriceBlock.css` | the price block's own layout, imported by the component — the quick look draws the block over listings, the home and search, where `product.css` is not loaded (v2.1 review) |
| `…/components/Facts.tsx` | v2.1: `SideNotes` — the side information as the kit's `<Note>`s under «التوصيل والدفع والإرجاع» (payment + transfer rule, delivery + guest checkout or the code fact, returns, warranty); `paymentMethods`, `offersTransfer`, `methodsList`, `sentenceStart`, `ASK_HREF` |
| `…/components/VariantPicker.tsx` | option cards with prices (figure and «د.ع» never split) · swatches · chips (`pickerLook`); no-script GET form — for swatches a `<noscript>` group of native radio chips (the swatches hide under `noscript:`) |
| `…/components/Actions.tsx` | `SecondaryActions` (WishlistKey · CompareToggle · `ShareKey`, a ghost key; `shareFrom="lg"`: the stage carries share below 1024), `useShare` |
| `…/components/Details.tsx` | `Section`, `BeforeYouOrder` (v2.1: the kit's warning `Note`), `Highlights` (v2.1: a checked list, `type-read`), `About` (65ch, `type-read`), `GameFacts` (the key-card / code sentence as an info `Note`), `Rows` (the values are facts: `.pp-fact`, 16 / 1.75 below 1024, 14 from 1024), `Specs` (+ `sourceLine` — that line a `.pp-fact` too; the sources as citations: the title link over its publisher, each in its own language and direction through the devices area's `SourceText`), `InTheBox` (+ `boxPhoto`) |
| `…/components/Slots.tsx` | cross-area pieces: `CompatibilitySlot` (+ `compatRows`), `DeviceHubSlot`, `RecommendationsSlot`; `alternativesPath` (where «شاهد بدائل» leads) |
| `…/components/SetContents.tsx`, `MixedText.tsx`, `Reviews.tsx` | store-set rows (each opens the quick look); bracket-safe Latin isolation (comma thousands are one run; a name goes on across a spaced joiner, «32GB / 1TB»; protected tokens kept together); reviews only when real |
| `app/server/services/catalog/product.server.ts`, `product-types.ts` | read layer (owner: data, D) — `getProductDetail`, `ProductDetail`, `VariantDetail`, `ProductPreview`, `galleryFor`, `selectVariant` |
| `app/i18n/messages/product.ts` | the "product" namespace (ar source, en, ckb) |
| `tests/product.test.ts` | 69 tests on the demo catalogue + a test world (server renders of the version picker, the box list, the hub row, the price block, the notes, «قبل أن تطلب», highlights, the specs and the phone bar inside a `createRoutesStub` router; `keepTokens` over every catalogue text — and the longest run it makes; the price block's own stylesheet; the tray's geometry at 360; the offline sentence said once; the focus handoff and its wiring; the specs' reading size; the sources' languages; the one-line breadcrumb bar) |

v2's removal of the before's `StageOrbs.tsx` stands; v2.1 puts round clay keys back on the stage below 1024 (back and
share, `StageCard`), while the header's cart stays the fly-to-cart target at every width and the shell's task header
(back · title · cart) still appears after 24px of scroll.

## v2.1 "Clay & Glass" (2026-11-13, client note 5: "the before look better")

The client preferred the BEFORE page ("the information is easy to read, button better, image and font like, and also
the note look better, also the bar above the name is much better"). The page is the before's arrangement rebuilt with
the v2.1 kit, keeping v2's features (zoom / full-screen gallery, the version in the URL, the actions row, «عرض السلة»
after an add, quick look, JSON-LD, every state, the used-unit link through the shelves).

- **Phones.** The stage is a soft card edge to edge under the header (lower corners rounded, 39:35 at 390; 4:3 on a phone under 760px tall, so the price stays above the bar): the kit's
  ground with the ambient light of the version's platform painted into it (a low pool on the floor line and a wide
  glow; brand red without a platform), the whole product floating in the middle of its zone with room around it
  (≈48% of the width for Switch 2 instead of v2's 77%), round clay keys over it — back at the start (real history
  Back, else the category) and share at the end beside the kit's full-screen key — the counter «1 من 6» above the
  thumbnails, which sit as raised tiles in a clay tray in the card's foot (its corners concentric with the tiles', so
  the chosen ring is whole at either end; six tiles fit from 320: 48px 6px apart at 360–367, 44px 4px apart under
  360). Then the breadcrumb bar (one line, up to
  the category: the current page is the name right under it), the brand line («جديد» when `isNew`, or «قريباً», + the
  platform's colour line and name; a product of no platform: its brand beside a neutral line), the name in Kufam, the
  fact line at 16px / 1.75 (running text, the « · » glued to the first fact), the price block (price big in Kufam with
  the demo tag at the start; «التوصيل 5,000 د.ع لكل المحافظات» and «● متوفر» at the end), the versions as cards with
  their own prices, المفضلة · قارن, the side information as calm notes (`SideNotes`: «طرق الدفع» with the transfer
  rule, delivery + «اطلب بدون حساب», returns, warranty) and «قبل أن تطلب» (warning note), «أبرز ما فيه» (checked
  list). The bar: the clay quantity tray and the glossy red «أضف إلى السلة» (the before's), «✓ في السلة» + «عرض
  السلة (n)» after an add; it slides in with the page.
- **768–1023.** The same, the stage card inside the page column with every corner round (16:11), 16px under the header.
- **From 1024.** The before's 5 + 7: the information column at the inline START (breadcrumbs — up to the category at
  1024–1279, where the 375–450px column cannot hold the current page on the same line; the whole trail from 1280, ONE
  line: a long name ends with an ellipsis at the end of its own run, «The Legend of Zelda: Ocar…» —, brand line, name, facts,
  price block, versions, the tray + «أضف إلى السلة», المفضلة · قارن · مشاركة, the notes, highlights) and the gallery
  at the inline END, sticky; below: about + «يعمل مع», game facts, specs | set + box, the hub row, reviews (real only)
  and the shelves, each fading up as it arrives (`Reveal`).
- **Motion.** A new picture slides in from the side it comes from (`data-step` next / previous, `pp-slide-*`; a new
  colour's set inflates in place — the kit's entrance); the chosen thumbnail's ring slides along the tray; the bar
  slides up with the page; the add key presses and the bead flies (kit). All instant under reduced motion (OS or the
  store's switch) and the lite tier.
- **Readable.** Facts, notes, the fee note, highlights, the specification and game-fact values and the line on their
  sources ≥ 16px with line height ≥ 1.7 on phones and tablets (measured); name > price > versions > notes.

## The page in v2 (spec §6.7) — kept for the rules; the arrangement is now v2.1's (above)

Phones, top to bottom: header (demo strip at load) · the stage full bleed and square (kit `Gallery`: neutral ground,
counter «1 من 6», full-screen key) · 56px thumbnails below it · platform dot + name + kind («● Nintendo · جهاز»; «قريباً»
or «جديد» — `product.isNew` only — at its start) · h1 (protected tokens never break: `keepTokens`, below; a long name
— 47 characters or more, three lines and more at 26px — one step down on phones, the h2 size: `isLongName`) · ONE fact
line (≤ 2 facts of the research's short line, drawn on one line: the second shows only when it fits beside the first,
`.pp-facts`; never cut with an ellipsis — in Arabic it cuts the START of a trailing Latin name, «…art World» — so a
first fact longer than a phone line that lists contents is cut into its « + » parts, each whole: a phone shows the
parts that fit on its one line, 768 and up all of them; any other long first fact is shown alone and wraps;
`factRow`) · price xl + «سعر ومخزون تجريبيان» · «●
متوفر · التوصيل 5,000 د.ع لكل المحافظات» · the payment sentence («الدفع عند الاستلام، أو زين كاش، أو تحويل إلى بطاقة
ماستركارد», + «محفظة طمطم» when signed in; only the methods the owner switched on) + «الحوالة تبقى بانتظار التحقق حتى
يراجعها موظف.» · the versions · المفضلة · قارن · مشاركة · the facts card · «قبل أن تطلب». The head steps are tight below
768 (8px under the thumbnails, 2px inside the name group, 8px to the price group; the buy box's other steps 12) so the
price, the demo tag and the stock-and-delivery line sit above the buy bar on first load (§6.7 target; 104 of 106
products at 390, "QA fixes" below). Then the reading
part (two columns from 1024): highlights + about | «يعمل مع»; game facts; specs | store set + in the box; the device
hub row; the recommendation shelves («أكمل تجهيزك», alternatives); reviews only when real approved verified-purchase
ones exist. The gallery's views are named by their own descriptions («الصورة 1: جهاز Nintendo Switch 2 من الأمام…»).

768–1023: one column, the 4:3 stage, the buy bar. From 1024: 7 + 5 — the gallery sticky at the inline START (right in
Arabic and Sorani, left in English; spec §6.7), the buy box at the inline end with `BuyControls` (stepper + «أضف إلى
السلة») after the versions; the breadcrumbs above both; no bottom bar.

Versions: `?v=<sku>`; without it the page opens on the default version — or on the first orderable one when the
default is sold out (`shownDefault`). Choosing is instant (state, then a `replace` navigation; no loader run); reload,
Back/Forward and the language switch keep it. Option cards (each with its own price; a version that cannot be ordered
says «نفد حالياً» or «يصدر …» and its price is muted); colours whose every version has its own photo are swatches
(56px thumbnails); other colours are chips (a swatch needs a real colour or a real photo — none is invented). The
group label repeats the choice («النسخة: النسخة الدولية»). No per-version research notes (no UPC notes); a
buyer-relevant line per version arrives only from the owner. Without script every choice still works through the GET
form: option cards and chips are native radios, and swatch products render the same colours as native radio chips in a
`<noscript>` group (the swatches hide under Tailwind's `noscript:` = `@media (scripting: none)`).

Buy bar (phones and tablets; v2.1): `BuyStrip` inside the shell's `<TaskBar>` (the glass, the `role="region"` named
«شراء {name}» right after the buy column in the reading and Tab order, the persisted name, and the measured height it
publishes as `--shell-taskbar-h` → `--shell-bottom`, so the page padding, toasts and scroll padding follow when the bar
grows). Ready: the clay quantity tray at the start and the glossy red «أضف إلى السلة» at the end (the kit's
`BuyControls`, as the before had it; on a 360 phone the key's side padding tightens through the kit's `--px` so its
words are never cut). After an add of this version: «✓ في السلة» over the price and «عرض السلة (n)» (another version
restores the tray and the key). Sold out «نفد حالياً» + «شاهد بدائل»; coming soon «يصدر … · الطلب يفتح عند وصوله», no
key (the kit's `BuyBar bare`). A failed add puts its sentence on a line above the controls and the kit's error toast
carries «أعد المحاولة»; offline that line says «لا يوجد اتصال» and the key goes flat (the full sentence is under the
price, named by the key's aria-describedby).

«شاهد بدائل» (bar and desktop) opens the product's own category (`alternativesPath`: its most specific category, whose
listing puts what is in stock first; else its platform hub). Not the page's shelves: on a sold-out page they are
mostly add-ons for the product («يكمّل PlayStation 5 Slim») or there are none (5 of 6 sold-out products checked).

## The quick look (spec §6.9)

A sheet (bottom on phones, the inline-end side from 768). Header strip: the name, «التفاصيل الكاملة ←» (the page on the
chosen version) and close. Body: the 4:3 stage, the price block (price + demo tag + stock-and-delivery line), the
versions (swatches for photographed colours). Pinned foot: [price | «أضف إلى السلة»]; adding closes nothing — the foot
says «✓ في السلة» and offers «عرض السلة (n)». Sold out / coming soon: words, no key. A navigation closes it. Opened from
cards of products with options (kit `ProductCard` → lazy import), from store-set rows, and from the home hero (home).

## States (spec §6.17)

| State | What the shopper sees |
|---|---|
| loading | SSR; the card's well grows into the stage; images carry their blurred placeholder. Quick look: the opener's picture and price at once, «جارٍ التحميل», the rest reserved |
| sold out | a sold-out default opens on an orderable version; otherwise the price muted (never the red sale figure, no saving words) + «● نفد حالياً» + one sentence (this version / the whole product), the bar «نفد حالياً» + «شاهد بدائل», the desktop key flat «نفد حالياً» + «شاهد بدائل» (→ the category) |
| coming soon | «قريباً» tag, the line «● يصدر 20 أيار 2027» alone (no delivery fee beside it: one line on a phone; the facts card states the fee) + the sentence «الطلب يفتح عند وصوله.»; no key anywhere; research sentences that speak of pre-orders are left out (fact line, highlights, about, in the box, notes) |
| digital code | «● نفد حالياً» or «● متوفر» with no delivery fee; facts: «يصلك الرمز بعد تأكيد الدفع.», payment; no returns or warranty rows |
| API failure | add: the count rolls back, the sentence (v2.1: the bar's line above the tray on phones, under the key from 1024) + the error toast with «أعد المحاولة». Quick look: ErrorState + retry |
| offline | the shell's banner; the add keys go flat and say why ONCE: on phones and tablets «لا يوجد اتصال. تعود الإضافة إلى السلة مع عودة الاتصال.» under the price (aria-describedby; the bar's line says «لا يوجد اتصال»), from 1024 the kit's line under the column's key (the sentence under the price gives way: `[data-offline-line]`, v2.1 review); quick look: the kit's line after the foot's flat key (once), and while loading the offline ErrorState, retried when the connection returns |
| no script | versions (cards, chips and — through the `<noscript>` chips — colours) choose through the GET form and `?v=`; the add key needs script (kit) |
| success | the bead counts at once, the bead flies from the stage photo to the header cart, the toast after landing, the bar «✓ في السلة» + «عرض السلة (n)» |
| demo | «سعر ومخزون تجريبيان» under the price (v2.1: the price's side of the block); a demo previous price is struck only while the store is in demo mode and never worded as a saving; demo stock never «الكمية محدودة» |
| reduced motion | the engine's rules (no flight, count + announcement; no zoom); v2.1: no picture slide, no ring travel, no bar slide-in (the OS setting, the store's switch and the lite tier) |
| opaque photos | light: the plate multiplies into the stage's ground (kit); dark: the kit's white plate stays (never a filter) — on 6 products the stage's first photo is plated (PlayStation 5 (2020), Switch Lite, PULSE 3D, PlayStation Plus, PlayStation Store card, Xbox Game Pass); 26 more have plated photos further in the gallery (list in the v2.1 report) |
| 404 / letter case | unknown, draft, review, archived, future-scheduled or variant-less slugs → the shell's 404 panel; other letter case → 301 to the canonical slug (`?v=` kept) |

## Real, demo, boundary

- Real: the researched facts (names, specs, highlights, in the box, game facts, notes, photos, sources, release dates),
  the fee and returns window from settings, the payment switches, stock states from the commerce core.
- Demo: prices, previous prices, stock levels — marked by the tag beside the price (and the shell's strip). JSON-LD
  carries no `offers` while `STORE_MODE=demo`.
- Warranty: the store's (`products.warranty_months`) is empty; the maker's from the specs is labelled as the maker's
  («كما تنشره الشركة المصنّعة، وليس ضمان طمطم.»); every warranty row asks «اسألنا عن شروط الضمان» → the hand-off form.
- No delivery time is promised; no call promise; no pre-orders (the cart accepts stocked variants only).
- Reviews: none exist; nothing is shown (no stars, no count, no aggregateRating).

## Exports other areas use (signatures kept)

`QuickPreview` / `QuickPreviewProps` / `fetchPreview` (kit `ProductCard`, home hero); `GET /api/product-preview/:slug`.
The page imports `CompareToggle` (catalog), `RecommendationShelves` / `DeviceHubLink` / `signals` (devices),
`readConsent` / `recordProductView` (home), and declares `handle.shell.tabBar = false` (shell).

## Review (2026-11-12, P3 review)

Found and fixed: the first-screen target was met for 60 of 106 products at 390 (two-line names, wrapping fact lines
and struck prices pushed the stock line under the buy bar) → tighter phone steps + one fact line; the buy bar grew to
93px after an add while `--shell-bottom` stayed 72 (focused controls and the page's end under it) → the measured
height is published, the bar is a named region right after the buy box; photographed colours could not be chosen
without script (swatches only) → `<noscript>` chips; a sold-out price was the red sale figure → muted; «شاهد بدائل»
scrolled to add-on shelves or to nothing on 5 of 6 sold-out products → the product's category; version prices broke
between the figure and «د.ع» → kept whole; the bar's offline line was cut → «لا يوجد اتصال»; gallery views were named
«الرئيسية» → their own descriptions. Checks: `…/scratchpad/ux/after/P3-product-review/`, scripts in
`…/scratchpad/work/pages-P3-product-review/` (probe, matrix, fold, focuswalk, census, flows, quick, qlstates, nojs3).

## Verified (2026-11-12)

`npx vitest run tests/product.test.ts` (47 pass) · `node scripts/lint-design.mjs --strict app/routes/storefront/product`
(0) · `npm run typecheck` (no error in this area) · screenshots `…/scratchpad/ux/after/P3-product/` and
`…/P3-product-review/` (360–1440 light and dark in Arabic, 390 and 1440 in English and Sorani; sold out, coming soon,
digital, colours, game, set; quick look and its states; no script; offline; failed add; 320 reflow and 720 = 1440 at
200%) · first screen at 390 on all 106 products: 91 above the bar · probe: one red primary per view, 0 targets < 44, 0
Arabic runs < 13px, 7–9 sizes, no overflow, no console error or hydration warning; at 1440 price, stock line, payment
sentence, versions and the add key above 900 for ≤ 3 versions · census on 4 products × ar/en/ckb × 390/1440 × light/dark
(48 views): sizes of the scale, Kufi 700 + Plex 400/600, radii in the set, ≤ 2 shadow recipes, no image filter, no low
contrast · focus walk 0 stops under a bar and a ring on every stop (390 after an add with the 93px bar, 390 swatches,
1440) · flows: `?v=` replace + reload, Enter on a version stays in the page, add → bead → «✓ في السلة» + «عرض السلة
(1)», failed add rolled back, offline flat key, no-script colour choice → `?v=`, quick look add + Escape (focus back to
the card), quick look loading / failed / gone / offline. Chromium (Edge) only.

## Verified (v2.1, 2026-11-13)

`npm run typecheck` (no error in this area) · `npx vitest run tests/product.test.ts` (61 pass: 6 new for v2.1, no
assertion of v2 changed) · `node scripts/lint-design.mjs --strict` on the area and its strings (0) · sweep of
`/p/nintendo-switch-2` at 360 / 390 / 768 / 1024 / 1440 light and dark (ar) and 390 / 1440 (en, ckb): no overflow,
one h1, one visible red primary, reading text ≥ 16px everywhere, Kufam ≥ 15px, no console error or hydration warning ·
first phone screen at 390×844: the price and the stock line above the bar and the add key on screen on 106 of 106
products (ar) · flows (Chromium): the bar slides in, thumbnail → slide next / previous and the ring travels, swipe
(RTL), full-screen viewer + Escape (focus back), `?v=` + reload, add → bead + «عرض السلة (1)», card → product → Back
keeps the scroll (stage key at 390, browser Back at 1440), quick look from a card (390 sheet, 1440 side), offline, a
failed add (cart 500), reduced motion (OS and the store's switch) · focus walk 390 / 1440 light and dark: every stop of
the area ringed, none under the header or the bar · states shot: sold out, coming soon, digital, colours, store set,
game, struck price, no platform, long name, «جديد», plated photos. Screenshots and scripts:
`…/scratchpad/fb1/shots/product/`, `…/scratchpad/fb1/work/product/`.

## Review (v2.1, 2026-11-13)

Found with my own probes and screenshots, all fixed in the area (tests first where it is behaviour):

- **The quick look's price block was unstyled** everywhere but the product page: its rules lived in `product.css`,
  which only `/p/` loads — opened from a listing, the home or search, the price, the demo tag, the fee and the stock
  were plain stacked lines. → `components/PriceBlock.css`, imported by `PriceBlock.tsx` (SSR critical CSS and the
  lazy quick-look chunk both carry it).
- **English pages wider than the phone**: `keepTokens` glued every word of up to three letters to the one before, so
  English prose became unbreakable runs of up to 47 characters («GPU: 4K at up to 120 FPS and 8K HDR»);
  `/en/p/xbox-series-x` was 407px wide at 390 (the layout viewport grows in mobile Chrome, so `scrollWidth >
  innerWidth` never saw it). → only a name's short tokens are kept (a digit, a capital or «+»; a unit after a number);
  the longest run the catalogue can make is now 25 characters (test over every text in ar/en/ckb).
- **The thumbnail tray cut its ends**: its 28px pill corners clipped the chosen ring at either end on every page, and
  at 360 six tiles needed 340px of 336 (it scrolled, the last tile cut). → corners concentric with the tiles'
  (`calc(var(--r-sm) + var(--pp-tray-pad))`), 6px gaps at 360–367, 44px tiles 4px apart under 360.
- **768–1023**: the stage card was glued to the header (no space above a card with four round corners) → 16px.
- **1024–1279**: the breadcrumb bar broke onto a second line holding only «‹ Nintendo Switch 2» in the 375–450px
  column → up to the category there, as on phones (the whole trail at 768–1023 and from 1280; JSON-LD unchanged).
- **320–359**: «أضف إلى السلة» was cut to «أضف إلى …» in the bar → the decorative bag gives way, `--px` 12.
- **Offline from 1024**: the shell's banner, the sentence under the price and the kit's line under the key said the
  same thing three times, and the key was described by both sentences → the sentence under the price gives way from
  1024 (`[data-offline-line]`, utilities layer), the column's key is described by the kit's line only. The quick look
  said it twice as well (under the price and in the foot): now only the kit's line after the foot's key.
- **Short phones** (360×740, 375×667): the 39:35 card put the price under the buy bar on 54 of 106 products at
  360×740 → below 760px of height the card is 4:3 (the whole product, a little smaller): 104 of 106 now.

Verified: `npx vitest run tests/product.test.ts` 65 pass (4 new; no earlier assertion changed) · full suite 139 files /
4217 tests pass · `npm run typecheck` green · `lint-design --strict` 0 · every product at 390×844: price and stock line
above the bar 106/106 in ar and en, 106/105 in ckb (the Charging Station's three-line Sorani name; the bar says sold
out); at 360×740: price 104/104/103 of 106 (ar/en/ckb); horizontal overflow 0 everywhere, measured against
`documentElement.clientWidth` · flows, focus walks (390, 1024, 1440), motion tiers, no-script colours, quick look
states. Shots and scripts: `…/scratchpad/fb1/shots/product-review/`, `…/scratchpad/fb1/work/product-review/`.

Outside the area (reported): a card → product zoom on a phone aborts its view transition with an uncaught
`InvalidStateError: … Viewport size changed` (Chromium mobile emulation, from listings and the home; not from the
product page — it stays with the page hidden; a plain router navigation is clean).

## QA fixes (wave C, 2026-11-13)

Five auditors checked the store against the client's notes; the product area's findings, all fixed (tests first):

- **Focus lost after «أضف إلى السلة»** (WCAG 2.4.3). The phone / tablet bar and the quick look's pinned foot replace
  the focused key with «✓ في السلة» + «عرض السلة (n)»; removing it dropped focus to `<body>` — in the quick look, out
  of the modal sheet (the next Tab started again at «التفاصيل الكاملة»). → `handoff.ts`: on the confirmed add, while the
  old key is still there, the bar / foot notes whether focus is inside it; after the swap «عرض السلة (n)»
  (`data-focus-target`) takes it, without scrolling. Never when focus had moved on; a tap or click moves it too, with no
  ring (`:focus-visible` stays false); the live region still says the add. The kit's own `BuyBar` (used unit page) has
  the same swap — asked of the kit owner.
- **Specification values 14 / 1.5 and the source line 13 on phones** (G7). → `.pp-fact`: the values of `Rows` (specs and
  game facts), the line on where they come from and «لا توجد مواصفات…» read at 16 / 1.75 below 1024; 14 from 1024 (half
  the page). The sources' titles read at 16 regular there too, each title over its publisher (a stacked citation: a
  wrapping title no longer splits «Nintendo of / America» across lines).
- **Sources in another language** («شركة Valve تعلن…», «機能・仕様 | Nintendo Switch 2») had no `lang`: an English or
  Sorani screen reader read them with the page's voice. → every title and publisher is a `<bdi>` with the language and
  direction its letters say (`SourceText`, devices area: Arabic, Sorani, Japanese, Korean, English; no claim otherwise).
- **The breadcrumb bar at ≥ 1280**: a long name («‹ The Legend of Zelda: Ocarina of Time») sat alone on a second line,
  chevron first. → where the trail names the product (768–1023, from 1280) it is ONE line: the name shrinks and ends
  with an ellipsis at the end of its own run (the isolate's direction: «The Legend of Zelda: Ocar…»). The bar itself
  has `min-inline-size: 0` — a grid item's automatic minimum is its content's, and the one line widened the column's
  implicit track (the price line was cut under the gallery at 1280 in the first try).

Verified: `tests/product.test.ts` 69 pass (4 new, red first; no earlier assertion changed) · flows (puppeteer, Edge):
Enter on the bar's key → focus on «عرض السلة (1)» with its ring at 390 / 768 in ar, en, ckb, light and dark; the quick
look from `/c/controllers`, `/platform/playstation` and the home hero at 390 and 1440 → focus on «عرض السلة (1)»
inside the dialog, every next Tab inside it · census at 390 (every `<details>` open): the specs' small runs 10 → 0
(left: the kit's section-head reason, the shell's footer and preference notes, a version card label; «يعمل مع»'s line
on what the states mean is a `.pp-fact` too) · breadcrumbs: every product in ar/en/ckb (315 pages per width) one line
inside the column — at 1280 83 long names cut at their end (at least 107px of the name shown), at 768 9 (at least
407px) · language scan 0 leaks · `lint-design --strict` 0. Shots and scripts:
`…/scratchpad/fb1/shots/C-fix-product/`, `…/scratchpad/fb1/work/C-fix-product/`.

## Not done / limits

- v2's first-screen notes below are superseded: with v2.1 the price and stock line sit above the bar on every product
  at 390×844 (Arabic measured; English and Sorani in the report).
- v2's "stage fill 60%" target is withdrawn by client note 5 (the whole product with room around it).
- The stage card, its tray and the sliding ring restyle the kit's gallery from product.css (scoped to `.pp-stage`); the
  quick look and the used unit page keep the kit's plain stage — asked of the kit owner to fold it in (report).
- From a card, the quick look's code is fetched on first use: offline before that, the card's button does nothing
  (kit `ProductCard`) — asked of the kit owner.
- A variant's own photos replace the product gallery (the database cannot tell "the whole gallery" from "none").
- God of War Ragnarök and EA SPORTS FC 27 (Switch 2) have no box art: their first photo is key art (spec §7.6) — data.
- The research text still contains pre-order sentences; the page leaves them out (`text.ts`) — asked of the data owner.
- The Sorani strings need a native reader; the Sorani brand spelling stays «تەمتەم» as in the other namespaces until
  the owner decides (spec §13 row 12).

## Wave G wiring (2026-11-12)

- **Buy bar:** the kit's `<BuyBar bare>` inside the shell's `<TaskBar>` (the named region, the persisted name, the height it
  publishes) — the page's own height hook and failure line are gone: a failed add and «لا يوجد اتصال» take the bar's own line; a
  new version starts afresh (keyed by variant).
- `WishlistKey variant="text"` in the actions row; `CompareToggle` gets the gallery's first picture (the tray's thumbnail).
- Coming soon: the price line's status says «● يصدر 19 تشرين الثاني 2026» (`PriceTag status`), the sentence under it «الطلب يفتح
  عند وصوله.» (`status.soonNote`).
- «يعمل مع» rows link to the device's hub when it has one (`CompatList` `href`); colour swatches say why one cannot be ordered
  («نفد حالياً», or its release day — never «غير متوفر»: `unavailable: "soldOut" | "soon"` + `reason`).
- A missing product: a redirect staff set in the content module is followed before the 404 (`redirectIfMoved`).

## QA fixes (2026-11-12, Q-product)

- **Memory and storage swapped («32GB / 1TB»).** `MixedText` isolated "Windows 11 Z1 Extreme 32GB" and "1TB" as two runs
  around « / », and an Arabic line put them in its own order («1TB / … 32GB», «Glacier أبيض 1TB / 32GB»). A Latin name now
  goes on across a spaced joiner (« / », « + », « – », « - », « & », « | », « × ») as the browser itself reads it — not after
  a bare number that follows Arabic («39 × 191 × 141 ملم» keeps the sentence's order) and not onto a number that counts
  the Arabic after it («+ 3 مانگ»). Fixes the Legion Go S cards and legend, the ROG Ally labels in store sets, the bundle
  labels («Switch 2 + Mario Kart World»), «Nintendo Switch – OLED Model», «DK Island & Emerald Rush».
- **Names breaking inside protected tokens** (§4.18). `keepTokens` (text.ts): a no-break space before a short Latin or
  number token of 1–3 characters («Switch 2», «PS5 Pro», «Go 2», «(L)», «(عدد 2)») and a non-breaking hyphen inside a
  Latin token («Z-A», «USB-C», «Joy-Con»). On the h1, the quick look's title and everything `MixedText` draws (in the
  box, facts, highlights, specs, version labels); the kit's `splitBidi` and `MixedText` cut every catalogue text exactly
  as before (test over the whole catalogue). The device-hub row's title uses the hub's own `deviceIn`.
- **First screen at 390** (§6.7 target): coming soon says the release day alone on its line (no fee → one line); phone
  steps 8 / 2 / 8; long names one size down on phones; a contents fact cut into its parts on phones. 90 → 104 of 106
  (ar), the 5 sampled failures pass (Pokémon Z-A bundle 842 → 760, carrying case 787 → 731, Xbox X25 783 → 746, store
  set 775 → 742, DualSense 771 → 759).
- Checks: `npx vitest run tests/product.test.ts` (55 pass) · `node scripts/lint-design.mjs --strict` on the area (0) ·
  every product at 390 in ar/ckb/en · screenshots and probes in `…/scratchpad/ux/after/Q-fix-pages-product/`.
