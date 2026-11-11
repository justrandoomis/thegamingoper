# Admin 05 — Orders & Fulfillment (`/admin/orders/…`)

Owner: admin orders. Blueprint module 05 (05.01–05.09) and 04.11 pick-pack-ship. Everything that moves stock, money
or an order's status goes through the commerce core (CONTRACTS §1); this module never writes those columns itself.
The one new core-level file is `app/server/services/orders/edit.server.ts` (05.05, CONTRACTS §1).

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin/orders` | List: saved views, filters in the URL (text: reference / phone digits / name; status, payment status and method, governorate, Baghdad dates, flags late / suspicious / on hold / pre-order, packer), sort, 25 a page; table ≥ 768 px, cards below; selected rows → print invoices / packing slips / labels; CSV; queue cards; `<ModuleFunctions moduleId="05">` | `orders.order.read` |
| `/admin/orders/:ref` | The unified order page (05.02): next steps with their impact, items (cost and margin only for cost.read / profit.read), totals, payments and proofs, COD collection, refund requests and decisions, parcels and proof of delivery, stock holds, history (order events; the audit trail for `audit.read`), notification log, customer, address, assignment and tasks, review flags, pre-order, invoice, notes | `orders.order.read` |
| `/admin/orders/proofs` · `/admin/orders/proofs/:paymentId` | Transfer proofs awaiting a person (oldest first) · one proof, mobile-first: image, declared vs due vs received, duplicate warning, reject with reason / approve | `orders.payment.verify` |
| `/admin/orders/proofs/image/:proofId` | The proof image (private, `no-store`, sandboxed) | `payment_proof.read` |
| `/admin/orders/refunds` | Refunds awaiting a second person; requesters see only their own | `orders.refund.approve` or `.create` |
| `/admin/orders/fulfillment` | 05.03: mine / nobody's / colleagues'; assign a packer (task in `staff_tasks`) | `orders.fulfillment.pack` or `orders.order.assign` |
| `/admin/orders/:ref/pack` | 04.11 packing station: keyboard-wedge scan field, per-line progress, confirm by hand with a reason (non-serial units only), parcels (05.04), mark packed, hand to the courier | `orders.fulfillment.pack` (ship: `.ship`) |
| `/admin/orders/review` | 05.09: flagged orders with the sentence behind every flag, clear / hold, on-hold list, the rules | `orders.risk.review` |
| `/admin/orders/preorders` | 05.07: marked pre-orders and orders holding unreleased products, expected / release date, catalogue deposit | `orders.order.read` |
| `/admin/orders/print?kind=invoice\|packing\|label&id=…` | 05.06: documents for one order or a batch (≤ 50), print CSS; POST issues missing invoice numbers | `orders.document.print` |
| `/admin/orders/:ref/edit` | 05.05: quantities and address → preview (GET) → save with a reason (POST) | `orders.order.update` |
| `/admin/orders/export` · `/admin/orders/files/:fileId` | CSV of the filtered list (audited) · proof-of-delivery photo (private) | `orders.order.export` · `orders.order.read` |

Queue URLs for the shell (`shell/queues.server.ts`): proofs → `/admin/orders/proofs`, refunds → `/admin/orders/refunds`.

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Note |
|---|---|---|
| 05.01 | implemented | Nine statuses, moves only through `transitionOrder`; the dialog shows units, refunds, coupon and unpaid rows it changes; reason for cancel / return; a stale page (`from`) changes nothing |
| 05.02 | implemented | The order page above |
| 05.03 | implemented | Assignment + task list; serial scan before handover at the packing station |
| 05.04 | partial | Parcels with their own slips and labels, but they leave together (the core commits an order's stock in one step) |
| 05.05 | partial | Unpaid orders only for lines and totals; paid orders: address only (see "Requests"); an issued invoice freezes lines and total; a line never goes below the units scanned at the packing station |
| 05.06 | boundary | Printing complete; notifications written to the outbox and held (no SMS / WhatsApp provider) |
| 05.07 | partial | Expected date and delay updates; deposits shown, not taken |
| 05.08 | implemented | History with actor and reason, notification log (held = not sent), proof of delivery (photo of the signed slip + receiver's name) |
| 05.09 | implemented | 12 deterministic rules, clear / hold / flag with reasons; a flag never lifts a hold; the hold lives in this module, not the core |
| 04.11 | implemented | Scan-verified pick → pack → ship; bundles per component, a used device by its own serial; units without a serial confirmable by hand with a reason (audited) |

## Rules this module adds on top of the core

- **Hold** (05.09): an order `blocked` in review is not moved to confirmed / preparing / shipped / delivered and its
  proof is not approved (`order_on_hold`); cancelling stays possible. Enforced here, not in `transitionOrder`. Only a
  reviewer's **clear** lifts it: "flag" (ask for a review, also open to `orders.order.note`) is refused on a held order
  (`order_on_hold`) — it used to turn the hold into `needs_review`.
- **Scan-verified shipping** (04.11): `shipped` needs every unit verified — serials attached
  (`assignSerialsStatements`: right variant, not sold, not held elsewhere) and other units scanned by SKU / barcode or
  confirmed by hand with a reason (`packing_incomplete`). The core still checks serials and stock itself. Units are
  counted **per item**: a bundle is verified component by component (scanning one component again is `line_complete`,
  never a stand-in for another; a serial scan never counts as an unserialised unit), and a **used device's line takes
  only that unit's serial** (new stock of the same model shares the variant, and the core's statement would accept it).
- **Scans are written down**, accepted (`scan`, `scan_manual`) or refused (`scan_rejected` with the code and reason),
  as `shipment_events` of parcel `shp_<order>_1`; a client `scanId` makes a repeat a no-op.
- **After a status change** parcels follow (handed over / delivered / returned / cancelled), packing tasks close, and
  the customer gets a HELD message (dedupe key per status). These run after the core's batch, idempotent.
- **Risk rules** (`risk.server.ts`, thresholds in `types.ts`): proof waiting > 6 h, COD unconfirmed > 24 h, not shipped
  > 48 h after confirmation, not delivered > 5 days, pre-order date passed, duplicate proof, declared ≠ due, COD ≥
  1,500,000 IQD, ≥ 2 cancellations on the phone in the 90 days before, ≥ 3 open orders on the phone, customer fraud
  flag, ≥ 5 units on a line. Clearing stores the flags seen; a new flag brings the order back.
- **Invoices** are numbered once per order (`sequences.invoice` → `INV-000001`, gap-free, guarded in the batch) for
  confirmed / preparing / shipped / delivered / returned orders; `invoices.data` freezes the content (no cost). The
  batch issues only from the order row as it was read (`updated_at`, total): an order edited meanwhile is skipped. Once
  issued, the order's lines and total no longer change (`edit_invoiced`, below).
- **Labels** say "prepaid — collect nothing" only for an order paid in full; the unpaid cash on delivery is collected
  on parcel 1 (later parcels say so); an unpaid transfer or a cancelled / unconfirmed / returned order prints "not
  paid — do not hand over" and "do not ship" (labels and packing slips carry `shippable`).
- **Edits** (`orders/edit.server.ts`, 05.05): after the invoice, lines and total are frozen (`edit_invoiced`; the
  address may change while the total stays); a line never goes below the units already verified at the packing station
  (`edit_units_scanned`, `editLineFloors` for the form's steppers) — both re-checked inside the edit's batch. The phone
  may be left out of an address edit: the order keeps its number (the form leaves it empty for employees without
  `customer.phone.read_full`, who never receive it).
- **Margins**: a cancelled or returned order sold nothing, so it has no margin (page and CSV); before shipping the
  margin is the expected one from the cost snapshot.
- **Typed amounts** (COD, refunds, received transfer) accept Latin, Arabic-Indic and Persian (Kurdish keyboard)
  digits, on the server and in the dialogs (`parseIqd`), so "differs from what is due → reason" is decided alike.

## Permissions and field data

Every loader and action starts with `requireEmployee(ctx, db, …)`; every service `assertCan`s again. Cost / margin
fields are absent (not null) without `cost.read` / `profit.read` (margin needs both) — order page, CSV; print views
never carry cost. Phones are masked without `customer.phone.read_full` (lists, page, documents, CSV, **the edit
page**), and only holders of it may search by **some digits** of a number (otherwise a digits search confirms the
masked digits one query at a time); a whole number finds its orders for everyone. Proof images: `payment_proof.read`
only. The audit trail entries on the page: `audit.read`. Refunds: the requester never approves (`approver_is_requester`
from the core); the queue marks "yours". **Ids are scoped to the page's order**: a payment or refund id of another
order posted to `/admin/orders/:ref` is `not_found` (`verifyProof` / `decideRefund` take `{ orderId }`).

## Invariants (tested)

No order state, stock or money column is written by this module; every money / stock action is idempotent (core
replays, `idempotencyKey`, scan ids, edit event ids, outbox dedupe keys); every change writes an order event and an
audit event with actor and reason; refunds never exceed what is refundable; a serial is attached once.

## Boundaries (honest)

- Barcode / QR scanners: keyboard-wedge input (the scanner types, Enter submits) — no device integration needed.
- Printers: the browser prints (print CSS hides the admin chrome; one document per page; Code 128 on labels).
- SMS / WhatsApp: no provider — customer messages are written and held, shown as "not sent".
- Couriers: no carrier integration; a typed tracking number is optional. Waybills and carriers belong to module 11.

## Verify

```
npx vitest run tests/admin-orders.test.ts tests/admin-orders-edit.test.ts
node scripts/lint-design.mjs app/routes/admin/orders
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-orders/seed-orders.ts   (demo staff + orders in the local DB, through the services; idempotent)
node .shots/admin-orders/shots.mjs [name,…]   (screenshots in .shots/admin-orders/; signs in only the roles a shot needs —
                                             the dev server allows 20 admin sign-ins per address per clock quarter-hour, shared by every agent)
