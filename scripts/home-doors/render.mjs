// Renders the doors with the GPU path tracer (three-gpu-pathtracer) in headless Chrome, then composites a real
// contact shadow from the floor passes. Outputs transparent WebP (800×600) plus inspection PNGs and sheets.
//
// node render.mjs [--keys a,b] [--langs ar,en,ckb] [--final] [--spp N] [--shadow-spp N] [--out DIR] [--size WxH]
//                 [--no-sheets] [--passes]
// Default is a quick preview (1200×900, 160 spp); --final is 1600×1200 at 640 spp.
import http from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TAMTAM = "C:/Users/levon/tamtam";
const require = createRequire(TAMTAM + "/package.json");
const puppeteer = require("puppeteer-core");
const sharp = require("sharp");

// ───────────────────────────── arguments
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const out = path.resolve(opt("out", path.join(here, "out")));
const langs = opt("langs", "ar").split(",");
const keysArg = opt("keys", "");
// presets: --preview (quick look while modelling) and --final (the pictures the site ships)
const preset = flag("final") ? { spp: "640", shadow: "128", size: "1600x1200" } : { spp: "160", shadow: "48", size: "1200x900" };
const spp = Number(opt("spp", preset.spp));
const shadowSpp = Number(opt("shadow-spp", preset.shadow));
const [W, H] = opt("size", preset.size).split("x").map(Number);
mkdirSync(out, { recursive: true });

// ───────────────────────────── a tiny static server: the studio, its node_modules, the store's fonts
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = url.startsWith("/fonts/") ? path.join(TAMTAM, "public", url) : path.join(here, url === "/" ? "studio.html" : url);
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// ───────────────────────────── shadow compositing
const LIN = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
/** A raw grab from the page (premultiplied RGBA, bottom-up rows) → straight RGBA, top-down. */
function decodeGrab(g) {
  if (!g) return null;
  const src = Buffer.from(g.b64, "base64");
  const { w, h } = g;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sr = (h - 1 - y) * w * 4;
    const dr = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      const a = src[sr + x + 3];
      out[dr + x + 3] = a;
      if (a === 0) continue;
      const k = 255 / a;
      out[dr + x] = Math.min(255, Math.round(src[sr + x] * k));
      out[dr + x + 1] = Math.min(255, Math.round(src[sr + x + 1] * k));
      out[dr + x + 2] = Math.min(255, Math.round(src[sr + x + 2] * k));
    }
  }
  return { data: out, width: w, height: h };
}
const rawPng = (img) => sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer();
/** Three box blurs (≈ a gaussian), separable, on a Float32 image. */
function blur3(src, w, h, r) {
  let a = Float32Array.from(src);
  let t = new Float32Array(w * h);
  const pass = (from, to, horizontal) => {
    const lines = horizontal ? h : w;
    const len = horizontal ? w : h;
    const at = horizontal ? (line, k) => line * w + k : (line, k) => k * w + line;
    const norm = 1 / (2 * r + 1);
    for (let line = 0; line < lines; line++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += from[at(line, Math.min(len - 1, Math.max(0, k)))];
      for (let k = 0; k < len; k++) {
        to[at(line, k)] = acc * norm;
        const add = Math.min(len - 1, k + r + 1);
        const sub = Math.max(0, k - r);
        acc += from[at(line, add)] - from[at(line, sub)];
      }
    }
  };
  for (let i = 0; i < 3; i++) {
    pass(a, t, true);
    pass(t, a, false);
  }
  return a;
}
/**
 * The contact shadow = 1 − (floor lit with the object) / (floor alone), from the two shadow-table passes.
 * Three guards keep it from showing as a grey box on the page:
 *  - offset: the two passes can differ by a few percent overall (and the object takes a little of the dome from
 *    every floor point in view), so the ratio is normalised to the brightest floor at the frame's border;
 *  - noise: values under `noise` are treated as unshadowed floor;
 *  - edge fade: the shadow fades to nothing over the outer `fade` share of the frame.
 */
