# TamTam Games Design System — Lens & Clay 1.0 (طين وعدسة)

Closed 2026-11-10. One system for the storefront (mobile first, 360–430px, then tablet and desktop) and for the admin. Arabic RTL is the default; English LTR and Kurdish Sorani RTL are complete alternates. Currency is the Iraqi dinar in integer amounts.

| What | Where |
|---|---|
| This spec | `design/DESIGN.md` |
| Reference mock (interactive, self-contained) | `design/final/index.html` — blocks `#screen-a` (home), `#screen-b` (product page), `#materials-light`, `#materials-dark`, `#desktop` (1280) |
| Mock switches | `?theme=dark`, `?lang=en`, `?lang=ckb`, and the "Show dark" toggle |
| Renders | `design/final/a.png`, `b.png`, `light.png`, `dark.png`, `desktop.png`, plus `a-dark`, `b-dark`, `desktop-dark`, `a-en`, `b-en`, `desktop-en`, `a-ckb`, `b-ckb`, `a-360`, `a-nintendo`, `a-xbox`, `b-interacted` |
| Check scripts | `design/_contrast.mjs` (110 contrast pairs), `_springs.mjs` (spring tokens), `_interact.mjs` (interaction, overflow, target sizes), `_states.mjs` (headline length per platform and language), `_redshare.mjs` (red share), `_shoot.sh` (renders), `_wire.mjs` (rebuilds the wireframes in this file) |

All product names, prices and specs in the mock are DEMO data.

---

## 0. The system in five laws

1. **Clay is for the hand.** If pressing it changes something, it is clay: an opaque, matte face standing on a real front wall. A press is the face travelling down onto the wall. A selected choice is the same key held down.
2. **Glass is for the eye.** Chrome that floats over content (bars, sheets, toasts, the price tag on a stage) is frosted glass. Glass never has a wall and is never red.
3. **Light is for the platform.** Nintendo, PlayStation, Xbox and handheld PCs exist only as a coloured light on a stage and a 16×5 LED beside the platform's name. Platform colour is never a surface, and text never sits directly on it: the only text near the light is on a glass tag whose contrast is computed against that light.
4. **Red is the commit.** TamTam red appears on the one key in a view that moves an order forward, on the cart bead, and in the logo. Nothing else is red: not prices, not badges, not links, not tabs, not selection, not errors.
5. **Flat is for reading.** The floor, product niches, fields, prices, totals, specs and tables are flat. Money never bounces, rotates or changes colour.

A shopper learns it in one screen: a wall means "press me", see-through means "I am telling you something", and the red thing is the way to the order.

---

## 1. Thesis

TamTam is a small, well-lit studio for game hardware. Three physical things build every screen, each with one job: **clay** you press, **glass** you read through, and **light** that tells you which platform you are in. Everything else is a calm warm-white floor.

The restraint is what makes it feel premium; the play is in the physics. Keys have real travel, the chosen platform key stays down like a radio button on an old console, the stage changes colour when you choose, a red bead flies into the cart, and the voice says "دورك." (your turn). Play stops at the price tag: money is flat ink on paper.

Because the rule is physical, it scales down to a dense admin without inventing a second language: data is flat, the few things that need a decision are raised, and overlays are glass.

## 2. Signature

**The Lit Stage and the key that stays down.**

- A product never stands on a podium and never sits in a card. It **floats** on a flat tonal stage (slight tilt, a contact shadow) inside **one pool of light in its platform's colour**: a soft halo behind it and a pool beneath it.
- A **glass price tag hangs off the rim of the stage**, half over the light and half over the floor, beside the **one red key**. This is the one place a shopper sees glass being glass and red being the commit.
- Under the stage sits a **bank of four clay keys** in a well. Press one: it goes down and stays down, the previous key springs up, the light changes colour, and the render deflates and re-inflates as the new platform's device. The headline, tag and "all of this platform" link change with it.
- The same object exists at three sizes: the hero stage on home, the stage on the product page (where the key bank becomes the gallery thumbnails), and, without light, the flat **niche** of every product card. The card-to-page shared-element transition is literally the niche growing into the stage.
- In dark mode the room goes charcoal and the stage light becomes the main colour on screen.

Cost: two radial gradients and one image. No backdrop-filter, no SVG, no per-product layout numbers.

## 3. What we deliberately do differently from the reference screenshots

The references were read only for broad direction: red and white, playful premium gaming, Arabic first, easy platform navigation. Nothing of their geometry is reused.

| Reference | Lens & Clay 1.0 |
|---|---|
| Red floods every screen: waves, glossy red banners, red podium, red prices, red badges, a red disc on the active tab | Red is measured at 3.6% of the home screenshot, 3.2% of the product page and 1.7% of the desktop block. It is the logo, the commit key and the cart bead. |
| Home opens with a carousel banner card (photo, headline, "order now" pill, dots) | No banner and no carousel. One device floats on a lit stage; choosing a platform relights it. |
| Platforms are large saturated tiles carrying official logos | Four white clay keys with a text name, a neutral device pictogram and a 16×5 LED. No logos are drawn anywhere. Platform colour is light only. |
| The product stands on a glowing red pedestal | No pedestal anywhere. The render floats; the only "ground" is a contact shadow and a pool of light. |
| One glossy glass-gel treatment for everything (cards, tiles, buttons, nav) | Two materials with separate jobs that never swap. Product cards have no material at all: a flat niche, text on the floor, one red key. |
| Full-width glossy red pill with a red glow as the default button | Buttons are walled clay keys with a 3px front wall and real travel. The red one appears once per view. |
| Floating glass pill tab bar with a red circle on the active icon | A glass sheet pinned to the bottom edge. Active tab = filled icon, heavier label and an ink marker on the sheet's top edge. The only red on it is the cart bead. |
| Product page: thumbnail strip, star rating "4.9 (248)", four icon spec tiles, red-outlined chip, red price | Thumbnail keys in a well with a caption and a count ("الواجهة · 1 من 4"), no invented ratings, plain spec rows, the chosen option as an ink key held down, an ink price with the delivery fee beside it. |
| Rows of glass quick-link icon tiles above the fold | None. The key bank and the tab bar carry navigation; negative space does the rest. |
| Prices in red | Prices are graphite, tabular, with a small currency suffix. Red never touches money. |
| A neutral rounded Arabic sans throughout | Kufam, a square geometric kufi that is family to the real logotype, for headlines and prices; IBM Plex Sans Arabic for everything you read. |
| Wet, glowing surfaces: specular streaks, bloom, liquid blobs | One light from above, matte faces, hard wall edges. Closer to a product photographer's table than to a splash. |

## 4. How the system was assembled

**Base: Lens & Clay** (aggregate 112 of 150, ranked first by the usability judge, with the clearest material law and the only concept rendered in all three languages and both themes). No decisive flaw was found in its law. Three of its expressions were flaws and were removed:

1. **The turntable** (a round podium with a coloured glow) is the reference product page's key prop, and it needed per-product layout numbers. Replaced by the lit stage: the light stays, the podium goes.
2. **The full-width red pill with a red glow** is the reference's own button. The commit key is now content-width beside the price tag on the stage, has no coloured glow, and is full width only inside the fixed buy bar.
3. **Products in near-black wells** in dark mode, and pastel per-platform tints on cards. Replaced by a lit `--stage` surface and flat untinted niches.

**Grafted in**

| From | What | Where it lives now |
|---|---|---|
| Toybox | Two-layer key: a static wall that owns the only blurred shadow, a cap that travels by transform, variants by custom property | `.key` and all variants (§6.1) |
| Toybox | Bordered "paper" inputs (boundary ≥ 3:1) | `.field__input`, `.search` |
| Toybox | The funnel rule: fun density drops from home to checkout; money is paper | §0 law 5, §8 funnel rule, §9.11 |
| Toybox | Game-turn voice "دورك." | Hero label, onboarding, empty states only (§11) |
| Toybox | Thumbnail keys in a tray; toast with thumbnail, variant line and undo; `--on-glass-2` token | Product stage, `.toast`, glass tokens |
| Toybox, Liquid | A fact line on every card (storage, condition grade), cart-plus glyph instead of a bare plus | `.pcard__meta`, `#i-bag-plus` |
| Gallery | Flat niches as the one card style (the niche colour is the image placeholder, so CLS is zero) | `.niche` |
| Gallery | The socket: the red key is seated in a well; after an add it shows a check, and an empty socket means "it left" | `.socket`, `[data-state="added"]` |
| Gallery | One-line mixed-script headline with an Arabic verb and a Latin product name ("وصل PS5 Pro") | Hero headline |
| Gallery | Caption plus count under the gallery; condition tags that differ by shape (new solid, used outlined) | `.gallery`, `.tag--new`, `.tag--used` |
| Gallery | Kufam weight plan (600 headlines, 700 prices, 800 only for the logo stand-in), card names in Plex 600 wrapping to two lines | Type tokens |
| Gallery | 44px on everything, logical properties only, `prefers-reduced-transparency` | Everywhere |
| Gallery | In admin a red dot means exactly one thing: something is waiting for a human | §10 |
| Liquid | Inflate as CSS keyframes with a stagger variable; `aspect-ratio` on every render slot; at most three beads in flight; AA status tokens; currency suffix with an 11px floor; low-end class from day one | §7, tokens |
| Liquid | Device silhouettes on platform keys so a platform is recognisable without reading Latin | `.key--plat` pictograms |
| Lens & Clay (kept) | Hand/eye law, platform colour as light, glass price tag overlapping the stage, header on the floor that becomes glass only on scroll, static-glass class, RGB-triplet shadow tokens, `--ds` locale scale, view-transition theme morph, admin relief rule | Throughout |

**Removed because the judges said to avoid it:** round podiums, red glow under buttons, red prices and badges, saturated platform tiles or domes, a fifth accent colour, rotated stickers, brush display type, a graphite buy button or graphite wordmark, toggle-looking buy controls, icon-only add keys without an accessible name, tags overlapping renders, borderless inputs, dark hardware on the darkest surface, a red circle for the active tab, star ratings and icon spec tiles, liquid necks and SVG-shaped glass, masks on backdrop-filter, CSS `filter` in chrome, forced `direction:ltr`, physical left/right layout, three font families, a display face under 15px, single-line truncation of product names, and any tap target under 44px.

---

## 5. Tokens

Tokens are plain CSS custom properties. Themes are set with `data-theme="light|dark"` on the root (or any subtree); density with `data-density="admin"`. Components never contain a hex value.

### 5.1 Core tokens (theme independent)

