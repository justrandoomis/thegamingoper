import type { CSSProperties, SyntheticEvent } from "react";
import { preload } from "react-dom";

import { artAspect, artFallbackSrc, artName, artSrcSet, getArt, isPhoto, parseArtName, parsePhotoKey, type ArtView } from "./index";

export interface ArtProps {
  /** A product photo key "<slug>--<n>" from catalog/products, e.g. "nintendo-switch-2--1". */
  name: string;
  /** Photos have one view, "hero" (the default); another view falls back to it. */
  view?: ArtView;
  /**
   * Required. Say what the picture shows ("Nintendo Switch 2 from the front"), in the page's
   * language. Pass "" when the name is already right next to the picture.
   */
  alt: string;
  /**
   * How wide the picture is drawn, as a `sizes` value — the browser picks the file from it.
   * Example: "(min-width: 768px) 320px, 45vw". The default suits a two-to-four column grid.
   */
  sizes?: string;
  /** Only for the first picture above the fold: loaded at once, with high priority, and preloaded. */
  priority?: boolean;
  /** Classes and styles go on the `<img>`: size it like any image (`w-full`, `h-full object-contain`, …). */
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_SIZES = "(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw";
/** Longer side of a placeholder block. */
const FULL_SIDE = 1600;

/**
 * An official product photo, pre-built in AVIF and WebP at up to five widths. The `<img>` itself
 * names one fallback file: the 720 px WebP (every browser the store supports decodes WebP).
 *
 *   <Art name="nintendo-switch-2--1" alt={image.alt[lang]} className="h-full w-full object-contain" />
 *   <Art name="playstation-5-slim--1" alt="" sizes="(min-width: 768px) 320px, 45vw" className="w-full" />
 *   <Art name="xbox-series-x--1" alt={title} priority sizes="(min-width: 1024px) 480px, 90vw" />
 *
 * It renders a `<picture>` whose `<img>` carries the intrinsic width and height, so the space is
 * reserved before anything loads (give it `height: auto` or a fixed box, as with any image —
 * Tailwind's base styles already do). Until the file arrives a blurred miniature is shown behind it.
 *
 * Most photos are transparent cut-outs. A photo whose background could not be removed safely
 * (manifest `transparent: false`) is drawn in its own rounded frame filled with its recorded
 * background colour, so it sits cleanly on a niche or stage; the radius is `--photo-radius`
 * (default `--r-md`). Every picture carries `data-transparent="true" | "false"` for CSS.
 *
 * A key that has no picture yet draws a flat, translucent block of the expected shape instead (`--line`,
 * so it sits on the floor, a niche or a stage in either theme), and warns in the dev console. Pages
 * can ship before their art does. Ask `hasArt(name)` / `artViews(key)` / `productPhotos(slug)` from
 * "~/art" when a layout must know.
 *
 * Purely presentational and safe on the server; it keeps no state.
 */
export function Art({ name, view, alt, sizes = DEFAULT_SIZES, priority = false, className, style }: ArtProps) {
  const target = parseArtName(name, view);
  const exact = getArt(target.key, target.view);
  // Photos have one view: any other view falls back to it.
  const art = exact ?? (target.view === "hero" ? undefined : getArt(target.key, "hero"));
  const label = artName(target.key, target.view);

  if (!art) {
    const photo = parsePhotoKey(target.key);
    warnOnce(
      label,
      photo
        ? `[Art] "${label}" has no photo yet — showing a placeholder. Check its entry in catalog/products/${photo.slug}.json and run: node scripts/products/images.mjs --only ${photo.slug}`
        : `[Art] "${label}" is not a product photo key ("<slug>--<n>") — showing a placeholder.`,
    );
    const aspect = artAspect(target.key, target.view) ?? artAspect(target.key) ?? 1;
    const width = Math.round(aspect >= 1 ? FULL_SIDE : FULL_SIDE * aspect);
    const height = Math.round(aspect >= 1 ? FULL_SIDE / aspect : FULL_SIDE);
    return (
      <img
        src={placeholderBlock(width, height)}
        width={width}
        height={height}
        alt={alt}
        decoding="async"
        data-art={label}
        data-art-missing=""
        className={className}
        style={{ ...MISSING_STYLE, ...style }}
      />
    );
  }

  if (!exact) warnOnce(label, `[Art] "${label}": photos have one view — showing "${target.key}".`);

  const photo = isPhoto(art) ? art : undefined;
  const opaque = photo !== undefined && !photo.transparent;
  const avif = artSrcSet(art.variants.avif);
  const webp = artSrcSet(art.variants.webp);
  if (priority) {
    // Lets the browser start on the right file before it has parsed the <picture>.
    const middle = art.variants.avif[Math.min(2, art.variants.avif.length - 1)];
    preload(middle.src, { as: "image", type: "image/avif", imageSrcSet: avif, imageSizes: sizes, fetchPriority: "high" });
  }

  return (
    <picture style={PICTURE_STYLE}>
      <source type="image/avif" srcSet={avif} sizes={sizes} />
      <source type="image/webp" srcSet={webp} sizes={sizes} />
      <img
        ref={settle}
        onLoad={onLoad}
        src={artFallbackSrc(art)}
        width={art.width}
        height={art.height}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding={priority ? undefined : "async"}
        fetchPriority={priority ? "high" : undefined}
        data-art={artName(art.key, art.view)}
        data-transparent={opaque ? "false" : "true"}
        className={className}
        style={{ ...blurBehind(art.placeholder), ...(opaque ? frame(photo.background) : null), ...style }}
      />
    </picture>
  );
}

/** The wrapper must not take part in layout: the `<img>` is the element callers size and place. */
const PICTURE_STYLE: CSSProperties = { display: "contents" };

/**
 * An opaque photo: its own rounded frame, filled with the background the photo kept, so the frame
 * continues the photo — also where `object-fit: contain` leaves room around it.
 */
function frame(background: string | null): CSSProperties {
  return { backgroundColor: background ?? undefined, borderRadius: "var(--photo-radius, var(--r-md))" };
}

function blurBehind(placeholder: string): CSSProperties {
  return {
    backgroundImage: `url("${placeholder}")`,
    backgroundSize: "contain",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  };
}

// Most photos are transparent, so the blurred miniature has to go once the real file is in —
// otherwise it would glow around the object. No state: the element is updated directly.
function reveal(img: HTMLImageElement) {
  img.style.backgroundImage = "none";
}

function onLoad(event: SyntheticEvent<HTMLImageElement>) {
  reveal(event.currentTarget);
}

/** Catches pictures that finished loading before React attached `onLoad` (served from cache, slow hydration). */
function settle(img: HTMLImageElement | null) {
  if (img && img.complete && img.naturalWidth > 0) reveal(img);
}

const blocks = new Map<string, string>();

/**
 * The stand-in for a photo that is not built yet. The file is an empty SVG that only carries the
 * shape (an image cannot read the page's tokens); the block itself is painted by `MISSING_STYLE`:
 * the translucent `--line` tint, rounded like a photo frame, so it sits on any surface in both themes.
 */
function placeholderBlock(width: number, height: number): string {
  const key = `${width}x${height}`;
  let uri = blocks.get(key);
  if (!uri) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"/>`;
    uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    blocks.set(key, uri);
  }
  return uri;
}

const MISSING_STYLE: CSSProperties = { backgroundColor: "var(--line)", borderRadius: "var(--photo-radius, var(--r-md))" };

const warned = new Set<string>();

function warnOnce(key: string, message: string) {
  if (!import.meta.env.DEV || warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}
