/**
 * Reads the researched catalogue from disk — NODE ONLY (the seed scripts and the tests).
 *
 *   const catalog = loadDemoCatalog();          // catalog/products/*.json + the photo keys of app/art/photos
 *   await seedDemo(db, now, { catalog });        // seedDemo calls this itself when no catalogue is passed
 *
 * The files are read at run time with node:fs, never imported as modules: no bundler can pull
 * catalog/** into the Worker or the client (the production database gets the catalogue through
 * `npm run db:seed -- --sql <file>`, which also runs in Node). node:fs is reached through
 * `process.getBuiltinModule` so this file needs no Node type declarations and type-checks with the
 * Worker's tsconfig; in a Worker there is no `process`, and the call fails with a clear message.
 */
import type { CatalogProduct, DemoCatalog } from "./types";

type NodeFs = {
  readdirSync(path: URL): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
};

/** The repository root, from this file's place in it (app/server/db/seed/demo/catalog/load.ts). */
const PROJECT_ROOT = new URL("../../../../../../", import.meta.url);

function nodeFs(): NodeFs {
  const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = process?.getBuiltinModule?.("node:fs") as NodeFs | undefined;
  if (!fs) {
    throw new Error("The demo catalogue is read from catalog/products by Node (npm run db:seed, db:reset and the tests). Pass `catalog` to seedDemo() anywhere else.");
  }
  return fs;
}

export type LoadCatalogOptions = {
  /** Repository root (a directory URL ending in "/"); default: the one this file lives in. */
  root?: URL;
};

/** Every product of catalog/products (sorted by slug) and every built photo key of app/art/photos. */
export function loadDemoCatalog(options: LoadCatalogOptions = {}): DemoCatalog {
  const fs = nodeFs();
  const root = options.root ?? PROJECT_ROOT;
  const productsDir = new URL("catalog/products/", root);
  const photosDir = new URL("app/art/photos/", root);

  const products: CatalogProduct[] = [];
  for (const file of fs.readdirSync(productsDir).filter((name) => name.endsWith(".json")).sort()) {
    const url = new URL(file, productsDir);
    let product: CatalogProduct;
    try {
      product = JSON.parse(fs.readFileSync(url, "utf8")) as CatalogProduct;
    } catch (error) {
      throw new Error(`Demo catalogue: catalog/products/${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    products.push(product);
  }
  const photoKeys = new Set(
    fs
      .readdirSync(photosDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length)),
  );
  return { products, photoKeys };
}
