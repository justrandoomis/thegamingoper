# Metrics dictionary

The one place where TamTam's business numbers are defined. Dashboards (01), finance (10), reports (18), exports and the daily consistency checks (23.06) compute every figure below exactly as written here. If a screen needs a number that is not here, add its definition first.

Owner: commerce core (`app/server/services/accounting/post.server.ts` writes the postings these definitions read).

## 1. Ground rules

| Rule | Meaning |
|---|---|
| Money | Integer IQD everywhere (`*_iqd`). Sums are integer sums; ratios are computed at the end and rounded only for display. A figure that cannot be computed is shown as "not available", never as 0, NaN or Infinity. |
| Time | Days, weeks and months are Asia/Baghdad (UTC+3, no daylight saving). A month is the fiscal period `YYYY-MM` (`fiscalPeriodOf`). |
| Demo data | Rows with `is_demo = 1` (orders, journal entries, products…) are excluded from every real metric. Orders placed while `STORE_MODE=demo` are demo orders. |
| Source of truth | Financial figures come from the journal (`journal_lines` joined to `journal_entries`; a line without its header is not part of the books). Operational counts come from the order tables. The two are reconciled daily (§6). |
| Accounts | Named by their stable system key (`accountId(key)` = `acc_<key>`); codes in brackets are the seeded chart (`CHART_OF_ACCOUNTS`). |
| Cost privacy | Every figure that uses cost (COGS, gross profit, net profit, margins, stock value) needs `cost.read` / `profit.read` — on screens, exports and APIs alike. |

## 2. When things are recognised

| Event | What happens in the books | Posted by |
|---|---|---|
| Order placed (cash on delivery, transfer) | nothing — an order is a promise, not a sale | — |
| Wallet payment at checkout | Dr wallet liability, Cr customer control | `placeOrder` → `postWalletPayment` |
| Transfer verified | Dr bank clearing (amount that arrived), Cr customer control (amount due), difference to cash over/short | `verifyPayment` → `postTransferVerified` |
| Cash on delivery collected | Dr cash (amount collected), Cr customer control (amount due), difference to cash over/short | `recordCodCollection` → `postCodCollected` |
| **Delivered — revenue is recognised** | Dr customer control (total − refunds already issued), Dr sales refunds (refunds already issued), Dr sales discounts, Cr sales revenue (lines subtotal), Cr shipping income (fee charged) | `transitionOrder(… "delivered")` → `postSale` |
| Delivered — cost of goods | Dr COGS, Cr inventory: the FIFO landed cost of the units that left (+ used units at acquisition cost) | `postCogs` |
| Refund issued, order not yet delivered | Dr customer control, Cr where the money leaves from (cash, bank clearing, wallet liability) | `createRefund` / `approveRefund` → `postRefund` |
| Refund issued, order delivered | Dr sales refunds, Cr where the money leaves from | `postRefund` |
| Goods back, restocked (after delivery) | Dr inventory, Cr COGS (at the cost they left with) | `postReturnedGoods` |
| Goods back, scrapped (after delivery) | Dr inventory adjustments, Cr COGS | `postReturnedGoods` |
| Goods back undelivered, scrapped | Dr inventory adjustments, Cr inventory (restocked: no entry, they never left the books) | `postReturnedGoods` |
| Wallet credit (top-up / trade-in / goodwill) | Dr cash or bank clearing / inventory / operating expenses, Cr wallet liability | `creditWallet` → `postWalletCredit` |
| Stock received | Dr inventory (landed cost), Cr accounts payable / cash / bank clearing / owner equity | purchasing → `postStockReceipt` |

