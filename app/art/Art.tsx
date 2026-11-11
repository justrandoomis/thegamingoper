import type { CSSProperties, SyntheticEvent } from "react";
import { preload } from "react-dom";

import { artAspect, artName, artSrcSet, getArt, isPhoto, parseArtName, parsePhotoKey, type ArtView } from "./index";

export interface ArtProps {
  /**
   * Art key from scripts/art/catalog.json, e.g. "switch-2" ("switch-2@front" also selects a view),
   * or a product photo key "<slug>--<n>" from catalog/products, e.g. "nintendo-switch-2--1".
   */
  name: string;
  /** "hero" (three-quarter, the default), "front" or "back". */
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
/** Longer side of a full render; placeholders use the same so both lay out alike. */
const FULL_SIDE = 1600;

/**
 * A TamTam clay render or product photo, pre-built in AVIF and WebP at up to five widths with a PNG
 * fallback.
 *
 *   <Art name="switch-2" alt={t("switch2")} sizes="(min-width: 768px) 320px, 45vw" className="w-full" />
 *   <Art name="ps5-slim" view="front" alt="" className="h-full w-full object-contain" />
 *   <Art name="xbox-series-x" alt={title} priority sizes="(min-width: 1024px) 480px, 90vw" />
 *   <Art name="nintendo-switch-2--1" alt={image.alt[lang]} className="h-full w-full object-contain" />
 *
 * It renders a `<picture>` whose `<img>` carries the intrinsic width and height, so the space is
 * reserved before anything loads (give it `height: auto` or a fixed box, as with any image —
 * Tailwind's base styles already do). Until the file arrives a blurred miniature is shown behind it.
 *
 * Renders and most photos are transparent. A photo whose background could not be removed safely
 * (manifest `transparent: false`) is drawn in its own rounded frame filled with its recorded
 * background colour, so it sits cleanly on a niche or stage; the radius is `--photo-radius`
 * (default `--r-md`). Every picture carries `data-transparent="true" | "false"` for CSS.
 *
 * A key that has no picture yet draws a neutral clay block of the expected shape instead, and warns
 * in the dev console. Pages can ship before their art does. Ask `hasArt(name)` / `artViews(key)` /
 * `productPhotos(slug)` from "~/art" when a layout must know.
 *
 * Purely presentational and safe on the server; it keeps no state.
 */
export function Art({ name, view, alt, sizes = DEFAULT_SIZES, priority = false, className, style }: ArtProps) {
  const target = parseArtName(name, view);
  const exact = getArt(target.key, target.view);
  // A view that is not rendered falls back to the hero picture of the same object.
  const art = exact ?? (target.view === "hero" ? undefined : getArt(target.key, "hero"));
  const label = artName(target.key, target.view);

  if (!art) {
    const photo = parsePhotoKey(target.key);
    warnOnce(
      label,
      photo
        ? `[Art] "${label}" has no photo yet — showing a placeholder. Check its entry in catalog/products/${photo.slug}.json and run: node scripts/products/images.mjs --only ${photo.slug}`
        : `[Art] "${label}" has no render yet — showing a placeholder. Add scripts/art/models/${target.key}.mjs and run: node scripts/art/build.mjs --only=${target.key}`,
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
        style={style}
      />
    );
  }

  if (!exact) warnOnce(label, `[Art] "${label}" is not rendered — showing the hero view of "${target.key}" instead.`);

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
        src={art.variants.png}
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

// The pictures are transparent, so the blurred miniature has to go once the real file is in —
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
 * The stand-in for art that is not rendered yet: a soft, rounded, neutral block with the same
 * padding as a real render. Translucent greys only, so it sits on light and dark surfaces alike.
 */
function placeholderBlock(width: number, height: number): string {
  const key = `${width}x${height}`;
  let uri = blocks.get(key);
  if (!uri) {
    const pad = Math.round(Math.max(width, height) * 0.08);
    const w = width - 2 * pad;
    const h = height - 2 * pad;
    const radius = Math.round(Math.min(w, h) * 0.14);
    const box = `x="${pad}" y="${pad}" width="${w}" height="${h}" rx="${radius}"`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#fff" stop-opacity=".14"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="#000" stop-opacity=".07"/></linearGradient></defs>` +
      `<rect ${box} fill="#8b8d93" fill-opacity=".17"/><rect ${box} fill="url(#g)"/></svg>`;
    uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    blocks.set(key, uri);
  }
  return uri;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string) {
  if (!import.meta.env.DEV || warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}
