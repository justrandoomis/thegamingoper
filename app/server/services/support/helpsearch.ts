/**
 * The help centre's search — the part that needs no database, shared by the server and the page (pure, client-safe,
 * like ./matcher):
 *
 *   kb.server searchHelp      the results page (`/support?q=`): every approved public guide ranked by these rules,
 *                             their bodies included
 *   the page's search box     instant suggestions while typing, from the index the loader sends (kb.server
 *                             getHelpIndex: titles, summaries, names and tags in every language, and the error codes
 *                             each guide names — no bodies), ranked by the same rules — a suggestion and a result
 *                             match a guide for the same reason (a body word may only reorder the results a little)
 *
 *   rankEntries(entries, q)                    guides by the words (title or device name 3 · summary or tag 2 · body
 *                                              1) and by the symptom or topic the words point to (+3); staff order
 *                                              breaks ties; a word that only appears in a body is noise beside a
 *                                              title match
 *   suggestHelp(index, policies, q, opts)      what the box suggests: a danger sign first (and nothing else), an error
 *                                              code with the guides that name it, else guides and policies
 *   matchPolicies(policies, q)                 the store's policies by their titles and the words people use for them
 *   highlightParts(text, q)                    a text cut into runs, the words that matched marked
 *   COMMON_PROBLEMS                            the chips under the box: each one's words lead to guides of one tag
 *
 * Nothing here invents an answer: it can only point at guides and policies that exist.
 */
import { aliasWords, findErrorCode, hasDangerSign, interpretText, KNOWN_SYMPTOMS, normalizeForMatch, tokenMatches } from "./matcher";

/** Symptom keys of the assistant's trees → the article tag that covers them. */
export const SYMPTOM_TAGS: Readonly<Record<string, string>> = { stick_drift: "stick-drift", no_power: "power" };

/** Words too common to rank a guide by — every guide is about "the device" (Arabic, English, Sorani; normalised). */
export const NOISE: ReadonlySet<string> = new Set(
  ["في", "من", "على", "عن", "مع", "او", "لا", "ما", "هو", "هي", "the", "a", "an", "my", "is", "it", "to", "of", "and", "or", "not", "لە", "و", "بە", "بۆ", "کە", "كه", "جهاز", "جهازي", "الجهاز", "device", "console", "ئامێر", "ئامێرەکە", "ئامێرەکەم"].map(normalizeForMatch),
);

/** The fewest characters the box suggests for. */
export const MIN_SUGGEST_CHARS = 2;

/**
 * The words of a query that rank a guide: normalised, each once, two letters or more, the noise left out — plus the
 * catalogue's words for the device names the shopper spelled their way («بلايستيشن» → "playstation", ./matcher
 * aliasWords), so an Arabic spelling finds (and marks) a Latin name.
 */
export function queryWords(query: string): string[] {
  return [...new Set([...normalizeForMatch(query).split(" "), ...aliasWords(query)])].filter((word) => word.length >= 2 && !NOISE.has(word));
}

/** The article tag the words point to — a symptom of the assistant's trees or a topic — or null. */
export function meantTag(query: string): string | null {
  const meaning = interpretText(query, { symptoms: KNOWN_SYMPTOMS });
  if (meaning.kind === "symptom") return SYMPTOM_TAGS[meaning.symptomKey] ?? null;
  if (meaning.kind === "topic") return meaning.topic;
  return null;
}

// ───────────────────────────────────────────────────────────────── ranking guides

/** What a guide is searched by. Texts may hold every language at once (the index joins them). */
export type HelpEntryText = { title: string; summary: string; names: string; tags: readonly string[]; body?: string };

type Tokens = { title: string[]; names: string[]; summary: string[]; tags: string[]; body: string[] };
const tokenCache = new WeakMap<object, Tokens>();
const split = (text: string | undefined) => (text ? normalizeForMatch(text).split(" ").filter(Boolean) : []);

function tokensOf(entry: HelpEntryText): Tokens {
  let tokens = tokenCache.get(entry);
  if (!tokens) {
    tokens = { title: split(entry.title), names: split(entry.names), summary: split(entry.summary), tags: split(entry.tags.join(" ").replace(/-/g, " ")), body: split(entry.body) };
    tokenCache.set(entry, tokens);
  }
  return tokens;
}

const hit = (tokens: readonly string[], word: string) => tokens.some((token) => tokenMatches(token, word));

