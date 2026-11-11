# Admin 11 — Shipping & Delivery (`/admin/shipping/…`)

Owner: admin shipping. Blueprint module 11 (11.01–11.06). Parcels are the `shipments` rows the orders module (05)
creates at its packing station (`shp_<order>_<n>`, scans in `shipment_events`); this module adds the waybill and
follows them to the door and back. Anything that moves an order, stock or money goes through the orders module's
`changeOrderStatus` (hold and scan-verified packing rules) or the commerce core — including the one new core-level
file `app/server/services/orders/shipments.server.ts` (CONTRACTS §1).

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin/shipping` | What waits for a person (raised cards: failed deliveries, parcels coming back, settlements to reconcile — only those this employee may decide —, sensitive parcels without a packing photo), figures, the fee in force, honest boundaries, `<ModuleFunctions moduleId="11">` | signed in (each block by its permission) |
| `/admin/shipping/shipments` | Parcels: saved views, filters in the URL (status / group, carrier, governorate, flag, sort; 25 a page), scan field (waybill code, tracking number, order ref), table ≥ 768 px / cards; bulk: cheapest carrier by rule, hand over, in transit, out for delivery, print waybills / manifest | `shipping.shipment.read` |
| `/admin/shipping/shipments/:shipmentId` | One parcel: next steps (pickup blocked with its reason), waybill form with carriers ranked by cost, contents (serials with `inventory.serial.read`), packing photos, proof of receipt, tries, timeline, cash and settlement, delivery margin (`profit.read`), recipient (phone masked without `customer.phone.read_full`), other parcels | `shipping.shipment.read` |
| `/admin/shipping/print?kind=waybill\|manifest&id=…` | Waybills (Code 128 of `REF-n`, carrier, tracking, sender, recipient, cash box, contents, fragile note, two signature boxes) and pickup manifests per carrier; print CSS, prints light from a dark screen | `shipping.shipment.read` |
| `/admin/shipping/attempts` | Failed deliveries and parcels coming back, oldest first, mobile-first: call link, tries, next day, retry / send back / receive | `shipping.shipment.read` (actions `shipping.attempt.manage`) |
| `/admin/shipping/zones` · `/zones/:governorateId` | Flat fee, per-governorate fee switch, all-governorates override (each with the governorates whose fee changes shown first); governorates: availability, fee, override + history, estimate, districts (add, rename, switch off), carriers' rates there | signed in; writes per permission |
| `/admin/shipping/carriers` · `/carriers/:carrierId` | Carriers (in-house / third party, phone, tracking page template, cash collection and its fee), on/off with impact, rates per governorate × level with estimates (one rate → many governorates) | signed in; writes `shipping.carrier.manage` |
| `/admin/shipping/cod` · `/cod/new` · `/cod/:settlementId` | Backlog per carrier (parcels not settled, cash held), settlements by status; a draft from the carrier's statement; correct, submit, reconcile, dispute, reopen, discard, statement photo, history | `shipping.cod.settle` |
| `/admin/shipping/files/:fileId` | Private files: packing photos, proofs (`shipping.shipment.read`), statements (`shipping.cod.settle`) | as stated |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Note |
|---|---|---|
| 11.01 | implemented | Fees through `setSetting` (reason, audit); overrides never deleted (new row, old deactivated); estimates are estimates (checkout does not show them yet) |
| 11.02 | implemented | Ranked by rate + cash fee; rule = cheapest eligible (cash parcels only with cash-collecting carriers). Courier API: boundary |
| 11.03 | implemented | Waybill number `REF-n` (or the carrier's number); statuses typed or scanned; pickup ships the order via the orders module |
| 11.04 | implemented | Two-person rule for a difference or a hand correction; cash recorded through `recordCodCollection`; posting to cash/bank, shipping costs, cash over/short |
| 11.05 | partial | Missing: an order whose parcels split (one delivered, one back) cannot be closed here — no partial return in the core |
| 11.06 | implemented | Packing photo required before this module's pickup of a sensitive parcel; receiver's name required at its delivery (the orders module's own handover and "delivered" step do not check them yet — requested) |

"Sensitive" = a console, a serial-tracked unit (also inside a bundle) or a used device (`sensitiveSql`).

## Rules this module adds

- **Waybill**: carrier active; a parcel that collects cash only with a carrier that collects cash (`carrier_no_cod`); the
  same tracking number twice for one carrier is refused; on the road a change of carrier or number needs a reason.
  Service level lives in the `waybill` event (no column). `cod_amount_iqd` = the pending cash-on-delivery payment, on
  the order's first live parcel (the orders module's labels say the same).
- **Pickup**: every live parcel of the order needs a waybill, a sensitive parcel its packing photo; then
  `changeOrderStatus(→ shipped)` (hold + packing verification), parcels handed over together.
- **Delivered**: `deliverParcel` (core); the last undelivered parcel moves the order to delivered first (warranties,
  `postSale`, `postCogs`); an order on hold is refused (`order_on_hold`), an order taken back meanwhile too
  (`order_not_shipped`, checked in the batch). Two parcels delivered at once deliver the order once.
- **Back at the store**: `returnParcels` (core) with restock / scrap per line; the parcels on the road become
  `returning` first (guarded batch), then the order is returned; refused when a parcel was delivered.
- **Settlements**: draft → submitted (amount received, negative = store paid the carrier; a difference needs a note)
  → reconciled (core) or disputed → reopened / discarded. A hand correction of a parcel (cash ≠ due, or a charge ≠ the
  carrier's rate + cash fee, `suggestedCharge`) needs a reason. **Two people** whenever the books take a difference —
  variance ≠ 0 OR any hand correction (audit action `shipping.cod.item`): the reconciler is nobody who created,
  corrected or submitted it, and gives a reason (`settlement_self_reconcile`, `variance_note_required`); an untouched
  settlement may be reconciled by its preparer. A cash amount ≠ due needs `orders.payment.override` (the core's rule).
  Posting key `cod_settlement:<id>`; parcels get `cod_settled_at` and their actual charge in `shipments.cost_iqd`. Demo
  and real orders never share a settlement.
- Typed amounts and days accept Arabic-Indic and Persian digits (`parseIqd`, `digitsOnly`).

## Permissions and field data

Every loader/action: `requireEmployee` (the parcel page's action: `shipping.shipment.read`); every service: `assertCan`;
the permission is checked before the input is read (403, never a field error). Pages whose service refuses throw
through `throwAsResponse` (403, not 500). Carrier rates and charges are cost data, sent only to who chooses carriers,
manages or settles with them, or has `cost.read` (`canSeeCarrierCost`: `shipping.shipment.create`, `.carrier.manage`,
`.cod.settle`, `cost.read`) — absent from page data, `.data` JSON and parcel history for support / stock roles (their
carrier page shows coverage and estimates, listed by name). The delivery margin (fee charged − carrier cost) only with
`profit.read` (absent, not null). Phones masked without `customer.phone.read_full` (page, queue, waybills: "number
hidden" printed). Serials only with `inventory.serial.read`. Uploads authorized, counted (`RATE_LIMITS.upload` per
employee) and checked against the state (`assertDeliverable`, `assertStatementOpen`) before anything is stored; files
private, served with `fileResponse`.

## Invariants (tested)

No stock, payment or order-status column is written by this module (core / orders module only); every change writes a
shipment event and an audit event; deterministic event ids (`sev_<id>_delivered`, `_handover`, `_returned`,
`_attempt_<n>`, `_cod_settled`) shared with the orders module, so retries never duplicate; settlement posting balanced
for every sign; one posting per settlement even under a race; fee shown = `getShippingFee`. Races (the competing write
lands just before the batch): a return first takes the parcels off the road (`returning`, guarded: no parcel
delivered), a delivery's batch requires the order still shipped/delivered — a parcel is never delivered on an order
taken back, nor goods restocked while the customer has them; a tracking number is unique per carrier inside the batch;
an override change refuses a fee changed meanwhile (`fee_changed`). A bulk retry checks `shipping.attempt.manage`
before the first parcel moves. Typed amounts keep a decimal mark (refused, never ×10); the cash fee % reads `١٫٥`.
The pickup manifest prints a parcel that must not leave as such, outside the totals; the bulk handover is confirmed with
its impact (parcels, orders, stock, cash).

## Boundaries (honest)

- Couriers: no API — carriers are records; pickups booked by phone or portal; statuses typed or scanned (keyboard wedge).
- Printers: browser print (print CSS, Code 128). SMS/WhatsApp: delivered/returned messages written to the outbox, held.

## Verify

```
npx vitest run tests/admin-shipping.test.ts tests/admin-shipping-core.test.ts tests/admin-shipping-review.test.ts   # 14 + 7 + 13
node scripts/lint-design.mjs app/routes/admin/shipping                          # 0 findings
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-shipping/review/seed.ts # review: a demo support employee, a corrected and a draft settlement
node .shots/admin-shipping/review/shots.mjs     # review screens (support role without carrier cost, manifest, bulk handover, corrections)
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-shipping/seed.ts       # demo carriers, 12 demo orders through the flow, staff
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-shipping/inspect.ts    # ids for the browser scripts (read-only)
node .shots/admin-shipping/shots.mjs [name,…]   # 390/1440 × light/dark × ar/en; sessions reused (.sessions.json)
node .shots/admin-shipping/act.mjs              # real clicks: waybill → pickup dialog → retry from the queue
```

## Requests to other owners

- **Orders (05)**: call the same pickup checks before its packing-station "hand over" (a sensitive parcel without a
  packing photo, a parcel without a waybill) — `pickupParcels` refuses them, the pack page's `ship` intent
  (`changeOrderStatus → shipped`) does not; its "delivered" step should ask the receiver's name for a sensitive device
  (or deliver through `deliverParcel`); its shipped → returned follow-up should take the parcels off the road first,
  as `returnParcels` does (a delivery racing it can still land between its read and its batch); and set
  `shipments.location_id` at packing — parcels carry no location today, so a branch-limited employee cannot be kept to
  their branch's parcels here.
- **Settings (core)**: an `expected` option on `setSetting` checked inside its batch — two people changing the flat
  fee at the same moment still overwrite each other (each saw the same old fee; both are audited).
- **Commerce core**: a partial return of a shipped order (one parcel delivered, another back) for 11.05.
- **Accounting / data**: a system account "cash held by couriers" (`carrier_receivable`), so collected cash is not in
  `cash` until the carrier remits; postings would then use it (`postCodSettlement`).
- **Checkout**: show `governorates.eta_days_min/max` as "usually N–M days — we call to confirm" (never a promise).
- **Shell** (`queues.server.ts`): a queue for failed deliveries → `/admin/shipping/attempts` and settlements to
  reconcile (not one the employee created, corrected or submitted when it has a difference or a correction —
  `settlementNeedsSecondPerson`) → `/admin/shipping/cod?status=submitted`.
- **Errors owner**: adopt this module's codes from `admin-shipping` → `errors.*`.
- **Finance (10)**: 10.02 can list `cod_settlements` through `listSettlements` / `getSettlement` (CONTRACTS §4).
