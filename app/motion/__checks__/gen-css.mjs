// @ts-nocheck — build-time script: npx tsx app/motion/__checks__/gen-css.mjs
// Rewrites the generated token block of app/motion/motion.css from app/motion/tokens.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replaceTokenBlock } from "../tokens-css.ts";

const file = fileURLToPath(new URL("../motion.css", import.meta.url));
const before = readFileSync(file, "utf8");
const after = replaceTokenBlock(before);
if (after === before) {
  console.log("motion.css tokens are up to date");
} else {
  writeFileSync(file, after);
  console.log("motion.css tokens regenerated");
}
