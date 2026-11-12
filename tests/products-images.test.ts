/**
 * Product photos (scripts/products/images.mjs → app/art/photos + public/products):
 *   - every manifest is valid, matches its files (sizes, content hashes, formats, alpha) and its
 *     entry in catalog/products; AVIF and WebP only (no PNG fallback), plus one share picture per
 *     product on its first photo; public/products holds exactly the files the manifests name;
 *   - the registry and <Art> hand photos out next to the clay renders, opaque photos in a frame,
 *     the 720 px WebP as the <img> fallback;
 *   - the background treatment (scripts/products/lib/cutout.mjs) keeps its promises on synthetic
 *     pictures — above all it never eats into an object; when in doubt the photo stays opaque —
 *     and its per-image options (scripts/products/image-options.json) do what they say.
 * Whether a real cut-out LOOKS right is judged on the review sheets images.mjs writes to
 * .cache/product-images/_sheets/ and on the contact sheets of scripts/products/contact-sheets.mjs.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Art } from "../app/art/Art";
import { artFallbackSrc, artViews, getArt, getPhoto, hasArt, isPhoto, parsePhotoKey, photoKey, photoKeys, productPhotos, productShareImage, type PhotoManifest } from "../app/art/index";
import { PAD, treat, type RawImage } from "../scripts/products/lib/cutout.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFESTS = path.join(ROOT, "app/art/photos");
const PUBLIC = path.join(ROOT, "public");
const CATALOG = path.join(ROOT, "catalog/products");
const OPTIONS = path.join(ROOT, "scripts/products/image-options.json");
const WIDTHS = [240, 480, 720, 960, 1440];
const SHARE_WIDTH = 1200;
const KINDS = ["hero", "angle", "detail", "in-box", "box-art", "screenshot"] as const;
/** Cloudflare Workers static assets: per file, and files per version. */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_FILES = 20_000;

const KEY = /^([a-z0-9]+(?:-[a-z0-9]+)*)--(\d+)$/;
const FILE = /^\/products\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+)-(\d+)\.([0-9a-f]{8})\.(avif|webp|jpg|png)$/;
const HEX = /^#[0-9a-f]{6}$/;
const url = z.string().regex(/^https?:\/\/\S+$/);

const variant = z.object({ w: z.number().int().positive(), src: z.string().regex(FILE) }).strict();
const share = z
  .object({
    src: z.string().regex(FILE).regex(/\.(jpg|png)$/),
    width: z.number().int().positive().max(SHARE_WIDTH),
    height: z.number().int().positive(),
    type: z.enum(["image/jpeg", "image/png"]),
  })
  .strict();
const manifestSchema = z
  .object({
    key: z.string().regex(KEY),
    // "back": the catalogue entry marks a picture of the object's back ("view": "back")
    view: z.enum(["hero", "back"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    aspect: z.number().positive(),
    // no PNG fallback: every browser the store supports decodes WebP
    variants: z.object({ avif: z.array(variant).min(1), webp: z.array(variant).min(1) }).strict(),
    share: share.optional(),
    placeholder: z.string().regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/),
    dominant: z.string().regex(HEX),
    transparent: z.boolean(),
    background: z.string().regex(HEX).nullable(),
    kind: z.enum(KINDS),
    credit: z.string().min(1),
    source: z.object({ url: url.nullable(), page: url.nullable() }).strict(),
    input: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict();

const manifestFiles = existsSync(MANIFESTS) ? readdirSync(MANIFESTS).filter((file) => file.endsWith(".json")).sort() : [];
const manifests = manifestFiles.map((file) => ({ file, manifest: JSON.parse(readFileSync(path.join(MANIFESTS, file), "utf8")) as PhotoManifest }));
const sha8 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);
/** Every public file a manifest names. */
const filesOf = (manifest: PhotoManifest) => [...manifest.variants.avif, ...manifest.variants.webp].map((v) => v.src).concat(manifest.share ? [manifest.share.src] : []);

interface CatalogImage { key: string; kind: string; credit: string; sourceUrl?: string; view?: string; alt?: { en?: string } }
function catalogImages(slug: string): CatalogImage[] | null {
  const file = path.join(CATALOG, `${slug}.json`);
  if (!existsSync(file)) return null;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { images?: CatalogImage[] }).images ?? [];
  } catch {
    return null; // being written by a researcher right now
  }
}

