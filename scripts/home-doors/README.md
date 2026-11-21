# Home department doors — three.js studio (v2, path traced)

The eight department icons under the home hero (`app/routes/storefront/home/doors/<door>.<locale>.webp`) are
modelled in three.js and rendered with a GPU path tracer. No generated pictures: every object is built from
three.js geometry in `objects/<door>.js`, and the department's name is printed into one of the object's own
surfaces (Kufam, from `public/fonts`), one render per language (ar, en, ckb).

## Files

- `kit.js` — materials (`M`), shapes (slab, sculpt, lathe, tube…), tangents, and the printed name
  (`titleSlab`, `titleMaterial`: colour + roughness + relief maps on the face).
- `core.js` — the virtual photo studio: an HDR environment of soft boxes, the path tracer
  (three-gpu-pathtracer's `WebGLPathTracer`), framing (the whole object always fits), and three passes per picture:
  the beauty pass (transparent background; the floor is "matte", invisible but still bouncing light) and the floor
  with and without the object on an overhead-lit shadow table.
- `render.mjs` — serves the studio, drives headless Chrome on the GPU (`--use-angle=d3d11`), turns the floor passes'
  ratio into a real contact shadow, and writes `<door>.<lang>.webp` (800×600, transparent) plus inspection PNGs
  and contact sheets.
- `sheet.mjs` — contact sheets of any renders on the store's light and dark floors.
- `objects/<door>.js` — one module per door: `export const meta` (turn, tilt, gap, margin, centerY) and
  `export function build({ text, lang, key })`.

## Setup (outside the repo — nothing is added to the store's dependencies)

```sh
mkdir D:/tt-tmp/doors3d-v2 && cd D:/tt-tmp/doors3d-v2
npm init -y && npm i three@0.187.0 three-mesh-bvh@0.9.18 three-gpu-pathtracer@0.0.28
# copy this folder's files next to node_modules
```

`render.mjs` borrows `puppeteer-core` and `sharp` from the store repo (`C:/Users/levon/tamtam/node_modules`) and the
fonts from its `public/fonts`. It needs a hardware GPU: it warns when Chrome falls back to SwiftShader.

## Rendering

```sh
node render.mjs --keys controllers --langs ar --out out/try      # quick preview: 1200×900, 160 spp (~30–60 s)
node render.mjs --langs ar,en,ckb --final --out out/final         # all doors: 1600×1200, 640 spp (~95 s each)
```

Each picture is written at three widths (`<door>.<lang>.webp` = 800, `.600.webp`, `.400.webp`); the site ships all
three as `app/routes/storefront/home/doors/<door>.<lang>.<width>.webp` and lets the browser pick (`srcset`).
`python port-to-repo.py out/final` copies them and this studio into the repo.

`veil.mjs <png…>` measures the alpha left at a render's edges (it must stay near 0, or the page shows a grey box).

## Gotchas found while building it

- three-gpu-pathtracer 0.0.28 merges meshes with one material slot per mesh: a mesh with a material array shifts
  every later mesh onto the wrong material. `core.js` splits such meshes per geometry group before tracing.
- Normal maps need a `tangent` attribute in the tracer; `kit.ensureTangents` adds one (core does it automatically).
- `material.matte` hides a surface from the camera but does not catch shadows — hence the two floor passes.
- WebGL calls return before the GPU works and `gl.finish()` does not block in Chrome: tracing is throttled with
  fences; pixels are read with `readPixels` (PNG `toDataURL` of the GPU canvas took ~35 s each).
