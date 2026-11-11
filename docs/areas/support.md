# Support area — help centre, guides, maintenance assistant, repairs

Owner: storefront area "support". Brief §7, DESIGN.md §9.22, CONTRACTS.md §3 (support row).
Files: `app/routes/storefront/support/**`, `app/server/services/support/**`, `app/i18n/messages/support.ts`,
`tests/support.test.ts`. No API route: photos travel with the form that needs them.

## Routes

| Path | What | States |
|---|---|---|
| `/support` | help centre: 3 ways forward, devices by platform (rails), `?device=<slug>` shows that device's guides, every approved guide, how to reach a person | default · device chosen · device without guides (empty) · no guides at all (empty) · demo note · store contact not published |
| `/support/article/:slug` | one approved public guide via `<Blocks>` (safety callouts included) + "still not solved?" + related guides | default · Arabic fallback note · "not yet reviewed by a store technician" · demo note · 404 (drafts, internal, review, archived, unknown) |
| `/support/assistant` | guided maintenance assistant; the conversation is the query string; `?handoff=1` = talk to staff | device · model · problem · steps · done (resolved / guide / part / repair / staff) · danger stop · error code with/without a guide · unmatched words · handoff form (validation, offline, network failure kept in place) · handoff receipt |
| `/support/repair` | repair request form; `?device=` preselects, `?from=assistant&…` prefills the problem with the conversation summary | default · prefilled · field errors (instant + server) · uploading photos · offline · network failure (form kept) · rate limited |
| `/support/repair/status` | `?ref&t` (link given after sending) or POST ref + phone | lookup form · not found (same answer for wrong ref / wrong phone) · rate limited · created · replayed · every repair status, quote pending/approved |

Navigation: the four sibling pages carry `handle = { nav: "push", order, group: "support" }` and link tabs, so moving
between them is the sideways push; guides open with `rise`. The assistant is a task screen (`shell.tabBar: false`):
below 1024px the composer is a `<TaskBar>`, from 1024 it sits under the conversation. Replies are links with
`preventScrollReset`; the newest answer takes focus and the replies scroll into view; new turns inflate (`Bubble`).

## Services (`app/server/services/support/`)

