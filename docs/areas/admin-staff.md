# Admin 15 — Employees & HR (`/admin/staff/…`)

Owner: admin module 15. Services `app/server/services/admin/staff/*`, the core file `app/server/services/accounting/payroll.server.ts`
(payroll postings), routes `app/routes/admin/staff/*`, strings `app/i18n/messages/admin-staff.ts` (ar source, en, ckb),
tests `tests/admin-staff.test.ts` (14), `tests/admin-staff-payroll.test.ts` (10), the review's `tests/admin-staff-review.test.ts` (8),
the follow-up's `tests/admin-staff-followup.test.ts` and the QA fix's `tests/admin-staff-accounts.test.ts` (4: staff accounts from the admin).
Arabic first (RTL), English second.

## Routes (`routes.ts`; `layout.tsx` loads the strings once, the section tabs this role may open, an in-shell error boundary)

| Path | What | Permission |
|---|---|---|
| `/admin/staff` | what waits for this employee's decision (raised cards), the team today, sections, honest limits, `<ModuleFunctions moduleId="15">` | any staff.* |
| `/admin/staff/me` | my day: clock in / out, this week's shifts, my leave (ask, withdraw), my tasks, my commissions, my payslips | any staff.* (gate rule requested for everyone) |
| `/admin/staff/approvals` | 15.06: the bell's own queues + this module's decisions, my requests awaiting others, the store's pending requests | any; store view staff.approval.read |
| `/admin/staff/employees` | 15.01 directory: search, status, role, demo, sort, page in the URL; «add an employee» (a dialog; `?add=1` opens it — module 20's staff list links here): the one-time password link shown once on the page | staff.employee.read or staff.manage; adding: staff.manage |
| `/admin/staff/employees/:id` | effective permissions (read-only), HR facts, signing in (password set or not, a new link, re-enabling), pay, this month, live sessions, sign-in log, ending access | same; parts by permission (below) |
| `/admin/staff/schedule` | 15.02 week roster (Saturday–Friday), add, cancel, mark worked/missed, copy a week | read: employee.read / schedule / attendance; write: staff.schedule.manage |
| `/admin/staff/attendance` | records by day range / employee / state, manual entry, correction, bulk approval | staff.attendance.manage or staff.schedule.manage |
| `/admin/staff/leave` | requests (pending first), approve / reject, record for someone, cancel | staff.leave.approve or staff.employee.read |
| `/admin/staff/tasks` | tasks: assign, move, hand over, cancel | everyone sees their own; the team's list: staff.task.manage or employee.read |
| `/admin/staff/commissions` | 15.03 versioned plans, the month's commissions per employee and line, compute | staff.commission.manage or staff.payroll.read |
| `/admin/staff/payroll` | 15.04 runs; what a run of a month would pay now; prepare | staff.payroll.read / .run / .approve |
| `/admin/staff/payroll/advances` | salary advances: ask, decide, withdraw | same |
| `/admin/staff/payroll/:runId` | one run: lines, bonus/deduction, defer an advance, recompute, approve, pay, void; payslips print | same |
| `/admin/staff/performance` | 15.05 each employee's month, no cost | staff.performance.read |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

- **15.01 implemented** — directory + each employee's effective permissions read-only (by module, field permissions marked, the
  granting role); roles edited only in `/admin/security/roles` (module 20; the gate opens it to staff.manage). Adding an employee
  and their first password through the auth core (QA fix 2026-11-12; "Staff accounts" below).
- **15.02 partial** — roster, attendance, leave, tasks. Missing: a role with no staff.* permission (a cashier) cannot reach
  `/admin/staff/me` until the gate opens it to every employee (requested). POS cash-drawer shifts stay module 06's (linked).
- **15.03 implemented** — versioned plans, sales or realised profit (profit.read), returns as clawbacks at the next computation.
- **15.04 partial** — runs, bonuses, deductions, advances, two people, postings. Missing: an off-cycle settlement for one leaver,
  advances in instalments, a salaries-payable account (pay is booked when paid).
- **15.05 implemented** — performance without any cost, margin or profit; commission only for who sees pay.
- **15.06 partial** — one view linking to each module's decision screen. Missing: a till discount above the cashier's limit and a
  direct stock adjustment have no request/approve step (modules 06, 04).
- **15.07 implemented** — ending access via the auth service's `disableEmployee` + housekeeping; sessions and sign-in log.

## Rules

