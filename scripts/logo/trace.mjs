#!/usr/bin/env node
// TamTam Games — provisional vector trace of the logo.
//
// The only logo artwork the owner supplied is inside a reference screenshot (the red logo on the
// splash screen, about 200 px wide). This script traces THAT artwork instead of redrawing it:
//
//   1. take the logo region of the screenshot, losslessly (kept in scripts/logo/source/splash-logo.png)
//   2. per pixel, estimate how much of it is covered by logo ink (an alpha matte): the green/blue
//      level of the pixel, placed between the local background level and the local ink level.
//      Gloss highlights inside the shapes stay "ink" because they are measured against the ink
//      around them, and the pink gradient behind the logo does not shift the edges because the
//      background level is estimated locally.
//   3. enlarge the matte 12× (Catmull-Rom, sampled at pixel centres) and refine it into a clean
//      two-level image whose coverage still agrees with the source pixels (see `refine`)
//   4. vectorise each part (mascot, Arabic wordmark, "TAM TAM", "GAMES") with potrace
//   5. "TAM TAM" only: its letters have nothing but straight sides, so each outline is replaced by
//      the polygon of its fitted edges, which puts back the corners that the low resolution
//      rounded off (see `straightenOutline`). Everything else stays exactly as potrace drew it.
//   6. put the four parts in one coordinate system that keeps their original positions and sizes
//   7. rasterise the result again and measure it against the source (printed, and stored in parts.json)
//
// Outputs:  app/art/logo/parts.ts      path data + boxes for <Logo>
//           scripts/logo/parts.json    the same data (+ fidelity numbers) for scripts/logo/assets.mjs
//           .shots/logo/*.png          overlays for checking by eye (with --debug)
//
// Usage:    node scripts/logo/trace.mjs            trace and write the two output files
//             --debug[=<subfolder>]   also write overlays to .shots/logo[/<subfolder>] and print timings
//             --dry                   print the report only, write nothing
//             --only=<part,…>         trace some parts only (implies --dry)
//             --<part|all>.<setting>=<number>     try a setting, e.g. --games.traceScale=6
//             --<part>.straight=<letters>         letters to straighten, e.g. --latin.straight= (none)
//             --polygons              print the fitted polygons of the straightened letters
//             --no-cache              redo the refinement even if .shots/logo/cache has it
//             --original=<png>        re-extract the source crop from the full reference screenshot
//           Takes about half a minute; afterwards run `node scripts/logo/assets.mjs`, then LOOK at
//           the result with `node scripts/logo/compare.mjs`.
//
// THIS IS A PROVISIONAL TRACE of a low-resolution screenshot. Replace it with the owner's original
// logo file as soon as it is supplied (see the note at the bottom of this file).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import potrace from "potrace";
import sharp from "sharp";
import { buildLayouts } from "./layouts.mjs";
import { boxOf, mapSubpaths, parsePath, toPathData } from "./lib/paths.mjs";
import { blur, clamp01, enlarge, localLevel, morph, refine, removeSpecks, shrink } from "./lib/planes.mjs";
import { straightenOutline } from "./lib/straighten.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SOURCE_CROP = path.join(HERE, "source/splash-logo.png");
const OUT_JSON = path.join(HERE, "parts.json");
const OUT_TS = path.join(ROOT, "app/art/logo/parts.ts");
const DEBUG_ROOT = path.join(ROOT, ".shots/logo");
const REFINEMENT_CODE = await readFile(path.join(HERE, "lib/planes.mjs"));

/** Where the logo sits in the supplied screenshot (1199 × 1312 px). */
const ORIGINAL = { file: "39a38d99-8cab-4bcc-a16a-6b83f3ac0213.png", width: 1199, height: 1312 };
const REGION = { left: 30, top: 142, width: 220, height: 226 };

/** Logo units per screenshot pixel. Coordinates are rounded to 0.1 unit = 1/50 px. */
const UNITS = 5;

/** Enlargement used for measuring and for the debug pictures. */
const CHECK_SCALE = 8;

