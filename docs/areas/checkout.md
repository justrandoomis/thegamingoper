# Checkout area

Owner: checkout. Cart, guest checkout, order confirmation, guest tracking and the transfer proof upload (brief §4,
§12, §14; Design System v2 §6.10, §6.11, §5.8 — the redesign spec `…/scratchpad/ux/design-v2-spec.md`). UI over the
commerce core only (CONTRACTS §1): nothing here writes a commerce table, prices anything or decides access —
`checkout.server.ts` reads, `placeOrder` / `submitPaymentProof` write. Files: `app/routes/storefront/checkout/**`,
`app/routes/api/upload-proof.ts`, `app/i18n/messages/checkout.ts`, `tests/checkout-flow.test.ts`,
`tests/checkout-extras.test.ts` (the points / referral / wallet-split fields, 2026-11-12), `tests/commerce-core-security.test.ts`
(the core's security review of 2026-11-12: the codes, the referral checks, the landing after checkout).

## Routes

| Path | Shell | What |
|---|---|---|
| `/cart` | store (`tabBar: false` + a `<TaskBar>`; the tab bar comes back on an empty cart) | h1 «السلة (3)»; a warning `StockNotice` when lines cannot be bought (by name, the total now, «أزل غير المتوفر»; the key waits); the kit's `CartLineRow`s (96/120px wells, the option value only, availability, the clay tray, line total, «إزالة» + undo row); the kit's `OrderSummary` (rows — «المجموع الفرعي» counts what can be bought, `payableCount` —, «الإجمالي» the one red figure, the discount code behind «لديك رمز خصم؟» — a code below its minimum says how much more —, every discount in the saving colour, `TrustStrip line`); under the card two `Note` lines: the delivery rule and the demo-order line; one recommendation rail. Below 1024 the task bar holds «الإجمالي» + the total and the glossy «إتمام الطلب»; from 1024 the summary is the sticky 5-column side with the primary inside it. **Empty (client note 7):** the visible title «السلة», the kit's `EmptyState panel` across the column (the mascot in its circle, «سلتك فارغة» in Kufam, «اختر منصّتك وأضف ما يعجبك، ثم عد إلى هنا.», the centred glossy «تسوّق الأجهزة ←»), «طلبت من قبل؟ تتبّع طلبك» under the card, then the store's four picks («مختارات المتجر») |
| `/checkout?step=address\|payment\|review` | checkout (`chrome: "checkout"`): the shell's one 56/64px bar carries the step rail | Below 1024 a 48px summary bar on `--niche` under the bar (`components/SummaryBar.tsx`, a native `<details>`: «ملخص الطلب · قطعتان», the total, the items on demand) + the task bar «الإجمالي» + the step's glossy primary («تابع إلى الدفع ←» · «راجع الطلب ←» · «✓ أكّد الطلب», «جارٍ تأكيد طلبك…» with the spinner while it is sent); from 1024 7/5 columns, the sticky summary with the items, the coupon, the primary («أكّد الطلب · 1,513,750 د.ع» on review), the trust line and, under the card, the demo-order note. One heading per step (the step's question is the h1); each step's fields in soft section cards with an icon head (`Section` in CheckoutSteps). Every step's key works only while every line can be bought (`cartReadiness`) |
| `/order/:ref` | store | `?t=<accessToken>` (guest) or the signed-in owner; anyone else the same 404 «تعذّر فتح هذا الطلب» (a `Note` with its two exits: look it up · sign in). The thank-you head: the kit's `SuccessMark` (the disc inflates, the check draws itself; finished under reduced motion), h1 «شكراً، استلمنا طلبك», the order number on its own soft card («رقم الطلب» + «طلب تجريبي» at the end, the code in `type-code` with «انسخ», the date, «انسخ رابط الطلب» with its hint), the calm demo `Note`; then the order status template; help as two of the before's rows (`EntryCard icon`: «تحدّث مع موظف», «تتبّع طلبك»), the quiet account card, «تابع التسوّق» (the page's primary unless a proof is due), at most one rail of four |
| `/track` | store | A centred 560px card: «رقم الطلب», «رقم الموبايل», the primary «اعرض الطلب»; what the lookup shows as three icon rows; «لديك حساب؟ طلباتك كلها في صفحة حسابي» as a note line. Found: focus on the result heading (the order number on its soft card with «طلب تجريبي» and the date), the form folds into «ابحث عن طلب آخر» (a link to `/track`, so it works without script), the order status template read-only — the order page's look. Not found: one sentence for either wrong half. A missing phone says «اكتب رقم الموبايل الذي طلبت به.» |
| `POST /api/upload/proof` | — | multipart `ref`, `t?`, `declaredAmountIqd`, `reference?`, `note?`, `file` → `{ ok: true, previewUrl }` or `{ ok: false, code, fields? }` (unchanged; order of work in `proof.server.ts`: size + per-IP limit → fields → access → per-order limit → `canUploadProof` → `saveImageUpload` private → `submitPaymentProof`; a refusal after storing deletes the file; `duplicateOf` never leaves the server) |

All four pages: `shellMeta(…, { noindex: true })`, `Cache-Control: no-store`, strings in `checkout` + `errors` (+ the
kit's `ui-shop` demo-order line). Page CSS: `checkout.css` (components layer, tokens only; one spacing scale — 8 inside a
field and its note, 16 in a card (24 from 768), 20 between cards, 24 between a page's blocks): the 7/5 split, the empty
cart's column, the section cards' insides (`.co-sec`), the icon rows (`.co-fact`), the summary bar, the transfer steps
and values, the stock list, the order number card (`.co-ref`), the status rail (`.co-progress`, `.co-stages`), the
tracking card, and the script on/off switches (`.co-js` / `.co-nojs`, from `<html data-motion>`). Side information is the
kit's `Note` everywhere (v2.1 G5): the guest note, the saved address, the delivery fee under the governorate, the wallet
for guests, the transfer rule, the fraud warning, the card warning, «لا نقاط لديك بعد», the demo-order line, the
next step of an order. Cart → checkout steps → order is one sideways-push group (`handle = { nav: "push", order, group:
"checkout" }`).

## The checkout, step by step (§6.10; v2.1, client note 8)

1. **التوصيل** — h1 «إلى أين نوصل طلبك؟» → the guest note (the kit's `Note`: the bag in its clay circle, «أكمل الطلب بدون
   حساب.», «الحساب اختياري: يحفظ عناوينك ويتيح الدفع من المحفظة وتتبّع طلباتك في مكان واحد.», «سجّل الدخول ←» on its own
   line; signed in: «أنت مسجّل الدخول برقم …») → the error summary (`FormErrorSummary`, only after «تابع») → the card
   «بيانات التواصل» (phone icon: «رقم الموبايل», hint «نستخدمه للتواصل بخصوص طلبك فقط. مثل 0770 123 4567.»; «اسم المستلم
   (اختياري)»; the marketing consent about that number, unticked) → the card «عنوان التوصيل» (pin icon: the saved-address
   note with «ابدأ بعنوان فارغ»; `GovernoratePicker` — a native `<select>` without script — with the fee as a note line
   under it; district `address-level2`; area; «العنوان بالتفصيل»; «ملاحظات للمندوب (اختياري)»; `PreferencePicker`, the
   period only: no dispatch days are configured, so no day or date is offered; «وقت مفضّل وليس موعداً مؤكداً.»; signed in,
   with an address that is not the saved one as it is: «احفظ هذا العنوان لطلباتك القادمة», unticked).
2. **الدفع** — `OptionCard pay` (72px, a word mark, never a logo) in this order, only enabled methods: الدفع عند الاستلام
   (chosen when it is on and nothing was chosen before) · محفظة طمطم (signed in: the balance and what remains; disabled with
   the shortfall when it does not cover the total) · تحويل إلى بطاقة ماستركارد · زين كاش. Guests: the wallet as a note line
   with «سجّل الدخول لتدفع منه ←». A transfer opens the card «كيف يتم الدفع بالتحويل» (bank icon): «1 أكّد الطلب · 2 حوّل
   {total} · 3 ارفع صورة الحوالة من صفحة الطلب» on clay discs, the rule as an info note («لا يُعتبر الطلب مدفوعاً حتى يتحقق
   موظف من الحوالة.» + the hold), where to send it (grouped numbers, a copy key each) and the fraud warning (warning note).
   The card «نقاطك» (star icon; the balance counted up once). «لا نطلب منك رقم بطاقتك…» as a note line. No card field, ever.
3. **المراجعة** — the cards «التوصيل» (truck icon) and «الدفع» (wallet icon), each with a clay «عدّل» key (pencil; named
   «عدّل التوصيل»…) and icon rows (phone, recipient, place, address, notes, time; the method with its icon), the card
   «المنتجات (قطعتان)» with the lines editable in place (the kit's cart editor with the items' pictures, priced for the
   chosen governorate: the tray, «إزالة» + undo), «لديك رمز إحالة من صديق؟», below 1024 the summary (every discount in the
   saving colour with its icon), «بتأكيد الطلب توافق على الشروط وسياسة الإرجاع», the demo-order note, «✓ أكّد الطلب»
   (glossy; «جارٍ تأكيد طلبك…» with the spinner in the check's place while it is sent).

- **State:** the draft lives in the page and in this tab's `sessionStorage` (`tt:checkout`); the order page clears it. A
  step change is a `?step=` change with no loader call; Back walks the steps; a deep link to a later step falls back to
  the first unfinished one. A stored day that is no longer offered is dropped (`withOfferedDay`).
- **Checks:** on blur, again on every keystroke once a problem shows; «تابع» lists the step's problems in one alert and
  focuses the first field. The server checks everything again; its field errors land on the right step.
- **Totals:** always the server's CartView. Choosing a governorate re-prices through `GET /api/cart?governorateId=`; cart
  edits and the coupon answer priced for it too. The key waits («جارٍ تحديث الإجمالي…») while a change is in flight;
  `expectedTotalIqd` = the total on screen; `totals_changed` shows the fresh cart and asks again.
- **Stock (client round 1, QA):** every step's key works only while every line can be bought (`cartReadiness`:
  ready · blocked · empty); otherwise it is flat and says why. Lines in the cart that cannot be bought are named in one
  warning note on every step and on the cart («بعض ما في سلتك لم يعد متوفراً» · «…: نفد من المخزون.» · «الإجمالي الآن …»)
  with «أزل غير المتوفر» (`useRemoveUnbuyable`: out through the cart editor, no undo row — there is nothing to put back).
  A refusal about stock at «أكّد الطلب» comes with the cart as it is now: by name what sold out (taken out) and what came
  down («خفّضنا الكمية من 3 إلى 1، وهي ما بقي.» — `stockChanges` against the cart the shopper confirmed), the total now,
  «راجع الإجمالي ثم اضغط «أكّد الطلب» مرة أخرى.»; the shopper confirms again with the new total. Nothing left to buy:
  the empty state on every step — the lines named, «تسوّق الأجهزة» and «عدّل السلة», no step key and no total of 0.
- **Idempotency:** one attempt key per checkout and per cart, resent on any retry; a lost answer offers «اعرض طلبي» on the
  empty cart (the core answers with the order it placed).
- **Saving the address** (signed in, ticked, a NEW order): `saveCheckoutAddress` → the account area's `saveAddress`, after
  `placeOrder`, never inside it; a refusal (book full, a field over the book's limits) is logged, the order is untouched,
  and the order page says «لم نحفظ هذا العنوان في دفتر عناوينك…» (`&address=0`).
- **Without script:** all three steps show (`.co-step` hiding needs `<html data-motion>`), the governorate is a native
  select, the steppers and removal hide, one plain post places the order; refusals come back with the values and the
  error summary, each field in the page's own words where its checks agree with the server's («اكتب رقم موبايلك.», not
  the generic «هذا الحقل مطلوب.»). The review's delivery and payment summaries (`co-js`) and the phone foot's terms line
  need script — every field is on screen and the terms sit once above the plain-post key. The district list and the
  proof upload need script.
- **Offline:** the keys go flat with «لا يوجد اتصال. تفاصيلك محفوظة…»; the shell's banner uses its form copy.

## The order status template (`components/OrderDetails.tsx`, §6.11)

Shared by `/order/:ref` (mode `owner`) and `/track` (mode `tracked`): the status rail — the five real stages (استلمنا ·
تأكيد · تجهيز · في الطريق · تم التسليم — `orderStage(status)`; waiting for a transfer or its check is still «استلمنا»;
none for a cancelled or returned order), each a 40px circle with its icon (receipt · seal-check · package · truck ·
house; reached ones ink, the current one ringed, the next ones raised clay) and its name under it, joined by a line that
fills to where the order is (`--progress`, `scale` from the reading start — `transform-origin` from `--dir`; it draws
itself once in 700ms under `data-motion="full"`, drawn at once otherwise) → the next step as the kit's `Note`, its tone
and icon by the state (COD «سنؤكد طلبك قبل تجهيزه. تدفع {total} نقداً عند الاستلام.»; a transfer: where to send it, the
deadline, the amount-first `ProofSection`/`ProofUploader`, then «بانتظار التحقق»; tracked mode says the upload needs the
confirmation link) → shipments → ONE summary card (the kit's `OrderSummary` with the lines and their pictures — the name
as sold split by `splitLineName` into the product's name and its option value, then the line's facts —, every discount
in the saving colour, and payment and delivery side by side from 1024 as icon rows (`components/Fact.tsx`), their
headings one level under the card's) → refunds → the dated history behind a `Disclosure` (each event in a small clay
circle). English status `cod_due` reads "Due on delivery". The order page's link hint speaks
of the transfer photo only while a proof is due; its account aside is two sentences («…ويجمع طلباتك القادمة…»,
«يبقى هذا الطلب متاحاً عبر رابطه وصفحة التتبّع.») and «أنشئ حساباً» → `/account/signup`. A demo order found on
`/track` carries the «طلب تجريبي» tag, as on its own page.

## States (§6.17)

| | Cart | Checkout | Order | Track |
|---|---|---|---|---|
| Loading | keys keep their width (kit loading); totals «جارٍ تحديث المجموع» | the same; the key waits for pricing and edits | streamed rail only | the submit key spins |
| Empty | the title «السلة», `EmptyState panel` «سلتك فارغة» + «تسوّق الأجهزة» (→ `/c/consoles`), «طلبت من قبل؟ تتبّع طلبك» under the card, four picks; the tab bar shows | the title, `EmptyState panel`, «تسوّق الأجهزة» → `/c/consoles` (+ «اعرض طلبي» after a lost answer); nothing left to buy: the warning note naming the lines + «تسوّق الأجهزة» + «عدّل السلة», no step key | — | — |
| Validation | — | inline + the error summary | — | per field; phone «اكتب رقم الموبايل الذي طلبت به.» |
| API failure | the coupon's refusal (below its minimum: how much more); a failed edit rolls back with a sentence | coupon / stock race (by name, the total now) / totals changed notes | upload refusals in the uploader | the not-found sentence; rate limit |
| Offline | the key flat + reason; the shell banner | the keys flat + reason; the draft stays | banner | the key flat + reason |
| Success | — | the order page | the thank-you header | the found order |
| Pending review | — | — | «بانتظار التحقق» | the same, read-only |
| Unauthorised | — | sign-in is a link, never a wall | the tokenless 404 with two exits | — |
| Sold out / soon | lines «لا يُحتسب في المجموع», named in the warning note with «أزل غير المتوفر», the key blocked with its reason | the same note on every step, every step's key blocked; on a race taken out by name (no undo row), the total now | — | — |
| Demo | the demo-order note under the summary | «طلب تجريبي» (bar) + the note | the tag on the number's card + the calm demo note | the tag on the found order |

## Promotions, points, split payments, digital codes (2026-11-12, commerce core)

Everything is priced by the core (`getCartView` / `placeOrder`, CONTRACTS §1) — the pages only show it, as charged:

- **Cart lines**: a flash-priced line says so under its name («عرض سريع (تجريبي): سعر العرض حتى …، بدلاً من 62,250 د.ع»,
  and how many units the price still covers — `withFlash`); «نقل إلى المفضلة» beside «إزالة» (`components/MoveToWishlist`:
  `POST /api/wishlist` then the editor's removal with its undo row; variant lines only).
- **The summary** (`components/Adjustments.tsx`, under the kit `OrderSummary`'s rows — the kit shows one discount row):
  every part of «الخصم» on its own line (an offer, the coupon, the membership discount with its rate, the redeemed
  points), the delivery a membership or an offer waived (words only: «التوصيل مجاني لعضوية … بدلاً من 5,000 د.ع» — the
  delivery row already shows 0), and a split payment's two parts («من محفظة طمطم» · «الباقي للدفع»). Since client round 1
  every part is listed (the coupon too), one line each — its icon, its name, its amount, in the saving colour — and the
  kit's discount row is the total «الخصم»; `summaryCoupon` names a coupon there only for an order without itemised
  discounts. The coupon's own words (its admin description, one language) are never a summary row: on Arabic pages they
  sit under the applied code in the coupon field (`CouponForm`), elsewhere not at all (review 2026-11-13). A coupon a better non-stackable
  offer beats is kept and named («لا يُجمع الرمز … مع عرض «…»، فطبّقنا العرض الأفضل لك.»). On the cart, the cart and checkout sticky summaries, the
  review, the order page, /track and the account's order page.
- **Payment step**: «نقاطك» for a signed-in customer with points (`PointsBox`: the balance and its worth, the field —
  Latin or Arabic digits — «استخدم 3,000», «لا تستخدم نقاطي», what comes off; the page re-prices through `GET
  /api/cart?points=`), and «ادفع … من رصيد محفظتك، والباقي بالطريقة التي تختارها» when the wallet holds part of the total
  (`useWallet` → `walletIqd`). **Review step**: «لديك رمز إحالة من صديق؟» (a disclosure; «تحقق» checks it against the core
  and says why a code cannot be used). Field errors map back to their step (`walletIqd` → the wallet box).
- **Order page**: «رموزك الرقمية» once paid — each code behind «اعرض الرمز» (`components/DigitalCodes.tsx`, `intent=reveal`
  on the page's own route with the token or the owner's session; rate-limited and audited by the core; «انسخ» after);
  revoked codes say so; units still waiting for a code are counted. /track shows that codes exist but opens none.
  The stored transfer proof is shown again after a reload (`storedProofPath`).
- Without script: the points field, the wallet box and the referral code post with the form (`draftFromPosted`); a
  reveal needs script (it is a fetcher on the order page).
- **Nothing to pay** (core review 2026-11-12): when points and free delivery bring the total to 0 the payment step offers no
  bank transfer or Zain Cash (the core refuses a transfer of 0 — `payment_method_unavailable` on the field), cash on
  delivery places the order already paid, and the order page's next step says «استلمنا طلبك» / «نراجع طلبك ثم نؤكده.» (no
  «تدفع 0 د.ع نقداً»: the cash line shows only while the payment is `cod_due`). A cancelled order's codes are revoked and its page
  offers none («اعرض الرمز» gone; nothing due). Verified in Edge at 1440 ar and 390 en (light, and the cancelled page in
  dark): scripts and shots in the session scratchpad `work/f2-core-review/`.
- **Security review 2026-11-12** (`tests/commerce-core-security.test.ts`, SECURITY §18):
  - An ACCOUNT's order opened with its link (nobody signed in as its owner) shows its codes but no «اعرض الرمز»: the
    codes card says «هذا الطلب مرتبط بحساب: تفتح رموزه لصاحب الحساب بعد تسجيل الدخول…» with «سجّل الدخول لعرض الرموز»
    (→ `/account/login?next=/order/<ref>`) — the loader's `codesSignIn` (`codesNeedSignIn`, the core's
    `orderCodesOpenWith`); a guest's order keeps «اعرض الرمز» behind its link. /track's sentence says the codes open
    from the account, or from the link of an order placed without one.
  - A signed-in shopper's checkout lands on `/order/<ref>` WITHOUT the token (`?address=0` when the address was not
    saved); a guest still lands on the link.
  - A revoked code says why in words true for the order: «أُلغي هذا الرمز لأن الطلب أُلغي أو أُعيد.» on a cancelled or
    returned order (`DigitalCodes closed`), «…مع الاسترداد.» otherwise; its tag is the short «ملغى».
  - The review's referral check posts its code (`POST /api/cart intent=price`) instead of a `?referral=` URL; the hint
    says the store reviews the referral before rewarding its owner.

## Exports other areas use (keep their signatures)

- `checkout-form.ts`: `STEPS`, `stepOf`, `stepIndex`, `Step` (the shell's checkout rail), the draft helpers,
  `optionValue` / `splitLineName` (a line's option value), `parsePoints` (2026-11-12).
- `components/Adjustments.tsx` (`Adjustments`, `summaryCoupon`, `withFlash`, `discountLabel`) and
  `components/DigitalCodes.tsx` — the account's order page shows them too (they import `checkout.css` themselves; a page
  using them returns `i18n: messagesFor(locale, "checkout", "errors")`).
- `checkout.server.ts`: `revealCodeForShopper(db, ctx, { ref, token, customerId, codeId })`, `storedProofPath`,
  `codesNeedSignIn(db, found)` (security review 2026-11-12). `DigitalCodes` takes `closed?` and `signInRef?` (both
  optional; `OrderDetails` passes them — `codesSignIn?` on `OrderDetails`).
- `checkout.server.ts`: `addressPrefill`, `cartShelves`, `recordPurchase`, `confirmationPath` (tests and the integration
  wiring), `NO_STORE`.
- `proof.server.ts`: `handleProofUpload`, `MAX_PROOF_BODY_BYTES`.
- `checkout.tsx` `action`, `order.tsx` `loader` (adversarial tests: the two 404s carry the same keys).
- Client round 1 (2026-11-13, new, all additive): `checkout-form.ts` `cartReadiness`, `stockChanges`, `StockChange`,
  `BLOCKING_PROBLEMS`, `COUPON_MINIMUM_INTENT`; `checkout.server.ts` `couponShortfall(db, request, code, now, cart?)`,
  `answerCouponMinimum`, `CouponShortfall`, `CouponMinimumAnswer`; `components/StockNotice.tsx`, `components/Fact.tsx`
  (an icon row of a `.co-facts` list), `components/useRemoveUnbuyable.ts`; `CouponForm` takes `shortfall?`,
  `couponIssueText` two optional arguments, `CommitKey` `icon?` / `iconEnd?` / `busyLabel?`. The cart and the checkout
  answer `POST intent=coupon-minimum code=…` (`{ ok, shortfall }`; 30 a minute per address); the coupon field of both
  pages posts it to the CART route, whose `clientAction` turns a failed request into `{ ok: false, code: "network" }`
  (review 2026-11-13: a fetcher's failed action showed the error boundary in place of the page).

## Real, demo, boundary

- Real: guest checkout, all four methods as switched in settings, stock holds, idempotency, proof upload to private
  storage, tracking, rate limits, saving the address to the book.
- Demo: prices and stock; orders placed in demo mode say «طلب تجريبي» on the order page.
- Boundary: linking a guest order to an account needs a phone code — no SMS provider; the order page does not promise
  it (it says the order stays reachable by its link and /track, and that an account gathers the next orders). No notice
  when staff approve or reject a proof (no provider). Dispatch days: no setting exists, so no day is offered.
- The stored proof is shown back from the upload answer's `previewUrl` during the visit, and after a reload from
  `latestProofFileId` + `shopperFilePath` (`storedProofPath`, 2026-11-12).
- Points, memberships, offers, flash sales, gift cards and digital codes are the store's own records (module 08 / 13);
  the demo ones say «(تجريبي)» in their names. Digital stock: imported codes add no stock count yet (module 13 request) —
  a digital product sells only as far as its stock row allows.

## Verified (2026-11-12, headless Edge against the dev server; scripts in the session scratchpad `work/pages-P6-checkout/`)

- `npx vitest run tests/checkout-flow.test.ts` — 22 tests on a real local D1 + KV (16 before, plus: the v2 form rules,
  option values / stages / digit groups, one rail, the cart's facts, saving the address, the cart rail over the demo
  catalogue). Assertions changed on purpose: the page data offers no days (`page.days` is `[]`, §4.9 / §13 #5).
- `flow.mjs`: cart edit + remove + undo; a refused and an applied coupon; guest COD (error summary + focus, COD
  preselected, the thank-you, no call promise); a Mastercard transfer with the panel and a proof upload → «بانتظار
  التحقق»; Zain Cash waiting for the proof; the wallet as the signed-in demo customer; the order by its token and
  without it; /track with a wrong and the right phone; the checkout without script (errors back, then an order); offline
  review.
- Screenshots (`…/scratchpad/ux/after/P6-checkout/`, `m-<page>-<width>-<theme>-<lang>.png`): cart, empty cart, the three
  steps, the empty checkout, three order states and /track at 360/390/768/1024/1440 in light and dark (ar) and 390/1440
  in en and ckb — no horizontal overflow, no console error or hydration warning on these pages.
- Census (`<main>`, ar light/dark 390/1440, en/ckb): sizes on the §2.6 scale, Noto Kufi 700 + Plex 400/600 only, radii in
  {8, 12, 20, 28, full, 6}, ≤ 2 shadow recipes, no image filter, every `<img>` sized, no target under 44px, no Arabic run
  under 13px (the 12px 600 tags and word marks excepted), no text contrast failure.
- Focus walk: every Tab stop of the three steps, the cart, the order and /track at 390×844, 390×420 (keyboard open) and
  1440 (and dark): none under the checkout bar, the summary bar, the header, the task bar or the tab bar; every stop
  draws its ring (scroll padding 68/84px below 1024).
- /en mirrors: the side-anchored pieces (wells, totals, the summary column, radios, marks, copy keys, the stage rail,
  the thank-you disc) swap sides; no overflow.
- One red primary per view (counted at 390 and 1440) — except an order waiting for its transfer photo, whose action is the
  kit uploader's secondary «اختر صورة» (a request to the kit).
- Not checked: Safari, Firefox, real phones; the Sorani copy needs a native reader. The browser checks placed demo orders
  in the dev database (COD ones hold their stock until staff cancel them).

## Review (2026-11-12, the P6 reviewer; scripts in the session scratchpad `work/pages-P6-checkout-review/`)

Found in the browser and fixed:

1. **Focus fell to the page when a cart line was removed by keyboard** (cart and review): the rows were keyed
   `removed:<id>` once removed, so React remounted the row as its undo row and the kit's hand-off («إزالة» → «تراجع» →
   the restored line's name) never ran — `document.activeElement` was `<body>`. One key per line now (`row.line.id`).
2. **Without script, a refused post spoke the server's generic words** («هذا الحقل مطلوب.», «بعض البيانات غير صحيحة…»);
   each field now says the page's own sentence where its checks agree with the server's.
3. **Without script, the review showed empty delivery and payment summaries and the terms twice** on phones; both
   summaries and the foot's terms are `co-js` now (every field is on screen; the terms sit once above the key).
4. **A demo order found on /track was not marked** (§9.7): the result carries «طلب تجريبي» as the order page does.
5. **The order page told a cash-on-delivery shopper that its link lets them upload a transfer photo**: the hint speaks
   of the photo only while a proof is due (`order.linkHint` / `order.linkHintProof`).
6. **Builder's voice in the account aside** («…وخدمة الرسائل غير مفعّلة بعد», §9.5) and a link «صفحة الحساب» to
   `/account`: two plain sentences now and «أنشئ حساباً» → `/account/signup`.
7. **«تسوّق الأجهزة» opened the home page** (empty cart and empty checkout): it opens `/c/consoles`.
8. **The order summary showed the whole snapshot "<name> — <option>" as the bold name** (clamped, the option cut): the
   name, then the option value with the line's facts (`splitLineName`, the inverse of the core's `lineName`), unisolated
   so «Nintendo Switch 2 Edition (نسخة فيزيائية)» reads in the page's order as the cart line does.
9. The payment and delivery headings inside the order's summary card are one level under the card's heading.

Tests added (`tests/checkout-flow.test.ts`, "review fixes", 6): `splitLineName` against the core's `lineName`; the
checkout rendered by the server after a refused plain post (the no-script page) says each field's own sentence and hides
the two summaries — it failed before fix 2; the /track result of a demo order carries the tag; the order page's link
hint for COD and for Zain Cash, the quiet account aside and its signup link; the empty cart's consoles link; the
`CartLineRow` key does not change with `removed` (a source guard: the test environment has no DOM — the focus itself
was checked in the browser: Enter on «إزالة» → «تراجع» focused; Enter → the restored line's name focused).

Verified by the review: `npm run typecheck` clean; `lint-design --strict` 0; the area's 28 tests and the whole suite
(90 files, 3,464 tests) pass; browser flows (cart undo by keyboard, coupon refused / applied / removed from the summary
bar, guest COD with the error summary, Back and reload on each step, review edits, a Zain Cash order and its proof →
«بانتظار التحقق», the wallet option for the signed-in demo customer, /track missing / wrong / right, the tokenless order,
the no-script checkout, offline); a sold-out line (the `/api/cart` answer rewritten in the browser) and a real
`totals_changed` refusal rendered; focus walk 0 stops under a bar on the three steps, the cart, the order and /track at
390×844, 390×420 and 1440; census (ar light/dark, en, ckb at 390/1440) 0 off-scale sizes, radii, image filters, targets
under 44 or Arabic under 13, 0 contrast failures; no overflow at 320, 360, 390, 720×450 (200% zoom), 768, 1024, 1440;
/en mirrors. Screenshots: `…/scratchpad/ux/after/P6-checkout-review/`.

## QA fixes (2026-11-12, the transaction matrix)

1. **The step's one primary was cut with an ellipsis** in English and Sorani below 1024 («Continue to paym…» at 360,
   «داواکارییەکە پشتڕاست بکەر…» at 360/390, the Sorani cart key at 320) and in the summary card at 1024 (the Sorani
   confirm-with-total, unreported). `<CommitKey>` now carries `.co-commit`: its words wrap to a second line, balanced and
   centred, inside the 48px key (2 × 20px of the button type) — never an ellipsis; in the task bar the key's inline
   padding is 16px (the small key's) before it wraps. In the summary card «أكّد الطلب · {total}» keeps the action
   (with its dot) and the total each whole (`.co-commit__part`), so a wrap reads «…پشتڕاست بکەرەوە ·» / «1,594,000
   د.ع», never a split verb. The strings are unchanged (the Sorani column still needs a native reader; shorter Sorani
   keys would let more of them sit on one line).
2. **Focus started on the step's h1 after /checkout loaded**, so the first Tab skipped the skip link and the checkout bar:
   React StrictMode runs a mount effect twice and the once-only «first render» flag let the second run focus the heading.
   The effect remembers the step it last acted on (`stepFocusTarget` in `checkout-form.ts`, pure): focus moves only when
   the step changes — the new step's h1, or the field a refused «تابع» sends the shopper to.
3. **«تحقق» (the referral code) and «استخدم …» (points) sat below their field** when a hint or an error showed
   (`align-items: flex-end` on the whole field): in `.co-extra__row` the field's parts join the row's grid
   (`display: contents`) — the label over both columns, the input and the key in one row, centred, the hint and the error
   under the input — so the key stays level with the input as the kit's coupon field keeps «طبّق», even when a narrow
   field (the points box at 320 in Sorani) would have wrapped its label to two lines.

Tests (`tests/checkout-flow.test.ts`, "QA fixes", +3, each failed first): every primary of the cart and the three steps
(server HTML, Sorani) carries `.co-commit` and the area CSS lets its label wrap without an ellipsis; `stepFocusTarget`
(first render, a replay of the same step, a step change, a requested field) and no `firstStep` flag in the page; the
`.co-extra__row` grid rule (the key in the input's row). Browser (headless Edge, `…/scratchpad/ux/after/Q-fix-pages-transaction/`): the task
bar and summary keys at 320/360/390 × ar/en/ckb × two carts (926,250 and 1,594,000 IQD) × the cart and three steps,
light and dark, guest and signed in, and 1024/1280: 0 labels cut (two lines where needed, the key 48px); after load
`document.activeElement` is `<body>` and Tab goes skip link → «رجوع إلى السلة» → «الدعم»; «تابع إلى الدفع» focuses the
payment h1; «تحقق» with an unknown code: the key's centre is the input's (0px) in ar/en/ckb at 320–390, light and dark.

## Client feedback round 1 — Design v2.1 «Clay & Glass» (2026-11-13, wave B)

The client compared v2 with the store before it (brief `…/fb1/brief.md`): note 7 (the empty cart: the before's font and
the arrangement of its words and key, v2's «مختارات المتجر» kept), note 8 (the checkout: v2's chrome, the step rail and
the order summary kept; the before's note — colour and arrangement —, and more arrangement), and two new screens (the
review, the order page). What changed is described in the sections above; in short:

- **Empty cart** — the visible title, the soft card across the column, the centred glossy key, the track line under the
  card, then the picks. **Checkout** — the kit's `Note` for every side note; section cards with an icon head; one spacing
  scale; glossy step keys (arrow forward, a check on «أكّد الطلب» that turns into the spinner with «جارٍ تأكيد طلبك…»).
  **Review** — icon rows, clay «عدّل» keys, the items with their pictures, every discount in the saving colour (the kit's
  row is the total; `summaryCoupon` names a coupon there only for orders without itemised discounts). **Order / track** —
  the kit's `SuccessMark`, the number card, the calm demo note, the five-stage rail with icons and a filling line, the next
  step as a toned `Note`, icon rows, help as two `EntryCard` rows; /track in the same look.
- **QA bug (a), the lost stock race** — `cartReadiness` gates every step's key; `StockNotice` names what cannot be bought or
  came down, with the total now; `useRemoveUnbuyable` takes sold-out lines out without an undo row; a lowered quantity
  (the core answers `totals_changed`) is named too; nothing left is the empty state. Tests (written first, failed
  first): "(a) after a lost stock race…" (every step with nothing left: no step key, the line named, the way to the
  store; part sold: every step's key waits, the line named; the refusal's alert names it with the total now; the cart
  page too) and "(a) a quantity that came down…".
- **QA bug (b), a coupon under its minimum** — `couponShortfall` (the core's verdict first, its own count; a demo coupon
  counts the demo goods its conditions cover) and the `coupon-minimum` intent on the cart and checkout routes (30 a
  minute per address; `shouldRevalidate` skips it; the fields post it to the cart route — see the review below). Test (written first, failed first): "(b) a coupon below its minimum
  says how much more is needed — in ar, en and ckb" (the core refuses, the shortfall is exactly what makes the core take
  the code, the stored code's sentence in three languages).
- Tests also added: the pure stock helpers; note 7's arrangement (title, card, track line after the card); note 8's guest
  note and section cards. No assertion of the earlier tests changed.

Verified (headless Edge against the shared dev server; scripts in `…/fb1/work/checkout/`, shots in
`…/fb1/shots/checkout/`): `npm run typecheck` green; `npx vitest run tests/checkout-flow.test.ts
tests/checkout-extras.test.ts` 41 pass; the tests of other areas that import this one (acceptance-checkout,
integration-wiring, shell, i18n, the two storefront-adversarial files) pass; `node scripts/lint-design.mjs --strict` 0;
the matrix (`matrix.mjs`, 12 templates × 360/390/768/1024/1440 light and dark ar + 390/1440 en and ckb = 168 shots): no
horizontal overflow, one h1, at most one red primary, console clean (the deliberate 404 of «تعذّر فتح هذا الطلب»; four dark
/track lookups met the per-address limit after my own repeated lookups); flows (`flows.mjs`): cart + / remove / undo
(focus on «تراجع»), a coupon below its minimum (typed and stored), refused and valid, guest COD by hand through the
governorate picker (the error summary, the progress state), a bank transfer and its proof → «بانتظار التحقق», /track
wrong and right, the order without its token, the stock race (part and all), the cart with a line sold while it waited,
the checkout without script (refused, then placed), the signed-in wallet and points; the focus walk (`focus.mjs`, 6 pages ×
390/1440 × light/dark: every stop of these pages draws its ring, none under a bar); reduced motion (the mark and the rail
drawn at once); /en mirrored. Test orders were cancelled again in the admin to give their stock back. None of the 18
product photos these pages showed is an opaque one (no white plate in dark wells).

Open: the step rail's names on phones (a shell request, below); the kit's «الخصم» row is ink; Sorani needs a native
reader; Chromium only.

### Review of wave B (2026-11-13, the checkout reviewer; scripts `…/fb1/work/checkout-review/`, shots `…/fb1/shots/checkout-review/`)

Found with my own shots and probes, fixed, each with a test written first and seen failing:

1. **The coupon's admin text leaked into English and Kurdish pages** (and cluttered the Arabic summary): under «Discount
   code DEMO10» the summary printed the coupon's Arabic description («قسيمة تجريبية: خصم 10% بحد أقصى …», its full stop at
   the wrong end on /en) — on the cart, the checkout, the review, the order page, /track and the account's order page. The
   summary now has one line per discount (icon, name, amount); the description is said under the applied code in the
   coupon field, on Arabic pages only (`CouponForm`).
2. **The order's next step said its title twice** — v2's status pill became the `Note`'s bold title over sentences written
   to follow a pill: «أُلغي الطلب» / «أُلغي هذا الطلب.», «استلمنا طلبك» / «استلمنا طلبك وسنراجعه.», «في الطريق إليك» /
   «شُحن طلبك وهو في الطريق إليك.» (and in English and Sorani). The texts now say what happens next («لن يُجهَّز هذا الطلب
   ولن يُشحن.», «نراجع طلبك ثم نؤكده.», «شُحن إلى العنوان الذي كتبته.», «جهّز {total} نقداً للمندوب.» …), no promise added.
3. **One dropped request took the checkout down**: the coupon-minimum read (QA bug b) is a fetcher; a failed action goes
   to the route's error boundary, so after a refusal one failed read replaced the whole checkout (and the cart) with «لا
   يوجد اتصال بالإنترنت». Both coupon fields now post the read to the cart route, whose `clientAction` answers instead of
   throwing; the field keeps the refusal's own sentence (checked in Edge with the request aborted, cart and checkout).
4. **What the shopper typed lost its order on /en**: an Arabic address in the review's and the order page's icon rows sat in
   the page's left-to-right paragraph («،7 شارع 14 رمضان…», the comma and the house number at the wrong ends). The
   recipient, the place, the address and the notes are now an inline `dir="auto"` isolate (`Typed` in `Fact.tsx`,
   `.co-typed`): right to left inside, the line still starting at the label's edge; Arabic pages unchanged.
5. Small: the transfer card's «إلى أين تحوّل» is one level under its card's head without script too (h4 there); the cart's
   «أزل غير المتوفر» is a script key (`co-js`), as on the checkout — without script it did nothing.

Tests (`tests/checkout-flow.test.ts`, "client feedback round 1: review fixes", +4): the coupon's words absent from en/ckb
and from the summary's rows, once on Arabic pages; the next step's title and text never repeat (ar, en, ckb; every pair
`NextStep` shows); the cart's `clientAction` answers a failed read and the coupon field targets the cart route; typed
values are `dir="auto"` isolates on the order page and the review (/en). No earlier assertion changed.

Checked and found right (no change): the stock race (part and all, the line named and bold, no undo row, the key back),
a line sold while it waited (the warning on the cart and every step, «أزل غير المتوفر» clears it), the coupon minimum in
ar/en/ckb (typed and stored, cart and checkout), guest COD, a transfer with its proof (→ «بانتظار التحقق», shown again
after a reload), the signed-in points and wallet up to the review (no order placed on the shared demo account), /track
wrong and right, the order without its token, the lost answer («اعرض طلبي» lands on the order placed with that key), the
no-script checkout (refused, then placed), Back / reload on the steps, offline and busy keys, 200% zoom (720×450) and
320 without overflow, reduced motion. The matrix (13 templates × 14 variants, 172 shots): no overflow, one h1, at most
one red primary, console clean.