describe.skipIf(manifests.length === 0)("photo manifests", () => {
  it.each(manifests)("$file is valid", ({ file, manifest }) => {
    const parsed = manifestSchema.safeParse(manifest);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(file).toBe(`${manifest.key}.json`);

    expect(Math.abs(manifest.aspect - manifest.width / manifest.height)).toBeLessThan(0.001);
    expect(Math.max(manifest.width, manifest.height)).toBeLessThanOrEqual(1600);
    expect(manifest.placeholder.length).toBeLessThan(800);
    // a transparent photo has no background to frame it with
    if (manifest.transparent) expect(manifest.background).toBeNull();

    for (const format of ["avif", "webp"] as const) {
      const widths = manifest.variants[format].map((v) => v.w);
      expect(widths, `${format} widths ascend`).toEqual([...widths].sort((a, b) => a - b));
      expect(new Set(widths).size).toBe(widths.length);
      // the standard widths, never upscaled; a picture narrower than 480 px also ships at its own width (a 2× screen
      // gets every pixel of a maker's small cut-out), one narrower than 240 px at its own width only
      const standard = WIDTHS.filter((w) => w <= manifest.width);
      expect(widths).toEqual(manifest.width < WIDTHS[1] && !standard.includes(manifest.width) ? [...standard, manifest.width] : standard);
      for (const v of manifest.variants[format]) expect(v.src.endsWith(`.${format}`)).toBe(true);
    }
    expect(manifest.variants.avif.map((v) => v.w)).toEqual(manifest.variants.webp.map((v) => v.w));
  });

  it.each(manifests)("$file matches its catalogue entry", ({ manifest }) => {
    const { slug } = parsePhotoKey(manifest.key)!;
    const images = catalogImages(slug);
    if (images === null) return; // no catalogue file (or one being written): nothing to compare
    const entry = images.find((image) => image.key === manifest.key);
    expect(entry, `${manifest.key} is not in catalog/products/${slug}.json — run node scripts/products/images.mjs to prune it`).toBeDefined();
    expect(manifest.kind).toBe(entry!.kind);
    // a picture of the object's back says so (no tile or lead picture may use it); every other one is the "hero" view
    expect(manifest.view).toBe(entry!.view === "back" ? "back" : "hero");
    if (/^(Back of|Back edge)|rear angle|at the back\b/i.test(entry!.alt?.en ?? "")) expect(entry!.view, `${manifest.key} shows the back: mark it "view": "back"`).toBe("back");
    expect(manifest.credit).toBe(entry!.credit.trim());
    expect(manifest.source.url).toBe(entry!.sourceUrl ?? null);
    // the share picture (og:image) belongs to the product's first image, and only to it
    expect(manifest.share !== undefined, `${manifest.key}: share picture ⇔ first image of ${slug}`).toBe(images[0].key === manifest.key);
  });

  it.each(manifests)("$file points at real files of the stated size, with alpha exactly when transparent", async ({ manifest }) => {
    const { slug, n } = parsePhotoKey(manifest.key)!;
    const shareWidth = Math.min(SHARE_WIDTH, manifest.width);
    const files = [
      ...manifest.variants.avif.map((v) => ({ ...v, format: "heif" })),
      ...manifest.variants.webp.map((v) => ({ ...v, format: "webp" })),
      ...(manifest.share ? [{ w: shareWidth, src: manifest.share.src, format: manifest.transparent ? "png" : "jpeg" }] : []),
    ];
    if (manifest.share) {
      expect(manifest.share.width).toBe(shareWidth);
      expect(manifest.share.type).toBe(manifest.transparent ? "image/png" : "image/jpeg");
      expect(manifest.share.src.endsWith(manifest.transparent ? ".png" : ".jpg")).toBe(true);
    }
    for (const entry of files) {
      const file = path.join(PUBLIC, entry.src);
      expect(existsSync(file), `${entry.src} is missing from public/`).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.length).toBeGreaterThan(100);
      // /products/<slug>/<n>-<width>.<hash of the content>.<ext>: the URL can be cached forever
      const match = FILE.exec(entry.src)!;
      expect(match[1]).toBe(slug);
      expect(Number(match[2])).toBe(n);
      expect(Number(match[3])).toBe(entry.w);
      expect(match[4]).toBe(sha8(bytes));

      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe(entry.format);
      expect(meta.width).toBe(entry.w);
      expect(Math.abs((meta.height ?? 0) - entry.w / manifest.aspect), `${entry.src} keeps the aspect`).toBeLessThanOrEqual(1);
      expect(meta.hasAlpha, `${entry.src}: alpha channel ⇔ transparent`).toBe(manifest.transparent);
      if (entry.src === manifest.share?.src) expect(meta.height).toBe(manifest.share.height);
    }

    // The <img> fallback really is see-through around the object when transparent (padding all round).
    if (manifest.transparent) {
      const fallback = readFileSync(path.join(PUBLIC, artFallbackSrc(manifest)));
      const { data, info } = await sharp(fallback).raw().toBuffer({ resolveWithObject: true });
      const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
      expect((await sharp(fallback).stats()).isOpaque).toBe(false);
      const corners = [alphaAt(0, 0), alphaAt(info.width - 1, 0), alphaAt(0, info.height - 1), alphaAt(info.width - 1, info.height - 1)];
      expect(Math.max(...corners), "transparent corners").toBeLessThan(64);
    }

    const placeholder = await sharp(Buffer.from(manifest.placeholder.split(",")[1], "base64")).metadata();
    expect(placeholder.format).toBe("webp");
    expect(Math.max(placeholder.width ?? 0, placeholder.height ?? 0)).toBeLessThanOrEqual(24);
    expect(placeholder.hasAlpha).toBe(manifest.transparent);
  });

  it("leave public/products holding exactly the files the manifests name, within the Workers limits", () => {
    const referenced = manifests.flatMap(({ manifest }) => filesOf(manifest));
    expect(new Set(referenced).size, "no file is named twice").toBe(referenced.length);
    const root = path.join(PUBLIC, "products");
    const entries = existsSync(root) ? readdirSync(root) : [];
    // only product folders, none of them empty
    expect(entries.filter((entry) => !statSync(path.join(root, entry)).isDirectory()), "loose files in public/products").toEqual([]);
    expect(entries.filter((slug) => readdirSync(path.join(root, slug)).length === 0), "empty folders in public/products").toEqual([]);
    const onDisk = entries.flatMap((slug) => readdirSync(path.join(root, slug)).map((file) => `/products/${slug}/${file}`));
    expect(onDisk.filter((src) => !referenced.includes(src)), "files no manifest names (run node scripts/products/images.mjs to prune them)").toEqual([]);
    expect(referenced.filter((src) => !onDisk.includes(src)), "named files that are missing").toEqual([]);
    expect(onDisk.length).toBeLessThan(MAX_ASSET_FILES / 2);
    expect(onDisk.filter((src) => statSync(path.join(PUBLIC, src)).size > MAX_ASSET_BYTES)).toEqual([]);
  });

  it("give every product with photos exactly one share picture, on its first photo", () => {
    const slugs = new Set(manifests.map(({ manifest }) => parsePhotoKey(manifest.key)!.slug));
    for (const slug of slugs) {
      const images = catalogImages(slug);
      if (!images?.length) continue;
      const shared = productPhotos(slug).filter((photo) => photo.share);
      if (!getPhoto(images[0].key)) continue; // the first photo is not built (yet)
      expect(shared.map((photo) => photo.key), slug).toEqual([images[0].key]);
      expect(productShareImage(slug)).toEqual(getPhoto(images[0].key)!.share);
    }
    expect(productShareImage("no-such-product")).toBeUndefined();
  });

  it("have per-image options only for images in the catalogue, each with a reason", () => {
    if (!existsSync(OPTIONS)) return;
    const options = JSON.parse(readFileSync(OPTIONS, "utf8")) as Record<string, Record<string, unknown>>;
    const known = new Set(readdirSync(CATALOG).filter((file) => file.endsWith(".json")).flatMap((file) => catalogImages(file.slice(0, -5))?.map((image) => image.key) ?? []));
    for (const [key, entry] of Object.entries(options)) {
      if (key.startsWith("$")) continue;
      expect(known.has(key), `${key} is not a catalogue image`).toBe(true);
      expect(typeof entry.why === "string" && entry.why.length > 10, `${key} needs a "why"`).toBe(true);
      // "opaque": the opaque-photo gate accepts this photo after looking (a gift card's printed face, …)
      expect(Object.keys(entry).filter((name) => !["why", "cutout", "holes", "extend", "clean", "pad", "trim", "crop", "opaque"].includes(name))).toEqual([]);
      if ("opaque" in entry) expect(entry.opaque, `${key}: "opaque" is true or absent`).toBe(true);
    }
  });
});

