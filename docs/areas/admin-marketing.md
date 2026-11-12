# Admin 16 — Marketing & growth

Owner: admin module 16 (`/admin/marketing/…`, permission group `marketing`). Routes in `app/routes/admin/marketing/`,
services in `app/server/services/admin/marketing/`, strings in `app/i18n/messages/admin-marketing.ts` (ar source, en,
ckb), tests `tests/admin-marketing*.test.ts`. Exports: `docs/CONTRACTS.md` §4 "16 marketing". Definitions of CAC, ROAS
and LTV: `docs/metrics.md` §8.

## What exists

| Path | What | Permission |
|---|---|---|
| `/admin/marketing` | What waits (requests to decide, approved campaigns due, reviews), each section's figures (real records; demo counted apart), the boundary, blueprint status | any `marketing.*` |
| `/admin/marketing/campaigns` | Campaigns by state (draft, waiting, approved, due, released — held —, tracking, closed); views incl. "waiting for me", search, channel, demo in the URL; table ≥ 768px, cards below | `campaign.manage` \| `campaign.send` |
| `/admin/marketing/campaigns/:id` (`new`) | Draft (audience, text per language with safe variables, schedule, budget, `utm_campaign`), who it reaches NOW and why others are out, the request for a second person, release, recipients, the campaign's links, spend per month, history | same; writes per intent |
| `/admin/marketing/segments` | 16.03: buyers of a platform in a date window × module 07's stored segment; how many may be messaged now; "start a campaign with this audience" | same |
| `/admin/marketing/carts` | 16.02: carts left by known customers, a verdict each, held reminders with limits, reminded carts and what became of them | `cart_recovery.manage` |
| `/admin/marketing/links` | 16.04: UTM link builder, the links, attribution of sales (only orders that carry their source) | `utm.manage` (write) \| `report.read` |
| `/admin/marketing/cross-sell` | 16.05: pin / boost / exclude add-ons per device and shelf; each rule's effect now; the device's setup shelf as shoppers see it | `recommendation.manage` |
| `/admin/marketing/reviews` | 16.06: approve / reject customer reviews | `review.moderate` |
| `/admin/marketing/performance` (+ `/csv`) | 16.07: spend, new customers, CAC, ROAS, LTV per month and campaign, with definitions and sources; CSV (audited) and print | `report.read` |

