// @ts-nocheck — node app/motion/__checks__/contact.mjs <out.png> <frame.png> [frame.png …] [--width=260]
// Lays captured frames side by side (scaled down, labelled by file name order) so a whole transition can be looked
// at in one image: node app/motion/__checks__/contact.mjs .shots/motion/zoom-forward.png .shots/motion/zoom-forward-0*.png
import sharp from "sharp";

const args = process.argv.slice(2);
const width = Number(args.find((a) => a.startsWith("--width="))?.slice(8) ?? 260);
const [out, ...files] = args.filter((a) => !a.startsWith("--"));
if (!out || files.length === 0) throw new Error("usage: contact.mjs <out.png> <frame.png> [frame.png …]");

const gap = 8;
const tiles = await Promise.all(files.map((file) => sharp(file).resize({ width }).png().toBuffer({ resolveWithObject: true })));
const height = Math.max(...tiles.map((t) => t.info.height));
await sharp({ create: { width: tiles.length * (width + gap) - gap, height, channels: 3, background: { r: 120, g: 120, b: 120 } } })
  .composite(tiles.map((t, i) => ({ input: t.data, left: i * (width + gap), top: 0 })))
  .png()
  .toFile(out);
console.log(out, `${tiles.length} frames`);
