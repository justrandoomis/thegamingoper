/**
 * Mixed scripts (docs/ui/core.md "BidiText, BidiLabel"): where the kit cuts Arabic/Sorani text into left-to-right
 * isolates, and the markup of <BidiText> and <BidiLabel>. The strings are the ones the storefront areas reported
 * (STATUS.md §4, design system) and every Arabic and Sorani name and variant title of the researched catalogue.
 * How the cuts look is checked in Chromium on /design-system#bidi (each line's `data-units` measured, not only seen).
 *
 *   npm test -- tests/ui-bidi.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BidiLabel, BidiText, BidiValue, FSI, hasRtl, isolate, latinName, PDI, splitBidi, splitNumbers, textOf } from "~/ui/BidiText";
import { FactLine, hasRtlLetter } from "~/ui/FactLine";

/** The left-to-right runs of a text, in reading order. */
const runs = (text: string) => splitBidi(text).filter((part) => part.ltr).map((part) => part.text);
const html = (text: string) => renderToStaticMarkup(createElement(BidiText, { text }));
const label = (children: Parameters<typeof BidiLabel>[0]["children"], className?: string) => renderToStaticMarkup(createElement(BidiLabel, { className, children }));

describe("splitBidi — the cases the areas reported", () => {
  it("keeps a number with thousands separators whole: 25,000 never becomes 000,25", () => {
    expect(runs("أكثر من 25,000 لعبة")).toEqual(["25,000"]);
    expect(runs("السعر 1,095,000 د.ع")).toEqual(["1,095,000"]);
    expect(runs("25,000")).toEqual(["25,000"]);
  });

  it("leaves brackets around Arabic in the sentence, where the browser pairs and mirrors them", () => {
    expect(splitBidi("PlayStation 5 Slim (نسخة الأقراص) – 1TB")).toEqual([
      { text: "PlayStation 5 Slim", ltr: true },
      { text: " (نسخة الأقراص) – ", ltr: false },
      { text: "1TB", ltr: true },
    ]);
    expect(splitBidi("PlayStation 5 (الطراز الأصلي 2020)")).toEqual([
      { text: "PlayStation 5", ltr: true },
      { text: " (الطراز الأصلي ", ltr: false },
      { text: "2020", ltr: true },
      { text: ")", ltr: false },
    ]);
    expect(runs("Metroid Prime 4: Beyond – Nintendo Switch 2 Edition (نسخة فيزيائية)")).toEqual(["Metroid Prime 4: Beyond – Nintendo Switch 2 Edition"]);
    expect(runs("Red Dead Redemption 2 لجهاز PS4 (يعمل على PS5)")).toEqual(["Red Dead Redemption 2", "PS4", "PS5"]);
  });

  it("keeps a Latin name whole across its own joiners: ' + ', ' – ', ' / ', ': '", () => {
    expect(runs("Pokémon Legends: Z-A – Nintendo Switch 2 Edition + Mega Dimension (نسخة فيزيائية)")).toEqual(["Pokémon Legends: Z-A – Nintendo Switch 2 Edition + Mega Dimension"]);
    expect(runs("Call of Duty: Modern Warfare 4 لجهاز PS5")).toEqual(["Call of Duty: Modern Warfare 4", "PS5"]);
    expect(runs("Legion Go S بنظام Windows 11 Z1 Extreme 32GB / 1TB أبيض Glacier White")).toEqual(["Legion Go S", "Windows 11 Z1 Extreme 32GB / 1TB", "Glacier White"]);
    expect(runs("DualSense – Prism برتقالي شفاف Flare Orange")).toEqual(["DualSense – Prism", "Flare Orange"]);
    expect(runs("Grand Theft Auto VI لجهاز XBOX Series X|S — Standard Edition")).toEqual(["Grand Theft Auto VI", "XBOX Series X|S", "Standard Edition"]);
  });

  it("gives a number that follows Arabic to that sentence: 'حزمة 2026: Switch 2' is not one run", () => {
    expect(runs("حزمة 2026: Switch 2 + Mario Kart World + اشتراك Nintendo Switch Online لـ3 أشهر")).toEqual(["2026", "Switch 2 + Mario Kart World", "Nintendo Switch Online", "3"]);
    expect(runs("حزمة الإطلاق 2025: Switch 2 + Mario Kart World")).toEqual(["2025", "Switch 2 + Mario Kart World"]);
    // a number between a joiner and Arabic counts what follows it ("3 مانگ" = three months)
    expect(runs("پاکێجی 2026: Switch 2 + Mario Kart World + 3 مانگ Nintendo Switch Online")).toEqual(["2026", "Switch 2 + Mario Kart World", "3", "Nintendo Switch Online"]);
    expect(runs("PS5 Slim Digital Edition – 1TB (مخزون 2023–2025)")).toEqual(["PS5 Slim Digital Edition – 1TB", "2023–2025"]);
  });

  it("leaves list and sentence punctuation outside: ' · ', ', ', ' — ', '، ', a final full stop", () => {
    expect(runs("اهتزاز Haptic · Adaptive triggers")).toEqual(["Haptic", "Adaptive triggers"]);
    expect(runs("يدعم USB-C, Bluetooth 5.1")).toEqual(["USB-C", "Bluetooth 5.1"]);
    expect(runs("Forza Horizon 6 لجهاز PS5 — Standard Edition (طلب مسبق)")).toEqual(["Forza Horizon 6", "PS5", "Standard Edition"]);
    expect(runs("Legion Go S بە SteamOS، Z1 Extreme 32GB / 1TB، Nebula Nocturne")).toEqual(["Legion Go S", "SteamOS", "Z1 Extreme 32GB / 1TB", "Nebula Nocturne"]);
    const sentence = splitBidi("يد التحكم الأصلية لجهاز PS5.");
    expect(sentence.at(-2)).toEqual({ text: "PS5", ltr: true });
    expect(sentence.at(-1)).toEqual({ text: ".", ltr: false });
  });

  it("keeps the product page's MixedText cases (brackets, separators, glued units)", () => {
    expect(runs("مجموعة Prism الشفافة (Flare Orange وEmerald Green)")).toEqual(["Prism", "Flare Orange", "Emerald Green"]);
    expect(runs("من 2–4 لاعبين، USB-C و3.5 ملم")).toEqual(["2–4", "USB-C", "3.5"]);
    expect(runs("بدقة 1920×1080 وتردد متغير (VRR)، الطراز BEE-001(-01)")).toEqual(["1920×1080", "VRR", "BEE-001(-01)"]);
  });

  it("keeps signs that belong to a name, and names that start with a number", () => {
    expect(runs("MSI Claw 8 EX AI+ لجهاز محمول")).toEqual(["MSI Claw 8 EX AI+"]);
    expect(runs("007 First Light لجهاز PS5")).toEqual(["007 First Light", "PS5"]);
    expect(runs("Lenovo Legion Go (2023) بلون أسود")).toEqual(["Lenovo Legion Go (2023)"]);
    expect(runs("يدا Joy-Con 2 (L)/(R) باللون الأزرق")).toEqual(["Joy-Con 2 (L)/(R)"]);
    expect(runs("Marvel's Spider-Man 2 لجهاز PS5")).toEqual(["Marvel's Spider-Man 2", "PS5"]);
    expect(runs("خصم 20% على PS5ی ڕەسەن")).toEqual(["20%", "PS5"]);
    expect(runs("الرمز #12 عبر @tamtam")).toEqual(["#12", "@tamtam"]);
    expect(runs("رصيد PS5$10 فقط")).toEqual(["PS5$10"]); // two runs that touch are one
  });

  it("treats text without Arabic script as one left-to-right run, and empty text as nothing", () => {
    expect(splitBidi("Joy-Con 2 (L)/(R)")).toEqual([{ text: "Joy-Con 2 (L)/(R)", ltr: true }]);
    expect(splitBidi("MSI Claw 8 EX AI+")).toEqual([{ text: "MSI Claw 8 EX AI+", ltr: true }]);
    expect(splitBidi("")).toEqual([]);
    expect(hasRtl("Xbox")).toBe(false);
    expect(hasRtl("کۆنسۆڵ")).toBe(true);
  });

  it("never ends a run at a line break", () => {
    expect(runs("جهاز PS5\nXbox Series X")).toEqual(["PS5", "Xbox Series X"]);
  });
});

