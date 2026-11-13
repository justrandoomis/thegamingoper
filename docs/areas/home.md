# Home — `/`, the intro and the onboarding

Owner: home area. Design System v2 §6.1 (home, intro, onboarding), §4.18–§4.25 (the showcase kit it is built from),
§6.17 (states), §7 (imagery), §9 (copy); brief §2 "Intro" / "Onboarding", §3.1–3.2, §6 (privacy); **v2.1 «Clay &
Glass» (client feedback round 1, notes 1–3: the hero carousel, the compact phone banner, glass in dark — DESIGN.md
§15)**. Files: `app/routes/storefront/home/**`, `app/i18n/messages/home.ts`, `tests/home.test.ts`. The data service
`app/server/services/home.server.ts` is read, not owned.

## Routes

| Path | File | What |
|---|---|---|
| `/` (`/en`, `/ckb`) | `home.tsx` | the page; `?platform=nintendo\|playstation\|xbox\|handheld` = the «وصل حديثاً» chip — shareable, kept by Back, no request (`shouldRevalidate` skips the loader when only `platform` changes; every platform's new arrivals are in the loader data) |
| `POST /api/onboarding` | `api.onboarding.ts` | `intro=seen`, `consent=1\|0`, `platforms=a.b` → `tt_intro` / `tt_consent` / `tt_platforms` cookies; a signed-in customer's answer is appended to `consents` (kind personalization, source `home_onboarding`); `consent=0` also forgets on the server (`personal.server.ts → forgetPersonalData`); 400 `invalid` + fields, 405, 429 |
| `GET /api/recently-viewed?ids=&locale=` | `api.recently-viewed.ts` | a guest's device list: cards for the ids this browser remembers (≤ 12, order kept), `no-store`; `?scope=account` → a signed-in, consenting customer's account list |
| `POST /api/recently-viewed` | same file | signed in + consent only: `productId` and/or `device=[{id,at}]` → `{ ok, kept, merged }`; `intent=clear` |

Unchanged in v2 and v2.1: `personal.ts`, `personal.server.ts` and both API files (other areas import `personal.ts`:
`readConsent`, `recordProductView`, the cookie names — keep their signatures).

## The page, top to bottom (v2 §6.1, v2.1)

0. A visually hidden `<h1>` «طمطم للألعاب: أجهزة وألعاب وإكسسوارات في العراق» — the banners' headlines are h2s (they
   change per campaign). The demo strip and the header are the shell's.
