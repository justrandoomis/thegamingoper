/**
 * <Art> and the picture registry (app/art): what still applies now that every picture is an official
 * product photo (the clay renders are retired). The photo manifests, their files and the share images
 * are checked by tests/products-images.test.ts; this file covers the component's loading behaviour
 * and the name helpers every caller uses.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Art } from "../app/art/Art";
import { Art as ArtFromIndex, artAspect, artName, artSrcSet, artViews, getArt, hasArt, parseArtName, photoKeys } from "../app/art/index";

const html = (props: Parameters<typeof Art>[0]) => renderToStaticMarkup(createElement(Art, props));
/** Any built photo will do; the first one by key. */
const KEY = photoKeys()[0];

describe("art registry", () => {
  it("has photos to hand out", () => {
    expect(KEY).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*--\d+$/);
  });

  it("parses picture names with and without a view", () => {
    expect(parseArtName("nintendo-switch-2--1")).toEqual({ key: "nintendo-switch-2--1", view: "hero" });
    expect(parseArtName("nintendo-switch-2--1@front")).toEqual({ key: "nintendo-switch-2--1", view: "front" });
    expect(parseArtName("nintendo-switch-2--1@front", "back")).toEqual({ key: "nintendo-switch-2--1", view: "back" });
    expect(artName("nintendo-switch-2--1", "front")).toBe("nintendo-switch-2--1@front");
    expect(artName("nintendo-switch-2--1")).toBe("nintendo-switch-2--1");
  });

  it("knows what is built and what is not; photos have the hero view only", () => {
    expect(hasArt(KEY)).toBe(true);
    expect(getArt(KEY)?.view).toBe("hero");
    expect(getArt(KEY, "front")).toBeUndefined();
    expect(artViews(KEY)).toEqual(["hero"]);
    expect(hasArt("no-such-product--1")).toBe(false);
    expect(artViews("no-such-product--1")).toEqual([]);
    expect(artAspect(KEY)).toBe(getArt(KEY)?.aspect);
    expect(artAspect("no-such-product--1")).toBeUndefined();
  });

  it("writes a srcset in ascending order", () => {
    expect(artSrcSet([{ w: 240, src: "/a.avif" }, { w: 480, src: "/b.avif" }])).toBe("/a.avif 240w, /b.avif 480w");
  });

  it("also exports the component", () => {
    expect(ArtFromIndex).toBe(Art);
  });
});

describe("<Art>", () => {
  it("renders AVIF, then WebP, then the <img> with its intrinsic size", () => {
    const art = getArt(KEY)!;
    const markup = html({ name: KEY, alt: "A product", sizes: "320px", className: "w-full" });
    const avif = markup.indexOf('type="image/avif"'), webp = markup.indexOf('type="image/webp"'), img = markup.indexOf("<img");
    expect(avif).toBeGreaterThan(-1);
    expect(webp).toBeGreaterThan(avif);
    expect(img).toBeGreaterThan(webp);
    expect(markup).toContain(`srcSet="${artSrcSet(art.variants.avif)}"`);
    expect(markup).toContain(`srcSet="${artSrcSet(art.variants.webp)}"`);
    expect(markup).toContain('sizes="320px"');
    expect(markup).toContain(`width="${art.width}"`);
    expect(markup).toContain(`height="${art.height}"`);
    expect(markup).toContain('alt="A product"');
    expect(markup).toContain('class="w-full"');
  });

  it("is lazy by default and shows the blurred miniature until the file loads", () => {
    const markup = html({ name: KEY, alt: "" });
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
    expect(markup).not.toMatch(/fetchpriority/i);
    expect(markup).not.toContain('rel="preload"');
    expect(markup).toContain("background-image:url(&quot;data:image/webp;base64,");
    expect(markup).toContain('alt=""');
  });

  it("loads a priority picture eagerly, with high priority and a preload", () => {
    const markup = html({ name: KEY, alt: "Hero", priority: true, sizes: "480px" });
    expect(markup).toContain('loading="eager"');
    expect(markup).toContain('fetchPriority="high"');
    expect(markup).not.toContain('loading="lazy"');
    expect(markup).toMatch(/<link rel="preload" as="image"[^>]*imageSrcSet="[^"]+\.avif 240w/);
  });

  it("shows the photo for any view a caller asks for", () => {
    expect(html({ name: KEY, view: "front", alt: "" })).toContain(`data-art="${KEY}"`);
    expect(html({ name: `${KEY}@back`, alt: "" })).toContain(`data-art="${KEY}"`);
  });

  it("draws a square placeholder for a key that is not a photo", () => {
    const markup = html({ name: "switch-2", alt: "Coming soon", className: "w-full" });
    expect(markup).not.toContain("<picture");
    expect(markup).toContain('data-art-missing=""');
    expect(markup).toContain('alt="Coming soon"');
    expect(/ width="(\d+)"/.exec(markup)?.[1]).toBe("1600");
    expect(/ height="(\d+)"/.exec(markup)?.[1]).toBe("1600");
  });
});
