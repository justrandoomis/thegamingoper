# Home — `/`, the intro and the onboarding

Owner: home area. Design System v2 §6.1 (home, intro, onboarding), §4.18–§4.25 (the showcase kit it is built from),
§6.17 (states), §7 (imagery), §9 (copy); brief §2 "Intro" / "Onboarding", §3.1–3.2, §6 (privacy). Files:
`app/routes/storefront/home/**`, `app/i18n/messages/home.ts`, `tests/home.test.ts`. The data service
`app/server/services/home.server.ts` is read, not owned, in the v2 stage.

## Routes

| Path | File | What |
|---|---|---|
| `/` (`/en`, `/ckb`) | `home.tsx` | the page; `?platform=nintendo\|playstation\|xbox\|handheld` = the «وصل حديثاً» chip — shareable, kept by Back, no request (`shouldRevalidate` skips the loader when only `platform` changes; every platform's new arrivals are in the loader data) |
| `POST /api/onboarding` | `api.onboarding.ts` | `intro=seen`, `consent=1\|0`, `platforms=a.b` → `tt_intro` / `tt_consent` / `tt_platforms` cookies; a signed-in customer's answer is appended to `consents` (kind personalization, source `home_onboarding`); `consent=0` also forgets on the server (`personal.server.ts → forgetPersonalData`); 400 `invalid` + fields, 405, 429 |
| `GET /api/recently-viewed?ids=&locale=` | `api.recently-viewed.ts` | a guest's device list: cards for the ids this browser remembers (≤ 12, order kept), `no-store`; `?scope=account` → a signed-in, consenting customer's account list |
| `POST /api/recently-viewed` | same file | signed in + consent only: `productId` and/or `device=[{id,at}]` → `{ ok, kept, merged }`; `intent=clear` |

Unchanged in v2: `personal.ts`, `personal.server.ts` and both API files (other areas import `personal.ts`:
`readConsent`, `recordProductView`, the cookie names — keep their signatures).

## The page, top to bottom (v2 §6.1)

0. A visually hidden `<h1>` «طمطم للألعاب: أجهزة وألعاب وإكسسوارات في العراق» — the hero's headline is an h2 (it
   changes per campaign). The demo strip and the header are the shell's.
1. **Hero** (`Hero.tsx`, the kit's `Band kind="hero"`), 16px under the header. The featured console: the lead device of
   `FEATURED_PLATFORM` = Nintendo (`view.ts featuredHero`) — Nintendo Switch 2 today — until the CMS pin is wired
   (§13 #13). The admin's content module already keeps pins and offers the reads (`getHomeHero`, `getHomeLayout`,
   `getActiveBanners` in `services/admin/cms/*`, docs/areas/admin-cms.md); the storefront wires them after the redesign,
   as the admin screens say — the home does not read them yet. Phones: the platform pill · the
   headline in two lines («العب على» / «Nintendo Switch 2», the name isolated, one edge, `splitHeadline`) · the
   product in a 168px box (the page's only preload, `fetchpriority="high"`, the shared element `product-image:<id>`
   slot `hero`, a link into `/p/<slug>` with the zoom) · the price (xl, white) + «سعر تجريبي» · the on-band key
   «اشترِ Nintendo Switch 2», full width · «التوصيل 5,000 د.ع لكل المحافظات · الدفع عند الاستلام» (fee and COD from the
   settings). ≥ 768: copy 7/12 at the inline start (6/12 from 1280) + the fact line (`card.subtitle`) and «تفاصيل
   الجهاز» → the device hub named like the product (`deviceHubFor`, else the product page); the product at the inline
   end on the band's light. Measured: 436px at 390 (≤ 440), 400 at 1024, 420 at 1440.
   - **The key** opens the product area's quick look (`QuickPreview`, lazy) on the version choice; the page keeps its
     URL and scroll; a real link to the product page underneath (new tab, no script). Dark theme: the band is a lit
     cabinet and the key renders as the red primary (kit CSS).
   - **Headline size** steps down the type scale until its longest line fits the copy column (`heroTitleSizes`:
     Noto Kufi 700 widths measured in Edge, Plex 600 for Sorani; the column minimums `HERO_COPY_MIN` mirror
     `home.css` — change both together). Integer sizes from the scale only, never fluid. Short last words never break
     (`keepTogether`: «Switch 2», «5 Pro», «Go 2»).
2. **«تسوّق حسب المنصّة»** (`PlatformDoors`): the four `PlatformTile`s (2×2 → 4-up) with the real product counts and
   hubs. A tile never repeats the hero's picture (`tileArt` → `otherView`: the Nintendo tile shows Switch 2 in its
   dock); nothing else makes it step away from its own picture — the next "angle" of a device can be its back (Xbox
   Series X `--2`, Switch 2 `--3`). The intro's tiles use exactly these pictures.