node .shots/admin-orders/review-shots.mjs [name,…]   (the adversarial review's checks: one owner sign-in, reads only)
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-orders/inspect.ts   (read-only list of the demo orders)
```

The admin runs in Arabic and English only (`tt_admin_locale=ckb` falls back to Arabic), so the Sorani strings of this
module are not visible in the admin yet and still need a native reader.

## Requests to other owners

- **Shell** (`shell/queues.server.ts`): proofs queue href `/admin/orders/proofs`, refunds `/admin/orders/refunds`.
- **Commerce core**: (1) a partial commit (ship some lines / parcels ahead of the rest) for 05.04; (2) a way to book a
  refund that reduces an order's price before delivery (not a sales refund in `postSale`) so paid orders can be edited
  (05.05); (3) deposits: a payment row smaller than the total at checkout (05.07); (4) the review hold inside
  `transitionOrder` / `verifyPayment`, so other modules cannot bypass it; (5) `assignSerialsStatements` accepts any
  in-stock serial of the variant for a **used-device line** (`freeForThisLine`) — it should accept only that unit's
  `used_units.serial_id` (this module refuses it at the packing station; another caller would not); (6) a credit note
  + re-invoice path, so an invoiced unpaid order could still be edited (05.05 refuses today: `edit_invoiced`).
- **Coupons owner**: export the coupon's own discount rule (eligibility + arithmetic without dates / usage), which
  `orders/edit.server.ts` replicates today.
- **Errors owner** (`app/i18n/messages/errors.ts`): the `edit_*` codes and `totals_changed` wording for edits (texts are
  in `admin-orders` meanwhile).
- **Shipping (11)**: carriers, waybills and courier status on the `shipments` rows this module creates
  (`shp_<order>_<n>`, scans in `shipment_events`).