/**
 * Settings, per part (all lengths in screenshot pixels unless noted):
 *   scale           enlargement at which the matte is refined
 *   refine          refinement iterations (0 = plain interpolation)
 *   interfaceWidth  ε of the phase field, in enlarged pixels
 *   fidelity        μ — how firmly coverage is held over a neighbourhood
 *   fidelityRadius  size of that neighbourhood (Gaussian sigma)
 *   pixelFidelity   ν — how firmly single source pixels are held …
 *   pixelTolerance  τ — … once they disagree by more than about this much coverage
 *   blur            final Gaussian smoothing before thresholding
 *   threshold       level at which a point counts as ink
 *   traceScale      enlargement handed to potrace (a divisor of `scale`). potrace reads anything
 *                   under half a bitmap pixel as noise, so a LOWER value gives straighter edges and
 *                   crisper corners (right for lettering), a higher one keeps finer detail (hair).
 *   minIsland       ink islands smaller than this many px² are dropped
 *   minHole         enclosed holes smaller than this many px² are filled (gloss sparkles)
 *   alphaMax        potrace corner threshold (0 = polygon … 1.33 = no corners)
 *   optTolerance    potrace curve-merging tolerance, in bitmap pixels
 *   edgeTolerance, minEdge, maxReach, snapLong, snapShort
 *                   for `straightenOutline`, which is applied to the letters named in a part's
 *                   `straight` (its `text` lists the letters from left to right)
 */
const DEFAULTS = {
  scale: 12,
  refine: 900,
  interfaceWidth: 1.5,
  fidelity: 5,
  fidelityRadius: 1.5,
  pixelFidelity: 0.3,
  pixelTolerance: 0.25,
  blur: 0.25,
  threshold: 0.5,
  traceScale: 12,
  minIsland: 0.5,
  minHole: 2,
  alphaMax: 1,
  optTolerance: 0.8,
  edgeTolerance: 0.4,
  minEdge: 2.4,
  maxReach: 1.6,
  snapLong: 4,
  snapShort: 12,
};

/**
 * `window` is [x0, y0, x1, y1] in screenshot pixels: the whole part and nothing of its neighbours.
 *
 * The mascot keeps a fine potrace bitmap (hair tips); the two big lines of lettering use a coarse
 * one. "GAMES" is only 9 px tall with strokes under 2 px: it keeps a fine bitmap and less smoothing,
 * and a threshold just under 50 % so that its thin strokes keep their measured weight. Its letters
 * are NOT straightened — at that size the fitted edges are too short to trust, and a mix of crisp
 * and soft letters looks worse than five equally soft ones.
 */
const PARTS = [
  { ...DEFAULTS, id: "mascot", window: [82, 146, 200, 251], traceScale: 6, optTolerance: 0.9 },
  { ...DEFAULTS, id: "wordmark", window: [36, 251, 242, 309], traceScale: 4, optTolerance: 0.8, minHole: 6 },
  { ...DEFAULTS, id: "latin", window: [38, 309, 236, 338], traceScale: 4, optTolerance: 0.3, minHole: 1.5, text: "TAMTAM", straight: "TAM" },
  { ...DEFAULTS, id: "games", window: [74, 342, 204, 361], traceScale: 6, optTolerance: 0.4, blur: 0.15, threshold: 0.45, minIsland: 0.3, minHole: 0.2, text: "GAMES", straight: "" },
];

// ───────────────────────────────────────────── arguments

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const part of PARTS) {
  for (const key of Object.keys(DEFAULTS)) {
    const value = option(`${part.id}.${key}`) ?? option(`all.${key}`);
    if (value !== undefined) part[key] = Number(value);
  }
  part.straight = option(`${part.id}.straight`) ?? part.straight ?? "";
  if (part.scale % part.traceScale !== 0) throw new Error(`${part.id}: traceScale ${part.traceScale} must divide scale ${part.scale}`);
}
const DEBUG = flag("debug") || option("debug") !== undefined;
const DEBUG_DIR = path.join(DEBUG_ROOT, option("debug") ?? "");
const DRY = flag("dry");

// ───────────────────────────────────────────── source