1. **The hero carousel** (`Hero.tsx` `HeroCarousel`, client note 1), 16px under the header — a region «عرض شرائح» named
   «أبرز ما في المتجر», built on the kit's `useCarousel` (a native scroll-snap track: swiping works before and without
   JavaScript) with the page's own banners. **Banners** (`view.ts heroSlides`): every platform's hero —
   `home.platforms[*].hero`, a staff pin or the lead device — in the key bank's order with the FEATURED one first
   (`featuredHero`: Nintendo, or while staff pin one, the pinned platform — what staff chose for this period leads, as
   the single hero did), then **«استبدل جهازك»** (→ `/trade-in`; «سعر تقديري الآن، والسعر النهائي بعد فحصه في المتجر.»
   from 768, the key «قدّر سعر جهازك») and, while used units are listed, **«مستعمل ومفحوص»** (→ `/used`). The two
   service banners show a console no platform banner shows, an upright one first (a wide picture stands small in the
   product column): the trade-in banner the first such picture among the listed used units and the PlayStation lead
   device (the trade-in door's), the used banner the next one (demo data: PS5 Slim, Xbox Series S); with no picture,
   the banner's icon in a clay disc. Six banners in the demo: Nintendo Switch 2, PlayStation 5 Pro, Xbox Series X,
   Steam Deck OLED, trade-in, used.
   - **The banner** — the kit's showcase band `Band kind="platform"` in the platform's colour (the trade-in banner
     `data-gel="brand"`, crimson; the used banner graphite, the page's `--band`, `data-tone="graphite"`), richer for the
     hero (`.home-slide__gloss`): a lighter tint of the colour behind the product, two soft ribbons of light across the
     product's side (the reference's sheen), a deeper corner and the words' side a shade deeper (white words ≥ 4.6:1 on
     the lightest 2% of the pixels behind them, every banner, light and dark, 360–1440; from 768 to 1279 the copy column
     is wider, so the ribbons sit nearer the product and the deeper side reaches past the words — `--ribbon-at`,
     `--deep-reach`), the kit's specular top band and rim; the product on a glossy floor (a pale ellipse with
     the contact shadow in the colour's deep shade) with a parallax as the banners move (the words fade with the move
     and drift slower than the banner, the product faster — written from the track's scroll, fix-browse below); the ambient light of the banner in view on the floor behind it (`.glow-layer` per banner, crossfading
     on opacity; it fades out inside its own box, which reaches a third of the banner below it — no hard line under the
     dots). Dark (client note 3): the kit's deep platform-colour glass (58% of the colour on the cabinet, a rim
     light brighter on top) over that light. The white clay key says its words in the colour's deep shade
     (`--on-band-label: var(--plat-deep)`, ≥ 7.6:1).
   - **From 768**: the platform pill · the headline in Kufam, two lines at most («العب على» / «Nintendo Switch 2», the
     name isolated, `splitHeadline`; a staff pin's headline instead, the product's name and the deck under it) · the
     facts line (`card.subtitle`, two lines at most) · the price (xl) + «سعر تجريبي» · the white clay key «اشترِ
     Nintendo Switch 2» and «تفاصيل الجهاز» → the device hub (`deviceHubFor`, else «تفاصيل المنتج» → the product page)
     at the inline start (3/5 to 1023, 7/12 from 1024, 1/2 from 1280); the product at the inline end. 370px at 768, 400
     from 1024. The delivery fee is NOT repeated (client note 6: the header's strip says it from 1024).
   - **Phones (client note 2, brief §2.2)**: a compact WIDE banner, 88% of the column so the next one peeks — its
     colour and product only: once the page is live a banner that is not in view hides its words, which fade in as it
     arrives. The name (two lines at most: «Nintendo» / «Switch 2», `keepLastWord`; the words around it are read, not
     shown) and the price (22px) at the start, the product at the end across the banner's height, «اشترِ الآن» along
     the bottom (a service banner: its title and key, its picture above the key). **The shape is ONE custom property,
     `--hero-phone-ratio` (home.css, 315 / 220)**: 220px tall at 390, 202 at 360 — the first row of platform tiles
     ends at 740 at 390 × 844 (tab bar 770). The height follows the width, so it is capped at 60% of the screen's
     height (never a cap under 240px; the banner keeps its full width): a phone on its side (740 × 360) or a desktop at
     200% zoom (720 wide) gets a 240–270px banner, not a 420px one with its key under the tab bar; portrait phones keep
     the ratio. No pill, facts line or second link on phones.
   - **Controls** (the bar under the banner): the kit's dots (the current one fills with the time left while autoplay
     runs — `data-run`, the page's progress layer on the kit's dot), the pause / play key and, from 768, the round clay
     arrows. **Autoplay** every 6.5 s (`HERO_AUTOPLAY_MS`), held while the pointer is over the hero, focus is inside it,
     a finger is on it, the tab is hidden or it is off screen; stopped by a swipe, an arrow, a dot or a key; ← → in the
     reading direction, Home, End. Reduced motion (OS or the store's switch): no autoplay, no pause key, instant moves,
     no parallax, no rise. What holds autoplay is mirrored from the same events with the kit's `carouselHold` /
     `autoplayWaits` (the hook does not expose it — asked of the kit).
   - **Accessibility**: each banner a group «1 من 6»; only the banner in view is interactive once the page is live
     (`inert` on the others — one banner's keys in the tab order; screen readers meet the banner that is shown); the
     track is a polite live region only once the shopper has taken over (the kit). **Loading**: every banner is
     server-rendered; only the first photo is eager (`fetchpriority="high"`, the page's LCP), the others lazy in the
     markup; once the page has loaded, the NEXT banner's photo is fetched while one is shown (`view.ts photoToWarm`;
     none on Save-Data) — a lazy photo in the sideways track waits until it scrolls in, so every banner used to arrive
     as a blurred miniature with its product popping in; the banner's size is the stylesheet's (CLS measured 0 / 0.0002).
   - **The key**: a product with versions opens the product area's quick look on the version choice (the page keeps its
     URL and scroll; a real link to the product page underneath); one version is added at once by the kit's on-band add
     key — offline it goes flat and its reason is said on the band in the band's ink (`message="none"` + the page's
     line), not in the page's grey. The photo opens the product page with the card → page zoom (`<SharedElement
     name="product-image:<id>" slot="hero">`). A photo that fails leaves its box empty (`pictureFailed` on mount).
   - **Headline size** (`view.ts heroTitleSizes`): the largest step of its RANGE's own Kufam sizes at which it fits the
     copy column — phones 22 → 18 (the name may take two lines: `twoLineEm`, its best break; a no-break space never
     breaks), 40 → 32 → 30 → 24 at 768, 48 → 34 → 32 → 26 at 1024, 56 → 36 → 28 from 1280; a staff pin's headline and a
     service title may take two lines everywhere. Widths: **Kufam Variable 600 measured in Edge** (2026-11-12; Latin
     letters, digits, punctuation; the page's OWN Arabic and Sorani headline words exactly — a line is the sum of its
     words — and 0.87 em per letter for a staff's unknown words); Sorani is Kufam too now, and «یاری بکە لەسەر /
     Steam Deck OLED» keeps 40 / 48 / 56 like Arabic and English. `HERO_COPY_MIN` (136 / 388 / 494 / 544) mirrors
     home.css — change both together.
   - **Plex's bowl ligature**: the banners' Plex lines (facts, deck) pass through `plainFinalYeh` («حتى» never «حق»).
1b. **The icon strip** (`Shelves.tsx CategoryStrip`, client note 4 — the reference's glass icon tiles), right under the
   hero in one group with it: the shell's `IconTile` (the categories sheet's own tile: a raised card / faux glass in
   dark with the kind's red line icon) for **consoles, games, controllers, headsets, accessories, gift cards, used,
   repair** — only departments that exist (`view.ts stripItems`: a catalogue category of that kind with products → its
   own listing; used while units are listed; the repair booking always), in the catalogue's words shortened where long
   («بطاقات الشحن»). One scrolling row below 1024 (96px tiles, 104 from 768: the longest one-word names fit; a tile
   that takes the keyboard focus scrolls fully into the row — the kit's `revealFocusedItem`); from 1024 one row of
   48px clay pills, the kind icon beside the name, with «تسوّق حسب المنصّة» 32px under it (lead decision 2: the top of
   the platform tiles on a 1440 × 900 first screen). Dark: glass tiles with the banner's colour spilling under them.
2. **«تسوّق حسب المنصّة»** (`PlatformDoors`): the four `PlatformTile`s (2×2 → 4-up; the kit's vivid glossy tiles in both
   themes) with the real product counts and hubs, on the brand's ambient light (`.glow glow--wide`, sized by the page so
   it fades out inside its box — the kit's wide light left a hard line under the tiles in dark). A tile never
   repeats the FIRST banner's picture (`tileArt` → `otherView`: the Nintendo tile shows Switch 2 in its dock); nothing
   else makes it step away from its own picture — the next "angle" of a device can be its back (Xbox Series X `--2`,
   Switch 2 `--3`). The intro's tiles use exactly these pictures.
3. **Trust strip** (`TrustFacts` → the kit's `TrustStrip`, under a visually hidden h2 «التوصيل والدفع»): only true
   facts — the fee from settings, COD while enabled, «زين كاش أو تحويل…» only while BOTH are enabled (the line names
   both), guest ordering (how the store works).
4. **«وصل حديثاً»** (`NewArrivals`): the kit's `SectionHead` with platform dot chips (`ChipGroup`, radiogroup, arrow
   keys) that filter the shelf in place, the reason line «أحدث ما أضفناه، والمتوفر الآن», the clay «عرض الكل» key
   (`ViewAll`, v2.1: a section head that leads to a listing carries a clay key) → `/platform/<chip>?sort=newest`; the
   kit's `Rail` (2.15 cards on phones, 4/5-up whole cards from 1024) of
   `ProductCard`s. **No «جديد» inside this shelf** (v2 §4.7): the page drops the badge from these cards. A chip exists
   only for a platform with a drawn shelf (`hasShelf`: `MIN_SHELF` = 3 new arrivals); the chip starts on the URL's
   platform, else the shopper's saved one, else the featured one (`resolveFocus`) — never on a short shelf, which would
   take the whole section and the other platforms' chips with it. New cards bubble in after a chip change.
5. **«قريباً»** (`Releases` → the kit's `ReleaseBand`, items from `view.ts releaseItemOf`): the soonest four
   (`RELEASE_LIMIT`), only with ≥ 2 dated items. EVERY item has its platform line (v2 §4.21; QA 2026-11-12: dated
   versions had none), from the facts the coming items carry (`home.server.ts`, no second card read): one platform → its
   dot and the card's words («جهاز Xbox Series X|S», «سماعة · PS5»); several → both dots and the platforms named
   («PlayStation · Xbox» for Grand Theft Auto VI — never one colour beside «لعبة متعددة المنصات»); a later version of a
   product that is out already → the platform that version is for («لعبة PlayStation» for the PS5 version of Forza
   Horizon 6) and «نسخة جديدة» on the line under its name (the catalogue's version titles are not shown — they can say
   «طلب مسبق»).
6. **«مستعمل ومفحوص»** (`UsedShelf`: the kit's `SectionHead` + `Rail` of `UsedUnitCard`s), the clay «عرض الكل» →
   `/used` (the short words every head uses: «كل المستعمل» pushed the key under the heading on a 360 phone); hidden
   under 3 units.
7. **Trade-in and support doors** (`ServiceEntries`, two `EntryCard`s, h2 titles, arriving one after the other):
   «استبدل جهازك» (the PlayStation lead device's photo) and «الدعم» (the mascot).
8. **«تسوّق حسب القسم»** (`Departments`): six `CategoryTile`s with counts (the shell's `sheetCategories` minus games,
   which live under the platforms here), with the photo staff set on the category (`NavCategory.artKey`, now in the
   navigation data), else the kind's icon tile (`CategoryTile icon`).
   Every section below the first screen fades up as it arrives (`revealProps()`; the doors staggered) — nothing above the
   fold moves, nothing hides before JavaScript, none under reduced motion or automation.
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
the still composition and a 120 ms fade. Once it has left, the focus is never on `<body>` (QA 2026-11-12): it goes back
to the key that opened it («شاهد المقدّمة مرة أخرى» — the intro remembers it, because React's commit puts the focus
back on the leaving overlay after the kit's modal layer returned it), else (a first landing) to the shell's
`<main id="main" tabindex="-1">` (no ring), so the next Tab is the hero's product link; after «ابدأ» the consent row
takes it (`landFocus`, `view.ts focusAfterIntro`).

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

## States (v2 §6.17, v2.1)

Default · partial (no buyable console anywhere → no platform banner; the trade-in banner (and the used one while units
are listed) still lead the page; a shelf under its minimum is not drawn) · empty catalogue (EmptyState «لا توجد منتجات
معروضة الآن» + «تحدّث مع موظف» → the hand-off, the two doors, the panel) · loading (SSR, every banner rendered; pictures
on their LQIP; streamed shelves bubble in) · API failure (loader → the route's ErrorBoundary, `ErrorState` stack with
a retry; recently viewed → an inline `ErrorState` with a retry) · banner photo failure (the banner keeps its size,
words and key; no broken-image frame — also when the photo failed before the page was hydrated, which React's onError
never reports: `pictureFailed` checks the photo once on mount) · offline (the shell's banner; a one-version banner's key goes
flat with «لا يوجد اتصال. أضف إلى السلة عند عودة الاتصال.» on the band in its own ink — from 768; on phones the shell's
banner says it and the key points at the sentence; the chips still filter — the data is on the page) · demo (the
shell's strip + «سعر تجريبي» beside every banner's price) · sold out / coming soon (never a banner: a hero is buyable
now — `pickHero`, a pin only while buyable) · reduced motion (no autoplay or pause key, instant banner moves, no
parallax, no dot fill, no section reveal, no bubbles, no hover lift, still intro).

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

**Known gaps:** red share of the whole page 6.9–7.3% light (target 8–12) — the first screen meets its caps since the QA
fixes (39.4% ar / 38.9% en at 390, 34.6% at 1440; caps 40 / 35), but the hero band holds 84% of the page's red
(6.1 of 7.3 points at 1440; the Nintendo tile 0.6, everything else crumbs) and nothing lower on the page is red by the
spec or allowed red by the design lint — asked of the design owner; at 768–1023 the
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

## QA fixes (2026-11-12, after the five-auditor matrix)

| Defect | Fix | Measured after |
|---|---|---|
| Hero headline 36px at 768–1023 (off that range's scale) | `HEADLINE_STEPS` per range; copy column 3/5 with a 16px gap at 768–1023 (`HERO_COPY_MIN.md` 388) | 40px at 768 in ar/en/ckb; the auditors' measure: no off-scale size on home at 768 |
| First-screen red share 36.7% at 1440, 40.2–40.9% at 390 | 404px band from 1280 (padding 24, the product 8px further into it); phones: no 4px margins above the product and the price; one-line delivery fact | 34.6% at 1440 (ar, en), 39.4% ar / 38.9% en at 390 (fullshare method) |
| Hero 450/456px in en/ckb at 390; tile counts under the tab bar (ckb 390, ar 360) | `hero.delivery` («Delivery 5,000 IQD · Cash on delivery», one line); the tighter phone hero | hero 428 / 423 / 428 at 390, first tile row 631 / 624 / 631; ar 360: counts end at 766 (tab bar 770) |
| Release items without a platform line (GTA VI, Forza Horizon 6) | `releasePlatformOf` names several platforms; `releaseItemOf` for every item, versions included | GTA VI «PlayStation · Xbox» (two dots), Forza «لعبة PlayStation» + «نسخة جديدة» under the name, in ar/en/ckb |
| Focus on `<body>` after Escape / «تخطَّ» | `landFocus` → the opener, else `<main>` | Escape and Skip → `MAIN#main` (no ring), next Tab → the hero's link; replay → back to its key; Start → the consent row (390 ar, 768 ckb, 1440 en reduced) |
| «حق 4K على التلفاز» | not a typo (the data says «حتى»): Plex's rlig ligature; `plainFinalYeh` on the hero's lines | «حتى 4K» drawn at 768–1440; ckb «کاتی» no longer «کاق» |

