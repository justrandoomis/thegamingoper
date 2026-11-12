# Admin shell

Owner: admin shell. The secure, separate admin experience the 23 blueprint modules plug into (brief §8, DESIGN.md §10,
SECURITY.md §6–7, CONTRACTS.md §4). Arabic first (right to left), English as the second admin language.

## What exists

| Path | What | Who |
|---|---|---|
| `/admin/setup` | First owner, once, with `SETUP_TOKEN` (`createFirstOwner`). Password typed twice. A plain 404 as soon as any employee exists (GET and POST); "switched off" while the token is missing or under 16 characters | nobody signed in |
| `/admin/login` | Email + password, then the authenticator code or a recovery code. Lockout and rate-limit messages name the email, never whether it exists (unknown emails are locked exactly like real ones). `?next=` = a same-origin path under `/admin` only. Signed-in employees go straight to `next`; a cross-site arrival (the Strict cookie is withheld) gets one same-site hop | anyone |
| `/admin/logout` | `POST scope=one\|all` → document redirect to the sign-in page, which says what happened | signed in |
| `/admin/locale` | `POST locale=ar\|en, back=<admin path>` → `tt_admin_locale` cookie (Path=/), document redirect | anyone |
| `/admin` | Minimal home until module 01 is built: what waits for this employee (raised clay cards only for things that need a decision), the two-step nudge, the employee's sections, module 01's blueprint status | signed in |
| `/admin/me` | My security: two-step verification (QR + typed key, recovery codes shown once with copy/download, turn off), password change, own sessions with "end" and "sign out the other devices". A password change and turning two-step on or off sign the other devices out and move this one to a new `tt_adm` token (both cookie paths, same session end; server pass 2026-11-11): a copy of the old cookie stops working. The ONLY page of an enrolment-only session (a role requires two-step verification the employee has not turned on — 2026-11-12): every other admin page sends them to `#two-step`, which then says why; turning it off is refused while a role requires it | signed in (enrolment-only too) |
| `/admin/welcome#<token>` | Set one's password with the one-time link the staff member who created (or re-opened) the account gave (`createEmployee`, `issuePasswordLink`, `enableEmployee` — auth core). The token stays in the fragment (never sent, never logged), is read once and taken out of the address bar; the page asks who the link is for, then posts it with the password typed twice. Done → "sign in" (a document link). A used, replaced or run-out link says so and what to do. The frame shows no navigation | nobody (the gate's `PUBLIC_PATTERNS`) |
| `/admin/blueprint` | 176 functions × status: legend with counts, sections × status matrix (counts link to the filtered list), filters in the URL (status, priority, section, text) | signed in, with at least one admin permission |
| `/admin/<slug>` | Landing page of a module that has no page yet: blueprint number, priority, title, status of its functions. 403 inside the shell when the role cannot see the module, 404 for an unknown name | signed in |
| `/admin/*` | 404 inside the shell | signed in |

Shell chrome (`shell/AdminShell.tsx`): a 248px rail at the inline start from 1200px (static glass, caption-headed
groups P0 first, the active module is a held ink key, queue rows carry a red bead, collapsible to 64px of icons — kept
in the `tt_admin_rail` cookie so the server renders it collapsed); a solid tool bar (search field that opens the
palette, notifications bell, employee menu); a "sections" sheet on tablets; a glass tab bar on phones with the queue
first (waiting · first module · search · sections). Command palette on Ctrl/⌘ K (also by key position, so it works with
an Arabic layout): sections, actions and blueprint functions the employee may use, Arabic/English matching that
ignores diacritics and alef/taa forms. Employee menu: My security, blueprint status, language, theme (light, dark,
device), sign out, sign out on every device. `data-density="admin"` on the whole shell; no page transitions.

## For module owners — how to plug in

1. **Routes** live under `/admin/<slug>/…` (`<slug>` = your folder = your permission group) in your own
   `routes/admin/<slug>/routes.ts`, paths relative to `/admin`. Give your module an index (`route("orders", …, [index(…)])`
   or `route("orders", …)`): it then wins over the shell's landing page automatically.
