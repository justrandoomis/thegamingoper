# Core components — props and examples

## Design v2.1 «Clay & Glass» (2026-11-12) — DESIGN.md §15, docs/UI.md §0

- **Key** — every look stands on a 2px wall (only the cap moves): `primary` glossy red (one per view), `secondary` white-to-
  cream clay (the default), `onBand` white clay, `danger` clay with a danger label, `ghost` flat. Labels Kufam 600 16px
  (`size="sm"` keeps Plex 600 14px). Props unchanged.
- **IconKey** — a 44px clay circle by default (`sm` 36, `xs` 32); `onImage` is a frosted disc. Props unchanged; the md
  size grew from 40 to 44 (the hit area was already 44).
- **Chip** — a clay pill; chosen = ink, held down on its wall, with the check. **Stepper** — the before's tray (pressed in, a
  flat «−», the count in Kufam, a raised «+»). **Segmented** — a tray with a clay thumb that slides. **Tabs** — one
  underline that slides. **Disclosure / Accordion** — the height animates (Chromium 131+).
- **Icon** — sprite icons draw at the before's weight (base.css); new names through the same API: `device-nintendo |
  device-playstation | device-xbox | device-handheld`, `kind-console | kind-game | kind-controller | kind-headset |
  kind-storage | kind-charging | kind-topup | kind-accessory | kind-used | kind-repair`, `media-play | media-pause`.
  `IconName` is now the union of the sprite names and these (`SpriteIconName`, `GlyphName` exported too).
- **PlatformLed / PlatformLabel** `bar` — the before's 16 × 5 colour line. **Breadcrumbs** `phone` — drawn on phones too.
- **New:** `Note` (side information), `Reveal` / `revealProps` (`~/ui/reveal`), `Carousel` / `useCarousel`,
  `SuccessMark`, `CountUp` (`~/motion`) — docs/UI.md §0 has the table.

## Fix round (2026-11-13) — DESIGN.md §15.10

- **Key** — the label's clip box reaches 0.45em above and below its line (Arabic marks are never cut: «أضف عنواناً»,
  «جارٍ»). New: `wrap` (a long label takes a balanced second line; the key grows) and `fit="compact"` (44px, 12px sides:
  a task bar's key on a 320–375 phone). Inside `[data-gel]` an `onBand` key says its words in `--plat-deep`.
- **Chip** `icon` (also `ChipGroup` options): a kind or device glyph before the label; the check takes its place when
  chosen.
- **Tabs** — labels 15px Plex 500 (chosen 600), a 44px row, the before's 3px underline; phones: 10px sides, no gap.
  `size="lg"` (16px, 48px row); `section` → `aria-current="true"` on the chosen tab. The admin keeps 12px / 2px.
- **Segmented** — the options' hit area is a true 44px (the `::after` inset counts the 1px border and the track's 2px).
- **Breadcrumbs** `phone` — each crumb stays on one line (base.css's `li { text-wrap: pretty }` undid the list's nowrap);
  a trail longer than the phone fades the edge that has more to scroll to (scroll-driven; no fade when it fits).
- **Carousel** — moves further than one slide fade and jump (`carouselMove()`); `running`, `autoplay`; `CarouselDots
  progress`; `CarouselArrows` / `CarouselPlay` `size` ("md" 44 default); 44px dots; keys from a portal ignored; the pause
  key after hydration. The slides keep `scroll-snap-stop: always`.
- **EntryCard** (row form) — the title 17px Kufam (16 on phones, 44px disc, 20px arrow): one line at 390.
- **Rail** / `PlatformTiles` / `CategoryTiles` `reveal` — their items fade up one after another (off by default).

## Polish round and stage 4 (2026-11-12)

- **Stage 4 (spec §4.2, §12):** `Socket`, `PlatformBank`, `StageTag` and `PlatformGlyph` are **deleted** — nothing
  imported them any more. Kept, because the admin (Lens & Clay 1.0) still uses them: Key `variant="commit" | "clay" |
  "ink" | "quiet"` and IconKey `variant="quiet"` (≈130 admin call sites), `<Glass variant="static">`
  (`app/routes/admin/shell/Nav.tsx`, `Palette.tsx`). `KeyBank` is not in §4.2's list and stays (`Chip` and `Tabs` use
  the roving helpers it re-exports; new code imports them from `~/ui/roving`). The storefront and the kit use none of
  the 1.0 names (`node scripts/lint-design.mjs --strict app/routes/storefront app/ui`: 0).
- **Bidi in sentences:** an amount or a name inside a translated sentence is a FIRST-STRONG isolate —
  `isolate(text)` (U+2068 … U+2069) from `~/ui/BidiText` — so «التوصيل 5,000 د.ع» reads the figure first in Arabic (the
  left-to-right isolate U+2066 put «د.ع» first). Card facts are `<BidiLabel>`s («512GB أو 1TB» reads from the right).
  `<BidiValue text>`: a value with numbers (impact rows, cells) — each standalone signed number one left-to-right run,
  the rest in the page's direction ("300 ← 450" reads 300, then on to 450). `latinName(name, dir)`: a clamped Latin
  name on an Arabic page is laid out left to right (its ellipsis at its own end) and aligned to the page's start.
- **Rows that scroll sideways** (`~/ui/reveal`): `<Rail>` brings a card that takes the KEYBOARD focus to the rail's
  start (a snap point — the snap can no longer pull it back ~80% off-screen); pointer focus never scrolls; the rail's
  own ring is drawn inside its edges. `<Tabs>` and link-mode `<Segmented>` keep their current item in view (first
  paint, change, fonts loaded, resize); they and `<ChipGroup rail>` bring a keyboard-focused item into view
  (`revealFocusedItem`; a pointer press never scrolls the row under it); `revealDelta` is the pure geometry.
- **Segmented (links):** each segment at least its words' width, the track scrolls when they do not fit (no cut
  labels); `current="true"` for a section (`aria-current="true"`), default `"page"`.
- **Fields:** a disabled CHECKED checkbox keeps its tick (an `--ink-3` fill; a disabled chosen radio an `--ink-3`
  ring) — the stylesheet's disabled box hid it. `Checkbox count={18}` / `end` (a filter row's count). `FieldGroup id`
  (an error-summary target). `Radio`/`OptionCard` `end`: a price keeps «667,500 د.ع» on one line.
- **Price:** the struck previous price above a price is its own 13px line (it inherited the 27px body line).
  `PriceTag size="page"`: `status` (the line's words, «قريباً · 19 تشرين الثاني») and `compareAtDemo` (struck, no
  «توفّر»).
- **PlatformTile:** `selected` (with `as="button"`) = a toggle — `aria-pressed`, held on its wall, a ring inside the face
  and a check disc. Below 1024 the words sit UNDER the hardware (768–1023 included: beside the name, the white PS5 Slim
  sat under «PlayStation», 1.48:1); a two-line name makes the tile taller instead of running into the picture.
- **Stage (pdp):** the image box is inset 4% / 2% / 5% (the cut-outs carry ~5% margin of their own, so the object stands
  at the spec's 8% / 6% / 9%); Switch 2 fills 63% of the 390 stage (was 52%). Opaque photos keep 8% / 6% / 9%.
- **OfflineBanner:** the spec's warn treatment (§4.23: `--warn-tint`, `--warn` 14/600, the wifi-slash in warn) with a
  3px `--warn` bar on the reading edge — told apart from the demo strip (centred, 28px, no bar) by shape, not by a
  black ribbon (QA 2026-11-12).
- **FactLine** (`~/ui/FactLine`): one line of facts joined by « · » — the card's kind and meta lines, the toast's
  product line, the buy bar's version. Each fact is whole or drops out with its « · » (it wraps onto a hidden row);
  only a first fact wider than the line is shortened, in its own isolate, at its LOGICAL end. Inside a fact with Arabic
  or Kurdish letters every Latin run is an atomic inline: the ellipsis hides it whole («جهاز Switch 2 بسعة …») or
  shortens it at its own end — a plain one-line ellipsis in an RTL box cut the start of a trailing Latin name («…G Xbox
  Ally», «…nds: Z-A»). A fact without Arabic letters (a Latin list with Arabic commas) is one left-to-right box.
  `lines={2}`: up to two rows (a used row's meta, the toast). Check it by paint, not geometry: a run the ellipsis hides
  keeps its overflowing box in the layout but is not drawn (hide the run and compare two screenshots of its box).
- **Price:** the figure and «د.ع» are one unbreakable unit (`.price__amount`); the buy bar's price steps down to sm in a
  column under 140px (a container query) instead of wrapping at 320px.
- **Field:** a `TextField` or `TextArea` that takes the focus is scrolled WHOLE into view (`revealField`: "nearest",
  which honours the shell's scroll padding) — the browser brought only the caret up and left the checkout's notes box
  half under the task bar. `FormErrorSummary` links are at least 44 × 44.
- **Switch** in forced colours: a CanvasText track edge and knob (off), a Highlight track with a HighlightText knob (on).
- **Swatches:** `unavailable` `"soldOut"` («نفد حالياً») · `"soon"` («قريباً») · `true` («غير متوفر»: not made in this
  version) · `reason` (your words). Never «غير متوفر» for a colour that is not out yet (§9).
- **Retired:** see the first item. The 1.0 sections further down are kept for the props that did not change.

## Design System v2 (2026-11-11) — read this first

The kit was rebuilt to Design System v2 (spec: the redesign's `design-v2-spec.md` §4; CSS classes: `docs/UI.md` §2,
`app/styles/materials.css`, `components.css`). Where a section further down disagrees with this one, **this one wins**;
the 1.0 sections below are kept for the props that did not change. Live, every state, ar/en/ckb × light/dark:
`/design-system#core` and `#forms` (and `#showcase`, see `docs/ui/showcase.md`).