Not fixed here: the whole-page red share (6.9–7.3%, see Known gaps). Tests: `tests/home.test.ts` 43 (new: per-range
headline scale, release lines for versions and multi-platform items, focus after the intro, `plainFinalYeh`). Tools and
screens: `…/scratchpad/work/Q-fix-pages-browse/` (home-measure, red-regions, red-try, intro-focus, release-shot, liga*)
and `…/scratchpad/ux/after/Q-fix-pages-browse/`.

## Client feedback round 1 — v2.1 «Clay & Glass» (2026-11-12, wave B)

The client preferred v2's home (notes 1–3) and asked for: several banners that switch with smooth motion and a better
banner (desktop), a compact wide banner instead of the tall stacked card (phones), and glass that looks like glass in
dark. Built (sections 1, 1b, 2 above):

| Note | What changed |
|---|---|
| 1 (desktop) | `HeroCarousel`: six banners (every platform's hero, the featured one first; trade-in; used) on the kit's carousel hook; a richer glossy ground (tint, ribbons, deeper word side, floor, parallax, ambient light of the banner in view); controls under it (dots with the time-left fill, pause / play, clay arrows); no delivery line (the header's strip says it) |
| 2 (phone) | a compact wide banner, `--hero-phone-ratio` (315 / 220: 220px at 390), the next one peeking (its words hidden until it arrives), the name and the price at the start, the product at the end, «اشترِ الآن»; the platform tiles' first row on the first screen |
| 3 (dark) | deep platform-colour glass banners over their ambient light; the kit's vivid tiles on the brand's light; faux-glass cards (kit) on transparent sections |
| 4 (task) | the icon strip of departments under the hero; clay «عرض الكل» keys; sections fade up as they arrive |

**Tests** (`tests/home.test.ts`, 46): changed on purpose — the headline-width test now pins **Kufam 600** widths (Noto
Kufi is retired; measured in Edge 2026-11-12) and the page's own Arabic/Sorani words within 6%; the size test uses the
new phone steps (22 → 18, the name on two lines) and Kufam for Sorani (it no longer steps down). New: `twoLineEm` and
`keepLastWord`, the banners' order and pictures (`heroSlides`: featured / pinned first, trade-in always, used only
with units, upright pictures not shown elsewhere), the strip's doors (`stripItems`).

**Verified** (scripts under `…/scratchpad/fb1/work/home/tools/`, screenshots `…/fb1/shots/home/`): typecheck 0; strict
design lint 0; carousel probe 25/25 (`carousel-probe.mjs`: semantics, first image eager + fetchpriority high, inert,
autoplay after 6.5 s, hover hold, resume, pause key + polite live region, ← / End / Home across several banners,
autoplay wrap from the last to the first, arrows, a phone swipe stops autoplay, reduced motion); home flows 30/30 in ar
390, en 1440 and ckb 390 dark reduced (`flow.mjs`: intro, consent yes / no, reload, chips without a request, change,
recently viewed — none at two products (≥ 3, v2 §6.1), shown at three — stop and delete, replay); banner keys and doors
22/22 at 1440, 390 and ckb 390 (`hero-flow.mjs`: the quick look + add + focus back, the one-version add, the photo, the
device hub, trade-in and used keys, eight strip doors, the tiles, the clay keys); a key pressed on a banner link moves
the focus to the track (`keyfocus.mjs`); reveal: 6 sections held below the fold, all arrived (`reveal-probe.mjs`);
rendered contrast of every banner's words ≥ 4.61:1 (`contrast-probe.mjs`, light and dark at 390 and 1440; dark facts
were 3.5:1 in `--on-showcase-2`, now `--on-showcase`); CLS 0 (390) / 0.0001 (1440, the demo tag at the font swap);
no overflow, one h1, ≤ 2 headline lines, clean console at 360, 390, 768, 1024, 1440 × light / dark (ar) and 390 / 1440
in en and ckb (`shots.mjs`); offline: the add key flat with its reason on the band. Opaque photos on the page (the kit's
plate in dark): Nintendo Switch Lite (used shelf), the gift-card department tile.

