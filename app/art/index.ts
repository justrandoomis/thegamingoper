/**
 * TamTam pictures — the registry behind `<Art>`: clay renders and product photos.
 *
 * Clay renders: every picture rendered by `node scripts/art/build.mjs` has one small manifest in
 * `app/art/manifest/` (`<key>.json` for the hero view, `<key>--<view>.json` for the others) and
 * its image files in `public/art/`. Art keys come from `scripts/art/catalog.json` ("switch-2",
 * "dualsense-white", "game-<slug>", …). The renders are stylised illustrations of the hardware.
 *
 * Product photos: every image of `catalog/products/<slug>.json` is built by
 * `node scripts/products/images.mjs` into `app/art/photos/<slug>--<n>.json` and `public/products/<slug>/`.
 * Their keys are "<slug>--<n>" (the catalogue's image key); they have one view, "hero", and never
 * collide with a clay key. `getArt("nintendo-switch-2--1")`, `<Art name="nintendo-switch-2--1" …/>`
 * and `productPhotos("nintendo-switch-2")` find them. Photos ship AVIF and WebP only (no PNG
 * fallback); a product's first photo also carries its share picture for `og:image`
 * (`productShareImage("nintendo-switch-2")`).
 *
 * This module collects the manifests at build time; nothing here touches the network or the DOM,
 * so it is safe in loaders, in components and on the server. A key that has no picture yet is not
 * an error: `<Art>` draws a placeholder of the right shape.
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
    /**
     * Clay renders only: one PNG for clients that take neither AVIF nor WebP. Product photos have
     * none — every browser the store supports decodes WebP, so their `<img src>` is the 720 px WebP
     * (`artFallbackSrc()`).
     */
    png?: string;
  };
  /** A ~24 px WebP as a data: URL, shown blurred until the real file has loaded. */
  placeholder: string;
  /** The object's main colour, "#rrggbb" — for tinted surfaces behind the picture. */
  dominant: string;
}

/** What a product photo shows, as the catalogue says ("box-art" is a game's front cover). */
export type PhotoKind = "hero" | "angle" | "detail" | "in-box" | "box-art" | "screenshot";

/**
 * A product's share picture for `og:image` / `twitter:image`: its first photo as one file, at most
 * 1200 px wide — JPEG when the photo is opaque, PNG when it is transparent.
 */
export interface ShareImage {
  /** Public URL, content-hashed. Make it absolute (origin + src) in meta tags. */
  src: string;
  width: number;
  height: number;
  type: "image/jpeg" | "image/png";
}

/**
 * A product photo ("<slug>--<n>"): the manifest of a render, plus how the photo was treated and
 * where it came from. Always view "hero".
 */
export interface PhotoManifest extends ArtManifest {
  /**
   * true: no background (the source had none, or it was cut out) — place it on any surface.
   * false: the photo keeps its own background; `<Art>` draws it in a rounded frame of that colour.
   */
  transparent: boolean;
  /**
   * The colour of the background an opaque photo kept, "#rrggbb". null when transparent, and when
   * the picture fills its own frame (box art, screenshots, photos without a plain background).
   */
  background: string | null;
  kind: PhotoKind;
  /** Who owns the picture, e.g. "Nintendo". */
  credit: string;
  /** Where the original was downloaded from (the picture file, and the page it was on). */
  source: { url: string | null; page: string | null };
  /** Only on the product's first photo: its share picture (`productShareImage(slug)` finds it). */
  share?: ShareImage;
  /** Hash of the original and of the build settings: how the build knows the files are current. */
  input: string;
}

const VIEWS: readonly ArtView[] = ["hero", "front", "back"];

const manifests = import.meta.glob<ArtManifest>(["./manifest/*.json", "!./manifest/_*.json"], {
  eager: true,
  import: "default",
});

const registry = new Map<string, ArtManifest>();
for (const manifest of Object.values(manifests)) registry.set(artName(manifest.key, manifest.view), manifest);

const photoManifests = import.meta.glob<PhotoManifest>("./photos/*.json", { eager: true, import: "default" });

/** Photos by key ("<slug>--<n>"). Kept apart from the renders: `artNames()` lists renders only. */
const photos = new Map<string, PhotoManifest>();
for (const manifest of Object.values(photoManifests)) photos.set(manifest.key, manifest);

const PHOTO_KEY = /^([a-z0-9]+(?:-[a-z0-9]+)*)--(\d+)$/;

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

/**
 * The manifest of a picture — a clay render, or a product photo for a "<slug>--<n>" key — or
 * undefined when it does not exist yet. `isPhoto()` tells the two apart.
 */
export function getArt(name: string, view?: ArtView): ArtManifest | undefined {
  const target = parseArtName(name, view);
  return registry.get(artName(target.key, target.view)) ?? (target.view === "hero" ? photos.get(target.key) : undefined);
}

export function hasArt(name: string, view?: ArtView): boolean {
  return getArt(name, view) !== undefined;
}

/** The views of a key that exist, hero first — what a gallery can show. A photo has "hero" only. */
export function artViews(key: string): ArtView[] {
  return VIEWS.filter((view) => registry.has(artName(key, view)) || (view === "hero" && photos.has(key)));
}

/** Every clay render as "key" / "key@view". Photos are listed by `photoKeys()`. */
export function artNames(): string[] {
  return [...registry.keys()].sort();
}

/* ── product photos ──────────────────────────────────────────────────────── */

/** "<slug>--<n>": the key of a product's n-th catalogue image (the same key as `media.art_key`). */
export function photoKey(slug: string, n: number): string {
  return `${slug}--${n}`;
}

/** Splits "nintendo-switch-2--3" into slug and number; undefined for anything else. */
export function parsePhotoKey(key: string): { slug: string; n: number } | undefined {
  const match = PHOTO_KEY.exec(key);
  return match ? { slug: match[1], n: Number(match[2]) } : undefined;
}

/** Narrows a manifest from `getArt()` to a product photo. */
export function isPhoto(art: ArtManifest | undefined): art is PhotoManifest {
  return art !== undefined && "transparent" in art && "kind" in art;
}

/** The manifest of a product photo, or undefined when it is not built (yet). */
export function getPhoto(key: string): PhotoManifest | undefined {
  return photos.get(key);
}

/** A product's built photos in catalogue order (n ascending) — what its gallery shows. */
export function productPhotos(slug: string): PhotoManifest[] {
  const found: { n: number; manifest: PhotoManifest }[] = [];
  for (const [key, manifest] of photos) {
    const parsed = parsePhotoKey(key);
    if (parsed?.slug === slug) found.push({ n: parsed.n, manifest });
  }
  return found.sort((a, b) => a.n - b.n).map((entry) => entry.manifest);
}

/** Every built photo key, sorted. */
export function photoKeys(): string[] {
  return [...photos.keys()].sort();
}

/**
 * The share picture of a product (its first photo, one JPEG or PNG ≤ 1200 px wide) for
 * `og:image`, or undefined when that photo is not built. Absolute URL: `new URL(share.src, origin)`.
 */
export function productShareImage(slug: string): ShareImage | undefined {
  return productPhotos(slug).find((photo) => photo.share)?.share;
}

/**
 * The single file an `<img src>` names when no `<source>` applies (and for anything that wants one
 * URL): a clay render's PNG, a photo's 720 px WebP (or its largest, when it is narrower).
 */
export function artFallbackSrc(art: ArtManifest): string {
  return art.variants.png ?? (art.variants.webp.find((variant) => variant.w >= 720) ?? art.variants.webp[art.variants.webp.length - 1]).src;
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