**Keys (`Key`)** — `variant`: `primary` (crimson clay; ONE per view: the commit) · `secondary` (default: paper, hairline) ·
`ghost` · `onBand` (white key on a crimson / platform band; the red primary in the dark theme) · `danger`. 1.0 names
still work and map through `KEY_LOOK`: `commit`→primary, `clay`→secondary, `ink`→secondary look but keeps
`key--ink` (the admin re-skins it), `quiet`→ghost. `size`: md 48 (default) · sm 40 (`lg` = 1.0 name for 48). Press
physics: `keyPress(look)` → `data-press="clay"` for primary/onBand, `"soft"` otherwise (override with `data-press`).

**IconKey** — round, 44 / 40 (`sm`) / 32 (`xs`, a 44 hit area): `variant` `outline` (default) · `plain` · `onImage`
(product photos) · `onColor` (the white disc on tiles and bands); 1.0 `clay`/`ink`→outline, `quiet`→plain,
`commit`→the neutral add button (`cadd`). `held` = aria-pressed with the FILLED glyph; the face never turns ink.

**Choices** — `Segmented` (new; `.seg`): a radiogroup with roving focus, or link mode when every option has `href`
(`aria-current="page"`); `inline` shrinks it to its content. `KeyBank kind="segment"` now renders `<Segmented inline>`;
`kind="platform" | "thumb"` keep the `.bank`. `PlatformBank` is deleted (stage 4; `PlatformTile`). `Chip`: `count` (tabular,
in the chip), `platform` (dot after the label), `removable`; `ChipGroup rail bleed` scrolls on phones (chips never
shrink) and wraps from 768. Roving helpers moved to `~/ui/roving` (`useRovingRadio`, `useControllable`).

