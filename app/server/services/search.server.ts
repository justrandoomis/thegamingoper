/**
 * Product search (catalog area; docs/CONTRACTS.md §3).
 *
 *   const result = await searchProducts(db, ctx.locale, "playstaion", { filters, sort, cursor, cumulative: true, now: ctx.now });
 *   result.items / total / nextCursor           Paged<ProductCardData> (plus the list's facets, as listProducts)
 *   result.correctedQuery                       "playstation" — the results are for this spelling (say so on the page)
 *   result.suggestions                          platforms / categories / device hubs the query names (category-aware)
 *   result.zeroResultHelp                       nothing found: the filter to remove, the word to drop, three picks
 *
 *   const { suggestions } = await suggestSearch(db, ctx.locale, "بليستيشن");   // the header's autocomplete
 *   await recordSearchQuery(db, { locale, q, total, now });                    // anonymous daily counts
 *
 * HOW A QUERY IS READ
 *   1. normalizeSearchText() (the index's own normaliser): lower case, Latin digits, no diacritics, unified
 *      Arabic/Kurdish letters. At most 8 words.
 *   2. SYNONYMS (`search_synonyms`, ar/en/ckb): sets that share a spelling are merged into one concept across the
 *      three languages ("بليستيشن" ⇄ "playstation" ⇄ "پلەیستەیشن"). The query's words are matched greedily, longest
 *      phrase first ("بلي ستيشن 5 برو" is one concept); each concept or plain word is a GROUP of alternatives.
 *   3. MATCH: every group must match (AND); a group matches when any alternative does — 3+ characters through the
 *      FTS5 trigram index (substrings, any script), shorter ones at the start of a word of the name or keywords.
 *      One statement per group, all in one db.batch.
 *   4. TYPOS: a plain word of 4+ letters that matches nothing is corrected — its trigrams find candidate rows, and
 *      the closest word of those rows within 1–2 edits (Damerau–Levenshtein) replaces it ("playstaion" →
 *      "playstation"). The result says which spelling it used. Only when the query as typed finds nothing.
 *   5. RANK ("relevance"): exact name first (the name IS the query › starts with it › contains it as words), then
 *      how many groups the NAME covers, then bm25 (name 10 · keywords 4 · body 1), then what can be bought now.
 *      So "xbox series x" puts the Series X before the Series S, which only shares two of the three words.
 * The matches then go through the same list pipeline as the hubs (listProducts: filters, facets, sorts, cursor).
 *
 * Synonyms and the names of platforms, categories and device models are cached per isolate for VOCAB_TTL_MS.
 * Services take `db` first and never import "cloudflare:workers".
 */
import { sql, type SQL } from "drizzle-orm";
import type { ProductCardData } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { NO_FILTERS, searchPath, type FilterGroup, type ListingFacets, type ListingFilters, type ListingSort } from "~/routes/storefront/catalog/listing-model";
import type { Db } from "~/server/db/drizzle.server";
import { searchQueryStats } from "~/server/db/schema";
import { normalizeSearchText } from "~/server/db/search.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { getNewArrivals } from "./catalog/cards.server";
import { listProducts, type ListingResult } from "./catalog/listing.server";

/** Longest query read (the header field allows the same). */
export const MAX_QUERY_LENGTH = 120;
/** Words read from a query. */
export const MAX_QUERY_WORDS = 8;
/** How long synonyms and entity names are kept in memory. */
export const VOCAB_TTL_MS = 5 * 60_000;
/** Most suggestions the autocomplete returns. */
export const MAX_SUGGESTIONS = 8;

// ───────────────────────────────────────────────────────────────── vocabulary (synonyms + names), cached

type Entity = {
  kind: "platform" | "category" | "device";
  slug: string;
  /** Normalised names in every language. */
  names: string[];
  label: L10n;
  /** Locale-less link. */
  href: string;
  order: number;
};

