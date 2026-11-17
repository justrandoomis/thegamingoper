/**
 * The kit's polish round (2026-11-13, after round 2 went live): the shared pieces' open requests from the wave C
 * reports — names that keep their tokens in cart lines, focus that survives the buy bar's swap, reading sizes on
 * phones (G7), a parallax that is right in Arabic, the coupon minimum's figures on the client, glass on paper, compact
 * tabs whose underline follows their padding. Each behaviour defect has a test here that failed before its fix; how
 * the pieces look is checked in Chromium on /design-system and on one real page each.
 *
 *   npm test -- tests/kit-polish.test.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterAll, describe, expect, it } from "vitest";

import { messagesFor } from "~/i18n/i18n.server";
import type { CartLine } from "~/lib/dto";
import { keepTokens } from "~/lib/keep-tokens";
import { LOCALES, localePath, type Locale } from "~/lib/locales";
import { parallaxShift } from "~/ui/Carousel";
import { readCartAnswer, readFailure } from "~/ui/cart-client";
import { CartLineRow } from "~/ui/CartLineRow";
import { CompatBadge } from "~/ui/CompatBadge";
import { FOCUS_TARGET, focusHandoff } from "~/ui/focus-handoff";
import { indicatorBox, paddingInset } from "~/ui/indicator";
import { Tabs } from "~/ui/Tabs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The bodies of every `@media <query> {…}` block of a stylesheet, joined (braces matched). */
function media(css: string, query: string): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media ${query} {`, from);
    if (start < 0) break;
    let depth = 0;
    let end = start;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    out.push(css.slice(css.indexOf("{", start) + 1, end));
    from = end;
  }
  return out.join("\n");
}
/** The declarations of every rule whose selector list is exactly `selector` (flat; @media bodies walked into). */
function decls(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1].trim().replace(/\s+/g, " ") === selector) out.push(m[2]);
  return out.join(";");
}
/** The rules (selector list → declarations) of a block of CSS. */
function rules(css: string): { selectors: string[]; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")), body: m[2] }));
}

const renderKit = (element: ReactElement, locale: Locale = "ar") => {
  const Page: ComponentType = () => element;
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "*", Component: Page }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [localePath("/kit", locale)],
      hydrationData: { loaderData: { root: { locale, dir: LOCALES[locale].dir, fx: null, i18n: messagesFor(locale, "ui", "ui-shop", "ui-card", "ui-overlays") } } },
    }),
  );
};

const line = (extra: Partial<CartLine> = {}): CartLine => ({
  id: "cl_1",
  kind: "variant",
  variantId: "var_1",
  usedUnitId: null,
  href: "/p/demo",
  name: "Demo",
  optionsLabel: null,
  unitPriceIqd: 25_000,
  qty: 1,
  maxQty: 5,
  lineTotalIqd: 25_000,
  image: { artKey: null, mediaKey: null, alt: "", isIllustration: false },
  stock: "in_stock",
  problem: null,
  ...extra,
});

describe("1 · names keep their tokens whole (the shared keepTokens)", () => {
  it("the shared module keeps short name tokens and Latin hyphens together, and leaves prose breakable", () => {
    expect(keepTokens("Xbox Rechargeable Battery + USB-C Cable")).toBe("Xbox Rechargeable Battery + USB‑C Cable");
    expect(keepTokens("حزاما معصم Joy-Con 2 (عدد 2)")).toBe("حزاما معصم Joy‑Con 2 (عدد 2)");
    expect(keepTokens("PS5ی Pro")).toBe("PS5ی\u00a0Pro");
    // a name's short tokens are glued («Xbox One», «Xbox 360»); the sentence's own words still break
    expect(keepTokens("Plays thousands of Xbox One, Xbox 360 games")).toBe("Plays thousands of Xbox One, Xbox 360 games");
    expect(keepTokens("شاشة 7.9 بوصة")).toBe("شاشة 7.9 بوصة");
    expect(keepTokens(keepTokens("Pokémon Legends: Z-A"))).toBe(keepTokens("Pokémon Legends: Z-A")); // idempotent
  });

  it("the shared module writes its two characters as escapes, and is the only copy: the product page uses it (follow-ups 2026-11-17)", async () => {
    // the builder's copy carried a literal U+00A0 and U+2011 in its source: invisible in review, and an editor or a
    // formatter that normalises spaces turns the rule into a no-op without a visible diff
    expect(read("app/lib/keep-tokens.ts")).not.toMatch(/[ ‑]/);
    // the product page's own copies (text.ts keepTokens, handoff.ts) are gone: one rule, one focus handoff
    const productText = await import("~/routes/storefront/product/text");
    expect("keepTokens" in productText).toBe(false);
    expect(existsSync(path.join(ROOT, "app/routes/storefront/product/handoff.ts"))).toBe(false);
    for (const file of ["product.tsx", "QuickPreview.tsx", "components/MixedText.tsx"]) expect(read(`app/routes/storefront/product/${file}`), file).toMatch(/import \{[^}]*\bkeepTokens\b[^}]*\} from "~\/lib\/keep-tokens"/);
    for (const file of ["QuickPreview.tsx", "components/BuyStrip.tsx"]) expect(read(`app/routes/storefront/product/${file}`), file).toContain('import { useFocusHandoff } from "~/ui/focus-handoff"');
    expect(keepTokens("Nintendo Switch 2 Dock")).toBe("Nintendo Switch\u00a02 Dock");
    expect(keepTokens("GPU: 4K at up to 120 FPS and 8K HDR")).toBe("GPU:\u00a04K at up to\u00a0120\u00a0FPS and\u00a08K\u00a0HDR");
    expect(keepTokens("3.5 mm · 401 g")).toBe("3.5\u00a0mm ·\u00a0401\u00a0g");
    expect(keepTokens("PS5ی Pro")).toBe("PS5ی\u00a0Pro");
    expect(keepTokens("USB-C")).toBe("USB‑C");
    expect(keepTokens("Switch 2")).toBe("Switch 2");
  });

  it("a cart line prints «USB‑C» whole (an old snapshot or an owner-typed name still has the plain hyphen)", () => {
    // QA 2026-11-13: «…Battery + USB-» / «C Cable» at 360–390 in /cart and /checkout. The catalogue now writes U+2011,
    // but an order line's snapshot and a name typed in the admin keep the plain hyphen: the row draws them kept.
    const html = renderKit(createElement(CartLineRow, { line: line({ name: "Xbox Rechargeable Battery + USB-C Cable" }) }));
    const name = html.match(/data-line-name=""[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    expect(name).toContain("USB‑C");
    expect(name).not.toContain("USB-C");
    // the undo row's sentence names it the same way
    const undo = renderKit(createElement(CartLineRow, { line: line({ name: "يد Joy-Con 2 (L) زرقاء" }), removed: true }));
    expect(undo).toContain("Joy‑Con 2");
  });
});

describe("2 · focus survives the buy bar's swap", () => {
  it("the hand-off lands once, only when focus was on what the swap replaced", () => {
    const landed: (FocusOptions | undefined)[] = [];
    const next = { focus: (options?: FocusOptions) => void landed.push(options) };
    const key = { id: "add" };
    const bar = { contains: (node: unknown) => node === key };
    const swap = focusHandoff();
    swap.arm(bar, key);
    expect(swap.land(next)).toBe(true);
    expect(landed).toEqual([{ preventScroll: true }]);
    expect(swap.land(next), "once").toBe(false);
    swap.arm(bar, { id: "elsewhere" }); // the shopper moved on while the add was on its way: never pulled back
    expect(swap.land(next)).toBe(false);
    swap.arm(null, key);
    expect(swap.land(next)).toBe(false);
    expect(landed).toHaveLength(1);
  });

  it("<BuyBar> arms it on a confirmed add and marks «عرض السلة (n)» as where focus lands", () => {
    // fix-product, wave C: on the used-unit page the kit's bar replaced the focused «أضف إلى السلة» with «عرض السلة (n)»,
    // and focus fell to <body> (the next Tab started at the top of the page)
    const source = read("app/ui/AddToCartKey.tsx");
    const bar = source.slice(source.indexOf("export function BuyBar("));
    expect(bar).toMatch(/useFocusHandoff\(added\)/);
    expect(bar).toContain("ref={handoff.area}");
    expect(bar).toMatch(/onAdded=\{\(cart, units\) => \{\s*handoff\.arm\(\);/);
    expect(bar.match(new RegExp(`${FOCUS_TARGET}=""`, "g"))).toHaveLength(1);
  });
});

describe("3 · reading sizes on phones (G7)", () => {
  const tokens = uncommented(read("app/styles/tokens.css"));
  const components = uncommented(read("app/styles/components.css"));
  const materials = uncommented(read("app/styles/materials.css"));
  const phone = rules(media(components, "(max-width: 47.99rem)"));
  const readingOnPhones = (selector: string) => phone.some((rule) => rule.selectors.includes(selector) && /font:\s*var\(--type-read\)/.test(rule.body));

  it("the lead's line height is at least 1.7 in Arabic and Sorani", () => {
    const lead = Number(tokens.match(/--lh-lead:\s*([\d.]+)/)?.[1]);
    expect(lead).toBeGreaterThanOrEqual(1.7);
  });

  it("a section's reason line, a card's fact line and the compatibility note are reading text below 48rem", () => {
    // fix-product census, wave C: «اختارها المتجر، وكلها تعمل مع Nintendo Switch 2» 14 / 1.5, the card's facts and the
    // CompatBadge note 13px on 360–390 phones
    expect(readingOnPhones(".sechead__reason")).toBe(true);
    expect(readingOnPhones(".pcard__meta")).toBe(true);
    // the note reads at 16 up to 1023 (polish 2026-11-17: the device hub's tablet override went to the kit)
    expect(rules(media(components, "(max-width: 63.99rem)")).some((rule) => rule.selectors.includes(".compat-badge__note") && /font:\s*var\(--type-read\)/.test(rule.body))).toBe(true);
    // the note carries no type utility: the utilities layer would beat the stylesheet's phone size
    const html = renderKit(createElement(CompatBadge, { status: "partial", device: "PS5", note: "يعمل بشرط تحديث الجهاز" }));
    const note = html.match(/<span class="([^"]*)">يعمل بشرط تحديث الجهاز<\/span>/)?.[1] ?? "";
    expect(note).toContain("compat-badge__note");
    expect(note).not.toMatch(/\btype-/);
  });

  it("a wrapped key's two lines have room for Arabic and Sorani marks (line height ≈ 1.45)", () => {
    expect(decls(materials, ".key--wrap .key__label")).toMatch(/line-height:\s*1\.45/);
  });
});

describe("4 · the carousel's parallax is right in right-to-left scrollers", () => {
  it("is not a CSS view() timeline (Chromium measures a right-to-left scroller's from the wrong edge): the hook writes the drift", () => {
    // fix-browse, wave C: the banner in view read −200% progress in Arabic
    const pieces = uncommented(read("app/styles/pieces.css"));
    for (const rule of rules(pieces)) if (rule.selectors.includes(".carousel__parallax")) expect(rule.body).not.toMatch(/animation-timeline/);
    expect(decls(pieces, ".carousel__parallax")).toMatch(/translate:\s*calc\(var\(--carousel-shift, 0\) \* 9%\) 0/);
  });

  it("parallaxShift: the view() range in physical terms — 0 in the middle, 1 coming in at the right, −1 gone at the left", () => {
    const track = { left: 0, right: 390 };
    const at = (left: number, width = 390) => parallaxShift(track, { left, right: left + width });
    expect(at(0)).toBe(0);
    expect(at(390)).toBe(1); // its near edge on the track's right edge: about to come in
    expect(at(-390)).toBe(-1); // its far edge on the track's left edge: just gone out
    expect(at(195)).toBe(0.5);
    expect(at(1560)).toBe(1); // further away it rests at its end
    expect(at(-1170)).toBe(-1);
    // physical, so one number serves both directions: the slide after the first is on the right in English and on
    // the left in Arabic, and drifts toward its own side in each — mirrored
    expect(at(-195)).toBe(-at(195));
    // a peeking track (88% slides in a padded track) and a degenerate box
    expect(parallaxShift({ left: 16, right: 374 }, { left: 16, right: 331 })).toBe(-0.064);
    expect(parallaxShift({ left: 0, right: 0 }, { left: 0, right: 0 })).toBe(0);
  });
});

describe("5 · the coupon minimum's figures reach the page", () => {
  it("readFailure / readCartAnswer pass the core's minimumIqd and moreIqd through (409 coupon_min_subtotal)", () => {
    // fix-core, wave C: the 409 now says the minimum and how much more the cart needs; the client dropped them
    const body = { ok: false, code: "coupon_min_subtotal", minimumIqd: 100_000, moreIqd: 68_750 };
    expect(readFailure(409, body)).toEqual({ ok: false, status: 409, code: "coupon_min_subtotal", minimumIqd: 100_000, moreIqd: 68_750 });
    expect(readCartAnswer(409, body)).toEqual(readFailure(409, body));
    // the live core's answer, captured 2026-11-13 (a 99,750 cart and DEMO5000): the figures and the field travel together
    const live = { ok: false, code: "coupon_min_subtotal", fields: { code: "coupon_min_subtotal" }, minimumIqd: 100000, moreIqd: 250 };
    expect(readCartAnswer(409, live)).toEqual({ ok: false, status: 409, code: "coupon_min_subtotal", fields: { code: "coupon_min_subtotal" }, minimumIqd: 100_000, moreIqd: 250 });
    // whole dinars, and the pair or nothing
    const bare = { ok: false, status: 409, code: "coupon_min_subtotal" };
    expect(readFailure(409, { ...body, moreIqd: -5 })).toEqual(bare);
    expect(readFailure(409, { ...body, moreIqd: 1.5 })).toEqual(bare);
    expect(readFailure(409, { ...body, minimumIqd: "100000" })).toEqual(bare);
    expect(readFailure(409, { ok: false, code: "coupon_min_subtotal", minimumIqd: 100_000 })).toEqual(bare);
  });
});

describe("6 · glass on paper, compact tabs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kit-lint-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("printing drops every backdrop filter (above the components layer's glass: an important declaration)", () => {
    // fix-shell, wave C: frosted bars and panels printed as smeared boxes
    const base = uncommented(read("app/styles/base.css"));
    const print = media(base, "print");
    const glass = rules(print).find((rule) => rule.selectors.includes('[class*="glass"]'));
    expect(glass?.body).toMatch(/-webkit-backdrop-filter:\s*none !important/);
    expect(glass?.body).toMatch(/(^|[;\s])backdrop-filter:\s*none !important/);
  });

  it("the tabs' sliding underline follows the tab's own padding (a compact row's 7px sides, a page's own override)", () => {
    // fix-service, wave C: the support tabs set 7px sides on phones; the kit's underline kept a fixed 10px inset
    const source = read("app/ui/Tabs.tsx");
    expect(source).toMatch(/inset: "padding"/);
    expect(source).toContain("px-(--tab-px)");
    expect(source).toContain("after:inset-x-(--tab-px)");
    // the measure: the item's inline paddings come off its two ends, in both directions
    expect(paddingInset({ paddingInlineStart: "7px", paddingInlineEnd: "7px" })).toEqual({ start: 7, end: 7 });
    expect(indicatorBox({ clientWidth: 390 }, { offsetLeft: 100, offsetWidth: 80 }, false, { start: 7, end: 7 })).toEqual({ x: 107, width: 66 });
    expect(indicatorBox({ clientWidth: 390 }, { offsetLeft: 100, offsetWidth: 80 }, true, { start: 7, end: 7 })).toEqual({ x: -217, width: 66 });
    // a number still means the same at both ends (Segmented's thumb: 0)
    expect(indicatorBox({ clientWidth: 390 }, { offsetLeft: 100, offsetWidth: 80 }, false, 10)).toEqual({ x: 110, width: 60 });
  });

  it("<Tabs compact>: 7px sides under 420px, in the storefront only (the admin keeps its 12)", () => {
    const items = [
      { value: "help", label: "مركز الدعم", href: "/support" },
      { value: "repair", label: "احجز صيانة", href: "/support/repair" },
    ];
    const compact = renderKit(createElement(Tabs, { "aria-label": "الدعم", value: "help", items, compact: true }));
    expect(compact).toContain("not-admin:max-[26.25rem]:[--tab-px:7px]");
    expect(compact).toContain("not-admin:[--tab-px:10px]");
    const plain = renderKit(createElement(Tabs, { "aria-label": "الدعم", value: "help", items }));
    expect(plain).not.toContain("[--tab-px:7px]");
  });

  it("the lint allows an important `none` for a backdrop filter outside materials.css, and nothing else", () => {
    const strict = (name: string, text: string) => {
      const file = path.join(dir, name);
      writeFileSync(file, text);
      try {
        execFileSync(process.execPath, [path.join(ROOT, "scripts/lint-design.mjs"), "--strict", file], { cwd: ROOT, encoding: "utf8" });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? 1;
      }
    };
    expect(strict("flat.css", "@media print { .x { backdrop-filter: none !important; } }\n")).toBe(0);
    expect(strict("frost.css", ".x { backdrop-filter: blur(4px) !important; }\n")).toBe(1);
  });
});