**Badges** — `Tag kind`: `new` · `soon` (calendar glyph, «قريباً») · `sale` · `grade` · `out` · `photo` · `demo` · `ok`
(+ 1.0 `used`/`preorder`/`refurbished`); `onColor` on bands. `Status tone`: ok · warn · info · bad · out · soon ·
neutral, `size="lg"`. `StockStatus`/`StockNote`: words «متوفر» · «الكمية محدودة» (shown as «متوفر» in demo mode) ·
«نفد حالياً» · «قريباً»; never "notify me" promises (`notifyTo` is ignored). Helpers: `stockLook`, `useStockWords`,
`useDemoMode`. `DemoNote variant`: `strip` (a link with `to`) · `chip` (full text from 1280, a compact button with a
popover below) · `tag` (`what`: price · priceStock · order · data; `onColor`) · `line`.

**Price** — Kufi 700 digits, the currency at a fixed ≥12px size after a no-break space, `aria-label` «667,750 دينار
عراقي». `tone`: ink · sale (automatic with `compareAtIqd`) · total (the ONE red figure of a summary) · onColor · muted;
`price--long` from 1,000,000. `PriceTag size="page"` = price + demo note + saving + `PriceLine` (stock + delivery).

**Grounds** — `Niche`: 1:1 by default, `kind` hardware | wide | box | card | used (`data-kind`), `size="sm"` (64–120px
wells: cart lines, summaries — use it instead of `rounded-md`), `fav` and `note` slots, `state="out"`. `Stage
size="pdp"` (default): straight, no tilt, no halo, a count chip and a tools slot; the 1.0 `StageTag` is deleted.
`Render` ignores the 1.0 `pose`/`shadow`.

