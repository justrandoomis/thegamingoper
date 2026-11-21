/**
 * Text rules for the Switch library: Wikipedia lead extracts cut at a sentence end, the words the store never prints
 * (docs/switch-builder.md §1.1) kept out of everything the build ships, the characters that could disguise a title
 * removed from it, page-language titles in the store's digits, and the one form of Wikipedia link the store prints.
 */

export const EXTRACT_MAX = 900;

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = /(?:^|[\s(])(?:Inc|Ltd|Co|Corp|Jr|Sr|Mr|Mrs|Ms|Dr|St|vs|No|Vol|Nos|approx|ca|cf|e\.g|i\.e|etc)$/i;

/** Indexes just after each sentence end in `text`: . ! ? ؟ (with closing quotes or brackets) before a space or the end. */
export function sentenceEnds(text) {
  const ends = [];
  for (const match of text.matchAll(/[.!?؟](?:["'”’»)\]]*)(?=\s|$)/g)) {
    const at = match.index;
    if (text[at] === ".") {
      const before = text.slice(Math.max(0, at - 8), at);
      if (/(?:^|[\s(.])\p{Lu}$/u.test(before)) continue; // an initial: "U.S.", "J. R."
      if (ABBREVIATIONS.test(before)) continue;
      if (/\d$/.test(before) && /^\d/.test(text.slice(at + 1))) continue;
    }
    ends.push(at + match[0].length);
  }
  return ends;
}

/**
 * Plain text of at most `max` characters, cut after the last sentence that fits. When no sentence end fits, cut at
 * the last space and mark the cut with "…".
 */
export function cutAtSentence(text, max = EXTRACT_MAX) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const fitting = sentenceEnds(clean).filter((end) => end <= max);
  if (fitting.length > 0) return clean.slice(0, fitting[fitting.length - 1]).trim();
  const space = clean.lastIndexOf(" ", max - 1);
  return `${clean.slice(0, space > 0 ? space : max - 1).trim()}…`;
}

/**
 * The words §1.1 of the contract keeps out of the store — and the "similar" ones it also means: their other forms
 * (-ing, -er, the plural noun, the English for the third Arabic phrase), that phrase without its final letter or with
 * the Arabic word for "installed", and the Arabic word for piracy (Arabic Wikipedia writes the genre "hack and slash"
 * with it) — in any form of the build's output. Written as patterns that do not spell the words out, because the rule
 * covers this source too. A bare "hack" is not matched: the genre name "hack and slash" stays.
 *
 * Text is compared in NFKC form, without Arabic diacritics and tatweel and without invisible format characters, so a
 * shadda, a presentation form or a zero-width character inside a word does not hide it (review 2026-11-21).
 */
const FORBIDDEN = [
  /\bmod(?:d(?:ed|ing|ers?)|s)\b/i,
  /\bjail-?br(?:o)ke(?:n)?\b/i,
  /\bjail-?br(?:e)ak(?:s|ing|ers?)?\b/i,
  /\bhac[k](?:ed|ing|ers?)\b/i,
  /\bpre-?ins[t]all(?:ed|ing|s)?\b/i,
  /\bpre-?lo[a]ded\b/i,
  /م[ه]كر/,
  /ت[ه]كير/,
  /محم[ل][ةه]? مسبق/,
  /مثب[ت][ةه]? مسبق/,
  /قرص[ن]/,
];
/** Arabic harakat (shadda, sukun…), superscript alef and tatweel; zero-width and other invisible format characters; the soft hyphen. */
const IGNORED = /[\u{64B}-\u{65F}\u{670}\u{640}\u{200B}-\u{200F}\u{2060}-\u{2064}\u{FEFF}\u{AD}]/gu;

export function hasForbiddenWord(text) {
  if (typeof text !== "string") return false;
  const plain = text.normalize("NFKC").replace(IGNORED, "");
  return FORBIDDEN.some((pattern) => pattern.test(plain));
}

/**
 * The extract up to (not including) the first sentence that holds a forbidden word — still a lead excerpt cut at a
 * sentence end; null when the first sentence already holds one.
 */
export function withoutForbiddenSentences(text) {
  if (!hasForbiddenWord(text)) return text;
  let start = 0;
  let kept = "";
  for (const end of [...sentenceEnds(text), text.length]) {
    const sentence = text.slice(start, end);
    if (hasForbiddenWord(sentence)) break;
    kept = text.slice(0, end);
    start = end;
  }
  const trimmed = kept.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * What app/server/text.server.ts cleanText removes from text staff read, removed from every string the build ships
 * (qa-security 2026-11-21): C0 and C1 control characters, the bidirectional embedding / override / isolate controls
 * (U+202A–U+202E, U+2066–U+2069 — an edited Wikidata label or Wikipedia page could otherwise reorder how a title looks
 * on the page), zero-width space, word joiner and a stray BOM. Line breaks and tabs become a space: a library string is
 * one line. Kept, as there: ZWNJ / ZWJ (Sorani and Persian spelling) and the LRM / RLM marks.
 * tests/switch-library-data.test.ts checks that the two sets are the same.
 */
const LINE_BREAKS = /\r\n?|[\n\t\u{85}\u{2028}\u{2029}]/gu;
const DISGUISING = /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}-\u{9F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}\u{2060}\u{FEFF}]/gu;

/**
 * The text without those characters, as one line. Text that holds none comes back as it is; text that did loses them,
 * with its spaces collapsed and trimmed. Anything but a string gives "".
 */
export function cleanLibraryText(text) {
  if (typeof text !== "string") return "";
  const cleaned = text.replace(LINE_BREAKS, " ").replace(DISGUISING, "");
  return cleaned === text ? text : cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Arabic-Indic (U+0660–U+0669) and extended Arabic-Indic (U+06F0–U+06F9) digits as Western digits. The store prints
 * Western digits in every language (docs/DESIGN.md §5.5), and a page-language title shares its line with the year and
 * the size: Wikidata's Sorani «… ١١» next to «2019» mixed two digit systems on one card (qa-visual 2026-11-21).
 */
export function westernDigits(text) {
  return text.replace(/[\u{660}-\u{669}\u{6F0}-\u{6F9}]/gu, (digit) => String(digit.codePointAt(0) - (digit.codePointAt(0) >= 0x6f0 ? 0x6f0 : 0x660)));
}

/**
 * The article link, canonical, when it is the one form the store prints under the word "Wikipedia" — https, the
 * `lang` wiki's own host, an article path, no user name, password or port; otherwise null. fetch-wikipedia.mjs
 * applies the same rule when it fetches; build.mjs applies it again to the committed snapshot, so an older or
 * hand-edited snapshot can never ship another link.
 */
export function wikipediaUrlOf(url, lang) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const own = parsed.protocol === "https:" && parsed.hostname === `${lang}.wikipedia.org` && parsed.pathname.startsWith("/wiki/");
  return own && !parsed.username && !parsed.password && !parsed.port ? parsed.href : null;
}
