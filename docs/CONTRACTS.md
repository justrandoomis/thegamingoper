# Service contracts between areas

`docs/ARCHITECTURE.md` says how to write code; this file says **who owns which service module and which functions other areas may call**. Signatures here are binding: owners implement them exactly, callers code against them even before the implementation lands. If a signature must change, the owner updates this file in the same change and lists the callers affected.

Conventions for every function below: first argument `db: Db`; mutations take an `Actor` (from `~/server/actor`) and `now: number`; inputs are validated with zod inside the service; expected failures throw `AppError`; results are view models from `~/lib/dto` (localized, no protected fields) unless stated. "ctx" means `RequestCtx` from `~/server/context.server` (services may accept the small pieces they need — `locale`, `ip`, `now` — instead of the whole object so tests stay simple).

## 1. Commerce core — `app/server/services/` (owners: commerce-core team)

The transactional heart. Storefront and admin both call it; neither re-implements stock, totals, payments or ledger logic. Synced with the implementation on 2026-11-11 (commerce core parts 1–3 and the adversarial pass, `tests/commerce-*.test.ts`). Each file's header comment lists every `AppError` code it throws.

Shared rules:
- Inputs called `raw` are parsed with the exported zod schema of the same name (`CheckoutInput`, `SubmitProofInput`, …); field errors come back as `AppError("invalid", 400, { fields })` with keys such as `required`, `too_long`.
- Error texts live in the `errors` namespace (`app/i18n/messages/errors.ts`) under `errors.<code>`: on the server `actionError(e, serverT(locale, "errors"))`, on the client ``t(`errors.${code}`)`` — never `t(code)`.
- Mutations that can be retried take an `idempotencyKey` and return `replayed: true` for a repeat instead of acting twice.
- `accountCode` in journal lines is an account's **system key** (e.g. `"sales_revenue"`), never its numeric code (codes can be renumbered).

### `inventory/stock.server.ts`
```ts
getAvailability(db, variantIds: readonly string[]): Promise<Map<string, Availability>>   // { available, state }; available = Σ sellable (on_hand − reserved); never sent to shoppers as a number
stockStateOf(available, lowThreshold?): StockState
reserveStatements(db, { orderId, lines: { variantId, qty }[], expiresAt, actor, now }): BatchStatement[]   // reservation rows + reserved += qty + movements; DB trigger aborts the batch on shortage
releaseOrderReservationsStatements(db, { orderId, actor, reason, now }): BatchStatement[]
releaseOrderReservations(db, actor, orderId, reason, now): Promise<{ released: number }>          // cancel / expiry / rejection
commitOrderReservations(db, actor, orderId, now): Promise<CommitResult>                           // on shipment: on_hand −= qty, reserved −= qty, 'sale' movements, FIFO cost layers consumed. CommitResult carries COGS ([P] cost data): callers outside commerce core must not pass it on
expireReservations(db, now): Promise<{ released: number }>                                        // scheduled job; skips orders whose proof arrived mid-run
adjustStock(db, actor, raw: AdjustStockInput, now): Promise<void>      // { variantId, locationId, delta ≠ 0, reason, kind?: 'adjust'|'damage', unitCostIqd?, allowOversell? }; inventory.stock.adjust; taking available below zero needs allowOversell + inventory.oversell.authorize (re-checked at write time)
receiveStock(db, actor, raw: ReceiveStockInput, now): Promise<void>    // { variantId, locationId, qty, unitCostIqd [P], serials? (one per unit, serial-tracked only), ref, reason? } — does NOT post to the journal: purchasing posts the receipt with postStockReceipt
assignSerialsStatements(db, { orderItemId, serialIds, actor, now }): BatchStatement[]   // a serial is sold once; it must belong to the item's variant and not be held for another order or be a trade-in unit
reserveUsedUnitStatements(db, { usedUnitId, orderId, now }): BatchStatement[]            // listed → reserved, guarded
releaseUsedUnitStatements(db, { usedUnitId, now }): BatchStatement[]
```

