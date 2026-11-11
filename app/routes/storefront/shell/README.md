# Storefront shell

Everything around a customer page: `app/routes/storefront/_layout.tsx` renders `<ShellFrame>` (this folder) around
`<PageTransition><Outlet/></PageTransition>`, and around the 404/500 panel in its `ErrorBoundary`.
Spec: docs/DESIGN.md §9.2 header, §9.3 tab bar, §8.8 desktop header + mega menu, §8.11 tablet, §9.16 offline.

| Piece | File | Notes |
|---|---|---|
| Frame, skip link, toasts, offline banner | `ShellFrame.tsx` | `<main id="main">` is the page's landmark |
| Demo ribbon | `Banners.tsx` | only while `STORE_MODE=demo` |
| Utility strip (≥1200), header, search | `Header.tsx`, `SearchForm.tsx` | glass only after 24px of scroll (IntersectionObserver) |
| Platform links + mega menus (≥1200) | `MegaMenu.tsx` | link → hub; caret → menu (focus trapped, Escape returns) |
| Tab bar (<1200) and `<TaskBar>` | `TabBar.tsx` | `--shell-bottom` = what fixed chrome covers |
| Categories sheet (<1200) | `CategoriesSheet.tsx` | used + support first, then platforms, departments, services, preferences |
| Footer | `Footer.tsx` | `#shell-categories` is the no-script target of the categories tab |
| Language / currency / theme | `Preferences.tsx` | URL prefix · `tt_prefs` cookie · `themeMorph` |
| 404 / 403 / 503 / 500 panel | `ShellError.tsx` | strings travel in thrown data when the layout itself fails |
| Page meta helper | `meta.ts` | `shellMeta(args, page)` |
| Server data | `data.server.ts`, `types.ts` | nav taxonomy (cached per isolate), fee, payment switches, contact, PUBLIC_ORIGIN |
| Strings | `app/i18n/messages/shell.ts` | read with `useShellT()` (`i18n.tsx`) |

## What a page does

- **No `<main>` of your own** — start with your `<h1>`. The shell's `<main id="main">` is the skip link's target.
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
  export const handle = { shell: { tabBar: false } } satisfies ShellHandle;
  <TaskBar aria-label={t("buy")} className="lg:hidden">…price and the commit key…</TaskBar>
  ```
  Sticky elements of a page sit at `inset-block-end: var(--shell-bottom)`; the shell already pads the page by it.
- **Fly to cart** lands on the visible `[data-cart-target]`: the tab bar's cart (<1200) or the header's cart orb.
- `--shell-header-h` (56 / 80px) and `--shell-toast-top` are on `:root` for anything positioned under the header.

## Contracts with other areas

- **Search suggestions** (catalog area): the header field asks `GET /api/search/suggest?q=<text>&locale=<ar|en|ckb>`
  for `{ suggestions: { label, href, hint? }[] }` (`href` locale-less). Until that endpoint exists it answers 404
  and the field stays a plain GET form to `/search?q=` for the rest of the visit.
- **Policies** (content area): the footer links `/policies/shipping|returns|warranty|privacy|terms`, `/about`,
  `/contact`, `/accessibility`.
- **Platform names:** the four known platforms show the design system's names (`ui:platform.*` — Latin brand names
  stay Latin, DESIGN.md §11); any other platform shows its catalogue name.

## Not done here

- Only Chromium was used to check this (headless, 360–1440px, light/dark, ar/en/ckb); no phone, Safari or Firefox.
- The Sorani strings need a native reader.
