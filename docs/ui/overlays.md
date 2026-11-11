# Overlays, navigation and states — props and examples

## Design System v2 (2026-11-11) — read this first

Where a section further down disagrees with this one, **this one wins**. Live: `/design-system#overlays`.

- **Sheet** — default `presentation="side"` (a side panel from 768; a bottom sheet on phones); a glass head (grab
  handle, h3, a plain close key), a paper body, `.sheet__foot` for the actions. `presentation="picker"` is the
  governorate / option picker (a dialog from 768).
- **Dialog / ConfirmDialog** — opaque paper, max 440px; ConfirmDialog `variant`: primary · danger · secondary. **Menu**
  is opaque (no glass).
- **Toast** — opaque paper card: a 48px thumb (cart) or a filled kind icon, the title, one line, actions (cart:
  «عرض السلة» + «تراجع»), always a close key. Phones: above the bottom bar (`--shell-bottom`); from 1024: top-end,
  380px wide, under the header (`--toaster-top`). Swipe away in either vertical direction.
- **Tabs** — a 2px ink underline, 13px labels. **Disclosure** — the panel variant is a hairline `panel`.
- **Breadcrumbs** — from 768 only; more than four items collapse the middle into «…» (a button); JSON-LD stays.
- **ProgressSteps** — numbered discs (done = ink + check, current = red); more than three steps show only the current
  label on phones; `variant="compact"` for the checkout bar.
- **EmptyState** — `layout="stack"` (the mascot in a red-tint disc, or `art` in a 132px well, or an icon; h2; text;
  `actions` + a quiet `recovery` link; optional `shelf`) or `"row"` (inline in a page). Never «دورك.»-style jokes.
- **ErrorState** — `layout` row | stack, `code`, `offline` (or the browser is offline) → «لا يوجد اتصال بالإنترنت» +
  wifi-slash; never "500". **OfflineBanner** — a warn-tint strip, `message="form"` for forms, a green "back" state.
- **Callout** (Blocks) — paper panel with a 3px inline-start bar in the tone colour.

Owner: design system (overlays). Files: `app/ui/{Sheet,Dialog,Menu,Toast,toast-store,Tabs,Disclosure,Accordion,Rail,
Breadcrumbs,Pagination,ProgressSteps,EmptyState,ErrorState,OfflineBanner,Blocks,DataTable}.tsx`, strings in
`app/i18n/messages/ui-overlays.ts` (`useT("ui-overlays")`, loaded on every page). Rules and tokens: `docs/UI.md`;
spec: `docs/DESIGN.md` §6, §7.2, §9.13–9.17, §10, §11. Live: **`/design-system#overlays`** (every piece open-able, in
both themes and all three languages). Import each file directly — there is no barrel.

Everything here is SSR-safe (overlays render nothing on the server and mount after hydration), uses logical
properties only, has 44px targets (36px rows in admin density on a mouse), a visible focus ring, works in light and
dark, and honours reduced motion, reduced transparency and the low-end tier (glass turns solid; see UI.md §7).

---

## The modal layer (shared by Sheet and Dialog) — `~/ui/Dialog`

Every sheet and dialog is one **modal layer**: a portal at the end of `<body>`, pushed on one stack.