**Platforms** — `PlatformLed` is an 8px dot (`.led`); `PlatformLabel` = dot + name; no pictograms (`PlatformGlyph` is
deleted). **Glass** is for bars and sheet heads only (`variant="live"`); `static` is the admin's (1.0) until it moves.

**Forms** — `Field` family: the error REPLACES the hint (one description), `aria-required` on required inputs.
New: `OptionCard` (`pay` with a 72px `mark`, words not logos), `FormErrorSummary errors={[{ id, label }]}` (role=alert,
44px links to the fields), `GovernoratePicker` (a select-looking button → picker sheet; the fee line on top; a
filter from 13 rows; unserved rows disabled with the reason; hidden input `name`), `PreferencePicker` (any · morning ·
afternoon · evening, day cells only when the owner configured `days`; always «وقت مفضّل وليس موعداً مؤكداً.»),
`Swatches` (colour dots or 56px thumbs; the chosen name printed above; `unavailable` crossed out). `Stepper`: no well,
plain icon keys, the stock limit is hidden in demo mode.

**Retired names:** deleted in stage 4 — `Socket` (→ `CardAddButton`), `PlatformBank` (→ `PlatformTile`), `StageTag`,
`PlatformGlyph`. Still exported for the admin's 1.0 look: Key `commit/clay/ink/quiet`, IconKey `quiet`,
`Glass variant="static"`, `Stage size="hero" | "compact"`, `KeyBank kind="segment"`. Storefront code uses the v2 names.

---

Owner: design system (`app/ui/*`, `app/styles/*`). Rules and tokens: `docs/UI.md`. Live: `/design-system#core`.
All components are SSR-safe, use logical properties only, work in both themes and in `ar` / `en` / `ckb`, and take
their own strings from the `ui` namespace (`app/i18n/messages/ui.ts`). Polymorphic components accept `as` (an element
name or a component such as `LocaleLink` / `MotionLink`) plus that element's props, `ref` included.

---

## Key — `~/ui/Key`

