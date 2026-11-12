# Devices area — device hubs, compatibility, recommendations, signals

Owner: storefront area "devices". Brief §3.4 and §6, Design System v2 §6.6 (the hub template) and §6.17 (states),
CONTRACTS.md §3 (devices row). Files: `app/routes/storefront/devices/**`, `app/routes/api/events.ts`,
`app/server/services/{devices,compatibility,recommendations}.server.ts`, `app/i18n/messages/devices.ts`,
`tests/devices.test.ts` (30), `tests/recommendations.test.ts` (17).

## Routes

| Path | What |
|---|---|
| `/device/:model` | "everything about this device" for every published model of an active platform (25 in the demo). Unknown, draft, archived and inactive-platform slugs (the generic `windows-pc`) → the shell's 404. The mega menu's `/device/<slug>.data` prefetch answers |
| `POST /api/events` | `kind=view\|click\|add productId source?` → `{ ok, recorded }`; `intent=forget` → `{ ok, forgotten }`; `kind=purchase` → 400 (server code only); GET 405; cross-site 403; 120/min per IP |

## The hub page (Design System v2, stage 3 — 2026-11-12, reviewed the same day)

Page order (`device.tsx`): breadcrumbs (from 768; JSON-LD always) · **head** · **sticky section chips** (16px under
the head) · editions · complete your setup · comparison · specs · accessories (compatible only) · games · setup and
repair · questions · used. A section with nothing in it is not drawn and its chip is not offered (`hubSections()` in
`components/format.ts`, the same rules as the components). One red primary per view: the head's key (white on-band
clay in the light theme, the red primary in the dark one); every other action is secondary, ghost or a link; card add
buttons are the kit's neutral ones.

URL state: `?all=<grid>` (repeatable; `format.ts` `toggleGrid` / `expandedGrids`) shows a card grid in full. The key is
a real link, so it works before JavaScript (the page comes back with the grid open at its section) and Back or a reload
keep the grid open (the restored scroll still points at the same card); with JavaScript it opens at once and the URL
follows with a `replace`. `shouldRevalidate` skips the loader for a change of `all` alone. The canonical URL drops it.

