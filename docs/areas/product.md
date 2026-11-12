# Product area

Owner: product. The product page `/p/:slug` and the quick look (brief §3.7–3.8; Design System v2 spec §6.7, §6.9,
§6.17, §7, §9). Contract row: CONTRACTS.md §3 "product". Rebuilt for Design System v2 on 2026-11-12 (stage 3, P3).

## Files

| File | What |
|---|---|
| `app/routes/storefront/product/product.tsx` | the page: loader, meta (`shellMeta`, `og:image` = `productShareImage`), `handle.shell.tabBar = false`, `shouldRevalidate` (a change of `?v=` only skips the loader), layout, the buy bar (a named region whose measured height it publishes as `--shell-taskbar-h`), JSON-LD |
| `…/product/QuickPreview.tsx` | `<QuickPreview slug name card? image? open onClose />` and `fetchPreview(slug, locale, signal?)` — the quick look (export signature unchanged) |
| `…/product/preview.ts` | `GET /api/product-preview/:slug?locale=` → `{ ok, product: ProductPreview, i18n }` (404 `{ ok:false, code:"not_found", i18n }`) |
| `…/product/useVariant.ts` | `?v=` handling: `shownDefault`, `variantFor`, `searchFor`, `onlyVariantChanged`, `useVariantInUrl` |
| `…/product/text.ts` | the researched text as the page shows it: `factParts` / `factLine`, `claimsPreorder`, `withoutPreorder`, `proseWithoutPreorder` |
| `…/product/jsonld.ts`, `i18n.tsx`, `product.css` | schema.org data; the strings hook (`useProductT`, `<ProductMessages>`); full-bleed stage, the one-line fact row (`.pp-facts`), sticky gallery, the reading pairs |
| `…/components/PriceBlock.tsx` | price xl + demo tag + «● متوفر · التوصيل …» (kit `PriceTag size="page"`), the reason sentences; `struckPrice`, `priceLook` (sold out = muted, no saving), `useDemoStore` |
| `…/components/Facts.tsx` | `PaymentLine` (the one payment sentence + transfer rule), `FactsCard` (kit `FactList` on paper); `paymentMethods`, `offersTransfer`, `ASK_HREF` |
| `…/components/VariantPicker.tsx` | option cards with prices (figure and «د.ع» never split) · swatches · chips (`pickerLook`); no-script GET form — for swatches a `<noscript>` group of native radio chips (the swatches hide under `noscript:`) |
| `…/components/Actions.tsx` | `SecondaryActions` (WishlistKey · CompareToggle · `ShareKey`) |
| `…/components/Details.tsx` | `Section`, `BeforeYouOrder`, `Highlights`, `About`, `GameFacts`, `Rows`, `Specs` (+ `sourceLine`), `InTheBox` (+ `boxPhoto`) |
| `…/components/Slots.tsx` | cross-area pieces: `CompatibilitySlot` (+ `compatRows`), `DeviceHubSlot`, `RecommendationsSlot`; `alternativesPath` (where «شاهد بدائل» leads) |
| `…/components/SetContents.tsx`, `MixedText.tsx`, `Reviews.tsx` | store-set rows (each opens the quick look); bracket-safe Latin isolation (comma thousands are one run); reviews only when real |
| `app/server/services/catalog/product.server.ts`, `product-types.ts` | read layer (owner: data, D) — `getProductDetail`, `ProductDetail`, `VariantDetail`, `ProductPreview`, `galleryFor`, `selectVariant` |
| `app/i18n/messages/product.ts` | the "product" namespace (ar source, en, ckb) |
| `tests/product.test.ts` | 47 tests on the demo catalogue + a test world (server renders of the version picker inside a `createRoutesStub` router) |

`StageOrbs.tsx` is gone (spec §11.5): below 1024 the shell's task header (back · title · cart) appears after 24px of
scroll, and the header's cart is the fly-to-cart target at every width.

## The page (spec §6.7)

