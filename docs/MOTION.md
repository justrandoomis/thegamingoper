# TamTam Motion Engine

Motion in TamTam should feel like water, bubbles and elastic clay — and it must never make an interaction slower.
The specification is **docs/DESIGN.md §7** (tokens, grammar, reduced-motion equivalents); this file says how the engine
implements it, what was measured, and where it deliberately differs. Everything lives in `app/motion`, is imported from
`~/motion`, and runs at **`/motion`** (the lab: every piece on flat token surfaces, in `ar`, `en` and `ckb`).

- No animation library: CSS, the Web Animations API and React 19.3 `<ViewTransition>`.
- Only **transform and opacity** are animated (a test fails if a `@keyframes` block in the engine touches anything else).
- Feedback starts in the frame after pointer-down. Navigation, data and state changes never wait for an animation.
- Everything is interruptible: any touch, key press or wheel ends a running page transition at once.
- Reduced motion replaces movement with a 120 ms cross-fade or nothing (DESIGN.md §7.3); every flow still works.
- Tokens: `app/motion/tokens.ts` (script) mirrors `app/styles/tokens.css` (design system); a test keeps them equal.

## 1. Setup (shell owners)

```tsx
// a layout route — once per app is enough; mounting it twice is harmless
import { MotionRoot, PageTransition } from "~/motion";

export default function StorefrontLayout() {
  return (
    <>
      <MotionRoot />
      <Header data-motion-persist="header" />        {/* fixed chrome that must not travel with the page */}
      <PageTransition>
        <Outlet />
      </PageTransition>
      <BottomNav data-motion-persist="nav" />
    </>
  );
}
```

- `<MotionRoot />` renders nothing. It installs passive, delegated document listeners, keeps
  `<html data-motion="full|lite|reduced">` (and class `fx-low` at the low-end tier) up to date and imports `motion.css`.
- `<PageTransition>` wraps the outlet in a plain `<div data-motion-page>` (pass `className`/`style` if the layout needs
  it). Keep it mounted; do not key it. Nested layouts may each have one — a navigation is planned once.
- Chrome that stays put during page transitions: `data-motion-persist="header" | "nav" | "bar" | "float"` (one element
  per value on screen). On a language switch it cross-fades in place.
- The stage (and anything else that should stay put while the language changes): `data-motion-anchor`. Anchors must
  look the same in both reading directions (full width or centred) — they do not slide, so a box at the inline start
  would jump to the other side.
- The cart: `data-cart-target` on the cart button, `data-cart-badge` on its bead (see `flyToCart`).
- **Before first paint** (DESIGN.md §6.5 wants `fx-low` before the first frame): the root layout puts
  `MOTION_TIER_SCRIPT` (from `~/motion/tier-script`, 0.7 KB) in `<head>` next to its theme script. It sets the same
  attributes `<MotionRoot>` sets later, by the same rule (a unit test runs both over all 1,280 signal combinations).
  Wired in `app/root.tsx` (with the request nonce) since 2026-11-11.

## 2. Tokens (DESIGN.md §7.1)

| Kind | Engine (`tokens.ts`) | CSS in the engine | Design token (`tokens.css`) |
|---|---|---|---|
| Springs `{response, dampingRatio}` → settle | `springs.press` {.16,.62} → 260 ms, `squish` {.26,.50} → 510, `inflate` {.28,.68} → 430, `settle` {.30,1} → 410, `sheet` {.30,.86} → 390 | `--motion-spring-<name>` (`linear()`), `--motion-spring-<name>-duration` | `--spring-<name>`, `--spring-<name>-t` |
| Durations | `durations.press` 80, `exit` 140, `micro` 160, `release` 180, `theme` 200, `base` 220, `reveal` 240, `sheet` 280, `page` 320, `fly` 460 | `--motion-duration-<name>` | `--t-<name>` |
| Curves | `easings.settle`, `squish`, `exit`, `water` | `--motion-ease-<name>` | `--ease-<name>` |
| Distances | `travel.push` 24, `direction` 16, `menu` 8, `rise` 48, `fade` 8 (px) | `--motion-travel-<name>` | — (from the §7.2 prose) |

- `tests/motion.test.ts` checks `tokens.ts` against `app/styles/tokens.css`: the five pairs and settle times, the 21
  samples of each design `linear()` against the engine's solver (within 0.003), durations and curves.
