# Admin 21 — Branches, channels and integrations

Owner: admin module 21. URL and permission group `channels` (`/admin/channels/…`; the blueprint calls it
"integrations"). Arabic first, English second; strings `app/i18n/messages/admin-channels.ts` (ar, en, ckb — Sorani needs
a native reader). Services `app/server/services/admin/channels/*`, routes `app/routes/admin/channels/*`.

## Pages

| Path | What | Permission |
|---|---|---|
| `/admin/channels` | what waits (given-up deliveries, keys expiring in 14 days), figures, stated limits, `<ModuleFunctions moduleId="21">` | any `channels.*` |
| `/branches`, `/branches/new`, `/branches/:id` | 21.01 branches: add (form key → same branch), edit (stale form refused), switch off/on with a reason (refused while active locations, registers, limited employees or price lists use it — re-checked in the write), and what belongs to it: locations + stock (04), registers (06), employees (20), price lists (03), this month's till sales | `channels.branch.manage`; each part also its module's read permission; branch-limited employees: their branch only, never create / switch |
| `/sales` | 21.01 per channel: stock (web: every active sellable location; POS: the registers' store locations), prices (POS applies its lists; the web checkout does NOT apply price lists yet — said so), delivery (web: the governorate fee rule; POS: at the counter), each linked to its module; add a marketplace / social channel (a record, not connected), rename (fingerprint), switch an added one off (refused while active price lists use it); web and pos are never switched off here | read `channels.channel.manage` or `channels.report.read`; changes `channels.channel.manage` |
| `/orders` | 21.02 per channel for a period (`?period=` or `?from&to`, `&demo=1`): placed, open, delivered, cancelled, returned, GMV, average basket, latest; linked to module 05's list for the same days (web and POS together) and module 06's sales | `orders.order.read`, no branch limit |
| `/profit` | 21.06 per channel (POS per branch): revenue, discounts, refunds, net, delivery fees; COGS + carrier costs (`cost.read`); gross profit, contribution, margins (`cost.read` + `profit.read`) — keys ABSENT otherwise (loader, print); what has no channel and commissions on their own lines; the store's figures from `profitAndLoss`; prints as the table on an A4 landscape sheet, ink on paper from a dark screen too | `channels.report.read`, no branch limit |
| `/api`, `/api/docs` | 21.03 keys: name, scopes (only held ones), expiry (30/90/180/365 days), rate a minute; shown once; revoke with a reason; "suspended" while the creator's account is disabled or branch-limited. The reference of the API and webhooks | keys `channels.api_key.manage`, created without a branch limit; docs any `channels.*` |
| `/webhooks`, `/webhooks/:id` | 21.03 registry: https:443 public host only; secret shown once (encrypted, DATA_KEY); events; pause/resume, new secret (once), ping; "look for new events now"; deliveries | `channels.webhook.manage`; create / re-point / resume also `orders.order.read` and no branch limit |
| `/monitor` | 21.04 deliveries by status (URL filters), retry (same delivery), incoming provider events, outbox held/failed counts, the boundaries | `channels.integration.read` or the webhook / provider managers; retry `channels.webhook.manage` |
| `/providers` | 21.05 payment (Zain Cash, Qi Card, FastPay, AsiaHawala), shipping (the store's third-party couriers, module 11), messaging (SMS, WhatsApp Business Platform, email) — all NOT connected; settings + secret kept encrypted, never shown or logged; remove the secret | read `channels.integration.read`; save `channels.integration.manage` |

`GET /api/v1/:resource` (`routes/admin/channels/api-v1.ts`, resource route) — written and tested, **not registered**
(the server core owns `app/routes/api/_routes.ts`; requested).

## Rules that hold

- Authorization in every service (`assertCan` / `assertAny` before the input is read) and in every loader / action
  (`ch.open(args, permission)`); the gate admits the module's permission group only.
- Branch limits (`isWholeStore` / `assertWholeStore`, shared.server.ts): an employee limited to a branch works on
  their own branch only and gets `forbidden "branch"` (403) for what covers every branch — the orders summary and the
  profitability report (with the store's net profit; as the reports of module 18), creating a branch, switching one,
  creating an API key, creating / re-pointing / resuming a webhook. The home counts their branch only.
- The hierarchy rule over time (SECURITY §7): an API key works only while its creator could still make it —
  `verifyApiKey` reads the creator: a disabled or branch-limited account stops the key (401, listed as "suspended",
  not counted active), and the key's scopes are those the creator's roles grant now (a scope taken away → 403; a role
  that requires two-step verification the creator lacks → none). Webhook events carry order references and totals:
  creating, re-pointing or resuming one needs `orders.order.read` (`orders_read_required`, 403); the deliveries list
  shows order references only with `orders.order.read`.
- Every change is one batch with its audit event (`channels.branch.*`, `channels.channel.*`, `channels.api_key.*`,
  `channels.webhook.*`, `channels.integration.*`, `channels.api.call`). Tables without a version column are written
  with every column compared with what was read (branches, channels, webhooks); integrations guard on `updated_at`.
- Creation ids derive from the form's idempotency key (`keyedId`): a resubmitted form names the same record
  (`replayed`); the same key with other values → `idempotency_mismatch`.
- Secrets: API keys `ttk_<8>_<43>` (256 bits) — only `sha256` stored, shown once, never in a loader, list or audit
  event; webhook secrets `whsec_…` and provider secrets AES-256-GCM with DATA_KEY bound to `webhook:<id>:secret` /
  `integration:<kind>:<provider>:secret`; without DATA_KEY nothing is saved (`data_key_missing`, 503). Audit keeps a
  webhook's host only (a path may carry the receiver's token).
- The API: GET/HEAD only; key in the address → 400; per network 120/min before the key; `Bearer` key (one 401 for
  malformed / unknown / revoked / expired / suspended); scope (the key's AND still its creator's) → 403; the key's own
  rate → 429 + `Retry-After`; JSON `no-store`; no cost, no customer name / phone / address; demo rows `demo: true`;
  every answered call audited as `api_key:<id>`.
- Webhooks: one delivery per (webhook, event) — UNIQUE; order events (placed, confirmed, shipped, delivered,
  cancelled, returned) after the webhook's creation, ≤ 7 days back, queued once however often (`queueOrderEvents`
  reads only events not queued yet, so a burst larger than one 500-event scan inside the 5-minute overlap is caught up
  over the next runs instead of stalling the cursor); payload: ref, channel, status, total — never PII or cost.
  Delivery: claim (attempts n → n+1 and back to "pending", guarded), sign (`X-TamTam-Signature: t=…,v1=hex
  HMAC-SHA256("t.body")`), send through a `WebhookTransport`, success never resent, failures back off
  1/5/30/120/720 min, give up after 6; a person's retry makes the SAME row due — never one whose attempt is out
  (pending), so a retry never sends a delivery twice at once.
- **Boundary:** no transport exists — `deliverWebhooks` returns `no_transport` and sends nothing. A Worker cannot pin
  the address it checked, so delivery stays off until a vetted relay exists; such a transport must resolve the host,
  check every address with `isPublicAddress` (private, loopback, link-local, CGNAT, metadata, documentation, multicast,
  IPv6 local, mapped forms) and follow no redirect. The registry already refuses IP literals in any notation,
  localhost / local suffixes, credentials and ports other than 443 (`checkWebhookUrl`) — and so does a provider's
  address setting (`endpoint`, a `url` field), so no stored setting points a future adapter at a private address.
- Inbound (`acceptInboundEvent`): the `inbound_events` row ("provider:event id") and its effects in one batch — a
  repeat is `replayed` and changes nothing; an unsigned event is recorded as failed and never acts.
- Profitability attribution by the entry's reference: order (sale, COGS, goods back undelivered), refund, return,
  return line, payment → the order's channel (POS by `orders.branch_id`); COD settlement → its parcels' channel when
  they share one; POS shift → pos. Everything else = "no channel"; commissions (payroll) store-wide. Σ channels +
  no channel − commissions = `profitAndLoss(...).profit.netIqd` (tested). Demo postings only with `&demo=1`.
- Lists keep their state in the URL (`?view=`, `?status=&webhook=&page=`, period), tables from 768px, cards below.
  Each figure opens the list it counts: the monitor's figures (every webhook) open the unfiltered list; the home's
  deliveries waiting are pending + failed, as the webhook list counts them.
- Typed digits: Arabic-Indic and Persian digits are read as digits in branch codes, channel keys, phones, a key's
  expiry and rate.

## Exports (CONTRACTS §4 "21 channels")

`channelsAccess`, `channelsQueueCounts(db, actor) → { deliveriesGaveUp | null }` (for the bell), `acceptInboundEvent`,
`queueOrderEvents(db, now)` and `deliverWebhooks(db, { dataKey, transport }, now)` (for the jobs), `handleApiRequest`,
`checkWebhookUrl`, `isPublicAddress`, `verifyWebhookSignature`, `channelProfitability`, `ordersByChannel`, the branch
and channel services.

## Requests to other owners

- **Server core** (`app/routes/api/_routes.ts`): `route("api/v1/:resource", "routes/admin/channels/api-v1.ts"),`.
- **Jobs** (`app/server/jobs.server.ts`): FREQUENT `channels.webhooks.queue` → `queueOrderEvents(db, now)`; and
  `channels.webhooks.deliver` → `deliverWebhooks(db, { dataKey: env.DATA_KEY, transport: null }, now)` (records the
  boundary as skipped until a transport exists).
- **Shell** (bell): `channelsQueueCounts(db, actor).deliveriesGaveUp` → `/admin/channels/monitor?status=gave_up`.
- **Orders 05:** a `channel` filter (`?channel=web|pos`) in `parseListFilters` / `listSearch` / `listWhere`.
- **Inventory 04:** `updateLocation({ branchId })` for a top-level location (children follow), so an existing store
  can be put under a branch.
- **Commerce core:** apply `resolveListPrice(channel "web")` in the cart pricing, or keep web price lists out of
  the pricing screens; read `channels.is_active` if the owner wants an on/off switch for web or POS.
- **Security 20:** `/admin/security/staff` could filter by branch (a branch page links there).

## Verify

```
npx vitest run tests/admin-channels.test.ts tests/admin-channels-routes.test.ts tests/admin-channels-review.test.ts   # 26 + 8 + 12
node scripts/lint-design.mjs app/routes/admin/channels                                                                # 0 findings
```

The API test's "wrong key" (fix 2026-11-13): it replaced the key's last character with «A», but the 43rd base64url
character of 32 random bytes is one of 16, so one key in 16 already ended in «A» and the "wrong" key was the key
itself — the API rightly answered 200 ("expected 401, got 200" in full runs, never an order or load effect; 6.22 % of
200,000 sampled keys). The wrong key now changes the last character whatever it is (and the test asserts it differs);
the 401 check is unchanged. 24 repeated runs: 24 passed.

Browser (Chromium, puppeteer): every page at 390 and 1440, light and dark, ar and en; empty / filled / validation /
confirm dialog / 403 states — scripts and shots in the module's scratch folder (`work/admin-channels/`, the review's in
`work/admin-channels/review/`: the branch-limited and suspended-key states, the provider address refusal, the printed
report as an A4 landscape PDF from a dark screen).

## Not done / limits

- No marketplace, payment, courier or messaging connection (boundaries); no outgoing webhook is sent; the read API is
  not reachable until registered; the queue job is not scheduled (staff can run it from `/webhooks`).
- Commissions are not per channel (booked with payroll); a marketplace channel has no sales by construction.
- A webhook is not bound to its creator the way a key is (only creating, re-pointing and resuming check who acts):
  when a transport is built, stop queuing for a webhook whose creator no longer holds `orders.order.read`.
- Demo records exist only as named "تجريبي" rows (branches, channels, keys and webhooks have no `is_demo` column).