### `shipping/fees.server.ts`
```ts
getShippingPolicy(db): Promise<{ flatFeeIqd: number; overridesEnabled: boolean }>
getShippingFee(db, governorateId): Promise<number>      // 5,000 IQD flat unless setting 'shipping.overrides_enabled' AND an active override row exists
listGovernorates(db, locale): Promise<GovernorateOption[]>
listDistricts(db, locale, governorateId): Promise<DistrictOption[]>
```

### `cart.server.ts`  (+ resource route `POST /api/cart`)
```ts
type CartOwner = { cartToken: string | null; customerId: string | null }
type CartRequest = CartOwner & { locale?: Locale; governorateId?: string | null }
getCartView(db, request: CartRequest, now): Promise<CartViewData>      // CartView (~/lib/dto) + couponIssue: { code, reason } | null — re-prices and re-checks stock on every read; sets line.problem
getCheckoutCart(db, request & { phoneE164? }, now): Promise<PricedCart> // what placeOrder prices with (server only)
getCartCount(db, owner: CartOwner): Promise<number>                    // used by the shell loader
addToCart(db, request, raw: { variantId? | usedUnitId?, qty }, now): Promise<{ cartToken: string; view: CartViewData; added: number }>   // creates the cart lazily; set the token as the httpOnly `tt_cart` cookie
setLineQty(db, request, lineId, qty, now): Promise<CartViewData>       // qty 0 removes
removeLine(db, request, lineId, now): Promise<CartViewData>
applyCoupon(db, request, code | null, now): Promise<CartViewData>
changeLineQty / deleteLine / changeCoupon(…, options?: { rekey? }): Promise<{ cartToken: string | null; view }>   // the same changes, for callers that may rotate the cart token
mergeGuestCart(db, owner: CartOwner, now): Promise<void>               // on sign-in
```
`POST /api/cart` form fields: `intent` = `add` | `set` | `remove` | `coupon`, plus `variantId` | `usedUnitId`, `qty`, `lineId`, `code`. Response JSON: `ActionResult<{ cart: CartView }>`. Rate-limited; never trusts client prices; cross-site posts get 403.

### `coupons.server.ts`
```ts
normalizeCouponCode(code: unknown): string | null
evaluateCoupon(db, { code, subtotalIqd, lines, customerId, phoneE164 }, now): Promise<{ ok: true; couponId; code; label; discountIqd } | { ok: false; reason: 'not_found'|'expired'|'not_started'|'min_subtotal'|'usage_limit'|'customer_limit'|'not_applicable' }>
```

### `orders/totals.ts`  (pure, no db)
```ts
computeTotals(input: { lines: { unitPriceIqd: number; qty: number }[]; discountIqd: number; shippingIqd: number }): { subtotalIqd; discountIqd; shippingIqd; totalIqd }   // integers only; throws on NaN/negative totals
```

### `orders/place.server.ts`
```ts
placeOrder(db, who: CheckoutWho, raw: CheckoutInput, now): Promise<PlaceOrderResult>
type CheckoutWho = { cartToken: string | null; customer: { id: string } | null; locale; ip: string | null; storeMode: 'demo'|'live'; requestId? }
type CheckoutInput = {
  idempotencyKey: string;                    // generated by the checkout page once per attempt
  contactName?: string; phone: string;       // phone normalised with normalizeIraqPhone — required
  governorateId: string; districtId?: string; areaText: string; addressText: string;   // required: governorate, area/district, detailed address
  notes?: string; preferredDay?: string;     // preferredDay: YYYY-MM-DD, today … +30 days (Baghdad)
  preferredWindow?: 'morning'|'afternoon'|'evening'|'any';   // "" from an HTML form counts as not given (also districtId)
  marketingConsent: boolean;                 // never defaulted to true
  paymentMethod: 'cod'|'wallet'|'bank_transfer'|'zaincash';  // 'wallet' only for signed-in customers
  expectedTotalIqd: number;                  // what the shopper saw
};
type PlaceOrderResult = { ref; orderId; accessToken; paymentStatus; totalIqd; replayed: boolean }
```
One `db.batch`: order + items (price/name snapshots, cost snapshot `[P]`), stock reservations (and used-unit reservation), coupon redemption, payment row, wallet debit when paying by wallet, order event, cart emptied, audit. Outcomes: `cod` → status `new`, payment `cod_due` (COD orders hold their stock until staff act — they do not expire); `wallet` → status `confirmed`, payment `paid` (ledger debit in the same batch — overdraft trigger aborts everything); `bank_transfer`/`zaincash` → status `awaiting_payment`, payment `pending` until a proof is submitted, cancelled by the scheduled job when the proof window (`checkout.transfer_proof_hours`) ends without one. A retry with the same `idempotencyKey` returns the first result (`replayed: true`); two simultaneous submissions produce one order. Guests are never asked to register.