| Prop | Type | Default | |
|---|---|---|---|
| `variant` | `"commit" \| "clay" \| "ink" \| "quiet"` | `"clay"` | commit = the red key, ONE per view |
| `size` | `"sm" \| "md" \| "lg"` | `"md"` | 40 / 48 / 56 (+ wall); sm keeps a 46px hit area |
| `icon`, `iconEnd` | `IconName \| ReactNode` | — | leading / trailing; directional sprite icons mirror in RTL |
| `held` | `boolean` | — | a toggle: `aria-pressed`, cap stays down, ink face (links: `data-held`) |
| `loading` | `boolean` | `false` | same width, spinner, `aria-busy`, says "جارٍ التحميل", ignores clicks, stays focusable |
| `disabled` | `boolean` | `false` | flat, ink-3; buttons get `disabled`, links `aria-disabled` and do not navigate |
| `block` | `boolean` | `false` | full inline size |
| `as` | element / component | `"button"` | buttons default to `type="button"` |

```tsx
<Key variant="commit" icon={<AddGlyph />} onClick={add}>{t("addToCart")}</Key>
<Key as={LocaleLink} to="/cart" iconEnd="arrow-right">{t("viewCart")}</Key>
<Key variant="ink" onClick={apply}>{t("showResults", { count })}</Key>       // filter drawer footer
<Key variant="quiet" icon="moon" onClick={(e) => themeMorph("dark", e.currentTarget)}>{t("dark")}</Key>
<Key held={showAll} onClick={() => setShowAll((v) => !v)}>{t("all")}</Key>
<Key variant="commit" loading={fetcher.state !== "idle"} type="submit">{t("placeOrder")}</Key>
<Key variant="commit" disabled aria-describedby="why">{t("addToCart")}</Key> <span id="why">{t("soldOut")}</span>
```

Classes (for reference): `.key` `.key__cap` `.key__label` + `.key--red|--ink|--quiet|--sm|--lg|--block|--round|--chip|--plat|--thumb`.
State attributes the CSS reads: `aria-checked`, `aria-pressed`, `data-held`, `data-pressed` (Motion Engine), `data-loading`, `:disabled` / `aria-disabled`.

## IconKey — `~/ui/IconKey`

Round 44px key (36px with `size="sm"`, hit area still 44). `label` is required (aria-label + tooltip). Held icon keys
switch to the filled sprite weight when there is one. Same `variant`, `held`, `loading`, `disabled`, `as` as Key.

```tsx
<IconKey icon="x" label={t("close")} onClick={onClose} />
<IconKey icon="heart" label={t("favourite")} held={fav} onClick={toggleFav} />
<IconKey as={LocaleLink} to="/cart" variant="quiet" icon="shopping-bag" label={t("cart")} />
```

## KeyBank — `~/ui/KeyBank`

Keys in a well with radio semantics (one tab stop, arrows follow reading direction, Home/End, selection follows focus).

| Prop | Type | Default | |
|---|---|---|---|
| `items` | `{ value, label?, ariaLabel?, icon?, gel?, media?, disabled? }[]` | — | `gel` adds the LED (and a platform pictogram for platform keys) |
| `value` / `defaultValue` / `onChange` | `string` | — | controlled or not |
| `onIntent` | `(value) => void` | — | pointer-down on an unchosen key — prefetch what it will show |
| `kind` | `"platform" \| "thumb" \| "segment"` | `"platform"` | tall LED keys · gallery thumbnails · short text keys |
| `label` | `ReactNode` | — | visible label above the well (names the group) |
| `aria-label`, `aria-labelledby` | `string` | — | when there is no visible label |
| `name` | `string` | — | adds a hidden input for `<Form>` |

```tsx
const ui = useT("ui");
<KeyBank label={<><b>{t("turn")}</b> {t("pick")}</>} items={PLATFORMS.map((p) => ({ value: p, gel: p, label: ui(`platform.${p}`) }))}
         value={platform} onChange={setPlatform} onIntent={prefetchHero} />
<KeyBank kind="thumb" aria-label={t("gallery")} value={view} onChange={setView}
         items={views.map((v, i) => ({ value: v, ariaLabel: t("view", { n: i + 1 }), media: <Render name={`${art}@${v}`} alt="" shadow={false} sizes="48px" /> }))} />
```
`useRovingRadio({ values, isDisabled, value, onChange })` and `useControllable()` are exported for custom radio rows.

