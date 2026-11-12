#!/usr/bin/env node
/**
 * TamTam product photos — from the researched originals to what the storefront serves.
 *
 *   node scripts/products/images.mjs                       every image of every catalog/products/*.json
 *   node scripts/products/images.mjs --only slug,slug      these products only (also --only=slug,slug)
 *   node scripts/products/images.mjs --force               rebuild even what is up to date
 *   node scripts/products/images.mjs --try a.png,b.jpg --kind=hero [--cutout=false --holes --extend --clean --pad=0.1 --crop=l,t,r,b --opaque]
 *                                                          run the treatment on any file and write a review
 *                                                          sheet to .cache/product-images/_try/ — publishes nothing;
 *                                                          prints the opaque-photo gate's verdict too
 *   node scripts/products/images.mjs --opaque-report       the published photos the gate would refuse today
 *
 * Other flags: --no-sheet (skip review sheets) · --no-download (never fetch a missing original) ·
 * --jobs=N (images in parallel, default 2) · --opaque-report (list every published photo the opaque-photo gate
 * below would refuse today — the re-cut list — and exit; nothing is built).
 *
 * For each entry of "images" in a catalogue file (key "<slug>--<n>", file, sourceUrl, sourcePage, kind,
 * credit) it reads the original from "file" — fetching it again from sourceUrl when it is missing —
 * and writes
 *   public/products/<slug>/<n>-<w>.<hash>.{avif,webp}   w = 240 · 480 · 720 · 960 · 1440, never wider than the picture
 *   public/products/<slug>/<n>-<w>.<hash>.{jpg,png}     the product's share image (og:image), first image only:
 *                                                       JPEG when opaque, PNG when transparent, ≤ 1200 px wide
 *   app/art/photos/<slug>--<n>.json                     manifest read by <Art> through app/art/index.ts
 *   .cache/product-images/_sheets/<slug>.png            review sheet: every image on the light and dark stage, edge zooms
 *   .cache/product-images/_report.json                  what was decided for every image, and why
 * There is no PNG fallback: every browser the store supports decodes WebP, so <Art> falls back to the
 * 720 px WebP. public/products holds exactly the files the manifests reference (the rest is pruned).
 *
 * Treatment (scripts/products/lib/cutout.mjs has the details):
 *   - Normalised first: EXIF orientation applied, converted to sRGB, metadata stripped, worked on at
 *     ≤ 2400 px and published at ≤ 1600 px on the longer side.
 *   - Real transparency is kept: trimmed to the object plus 6% padding.
 *   - "screenshot", and "box-art" that fills its frame, stay untouched opaque rectangles.
 *   - Other photos on a plain light background are cut out when every check passes; otherwise they
 *     stay opaque, trimmed to their content plus 6% of their own background, and the manifest records
 *     that background so the storefront frames them on a matching surface.
 *
 * Per-image options, decided by looking at the result, live in scripts/products/image-options.json
 * (key → options plus a "why"): cutout false (keep the photo opaque), holes true (cut out closed
 * windows of pure background colour — the inside of a headband), extend true (the object touches
 * the frame of a plain canvas: extend the canvas, then cut out), clean true (a transparent source:
 * drop a baked shadow or glow and stray specks), pad (padding share instead of 6%), trim false (an
 * opaque photo keeps its full frame), crop [left, top, right, bottom] (shares of the original cut
 * off before anything else — white bars, an empty canvas), opaque true (the gate below accepts this
 * opaque photo after looking; it changes nothing in the treatment).
 *
 * Opaque-photo gate (design v2 spec §7.5: one ground for every product photo, no white or black boxes
 * inside the well). A photo that comes out OPAQUE — not box art, not a screenshot — passes only when
 * the plain background it kept is within ΔE 3 (CIE76, the treatment's own unit) of the light
 * `--niche` token (read from app/styles/tokens.css), so it sits on the product ground without a
 * visible box. Otherwise it is REFUSED (✗, not published, exit code 1) — re-cut it (--try helps),
 * give it the kind it really is (box-art, screenshot), or accept it with "opaque": true and a why.
 * Photos already published opaque before the gate existed are GRANDFATHERED: rebuilt and published
 * as before, counted in the summary, and listed by --opaque-report until they are re-cut (owner input,
 * spec §13 row 7). The storefront flags every one of them (ImageRef.opaque) so the well treats it.
 *
 * Manifest = the clay-render manifest (app/art/index.ts ArtManifest, without the PNG; view "hero", or "back" when the
 * catalogue entry says `"view": "back"` — a picture of the object's back, which no tile or lead picture may use) plus
 *   transparent, background ("#rrggbb" | null), kind, credit, source { url, page }, share (first image
 *   only) and input — a hash of the original, of its options and of every treatment and encoder
 *   setting. An image whose manifest carries the same input hash and whose files all exist is skipped
 *   (only its view, credit and source are refreshed).
 * Output is deterministic and file names carry a hash of their content, so /products/* can be cached
 * forever and a rebuild that changes nothing rewrites no file.
 */
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PHOTO_KINDS, TREATMENT_VERSION, lab, treat } from './lib/cutout.mjs';
import { writeSheet } from './lib/sheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG = path.join(ROOT, 'catalog', 'products');
const PUBLIC = path.join(ROOT, 'public', 'products');
const MANIFESTS = path.join(ROOT, 'app', 'art', 'photos');
const CACHE = path.join(ROOT, '.cache', 'product-images');
const OPTIONS_FILE = path.join(ROOT, 'scripts', 'products', 'image-options.json');

