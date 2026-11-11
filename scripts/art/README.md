# TamTam clay renders

Product and category pictures for the storefront: stylised 3D clay-toy models of real gaming
hardware, rendered ahead of time to transparent images. True proportions (millimetres from
`catalog.json`), simplified detail, generously rounded edges, soft matte clay with a gentle sheen,
dark glass screens with one soft diagonal reflection, one soft contact shadow, nothing else.
**No logos, wordmarks or trademarked symbols** — plain dots and shapes on buttons.

The set must look like one family, so the light rig, the materials and the camera live in one
place (`kit.mjs`) and a model file contains only shapes.

```
scripts/art/
  catalog.json        the art keys, their views and their real sizes (read-only)
  kit.mjs             scene kit: rig, materials, shape helpers, auto-framing stage
  render.html         the page that renders a model with the kit (opened headless by build.mjs)
  build.mjs           render → trim → AVIF / WebP / PNG variants → manifest
  models/<key>.mjs    one file per model
  .masters/           1600 px masters and contact sheets (git-ignored)
public/art/           the published image files (content-hashed names)
app/art/manifest/     one JSON per picture, read by <Art> (app/art/Art.tsx)
tests/art.test.ts     checks every manifest against the files on disk
```

## Commands

```
node scripts/art/build.mjs --only=switch-2,ps5-slim     render and publish these keys (all their views)
node scripts/art/build.mjs --only=switch-2 --draft      quick look: 800 px, 96 samples, nothing published
node scripts/art/build.mjs --only=switch-2 --views=hero one view only
node scripts/art/build.mjs                              every catalogue key that has a model
node scripts/art/build.mjs --list                       which keys have a model / a render
node scripts/art/build.mjs --serve                      serve render.html for a live look in your own browser
npm test -- tests/art.test.ts                           validate manifests and files
```

Other flags: `--samples=256` `--size=1600` `--no-sheet` `--gl=default|d3d11|gl|swiftshader`.

**While several people are modelling, always pass `--only=` with your own keys.** A build only
writes files of the keys it renders, so parallel builds do not collide.

After every build, **open the contact sheet** `scripts/art/.masters/<key>.sheet.png`: each view on
a light and a dark backdrop, plus the 240 px and 120 px sizes shoppers actually see. A full build
also writes `scripts/art/.masters/_family.png` — every finished hero picture side by side, the
check that a new model sits in the family.

## How a picture is made

1. `build.mjs` serves `scripts/art` and `node_modules/three` on a random local port and opens
   `render.html` in headless Chrome or Edge (found the way `scripts/shot.mjs` finds it; set
   `CHROME_PATH` to choose). WebGL: the plain headless launch is tried first — on this machine that
   gives the real GPU through ANGLE/D3D11 with no extra flags. If it fails, `--use-angle=d3d11`,
   then `--use-gl=angle`, then software (`--use-angle=swiftshader --enable-unsafe-swiftshader`,
   slower and with fewer samples) are tried. The log says which one was used.
2. The page imports `models/<key>.mjs`, calls `build(kit, options)` once and hands the object to
   the stage in `kit.mjs` for each view.
3. The stage stands the object on the floor, orbits the camera to the view, and averages many
   renders (256 by default). Each one moves the camera by a fraction of a pixel and takes one
   direction from each light of the rig: a large key from the upper left, an overhead sky, a floor
   bounce, a rim from behind. That average is what gives soft shadows, soft contact shading and
   clean edges. The floor is invisible; only its shadow is kept. A small probe render first measures
   the object, so the final frame is centred on it and filled to 84% (8% padding on each side).
4. Output is 1600 × 1600 RGBA with straight alpha. `build.mjs` keeps it as
   `.masters/<name>.png`, trims it to the object plus padding (the shadow lives in the padding;
   only a shadow larger than the padding widens the picture), and writes with sharp:
   - `public/art/<name>-<width>.<hash>.avif` and `.webp` at 240, 480, 720, 960, 1440 px — never
     wider than the trimmed master, so a tall, narrow picture has fewer of them
   - `public/art/<name>-720.<hash>.png` as fallback
   - `app/art/manifest/<name>.json`
   `<name>` is the key for the hero view and `<key>--<view>` for the others (`switch-2--front`);
   in the app the same picture is called `switch-2@front`.
5. `app/art/manifest/_expected.json` (rewritten from `catalog.json` on every non-draft build) lists
   the approximate shape of every picture in the catalogue, so `<Art>` can draw a placeholder of
   the right proportions for art that has no model yet.

