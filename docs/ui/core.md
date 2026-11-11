# Core components — props and examples

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

44px clay choices with a reserved 16px mark (ring → check), so the row never reflows. Labels are isolated (`<bdi>`).

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
| `Radio` | `row?` (option row: title + `hint` explanation), `end?` | group them in `FieldGroup` with one `name`; arrows are native |
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
<Niche variant="panel" className="flex items-center gap-3 p-3"><Socket state="empty" inset />…</Niche>
```

## Stage, StageTag, Render — `~/ui/Stage`

`<Stage size="hero" | "product" | "compact" gel tag action top bottom flush>` — the lit stage (194→452, 318→520,
132→160px). `gel` (`"nintendo" | "playstation" | "xbox" | "handheld" | "brand" | null`) cross-fades pre-painted light
layers when it changes. `tag`/`action` hang off the rim (band below the stage); `top`/`bottom` sit inside (orbs,
gallery). `<StageTag name priceIqd />` is the static-glass price tag.
`<Render name view? alt sizes? priority? pose? shadow? />` — a clay render fitted by its manifest aspect ratio inside
its slot, with a percentage contact shadow; a changed `name` inflates in (never on first paint). Only the LCP render
gets `priority`.

## PlatformLed, PlatformLabel, PlatformGlyph — `~/ui/PlatformLed`

`<PlatformLed platform? solid? on? />` (16×5; inherits the subtree's `data-gel` when `platform` is omitted),
`<PlatformLabel platform label? glyph? />` (LED + name as text — default names from `ui:platform.*`),
`<PlatformGlyph platform size? />` (neutral device pictogram). `PLATFORMS`, `isPlatform()`, types `Platform`, `Gel`.

## TextLink — `~/ui/TextLink`

`as` (default `"a"`), `arrow` (default on; off for `inline`), `inline` (underlined, inherits paragraph type),
`external` (new tab + "يفتح في نافذة جديدة"), `tone` (`"ink"` | `"danger"` — red-ink words for destructive text actions).

## Glass — `~/ui/Glass`

`variant` (`"live"` default | `"static"` | `"solid"`), `edge` (`"bottom"` for bottom-anchored bars and sheets), `as`.
The only way to get `backdrop-filter`. Secondary text inside glass automatically uses `--on-glass-2`.

## Socket — `~/ui/Socket`

`<Socket name state="ready" | "added" | "empty" onAdd loading? disabled? inset? />` — the card's red key seated in a
well; children replace the default add key. `useAddedFlash(ms = 1200)` → `[added, flash]`. `AddGlyph` is the
bag-plus glyph for the commit key.

## VisuallyHidden, cx

`<VisuallyHidden as? focusable?>` — screen-reader text (`focusable` shows it on focus, for skip links).
`cx(...classes)` — joins truthy class names; no merging needed because utilities win by layer.

## CSS-only pieces (no component yet)

`.bead` (the red cart count — tab bar, cart orb, admin queues), `.well`, `.panel`, `.panel--paper`, `.clay`,
`.clay--walled` (admin decision cards), `.status`, `.gtag`, `.render-slot`, `.chips`.