const WIDTHS = [240, 480, 720, 960, 1440];
/**
 * The widths a picture is published at: the standard widths it covers, never upscaled. A picture narrower than the
 * second standard width (a maker's small cut-out, e.g. Razer's 500 px renders) also ships at its own width, so a
 * 2× screen gets every pixel there is instead of the 240 px file stretched; one narrower than 240 ships at its own
 * width only. (tests/products-images.test.ts checks the same rule.)
 */
function publishedWidths(width) {
  const widths = WIDTHS.filter((w) => w <= width);
  if (width < WIDTHS[1] && !widths.includes(width)) widths.push(width);
  return widths;
}
/** The share image (og:image) of a product: its first picture, at most this wide. */
const SHARE_WIDTH = 1200;
const PLACEHOLDER_SIDE = 20;
/** The background treatment works at this size at most; finer detail does not survive publishing. */
const WORK_MAX = 2400;
/** Longest side of the published picture (its manifest width / height). */
const MASTER_MAX = 1600;
const ENCODE = {
  avif: { quality: 60, effort: 4, chromaSubsampling: '4:4:4' },
  webp: { quality: 82, alphaQuality: 90, effort: 5, smartSubsample: true },
  jpeg: { quality: 84, mozjpeg: true, chromaSubsampling: '4:2:0' },
  // Palette PNG (libimagequant, dithered): a quarter of the bytes of a full-colour one, alpha kept.
  png: { compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 92, effort: 10, dither: 1 },
  placeholder: { quality: 30, alphaQuality: 40, effort: 6 },
};
const SETTINGS = JSON.stringify({ TREATMENT_VERSION, WORK_MAX, MASTER_MAX, WIDTHS, SHARE_WIDTH, PLACEHOLDER_SIDE, ENCODE, sharp: sharp.versions.sharp, vips: sharp.versions.vips });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/* ── the opaque-photo gate (header; design v2 spec §7.5) ───────────────────── */

/** An opaque photo's kept background may differ from the product ground by at most this (CIE76 ΔE). */
const GATE_DELTA_E = 3;
/** Framed rectangles by design: the gate never asks them for a background. */
const GATE_FREE_KINDS = new Set(['box-art', 'screenshot']);
const TOKENS_FILE = path.join(ROOT, 'app', 'styles', 'tokens.css');
const NICHE_FALLBACK = '#f3f1ee';

