# Admin 09 — Suppliers and purchasing

Owner: admin purchasing. Suppliers, requests for quotation, purchase orders with the spending limit and four eyes,
receiving against orders (through the stock core, posted to the books through the core), landed costs (through pricing's
allocation), supplier invoices and the three-way match, claims and returns to the supplier, variance alerts and the
supplier rating. Arabic first (RTL), English second. Strings: `app/i18n/messages/admin-purchasing.ts` (side-by-side
triples, so ar/en/ckb keys never drift). Services: `app/server/services/admin/purchasing/*` (pure rules in `rules.ts`).
Tests: `tests/admin-purchasing.test.ts`.

## Routes (`app/routes/admin/purchasing/routes.ts`; `layout.tsx` loads the strings, the section tabs and an in-shell error boundary)

| Path | What | Permission (loader / action) |
|---|---|---|
| `/admin/purchasing` | What waits (raised cards: approvals not mine, stopped postings, draft receipts, invoice variances, late orders, open claims, alerts), figures (open orders, units incoming, receipts this month, open value for cost.read), quick actions, latest receipts, `<ModuleFunctions moduleId="09">` | any purchasing permission |
| `/suppliers`, `/suppliers/:id` | List (search, status chips, sort incl. rating — URL state; cards on phones) and new profile; profile (code, names, country, currency, terms, lead time, phone, email, address), contacts (one primary), status with a reason, the rating explained, staff reviews, recent orders, history | `supplier.read` / `supplier.manage` (`supplier.rate` for reviews) |
| `/rfqs`, `/rfqs/:id` | Requests (SKU rows typed or scanned); quotes per supplier (unit price, quantity available, lead time, warranty, validity), comparison cards + per-SKU matrix (IQD at the store's rate; cheapest complete / fastest / longest warranty marked), award → draft PO | `rfq.manage` (+ cost.read for prices; + `po.create` to award) |
| `/orders` | Saved views (open, awaiting approval, drafts, late, received, closed, all), search, supplier, sort, page in the URL; bulk "mark as sent"; amounts only for cost.read | `po.read` / `po.create` |
| `/orders/new`, `/orders/:id/edit` | Draft form: supplier, delivery location (branch-limited), currency + dated rate (store USD rate suggested), expected day, terms, line rows (SKU/barcode, qty, unit cost — Enter jumps fields for scanners), shipping/other; running total says whether a second person will be needed | `po.create` + cost.read |
| `/orders/:id` | Approval card first (requester, total vs limit; approve = commit key, reject with reason — the requester/creator only sees who must decide), next steps (submit, send, receive, invoice, claim, close, cancel — each a dialog with its impact), lines (ordered / received / in unposted receipts / invoiced / outstanding, [P] unit cost), receipts, invoices, claims, approval history, audit history | `po.read` / per intent `po.create`, `po.approve` |
| `/orders/:id/print` | The order as a document (logo, parties, terms, lines, totals, signatures) printed by the browser; a goods list without prices for roles without cost.read | `po.read` |
| `/orders/:id/receive` | Count per line: received, refused at inspection + reason, one serial per accepted unit (scanner, one per line), delivery note, arrival day → DRAFT receipt | `receipt.create` |
| `/orders/:id/invoice` | Record the supplier's invoice per order line (prefilled: received − billed, order price), rate, charges → matched at once | `invoice.manage` + cost.read |
| `/receipts`, `/receipts/:id` | States (open, draft, posting, posted, cancelled); one receipt: lines, landed-cost bills (add + spread by value / qty / weight, spread, remove — pricing's functions; manual split links to `/admin/pricing/landed/:id`), post / resume (commit, impact: units, value, Dr inventory / Cr AP), cancel, claim for refused units | `po.read` or `receipt.create` / `receipt.create`; landed: cost.read + `landed_cost.allocate` |
| `/invoices`, `/invoices/:id` | Open / variances / matched / approved / void; three-way table, every variance in words, approve (variances: reason + not the recorder), re-match, void | `invoice.manage` + cost.read |
| `/claims`, `/claims/:id` | New claim (from `?receipt=` refused units, `?po=` missing units, or a supplier), list; one claim: lines (refused at inspection / from stock), [P] amount, transitions, goods back to the supplier from a chosen location with a reason (refused units without a stock movement) | `claim.manage` (+ `inventory.stock.adjust` to return goods) |
| `/alerts` | Variance alerts, mobile-first cards with the next step (open invoice / receipt / order, open a claim) | `po.read`, `invoice.manage` or `claim.manage` |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Where / what is missing |
|---|---|---|
| 09.01 | implemented | `/suppliers`: profile, currency, terms, lead time, contacts, quality = computed rating + staff reviews |
| 09.02 | implemented | `/rfqs`: quotes compared on price (IQD), lead time, warranty, coverage, validity; award → draft PO. Sending the request happens outside the system (no messaging provider) and is recorded as "sent" |
| 09.03 | partial | `/orders`: drafts, submit, four eyes above the limit (rate- and split-proof, see below), history. The limit is ONE store-wide constant (`PO_SPENDING_LIMIT_IQD` = 1,000,000 IQD) until settings (22) has the key; per-role limits need approval chains (15.06) |
| 09.04 | implemented | partial receipts with inspection and serials, posted through `receiveStock` + `postStockReceipt`; invoices matched to order and receipts (units, unit prices, charges). Paying invoices and posting price/FX differences are finance's (10); no invoice image upload |
| 09.05 | partial | bills spread on draft receipts through pricing (`addLandedCost` / `allocateLandedCost`), carried into the FIFO layers. A bill that arrives after posting needs a core layer revaluation (requested, as in 03.02) |
| 09.06 | partial | claims with transitions; goods back with a reason: refused units without a movement, the rest through `adjustStock`, bounded by the receipt / order. Serial-tracked units in stock cannot leave (no single-serial core operation); returns are not posted to the books |
| 09.07 | implemented | `/alerts` + home cards: invoice qty / price / charges, refused units, over-received, closed short, late. The shell's bell does not count them (requested) |
| 09.08 | implemented | rating = 60 % on time + 40 % (1 − defect rate), last 365 days, ≥ 3 posted receipts, explained on the profile; units never delivered on orders closed short after their day count as not on time |

## Invariants and writes

- Stock, money and order state only through the core: `receiveStock` (ref `{ type: "receipt_item", id }`, landed unit
  cost, serials), `adjustStock` (returns), `postStockReceipt` (key `receipt:<id>:receipt`, demo flag from the order).
  The module writes its own tables (suppliers, contacts, rfqs, quotes, purchase orders, po_items, receipts,
  receipt_items, supplier invoices, claims) and `approvals` rows (kind `purchase_order`).
- Posting a receipt: claim (draft → posted with a `posting:<token>` lease in `received_by`, guarded on the order being
  open and no unspread bill) → one `receiveStock` per accepted line (a line whose 'receive' movement exists is skipped;
  the lease is checked before each) → finish batch (lease swapped for the poster exactly once, `po_items.qty_received`,
  order status, open invoices re-matched, journal, audit). Stopped postings resume after 5 minutes; if nothing moved the
  receipt goes back to draft. Tests: double post, two posters at once, a crash resumed.
- Idempotency: creations take a form key (ids derived from employee + key: double submits return the first record);
  transitions are guarded updates (a repeat answers `replayed`); edits carry `updated_at` (`po_changed`,
  `supplier_changed`). Returns mark the claim's lines with a compare-and-set before stock moves (once, resumable).
- Four eyes: an order above the limit is approved by someone holding `po.approve` who did not create, edit or submit it
  (audit events `purchasing.po.create|update|submit`); the decision carries the approval id the page showed (a newer
  request → `po_changed`); a supplier no longer active is not approved. The order weighs its total at the HIGHER of
  its own rate and the store's rate of the day, plus what the same person approved alone for the same supplier in the
  last `SPLIT_WINDOW_DAYS` = 7 (the write re-checks that window) — a low typed rate or a split order still meets a
  second person. Invoice variances are accepted with a reason by someone other than the recorder (`approver_is_requester`).
- Races closed in the write batch: two drafts at once cannot over-receive a line (guard per line); a landed bill
  spread while a receipt is being posted reaches the layers (lines are read again after the claim).
- Three-way match: units (billed on all live invoices vs received), unit price, and charges — shipping + other billed on
  the order's live invoices above the order's (`field: "charges"`, stored in the same JSON column; an invoice of
  charges alone is allowed). An order with a live (not void) invoice is not cancelled (`po_has_invoices`).
- Claims: a claim tied to a receipt carries the receipt's refused units first (`refused` on its lines, set when it is
  made); they go back without a stock movement. From stock, a claim goes back with a reason and at most what its
  receipt / order put into stock less what other claims returned (`return_exceeds_received`).
- Amounts too big to be exact (orders, invoices, quotes, claims) are field errors (`too_big`), never a 500.
- Cost privacy: prices, totals, rates, landed costs, claim amounts and the open-order value are absent (not blank) from
  loader data, lists, the print document and alerts without cost.read (tests check JSON and loaders).
- Branch limits: an employee with a branch sees and acts on orders, receipts, invoices and claims of their branch's
  locations only (403 otherwise — void and re-match of invoices, claim moves and returns included; lists and the
  supplier profile's orders filtered).
- Every write has an audit event (`purchasing.*`; the history panels read them, with pricing's `pricing.landed.*`).

## Boundaries

- Requests, orders and claims reach suppliers outside the system (no email / WhatsApp provider): staff mark them sent.
- Printing is the browser's (print CSS, light ink from a dark screen). Scanners work as keyboard input.
- No invoice payment, no AP sub-ledger per supplier, no posting of invoice price/FX variances or of supplier returns.

## Requests to other owners

- **Commerce core:** (1) a return-to-supplier / single-serial stock-out with `ref { type, id }` that returns the FIFO
  cost, so serial-tracked returns work and purchasing can post Dr accounts payable / Cr inventory in the same batch;
  (2) a cost-layer revaluation for landed bills after posting (same as pricing's request); (3) a `receiveStockStatements`
  builder so a whole receipt can be one batch (today: per-line batches + the lease).
- **Server core / settings 22:** a settings key `purchasing.po_approval_limit_iqd` (default 1,000,000) to replace
  `PO_SPENDING_LIMIT_IQD`; per-role limits with staff 15.06.
- **Admin shell:** queues — orders awaiting approval not one's own (holders of `po.approve` + cost.read →
  `/admin/purchasing/orders?view=pending_approval`), invoices with variances (`/admin/purchasing/invoices?status=mismatch`),
  stopped postings (`/admin/purchasing/receipts?state=posting`); counts in `purchasingOverview()`.
- **Inventory 04:** label movement references of type `receipt_item` with the receipt's ref (`refLabels`).
- **Finance 10:** pay approved supplier invoices (Dr AP / Cr bank) and post price/FX differences against AP.
- **Schema owner:** add `"charges"` to `InvoiceDiscrepancy["field"]` (purchasing stores it today through rules.ts
  `MatchDiscrepancy`); a `refused` count on claim items is kept in the items JSON (no column needed).
- **Pricing 03:** `allocateLandedCost({ updateVariantCosts })` lets a `purchasing.landed_cost.allocate` holder without
  `pricing.cost.update` rewrite a SKU's landed cost (no built-in role is affected today).

## Adversarial review (2026-11-11)

Fixed, each with a test in `tests/admin-purchasing-review.test.ts` that failed before: branch limits on invoice void /
re-match and claim move / return (and the supplier profile's order list); approvals bound to the request seen; editors
excluded from approving; split orders and low typed rates no longer slip under the limit; a supplier blocked while
waiting is not approved; refused units no longer leave stock on a claim's return, returns bounded by their documents and
given a reason; the landed-cost and over-receipt races; charges in the three-way match; an invoiced order not cancelled;
huge amounts answered as field errors; closed-short units in the rating; a receipt's landed cost no longer shown as 0
to a cost reader without the landed-cost permission. Still open: a posting stopped on a line the
core refuses for good (a serial registered elsewhere meanwhile) stays "posting" — no abandon path yet.

## Verify

```
npx vitest run tests/admin-purchasing.test.ts tests/admin-purchasing-review.test.ts tests/i18n.test.ts
node scripts/lint-design.mjs app/routes/admin/purchasing
```
Browser (Edge, puppeteer-core): every page at 390 and 1440, light and dark, ar and en, for a buyer (manager), an
approver, a warehouse clerk (no cost) and a cashier (403); dialogs (approve, cancel, return, spread) and a validation
error. Screenshots and scripts in `.shots/admin-purchasing/` (review shots in `review/`; demo records: suppliers
`SUP-*`, location `DEMO-PUR`, the freight invoice `GGD-2026-0918-FRT` with a charges variance).

## Module follow-up 2026-11-12

`purchasingQueueCounts().mismatch` (the bell, the home) leaves out the invoices the employee recorded: only someone else may accept their variances (`approver_is_requester`).

Tests (each failed before its change): `tests/admin-purchasing-followup.test.ts`.

Review of the follow-up (2026-11-12): that count opens its own list — the invoices filter `to_accept` (mismatches the viewer did not record), which the home card links to, so the card's number is the list's; `mismatch` still lists them all. The bell's `invoice_mismatches` link should be `?status=to_accept` too (requested). Test: `tests/admin-purchasing-followup.test.ts` ("the card's count is the list it opens").
