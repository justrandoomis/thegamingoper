/**
 * Brand mark and icons: the generated files are present, consistent with each other, and the
 * components render what they promise. (How faithful the logo trace is to the source screenshot
 * is measured by scripts/logo/trace.mjs and checked by eye with scripts/logo/compare.mjs.)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Icon } from "../app/art/Icon";
import { ICON_GROUPS, ICON_NAMES, ICON_SPRITE_HREF, ICONS_MIRRORED_IN_RTL, ICONS_WITH_FILL } from "../app/art/icons/names";
import { Logo, logoAspectRatio } from "../app/art/Logo";
import { LOGO_IS_PROVISIONAL, LOGO_LAYOUTS, LOGO_LOCKUP, LOGO_PARTS, type LogoPartId, type LogoVariant } from "../app/art/logo/parts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = (relative: string) => path.join(ROOT, relative);
const text = (relative: string) => readFileSync(file(relative), "utf8");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Every number in SVG path data. */
const numbersIn = (d: string) => (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);

describe("icon sprite", () => {
  const sprite = text("public/icons.svg");
  const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]);

  it("contains exactly the symbols listed in names.ts", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ICON_NAMES].sort());
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(120);
  });

  it("draws every symbol in currentColor on the 256 grid, with nothing but shapes inside", () => {
    const symbols = [...sprite.matchAll(/<symbol id="([^"]+)" viewBox="0 0 256 256" fill="currentColor">(.*?)<\/symbol>/gs)];
    expect(symbols.length).toBe(ICON_NAMES.length);
    for (const [, id, body] of symbols) {
      expect(body.length, id).toBeGreaterThan(20);
      expect(body, id).not.toMatch(/(?:fill|stroke)="(?!currentColor|none)/);
      expect(body, id).not.toMatch(/<(?:script|style|foreignObject|image|use)\b|\son\w+=|href=/i);
    }
  });

  it("has the filled weight for every icon that claims one, and only directional icons are mirrored", () => {
    const names = new Set<string>(ICON_NAMES);
    for (const name of ICONS_WITH_FILL) expect(names.has(`${name}-fill`), `${name}-fill`).toBe(true);
    for (const name of ICON_NAMES) if (name.endsWith("-fill")) expect(ICONS_WITH_FILL.has(name.slice(0, -5) as never), name).toBe(true);
    for (const name of ICONS_MIRRORED_IN_RTL) expect(names.has(name), name).toBe(true);
    for (const name of ["arrow-left", "arrow-right", "caret-left", "caret-right"] as const) expect(ICONS_MIRRORED_IN_RTL.has(name)).toBe(true);
    for (const name of ["arrow-up", "caret-down", "magnifying-glass", "arrows-clockwise", "chart-line"] as const) expect(ICONS_MIRRORED_IN_RTL.has(name)).toBe(false);
  });

  it("groups cover every regular icon once", () => {
    const grouped = Object.values(ICON_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(ICON_NAMES.filter((name) => !name.endsWith("-fill")).sort());
  });

  it("is addressed with a revision that matches its content", () => {
    expect(ICON_SPRITE_HREF).toMatch(/^\/icons\.svg\?r=[0-9a-f]{10}$/);
    // The same digest scripts/icons.mjs writes: a stale names.ts or a hand-edited sprite fails here.
    expect(ICON_SPRITE_HREF.split("=")[1]).toBe(createHash("sha256").update(sprite).digest("hex").slice(0, 10));
  });
});

describe("<Icon>", () => {
  const render = (props: Parameters<typeof Icon>[0]) => renderToStaticMarkup(createElement(Icon, props));

  it("is decorative by default and points at the sprite symbol", () => {
    const html = render({ name: "house" });
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).toContain(`<use href="${ICON_SPRITE_HREF}#house"`);
    expect(html).toContain('width="20"');
    expect(html).not.toContain("role=");
    expect(html).not.toContain("<title");
  });

  it("becomes a named image when given a title or an aria-label", () => {
    const titled = render({ name: "warning", title: "المخزون منخفض" });
    expect(titled).toContain('role="img"');
    expect(titled).toMatch(/aria-labelledby="([^"]+)"[^>]*>.*<title id="\1">المخزون منخفض<\/title>/s);
    expect(titled).not.toContain("aria-hidden");
    const labelled = render({ name: "warning", "aria-label": "Low stock" });
    expect(labelled).toContain('role="img"');
    expect(labelled).not.toContain("aria-hidden");
  });

  it("uses the filled weight only where the sprite has one", () => {
    expect(render({ name: "heart", filled: true })).toContain("#heart-fill");
    expect(render({ name: "truck", filled: true })).toContain("#truck\"");
  });

  it("mirrors directional icons in rtl, and only those unless told otherwise", () => {
    expect(render({ name: "arrow-left" })).toContain("rtl:-scale-x-100");
    expect(render({ name: "arrow-left", mirror: false })).not.toContain("rtl:-scale-x-100");
    expect(render({ name: "arrow-up" })).not.toContain("rtl:-scale-x-100");
    expect(render({ name: "heart", mirror: true })).toContain("rtl:-scale-x-100");
    expect(render({ name: "house", className: "text-brand" })).toContain('class="shrink-0 text-brand"');
  });
});

