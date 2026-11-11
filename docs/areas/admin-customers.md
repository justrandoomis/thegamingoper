# Admin 07 — Customers & CRM

Owner: admin customers. Routes `app/routes/admin/customers/**`, services `app/server/services/admin/customers/**`,
strings `app/i18n/messages/admin-customers.ts` (ar source, en, ckb), tests `tests/admin-customers*.test.ts`.
Blueprint 07.01–07.07 (`blueprint-status.ts`): five implemented; 07.04 and 07.05 partial (the wallet can neither be
paid out nor moved — see Requests).

## Routes

| Path | What | Permission (loader / actions) |
|---|---|---|
| `/admin/customers` | Queue cards (open privacy requests, open complaints, risk, VIP), the list: search (name, e-mail, whole phone, an order or RMA number; part of a phone only with `customer.phone.read_full`), saved views (all, VIP, risk, complaints, blocked, new, no purchase), status, RFM segment, sort, page — all in the URL; table ≥ 768 px, cards below; module functions | `customers.customer.read` |
| `/admin/customers/export` | The list as CSV (same filters and order, ≤ 5,000 rows, phones as on screen), audited | `customers.customer.export` + read |
| `/admin/customers/segments` | RFM: the written rules, stored membership next to what the orders say now, recency × frequency grid, recompute (confirm, one batch, audited) | read · recompute `customers.segment.manage` |
| `/admin/customers/consents` | Consent log of customers and guests (grants, withdrawals; "unsubscribes" = marketing · withdrawn), source, policy version | `customers.consent.read` |
| `/admin/customers/privacy` | Privacy requests (open, past due, finished, all; kind), open one by phone number | `customers.privacy.manage` |
| `/admin/customers/privacy/:ref` | One request: facts, verify (method + note), then export / erase plan + erase / unsubscribe / correct, reject, complete; history; prints as a record | `customers.privacy.manage` |
| `/admin/customers/privacy/:ref/export` | The customer's data as JSON, built at download, each download audited with its SHA-256 | `customers.privacy.manage` |
| `/admin/customers/duplicates` | Look-alike pairs with their reason, latest merges from the audit trail | `customers.customer.merge` |
| `/admin/customers/:id` | 360° profile (header shared by the sub-pages: name, phone as allowed, status, segment, labels) | read · note / vip / flag / block |
| `/admin/customers/:id/contact` | Details, addresses (add, edit, default, delete), notification channels — each with a reason | read · `customers.customer.update` |
| `/admin/customers/:id/privacy` | Current consents + full history, record a withdrawal, the customer's requests + open one | consent.read or privacy.manage |
| `/admin/customers/:id/messages` | Communication log (filter by order), log a contact | `customers.communication.read` · log `customers.customer.note` |
| `/admin/customers/:id/merge` | Candidates with reasons, search, plan (`?with=`), verification, confirm | `customers.customer.merge` |

Actions are POSTs with one `intent` each (`customer.server.ts`, `actions.server.ts`): the intent's permission is
checked before anything is read, then the service checks it again (`assertCan`) and parses the raw input with zod.

## Functions → status