async function loadSource() {
  const original = option("original");
  if (original) {
    const meta = await sharp(original).metadata();
    if (meta.width !== ORIGINAL.width || meta.height !== ORIGINAL.height) {
      throw new Error(`--original must be the ${ORIGINAL.width}×${ORIGINAL.height} reference screenshot (${ORIGINAL.file}); got ${meta.width}×${meta.height}`);
    }
    await mkdir(path.dirname(SOURCE_CROP), { recursive: true });
    await sharp(original).extract(REGION).png({ compressionLevel: 9 }).toFile(SOURCE_CROP);
    console.error(`source crop refreshed from ${original}`);
  }
  if (!existsSync(SOURCE_CROP)) {
    throw new Error(`Missing ${path.relative(ROOT, SOURCE_CROP)}. Run once with --original=<path to ${ORIGINAL.file}>.`);
  }
  const file = await readFile(SOURCE_CROP);
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== REGION.width || info.height !== REGION.height || info.channels !== 3) {
    throw new Error(`Unexpected source crop ${info.width}×${info.height}×${info.channels}`);
  }
  // Hash the pixels, not the PNG file, so re-encoding the crop does not look like new artwork.
  return { rgb: data, width: info.width, height: info.height, pixelSha256: createHash("sha256").update(data).digest("hex"), file };
}

/** Ink coverage (0…1) of every source pixel. */
function buildMatte({ rgb, width: w, height: h }) {
  const level = new Float32Array(w * h); // green/blue level: ~10–75 inside the red shapes, 150–255 behind them
  for (let i = 0; i < w * h; i++) level[i] = (rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 2;

  const probablyInk = new Uint8Array(w * h);
  const clearlyInk = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    probablyInk[i] = level[i] < 120 ? 1 : 0;
    clearlyInk[i] = level[i] < 85 ? 1 : 0;
  }
  const sureInk = morph(clearlyInk, w, h, 1, "min"); // interior pixels only

  const inkValues = [];
  for (let i = 0; i < w * h; i++) if (sureInk[i]) inkValues.push(level[i]);
  inkValues.sort((a, b) => a - b);
  const typicalInk = inkValues[Math.floor(inkValues.length / 2)];

  // Background level, in two passes. The first uses only pixels well away from obvious ink. The
  // second knows roughly how light the background is at each spot, so it can also recognise faint
  // ink (hair tips at 20–40 % coverage) and keep it out of the estimate, and it may use background
  // pixels right next to the shapes — where the artwork has a light rim — which is the level an
  // edge pixel is actually mixed with.
  const farFromInk = morph(probablyInk, w, h, 2, "max").map((v) => 1 - v);
  const roughBackground = localLevel(level, farFromInk, w, h, 235);
  const anyInk = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) anyInk[i] = level[i] < roughBackground[i] - 22 ? 1 : 0;
  const sureBackground = morph(anyInk, w, h, 1, "max").map((v) => 1 - v);

  const backgroundLevel = localLevel(level, sureBackground, w, h, 235);
  const inkLevel = localLevel(level, sureInk, w, h, typicalInk);

  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    alpha[i] = clamp01((backgroundLevel[i] - level[i]) / Math.max(40, backgroundLevel[i] - inkLevel[i]));
  }
  return { alpha, backgroundLevel, inkLevel, typicalInk };
}

// ───────────────────────────────────────────── tracing one part

function potraceBitmap(png, params) {
  return new Promise((resolve, reject) => {
    const tracer = new potrace.Potrace(params);
    tracer.loadImage(png, (error) => {
      if (error) reject(error);
      else resolve(tracer.getPathTag());
    });
  });
}

