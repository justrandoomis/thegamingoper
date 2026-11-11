#!/usr/bin/env node
/**
 * TamTam clay renders — build pipeline.
 *
 *   node scripts/art/build.mjs                       render every catalogue key that has a model
 *   node scripts/art/build.mjs --only=switch-2,ps5-slim
 *   node scripts/art/build.mjs --only=switch-2 --views=hero --draft     quick look, nothing published
 *   node scripts/art/build.mjs --list                which keys have a model / a render
 *   node scripts/art/build.mjs --serve               serve render.html for a live look in a browser
 *
 * For each key / view it renders scripts/art/models/<key>.mjs in headless Chrome or Edge (WebGL,
 * see kit.mjs), keeps the 1600 px master in scripts/art/.masters/, trims it to the object plus
 * padding and writes
 *   public/art/<name>-<width>.<hash>.{avif,webp}     widths 240 · 480 · 720 · 960 · 1440 (never upscaled)
 *   public/art/<name>-720.<hash>.png                 fallback
 *   app/art/manifest/<name>.json                     what <Art> reads
 * where <name> is the key for the hero view and "<key>--<view>" for the others.
 * It also writes scripts/art/.masters/<key>.sheet.png — every view on a light and a dark
 * backdrop plus 240 px and 120 px thumbnails. Look at that sheet after every change.
 *
 * Flags: --only=a,b  --views=hero,front  --samples=256  --size=1600  --draft  --no-sheet
 *        --gl=default|d3d11|gl|swiftshader  --list  --serve[=port]
 */
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { expectedAspect, FILL, VIEWS } from './kit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ART = path.join(ROOT, 'scripts', 'art');
const MODELS = path.join(ART, 'models');
const MASTERS = path.join(ART, '.masters');
const PUBLIC = path.join(ROOT, 'public', 'art');
const MANIFESTS = path.join(ROOT, 'app', 'art', 'manifest');

const WIDTHS = [240, 480, 720, 960, 1440];
const PNG_WIDTH = 720;
const PLACEHOLDER_WIDTH = 24;
/** Game cases have no entry of their own in catalog.json; sizes come from its "games._about". */
const GAME_CASE_MM = { nintendo: [105, 170, 11], playstation: [135, 171, 14], xbox: [135, 171, 14] };

const flags = {};
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) { console.error(`Unexpected argument "${arg}". Flags look like --only=switch-2.`); process.exit(2); }
  const i = arg.indexOf('=');
  if (i < 0) flags[arg.slice(2)] = true; else flags[arg.slice(2, i)] = arg.slice(i + 1);
}
const draft = !!flags.draft;
const SIZE = +(flags.size ?? (draft ? 800 : 1600));
const list = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/* ── catalogue and models ─────────────────────────────────────────────────── */

async function readCatalog() {
  const catalog = JSON.parse(await fs.readFile(path.join(ART, 'catalog.json'), 'utf8'));
  const items = new Map();
  for (const item of catalog.items) items.set(item.key, item);
  for (const game of catalog.games.items) {
    const key = `game-${game.slug}`;
    items.set(key, { key, group: 'game', views: ['hero'], mm: GAME_CASE_MM[game.platform], title: game.title, platform: game.platform, notes: catalog.games._about });
  }
  return { catalog, items };
}

/**
 * Model files are found by name, there is no registry to edit:
 *   models/switch-2.mjs            the key "switch-2"
 *   models/dualsense-[colour].mjs  every key "dualsense-<something>" that has no file of its own;
 *                                  build() receives options.params.colour
 *   models/_anything.mjs           helpers and test scenes; never matched by a catalogue key
 */