type Vocab = {
  /** Normalised spelling → concept id. */
  forms: Map<string, number>;
  /** Concept id → every spelling of the concept (all languages). */
  concepts: string[][];
  /** Most words in one spelling. */
  maxWords: number;
  entities: Entity[];
};

type SynonymRow = { locale: string; term: string; synonyms: string | null };
type NamedRow = { slug: string; name: string; kind?: string; sort?: number };

function parseJson<T>(text: string | null | undefined): T | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const namesOf = (value: L10n | null): string[] => [...new Set(Object.values(value ?? {}).map((text) => normalizeSearchText(String(text))).filter(Boolean))];

/** Merges synonym rows that share a spelling into concepts (union–find), across languages. */
export function buildConcepts(rows: readonly { term: string; synonyms: readonly string[] }[]): { forms: Map<string, number>; concepts: string[][]; maxWords: number } {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  const formsOfRow = rows.map((row) => [...new Set([row.term, ...row.synonyms].map((form) => normalizeSearchText(form)).filter(Boolean))]);
  formsOfRow.forEach((forms, i) => {
    for (const form of forms) {
      const seen = owner.get(form);
      if (seen === undefined) owner.set(form, i);
      else parent[find(i)] = find(seen);
    }
  });
  const conceptOfRoot = new Map<number, number>();
  const concepts: string[][] = [];
  const forms = new Map<string, number>();
  let maxWords = 1;
  formsOfRow.forEach((rowForms, i) => {
    const root = find(i);
    let id = conceptOfRoot.get(root);
    if (id === undefined) {
      id = concepts.length;
      conceptOfRoot.set(root, id);
      concepts.push([]);
    }
    for (const form of rowForms) {
      if (!forms.has(form)) {
        forms.set(form, id);
        concepts[id].push(form);
        maxWords = Math.max(maxWords, form.split(" ").length);
      }
    }
  });
  return { forms, concepts, maxWords: Math.min(maxWords, MAX_QUERY_WORDS) };
}

async function buildVocab(db: Db): Promise<Vocab> {
  const [synonymResult, platformResult, categoryResult, deviceResult] = await runBatch(db, [
    batchSql(db, sql`SELECT locale, term, synonyms FROM search_synonyms WHERE is_active = 1 ORDER BY locale, term`),
    batchSql(db, sql`SELECT slug, name, sort FROM platforms WHERE is_active = 1 ORDER BY sort, id`),
    batchSql(db, sql`SELECT slug, name, kind, sort FROM categories WHERE is_active = 1 ORDER BY sort, id`),
    batchSql(db, sql`SELECT dm.slug, dm.name, dm.sort FROM device_models AS dm JOIN platforms AS pl ON pl.id = dm.platform_id WHERE dm.status = 'published' AND pl.is_active = 1 ORDER BY pl.sort, dm.sort, dm.id`),
  ]);
  const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];
  const synonyms = rowsOf<SynonymRow>(synonymResult).map((row) => ({ term: row.term, synonyms: (parseJson<unknown[]>(row.synonyms) ?? []).filter((item): item is string => typeof item === "string") }));
  const entities: Entity[] = [
    ...rowsOf<NamedRow>(platformResult).map((row, i): Entity => ({ kind: "platform", slug: row.slug, names: namesOf(parseJson<L10n>(row.name)), label: parseJson<L10n>(row.name) ?? { ar: row.slug }, href: `/platform/${row.slug}`, order: i })),
    ...rowsOf<NamedRow>(categoryResult).map((row, i): Entity => ({
      kind: "category",
      slug: row.slug,
      names: namesOf(parseJson<L10n>(row.name)),
      label: parseJson<L10n>(row.name) ?? { ar: row.slug },
      // used devices live in the used marketplace
      href: row.kind === "used" ? "/used" : `/c/${row.slug}`,
      order: i,
    })),
    ...rowsOf<NamedRow>(deviceResult).map((row, i): Entity => ({ kind: "device", slug: row.slug, names: namesOf(parseJson<L10n>(row.name)), label: parseJson<L10n>(row.name) ?? { ar: row.slug }, href: `/device/${row.slug}`, order: i })),
  ];
  return { ...buildConcepts(synonyms), entities };
}