/** A guide's score for the words: title or device name 3 · summary or tag 2 · body 1 per word, +3 for the meant tag. */
export function scoreEntry(entry: HelpEntryText, words: readonly string[], meant: string | null): number {
  const tokens = tokensOf(entry);
  let score = meant && entry.tags.includes(meant) ? 3 : 0;
  for (const word of words) {
    if (hit(tokens.title, word) || hit(tokens.names, word)) score += 3;
    else if (hit(tokens.summary, word) || hit(tokens.tags, word)) score += 2;
    else if (hit(tokens.body, word)) score += 1;
  }
  return score;
}

/**
 * Guides ranked for a query, best first (staff order — the entries' order — breaks ties). When some guides match by
 * their title, summary, tags or meaning (3 and more), a guide that only matched a word in its body is left out.
 */
export function rankEntries<T extends HelpEntryText>(entries: readonly T[], query: string): T[] {
  const words = queryWords(query);
  const meant = meantTag(query);
  if (words.length === 0 && !meant) return [];
  const scored: Array<{ entry: T; order: number; score: number }> = [];
  entries.forEach((entry, order) => {
    const score = scoreEntry(entry, words, meant);
    if (score > 0) scored.push({ entry, order, score });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const floor = (scored[0]?.score ?? 0) >= 3 ? 2 : 1;
  return scored.filter((item) => item.score >= floor).map((item) => item.entry);
}

// ───────────────────────────────────────────────────────────────── the page's index and suggestions

/** One approved public guide as the page's search box knows it (kb.server getHelpIndex). */
export type HelpIndexEntry = HelpEntryText & {
  slug: string;
  /** The platform the guide is written for (its device's platform), or null for a guide about every device. */
  platform: string | null;
  /** Error codes the guide names, as findErrorCode writes them. */
  codes: string[];
};

/** A store policy (the content area's /policies/<slug>): its title and one line. */
export type PolicyEntry = { slug: string; title: string; summary: string };

export type HelpSuggestions = {
  /** The words carry a danger sign: the box says stop and offers a repair — and suggests nothing else. */
  danger: boolean;
  /** The error code in the words, or null. */
  code: string | null;
  /** The guides that name that code (slugs, staff order). */
  codeGuides: string[];
  /** Guides by the words (slugs, best first). */
  guides: string[];
  /** Policies by the words (slugs). */
  policies: string[];
};

/** Guides of one platform and the guides written for every device; every guide when no platform is chosen. */
export function forPlatform<T extends { platform: string | null }>(entries: readonly T[], platform: string | null | undefined): T[] {
  return platform ? entries.filter((entry) => entry.platform === null || entry.platform === platform) : [...entries];
}

/**
 * What the search box suggests while the shopper types, in the order the results page answers: a danger sign first
 * (nothing else then — stop, unplug, book a repair), then an error code with the guides that name it (possibly none,
 * said honestly), else the guides and the policies the words match. Null below MIN_SUGGEST_CHARS.
 */
export function suggestHelp(
  index: readonly HelpIndexEntry[],
  policies: readonly PolicyEntry[],
  raw: string,
  options: { platform?: string | null; guides?: number; policies?: number } = {},
): HelpSuggestions | null {
  const query = raw.trim();
  if (query.length < MIN_SUGGEST_CHARS) return null;
  const none: HelpSuggestions = { danger: false, code: null, codeGuides: [], guides: [], policies: [] };
  if (hasDangerSign(query)) return { ...none, danger: true };
  const scoped = forPlatform(index, options.platform);
  const code = findErrorCode(query);
  if (code) return { ...none, code, codeGuides: scoped.filter((entry) => entry.codes.includes(code)).map((entry) => entry.slug) };
  return {
    ...none,
    guides: rankEntries(scoped, query)
      .slice(0, options.guides ?? 5)
      .map((entry) => entry.slug),
    policies: matchPolicies(policies, query, options.policies ?? 2).map((policy) => policy.slug),
  };
}

// ───────────────────────────────────────────────────────────────── policies

/** How people ask about each policy (Arabic as written in Iraq, English, Sorani). Routing data: it only points at a policy. */
const POLICY_TERMS: Readonly<Record<string, readonly string[]>> = {
  returns: ["ارجاع", "استرجاع", "ترجيع", "استبدال", "تبديل", "استرداد", "return", "returns", "refund", "exchange", "گەڕاندنەوە", "گۆڕینەوە"],
  warranty: ["ضمان", "كفاله", "warranty", "guarantee", "گەرەنتی", "زەمانەت"],
  shipping: ["توصيل", "delivery", "shipping", "گەیاندن"],
  payment: ["دفع", "زين كاش", "ماستركارد", "payment", "pay", "zaincash", "mastercard", "پارەدان"],
  privacy: ["خصوصيه", "privacy", "cookies", "تایبەتمەندی"],
  terms: ["شروط", "terms", "مەرجەکان"],
};
const POLICY_VOCABULARY = Object.fromEntries(Object.entries(POLICY_TERMS).map(([slug, terms]) => [slug, [...new Set(terms.map(normalizeForMatch))]]));
/** Every policy's title says "policy": that word ranks none of them. */
const POLICY_NOISE = new Set(["سياسه", "سياسات", "policy", "policies", "سیاسەت", "سیاسەتی"].map(normalizeForMatch));

/**
 * The store's policies a query points at, best first (at most `limit`): a word in the title or one of the words
 * people use for it (3), a word of its line (1); a policy needs a title or vocabulary match to be listed.
 */
export function matchPolicies<T extends PolicyEntry>(policies: readonly T[], query: string, limit = 2): T[] {
  const words = queryWords(query).filter((word) => !POLICY_NOISE.has(word));
  if (words.length === 0) return [];
  const text = ` ${normalizeForMatch(query)} `;
  const scored: Array<{ policy: T; order: number; score: number }> = [];
  policies.forEach((policy, order) => {
    const title = split(policy.title);
    const summary = split(policy.summary);
    const vocabulary = POLICY_VOCABULARY[policy.slug] ?? [];
    let score = vocabulary.some((term) => term.includes(" ") && text.includes(` ${term} `)) ? 3 : 0;
    for (const word of words) {
      if (hit(title, word) || vocabulary.some((term) => !term.includes(" ") && tokenMatches(word, term))) score += 3;
      else if (hit(summary, word)) score += 1;
    }
    if (score >= 3) scored.push({ policy, order, score });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.policy);
}

// ───────────────────────────────────────────────────────────────── highlighting

export type TextPart = { text: string; hit: boolean };

/** A word of a text: letters, marks and digits, with the hyphens and apostrophes inside it ("Joy-Con", "won't"). */
const WORD = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;

/**
 * A text cut into runs, the words that match the query's words marked (`hit`) — whole words, as the ranking reads
 * them («بالشاشة» for «شاشة»). The runs joined are the text unchanged. No query words: one run.
 */
export function highlightParts(text: string, query: string): TextPart[] {
  const words = queryWords(query);
  if (!text || words.length === 0) return [{ text, hit: false }];
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(WORD)) {
    const at = match.index ?? 0;
    const tokens = normalizeForMatch(match[0]).split(" ");
    if (!tokens.some((token) => token !== "" && words.some((word) => tokenMatches(token, word)))) continue;
    if (at > last) parts.push({ text: text.slice(last, at), hit: false });
    parts.push({ text: match[0], hit: true });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts.length > 0 ? parts : [{ text, hit: false }];
}

// ───────────────────────────────────────────────────────────────── common problems

/**
 * The chips under the search box («مشكلات شائعة»): each chip's words (the "support" messages `help.common.items.<key>`,
 * in every language) lead the search to the guides of one tag — tests/support.test.ts checks that they do. The page
 * shows a chip only while an approved public guide carries its tag: a chip never leads to nothing.
 */
export const COMMON_PROBLEMS: ReadonlyArray<{ key: string; tag: string }> = [
  { key: "power", tag: "power" },
  { key: "drift", tag: "stick-drift" },
  { key: "heat", tag: "overheating" },
  { key: "screen", tag: "display" },
  { key: "controller", tag: "controller" },
  { key: "battery", tag: "battery" },
  { key: "setup", tag: "setup" },
];

/**
 * The common problems to offer (their keys, in order): those an approved public guide of the index answers — with
 * `platform` (a device chip is chosen: the chips' links carry it), those a guide of that platform or a guide about every
 * device answers, so a chip never leads to «لم نجد دليلاً».
 */
export function commonProblemsFor(index: ReadonlyArray<Pick<HelpIndexEntry, "tags"> & { platform?: string | null }>, platform?: string | null): string[] {
  const scoped = platform ? index.filter((entry) => (entry.platform ?? null) === null || entry.platform === platform) : index;
  return COMMON_PROBLEMS.filter((problem) => scoped.some((entry) => entry.tags.includes(problem.tag))).map((problem) => problem.key);
}