3. **Trust strip** (`TrustFacts` → the kit's `TrustStrip`, under a visually hidden h2 «التوصيل والدفع»): only true
   facts — the fee from settings, COD while enabled, «زين كاش أو تحويل…» only while BOTH are enabled (the line names
   both), guest ordering (how the store works).
4. **«وصل حديثاً»** (`NewArrivals`): the kit's `SectionHead` with platform dot chips (`ChipGroup`, radiogroup, arrow
   keys) that filter the shelf in place, the reason line «أحدث ما أضفناه، والمتوفر الآن», «عرض الكل» →
   `/platform/<chip>?sort=newest`; the kit's `Rail` (2.15 cards on phones, 4/5-up whole cards from 1024) of
   `ProductCard`s. **No «جديد» inside this shelf** (v2 §4.7): the page drops the badge from these cards. A chip exists
   only for a platform with a drawn shelf (`hasShelf`: `MIN_SHELF` = 3 new arrivals); the chip starts on the URL's
   platform, else the shopper's saved one, else the featured one (`resolveFocus`) — never on a short shelf, which would
   take the whole section and the other platforms' chips with it. New cards bubble in after a chip change.
5. **«قريباً»** (`Releases` → the kit's `ReleaseBand`): the soonest four (`RELEASE_LIMIT`), only with ≥ 2 dated items;
   an unreleased version of a released product reads «Forza Horizon 6 · نسخة جديدة» (the catalogue's version titles are
   not shown — they can say «طلب مسبق»). The platform line comes from each pre-order product's own card (the loader
   reads them with `getCardsByIds`; one platform only — one colour dot beside «متعددة المنصات» would mislead).
6. **«مستعمل ومفحوص»** (`UsedShelf` → `ShelfRail` + `UsedUnitCard`), «كل المستعمل» → `/used`; hidden under 3 units.
7. **Trade-in and support doors** (`ServiceEntries`, two `EntryCard`s, h2 titles): «استبدل جهازك» (the PlayStation
   lead device's photo) and «الدعم» (the mascot).
8. **«تسوّق حسب القسم»** (`Departments`): six `CategoryTile`s with counts (the shell's `sheetCategories` minus games,
   which live under the platforms here). Pictures: the department glyph, as in the categories sheet, until the
   navigation data carries a photo (`NavCategory.artKey` is read when it exists — the column `categories.art_key` is
   filled but not exposed).
9. **Personal shelves**, consent only, from 3 items: «شاهدتها مؤخراً» (`RecentlyViewed`, the shopper's ONE list) and
   the devices area's `RecommendationShelves` (streamed).
10. **«خصّص طمطم»** (`PersonalPanel`, `#personal`): what is remembered here, change platforms (the sheet), stop and
    delete, watch the intro again.

Not on the page any more (v2 §6.1): the platform key bank and the relit stage, the games / accessories / price-drop
shelves, the coming-soon card rail, the used + repairs row panel. `getHomeData` still reads games, gear and deals; the
loader passes only what is drawn (`forPage`).

## Intro and onboarding (`Intro.tsx`, `Onboarding.tsx`)

The intro is a client-only modal overlay over the server-rendered page, only when: no `tt_intro`, the shopper landed
here (`history.state.idx === 0`), has not scrolled, and the lazily loaded `isbot` does not match. The motion grammar is
kept: the logo's layers inflate 60 ms apart and lift; the four lead devices come in at the corners (straight — no
tilt); on «ابدأ» they lean in 8 px and leave along their diagonals, the logo travels to the header's lockup
(`.shell-lockup__word`), the floor fades. v2 changes: «دورك. اختر منصّتك.» (the one game-turn line of the store); the
choices are four `PlatformTile`s as toggle buttons (`aria-pressed`; 2×2 on phones, 4 × 240px from 1024) — a chosen tile
stays down on its wall, ringed inside and checked; «تخطَّ» is a visible secondary key from the first frame; «ابدأ» is
the view's one primary. Escape / Android back = skip; focus trapped; the page inert until it leaves. Reduced motion:
the still composition and a 120 ms fade.

**Consent asked honestly:** the 1.0 consent sheet is gone. After an intro with platforms chosen (and consent never
asked), a NON-BLOCKING row under the hero asks «نحفظ اختيارك على هذا الجهاز؟» with what would be kept, and two equal
keys «احفظ» / «لا، شكراً»; it takes the focus (no ring for a pointer user) and the browser brings it into view. Nothing
is written before yes: the chosen platform only arranges this visit (the new-arrivals chip). The platforms sheet
(«منصّاتك») uses platform chips (several may be chosen) and two equal keys.

## Rules the data follows (`home.server.ts`, read-only here; `tests/home.test.ts`)

- A product is on a platform when it is made for it (`platform_id`) or a **verified or partial** compatibility rule
  ties it to one of the platform's models, generations or the platform. Shelves hold only what can be bought now.
- Hero = a platform's lead device (`device_models.sort`, base model named like the model, buyable, not discontinued,
  with a photo); a base model released in the last 120 days → «وصل …».
