#!/usr/bin/env node
// Visual check of the trace: the source crop next to the shipped vector, same scale, same position.
//
// Usage: node scripts/logo/compare.mjs [out.png] [scale=4]
// Writes .shots/logo/compare.png by default — LOOK at it after every change to trace.mjs.
//   left    the screenshot crop, enlarged
//   middle  the vector in flat red on a pale ground
//   right   the vector's outline drawn over the crop

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const out = process.argv[2] ?? path.join(ROOT, ".shots/logo/compare.png");
const scale = Number(process.argv[3] ?? 4);

const data = JSON.parse(await readFile(path.join(HERE, "parts.json"), "utf8"));
const { region, originInScreenshotPx: origin } = data.source;
const units = data.unitsPerSourcePx;

const width = region.width * scale;
const height = region.height * scale;
// The crop covers screenshot pixels [region.left, region.left + width); express that in lockup units.
const viewBox = [(region.left - origin[0]) * units, (region.top - origin[1]) * units, region.width * units, region.height * units].join(" ");
const paths = Object.values(data.parts)
  .map((part) => `<path fill-rule="evenodd" d="${part.d}"/>`)
  .join("");
const svg = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${inner}</svg>`);

const crop = await sharp(path.join(HERE, "source/splash-logo.png")).resize(width, height, { kernel: "cubic", fit: "fill" }).png().toBuffer();
const flat = await sharp(svg(`<rect x="-9999" y="-9999" width="99999" height="99999" fill="#fbeef2"/><g fill="#e5132b">${paths}</g>`)).png().toBuffer();
const outline = svg(`<g fill="none" stroke="#00e5ff" stroke-width="${(1.2 * units) / scale}">${paths}</g>`);
const over = await sharp(crop).composite([{ input: outline }]).png().toBuffer();

await mkdir(path.dirname(out), { recursive: true });
await sharp({ create: { width: width * 3 + 32, height, channels: 3, background: "#ffffff" } })
  .composite([
    { input: crop, left: 0, top: 0 },
    { input: flat, left: width + 16, top: 0 },
    { input: over, left: (width + 16) * 2, top: 0 },
  ])
  .png()
  .toFile(out);
console.log(out);
