#!/usr/bin/env node
// TamTam Games — static brand assets, built from the traced logo (scripts/logo/parts.json).
//
//   public/logo/tamtam-{full,stacked,wordmark,mark}.svg   standalone, brand red on transparent
//   public/favicon.svg                                     mark on transparent
//   public/favicon.ico                                     16 / 32 / 48 px, mark on transparent
//   public/apple-touch-icon.png                            180 px, red mark on warm white
//   public/icon-192.png, public/icon-512.png               mark on a warm-white rounded tile
//   public/icon-maskable-512.png                           full bleed, mark inside the safe zone
//   public/site.webmanifest
//
// Usage: node scripts/logo/assets.mjs
//
// The artwork is PROVISIONAL (a trace of a low-resolution screenshot). When the owner's original
// logo replaces scripts/logo/parts.json, run this again; nothing here needs to change.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderLayoutSvg } from "./layouts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const PUBLIC = path.join(ROOT, "public");

/**
 * Brand colours used by files that cannot read the design tokens (icons, manifest).
 * Keep in step with the design system: `red` = signature TamTam red, `warmWhite` = the light page ground.
 */
const BRAND = { red: "#E5132B", warmWhite: "#F3EFEC" };

const NAME = "TamTam Games — طمطم";

const data = JSON.parse(await readFile(path.join(HERE, "parts.json"), "utf8"));
const mark = data.layouts.mark;

/**
 * A square icon: the mark centred on an optional background.
 *   fit     share of the icon's side taken by the mark's longer side
 *   radius  corner radius of the background as a share of the side (0 = square, full bleed)
 */
function iconSvg({ size, fit, background = null, radius = 0, fill = BRAND.red }) {
  const scale = (size * fit) / Math.max(mark.width, mark.height);
  const x = (size - mark.width * scale) / 2;
  const y = (size - mark.height * scale) / 2;
  const shapes = mark.parts
    .map(({ part, x: dx, y: dy }) => `<path transform="translate(${dx} ${dy})" fill-rule="evenodd" d="${data.parts[part].d}"/>`)
    .join("");
  const back = background ? `<rect width="${size}" height="${size}" rx="${size * radius}" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${back}<g transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(5)})" fill="${fill}">${shapes}</g></svg>`;
}

const png = (svg) => sharp(Buffer.from(svg)).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();

/** An .ico file holding PNG images (every current browser and OS reads PNG-in-ICO). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, bytes }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at); // width
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(bytes.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.bytes)]);
}

const written = [];
async function write(relative, content) {
  const file = path.join(PUBLIC, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  written.push(`${relative} (${typeof content === "string" ? Buffer.byteLength(content) : content.length} bytes)`);
}

// Standalone logo files — for e-mail, documents, social cards, partners.
for (const variant of Object.keys(data.layouts)) {
  await write(`logo/tamtam-${variant}.svg`, renderLayoutSvg(data, variant, { fill: BRAND.red, title: NAME }));
}

// Favicons: the mark alone, on transparent.
const faviconScale = 0.94;
const side = Math.max(mark.width, mark.height) / faviconScale;
const faviconParts = mark.parts
  .map(({ part, x, y }) => `<path transform="translate(${(x + (side - mark.width) / 2).toFixed(1)} ${(y + (side - mark.height) / 2).toFixed(1)})" fill-rule="evenodd" d="${data.parts[part].d}"/>`)
  .join("");
await write("favicon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side.toFixed(1)} ${side.toFixed(1)}" fill="${BRAND.red}">${faviconParts}</svg>\n`);

const icoImages = [];
for (const size of [16, 32, 48]) icoImages.push({ size, bytes: await png(iconSvg({ size, fit: faviconScale })) });
await write("favicon.ico", ico(icoImages));

// Home-screen icons.
await write("apple-touch-icon.png", await sharp(await png(iconSvg({ size: 180, fit: 0.66, background: BRAND.warmWhite }))).flatten({ background: BRAND.warmWhite }).png({ compressionLevel: 9 }).toBuffer());
await write("icon-192.png", await png(iconSvg({ size: 192, fit: 0.64, background: BRAND.warmWhite, radius: 0.225 })));
await write("icon-512.png", await png(iconSvg({ size: 512, fit: 0.64, background: BRAND.warmWhite, radius: 0.225 })));
// Maskable: launchers crop to a circle of 80 % of the side at the least, so the mark's corners must stay inside it.
await write("icon-maskable-512.png", await sharp(await png(iconSvg({ size: 512, fit: 0.54, background: BRAND.warmWhite }))).flatten({ background: BRAND.warmWhite }).png({ compressionLevel: 9 }).toBuffer());

const manifest = {
  name: NAME,
  short_name: "طمطم",
  description: "متجر ألعاب وأجهزة وملحقات في العراق",
  lang: "ar",
  dir: "rtl",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  theme_color: BRAND.warmWhite,
  background_color: BRAND.warmWhite,
  icons: [
    { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
await write("site.webmanifest", `${JSON.stringify(manifest, null, 2)}\n`);

console.log(written.join("\n"));