describe("photo registry", () => {
  it("names photos <slug>--<n>", () => {
    expect(photoKey("nintendo-switch-2", 3)).toBe("nintendo-switch-2--3");
    expect(parsePhotoKey("nintendo-switch-2--3")).toEqual({ slug: "nintendo-switch-2", n: 3 });
    expect(parsePhotoKey("nintendo-switch-2-pro-controller--12")).toEqual({ slug: "nintendo-switch-2-pro-controller", n: 12 });
    for (const bad of ["switch-2", "switch-2@front", "dualsense-white--front", "a---1", "--1"]) expect(parsePhotoKey(bad)).toBeUndefined();
  });

  it("knows every built photo and nothing else", () => {
    expect(photoKeys()).toEqual(manifests.map(({ manifest }) => manifest.key).sort());
    expect(getPhoto("no-such-product--1")).toBeUndefined();
    expect(hasArt("no-such-product--1")).toBe(false);
    expect(productPhotos("no-such-product")).toEqual([]);
  });

  it.skipIf(manifests.length === 0)("hands photos out through getArt, in catalogue order per product", () => {
    for (const { manifest } of manifests) {
      const art = getArt(manifest.key);
      expect(art).toBe(getPhoto(manifest.key));
      expect(isPhoto(art)).toBe(true);
      expect(artViews(manifest.key)).toEqual(["hero"]);
    }
    const slug = parsePhotoKey(manifests[0].manifest.key)!.slug;
    const ns = productPhotos(slug).map((photo) => parsePhotoKey(photo.key)!.n);
    expect(ns.length).toBeGreaterThan(0);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
    // renders are not photos
    if (hasArt("switch-2")) expect(isPhoto(getArt("switch-2"))).toBe(false);
  });
});

