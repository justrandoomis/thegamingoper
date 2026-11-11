/**
 * Message catalogues — every namespace in app/i18n/messages must be complete and consistent in all
 * three languages. Arabic is the source; English and Kurdish (Sorani) ship with it.
 *
 * Namespace files are discovered the way the app discovers them (one file = one namespace), so a
 * file another team adds is checked the moment it exists. For each one:
 *
 *   · it exports `defineMessages({ ar, en, ckb })` as default — exactly those three locales
 *   · the three locales have the same message keys (a plural message counts as one key)
 *   · each message uses the same {placeholders} in every locale (a plural message: across its forms)
 *   · plural messages have an `other` form and only CLDR category names (zero one two few many other)
 *   · values are strings or plural objects, no string is empty, and every key can be reached by
 *     t() (no empty keys, no "." inside a key)
 *
 * One test per namespace, reporting every problem of that file at once with its exact keys, so the
 * owner of the file can fix it without guessing. Each file is imported inside its own test: a broken
 * file fails its own test and nobody else's.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { LOCALE_CODES, type Locale } from "~/lib/locales";
import { translate, type MessageTree } from "~/i18n/translate";

const MESSAGES_DIR = fileURLToPath(new URL("../app/i18n/messages/", import.meta.url));

const loaders = import.meta.glob<{ default?: unknown }>("../app/i18n/messages/*.ts");
const loaderByNamespace = new Map(Object.entries(loaders).map(([path, load]) => [path.slice(path.lastIndexOf("/") + 1, -".ts".length), load]));
const NAMESPACES = [...loaderByNamespace.keys()].sort();

const SOURCE: Locale = "ar";
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
const PLACEHOLDER = /\{(\w+)\}/g;

// ───────────────────────────────────────────────────────────────── flattening

/** One message: its texts (one for a string, one per form for a plural) and where it was found. */
type Message = { kind: "text" | "plural"; texts: string[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** An object whose keys are all plural categories (and that uses a category no tree would use as a key) but has no `other`. */
function looksLikePluralWithoutOther(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    !("other" in value) &&
    keys.every((key) => (PLURAL_CATEGORIES as readonly string[]).includes(key) && typeof value[key] === "string") &&
    keys.some((key) => key === "zero" || key === "few" || key === "many")
  );
}

/**
 * Message key → message, for one locale's tree. A node is a message when it is a string or an object
 * with a string `other` (exactly what translate.ts treats as one); every other object is a branch.
 */
function flatten(tree: unknown, locale: Locale, problems: string[]): Map<string, Message> {
  const out = new Map<string, Message>();
  const walk = (node: Record<string, unknown>, path: string[]) => {
    for (const [key, value] of Object.entries(node)) {
      const at = [...path, key].join(".");
      if (key.trim() === "" || key.includes(".")) problems.push(`${locale}: key "${at}" cannot be reached by t() — keys must be non-empty and contain no "."`);

      if (typeof value === "string") {
        out.set(at, { kind: "text", texts: [value] });
      } else if (
        isPlainObject(value) &&
        typeof value.other === "string" &&
        Object.keys(value).every((form) => (PLURAL_CATEGORIES as readonly string[]).includes(form))
      ) {
        // Exactly translate.ts's rule: only an object whose keys are all plural categories is a plural message.
        // An object with `other` and any other key is a branch ("reasons.other" is an ordinary key); a mistyped
        // plural form then shows up as keys that differ from the source language.
        const texts: string[] = [];
        for (const form of PLURAL_CATEGORIES) {
          if (!(form in value)) continue;
          if (typeof value[form] === "string") texts.push(value[form] as string);
          else problems.push(`${locale}: plural form "${at}.${form}" is not a string`);
        }
        out.set(at, { kind: "plural", texts });
      } else if (isPlainObject(value)) {
        if (looksLikePluralWithoutOther(value)) problems.push(`${locale}: "${at}" looks like a plural message but has no "other" form, which is required`);
        else walk(value, [...path, key]);
      } else {
        problems.push(`${locale}: "${at}" is ${Array.isArray(value) ? "an array" : value === null ? "null" : `a ${typeof value}`} — a message must be a string or a plural object`);
      }
    }
  };
  if (isPlainObject(tree)) walk(tree, []);
  else problems.push(`${locale}: the messages must be an object, got ${tree === null ? "null" : Array.isArray(tree) ? "an array" : typeof tree}`);
  return out;
}

const placeholdersOf = (message: Message): string[] => [...new Set(message.texts.flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1])))].sort();

const list = (names: string[]) => (names.length === 0 ? "none" : names.map((name) => `{${name}}`).join(" "));

/** Every problem of one namespace's default export, as sentences. Empty when it is well-formed. */
function problemsOf(messages: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(messages)) return [`the default export must be defineMessages({ ar, en, ckb }), got ${messages === undefined ? "nothing" : typeof messages}`];

  const locales = Object.keys(messages);
  const missingLocales = LOCALE_CODES.filter((locale) => !locales.includes(locale));
  const extraLocales = locales.filter((locale) => !(LOCALE_CODES as readonly string[]).includes(locale));
  if (missingLocales.length > 0) problems.push(`missing locale(s): ${missingLocales.join(", ")}`);
  if (extraLocales.length > 0) problems.push(`unknown locale(s): ${extraLocales.join(", ")} (expected ${LOCALE_CODES.join(", ")})`);

  const flat = new Map<Locale, Map<string, Message>>();
  for (const locale of LOCALE_CODES) if (locale in messages) flat.set(locale, flatten(messages[locale], locale, problems));

  // No empty strings anywhere.
  for (const [locale, entries] of flat) {
    for (const [key, message] of entries) {
      if (message.texts.some((text) => text.trim() === "")) problems.push(`${locale}: "${key}" is an empty string`);
    }
  }

  // Same keys and same placeholders as the source language.
  const source = flat.get(SOURCE);
  if (source) {
    for (const [locale, entries] of flat) {
      if (locale === SOURCE) continue;
      const missing = [...source.keys()].filter((key) => !entries.has(key));
      const extra = [...entries.keys()].filter((key) => !source.has(key));
      if (missing.length > 0) problems.push(`${locale} is missing ${missing.length} key(s) that ${SOURCE} has: ${missing.join(", ")}`);
      if (extra.length > 0) problems.push(`${locale} has ${extra.length} key(s) that ${SOURCE} does not: ${extra.join(", ")}`);
      for (const [key, message] of source) {
        const other = entries.get(key);
        if (!other) continue;
        const expected = placeholdersOf(message);
        const actual = placeholdersOf(other);
        if (expected.join() !== actual.join()) problems.push(`"${key}": ${SOURCE} uses ${list(expected)} but ${locale} uses ${list(actual)}`);
      }
    }
  }
  return problems;
}

