# Admin 10 — Finance and accounting

Owner: admin finance. The double-entry journal is the single source of truth of the money: sales, cost of goods,
payments, refunds, wallet credits, stock receipts, carrier settlements and expenses are balanced entries the database
seals (append-only, closed months refused). This module reads them, adds the few writes an accountant needs, and never
moves money any other way. Arabic first (RTL), English second, Sorani third. Strings: `app/i18n/messages/admin-finance.ts`.
Services: `app/server/services/admin/finance/*` (client-safe helpers in `types.ts` and `statement-csv.ts`) and two new
commerce-core files, `accounting/reports.server.ts` (statements) and `accounting/expenses.server.ts` (10.05).
Tests: `tests/admin-finance-core.test.ts` (core files), `tests/admin-finance.test.ts` (module services),
`tests/admin-finance-review.test.ts` (the adversarial review of 2026-11-11: closed months, account families, split
four eyes, reused keys, typed digits, unknown intents, orphaned receipts, the home's cash figures).

## Routes (`app/routes/admin/finance/routes.ts`; `layout.tsx` loads the strings, the section tabs with queue counts and an in-shell error boundary)

| Path | What | Permission (loader / action) |
|---|---|---|
| `/admin/finance` | What waits (raised cards: top-ups, adjustments, draft expenses, unmatched lines, critical findings, last month still open), this month's figures, sections, `<ModuleFunctions moduleId="10">` | any finance permission (cards per permission) |
| `/journal`, `/journal/export` | Entries with range (month, two days, "include demo"), account, reference type and text in the URL; 25 a page; cards on phones; CSV of the same filters (formula-safe cells, ≤ 10,000 lines, audited) | `finance.journal.read` + cost.read |
| `/journal/new` | Manual entry: date, memo, reason, up to 20 lines (account, debit or credit, cost centre, note); running difference, commit only when balanced | `finance.journal.post` |
| `/journal/:id` | One entry: lines, reference link (order, payment, refund, wallet, expense, receipt, return, carrier settlement, shift), who, reversal links; "reverse" for manual entries (reason, impact) | read / `finance.journal.post` |
| `/accounts`, `/accounts/:id` | Chart of accounts with the trial balance at a date (balanced flag, printable); add/rename/move/switch off accounts; one account's ledger with running balance | read / `finance.account.manage` |
| `/settlements`, `/settlements/import`, `/settlements/:lineId` | Per method: owed, settled, matched, unmatched; carriers' settlements (module 11) shown; statement lines with filters; CSV import with preview; one line: candidates by amount, reference and date, match / unmatch / set aside / restore; bulk "match exact only"; paid payments no statement proves | `finance.settlement.reconcile` |
| `/revenue` | Recognised (delivered) vs open orders (prepaid / to collect), delivered without cash, customer control; [P] COGS, discounts with coupons, refunds (done / waiting), goods back, gross margin | `finance.report.read` (+ cost.read / profit.read) |
| `/expenses`, `/expenses/new`, `/expenses/:id`, `/expenses/:id/receipt`, `/cost-centers` | Expenses by status, account and centre; record (account, paid from, centre, vendor, day, private receipt photo); approve and post, void (reverses a posted one); cost centres with posted totals | `finance.expense.manage` |
| `/reports` (`?view=pnl|cash|inventory`), `/reports/export` | P&L per docs/metrics.md; cash flow by cause (customers, wallet top-ups, refunds, payroll, marketing, shipping, commissions, operating, suppliers, point of sale, manual, other); inventory account vs stock layers; printable; CSV | `finance.report.read` (cost lines cost.read; profit lines + profit.read; cash and inventory cost.read) |
| `/wallets` (`?tab=topups|adjustments|ledger`) | Liability vs the sum of wallets (to the dinar), top-up queue, adjustment requests (request / approve / reject), the whole ledger read-only | `finance.wallet.read` / `customers.wallet.adjust` |
| `/wallets/topups/:id`, `/…/proof` | Review: private proof (payment_proof.read), declared vs received, same proof / same reference warnings, balance; approve / confirm / send back / reject with the customer's reason; sticky decision bar | `finance.wallet.read` / `customers.wallet.adjust` |
| `/wallets/:customerId` | One customer's wallet: ledger with running balance, top-ups, request an adjustment | `finance.wallet.read` / `customers.wallet.adjust` |
| `/tax` | Configured rates (none today, said plainly), add / change / switch off with a reason; tax included in delivered sales per active rate | `finance.tax.manage` |
| `/close` | Months with state; checklist per month (blocking / warnings), close with reason | books or `finance.period.close` / `finance.period.close` |
| `/anomalies` | Deterministic checks grouped (not a number, unexplained negatives, mismatched totals) + open consistency findings | `finance.anomaly.read` (cost checks need cost.read) |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Where / what is missing |
|---|---|---|
| 10.01 | implemented | `/journal`, `/accounts`: the books; manual entries never touch the wallet account; corrections by reversal |
| 10.02 | partial | `/settlements`: a top-up transfer can only be set aside (statement lines link to order payments only); carriers' settlements are module 11's; no online card gateway configured |
| 10.03 | implemented | `/revenue`: recognised at delivery vs open orders |
| 10.04 | implemented | `/revenue`: COGS (landed, FIFO), discounts and coupons, refunds, goods back |
| 10.05 | implemented | `/expenses`: payroll recorded as an expense on the payroll account until module 15 runs payroll |
| 10.06 | implemented | `/reports`: P&L, cash flow, inventory as an asset |
| 10.07 | implemented | `/wallets`: read-only ledger, top-ups and adjustments through `creditWallet`; adjustments can only credit (no core debit) |
| 10.08 | partial | `/tax`: configuration and report only; checkout adds no tax, no tax-liability account |
| 10.09 | implemented | `/close`: no reopening by design |
| 10.10 | implemented | `/anomalies` |

## Invariants and writes

- Money moves only through the core: `journalStatements` (manual entries, reversals), `creditWallet` (top-ups
  `topup:<id>`, adjustments `adjustment:<approvalId>`), the expense core (`expense:<id>:posted` / `:void`). The module
  writes its own rows: accounts (non-system), cost centres, statement imports and lines, tax rates, fiscal periods,
  `approvals` (kinds `wallet_topup`, `wallet_adjustment`), top-up decisions; every write has an audit event (`finance.*`).
- Manual entries: balanced, ≥ 2 lines, integer IQD (Arabic-Indic / Persian digits accepted), not in the future, never
  on the wallet liability (only `creditWallet` writes it) or an inactive account, refused in a closed month or any
  month before the last closed one. Only manual entries are reversed here (each once, dated now); other entries are
  corrected by their own flow.
- Chart: an account (or a sub-account of it) that holds postings never moves to another family (`account_family_locked`):
  re-parenting would rewrite closed months' statements or the wallet liability without an entry. Codes typed with
  Arabic-Indic / Persian digits are read as digits (accounts, cost centres, tax rates).
- Idempotency: forms carry a key generated by the loader; a repeat returns the first result (`replayed`); a key reused
  with other content is `idempotency_mismatch` (manual entries included). Status changes are guarded updates (two
  people at once: one wins).
- Four eyes: expenses above 500,000 IQD are approved by someone other than the recorder; top-ups above 500,000 IQD
  need a second person; every adjustment is requested by one and approved by another. The limit cannot be split:
  what one employee records AND approves alone, and what one employee approves alone for one customer's top-ups,
  counts together over 24 hours (a guard inside the batch holds it for two tabs at once). Limits are constants
  (`EXPENSE_SECOND_APPROVAL_ABOVE_IQD`, `TOPUP_SECOND_APPROVAL_ABOVE_IQD`) until settings 22 holds them.
- Top-up decision order (no interactive transactions): the decision first (guarded batch, one winner against the
  customer's own cancel), then the idempotent credit; a failed credit shows "approved, not credited" and the same
  action finishes it. Anomalies list any such request.
- Statement import: CSV with Arabic or English headers, ≤ 2,000 rows / 1 MB; each line hashed, so a re-import adds
  nothing. Matching links a line to one PAID payment (a different amount needs a note); nothing moves money.
- Close: the `fiscal_periods` row; the database (TT:PERIOD_CLOSED) refuses entries dated in a closed month, and the
  services (`isLockedPeriod` + the batch guard `openPeriodGuard`, accounting/reports.server.ts) refuse anything dated
  on or before the last closed month — an earlier month left open would otherwise move the closed month's balances.
- Cost privacy: the journal carries purchase cost, so the books (journal, accounts, trial balance, cash flow,
  inventory, the home's cash and bank balances) need cost.read too; profit needs cost.read + profit.read; an absent
  figure is `null`, never 0 — in loader data, JSON, CSV and print (the printed trial balance leaves its edit keys
  out). Phones masked without customer.phone.read_full; proofs only with payment_proof.read.
- Branches: finance records (journal, wallets, statements, expenses) are store-wide and carry no branch, like SKU
  prices in pricing; branch limits do not apply here.
- Demo data (`is_demo`) is left out of every figure unless "include demo" is on; screens say how many rows are hidden.

## Boundaries

- No bank, Zain Cash or card-gateway connection: statements arrive as CSV files. No online card gateway is configured.
- Tax: no rate is configured and none is invented — which taxes apply in Iraq is the owner's decision with their
  accountant. A configured rate is reported (tax included in prices), never added at checkout nor posted.
- Printing is the browser's (print CSS). No PDF.

## Requests to other owners

- **Admin shell:** queues — top-ups waiting (`customers.wallet.adjust` + `finance.wallet.read` →
  `/admin/finance/wallets?tab=topups`, excluding first approvals by the viewer), adjustments to approve (not one's
  own), draft expenses others may approve (`/admin/finance/expenses?status=draft`), unmatched statement lines
  (`/admin/finance/settlements`); counts in `walletQueue`, `countDecidableExpenses(db, actor, now)` (it counts the
  viewer's own 24-hour self-approvals), `countUnmatched`.
- **Schema (drizzle owner), defence in depth:** the `journal_entries_post` trigger could refuse `NEW.period <=` the
  last closed period too, so a future flow that back-dates a posting cannot reopen a closed month's balances (today
  only manual entries and expenses back-date, and their services refuse it).
- **Settings 22:** keys `finance.topup_second_approval_iqd` and `finance.expense_second_approval_iqd` (default 500,000).
- **Commerce core:** a debit wallet adjustment (`debitWallet` with reason and approval key) so a wrong credit can be
  taken back; a tax-liability system account and checkout tax if the owner decides a rate applies; posting memos
  are written in English ("Order … delivered") and shown as written — Arabic memos or a memo key would read better.
- **Schema:** `statement_lines.matched_topup_id` (match a statement line to a wallet top-up) and `is_demo` on
  statement lines/imports.
- **Root error boundary (lead):** the gate's 403 page logs a hydration warning (seen on `/admin/finance` as a cashier).
- **Operations 23:** resolve consistency findings from its screen (this module only shows them).
- **Purchasing 09:** paying supplier invoices is not built here yet; record it as a manual entry (Dr accounts payable /
  Cr bank or cash) until a payment screen exists.

## Verify

```
npx vitest run tests/admin-finance-core.test.ts tests/admin-finance.test.ts tests/admin-finance-review.test.ts tests/i18n.test.ts
node scripts/lint-design.mjs app/routes/admin/finance
```
Browser (Edge, puppeteer-core): every page at 390 and 1440, light and dark, ar and en, as the owner, two finance
clerks (four eyes), a manager and a cashier (403); dialogs (reverse, add account, approve expense, approve/reject
top-up, add tax rate), validation errors. Scripts and screenshots in `.shots/admin-finance/` (demo records: memo or
description ending "(تجريبي)", staff `demo.finance.*@tamtam.local`, statement references `DEMO-*`).