```css
:root{
  /* families */
  --font-display:"Kufam Variable","Kufam","IBM Plex Sans Arabic",system-ui,sans-serif;
  --font-text:"IBM Plex Sans Arabic","Noto Sans Arabic",system-ui,sans-serif;
  --font-head:var(--font-display);   /* the headline face; swapped per locale */
  --ds:1;                            /* display scale for translated strings */
  --lh-body:1.7;                     /* Arabic and Sorani body line-height */

  /* type: weight size/line-height family */
  --type-hero:600 calc(36px * var(--ds))/1.25 var(--font-head);
  --type-title:600 calc(26px * var(--ds))/1.35 var(--font-head);
  --type-section:600 calc(19px * var(--ds))/1.45 var(--font-head);
  --type-sub:600 calc(17px * var(--ds))/1.45 var(--font-head);
  --type-button:600 calc(16px * var(--ds))/1.25 var(--font-head);
  --type-body:400 15px/var(--lh-body) var(--font-text);
  --type-strong:600 14.5px/1.5 var(--font-text);
  --type-label:500 13.5px/1.5 var(--font-text);
  --type-caption:400 12.5px/1.6 var(--font-text);
  --type-tab:500 12px/1.4 var(--font-text);
  --type-tag:600 12px/1 var(--font-text);
  /* utility (admin, order numbers, ledgers): always with tabular-nums lining-nums */
  --type-data:500 13px/1.5 var(--font-text);
  --type-data-sm:400 12px/1.5 var(--font-text);
  --type-kpi:700 24px/1.2 var(--font-display);

  /* spacing: 4px grid */
  --s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-5:20px;--s-6:24px;--s-8:32px;--s-10:40px;--s-12:48px;--s-16:64px;
  --gutter:16px;                     /* 24px from 768, 40px from 1200 */

  /* radius: one scale */
  --r-xs:8px;--r-sm:12px;--r-md:16px;--r-lg:20px;--r-xl:28px;--r-full:999px;

  /* z-index: one scale */
  --z-raised:1;--z-sticky:100;--z-nav:200;--z-scrim:300;--z-sheet:310;--z-dialog:400;--z-toast:500;--z-fly:600;--z-intro:700;

  /* motion: durations */
  --t-press:80ms;--t-release:180ms;--t-micro:160ms;--t-exit:140ms;--t-reveal:240ms;
  --t-sheet:280ms;--t-page:320ms;--t-fly:460ms;--t-theme:200ms;
  /* motion: easing curves (fallbacks for the springs below) */
  --ease-settle:cubic-bezier(.2,.8,.2,1);
  --ease-squish:cubic-bezier(.34,1.56,.64,1);
  --ease-exit:cubic-bezier(.4,0,1,1);
  --ease-water:cubic-bezier(.4,0,.2,1);
  /* motion: springs, {response, dampingRatio} sampled into linear(); each carries its settle time */
  --spring-press:linear(0, 0.104, 0.329, 0.575, 0.786, 0.939, 1.031, 1.074, 1.083, 1.072, 1.053, 1.032, 1.016, 1.004, 0.997, 0.994, 0.993, 0.994, 0.996, 0.998, 1);
  --spring-press-t:260ms;
  --spring-squish:linear(0, 0.152, 0.466, 0.783, 1.014, 1.134, 1.163, 1.133, 1.081, 1.03, 0.995, 0.977, 0.974, 0.979, 0.988, 0.996, 1.001, 1.004, 1.004, 1.003, 1);
  --spring-squish-t:510ms;
  --spring-inflate:linear(0, 0.093, 0.293, 0.515, 0.712, 0.862, 0.963, 1.022, 1.048, 1.054, 1.048, 1.037, 1.025, 1.015, 1.007, 1.002, 0.999, 0.997, 0.997, 0.997, 1);
  --spring-inflate-t:430ms;
  --spring-settle:linear(0, 0.07, 0.212, 0.369, 0.512, 0.632, 0.728, 0.802, 0.857, 0.898, 0.928, 0.949, 0.964, 0.975, 0.983, 0.988, 0.992, 0.994, 0.996, 0.997, 1);
  --spring-settle-t:410ms;
  --spring-sheet:linear(0, 0.066, 0.209, 0.373, 0.529, 0.662, 0.767, 0.847, 0.905, 0.945, 0.971, 0.987, 0.997, 1.002, 1.004, 1.005, 1.005, 1.004, 1.003, 1.002, 1);
  --spring-sheet-t:390ms;
}

/* Latin, left-to-right */
:lang(en){--ds:.91;--lh-body:1.55}
/* Kurdish Sorani: headlines use the text face until a native reader approves Kufam (see 5.5) */
:lang(ckb){--font-head:var(--font-text);--ds:.94}
```

### 5.2 Light theme

```css
[data-theme="light"]{
  color-scheme:light;
  /* surfaces */
  --ground:#F3EEEA;        /* kaolin: the floor, every page background */
  --niche:#E9E2DC;         /* flat tonal panel: cards, info panels, table headers */
  --stage:#E9E2DC;         /* the surface behind every product render */
  --well:#E6DED7;          /* pressed-in track that holds keys */
  --paper:#FCFAF8;         /* fields, receipts, table rows, dialogs */
  /* text and lines */
  --ink:#1F2126;           /* graphite: text, icons, prices, held-down keys */
  --ink-2:#585A62;         /* secondary text */
  --ink-3:#808188;         /* disabled and decorative only (3.4:1) */
  --line:rgb(84 56 44 / .14);
  --line-strong:#857E78;   /* field borders: 3.8:1 on paper, 3.5:1 on the floor */
  /* brand */
  --red:#E0142B;           /* TamTam red: commit keys, cart bead, logo */
  --red-ink:#C7102A;       /* red as text: validation and negative amounts only */
  /* state: text and dots, always with a label */
  --ok:#17713F;--warn:#8A5200;--info:#0A5FB8;
  --shade:84 56 44;        /* shadows are warm umber, never grey */

  /* platform light (RGB triplets; used only by .stage__* and .led) */
  --gel-nintendo:255 81 64;--gel-playstation:47 107 242;--gel-xbox:31 166 80;--gel-handheld:123 91 239;
  --gel-brand:224 20 43;   /* store-wide campaigns only */
  --halo:.24;--pool:.40;--spot:0;

  /* clay */
  --clay-face:linear-gradient(180deg,#FFFFFF 0%,#FFFCFA 42%,#F1EAE4 100%);
  --clay-wall:#CCC0B6;
  --clay-lip:rgb(255 255 255 / 1);
  --clay-belly:rgb(84 56 44 / .13);
  --red-face:linear-gradient(180deg,#E8293D 0%,#E0142B 20%,#C80F25 100%);  /* the lighter red stays in the top fifth, above label height */
  --red-wall:#A30C1F;
  --red-lip:rgb(255 186 186 / .75);
  --red-belly:rgb(112 0 16 / .40);
  --sel-face:#1F2126;--sel-wall:#000000;--on-sel:#FFFCFA;--sel-in:rgb(0 0 0 / .55);
  --well-shadow:inset 0 2px 4px rgb(84 56 44 / .20),inset 0 -1px 0 rgb(255 255 255 / .85);

  /* glass */
  --glass-bg:linear-gradient(180deg,rgb(250 251 253 / .82) 0%,rgb(241 243 248 / .72) 100%);
  --glass-static:linear-gradient(180deg,rgb(255 255 255 / .80) 0%,rgb(250 251 253 / .54) 100%);
  --glass-solid:#F7F8FA;
  --glass-filter:blur(16px) saturate(1.7);
  --glass-rim:inset 0 1.5px 0 rgb(255 255 255 / 1),inset 0 0 0 1px rgb(255 255 255 / .46),0 0 0 .5px rgb(40 48 66 / .12);
  --on-glass-2:#3F4148;    /* secondary text on glass: 4.6:1 even over a black backdrop */

  /* elevation: one blurred shadow per object, static */
  --e-1:0 5px 8px -4px rgb(84 56 44 / .30);
  --e-2:0 9px 14px -7px rgb(84 56 44 / .34);
  --e-3:0 6px 12px -6px rgb(84 56 44 / .30);
  --e-4:0 12px 24px -10px rgb(84 56 44 / .36);
  --e-4-up:0 -10px 24px -14px rgb(84 56 44 / .30);
  --e-5:0 -18px 40px -16px rgb(84 56 44 / .42);
}
```

### 5.3 Dark theme

Charcoal with deep translucent layers. The only near-black is inside wells. Renders always sit on `--stage`, which is lighter than the page.

```css
[data-theme="dark"]{
  color-scheme:dark;
  --ground:#16171B;        /* charcoal, never pure black */
  --niche:#202228;
  --stage:#34363F;         /* lit: renders never sit on the darkest surface */
  --well:#0E0F12;
  --paper:#1D1F24;
  --ink:#F5F1EC;
  --ink-2:#B4B6BE;
  --ink-3:#7C7E86;
  --line:rgb(255 255 255 / .10);
  --line-strong:#74767E;
  --red:#E0142B;           /* the same red in both themes: the brand never shifts */
  --red-ink:#FF7C86;
  --ok:#4CCB86;--warn:#F0B04A;--info:#6DB3FF;
  --shade:0 0 0;

  --gel-nintendo:255 106 90;--gel-playstation:90 140 255;--gel-xbox:53 196 106;--gel-handheld:154 125 255;
  --gel-brand:255 70 88;
  --halo:.34;--pool:.58;--spot:.10;   /* the light becomes the main colour source */

  --clay-face:linear-gradient(180deg,#3B3E47 0%,#2B2D34 42%,#22242A 100%);
  --clay-wall:#0B0C0F;
  --clay-lip:rgb(255 255 255 / .17);
  --clay-belly:rgb(0 0 0 / .34);
  --red-face:linear-gradient(180deg,#EA2B40 0%,#E0142B 20%,#C40E24 100%);
  --red-wall:#8C0A1B;
  --red-lip:rgb(255 170 170 / .60);
  --red-belly:rgb(96 0 14 / .45);
  --sel-face:#F5F1EC;--sel-wall:#9B948E;--on-sel:#1F2126;--sel-in:rgb(84 56 44 / .40);
  --well-shadow:inset 0 2px 5px rgb(0 0 0 / .70),inset 0 -1px 0 rgb(255 255 255 / .07);

  --glass-bg:linear-gradient(180deg,rgb(62 66 78 / .82) 0%,rgb(30 32 39 / .76) 100%);
  --glass-static:linear-gradient(180deg,rgb(76 80 92 / .80) 0%,rgb(50 52 61 / .68) 100%);
  --glass-solid:#26282F;
  --glass-filter:blur(16px) saturate(1.6) brightness(.8);   /* bright consoles behind it cannot wash out light text */
  --glass-rim:inset 0 1.5px 0 rgb(255 255 255 / .34),inset 0 0 0 1px rgb(255 255 255 / .08),0 0 0 .5px rgb(0 0 0 / .5);
  --on-glass-2:#DAD7D3;

  --e-1:0 5px 8px -4px rgb(0 0 0 / .60);
  --e-2:0 10px 16px -7px rgb(0 0 0 / .66);
  --e-3:0 6px 12px -6px rgb(0 0 0 / .60);
  --e-4:0 14px 28px -10px rgb(0 0 0 / .70);
  --e-4-up:0 -12px 26px -14px rgb(0 0 0 / .60);
  --e-5:0 -20px 44px -16px rgb(0 0 0 / .80);
}
```

### 5.4 Contrast (computed, not estimated)

`node design/_contrast.mjs` checks 110 pairs; all pass. Glass is checked against its worst-case backdrop.

| Pair | Light | Dark |
|---|---|---|
| ink on ground / niche / paper | 13.98 / 12.56 / 15.47 | 15.93 / 14.14 / 14.66 |
| ink on stage (dark) | — | 10.70 |
| ink-2 on ground / niche / paper | 5.97 / 5.36 / 6.60 | 8.85 / 7.85 / 8.15 |
| white label on red face (below the top fifth) | 4.88 to 5.91 | 4.88 to 6.11 |
| red-ink on ground / niche / paper | 5.16 / 4.63 / 5.70 | 7.23 / 6.42 / 6.66 |
| ok / warn / info on ground | 5.25 / 5.54 / 5.45 | 8.69 / 9.39 / 8.14 |
| held-down key label on its face | 15.77 | 14.32 |
| field border on paper / ground (non-text, needs 3) | 3.84 / 3.47 | 3.64 / 3.95 |
| ink on live glass, worst backdrop | 7.34 (over black) | 6.05 (over white) |
| on-glass-2 on live glass, worst backdrop | 4.64 (over black) | 4.74 (over white) |
| ink on static glass over the strongest light pool | 11.47 or more | 6.38 or more |
| on-glass-2 on static glass over the strongest light pool | 7.25 or more | 5.00 or more |

Rules that keep these true: the red is never lightened; labels on red are 600 weight and at least 13.5px; red as text uses `--red-ink`; `--ink-2` is never placed on glass (use `--on-glass-2`); `--ink-3` is never used for information.

### 5.5 Typography

**Two families, both verified for Arabic, Kurdish Sorani and Latin** (fontkit cmap, HarfBuzz joining test, headless Chromium, Fontsource 5.3.0).

