# Product area

Owner: product. The product page `/p/:slug` and the quick-preview sheet (brief §3.7–3.8; DESIGN.md §8.4 phone, §8.10
desktop, §8.11 tablet, §9.6 gallery). Contract row: CONTRACTS.md §3 "product".

## Files

| File | What |
|---|---|
| `app/routes/storefront/product/product.tsx` | the page: loader, meta (`shellMeta`, `og:image` = `productShareImage`), `handle.shell.tabBar = false`, `shouldRevalidate`, JSON-LD |
| `…/product/components/*` | stage orbs, variant picker, price block, facts, details sections, store-set contents (each row opens the quick look), `MixedText` (bracket-safe isolation of Latin runs in research sentences), related shelves, reviews, integration slots |
| `…/product/QuickPreview.tsx` | `<QuickPreview slug name card open onClose />` — the sheet the integration pass opens from cards |
| `…/product/preview.ts` | `GET /api/product-preview/:slug?locale=` → `{ ok, product: ProductPreview, i18n }` (404 `{ ok:false, code:"not_found", i18n }`) |
| `…/product/useVariant.ts`, `jsonld.ts`, `i18n.tsx`, `product.css` | `?v=` handling, schema.org data, the strings hook, three layout rules |
| `app/server/services/catalog/product.server.ts` | `getProductDetail(db, locale, slug, { now, related? }) → ProductDetail \| null` |
| `app/server/services/catalog/product-types.ts` | client-safe types (`ProductDetail`, `VariantDetail`, `ProductPreview`, `ReviewSummary`) and pure helpers |
| `app/server/services/reviews.server.ts` | `getReviewSummary(db, productId)`, `listVerifiedReviews(db, productId, { limit })` |
| `app/i18n/messages/product.ts` | the "product" namespace (ar source, en, ckb) |
| `tests/product.test.ts` | 30 tests on the demo catalogue + a test world |

## The page