describe("splitBidi — every Arabic and Sorani name of the catalogue", () => {
  const dir = fileURLToPath(new URL("../catalog/products/", import.meta.url));
  const names: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const product = JSON.parse(readFileSync(dir + file, "utf8")) as { name?: Record<string, string>; variants?: { title?: Record<string, string> }[] };
    for (const locale of ["ar", "ckb"]) {
      if (product.name?.[locale]) names.push(product.name[locale]);
      for (const variant of product.variants ?? []) if (variant.title?.[locale]) names.push(variant.title[locale]);
    }
  }

  it("reads the catalogue (hundreds of names)", () => {
    expect(names.length).toBeGreaterThan(300);
  });

  it("loses nothing, never puts two runs side by side, and gives every run clean edges and whole bracket pairs", () => {
    for (const name of names) {
      const parts = splitBidi(name);
      expect(parts.map((part) => part.text).join(""), name).toBe(name);
      if (!hasRtl(name)) {
        expect(parts, name).toEqual([{ text: name, ltr: true }]);
        continue;
      }
      parts.forEach((part, index) => {
        if (index > 0) expect(part.ltr !== parts[index - 1].ltr, name).toBe(true);
        if (!part.ltr) return;
        expect(hasRtl(part.text), `${name} → ${part.text}`).toBe(false);
        expect(part.text, name).toBe(part.text.trim());
        expect(part.text, name).not.toMatch(/[.,:;·–—\-/(\[]$/u);
        expect(part.text, name).not.toMatch(/^[.,:;·–—\-/)\]]/u);
        const open = (part.text.match(/[([{]/gu) ?? []).length;
        const close = (part.text.match(/[)\]}]/gu) ?? []).length;
        expect(open, `${name} → ${part.text}`).toBe(close);
      });
    }
  });
});

