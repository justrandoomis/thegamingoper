# Admin 01 — Command centre (`/admin`, `/admin/dashboard/…`)

Owner: admin dashboard. Blueprint module 01 (01.01–01.07). The admin home of every employee: what needs action, what
waits for their own decision, the period's figures against the span before, the funnel, role views, the global search
and the activity feed. **Read-only**: it changes nothing, so it has no POST, dialog or audit event of its own — every
action happens on the module screen its links open. Services: `app/server/services/admin/dashboard/*` (client-safe
vocabulary and view models in `types.ts` and `feed.ts`).

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin` (`admin-home.tsx`, the index) | The command centre: search box, role views (`?view=`), period (`?period=today\|week\|month`), demo switch (`?demo=1`), branch filter (`?branch=`, only when branches exist); urgent tiles; the bell's queues (from the layout's data); KPIs; funnel; role cards; latest activity; sections; `<ModuleFunctions moduleId="01">`; prints without the chrome | any signed-in employee (each card by its own) |
| `/admin/dashboard/search?q=` | Global search: orders, customers, SKUs, serial numbers, tickets and repairs with quick actions; a GET form; `&limit=1..10` for a palette's fetcher | `dashboard.search.use` |
| `/admin/dashboard/activity?kind=&before=` | The whole feed: price changes, returns, approvals; 25 a page, "older" by sequence | `dashboard.activity.read` |

`/admin/dashboard` stays the shell's landing route (it redirects to `/admin`). The file keeps the name `admin-home.tsx`:
`tests/admin-auth-adversarial.test.ts` imports its loader.

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Missing / note |
|---|---|---|
| 01.01 | implemented | Net profit is not available per branch (the journal is store-wide) |
| 01.02 | implemented | Mismatched payments = imported statement lines matching no payment (module 10's list) |
| 01.03 | partial | No visit step (no analytics provider — owner's decision); no device split (carts and orders record no device — schema) |
| 01.04 | implemented | The branch filter appears once module 21 has branches (none yet) |
| 01.05 | implemented | |
| 01.06 | implemented | The Ctrl/⌘ K palette does not search records yet (asked of the shell owner) |
| 01.07 | implemented | |

## Cards, permissions and sources

Every card needs `dashboard.overview.read` and its own permission (`shared.server.ts dashboardAccess`); the loader asks
only for the cards of the chosen view that the employee may see, so a missing card is absent from the data, not empty.

| Card (view) | Permission | Source — never a second formula |
|---|---|---|
| Paid sales, new orders, open orders, average basket (overview, finance) | `dashboard.sales.read` | `kpis.server.ts salesCard`, docs/metrics.md §3, one `db.batch` |
| Net profit (overview, finance) | + `cost.read` + `profit.read` | finance's `profitAndLoss` (accounting/reports.server.ts) for both spans |
| Late orders (overview, warehouse, support) | `dashboard.alerts.read` + `orders.order.read` | `listOrders(flag=late)` — the orders list itself |
| Mismatched payments (overview, finance) | + `finance.settlement.reconcile` | `listStatementLines(status=unmatched)` over the list's longest range |
| Low stock (overview, warehouse) | + `inventory.stock.read` | `listStock(state=low, sort=available)` |
| Urgent tickets (overview, support) | + `support.ticket.read` | `listInbox(priority=urgent, sort=due)` + its `late` view count |
| Waiting for your decision (every view, filtered by view) | the bell's own rules | `useAdminShell().waiting` — shell/queues.server.ts, no query here |
| Funnel (overview) | `dashboard.funnel.read` | `funnel.server.ts`, one `db.batch` |
| Money held and owed (finance) | `finance.report.read` (+ `finance.wallet.read` for the wallet) | metrics §5, one `db.batch`; cash on delivery opens the settlements page with the card's demo choice (same figure) |
| Stock now (warehouse) | `inventory.stock.read` (+ `orders.fulfillment.pack` for "to pack") | `inventoryOverview` (stock value dropped) + the orders list's WHERE; a figure links only to a list that counts the same records (`stockCard().links`) |
| Support inbox (support) | `support.ticket.read` | `inboxCounts` (each = its view's rows) |
| Latest activity (overview, finance) | `dashboard.activity.read` | `activity.server.ts` over `audit_events` |

A tile's number is the `total` of the module's own list called with exactly the filter its link opens, for this
employee — the shell's "truth" rule; its first three rows come along. Raised clay only when the count is above 0.
The stock card follows the same rule: inventory's overview counts active SKUs of products that are not archived, its
stock list counts every SKU, so SKUs with stock, units, low and below zero are shown without a link (as on the inventory
home); sold out opens the reorder list (`show=out`, the overview's SKUs). Its "low" row is left out when the low-stock
tile is on the page (two different "low" numbers on one page otherwise; asked of the inventory owner).

## Rules

- **Streaming.** Each card is a promise that never rejects (`settle`: data, or `{ ok: false }` logged as
  `[dashboard] the <card> card failed`); `<StreamedCard>` = `<Suspense>` + `<Await>` keyed by the URL, so a new period
  shows placeholders at once and one slow module never holds the page. A failure says "could not be computed", never 0.
- **Periods** (Iraq time, `types.ts periodSpans`): today until now vs yesterday until the same time; this week from
  Saturday vs last week to the same moment; this month vs the same days of last month (cut at its end).
- **Open orders at a past moment**: the status an order had then = its last `status_changed` event before it, else the
  status of its `placed` event, else (no history at all) its status now. The same definition as now, read from history.
- **Demo**: metrics leave demo rows out (`?demo=1` adds them, with a notice). Carts carry no demo marker: a cart that
  became a demo order is left out with it. Tiles show the module lists as they are (demo rows tagged).
- **Branch**: an employee with `branchId` always sees their branch (`effectiveBranch`). Web orders and carts belong to no
  branch, the journal is store-wide: net profit and the web funnel say "not available for a branch".
- **Activity feed** (`feed.ts`): an action shows only when listed (fail closed), to holders of the permission that opens
  that record's screen; links only to such pages. Only two snapshot fields are read, in SQL (`priceIqd` before/after —
  the public selling price) plus a top-up's reference; the rest never leaves the database. Lines of the cost families
  (`purchasing.*`, `finance.*`, module 20's `snapshotWithheld`) lose their reason without `cost.read`. Branch-limited
  employees do not get branch-scoped lines (purchasing, staff, POS, counts, used-device prices). Used-device price
  lines need pricing's own `SPECIAL_READERS` (the page they open). A gift card's approval is its `issue` event carrying
  an approval (`onlyWith`); a card issued alone is no line. A customer actor is "a customer", never named.
- **Search** (`search.server.ts`): orders through the orders list's `listWhere`, customers through `customerWhere`
  (their own rules: part of a number only with `customer.phone.read_full`, merged / deleted accounts left out); phones
  masked with the modules' `phoneFor` / `phoneView`; SKUs: the public selling price, availability only with
  `inventory.stock.read`; serials (exact, or from 4 characters their start): `inventory.serial.read` + `.stock.read` or
  `devices.registry.read`; tickets / repairs: the support inbox's own `listInbox` (view all, newest first — order and
  return references, e-mail too), so the group is the first rows of its "see all". No cost, file or full phone is ever
  selected. Quick actions are links, each only where the employee may open it.
- **D1's LIKE limit** is 50 BYTES (an Arabic letter 2, "…" / "’" / a PDF's presentation forms 3, an emoji 4): every
  text that reaches a LIKE — ours, a module's WHERE, a "see all" list — is `likeNeedle(q)`, the longest start that fits
  escaped. A group whose module fails is `failed` (logged without the typed values) and says so; the others answer.
  `cleanQuery` folds compatibility forms first (NFKC): text pasted from a PDF finds the catalogue's ordinary letters.
- **Keys**: no loader key or message key contains cost / margin / profit / proof (the shell's payload scan).

## Exports (CONTRACTS.md §4 "01 dashboard")

`globalSearch(db, actor, { q, limit? }, locale, now)` (for the palette) · `salesCard` / `resultCard` · `funnelCard` ·
`lateOrdersAlert` / `unmatchedPaymentsAlert` / `lowStockAlert` / `criticalTicketsAlert` · `moneyCard` / `stockCard` /
`inboxCard` · `activityFeed` / `readableActions` / `FEED_RULES` · `dashboardAccess` / `viewAccess` / `effectiveBranch` /
`settle` · `periodSpans` / `compare` / `parseDashboardFilters` / `dashboardSearch` / `cleanQuery` · `likeNeedle`.

## Honest limits

- Visits and the visitor conversion rate: no analytics provider is connected (boundary; shown on the funnel).
- Device split: neither carts nor orders record the shopper's device (asked of the schema owner).
- The Ctrl/⌘ K palette (shell) does not call `globalSearch` yet (asked of the shell owner).
- No saved dashboards or customisable card order (blueprint UX rule "customizable tables"): URL state only.
- Chromium only; Sorani strings need a native reader.

## Verify

```
npx vitest run tests/admin-dashboard.test.ts        # 26 tests: periods, metrics, access per role, tile truth, funnel,
                                                   # feed permissions and pages, search field rules, routes and 403s
npx vitest run tests/admin-dashboard-review.test.ts # 13 (review): LIKE limit, pasted PDF text, failed groups, tickets =
                                                   # inbox, stock and money links = their lists, feed approvals and
                                                   # used-device lines
npx vitest run tests/admin-auth-adversarial.test.ts tests/admin-shell.test.ts tests/i18n.test.ts
node scripts/lint-design.mjs app/routes/admin/dashboard   # 0 findings
```

Browser (Edge, puppeteer; scripts and shots in the module's scratch folder): every page and state at 390 and 1440,
light and dark, ar and en — owner (overview, each role view, demo on), finance / inventory / support / cashier / no-role
homes, search (empty, filled, too short, nothing found, a cashier's masked results, 403), activity (all, one kind, 403),
the printed page; no horizontal overflow, no console errors, every streamed card arrived.