Default roles: owner and manager hold every marketing permission; finance `report.read`; content `review.moderate`;
everyone else none (the shell's gate refuses the module).

## The rules

**Consent (16.01, 16.02; `audience.server.ts`).** A person is an account with every guest checkout of its number or
claimed by it, or a number without an account. Their consent is the NEWEST `consents` row of kind `marketing` across
all of those subjects: yes → may be messaged; a later "no" anywhere wins; never answered = no. Guest-checkout answers
per number count. Merged, deleted (erased, anonymized) and blocked accounts never receive anything, nor does a number
tied to one. Demo people only in demo campaigns. An account that switched the channel off is left out on that
channel; e-mail needs an address. `SEND_LIMITS`: at most 2 marketing messages (campaigns + cart reminders) per
recipient per 7 days, counted from the outbox. Every rule is checked again INSIDE the write (`recipientGuard`, an
`INSERT … SELECT … WHERE` over `json_each`): a withdrawal that lands between the count and the write keeps the message
out, and the release counts that person as `changed`. Each person is counted once under the first reason that applies
(`EXCLUSION_REASONS`), so held + every reason = the people considered. `{name}` is the first word of the name only when
it is made of letters (`firstName`): a guest-checkout name is anyone's to type, so a web address, a number or a code
never enters the text — the neutral word does.

**Campaigns.** A draft (create: idempotency key → `cmp_<hash>`; edit: guarded on `updated_at`, refused while a request
waits). Text: ar required, en / ckb optional; only `{name}` (first name, else a neutral word), `{link}` (one of the
campaign's own UTM links) and `{store}`; SMS ≤ 640 characters. Submitting needs an audience that reaches someone and
≤ 5,000 people (`approvals` kind `marketing_campaign`, payload = the campaign's fingerprint). A second person with
`marketing.campaign.send` decides — never the requester, never anyone who created or edited it (audit trail; both
re-checked inside the batch); approving binds to the fingerprint the decider saw. Approved → `scheduled`; when due
(`scheduled_at` empty or past) `releaseCampaign` resolves the audience again and writes, per recipient, one outbox
row `held` (template `marketing_campaign`, `payload.text` in the recipient's language) and a `campaign_recipients`
row `held`; people without consent are documented `skipped_no_consent`. Idempotent and resumable (dedupe key
`campaign:<id>:<recipient>`, UNIQUE campaign + recipient); a second click answers the first release's result. `{link}` is
read by its id (never "the newest 50 links"). `utm_campaign` is unique, also inside the write. The list's views include
"due" (approved message campaigns whose time has come) — the front page's "due" figure opens exactly that list. Status `sending` is shown as "released — held in the
outbox". Cancel (before release, reason), close (after). Tracking campaigns (social, ads, offline) carry links, budget,
dates and spend; they are approved the same way and never message anyone.

**Spend (16.07).** Entries per campaign and month in `campaigns.content.spend` (`spend_iqd` = their sum), guarded on
`updated_at` (every writer of `content` moves it, the release's record too), one key = one entry (the same form sent
twice at once answers the first entry), corrections as negative entries, a month never below 0, never a future month;
a confirm dialog shows the month's and the campaign's spend before → after. Per campaign, spend exists only here: the
finance books hold marketing expenses as a whole (account 6400), not per campaign, and the two are not matched.

**Cart reminders (16.02).** Carts with lines, not converted, idle ≥ 2 h and ≤ 7 days, of a signed-in customer who
passes the consent rules on SMS; not when they ordered since, nothing is buyable, the cart was reminded (one per cart),
the person had a cart reminder in 7 days, or the limit is reached. Quiet hours 21:00–09:00 (scheduled for 09:00).
Prepared reminders: `cart_reminders` `held` + an outbox row `held` (template `cart_reminder`, payload name / items /
link / text). A cart that becomes an order after its reminder is marked converted — and the page says the shopper
never received it.

**Links and attribution (16.04).** Paths through the CMS's `normalizeStorePath` (locale-less; admin / API refused) and
`checkStoreLink` (a missing page is refused). URL = path + `utm_source/medium/campaign/content/term` + `tt_l=<code>`.
Attribution reads only `orders.utm_link_id` / `orders.attribution`; clicks are "not measured". An ATTRIBUTED order is one
attributed to a (non-demo, unless asked) campaign (metrics §8): months, totals and campaign rows count the same orders;
"carry their source" also counts sources that match no campaign.

**Cross-sell (16.05).** Rules in `recommendation_rules` (context `{ deviceModelId, placement? }`). Pin / boost only an
add-on (`ADDON_KINDS`) VERIFIED on the device by the catalogue's compatibility rules (partial / incompatible /
unverified refused with the status); re-checked when a rule is switched back on (a device no longer published is a
refusal); one active rule per kind, product, device and shelf — also when switching on, and inside the write. A rule
is added through a confirm dialog (product, device, shelves, weight). The engine still applies its own hard filter and
stock rule.

**Reviews (16.06).** No creation path, no demo reviews. Approve only `is_verified_purchase` AND (inside the write) a
delivered order of the same customer and product; reject with a reason code (abusive, personal data, off topic, spam,
not about the product, other + note) — never for being negative. The author's name only with `customers.customer.read`.

**Privacy and field rules.** Phones masked without `customer.phone.read_full`, e-mails likewise; customer names link to
the profile only with `customers.customer.read` (`CustomerName`). No cost, margin or profit is read anywhere. The front
page counts real records only (no demo campaign, link of a demo campaign or demo customer's cart reminder).

## Boundaries (said on the pages)

- No SMS / WhatsApp / e-mail provider: every campaign message and cart reminder is HELD; nothing is reported as sent.
  Held rows are not picked up by `deliverOutbox` (it sends `queued` ones); when a provider is connected, held marketing
  rows must not be re-queued without checking consent again.
- The storefront records no source: no order is attributed, ROAS is not available, clicks are not counted.
- Customers cannot write reviews yet (no storefront form).
- Limits are module constants (`SEND_LIMITS`, `CART_RECOVERY`) until the settings module adds keys.
- Releasing at the scheduled time and preparing reminders are by hand until scheduled jobs exist (functions ready).

## Verify

```
npx vitest run tests/admin-marketing.test.ts tests/admin-marketing-routes.test.ts   # 21 + 1
npx vitest run tests/admin-marketing-review.test.ts                                  # 15 (review 2026-11-12)
npx vitest run tests/i18n.test.ts tests/admin-shell.test.ts
node scripts/lint-design.mjs app/routes/admin/marketing                              # 0 findings
```
Browser scripts (sign-in once per role, seed through the services, screenshots, click-through) and the shots: the
task's scratchpad `work/admin-marketing/`.

## Requests to other owners

- **Storefront (shell + checkout) and commerce core:** capture `utm_source/medium/campaign/content/term` and `tt_l` on
  landing (first-party, with the privacy policy's consent rule) and pass them to `placeOrder`, which writes
  `orders.attribution` and `orders.utm_link_id` (the link whose `code` = `tt_l`); count clicks on `utm_links.clicks`.
- **Product area:** a review form for delivered order lines (`is_verified_purchase`, `order_item_id`), status pending.
- **Settings 22:** register templates `marketing_campaign` (`text`, `subject`) and `cart_reminder` (`name`, `items`,
  `link`, `text`) in `TEMPLATE_CATALOG`; keys for the sending limits and cart-recovery windows.
- **Jobs:** `releaseDueCampaigns(db, systemActor("marketing.campaigns.release"), now, origin)` every few minutes and
  `prepareCartReminders` hourly (a system actor holding `marketing.cart_recovery.manage`).
- **Shell (bell):** `marketingQueueCounts` → campaigns to decide `/admin/marketing/campaigns?view=decide`, reviews
  `/admin/marketing/reviews`. **Staff 15:** `approvalHref("marketing_campaign", "campaign", id)` →
  `/admin/marketing/campaigns/<id>`.
- **Customers 07:** an erasure should also clear the account's `campaign_recipients.recipient` (held rows keep the
  number) — or tell us to.
- **Integrations 21:** a provider must re-check consent before sending a held marketing row, and skip a held
  `cart_reminder` row whose `cart_reminders.status` is `converted` (the cart became an order).
- **Store owner:** a guest checkout's "yes" counts for its number (asked of this module), and the newest answer wins —
  so an unverified checkout with an account's number can turn that account's "no" back into "yes". Keep, or count a
  "yes" for an account only from the account itself or a checkout it claimed (a "no" from anywhere still wins)?
