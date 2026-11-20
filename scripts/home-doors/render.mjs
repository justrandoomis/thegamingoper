// Renders the doors with headless Chrome. Usage: node render.mjs [out dir] [langs=ar,en,ckb] [keys=all]
import http from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(process.argv[1]);
const TAMTAM = "C:/Users/levon/tamtam";
const require = createRequire(TAMTAM + "/package.json");
const puppeteer = require("puppeteer-core");
const sharp = require("sharp");

const out = process.argv[2] ?? path.join(here, "out");
const langs = (process.argv[3] ?? "ar,en,ckb").split(",");
const only = process.argv[4]?.split(",");
mkdirSync(out, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = url.startsWith("/fonts/") ? path.join(TAMTAM, "public", url) : path.join(here, url === "/" ? "studio.html" : url);
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(8793, "127.0.0.1", resolve));

const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--hide-scrollbars"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("console", m.text()));
  await page.setViewport({ width: 1024, height: 1024 });
  await page.goto("http://127.0.0.1:8793/", { waitUntil: "load" });
  await page.waitForFunction("window.studioReady", { timeout: 30000 });
  await page.evaluate("window.studioReady");
  const keys = only ?? (await page.evaluate("window.DOORS"));
  for (const lang of langs) {
    for (const key of keys) {
      const dataUrl = await page.evaluate((k, l) => window.renderDoor(k, l), key, lang);
      const png = Buffer.from(dataUrl.split(",")[1], "base64");
      const file = path.join(out, `${key}.${lang}.webp`);
      await sharp(png).resize(640, 640).webp({ quality: 90 }).toFile(file);
      console.log(file);
    }
  }
  // a contact sheet per language, to look at
  for (const lang of langs) {
    const tiles = await Promise.all(keys.map((key) => sharp(path.join(out, `${key}.${lang}.webp`)).resize(320, 320).png().toBuffer()));
    const cols = 4;
    const rows = Math.ceil(tiles.length / cols);
    await sharp({ create: { width: cols * 328 + 8, height: rows * 328 + 8, channels: 3, background: "#f3f0ea" } })
      .composite(tiles.map((input, i) => ({ input, left: 8 + (i % cols) * 328, top: 8 + Math.floor(i / cols) * 328 })))
      .png()
      .toFile(path.join(out, `sheet.${lang}.png`));
  }
} finally {
  await browser.close();
  server.close();
}
