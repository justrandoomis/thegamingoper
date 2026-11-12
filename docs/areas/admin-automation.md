# Admin 19 — Automation and AI (`/admin/automation/…`)

Owner: admin automation. Blueprint module 19 (19.01–19.08), priority P2. Rules that WATCH what the other modules
recorded and hand work to a person — never a refund, a price change, a stock or money movement or an approval.
Tables (no migration; the schema's own): `workflows` (rules), `workflow_runs` (the execution log + dry-run samples),
`reorder_suggestions` (19.02), `demand_forecasts` (19.05), plus `staff_tasks` rows (15.02's table, `ref_type` null so
the staff module manages them). Services: `app/server/services/admin/automation/*` (client-safe: `catalog.ts`,
`definition.ts`, `types.ts`, `forecast.ts`).

## Routes

| Path | What | Loader permission (changes) |
|---|---|---|
| `/admin/automation` | What waits (open suggestions, rules ready to switch on, failed runs), notices for me grouped by rule (open its runs, mark all seen), figures, what automation never does (19.08), honest limits, `<ModuleFunctions moduleId="19">` | any automation permission |
| `/admin/automation/rules` | Rules: status chips with counts, event and name in the URL, `?ready=1` = the rules this person may switch on now (what the bell and the front page count); "run the active rules now" (reason) | `automation.workflow.read` (run: `.activate`) |
| `/admin/automation/rules/new` · `/:ruleId/edit` | The builder: event cards (`?event=`, works without JS) → typed conditions → allowed actions → name; edit needs a reason, a rule that is on asks for a confirmation (it stops) | `automation.workflow.manage` |
| `/admin/automation/rules/:ruleId` | The rule in words, its dry run (summary, why events did not count, samples), switch on / resume (another person, reason), pause (reason), versions with who and why, latest runs | `.read` (dry run `.manage`/`.activate`, switch on `.activate`, pause `.manage`/`.activate`) |
| `/admin/automation/runs` · `/:runId` | The execution log (rule, status, runs / dry-run samples / all, the last 1 / 7 / 30 days in the URL); one run: event facts, what each action did and where it lives | `automation.workflow.read` |
| `/admin/automation/suggestions` | 19.02: open / made into drafts / dismissed; check the stock now; dismiss with a reason; select → draft order; SKUs that need attention but have no honest quantity (link to 04's reorder page) | `automation.suggestion.read` (changes `.approve`) |
| `/admin/automation/suggestions/order?ids=` | One draft purchase order of 09 from open suggestions: supplier, destination, currency, rate, qty, unit cost (last price paid with cost.read); confirm dialog with the impact | `.approve` + `purchasing.po.create` + `cost.read` to submit |
| `/admin/automation/forecast` | 19.05: next month per SKU, the 12 months behind it, stock now, launches with pre-orders | `automation.suggestion.read` |
| `/admin/automation/anomalies` | 19.04: own checks with thresholds; finance 10.10 and purchasing 09.07 summaries for their readers; demo switch | `automation.anomaly.read` |
| `/admin/automation/tickets` | 19.03: open tickets whose words point to another topic by the keyword rules (listed), canned replies of that topic; pages; every open ticket counted, the latest 1,000 read (said when fewer) | `.workflow.read` + `support.ticket.read` |
| `/admin/automation/assistant` | 19.06 boundary: what an assistant needs and must respect | `automation.assistant.use` |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Missing / note |
|---|---|---|
| 19.01 | partial | Runs unattended only once the platform schedules `runAutomation` (requested); until then "run the active rules now". Notices stay in the admin (no message provider) |
| 19.02 | partial | The stock is checked by itself only once scheduled (requested; "check now" meanwhile); the bell does not count suggestions yet (requested) |
| 19.03 | partial | Keyword rules only; summaries and written reply suggestions need a language model (none configured) |
| 19.04 | implemented | Worked out when the page opens; nothing is pushed (no provider) |
| 19.05 | implemented | Stored monthly by `storeDemandForecasts` once scheduled (requested) |
| 19.06 | boundary | No language model, provider, key or data decision |
| 19.07 | implemented | |
| 19.08 | implemented | By construction (catalogue) and tested by counting the money / stock / price tables |

## The catalogue (fixed — `catalog.ts`)

Events: `order.placed` (one per order), `stock.below_reorder` (a level at a sellable active location with available ≤
its reorder point; one per level and stock episode = the latest arrival there), `ticket.waiting` (one per waiting
episode — opening or a customer message until the next public staff reply — dated when it crossed the rule's hours),
`price.changed` (one per applied price change). Conditions are typed fields per event (channel, payment methods, minimum
total, governorate · location, product kinds, nothing on the way · hours, priorities, topics, unassigned · direction,
minimum change %) plus "count demo records too"; digits in any of the three sets. Actions per event (`EVENT_ACTIONS`):
a staff task (an active employee, priority, due hours, a plain note), a notice inside the admin for holders of one of
the module's read permissions, a review flag through 05.09's `decideReview` (orders only; never on a held, closed or
already flagged order), a purchase suggestion (stock only; 04's quantity). Nothing else exists to choose.

## Rules

- **Versions.** Every saved change = version + 1, back to `draft` (an active rule stops), saved with its author; the
  full definition of each version is the `after` of its audit event (`automation.rule.create` / `.save`, with the
  reason). Stored JSON: `workflows.conditions = { schema, version, match, author, demo, dryRun, activation, pause,
  cursor }`; a row that does not read is `broken` and never runs.
- **19.07.** Switching on needs a dry run of the CURRENT version ≤ 7 days old, by someone who did not save that version
  (`author_cannot_activate`, 403), with a reason. A dry run reads 7 / 30 / 90 days (stock: now), runs the same planner
  as a real run, writes only its summary and ≤ 50 sample rows (`is_dry_run`, replacing the previous ones).
- **Runs.** `runAutomation(db, now, { ruleId?, triggeredBy?, reason?, scan? })`: the 19.02 scan, then each active rule's
  events since it was switched on (orders and prices after the rule's cursor, ≤ 100 a run; stock and tickets as they
  are now); a run's id is derived from rule + event key, so twice in a row or two at once act once. Run row + task /
  suggestion inserts + audit in ONE batch; the flag is the one call into another module: the run row is claimed
  first ("interrupted" until finished). Every event's batch (the claim, for a flag) is guarded on the rule as the
  run read it (`status = active`, same `updated_at`): pausing or saving a rule stops a run under way at once
  (`stats.stoppedRules`). Status: failed (an action failed, e.g. `assignee_inactive`) › awaiting approval (a flag or
  suggestion waits for a person) › succeeded › skipped. A flag never lands on a held, closed, already flagged or
  already CLEARED order (`order_reviewed`: a reviewer's decision is not reopened).
- **19.08.** No action moves stock or money, changes a price or an order's status, approves or sends anything. Refunds
  stay 05/12 (second person), prices 03 (approval limits), purchase orders 09 (submit, limit, second person).
- **19.02.** `scanStockOuts` reads 04's `listReorder` ("attention", all pages): a SKU out / below its reorder point /
  running out within 14 days WITH a suggested quantity gets one suggestion per stock episode (id from SKU + latest
  arrival); dismissed ones do not come back until stock arrives; a draft 09 cancelled reopens it. Ids are bound as ONE
  value (`json_each`), so 100+ SKUs scan (D1 binds ≤ 100 values a statement). `createDraftOrder` TAKES the suggestions
  first (guarded on all being open, linked to the draft 09 derives from the person + the form's key), then calls 09's
  `savePurchaseOrder` (demo suggestions only make a demo draft, never mixed): two people at once, a second tab or a
  stale form get `suggestion_not_open` / `suggestion_changed` and no second draft; a draft 09 refuses releases them at
  once; a request stopped half way is released by the scan after `CLAIM_RELEASE_MS` (15 min,
  `draft_order_missing`). Only this form's own replay finds them taken and gets its draft back; the same old form sent
  after 09 cancelled its draft (suggestions reopened) is refused (`idempotency_mismatch`). Cost only with
  cost.read (last unit cost on the form).
- **19.05.** `forecastOf`: 3-month moving average of 'sale' movements × last year's index for next month (bounded
  0.5–2) once 12 full months exist; fewer than 3 full months = short history; no sale in 3 months = no number;
  launches from `attributes.catalogue.releaseDate` / `preorder_release_at` with pre-ordered units.
- **19.04.** Own checks (thresholds in `ANOMALY_RULES`): refunds ≥ max(250,000, 3 × median of the 90 days before),
  discounts ≥ 25 % and ≥ 25,000, orders ≥ 5 × the median order (≥ 20 orders of history), cost jumps ≥ 25 % between
  receipts [cost.read]. Demo records only with `?demo=1`. Each lists its largest 50 and counts all it found (`total`).
- **Notices.** A run's `notify` entry; listed for holders of the audience permission for 14 days; "seen" is an audit
  event per person (`automation.notice.seen`, deterministic id), the run is never edited. The front page's groups
  count EVERY notice (they add up to the bell's `countNotices`); "mark all as seen" marks all of a rule's, in batches.
- **Counts = their lists.** The front page and the bell link through `AUTOMATION_LINKS` (types.ts): rules to switch
  on → `/rules?ready=1` (the same predicate as `countActivatable`), failed runs in 24 h → `/runs?status=failed&days=1`,
  runs in 24 h → `/runs?days=1`. "Run the active rules now" records `stats.scanned`, so the suggestions page's "last
  checked" counts it.
- **Branch limits.** Rules act on the whole store: a branch-limited employee reads them, never writes, dry-runs or
  switches them on (`branch_limited`). Suggestions, forecast and anomalies are store-wide like 04's reorder page.

## Exports for other owners

`runAutomation(db, now)` and `storeDemandForecasts(db, now)` return `{ status, stats, error }` (jobs.server's shape;
`runAutomation` says "failed" when a rule or the scan failed — the other rules still ran — "skipped" when nothing was
active or found); `automationQueueCounts(db, actor, now)` → `{ suggestions, rulesToActivate, notices }` with
`QUEUE_HREFS`. 19.03 masks a phone number typed into a ticket subject unless the employee holds
`customer.phone.read_full`.

## Verify

```
npx vitest run tests/admin-automation.test.ts tests/admin-automation-routes.test.ts   # 22 + 5
npx vitest run tests/admin-automation-review.test.ts                                   # 14 (the adversarial review)
npx vitest run tests/i18n.test.ts -t admin-automation
node scripts/lint-design.mjs app/routes/admin/automation                              # 0 findings
```

Browser: `…/scratchpad/work/admin-automation/` (`seed-automation.ts` demo data through the services, `sign-in.mjs`,
`shots.mjs all`: 26 pages and states × 390 / 1440 × light / dark × ar / en). Route modules import values only from
the client-safe files (`catalog.ts`, `definition.ts`, `forecast.ts`, `types.ts`) for their components: a `.server`
value used in a component makes the page's client module answer 500.

## Not done / limits

- No AI model: no ticket summaries, no written reply suggestions, no assistant (boundaries, said on the pages).
- No message provider: notices are not sent by SMS / e-mail / WhatsApp.
- Unattended runs, the daily stored forecast and the bell's counts wait for their owners (requests in the report).
- Stock rules' dry runs read today's stock (levels in the past are not rebuilt). Event types are four.
- The Sorani strings need a native reader; Chromium (Edge) only.
