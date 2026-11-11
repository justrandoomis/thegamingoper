# TamTam Motion Engine

Motion in TamTam should feel like water, bubbles and elastic clay — and it must never make an interaction slower.
Everything lives in `app/motion`, is imported from `~/motion`, and can be seen running at **`/motion`** (the lab; every
piece on neutral surfaces, in `ar`, `en` and `ckb`).

- No animation library: CSS, the Web Animations API and React 19.3 `<ViewTransition>`.
- Only **transform and opacity** are animated (a test fails if a `@keyframes` block in the engine touches anything else).
- Feedback starts in the frame after pointer-down. Navigation, data and state changes never wait for an animation.
- Everything is interruptible: any touch, key press or wheel ends a running page transition at once.
- `prefers-reduced-motion` (or the shopper's own setting) replaces movement with short opacity changes or nothing; every flow still works.
- One place to retune: `app/motion/tokens.ts`.

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

- `<MotionRoot />` renders nothing. It installs a few passive, delegated document listeners, keeps
  `<html data-motion="full|lite|reduced">` up to date and imports `motion.css`.
- `<PageTransition>` wraps the outlet in a plain `<div data-motion-page>` (pass `className`/`style` if the layout needs
  it). Keep it mounted; do not key it. Nested layouts may each have one — a navigation is planned once.
- Chrome that stays put during page transitions: `data-motion-persist="header" | "nav" | "bar" | "float"` (one element
  per value on screen). Without it the chrome simply moves with the page.
- The cart button: `data-cart-target` on the button, `data-cart-badge` on its count bubble (see `flyToCart`).

## 2. Tokens

`app/motion/tokens.ts` is the source; `motion.css` carries the same values as custom properties
(`npx tsx app/motion/__checks__/gen-css.mjs` regenerates the block, and `tests/motion.test.ts` fails if they drift).

| Token | Value | Use |
|---|---|---|
| `--motion-duration-instant` | 80 ms | press-in, things that must feel immediate |
| `--motion-duration-quick` | 140 ms | micro-interactions, fades |
| `--motion-duration-base` | 220 ms | default |
| `--motion-duration-page` | 320 ms | page transitions, shared elements (upper bound) |
| `--motion-duration-slow` | 480 ms | theme reveal, cart squish |
| `--motion-ease-out` / `-in` / `-in-out` / `-emphasized` | cubic-béziers | entering / leaving / moving / page-sized movement |
| `--motion-spring-snappy` (+ `-duration` 208 ms) | response 0.22, damping 0.9 | controls, small state changes |
| `--motion-spring-gentle` (408 ms) | 0.34 / 0.72 | things that arrive: bubbles, shared elements, menus (a whisper of overshoot) |
| `--motion-spring-bouncy` (733 ms) | 0.40 / 0.55 | **momentum only** — a flick or a throw, never a plain state change |
| `--motion-spring-sheet` (442 ms) | 0.34 / 0.82 | sheets settling after a drag |
| `--motion-spring-fly` (567 ms) | 0.42 / 1.0 | fly-to-cart travel |

Springs are `{ response, dampingRatio }`. Each becomes a CSS `linear()` easing plus the duration it needs (browsers
without `linear()` get a plain ease-out of the same length).

```css
.chip { animation: chip-in var(--motion-spring-gentle-duration) var(--motion-spring-gentle) both; }
```

```ts
import { durations, springTiming, springs } from "~/motion";
element.animate([{ scale: 0.9 }, { scale: 1 }], springTiming("gentle"));      // same token, as WAAPI timing

// Gesture hand-off (a spring that starts with the finger's velocity): the solver is a separate import so it stays
// out of the always-loaded bundle.
import { springKeyframes, springValue, springVelocity } from "~/motion/spring";
const { values, duration } = springKeyframes(springs.sheet, { from: y, to: 0, velocity });   // px, px/s
```

## 3. Public API

### Environment

```ts
getMotionTier(): "full" | "lite" | "reduced"      useMotionTier()      useReducedMotion()
setMotionOverride("full" | "lite" | "reduced" | null)     getMotionOverride()
haptic("tap" | "select" | "success" | "warning" | "error")
```

| Tier | Chosen when | What changes |
|---|---|---|
| `full` | default | everything |
| `lite` | Save-Data, `deviceMemory` ≤ 2 GB, ≤ 2 cores, or ≤ 4 GB with ≤ 4 cores | no stagger or overshoot on bubbles, no parallax layer under a page push, no depth tilt, no cart squish, no ambient motion; theme uses the sweep |
| `reduced` | `prefers-reduced-motion` | no view transitions (pages cut), press is an opacity change, bubbles and numbers are 80–120 ms fades, no flight, sheets are placed, theme and language switch instantly |

The shopper's override (stored in `localStorage`, applied immediately, shown on the accessibility page) wins over every
signal in both directions. The server always renders `full`; CSS honours the OS setting before hydration.
`haptic()` is `navigator.vibrate` where it exists (Android) and silently nothing elsewhere.

### Press feedback — automatic

```tsx
<button data-press="clay" data-haptic="tap">أضف إلى السلة</button>   {/* 3 % compression + 1px sink, spring return */}
<a data-press="soft">…</a>                                           {/* 2 % */}
<button data-press="icon" aria-label="…">…</button>                   {/* 6 % */}
```

`<MotionRoot>` sets `data-pressed` inside the `pointerdown` event (and on Space/Enter), swaps it for `data-released` on
release, and cancels when the pointer leaves the element or the gesture turns into a scroll. The motion is CSS keyframes
on `scale`/`translate` — deliberately not transitions, so a component's own `transition` list cannot break it, and
`transform` stays free. Style extra pressed looks with `[data-pressed]`.

### Navigation grammar

While a page transition runs, `<html>` carries `data-nav` and `data-nav-dir="forward|back"`:

| `data-nav` | Meaning | Motion |
|---|---|---|
| `fade` | default between unrelated pages | old page lets go (100 ms), new one settles in from 10px (fade-through) |
| `zoom` | card → detail | the world zooms toward the tap point; the shared element morphs on top. Back: zooms out |
| `push-forward` / `push-back` | neighbouring contexts | new page slides over from the inline end (from the **left** in RTL); back uncovers |
| `rise` | sheet-like child page | lifts over a receding parent; back drops away |
| `direction` | language switch | out toward the old reading direction's end, in from the new start |

How a navigation gets its transition, in priority order:

1. **Back/Forward** play the reverse (or replay) of whatever brought the shopper to that history entry. The engine
   remembers it per entry (sessionStorage), together with the tap point and the shared element.
2. **An explicit request** on the link or before a programmatic navigation:
   ```tsx
   <MotionLink nav="zoom" to={`/p/${slug}`}>…</MotionLink>        // LocaleLink + intent (prefetches on intent as usual)
   <MotionLink nav="push" order={2} to="/account/orders">…</MotionLink>
   <MotionLink nav="zoom" back to="/c/consoles">رجوع</MotionLink>  // an in-page "back" that pushes a new entry

   const intent = useNavIntent();
   intent("rise"); navigate("/cart");                               // or before a <Form> submit
   ```
3. **Sibling order from route handles** — no link props needed, direction is automatic (and correct on a deep link):
   ```ts
   export const handle = { nav: "push", order: 2 } satisfies MotionHandle;
   export const handle = { nav: "push", order: ({ params }) => STEPS.indexOf(params.step!) } satisfies MotionHandle;
   export const handle = { nav: "push", order: ({ search }) => tabIndex(search) } satisfies MotionHandle;   // ?tab= tabs
   ```
   Routes are siblings when they share a parent route (or the same `group`).
4. `handle = { nav: "rise" }` on the destination, else `fade`.

A change of only the query string or hash on the same page gets **no** page transition unless something above asks
for one — filters, sorting and pagination stay instant.

### `<SharedElement>` — card → page morph

```tsx
// card                                                   // product page
<MotionLink nav="zoom" to={`/p/${slug}`}>                <SharedElement name={`product-image:${id}`} target>
  <SharedElement name={`product-image:${id}`}>             <Art name={art} priority … />
    <Art name={art} … />                                 </SharedElement>
  </SharedElement>
</MotionLink>
```

- It renders one wrapper (`as`, default `div`; pass `className`/`style`) and that box is what morphs.
  Same aspect ratio on both sides is ideal; otherwise the snapshots are fitted (`fit="contain"` default, or `"cover"`),
  never stretched.
- A card carries the name only while it is the one that was pressed (or the one Back returns to); the detail side sets
  `target`. So the same product may appear in several rails. If one page can show the same name twice, give the
  elements different `slot`s so Back returns into the right one.
- No partner, partner off-screen, reduced motion, or no browser support → nothing happens, the page transition still plays.
- **Images inside must have an `onLoad` handler (any) or `loading="lazy"`.** Otherwise React holds the navigation until
  the image has loaded (see §4.6).
- Changing `name` on a mounted element remounts its children (it now stands for another thing).

### `<Bubble>` / `<BubbleGroup>` — content that arrives

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

- Scale .92 → 1 (soft overshoot) + opacity on the wrapper itself. Reserve the geometry with your own classes on the
  wrapper and on the fallback; the lab measures zero layout shift.
- Plays for content that appears **after** the page is on screen: Suspense reveals, arriving results, inserted items.
  Content that is in the server HTML or part of a navigation is simply there (the page transition is that animation);
  `always` opts in.
- `origin={{ x, y }}` or `origin="pointer"` grows it from a tap point.
- `<BubbleGroup stagger>` (or `stagger={ms}`) delays direct children one after another; the whole wave is capped at
  400 ms. Items added later are not delayed. Re-key the group (`key={query}`) to play the wave again.
  Bubbles that are not direct children take `index`.
- Bubbles are CSS animations on purpose — see §4.5.

### `<NumberMorph value format />`

```tsx
const f = useFormat();
<NumberMorph value={priceIqd} format={f.money} />      // also morphs when the display currency changes
<NumberMorph value={cart.count} format={f.number} />
```

Digits roll (up when the value grows, down when it shrinks) in 220 ms; text around them cross-fades. Assistive
technology gets the final text immediately; the animated glyphs are `aria-hidden`. Digits sit in a left-to-right
island so Arabic currency text keeps its shaping and order. Western digits get a fixed `1ch` box (heavy fonts ignore
`tabular-nums` — measured with Segoe UI Black), so equal digit counts never change the width.

### `flyToCart(source, options?)`

```tsx
const add = () => {
  fetcher.submit(form, { method: "post", action: "/api/cart" });   // 1. real state first
  flyToCart(imageRef.current!);                                     // 2. returns immediately
};
```

A copy of the picture (`options.image`: URL or element, default: the source's own `img/svg/canvas`) shrinks to a puck
and travels a quadratic Bézier arc to the first visible `[data-cart-target]` (`options.target` overrides). On arrival
the target squishes, `[data-cart-badge]` bumps, and a bubbling `tt:cart-received` event (`detail.flown`) fires on it;
`options.onArrive` runs too. At most four flights at once — further taps are acknowledged instantly. Reduced motion,
no target, or the chunk not loaded yet: no flight, the event fires straight away.

### Sheets, menus, toasts

```tsx
function CartSheet({ onClose }: { onClose: () => void }) {
  const sheet = useSheet({ snapPoints: [0.5, 1], initialSnap: 0, onClose });
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

Mount the sheet when it opens; it springs up to `initialSnap`. Dragging the handle moves it 1:1 from where it was
grabbed (pointer capture); on release the finger's momentum is projected to choose the snap point and the spring starts
with that velocity; past the most open point it rubber-bands; grabbing it mid-flight continues from its exact position.
Below the lowest snap point (or `sheet.close()`) it springs down, then `onClose` runs. `sheet.snapTo(i)` moves it.
Only the handle drags, so content scrolls natively. Focus management and Escape belong to the sheet component (the lab's
`DemoSheet` shows the pattern).

```ts
await materialize(menuElement, { from: triggerElement });   // after it is in the DOM: grows from the trigger
await dematerialize(menuElement); setOpen(false);           // shrinks away, then unmount
```

### Theme and language

```tsx
<button onClick={(e) => themeMorph("dark", e.currentTarget)}>داكن</button>

const switchLanguage = useDirectionMorph();
<button onClick={() => switchLanguage("en")}>English</button>
// low level: directionMorph(() => navigate(path, { replace: true, preventScrollReset: true }))
```

`themeMorph` updates the prefs store and `<html data-theme>` inside a reveal that grows from the control (a light sweep
without an origin or at `lite`). It is transform-only: the new theme is its own layer whose clip box scales (or slides)
while the picture inside counter-moves, so it stands still. Every pixel is fully one theme, so text is legible in every
frame. Nothing navigates or remounts; scroll and state are untouched. `useDirectionMorph` navigates to the same page in
the other language with scroll position and form state kept and the history entry replaced.

### Rails and ambient motion

```tsx
const rail = useRail({ tilt: true });
<div {...rail.props} aria-label={t("trending")}>{cards}</div>
<button onClick={() => rail.step(true)} aria-label={t("next")}>…</button>
```

Native scroll-snap scrolling with the platform's own momentum; vertical gestures and the vertical wheel are never
captured. Adds ← → (mirrored in RTL), Page Up/Down, Home/End, and a small rubber bump at the edges for mouse, keyboard
and the step buttons (touch platforms keep their own overscroll effect). `tilt` leans items as they cross an edge using
scroll-driven animations — only at `full`, only where the browser's timeline is correct (§4.9).

```tsx
const float = useAmbient<HTMLDivElement>();
<div ref={float} data-ambient="" className="hero-bubble" />    // your CSS: animation: drift 9s … infinite
```

Ambient animations run only at `full`, on screen, in a visible tab, and not on a nearly empty battery.

## 4. What React and React Router actually do (measured)

React 19.3.1, React Router 8.5.1, Chromium 157, development server. These findings shaped the design; the check scripts
in §6 keep them true.

**4.1 A `<ViewTransition>` around the outlet is not usable as documented.**
React Router wraps *every* router state update in `startTransition`, and React pre-names every boundary whose
`update` class is not `"none"` whenever anything near it re-renders. With the documented
`<ViewTransition><Outlet/></ViewTransition>` we measured a full-page cross-fade right after hydration, another one for
the `navigation.state = "loading"` update of every click — and the real navigation commit then waited for that
animation to finish (+380 ms). The page group also slid vertically by the scroll difference between the two pages.
**Design:** `<PageTransition>` puts a 1px sentinel in a *keyed* `<ViewTransition update="none">`. The key changes only
when a navigation should animate, so React starts exactly one view transition per navigation and none otherwise
(fetchers, pending states, filters). The animated layers are the two viewport-sized **root** snapshots, which need no
scroll compensation and stack correctly under fixed chrome. React normally hides the root layer; setting
`view-transition-name: root` inline on `<html>` for the commit keeps it (a React 19.3 implementation detail — if it
changes, pages stop animating but shared elements still morph; `check-nav.mjs` fails).

**4.2 Back and Forward.** A Back that needs data (any route with a loader) completes outside the `popstate` event, so it
is an ordinary transition and animates (view transition started 43 ms after `popstate`). A Back that needs no data —
hash to hash, or routes without loaders — is finished by React Router *inside* `popstate`, React renders it
synchronously, and a synchronous commit cannot be a view transition: the page just swaps.
**Fallback:** `<PageTransition>` detects that it is being rendered inside `popstate` (`window.event`) for a navigation
that should animate and suspends for one macrotask; React then finishes the same transition asynchronously with the
view transition. Measured: DOM updated 47 ms after `popstate`, reverse transition played. History is untouched (React
Router has already moved the URL) and scroll is restored by React Router's own layout effect inside the transition:
the checks assert URL, `history.length` and `scrollY` after Back and Forward. Note that React Router treats
`/page#hash → /page` as a data navigation (loaders re-run).

**4.3 Interruption.** While a view transition is animating, the captured page is not hit-testable (`elementFromPoint`
returns `<html>`), and React parks every later transition commit until the animation ends. `<MotionRoot>` therefore
ends the running transition on any `pointerdown`, key press, wheel or `popstate`. A touch tap then lands by itself (the
click is hit-tested again on release); a mouse/pen click is dispatched to `<html>` and is forwarded to the element under
the pointer. The engine never skips a transition that is still preparing — React reports that as an error
("A ViewTransition was aborted early").

**4.4 Content is not held back.** A Suspense reveal that became ready 0.9 s into an (artificially 20× slowed) page
transition was shown only when the transition ended, 6.2 s later. React waits by reading `.finished` on the running
transition; the engine notices that read and plays the rest of the animation 4× faster (`tokens.page.hurry`) — same
case: shown at 1.85 s. At real speed the worst case is ≈ 80 ms. If React changes how it waits, behaviour falls back to
React's default hold (≤ 320 ms).

**4.5 Why Bubbles are CSS, not `<ViewTransition>`.** A Suspense reveal driven by a view transition is a document-level
transition: it queues behind a page transition, blocks later commits while it runs, and makes part of the page
untouchable. A mount-time CSS animation has none of these problems, works before hydration finishes and in every browser.

**4.6 Images inside a `<ViewTransition>` can delay navigation.** React suspends the commit for unloaded `<img>`
elements inside a boundary: tap → commit took 950 ms with a slow image inside a shared element versus 160–260 ms when the
`<img>` had an `onLoad` prop (or `loading="lazy"`). Page content is not inside a boundary in this design, so only
`<SharedElement>` children are affected.

**4.7 Effects run late during a transition.** `useEffect` callbacks of the new page ran when the view transition had
finished (≈ 350 ms after the commit), not right after it. Layout effects run inside the transition. Do not start data
fetching or focus changes that must be prompt in `useEffect` after navigation — use loaders and layout effects.

**4.8 Things React reports that are not bugs in the app.**
- If the viewport is resized while a view transition is preparing (soft keyboard, rotation), Chromium 157 aborts with
  "Transition was aborted because of invalid state. Viewport size changed"; React 19.3.1 only recognises the older
  wording and reports it as an uncaught error. Harmless (the navigation completes); worth filtering in error reporting.
- In development React tracks `<ViewTransition name>` by the name a boundary had when it mounted, so renaming a mounted
  boundary produces false "two components with the same name" errors. `<SharedElement>` remounts its boundary instead.

**4.9 Scroll-driven tilt in RTL.** Chromium 157 computes horizontal `view()` timelines wrongly in RTL scrollers (every
item stays in its "not yet entered" keyframe). The rail probes the browser once per writing direction on an invisible
element and enables the tilt only where an item that is fully inside comes out flat — so Arabic and Kurdish rails are
flat today and will tilt when the browser is fixed.

**4.10 Theme changes are synchronous.** The prefs store uses `useSyncExternalStore`, whose updates cannot be transitions,
so `themeMorph` owns its view transition directly (and ends any page transition first).

**4.11 Browsers.** No View Transitions API (older Safari/Firefox): navigation is instant and the new page fades in
(opacity only); shared elements and the theme reveal do nothing. Without `document.activeViewTransition` the engine uses
React's `<ViewTransition>` callbacks and `:active-view-transition` instead. Both paths are covered by `check-fallbacks.mjs`.

## 5. Performance notes

- **Bundle** (minified + gzip, a consumer using every export; `node app/motion/__checks__/size.mjs`):
  always loaded 8.5 KB JS + 3.0 KB CSS; on demand (fetched at idle by `<MotionRoot>`) 5.6 KB JS + 0.6 KB CSS for
  fly-to-cart, sheet physics, materialize, theme reveal and rail behaviour. If the on-demand chunk has not arrived when
  it is needed, the call does its instant part (state, event, theme) without the animation — an interaction never waits
  for code.
- **Press feedback:** `data-pressed` is set inside the `pointerdown` event and the animation starts in the very next
  frame: 15–17 ms after the event at 60 fps (17–35 ms after the touch timestamp). The default headless browser on the
  build machine renders at ~23 fps, where the same single frame is ~42 ms.
- **Compositor only:** page transitions animate two viewport-sized snapshots; sheets settle with one WAAPI animation
  sampled from the closed-form spring (interrupting it needs no style read); the flight is one keyframed transform.
  Shared-element groups use the browser's own size interpolation between the two boxes.
- **Listeners:** all delegated, passive, on `document`; `pointermove` is only listened to while something is pressed.
- **Idle:** nothing runs when nothing moves. The lab's FPS readout is the only `requestAnimationFrame` loop and exists
  only on `/motion`.
- **No layout animation:** no CSS transitions at all in the engine; `NumberMorph` takes a new width once, at the start.

## 6. Verifying

```
npm test -- tests/motion.test.ts                  34 tests: spring solver → linear(), hand-off continuity, momentum,
                                                  rubber band, snap choice, Bézier path, tier resolution, navigation
                                                  grammar, theme keyframes, tokens ↔ CSS, transform/opacity-only guard
node app/motion/__checks__/check-nav.mjs          URL / history length / scroll for forward, Back, Forward; one transition
                                                  per navigation; grammar; shared elements; RTL vs LTR; synchronous Back
node app/motion/__checks__/check-touch.mjs        press timing and depth, cancel, keyboard, haptics, number morph,
                                                  materialize, interrupting a transition (touch and mouse)
node app/motion/__checks__/check-content.mjs      bubbles (zero layout shift, stagger cap), rails, ambient, fly-to-cart,
                                                  sheet physics, content not held by a page animation
node app/motion/__checks__/check-system.mjs       tiers and signals, what reduced and lite change, theme reveal, language
node app/motion/__checks__/check-fallbacks.mjs    no View Transitions; no document.activeViewTransition
node app/motion/__checks__/frames.mjs             stills from the middle of each animation → .shots/motion/
node app/motion/__checks__/size.mjs               bundle sizes
```

The browser checks drive the lab at 390×844 against the running dev server (`MOTION_ORIGIN` to point elsewhere) and
write frames to `.shots/motion/` — look at them when changing motion.

## 7. Rules for feature code

1. State first, motion second: update the cart, submit the form, navigate — then call the motion helper. Never `await`
   an animation before doing the real thing.
2. Use the pieces: `data-press` for anything tappable, `<MotionLink>`/handles for navigation, `<SharedElement>` for the
   one thing that travels, `<Bubble>` for content that arrives, `<NumberMorph>` for numbers that change, `useSheet` for
   sheets. If something needs custom motion, use the tokens and animate only `transform`/`opacity`.
3. Loaders await what the page needs to be meaningful; stream only what may arrive later, and reveal it with Bubbles into
   reserved space. No grey skeletons, no layout shift.
4. Do not add `<ViewTransition>` boundaries with the default `update` behaviour (§4.1), and do not pass React Router's
   deprecated `viewTransition` props.
5. Every flow must be complete with `data-motion="reduced"`: open `/motion`, switch the tier, try it.

## 8. Not done / limits

- The engine is verified on Chromium 157 (headless Edge). Safari and Firefox paths are exercised only by removing APIs
  in Chromium, not on those browsers or on real phones; durations and springs should be tuned on devices.
- The production bundle sizes were measured with esbuild on the engine alone, not from a full `react-router build`.
- No runtime downgrade from measured frame times; the tier is decided from device signals and the override.
- Server-rendered Bubbles do not animate when a streamed Suspense boundary resolves before hydration (they are simply
  shown); after hydration every reveal animates.
- Rails are flat in RTL until the browser bug in §4.9 is fixed.