async function readModels() {
  const exact = new Map(), families = [];
  for (const file of (existsSync(MODELS) ? await fs.readdir(MODELS) : []).sort()) {
    if (!file.endsWith('.mjs')) continue;
    const name = file.slice(0, -4);
    const family = /^(.+-)\[([a-z][a-zA-Z0-9]*)\]$/.exec(name);
    if (family) families.push({ prefix: family[1], param: family[2], file });
    else exact.set(name, file);
  }
  families.sort((a, b) => b.prefix.length - a.prefix.length);
  return (key) => {
    if (exact.has(key)) return { file: exact.get(key), params: {} };
    if (key.startsWith('_')) return null;
    const family = families.find((f) => key.startsWith(f.prefix) && key.length > f.prefix.length);
    return family ? { file: family.file, params: { [family.param]: key.slice(family.prefix.length) } } : null;
  };
}

const fileName = (key, view) => (view === 'hero' ? key : `${key}--${view}`);

/* ── static server for the render page ────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
};
/** Only what the render page needs — never the repository root (it holds .dev.vars). */
const SERVED = ['/scripts/art/', '/node_modules/three/', '/public/fonts/'];

async function startServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      const allowed = (req.method === 'GET' || req.method === 'HEAD') && SERVED.some((prefix) => pathname.startsWith(prefix)) && !pathname.split('/').some((part) => part.startsWith('.'));
      const file = path.resolve(ROOT, '.' + pathname);
      if (!allowed || !file.startsWith(ROOT + path.sep)) { res.writeHead(404).end('not found'); return; }
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/* ── browser ──────────────────────────────────────────────────────────────── */

function findBrowser() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    local && local + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found. Set CHROME_PATH to a Chromium-based browser.');
  return found;
}

/** WebGL in headless mode: the plain launch first, then explicit ANGLE back ends, software last. */
const GL_ATTEMPTS = [
  { name: 'default', args: [] },
  { name: 'd3d11', args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'], platform: 'win32' },
  { name: 'gl', args: ['--use-gl=angle', '--enable-gpu', '--ignore-gpu-blocklist'] },
  { name: 'swiftshader', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
];
const BASE_ARGS = ['--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];

function watch(page, label) {
  page.on('pageerror', (error) => console.error(`  [page error] ${label}: ${error.message}`));
  page.on('console', (message) => {
    const type = message.type(), text = message.text();
    if (text.includes('GPU stall due to ReadPixels')) return; // every read-back says so on software GL
    if (type === 'error' || type === 'warn' || type === 'warning') console.error(`  [page ${type}] ${label}: ${text}`);
  });
}

async function launch(origin) {
  const executablePath = findBrowser();
  const attempts = flags.gl ? GL_ATTEMPTS.filter((a) => a.name === flags.gl) : GL_ATTEMPTS.filter((a) => !a.platform || a.platform === process.platform);
  if (!attempts.length) throw new Error(`--gl must be one of ${GL_ATTEMPTS.map((a) => a.name).join(', ')}`);
  let fallback = null;
  const problems = [];
  for (const attempt of attempts) {
    // Own profile folder: the browser can then simply be killed at the end (a polite close takes
    // Edge about ten seconds) and the folder is swept up in the background.
    const session = { browser: null, attempt, info: null, executablePath, profile: path.join(os.tmpdir(), `tamtam-art-${process.pid}-${attempt.name}`) };
    try {
      session.browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 0, userDataDir: session.profile, args: [...BASE_ARGS, ...attempt.args] });
      const page = await session.browser.newPage();
      await page.goto(`${origin}/scripts/art/render.html`, { waitUntil: 'load' });
      session.info = await page.evaluate(() => window.tamtamArt.info());
      await page.close();
      if (!session.info.software || flags.gl) { if (fallback) await shutdown(fallback); return session; }
      if (fallback) await shutdown(session); else fallback = session; // software works; keep looking for a GPU
    } catch (error) {
      problems.push(`${attempt.name}: ${String(error.message).split('\n')[0]}`);
      await shutdown(session);
    }
  }
  if (fallback) return fallback;
  throw new Error(`Could not get a WebGL2 context with float render targets in ${executablePath}.\n  ${problems.join('\n  ')}`);
}

async function shutdown(session) {
  const child = session.browser?.process();
  if (child && child.exitCode === null) {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); setTimeout(resolve, 5000).unref(); });
  }
  const sweep = `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(session.profile)}, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }), 1000)`;
  spawn(process.execPath, ['-e', sweep], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/* ── image work ───────────────────────────────────────────────────────────── */

/**
 * Trim the square master to the finished picture: the object in the middle with padding around
 * it so that its larger side fills FILL of the picture. The contact shadow lives in that
 * padding; only a shadow larger than the padding widens the picture (evenly, so the object
 * stays centred). `bounds` comes from the stage: pixel boxes of the object and of object + shadow.
 */
function trim(raw, size, bounds) {
  const o = bounds.object, s = bounds.all;
  if (!o || !s) throw new Error('the render is empty');
  const touches = s.minX <= 0 || s.minY <= 0 || s.maxX >= size || s.maxY >= size;
  const cx = (o.minX + o.maxX) / 2, cy = (o.minY + o.maxY) / 2;
  const objectWidth = o.maxX - o.minX, objectHeight = o.maxY - o.minY;
  const pad = (Math.max(objectWidth, objectHeight) * (1 - FILL)) / (2 * FILL);
  const halfWidth = Math.max(objectWidth / 2 + pad, cx - s.minX + 1, s.maxX - cx + 1);
  const halfHeight = Math.max(objectHeight / 2 + pad, cy - s.minY + 1, s.maxY - cy + 1);
  const width = Math.round(2 * halfWidth), height = Math.round(2 * halfHeight);
  const out = Buffer.alloc(width * height * 4);
  const x0 = Math.round(cx - halfWidth), y0 = Math.round(cy - halfHeight);
  const from = Math.max(x0, 0), to = Math.min(x0 + width, size);
  for (let y = 0; y < height; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= size) continue;
    raw.copy(out, (y * width + (from - x0)) * 4, (sy * size + from) * 4, (sy * size + to) * 4);
  }
  return { data: out, width, height, touches };
}