/** The light theme's `--niche` (the first one in tokens.css: the :root block comes before the dark one). */
function readNiche() {
  try {
    const match = /--niche:\s*(#[0-9a-f]{6})\b/i.exec(readFileSync(TOKENS_FILE, 'utf8'));
    return match ? match[1].toLowerCase() : NICHE_FALLBACK;
  } catch {
    return NICHE_FALLBACK;
  }
}
const NICHE = readNiche();

/** CIE76 ΔE between two "#rrggbb" colours; null when either does not parse. */
function deltaE(a, b) {
  const rgb = (value) => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value ?? ''));
    return match ? match.slice(1, 4).map((part) => parseInt(part, 16)) : null;
  };
  const [x, y] = [rgb(a), rgb(b)];
  if (!x || !y) return null;
  const [p, q] = [lab(...x), lab(...y)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * The gate's verdict on one picture: { verdict: 'ok' | 'accepted' | 'refused', deltaE, why }. `picture` is a
 * treatment result or a published manifest (both carry transparent and background); `accepted` = the image's
 * options say "opaque": true.
 */
function opaqueGate(kind, picture, accepted) {
  if (picture.transparent || GATE_FREE_KINDS.has(kind)) return { verdict: 'ok', deltaE: null, why: null };
  const distance = picture.background ? deltaE(picture.background, NICHE) : null;
  if (distance !== null && distance <= GATE_DELTA_E) return { verdict: 'ok', deltaE: distance, why: null };
  const why = picture.background
    ? `opaque on ${picture.background}, ΔE ${distance.toFixed(1)} from --niche ${NICHE} (at most ${GATE_DELTA_E})`
    : 'opaque and fills its own frame (no plain background to match --niche)';
  return { verdict: accepted ? 'accepted' : 'refused', deltaE: distance, why };
}

/* ── flags ────────────────────────────────────────────────────────────────── */

const flags = {};
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { console.error(`Unexpected argument "${arg}".`); process.exit(2); }
    const eq = arg.indexOf('=');
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (['only', 'try', 'kind', 'jobs', 'pad', 'crop'].includes(arg.slice(2)) && args[i + 1] && !args[i + 1].startsWith('--')) flags[arg.slice(2)] = args[++i];
    else flags[arg.slice(2)] = true;
  }
}
const list = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const KEY = /^([a-z0-9]+(?:-[a-z0-9]+)*)--(\d+)$/;

/* ── per-image options ────────────────────────────────────────────────────── */

const OPTION_CHECKS = {
  cutout: (v) => v === false,
  holes: (v) => v === true,
  extend: (v) => v === true,
  clean: (v) => v === true,
  trim: (v) => v === false,
  pad: (v) => typeof v === 'number' && v >= 0 && v <= 0.4,
  crop: (v) => Array.isArray(v) && v.length === 4 && v.every((s) => typeof s === 'number' && s >= 0 && s < 0.5),
  opaque: (v) => v === true,
};
/** Options that only the gate reads: they change nothing in the treatment (nor in the input hash). */
const GATE_OPTIONS = new Set(['opaque']);
const withoutGateOptions = (options) => Object.fromEntries(Object.entries(options).filter(([name]) => !GATE_OPTIONS.has(name)));

/** scripts/products/image-options.json: key → { option…, why }. Unknown options are an error. */
async function readOptions() {
  if (!existsSync(OPTIONS_FILE)) return {};
  const raw = JSON.parse(await fs.readFile(OPTIONS_FILE, 'utf8'));
  const options = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key.startsWith('$')) continue;
    if (!KEY.test(key)) throw new Error(`${rel(OPTIONS_FILE)}: "${key}" is not an image key`);
    const { why, ...rest } = entry ?? {};
    if (typeof why !== 'string' || !why.trim()) throw new Error(`${rel(OPTIONS_FILE)}: ${key} needs a "why"`);
    for (const [name, value] of Object.entries(rest)) {
      if (!OPTION_CHECKS[name]?.(value)) throw new Error(`${rel(OPTIONS_FILE)}: ${key}.${name} = ${JSON.stringify(value)} is not a valid option`);
    }
    options[key] = rest;
  }
  return options;
}

/** The options as the treatment takes them (defaults filled in elsewhere: absent = default). */
const treatmentOptions = (job) => ({ kind: job.kind, ...withoutGateOptions(job.options) });

/* ── catalogue ────────────────────────────────────────────────────────────── */

