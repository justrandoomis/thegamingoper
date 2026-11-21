/**
 * Switch bundle builder — the game search (pure, client-safe). Contract: docs/switch-builder.md §6.4.
 *
 * The open list holds ~4,900 games; the search runs in the browser as the shopper types (debounced by the page), over
 * each game's titles (the Latin title, the Arabic and Sorani labels), its aliases and series names, and its publishers.
 *
 *   normalizeSearchText("أسطورة زيلدا")    → "اسطوره زيلدا"   a port of ~/server/db/search.server normalizeSearchText
 *   searchTerms("ماريو كارت")              → [{ forms: ["ماريو", "mario"] }, { forms: ["كارت", "kart"] }]
 *   gameSearchKey(game)                    → the game's normalised text, built once per list
 *   matchTier(searchTerms(q), key)         → 0 (every word starts a word of a title) · 1 (… of any searched text) ·
 *                                            2 (found inside a word) · null (no match)
 *
 * Arabic and Sorani are folded the way the store's product search folds them (hamza forms, alef maqsura, teh marbuta,
 * Kurdish yeh/kaf/ae, tatweel, diacritics, Arabic-Indic digits), an Arabic article or conjunction in front of a word
 * is read without it («الزيلدا» → «زيلدا»), and the way shoppers in Iraq spell the big series in Arabic letters
 * («ماريو», «زيلدا», «بوكيمون»…) also finds the Latin title. Search help only: it can only find games of the list.
 */

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Letter variants that people type interchangeably, folded to one form (the store's product search folds the same). */
const FOLD: Record<string, string> = {
  "ى": "ي", // alef maqsura → yeh
  "ی": "ي", // Farsi / Kurdish yeh → yeh
  "ئ": "ي", // yeh with hamza above → yeh
  "ک": "ك", // Kurdish / Persian kaf → kaf
  "ة": "ه", // teh marbuta → heh
  "ە": "ه", // Kurdish ae → heh
  "ؤ": "و", // waw with hamza above → waw
  "ٱ": "ا", // alef wasla → alef
  "ـ": "", // tatweel
};

/** Zero-width joiners and non-joiners, directional marks and isolates, the byte-order mark: removed. */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/u;
const MARK = /\p{M}/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Canonical form for searching: lower case, Latin digits, no diacritics or tashkeel, unified Arabic/Kurdish letter
 * variants, punctuation turned into single spaces. The same function as the store's product search
 * (~/server/db/search.server normalizeSearchText), ported here because that module is server-only.
 */
export function normalizeSearchText(input: string | null | undefined): string {
  if (!input) return "";
  let out = "";
  // Trademark signs would otherwise glue "tm" / "r" onto the word before them.
  const text = input.replace(/[™®©℠]/g, " ");
  // NFKD splits letters from their marks (é → e + ´, أ → ا + hamza); the marks are dropped below.
  for (const ch of text.normalize("NFKD")) {
    if (MARK.test(ch)) continue;
    const folded = FOLD[ch];
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    const arabicDigit = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (arabicDigit !== -1) {
      out += String(arabicDigit);
      continue;
    }
    const persianDigit = PERSIAN_DIGITS.indexOf(ch);
    if (persianDigit !== -1) {
      out += String(persianDigit);
      continue;
    }
    if (INVISIBLE.test(ch)) continue;
    out += WORD_CHAR.test(ch) ? ch.toLowerCase() : " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * How shoppers write the big Switch series in Arabic letters (Arabic as written in Iraq, Sorani), with the Latin words
 * the list's titles use. Search help: a spelling only adds the Latin words as another way to match.
 */
const GAME_SPELLINGS: ReadonlyArray<readonly [readonly string[], string]> = [
  [["ماريو", "ماريۆ", "ماریۆ"], "mario"],
  [["لويجي", "لوجي", "لويغي"], "luigi"],
  [["زيلدا", "زلدا", "زێلدا"], "zelda"],
  [["بوكيمون", "بوكمون", "بوكيمن", "پۆکیمۆن", "پوکیمون"], "pokemon"],
  [["كيربي", "كربي", "کێربی"], "kirby"],
  [["ميترويد", "مترويد", "ميتروید"], "metroid"],
  [["سبلاتون", "سبلاتوون"], "splatoon"],
  [["سونيك", "سونك", "سۆنیک"], "sonic"],
  [["دونكي كونغ", "دونكي كونج", "دانكي كونج", "دانكي كونغ"], "donkey kong"],
  [["ماين كرافت", "ماينكرافت", "ماین کرافت"], "minecraft"],
  [["فورتنايت", "فورت نايت"], "fortnite"],
  [["فيفا"], "fifa"],
  [["كارت"], "kart"],
  [["سماش"], "smash"],
  [["بيكمين", "بكمين"], "pikmin"],
  [["انيمال كروسينغ", "انيمال كروسنج", "انمال كروسنغ", "انيمال كروسينج"], "animal crossing"],
  [["هيدز", "هاديس"], "hades"],
  [["هولو نايت"], "hollow knight"],
  [["ستاردو فالي", "ستارديو فالي"], "stardew valley"],
  [["ويتشر"], "witcher"],
  [["دووم"], "doom"],
  [["فاينل فانتسي", "فاينل فانتازي"], "final fantasy"],
  [["سكايرم"], "skyrim"],
  [["اوفركوكد", "اوفر كوكد"], "overcooked"],
  [["كراش"], "crash"],
  [["سبايرو"], "spyro"],
  [["ريمان"], "rayman"],
  [["بيونيتا"], "bayonetta"],
  [["زينوبليد", "زينوبلید"], "xenoblade"],
  [["فاير ايمبلم", "فاير امبلم"], "fire emblem"],
];

/** An Arabic article or conjunction glued in front of a word; the rest keeps at least three letters. */
const ARABIC_PREFIX = /^(وال|بال|فال|كال|لل|ال)(?=\S{3,}$)/;
const LATIN = /[a-z]/;

type Spelling = { tokens: string[]; words: string[] };

/** Normalised spellings, longest (most words) first so «دونكي كونغ» is read before «كونغ». */
const SPELLINGS: Spelling[] = GAME_SPELLINGS.flatMap(([forms, words]) =>
  forms.map((form) => ({ tokens: normalizeSearchText(form).split(" ").filter(Boolean), words: words.split(" ") })),
)
  .filter((spelling) => spelling.tokens.length > 0 && !spelling.tokens.some((token) => LATIN.test(token)))
  .sort((a, b) => b.tokens.length - a.tokens.length);

/** One word of the query: the game must contain one of its forms. */
export type SearchTerm = { forms: string[] };

/** At most this many words of a query are used. */
const MAX_TERMS = 8;

const strip = (token: string) => (LATIN.test(token) ? token : token.replace(ARABIC_PREFIX, ""));

/**
 * The query as search terms: normalised words (each once, at most eight), each with its other forms — the word without
 * an Arabic article in front, and the Latin words a known Arabic spelling stands for. The LAST word may still be being
 * typed: «بوكي» also stands for "pokemon". Pure.
 */
export function searchTerms(query: string): SearchTerm[] {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  const terms: SearchTerm[] = [];
  const seen = new Set<string>();
  for (let at = 0; at < tokens.length && terms.length < MAX_TERMS; ) {
    // a spelling of several words («دونكي كونغ») is read first, as one term per Latin word
    const multi = SPELLINGS.find((spelling) => spelling.tokens.length > 1 && spelling.tokens.every((token, offset) => strip(tokens[at + offset] ?? "") === token));
    if (multi) {
      multi.words.forEach((word, index) => {
        const typed = tokens[at + index] ?? word;
        terms.push({ forms: unique([word, typed, strip(typed)]) });
      });
      at += multi.tokens.length;
      continue;
    }
    const token = tokens[at];
    const bare = strip(token);
    const last = at === tokens.length - 1;
    const forms = [token, bare];
    for (const spelling of SPELLINGS) {
      if (spelling.tokens.length !== 1) {
        // a word that begins a spelling of several words, as the shopper is still typing: «دونكي» → donkey
        if (last && spelling.tokens[0] === bare) forms.push(spelling.words[0]);
        continue;
      }
      const form = spelling.tokens[0];
      if (form === bare || (last && bare.length >= 3 && form.startsWith(bare))) forms.push(...spelling.words);
    }
    const key = unique(forms).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      terms.push({ forms: unique(forms) });
    }
    at += 1;
  }
  return terms.slice(0, MAX_TERMS);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** What a game is searched by (the fields of a LibraryGame the search reads). */
export type SearchableGame = { title: string; titleAr?: string; titleCkb?: string; aliases?: string[]; publishers?: string[] };

/** A game's searchable text, normalised once (" " + words + " ", so a word start is " " + term). */
export type GameSearchKey = { titles: string; all: string };

export function gameSearchKey(game: SearchableGame): GameSearchKey {
  const titles = [game.title, game.titleAr, game.titleCkb].map(normalizeSearchText).filter(Boolean).join(" ");
  const others = [...(game.aliases ?? []), ...(game.publishers ?? [])].map(normalizeSearchText).filter(Boolean).join(" ");
  return { titles: ` ${titles} `, all: ` ${titles} ${others} ` };
}

const startsAWord = (text: string, form: string) => text.includes(` ${form}`);
/** Inside a word only for forms long enough not to catch everything ("art" in "kart"): three characters or more. */
const inside = (text: string, form: string) => [...form].length >= 3 && text.includes(form);

/**
 * How well a game matches the terms: 0 — every term starts a word of one of its titles; 1 — every term starts a word
 * of its titles, aliases, series or publishers; 2 — every term is found, some inside a word; null — some term is not
 * found. No terms: 0 (everything matches). Pure.
 */
export function matchTier(terms: readonly SearchTerm[], key: GameSearchKey): 0 | 1 | 2 | null {
  if (terms.length === 0) return 0;
  let tier: 0 | 1 | 2 = 0;
  for (const term of terms) {
    if (term.forms.some((form) => startsAWord(key.titles, form))) continue;
    if (term.forms.some((form) => startsAWord(key.all, form))) {
      tier = tier < 1 ? 1 : tier;
      continue;
    }
    if (term.forms.some((form) => inside(key.all, form))) {
      tier = 2;
      continue;
    }
    return null;
  }
  return tier;
}