| Module | Exports |
|---|---|
| `kb.server.ts` | `getSupportDirectory(db, locale)`, `listArticlesForDevice(db, locale, deviceModelId, { related? })` (contract), `listArticlesForPlatform`, `listArticlesByTag`, `listHelpArticles`, `findArticlesMentioning`, `getArticle`, `listRelatedArticles`, `findDevice`, `findPlatform` |
| `assistant.server.ts` | `runAssistant(db, locale, state, { model? })` → `AssistantView`; `handOffToStaff(db, who, locale, state, raw, now, { store, photos })`; `AssistantModel` + `configuredAssistantModel()` (the AI seam, returns null); `checkTree` |
| `tickets.server.ts` | `createSupportTicket(db, who, raw, now, { store?, photos?, channel? })` (contract) → `{ ticketId, ref: "SP-…", accessToken, replayed }`; `getTicketByAccessToken`; `planSupportTicket` (statements for a caller's batch); `SUPPORT_ERROR_KEYS` |
| `repairs.server.ts` | `createRepairTicket(db, who, raw, now, { store?, photos? })` (contract) → `{ ref: "RP-…", accessToken, … }`; `getRepairByAccessToken`; `lookupRepair` (ref + phone, rate limited) |
| `matcher.ts` | keyword router (danger → error code → symptom tree → topic), Arabic/English/Sorani |
| `state.ts`, `summary.ts`, `types.ts` | client-safe: URL state, the conversation summary, view models |
| `common.server.ts` | `SupportWho`, refs, idempotency → access token, preferred day (Baghdad, today … +30), rate limits, private photos |

`listArticlesForDevice` scope: articles written for the model ("device"), then for every device of its platform
("platform"); with `related`, other models of the same platform ("related" — labelled "written for X, check it applies").
The seed hangs the PS5 and Xbox guides on `ps5-slim` / `xbox-series-x`, so other models of those platforms see them only
as "related". Never inferred as written for them.

## Real, demo, boundary

- **Real:** everything above runs against D1 with zod validation, one `db.batch` per creation (an `expectThat` guard on
  the access-token hash makes double submissions one row), audit events (`support.ticket.create`,
  `support.repair.create`), per-IP and per-phone rate limits, private photos through the server's upload pipeline
  (type by bytes, ≤ 8 MB, metadata removed; `files` rows in the same batch, blobs removed if it fails).
- **Demo:** the 8 articles and 2 trees are seeded, approved without a reviewer: pages say "demo" and "not yet reviewed by
  a store technician". Tickets and repairs made while `STORE_MODE=demo` are `is_demo` and say so.
- **Boundary — AI:** no model or provider is configured. `AssistantModel.interpret` may only return existing symptom/topic
  keys; danger signs and error codes are never left to it. The page states that answers come from verified guides.
- **Boundary — messages:** no SMS/WhatsApp provider, so pages promise a call, never a sent message. Staff see tickets and
  repairs in the admin support module (other workflow).
- **Not promised:** pick-up availability, appointment times (preferences only), repair prices, warranty cover.

## Stored data

- Assistant: nothing until "talk to staff" with consent → `assistant_sessions` (escalated, `log_consent`, expires after
  365 days), `assistant_messages` (what the shopper saw, sources, confidence, safety flags), `consents` (`support_log`),
  `support_tickets` (channel `assistant`, internal note = Arabic summary rebuilt on the server from the state),
  `ticket_messages` (the shopper's note + photo ids; the internal note).
- Repair: `repair_tickets` (`serial_text` as typed; `serial_id` / `warranty_id` when the serial is one of our units —
  never shown back) + a `repair_events` "submitted" row whose `data` holds hand-over, preferred day/window, photo ids.
  The status page reads staff changes from `repair_events` kind `status` with `data.to`.

## Integration slots left

- ~~Device hub link in the help centre's device panel~~ — done 2026-11-11 (integration pass): the devices area's
  `DeviceHubLink` row ("كل شيء عن {device}", `help.device.hub` / `hubText`) heads the panel's guides column; every
  device the directory lists has a hub (published model, active platform), and its picture grows into the hub's stage.
- The devices area can call `listArticlesForDevice` for hub guides; product/order pages can call `createSupportTicket`.
- A "part" outcome links `/p/<slug>` (product area); no seeded tree uses it yet.

## Verify

```
npx vitest run tests/support.test.ts        26 tests: URL state, refs, days, matcher, KB visibility, tree replay and safety,
                                            model boundary, handoff (consent, storage, idempotency, race, photos, limits), repairs
node scripts/lint-design.mjs app/routes/storefront/support app/server/services/support
```

Checked in headless Chromium against the dev server (2026-11-11): every page at 390 and 1440, light and dark, ar, en
and ckb (no horizontal overflow, no console or page errors); flows — platform → model → problem → steps → outcome with
focus on the newest answer and Back undoing the last answer; typed danger words, an error code, Sorani words routed to
the right tree; handoff validation (specific phone sentence, consent) and success → ticket receipt; repair with a photo →
status page; lookup with a wrong phone (generic answer); offline (send key flat with the reason); a POST that never
reaches the store (form and text kept, sentence beside the commit key, no error page). Chromium only; no phone.

## Not done / open

- ~~Retention: no job deletes expired `assistant_sessions` yet (jobs owner).~~ Done 2026-11-11 (server pass): the daily
  retention job (`purgeExpiredAssistantSessions` in `app/server/jobs.server.ts`, stat `assistantSessions`) deletes a
  stored conversation once its `expires_at` (hand-off + `ASSISTANT_RETENTION_DAYS`) has passed, with its messages; the
  ticket keeps its summary note and loses only the `assistant_session_id` link (the foreign key would refuse the delete
  otherwise; `repair_tickets.assistant_session_id` likewise). The `consents` row (`support_log`) stays: the table is
  append-only (`consents_no_delete`) and holds no conversation. The pages still do not promise a deletion date
  (copy is this area's call).
- Admin side (ticket queue, repair status changes, quotes) is the admin support module's. Status changes should be
  written as `repair_events` kind `status`, `data: { from, to }` so the status page shows them.
- Error codes: no approved guide mentions one yet, so the assistant says so and offers staff.
- The matcher is keyword-based; Sorani vocabulary and all Sorani strings need a native reader.
- No SLA policies or routing rules are seeded, so new tickets carry no due times until the admin sets policies.
- Shell (not this area): on a URL whose query contains `%20`, the language links' `href` differ between server (`+`) and
  client (`%20`) — a hydration attribute warning. Links this area builds always use `+`.