async function tracePart(part, matte, source) {
  const [ax0, ay0, ax1, ay1] = part.window;
  const x0 = ax0 - REGION.left;
  const y0 = ay0 - REGION.top;
  const w = ax1 - ax0;
  const h = ay1 - ay0;

  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = matte.alpha[(y + y0) * source.width + x + x0];

  const started = performance.now();
  let { data: field, width: W, height: H } = enlarge(alpha, w, h, part.scale);
  if (part.refine > 0) {
    // The refinement is the slow step and depends only on the source pixels, these settings and the
    // code in lib/planes.mjs, so its result is kept in .shots/logo/cache while potrace settings are tuned.
    const settings = [part.window, part.scale, part.refine, part.interfaceWidth, part.fidelity, part.fidelityRadius, part.pixelFidelity, part.pixelTolerance];
    const key = createHash("sha256").update(source.pixelSha256).update(REFINEMENT_CODE).update(JSON.stringify(settings)).digest("hex").slice(0, 16);
    const cached = path.join(DEBUG_ROOT, "cache", `${part.id}-${key}.f32`);
    if (!flag("no-cache") && existsSync(cached)) {
      const bytes = await readFile(cached);
      field = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
    } else {
      field = refine(field, alpha, w, h, part.scale, { iterations: part.refine, ...part });
      await mkdir(path.dirname(cached), { recursive: true });
      await writeFile(cached, Buffer.from(field.buffer, field.byteOffset, field.byteLength));
    }
  }
  if (part.blur > 0) field = blur(field, W, H, part.blur * part.scale);
  const refined = performance.now();

  // Hand potrace a bitmap at `traceScale`.
  const T = part.traceScale;
  if (T !== part.scale) {
    field = shrink(field, W, H, part.scale / T);
    W = w * T;
    H = h * T;
  }
  const mask = new Uint8Array(W * H); // 1 = ink
  for (let i = 0; i < W * H; i++) mask[i] = field[i] >= part.threshold ? 1 : 0;
  const specks = removeSpecks(mask, W, H, part.minIsland * T * T, part.minHole * T * T);

  const bitmap = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) bitmap[i] = mask[i] ? 0 : 255;
  const png = await sharp(bitmap, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();

  const tag = await potraceBitmap(png, {
    threshold: 128,
    turdSize: 2,
    alphaMax: part.alphaMax,
    optCurve: true,
    optTolerance: part.optTolerance,
    turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
  });
  const d = /\sd="([^"]*)"/.exec(tag)?.[1] ?? "";
  // bitmap pixels → screenshot pixels
  let subpaths = mapSubpaths(parsePath(d), (x, y) => [x / T + ax0, y / T + ay0]);
  let straightened = 0;
  if (part.straight) {
    // Match outlines to letters: outer outlines from left to right spell `part.text`; an outline
    // lying inside another one (a counter) belongs to that letter.
    const boxes = subpaths.map((sub) => boxOf([sub]));
    const inside = (a, b) => a !== b && a[0] > b[0] && a[1] > b[1] && a[2] < b[2] && a[3] < b[3];
    const outer = boxes.map((box, index) => index).filter((index) => !boxes.some((other) => inside(boxes[index], other)));
    outer.sort((a, b) => boxes[a][0] - boxes[b][0]);
    if (outer.length !== part.text.length) throw new Error(`${part.id}: expected ${part.text.length} letters (${part.text}), traced ${outer.length} separate shapes`);
    const letterOf = boxes.map((box, index) => {
      const owner = outer.includes(index) ? index : outer.find((candidate) => inside(box, boxes[candidate]));
      return part.text[outer.indexOf(owner)];
    });
    subpaths = subpaths.map((sub, index) => {
      if (!part.straight.includes(letterOf[index])) return sub;
      const polygon = straightenOutline(sub, part);
      if (!polygon) return sub;
      straightened++;
      if (flag("polygons")) console.error(`${part.id} ${letterOf[index]}: ${polygon.map((p) => `${(p[0] - ax0).toFixed(1)},${(p[1] - ay0).toFixed(1)}`).join("  ")}`);
      const [start, ...rest] = polygon;
      return { start, segments: rest.map((points) => ({ type: "L", points })) };
    });
  }
  if (DEBUG) {
    const polygons = part.straight ? `, straightened ${straightened}/${subpaths.length} outlines` : "";
    console.error(`${part.id}: refine ${Math.round(refined - started)} ms, potrace ${Math.round(performance.now() - refined)} ms, specks ${JSON.stringify(specks)}${polygons}`);
  }

  return { part, subpaths, alpha, specks, straightened, w, h };
}

/** Rasterise path data given in screenshot pixels over a part window. Returns coverage 0…1 at CHECK_SCALE. */
async function rasterise(d, window) {
  const [ax0, ay0, ax1, ay1] = window;
  const W = (ax1 - ax0) * CHECK_SCALE;
  const H = (ay1 - ay0) * CHECK_SCALE;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${ax0} ${ay0} ${ax1 - ax0} ${ay1 - ay0}"><rect x="${ax0}" y="${ay0}" width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000" fill-rule="evenodd"/></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = 1 - data[i * info.channels] / 255;
  return { data: out, width: W, height: H };
}

