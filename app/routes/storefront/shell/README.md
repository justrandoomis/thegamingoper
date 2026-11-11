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

`--shell-header-h` (56 / 108; checkout 56 / 64), `--shell-top` (+ safe area, + 40 while offline), `--shell-bottom` (the tab
bar 74 + safe area, a task bar's measured height, or 0) and `--shell-toast-top` are on `:root`; `base.css` turns
`--shell-top` / `--shell-bottom` into the global `scroll-padding-block`, so a focused control is never under a bar
(WCAG 2.4.11). Sticky page elements sit at `top: calc(var(--shell-header-h) + var(--safe-top))` and
`inset-block-end: var(--shell-bottom)`.

| Piece | File | Notes |
|---|---|---|
| Frame, skip link, mega-menu host, sheets, toasts | `ShellFrame.tsx` | `<main id="main">` is the page's landmark; the skip link overlays the header |
| Demo strip, offline banner, page progress | `Banners.tsx` | strip = kit `<DemoNote variant="strip">` linking to the footer's `#shell-demo`; offline = kit `<OfflineBanner>` (form copy on task / checkout screens); progress = 2px ink bar after 150 ms of `navigation.state === "loading"` |
| Header (both widths), task header, cart button, lockup, checkout bar | `Header.tsx` | one `<header data-motion-persist="header">` (glass); the cart carries `data-cart-target`, its bead `data-cart-badge` |
| Nav-row platforms + mega menus | `MegaMenu.tsx` | one 44px menu button per platform; the opaque panel and its scrim render through a portal into the host after the header |
| Search field, suggestions, search sheet | `SearchForm.tsx` | header pill (from 1024, "/" focuses it) · phone search sheet · 404 field |
| Tab bar and `<TaskBar>` | `TabBar.tsx` | floating pill; hidden while a `.shell-taskbar` is in the page (CSS) |
| Categories sheet, compact platform tiles | `CategoriesSheet.tsx` | tiles · used + support entries · departments · rows · language / theme / currency |
| Footers | `Footer.tsx` | full footer (accordions below 768) and the one-line `TaskFooter` |
| Language / theme / currency | `Preferences.tsx` | `LanguageBank` (segmented LINKS — work without script), `LanguageMenu` (globe), `ThemeBank`, `CurrencyPanel` |
| Error panels | `ShellError.tsx` | 404 / 403 / 503 / 500 / offline (never "500" for a request that never reached the store) |
| Pure decisions | `chrome.ts` | `shellChrome`, `backFallback`, `canonicalSearch`, `tabOf`, `checkoutRail`, `megaPlan`, `megaFeature`, `suggestionKind`, `sheetCategories`, `errorKind`, `FOOTER_POLICIES` — `tests/shell.test.ts` |
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
- **Error pages ignore page handles:** while the layout's ErrorBoundary renders, the failed page's `tabBar: false` /
  `chrome` no longer apply, so a 404 under `/p/…` or `/checkout` gets the store shell with its tab bar.
- **Fly to cart** lands on the first on-screen `[data-cart-target]`: the header's cart button (every width) — the tab
  bar's cart tab carries one too.
- **Anything rendered from `location.search`** goes through `canonicalSearch()`: the server renders the query rebuilt by
  URLSearchParams (`%20` → `+`, `,` → `%2C`), the browser keeps the raw text — without it the hydration differs.

## Contracts with other areas

- **Search suggestions** (catalog area): `GET /api/search/suggest?q=<text>&locale=<ar|en|ckb>` →
  `{ suggestions: { label, href, hint?, image?, priceIqd?, kindLabel? }[], total? }` (`href` locale-less). The row's
  kind comes from the href (`/p/` product, `/platform/`, `/c/`, `/device/`, `/used`, `/search?q=` correction). The
  optional fields (thumbnail art key, integer IQD price, kind label, total count) are shown when they come; today the
  endpoint sends label/href/hint only, so product rows show a package glyph and no price. A 404 switches suggestions
  off for the visit. Recent searches come from the catalog's `recent-searches` (this device, consent only).
- **Navigation data** (catalog read layer, `NavTaxonomy`): the mega menu's columns are `devices` (5 models + the
  consoles category), `games` (minus the cross-platform category; "all" = `/c/games?platform=<slug>`), `accessories`
  (minus gift cards and subscriptions, which go to "cards and services" with the used units); the featured tile is the
  console whose photo leads the platform (`artKey`). Not in the data yet: link counts, the featured product's price,
  category photos (the categories sheet shows a glyph in each well).
- **Policies** (content area): the footer links every slug of `POLICY_SLUGS` (`FOOTER_POLICIES`, test-checked).
- **Platform names:** the four known platforms show the design system's names (`ui:platform.*`).
- **Dates:** `useFormat().date` / `.dateTime` come from `~/lib/dates`.

## Not done here

- Only Chromium (Edge) was used to check this (headless, 360–1440px, light/dark, ar/en/ckb); no phone, Safari or Firefox.
- The Sorani strings need a native reader.
- An offline client navigation is caught by the ROOT error boundary (`app/root.tsx`, the single fetch fails inside
  the middleware pipeline), not by `ShellError` — its offline panel shows only for failures that reach the layout.
