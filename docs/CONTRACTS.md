# Service contracts between areas

`docs/ARCHITECTURE.md` says how to write code; this file says **who owns which service module and which functions other areas may call**. Signatures here are binding: owners implement them exactly, callers code against them even before the implementation lands. If a signature must change, the owner updates this file in the same change and lists the callers affected.

Conventions for every function below: first argument `db: Db`; mutations take an `Actor` (from `~/server/actor`) and `now: number`; inputs are validated with zod inside the service; expected failures throw `AppError`; results are view models from `~/lib/dto` (localized, no protected fields) unless stated. "ctx" means `RequestCtx` from `~/server/context.server` (services may accept the small pieces they need — `locale`, `ip`, `now` — instead of the whole object so tests stay simple).

## 1. Commerce core — `app/server/services/` (owners: commerce-core team)

The transactional heart. Storefront and admin both call it; neither re-implements stock, totals, payments or ledger logic. Synced with the implementation on 2026-11-11 (commerce core parts 1–3 and the adversarial pass, `tests/commerce-*.test.ts`). Each file's header comment lists every `AppError` code it throws.

Shared rules:
- Inputs called `raw` are parsed with the exported zod schema of the same name (`CheckoutInput`, `SubmitProofInput`, …); field errors come back as `AppError("invalid", 400, { fields })` with keys such as `required`, `too_long`.
- Error texts live in the `errors` namespace (`app/i18n/messages/errors.ts`) under `errors.<code>`: on the server `actionError(e, serverT(locale, "errors"))`, on the client ``t(`errors.${code}`)`` — never `t(code)`. The account services' codes (`ACCOUNT_ERROR_KEYS`) and the trade-in service's (`TRADE_IN_ERROR_KEYS`) are there too since 2026-11-11, ADOPTED from their areas' namespaces (`account:errors.*`, `used:errors.*` — the one copy of each sentence; `idempotency_conflict` keeps the checkout wording in `errors`), so a screen outside those areas can show them.
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

Refusals throw `CheckoutError` (an `AppError` with `.cart: CartViewData | null` — the cart as it is now, so the page can show what changed) with one of `CHECKOUT_ERROR_KEYS`: `cart_empty` (no cart, or a cart without lines), `cart_blocked` (a line that cannot be bought — sold out or off sale — also when that is every line; since 2026-11-11, was `cart_empty` then), `cart_changed`, `totals_changed` (409), `insufficient_stock`, `used_unit_not_available`, `payment_method_unavailable`, `wallet_requires_account`, `wallet_insufficient`, `shipping_unavailable`, `district_invalid`, `preferred_day_invalid`, `phone_invalid`, `idempotency_conflict`, `account_blocked`, `coupon_usage_limit`, `coupon_customer_limit`, `period_closed`.

`accessToken` is derived from the order id and the shopper's key; only its hash is stored. The confirmation link is **`/order/<ref>?t=<accessToken>`**.

