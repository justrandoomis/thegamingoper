/**
 * Clay renders: every manifest in app/art/manifest is valid and consistent with the files in
 * public/art, the registry and <Art> hand them out correctly, and art that is not rendered yet
 * degrades to a placeholder of the right shape. (Whether a render LOOKS right is judged by eye on
 * the contact sheets that scripts/art/build.mjs writes.)
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Art } from "../app/art/Art";
import { Art as ArtFromIndex, artAspect, artName, artNames, artSrcSet, artViews, getArt, hasArt, parseArtName } from "../app/art/index";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFESTS = path.join(ROOT, "app/art/manifest");
const PUBLIC = path.join(ROOT, "public");
const WIDTHS = [240, 480, 720, 960, 1440];
const VIEWS = ["hero", "front", "back"] as const;

const variant = z.object({ w: z.number().int().positive(), src: z.string().regex(/^\/art\/[a-z0-9-]+-\d+\.[0-9a-f]{8}\.(avif|webp)$/) }).strict();
const manifestSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    view: z.enum(VIEWS),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    aspect: z.number().positive(),
    variants: z.object({ avif: z.array(variant).min(1), webp: z.array(variant).min(1), png: z.string().regex(/^\/art\/[a-z0-9-]+-\d+\.[0-9a-f]{8}\.png$/) }).strict(),
    placeholder: z.string().regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/),
    dominant: z.string().regex(/^#[0-9a-f]{6}$/),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;

interface CatalogItem { key: string; views?: string[]; mm?: number[] }
const catalog = JSON.parse(readFileSync(path.join(ROOT, "scripts/art/catalog.json"), "utf8")) as {
  items: CatalogItem[];
  games: { items: { slug: string }[] };
};
/** key → views, for hardware and for game cases ("game-<slug>", hero only). */
const catalogViews = new Map<string, string[]>([
  ...catalog.items.map((item): [string, string[]] => [item.key, item.views ?? ["hero"]]),
  ...catalog.games.items.map((game): [string, string[]] => [`game-${game.slug}`, ["hero"]]),
]);

const manifestFiles = readdirSync(MANIFESTS).filter((file) => file.endsWith(".json") && !file.startsWith("_")).sort();
const manifests = manifestFiles.map((file) => ({ file, manifest: JSON.parse(readFileSync(path.join(MANIFESTS, file), "utf8")) as Manifest }));
const fileOf = (src: string) => path.join(PUBLIC, src);
const sha8 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);