## Chip, ChipGroup — `~/ui/Chip`

44px clay choices with a reserved 16px mark (ring → check), so the row never reflows. Labels are isolated by
`<BidiLabel>` (below): pass plain strings — "PlayStation 5 Slim (نسخة الأقراص)" reads right to left on an Arabic page,
"1 TB" and "PS5" stay left to right; no `<bdi>` of your own is needed.

| Mode | How | Semantics |
|---|---|---|
| toggle | `<Chip selected onClick>` | `aria-pressed` (multi-choice) |
| link | `<Chip as={LocaleLink} to selected>` | `aria-current="true"` when selected |
| native | `<Chip input="checkbox" \| "radio" name value checked/defaultChecked onChange>` | a real `<input>` — submits without script |
| removable | `<Chip onRemove>` | held, ×, accessible name "أزل {label}" |
| single choice | `<ChipGroup options value onChange aria-label name? rail?>` | `radiogroup`, roving tabindex |

## Tag, Status, StockStatus — `~/ui/Tag`

`<Tag kind="new" | "used" | "preorder" | "refurbished" detail? >children?</Tag>` — new is solid ink, the others are
outlined; default words come from `ui:tag.*`; `detail` appends " · {detail}" (e.g. the used grade). One tag per object.
`<Status tone="ok" | "warn" | "info" | "bad" | "neutral">words</Status>` — dot + words.
`<StockStatus quantity={n} lowAt={3} detail? />` — "متوفر" / "بقي {n}" / "نفد"; `quantity={null}` renders nothing.

## Field family — `~/ui/Field`

Common props: `label` (required), `hint`, `error` (the sentence; present = invalid: red-ink border, alert icon,
`aria-invalid`, `aria-describedby`, polite announcement), `required` ("*" + the word for screen readers), `optional`
("(اختياري)"), `hideLabel`, `className` (wrapper). Everything else goes to the native control. No native `required`
validation — validate on blur, re-check on input once an error shows, and pass `error`.

| Component | Extra props | Notes |
|---|---|---|
| `TextField` | `ltr?`, `end?` (inline-end slot: unit, small key), `inputClassName?` | tel/email/url/number and numeric/decimal/tel input modes are LTR and hug the start edge in RTL |
| `TextArea` | `inputClassName?` | `rows` 3 by default, resizes vertically |
| `Select` | `options?`, `placeholder?` | native `<select>`, caret at the inline end |
| `Checkbox` | `indeterminate?` | never pre-check consent |
| `Radio` | `row?` (option row: title + `hint` explanation), `end?` | group them in `FieldGroup` with one `name`; arrows are native; a group with nothing chosen yet shows every circle empty (a radio matches `:indeterminate` then — the mixed look is for checkboxes only) |
| `Switch` | — | `role="switch"`; for settings that apply at once |
| `FieldGroup` | `legend`, `hint`, `error`, `required`, `optional`, `layout` | a `<fieldset>` for radios, checkboxes or chips |

```tsx
<TextField name="phone" type="tel" autoComplete="tel-national" label={t("phone")} required hint={t("weCall")} error={errors.phone} />
<FieldGroup legend={t("payment")} required error={errors.method}>
  <Radio row name="method" value="cod" label={t("cod")} hint={t("codHint")} defaultChecked />
  <Radio row name="method" value="zaincash" label={t("zain")} hint={t("zainHint")} end={<Price amountIqd={0} size="sm" as="span" />} />
</FieldGroup>
```

## Stepper — `~/ui/Stepper`

