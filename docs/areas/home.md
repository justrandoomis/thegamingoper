# Home — `/`, the intro and the onboarding

Owner: home area. Brief §2 "Intro" / "Onboarding", §3.1–3.2, §6 (privacy), §12; DESIGN.md §2, §7.2 intro, §7.3, §8.1,
§8.9, §8.11. Files: `app/routes/storefront/home/**`, `app/server/services/home.server.ts`, `app/i18n/messages/home.ts`,
`tests/home.test.ts`.

## Routes

| Path | File | What |
|---|---|---|
| `/` (`/en`, `/ckb`) | `home.tsx` | the page; `?platform=nintendo\|playstation\|xbox\|handheld` lights the stage for one platform — shareable, kept by Back, no request (`shouldRevalidate` skips the loader when only `platform` changes; every platform's hero and shelves are in the loader data, ~45 KB for 61 cards) |
| `POST /api/onboarding` | `api.onboarding.ts` | `intro=seen`, `consent=1\|0`, `platforms=a.b` → `tt_intro` / `tt_consent` / `tt_platforms` cookies; a signed-in customer's answer is appended to `consents` (kind personalization, source `home_onboarding`); 400 `invalid` + fields, 405, 429 |
| `GET /api/recently-viewed?ids=&locale=` | `api.recently-viewed.ts` | cards for the ids this browser remembers (≤ 12, order kept, unknown/unpublished left out), `no-store`; 400 for more ids or malformed ones |

## The page, top to bottom

1. **Hero** (`Hero.tsx`): an Arabic verb + the product's own name ("العب على Nintendo Switch 2"), sized to stay on one
   line in its column (`--em` = measured Kufam widths, `view.ts`; floors 22/26/34 px, then a balanced wrap); the lit
   stage with the official photo — a link into `/p/<slug>` (shared element `product-image:<id>`, slot `hero`; the LCP
   image, preloaded); the glass tag and the commit key on the rim (the key drops under the tag when a seven-digit price
   leaves no room; ≥ 768 the copy column holds deck, "تفاصيل الجهاز", the commit key and the delivery fact); the four
   platform keys (the other platform's photo is preloaded on pointer-down). Products with options get the kit's
   "اختر الخيارات" link instead of an add.
2. **New arrivals** of the platform in focus (grid 2 → 3 → 6, "كل PlayStation" → `/platform/<slug>`), inflating in
   when another platform is lit.
3. **Used + repairs**: the two-row flat panel of §8.1 with the real count of listed used units.
4. **Games for the platform**, **Price drops**, **Used and inspected**, **Accessories** (the shopper's platforms in
   turns when they chose several, else the platform in focus) — `ShelfRail`, each with its written rule.
5. **Coming soon**: 4 pre-orders and the unreleased variants (grouped per product and day: "3 نسخ جديدة") with the
   release date from the research; no add key.
6. **Shop by platform**: category cards (1:1 niche, lead photo, LED + name, real product count) → `/platform/<slug>`.
7. **Recently viewed**: only with consent, from this device, loaded after the page is on screen, "امسح القائمة".
8. *Recommendation shelves slot* (empty until the integration pass).
9. **Make TamTam yours** (`#personal`): what is remembered here, change platforms, stop and delete, watch the intro again.

## Rules the data follows (`home.server.ts`; `tests/home.test.ts`, 30 tests)

- A product is on a platform when it is made for it (`platform_id`) or — multi-platform products have no
  `platform_id` — when a **verified or partial** compatibility rule ties it to one of the platform's device models,
  generations or the platform. Unverified and incompatible rules never do (tested by moving one product on and off the
  Xbox shelves as its rule changes). This is why the page does not use `getNewArrivals` (platform_id only).
- Shelves hold only what can be bought now (`in_stock` / `low_stock` from the card read layer), newest in the store
  first (`published_at`); games and accessories never repeat the new arrivals.
- Hero = the platform's **lead device**: the first device model in the store's order (`device_models.sort`) whose base
  product (named like the model, not a bundle) can be bought and is not marked discontinued → "العب على {name}"; a base
  model released in the last 120 days → "وصل {name}" with its release date. No buyable console → an unlit stage that
  says so and links to the hub.
- Deals = `getDeals` (genuine previous prices only, 7 in the demo). Used = `getUsedSpotlight`. Nothing is called
  "trending" or "customers also bought": there are no order, view or review aggregates.
- One `db.batch` (membership + ranking, console candidates, coming soon), then cards (≤ 100 ids per statement), deals
  and used in parallel: ~37 ms on the local D1.

## Personalisation and consent (`personal.ts`)

| Where | What | Written when |
|---|---|---|
| cookie `tt_intro` | `1` | the intro was finished or skipped |
| cookie `tt_consent` | `1` / `0` | the shopper answered (never pre-set) |
| cookie `tt_platforms` | `playstation.xbox` | only while `tt_consent=1`; deleted on `0` |
| localStorage `tt:recent` | `[{ id, at }]`, ≤ 12, 90 days | only while `tt_consent=1`; wiped on `0` |

The intro asks nothing: platforms picked there light **this visit**. If nothing was ever asked, a sheet then asks
"نتذكّر منصّاتك؟" with two equal keys; declining or dismissing keeps nothing. Guests' answers stay on the device. On the
client read consent with `readConsent()` (root `personalizationConsent` refreshes only on a document load or a POST).

## The intro (`Intro.tsx`)

A client-only modal overlay over the server-rendered page, only when: no `tt_intro`, the shopper landed on this page
(`history.state.idx === 0`), has not scrolled, and the lazily loaded `isbot` does not match. Sequence and exit per
DESIGN §7.2 (logo layers inflate 60 ms apart with 6 px parallax and lift; four platform lights with their lead device in
the corners 80 ms apart; the line, the toggling keys, "ابدأ" last; a tap jumps to the end). Start/Skip: state first,
then the corners lean in 8 px and are pulled out along their diagonals (no fade), the logo travels to the header's, the
floor fades over the already relit page. Reduced motion: still composition, 120 ms fade. Lite: no staggered inflate.
Escape / Android back = Skip; focus trapped; page inert until it leaves.

## States (brief §12)

Default · partial (a platform without a buyable console: unlit stage + hub link; empty shelves are not drawn) · empty
catalogue (empty state with "تواصل معنا", the used/repairs panel, the personal panel) · API failure (loader → the
route's ErrorBoundary inside the shell with a retry; recently viewed → inline ErrorState with a retry) · offline (shell
banner; lighting a platform needs no network; adds roll back honestly) · success (toasts for answers) · validation
("اختر منصّة واحدة على الأقل") · reduced motion · pending review / unauthorized: not applicable here.

## Demo, real, boundaries

- **Real:** products, names, photos, release dates, compatibility, used grades, counts. **Demo:** prices, previous
  prices, stock (the shell's ribbon).
- **Pre-orders cannot be ordered** (no pre-order flow in the commerce core): cards say "يصدر في …", no add key.
- **The hero is not staff-selectable yet** (admin module 17 not built): when it is, read a `banners` row
  (placement `home_hero`, accent = platform, link `/p/<slug>`) before the automatic rule in `pickHero`.

## Integration slots

- `RecommendationShelves` (`Shelves.tsx`) + loader `recommendations: []` → devices' `getRecommendations(db, { locale,
  context: "home", platformSlugs: prefs.platforms, consent: prefs.consent === true, … })`.
- **Recently viewed has two stores today:** this device's list (`personal.ts`, `rememberViewed(product.id)` for the
  product page) and the account area's server table (`account/recently-viewed.server.ts`). Pick one in the integration
  pass (e.g. the product page records server-side, the home loader reads `listRecentlyViewed` and this endpoint goes);
  "stop remembering" here should then also clear the server copy.
- Device hub links from the hero are left out until `/device/*` exists; a "replay the intro" entry in account settings
  or Preferences can link to `/#personal`.

## Verified / not verified

`npx vitest run tests/home.test.ts` (30 pass) · no type errors in these files (`npx tsc -b`; the project typecheck is
red from other areas' in-progress files) · `node scripts/lint-design.mjs app/routes/storefront/home` (0) · browser flow
(scratch `flow.mjs`, 20 checks: intro → keys → Start → consent → reload remembered → bank without a request → recently
viewed → stop and delete) passed in ar 390, en 1440, ckb 390 dark + reduced motion, console clean · screenshots in
`.shots/home/` (360, 390, 768, 1440; light/dark; ar/en/ckb; intro frames; sheets; panel). Chromium only; no phone,
Safari or Firefox; Core Web Vitals not measured. Sorani needs a native reader; Sorani dates show English month names
(the shared formatter has no `ckb` month data).
