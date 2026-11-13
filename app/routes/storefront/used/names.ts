/**
 * Device and product names as the used area lays them out (client-safe, pure):
 *
 *   bindDashes("Nintendo Switch – OLED Model")   → "Nintendo Switch – OLED Model" with a no-break space before the
 *                                                  dash: a wrapped (or `text-wrap: balance`d) name never starts a line
 *                                                  with «– OLED Model» (QA 2026-11-12, the unit page's h1)
 *   keepLatinHyphens("جووتە Joy-Con")            → "جووتە Joy‑Con": a Latin name never breaks at its hyphen
 *   splitQualifier("PlayStation 5 Digital Edition (الطراز الأصلي 2020)")
 *                                                → { base: "PlayStation 5 Digital Edition", qualifier: "الطراز الأصلي 2020" }:
 *                                                  the trailing bracket that tells two models apart goes on a meta line
 *                                                  of its own instead of being cut by the name's two-line clamp
 *                                                  (Design System v2 §4.11)
 */

const NBSP = " ";

/** A spaced dash (en, em or hyphen) stays on the line of the word before it. */
export function bindDashes(name: string): string {
  return name.replace(/ ([–—-]) /g, `${NBSP}$1 `);
}

/**
 * A model's short token stays with the word before it — «PlayStation 5», «Series X», «Go 2», «Claw 8 EX AI+» (one
 * to three letters or digits that start with a capital or a digit): a narrow tile breaks "PlayStation 5 / Slim", never
 * "PlayStation / 5 Slim" (design v2 §4.18, as the product page's names). Longer words still wrap at their spaces. Pure.
 */
export function bindNameTokens(name: string): string {
  return name.replace(/ (?=[A-Z0-9][A-Za-z0-9+]{0,2}(?![A-Za-z0-9+]))/g, NBSP);
}

/** The non-breaking hyphen (U+2011): a line never breaks at it, and it stays inside its Latin run. */
const NB_HYPHEN = String.fromCharCode(0x2011);

/**
 * A hyphen inside a Latin name or code («Joy-Con», "USB-C") becomes the non-breaking hyphen: in a Sorani or Arabic
 * sentence the name broke at it and the hyphen was drawn on the wrong side («جووتە -Joy / Con» — round-1 fixes); the
 * product page keeps its names whole the same way. Spaced dashes and Arabic text are left as they are. Pure.
 */
export function keepLatinHyphens(text: string): string {
  return text.replace(/(?<=[A-Za-z0-9])-(?=[A-Za-z0-9])/g, NB_HYPHEN);
}

/** The name without its trailing bracketed qualifier, and the qualifier's words (null when there is none). */
export function splitQualifier(name: string): { base: string; qualifier: string | null } {
  const match = /^(.*\S)\s+\(([^()]+)\)$/u.exec(name.trim());
  if (!match) return { base: name, qualifier: null };
  return { base: match[1], qualifier: match[2].trim() };
}