describe("art manifests", () => {
  it("exist for the first three consoles, in every view the catalogue lists", () => {
    for (const key of ["switch-2", "ps5-slim", "xbox-series-x"]) {
      for (const view of catalogViews.get(key) ?? []) {
        expect(manifestFiles, `${key} @ ${view}`).toContain(view === "hero" ? `${key}.json` : `${key}--${view}.json`);
      }
    }
  });

  it.each(manifests)("$file is valid", ({ file, manifest }) => {
    const parsed = manifestSchema.safeParse(manifest);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);

    // named after its key and view; "@" is written "--" in file names
    expect(file).toBe(`${artName(manifest.key, manifest.view).replace("@", "--")}.json`);
    // only art the catalogue knows, in a view the catalogue lists for it
    expect(catalogViews.get(manifest.key), `${manifest.key} is not in scripts/art/catalog.json`).toBeDefined();
    expect(catalogViews.get(manifest.key)).toContain(manifest.view);

    expect(Math.abs(manifest.aspect - manifest.width / manifest.height)).toBeLessThan(0.001);
    expect(Math.max(manifest.width, manifest.height)).toBeLessThanOrEqual(1700);
    expect(manifest.placeholder.length).toBeLessThan(1400);

    for (const format of ["avif", "webp"] as const) {
      const widths = manifest.variants[format].map((v) => v.w);
      expect(widths, `${format} widths ascend`).toEqual([...widths].sort((a, b) => a - b));
      expect(new Set(widths).size).toBe(widths.length);
      // the standard widths, never upscaled; a picture narrower than 240 px ships at its own width
      expect(widths).toEqual(manifest.width >= WIDTHS[0] ? WIDTHS.filter((w) => w <= manifest.width) : [manifest.width]);
      for (const v of manifest.variants[format]) expect(v.src.endsWith(`.${format}`)).toBe(true);
    }
    expect(manifest.variants.avif.map((v) => v.w)).toEqual(manifest.variants.webp.map((v) => v.w));
  });

  it.each(manifests)("$file points at real image files of the stated size", async ({ manifest }) => {
    const name = artName(manifest.key, manifest.view).replace("@", "--");
    const files = [
      ...manifest.variants.avif.map((v) => ({ ...v, format: "heif" })),
      ...manifest.variants.webp.map((v) => ({ ...v, format: "webp" })),
      { w: Math.min(720, manifest.width), src: manifest.variants.png, format: "png" },
    ];
    for (const entry of files) {
      expect(existsSync(fileOf(entry.src)), `${entry.src} is missing from public/`).toBe(true);
      const bytes = readFileSync(fileOf(entry.src));
      expect(bytes.length).toBeGreaterThan(200);
      // the file name carries the width and a hash of the content (the URL can be cached forever)
      const match = /^\/art\/(.+)-(\d+)\.([0-9a-f]{8})\.[a-z]+$/.exec(entry.src);
      expect(match?.[1]).toBe(name);
      expect(Number(match?.[2])).toBe(entry.w);
      expect(match?.[3]).toBe(sha8(bytes));

      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe(entry.format);
      expect(meta.width).toBe(entry.w);
      expect(Math.abs((meta.height ?? 0) - entry.w / manifest.aspect)).toBeLessThanOrEqual(1);
      expect(meta.hasAlpha, `${entry.src} must keep its transparent background`).toBe(true);
    }
    const placeholder = await sharp(Buffer.from(manifest.placeholder.split(",")[1], "base64")).metadata();
    expect(placeholder.format).toBe("webp");
    expect(placeholder.width).toBeLessThanOrEqual(32);
  });

  it("leave no orphaned files in public/art", () => {
    const referenced = new Set(manifests.flatMap(({ manifest }) => [...manifest.variants.avif, ...manifest.variants.webp].map((v) => v.src).concat(manifest.variants.png)));
    const onDisk = existsSync(path.join(PUBLIC, "art")) ? readdirSync(path.join(PUBLIC, "art")).map((file) => `/art/${file}`) : [];
    expect(onDisk.filter((src) => !referenced.has(src))).toEqual([]);
  });

  it("come with a placeholder shape for every picture in the catalogue", () => {
    const expected = JSON.parse(readFileSync(path.join(MANIFESTS, "_expected.json"), "utf8")) as Record<string, number>;
    for (const [key, views] of catalogViews) {
      for (const view of views) {
        const aspect = expected[artName(key, view as (typeof VIEWS)[number])];
        expect(aspect, `${key} @ ${view}`).toBeGreaterThan(0.1);
        expect(aspect).toBeLessThan(10);
      }
    }
  });
});

describe("art registry", () => {
  it("finds a picture by key, by key@view and by key + view", () => {
    expect(getArt("switch-2")?.view).toBe("hero");
    expect(getArt("switch-2@front")?.view).toBe("front");
    expect(getArt("switch-2", "back")?.view).toBe("back");
    expect(getArt("switch-2@front", "back")?.view).toBe("back");
    expect(parseArtName("game-halo-infinite")).toEqual({ key: "game-halo-infinite", view: "hero" });
    expect(parseArtName("ps5-slim@back")).toEqual({ key: "ps5-slim", view: "back" });
    expect(artName("ps5-slim", "front")).toBe("ps5-slim@front");
    expect(artName("ps5-slim")).toBe("ps5-slim");
  });

  it("knows what is rendered and what is not", () => {
    expect(hasArt("xbox-series-x")).toBe(true);
    expect(hasArt("no-such-device")).toBe(false);
    expect(getArt("no-such-device")).toBeUndefined();
    expect(artViews("ps5-slim")).toEqual(["hero", "front", "back"]);
    expect(artViews("no-such-device")).toEqual([]);
    expect(artNames()).toEqual(manifests.map(({ manifest }) => artName(manifest.key, manifest.view)).sort());
  });

  it("reserves the real shape for rendered art and the catalogue estimate for the rest", () => {
    expect(artAspect("switch-2")).toBe(getArt("switch-2")?.aspect);
    const pending = [...catalogViews.keys()].find((key) => !hasArt(key));
    if (pending) expect(artAspect(pending)).toBeGreaterThan(0);
    expect(artAspect("no-such-device")).toBeUndefined();
  });

  it("writes a srcset in ascending order", () => {
    expect(artSrcSet([{ w: 240, src: "/a.avif" }, { w: 480, src: "/b.avif" }])).toBe("/a.avif 240w, /b.avif 480w");
  });

  it("also exports the component", () => {
    expect(ArtFromIndex).toBe(Art);
  });
});

