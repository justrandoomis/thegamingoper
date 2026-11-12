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
expenseAccounts(chart) · paidFromAccounts(chart) · expenseIdFor(key) · expenseInstant(day) · MAX_EXPENSE_IQD · EXPENSE_ERROR_KEYS · CreateExpenseInput
expenseApprovalLimit(db): Promise<number>   // the limit in force: setting "finance.expense_second_approval_iqd" (admin 22); EXPENSE_SECOND_APPROVAL_ABOVE_IQD (500,000) is its default
selfApprovedRecentIqd(db, employeeId, now): number · SELF_APPROVAL_WINDOW_MS (24 h)
needsOtherApprover(expense, approverId, recentSelfIqd, limitIqd = EXPENSE_SECOND_APPROVAL_ABOVE_IQD): boolean   // pure: pass expenseApprovalLimit(db) — the screens and approveExpense do
```
`finance.expense.manage` for every call, checked before the input is read. Approving posts Dr the expense account (cost centre on the line) / Cr where the money came from (cash, bank clearing, accounts payable, owner's equity or a sub-account of those) in the same batch as the guarded draft → posted update, dated noon (Baghdad) of the day incurred — a closed month, or a month before the last closed one, refuses it (`period_closed`, also at creation). Above the limit the recorder cannot approve (`expense_self_approval`, 403); what one employee records AND approves alone counts together over 24 hours against the limit (no splitting), held inside the posting batch too. The cost of goods, stock write-offs, cash over/short, the wallet, customer control and inventory accounts are never expense or payment accounts here. Errors: `expense_not_draft`, `expense_not_posted`, `expense_self_approval`, `expense_account_invalid`, `expense_paid_from_invalid`, `cost_center_invalid`, `expense_date_future`, `period_closed`, `idempotency_mismatch` (texts: `admin-finance` → `errors.*`).

### `accounting/payroll.server.ts`  (added by admin 15 staff on 2026-11-11 — a commerce-core file with its own tests, `tests/admin-staff-payroll.test.ts`)
```ts
postPayrollRun(db, { entryId?, runId, ref, period, paidFrom: "cash"|"bank_clearing", totals: PayrollRunTotals, at, createdBy, isDemo }): BatchStatement[]   // key "payroll_run:<id>:paid", ref "payroll_run"; [] when every line is 0
postEmployeeAdvance(db, { entryId?, advanceId, amountIqd > 0, paidFrom, memo?, at, createdBy, isDemo }): BatchStatement[]                               // key "staff_advance:<id>:paid", ref "staff_advance"
payrollRunLines(totals, paidFrom): JournalLineSpec[]   // pure · PayrollRunTotals = { baseIqd, bonusIqd, commissionIqd (signed), advanceDeductionIqd, otherDeductionIqd, netIqd }
PAYROLL_PAID_FROM · payrollRunPostingKey(runId) · advancePostingKey(advanceId) · PayrollPostingError
```
Synchronous statement builders through `journalStatements` (balanced or they throw before the database; closed months refused by the database → `period_closed`, a second posting of the same key → `already_posted`, both through `mapPostingError`). A run: Dr payroll = base + bonus − advances deducted − other deductions (Cr when negative), Dr commissions = the run's net commissions (Cr when returns outweigh them), Cr cash or bank clearing = net pay; totals that do not add up (net ≠ base + commission + bonus − deductions, a negative or fractional figure) throw `PayrollPostingError`. An advance: Dr payroll / Cr cash or bank — pay handed out early, which the run that deducts it books back, so over both the payroll account carries base + bonus − other deductions. The chart has no salaries-payable nor advances-to-employees account (requested), so pay reaches the books when paid out; commissions land on [6200], which the profit definition subtracts (docs/metrics.md §4). Callers: admin 15 (`services/admin/staff/payroll.server.ts`), in the same batch as the run's guarded paid transition / the advance's insert.

### `orders/pos-sale.server.ts`  (added by admin 06 pos on 2026-11-11 — a commerce-core file with its own tests, `tests/admin-pos-core.test.ts`; flows in `tests/admin-pos.test.ts`; review cases in `tests/admin-pos-review.test.ts`)
```ts
placePosSale(db, actor, raw: PosSaleInput, now): Promise<PosSaleResult>   // pos.sale.create
type PosSaleInput = {
  idempotencyKey;                         // made on the device once per sale, 22–128 URL-safe chars (an offline sale keeps it)
  shiftId;                                // the drawer; its register gives the store location, branch and register
  customerId?; contact?: { phone; name? }; // an account (wallet allowed) or a phone kept as a guest contact
  lines: ({ variantId } | { usedUnitId })[] & { qty; unitPriceIqd; discountIqd?; serialIds? };   // prices are the CALLER's (the POS module)
  orderDiscountIqd?; payments: { method: "pos_cash"|"pos_card"|"wallet"; amountIqd; tenderedIqd? /* cash */; reference? /* card slip */ }[];
  notes?; offlineCreatedAt?; allowOversell? /* + inventory.oversell.authorize */; isDemo?; locale?; reason?; auditFacts?;
};
type PosSaleResult = { orderId; ref; receiptNumber /* "RC-000001" */; totalIqd; changeIqd; replayed; lateForClosedShift }
posSaleTotals(input) · posSaleKeyHash(key) · storeLocationTree(db, locationId): { locationIds; treeIds; locationSort } · POS_PAYMENT_METHODS · POS_RECEIPT_SEQUENCE · POS_SALE_ERROR_KEYS · type PosReceiptData
```
A sale at the counter in ONE batch: guest contact · order (channel `pos`, status `delivered`, payment `paid`, `register_id`, `pos_shift_id`, `cashier_id`, `branch_id`, `offline_created_at`; totals that satisfy the CHECKs and `orders.totals_vs_items`) · lines (snapshots, `cost_snapshot_iqd` [P], warranty months / used-device days) · stock **reserve → commit** at the register's location of kind `store` and the active sellable bins under it (a scanned serial's unit from the serial's own location when it is free there — review 2026-11-11 — the rest most free first): a `stock_reservations` row per slice inserted as `committed`, a `reserve` and FIFO `sale` movements (unit cost [P]), `on_hand −= qty` guarded on `on_hand − reserved ≥ qty` (units promised to web orders are never sold here → `insufficient_stock`; with `allowOversell`: guarded `on_hand ≥ qty`, the level marked `allow_oversell`), cost layers consumed (guarded, re-planned up to 3× on `COST_LAYER_CHANGED`) · serials checked in the store's tree, then `assignSerialsStatements` (sold once) · a used device `reserveUsedUnitStatements` → sold with its own serial · payments `paid`, recorded by the cashier (`verified_by`), the card's slip in `reference`, the wallet's ledger debit (`order:<id>:wallet`; the overdraft trigger aborts everything) · the drawer's `cash_movements` row kind `sale` (+ the cash applied, key `pos_sale:<order>:cash`) · warranties (one per serial, else per line) · the receipt (`invoices` kind `receipt`, counter `pos_receipt`, frozen `PosReceiptData`, no cost) · postings: `postPaymentReceived` / `postWalletPayment` per payment, `postSale`, `postCogs` (FIFO; unknown costs stay out and are counted in the audit) · order event `placed` · audit `pos.sale.create`. The shift: open → guarded `status = 'open'`; closed and not reviewed → only a sale queued offline (`offlineCreatedAt` set) lands there, and the same batch moves its `expected_cash_iqd` up and `variance_iqd` down by the cash (`lateForClosedShift`; an offline sale whose drawer was counted while it was recorded is re-planned as late); a sale rung up now on a counted drawer → `pos_shift_not_open` (review 2026-11-11); reviewed → `pos_shift_reviewed`. The shift must be the actor's own unless they hold `pos.shift.review`; a branch-limited employee sells at their branch's registers only. Idempotency: `orders.idempotency_key` = sha256("tamtam.pos.sale.v1|" + key); the same key returns the first sale (`replayed: true`, also for two at once); the same key with another total or shift → `idempotency_conflict`. Payments must add up exactly (cash may be over-tendered: `changeIqd`). Errors: `POS_SALE_ERROR_KEYS` — `pos_shift_not_open`, `pos_shift_reviewed`, `pos_register_inactive`, `pos_location_invalid`, `insufficient_stock`, `serial_not_available`, `serials_required`, `serials_count`, `used_unit_not_available`, `variant_inactive`, `payment_total_mismatch`, `payment_duplicate_method`, `cash_tendered_short`, `wallet_requires_account`, `wallet_insufficient`, `account_blocked`, `idempotency_conflict`, `period_closed`; plus `invalid` field keys (`discount_exceeds_price`, `used_unit_qty`, `serials_not_tracked`, `serials_duplicate`, `duplicate_line`, `phone_invalid`) (texts: `admin-pos` → `errors.*`).

### `app/server/jobs.server.ts` (scheduled jobs)
`runScheduledJobs(db, cron, now, env?)` is called by the Worker's `scheduled` handler (`workers/app.ts`, crons in `wrangler.jsonc`); `runJob(db, job, now, { origin, triggeredBy })` lets the operations module re-run a job (caller checks `ops.job.run`); `listJobRuns(db, job?, limit?)` for the ops screens (caller checks `ops.job.read`). Every run is a `job_runs` row. The daily `retention` job also runs the areas' purges (`purgeAreaData`): unused wallet top-up proofs and — since 2026-11-11 — `purgeExpiredAssistantSessions(db, now)`: stored assistant conversations past their `expires_at`, with their messages (the ticket keeps its note and loses the link; `consents` rows are append-only and stay). Since the integration pass of 2026-11-11 the daily run (`30 0 * * *`) also has four jobs of its own, one `job_runs` row each and a failure their own (`ok: false`, the others still run): `recommendations.events.purge` (`purgeRecommendationEvents`), `tradein.drafts.purge` (`purgeStaleTradeInDrafts` — skipped without `env.KV`), `devices.tradein_offers.expire` (`expireTradeInOffers`, 200 a run) and `customers.segments.recompute` (`recomputeSegments` as the system); `consistency.daily` runs last. `JOB_NAMES` lists them for the operations screens.

## 2. Catalogue read layer (owner: storefront shell team)
`catalog/cards.server.ts` — `getCardsByIds`, `listCards`, `getNewArrivals`, `getDeals`, `getUsedSpotlight`; `catalog/taxonomy.server.ts` — `getPlatforms`, `getCategoryTree`, `getNavTaxonomy`. See the files for exact types.

**Card facts (design v2, 2026-11-11; rules in `catalog/card-facts.ts`, client-safe).** Every `ProductCardData` from the read layer also carries `isNew` (released, or really listed, ≤ 30 days ago — a demo row's listing time is the seed's clock and never counts), `kindLabel` (the card's platform line, localized: «جهاز PS5», «لعبة Switch 2», «يد تحكم · PS5», «سماعة · متعددة المنصات»), `forPlatforms` (the researched platforms, menu order: the dots), `releaseAt` (coming soon) and `compareAtDemo`. `compareAtIqd` is set only when an APPLIED price change set exactly that compare-at (really charged) or as a demo row's demo value (`compareAtDemo: true`: struck only under the demo marking, never worded as a saving); `deals`/`dealsOnly` follow the same rule. A demo row never reports `low_stock`. `badge`: "preorder" › "deal" › "new" (only with `isNew`), none on a sold-out card. `image.opaque` flags a photo that is not a cut-out (box art and screenshots excluded). Sort "featured" is the suggested order «المقترَح»: in stock › coming soon (soonest release first) › sold out, newest first inside; `listProducts` on a platform hub leads with the platform's own in-stock consoles in device-model order (entry version of a model first). `getProductDetail` applies the same rules (`isNew`, variant `compareAtDemo`, no demo scarcity, `opaque` pictures).

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

#### 06 pos

`services/admin/pos/` — authorization inside (`assertCan`; branch-limited employees work at their branch's registers); a sale only through the core file `orders/pos-sale.server.ts` (§1); prices through pricing's `resolveListPrice` (channel `pos`); the module itself writes `pos_registers`, `pos_shifts` (open, close, review) and hand `cash_movements` (pay_in / pay_out / drop), each with an audit event, and the shift-difference posting through `journalStatements` (key `pos_shift:<id>:variance`). No cost or margin in any result; the drawer's owner — a supervisor working a till included — never receives expected cash, cash sales, sales by method or the difference (blind count; `seesShiftFigures(actor, shift)` in `shifts.server.ts`); serials on receipts only with inventory.serial.read; the buyer's wallet balance only with customers.wallet.read.
Exports used across the module's routes (review 2026-11-11): `printReceipt(db, actor, ref, now, locale?) → { copy /* 0 = the original */; receipt }` (the first print is recorded once as `pos.receipt.print`, every later one needs pos.receipt.reprint and is `pos.receipt.reprint`); `discardQueuedSale(db, actor, { key, reason, sale? }, now)` (pos.shift.review; the audit keeps what the device held; a recorded key → `sale_recorded`); `getReceipt(…).printed`; a key reused with other figures on `moveCash` / `openShift` → `idempotency_mismatch`. Details: `docs/areas/admin-pos.md`.

```ts
// types.ts (client-safe): IQD_DENOMINATIONS, CASH_MOVE_KINDS, TILL_METHODS, CASHIER_DISCOUNT_LIMIT_BPS (1000), CATALOG_MAX_AGE_MS, shiftStateOf, parseWhole / parsePercentBps (Arabic-Indic / Persian digits), cartTotals, discountBeyondLimit, URL filters (parseShiftFilters / shiftSearch, parseSaleFilters / saleSearch), baghdadDay(Range), view-model types (TillItem, LookupResult, CatalogSnapshot, CustomerHit, SaleRequest, SaleOutcome, ShiftView, ShiftReport, RegisterRow, SaleRow, ReceiptView)
// shared.server.ts — posAccess(actor) · POS_READERS · employeeNames
// registers.server.ts — 06.01 06.04
listRegisters(db, actor, locale) · registerFormOptions(db, actor, locale) · saveRegister(db, actor, { registerId?, code, name, locationId /* kind store */, branchId?, isActive, reason? }, now): { registerId; changed }
// shifts.server.ts — 06.02
openShiftForm(db, actor, locale) · openShift(db, actor, { registerId, openingFloatIqd, denominations?, notes?, idempotencyKey }, now): { shiftId; replayed }
moveCash(db, actor, { shiftId, kind: "pay_in"|"pay_out"|"drop", amountIqd, reason, idempotencyKey }, now): { replayed }   // never below zero
closeShift(db, actor, { shiftId, denominations? | countedCashIqd, notes? }, now): { needsReview; varianceIqd /* reviewers only */; replayed }
reviewShift(db, actor, { shiftId, expectedVarianceIqd, note }, now): { replayed; journalEntryId }   // pos.shift.review, never who opened or closed it
myShift(db, actor, locale) · listShifts(db, actor, filters, locale) · shiftReport(db, actor, shiftId, locale) · countReviewable(db, actor)
// sale.server.ts — 06.01 06.03–06.07
lookupItem(db, actor, { shiftId, code }, locale, now): LookupResult · searchItems(db, actor, { shiftId, q }, locale, now) · catalogSnapshot(db, actor, { shiftId }, locale, now)
findCustomer(db, actor, { phone }): CustomerHit | null   // + customers.customer.read
createSale(db, actor, raw: SaleRequest, { locale, storeMode }, now): { ok: true; ref; receiptNumber; totalIqd; changeIqd; replayed; lateForClosedShift }   // throws PosSaleError (prices, resolvable)
syncSales(db, actor, { sales }, ctx, now, t?): { key; outcome }[] · saleFailure(error, t?)
listSales(db, actor, filters, locale) · getReceipt(db, actor, ref, locale): ReceiptView · recordReprint(db, actor, ref, now): { copy }
```
Errors (texts: `admin-pos` → `errors.*`): `price_changed`, `price_missing`, `not_sellable`, `discount_not_allowed`, `discount_over_limit`, `discount_below_floor` (403), `discount_reason_required`, `card_reference_required`, `wallet_offline`, `serial_unknown`, `override_reason_required`, `customer_unknown`, `shift_already_open`, `register_busy`, `shift_not_open`, `shift_not_in_review`, `shift_changed`, `drawer_short`, `shift_self_review` (403), `code_taken`, `register_has_open_shift`, `register_changed`, field keys `location_not_store`, `branch_invalid`, `code_invalid`, `count_mismatch`, `reason_required`, plus the core file's `POS_SALE_ERROR_KEYS`.

#### 07 customers

`services/admin/customers/` — authorization inside (`assertCan`); no cost, landed cost, margin or profit is read anywhere ("value" = paid − refunded); phones through `phoneView` (masked without customer.phone.read_full; partial-digit search needs it); the wallet only through the core (`getWalletBalance`, `listWalletEntries`; credits stay module 10's); every change one guarded batch with its audit event; notes and logged contacts are append-only audit events; consents only ever get withdrawals. Details: `docs/areas/admin-customers.md`.

```ts
// types.ts (client-safe): statuses and tones, RFM_RULES + scoreRecency/Frequency/Monetary + segmentOf + rfmOf (pure), FLAG_RULES + FLAG_IDS,
//   CUSTOMER_VIEWS / parseCustomerFilters / customerSearch (URL state), consent + privacy filters, PRIVACY_DUE_DAYS, VERIFY_METHODS,
//   MERGE_VERIFY_METHODS, RETENTION (what an erasure erases / keeps), MESSAGE_SAFE_FIELDS, view-model types
// shared.server.ts — customersAccess(actor) · phoneView(e164, full) · customerById · changeableCustomer (merged/erased → customer_unavailable) · hasLongDigitRun · CUSTOMER_ERROR_KEYS
// list.server.ts — 07.01 07.06
listCustomers(db, actor, filters, now): CustomerListPage · customerWhere(filters, actor, now) · customerQueues(db, actor, now): { vip; risk; complaints; blocked }
exportCustomersCsv(db, actor, filters, now, labels): { header; rows; truncated }   // + customers.customer.export, ≤ 5,000 rows, audited
// profile.server.ts — 07.01
customerHeader(db, actor, customerId, now) · getCustomerProfile(db, actor, customerId, locale, now): CustomerProfile   // sections null without their module's permission; activity by activityScope(actor, access) (wallet / consent / other modules' events need their permission)
addCustomerNote(db, actor, { customerId, text }, now)   // customers.customer.note · currentConsents(db, customerId)
// rfm.server.ts — 07.02
rfmFacts(db, customerIds?) · storedSegments(db, ids) · segmentOverview(db, actor, now) · recomputeSegments(db, actor, now): { counts; total }   // customers.segment.manage, one batch
// flags.server.ts — 07.06
customerFlags(db, ids, now): Map<id, CustomerFlag[]> · flagCondition(view, now): SQL
setVip(db, actor, { customerId, tier | null, reason }, now)   // customers.customer.update
setFraudFlag / setBlocked(db, actor, { customerId, flagged | blocked, reason }, now)   // customers.customer.block; blocking revokes the sessions
// contact.server.ts — 07.03 (customers.customer.update)
getContactView(db, actor, customerId, locale) · updateCustomerDetails(db, actor, { customerId, name?, email?, locale, reason, expectedUpdatedAt }, now)
saveCustomerAddress(db, actor, { customerId, id?, …AddressInput, reason, expectedUpdatedAt? }, now) · deleteCustomerAddress / setCustomerDefaultAddress(db, actor, { customerId, addressId, reason, expectedUpdatedAt? }, now)
setCustomerChannels(db, actor, { customerId, sms, whatsapp, email, reason, expectedUpdatedAt? }, now)   // a stamp older than the row → customer_changed; limit and default decided in the batch
// privacy.server.ts — 07.04
listConsentLog(db, actor, filters) · customerConsentHistory(db, actor, customerId) · consentSources   // customers.consent.read
recordWithdrawal(db, actor, { customerId, kind, reason }, now)   // customers.privacy.manage; a "no" only
listPrivacyRequests · privacyCounts(db, actor, now) · getPrivacyRequest(db, actor, ref, now) · customerPrivacyRequests
createPrivacyRequest(db, actor, { customerId? | phone, kind, details?, idempotencyKey }, now): { ref; replayed } · verifyPrivacyRequest(…, { ref, method, note }) · rejectPrivacyRequest / completePrivacyRequest(…, { ref, note })
buildPrivacyExport(db, actor, ref, now): { filename; body; sha256 }   // verified exports still in progress only, audited per download
planErasure(db, actor, ref) · executeErasure(db, actor, { ref, reason }, now) · executeUnsubscribe(db, actor, { ref, kinds, note }, now) · erasedPhone(customerId)   // erasure: the account + accounts merged into it, guest contacts' names and answers, browsing signals; every guard again in the batch; wallet amounts in the plan only with customers.wallet.read
// merge.server.ts — 07.05 (customers.customer.merge)
duplicateCandidates(db, actor, customerId) · storeDuplicates(db, actor) · recentMerges(db, actor)
planMerge(db, actor, { keepId, mergeId }, now): MergePlan (moves, stays, consentCarry, blockers incl. duplicate_blocked / duplicate_flagged, fingerprint; walletIqd null without customers.wallet.read)
mergeCustomers(db, actor, { keepId, mergeId, method, verification, reason, fingerprint }, now): { replayed; moved }
// communication.server.ts — 07.07
listCommunication(db, actor, { customerId, orderRef? }, now)   // customers.communication.read; outbox rows with MESSAGE_SAFE_FIELDS only + logged contacts
logContact(db, actor, { customerId, channel, direction, orderRef?, summary }, now)   // customers.customer.note; an order of this customer only
```
Errors (texts: `admin-customers` → `errors.*`): `CUSTOMER_ERROR_KEYS` — `customer_changed`, `address_limit`, `note_has_card_number` (field), `consent_not_granted`, `privacy_not_verified`, `privacy_not_exported`, `privacy_not_open`, `privacy_wrong_kind`, `privacy_already_verified`, `privacy_customer_required`, `privacy_open_exists`, `erasure_blocked`, `merge_same_account`, `merge_blocked`, `merge_plan_changed`, `merge_already_done`, `segments_changed`, `vip_unchanged`, `flag_unchanged`, `status_unchanged`, plus `customer_unavailable` and the shared field keys.

#### 08 promotions

`services/admin/promotions/` — authorization inside (`assertCan`; a section reads with promotions.promotion.read or its own manage permission, `SECTION_READ`); nothing here changes a checkout total — coupons are evaluated and redeemed by the core only (`evaluateCoupon` in "try this coupon", never a second validation path), prices of flash sales are judged by pricing 03's `evaluatePriceChange` / `costBasisFor`, VIP eligibility is module 07's `flagCondition("vip")` / `customerFlags`, gift-card value reaches a wallet only through the core's `walletCreditStatement` + `postWalletCredit`. Second-person requests are `approvals` rows (kinds `coupon`, `promotion_rule`, `flash_sale`, `gift_card`, `loyalty_adjustment`; the requester never decides — `approver_is_requester`); every change one guarded batch with its audit event; `loyalty_ledger` is append-only with one idempotency key per fact. [P] floor price, cost, margins, "needs the override" and the cost-based reasons (pricing 03's field rule) only with cost.read + profit.read — in loader data, action answers and the approvals queue; a record's page decides only its own requests (decide / withdraw take the page's id → 404 for another record's approval); phones masked without customer.phone.read_full; gift-card codes never in a list, history or audit event. Details: `docs/areas/admin-promotions.md`.

```ts
// types.ts (client-safe): DISCOUNT_LIMITS (20 %, 50,000 IQD), LOYALTY, REFERRAL, GIFT_CARD, FLASH, EXPERIMENT constants; states / views / tones;
//   latinDigits · parseWhole · parsePercentBps · toBaghdadInput / fromBaghdadInput; URL state parse*/…Search for coupons, rules, flash, ledger, referrals, gift cards, dry run
// rules.ts (pure, client-safe) — the checkout hook's evaluator
discountApprovalReasons(terms, { coupon? }) · termsFingerprint · couponStateOf · ruleStateOf · flashStateOf · windowsOverlap
evaluateRule(terms: RuleTerms, cart: CartFacts): RuleOutcome   // percent / fixed / tiered / bogo / free_shipping; scope, segment, channel, cart value, quantity, window, ceiling
stackedChange(outcome, stackable, existingDiscountIqd, subtotalIqd) · pointsFor(order, multiplierBps) · expiredUnconsumed(credits, debits, at) · experimentDecision(results, metric, minSample)
// shared.server.ts
promotionsAccess(actor) · SECTION_READ · DECIDE_PERMISSIONS · canDecideApproval / assertMayDecide · approvedFingerprint · pendingApprovalOf · noPendingRequest(db, kind, entityId) (in a request's batch: one waiting request per record) · idFromKey
// coupons.server.ts — 08.01 (promotions.coupon.manage; decide + pricing.discount.override)
listCoupons(db, actor, parseCouponFilters(params), now) · getCoupon(db, actor, couponId, now) · couponChoices · conditionOptions(db, locale)
saveCoupon(db, actor, raw, now, { demo? }): create (a replay = same code, author and terms) or edit ({ couponId, expected: the terms' fingerprint, reason }); terms past the limits → a request, live terms stay
setCouponActive · deactivateCoupons (bulk ≤ 100, reason) · decideCoupon({ approvalId, couponId?, decision, note }) · withdrawCouponRequest({ approvalId, couponId? }) · tryCoupon({ code, lines: { code, qty (Arabic-Indic digits too) }[], phone?, channel })
// discounts.server.ts — 08.02 (promotions.rule.manage; decide + pricing.discount.override)
listRules · getRule · saveRule(…, { demo? }) · setRuleActive · decideRule({ approvalId, ruleId?, … }) · withdrawRuleRequest({ approvalId, ruleId? }) · ruleChoices
dryRun(db, actor, ruleId, { days: 7 | 30 | 90, includeDemo }, now)   // ≤ 2,000 recent orders, read only; margin block null without cost.read + profit.read
// flash.server.ts — 08.03 (promotions.flash_sale.manage; decide + pricing.price.approve, + pricing.discount.override under the margin floor)
listFlashSales · getFlashSale · createFlashSale(…, { demo? }) · updateFlashSale · setFlashItem({ saleId, code (SKU | barcode), salePrice, qtyLimit, perCustomerLimit? }) · removeFlashItem
submitFlashSale → scheduled | a request (cut from the 30-day high, dropReferencePrice) · decideFlashSale({ approvalId, saleId?, … }) (guarded on the items checksum; pricing re-evaluated → override_required) · withdrawFlashRequest({ approvalId, saleId? }) · cancelFlashSale
// loyalty.server.ts — 08.04 (promotions.loyalty.manage / promotions.loyalty.adjust)
loyaltyOverview · listLedger · customerPoints · findCustomerId · multipliers(db, customerIds, now)
syncOrderPoints(db, actor, now)   // earn `loyalty:earn:<order>` after delivery + returns.window_days; reversal `loyalty:reversal:<refund>`
postExpiry(db, actor, now)   // FIFO, `loyalty:expire:<customer>:<credits>` · adjustPoints (> 5,000 points, or > 10,000 given alone in 24 h → a request; points_solo_limit in the batch) · decideAdjustment({ approvalId, customerId?, … }) · withdrawAdjustment({ approvalId, customerId? })
// referrals.server.ts — 08.05 (promotions.referral.manage)
listReferrals · issueReferralCode({ customerId | phone, maxUses? }) · setReferralCodeActive · recordReferral({ code, phone, orderRef?, note, idempotencyKey }) · rewardReferral (not the recorder) · rejectReferral
// vip.server.ts — 08.06 (promotions.membership.manage)
vipPage(db, actor, now, locale, { members: "current" | "ended", page }) (memberTotal = the chosen view's count) · saveTier · grantMembership (one active per customer) · endMembership · closeEndedMemberships
// giftcards.server.ts — 08.07 (promotions.gift_card.issue / .manage; reveal + digital_code.reveal)
giftCardSettlement · listGiftCards · getGiftCard · issueGiftCard(db, actor, dataKey, raw, now, { demo? }): code once, or a request above 100,000 IQD / 250,000 IQD a day alone
decideGiftCard (code once to the approver) · withdrawGiftCardRequest · revealGiftCardCode (reason, audited, rate-limited) · voidGiftCard · expireGiftCards
checkGiftCardRedemption(db, actor, { code, customerId? | phone? }, now)   // read only: amount + whose wallet, for the confirm dialog (same checks, same guessing limit)
redeemGiftCard(db, actor, { code, customerId? | phone?, idempotencyKey }, now)   // guarded active → redeemed + wallet credit key `gift_card:<id>` (Dr marketing / Cr wallet liability) in one batch; replay → { replayed: true }; demo card ↔ demo account only
// experiments.server.ts — 08.08 (promotions.experiment.manage)
listExperiments · getExperiment(…, { includeDemo }) · saveExperiment · startExperiment (measurement rule required) · pauseExperiment · resumeExperiment · completeExperiment (winner only when decidable)
// approvals.server.ts · overview.server.ts
countDecidable(db, actor): number | null · listApprovals(db, actor, locale, format) · promotionsOverview(db, actor, now)
```
Errors (texts: `admin-promotions` → `errors.*`): `PROMOTIONS_ERROR_KEYS` — `code_taken`, `coupon_changed`, `coupon_needs_approval`, `change_pending`, `change_not_pending`, `approver_is_requester`, `rule_changed`, `flash_changed`, `flash_not_draft`, `flash_not_scheduled`, `flash_started`, `flash_empty`, `flash_overlap`, `flash_item_problem`, `flash_window_past`, `points_insufficient`, `customer_unavailable`, `referral_code_exists`, `referral_code_inactive`, `referral_cap_reached`, `referral_self`, `referral_phone_used`, `referral_not_open`, `referral_not_qualified`, `referral_self_review`, `referral_order_mismatch`, `membership_exists`, `membership_not_active`, `tier_changed`, `tier_inactive`, `gift_card_unknown`, `gift_card_used`, `gift_card_void`, `gift_card_expired`, `gift_card_not_active`, `gift_card_not_revealable`, `gift_card_solo_limit`, `gift_card_demo_mismatch`, `override_required`, `points_solo_limit`, `data_key_missing`, `wallet_requires_account`, `experiment_changed`, `experiment_not_draft`, `experiment_not_running`, `experiment_rule_missing`, `experiment_not_decidable`, `key_taken`, `idempotency_mismatch`, plus field keys with their own texts (`customer_unknown`, `code_invalid`, `number_invalid`, `percent_invalid`, `date_invalid`, `price_step`, `price_not_lower`, `allowance_over_stock`, `amount_step`, …) and the shared field keys.

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

#### 13 devices

`services/admin/devices/` — authorization inside (`assertCan`); money only through the core's statement builders, in ONE batch with the trade-in → paid, the serial and the used unit (a payout that loses a race moves no money): `walletCreditStatement` + `postWalletCredit` (kind `trade_in_credit`, key `tradein:<id>:payout`: Dr inventory / Cr wallet liability, audit `customers.wallet.credit`) for store credit, one `journalStatements` entry for cash (Dr inventory / Cr cash, key `trade_in:<id>:payout`, ref `trade_in`, guarded against an existing credit); prices only through pricing 03 (`setUsedUnitPrice`). The module writes `trade_ins` (staff steps), `trade_in_events` (the history the storefront's tracking page reads: `inspection_scheduled` {at}, `inspected`, `offered` {amountIqd}, `accepted`/`declined` {inPerson}, `paid`, `cancelled`, `expired`; staff-only `data_wiped`, `photo`), `used_units`, the trade-in `serials` row (and, for a unit the store sold before, its open `order_item_serials.released_at` and its active warranty `void`), `media` of used units, `files` visibility (photos published on listing), `inspection_templates` (new versions), `trade_in_price_guides`, `digital_codes` — each change one guarded batch with its audit event (`devices.*`). [P] acquisition / serial / code costs absent without cost.read, the margin without profit.read; phones masked without customer.phone.read_full; serials only for registry / inspection / ownership staff. Details: `docs/areas/admin-devices.md`.

```ts
// types.ts (client-safe): statuses + tones (trade-in, used unit, serial, code), URL filters (parseTradeInFilters / tradeInSearch, parseUsedFilters,
//   parseRegistryFilters), PIPELINE_STEPS + pipelineStep(), parseWhole / parsePercent (Arabic-Indic, Persian digits), limits (MAX_OFFER_IQD, OFFER_VALID_DAYS…), view models
// shared.server.ts — devicesAccess(actor) · DEVICES_PERMISSIONS · inspectionKindFor({ productKind, deviceKind }) · activeTemplates · templateById
//   checklistView(template, checklist, locale, kind) · buildChecklist(template, answers, actorId, now, clean) → { checklist; complete; batteryPct } · checklistAnswersFrom(form)
//   unitLocations · assertUnitLocation · unitBranchWhere(actor) (lists and their queue counts) · baghdadInstant(day, time)
// tradeins.server.ts — 13.03 13.04 13.08 13.09
listTradeIns(db, actor, filters, locale, now) · getTradeInDetail(db, actor, ref, locale, now, { file, target? }) · deviceQueueCounts(db, actor, now)   // queue counts, null per missing permission; each = its list (viewWhere(view, now))
openCounterTradeIn(db, actor, { idempotencyKey, phone, contactName?, deviceModelId? | code?, notes?, ownershipDeclared: true }, now, storeMode): { tradeInId; ref; replayed }
scheduleInspection(db, actor, { tradeInId, day, time, note? }, now) · recordInspection(db, actor, { tradeInId, templateId (current version), variantId?, serial?, grade?, answers, included, ownershipOk?, accountLockOk?, notes? }, now)   // a "yes" not on file for this serial: + devices.ownership.verify; left out: kept
makeOffer(db, actor, { tradeInId, amountIqd, validDays?, note? }, now): { expiresAt; replayed } · recordAnswer(db, actor, { tradeInId, decision: "accept", payout } | { …, "decline", reason? }, now): { status; replayed }
confirmWipe(db, actor, { tradeInId, note? }, now) · payOut(db, actor, { tradeInId, method?, locationId, reason? }, now, { labels? }): { usedUnitId; replayed; method }
cancelTradeIn(db, actor, { tradeInId, reason }, now) · expireTradeInOffers(db, now, limit?): { expired }   // for the daily job
valuationOf(guide, grade, included) · guideFor(db, modelId, variantId) · priceDifference(target, offerIqd) · payoutNeedsSecond(offerIqd, suggestedIqd, guideSetByOfferer?) · normalizeSerial
assertTradeInPhotoSlot · recordTradeInPhoto · tradeInDocument · counterModelOptions · payoutWalletKey · payoutJournalKey · counterTradeInId
// used.server.ts — 13.02 13.08 13.09
listUsedUnits(db, actor, filters, locale) · getUsedUnitDetail(db, actor, id, locale, { file }) · listBlockers(facts) · settledStatus(db, unit, kind)   // the ready rule, also for the payout
saveUnitChecklist(db, actor, { usedUnitId, templateId (current version), answers }, now) · saveUnitGrading(db, actor, { usedUnitId, grade, cosmeticNotes, defects, included, warrantyDays }, now, labels)
confirmUnitChecks(db, actor, { usedUnitId, ownership?, wipe?, note? }, now) · startReinspection(db, actor, { usedUnitId, reason }, now)
assertUnitPhotoSlot · recordUnitPhoto · setPhotoReal(db, store, actor, { usedUnitId, mediaId, real }, now) · removeUnitPhoto(db, store, actor, …)
listUnit(db, store, actor, { usedUnitId }, now) · unlistUnit(db, actor, { usedUnitId, reason }, now)
// registry.server.ts — 13.01 · templates.server.ts — 13.02 · guides.server.ts — 13.03 · codes.server.ts — 13.06 13.07 · files.server.ts
listRegistry(db, actor, filters, locale) · getRegistryDetail(db, actor, serialId, locale)   // movements only with inventory.movement.read
listTemplates · getTemplateEditor(db, actor, kind, locale) · saveTemplate(db, actor, { kind, expectedVersion, name, items, reason }, now): { templateId; version }
listGuides · modelOptions · saveGuide(db, actor, { guideId?, expectedUpdatedAt?, deviceModelId, variantCode?, baseIqd, multipliers (percent), deductions, isActive, reason }, now)
digitalOverview(db, actor, locale) · deliveryClass(facts) · listCodes(db, actor, variantId, { status, page }, locale)
importCodes(db, actor, dataKey, { variantId, codes, expiresOn?, unitCostIqd? }, now, { demo? }): { added; duplicates } · revealCode(db, actor, dataKey, { codeId, variantId?, reason }, now): { code }   // only codePaidFor(row): delivered on a paid, not fully refunded line
revokeCode(db, actor, { codeId, variantId?, reason }, now) · codeContext(codeId) · normalizeCode · devicesFile(db, actor, fileId)
```
Errors (texts: `admin-devices` → `errors.*`): `trade_in_changed`, `trade_in_not_open`, `inspection_required`, `offer_ownership`, `offer_account_lock`, `offer_checklist_incomplete`, `offer_grade_required`, `offer_variant_required`, `offer_serial_required`, `offer_open`, `offer_closed`, `payout_not_accepted`, `payout_method_required`, `payout_requires_account`, `payout_wipe_required`, `payout_second_person` (403), `payout_started`, `photo_limit`, `unit_changed`, `unit_not_editable`, `unit_returned_reinspect`, `unit_not_returned`, `unit_not_ready`, `unit_not_listed`, `unit_reserved`, `not_listable`, `last_real_photo`, `template_changed`, `guide_changed`, `not_digital`, `code_unpaid`, `code_not_revealable`, `code_not_available`, field keys `serial_in_stock`, `serial_in_trade_in`, `serial_variant_mismatch`, `variant_not_model`, `template_invalid`, `offer_step`, `percent_invalid`, `schedule_out_of_range`, `key_invalid`, `key_taken`, `critical_pass_fail`, `device_required`, plus the wallet's and pricing's codes.

#### 14 support

`services/admin/support/` — authorization inside (`assertCan` / `canAny`); no stock, money or order state is touched (refunds and RMAs are modules 05 / 12, linked from the ticket). The module writes `support_tickets` (staff tickets, status, priority / topic / team with their SLA due times, holder, links by id, escalation), `ticket_messages` (replies, internal notes, customer messages staff record; ids derived from the form's key), `outbox` (a written reply, `held`, template `support_reply`, dedupe `support_reply:<message id>`), `ticket_routing_rules` (`conditions` = match lists + the pool `agents` + `capacity`), `sla_policies`, `canned_replies`, `knowledge_articles` and `approvals` (kind `knowledge_article`: a pending revision of an approved article) — each change one guarded batch with its audit event (`support.*`). Repair status events stay module 12's (`changeRepairStatus`). Phones masked without customer.phone.read_full; linked records shown only with their module's read permission; never cost. Details: `docs/areas/admin-support.md`.

```ts
// types.ts (client-safe): SUPPORT_ERROR_KEYS, statuses + tones, TICKET_TRANSITIONS, STATUS_WITH_REASON, REPLY_VIA / INBOUND_VIA / STAFF_CHANNELS,
//   INBOX_VIEWS / parseInboxFilters / inboxSearch / QUEUE_LINKS, CANNED_VARIABLES + checkTemplate / fillTemplate / unfilledPlaceholders,
//   RuleConditions + ruleMatches / normalizeMatchText / pickAgent, slaClock, SUGGESTED_SLA, median / percentile / share, ESCALATION_PERMISSION, view models
// inbox.server.ts — 14.01
listInbox(db, actor, filters, now): InboxPage   // tickets ∪ repair requests, views + filters + sort + page
supportQueueCounts(db, actor, now): { escalatedToMe; unassigned; mineLate }   // null per missing permission; each = the QUEUE_LINKS view's rows
// tickets.server.ts — 14.01 14.02
getTicket(db, actor, ref, locale, now, { file }): TicketDetail · agentLoads(db) · supportPhotoFile(db, actor, fileId)
openStaffTicket(db, actor, { channel, phone?|email?, contactName?, subject, category, priority, message?, orderRef?, repairRef?, locale, takeIt, idempotencyKey }, now, storeMode): { ticketId; ref; replayed; decision }
//   orderRef needs orders.order.read, repairRef support.ticket.read (403 before the look-up); the account by phone only with customers.customer.read;
//   one customer across account / order / repair (order_other_customer); references with Arabic-Indic digits accepted
replyToTicket(db, actor, { ticketId, body, via: whatsapp|sms|email|call|in_person, then, cannedReplyId?, edited?, idempotencyKey }, now): { messageId; status; held; replayed }
addInternalNote · recordInboundMessage(db, actor, { ticketId, body, via, idempotencyKey }, now)
changeTicketStatus(db, actor, { ticketId, from, to, reason? }, now) · triageTicket(db, actor, { ticketId, priority, category, team, expectedUpdatedAt }, now)
//   resolving / closing (also a reply with then "resolved") is guarded inside the write on "the escalation is what was checked" (ticket_changed)
linkTicket(db, actor, { ticketId, field: customer|order|product|warranty|repair|return, value ("" = unlink) }, now)   // a look-up needs LINK_READ[field] (that kind's read permission)
//   linkOwners(db, links) / linkConflict(record, others): ONE customer and ONE order across all links, whichever came first; the write is guarded on every link read
assignTicket(db, actor, { ticketId, employeeId, expected }, now) · assignTickets(db, actor, { ticketIds, employeeId, expected?: { [ticketId]: holder shown | "" } }, now): { assigned; skipped }
//   TicketDetail.can.rmaCreate (returns.rma.create: the "return request" key) · can.handBack (holder or cover) · rma.status only with returns.rma.read
// routing.server.ts — 14.03
listRoutingRules (each rule's `version` = ruleVersion(rule)) · saveRoutingRule(db, actor, { id?, version (required with id), name, categories, channels, priorities, keywords, agents, capacity, team, setPriority, isActive, reason }, now) · moveRoutingRule · deleteRoutingRule(db, actor, { ruleId, reason, version? }, now)
previewRule(db, actor, rule): { checked; count; matches }   // matches (refs, subjects) only with support.ticket.read
routeTicket(db, actor, { ticketId }, now): RouteDecision · routeWaitingTickets(db, actor, now, limit?) · countWaitingToRoute(db)   // for a scheduled job: actor = systemActor("support.route")
// sla.server.ts — 14.05
listSlaPolicies (policies with `version`; missing: { open, withoutDue, fillable }) · saveSlaPolicy({ id?, version (required with id), … }) · adoptSuggestedSla · applySlaToOpenTickets (fills exactly the `fillable` tickets) · policyFor(db, priority, category) · dueTimesFor(db, priority, category, createdAt)
// metrics.server.ts — 14.05: supportMetrics(db, actor, { days: 7|30|90, demo }, now)
// replies.server.ts — 14.04: listCannedReplies · saveCannedReply · ticketVariables (account name / order status only with customers.customer.read / orders.order.read) · previewCannedReply(db, actor, { ticketId, replyId })
// knowledge.server.ts — 14.06 (article-text.ts client-safe: textToArticleBlocks / articleBlocksToText)
listArticles · getArticleEditor (revision.savedAt = its version) · knowledgeOptions · saveArticle({ …, revisionSavedAt? (the revision the form showed) }, storeMode) · submitArticle · decideArticle
decideRevision(db, actor, { articleId, revisionId, savedAt (required to approve / reject: the version the decider saw), decision: approve|reject|withdraw, note }, now) · archiveArticle · restoreArticle
// escalation.server.ts — 14.07: escalationTargets(db, actor) · escalateTicket(db, actor, { ticketId, kind, toEmployeeId, reason, expected }, now) · returnEscalation(db, actor, { ticketId, outcome }, now)
//   lastEscalation(db, ticketId) / escalationTrail(events): { kind, by, escalators } · settlesEscalation(actor, ticket, trail): "holder" | "cover" | null — a cover holds
//   support.ticket.escalate + the kind's permission and did NOT escalate it (nor pass it on) since the last hand-back; only the holder or a cover hands it back or
//   passes it on (escalation_open); the target's authority is re-checked inside the write
// repairs.server.ts — 14.01: getRepairRequest(db, actor, ref, locale, now, { file }) · openRepairTicket(db, actor, { repairRef, channel, subject?, message, idempotencyKey }, now, storeMode)
```
Errors (texts: `admin-support` → `errors.*`): `SUPPORT_ERROR_KEYS` — `ticket_changed`, `transition_not_allowed`, `ticket_closed`, `take_only_unassigned`, `assignee_not_agent`, `escalation_target`, `escalation_self`, `escalation_open`, `not_escalated`, `order_other_customer`, `warranty_other_order`, `rule_changed`, `policy_duplicate`, `article_changed`, `approver_is_editor` (403), `revision_pending`, `no_revision`, `article_not_editable`, `reply_changed`, `nothing_to_apply`, field keys `reason_required`, `unfilled_variable`, `template_code`, `unknown_variable`, `no_phone`, `no_email`, `contact_required`, `link_not_found`, `slug_taken`, `slug_locked`, `photo_unknown`, `key_taken`, `rule_does_nothing`, `resolution_before_response`.

#### 15 staff

`services/admin/staff/` — authorization inside (`assertCan` / `assertAny`, before the input is read; one's own clock, leave, tasks, commissions and pay need only to be that employee). Accounts, passwords, roles and sessions only through their owners: `disableEmployee` and `listEmployeeSessions` (auth core), `endStaffSession` / `endAllStaffSessions` / `authEventView` / `holdsAll` / `storedPermissionsOf` (module 20); roles are edited only in `/admin/security/roles`. Money only through the core file `accounting/payroll.server.ts` (§1). The module writes `shifts`, `attendance`, `leave_requests`, `staff_tasks` (its own; another module's tasks — `ref_type` set — change only there), `commission_rules` (versions `crl_<id>`, `crl_<id>.v<n>`, never edited but for their end), `commissions` (`com_<order item>_<n>`; an amount is never edited — a later difference is a new row; only the run link and status move with a run), `payroll_runs` (`pyr_…` real / `pyd_…` demo), `payroll_items`, `employee_advances`, `approvals` (kind `staff_advance`), `employees.job_title / phone / base_salary_iqd` — each change one guarded batch with its audit event (`staff.*`; pay under `staff.payroll.*`). Salary and pay absent without staff.payroll.read/.run/.approve; a profit plan's rate and a profit row's base/rate absent without profit.read; performance reads no cost. Details: `docs/areas/admin-staff.md`.

```ts
// types.ts (client-safe): statuses + TONES, STAFF_ERROR_KEYS, URL filters (parseEmployeeFilters / employeeSearch, parseRosterFilters / rosterSearch, parseAttendanceFilters,
//   parseLeaveFilters, parseTaskFilters, parseCommissionFilters, parsePayrollFilters, parseAdvanceFilters, parsePeriod, searchOf), weekStartOf / weekDays / addDays / daySpan /
//   monthDays (Baghdad, Saturday-first), parseClock / clockOf, parseWhole / parseRateBps (Arabic-Indic, Persian digits) / bpsText, view models
// shared.server.ts — staffAccess(actor) · STAFF_PERMISSIONS · employeeFacts · activeEmployee · peopleById · rolesOf · employeeOptions(db, { includeDisabled?, demo?, branchId? }) · participants(db, type, id, actions) · tookPartSql
//   branch limits (review 2026-11-12): branchLimit(actor) · assertReach(actor, { branchId }) · assertReachOf(db, actor, employeeId) · reachSql(actor, employeeIdColumn) · assertWholeStore(actor)
//   — a branch-limited employee reads and changes only the staff of their branch (403 "branch" otherwise); payroll runs only without a limit
// employees.server.ts — 15.01 15.07
listEmployees(db, actor, filters, locale) · getEmployeeProfile(db, actor, employeeId, locale, now, currentSessionId?) · effectivePermissions(db, employeeId, locale)
updateEmployeeProfile(db, actor, { employeeId, jobTitle?, phone?, reason, expectedUpdatedAt }, now) (staff.manage) · setBaseSalary(db, actor, { employeeId, baseSalaryIqd | null, expectedIqd, reason }, now) (staff.payroll.run; never one's own)
terminationPlan(db, actor, employeeId, now) · terminateEmployee(db, actor, { employeeId, reason }, now): { sessionsEnded; shiftsCancelled; leaveCancelled; attendanceClosed }   // staff.manage
endEmployeeSession / endEmployeeSessions(db, actor, { employeeId, sessionId?, reason }, now)   // module 20's services
// schedule.server.ts, attendance.server.ts, leave.server.ts, tasks.server.ts — 15.02
listRoster(db, actor, { week, employee }, locale, now) · createShift(db, actor, { employeeId, day, start, end, note? }, now) · cancelShift · markShift(…, { shiftId, status: "completed"|"missed", reason? }) · copyWeek(…, { fromWeek, toWeek }): { copied; skipped } · shiftsOf · shiftAt
listAttendance(db, actor, filters, locale) · myClock(db, actor, now) · clockIn / clockOut(db, actor, { note? }, now) · recordAttendance · correctAttendance(…, expectedClockInAt, expectedClockOutAt) · approveAttendance(db, actor, { ids }, now): { approved; skipped } · clockedInNow
listLeave(db, actor, filters, now) · myLeave · requestLeave(db, actor, { employeeId?, kind, startsOn, endsOn, reason? }, now) · decideLeave(…, { leaveId, decision, note? }): { status; shiftsCancelled } (never the employee nor whoever recorded it) · cancelLeave · unpaidLeaveDays · leaveRecorders(db, leaveIds)
listTasks(db, actor, filters, now) · createTask · moveTask(…, { taskId, to, reason? }) · reassignTask · taskMoves(actor, row)
// commissions.server.ts — 15.03
listPlans(db, actor, locale, now) · saveRuleVersion(db, actor, { planId?, name, basis, rateBps, scope, roleId?, employeeId?, productKind?, categoryId?, channel?, startsOn?, endsOn?, reason }, now): { ruleId; planId; version } · endPlan
syncCommissions(db, actor, { period }, now): SyncResult · syncCommissionsJob(db, actor, now)   // writes differences only · commissionLedger(db, actor, filters) · myCommissions(db, actor, period)
salesBaseOf · profitBaseOf · commissionOf · ruleForLine · planIdOf · versionOf   // pure
// payroll.server.ts — 15.04
listRuns · previewRun(db, actor, { period, demo? }, now) · prepareRun(db, actor, { period, demo, notes?, idempotencyKey }, now): { runId; replayed; employees } · getRun(db, actor, runId, now)
recomputeRun · updateItem(…, { runId, employeeId, bonusIqd, otherDeductionIqd, notes?, expectedNetIqd }) · deferAdvance(…, { runId, advanceId, reason }) · approveRun(…, { runId, expectedNetIqd, expectedItems, note? }) (never a participant, nor who changed a salary in it after that salary was last computed into a paid run, nor someone it pays)
payRun(db, actor, { runId, paidFrom, reference? }, now): { status: "paid"; journalEntryId; replayed } · voidRun · myPay · planRun · runInvolved · RUN_PARTICIPANT_ACTIONS
listAdvances · requestAdvance(…, { employeeId, amountIqd, paidFrom, reason, idempotencyKey }) · decideAdvance(…, { approvalId, decision, note? }) (never requester or beneficiary) · withdrawAdvance
// performance.server.ts — 15.05 · approvals.server.ts — 15.06 · overview.server.ts
performance(db, actor, { period, employeeId? }, locale, now) · staffDecisions(db, actor) · myRequests(db, actor) · storeApprovals(db, actor, locale) · approvalHref(kind, entityType, entityId) · staffOverview(db, actor, now)
```
Errors (texts: `admin-staff` → `errors.*`): `STAFF_ERROR_KEYS` — `shift_overlap`, `shift_not_scheduled`, `shift_in_past`, `employee_inactive`, `already_clocked_in`, `not_clocked_in`, `attendance_self_approval` (403), `attendance_changed`, `leave_overlap`, `leave_not_pending`, `leave_self_decision` (403), `task_not_open`, `task_managed_elsewhere`, `task_not_yours` (403), `rule_ended`, `rule_changed`, `profit_basis_needs_permission` (403), `run_open_exists`, `run_not_draft`, `run_not_approved`, `run_changed`, `run_self_approval` (403), `run_empty`, `run_mixed_demo`, `net_negative`, `advance_not_pending`, `advance_self_decision`, `advance_beneficiary` (403), `advance_not_in_run`, `target_more_privileged` (403), `own_account_here`, `commission_sync_busy`; also `employee_changed`, `salary_self_change` (403), `shift_on_leave`, `shift_not_started`, `shift_attended`, `attendance_overlap`, `leave_not_cancellable`, `advance_not_yours` (403), field keys `shift_too_long`, `too_far`, `attendance_too_long`, `attendance_future`, `leave_end_before_start`, `leave_too_long`, `leave_too_old`, `due_in_past`, `rule_start_past`, `rule_end_before_start`, `rule_start_before_latest`, `rate_invalid`, `period_future`, `period_too_old`, `reason_required`; plus the shared `approver_is_requester`, `last_owner`, `cannot_disable_self`, `employee_not_active`, `period_closed`, `already_posted`, `idempotency_mismatch`.

#### 17 cms

`services/admin/cms/` (URL and permission group `cms`, docs/areas/admin-cms.md) — authorization inside (`assertCan`, before the input is read); writes only CMS tables (`banners`, `home_sections`, `pages`, `nav_menus`, `catalog_filters`, `redirects`, `search_synonyms`), a product's `seo` only through the catalogue's `commitStatements`, a category's `seo` guarded on its stored text; never `search_index`, never a product's status, no money, stock or cost data. Every write guarded on the row's `updated_at` (`content_changed`) and audited (`cms.*`). `rules.ts` is client-safe.

```ts
// rules.ts (pure) — paths, Iraq time, arrangements
normalizeStorePath(raw, { query }) → { ok, path, query } | { ok: false, code: "path_invalid"|"path_reserved"|"path_external"|"path_query" } (one language prefix at most) · isReservedPath · isSafeExternalUrl
ownStorePath(raw, origins?) → "/path?query" | null   // a full address on STORE_HOSTS (tamtamgames.com, www.) or an origin's host is a store path: redirects and banner links pass through it first
redirectConflict(rows, { id?, fromPath, toPath, isActive? }) → "redirect_self"|"redirect_from_taken"|"redirect_loop"|"redirect_chain_target"|"redirect_chain_source"|null
parseBaghdadLocal("YYYY-MM-DDTHH:mm") · baghdadLocal(ms) · baghdadDay · parseBaghdadDay · windowsOverlap · inWindow · liveStateOf
arrangeHomeSections(placements) → HomeSectionKind[] ("personal" never hidden) · arrangeBySlug(items, NavPlacement[]) → items + featured · arrangeFilterGroups(placements)
HERO_PLATFORMS (= home HOME_PLATFORMS) · HOME_SECTIONS · LISTING_FILTER_GROUPS (= listing FILTER_GROUPS) · LANDING_PATH_PREFIX "/pages" · storePathOfPage · seoIssues · clipText
// shared.server.ts
productReadiness(db, productId, at) → ok | { reason: "unknown"|"not_published"|"scheduled_later"|"incomplete", missing } · assertProductReady · checkStoreLink(db, path, now) → { state: "ok"|"missing"|"not_live"|"unchecked"|"external"|"pending_route" } · cmsAccess(actor)
// banners.server.ts
listBanners (counts per view under the other filters, `stored`) · getBannerEditor · saveBanner(db, actor, raw, now, { demo?, origins? }) → { bannerId; created } · changeBannerStatus(db, actor, { bannerId, version, action: publish|schedule|unpublish|archive|restore, startsAt?, endsAt?, reason }, now) · searchProductPhotos
getActiveBanners(db, locale, "home_strip"|"category_top"|"cart", { now, categoryId?, includeDemo? }) → StoreBanner[]   // storefront read: ≤ 3, demo left out, dead product links dropped
// home.server.ts
getHomeLayoutEditor · saveHomeLayout(db, actor, { order, hidden, version, reason }, now) · getHomeLayout(db) → HomeSectionKind[]   // storefront read
listHeroPins · getHeroPinEditor · searchPinProducts · pinProductOf · saveHeroPin(db, actor, raw, now, { demo? }) → { pinId; created; staged } · publishHeroPin · discardPinChanges · unpublishHeroPin (each { pinId, version, reason })
getHomeHero(db, now, { includeDemo? }) → { pinId, platform, productId, headline: L10n, deck, startsAt, endsAt }[]   // storefront read, ≤ 1 per platform, product live
// pages.server.ts — policies here: shipping, payment, privacy, terms (returns, warranty → module 22); about, contact, landing
listPages · getPageEditor(db, actor, slug, locale, now, storeMode) · createLandingPage(db, actor, { slug, titleAr }, now, { demo? }) · startPageDraft(db, actor, { slug, version, reason, from?: "code"|"approved" }, now, storeMode) · savePageDraft · discardPageDraft   // cms.page.manage
publishPage (approve) · schedulePage (not while live) · archivePage (withdraw)   // cms.page.publish
getLandingPage(db, locale, slug, now) → LandingPageView | null   // storefront read (route /pages/:slug to be added)
// schedule.server.ts · navigation.server.ts · search.server.ts · seo.server.ts · redirects.server.ts · preview.server.ts · overview.server.ts
getSchedule(db, actor, { from, days }, locale, now)   // items carry `draft` (a draft banner's or pin's planned dates) and `demo`
getNavEditor · saveNavDraft · publishNav · discardNavDraft · getNavArrangement(db) → { platforms, categories: NavPlacement[] }   // storefront read
getFilterEditor · saveFilters(db, actor, { categoryId, groups, mode: save|inherit, version, reason }, now) · getListingFilterOrder(db, categoryId) → ListingFilterGroup[]   // storefront read
listSynonyms · getSynonym · saveSynonym · setSynonymActive · conceptPreview · trySearch · zeroResultQueries(db, actor, { days, locale, page }, now) · addQueryAsSynonym · suggestFor · consonantSketch
listSeo · getSeoEditor(db, actor, "product"|"category", id) · saveSeo(db, actor, { type, id, version, title, description, noindex, reason }, now)
listRedirects · saveRedirect(db, actor, { id?, version?, fromPath, toPath, code: 301|302, reason? }, now, { origins? }) · setRedirectsActive(db, actor, { ids, active, reason }, now) → { changed, skipped }   // a row switched by someone else meanwhile → content_changed
resolveRedirect(db, pathname) → { id, to, code, external } | null · recordRedirectHit(db, id)   // storefront reads: only where it would answer 404
previewLink(db, actor, { kind: banner|page|pin, id }, SESSION_SECRET, now) → { token, path, expiresAt } · openPreview(db, actor, token, secret, locale, now)
getCmsOverview(db, actor, locale, now)
```
Errors (texts: `admin-cms` → `errors.*`): `CMS_ERROR_KEYS` in `shared.server.ts` — `content_changed`, `page_in_settings`, `page_slug_taken`, `page_slug_reserved`, `page_no_draft`, `page_empty`, `page_live_schedule`, `page_not_live`, `pin_overlap`, `pin_window`, `pin_platform`, `pin_photo`, `pin_no_changes`, `product_unknown`, `product_not_ready` (field keys `product_not_published`, `product_scheduled_later`, `product_incomplete`), `link_missing`, `link_invalid`, `link_reserved`, `art_unknown`, `category_unknown`, `redirect_self`, `redirect_from_taken`, `redirect_loop`, `redirect_chain_target`, `redirect_chain_source`, `redirect_target_missing`, `path_*`, `synonym_*`, `nav_featured_max`, `nav_unknown_entry`, `seo_not_found`, `nothing_changed`, `preview_invalid` (404), `preview_secret` (503), field keys `schedule_past`, `schedule_order`, `schedule_far`, `section_locked`, `reason_required`.

#### 20 security

`services/admin/security/` — authorization inside (`assertCan` / `assertAny`, before the input is read); sessions and two-step only through the auth core (`revokeEmployeeSession`, `revokeAllEmployeeSessions`, `resetEmployeeMfa`), the chain only through `sealAudit` / `verifyAuditChain`. The module writes `role_permissions`, `roles` (new, non-system), `employee_roles`, `employees.branch_id` — each change one guarded batch with its audit event — and audit-only records (restore tests, access reviews, refund reviews, verify / seal / export). No secret leaves the server (no token, hash, TOTP secret or recovery code); audit snapshots of cost families are withheld and cost / margin / profit keys cut without cost.read (also in the CSV); phone identifiers masked without customer.phone.read_full. Details: `docs/areas/admin-security.md`.

```ts
// types.ts (client-safe): SECURITY_ERROR_KEYS, FIELD_KEYS (= FIELD_PERMISSIONS, tested), ACCESS_REVIEW_INTERVAL_DAYS, RESTORE_TEST_INTERVAL_DAYS, TIME_TRAVEL_DAYS,
//   SIGNIN_THRESHOLDS + SIGNIN_RULES, REFUND_THRESHOLDS + REFUND_SIGNALS, URL filters (parseStaffFilters / staffSearch, parseAuditFilters / auditSearch, parseSigninFilters / signinSearch, parseRefundFilters), view models
// staff.server.ts — 20.01
listStaffSecurity(db, actor, filters, locale, now) · getStaffSecurity(db, actor, employeeId, locale, now, currentSessionId?) · staffCounts · staffOptions   // security.session.read
endStaffSession(db, actor, { employeeId, sessionId, reason }, now): { ended } · endAllStaffSessions(db, actor, { employeeId, reason }, now): { ended }   // security.session.revoke; never one's own (own_account_here)
resetStaffTwoStep(db, actor, { employeeId, reason }, now): { reset }   // security.mfa.manage; two_step_not_on; target_more_privileged (403) when the target holds a permission the actor does not
// roles.server.ts — 20.02 (read: staff.manage | security.access_review.perform | security.session.read; write: staff.manage)
listRoles(db, actor, locale, now) · getRole(db, actor, roleId, locale) (+ membersFingerprint) · fingerprintOf(permissions) · membersFingerprintOf(ids)   // sorted, comma-joined
saveRolePermissions(db, actor, { roleId, permissions, fingerprint, reason }, now): { added; removed; members }   // grant_exceeds_own / revoke_exceeds_own: only one's own permissions, both ways
createRole(db, actor, { key, nameAr, nameEn?, descriptionAr?, copyFrom?, reason }, now): { roleId; copied; skipped }
setEmployeeRoles(db, actor, { employeeId, roleIds, expected, reason }, now): { added; removed; gained; lost }   // a role given OR taken needs all it grants (revoke_exceeds_own: only an owner takes the owner role)
setEmployeeBranch(db, actor, { employeeId, branchId | null, reason }, now): { changed }   // target_more_privileged when the target holds more
// shared.server.ts — holdsAll(actor, stored) · storedPermissionsOf(db, employeeId) (the hierarchy checks above)
// audit-log.server.ts — 20.03
listAuditEvents(db, actor, filters) · getAuditEvent(db, actor, eventId) · exportAuditCsv(db, actor, filters, now): { csv; rows; truncated }   // audit.read; the export is audited
verifyChain(db, actor, now) · sealNow(db, actor, now) · chainHead(db)   // security.audit.verify; both audited
// protections.server.ts — 20.04 20.06
encryptionStatus(db, actor, { DATA_KEY? }) (security.audit.verify) · duplicatesView(db, actor) (security.fraud.review) · IDEMPOTENCY_RULES
// backups.server.ts — 20.05 · retention.server.ts — 20.07
backupsView(db, actor, now) · recordRestoreTest(db, actor, { testedOn, method, pointInTime?, restoredTo, durationMinutes?, result, checks, notes?, idempotencyKey }, now): { id; replayed } · restoreTestAge(db, now)   // security.backup.manage
retentionView(db, actor) · performAccessReview(db, actor, { roleId, outcome: "confirmed"|"changes_needed", note, fingerprint, members }, now) · reviewsDue(db, now, days) · lastReviews(db, roleIds)   // role_changed when the permissions OR the members (getRole's membersFingerprint) moved on
// signins.server.ts · refund-reviews.server.ts — 20.08
signinOverview(db, actor, window, now) · listAuthEvents(db, actor, filters, now) · alertCount(db, actor, now)   // security.auth_event.read
listRefundReviews(db, actor, filters, now) · reviewRefund(db, actor, { refundId, outcome: "cleared"|"suspicious", note }, now) · unreviewedCount(db, actor, now)   // security.fraud.review; reviewer_involved
// overview.server.ts — securityOverview(db, actor, now) · shared.server.ts — securityAccess, identifierFor, snapshotWithheld, cutSnapshot, deviceOf
```
Errors (texts: `admin-security` → `errors.*`): `SECURITY_ERROR_KEYS` — `own_account_here`, `two_step_not_on`, `role_locked`, `role_changed`, `own_role`, `own_roles`, `wildcard_owner_only`, `grant_exceeds_own`, `revoke_exceeds_own`, `target_more_privileged`, `role_key_taken`, `roles_changed`, `last_owner`, `branch_unknown`, `reviewer_involved`, `restore_test_future`, `chain_verify_failed`, field keys `reason_required`, `no_change`.

#### 22 settings

`services/admin/settings/` — authorization inside; settings values only through `setSetting` / `settingChangeStatements` (`app/server/settings.server.ts`, extended additively: `approver` per key, `{ expected }` read once, compared and guarded inside the batch on the same stored text (`expected: null` matches only a stored value that no longer fits its schema), `readSettingState(db, key, row?)` → `{ value | null, isStored, broken }` (never throws), `parseSettingValue`, `isSettingChangedError`). The money-control keys (`pricing.drop_approval_bps`, `purchasing.po_approval_limit_iqd`, `finance.topup_second_approval_iqd`, `finance.expense_second_approval_iqd`) and `returns.sla` are read by their modules with the old constants as defaults; a change of a money-control key by anyone without `settings.change.approve` is an `approvals` row (kind `settings`) that another person approves in one batch. The module also writes `custom_fields`, `message_templates`, and the `pages` rows of kind `policy` for `returns` / `warranty` (draft, publish, archive). Details: `docs/areas/admin-settings.md`.

```ts
// catalog.ts (client-safe): SETTINGS_ERROR_KEYS, SETTING_EDITORS (every key: value | object | linked | unused) + SETTING_VIEWS / viewOf, SETTING_GROUP_ORDER,
//   parseWhole / parsePercentBps / latinDigits, FIELD_KINDS / FIELD_TYPES (= schema, tested), TEMPLATE_CATALOG / templateVariables / renderTemplate, EDITABLE_POLICIES, parseChangeFilters
// policy-text.ts (client-safe): textToBlocks(text) · blocksToText(blocks)   // ## h2 · - ul · 1. ol · > steps · [info|warning|danger] callout · | table |
// changes.server.ts — 22.06 and every key's editor
listSettingItems(db, actor, locale, now) · getSettingItem(db, actor, key, locale, now) · pendingChanges(db, actor, locale, now, key?) · listChanges(db, actor, { key, page }, locale)   // settings.read; items carry broken (a stored value that no longer fits) and blocked (a LIVE request); requests carry canDecide (approve) and canReject (also an expired one)
proposeSettingChange(db, actor, { key, value, expected, reason, idempotencyKey }, now): { status: "applied"|"requested"|"unchanged"; requestId?; replayed? }   // the key's permission
decideSettingChange(db, actor, { approvalId, decision: "approve"|"reject"|"withdraw", note? }, now): { status; replayed }   // settings.change.approve + the key's permission; never the requester
countDecidableSettingChanges(db, actor, now): number | null   // for the admin bell
// system.server.ts — 22.01 22.05 22.06: currencyView · taxSummary · localeView · environmentView(db, actor, { STORE_MODE, APP_ENV })
// policies.server.ts — 22.02: policiesView · getPolicyEditor(…, storeMode) · startPolicyDraft · savePolicyDraft · publishPolicy · archivePolicy   // cms.page.manage / cms.page.publish, guarded on updated_at
// custom-fields.server.ts — 22.03: listCustomFields · getCustomField · productCountsByKind · saveCustomField(db, actor, CustomFieldInput, now) · setCustomFieldActive   // settings.custom_field.manage
// templates.server.ts — 22.04: listTemplates · getTemplate · saveTemplate(db, actor, { key, locale, body, isActive, version, reason? }, now) (settings.template.manage) · filesView (settings.file.manage)
```
Errors (texts: `admin-settings` → `errors.*`): `SETTINGS_ERROR_KEYS` — `setting_changed`, `setting_needs_approval` (403), `change_pending`, `change_not_pending`, `approver_is_requester` (403), `not_editable`, `key_taken`, `key_locked`, `field_changed`, `type_locked`, `option_in_use`, `template_variable_unknown`, `template_variable_missing`, `template_changed`, `policy_changed`, `policy_no_draft`, `policy_not_editable`, `policy_empty`, field keys `reason_required`, `no_change`; plus the shared `idempotency_mismatch`.

#### 23 ops

`services/admin/ops/` — authorization inside (`assertCan`, before the input is read); reads `job_runs`, `outbox`, `consistency_findings`, module 20's restore tests (`restoreTestAge`) and the audit trail; runs jobs only through `runJob` (`app/server/jobs.server.ts`, origin `manual`); writes `incidents`, `incident_updates`, `error_reports`, `perf_rollups`, the status / resolution columns of `consistency_findings`, and `staff_tasks` (ref `incident` = the owner and target date, ref `consistency_finding` = who has a finding) — each change one guarded batch with its audit event (`ops.job.run`, `ops.finding.*`, `ops.incident.*`, `ops.error.*`). Never edits the data a consistency check compared. Cost / profit keys of job counters and finding details cut without cost.read / profit.read; cost checks' (`journal.*`) messages and numbers absent and unsearchable. Outbox recipients masked, payloads never read. Details: `docs/areas/admin-ops.md`.

```ts
// types.ts (client-safe): OPS_ERROR_KEYS, thresholds (PERF_THRESHOLDS, FREQUENT_LATE_MS, DAILY_LATE_MS, RUN_STUCK_MS, BULK_MAX 25, TELEMETRY_RETENTION_DAYS 90, TELEMETRY_RATE),
//   statuses + tones (jobs, runs, findings, incidents, errors, outbox), CHECK_META / isCostCheck / isWalletCheck / checkAreaOf, likePatterns(q) (as typed + Arabic-Indic/Persian digits as 0–9), parseJobListView ("all"|"attention"), Baghdad days and datetime-local (baghdadDateTime, toBaghdadInput),
//   URL state (parseRunFilters, parseFindingFilters / findingSearch, parseIncidentFilters / incidentSearch, parseErrorFilters / errorSearch, parseOutboxFilters, parsePerfFilters), view models
// shared.server.ts — opsAccess(actor) (incl. wallet: customers.wallet.read | finance.wallet.read) · hasAnyOpsPermission · staffHolding(db, permission, { branchOf? }) · employeeHolds · findingScope(actor) / findingBranchSql (branch limit of findings: a stock level by its location, an order/payment/refund by its order; limited employees see only their branch's) · cutProtected(value, { cost, profit }) · entityViews(db, actor, refs)   // labels + links only where the employee may open them
// job-monitor.server.ts — 23.03 (ops.job.read; run: ops.job.run)
jobsOverview(db, actor, now): { jobs: JobView[]; crons } · getJob(db, actor, job, now) · listRuns(db, actor, filters) · getRun(db, actor, runId) · jobPreview(db, actor, job, now)
runJobNow(db, actor, { job, reason, idempotencyKey }, now, env?): { runId; status; replayed }   // job_unknown, job_running, idempotency_mismatch (the key used for another job); the key's audit claim comes before the run
outboxOverview(db, actor) · listOutbox(db, actor, filters) · maskRecipient(recipient) · nextCronRun(cron, after) · cronPeriod · jobsNeedingAttention(jobs)
// consistency.server.ts — 23.06 (ops.consistency.read; changes ops.consistency.resolve)
listFindings(db, actor, filters) (view counts with the same filters) · getFinding(db, actor, id) (incidents only with ops.incident.read; run.href only with ops.job.read) · lastCheckRun(db) · findingCounts(db, actor) · withheldFor(checkKey, access)   // all within findingScope: out of reach = not_found
assignFindings(db, actor, { ids ≤ 25, assigneeId, dueDay?, note? }, now): { assigned; unchanged }   // assignee_invalid (also: limited to another branch), due_invalid, finding_not_open, finding_changed
closeFindings(db, actor, { ids ≤ 25, outcome: "resolved"|"false_positive", reason }, now): { closed; unchanged } · reopenFinding(db, actor, { id, reason }, now)
// incidents.server.ts — 23.05 (ops.incident.read; changes ops.incident.manage)
listIncidents(db, actor, filters, now) · getIncident(db, actor, ref, now) · incidentFormOptions(db, actor, now, prefill) (prefill only of kinds the employee reads) · incidentCounts(db, actor, now) · incidentsLinkedTo(db, kind, id) · incidentIdForPage(db, actor, ref, formIncidentId) · LINK_READ / linkableKinds(actor)
createIncident(db, actor, { title, severity, summary, impact?, ownerId, startedAt?, targetDay, links?, idempotencyKey }, now): { incidentId; ref; replayed }   // idempotency_mismatch: the key reused with another title/severity/owner; links need LINK_READ[kind] (forbidden)
addIncidentUpdate(…, { incidentId, note, status?, expectedStatus }) · resolveIncident(…, { incidentId, resolvedAt?, rootCause ≥ 20, note?, expectedStatus }) · reopenIncident(…, { incidentId, reason, targetDay })
changeIncidentOwner(…, { incidentId, ownerId, targetDay, reason }) · changeIncidentSeverity(…, { incidentId, severity, reason }) · editIncident(…, { incidentId, title, summary, impact?, rootCause?, expectedUpdatedAt, reason })
linkToIncident(…, { incidentId, kind: "finding"|"run"|"error", id, reason? }) · unlinkFromIncident(…, { incidentId, kind, id, reason })
// telemetry.server.ts — 23.01 23.02 (recording needs no actor: it is called by the app for itself; reading ops.error.read / ops.performance.read)
recordError(db, { source, level?, message, stack?, route?, url?, release?, sample? }, now): { recorded; id; fingerprint }   // one upsert, scrubbed, grouped; invalid input dropped
recordPerfSample(db, { area, route, kind: "server"|"load"|"nav", ms, status?, device? }, now): { recorded; metric }   // fast samples write nothing
purgeOpsTelemetry(db, now): { errors; perf }   // for the daily retention job; keeps an error report an incident is about · scrubText · pathOf · routeOf · deviceOf
listErrors(db, actor, filters, now) · getErrorReport(db, actor, id) · setErrorStatus(db, actor, { ids ≤ 25, status: "resolved"|"ignored"|"open", reason }, now) · errorCounts · performanceView(db, actor, filters, now) · perfCounts
// overview.server.ts — opsOverview(db, actor, now) · backupsMonitor(db, actor, now) (ops.backup.read) · opsQueueCounts(db, actor, now): { criticalFindings; failingJobs (→ /admin/ops/jobs?view=attention); overdueIncidents (every open incident past its date → ?view=overdue) }   // each null when it does not concern the employee
// routes (route-side, for the shell owner): opsTimingMiddleware (routes/admin/ops/observe.server.ts) · <OpsReporter /> (routes/admin/ops/components/Reporter.tsx) · POST /admin/ops/report
```
Errors (texts: `admin-ops` → `errors.*`): `OPS_ERROR_KEYS` — `reason_required`, `job_unknown`, `job_running`, `finding_changed`, `finding_not_open`, `finding_not_closed`, `assignee_invalid`, `due_invalid`, `incident_changed`, `incident_resolved`, `incident_not_resolved`, `owner_invalid`, `target_invalid`, `started_invalid`, `resolved_invalid`, `postmortem_required`, `link_invalid`, `link_exists`, `link_missing`, `error_changed`, `too_many`, `nothing_selected`, `no_change`.
