/**
 * Design System v2, stage 4 polish of the styles (docs/DESIGN.md §5.5, §6.7, §12.5, §13): the opaque-photo blend sits
 * on the render slot and only for [data-opaque]; a held icon button keeps its own face; card and line titles are not
 * `plaintext`; the device band's light follows --light-y; the two font preloads go through React's preload(); the
 * lint's v2 rules fail outside the admin. What these look like is measured in Chromium on the dev server (DESIGN.md
 * §14 "Verified 2026-11-12").
 *
 *   npm test -- tests/design-styles.test.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

const preloads = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  preload: (href: string, options: Record<string, unknown>) => void preloads.push([href, options]),
}));

import { criticalFonts, preloadFonts } from "~/styles/fonts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const materials = uncommented(read("app/styles/materials.css"));
const components = uncommented(read("app/styles/components.css"));

/** Every rule as [selector, declarations] (flat: @media / @supports bodies are walked into). */
function rules(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([m[1].trim().replace(/\s+/g, " "), m[2]]);
  return out;
}
const declarationsOf = (css: string, selector: string) =>
  rules(css)
    .filter(([sel]) => sel === selector)
    .map(([, body]) => body)
    .join(";");

describe("opaque product photos (DESIGN.md §12.5)", () => {
  const blending = rules(materials).filter(([, body]) => /mix-blend-mode/.test(body));

  it("blend only on [data-opaque] — box art and screenshots (data-transparent=false too) never blend", () => {
    expect(blending.length).toBeGreaterThan(0);
    for (const [selector] of blending) {
      expect(selector).toMatch(/\[data-opaque\]/);
      expect(selector).not.toMatch(/data-transparent/);
    }
  });

  it("the blend sits on the render slot (a stacking context inside it cannot cancel it), a bare <Art> blends itself", () => {
    const selectors = blending.map(([selector]) => selector).join(" ");
    expect(selectors).toContain(".render-slot:has(img[data-opaque])");
    expect(selectors).toContain("img[data-opaque]:not(.render-slot img)");
  });

  it("the render box no longer isolates its picture", () => {
    expect(declarationsOf(materials, ".render")).not.toMatch(/isolation/);
  });

  it("showcase surfaces keep the plate (no multiply into crimson, a platform colour or the graphite band)", () => {
    expect(declarationsOf(materials, ":is(.band, .ptile, .release)")).toMatch(/--opaque-blend:\s*normal/);
  });

  it("box art and digital cards in a well keep --r-xs corners on their plate", () => {
    expect(declarationsOf(materials, '.niche:is([data-kind="box"], [data-kind="card"]) img[data-transparent="false"]')).toMatch(/--photo-radius:\s*var\(--r-xs\)/);
  });
});

describe("keys and titles", () => {
  it("the selected (ink) rule leaves icon buttons out, so a held icon button keeps its variant's face", () => {
    const selected = rules(materials).find(([, body]) => /--face:\s*var\(--ink\)/.test(body))?.[0] ?? "";
    expect(selected).toContain(".key:not(.key--round)");
    const held = declarationsOf(materials, '.key--round:is([aria-pressed="true"], [data-held])');
    expect(held).toMatch(/--on:\s*var\(--ink\)/);
    expect(held).not.toMatch(/--face/);
  });

  it("card, line and release names are not `plaintext` (a Latin name would sit flush left in an Arabic card)", () => {
    for (const selector of [".pcard__title", ".cline__name", ".release__name"]) {
      const body = declarationsOf(components, selector);
      expect(body, selector).not.toMatch(/plaintext|match-parent/);
    }
  });

  it("small kit fixes: chips in a rail never shrink, section-head chips can, crumbs are 44 wide, a chosen swatch's focus ring moves out", () => {
    expect(declarationsOf(components, ".chips--rail > *")).toMatch(/flex:\s*none/);
    expect(declarationsOf(components, ".sechead__chips")).toMatch(/min-inline-size:\s*0/);
    expect(declarationsOf(components, ".crumbs__link")).toMatch(/min-inline-size:\s*var\(--target\)/);
    expect(declarationsOf(components, '.swatch:is([aria-checked="true"], [aria-pressed="true"]):focus-visible')).toMatch(/outline-offset:\s*4px/);
  });

  it("the platform and device bands' light follows --light-y (60% unless the page moves it)", () => {
    expect(declarationsOf(materials, ".band--platform, .band--device")).toMatch(/--light-y:\s*60%/);
    expect(declarationsOf(materials, ".band--platform > .band__light, .band--device > .band__light")).toMatch(/at var\(--light-x\) var\(--light-y\)/);
  });
});

describe("font preloads (DESIGN.md §5.5)", () => {
  it("preloadFonts() preloads exactly the two critical files of the script through React's preload(), as CORS font requests", () => {
    for (const script of ["Arab", "Latn"] as const) {
      preloads.length = 0;
      preloadFonts(script);
      expect(preloads.map(([href]) => href)).toEqual(criticalFonts(script).map((f) => f.href));
      expect(preloads).toHaveLength(2);
      for (const [, options] of preloads) expect(options).toEqual({ as: "font", type: "font/woff2", crossOrigin: "anonymous" });
    }
  });
});

describe("lint stage 4 (DESIGN.md §6.7)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lint-design-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const lint = (name: string, text: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    try {
      execFileSync(process.execPath, [path.join(ROOT, "scripts/lint-design.mjs"), file], { cwd: ROOT, encoding: "utf8" });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };

  it("a v2 rule fails the run in a file outside the design system and the admin (it was report-only before stage 4)", () => {
    expect(lint("page.css", ".x { font-weight: 500; }\n")).toBe(1);
    expect(lint("blend.css", ".render-slot:has(img[data-opaque]) { mix-blend-mode: multiply; }\n")).toBe(1); // only materials.css may blend
  });

  it("a 1.0 rule outside the design system is still reported only (CI's --strict fails it)", () => {
    expect(lint("old.css", ".x { margin-left: 4px; }\n")).toBe(0);
  });

  it("the repository's design-system files and storefront files pass", () => {
    const run = () => execFileSync(process.execPath, [path.join(ROOT, "scripts/lint-design.mjs"), "app/styles", "app/app.css", "app/motion"], { cwd: ROOT, encoding: "utf8" });
    expect(run).not.toThrow();
  });
});
