/**
 * Admin shell (owner: admin shell) — a control reached by Tab is never hidden under the admin's bottom chrome
 * (WCAG 2.4.11), fix of 2026-11-13 (wave C). The browser scrolls a focused control into view inside the root's
 * scroll padding; base.css pads the root's end by the storefront's --shell-bottom, which is 0 in the admin, so:
 *
 *   · at 390 Tab stops landed under the phone tab bar (60px + the safe area): 1 on /admin/promotions, 3 on /admin,
 *     4 on /admin/orders (focus walk, fb1/shots/C-fix-admin)
 *   · on a page with a sticky bar at the bottom (the role editor's save bar, the approvals' task bars, the catalogue's
 *     save bars, the till's pay bar) Tab stops landed under that bar at every width — 12 on the role editor at 1440
 *
 * The shell pads the root's end by both (admin-shell.css); a sticky bottom bar says it is one with
 * `data-adm-sticky-end`. These checks read the sources: the walk itself is a browser's (fb1/work/C-fix-admin).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ADMIN = path.join(ROOT, "app/routes/admin");
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const SHELL_CSS = withoutComments(readFileSync(path.join(ADMIN, "shell/admin-shell.css"), "utf8"));

function filesUnder(dir: string, extension: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, extension));
    else if (extension.test(entry)) out.push(full);
  }
  return out;
}
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
/** The declarations of every rule whose selector is exactly `selector` (media blocks included), joined. */
const rulesOf = (css: string, selector: string) =>
  [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]!.trim() === selector)
    .map((match) => match[2]!)
    .join("\n");

describe("the root's end padding covers what the admin pins at the bottom", () => {
  test("the phone tab bar: below 48rem the root's end is padded by the bar's own height", () => {
    // the bar: .adm { --adm-tab-h: calc(60px + var(--safe-bottom)) } — :root cannot read it, so the root repeats it
    const tab = /--adm-tab-h:\s*([^;]+);/.exec(rulesOf(SHELL_CSS, ".adm"))?.[1]?.trim();
    expect(tab).toBe("calc(60px + var(--safe-bottom))");
    const phone = /@media \(max-width: 47\.99rem\) \{\s*:root:has\(\.adm\) \{([^}]*)\}/.exec(SHELL_CSS)?.[1] ?? "";
    expect(phone).toContain(`--adm-fixed-end: ${tab};`);
    expect(rulesOf(SHELL_CSS, ":root:has(.adm)")).toMatch(/scroll-padding-block-end:\s*calc\(var\(--adm-fixed-end, 0px\) \+ var\(--adm-sticky-end, 0px\) \+ var\(--s-\d\)\)/);
  });

  test("a sticky bar at the bottom of a page: the root's end grows by one row of keys while one is on the page", () => {
    const allowance = Number(/--adm-sticky-end:\s*(\d+)px/.exec(rulesOf(SHELL_CSS, ":root:has(.adm [data-adm-sticky-end])"))?.[1]);
    // the bars: 12px of padding above and below one row of keys, 44px on touch screens (the kit's --target)
    expect(allowance).toBeGreaterThanOrEqual(12 + 44 + 12);
  });

  test("every sticky bar at the bottom of an admin page says so (data-adm-sticky-end)", () => {
    // the bars' classes: a rule that is sticky and sits on the phone tab bar (inset-block-end: var(--adm-bottom…))
    const classes = new Set<string>();
    for (const file of filesUnder(ADMIN, /\.css$/)) {
      for (const match of withoutComments(readFileSync(file, "utf8")).matchAll(/\.([\w-]+)\s*\{([^{}]*)\}/g)) {
        if (/position:\s*sticky/.test(match[2]!) && /inset-block-end:\s*var\(--adm-bottom/.test(match[2]!)) classes.add(match[1]!);
      }
    }
    expect([...classes]).toEqual(expect.arrayContaining(["sec-taskbar", "fin-taskbar", "ord-taskbar", "stf-taskbar", "shp-sticky", "pos-paybar"]));
    const bars: string[] = [];
    const unmarked: string[] = [];
    for (const file of filesUnder(ADMIN, /\.tsx$/)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const named = [...line.matchAll(/className="([^"]*)"/g)].some((match) => match[1]!.split(/\s+/).some((name) => classes.has(name)));
          // a bar styled in place (Tailwind's `sticky` with the shell's bottom inset)
          const inline = /\bsticky\b/.test(line) && /insetBlockEnd: "var\(--adm-bottom/.test(line);
          if (!named && !inline) return;
          bars.push(`${rel(file)}:${index + 1}`);
          if (!line.includes("data-adm-sticky-end")) unmarked.push(`${rel(file)}:${index + 1}`);
        });
    }
    expect(bars.length).toBeGreaterThanOrEqual(9);
    expect(unmarked).toEqual([]);
  });
});
