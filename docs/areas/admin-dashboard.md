# Admin 01 — Command centre (`/admin`, `/admin/dashboard/…`)

Owner: admin dashboard. Blueprint module 01 (01.01–01.07). The admin home of every employee: what needs action, what
waits for their own decision, the period's figures against the span before, the funnel, role views, the global search
and the activity feed. **Read-only**: it changes nothing, so it has no POST, dialog or audit event of its own — every
action happens on the module screen its links open. Services: `app/server/services/admin/dashboard/*` (client-safe
vocabulary and view models in `types.ts` and `feed.ts`).

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin` (`admin-home.tsx`, the index) | The command centre (arrangement below): header (greeting, today's date, quick actions), search box, role views (`?view=`), period (`?period=today\|week\|month`), demo switch (`?demo=1`), branch filter (`?branch=`, only when branches exist); the KPI row (+ the 14-day trend); urgent tiles; the bell's queues (from the layout's data); role cards; latest activity beside the funnel; sections; `<ModuleFunctions moduleId="01">`; prints without the chrome | any signed-in employee (each card by its own) |
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

## Arrangement and look (Design v2.1, client note 12 — 2026-11-12)

The admin keeps Lens & Clay 1.0 (`app/styles/admin.css`: walled clay keys, wells, raised decision cards); titles and
KPI numerals are Kufam through the tokens (`--font-head`, `--type-kpi`). Top to bottom:

1. **Header row** — eyebrow + today's date chip (Baghdad, from the loader's `today`), «أهلاً، …», the lead; on the
   other side the **quick actions** this employee really has (`home.server.ts quickActions`): «بيع جديد» →
   `/admin/pos/sell` (`pos.sale.create`, the till's own loader), «منتج جديد» → `/admin/catalog/new`
   (`catalog.product.create`), «اطبع» (whoever sees figures). Clay keys, never red (nothing here commits).
2. **Tool row** — the compact search (label for screen readers, the hint as placeholder and description), the role
   views (own link tabs, `tools.tsx ViewTabs`: an ink marker that slides from the old view — a FLIP of the marker,
   settle spring), the period as the 1.0 **key bank** (three clay keys in a `.well`, the chosen one held down) and the
   demo switch; the comparison note and the demo notice under it. The tabs and keys answer a click at once
   (`usePendingFilters`: the next view/period while its loader runs) and the figures wait behind a shimmer.
3. **KPI row** («أرقام اليوم / هذا الأسبوع / هذا الشهر») — `KpiRow`: one flat paper tile per figure (an icon disc,
   the figure in Kufam with its currency smaller after it — `KpiMoney`, the comparison **chip** — `DeltaChip`: arrow +
   percentage, green when good for the store, red-ink when bad, neutral for open orders, the whole sentence for screen
   readers — and the definition). Each tile's frame stays on screen across periods; its body streams in (skeleton →
   figure counting up). The figure is always ONE line: `figureFit` estimates its width (Kufam digits 0.62em, separators
   0.3em, the currency at its 12px floor, the arrow) and a long amount takes a smaller size (never below 18px) instead
   of breaking inside «د.ع»; the line keeps its height, so the figures of a row stay level. With the demo rows the row's
   title carries «تجريبي» once (each tile's head stays one line). **New orders** carries the **14-day trend**
   (`TrendChart`, `trend.server.ts`): orders placed per Baghdad day from the reports module's own `salesReport`
   (by day) — the same definition as the tile (today's column = the tile's figure for "today"), thin columns on a
   hairline, today in ink, the days before in `--line-strong`, a zero day draws nothing; pointing or the arrow keys
   read one day on the line under it, a visually hidden table holds every value, «التقرير اليومي» opens the report.
   Only for `reports.sales.read` holders who see the whole company (`mayOpenReport`), never with a branch filter.
4. **يحتاج تصرفاً** — the urgent tiles with their **severity**: a stripe on the start edge, the icon's disc and a word
   («عاجل» late orders and urgent tickets; «يحتاج متابعة» mismatched payments, low stock, or no urgent ticket but some
   past their due time); raised clay only when the count is above 0; an empty tile lies flat with a check. The four
   share one row from 1024px. Then the bell's queues (raised cards) and the two-step notice.
5. The role cards (money / stock / inbox), then **latest activity beside the funnel** (two columns from 1200px; the
   funnel steps are label | bar | value with the share and the span before under it; an all-zero funnel says so in one
   line instead of rows of zeros), then the sections and the module's functions.

**Every KPI that links opens a list counting the same records** (`home.server.ts kpiLinks`, checked against the lists
in `tests/admin-dashboard-home.test.ts`): paid sales and the average basket → the sales report for the same days and
demo choice (its own operational figures; not for a branch, only for who may open it); new orders and open orders →
the orders list for the same days / the open statuses, only when the figures include the demo rows or the store is live
(that list has no demo filter) and no branch; net profit → profit and loss for the same days and demo choice. A figure
whose list would count something else is shown without a link.

**Motion** (all on `html[data-motion="full"]` only — nothing under reduced motion, the store's reduce-motion setting or
the lite tier; transform and opacity only; nothing moves layout): a figure counts up once from 0 (`CountUp`, 720ms
ease-out; the final text reserves its cell; server HTML waits behind a shimmer until the page is live, a fallback shows
the plain figure after 2.4s if scripts never run; StrictMode-safe); cards fade up 10px with a 50ms stagger
(`.dash-rise` + `rise(i)`); streamed bodies fade in (`.dash-arrive`); funnel bars and trend columns grow from their
baseline; skeletons pulse (`Skeleton`). Print drops all of it.

**Review (2026-11-12)** — what the reviewer of this round fixed, each with its test or measurement:

- **Bidi of negative amounts.** ICU writes an Arabic negative as LRM + "-", and the kit's own minus is "‎−": inside a
  first-strong isolate (`<bdi>` without `dir`, or U+2068) that mark turned the amount left to right and put the currency
  BEFORE the figure in an Arabic line («د.ع −17,917»). `Money` and `KpiMoney` now isolate in the page's direction
  (`<bdi dir>`), the comparison's earlier figure with `isolate(text, dir)` (U+2067 / U+2066). Use `isolate()` for any
  amount set inside a sentence.
- **Skeletons hold the height of what replaces them (load CLS 0.051 → 0).** The KPI skeleton keeps the trend's place
  on new orders (`KpiSkeleton trend`), the chip's line (`Skeleton size="chip"`), the figure's own line (`size="figure"`
  inside `.dash-kpi__value` / `.dash-tile__count` = `1lh`); `TrendSkeleton` = the chart's 40px and the same foot (window
  text + the report link's box, unseen); `TileLoading` = an empty tile's lines and its key (`size="key"`). Measured: the
  loading KPI row and the loaded one are the same height at 1440 and 1000 (ar, en); at tablet widths a comparison that
  wraps to two lines can still add a line.
- **The profit-and-loss link** beside the figures only for `finance.report.read` (`mayOpenProfitAndLoss`) — the net
  figure needs cost.read + profit.read, which a role may hold without the report.
- **Activity** with no kind chosen says «لا نشاط بعد.» (`activity.emptyAll`), not «… من هذا النوع».

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
| Orders per day, last 14 days (overview, finance; on the new-orders tile) | + `reports.sales.read`, whole company, no branch filter | the reports module's `salesReport` by day (`trend.server.ts`), one call |

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

Route-side (this folder): `home.server.ts` `quickActions(actor)` / `kpiLinks(actor, filters, storeMode, now)` /
`mayOpenProfitAndLoss(actor)` · `components/kit.tsx` `isolate(text, dir)` · `components/cards.tsx` `figureFit(text,
linked)` ·
`trend.server.ts` `ordersTrend` / `mayShowTrend` / `trendRange` (+ `trend.ts` `TREND_DAYS`, `OrdersTrend`) ·
`components/kit.tsx` `CountUp`, `Skeleton`, `rise`, `DeltaChip`, `usePendingFilters`, `Severity` (beside the 1.0
`KpiCard` / `DeltaLine` / `CardLoading`, kept) · `components/cards.tsx` `KpiRow`, `KpiBody`, `KpiSkeleton`,
`KpiFailed`, `KpiMoney`, `TrendChart`, `TrendSkeleton`, `tileSeverity` (beside `SalesKpis` / `ResultKpi`, kept) ·
`components/tools.tsx` `SearchBox({ compact })`, `PeriodBar({ notes })`, `PeriodNotes`.

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
npx vitest run tests/admin-dashboard-home.test.ts   # 16 (v2.1): quick actions per permission, every KPI link = its
                                                   # list's figure (orders, open orders, sales report, P&L), the trend
                                                   # = the report's orders per day (today = the KPI), who gets it,
                                                   # severity words, the comparison chip, server-rendered figures;
                                                   # review: negative amounts isolated in the page's direction, the
                                                   # skeletons' parts, the figure fit, the P&L link's permission
npx vitest run tests/admin-auth-adversarial.test.ts tests/admin-shell.test.ts tests/i18n.test.ts
node scripts/lint-design.mjs --strict app/routes/admin/dashboard app/styles/admin.css   # 0 findings
```

Browser (Edge, puppeteer; scripts and shots in the module's scratch folder): every page and state at 390 and 1440,
light and dark, ar and en — owner (overview, each role view, demo on), finance / inventory / support / cashier / no-role
homes, search (empty, filled, too short, nothing found, a cashier's masked results, 403), activity (all, one kind, 403),
the printed page; no horizontal overflow, no console errors, every streamed card arrived. v2.1 (2026-11-12): 1440 /
1280 / 1024 × light / dark × ar / en, the role views, demo on, 390; the count-up sampled frame by frame on a first load
and after a period switch (0 → n, never below 0), the tab marker's slide, and none of it under reduced motion. The dev
database holds no orders: the cards with figures were also drawn from sample data through the real components and the
admin's stylesheets (a scratch harness, never shipped).
