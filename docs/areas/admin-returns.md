# Admin 12 — Returns & Warranty

Owner: admin returns. Blueprint module 12 (P0), functions 12.01–12.07, the "game or device return" workflow (RMA →
policy check → approval → receipt and inspection → stock update → matching refund → warranty update). Arabic first,
English second. Code: `app/routes/admin/returns/**`, `app/server/services/admin/returns/**`, the core-level file
`app/server/services/returns/receive.server.ts`, strings `admin-returns`, tests `tests/admin-returns*.test.ts`.

## Routes

| Path | What | Permission |
|---|---|---|
| `/admin/returns` | queues (decide, receive, inspect, refund, refund approval, quarantine, late repairs, warranties ending — raised clay only where a person decides), RMA list: saved views (`?view=decide…flagged`), filters in the URL (q = RMA / order ref / full phone / name, status, reason, Baghdad dates), table ≥ 768, cards below, pages of 25; `<ModuleFunctions moduleId="12" />` | any returns.*; list: `returns.rma.read` (all) or `returns.rma.create` (own RMAs only) |
| `/admin/returns/new` | open an RMA for the customer: `?order=TT-…` (GET) → lines with returnable units, value, the rules' verdict; units by serial, sealed?, reason code + words, wanted resolution, contact phone, up to 8 private photos; outside the rules only with an approver's reason | `returns.rma.create` (+ `returns.rma.approve` to override) |
| `/admin/returns/:rma` | one RMA: units (verdict at the request, grade, decision, quarantine exit, refunded, warranty), inspection dialog, refunds with the two-person decision, photos, fraud signals explained, facts, internal notes, history (audit), next step + due time | read or own; each intent its permission (below) |
| `/admin/returns/:rma/print` | return slip: RMA as Code 128, order, customer, units, serials, inspection; browser print, always ink on paper (`data-theme="light"`) | read or own |
| `/admin/returns/policies` | eligibility rules (`?new=1`, `?edit=<id>` — URL state), the general window from settings | read: rma.read / rma.create / policy.manage; save: `returns.policy.manage` |
| `/admin/returns/quarantine` | units waiting to be refurbished / returned to the supplier, days waited vs SLA; back on sale, to the supplier, written off | `returns.rma.inspect` or `returns.supplier_return.manage` |
| `/admin/returns/repairs`, `/repairs/:ref` | repair tickets (storefront, assistant, shop, return) with SLA; counter intake; status workflow, diagnosis + quote, the customer's answer, parts, technician, due date, notes, photos | read: repair.manage / rma.read / warranty.read; changes: `returns.repair.manage` |
| `/admin/returns/warranties`, `/warranties/:id` | running / ending (30 d) / expired / void; search by order, serial, full phone; dates, the maker's warranty apart, service history, replaced parts, returns; extend / void | `returns.warranty.read`; changes `returns.warranty.manage` |
| `/admin/returns/files/:fileId` | a private photo (RMA, repair request), `private, no-store`, sandboxed; anything else the same 404 | as the record |

RMA page intents (`rma.server.ts`, permission checked before anything is read): decide (`returns.rma.approve`, never
the opener), transit (inspect | create), cancel / close (`returns.rma.approve`), note (create | inspect | approve), photo
(create | inspect; slot checked before storing; `RATE_LIMITS.upload` per employee), inspect (`returns.rma.inspect`),
refund (`orders.refund.create`), refund-decision (`orders.refund.approve`, never the requester), repair (`returns.repair.manage`).

## Functions → status