`value`/`defaultValue`/`onChange`, `min` (1), `max`, `maxReason` (`"stock"` → "بقي {max} فقط" at the limit; or your own
words), `size` (`"md"` 44 / `"sm"` 36 with 44 hit area), `label` (group name, default "الكمية"), `name` (hidden input),
`disabled`. Minus at the start, plus at the end in every language; ends go flat but stay focusable; hold to repeat
(420ms, accelerating); the numeral is a polite live region.

## Price — `~/ui/Price`

| Prop | Type | Default | |
|---|---|---|---|
| `amountIqd` | integer | — | a fraction throws (money is integer IQD) |
| `size` | `"xl" \| "lg" \| "md" \| "sm"` | `"md"` | 28/34 · 21/28 · 17 · 15 (mobile/desktop) |
| `compareAtIqd` | integer | — | shown first, ink-2, struck — only when higher |
| `approx` | `"auto" \| "off"` | `"auto"` | converted line when the shopper's display currency is not IQD |
| `rateDetails` | `boolean` | xl only | the rate, its source and time (and "demo rate" when `fxIsDemo`) behind a disclosure |
| `as` | `"p" \| "span" \| "div"` | `"p"` | `"span"` inside running text (no block line then) |

The dinar is always primary and payable. The converted line reads "≈ $686.26 · الدفع بالدينار العراقي", never bold;
its digits roll on a currency switch (NumberMorph) — the only moving money. No rate configured → no conversion (xl/lg
say so). Delivery copy: `t("delivery", …)` around `<Price amountIqd={fee} size="sm" as="span" approx="off" />`.

## Niche — `~/ui/Niche`

`variant` (`"card"` | `"panel"`), `ratio` (`"3/2"` default, `"1/1"`, any ratio), `tag` (top-start zone), `tagZone`
(false for category cards), `fill` (real photos, object-fit cover), `as`. The niche colour is the placeholder.

```tsx
<Niche as={MotionLink} nav="zoom" to={`/p/${slug}`} aria-label={name} tag={<Tag kind="used" detail={grade} />}>
  <SharedElement name={`product-image:${id}`}><Render name={art} alt="" sizes="(min-width: 1200px) 200px, 45vw" /></SharedElement>
</Niche>
<Niche variant="panel" className="flex items-center gap-3 p-3">…</Niche>
```

## Stage, Render — `~/ui/Stage`

`<Stage size="pdp">` — see the v2 section at the top. 1.0: `<Stage size="hero" | "product" | "compact" gel tag action
top bottom flush>` — the stage geometry (194→452, 318→520, 132→160px); `gel` is ignored in v2. `tag`/`action` hang off
the rim (band below the stage); `top`/`bottom` sit inside. (The 1.0 static-glass price tag `StageTag` is deleted.)
The band never cuts the commit key's label: the tag gives way first (its name keeps to one line of whole words and
only its price must fit), a price of 1,000,000 or more steps down from 21 to 17px on a stage narrower than 24rem
(`data-long`; a 390 phone keeps tag and key side by side), and only when the price and the key still do not fit
(a 360 phone with a seven-digit price) does the key move under the tag, at the inline end. Pages need no local rule.
`<Render name view? alt sizes? priority? pose? shadow? />` — a catalogue photo fitted by its manifest aspect ratio inside
its slot, with a percentage contact shadow; a changed `name` inflates in (never on first paint). Only the LCP render
gets `priority`.

## PlatformLed, PlatformLabel — `~/ui/PlatformLed`

`<PlatformLed platform? />` (the 8px dot; inherits the subtree's `data-gel` when `platform` is omitted; 1.0 `solid`/`on`
ignored), `<PlatformLabel platform label? />` (dot + name as text — default names from `ui:platform.*`).
`PLATFORMS`, `isPlatform()`, types `Platform`, `Gel`.

## TextLink — `~/ui/TextLink`