| Role | Family | Package | Weights | Transfer size |
|---|---|---|---|---|
| Display | Kufam (variable) | `@fontsource-variable/kufam` (CSS family `Kufam Variable`) | wght 400–900 axis. Used: 600 headlines, titles, button labels; 700 prices and KPI numerals; 800 only for the logo stand-in | 54.5 KB Arabic + 35.5 KB Latin, whole weight range |
| Text and utility | IBM Plex Sans Arabic (static only) | `@fontsource/ibm-plex-sans-arabic` | 400, 500, 600. No other weights ship. | 41.8 KB Arabic + 18.7 KB Latin at 400; about the same for 500 and 600 |

Why these two: the real logotype is a heavy square kufi, and Kufam is built the same way, so headlines sit beside the logo artwork as family. Its Latin is drawn with its Arabic at the same weight and x-height, so "وصل PS5 Pro" needs no size or baseline correction. Its flat, slab-like strokes look moulded, which suits clay. IBM Plex Sans Arabic is the engineered counterweight: open counters at 12px, tabular figures by default, and one voice from product cards to ledger tables.

**Kurdish Sorani strategy (explicit).** Body, labels, fields, tables and every operational string use IBM Plex Sans Arabic, which contains all fourteen Sorani letters (ڕ ڵ ێ ۆ ە ڤ گ چ پ ژ ک ی ھ ئ), joins them correctly at every weight and ligates ڵ + ا like ل + ا. Kufam also contains all of them, but it draws final ە as a low hook that looks unfamiliar and it does not ligate ڵا. Therefore:

```css
:lang(ckb){--font-head:var(--font-text);--ds:.94}
```

In Sorani, headlines, section heads and button labels are set in IBM Plex Sans Arabic 600. Kufam remains only where no Kurdish letters occur: numerals in prices, counters and KPI figures. The override is removed only after a native Sorani reader approves Kufam's ە and ڵا in the hero, a section head and a button label. Kurdish written in Latin script (Kurmanji) is a separate, left-to-right locale; it would use the `:lang(en)` adjustments, and its extra letters (ç ê î ş û) have not been checked in these files.

**Scale**

| Token | Mobile | Desktop (≥1200) | Use |
|---|---|---|---|
| `--type-hero` | Kufam 600 36/1.25 | 68/1.15 | Home and campaign headline, one line |
| `--type-title` | Kufam 600 26/1.35 | 40/1.25 | Product title, page title |
| `--type-section` | Kufam 600 19/1.45 | 26/1.35 | Section and rail heads |
| `--type-sub` | Kufam 600 17/1.45 | 20/1.4 | Sheet titles, spec heads |
| `--type-button` | Kufam 600 16/1.25 | 16/1.25 | Key labels |
| price xl / lg / md / sm | Kufam 700 28 / 21 / 17 / 15, line-height 1.3 | 34 / 28 / 17 / 15 | Product page / stage tag / card / inline |
| currency suffix | Plex 500 at `max(11px, .6em)`, `--ink-2` | same | "د.ع" or "IQD", after the figure |
| `--type-body` | Plex 400 15/1.7 | 16/1.75 | Reading text |
| `--type-strong` | Plex 600 14.5/1.5 | 15/1.5 | Card names, row titles |
| `--type-label` | Plex 500 13.5/1.5 | 14/1.5 | Field labels, chips, key-bank label |
| `--type-caption` | Plex 400 12.5/1.6 | 13/1.6 | Fact lines, help text |
| `--type-tab` | Plex 500 12/1.4 | — | Tab labels |
| `--type-tag` | Plex 600 12/1 | 12/1 | Tags |
| `--type-data` | Plex 500 13/1.5 tabular | same | Admin tables, order numbers, ledgers |
| `--type-data-sm` | Plex 400 12/1.5 tabular | same | Admin captions, timestamps |
| `--type-kpi` | Kufam 700 24/1.2 tabular | 28/1.2 | Dashboard numerals |

**Arabic-first rules**

- No `letter-spacing` anywhere, in any language. Hierarchy comes from size, weight and the ink / ink-2 pair.
- Arabic and Sorani body is 1.7 (desktop 1.75); captions 1.6; display 1.25–1.45. Never below 1.6 for running text.
- Kufam is never used below 15px, never for body, never for card names.
- Latin product names and all numbers inside Arabic or Sorani are wrapped in `<bdi>`. Nothing forces `direction` on a name or a title.
- Product names wrap to two lines with reserved height; they are never truncated to one line.
- Headlines and decks use `text-wrap: balance`. The hero headline is one line by budget: an Arabic verb plus a short Latin product name, at most 16 characters in Arabic, checked in all three languages for every campaign.
- Numbers: Western digits with a comma for thousands, `font-variant-numeric: tabular-nums lining-nums` on every price, counter, quantity and table cell. The currency label is always present and never under 11px.

**Latin and LTR adjustments**

- `--ds: .91` scales headlines, section heads and button labels, because Kufam's Latin runs wide and English strings run longer. Body size does not change.
- Body line-height drops to 1.55.
- English pages use the Latin glyphs of the same two families; no third family is loaded.
- Direction is set once on `<html dir>`. Components use logical properties only, so nothing else changes.

**Loading plan**

- Self-host the Fontsource WOFF2 files; no third-party font host in production (the mock uses Google Fonts only for convenience).
- Import `@fontsource-variable/kufam` (index.css) and `@fontsource/ibm-plex-sans-arabic/400.css`, `500.css`, `600.css`. The static package's `index.css` declares 400 only.
- Preload exactly two files: Plex 400 Arabic and Kufam Arabic (96.3 KB together). Latin files load on first use through `unicode-range`.
- `font-display: swap` with metric-adjusted fallbacks (`size-adjust`, `ascent-override`, `descent-override` tuned against Noto Sans Arabic and Segoe UI) so the swap does not move layout.
- Worst case if every file loads is about 272 KB. If measured LCP on a low-end phone suffers, the first cut is dropping the 500 weight (label, tab and chip tokens fall to 400 or 600: a three-line token change), the second is a custom subset limited to Arabic, the Sorani additions, digits and basic Latin.

### 5.6 Spacing, grid, breakpoints

| Token | Value | Use |
|---|---|---|
| `--s-1` … `--s-16` | 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 | All gaps and paddings |
| `--gutter` | 16 (mobile), 24 (≥768), 40 (≥1200) | Page side margin |
| card gap | 12 (mobile), 16 (≥768), 20 (≥1200) | Grids and rails |
| section gap | 24 (mobile), 40 (≥1200) | Between shelves |
| touch target | 44×44 minimum | Everything pressable; smaller-looking controls extend their hit area with a pseudo-element |

Breakpoints: 360 (minimum supported), 600 (large phone), 768 (tablet), 1024, 1200 (desktop), content max-width 1280.

### 5.7 Radius, elevation, z-index

**Radius** (nested radius = inner radius + the gap between them)

| Token | Value | Use |
|---|---|---|
| `--r-xs` | 8 | Tags, admin controls |
| `--r-sm` | 12 | Small keys, thumbnail keys, toast thumbnails, admin panels |
| `--r-md` | 16 | Keys, chips, fields, glass tags, toasts |
| `--r-lg` | 20 | Niches, info panels, uploader |
| `--r-xl` | 28 | Stages, sheets, bars (free corners only), dialogs |
| `--r-full` | 999 | Round keys, steppers, sockets, LEDs, beads |

**Elevation**

| Level | Token | What sits there |
|---|---|---|
| 0 | none | Floor, niches, stages, paper, tables |
| in | `--well-shadow` | Wells (tracks that hold keys) |
| wall | `0 2px 0` / `0 3px 0` zero blur | The front wall of small keys / keys. It never moves. |
| 1 | `--e-1` | Cast shadow of small keys (round, chip, thumbnail) |
| 2 | `--e-2` | Cast shadow of keys |
| 3 | `--e-3` | Resting glass: stage tag, chrome orbs |
| 4 | `--e-4`, `--e-4-up` | Floating glass: toast, scrolled header; bottom bars throw the shadow upward |
| 5 | `--e-5` | Sheets and dialogs |

One blurred shadow per object. Shadows are static: nothing ever animates `box-shadow`, `filter` or blur. In dark mode depth comes from the lit top lip and the wall more than from the shadow.

**z-index:** `--z-raised` 1, `--z-sticky` 100 (sticky table heads, filter row), `--z-nav` 200 (tab bar, task bar, header), `--z-scrim` 300, `--z-sheet` 310, `--z-dialog` 400, `--z-toast` 500, `--z-fly` 600 (the cart bead in flight), `--z-intro` 700.

---

## 6. Materials

### 6.1 Clay — for the hand

```html
<button class="key key--red" type="button">
  <span class="key__cap">…icon and label…</span>
</button>
```

```css
/* the painted face; also for clay that never travels */
.clay{background:var(--clay-face);box-shadow:inset 0 1.5px 0 var(--clay-lip),inset 0 -6px 8px -5px var(--clay-belly)}
.clay--red{background:var(--red-face);color:#fff;box-shadow:inset 0 1.5px 0 var(--red-lip),inset 0 -6px 8px -5px var(--red-belly)}
.clay--ink{background:var(--sel-face);color:var(--on-sel);box-shadow:inset 0 2px 3px var(--sel-in)}
/* clay that never travels (admin decision cards): the wall is drawn as a zero-blur shadow */
.clay--walled{box-shadow:inset 0 1.5px 0 var(--clay-lip),inset 0 -6px 8px -5px var(--clay-belly),0 3px 0 var(--clay-wall),var(--e-2)}

/* KEY: a clay face on a static front wall. Only the face moves, by transform. */
.key{
  --wall:3px;--r:var(--r-md);--h:48px;--px:20px;
  --face:var(--clay-face);--wall-c:var(--clay-wall);--on:var(--ink);--lip:var(--clay-lip);--belly:var(--clay-belly);--cast:var(--e-2);
  position:relative;display:inline-flex;vertical-align:top;padding:0 0 var(--wall);border-radius:var(--r);
  color:var(--on);font:var(--type-button);white-space:nowrap;min-inline-size:0;user-select:none;
}
/* the wall never moves and owns the only blurred shadow */
.key::before{content:"";position:absolute;inset:var(--wall) 0 0;border-radius:inherit;background:var(--wall-c);box-shadow:var(--cast)}
.key__cap{
  position:relative;flex:1;min-inline-size:0;display:flex;align-items:center;justify-content:center;gap:8px;
  min-block-size:var(--h);padding-inline:var(--px);border-radius:inherit;background:var(--face);
  box-shadow:inset 0 1.5px 0 var(--lip),inset 0 -6px 8px -5px var(--belly);
  transition:transform var(--t-release) var(--ease-squish);
}
@supports (transition-timing-function:linear(0,1)){.key__cap{transition:transform var(--spring-press-t) var(--spring-press)}}
.key:active .key__cap{transform:translateY(calc(var(--wall) - 1px));transition-duration:var(--t-press);transition-timing-function:ease-out}
@media (hover:hover){.key:not([aria-checked="true"]):not([aria-pressed="true"]):hover:not(:active) .key__cap{transform:translateY(-1px)}}

/* variants only reassign variables */
.key--red{--face:var(--red-face);--wall-c:var(--red-wall);--on:#fff;--lip:var(--red-lip);--belly:var(--red-belly)}
.key--lg{--h:56px;--px:26px}
.key--sm{--wall:2px;--h:40px;--px:14px;--r:var(--r-sm);--cast:var(--e-1);font:600 13.5px/1.25 var(--font-text)}
.key--sm::after{content:"";position:absolute;inset:-2px 0}          /* 44px hit area */
.key--round{--wall:2px;--r:var(--r-full);--h:44px;--px:0;--cast:var(--e-1)}
.key--round .key__cap{inline-size:44px}
.key--chip{--wall:2px;--h:44px;--px:14px;--cast:var(--e-1);font:500 14px/1.25 var(--font-text)}
/* every chip reserves its mark, so choosing never reflows the row: hollow ring = not chosen, check = chosen */
.key--chip .key__cap::before{content:"";flex:none;inline-size:14px;block-size:14px;margin:1px;border-radius:50%;border:1.6px solid var(--ink-2)}
.key--chip .ico{display:none}

/* selected / on = the same key held down, ink-coloured */
.key[aria-checked="true"],.key[aria-pressed="true"]{--face:var(--sel-face);--wall-c:var(--sel-wall);--on:var(--on-sel)}
.key[aria-checked="true"] .key__cap,.key[aria-pressed="true"] .key__cap{transform:translateY(calc(var(--wall) - 1px));box-shadow:inset 0 2px 3px var(--sel-in)}
.key--chip[aria-checked="true"] .ico{display:block}
.key--chip[aria-checked="true"] .key__cap::before{display:none}

/* WELL: clay pressed in; a track that holds keys */
.well{background:var(--well);box-shadow:var(--well-shadow)}
```

