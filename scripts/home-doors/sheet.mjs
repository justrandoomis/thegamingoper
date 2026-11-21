// Contact sheet of renders on the store's light and dark page floors.
// node sheet.mjs <out-prefix> <a.png> <b.png> …   → <out-prefix>.light.png and <out-prefix>.dark.png
import { createRequire } from "node:module";
const require = createRequire("C:/Users/levon/tamtam/package.json");
const sharp = require("sharp");

const [prefix, ...files] = process.argv.slice(2);
if (!prefix || files.length === 0) {
  console.error("usage: node sheet.mjs <out-prefix> <png…>");
  process.exit(2);
}
const tiles = await Promise.all(files.map((f) => sharp(f).resize(400, 300, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()));
const cols = Math.min(4, tiles.length);
const rows = Math.ceil(tiles.length / cols);
for (const [name, background] of [["light", "#fdfcfa"], ["dark", "#101116"]]) {
  await sharp({ create: { width: cols * 404 + 4, height: rows * 304 + 4, channels: 3, background } })
    .composite(tiles.map((input, i) => ({ input, left: 4 + (i % cols) * 404, top: 4 + Math.floor(i / cols) * 304 })))
    .png()
    .toFile(`${prefix}.${name}.png`);
  console.log(`${prefix}.${name}.png`);
}
