# TamTam UI — the cheat-sheet (Design System v2 + v2.1 «Clay & Glass»)

Read this instead of `docs/DESIGN.md` when you build screens. Live reference with every piece in every state:
**`/design-system`** (also `/en/…`, `/ckb/…`; theme, language, currency, density and motion switches at the top).
Component props and examples: `docs/ui/core.md`, `docs/ui/commerce.md`, `docs/ui/overlays.md`. When this sheet and
DESIGN.md disagree, DESIGN.md wins — tell the design-system owner.

## 1. The ten principles (DESIGN.md §0), short

1. **Red and white is the brand; the four platform colours are the doors.** Everything else is warm white, graphite, hairlines.
2. **The product is the most real thing on screen:** official photos on one neutral ground, one floor line, no tilt, no coloured light behind it.
3. **One red primary per view.** Ink fill means *selected*, never *action*.
4. **v2.1: every key is clay** — a raised face on a 2px wall (glossy red primary, white-to-cream secondary, clay chips,
   44px clay icon circles, the quantity tray). Ghost keys and data stay flat.
5. **v2.1: glass on bars AND panels** (sheets, menus, the mega menu, floating tags, carousel controls); dialogs and toasts
   stay opaque; repeated cards are faux glass in dark (no blur).
6. **Colour light belongs to showcases** (hero, tiles, platform bands) and, v2.1, to the ambient `.glow` behind them;
   platform tiles stay vivid glossy colour in BOTH themes (never a grey cabinet).
7. **Facts sit beside the price** (stock, 5,000 IQD delivery, payment, returns, guest checkout). Nothing invented.
8. **Arabic first:** a 13px floor, integer sizes, Latin names isolated, layouts that mirror by logic.
9. **Motion is the existing engine;** nothing waits for an animation, nothing moves at rest.
10. **One system:** every value is a token; every component exists once.

## 0. Design v2.1 «Clay & Glass» — what to use (2026-11-12, DESIGN.md §15)

The client compared the redesign with the store before it and asked for the before's font, its tactile keys, softer
cards, bolder icons, calmer notes, glass that looks like glass, and some motion. The kit does most of it by itself
(every page got it without page work); the pieces below are what page owners add.