describe("<Art> with photos", () => {
  const html = (props: Parameters<typeof Art>[0]) => renderToStaticMarkup(createElement(Art, props));
  const opaque = manifests.find(({ manifest }) => !manifest.transparent && manifest.background)?.manifest;
  const transparent = manifests.find(({ manifest }) => manifest.transparent)?.manifest;

  it.skipIf(!opaque)("frames an opaque photo in its own background colour", () => {
    const markup = html({ name: opaque!.key, alt: "photo", className: "w-full" });
    expect(markup).toContain('data-transparent="false"');
    expect(markup).toContain(`background-color:${opaque!.background}`);
    expect(markup).toContain("border-radius:var(--photo-radius, var(--r-md))");
    expect(markup).toContain(`src="${artFallbackSrc(opaque!)}"`);
    expect(markup).toContain(`width="${opaque!.width}"`);
    expect(markup).toContain('class="w-full"');
  });

  it.skipIf(manifests.length === 0)("falls back to the 720 px WebP, never to a PNG", () => {
    for (const { manifest } of manifests) {
      const fallback = artFallbackSrc(manifest);
      expect(fallback.endsWith(".webp")).toBe(true);
      expect(manifest.variants.webp.some((v) => v.src === fallback)).toBe(true);
      const width = Number(FILE.exec(fallback)![3]);
      expect(width).toBe(manifest.width >= 720 ? 720 : manifest.variants.webp[manifest.variants.webp.length - 1].w);
      expect(html({ name: manifest.key, alt: "" })).toContain(`src="${fallback}"`);
    }
  });

  it.skipIf(!transparent)("draws a transparent photo like a render", () => {
    const markup = html({ name: transparent!.key, alt: "photo" });
    expect(markup).toContain('data-transparent="true"');
    expect(markup).not.toContain("border-radius");
    expect(markup).toContain(`data-art="${transparent!.key}"`);
  });

  it("lets the caller's style win over the frame", () => {
    if (!opaque) return;
    expect(html({ name: opaque.key, alt: "", style: { borderRadius: 4 } })).toContain("border-radius:4px");
  });

  it("marks renders as transparent and draws a placeholder for a photo that is not built", () => {
    if (hasArt("switch-2")) expect(html({ name: "switch-2", alt: "" })).toContain('data-transparent="true"');
    const missing = html({ name: "no-such-product--1", alt: "Coming soon" });
    expect(missing).toContain('data-art-missing=""');
    expect(missing).not.toContain("<picture");
    // painted with a token, not with colours baked into the file (the file only carries the shape)
    expect(missing).toContain("background-color:var(--line)");
    expect(decodeURIComponent(/src="data:image\/svg\+xml,([^"]+)"/.exec(missing)![1])).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|fill=/i);
  });
});