Refusals throw `CheckoutError` (an `AppError` with `.cart: CartViewData | null` — the cart as it is now, so the page can show what changed) with one of `CHECKOUT_ERROR_KEYS`: `cart_empty`, `cart_blocked`, `cart_changed`, `totals_changed` (409), `insufficient_stock`, `used_unit_not_available`, `payment_method_unavailable`, `wallet_requires_account`, `wallet_insufficient`, `shipping_unavailable`, `district_invalid`, `preferred_day_invalid`, `phone_invalid`, `idempotency_conflict`, `account_blocked`, `coupon_usage_limit`, `coupon_customer_limit`, `period_closed`.

`accessToken` is derived from the order id and the shopper's key; only its hash is stored. The confirmation link is **`/order/<ref>?t=<accessToken>`**.

### `orders/state.ts` + `orders/manage.server.ts`
```ts
ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]>
transitionPermission(from, to): Permission                         // which permission a transition needs (the admin uses it to offer actions)
transitionOrder(db, actor, orderId, to: OrderStatus, opts: TransitionOptions, now): Promise<void>
type TransitionOptions = {
  reason?: string;                           // required (≥ 3 chars) for cancelled and returned
  goods?: { orderItemId; qty; disposition: 'restock'|'scrap'; serialIds? }[];   // shipped → returned only; default: everything that left comes back and is restocked
  locationId?: string;                       // where restocked goods go (default: where they left from)
  from?: OrderStatus | OrderStatus[];        // optimistic guard: if the order moved on since the caller decided → AppError('order_changed', 409). Jobs always pass it
};
normalizeOrderRef(ref: unknown): string | null
getOrderForCustomer(db, customerId, ref, locale, now?): Promise<OrderView | null>
getOrderByAccessToken(db, ref, accessToken, locale, now?): Promise<OrderView | null>                 // the guest confirmation page
lookupGuestOrder(db, { ref, phone }, { ip, locale? }, now): Promise<OrderView | null>                 // needs BOTH; rate-limited; same answer for "wrong ref" and "wrong phone"
listOrdersForCustomer(db, customerId, locale, page?: { cursor?; limit? }): Promise<Paged<OrderSummary>>
```
Permissions: → confirmed `orders.order.update` (COD, after the phone confirmation) · → preparing `orders.fulfillment.pack` · → shipped `orders.fulfillment.ship` · → delivered `orders.fulfillment.deliver` · → cancelled `orders.order.cancel` · → returned `shipping.attempt.manage` (from shipped) or `returns.rma.approve` (from delivered). The payment moves (`awaiting_payment` ⇄ `payment_review` → `confirmed`) are refused here: only `submitPaymentProof` / `verifyPayment` make them, so no order is confirmed without a verified payment. Moving to the current state is a no-op.