- The engine's own `linear()` curves are generated from the closed-form spring (≤ 40 stops, within 0.5 % everywhere):
  `npx tsx app/motion/__checks__/gen-css.mjs` rewrites the block in `motion.css` after a retune.
- Without `linear()` each spring uses the DESIGN.md fallback curve with its duration token (press → squish curve over
  180 ms; squish and inflate → squish curve over 240 ms; settle → settle curve over 320 ms; sheet → over 280 ms).
- Two more token objects are exported: `press` (pressed scale and sink per `data-press` kind: `clay` .97 and 1px,
  `soft` .98, `icon` .94) and `haptics` (the `navigator.vibrate` pattern per `haptic()` kind: `tap` 8 ms, `select`
  12 ms, `success`, `warning`, `error`).
- Earlier names still work and point at the design token they now equal (marked `@deprecated`): springs
  `snappy`→press, `gentle`→inflate, `bouncy`→squish, `fly`→settle; durations `instant`→press, `quick`→exit
  (`slow` 480 is unused); curves `out`/`emphasized`→settle, `in`→exit, `inOut`→water.

```ts
import { springTiming, durations, easings, travel } from "~/motion";
element.animate([{ scale: 0.86 }, { scale: 1 }], springTiming("inflate"));   // a spring as WAAPI timing
import { springKeyframes, springValue, springVelocity } from "~/motion/spring"; // the solver: not in the core bundle
const { values, duration } = springKeyframes(springs.sheet, { from: y, to: 0, velocity });  // px, px/s
```

## 3. Public API

### Environment and tiers

```ts
getMotionTier(): "full" | "lite" | "reduced"      useMotionTier()      useReducedMotion()
setMotionOverride("full" | "lite" | "reduced" | null)     getMotionOverride()
haptic("tap" | "select" | "success" | "warning" | "error")      MOTION_TIER_SCRIPT
```

| Tier | Chosen when | What changes |
|---|---|---|
| `full` | default | everything |
| `lite` (`fx-low`) | Save-Data; `deviceMemory` ≤ 2; ≤ 4 cores on a phone (shorter screen side < 768px) where `deviceMemory` exists; **three frames over 50 ms inside one page transition** (sticky for the session) | DESIGN.md §6.5: glass becomes solid (design-system CSS), staggered inflate is off, theme and language switch instantly, idle motion is off. Page transitions, press, flight and sheets are unchanged. |
| `reduced` | `prefers-reduced-motion` | DESIGN.md §7.3: pressed offset with no animation, content and numbers appear in place, page changes are a 120 ms cross-fade, no flight, sheets fade 120 ms (drag still works), theme and language instant, no idle motion |

- Deviation from DESIGN.md's literal rule: the core count only counts where `deviceMemory` exists (Chromium). WebKit
  reports 4 cores for every device with fewer than 8 (all iPhones, `NavigatorBase.cpp`), so "≤ 4 cores on a small
  screen" would put every iPhone on the low-end tier. Verified both ways in `check-system.mjs`.
- The shopper's override (localStorage `tt:motion`, shown in the lab) wins over every signal in both directions.
- `haptic()` is `navigator.vibrate` where it exists (Android), silent elsewhere, and only after the first tap.
  DESIGN.md: a light haptic (`data-haptic="tap"`, 8 ms) on the commit key only.

### Press feedback — automatic

```tsx
<button data-press="clay" data-haptic="tap">أضف إلى السلة</button>   {/* 3 % and 1px down, `press` spring back */}
<a data-press="soft">…</a>                                           {/* 2 % */}
<button data-press="icon" aria-label="…">…</button>                   {/* 6 % */}
```

`<MotionRoot>` sets `data-pressed` inside `pointerdown` (and on Space/Enter), swaps it for `data-released` on release,
and cancels when the pointer leaves the element or the gesture becomes a scroll. Press-in is 80 ms ease-out; the return
is the `press` spring (260 ms, 8 % overshoot). The design system's keys (`app/styles/materials.css`) carry
`data-press="clay"`, zero the element's own movement and move only their cap on `[data-pressed]` (DESIGN.md §6.1: the
wall never moves). Reduced motion: the pressed offset is shown without animation.

### Navigation grammar

While a page transition runs, `<html>` carries `data-nav` and `data-nav-dir="forward|back"`:

| `data-nav` | Use | Motion (full and lite) |
|---|---|---|
| `zoom` | card → detail | the card's shared element grows into place on the `settle` spring (410 ms, no overshoot); the list lets go (140 ms, exit) and the page settles in behind from .94 at the tap point. Back runs the same path into the same card |
| `push-forward` / `push-back` | siblings: tabs, steps, neighbouring hubs | "next" enters 24px from the inline-end side and fades in (`settle`); the old view slides 24px the other way and fades (140 ms, exit). RTL mirrors LTR (`--motion-dir`) |
| `rise` | sheet-like child page | rises 48px on the `sheet` spring over the fading parent; Back drops it away |
| `fade` | unrelated pages (default) | old fades out (140 ms), new settles in from 8px below |
| `direction` | language switch (full tier only) | content drifts 16px toward the new reading direction's start: out 140 ms, in 220 ms; chrome cross-fades in place; anchors stay |

Reduced motion: every navigation except the language switch is a 120 ms cross-fade (opacity only, no shared element).

How a navigation gets its transition, in priority order:

1. **Back/Forward** play the reverse (or replay) of whatever brought the shopper to that history entry (remembered per
   entry in sessionStorage, with the tap point and the shared element).
2. **An explicit request**: `<MotionLink nav="zoom" to=…>` (a `LocaleLink`), `<MotionLink nav="push" order={2}>`,
   `<MotionLink nav="zoom" back>` for an in-page "back" link, or `useNavIntent()("rise")` before `navigate()` / a form.
3. **Sibling order from route handles** — direction is automatic and right on a deep link:
   ```ts
   export const handle = { nav: "push", order: 2 } satisfies MotionHandle;
   export const handle = { nav: "push", order: ({ params }) => STEPS.indexOf(params.step!) } satisfies MotionHandle;
   export const handle = { nav: "push", order: ({ search }) => tabIndex(search) } satisfies MotionHandle;   // ?tab= tabs
   ```
   Routes are siblings when they share a parent route (or the same `group`).
4. `handle = { nav: "rise" }` on the destination, else `fade`.

A change of only the query string or hash on the same page gets **no** page transition unless something above asks for
one — filters, sorting and pagination stay instant.

### `<SharedElement>` — card → page morph

```tsx
<MotionLink nav="zoom" to={`/p/${slug}`}>                <SharedElement name={`product-image:${id}`} target>
  <SharedElement name={`product-image:${id}`}>             <Art name={art} priority … />
    <Art name={art} … />                                 </SharedElement>
  </SharedElement>
</MotionLink>
```

- One wrapper (`as`, default `div`) morphs. Same aspect ratio on both sides is ideal; otherwise the snapshots are
  fitted (`fit="contain"` default, or `"cover"`), never stretched. Niche and render may be two names.
- A card carries the name only while it is the one that was pressed (or the one Back returns to); the detail side sets
  `target`. If one page can show the same name twice, give the elements different `slot`s.
- No View Transitions in the browser: the destination FLIPs from the card's box (one scale, `settle` spring) while the
  page fades in over 120 ms; Back FLIPs the card from the detail picture's box. Reduced motion: nothing.
- **Images inside need an `onLoad` handler (any) or `loading="lazy"`**, otherwise React holds the navigation until the
  image has loaded (§4.6).

### `<Bubble>` / `<BubbleGroup>` — content that arrives (DESIGN.md "inflate")

```tsx
<Suspense fallback={<div className="grid">{placeholders}</div>}>      {/* same geometry as the content */}
  <Await resolve={products}>
    {(items) => (
      <BubbleGroup stagger className="grid">
        {items.map((p) => <Bubble key={p.id} className="card-size"><ProductCard product={p} /></Bubble>)}
      </BubbleGroup>
    )}
  </Await>
</Suspense>
```

- Scale .86 → 1 with opacity 0 → 1 on the `inflate` spring, on the wrapper itself (zero layout shift, measured).
- First appearance only: content that arrives after the page is on screen. Server HTML and content that is part of a
  navigation is simply there; `always` opts in. `origin={{ x, y }}` or `"pointer"` grows it from a tap.
- Hydration-safe: a Bubble that hydrates server HTML never inflates — also inside a streamed Suspense section that
  hydrates after `<MotionRoot>` went live (it used to add `tt-bubble-in` there: a hydration mismatch). The decision is
  `inflateOnMount({ hydrating, live, always, inNavigation })`; `hydrating` comes from `useHydrating()` (exported from
  `~/motion`: `useSyncExternalStore` returns its server snapshot while React hydrates, then turns false). Read it once,
  at mount. Live check: `/design-system#reveal` streams a shelf — a full load hydrates it with no warning, a client
  navigation to the page inflates it.