- **07.01 implemented** — profile: KPIs (purchases, value kept, average, last order), RFM with its rules, labels with
  reasons, orders (`orders.order.read`), RMAs (`returns.rma.read`), warranties (`returns.warranty.read`; serials with
  `inventory.serial.read`), repairs, tickets (`support.ticket.read`, read only until module 14), wallet
  (`customers.wallet.read`: the core's `getWalletBalance` + `listWalletEntries`; link to `/admin/finance/wallets/:id`
  for `finance.wallet.read` — top-ups and adjustments stay module 10's), notes, consents, privacy requests, merged
  accounts, activity. A section the employee may not read is `null` in the loader data, never sent; the activity
  follows the same rule (`activityScope`: wallet events need a wallet permission, consent events consent.read or
  privacy.manage, other modules' events audit.read).
- **07.02 implemented** — purchase = an order not cancelled with `paid_iqd − refunded_iqd > 0`; R/F/M 1–5 by
  `RFM_RULES`; ten segments by `segmentOf` (types.ts); stored as `customer_segments` "rfm.<segment>" + members.
- **07.03 implemented** — account area's `AddressInput`, geography and preferences reused; staff edits carry a reason,
  before/after audit, an `updated_at` guard (`customer_changed`): every form (details, channels, an address's edit,
  default, delete) sends the stamp it showed. Limit of 10 and one default decided in the batch. The account phone is
  not edited (SMS needed).
- **07.04 partial** — consents append-only (withdrawals only); requests: verify → export / erase / unsubscribe /
  rectify → complete; due in `PRIVACY_DUE_DAYS` (30, the store's target). The export file only while the request is in
  progress. An unsubscribe withdraws the account's answers and the person's checkout answers as a guest (guest contacts
  of the account or its number); for a number without an account, its guest contacts. **Missing:** an account holding
  wallet money cannot be erased — no wallet payout exists (module 10's adjustments are credits). Customers cannot file
  one themselves yet. The request page prints as a record (light ink on paper from a dark screen, no chrome or controls).
- **07.05 partial** — merge plan → verification → confirm, one batch; refused while the duplicate holds wallet money,
  and when a blocked or fraud-flagged duplicate would fold into an account without that label.
- **07.06 implemented** — `FLAG_RULES`: VIP (manual label, ≥ 2,000,000 IQD or ≥ 5 purchases in 365 days), risk
  (manual fraud flag, ≥ 2 cancelled in 90 days, ≥ 2 rejected proofs in 90 days, ≥ 2 returned in 180 days, a duplicate
  proof), complaints (open complaint or escalated tickets). Fraud flag → module 05's `customer_flagged` review rule.
  Block = `status` blocked (sign-in and checkout refuse it) + sessions end.
- **07.07 implemented** — outbox rows of the customer, their orders or their number, with only `MESSAGE_SAFE_FIELDS`;
  contacts logged by hand as audit events. Every message is `held` (no provider): shown as "not sent".

## Invariants

- No cost, landed cost, margin or profit is selected anywhere in this module ("value" = paid − refunded); tests check
  the loader data and the export file. Wallet balances only with `customers.wallet.read` — also in the merge plan, its
  candidates and the erasure plan ("holds money" without the amount otherwise).
- Phones: `phoneView` masks without `customer.phone.read_full` (list, profile, CSV, consent log, merge, messages);
  partial-digit search needs the permission (the orders module's oracle finding). A fraud reason is stored and shown
  with phones masked, and refuses card-like numbers.
- Notes and contacts are append-only audit events (`customers.customer.note`, `customers.contact.log`); a summary or
  note with 12+ digits in a row (after Iraqi phones are taken out) is refused (`note_has_card_number`).
- Consents: staff record withdrawals only (source "admin", "privacy_request", "erasure", "merge"); never a grant.
- Every change is one guarded batch with its audit event; merged/erased accounts are read-only (`customer_unavailable`,
  also for a withdrawal).
- Erasure (`executeErasure`): guards re-checked in the batch (wallet sum 0, no open order, return — also one filed on
  its orders without the account — or repair, no pending top-up or adjustment); the account AND the accounts merged
  into it (the same person) lose name, e-mail, password, notes, preferences, VIP label and fraud reason, phone →
  `erased:<id>` (merged ones stay "merged"); their addresses, saved devices, favourites, recently viewed, browsing
  signals (`recommendation_events`), notifications, sessions, segment rows deleted; carts unlinked; the person's guest
  contacts (claimed, or on one of its numbers) lose their name; every answer still granted — accounts' and guest
  contacts' — withdrawn; orders, payments, refunds, wallet ledger, consents, audit, returns, warranties, tickets,
  trade-ins and messages kept. Its audit events hold counts, never the erased values.
- Export: built only while the request is in progress (verified); no staff text (internal notes, cancel reasons).
- Merge (`mergeCustomers`): the plan's fingerprint must match (`merge_plan_changed`); guards in the batch (kept account
  live, a blocked duplicate only into a blocked account, a fraud-flagged one only into a flagged account, duplicate's
  wallet 0, no pending top-up / adjustment, loyalty 0, no membership or referral code, no open privacy request);
  orders moved by id with an order event `customer_merged` each and none left behind; duplicates of favourites /
  saved devices / recently viewed / reviews dropped or kept by the rules in the file header; duplicate → `merged`,
  sessions revoked; a newer withdrawal carried as a withdrawal; replay → `{ replayed: true }`.

## Boundaries (honest)

- No SMS / WhatsApp / e-mail provider: messages held; the export is handed over by hand; a phone change is not offered.
- Customers cannot open a privacy request from the storefront (the account area has no form) — staff open them.
- The immutable audit trail keeps names written in earlier events (phones are masked there): erasure cannot reach it.
  Stored assistant conversations and sign-in events keep their own retention (expiry; 180 days): erasure does not
  shorten it.
- Rules and thresholds are module constants (settings 22); no scheduled RFM recompute (jobs owner).

## Tests

`npx vitest run tests/admin-customers.test.ts` — 19 tests: pure rules, roles and field rules, phone search oracle,
CSV, notes, RFM + recompute, labels and manual flags, route actions' permission order, contact guards, consents,
privacy requests + export + guest unsubscribe + erasure, merge, communication log.

`npx vitest run tests/admin-customers-review.test.ts` — the adversarial review (2026-11-11), 17 tests, 16 of them
failed on the builder's code: activity and wallet-amount field rules, fraud reason, blocked / flagged duplicates (and
the race), erasure races (return, repair), guest contacts, browsing signals and merged accounts in an erasure, the
account's unsubscribe, the finished export, address races and stale forms, 07.04's status; plus one guard: every
loader × four roles answers 200 / 403 / 404 and a forbidden intent 403.

Browser (Edge, puppeteer-core; scripts in the session scratch folder `work/admin-customers/`): every page × role
(owner, support, cashier, content) answers 200 / 403 / 404 as expected; 121 screenshots in `.shots/admin-customers/`
at 390 and 1440, light and dark, ar and en (list, profile, contact, privacy, messages, merge, segments, consents,
duplicates, dialogs, validation errors, 403s), no overflow, clean console; a click-through as the owner (note, VIP
label, recompute, export download + complete, verification, merge, merged account read-only) 7/7; print of the
request record from a dark screen. Review: 50 more in `.shots/admin-customers/review/` (blocked / flagged merge plans,
the erasure plan and its dialog, the cashier's profile without wallet events, a saved and a stale channels form);
demo records `cus_demo_crm_r1`–`r6` and request `PR-HT4M4EDP` (`.shots/admin-customers/review/seed-review.ts`).

## Requests to other owners

- **Commerce core:** a wallet transfer between two customers (one batch: debit the duplicate, credit the kept account,
  journal net zero, idempotent) so 07.05 can merge accounts holding money; a wallet payout/debit so 07.04 can erase an
  account holding money (today the request waits until the customer spends it).
- **Shell (queues):** privacy requests open / past due (`privacyCounts(db, actor, now)`) →
  `/admin/customers/privacy` (and `?view=overdue`), for `customers.privacy.manage`.
- **Orders (05), Returns (12), Finance (10):** link the customer's name on an order / RMA / wallet page to
  `/admin/customers/:customerId`.
- **Account (storefront):** a privacy request form (export / delete / unsubscribe) calling `createPrivacyRequest`
  with a customer actor, or its own service writing `privacy_requests`.
- **Jobs:** an optional daily `recomputeSegments(db, systemActor("customers.rfm"), now)`.
- **Settings (22):** keys for `RFM_RULES`, `FLAG_RULES`, `PRIVACY_DUE_DAYS`.
