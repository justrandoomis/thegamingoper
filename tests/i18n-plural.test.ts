/**
 * Plural selection in translate(): CLDR's categories per language, plus an explicit `zero` form that is used for
 * exactly 0 in every language. English and Sorani have no "zero" category in CLDR (Intl.PluralRules picks "other"
 * for 0), so before this rule their "no items" wording was written but never shown.
 */
import { describe, expect, test } from "vitest";
import { translate, type MessageTree } from "~/i18n/translate";

const tree = (items: MessageTree["items"]): MessageTree => ({ items });

describe("plural forms", () => {
  const withZero = tree({ zero: "No items", one: "{count} item", other: "{count} items" });
  const withoutZero = tree({ one: "{count} item", other: "{count} items" });

  test("a zero form is used for 0 in English and Sorani too", () => {
    expect(translate(withZero, "en", "items", { count: 0 })).toBe("No items");
    expect(translate(withZero, "ckb", "items", { count: 0 })).toBe("No items");
    expect(translate(withZero, "en", "items", { count: "0" })).toBe("No items");
  });

  test("without a zero form, 0 falls back to the language's own category", () => {
    expect(translate(withoutZero, "en", "items", { count: 0 })).toBe("0 items");
  });

  test("other counts keep CLDR's categories", () => {
    expect(translate(withZero, "en", "items", { count: 1 })).toBe("1 item");
    expect(translate(withZero, "en", "items", { count: 2 })).toBe("2 items");
    expect(translate(withZero, "en", "items", { count: 0.5 })).toBe("0.5 items");
  });

  test("Arabic keeps all six categories", () => {
    const ar = tree({ zero: "لا عناصر", one: "عنصر واحد", two: "عنصران", few: "{count} عناصر", many: "{count} عنصراً", other: "{count} عنصر" });
    expect(translate(ar, "ar", "items", { count: 0 })).toBe("لا عناصر");
    expect(translate(ar, "ar", "items", { count: 1 })).toBe("عنصر واحد");
    expect(translate(ar, "ar", "items", { count: 2 })).toBe("عنصران");
    expect(translate(ar, "ar", "items", { count: 3 })).toBe("3 عناصر");
    expect(translate(ar, "ar", "items", { count: 11 })).toBe("11 عنصراً");
    expect(translate(ar, "ar", "items", { count: 100 })).toBe("100 عنصر");
  });
});