describe("logo artwork", () => {
  const partIds = Object.keys(LOGO_PARTS) as LogoPartId[];

  it("has four non-empty parts inside the lockup", () => {
    expect(partIds.sort()).toEqual(["games", "latin", "mascot", "wordmark"]);
    expect(LOGO_LOCKUP.width).toBeGreaterThan(0);
    expect(LOGO_LOCKUP.height).toBeGreaterThan(0);
    for (const id of partIds) {
      const { d, box } = LOGO_PARTS[id];
      expect(d.length, id).toBeGreaterThan(200);
      expect(d, id).toMatch(/^M-?[\d.]+ ?-?[\d.]+[clhv]/);
      expect(d.endsWith("z"), id).toBe(true);
      expect(d, id).not.toMatch(/NaN|Infinity|undefined/);
      expect(numbersIn(d).every(Number.isFinite), id).toBe(true);
      const [x, y, width, height] = box;
      expect(width, id).toBeGreaterThan(10);
      expect(height, id).toBeGreaterThan(10);
      expect(x, id).toBeGreaterThanOrEqual(-0.5);
      expect(y, id).toBeGreaterThanOrEqual(-0.5);
      expect(x + width, id).toBeLessThanOrEqual(LOGO_LOCKUP.width + 0.5);
      expect(y + height, id).toBeLessThanOrEqual(LOGO_LOCKUP.height + 0.5);
      // Every subpath starts inside the part's own box.
      for (const [, mx, my] of d.matchAll(/M(-?[\d.]+) ?(-?[\d.]+)/g)) {
        expect(Number(mx), id).toBeGreaterThanOrEqual(x - 1);
        expect(Number(mx), id).toBeLessThanOrEqual(x + width + 1);
        expect(Number(my), id).toBeGreaterThanOrEqual(y - 1);
        expect(Number(my), id).toBeLessThanOrEqual(y + height + 1);
      }
    }
  });

  it("keeps the supplied arrangement: mascot above طمطم above TAM TAM above GAMES, centred", () => {
    const bottom = (id: LogoPartId) => LOGO_PARTS[id].box[1] + LOGO_PARTS[id].box[3];
    const centre = (id: LogoPartId) => LOGO_PARTS[id].box[0] + LOGO_PARTS[id].box[2] / 2;
    expect(bottom("mascot")).toBeLessThan(LOGO_PARTS.wordmark.box[1]);
    expect(bottom("wordmark")).toBeLessThan(LOGO_PARTS.latin.box[1]);
    expect(bottom("latin")).toBeLessThan(LOGO_PARTS.games.box[1]);
    for (const id of partIds) expect(Math.abs(centre(id) - LOGO_LOCKUP.width / 2), id).toBeLessThan(LOGO_LOCKUP.width * 0.02);
    // "TAM TAM" is six letters with two counters (the As); "GAMES" is five letters with one.
    expect(LOGO_PARTS.latin.d.match(/M/g)?.length).toBe(8);
    expect(LOGO_PARTS.games.d.match(/M/g)?.length).toBe(6);
  });

  it("matches the data the asset script reads, including whether the artwork is provisional", () => {
    const data = JSON.parse(text("scripts/logo/parts.json"));
    expect(data.provisional).toBe(LOGO_IS_PROVISIONAL);
    expect(data.lockup).toEqual({ ...LOGO_LOCKUP });
    for (const id of partIds) {
      expect(data.parts[id].d).toBe(LOGO_PARTS[id].d);
      expect(data.parts[id].box).toEqual([...LOGO_PARTS[id].box]);
    }
    expect(data.layouts).toEqual(JSON.parse(JSON.stringify(LOGO_LAYOUTS)));
    expect(existsSync(file(data.source.crop))).toBe(true);
  });

  it("lays every variant out inside its viewBox", () => {
    const variants = Object.keys(LOGO_LAYOUTS) as LogoVariant[];
    expect(variants.sort()).toEqual(["full", "mark", "stacked", "wordmark"]);
    for (const variant of variants) {
      const layout = LOGO_LAYOUTS[variant];
      expect(layout.parts.length, variant).toBeGreaterThan(0);
      for (const { part, x, y } of layout.parts) {
        const [bx, by, width, height] = LOGO_PARTS[part].box;
        expect(bx + x, `${variant}/${part}`).toBeGreaterThanOrEqual(-0.5);
        expect(by + y, `${variant}/${part}`).toBeGreaterThanOrEqual(-0.5);
        expect(bx + x + width, `${variant}/${part}`).toBeLessThanOrEqual(layout.width + 0.5);
        expect(by + y + height, `${variant}/${part}`).toBeLessThanOrEqual(layout.height + 0.5);
      }
    }
    expect(LOGO_LAYOUTS.stacked.parts.every((placed) => placed.x === 0 && placed.y === 0)).toBe(true);
    expect(LOGO_LAYOUTS.full.parts.map((placed) => placed.part).sort()).toEqual(["games", "latin", "mascot", "wordmark"]);
    expect(logoAspectRatio("full")).toBeGreaterThan(2);
    expect(logoAspectRatio("mark")).toBeCloseTo(1, 0);
  });
});

