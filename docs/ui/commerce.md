# Commerce components — props and examples

## Design v2.1 «Clay & Glass» (2026-11-12) — DESIGN.md §15

- **ProductCard / UsedUnitCard** — a soft raised card (light: paper + warm shadow; dark: faux glass) holding the warm well
  6px in (8 from 768); fine-pointer hover lifts it 3px (the deeper shadow fades in on `.pcard::before`) and grows the
  photo 1.03. The kind line starts with the platform's colour line; the heart is a 36px frosted disc in the well's corner
  (`size="sm"`); the add button is a 40px clay circle that turns glossy red under the pointer. Props unchanged.
- **Stepper** is the clay tray; **OrderSummary**, **InspectionCard**, **TrustStrip** (clay icon tiles with red line icons) and
  **FactList** (16px reading text) are soft raised cards.
- **EmptyState** stacks the key and the recovery link (the before's arrangement); `panel` sets it on the soft card.

## Fix round (2026-11-13) — DESIGN.md §15.10

- **OrderSummary** — the arrangement is subtotal · the discount · delivery · «الإجمالي»; nothing with a minus sign after
  the total. New: `discountParts={[{ key, icon?, label, amountIqd }]}` — each part of the discount a row in the discount's
  place (`--ok`, its icon), never with the single «الخصم» row (parts that do not add up to `discountIqd` fall back to
  it; `discountRows()` is the pure rule); `shippingNote` replaces the line under «التوصيل»; `children` now render
  directly under the total (a split payment's parts), before the coupon question, which has a caret that turns.
- **Price** `countUp` (`true`: once on first view; `"load"`: also on a direct open, from 70%) — the page's news figure.
- **WalletBalance** — ledger rows: the kind's 40px disc (`ledgerLook()`: in green, spent red, given back blue) and the
  signed amount, + in `--ok`, − in `--red-ink` (the account's history look).
- **UsedUnitCard** row — «صورة توضيحية» sits under the 96px well (Sorani's words did not fit on it); on the grid card it
  wraps inside the well. **InspectionCard** / **GradeBadge** — reading text on phones (16px), 14px from 1024; the
  legend keeps clear of the shell's fixed bars. **Gallery** — no counter for a single picture.
- **EmptyState** `wide` (with `panel`): the card spans its column; a stack `icon` is drawn at 44px.
- **Field** — `OptionCard clay icon` (a clay face, the option's icon in a 40px clay disc); `Radio row icon`;
  `Checkbox row` (the option row's look, the hint inside); a one-line option row is centred in its 64px.

## QA fixes (2026-11-12, after the full matrix)

- **ProductCard / KindLine:** the kind line and the meta line are `<FactLine>`s (docs/ui/core.md): «جهاز محمول · ROG
  Xbox Ally» drops the family whole when it does not fit, and a meta fact is whole or shortened at its own end — never
  «…G Xbox Ally», «…RAM · Ryzen AI Z2 Extreme», «…nds: Z-A». The coming-soon day is day-first in English too
  («Out 13 November»; `releaseDay` uses the British order).
- **Gallery viewer:** one column as wide as the screen (`minmax(0, 1fr)`): six thumbnails made it 416px wide and pushed
  the close key off a 360px phone. The strip scrolls sideways inside its own row (centred while it fits, the gutter as
  scroll padding) and keeps the chosen thumbnail in view (`useKeepInView`); the bar keeps the gutter. Android's back
  closes the viewer through the modal layer's CloseWatcher; no history entry is pushed.
- **BuyBar:** the version is a `<FactLine>` (one line, shortened at its logical end: «SteamOS Z1 Extreme 32GB / 1…»);
  the price steps down to sm when the price column is under 140px (320px reflow) — the figure and «د.ع» never part.
- **AddToCartKey:** an add pressed inside a sheet or dialog (the quick look) shows no success toast — the layer says
  «✓ في السلة» and the live region announces it; a failure still toasts (it carries the retry).
- **PriceLine:** «● متوفر · التوصيل …» — the « · » belongs to the item after it (`.price-line__item`), so it wraps with it.
- **UsedUnitCard:** the grid card's action is the words «اعرض تقرير الفحص» (a 44px TextLink, the unit's name as its
  description), like the row; the picture of an illustrated unit stands above the «صورة توضيحية» chip (the slot ends
  ≥ 40px from the bottom of a card well, 32px in a 96px row well); a row's meta may take two lines (64GB stays).
- **Cart editor:** «تراجع» puts a removed line back in its old place (`keepLineOrder`, by variant / unit identity — the
  server re-adds it as a new line at the end).
- **TrustStrip `line`:** «سياسة الإرجاع» has a 44px hit area (`hit-44`) around its 13px words.

## Polish round (2026-11-12)

- **ProductCard:** `compare` — a slot under the price row for the catalogue's `<CompareToggle>` (console and handheld
  cards; give every card of a row the slot or none); `onWishedChange` — the heart's confirmed state; facts are
  `<BidiLabel>`s («512GB أو 1TB» reads from the right); a Latin name on an Arabic page clamps with the ellipsis at its
  own end and stays aligned to the page's start; «تخفيض» only beside a previous price the card actually strikes; a
  picture that failed before hydration is found on mount (`pictureFailed`) and shows the failed state, not the
  browser's broken frame; the card fills its cell (`w-full`: it is an inline-size container). The quick look's code is
  fetched on the first tap: offline, an error toast says so (the next tap tries again); online and missing (a new
  deploy), the link opens the product page.
- **AddToCartKey:** `look="onBand"` (the white clay key on a crimson band) and `label` (the key's words: «اشترِ {name}»);
  offline, the labelled key goes flat with «لا يوجد اتصال. أضف إلى السلة عند عودة الاتصال.» beside it, and a card
  button says the same in an error toast instead of flying (`offline` forces the state for previews). `onMessage`
  passes the tone too.
- **BuyBar:** `bare` — content only, to sit inside the shell's `<TaskBar>` (which owns the glass, the named region, the
  persisted name and the height it publishes); otherwise `aria-label` (a named region) and `data-motion-persist` are
  forwarded to its glass. A failed add says why on the variant's line (red-ink; the toast carries the retry) — the bar
  never grows; offline that line says «لا يوجد اتصال» and the key is flat.
- **PriceTag `size="page"`:** `status` (the stock line's words for a coming product) and `compareAtDemo` (no «توفّر»
  from a demo previous price); the struck price is its own 13px line.
- **UsedUnitCard `layout="row"`:** in a card narrower than 36rem (phones; each of two columns at 1024–1279) the
  «اعرض تقرير الفحص» link goes under the words, in line with them; an illustration says «صورة توضيحية» ON the 96px
  photo. **InspectionCard** `illustrationNote={false}`: the page already said the pictures are illustrations (the
  gallery's line), so the card leaves its photos part out.
- **ProofUploader** `primary`: the upload is the view's one step forward — «اختر صورة» (and «أكمل الرفع» / «أعد
  المحاولة») is the red primary. No 1.0 `ink` key left inside.
- **WishlistKey** `variant="text"`: a 40px ghost key «المفضلة» / «في المفضلة» with the heart (held = aria-pressed),
  for the product page's row المفضلة · قارن · مشاركة.
- **CartLineRow, WalletBalance, GovernoratePicker, TrustStrip:** amounts inside sentences are first-strong isolates.
  **TrustStrip** `transfer={{ zaincash, card }}` names only the methods that are switched on. **GovernoratePicker:**
  the arrow keys move through the rows without choosing or closing; a click, Space or Enter chooses and closes.
- **CompatBadge / CompatList:** the words of §4.1 — يعمل · يعمل جزئياً · لا يعمل · لم نتحقق; a row with `href` is one
  link to the device. **Swatches:** see `docs/ui/core.md`.

## Design System v2 (2026-11-11) — read this first

Where a section further down disagrees with this one, **this one wins**. Live, every state: `/design-system#commerce`.

- **ProductCard** — no frame: a square well (`Niche`, kind from `wellKind(card)`: box art, digital card, wide 1.9:1
  handhelds, hardware), the tag top-start, the kind line (`KindLine`: platform dot + «جهاز PS5»), the name (two lines,
  `headingLevel` default **3**), ≤2 facts, then price + the neutral add button (`CardAddButton`: a 40px outlined circle,
  bag-plus, a check after adding; «اختر نسخة…» opens the quick look when the product has options). States via
  `data-state`: in · sale (compareAt, shown only when real or in demo mode) · soon (`releaseAt` → «يصدر 18 تشرين الثاني
  2026» + «الطلب يفتح عند وصوله», `releaseDay(ms, locale)`) · out («نفد حالياً», no add). The wishlist heart is opt-in
  (`wishlist`, `wished`). A failed image shows «تعذّر تحميل الصورة» + retry. The whole card is one link (the well is
  inside it, so the shared-element zoom claims it). `layout="row"` for 96px rows. `ProductCardPlaceholder` keeps the
  geometry.
- **UsedUnitCard** — grid (grade tag on the well, «صورة توضيحية» when the picture is not the unit, battery and
  warranty facts, price, a report button) and row layout («اعرض تقرير الفحص»). Never an add button.
- **AddToCartKey / BuyControls / BuyBar** — `AddToCartKey variant="key"` (primary, bag-plus) or `"socket"` (the card
  button). The «أُضيف إلى السلة» toast comes AFTER the fly-to-cart lands (`onArrive`, 900ms fallback); a session
  memory marks items already added (hydration-safe). `BuyBar priceIqd releaseAt alternativesHref fixed`: after adding
  it reads «✓ في السلة» + «عرض السلة (n)»; sold out → «نفد حالياً» + «شاهد بدائل»; no stepper in the bar.
- **WishlistKey** — `onImage`, `size="xs"`, `message="none"` for cards; posts to `/api/wishlist`.
- **Gallery** — `Stage size="pdp"`: straight product, the counter «1 من 4» (polite live region after a change), a
  full-screen tool, thumbs (a radiogroup) under the stage; the viewer is opaque. Used units: the illustration line.
- **CartLineRow** — 120px well (`Niche size="sm"`), the name (a 44px link band), option, availability (Status or the
  problem line), Stepper sm, line total, «إزالة» → an undo row «تراجع».
- **OrderSummary** — new props: `lines` (64px wells), `couponField` (the «لديك رمز خصم؟» disclosure; use
  `CouponField`: a field + a SEPARATE 40px «طبّق»), `action` (the commit inside the card on desktop), `trust`
  (`<TrustStrip variant="line">`), `demo` (the demo order line). «الإجمالي» is the one red figure. Figures that do not
  reconcile → an error row, never a guessed number.
- **InspectionCard** — `newPriceIqd` («سعره جديداً في المتجر …»); battery as an ink bar; dates as «7 تشرين الثاني 2026».
- **ProofUploader**, **WalletBalance** — v2 surfaces; the wallet is a `Band kind="wallet"` with «اشحن الرصيد»
  (`topupHref`) and «سجل الحركات» (`historyHref`), a ledger with signed amounts.
- **Rail / ShelfRail** — `.rail`: a snap rail on phones, whole cards in one row from 1024 (no arrows over cards);
  `ShelfRail` = `SectionHead` + `Rail`, hidden below `minItems` (default 3), optional `chips`. **ShowMore** («عرضنا 24
  من 60», a bar, «اعرض المزيد») replaces numbered pages on listings.

Owner: commerce components (`app/ui/*` listed below, `app/ui/cart-client.ts`, strings in `app/i18n/messages/ui-shop.ts`).
Rules and tokens: `docs/UI.md`, `docs/DESIGN.md` §2, §9.5–9.6, §9.11–9.12, §9.18–9.20. Live, in every state, with sample
data (real product photos, demo-store ids): **`/design-system#commerce`** (also `/en/…`, `/ckb/…`).

Every component is SSR-safe, uses logical properties only, works in both themes, in `ar` / `en` / `ckb`, under reduced
motion, reduced transparency and the low-end tier, and takes its words from the `ui-shop` namespace (loaded on every
page by the root loader). Import each file directly: `import { ProductCard } from "~/ui/ProductCard"`.

Money is integer IQD everywhere. A figure that is not whole, non-negative dinars is never drawn as a number: the
components say "تعذّر عرض السعر" / "تعذّر التحقق من المجموع…" instead.

---

## ProductCard — `~/ui/ProductCard`

The one card (§9.5, reference `a.png`): a flat niche (3:2, the tag top-start), the name on two lines (height reserved,
Latin runs isolated with `<bdi>`), the fact line, then the price at the start and the red add key in its socket at the
end. No chrome. The card is ONE link to `/p/<slug>` (`MotionLink nav="zoom"`, the niche is the shared element
`product-image:<id>`); the add key is a separate control above the link's stretched area — nothing interactive is
nested.

| Prop | Type | Default | |
|---|---|---|---|
| `card` | `ProductCardData` (`~/lib/dto`) | — | from the catalogue read layer |
| `priority` | `boolean` | `false` | the first card above the fold only (eager + preloaded) |
| `sharedName` | `string` | `product-image:${card.id}` | the Gallery on `/p/<slug>` is the target |
| `slot` | `string` | — | the same product twice on one page (ShelfRail passes `shelf.key`) |
| `sizes` | `string` | phone 46vw → 210px | `sizes` of the picture |
| `headingLevel` | `2 \| 3 \| 4` | — | make the name a heading for the page outline |
| `demoNote` | `boolean` | demo rows while the store is live | the compact "تجريبي" note |

What the card shows, from the data: `badge` `new` → solid "جديد", `preorder` → outlined tag, `deal` → no tag (the
saving is words in the fact line: "توفّر 20,000 د.ع"; the old price is struck above the price); `stock` other than
`in_stock` → a status line ("الكمية محدودة", "نفد" in red-ink, "طلب مسبق"); `out_of_stock` → an empty socket;
`hasVariants` → the key opens the product page ("اختر خيارات {name}") instead of adding; `rating` only when not null.
Pictures: a cut-out floats with the contact shadow; an opaque photo (`transparent: false`), box art and screenshots sit
flat in their own frame (§12). A seven-digit price steps down to 15px in cards narrower than ~184px (rail cards on
phones), a six-digit one below ~152px, so price and socket share a row; at 360px a seven-digit price in a rail wraps
and the socket keeps to the end.

```tsx
<ProductCard card={card} />
<ProductCard card={cards[0]} priority />
{shelf.items.map((card) => <ProductCard key={card.id} card={card} slot={shelf.key} />)}
<Suspense fallback={<ProductCardPlaceholder />}>…</Suspense>        // same geometry, no grey skeleton (§7.2)
```

Also exported: `ProductCardPlaceholder`, `ProductImage({ image, alt?, sizes?, priority?, fit?, pose?, shadow? })` (one
`ImageRef` drawn the right way — `<Art>` for catalogue keys, `/media/<key>` for uploads), `BidiText({ text })`,
`priceFit(priceIqd)`. `BidiText` lives in `~/ui/BidiText` (docs/ui/core.md); this file re-exports it.

## UsedUnitCard — `~/ui/UsedUnitCard`

The same card for one used unit: the outlined grade tag ("مستعمل · ممتاز (A)"), battery and warranty in the fact
line, and — always — what the picture is: "صورة الجهاز نفسه" for a real photo, or "صورة توضيحية — ليست صورة الجهاز
نفسه" (warn) when the listing only has an illustration (`hasRealPhotos: false`). Real photos fill the niche (cover)
and are never lit. One unit = one add (`usedUnitId`). Props as ProductCard with `unit: UsedUnitCardData`; the shared
element is `used-image:<id>`, the link `/used/<slug>`.

## AddToCartKey, BuyControls, BuyBar — `~/ui/AddToCartKey`

Optimistic and never blocking (§7.2 "Fly to cart"): on press the badge count changes, the bead flies from the picture
(`flyToCart`) and the request is queued; taps on one item within 250 ms leave as ONE `POST /api/cart`
(`intent=add`, `qty` summed, max 10). When the server confirms: a check for 1.2 s, the live region says "أُضيف … إلى
السلة", and the cart toast offers "تراجع" (sets the line back). When it fails: the count rolls back, the bead flies
back, a red-ink sentence with "أعد المحاولة" follows the key and an error toast carries the same retry. A partial add
("only 3 left") says so.

| Prop | Type | Default | |
|---|---|---|---|
| `item` | `{ variantId } \| { usedUnitId }` | — | what to add |
| `name` | `string` | — | the accessible name and every message |
| `variant` | `"socket" \| "key"` | `"socket"` | the card's round key in its well · the labelled commit key |
| `qty` | `number` | `1` | units per press |
| `stock` | `StockState` | — | `out_of_stock` → empty socket / flat "غير متوفر" key |
| `chooseHref` | `string \| null` | — | needs a choice: a link to this page, adds nothing |
| `source` | `Element \| () => Element` | the key | where the bead leaves from (the picture) |
| `image`, `optionsLabel` | `ImageRef`, `string` | — | the toast's thumbnail and "name · variant" line |
| `size`, `block` | key variant | — | |
| `disabled` + `aria-describedby` | | — | not addable for another reason: say why next to it |
| `message` / `onMessage` | `"after" \| "none"` | `"after"` | place the failure sentence yourself |
| `onAdded` | `(cart, added) => void` | — | once per confirmed request |

```tsx
<AddToCartKey item={{ variantId: card.variantId }} name={card.name} source={() => niche} image={card.image} />
<AddToCartKey variant="key" item={{ variantId }} name={name} stock={stock} chooseHref={needsChoice ? `/p/${slug}` : null} />
<BuyBar item={{ variantId }} name={name} maxQty={variant.maxQty} maxReason="stock" source={() => stageImage} />
<BuyControls item={{ variantId }} name={name} qty={qty} onQtyChange={setQty} />     // desktop info column (§8.10)
```

`BuyBar` (reference `b.png`): live glass pinned to the bottom edge, top corners r-xl, the stepper at the start and the
full-width 52px commit key at the end; padded for the safe area. The product page hides the tab bar while it shows
(one bar per edge, §8). `fixed={false}` makes it sticky inside a scrolling box. `BuyControls` is the same row without
the glass. A used unit has no stepper.

Why `fetch` and not `useFetcher`: React Router 8 sends a fetcher's network error, a thrown 5xx or a path with no route
(an endpoint that does not exist yet) to the route's ErrorBoundary (`setFetcherError` in `router.js`), which would
replace the whole page because one add failed. Here every failure is a value that is rolled back and explained
(§9.16). The cart page follows changes through `useCartEditor` / `useCartView` instead of loader revalidation.

## cart-client — `~/ui/cart-client`

The browser side of the cart, shared by the keys, the shell's badge and the cart page.

```ts
const { count, bump, pending } = useCartCount();     // the bead: <b className="bead" data-cart-badge>{count}</b> inside [data-cart-target]
const outcome = await addToCart({ variantId, qty, locale });   // optimistic, coalesced, never throws: { ok, added, cart } | { ok: false, code }
await undoAdd(outcome, item, locale);                  // the toast's "تراجع"
const editor = useCartEditor(loaderData.cart, { locale, governorateId });   // rows, setQty, remove (undo row), restore, dismiss, view, pending
const cart = useCartView(loaderData.cart);            // a CartView that follows changes made anywhere on the page
onCartChange((cart) => …);  announce("…");  showShopToast({ kind: "added" | "error", … });
cartErrorKey(code);   // "errors.out_of_stock" … — the ui-shop sentence for a failure code
```

The count: root loader `cart.count` (hydration-safe) → the newest server answer → plus changes in flight; a fresh
root-loader read always wins (it is recognised by object identity, so "0 after checkout" is taken even if the page
started at 0). `tt:cart-received` (dispatched by the Motion Engine when a bead lands) bumps `bump` for the squish.
The one polite live region for cart feedback is created on first use and stays live above sheets and dialogs.

## WishlistKey — `~/ui/WishlistKey`

`<WishlistKey productId name initial? onChange? size? />` — the round favourite key (held = filled heart,
`aria-pressed`). Optimistic toggle → `POST /api/wishlist` (`intent=toggle`, `productId`; expected answer
`{ ok: true, wished }`). **That endpoint belongs to the account area and does not exist yet: every toggle currently
fails honestly** — the heart goes back, a sentence beside the key and an error toast say "لم نحفظ التغيير في المفضلة.
هذه الخدمة غير متاحة الآن…", with a retry. Never on a product card (one walled key per card).

## ShelfRail — `~/ui/ShelfRail`

`<ShelfRail shelf={Shelf<T>} href? viewAllLabel? renderItem? headingLevel? emptyText? fade? />` — the title and the
honest `reason` line ("متوافق مع Nintendo Switch 2", "اقتراحات المتجر"; never "customers also bought" without real
data) at the start, the one "عرض الكل" link at the end, then `~/ui/Rail` (native scroll-snap, arrow keys, step keys
from 1024px, edge fade). An empty shelf renders nothing, or `emptyText` — never placeholder products.

## PlatformBank — deleted (stage 4, 2026-11-12)

The 1.0 platform keys are gone: the doors are `PlatformTile`s (`docs/ui/showcase.md`; `selected` for toggles, as the
intro uses them).

## Gallery — `~/ui/Gallery`

The product page's Lit Stage (§2, §9.6, `b.png`): the picture in its platform's light; inside the stage at the bottom
the caption (one word — "الرئيسية", "الغلاف", "في العلبة"), the thumbnail keys in a well (the current one held with an
ink ring), "1 من 4". Swipe (direction follows the reading direction), the thumbnails, or ← → on the focused picture.
Tapping opens the full-screen viewer — a layer of the shared modal stack (`~/ui/Dialog`): opaque floor, the thumbnails
in a glass strip, zoom key / double-tap, Escape and focus return.

| Prop | Type | Default | |
|---|---|---|---|
| `name` | `string` | — | alt fallback, viewer title |
| `items` | `{ image: ImageRef; caption? }[]` | — | catalogue photos (`artKey: "<slug>--<n>"`) or uploads |
| `gel` | `Gel \| null` | `null` | the light (ignored for used units) |
| `evidence` | `"product" \| "used"` | `"product"` | used: unlit, and the honesty line under the stage |
| `sharedName` | `string` | — | `product-image:<id>` — the card's morph lands here |
| `top`, `flush`, `priority` | | | orbs, square top corners, LCP |
| `index` / `defaultIndex` / `onIndexChange` | `number` | | controlled or not |

`evidence="used"`: each picture is labelled under the stage, in full: "صورة الجهاز نفسه" or (warn) "صورة توضيحية — ليست
صورة الجهاز نفسه". Put real defect photos first. Pure helpers: `stepIndex`, `swipeStep`, `arrowStep`.

## PriceTag — `~/ui/PriceTag`

`<PriceTag priceIqd compareAtIqd? size="card" | "line" | "page" deliveryIqd? aside? showSaving? approx? />` on top of
`<Price>`: ink, Kufam 700, never red, never animated. A genuine reduction shows the old price struck in ink-2 (above
the price on cards) and the saving as words; `size="page"` puts the delivery fee and `aside` (a StockNote) beside the
price. Also: `SafePrice` (Price that refuses a broken amount), `SavingNote`, `DeliveryNote` ("التوصيل 5,000 د.ع لكل
المحافظات" — pass the configured fee), `fillNodes(template, nodes)`, `iqdText(f, amount)` (an amount inside a
sentence, number then currency, like `<Price>` — it is `f.iqd(amount)`; wrap it in `<bdi>` or U+2066…U+2069), `isIqd`.

## StockNote, CompatBadge, RatingStars, GradeBadge, DemoNote

```tsx
<StockNote stock="in_stock" detail={t("warranty")} />     // dot + words; never an exact number; notifyTo only when a back-in-stock service exists
<CompatBadge status="partial" device="PlayStation 5" note={rule.note} />   // icon AND words; "unverified" is a real answer
<RatingStars rating={card.rating} />                       // renders nothing unless real, approved reviews exist
<GradeBadge grade="B" legend />                            // outlined "مستعمل · جيد جداً (B)" + a popover legend of all grades
<DemoNote /> · <DemoNote compact />                        // "بيانات تجريبية" — for anything seeded or sample
```

## CartLineRow — `~/ui/CartLineRow`

`<CartLineRow line removed? busy? error? onQtyChange onRemove onRestore onDismiss actions? as? />` — a paper row
(§8.5): thumbnail in a niche, the name (a link) and its facts ("{price} للقطعة" when qty > 1, "قطعة واحدة" for a used
unit), the line total, the small stepper (`max` = `line.maxQty`; "بقي N فقط" at a stock limit) and "أزل". Problems:
`out_of_stock` / `unavailable` → red-ink sentence, "لا يُحتسب في المجموع" instead of the total, no stepper (checkout is
blocked); `qty_reduced` (warn) and `price_changed` (info) are notices. `removed` → the undo row "أزلنا … من السلة."
with "تراجع" and a hide key. Focus never falls to the page (removed → "تراجع"; hidden → next row; restored → its
name). Feed it `useCartEditor().rows`.

## OrderSummary — `~/ui/OrderSummary`

`<OrderSummary subtotalIqd discountIqd shippingIqd totalIqd count? coupon? shipping? pending? approx? title? headingLevel? />`
— spread a `CartView` straight in. Paper, tabular, label at the start and amount at the end; the discount as
"−50,000 د.ع" with the coupon's label; delivery "5,000 د.ع — لكل المحافظات" (`shipping`: `flat` · `governorate` ·
`pending` · `unserved`); the total in dinars (a labelled "≈ …" line under it when another display currency is chosen,
`approx="off"` to drop it). Figures are checked first (`totalsReconcile`: whole dinars, discount ≤ subtotal, total =
subtotal − discount + delivery); if they do not reconcile, the total is replaced by an explicit error row.
`pending` says "جارٍ تحديث المجموع" — the numbers never move. `children` go under the rows (a coupon field).

## ProofUploader — `~/ui/ProofUploader`

`<ProofUploader onUpload status? current? onUploaded? title? maxBytes? disabled? defaultState? />` (§9.18). Drag and
drop, "اختر صورة", and "التقط صورة" (camera, on touch screens). The file is checked here first — JPEG, PNG or WebP up
to 8 MB, the server's own limits (`~/server/uploads.server`; HEIC is not accepted there, so it is not offered) — then
previewed and handed to `onUpload(file, { signal, onProgress })`, the only way the component talks to anything. It
must resolve `{ ok: true, previewUrl? }` or `{ ok: false, code }` (the server's `upload_*` codes, `network`,
`timeout`, `rate_limited`). States: empty · dragging · uploading (name, ink progress bar, %, "ألغِ") · interrupted
("توقّف الرفع عند 60%." + "أكمل الرفع" — the same file is sent again; it continues from where it stopped only if your
`onUpload` can resume) · failed (the reason; retry only when it can help) · uploaded (thumbnail, name, "استبدل الصورة").
`status` adds the review: submitted (warn + "استلمنا صورة الحوالة. نراجعها ثم نؤكد طلبك."), approved (ok, nothing to
replace), rejected (bad + the reviewer's reason + the uploader ready again).

```tsx
<ProofUploader
  onUpload={(file, controls) => sendProof("/api/upload/proof", { ref: order.ref, token }, file, controls)}
  status={order.proof ? { state: order.proof.status, note: order.proof.reviewNote } : null}
  current={order.proof ? { previewUrl: order.proof.previewUrl, fileName: null } : null} />
```

`sendProof(url, fields, file, controls)` posts multipart data with XMLHttpRequest (fetch cannot report upload
progress) and reads the JSON ActionResult. **The endpoint `POST /api/upload/proof` belongs to the checkout area and
does not exist yet.** Pure: `checkProofFile`, `proofFailure`, `proofReducer`, `PROOF_IDLE`, `PROOF_TYPES`,
`PROOF_MAX_BYTES`.

## WalletBalance — `~/ui/WalletBalance`

`<WalletBalance balanceIqd pendingIqd? entries? payIqd? compact? signInHref? footer? headingLevel? />` (§9.19). A paper
panel: "رصيد المحفظة", the balance in price type (never editable), top-ups under review on their own warn line, the
ledger (entry kind, order reference, date, signed amount — "−675,000" in red-ink for money spent). `entries` are
`WalletEntryView` rows of `listWalletEntries` (shape repeated as `WalletEntry`, so no server import). `payIqd` says
what remains or how much is missing; `compact` is the payment option row's content. `balanceIqd={null}` → a guest:
one sentence and a sign-in link. Pure: `signedAmount`, `walletAfter`. `pendingIqd` has no service yet (pending
top-ups are rows of `wallet_topups`; the account area adds the read).

## InspectionCard — `~/ui/InspectionCard`

`<InspectionCard grade inspectedAt batteryHealthPct checklist defects? included? photos warrantyDays returnDays?
ownershipChecked? dataWiped? isDemo? headingLevel? />` (§9.20). The grade tag with its legend, the inspection date,
the real photos ("هذه صور الجهاز نفسه الذي يصلك.") — or the plain statement that none exist yet; the checklist (check
or alert icon AND words), battery health as a percentage with a meter or "غير قابلة للقياس", ownership and data-wipe
checks, defects in words with their photos first, what is included, the warranty and return sentences. Nothing is
animated; there is no prop for serial numbers. The used area maps `used_units` onto these props. Pure: `batteryPct`,
`realPhotos`.

---

## Verification

```
npm test -- tests/ui-shop.test.ts            count model, coalescing, /api/cart answers, totals check, proof state machine, badges, i18n keys
node scripts/lint-design.mjs                 design rules (no findings in these files)
node scripts/shot.mjs http://localhost:5173/design-system .shots/x.png 390 844 --selector=#commerce-cards   (and 1440, --dark, /en, /ckb)
```

Interaction checked in headless Chromium against the dev server (demo database): three rapid taps → one request with
`qty=3`, the bead count at once, check mark, cart toast, "تراجع" sets the line back; an unknown id rolls the count
back with the sentence, retry and error toast; the wishlist toggle returns and says the service is unavailable; the
viewer traps focus, steps with the arrows, Escape returns focus to the picture.

## Not built / boundaries

- `POST /api/wishlist` (account area), `POST /api/upload/proof` (checkout area): the components talk to them and fail
  honestly until they exist.
- Back-in-stock ("أعلمني عند التوفّر"): no service, so `StockNote` shows the link only when given `notifyTo`.
- Quick-preview sheet for products with options (§9.5): the key opens the product page instead.
- Pending wallet top-ups: no read service yet (`pendingIqd`).
- Nothing measured on a phone; Chromium only; the Sorani copy needs a native reader (§11).