**Requests to other owners** (the page works around each meanwhile):
- kit (Carousel): `scroll-snap-stop: always` stops every smooth programmatic move at the next snap point in Chromium —
  a dot two away, Home / End and autoplay's wrap moved one slide (also on /design-system); the hero sets `normal`.
- kit (Carousel): expose whether autoplay is running (`CarouselApi.running`) and a progress look for the current dot
  (`CarouselDots progress` + `--carousel-interval`); the hero mirrors `carouselHold` and draws the fill itself.
- kit (Rail, PlatformTiles, CategoryTiles): pass `data-reveal` (a `reveal` prop) so a page can stagger their items.
- kit (Key `onBand`): inside `[data-gel]` say the words in `--plat-deep` (the crimson label read oddly on blue / green);
  the hero sets `--on-band-label` on its banners.

### Review (2026-11-13, wave B)

Found with my own probes and screenshots (`…/scratchpad/fb1/work/home-review/`, shots `…/fb1/shots/home-review/`), all
fixed:
1. **Banners arrived without their product.** Every photo but the first is lazy, and a lazy photo inside the sideways
   track waits until it scrolls in: 3 s after load, banners 2–6 were not loaded; a frame mid-move showed an empty blue
   PlayStation banner, then the blurred miniature, then the photo. Now the next banner's photo is fetched once the page
   has loaded and after each move (`view.ts photoToWarm`, `Hero.tsx`; none on Save-Data; the markup still has one eager
   photo — a server-render test guards it).
