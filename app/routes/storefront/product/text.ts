/**
 * The researched text as the product page shows it (pure, client-safe; tests/product.test.ts).
 *
 *   factParts(short) / factLine      the ONE fact line under the name: at most two facts of the short line (§6.7 item 5)
 *   withoutPreorder(items)           list items (highlights, in the box) without the ones that speak of pre-orders
 *   proseWithoutPreorder(text)       a paragraph without its sentences that speak of pre-orders
 *
 * Why the pre-order filter: the research quotes makers and other shops ("open for pre-order ahead of 20 May 2027",
 * «مكافأة الطلب المسبق: …»). On this store's page such a sentence reads as the STORE's offer, and the store takes no
 * pre-orders (design v2 spec §6.7 states: "the highlights never claim pre-orders the store does not take"; §9 glossary:
 * never «طلب مسبق»). Coming-soon products say «يصدر … · الطلب يفتح عند وصوله» instead. The catalogue text itself is the
 * data owner's (requested there); until it is rewritten, the page leaves those sentences out.
 */

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

/**
 * How the fact row is drawn. Usually ONE line (`wrap: false`): the first fact, and the second only when it fits beside
 * it. A first fact longer than a phone line (a set's contents: «جهاز Switch 2 بسعة 256GB + لعبة Mario Kart World كاملة…»)
 * is shown alone and wraps — never cut with an ellipsis, which in Arabic would cut the START of a Latin name at the
 * line's end («…art World»). Pure.
 */
export function factRow(short: string | null): { facts: string[]; wrap: boolean } {
  const facts = factParts(short);
  if (facts.length > 0 && facts[0].length > FACT_LINE_CHARS) return { facts: facts.slice(0, 1), wrap: true };
  return { facts, wrap: false };
}
