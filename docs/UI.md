# TamTam UI — the cheat-sheet

Read this instead of `docs/DESIGN.md` when you build screens. Live reference with every piece in every state:
**`/design-system`** (also `/en/…`, `/ckb/…`; theme, language, currency, density and motion switches at the top).
Component props and examples: `docs/ui/core.md`. When this sheet and DESIGN.md disagree, DESIGN.md wins — tell the
design-system owner.

## 1. The five laws (DESIGN.md §0)

1. **Clay is for the hand.** Anything you press is a key: a face on a wall; pressing moves the face down; "on" stays down.
2. **Glass is for the eye.** Floating chrome (bars, sheets, toasts, the stage price tag). Never a wall, never red.
3. **Light is for the platform.** Platform colour exists only as stage light and a 16×5 LED beside the name in text.
4. **Red is the commit.** One red key per view (the action that moves the order forward), the cart bead, the logo.
   Never prices, badges, links, tabs, selection, errors or "danger".
5. **Flat is for reading.** Floor, niches, fields, prices, tables. Money never bounces or changes colour.

## 2. Components — import each file directly (there is no barrel)

```tsx
import { Key } from "~/ui/Key";            import { Price } from "~/ui/Price";
import { IconKey } from "~/ui/IconKey";    import { Niche } from "~/ui/Niche";
import { KeyBank } from "~/ui/KeyBank";    import { Stage, StageTag, Render } from "~/ui/Stage";
import { Chip, ChipGroup } from "~/ui/Chip";   import { PlatformLabel, PlatformLed, PlatformGlyph } from "~/ui/PlatformLed";
import { Tag, Status, StockStatus } from "~/ui/Tag";   import { TextLink } from "~/ui/TextLink";
import { TextField, TextArea, Select, Checkbox, Radio, Switch, FieldGroup } from "~/ui/Field";
import { Stepper } from "~/ui/Stepper";    import { Glass } from "~/ui/Glass";
import { Socket, AddGlyph, useAddedFlash } from "~/ui/Socket";
import { VisuallyHidden } from "~/ui/VisuallyHidden";   import { cx } from "~/ui/cx";
```

| Need | Use | Not |
|---|---|---|
| The action that moves the order forward | `<Key variant="commit">` — once per view | a second red key, a red link |
| Any other action | `<Key>` (clay), `<Key variant="ink">` (emphasis without red), `<Key variant="quiet">` (bar tools) | `<button className="…">` with your own look |
| Icon-only action | `<IconKey icon label>` (label is required) | an icon without an accessible name |
| A toggle that is on | `held` (aria-pressed; the key stays down, ink face, filled icon) | colour alone |
| One choice from a few | `<KeyBank>` (platforms, gallery thumbnails, segments) or `<ChipGroup>` | radio buttons styled as tabs |
| Several choices / filters | `<Chip selected>`, `<Chip input="checkbox" name>` (no-script forms), `<Chip onRemove>` | facts shaped like chips |
| A fact about a product | `<Tag kind="new" \| "used" \| "preorder" \| "refurbished">` — one per card | a coloured badge, a price in a tag |
| A state | `<Status tone>` / `<StockStatus quantity>` — dot + words | colour alone |
| Text action / navigation | `<TextLink as={LocaleLink} to>` (arrow follows reading direction), `inline` inside paragraphs | a third button style |
| Form input | `TextField`, `TextArea`, `Select`, `Checkbox`, `Radio row` (option rows), `Switch`, `FieldGroup` | borderless inputs, placeholder-as-label |
| Quantity | `<Stepper max maxReason="stock">` (minus at start, plus at end, in every language) | a number input |
| Money | `<Price amountIqd>` (integer IQD; converted line and rate handled) | formatting prices by hand, red prices |
| A product picture in a card | `<Niche tag><Render name alt /></Niche>` | a card with border/shadow, grey skeletons |
| The hero / product picture | `<Stage size gel tag action><Render … priority /></Stage>` | podiums, coloured cards, light on photos |
| Floating chrome | `<Glass>` (live: fixed/sticky only), `variant="static"` over smooth surfaces, `"solid"` | `backdrop-filter` anywhere else |
| The add-to-cart key on a card | `<Socket name state onAdd>` + `useAddedFlash()` | a bare plus |
| Screen-reader-only text | `<VisuallyHidden>` | `display:none` text |

Links that look like keys: `<Key as={LocaleLink} to="/cart">` or `<Key as={MotionLink} nav="zoom" to=…>`; plain
anchors `<Key as="a" href>`. Every key carries `data-press` (press feedback from `<MotionRoot>`, which the layout mounts).

## 3. Tokens (CSS custom properties — `app/styles/tokens.css`)

