# Storefront shell (Design System v2 §5)

Everything around a customer page: `app/routes/storefront/_layout.tsx` renders `<ShellFrame>` (this folder) around
`<PageTransition><Outlet/></PageTransition>`, and around the error panel in its `ErrorBoundary`.
Spec: `…/scratchpad/ux/design-v2-spec.md` §5 (and §2.7, §2.10b, §2.11, §4.23, §6.16, §9, §10); class map: docs/UI.md §2.

## The three shells (chrome budget, §5.1)

| Shell | Below 1024 | From 1024 | Bottom | Footer |
|---|---|---|---|---|
| **store** (default) | 28px demo strip (scrolls away) + 56px sticky glass header | 64 + 44 = 108px (row 1 + nav row), no strip | floating tab bar 64 + 10 + safe area (gives way to a `<TaskBar>`) | full |
| **task** — `handle.shell.chrome = "task"` (trade-in, repair, assistant) | the store header | 108 | the page's `<TaskBar>`, no tab bar | one line |
| **checkout** — `handle.shell.chrome = "checkout"` (and `/checkout` by default) | ONE 56px bar: back to the cart · mascot · step rail · «طلب تجريبي» · help | 64 | the page's `<TaskBar>` | one line |

`--shell-header-h` (56 / 108; checkout 56 / 64), `--shell-top` (+ safe area, + the offline banner's measured height
`--shell-offline-h` while it shows — 40, more when its words wrap), `--shell-bottom` (the tab bar 74 + safe area, a task
bar's measured height, or 0) and `--shell-toast-top` are on `:root`; `base.css` turns `--shell-top` / `--shell-bottom`
into the global `scroll-padding-block`, so a focused control is never under a bar (WCAG 2.4.11). Sticky page elements
sit at `inset-block-start: var(--shell-top)` (right under the header, and under the offline banner while it shows) and
`inset-block-end: var(--shell-bottom)`.

| Piece | File | Notes |
|---|---|---|
| Frame, skip link, mega-menu host, sheets, toasts | `ShellFrame.tsx` | `<main id="main">` is the page's landmark; the skip link overlays the header |
| Demo strip, offline banner, page progress | `Banners.tsx` | strip = kit `<DemoNote variant="strip">` linking to the footer's `#shell-demo` (28px: the spec's one documented exception to 44px targets, full width, WCAG 2.5.8); offline = kit `<OfflineBanner>` pinned under the header for the whole page, its words from `shellChrome().offline` (form copy on checkout, task flows and `/account`, the cart elsewhere), its height published as `--shell-offline-h`; progress = 2px ink bar after 150 ms of `navigation.state === "loading"` |
| Header (both widths), task header, cart button, lockup, checkout bar | `Header.tsx` | one `<header data-motion-persist="header">` (glass); the cart carries `data-cart-target`, its bead `data-cart-badge`. Checkout bar: the keys, mascot and tag never shrink; the step rail shows all labels from 600, the numbers + the current label below (the label only when it fits — it wraps out of sight before anything runs under the tag), the numbers alone below 375, no mascot below 360; done steps keep a 44px hit area |
| Nav-row platforms + mega menus | `MegaMenu.tsx` | one 44px menu button per platform; the opaque panel and its scrim render through a portal into the host after the header |
| Search field, suggestions, search sheet | `SearchForm.tsx` | header pill (from 1024, "/" focuses it; the 404's one search field) · phone search sheet · a page's own field (`variant="panel"`, the catalog's /search) · `query` prefills it (a missing product's words) |
| Tab bar and `<TaskBar>` | `TabBar.tsx` | floating pill; hidden while a `.shell-taskbar` is in the page (CSS) |
| Categories sheet, compact platform tiles | `CategoriesSheet.tsx` | tiles · used + support entries · departments · rows · language / theme / currency |
| Footers | `Footer.tsx` | full footer (accordions below 768) and the one-line `TaskFooter` |
| Language / theme / currency | `Preferences.tsx` | `LanguageBank` (segmented LINKS — work without script), `LanguageMenu` (globe), `ThemeBank`, `CurrencyPanel` |
| Error panels | `ShellError.tsx` | 404 (the header's field focused on desktop, no second field) / missing product (§6.16: «ابحث عن …» with the slug's words, the named platform's consoles or the four tiles, the used devices) / 403 / 503 / 500 / offline (`errors.offline` word for word, as the root boundary; never "500" for a request that never reached the store) |
| Pure decisions | `chrome.ts` | `shellChrome` (+ the banner's `offline` words), `backFallback`, `canonicalSearch`, `tabOf`, `checkoutRail`, `megaPlan`, `megaFeature`, `suggestionKind`, `sheetCategories`, `errorKind`, `missingProduct`, `platformForQuery`, `FOOTER_POLICIES` — `tests/shell.test.ts` |
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
  `{ suggestions: { label, href, hint?, image?, priceIqd?, kindLabel? }[], total? }` (`href` locale-less; CONTRACTS.md
  §2). The row's kind comes from the href (`/p/` product, `/platform/`, `/c/`, `/device/`, `/used`, `/search?q=`
  correction). A product row: the thumbnail (`image`, an art key; a package glyph without one), the name, ONE second
  line — `kindLabel` («جهاز PS5»), else the department `hint` — and the price (`priceIqd`, integer IQD; the endpoint
  leaves it out while the product is sold out). `total` is the count in «اعرض كل النتائج (42)». A 404 switches
  suggestions off for the visit. Recent searches come from the catalog's `recent-searches` (this device, consent only).
- **Navigation data** (catalog read layer, `NavTaxonomy`): the mega menu's columns are `devices` (5 models + the
  consoles category), `games` (minus the cross-platform category; "all" = `/c/games?platform=<slug>`), `accessories`
  (minus gift cards and subscriptions, which go to "cards and services" with the used units); the featured tile is the
  console whose photo leads the platform (`artKey`). Not shown yet: link counts, short model names, the featured
  product's price and category photos — the catalogue read layer is adding them to `NavTaxonomy` (`NavLink.count`,
  `NavLink.short`, `NavPlatform.featured`, `NavCategory.artKey`, 2026-11-12); until the shell reads them the menu shows
  names only and the categories sheet a glyph in each well.
- **Policies** (content area): the footer links every slug of `POLICY_SLUGS` (`FOOTER_POLICIES`, test-checked).
- **Platform names:** the four known platforms show the design system's names (`ui:platform.*`).
- **Dates:** `useFormat().date` / `.dateTime` come from `~/lib/dates`.

## Not done here

- Only Chromium (Edge) was used to check this (headless, 320–1440px, light/dark, ar/en/ckb); no phone, Safari or Firefox.
- The Sorani strings need a native reader.
- An offline client navigation (and any data request that never reaches the store) is caught by the ROOT error
  boundary (`app/root.tsx`: the single fetch fails inside the middleware pipeline): a bare page with `errors.offline` and
  a retry that reloads the address. `ShellError`'s offline panel says the same words, for failures that do reach the
  layout (e.g. a part of a page whose code cannot load). A page whose code was never loaded makes React Router reload
  the document, so offline that ends on the browser's own offline page.
- Offline, the language switch waits (React Router cannot fetch the route manifest; switching would leave the new
  language's address over the old page): the page stays, the banner says why.
