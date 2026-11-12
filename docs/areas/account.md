# Account area

Owner: account. Sign-in and sign-up, the customer's account pages, favourites (brief §3.10, §4, §6, §12, §14; Design
System v2 spec §6.12, §6.11 for the order page, §6.17 states, §9 copy). Files: `app/routes/storefront/account/**`
(routes, `components/`, `account.css`), `app/routes/api/wishlist.ts` (+ its line in `app/routes/api/_routes.ts`),
`app/server/services/account/**`, `app/server/services/wishlist.server.ts`, `app/i18n/messages/account.ts`,
`tests/account.test.ts`, `tests/wishlist.test.ts`, `tests/account-rewards.test.ts`. Orders, payments and the wallet
ledger are the commerce core's (CONTRACTS §1): read through it, never written here. Points, memberships, referral codes
and gift cards are module 08's, privacy requests module 07's: the account calls their services for the customer's own
account (2026-11-12).

## Design System v2 (stage 3, 2026-11-12) — what changed

The area was rebuilt on the v2 kit and shell (no retired kit names left: no `quiet`/`ink`/`commit` keys, no `shadow-e1`,
`bg-well`, `font-medium`, `rounded-md`; lint 0 findings). Page CSS lives in `account.css` (components layer, tokens and
logical properties only): the frame, the grouped section list, row lists, quick tiles, the first-steps checklist, the
order rail and the sign-in card. Everything else is the kit (`.panel`, `.callout`, `.form-alert`, `.sechead`, `.cards`,
`.empty`, `Band kind="wallet"`, `OrderSummary`, `ProofUploader`, `GovernoratePicker`, `Segmented`, `Chip`, `Switch` …).