async function composite(beauty, litImg, bareImg, { strength = 0.8, gain = 1.35, blur = 2.4, noise = 0.05, fade = 0.06 } = {}) {
  const { width, height } = beauty;
  const b = beauty.data;
  if (!litImg || !bareImg) return rawPng(beauty);
  const l = litImg.data;
  const n = bareImg.data;
  const lum = (p, i) => 0.2126 * LIN[p[i * 4]] + 0.7152 * LIN[p[i * 4 + 1]] + 0.0722 * LIN[p[i * 4 + 2]];
  // the reference: the 80th percentile of lit/bare along the border (empty floor), clamped to a sane range
  const band = Math.max(4, Math.round(Math.min(width, height) * 0.03));
  const ratios = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue;
      const i = y * width + x;
      if (b[i * 4 + 3] > 3) continue;
      const ln = lum(n, i);
      if (ln > 1e-4) ratios.push(lum(l, i) / ln);
    }
  }
  ratios.sort((p, q) => p - q);
  const ref = ratios.length ? Math.min(1.05, Math.max(0.85, ratios[Math.floor(ratios.length * 0.8)])) : 1;
  // the raw ratio on the floor (object pixels masked out), denoised with a mask-aware blur before any threshold:
  // at a few dozen samples the far floor's noise alone crossed the threshold and left a faint grey box
  const N = width * height;
  const raw = new Float32Array(N);
  const mask = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (b[i * 4 + 3] > 3) continue;
    const lumN = lum(n, i);
    if (lumN < 1e-4) continue;
    raw[i] = 1 - lum(l, i) / ref / lumN;
    mask[i] = 1;
  }
  const radius = Math.max(2, Math.round(width / 320));
  const num = blur3(raw, width, height, radius);
  const den = blur3(mask, width, height, radius);
  const edge = Math.max(1, Math.min(width, height) * fade);
  const s = Buffer.alloc(N);
  for (let y = 0; y < height; y++) {
    const ey = Math.min(y, height - 1 - y);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i] || den[i] < 1e-3) continue;
      let v = num[i] / den[i];
      v = Math.min(1, Math.max(0, ((v - noise) / (1 - noise)) * gain));
      const t = Math.min(1, Math.min(x, width - 1 - x, ey) / edge);
      v *= t * t * (3 - 2 * t);
      s[i] = Math.round(v * 255);
    }
  }
  const sb = await sharp(s, { raw: { width, height, channels: 1 } }).blur(blur).extractChannel(0).raw().toBuffer();
  const o = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const ab = b[i * 4 + 3] / 255;
    const sh = (sb[i] / 255) * strength;
    const a = ab + sh * (1 - ab);
    if (a > 0) {
      o[i * 4] = Math.round((b[i * 4] * ab) / a);
      o[i * 4 + 1] = Math.round((b[i * 4 + 1] * ab) / a);
      o[i * 4 + 2] = Math.round((b[i * 4 + 2] * ab) / a);
    }
    o[i * 4 + 3] = Math.round(a * 255);
  }
  return sharp(o, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ───────────────────────────── render
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 0,
  userDataDir: path.join(here, ".chrome-profile"),
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-watchdog", "--hide-scrollbars", "--no-first-run", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
const made = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  await page.setViewport({ width: W, height: H });
  await page.goto(`http://127.0.0.1:${port}/?w=${W}&h=${H}`, { waitUntil: "load" });
  await page.waitForFunction("window.studioReady", { timeout: 60000 });
  await page.evaluate("window.studioReady");
  const gpu = await page.evaluate(() => {
    const gl = document.querySelector("canvas").getContext("webgl2");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?";
  });
  if (!/NVIDIA|AMD|Intel/i.test(gpu)) console.warn("WARNING: not on a hardware GPU:", gpu);
  const keys = keysArg ? keysArg.split(",") : await page.evaluate("window.DOORS");
  for (const lang of langs) {
    for (const key of keys) {
      const t0 = Date.now();
      let r;
      try {
        r = await page.evaluate((k, l, o) => window.renderDoor(k, l, o), key, lang, { spp, shadowSpp, bust: Date.now() });
      } catch (error) {
        console.log(`${key}.${lang}: FAILED — ${String(error.message || error).split("\n").slice(0, 6).join(" | ")}`);
        if (errors.length) console.log("browser errors:\n" + [...new Set(errors)].slice(-8).join("\n"));
        continue;
      }
      const tPage = Date.now() - t0;
      const beautyImg = decodeGrab(r.beauty);
      const litImg = decodeGrab(r.lit);
      const bareImg = decodeGrab(r.bare);
      const full = await composite(beautyImg, litImg, bareImg);
      const base = path.join(out, `${key}.${lang}`);
      writeFileSync(`${base}.png`, full);
      if (flag("passes")) {
        writeFileSync(`${base}.beauty.png`, await rawPng(beautyImg));
        if (litImg) writeFileSync(`${base}.lit.png`, await rawPng(litImg));
        if (bareImg) writeFileSync(`${base}.bare.png`, await rawPng(bareImg));
      }
      await sharp(full).resize(800, 600, { kernel: "lanczos3" }).webp({ quality: 88, alphaQuality: 90, smartSubsample: true, effort: 6 }).toFile(`${base}.webp`);
      // the smaller widths the site's srcset offers (1× laptops and tablets take 400)
      for (const w of [600, 400]) {
        await sharp(full).resize(w, (w * 3) / 4, { kernel: "lanczos3" }).webp({ quality: 88, alphaQuality: 90, smartSubsample: true, effort: 6 }).toFile(`${base}.${w}.webp`);
      }
      // how it reads on the page: the size the home row draws it (196px wide), light and dark floors, at 2x
      const small = await sharp(full).resize(392, 294, { kernel: "lanczos3" }).png().toBuffer();
      await sharp({ create: { width: 800, height: 310, channels: 3, background: "#fdfcfa" } })
        .composite([
          { input: small, left: 4, top: 8 },
          { input: await sharp({ create: { width: 396, height: 310, channels: 3, background: "#101116" } }).png().toBuffer(), left: 404, top: 0 },
          { input: small, left: 404, top: 8 },
        ])
        .png()
        .toFile(`${base}.small.png`);
      made.push({ key, lang });
      const tt = Object.entries(r.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(", ");
      console.log(`${key}.${lang}: ${((Date.now() - t0) / 1000).toFixed(1)}s, page ${(tPage / 1000).toFixed(1)}s (${tt}) tris=${r.triangles} → ${base}.png | ${base}.small.png`);
    }
  }
  if (errors.length) console.log("browser errors:\n" + [...new Set(errors)].slice(0, 12).join("\n"));
  console.log("gpu:", gpu);

  // contact sheets on the page's light and dark floors
  if (!flag("no-sheets") && made.length > 1) {
    for (const lang of langs) {
      const ks = made.filter((m) => m.lang === lang).map((m) => m.key);
      const tiles = await Promise.all(ks.map((k) => sharp(path.join(out, `${k}.${lang}.png`)).resize(400, 300).png().toBuffer()));
      const cols = 4;
      const rows = Math.ceil(tiles.length / cols);
      for (const [name, background] of [["light", "#fdfcfa"], ["dark", "#101116"]]) {
        await sharp({ create: { width: cols * 404 + 4, height: rows * 304 + 4, channels: 3, background } })
          .composite(tiles.map((input, i) => ({ input, left: 4 + (i % cols) * 404, top: 4 + Math.floor(i / cols) * 304 })))
          .png()
          .toFile(path.join(out, `sheet.${lang}.${name}.png`));
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