- `<BubbleGroup stagger>`: 45 ms apart, at most six staggered, the rest appear with the sixth (`stagger={ms}` for a
  custom step, the wave capped at 400 ms). Items added later are not delayed. Re-key the group to replay.
- A failed load is not a bubble: show the empty reserved space with a message and a retry key. Lite and reduced: in place.

### `<NumberMorph value format />` (DESIGN.md "Currency number morph")

Digits roll per column (160 ms, water curve) in fixed cells; equal digit counts never change the width (measured).
Text around the digits (the currency label) is never animated — visible in every frame, it swaps. Assistive technology
gets the final text immediately. Reduced motion: the number replaces the number.

### `flyToCart(source, options?) → FlyHandle` (DESIGN.md "Fly to cart")

```tsx
const add = () => {
  setCount((n) => n + 1); announce();                           // 1. state, count and aria-live first
  const flight = flyToCart(imageRef.current!);                  // 2. returns immediately
  fetcher.submit(form, { method: "post", action: "/api/cart" });
  // on failure: roll the count back, show the message with a retry key, and
  flight.revert();                                              //    the bead returns along the same arc
};
```

- A 22px red clay bead (`.fly`) leaves the centre of `source` and travels a quadratic arc — control point halfway
  across, 70px above the higher end — to the cart bead (`[data-cart-badge]` in the first visible `[data-cart-target]`),
  shrinking to .55, in 420 ms + 0.3 ms per px (≤ 600 ms). One transform animation.
- On arrival the cart bead squishes: scale(1.4, .68) → (.88, 1.16) → 1 over 340 ms; a bubbling `tt:cart-received`
  event (`detail.flown`) fires on the target; `options.onArrive` runs.
- At most three beads in flight; further taps go straight to the count (the bead still squishes).
- `revert()`: mid-flight the bead turns round; after landing a bead flies the same arc back. The cart is not told.
- `options.image` (URL, element, or `true` for the source's own picture) flies a copy of the picture instead of the bead.
- Reduced motion, no target, or the chunk not loaded yet: no flight, the event fires straight away.

### Sheets, menus, toasts

```tsx
function CartSheet({ onClose }: { onClose: () => void }) {
  const sheet = useSheet({ snapPoints: [0.5, 1], initialSnap: 0, onClose });   // edge: "auto" by default
  return (
    <>
      <div ref={sheet.backdropRef} className="scrim" onClick={sheet.close} />
      <section ref={sheet.ref} className="tt-sheet …" role="dialog" aria-modal="true" aria-label="…" tabIndex={-1}>
        <div {...sheet.handleProps}><span className="grabber" /></div>
        <div className="content">…</div>
      </section>
    </>
  );
}
{open && <CartSheet onClose={() => setOpen(false)} />}
```

- Mount when it opens; it rises on the `sheet` spring to `initialSnap`. `edge: "auto"` (default) is the bottom edge
  below 768px and the inline-end edge from 768px (a side sheet has one resting point: fully open). `sheet.edge` says
  which; `data-sheet-edge` is set on the element for styling.
- The handle drags 1:1 from where it was grabbed (pointer capture); on release the finger's momentum is projected to
  choose the snap point and the spring starts with that velocity; past the most open point it rubber-bands; grabbed
  mid-flight it continues from its exact position. Past the lowest point, Escape, or `close()`: away, then `onClose`.
- Focus (unless `manageFocus: false`): moves into the sheet (its `[autofocus]` element, else the sheet), Tab and
  Shift+Tab stay inside, Escape closes, focus returns to the opener. Only the top sheet answers keys.
- The scrim's opacity follows how open the sheet is (its colour is the component's: `--scrim`).
- Reduced motion: it appears and disappears with a 120 ms fade; drag still works.

```ts
await materialize(menuElement, { from: triggerElement });   // after it is in the DOM: drops 8px from the trigger, fades in (220 ms)
await dematerialize(menuElement); setOpen(false);           // leaves the way it came (140 ms, exit curve), then unmount
```

### Theme and language

```tsx
<button onClick={() => themeMorph("dark")}>داكن</button>

const switchLanguage = useDirectionMorph();
<button onClick={() => switchLanguage("en")}>English</button>
// low level: directionMorph(() => navigate(path, { replace: true, preventScrollReset: true }))
```