let vocabCache = new WeakMap<object, { at: number; vocab: Vocab }>();
const cacheKey = (db: Db): object => (db as { $client?: object }).$client ?? db;

/**
 * The vocabulary, from this isolate's memory when it is younger than VOCAB_TTL_MS. Plain data only — never a
 * promise shared between requests (see taxonomy.server.ts for why).
 */
async function vocabFor(db: Db, now: number): Promise<Vocab> {
  const key = cacheKey(db);
  const hit = vocabCache.get(key);
  if (hit && now - hit.at >= 0 && now - hit.at < VOCAB_TTL_MS) return hit.vocab;
  const vocab = await buildVocab(db);
  vocabCache.set(key, { at: now, vocab });
  return vocab;
}

/** Drop the cached vocabulary (this isolate) — for admin code that just edited synonyms or names. */
export function invalidateSearchCaches(db?: Db): void {
  if (db) vocabCache.delete(cacheKey(db));
  else vocabCache = new WeakMap();
}

// ───────────────────────────────────────────────────────────────── reading a query

/** A part of the query: one concept (all its spellings) or one plain word. */
export type QueryGroup = { text: string; alternatives: string[]; concept: boolean };

const wordsOf = (normalized: string) => normalized.split(" ").filter(Boolean).slice(0, MAX_QUERY_WORDS);

/** Splits a normalised query into groups, longest synonym phrase first. */
export function queryGroups(normalized: string, vocab: Pick<Vocab, "forms" | "concepts" | "maxWords">): QueryGroup[] {
  const words = wordsOf(normalized);
  const groups: QueryGroup[] = [];
  for (let i = 0; i < words.length; ) {
    let matched = false;
    for (let length = Math.min(vocab.maxWords, words.length - i); length >= 1; length--) {
      const phrase = words.slice(i, i + length).join(" ");
      const concept = vocab.forms.get(phrase);
      if (concept === undefined) continue;
      groups.push({ text: phrase, alternatives: [...new Set([phrase, ...vocab.concepts[concept]])], concept: true });
      i += length;
      matched = true;
      break;
    }
    if (!matched) {
      groups.push({ text: words[i], alternatives: [words[i]], concept: false });
      i += 1;
    }
  }
  return groups;
}

const chars = (text: string) => [...text].length;
const quote = (term: string) => `"${term.replaceAll('"', '""')}"`;
const likeEscape = (term: string) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const BM25 = sql`bm25(search_index, 0.0, 0.0, 10.0, 4.0, 1.0)`;

/** Rows of the search index matching any alternative of a group: (product, normalised name, bm25 or 0). */
function groupStatement(group: QueryGroup): SQL {
  const long = group.alternatives.filter((alt) => chars(alt) >= 3);
  const short = group.alternatives.filter((alt) => chars(alt) < 3);
  const parts: SQL[] = [];
  if (long.length > 0) parts.push(sql`SELECT product_id AS id, name, ${BM25} AS score FROM search_index WHERE search_index MATCH ${long.map(quote).join(" OR ")}`);
  for (const term of short) {
    parts.push(sql`SELECT product_id AS id, name, 0 AS score FROM search_index WHERE (' ' || name || ' ' || keywords || ' ') LIKE ${`% ${likeEscape(term)}%`} ESCAPE '\\'`);
  }
  return sql.join(parts, sql` UNION ALL `);
}

type GroupHits = Map<string, { score: number; names: Set<string> }>;
type HitRow = { id: string; name: string; score: number };

