# Admin 08 — Promotions & loyalty

Owner: admin promotions. Routes `app/routes/admin/promotions/**`, services `app/server/services/admin/promotions/**`
(pure rules in `rules.ts`, client-safe types in `types.ts`), strings `app/i18n/messages/admin-promotions.ts` (ar source,
en, ckb), tests `tests/admin-promotions*.test.ts`. Blueprint 08.01 implemented; 08.02–08.08 partial (the commerce core
does not apply them at checkout yet — "Requests"). Adversarial review 2026-11-12: `tests/admin-promotions-review.test.ts`.

## Routes

| Path | What | Permission (loader / actions) |
|---|---|---|
| `/admin/promotions` | What waits for this employee, each section's counted figures, what the checkout applies today, `<ModuleFunctions moduleId="08">` | any promotions.* |
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

## Boundaries (honest)

The checkout applies coupons and the wallet only. Rules, flash prices, points redemption and VIP discount / free
delivery need the core hooks below; referral codes cannot be typed by shoppers; visitors are not assigned to A/B
variants; gift cards cannot be sold for money (no liability account, no sale line). Programme limits are module
constants (settings keys requested). Posting points / expiry / closing memberships are staff actions (no job yet).
A tier's member discount has no second-person rule yet (harmless until the core applies it; see Requests).

## Tests and verification

- `tests/admin-promotions.test.ts` (26): pure rules; roles; coupons; dry run; flash; points; referrals; VIP; gift
  cards; A/B; races; route glue.
- `tests/admin-promotions-review.test.ts` (16, each failed on the builder's code): flash field rules, the 30-day high,
  the decision-time override, split point adjustments (two tabs too), one waiting request per record (two requests at
  once), IDOR on the coupon and points pages, redemption replay / demo card / merged customer, the redemption check,
  the referral race, Arabic qty in "try", 100 coupons off, gift-card and VIP counts.
- `tests/admin-promotions-routes.test.ts` (1): every loader and intent for six roles answers 200 / 400 / 403 / 404.

Browser: `.shots/admin-promotions/` (seed `seed-promotions.ts`, ids `refs.ts`), review shots in `review/`.

## Requests to other owners

- **Commerce core** — `priceCart` (cart.server.ts): (1) unit price = the running flash sale's price; (2) after the
  subtotal, before the coupon: `evaluateRule` (rules.ts, pure) over active `promotions` by priority, stacking per rule;
  (3) membership `discountBps` and free delivery; (4) "redeem N points" = N × `LOYALTY.pointValueIqd` off. `placeOrder`'s
  batch: claim `flash_sale_items.qty_sold` (guarded by `qty_limit`, per-customer limit), a `loyalty_ledger` 'redeem'
  row, the rule applied (order event), a `referral_redemptions` row from a typed code. `transitionOrder` → delivered
  could post the earn row itself (today: staff "post points"). Before the member discount is applied, a tier discount
  above `DISCOUNT_LIMITS.percentBps` should need a second person (module 08 adds it with the hook).
- **Schema / data**: a `gift_card_liability` system account and a POS / checkout sale line for gift cards.
- **Settings 22 + server core**: keys for `DISCOUNT_LIMITS`, `LOYALTY` (incl. `adjustSoloDayPoints`),
  `REFERRAL.rewardPoints`, `GIFT_CARD` limits.
- **Jobs**: daily `syncOrderPoints`, `postExpiry`, `expireGiftCards`, `closeEndedMemberships`.
- **Shell (queues)**: `countDecidable(db, actor)` (approvals.server.ts) → `/admin/promotions/approvals`.
- **Storefront (account)**: show points, membership benefits, a referral code field and "add a gift card to my wallet"
  (service: `redeemGiftCard` with a customer actor needs a customer-facing variant — requested from the core).