- `themeMorph` (DESIGN.md: "the light changes, not the objects") updates the prefs store and `<html data-theme>` inside
  a view transition the engine owns: the two snapshots cross-fade over 200 ms (water curve); nothing moves and nothing
  repaints per frame; fixed chrome fades with the page. Instant at the lite tier, under reduced motion and without
  View Transitions. **Measured:** text contrast passes through ≈ 2:1 about 70 ms in and is under 3:1 for ≈ 30 ms
  (two frames) — a cross-fade between dark-on-light and light-on-dark always crosses equal luminance, so DESIGN.md's
  "legible in every frame" holds everywhere except those frames. (The engine's earlier circular reveal kept every
  pixel fully one theme; the design team chose the cross-fade.)
- `useDirectionMorph` navigates to the same page in the other language with `replace` (Back leaves the page) and
  `preventScrollReset`; the route stays mounted, so form state survives. The first `data-motion-anchor` on screen keeps
  its place: once the new text has rendered, the page is scrolled by however much the text above moved it (every tier),
  so what the shopper was looking at stays put. Instant at lite and reduced.

### Rails and idle motion

```tsx
const rail = useRail({ tilt: true });
<div {...rail.props} aria-label={t("trending")}>{cards}</div>
<button onClick={() => rail.step(true)} aria-label={t("next")}>…</button>

const breathe = useAmbient<HTMLDivElement>();
<div ref={breathe} data-ambient="" className="stage__pool" />    // your CSS: animation: breathe 5s … infinite alternate
```

- Rails: native scroll-snap with the platform's own momentum and rubber band, no scroll listener; vertical gestures and
  the vertical wheel are never captured. Adds ← → (mirrored in RTL), Page Up/Down, Home/End and a small rubber bump for
  mouse, keyboard and the step buttons. `tilt` leans items crossing an edge with scroll-driven animations, at `full`
  only, only where the browser's timeline is right (§4.9).
- Idle motion (DESIGN.md: nothing moves at rest, one optional exception): runs only at `full` (so never with Save-Data
  or on the low-end tier), on screen, in a visible tab, and only from 2 s after load. Browsers do not expose battery
  saver; the engine pauses idle motion at ≤ 20 % battery when not charging, where `navigator.getBattery` exists.

### Stage relight and the intro

The stage relight (DESIGN.md §7.2) is implemented by the design system's stage CSS (`materials.css`:
`.render[data-enter]`, `.stage__layer[data-entering|data-leaving]`, off at `fx-low` and reduced). The intro belongs to
the home area; both use these tokens and the tiers above.

### Types

Exported from `~/motion` next to the pieces above: tokens `Spring`, `SpringName`, `DurationName`, `EasingName`,
`PressKind`, `HapticKind`, `SpringTiming`; environment `MotionTier`; navigation `MotionHandle`, `MotionLinkProps`,
`PageTransitionProps`, `NavKind`, `NavName`; content `SharedElementProps`, `BubbleProps`, `BubbleGroupProps` (and the
hook `useHydrating`),
`NumberMorphProps`; imperative `FlyHandle`, `FlyOptions`, `CartReceivedDetail` (the `tt:cart-received` event's
`detail`), `MaterializeOptions`, `MorphOrigin`; sheets and rails `SheetHandle`, `SheetOptions`, `SheetEdge`,
`RailHandle`, `RailOptions`.

## 4. What React 19.3.1 and React Router 8.5.1 actually do

Chromium 157 (headless Edge), development server. "Verified" items are asserted by the checks in §6 on every run
(2026-11-11); the others were measured while the engine was built and are the reasons for its design.

**4.1 One view transition per navigation.** React Router wraps every router update in `startTransition`, and React
pre-names every `<ViewTransition>` whose `update` is not `"none"` when anything near it re-renders, so the documented
`<ViewTransition><Outlet/></ViewTransition>` cross-faded the page after hydration and on every `navigation.state`
change, and held the real commit until that animation ended (measured +380 ms while building). **Design:**
`<PageTransition>` puts a 1px sentinel in a *keyed* `<ViewTransition update="none">`; the key changes only when a
navigation should animate. The animated layers are the two viewport-sized **root** snapshots (no scroll compensation,
correct stacking under fixed chrome); `view-transition-name: root` is set inline on `<html>` for the commit because
React otherwise hides the root layer (a React implementation detail — if it changes, `check-nav.mjs` fails).
Verified: no view transition on load or hydration; exactly one per navigation.

