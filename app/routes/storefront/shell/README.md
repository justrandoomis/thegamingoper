# Storefront shell (Design v2.1 "Clay & Glass" on Design System v2 §5)

Everything around a customer page: `app/routes/storefront/_layout.tsx` renders `<ShellFrame>` (this folder) around
`<PageTransition><Outlet/></PageTransition>`, and around the error panel in its `ErrorBoundary`.
Spec: `…/scratchpad/ux/design-v2-spec.md` §5 (and §2.7, §2.10b, §2.11, §4.23, §6.16, §9, §10); the v2.1 round:
`…/a312dfb7…/scratchpad/fb1/brief.md` (client notes 1, 6, 9; §2.7, §3); class map: docs/UI.md §2.

## v2.1 QA fixes (2026-11-13, wave C)

- **Icon tiles** (home strip, categories sheet): the name is never clipped (no line clamp; 1.45 line height) — the clamp
  cut the dots under a final «ي» («أيدى التحكم», «الواقع الافتراضى») at every density. Under a fine pointer the tile
  lifts (the kit's `.lift`) and its icon swells 1.08 (instant under reduced motion).
- **Utility strip:** inert once the page has scrolled it away (`data-scrolled`), so Tab / Shift+Tab never focus a link
  above the screen; its links, languages and switch are 44px wide at least and their hit areas reach down into the
  12px lead (the strip is the top of the page: a hit area above it was off the screen).
- **Focus in the sticky bars never scrolls the page:** the header's and the checkout bar's controls have
  `scroll-margin-block` shifting their scroll box by the root's scroll padding (Shift+Tab through the header scrolled
  ~420px a step), and the header's search field undoes its caret reveal before the next paint (`holdScroll`).
- **Demo strip:** a plain in-page link `<a href="#shell-demo">` around the kit's strip (a router link to a bare hash
  dropped the query — a guest's order link lost its `?t=` token), 44px tall.
- **Search:** words with no match get one row «لا اقتراحات لـ «…»» · «ابحث في كل المتجر» (Enter searches;
  `chrome.ts suggestionState`); in demo mode a list with prices says «الأسعار تجريبية» on its head; `SearchForm` takes
  `openOnFocus` and `aria-label`. The not-found view has its own field, so its header shows the key
  (`searchMode(path, { notFound })`); every other error panel keeps its address's search.
- **«مركز الدعم»** is the support centre's one name: the strip's link, the footer column, the sheet's tile, the
  one-line footer, the checkout bar's help key (lead decision 2026-11-13).
- **Checkout bar below 600:** every step's word under its disc (13px) — from 390 in every language, from 360 in Arabic;
  English and Sorani keep only the current step's word at 360–389; numbers alone below 360.
- **Print:** the logo, the page, the footer's contact row, © and demo statement; no tab bar, task bar, skip link,
  offline banner, strip, nav row, keys, search, footer columns or switches; header and checkout bar flow with the page.
- **Phone footer and sheet notes** read at 16px / 1.75 (G7); the footer lockup is as wide as the logo.
- An **error panel** that replaces a page after a client navigation scrolls to the top when its title would be above the
  bars; the nav row's **indicator** stays under the item the mouse is on when a menu closes.
- `handle.shell.chrome` may be a **function of the address** (`({ path, search }) => "store" | "task" | "checkout"`).

## v2.1 (2026-11-12, the client's first feedback round)