describe("<BidiText>", () => {
  it("isolates each run with <bdi dir=ltr> and leaves the sentence in the page's direction", () => {
    expect(html("PlayStation 5 (الطراز الأصلي 2020)")).toBe('<bdi dir="ltr">PlayStation 5</bdi> (الطراز الأصلي <bdi dir="ltr">2020</bdi>)');
    expect(html("أكثر من 25,000 لعبة")).toBe('أكثر من <bdi dir="ltr">25,000</bdi> لعبة');
  });

  it("wraps a Latin-only name in one isolate, and renders nothing for empty text", () => {
    expect(html("PlayStation 5 Pro")).toBe('<bdi dir="ltr">PlayStation 5 Pro</bdi>');
    expect(html("")).toBe("");
  });
});

describe("<BidiLabel> — labels of keys, chips, banks, crumbs, menus, steps and toasts", () => {
  it("is a left-to-right isolate when the label has no Arabic script (PS5, 1 TB, A+, a count)", () => {
    expect(label("PS5", "key__label")).toBe('<bdi dir="ltr" class="key__label">PS5</bdi>');
    expect(label(3)).toBe('<bdi dir="ltr">3</bdi>');
  });

  it("follows the page's direction when the label has Arabic script, even if it starts with Latin (no dir=auto)", () => {
    expect(label("PlayStation 5 Slim (نسخة الأقراص)", "key__label")).toBe('<span class="bidi key__label"><bdi dir="ltr">PlayStation 5 Slim</bdi> (نسخة الأقراص)</span>');
    expect(label("ألعاب PS5")).toBe('<span class="bidi">ألعاب <bdi dir="ltr">PS5</bdi></span>');
    // element children are kept as they are; their text decides the direction
    expect(label(createElement(BidiText, { text: "Xbox Series X — أسود" }))).toBe('<span class="bidi"><bdi dir="ltr">Xbox Series X</bdi> — أسود</span>');
    expect(label(createElement("b", null, "Xbox"))).toBe('<bdi dir="ltr"><b>Xbox</b></bdi>');
  });

  it("follows the page's direction when it cannot read the label (a component that takes its words as props)", () => {
    const Count = ({ n }: { n: number }) => createElement("span", null, `(${n})`);
    expect(label(createElement(Count, { n: 3 }))).toBe('<span class="bidi"><span>(3)</span></span>');
  });
});

