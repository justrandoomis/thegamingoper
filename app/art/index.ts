/**
 * TamTam pictures — the registry behind `<Art>`: official product photos (DESIGN.md §12).
 *
 * Every image of `catalog/products/<slug>.json` is built by `node scripts/products/images.mjs` into
 * `app/art/photos/<slug>--<n>.json` (its manifest) and `public/products/<slug>/` (AVIF and WebP at
 * fixed widths). Their keys are "<slug>--<n>" — the catalogue's image key, which is also what
 * `media.art_key` stores. `getArt("nintendo-switch-2--1")`, `<Art name="nintendo-switch-2--1" …/>`
 * and `productPhotos("nintendo-switch-2")` find them. A product's first photo also carries its
 * share picture for `og:image` (`productShareImage("nintendo-switch-2")`).
 *
 * (The stylised clay renders this registry used to serve are retired: no 3D art.)
 *
 * This module collects the manifests at build time; nothing here touches the network or the DOM,
 * so it is safe in loaders, in components and on the server. A key that has no picture yet is not
 * an error: `<Art>` draws a placeholder of the right shape.
 */

// The component, so that `import { Art, hasArt } from "~/art"` works as well as "~/art/Art".
// (Art.tsx imports this file too; that is fine because neither uses the other while loading.)
export { Art } from "./Art";
export type { ArtProps } from "./Art";

/**
 * Views a picture name may ask for ("<key>@front"). Photos have one view, "hero"; another view of a
 * photo falls back to it. Kept so names and components written with views keep working.
 */
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
  /** Intrinsic size of the picture (the largest file); use it for width/height attributes. */
  width: number;
  height: number;
  /** width / height */
  aspect: number;
  variants: {
    /** Ascending by width. */
    avif: ArtVariant[];
    webp: ArtVariant[];
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

/** A product photo ("<slug>--<n>"): its files, how it was treated and where it came from. Always view "hero". */
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

const photoManifests = import.meta.glob<PhotoManifest>("./photos/*.json", { eager: true, import: "default" });

/** Photos by key ("<slug>--<n>"). */
const photos = new Map<string, PhotoManifest>();
for (const manifest of Object.values(photoManifests)) photos.set(manifest.key, manifest);

const PHOTO_KEY = /^([a-z0-9]+(?:-[a-z0-9]+)*)--(\d+)$/;

/** "<key>" for the hero view, "<key>@front" for the others — the form a picture name may take. */
export function artName(key: string, view: ArtView = "hero"): string {
  return view === "hero" ? key : `${key}@${view}`;
}

/** Splits "<key>@front" into key and view. An explicit `view` argument wins over the suffix. */
export function parseArtName(name: string, view?: ArtView): { key: string; view: ArtView } {
  const at = name.lastIndexOf("@");
  const suffix = at > 0 ? name.slice(at + 1) : "";
  const fromName = (VIEWS as readonly string[]).includes(suffix) ? (suffix as ArtView) : undefined;
  return { key: fromName ? name.slice(0, at) : name, view: view ?? fromName ?? "hero" };
}

/** The manifest of a product photo ("<slug>--<n>"), or undefined when it does not exist (yet). */
export function getArt(name: string, view?: ArtView): ArtManifest | undefined {
  const target = parseArtName(name, view);
  return target.view === "hero" ? photos.get(target.key) : undefined;
}

export function hasArt(name: string, view?: ArtView): boolean {
  return getArt(name, view) !== undefined;
}

/** The views of a key that exist — what a gallery can show. A photo has "hero" only. */
export function artViews(key: string): ArtView[] {
  return photos.has(key) ? ["hero"] : [];
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

/** Narrows a manifest from `getArt()` to a product photo (every picture is one now). */
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
 * URL): the 720 px WebP (or the largest, when the photo is narrower). Every browser the store
 * supports decodes WebP, so there is no PNG fallback.
 */
export function artFallbackSrc(art: ArtManifest): string {
  return (art.variants.webp.find((variant) => variant.w >= 720) ?? art.variants.webp[art.variants.webp.length - 1]).src;
}

/** Width / height to reserve for a picture, or undefined for an unknown key. */
export function artAspect(name: string, view?: ArtView): number | undefined {
  const target = parseArtName(name, view);
  return getArt(target.key, target.view)?.aspect;
}

/** `srcset` value for a list of variants. */
export function artSrcSet(variants: readonly ArtVariant[]): string {
  return variants.map((variant) => `${variant.src} ${variant.w}w`).join(", ");
}
