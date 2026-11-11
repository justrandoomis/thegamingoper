# TamTam Games Design System v2 — Vivid Premium (طمطم)

Adopted 2026-11-11. One system for the storefront (mobile first at 390, then 768, 1024 and 1440) and, through a density switch, for the admin. Arabic RTL is the default; English LTR and Kurdish Sorani RTL are complete alternates. Currency is the Iraqi dinar in integer amounts. It replaces "Lens & Clay 1.0" on the storefront; the admin keeps the 1.0 materials until its own migration (§10).

| What | Where |
|---|---|
| Tokens (the only place a colour literal is written) | `app/styles/tokens.css` |
| Materials (clay v2, glass v2, showcase light, the product ground, tiers) | `app/styles/materials.css` |
| Kit component classes | `app/styles/components.css` (class map: `docs/UI.md` §2) |
| The admin's 1.0 materials and density | `app/styles/admin.css` (`[data-density="admin"]`) |
| Fonts | `public/fonts/*`, `app/styles/fonts.css`, `app/styles/fonts.ts` (the two preloads) |
| Tailwind mapping | `app/styles/theme.css` |
| Checks | `node scripts/contrast.mjs` (token contrast, both themes), `node scripts/lint-design.mjs` (the rules of §6.7) |
| Live reference | `/design-system` (also `/en/…`, `/ckb/…`) |
| Cheat sheet for builders | `docs/UI.md` |

Honesty floor (unchanged, hard): no invented reviews, ratings, "sold" counts, customer numbers, delivery promises (no "we call to confirm"), integrations or notify-me controls. Prices are integer IQD. Demo data stays marked as demo.

---

## 0. Principles

1. **Red and white is the brand; the four platform colours are the doors.** Everything else is warm white, graphite and hairlines.
2. **The product is the largest, most real thing on screen:** official photos, one ground, one floor line, no tilt, no coloured light behind anything a shopper is judging.
3. **One red primary action per view.** Ink fill means "selected", never "action".
4. **Clay in exactly two places, the primary key and the platform tiles.** Every other control is flat.
5. **Glass only on thin bars that content scrolls under.** Panels, menus, sheets and dialogs are opaque.
6. **Colour light belongs to showcases** (hero, tiles, platform bands). In dark mode they become lit cabinets.
7. **Facts sit beside the price:** stock, the 5,000 IQD delivery fee, payment, returns, guest checkout. Nothing invented.
8. **Arabic first:** a 13px floor, integer sizes, Latin names isolated, layouts that mirror by logic.
9. **Motion is the existing engine:** feedback within 80 ms, nothing waits for an animation, nothing moves at rest.
10. **One system:** every value is a token, and every component exists once.

## 1. Thesis

TamTam is a red-and-white store with real hardware in it. The identity is the logo's red and a warm white floor; the four platforms are recognised by their own colours, used as doors (tiles and hub bands) and as an 8px dot beside their names everywhere else. Products always stand on one neutral ground, so a shopper judges the thing itself. The play lives in a few precise places — a clay primary key you can press, platform tiles whose hardware breaks out of the frame, a crimson hero with one studio light — and stops at money: prices, totals and forms are flat and quiet.

## 2. Signature

- **The crimson hero band** (`--hero`, a 17% darker red than the logo) with the featured product under one radial light in brand red, its Arabic and Latin headline flush to the reading start, the price in Kufi beside a white clay key.
- **Four platform tiles** in their own colours on a 2px clay wall, the real console standing above the tile's top edge.
- **The product well**: every product on `--niche`, contained and bottom-aligned on one floor line with a CSS contact ellipse.
- **In dark mode the showcases become lit cabinets**: charcoal with a rim and the platform's (or the brand's) light behind the hardware; products sit on a neutral lit spot that is always lighter than the page.

## 3. What changed from Lens & Clay 1.0

Removed (DESIGN.md §6.7 lints what can be linted):

1. **Kufam** (both files, its licence, the "Kufam Fallback", the 15px Kufam floor) and **Plex 500**.
2. **The kaolin palette** (`#F3EEEA` floor, `#E9E2DC` niche and stage, `#E6DED7` well) and the umber shadows (`--shade: 84 56 44`) on the storefront.
3. **Clay on every control:** walled white keys, the chip ring, clay steppers, icon orbs and header orbs, clay thumbnails, wells (`.well`, `--well-shadow`), the key bank, `PlatformBank`, `PlatformGlyph`, the 16×5 LED (now the 8px dot).
4. **The red socket** on every card (now a neutral add button that fills red under the pointer).
5. **The tilted lit stage on product pages:** the −3° pose, the coloured halo and pool, light under box art, the glass price tag (`StageTag`), stage orbs, thumbnails inside the stage, kind captions («الرئيسية»).
6. **Glass on panels:** the mega menu, sheet bodies, menus and toasts are opaque; static glass is retired.
7. **Three-bar chrome:** the black «الموقع قيد الإنشاء» ribbon, the separate utility strip, the offline banner that looked like the ribbon, the footer's duplicate demo box, the phone layout at 1024–1199.
8. **Copy:** «دورك.» outside the intro; every call promise; builder's voice and dev notes; "draft" tags; research and UPC notes on product pages; the empty reviews section; «الكمية محدودة» and savings computed from demo data; notify-me links; «جديد» on everything.
9. **Type debris:** half-pixel sizes, the 11px currency, `--ds` scaling, Kufam on buttons, 29 sizes in one view.
10. **Image effects:** `filter: drop-shadow` on images; `mix-blend-mode` except the interim opaque-photo rule (§12).
11. **Layout debris:** rail arrows over content, one- and two-card shelves, desktop carousels of whole cards, the intro's consent modal, the empty cart without a tab bar.
12. **The five 1.0 laws** are replaced by §0; law 5 ("flat is for reading") survives inside principle 4.