- **Two people.** A payroll run is approved by staff.payroll.approve holders who neither prepared, recomputed, edited nor
  deferred an advance in it, nor changed (`staff.payroll.salary_set`) the salary of one of its employees after that salary was
  last COMPUTED into a paid run (`lastPaidComputationSql`: the latest prepare/recompute of the employee's last paid run — not its
  payment: a run computed before a raise and paid after it never paid the raise; review 2026-11-12), nor anyone the run pays —
  checked before and again inside the approval batch (`approverInvolvedSql`); the approver approves the count
  and net they saw (`run_changed` otherwise). Advances: never decided by the requester (`approver_is_requester`) nor the employee
  (`advance_beneficiary`). Leave: never decided on one's own, nor by whoever recorded it for someone (`leave_self_decision`; the
  recorder is the `staff.leave.request` audit actor). Attendance: nobody records, corrects or approves their own, nor marks their
  own shift worked or missed (`attendance_self_approval`). Salaries: never one's own (`salary_self_change`).
- **Branch limits** (module 20 limits an employee to a branch; review 2026-11-12). A limited employee works with the staff of
  that branch only — never someone of another branch or of the whole store (no branch): every list, count and picker is
  scoped (`reachSql`, `employeeOptions({ branchId })`), every change on someone else's record refuses with 403 `forbidden`
  ("branch"; `assertReach` / `assertReachOf`). Payroll runs cover every branch: no run page, preview, preparation, approval,
  payment or void for a limited employee (`assertWholeStore`); advances stay per employee (their branch's).
- **Decisions are zod-validated as sent**: a missing or unknown `decision` / `status` posted to leave, advances or a shift's mark
  is a 400, never read as "approve" or "worked".
- **Books only through the core.** Paying a run = ONE batch: approved → paid (guarded), commissions → paid, advances → settled
  (sum guarded = the run's deductions), `postPayrollRun` (Dr payroll = base + bonus − advances − other; Dr/Cr commissions;
  Cr cash or bank clearing = net; key `payroll_run:<id>:paid`). An advance handed out: `postEmployeeAdvance` (Dr payroll /
  Cr cash or bank, key `staff_advance:<id>:paid`) in the batch that inserts it. A replayed payment returns `replayed: true`.
- **Nothing counted twice.** Commission rows and advances are linked to a run (`payroll_run_id`, `settled_run_id`) in the
  run's batch with `expectChanged` = the rows named; a base already paid in another run of the month is subtracted; one open
  run per month and kind (real `pyr_…` / demo `pyd_…`, never mixed; a demo run posts a demo entry).
- **Base** = monthly × payable days ÷ days in month; payable = days employed in the month (account creation → disabling)
  minus approved unpaid leave. Clawbacks that would take a line below zero wait; advances are deducted whole, oldest first,
  while the net stays ≥ 0, the rest wait; a deferred advance stays deferred on recompute.
- **Commissions.** Seller = `orders.cashier_id` (web orders earn nothing); delivered orders only; a demo order only for a
  demo seller. Most specific plan in force at delivery: employee › role › everyone, inside a level pricing's `commissionFor`.
  Base: line total − share of the order discount, × kept ÷ sold, − share of refunds without items; profit base − landed unit
  cost (`cost_snapshot_iqd`) × kept; unknown cost → "uncosted", never 0. Rows are `com_<order item>_<n>` (a concurrent
  computation fails `commission_sync_busy`); later deltas are `clawback`/`earn` rows in the month computed.
- **Plans are versioned**: `crl_<id>`, `crl_<id>.v2` …; a version is never edited; a new version ends the previous one at its
  start; no start in the past; a profit plan — created, superseded by a new version, or ended — only with profit.read.
- **Schedule**: no overlapping live shifts per employee (guard after the insert, so two planners cannot both win), none in
  the past, ≤ 16 h, ≤ 120 days ahead, none on approved leave; approving leave cancels that day's scheduled shifts — chosen
  inside the approval's batch (`UPDATE … RETURNING`), so a shift planned a moment before is cancelled too.
- **Approvals view** decides nothing: each `approvals` kind links to its module's decision screen (`approvalHref`; the
  promotions kinds come from that module's `APPROVAL_KINDS`); a kind no module claims is listed without a link. A payroll
  run appears for an approver only when `approveRun` would accept them.
- **Staff accounts** (QA fix 2026-11-12; the auth core's `app/server/auth/employees.server.ts`). «Add an employee»
  (`hireOptions` → the form; `hireEmployee` → `createEmployee`): staff.manage; name, email, phone (the HR facts' rule:
  `phone_invalid`), job title, roles, branch, reason — the form is checked whole, so every field error comes back at once; each
  role says whether this person may give it (they hold all it grants — `grant_exceeds_own` on `fields.roleIds` otherwise; the
  others are shown disabled), a branch-limited person hires for their own branch only; the same email twice → `email_taken`
  (`fields.email`); demo in a demo store (`storeMode`). The account has no password: the answer carries the one-time link
  (`handedLink`: `<origin>/admin/welcome#<token>`, 72 h, once), shown ONCE on the page (`LinkOnce`: the address, a copy key —
  the address is selected for a copy by hand when the clipboard refuses —, until when it works, how to hand it over) — never
  stored, never in a URL this admin requests, never in the audit trail (`staff.employee.create` has no token). The employee's
  file: «signing in» shows whether a password is set; a new link (`issuePasswordLink`: older links stop working) for an active
  account, re-enabling (`enableEmployee`, a new link asked by default; links made before the closing stay dead) for a closed one —
  staff.manage, never one's own account, never one holding more (`target_more_privileged`), each with a reason, audited by the core.
- **Termination**: staff.manage, a reason, never oneself (`own_account_here`) nor an account holding more
  (`target_more_privileged`, also enforced by the auth service); `disableEmployee` locks the account and revokes every session
  in its batch; then future shifts and pending leave are cancelled and an open attendance closed (`staff.employee.offboard`).

## Permissions and data

- Salary, advances and pay: only with staff.payroll.read/.run/.approve — absent (null) from the employee file otherwise.
- Profit: a profit plan's rate, a profit row's base and rate are null without profit.read (page data and JSON).
- Performance reads no cost column at all (a test asserts no cost/profit/margin key in the result).
- The store's pending approvals never carry the request's payload (amounts, purchase costs).
- Sessions on an employee's file: staff.manage or security.session.read; sign-in events: staff.manage or security.auth_event.read
  (identifiers masked by module 20's `authEventView`); ending sessions: security.session.revoke (module 20's service).
- Every change is audited (`staff.*`): pay-related events under `staff.payroll.*` (salary before/after, items, runs, advances).

## Boundaries (honest)

- No message provider: a password link (new employee, forgotten password, re-enabled account) is shown once to whoever made it
  and handed over in person; there is no self-service password reset. A link lost before it is used is replaced from the file.
- No "salaries payable" / "advances to employees" account: pay and advances reach the books when paid out.
- Commissions are computed when staff press "compute" or a run is prepared; no scheduled job yet (`syncCommissionsJob` ready).
- Printing: payslips are print CSS (one per page, the document switched to the light theme while printing), signed by
  hand; no PDF.

## Verify

```
npx vitest run tests/admin-staff.test.ts tests/admin-staff-payroll.test.ts tests/admin-staff-review.test.ts   # 14 + 10 + 8
npx vitest run tests/admin-staff-followup.test.ts tests/admin-staff-accounts.test.ts
npx vitest run tests/i18n.test.ts -t admin-staff
node scripts/lint-design.mjs app/routes/admin/staff                          # 0 findings
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-staff/seed.ts        # demo HR data (local, idempotent)
```

Browser (Edge, puppeteer): every page at 390 and 1440, light and dark, ar and en, dialogs (end access, salary, add shift,
approve leave, new plan, approve advance), validation, empty states, 403 (cashier at the gate, finance on performance) —
`.shots/admin-staff/<page>-<width>-<theme>-<lang>.png`; flows `flow-*.png`: finance prepares a demo run, the owner approves
and pays it (journal entry linked, payslips printed), clock in/out on My day, an advance asked (Arabic-Indic digits) and
approved, leave recorded and approved, a demo employee's access ended. Demo data: `.shots/admin-staff/seed.ts`.

## Requests to other owners

- ~~**Auth**: `createEmployee` with a one-time password-set link, and `enableEmployee`~~ — delivered by the auth core (2026-11-12),
  wired to the screens by the QA fix of the same day.
- **Shell gate**: `ALSO_OPENED_BY["admin/staff/me"] = ["dashboard.overview.read"]` so every employee reaches My day.
- **Jobs**: a daily `staff.commissions.sync` calling `syncCommissionsJob(db, systemActor(...), now)`.
- **Schema/finance**: system accounts `salaries_payable` and `employee_advances` (then accrual at approval); `REF_TYPES`
  `payroll_run` / `staff_advance` with links to `/admin/staff/payroll/:id` in finance's journal.
- **Finance**: replace `expenses.payrollNote` (payroll is now posted by staff runs; recording it as an expense too counts it twice
  — the run page warns).
- **Security 20**: withhold `staff.payroll.*` audit snapshots from readers without staff.payroll.read.

## Module follow-up 2026-11-12

A payroll run's involved people include the authors of the commission plans it pays under (`runInvolved`, and the approval batch's guard): they never approve it. `storeApprovals` and `syncCommissions` follow branch limits (a limited employee: their branch's requests — an advance FOR their staff included —, no store-wide runs; a sync writes their branch's sellers only). `StaffAccess.advancesView`: a branch-limited payroll approver gets the advances page as a section and its card on the home.

Tests (each failed before its change): `tests/admin-staff-followup.test.ts`.
