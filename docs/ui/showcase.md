# Showcase components — props and examples

Owner: the kit (`app/ui/*` below), strings in `app/i18n/messages/ui-shop.ts` (`tile`, `trust`, `release`, `contact`
groups) and `ui.ts`. Spec: Design System v2 §4.18–§4.27; CSS classes: `docs/UI.md` §2 (`.band`, `.ptile`, `.trust`,
`.facts`, `.release`, `.sechead`, `.entry`, `.cats`, `.contact`, `.compat`). Live, every state, ar/en/ckb × light/dark:
**`/design-system#showcase`**. Import each file directly — there is no barrel.

Colour light belongs to showcases only (bands and platform tiles); everything else stays on paper. Copy never sits on
a light core; text on a band is solid white in the light theme and ink in the dark one (set by the band).

**Polish round (2026-11-12):** `PlatformTile selected` (render it `as="button"`) is a toggle — aria-pressed, held on its
wall, a ring inside the face, a check disc (top start below 1024, the arrow disc's place from 1024). Below 1024 the
words sit under the hardware at every width (768–1023 too: the name never sits on the hardware — «PlayStation» on the
white PS5 Slim measured 1.48:1); a two-line name makes the tile taller. `SectionHead action` — your own action in the
«عرض الكل» place; «عرض الكل» and the action sit ON the heading's line (baseline), the reason runs under both.
`ReleaseBand` items: `detail` (a line under the name) and `platforms` (two dots for a multi-platform release; the
label names them all). `TrustStrip transfer={{ zaincash, card }}` (one fact naming the methods that are on).
`EntryCard` without `art` gives the words the whole card. `ContactCard` channels: `email` (mailto, left to right) and
`links` ([{ label: "Instagram", url }], new-tab links) — either one is a configured channel. `CompatList` rows:
`href` (the whole row is a link to the device). The compat words follow §4.1: يعمل · يعمل جزئياً · لا يعمل · لم نتحقق.

## Band — `~/ui/Band`

`kind`: `hero` (crimson + the brand light) · `platform` (hub band, `--r-lg`, 104 → 160) · `device` (device-hub head,
200 → 280) · `wallet` (crimson, no light). `platform` sets the surface and the light (`data-gel`). `media` is the
hardware layer: clipped at the sides and the bottom only, so it may rise above the top edge; placed at the inline end
(the hero on phones: a 220px box at the top centre — pad the copy with `max-md:pt-[230px]`); `mediaClassName` places it
yourself. `contentClassName` lays out the copy layer (it sits above the light). `contact` draws the floor ellipse.

```tsx
<Band kind="hero" media={<Render name="nintendo-switch-2--1" alt="" priority />} contact>
  <h2 className="type-display">العب على<br /><bdi>Nintendo&nbsp;Switch&nbsp;2</bdi></h2>
  <Price amountIqd={667750} size="xl" tone="onColor" /> <DemoNote variant="tag" what="price" onColor />
  <Key variant="onBand">اشترِ Nintendo Switch 2</Key>
</Band>
```

Headline rule: the Arabic line and the Latin name share one direction and edge — the name in a `<bdi>` after a `<br />`,
never a separate `dir="ltr"` block.

## PlatformTile, PlatformTiles — `~/ui/PlatformTile`

The four doors: `platform`, `to`, `name`, `count` («42 منتجاً», omitted when unknown), `art` (a render key), `compact`
(the short row variant). The hardware stands on the tile's floor; the white disc with the arrow mirrors in RTL.
`PlatformTiles` is the `nav` grid around them (`label` names it). `compact` keeps the words in their own column (48% of
the tile, as on the large tile) and the hardware in the other half; a compact tile narrower than ~220px (a container
query: two in a row on a phone, the 404 page's row of four) gives the words 62% and stands a smaller picture in the
bottom inline-end corner — «Nintendo» no longer sits on the Switch 2 (QA 2026-11-12).

## TrustStrip — `~/ui/TrustStrip`

Only true facts, each shown only when its prop is given (they come from settings): `deliveryIqd` («التوصيل 5,000 د.ع
لكل المحافظات»), `cod`, `transfer` (Zain Cash / card transfer, «نراجع كل تحويل قبل تأكيد الطلب»), `guest`. `variant="line"`:
the one-line form under a commit key (COD short + the returns link `returnsTo`, a 44px hit area around its 13px
words). Never ratings, counts or delivery times.

## FactList — `~/ui/FactList`

`facts: { icon, title, text?, link?: { to, label } }[]`; a paper card of rows, or `plain` rows. For the PDP and the
cart (delivery, returns, warranty).

## ReleaseBand — `~/ui/ReleaseBand`

The page's one dark band: «قريباً» + the honest lead («مواعيد الإصدار كما أعلنتها الشركات. الطلب المسبق غير متاح في المتجر
بعد.»), then items `{ id, to, name, releaseAt, platform, platformLabel?, priceIqd?, image }`: the day in large Kufi
numerals, «تشرين الثاني 2026», a relative chip «بعد 8 أيام» only within 30 days (Baghdad calendar days, `daysUntil`,
`iraqDay`), the art, the name, the price when set and «الطلب يفتح عند وصوله». Pass the loader's `now`. No countdowns,
no pre-order buttons. Nothing renders without items. Below 768 (a snap rail) an item that takes the KEYBOARD focus is
brought to the rail's start (`revealInRow`, as `<Rail>` does): Chromium leaves a partly visible item where it is.

## SectionHead — `~/ui/SectionHead`

`title`, `reason` (one honest line on why this shelf is here), `href` + `viewAllLabel` («عرض الكل» at the end),
`headingLevel` 2 | 3, `chips` (a `ChipGroup rail bleed` under the head; it scrolls on phones).

## EntryCard — `~/ui/EntryCard`

A whole-card link: `title`, `text`, `cta` (a text-link cue), `art` (a render key on a niche, or `"mascot"` for the
mark on a red-tint ground), `to`. For "used and inspected", "support" and similar doors.

## CategoryTile, CategoryTiles — `~/ui/CategoryTile`

`label`, `count` (optional), `art` (a render key at 14% inset on a square niche), `to`. `CategoryTiles` is the grid.

## ContactCard — `~/ui/ContactCard`

`channels: { whatsapp?, phone?, address?, mapsUrl?, hours?, hoursText?, replyTime? }` — all from settings, written
by the owner. With no channel it renders **nothing** (the caller shows «اكتب لموظف» instead). WhatsApp is a key
(`primary` on the contact page), the phone a `tel:` link in LTR, the address with a maps link, the hours with an
open/closed status computed in Baghdad time (`openNow(hours, now)`, overnight slots supported). `layout="row"` for
footers. Never invent hours or reply times.

## CompatBadge, CompatList — `~/ui/CompatBadge`

`CompatBadge status device note` — an icon AND words («متوافق مع PS5», «متوافق جزئياً»…, the note underneath).
`CompatList rows={[{ status, device, note }]}` — a paper card of rows with the state word per device.
