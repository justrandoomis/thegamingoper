/**
 * A short form of a photo manifest, for sending photo manifests to the browser.
 *
 * The server keeps every manifest (app/art/photos/*.json). The browser does NOT get them all in its
 * bundle (that was ~160 KB compressed on every page). Instead:
 *   - each HTML page carries the manifests of the products it shows (app/art/seed.server.ts), so
 *     hydration draws exactly what the server drew;
 *   - the rest arrive later in one small file without the blurred miniatures (`virtual:tt-art-lite`,
 *     built by the Vite plugin in vite.config.ts), before the first client-side navigation.
 *
 * Every file URL follows "/products/<slug>/<n>-<width>.<hash>.<ext>", so only the hashes travel.
 * This module is plain data code: it runs in the Worker, in the browser and in vite.config.ts.
 */
/** The fields of a photo manifest this file reads and writes (app/art/index.ts PhotoManifest has the full, stricter type). */
export interface PhotoManifestShape {
  key: string;
  view: string;
  width: number;
  height: number;
  aspect: number;
  variants: { avif: { w: number; src: string }[]; webp: { w: number; src: string }[] };
  placeholder: string;
  dominant: string;
  transparent: boolean;
  background: string | null;
  kind: string;
  credit: string;
  source: { url: string | null; page: string | null };
  input: string;
  share?: { src: string; width: number; height: number; type: "image/jpeg" | "image/png" };
}
type PhotoManifest = PhotoManifestShape;

export interface CompactPhoto {
  /** key "<slug>--<n>" */
  k: string;
  /** view, only when not "hero" */
  v?: string;
  w: number;
  h: number;
  a: number;
  /** transparent: 1, opaque: 0 */
  t: 0 | 1;
  /** background */
  b: string | null;
  /** kind */
  c: string;
  /** dominant colour */
  d: string;
  /** blurred miniature; "" when not sent */
  p: string;
  /** AVIF widths and hashes */
  x: [number, string][];
  /** WebP widths and hashes */
  y: [number, string][];
  /** share picture: width, height, hash, extension */
  s?: [number, number, string, string];
}

const KEY = /^(.+)--(\d+)$/;
const FILE = /\/(\d+)-(\d+)\.([0-9a-f]+)\.([a-z0-9]+)$/;

function hashOf(src: string): string {
  const match = FILE.exec(src);
  if (!match) throw new Error(`[art] unexpected photo URL ${src}`);
  return match[3];
}

/** True when every URL of the manifest has the standard shape (so the short form can rebuild it). */
export function isCompactable(manifest: PhotoManifest): boolean {
  const key = KEY.exec(manifest.key);
  if (!key) return false;
  const base = `/products/${key[1]}/${key[2]}-`;
  const ok = (src: string, w: number, ext: string) => src.startsWith(base) && FILE.test(src) && src.endsWith(`.${ext}`) && src.slice(base.length).startsWith(`${w}.`);
  return (
    manifest.variants.avif.every((variant) => ok(variant.src, variant.w, "avif")) &&
    manifest.variants.webp.every((variant) => ok(variant.src, variant.w, "webp")) &&
    (!manifest.share || ok(manifest.share.src, manifest.share.width, manifest.share.src.split(".").pop() ?? ""))
  );
}

export function compactPhoto(manifest: PhotoManifest, withPlaceholder: boolean): CompactPhoto {
  const out: CompactPhoto = {
    k: manifest.key,
    w: manifest.width,
    h: manifest.height,
    a: manifest.aspect,
    t: manifest.transparent ? 1 : 0,
    b: manifest.background,
    c: manifest.kind,
    d: manifest.dominant,
    p: withPlaceholder ? manifest.placeholder : "",
    x: manifest.variants.avif.map((variant) => [variant.w, hashOf(variant.src)]),
    y: manifest.variants.webp.map((variant) => [variant.w, hashOf(variant.src)]),
  };
  if (manifest.view !== "hero") out.v = manifest.view;
  if (manifest.share) {
    const ext = manifest.share.src.split(".").pop() ?? "png";
    out.s = [manifest.share.width, manifest.share.height, hashOf(manifest.share.src), ext];
  }
  return out;
}

export function expandPhoto(photo: CompactPhoto): PhotoManifest {
  const key = KEY.exec(photo.k);
  const base = key ? `/products/${key[1]}/${key[2]}-` : "/products/";
  return {
    key: photo.k,
    view: photo.v ?? "hero",
    width: photo.w,
    height: photo.h,
    aspect: photo.a,
    variants: {
      avif: photo.x.map(([w, hash]) => ({ w, src: `${base}${w}.${hash}.avif` })),
      webp: photo.y.map(([w, hash]) => ({ w, src: `${base}${w}.${hash}.webp` })),
    },
    placeholder: photo.p,
    dominant: photo.d,
    transparent: photo.t === 1,
    background: photo.b,
    kind: photo.c,
    // Not needed in the browser (only the server's pages and the admin read them).
    credit: "",
    source: { url: null, page: null },
    input: "",
    share: photo.s
      ? {
          src: `${base}${photo.s[0]}.${photo.s[2]}.${photo.s[3]}`,
          width: photo.s[0],
          height: photo.s[1],
          type: photo.s[3] === "png" ? "image/png" : "image/jpeg",
        }
      : undefined,
  };
}