Phones: the Lit Stage edge to edge under the header, square top corners (b.png), back / cart orbs on it; the info on
the floor; the buy bar (`<TaskBar>` + `BuyControls`) in place of the tab bar. 768–1023: the stage inside the page
column. From 1024: 7 + 5 grid — stage sticky at the inline end, info column at the start with `BuyControls` in it and no
bottom bar. From 1200 the orbs hide (the header's cart orb is the fly target).

Order of the info: breadcrumbs (+ BreadcrumbList JSON-LD) · tag ("جديد", or "قريباً" while a release date is ahead) and
platform LED(s) · h1 + wishlist key · short line · price with genuine old price, delivery fee and stock words · the
reason it cannot be ordered (when so) · variant picker + the variant's research note · buy controls (≥1024) ·
[compatibility slot] · highlights · game facts · delivery / warranty / returns. Below: about, specifications (SKU and
model number first), store-set contents, in the box, "before you order" notes, [device hub slot], related shelves,
[recommendations slot], reviews, photo credits and research sources.

Variants: `?v=<sku>` (none = the default). Choosing is instant (state first, then a `replace` navigation; the loader is
skipped for a change of `v` only), Back leaves the product, the language switch keeps the choice, and without script
the radios submit a GET form. Labels are the localized variant titles without their shared words; short ones are
chips, long ones option rows with price and stock. The gallery shows the variant's own photos (the picture swaps with
the stage's inflate; a platform option relights the stage, e.g. PS5 / Xbox versions of a game); a variant without
photos while its siblings have some shows the default's photos and says so.

## States (brief §12)

| State | What the shopper sees |
|---|---|
| default / partial data | every section renders only when it has data; no specs → "لا توجد مواصفات مسجّلة…"; no photos → an unlit, empty stage |
| loading | SSR; client navigation from a card zooms the card's niche into the stage (`product-image:<id>`); the preview sheet shows the card's picture and price while the rest loads (reserved space, no skeleton) |
| empty | no reviews → empty-state panel with the rule (approved, verified purchases only); empty shelves render nothing |
| sold out / not out yet | flat "غير متوفر" key + one sentence (aria-describedby): this version sold out, all sold out, or "يصدر في {date}، ويمكنك طلبه من هنا عندما يتوفّر لدينا" |
| offline / API failure | add-to-cart and wishlist roll back with a sentence + retry (kit); the shell's offline banner; the preview sheet: error panel + retry, retries by itself when back online |
| success | the kit's check, live-region sentence, cart toast with undo, fly-to-cart into the visible cart |
| unauthorized / pending review | not applicable (public page; nothing to review) |
| reduced motion | no flight, no zoom (120 ms cross-fade), instant picture swap — the engine's rules |
| 404 | unknown, draft, review, archived, future-scheduled or variant-less slugs → the shell's 404 panel; other letter case → 301 to the canonical slug |

## Real, demo, boundary

- Real: the researched facts (names, specs, highlights, in the box, game facts, notes, photos, credits, sources,
  release dates), the delivery fee and returns window from settings, stock states from the commerce core.
- Demo: prices, compare-at prices and stock levels (the shell's ribbon says so; a live store shows `DemoNote` on
  leftover demo rows). JSON-LD carries no `offers` while `STORE_MODE=demo`.
- Store warranty: `products.warranty_months` is empty (open item 15) → "لم ننشر شروط ضمان طمطم لهذا المنتج بعد. اسألنا
  عنها قبل أن تطلب."; the maker's warranty from the specs is labelled as the maker's.
- Pre-orders: the cart only accepts stocked variants, so nothing is offered before stock exists; the date is said.
- Reviews: none exist; nothing is invented (no stars, no count, no aggregateRating).
- Delivery time: "نتصل بك لتأكيد موعد التوصيل" — never a promised day.

## Integration slots (filled by the integration pass — `components/Slots.tsx` says what each needs)

- `CompatibilitySlot` — devices: `getCompatibilityForProduct` → rows for `~/ui/CompatBadge` ("يعمل مع").
- `RecommendationsSlot` — devices: `getRecommendations({ context: "product", productId, … })` → `ShelfRail`s.
- `DeviceHubSlot` — devices: the `/device/<slug>` row link for products that are a device (`product.deviceModel`).
- `WishlistKey initial` — account: `getWishlistIds` in the loader (today `false`; the endpoint answers for real once
  `POST /api/wishlist` exists).
- Quick preview from cards: `import { QuickPreview } from "~/routes/storefront/product/QuickPreview"` (header comment
  has the snippet); DESIGN §9.5 wants it for cards with options.

## Verified

`npx vitest run tests/product.test.ts` (30 pass) · `node scripts/lint-design.mjs app/routes/storefront/product` (0) ·
typecheck of the area's files · screenshots at 390 / 1440, light / dark, ar / en / ckb (`.shots/product/`), browser
flows in headless Edge (`scratchpad/work/product/flow.mjs`): card → page → Back keeps URL, history length and scroll (3503 px → 3503 px), also under reduced motion; a colour choice changes `?v=` by replace, the picture and the price, survives a reload, and Back leaves the product; a photo-less colour says whose photos show; a not-yet-released colour shows the date and a disabled key described by the reason; add to cart counts up before the server answers (200) and toasts with undo; the quick look opens from a set row, traps focus, Escape returns focus; 404 and the 301 to the canonical slug; at 1440 no task bar, no orbs, sticky stage. Console clean (no hydration warning, no 404 of this area). Chromium only.

## Not done / limits

- The header has no cart below 1200 on task screens: once the stage scrolls away on a phone there is no visible cart
  (the bead lands only when the orb is on screen). Asked of the shell owner.
- A 404 product URL renders the shell's panel without the tab bar (the page's `tabBar: false` handle still matches).
  Asked of the shell owner.
- With the quick look open, three live glass panes are mounted (header, buy bar, sheet strip) and `<Glass>` warns in
  development; the sheet covers the bar. Same pattern as the categories sheet over the tab bar.
- A variant's own photos replace the product gallery (not added to it): the database cannot tell a variant listed with
  "the whole gallery" from one listed with none, so a photo-less non-default variant borrows the default's and says so.
- No back-in-stock or pre-order flow (no service); no video in the gallery (no video media exist).
- Research `unverified` notes are English only and are not shown; research notes about barcodes appear as written.
- The Sorani strings need a native reader.