/**
 * Compares the shipped vector with the source, two ways that do not depend on the refinement:
 *   · overlap (intersection over union) with the plainly interpolated matte thresholded at 50 %
 *   · the vector's ink coverage of each source pixel against the matte's value for that pixel
 */
async function measure(traced, d) {
  const { part, alpha, w, h } = traced;
  const raster = await rasterise(d, part.window);
  const { data: plain, width: W, height: H } = enlarge(alpha, w, h, CHECK_SCALE);
  let both = 0;
  let either = 0;
  for (let i = 0; i < W * H; i++) {
    const a = raster.data[i] >= 0.5;
    const b = plain[i] >= 0.5;
    if (a && b) both++;
    if (a || b) either++;
  }
  const coverage = shrink(raster.data, W, H, CHECK_SCALE);
  let abs = 0;
  let edgeAbs = 0;
  let edgeCount = 0;
  let worst = 0;
  let inkArea = 0;
  let matteArea = 0;
  for (let i = 0; i < w * h; i++) {
    const diff = Math.abs(coverage[i] - alpha[i]);
    abs += diff;
    inkArea += coverage[i];
    matteArea += alpha[i];
    if (diff > worst) worst = diff;
    if ((alpha[i] > 0.02 && alpha[i] < 0.98) || (coverage[i] > 0.02 && coverage[i] < 0.98)) {
      edgeAbs += diff;
      edgeCount++;
    }
  }
  return {
    overlapWithPlainInterpolation: both / either,
    inkAreaRatio: inkArea / matteArea,
    meanCoverageError: abs / (w * h),
    meanEdgeCoverageError: edgeCount ? edgeAbs / edgeCount : 0,
    worstPixelError: worst,
    raster,
    plain,
  };
}

// ───────────────────────────────────────────── debug images

async function writeDebug(traced, d, measured, source) {
  const { part } = traced;
  const [ax0, ay0, ax1, ay1] = part.window;
  const S = CHECK_SCALE;
  const W = (ax1 - ax0) * S;
  const H = (ay1 - ay0) * S;
  const region = { left: ax0 - REGION.left, top: ay0 - REGION.top, width: ax1 - ax0, height: ay1 - ay0 };
  const original = await sharp(source.file).extract(region).resize(W, H, { kernel: "cubic", fit: "fill" }).png().toBuffer();
  const viewBox = `${ax0} ${ay0} ${ax1 - ax0} ${ay1 - ay0}`;
  const outline = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${viewBox}"><path d="${d}" fill="none" stroke="#00e5ff" stroke-width="${1.4 / S}"/></svg>`,
  );
  const filled = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${viewBox}"><rect x="${ax0}" y="${ay0}" width="100%" height="100%" fill="#fbeef2"/><path d="${d}" fill="#e11d2e" fill-rule="evenodd"/></svg>`,
  );
  const vector = await sharp(filled).resize(W, H, { fit: "fill" }).png().toBuffer();

  // agreement map: white = both background, grey = both ink, red = only in the source, blue = only in the vector
  const agreement = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const a = measured.raster.data[i] >= 0.5;
    const b = measured.plain[i] >= 0.5;
    const colour = a && b ? [70, 70, 70] : a ? [0, 90, 255] : b ? [255, 40, 40] : [255, 255, 255];
    agreement[i * 3] = colour[0];
    agreement[i * 3 + 1] = colour[1];
    agreement[i * 3 + 2] = colour[2];
  }

  await sharp(original).composite([{ input: outline }]).png().toFile(path.join(DEBUG_DIR, `${part.id}-overlay.png`));
  await sharp({ create: { width: W * 2 + 16, height: H, channels: 3, background: "#ffffff" } })
    .composite([
      { input: original, left: 0, top: 0 },
      { input: vector, left: W + 16, top: 0 },
    ])
    .png()
    .toFile(path.join(DEBUG_DIR, `${part.id}-side.png`));
  await sharp(agreement, { raw: { width: W, height: H, channels: 3 } }).png().toFile(path.join(DEBUG_DIR, `${part.id}-agreement.png`));
}

// ───────────────────────────────────────────── output

