/**
 * TamTam clay renders — the registry behind `<Art>`.
 *
 * Every picture rendered by `node scripts/art/build.mjs` has one small manifest in
 * `app/art/manifest/` (`<key>.json` for the hero view, `<key>--<view>.json` for the others) and
 * its image files in `public/art/`. This module collects the manifests at build time; nothing here
 * touches the network or the DOM, so it is safe in loaders, in components and on the server.
 *
 * Art keys come from `scripts/art/catalog.json` ("switch-2", "dualsense-white", "game-<slug>", …).
 * A key that has no render yet is not an error: `<Art>` draws a placeholder of the right shape.
 *
 * The renders are stylised illustrations of the hardware, not photographs of the item for sale.
 */
import expected from "./manifest/_expected.json";

// The component, so that `import { Art, hasArt } from "~/art"` works as well as "~/art/Art".
// (Art.tsx imports this file too; that is fine because neither uses the other while loading.)
export { Art } from "./Art";
export type { ArtProps } from "./Art";

export type ArtView = "hero" | "front" | "back";

export interface ArtVariant {
  /** Width of this file in pixels. */
  w: number;
  /** Public URL, content-hashed: safe to cache forever. */
  src: string;
}

export interface ArtManifest {
  key: string;
  view: ArtView;
  /** Intrinsic size of the picture (the largest master); use it for width/height attributes. */
  width: number;
  height: number;
  /** width / height */
  aspect: number;
  variants: {
    /** Ascending by width. */
    avif: ArtVariant[];
    webp: ArtVariant[];
    /** One PNG for clients that take neither AVIF nor WebP. */
    png: string;
  };
  /** A ~24 px WebP as a data: URL, shown blurred until the real file has loaded. */
  placeholder: string;
  /** The object's main colour, "#rrggbb" — for tinted surfaces behind the picture. */
  dominant: string;
}

const VIEWS: readonly ArtView[] = ["hero", "front", "back"];

const manifests = import.meta.glob<ArtManifest>(["./manifest/*.json", "!./manifest/_*.json"], {
  eager: true,
  import: "default",
});

const registry = new Map<string, ArtManifest>();
for (const manifest of Object.values(manifests)) registry.set(artName(manifest.key, manifest.view), manifest);

const expectedAspects: Readonly<Record<string, number>> = expected;

/** "switch-2" for the hero view, "switch-2@front" for the others — the form `media.art_key` stores. */
export function artName(key: string, view: ArtView = "hero"): string {
  return view === "hero" ? key : `${key}@${view}`;
}

/** Splits "switch-2@front" into key and view. An explicit `view` argument wins over the suffix. */
export function parseArtName(name: string, view?: ArtView): { key: string; view: ArtView } {
  const at = name.lastIndexOf("@");
  const suffix = at > 0 ? name.slice(at + 1) : "";
  const fromName = (VIEWS as readonly string[]).includes(suffix) ? (suffix as ArtView) : undefined;
  return { key: fromName ? name.slice(0, at) : name, view: view ?? fromName ?? "hero" };
}

/** The manifest of a rendered picture, or undefined when that key / view has no render yet. */
export function getArt(name: string, view?: ArtView): ArtManifest | undefined {
  const target = parseArtName(name, view);
  return registry.get(artName(target.key, target.view));
}

export function hasArt(name: string, view?: ArtView): boolean {
  return getArt(name, view) !== undefined;
}

/** The views of a key that are rendered, hero first — what a gallery can show. */
export function artViews(key: string): ArtView[] {
  return VIEWS.filter((view) => registry.has(artName(key, view)));
}

/** Every rendered picture as "key" / "key@view". */
export function artNames(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Width / height to reserve for a picture: the real one when it is rendered, otherwise an
 * estimate from the hardware's size in the catalogue, otherwise undefined (unknown key).
 */
export function artAspect(name: string, view?: ArtView): number | undefined {
  const target = parseArtName(name, view);
  return getArt(target.key, target.view)?.aspect ?? expectedAspects[artName(target.key, target.view)];
}

/** `srcset` value for a list of variants. */
export function artSrcSet(variants: readonly ArtVariant[]): string {
  return variants.map((variant) => `${variant.src} ${variant.w}w`).join(", ");
}