- **Desktop header (note 1):** three rows — the 36px **utility strip** (the delivery fee fact and «الدفع عند الاستلام»
  while the store takes cash · تتبّع طلبك · استبدل جهازك · مركز الدعم · العربية English کوردی as words · the light /
  dark switch `ThemeSwitch`; 1024–1279 it drops the cash note, the links' icons and the switch's visible words; every
  link at least 44px wide, its hit area 44 × 44; inert once scrolled away), the
  **main row** (the larger lockup · the wide search well, 48px, «/» · round clay keys: favourites, account, the cart
  with its count) and the 44px **nav row** (each platform: its device glyph in its colour light + name + chevron ·
  الألعاب · الإكسسوارات (from 1280) · المستعمل · الصيانة · the demo chip). An indicator in the platform's colour
  slides under the item the pointer or the keyboard focus is on and rests under the open menu or the current page
  (`.shell-nav__ink`, transform only). The header sticks at −(strip + 12px lead): those scroll away 1:1, the sticky
  header stays 108px; on the floor at the top, its glass layer (`.shell-header__glass`) fades in once scrolled and
  the lockup tightens to 0.9. Nothing below moves.
- **Phone header:** lockup · the search pill (search pages) or the round search key · the cart; glass once scrolled.
  The task header's back key is a round clay key like the cart at its other end (G2); the checkout bar keeps v2's
  plain back and help (the bar the client chose).
- **Search field or search key, decided here by path (note 9, brief §2.7):** `chrome.ts searchMode(path, { notFound })`
  — the FIELD on home, platform / category / search listings, compare, products, device hubs, the used list and units,
  landing pages; only the round KEY (`.shell-searchkey`, every width) on the cart, checkout, order and track, all of
  /support, trade-in and its status, the account and /wishlist, about / contact / policies / accessibility, the design
  system and the motion lab — and on the not-found view, whose own field is the page's one search field (an error
  panel otherwise keeps its address's search). The key opens the same search sheet (field focused; a side sheet from
  768); without script it is a link to /search. `<header data-search="field|key">` for page CSS.
- **Mega menu (note 6):** v2's arrangement in a frosted panel (`.glass.glass--panel`) with a 3px line of the platform's
  colour; a head row (the platform's glyph on a clay disc, its name, its count · «كل منتجات …» as a clay key); kind
  icons on clay discs over the columns; device rows with the model's 32px photo only when the read layer sends
  `artKey` (no stand-in glyph: the same glyph on every row said nothing and pushed «PS5 Digital (2020)» onto two
  lines); the read layer's counts as pills at the row's end; hovered rows highlighted; the featured card (`.surface
  .lift`: the photo on a lit well, the name, its **qualifier on its own meta line**, the price with «سعر تجريبي» on
  a demo row, a clay key «عرض المنتج»). It drops 8px with a fade, the columns follow 40ms apart, a platform switch
  staggers again; it starts at the header's bottom wherever that is (`--shell-mega-top`); it closes when the window
  leaves the desktop range (a tablet turned upright, a zoom). The panel is a denser frost than the kit's
  (`--glass-panel` 94% paper, saturate 1.2; dark 88%): over the crimson hero the kit's face turned it pink in blotches.
- **Search suggestions:** a product row's meta line is `suggestionMeta()` — the qualifier, then the kind, else the
  department; under the header's field the panel is `.glass--panel` with the mega menu's denser frost, as wide as the
  search well.
- **Categories sheet:** the kit's vivid compact platform tiles, then «الأقسام» and «خدمات» as glass icon tiles
  (`.shell-itiles` / `IconTile`: `.surface`, a red `kind-*` icon, the name, the count), three to a row (four once the
  sheet is 520px wide; a short last row centred — four in 358px pushed «الإكسسوارات», «هێدسێتەکان» and
  "subscriptions" out of their tiles), arriving 30ms apart.
- **Tab bar:** ONE active pill (`.shell-tabbar__pill`, its column from the server as `--tab-i`) slides between tabs;
  a pressed tab's icon dips. Reduced motion (OS or the store's switch): every one of these is instant, no stagger.

## The three shells (chrome budget, §5.1)

