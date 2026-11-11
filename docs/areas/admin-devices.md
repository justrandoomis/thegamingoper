# Admin 13 — Devices, games & trade-in

Owner: admin devices. Blueprint module 13 (P0), functions 13.01–13.09, the "used-device trade-in" workflow (valuation →
inspection & ownership → offer → approval → receipt & data wipe → cost entry → relisting). Arabic first, English second.
Code: `app/routes/admin/devices/**`, `app/server/services/admin/devices/**`, strings `admin-devices`, tests
`tests/admin-devices*.test.ts`. The shopper's side of trade-in is the storefront used area's (`services/tradein.server.ts`).

## Routes

| Path | What | Permission |
|---|---|---|
| `/admin/devices` | what waits (raised clay only where a person decides), the 7-step workflow, sections, `<ModuleFunctions moduleId="13" />` | any devices.* |
| `/admin/devices/trade-ins` | requests (storefront + counter), views `?view=new…done`, filters q (TI-… / full phone / name; partial digits need read_full) · status · Baghdad days; table ≥ 768, cards below | tradein.read / inspect / offer / payout |
| `/admin/devices/trade-ins/new` | trade-in at the counter: phone (an account with it is linked), model OR SKU/barcode (games, accessories), notes, ownership declaration; idempotent form key | tradein.inspect |
| `/admin/devices/trade-ins/:ref` | the pipeline: steps, next step, appointment, inspection (checklist, grade, variant, serial scan, accessories, ownership, account lock, photos), guide valuation + store reference prices, price difference (`?target=` SKU/barcode/used slug, GET form), offer, in-person answer, wipe, payout, cancel, history | read; each intent its own (below) |
| `/admin/devices/trade-ins/:ref/print` | offer / valuation sheet the customer signs (grade, checklist, amount, validity, payout), browser print, ink on paper | read |
| `/admin/devices/used`, `/used/:id` | units intake → sold with the evidence each lacks; unit page: readiness + list/unlist, checklist, grading (notes ar/en/ckb, defects, included, warranty days), photos (real/illustration, published), ownership/wipe, re-inspection of a returned unit, price (pricing 03's `setUsedUnitPrice`), game facts, history | registry.read or used.* or ownership.verify; acquisition cost cost.read; margin + profit.read |
| `/admin/devices/registry`, `/registry/:serialId` | serials by condition, source (receipt/PO/supplier, trade-in, demo opening), status, location, order; detail: orders, trade-ins, warranties, movements (inventory.movement.read) | registry.read; cost cost.read |
| `/admin/devices/digital`, `/digital/:variantId` | delivery classes, conflicting catalogue facts, code stock; a variant's codes: import, reveal, revoke | any devices.*; codes: digital_code.manage (reveal + digital_code.reveal) |
| `/admin/devices/templates` | checklists per kind, `?kind=` editor (new version on save) | read any devices.*; save inspection_template.manage |
| `/admin/devices/guides` | price guides, `?edit=<id>` / `?new=1` | read price_guide.manage or tradein.*; save price_guide.manage |
| `/admin/devices/files/:fileId` | a private photo (trade-in: shopper's / inspector's; used unit) — anything else, and public files, the same 404 | the record's readers |

Trade-in intents (`trade-in.server.ts`, permission checked at the route before anything is read, again in the service):
schedule / inspect / photo `devices.tradein.inspect` (confirming ownership / the lock at inspect + `devices.ownership.verify`); offer / answer `devices.tradein.offer`; wipe
`devices.ownership.verify`; payout `devices.tradein.payout`; cancel offer, or inspect before an offer. Unit intents
(`used-unit.server.ts`): checklist / reinspect `devices.used.inspect`; grade / photo-real / photo-remove `devices.used.grade`;
photo inspect | grade; checks `devices.ownership.verify`; list / unlist `devices.used.list`; price `pricing.used.update`.

## Functions → status

| Id | Status | Where / what is missing |
|---|---|---|
| 13.01 | implemented | `/admin/devices/registry` |
| 13.02 | implemented | `/admin/devices/templates`; checklists on trade-ins and units |
| 13.03 | implemented | `/admin/devices/guides`, valuation on the trade-in page (no external market feed: staff enter the reference price) |
| 13.04 | partial | offer + validity + price difference + store credit + printed offer; missing: trade-in value as part payment of a purchase (no split tender at checkout, POS 06), the expiry job not scheduled |
| 13.05 | implemented | games checklist + counter trade-in by SKU + region / platform / format / compatibility on the unit |
| 13.06 | implemented | `/admin/devices/digital` (facts edited in the catalogue, module 02) |
| 13.07 | partial | encrypted codes, reveal only once delivered on a paid line, revoke; missing: delivering a code to its buyer after payment (commerce core), so no code is revealable yet |
| 13.08 | implemented | ownership + account lock at inspection (devices.ownership.verify), wipe before payout, re-wipe after a return |
| 13.09 | partial | grading, real photos, published on listing, in-person approval on the signed offer; missing: the storefront tracking page does not show the grade/checklist the offer was made on |

## Invariants and how they hold

- **An estimate is never an offer.** `makeOffer` needs an inspection with a complete checklist, a grade, the catalogue
  variant, the serial (serial-tracked), ownership AND a free account lock; the database refuses an offer without
  offered_by / offered_at / inspection. An open offer never changes (`offer_open`); expired/declined ones are replaced,
  both kept in `trade_in_events`.
- **Money through the core, once, with the device or not at all.** Store credit: the wallet core's
  `walletCreditStatement` kind `trade_in_credit`, key `tradein:<id>:payout`, + `postWalletCredit` (Dr inventory / Cr
  wallet liability, the `customers.wallet.credit` audit); cash: one `journalStatements` entry Dr inventory / Cr cash,
  key `trade_in:<id>:payout` — the money in ONE batch with: trade-in → paid (guarded on accepted, amount, wipe), the
  registry serial (new, or a sold one bought back: its open `order_item_serials` link released, its active warranty
  `void` "traded_in:<ref>"), the used unit (acquisition cost [P] = offer, grade, checklist, ownership/wipe facts, price
  0; status by the units' rule — a failed critical item is "testing", not "ready"), the inspection photos as
  unconfirmed media, the `paid` event, audit. A payout that loses a race (a second payout, a cancel, the serial entering
  stock) moves no money; a repeat answers `replayed` with the method really paid; a credit left by an older half-done
  payout is completed, never paid twice (cash is then refused, `payout_started`); a cancel is refused once a payout
  key exists (checked in its batch).
- **Four eyes on exceptions:** an offer above the guide's suggestion, without a guide, or on a guide last changed by
  the employee who makes the offer is paid out by someone other than that employee (`payout_second_person`, 403). The
  `offered` event keeps the suggestion and the guide's author (`guideBy`) it was made on; the offer dialog warns.
- **13.08 ownership is its own right:** at the inspection, confirming ownership / a free account lock needs
  `devices.ownership.verify` (403 otherwise; an inspector without it sees them read-only and leaves what is on file); a
  confirmation holds for that serial only (another serial clears it) and keeps who confirmed it.
- **Checklists on the current version:** a new checklist (trade-in or unit) on a switched-off template version is a
  stale page (`templateId: template_changed`); a filled checklist keeps the version it was filled with.
- **Evidence before sale:** a unit is listed only from `ready` (checklist complete, no critical failure, grade, ownership,
  wipe) with a price, Arabic condition words and ≥ 1 photo a person confirmed shows THIS unit; real photos are published
  first (reverted if the batch fails); its serial becomes sellable in the same batch. The database's trigger is the
  backstop for real units and keeps a listed unit's last real photo. A photo taken off a unit is deleted (its own
  upload) or made private again (a trade-in's inspection photo); a "real" mark that fails is unpublished again.
- **Codes:** encrypted with context `digital_code:<id>`, sha256 over the normalized text for duplicates, no plain text in
  lists or audit, reveal limited (20 / 10 min / employee) and ONLY for a code delivered on a paid, not fully refunded
  order line (`codePaidFor`) — never unsold stock, never an unpaid order (13.07 "never revealed before payment").
- Every change is one guarded batch (status / updated_at in the WHERE) with its audit event; phones masked without
  `customer.phone.read_full`; serials only for registry / inspection / ownership staff; [P] fields absent, never 0.
  The in-person answer sent twice is answered once (`replayed`). Every queue count is exactly its card's list: the
  trade-in views and their counts share `viewWhere` ("new" = still to inspect, booked or not; "inspected" = no open
  offer, an offer past its date included; "offered" = still open), and the units counts what a branch-limited
  employee's own list shows (`unitBranchWhere`).

## History the tracking page reads

`inspection_scheduled` {at} · `inspected` {grade, passed, failed} · `offered` {amountIqd, expiresAt, grade, suggestedIqd}
· `accepted` / `declined` {inPerson: true} · `paid` {payout, amountIqd} · `cancelled` {reason} · `expired`; staff-only:
`data_wiped`, `photo`.

## Boundaries

- Printing is the browser's; scanners are keyboard wedges (serial, SKU, barcode fields). No SMS: the customer is not
  notified; the printed offer names the tracking page. No external market-price source.
- A cash payout is booked to `cash` but not counted in a POS shift (module 06).

## Requests

- Shell: queues from `deviceQueueCounts` (tradein.inspect → `/admin/devices/trade-ins?view=new`; tradein.offer →
  `?view=inspected`; tradein.payout | ownership.verify → `?view=accepted`; used.inspect → `/admin/devices/used?view=todo`;
  used.list → `?view=ready`).
- Jobs: run `expireTradeInOffers(db, now)` daily (offered past `offer_expires_at` → expired + event).
- Storefront used: show the `offered` event's grade and checklist result on `/trade-in/:ref` before "accept".
- Commerce core: assign a `digital_codes` row to a paid digital order line and show it to the buyer; part payment from
  the wallet (split tender); POS 06: count trade-in cash payouts in the shift; a core op for releasing a sold serial on
  re-acquisition (done here in the payout batch today).

## Verify

```
npx vitest run tests/admin-devices.test.ts tests/admin-devices-units.test.ts tests/admin-devices-review.test.ts  # 17 + 11 + 13
npx vitest run tests/i18n.test.ts                                                  # every namespace, ar/en/ckb parity
node scripts/lint-design.mjs app/routes/admin/devices                              # 0 findings
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-devices/seed-devices.ts    # demo records (dev DB, idempotent)
node .shots/admin-devices/shots.mjs                                                 # screenshots .shots/admin-devices/
node .shots/admin-devices/flow.mjs [TI-…]                                          # the workflow in the browser (a ref resumes one)
```