The output is deterministic: the same model on the same machine gives byte-identical files and
therefore the same hashed names (a different GPU or driver may differ in the last bit).

Timings on the development machine (RTX 5070, Edge 157, measured while other builds were running):
about 2–4 s to render the first view of a key at full quality (most of it is building the
geometry and compiling shaders) and 0.6–1.4 s for each further view; 1–8 s to encode the 7–11
files of a picture, depending on how busy the machine is; 3–4 s to start the browser. The three
consoles (9 pictures) build in 25–60 s. A draft of one key takes about 8 s end to end. Software
rendering (`--gl=swiftshader`): about 10 s for one 800 px draft view at 48 samples.

### Manifest

```json
{
  "key": "switch-2", "view": "front",
  "width": 1556, "height": 803, "aspect": 1.9377,
  "variants": {
    "avif": [{ "w": 240, "src": "/art/switch-2--front-240.1a2b3c4d.avif" }, "…"],
    "webp": [{ "w": 240, "src": "/art/switch-2--front-240.5e6f7a8b.webp" }, "…"],
    "png": "/art/switch-2--front-720.9c0d1e2f.png"
  },
  "placeholder": "data:image/webp;base64,…",
  "dominant": "#2b2c2f"
}
```

`width` / `height` are the trimmed master (the intrinsic size for the `<img>`), `placeholder` is a
24 px WebP shown blurred until the file loads, `dominant` is the object's most common colour.
File names carry a hash of their content, so `/art/*` can be cached forever.

## Adding a model

1. Find the key in `catalog.json`. Read its `mm` (width × height × depth as the device normally
   stands), its `views` and its `notes` — the notes say which colours and details matter.
2. Create `scripts/art/models/<key>.mjs`. That is the whole registration: `build.mjs` finds models
   by file name. Do not edit `kit.mjs`, `build.mjs`, `render.html` or anyone else's model.
3. `node scripts/art/build.mjs --only=<key> --draft`, open `.masters/<key>.sheet.png`, compare with
   what the real hardware looks like, refine. Expect at least three rounds. Look at every view and
   at the 120 px thumbnail: the object must be recognisable there.
4. `node scripts/art/build.mjs --only=<key>` to publish, then `npm test -- tests/art.test.ts`.

```js
// scripts/art/models/example-console.mjs
/** example-console — 150 × 90 × 30 mm. Dark shell, one screen, two buttons. */

// Optional: change the camera for this object (defaults are in kit.VIEWS).
export const views = { hero: { azimuth: 28 } };

export function build(kit, options) {
  const { clay, glass, colors } = kit;
  const W = 150, H = 90, D = 30, F = D / 2; // F: the front surface
  const parts = [];
  const add = (geometry, material, at, rot) => parts.push(kit.mesh(geometry, material, { at, rot }));

  add(kit.slab(kit.rect(W, H, 14), D, { bevel: 4 }), clay(colors.black), [0, 0, 0]);
  add(kit.slab(kit.rect(96, 54, 3), 1.2, { bevel: 0.4 }), glass({ aspect: 96 / 54 }), [-14, 4, F - 0.25]);
  const button = kit.puck(5, 1.6, { bevel: 0.8, top: 0.3, axis: 'z' });
  add(button, clay(colors.coral), [52, 14, F - 0.25]);
  add(button, clay(colors.lightBlue), [52, -6, F - 0.25]);
  parts.push(kit.vents(kit.grid(8, 1, 3.2), { size: [1.6, 5], at: [0, H / 2, 0], rot: [-90, 0, 0] }));
  return kit.group(parts);
}
```

### Conventions

- **Units are millimetres**, taken from the catalogue. **+X** is the device's right as you face
  it, **+Y** is up, **+Z** points at you: the front of the device looks down +Z. Model the device as
  it normally stands (a console upright, a handheld with its screen facing +Z). You do not need to
  centre it or put it on the floor: the stage does both. The build log prints the size the model
  came out at next to the catalogue size and warns when width or height is more than 6% off.
- `build(kit, options)` returns one `THREE.Object3D` (use `kit.group(parts)`). It may be `async`.
  `options` is `{ key, params, item, platformColors }`: `item` is the catalogue entry (`mm`,
  `notes`, and for games `title` / `platform`), `platformColors` the catalogue's platform colours.