function renderTypeScript(data) {
  const ids = PARTS.map((p) => p.id);
  const lines = [];
  lines.push("// GENERATED by scripts/logo/trace.mjs — do not edit by hand; run `node scripts/logo/trace.mjs`.");
  lines.push("//");
  lines.push("// PROVISIONAL ARTWORK: these paths are an automatic trace of the ~200 px wide logo found inside a");
  lines.push("// reference screenshot (the only artwork supplied). Shapes are faithful to that picture, but fine");
  lines.push('// detail is limited by its resolution — most of all the small "GAMES" line. Replace this data');
  lines.push("// with the owner's original logo as soon as it is available.");
  lines.push("");
  lines.push(`export type LogoPartId = ${ids.map((id) => JSON.stringify(id)).join(" | ")};`);
  lines.push(`export type LogoVariant = ${Object.keys(data.layouts).map((id) => JSON.stringify(id)).join(" | ")};`);
  lines.push("");
  lines.push("export interface LogoPart {");
  lines.push("  /** Path data in lockup units: closed subpaths, each starting with an absolute M; even-odd fill. */");
  lines.push("  readonly d: string;");
  lines.push("  /** Tight box of the part inside the lockup: x, y, width, height. */");
  lines.push("  readonly box: readonly [x: number, y: number, width: number, height: number];");
  lines.push("}");
  lines.push("");
  lines.push("export interface LogoLayout {");
  lines.push("  /** viewBox size. */");
  lines.push("  readonly width: number;");
  lines.push("  readonly height: number;");
  lines.push("  /** Parts drawn, each moved by (x, y) from its lockup position. */");
  lines.push("  readonly parts: readonly { readonly part: LogoPartId; readonly x: number; readonly y: number }[];");
  lines.push("}");
  lines.push("");
  lines.push("/** Size of the original lockup (mascot above طمطم above TAM TAM above GAMES), in lockup units. */");
  lines.push(`export const LOGO_LOCKUP = { width: ${data.lockup.width}, height: ${data.lockup.height} } as const;`);
  lines.push("");
  lines.push("/** Lockup units per pixel of the source screenshot — a reminder of how little resolution the trace had. */");
  lines.push(`export const LOGO_UNITS_PER_SOURCE_PX = ${data.unitsPerSourcePx};`);
  lines.push("");
  lines.push("/** True while the artwork is a screenshot trace rather than the owner's original file. */");
  lines.push("export const LOGO_IS_PROVISIONAL: boolean = true;");
  lines.push("");
  lines.push("export const LOGO_PARTS: Readonly<Record<LogoPartId, LogoPart>> = {");
  for (const id of ids) {
    lines.push(`  ${id}: {`);
    lines.push(`    box: [${data.parts[id].box.join(", ")}],`);
    lines.push(`    d: ${JSON.stringify(data.parts[id].d)},`);
    lines.push("  },");
  }
  lines.push("};");
  lines.push("");
  lines.push("/**");
  lines.push(" * Arrangements of the parts (rules in scripts/logo/layouts.mjs). `stacked` is the lockup as supplied;");
  lines.push(" * `full` puts the same parts side by side and is NOT in the supplied artwork.");
  lines.push(" */");
  lines.push("export const LOGO_LAYOUTS: Readonly<Record<LogoVariant, LogoLayout>> = {");
  for (const [variant, layout] of Object.entries(data.layouts)) {
    lines.push(`  ${variant}: {`);
    lines.push(`    width: ${layout.width},`);
    lines.push(`    height: ${layout.height},`);
    lines.push("    parts: [");
    for (const placed of layout.parts) lines.push(`      { part: ${JSON.stringify(placed.part)}, x: ${placed.x}, y: ${placed.y} },`);
    lines.push("    ],");
    lines.push("  },");
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────────────────────────── main

const source = await loadSource();
const matte = buildMatte(source);
if (DEBUG) {
  await mkdir(DEBUG_DIR, { recursive: true });
  const grey = Buffer.alloc(source.width * source.height);
  for (let i = 0; i < grey.length; i++) grey[i] = Math.round(255 - matte.alpha[i] * 255);
  await sharp(grey, { raw: { width: source.width, height: source.height, channels: 1 } })
    .resize(source.width * 4, source.height * 4, { kernel: "nearest" })
    .png()
    .toFile(path.join(DEBUG_DIR, "matte.png"));
}

// --only=latin,games traces a subset while tuning (always a dry run: the lockup needs all four).
const only = option("only")?.split(",");
const traced = [];
for (const part of PARTS) if (!only || only.includes(part.id)) traced.push(await tracePart(part, matte, source));

// One coordinate system: origin at the top-left of everything, UNITS per screenshot pixel.
const everything = boxOf(traced.flatMap((t) => t.subpaths));
const [originX, originY] = everything;
const toUnits = (x, y) => [(x - originX) * UNITS, (y - originY) * UNITS];

const fidelity = {};
const parts = {};
for (const item of traced) {
  const { part, subpaths } = item;
  const inUnits = mapSubpaths(subpaths, toUnits);
  const d = toPathData(inUnits, 1);
  // Measure exactly what ships: the rounded path data, mapped back to screenshot pixels.
  const shipped = toPathData(
    mapSubpaths(parsePath(d), (x, y) => [x / UNITS + originX, y / UNITS + originY]),
    4,
  );
  const measured = await measure(item, shipped);
  const [bx0, by0, bx1, by1] = boxOf(parsePath(d));
  parts[part.id] = { d, box: [bx0, by0, bx1 - bx0, by1 - by0].map((v) => Number(v.toFixed(1))) };
  fidelity[part.id] = {
    sourceSizePx: [Number(((bx1 - bx0) / UNITS).toFixed(1)), Number(((by1 - by0) / UNITS).toFixed(1))],
    subpaths: subpaths.length,
    segments: subpaths.reduce((n, sub) => n + sub.segments.length, 0),
    bytes: d.length,
    specksRemoved: item.specks,
    overlapWithPlainInterpolation: Number(measured.overlapWithPlainInterpolation.toFixed(4)),
    inkAreaRatio: Number(measured.inkAreaRatio.toFixed(4)),
    meanCoverageError: Number(measured.meanCoverageError.toFixed(4)),
    meanEdgeCoverageError: Number(measured.meanEdgeCoverageError.toFixed(4)),
    worstPixelError: Number(measured.worstPixelError.toFixed(3)),
    straightenedLetters: part.straight || null,
    straightenedOutlines: item.straightened,
    settings: Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, part[key]])),
  };
  if (DEBUG) await writeDebug(item, shipped, measured, source);
}