/* ── the treatment, on synthetic pictures ──────────────────────────────────── */

type RGB = readonly [number, number, number];
type Shape = (x: number, y: number) => boolean;
const WHITE: RGB = [255, 255, 255];

/** A picture painted with 4×4 supersampling: anti-aliased edges like a real render. */
function paint(width: number, height: number, background: RGB | null, layers: { shape: Shape; colour: RGB | ((x: number, y: number) => RGB) }[]): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, covered = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
          let colour: RGB | null = background;
          for (const layer of layers) if (layer.shape(px, py)) colour = typeof layer.colour === "function" ? layer.colour(px, py) : layer.colour;
          if (!colour) continue;
          r += colour[0]; g += colour[1]; b += colour[2]; covered++;
        }
      }
      const i = (y * width + x) * 4;
      if (covered) { data[i] = Math.round(r / covered); data[i + 1] = Math.round(g / covered); data[i + 2] = Math.round(b / covered); }
      data[i + 3] = Math.round((covered / 16) * 255);
    }
  }
  return { data, width, height };
}

const roundedRect = (cx: number, cy: number, w: number, h: number, r: number): Shape => (x, y) => {
  const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0), dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
};
const circle = (cx: number, cy: number, r: number): Shape => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const minus = (a: Shape, b: Shape): Shape => (x, y) => a(x, y) && !b(x, y);
const rgbaAt = (image: RawImage, x: number, y: number) => Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));