Side effects (all in the transition's batch, guarded by the current status; each writes an order event and an audit event — the file header has the full list): shipped → every serial-tracked unit scanned first (`serials_required`), the order must still hold its stock (`stock_not_reserved`), reservations committed with FIFO landed cost; delivered → warranties start, `postSale` + `postCogs` (refunds issued before delivery move to sales refunds then, so customer control nets to zero); cancelled → reservations and used units released, packed serials back to stock, coupon use freed, unpaid payment rows cancelled, and every **paid** payment gets a **pending** refund (issued by `approveRefund`, four eyes); returned from shipped → goods back per `goods` (restock by default), coupon freed, unpaid COD payment cancelled, paid payments get a pending refund; returned from delivered → status only (goods and money go through `createRefund` after inspection). `transitionOrder` does **not** touch `shipments` rows — the shipping module owns those.

`OrderView`/`OrderSummary` are defined in `orders/types.ts` (client-safe): statuses, lines, totals, payment state and instructions, shipment tracking events, proof status (a shopper may upload again after a rejection; amount due shows 0 once paid) — never cost data or other customers' data.

### `payments/payments.server.ts`
```ts
getPaymentInstructions(db, locale?): Promise<{ cod: { enabled }; wallet: { enabled }; bankTransfer: { enabled; accountNumber; recipientName }; zaincash: { enabled; number } }>   // from settings
submitPaymentProof(db, who: { orderRef; accessToken?; customerId?; ip? }, raw: { fileId; declaredAmountIqd; note?; reference? }, now): Promise<{ proofId: string; duplicateOf: string | null }>
verifyPayment(db, actor, paymentId, raw: { approve: boolean; note?; receivedAmountIqd? }, now): Promise<{ status: 'paid'|'rejected'; override: boolean; replayed: boolean }>
recordCodCollection(db, actor, orderId, amountIqd, now, opts?: { reason? }): Promise<{ paymentId: string; replayed: boolean }>
```
- `submitPaymentProof`: `fileId` is a private `files` row of kind `payment_proof` (stored by `POST /api/upload/proof` with `visibility: "private"`). Order → `payment_review`, payment → `pending_verification`; replaces a rejected proof. Errors: `proof_not_expected`, `payment_window_closed`, `proof_file_invalid` (409); someone else's order is `not_found`. `duplicateOf` (an earlier proof with the same file hash or reference) is **for staff only — never show it to the shopper**.
- `verifyPayment` (permission `orders.payment.verify`, employees only): approving needs the proof's **declared** amount and the **received** amount (default: the declared amount) both to equal the amount due; otherwise it needs `orders.payment.override` and a reason in `note`, else `amount_mismatch` (403). Approve → payment `paid`, order `confirmed`, journal entry. Reject (`note` required, shown to the shopper) → payment rejected, order back to `awaiting_payment` with a new proof window. Repeating the same decision returns `replayed: true`.

### `wallet.server.ts`
```ts
getWalletBalance(db, customerId): Promise<number>                                                  // SUM of the ledger
listWalletEntries(db, customerId, page?: { cursor?; limit? }): Promise<Paged<WalletEntryView>>
walletDebitStatement(db, { customerId, amountIqd, refType, refId, idempotencyKey, actor, now }): BatchStatement   // used inside placeOrder only
walletCreditStatement(db, { …, kind }): BatchStatement                                              // used by refunds
creditWallet(db, actor, raw: { customerId, amountIqd, kind: 'topup'|'adjustment'|'trade_in_credit', refType?, refId?, reason, idempotencyKey, fundedBy?: 'cash'|'bank_clearing' }, now): Promise<{ entryId: string; replayed: boolean }>
```
Refunds to the wallet go **only** through `createRefund`/`approveRefund` (so the database's refund limits always apply); `creditWallet` is for top-ups, adjustments and trade-in credit.

### `refunds.server.ts`
```ts
getRefundableAmount(db, paymentId): Promise<number>
createRefund(db, actor, raw: CreateRefundInput, now): Promise<{ refundId: string; status: 'pending'|'paid'; replayed: boolean }>
type CreateRefundInput = { orderId; paymentId; items?: { orderItemId; qty; disposition?: 'restock'|'scrap'; serialIds? }[]; amountIqd; method: 'original'|'wallet'|'cash'; reason; reference?; idempotencyKey?; locationId? }
approveRefund(db, actor, refundId, decision: { approve: boolean; note?; reference? }, now): Promise<{ status: 'paid'|'rejected' }>
listPendingRefunds(db, actor, limit?): Promise<Refund[]>
```
`createRefund` needs `orders.refund.create`; at or below `refunds.approval_threshold_iqd` it is issued at once (`paid`), above it it waits (`pending`). `approveRefund` needs `orders.refund.approve` and **the approver must not be the requester** (`approver_is_requester`, 403) — two-person rule. An `original` refund of a bank / Zain Cash payment needs the outgoing transfer `reference`. Refunds created by a cancellation always wait for approval. Bounded by DB triggers (never more than was paid, never more units than were sold). Errors: `payment_not_paid`, `refund_exceeds_payment`, `refund_qty_exceeds`, `wallet_requires_account`, `return_exceeds_shipped`, `period_closed` (409).

### `orders/returns.server.ts`
`planReturnedGoods(…)` — what returned units do (restock / scrap, serials released) for refunds and `returned` transitions; used inside commerce core only.

### `accounting/post.server.ts`
```ts
journalStatements(db, { at, memo, refType, refId, createdBy, lines: { accountCode /* system key */, debitIqd?, creditIqd?, costCenter? }[] }): BatchStatement[]   // balanced or it throws before touching the DB; closed periods rejected
standard postings: postPaymentReceived, postCodCollected, postTransferVerified, postWalletPayment, postSale, postCogs, postRefund, postReturnedGoods, postWalletTopup, postWalletCredit, postStockReceipt
receivingAccount(method): SystemAccountKey; posting keys: paymentPostingKey, salePostingKey, cogsPostingKey, refundPostingKey, returnedGoodsPostingKey, walletCreditPostingKey
```
Profit follows `docs/metrics.md` (written by the core team): net revenue − COGS (landed) − commissions − shipping subsidy. Carrier costs (the shipping subsidy) and conversion rate are not measurable yet: the shipping module must post carrier costs to `shipping_costs`.

### `app/server/jobs.server.ts` (scheduled jobs)
`runScheduledJobs(db, cron, now, env?)` is called by the Worker's `scheduled` handler (`workers/app.ts`, crons in `wrangler.jsonc`); `runJob(db, job, now, { origin, triggeredBy })` lets the operations module re-run a job (caller checks `ops.job.run`); `listJobRuns(db, job?, limit?)` for the ops screens (caller checks `ops.job.read`). Every run is a `job_runs` row.

## 2. Catalogue read layer (owner: storefront shell team)
`catalog/cards.server.ts` — `getCardsByIds`, `listCards`, `getNewArrivals`, `getDeals`, `getUsedSpotlight`; `catalog/taxonomy.server.ts` — `getPlatforms`, `getCategoryTree`, `getNavTaxonomy`. See the files for exact types.

**Shell contract for every storefront page** (`app/routes/storefront/shell/README.md` has the examples): no `<main>` of your own (the shell's `<main id="main">` is the landmark — start with the `<h1>`); build `meta` with `shellMeta(args, { title, description, image, type })` from `~/routes/storefront/shell/meta` (React Router replaces the layout's meta, so this keeps canonical, hreflang, Open Graph and demo-mode noindex); a page with its own bottom bar declares `handle = { shell: { tabBar: false } } satisfies ShellHandle` and renders `<TaskBar>`; sticky page elements sit at `inset-block-end: var(--shell-bottom)`. Product pages use `productShareImage(slug)` from `~/art` for `og:image`. The header search calls `GET /api/search/suggest?q=&locale=` → `{ suggestions: { label, href /* locale-less */, hint? }[] }` (catalog area); the footer links `/policies/shipping|returns|warranty|privacy|terms`, `/about`, `/contact`, `/accessibility` (content area).

## 3. Storefront areas (each owns its routes folder, its messages namespace(s), its tests, and the service modules listed)

| Area | Routes | Service modules it owns | Functions other areas may call |
|---|---|---|---|
| home | `/` + intro/onboarding | — | — |
| catalog | `/c/:category`, `/platform/:platform`, `/search`, `/compare`, `GET /api/search/suggest` | `search.server.ts`, `catalog/listing.server.ts` | `searchProducts(db, locale, q, opts) → Paged<ProductCardData> & { suggestions; zeroResultHelp }` |
| product | `/p/:slug` (+ quick preview) | `catalog/product.server.ts`, `reviews.server.ts` | `getProductDetail(db, locale, slug) → ProductDetail \| null`, `getReviewSummary(db, productId)` |
| checkout | `/cart`, `/checkout`, `/order/:ref`, `/track`, `POST /api/upload/proof` | UI only — calls commerce core | — |
| account | `/account/*`, `/wishlist`, `POST /api/wishlist` | `account/*.server.ts`, `wishlist.server.ts` | `getWishlistIds(db, { customerId, cartToken })`, `toggleWishlist(db, who, productId, now)` |
| devices | `/device/:model`, `POST /api/events` | `devices.server.ts`, `compatibility.server.ts`, `recommendations.server.ts` | `getCompatibilityForProduct(db, locale, productId) → { deviceSlug; deviceName; status: CompatibilityStatus; note }[]`, `getRecommendations(db, { locale, context: 'home'\|'product'\|'cart'\|'post_purchase'\|'device_hub'\|'search'; productId?; deviceModelId?; cartVariantIds?; platformSlugs?; sessionHash?; customerId?; consent: boolean }, limit) → Shelf<ProductCardData>[]` (hard compatibility filter, stock-aware, honest `reason`), `recordEvent(db, …)` (no-op without consent) |
| used | `/used`, `/used/:slug`, `/trade-in`, `/trade-in/:ref` | `used.server.ts`, `tradein.server.ts` | `listUsedUnits(db, locale, filters) → Paged<UsedUnitCardData>`, `getUsedUnitDetail`, `createTradeIn`, `getTradeInByRef` |
| support | `/support`, `/support/article/:slug`, `/support/assistant`, `/support/repair` | `support/kb.server.ts`, `support/assistant.server.ts`, `support/tickets.server.ts`, `support/repairs.server.ts` | `listArticlesForDevice(db, locale, deviceModelId)`, `createRepairTicket`, `createSupportTicket` |
| content | `/about`, `/contact`, `/policies/:slug`, `/accessibility`, `/sitemap.xml`, `/robots.txt` | `content.server.ts` | `getPolicy(db, locale, slug)` |

Cross-area UI (recommendation shelves on home/product/cart, compatibility on the product page, device links) is wired by the **integration pass** after the areas land; until then an area renders without the other area's section rather than importing something that may not exist.

## 4. Admin modules (each owns `app/routes/admin/<module>/**`, its messages namespace `admin-<module>`, tests, and `services/admin/<module>/**`)

Admin code calls the commerce core for anything that moves stock, money or order state — it never writes those tables directly. Every admin loader/action starts with `requireEmployee(ctx, db, "<permission>")`. Lists read their filter/sort/page state from the URL. Destructive or financial actions go through the confirm-with-reason dialog and show the stock/financial impact before confirming. Cost and profit columns are fetched only when `can(actor, "cost.read")` / `"profit.read"` — including CSV exports.

The module ↔ blueprint mapping and the status of each of the 176 functions live in `app/routes/admin/blueprint-status.ts` (owner: admin shell): each function id (`"05.03"`) → `{ status: 'implemented'|'partial'|'boundary'|'planned', route?, note? }`. Module owners update their own entries truthfully; the admin shows this registry on every module page and `docs/STATUS.md` is generated from it.
