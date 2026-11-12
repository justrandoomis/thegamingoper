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
| `/cart` | store (`tabBar: false` + a `<TaskBar>`; the tab bar comes back on an empty cart) | h1 «السلة (3)»; the kit's `CartLineRow`s (96/120px wells, the option value only, availability, stepper, line total, «إزالة» + undo row); the kit's `OrderSummary` (rows, «الإجمالي» the one red figure, the discount code behind «لديك رمز خصم؟», the delivery rule, `TrustStrip line` — COD when on, «اطلب بدون حساب», «سياسة الإرجاع» — and the demo-order line); one recommendation rail. Below 1024 the task bar holds «الإجمالي» + the total and the primary «إتمام الطلب»; from 1024 the summary is the sticky 5-column side with the primary inside it |
| `/checkout?step=address\|payment\|review` | checkout (`chrome: "checkout"`): the shell's one 56/64px bar carries the step rail | Below 1024 a 48px summary bar on `--niche` under the bar (`components/SummaryBar.tsx`, a native `<details>`: «ملخص الطلب · قطعتان», the total, the items on demand) + the task bar «الإجمالي» + the step's primary («تابع إلى الدفع» · «راجع الطلب» · «أكّد الطلب»); from 1024 7/5 columns, the sticky summary with the items, the coupon, the primary («أكّد الطلب · 1,513,750 د.ع» on review), the trust line and the demo-order line. One heading per step (the step's question is the h1) |
| `/order/:ref` | store | `?t=<accessToken>` (guest) or the signed-in owner; anyone else the same 404 «تعذّر فتح هذا الطلب» with two exits (look it up · sign in). The thank-you header (72px `--ok-tint` disc + check, one scale-in under `data-motion="full"`, h1 «شكراً، استلمنا طلبك», «رقم الطلب» + the code in `type-code` with «انسخ» and «انسخ رابط الطلب», «طلب تجريبي»), then the order status template, the quiet aside (help → «تحدّث مع موظف», following it later, the optional account), «تابع التسوّق» (the page's primary unless a proof is due), at most one rail of four |
| `/track` | store | A centred 560px card: «رقم الطلب», «رقم الموبايل», the primary «اعرض الطلب», three lines of what the lookup shows. Found: focus on the result heading, the form folds into «ابحث عن طلب آخر» (a link to `/track`, so it works without script), the order status template read-only. Not found: one sentence for either wrong half. A missing phone says «اكتب رقم الموبايل الذي طلبت به.» |
| `POST /api/upload/proof` | — | multipart `ref`, `t?`, `declaredAmountIqd`, `reference?`, `note?`, `file` → `{ ok: true, previewUrl }` or `{ ok: false, code, fields? }` (unchanged; order of work in `proof.server.ts`: size + per-IP limit → fields → access → per-order limit → `canUploadProof` → `saveImageUpload` private → `submitPaymentProof`; a refusal after storing deletes the file; `duplicateOf` never leaves the server) |

All four pages: `shellMeta(…, { noindex: true })`, `Cache-Control: no-store`, strings in `checkout` + `errors` (+ the
kit's `ui-shop` demo-order line). Page CSS: `checkout.css` (components layer, tokens only): the 7/5 split, the summary
bar, the guest strip, the transfer steps and values, the stage rail, the thank-you header, the tracking card, and the
script on/off switches (`.co-js` / `.co-nojs`, from `<html data-motion>`). Cart → checkout steps → order is one
sideways-push group (`handle = { nav: "push", order, group: "checkout" }`).

## The checkout, step by step (§6.10)

1. **التوصيل** — h1 «إلى أين نوصل طلبك؟» → the guest strip (`--ok-tint`: «أكمل الطلب بدون حساب. الحساب اختياري: يحفظ
   عناوينك ويسهّل تتبّع طلباتك.» + «سجّل الدخول») → the error summary (`FormErrorSummary`, only after «تابع») → contact
   («رقم الموبايل», hint «نستخدمه للتواصل بخصوص طلبك فقط. مثل 0770 123 4567.»; «اسم المستلم (اختياري)») → the address
   (`GovernoratePicker` with the fee on top — a native `<select>` without script; district `address-level2`; area;
   «العنوان بالتفصيل»; «ملاحظات للمندوب (اختياري)») → `PreferencePicker` (the period only: no dispatch days are
   configured, so no day or date is offered; «وقت مفضّل وليس موعداً مؤكداً.») → the marketing consent (unticked) → signed
   in, with an address that is not the saved one as it is: «احفظ هذا العنوان لطلباتك القادمة» (unticked).
2. **الدفع** — `OptionCard pay` (72px, a word mark, never a logo) in this order, only enabled methods: الدفع عند الاستلام
   (chosen when it is on and nothing was chosen before) · محفظة طمطم (signed in: the balance and what remains; disabled with
   the shortfall when it does not cover the total) · تحويل إلى بطاقة ماستركارد · زين كاش. A transfer opens the panel: «1
   أكّد الطلب · 2 حوّل {total} · 3 ارفع صورة الحوالة من صفحة الطلب», «لا يُعتبر الطلب مدفوعاً حتى يتحقق موظف من الحوالة.»,
   where to send it (grouped numbers, a copy key each) and the fraud callout. No card field, ever.
3. **المراجعة** — the delivery and payment blocks with «عدّل» (pencil inline, named «عدّل التوصيل»…), the lines editable in
   place (the kit's cart editor, priced for the chosen governorate: stepper, «إزالة» + undo), «بتأكيد الطلب توافق على الشروط
   وسياسة الإرجاع», the demo-order line, «أكّد الطلب».

- **State:** the draft lives in the page and in this tab's `sessionStorage` (`tt:checkout`); the order page clears it. A
  step change is a `?step=` change with no loader call; Back walks the steps; a deep link to a later step falls back to
  the first unfinished one. A stored day that is no longer offered is dropped (`withOfferedDay`).
- **Checks:** on blur, again on every keystroke once a problem shows; «تابع» lists the step's problems in one alert and
  focuses the first field. The server checks everything again; its field errors land on the right step.
- **Totals:** always the server's CartView. Choosing a governorate re-prices through `GET /api/cart?governorateId=`; cart
  edits and the coupon answer priced for it too. The key waits («جارٍ تحديث الإجمالي…») while a change is in flight;
  `expectedTotalIqd` = the total on screen; `totals_changed` shows the fresh cart and asks again.
- **Stock race:** a refusal about stock comes with the cart as it is now; lines that sold out are taken out through the
  cart editor (each keeps its undo row) and the review says «بيعت آخر قطعة قبل لحظات. أزلناها من سلتك.»; a lowered
  quantity says so. The shopper confirms again with the new total.
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

Shared by `/order/:ref` (mode `owner`) and `/track` (mode `tracked`): the five real stages (استلمنا · تأكيد · تجهيز ·
في الطريق · تم التسليم — `orderStage(status)`; waiting for a transfer or its check is still «استلمنا»; none for a
cancelled or returned order) → the next step by payment (COD «سنؤكد طلبك قبل تجهيزه. تدفع {total} نقداً عند الاستلام.»;
a transfer: where to send it, the deadline, the amount-first `ProofSection`/`ProofUploader`, then «بانتظار التحقق»;
tracked mode says the upload needs the confirmation link) → shipments → ONE summary card (the kit's `OrderSummary` with
the lines — the name as sold split by `splitLineName` into the product's name and its option value, then the line's
facts — and payment and delivery side by side from 1024, their headings one level under the card's) → refunds → the
dated history behind a `Disclosure`. English status `cod_due` reads "Due on delivery". The order page's link hint speaks
of the transfer photo only while a proof is due; its account aside is two sentences («…ويجمع طلباتك القادمة…»,
«يبقى هذا الطلب متاحاً عبر رابطه وصفحة التتبّع.») and «أنشئ حساباً» → `/account/signup`. A demo order found on
`/track` carries the «طلب تجريبي» tag, as on its own page.

## States (§6.17)

| | Cart | Checkout | Order | Track |
|---|---|---|---|---|
| Loading | keys keep their width (kit loading); totals «جارٍ تحديث المجموع» | the same; the key waits for pricing and edits | streamed rail only | the submit key spins |
| Empty | EmptyState «سلتك فارغة» + «تسوّق الأجهزة» (→ `/c/consoles`) + «تتبّع طلبك» + four picks; the tab bar shows | EmptyState, «تسوّق الأجهزة» → `/c/consoles` (+ «اعرض طلبي» after a lost answer) | — | — |
| Validation | — | inline + the error summary | — | per field; phone «اكتب رقم الموبايل الذي طلبت به.» |
| API failure | the coupon's refusal; a failed edit rolls back with a sentence | coupon / stock race / totals changed sentences | upload refusals in the uploader | the not-found sentence; rate limit |
| Offline | the key flat + reason; the shell banner | the keys flat + reason; the draft stays | banner | the key flat + reason |
| Success | — | the order page | the thank-you header | the found order |
| Pending review | — | — | «بانتظار التحقق» | the same, read-only |
| Unauthorised | — | sign-in is a link, never a wall | the tokenless 404 with two exits | — |
| Sold out / soon | lines «لا يُحتسب في المجموع», the key blocked | taken out with undo on a race | — | — |
| Demo | the demo-order line | «طلب تجريبي» (bar) + the line | the tag + the line | the tag on the found order |

## Promotions, points, split payments, digital codes (2026-11-12, commerce core)

Everything is priced by the core (`getCartView` / `placeOrder`, CONTRACTS §1) — the pages only show it, as charged:

- **Cart lines**: a flash-priced line says so under its name («عرض سريع (تجريبي): سعر العرض حتى …، بدلاً من 62,250 د.ع»,
  and how many units the price still covers — `withFlash`); «نقل إلى المفضلة» beside «إزالة» (`components/MoveToWishlist`:
  `POST /api/wishlist` then the editor's removal with its undo row; variant lines only).
- **The summary** (`components/Adjustments.tsx`, under the kit `OrderSummary`'s rows — the kit shows one discount row):
  every part of «الخصم» on its own line (an offer, the coupon, the membership discount with its rate, the redeemed
  points), the delivery a membership or an offer waived (words only: «التوصيل مجاني لعضوية … بدلاً من 5,000 د.ع» — the
  delivery row already shows 0), and a split payment's two parts («من محفظة طمطم» · «الباقي للدفع»). The kit's discount
  row names the coupon only when the coupon IS the whole discount (`summaryCoupon`). A coupon a better non-stackable
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
  delivery places the order already paid, and the order page's next step says «استلمنا طلبك وسنراجعه.» (no «تدفع 0 د.ع
  نقداً»: the cash line shows only while the payment is `cod_due`). A cancelled order's codes are revoked and its page
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
