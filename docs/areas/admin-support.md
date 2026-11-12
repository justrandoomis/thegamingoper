# Admin 14 — Customer Service

Owner: admin support. Blueprint module 14 (P1), functions 14.01–14.07. Arabic first, English second. Code:
`app/routes/admin/support/**`, `app/server/services/admin/support/**`, strings `admin-support`, tests
`tests/admin-support*.test.ts`. The storefront side (help centre, assistant, repair form, ticket receipt) is
`docs/areas/support.md`; repairs' work is module 12's (`docs/areas/admin-returns.md`).

## Routes

| Path | What | Permission |
|---|---|---|
| `/admin/support` | queue cards (escalated to me, nobody holds, my late — raised clay when something waits), the unified inbox of tickets (SP-), assistant hand-offs and repair requests (RP-): views `?view=open…all` with counts, filters (kind, status, priority, topic, channel, agent, team, `q` = SP-/RP-/TT-/RMA- ref, whole phone, name/subject), sort, page — all in the URL; table ≥ 768 with bulk assign / route (confirmed in a dialog), cards below; route the waiting tickets; `<ModuleFunctions moduleId="14" />`. An employee who may not read tickets (content) gets the sections they may use | any support.*; inbox `support.ticket.read`; actions `support.ticket.assign` |
| `/admin/support/new` | a ticket for a call, WhatsApp, e-mail, social message or a visit: contact (Iraqi mobile or e-mail), customer's language, subject, topic, priority, their words, order / repair ref; "I will follow it" or the routing rules; `?order=` `?repair=` `?phone=` prefill | `support.ticket.reply` |
| `/admin/support/tickets/:ref` | one ticket: conversation (customer messages, replies with how they travelled — held in the outbox —, internal notes, every change from the audit trail as a sentence), composer (reply · internal note · record the customer's message; canned replies filled in the customer's language and reviewed), status with reasons, SLA targets, who holds it and why (routing), take / assign (with each agent's load) / route again, priority · topic · team, linked records, escalation, the assistant's conversation, private photos; prints as the record | read `support.ticket.read`; each intent its permission (below) |
| `/admin/support/repairs/:ref` | a repair request as support sees it: the customer's words and photos, hand-over / day / time preferences, status steps (module 12's events), SLA, technician, quote, tickets about it; a ticket for a call about it; link to module 12's page | `support.ticket.read` (ticket: `.reply`) |
| `/admin/support/routing` | rules in order (conditions in words, pool, capacity, team, priority), move / edit / delete with a reason, a dry run on the open tickets, every agent's open tickets, route the waiting ones | read `support.ticket.assign` or `support.routing.manage`; change `support.routing.manage` |
| `/admin/support/sla` | SLA policies per priority × topic (minutes, hours), the suggested set to adopt in one step, open tickets without due times and "give them their due times" | read `support.ticket.read`; change `support.routing.manage` |
| `/admin/support/replies` | canned replies (ar required, en/ckb optional) with the ten safe variables explained; live check of unknown variables / template code | read `support.ticket.reply` or `.canned_reply.manage`; change `support.canned_reply.manage` |
| `/admin/support/knowledge`, `/knowledge/:id`, `/knowledge/new` | articles by state (all, in the help centre, internal, review, drafts, archived), search; one article: preview as the site renders it (`<Blocks>`, per language), editor (lines → blocks, photos = catalogue keys), review workflow, pending revision, history | agents (`support.ticket.read`) read approved ones; `support.knowledge.manage` writes; `support.knowledge.approve` decides |
| `/admin/support/metrics` | `?days=7|30|90&demo=1`: new tickets, first reply and resolution (median, 90 %, on time), not answered, backlog, satisfaction (or "not collected"), by agent / topic / priority / channel, repairs | `support.metrics.read` |
| `/admin/support/files/:fileId` | a private photo of a ticket, a hand-off or a repair request; `private, no-store`, sandboxed; anything else the same 404 | `support.ticket.read` |

