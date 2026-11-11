#!/usr/bin/env node
/**
 * TamTam product photos — from the researched originals to what the storefront serves.
 *
 *   node scripts/products/images.mjs                       every image of every catalog/products/*.json
 *   node scripts/products/images.mjs --only slug,slug      these products only (also --only=slug,slug)
 *   node scripts/products/images.mjs --force               rebuild even what is up to date
 *   node scripts/products/images.mjs --try a.png,b.jpg --kind=hero
 *                                                          run the treatment on any file and write a review
 *                                                          sheet to .cache/product-images/_try/ — publishes nothing
 *
 * Other flags: --no-sheet (skip review sheets) · --no-download (never fetch a missing original) ·
 * --jobs=N (images in parallel, default 2).
 *
 * For each entry of "images" in a catalogue file (key "<slug>--<n>", file, sourceUrl, sourcePage, kind,
 * credit) it reads the original from "file" — fetching it again from sourceUrl when it is missing —
 * and writes
 *   public/products/<slug>/<n>-<w>.<hash>.{avif,webp}   w = 240 · 480 · 720 · 960 · 1440, never wider than the picture
 *   public/products/<slug>/<n>-720.<hash>.png           fallback; it has an alpha channel exactly when the photo is transparent
 *   app/art/photos/<slug>--<n>.json                     manifest read by <Art> through app/art/index.ts
 *   .cache/product-images/_sheets/<slug>.png            review sheet: every image on the light and dark stage, edge zooms
 *   .cache/product-images/_report.json                  what was decided for every image, and why
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
 * Manifest = the clay-render manifest (app/art/index.ts ArtManifest, view "hero") plus
 *   transparent, background ("#rrggbb" | null), kind, credit, source { url, page }, and input — a hash
 *   of the original and of every treatment and encoder setting. An image whose manifest carries the
 *   same input hash and whose files all exist is skipped (only its credit / source are refreshed).
 * Output is deterministic and file names carry a hash of their content, so /products/* can be cached forever.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PHOTO_KINDS, TREATMENT_VERSION, treat } from './lib/cutout.mjs';
import { writeSheet } from './lib/sheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG = path.join(ROOT, 'catalog', 'products');
const PUBLIC = path.join(ROOT, 'public', 'products');
const MANIFESTS = path.join(ROOT, 'app', 'art', 'photos');
const CACHE = path.join(ROOT, '.cache', 'product-images');

const WIDTHS = [240, 480, 720, 960, 1440];
const PNG_WIDTH = 720;
const PLACEHOLDER_SIDE = 20;
/** The background treatment works at this size at most; finer detail does not survive publishing. */
const WORK_MAX = 2400;
/** Longest side of the published picture (its manifest width / height). */
const MASTER_MAX = 1600;
const ENCODE = {
  avif: { quality: 60, effort: 4, chromaSubsampling: '4:4:4' },
  webp: { quality: 82, alphaQuality: 90, effort: 5, smartSubsample: true },
  png: { compressionLevel: 9, adaptiveFiltering: true },
  placeholder: { quality: 30, alphaQuality: 40, effort: 6 },
};
const SETTINGS = JSON.stringify({ TREATMENT_VERSION, WORK_MAX, MASTER_MAX, WIDTHS, PNG_WIDTH, PLACEHOLDER_SIDE, ENCODE, sharp: sharp.versions.sharp, vips: sharp.versions.vips });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/* ── flags ────────────────────────────────────────────────────────────────── */

const flags = {};
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { console.error(`Unexpected argument "${arg}".`); process.exit(2); }
    const eq = arg.indexOf('=');
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (['only', 'try', 'kind', 'jobs'].includes(arg.slice(2)) && args[i + 1] && !args[i + 1].startsWith('--')) flags[arg.slice(2)] = args[++i];
    else flags[arg.slice(2)] = true;
  }
}
const list = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const KEY = /^([a-z0-9]+(?:-[a-z0-9]+)*)--(\d+)$/;

/* ── catalogue ────────────────────────────────────────────────────────────── */