2. **The gate is coarse, you are precise.** The layout middleware (`shell/gate.server.ts`) refuses every request of a
   module whose permission group the employee holds nothing of — by the matched route pattern, before your loaders
   run. Your loaders and actions still start with `requireEmployee(ctx, getDb(), "<permission>")`, and your services
   with `assertCan`. A route registered outside `/admin/<slug>/` is refused (403) for everyone unless the gate has a rule for it — ask the shell owner.
   The cross-group rules (`ALSO_OPENED_BY`, by exact pattern): `staff.manage` (group "staff") also opens module 20's
   role editor — `admin/security/roles`, `admin/security/roles/:roleId` — and the frame's front page `admin/security`
   (its tab bar links there; every figure on it is null for that permission alone); nothing else of module 20.
   `dashboard.overview.read` (every built-in role) opens module 15's My day, `admin/staff/me` (2026-11-12); nothing else
   of module 15. Two more narrow rules (2026-11-12): `POST admin/ops/report` is open to every signed-in employee
   (`ANY_EMPLOYEE_POSTS` — the browser's own reports; a GET there is module 23's), and `admin/welcome` needs nobody
   signed in (`PUBLIC_PATTERNS`, the password-set link). An enrolment-only session opens `admin/me` only.
   The layout's middleware is `[adminGate, opsTimingMiddleware]`: module 23 times every admin request that got past
   the gate (only slow or failed ones are written; once per request even under the ops layout's own copy), and the
   shell mounts module 23's `<OpsReporter/>` for every signed-in page (one reporter per window).
3. **Page skeleton:** no `<main>` of your own (the shell's is the landmark); start with
   `<h1 className="adm-title">`; section heads `adm-h2` / `adm-h3` (Kufam only for page titles and KPI figures, §10);
   `export const meta = (args) => adminMeta(args, (t) => t("modules.orders"))` from `shell/meta` (keeps noindex and the
   admin suffix). A sticky bottom bar sits at `inset-block-end: var(--adm-bottom)`.
4. **Links:** react-router `<Link to="/admin/…">` — never `LocaleLink` (the admin's language is a cookie, not a URL
   prefix). Since 2026-11-11 `localePath` never prefixes `/admin` or `/api`, so `LocaleLink` and `Menu` items of
   `kind: "link"` keep admin paths as they are too — plain `<Link>` is still the clearer choice in admin code.
   **A customer's name** in another module opens the customer's profile only for staff who may open it: send
   `customerProfileId(actor, customerId)` (`shell/access.server.ts` — the id with customers.customer.read, else null;
   null for guests) next to the name and render `<CustomerName profileId={…}>{name}</CustomerName>`
   (`shell/CustomerName.tsx`): a link, or the plain name. Never inside a row or card that is itself a link. Used by
   orders (list, order, transfer proof), returns (list, RMA, repairs, warranties) and finance (wallet, top-up).
5. **Status:** update your own entries in `app/routes/admin/blueprint-status.ts` in the same change as the code —
   `implemented` only when staff can do it in the admin completely (with `route`), `partial` with the missing part in
   `note` (ar + en), `boundary` when only a provider/credential/owner decision is missing. Render
   `<ModuleFunctions moduleId="05" />` on your module's page (or `<ModuleLanding moduleId="05">…</ModuleLanding>` from
   `shell/ModuleLanding` until your first screen). `tests/admin-shell.test.ts` checks every route you name exists.
6. **Strings:** `useT("admin")` gives the module names (`modules.<slug>`), status words (`status.<status>`) and
   priorities; put your own in `app/i18n/messages/admin-<slug>.ts`.
7. **Queues** (the bell, the home cards, the beads): `shell/queues.server.ts` counts, each only for holders of the
   permission to act who may see its module and open the list it links to, never something the employee may not
   decide themselves, and with the module's own count function wherever the module has one. The link opens a list
   that shows the counted rows to that employee — the "truth" test opens every new queue's page for eight roles and
   compares the number with what the page says they may act on:
   - orders: transfer proofs awaiting verification → `/admin/orders/proofs`; refunds awaiting a second approval, not
     the employee's own (RMA refunds included, so returns has no refund queue of its own) → `/admin/orders/refunds`
   - pos: counted shifts with a difference nobody approved, never one the employee opened or closed, within their
     branch (`countReviewable`, pos.shift.review) → `/admin/pos/shifts?state=review`
   - customers: privacy requests still open (`privacyCounts.open`, customers.privacy.manage; staff open them for the
     customer, so there is no "own request") → `/admin/customers/privacy` (its default view, "open")
   - shipping: failed deliveries waiting for "try again" or "send back" (`countFailedDeliveries`,
     shipping.attempt.manage + shipping.shipment.read) → `/admin/shipping/attempts`; carrier settlements to reconcile
     (`countSettlementsToReconcile`, shipping.cod.settle; one query, one row per submitted settlement): one with a
     difference never to whoever created, corrected or submitted it (the core's `settlementNeedsSecondPerson`), one
     carrying cash still to record only with orders.payment.record (the core's reconcile needs it; the settlement's
     page says "permission") → `/admin/shipping/cod?status=submitted`
   - returns (`queueCounts`; both need returns.rma.read — without it the list shows only one's own RMAs): RMAs to
     decide, never one the employee opened (returns.rma.approve) → `/admin/returns?view=decide`; RMAs received and
     waiting for inspection (returns.rma.inspect) → `/admin/returns?view=inspect`
   - pricing: price changes awaiting a decision, not the employee's own request (`countDecidable`) →
     `/admin/pricing/changes`
   - inventory: stock counts submitted for approval that the employee neither started nor counted →
     `/admin/inventory/counts?status=review`; transfers in transit → `/admin/inventory/transfers?status=in_transit`
   - devices (`deviceQueueCounts`, the module's own cards; each count shares its list's filter): trade-ins to inspect
     (devices.tradein.inspect) → `/admin/devices/trade-ins?view=new`; inspected without an open offer
     (devices.tradein.offer) → `?view=inspected`; used units to inspect (devices.used.inspect) →
     `/admin/devices/used?view=todo`; ready, not listed (devices.used.list) → `/admin/devices/used?view=ready`. Accepted
     trade-ins (+ a permission that opens the trade-in list — ownership.verify alone does not) → `?view=accepted`,
     counted by the shell itself (`payoutsWhere`, the trade-in page's rules) as what THIS employee can do there: the
     data wipe with devices.ownership.verify while it is not confirmed, the payout with devices.tradein.payout once it
     is — never their own offer that only a second person may pay (`payoutNeedsSecond`, from the latest `offered`
     event). The module's own card (`toPay`) counts every accepted trade-in for either permission (review 2026-11-12:
     the bell asked a manager to pay their own offer above the guide, and a payer to pay before the wipe — the
     "trade-in payouts" test). Offers waiting for the customer's answer are not a queue (nobody here decides them)
   - purchasing (`purchasingQueueCounts`, which the module's home reads too): orders above the spending limit, never
     one the employee asked for, created, edited or submitted, within their branch (purchasing.po.approve + cost.read
     + purchasing.po.read, which the list and the order's page need) → `/admin/purchasing/orders?view=pending_approval`;
     receipts whose posting stopped (purchasing.receipt.create) → `/admin/purchasing/receipts?state=posting`; supplier
     invoices with variances (purchasing.invoice.manage + cost.read) → `/admin/purchasing/invoices?status=mismatch`
   - finance: wallet top-ups awaiting a decision, not those the employee already approved first, and wallet
     adjustments awaiting a second person, never the employee's own request (`walletQueue`; finance.wallet.read +
     customers.wallet.adjust) → `/admin/finance/wallets?status=pending_verification` and
     `/admin/finance/wallets?tab=adjustments`; draft expenses the employee may approve, not their own above the limit
     (`countDecidableExpenses`; finance.expense.manage) → `queueHref("expenses", now)` =
     `/admin/finance/expenses?from=<today − 399 days>&to=<today>&demo=1&status=draft`: the count takes drafts of any
     open month, demo ones included (never one whose posting month is closed: approving it would be `period_closed`),
     while the list alone opens on this month's real expenses — so the link asks for the list's longest range (400
     Baghdad days) and demo rows (a draft older than that would be counted, not listed). Finance's home card uses
     the same link (its loader: `queueHref("expenses", now)`)
   - security: abnormal sign-in alerts of the last 24 hours (`alertCount`, security.auth_event.read) →
     `/admin/security/sign-ins?window=24h`; roles whose access review is due — never reviewed, or not within
     `ACCESS_REVIEW_INTERVAL_DAYS` (`reviewsDue`, security.access_review.perform) → `/admin/security/retention#reviews`.
     The flagged refunds to review are NOT a queue: `unreviewedCount` counts refunds the reviewer asked for or
     approved (reviewRefund refuses those) and lists every refund of 90 days to count — asked of the security owner
   - settings: change requests this employee may decide — never their own, not expired, only keys they may change
     (`countDecidableSettingChanges`; settings.change.approve + settings.read, which the list needs) →
     `/admin/settings/changes`
   - promotions (2026-11-12): requests of the module this employee may decide — coupon and rule terms past the limits,
     flash sales, large gift cards and point adjustments — never their own (`countDecidable`; every permission of a
     kind, `DECIDE_PERMISSIONS`) → `/admin/promotions/approvals` (its "to decide" list is exactly those)
   - support (2026-11-12, `supportQueueCounts` — one query; each needs support.ticket.read, without which the inbox
     lists nothing): open tickets escalated to this employee → `/admin/support?view=escalated_me`; open tickets nobody
     holds (support.ticket.assign) → `?view=unassigned&kind=ticket`; their own tickets past due (support.ticket.reply)
     → `?view=late&kind=ticket&assignee=me` (the module's `QUEUE_LINKS`; each count is that view's total)
   - staff (2026-11-12): leave requests to decide — never their own, nor one they recorded, within their branch
     (staff.leave.approve; `staffDecisions`) → `/admin/staff/leave` (its default view: pending); payroll runs to
     approve or pay — never one they took part in, changed a salary in or that pays them, and never for a
     branch-limited approver (staff.payroll.approve; `staffDecisions`) → `/admin/staff/payroll`; salary advances
     waiting for a decision — never asked by or for the employee, within their branch (staff.payroll.approve; the
     module home's own rule, `advancesToDecide` — counted with the module's other two queues, so a failure hides all
     three and nothing else; review 2026-11-12) → `/admin/staff/payroll/advances?status=pending`
   - operations (2026-11-12, `opsQueueCounts`): open critical findings nobody has (ops.consistency.resolve) →
     `/admin/ops/consistency?severity=critical&assignee=none`; jobs failing, stuck or late (ops.job.run) →
     `/admin/ops/jobs?view=attention`; open incidents past their target date (ops.incident.manage) →
     `/admin/ops/incidents?view=overdue`
   - content (2026-11-12, optional): the content module's policies (shipping, payment, privacy, terms) not approved yet
     or with a draft waiting, never one whose draft this employee saved last (cms.page.publish; `policiesAwaiting`, the
     module home's "approved") → `/admin/cms/pages`

   The module counts run at the same time as the shell's own batch (the "speed" test records every statement: the
   batch and every module's first query — the later modules' too — are sent before any comes back, and 60 more audit
   rows, 30 more failed parcels and 30 more top-ups change no statement and no row read), each asked only of the
   employees it concerns, on the request's clock (`shell.server.ts` passes `ctx.now`); a module whose count throws is
   logged (`[admin] the <module> queues failed`) and shows none of ITS queues, and the page still loads.
   `QUEUE_HREF` / `queueHref`, icons in `TopBar.tsx`, words `notices.<id>` in `messages/admin.ts` (Arabic with all six
   plural forms, English and Sorani one/other — the "words" test). Proof: `npx vitest run tests/admin-shell.test.ts`
   ("shell data"; run the whole file — those tests need the first owner the setup tests create, so `-t` alone fails;
   the "pos, customers, devices, security and settings queues" test opens each new link for twelve roles). Ask the
   shell owner to add yours.

## Security notes

- Every admin response: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `<meta name="robots">`.
- The gate's 403 for a module the role cannot see is thrown in middleware, so React Router renders it with the ROOT
  error boundary (no shell): that is the price of refusing before any module code runs. It carries the admin's
  language: an English admin reads English first, then the Arabic line, and "Back to the admin" (seen in the browser
  2026-11-12, `.shots/platform/out/forbidden-cashier-1440-en.png`). The landing page's 403 renders inside the shell.
- Server errors: `entry.server.tsx`'s `handleError` records what React Router catches on the server (not aborted
  requests, not thrown Responses / `data()`) through module 23's `recordError`, inside `waitUntil` (2026-11-12) —
  never a failed query's bound values (`describeServerError`: Drizzle writes them after "params:" in the message and
  the stack; the record keeps the SQL and the database's reason), and a splat route under its pattern (`/admin/*`,
  never one row per address). Review 2026-11-12, `tests/admin-platform-review.test.ts`.
- `/admin/welcome`: nobody is signed in there, so its look-ups ("who is this link for?") count per address like the
  password it sets (`checkPasswordLink(…, origin)`, the sign-in limit on a counter of its own); a page asked too often
  says so (`rate_limited`) without the "open the full link" hint.
- `next`: `adminNextPath()` = `safeNextPath(…, "/admin")` + a second decode check + never back to login/setup/logout.
- The hop: only when `Sec-Fetch-Site: cross-site`, no session cookie visible and no `hop` marker yet; the page then
  `location.replace`s itself from its own origin (a link for no-JS). Browsers without fetch metadata just see the form.
- Secrets reach the auth services through `shell/env.server.ts` (route modules never import `cloudflare:workers`).

## Local demo accounts

`npx tsx --tsconfig tsconfig.cloudflare.json scripts/dev-accounts.ts` — one demo owner and one demo customer (both
`is_demo`) in the LOCAL database, idempotent (re-run after every `npm run db:reset`); credentials only in
`.dev.seed-credentials` (git-ignored, reused across resets, never printed). `--reset-mfa` turns the owner's two-step
verification off again; `--credentials-only` writes the file without touching the database (to create the owner
through `/admin/setup`). Refuses any other argument (`--remote`, …) and `APP_ENV=production`.

## Verify

```
npx vitest run tests/admin-shell.test.ts      # 36 tests: registry vs blueprint JSON, next validation, visibility per role,
                                              # navigation, gate (redirect with next, 403 before loaders, POST too, staff.manage →
                                              # the role editor only), setup once, sign-in (same failure for unknown/wrong,
                                              # lockout wording, TOTP, replay, recovery code once, hop), queues (rules, truth
                                              # against the linked pages — each accepted trade-in's own page for the payouts —,
                                              # failures, speed, ctx.now, trade-in payouts per person, words), My security,
                                              # sign-out, language
npx vitest run tests/admin-platform.test.ts   # 25 tests (2026-11-12): wave D's queues (promotions, support, staff, ops,
                                              # content; a failing module hides only its own), the gate's exceptions
                                              # (My day, the report POST, the password page, the enrolment-only session),
                                              # the timing middleware and reporter, the wave's jobs, staff accounts and links,
                                              # the hierarchy rule on sessions, two-step per role, handleError
npx vitest run tests/admin-platform-review.test.ts # 8 tests (review 2026-11-12): a closed account's link stays dead,
                                              # a new hire's unknown branch is a field error, the welcome page's look-ups
                                              # are limited, a failing staff module hides its advances too, the commissions
                                              # job keeps no pay, handleError keeps no query values and files splats by pattern
npx vitest run tests/admin-integration.test.ts # what the modules take from each other (2026-11-11): shipping's guarded fee,
                                              # returns' targets and queues, pricing's limit words, every setting's help text,
                                              # finance's expenses and home link, customer names → profile
npx vitest run tests/i18n.test.ts             # admin and admin-auth namespaces complete in ar, en, ckb
node scripts/lint-design.mjs app/routes/admin # 0 findings
```

Browser checks (puppeteer, Chromium): setup once then 404; sign-in; enrolment with QR and recovery codes; sign-in with
the app code and with a recovery code; a link from another site reaching its page through the hop; palette (Enter,
Escape returns focus); rail collapse over a reload; theme and language from the menu. Screenshots of every page at 390
and 1440, light and dark, ar and en (`.shots/admin/`), no horizontal overflow, no console errors.

## Not done / limits

- The bell and the home's list were seen in the browser at 1440 (bell) and 390 (the "waiting" tab's list), ar and en,
  light and dark, with the demo owner (integration review 2026-11-12).
- Not in the bell yet: the security module's flagged refunds to review (its count includes the reviewer's own
  refunds and reads 90 days of refunds — asked of the security owner).
- The trade-in payouts queue applies the trade-in page's rules in the shell's own query (`payoutsWhere`), while the
  devices module's card still counts every accepted trade-in: the two differ for an employee who cannot act on some
  of them — asked of the devices owner to count `toPay` the same way (then the shell can take it back).
- Records (orders, customers, SKUs, serials, tickets) are not searchable from the palette (blueprint 01.06, module 01).
- Trusted devices: not built (module 20 / auth core). Requiring two-step verification per role is in the auth core
  (2026-11-12) — the switch on module 20's role page is asked of that module; creating, enabling and password links
  for staff are in the auth core — their screens are module 15's (asked).
- The 15.06 approvals page lists the bell's queues AND the module's own leave and payroll decisions, which the bell
  now counts too (2026-11-12): until module 15 drops its own copies there, they show twice on that page.
- Recovery codes cannot be regenerated without turning two-step verification off and on (no service for it).
- The admin offers Arabic and English only; the Sorani strings exist for the catalogue test and need a native reader.
- Chromium only (no Safari/Firefox/real phones).
