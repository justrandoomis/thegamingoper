# Admin 03 — Pricing and profitability

Owner: admin pricing. Selling prices and their approvals, purchase and landed cost, margin rules, price lists, the
discount simulation, bundle / clearance / used pricing, the advisory suggestion and the store's USD rate.
Arabic first (RTL), English second. Strings: `app/i18n/messages/admin-pricing.ts`. Services:
`app/server/services/admin/pricing/*` (pure rules in `rules.ts`). Tests: `tests/admin-pricing.test.ts`.

## Routes (`app/routes/admin/pricing/routes.ts`, layout `layout.tsx` loads the strings and the module tabs)

| Path | What | Permission (loader / action) |
|---|---|---|
| `/admin/pricing` | Waiting for me (decidable requests, own requests, bills to spread), the price book (SKUs, under minimum / target, without cost, USD rate, lists), the pages, `<ModuleFunctions moduleId="03">` | any pricing permission |
| `/admin/pricing/skus` | Every SKU: price, "was" price, stock, landed cost (cost.read), margin state (profit.read). Filters, views, sort, page in the URL (GET form, no JS needed); folded filters on phones; cards on phones, DataTable from 768; CSV; bulk margin rules for selected rows | any pricing permission / `pricing.margin.manage` + profit.read |
| `/admin/pricing/skus/:variantId` | Price today, "was"-price eligibility (90-day rule), the change form (standard / clearance) → server preview → confirm dialog with impact (price, %, stock value at retail, margin before/after, floor, approval) + reason; pending request (withdraw); suggestion (market price as a GET param); cost card (currency, unit cost, dated rate, extras → landed, live preview, confirm + reason); margin rules; bundle components; price lists; FIFO layers; history | any pricing permission / per intent: `pricing.price.update`, `pricing.cost.update`, `pricing.margin.manage` |
| `/admin/pricing/changes` | Approval queue (cards, mobile-first; approve / reject with impact and reason; the requester only withdraws) and the log (filters in the URL, paging, CSV) | any pricing permission / `pricing.price.approve` (decide), `pricing.price.update` (withdraw) |
| `/admin/pricing/landed`, `/landed/:receiptId` | Receipts (from purchasing 09) with their bills; add a bill (currency + rate), spread it by value / quantity / weight with a per-line preview, remove it. The page acts on its own receipt's bills only; a branch-limited employee sees their branch's receipts only | `cost.read` + (`pricing.cost.update` or `purchasing.landed_cost.allocate`) |
| `/admin/pricing/lists`, `/lists/:listId` | Price lists per channel / branch / segment, priority, window; items by SKU or scanned barcode (keyboard wedge: Enter moves to the price) with min quantity; margin check; plain notice that the cart does not apply them | price-list readers / `pricing.price_list.manage` |
| `/admin/pricing/simulate` | Discount (percent or fixed) over a selection: net price, refunds (history 180 days / none / assumed), fees, commission rules, landed cost → profit and net margin before/after, totals over stock on hand; GET form (shareable URL); CSV | `pricing.simulation.run` |
| `/admin/pricing/special` | `?tab=bundles` (vs components), `clearance` (no sale 90 days, stock ≥ 90 days old; `&all=1` = every unsold SKU), `used` (unit prices, confirm with impact; a waiting request on its card: approve / reject for others, withdraw for its requester; the module tab carries the count) | `SPECIAL_READERS` (403 for other pricing roles) / `pricing.used.update` (price, withdraw), `pricing.price.approve` (decide) |
| `/admin/pricing/fx` | The USD rate in force, scheduled rates, every rate (append-only use), set a new rate now or later (confirm with the effect on a 100,000 IQD price) | any pricing permission / `pricing.fx_rate.manage` |
| `/admin/pricing/export/:kind` | CSV `skus` · `changes` · `simulate` (BOM, formula-safe, `Cache-Control: private, no-store`) — cost columns only with cost.read, margin/profit only with profit.read | any pricing permission (+ `pricing.simulation.run`) |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Where / what is missing |
|---|---|---|
| 03.01 | implemented | SKU page cost card: currency, unit cost, purchase rate and date (store USD rate as default), extras → landed (exact BigInt rounding) |
| 03.02 | partial | `/landed`: bills spread exactly over draft receipts (and per-unit extras per SKU). Receipts come from purchasing (no screens yet); a bill after posting needs a FIFO-layer revaluation the core lacks |
| 03.03 | implemented | min / target margin per SKU and in bulk gate every price; the catalog (02) leaves new variants at price 0 and will not publish them, so every published price passed this gate (or a second person) |
| 03.04 | partial | lists managed here; the cart, checkout and POS do not apply them; product condition is not a list dimension in the schema |
| 03.05 | implemented | `/changes`: log (append-only) + approvals; the 10 % limit (counted from the highest price of the last 30 days) is a constant until settings has a key |
| 03.06 | implemented | `/simulate` |
| 03.07 | implemented | `/special` + clearance mode on the SKU page; used-device prices under the same four-eyes rules (decided on the used tab) |
| 03.08 | implemented | SKU page: deterministic rules; no AI model or market feed connected |

