// Measures the shadow "veil": alpha near the frame edges of a render (should be ~0 so no grey box shows).
// node veil.mjs <render.png> …
import { createRequire } from "node:module";
const require = createRequire("C:/Users/levon/tamtam/package.json");
const sharp = require("sharp");
for (const file of process.argv.slice(2)) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const band = Math.round(Math.min(w, h) * 0.04);
  const stats = (pred) => {
    let sum = 0, n = 0, max = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!pred(x, y)) continue;
        const a = data[(y * w + x) * 4 + 3];
        sum += a;
        n++;
        if (a > max) max = a;
      }
    return `${(sum / n).toFixed(1)}/${max}`;
  };
  console.log(
    file.split(/[\\/]/).slice(-3).join("/"),
    `${w}x${h}`,
    "edge alpha mean/max — top",
    stats((x, y) => y < band),
    "bottom",
    stats((x, y) => y >= h - band),
    "left",
    stats((x, y) => x < band),
    "right",
    stats((x, y) => x >= w - band),
  );
}