**The one button pair**

| | Class | Use |
|---|---|---|
| Commit key | `.key.key--red` | The single action in a view that moves the order forward: add to cart, go to checkout, continue, place order, accept a final quote. One per view. |
| Key | `.key` | Every other action |

Sizes: default 48 (51 with its wall), `--lg` 56 for desktop heroes, `--sm` 40 for toasts and rows, `--round` 44 for icon keys, `--chip` 44 for choices. Text-only actions use the link look (§9.1), not a third button style.

**Where clay may be used:** buttons, chips, steppers, toggles, platform keys, thumbnail keys, favourite, close, copy, the cart bead, the socket key. In admin: the active navigation item, the one primary action, saved-view chips, and summary cards that need a human decision.

**Where clay may not be used:** as a container or card around content; around prices or totals; behind text blocks; on list rows; inside tables. A key never contains another key. No more than one walled key per product card.

**State is never depth alone.** Held-down keys also turn ink and carry a second cue: a check on chips, a lit LED and heavier label on platform keys, an ink ring on thumbnail keys, a filled icon on the favourite. All of them expose `aria-checked` or `aria-pressed`.

**Disabled** keys lose their wall and cast shadow, sit flat on the floor with an `--ink-3` label, and always have the reason written next to them.

### 6.2 Glass — for the eye

```css
/* live frost: only fixed chrome that content really scrolls under */
.glass{
  background:var(--glass-bg);
  -webkit-backdrop-filter:var(--glass-filter);backdrop-filter:var(--glass-filter);
  box-shadow:var(--glass-rim),var(--e-4);
}
.glass--bottom{box-shadow:var(--glass-rim),var(--e-4-up)}     /* bars and sheets anchored to the bottom edge */
/* the same pane with no backdrop-filter: only where it rests on a smooth surface (floor, stage, light) */
.glass--static{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--glass-static);box-shadow:var(--glass-rim),var(--e-3)}
/* secondary text on any glass */
.glass .is-2{color:var(--on-glass-2)}
```

| Variant | Blur | Use |
|---|---|---|
| `.glass` | live, 16px | Tab bar, task bar (buy bar, checkout bar), header after scroll, toast, sheet and dialog header strip, admin bulk-action bar, mega menu |
| `.glass.glass--static` | none | Price tag on a stage, back and cart orbs over a stage, desktop cart orb, admin side rail |

**Rules**

