# Admin 18 — Reports & Business Intelligence (`/admin/reports/…`)

Owner: admin reports. Blueprint module 18 (18.01–18.07). Reads; writes only `saved_reports` and audit events. Revenue,
cost and profit come from the accounting core (`accounting/reports.server.ts`, docs/metrics.md) — no second formula.
Services: `app/server/services/admin/reports/*` (client-safe URL state and view models in `types.ts`, the dictionary in
`dictionary.ts`, the XLSX writer in `xlsx.ts`). Strings: `app/i18n/messages/admin-reports.ts`.

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin/reports` | The reports this employee may open (each with its function), their saved and shared reports, the limits, `<ModuleFunctions moduleId="18">`. Computes nothing | any `reports.*` |
| `/admin/reports/sales` | 18.01 — totals of the books (revenue at delivery, discounts, refunds, delivery income, net) and of the orders (placed, GMV, average basket, cancellation, paid sales, refund and return rates, units); rows by `by=day\|platform\|branch\|channel`; rows + "not attributed" = the books, checked on every request (`consistent`) | `reports.sales.read` |
| `/admin/reports/margin` | 18.02 — net margin per SKU (sort, search, page in the URL) with the books for the same dates | `reports.margin.read` (+ `cost.read`, `profit.read` for those columns) |
| `/admin/reports/inventory` | 18.03 — `view=abc` (basis revenue \| units, `class=A\|B\|C`), `view=turnover\|dead` (module 04's report, `days=30…365`) | `reports.inventory.read` (+ `inventory.report.read` for 04's views) |
| `/admin/reports/customers` | 18.04 — `view=cohorts` (first-purchase months of the range, 12 months each) · `view=value` (lifetime, RFM segments) | `reports.customer.read` |
| `/admin/reports/performance` | 18.05 — `view=suppliers\|employees\|shipping\|support` (`days=7\|30\|90` for support) | `reports.performance.read` (+ `staff.performance.read`, `support.metrics.read` for those sections) |
| `/admin/reports/saved` | 18.06 — saved reports: open, rename / share (owner), delete with a reason (owner, confirm dialog); POST `intent=create\|update\|delete` | any `reports.*` (changes: `reports.saved.manage`) |
| `/admin/reports/export` | 18.06 — `GET ?report=<key>&format=csv\|xlsx&<the report's parameters>`; 404 for anything else | `reports.export.create` + the report's |
| `/admin/reports/dictionary` | 18.07 — the metrics dictionary, `?q=` search | any `reports.*` |

