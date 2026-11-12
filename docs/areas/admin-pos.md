# Admin 06 — Point of sale

Owner: admin pos. In-store sales at a till (keyboard-wedge scanner, 80 mm receipts from the browser), shifts and the
cash drawer (float, pay-in / pay-out / drop, blind count, a second person approves a difference), mixed payment (cash,
card recorded from the bank's terminal, wallet), one stock with the website, sales linked to the buyer, serials and
warranties, prices and discounts limited by permission, and offline sales that sync without duplicates. Arabic first
(RTL), English second. Strings: `app/i18n/messages/admin-pos.ts`. Services: `app/server/services/admin/pos/*` (pure
rules in `types.ts`). New core file: `app/server/services/orders/pos-sale.server.ts`. Tests:
`tests/admin-pos-core.test.ts`, `tests/admin-pos.test.ts`, `tests/admin-pos-review.test.ts` (adversarial review
2026-11-11: 14 tests, each failed on the builder's code).

## Routes (`app/routes/admin/pos/routes.ts`; the layout loads the strings, the employee's shift and the review count)

| Path | What | Permission (loader / action) |
|---|---|---|
| `/admin/pos` | the employee's drawer (open the till, cash and count, or open a shift), shifts waiting for their review (raised card), today's sales for supervisors, registers and who works on them, what works and what does not, `<ModuleFunctions moduleId="06">` | any `pos.*` |
| `/admin/pos/sell` | the till: scan field (Enter), search by name, cart (qty, line discount, serial chips), buyer (account by phone or a kept phone), sale discount + reason, card amount + slip number, wallet, cash tendered with quick notes and change, one commit key; online / offline pill, saved-catalogue time, the device's queue (send now, conflicts, resolutions — dropping one is a supervisor's); the receipt printed IN PLACE (`receipt-paper.tsx`: hidden on screen, alone on paper — the admin answers X-Frame-Options: DENY, so no frame); sticky total bar on phones | `pos.sale.create` |
| `/admin/pos/shift` | open a shift (free register, float counted by note), pay in / pay out / drop to the safe (confirm with the drawer impact + reason), the hand moves, close with a BLIND count by note (refused on a device that still holds offline sales) | `pos.shift.open` · `pos.cash.move` · `pos.shift.close` |
| `/admin/pos/shifts` | shifts with state chips, register, Baghdad day and "mine" in the URL; table from 768 px, cards on phones; supervisors see counted / expected / difference | `pos.shift.review` (all) · `pos.shift.open/close` (own) |
| `/admin/pos/shifts/:shiftId` | the shift (Z) report on 80 mm paper: who and when, sales by method, discounts, cash moves, count by note, expected and difference (supervisors); the approval card (raised) with confirm + impact + reason | same / `pos.shift.review` |
| `/admin/pos/sales` | POS sales (orders of channel `pos`), filters in the URL (sale / receipt number, register, shift, method, day), day total for supervisors; receipt and order links | `pos.shift.review` (all) · `pos.receipt.reprint` / `pos.sale.create` (own shifts) |
| `/admin/pos/receipts/:ref` | the receipt (80 mm): number, Code 128 of the sale, lines, serials (inventory.serial.read), warranty, discounts, payments, tendered / change, masked phone; COPY / DEMO / REFUNDED marks; every print is a POST first (`printReceipt`): the first is the original, every later one a numbered, recorded COPY; the order link only with orders.order.read | `pos.receipt.reprint` · `pos.shift.review` (a copy: `pos.receipt.reprint`) |
| `/admin/pos/registers` | registers (store location, branch, on/off, open shift); add / edit in a dialog with a reason | any `pos.*` / `pos.register.manage` |
| `/admin/pos/api/:op` | JSON for the till: `lookup`, `search`, `catalog`, `customer` (GET); `sale`, `sync`, `print`, `discard` (POST; a body that is not a JSON object → 400) — `private, no-store`; field errors come back as sentences | `pos.sale.create` (+ `customers.customer.read` for `customer`; `pos.shift.review` for `discard`, checked before the body) |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Where / what is missing |
|---|---|---|
| 06.01 | implemented | `/admin/pos/sell`: keyboard-wedge scanner (SKU, barcode, extra barcodes, serial), receipts printed in place from the browser on 80 mm paper with a barcode; the first print is the original, later ones marked, numbered and recorded copies |
| 06.02 | implemented | `/admin/pos/shift`, `/shifts`: float, pay-in / pay-out / drop, blind count by note (a supervisor's own drawer too), difference approved by a second person and posted once to cash over/short, Z report |
| 06.03 | boundary | cash, wallet and mixed payments work; a card is charged on the bank's own terminal and recorded by its slip number (no terminal / gateway connected — a provider); the wallet is confirmed by the cashier, not by an SMS code (no SMS provider); its balance shows only with customers.wallet.read |
| 06.04 | implemented | the till sells the shop's units of the same `stock_levels` through the core (reserve → commit at the register's store location); the website's availability moves at once; units held for web orders are never sold at the till |
| 06.05 | implemented | buyer account (by phone) or a kept phone; serials scanned and assigned through the core (sold once); warranties start at the sale (one per serial) — new products carry a term only once the owner sets the store's terms (STATUS item 15); used devices their days |
| 06.06 | implemented | price lists for channel `pos` (branch, segments, quantity breaks: pricing 03 `resolveListPrice`); discounts with `pos.discount.apply` ≤ 10 % per line and per sale and never under the margin floor (a bundle without a cost of its own: its components' cost); beyond: `pricing.discount.override`; a reason always; the 10 % is a module constant until settings has a key |
| 06.07 | partial | an open till keeps selling offline from the device's catalogue; each sale keeps the key it got at "charge"; replays are recorded once; stock, prices and serials are confirmed on sync and conflicts wait for a person (accept the prices paid — override, offline sales only; record an oversell — oversell right; drop with a reason — a supervisor). Missing: no service worker caches the app (the page must be open before the connection drops); no wallet or used devices offline |

## Rules

- **A sale** is ONE batch in the core (`placePosSale`): order (channel `pos`, delivered, paid, register, shift, cashier,
  branch, device time), lines (snapshots, cost snapshot [P], warranty terms), stock reserved and committed at once at the
  register's store location and its bins (a scanned serial's unit from the serial's own location when it has it
  free, the rest most free first; `on_hand − reserved ≥ qty` guarded; FIFO layers consumed; a 'reserve' and 'sale'
  movements), serials (`assignSerialsStatements`, each in the store's tree), a used device
  (listed → reserved → sold), payments (`pos_cash`, `pos_card` with its slip, `wallet` with its ledger debit),
  the drawer's cash movement, warranties, the receipt (`RC-000001`, gap-free), the books (payment received, revenue,
  COGS), event and audit. The same key again returns the first sale (also two at once).
- **Prices** are the server's: the till sends what it showed; a difference → `price_changed` with today's prices.
  "Accept the prices paid" (override + reason) only for a sale queued OFFLINE — online a lower price is a discount.
  **Discounts:** `discountBeyondLimit` (`types.ts`, the same rule offline and on the server) and the floor
  (`priceForMargin(landed, min margin)` or the landed cost; a bundle without a cost row: Σ its components' landed
  cost; the cost never leaves the server).
- **Shifts:** one open per register (database) and per employee (guarded); opening re-checks inside its batch that
  the register is still on, at an active store location; expected cash = float + Σ cash movements, computed inside
  the closing UPDATE; the drawer's owner — a supervisor working a till included (`seesShiftFigures`) — never receives
  expected cash, cash sales, sales by method, discounts or the difference (results, report, list, the "sales of this
  shift" total, JSON). A difference is approved by `pos.shift.review`, never by who opened or closed the shift, bound
  to the figure the reviewer saw (`shift_changed`), with a note; the posting is keyed `pos_shift:<id>:variance`
  (short: Dr cash over/short / Cr cash). Pay-ins, pay-outs and drops are moves inside the "cash" account (no posting;
  spending is an expense in finance 10.05). Only a sale queued OFFLINE lands on a counted (not yet reviewed) shift
  and moves its expected cash and difference in its own batch; one rung up now is refused (`pos_shift_not_open`);
  after the review every sale is refused. A key that comes back with other figures (cash move, opening) →
  `idempotency_mismatch`.
- **Wallet** only for an account the cashier looked up (id), never for a typed phone, never offline; the balance
  reaches the till only with `customers.wallet.read` (module 07's rule; the server refuses more than the balance).
- **Receipts:** `printReceipt` records every print before the page prints: the first is the original (once, also for
  two at once), every later one a numbered copy (`pos.receipt.reprint`, which it needs). Ctrl+P is the browser's: a
  receipt whose original was printed always shows the COPY mark.
- **Dropping a queued sale** (`discardQueuedSale`): `pos.shift.review` and a reason; the trail keeps what the device
  held (SKUs, quantities, prices, payments, totals); a key the server recorded → `sale_recorded`.
- **Field rules:** no cost, landed cost or margin in any till, catalogue, receipt, list or report result; serials on
  receipts only with `inventory.serial.read`; phones masked; supervisors' figures absent (null) for the drawer owner.
- **Audit:** `pos.sale.create` (lines, discounts, payments, list prices, accepted prices, oversell), `pos.shift.open /
  close / variance / review`, `pos.cash.<kind>`, `pos.register.create / update`, `pos.receipt.print / reprint`,
  `pos.offline.discard`.

## Offline (06.07), honestly

Works: with the till open, a lost connection switches the pill to "offline"; scans and searches use the catalogue
snapshot kept on the device (prices, barcodes, the store's units; refreshed every 10 minutes and on reconnect; used for
24 hours at most); a charged sale is saved on the device with its key and a provisional note; on reconnect (or "send
now") queued sales replay through `/admin/pos/api/sync`; a lost response is safe (the key replays). Conflicts stay on
the device with their reason. Closing a shift on that device waits for its queue. Does not work: opening or reloading
the page offline (no service worker), the wallet, used devices, numbered receipts before the sync.

## Boundaries

- Scanner = keyboard wedge; printer = the browser's print (80 mm CSS); card = the bank's own terminal (slip number);
  no SMS code for wallet spending; no coupon codes at the till yet (promotions 08).
- Refunds of POS sales go through orders 05 / returns 12 (`createRefund`); cash paid back from a drawer is not yet a
  drawer movement (requested below).

## Requests to other owners

- **Spine / lead:** a service worker that caches the admin shell and `/admin/pos/sell` (offline open / reload).
- **Settings 22:** keys `pos.discount_limit_bps` (default 1000) and the catalogue's offline age.
- **Finance 10:** match `bank_card` statement lines to `pos_card` payments too (`METHOD_OF` in settlements.server.ts
  maps bank_card → bank_transfer only); show line discounts of POS orders (`order_items.discount_iqd`) in 10.04.
- **Returns 12 / orders 05:** when a cash refund of a POS sale is paid from a drawer, record a `cash_movements` row
  kind `refund` on the open shift (key `refund:<id>:drawer`) — a hook or a core statement builder is needed.
- **Pricing 03:** before relying on POS price lists, four eyes on list items under the floor (03's own note).
- **Admin shell:** a bell queue for shifts to review (`countReviewable(db, actor)` in `shifts.server.ts` →
  `/admin/pos/shifts?state=review`).
- **Staff 15:** an on-the-spot supervisor sign-off at the till (today a manager rings up a deep discount themselves).
- **UI kit:** hide toasts (`[data-toast]`) in `@media print` everywhere — a "sale recorded" toast printed over the
  receipt's number (the module now hides it on its own print pages).

## Known residual risks (review 2026-11-11)

- A drop / pay-out refused as `drawer_short` tells the drawer's owner that the drawer holds less than that amount:
  a probe of the expected cash is possible, at the price of recorded, audited moves in the Z report.
- A supervisor who takes over and counts someone else's drawer sees its expected cash (the take-over is a manager
  count); a late offline sale can move a counted difference to 0, and then nobody reviews the shift.
- Per-sale totals stay visible to the cashier (they rang them up): the blind count hides the sum, not the sales.
- A unit scanned from a location with no FREE units there still leaves from another location of the store (the web
  order holding that location's units keeps its count) — the per-location count can drift until a count corrects it.

## Verify

```
npx vitest run tests/admin-pos-core.test.ts tests/admin-pos.test.ts tests/admin-pos-review.test.ts   # 9 + 12 + 14
npx vitest run tests/i18n.test.ts -t admin-pos
node scripts/lint-design.mjs app/routes/admin/pos
node .shots/admin-pos/shots.mjs                       # builder's matrix, .shots/admin-pos/
node .shots/admin-pos/review/review.mjs [flows|queue|matrix]   # review: printing, blind count, wallet, queue
```

## Module follow-up 2026-11-12

A counted shift waits for a second person on a difference, a take-over count (counted by someone other than its owner) or a late offline sale — `shiftReviewReasons` / `SHIFT_REVIEW_REASONS` (types.ts), `ShiftView.reviewReasons` for those who see the figures; `reviewShift` approves one at 0 without posting. `moveCash` never refuses the drawer's owner for an amount (no probe of the blind count); `drawer_short` only for those who see the figures. Core `orders/pos-sale.server.ts`: a scanned serial's unit leaves ONLY from the serial's own location — held there for web orders → `insufficient_stock` (or an authorised oversell from that location); a serial in a location the till does not sell from → `serial_not_available`. A cash trade-in payout may come out of the payer's own open shift (admin 13 `payOut({ shiftId })`): a `pay_out` cash movement in the payout's batch.

Tests (each failed before its change): `tests/admin-pos-followup.test.ts`, `tests/admin-devices-followup.test.ts (the drawer payout)`.
