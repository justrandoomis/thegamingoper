# Admin 08 — Promotions & loyalty

Owner: admin promotions. Routes `app/routes/admin/promotions/**`, services `app/server/services/admin/promotions/**`
(pure rules in `rules.ts`, client-safe types in `types.ts`), strings `app/i18n/messages/admin-promotions.ts` (ar source,
en, ckb), tests `tests/admin-promotions*.test.ts`. Blueprint 08.01 implemented; 08.02–08.08 partial — since 2026-11-12
the online checkout applies coupons, rules, flash prices, points, the member discount and free delivery and records
referral codes; what each still misses (the till, early access, …) is in "What the checkout and the till apply".
Adversarial review 2026-11-12: `tests/admin-promotions-review.test.ts`.

## Routes

| Path | What | Permission (loader / actions) |
|---|---|---|
| `/admin/promotions` | What waits for this employee, each section's counted figures, where each section is applied today (online checkout / till, `checkout-state.ts`), `<ModuleFunctions moduleId="08">` | any promotions.* |
| `/admin/promotions/approvals` | The module's decisions in one queue (mobile-first cards linking to the deciding page); my own requests apart | any promotions.* |
| `/admin/promotions/coupons` | States (live, scheduled, waiting, off, expired, used up), uses / limit, discount given; views, search, sort, page in the URL (GET form); table ≥ 768 px, cards below; bulk switch-off with a reason | promotion.read or coupon.manage / coupon.manage |
| `/admin/promotions/coupons/:couponId` (`new`) | Terms and conditions, approval reasons, edit (stale form → `coupon_changed`), switch on/off, the request (approve / reject for others, withdraw for the requester), **try this coupon** (the core's `evaluateCoupon`), redemptions, history | read / coupon.manage; decide + pricing.discount.override |
| `/admin/promotions/rules`, `/rules/:ruleId` (`new`) | Automatic rules (percent, fixed, tiers, buy X get Y, free delivery; scope by platform, category ⊇ sub-categories, kind, segment, channel, cart value, quantity; priority, stacking, window); **dry run** `?days=7\|30\|90&demo=1` | promotion.read or rule.manage / rule.manage; decide + pricing.discount.override |
| `/admin/promotions/flash`, `/flash/:saleId` | Sales with a Baghdad-time window; SKUs by SKU or barcode (keyboard wedge), sale price, allowance, per-customer limit, pricing's checks per SKU (with the 30-day high), stock now, "can sell"; submit → scheduled or a request; cancel / stop | promotion.read or flash_sale.manage / flash_sale.manage; decide + pricing.price.approve (+ pricing.discount.override under the margin floor) |
| `/admin/promotions/points`, `/points/:customerId` | Programme rules, outstanding points and their worth, what is due (post earn + reversals, post expiry), find a customer by phone, the ledger (kind / customer in the URL); a customer's balance, expiring points, multiplier, entries, adjustment (confirm dialog: balance before → after, worth) | promotion.read or loyalty.manage / loyalty.adjust |
| `/admin/promotions/referrals` | Referrals to review with their signals, reward / reject, record a referral, issue a code, every code with uses / cap and switch | promotion.read or referral.manage / referral.manage |
| `/admin/promotions/vip` | Tiers (written benefits, delivery terms, multiplier, duration), eligible customers by module 07's rule, members `?members=current\|ended&page=` (the count is its list's), grant / end, close ended | promotion.read or membership.manage / membership.manage |
| `/admin/promotions/gift-cards`, `/gift-cards/:cardId` | Settlement (issued, outstanding, used vs the wallet ledger, expired, void, requests), issue (confirm dialog, code once, printable), decide requests, redeem into a wallet (check → confirm dialog with the amount and the wallet), mark expired; one card: reveal (audited), void, history | promotion.read or gift_card.* / gift_card.issue, gift_card.manage (+ digital_code.reveal) |
| `/admin/promotions/experiments`, `/experiments/:experimentId` | A/B tests of coupons: measurement rule, problems, results per variant, start / pause / resume / complete | promotion.read or experiment.manage / experiment.manage |

