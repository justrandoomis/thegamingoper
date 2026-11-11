# Devices area — device hubs, compatibility, recommendations, signals

Owner: storefront area "devices". Brief §3.4 and §6, DESIGN.md §8.7, CONTRACTS.md §3 (devices row).
Files: `app/routes/storefront/devices/**`, `app/routes/api/events.ts`, `app/server/services/{devices,compatibility,recommendations}.server.ts`,
`app/i18n/messages/devices.ts`, `tests/devices.test.ts` (20), `tests/recommendations.test.ts` (17).

## Routes

| Path | What |
|---|---|
| `/device/:model` | "everything about this device" for every published model of an active platform (25 in the demo). Unknown, draft, archived and inactive-platform slugs (the generic `windows-pc`) → the shell's 404. The mega menu's `/device/<slug>.data` prefetch answers |
| `POST /api/events` | `kind=view\|click\|add productId source?` → `{ ok, recorded }`; `intent=forget` → `{ ok, forgotten }`; `kind=purchase` → 400 (server code only); GET 405; cross-site 403; 120/min per IP |

Hub sections, in order (sticky section keys under the header, `#versions … #used`): breadcrumbs (+ JSON-LD) · hero (lit
stage = shared-element target `device-image:<slug>`, LED + platform, h1, summary, release date, generation, counts of
VERIFIED games / accessories) · editions (product cards) + versions table (maker's model numbers, later release dates) +
"before you buy" research note + folded notes of the other editions and highlights · **complete your setup** (streamed
recommendation shelf) · comparison with up to 4 siblings (same platform and catalogue category, same generation first;
fixed rows; "—" = not in our sources; sibling names push sideways in model order) · grouped spec sheet + sources ·
accessories and games by status (verified / partial as card rails with the rule's note; unverified / incompatible as
plain rows without an add key) · setup & repair (approved public guides of the model, its platform, its generation's
siblings labelled "written for X"; diagnosis trees → assistant; repair request; spare parts; the store's warranty) · FAQ
answered only from stored facts · used units of this model.

## States (brief §12)

| State | What happens |
|---|---|
| default / partial data | every block renders only from data; a model without specs, rules, guides or siblings shows the honest empty line, never filler |
| loading | SSR; the setup shelf streams into placeholders of the same geometry (keyed by device, so a hub → hub push commits at once); cards inflate (`Bubble`) only when they arrive after the page — hydrated HTML is simply there |
| empty | no editions / parts / used units / documented accessories → `EmptyState` with the one way forward (used, repair, contact, trade-in) |
| API failure | the shelf's failure is `{ ok: false }` → `ErrorState` with retry (revalidate) in its space; the rest works. Loader failure → shell 500 |
| offline | shell banner; add keys roll back (kit) |
| reduced motion | engine rules: no zoom/push, instant swaps; section keys scroll without smoothing |
| not applicable | validation (no form), pending review (unapproved guides are simply not listed), unauthorized (public) |

## Real, demo, boundary

- **Real (researched):** device names, specs and labels, release dates, generations, model numbers, notes, highlights,
  photos, sources, the 391 compatibility rules (shown as stored — partial stays partial, a game that exists for a model
  but whose disc does not fit it is "incompatible"), guides and trees (seeded, approved, `is_demo`).
- **Demo:** prices and stock on every card (the shell's ribbon). **Store warranty:** not set by the owner (STATUS open
  item 15) → "لم يحدّد المتجر بعد مدة ضمانه…"; set `products.warranty_months` and the hub states it.
- **Rules of the services:** model › generation › platform, variant › product; no rule = unverified; versions that
  disagree → partial naming the ones that work. `getCompatibilityForProduct` lists every device a rule touches plus an
  explicit "unverified" for the other consoles/handhelds of the product's platforms (never for a device itself, never
  for an inactive platform). Recommendations: hard filter = VERIFIED on a context device; out of stock dropped; no
  repeats; kinds take turns; `recommendation_rules` pin / exclude / boost by context (a pin cannot break the filter);
  "bought together" only from ≥ 5 real (non-demo, not cancelled/returned) orders; cold start = store picks that say
  they do not use browsing. A model that is one variant of a shared product (2020 PS5 Digital) is matched by the
  variant's first photo = the model's photo.
- **Signals:** only with consent (customer's latest `consents` row, else `tt_consent`); guests keyed by sha256 of
  `tt_rs` (random, httpOnly, 90 days, set on the first consented event — or at checkout with a consenting guest's
  first purchase), customers by id; no IP/UA; dedup windows; `forgetEvents`, `purgeRecommendationEvents` (90 days,
  run daily by the retention job). The hub sends a click signal (consent only) when a card in one of its shelves is
  opened (`components/signals.ts`, source = shelf key); so do the shelves on other pages (source = `<context>:<shelf>`).

## Exports for other areas (CONTRACTS §3)

- `getCompatibilityForProduct(db, locale, productId)` → `{ deviceSlug, deviceName, status, note, platformSlug, hasHub, level }[]`.
- `getRecommendations(db, { locale, context, productId?, deviceModelId?, cartVariantIds?, platformSlugs?, sessionHash?, customerId?, consent, now? }, limit)` → `Shelf<ProductCardData>[]`.
- `recommendationsFor(db, { cookie, customerId }, { locale, context, productId?, deviceModelId?, cartVariantIds?, platformSlugs?, keep?, personalOnly?, now? }, limit)`
  → `Promise<{ ok, shelves }>` — what a page's loader STREAMS (never awaited, never rejects; a failure is `ok: false`,
  logged). Home and search read consent and the session key first (`personalizationFor`); `personalOnly` reads nothing
  without consent and keeps only `<context>:personal`. A customer's personal shelf says it is built from the account's
  views and saved devices (`rec.personal.reasonAccount`), a guest's from this device.
- `personalizationFor(db, { cookie: ctx.cookie, customerId })` → `{ consent, sessionHash, customerId }`.
- `recordEvent(db, who, { kind, productId, source? }, now)` · `recordPurchaseSignals(db, who, productIds, now)` (server
  only: the checkout's own server file after a new order) · `forgetEvents` · `purgeRecommendationEvents` (the daily
  retention job calls it since 2026-11-11, so the privacy draft says "deleted") · `orderItemsOf(db, ref)`,
  `usedUnitVariantIds(db, ids)` (cart/order anchors).
- `getDeviceHub`, `getDeviceLink(db, locale, slug)` (a hub as a row link, null without one), `listDeviceHubs(db, locale)`
  (sitemap), `compatibilityForModels`, `loadDeviceTargets`.
- Client: `components/RecommendationShelves.tsx` (the shared drawer of streamed shelves: nothing until they arrive, cards
  inflate in, a newer answer replaces the old only when it is here — hub filters never flicker —, `layout="column"`
  for the cart/order column, a failure is a retry panel, clicks on its cards are "click" signals with consent);
  `components/DeviceHubLink.tsx` (the row link to a hub; picture = shared element `device-image:<slug>`);
  `sendRecommendationEvent`, `useSignalConsent`, `useShelfSignals` (`components/signals.ts`).

## Wired by the integration pass (2026-11-11)

- Product page: compatibility rows (hub links), the device hub row link, the "product" shelves (replacing the page's
  unchecked related shelves), the "view" signal once on screen (consent only).
- Cart / order page: "cart" and "post_purchase" shelves anchored on every line (used units through their variant);
  the purchase signal after a NEW order (`checkout.server.ts → recordPurchase`, consent only, a consenting guest gets
  its `tt_rs` there; a replay records nothing).
- Home (personal shelf only), platform and category hubs and search results (personal shelf only, consent), the search
  start page (personal + the store's picks). Used unit pages: the model's "complete your setup" shelf + hub link. Help
  centre device panel: hub link.
- Forgetting: the home panel's "stop" and the account settings' withdrawal both run `forgetPersonalData`
  (home/personal.server: `forgetEvents` for this device's `tt_rs` and the account + clear `tt_rs` + the account's
  recently-viewed list); `POST /api/events intent=forget` still works on its own.
- `device-image:<slug>`: the catalog platform/category hub device tiles and every `DeviceHubLink` grow into the hub's stage.
- Open: guides — the hub reads approved articles itself; `support/kb.server.ts → listArticlesForDevice` may replace that read.

## Verify

```
npx vitest run tests/devices.test.ts tests/recommendations.test.ts     37 tests
node scripts/lint-design.mjs app/routes/storefront/devices …           0 findings
```
Browser (headless Edge, dev server): all 25 hubs × ar/en/ckb at 360 px: 200, no overflow, no console warning; flow:
section keys, sibling push, Back, card → product → Back (390 and 1440 reduced motion); loading placeholder and failure
state forced once; `/api/events` by curl (403/405/400, no-consent no-op, cookie, dedup, forget). Screenshots in `.shots/devices/`.
Not done: Safari/Firefox/phones; the Sorani strings (and the Sorani month names) need a native reader.