async function matchGroups(db: Db, groups: readonly QueryGroup[]): Promise<GroupHits[]> {
  if (groups.length === 0) return [];
  const results = await runBatch(
    db,
    groups.map((group) => batchSql(db, groupStatement(group))),
  );
  return results.map((result) => {
    const hits: GroupHits = new Map();
    for (const row of ((result as { results?: HitRow[] } | null)?.results ?? []) as HitRow[]) {
      const entry = hits.get(row.id) ?? { score: 0, names: new Set<string>() };
      entry.score = Math.min(entry.score, Number(row.score) || 0);
      entry.names.add(row.name);
      hits.set(row.id, entry);
    }
    return hits;
  });
}

// ───────────────────────────────────────────────────────────────── typo tolerance

/** Damerau–Levenshtein distance (optimal string alignment), by code point; stops early past `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > max) return max + 1;
  const rows: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array.from({ length: y.length }, () => 0)]);
  for (let j = 0; j <= y.length; j++) rows[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    let best = Number.MAX_SAFE_INTEGER;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1);
      rows[i][j] = value;
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
  }
  return rows[x.length][y.length];
}

/** Edits a word of this length may need to be corrected: 1 up to 5 letters, 2 above. */
const allowedEdits = (length: number) => (length <= 5 ? 1 : 2);

/** The distinct trigrams of a word. */
export function trigramsOf(word: string): string[] {
  const letters = [...word];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= letters.length; i++) out.add(letters.slice(i, i + 3).join(""));
  return [...out];
}

/**
 * The closest indexed word to `word` (a plain query word that matched nothing), or null. Candidates are the words of
 * the rows that share most trigrams with it; the winner has the fewest edits, then appears most often.
 */
function bestCorrection(word: string, candidateTexts: readonly string[]): string | null {
  const length = chars(word);
  const max = allowedEdits(length);
  const counts = new Map<string, number>();
  for (const text of candidateTexts) for (const candidate of text.split(" ")) if (candidate && candidate !== word && Math.abs(chars(candidate) - length) <= max) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  let best: { word: string; distance: number; count: number } | null = null;
  for (const [candidate, count] of counts) {
    const distance = editDistance(word, candidate, max);
    if (distance > max) continue;
    if (!best || distance < best.distance || (distance === best.distance && (count > best.count || (count === best.count && candidate < best.word)))) best = { word: candidate, distance, count };
  }
  return best?.word ?? null;
}

async function correctGroups(db: Db, groups: readonly QueryGroup[], hits: readonly GroupHits[], vocab: Vocab): Promise<QueryGroup[] | null> {
  const targets = groups.map((group, i) => (!group.concept && hits[i].size === 0 && chars(group.text) >= 4 && trigramsOf(group.text).length > 0 ? i : -1)).filter((i) => i >= 0);
  if (targets.length === 0) return null;
  const results = await runBatch(
    db,
    targets.map((i) =>
      batchSql(db, sql`SELECT name || ' ' || keywords AS text FROM search_index WHERE search_index MATCH ${trigramsOf(groups[i].text).map(quote).join(" OR ")} ORDER BY ${BM25} LIMIT 40`),
    ),
  );
  const next = [...groups];
  let changed = false;
  targets.forEach((groupIndex, k) => {
    const texts = (((results[k] as { results?: { text: string }[] } | null)?.results ?? []) as { text: string }[]).map((row) => row.text);
    const fixed = bestCorrection(groups[groupIndex].text, texts);
    if (!fixed) return;
    changed = true;
    const concept = vocab.forms.get(fixed);
    next[groupIndex] = concept === undefined ? { text: fixed, alternatives: [fixed], concept: false } : { text: fixed, alternatives: [...new Set([fixed, ...vocab.concepts[concept]])], concept: true };
  });
  return changed ? next : null;
}

// ───────────────────────────────────────────────────────────────── ranking