- At most **two live `.glass` elements in a viewport**. A third overlay (for example a toast while a sheet is open) replaces one of them or uses `--glass-solid`.
- Live glass only on **fixed or sticky layers**. Nothing that scrolls with content and nothing that repeats in a list is glass. Tags inside cards are solid.
- Glass is always a **rounded rectangle**. Never a mask, `clip-path` or SVG silhouette on an element with `backdrop-filter`.
- A sheet blurs only its **header strip**; the body is opaque `--ground`. Dragging a sheet moves a strip of blur, not a screen of it.
- Glass **never has a wall and is never red**. Anything pressable or red that sits on glass is a clay object resting on it (the cart bead, a toast's undo key, a sheet's close key, the buy bar's stepper and commit key).
- Text on glass is `--ink`; secondary text on glass is `--on-glass-2`. `--ink-2` is not allowed on glass.
- Blur radius, tint and shadow are never animated. Glass moves by `transform` and `opacity` only.
- Static glass is only used over smooth backdrops (floor, stage, light). If something detailed can pass under it, it must be live glass or solid.

### 6.3 Flat surfaces (no material)

| Surface | Token | Use |
|---|---|---|
| Floor | `--ground` | Every page background |
| Niche | `--niche` | Product card image area, info panels, empty states, table headers |
| Stage | `--stage` | Behind every product render (equal to the niche in light, lighter than the page in dark) |
| Paper | `--paper` | Fields, receipts, order summaries, table rows, dialog bodies |

Flat surfaces have no shadow, no gradient and no blur. A flat surface is separated from the floor by a tonal step, and from another flat surface by a 1px `--line`.

### 6.4 Light — for the platform

```css
/* a stage is a flat niche; the light is two pre-painted radial gradients behind the render */
.stage{position:relative;border-radius:var(--r-xl);background:var(--stage);overflow:hidden}
.stage__light{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.stage__halo,.stage__spot{grid-area:1/1;border-radius:50%}
.stage__halo{inline-size:var(--halo-w,420px);block-size:var(--halo-h,300px);
  background:radial-gradient(closest-side,rgb(var(--gel) / var(--halo)),rgb(var(--gel) / calc(var(--halo) * .3)) 58%,transparent)}
.stage__spot{inline-size:calc(var(--halo-w,420px) * .62);block-size:calc(var(--halo-h,300px) * .62);
  background:radial-gradient(closest-side,rgb(255 255 255 / var(--spot)),transparent)}     /* dark only: a neutral rim so dark hardware separates */
.stage__pool{position:absolute;border-radius:50%;pointer-events:none;
  background:radial-gradient(closest-side,rgb(var(--gel) / var(--pool)),rgb(var(--gel) / calc(var(--pool) * .38)) 56%,transparent)}

/* a render: one box sized by its aspect ratio; the contact shadow is a percentage of the image box */
.render{position:relative;display:block;line-height:0;isolation:isolate}
.render img{display:block;inline-size:auto;block-size:auto;max-inline-size:var(--slot-w);max-block-size:var(--slot-h);transform:rotate(var(--pose,-3deg))}
.render::after{content:"";position:absolute;z-index:-1;inset-inline:6%;inset-block-end:-11%;block-size:15%;border-radius:50%;
  background:radial-gradient(closest-side,rgb(var(--shade) / .42),rgb(var(--shade) / .13) 60%,transparent)}

/* the LED: 16x5, always beside the platform name as text */
.led{display:block;flex:none;inline-size:16px;block-size:5px;border-radius:var(--r-full);background:rgb(var(--gel));opacity:.5}
.led--solid{opacity:1}
.led.is-on,[aria-checked="true"] .led{opacity:1;box-shadow:0 0 0 3px rgb(var(--gel) / .18),0 0 8px rgb(var(--gel) / .8)}
```

A subtree sets its platform once: `style="--gel:var(--gel-playstation)"`.

**Rules**

- `--gel-*` may be referenced only by `.stage__*` and `.led`. It is never a background behind text, a border, a button colour or a card tint.
- One light per stage, one stage with light per viewport on mobile. Product cards in lists have **no light**: a flat niche only.
- The platform's name is always written as text next to its LED. No official platform logos are drawn anywhere; key pictograms are neutral device shapes.
- The Nintendo gel is a warmer, lighter red than brand red and exists only as light, so it cannot be mistaken for a commit key.
- `--gel-brand` is reserved for store-wide campaigns: the home stage may be lit in TamTam red for a campaign. That is the only way red is ever "added"; it stays light, never a surface.
- Photos of used devices are not lit. Light is for new-product photography only.

### 6.5 Performance tiers and preference fallbacks

```css
/* no backdrop-filter support */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.glass{background:var(--glass-solid)}}

/* the user asked for less transparency */
@media (prefers-reduced-transparency:reduce){
  .glass,.glass--static{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--glass-solid)}
}

/* low-end tier: set on <html> by the Motion Engine */
.fx-low .glass{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--glass-solid)}
.fx-low .inflate{animation:none}

/* the user asked for more contrast: materials become outlined flat surfaces */
@media (prefers-contrast:more){
  .glass,.glass--static{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--ground);box-shadow:0 0 0 1.5px var(--ink)}
  .key__cap{box-shadow:inset 0 0 0 1.5px var(--ink)}
  .niche,.well{box-shadow:inset 0 0 0 1px var(--ink)}
  .stage__light,.stage__pool{display:none}
}

/* forced colours: depth and fills disappear, so state gets an outline */
@media (forced-colors:active){
  .key__cap{border:1px solid ButtonText}
  .key[aria-checked="true"] .key__cap,.key[aria-pressed="true"] .key__cap{outline:3px solid Highlight;outline-offset:-3px}
}
```

**Low-end tier (`.fx-low`).** The Motion Engine sets it before first paint when `navigator.deviceMemory <= 2`, `navigator.hardwareConcurrency <= 4` with a small viewport, or `navigator.connection.saveData`; and at runtime after three long animation frames (over 50ms) inside one transition. It is sticky for the session. Effects: glass becomes solid, staggered inflate is off (content appears in place), the theme and language morphs become instant, the optional idle light breath is off. Function is identical.

**Budget, as rules a reviewer can check**

- LCP element on home is the hero render: one image, `fetchpriority="high"`, preloaded, never faded in from opacity 0 and never animated before it is painted. Other platforms' hero images are fetched on idle or on intent (pointerdown on a platform key), never stacked in the DOM.
- Every image slot has explicit `width` and `height` or an `aspect-ratio`; the niche colour is the placeholder. No grey skeletons, no layout shift.
- Lists longer than about 40 cards are virtualised. Cards in lists carry no light, no glass and exactly one walled key.
- Nothing here has been measured on a phone. These are design constraints; Core Web Vitals must be measured on a mid and a low-end Android device before sign-off.

### 6.6 Lint rules (enforce in CI)

1. `backdrop-filter` appears only in the `.glass` rule.
2. No more than two `.glass:not(.glass--static)` elements can be visible in one viewport; none inside a list-item component.
3. No `mask`, `mask-image` or `clip-path` on an element that has `backdrop-filter`.
4. No CSS `filter` in component styles and no SVG filter in shipped markup.
5. No `transition` or `animation` on `box-shadow`, `filter`, `backdrop-filter`, `background`, `width`, `height`, `top`, `left`, `inset` or custom colour properties. Motion is `transform` and `opacity`.
6. No physical properties (`left`, `right`, `margin-left`, `padding-right`, `text-align:left`, …) in components. Logical properties only. The single exception is the pixel-space start position of the flying bead.
7. No `letter-spacing`.
8. No hex or `rgb()` literals outside the token files.
9. `--red` and `--red-face` are referenced only by `.key--red`, `.clay--red`, `.bead`, `.fly` and the logo.
10. `--gel-*` is referenced only by `.stage__*` and `.led`.
11. `<img>` without `width` and `height` (or a sized, aspect-ratio parent) fails the build.
12. `view-transition-name` is set at tap time on the tapped element only, never on every card.

---

## 7. TamTam Motion Engine

Principles: feedback starts on `pointerdown`; navigation and data requests fire at the same moment as the animation, never after it; state changes first and animation is decoration; everything is interruptible; only `transform` and `opacity` move; shadows and blur are static.

### 7.1 Tokens

**Springs** (mass 1; `stiffness = (2π / response)²`, `damping = 4π × dampingRatio / response`)

| Preset | `{response, dampingRatio}` | Stiffness / damping | Overshoot | Settles in | Intended use |
|---|---|---|---|---|---|
| `press` | `{0.16, 0.62}` | 1542 / 48.7 | 8% | 260ms | Key release, chip and thumbnail settle, toggle |
| `squish` | `{0.26, 0.50}` | 584 / 24.2 | 16% | 510ms | The cart bead receiving a product, socket refill, small objects only |
| `inflate` | `{0.28, 0.68}` | 504 / 30.5 | 5% | 430ms | Content inflating into reserved space, render swap on the stage, intro layers |
| `settle` | `{0.30, 1.00}` | 439 / 41.9 | none | 410ms | Shared-element zoom, sideways push, anything large (large things never overshoot) |
| `sheet` | `{0.30, 0.86}` | 439 / 36.0 | 0.5% | 390ms | Sheets, menus, drag release (carries the finger's velocity) |

In CSS each preset is a `linear()` curve with its settle time (`--spring-*`, `--spring-*-t`, §5.1). In JS (drag, sheets, rails with velocity) the same `{response, dampingRatio}` pairs drive WAAPI keyframes generated from the spring's step response; no `requestAnimationFrame` loops. Where `linear()` is unsupported the cubic-bezier fallbacks below are used with the duration tokens.

**Durations**

| Token | Value | Use |
|---|---|---|
| `--t-press` | 80ms | Press-down; feedback must be visible within this |
| `--t-exit` | 140ms | Anything leaving |
| `--t-micro` | 160ms | Chips, toggles, digit roll |
| `--t-release` | 180ms | Key release (fallback curve) |
| `--t-theme` | 200ms | Theme cross-fade |
| `--t-reveal` | 240ms | Inflate (fallback curve) |
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

Each material moves in exactly one way, so motion teaches the law: **clay travels and squishes, glass slides, light fades, flat things do not move.**

**Press feedback.** On `pointerdown` the cap travels `wall − 1px` down in 80ms (`ease-out`); on release it returns on the `press` spring (260ms, 8% overshoot). The wall and the shadow do not move. Selected keys stay down. On hover (pointer devices) the cap rises 1px. A light haptic (`navigator.vibrate(8)`) fires on the commit key only, where supported. Verified in the mock.

**Bubble / inflate reveal** (instead of skeletons). Geometry is reserved first: the niche is on screen at its final size in its final colour from first paint. When the image has decoded, the render scales from `.86` with opacity 0→1 on the `inflate` spring; `animation-delay: calc(var(--i) * 45ms)`; at most six items are staggered, the rest appear together; first appearance only. A failed load shows the empty niche with a one-line message and a retry key. It never keeps moving. In the mock: `.inflate`.

**Stage relight** (choosing a platform). The pressed key goes down and stays; the previous key springs up. The light fades out in 110ms, the render deflates to `.9` and fades (110ms, exit ease), the content swaps (image, headline, tag, link), then the light fades in over 260ms while the render inflates from `.86` on the `inflate` spring. About 370ms in total, interruptible, opacity and transform only. In production the light swap is a cross-fade between two pre-painted layers, not a change of `--gel` on a painted element. Verified in the mock (the mock swaps `--gel`).

**Shared-element card → page zoom.** On tap, `view-transition-name` is set on the tapped card's niche and render only; the niche grows into the stage and the render rides it (`settle` spring, 320–410ms, no overshoot). The page content inflates behind it and never waits for it; the route change and the data request fire on tap. The page opens on the card's already-loaded image and swaps to the larger one when it arrives. Back reverses the same path into the same card with scroll position restored. Fallback where View Transitions are missing: a FLIP transform on the niche, then a 120ms cross-fade. Specified, not built in the mock.

**Sideways push** (sibling contexts: tabs inside a hub, checkout steps, platform hubs). The outgoing view slides 24px toward the trailing side and fades (140ms, exit ease); the incoming view slides in 24px from the leading side and fades in (`settle`). Direction follows reading direction: "next" enters from the inline-end side in both RTL and LTR. Fixed chrome (header, tab bar, step rail) does not move.

**Fly to cart.** In this order:
1. On tap: the cart count, the cart state and the `aria-live` message update immediately. The key shows a check for 1.2s.
2. A 22px red clay bead leaves the product image and travels a quadratic arc lifted 70px above the straight line to the cart bead, shrinking to `.55`. Duration scales with distance (`--t-fly`).
3. The cart bead receives it with a squish: `scale(1.4,.68)` → `(.88,1.16)` → `1` over 340ms.
4. Rapid taps each get a bead, at most three in flight; further taps go straight to the count.
5. On failure the count rolls back, the bead returns along the same arc, and a specific message appears beside the key with a retry.
The toast that follows carries the thumbnail, the variant line and an undo key. Verified in the mock: the count goes 2 → 5 on three rapid taps before any bead lands, never more than three beads are in flight, none are left behind; under reduced motion the count changes with no flight.

**Sheets and menus.** A sheet rises from the bottom edge on the `sheet` spring with its glass header strip attached; the scrim fades by opacity (to 36% black). While dragging, the sheet follows the finger 1:1; on release it continues with the finger's velocity and either settles open or leaves. Only the header strip is blurred. Focus moves into the sheet, is trapped, and returns to the trigger on close; `Escape` closes. Menus and the desktop mega menu drop from their trigger with 8px of travel and opacity (`settle`, 220ms in, 140ms out). On tablet and desktop, cart and filters are side sheets from the inline-end edge.

**Theme morph** (the light changes, not the objects). `document.startViewTransition()` swaps `data-theme` and cross-fades two snapshots over 200ms, so text is legible in every frame and nothing repaints per frame. The red does not change. Without View Transitions, or on the low-end tier, the swap is instant. Verified in the mock.

**Language and direction morph.** Route, scroll position, cart and every form field's value are kept. The content area slides 16px toward the new reading direction's start and cross-fades (140ms out, 220ms in); fixed chrome cross-fades in place; the stage and its render stay exactly where they are as the visual anchor. `dir` and `lang` change on `<html>` at the midpoint. The mock demonstrates the result of the flip (`?lang=en`, `?lang=ckb`), not the transition.

**Currency number morph.** Digits roll per column (160ms, `--ease-water`) in fixed tabular cells, so width never changes. The currency label is visible in every frame. While a converted amount is being fetched, the previous number is shown at `--ink-2` with "≈"; a converted price is never bold and is always labelled as approximate with its rate source and time. The payable amount in dinar stays visible beside it. This is the only motion money is allowed.

**Intro — "the lights come on"** (at most 1.4s, an overlay above an already rendered home, skippable from the first frame, shown once per device):
1. 0–300ms. Bare floor. The supplied logo artwork, used as delivered and pre-split into its layers (mascot, Arabic lettering, "TAM TAM GAMES"), assembles as softly floating clay layers: each inflates from `.86` on the `inflate` spring, 60ms apart, with a static pre-rendered shadow and 6px of parallax between layers.
2. 300–700ms. Four platform lights come on behind it one after another (four pre-painted halos, opacity only, 80ms apart).
3. 600–1000ms. The line "دورك. اختر منصّتك." rises 8px and fades in. The four platform keys inflate out of their well (45ms stagger). A commit key "ابدأ" rises last. "تخطَّ" has been a visible text link since the first frame.
4. Corner objects: one official product cut-out per platform rests half out of frame in each of the four corners, each in its own light.
5. On "ابدأ" (navigation fires at once; home is already underneath): each corner object leans 8px inward (60ms, anticipation) and is then **pulled back out along its own diagonal past the edge** (200ms, exit ease, 40ms stagger). They do not fade. The logo travels as a shared element to its header slot. The chosen key is still held down and the home stage is already lit in that platform's colour.
6. Optional onboarding reuses the same bank with multi-select (`aria-pressed`), a commit key "تابع" and "تخطَّ". Guests can always skip.
7. Returning shoppers never see it; it can be replayed from settings. No video, no audio. Any tap during the sequence jumps to the end state.

**Idle motion policy.** Nothing moves at rest, with one optional exception: the light pool under the home hero may breathe (opacity 0.85 ↔ 1 over 5s) on a small pre-painted layer. It never touches the LCP image, starts 2s after load, and pauses when off screen, when the tab is hidden, on battery saver or save-data, on the low-end tier and under reduced motion. Rails use native scrolling with scroll-snap and the platform's own rubber band; there is no scroll-jacking and no scroll listener.

### 7.3 Reduced-motion equivalents

| Motion | With `prefers-reduced-motion: reduce` |
|---|---|
| Press | The pressed offset is shown with no transition |
| Inflate | Content appears in place |
| Stage relight | Instant swap |
| Card → page | 120ms cross-fade |
| Push | 120ms cross-fade |
| Fly to cart | No flight; the count changes and is announced; the key shows a check |
| Sheet | Appears and disappears with a 120ms fade; drag still works |
| Theme, language | Instant |
| Currency | Number replaces number |
| Intro | Still composition for 300ms, then a 120ms cross-fade |
| Idle | None |

Every function works identically. Verified in the mock for press, add to cart and stage relight.

---

## 8. Layout grammar

**Grammar: floor, stage, keys, shelf.** Every screen is an open floor. At most one lit stage per screen. Controls are keys, in wells when they form a set. One commit key per view. Glass is pinned to an edge. Below the stage, content is arranged in shelves: a section head with one link, then one grid or rail of cards.

**The funnel rule.** Play density drops as the shopper moves toward paying: home (stage, light, key bank, voice) → hub and list (flat niches, chips) → product page (stage, keys; the price on the floor) → cart and checkout (paper, one commit key, no light, no voice).

**Sticky rule.** Never two sticky bars at the same edge. On task screens (product, cart, checkout, chat) the tab bar gives way to one task bar. Bars pad for `env(safe-area-inset-bottom)`.

Wireframes are drawn as seen in Arabic: the start edge is on the right. Labels are written in English so the drawings survive any bidirectional text renderer.

### 8.1 Mobile home (390)

```
+----------------------------------------+
| [ search field, paper        ]    LOGO |  header sits on the floor; becomes glass on scroll
|                    headline: PS5 Pro   |  one line: an Arabic verb + a Latin product name
| +------------------------------------+ |
| |         ( platform light )         | |  LIT STAGE: flat, r-xl, one floating render
| |             [ render ]             | |
| |              ~ pool ~              | |
| +--+-----------------+-+-----------+-+ |
|    | # ADD TO CART # | | name      |   |  commit key and glass price tag hang off the rim
|    +-----------------+ | 1,099,000 |   |
|                        +-----------+   |
|             Your turn. Pick a platform |  label of the key bank
| [well: (Handheld)(Xbox)(PS*)(Nintendo)]|  four platform keys; * = held down
| <- all PlayStation        New arrivals |  section head at the start, the one link at the end
| +-----------------+ +----------------+ |
| |          [used] | |          [new] | |  flat niches; one tag, top-start, in a reserved zone
| |    [render]     | |    [render]    | |
| +-----------------+ +----------------+ |
|    name (2 lines)       name (2 lines) |
|         fact line            fact line |
| (+)       485,000   (+)       749,000  |  price at the start, commit key in its socket at the end
|~~~~~~~~~~~~ glass tab bar ~~~~~~~~~~~~~|
| account  fav  cart(2) categories home* |  five labelled tabs; * = current
+----------------------------------------+
```
Below the fold: a two-row flat panel with entries for "المستعمل" and "الصيانة والمساعدة", then shelves: trending, used and inspected, recently viewed, "يكمّل جهازك".

### 8.2 Category hub (a platform)

```
+----------------------------------------+
| (cart 2)     PlayStation [LED]  (back) |  glass bar once scrolled: back, LED + name, cart
| +------------------------------------+ |
| |  ( light )             PlayStation | |  compact lit stage, 132px: title, count,
| |  [render]             148 products | |  and the platform's lead device
| +------------------------------------+ |
| <[storage][pads][games][consoles][all*]|  chip rail of keys; scrolls sideways with snap
| +----------+ +----------+ +----------+ |  category cards, 3-up: flat niche + label
| | [render] | | [render] | | [render] | |
| +----------+ +----------+ +----------+ |
|  controllers     games       consoles  |
| <- all                        Consoles |  a shelf: head + the one link
| [ product card ]     [ product card ]  |  the same product card as everywhere
| +------------------------------------+ |
| | <-  Everything about PS5  [render] | |  row link to the device hub: a flat niche,
| |     versions, specs, guides        | |  render at the start, arrow at the end
| +------------------------------------+ |
| <- all              Used and inspected |
| [ product card ]     [ product card ]  |
|~~~~~~~~~~~~ glass tab bar ~~~~~~~~~~~~~|
+----------------------------------------+
```

### 8.3 Product list (category, search results)

```
+----------------------------------------+
| (cart 2)   PlayStation consoles (back) |
| 24 items  [sort: newest v]  [filter 2] |  sticky row under the bar: two small keys + count
|                     [1TB x]  [used x]  |  active filters: held-down chips; x removes
| +-----------------+ +----------------+ |
| |    [render]     | |    [render]    | |  2-up grid of flat niches, virtualised
| +-----------------+ +----------------+ |
|   name / fact / price (+)    same card |
|   ...                                  |
|   zero results: the empty state, the   |
|   nearest filter to remove, 3 picks    |
|~~~~~~~~~~~~ glass tab bar ~~~~~~~~~~~~~|
+----------------------------------------+
```

### 8.4 Product detail

```
+----------------------------------------+
| (cart 2)                        (back) |  static glass orbs over the stage
| +------------------------------------+ |
| |         ( platform light )         | |  STAGE: the card's niche, grown (shared element)
| |             [ render ]             | |  swipe changes the view
| | 1 of 4   [th][th][th][th*]   Front | |  thumbnail keys in a well + caption + count
| +------------------------------------+ |
|                 [new]  Handhelds [LED] |  LED + platform as text; one tag
| (fav)               Lenovo Legion Go S |  title; the favourite is a round key at the end
|     one-line description of the device |
| delivery 5,000 IQD ...     899,000 IQD |  ink price; delivery fee and stock beside it
| * in stock, 1-year warranty            |
|                                Storage |
|                  [o 1 TB]  [v 512 GB]  |  option chips: held-down ink key = chosen
|                         Specifications |
|   8 inch, 120Hz                Display |  plain rows on the floor, hairlines
|   ...                                  |
|~~~~~~~~~~~~ glass buy bar ~~~~~~~~~~~~~|
| [###### ADD TO CART ######]    [+ 1 -] |  replaces the tab bar: stepper + commit key
+----------------------------------------+
```
Further down: compatibility ("يعمل مع"), what is in the box, warranty and returns, "يكمّل جهازك" (compatibility-checked), the device hub link, FAQs, and verified reviews only when real ones exist.

### 8.5 Cart

```
+----------------------------------------+
|                        Cart (3) (back) |
| +------------------------------------+ |
| | 749,000 IQD    name (2 lines) [th] | |  cart line: a paper row; thumbnail in a niche
| |                fact line           | |
| | remove . to favourites     [+ 1 -] | |  small stepper; text actions
| +------------------------------------+ |
|   ... more lines                       |
| [apply] [ discount code              ] |  field + small key; a rejection reason shows inline
| -------------------------------------- |
|  1,234,000 IQD                Subtotal |  totals on paper: tabular, never animated
|      5,000 IQD                Delivery |
|  1,239,000 IQD                   Total |
| <- all             Complete your setup |
| [ product card ]     [ product card ]  |
|~~~~~~~~~~~~ glass task bar ~~~~~~~~~~~~|
| [#### CHECK OUT ####]    1,239,000 IQD |  one commit key; the tab bar is gone
+----------------------------------------+
```

### 8.6 Checkout step (address; guest by default)

```
+----------------------------------------+
|                        Checkout (back) |
| (3) Review - (2) Payment - (1) Address*|  step rail: numbers + labels; done steps are links
|   Continue as guest. Account optional. |
|                         Phone number * |
| [                      0770 123 4567 ] |  paper fields, 52px, bordered; numbers stay LTR
|                          Governorate * |
| [ v                          Baghdad ] |  opens the governorate sheet (18 rows)
| [                    ]          Area * |
| [                    ]  Full address * |
| [                    ] Notes (optional)|
|     Preferred delivery time (optional) |
|      [day after] [tomorrow] [today]    |  chips
|      [evening] [afternoon] [morning]   |
|   A preference, not a confirmed slot.  |  help text
| Send me offers on this number      [ ] |  never pre-checked
|~~~~~~~~~~~~ glass task bar ~~~~~~~~~~~~|
| [# CONTINUE TO PAYMENT #]    1,239,000 |  the total and exactly one commit key
+----------------------------------------+
```
Payment step: an option-row list (cash on delivery, wallet for signed-in customers, Mastercard transfer, Zain Cash transfer); a transfer shows the account in a paper panel with a copy key, the fraud warning, an amount field and the proof uploader. Review step: editable summary and total, then the commit key "أكّد الطلب".

### 8.7 Device hub (everything about one device)

```
+----------------------------------------+
| (cart 2)          PlayStation 5 (back) |
| +------------------------------------+ |
| |      lit stage, 200px: device      | |
| +------------------------------------+ |
|        Everything about PlayStation 5  |
| <[guides][accessories][specs][models*] |  section keys: sticky anchor navigation
|                                 Models |
|    | Digital |   Pro   |  Slim  |      |  comparison table: paper, hairlines,
|    |   1TB   |   2TB   |  1TB   |      |  sticky first column, scrolls sideways
| <- all          Compatible accessories |
| [card: v compatible]  [card: v compat.]|  compatibility is a stated fact, never inferred
|                           Setup guides |
| <                     First-time setup |  disclosure rows on paper
| <        Moving data from an old unit  |
| +------------------------------------+ |
| | <- Something wrong? Ask the helper | |  row link to the repair assistant
| +------------------------------------+ |
| <- all        Used units of this model |
|~~~~~~~~~~~~ glass tab bar ~~~~~~~~~~~~~|
+----------------------------------------+
```

### 8.8 Desktop header and mega menu (≥1200)

```
+----------------------------------------------------------------------------------------------------------+
| AR . Kurdish . EN | IQD . Help . Trade in . Track your order     Delivery 5,000 IQD, all governorates    |  utility strip, 38px, flat
+----------------------------------------------------------------------------------------------------------+
| (cart 2)(me)(fav)(theme)  [ search field ]  Repair  Used | =Handhelds =Xbox =PlayStation =Nintendo LOGO  |  80px; = is an LED
+----------------------------------------------------------------------------------------------------------+
| MEGA MENU: one glass sheet (live) dropping from the header; bottom corners r-xl                          |
|                                                                                                          |
|   About the device       Accessories       Games            Consoles        +----------------+           |
|   PS5 Pro                Controllers       New arrivals     PS5 Pro         |   lit stage    |           |
|   PS5 Slim               Headsets          Preorders        PS5 Slim        |   [ render ]   |           |
|   PlayStation Portal     Storage           Used games       <- Used PS5     +----------------+           |
+----------------------------------------------------------------------------------------------------------+
```
Platform entries are text links with an LED; the open platform's name is underlined. Columns are plain text links. Focus is trapped while open; `Escape` closes and returns focus.

### 8.9 Desktop home

```
+----------------------------------------------------------------------------------------------------------+
| header                                                                                                   |
| +-----------------------------------------------------+       headline: Switch 2     (68px)              |
| |                 ( platform light )                  |       deck, one line                             |
| |                     [ render ]                      |       [See the console] [# ADD TO CART #]        |
| |                      ~ pool ~                       |       delivery 5,000 IQD ...                     |
| |                                                     |       Your turn. Pick a platform                 |
| +-----------+---------------+-------------------------+       [well: (HH)(Xbox)(PS)(Nintendo*)]          |
|             | name  749,000 |   glass tag on the rim                                                     |
|             +---------------+                                                                            |
| <- all Nintendo                                                                  New arrivals            |
| [card]   [card]   [card]   [card]   [card]   [card]          6-up; full cards: price + commit key        |
+----------------------------------------------------------------------------------------------------------+
```
Copy column (5 of 12) on the inline-start side, stage (7 of 12) on the inline-end side, so it mirrors correctly in LTR (see `desktop-en.png`).

### 8.10 Desktop product detail

```
+----------------------------------------------------------------------------------------------------------+
| header                                                          Legion Go S / Handhelds [LED]            |
| +-----------------------------------------------------+   [new]                                          |
| |                 ( platform light )                  |   (fav)             Lenovo Legion Go S           |
| |                     [ render ]                      |   one-line description of the device             |
| |                                                     |   delivery 5,000 IQD       899,000 IQD           |
| | 1 of 4        [th][th][th][th*]               Front |   Storage      [o 1 TB]  [v 512 GB]              |
| +-----------------------------------------------------+   [##### ADD TO CART #####]   [+ 1 -]            |
|   Specifications (a table on paper)                       * in stock, 1-year warranty                    |
|   ...                                                     Complete your setup: [card] [card]             |
+----------------------------------------------------------------------------------------------------------+
```
The stage is sticky across 7 columns. The buy controls live in the 5-column info column as a flat panel that is sticky inside that column; there is no bottom bar and no glass on the desktop product page except the scrolled header and dialogs. The flight target is the cart orb in the header.

### 8.11 Tablet (768–1199)

- Gutter 24, card gap 16. The tab bar stays (touch); the header gains the search field at full width and the utility links move into "حسابي".
- Home: stage and copy sit side by side 6 + 6 from 768; the key bank stays under the copy. Rails become grids: 3-up at 768, 4-up at 1024.
- Category hub: category cards 4-up then 6-up; product grid 3-up then 4-up.
- Product page: stage full width on top at 768 with the buy bar at the bottom; from 1024 it switches to the desktop 7 + 5 split with the buy panel in the column.
- Cart and checkout: content column max 640 centred; from 1024 the order summary becomes a sticky side column and the task bar is replaced by the commit key under the summary.
- Sheets: pickers become centred dialogs (max 520); cart and filters become side sheets from the inline-end edge (420).

---

## 9. Components

### 9.1 Links

One look: `--ink`, weight 600, with an arrow that follows the reading direction (`.link`); underlined on hover. Inside a paragraph the same link is always underlined (`.link--inline`, 1.5px, offset 6px). Links are never red and never clay. Minimum hit height 44.

### 9.2 Header

- **Mobile, top of a page:** part of the floor. Logo at the start (the supplied artwork; the mock uses live text as a stand-in), search field filling the rest. The search field is a doorway: tapping it opens the search screen with recent searches, suggestions in three languages and category-aware results.
- **Mobile, after about 24px of scroll:** condenses into a 56px live glass bar with the logo mark and the search field. That is the moment it earns its blur.
- **Task screens:** two static glass orbs over the stage (back at the start, cart with its bead at the end); after scroll, a live glass bar with back, title and cart.
- **Desktop:** utility strip (delivery fact; order tracking, trade-in, help, currency, languages) and an 80px header (logo, platform links with LEDs, used, repair, search field, theme, favourites, account, cart orb). Flat at the top of the page, one live glass bar after scroll.

### 9.3 Mobile nav (tab bar)

Live glass pinned to the bottom edge, top corners `--r-xl`, 64px plus the safe-area inset. Five always-labelled tabs in reading order: الرئيسية، التصنيفات، السلة، المفضلة، حسابي. Active tab: filled icon, weight 600 and a 22×3 ink marker on the bar's top edge; never colour alone and never red. The cart count is the red clay bead and the landing target of the flight. Used devices and Support are the first rows of التصنيفات, a panel on home, and contextual links on hubs, product pages and orders.

### 9.4 Category cards

A flat niche (aspect 1:1) with one render and no light, and the label on the floor beneath it in `--type-strong`. The whole card is a link. Three-up on mobile. No tag, no price, no key.

### 9.5 Product cards (the one card)

```
+--------------------+
|              [tag] |   .niche: flat, r-lg, aspect 3:2, background --stage
|      [render]      |   tag zone: top-start 8px; the render slot starts 30px down, so they never touch
+--------------------+
  Name, up to 2 lines    --type-strong; height reserved for two lines
            Fact line    --type-caption, --ink-2: storage, condition grade, warranty
 (+)      749,000 IQD    price at the start; commit key in its socket at the end

(drawn as seen in Arabic: start = right)
```

- No card chrome: no border, no shadow, no background around the text.
- Exactly one tag per card, stating a fact (new, used with grade, preorder). Never a price or a discount shouted in colour.
- The add key has an accessible name ("أضف {name} إلى السلة"), a cart-plus glyph, a 52px socket, and shows a check for 1.2s after an add. Products with required options open the quick-preview sheet instead of adding.
- Unavailable: the socket is empty, the fact line says "نفد" in `status--bad` with "أعلمني عند التوفّر" as a link.
- Used devices show a real photo of the unit in the niche (`object-fit: cover`) labelled "صورة الجهاز نفسه".

### 9.6 Media gallery

On the product stage: the render, swipeable, with thumbnail keys (50×44) in a well, a caption for the current view and a count ("الواجهة · 1 من 4"). The current thumbnail is held down with an ink ring. Tapping the render opens the full-screen viewer (opaque `--ground`, pinch zoom, the same thumbnail keys in a glass strip, close key at the end). Changing a colour variant cross-fades the render (opacity, 160ms). Used devices: real photos, a visible label, and defect photos first in order.

### 9.7 Filter drawer

A bottom sheet on mobile, a side sheet from 768. Glass header strip with the title, result count and close key; opaque body. Groups are labelled sets of chips (platform, model, condition, storage, warranty) and a price range with two paper fields and a slider whose handle is a round key. Results update as filters change; the list never blocks on the drawer. Footer: a neutral key "امسح الكل" and a key "اعرض 24 منتجاً" (not red: it commits nothing to the order). Active filters also appear as removable chips above the list.

### 9.8 Chips

`.key--chip`: 44px, short labels only. Unchosen: white clay with a hollow ring. Chosen: held down, ink, with a check. Single choice uses `role="radiogroup"` with roving tabindex and arrow keys that follow reading direction; multi-choice uses `aria-pressed`. Chips are for choices. A non-interactive fact is never chip-shaped: facts are plain text or a `.tag`.

**Option rows** (the one pattern for choices that carry more than a label: payment method, delivery address, trade-in answers with explanations): a paper row with a 1.5px `--line-strong` border, a radio mark at the start, a title and one line of explanation. Chosen: 2px `--ink` border and a filled mark.

### 9.9 Form fields and validation

Flat paper with a real border: 52px high, `--r-md`, 1.5px `--line-strong`, 16px text (no zoom on iOS), label above in weight 600, help below in caption. Focus: 2.5px ink outline with 2px offset. Phone and numeric fields stay LTR but hug the start edge.

Validation is instant and specific: checked on blur, re-checked on every keystroke once an error is showing. Error state: 2px `--red-ink` border, an alert icon and a sentence that says what is wrong and what to type ("ينقص الرقم 4 أرقام."), linked with `aria-describedby`, announced politely. Never colour alone, never a red fill, never "invalid input". Success needs no decoration. Required fields are marked with "*" and the word in the label for screen readers; optional fields say "(اختياري)".

### 9.10 Steppers

Two round keys in a well with a tabular numeral between them. The minus is at the start and the plus at the end, in every language and on every screen. At the minimum the minus becomes flat and disabled; reaching the stock limit shows "بقي 2 فقط" beside it. Small variant (36px keys with a 44px hit area) inside cart lines.

### 9.11 Price display

```html
<p class="price price--xl"><bdi class="price__num">749,000</bdi><span class="price__cur">د.ع</span></p>
```

- Ink, Kufam 700, tabular lining numerals, comma thousands separator, integer dinars. The currency label follows the number: "د.ع" in Arabic and Sorani, "IQD" in English.
- Never red, never struck through in red, never animated except the digit roll on a currency switch.
- A discount is shown as the old price in `--ink-2` with a line through it before the current price, and the saving as plain text in the fact line ("توفّر 50,000 د.ع"). It is not a second tag and never a colour.
- **Converted currencies:** the dinar price stays primary. The converted amount sits beneath it in `--ink-2`, prefixed with "≈" and followed by "الدفع بالدينار"; the rate source and refresh time are one tap away. A converted number is never bold and never appears alone on a commit key or a total.
- Delivery is stated beside the product price, not further down: "التوصيل 5,000 د.ع لكل المحافظات".

### 9.12 Badges

- **Tags** (`.tag`): 24px, `--r-xs`, one per object. New = solid ink. Used = outlined, with the grade as text ("مستعمل · ممتاز", "مستعمل · جيد جداً", "مستعمل · جيد"). Preorder and refurbished are outlined too. Shape, not colour, separates them.
- **Status** (`.status`): a 7px dot and text in `--ok`, `--warn`, `--info` or `--red-ink`: "متوفر", "بقي 2", "نفد", "بانتظار التحقق". Always with words.
- **Bead** (`.bead`): the red count on the cart, and in admin the count of items waiting for a human. Nothing else is a bead.

### 9.13 Toasts

Live glass, `--r-md`, pinned under the header so it never covers a task bar. Minimum height 60: product thumbnail in a small niche, a bold first line and a secondary line in `--on-glass-2`, and one small clay key (undo, or view cart). Auto-dismisses after 4s, pauses on hover and focus, `role="status"`. One toast at a time; a new one replaces the old. Anything that needs a decision is not a toast: it is inline.

### 9.14 Sheets

Bottom-anchored. Header strip of live glass (`.glass.glass--bottom`, top corners `--r-xl`) with a grab handle, a title and a round clay close key; opaque body. Maximum height 90% of the viewport; internal scrolling. Motion and focus rules in §7.2. Used for filters, the governorate picker (18 rows with the fee shown), quick preview, variant choice and reason codes.

### 9.15 Dialogs

Centred, at most 420 wide on mobile and 520 on desktop, `--r-xl`, opaque `--paper` body, a scrim, an optional glass header strip. One sentence that says what will happen, then at most two keys: a neutral key and the action. A destructive action is a neutral key with a `--red-ink` label, and it states the consequence ("احذف العنوان"). The commit key appears in a dialog only when the dialog itself confirms an order step.

### 9.16 Empty, error, offline

- **Empty:** a flat niche panel with an empty socket, one sentence in the brand voice and one key that says where to go: "سلتك فارغة. دورك." with "تصفّح الأجهزة". Rendered in the mock.
- **Error (load failed):** the reserved space stays; a flat panel says what failed and offers a retry key. It never keeps animating and never pretends to load.
- **API failure on an action:** the optimistic change rolls back, and a sentence beside the control says what happened and what to do. Stock race: "بيعت آخر قطعة قبل لحظات. أزلناها من سلتك."
- **Offline:** a flat ink banner pinned under the header ("لا يوجد اتصال. سلتك محفوظة على هذا الجهاز."). Not glass and not red. Keys that need the network go flat with the reason beside them.
- **Pending review, unauthorised:** a status line with words, and the next step; never a blank screen.

### 9.17 Checkout steps

A step rail of three numbered steps with text labels (العنوان، الدفع، المراجعة). Done: an ink disc with a check, and it is a link back. Current: an ink ring and a bold label. Upcoming: a `--line-strong` ring and an `--ink-2` label. Moving between steps is a sideways push; every field keeps its value. The task bar always shows the total and exactly one commit key. Guest checkout is the default path; signing in is a link, never a wall.

### 9.18 Proof uploader (manual transfers)

A paper drop area, `--r-lg`, with a dashed 1.5px `--line-strong` border.

| State | Appearance |
|---|---|
| Empty | Upload icon, "ارفع صورة الحوالة", accepted types and size limit in caption |
| Uploading | File name, a determinate ink progress bar, percentage in tabular type, "ألغِ" as a link |
| Interrupted | "توقّف الرفع عند 60%." with a key "أكمل الرفع" |
| Uploaded | Thumbnail in a niche (from a signed, private URL), file name, "استبدل الصورة" |
| Failed | A `--red-ink` sentence with the reason (type, size, network) and a retry key |
| Pending verification | `status--warn` "بانتظار التحقق" and the line "استلمنا صورة الحوالة. نراجعها ثم نؤكد طلبك." |
| Rejected | `status--bad` with the reviewer's reason, and the uploader ready again |

Above it: the transfer details in a paper panel (recipient name, account or wallet number in tabular type, each with a small copy key that shows a check and "نُسخ"), the amount field, and the fraud warning as a flat panel with an info icon. The order is never shown as paid until a person has approved it.

### 9.19 Wallet balance

A paper panel: the label "رصيد المحفظة", the balance in price type, and pending amounts on their own line with a warn status. Beneath it the ledger: flat rows with date, description, signed amount (tabular, a minus sign and `--red-ink` for debits) and status. The balance is never an editable number. Guests see one sentence and a sign-in link in its place. At payment, the wallet option row shows the balance and what will remain.

### 9.20 Used-device inspection card

A paper panel on the product page of every used unit.

- Head: the grade tag (outlined), the inspection date, and "صور الجهاز نفسه" above real photographs (thumbnails with a 1px line border; never manufacturer images).
- Checklist: flat rows, each with a check or alert icon and words: screen, buttons and sticks, ports, disc drive, charging, battery health as a percentage when it can be measured and "غير قابل للقياس" when it cannot.
- Cosmetic defects: listed in words with their photos first.
- Included accessories; warranty and return conditions in plain sentences.
- Nothing is animated. Serial numbers and private data never appear.

### 9.21 Trade-in wizard

The checkout step rail (الجهاز، الحالة، الصور، التقدير، الفحص). One question per screen; answers are option rows with a one-line explanation. Photos use the proof uploader pattern. The estimate screen shows a **range** in price type under the label "سعر تقديري", an outlined tag "بانتظار الفحص", the expiry date, and the sentence "هذا سعر تقديري. السعر النهائي بعد فحص الجهاز." There is no commit key until a person has issued a final quote; then "اقبل العرض" is the commit key and "ارفض" a neutral key. Tracking reuses the order timeline.

### 9.22 Repair assistant bubbles

- The customer's messages: flat `--niche` bubbles at the inline-end side. The assistant's: `--paper` with a 1px line at the inline-start side. `--r-lg`, with the corner nearest the speaker at `--r-xs`. No glass and no clay on bubbles.
- Suggested replies are chips. Troubleshooting steps are a numbered list inside one paper bubble, each step tickable.
- Uncertainty is stated in words at the top of an answer ("غالباً"، "غير متأكد") with an info status dot. The assistant never states a definite hardware diagnosis.
- Safety warnings (battery, mains power, opening the device, warranty) are a flat panel with a warn icon and `--warn` text, never dismissible mid-step.
- Handoff: a paper card with the ticket number in tabular type, a summary of the conversation and a key "تحدّث مع موظف".
- Composer: a paper field and a round ink-labelled send key in a live glass task bar. The send key is not red.

---

## 10. Admin adaptation

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
[data-density="admin"] .key--round .key__cap{inline-size:32px}
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

**Tables and financial grids.** Flat paper. No clay, no glass, no shadow, no radius above 4px inside a grid, no animation beyond an instant row highlight. 36px rows (48 on mobile approval queues), hairlines, sticky solid header. Numbers are tabular, aligned to the inline end, wrapped in `<bdi>`, with the currency in the column head. Negative amounts carry a minus sign and `--red-ink` text; there is never a red cell background. Text is full `--ink` on `--paper`: 15.47:1 light, 14.66:1 dark. Cost and profit columns are absent from the DOM and the API response for roles without the permission; the design reserves no blurred or masked placeholder that could suggest the data is only hidden.

**Navigation.** A 248px side rail at the inline start in static glass (it rests on the flat page, so it needs no live blur). The 23 modules are flat 36px rows in groups ordered by priority (P0 first), with caption group heads. Only the **active module** is clay: a held-down ink key, exactly like a selected chip on the storefront. Queue rows show a bead with the number of items waiting for a person. Collapsed, the rail is 64px of icons with tooltips. On tablets it becomes a top bar; on phones a tab bar with the approvals queue first.

**Summary cards.** KPI cards are flat: paper with a 1px line, a caption label and the figure in `--type-kpi`. The only raised cards (`.clay.clay--walled`) are the ones that need a human decision: transfer proofs awaiting review, guest orders to verify, low stock, failed deliveries, approvals. The relief map of the dashboard is the to-do list; a dashboard with nothing raised is a clean desk.

**Filters.** Above every table: saved views as chips (held down = the current view), a filter key that opens a side sheet of paper fields, the active filters as removable chips, a search field, a density toggle and a neutral export key. Filtering never blocks typing.

**Bulk actions.** Selecting rows raises a bulk bar from the bottom of the table region: live glass (rows scroll under it), the count in tabular type, neutral keys, and at most one commit key. The table gains bottom padding so the bar never covers the last row. Destructive bulk actions open a reason-code dialog.

**Red in admin** keeps its meaning and gets stricter: the commit key is the single action on a screen that moves money or stock and cannot be casually undone ("اعتمد الحوالة"، "أصدر الاسترجاع"، "رحّل الجرد"). Everything else is a neutral key. Rejections and deletions are neutral keys with a `--red-ink` label and a mandatory reason code. Brand red never means danger; danger is words, an icon and `--red-ink`.

**Command palette.** `Ctrl/⌘ K`. A dialog with a glass header strip holding one paper search field, and an opaque paper body of 36px result rows grouped as orders, products, customers, actions. The highlighted row has a niche fill and an ink start-edge bar. Keyboard hints in caption type. It opens with opacity and 8px of travel and nothing else moves.

**Audit timeline.** Flat paper. A 1px vertical line with 7px dots: solid ink for a person's action, hollow `--ink-2` for automation. Each event is one sentence (who did what to which record), the time in tabular type, an outlined reason-code tag and a link to the before and after values. There is no edit or delete affordance anywhere on it, because the trail is immutable. Filter by person, record and date; export is a neutral key.

**Dialogs and mobile approvals.** Dialogs follow §9.15. On a phone, a payment-proof review opens the image full width with pinch zoom, the claimed amount against the order total in tabular type (a mismatch is a warn status with both numbers), a duplicate-reference warning when one exists, and a glass task bar with two keys: neutral "ارفض مع السبب" and commit "اعتمد". Rejecting opens the reason-code sheet. Every approval writes an audit event.

**Status.** Text with a dot in `--ok`, `--warn`, `--info`, `--red-ink`, always with words ("مدفوع"، "بانتظار التحقق"، "تم الشحن"، "مرفوض"). Platform appears as the same 16×5 LED before the platform name in product and inventory columns.

**Charts.** Ink series on a hairline grid, `--ink-2` and `--ink-3` for secondary series. Platform breakdowns use the four gel colours with text labels. Thresholds and negatives use `--red-ink`. No gradients, no animation on load beyond a 160ms fade.

**Type and language.** Kufam appears only in page titles and KPI numerals; everything operational is IBM Plex Sans Arabic. Arabic, English and Sorani work with no change because both families cover them.

---

## 11. Copy voice

**Plain, specific, active.** Say what happened and what to do next, with the number and its unit. Simple Modern Standard Arabic that reads naturally in Iraq. Address the shopper directly with an imperative verb: أضف، اختر، أكمل، ارفع.

- A button says what it does: "أضف إلى السلة"، "تابع إلى الدفع"، "أكّد الطلب". Never "موافق" or "إرسال".
- An error says what is wrong and how to fix it. No apology formulas, no exclamation marks, no blame.
- Never promise what the shop cannot guarantee. Delivery times are preferences; estimates are labelled as estimates; a transfer is "بانتظار التحقق" until a person approves it.
- Numbers are exact and always carry their unit: "5,000 د.ع"، "ضمان سنة"، "بقي 2".
- The game-turn voice ("دورك.") is used in exactly three places: the home key bank, onboarding and empty states. Never in checkout, errors, payments or anything about money.
- Latin product names stay in Latin; they are not transliterated.

| # | Context | العربية | English | کوردیی سۆرانی |
|---|---|---|---|---|
| 1 | Commit key | أضف إلى السلة | Add to cart | بیخە ناو سەبەتە |
| 2 | Home key bank | دورك. اختر منصّتك. | Your turn. Pick your platform. | نۆرەی تۆیە. پلاتفۆرمەکەت هەڵبژێرە. |
| 3 | Delivery fact | التوصيل 5,000 د.ع لكل المحافظات. | Delivery is 5,000 IQD to every governorate. | گەیاندن 5,000 د.ع بۆ هەموو پارێزگاکان. |
| 4 | Guest checkout | أكمل الطلب بدون حساب. | Check out without an account. | بەبێ هەژمار داواکارییەکەت تەواو بکە. |
| 5 | Phone validation | ينقص الرقم 4 أرقام. اكتبه مثل 0770 123 4567. | The number is 4 digits short. Write it like 0770 123 4567. | ژمارەکە 4 ژمارەی کەمە. وەک 0770 123 4567 بینووسە. |
| 6 | Transfer proof received | استلمنا صورة الحوالة. نراجعها ثم نؤكد طلبك. | We received your transfer photo. We review it, then confirm your order. | وێنەی حەواڵەکەمان پێگەیشت. پێداچوونەوەی بۆ دەکەین، پاشان داواکارییەکەت پشتڕاست دەکەینەوە. |
| 7 | Preferred delivery time | هذا وقت مفضّل وليس موعداً مؤكداً. نتصل بك لتأكيده. | This is a preferred time, not a confirmed appointment. We call you to confirm it. | ئەمە کاتی دڵخوازە، نەک ژوانێکی پشتڕاستکراو. پەیوەندیت پێوە دەکەین بۆ پشتڕاستکردنەوەی. |
| 8 | Empty cart | سلتك فارغة. دورك. | Your cart is empty. Your turn. | سەبەتەکەت بەتاڵە. نۆرەی تۆیە. |
| 9 | Used device photos | هذه صور الجهاز نفسه الذي يصلك. | These are photos of the exact unit you receive. | ئەمانە وێنەی هەمان ئەو ئامێرەن کە پێت دەگات. |
| 10 | Trade-in estimate | هذا سعر تقديري. السعر النهائي بعد فحص الجهاز. | This is an estimate. The final price comes after we inspect the device. | ئەمە نرخێکی خەمڵێنراوە. نرخی کۆتایی دوای پشکنینی ئامێرەکە دیاری دەکرێت. |
| 11 | Stock race | بيعت آخر قطعة قبل لحظات. أزلناها من سلتك. | The last one sold a moment ago. We removed it from your cart. | دوا دانە پێش چەند ساتێک فرۆشرا. لە سەبەتەکەت لامانبرد. |
| 12 | Offline | لا يوجد اتصال. سلتك محفوظة على هذا الجهاز. | No connection. Your cart is saved on this device. | هێڵی ئینتەرنێت نییە. سەبەتەکەت لەسەر ئەم ئامێرە پاشەکەوت کراوە. |

The Sorani column was written for this spec and must be reviewed by a native Sorani reader before launch.

---

## 12. Product imagery (official product photography)

Decided by the client on 2026-11-11: **no 3D renders** (the three.js clay-render pipeline is retired). Every product is shown with its **official manufacturer or publisher images**, researched per product in `catalog/` (see `catalog/README.md`) and processed by `scripts/products/images.mjs`.

- **Hero first.** The first image is a clean front or three-quarter shot of exactly this product, edition and colour; games show the front box art (pack shot). Lifestyle photos never come first.
- **Cut-outs where they are clean.** Sources with real transparency are trimmed and padded. Opaque photos on a uniform light background are cut out only when the result passes validation (no fragments, nothing eaten from white products); otherwise the photo stays opaque and is shown in its own rounded frame filled with its recorded background colour, so it still sits cleanly on a niche or stage. Box art and screenshots are always rectangles.
- **The stage still works:** a cut-out floats on the lit stage with the CSS contact shadow; an opaque photo sits on the stage inside its frame, without the floating tilt.
- **Delivery:** AVIF and WebP at 240, 480, 720, 960 and 1440 wide (up to the source size); the `<img src>` fallback is the 720 WebP, and each product’s first image also has one share picture (JPEG or PNG, at most 1200 px, `productShareImage(slug)`) for Open Graph; `srcset`/`sizes`, explicit width and height, a tiny blurred placeholder and the dominant colour. Manifests live in `app/art/photos/<slug>--<n>.json` and are rendered by `<Art name="<slug>--<n>" />`.
- **Credit and rights:** every image records its owner (`credit`) and source URL. They are manufacturer marketing images used to sell genuine products; the store owner confirms usage rights with distributors before launch.
- **Used devices** are photographed, not taken from the manufacturer: real photos of the unit on a neutral background, labelled as such, never lit by the platform light. A used listing that only has the manufacturer image says so plainly ("صورة توضيحية — ليست صورة الجهاز نفسه").

---

## 13. Accessibility and internationalisation rules

- Text contrast is AA in both themes, computed (§5.4). Field boundaries reach 3:1.
- Every pressable target is at least 44×44. The mock was checked by script: none smaller on the two screens and the materials strip.
- Focus is always visible: a 2.5px ink outline with a 3px offset.
- State is never carried by depth, shape or colour alone (§6.1). Radio groups use roving tabindex with arrow keys that follow reading direction.
- Cart changes are announced through an `aria-live="polite"` region. Dialogs and sheets trap focus and return it.
- `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast` and `forced-colors` each have a defined result (§6.5, §7.3).
- Logical properties only. Directional icons mirror by rule (`[dir="ltr"] .ico.is-dir`). Latin names and numbers inside Arabic or Sorani are isolated with `<bdi>`.
- Icons that are the only content of a control always have an accessible name.
- All copy exists in Arabic, English and Sorani; layouts are checked at 360, 390 and 430 in each.

---

## 14. Verified, not verified, open

**Verified in the mock (desktop Chromium, by screenshot and script)**

- No horizontal overflow and no element outside its screen at 360, 390 and 430 in Arabic, English (LTR) and Sorani; no console or page errors in any of 13 renders.
- The hero headline stays on one line for all four platforms in all three languages.
- Platform switch, option chips, gallery thumbnails, favourite, quantity, add to cart (including three rapid taps and the reduced-motion path) behave as specified.
- 110 contrast pairs pass, including glass over its worst-case backdrops.
- Red covers 3.6% of the home screenshot, 3.2% of the product page and 1.7% of the desktop block.
- Both themes for both screens and the desktop block; the LTR mirror of all three.

**Not verified**

- Anything on a physical phone: frame times, blur cost, Core Web Vitals. The blur budget and motion timings are design intent.
- Safari, WebKit on iOS, and Firefox.
- The `prefers-contrast` and `forced-colors` rules are written but were not rendered.
- The shared-element zoom, sideways push, sheet drag, language morph and intro are specified, not built.
- Self-hosted font files and metric-adjusted fallbacks (the mock loads Google Fonts).

**Open questions**

1. **Logo artwork.** The mock uses live text as a stand-in. Production needs the supplied artwork as vector or high-resolution files, split into three layers (mascot, Arabic lettering, "TAM TAM GAMES") for the intro. Who supplies them?
2. **Sorani review.** A native reader must review every Sorani string, and Kufam's final ە and ڵا, before Kufam is allowed for Sorani headlines.
3. **How little red is acceptable?** The references are roughly a third red; this system is under 4%. The escape hatch is lighting the home stage in brand red for campaigns. Does the client accept that as on-brand?
4. **Digits.** Western digits in all three languages, as in the brief's price format, or Arabic-Indic digits for Arabic and Sorani?
5. **Stepper order.** Minus at the start and plus at the end in every language, so it mirrors with direction. Confirm with Iraqi shoppers.
6. **Product photography.** Resolved 2026-11-11: official manufacturer and publisher images (see section 12); the owner confirms usage rights with distributors before launch.
7. **Hero merchandising.** The CMS must let staff choose and schedule the staged product and headline per platform, within the headline length budget.
8. **Font budget.** About 272 KB if every file loads. Is the three-weight text plan acceptable once measured, or do we drop the 500 weight?
9. **Kurmanji.** If a Latin-script Kurdish locale is wanted, its letters must be checked in both families first.