Every action is a POST with one `intent`; `runIntent` (`promotions.server.ts`) checks the intent's permissions before
anything is read (403), then the service checks again (`assertCan`) and parses the raw input with zod (Arabic-Indic
and Persian digits accepted: `parseWhole`, `parsePercentBps`; datetime-local fields in Baghdad time). A record's page
decides and withdraws only ITS requests: the services take the page's id (`couponId`, `ruleId`, `saleId`,
`customerId`) and answer 404 for an approval of another record. Financial forms (issue a card, redeem a card, adjust
points) open a confirm dialog with the impact before they are sent.

## Rules that decide

- **Second person** (`DISCOUNT_LIMITS`, `discountApprovalReasons`): a percentage above 20 %, more than 50,000 IQD off
  one order or no ceiling, and for coupons no usage limit at all. Requests are `approvals` rows (kinds `coupon`,
  `promotion_rule`, `flash_sale`, `gift_card`, `loyalty_adjustment`); a decision is one batch guarded on the terms the
  request carried (fingerprint / `updated_at` / items checksum) and on `status = 'pending'`; one waiting request per
  coupon, rule or sale, re-checked inside the request's batch (`noPendingRequest` → `change_pending`); **the requester
  never decides** (`approver_is_requester`), the requester withdraws. Approved terms are remembered (`json_extract(payload,
  '$.fingerprint')`): switching the same terms off and on needs nobody. An edit of live terms waits while the terms in
  force stay.
- **Flash prices** go through pricing 03's own `evaluatePriceChange` + `costBasisFor` + `pricing.drop_approval_bps`,
  the cut measured from the SKU's highest price of the last 30 days (`dropReferencePrice` over its applied
  `price_changes` — a quiet price cut plus a quiet flash cut cannot split the 10 % limit); re-evaluated at the decision
  (`override_required`, 403, when a price now needs pricing.discount.override). `variants.price_iqd` is never touched.
  Allowance ≤ units available now (refused at add, submit and approval); overlapping sales of a SKU refused. Running =
  status `scheduled` and `starts_at ≤ now < ends_at`.
- **Points** (`LOYALTY`): 1 point per whole 1,000 IQD of goods paid and kept (shipping excluded) × the VIP multiplier,
  after delivery + `returns.window_days`; key `loyalty:earn:<order>`; a refund paid later reverses its share
  (`loyalty:reversal:<refund>`, never below zero); FIFO expiry after 365 days (`loyalty:expire:<customer>:<credits>`);
  manual adjustments above 5,000 points, or that take what one employee GAVE alone in 24 hours above 10,000
  (`adjustSoloDayPoints`, summed from the ledger, re-checked in the batch → `points_solo_limit`), by a second person;
  the overdraft trigger refuses a negative balance; the customer must still exist inside the batch.
- **Referrals**: refused — self-referral, a number referred twice (UNIQUE), a code off or at its cap (guarded
  `uses + 1`), an order of someone else; signals for a person — same address, same device (IP + browser, 90 days), an
  existing customer, the order's state; reward 500 points after delivery + the return window, once
  (`referral:<id>:reward`), never by whoever recorded it; the order's state and the referrer are re-checked inside the
  reward's batch (an order returned meanwhile earns nothing).