| Shell | Below 1024 | From 1024 | Bottom | Footer |
|---|---|---|---|---|
| **store** (default) | 44px demo strip (scrolls away) + 56px sticky header (glass once scrolled) | strip 36 + lead 12 + 64 + 44 at the top; 108 sticky (strip and lead scroll away); the demo chip in the nav row | floating tab bar 64 + 10 + safe area (gives way to a `<TaskBar>`) | full |
| **task** — `handle.shell.chrome = "task"` (trade-in, repair, assistant) | the store header | the store header | the page's `<TaskBar>`, no tab bar | one line |
| **checkout** — `handle.shell.chrome = "checkout"` (and `/checkout` by default) | ONE 56px bar: back to the cart · mascot · step rail · «طلب تجريبي» · help | 64 | the page's `<TaskBar>` | one line |

`--shell-header-h` (56 / 108 sticky; checkout 56 / 64), `--shell-strip-h` and `--shell-lead` (36 and 12 from 1024 on
store and task pages, else 0), `--shell-top` (+ safe area, + the offline banner's measured height
`--shell-offline-h` while it shows — 40, more when its words wrap), `--shell-bottom` (the tab bar 74 + safe area, a task
bar's measured height, or 0) and `--shell-toast-top` are on `:root`; `base.css` turns `--shell-top` / `--shell-bottom`
into the global `scroll-padding-block`, so a focused control is never under a bar (WCAG 2.4.11). A browser does not
scroll a control that is already PARTLY in view, so `ShellFrame` also moves a keyboard-focused control of the page that
still reaches under a bar clear of it by the overlap + 12px (`useFocusClearOfBars`, `chrome.ts focusNudge`; controls
only — a `tabindex="-1"` target such as `<main>` never moves the page). Sticky page elements sit at
`inset-block-start: var(--shell-top)` (right under the header, and under the offline banner while it shows) and
`inset-block-end: var(--shell-bottom)`. Under forced colours the glass bars draw their edge (header and checkout bar
below, the tab bar all round, task bars above).

| Piece | File | Notes |
|---|---|---|
| Frame, skip link, mega-menu host, sheets, toasts | `ShellFrame.tsx` | `<main id="main">` is the page's landmark; the skip link overlays the header |
| Demo strip, offline banner, page progress | `Banners.tsx` | strip = a plain in-page link `<a href="#shell-demo">` (the footer's statement) around the kit's `<DemoNote variant="strip">`, 44px tall — a plain link keeps the address's query (a router link to a bare hash dropped it) and prefetches nothing; offline = kit `<OfflineBanner>` pinned under the header for the whole page, its words from `shellChrome().offline` (form copy on checkout, task flows and `/account`, the cart elsewhere), its height published as `--shell-offline-h`; progress = 2px ink bar after 150 ms of `navigation.state === "loading"` |
| Header (both widths), utility strip, search key, task header, cart key, lockup, checkout bar | `Header.tsx` | one `<header data-motion-persist="header" data-search data-scrolled>` with a `<Glass>` layer that fades in once scrolled; the cart (a round clay key) carries `data-cart-target`, its bead `data-cart-badge`. Task header title (`TaskTitle`): the `<h1>` on one line, cut between words with «…» at its logical end (`chrome.ts clampWords`, measured by a hidden probe; never inside a bracket or on a joiner). Checkout bar: the keys and the whole «طلب تجريبي» tag never shrink (no short form); the step rail shows all labels beside their discs from 600; below 600 every label UNDER its disc (13px; steps 46px tall) from 390 in every language and from 360 in Arabic, only the current step's label at 360–389 in English and Sorani, the numbers alone below 360; the mascot gives way first below 430 (480 in Sorani, whose tag and labels are longer); done steps keep a 44px hit area. The header's and the bar's controls carry a `scroll-margin-block` that keeps focus in them from scrolling the page. The strip is `inert` while scrolled away |
| Nav-row platforms + mega menus | `MegaMenu.tsx` | one 44px menu button per platform (device glyph `DeviceGlyph` = the kit's `<Icon name="device-…">` in its colour light, name, chevron) and the sliding indicator; the glass panel and its scrim render through a portal into the host after the header. Columns: at most five short model names (`NavLink.short`, the full name as the tooltip; the model's photo when the link has `artKey`) with the read layer's counts (`NavLink.count`) as pills, a link's `qualifier` on its own meta line; «كل … » / «… المستعملة» one string per platform (`chrome.ts megaWords`). Featured card (`megaFeature`): the read layer's `NavPlatform.featured` — photo (else the product's first catalogue photo; the glyph only when it has none), name, `qualifier`, Price md + «سعر تجريبي» on a demo row, «نفد حالياً» / «قريباً», the clay key |
| Search field, suggestions, search sheet | `SearchForm.tsx` | header well (from 1024, "/" focuses it without scrolling; its focus never moves the page) · phone search sheet (also what the search key opens, at every width) · a page's own field (`variant="panel"`: the catalog's /search, the 404) · `query` prefills it (a missing product's words) · `openOnFocus` (default true; false: the recent searches wait for typing or ↓) · `aria-label` (the search landmark's name; «ابحث في المتجر» by default for the header and the sheet, none for a panel unless given) · no match → one row that searches anyway · «الأسعار تجريبية» on a priced list's head in demo mode |
| Tab bar and `<TaskBar>` | `TabBar.tsx` | floating glass pill with the sliding active pill; hidden while a `.shell-taskbar` is in the page (CSS) |
| Categories sheet, compact platform tiles, icon tiles | `CategoriesSheet.tsx` | platform tiles · «الأقسام» and «خدمات» as glass icon tiles (`IconTile`, kind icons) · language / theme / currency; `ShellRow` stays for the 404 page |
| Footers | `Footer.tsx` | full footer (accordions below 768) and the one-line `TaskFooter` |
| Language / theme / currency | `Preferences.tsx` | `LanguageBank` (segmented LINKS — work without script), `LanguageLinks` (the same links as words: the utility strip), `LanguageMenu` (globe), `ThemeSwitch` (the strip's light / dark toggle, `aria-pressed`), `ThemeBank`, `CurrencyPanel` (the rate «1 USD = 1,310 د.ع»: only «1 USD» isolated, the dinar figure first — `chrome.ts rateText`) |
| Error panels | `ShellError.tsx` (service group's) | 404 (its own field, focused on desktop; the header shows only the search key there — `ShellFrame notFound`) / missing product (§6.16: «ابحث عن …» with the slug's words, the named platform's consoles or the four tiles, the used devices) / 403 / 503 / 500 / offline (`errors.offline` word for word, as the root boundary; never "500" for a request that never reached the store) |
| Pure decisions | `chrome.ts` | `shellChrome` (+ the banner's `offline` words; a handle's `chrome` may be a function of the address), `searchMode` (field or key, by path; the key on the not-found view), `backFallback`, `canonicalSearch`, `tabOf`, `checkoutRail`, `megaPlan`, `megaFeature`, `megaWords`, `suggestionKind`, `suggestionMeta`, `suggestionState` (rows · count · «لا اقتراحات» · wait), `sheetCategories`, `errorKind`, `missingProduct`, `platformForQuery`, `focusNudge`, `clampWords`, `rateText`, `FOOTER_POLICIES`, `TASK_FOOTER_LINKS` / `TASK_FOOTER_LABELS` (support is «مركز الدعم», its one name) — `tests/shell.test.ts` |
| Page meta helper | `meta.ts` | `shellMeta(args, page)` |
| Server data | `data.server.ts`, `types.ts` | nav taxonomy (cached per isolate), fee, payment switches, contact, PUBLIC_ORIGIN |
| Strings | `app/i18n/messages/shell.ts` (+ `errors.offline` in `errors.ts`) | read with `useShellT()` (`i18n.tsx`) |

## What a page does

- **No `<main>` of your own** — start with your `<h1>`. The shell's `<main id="main">` is the skip link's target, and
  the task header shows the `<h1>`'s text as its title.
- **Meta:** React Router replaces (never merges) the layout's meta, so pass yours through the helper to keep the
  title template, canonical, hreflang, Open Graph and demo-mode noindex:
  ```ts
  import { shellMeta } from "~/routes/storefront/shell/meta";
  export const meta: Route.MetaFunction = (args) =>
    shellMeta(args, { title: args.loaderData?.product.name, description: args.loaderData?.product.short, image, type: "product" });
  ```
- **A bottom buy / task bar:** declare it so the server renders the right header, and use `<TaskBar>` (glass, 72px +
  safe area, content inset 16, at most 640 wide on tablets):
  ```tsx
  import type { ShellHandle } from "~/routes/storefront/shell/types";
  import { TaskBar } from "~/routes/storefront/shell/TabBar";
  export const handle = { shell: { tabBar: false } } satisfies ShellHandle;      // optional: back: "/cart"
  <TaskBar aria-label={t("buy")} className="lg:hidden">…price and the primary key…</TaskBar>
  ```
  The tab bar gives way to it by itself (CSS) — and comes back on the same page when it draws no task bar (an empty
  cart). Task flows declare `{ shell: { chrome: "task" } }`; checkout `{ shell: { chrome: "checkout" } }` (the
  checkout bar then shows the step rail from `?step=address|payment|review`, labels in `shell.ts checkout.steps`).
  One route that is two kinds of page gives a function of the address (locale-less `path`, the query as the server
  spells it; read on the server too): `{ shell: { chrome: ({ search }) => (new URLSearchParams(search).has("step") ?
  "task" : "store") } }` — a landing page with the tab bar, its steps a task flow.
- **Print** is the shell's: only the logo, the page and the footer's contact row, © and demo statement print. A page
  hides its own screen-only controls in print (gallery keys, sticky bars of its own).
- **Task header** (pages with `tabBar: false` and task flows, below 1024): once the page scrolls 24px the header is
  back · title · cart. Back is history Back when an earlier page of this site is in the tab, else `handle.shell.back`
  or the page's section (`backFallback`: `/checkout` → `/cart`, `/used/x` → `/used`, `/support/x` → `/support`,
  otherwise `/`). Public state for page CSS: `.shell-header[data-task][data-scrolled]`.
- **Offline words:** the banner says «ما كتبته باقٍ في الصفحة؛ أرسله عند عودة الاتصال.» on checkout, task flows and
  every `/account` page, «سلتك محفوظة على هذا الجهاز.» elsewhere. A page decides for itself with
  `handle = { shell: { offline: "form" } }` (a store page built around a form, e.g. /track) or `"store"`.
- **Error pages ignore page handles:** while the layout's ErrorBoundary renders, the failed page's `tabBar: false` /
  `chrome` / `offline` no longer apply, so a 404 under `/p/…` or `/checkout` gets the store shell with its tab bar.
- **A missing product:** throw `data({ error: "not_found", what: "product", query: <the slug's words> }, { status: 404 })`
  (the product page does); the panel and the search fields read `query`.
- **Fly to cart** lands on the first on-screen `[data-cart-target]`: the header's cart button (every width) — the tab
  bar's cart tab carries one too.
- **Anything rendered from `location.search`** goes through `canonicalSearch()`: the server renders the query rebuilt by
  URLSearchParams (`%20` → `+`, `,` → `%2C`), the browser keeps the raw text — without it the hydration differs.

## Contracts with other areas

- **Search suggestions** (catalog area): `GET /api/search/suggest?q=<text>&locale=<ar|en|ckb>` →
  `{ suggestions: { label, href, hint?, image?, priceIqd?, kindLabel?, qualifier? }[], total? }` (`href` locale-less;
  CONTRACTS.md §2). The row's kind comes from the href (`/p/` product, `/platform/`, `/c/`, `/device/`, `/used`,
  `/search?q=` correction). A product row: the thumbnail (`image`, an art key; a package glyph without one), the name,
  ONE meta line — `qualifier` («نسخة الأقراص», the words the Latin title leaves out), then `kindLabel` («جهاز PS5»),
  else the department `hint` (`chrome.ts suggestionMeta`) — and the price (`priceIqd`, integer IQD; the endpoint leaves
  it out while the product is sold out). `total` is the count in «اعرض كل النتائج (42)». A 404 switches suggestions
  off for the visit. Recent searches come from the catalog's `recent-searches` (this device, consent only).
  **Open (asked of the catalog area, 2026-11-12):** the endpoint does not send `qualifier` yet — the search service
  has it (`SearchSuggestionItem.qualifier`); the shell prints it as soon as it comes.