2. **Contrast at 768–1279 (light):** the ribbons and the tint crossed the end of the facts line and «تفاصيل الجهاز» —
   3.67:1 on the lightest 2% of the pixels behind them (PlayStation, Xbox; ar, en, ckb). The ribbons sit nearer the
   product there and the words' deeper side reaches past the copy (`--ribbon-at`, `--deep-reach`): ≥ 4.6:1 everywhere.
3. **Keys pressed in the quick look moved the banners behind it.** React bubbles a portal's events through the hero
   `<section>`, so ← → Home End on its close or add key ran the carousel's keyboard handler; closing it then dropped the
   focus to `<body>` (its opener's banner had turned inert). The hero now handles only keys pressed inside its own
   markup; the banners still hold while the quick look is open.
4. **The phone banner grew with the width:** 435px tall on a phone on its side (740 × 360) and 423 at a desktop's 200%
   zoom (720 wide), its key under the tab bar. Capped at 60% of the screen's height (never a cap under 240px), the
   banner keeping its full width; portrait phones unchanged (220px at 390).
5. **Hard lines in the dark theme:** the hero's ambient light and the platform tiles' light still had a fifth to a
   third of their colour at their boxes' edges — a straight line under the dots and under the tiles. Both fade out
   inside their boxes now.
6. **The icon strip:** a tile that took the keyboard focus stayed 40px out of the 390px row — now scrolled fully in
   (`revealFocusedItem`).
7. **Reading text (G7) and note 3 on the page's own copy:** the consent row's explanation, the platforms sheet's and
   the intro's hint were 14px / 1.5 → 16px reading text; the consent row was flat `--paper` with a hairline (the grey
   card of note 3) → the kit's raised `panel` (faux glass in dark).