- **VIP**: eligibility is module 07's `flagCondition("vip")` / `customerFlags` (not forked); one active membership per
  customer (guarded in the batch). "Members" = active and not past the end (the front page's count).
- **Gift cards**: 16 characters from 31 (≈ 79 bits), sha256 for lookup, AES-GCM with DATA_KEY bound to
  `gift_card:<id>` (as module 13's digital codes); the code is shown once to the issuer (or the approver); reveal needs
  gift_card.manage + digital_code.reveal, a reason, an audit event, 20 per employee / 10 min; wrong codes (check or
  redemption) 10 per employee / 10 min. Redemption = guarded `active → redeemed` + `walletCreditStatement` (kind
  `gift_card`, key `gift_card:<id>`) + `postWalletCredit` (Dr marketing / Cr wallet liability) + audit, one batch, with
  one idempotency key per redemption form (the wallet entry's id: a replay answers the first result, the key with
  another card is `idempotency_mismatch`) and the customer re-checked inside the batch. A demo card never goes into a
  real wallet, nor a real card into a demo account (`gift_card_demo_mismatch`). A card above 100,000 IQD, or 250,000 IQD
  a day issued alone (audit sum, re-checked in the batch), waits. An active card past its date shows and counts as
  expired everywhere (rows, views, settlement, front page) until "mark expired" stores it.
- **A/B tests**: no start without metric, minimum orders per variant (stored on each variant: `config.minOrders`) and
  planned end; results = orders with the variant's coupon since the start (cancelled and demo left out); a winner only
  when every variant reached the minimum and only the leader; no significance computed.

## Field rules

No cost or margin leaves the server without cost.read + profit.read — pricing 03's rule, in loader data, action answers
and the queue: the flash checks' floor, margins, "needs the override" and the cost-based reasons (`below_cost`,
`below_min_margin`, `cost_unknown`) are absent; the page says the server decides at submit. The dry run's margin
block likewise (tests check the JSON). Phones masked without customer.phone.read_full. Gift-card codes are in no list,
history or audit event. Profile links only with customers.customer.read.

## What the checkout and the till apply (read from the core 2026-11-12)

One registry says it to staff: `app/routes/admin/promotions/checkout-state.ts` (`CHECKOUT_STATE`: per section, `web` =
the online checkout, `pos` = the till; `applied` / `partial` / `missing`) — the overview's «ما يُطبَّق اليوم في الموقع
ونقطة البيع» and the note at the top of every section page (`SectionState` in `ui.tsx`) read it; the sentences are
`home.checkout.<section>.<web|pos>`. `tests/admin-promotions-state.test.ts` checks every claim against the core (its
pure decision, the till's source, a database), so a change on either side that is not written on the other fails.

| Section | Online checkout | Till (admin 06) | Sources (file:line, 2026-11-12) |
|---|---|---|---|
| Coupons | applied — validated on every read of the cart, applied after the rules, a redemption row guarded by the limits | missing — the till takes no coupon (the cashier's own discount); a coupon limited to the point of sale is refused online, so it applies nowhere | `cart.server.ts:551`; `orders/promotions.ts:151` (step 3); `orders/place.server.ts:573`; `coupons.server.ts:162`; `admin/pos/sale.server.ts:9–18` |
| Rules | applied — live rules; the ones that combine with coupons («مع الكوبونات») add up, highest priority first, then the coupon; the best rule that does not combine (by amount, priority on a tie) competes with all of them together and, if it gives more, applies ALONE (no other rule, no coupon — `couponDropped`); rules that do not combine never add up; the best free-delivery rule's waiver applies either way (a member's free delivery first) | missing — no rule at the till; a rule limited to the point of sale applies nowhere (the web passes channel "web") | `orders/promotions.server.ts:127` (`loadPromotionFacts`); `orders/promotions.ts:129–171` (steps 2–3), `:199` (step 6); `admin/promotions/rules.ts:135` |
| Flash sales | partial — the sale price in the cart and at checkout while the allowance and the shopper's limit cover the line, units claimed in placeOrder's batch, given back on a cancel; product pages, lists and search read no flash sale | missing — the till sells at the SKU's or its price list's price | `cart.server.ts:484, 759`; `orders/promotions.ts:51`; `orders/promotions.server.ts:336, 358, 433`; `orders/place.server.ts:625`; the only reader outside module 08 is `orders/promotions.server.ts` |
| Points | applied — a signed-in customer redeems (balance, goods left, × the point's worth), a 'redeem' row (overdraft trigger), all given back on a cancel / refused parcel, a share with each refund (ledger rows kind "reversal", ref "redeem" — labelled «نقاط استُبدلت في طلب»); earned after delivery + the return window | partial — a sale to a known account earns (status delivered at once); the till redeems nothing | `orders/promotions.ts:185` (step 5), `:216` (`restoredPointsFor`); `orders/place.server.ts:191, 374, 629`; `orders/promotions.server.ts:364, 400–425, 433, 477`; `admin/promotions/loyalty.server.ts:80` (no channel filter); `orders/pos-sale.server.ts:749, 770` |
| VIP | partial — the member discount at most the discount limits in force (20 % / 50,000 IQD by default), free delivery, the multiplier when points are posted; early access is read by nothing | partial — the multiplier counts on till sales when points are posted; no member discount at the till | `orders/promotions.ts:174` (step 4), `:199` (step 6); `orders/promotions.server.ts:127` (member); `admin/promotions/loyalty.server.ts:63`; `earlyAccess` only in `db/schema/growth.ts` outside module 08 |
| Gift cards | applied — redeemed into the wallet (account page or staff), the wallet pays | applied — the wallet pays at the till (a customer identified by number; never offline) | `account/giftcards.server.ts`; `orders/pos-sale.server.ts:879`; `admin/pos/sale.server.ts:19` |
| Referrals | applied — a friend's code typed at checkout, checked by module 08's rules, recorded "pending" in placeOrder's batch; a cancel closes it and gives the use back; the reward stays a person's decision | missing — staff record it by hand (`recordReferral`); sign-up records no referral | `orders/promotions.server.ts:271, 294, 433`; `orders/place.server.ts:193, 416, 630`; nothing in `server/auth` |
| A/B tests | partial — results from the orders of each variant's coupon; nothing assigns or counts visitors | missing — the till takes no coupon | no writer of `experiment_assignments` / `experiment_events` |

Points (and the other daily jobs) are posted every night by `jobs.server.ts` (`promotions.points.sync`,
`promotions.points.expire`, after `promotions.memberships.close`; cron `30 0 * * *`) and at once from the points page.

## Boundaries (honest)

The till applies no promotion of this module (it takes the wallet, so a gift card's value spends there); early access
to sales is written on a tier and read by nothing; product pages, lists and search show the regular price during a
flash sale (the sale price shows from the cart on); referral codes are not recorded at sign-up; visitors are not
assigned to A/B variants; gift cards are not sold for money — the account «بطاقات هدايا لم تُستخدم بعد»
(`gift_card_liability`, 2150) exists in the chart, but there is no sale line at the till or the checkout. A tier's
member discount above the limits is capped by the core at the limits (no second-person rule for tiers): the tier card
says «يُطبَّق حتى …%» and the discount field says the limits. Programme limits are settings since 2026-11-12
(promotions.* — see the follow-up section).

## Tests and verification

- `tests/admin-promotions.test.ts` (26): pure rules; roles; coupons; dry run; flash; points; referrals; VIP; gift
  cards; A/B; races; route glue.
- `tests/admin-promotions-review.test.ts` (16, each failed on the builder's code): flash field rules, the 30-day high,
  the decision-time override, split point adjustments (two tabs too), one waiting request per record (two requests at
  once), IDOR on the coupon and points pages, redemption replay / demo card / merged customer, the redemption check,
  the referral race, Arabic qty in "try", 100 coupons off, gift-card and VIP counts.
- `tests/admin-promotions-routes.test.ts` (1): every loader and intent for six roles answers 200 / 400 / 403 / 404.
- `tests/admin-promotions-state.test.ts` (19, wave B 2026-11-12/13): the state texts in ar/en/ckb and the retired
  sentences gone; the claims against the core's `applyDiscounts` / `flashLineCap` / `evaluateRule` / `evaluateCoupon`, the
  till's source (no promotion call, the wallet), the readers of early access, flash sales, A/B visitors and sign-up
  referrals, and a till sale to a VIP customer earning × the multiplier. Review 2026-11-13 (+6, each failed first):
  every ledger reference the server writes has a label (the checkout's ref "redeem" showed a raw key), the rules'
  stacking as the core decides it (the note and the form's hint), a refund's share of redeemed points, the coupon
  try's regular price, the «not built yet» lines as one sentence and the nightly posting in the empty ledger, and a
  rule's dry run weighing an order's whole discount (points, no coupon) with words that say «discount».

Browser: `.shots/admin-promotions/` (seed `seed-promotions.ts`, ids `refs.ts`), review shots in `review/`.

Review of the wave-B change (2026-11-13), each found in the browser or against the core: the points ledgers (module
and customer pages) showed the raw key «points.ref.redeem» for the points the checkout gives back after a cancel or a
refund — labelled now; the rules' sentence and the rule form's «مع الكوبونات» hint said a rule that does not combine
only competes with the coupon (the core also drops the combining rules, and only the best such rule applies); the
points sentence said redeemed points come back when an order is refunded (a refund gives back its share); «جرّب
الكوبون» said "today's prices" (it prices the regular price; a running flash sale's price comes first at checkout);
the gift-card and referral «لم يُبنَ بعد:» lines read as a label inside a label; the empty ledger told staff to post
points by hand only (the jobs post them nightly); the note's stripe was the warning colour on sections that apply
online (information now; the warning stays on the «not built yet» icon); blueprint 08.04 said "at once from here" on
the blueprint page; a rule's dry run called each order's whole discount (`orders.discount_iqd` — since the core
applies rules, the member discount and points, not only the coupon) «خصم الكوبون» and its skip «كوبونه أفضل» (now
«خصمه القائم»); the dry run's order references broke over three lines (kept on one; the table already scrolled at
1024–1279); a ×2 multiplier read «×2.0» (tier tag, customer page). Demo records added through the real forms: rule
«قاعدة للمراجعة: 10% (موقوفة)» (off, demo — applies nowhere; for looking at the dry run); the demo tier «ذهبي» said
"double points" for ×1.5 (its written benefits corrected, with a reason). Open for the shell: at phone widths a
focused control can sit under the admin tab bar (no `scroll-padding-block-end`; requested).

## Requests to other owners

Done since the first build (2026-11-12): the commerce core's hooks (flash prices and claims, rules, the member
discount and free delivery, points redemption, referral codes at checkout — wave F core), the programme limits as
settings, the daily jobs, the shell's queue (`countDecidable`), the storefront's rewards page and gift-card redemption
into the wallet. Open:

- **POS (admin 06) + commerce core**: coupons, rules, flash prices, points redemption and the member discount at the
  till (today: price lists and the cashier's own discount; `CHECKOUT_STATE.*.pos` and `home.checkout.*.pos` change with
  it — the state test fails until they do).
- **Catalogue read layer**: show a running flash sale's price on product pages, lists and search (only the cart and
  checkout read it).
- **Commerce core + module 08**: early access to sales (a definition from the owner first), and a second person for a
  tier discount above the limits if tiers should ever give more than the limits.
- **Commerce core / POS + schema**: a sale line for gift cards (the liability account exists).
- **Lead (blueprint rows 08.02, 08.03, 08.05, 08.07, outside this module's rows)**: their "Missing" still says the
  checkout does not apply rules / flash prices / referral codes and that the chart lacks a gift-card account — and
  `/admin/promotions` shows them right under the «ما يُطبَّق اليوم» table that says otherwise. Proposed text in the
  wave-B review report (admin-promos-review; 08.02 corrected for the rules' stacking).
- **Admin shell**: at phone widths a control focused by keyboard can sit under the tab bar — `:root:has(.adm)` has a
  `scroll-padding-block-start` but no `-end` (fixes it when added for < 48rem: `calc(60px + var(--safe-bottom) + 8px)`).
- **Module 08 services (comments)**: the headers of `discounts.server.ts`, `flash.server.ts`, `referrals.server.ts`,
  `rules.ts`, `vip.server.ts` and `giftcards.server.ts` still say the core does not apply them; `loyalty.server.ts`'s
  header is corrected.

## Module follow-up 2026-11-12

Programme rules in force: `program.server.ts` `programRules(db)` → `{ limits, loyalty, referral, giftCard }` in the constants' shapes (settings `promotions.discount_limits`, `.loyalty`, `.referral`, `.gift_card` — money-control limits; defaults = DISCOUNT_LIMITS, LOYALTY, REFERRAL, GIFT_CARD; batch sizes, rate limits, the step and the uses cap stay constants). Optional arguments: `discountApprovalReasons(terms, { limits })`, `couponReasons(terms, limits?)`, `ruleReasons(terms, limits?)`, `pointsFor(order, multiplierBps, pointsPerThousandIqd?)`. The layout sends `program`; pages read it with `useProgram()` (ui.tsx). `IssueCodeInput.maxUses` is optional (blank = the setting's default); `issueGiftCard` checks the in-force min/max (the schema keeps the absolute bounds). Spans of days use `daySpan`.

Tests (each failed before its change): `tests/admin-settings-keys.test.ts`.

Review of the follow-up (2026-11-12): VIP eligibility (`vipPage`'s list and count, the front page's `vip.eligible`) uses module 07's rule with the thresholds in force (`customerRules(db).flags`), like the flags beside each name; `VipPage.rule` carries them and the page states them (no fixed "2,000,000 IQD / 5 / 365 days"). Points given after a second person's approval and referral rewards expire after `promotions.loyalty.expiry_days` (`rewardPointsStatement` takes an optional `expiryDays`). Day counts that are settings read through `daySpan` (VIP flag lines, the return window on the points page). Tests: `tests/admin-followup-review.test.ts`.