## Rules (rules.ts, prices.server.ts)

- A change applies at once unless it trips a rule: a cut of more than 10 % (`DROP_APPROVAL_BPS`) from the highest price in
  force during the last 30 days (`DROP_WINDOW_DAYS`; the window starts again at the last change a second person approved —
  `dropReferencePrice`), a new or changed "was" price, any new price on a SKU without a cost (its profit is unknown), any
  clearance price → `pricing.price.approve`; under the minimum margin or under the landed cost → also
  `pricing.discount.override`. Decider ≠ requester (`approver_is_requester`). One undecided request per SKU. The preview
  shows the 30-day price the cut counts from when it is above today's.
- Used devices (`/special?tab=used`) follow the same rules per unit, with the acquisition cost as the cost and no margin
  rules: a rise or a cut of at most 10 % (30-day reference read from the audit trail) above the cost applies at once;
  otherwise an `approvals` row (kind `used_price`) that a second person decides (`decideUsedPrice`; override under the
  cost); the requester withdraws (`cancelUsedPrice`). One request per unit.
- "Was" price: higher than the new price and charged EXACTLY for 90 consecutive days while the product was published, within
  the last 365 days (history rebuilt from applied `price_changes`; seeded SKUs therefore qualify 90 days after the seed).
- Clearance: floor = landed cost (minimum margin ignored), always a second person.
- Bundles without an own cost row are priced against Σ component landed × qty (only when every component has a cost).
- Margins are floored basis points on the selling price; floors are the lowest 250-step price that keeps the margin.
- The suggestion: cost + target margin; keep today's price when it already meets the target (no market price); match a
  typed market price (or one step under it when above target), never under the floor; −5 % for slow stock. Advice only.
- Simulation: profit = net price − refunds − fees − commission − landed; a refund counts as money back without resale
  (cautious); commission = the most specific "everyone" rule (category > kind > all, higher rate on a tie).

## Invariants and writes

- `variants.price_iqd / compare_at_iqd` change only in the batch that writes the `price_changes` row (applied, or the
  decision row pointing at its request) and the audit event, guarded by the price the decision was made on
  (`price_changed`), the cost it was evaluated on (`cost_changed`) and "no other undecided request" (`change_pending`).
  Approval rows (`approvals`, kind `price_change`) are closed in the same batch. Orders keep their snapshot; carts re-price.
- Idempotency: request ids, landed-bill ids and fx-rate ids are derived from (employee, form key) — a double submit returns
  the first result. Cost and list edits carry the row's `updated_at` (stale tab → `cost_changed` / `list_changed`); a
  cost or used-unit price that already is what the form says answers "unchanged" instead (a double submit is not a
  conflict), and a repeated used-unit request returns the waiting one (`replayed`).