describe("<Art>", () => {
  const html = (props: Parameters<typeof Art>[0]) => renderToStaticMarkup(createElement(Art, props));

  it("renders AVIF, then WebP, then a PNG <img> with its intrinsic size", () => {
    const art = getArt("switch-2")!;
    const markup = html({ name: "switch-2", alt: "Nintendo Switch 2", sizes: "320px", className: "w-full" });
    const avif = markup.indexOf('type="image/avif"'), webp = markup.indexOf('type="image/webp"'), img = markup.indexOf("<img");
    expect(avif).toBeGreaterThan(-1);
    expect(webp).toBeGreaterThan(avif);
    expect(img).toBeGreaterThan(webp);
    expect(markup).toContain(`srcSet="${artSrcSet(art.variants.avif)}"`);
    expect(markup).toContain(`srcSet="${artSrcSet(art.variants.webp)}"`);
    expect(markup).toContain('sizes="320px"');
    expect(markup).toContain(`src="${art.variants.png}"`);
    expect(markup).toContain(`width="${art.width}"`);
    expect(markup).toContain(`height="${art.height}"`);
    expect(markup).toContain('alt="Nintendo Switch 2"');
    expect(markup).toContain('class="w-full"');
  });

  it("is lazy by default and shows the blurred miniature until the file loads", () => {
    const markup = html({ name: "ps5-slim", alt: "" });
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
    expect(markup).not.toMatch(/fetchpriority/i);
    expect(markup).not.toContain('rel="preload"');
    expect(markup).toContain("background-image:url(&quot;data:image/webp;base64,");
    expect(markup).toContain('alt=""');
  });

  it("loads a priority picture eagerly, with high priority and a preload", () => {
    const markup = html({ name: "xbox-series-x", alt: "Xbox Series X", priority: true, sizes: "480px" });
    expect(markup).toContain('loading="eager"');
    expect(markup).toContain('fetchPriority="high"');
    expect(markup).not.toContain('loading="lazy"');
    expect(markup).toMatch(/<link rel="preload" as="image"[^>]*imageSrcSet="[^"]+\.avif 240w/);
  });

  it("selects a view by prop or by suffix", () => {
    expect(html({ name: "switch-2", view: "front", alt: "" })).toContain('data-art="switch-2@front"');
    expect(html({ name: "switch-2@back", alt: "" })).toContain('data-art="switch-2@back"');
    expect(html({ name: "switch-2@back", alt: "" })).toContain(getArt("switch-2@back")!.variants.png);
  });

  it("draws a placeholder of the expected shape for art that is not rendered yet", () => {
    const pending = [...catalogViews.keys()].find((key) => !hasArt(key));
    for (const name of [pending, "no-such-device"]) {
      if (!name) continue;
      const markup = html({ name, alt: "Coming soon", className: "w-full" });
      expect(markup).not.toContain("<picture");
      expect(markup).toContain('data-art-missing=""');
      expect(markup).toContain('src="data:image/svg+xml,');
      expect(markup).toContain('alt="Coming soon"');
      const width = Number(/ width="(\d+)"/.exec(markup)?.[1]), height = Number(/ height="(\d+)"/.exec(markup)?.[1]);
      expect(Math.abs(width / height - (artAspect(name) ?? 1))).toBeLessThan(0.02);
      expect(Math.max(width, height)).toBe(1600);
    }
  });
});
