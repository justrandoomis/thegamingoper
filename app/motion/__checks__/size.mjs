// @ts-nocheck — node app/motion/__checks__/size.mjs
// How many bytes does the engine add? Bundles a consumer that uses every public piece of ~/motion (so nothing is
// tree-shaken away), with React, React Router and the app's own shared modules (~/i18n, ~/lib) left external,
// then reports minified + gzipped sizes of the always-loaded part, the on-demand chunk and the stylesheet.
import { build, transform } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const motionDir = fileURLToPath(new URL("..", import.meta.url));
const appDir = path.resolve(motionDir, "..");
const out = path.join(tmpdir(), "tamtam-motion-size");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entry = path.join(out, "consumer.tsx");
writeFileSync(
  entry,
  `import { Bubble, BubbleGroup, MotionLink, MotionRoot, NumberMorph, PageTransition, SharedElement, dematerialize, directionMorph,
  flyToCart, getMotionTier, haptic, materialize, setMotionOverride, themeMorph, useAmbient, useDirectionMorph, useMotionTier,
  useNavIntent, useRail, useReducedMotion, useSheet, durations, springs } from "~/motion";
export const used = [Bubble, BubbleGroup, MotionLink, MotionRoot, NumberMorph, PageTransition, SharedElement, dematerialize, directionMorph,
  flyToCart, getMotionTier, haptic, materialize, setMotionOverride, themeMorph, useAmbient, useDirectionMorph, useMotionTier,
  useNavIntent, useRail, useReducedMotion, useSheet, durations, springs];
`,
);

const result = await build({
  entryPoints: [entry],
  outdir: out,
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  metafile: true,
  target: "es2022",
  jsx: "automatic",
  logLevel: "silent",
  plugins: [
    {
      name: "app-alias",
      setup(b) {
        b.onResolve({ filter: /^~\// }, (args) => {
          if (args.path === "~/motion") return { path: path.join(motionDir, "index.ts") };
          return { path: args.path, external: true }; // ~/i18n, ~/lib: already in every page's bundle
        });
        b.onResolve({ filter: /^(react|react-dom|react-router)(\/.*)?$/ }, (args) => ({ path: args.path, external: true }));
      },
    },
  ],
});

const outputs = result.metafile.outputs;
const size = (file) => {
  const bytes = readFileSync(file);
  return { min: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
};
const rel = (file) => path.relative(process.cwd(), file).split(path.sep).join("/");
const entryOut = Object.keys(outputs).find((file) => outputs[file].entryPoint);

// Always loaded = the consumer's output plus everything it imports statically.
const core = new Set();
const walk = (file) => {
  if (core.has(file)) return;
  core.add(file);
  for (const imported of outputs[file].imports) if (imported.kind === "import-statement" && outputs[imported.path]) walk(imported.path);
};
walk(entryOut);
const lazy = Object.keys(outputs).filter((file) => file.endsWith(".js") && !core.has(file));
const css = Object.keys(outputs).filter((file) => file.endsWith(".css"));

const total = (files) => files.map(size).reduce((sum, s) => ({ min: sum.min + s.min, gzip: sum.gzip + s.gzip }), { min: 0, gzip: 0 });
const kb = (n) => (n / 1024).toFixed(2) + " KB";
const coreJs = total([...core].filter((file) => file.endsWith(".js")));
const lazyJs = total(lazy);
// Stylesheets are measured from their sources (esbuild also copies an async chunk's CSS into the entry's CSS
// bundle, which Vite does not do, so the bundle outputs would count extras.css twice).
const has = (file, name) => Object.keys(outputs[file].inputs).some((input) => path.basename(input) === name);
const minifiedCss = async (name) => {
  const { code } = await transform(readFileSync(path.join(motionDir, name), "utf8"), { loader: "css", minify: true });
  const bytes = Buffer.from(code);
  return { min: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
};
const coreCss = await minifiedCss("motion.css");
const lazyCss = await minifiedCss("extras.css");

const modulesOf = (files) => [...new Set(files.flatMap((file) => Object.keys(outputs[file].inputs)))].filter((m) => m.includes("motion")).map((m) => path.basename(m)).sort();
console.log("always loaded JS  :", kb(coreJs.min), "min,", kb(coreJs.gzip), "gzip  —", modulesOf([...core].filter((f) => f.endsWith(".js"))).join(" "));
console.log("always loaded CSS :", kb(coreCss.min), "min,", kb(coreCss.gzip), "gzip  — motion.css");
console.log("on demand JS      :", kb(lazyJs.min), "min,", kb(lazyJs.gzip), "gzip  —", modulesOf(lazy).join(" "));
console.log("on demand CSS     :", kb(lazyCss.min), "min,", kb(lazyCss.gzip), "gzip  — extras.css");
if (process.argv.includes("--modules")) {
  const per = {};
  for (const file of Object.keys(outputs)) {
    for (const [input, info] of Object.entries(outputs[file].inputs)) {
      const key = path.basename(input) + (core.has(file) || has(file, "motion.css") ? "" : " (on demand)");
      per[key] = (per[key] ?? 0) + info.bytesInOutput;
    }
  }
  for (const [name, bytes] of Object.entries(per).sort((a, b) => b[1] - a[1])) if (bytes > 0) console.log("  ", String(bytes).padStart(6), name);
}
console.log(JSON.stringify({ coreJsGzip: coreJs.gzip, coreCssGzip: coreCss.gzip, lazyJsGzip: lazyJs.gzip, lazyCssGzip: lazyCss.gzip }));
rmSync(out, { recursive: true, force: true });
