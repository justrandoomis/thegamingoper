/**
 * The researched text as the product page shows it (pure, client-safe; tests/product.test.ts).
 *
 *   factParts(short) / factLine      the ONE fact line under the name: at most two facts of the short line (§6.7 item 5)
 *   withoutPreorder(items)           list items (highlights, in the box) without the ones that speak of pre-orders
 *   proseWithoutPreorder(text)       a paragraph without its sentences that speak of pre-orders
 *   keepTokens(text)                 names whose protected tokens never break across lines («Switch 2», «Z-A»)
 *
 * Why the pre-order filter: the research quotes makers and other shops ("open for pre-order ahead of 20 May 2027",
 * «مكافأة الطلب المسبق: …»). On this store's page such a sentence reads as the STORE's offer, and the store takes no
 * pre-orders (design v2 spec §6.7 states: "the highlights never claim pre-orders the store does not take"; §9 glossary:
 * never «طلب مسبق»). Coming-soon products say «يصدر … · الطلب يفتح عند وصوله» instead. The catalogue text itself is the
 * data owner's (requested there); until it is rewritten, the page leaves those sentences out.
 */

/** A hyphen inside a Latin or number token: "Z-A", "USB-C", "Joy-Con", "BEE-001" (not "(-01)", not a spaced one). */
const TOKEN_HYPHEN = /(?<=[\p{Script=Latin}\d])-(?=[\p{Script=Latin}\d])/gu;
/**
 * The space before a short Latin or number token — one to three characters ("2", "Pro", "S", "Z-A", "AI+", "(L)",
 * "2)") that ends there: not a longer word, not a decimal ("7.9"), not a token glued to Arabic or Sorani ("PS5ی").
 */
const BEFORE_SHORT = /(?<=\S) (?=\(?[\p{Script=Latin}\d][\p{Script=Latin}\d\u2011+]{0,2}\)?(?![\p{Script=Latin}\d\u2011+]|[.,\u066b]\d|[\u0600-\u06ff]))/gu;

/**
 * A name — or a sentence with names in it — whose protected tokens never break across lines (design v2 §4.18:
 * «Switch 2», «PS5 Pro», «Go 2» never break): the space before a short token becomes a no-break space (U+00A0), so
 * "2" never starts a line of its own («Nintendo Switch» / «2 Dock»), and a hyphen inside a Latin token becomes a
 * non-breaking hyphen (U+2011), so «Z-» never ends one («Pokémon Legends: Z-» / «A – …»). Longer words still wrap
 * at their spaces. Both characters stay inside a Latin run for the kit's splitBidi and for MixedText, so the text
 * is isolated exactly as before (tests/product.test.ts runs every catalogue text through both). Idempotent; pure.
 */
export function keepTokens(text: string): string {
  return text.replace(TOKEN_HYPHEN, "\u2011").replace(BEFORE_SHORT, "\u00a0");
}

/**
 * The shortest name that can take three lines at the h1 size on a 390px phone (26px Kufi in 358px; measured on every
 * Arabic page of the catalogue: each name that took three or four lines had 47 characters or more, none of 46 or
 * fewer did — a few of 47–50 still took two, and set one step down they stay two).
 */
export const LONG_NAME_CHARS = 47;

/**
 * A long name: on phones the product page sets it one step down (the h2 size), so a three- or four-line name does not
 * push the price, the demo tag and the stock line under the buy bar on first load (spec §6.7 target: y ≤ 760 at
 * 390×844). Counts characters (a no-break space or hyphen is one). Pure.
 */
export function isLongName(name: string): boolean {
  return [...name].length >= LONG_NAME_CHARS;
}

/** «طلب مسبق», «الطلب المسبق», «طلبات مسبقة», "pre-order(s)", "preorder", «پێشوەختە». */
const PREORDER = /طلب\S*\s+(?:ال)?مسبق|pre-?orders?\b|پێشوەختە/iu;

/** True when the text speaks of pre-orders. */
export function claimsPreorder(text: string): boolean {
  return PREORDER.test(text);
}

/** The items that do not speak of pre-orders. */
export function withoutPreorder(items: readonly string[]): string[] {
  return items.filter((item) => !claimsPreorder(item));
}

/** A paragraph without its sentences that speak of pre-orders (null when nothing is left). */
export function proseWithoutPreorder(text: string | null): string | null {
  if (!text || !claimsPreorder(text)) return text;
  const kept = text
    .split(/(?<=[.!؟?])\s+/u)
    .filter((sentence) => !claimsPreorder(sentence))
    .join(" ")
    .trim();
  return kept.length > 0 ? kept : null;
}

/**
 * The facts of the line under the name: at most two of the research's short line, none about pre-orders. The page draws
 * them as ONE line (§6.7 item 5): the second shows only when it fits beside the first (product.css `.pp-facts`).
 */
export function factParts(short: string | null): string[] {
  if (!short) return [];
  return withoutPreorder(
    short
      .split(" · ")
      .map((fact) => fact.trim())
      .filter(Boolean),
  ).slice(0, 2);
}

/** The same facts as one string (the page's meta description falls back to it). */
export function factLine(short: string | null): string | null {
  const facts = factParts(short);
  return facts.length > 0 ? facts.join(" · ") : null;
}

/**
 * The longest first fact that still fits one line on the narrowest phone (328px of 14px text at 360: about 46 Latin or
 * 54 Arabic characters, kept safely under both).
 */
export const FACT_LINE_CHARS = 42;

/** The fact row: its facts, and how it is drawn (product.tsx `.pp-facts`). */
export type FactRow = {
  facts: string[];
  /** One long fact, shown alone and wrapping. */
  wrap: boolean;
  /** The parts of one contents fact (joined by «+»): one line on a phone (the parts that fit), all of them from 768. */
  parts?: boolean;
};

/**
 * How the fact row is drawn. Usually ONE line (`wrap: false`): the first fact, and the second only when it fits beside
 * it. A first fact longer than a phone line is never cut with an ellipsis, which in Arabic would cut the START of a
 * Latin name at the line's end («…art World»):
 *   · a list of contents («جهاز Switch 2 بسعة 256GB + لعبة Mario Kart World كاملة (تنزيل رقمي)») is cut into its
 *     parts at " + " (`parts`): a phone shows the parts that fit on its one line, each whole — the first screen keeps
 *     the price and the stock line above the buy bar (spec §6.7 target) — the rest are listed in «في العلبة» / «في
 *     هذا الطقم» further down, and the line shows them all from 768; screen readers hear every part;
 *   · anything else, or a list whose first part alone is too long, is shown alone and wraps.
 * Pure.
 */
export function factRow(short: string | null): FactRow {
  const facts = factParts(short);
  const first = facts[0];
  if (first === undefined || first.length <= FACT_LINE_CHARS) return { facts, wrap: false };
  const parts = first
    .split(" + ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1 && parts[0].length <= FACT_LINE_CHARS) return { facts: parts, wrap: false, parts: true };
  return { facts: [first], wrap: true };
}