| Need | Use | Notes |
|---|---|---|
| Side information (a payment rule, «أكمل الطلب بدون حساب», a demo order line, «قبل أن تطلب») | `<Note title icon tone action>` from `~/ui/Note` | neutral soft card, icon in a circle, short bold title, muted 16px text, action on its own line; `tone` info · success · warning · demo tints only the circle; `variant="line"` (no card) · `"flat"` (inside a card). Replaces bold side paragraphs and tinted callouts with inline links. Renders a `<div>` (an unnamed `<aside>` would be one complementary landmark per note); `as="aside"` + `aria-label` only for a page's one real side panel |
| Several banners that switch (the home hero) | `<Carousel label slides autoplay={6000} aspect="390 / 220">` or `useCarousel()` + `CarouselDots` / `CarouselArrows` / `CarouselPlay` from `~/ui/Carousel` | native scroll-snap; autoplay PAUSES on hover, focus, a finger on the track, a hidden tab, off screen, and STOPS when the shopper takes over (a swipe that moves the track, a sideways trackpad swipe, an arrow, a dot) — a vertical page scroll that starts on the banner is not a take-over; the pause key is there while it can play (WCAG 2.2.2) and play starts it even with focus inside; spread all of `trackProps` on your track (it carries the touch, scroll and wheel handlers); ← → follow the reading direction; reduced motion: no autoplay, instant moves. `aspect` sets `--carousel-aspect` (one property for the banner's shape); `peek` shows the next slide's edge; `controls="over"` puts frosted keys on the slide; `.carousel__parallax` on an element in a slide drifts it a little |
| A section that fades up as it arrives | `<Reveal as="section">` / `<Reveal stagger>` / `{...revealProps()}` from `~/ui/reveal` (or `data-reveal` / `data-reveal="stagger"`) | below the fold only, once, 16px + fade, 60ms stagger (six steps); Web Animations — no attribute is written, so no hydration mismatch; skipped under reduced motion, the lite tier and automation. Never on the hero or a form |
| A number that matters, counted once (points, an offer, a KPI) | `<CountUp value format={f.number} />` from `~/motion` | reserves the final width; SR reads the final text; a server-rendered number already on screen is not reset (no flash); one below the fold waits at its start out of sight and counts when 40% of it is in view. A value that CHANGES is `<NumberMorph>` |
| A success that draws itself (order placed, offer accepted) | `<SuccessMark size={72} label? />` from `~/ui/SuccessMark` | ok-tint disc inflates, the check strokes in once; reduced motion: finished |
| Ambient colour light behind a hero / stage / tiles | `className="glow"` (brand red) · inside `data-gel="playstation"` the platform's light · any colour with `--glow-rgb` (an "r g b" triplet, e.g. `var(--gel-xbox)`) · `glow--strong` · `glow--wide` · `style={{"--glow-x":"30%","--glow-y":"40%"}}` · or an element `<span className="glow-layer" aria-hidden />` | a `::before` radial, painted once, hidden under `prefers-contrast: more`; keep the element's own background transparent where the light should show |
| Soft raised card / real glass | `className="surface"` (light: paper + warm shadow; dark: see-through faux glass over the floor's light) · `"surface--quiet"` (no shadow) · `"surface--glass"` (frosted, rim-lit; heroes and ≤8 tiles per screen) · `"lift"` (hover lift with the shadow layer; isolates itself) | `.panel` and `.niche--panel` ARE the soft card now. Keep a dark section's own background transparent where the floor's light should show through its cards |
| A frosted panel | `<Glass panel>` or `className="glass glass--panel"` | menus and sheets use it by themselves (`Menu`, `Sheet`) |
| A clay disc for an icon that is not a button | `<span className="clay-disc"><Icon … /></span>` (`--disc` sets the size, 44 default) | the before's raised circles |
| Device pictures for the four platforms | `<Icon name="device-nintendo|device-playstation|device-xbox|device-handheld" />` | neutral silhouettes, never logos |
| Catalogue kinds | `<Icon name="kind-console|kind-game|kind-controller|kind-headset|kind-storage|kind-charging|kind-topup|kind-accessory|kind-used|kind-repair" />`; `<CategoryTile icon="kind-controller" …>` for the reference's icon tiles | 2px strokes on a 24 grid |
| The before's support rows (icon disc · words · arrow) | `<EntryCard icon="lifebuoy" title text to>` | without `art` |
| The platform colour line (above a product's name, a card's kind line) | `<PlatformLed bar />`, `<PlatformLabel platform bar />` | the card's kind line draws it already |
| Breadcrumbs on phones too (the product page's bar) | `<Breadcrumbs items phone />` | one scrolling line |
| The before's empty cart arrangement | `<EmptyState layout="stack" panel …>` | words, then the key, then the recovery link under it (the stack does that by itself now) |
| Reading text (facts, notes, descriptions) | `type-read` (16px / 1.75 Arabic, 1.6 English) | `.fact__text`, `.entry__text`, `.note__text` use it. The utility class exists since the fix round (2026-11-13); before, `className="type-read"` silently did nothing |

**Fix round (2026-11-13, DESIGN.md §15.10) — new props and what they replace:**

| Need | Use | Replaces |
|---|---|---|
| The carousel's own progress look and state | `useCarousel()` → `running`, `autoplay`; `<CarouselDots api progress />`; `CarouselArrows` / `CarouselPlay` `size="md"` (default 44px) · `"sm"` | the home hero's mirror of `carouselHold` and its local dot fill; its `scroll-snap-stop: normal` override (moves further than one slide now fade and jump) |
| Section tabs at the before's size; a page inside a tab's part of the site | `<Tabs size="lg" />` (16px, 48px row) · `<Tabs section />` (`aria-current="true"`) | support's local padding and its "page" for guides and tickets |
| A discount's parts in its place; a waived delivery said under «التوصيل» | `<OrderSummary discountParts={[{ key, icon, label, amountIqd }]} shippingNote={…}>{split parts}</OrderSummary>` | the discount lines that `<Adjustments>` drew after the total |
| A long key label; a task bar's compact key | `<Key wrap>` · `<Key fit="compact">` | content's local wrapping; used's `.used-keys` |
| A danger note | `<Note tone="danger" title>` | support's `.sup-safety-note--danger` |
| A chip with a kind or device icon | `<Chip icon="kind-controller">` (also `ChipGroup` options' `icon`) | catalog's hand-drawn chip icons |
| The empty card across its column; a bold stack icon | `<EmptyState layout="stack" panel wide icon>` (44px icon) | checkout's `.co-empty > .empty--panel` widening |
| The before's labelled step rail; an order's stages with icons | `<ProgressSteps labels="under" />` · `<ProgressSteps variant="status" steps={[{ label, icon }]} />` | used's `.used-rail`; the order pages' `.co-progress` / `.co-stages` |
| A state in a tinted pill | `<Status tone pill>` | account's `.acct-pill` |
| The glossy wallet card | `<Band kind="wallet" gloss>` | account's `.band--wallet.acct-money` gloss |
| An option card with a clay face and an icon; a checkbox row | `<OptionCard clay icon="wallet" …>` · `<Checkbox row hint …>` | used's `surface` + `PayIcon`, `.used-check` |
| A figure that counts once — also on a direct open | `<Price countUp>` / `countUp="load"`; `<CountUp playOnLoad>` | used's hand-composed `.price__num` count; the offer and the rewards balance that never counted when opened from a link |
| Items that stagger in | `<Rail reveal>`, `<PlatformTiles reveal>`, `<CategoryTiles reveal>`; late cards of any `data-reveal="stagger"` row (show more, a filter change) arrive as a batch by themselves | — |

**Automatic (no page work):** Kufam headings, prices and key labels; clay keys, chips, icon circles and the tray;
soft cards (ProductCard, UsedUnitCard, EntryCard, CategoryTile, TrustStrip, FactList, OrderSummary, InspectionCard,
ContactCard, CompatList) with the hover lift and photo zoom on fine pointers; vivid platform tiles and hub bands in dark;
frosted menus and sheets; bolder icons; the sliding thumb of `Segmented` and the sliding underline of `Tabs`; the
`Disclosure` / `Accordion` height animation; the deep crimson glass hero band in dark; the dark floor's ambient light
(`body::before`, `--floor-light`) behind see-through dark cards; product-card feet that keep price and add key on one
row on 360–414 phones.

## 2. Components and their classes

Import each kit file directly (there is no barrel): `import { Key } from "~/ui/Key";` … The React components are the
API; the classes below (in `app/styles/materials.css` and `components.css`) are their implementation — feature code
uses the components, kit code uses the classes.

| Need | Component (today) | Classes (v2) | Not |
|---|---|---|---|
| The ONE action per view that moves the shopper forward | `<Key variant="primary">` (1.0 alias `commit`) | `.key.key--primary` (alias `.key--red`) > `.key__cap` > `.key__label` | a second red key, a red link |
| Any other action, toolbar buttons | `<Key>` (secondary, the default; 1.0 `ink` renders secondary) | `.key` / `.key--secondary` | `<button className>` with your own look |
| Quiet actions in bars and lists | `<Key variant="ghost">` (1.0 `quiet`) | `.key--ghost` | |
| The action on the crimson hero / wallet band | `<Key variant="onBand">` (kit adds it) | `.key--on-band` (v2.1: white clay in both themes, on the band's own deep-coloured wall) | a red key on crimson |
| Destructive confirmations | `<Key variant="danger">` (kit adds it) | `.key--danger` | brand red |
| Sizes | `size="md"` 48 · `"sm"` 40 (`"lg"` = 48) | `.key--sm`, `.key--block` | a third height |
| Icon-only action | `<IconKey icon label>` | `.key.key--round` (v2.1: a 44px clay circle; `--sm` 36, `--xs` 32 on photos) + `.key--outline` (default, clay) / `--plain` / `--on-image` (frosted disc) / `--on-color`; heart `.key--wish` | an unnamed icon |
| The card add button | `<Socket>` today (kit: `CardAddButton`) | `.key.key--round.cadd` (neutral; red under the pointer; `data-state="added"` = ok check) | a red key on every card |
| A toggle that is on | `held` (aria-pressed) | ink fill on keys/chips; icon buttons keep their face and fill the glyph | colour alone |
| One choice from a few | `<ChipGroup>`, `Segmented` (kit), `<KeyBank>` (renders segmented) | `.seg` > `.seg__opt[aria-checked]`; `.bank` (1.0) | radio buttons styled as tabs |
| Several choices / filters | `<Chip selected>`, `<Chip input name>`, `<Chip onRemove>` | `.key.key--chip` (+ `.key__mark` check, `.key__count`); rows `.chips`, `.chips--rail`, `.chips--bleed` | facts shaped like chips |
| A fact about a product (one per card) | `<Tag kind>` | `.tag` + `--new` (`--solid`), `--soon`, `--sale`, `--grade` (`--outline`), `--out`, `--demo`, `--photo`, `--on-color`, `--ok` | a coloured price shout |
| A state | `<Status tone>`, `<StockStatus>` | `.status` + `--ok` `--warn` `--info` `--bad` `--out` `--soon`; `--lg` | colour alone |
| Demo marking | `<DemoNote>` | `.demo-strip`, `.demo-chip`, `.tag--demo`, `.demo-line` | anything louder |
| Text action / navigation | `<TextLink>` | `.link` > `.link__text` + arrow; `.link--inline`, `.link--danger` | a third button style |
| Form input | `TextField` `TextArea` `Select` `Checkbox` `Radio` (`row` = OptionCard) `Switch` `FieldGroup` | `.field` `.field__label` `.field__input` `.field__hint` `.field__error`; `.choice` `.choice--radio` `.choice--row` (`--pay`) `.choice--switch` `.switch__track`; `.form-alert`; `.pref`/`.pref__cell`; `.swatches`/`.swatch`; `.listrow` (52px) | borderless inputs, placeholder-as-label |
| Quantity | `<Stepper>` | `.stepper` (+ `--sm`) `.stepper__value` | a number input |
| Money | `<Price amountIqd>` | `.price` + `--xl/--lg/--md/--sm`, tones `--sale` `--total` `--on-color` `--muted`; `.price__amount` (figure + `.price__cur`, one unbreakable unit), `.price__was`, `.price-line` (`__item`: a « · » with what follows it) | formatting prices by hand |
| A product in a card | `<ProductCard>` / `<Niche>` | `.cards` (`--4`, `--5`) > `.pcard[data-state]` > `.niche[data-kind]` + `.pcard__body` `__kind` `__title` > `.pcard__link` · `__meta` `__foot` `__status`; `.pcard--row` | a card with border or shadow, skeletons |
| The product stage | `<Stage>` (1.0, being rebuilt) | `.stage.stage--pdp` (1:1 → 4:3 → 5:4) + `.stage__count`, `.stage__tools`; thumbnails `.thumbs` > `.thumb[aria-checked]` | tilt, halo, glass tag |
| Showcase bands | `Band` (kit adds it) | `.band.band--hero|--platform|--device|--wallet[data-gel]` > `.band__light` (+ `.band__contact`) | text on the light core |
| Platform tiles | `PlatformTile(s)` (kit adds them) | `.ptiles` > `a.ptile[data-gel]` > `.ptile__cap` > `.ptile__light`, `.ptile__text` (`__name`, `__count`), `.ptile__hw` > `.ptile__img`, `.ptile__go`; `.ptile--compact` | logos, translucent text |
| Platform dot / label | `<PlatformLed>`, `<PlatformLabel>` | `.led` (8px, `--dot`), `.plat`; nav underline `.plat-line` | a dot without the name |
| Trust facts / fact rows | `TrustStrip`, `FactList` (kit adds them) | `.trust` > `.trust__cell` (`__icon` `__title` `__text`), `.trust--line`; `.facts` > `.fact` (`__icon` `__title` `__text` `__link`), `.facts--plain` | invented facts |
| Release dates | `ReleaseBand` (kit adds it) | `.release` > `.release__list` > `.release__item` (`__date` `__day` `__month` `__rel` `__art` `__name` `__price` `__note`) | countdowns, pre-order keys |
| Section head, shelf, show more | `SectionHead`, `ShelfRail`, `Rail`, `Pagination` | `.sechead` (`__text` `__title` `__reason` `__chips`), `.rail`, `.showmore` (`__count` `__bar` `__fill` `__end`) | arrows over cards |
| Cart line / summary | `<CartLineRow>`, `<OrderSummary>` | `.cline` (`__body` `__name` `__opt` `__avail` `__actions` `__total`, `--undo`), `.summary` (`__lines` `__line` `__rows` `__row` `--total` `__coupon`) | two red figures |
| Used units | `<UsedUnitCard>`, `<InspectionCard>` | `.pcard--row`, `.inspect` (`__rows` `__row`), `.battery` (`__bar` `__fill`) | serial numbers |
| Buy controls | `AddToCartKey` (`BuyBar`, `BuyControls`) | `.buybar` (`__info` `__var` `__added`) on `<Glass edge="bottom">` | |
| Toast / sheet / dialog / menu | `toast`, `<Sheet>`, `<Dialog>`, `<Menu>` | `.toast` (`__thumb` `__text` `__title` `__line` `__close` `__actions` `__view`: the actions in their own row at every width); `.sheet` (`__head` on glass, `__grab` `__title` `__body` `__foot`); `.dialog` (`__title` `__text` `__actions`); `.menu` > `.menu__row`; `.scrim`, `.scrim--menu` | glass bodies |
| Structure | `Breadcrumbs`, `ProgressSteps`, `Tabs`, `Accordion`/`Disclosure`, `Blocks` | `.crumbs` (`__list` `__link` `__current` `__sep`), `.steps` > `.step[data-state][aria-current]` (`__n` `__label` `__sep`), `.steps--compact`; `.tabs` > `.tab`; `.acc` (`__summary` `__chev` `__body`); `.callout` (`--ok` `--warn` `--danger`) | |
| Empty / error / offline | `EmptyState`, `ErrorState`, `OfflineBanner` | `.empty` (`__art`, `__art--well`, `__title` `__text` `__actions` `__ref`), `.empty-page` > `.empty` + `.empty__shelf` (a shelf at page width), `.empty--error`, `.offline` (warn tint + 3px warn bar; `--back` ok) | «دورك.», "500" offline, a black ribbon |
| Entries, categories, contact, compat | `EntryCard`, `CategoryTile`, `ContactCard` (kit adds them), `CompatBadge` | `.entry` (`__art` `__title` `__text`), `.cats` > `.cat` (`__art` `__name` `__count`), `.contact` > `.contact__row`, `.compat` > `.compat__row[data-state=yes|part|no]` (`__mark` `__name` `__state`) | «قريباً» for missing channels |
| Proof and wallet | `ProofUploader`, `WalletBalance` | `.proof__drop[data-state]`, `.proof__bar` `__fill`, `.copyval` `__value`; `.band--wallet`, `.wallet__label`, `.ledger` > `.ledger__row`, `.ledger__amount[data-sign]` | |
| Floating chrome | `<Glass>` (live, fixed/sticky only), `edge="bottom"` (float), `"solid"` | `.glass`, `.glass--bottom`/`--float`, `.glass--solid` (`--static` retired) | `backdrop-filter` anywhere else |
| Screen-reader text, bidi | `VisuallyHidden`, `BidiText`, `BidiLabel`, `FactLine` | `.bidi`; `.factline` (`--2`) > `.factline__fact` (`__sep`, `__text`, `__lead`): facts whole or shortened at their logical end; mirrored glyphs `.i--dir`; `/` chip `.kbd`; small pill `.pill` | `display:none` text, a one-line ellipsis that cuts a Latin name at its start |

Links that look like keys: `<Key as={LocaleLink} to="/cart">` or `<Key as={MotionLink} nav="zoom" to=…>`. Every key
carries `data-press` (press feedback from `<MotionRoot>`): clay keys move only their cap; flat keys compress softly.

**Deprecated (they work as aliases until stage 4, then the lint forbids them):** `Socket`, `PlatformBank`, `StageTag`,
`PlatformGlyph`, `variant="commit" | "ink" | "quiet"`, `<Glass variant="static">`.

## 3. Tokens (CSS custom properties — `app/styles/tokens.css`)

| Group | Tokens | Tailwind |
|---|---|---|
| Surfaces | `--ground` (floor) `--paper` `--niche` (THE product ground) `--niche-2` `--stage` `--band` `--glass-solid` | `bg-floor` `bg-paper` `bg-niche` `bg-niche-2` `bg-stage` `bg-band` `bg-glass-solid` |
| The product ground | `--product-ground` (flat light, lit spot dark), `--product-ground-hover`, `--contact` | — (the well classes paint it) |
| Ink | `--ink` `--ink-2` (secondary) `--ink-3` (disabled/decorative only); on bands `--on-band` `--on-band-2`; on colour `--on-color` | `text-ink` `text-ink-2` `text-ink-3` `text-on-band` `text-on-band-2` `text-on-color` |
| Lines | `--line` (hairline) `--line-2` (chips, dividers) `--line-strong` (controls, 3:1) `--line-glass` | `border-line` `border-line-2` `border-line-strong` `border-line-glass` |
| State | `--ok` `--warn` `--info` `--danger` + `-tint`; `--red-ink` `--red-tint`; `--demo-ink` `--demo-bg` | `text-ok` `bg-ok-tint` … `text-danger` `bg-danger-tint` `text-red-ink` `bg-red-tint` `text-demo-ink` `bg-demo-bg` |
| Brand red | `--red` `--red-hover` `--red-deep` `--hero` — only the primary key, bead, logo, hero/wallet bands, current step | `text-logo` (no `bg-logo`) |
| Platform | `--plat-*` `--plat-*-deep` (tile/band surfaces), `--dot-*` (dots; dark values in dark), `--gel-*` (dark cabinet light) — set a subtree with `data-gel="xbox"` (→ `--plat`, `--plat-deep`, `--dot`, `--gel`) | `bg-dot-xbox` (a dot), `text-dot-xbox` |
| Radius | `--r-xs` 8 `--r-sm` 12 `--r-md` 16 (admin) `--r-lg` 20 `--r-xl` 28 `--r-full` `--r-check` 6 | `rounded-xs…xl`, `rounded-full`, jobs: `rounded-button` `-key` `-field` `-thumb` (12) `-tag` `-chip` (full) `-niche` `-well` `-card` `-panel` (20) `-stage` `-band` `-sheet` `-dialog` (28) `-check` |
| Elevation | `--clay-cap` + `--clay-cast` (clay) · `--e-bar` · `--e-float` · `--e-overlay` · `--e-art` · `--rim` — nothing at rest has a shadow | `shadow-bar` `shadow-float` `shadow-overlay` `shadow-art` `shadow-rim`; 1.0 aliases `shadow-e1…e5` (e1 = a hairline ring until migrated) |
| Spacing / layout | `--s-1` 4 … `--s-20` 80; `--gutter` 16/24/32; `--gap-card` 12/16/20; `--gap-row` 24/32; `--gap-section` 40/56/72; `--page-max` 1280; `--target` 44; `--h-btn` 48 `--h-btn-sm` 40 `--h-field` 52 `--h-chip` 40 `--h-row` 56 `--h-option` 64/72; bars `--h-strip` 28 `--h-header` 56/64 `--h-nav` 44 `--h-tabbar` 64 `--h-taskbar` 72 `--h-checkout` 56/64; `--shell-top` `--shell-bottom` (set by the shell) | `p-4` = 16px (4px grid); `page`, `gutter`, `gap-card`, `gap-row`, `gap-section` |
| z-index | `--z-raised` 1 `--z-sticky` 100 `--z-nav` 200 `--z-scrim` 300 `--z-sheet` 310 `--z-dialog` 400 `--z-toast` 500 `--z-fly` 600 `--z-intro` 700 | `z-(--z-nav)` |
| Motion | `--t-press` 80 … `--t-fly` 460, `--ease-*`, `--spring-*` + `--spring-*-t`; the engine's `--motion-*` (docs/MOTION.md) | — |
| Misc | `--focus` `--focus-on-color` `--focus-w` `--focus-offset`, `--scrim` `--scrim-menu`, `--selection`, `--on-image`, `--dir` (±1), `--safe-top/-bottom/-inline`, `--lit`/`--unlit` (theme switches) | `safe-top` `safe-bottom` `safe-x` `hit-44` |
| Legacy: admin only | `--clay-*` `--red-face/-wall/-lip/-belly` `--sel-*` `--ink-lip` `--ink-belly` `--well` `--well-shadow` `--glass-bg/-static/-rim` `--on-glass-2` `--e-1…--e-5` `--shade` … | `bg-well` (→ niche-2), `bg-sel` (→ ink), `text-on-sel`, `shadow-well`, `shadow-wall` — lint `legacy-token` outside the admin |

Breakpoints (Tailwind): `sm` 600 · `md` 768 · `lg` 1024 · `xl` 1200 (admin only) · `2xl` 1280. Storefront code uses
`md`, `lg`, `2xl`. The default Tailwind palette, radius, shadow, blur and tracking scales are **removed**.

### Type roles — one class sets size, weight, line-height and face (integer px)

| Class | 360 → 768 → 1024 → 1280 | Use |
|---|---|---|
| `type-display` | Kufam 600 28 → 40 → 48 → 56 | the hero headline (an h2) |
| `type-h1` | Kufam 600 26 → 30 → 32 → 36 | page titles (PDP included) |
| `type-h2` | Kufam 600 22 → 24 → 26 → 28 | section heads |
| `type-tile` | Kufam 600 18 → 20 → 22 | tile names |
| `type-day` | Kufam 700 44 → 56 (1024) | release-day numerals |
| `type-h3` | Kufam 600 18 | h3, group, sheet and dialog titles |
| `type-code` | Plex 600 20, tabular | order numbers, account numbers |
| `type-lead` | Plex 400 16 → 18 | lead paragraphs |
| `type-body` | Plex 400 16 | reading text (the body default) |
| `type-read` | Plex 400 16 / 1.75 (en 1.6) | v2.1: facts, notes, descriptions |
| `type-card` | Plex 600 15 → 16 (1024) | card titles (two lines, never one) |
| `type-sm` / `type-sm-strong` | Plex 400 / 600 14 | labels, chips, fact rows |
| `type-button` / `type-button-sm` | Kufam 600 16 / Plex 600 14 | button labels (keys set them) |
| `type-xs` / `type-xs-strong` | Plex 400 / 600 13 | captions, meta, hints, tab labels |
| `type-tag` | Plex 600 12 | badges and the bead only |
| `nums` | tabular lining figures | every price, counter, quantity, table cell |

1.0 names still work on the v2 scale: `type-hero` = display, `type-title` = h1, `type-section` = h2, `type-sub` = h3,
`type-strong` = card, `type-label` = sm-strong, `type-caption` = xs, `type-tab` = 13/400; `type-data`, `type-data-sm`,
`type-kpi` are the admin's (Kufam 700). Prices: `.price--xl/lg/md/sm` (Kufam 700 30–36 / 22–24 / 18 / 16), the
currency smaller after the figure. **Kufam never under 15px** (lint). Arabic and Sorani text ≥13px; 12px only for
600-weight tags and the bead. **No letter-spacing, ever.** Sorani headings are Kufam too (it has every Sorani letter;
a native reader still reviews the ckb strings).

## 4. Rules a reviewer checks (`node scripts/lint-design.mjs`, `node scripts/contrast.mjs`)

- Logical properties only: `ms-/me-/ps-/pe-/start-/end-/text-start/rounded-s-`, `inset-inline-*`, `margin-inline-*`.
  Never `left/right`, `ml-/pr-/left-/text-left`. Directional icons mirror by themselves.
- No hex / `rgb()` / `hsl()` literals outside `tokens.css`. No `letter-spacing`. No CSS `filter` (images included), no SVG filters.
- `backdrop-filter` exists only in materials.css (`.glass`, `.glass--panel`, `.surface--glass`) — use `<Glass>` or
  those classes. At most **four live glass panes per viewport** (two bars, one panel, one hero); never in a list (grid
  cards are faux glass). Under an open sheet or dialog the page's glass turns solid by itself.
- Motion: only transform, translate, scale, rotate and opacity. Shadows, blur and colours never animate (a hover colour is instant).
- One primary key per route view (card add buttons are neutral). `--red`/`--hero` only in the primary key, bead, logo,
  hero/wallet bands and the current step; `--plat-*` surfaces only on tiles and bands; `--gel-*` only in dark cabinets.
- v2 rules (since stage 4 they fail the run in every file outside the admin): no 1.0 material tokens or utilities
  outside the admin; integer font sizes, Kufam never under 15px (v2.1: weight 500 is allowed again); radius only through `--r-*`; box
  shadows only from the elevation tokens; `mix-blend-mode` only in the opaque-photo rule (`[data-opaque]`,
  materials.css); the retired kit names (`Socket`, `PlatformBank`, `StageTag`, `PlatformGlyph`, `KeyBank`, `variant=
  "commit" | "ink" | "quiet"`, `<Glass variant="static">`).
- Pictures: put a product photo in a `.render-slot` that stands directly on its ground (`<Niche>`, `<Stage>`, a
  thumbnail): an opaque photo (`data-opaque`) blends there, on the slot, into the light ground. Showcase surfaces
  (`.band`, `.ptile`, `.release`) keep its plate. Box art and screenshots never blend.
- `<img>` always has `width` and `height` (or use `<Art>`).
- Escape hatch, with a reason: `// lint-design: allow <rule> — why` (line + next line; first 3 lines = whole file).
- 44×44 minimum target on everything pressable. Focus ring is automatic (2px, 2px offset; white inside light bands).
- Latin names and numbers inside Arabic/Kurdish text: `<BidiText text>`; kit labels isolate themselves (`BidiLabel`).
  Never wrap mixed text in a bare `<bdi>`. Inside a plain string use U+2066…U+2069. Phone numbers, references and
  amounts stay left-to-right. Card and line titles are isolated (`unicode-bidi: isolate`) and aligned to the page
  start in the page's direction — never `plaintext` (a Latin name would sit flush left in an Arabic card).
- Every user-facing string exists in `ar`, `en` and `ckb`.
- Token contrast: `node scripts/contrast.mjs` must pass (146 pairs since v2.1 — the glossy red's stops, clay faces,
  the tray, tile corners, glass panels over the worst backdrop, faux and real dark glass; 2 documented demonstrations).

## 5. Themes, density, language

- `<html data-theme="light|dark">` (an inline script resolves "system" before paint). Any subtree can carry its own
  `data-theme`; the showcases follow it through `--lit` / `--unlit`. Tailwind's `dark:` variant follows the attribute.
- Switch theme: `themeMorph("dark", buttonEl)` from `~/motion`.
- `data-density="admin"` on a container: the admin's compact type, 36px keys and fields, 24px gutter **and the Lens &
  Clay 1.0 materials** (walled keys, wells, `.clay--walled`, 1.0 glass) — `app/styles/admin.css`. `admin:` variant.
  Data grids: `<table className="table">` (`.is-num`, `.is-negative`, `aria-selected` rows).
- `lang` drives type: `:lang(en)` sets Latin line heights; Sorani uses the same faces as Arabic (v2.1).
- Direction comes from `<html dir>` only; sideways movement multiplies by `--dir`.

## 6. Layers — how to override

`app/app.css` orders the cascade: `theme` (Tailwind theme, then tokens) → `base` (preflight, then base.css) →
`components` (materials.css, components.css, admin.css, the Motion Engine's classes) → `utilities`. A Tailwind utility
in `className` always beats a component class — use utilities for placement and spacing, never to recolour a
material. Nothing in feature code may be unlayered.

## 7. Performance tiers and preferences (DESIGN.md §6.6)

| Signal | Result |
|---|---|
| no `backdrop-filter`, `prefers-reduced-transparency`, `.fx-low`, `html[data-motion="lite"]` | glass becomes `--glass-solid` (glass cards the card face); nothing inflates; no section reveal |
| `prefers-reduced-motion` / `data-motion="reduced"` | pressed states without transition, instant swaps, no light fades, no spinner rotation; no card lift, no reveal, no count-up, no carousel autoplay (moves instant), indicators jump, accordions open at once, the success mark is drawn |
| `prefers-contrast: more` | hairlines become `--line-strong`, glass solid, showcase lights hidden, wells and clay faces outlined |
| `forced-colors` | borders on keys, chips, tags, cells, wells and bands; selected = a Highlight outline; dots keep their colour |

## 8. Fonts

Self-hosted in `public/fonts` (content-hashed, cached immutable) — v2.1 brought the before's pair back: **Kufam
Variable** (wght 400–900; 600 for headings and key labels, 700 for prices and numerals, never under 15px) and **IBM
Plex Sans Arabic 400/500/600** (text), split arabic / latin (and latin-ext for Plex 400/600) by `unicode-range` — a
file is fetched only when the page draws one of its characters. `font-synthesis-weight: none`. Kufam has every Sorani
letter (cmap + shaping checked with fontkit; `tests/design-v21.test.ts`). `font-display: swap` with metric-adjusted
local fallbacks: "Kufam Fallback" / "Plex Fallback" (Segoe UI, Windows) and "… Fallback Noto" (Noto Sans Arabic,
Android, measured from Google's cut as a stand-in); iOS is unmeasured. The two critical files (Plex 400 + Kufam of the
page's script: 98.6 KB Arabic, 55.5 KB Latin) are preloaded with `preloadFonts(LOCALES[locale].script)` from
`~/styles/fonts` — React's `preload()` while the document renders, never as `<link>` elements.
Licences: `public/fonts/OFL-Kufam.txt`, `public/fonts/OFL-IBM-Plex-Sans-Arabic.txt` (Noto Kufi Arabic, v2's display
face, is retired: its files and licence are deleted — nothing referenced them).

## 9. The /design-system page

Add a section without touching the page: create `app/routes/storefront/content/design-system/sections/<name>.tsx`
exporting `section` (`{ id, order, title: { ar, en, ckb }, owner? }`) and a default component. Use `DsBlock`,
`SpecimenGrid`, `Specimen`, `SpecimenRow`, `defineCopy` / `useCopy` from `../kit`. Core is `order: 0`; take 10, 20, ….
Prices and names on that page are examples and the page says so.

## 10. Known gaps

- Nothing has been measured on a phone; Safari/WebKit and Firefox are untested (Chromium/Edge only).
- Fallback-font metrics cover Windows (Segoe UI) and a Noto Sans Arabic stand-in; iOS is not measured.
- The v2 classes for the new kit pieces (bands, tiles, trust strip, release band, entry/category/contact cards,
  segmented control, swatches, preference cells) exist in the stylesheets; their components arrive with the kit stage.
  Until then pages render half-migrated: 1.0 call sites draw on the v2 materials through the aliases above.
- Built by other owners and documented apart: overlays and states in `docs/ui/overlays.md`; commerce components in
  `docs/ui/commerce.md`; header, tab bar and footer in `app/routes/storefront/shell/README.md`.