- Coming soon: pre-orders and unreleased variants with the researched release dates; nothing can be pre-ordered.

## Personalisation and consent (`personal.ts`) — unchanged

| Where | What | Written when |
|---|---|---|
| cookie `tt_intro` | `1` | the intro was finished or skipped |
| cookie `tt_consent` | `1` / `0` | the shopper answered (never pre-set) |
| cookie `tt_platforms` | `playstation.xbox` | only while `tt_consent=1`; deleted on `0` |
| localStorage `tt:recent` | `[{ id, at }]`, ≤ 12, 90 days | a GUEST's views, only while `tt_consent=1`; wiped on `0`; handed to the account after signing in |

Recently viewed is ONE store per shopper (guest = this device, signed in = the account; details in the 2026-11-11
integration notes of `personal.ts`).

## States (v2 §6.17)

Default · partial (no buyable console anywhere → no hero band, the rest stands; a shelf under its minimum is not drawn)
· empty catalogue (EmptyState «لا توجد منتجات معروضة الآن» + «تحدّث مع موظف» → the hand-off, the two doors, the panel) ·
loading (SSR; pictures on their LQIP; streamed shelves bubble in) · API failure (loader → the route's ErrorBoundary,
`ErrorState` stack with a retry; recently viewed → an inline `ErrorState` with a retry) · hero photo failure (the band
keeps its size, copy and key; no broken-image frame — also when the photo failed before the page was hydrated, which
React's onError never reports: `pictureFailed` checks the photo once on mount) · offline (the shell's banner; the chips still filter — the data
is on the page; card pictures show the kit's failed-image state) · demo (the shell's strip + «سعر تجريبي» beside the
hero price) · reduced motion (no bubbles, no hover lift, still intro).

## Exports others may use

`personal.ts` (cookie names, `readConsent`, `recordProductView`, `parsePlatformList`, …) and the two API routes. The
components and `view.ts` are this page's own.

## Verified (2026-11-12)

`npx vitest run tests/home.test.ts` (36 pass; 38 after the review below) · `node scripts/lint-design.mjs --strict app/routes/storefront/home`
(0) · no type errors in these files · browser flows (scratch `work/pages-P1-home/tools/flow.mjs`, `hero-flow.mjs`,
`states.mjs`): intro → choose → start → consent row → yes / no → reload → chips without a request → change → recently
viewed (3 products) → stop and delete → replay, 30/30 in ar 390, en 1440 and ckb 390 dark + reduced motion; hero key →
quick look → add, photo → product page, device hub, four tiles, «عرض الكل» 12–13/13; states 7/7 · probe: hero 436px at
390 with the key, price and delivery line above the tab bar, first tile row at y 639; at 1440 the hero (420) and the four
tiles inside 900px (bottom 885) · census (sizes on the scale, Kufi 700 + Plex 400/600 only, radii in the set, 2–3 shadow
recipes, no image filter, no target under 44px, no Arabic run under 13px, 0 contrast fails except below) · focus walk
(0 stops under a bar at 390/768/1440) · screenshots `…/scratchpad/ux/after/P1-home/`.