const lockup = {
  width: Number(((everything[2] - everything[0]) * UNITS).toFixed(1)),
  height: Number(((everything[3] - everything[1]) * UNITS).toFixed(1)),
};
const output = {
  generatedBy: "scripts/logo/trace.mjs",
  provisional: true,
  note: "Traced from a ~200 px wide logo inside a reference screenshot. Replace with the owner's original logo file.",
  source: {
    screenshot: ORIGINAL.file,
    region: REGION,
    crop: "scripts/logo/source/splash-logo.png",
    cropPixelSha256: source.pixelSha256,
    originInScreenshotPx: [Number(originX.toFixed(3)), Number(originY.toFixed(3))],
  },
  unitsPerSourcePx: UNITS,
  lockup,
  layouts: only ? null : buildLayouts(parts, lockup),
  parts,
  fidelity,
};

console.log(JSON.stringify({ lockup, report: fidelity }, null, 2));

if (!DRY && !only) {
  await writeFile(OUT_JSON, `${JSON.stringify(output, null, 2)}\n`);
  await mkdir(path.dirname(OUT_TS), { recursive: true });
  await writeFile(OUT_TS, renderTypeScript(output));
  console.error(`wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_TS)}`);
}

// When the owner supplies the original logo (SVG/AI/PDF or a large PNG):
//   · vector original → export the four groups (mascot, wordmark, latin, games) in one coordinate
//     system and write the same structure this script writes — lockup size, `d` + `box` per part,
//     layouts from buildLayouts() in layouts.mjs, provisional: false / LOGO_IS_PROVISIONAL = false —
//     into scripts/logo/parts.json and app/art/logo/parts.ts, then run `node scripts/logo/assets.mjs`.
//     <Logo>, the icons and the manifest need no change. tests/brand.test.ts checks the two files agree.
//   · large PNG → put it in scripts/logo/source/, adjust ORIGINAL / REGION / PARTS above (with real
//     resolution: refine 0, scale = traceScale = 1 or 2, straight: "") and run this script.