Order lines snapshot their name with `lineName(productName, variantTitle)` (exported): the product name and the variant title joined with " — ", except that a title which already contains the product's name stands alone ("Resident Evil Requiem لجهاز PS5") and a title that opens with the product's short name keeps only its detail ("يد التحكم اللاسلكية DualSense — أبيض"); whole words, case-insensitive.

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
getPaymentProofFileForShopper(db, store: BlobStore, fileId, who: { accessToken?; customerId? }): Promise<StoredFile | null>   // the proof's picture for its order's shopper only
latestProofFileId(db, orderRef): Promise<string | null>                                       // the order's newest proof file (call only for an order already opened for this shopper)
```
- `submitPaymentProof`: `fileId` is a private `files` row of kind `payment_proof` (stored by `POST /api/upload/proof` with `visibility: "private"`). Order → `payment_review`, payment → `pending_verification`; replaces a rejected proof. Errors: `proof_not_expected`, `payment_window_closed`, `proof_file_invalid` (409); someone else's order is `not_found`. `duplicateOf` (an earlier proof with the same file hash or reference) is **for staff only — never show it to the shopper**.
- **Showing a stored proof back to the shopper** (since 2026-11-11): `GET /api/files/:fileId` (`app/routes/api/files.ts`, server core) serves a private transfer proof to the order's signed-in owner or with the order's confirmation token (`?t=`), and a wallet top-up proof to the customer who uploaded it — every other request is the same 404; answers `private, no-store`, `Cross-Origin-Resource-Policy: same-origin`, sandboxed. Build the URL with `shopperFilePath(fileId, accessToken?)` (`~/server/storage.server`). `POST /api/upload/proof` answers `{ ok: true, previewUrl }` with it; after a reload the order page can rebuild it from `latestProofFileId(db, ref)`.
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

### `orders/edit.server.ts`  (added by admin 05 orders on 2026-11-11 — a commerce-core file with its own tests, `tests/admin-orders-edit.test.ts`)
```ts
planOrderEdit(db, actor, orderId, raw: EditOrderInput): Promise<EditPlan>        // the preview: writes nothing, throws what editOrder would
editOrder(db, actor, orderId, raw: EditOrderInput & { idempotencyKey }, now): Promise<{ replayed; plan: EditPlan | null; totalIqd }>
orderEditBlockers(db, order): Promise<{ lines: string | null; address: string | null }>   // cheap, for the order page
editLineFloors(db, orderId): Promise<Map<orderItemId, minQty>>                    // units verified at the packing station: the lowest quantity per line (absent = 0)
type EditOrderInput = { lines?: { orderItemId; qty /* 0 removes */ }[]; address?: { contactName?; phone? /* empty: the order keeps its number */; governorateId; districtId?; areaText; addressText; notes? }; reason /* ≥ 3 */; idempotencyKey?; expectedTotalIqd? }
type EditPlan = { lines; before; after /* EditTotals */; stock: { variantId; sku; deltaQty }[]; usedUnitsReleased; coupon: { code; beforeIqd; afterIqd; lost } | null; payment: { paymentId; method; fromIqd; toIqd } | null; address: { changed; shippingBeforeIqd; shippingAfterIqd } }
```
Needs `orders.order.update`; before shipping only (new, awaiting_payment, confirmed, preparing; web orders). ONE batch, guarded on the order's `updated_at` and `paid_iqd`, the reservation rows and the payment row; re-planned up to three times, and a total other than `expectedTotalIqd` → `totals_changed`. Lines are updated or deleted (with their not-yet-packed parcel rows). Per stocked variant (bundles = their components) the hold follows the new need: more through `reserveStatements` (a shortage aborts everything: `insufficient_stock`), less by releasing or reducing the newest reservation rows with `release` movements; a removed used device goes back on sale (`releaseUsedUnitStatements`). Totals are recomputed (CHECK-safe); a coupon is re-applied by its own rule (eligibility replicated from `coupons.server.ts` — a shared helper is requested from its owner) and voided when it no longer applies; the open payment (`pending` cash on delivery, an awaited transfer `pending`/`rejected`) asks for the new total. An `edited` order event whose id derives from the idempotency key (a retry, also a concurrent one, returns `replayed: true`) and an audit event. **A paid order's lines and total never change** (`edit_paid_order`): `postSale` counts every refund issued before delivery as a sales refund, so a price reduction refunded before delivery would leave customer control unbalanced; address-only edits that keep the total are allowed. **An issued invoice freezes lines and total too** (`edit_invoiced`; address edits that keep the total stay possible), and **a line never goes below the units verified at the packing station** (`edit_units_scanned`) — both re-checked inside the batch (`expectThat`, re-planned on failure). An address edit without a phone keeps the order's number (employees without `customer.phone.read_full` never receive it). Errors: `edit_not_allowed`, `edit_payment_in_review`, `edit_has_refunds`, `edit_paid_order`, `edit_invoiced`, `edit_serials_attached`, `edit_units_scanned`, `edit_parcel_packed`, `edit_no_change`, `edit_empty_order`, `edit_used_unit_qty` (400), `edit_line_referenced`, `totals_changed`, `order_changed`, `insufficient_stock`, `shipping_unavailable`, `invalid` (texts in `admin-orders` → `errors.*` until the errors owner adds them).

### `inventory/transfers.server.ts`  (added by admin 04 inventory on 2026-11-11 — a commerce-core file with its own tests, `tests/admin-inventory-transfers.test.ts`; races in `tests/admin-inventory-adversarial.test.ts`)
```ts
createTransfer(db, actor, raw: { fromLocationId, toLocationId, lines: { variantId, qty }[], notes?, idempotencyKey }, now): Promise<{ transferId; ref; replayed }>   // a draft; moves nothing
shipTransfer(db, actor, raw: { transferId, serials?: { itemId, serials: string[] }[] }, now): Promise<{ replayed }>                                   // draft → in_transit
receiveTransfer(db, actor, raw: { transferId, lines?: { itemId, qty }[], serials?: string[], idempotencyKey }, now): Promise<{ received; complete; replayed }>
closeTransferShortfall(db, actor, raw: { transferId, reason, idempotencyKey }, now): Promise<{ lost; replayed }>                                     // what never arrived is written off
cancelTransfer(db, actor, raw: { transferId, reason }, now): Promise<{ replayed }>                                                                     // drafts only
fillLayers(layers, before, units)   // pure: how arriving units fill the transfer's destination layers (FIFO)
```
Permissions: create / ship / cancel `inventory.transfer.create` (branch of the source); receive `inventory.transfer.receive` (branch of the destination); shortfall `inventory.transfer.receive` + `inventory.stock.adjust`. Shipping is ONE batch: status guard, on_hand −= qty at the source with the guard on_hand − qty ≥ reserved (units promised to orders never leave → `insufficient_stock`), `incoming += qty` at the destination, the source's FIFO layers consumed and a twin layer per slice created at the destination (same unit cost, received_at, source, receipt item; `qty_remaining` 0 until the units arrive; id `<transfer>.L.<variant>.<n>`), one 'transfer_out' movement per slice (per serial for tracked units) with its unit cost [P], tracked serials in_stock → `intake` with no location (not sellable or packable), a used device's serial refused, audit. Receiving (partial or whole, any number of times): on_hand += qty, incoming −= qty, destination layers filled oldest first, 'transfer_in' movements (units that had no layer keep the standard-cost/unknown rule of fifo.ts), serials → in_stock at the destination; the transfer turns `received` when every line has arrived (decided in SQL, so concurrent partial receipts still close it). A shortfall writes a 'transfer_in' + 'damage' pair per lost slice at the destination (on_hand unchanged, the loss at its unit cost), missing serials → `scrapped`. Receipts and shortfall closes exclude each other: a receipt's batch requires the transfer still in transit (`transfer_not_in_transit` after a close), a close's batch requires that nothing arrived since it read (it reads again and writes off only what is still missing). `shortfallValue(db, actor, transferId): { units; valueIqd | null }` (cost.read) is what a close would write off now. Idempotency: the creation key decides the transfer id; ship/cancel are guarded status changes (repeat → `replayed: true`); receipt and shortfall keys are built into their movement ids (a repeat finds them, a race meets the primary key → `replayed: true`). Every movement carries a reason ("TR-…: FROM → TO"), the transfer reference, the actor and the time. Errors (`TRANSFER_ERROR_KEYS`; texts in `admin-inventory` → `errors.*` until the errors owner adds them): `invalid` (fields: `transfer_same_location`, `serials_required`, `serials_count`, `serials_duplicate`, `serials_not_tracked`, `transfer_serial_mismatch`), `forbidden`, `not_found`, `location_invalid`, `insufficient_stock`, `serial_not_available`, `transfer_not_draft`, `transfer_not_in_transit`, `transfer_changed`, `transfer_receive_exceeds`, `transfer_nothing_missing`.

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
`runScheduledJobs(db, cron, now, env?)` is called by the Worker's `scheduled` handler (`workers/app.ts`, crons in `wrangler.jsonc`); `runJob(db, job, now, { origin, triggeredBy })` lets the operations module re-run a job (caller checks `ops.job.run`); `listJobRuns(db, job?, limit?)` for the ops screens (caller checks `ops.job.read`). Every run is a `job_runs` row. The daily `retention` job also runs the areas' purges (`purgeAreaData`): recommendation signals, abandoned trade-in photos and — since 2026-11-11 — `purgeExpiredAssistantSessions(db, now)`: stored assistant conversations past their `expires_at`, with their messages (the ticket keeps its note and loses the link; `consents` rows are append-only and stay).

## 2. Catalogue read layer (owner: storefront shell team)
`catalog/cards.server.ts` — `getCardsByIds`, `listCards`, `getNewArrivals`, `getDeals`, `getUsedSpotlight`; `catalog/taxonomy.server.ts` — `getPlatforms`, `getCategoryTree`, `getNavTaxonomy`. See the files for exact types.

**Shell contract for every storefront page** (`app/routes/storefront/shell/README.md` has the examples): no `<main>` of your own (the shell's `<main id="main">` is the landmark — start with the `<h1>`); build `meta` with `shellMeta(args, { title, description, image, type })` from `~/routes/storefront/shell/meta` (React Router replaces the layout's meta, so this keeps canonical, hreflang, Open Graph and demo-mode noindex); a page with its own bottom bar declares `handle = { shell: { tabBar: false } } satisfies ShellHandle` and renders `<TaskBar>`; sticky page elements sit at `inset-block-end: var(--shell-bottom)`. Product pages use `productShareImage(slug)` from `~/art` for `og:image`. The header search calls `GET /api/search/suggest?q=&locale=` → `{ suggestions: { label, href /* locale-less */, hint? }[] }` (catalog area); the footer links `/policies/shipping|returns|warranty|privacy|terms`, `/about`, `/contact`, `/accessibility` (content area).

## 3. Storefront areas (each owns its routes folder, its messages namespace(s), its tests, and the service modules listed)

| Area | Routes | Service modules it owns | Functions other areas may call |
|---|---|---|---|
| home | `/` + intro/onboarding | — | — |
| catalog | `/c/:category`, `/platform/:platform`, `/search`, `/compare`, `GET /api/search/suggest` | `search.server.ts`, `catalog/listing.server.ts` | `searchProducts(db, locale, q, opts) → Paged<ProductCardData> & { suggestions; zeroResultHelp }` |
| product | `/p/:slug` (+ quick preview, `GET /api/product-preview/:slug`) | `catalog/product.server.ts`, `catalog/product-types.ts` (client-safe), `reviews.server.ts` | `getProductDetail(db, locale, slug, { now, related? }) → ProductDetail \| null` (stock state only, never quantities, costs or serials; `orderable` = what the cart accepts), `getReviewSummary(db, productId)`, `listVerifiedReviews`; the `QuickPreview` sheet |
| checkout | `/cart`, `/checkout`, `/order/:ref`, `/track`, `POST /api/upload/proof` | UI only — calls commerce core | — |
| account | `/account/*`, `/wishlist`, `POST /api/wishlist` (→ `{ ok, wished, count }`), `/account/wallet/proof` | `account/*.server.ts`, `wishlist.server.ts` | `getWishlistIds(db, { customerId, cartToken })`, `toggleWishlist(db, who, productId, now)`, `wishedAmong`, `wishlistWho`; `getDefaultAddress`, `listSavedDeviceIds`, `recordRecentlyViewed`; wallet top-up requests (approval belongs to the admin) |
| devices | `/device/:model`, `POST /api/events` | `devices.server.ts`, `compatibility.server.ts`, `recommendations.server.ts` | `getCompatibilityForProduct(db, locale, productId) → { deviceSlug; deviceName; status: CompatibilityStatus; note }[]`, `getRecommendations(db, { locale, context: 'home'\|'product'\|'cart'\|'post_purchase'\|'device_hub'\|'search'; productId?; deviceModelId?; cartVariantIds?; platformSlugs?; sessionHash?; customerId?; consent: boolean }, limit) → Shelf<ProductCardData>[]` (hard compatibility filter, stock-aware, honest `reason`), `recordEvent(db, …)` (no-op without consent) |
| used | `/used`, `/used/:slug`, `/trade-in`, `/trade-in/:ref`, `POST /api/upload/tradein` | `used.server.ts`, `tradein.server.ts` | `listUsedUnits(db, locale, filters) → Paged<UsedUnitCardData>`, `getUsedFacets`, `getUsedUnitDetail`, `createTradeIn`, `getTradeInByRef`, `lookupTradeIn`, `respondToOffer`, `purgeStaleTradeInDrafts` (daily retention job) |
| support | `/support`, `/support/article/:slug`, `/support/assistant`, `/support/repair` (+ status) | `support/kb.server.ts`, `support/assistant.server.ts` (`AssistantModel` slot; no AI is configured), `support/tickets.server.ts`, `support/repairs.server.ts` | `listArticlesForDevice(db, locale, deviceModelId)`, `createRepairTicket`, `createSupportTicket`, `handOffToStaff` |
| content | `/about`, `/contact`, `/policies`, `/policies/:slug`, `/accessibility`, `/sitemap.xml`, `/robots.txt` | `content.server.ts` | `getPolicy(db, locale, slug, { now, storeMode }?)` (an approved CMS row, else the code draft marked as awaiting the owner), `listPolicies`, `getPolicyDraftL10n` (admin), `getContactDetails`, `getStoreFacts`, `getCmsText`; `PRIVACY_COOKIES` (every shopper cookie) |

Every area's routes, states, slots and exports are in `docs/areas/<area>.md`. Cross-area UI (recommendation shelves on home/product/cart, compatibility on the product page, device links) is wired by the **integration pass** after the areas land; until then an area renders without the other area's section rather than importing something that may not exist.

## 4. Admin modules (each owns `app/routes/admin/<module>/**`, its messages namespace `admin-<module>`, tests, and `services/admin/<module>/**`)

Admin code calls the commerce core for anything that moves stock, money or order state — it never writes those tables directly. Every admin loader/action starts with `requireEmployee(ctx, db, "<permission>")`. Lists read their filter/sort/page state from the URL. Destructive or financial actions go through the confirm-with-reason dialog and show the stock/financial impact before confirming. Cost and profit columns are fetched only when `can(actor, "cost.read")` / `"profit.read"` — including CSV exports.

The module ↔ blueprint mapping and the status of each of the 176 functions live in `app/routes/admin/blueprint-status.ts` (owner: admin shell): each function id (`"05.03"`) → `{ status: 'implemented'|'partial'|'boundary'|'planned', route?, note? }`. Module owners update their own entries truthfully; the admin shows this registry on every module page and `docs/STATUS.md` is generated from it.

#### 02 catalog

`services/admin/catalog/` — authorization inside (`assertCan`); never writes prices, compare-at prices, costs or stock (a new variant is inserted with `price_iqd = 0` until pricing 03 sets it); every product write goes through `commitStatements` (version guard → `product_changed`, append-only `product_versions` snapshot, audit event, `search_index` statements LAST in the same batch). "Hidden" = status `draft` with `published_at` set. [C] landed cost only with cost.read, [P] margin only with profit.read (editor data and CSV). Details: `docs/areas/admin-catalog.md`.

```ts
// rules.ts (pure, client-safe)
completenessOf(facts, custom?) → { complete; missing: Requirement[]; missingCustom: string[] } · requirementsOf(kind) · newlyMissing(before, after)
WORKFLOW / actionsFrom(status) · adminStatusOf({ status, publishedAt }) · isLive({ status, publishAt }, now) · isSearchListed(status)
barcodeCheckDigitOk(code) · CSV_PRODUCT_COLUMNS · PRODUCT_KIND_LIST · OPTION_AXES · VARIANT_CONDITIONS
// search-index.server.ts — the one builder of a product's search rows (same rows as the seed)
productSearchStatements(db, productId, source) → BatchStatement[]   // delete + insert per locale; empty unless published/scheduled; append LAST
loadSearchSource(db, productId) · reindexProduct(db, productId) · catalogSearchDocs(source)
// product.server.ts
listProducts(db, actor, parseProductFilters(params), locale, now) · getProductEditor(db, actor, productId, locale, now)
createProduct(db, actor, raw, now, { demo? }) → { productId; replayed } · updateProductDetails(db, actor, raw: { productId, version, … }, now)
bulkUpdateProducts(db, actor, { ids, set, reason }, now) → { updated; skipped } · productsByExactCode(db, actor, code)   // SKU / barcode / model number
// variants.server.ts
getVariantsEditor(db, actor, productId, locale) · saveVariant(db, actor, raw, now) · setVariantActive(db, actor, { productId, variantId, version, active, reason }, now) · findVariantByCode(db, code)
// workflow.server.ts
changeProductStatus(db, actor, { productId, version, action, publishAt?, reason? }, now) · bulkChangeStatus(db, actor, raw, now)
publishDueProducts(db, now) → { published; returnedToDraft; conflicts }   // job PUBLISH_DUE_JOB = "catalog.publish_due" (*/5) — not yet in jobs.server.ts
// media, bundles, relations, compatibility, taxonomy, versions, import (signatures in the files)
addUploadedImage(db, store, actor, { productId, variantId?, alt?, isIllustration? }, file, now)   // via uploads.server.ts, public "product_image"
getBundle(db, actor, productId, locale)   // per-component availability from getAvailability
saveCompatibilityRule(db, actor, raw, now) · compareDevices(db, actor, slugs, locale)
saveCategory(db, actor, { id?, parentId?, slug, name, kind?, isActive, reason? }, now)   // switching off with products on sale or scheduled in its branch needs a reason
restoreVersion(db, actor, { productId, version, expectedVersion, reason }, now) → { version; restored }   // never prices, costs, stock, status, SKU, slug
previewImport(db, store, actor, source, raw, now) · applyImport(db, store, actor, jobId, now, { demo? }) · rollbackImport(db, actor, { jobId, reason }, now) → { restored; archived; conflicts }
exportProductsCsv / exportVariantsCsv(db, actor, filters, locale, now)   // [C]/[P] columns only with cost.read / profit.read; audited
```
Errors: `product_changed`, `incomplete` (detail = missing requirements), `regression`, `status_not_allowed`, `slug_taken`, `sku_taken`, `barcode_invalid`, `barcode_taken` (one code names one variant — its column or a SKU's extra codes), `category_cycle`, `category_not_empty`, `category_depth`, `track_serials_locked`, `variant_last_active`, `bundle_kind` (components only on a `bundle` product), `bundle_stocked` (the variant holds stock of its own), `bundle_nested`, `bundle_self`, `component_unknown`, `relation_self`, `target_unknown`, `subject_unknown`, `generation_platform`, `photo_unknown`, `media_duplicate`, `schedule_past`, `schedule_far`, `import_changed`, `import_state`, `import_empty`, `version_unknown`, `nothing_to_restore`, plus `invalid` field keys such as `kind_has_components` and `reason_required`, and `rate_limited` (429) from the routes (texts: `admin-catalog` → `errors.*`). A variant created on a published or scheduled product is saved inactive (no price yet); switching it on needs a price. Services check the permission before parsing the input or comparing the version. Gallery and CSV uploads share `RATE_LIMITS.upload` per employee (route helper `enforceUploadLimit`, key `upload:employee:<id>`).

#### 03 pricing

`services/admin/pricing/` — authorization inside (`assertCan`); [P] fields absent without cost.read / profit.read. Details: `docs/areas/admin-pricing.md`.

```ts
// rules.ts (pure, client-safe)
marginBps(priceIqd, costIqd): number | null; priceForMargin(costIqd, bps): number            // floored margins; lowest 250-step price keeping a margin
evaluatePriceChange({ oldPriceIqd, newPriceIqd, oldCompareAtIqd, newCompareAtIqd, cost: CostBasis | null, mode: "standard"|"clearance", referencePriceIqd? }): { reasons, needsApproval, needsOverride, floorIqd, referencePriceIqd, referenceDropBps, … }
dropReferencePrice(currentPriceIqd, createdAt, appliedChanges, now): number   // the 10 % limit counts from the highest price of DROP_WINDOW_DAYS (30), restarting at the last approved change
priceSegments(currentPriceIqd, createdAt, appliedChanges, now); compareAtCheck(valueIqd, segments, onSaleFrom, now)   // the 90-day "was" price rule
allocateAmount(totalIqd, weights) · planAllocation(amountIqd, "by_value"|"by_qty"|"by_weight"|"manual", lines, manual?)  // exact to the dinar
purchaseCostIqd(minor, decimals, rateMicros) · suggestPrice(input) · simulateUnit(input)
// prices.server.ts
listSkuPrices(db, actor, filters, locale) · allSkuPrices(…) · getSkuPricing(db, actor, variantId, locale, now)
previewPriceChange(db, actor, raw, locale, now) · requestPriceChange(db, actor, raw: { variantId, newPriceIqd, newCompareAtIqd?, reason, mode?, source?, idempotencyKey }, locale, now): { status: "applied"|"pending"; changeId; replayed; reasons }
decidePriceChange(db, actor, { requestId, decision: "approve"|"reject", note? }, locale, now) · cancelPriceChange(db, actor, { requestId, note? }, now)
listChanges(db, actor, query, locale) · countDecidable(db, actor) · impactsFor(db, actor, views)
// costs.server.ts
setVariantCost(db, actor, { variantId, currency, unitCost, fxRate?, fxDate?, extrasIqd?, reason, expectedUpdatedAt }, now) · getCostDetail(db, actor, variantId, now)
setMarginRules(db, actor, { variantId, minMargin?, targetMargin?, reason }, now) · setMarginRulesBulk(db, actor, { variantIds, … }, now)
// landed.server.ts — purchasing (09) calls these when receiving (receipt still a draft); branch-limited employees: their branch's receipts only
addLandedCost(db, actor, { receiptId, kind, currency, amount, fxRate?, method, reason, idempotencyKey }, now): { landedCostId; amountIqd; replayed }   // amountIqd ≤ MAX_BILL_IQD (10 bn)
previewAllocation(db, actor, { landedCostId, receiptId?, manual? }) · allocateLandedCost(db, actor, { landedCostId, receiptId?, manual?, updateVariantCosts? }, now) · removeLandedCost(db, actor, { landedCostId, receiptId?, reason }, now)   // receiptId: a bill of another receipt is not_found
loadBillContext(db, actor, landedCostId, receiptId?) → allocationStatements(db, { context, preview, updateVariantCosts, costRows, actor, reason, now }): BatchStatement[]   // for 09's own receiving batch; guarded on the receipt's other allocated bills (cost_changed)
// lists.server.ts
listPriceLists · getPriceList · savePriceList · setListItem · removeListItem · listsForVariant   // writes: a branch-limited employee → their branch's lists only (403)
resolveListPrice(db, { variantIds, qty?, channel?, branchId?, segmentIds?, at }): Map<variantId, { priceIqd; compareAtIqd; listId; listCode } | null>   // for the commerce core (not called yet)
// fx.server.ts — the store's USD rate (settings 22 links to /admin/pricing/fx)
getFxOverview(db, actor, now) · setFxRate(db, actor, { iqdPerUnit, source, effective: "now"|"YYYY-MM-DDTHH:mm", reason, idempotencyKey }, now) · storeRateAt(db, quote, at)
// simulate.server.ts, suggest.server.ts, special.server.ts, overview.server.ts
simulateDiscount / simulateAll(db, actor, parseSimulation(params).params, locale, now) · suggestForSku(db, actor, { variantId, marketIqd }, now)
listBundles · listClearance · listUsedForPricing (each unit with its waiting request, `pending`) · getPricingOverview
setUsedUnitPrice(db, actor, { usedUnitId, price, expectedPriceIqd, reason }, now): { changed; status: "applied"|"pending"|"unchanged"; requestId; replayed; reasons }   // the 03.05 limits; beyond them an approvals row (kind "used_price")
decideUsedPrice(db, actor, { approvalId, decision: "approve"|"reject", note? }, now) · cancelUsedPrice(db, actor, { approvalId, note? }, now) · countUsedDecidable(db, actor)   // four eyes, as for SKUs
```
Errors: `change_pending`, `price_changed`, `cost_changed`, `compare_at_not_charged`, `change_not_pending`, `approver_is_requester` (403), `override_required` (403), `not_requester` (403), `receipt_posted`, `allocation_basis_zero`, `line_value_missing`, `line_weight_missing`, `manual_sum_mismatch`, `code_taken`, `list_changed`, `unit_not_priceable`, `rate_unchanged`, plus `invalid` field keys (texts: `admin-pricing` → `errors.*`).

#### 04 inventory

`services/admin/inventory/` — authorization inside (`assertCan`; branch-limited employees act on their branch's locations); stock moves only through the commerce core (`receiveStock`, `adjustStock`, `releaseOrderReservations`, `inventory/transfers.server.ts`); the module itself writes documents (locations, cycle counts) and the planning columns `reorder_point` / `reorder_qty`. [P] value, unit costs, layers, standard costs and COGS absent without cost.read; serial numbers only with inventory.serial.read; movement rows (a SKU's latest, a unit's history) only with inventory.movement.read. Blind counts: nothing that reveals the system quantity reaches a counter while the count is open (getCount, and `differences: null` in listCounts). Details: `docs/areas/admin-inventory.md`.

```ts
// forecast.ts, csv.ts (pure)
salesRate({ unitsSold, windowDays, historyDays }): SalesRate · coverPlan({ available, incoming, reorderPoint, reorderQty, rate, now }): CoverPlan
toCsv(rows) · csvCell(value) · csvHeaders(filename)
// shared.server.ts
inventoryAccess(actor): InventoryAccess · locationTree(db): LocationNode[] · locationOptions(tree) · variantLabels(db, ids, locale) · employeeNames(db, ids)
// stock.server.ts — 04.01 04.06 04.09
listStock(db, actor, parseStockFilters(params), locale): StockPage · getVariantStock(db, actor, variantId, locale, now): VariantStock   // movements? only with inventory.movement.read
adjustFromAdmin(db, actor, { variantId, locationId, kind, direction, qty, reason, unitCostIqd?, allowOversell?, idempotencyKey }, now): { replayed }   // a reason starting "CC-… [" → invalid (reason_reserved)
setReorderPoint(db, actor, { variantId, locationId, reorderPoint | null, reorderQty | null }, now): { changed }
listOversell(db, actor, locale): { levels; authorizations } · recentMovements(db, actor, limit, locale)
// locations.server.ts — 04.02
listLocations(db, actor) · getLocation(db, actor, id) · createLocation(db, actor, { kind, parentId?, code, name, barcode?, isSellable?, branchId? }, now): { locationId; code }
updateLocation(db, actor, { locationId, name?, barcode?, isSellable?, isActive?, sort?, reason? }, now): { changed }   // switching off re-checked "not in use" inside the batch
locationLabels(db, actor, ids, { withChildren? })
// receiving.server.ts — 04.03
lookupCode(db, actor, code, locale): ScanHit   // variant (SKU/barcode) | serial (serial.read only, else serial_hidden) | location | none
receiveLine(db, actor, { sessionRef, locationId, variantId, counted, rejected?, rejectReason?, serials?, unitCostIqd? /* cost.read */, reference?, note?, idempotencyKey }, now): { accepted; rejected; replayed }
getReceivingSession(db, actor, ref, locale) · listReceivingSessions(db, actor, locale, limit?) · newReceivingSession() · standardCostFor(db, actor, variantId)   // [P]
// movements.server.ts — 04.04
listMovements(db, actor, parseMovementFilters(params), locale): MovementPage · movementsCsv(db, actor, filters, locale, headers): { csv; rows; truncated }
// counts.server.ts — 04.05
createCount(db, actor, { locationId, mode: "all"|"skus"|"sample", skus?, sampleSize?, notes?, idempotencyKey }, now) · recordCounts(db, actor, { countId, lines: { variantId, countedQty? | serials?, note? }[] }, now)
submitCount · approveCount(db, actor, { countId, reason, allowOversell? }, now, locale?): { posted; alreadyPosted; serialLines; replayed } · sendBackCount · cancelCount
//   a line is posted when an adjustment "<ref> [<line id>]: …" is at least as recent as its last counting: an approval
//   stopped half way resumes; after a send-back a recounted line posts only its new difference; a count with any
//   posting cannot be cancelled (count_partially_posted, re-checked in the batch); the approval stops if the count
//   leaves review meanwhile (count_not_in_review)
getCount(db, actor, countId, locale): CountView   // + postedLines (posted while not approved)
listCounts(db, actor, { status, location, page })   // differences: null while blind for this employee
differenceValue(difference, layers, standardCostIqd)
// transfers.server.ts (reads; changes are the core file above)
listTransfers(db, actor, filters) · getTransfer(db, actor, id, locale) · resolveTransferLines(db, text) · serialsAvailableAt(db, actor, locationId, variantIds) · transferableAt(…)
// reservations.server.ts — 04.08
listReservations(db, actor, filters, locale, now) · releaseReservationsOfOrder(db, actor, { orderId, reason }, now): { released }
// analytics.server.ts — 04.06 04.10 04.12, home
listReorder(db, actor, filters, locale, now) · listCostLayers(db, actor, filters, locale)   // cost.read · inventoryReport(db, actor, { report, days, page }, locale, now) · inventoryReportCsv(…) · inventoryOverview(db, actor, now)
// serials.server.ts
findSerials(db, actor, filters, locale) · getSerialHistory(db, actor, serialId, locale)   // movements? only with inventory.movement.read
```
Errors (texts: `admin-inventory` → `errors.*`): `location_in_use`, `location_too_deep`, `location_parent_invalid`, `location_code_invalid`, `code_taken`, `barcode_taken`, `cost_unknown`, `rejected_exceeds`, `reject_reason_required`, `unknown_code`, `count_location_busy`, `count_not_open`, `count_not_in_review`, `count_self_approval` (403), `count_nothing_counted`, `count_empty`, `count_stock_changed`, `count_oversell_needs_authorization`, `count_unknown_skus`, `count_partially_posted`, `release_not_allowed`, `transfer_unknown_codes`, field key `reason_reserved`, plus the core's codes.

#### 05 orders

`services/admin/orders/` — authorization inside (`assertCan`); money, stock and status only through the commerce core (transitionOrder, verifyPayment, recordCodCollection, createRefund / approveRefund, assignSerialsStatements, `orders/edit.server.ts`); [P] fields absent without cost.read / profit.read; phones masked without customer.phone.read_full; proof images only with payment_proof.read. Details: `docs/areas/admin-orders.md`.

```ts
// types.ts (client-safe): statuses, tones, RISK_RULE_IDS + RISK_THRESHOLDS, parseListFilters / listSearch (URL state), SAVED_VIEWS, view-model types
// list.server.ts
listOrders(db, actor, filters, locale, now): OrderListPage            // orders.order.read; 25 a page, flags per row
orderCounts(db, actor, now): { proofs; refunds; review; toPack; mine; late }   // each null for an employee who cannot act on it
listWhere(filters, actor, now)                                         // shared with the CSV export
// detail.server.ts
getOrderDetail(db, actor, ref, locale, now, urls): OrderDetail         // 05.02, with transitions + their impact, `can` flags, editBlockers
// actions.server.ts — wrappers over the core with the module's rules (hold, scan-verified shipping, held notifications)
changeOrderStatus(db, actor, orderId, { to, from?, reason?, trackingNo?, carrierId? }, now): { status; replayed }
verifyProof(db, actor, paymentId, { approve, receivedAmountIqd?, note? }, now, scope?: { orderId }) · collectCod(db, actor, orderId, { amountIqd, reason? }, now)
requestRefund(db, actor, { orderId, paymentId, amountIqd, method, reason, reference?, idempotencyKey }, now) · decideRefund(db, actor, refundId, { approve, note?, reference? }, now, scope?: { orderId })
// scope: an order page acts only on its own payments / refunds (another order's id → not_found)
addNote(db, actor, orderId, { text }, now) · setPreorder(db, actor, orderId, { isPreorder, expectedDay?, reason, notify? }, now)
// fulfillment.server.ts — 05.03 / 04.11 / 05.04 / 05.08
listFulfillment(db, actor, locale) · assignOrder(db, actor, orderId, { employeeId | null }, now) · getPackView(db, actor, ref, locale, proofUrl)
packProgress(db, orderId, locale?) · scanCode(db, actor, orderId, { code, scanId }, now): ScanOutcome · manualVerify(db, actor, orderId, { orderItemId, reason, scanId }, now)
splitParcel(db, actor, orderId, { lines: { orderItemId, qty }[] }, now) · markPacked(db, actor, orderId, now)
recordDeliveryProof(db, actor, orderId, { fileId, receivedByName }, now) · deliveryProofFile(db, actor, fileId)
parcelsShippedStatements / parcelsDeliveredStatements / closeTasksStatement (batch statements for the status wrappers)
// queues.server.ts — the shell's two queues
listProofQueue(db, actor) · getProofReview(db, actor, paymentId, imageUrl) · proofFileOf(db, actor, proofId) · listRefundQueue(db, actor)
// risk.server.ts — 05.09
riskConditions(now) · anyRule(now, ids) · riskFlagsOf(db, orderIds, now) · listReviewQueue(db, actor, now) · decideReview(db, actor, orderId, { decision: "clear"|"hold"|"flag", reason }, now)
// documents.server.ts — 05.06
issueInvoices(db, actor, orderIds, now): { issued; skipped } · printDocuments(db, actor, { kind: "invoice"|"packing"|"label", orderIds }, locale) · orderIdsForRefs(db, refs)
// labels: payment "collect" | "prepaid" (paid in full only) | "unpaid"; labels and slips carry shippable (confirmed, preparing, shipped)
// preorders.server.ts, export.server.ts, notify.server.ts
listPreorders(db, actor, locale, now) · exportOrdersCsv(db, actor, filters, headers, locale, now): { csv; rows } · notifyOrderContact(db, order, template, payload, dedupeKey, now)
```
Errors (texts: `admin-orders` → `errors.*`): `order_on_hold` (also a "flag" on a held order: only a reviewer's clear lifts a hold), `packing_incomplete`, `pack_not_open`, `assign_not_open`, `assignee_not_packer`, `review_not_open`, `preorder_not_open`, `proof_not_shipped`, `parcel_packed`, `split_qty_exceeds`, `scan_serial_instead`, plus the core's codes and the `edit_*` codes of `orders/edit.server.ts`.