/** The most common solid colour of the object (coarse histogram), as #rrggbb. */
function dominantColor(data) {
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) continue;
    const bin = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    let b = bins.get(bin);
    if (!b) bins.set(bin, (b = [0, 0, 0, 0]));
    b[0]++; b[1] += data[i]; b[2] += data[i + 1]; b[3] += data[i + 2];
  }
  let best = null;
  for (const b of bins.values()) if (!best || b[0] > best[0]) best = b;
  if (!best) return '#808080';
  return '#' + [1, 2, 3].map((c) => Math.round(best[c] / best[0]).toString(16).padStart(2, '0')).join('');
}

async function writeIfChanged(file, content) {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try {
    if (next.equals(await fs.readFile(file))) return false;
  } catch { /* new file */ }
  await fs.writeFile(file, next);
  return true;
}

/** Variants + manifest for one trimmed picture. */
async function publish(key, view, picture) {
  const name = fileName(key, view);
  const { data, width, height } = picture;
  const image = () => sharp(data, { raw: { width, height, channels: 4 } });
  const widths = WIDTHS.filter((w) => w <= width);
  if (!widths.length) widths.push(width);
  const files = new Map();
  const add = (w, ext, buffer) => {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);
    const file = `${name}-${w}.${hash}.${ext}`;
    files.set(file, buffer);
    return { w, src: `/art/${file}` };
  };
  const resized = (w) => (w === width ? image() : image().resize({ width: w, kernel: 'lanczos3' }));
  const [avif, webp, png, placeholder] = await Promise.all([
    Promise.all(widths.map(async (w) => add(w, 'avif', await resized(w).avif({ quality: 62, effort: 6, chromaSubsampling: '4:4:4' }).toBuffer()))),
    Promise.all(widths.map(async (w) => add(w, 'webp', await resized(w).webp({ quality: 84, alphaQuality: 92, effort: 5, smartSubsample: true }).toBuffer()))),
    (async () => { const w = Math.min(PNG_WIDTH, width); return add(w, 'png', await resized(w).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()); })(),
    image().resize({ width: PLACEHOLDER_WIDTH }).webp({ quality: 32, alphaQuality: 50, effort: 6, smartSubsample: true }).toBuffer(),
  ]);

  // Order matters for anyone reading while we write (the dev server, the tests, another build):
  // new files first, then the manifest that points at them, and only then the files it replaced.
  await fs.mkdir(PUBLIC, { recursive: true });
  await fs.mkdir(MANIFESTS, { recursive: true });
  let bytes = 0;
  for (const [file, buffer] of files) { bytes += buffer.length; await writeIfChanged(path.join(PUBLIC, file), buffer); }

  const manifest = {
    key, view, width, height,
    aspect: +(width / height).toFixed(4),
    variants: { avif, webp, png: png.src },
    placeholder: `data:image/webp;base64,${placeholder.toString('base64')}`,
    dominant: dominantColor(data),
  };
  await writeIfChanged(path.join(MANIFESTS, `${name}.json`), JSON.stringify(manifest, null, 2) + '\n');

  const stale = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.[0-9a-f]{8}\\.(avif|webp|png)$`);
  for (const existing of await fs.readdir(PUBLIC)) {
    if (stale.test(existing) && !files.has(existing)) await fs.rm(path.join(PUBLIC, existing), { force: true });
  }
  return { manifest, bytes, files: files.size };
}

/** One contact sheet per key: each view on light and dark, plus the sizes shoppers actually see. */
async function writeSheet(key, pictures) {
  const cell = 560, side = 300, light = '#f3efe9', dark = '#17181b';
  const fit = async (picture, box) => {
    const { data, info } = await sharp(picture.data, { raw: { width: picture.width, height: picture.height, channels: 4 } })
      .resize({ width: box, height: box, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
    return { input: data, width: info.width, height: info.height };
  };
  const panel = (width, height, background) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
  const layers = [];
  const place = (img, left, top, width, height) => layers.push({ input: img.input, left: Math.round(left + (width - img.width) / 2), top: Math.round(top + (height - img.height) / 2) });
  for (const [row, picture] of pictures.entries()) {
    const top = row * cell;
    layers.push({ input: await panel(cell, cell, dark), left: cell, top });
    layers.push({ input: await panel(side / 2, cell - 300, dark), left: cell * 2 + side / 2, top: top + 300 });
    const big = await fit(picture, cell - 48);
    place(big, 0, top, cell, cell);
    place(big, cell, top, cell, cell);
    place(await fit(picture, 240), cell * 2, top, side, 300);
    const small = await fit(picture, 120);
    place(small, cell * 2, top + 300, side / 2, cell - 300);
    place(small, cell * 2 + side / 2, top + 300, side / 2, cell - 300);
  }
  const file = path.join(MASTERS, `${key}.sheet.png`);
  await sharp({ create: { width: cell * 2 + side, height: cell * pictures.length, channels: 4, background: light } }).composite(layers).png({ compressionLevel: 6 }).toFile(file);
  return file;
}

/**
 * Proportions are the point of these renders: say how big the model came out next to the
 * catalogue, and complain when width or height is off. Depth may differ — the catalogue gives
 * the body, a model also has sticks, triggers and feet.
 */
function reportSize(job, sizeMm) {
  const mm = job.item?.mm;
  const text = sizeMm.map((n) => +n.toFixed(1)).join(' × ');
  if (!mm) { console.log(`  size   ${text} mm`); return; }
  const off = [0, 1].filter((axis) => Math.abs(sizeMm[axis] / mm[axis] - 1) > 0.06);
  console.log(`  size   ${text} mm   (catalogue ${mm.join(' × ')})`);
  if (off.length) console.warn(`  ! ${job.key}: ${off.map((axis) => ['width', 'height'][axis]).join(' and ')} differ from the catalogue by more than 6% — check the proportions`);
}

/** All finished hero pictures side by side, on light and dark: the check that the set is one family. */
async function writeFamily() {
  const heroes = [];
  for (const file of (existsSync(MANIFESTS) ? await fs.readdir(MANIFESTS) : []).sort()) {
    if (!file.endsWith('.json') || file.startsWith('_') || file.includes('--')) continue;
    const manifest = JSON.parse(await fs.readFile(path.join(MANIFESTS, file), 'utf8'));
    const variant = manifest.variants.webp.find((v) => v.w >= 480) ?? manifest.variants.webp.at(-1);
    heroes.push({ key: manifest.key, file: path.join(ROOT, 'public', variant.src) });
  }
  if (!heroes.length) return null;
  const cell = 300, columns = Math.min(6, heroes.length), rows = Math.ceil(heroes.length / columns);
  const layers = [{ input: await sharp({ create: { width: cell * columns, height: cell * rows, channels: 4, background: '#17181b' } }).png().toBuffer(), left: 0, top: cell * rows }];
  for (const [i, hero] of heroes.entries()) {
    const { data, info } = await sharp(hero.file).resize({ width: cell - 36, height: cell - 36, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
    const left = (i % columns) * cell + Math.round((cell - info.width) / 2), top = Math.floor(i / columns) * cell + Math.round((cell - info.height) / 2);
    layers.push({ input: data, left, top }, { input: data, left, top: top + cell * rows });
  }
  await fs.mkdir(MASTERS, { recursive: true });
  const file = path.join(MASTERS, '_family.png');
  await sharp({ create: { width: cell * columns, height: cell * rows * 2, channels: 4, background: '#f3efe9' } }).composite(layers).png({ compressionLevel: 6 }).toFile(file);
  return file;
}

/** Aspect ratios the storefront can reserve for art that has no render yet. */
async function writeExpected(items) {
  const expected = {};
  for (const [key, item] of [...items].sort(([a], [b]) => a.localeCompare(b))) {
    for (const view of item.views ?? ['hero']) {
      if (!VIEWS[view] || !item.mm) continue;
      expected[fileName(key, view).replace('--', '@')] = +expectedAspect(item.mm, view).toFixed(2);
    }
  }
  await fs.mkdir(MANIFESTS, { recursive: true });
  return writeIfChanged(path.join(MANIFESTS, '_expected.json'), JSON.stringify(expected, null, 2) + '\n');
}

/* ── main ─────────────────────────────────────────────────────────────────── */

async function main() {
  const { catalog, items } = await readCatalog();
  const modelFor = await readModels();

  if (flags.serve) {
    const { origin } = await startServer(flags.serve === true ? 0 : +flags.serve);
    console.log(`Render page: ${origin}/scripts/art/render.html?key=<key>&view=hero&size=900&samples=64   (Ctrl+C to stop)`);
    await new Promise(() => {}); // keep serving
  }

  if (flags.list) {
    for (const [key, item] of items) {
      const model = modelFor(key);
      const rendered = (item.views ?? ['hero']).filter((view) => existsSync(path.join(MANIFESTS, `${fileName(key, view)}.json`)));
      console.log(`${key.padEnd(34)} ${(item.views ?? ['hero']).join(',').padEnd(16)} ${model ? 'model: ' + model.file : 'no model'}${rendered.length ? '   rendered: ' + rendered.join(',') : ''}`);
    }
    return;
  }

  const wanted = flags.only ? list(flags.only) : [...items.keys()].filter((key) => modelFor(key));
  const viewFilter = flags.views ? list(flags.views) : null;
  const jobs = [];
  for (const key of wanted) {
    const model = modelFor(key);
    if (!model) { console.error(`✗ ${key}: no model file (expected scripts/art/models/${key}.mjs)`); process.exitCode = 1; continue; }
    const item = items.get(key) ?? null;
    if (!item && !key.startsWith('_')) console.warn(`! ${key} is not in catalog.json — rendering its hero view only`);
    let views = item?.views ?? ['hero'];
    if (viewFilter) views = views.filter((view) => viewFilter.includes(view));
    jobs.push({ key, ...model, item, views, internal: key.startsWith('_') });
  }
  if (!draft && (await writeExpected(items))) console.log(`wrote ${rel(path.join(MANIFESTS, '_expected.json'))}`);
  if (!jobs.length) { console.log('Nothing to render.'); return; }

  await fs.mkdir(MASTERS, { recursive: true });
  const started = performance.now();
  const { server, origin } = await startServer();
  let session = null;
  const timings = [];
  try {
    session = await launch(origin);
    // Samples are cheap on a GPU (a second per thousand); on software each one costs real time.
    const samples = +(flags.samples ?? (session.info.software ? 48 : draft ? 96 : 256));
    console.log(`browser  ${path.basename(session.executablePath)} · flags: ${session.attempt.name}${session.attempt.args.length ? ' (' + session.attempt.args.join(' ') + ')' : ' (no extra flags)'}`);
    console.log(`gpu      ${session.info.gpu}${session.info.software ? '   — software rendering, this will be slow' : ''}`);
    console.log(`quality  ${SIZE} px · ${samples} samples · three r${session.info.three}${draft ? ' · DRAFT (nothing is published)' : ''}\n`);

    for (const job of jobs) {
      const page = await session.browser.newPage();
      watch(page, job.key);
      const pictures = [];
      try {
        await page.goto(`${origin}/scripts/art/render.html`, { waitUntil: 'load' });
        for (const view of job.views) {
          const t0 = performance.now();
          const shot = await page.evaluate((options) => window.tamtamArt.render(options), {
            key: job.key, file: job.file, params: job.params, view, size: SIZE, samples,
            item: job.item, platformColors: catalog.platformColors,
          });
          const raw = Buffer.from(shot.rgba, 'base64');
          if (raw.length !== SIZE * SIZE * 4) throw new Error(`expected ${SIZE * SIZE * 4} bytes from the page, got ${raw.length}`);
          const renderMs = performance.now() - t0;
          const name = fileName(job.key, view);
          await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path.join(MASTERS, `${name}.png`));
          const picture = trim(raw, SIZE, shot.bounds);
          if (picture.touches) console.warn(`  ! ${name}: the picture touches the edge of the frame — part of it may be cut off`);
          pictures.push(picture);
          const t1 = performance.now();
          let published = null;
          if (!draft && !job.internal) published = await publish(job.key, view, picture);
          const encodeMs = performance.now() - t1;
          timings.push({ name, renderMs, encodeMs });
          console.log(`✓ ${name.padEnd(30)} ${String(picture.width).padStart(4)}×${String(picture.height).padEnd(4)}  render ${(renderMs / 1000).toFixed(2)}s (gpu ${(shot.stats.ms / 1000).toFixed(2)}s, ${shot.stats.triangles.toLocaleString('en')} tris)`
            + (published ? `  encode ${(encodeMs / 1000).toFixed(2)}s  ${published.files} files ${(published.bytes / 1024).toFixed(0)} kB` : ''));
          if (pictures.length === 1) reportSize(job, shot.stats.sizeMm);
        }
        if (pictures.length && !flags['no-sheet']) console.log(`  sheet  ${rel(await writeSheet(job.key, pictures))}`);
      } catch (error) {
        process.exitCode = 1;
        console.error(`✗ ${job.key}: ${String(error.message).split('\n    at ')[0]}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    if (session) await shutdown(session);
    server.close();
    server.closeAllConnections?.();
  }
  if (!draft && !flags['no-sheet']) {
    const family = await writeFamily();
    if (family) console.log(`\nfamily   ${rel(family)}   (every finished hero picture, light and dark)`);
  }
  const total = (performance.now() - started) / 1000;
  const render = timings.reduce((sum, t) => sum + t.renderMs, 0) / 1000, encode = timings.reduce((sum, t) => sum + t.encodeMs, 0) / 1000;
  console.log(`\n${timings.length} picture${timings.length === 1 ? '' : 's'} in ${total.toFixed(1)}s (render ${render.toFixed(1)}s, encode ${encode.toFixed(1)}s)`);
}

// Everything is written by the time main() resolves; exit now instead of waiting for the killed
// browser's sockets to time out.
main().then(() => process.exit(process.exitCode ?? 0), (error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