- **Navigation data** (catalog read layer, `NavTaxonomy`): the mega menu's columns are `devices` (5 models + the
  consoles category), `games` (minus the cross-platform category; "all" = `/c/games?platform=<slug>`), `accessories`
  (minus gift cards and subscriptions, which go to "cards and services" with the used units). The menu shows the
  read layer's `NavLink.short` (device models) and `NavLink.count` on every link that has one, and features
  `NavPlatform.featured` (photo, name, price, state, demo flag); `featured: null` means no tile. Without `featured`
  (hand-written data) the tile is the console whose photo leads the platform (`artKey`), else the first console with a
  catalogue photo. The featured card prints `NavFeatured.qualifier` (and a product link's `NavLink.qualifier`) on its
  own meta line. **Open (asked of the catalog area, 2026-11-12):** a device link's photo — `artKey` on
  `NavPlatform.devices[]` (`device_models.art_key`); `chrome.ts megaPlan` already reads a well-formed one into
  `MegaLink.art`, and the devices column shows plain rows (no stand-in glyph) until then.

## What other areas use (v2.1)

- `searchMode(path)` (`chrome.ts`) tells whether the header has the search field; `.shell-header[data-search="key"]`
  is on the page for CSS. A page that needs search on a key-mode page (support's own problem search) draws its own
  field — the header's key opens the store search. A page's own `SearchForm variant="panel"` can be named
  (`aria-label`) and kept from opening its recent searches on focus (`openOnFocus={false}`, a field focused for the
  shopper).
- The header is taller at the very top from 1024 (strip 36 + lead 12): sticky page parts keep using `--shell-top` /
  `--shell-header-h` (the sticky 108), which is right once the page has scrolled 48px; nothing to change in a page.
- `IconTile` (`CategoriesSheet.tsx`) and `DeviceGlyph` (`MegaMenu.tsx`) are exported for the 404 page (content area,
  note 11) — the four platform tiles stay `PlatformTilesCompact`.
- **Policies** (content area): the footer links every slug of `POLICY_SLUGS` (`FOOTER_POLICIES`, test-checked).
- **Platform names:** the four known platforms show the design system's names (`ui:platform.*`).
- **Dates:** `useFormat().date` / `.dateTime` come from `~/lib/dates`.

## Not done here

- Only Chromium (Edge) was used to check this (headless, 320–1440px, light/dark, ar/en/ckb); no phone, Safari or Firefox.
- The Sorani strings need a native reader. They spell the brand «طمطم» as in the logo until the owner decides the
  Sorani spelling (v2 §9 glossary, §13 item 12): change it in `shell.ts` (brandHome, checkout.home, footer.about,
  footer.pay.wallet, footer.rights, meta) and in the other namespaces that name the store.
- An offline client navigation (and any data request that never reaches the store) is caught by the ROOT error
  boundary (`app/root.tsx`: the single fetch fails inside the middleware pipeline): a bare page with `errors.offline` and
  a retry that reloads the address. `ShellError`'s offline panel says the same words, for failures that do reach the
  layout (e.g. a part of a page whose code cannot load). A page whose code was never loaded makes React Router reload
  the document, so offline that ends on the browser's own offline page.
- Offline, the language switch waits (React Router cannot fetch the route manifest; switching would leave the new
  language's address over the old page): the page stays, the banner says why.