- `export const views = { hero: {…}, front: {…}, back: {…} }` overrides `azimuth`, `elevation`
  or `lens` per view. `azimuth` is where the camera stands: 0 in front, positive towards the
  device's right. The lights orbit with the camera, so the key always comes from the upper left of
  the picture — pick the azimuth that puts the most important face towards it (the PS5 uses −32
  so its big white plate is lit; the Xbox uses elevation 27 so you can see into the top vent).
  Leave the lens alone unless something looks distorted.
- **One file per key.** A group of keys that differ only by colour or title can share one file
  named with a parameter: `models/dualsense-[colour].mjs` serves every `dualsense-<x>` key that has
  no file of its own and receives `options.params.colour` (`"white"`, `"black"`, `"red"`);
  `models/game-[slug].mjs` would serve all `game-…` keys, `models/gift-card-[brand].mjs` the cards.
  An exact file name always wins (`dualsense-edge.mjs`).
- Files starting with `_` are never matched by a catalogue key: use them for shared pieces
  (`_stick.mjs`, imported by several models) and test scenes. `_swatch.mjs` is the rig and
  material test: render it with `--only=_swatch` to see every material and helper at once.
- Do not import `three` yourself; use the helpers, and `kit.THREE` when you need something the kit
  does not have. If the kit lacks something several models need, say so instead of copying code.
- Colours: use `kit.colors` (`black` is a charcoal on purpose — pure black loses its form).
  "White" hardware is `colors.white`. Accent colours follow the catalogue notes.

### The kit in one page

Materials — every part uses one of these, never a raw three.js material:

| call | for |
|---|---|
| `clay(color, { finish })` | the house material: bodies, shells, buttons. `finish`: `'matte'` (default), `'satin'` (a little more sheen), `'soft'` (rubber, stick caps). `{ map }` takes a `paint()` texture |
| `glass({ aspect })` | screens: dark, glossy, one soft diagonal reflection. Pass the screen's width / height |
| `gloss(color)` | glossy moulded plastic (piano-black cores) |
| `metal(color)` | soft metal: shafts, heatsinks, contacts |
| `hollow()` | the inside of slots, ports and vents |
| `glow(color, strength)` | a lit accent: status light, light bar. Add `accentLight(color, strength, reachMm)` next to it to tint the surfaces around it |
| `clear(color, { opacity })` | see-through plastic or glass; build such parts with `mesh(…, { cast: false })` |
| `paint(w, h, (ctx, w, h) => …)` | a 2D-canvas texture for generated covers and card faces (no real artwork, no logos) |

Outlines — 2D profiles, counter-clockwise, in millimetres:
`rect(w, h, radius | [topLeft, topRight, bottomRight, bottomLeft])`, `pill(w, h)`, `circle(r)`,
`ellipse(rx, ry)`, `superellipse(w, h, exponent)`, `plus(size, arm)`,
`polygon([[x, y], …], radius | [per corner])`. Every outline has `.move(dx, dy)`, `.rotate(deg)`
and `.mirror()`.

Solids:

| call | makes |
|---|---|
| `slab(outline, depth, { bevel, bevelBack, dome, rings, axis })` | the workhorse: an outline given thickness, rounded edges, optionally a pillowed (`dome: +mm`) or dished (`dome: −mm`) face |
| `extrude(outline, depth, { bevel, holes, axis })` | the same for U / L / ring shapes and for plates with real holes |
| `box(w, h, d, radius)` | a box with all edges equally round |
| `puck(radius, height, { bevel, top, axis })` | round button, knob, foot (`top`: + domed, − dished) |
| `ring(outer, inner, height, { axis })` | washer / collar |
| `lathe([[radius, y], …], { axis })` | any profile spun around an axis |
| `capsule(radius, length, { axis })`, `torus(radius, tube, { axis })`, `tube([[x, y, z], …], radius)` | rods, rings, cables |
| `deform(geometry, (p) => { … }, { maxEdge })` | bend or bow a solid; returns the new geometry |

`slab` and `extrude` draw the outline in XY and face **+Z**; `puck`, `ring`, `lathe` and
`capsule` stand along **+Y**. `axis` points that direction elsewhere: `'x'`, `'-x'`, `'y'`,
`'-y'`, `'z'`, `'-z'`. Looking at the face, the outline's X is to your right and its Y is up.

