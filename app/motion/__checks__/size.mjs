// @ts-nocheck — node app/motion/__checks__/size.mjs [--modules]
// How many bytes does the engine add to a page? A production build of the engine with the app's own bundler:
// Vite 8 (Rolldown, Oxc minifier, Lightning CSS), the same pipeline `react-router build` uses for the client.
//
// Two consumers are built, with React, React Router and the app's shared modules (~/i18n, ~/lib — already in every
// page's bundle) left external:
//   layout       what every page loads: <MotionRoot>, <PageTransition>, <MotionLink> (a layout mounts these)
//   everything   every public export of ~/motion at once (the worst case; a real page uses fewer pieces)
// and the gzip sizes of
//   always loaded   the entry chunk + everything it imports statically, and the CSS attached to it (motion.css)
//   on demand       the dynamically imported chunk (./extras) and its CSS (extras.css)
// Vite's own dynamic-import helper (vite/preload-helper) is listed apart: the app ships it once for every route.
//
// Safety: `configFile: false` (the project's vite.config.ts — React Router and Cloudflare plugins — is never loaded,
// so nothing touches build/, .react-router/ or .wrangler/), and `write: false` (nothing is written except the tiny
// consumer entries in .shots/motion-build/, which is git-ignored and removed afterwards).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";

const motionDir = fileURLToPath(new URL("..", import.meta.url));
const appDir = path.resolve(motionDir, "..");
const root = path.resolve(appDir, "..");
const out = path.join(root, ".shots", "motion-build");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const consumers = {
  layout: `import { MotionLink, MotionRoot, PageTransition } from "~/motion";\nexport const used = [MotionLink, MotionRoot, PageTransition];\n`,
  everything: `import * as motion from "~/motion";\n// Every value export, so the bundler keeps all of it.\nexport const used = Object.values(motion);\n`,
};

const gz = (text) => gzipSync(Buffer.from(text), { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(2) + " KB";
const isHelper = (id) => id.includes("preload-helper") || id.includes("rolldown/runtime") || id.includes("rolldown:runtime");

async function measure(name) {
  const entry = path.join(out, `${name}.tsx`);
  writeFileSync(entry, consumers[name]);
  const result = await build({
    configFile: false,
    root,
    logLevel: "warn",
    publicDir: false,
    mode: "production",
    oxc: { jsx: { runtime: "automatic" } },
    resolve: {
      alias: [
        { find: /^~\/motion$/, replacement: path.join(motionDir, "index.ts") },
        { find: /^~\/motion\/(.*)$/, replacement: path.join(motionDir, "$1") },
      ],
    },
    build: {
      outDir: out,
      write: false,
      emptyOutDir: false,
      minify: true,
      cssMinify: true,
      sourcemap: false,
      modulePreload: { polyfill: false },
      reportCompressedSize: false,
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: "strict",
        external: (id) => /^(react|react-dom|react-router)(\/.*)?$/.test(id) || /^~\/(i18n|lib)\//.test(id),
        output: { format: "es" },
      },
    },
  });

  const outputs = (Array.isArray(result) ? result[0] : result).output;
  const chunks = outputs.filter((o) => o.type === "chunk");
  const assets = new Map(outputs.filter((o) => o.type === "asset").map((a) => [a.fileName, a]));
  const byName = new Map(chunks.map((c) => [c.fileName, c]));

  // Always loaded = the entry plus its static imports (transitively).
  const core = new Set();
  const walk = (chunk) => {
    if (core.has(chunk.fileName)) return;
    core.add(chunk.fileName);
    for (const imported of chunk.imports) if (byName.has(imported)) walk(byName.get(imported));
  };
  walk(chunks.find((c) => c.isEntry));
  const coreChunks = [...core].map((file) => byName.get(file));
  const lazy = chunks.filter((c) => !core.has(c.fileName));
  const cssOf = (list) => [...new Set(list.flatMap((c) => [...(c.viteMetadata?.importedCss ?? [])]))].map((file) => assets.get(file)).filter(Boolean);
  const sum = (items, text) => items.reduce((acc, item) => ({ min: acc.min + Buffer.byteLength(text(item)), gzip: acc.gzip + gz(text(item)) }), { min: 0, gzip: 0 });

  // The helper's bytes, measured on its own (rendered length inside the chunk, gzipped separately as an estimate).
  let helperCode = "";
  for (const chunk of coreChunks) for (const [id, info] of Object.entries(chunk.modules)) if (isHelper(id)) helperCode += info.code ?? "";
  const helper = { min: Buffer.byteLength(helperCode), gzip: helperCode ? gz(helperCode) : 0 };
  const coreJs = sum(coreChunks, (c) => c.code);
  const engineJs = { min: coreJs.min - helper.min, gzip: coreJs.gzip - helper.gzip };
  const report = {
    coreJs,
    engineJs,
    helper,
    coreCss: sum(cssOf(coreChunks), (a) => String(a.source)),
    lazyJs: sum(lazy, (c) => c.code),
    lazyCss: sum(cssOf(lazy), (a) => String(a.source)),
    // Modules that actually contribute code (tree-shaken ones have no rendered bytes).
    modules: (list) =>
      [...new Set(list.flatMap((c) => Object.entries(c.modules).filter(([, info]) => info.renderedLength > 0).map(([id]) => id)))]
        .filter((m) => m.includes("motion") && !m.includes("motion-build"))
        .map((m) => path.basename(m))
        .sort(),
    coreChunks,
    lazy,
  };
  return report;
}

for (const name of Object.keys(consumers)) {
  const r = await measure(name);
  console.log(`── ${name} ──  (Vite 8 production build, gzip -9)`);
  console.log("always loaded JS  :", kb(r.engineJs.min), "min,", kb(r.engineJs.gzip), "gzip  —", r.modules(r.coreChunks).join(" "));
  console.log("  + Vite's preload helper (shared with the whole app):", kb(r.helper.gzip), "gzip (estimate)");
  console.log("always loaded CSS :", kb(r.coreCss.min), "min,", kb(r.coreCss.gzip), "gzip  — motion.css");
  console.log("on demand JS      :", kb(r.lazyJs.min), "min,", kb(r.lazyJs.gzip), "gzip  —", r.modules(r.lazy).join(" "));
  console.log("on demand CSS     :", kb(r.lazyCss.min), "min,", kb(r.lazyCss.gzip), "gzip  — extras.css");
  if (process.argv.includes("--modules")) {
    for (const chunk of [...r.coreChunks, ...r.lazy]) {
      console.log(`  ${chunk.fileName}${r.coreChunks.includes(chunk) ? "" : " (on demand)"}`);
      for (const [id, info] of Object.entries(chunk.modules).sort((a, b) => b[1].renderedLength - a[1].renderedLength)) {
        if (info.renderedLength > 0) console.log("    ", String(info.renderedLength).padStart(6), path.relative(root, id).split(path.sep).join("/"));
      }
    }
  }
  console.log(JSON.stringify({ consumer: name, engineJsGzip: r.engineJs.gzip, helperGzip: r.helper.gzip, coreCssGzip: r.coreCss.gzip, lazyJsGzip: r.lazyJs.gzip, lazyCssGzip: r.lazyCss.gzip }));
}
rmSync(out, { recursive: true, force: true });