| Group | Tokens | Tailwind |
|---|---|---|
| Surfaces | `--ground` (floor) `--niche` `--stage` `--well` `--paper` `--glass-solid` | `bg-floor` `bg-niche` `bg-stage` `bg-well` `bg-paper` `bg-glass-solid` |
| Ink | `--ink` `--ink-2` (secondary) `--ink-3` (disabled/decorative only) `--on-glass-2` | `text-ink` `text-ink-2` `text-ink-3` `text-on-glass-2` |
| Lines | `--line` (hairline) `--line-strong` (field borders, 3:1) | `border-line` `border-line-strong` |
| State | `--ok` `--warn` `--info` `--red-ink` (validation, negative amounts) | `text-ok` `text-warn` `text-info` `text-red-ink` |
| Brand red | `--red` — logo only through `text-logo`; keys and the bead are components | `text-logo` (no `bg-logo`) |
| Radius | `--r-xs` 8 `--r-sm` 12 `--r-md` 16 `--r-lg` 20 `--r-xl` 28 `--r-full` | `rounded-xs…xl`, `rounded-key` `-chip` `-field` `-tag` `-niche` `-panel` `-stage` `-sheet`, `rounded-full` |
| Elevation | `--e-1`…`--e-5`, `--e-4-up`, `--well-shadow`, `--glass-rim` | `shadow-e1…e5` `shadow-e4-up` `shadow-wall` `shadow-well` `shadow-rim` |
| Spacing | `--s-1` 4 … `--s-16` 64 (4px grid); `--gutter` 16/24/40; `--gap-card` 12/16/20; `--gap-section` 24/40 | Tailwind spacing is the same 4px grid (`p-4` = 16px); `page`, `gutter`, `gap-card`, `gap-section` |
| z-index | `--z-raised` 1 `--z-sticky` 100 `--z-nav` 200 `--z-scrim` 300 `--z-sheet` 310 `--z-dialog` 400 `--z-toast` 500 `--z-fly` 600 `--z-intro` 700 | `z-(--z-nav)` |
| Motion | `--t-press` 80 … `--t-fly` 460, `--ease-*`, `--spring-*` + `--spring-*-t`; the engine's `--motion-*` (docs/MOTION.md) | — |
| Platform light | `--gel-nintendo/-playstation/-xbox/-handheld/-brand` (RGB triplets) — set a subtree with `data-gel="xbox"` | — (only `.stage__*` and `.led` read them) |
| Misc (ext) | `--target` 44px, `--page-max` 1280, `--safe-top/-bottom/-inline`, `--dir` (±1), `--scrim`, `--selection`, `--price-xl…sm` | `safe-top` `safe-bottom` `safe-x` `hit-44` |

Breakpoints (Tailwind): `sm` 600 · `md` 768 · `lg` 1024 · `xl` 1200 · `2xl` 1280. The default Tailwind palette,
radius, shadow, blur and tracking scales are **removed** — `bg-red-500`, `rounded-2xl`, `shadow-lg`,
`backdrop-blur`, `tracking-wide` do not exist.

### Type roles — one class sets size, weight, line-height and face

| Class | Mobile → desktop (≥1200) | Use |
|---|---|---|
| `type-hero` | Kufam 600 36 → 68 | home/campaign headline, one line |
| `type-title` | Kufam 600 26 → 40 | product and page titles |
| `type-section` | Kufam 600 19 → 26 | section and rail heads |
| `type-sub` | Kufam 600 17 → 20 | sheet titles, spec heads |
| `type-button` | Kufam 600 16 | key labels (keys set it themselves) |
| `type-body` | Plex 400 15/1.7 → 16/1.75 | reading text (the body default) |
| `type-strong` | Plex 600 14.5 → 15 | card names (two lines, never truncated to one) |
| `type-label` | Plex 500 13.5 → 14 | field labels, bank labels |
| `type-caption` | Plex 400 12.5 → 13 | fact lines, help text |
| `type-tab` / `type-tag` | Plex 500 12 / 600 12 | tab labels / tags |
| `type-data` / `type-data-sm` / `type-kpi` | Plex 500 13 / 400 12 / Kufam 700 24 → 28, tabular | admin tables, ledgers, dashboards |
| `nums` | tabular lining figures | every price, counter, quantity, table cell |