`as` (default `"a"`), `arrow` (default on; off for `inline`), `inline` (underlined, inherits paragraph type),
`external` (new tab + "يفتح في نافذة جديدة"), `tone` (`"ink"` | `"danger"` — red-ink words for destructive text actions).

## Glass — `~/ui/Glass`

`variant` (`"live"` default | `"static"` | `"solid"`), `edge` (`"bottom"` for bottom-anchored bars and sheets), `as`.
The only way to get `backdrop-filter`. Secondary text inside glass automatically uses `--on-glass-2`.
Two live panes per viewport: while a sheet or dialog is open, the page it covers is marked `data-layer-behind` (by the
modal-layer stack in `~/ui/Dialog`, never on other overlays) and that page's live glass — the header after scroll, the
tab or task bar — turns solid (`materials.css`), so the layer's own strip is the live pane under the scrim. In
development `<Glass>` warns when more than two live panes are in the viewport (counted half a second after a live pane
mounts: drawn, on screen, not behind an open layer); `liveGlassPanes(document)` lists them.

## BidiText, BidiLabel, BidiValue, isolate, splitBidi — `~/ui/BidiText`

Mixed scripts (DESIGN.md §5.5, §13). `<BidiText text>` takes a name or a sentence and returns inline nodes: a text
without Arabic script is one `<bdi dir="ltr">`; inside Arabic or Sorani text each Latin NAME and each number is one
left-to-right isolate and the rest keeps the page's direction. Where a run ends:

| Kept inside one run | Left in the sentence |
|---|---|
| glued joiners: `Z-A` `USB-C` `Marvel's` `X\|S` `1920×1080` `3.5` `25,000` `16:9`; trailing signs `AI+` `C#` `20%` `™` | a final full stop, `, ` `·` `—` (name — option) `،` `؛` quotes, line breaks |
| spaced joiners between Latin words: ` – ` ` + ` ` / ` ` & ` `: ` ("Pokémon Legends: Z-A – Nintendo Switch 2 Edition") | brackets around Arabic: "PlayStation 5 Slim (نسخة الأقراص) – 1TB" |
| a bracket pair around Latin only: `Legion Go (2023)`, `BEE-001(-01)`, `Joy-Con 2 (L)/(R)` | a number that follows Arabic: "حزمة 2026: Switch 2" (2026 is the bundle's) |

`<BidiLabel className>{children}</BidiLabel>` is the isolate the kit puts around labels — keys, chips, banks,
breadcrumbs, menu rows, progress steps, the stage tag's name, the toast's name: a label whose text has no Arabic
script is `<bdi dir="ltr">`; one with Arabic script (or whose words it cannot read, such as a component that takes them
as props) is `<span class="bidi">` — `unicode-bidi: isolate` in the page's own direction — and a string gets
`<BidiText>` inside. A bare `<bdi>` guesses its direction from the first letter, so a Latin-first Arabic label came out
left to right. `splitBidi(text)` returns the parts (`{ text, ltr }[]`); `textOf(node)` reads a label's text; `hasRtl`.
Tests: `tests/ui-bidi.test.ts` (every Arabic and Sorani name of the catalogue round-trips with clean runs); live, with
each line's reading order measured in Chromium: `/design-system#bidi`.

`BidiText` was first written in `~/ui/ProductCard`; that file now re-exports this one, so the storefront's existing
`import { BidiText } from "~/ui/ProductCard"` gets it too. New code imports it from `~/ui/BidiText`.

## VisuallyHidden, cx

`<VisuallyHidden as? focusable?>` — screen-reader text (`focusable` shows it on focus, for skip links).
`cx(...classes)` — joins truthy class names; no merging needed because utilities win by layer.

## CSS-only pieces (no component yet)

`.bead` (the red cart count — tab bar, cart orb, admin queues), `.well`, `.panel`, `.panel--paper`, `.clay`,
`.clay--walled` (admin decision cards), `.status`, `.gtag`, `.render-slot`, `.chips`.