- **Sign in / sign up / reset** (`components/AuthCard.tsx`): one centred 480px paper card (h1, one line, the form, the
  switch to the other page) and the guest note under it «يمكنك الطلب بدون حساب، وتتبّع طلبك برقمه ورقم موبايلك.» with
  «تتبّع طلبك» · «تابع التسوق». The submit is the view's one red primary. Sign-up's offers box carries the checkout's
  sentence «أرسل لي العروض على هذا الرقم» (unticked). Reset: the code flow shows only with a text-message provider
  (`codeDelivery` = "provider"); today the page says reset codes cannot be sent yet («لا نرسل رموز الاستعادة بعد») and its
  primary is «تحدّث مع موظف» (`/support/assistant?handoff=1#handoff`) — it promises no reset: no staff tool resets a
  customer's password — in development too (no "development mode" text on customer pages, §9.5). A sign-up refusal names
  every wrong field at once (the route adds the number's error, which the server core checks only after the others).
- **Frame** (`layout.tsx`): from 1024 a 264px sticky side column with the grouped section list — «نظرة عامة», then
  الطلبات والمرتجعات (طلباتي · الإرجاع · الضمان) · المال (المحفظة) · الحساب (العناوين · أجهزتي · المفضلة · الإشعارات ·
  الملف الشخصي · الإعدادات) — each row with its fact («طلبان قيد التنفيذ», the balance, «عنوان واحد»), the current one
  with `aria-current`, a niche fill and an ink bar; «سجّل الخروج» is a quiet link at the end (a POST form). Below 1024 the
  overview is the list and every section page has a «حسابي» back link. `data-motion-persist="float"` keeps the column
  still while sections push sideways.
- **Overview** (`overview.tsx`): a header card (initial or user glyph on niche, h1 «أهلاً {name}», the masked number,
  «معنا منذ …»); four quick tiles with red-tint icon tiles (طلباتي · المحفظة · العناوين · أجهزتي) and their counts; the
  first-steps checklist «ابدأ من هنا» (add the first address, save your device; hidden once both are done — the
  account's empty state); «آخر طلب» (one order row + «كل الطلبات»); on phones the grouped list + «سجّل الخروج»;
  «شاهدتَ مؤخراً» as a kit rail only with consent and items (with «امسح السجل»). The number's verify chip shows only when
  it is confirmed («رقم مؤكد») or a provider can confirm it («أكّد رقمك»); an unconfirmable "unverified" is not shown.
- **Orders** (`orders.tsx`, `components/OrderBits.tsx`): one paper panel of rows — 56px well, the order number, the
  product's name (option dropped) and «قطعتان», status (dot + words), date, total. The whole row rises into the order.
  «اعرض طلبات أقدم» only when there are more. Empty: the mascot, «لا طلبات بعد», primary «تصفّح المتجر», «تتبّع طلبك».
- **Order** (`order.tsx`, the §6.11 template): «رقم الطلب» + the code (type-code) + copy key + «طلب تجريبي»; «حالة الطلب»
  with the five real states (استلمنا · تأكيد · تجهيز · في الطريق · تم التسليم: done = ink + check, current = ink disc
  with a paper core and `aria-current="step"`, upcoming = rings; a cancelled / returned order says so instead); the next
  step by payment — COD «سنؤكد طلبك قبل تجهيزه. تدفع {total} نقداً عند الاستلام.», a transfer: the store's card / Zain
  number (type-code, grouped, copy keys), the deadline and the ONE primary «ارفع صورة الحوالة» (→ checkout's
  `/order/:ref`, which opens for the signed-in owner without a token), a photo under review / rejected / a missed
  deadline in words; one `OrderSummary` with the lines (name + option value + pieces + warranty) and «الإجمالي» as the
  one red figure, plus the demo line; payment and delivery cards side by side from 1024 (the preference note «وقت مفضّل
  وليس موعداً مؤكداً.»); refunds; «سجلّ الطلب» as a disclosure; «سؤال عن طلبك؟» → «تحدّث مع موظف».
- **Wallet** (`wallet.tsx`): `WalletBalance` on the wallet band (crimson; a cabinet in dark) with «اشحن الرصيد» (only
  when a method is on), pending top-ups on their own line, the ledger rows; «طلبات الشحن» as rows (status in words,
  amount, private proof link, «ألغِ الطلب» → confirm dialog). The top-up is its own step `?topup=1` (not a form under
  the balance): three steps, method option cards, «حوّل إلى» with copy keys, the fraud callout, amount, reference, the
  proof uploader, primary «أرسل طلب الشحن»; on success a toast and back to the wallet, the request «بانتظار التحقق».
- **Addresses** (`addresses.tsx`): cards (label, «العنوان الافتراضي» tag, recipient · number, place, address, notes;
  «عدّل» · «اجعله الافتراضي» · «احذف» → confirm dialog) + primary «أضف عنواناً». The form is its own step (`?new=1`,
  `?edit=<id>`) in one card: the kit's `GovernoratePicker` (the flat fee on top, as in checkout) and the districts of
  the chosen governorate, area, address, notes, default; an error summary linking to the fields on a refused save.
  Saved → toast (the form submits with `replace`, so Back does not reopen it). Without script the picker is hidden and a
  native governorate select inside `<noscript>` is the field, with every district listed under its governorate.
- **Devices**: «أجهزتك» (rows linking to each hub) and «اختر أجهزتك» by platform (dot label), each device with the
  «أملكه» chip (`aria-pressed`, saved at once, optimistic); without script, a plain form with a held toggle key per
  device. **Returns / warranties / notifications**: rows and cards in the same panels; returns ask a person (no return
  form exists; the policy is the link inside the lead sentence); warranty claims → `/support/repair`.
- **Profile**: one card — the number (read-only), name, e-mail, the messages language as a `Segmented` control (native
  radios without script); saved → toast. **Settings**: one card width — «الخصوصية والعروض» as switches that save on
  their own with a toast (each consent recorded only when touched: intent `consent`; `consents` stays for the no-script
  form; the viewing-history switch says it also shapes suggestions — the personal shelves read it); channels only for
  configured providers (switches that save on their own, a `channels` form without script) and phone confirmation only
  with a provider (none today: both hidden, no inert boxes); password (primary «غيّر كلمة المرور»); signed-in devices
  (one / all others).
- **No-script fallbacks** (`components/useHydrated.ts`): a kit control that needs script takes the field's `name` only
  once script runs (`useHydrated`, false in the server HTML and during hydration); until then the same field is a native
  control inside `<noscript>`, and the script control hides under `noscript:` (`@media (scripting: none)`). Never both:
  the form sends one value per field. Everything that worked without script before v2 still does (sign in / up, address
  add / edit, own a device, profile language, consents, favourites «أزل»).
- **Focus after a control removes itself** (`rescueFocus` in `components/FormBits.tsx`): a cancelled top-up, a deleted
  address, «اجعله الافتراضي», a removed favourite, «علّمه كمقروء» / «علّم الكل كمقروء», a signed-out device and «امسح
  السجل» each move lost focus (never focus the shopper already moved) to the nearest stable thing — the request row, the
  next card (else the title), the card's name, the notification, the card's heading, the cleared sentence — instead of
  leaving it on `<body>` (WCAG 2.4.3).
- **Favourites** (`/wishlist`): the catalogue's cards (`.cards--5`, the pinned foot keeps baselines aligned) with «أزل»
  under each (optimistic, undo toast), the guest note «مفضلتك محفوظة على هذا الجهاز…» with sign-in, products no longer
  sold counted.

## Routes

| Path | What |
|---|---|
| `/account/login` | Phone + password (`signInCustomer`). One sentence for a wrong password or an unknown number; rate limits say how long to wait. `?next=` (safe, locale-less) comes back after sign-in; a signed-in visitor goes straight there — so checkout never asks twice |
| `/account/signup` | Name (optional), phone, password, an UNTICKED offers box (a consent row only when ticked), terms/privacy links |
| `/account/forgot` | Password reset by code — the SMS boundary: without a provider (today, everywhere) the page hands over to a person |
| `POST /account/logout` | Ends this session, drops `tt_cart`/`tt_wish` → `/account/login?signedout=1`. GET only redirects |
| `/account` | Header card, quick tiles, first steps, latest order, section list (phones), recently viewed (consent) |
| `/account/orders`, `/orders/:ref` | `listOrdersForCustomer` (10 at a time) · `getOrderForCustomer` (another customer's ref = 404 in the account frame) |
| `/account/wallet`, `?topup=1` | `WalletBalance` = ledger sum + ledger + pending top-ups; top-up REQUEST step (methods switched on, store details from settings, fraud note, amount, reference, `ProofUploader` → private file → `pending_verification`); requests with status, reject reason, private proof link, cancel |
| `POST /account/wallet/proof`, `GET …/proof/:fileId` | Resource route: upload pipeline → private file `wallet_topup_proof` → `{ ok, fileId, previewUrl }`; served to its uploader only |
| `/account/addresses`, `?new=1`, `?edit=<id>` | Cards + the form step; every field error at once; delete asks first |
| `/account/devices` | Published device models by platform; «أملكه» chips; each name links to its hub |
| `/account/returns`, `/account/warranties`, `/account/notifications` | Read-only lists (returns window, RMAs; warranties from delivery; notifications read one / all) |
| `/account/profile`, `/account/settings` | Profile (audited); consents, channels (providers only), phone confirmation (provider only), password, sessions |
| `/account/rewards` (2026-11-12) | «النقاط والعضوية»: the points balance and its worth, what expires within 30 days and the next date points really expire (module 08's FIFO rule), the earn and expiry rules in words from the programme in force, the history (an order's reference only for the customer's own orders; a cancelled order's points «أُعيدت إليك»); the active membership as the checkout applies it (the tier's rate within the store's discount limits, «حتى 50,000 د.ع في الطلب الواحد», free delivery, the points multiplier) or «ليست لديك عضوية الآن» (memberships are granted by the store); the referral code to copy with its uses, or «احصل على رمز إحالة» (module 08's `issueReferralCode` for the customer, once). `account/rewards.server` |
| `/account/privacy` (2026-11-12) | «الخصوصية وبياناتك»: a copy of my data · correct my data (details required) · delete my account (what is kept, the wallet paid out first) → module 07's `createPrivacyRequest` for the own account (`account/privacy.server`: 5 filings a day per customer and per address, one open request per kind, the same form twice is one request); «نرد قبل …»; nothing happens until a staff member confirms who is asking. Stopping messages points to the settings switches. Works without script (the page answers the document post) |
| `/account/wallet` gift card (2026-11-12) | «بطاقة هدية»: the code → «تحقق من البطاقة» (the amount; nothing changes) → a confirm dialog «أضف 60,000 د.ع إلى محفظتك؟» → module 08's guarded redemption into the customer's own wallet (`account/giftcards.server`: 10 checks per 10 minutes per customer and per address); the band's balance reads again. Refusals in the customer's words (`gift_card_*`). Without script the check answers with a plain confirm form |
| `/wishlist` | Favourites for guests and customers; `private, no-store` |
| `/api/wishlist` | GET `{ ok, ids }` · POST `intent=toggle\|add\|remove, productId` → `{ ok, wished, count }`; what `~/ui/WishlistKey` calls |

Every page: shell meta with `noindex` (titles per step: «اشحن رصيدك», «عنوان جديد», «تعديل العنوان»), no `<main>` (h1
first), `/account/*` is `no-store`, `/wishlist` `private, no-store`. Every loader/action calls `requireSignedIn` itself.
Navigation grammar: sections are push siblings (`handle.order`), the order rises, the entry pages are a push group.

## States (§6.17)

| State | How it shows |
|---|---|
| Loading | keys spin in place (width kept); «اعرض المزيد» appends; no skeletons |
| Empty | the overview's first-steps checklist; per page the kit's empty state with the mascot and one way on (orders, addresses, notifications, warranties, favourites); short lines inside sections |
| Validation | the field sentences (values kept) and an error summary above the form linking to each field, focus on the first |
| API failure | a refusal is one sentence above the form (focus on it) or beside the control (a consent switch goes back with its reason); a chip / default refusal comes back with a toast; a refused top-up cancel or address delete keeps its sentence in the dialog and reads the list again (a refused answer does not revalidate by itself, and another tab or staff may have changed it); a page that fails to load says so in the account frame with «أعد المحاولة» (the kit's offline wording when the device is offline); a missing order is «لم نجد هذا في حسابك» with «طلباتي» |
| Offline | the shell's banner; submit keys go flat with «لا يوجد اتصال. أعد المحاولة عند عودة الاتصال.»; switches, chips and row actions are disabled with the same sentence (a fetcher request that cannot leave would end on the error panel) |
| Success | a toast (saved address, profile, choice, cancelled request, signed-out device …) |
| Pending review | «قيد المراجعة {amount}» on the wallet band, «بانتظار التحقق» on the request; a transfer photo under review on the order |
| Unauthorised | a redirect to sign-in with `next` (and back after it) |

## Real, demo, boundary

- Real: accounts and sessions (server core), addresses, saved devices, consent history, notification preferences,
  favourites (guest + account + merge), top-up requests with private proofs, reads of orders / wallet / warranties / RMAs.
- Demo: everything the shell marks (prices, stock); orders placed in demo mode carry «طلب تجريبي» (the tag on the order
  page; on rows only once the store is live) and the summary's demo line.
- Boundary: no SMS/WhatsApp/e-mail provider (codes unavailable; channel and phone screens hidden until one exists;
  choices stored, not delivered); numbers stay unconfirmed; no storefront return form or warranty claim service (a person
  and the repair request); approving or rejecting top-ups is an admin job; nothing writes notifications yet.

## Guest favourites and the cart cookie

Guest rows carry sha256(`tt_cart`). The cart service mints a new token for a guest's first cart and for the cart after an
order, so a guest without a cart gets a token here kept in `tt_wish`; whenever both cookies differ, the next wishlist
call moves the rows to the cart token (`reconcileGuestWishlist`). Sign-in moves everything into the account and deletes
the guest rows. `getWishlistIds(db, { customerId, cartToken })` (contract) works alone; `wishlistWho(ctx.cookie, id)`
also passes `tt_wish` and sees moved rows at once.

## For other areas (exports — signatures unchanged)

- `wishlist.server`: `getWishlistIds`, `toggleWishlist`, `setWished`, `isWished`, `wishedAmong`, `mergeGuestWishlist`,
  `wishlistWho`, `rekeyGuestWishlist`.
- `account/addresses.server`: `listAddresses`, `getDefaultAddress` · `account/saved-devices.server`: `listSavedDeviceIds`
  · `account/recently-viewed.server`: `recordRecentlyViewed`, `mergeDeviceRecentlyViewed`, `listRecentlyViewed`,
  `clearRecentlyViewed` · `account/notifications.server`: `notificationStatement` · `account/topups.server`:
  `getPendingTopupTotal`, `listWalletTopups` · `account/preferences.server`: `getConsent`, `recordConsent`.
- Route modules: `layout.tsx` `ACCOUNT_LAYOUT_ID`, `useAccountData()`; `components/AccountNav.tsx` `ACCOUNT_SECTIONS`,
  `sectionOrder`; `components/OrderBits.tsx` `splitOption`, `railIndex` (pure, tested), `ORDER_RAIL`. No other area
  imports them.
- 2026-11-12: `account/rewards.server` `getRewards`, `issueOwnReferralCode`; `account/giftcards.server`
  `checkOwnGiftCard`, `redeemOwnGiftCard`, `GIFT_ATTEMPTS`; `account/privacy.server` `listOwnPrivacyRequests`,
  `fileOwnPrivacyRequest`, `OWN_PRIVACY_KINDS`, `PRIVACY_FILINGS` (tests: `tests/account-rewards.test.ts`).
- The order page (2026-11-12): the kit's status rail (`ProgressSteps variant="status"`, the kit's page request — the
  page's own `.orail` is gone), the checkout area's `Adjustments` (every discount as charged, the waived delivery, a split
  payment's parts) and `DigitalCodes` («اعرض الرمز»: the page's `action` asks the core with the owner's session; audited,
  rate-limited); its loader returns the `checkout` and `errors` words for them. Since the core review of 2026-11-12 a
  cancelled or returned order's codes are revoked (shown as such, never revealed) and the rewards page lists each
  points give-back by order («أُعيدت إليك» — a cancellation, a parcel refused at the door, a refund's share).
- Security review 2026-11-12 (`tests/commerce-core-security.test.ts`, SECURITY §18): the new pages, their actions and
  `/api/cart?points=` were attacked for another customer's points, codes, wallet and privacy requests (none reachable:
  every service takes the session's customer, a posted `customerId` or `phone` changes nothing, another customer's
  order is the same 404 as none); the gift-card and privacy budgets hold per ADDRESS across free accounts; a guest is
  sent to sign in and nothing is written; another site's post is refused. An account's order shows its codes ONLY here
  or on `/order/<ref>` signed in as its owner — never to the order's link (the core's `orderCodesOpenWith`); a reveal is
  audited with `access: "account"`. A revoked code on a cancelled or returned order says «أُلغي هذا الرمز لأن الطلب أُلغي
  أو أُعيد.» (`DigitalCodes closed`).

## Recently viewed — one store per shopper

A signed-in customer's views are kept in the ACCOUNT only (`recently_viewed`, ≤ 30, with consent); a guest's on the
device only (home's `tt:recent`). After signing in, the first product page, home visit or the overview hands the
device's guest list to the account once (`mergeDeviceRecentlyViewed`). Withdrawing personalization in the settings
(`forgetPersonalData`) clears the account's list and the recommendation signals of the account and this device. Full
table: docs/areas/home.md "Recently viewed".

## Verified (2026-11-12)

- `npx vitest run tests/account.test.ts tests/wishlist.test.ts tests/i18n.test.ts` — all pass (account 30: + the v2
  block — `splitOption`, `railIndex`, the copy rules in ar/en/ckb; no assertion changed); `npm run typecheck` clean for
  these files; `node scripts/lint-design.mjs app/routes/storefront/account app/routes/api/wishlist.ts
  app/i18n/messages/account.ts` — 0 findings.
- Browser (headless Edge, dev server): sign up, sign in with `next` (→ wallet, → wishlist), sign out (notice), guest
  favourite → `/wishlist` → sign-in merge, address add (error summary → focus on the first field; governorate picker) and
  edit, devices chips (persist after reload), top-up with a photo → «بانتظار التحقق» → cancel dialog, consent switch →
  toast → persists, a COD and a card-transfer order on the order page; offline, refused sign-in, empty submit and 404
  states. Audit (`…/scratchpad/work/pages-P7-account/audit.mjs`): 15 pages × 360 / 390 / 768 / 1024 / 1440 × light /
  dark (ar) and 390 / 1440 × en / ckb — no overflow, Kufi 700 + Plex 400/600 only, radii ⊆ {12, 20, full}, ≤ 2 shadow
  recipes, 12px only on tags, no target under 44, ≤ 1 red primary per view, no banned copy, no focused control under a
  bar. Screenshots: `…/scratchpad/ux/after/P7-account/`.
- Not checked: Safari, Firefox, real phones; Sorani needs a native reader.

## P7 review (2026-11-12)

Fixed: (1) forms that worked without script before v2 did not — the address governorate (picker only), «أملكه» (chip
only) and the messages language (segmented only) — now native fallbacks inside `<noscript>`; (2) focus fell to `<body>`
after a control removed itself (top-up cancel, address delete / default, favourite «أزل», notifications, sessions, clear
history) — `rescueFocus`; (3) a refused top-up cancel / address delete left a stale list behind the dialog —
revalidated; (4) the reset page promised that staff reset the password («A staff member resets your password») — no
such tool exists; now it says codes cannot be sent yet; (5) the favourites removal was announced twice; (6) sign-up
named a wrong number only after the password was fixed; (7) copy: the viewing-history switch did not say it shapes
suggestions, the language hint pointed at "the top of the page" (the switch is in the footer on phones), the returns
lead named the policy twice, the reset page's «العودة إلى تسجيل الدخول» carried a forward arrow; (8) a saved address
form came back on Back (now `replace`). Tests (`tests/account.test.ts`, +7): server HTML of the address form, devices and profile
carries the no-script fields (exactly one `governorateId`, one form per device, three `locale` radios and no hidden
value); sign-up returns both field errors; the honest-copy rules. Reviewer's checks: pixel contrast of every text run in
`main` (none under 4.5 / 3 large) at 390 and 1440 light / dark; 320px reflow; no-script and keyboard flows; screenshots
`…/scratchpad/ux/after/P7-account-review/`.
