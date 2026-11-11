# Storefront shell

Everything around a customer page: `app/routes/storefront/_layout.tsx` renders `<ShellFrame>` (this folder) around
`<PageTransition><Outlet/></PageTransition>`, and around the 404/500 panel in its `ErrorBoundary`.
Spec: docs/DESIGN.md §9.2 header, §9.3 tab bar, §8.8 desktop header + mega menu, §8.11 tablet, §9.16 offline.

| Piece | File | Notes |
|---|---|---|
| Frame, skip link, toasts, offline banner | `ShellFrame.tsx` | `<main id="main">` is the page's landmark |
| Demo ribbon | `Banners.tsx` | only while `STORE_MODE=demo` |
| Utility strip (≥1200), header, search | `Header.tsx`, `SearchForm.tsx` | glass only after 24px of scroll (IntersectionObserver); task header on task screens (below) |
| Platform links + mega menus (≥1200) | `MegaMenu.tsx` | link → hub; caret → menu (focus trapped, Escape returns) |
| Tab bar (<1200) and `<TaskBar>` | `TabBar.tsx` | `--shell-bottom` = what fixed chrome covers |
| Categories sheet (<1200) | `CategoriesSheet.tsx` | used + support first, then platforms, departments, services, preferences |
| Footer | `Footer.tsx` | `#shell-categories` is the no-script target of the categories tab |
| Language / currency / theme | `Preferences.tsx` | URL prefix · `tt_prefs` cookie · `themeMorph` |
| 404 / 403 / 503 / 500 panel | `ShellError.tsx` | strings travel in thrown data when the layout itself fails |
| Page meta helper | `meta.ts` | `shellMeta(args, page)` |
| Pure decisions | `chrome.ts` | `shellChrome` (bars from the handles), `backFallback`, `canonicalSearch`, `FOOTER_POLICIES` — `tests/shell.test.ts` |
| Server data | `data.server.ts`, `types.ts` | nav taxonomy (cached per isolate), fee, payment switches, contact, PUBLIC_ORIGIN |
| Strings | `app/i18n/messages/shell.ts` | read with `useShellT()` (`i18n.tsx`) |

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
- **A bottom buy / checkout bar:** declare it so the server renders the page without the tab bar, and use `<TaskBar>`:
  ```tsx
  import type { ShellHandle } from "~/routes/storefront/shell/types";
  import { TaskBar } from "~/routes/storefront/shell/TabBar";
  export const handle = { shell: { tabBar: false } } satisfies ShellHandle;      // optional: back: "/cart"
  <TaskBar aria-label={t("buy")} className="lg:hidden">…price and the commit key…</TaskBar>
  ```
  Sticky elements of a page sit at `inset-block-end: var(--shell-bottom)`; the shell already pads the page by it.
- **Task header** (pages with `tabBar: false`, below 1200, DESIGN §9.2): once the page scrolls ~24px the glass header
  becomes back · title · cart. The title is the page's `<h1>` text (`aria-hidden` — the `<h1>` itself names the page);
  the cart orb carries the count bead and `data-cart-target`; the search field comes back while it has focus. Back is
  history Back when an earlier page of this site is in the tab, else a link to `handle.shell.back` or the page's section
  (`backFallback`: `/checkout` → `/cart`, `/used/x` → `/used`, `/support/x` → `/support`, otherwise `/`). The state is
  public for page CSS: `.shell-header[data-task][data-scrolled]` = the task header is showing (e.g. to hide a page's
  own back / cart orbs that would repeat it).
- **Error pages ignore page handles:** while the layout's ErrorBoundary renders, `tabBar: false` of the failed page no
  longer applies (its task bar is gone), so a 404 under `/p/…` has the tab bar. A page with its own ErrorBoundary and
  `tabBar: false` must render its `<TaskBar>` (or nothing at the bottom) there itself.
- **Fly to cart** lands on the first visible `[data-cart-target]`: the task header's cart orb, the tab bar's cart
  (<1200), or the desktop header's cart orb.
- `--shell-header-h` (56 / 80px) and `--shell-toast-top` are on `:root` for anything positioned under the header.
- **Anything rendered from `location.search`** goes through `canonicalSearch()`: the server renders the query rebuilt by
  URLSearchParams (`%20` → `+`, `,` → `%2C`), the browser keeps the raw text — without it the hydration differs.

## The catalogue read layer (`app/server/services/catalog/cards.server.ts`, `taxonomy.server.ts`)

- **Platforms are the researched ones** (`researchedPlatformSql`): a product's own `platform_id`, else the devices its
  `attributes.game.platforms` names, else its verified/partial product-level compatibility rules — the demo import's
  `platformsOf` and the catalog area's hubs. `listCards({ platform })` (and `getNewArrivals` / `getDeals`) include the
  games sold for PS5 and Xbox and the headsets made for several platforms; a multi-platform card's `platformSlug` is null.
- **The menu agrees with the hubs** (`getNavTaxonomy`): `productCount` = the platform hub's count, department counts =
  the category hubs' counts (published products with an active variant), a game for two platforms counts for both;
  a department link carries `?platform=` only when its hub would also list products not for that platform.
  `tests/catalog-cards.test.ts` checks every count and link against `listing.server.ts`.
- Used units keep their device's own platform (`getUsedSpotlight`, like `/used?platform=`).

## Contracts with other areas

- **Search suggestions** (catalog area): the header field asks `GET /api/search/suggest?q=<text>&locale=<ar|en|ckb>`
  for `{ suggestions: { label, href, hint? }[] }` (`href` locale-less). Until that endpoint exists it answers 404
  and the field stays a plain GET form to `/search?q=` for the rest of the visit.
- **Policies** (content area): the footer links every slug of `POLICY_SLUGS` (`/policies/shipping|returns|warranty|
  payment|privacy|terms`, columns in `chrome.ts` `FOOTER_POLICIES`, test-checked), `/policies`, `/about`, `/contact`,
  `/accessibility`.
- **Platform names:** the four known platforms show the design system's names (`ui:platform.*` — Latin brand names
  stay Latin, DESIGN.md §11); any other platform shows its catalogue name.
- **Dates:** `useFormat().date` / `.dateTime` come from `~/lib/dates` — Sorani months and CLDR's Sorani patterns are
  written there (the browsers' and workerd's ICU have no Kurdish data); `formatWeekday` / `formatWeekdayDay` are there
  for day choices (checkout, repair, trade-in still call Intl for those).

## Not done here

- Only Chromium (Edge) was used to check this (headless, 360–1440px, light/dark, ar/en/ckb); no phone, Safari or Firefox.
- The Sorani strings, month names and date patterns need a native reader. Relative times (`useFormat().relative`)
  stay English on a Kurdish page: CLDR has no Sorani relative-time data to follow.