Tests: 3 new in `tests/home.test.ts` (49): `photoToWarm` (written failing first), and the hero in the server's markup —
every banner rendered with a group «n من N», no `inert`, no countdown, the trade-in's estimate line, and only the first
photo eager with high priority (ar and en). Kit requests from this review:
- kit (Carousel `rootProps.onKeyDown`): ignore a key whose target is outside the carousel's DOM (a dialog rendered in
  its React tree bubbles through it); the hero guards it meanwhile.
- kit (Carousel autoplay): the wrap from the last slide to the first smooth-scrolls back across every slide (1.3 s, five
  banners flying past at 1440) — jump instantly (the arriving banner's own rise reads as the change) or crossfade.
- kit (Carousel): with `scroll-snap-stop: normal` (above) a hard fling on a phone can pass several banners; once
  programmatic moves are fixed in the hook, the hero can go back to `always`.
- kit (CarouselPlay / CarouselDots): the pause key is server-rendered although nothing plays without JavaScript; the
  focused dot's ring (`outline-offset: -8px`) draws a thin 8 × 28 box beside the current pill.

### Fix-browse (wave C, 2026-11-13)

The auditors' defects for the page, fixed (tools `<scratch>/fb1/work/C-fix-browse/`, screens `<scratch>/fb1/shots/C-fix-browse/`):

| Defect | Fix | After |
|---|---|---|
| Lead decision 2 not built: the 116px icon-tile row and a 72px gap put the platform tiles at 917–919px on every laptop — only «تسوّق حسب المنصّة» at the fold of 1440 × 900 | from 1024 the strip is one row of 48px clay pills (`--key-face`, `--e-disc`), the kind icon (20px) beside the name, sharing the row (a little less air at 1024–1279 so eight still fit in ar, en, ckb); 12px under the hero's bar; «تسوّق حسب المنصّة» 32px under the strip (`.home-top + .home-platforms`) | tiles at 813–815px at 1024–1440 (`layout.mjs`): 85px of the tiles on the 1440 × 900 first screen in light and dark; at 768-tall laptops the heading is on screen and the tiles start under the fold — the banners' own copy needs 371–400px (`bannerfit.mjs`), so a shorter banner was not an option |
| Note 3 at the first dark screen: the strip's tiles were flat grey cards (the 13% / 9% floor light, nothing showing through) | dark: the strip's own glass — the card veil 10% → 4% white, a rim 18% on top (the theme's composite tokens declared again on `.home-strip`) — and a faint red light behind each icon; the banner's colour spills wide and low under the strip (`.home-hero__spill`, one per banner, crossfading with the slide; the ellipse ends inside its box on every side) | `z-home-dark-strip.png`: the pills take the banner's colour, rim-lit; phones' tiles too |
| The incoming banner crossed the screen as an empty band of colour; its words came after it landed | the words follow the move, as much as their column is on screen (`view.ts inView()`, `wordsShown()`: whole once the column is in, none at half of it or less, a fade between). A banner comes in words first in Arabic (its copy at its start, it enters from the end; English mirrors), so a fade tied to its distance — the auditor's "last 40%" — left the part on screen blank for most of the move; now its words arrive with it and the leaving banner's fade as they slide off, and the phone's peeking banner (a quarter of its column on screen) shows none. `Hero.tsx` writes inline opacity and translate on the words (60px a banner slower, `bannerAway()`: the distance from the resting place, the end of a phone's track counted) and the product (9% faster) as the track scrolls, once a frame; no drift unless motion is full | `midmove.mjs`: at 30% of a move the incoming words are fading in at the screen's edge, at 60% they are whole and the leaving banner shows its product (`shots/C-fix-browse/hero/mid-*.png`, 1440 dark ar, 390 ar, 1440 en). CSS `view()` timelines were tried first: Chromium measures a right-to-left scroller's view timeline from the wrong edge (the banner in view read -200% in Arabic, 50% in English) — the kit's `carousel__parallax` is wrong in Arabic for the same reason (requested) |
| Each move re-rendered the whole hero two or three times (6 banners; `arrived` set in an effect) — 3 long tasks of 74–164ms per move at 4× CPU | `HeroCarousel`, `ProductSlide`, `ServiceSlide` memoised with stable props (`slides` memoised in `home.tsx`, one `onChoose`); `arrived` derived in the render (set once, the first move); the kit's and the mirror's "swipe" heard only under a finger (they re-rendered the hero on every scroll event of a move, ~30 renders) | `perf.mjs` (16 s of autoplay, 4× CPU): one long task per move at 390 (152, 94ms), one or two at 1440; what remains is a whole-page style recalc: one dot's `aria-current` costs 134ms at 4× (1,500 elements) through the shell's `:has()` rules (requested) |
| Phones: the trade-in and used banners' picture sat 70px wide in the top corner, the lower 40% of the banner empty | the title in the top row, the key along the bottom, the console standing over everything above the key's row at the far end of its column (it stops at the key's row: the used banner's white key covered the Xbox's white controller when the console took the whole height) | `service.mjs`: no key-console overlap at 360 / 390 in ar, en, ckb; the console 126–144px tall (it was ~70 wide) |

Tests: `tests/home.test.ts` (53): `bannerAway`, `inView` and `wordsShown` (written failing first: right to left, a
phone's scroll padding, the last banner at the track's end, a snapped banner a pixel off, the peeking banner's quarter
column), and the stylesheet's contracts (the pills from 1024 and the gap above the tiles, the dark glass and the
spill's ellipse inside its box, the phones' service banners).

Requests from this round:
- shell (shell.css): `.shell-cobar__steps .steps > li:has(> .step[aria-current="step"])` puts `[aria-current]` inside a
  `:has()` argument while `.shell` and `:root` are `:has()` subjects with descendant parts (`.shell:has(.shell-taskbar)
  .shell-tabbar`, `:root:has(.shell …)`): every `aria-current` change anywhere in a page — each hero move's dots, chips,
  the nav — re-styles the whole page (134ms at 4× CPU on the home). Mark the current step's `<li>` (a class or
  attribute) and the shell's chrome on `<html>` / `.shell` with attributes instead of `:has()`.
- kit (pieces.css `.carousel__parallax`): `animation-timeline: view(inline)` is wrong in a right-to-left track in
  Chromium (the slide in view at -200%): in Arabic every parallax element sits at its `from` keyframe. The hero no
  longer uses the class; drive it from the track's scroll (as the hero does) or only in `[dir="ltr"]`.