// ───────────────────────────────────────────────────────────────── tests

describe("message catalogues", () => {
  test("namespace files are found, and the app's registry knows exactly the same ones", async () => {
    const files = readdirSync(MESSAGES_DIR)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.slice(0, -".ts".length))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    expect(NAMESPACES).toEqual(files);
    // The shell's own namespaces are always there.
    expect(NAMESPACES).toEqual(expect.arrayContaining(["common", "ui"]));

    const registry = await import("~/i18n/i18n.server");
    expect(registry.listNamespaces()).toEqual(files);
  });

  test.each(NAMESPACES)("%s: same keys, same placeholders, plural forms and no empty strings in ar, en and ckb", async (namespace) => {
    const loaded = await loaderByNamespace.get(namespace)!();
    const problems = problemsOf(loaded.default);
    expect(problems, `app/i18n/messages/${namespace}.ts`).toEqual([]);
  });

  test("every message resolves through the runtime lookup in every locale", async () => {
    // Not just well-formed on paper: translate() finds each key, and a plural yields text for any count.
    for (const namespace of NAMESPACES) {
      const { default: messages } = await loaderByNamespace.get(namespace)!();
      if (problemsOf(messages).length > 0) continue; // reported, with details, by the test above
      const trees = messages as Record<Locale, MessageTree>;
      for (const locale of LOCALE_CODES) {
        for (const [key, message] of flatten(trees[locale], locale, [])) {
          for (const count of message.kind === "plural" ? [0, 1, 2, 3, 11, 100, 1.5] : [undefined]) {
            const where = `${namespace}:${key} (${locale}${count === undefined ? "" : `, count ${count}`})`;
            const text = translate(trees[locale], locale, key, count === undefined ? undefined : { count });
            expect(text, where).toBeTypeOf("string");
            expect(text?.trim(), where).not.toBe("");
          }
        }
      }
    }
  });
});

describe("the checker itself", () => {
  // The rules above must catch real mistakes, not just pass on today's files.
  const wellFormed = {
    ar: { title: "السلة", items: { zero: "لا عناصر", one: "عنصر واحد", two: "عنصران", few: "{count} عناصر", many: "{count} عنصراً", other: "{count} عنصر" }, greet: { hello: "مرحباً {name}" } },
    en: { title: "Cart", items: { one: "{count} item", other: "{count} items" }, greet: { hello: "Hello {name}" } },
    ckb: { title: "سەبەتە", items: { one: "{count} بابەت", other: "{count} بابەت" }, greet: { hello: "سڵاو {name}" } },
  };

  test("a well-formed namespace passes, with plural forms that differ between languages", () => {
    expect(problemsOf(wellFormed)).toEqual([]);
  });

  test("each kind of mistake is reported with its key", () => {
    const broken = {
      ar: { ...wellFormed.ar, only: "عربي فقط", nested: { deep: "عميق" }, empty: " ", "bad.key": "نقطة" },
      en: { ...wellFormed.en, greet: { hello: "Hello" }, extra: "English only", nested: { deep: "" }, empty: "x", "bad.key": "dot", count: { one: "one item", few: "{count} items" } },
      ckb: { title: "سەبەتە", items: { other: "{count} بابەت", lots: "زۆر" }, greet: { hello: "سڵاو {name}" }, only: "تەنها", nested: { deep: 7 }, empty: "y", "bad.key": "خاڵ" },
      fr: { title: "Panier" },
    };
    const problems = problemsOf(broken).join("\n");
    expect(problems).toContain("unknown locale(s): fr");
    expect(problems).toContain('en is missing 1 key(s) that ar has: only');
    expect(problems).toContain("en has 1 key(s) that ar does not: extra");
    expect(problems).toContain('"greet.hello": ar uses {name} but en uses none');
    expect(problems).toContain('en: "nested.deep" is an empty string');
    expect(problems).toContain('ar: "empty" is an empty string');
    expect(problems).toContain('ar: key "bad.key" cannot be reached by t()');
    expect(problems).toContain('en: "count" looks like a plural message but has no "other" form');
    // `{ other, lots }` is a branch (not a plural): the mistyped form surfaces as keys the source does not have
    expect(problems).toContain("ckb has 2 key(s) that ar does not: items.other, items.lots");
    expect(problems).toContain('ckb: "nested.deep" is a number');

    expect(problemsOf(undefined)).toEqual(["the default export must be defineMessages({ ar, en, ckb }), got nothing"]);
    expect(problemsOf({ ar: { a: "أ" }, en: { a: "A" } })).toEqual(["missing locale(s): ckb"]);
    expect(problemsOf({ ar: [], en: {}, ckb: {} })).toEqual(["ar: the messages must be an object, got an array"]);
  });
});