Considered and not taken: grey platform doors and red on every price (they repeat the owner's complaint and kill the sale signal); «أعلمني عند التوفر» (no notification integration exists); cabinets that stay black in the light theme and a glow behind every showcase; RTL-only transforms and an LTR hero headline block; 3–4px clay walls with 55–75% tinted casts, 12px Arabic, a 127px checkout header and a full-saturation dark mode.

## 4. How the system was assembled

Five audits, a benchmark of 15 stores and three prototypes (A "Vivid Premium", B, C) judged by three reviewers (brand, shopper, system). Two of three chose A (brand 8.2 against 7.2 and 7.2; shopper 7.83 against 7.70 and 7.58); the system judge chose B but wrote that grafting A's colour doors and clay primary onto B "gives the owner A's look with B's discipline". The result is **A's red-and-white identity, platform tiles and layouts, built on B's tokens, readability and checkout compactness, with C's lit cabinets as the dark mode** — A with calibrations, not a three-way hybrid.

| # | Graft | From | Where |
|---|---|---|---|
| G1 | Chrome budget: phone 28px demo strip (scrolls away) + 56px header; desktop 64 + 44 = 108 at every width ≥1024; checkout one 56/64px bar with the step rail inline | B | §8.1 |
| G2 | Hero typography flush to the reading start (the Latin name isolated inline); product name in Kufi; price in Kufi 700 beside the action | B | §9.18 |
| G3 | Readability floor: Arabic and Sorani ≥13px (12px only for 600-weight tags and the bead); fact rows 14–15; tab labels 13; integer sizes | B | §5.5 |
| G4 | Dark product ground: a neutral lit spot (black hardware 2.12:1 against 1.17:1 on a flat well) | B | §6.4 |
| G5 | Error colour distinct from the brand red (`--danger`) | B | §5.2 |
| G6 | Release band with large Kufi day numerals | B | §9.21 |
| G7 | Trust facts between hairlines (2×2 on phones); one red figure per summary (the total) | B | §9.20, §9.13 |
| G8 | Checkout details: 48px preference cells; governorate sheet with 52px rows and the fee on top; collapsible summary bar | B | §9.9, §8.3 |
| G9 | PDP payment row as one sentence with the transfer rule; no phone PDP stepper; option value only in summaries | B | §8.3, §9.13 |
| G10 | Hub lead line with delivery and COD, phones included | B | §8.3 |
| G11 | System rigour: today's radius scale, ≤7 shadow recipes, global scroll padding, `--dir` mirroring, latin-ext subsets, an opaque-photo import gate (ΔE 3) | B | §5, §12 |
| G12 | Lit cabinets as the dark mode of the hero, the tiles and the hub bands | C | §6.3 |
| G13 | Mascot + wordmark lockup in the phone header | C | §8.2 |
| G14 | Card states: a neutral add button that fills red on hover and shows a check after adding; sold-out photo at 50%; used units as list rows | C | §9.11 |
| G15 | A specific hero action «اشترِ Nintendo Switch 2»; a desktop model switcher in the platform band | C | §8.3 |
| G16 | PDP first screen: «● متوفر · التوصيل 5,000 د.ع لكل المحافظات» under the price; «سعر ومخزون تجريبيان»; a guest row in the facts | C | §8.3 |
| G17 | Compatibility rows with state words; card kind label; sort explanation; built search suggestions; toast with «عرض السلة» | C | §9 |
| G18 | A CSS contact ellipse instead of `filter: drop-shadow`; Plex 400/600 only; 12px-radius buttons against pill chips; a bordered switch | C | §5–§6, §9 |

---

## 5. Tokens

### 5.1 Mechanics, scope and migration

- **One file.** `app/styles/tokens.css` is the only place a colour literal may be written. Themes: `:root, [data-theme="light"]` and `[data-theme="dark"]`, on `<html>` (resolved before paint by the inline script) or on any subtree. Composite tokens that read other tokens are declared in both theme blocks, so a theme island resolves them with its own colours.
- **Storefront first.** v2 materials are the default. `[data-density="admin"]` keeps the 1.0 materials (§10). The 1.0 material tokens — `--clay-face`, `--clay-wall`, `--clay-lip`, `--clay-belly`, `--red-face`, `--red-wall`, `--red-lip`, `--red-belly`, `--sel-*`, `--ink-lip`, `--ink-belly`, `--well`, `--well-shadow`, `--glass-bg`, `--glass-static`, `--glass-rim`, `--on-glass-2`, `--e-1`…`--e-5`, `--e-4-up`, `--shade`, `--lumen`, `--halo`, `--pool`, `--spot` — sit in a block marked `legacy: admin only` inside each theme block. Storefront code may not read them (lint `legacy-token`). Shared surface tokens changed for both: the admin got the neutral floor, white paper, the v2 ink and lines, and nothing else.
- **Names kept where the meaning survives**, so most call sites need no edit:

| 1.0 | v2 | Light | v2 meaning |
|---|---|---|---|
| `--ground` | `--ground` | `#FDFCFA` | page floor (warm white) |
| `--paper` | `--paper` | `#FFFFFF` | cards with content, fields, sheets, menus, dialogs, header base |
| `--niche` | `--niche` | `#F3F1EE` | **the** product ground: wells, stage, thumbnails, cart lines, toast thumb, category tiles. No longer used for info panels |
| `--stage` | `--stage` | `= --niche` | PDP stage (dark: the lit spot, §6.4) |
| `--well` | retired (admin only) | — | steppers and segmented controls are hairline pills now |
| — | `--niche-2` | `#EAE7E3` | well hover/pressed, image placeholder, ShowMore track |
| — | `--band` | `#17181C` | the one dark band per page (release dates) |
| `--line` | `--line` | `#E6E3DF` | decorative hairline |
| — | `--line-2` | `#C9C5BF` | chip border, dividers that need presence (decorative, 1.72:1) |
| `--line-strong` | `--line-strong` | `#85827D` | control boundaries: fields, secondary and toolbar buttons, checkbox, radio, switch off-track (3.83:1) |
| `--ink` `--ink-2` `--ink-3` | same | `#141518` `#55575D` `#9C9A96` | text; `--ink-3` is decorative or disabled only |
| `--red` | `--red` | `#E5132B` | brand: logo, primary key, cart bead, hero light core |
| — | `--red-hover` / `--red-deep` | `#CC0F25` / `#9E0B1E` | primary hover (both themes) / the primary key's and on-band key's wall |
| `--red-ink` | `--red-ink` | `#C8102A` | red as text: sale price, the total in summaries |
| — | `--red-tint` | `#FDECEE` | active tab pill, trust icon tiles, sale badge, empty-state disc |
| — | `--hero` / `--on-band-key` | `#BE0F27` | "TamTam crimson": hero band, wallet card / the white key's label |
| — | `--danger` `--danger-tint` | `#B42318` `#FEF3F2` | field errors and the error summary, never brand red |
| `--ok` `--warn` `--info` | same, plus `-tint` | §5.2 | states, always with words |
| — | `--demo-ink` `--demo-bg` | `#7A4A00` `#FFF4E2` | demo marking, never inverted |
| `--gel-*` | `--gel-*` (values unchanged) | triplets | light inside dark cabinets only |
| — | `--plat-*`, `--plat-*-deep`, `--dot-*` | §5.3 | platform surfaces and dots |
| `--glass-bg` | `--glass` | `rgb(255 255 255 / .90)` | thin bars only |
| `--e-1`…`--e-5` | `--clay-cap`/`--clay-cast`, `--e-bar`, `--e-float`, `--e-overlay`, `--e-art`, `--rim` | §5.7 | the whole shadow vocabulary |
| `--type-*` | `--type-*` (new values) + `--fs-*` | §5.5 | integer sizes |
| `--ds` | constant 1 (deprecated) | — | no size scaling per language |
| `--price-xl`…`--price-sm` | same names | §5.5 | new values |

### 5.2 Colour, light theme

| Token | Value | Role |
|---|---|---|
| `--ground` | `#FDFCFA` | page floor |
| `--paper` | `#FFFFFF` | cards with content, fields, sheets, menus, dialogs |
| `--niche` / `--stage` | `#F3F1EE` | the product ground, flat in light (`--product-ground`) |
| `--niche-2` | `#EAE7E3` | well hover overlay (`--product-ground-hover`), placeholders |
| `--band` / `--on-band` / `--on-band-2` | `#17181C` / `#FFFFFF` / `#B9BAC0` | release band; `--toast` = `#17181C` |
| `--line` / `--line-2` / `--line-strong` | `#E6E3DF` / `#C9C5BF` / `#85827D` | hairline / chip and divider / control boundary |
| `--line-glass` | `rgb(20 21 24 / .08)` | edge of glass bars and floating layers |
| `--ink` / `--ink-2` / `--ink-3` | `#141518` / `#55575D` / `#9C9A96` | text |
| `--red` / `--red-hover` / `--red-deep` | `#E5132B` / `#CC0F25` / `#9E0B1E` | brand red (the logo trace; the owner confirms it, §14) |
| `--red-ink` / `--red-tint` | `#C8102A` / `#FDECEE` | red text / red tint |
| `--hero` / `--on-band-key` | `#BE0F27` / `#BE0F27` | crimson band base / white-key label |
| `--danger` / `--danger-tint` | `#B42318` / `#FEF3F2` | errors |
| `--ok` / `--ok-tint` | `#157A3E` / `#E7F4EB` | in stock, verified, guest strip |
| `--warn` / `--warn-tint` | `#8A5300` / `#FFF3DF` | partial compatibility, «قبل أن تطلب» |
| `--info` / `--info-tint` | `#0B5FB8` / `#EAF2FC` | info callouts |
| `--demo-ink` / `--demo-bg` | `#7A4A00` / `#FFF4E2` | the demo marking |
| `--focus` / `--focus-on-color` | `#141518` / `#FFFFFF` | focus ring / ring on crimson and platform surfaces |
| `--glass` / `--glass-filter` / `--glass-solid` | `rgb(255 255 255 / .90)` / `saturate(1.8) blur(20px)` / `#FFFFFF` | thin bars; solid fallback |
| `--scrim` / `--scrim-menu` | `rgb(14 15 18 / .44)` / `rgb(14 15 18 / .08)` | under sheets and dialogs / under the mega menu |
| `--selection` | `rgb(20 21 24 / .14)` | text selection |
| `--on-red` / `--on-color` | `#FFFFFF` | labels on red; text on crimson and platform surfaces (solid, never translucent) |
| `--on-image` | `rgb(255 255 255 / .88)` | icon buttons and chips on photos |

**Derivation.** `--hero` is `--red` darkened by about 17% (`color-mix(in oklab, var(--red) 83%, black)`). If the owner confirms a different brand red, recompute `--red-hover`, `--red-deep`, `--red-ink` and `--hero` the same way and re-run `node scripts/contrast.mjs`.

### 5.3 Colour, dark theme ("charcoal with lit grounds") and platform tokens

| Token | Value | Note |
|---|---|---|
| `--ground` | `#121316` | never pure black |
| `--paper` | `#1B1C20` | cards, fields, sheets, menus, dialogs |
| `--niche` / `--stage` | `#25272D` | the wells and the stage paint the lit spot on top (§6.4) |
| `--niche-2` | `#2C2E35` | |
| `--cab` | `#1E1F25` + `--rim` | cabinet base (hero, tiles, platform bands, wallet card) |
| `--band` | `#1E1F25` + `--rim` | the release band becomes a raised panel |
| `--on-band` / `--on-band-2` | `#F4F3F1` / `#B5B6BC` | |
| `--line` / `--line-2` / `--line-strong` | `#2F3137` / `#45474E` / `#7E8088` | `--line-strong` 4.32:1 on paper |
| `--line-glass` | `rgb(255 255 255 / .08)` | |
| `--ink` / `--ink-2` / `--ink-3` | `#F4F3F1` / `#B5B6BC` / `#6E7077` | |
| `--red` / `--red-hover` / `--red-deep` | `#E5132B` / `#CC0F25` / `#7E0817` | the brand never shifts; hover darkens in both themes |
| `--red-ink` / `--red-tint` | `#FF6B79` / `#3A1519` | |
| `--danger` / `--danger-tint` | `#FF8A80` / `rgb(255 138 128 / .10)` | |
| `--ok` `--warn` `--info` | `#4CC984` `#F2B550` `#6CB2FF` | tints `#15291D` `#2E2414` `#142438` |
| `--demo-ink` / `--demo-bg` | `#F4C56A` / `#2A2316` | never inverted into a bright bar |
| `--focus` | `#F4F3F1` | |
| `--glass` / `--glass-filter` / `--glass-solid` | `rgb(27 28 32 / .88)` / `saturate(1.6) blur(20px) brightness(.9)` / `#1B1C20` | |
| `--scrim` / `--scrim-menu` | `rgb(0 0 0 / .60)` / `rgb(0 0 0 / .30)` | |
| `--toast` | `#2A2C32` | so it separates from the page |

Unchanged between themes: `--red`, `--hero`, `--on-band-key`, the platform surfaces and every layout. In dark mode the crimson band and the colour tiles do not render as slabs: they become cabinets (§6.3). Two numeric switches carry that: `--lit` (1 in dark) and `--unlit` (1 in light) — the light layers multiply their opacity by them and the tiles mix `--plat` with `--cab` by them, so a nested theme island is always right.

| Platform | `--plat-*` (tile and band surface) | `--plat-*-deep` (tile wall) | `--dot-*` light | `--dot-*` dark | `--gel-*` dark light |
|---|---|---|---|---|---|
| Nintendo | `#E60012` | `#A8000D` | `#E60012` | `#FF5247` | `255 106 90` |
| PlayStation | `#0070D1` | `#00508F` | `#0070D1` | `#3D86FF` | `90 140 255` |
| Xbox | `#107C10` | `#0A560A` | `#107C10` | `#34C25D` | `53 196 106` |
| Handheld PCs (violet) | `#5B3FD9` | `#3F2AA3` | `#5B3FD9` | `#9077FF` | `154 125 255` |
| Brand (campaigns, hero cabinet) | — | — | — | — | `255 70 88` (`--gel-brand`) |

A subtree names its platform with `data-gel="xbox"`; that sets `--plat`, `--plat-deep`, `--dot` and `--gel` for it. Platform colour is a **surface in four places only**: the platform tiles, the platform hub band, the device-hub head, and the hero band during a platform campaign. Everywhere else it is the **8px dot** beside the platform name in text (nav, chips, cards, mega menu, filters, compare, admin columns), or the 3px nav underline. No drawn platform logos until the owner confirms the rights (§14).

### 5.4 Contrast (computed: `node scripts/contrast.mjs`)

The script reads `tokens.css`, resolves each theme, composites translucent colours over their real backdrop and checks 100 required pairs (all pass today), 2 demonstrations and 6 informational rows. Highlights:

| Theme | Pair | Ratio | Needs |
|---|---|---|---|
| Light | ink on ground / paper / niche | 17.81 / 18.26 / 16.20 | 4.5 |
| Light | ink-2 on ground / paper / niche / niche-2 | 7.04 / 7.22 / 6.41 / 5.86 | 4.5 |
| Light | red-ink on ground / paper / niche / red-tint | 5.75 / 5.89 / 5.23 / 5.17 | 4.5 |
| Light | danger on paper / danger-tint | 6.57 / 6.05 | 4.5 |
| Light | ok on paper / niche / ok-tint | 5.41 / 4.79 / 4.77 | 4.5 |
| Light | warn on warn-tint · info on info-tint · demo-ink on demo-bg | 5.77 · 5.56 · 6.87 | 4.5 |
| Light | white on the red key / red-hover · white on crimson | 4.71 / 5.73 · 6.39 | 4.5 |
| Light | the on-band label on the white key | 6.39 | 4.5 |
| Light | white on Nintendo / PlayStation / Xbox / handheld (flat) | 4.80 / 4.95 / 5.37 / 6.65 | 4.5 |
| Light | white on PlayStation under an 8% sheen | **4.35 — demonstration: no sheen behind tile text** | 4.5 |
| Light | white / on-band-2 on the graphite band | 17.74 / 9.16 | 4.5 |
| Light | ink / ink-2 on 90% header glass over black (worst case) | 14.63 / 5.79 | 4.5 |
| Light | line-strong on paper / ground | 3.83 / 3.73 | 3 |
| Light | red key face on ground · platform dots on paper · focus | 4.59 · 4.80–6.65 · 17.81 | 3 |
| Dark | ink on ground / paper / niche / cabinet | 16.75 / 15.35 / 13.46 / 14.82 | 4.5 |
| Dark | ink-2 on ground / paper / niche / cabinet | 9.18 / 8.42 / 7.38 / 8.12 | 4.5 |
| Dark | red-ink on ground / paper / red-tint | 6.75 / 6.19 / 5.86 | 4.5 |
| Dark | danger / ok / warn / info on ground | 8.14 / 8.84 / 10.17 / 8.36 | 4.5 |
| Dark | ink / ink-2 on 88% dark glass over white (worst case) | 10.72 / 5.88 | 4.5 |
| Dark | line-strong on paper / ground · red key on ground / cabinet | 4.32 / 4.72 · 3.94 / 3.49 | 3 |
| Dark | dark dots on ground | 5.79 / 5.35 / 7.98 / 5.55 | 3 |
| Dark | the light handheld dot on the dark ground | **2.79 — demonstration: dots switch to dark values** | 3 |
| Dark | black hardware on the lit spot centre / on a flat well | 2.12 / 1.17 | (separation) |

Rules: labels on red, crimson or a platform surface are 600 weight and at least 14px (13/600 for one-line facts and counts). Text on crimson and on platform surfaces is **solid white**, never translucent (90% white falls to 4.04:1 on Nintendo). On the graphite band, secondary lines use `--on-band-2`. `--ink-3` never carries information. Every text run on a tile, a band or a cabinet is measured on the real composite in QA.

### 5.5 Type

**Families and files** (self-hosted in `public/fonts`, content-hashed, `font-display: swap`, split by `unicode-range`):

| Face | Weight | Subsets (file) | Size |
|---|---|---|---|
| Noto Kufi Arabic (static instance) | 700 | arabic `kufi-arabic-700` · latin `kufi-latin-700` · latin-ext `kufi-latin-ext-wght` (variable, served at 700, on demand) | 43.9 · 10.4 · 16.5 KB |
| IBM Plex Sans Arabic | 400 / 600 | arabic `plex-arabic-400/600` · latin `plex-latin-400/600` · latin-ext `plex-latin-ext-400/600` (on demand) | 42.8/45.7 · 19.2/20.5 · 6.7/6.7 KB |

Licences: `public/fonts/OFL-Noto-Kufi-Arabic.txt`, `public/fonts/OFL-IBM-Plex-Sans-Arabic.txt` (SIL OFL 1.1). **Preload exactly two** (`app/styles/fonts.ts`, read by `root.tsx`): Plex 400 and Kufi 700 of the page's script (86.7 KB on Arabic and Sorani pages, 29.5 KB on English). Measured on the running site: an Arabic home page requests six files, 182.5 KB, no Kufam, no Plex 500; a page that draws a latin-ext character (ō) adds a 6.7 KB file. `html` sets `font-synthesis-weight: none`: a request for 500 draws 400, 700 in Plex draws 600.

**Fallbacks** with matched metrics (`fonts.css`): "Kufi Fallback" and "Plex Fallback" against Segoe UI (Windows), "Kufi Fallback Noto" and "Plex Fallback Noto" against Noto Sans Arabic (Android; measured from Google's variable cut as a stand-in). size-adjust = web width ÷ local width over the same storefront copy; ascent/descent overrides = the web font's own metrics ÷ size-adjust. iOS could not be measured.

Coverage: both faces contain ڕ ڵ ۆ ێ ە ڤ گ چ پ ژ ک ی ھ ئ. Digits: Kufi draws all ten at 572 units and Plex at 600, so both are tabular by default; every number still sets `font-variant-numeric: tabular-nums lining-nums`.

**Scale** (integer px; sizes step at breakpoints, never with `clamp()`; the `--fs-*` tokens and the `--type-*` roles):

| Role | Class / token | Face | 360–767 | 768–1023 | 1024–1279 | ≥1280 | Line height ar·ckb / en |
|---|---|---|---|---|---|---|---|
| Display (hero headline) | `type-display` | Kufi 700 | 28 | 40 | 48 | 56 | 1.22 / 1.12 |
| Page title h1 | `type-h1` | Kufi 700 | 26 | 30 | 32 | 36 | 1.3 / 1.2 |
| Section h2 | `type-h2` | Kufi 700 | 22 | 24 | 26 | 28 | 1.3 / 1.25 |
| Tile name | `type-tile` | Kufi 700 | 18 | 20 | 22 | 22 | 1.25 |
| Release-day numeral | `type-day` | Kufi 700 | 44 | 44 | 56 | 56 | 1 |
| Codes (order number, account number) | `type-code` | Plex 600, tabular | 20 | 20 | 20 | 20 | 1.3 |
| h3, group, sheet and dialog titles | `type-h3` | Plex 600 | 18 | 18 | 18 | 18 | 1.45 |
| Lead | `type-lead` | Plex 400 | 16 | 18 | 18 | 18 | 1.6 / 1.5 |
| Body | `type-body` | Plex 400 | 16 | 16 | 16 | 16 | 1.7 / 1.55 |
| Card title | `type-card` | Plex 600 | 15 | 15 | 16 | 16 | 1.45 |
| Small, labels, chips, fact rows | `type-sm` / `type-sm-strong` | Plex 400 / 600 | 14 | 14 | 14 | 14 | 1.5 |
| Button label | `type-button` / `type-button-sm` | Plex 600 | 16 on 48px · 14 on 40px | | | | 1.25 |
| Caption, meta, hints, tab labels | `type-xs` / `type-xs-strong` | Plex 400 / 600 | 13 | 13 | 13 | 13 | 1.5 |
| Tag, cart bead | `type-tag` | Plex 600 | 12 | 12 | 12 | 12 | 1.25 |
| Price xl (hero, PDP, wallet balance) | `--price-xl` | Kufi 700 | 30 | 32 | 34 | 36 | 1.15 |
| Price lg (buy bar, totals) | `--price-lg` | Kufi 700 | 22 | 24 | 24 | 24 | 1.2 |
| Price md (cards) | `--price-md` | Kufi 700 | 18 | 18 | 18 | 18 | 1.2 |
| Price sm (lines, summaries) | `--price-sm` | Kufi 700 | 16 | 16 | 16 | 16 | 1.3 |
| Currency «د.ع» / IQD | `--cur-*` | Plex 600, `--ink-2` (white on colour) | xl 16 → 18 from 1024 · lg 14 · md 13 · sm 13 | | | | 1 |

The 1.0 role names stay as aliases on the v2 scale: `type-hero` = display, `type-title` = h1, `type-section` = h2, `type-sub` = h3, `type-strong` = card, `type-label` = sm-strong, `type-caption` = xs, `type-tab` = 13/400; `type-data`, `type-data-sm`, `type-kpi` are the admin's utility roles. A page at one width renders at most 12 sizes.

**Rules**

- Kufi only at 18px and up, plus prices (digits only). Never for body, buttons, card names or fields.
- Arabic and Sorani text ≥13px. 12px exists only for 600-weight tags and the cart bead.
- No `letter-spacing`, in any language. `text-wrap: balance` on display, h1 and h2. Card names wrap to two lines and are never truncated to one.
- Numbers: Western digits, comma thousands, integer dinars, the currency after the figure with a no-break space («667,750 د.ع», "667,750 IQD"), and `aria-label="667,750 دينار عراقي"` on the price element. Money never animates, except the engine's currency `NumberMorph`.
- Dates: Iraqi month names in Arabic («19 تشرين الثاني 2026»); numeric dates day/month/year (18/11/2026). Counters are words: «1 من 6».
- **Sorani (ckb):** same faces; headings use Plex 600 (`--font-head: var(--font-text)`, `--w-head: 600`) until a native Sorani reader approves Noto Kufi's ە and ڵا in a hero, a section head and a tile name. Prices stay in Kufi. A ZWNJ goes before the ezafe after a Latin word ("Switch‌ی").
- **English:** same faces, body line height 1.55, display 1.12, no size scaling.

### 5.6 Space, layout, grid and breakpoints

| Token | Value |
|---|---|
| `--s-1` … `--s-20` | 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80 |
| `--gutter` | 16 · 24 from 768 · 32 from 1024 |
| `--page-max` | 1280 (side margins of 80 at 1440; the `page` utility) |
| `--gap-card` / `--gap-row` | 12 / 24 · 16 / 24 from 768 · 20 / 32 from 1024 |
| `--gap-section` | 40 · 56 from 768 · 72 from 1024 |
| `--target` | 44 (every pressable thing; pseudo-element hit areas for 32–40px visuals) |
| `--h-btn` / `--h-btn-sm` | 48 / 40 (the only two button heights) |
| `--h-field` / `--h-chip` / `--h-row` / `--h-option` / `--h-option-pay` | 52 / 40 / 56 / 64 / 72 |
| `--h-strip` / `--h-header` / `--h-nav` | 28 / 56 below 1024, 64 from 1024 / 44 |
| `--h-tabbar` / `--h-taskbar` / `--h-checkout` | 64 / 72 / 56 below 1024, 64 from 1024 (plus the safe area at an edge) |
| `--shell-top` / `--shell-bottom` | sticky top and fixed bottom chrome of the page, set by the shell on `:root`; `html { scroll-padding-block: calc(var(--shell-top) + 12px) calc(var(--shell-bottom) + 12px) }` (base.css) |

| Range | Columns | Gutter | Shell | Product grid | What else changes |
|---|---|---|---|---|---|
| 360–599 (design at 390) | 4 | 16 | 28px demo strip (scrolls away) + 56px sticky glass header; floating tab bar | 2-up (173px at 390) | rails show 2.15 cards; tiles 2×2; trust facts 2×2; footer accordions; PDP stage full bleed 1:1 with the buy bar; checkout bar 56 |
| 600–767 | 4 | 16 | same; tab bar max 520px, centred | 2-up | the strip shows its full sentence |
| 768–1023 | 8 | 24 | same shell as phones | 3-up | hero splits copy and product; tiles 4-up; side sheets (420px); PDP single column, 4:3 stage; checkout single column, max 640 |
| 1024–1279 | 12 | 32 | desktop header 64 + 44 = 108, no strip (compact demo chip), no tab bar | home shelves 4-up; listing 264px sidebar + 3-up | PDP 7/5 with a sticky gallery; checkout 7/5 with a sticky summary holding the commit key |
| ≥1280 (design at 1440) | 12 in the 1280 wrap | 32 | same, full demo chip, utility links in row 1, a 560px search | home shelves 5-up whole cards; listing sidebar + 4-up | hero and all four tiles inside the first 900px |

Tailwind breakpoints: `sm` 600 · `md` 768 · `lg` 1024 · `xl` 1200 (the admin's) · `2xl` 1280; new storefront code uses `md`, `lg`, `2xl`. **Equal edges:** every block starts on the wrap's start line and ends on its end line; only native rails (the gutter kept as scroll padding) and the phone PDP stage cross the gutter. No horizontal page scroll at 360 in any locale.

### 5.7 Radius, elevation, z-index

**Radius (today's scale, no new values):**

| Token | Value | Storefront use |
|---|---|---|
| `--r-xs` | 8 | box-art and digital-card corners, thumbnails ≤48px, the `/` shortcut chip |
| `--r-sm` | 12 | buttons, fields, option cards, segmented cells, thumbnails 56–76px, menu rows, the toast thumbnail |
| `--r-lg` | 20 | product wells, content cards and panels, platform tiles, entry cards, the trust card, toasts, menus, mega-menu bottom corners, sheet top corners on phones |
| `--r-xl` | 28 | hero band, PDP stage (from 768), release band, dialogs |
| `--r-full` | 999 | chips, badges, pills, icon buttons, search, steppers, tab bar, bead, dots |
| `--r-check` | 6 | checkbox only |

`--r-md` (16) stays for the admin. A storefront view renders at most these six values.

**Elevation — the whole shadow vocabulary (seven recipes):**

| Token | Recipe (light; dark in brackets) | Used by |
|---|---|---|
| none | — | everything at rest: cards, wells, panels, chips, fields |
| `--clay-cap` + `--clay-cast` (the clay recipe) | cap `inset 0 1px 0 rgb(255 255 255 / .22)`; the static wall layer is a 2px block in `--wall-c` with the cast `0 8px 16px -10px rgb(0 0 0 / .10)` (`.32`) | primary key, on-band key, platform tiles |
| `--e-bar` | `0 1px 0 var(--line-glass)` | sticky header and checkout bar |
| `--e-float` | `0 12px 32px -12px rgb(20 21 24 / .18), 0 0 0 1px var(--line-glass)` (`rgb(0 0 0 / .60)`) | tab bar, task bars, buy bar, toast |
| `--e-overlay` | `0 24px 64px -16px rgb(20 21 24 / .24), 0 0 0 1px var(--line-glass)` (`.70`) | mega menu, menus, suggestions, sheets, dialogs |
| `--e-art` | `0 8px 18px -8px rgb(0 0 0 / .28)` (`.50`) | box art and digital-card faces only |
| `--rim` | dark only: `inset 0 1px 0 rgb(255 255 255 / .07), 0 0 0 1px var(--line)` | cabinets, the dark release band |

No resting shadow on any card. A hover lift never adds a shadow. Shadows, blur and colours never animate. Hairlines are borders, not shadows.

**z-index** (unchanged): `--z-raised` 1, `--z-sticky` 100, `--z-nav` 200, `--z-scrim` 300, `--z-sheet` 310, `--z-dialog` 400, `--z-toast` 500, `--z-fly` 600, `--z-intro` 700.

---

## 6. Materials

### 6.1 Clay v2 — exactly two objects

| | Primary key | On-band key (light theme) | Platform tile |
|---|---|---|---|
| Face (flat, no gradient) | `--red`; hover `--red-hover` | `#FFFFFF` (`--on-band-face`) | `--plat-*` |
| Wall (2px, zero blur, static layer) | `--red-deep` | `--red-deep` | `--plat-*-deep` |
| Label | white, Plex 600 | `--on-band-key`, Plex 600 | white |
| Cast | `--clay-cast` on the wall layer | same | same |

Structure (`materials.css`): `<button class="key key--primary"><span class="key__cap">…</span></button>`. `.key::before` is the static wall (it owns the cast) and hangs 2px below the box, so the key is exactly 48 or 40px in layout; `.key__cap` is the face and moves. Press: the cap travels 2px onto the wall in 80 ms (ease-out) and returns on the `press` spring (260 ms). Hover (pointer devices): cap −1px (tiles −2px). Keys set `--press-scale: 1; --press-sink: 0` on clay variants so the engine moves only the cap; flat keys take the engine's soft (.98) and icon (.94) presses. Disabled: no wall, no cast, a `--niche-2` face, an `--ink-3` label and the reason in text beside it. In dark the on-band key renders as the red primary (the band is a cabinet), by tokens alone.

### 6.2 Glass v2 — thin fixed chrome only

The phone header, the desktop header's two rows, the tab bar, the buy bar, task bars, the checkout bar and the header strip of a sheet. `.glass`: `background: var(--glass); backdrop-filter: var(--glass-filter)` with the `--e-bar` edge; `.glass--bottom` / `.glass--float` take `--e-float`. At most two live panes per viewport; under an open sheet or dialog the page's glass turns `--glass-solid`. Solid also without `backdrop-filter`, under `prefers-reduced-transparency`, on `.fx-low` / the engine's lite tier and under `prefers-contrast: more`. **Opaque:** mega menu, menus, search suggestions, sheet bodies, dialogs, toasts. `.glass--static` is retired (it renders as an opaque `--on-image` surface until its call sites move). No element with a `view-transition-name` may contain a glass layer (engine, `docs/MOTION.md`).

### 6.3 Light — showcases only

One radial light per showcase, painted once, never animated except its layer's opacity (`.band__light`, `.ptile__light`).

| Showcase | Light theme | Dark theme ("cabinet") |
|---|---|---|
| Hero band (`.band--hero`) | base `--hero`; one radial in brand red behind the product (inline end from 768; top centre on phones); a contact ellipse `--hero-contact` under it; the copy sits where the light is below 30% | base `--cab` + `--rim`; `rgb(var(--gel-brand) / .55)` behind the product, a floor pool `rgb(var(--gel-brand) / .40)`, a neutral key light `rgb(255 255 255 / .09)`; copy in `--ink` / `--ink-2`; the action is the red primary |
| Platform tile (`.ptile`) | flat `--plat-*`; one radial `rgb(255 255 255 / .14)` behind the hardware only | `--cab` + `--rim`; `rgb(var(--gel-*) / .50)` from the bottom inline-end corner; name `--ink`, count `--ink-2` |
| Platform hub band, device-hub head (`.band--platform`, `.band--device`) | as the tile, without clay | as the tile cabinet; sibling hubs cross-fade two pre-painted light layers |
| Wallet card (`.band--wallet`) | `--hero`, no light | `--cab` + `rgb(var(--gel-brand) / .40)` |
| Release band (`.release`) | `--band` graphite, no light | `--band` + `--rim` |

Hover on a cabinet (pointer devices): the light layer's opacity goes from .86 to 1 in 240 ms. Text colour comes from the band (`--on-showcase`: white in light, `--ink` in dark); focus rings inside a light-theme band are white (`--focus-showcase`).

### 6.4 The product ground — always neutral

Light: flat `--niche`. Dark: `radial-gradient(62% 58% at 50% 46%, #4C4F56 0%, #33353B 48%, #222327 100%)` (`--product-ground`). It covers wells (`.niche`), the PDP stage (`.stage`), thumbnails, cart and summary lines, the toast thumbnail and category tiles. Images are contained and bottom-aligned with a CSS contact ellipse (`::before`, 44% wide, 6% tall, 7% from the bottom, `--contact`). No platform light behind a product that is being judged; no tilt; no `filter`.

### 6.5 Flat

Everything else: paper cards and panels with a `--line` hairline (`.panel`), no shadow, no gradient. Controls are flat: secondary keys are paper with a 1px `--line-strong` boundary; chips are pills with a `--line-2` border; selected means an ink fill.

### 6.6 Performance tiers and preference fallbacks

| Signal | Result |
|---|---|
| no `backdrop-filter`, `prefers-reduced-transparency`, `.fx-low`, `html[data-motion="lite"]` | glass becomes `--glass-solid`; nothing inflates |
| `prefers-reduced-motion` / `data-motion="reduced"` | the pressed state without transition; instant swaps; no light fades; no hover parallax |
| `prefers-contrast: more` | hairlines become `--line-strong`; glass solid; showcase lights hidden; wells and clay faces outlined |
| `forced-colors` | borders on buttons, chips, tags, fields and wells; selected = a Highlight outline; dots keep their colour |

Budget: the hero image is the only image preload (`fetchpriority="high"`); every image slot has its size or an aspect ratio; the well colour is the placeholder (no skeletons, no shift); lists longer than about 40 cards are virtualised. Core Web Vitals must be measured on a mid and a low-end Android device before sign-off.

### 6.7 Lint rules (`node scripts/lint-design.mjs`; `--strict` in CI)

Kept from 1.0: logical properties only; no colour literal outside `tokens.css`; `backdrop-filter` only in `materials.css` (`<Glass>`); no mask or clip-path on a glass rule; no live glass in a list; no CSS `filter` (images included) and no SVG filters; motion animates only transform, translate, scale, rotate and opacity; no letter-spacing; `<img>` sized; `view-transition-name` never static; ui namespaces have the same keys in ar, en and ckb.

Added or changed by v2 (they fail in `app/styles` now and are reported for the kit and the areas until stage 4):

- `red` — `--red`, `--red-hover`, `--hero` only in the primary key, the card add button, the bead, the fly bead, the logo, the hero and wallet bands and the current step's disc.
- `gel` — `--gel-*` only in the dark cabinet light layers.
- `plat` — `--plat-*` surfaces only on `.ptile` and `.band`.
- `legacy-token` — the 1.0 material tokens and their utilities only inside `[data-density="admin"]`, `admin.css` and the admin routes.
- `type` — no `font-weight: 500` (`font-medium`), no non-integer font size.
- `radius` — only `--r-*` tokens (the checkbox's 6px is `--r-check`).
- `shadow` — box shadows only from the elevation tokens.
- `blend` — `mix-blend-mode` only in the opaque-photo rule.
- `primary-count` — one `variant="primary"` (or the alias `commit`) per route view; card add buttons are neutral.
- `deprecated` — `Socket`, `PlatformBank`, `StageTag`, `PlatformGlyph`, `variant="commit" | "ink" | "quiet"`, `<Glass variant="static">`.

Escape hatch, always with a reason: `// lint-design: allow <rule> — why`.

---

## 7. TamTam Motion Engine

The engine is unchanged (`app/motion`, `docs/MOTION.md`); v2 tunes how the system uses it. Where the text below says "commit key", "key bank" or "stage relight", read the v2 names: the primary key, the platform tiles, the hub band relight.

### 7.0 v2 tuning

| Moment | Engine piece | v2 tuning |
|---|---|---|
| Press, clay | `data-press="clay"` on the primary key and the tiles | the cap travels 2px onto its 2px wall in 80 ms and returns on `press` (260 ms, 8% overshoot); haptic `tap` on «أضف إلى السلة» and the checkout commit only |
| Press, everything else | `soft` (.98) on cards, chips, option cards, secondary keys; `icon` (.94) on icon buttons | unchanged values (materials.css maps keys onto them) |
| Hover (pointer only) | CSS | card photo 1.03 in its well (240 ms) + the well overlay to `--niche-2` (opacity, 160 ms) + title underline; tile −2px and its hardware −4px / 1.02 (`inflate`); cabinet light .86 → 1; link arrow nudges 3px |
| Content arriving | `<Bubble>` / `<BubbleGroup>` | from **.94**, 45 ms stagger, six at most; only content that streams in after first paint; never the hero or LCP image, never on scroll |
| Card → product | `MotionLink nav="zoom"` + `SharedElement` | `settle` 410 ms, no overshoot; the 1:1 well grows into the 1:1 phone stage |
| Fly to cart | `flyToCart(source)` | engine defaults; the count and `aria-live` update first; the toast appears after landing |
| Sideways push | `nav="push"` | checkout steps; sibling platform hubs (Nintendo 1, PlayStation 2, Xbox 3, handheld 4) with the band relight in dark |
| Menus, sheets | `materialize` / `useSheet` | mega menu drops 8px (220 ms in, 140 ms out) with `--scrim-menu`; sheets on the `sheet` spring |
| Order success | CSS, one shot | the check disc .86 → 1 with opacity on `inflate`, once; none under reduced motion |
| Pending navigation | CSS | a 2px `--ink` progress bar under the header after 150 ms on GET steps, plus the key's loading state |
| Reduced motion | engine tier | the pressed state without travel animation, 120 ms cross-fades for pages and sheets, no flight, no hover parallax, no light fade |

Principles: feedback starts on `pointerdown`; navigation and data requests fire at the same moment as the animation, never after it; state changes first and animation is decoration; everything is interruptible; only `transform` and `opacity` move; shadows and blur are static.

### 7.1 Tokens

**Springs** (mass 1; `stiffness = (2π / response)²`, `damping = 4π × dampingRatio / response`)

| Preset | `{response, dampingRatio}` | Stiffness / damping | Overshoot | Settles in | Intended use |
|---|---|---|---|---|---|
| `press` | `{0.16, 0.62}` | 1542 / 48.7 | 8% | 260ms | Key release, chip and thumbnail settle, toggle |
| `squish` | `{0.26, 0.50}` | 584 / 24.2 | 16% | 510ms | The cart bead receiving a product, small objects only |
| `inflate` | `{0.28, 0.68}` | 504 / 30.5 | 5% | 430ms | Content inflating into reserved space, tile hardware on hover, intro layers |
| `settle` | `{0.30, 1.00}` | 439 / 41.9 | none | 410ms | Shared-element zoom, sideways push, anything large (large things never overshoot) |
| `sheet` | `{0.30, 0.86}` | 439 / 36.0 | 0.5% | 390ms | Sheets, menus, drag release (carries the finger's velocity) |

In CSS each preset is a `linear()` curve with its settle time (`--spring-*`, `--spring-*-t`, `tokens.css`). In JS (drag, sheets, rails with velocity) the same `{response, dampingRatio}` pairs drive WAAPI keyframes generated from the spring's step response; no `requestAnimationFrame` loops. Where `linear()` is unsupported the cubic-bezier fallbacks below are used with the duration tokens.

**Durations**

| Token | Value | Use |
|---|---|---|
| `--t-press` | 80ms | Press-down; feedback must be visible within this |
| `--t-exit` | 140ms | Anything leaving |
| `--t-micro` | 160ms | Chips, toggles, digit roll, the well's hover overlay |
| `--t-release` | 180ms | Key release (fallback curve) |
| `--t-theme` | 200ms | Theme cross-fade |
| `--t-reveal` | 240ms | Inflate (fallback curve), card photo hover |
| `--t-sheet` | 280ms | Sheets and menus (fallback curve) |
| `--t-page` | 320ms | Shared-element zoom and push (fallback curve) |
| `--t-fly` | 460ms | Fly to cart: `420ms + 0.3ms × distance in px`, capped at 600ms |

Nothing outside the intro lasts longer than 600ms.

**Easing curves**

| Token | Curve | Use |
|---|---|---|
| `--ease-squish` | `cubic-bezier(.34,1.56,.64,1)` | Fallback for `press`, `squish`, `inflate` |
| `--ease-settle` | `cubic-bezier(.2,.8,.2,1)` | Fallback for `settle`, `sheet`; entrances |
| `--ease-exit` | `cubic-bezier(.4,0,1,1)` | Exits |
| `--ease-water` | `cubic-bezier(.4,0,.2,1)` | Symmetric moves: push, digit roll, light cross-fade |

### 7.2 Grammar

Each material moves in exactly one way: **clay travels and squishes, glass slides, light fades, flat things do not move.**

**Press feedback.** On `pointerdown` the clay cap travels onto its wall in 80ms (`ease-out`); on release it returns on the `press` spring (260ms, 8% overshoot). The wall and the shadow do not move. Flat controls compress softly instead. On hover (pointer devices) a clay cap rises 1px. A light haptic (`navigator.vibrate(8)`) fires on the primary add and checkout commit only, where supported.

**Bubble / inflate reveal** (instead of skeletons). Geometry is reserved first: the well is on screen at its final size in its final colour from first paint. Content that streams in after first paint scales from `.94` with opacity 0→1 on the `inflate` spring; `animation-delay: calc(var(--i) * 45ms)`; at most six items are staggered, the rest appear together; first appearance only. A failed load shows the empty well with a one-line message and a retry key. It never keeps moving.

**Hub relight** (sibling platform hubs, dark theme). The cabinet's light is a cross-fade between two pre-painted layers (opacity only), never a change of `--gel` on a painted element; the hardware swaps with the push.

**Shared-element card → page zoom.** On tap, `view-transition-name` is set on the tapped card's well and image only; the well grows into the stage and the image rides it (`settle`, no overshoot). The page content arrives behind it and never waits for it; the route change and the data request fire on tap. The page opens on the card's already-loaded image and swaps to the larger one when it arrives. Back reverses the same path into the same card with scroll position restored. Without View Transitions: a FLIP transform, then a 120ms cross-fade.

**Sideways push** (sibling contexts: checkout steps, platform hubs). The outgoing view slides 24px toward the trailing side and fades (140ms, exit ease); the incoming view slides in 24px from the leading side and fades in (`settle`). Direction follows reading direction: "next" enters from the inline-end side in both RTL and LTR. Fixed chrome does not move.

**Fly to cart.** In this order:
1. On tap: the cart count, the cart state and the `aria-live` message update immediately. The add button shows a check.
2. A 22px red bead leaves the product image and travels a quadratic arc lifted 70px above the straight line to the cart bead, shrinking to `.55`. Duration scales with distance (`--t-fly`).
3. The cart bead receives it with a squish: `scale(1.4,.68)` → `(.88,1.16)` → `1` over 340ms.
4. Rapid taps each get a bead, at most three in flight; further taps go straight to the count.
5. On failure the count rolls back, the bead returns along the same arc, and a specific message appears beside the key with a retry.

**Sheets and menus.** A sheet rises from the bottom edge on the `sheet` spring with its glass header strip attached; the scrim fades by opacity. While dragging, the sheet follows the finger 1:1; on release it continues with the finger's velocity and either settles open or leaves. Focus moves into the sheet, is trapped, and returns to the trigger on close; `Escape` closes. Menus and the mega menu drop from their trigger with 8px of travel and opacity (`settle`, 220ms in, 140ms out). On tablet and desktop, filters are side sheets from the inline-end edge.

**Theme morph.** `document.startViewTransition()` swaps `data-theme` and cross-fades two snapshots over 200ms, so text is legible in every frame. The red does not change. Without View Transitions, or on the low-end tier, the swap is instant.

**Language and direction morph.** Route, scroll position, cart and every form field's value are kept. The content area slides 16px toward the new reading direction's start and cross-fades (140ms out, 220ms in); fixed chrome cross-fades in place; the hero media and the PDP stage stay where they are as the visual anchor (`data-motion-anchor`). `dir` and `lang` change on `<html>` at the midpoint.

**Currency number morph.** Digits roll per column (160ms, `--ease-water`) in fixed tabular cells, so width never changes. The currency label is visible in every frame. A converted price is never bold and is always labelled as approximate with its rate source and time; the payable dinar amount stays visible beside it. This is the only motion money is allowed.

**Intro — "the lights come on"** (at most 1.4s, an overlay above an already rendered home, skippable from the first frame, shown once per device): the supplied logo layers assemble; the four platform choices are `PlatformTile`s; the line «دورك. اختر منصّتك.» (the one place the game-turn voice stays); «تخطَّ» is a visible secondary button from the first frame; on «ابدأ» the corner objects retreat along their diagonals and the logo travels to its header slot. Returning shoppers never see it; any tap jumps to the end state. No video, no audio.

**Idle motion policy.** Nothing moves at rest. Rails use native scrolling with scroll-snap and the platform's own rubber band; there is no scroll-jacking and no scroll listener.

### 7.3 Reduced-motion equivalents

| Motion | With `prefers-reduced-motion: reduce` |
|---|---|
| Press | The pressed state with no transition |
| Inflate | Content appears in place |
| Hub relight, cabinet light | Instant swap |
| Card → page | 120ms cross-fade |
| Push | 120ms cross-fade |
| Fly to cart | No flight; the count changes and is announced; the add button shows a check |
| Sheet | Appears and disappears with a 120ms fade; drag still works |
| Theme, language | Instant |
| Currency | Number replaces number |
| Intro | Still composition for 300ms, then a 120ms cross-fade |
| Idle | None |

Every function works identically.

---

## 8. Layout grammar

**Grammar.** An open warm-white floor; at most one showcase band at the top of a page and one dark band (release dates) further down; shelves below (a section head with an honest reason line and «عرض الكل», then one rail or grid of whole cards); facts beside every price. One red primary per view. Glass only on fixed bars. Never two sticky bars at the same edge.

**The funnel rule.** Colour density drops as the shopper moves toward paying: home (hero band, tiles, release band) → hubs (one platform band, then flat cards) → product page (a neutral stage, the price with its facts) → cart and checkout (paper, one primary, no showcase).

### 8.1 Chrome budget (shell: `app/routes/storefront/shell/**`)

| Context | 360–1023 | ≥1024 |
|---|---|---|
| Store pages | 28 demo strip (scrolls away) + 56 sticky header = 84 at rest, 56 sticky; bottom: floating tab bar 64 + 10 + safe area | 64 + 44 = 108 sticky (the demo chip lives in the nav row) |
| Product page | as store pages; the buy bar (72 + safe area) replaces the tab bar | 108 |
| Checkout | one 56px bar (64 from 1024), sticky; the summary bar under it scrolls with the page; the task bar (72 + safe area) | 64 |
| Task flows (trade-in, repair, assistant) | 56 header; a task bar replaces the tab bar | 108 |

`--shell-top` and `--shell-bottom` carry these numbers and drive the global scroll padding, so a focused control is never under a bar (WCAG 2.4.11).

### 8.2 Shell

- **Phone header** (56px, sticky, glass, `--e-bar`): the lockup — mascot (28px) + wordmark (22px tall) from 375px, the wordmark alone at 360–374; the search pill (40px visual, 44 hit, `--niche`, «ابحث» below 430px and «ابحث عن جهاز أو لعبة» from 430, never clipped); the cart icon button with the bead. The demo strip above it (`DemoNote variant="strip"`, 28px, not sticky). Task header (pages without a tab bar): back · title · cart.
- **Cart bead:** a 20px `--red` disc, 12/600 white, a 2px ring in the surface colour; the fly-to-cart target; `aria-live` count.
- **Desktop header:** row 1 (64px): lockup (mascot 36 + wordmark 24) · search pill (44px; 560 from 1280 with a `/` chip; 320 at 1024–1279) · from 1280 «استبدل جهازك» and «تتبّع طلبك» · language, account, wishlist, cart. Row 2 (44px): four platform triggers (8px dot + name 15/600 + caret; the whole item is one 44px menu button; a 3px underline in the dot colour on hover, open and current), a separator, الألعاب · الإكسسوارات · المستعمل · الدعم, and the demo chip at the end. Both rows sticky glass with one `--e-bar` edge: 108px at every desktop width.
- **Mega menu:** an opaque `--paper` panel under the header across the wrap, `--line` on top, bottom corners `--r-lg`, `--e-overlay`, `--scrim-menu` behind; a portal sibling of the header; a first-row link «كل منتجات PlayStation · 42»; four columns of at most five short model names with counts; a featured tile (a 1:1 well, name, price). Opens on click or after 140 ms of hover intent.
- **Search:** the pill; phones open a full-screen search sheet. The suggestions panel is opaque (`--e-overlay`, 420px on desktop): 44px thumbnails on `--niche`, typed rows (platform, category, «كل شيء عن الجهاز»), «هل تقصد…», «اعرض كل النتائج (42)»; recent searches only with consent; the active row has a `--niche` fill and an `--ink` start bar.
- **Tab bar** (below 1024): a floating glass pill, 64px, 12px from the sides, 10px + safe area from the bottom, `--r-xl`, `--e-float`, max 520 and centred from 600. الرئيسية · التصنيفات · السلة · المفضلة · حسابي; current = a filled icon in `--red-ink` inside a 56×32 `--red-tint` pill, label 600 `--ink`, `aria-current="page"`. Hidden on the product page, in checkout and task flows and on a cart with items; shown on an empty cart.
- **Task bars:** glass, 72px + safe area, `--e-float`. Cart: «الإجمالي» + the total (price lg, total tone) | «إتمام الطلب». Checkout: the total | the step's primary. Trade-in and repair: «رجوع» | «تابع».
- **Checkout bar:** 56px (64 from 1024): back to the cart · the mascot (a link home) · the step rail `compact` · the «طلب تجريبي» tag · help. No strip, search, nav or tab bar. Phones: a 48px summary bar on `--niche` under it («ملخص الطلب · قطعتان» + the total + chevron).
- **Footer:** on `--niche` with a `--line` on top: the ContactCard row (when channels exist), the lockup and one factual line, four columns (تسوّق · الدعم · عن طمطم · طرق الدفع — words, no unlicensed marks) as 56px accordions below 768, the language and theme segmented controls, the legal row with the precise demo statement. Checkout and task flows: one line of 13px links with 44px hit areas.
- **Categories sheet** (the «التصنيفات» tab): four compact platform tiles 2×2, two wide entry cards (المستعمل والمفحوص, الدعم), a 3-column grid of category tiles, rows for trade-in and tracking, language and theme.
- **Frame pieces:** the skip link «تخطَّ إلى المحتوى» overlays the header (never pushes); the offline banner sticky under the header; the 2px page progress bar; `[tabindex="-1"]:focus:not(:focus-visible) { outline: none }`.

### 8.3 Page templates (owners in brackets; targets measured at 390×844 and 1440×900, Arabic, light, first load)

- **Home** [home]: a visually hidden h1 «طمطم للألعاب: أجهزة وألعاب وإكسسوارات في العراق»; the hero band (`Band kind="hero"`, 16px under the header, `--r-xl`, ≤440px tall at 390): the platform pill, the headline (h2, display, two lines «العب على» / «Nintendo Switch 2», flush to the reading start), the product (the LCP image, never faded in), price xl + «سعر تجريبي», the on-band key «اشترِ Nintendo Switch 2» full width on phones, one line «التوصيل 5,000 د.ع لكل المحافظات · الدفع عند الاستلام»; «تسوّق حسب المنصّة» + `PlatformTiles`; `TrustStrip`; «وصل حديثاً» (section head with dot chips) + a rail; `ReleaseBand` (≥2 real dated items); used units; two entry cards (استبدل جهازك, الدعم); category tiles; personal shelves only with consent. Desktop: the band 420px (copy in 5 columns, product in 7), tiles 4-up, shelves 5-up. Targets: the hero action, price and delivery line above the tab bar at 390; the first tile row at y ≤ 640; the hero and all four tiles inside 900px at 1440; red share ≤35% / ≤40% of the first screen, 8–12% of the page.
- **Platform hub** [catalog]: the hub band (104px phones; 160 from 1024 with a model switcher of 56px paper tiles) with h1, the count and the lead line «التوصيل 5,000 د.ع لكل المحافظات، والدفع عند الاستلام»; category chips with counts; the toolbar; the grid; the device rail after two rows; used for this platform; «اعرض المزيد». Sort «المقترَح»: in stock, then coming soon, then sold out; the platform's consoles lead. First card top ≤ 330px at 390.
- **Category hub, listing, search, compare** [catalog]: a title row (h1 + count + the lead line) instead of a band; dot chips; the toolbar (count, the sort explanation once the data sort makes it true, «الفلاتر (2)» and «الترتيب» on phones, a floating glass pill «الفلاتر | الترتيب» once the toolbar scrolls away); filters as a bottom sheet (<768), side sheet (768–1023) or a 264px sticky sidebar; facets from real data with counts; removable active chips; the sheet foot «امسح الكل» + «اعرض 24 منتجاً». Zero results: an EmptyState with «هل تقصد…», the tiles and a shelf — no sort and no filters. Compare: a sticky tray «قارن (2)»; sticky product headers; «غير موثّق» for missing values.
- **Device hub** [devices]: `Band kind="device"` (200 / 280px) with h1 «كل شيء عن PlayStation 5», a facts row («17 لعبة له في المتجر»), «من 756,500 د.ع» and the on-band key; a sticky chip anchor nav; versions, comparison, specs, verified accessories (state words), games, guides, the assistant row, used units; a one-item section renders a row card; an empty one is hidden.
- **Product page** [product]: the full-bleed 1:1 stage then 56px thumbnails; the platform label; h1; one fact line; price xl + «سعر ومخزون تجريبيان»; «● متوفر · التوصيل 5,000 د.ع لكل المحافظات»; one payment sentence with the transfer rule; versions as OptionCards with their own prices (colours as Swatches); المفضلة · قارن · مشاركة; the facts card (delivery + guest row, payment, returns, warranty as a fact or a question); «قبل أن تطلب»; highlights, «يعمل مع», specs, in the box, «أكمل تجهيزك», «أجهزة مشابهة». No reviews until verified ones exist; no stage orbs, no kind captions. Desktop 7/5 with a sticky gallery and `BuyControls`; phones and tablets the BuyBar. Targets: price, demo badge and stock-and-delivery line above the buy bar (y ≤ 760); stage fill ≥60% for compact hardware.
- **Used** [used]: the list as used rows (grade · battery · warranty · price, «اعرض تقرير الفحص»); the unit page with its own photos first, the InspectionCard straight after the buy box, «سعره جديداً في المتجر …».
- **Quick look** [product]: a sheet with a 4:3 stage, price, the stock-and-delivery line, the version cards and a pinned foot [price | «أضف إلى السلة»].
- **Cart and checkout** [checkout]: cart lines and the summary («الإجمالي» the one red figure), the task bar, one recommendation rail; the empty cart shows the tab bar. Checkout steps «التوصيل» (guest strip on `--ok-tint`, «رقم الموبايل» LTR, the GovernoratePicker, the PreferencePicker with «وقت مفضّل وليس موعداً مؤكداً.»), «الدفع» (72px payment OptionCards, enabled methods only, the transfer panel and its rule), «المراجعة» («أكّد الطلب · 1,513,750 د.ع», the demo-order line). Desktop 7/5 with the sticky summary holding the commit key. Only the 56px bar and the 72px task bar are sticky at 390.
- **Order and track** [checkout]: a success header (72px `--ok-tint` disc, one-shot check), the order code in `type-code` with copy, the five real states, the next-step box by payment, one summary card; track as a centred 560px card.
- **Account** [account], **support** [support], **trade-in** [used], **content** [content]: one centred card width for forms; grouped account nav with a quiet sign-out; WalletBalance on the wallet band; the help centre with four task tiles, the device picker and the ContactCard (or «اكتب لموظف»); one "talk to a person" destination labelled «تحدّث مع موظف»; trade-in as a task flow with one question per screen and the estimate «سعر تقديري» + «بانتظار الفحص»; content in a 720px reading column; policies with one status line «نسخة أولى — قد تتغيّر قبل الإطلاق.».
- **Errors** [content + shell]: 404 with the expanded search, the mascot, compact tiles and the help centre; a missing product with prefilled search; 500 «تعذّر عرض هذه الصفحة» + retry + home; offline navigation is the offline ErrorState, never 500.

**State matrix.** Every template defines loading (reserved geometry + LQIP; bubbles for streamed content), empty (EmptyState with recovery), validation (inline + summary), API failure (a sentence beside the control or ErrorState in place), offline (banner; keys flat with the reason; drafts kept), success (toast, buy bar «عرض السلة», order page), pending review (transfer «بانتظار التحقق», «بانتظار الفحص»), unauthorised (a sign-in link, never a wall) and sold out / coming soon (card states). Every template is checked in light and dark, ar, en and ckb, and under reduced motion.

---

## 9. Components (`app/ui`; their classes: `docs/UI.md` §2)

### 9.1 Deprecation protocol

The kit changes looks behind existing APIs first; old names keep working as aliases (`variant="commit"` renders primary, `ink` renders secondary, `quiet` renders ghost; `PlatformGlyph` and `StageTag` render nothing; `Socket` renders the neutral card add button; `KeyBank` renders a segmented control). Areas migrate their call sites while building their pages. Stage 4 deletes the aliases once `grep` finds no importer, and the lint then forbids them.

### 9.2 Button (`Key`)

| | Primary | Secondary (default) | Ghost | On-band | Danger |
|---|---|---|---|---|---|
| Use | the one action per view that moves the shopper forward | every other action, toolbar buttons | quiet actions in bars and lists («تراجع», «إلغاء») | the action on the crimson hero and wallet bands (dark: renders as the red primary) | destructive confirmations |
| Face | clay red (§6.1) | `--paper`, 1px `--line-strong` | transparent | clay white on a `--red-deep` wall | `--paper`, 1px `--line-strong` |
| Label | white 600 | `--ink` 600 | `--ink` 600 | `--on-band-key` 600 | `--danger` 600 |
| Height / radius | 48 or 40 / `--r-sm` | same | same | same | same |
| Padding | 24 (48), 16 (40); icon 20 at the start, gap 8 | same | 12 | same | same |
| Hover | `--red-hover`, cap −1px | `--niche` fill | `--niche` fill | cap −1px | `--danger-tint` fill |
| Pressed | cap 2px onto the wall | soft .98 | soft .98 | cap 2px | soft .98 |
| Focus | 2px `--focus` ring, 2px offset (white on crimson) | | | | |
| Disabled | flat `--niche-2`, `--ink-3` label, the reason in text beside it | | | | |
| Loading | keeps its width; a spinner takes the start icon's place (or covers the label when there is none); `aria-busy="true"` | | | | |

One primary per view (lint). A button never contains another button. Full width only inside sheets, task bars and the phone hero. Links styled as buttons use `as={LocaleLink}` / `as={MotionLink}`; every key carries `data-press`.

### 9.3 Icon button, wishlist, text link

- **Icon button** (`IconKey`): a 40px circle (36 small, 32 only on product images), always a 44px hit area. `plain` transparent with an `--ink` icon (20; 24 in bars) and a `--niche` hover; `outline` 1px `--line-2` (the default); `onImage` `--paper` at 88% + `--line-glass`; `onColor` a white disc with an ink icon (tiles, bands). `held`: the filled glyph + `aria-pressed`; the heart fills in `--red-ink`. The accessible name names the object.
- **Text link** (`TextLink`): `--ink` 600, 14 (16 in running text), a 1px `--line-2` underline that turns `--ink` on hover, a directional arrow that nudges 3px; inline links always underlined; 44px hit height outside running text; never red; the icon renders outside `.link__text`.

### 9.4 Chips, segmented control, tabs

- **Chip:** a 40px pill (44 hit), `--paper` with 1px `--line-2`, label 14/600; optional count in `--ink-2`; optional 8px platform dot. **Selected:** `--ink` fill, `--paper` label, a 16px check at the start; the count at 72%. Removable chips end with their ×. Single choice: `role="radiogroup"` with roving tabindex and arrow keys that follow the reading direction; multi: `aria-pressed`. A row scrolls sideways on phones and wraps from 768. Chips are state, never action.
- **Segmented:** a 44px `--niche` track, `--r-full`; the selected segment is `--paper` with `--line` and a 600 label. Language (each name in its own script), theme, motion choice, the support sub-navigation.
- **Tabs:** 44px, a 2px `--ink` underline under the current tab, `aria-selected`; only where panels switch in place.

### 9.5 Badges, status, demo marking

| Badge (24px pill, 12/600) | Look | Rule |
|---|---|---|
| «جديد» | `--ink` fill, `--paper` text | only within 30 days of release or listing; never in «وصل حديثاً» |
| «قريباً» | `--paper`, 1px `--line-strong`, 14px calendar | with the release date in the card's action slot |
| «تخفيض» | `--red-tint` fill, `--red-ink` | only with a real previous price |
| Grade «A+ · كالجديد» | `--paper`, 1.5px `--ink` outline; grade in `<bdi>` | used units |
| «نفد» | `--niche-2`, `--ink-2` | |
| «صورة توضيحية» | `--on-image`, `--ink-2`, bottom-start on the photo | used units without their own photos |

One badge per card. **Status:** an 8px dot + words, 13–14: «متوفر» (`--ok`), «نفد حالياً» (`--ink-2`), «قريباً · 19 تشرين الثاني» (`--ink`), «بقي 2» (`--warn`, real stock only, hidden in demo mode), «بانتظار التحقق» (`--warn`). **Demo marking:** `strip` (28px, `--demo-bg`, 13/600 `--demo-ink`, «متجر تجريبي: الأسعار والمخزون للعرض فقط», one link; the documented exception to the 44px rule), `chip` (28px, in the desktop nav row; full text from 1280), `tag` (24px beside a price or order number: «سعر تجريبي», «سعر ومخزون تجريبيان», «طلب تجريبي»; on crimson transparent with a 1px white border at 60% and white text), `line` (13px sentences). Never inverted in dark.

### 9.6 Price

Kufi 700 figures, tabular, steps `xl lg md sm` (§5.5). The currency after the figure in Plex 600 at the fixed size of its step, `--ink-2` (white on colour). Tones: `ink` (every selling price), `sale` (`--red-ink`, only with a real previous price struck beside it at 13px `--ink-2` with a hidden «السعر قبل التخفيض»), `total` (`--red-ink`, the payable total — one red figure per summary), `onColor` (white), `muted` (`--ink-2`, sold out). `PriceTag size="page"` puts «● متوفر · التوصيل 5,000 د.ع لكل المحافظات» under the price. A converted currency stays secondary («≈ …», never bold, never on a key or a total). A broken amount renders «تعذّر عرض السعر», never a number.

### 9.7 Fields

| Part | Spec |
|---|---|
| Label | above, 14/600 `--ink`; optional fields say «(اختياري)»; required fields «*» plus the word for screen readers and `aria-required` |
| Control | 52px, `--r-sm`, `--paper`, 1px `--line-strong`, text 16 (no iOS zoom), padding 16 |
| Hint | under it, 13 `--ink-2`, `aria-describedby` |
| Hover / focus | border `--ink-2` / border `--ink` + the 2px focus ring (an outline, visible on an errored field) |
| Error | a 2px `--danger` border; a 16px alert icon + the message replaces the hint; `aria-invalid`; checked on blur, re-checked per keystroke once shown; on submit one `role="alert"` summary above the form whose items link to the fields, and focus moves to the first invalid field |
| Disabled | `--niche` fill, `--ink-3` text, the reason beside it |
| Phone and code fields | `dir="ltr"`, aligned to the field's start in the page direction, `type="tel"`, `inputmode="tel"`, `autocomplete="tel-national"`, tabular digits |
| Checkbox / radio | 20px, radius 6 / circle, 1.5px `--line-strong`; checked ink fill + white check / a 6px ink ring |
| Switch | 44×26 track, off `--line-strong`, on `--ink`; a 20px `--paper` knob that travels `calc(18px * var(--dir))` on the `press` spring |
| OptionCard | min 64 (payment 72), `--r-sm`, 1px `--line-strong`; radio 20 at the start; title 15/600; one hint line; at the end the option's own price or a 40×28 word mark (no unlicensed logos); checked: a 2px ink border; focus via `:has(:focus-visible)`; the group label repeats the choice |
| GovernoratePicker | looks like a select; opens a sheet (phones) or a listbox (≥1024) of 52px radio rows from the admin's list, the fee line on top, a filter field beyond 12 |
| PreferencePicker | optional 48px cells, 2 columns on phones, 4 from 600: «أي وقت · صباحاً · بعد الظهر · مساءً»; day cells only once the owner configures dispatch days; always «وقت مفضّل وليس موعداً مؤكداً.» |
| Swatch | a 36px dot or a 56px thumbnail on the product ground, 44 hit; selected: a 2px ink ring with a 2px gap; unavailable: a diagonal stroke and the reason in its name; the chosen value printed above the row |

### 9.8 Stepper

A pill 48 (40 compact) with a 1px `--line-2` border; two 40px round ghost icon buttons (44 hit) and a 16/600 tabular count with `aria-live="polite"`. Minus at the start, plus at the end, in every language. Minus is disabled at 1; plus at the stock limit, where «بقي 2 فقط» appears from real stock only. No stepper on the phone PDP.

### 9.9 Product card (`ProductCard`, the well `Niche`, the add button)

The well: 1:1, `--r-lg`, the product ground; badge top-start; wishlist top-end (32 on the image); the image inset by kind (§12) and bottom-aligned with the contact ellipse. Below it, no container: the kind label (8px dot + «جهاز PS5», 13/600 `--ink-2`), the title (`type-card`, two lines, `unicode-bidi: plaintext`, aligned to the page start), at most two facts (13 `--ink-2`), and a foot pinned to the bottom with price md at the start and the add button at the end. The whole card is one link (the title's stretched pseudo-element) with the zoom; the add button and the wishlist sit above it.

**Add button:** a 40px circle, `--paper`, 1px `--line-2`, an ink bag-plus; under the pointer a red fill and a white glyph; after an add a check in `--ok` («{name} في السلة. أضف قطعة أخرى»); a product with required options opens the quick look («اختر نسخة {name}»). Hover: photo 1.03, the well overlay, the title underline; no lift, no shadow.

| State | Badge | Action slot | Other |
|---|---|---|---|
| In stock | none, or «جديد» (≤30 days) | add button | |
| Sale | «تخفيض» | add button | price `sale` + the real previous price |
| Coming soon | «قريباً» | «يصدر 19 تشرين الثاني» + «الطلب يفتح عند وصوله» | no add button, no pre-order |
| Sold out | «نفد» | «نفد حالياً» | photo at 50%; price `muted`; no notify-me |
| Used | grade | «اعرض تقرير الفحص» | «صورة توضيحية»; meta «البطارية 91% · ضمان 30 يوماً»; photo raised 10% |
| Loading / image failed | — | — | the well colour + LQIP at final size / the empty well with «تعذّر تحميل الصورة» and retry |

Layouts `grid` and `row` (a 96px well at the start). A seven-digit price in a card narrower than 170px steps down to price sm.

### 9.10 Used units

Rows (all widths, two columns from 1024): 96px well (`--r-sm`), title 15/600, grade badge, «البطارية 91% · ضمان 30 يوماً · 512GB», price md, «اعرض تقرير الفحص». No add-to-cart from the list. **InspectionCard:** a paper card with a hairline; grade + date + «صور الجهاز نفسه»; checklist rows (icon + words); battery as an `--ink` bar on `--niche-2` with a tabular % or «غير قابل للقياس»; defects with their photos first; accessories; warranty and returns; «سعره جديداً في المتجر 524,750 د.ع». No serial numbers.

### 9.11 Cart line and order summary

- **Cart line:** a 96 / 120px well, the name (link, two lines), the option value only, availability, the stepper (40), the line total (Kufi 16, tabular; a 140px end column on desktop); «إزالة» (44×44) and «نقل إلى المفضلة»; removal leaves the undo row «أزلنا … من السلة.» + «تراجع».
- **Summary:** a paper card, `--r-lg`, hairline: item lines with 64px wells and option values, «المجموع الفرعي», «التوصيل 5,000 د.ع لكل المحافظات», «لديك رمز خصم؟», and «الإجمالي» as the **one red figure** (price lg, total tone). On desktop the commit key sits inside the card («أكّد الطلب · 1,513,750 د.ع»); under it a `TrustStrip line` and, in demo mode, «طلب تجريبي: لن يُشحن الطلب ولن يُحصَّل أي مبلغ.». One term for the payable amount: «الإجمالي».

### 9.12 Gallery and stage

The stage is the neutral product ground: 1:1, full bleed and without radius below 768; 4:3 with `--r-xl` at 768–1023 (and in the quick look); 5:4 with `--r-xl` from 1024, sticky in the 7-column gallery (`.stage--pdp`); the image inset 8% top, 6% sides, 9% bottom. Inside only the counter «1 من 6» (onImage, bottom-start) and the full-screen button (top-end). Thumbnails below: 56 / 76px, `--r-sm`, on `--niche`; selected = a 2px ink ring with a 2px gap; a radiogroup. The full-screen viewer is opaque (`--ground`). A variant change cross-fades the image in 160 ms.

### 9.13 Buy controls, buy bar, toast

- **BuyControls** (≥1024): stepper 48 + primary «أضف إلى السلة» (grows) + an outline wishlist; under them 44px text buttons المفضلة · قارن · مشاركة.
- **BuyBar** (phones and tablets): glass, 72px + safe area, `--e-float`; price lg and the variant (13 `--ink-2`) at the start, the primary (min 168px) at the end; after an add «✓ في السلة» and «عرض السلة (2)»; sold out «نفد حالياً» + «شاهد بدائل»; coming soon the date sentence, no button.
- **Toast:** `--toast` surface (`#17181C`; dark `#2A2C32`), `--r-lg`, `--e-float`, min 64: a 48px thumbnail on `--niche`, a 14/600 title with an ok check («أُضيف إلى السلة»), a 13 `--on-band-2` line, «عرض السلة» as a 40px outlined button (44 hit) and «تراجع» as a ghost; above the tab bar or the buy bar on phones, under the header at the inline end from 1024 (380px). 5 s, paused on hover and focus, `role="status"`, one at a time.

### 9.14 Sheet, dialog, menu

- **Sheet:** a bottom sheet below 768 (top corners `--r-xl`, ≤90% of the viewport), a 420px side sheet from the inline end from 768. A 56px glass header strip (36×5 grabber, title `type-h3`, 44px close); an opaque `--paper` body; a sticky foot (`--paper`, hairline on top) with «امسح الكل» + the primary with the live count. `role="dialog"`, `aria-modal`, focus in and trapped, Escape and the scrim close, focus returns to the trigger.
- **Dialog:** centred, max 440 (phones 100% − 32), `--r-xl`, `--paper`, one sentence of what will happen, at most two buttons; only for irreversible actions.
- **Menu / popover:** opaque `--paper`, `--r-lg`, `--e-overlay`, 44px rows, arrow keys, Escape.

### 9.15 Showcase band, platform tile and dot

- **Band** (`hero` · `platform` · `device` · `wallet`): a base layer, pre-painted light layers (`pointer-events: none`), a hardware layer clipped at the sides and bottom only (`clip-path: inset(-56px 0 0 0 round …)`) so the hardware breaks out of the top and bleeds off the inline end, and the copy. **Headline bidi rule:** `<h2 class="type-display">العب على<br><bdi>Nintendo Switch 2</bdi></h2>`, `text-align: start` — never a separate LTR block; `Switch&nbsp;2`, `PS5&nbsp;Pro` never break.
- **PlatformTile:** phones 2×2 (min 132, padding 16, hardware 92px tall starting 18px above the top), 768–1023 4-up (min 168, padding 20, hardware 58% wide and tile height + 22px), ≥1024 4-up (min 184, padding 22/24, an onColor arrow disc at the bottom start); name and count at the top start (Kufi 18/20/22 white, 13/14 600); the light behind the hardware only; hover cap −2px and hardware −4px / 1.02; focus ring outside the tile in `--focus`; a `compact` variant (96px, hardware inside) for the categories sheet and the 404 page; dark: a cabinet.
- **PlatformLed** = the 8px `--dot` beside the platform name (never alone); **PlatformLabel** = dot + name (13–15/600); the nav adds a 3px underline in the dot colour.

### 9.16 Trust strip, fact list, release band, section head, rails

- **TrustStrip:** one paper card, `--r-lg`, hairline; four cells divided by hairlines (2×2 on phones, one row from 768): a 40px `--red-tint` icon tile (22px `--red-ink` icon), a 15/600 title, a 13–14 `--ink-2` line; each fact only when true in admin settings: the delivery fee, COD (while enabled), «زين كاش أو تحويل إلى بطاقة ماستركارد» / «نراجع كل تحويل قبل تأكيد الطلب», «اطلب بدون حساب». A `line` variant for the cart.
- **FactList:** rows of a 20px icon + a 14–15/600 title + a 14 `--ink-2` line + an optional 44px link, between hairlines.
- **ReleaseBand:** the page's one dark band (`--band`, `--r-xl`; dark `--rim`): h2 «قريباً» and «مواعيد الإصدار كما أعلنتها الشركات. الطلب المسبق غير متاح في المتجر بعد.»; items (74%-wide snap rail on phones, four columns from 768): the day in Kufi 700 (44 / 56) beside the month and year, a relative chip «بعد 8 أيام» within 30 days, a 4:3 art well on `#26272D`, the name 16/600, the platform label, the price, «الطلب يفتح عند وصوله». No countdowns, no pre-order buttons.
- **SectionHead:** h2 + an honest reason line (14 `--ink-2`) at the start, «عرض الكل» at the end, an optional dot-chip row below.
- **Rails:** phones a native scroll-snap rail with 2.15 cards and the gutter kept; from 1024 a grid of whole cards in one row (4-up, 5-up from 1280), never a carousel with arrows over cards; fewer than 3 items do not render.
- **ShowMore:** «عرضنا 12 من 42 منتجاً», a 200×4 progress bar (`--ink` on `--niche-2`), «اعرض 12 منتجاً آخر»; at the end «لا يوجد المزيد لعرضه».
- **Breadcrumbs** from 768 only; **ProgressSteps** `full` and `compact` (done = an ink disc with a check; current = a `--red` disc with a white number and `aria-current="step"`; upcoming = a `--line-strong` ring).

### 9.17 Empty, error, offline

- **EmptyState:** centred, max 560, no slab: a 112px `--red-tint` disc with the mascot (or a real product cut-out in a 132px well), a title that says what is empty, one sentence of what to do (16 `--ink-2`), one primary and one recovery link, an optional shelf of four in-stock products. No «دورك.», no empty socket.
- **ErrorState:** the same anatomy with an alert icon in a `--niche` disc; a retry; the error reference in caption, LTR; the **offline** variant «لا يوجد اتصال بالإنترنت. أعد المحاولة عند عودة الاتصال.» (never "500").
- **OfflineBanner:** sticky under the header, 40px, `--warn-tint` with `--warn` 14/600 text and an inline wifi-slash icon; contextual copy; never confused with the demo strip.

### 9.18 Proof uploader, wallet, entry card, category tile, contact card

- **ProofUploader:** a paper drop area (`--r-lg`, 1.5px dashed `--line-strong`); states unchanged (uploading with a determinate `--ink` bar, interrupted, uploaded, failed in `--danger`, pending «بانتظار التحقق» + «استلمنا صورة الحوالة. نراجعها ثم نؤكد طلبك.», rejected with the reason). Transfer details above it: the number in `type-code`, grouped, a copy key that shows «نُسخ»; the fraud warning as an info panel.
- **WalletBalance:** `Band kind="wallet"`: «رصيد المحفظة», the balance as white price xl, pending amounts with a warn dot and words, the on-band key «اشحن الرصيد» and a white link «سجل الحركات»; the ledger as flat rows (debits `--red-ink` with a minus).
- **EntryCard:** paper, `--r-lg`, hairline, padding 20 (24 from 1024); an image well (96 / 160px; a cut-out or the mascot), `type-h3`, one line, a TextLink; the whole card is a link.
- **CategoryTile:** a 1:1 well with a cut-out at 72% + a 14/600 label + an optional count; 3 columns on phones, 6 from 1024.
- **ContactCard:** only the channels the owner configured (WhatsApp «راسلنا على واتساب», a `tel:` link in `<bdi>`, the address with «افتح في الخرائط», hours with «مفتوح الآن / مغلق الآن» from the schedule, the reply time when configured). With no channel it renders nothing and the caller shows «اكتب لموظف». Never «قريباً».

---

## 10. Admin adaptation

**The admin keeps Lens & Clay 1.0.** Its materials live in `app/styles/admin.css` under `[data-density="admin"]` (the "legacy: admin only" block): walled clay keys and chips, wells, steppers and switches with clay knobs, `.clay--walled` decision cards, 1.0 glass, the 16×5 LED and the clay bead. They read the 1.0 tokens kept in the `legacy: admin only` block of `tokens.css`; storefront code may not (lint `legacy-token`). The admin shares the v2 floor, paper, ink, lines and state colours, and Noto Kufi Arabic replaces the retired Kufam in its titles and KPI numerals. Overlays opened from the admin inherit `data-density="admin"` from their opener (`~/ui/Dialog`). A later migration will move the admin to v2.

The material law becomes a priority rule: **raised clay means "act on this", glass means "navigation or a temporary layer", and data itself has no material.** Same tokens, a density switch, and nothing else new.

```css
[data-density="admin"]{
  --gutter:24px;
  --type-body:400 13px/1.5 var(--font-text);
  --type-label:600 12.5px/1.5 var(--font-text);
  --type-caption:400 12px/1.5 var(--font-text);
  --row:36px;
}
[data-density="admin"] .key{--wall:2px;--h:36px;--px:14px;--r:var(--r-xs);--cast:none;font:600 13px/1.25 var(--font-text)}
[data-density="admin"] .key--lg{--h:40px}
[data-density="admin"] .key--round{--h:32px}
[data-density="admin"] .field__input{block-size:36px;border-radius:var(--r-xs);font-size:13px;padding-inline:10px}

.table{inline-size:100%;border-collapse:collapse;background:var(--paper);font:var(--type-data);font-variant-numeric:tabular-nums lining-nums}
.table th{position:sticky;inset-block-start:0;z-index:var(--z-sticky);block-size:var(--row);padding-inline:12px;background:var(--niche);
  color:var(--ink-2);font-weight:600;text-align:start;border-block-end:1px solid var(--line-strong)}     /* solid, never glass */
.table td{block-size:var(--row);padding-inline:12px;border-block-end:1px solid var(--line)}
.table .is-num{text-align:end}
.table tbody tr:hover td{background:var(--niche)}
.table tr[aria-selected="true"] td{background:var(--niche)}
.table tr[aria-selected="true"] td:first-child{border-inline-start:3px solid var(--ink)}
```

The admin density also pins the 1.0 type roles (`type-title`, `type-section`, `type-sub`, `type-strong`, `type-tab`, `type-data`, `type-data-sm`) at their 1.0 sizes, the 1.0 scrim and the 2.5px focus ring (`tokens.css`).

**Tables and financial grids.** Flat paper. No clay, no glass, no shadow, no radius above 4px inside a grid, no animation beyond an instant row highlight. 36px rows (48 on mobile approval queues), hairlines, sticky solid header. Numbers are tabular, aligned to the inline end, wrapped in `<bdi>`, with the currency in the column head. Negative amounts carry a minus sign and `--red-ink` text; there is never a red cell background. Text is full `--ink` on `--paper`. Cost and profit columns are absent from the DOM and the API response for roles without the permission; the design reserves no blurred or masked placeholder that could suggest the data is only hidden.

**Navigation.** A 248px side rail at the inline start in static glass (it rests on the flat page, so it needs no live blur). The 23 modules are flat 36px rows in groups ordered by priority (P0 first), with caption group heads. Only the **active module** is clay: a held-down ink key, exactly like a selected chip. Queue rows show a bead with the number of items waiting for a person. Collapsed, the rail is 64px of icons with tooltips. On tablets it becomes a top bar; on phones a tab bar with the approvals queue first.

**Summary cards.** KPI cards are flat: paper with a 1px line, a caption label and the figure in `--type-kpi`. The only raised cards (`.clay.clay--walled`) are the ones that need a human decision: transfer proofs awaiting review, guest orders to verify, low stock, failed deliveries, approvals. The relief map of the dashboard is the to-do list; a dashboard with nothing raised is a clean desk.

**Filters.** Above every table: saved views as chips (held down = the current view), a filter key that opens a side sheet of paper fields, the active filters as removable chips, a search field, a density toggle and a neutral export key. Filtering never blocks typing.

**Bulk actions.** Selecting rows raises a bulk bar from the bottom of the table region: live glass (rows scroll under it), the count in tabular type, neutral keys, and at most one commit key. The table gains bottom padding so the bar never covers the last row. Destructive bulk actions open a reason-code dialog.

**Red in admin** keeps its meaning and gets stricter: the commit key is the single action on a screen that moves money or stock and cannot be casually undone ("اعتمد الحوالة"، "أصدر الاسترجاع"، "رحّل الجرد"). Everything else is a neutral key. Rejections and deletions are neutral keys with a `--red-ink` label and a mandatory reason code. Brand red never means danger; danger is words, an icon and `--red-ink`.

**Command palette.** `Ctrl/⌘ K`. A dialog with a glass header strip holding one paper search field, and an opaque paper body of 36px result rows grouped as orders, products, customers, actions. The highlighted row has a niche fill and an ink start-edge bar. Keyboard hints in caption type. It opens with opacity and 8px of travel and nothing else moves.

**Audit timeline.** Flat paper. A 1px vertical line with 7px dots: solid ink for a person's action, hollow `--ink-2` for automation. Each event is one sentence (who did what to which record), the time in tabular type, an outlined reason-code tag and a link to the before and after values. There is no edit or delete affordance anywhere on it, because the trail is immutable. Filter by person, record and date; export is a neutral key.

**Dialogs and mobile approvals.** Dialogs follow §9.14. On a phone, a payment-proof review opens the image full width with pinch zoom, the claimed amount against the order total in tabular type (a mismatch is a warn status with both numbers), a duplicate-reference warning when one exists, and a glass task bar with two keys: neutral "ارفض مع السبب" and commit "اعتمد". Rejecting opens the reason-code sheet. Every approval writes an audit event.

**Status.** Text with a dot in `--ok`, `--warn`, `--info`, `--red-ink`, always with words ("مدفوع"، "بانتظار التحقق"، "تم الشحن"، "مرفوض"). Platform appears as the 16×5 LED before the platform name in product and inventory columns.

**Charts.** Ink series on a hairline grid, `--ink-2` and `--ink-3` for secondary series. Platform breakdowns use the four gel colours with text labels. Thresholds and negatives use `--red-ink`. No gradients, no animation on load beyond a 160ms fade.

**Type and language.** Noto Kufi Arabic 700 appears only in page titles and KPI numerals; everything operational is IBM Plex Sans Arabic 400/600. Arabic, English and Sorani work with no change because both families cover them.

---

## 11. Copy voice

**Plain, specific, active.** Say what happened and what to do next, with the number and its unit. Simple Modern Standard Arabic that reads naturally in Iraq. Address the shopper directly with an imperative verb: أضف، اختر، أكمل، ارفع. No apology formulas, no exclamation marks, no blame. Latin product names stay Latin.

- A button says what it does: «أضف إلى السلة»، «تابع إلى الدفع»، «أكّد الطلب»، «اشترِ {name}»، «اختر نسخة {name}»، «اعرض تقرير الفحص»، «تحدّث مع موظف»، «اعرض 24 منتجاً». Never «موافق» or «إرسال».
- Never promise what the shop cannot guarantee. **No call promises anywhere**; a contact promise returns only after the owner confirms the process, and then names the channel. Delivery times are preferences; estimates are labelled as estimates; a transfer is «بانتظار التحقق» until a person approves it.
- Labels must be true: «المقترَح» with its explanation; counts say «له في المتجر»; coming soon says «الطلب يفتح عند وصوله».
- The game-turn voice «دورك.» survives only in the intro line «دورك. اختر منصّتك.».
- No builder's voice on customer pages ("development mode", "not approved by the owner yet", "we only tested Chromium"); one short honest section on the accessibility page is enough. Warranty is a fact or a question, never an admission.
- Demo marking: the strip or chip, the tag beside the hero and PDP prices, the checkout and order tag, the footer statement. Nothing louder.

| # | Context | العربية | English | کوردیی سۆرانی |
|---|---|---|---|---|
| 1 | Primary action | أضف إلى السلة | Add to cart | بیخە ناو سەبەتە |
| 2 | Intro | دورك. اختر منصّتك. | Your turn. Pick your platform. | نۆرەی تۆیە. پلاتفۆرمەکەت هەڵبژێرە. |
| 3 | Delivery fact | التوصيل 5,000 د.ع لكل المحافظات. | Delivery is 5,000 IQD to every governorate. | گەیاندن 5,000 د.ع بۆ هەموو پارێزگاکان. |
| 4 | Guest checkout | أكمل الطلب بدون حساب. | Check out without an account. | بەبێ هەژمار داواکارییەکەت تەواو بکە. |
| 5 | Phone validation | ينقص الرقم 4 أرقام. اكتبه مثل 0770 123 4567. | The number is 4 digits short. Write it like 0770 123 4567. | ژمارەکە 4 ژمارەی کەمە. وەک 0770 123 4567 بینووسە. |
| 6 | Transfer proof received | استلمنا صورة الحوالة. نراجعها ثم نؤكد طلبك. | We received your transfer photo. We review it, then confirm your order. | وێنەی حەواڵەکەمان پێگەیشت. پێداچوونەوەی بۆ دەکەین، پاشان داواکارییەکەت پشتڕاست دەکەینەوە. |
| 7 | Preferred delivery time | وقت مفضّل وليس موعداً مؤكداً. | A preference, not a confirmed time. | (Sorani mirrors the meaning; native review) |
| 8 | Empty cart | سلتك فارغة · ابدأ من منصّتك: Nintendo أو PlayStation أو Xbox. | Your cart is empty · Start with your platform: Nintendo, PlayStation or Xbox. | (native review) |
| 9 | Used device photos | هذه صور الجهاز نفسه الذي يصلك. | These are photos of the exact unit you receive. | ئەمانە وێنەی هەمان ئەو ئامێرەن کە پێت دەگات. |
| 10 | Trade-in estimate | هذا سعر تقديري. السعر النهائي بعد فحص الجهاز. | This is an estimate. The final price comes after we inspect the device. | ئەمە نرخێکی خەمڵێنراوە. نرخی کۆتایی دوای پشکنینی ئامێرەکە دیاری دەکرێت. |
| 11 | Stock race | بيعت آخر قطعة قبل لحظات. أزلناها من سلتك. | The last one sold a moment ago. We removed it from your cart. | دوا دانە پێش چەند ساتێک فرۆشرا. لە سەبەتەکەت لامانبرد. |
| 12 | Offline | لا يوجد اتصال. سلتك محفوظة على هذا الجهاز. | No connection. Your cart is saved on this device. | هێڵی ئینتەرنێت نییە. سەبەتەکەت لەسەر ئەم ئامێرە پاشەکەوت کراوە. |

**Glossary (one term per concept, every surface, every language)**

| Concept | ar | en | Never |
|---|---|---|---|
| amount payable | الإجمالي | Total | «المجموع» for the total |
| phone field | رقم الموبايل | Mobile number | رقم الهاتف، الهاتف |
| payment methods | الدفع عند الاستلام · محفظة طمطم · تحويل إلى بطاقة ماستركارد · زين كاش | Cash on delivery · TamTam wallet · Transfer to a Mastercard card · Zain Cash | «تحويل بطاقة»، «تحويل بطاقة مصرفية (ماستر كارد)» |
| human help | تحدّث مع موظف | Talk to a person | «تحدّث مع شخص» |
| support area | الدعم (navigation) · مركز الدعم (page title) | Support · Support centre | الصيانة والمساعدة، المساعدة |
| used section | المستعمل والمفحوص (titles) · المستعمل (navigation) | Used & inspected · Used | |
| sold out / coming soon | نفد حالياً / قريباً · يصدر {date} | Sold out / Coming soon · Out {date} | «غير متوفر» for an unreleased item; «طلب مسبق» |
| demo | متجر تجريبي · سعر تجريبي · سعر ومخزون تجريبيان · طلب تجريبي | Demo store · Demo price · Demo price and stock · Demo order | «الموقع قيد الإنشاء» |
| platform names | Nintendo · PlayStation · Xbox · الأجهزة المحمولة | Nintendo · PlayStation · Xbox · Handheld PCs | «XBOX» |
| brand | طمطم (ar and ckb) | TamTam | mixed spellings in ckb |
| delivery fact | التوصيل 5,000 د.ع لكل المحافظات | Delivery: 5,000 IQD to every governorate | any time promise |

Every Sorani string is reviewed by a native reader before launch.

---

## 12. Product imagery (official product photography)

Decided by the client on 2026-11-11: **no 3D renders.** Every product is shown with its **official manufacturer or publisher images**, researched per product in `catalog/` and processed by `scripts/products/images.mjs`; used units get real photos of the unit. No generated product images.

1. **One ground.** Every product photo stands on `--niche` (flat in light, the neutral lit spot in dark): cards, PDP stage, thumbnails, quick look, mega-menu tile, search suggestions, cart and summary lines, toast, category tiles, release-band art (on `#26272D`). No white boxes inside the ground; no platform light behind a product being judged.
2. **One frame per context.** Cards, category tiles, thumbnails and cart lines 1:1. PDP stage 1:1 below 768 (full bleed), 4:3 at 768–1023 and in the quick look, 5:4 from 1024. Release art 4:3. Hero band, tiles and platform bands hold cut-outs freely.
3. **One fill rule per kind** (contained, bottom-aligned on one floor line, plus the contact ellipse; `.niche[data-kind]`):

| Kind | Insets top / sides / bottom | Result |
|---|---|---|
| Hardware and accessories (cut-outs) | 9% / 8% / 9.5% | fills ~84% of the width or ~80% of the height |
| Wide objects (≥1.8:1) | 14% / 7% / 16% | |
| Box art (games) | the cover at 84% of the frame height, 2:3, centred, `--r-xs`, `--e-art`; no ellipse | |
| Digital cards | the face at 84% of the width, 1.586:1, `--r-xs`, `--e-art` | |
| Used units with «صورة توضيحية» | as hardware, raised 10% | the chip never covers the object |
| PDP stage | 8% / 6% / 9% | compact hardware covers ≥60% of the stage |

4. **Never:** CSS tilt (`--pose` is 0), `filter: drop-shadow` or any `filter` on images, coloured pools under products, reflections, light under box art, kind captions.
5. **Opaque photos** (`<Art>` marks them `data-transparent="false"`): re-cut them through the image pipeline. Until then they get `mix-blend-mode: multiply` on the light ground and keep their own background as a white `--r-sm` plate in dark — the only blend in the app. The pipeline refuses a new opaque photo whose background differs from `--niche` by more than ΔE 3, unless it is box art or a screenshot.
6. **First image by kind:** hardware = the device as sold, front or three-quarter; game = the case pack shot; bundle = a composite; gift card = the face. Never key art first. A different view per surface.
7. **Delivery:** AVIF and WebP at 240 / 480 / 720 / 960 / 1440 with `sizes` per frame; explicit size or aspect ratio; a blurred LQIP and the dominant colour as placeholder; lazy below the fold; the hero image is the only preload; tile hardware at 480w with `fetchpriority="low"`. Budget ≤900 KB of images on the first load of home at 390.
8. **Alt text:** card images `alt=""` (the name is the link text); PDP images describe the view; used photos say whether they show the unit. Credits live in the footer line and the PDP sources disclosure; the owner confirms usage rights before launch.

---

## 13. Accessibility and internationalisation (WCAG 2.2 AA)

- **Contrast:** text ≥4.5:1 (≥3:1 at ≥24px, or ≥18.66px bold); boundaries and states ≥3:1 (fields, secondary and toolbar buttons, checkbox, radio, switch off-track, selected chip, focus ring). Tokens are gated by `node scripts/contrast.mjs`; QA measures the rendered composites (tiles, bands, cabinets, glass, toast).
- **Focus:** `outline: 2px solid var(--focus); outline-offset: 2px` on every interactive element (white on crimson and platform surfaces); never animated; no ring on programmatic focus of non-interactive targets. **Focus is never hidden** by sticky or fixed chrome (2.4.11): the global `scroll-padding-block` from `--shell-top` / `--shell-bottom`.
- **Targets:** 44×44 on everything pressable (pseudo-element hit areas for 32–40px visuals). The one documented exception: the 28px demo strip, a full-width link (passes 2.5.8).
- **Structure:** one h1 per page; headings in order; card names as h3 under section h2s; header, nav, main, footer landmarks; footer navs named by their headings; the skip link first and overlaying.
- **Forms:** labels above; hints and errors via `aria-describedby`; `aria-invalid`; `aria-required`; the error summary `role="alert"` with links; autocomplete (`tel-national`, `name`, `address-level1/2/3`, `street-address`); `inputmode`; phone and code fields LTR; errors never by colour alone (icon + words).
- **Live regions:** cart count (polite), results count (polite, after filtering settles), gallery counter (on change), toasts `role="status"`, the error summary `role="alert"`.
- **Preferences:** reduced motion (engine tier, §7.3); reduced transparency (glass solid); `prefers-contrast: more` and `forced-colors` (§6.6).
- **Language and direction:** `lang` and `dir` per locale; Latin names, numbers, codes and phone numbers isolated (`BidiText`, `<bdi>`, U+2066…U+2069 inside strings); card titles `unicode-bidi: plaintext` aligned to the page start; no forced `direction` on block elements; sideways transforms multiply by `--dir` (switch knob, sheet entry, arrow nudge, push); directional glyphs mirror (`.i--dir`, the icon's `rtl:` flip), nothing else; counters in words; dates day-first. Every user-facing string exists in ar, en and ckb; layouts are checked at 360, 390 and 430.
- **Arabic size:** no Arabic or Sorani run under 13px except 600-weight tags and the bead.
- **QA adds:** 200% zoom and 320px reflow on home, PDP and checkout; a `forced-colors` and a `prefers-contrast` render; NVDA on add-to-cart, filters and checkout.

---

## 14. Verified, not verified, open

**Verified (2026-11-11, foundation stage, headless Edge against the dev server)**

- Token contrast: 100 required pairs pass in both themes; the two demonstrations fail as documented (`node scripts/contrast.mjs`).
- Fonts: an Arabic home page requests six files, 182.5 KB, no Kufam, no Plex 500, exactly two preloads; English requests four (92.9 KB, including the Arabic cut for «العربية»); Sorani six (182.5 KB).
- The admin (dashboard, orders, a dialog, the command palette at 1440, light and dark): keys, chips, decision cards and the held nav key keep the 1.0 look; floor, paper, ink, lines and the headline face changed.
- `node scripts/lint-design.mjs app/styles app/app.css`: no finding.

**Not verified:** real phones, Safari and iOS (and the iOS fallback metrics), screen readers beyond QA, production bundle performance, the rendered composites of the new bands and tiles (they are built in the kit and page stages).

**Build order** (the redesign's stages): S (system: this document's tokens, materials, fonts, lint) → M (motion fixes) → K (kit), H (shell), D (catalogue data) → the page areas → K cleanup (stage 4: the deprecated names go and the v2 lint rules fail everywhere) → QA.

**Owner inputs** (the build uses the default meanwhile)

| # | Needed from the owner | Default until then |
|---|---|---|
| 1 | Confirm the brand red (`#E5132B` is a trace of the logo) | `#E5132B`; derived tokens recomputed if it changes (§5.2) |
| 2 | Final logo artwork as vectors (mascot, Arabic lettering, "TAM TAM GAMES") | the provisional SVGs in `public/logo` |
| 3 | Real contact channels: WhatsApp, phone, address, hours, reply time | `ContactCard` renders nothing; «اكتب لموظف» everywhere |
| 4 | Warranty terms | the manufacturer's warranty when known + «اسألنا عن شروط الضمان» |
| 5 | Dispatch days and time windows | the preference offers periods only |
| 6 | Governorate count (18 in the brief; 19 with Halabja in the policy) | «لكل المحافظات» with no number |
| 7 | Re-cut opaque product photos; real photos of used units | the interim blend / plate; «صورة توضيحية» |
| 8 | Real previous prices; release and listing dates; one buyer-relevant line per version | a struck price only where the data marks the store's own previous price; «جديد» only from real dates |
| 9 | Rights to official platform logos and the Zain Cash and Mastercard marks | names in text |
| 10 | A native Sorani reader for every ckb string and for Noto Kufi's ە and ڵا | ckb headings in Plex 600 |
| 11 | Is cash on delivery enabled? Is the 5,000 IQD fee charged on digital codes? | COD shown only when enabled; no delivery line on codes until decided |
| 12 | Brand spelling in Sorani | «طمطم» |
| 13 | Featured hero product and headline per period (CMS) | Nintendo Switch 2, «العب على / Nintendo Switch 2» |