Ticket intents (`actions.server.ts`, the permission checked before the ticket or the form is read): reply / note /
inbound / preview / link / take (`support.ticket.reply`), status (`.reply`; to or from closed `.close`), assign /
triage / route (`support.ticket.assign`), escalate (`support.ticket.escalate`), return_escalation (the person it is
escalated to, or a holder of `.escalate` + the kind's permission).

## Functions → status

| Id | Status | Where / what is missing |
|---|---|---|
| 14.01 | boundary | `/admin/support`. No e-mail / WhatsApp / chat provider: staff open tickets for calls and messages and record what the customer said; written replies are `held` in the outbox (template `support_reply`, dedupe `support_reply:<message id>`), never "sent"; the shopper reads replies on the ticket page (`getTicketByAccessToken` shows employee, non-internal messages). |
| 14.02 | implemented | ticket page: links kept by id, consistency refused (another customer's order, a warranty / return of another order), account suggested by phone; each linked record shown only with its module's read permission. |
| 14.03 | partial | rules + capacity + reasons + dry run. Missing: automatic routing on arrival (storefront tickets wait until an assigner routes them; scheduled job requested). |
| 14.04 | implemented | `/admin/support/replies` + the composer. |
| 14.05 | partial | metrics + SLA policies. Missing: satisfaction is not collected (no survey, no rating page). |
| 14.06 | implemented | `/admin/support/knowledge`. Troubleshooting trees are not edited here (the assistant's; demo trees are seeded approved). |
| 14.07 | implemented | escalation dialog + hand back; refunds / RMAs only in modules 05 / 12 (links). |

## Rules and how they hold

- **One guarded batch per change** with its audit event (`support.ticket.*`, `support.routing.*`, `support.sla.*`,
  `support.canned.*`, `support.knowledge.*`): the status / holder / `updated_at` the page showed is in the UPDATE's
  WHERE + `expectChanged` (`ticket_changed`, `rule_changed`, `article_changed`, `reply_changed`). Routing rules and SLA
  policies carry a `version` (hash of what their form changes) and a pending revision a `savedAt`: a form or a
  decision built from an older version is refused, never saved over a newer change (review 2026-11-12). Bulk assign
  sends the holder each row showed and skips (and counts) a ticket taken since.
- **Idempotent writes:** a reply / note / recorded message's id is derived from the form's key (a double submit
  records one); a staff ticket's id too; outbox rows deduped by message.
- **Replies are reviewed:** canned replies only fill the composer; a text that still holds a `{name}` is refused
  (`unfilled_variable`); the audit records the canned reply used and whether it was edited.
- **Safe variables only:** a body may hold text and `{customer_name}` … `{store_phone}` — anything else with a brace,
  an unknown name, `${}`, `{{}}` is refused at save time (`template_code`, `unknown_variable`); values are put in as
  text (rendered as text nodes).
- **Routing:** rules in `sort` order, first match wins; `conditions` holds the match lists AND the pool (`agents`) +
  `capacity`; the least-loaded pool agent under the capacity gets the ticket, re-checked INSIDE the batch
  (`CAPACITY_FULL` → decide again); full pool → the rule's team queue. The decision (rule, what matched, agent with
  load/capacity, fallback) is the `support.ticket.route` audit event the ticket page puts into words. A ticket no rule
  matched is recorded once and not retried by the bulk run.
- **SLA:** due = created + the policy's minutes; the topic's policy beats the priority's general one (the storefront's
  rule). Priority / topic changes and escalation recompute both. Calendar time, no pause (said on the page). "Give
  them their due times (N)" counts only the tickets a policy covers (`missing.fillable`) and fills exactly those.
- **Escalation:** targets hold the kind's permission (`orders.refund.approve` / `returns.warranty.manage`) AND
  `support.ticket.read`, never the escalating person — re-checked inside the write (disabled a moment ago =
  `escalation_target`); priority ≥ high (a priority raised meanwhile is not lowered); only that person resolves or
  closes it until it is handed back (`escalation_open`, also inside the resolving write). Handing back or passing it
  on: the holder, or a cover (escalate + the kind's permission) who did not escalate or pass it on since the last
  hand-back (the ticket page offers the key to them: `can.handBack`); the customer's profile counts it as an open
  complaint (module 07's rule).
- **Links:** one customer and one order across customer, order, warranty, return and repair, whichever was linked
  first (`linkConflict`), also when a staff ticket is opened; the link's write is guarded on every link it read.
- **Knowledge, two people:** whoever saved a version since its last approval (audit trail) cannot approve it
  (`approver_is_editor`); an approved article's edit is an `approvals` row (kind `knowledge_article`, full content,
  `basedOn` = its `updated_at`, `savedAt` = its version) applied in one batch on approval — only as the approver saw
  it; slugs are fixed once approved or referenced by a tree.
- **Field rules:** phones masked without `customer.phone.read_full` (partial-number search needs it); the order shows
  its status / link only with `orders.order.read`, the customer with `customers.customer.read`, product / warranty /
  RMA (its status too) with their module's read — canned-reply variables follow the same rules (`{customer_name}` from
  the account, `{order_status}`); looking a record up by its reference (link, a staff ticket's order / repair, the
  account by phone) needs that kind's read permission (unlinking needs none); the routing dry run lists tickets only
  for ticket readers; the repair's serial number is never sent (given / ours only); no cost anywhere. Order and RMA
  references typed with Arabic-Indic digits are found.
- **Mixed scripts:** every value the module's `t()` puts into a sentence (a name, a ref, a number) is bidi-isolated
  (FSI … PDI, `ui.tsx`), and lists are `listOf(items, t("listSep"))` (each item isolated, the language's separator):
  an Arabic name with brackets in an English sentence keeps its order. Form fields start from `plainText(…)`.
- **Repair status events** are module 12's (`changeRepairStatus` writes `repair_events` kind `status`, `data.to`), which
  the storefront's status page reads; this module only reads them. **Private photos** (`support_photo`,
  `repair_photo`) are served by `/admin/support/files/:fileId` to ticket readers (SECURITY §9).

## Real, demo, boundary

- Real: everything above against D1. Demo records in the local database came through the services
  (`.shots/admin-support/seed-support.ts`, `is_demo` / "(تجريبي)" names); the SLA targets there are the suggested set.
- Boundary: messaging providers (14.01), satisfaction collection (14.05). No AI: `ai_summary` is not written.

## Verify

```
npx vitest run tests/admin-support.test.ts tests/admin-support-routes.test.ts   # 24 + 6 tests
npx vitest run tests/admin-support-review.test.ts                              # 19 attacks of the 2026-11-12 review
npx vitest run tests/i18n.test.ts -t admin-support
node scripts/lint-design.mjs app/routes/admin/support                          # 0 findings
```

The review's tests fail on the builder's code (snapshot + alias config in `.shots/admin-support/adversarial/`:
`npx vitest run --config .shots/admin-support/adversarial/vitest.orig.config.mts` → 19 failed).

Browser (Edge, puppeteer-core): `.shots/admin-support/shots.mjs` (every page × 390/1440 × ar/en × light/dark, the
content role's home and 403, the cashier's gate 403) and `flow.mjs` (canned reply → review → unfilled variable refused →
held reply; status dialog; escalation dialog with impact; new-ticket validation; routing dry run; approving an article;
the writer who cannot approve; at ≥ 768 px the bulk-route confirmation); `print.mjs` (the ticket as printed, ar/en: shell and forms hidden, ink on white).

## Not done / limits

- Automatic routing on arrival and the shell's bell queues wait for their owners (asked below).
- No customer satisfaction survey; no SLA business hours or pause; no attachments from staff replies.
- Troubleshooting trees are read by the assistant only; editing them is not built.
- A ticket keeps one link per kind (one order, one product…). Chromium only; Sorani unreviewed.

## Asked of other owners

- Shell (bell, home cards): `supportQueueCounts(db, actor, now)` → `QUEUE_LINKS` (escalated to me, nobody holds, my late).
- Jobs: `routeWaitingTickets(db, systemActor("support.route"), now)` every few minutes (routing on arrival).
- Storefront support: a rating page (satisfaction), the ticket page for staff replies already exists.
- Customers (07): ticket refs link to `/admin/support/tickets/:ref`.
- Security (20): finance has no `support.ticket.read`, so a financial complaint can only go to owner / manager.
- Settings (22): the message template `support_reply` for when a provider is connected.

## Module follow-up 2026-11-12

`TicketDetail.can.passOn`: the holder of an open escalation (or a cover) who may escalate is offered passing it on (the page's escalate panel), as `escalateTicket` allowed.

Tests (each failed before its change): `tests/admin-support-followup.test.ts`.