**4.2 Back and Forward.** Verified: Back and Forward keep URL, `history.length` and scroll (the list returns to
260px), play the reverse/replay of the remembered transition, and morph into the same card.
- A Back that needs data (routes with loaders) is an ordinary transition: React starts it after `popstate`, once the
  loader has answered (measured 32 ms after `popstate`).
- A Back that needs no data (hash to hash, or no loaders) is finished by React Router *inside* `popstate`, and React
  19.3 renders a transition scheduled during `popstate` synchronously (`shouldAttemptEagerTransition` in
  `react-dom-client`, so the browser can restore scroll). A synchronous commit cannot be a view transition: the page
  would just swap. **Fallback:** `<PageTransition>` notices it is rendering inside `popstate` (`window.event`) for a
  navigation that should animate and suspends for one macrotask; React finishes the same transition asynchronously,
  with the view transition. Verified: one push-back transition, DOM updated 18 ms after `popstate`; history untouched
  (React Router has already moved the URL) and scroll restored by React Router's own layout effect.

**4.3 Interruption.** While a view transition animates, the captured page is not hit-testable (`elementFromPoint`
returns `<html>`) and React parks later transition commits until it ends. `<MotionRoot>` ends the running transition on
any `pointerdown`, key press, wheel or `popstate`; a touch tap then lands by itself, a mouse click is forwarded to the
element under the pointer. A transition that is still preparing is never skipped (React reports "A ViewTransition was
aborted early"). Verified for touch and mouse, with and without `document.activeViewTransition`.

**4.4 Content is not held back.** React waits for a running view transition before committing a Suspense reveal; it
waits by reading `.finished`, so the engine plays the rest of the animation 4× faster when that happens
(`tokens.page.hurry`). Verified at 5 % animation speed: data ready after 0.9 s was shown at 2.26 s instead of 8.03 s.

**4.5 Why Bubbles are CSS, not `<ViewTransition>`.** A Suspense reveal driven by a view transition is document-level:
it queues behind a page transition, blocks later commits and makes part of the page untouchable. A mount-time CSS
animation has none of these problems and works before hydration finishes.

**4.6 Images inside a `<ViewTransition>` can delay navigation** (measured while building). React suspends the commit for
unloaded `<img>` inside a boundary: tap → commit took 950 ms with a slow image in a shared element versus 160–260 ms with
an `onLoad` prop (or `loading="lazy"`). Page content is not inside a boundary in this design; only `<SharedElement>`
children are affected.

**4.7 Effects run late during a transition** (measured while building). `useEffect` of the new page ran when the view
transition had finished (≈ 350 ms after the commit); layout effects run inside it. Do not start prompt work in
`useEffect` after navigation — use loaders and layout effects.

**4.8 Reports that are not app bugs** (observed while building). A viewport resize while a transition prepares
(soft keyboard, rotation) makes Chromium abort with "Viewport size changed", which React 19.3.1 reports as an uncaught
error (harmless; filter it in error reporting). In development React tracks `<ViewTransition name>` by the name a
boundary mounted with, so `<SharedElement>` remounts its boundary instead of renaming it.

**4.9 Scroll-driven tilt in RTL.** Chromium computes horizontal `view()` timelines wrongly in RTL scrollers. The rail
probes once per direction and enables the tilt only where an item fully inside comes out flat. Verified: RTL rails are
flat, LTR rails tilt only the item crossing an edge.

**4.10 Theme changes are synchronous.** The prefs store uses `useSyncExternalStore`, whose updates cannot be
transitions, so `themeMorph` runs its own view transition (ending a page transition first).

**4.11 Browsers.** Verified by removing the APIs in Chromium: without View Transitions, navigation is instant, the page
fades in over 120 ms and shared elements FLIP; the theme and language switch instantly. Without
`document.activeViewTransition`, React's `<ViewTransition>` callbacks and `:active-view-transition` take over.

## 5. Performance (measured)

- **Bundle** — Vite 8 production build (Rolldown, Oxc, Lightning CSS), gzip -9, `node app/motion/__checks__/size.mjs`:

  | | always loaded JS | always loaded CSS | on demand JS + CSS |
  |---|---|---|---|
  | a layout (`MotionRoot`, `PageTransition`, `MotionLink`) | 5.8 KB | 3.2 KB | 5.2 KB + 0.6 KB |
  | every export at once (worst case) | 9.8 KB | 3.2 KB | 5.1 KB + 0.6 KB |

  Plus Vite's dynamic-import helper (≈ 1.3 KB), which the app ships once for every route. The on-demand chunk (fly,
  sheet physics, menus, theme cross-fade, rail behaviour) is fetched at idle by `<MotionRoot>`; if it has not arrived
  when needed, the call does its instant part (state, event, theme) without the animation.