Every report: range in the URL (`period=YYYY-MM` or `from`/`to`, ≤ 400 Baghdad days; finance's `parseRange`; month,
days, page and demo typed in Arabic-Indic or Persian digits are read as digits first — `latinParams`), `demo=1`
adds demo rows (left out otherwise), printable (`.rep-print`: the chrome hidden, light ink whatever the theme), CSV and
XLSX of exactly what the page shows, "save this view". Tables from 768 px, cards on phones; links and GET forms only
(works without JavaScript); the save / edit / delete dialogs need it.

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Missing / note |
|---|---|---|
| 18.01 | implemented | |
| 18.02 | implemented | Card-terminal fees are recorded nowhere, so they are not in it |
| 18.03 | implemented | Turnover and dead stock need `inventory.report.read` (module 04's own report) |
| 18.04 | implemented | Customer value = what the store kept (07's); a profit-based value is not computed yet |
| 18.05 | implemented | Employees and service sections need their module's permission |
| 18.06 | partial | Scheduled delivery is a boundary: no e-mail provider |
| 18.07 | implemented | Read-only by design |

## Rules

- **One definition.** Totals are the core's `revenueRecognised` / `profitAndLoss`. Breakdowns split the SAME journal
  lines (`revenue.server.ts`): the four revenue families by `systemRoots` (an accountant's sub-account counts with its
  parent), lines joined to their header, demo entries only when asked. An entry belongs to an order when it is the
  order's posting (`ref_type order`) or a refund of it (`refund` → `refunds.order_id`); anything else is "not
  attributed" and shown. Day = the entry's Baghdad day; channel / branch = the order's (web = "online", a counter sale
  without a branch has its own row); platform / SKU = the order's amounts split over its lines exactly to the dinar
  (pricing 03's `allocateAmount`): revenue, discount, delivery income by line value, a refund by the items it names —
  one paid BEFORE delivery too (it reaches sales refunds inside the sale's own posting: each such refund by its items).
- **Net margin per SKU** = metrics §4 "Profit of one order" for the orders whose sale was recognised in the range, as
  of now, per line: line total − discount share − refunds (items, else value) − COGS (the order's own `sale`
  movements at FIFO landed cost, less `return` movements; a used device at acquisition cost; no cost = "uncosted",
  counted) − commissions (per order item, void left out) − (carrier charges − delivery fee, by value; a parcel without a
  charge = "carrier cost not recorded"). Beside it the period books (timing differences explained on the page).
- **Fields.** Cost figures (COGS, delivery, landed cost) only with `cost.read`; commissions, profit and margin only with
  `cost.read` + `profit.read` — ABSENT from the loader data, the CSV, the XLSX and the print otherwise (tested).
- **Never widen.** Every report sums the whole company: an employee limited to a branch is refused (`branch`, 403),
  and offered no report, export, saving or saved report (`reportsAccess`, `mayOpenReport`) — the menu, the cards and
  the dictionary's links never end on a 403; the front and saved pages say why.
  Sections built on another module's service need that module's read permission, which its service checks
  (inventory 04 `inventoryReport`, staff 15 `performance`, support 14 `supportMetrics`); the page says what is
  needed. Supplier ratings (09 `supplierRatings`) and the shipping figures carry no cost. The employees section sends
  only counter sales, refunds and packing (`EmployeePerformance`): module 15's pay and attendance stay on its page.
- **Shipping performance** (computed here, over parcels handed over in the range, demo orders left out): success =
  delivered ÷ (delivered + returned); first attempt = delivered without a failed `delivery_attempts` row ÷ delivered;
  days to deliver and cash-on-delivery settlement days (settled − delivered) as medians; what waits, the oldest age.
- **Customers.** A purchase and its value are module 07's (paid − refunded > 0, not cancelled; merged / erased
  accounts out); segments by 07's `rfmOf`. Guests are counted apart. Aggregates only.
- **Limits.** A line-level report (platform, margin, ABC) reads at most 5,000 orders (`MAX_LINE_ORDERS`): above, it
  says so and shows no partial total; parcels 20,000; exports 10,000 rows (the file says when it stopped).
- **Saved reports** (`saved_reports`): saving needs `reports.saved.manage` + the report's permission; the parameters
  are normalised through the report's own parser (`savedParamsOf`: never a page, never an unknown value); id from the
  form's key (a double submit = one record, `replayed`); a shared report shows to those who may open its report and
  opens with THEIR permissions; only the owner renames / shares (guarded on `updated_at` → `saved_changed`) or deletes
  (reason ≥ 3, confirm dialog with the impact); every change one batch with `reports.saved.create|update|delete`.
  The name, the saved values and the reason lose control, bidi-override and invisible characters before they are
  judged and stored (text.server `cleanLine`; a stored one is cleaned on the way out too).
  `schedule` / `recipients` stay empty: scheduled delivery needs an e-mail provider (boundary).
- **Exports** (`reports.export.create`): CSV with module 04's writer (BOM, formula-safe cells, CRLF), XLSX with
  `xlsx.ts` (stored ZIP + CRC-32, inline strings — a leading "=" stays text, right-to-left sheet in Arabic, bold frozen
  header); module 04's views use its own CSV (`inventoryReportCsv`; in XLSX its SKU and name stay text). The margin
  file's total row is its rows' own (`marginTotals`: a search keeps its total, each order once; the carrier column
  counts orders without a carrier charge). One audit event per file:
  `reports.export.create` {format, params, rows, truncated, includedProtected {cost, profit}}. `no-store`.
- **Dictionary.** `dictionary.ts` mirrors every metric table of docs/metrics.md (§3–§6, §8; not §1, §2, §7) under the
  same English name — `tests/admin-reports.test.ts` fails when the two drift — and adds the reports' own figures, each
  written from those definitions or from the owning module's rule. A metric added to docs/metrics.md needs its entry
  there and its words (`dict.metric.<id>`, ar/en/ckb). `reports.dictionary.manage` has nothing to edit: a definition
  changes with the document and its code.

## Verify

```
npx vitest run tests/admin-reports.test.ts tests/admin-reports-routes.test.ts   # 23 + 8: the June scenario reconciled
      # with the core in every breakdown, platform split and refund-by-item, margin by hand (68,000 for one order),
      # fields absent per permission (page, CSV), ABC, cohorts (null months), shipping, sections' permissions,
      # every role, saved reports (normalised, idempotent, owner-only, stale, reason, audit), CSV injection, XLSX
      # package + CRC, dictionary vs docs/metrics.md, loaders 403/200, export route, saved action (Arabic digits)
npx vitest run tests/admin-reports-review.test.ts   # 12, the review of 2026-11-12 (each failed on the builder's code):
      # free text cleaned, Arabic-Indic / Persian digits in URLs, module 04's XLSX text, branch-limited employees,
      # a refund paid before delivery, the margin file's total row, the search keeps the sort, the too-many sentence,
      # no pay in the employees section
npx vitest run tests/i18n.test.ts tests/admin-shell.test.ts
node scripts/lint-design.mjs app/routes/admin/reports app/server/services/admin/reports   # 0 findings
```

Browser (Edge, puppeteer; scripts and shots in the run's scratchpad `work/admin-reports/`): every page in four
combinations (1440 light ar, 1440 dark en, 390 light en, 390 dark ar), empty months, the reader without cost, the
section needs, 403 (gate and page), and the flows — save a view (dialog, field error, toast), the saved list, edit,
delete (confirm with impact, a too-short reason refused) — no console errors, no sideways scrolling. The review's
sweep (`work/admin-reports/review/`: 89 shots, two saved-report flows, print from a dark screen) repeated it.

## Not done / limits

- Scheduled delivery (no e-mail provider); no chart beside the daily table (the table and the CSV only).
- Payment-processing fees: no gateway; POS card-terminal fees are not recorded anywhere (module 06 / 10).
- A returned used device is not subtracted from units sold (no stock movement records it).
- A profit-based customer value (the marketing section of docs/metrics.md points here): not built — it needs per-order
  profit per customer (the margin engine) over the customer's whole history.
- Exports are synchronous files (≤ 10,000 rows); `export_jobs` (asynchronous files) is not used.
- Branch-limited employees get no report (whole-company figures); per-branch reports would need branch filters in the
  core's statements.