/** Every image entry of the catalogue files we were asked for, plus the slugs that parsed. */
async function readCatalog(only, options) {
  const jobs = [], parsed = new Set(), problems = [];
  const files = existsSync(CATALOG) ? (await fs.readdir(CATALOG)).filter((f) => f.endsWith('.json')).sort() : [];
  const keys = new Set();
  for (const file of files) {
    const slug = file.slice(0, -5);
    let product;
    try {
      product = JSON.parse(await fs.readFile(path.join(CATALOG, file), 'utf8'));
    } catch (error) {
      if (!only || only.includes(slug)) problems.push(`${file}: ${error.message} — skipped (is it still being written?)`);
      continue;
    }
    for (const image of Array.isArray(product.images) ? product.images : []) keys.add(image?.key);
    if (only && !only.includes(slug)) continue;
    parsed.add(slug);
    let first = true;
    for (const [index, image] of (Array.isArray(product.images) ? product.images : []).entries()) {
      const where = `${slug} images[${index}]`;
      const match = KEY.exec(image?.key ?? '');
      if (!match || match[1] !== slug) { problems.push(`${where}: key "${image?.key}" must be "${slug}--<n>"`); continue; }
      if (!PHOTO_KINDS.includes(image.kind)) { problems.push(`${where}: kind "${image.kind}" must be one of ${PHOTO_KINDS.join(' | ')}`); continue; }
      if (!image.file && !image.sourceUrl) { problems.push(`${where}: neither "file" nor "sourceUrl"`); continue; }
      if (image.view !== undefined && image.view !== 'back') { problems.push(`${where}: view "${image.view}" must be "back" when given`); continue; }
      jobs.push({
        key: image.key, slug, n: Number(match[2]), kind: image.kind,
        // a picture of the object's back (ports, stand) — the manifest says so (view "back"), so no surface leads with it
        view: image.view === 'back' ? 'back' : 'hero',
        file: image.file ? path.resolve(ROOT, image.file) : path.join(CACHE, slug, `${match[2]}.bin`),
        credit: String(image.credit ?? '').trim(),
        source: { url: image.sourceUrl ?? null, page: image.sourcePage ?? null },
        options: options[image.key] ?? {},
        // The product's first picture also becomes its share image (og:image).
        share: first,
      });
      first = false;
    }
  }
  for (const slug of only ?? []) if (!files.includes(`${slug}.json`)) problems.push(`${slug}: no catalog/products/${slug}.json`);
  for (const key of Object.keys(options)) if (!keys.has(key)) problems.push(`${rel(OPTIONS_FILE)}: ${key} is not an image in the catalogue`);
  return { jobs, parsed, problems };
}

/* ── originals ────────────────────────────────────────────────────────────── */

