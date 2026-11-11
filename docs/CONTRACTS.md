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

### `returns/receive.server.ts`  (added by admin 12 returns on 2026-11-11 — a commerce-core file with its own tests, `tests/admin-returns-receive.test.ts`)
```ts
returnGoodsStatements(db, { orderId, lines: { orderItemId, qty, serialIds? }[], to: { kind: "restock", locationId? } | { kind: "quarantine", locationId } | { kind: "scrap" }, actor, now, key, refType, refId, reason }): Promise<{ statements; units; uncostedUnits; restockedCostIqd [P]; scrappedCostIqd [P] }>
exitQuarantine(db, actor, raw: { variantId, fromLocationId, qty, serialIds?, to: { kind: "stock", locationId } | { kind: "scrap" } | { kind: "supplier", reference }, refType, refId, reason, key }, now, extra?: (plan) => BatchStatement[]): Promise<{ units; uncostedUnits }>
quarantineExitStatements(db, actor, raw, now)   // the plan exitQuarantine runs (re-planned up to 3× on COST_LAYER_CHANGED / STOCK_CHANGED)
linkRefundStatements(db, { refundId, returnId, orderId }): BatchStatement[]   // refunds.return_id of an unlinked refund of the same order; moves no money
translateReturnGoodsError(error)
```
Goods of a DELIVERED order coming back through a return (`return_not_delivered` otherwise), built on `planReturnedGoods` (never more back than left — guarded in the batch; cost slices of the order's own 'sale' movements; `order_item_serials.released_at` set, so the unit can be sold again): **restock** into a sellable active location (default: where it left from); **quarantine** into a NON-sellable active location (`location_not_quarantine` otherwise) — on hand there, a 'return' cost layer, serial-tracked units (and a used device's serial) `returned` so they are never available nor packable; **scrap** — 'return' + 'damage', serials scrapped. Books: `postReturnedGoods` once per `key` (`<key>:goods`). `returnGoodsStatements` needs `returns.rma.inspect`; it builds, the caller adds its guarded record update and audit to the same batch. Leaving quarantine: on_hand −= qty at the quarantine location (guarded ≥ reserved), its FIFO layers consumed (guarded); **stock** (`returns.rma.inspect`): 'transfer_out' / 'transfer_in' pairs, a twin layer per costed slice at a sellable location, serials `returned` → `in_stock` there; **scrap** (`returns.rma.inspect` + `inventory.stock.adjust`): 'damage', serials scrapped, Dr inventory adjustments / Cr inventory; **supplier** (`returns.supplier_return.manage`): 'adjust' with the supplier reference, serials `in_repair` with no location, Dr accounts payable / Cr inventory; postings keyed `<key>:exit`; unknown costs stay unknown. The caller's `extra` statements run AFTER the exit's in the same batch (a guard there sees the exit's movements). Errors: `forbidden`, `not_found`, `invalid` (fields `locationId` = `location_invalid` | `location_not_quarantine`, `items` = `serials_required` | `serial_not_on_line`, `serialIds` = `serials_required` | `serials_count` | `serial_not_in_quarantine` | `serials_not_tracked`), `return_not_delivered`, `return_exceeds_shipped`, `insufficient_stock`, `serial_not_in_quarantine`, `period_closed`, `already_posted`.

### `orders/shipments.server.ts`  (added by admin 11 shipping on 2026-11-11 — a commerce-core file with its own tests, `tests/admin-shipping-core.test.ts`; flows in `tests/admin-shipping.test.ts`; races and the two-person rule in `tests/admin-shipping-review.test.ts`)
```ts
deliverParcel(db, actor, raw: { shipmentId, receivedByName?, proofFileId?, note?, from? }, now): Promise<{ orderDelivered; replayed }>   // shipping.shipment.update (+ orders.fulfillment.deliver for the last parcel)
returnParcels(db, actor, raw: { orderId, reason, goods?: { orderItemId, qty, disposition: "restock"|"scrap", serialIds? }[], locationId? }, now): Promise<{ parcels; replayed }>   // shipping.attempt.manage
syncParcels(db, actor, orderId, now): Promise<{ moved }> · syncParcelsStatements(db, actor, order, now): BatchStatement[] · parcelsOutOfStep(db, order): Promise<number>
submitCodSettlement(db, actor, raw: { settlementId, receivedIqd /* < 0: the store paid the carrier */, note? }, now): Promise<{ varianceIqd; replayed }>   // shipping.cod.settle
reconcileCodSettlement(db, actor, raw: { settlementId, receivedInto: "cash"|"bank_clearing", reason?, reference? }, now): Promise<{ journalEntryId; codRecorded; replayed }>
postCodSettlement(db, { settlementId, ref, carrier, expectedIqd, feesIqd, receivedIqd, receivedInto, reference?, at, createdBy, isDemo }): BatchStatement[]   // key "cod_settlement:<id>"
settlementSubmitter(db, settlementId) · parcelEventId · codSettlementPostingKey · SHIPMENT_ERROR_KEYS
settlementPreparers(db, settlementId): Promise<{ submitter; correctors; corrected }> · settlementNeedsSecondPerson(settlement, preparers, actorId): { needsSecond; involved } · SETTLEMENT_CORRECTION_ACTION   // "shipping.cod.item"
```
Review 2026-11-11 (each with a test): `returnParcels` first moves the parcels on the road to `returning` in a guarded batch (no parcel of the order delivered — `parcel_partly_delivered`), then moves the order, so a delivery racing a return never leaves goods restocked that the customer has; `deliverParcel`'s batch requires the order still `shipped`/`delivered` (`order_not_shipped`); the two-person rule covers HAND CORRECTIONS too — a variance OR any `SETTLEMENT_CORRECTION_ACTION` audit event (a parcel's cash or charge changed by hand) makes the reconciliation a decision of somebody who neither created, corrected nor submitted it, with a reason (one person could otherwise book a courier's shortfall as a higher carrier charge, make the variance 0 and reconcile alone).
`transitionOrder` never touches `shipments`; this file keeps parcels in step: the ORDER moves first (through `transitionOrder`: its permissions, guards, stock, warranties and postings), then the parcels follow in a guarded, idempotent batch whose one-per-parcel events have deterministic ids shared with the orders module (`sev_<id>_handover`, `_delivered`, `_returned`, `_cancelled`, `_cod_settled`). `deliverParcel`: one parcel delivered (`delivery_attempts` row "delivered", private `delivery_proof` file of that order, receiver's name); the LAST live parcel moves the order shipped → delivered first; two parcels delivered at once deliver the order once; an order on hold (`review_status` blocked, module 05's rule) is refused (`order_on_hold`). `returnParcels`: shipped → returned with the goods per line, then every in-flight parcel `returned`; refused when a parcel was delivered (`parcel_partly_delivered`: no partial return of a shipped order). `syncParcels`: shipped → pending/packed handed over; delivered → in-flight delivered; cancelled → pending/packed cancelled; returned undelivered → in-flight returned. Settlements (built as drafts by the shipping module): submit fixes the remittance and the totals (`variance = received − (expected − fees)`, a non-zero variance needs a note); reconcile — two people when the variance ≠ 0 or a parcel was corrected by hand (never the creator, a corrector or the submitter: `settlement_self_reconcile`, 403; a reason required) — records each parcel's cash still pending through `recordCodCollection` (its rules — `orders.payment.record`, a different amount `orders.payment.override` + reason — checked for every parcel before the first is recorded; a stopped run resumes, the core replays what was recorded), then ONE batch: settlement reconciled (guarded on status and totals), parcels `cod_settled_at` and `cost_iqd` = the carrier's actual charge, events, the posting (Dr cash / bank clearing received — Cr when negative; Dr shipping costs fees; Dr/Cr cash over/short −variance; Cr cash expected) and an audit event; demo and real orders never mix (`settlement_mixed_demo`). Courier-held cash sits in `cash` from `recordCodCollection` until the settlement moves it (the chart has no "cash held by couriers" account). Errors: `SHIPMENT_ERROR_KEYS` (shipment_changed, shipment_not_deliverable, order_not_shipped, order_on_hold, parcel_partly_delivered, proof_file_invalid, settlement_not_draft, settlement_not_submitted, settlement_empty, settlement_changed, settlement_self_reconcile, settlement_mixed_demo, settlement_item_invalid, settlement_amount_mismatch, variance_note_required) plus `transitionOrder`'s and `recordCodCollection`'s codes and `period_closed` / `already_posted` (texts: `admin-shipping` → `errors.*`).

### `accounting/post.server.ts`
```ts
journalStatements(db, { at, memo, refType, refId, createdBy, lines: { accountCode /* system key */, debitIqd?, creditIqd?, costCenter? }[] }): BatchStatement[]   // balanced or it throws before touching the DB; closed periods rejected
standard postings: postPaymentReceived, postCodCollected, postTransferVerified, postWalletPayment, postSale, postCogs, postRefund, postReturnedGoods, postWalletTopup, postWalletCredit, postStockReceipt
receivingAccount(method): SystemAccountKey; posting keys: paymentPostingKey, salePostingKey, cogsPostingKey, refundPostingKey, returnedGoodsPostingKey, walletCreditPostingKey
```
Profit follows `docs/metrics.md` (written by the core team): net revenue − COGS (landed) − commissions − shipping subsidy. Carrier costs (the shipping subsidy) and conversion rate are not measurable yet: the shipping module must post carrier costs to `shipping_costs`.

### `accounting/reports.server.ts`  (added by admin 10 finance on 2026-11-11 — a commerce-core file with its own tests, `tests/admin-finance-core.test.ts`)
```ts
chartOfAccounts(db): ChartAccount[] · isDebitNormal(type, isContra) · naturalBalance(account, sums) · systemRoots(chart) · familyIds(chart, systemKey)
accountSums(db, scope: { from?, to? /* exclusive */, includeDemo? }): Map<accountId, { debit; credit }>
trialBalance(db, actor, { to?, includeDemo? }): { rows; totalDebit; totalCredit; balanced; entries }   // cost.read
revenueRecognised(db, scope): RevenueSection   // gross, shipping income, discounts, refunds, net, other income, orders recognised — no cost involved
profitAndLoss(db, actor, scope): ProfitAndLoss   // cost: null without cost.read · profit (+ margins in bps): null without cost.read AND profit.read
cashFlow(db, actor, scope): CashFlow   // cost.read; opening/closing of the cash and bank family, in/out by CASH_FLOW_CATEGORIES
inventoryAsset(db, actor): InventoryAsset   // cost.read; inventory account vs FIFO layers + used devices + shipped-not-delivered + in transit, the rest "unexplained"
lastClosedPeriod(db): "YYYY-MM" | null · isLockedPeriod(db, period): boolean · openPeriodGuard(db, period): BatchStatement   // closed months (review 2026-11-11)
```
Closed months: a closed month is final for every month before it too — a posting dated on or before the last closed month is refused (`isLockedPeriod` before the batch, `openPeriodGuard` inside it → TT:PERIOD_CLOSED → `period_closed` through `mapPostingError`); the database trigger refuses only the closed month's own dates. Manual entries and expenses use both; a flow that posts dated `now` needs neither.
The one implementation of docs/metrics.md §3–§5 for finance (10), dashboards (01) and reports (18): the caller checks its screen's permission, the field permissions are applied here (an absent figure is `null`, never 0). Only lines whose entry header exists count; demo postings are left out unless `includeDemo`; an accountant's sub-account rolls up to its nearest system parent (`systemRoots`). Cash flow classifies by the entry's `ref_type` (payment, refund, wallet, POS shift, manual) and otherwise by the counter-account's system root (payroll, marketing, shipping costs, commissions, inventory / payables → suppliers, cash-on-delivery receivable → customers, wallet liability → top-ups, operating expenses).

### `accounting/expenses.server.ts`  (added by admin 10 finance on 2026-11-11 — a commerce-core file with its own tests, `tests/admin-finance-core.test.ts`)
```ts
createExpense(db, actor, { accountId, paidFromAccountId, costCenter?, amountIqd, vendor?, description, incurredOn: "YYYY-MM-DD", receiptFileId?, refType?, refId?, idempotencyKey }, now, { demo? }): { expenseId; replayed }   // a draft, not in the books
approveExpense(db, actor, { expenseId, note? }, now): { status: "posted"; entryId; replayed }   // one entry, key "expense:<id>:posted"
voidExpense(db, actor, { expenseId, reason }, now): { status: "void"; reversalId | null; replayed }   // posted → reversing entry dated now, key "expense:<id>:void"
expenseAccounts(chart) · paidFromAccounts(chart) · expenseIdFor(key) · expenseInstant(day) · EXPENSE_SECOND_APPROVAL_ABOVE_IQD (500,000) · MAX_EXPENSE_IQD · EXPENSE_ERROR_KEYS · CreateExpenseInput
selfApprovedRecentIqd(db, employeeId, now): number · needsOtherApprover(expense, approverId, recentSelfIqd): boolean · SELF_APPROVAL_WINDOW_MS (24 h)
```
`finance.expense.manage` for every call, checked before the input is read. Approving posts Dr the expense account (cost centre on the line) / Cr where the money came from (cash, bank clearing, accounts payable, owner's equity or a sub-account of those) in the same batch as the guarded draft → posted update, dated noon (Baghdad) of the day incurred — a closed month, or a month before the last closed one, refuses it (`period_closed`, also at creation). Above the limit the recorder cannot approve (`expense_self_approval`, 403); what one employee records AND approves alone counts together over 24 hours against the limit (no splitting), held inside the posting batch too. The cost of goods, stock write-offs, cash over/short, the wallet, customer control and inventory accounts are never expense or payment accounts here. Errors: `expense_not_draft`, `expense_not_posted`, `expense_self_approval`, `expense_account_invalid`, `expense_paid_from_invalid`, `cost_center_invalid`, `expense_date_future`, `period_closed`, `idempotency_mismatch` (texts: `admin-finance` → `errors.*`).

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
publishDueProducts(db, now) → { published; returnedToDraft; conflicts }   // job PUBLISH_DUE_JOB = "catalog.publish_due" (*/5, in jobs.server.ts SCHEDULES since 2026-11-11)
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

#### 09 purchasing

`services/admin/purchasing/` — authorization inside (`assertCan`; branch-limited employees act on their branch's locations); stock moves only through the commerce core (`receiveStock` with `ref { type: "receipt_item", id }` and the landed unit cost, `adjustStock` for returns to the supplier), the books through `postStockReceipt` (Dr inventory / Cr accounts payable, key `receipt:<id>:receipt`), landed costs through pricing's `addLandedCost` / `allocateLandedCost` / `removeLandedCost` on draft receipts. [P] prices, totals, rates, landed costs and claim amounts absent without cost.read (views, lists, print document, alerts). Details: `docs/areas/admin-purchasing.md`.

```ts
// rules.ts (pure, client-safe)
toIqd(minor, currency, rateMicros) · poTotals(lines, shippingMinor, otherMinor) · poTotalsOrNull(…)   // null when too big to be exact (a field error, never a 500)
needsApproval(totalIqd, limit = PO_SPENDING_LIMIT_IQD /* 1,000,000 */, windowIqd = 0) · SPLIT_WINDOW_DAYS (7)
threeWayMatch(poLines, invoiceLines, invoicedElsewhere, charges?): MatchDiscrepancy[]   // field "qty" | "unit_cost" | "charges" (shipping + other above the order's)
rateSupplier(facts): SupplierRating   // due units include unitsShortClosed · receiptStateOf(receipt) · isLate(order, now)
CLAIM_TRANSITIONS · parseCount (Arabic-Indic / Persian digits) · list filters (PO_VIEWS, RECEIPT_FILTERS, INVOICE_FILTERS, CLAIM_FILTERS, RFQ_FILTERS, ALERT_KINDS)
// suppliers.server.ts — 09.01 · rating.server.ts — 09.08
listSuppliers(db, actor, parseSupplierFilters(params), now) · getSupplier(db, actor, supplierId, now) · supplierOptions(db, actor, { includeInactive? })
createSupplier(db, actor, raw, now, { demo? }) · updateSupplier(db, actor, { supplierId, version, …fields }, now) · setSupplierStatus(db, actor, { supplierId, status, reason }, now)
saveContact / removeContact(db, actor, raw, now) · reviewSupplier(db, actor, { supplierId, score 1–5, note }, now)   // supplier.rate; kept in the audit trail
supplierRatings(db, supplierIds, now): Map<id, SupplierRating> · ratingFactsFor(db, supplierIds, now)
// rfqs.server.ts — 09.02
createRfq(db, actor, { title, neededBy?, notes?, lines: { code, qty }[], idempotencyKey }, now, locale) · markRfqSent · cancelRfq(…, { rfqId, reason })
recordQuote(db, actor, { rfqId, supplierId, currency, leadTimeDays?, warrantyMonths?, validUntil?, notes?, lines: { rfqItemId, unitCost?, qtyAvailable? }[] }, now)   // replaces the supplier's quote
awardQuote(db, actor, { rfqId, quoteId, locationId, fxRate?, expectedOn?, idempotencyKey }, now): { poId; replayed }   // draft PO; other quotes declined
listRfqs(db, actor, parseRfqFilters(params)) · getRfq(db, actor, rfqId, locale, now)   // quotes compared (IQD, coverage, lead, warranty, best flags)
// orders.server.ts — 09.03
savePurchaseOrder(db, actor, { poId?, version?, supplierId, locationId, currency, fxRate?, expectedOn?, paymentTerms?, notes?, shipping?, other?, lines: { code, qty, unitCost }[], idempotencyKey? }, now, locale, { demo? }): { poId; ref; replayed }
submitPurchaseOrder(db, actor, { poId, version, note? }, now): { status: "approved" | "pending_approval"; replayed }   // approvals row (kind "purchase_order") above the limit:
//   the order weighs its total at the higher of its rate and the store's rate of the day, plus what the same person approved alone for the supplier in SPLIT_WINDOW_DAYS
decidePurchaseOrder(db, actor, { poId, decision: "approve" | "reject", note?, approvalId? }, now)   // po.approve + cost.read; not whoever created, edited or submitted it
//   (approver_is_requester); `approvalId` = the request the page showed (a newer one → po_changed); approve refuses a supplier no longer active
limitWindow(db, supplierId, approvedBy, now, exceptPoId): { count; iqd }
markOrderSent · markOrdersSent(db, actor, { poIds }, now): { sent; skipped } · cancelPurchaseOrder(…, { poId, reason })   // no live receipt, no live invoice (po_has_invoices)
closePurchaseOrder(…, { poId, reason? })
listPurchaseOrders(db, actor, parsePoFilters(params), now) · getPurchaseOrder(db, actor, poId, locale, now) · purchaseOrderDocument(…) · openOrderOptions(db, actor)
planOrder / insertOrderStatements   // shared by save and the RFQ award
// receipts.server.ts — 09.04
receiveFormFor(db, actor, poId, locale) · createReceipt(db, actor, { poId, supplierDocNo?, receivedOn?, notes?, lines: { poItemId, received, rejected?, rejectReason?, serials? }[], idempotencyKey }, now)   // DRAFT; the batch re-checks what is outstanding
postReceipt(db, actor, { receiptId }, now): { units; resumed; replayed }   // claim → lines read again → receiveStock per line → finish (lease "posting:<token>", resumable after 5 min)
cancelReceipt(…, { receiptId, reason }) · listReceipts(db, actor, parseReceiptFilters(params)) · getReceipt(db, actor, receiptId, locale, now)
// invoices.server.ts — 09.04 09.07
recordInvoice(db, actor, { poId, invoiceNo, issuedOn?, dueOn?, fxRate?, shipping?, other?, lines: { poItemId, qty, unitCost }[], idempotencyKey }, now): { invoiceId; status; discrepancies; replayed }
approveInvoice(db, actor, { invoiceId, reason? }, now)   // variances: reason + not the recorder · rematchInvoice · voidInvoice(…, { invoiceId, reason })   // all branch-limited
//   an invoice of charges alone (freight billed apart) is allowed; charges above the order's shipping + other are a "charges" variance
rematchStatements(db, poId, addedQtyByPoItem)   // in the receipt-posting batch · listInvoices · getInvoice · invoiceFormFor
// claims.server.ts — 09.06
createClaim(db, actor, { supplierId? | poId? | receiptId?, kind, description?, lines: { code, qty, serial? }[], amount?, idempotencyKey }, now, locale) · claimPrefill(db, actor, { receiptId? | poId? }, locale)
moveClaim(db, actor, { claimId, to, note?, creditAmount?, creditReference? }, now) · returnClaimGoods(db, actor, { claimId, locationId, reason }, now, locale): { returned; fromStock; replayed }   // + inventory.stock.adjust
//   units refused at inspection (a receipt's claim carries them first) go back without a stock movement; from stock at most what the receipt / order put in (return_exceeds_received)
listClaims · getClaim
// alerts.server.ts — 09.07, home
listAlerts(db, actor, parseAlertFilters(params), locale, now) · purchasingOverview(db, actor, now)
```
Errors (texts: `admin-purchasing` → `errors.*`): `code_taken`, `supplier_changed`, `supplier_not_active`, `po_changed`, `po_not_draft`, `po_not_pending`, `po_not_open`, `po_has_receipts`, `po_has_invoices`, `receipts_open`, `return_exceeds_received`, `approver_is_requester` (403), `over_receipt`, `nothing_to_receive`, `receipt_not_draft`, `receipt_has_bills`, `landed_unallocated`, `posting_in_progress`, `receipt_cancelled`, `cost_unknown`, `invoice_no_taken`, `invoice_not_open`, `invoice_changed`, `variance_reason_required`, `claim_transition`, `claim_not_open`, `return_in_progress`, `nothing_to_return`, `serial_unknown`, `claim_not_returnable`, `rfq_closed`, `quote_expired`, `quote_not_received`, `quote_empty`, field keys such as `unknown_code`, `duplicate_line`, `bundle_not_purchasable`, `expected_past`, `fx_rate_required`, `reject_reason_required`, plus the core's codes (`serial_duplicate`, `serial_tracked`, `insufficient_stock`, `period_closed`).

#### 10 finance

`services/admin/finance/` — authorization inside (`assertCan`); money only through the core: `journalStatements` (manual entries and their reversal), `creditWallet` (top-ups key `topup:<id>`, adjustments key `adjustment:<approvalId>`), `accounting/expenses.server.ts` (§1); statements from `accounting/reports.server.ts` (§1). The module writes non-system accounts, cost centres, statement imports and lines, tax rates, `fiscal_periods`, `approvals` (kinds `wallet_topup`, `wallet_adjustment`) and top-up decisions, each with an audit event (`finance.*`). The books (journal, accounts, trial balance, cash flow, inventory) need `finance.journal.read` or `finance.report.read` AND cost.read; profit lines cost.read + profit.read; absent, never 0, in loader data, CSV and print. Details: `docs/areas/admin-finance.md`.

```ts
// types.ts (client-safe) — parseAmount (Arabic-Indic / Persian digits, integer IQD) · parsePercentBps · parseRange(params, now): RangeFilter (month or two Baghdad days ≤ 400, demo flag) · rangeSearch · periodOf · periodRange · shiftPeriod · REF_TYPES · MAX_MANUAL_LINES (20)
// statement-csv.ts (pure) — parseStatementCsv(text): { rows, columns, problem } (Arabic or English headers, ≤ 2,000 rows / 1 MB) · normalizeReference
// shared.server.ts — FINANCE_PERMISSIONS · financeAccess(actor): FinanceAccess · assertBooks(actor) · refLinks(db, refs) · closedPeriods(db) · customerLabels · employeeNames
// ledger.server.ts — 10.01
listJournal(db, actor, { …range, account?, refType?, q?, page }, locale) · getEntry(db, actor, entryId, locale) · exportJournalLines(…): { lines; truncated }   // audited, ≤ 10,000 lines
postManualEntry(db, actor, { date, memo, reason, lines: { accountId, debitIqd?, creditIqd?, costCenter?, memo? }[], idempotencyKey }, now, { demo? }): { entryId; replayed }   // finance.journal.post; never dated on/before the last closed month; a key reused with other lines → idempotency_mismatch
reverseEntry(db, actor, { entryId, reason }, now): { reversalId; replayed }   // manual entries only, once, dated now
listAccounts(db, actor, range, locale) · saveAccount(db, actor, { id?, code, nameAr, nameEn?, type?, parentId? /* undefined keeps, null removes */, description?, isActive, reason }, now)   // finance.account.manage; system accounts keep code/type; an account holding postings keeps its family (account_family_locked)
accountLedger(db, actor, accountId, range, page, locale) · manualEntryOptions(db, actor, locale)
// settlements.server.ts — 10.02 (finance.settlement.reconcile)
settlementOverview(db, actor, range) · listStatementLines(db, actor, filters) · unreconciledPayments(db, actor, range)
previewStatement / importStatement(db, actor, { source: "bank_card"|"zaincash"|"carrier", csv }, now): { importId; inserted; skipped; errors }
reviewStatementLine(db, actor, lineId, search) · matchStatementLine(db, actor, { lineId, paymentId, note? }, now) · unmatch / ignore / restoreStatementLine(db, actor, { lineId, reason }, now) · matchExactLines(db, actor, range, now) · countUnmatched
// revenue.server.ts — 10.03 10.04 (finance.report.read) — realisedVsPending(db, actor, range) · salesDeductions(db, actor, range)   // [P] COGS, margin
// expense-views.server.ts — 10.05 — listExpenses(…, locale, now?) · getExpense(db, actor, id, locale, now?) · expenseFormOptions · expenseReceiptFile · listCostCenters · saveCostCenter · countDecidableExpenses(db, actor, now?)   // needsOther counts the viewer's own 24-hour self-approvals
// wallets.server.ts — 10.07 (finance.wallet.read; decisions customers.wallet.adjust; proof payment_proof.read)
walletOverview(db, actor, range) · listWalletLedger · customerWallet(db, actor, customerId, page) · listTopups · getTopupReview(db, actor, id, proofUrl, now?) (+ soloApprovedIqd, soloRoomIqd) · topupProofFile
decideTopup(db, actor, { topupId, decision: "approve"|"reject"|"return", amountIqd?, note? }, now): { status: "approved"|"rejected"|"awaiting_second"|"pending"; replayed; entryId? }   // two people above TOPUP_SECOND_APPROVAL_ABOVE_IQD (500,000), counting what the same person approved alone for the customer in 24 h
requestWalletAdjustment(db, actor, { customerId, amountIqd, reason, idempotencyKey }, now) · decideWalletAdjustment(db, actor, { approvalId, decision, note? }, now)   // never the requester
listAdjustments · walletQueue(db, actor): { topups; adjustments } | null
// tax.server.ts — 10.08 (finance.tax.manage) — listTaxRates · saveTaxRate(db, actor, { id?, code, nameAr, nameEn?, rateBps, productKinds, channels, isActive, effectiveFrom?, reason, expectedUpdatedAt? }, now) · taxIncluded(amount, rateBps) · taxReport(db, actor, range, locale)
// close.server.ts — 10.09 — listPeriods · closeChecklist(db, actor, period, now) · closePeriod(db, actor, { period, reason }, now)   // finance.period.close
// anomalies.server.ts — 10.10 (finance.anomaly.read) — financeAnomalies(db, actor, now) · countCritical
// overview.server.ts — financeOverview(db, actor, now)   // home cards and this month's figures, per permission
```
Errors (texts: `admin-finance` → `errors.*`): `LEDGER_ERROR_KEYS` (journal_unbalanced, journal_line_invalid, journal_wallet_manual, journal_account_inactive, journal_date_future, reverse_not_manual, reverse_reversal, already_reversed, account_code_taken, account_parent_invalid, account_system_locked, account_has_balance, account_has_children, account_family_locked), `SETTLEMENT_ERROR_KEYS` (statement_*, line_not_unmatched, line_not_matched, line_not_ignored, payment_already_matched, payment_not_paid, payment_method_mismatch, …), `WALLET_ADMIN_ERROR_KEYS` (topup_not_pending, topup_second_person, topup_amount_changed, topup_amount_note_required, topup_reject_reason_required, topup_nothing_to_return, adjustment_self_approval, adjustment_not_pending, customer_unavailable, wallet_insufficient), `TAX_ERROR_KEYS`, `CLOSE_ERROR_KEYS` (period_not_over, period_earlier_open, period_unbalanced, period_already_closed, period_close_blocked), the expense core's, plus `period_closed`, `idempotency_mismatch`.

#### 11 shipping

`services/admin/shipping/` — authorization inside (`assertCan`); order moves only through the orders module's `changeOrderStatus` (pickup → shipped) and the core file `orders/shipments.server.ts` (delivered, returned, settlements, §1); money only through `recordCodCollection` and `postCodSettlement`; the module itself writes carriers, carrier rates, override rows, governorate/district fields (estimates, availability, names), the waybill columns of `shipments`, delivery attempts, settlement drafts. Carrier rates and charges are cost data: sent only to who chooses carriers, manages or settles with them, or has cost.read (`canSeeCarrierCost` in `shared.server.ts`; absent — not null — for support / stock roles, in page data, JSON and parcel history); the delivery margin only with profit.read; phones masked without customer.phone.read_full; serials only with inventory.serial.read. Details: `docs/areas/admin-shipping.md`.

```ts
// rules.ts (client-safe): SHIPMENT_STATUS_LIST, SHIPMENT_TONE, ON_ROAD / IN_FLIGHT / DELIVERABLE / AT_STORE / FINAL, SIMPLE_MOVES, FAILURE_OUTCOMES, SERVICE_LEVELS,
//   parcelCode(ref, n) → "REF-n" · parseParcelCode · codFeeFor(collected, carrier) · settlementTotals(items, received) · effectiveFee(policy, override) · feeChanges(zones, before, after, override?)
//   parseShipmentFilters / shipmentSearch (URL state), SHIPMENT_VIEWS, view-model types (ShipmentListRow, ShipmentDetail, CodView, SettlementView…)
// zones.server.ts — 11.01
listZones(db, actor, locale) · getZone(db, actor, governorateId, locale) · feePolicy(db)
setFlatFee(db, actor, { feeIqd, expectedFeeIqd, reason }, now) · setOverridesEnabled(db, actor, { enabled, expected, reason }, now)   // settings.shipping.manage, via setSetting
setOverrideFee(db, actor, { governorateId | null, feeIqd | null, expectedIqd, reason }, now): { changes; applies; replayed }        // shipping.rate.manage
setGovernorateAvailability · setGovernorateEta · saveDistrict · setDistrictActive(db, actor, { governorateId?, districtId, isActive, reason }, now)   // shipping.zone.manage; a district of another governorate is not_found
// carriers.server.ts — 11.02
listCarriers · getCarrier · saveCarrier(db, actor, raw, now, { demo? }) · setCarrierActive · applyCarrierRate(db, actor, { carrierId, governorateIds, serviceLevel, costIqd | null, etaDaysMin?, etaDaysMax? }, now)
carrierOptions(db, { governorateId, serviceLevel?, codAmountIqd }): CarrierOption[]   // cheapest eligible first · carrierRate · carrierChoices · codOutstandingByCarrier
// shipments.server.ts — 11.03 11.05 11.06
listShipments(db, actor, filters, locale, now) · getShipment(db, actor, shipmentId, locale, now) · lookupParcel(db, actor, code) · shippingOverview(db, actor, now) · attemptsQueue(db, actor, locale)
saveWaybill(db, actor, { shipmentId, carrierId, serviceLevel, trackingNo?, costIqd?, reason?, from? }, now) · assignByRule(db, actor, { shipmentIds, serviceLevel }, now)
pickupParcels(db, actor, { shipmentIds }, now): { shipped; failed }   // + orders.fulfillment.ship · moveParcels(db, actor, { shipmentIds, to, note?, from? }, now)
recordAttempt(db, actor, { shipmentId, outcome, reason?, notes?, nextAttemptDay?, from? }, now) · deliverShipment(…) · receiveReturn(db, actor, { shipmentId, reason, lines? }, now)
addPackingPhoto(db, actor, { shipmentId, fileId, note? }, now) · addDeliveryProof(db, actor, { shipmentId, fileId, receivedByName }, now) · waybillDocs · manifestDocs   // manifest rows carry `shippable`; totals count only those
assertDeliverable(db, actor, { shipmentId, receivedByName?, from? }): "deliver" | "replay"   // deliverShipment's refusals, BEFORE a proof photo is stored
// cod.server.ts — 11.04 (drafts; submit / reconcile are the core's)
listSettlements · parseSettlementFilters · settlementBacklog · eligibleParcels(db, actor, carrierId, locale) · getSettlement(db, actor, settlementId, locale)   // view: corrected, secondPerson, items[].rateIqd
createSettlement(db, actor, { carrierId, shipmentIds, notes?, idempotencyKey }, now) · updateSettlementItem (cash ≠ due or charge ≠ suggestedCharge → reason) · removeSettlementItems · disputeSettlement · reopenSettlement · discardSettlement · attachStatement
suggestedCharge(parcelCostIqd, collectedIqd, carrier) · assertStatementOpen(db, actor, settlementId)   // before a statement photo is stored
// shared.server.ts
canSeeCarrierCost(actor) · eventDataFor(actor, data) · shippingAccess(actor)   // carrierCost, read, waybill, update, attempts, proof, carriers, zones, rates, fee, cod, …
// files.server.ts
shippingFile(db, actor, fileId)   // packing_photo / delivery_proof: shipping.shipment.read · cod_statement: shipping.cod.settle
```
Errors (texts: `admin-shipping` → `errors.*`): the core file's `SHIPMENT_ERROR_KEYS`, plus `fee_changed`, `waybill_locked`, `carrier_no_cod`, `carrier_inactive`, `waybill_missing`, `packing_undocumented`, `shipment_not_at_store`, `shipment_not_on_road`, `proof_not_delivered`, `packing_after_pickup`, `parcel_not_eligible`, `parcel_already_settled`, field keys `tracking_taken`, `tracking_invalid`, `day_invalid`, `receiver_required`, `file_invalid`, `settlement_no_cash`, `settlement_amount_recorded`, `settlement_cash_missing`, `district_exists`, `code_taken`, `code_invalid`, `tracking_template_invalid`, `eta_both`, `eta_order`; and the orders module's `order_on_hold`, `packing_incomplete`.

#### 12 returns

`services/admin/returns/` — authorization inside (`assertCan`); goods only through `returns/receive.server.ts` (core, §1), money only through `createRefund` / `approveRefund`; no [P] column is selected for any view; phones masked without customer.phone.read_full (partial-digit search needs it). Every change is one guarded batch with its audit event. Details: `docs/areas/admin-returns.md`.

```ts
// types.ts (client-safe): statuses, reasons, resolutions, conditions, decisions, SLA, FRAUD_RULE_IDS + FRAUD_THRESHOLDS, URL filters (parseRmaFilters / rmaSearch, repairs, warranties), parseWhole, view-model types
// policy.server.ts — 12.02
evaluateOrder(db, order, at, locale, { sealed?, reasonCode?, exceptReturnId? }): EligibleLine[]   // returnable units, unit value, serials, verdict per line
pickRule(rules, facts) · verdict(input)   // pure: category (nearest parent first) › kind › catch-all, new/used, then sort
listPolicies(db, actor, locale) · savePolicy(db, actor, { id?, productKind, categoryId?, itemCondition, isReturnable, windowDays | null, requiresSealed, restockingFeeBps, note, sort, isActive, reason }, now)   // returns.policy.manage, audited before/after
// rma.server.ts — 12.01
returnsAccess(actor) · listReturns(db, actor, filters, locale, now) · queueCounts(db, actor, now)   // never one's own RMA to decide
findOrderForReturn(db, actor, orderRef, locale, now) · openReturn(db, actor, { orderRef, items: { orderItemId, qty, serialIds?, sealed? }[], reasonCode, reason, requestedResolution, phone?, override?, overrideReason?, idempotencyKey }, now, locale): { returnId; rma; replayed }
decideReturn(db, actor, returnId, { approve, note? }, now) · markInTransit · cancelReturn · closeReturn(db, actor, returnId, { resolution, note }, now) · addReturnNote
//   closeReturn: the resolution must have happened (refund paid · store credit/exchange: a paid wallet refund · repair: a finished repair · supplier return: a unit set aside)
//   markInTransit / addReturnNote / assertPhotoSlot: with returns.rma.create alone, only on RMAs the employee opened (else not_found)
assertPhotoSlot / recordReturnPhoto / returnPhotoFile · getReturnDetail(db, actor, rma, locale, now, urls): RmaDetail · dueOf(row)   // items[].refundable, items[].feeIqd
// inspect.server.ts — 12.03, 12.07
inspectItem(db, actor, { returnId, itemId, condition, decision: "restock"|"refurbish"|"return_to_supplier"|"scrap"|"keep", locationId?, serial?, notes? }, now): { replayed; status }   // branch-limited: their branch's locations, a named restock location
listQuarantine(db, actor, locale, now) · resolveQuarantine(db, actor, { itemId, to: "stock"|"scrap"|"supplier", locationId?, supplierId?, reason }, now): { claimRef; replayed }   // supplier → supplier_claims row, kind "return"; both locations in the actor's branch
// refund.server.ts — 12.04, 12.05
requestReturnRefund(db, actor, { returnId, paymentId, itemIds, amountIqd, method: "original"|"wallet"|"cash", reason, reference?, idempotencyKey }, now)   // key "rma:<return id>:<form key>"; units that came back (kept: after a failed repair); ≤ value − restocking fee; units guard inside createRefund's batch
restockingFee(unitValueIqd, qty, bps)   // floor, per RMA line
decideReturnRefund(db, actor, { returnId, refundId, approve, note?, reference? }, now)   // another return's refund → not_found
// fraud.server.ts — fraudSignals(db, rows): Map<returnId, { id, vars }[]>
// repair.server.ts — 12.07
listRepairs · getRepair · changeRepairStatus(db, actor, { ticketId, from, to, note? }, now) · setDiagnosis · recordQuoteDecision · addPart · assignRepair · setRepairSla · addRepairNote
openCounterRepair(db, actor, { phone, contactName?, deviceModelId? | deviceText, serial?, issue, idempotencyKey }, now, storeMode) · openReturnRepair(db, actor, { returnId, itemId, issue }, now) · technicians · deviceOptions · repairPhotoFile
// warranty.server.ts — 12.06
listWarranties · getWarranty · extendWarranty(db, actor, { warrantyId, endsOn: "YYYY-MM-DD", reason }, now) · voidWarranty(db, actor, { warrantyId, reason }, now) · endOfBaghdadDay(day)
```
Errors (texts: `admin-returns` → `errors.*`): `approver_is_requester` (403), `return_not_delivered`, `return_qty_exceeds`, `not_eligible`, `rma_changed`, `photo_limit`, `item_inspected`, `serial_mismatch`, `quarantine_resolved`, `no_suppliers`, `refund_exceeds_items`, `refund_exceeds_policy`, `refund_not_ready`, `repair_changed`, `transition_not_allowed`, `quote_not_approved`, `assignee_not_technician`, `warranty_void`, `warranty_changed`, field keys `items_required`, `used_unit_decision`, `override_reason_required`, `not_inspected`, `not_returned`, `items_not_inspected`, `refund_waiting`, `no_refund_issued`, `no_store_credit_issued`, `no_repair_done`, `no_supplier_unit`, `not_later`, plus the core's codes.