**Known gaps:** red share of the first screen 40.2% at 390 and 36.7% at 1440 (targets ≤ 40 / ≤ 35; A measured 46 / 39),
whole page 6.8–7.5% (target 8–12: the page is longer than A's) — the band (≈ 31%) and the Nintendo tile (≈ 10% at 390)
fill the first screen at the spec's own sizes, so the targets conflict with the hero geometry; at 768–1023 the
PlayStation tile's name «PlayStation» lies on the tall white PS5 Slim cut-out (kit layout: hardware 58% wide, no
text limit below 1024; p10 contrast 1.48 — in the intro too); a focused card in a phone rail stays partly off-screen
(kit / motion rail: Chrome does not scroll a link with 28px visible); departments show glyphs (no category picture in
the navigation data); Sorani copy unreviewed (the hero puts the verb first, «یاری بکە لەسەر …»); Chromium (Edge) only.

## Review (2026-11-12)

Found in the browser and fixed: (1) a hero photo that fails before hydration showed the blurred placeholder in a
broken-image frame (onError never fires before hydration) — `pictureFailed` on mount; (2) the intro's Xbox tile showed
the back of the console with its ports (the tile stepped away from the corner's picture to the next "angle") — the
intro's tiles now use the page tiles' pictures (`tileArt`); (3) the bottom of the page doubled the section gap above
the footer (144px at 1440: the page's own bottom padding + the shell footer's margin) — the page keeps only its top
16px; (4) a platform with 1–2 new arrivals could become the chip the shelf starts on, and the shelf and every chip
vanished — chips and focus now need `MIN_SHELF` items. Tests: `tests/home.test.ts` 38 (resolveFocus fixture moved to
real shelf sizes on purpose; new: short shelves never focused, `pictureFailed`, `tileArt` never a console's back).
Screens and scripts: `…/scratchpad/ux/after/P1-home-review/`, `…/scratchpad/work/pages-P1-home-review/tools/`.

## The content module on the page (wave G wiring, 2026-11-12; `tests/storefront-wiring.test.ts`)

- **Pinned hero** (admin 17.01, `getHomeHero`): `getHomeData` keeps a live, non-demo pin only while its product can be bought and
  has a photo (`pinnedHero`, the automatic pick's own test) — else the platform's automatic hero, as if nothing were pinned.
  `featuredHero` prefers a pin (the featured platform's, else the first pinned one). The band then shows the staff's headline
  (h2; the pin's language, Arabic when it has none in the page's — lang/dir set), the product's **name under it on every
  width** (the headline no longer names it) and the deck from 768. «تفاصيل الجهاز» reads «تفاصيل المنتج» when the product has
  no device hub. A pin takes the STAGE only: `HomePlatform.lead` keeps the platform's own lead device (the automatic pick), and
  the page's other pictures of a platform's console — the trade-in door's PlayStation, the intro's corner objects — use it
  (`view.ts leadArt`); review 2026-11-12: a pinned game had become the «استبدل جهازك» picture.
- **The key:** a product with versions opens the quick look (as before); one with a single version is the kit's on-band add key
  (`AddToCartKey look="onBand"`: the flight, «تراجع», flat with its reason offline). A name longer than 24 characters keeps the
  kit's own words («أضف إلى السلة» / «اختر نسخة») instead of a cut «اشترِ …».
- **Sections** (`getHomeLayout` → `home.layout`, `homeLayoutOf`): the page's own order (`HOME_PAGE_SECTIONS`: platforms, new
  arrivals, coming soon, used, the trade-in and support doors = `used_repairs`, departments = `accessories`, recently viewed,
  recommendations, personal) until staff save an arrangement; the module's untouched default list reads as "not arranged".
  "games" and "deals" have no section here. The trust strip follows the platform tiles when they lead, else the hero.
- **Banners** (`home_strip`, `getStoreBanners`) under the trust strip (`content/components/StoreBanners.tsx`): never demo, never a
  link the store cannot open; a failed read leaves the page without them.
- **Kit requests applied:** the intro's tiles are the kit's `PlatformTile selected` (the page's own toggle CSS removed);
  `TrustStrip transfer={{ zaincash, card }}` (one fact naming the methods that are on).
- "/old-name" (one segment, no language) is this route under an invalid locale: a redirect staff set is followed
  (`redirectIfMoved`), and the page's data is never read for it.