| Piece | File | What |
|---|---|---|
| Head | `components/HubHead.tsx` | the kit's `Band kind="device"` (the platform's surface + one light; a lit cabinet in dark), min 200 phones / 280 from 1024. The device photo at the inline end (LCP, preloaded; on phones a box beside the title sized by the photo's aspect — `--hw-cap` — rising 16px above the band; from 768 the inline-end half). An opaque photo (not cut out yet, v2 §7.5) stands on a plate of the colour it kept (`--plate`, from the art manifest — white today), so no box shows inside the plate in either theme whatever the blend does. Phones: the light-theme band is flat (`--tile-sheen: transparent`) — the facts, price and key run across the whole band where the kit paints its sheen (60% height), and white text fell to 3.9:1 there. Copy: the platform pill, h1 «كل شيء عن / PlayStation 5 Slim» (the name on its own line through the kit's `BidiText`: Latin runs isolated, so «PlayStation 5 (الطراز الأصلي 2020)» reads name first; «Switch 2» never splits — `keepTogether`), ONE line of facts (release date, generation, «17 لعبة له في المتجر», «18 إكسسواراً له في المتجر» — verified records; `headFacts`: the facts that fit, the rest clipped and read by screen readers; a phone reads the release year only, «صدر عام 2025», so two facts share its line), the price line, the 40px on-band key «تسوّق إصدارات الجهاز» → `#versions` (on the price's row from 1024 when both fit). Compact steps (12px on phones, 12–16 above; copy padding 20 / 32). The shared-element target `device-image:<slug>`. Head height below |
| «من …» price | `hub.server.ts` (`fromPriceOf`), `format.ts` (`cheapestOrderable`, `headPrice`) | the cheapest version OF THIS DEVICE the cart accepts now: a one-version edition is its card; an edition with several is read through `getProductDetail` (every version's price and `orderable`); only `DeviceHub.versions` count (one product can cover two models — the 2020 PS5 never shows its Digital Edition's price). STREAMED as a `FromOutcome` (`{ amount }` or `{ failed: true }`) into a Suspense boundary keyed by device (a hub → hub push shows the reserved line at once instead of holding the navigation until the price arrives). No orderable version → «نفد حالياً», or «قريباً · الطلب يفتح عند وصوله» when an edition is coming — even when a shared product's card says in stock; a failed read → nothing (never a guess) |
| Section chips | `components/SectionNav.tsx` | the kit's `Chip` links (40px, 44 hit) in one opaque row stuck under the header (`--shell-top`), pulled up to 16px under the head; the section being read is the chosen chip — measured on scroll (`currentSection`): none while the head is on screen, the last one at the very end of the page; the row scrolls sideways and keeps the current — or keyboard-focused — chip fully in view (`reveal.ts`). `devices.css` extends the root's scroll padding by the row (57px), so jumps and focused controls land below both bars |
| Editions | `components/VersionsSection.tsx` | the cards (`CardGrid`; one edition = a `row` card), the versions table (maker's model numbers, later release dates as «يصدر في …»), «قبل أن تشتري» as the kit's warn callout, folded notes and highlights. A device not sold new keeps the table («لا نبيع هذا الجهاز جديداً الآن. هذه طرازاته وأرقامها.») |
| Cards grid | `components/CardGrid.tsx` | whole rows 2 → 3 → 4 → 5; each card's compatibility note on one shared line under it (a two-row subgrid per item — prices align on the pinned foot); two rows at first, «اعرض كل الإكسسوارات (18)» (a link, `aria-expanded`, URL state above) opens the rest in place, shown only when more exist at the current width; folding keeps the key in view |
| Complete your setup | `components/SetupShelf.tsx` | streamed; each state is ONE element of the page's track or none: loading = the kit shelf's head + the rail's geometry with empty wells (aria-busy, a status line); arrived = the kit's `ShelfRail`, cards inflate in when they arrive after the page; failure (or the stream's 5 s timeout) = the head stays, an `ErrorState` with retry in the rail's place; empty, or only shelves of fewer than three cards (`drawableShelves`) = no element (no double section gap) |
| Comparison | `components/CompareSection.tsx` | paper table, hairlines, sticky first column, focusable region that scrolls sideways (a focused sibling link is scrolled clear of the sticky column); the current device's column has an ink line and «هذا الجهاز»; names and cells through `BidiText` («Joy-Con» keeps its order when a line breaks inside it); a missing fact reads «غير موثّق»; siblings push sideways in model order |
| Specs | `components/SpecSection.tsx` | grouped panels: label 14/600 ink-2 + value 14 (`BidiText`); sources behind a disclosure |
| Accessories | `components/CompatSection.tsx` + `format.ts` `accessoryGroups` | §6.6 "compatible accessories (verified only)": verified = the section's cards, every one with its state word («متوافق») and the rule's note when it adds something; «تعمل بشرط» = cards with their condition. Accessories nobody has checked, or recorded as not working, are not listed here (their product pages name every device) |
| Games | `components/CompatSection.tsx` | as accessories, plus unverified / incompatible as folded paper rows (small well, name, state word + note), no add button — a disc that does not fit a digital console is worth knowing |
| Setup and repair | `components/HelpSection.tsx` | §6.6 order: guides as disclosure rows (summary + «اقرأ الدليل»), then the row links «شيء لا يعمل؟ اسأل مساعد الصيانة» (→ assistant) and «اطلب صيانة لـ …» (→ repair), diagnosis trees as rows into the assistant, spare parts (cards), the warranty as a `FactList` fact — or, unset, the question «اسألنا عن شروط الضمان» (→ the hand-off) |
| Questions | `components/FaqSection.tsx` | the kit's accordion; the service's isolated name is re-isolated run by run (`deviceIn`) |
| Used | `components/UsedSection.tsx` | the kit's used rows (1 column, 2 from 1024), «عرض الكل» → `/used?model=<slug>`; none → one closing line with «تصفّح المستعمل» and «استبدل جهازك» |

Names inside sentences go through `deviceIn` / `isolateName` (`format.ts`): every Latin run in its own LRI…PDI isolate
and the rest in the sentence, the string form of the kit's `BidiText` (one isolate around a name with an Arabic
qualifier made the qualifier lead in Arabic).

Retired here: `HubHero` (lit stage, quiet key), `SECTION_SCROLL_MARGIN`, the EmptyState slabs for empty sections, the
"لم يحدّد المتجر بعد…" warranty admission, «… تعمل عليه» counts (now «له في المتجر»), the entry cards of the help
section (now the row links §6.6 asks for) and their CTA strings.

## States (v2 §6.17)

| State | What happens |
|---|---|
| default / partial data | every block renders only from data; a section with nothing is not drawn (and has no chip) — never filler |
| loading | SSR; the «من …» line and the setup shelf stream into reserved space (both boundaries keyed by device, so a hub → hub push commits at once and shows the reserved space); cards inflate (`Bubble`) only when they arrive after the page |
| empty | sections hide; no used units → the closing line (used of the platform, trade-in); nothing orderable → «نفد حالياً» / «قريباً …» in the head |
| API failure | the shelf's `{ ok: false }` (or a stream cut at 5 s) → `ErrorState` with retry (revalidate) in its space, announced; the from-price's failure → no price. Loader failure → shell 500 |
| offline | the shell's banner; the shelf's `ErrorState` says the offline sentence and its retry waits for the connection (`retry.ts` — a revalidation offline would replace the whole hub with the error page); cards' add buttons roll back (kit) |
| sold out / coming soon | the kit's card states (photo at 50% + «نفد حالياً»; «قريباً» + «يصدر …» + «الطلب يفتح عند وصوله»), and the head's line (live: PS5 Slim sold out, the Xbox Series X25 coming) |
| demo | the shell's strip/chip, «سعر تجريبي» beside the head's price; cards follow the kit |
| reduced motion | engine rules: no zoom/push, instant swaps; the chips row scrolls without smoothing |
| no JavaScript | chips are anchors, the comparison scrolls natively, guides and FAQ are native `<details>`, «اعرض كل …» is a link (`?all=`) |
| not applicable | validation (no form), pending review (unapproved guides are not listed), unauthorised (public) |

## Real, demo, boundary

- **Real (researched):** device names, specs and labels, release dates, generations, model numbers, notes, highlights,
  photos, sources, the 391 compatibility rules (shown as stored — partial stays partial, a game that exists for a model
  but whose disc does not fit it is "incompatible"), guides and trees (seeded, approved, `is_demo`).
- **Demo:** prices and stock on every card and in the head (the shell's marking + «سعر تجريبي»). **Store warranty:**
  not set by the owner (STATUS open item 15) → the question «اسألنا عن شروط الضمان»; set `products.warranty_months`
  and the hub states it.
- **Rules of the services:** model › generation › platform, variant › product; no rule = unverified; versions that
  disagree → partial naming the ones that work. `getCompatibilityForProduct` lists every device a rule touches plus an
  explicit "unverified" for the other consoles/handhelds of the product's platforms (never for a device itself, never
  for an inactive platform). Recommendations: hard filter = VERIFIED on a context device; out of stock dropped; no
  repeats; kinds take turns; `recommendation_rules` pin / exclude / boost by context (a pin cannot break the filter);
  "bought together" only from ≥ 5 real (non-demo, not cancelled/returned) orders; cold start = store picks that say
  they do not use browsing. A model that is one variant of a shared product (2020 PS5 Digital) is matched by the
  variant's first photo = the model's photo.
- **Signals:** only with consent (customer's latest `consents` row, else `tt_consent`); guests keyed by sha256 of
  `tt_rs` (random, httpOnly, 90 days), customers by id; no IP/UA; dedup windows; `forgetEvents`,
  `purgeRecommendationEvents` (90 days, the daily retention job). The hub sends a click signal (consent only) when a
  card in one of its groups is opened (`[data-shelf]`: `versions`, `device_hub:<accessories|games>:<verified|partial>`,
  `parts`, the setup shelf's keys); the shelves on other pages too (source = `<context>:<shelf>`).

## Exports for other areas (CONTRACTS §3) — signatures kept

- `getCompatibilityForProduct(db, locale, productId)` → `{ deviceSlug, deviceName, status, note, platformSlug, hasHub, level }[]`.
- `getRecommendations(db, { locale, context, productId?, deviceModelId?, cartVariantIds?, platformSlugs?, sessionHash?, customerId?, consent, now? }, limit)` → `Shelf<ProductCardData>[]`.
- `recommendationsFor(db, { cookie, customerId }, { locale, context, … }, limit)` → `Promise<{ ok, shelves }>` — what a
  page's loader STREAMS (never awaited, never rejects; a failure is `ok: false`, logged). `personalizationFor`,
  `recordEvent`, `recordPurchaseSignals`, `forgetEvents`, `purgeRecommendationEvents`, `orderItemsOf`,
  `usedUnitVariantIds`, `getDeviceHub`, `getDeviceLink`, `listDeviceHubs`, `compatibilityForModels`, `loadDeviceTargets`.
- **`components/RecommendationShelves.tsx`** (home, product, cart, order, hubs, search, used unit) — props unchanged:
  `result`, `source`, `headingLevel?`, `sizes?`, `layout?: "page" | "column"`, `className?`; NEW optional
  `placeholder?: { title, reason?, loading? }` (reserve the shelf's geometry while it streams; default: nothing until
  it arrives, as before). v2 look: the kit's `ShelfRail` (phones: snap rail; from 1024 whole cards, 5-up — "column":
  at most 4), cards inflate in, a keyboard-focused card is brought fully into its phone rail. Only shelves of three
  cards or more are drawn; with none left it renders NO element (an empty box took a gap in the host's layout). A
  failure is the kit's `ErrorState` with retry; offline, the retry waits for the connection instead of revalidating
  (which would replace the host page with the error page). Also exported: `ShelfStack`, `ShelfPlaceholder` (the hub's
  setup shelf draws with them).
- `components/retry.ts` — `useSafeRetry()` → `{ retry, retrying }`: revalidate, but never while offline (then once the
  connection is back).
- **`components/DeviceHubLink.tsx`** — props unchanged (`device`, `title`, `text?`, `slot?`, `className?`): a paper
  card with a hairline, a 72px well (shared element `device-image:<slug>`), title, one line, the arrow. Utilities
  only (no area stylesheet), so it looks the same wherever it is imported; `className` wins.
- `components/signals.ts` — `sendRecommendationEvent`, `useSignalConsent`, `useShelfSignals` (unchanged).

## Wired by the integration pass (2026-11-11)

- Product page: compatibility rows (hub links), the device hub row link, the "product" shelves, the "view" signal.
- Cart / order page: "cart" and "post_purchase" shelves (`layout="column"`); the purchase signal after a NEW order.
- Home (personal shelf only), platform and category hubs and search (personal shelf, consent), the search start page
  (personal + the store's picks). Used unit pages: the model's setup shelf + hub link. Help centre device panel: hub link.
- `device-image:<slug>`: the catalog hub device tiles and every `DeviceHubLink` grow into the hub head's photo.
- Open: guides — the hub reads approved articles itself; `support/kb.server.ts → listArticlesForDevice` may replace that read.

## Verify

```
npx vitest run tests/devices.test.ts tests/recommendations.test.ts     47 tests
node scripts/lint-design.mjs --strict app/routes/storefront/devices    0 findings
```
Review (headless Edge, dev server, 2026-11-12; scripts in `…/scratchpad/work/pages-P5-devices-review/`): 3 hubs ×
360/390/768/1024/1440 × light/dark (ar) + 390/1440 en/ckb = 42 views: 200, no overflow, one h1, 0 console errors or
hydration warnings (every page also logs the root's two "preloaded but not used" font warnings), red primaries 0 in
light (the band's white key is the action) and exactly 1 in dark. Band text measured on the rendered band (text made
transparent, worst pixel under each run): ≥4.72:1 at every width in ar/en/ckb, light and dark — before the phone band
went flat, the facts row fell to 3.92:1 on PlayStation. Focus walk (390 light/dark, 1440, en): 0 stops under a bar, 0
sideways, 0 without a visible ring. Census (390 light, 1440 dark): sizes on the scale (12px only in tags), Kufi 700 +
Plex 400/600, radii {8, 12, 20, 28, full}, ≤3 shadow recipes, every image sized, 0 targets under 44, 0 Arabic runs
under 13px. No overflow at 320 and at 200% zoom (720px). `?all=`: without JavaScript the link opens the grid at its
section; with it, Back from a product returns to the open grid at the same scroll, and a reload keeps it. States
rendered with a temporary dev switch (removed): shelf loading (a hub → hub push shows both placeholders at once),
failure, rejected stream, offline (the retry keeps the hub). Screenshots: `…/scratchpad/ux/after/P5-devices-review/`.
Not done: Safari/Firefox/real phones; the Sorani strings (and month names) need a native reader.

## Wave G wiring (2026-11-12)

- `components/reveal.ts` is gone: the section chips use the kit's `revealInRow` / `revealFocusedItem` (`~/ui/reveal`), the
  comparison table the same with its sticky column as the row's start padding, and the recommendation rails rely on the kit's
  Rail (a keyboard-focused card goes to the rail's start).

## Head height (QA fix, 2026-11-12)

v2 §6.6 / §4.18 ask 200px on phones and 280 from 1024; the head measured 352–407 (390) and 357–385 (1440), so a phone's
first screen showed only the band and the chips. Now: the facts are ONE line (`headFacts`; the release year only on a
phone), the on-band key is the 40px one, price and key share a row from 1024, the steps are compact (12px phones; 32px
copy padding from 768). Measured (`…/scratchpad/ux/after/Q-fix-pages-product/`, Switch 2, PS5 Pro, Xbox Series X, Steam
Deck OLED): **Arabic 300–301 at 390, 280 at 1024, 281 at 1440**; English 300–324 / 280–308 / 280; Sorani 301–335 / 315 /
281. At 390 the editions now start at y 514 (was 565–620) and the first edition card shows on the first screen.
Why not 200 on phones: the device stays large (176px, rising above the band) beside a headline of two to four lines in
the column it leaves (English and Sorani «Everything about» / «هەموو شتێک دەربارەی» take two lines there), then the
facts, the price with its demo tag and the key below — about 300 is what that content takes. Reaching 200 would need a
smaller device and no facts on phones, or the lead-in («كل شيء عن») set smaller than the name: the spec owner's call
(asked). From 1024, Sorani and the PS5 Pro in English put the key under the price (a longer price line and label; +44).