describe("background treatment", () => {
  it("cuts a dark object out of white, centred with padding and without a white halo", () => {
    const out = treat(paint(320, 200, WHITE, [{ shape: roundedRect(160, 100, 160, 90, 18), colour: [40, 42, 46] }]), { kind: "hero" });
    expect(out.method).toBe("cutout");
    expect(out.transparent).toBe(true);
    expect(out.background).toBeNull();
    expect(Math.abs(out.width - 160 * (1 + 2 * PAD))).toBeLessThanOrEqual(3);
    expect(Math.abs(out.height - (90 + 160 * 2 * PAD))).toBeLessThanOrEqual(3);
    const centre = rgbaAt(out, out.width >> 1, out.height >> 1);
    expect(centre[3]).toBe(255);
    expect(Math.abs(centre[0] - 40)).toBeLessThanOrEqual(2);
    expect(rgbaAt(out, 0, 0)[3]).toBe(0);
    let rim = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      const a = out.data[i + 3];
      if (a <= 20 || a >= 235) continue;
      rim++;
      // a rim pixel carries the object's colour, not the white it was blended with
      expect(Math.max(out.data[i], out.data[i + 1], out.data[i + 2])).toBeLessThan(90);
    }
    expect(rim).toBeGreaterThan(50);
  });

  it("removes a soft floor shadow under the object", () => {
    const shadow: Shape = (x, y) => y > 140 && y < 175 && Math.abs(x - 160) < 95;
    const shade = (x: number, y: number): RGB => {
      // darkest at the contact line, fading to white over 30 px and towards the sides
      const v = 255 - 70 * Math.max(0, 1 - (y - 140) / 30) * Math.max(0, 1 - Math.abs(x - 160) / 95);
      return [v, v, v];
    };
    const out = treat(paint(320, 200, WHITE, [{ shape: shadow, colour: shade }, { shape: roundedRect(160, 100, 160, 80, 14), colour: [40, 42, 46] }]), { kind: "angle" });
    expect(out.method).toBe("cutout");
    expect(Number(out.stats.shadow)).toBeGreaterThan(0);
    // trimmed to the object: the shadow did not widen the picture downwards
    expect(Math.abs(out.height - (80 + 160 * 2 * PAD))).toBeLessThanOrEqual(4);
  });

  it("keeps white lettering inside a dark object", () => {
    const body = roundedRect(160, 100, 180, 110, 16);
    const letters: Shape = (x, y) => y > 92 && y < 108 && x > 110 && x < 210 && Math.floor((x - 110) / 10) % 2 === 0;
    const out = treat(paint(320, 200, WHITE, [{ shape: body, colour: [30, 30, 34] }, { shape: letters, colour: WHITE }]), { kind: "hero" });
    expect(out.method).toBe("cutout");
    const cx = out.width >> 1, cy = out.height >> 1;
    // the middle of the lettering row is opaque white, not a hole
    let opaqueWhite = 0;
    for (let x = cx - 50; x < cx + 50; x++) { const [r, , , a] = rgbaAt(out, x, cy); if (a === 255 && r > 240) opaqueWhite++; }
    expect(opaqueWhite).toBeGreaterThan(30);
  });

  it("never eats a near-white object whose outline has a gap: it stays opaque", () => {
    const body = roundedRect(160, 100, 160, 90, 18);
    const outline = minus(roundedRect(160, 100, 166, 96, 21), body);
    const gap: Shape = (x, y) => x < 100 && y > 88 && y < 112;
    const out = treat(paint(320, 200, WHITE, [
      { shape: body, colour: [250, 250, 250] }, // ≈ 2 ΔE from the background
      { shape: minus(outline, gap), colour: [150, 150, 150] },
      { shape: circle(200, 100, 9), colour: [30, 30, 30] },
    ]), { kind: "hero" });
    expect(out.transparent).toBe(false);
    expect(out.method).toBe("opaque");
    expect(out.background).toBe("#ffffff");
  });

  it("keeps an object with only faint edges opaque (white on white)", () => {
    const out = treat(paint(320, 200, WHITE, [{ shape: roundedRect(160, 100, 160, 90, 18), colour: [244, 244, 244] }, { shape: circle(160, 100, 12), colour: [40, 40, 40] }]), { kind: "hero" });
    expect(out.transparent).toBe(false);
    expect(out.reason).toBeTruthy();
  });

  it("keeps a strap loop opaque: closed background windows behind a thin wall", () => {
    const loop = minus(circle(160, 100, 70), circle(160, 100, 67));
    const out = treat(paint(320, 200, WHITE, [{ shape: loop, colour: [35, 35, 35] }, { shape: roundedRect(160, 30, 60, 30, 8), colour: [35, 35, 35] }]), { kind: "detail" });
    expect(out.transparent).toBe(false);
    expect(out.reason).toMatch(/closed shapes/);
  });

  it("keeps a large enclosed gap between two thick bands opaque (a headband and its suspension band)", () => {
    const outer = minus(circle(160, 150, 120), circle(160, 150, 104));
    const inner = minus(circle(160, 150, 80), circle(160, 150, 66));
    const top: Shape = (x, y) => y < 150;
    const ends: Shape = (x, y) => y >= 140 && y < 150 && ((x > 38 && x < 96) || (x > 224 && x < 282));
    const out = treat(paint(320, 200, WHITE, [{ shape: (x, y) => (outer(x, y) || inner(x, y)) && top(x, y), colour: [40, 42, 46] }, { shape: ends, colour: [40, 42, 46] }]), { kind: "hero" });
    expect(out.transparent).toBe(false);
    expect(out.reason).toMatch(/closed shapes/);
  });

  it("keeps a small zip-pull loop on a large object opaque too", () => {
    const body = roundedRect(150, 100, 220, 120, 30);
    const pull = minus(circle(275, 100, 14), circle(275, 100, 10));
    const out = treat(paint(320, 200, WHITE, [{ shape: body, colour: [40, 42, 46] }, { shape: roundedRect(262, 100, 8, 4, 1), colour: [40, 42, 46] }, { shape: pull, colour: [40, 120, 80] }]), { kind: "hero" });
    expect(out.transparent).toBe(false);
    expect(out.reason).toMatch(/closed shapes/);
  });

  it("keeps an object cropped by the frame opaque and untrimmed", () => {
    const image = paint(320, 200, WHITE, [{ shape: roundedRect(60, 100, 160, 90, 18), colour: [40, 42, 46] }]);
    const out = treat(image, { kind: "hero" });
    expect(out.transparent).toBe(false);
    expect(out.background).toBe("#ffffff");
    expect([out.width, out.height]).toEqual([320, 200]);
  });

  it("trims an opaque fallback to its content plus padding, on its own background", () => {
    // faint edges → opaque; the white margin is trimmed and the new margin is the same white
    const out = treat(paint(400, 300, WHITE, [{ shape: roundedRect(200, 150, 120, 80, 12), colour: [244, 244, 244] }, { shape: circle(200, 150, 10), colour: [40, 40, 40] }]), { kind: "hero" });
    expect(out.method).toBe("opaque");
    expect(out.width).toBeLessThan(400);
    expect(out.width).toBeGreaterThanOrEqual(120);
    expect(rgbaAt(out, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it("leaves box art and screenshots as they are", () => {
    const cover = paint(150, 240, null, []);
    for (let i = 0; i < cover.data.length; i += 4) { cover.data[i] = (i / 4) % 150; cover.data[i + 1] = 80; cover.data[i + 2] = 160; cover.data[i + 3] = 255; }
    for (const kind of ["box-art", "screenshot"] as const) {
      const out = treat(cover, { kind });
      expect(out.method).toBe("untouched");
      expect(out.transparent).toBe(false);
      expect(out.background).toBeNull();
      expect([out.width, out.height]).toEqual([150, 240]);
      expect(Buffer.from(out.data).equals(Buffer.from(cover.data))).toBe(true);
    }
  });

  it("never crops a cover whose own frame is a plain dark colour", () => {
    const frame = roundedRect(75, 120, 150, 240, 0);
    const art = roundedRect(75, 120, 120, 200, 0);
    const out = treat(paint(150, 240, null, [{ shape: frame, colour: [60, 20, 90] }, { shape: art, colour: (x, y) => [x, y, 120] }]), { kind: "box-art" });
    expect(out.method).toBe("untouched");
    expect([out.width, out.height]).toEqual([150, 240]);
  });

  it("keeps real transparency, trimmed to the object plus padding", () => {
    const out = treat(paint(400, 300, null, [{ shape: roundedRect(200, 150, 100, 60, 10), colour: [200, 30, 40] }]), { kind: "angle" });
    expect(out.method).toBe("alpha");
    expect(out.transparent).toBe(true);
    expect(Math.abs(out.width - 100 * (1 + 2 * PAD))).toBeLessThanOrEqual(2);
    expect(Math.abs(out.height - (60 + 100 * 2 * PAD))).toBeLessThanOrEqual(2);
    expect(rgbaAt(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("is deterministic", () => {
    const image = paint(320, 200, WHITE, [{ shape: roundedRect(160, 100, 160, 90, 18), colour: [40, 42, 46] }]);
    expect(Buffer.from(treat(image).data).equals(Buffer.from(treat(image).data))).toBe(true);
  });
});

describe("per-image options of the treatment", () => {
  const dark = () => paint(320, 200, WHITE, [{ shape: roundedRect(160, 100, 160, 90, 18), colour: [40, 42, 46] }]);
  const headband = () => {
    const outer = minus(circle(160, 150, 120), circle(160, 150, 104));
    const inner = minus(circle(160, 150, 80), circle(160, 150, 66));
    const ends: Shape = (x, y) => y >= 140 && y < 150 && ((x > 38 && x < 96) || (x > 224 && x < 282));
    return paint(320, 200, WHITE, [{ shape: (x, y) => (outer(x, y) || inner(x, y)) && y < 150, colour: [40, 42, 46] }, { shape: ends, colour: [40, 42, 46] }]);
  };
  /** Runs of opaque (alpha ≥ 128) pixels down the middle column. */
  const opaqueRuns = (image: RawImage) => {
    let runs = 0, inside = false;
    for (let y = 0; y < image.height; y++) {
      const opaque = rgbaAt(image, image.width >> 1, y)[3] >= 128;
      if (opaque && !inside) runs++;
      inside = opaque;
    }
    return runs;
  };

  it("cutout false keeps a clean photo opaque, trimmed on its own background", () => {
    expect(treat(dark()).method).toBe("cutout");
    const out = treat(dark(), { cutout: false });
    expect(out.method).toBe("opaque");
    expect(out.transparent).toBe(false);
    expect(out.background).toBe("#ffffff");
    expect(out.reason).toMatch(/image option/);
    expect(Math.abs(out.width - 160 * (1 + 2 * PAD))).toBeLessThanOrEqual(3);
    expect(rgbaAt(out, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it("trim false keeps the whole frame of an opaque photo", () => {
    const out = treat(dark(), { cutout: false, trim: false });
    expect(out.method).toBe("opaque");
    expect([out.width, out.height]).toEqual([320, 200]);
  });

  it("pad sets the padding of a trimmed object", () => {
    const out = treat(dark(), { pad: 0.12 });
    expect(out.method).toBe("cutout");
    expect(Math.abs(out.width - 160 * 1.24)).toBeLessThanOrEqual(3);
    expect(Math.abs(out.height - (90 + 160 * 0.24))).toBeLessThanOrEqual(3);
    expect(() => treat(dark(), { pad: 0.5 })).toThrow();
  });

  it("holes true cuts out the window between two bands instead of keeping the photo opaque", () => {
    expect(treat(headband()).transparent).toBe(false);
    const out = treat(headband(), { holes: true });
    expect(out.method).toBe("cutout");
    expect(Number(out.stats.holes)).toBeGreaterThan(0);
    // down the middle: outer band, window (now see-through), inner band
    expect(opaqueRuns(out)).toBe(2);
    // the bands keep their colour up to the cut, no white rim around the window
    for (let i = 0; i < out.data.length; i += 4) {
      const a = out.data[i + 3];
      if (a > 20 && a < 235) expect(Math.max(out.data[i], out.data[i + 1], out.data[i + 2])).toBeLessThan(90);
    }
  });

  it("holes true never opens a light part that is not the background colour", () => {
    // a light grey panel (≈ 8 ΔE from white) inside a dark ring stays opaque
    const ring = minus(circle(160, 100, 80), circle(160, 100, 60));
    const out = treat(paint(320, 200, WHITE, [{ shape: ring, colour: [40, 42, 46] }, { shape: circle(160, 100, 60), colour: [225, 225, 225] }]), { holes: true });
    expect(out.method).toBe("cutout");
    const centre = rgbaAt(out, out.width >> 1, out.height >> 1);
    expect(centre[3]).toBe(255);
    expect(centre[0]).toBeGreaterThan(215);
  });
});