Phones, top to bottom: header (demo strip at load) · the stage full bleed and square (kit `Gallery`: neutral ground,
counter «1 من 6», full-screen key) · 56px thumbnails below it · platform dot + name + kind («● Nintendo · جهاز»; «قريباً»
or «جديد» — `product.isNew` only — at its start) · h1 · ONE fact line (≤ 2 facts of the research's short line, drawn
on one line: the second shows only when it fits beside the first, `.pp-facts`; a first fact longer than a phone line —
a set's contents — is shown alone and wraps, never cut: an ellipsis in Arabic cuts the START of a trailing Latin name,
«…art World»; `factRow`) · price xl + «سعر ومخزون تجريبيان» · «●
متوفر · التوصيل 5,000 د.ع لكل المحافظات» · the payment sentence («الدفع عند الاستلام، أو زين كاش، أو تحويل إلى بطاقة
ماستركارد», + «محفظة طمطم» when signed in; only the methods the owner switched on) + «الحوالة تبقى بانتظار التحقق حتى
يراجعها موظف.» · the versions · المفضلة · قارن · مشاركة · the facts card · «قبل أن تطلب». The head steps are tight below
768 (12px between the gallery, the name group and the price group; 4px inside the name group) so the price, the demo
tag and the stock-and-delivery line sit above the buy bar on first load for names up to two lines. Then the reading
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

Buy bar (phones and tablets): the kit's `BuyBar`, placed as the shell's task bar (`.shell-taskbar`, so the tab bar
gives way), wrapped in a `role="region"` named «شراء {name}» that sits right after the buy box in the reading and Tab
order (it is fixed on screen; from 1024 the wrapper is hidden, so no empty landmark). The page measures the bar and
publishes its height as `--shell-taskbar-h` (the shell's task-bar contract → `--shell-bottom`): the bar grows from 72px
to 93px after an add, and the page's bottom padding, the toasts and the global scroll padding follow. Price and version
at the start, «أضف إلى السلة» at the end; after an add of this version «✓ في السلة» + «عرض السلة (n)» (another version
restores the key); sold out «نفد حالياً» + «شاهد بدائل»; coming soon «يصدر … · الطلب يفتح عند وصوله», no key. A failed
add keeps the bar on one line: its sentence takes the bar's info line, the kit's error toast carries «أعد المحاولة»;
offline the info line says «لا يوجد اتصال» (the full sentence is under the price, named by the key's aria-describedby).

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
| coming soon | «قريباً» tag, «● قريباً · التوصيل …» + «يصدر 20 أيار 2027 · الطلب يفتح عند وصوله»; no key anywhere; research sentences that speak of pre-orders are left out (fact line, highlights, about, in the box, notes) |
| digital code | «● نفد حالياً» or «● متوفر» with no delivery fee; facts: «يصلك الرمز بعد تأكيد الدفع.», payment; no returns or warranty rows |
| API failure | add: the count rolls back, the sentence (bar info line on phones, under the key from 1024) + the error toast with «أعد المحاولة». Quick look: ErrorState + retry |
| offline | the shell's banner; the add keys go flat with «لا يوجد اتصال. تعود الإضافة إلى السلة مع عودة الاتصال.» (aria-describedby; the bar's one line says «لا يوجد اتصال»); quick look: the offline ErrorState, retried when the connection returns |
| no script | versions (cards, chips and — through the `<noscript>` chips — colours) choose through the GET form and `?v=`; the add key needs script (kit) |
| success | the bead counts at once, the bead flies from the stage photo to the header cart, the toast after landing, the bar «عرض السلة (n)» |
| demo | «سعر ومخزون تجريبيان» beside the price; a demo previous price is struck only while the store is in demo mode and never worded as a saving; demo stock never «الكمية محدودة» |
| reduced motion | the engine's rules (no flight, count + announcement; no zoom) |
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

## Not done / limits

- The §6.7 first-screen target (price, demo tag and stock-and-delivery line above the buy bar, y ≤ 760 at 390×844)
  holds for 91 of 106 products (was 60). The 15 left: names of three or four lines at 26px (9: Switch 2 bundles and
  editions, microSD and expansion cards, the carrying case, Zelda BotW and TotK); two-line names with a struck demo
  previous price (4: DualSense, HyperX Cloud III S, Switch 2 dock set, PS5 Slim — line bottom 783; the kit's
  previous-price line is 27px tall, it inherits the body's 1.7 line height, and sits above the figure: asked of the kit
  owner); two-line names whose first fact is a set's contents, shown whole on two lines rather than cut (2: the Mario
  Kart World bundle and the store set — 775).
- Stage fill: the hardware covers ~52% of the stage at 390 (Switch 2; target 60%): the kit's stage insets (8/6/9%) and
  the photos' own transparent margins — asked of the kit owner.
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