| | |
|---|---|
| Focus | moves in (`initialFocus`, else `[autofocus]`, else the panel), is trapped (Tab / Shift+Tab wrap; roving `tabindex="-1"` items are skipped), and returns to the opener when the layer closes (Safari: the last pressed element) |
| Close | Escape (top layer only), the scrim, the close key, and **Android's back button / gesture** (Chromium `CloseWatcher`; elsewhere nothing). A layer that is not dismissible (a request in flight) ignores all of them and listens again |
| The page behind | `inert` (every other `<body>` child except the toaster), no scroll — without a layout shift (a classic scrollbar's gutter stays reserved). The page itself (not other overlays) is also marked `data-layer-behind`: its live glass — header after scroll, tab bar, task or buy bar — turns solid while the layer is open, so the layer's glass strip is the live pane under the scrim (two per viewport, DESIGN.md §6.2; a sheet under a dialog keeps its strip) |
| Surface | the layer takes the **density and theme island of its opener** (`data-density="admin"` on the admin shell → admin-dense dialogs) |
| Stacking | a dialog over a sheet works (only the top answers keys); menus opened inside a layer render into it |

Exports for other overlay builders: `useModalLayer`, `useOverlayRoot(keep?, enabled?)`, `OverlayHostContext`,
`useOverlayDepth()` (open layers), `usePresence`, `fadeElement`, `focusablesIn(container)`, `inheritSurface`,
`watchCloseRequests(onClose)`, `usePrimeLayers()`, `LAYER_BEHIND` (the attribute name).

## Sheet — `~/ui/Sheet`

Bottom-anchored on phones; a glass header strip (grab handle, title, one line, round clay close key) over an opaque
`--ground` body that scrolls inside; at most 90% of the viewport. Motion is the engine's `useSheet`: it rises on the
`sheet` spring, follows the finger 1:1 when the header is dragged, keeps the finger's velocity, rubber-bands, snaps.

| Prop | Type | Default | |
|---|---|---|---|
| `open`, `onClose` | `boolean`, `() => void` | — | `open` is the state; it springs away and unmounts after it turns false. A drag/flick past the lowest snap calls `onClose` |
| `title` | `ReactNode` | — | h2 in the strip |
| `description` | `ReactNode` | — | one line under the title (result count, the fee rule) |
| `footer` | `ReactNode` | — | at most two keys, pinned under the body ("امسح الكل" / "اعرض 24 منتجاً" — not red) |
| `presentation` | `"sheet" \| "side" \| "picker"` | `"sheet"` | `side`: a 420px side panel from the inline-end edge from `sideFrom` (cart, filters); `picker`: a centred dialog from 768 (governorate, variant, reason codes) |
| `sideFrom` | `number` | `768` | pass `1024` where a screen asks for a later switch |
| `snapPoints`, `initialSnap` | `number[]`, `number` | `[1]`, most open | bottom sheets only; the grab handle becomes a key that toggles between the lowest and highest |
| `initialFocus` | ref or `() => HTMLElement` | the sheet | |
| `flush` | `boolean` | `false` | no body padding (full-bleed rows) |

```tsx
const [open, setOpen] = useState(false);
<Key aria-haspopup="dialog" onClick={() => setOpen(true)}>{t("governorate")}</Key>
<Sheet open={open} onClose={() => setOpen(false)} title={t("chooseGovernorate")} description={t("feeRule")} presentation="picker" flush>
  {governorates.map((g) => <Radio key={g.id} name="gov" value={g.id} label={g.name} end={<Price amountIqd={fee} size="sm" as="span" approx="off" />} … />)}
</Sheet>

<Sheet open={filters} onClose={close} title={t("filters")} description={t("results", { count })} presentation="side" snapPoints={[0.5, 1]}
       footer={<><Key onClick={clear}>{t("clearAll")}</Key><Key variant="ink" onClick={close}>{t("show", { count })}</Key></>}>…</Sheet>
```

## Dialog, ConfirmDialog — `~/ui/Dialog`

Centred, ≤ 420 wide (520 from 768), `--r-xl`, opaque paper, a scrim, an optional glass header strip. Drops in with 8px
of travel and opacity; reduced motion fades.

`<Dialog open onClose title description? footer? header="plain"|"glass" role="dialog"|"alertdialog" initialFocus?
dismissible? scrimDismiss? closeKey? onSubmit? className? bodyClassName?>` — `onSubmit` renders the panel as a
`<form noValidate>`; put the submit key in `footer`.

**ConfirmDialog** — the confirmation, including the admin's destructive-with-reason:

| Prop | Type | |
|---|---|---|
| `title` | `ReactNode` | the question ("احذف العنوان؟") |
| `consequence` | `ReactNode` | one sentence, what will happen (`aria-describedby`) |
| `confirmLabel` | `string` | the same words as the action that opened it ("احذف العنوان") — never "موافق" |
| `cancelLabel` | `string` | default "ارجع" |
| `tone` | `"neutral" \| "destructive" \| "commit"` | destructive = neutral key with a red-ink label, `role="alertdialog"`, focus starts on the cancel key; commit = the red key, only when the dialog confirms an order step |
| `impact` | `ImpactRow[] \| ReactNode` | the stock or money it changes, shown before confirming (`{ label, value, negative? }`) |
| `reason` | `true \| { codes?, codeLabel?, noteRequired?, minLength? (3), maxLength? (500), label?, hint? }` | `true`: a typed reason is required; `codes`: a mandatory reason code (native select) plus a note (required with `noteRequired`) |
| `pending` | `boolean` | the request is in flight: the key spins, nothing closes it |
| `error` | `ReactNode` | what went wrong, red-ink, `role="alert"` |
| `onConfirm` | `({ reason, code }) => void` | only with valid input; it stays open — close it when the request succeeded |

```tsx
<ConfirmDialog open={open} onClose={close} tone="destructive"
  title={t("rejectQ")} consequence={t("rejectWhat", { ref })} confirmLabel={t("reject")}
  impact={[{ label: t("orderStatus"), value: t("awaitingPayment") }, { label: t("held"), value: <Price amountIqd={due} size="sm" as="span" approx="off" /> }]}
  reason={{ codes: REJECT_CODES, noteRequired: true, minLength: 10, hint: t("whatToFix") }}
  pending={fetcher.state !== "idle"} error={fetcher.data?.error}
  onConfirm={({ code, reason }) => fetcher.submit({ intent: "reject", code, reason }, { method: "post" })} />
```

Empty or short input is refused with field errors (and focus on the first bad field); the services validate again.

## Menu — `~/ui/Menu`

A list of actions anchored to the key that opened it: below it, start edges aligned (`align="end"`: end edges), above
it when there is more room there, 8px inside the viewport, following it on scroll. Glass (solid inside a layer).
Drops from the trigger (`materialize`), leaves the same way.

| Prop | Type | |
|---|---|---|
| `label` | `string` | names the menu and the default "⋯" trigger |
| `items` | `MenuItem[]` | `{ id, label, icon?, hint?, tone?: "danger", disabled?, onSelect }` (action) · `{ kind: "link", href, external? }` · `{ kind: "checkbox", checked, onCheckedChange }` (stays open) · `{ kind: "radio", checked, onSelect }` · `{ kind: "separator", id }` |
| `trigger` | `(props: MenuTriggerProps) => ReactNode` | spread the props on your key |
| `align` | `"start" \| "end"` | |
| `title` | `ReactNode` | a caption above the rows |
| `open`, `onOpenChange` | | optional control |

Keyboard (WAI-ARIA menu button): Enter / Space / ↓ open on the first row, ↑ on the last; a pointer opens it with focus
on the menu. ↑ ↓ Home End move (focus follows the pointer too), typing jumps to the next row starting with the letters
(Arabic and Sorani too), Escape closes and returns focus, Tab closes and moves on, a press outside or Android's back
closes it. Choosing an action closes it, returns focus to the trigger, then runs `onSelect` — so a dialog it opens
returns focus to the trigger. Danger rows are red-ink words and should open a ConfirmDialog.

```tsx
<Menu label={t("orderActions")} items={[
  { id: "edit", label: t("edit"), icon: "pencil-simple", onSelect: edit },
  { id: "s1", kind: "separator" },
  { id: "cancel", label: t("cancelOrder"), icon: "x-circle", tone: "danger", onSelect: () => setConfirm(true) },
]} />
<Menu label={t("sortBy")} title={t("sortBy")} align="end" trigger={(p) => <Key {...p} iconEnd="caret-down">{current}</Key>}
      items={SORTS.map((s) => ({ id: s, kind: "radio", label: t(s), checked: sort === s, onSelect: () => setSort(s) }))} />
```

## Toasts — `~/ui/toast-store` and `~/ui/Toast`

```ts
import { toast } from "~/ui/toast-store";
toast.info(t("copied"));                                   // also .success · .warning · .error(text, opts)
toast.error(t("notSaved"), { detail: t("checkConnection"), action: { label: t("retry"), onAction: save } });
toast.success(t("saved"), { art: "nintendo-switch-2--1" }); // any kind may carry a thumbnail (art key or image)
toast.cart({ name: "Xbox Series X", variant: "1TB", art: "xbox-series-x--1", onUndo: () => removeLine(id) });
const id = toast.info(t("x"), { duration: Infinity }); toast.dismiss(id); toast.dismiss();   // one / all
showToast({ tone: "success", title, detail, image: imageRef, action });                     // data form (cart-client)
```

`opts`: `{ id?, detail?, action?: { label, onAction?, href? }, duration? (4000), art?, image? }`. The same `id` updates
in place (a cart toast's id defaults to `"cart"`: rapid adds refresh one toast); the update is announced again.

The store: one toast on screen; a new one replaces it unless it is less important (error > warning > info · success ·
cart), then it waits; at most 3 wait (oldest dropped). It leaves after 4 s, counted only while a toaster shows it and
nothing holds it (pointer over it, focus in it, a drag, a hidden tab). Server calls are no-ops. `createToastStore({
limit, duration, timers })` makes an isolated store (tests).

`<Toaster offset? fallback? className? />` — mount once in a layout, under the header (`offset`). Only one renders: the
first regular one, else a `fallback` one (a page that may or may not sit in a shell, e.g. `/design-system`).
Live glass, `--r-md`, ≥ 60px: thumbnail niche or the kind's icon, a bold line, a secondary line, ONE small clay key
(undo, an action, a link) or a close key. Announced through two live regions present from the start (polite; errors
assertive). F6 moves focus to the toast's key (Escape dismisses it and returns focus). Swipe sideways or up to dismiss.
Above an open sheet or dialog it turns solid (two live glass panes at most) and stays usable (not inert).
Anything that needs a decision is not a toast.

## Tabs — `~/ui/Tabs`

Flat (tabs navigate, they do not commit): the label turns ink and 600, an ink marker sits on the bottom edge; labels
reserve their bold width; long rows scroll sideways.

`<Tabs items value? defaultValue? onChange? aria-label activation="auto"|"manual" keepMounted? className listClassName panelClassName />`
with `items: { value, label, count?, disabled?, href?, content? }[]`.

- **Link tabs** (every item has `href`, a path or `"?tab=…"`): a `<nav>` of links, `aria-current="page"`, scroll kept
  for query links. The route's handle `{ nav: "push", order }` gives the sideways push (docs/MOTION.md).
- **Panel tabs** (`content`): WAI-ARIA tabs — one tab stop, ← → follow the reading direction, Home / End, selection
  follows focus (or Enter / Space with `activation="manual"`). The new panel slides 24px in from the chosen side.

## Disclosure, Accordion — `~/ui/Disclosure`, `~/ui/Accordion`

Native `<details>`: works before JavaScript, find-in-page opens it, `aria-expanded` for free.

`<Disclosure summary children defaultOpen? open? onOpenChange? name? icon? variant="row"|"panel" />` — `name` groups
them (one open at a time, native). The caret turns over; the content fades in 4px; height never animates.
`<Accordion items={[{ id, summary, content, icon? }]} exclusive? defaultOpen={["id"]} />` — rows between hairlines.

## Rail — `~/ui/Rail`

`<Rail aria-label | aria-labelledby keys? (true) fade="ground"|"paper"|"niche"|false itemClassName? tilt? className railClassName>{items}</Rail>`
— native scroll-snap with the platform's momentum (the engine's `useRail`), one tab stop with ← → (mirrored in RTL),
Page Up/Down, Home/End; step keys from 1024px that hide at their end; an edge fade in the colour of the surface
behind (IntersectionObserver, no scroll listener). Never glass. Each child is one `<li>` sized by `itemClassName`
(default two and a peek on a phone, about six on a desktop).

## Breadcrumbs — `~/ui/Breadcrumbs`

`<Breadcrumbs items={[{ label, href? }]} jsonLd={{ origin }}? />` — carets that point along the reading direction
(they flip in RTL), the last item is the current page (`aria-current`, not a link), one line that starts scrolled to
the current page on a phone. `jsonLd` adds a schema.org `BreadcrumbList` with absolute URLs in the page's language
(`breadcrumbJsonLd(items, origin, locale)`; `<`, `>`, `&`, U+2028/9 escaped).

## Pagination, ShowMore, HrefLink — `~/ui/Pagination`

- ``<Pagination page pageCount href={(n) => `?page=${n}`} | onPage siblings? />`` — round prev / next keys, numbers as
  small keys with the current one held (`aria-current="page"`), "…" gaps, a constant number of slots
  (`pageWindow(page, count, siblings, boundary)`); phones show "الصفحة 3 من 12" between the arrows. Nothing for one page.
- `<ShowMore shown total? href | onMore loading? label? />` — "عرضنا 24 من 120" (announced), a flat progress line,
  "اعرض المزيد"; when all are shown it says "عرضنا كل النتائج (120)." and the key goes.
- `<HrefLink to>` — a locale-less path through `LocaleLink`, or a same-page `?query` / `#hash` through react-router's
  `Link` (keeps the path and the scroll). `LocaleLink` alone would turn `?page=2` into `/?page=2`.

## ProgressSteps — `~/ui/ProgressSteps`

`<ProgressSteps steps={[{ label, href? }]} current={1} aria-label? />` — numbered discs joined by a line: done = ink
disc with a check (a link back with `href`), current = ink ring + bold label (`aria-current="step"`), upcoming =
line-strong ring + ink-2 label. Equal columns; five steps fit 360px; labels never break inside a word.

## EmptyState, ErrorState, OfflineBanner

- `<EmptyState title text? action? icon? layout="row"|"stack" headingLevel? />` — a flat niche panel with an empty
  socket (or an icon in it), one sentence, ONE key that says where to go. The "دورك." voice belongs here (§11).
- `<ErrorState title? text? onRetry | retryHref retrying? retryLabel? code? minHeight? alert? />` — keeps the space,
  says what failed (defaults "تعذّر تحميل هذا الجزء." / "تحقّق من الاتصال، ثم أعد المحاولة."), a retry key, an
  error reference left-to-right. Never animates, never pretends to load. A failed *action* is not this: roll back and
  put a sentence beside the control.
- `<OfflineBanner message="store"|"generic"|node offset? pinned? state? />` — a flat ink banner under the header
  ("لا يوجد اتصال. سلتك محفوظة على هذا الجهاز."), "عاد الاتصال." for 3 s when it returns; a polite live region that
  exists from the start. `useOnline()` for keys that need the network (flat + the reason beside them). Server and
  hydration assume online. `navigator.onLine` only knows the device's link — failed requests still say so in place.

## Blocks — `~/ui/Blocks`

`<Blocks blocks headingLevel={2} artSizes? />` renders structured content — the demo seed's exact shapes
(`app/server/db/seed/demo/blocks.ts`):

```ts
type Block =
  | { type: "h2" | "p"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "steps"; items: { title: string; text?: string }[] }
  | { type: "callout"; tone: "info" | "warning" | "danger"; title?: string; text: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "art"; name: string; alt: string };
```

Strings only ever become text nodes — no `dangerouslySetInnerHTML`, no markup or links inside strings — so staff
content is safe by construction. Data from the database goes through `parseBlocks(value)` / `toBlock(value)`:
malformed or unknown blocks are dropped (the renderer does it too). Callouts are flat panels, never dismissible: info
(info icon, `--info`), warning (warning icon, `--warn` heading), danger (`--red-ink` heading — never brand red); the
icon is named with the tone's word, so the tone is not colour alone. Art blocks render `<Art>` in a 16:9 niche.

## DataTable — `~/ui/DataTable`

The dense admin table on `.table` (admin.css): flat paper, hairlines, sticky solid header, tabular end-aligned
numbers. **Controlled only** — sort, page and selection live in the URL and belong to the caller.

| Prop | Type | |
|---|---|---|
| `caption` | `string` | visually hidden `<caption>`; names the scroll region |
| `columns` | `DataColumn<Row>[]` | `{ key, header, cell(row, i), numeric?, negative?(row), sortable?, firstDir?, width?, className? }` |
| `rows`, `rowKey`, `rowLabel?` | | `rowLabel` names the row checkbox ("اختر TT-7K4M…") |
| `sort`, `sortHref` \| `onSort` | `{ key, dir }` | sortable headers are links (URL state) or buttons; `aria-sort` on the sorted one |
| `selected`, `onSelectedChange` | `string[]` | turns selection on: row boxes, a page box (mixed state), Shift-click ranges (`toggleRange`, `toggleAllOnPage`, `pageSelection`) |
| `bulkActions` | `(ids) => ReactNode` | keys for the glass bulk bar that rises when rows are selected (count, your keys, "ألغِ التحديد"); destructive bulk actions open a reason-code ConfirmDialog |
| `status` | `"ready" \| "loading" \| "error"` | loading and error rows; no rows → `empty` |
| `busy` | `boolean` | rows shown, a newer page loading: dimmed, `aria-busy` |
| `empty`, `error`, `footer` | `ReactNode` | `footer` for `<Pagination>` |
| `maxHeight` | `string \| null` | `"min(70dvh, 720px)"`: the region scrolls so the header sticks |
| `pinFirst` | `boolean` | `true`: the first column (and the checkboxes) stay while it scrolls sideways |
| `density` | `"admin" \| "inherit"` | `admin` sets `data-density="admin"` |

Protected columns (cost, margin) are left out of `columns` **and** the loader for actors without the permission — never
rendered empty (CONTRACTS §4).

---

## Verifying

- `npm test -- tests/ui-overlays.test.ts` — toast store (queue, importance, clock, holds), the payload adapter, menu
  placement and typeahead (Arabic and Sorani too), the pagination window, table selection, the Blocks parser against
  every block of every demo article in ar/en/ckb, breadcrumb JSON-LD escaping.
- In a browser (Chromium, headless, against the dev server): focus in/trapped/returned, Escape and Android back
  (`CloseWatcher.requestClose()`), inert page and scroll lock, admin density inherited, empty reason refused,
  sheet snap and drag-to-dismiss (normal and reduced motion), menu keyboard/typeahead/placement/outside press, toast
  importance, queue and 4 s clock, tab arrows in RTL, table range selection, page box and sort — in ar, ckb (390) and
  en (1440). Screenshots of every open state at 390 and 1440 in both themes.
- `node scripts/lint-design.mjs` — no findings in these files.

## Not done / limits

- Verified in Chromium only (no Safari, Firefox or real phones). `CloseWatcher` exists only in Chromium; elsewhere
  the Android-style back does not close overlays (iOS has no back button; Escape works everywhere).
- Dialogs and sheets are portals with an ARIA dialog role, not native `<dialog>`; the focus trap and `inert` are
  ours. The page's own scroll lock uses `overflow: hidden` on `<html>` (iOS Safari before 16 may still rubber-band).
- Toast swipe is pointer-based; not tried on a real touch screen.
- The Sorani strings need a native reader (as everywhere).