/** Fetch an original again from its sourceUrl, the way a browser asks for an image. */
async function download(job) {
  const { url, page } = job.source;
  if (!/^https?:\/\//.test(url ?? '')) throw new Error(`the original is missing (${rel(job.file)}) and there is no sourceUrl to fetch it from`);
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(page ? { referer: page } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`fetching ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 80 * 1024 * 1024) throw new Error(`fetching ${url}: ${bytes.length} bytes is too large for a product photo`);
  const meta = await sharp(bytes).metadata().catch(() => null);
  if (!meta?.width) throw new Error(`fetching ${url}: the response is not an image (${response.headers.get('content-type')})`);
  await fs.mkdir(path.dirname(job.file), { recursive: true });
  await fs.writeFile(job.file, bytes);
  return bytes;
}

/** Decode, orient, crop (option), convert to sRGB, cap the size: RGBA, 8 bits, straight alpha. */
async function decode(bytes, crop) {
  const meta = await sharp(bytes, { failOn: 'none' }).metadata();
  const density = meta.format === 'svg' ? Math.min(2400, Math.max(72, Math.round((72 * WORK_MAX) / Math.max(meta.width ?? 1, meta.height ?? 1)))) : undefined;
  let pipeline = sharp(bytes, { failOn: 'none', density }).rotate();
  if (crop) {
    // Shares of the oriented original (what one sees), cut off before anything else.
    const scale = density ? density / 72 : 1;
    const width = Math.round((meta.autoOrient?.width ?? meta.width) * scale), height = Math.round((meta.autoOrient?.height ?? meta.height) * scale);
    const [l, t, r, b] = crop;
    const left = Math.round(width * l), top = Math.round(height * t);
    pipeline = pipeline.extract({ left, top, width: Math.max(1, width - left - Math.round(width * r)), height: Math.max(1, height - top - Math.round(height * b)) });
  }
  const { data, info } = await pipeline
    .resize({ width: WORK_MAX, height: WORK_MAX, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`decoded to ${info.channels} channels, expected 4`);
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, format: meta.format, source: { width: meta.autoOrient?.width ?? meta.width, height: meta.autoOrient?.height ?? meta.height } };
}

/** The treated picture at its published size (≤ MASTER_MAX on the longer side). */
async function master(picture) {
  const { width, height } = picture;
  const scale = Math.min(1, MASTER_MAX / Math.max(width, height));
  if (scale === 1) return picture;
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const data = await sharp(picture.data, { raw: { width, height, channels: 4 } }).resize({ width: w, height: h, fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  return { ...picture, data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: w, height: h };
}

/* ── publishing ───────────────────────────────────────────────────────────── */

const sha = (bytes, length = 8) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, length);

async function writeIfChanged(file, content) {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try {
    if (next.equals(await fs.readFile(file))) return false;
  } catch { /* new file */ }
  await fs.writeFile(file, next);
  return true;
}

function manifestOf(job, files, input) {
  return {
    key: job.key, view: job.view,
    width: files.width, height: files.height, aspect: +(files.width / files.height).toFixed(4),
    variants: files.variants,
    ...(files.share ? { share: files.share } : {}),
    placeholder: files.placeholder,
    dominant: files.dominant,
    transparent: files.transparent,
    background: files.background,
    kind: job.kind,
    credit: job.credit,
    source: { url: job.source.url, page: job.source.page },
    input,
  };
}

/** Variants, share image, placeholder and manifest for one treated picture; stale files of the same image go. */
async function publish(job, picture, input) {
  const { width, height, transparent } = picture;
  const image = () => {
    const s = sharp(picture.data, { raw: { width, height, channels: 4 } });
    return transparent ? s : s.removeAlpha();
  };
  const resized = (w) => (w === width ? image() : image().resize({ width: w, kernel: 'lanczos3' }));
  const widths = publishedWidths(width);
  const dir = path.join(PUBLIC, job.slug);
  const files = new Map();
  const add = (w, ext, buffer) => {
    const file = `${job.n}-${w}.${sha(buffer)}.${ext}`;
    files.set(file, buffer);
    return { w, src: `/products/${job.slug}/${file}` };
  };
  const side = width >= height ? { width: PLACEHOLDER_SIDE } : { height: PLACEHOLDER_SIDE };
  const shareWidth = Math.min(SHARE_WIDTH, width);
  const [avif, webp, share, placeholder] = await Promise.all([
    Promise.all(widths.map(async (w) => add(w, 'avif', await resized(w).avif(ENCODE.avif).toBuffer()))),
    Promise.all(widths.map(async (w) => add(w, 'webp', await resized(w).webp(ENCODE.webp).toBuffer()))),
    job.share
      ? (async () => {
          const { data, info } = await (transparent ? resized(shareWidth).png(ENCODE.png) : resized(shareWidth).jpeg(ENCODE.jpeg)).toBuffer({ resolveWithObject: true });
          const { src } = add(info.width, transparent ? 'png' : 'jpg', data);
          return { src, width: info.width, height: info.height, type: transparent ? 'image/png' : 'image/jpeg' };
        })()
      : null,
    image().resize({ ...side, kernel: 'lanczos3' }).webp(ENCODE.placeholder).toBuffer(),
  ]);

  // New files first, then the manifest that points at them, then the files it replaced.
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(MANIFESTS, { recursive: true });
  let bytes = 0;
  for (const [file, buffer] of files) { bytes += buffer.length; await writeIfChanged(path.join(dir, file), buffer); }
  const manifest = manifestOf(job, {
    width, height, transparent, background: picture.background, dominant: picture.dominant,
    variants: { avif, webp }, share,
    placeholder: `data:image/webp;base64,${placeholder.toString('base64')}`,
  }, input);
  await writeIfChanged(path.join(MANIFESTS, `${job.key}.json`), JSON.stringify(manifest, null, 2) + '\n');
  const mine = new RegExp(`^${job.n}-\\d+\\.[0-9a-f]{8}\\.(avif|webp|png|jpg)$`);
  for (const existing of await fs.readdir(dir)) {
    if (mine.test(existing) && !files.has(existing)) await fs.rm(path.join(dir, existing), { force: true });
  }
  return { manifest, bytes, files: files.size };
}

/** Every public file a manifest points at (a manifest of an older format may still name a PNG fallback). */
function referencedFiles(manifest) {
  return [...manifest.variants.avif, ...manifest.variants.webp].map((v) => v.src)
    .concat(manifest.variants.png ? [manifest.variants.png] : [], manifest.share ? [manifest.share.src] : []);
}

/** The WebP a review sheet shows: 720 px wide, or the largest there is below that. */
const reviewFile = (manifest) => path.join(ROOT, 'public', (manifest.variants.webp.find((v) => v.w >= 720) ?? manifest.variants.webp.at(-1)).src);

async function readManifest(key) {
  try {
    return JSON.parse(await fs.readFile(path.join(MANIFESTS, `${key}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** Manifests (and their files) of images that are no longer in the catalogue; files nobody points at. */
async function prune(parsed, wanted, only) {
  if (!existsSync(MANIFESTS)) return [];
  const removed = [];
  for (const file of (await fs.readdir(MANIFESTS)).sort()) {
    const match = KEY.exec(file.replace(/\.json$/, ''));
    if (!file.endsWith('.json') || !match) continue;
    const slug = match[1];
    if (only && !only.includes(slug)) continue;
    // A catalogue file that did not parse (being written right now) keeps its pictures.
    if (!parsed.has(slug) && existsSync(path.join(CATALOG, `${slug}.json`))) continue;
    if (wanted.has(match[0])) continue;
    const manifest = await readManifest(match[0]);
    await fs.rm(path.join(MANIFESTS, file), { force: true });
    for (const src of manifest ? referencedFiles(manifest) : []) await fs.rm(path.join(ROOT, 'public', src), { force: true });
    removed.push(match[0]);
  }
  // Files nobody points at (an interrupted run, an older format), and empty product folders.
  if (existsSync(PUBLIC)) {
    const referenced = new Set();
    for (const file of await fs.readdir(MANIFESTS)) {
      if (!file.endsWith('.json')) continue;
      const manifest = await readManifest(file.slice(0, -5));
      for (const src of manifest ? referencedFiles(manifest) : []) referenced.add(src);
    }
    for (const slug of await fs.readdir(PUBLIC)) {
      if (only && !only.includes(slug)) continue;
      const dir = path.join(PUBLIC, slug);
      if (!(await fs.stat(dir)).isDirectory()) continue;
      for (const file of await fs.readdir(dir)) if (!referenced.has(`/products/${slug}/${file}`)) await fs.rm(path.join(dir, file), { force: true });
      if (!(await fs.readdir(dir)).length) await fs.rmdir(dir);
    }
  }
  return removed;
}

/* ── one image ────────────────────────────────────────────────────────────── */

async function processImage(job) {
  let bytes;
  if (existsSync(job.file)) bytes = await fs.readFile(job.file);
  else if (flags['no-download']) throw new Error(`the original ${rel(job.file)} is missing (--no-download)`);
  else { bytes = await download(job); console.log(`  fetched ${job.key} from ${job.source.url}`); }

  const options = JSON.stringify({ ...withoutGateOptions(job.options), share: job.share });
  const input = sha(Buffer.concat([Buffer.from(`${SETTINGS}|${job.kind}|${options}|`), bytes]), 16);
  const previous = await readManifest(job.key);
  if (!flags.force && previous?.input === input && referencedFiles(previous).every((src) => existsSync(path.join(ROOT, 'public', src)))) {
    const refreshed = { ...previous, view: job.view, kind: job.kind, credit: job.credit, source: { url: job.source.url, page: job.source.page } };
    const changed = await writeIfChanged(path.join(MANIFESTS, `${job.key}.json`), JSON.stringify(refreshed, null, 2) + '\n');
    return { job, status: changed ? 'refreshed' : 'current', manifest: refreshed };
  }

  const started = performance.now();
  const decoded = await decode(bytes, job.options.crop);
  const treated = treat(decoded, treatmentOptions(job));
  // The opaque-photo gate (header): a new opaque photo off the product ground is not published.
  const gate = opaqueGate(job.kind, treated, job.options.opaque === true);
  if (gate.verdict === 'refused') {
    if (previous && previous.transparent === false) gate.verdict = 'grandfathered';
    else {
      throw new Error(
        `refused by the opaque-photo gate: ${gate.why}. Re-cut it (node scripts/products/images.mjs --try <file> --kind=${job.kind}), ` +
          `give it the kind it is (box-art, screenshot), or accept it in ${rel(OPTIONS_FILE)} with "opaque": true and a why (design v2 spec §7.5)`,
      );
    }
  }
  const picture = await master(treated);
  const published = await publish(job, picture, input);
  return { job, status: 'built', manifest: published.manifest, treated, decoded, gate, files: published.files, bytes: published.bytes, ms: performance.now() - started };
}

function describe(result) {
  const { job, treated, manifest } = result;
  const kind = job.kind.padEnd(10);
  if (result.status !== 'built') return `= ${job.key.padEnd(52)} ${kind} ${manifest.transparent ? 'transparent' : 'opaque'}   ${result.status === 'refreshed' ? '(credit/source refreshed)' : 'up to date'}`;
  const s = treated.stats ?? {};
  const facts = treated.method === 'cutout'
    ? `tolerance ${s.tolerance} · floor ${s.floor} · object ${Math.round((s.foreground ?? 0) * 100)}% · faint outline ${Math.round((s.weakOutline ?? 0) * 100)}%${s.holes ? ` · holes ${s.holes}` : ''}`
    : treated.reason ?? '';
  const size = `${manifest.width}×${manifest.height}`.padEnd(10);
  const options = Object.keys(job.options).length ? `  [${Object.entries(job.options).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}]` : '';
  const gate = result.gate && result.gate.verdict !== 'ok' ? `\n    ⚠ opaque-photo gate: ${result.gate.verdict} — ${result.gate.why}` : '';
  return `${treated.transparent ? '✓' : '·'} ${job.key.padEnd(52)} ${kind} ${treated.method.padEnd(9)} ${size} ${String(result.files).padStart(2)} files ${(result.bytes / 1024).toFixed(0).padStart(5)} kB  ${(result.ms / 1000).toFixed(1)}s  ${facts}${options}${gate}`;
}

/* ── --opaque-report: the published photos the gate would refuse today ────── */

async function opaqueReport() {
  const options = await readOptions();
  const files = existsSync(MANIFESTS) ? (await fs.readdir(MANIFESTS)).filter((file) => file.endsWith('.json')).sort() : [];
  const rows = [];
  for (const file of files) {
    const manifest = await readManifest(file.slice(0, -5));
    if (!manifest) continue;
    const gate = opaqueGate(manifest.kind, manifest, options[manifest.key]?.opaque === true);
    if (gate.verdict !== 'ok') rows.push({ key: manifest.key, kind: manifest.kind, ...gate });
  }
  console.log(`Opaque-photo gate (design v2 spec §7.5): background within ΔE ${GATE_DELTA_E} of --niche ${NICHE}, box art and screenshots exempt.\n`);
  for (const row of rows) console.log(`${row.verdict === 'accepted' ? '·' : '✗'} ${row.key.padEnd(56)} ${row.kind.padEnd(8)} ${row.verdict === 'accepted' ? 'accepted ' : 'to re-cut'} ${row.why}`);
  const recut = rows.filter((row) => row.verdict !== 'accepted').length;
  console.log(`\n${files.length} published photo${files.length === 1 ? '' : 's'}: ${recut} to re-cut (grandfathered until then), ${rows.length - recut} accepted in ${rel(OPTIONS_FILE)}.`);
}

async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

/* ── --try: any file, nothing published ───────────────────────────────────── */

async function tryFiles(files, kind) {
  const out = path.join(CACHE, '_try');
  await fs.mkdir(out, { recursive: true });
  const options = {};
  if (flags.cutout === 'false') options.cutout = false;
  if (flags.holes) options.holes = true;
  if (flags.extend) options.extend = true;
  if (flags.clean) options.clean = true;
  if (flags.trim === 'false') options.trim = false;
  if (flags.pad !== undefined) options.pad = Number(flags.pad);
  if (flags.crop) options.crop = list(flags.crop).map(Number);
  for (const [name, value] of Object.entries(options)) if (!OPTION_CHECKS[name](value)) throw new Error(`--${name}: ${JSON.stringify(value)} is not a valid option`);
  for (const file of files) {
    const started = performance.now();
    const decoded = await decode(await fs.readFile(path.resolve(file)), options.crop);
    const treated = treat(decoded, { kind, ...options });
    const picture = await master(treated);
    const name = `${path.basename(path.dirname(path.resolve(file)))}-${path.basename(file).replace(/\.[^.]+$/, '')}`;
    let png = sharp(picture.data, { raw: { width: picture.width, height: picture.height, channels: 4 } });
    if (!picture.transparent) png = png.removeAlpha();
    const pngFile = path.join(out, `${name}.png`);
    await png.resize({ width: Math.min(720, picture.width), kernel: 'lanczos3' }).png({ compressionLevel: 6 }).toFile(pngFile);
    const sheet = await writeSheet(path.join(out, `${name}.sheet.png`), [{ label: `${name} · ${kind} · ${treated.method}${treated.reason ? ' · ' + treated.reason : ''}`, file: pngFile, transparent: picture.transparent, background: picture.background }]);
    console.log(`${treated.transparent ? '✓' : '·'} ${name}  ${kind}  ${treated.method}  ${picture.width}×${picture.height}  ${((performance.now() - started) / 1000).toFixed(1)}s  ${treated.reason ?? ''}`);
    const gate = opaqueGate(kind, treated, flags.opaque === true);
    console.log(`  opaque-photo gate: ${gate.verdict}${gate.why ? ` — ${gate.why}` : ''}`);
    console.log(`  ${JSON.stringify(treated.stats)}`);
    console.log(`  ${rel(pngFile)}   sheet ${rel(sheet)}`);
  }
}

/* ── main ─────────────────────────────────────────────────────────────────── */

async function main() {
  if (flags['opaque-report']) {
    await opaqueReport();
    return;
  }
  if (flags.try) {
    const kind = flags.kind ?? 'hero';
    if (!PHOTO_KINDS.includes(kind)) throw new Error(`--kind must be one of ${PHOTO_KINDS.join(', ')}`);
    await tryFiles(list(flags.try), kind);
    return;
  }

  const only = flags.only && flags.only !== true ? list(flags.only) : null;
  const { jobs, parsed, problems } = await readCatalog(only, await readOptions());
  for (const problem of problems) console.warn(`! ${problem}`);
  if (!jobs.length) console.log('No images to process.');

  const started = performance.now();
  const failures = [];
  const results = await pool(jobs, Math.max(1, Number(flags.jobs) || 2), async (job) => {
    try {
      const result = await processImage(job);
      console.log(describe(result));
      return result;
    } catch (error) {
      failures.push(job.key);
      console.error(`✗ ${job.key}: ${String(error?.message ?? error).split('\n')[0]}`);
      return null;
    }
  });

  const removed = await prune(parsed, new Set(jobs.map((job) => job.key)), only);
  for (const key of removed) console.log(`- ${key}: no longer in the catalogue, manifest and files removed`);

  // Review sheets, from the files that are actually published.
  if (!flags['no-sheet']) {
    const bySlug = new Map();
    for (const result of results) if (result) bySlug.set(result.job.slug, [...(bySlug.get(result.job.slug) ?? []), result]);
    await fs.mkdir(path.join(CACHE, '_sheets'), { recursive: true });
    for (const [slug, items] of bySlug) {
      if (items.every((item) => item.status !== 'built') && existsSync(path.join(CACHE, '_sheets', `${slug}.png`))) continue;
      const rows = items.sort((a, b) => a.job.n - b.job.n).map(({ job, manifest, treated }) => ({
        label: `${job.key} · ${job.kind} · ${treated?.method ?? (manifest.transparent ? 'transparent' : 'opaque')}${treated?.reason ? ' · ' + treated.reason : ''}`,
        file: reviewFile(manifest),
        transparent: manifest.transparent,
        background: manifest.background,
      }));
      await writeSheet(path.join(CACHE, '_sheets', `${slug}.png`), rows);
    }
  }

  // What was decided, for review (only the images built in this run carry treatment details).
  const reportFile = path.join(CACHE, '_report.json');
  let report = {};
  try { report = JSON.parse(await fs.readFile(reportFile, 'utf8')); } catch { /* first run */ }
  for (const key of removed) delete report[key];
  for (const result of results) {
    if (!result || result.status !== 'built') continue;
    report[result.job.key] = {
      kind: result.job.kind, method: result.treated.method, transparent: result.treated.transparent, reason: result.treated.reason,
      background: result.treated.background, size: [result.manifest.width, result.manifest.height],
      source: { format: result.decoded.format, ...result.decoded.source }, options: result.job.options, stats: result.treated.stats,
      gate: result.gate ? { verdict: result.gate.verdict, deltaE: result.gate.deltaE === null ? null : +result.gate.deltaE.toFixed(2), niche: NICHE } : null,
    };
  }
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(Object.fromEntries(Object.entries(report).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');

  const built = results.filter((r) => r?.status === 'built');
  const cut = built.filter((r) => r.treated.method === 'cutout').length;
  console.log(`\n${jobs.length} image${jobs.length === 1 ? '' : 's'}: ${built.length} built (${cut} cut out), ${results.filter((r) => r && r.status !== 'built').length} up to date, ${failures.length} failed — ${((performance.now() - started) / 1000).toFixed(1)}s`);
  const grandfathered = built.filter((r) => r.gate?.verdict === 'grandfathered').length;
  const accepted = built.filter((r) => r.gate?.verdict === 'accepted').length;
  if (grandfathered || accepted) console.log(`opaque-photo gate: ${grandfathered} grandfathered (published opaque before the gate: re-cut them), ${accepted} accepted — the list: --opaque-report`);
  if (!flags['no-sheet'] && built.length) console.log(`sheets  ${rel(path.join(CACHE, '_sheets'))}/<slug>.png   report  ${rel(reportFile)}`);
  if (failures.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0), (error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