Putting things together: `mesh(geometry, material, { at: [x, y, z], rot: [degX, degY, degZ] })`,
`group([...parts], { at, rot })`, `mirrorX(part)` for the left-hand twin of a part,
`grid(columns, rows, pitchX, pitchY, { stagger, keep })` and `radial(count, radius)` for point
patterns, `stamp(geometry, material, points)` to repeat a part at those points,
`vents(points, { size: [w, h] | radius, at, rot })` for dark vent slots, holes and ports laid on
a surface (`at` is a point ON the surface; `rot` turns the field: top `[-90, 0, 0]`, back
`[0, 180, 0]`, right side `[0, 90, 0]`).

### Recipes

- **A part on a surface** must not be coplanar with it: sink it a little
  (`at: [x, y, F - 0.25]` for a 1.5 mm button standing 1.25 mm proud) or lift an inlay by
  0.2–0.3 mm. Coplanar faces flicker.
- **Seams**: build the two parts with a 2 mm gap over something dark, or wrap a thin band round
  the body (the Switch 2 rails are a 1.9 mm `slab(…, { axis: 'x' })` a hair larger than the body's
  cross-section). Real seams are hairlines; they must be exaggerated to read.
- **Dark on dark** does not read. Give slots and ports a slightly lighter frame
  (`clay(colors.graphite, { finish: 'satin' })`) with the `vents()` inlay on top, and make black
  buttons one shade lighter than a black shell.
- **Curved shells** (the PS5 plates): `slab(polygon(points, radii, { edge: 10 }), t, { rings: 24, axis: 'x' })`,
  then `deform()` with a function of the position. `edge` and `rings` give the slab enough
  vertices to bend smoothly.
- **Real holes** (the Xbox top vent): `extrude(rect(…), t, { holes: grid(…).map(([x, y]) => circle(r).move(x, y)) })`.
  To bend such a plate, `deform(geometry, fn, { maxEdge: 3 })` cuts its long triangles first. To
  show colour inside the holes, put a second, thicker perforated plate in that colour right under
  the first one.
- **Mirrored pairs**: build the right-hand part, then `parts.push(part, kit.mirrorX(part))`.
- **Small things** (a microSD card): only proportions matter — the stage scales every object to
  fill the frame — but keep details above about 0.3% of the object's size or they vanish.
- **Thin flat things** (cards, sheets): do not render them edge-on. Lean them back with `rot` so
  the face is towards the camera; the catalogue notes usually say how.

### Checklist before publishing

- Silhouette and proportions match the real hardware; the log shows no size warning.
- Every view on the sheet is clean on the light **and** the dark backdrop.
- Recognisable at 120 px. If not, the identifying parts are too small or too low in contrast.
- Colours follow the catalogue notes. No logo, no wordmark, no trademarked symbol, no letters on
  buttons.
- Same family: compare with `.masters/_family.png`. If it looks brighter, glossier or more
  cartoonish than its neighbours, the model is using materials the wrong way — the rig is shared
  and must not be changed per model.
- `npm test -- tests/art.test.ts` passes.

## Using the pictures

```tsx
import { Art, artViews, hasArt } from "~/art";

<Art name="switch-2" alt={t("switch2")} sizes="(min-width: 768px) 320px, 45vw" className="w-full" />
<Art name="ps5-slim" view="front" alt="" className="h-full w-full object-contain" />
<Art name="xbox-series-x" alt={title} priority />   // only the first picture above the fold
```

`<Art>` renders `<picture>` with AVIF, then WebP, then the PNG `<img>` with intrinsic width and
height, lazy by default. A key without a render draws a neutral placeholder of the expected shape
(and warns in the dev console), so pages can be built before their art exists.

## Troubleshooting

- *"Could not get a WebGL2 context"* — the browser has no usable GPU path. Try
  `--gl=swiftshader`; if that works, the hardware path is blocked on this machine.
- *"shader patch … does not match three r…"* — three.js was upgraded and a line that `kit.mjs`
  patches has changed. The patches are at the top of the materials section; update the strings.
- *A model throws* — the message is printed with the key; other keys still build and the exit code
  is non-zero.
- *Bright hairline where two parts touch, or a part looks see-through* — one of them is not a
  closed solid. Every kit helper returns closed solids; raw planes and open shapes do not work
  with the shadow method (shadow maps hold the far side of each solid).
- *The picture is cut off / "touches the edge"* — the shadow reached the frame; the object is
  probably much taller than `mm` says, or lies far from where it should.
