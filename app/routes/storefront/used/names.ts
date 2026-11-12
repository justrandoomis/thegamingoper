/**
 * Device and product names as the used area lays them out (client-safe, pure):
 *
 *   bindDashes("Nintendo Switch – OLED Model")   → "Nintendo Switch – OLED Model" with a no-break space before the
 *                                                  dash: a wrapped (or `text-wrap: balance`d) name never starts a line
 *                                                  with «– OLED Model» (QA 2026-11-12, the unit page's h1)
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

/** The name without its trailing bracketed qualifier, and the qualifier's words (null when there is none). */
export function splitQualifier(name: string): { base: string; qualifier: string | null } {
  const match = /^(.*\S)\s+\(([^()]+)\)$/u.exec(name.trim());
  if (!match) return { base: name, qualifier: null };
  return { base: match[1], qualifier: match[2].trim() };
}