/** Every image entry of the catalogue files we were asked for, plus the slugs that parsed. */
async function readCatalog(only) {
  const jobs = [], parsed = new Set(), problems = [];
  const files = existsSync(CATALOG) ? (await fs.readdir(CATALOG)).filter((f) => f.endsWith('.json')).sort() : [];
  for (const file of files) {
    const slug = file.slice(0, -5);
    if (only && !only.includes(slug)) continue;
    let product;
    try {
      product = JSON.parse(await fs.readFile(path.join(CATALOG, file), 'utf8'));
    } catch (error) {
      problems.push(`${file}: ${error.message} — skipped (is it still being written?)`);
      continue;
    }
    parsed.add(slug);
    for (const [index, image] of (Array.isArray(product.images) ? product.images : []).entries()) {
      const where = `${slug} images[${index}]`;
      const match = KEY.exec(image?.key ?? '');
      if (!match || match[1] !== slug) { problems.push(`${where}: key "${image?.key}" must be "${slug}--<n>"`); continue; }
      if (!PHOTO_KINDS.includes(image.kind)) { problems.push(`${where}: kind "${image.kind}" must be one of ${PHOTO_KINDS.join(' | ')}`); continue; }
      if (!image.file && !image.sourceUrl) { problems.push(`${where}: neither "file" nor "sourceUrl"`); continue; }
      jobs.push({
        key: image.key, slug, n: Number(match[2]), kind: image.kind,
        file: image.file ? path.resolve(ROOT, image.file) : path.join(CACHE, slug, `${match[2]}.bin`),
        credit: String(image.credit ?? '').trim(),
        source: { url: image.sourceUrl ?? null, page: image.sourcePage ?? null },
      });
    }
  }
  for (const slug of only ?? []) if (!files.includes(`${slug}.json`)) problems.push(`${slug}: no catalog/products/${slug}.json`);
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

/** Decode, orient, convert to sRGB, cap the size: RGBA, 8 bits, straight alpha. */
async function decode(bytes) {
  const meta = await sharp(bytes, { failOn: 'none' }).metadata();
  const density = meta.format === 'svg' ? Math.min(2400, Math.max(72, Math.round((72 * WORK_MAX) / Math.max(meta.width ?? 1, meta.height ?? 1)))) : undefined;
  const { data, info } = await sharp(bytes, { failOn: 'none', density })
    .rotate()
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
    key: job.key, view: 'hero',
    width: files.width, height: files.height, aspect: +(files.width / files.height).toFixed(4),
    variants: files.variants,
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

/** Variants, placeholder and manifest for one treated picture; stale files of the same image go. */
async function publish(job, picture, input) {
  const { width, height, transparent } = picture;
  const image = () => {
    const s = sharp(picture.data, { raw: { width, height, channels: 4 } });
    return transparent ? s : s.removeAlpha();
  };
  const resized = (w) => (w === width ? image() : image().resize({ width: w, kernel: 'lanczos3' }));
  const widths = WIDTHS.filter((w) => w <= width);
  if (!widths.length) widths.push(width);
  const dir = path.join(PUBLIC, job.slug);
  const files = new Map();
  const add = (w, ext, buffer) => {
    const file = `${job.n}-${w}.${sha(buffer)}.${ext}`;
    files.set(file, buffer);
    return { w, src: `/products/${job.slug}/${file}` };
  };
  const side = width >= height ? { width: PLACEHOLDER_SIDE } : { height: PLACEHOLDER_SIDE };
  const [avif, webp, png, placeholder] = await Promise.all([
    Promise.all(widths.map(async (w) => add(w, 'avif', await resized(w).avif(ENCODE.avif).toBuffer()))),
    Promise.all(widths.map(async (w) => add(w, 'webp', await resized(w).webp(ENCODE.webp).toBuffer()))),
    (async () => { const w = Math.min(PNG_WIDTH, width); return add(w, 'png', await resized(w).png(ENCODE.png).toBuffer()); })(),
    image().resize({ ...side, kernel: 'lanczos3' }).webp(ENCODE.placeholder).toBuffer(),
  ]);

  // New files first, then the manifest that points at them, then the files it replaced.
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(MANIFESTS, { recursive: true });
  let bytes = 0;
  for (const [file, buffer] of files) { bytes += buffer.length; await writeIfChanged(path.join(dir, file), buffer); }
  const manifest = manifestOf(job, {
    width, height, transparent, background: picture.background, dominant: picture.dominant,
    variants: { avif, webp, png: png.src },
    placeholder: `data:image/webp;base64,${placeholder.toString('base64')}`,
  }, input);
  await writeIfChanged(path.join(MANIFESTS, `${job.key}.json`), JSON.stringify(manifest, null, 2) + '\n');
  const mine = new RegExp(`^${job.n}-\\d+\\.[0-9a-f]{8}\\.(avif|webp|png)$`);
  for (const existing of await fs.readdir(dir)) {
    if (mine.test(existing) && !files.has(existing)) await fs.rm(path.join(dir, existing), { force: true });
  }
  return { manifest, bytes, files: files.size };
}

function referencedFiles(manifest) {
  return [...manifest.variants.avif, ...manifest.variants.webp].map((v) => v.src).concat(manifest.variants.png);
}

async function readManifest(key) {
  try {
    return JSON.parse(await fs.readFile(path.join(MANIFESTS, `${key}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** Manifests (and their files) of images that are no longer in the catalogue. */
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
  // Files nobody points at (an interrupted run), and empty product folders.
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

  const input = sha(Buffer.concat([Buffer.from(`${SETTINGS}|${job.kind}|`), bytes]), 16);
  const previous = await readManifest(job.key);
  if (!flags.force && previous?.input === input && referencedFiles(previous).every((src) => existsSync(path.join(ROOT, 'public', src)))) {
    const refreshed = { ...previous, kind: job.kind, credit: job.credit, source: { url: job.source.url, page: job.source.page } };
    const changed = await writeIfChanged(path.join(MANIFESTS, `${job.key}.json`), JSON.stringify(refreshed, null, 2) + '\n');
    return { job, status: changed ? 'refreshed' : 'current', manifest: refreshed };
  }

  const started = performance.now();
  const decoded = await decode(bytes);
  const treated = treat(decoded, { kind: job.kind });
  const picture = await master(treated);
  const published = await publish(job, picture, input);
  return { job, status: 'built', manifest: published.manifest, treated, decoded, files: published.files, bytes: published.bytes, ms: performance.now() - started };
}

function describe(result) {
  const { job, treated, manifest } = result;
  const kind = job.kind.padEnd(10);
  if (result.status !== 'built') return `= ${job.key.padEnd(52)} ${kind} ${manifest.transparent ? 'transparent' : 'opaque'}   ${result.status === 'refreshed' ? '(credit/source refreshed)' : 'up to date'}`;
  const s = treated.stats ?? {};
  const facts = treated.method === 'cutout'
    ? `tolerance ${s.tolerance} · floor ${s.floor} · object ${Math.round((s.foreground ?? 0) * 100)}% · faint outline ${Math.round((s.weakOutline ?? 0) * 100)}%`
    : treated.reason ?? '';
  const size = `${manifest.width}×${manifest.height}`.padEnd(10);
  return `${treated.transparent ? '✓' : '·'} ${job.key.padEnd(52)} ${kind} ${treated.method.padEnd(9)} ${size} ${String(result.files).padStart(2)} files ${(result.bytes / 1024).toFixed(0).padStart(5)} kB  ${(result.ms / 1000).toFixed(1)}s  ${facts}`;
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
  for (const file of files) {
    const started = performance.now();
    const decoded = await decode(await fs.readFile(path.resolve(file)));
    const treated = treat(decoded, { kind });
    const picture = await master(treated);
    const name = `${path.basename(path.dirname(path.resolve(file)))}-${path.basename(file).replace(/\.[^.]+$/, '')}`;
    const pngWidth = Math.min(PNG_WIDTH, picture.width);
    let png = sharp(picture.data, { raw: { width: picture.width, height: picture.height, channels: 4 } });
    if (!picture.transparent) png = png.removeAlpha();
    const pngFile = path.join(out, `${name}.png`);
    await png.resize({ width: pngWidth, kernel: 'lanczos3' }).png(ENCODE.png).toFile(pngFile);
    const sheet = await writeSheet(path.join(out, `${name}.sheet.png`), [{ label: `${name} · ${kind} · ${treated.method}${treated.reason ? ' · ' + treated.reason : ''}`, file: pngFile, transparent: picture.transparent, background: picture.background }]);
    console.log(`${treated.transparent ? '✓' : '·'} ${name}  ${kind}  ${treated.method}  ${picture.width}×${picture.height}  ${((performance.now() - started) / 1000).toFixed(1)}s  ${treated.reason ?? ''}`);
    console.log(`  ${JSON.stringify(treated.stats)}`);
    console.log(`  ${rel(pngFile)}   sheet ${rel(sheet)}`);
  }
}

/* ── main ─────────────────────────────────────────────────────────────────── */

async function main() {
  if (flags.try) {
    const kind = flags.kind ?? 'hero';
    if (!PHOTO_KINDS.includes(kind)) throw new Error(`--kind must be one of ${PHOTO_KINDS.join(', ')}`);
    await tryFiles(list(flags.try), kind);
    return;
  }

  const only = flags.only && flags.only !== true ? list(flags.only) : null;
  const { jobs, parsed, problems } = await readCatalog(only);
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
        file: path.join(ROOT, 'public', manifest.variants.png),
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
      source: { format: result.decoded.format, ...result.decoded.source }, stats: result.treated.stats,
    };
  }
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(Object.fromEntries(Object.entries(report).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');

  const built = results.filter((r) => r?.status === 'built');
  const cut = built.filter((r) => r.treated.method === 'cutout').length;
  console.log(`\n${jobs.length} image${jobs.length === 1 ? '' : 's'}: ${built.length} built (${cut} cut out), ${results.filter((r) => r && r.status !== 'built').length} up to date, ${failures.length} failed — ${((performance.now() - started) / 1000).toFixed(1)}s`);
  if (!flags['no-sheet'] && built.length) console.log(`sheets  ${rel(path.join(CACHE, '_sheets'))}/<slug>.png   report  ${rel(reportFile)}`);
  if (failures.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0), (error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