| Id | Status | Where / what is missing |
|---|---|---|
| 12.01 | implemented | `/admin/returns/new`, `/admin/returns/:rma`, print slip. Customers cannot open an RMA themselves yet (storefront account area sends them to support). |
| 12.02 | implemented | `/admin/returns/policies`: kind, category (+ subcategories), new/used, window (empty = setting `returns.window_days`), seal for change-of-mind, restocking fee ≤ 50 %. Most specific wins: category › kind › catch-all; ties by `sort`. The verdict per unit is stored in the RMA's creation audit event. |
| 12.03 | implemented | inspection dialog: scan the serial (a swapped unit is refused and recorded), grade, decision restock / refurbish / return_to_supplier / scrap / keep, location. A used device goes back to the devices team (status `returned`, module 13 re-inspects and lists it) or is written off — never into quarantine (`used_unit_decision`). |
| 12.04 | implemented | refund dialog: units that came back (a kept unit only after its repair failed), payment, amount ≤ value − the policy's restocking fee on a change of mind (refused above: `refund_exceeds_policy`; a waived fee is a goodwill refund on the order page), original / wallet (store credit) / cash, reference for transfers. |
| 12.05 | implemented | never twice (5 layers, below — also under a race) + 9 explained fraud rules, `?view=flagged`. |
| 12.06 | boundary | built; new products have no store warranty until the owner sets terms (`products.warranty_months`, STATUS item 15). Used units carry theirs. |
| 12.07 | partial | repairs + SLA + quarantine + return-to-supplier claims; missing: free replacement shipment (exchange = store credit + a new order), collecting repair charges, parts out of stock from the ticket, SLA targets as settings. |

## Invariants and how they hold

- **Goods only through the core.** Inspection calls `returnGoodsStatements` (planReturnedGoods: never more back than left,
  cost slices of the order's own sales, `order_item_serials.released_at` set; postReturnedGoods once per unit, key
  `return_item:<id>:goods`). Quarantine = a NON-sellable location; serial-tracked units wait as `returned` (never
  available, never packable). Exits: `exitQuarantine` (FIFO layers, guarded level, serial state, journal).
- **Money only through the core.** `createRefund` / `approveRefund`; the refund keeps its return (`refunds.return_id`,
  key `rma:<return id>:<form key>`, linked by `linkRefundStatements`).
- **Never twice for the same unit:** (1) a unit sits in one open/finished RMA (in-batch guard, a serial once);
  (2) only units that came back (inspected, not kept — a kept unit once its repair under the RMA was declared
  unrepairable), not refunded yet, amount ≤ their value − the restocking fee; (3) a guard appended to the core's OWN
  refund batch (`withBatchGuards` in refund.server): Σ units held by this RMA's refunds ≤ its inspected units per order
  line — two requests racing for one unit of a line bought ×2 both passed before (`refund_qty_exceeds` now);
  (4) createRefund: ≤ getRefundableAmount, units ≤ bought − refunded, idempotency key; (5) DB triggers.
- **Two people:** the employee who opened an RMA never decides it (`approver_is_requester`); a refund's requester never
  approves it (core). Queues never count one's own; a refund waiting for this employee is the page's next step.
- **Own RMAs only:** an employee who may only open RMAs (cashier) works on the ones they opened; in transit, notes and
  photos on anyone else's are the same `not_found` (404) as that RMA's page — the existence of an RMA never leaks.
- **Branches:** an employee limited to a branch inspects into, and takes out of quarantine from, that branch's
  locations only (403); restock "where it left from" needs a named location from them; the dialog and the quarantine
  list show their branch's locations and units.
- **What the page says about money:** units in a waiting refund are "awaiting approval", only issued ones "refunded";
  the RMA reads `refunded` once every unit that came back is paid (a partial refund keeps it in the refund queue); the
  history shows the core's `orders.refund.*` events once (this module's mirror events stay in the audit log).
- **Closing says what happened:** refund needs a paid refund; store credit / exchange a paid wallet refund
  (`no_store_credit_issued`); repair a finished repair of the RMA (`no_repair_done`); supplier return a unit set aside
  for its supplier (`no_supplier_unit`). A closed RMA takes no new refund. A repair handed back unrepairable never
  marks the RMA `repaired`.
- **Repairs:** "repairing" (from any status) and "ready" need an approved quote when one is set (not under warranty);
  a changed quote is approved again; the customer's answer is recorded on open tickets only.
- **Every change** is one guarded batch (status in the WHERE) with its audit event (actor, reason, before/after).
- **No cost data** leaves these services (no [P] column is selected for views); phones masked without
  `customer.phone.read_full`; partial-digit phone search needs it too.
- **Warranty update:** goods taken back void the unit's running warranty (`returned: RMA-…`); a kept unit keeps it —
  until its money goes back after a failed repair (`refunded: RMA-…`).

## Fraud rules (types.ts `FRAUD_THRESHOLDS`)

repeat_returner (≥ 3 RMAs / phone or customer / 90 d), high_value (≥ 1,000,000 IQD), quick_return (change of mind ≤ 24 h
after delivery), customer_flagged, earlier_refunds (outside this RMA), no_photos (defect or damage claim),
policy_override, serial_mismatch (recorded swap attempts), refund_method_differs (cash for a non-cash payment).