describe("<Logo>", () => {
  const render = (props: Parameters<typeof Logo>[0]) => renderToStaticMarkup(createElement(Logo, props));

  it("draws each part in its own group, in currentColor", () => {
    const html = render({ variant: "stacked" });
    for (const part of ["mascot", "wordmark", "latin", "games"]) expect(html).toContain(`data-part="${part}"`);
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toMatch(/fill="#|stroke=/);
    expect(html).toContain(`viewBox="0 0 ${LOGO_LAYOUTS.stacked.width} ${LOGO_LAYOUTS.stacked.height}"`);
    expect(html).toContain('aria-hidden="true"');
    // Animated groups carry no transform of their own; the layout offset sits on a parent.
    expect(html).not.toMatch(/<g data-part="[a-z]+"[^>]*transform=/);
  });

  it("draws only what the variant names", () => {
    const mark = render({ variant: "mark" });
    expect(mark).toContain('data-part="mascot"');
    expect(mark).not.toContain('data-part="wordmark"');
    const wordmark = render({ variant: "wordmark" });
    expect(wordmark).toContain('data-part="wordmark"');
    expect(wordmark).not.toContain('data-part="mascot"');
    expect(render({})).toContain('data-logo="full"');
  });

  it("is a named image when given a title, and sizes from one dimension", () => {
    const html = render({ variant: "mark", title: "طمطم — TamTam Games" });
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-labelledby="([^"]+)"[^>]*><title id="\1">طمطم — TamTam Games<\/title>/);
    expect(html).not.toContain("aria-hidden");
    expect(render({ variant: "mark" })).toContain('height="1em"');
    const sized = render({ variant: "mark", width: 96 });
    expect(sized).toContain('width="96"');
    expect(sized).not.toContain("height=");
  });
});

describe("static brand files", () => {
  it("has a valid web manifest whose icons exist at the stated sizes", () => {
    const manifest = JSON.parse(text("public/site.webmanifest"));
    expect(manifest.name).toBe("TamTam Games — طمطم");
    expect(manifest.short_name).toBe("طمطم");
    expect(manifest.lang).toBe("ar");
    expect(manifest.dir).toBe("rtl");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.theme_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(manifest.background_color).toBe(manifest.theme_color);
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
      expect(icon.src.startsWith("/"), icon.src).toBe(true);
      const onDisk = file(path.join("public", icon.src));
      expect(existsSync(onDisk), icon.src).toBe(true);
      if (icon.type === "image/png") {
        const { width, height } = pngSize(readFileSync(onDisk));
        expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
      } else {
        expect(icon.type).toBe("image/svg+xml");
        expect(readFileSync(onDisk, "utf8")).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      }
    }
  });

  it("has the touch icon, a multi-size favicon.ico and the standalone logo files", () => {
    expect(pngSize(readFileSync(file("public/apple-touch-icon.png")))).toEqual({ width: 180, height: 180 });

    const ico = readFileSync(file("public/favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBe(3);
    const sizes: number[] = [];
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const image = pngSize(ico.subarray(offset, offset + length));
      expect(image.width).toBe(ico.readUInt8(entry));
      expect(image.height).toBe(image.width);
      sizes.push(image.width);
    }
    expect(sizes).toEqual([16, 32, 48]);

    for (const variant of Object.keys(LOGO_LAYOUTS) as LogoVariant[]) {
      const svg = text(`public/logo/tamtam-${variant}.svg`);
      const layout = LOGO_LAYOUTS[variant];
      expect(svg, variant).toContain(`viewBox="0 0 ${layout.width} ${layout.height}"`);
      for (const { part } of layout.parts) expect(svg, `${variant}/${part}`).toContain(LOGO_PARTS[part].d);
    }
    expect(text("public/favicon.svg")).toContain(LOGO_PARTS.mascot.d);
  });
});