`customer control` is the account `cod_receivable` [1020]. Its balance per order is: debit = delivered but not yet paid (cash on delivery in the courier's hands), credit = paid but not yet delivered (an advance). When an order is delivered and paid it nets to zero.

Every posting carries a deterministic `idempotency_key` (`order:<id>:sale`, `order:<id>:cogs`, `payment:<id>:received`, `refund:<id>`, `refund:<id>:goods`, `wallet:<ledger id>`, `<ref type>:<id>:receipt`), so a business event can be in the books only once. Entries are never edited: a correction is a reversing entry (`reverses_id`) in an open month. A closed month (`fiscal_periods.status = 'closed'`) refuses every entry dated into it.

## 3. Sales

| Metric | Definition |
|---|---|
| **Orders placed** | Count of non-demo orders with `placed_at` in the period, any status. |
| **Open orders** | Orders now in `new`, `awaiting_payment`, `payment_review`, `confirmed`, `preparing` or `shipped`. |
| **Gross merchandise value (GMV)** | Σ `orders.total_iqd` of orders placed in the period, excluding `cancelled`. Includes delivery fees; a pipeline figure, not revenue. |
| **Paid sales** (01.01) | Money that actually arrived for orders: Σ `payments.amount_iqd` with `status = 'paid'` and `paid_at` in the period, minus Σ `refunds.amount_iqd` with `status = 'paid'` and `paid_at` in the period. Cash on delivery counts when collected, transfers when verified, wallet payments at checkout. A transfer waiting for verification never counts. |
| **Revenue (gross)** | Credits to sales revenue [4000] in the period — the lines subtotal of orders delivered in the period. |
| **Shipping income** | Credits to shipping income [4100] — delivery fees of orders delivered in the period. |
| **Discounts** | Debits to sales discounts [4800] — coupon and order discounts of orders delivered in the period. |
| **Refunds** | Debits to sales refunds [4900] — refunds of recognised sales: issued after delivery in the period, plus refunds issued before delivery of orders delivered in the period. |
| **Net revenue** | Revenue − Discounts − Refunds. (Shipping is handled by the shipping subsidy, §4.) |
| **Average order value (AOV, "average basket")** | Σ (`subtotal_iqd` − `discount_iqd`) ÷ count, over non-demo orders placed in the period and not cancelled. Delivery fees are excluded. Not shown when the count is 0. |
| **Units sold** | Σ `order_items.qty` of orders delivered in the period, minus the units of those orders that came back (`stock_movements.kind = 'return'`, plus returned used units). |
| **Cancellation rate** | Orders placed in the period that are now `cancelled` ÷ orders placed in the period. |
| **Refund rate** | Σ refunds paid in the period ÷ Σ payments paid in the period (money terms). |
| **Return rate** | Units that came back (`stock_movements.kind = 'return'` with `ref_type = 'order'`) ÷ units shipped (`kind = 'sale'`), same period. |

## 4. Cost and profit

| Metric | Definition |
|---|---|
| **COGS (landed)** | Net debit of COGS [5000] in the period. Each unit leaves stock at the unit cost of the FIFO cost layer it is taken from (`cost_layers.unit_cost_iqd` = purchase price + its share of freight, customs and other landed costs allocated at receipt). A unit with no layer left is costed at the variant's standard landed cost (`variant_costs.landed_cost_iqd`); a unit with neither is **uncosted**: it adds nothing to COGS and is flagged (movement reason `no_cost_layer_uncosted`, order event `uncostedUnits`). Used units are costed at `used_units.acquisition_cost_iqd`. Goods restocked after a return reduce COGS at the cost they left with. |
| **Gross profit** | Net revenue − COGS. |
| **Gross margin** | Gross profit ÷ Net revenue. Not shown when net revenue is 0. |
| **Commissions** | Net debit of commissions [6200] in the period (staff and sales-channel commissions). |
| **Shipping costs** | Net debit of shipping and delivery costs [6100] — what carriers charged (`shipments.cost_iqd`, posted by the shipping/finance modules). |
| **Shipping subsidy** | Shipping costs − Shipping income. Positive when delivery costs the store more than it charges (the flat 5,000 IQD fee does not cover the carrier); negative is a delivery margin. |
| **Net profit** (01.01, ARCHITECTURE §7.9) | Net revenue − COGS − Commissions − Shipping subsidy. Equivalently: Revenue + Shipping income − Discounts − Refunds − COGS − Commissions − Shipping costs. |
| **Net margin** | Net profit ÷ Net revenue. |
| **Operating result** (P&L, 10.06) | Net profit − inventory adjustments [5100] (write-offs, scrapped returns, count differences) − cash over/short [6900] − the other operating expenses [6000, 6300, 6400 …]. |
| **Profit of one order** | Its share of the above: (subtotal − discount − refunds of it) − its COGS − its commissions − (its carrier cost − its delivery fee). Only for delivered orders; an order with uncosted units shows its profit as incomplete. |

## 5. Money held and owed

| Metric | Definition |
|---|---|
| **Wallet liability** | Σ `wallet_ledger.amount_iqd` (all customers). Must equal the credit balance of wallet liability [2100]. A customer's balance is Σ of their rows; it can never go below zero (database trigger). |
| **Cash on delivery outstanding** | Σ `payments.amount_iqd` of `cod` payments still `pending` whose order is `shipped` or `delivered`. |
| **Customer advances** | Credit balance of customer control [1020] on orders not yet delivered (paid by wallet or verified transfer). |
| **Transfers awaiting verification** | Count and Σ `declared_amount_iqd` of payments in `pending_verification`. |
| **Payment verification time** | `payments.verified_at` − `created_at` of the approved proof; median per period. |
| **Stock value (inventory as an asset)** | Σ `cost_layers.qty_remaining × unit_cost_iqd`, plus listed/reserved used units at acquisition cost. Compare it with the inventory account [1200]: they differ by goods shipped but not yet delivered (still in the account until delivery, already out of the layers), by uncosted units, and by any receipt that was not posted (`receiveStock` does not post by itself; the purchasing flow posts receipts with `postStockReceipt`, and the demo opening stock is not posted). |

## 6. Conversion and funnel

| Metric | Definition |
|---|---|
| **Cart-to-order conversion** | Carts created in the period that became an order (`carts.converted_order_id` set) ÷ carts created in the period. |
| **Checkout completion** | Orders placed ÷ checkout attempts. Not measured yet: no checkout-attempt event is recorded. Shown as "not available", never estimated. |
| **Visitor conversion rate** | Orders placed ÷ distinct visiting sessions. Sessions are only counted for visitors who gave analytics consent, so this figure covers consenting visitors only and says so. Until a session counter exists it is "not available". |

## 7. Daily consistency checks (`consistency.daily`, 23.06)

Run by `runScheduledJobs` (cron `30 0 * * *`); every problem is a row in `consistency_findings` (`check_key`, entity, details), updated while it persists and closed automatically when it is gone.

| Check | Rule | Severity |
|---|---|---|
| `stock.levels_vs_movements` | `stock_levels.on_hand` = Σ `qty_delta` and `reserved` = Σ `reserved_delta` of the movements of that variant and location | warning |
| `stock.reserved_vs_reservations` | `stock_levels.reserved` = Σ `qty` of the active `stock_reservations` | warning |
| `wallet.ledger_vs_journal` | Σ `wallet_ledger` = balance of wallet liability [2100] | critical |
| `wallet.negative_balance` | no customer's wallet sum is below zero | critical |
| `journal.unbalanced_entries` | every entry has ≥ 2 lines and Σ debit = Σ credit | critical |
| `journal.orphan_lines` | no line without its entry header | warning |
| `orders.totals_vs_items` | `orders.subtotal_iqd` = Σ `order_items.total_iqd` (the CHECK constraints already enforce total = subtotal − discount + shipping + tax and line = unit × qty − discount) | critical |
| `orders.paid_vs_payments` | `orders.paid_iqd` = Σ paid payments and `refunded_iqd` = Σ paid refunds | critical |
| `money.missing_postings` | every paid payment, paid refund and delivered order has its journal entry | critical |

## 8. Marketing (admin 16.04, 16.07)

Computed by `services/admin/marketing/performance.server.ts` and `links.server.ts` exactly as written here (`marketing.report.read`). No cost, landed cost, margin or profit enters any of them, so none needs `cost.read` / `profit.read`; a profit-based customer value belongs to the reports (18), from the journal (§4). A figure that cannot be computed is "not available" with its reason — never 0.

| Metric | Definition |
|---|---|
| **Marketing spend** | Σ of the entries staff record on a campaign per month (`campaigns.content.spend`: amount, month, reference, note; a correction is a negative entry; a month's total never goes below 0). Per campaign, spend is recorded only here — the finance books hold marketing expenses as a whole (account 6400, §4), not per campaign, and the two are not matched automatically. A month without an entry has no spend figure. Demo campaigns are left out unless asked for. |
| **Customer** (marketing) | A person: the order's account, else the account that claimed the guest checkout (`guest_contacts.customer_id`), else the order's phone number. A **qualifying order** is not demo, not cancelled, and money arrived for it (`paid_iqd > 0`). Orders without any of the three (an anonymous till sale) count for nobody. |
| **New customer** | A customer whose first qualifying order is placed in the month (Baghdad). |
| **CAC** (blended) | Marketing spend of the month ÷ new customers of the month — every campaign together, every new customer. Not available without a spend entry or without new customers. |
| **Attributed order** | An order that carries its source AND names a campaign: `orders.utm_link_id` (a campaign's link) or `orders.attribution.campaign` matching a campaign's `utm_campaign` (a demo campaign only when demo is asked for). An order whose source names no campaign carries a source but is not attributed — the months, the totals and the campaign rows count the same attributed orders. Nothing is modelled or guessed; until the storefront records the source, no order is attributed. |
| **Attributed sales** | Σ (`paid_iqd` − `refunded_iqd`) of the attributed orders placed in the period, not cancelled (§3 "Paid sales", per order). |
| **ROAS** | Attributed sales of a campaign ÷ its spend in the same period. Not available while no order carries its source, or without spend. |
| **LTV** (revenue) | The average, over customers, of Σ (`paid_iqd` − `refunded_iqd`) of their qualifying orders to date. Shown for every customer and for the customers acquired in the period (their first qualifying order in it). |
| **LTV ÷ CAC** | LTV of the period's new customers ÷ the period's blended CAC. |