- **Press:** `data-pressed` is set inside `pointerdown`; the animation starts in the very next frame — 14–17 ms after the
  event and 19–33 ms after the touch timestamp at 60 fps (DESIGN.md budget: 80 ms).
- **Compositor only:** page transitions animate two viewport-sized snapshots; sheets settle with one WAAPI animation
  sampled from the closed-form spring (interrupting it needs no style read); a flight is one transform animation.
- **Listeners:** delegated, passive, on `document`; `pointermove` only while something is pressed. Nothing runs at rest;
  the jank watch is one `requestAnimationFrame` loop that lives only while a page transition animates.

## 6. Verifying

```
npm test -- tests/motion.test.ts                  41 tests: spring solver → linear(), hand-off, momentum, rubber band, snap,
                                                  arc and flight time, tiers + the head script (1,280 combinations), navigation
                                                  grammar, tokens ↔ motion.css ↔ app/styles/tokens.css, transform/opacity guard
node app/motion/__checks__/check-nav.mjs          40: URL / history / scroll on forward, Back, Forward; one transition per
                                                  navigation; grammar; shared elements; RTL vs LTR push; synchronous Back
node app/motion/__checks__/check-touch.mjs        32: press timing and depth, cancel, keyboard, haptics, number morph, menus,
                                                  interrupting a transition (touch and mouse)
node app/motion/__checks__/check-content.mjs      50: bubbles (zero layout shift, stagger), rails, idle motion, fly-to-cart (bead,
                                                  arc, squish, cap, failure return), sheet physics and focus, side sheets
node app/motion/__checks__/check-system.mjs       45: tiers and signals, reduced and lite, runtime jank downgrade, theme
                                                  cross-fade with contrast per frame, language switch with anchors
node app/motion/__checks__/check-fallbacks.mjs    12: no View Transitions (fade + FLIP); no document.activeViewTransition
node app/motion/__checks__/frames.mjs             stills from the middle of each animation → .shots/motion/
node app/motion/__checks__/contact.mjs out.png frames…    lays frames side by side to look at a whole transition
node app/motion/__checks__/size.mjs               bundle sizes (§5)
```

The browser checks drive the lab at 390×844 (and 1024×768 for side sheets) against the running dev server
(`MOTION_ORIGIN` to point elsewhere) and write frames to `.shots/motion/` — look at them when changing motion.

## 7. Rules for feature code

1. State first, motion second: update the cart, submit the form, navigate — then call the motion helper. Never `await`
   an animation before doing the real thing.
2. Use the pieces: `data-press` for anything tappable, `<MotionLink>`/handles for navigation, `<SharedElement>` for the
   one thing that travels, `<Bubble>` for content that arrives, `<NumberMorph>` for numbers that change, `useSheet` for
   sheets, `materialize` for menus. Custom motion uses the tokens and animates only `transform`/`opacity`.
3. Loaders await what the page needs to be meaningful; stream only what may arrive later, into reserved space.
4. Do not add `<ViewTransition>` boundaries with the default `update` behaviour (§4.1), and do not pass React Router's
   `viewTransition` props.
5. Every flow must be complete with `data-motion="reduced"` and `"lite"`: open `/motion`, switch the tier, try it.

## 8. Not done / limits

- Verified on Chromium 157 only (headless Edge). Safari and Firefox paths are exercised by removing APIs in Chromium,
  not on those browsers or on real phones; durations and springs should be tuned on devices, and the jank threshold
  (3 frames over 50 ms) has not been tried on a real low-end phone.
- The theme cross-fade dips below 3:1 text contrast for ≈ 30 ms (§3, measured); the design team's call.
- The language switch cross-fades two pages of text for ≈ 100 ms (DESIGN.md's 140 ms out / 220 ms in).
- Server-rendered Bubbles do not animate when a streamed Suspense boundary resolves before hydration (they are shown,
  and they hydrate without a mismatch — §`<Bubble>`).
- Rails are flat in RTL until the browser bug in §4.9 is fixed.