Headline roles scale by `--ds` per language (en .91, ckb .94); **Sorani headlines use Plex**, not Kufam (until a
native reader approves Kufam's ە and ڵا). Kufam never below 15px. **No letter-spacing, ever.**

## 4. Rules a reviewer checks (`node scripts/lint-design.mjs`)

- Logical properties only: `ms-/me-/ps-/pe-/start-/end-/text-start/rounded-s-`, `inset-inline-*`, `margin-inline-*`.
  Never `left/right`, `ml-/pr-/left-/text-left`. Directional icons mirror by themselves (`<Icon name="arrow-right">`).
- No hex / `rgb()` / `hsl()` literals outside `tokens.css`. No `letter-spacing`. No CSS `filter`, no SVG filters.
- `backdrop-filter` exists only in `.glass` — use `<Glass>`. At most **two live glass panes per viewport**; live glass
  only on fixed/sticky chrome, never in a list (the dev console warns when a third mounts).
- Motion: only `transform` and `opacity`. No `transition-all/-colors/-shadow`; shadows, blur and colours never animate.
- One `<Key variant="commit">` per route view (socket keys on product cards excepted).
- `--gel-*` only through `<Stage>`, `<PlatformLed>`, `data-gel`. Brand red only through the commit key, bead, logo.
- `<img>` always has `width` and `height` (or use `<Art>` / `<Render>`).
- Escape hatch, with a reason: `// lint-design: allow <rule> — why` (line + next line; first 3 lines = whole file).
- 44×44 minimum target on everything pressable (keys and fields already are). Focus ring is automatic (2.5px ink).
- Latin names and numbers inside Arabic/Kurdish text go in `<bdi>` (keys, chips and banks isolate their labels
  already). Inside a plain string use U+2066…U+2069. Phone numbers, references and amounts stay left-to-right.
- Every user-facing string exists in `ar`, `en` and `ckb`. Component strings live in `app/i18n/messages/ui.ts`
  (`useT("ui")`); add your own `ui-<area>.ts` namespace if a shared component of yours needs some (loaded on every page).

## 5. Themes, density, language

- `<html data-theme="light|dark">` (an inline script resolves "system" before paint). Any subtree can carry its own
  `data-theme`. Tailwind's `dark:` variant follows the attribute, not the media query.
- Switch theme: `themeMorph("dark", buttonEl)` from `~/motion` (updates the prefs cookie + attribute with a cross-fade).
- `data-density="admin"` on a container: compact type, 36px keys and fields, 24px gutter (DESIGN.md §10). `admin:` variant.
  Data grids: `<table className="table">` (`.is-num` cells end-aligned and tabular, `.is-negative` red-ink, selected
  rows `aria-selected`) — `app/styles/admin.css`.
- `lang` drives type: `:lang(en)` scales headlines .91 and body line-height 1.55; `:lang(ckb)` swaps the headline face.
- Direction comes from `<html dir>` only; never force `direction` on names or titles.

## 6. Layers — how to override

`app/app.css` orders the cascade: `theme` (Tailwind theme, then tokens) → `base` (preflight, then base.css) →
`components` (materials.css, components.css, the Motion Engine's classes) → `utilities`. A Tailwind utility in
`className` therefore always beats a component class — use utilities for placement and spacing, never to recolour a
material. Nothing in feature code may be unlayered.

## 7. Performance tiers and preferences (DESIGN.md §6.5, §7.3)

| Signal | Result |
|---|---|
| no `backdrop-filter` support, `prefers-reduced-transparency`, `.fx-low` or `html[data-motion="lite"]` | glass becomes `--glass-solid`; nothing inflates |
| `prefers-reduced-motion` / `data-motion="reduced"` | key travel without transition, instant relight and render swap, no spinner rotation |
| `prefers-contrast: more` | glass and caps outlined in ink, niches and wells outlined, stage light hidden |
| `forced-colors` | key caps get a ButtonText border; held keys a Highlight outline |

## 8. Fonts

Self-hosted in `public/fonts` (content-hashed, cached immutable): Kufam variable (Arabic + Latin) and IBM Plex Sans
Arabic 400/500/600 (Arabic + Latin), split by `unicode-range`: a file is fetched only when the page draws one of its
characters. Measured on `/en/design-system`: only the Latin cuts plus Plex 600 Arabic (for the "العربية / کوردی"
language labels); an Arabic page fetches the Latin cuts for digits and Latin names. `font-display: swap` with
metric-adjusted local fallbacks ("Kufam Fallback", "Plex Fallback") measured against **Segoe UI only** (Android's Noto
Sans Arabic and iOS's SF Arabic were not available to measure — they fall through unadjusted). Shell owners preload the
two critical files: `fontPreloadLinks(LOCALES[locale].script)` from `~/styles/fonts`.

## 9. The /design-system page

Add a section without touching the page: create `app/routes/storefront/content/design-system/sections/<name>.tsx`
exporting `section` (`{ id, order, title: { ar, en, ckb }, owner? }`) and a default component. Use `DsBlock`,
`SpecimenGrid`, `Specimen`, `SpecimenRow`, `defineCopy` / `useCopy` from `../kit`. Core is `order: 0`; take 10, 20, ….
Prices and names on that page are examples and the page says so.

## 10. Known gaps

- Nothing has been measured on a phone; Safari/WebKit and Firefox are untested (Chromium only).
- Fallback-font metrics cover Windows (Segoe UI) only.
- The sprite has no bag-plus symbol: `<AddGlyph>` draws the DESIGN.md bag-plus inline. Platform pictograms are
  inline too (`PlatformGlyph`) — both should move to the icon sprite.
- Not built here (other owners): header, tab bar, sheets/dialog shells, toasts, product card, tables, uploader.