- Landed cost: allocating and removing a bill are guarded on the receipt's other allocated bills ("count:Σ amount:Σ per
  unit"), so two bills spread at once cannot drop each other's share (`cost_changed`). Removing a bill re-sets each
  line's landed unit cost, and a SKU whose `variant_costs.landed_cost_iqd` is still the one that line gave it follows
  the line back (guarded on that value: a cost typed in since stays). Bills are capped at `MAX_BILL_IQD` (10 bn IQD).
- Every change writes an audit event with before/after and the reason (`pricing.price.*`, `pricing.cost.update`,
  `pricing.margin.*`, `pricing.landed.*`, `pricing.price_list.*`, `pricing.used.price`, `pricing.fx_rate.set`).
- Branch limits (SECURITY §7): an employee with a `branchId` works only on receipts and used devices kept at that
  branch's locations (lists filtered, writes 403) and on price lists scoped to that branch (not another branch's, not
  a list for every branch). SKU prices and costs are store-wide and have no branch.
- Field rules: `[P]` values are absent (not blank) from loader data, CSV and service results without cost.read /
  profit.read; margin-based approval reasons are hidden from requesters without profit.read (the preview says the server
  decides). A margin together with a price reveals the cost: give profit.read only to roles that may know cost.

## Boundaries

- No AI model, no market-price feed (staff type a market price). No courier, gateway or messaging involved.
- Price lists are not applied by the commerce core; posted-receipt revaluation does not exist (see requests).
- Printing: pages print with the browser; no dedicated print views were built (shelf labels would belong here later).

## Requests to other owners

- **Commerce core:** (1) price the cart / checkout / POS with `resolveListPrice(db, { variantIds, qty, channel, branchId,
  segmentIds, at })` from `services/admin/pricing/lists.server.ts` — before that goes live, list items must pass the
  four-eyes rules too (today a holder of `pricing.discount.override` sets a list price under the floor alone, and a
  list price on a SKU without a cost is not stopped: harmless while no list is applied); (2) a cost-layer revaluation
  for landed bills that arrive after a receipt is posted (Dr inventory / Cr accrued freight, layers' `unit_cost_iqd`
  for the units left).
- **Catalog (02):** keep prices out of the catalog (today new variants start at 0 and publishing needs a price, which only
  this module sets — the margin gate of 03.03 relies on it); product links used here: `/admin/catalog/products/:productId`.
- **Purchasing (09):** create receipts as drafts, call `addLandedCost` + `allocateLandedCost` (or embed
  `allocationStatements(db, { context: await loadBillContext(db, actor, landedCostId), preview, … })` in the receiving
  batch), then post with `receiveStock(… unitCostIqd = receipt_items.landed_unit_cost_iqd)`.
- **Server core:** a settings key `pricing.drop_approval_bps` (default 1000) to replace the constant `DROP_APPROVAL_BPS`.
- **Admin shell:** a queue for price changes awaiting a decision (`countDecidable(db, actor)` in prices.server.ts).
- **Schema (data):** a `condition` column on `price_lists` ("new" | "used" | "open_box") if lists must vary by condition.

## Verify

```
npx vitest run tests/admin-pricing.test.ts       # 39 tests (11 from the adversarial review: sliced cuts, receipt binding,
                                                 # branch limits (receipts; used devices and lists), bill removal vs SKU
                                                 # cost, concurrent allocation, 403 on /special, Arabic digits, double
                                                 # submits, used-device four eyes, bill cap)
npx vitest run tests/i18n.test.ts tests/admin-shell.test.ts
node scripts/lint-design.mjs app/routes/admin/pricing
```
Browser (puppeteer-core + Edge, signed in): every page at 390 and 1440, light and dark, ar and en; confirm dialogs (price
change, approve, reject, cost, fx), a validation error, 403 inside the shell for a custom role without cost.read, the
gate's 403 for a cashier. Screenshots in `.shots/admin-pricing/`.