const containsWords = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `);
const containsAtWordStart = (text: string, phrase: string) => ` ${text}`.includes(` ${phrase}`);

/**
 * How many groups of the query a name covers, word by word: an alternative matches consecutive words of the name
 * (its last word may be the start of the name's word: "controller" → "controllers", "x" → "x25"), and every word of
 * the name serves one group at most — so in "xbox series s" the "x" of "xbox series x" cannot reuse "xbox".
 * Groups with longer spellings are placed first.
 */
export function nameCoverage(name: string, groups: readonly QueryGroup[]): number {
  const words = name.split(" ").filter(Boolean);
  const used = words.map(() => false);
  const order = groups
    .map((group, index) => ({ group, index, length: Math.max(...group.alternatives.map(chars)) }))
    .sort((a, b) => b.length - a.length || a.index - b.index);
  let covered = 0;
  for (const { group } of order) {
    let placed = false;
    for (const alt of group.alternatives) {
      const parts = alt.split(" ").filter(Boolean);
      for (let start = 0; !placed && start + parts.length <= words.length; start++) {
        const fits = parts.every((part, k) => !used[start + k] && (k === parts.length - 1 ? words[start + k].startsWith(part) : words[start + k] === part));
        if (fits) {
          parts.forEach((_, k) => (used[start + k] = true));
          placed = true;
        }
      }
      if (placed) break;
    }
    if (placed) covered++;
  }
  return covered;
}

/**
 * [exactness, −groups the name covers, bm25 sum] — smaller is better, compared position by position. Exactness:
 * 0 the name is the query · 1 the name starts with it (the last word may be unfinished) · 2 the name contains it from
 * a word start · 3 otherwise.
 */
function rankOf(names: ReadonlySet<string>, groups: readonly QueryGroup[], perGroup: readonly { score: number }[], phrases: readonly string[]): number[] {
  let exact = 3;
  let covered = 0;
  for (const name of names) {
    for (const phrase of phrases) {
      if (name === phrase) exact = 0;
      else if (name.startsWith(phrase)) exact = Math.min(exact, 1);
      else if (containsAtWordStart(name, phrase)) exact = Math.min(exact, 2);
    }
    covered = Math.max(covered, nameCoverage(name, groups));
  }
  const score = perGroup.reduce((sum, entry) => sum + entry.score, 0);
  return [exact, -covered, Math.round(score * 10_000) / 10_000];
}

export type QueryMatch = {
  /** The query as read (normalised). */
  query: string;
  /** Set when the query as typed found nothing and a corrected spelling did. */
  correctedQuery: string | null;
  groups: QueryGroup[];
  /** Matching product ids, best first. */
  ids: string[];
  rank: Map<string, number[]>;
  /** Nothing matched all groups: the query without one group, and how many products that finds. */
  partial: { q: string; count: number }[];
};

function intersect(hits: readonly GroupHits[]): string[] {
  if (hits.length === 0) return [];
  const [first, ...rest] = [...hits].sort((a, b) => a.size - b.size);
  return [...first.keys()].filter((id) => rest.every((map) => map.has(id)));
}

/** Matches a query against the search index (see the file header). Empty query → nothing. */
export async function matchQuery(db: Db, q: string, now: number = Date.now()): Promise<QueryMatch> {
  const query = normalizeSearchText(String(q ?? "").slice(0, MAX_QUERY_LENGTH));
  const empty: QueryMatch = { query, correctedQuery: null, groups: [], ids: [], rank: new Map(), partial: [] };
  if (!query) return empty;
  const vocab = await vocabFor(db, now);
  let groups = queryGroups(query, vocab);
  if (groups.length === 0) return empty;
  let hits = await matchGroups(db, groups);
  let ids = intersect(hits);
  let correctedQuery: string | null = null;

  if (ids.length === 0) {
    const corrected = await correctGroups(db, groups, hits, vocab);
    if (corrected) {
      const changed = corrected.map((group, i) => group !== groups[i]);
      const fresh = await matchGroups(
        db,
        corrected.filter((_, i) => changed[i]),
      );
      let k = 0;
      const nextHits = corrected.map((_, i) => (changed[i] ? fresh[k++] : hits[i]));
      const nextIds = intersect(nextHits);
      if (nextIds.length > 0) {
        groups = corrected;
        hits = nextHits;
        ids = nextIds;
        correctedQuery = corrected.map((group) => group.text).join(" ");
      }
    }
  }

  const phrases = [...new Set([query, ...(correctedQuery ? [correctedQuery] : []), ...(groups.length === 1 && groups[0].concept ? groups[0].alternatives : [])])];
  const rank = new Map<string, number[]>();
  for (const id of ids) {
    const names = new Set<string>();
    const perGroup = hits.map((map) => {
      const entry = map.get(id)!;
      for (const name of entry.names) names.add(name);
      return entry;
    });
    rank.set(id, rankOf(names, groups, perGroup, phrases));
  }
  const ordered = [...ids].sort((a, b) => {
    const x = rank.get(a)!;
    const y = rank.get(b)!;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const partial =
    ids.length === 0 && groups.length >= 2
      ? groups
          .map((_, skip) => ({ q: groups.filter((__, i) => i !== skip).map((group) => group.text).join(" "), count: intersect(hits.filter((__, i) => i !== skip)).length }))
          .filter((entry) => entry.count > 0)
          .sort((a, b) => b.count - a.count)
          .slice(0, 2)
      : [];

  return { query, correctedQuery, groups, ids: ordered, rank, partial };
}

// ───────────────────────────────────────────────────────────────── category-aware: what the query names

export type SearchJump = { kind: Entity["kind"]; slug: string; label: string; href: string };

/**
 * Platforms, categories and device hubs the query names — in any language, through its synonyms. A name matches a
 * phrase when they are equal or the phrase contains the whole name; a category also when its name contains the phrase
 * from a word start ("سماعات" → "سماعات الرأس"). At most one platform, one category and two devices; three in all.
 */
export function jumpsFor(match: Pick<QueryMatch, "query" | "correctedQuery" | "groups">, entities: readonly Entity[], locale: Locale): SearchJump[] {
  const phrases = new Set<string>([match.query, ...(match.correctedQuery ? [match.correctedQuery] : [])]);
  for (const group of match.groups) if (group.concept) for (const alt of group.alternatives) phrases.add(alt);
  const scored: { entity: Entity; score: number }[] = [];
  for (const entity of entities) {
    let score = 0;
    for (const name of entity.names) {
      for (const phrase of phrases) {
        if (name === phrase) score = Math.max(score, 3);
        else if (chars(name) >= 3 && containsWords(phrase, name)) score = Math.max(score, 2);
        else if (entity.kind === "category" && chars(phrase) >= 4 && containsAtWordStart(name, phrase)) score = Math.max(score, 1);
      }
    }
    if (score > 0) scored.push({ entity, score });
  }
  const KIND_ORDER = { platform: 0, category: 1, device: 2 } as const;
  scored.sort((a, b) => b.score - a.score || KIND_ORDER[a.entity.kind] - KIND_ORDER[b.entity.kind] || a.entity.order - b.entity.order);
  const quota = { platform: 1, category: 1, device: 2 };
  const out: SearchJump[] = [];
  for (const { entity } of scored) {
    if (quota[entity.kind] <= 0 || out.length >= 3) continue;
    quota[entity.kind] -= 1;
    out.push({ kind: entity.kind, slug: entity.slug, label: pick(entity.label, locale), href: entity.href });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── searchProducts (the contract)

export type ZeroResultHelp = {
  /** Why nothing shows: nothing matches the words, or the filters hide every match. */
  reason: "no_match" | "filters";
  /** Remove one filter: how many products that shows (most first). */
  relax: { group: FilterGroup; count: number }[];
  /** Drop one word: the shorter query and how many products it matches (before filters). */
  partial: { q: string; count: number }[];
  /** New arrivals that can be bought now — shown as such, never as "recommended". */
  picks: ProductCardData[];
};

export type SearchOptions = {
  filters?: Partial<ListingFilters>;
  /** Default "relevance". */
  sort?: ListingSort | null;
  cursor?: string | null;
  limit?: number;
  /** Everything from the first result through the page after `cursor` (see listProducts). */
  cumulative?: boolean;
  now?: number;
};

export type SearchResult = ListingResult & {
  query: string;
  correctedQuery: string | null;
  /** Category-aware: the platforms, categories and device hubs the query names. */
  suggestions: SearchJump[];
  zeroResultHelp: ZeroResultHelp | null;
};

const EMPTY_FACETS: ListingFacets = {
  categories: [],
  platforms: [],
  devices: [],
  price: null,
  priceBands: [],
  inStock: 0,
  deals: 0,
  arabic: [],
  formats: [],
  without: { platforms: 0, category: 0, device: 0, price: 0, inStock: 0, deals: 0, arabic: 0, formats: 0 },
};

/**
 * Searches the catalogue (CONTRACTS.md §3): Paged<ProductCardData> & { suggestions; zeroResultHelp }, plus the list's
 * facets and sort like listProducts. An empty query returns an empty page with no help (the page shows its start).
 */
export async function searchProducts(db: Db, locale: Locale, q: string, options: SearchOptions = {}): Promise<SearchResult> {
  const now = options.now ?? Date.now();
  const match = await matchQuery(db, q, now);
  const vocab = match.query ? await vocabFor(db, now) : null;
  const suggestions = vocab ? jumpsFor(match, vocab.entities, locale) : [];
  const filters: ListingFilters = { ...NO_FILTERS, ...options.filters };

  if (!match.query) {
    return {
      items: [],
      total: 0,
      nextCursor: null,
      sort: "relevance",
      filters,
      scopeTotal: 0,
      offset: 0,
      facets: EMPTY_FACETS,
      relax: [],
      hub: { category: null, platform: null, devices: [] },
      query: "",
      correctedQuery: null,
      suggestions: [],
      zeroResultHelp: null,
    };
  }

  const list = await listProducts(db, locale, {
    scope: { kind: "products", ids: match.ids, rank: match.rank },
    filters: options.filters,
    sort: options.sort ?? "relevance",
    cursor: options.cursor,
    limit: options.limit,
    cumulative: options.cumulative,
    now,
  });
  // a products scope always exists
  const result = list!;
  let zeroResultHelp: ZeroResultHelp | null = null;
  if (result.total === 0) {
    const picks = await getNewArrivals(db, locale, { limit: 3, now });
    zeroResultHelp = { reason: result.scopeTotal > 0 ? "filters" : "no_match", relax: result.relax, partial: match.partial, picks };
  }
  return { ...result, query: match.query, correctedQuery: match.correctedQuery, suggestions, zeroResultHelp };
}

// ───────────────────────────────────────────────────────────────── autocomplete

export type SuggestionKind = "product" | "correction" | SearchJump["kind"];
export type SearchSuggestionItem = { kind: SuggestionKind; label: string; href: string; hint?: string };

/**
 * Suggestions for the header's search field: a corrected spelling, the platforms / categories / device hubs the query
 * names, then the best-matching products (name, with its category as the hint). Hrefs are locale-less. Fewer than two
 * characters → nothing.
 */
export async function suggestSearch(db: Db, locale: Locale, q: string, options: { now?: number; limit?: number } = {}): Promise<SearchSuggestionItem[]> {
  const now = options.now ?? Date.now();
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? MAX_SUGGESTIONS)), MAX_SUGGESTIONS);
  const query = normalizeSearchText(String(q ?? "").slice(0, MAX_QUERY_LENGTH));
  if ([...query.replace(/ /g, "")].length < 2) return [];
  const match = await matchQuery(db, query, now);
  const vocab = await vocabFor(db, now);
  const out: SearchSuggestionItem[] = [];
  if (match.correctedQuery) out.push({ kind: "correction", label: match.correctedQuery, href: searchPath(match.correctedQuery) });
  for (const jump of jumpsFor(match, vocab.entities, locale)) out.push({ kind: jump.kind, label: jump.label, href: jump.href });
  const room = limit - out.length;
  if (room > 0 && match.ids.length > 0) {
    const top = match.ids.slice(0, room + 4);
    const rows = await db.all<{ id: string; slug: string; name: string; category: string | null }>(sql`
      SELECT p.id, p.slug, p.name, c.name AS category
      FROM products AS p LEFT JOIN categories AS c ON c.id = p.category_id AND c.is_active = 1
      WHERE p.status = 'published' AND p.id IN (SELECT value FROM json_each(${JSON.stringify(top)}))`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of top) {
      const row = byId.get(id);
      if (!row || out.length >= limit) continue;
      const hint = pick(parseJson<L10n>(row.category), locale);
      out.push({ kind: "product", label: pick(parseJson<L10n>(row.name), locale) || row.slug, href: `/p/${row.slug}`, ...(hint ? { hint } : {}) });
    }
  }
  return out.slice(0, limit);
}

// ───────────────────────────────────────────────────────────────── anonymous query statistics

const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
/** The Asia/Baghdad calendar day of an instant (UTC+3, no daylight saving). */
export const baghdadDay = (at: number) => new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

/** Longest normalised query that is counted. */
export const MAX_COUNTED_QUERY = 64;

/**
 * Should this query be counted at all? Not when it could carry personal data — an e-mail address, a phone or order
 * number (seven digits or more) — and not when it is too long to be a real product search.
 */
export function isCountableQuery(q: string): boolean {
  const raw = String(q ?? "");
  if (raw.includes("@")) return false;
  const query = normalizeSearchText(raw);
  // "0770 123 4567", "TT-7K4M2Q9X"-style references with long digit runs, card or account numbers
  if (/\d{7,}/.test(query.replace(/ /g, ""))) return false;
  return query.length > 0 && query.length <= MAX_COUNTED_QUERY;
}

/**
 * Distinct queries counted per day and language (security review, second pass). The statistics are written by
 * anonymous GETs — and any page on the web can make its visitors' browsers request `/search?q=…` — so without a cap
 * every new string was a new row, for good. Once a day holds this many queries, only those already counted that day
 * keep counting; a real store sees a few hundred distinct searches a day.
 */
export const MAX_COUNTED_QUERIES_PER_DAY = 2_000;

/**
 * Counts one search in `search_query_stats` (day in Baghdad, locale, normalised query → searches, zero_results,
 * last_at). Anonymous by construction: no IP, account, session or cart is stored, and queries that may hold
 * personal data are not counted (isCountableQuery). A new query is counted only while its day and language hold fewer
 * than MAX_COUNTED_QUERIES_PER_DAY queries — decided in the same statement. Returns whether it was counted.
 */
export async function recordSearchQuery(db: Db, input: { locale: Locale; q: string; total: number; now: number }): Promise<boolean> {
  if (!isCountableQuery(input.q)) return false;
  const query = normalizeSearchText(input.q);
  const zero = input.total === 0 ? 1 : 0;
  const day = baghdadDay(input.now);
  // One statement (never inside a batch: drizzle's db.run(sql) must not be batched — drizzle/README.md).
  const result = await db.run(sql`
INSERT INTO ${searchQueryStats} (day, locale, query, searches, zero_results, last_at)
SELECT ${day}, ${input.locale}, ${query}, 1, ${zero}, ${input.now}
WHERE (SELECT count(*) FROM ${searchQueryStats} WHERE day = ${day} AND locale = ${input.locale}) < ${MAX_COUNTED_QUERIES_PER_DAY}
   OR EXISTS (SELECT 1 FROM ${searchQueryStats} WHERE day = ${day} AND locale = ${input.locale} AND query = ${query})
ON CONFLICT (day, locale, query) DO UPDATE SET searches = searches + 1, zero_results = zero_results + excluded.zero_results, last_at = excluded.last_at`);
  return result.meta.changes > 0;
}