// Polish round (digest K): «5,000 د.ع» inside an Arabic sentence was a left-to-right isolate (U+2066), which put «د.ع»
// before the figure; card facts in a bare <bdi> read «512GB أو 1TB» backwards; number-only impact rows pointed their
// arrow at the old value; a Latin card title clamped with the ellipsis on its left.
describe("amounts and names inside sentences: first-strong isolates", () => {
  it("isolates with U+2068 … U+2069, never the left-to-right isolate", () => {
    expect(isolate("5,000 د.ع")).toBe(`${FSI}5,000 د.ع${PDI}`);
    expect(FSI).toBe("⁨");
    expect(PDI).toBe("⁩");
  });

  it("no kit component wraps an amount in a left-to-right isolate any more", () => {
    for (const file of ["TrustStrip", "CartLineRow", "GovernoratePicker", "WalletBalance"]) {
      const source = readFileSync(fileURLToPath(new URL(`../app/ui/${file}.tsx`, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/⁦/);
      expect(source, file).toMatch(/isolate\(/);
    }
  });
});

describe("a card fact keeps the page's direction (<BidiLabel>)", () => {
  it("reads «512GB أو 1TB» from the right, each size its own left-to-right run", () => {
    expect(label("512GB أو 1TB")).toBe('<span class="bidi"><bdi dir="ltr">512GB</bdi> أو <bdi dir="ltr">1TB</bdi></span>');
  });
});

describe("<FactLine> — one line of whole facts, never cut through a Latin name (QA 2026-11-12)", () => {
  const line = (facts: (string | null)[], lines?: 1 | 2) => renderToStaticMarkup(createElement(FactLine, { facts, lines }));

  it("gives each fact its own box and its « · » to the fact it introduces, so a fact drops out with its separator", () => {
    expect(line(["Ryzen AI Z2 Extreme", "24GB RAM"])).toBe(
      '<span class="factline"><span class="factline__fact"><bdi dir="ltr" class="factline__text">Ryzen AI Z2 Extreme</bdi></span>' +
        '<span class="factline__fact"><span class="factline__sep"> · </span><bdi dir="ltr" class="factline__text">24GB RAM</bdi></span></span>',
    );
  });

  it("keeps a fact with Arabic words in the page's direction, each Latin run one isolate, the opening one marked", () => {
    const html = line(["جهاز Switch 2 بسعة 256GB + Pokémon Legends: Z-A (تنزيل رقمي)"]);
    expect(html).toContain('<span class="factline__text bidi">جهاز <bdi dir="ltr">Switch 2</bdi> بسعة <bdi dir="ltr">256GB + Pokémon Legends: Z-A</bdi> (تنزيل رقمي)</span>');
    expect(line(["Nintendo Switch 2 Edition أو نسخة Nintendo Switch"])).toContain('<bdi dir="ltr" class="factline__lead">Nintendo Switch 2 Edition</bdi>');
  });

  it("treats a Latin list with Arabic commas as one left-to-right fact, skips empty facts, and renders nothing for none", () => {
    expect(hasRtlLetter("SteamOS، Z1 Extreme 32GB / 1TB، Nebula Nocturne")).toBe(false);
    expect(hasRtlLetter("جهاز PS5")).toBe(true);
    expect(line(["SteamOS، Z1 Extreme 32GB / 1TB، Nebula Nocturne"])).toContain('<bdi dir="ltr" class="factline__text">SteamOS، Z1 Extreme');
    expect(line([null, " ", "PS5"])).toBe('<span class="factline"><span class="factline__fact"><bdi dir="ltr" class="factline__text">PS5</bdi></span></span>');
    expect(line([null, ""])).toBe("");
    expect(line(["a", "b"], 2)).toMatch(/^<span class="factline factline--2">/);
  });
});

describe("<BidiValue> — impact rows and other values with numbers", () => {
  const value = (text: string) => renderToStaticMarkup(createElement(BidiValue, { text }));

  it("cuts standalone signed numbers out, never the digits of a name", () => {
    expect(splitNumbers("300 ← 450")).toEqual([
      { text: "300", ltr: true },
      { text: " ← ", ltr: false },
      { text: "450", ltr: true },
    ]);
    expect(splitNumbers("−445,000 د.ع")).toEqual([
      { text: "−445,000", ltr: true },
      { text: " د.ع", ltr: false },
    ]);
    expect(splitNumbers("PS5 +2").map((part) => part.text)).toEqual(["PS5 ", "+2"]);
  });

  it("lays a value of numbers only out in the page's direction, the sign glued to its digits", () => {
    expect(value("300 ← 450")).toBe('<span class="bidi"><bdi dir="ltr">300</bdi> ← <bdi dir="ltr">450</bdi></span>');
    expect(value("−2 قطعة")).toBe('<span class="bidi"><bdi dir="ltr">−2</bdi> قطعة</span>');
    expect(value("+3,000")).toBe('<span class="bidi"><bdi dir="ltr">+3,000</bdi></span>');
  });

  it("keeps Latin text one left-to-right isolate", () => {
    expect(value("PS5 Pro")).toBe('<bdi dir="ltr">PS5 Pro</bdi>');
  });
});

describe("latinName — a clamped Latin name on a right-to-left page", () => {
  it("is laid out left to right (its ellipsis at its own end) and aligned to the page's start edge", () => {
    expect(latinName("Pokémon Legends: Z-A – Nintendo Switch 2 Edition", "rtl")).toEqual({ dir: "ltr", className: "text-end" });
    expect(latinName("PlayStation 5 Slim (نسخة الأقراص)", "rtl")).toEqual({});
    expect(latinName("Nintendo Switch 2", "ltr")).toEqual({});
    expect(latinName("2026", "rtl")).toEqual({});
  });
});

describe("textOf", () => {
  it("reads strings, numbers, arrays, nested elements and <BidiText text>", () => {
    expect(textOf(["PS5 ", 2, null, false, createElement("span", null, "ألعاب")])).toBe("PS5 2ألعاب");
    expect(textOf(createElement(Fragment, null, createElement(BidiText, { text: "Mario Kart World" }), " ·"))).toBe("Mario Kart World ·");
    expect(textOf(undefined)).toBe("");
  });
});
