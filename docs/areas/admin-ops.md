# Admin 23 — Technical operations (`/admin/ops/…`)

Owner: admin ops. Blueprint module 23 (23.01–23.06). Reads what the scheduler and the app already record —
`job_runs`, `outbox`, `consistency_findings`, the audit trail, module 20's restore tests — and keeps its own records
in the tables the schema has for it: `incidents` + `incident_updates`, `error_reports`, `perf_rollups`, and
`staff_tasks` (refs `incident`, `consistency_finding`) for owners and assignees. Services:
`app/server/services/admin/ops/*` (client-safe constants, URL parsers and view models in `types.ts`).

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin/ops` | What waits (failing / late / stuck jobs, critical findings nobody has, my incidents past their date, open errors, a restore test due), figures, honest limits, `<ModuleFunctions moduleId="23">` | any ops permission (each block by its own) |
| `/admin/ops/jobs` | Every job of `JOB_NAMES` with its cron (= wrangler.jsonc, tested), next run, health, last run and success, failures 7 d and in a row; `?view=attention` = only failing / stuck / late jobs (what the front page and `opsQueueCounts.failingJobs` count); run history (job, status, origin, page in the URL) | `ops.job.read` |
| `/admin/ops/jobs/:job` | One job: what a run now would touch (counted with the job's own conditions), its runs, **run now** (dialog: impact + reason; `ops.job.run`) | `ops.job.read` |
| `/admin/ops/jobs/runs/:runId` | One run: counters (cost / profit keys cut), error, linked incidents, "open an incident" | `ops.job.read` |
| `/admin/ops/outbox` | Held / queued / sent / failed by channel, oldest held, messages (status, channel, template in the URL) — recipients masked, content never read | `ops.job.read` |
| `/admin/ops/consistency` | The daily findings: views with counts, severity, check, who has it, text, sort, page in the URL; select ≤ 25 → give to a person, close as resolved / false positive, open an incident with them | `ops.consistency.read` (changes: `.resolve`) |
| `/admin/ops/consistency/:findingId` | What the check compares, why it matters, how to look into it; the record (linked into its module when the employee may open it); the numbers (withheld for cost checks without `cost.read`); history; incidents | `ops.consistency.read` |
| `/admin/ops/incidents` · `/new` · `/:ref` | The incident centre: views (open, mine, past their date, resolved, all); a new incident (owner, target day, severity, start, links prefilled by `?finding=` `?run=` `?error=`); one incident (timeline, update with a status move, resolve with the post-mortem, reopen, owner and date, severity, details, link / unlink, print) | `ops.incident.read` (changes: `.manage`) |
| `/admin/ops/errors` · `/:errorId` | Errors the app recorded (views, source, level, period, text, sort); resolve / ignore / reopen with a reason (bulk ≤ 25); one error with its scrubbed stack and last context; link to an incident; Cloudflare Workers Logs step by step | `ops.error.read` (changes: `.resolve`) |
| `/admin/ops/performance` | Slow and failed requests and page loads per page, day and device (1 / 7 / 30 days, admin / store); Cloudflare's metrics step by step for totals and rates | `ops.performance.read` |
| `/admin/ops/backups` | Age of the last passed restore test (module 20's record), due every 90 days, the audit seal, what D1 Time Travel keeps; link to `/admin/security/backups` for whoever may record a test | `ops.backup.read` |
| `POST /admin/ops/report` | A browser's script error or slow load (JSON, ≤ 16 KB, `TELEMETRY_RATE` per employee → 429); 204 | any signed-in employee |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Missing / note |
|---|---|---|
| 23.01 | partial | Recorded today for the ops pages (server errors through the route kit, browser errors through `OpsReporter`); every other page needs the recorder wired by the shell / spine (requested). No APM: Workers Logs |
| 23.02 | partial | Same: measured for the ops pages; rates and percentiles are Cloudflare's (no analytics provider) |
| 23.03 | implemented | Jobs, history, run now, outbox |
| 23.04 | partial | Monitoring only; backups are Cloudflare's (no API token), KV has no history |
| 23.05 | implemented | |
| 23.06 | partial | No check yet that a delivered order with known costs has its COGS posting (requested from the jobs owner) |

## Rules

- **Never per request.** `recordError` = one upsert per error, grouped by fingerprint (source + route + message with
  numbers / ids / quotes blanked + first stack frame); `recordPerfSample` = one upsert per SLOW (server ≥ 1 s, load
  ≥ 3 s, navigation ≥ 2 s) or FAILED (≥ 500) request into the day's row. A per-isolate budget (60 writes / minute)
  holds error counts in memory past it. Retention: `purgeOpsTelemetry` (90 days unseen); every 100th write runs it
  until the daily retention job calls it (requested).
- **Scrubbed before stored:** phones masked (`maskPhonesIn`), e-mails, 13–19-digit runs, ≥ 40-char tokens and
  `?t= / token= / key= / code=` values removed, URLs reduced to their path; the sample keeps the request id (Ray ID)
  and the device class only.
- **Jobs:** health = stuck (running > 30 min) › failing › late (the CRON has not started it for 3 periods, or a period +
  2 h for daily — a run by hand never hides a stopped trigger; never run by the cron: measured from its first run)
  › running › skipped › ok. A job's error and an outbox row's provider error are scrubbed like error reports. Run
  now: `ops.job.run`, reason ≥ 3, the form's key claims an audit event (`aud_job_<hash>`) BEFORE the run, so a
  resubmission returns the first run (`replayed`); refused while a run of the same job is in progress (`job_running`;
  a best-effort check, not atomic — the jobs are safe to run twice); `runJob(…, { origin: "manual", triggeredBy,
  env: { KV } })`.
- **Findings:** never edit the checked data. Give = status acknowledged + a `staff_tasks` row (due at the end of the
  Baghdad day) — only to an active employee holding `ops.consistency.read`; a previous task is cancelled. Close =
  resolved (task done; the next daily run opens it again if still there) or false_positive (task cancelled; the job
  keeps it closed), reason ≥ 3; reopen with a reason. One batch per call, `FINDING_CHANGED` guard, an audit event per
  finding (`ops.finding.assign|resolve|dismiss|reopen`). Withheld (message and details absent, the message not
  searched): cost checks (`journal.*`, cost-named keys) without `cost.read`, wallet checks (`wallet.*`) without
  `customers.wallet.read` or `finance.wallet.read`. **Branch limit** (`findingScope`, `canAccessBranch` semantics): an
  employee limited to a branch sees, counts, takes and closes only findings about that branch's records (a stock
  level by its location's branch, an order / payment / refund by its order's) — never another branch's nor the
  company-wide ones (books, wallets, the warehouse, web orders): `not_found`; a finding is given only to someone who
  may open it (`assignee_invalid`). The page's incidents only with `ops.incident.read`; its run linked only with
  `ops.job.read`.
- **Incidents:** `INC-0001…` from the counter `incident`; creation id = hash of the form's key (replay → same ref).
  Owner must hold `ops.incident.read`; target day today … +365 (suggested by severity: 0 / 1 / 3 / 7 days); start not
  in the future (5 min skew) nor > 1 year ago. Moves open → investigating / mitigated, mitigated → investigating;
  resolving needs the post-mortem (≥ 20) and a time between the start and now; status moves check the status the form
  saw, edits the `updated_at` it saw (`incident_changed`). Links keep ids: findings / runs as audit events with a
  snapshot label (a purged run stays described), errors through `error_reports.incident_id` (one incident each,
  `link_exists`; the retention purge keeps a report an incident is about). Linking — and the new form's `?finding= /
  ?run= / ?error=` prefill — needs the permission to read that kind (`LINK_READ`: `forbidden`), findings within the
  branch limit. The page's action changes only the page's own incident (`incidentIdForPage`); a reused form key with
  other details is `idempotency_mismatch` (also for run now with another job). Dialogs open on the details as they
  are now (a stale form never overwrites a newer edit). Audit: `ops.incident.create|update|resolve|reopen|owner|
  severity|edit|link|unlink`.
- **Counts equal their lists:** the view chips count with the same filters their links keep (findings, errors,
  incidents); `opsQueueCounts.overdueIncidents` = every open incident past its date (`?view=overdue`).
- Searches accept Arabic-Indic and Persian digits (`likePatterns`); a POST that is not a form is a 400 (`ops.form`).
- Typed days and times accept Arabic-Indic and Persian digits; days and times are Baghdad's (UTC+3).

## Verify

```
npx vitest run tests/admin-ops.test.ts tests/admin-ops-routes.test.ts tests/admin-ops-review.test.ts   # 24 + 8 + 15
node scripts/lint-design.mjs app/routes/admin/ops                       # 0 findings
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-ops/seed-ops.ts       # demo staff (manager, finance, support, reader w/o cost)
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-ops/seed-findings.ts  # three DEMO findings (dev data is consistent)
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-ops/inspect.ts        # read-only counts
```

Screenshots: `.shots/admin-ops/` (every page × 390/1440 × light/dark × ar/en; run-now, assign, resolve dialogs;
validation; 403 for support, finance on jobs, a reader on a new incident; a reader without cost.read on a cost check).
Review 2026-11-12: `.shots/admin-ops/review/` (changed pages × 390/1440 × light/dark × ar/en, every dialog at 390 and
1440 with its confirm word whole and the focus inside, the stale-edit and toast flows). Chromium's FULL-PAGE capture
shifts a short RTL page sideways (the rail half off-screen, also in the builder's set) — an artefact: grow the
viewport to the content height and capture the viewport instead.

## Review 2026-11-12 (adversarial)

Fixed, each with a test in `tests/admin-ops-review.test.ts` that failed first: incidents (titles) on finding and run
pages for people without `ops.incident.read`; links to pages the person cannot open; wallet amounts without a wallet
permission; linking any finding / run / error by id without the permission to read it; view chip counts ignoring the
filters their links keep; "my" overdue count linking to everyone's; the purge deleting an incident's error report; a
manual run hiding a stopped cron; unscrubbed provider errors; the incident action changing the incident the form
named; a reused key with other details answered as a replay; branch limits; a non-form POST answering 500; digits in
search; the jobs count without its list. Without a unit test (seen in the browser): bulk dialogs counted the visible
page only while sending every selected id; the update toast repeated on each revalidation and wiped a note being
typed; the edit dialog kept the values of the first render (a save overwrote a newer edit); filter keys truncated;
confirm keys truncated at 390.

## Boundaries (honest)

- No APM / analytics provider: Workers Logs and the Worker's metrics hold every error and request (steps on the pages).
- No message provider: messages stay "held". No Cloudflare API token: backup state is not readable from the app.
- Cron triggers fire only in Cloudflare: locally every job is "never" or "late".

## Requests to other owners

- **Shell owner:** add `opsTimingMiddleware` (`routes/admin/ops/observe.server.ts`) to `_layout.tsx`'s middleware after
  the gate, mount `<OpsReporter />` (`routes/admin/ops/components/Reporter.tsx`) in `AdminShell`, and give the gate a
  rule letting every signed-in employee POST `/admin/ops/report`; bell items from `opsQueueCounts` (critical findings
  nobody has → `/admin/ops/consistency?severity=critical&assignee=none`, failing jobs → `/admin/ops/jobs?view=attention`,
  incidents past their date → `/admin/ops/incidents?view=overdue`; each count equals its list for that employee).
- **Spine (lead):** call `recordError(getDb(), { source: "server", … }, Date.now())` from `entry.server.tsx`'s
  `handleError` (inside `waitUntil`), skipping aborted requests and Responses.
- **Jobs owner:** call `purgeOpsTelemetry(db, now)` from the retention job; add a consistency check for delivered
  orders with known costs and no `order:<id>:cogs` entry (the profit side of 23.06).
- **Schema owner:** `consistency_findings.assigned_to`, `.incident_id` and an `incident_links` table (today: a task and
  audit events); `error_reports`/`perf_rollups` `is_demo`.
