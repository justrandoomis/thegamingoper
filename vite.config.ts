import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { compactPhoto, isCompactable, type PhotoManifestShape } from "./app/art/compact";

/**
 * `virtual:tt-art-lite`: every product photo manifest in short form, without the blurred miniatures.
 * The browser loads it lazily (app/art/index.ts loadAllPhotos) instead of bundling every manifest.
 */
function artLitePlugin(): Plugin {
  const id = "virtual:tt-art-lite";
  const resolved = `\0${id}`;
  const dir = resolve(__dirname, "app/art/photos");
  return {
    name: "tt-art-lite",
    resolveId(source) {
      return source === id ? resolved : undefined;
    },
    load(loadId) {
      if (loadId !== resolved) return undefined;
      const entries = [];
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
        const path = resolve(dir, file);
        this.addWatchFile(path);
        const manifest = JSON.parse(readFileSync(path, "utf8")) as PhotoManifestShape;
        if (isCompactable(manifest)) entries.push(compactPhoto(manifest, false));
      }
      return `export default ${JSON.stringify(entries)};`;
    },
  };
}

export default defineConfig({
  plugins: [
    artLitePlugin(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