## SLA (types.ts `SLA`, constants until settings 22 owns them)

Decision 48 h · inspection 48 h after receipt · repair 7 days from receipt (`sla_due_at`, movable with a reason) ·
quarantine decision 14 days · warranties "ending soon" 30 days. Every timer shows the due time and "late since".

## Boundaries

- Store warranty terms: owner decision (above). The maker's warranty comes from the product's specs and is labelled.
- Repair charges: recorded (`cost_iqd`), not collected — no payment record for repairs (POS 06 / finance 10).
- Return to supplier needs suppliers (purchasing 09); with none the dialog says so (`no_suppliers`).
- Printing is the browser's; scanners are keyboard wedges (serial field).
- No SMS/WhatsApp: the customer is not notified of decisions (account page shows the RMA and the reject reason).

## Limits

- A line whose unit carries several serials (a bundle with two serial-tracked components) cannot be returned by serial
  (one serial per RMA line).
- Inventory adjustments of repair parts and quarantine exits outside this module do not update the RMA.
- A cycle count at a quarantine location expects `in_stock` serials (quarantined ones are `returned`).
- Sorani strings unreviewed; Chromium only.

## Verify

```
npx vitest run tests/admin-returns-receive.test.ts tests/admin-returns.test.ts tests/admin-returns-adversarial.test.ts   # 9 + 25 + 11
npx vitest run tests/i18n.test.ts -t admin-returns
node scripts/lint-design.mjs app/routes/admin/returns                              # 0 findings
node .shots/admin-returns/review/shots.mjs     # review screens: kept unit, refund + close dialogs, quarantine, cashier 404
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-returns/seed-returns.ts   # demo records (dev DB, idempotent)
node .shots/admin-returns/shots.mjs                                                # screenshots, .shots/admin-returns/
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-returns/seed-flow-order.ts && node .shots/admin-returns/flow.mjs
                                                   # the workflow by five roles in the browser (one new delivered order)
```

## Requests

- Shell: queues `returns.decide`, `returns.inspect`, `returns.refund_approval` (`queueCounts` in rma.server) → `/admin/returns?view=…`.
- Settings 22: keys for the SLA targets (types.ts `SLA`); returns refunds above `refunds.approval_threshold_iqd` already wait.
- Storefront account: a customer-side RMA form calling `openReturn` (with a customer actor variant) and the RMA timeline.
- Commerce core: a zero-price replacement shipment (exchange), a repair payment record, a repair-part consumption
  operation; `assignSerialsStatements` could also refuse serials at non-sellable locations (belt and braces).
- Catalog / owner: `products.warranty_months` per product once the store's terms are decided.
- Root (`app/root.tsx`): a 403 rendered by the root error boundary (role without the module, e.g. content on
  `/admin/returns`, `/admin/finance`, `/admin/purchasing`) logs a hydration warning — `<Links nonce>` is set on the
  server and `undefined` on the client.

## Review (adversarial, 2026-11-11)

Nine defects, each proved by a test in `tests/admin-returns-adversarial.test.ts` that failed on the built code: a
cashier changed other people's RMAs (IDOR); a kept unit was refundable (goods and money with the customer); two racing
refund requests refunded one unit twice; quoted repairs started (diagnosing / awaiting parts → repairing) or finished
(changed quote) without the customer's approval, and a closed ticket took a quote answer; an unrepairable device handed
back marked its RMA repaired; a branch-limited inspector moved goods at other branches; an RMA closed as store credit /
exchange / repair / supplier return when none happened, and a closed RMA still took refunds; a partial refund marked the
RMA refunded (it left the refund queue); the restocking fee was only a suggestion (12.04 "per policy"). Also: the note
form shows only to roles that may write notes; a return repair opens only while the RMA is received or inspected.

## Module follow-up 2026-11-12

`queueCounts(db, actor, now, { only? })`: only the counts asked for are queried (the SLA setting only for `warrantiesEnding`) — the bell needs `{ only: ["decide", "inspect"] }`. Spans of days are plural messages (`withinDays`, `policies.days`): the targets are settings (1–365 days).

Tests (each failed before its change): `tests/admin-returns-followup.test.ts`.
