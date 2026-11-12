/**
 * Admin 17.03 / 17.05 — on-site search: synonym sets and the searches that found nothing.
 *
 * SYNONYMS (`search_synonyms`, one row = one spelling set in one language): the storefront's search service merges
 * rows that share a spelling into one concept across ar/en/ckb ("بلايستيشن" ⇄ "playstation" ⇄ "پلەیستەیشن") and
 * expands a query with it — nothing here touches `search_index` (products are indexed by the catalogue module's
 * builder only; CONTRACTS §4 02). Every spelling is stored normalised with the index's own normalizeSearchText(), so
 * what staff type meets what shoppers type. The search keeps its vocabulary in memory for up to VOCAB_TTL_MS per
 * isolate: a change is live at once here (invalidateSearchCaches) and within that time everywhere else.
 *
 *   listSynonyms · getSynonym · saveSynonym · setSynonymActive · conceptPreview          cms.search.manage
 *
 * ZERO-RESULT SEARCHES (`search_query_stats`, anonymous daily counts the storefront writes): the queries that found
 * nothing in the last N Iraq days, whether they find something now, and SUGGESTED synonyms — spellings of the store's
 * own vocabulary (product, platform, category and device names, existing synonym sets) close to the query by edit
 * distance or by an Arabic⇄Latin consonant sketch. Suggestions are arithmetic on spellings, said as such: no AI model
 * is configured (a boundary), so meanings ("فيفا" → "EA SPORTS FC") stay a person's call.
 *
 *   zeroResultQueries(db, actor, { days, locale, page }, now) · addQueryAsSynonym · trySearch
 */
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { searchSynonyms, type SearchSynonym } from "~/server/db/schema";
import { normalizeSearchText } from "~/server/db/search.server";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { baghdadDay as storeDay, buildConcepts, editDistance, invalidateSearchCaches, matchQuery, searchProducts, VOCAB_TTL_MS } from "~/server/services/search.server";
import { DAY_MS, PAGE_SIZE, SEARCH_LOCALES, SYNONYM_LIMITS, ZERO_RESULT_DAYS, latinDigits, oneOf, pageOf, queryText, splitForms, type SearchLocale } from "./rules";
import { actorIdOf, cmsError, parseInput, zReason } from "./shared.server";

export { VOCAB_TTL_MS };

function conflictOf(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CONTENT_CHANGED") throw cmsError("content_changed", 409);
  if (info?.kind === "unique") throw cmsError("synonym_term_taken", 409, { fields: { term: "synonym_term_taken" } });
  throw error;
}

// ───────────────────────────────────────────────────────────────── synonym sets

export const SYNONYM_STATES = ["all", "active", "inactive"] as const;
export type SynonymFilters = { locale: SearchLocale | null; q: string; state: (typeof SYNONYM_STATES)[number]; page: number };

export function parseSynonymFilters(params: URLSearchParams): SynonymFilters {
  return { locale: oneOf(params.get("locale"), SEARCH_LOCALES, null), q: queryText(params.get("q")), state: oneOf(params.get("state"), SYNONYM_STATES, "all"), page: pageOf(params.get("page")) };
}

export type SynonymRow = { id: string; locale: string; term: string; synonyms: string[]; isActive: boolean; updatedAt: number; createdBy: string | null };
/** `counts`: per language among the sets the state and words filters keep (each chip's count is its list); `stored`: every set. */
export type SynonymList = { rows: SynonymRow[]; total: number; page: number; pageCount: number; counts: Record<SearchLocale | "all", number>; stored: number };

const toRow = (row: SearchSynonym): SynonymRow => ({ id: row.id, locale: row.locale, term: row.term, synonyms: Array.isArray(row.synonyms) ? row.synonyms : [], isActive: row.isActive, updatedAt: row.updatedAt, createdBy: row.createdBy });

export async function listSynonyms(db: Db, actor: Actor, filters: SynonymFilters): Promise<SynonymList> {
  assertCan(actor, "cms.search.manage");
  const all = (await db.select().from(searchSynonyms).orderBy(asc(searchSynonyms.locale), asc(searchSynonyms.term))).map(toRow);
  const needle = normalizeSearchText(filters.q);
  const matching = all.filter((row) => {
    if (filters.state === "active" && !row.isActive) return false;
    if (filters.state === "inactive" && row.isActive) return false;
    if (needle && ![row.term, ...row.synonyms].some((form) => form.includes(needle))) return false;
    return true;
  });
  const counts = { all: matching.length, ar: 0, en: 0, ckb: 0 } as Record<SearchLocale | "all", number>;
  for (const row of matching) if ((SEARCH_LOCALES as readonly string[]).includes(row.locale)) counts[row.locale as SearchLocale]++;
  const rows = matching.filter((row) => !filters.locale || row.locale === filters.locale);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: rows.length, page, pageCount, counts, stored: all.length };
}

export async function getSynonym(db: Db, actor: Actor, id: string): Promise<SynonymRow> {
  assertCan(actor, "cms.search.manage");
  const row = await db.select().from(searchSynonyms).where(eq(searchSynonyms.id, id)).get();
  if (!row) throw notFound("synonym");
  return toRow(row);
}

/** The spellings of a set, normalised as the index is, without repeats or the term itself. */
export function normalizeSet(term: string, synonymsText: string): { term: string; synonyms: string[] } {
  const normalizedTerm = normalizeSearchText(latinDigits(term));
  const forms: string[] = [];
  for (const raw of splitForms(synonymsText)) {
    const form = normalizeSearchText(latinDigits(raw));
    if (form && form !== normalizedTerm && !forms.includes(form)) forms.push(form);
  }
  return { term: normalizedTerm, synonyms: forms };
}

export type ConceptPreview = {
  /** Every spelling the search will treat as one, across languages, once this set is saved. */
  forms: string[];
  /** The other active sets it joins through a shared spelling (the merge staff should look at). */
  joins: { id: string; locale: string; term: string }[];
};

/** What saving this set would make one concept (the search merges sets that share a spelling, in any language). */
export async function conceptPreview(db: Db, actor: Actor, input: { id?: string | null; locale: string; term: string; synonyms: string[] }): Promise<ConceptPreview> {
  assertCan(actor, "cms.search.manage");
  const rows = (await db.select().from(searchSynonyms).where(eq(searchSynonyms.isActive, true))).filter((row) => row.id !== input.id);
  const mine = [input.term, ...input.synonyms];
  const all = [...rows.map((row) => ({ term: row.term, synonyms: Array.isArray(row.synonyms) ? row.synonyms : [] })), { term: input.term, synonyms: input.synonyms }];
  const { forms, concepts } = buildConcepts(all);
  const conceptId = forms.get(normalizeSearchText(input.term));
  const joined = conceptId === undefined ? mine : concepts[conceptId];
  const joins = rows.filter((row) => [row.term, ...(Array.isArray(row.synonyms) ? row.synonyms : [])].some((form) => joined.includes(normalizeSearchText(form)))).map((row) => ({ id: row.id, locale: row.locale, term: row.term }));
  return { forms: joined, joins };
}

export const SynonymInput = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  version: z.coerce.number().int().optional(),
  locale: z.enum(SEARCH_LOCALES, { error: "required" }),
  term: z.string({ error: "required" }).trim().min(1, "required").max(SYNONYM_LIMITS.form, "too_long"),
  synonyms: z.string({ error: "required" }).max(SYNONYM_LIMITS.form * SYNONYM_LIMITS.forms + 200, "too_long"),
});

/** Creates or saves a set (normalised); a stale form, a term the language already has, or an empty set is refused. */
export async function saveSynonym(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string; created: boolean; term: string; synonyms: string[]; joins: ConceptPreview["joins"] }> {
  assertCan(actor, "cms.search.manage");
  const input = parseInput(SynonymInput, raw);
  const set = normalizeSet(input.term, input.synonyms);
  if (!set.term) throw invalid({ term: "required" });
  if (splitForms(input.synonyms).some((form) => [...form].length > SYNONYM_LIMITS.form)) throw invalid({ synonyms: "too_long" });
  if (set.synonyms.length === 0) throw cmsError("synonym_empty", 400, { fields: { synonyms: splitForms(input.synonyms).length > 0 ? "synonym_same" : "synonym_empty" } });
  if (set.synonyms.length > SYNONYM_LIMITS.forms) throw cmsError("synonym_too_many", 400, { fields: { synonyms: "synonym_too_many" } });
  const preview = await conceptPreview(db, actor, { id: input.id, locale: input.locale, term: set.term, synonyms: set.synonyms });
  const by = actorIdOf(actor);
  if (!input.id) {
    const id = newId("syn");
    await runBatch(db, [
      db.insert(searchSynonyms).values({ id, locale: input.locale, term: set.term, synonyms: set.synonyms, isActive: true, createdBy: by, updatedAt: now }),
      auditStatement(db, { actor, action: "cms.synonym.create", entityType: "search_synonym", entityId: id, after: { locale: input.locale, ...set, joins: preview.joins.map((row) => row.id) }, at: now }),
    ]).catch(conflictOf);
    invalidateSearchCaches(db);
    return { id, created: true, ...set, joins: preview.joins };
  }
  const row = await db.select().from(searchSynonyms).where(eq(searchSynonyms.id, input.id)).get();
  if (!row) throw notFound("synonym");
  if (input.version === undefined || row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  await runBatch(db, [
    db.update(searchSynonyms).set({ locale: input.locale, term: set.term, synonyms: set.synonyms, updatedAt: now }).where(and(eq(searchSynonyms.id, row.id), eq(searchSynonyms.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "cms.synonym.update", entityType: "search_synonym", entityId: row.id, before: { locale: row.locale, term: row.term, synonyms: row.synonyms }, after: { locale: input.locale, ...set }, at: now }),
  ]).catch(conflictOf);
  invalidateSearchCaches(db);
  return { id: row.id, created: false, ...set, joins: preview.joins };
}

const ActiveInput = z.object({ id: z.string().trim().min(1), version: z.coerce.number().int(), active: z.boolean(), reason: zReason(true) });

/** Switches a set off (the search stops using it) or on again — never deleted, so the history stays readable. */
export async function setSynonymActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ active: boolean }> {
  assertCan(actor, "cms.search.manage");
  const input = parseInput(ActiveInput, raw);
  const row = await db.select().from(searchSynonyms).where(eq(searchSynonyms.id, input.id)).get();
  if (!row) throw notFound("synonym");
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  if (row.isActive === input.active) return { active: row.isActive };
  await runBatch(db, [
    db.update(searchSynonyms).set({ isActive: input.active, updatedAt: now }).where(and(eq(searchSynonyms.id, row.id), eq(searchSynonyms.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: input.active ? "cms.synonym.activate" : "cms.synonym.deactivate", entityType: "search_synonym", entityId: row.id, before: { active: row.isActive }, after: { active: input.active }, reason: input.reason, at: now }),
  ]).catch(conflictOf);
  invalidateSearchCaches(db);
  return { active: input.active };
}

// ───────────────────────────────────────────────────────────────── trying a query

export type TryResult = { query: string; correctedQuery: string | null; total: number; top: { id: string; name: string; slug: string }[] };

/** What the storefront search finds for a query right now (the same service; nothing is recorded). */
export async function trySearch(db: Db, actor: Actor, input: { q: string; locale: Locale }, now: number): Promise<TryResult> {
  assertCan(actor, "cms.search.manage");
  const q = input.q.trim().slice(0, 120);
  if (!q) return { query: "", correctedQuery: null, total: 0, top: [] };
  const result = await searchProducts(db, input.locale, q, { now, limit: 5 });
  return { query: result.query, correctedQuery: result.correctedQuery, total: result.total, top: result.items.slice(0, 5).map((card) => ({ id: card.id, name: card.name, slug: card.slug })) };
}

// ───────────────────────────────────────────────────────────────── zero-result searches

export type ZeroFilters = { days: (typeof ZERO_RESULT_DAYS)[number]; locale: SearchLocale | null; page: number };

export function parseZeroFilters(params: URLSearchParams): ZeroFilters {
  const days = Number(params.get("days"));
  return { days: (ZERO_RESULT_DAYS as readonly number[]).includes(days) ? (days as ZeroFilters["days"]) : 30, locale: oneOf(params.get("locale"), SEARCH_LOCALES, null), page: pageOf(params.get("page")) };
}

export type Suggestion = {
  /** The spelling to join (normalised), the words staff read, and every spelling of that concept per language. */
  target: string;
  label: string;
  source: "synonym" | "name";
  /** 0 = the same consonants in another script, 1–2 = letters apart. */
  distance: number;
  forms: Partial<Record<SearchLocale, string[]>>;
};

export type ZeroRow = { locale: string; query: string; searches: number; zeroResults: number; days: number; lastAt: number; matchesNow: number; suggestions: Suggestion[] };
export type ZeroReport = { rows: ZeroRow[]; total: number; page: number; pageCount: number; from: string; to: string; searched: number; zero: number };

export const ZERO_PAGE_SIZE = 20;

type VocabEntry = { form: string; label: string; source: "synonym" | "name"; forms: Partial<Record<SearchLocale, string[]>> };

/** The store's own spellings: synonym concepts (by language) and the names of products, platforms, categories and devices. */
async function vocabulary(db: Db): Promise<VocabEntry[]> {
  const [synonymRows, nameRows] = await Promise.all([
    db.select({ locale: searchSynonyms.locale, term: searchSynonyms.term, synonyms: searchSynonyms.synonyms }).from(searchSynonyms).where(eq(searchSynonyms.isActive, true)),
    db.all<{ name: string }>(sql`
      SELECT name FROM products WHERE status IN ('published', 'scheduled')
      UNION ALL SELECT name FROM platforms WHERE is_active = 1
      UNION ALL SELECT name FROM categories WHERE is_active = 1
      UNION ALL SELECT name FROM device_models WHERE status = 'published'`),
  ]);
  const out: VocabEntry[] = [];
  // synonym concepts, with their spellings sorted by the language of the rows they came from
  const rows = synonymRows.map((row) => ({ term: row.term, synonyms: Array.isArray(row.synonyms) ? row.synonyms : [], locale: row.locale }));
  const { concepts } = buildConcepts(rows);
  for (const concept of concepts) {
    const forms: Partial<Record<SearchLocale, string[]>> = {};
    for (const row of rows) {
      const own = [row.term, ...row.synonyms].map((form) => normalizeSearchText(form));
      if (!own.some((form) => concept.includes(form))) continue;
      const locale = (SEARCH_LOCALES as readonly string[]).includes(row.locale) ? (row.locale as SearchLocale) : "ar";
      forms[locale] = [...new Set([...(forms[locale] ?? []), ...own])];
    }
    for (const form of concept) out.push({ form, label: form, source: "synonym", forms });
  }
  // names: each language's whole name and its words (3+ letters), with the entity's names in the three languages
  for (const row of nameRows) {
    let name: L10n | null = null;
    try {
      name = JSON.parse(row.name) as L10n;
    } catch {
      continue;
    }
    const forms: Partial<Record<SearchLocale, string[]>> = {};
    for (const locale of SEARCH_LOCALES) {
      const text = normalizeSearchText(name?.[locale]);
      if (text) forms[locale] = [text];
    }
    for (const locale of SEARCH_LOCALES) {
      const text = normalizeSearchText(name?.[locale]);
      if (!text) continue;
      out.push({ form: text, label: pick(name, locale), source: "name", forms });
      for (const word of text.split(" ")) if ([...word].length >= 3 && word !== text) out.push({ form: word, label: word, source: "name", forms });
    }
  }
  return out;
}

const ARABIC_SKETCH: Record<string, string> = {
  ا: "", أ: "", إ: "", آ: "", ء: "", ع: "", ب: "b", پ: "b", ت: "t", ث: "s", ج: "j", چ: "j", ح: "h", خ: "k", د: "d", ذ: "z", ر: "r", ڕ: "r", ز: "z", ژ: "j", س: "s", ش: "s", ص: "s", ض: "d", ط: "t", ظ: "z", غ: "g", ف: "f", ڤ: "f", ق: "k", ك: "k", ک: "k", گ: "g", ل: "l", ڵ: "l", م: "m", ن: "n", ه: "h", ھ: "h", و: "", ۆ: "", ي: "", ی: "", ێ: "", ى: "",
};

/** The consonants of a word, Arabic and Latin letters mapped to one sketch ("بلايستيشن" ≈ "playstation"). */
export function consonantSketch(word: string): string {
  let out = "";
  const lower = word.toLowerCase().replace(/tion/g, "sn").replace(/ph/g, "f").replace(/sh/g, "s").replace(/ch/g, "s").replace(/th/g, "s").replace(/x/g, "ks").replace(/q/g, "k").replace(/c/g, "k").replace(/v/g, "f").replace(/p/g, "b").replace(/w/g, "").replace(/y/g, "");
  for (const ch of lower) {
    if (ch in ARABIC_SKETCH) out += ARABIC_SKETCH[ch];
    else if (/[bdfghjklmnrstz0-9]/.test(ch)) out += ch;
  }
  return out.replace(/(.)\1+/g, "$1");
}

const isArabicScript = (text: string) => /[؀-ۿ]/.test(text);

/** Up to three spellings of the store's vocabulary close to the query (never the query itself). */
export function suggestFor(query: string, vocab: readonly VocabEntry[]): Suggestion[] {
  const q = normalizeSearchText(query);
  const length = [...q].length;
  if (length < 3) return [];
  const allowed = length <= 5 ? 1 : 2;
  const sketch = consonantSketch(q);
  const scored: Suggestion[] = [];
  const seen = new Set<string>();
  for (const entry of vocab) {
    if (entry.form === q || seen.has(entry.form)) continue;
    let distance = editDistance(q, entry.form, allowed);
    if (distance > allowed && isArabicScript(q) !== isArabicScript(entry.form) && sketch.length >= 4) {
      const other = consonantSketch(entry.form);
      if (other.length >= 4 && editDistance(sketch, other, 1) <= 1) distance = 0;
    }
    if (distance > allowed) continue;
    seen.add(entry.form);
    scored.push({ target: entry.form, label: entry.label, source: entry.source, distance, forms: entry.forms });
  }
  // one suggestion per concept or name (its spellings share one `forms` object): the closest spelling of each
  const concepts = new Set<object>();
  return scored
    .sort((a, b) => a.distance - b.distance || (a.source === b.source ? 0 : a.source === "synonym" ? -1 : 1) || a.target.localeCompare(b.target))
    .filter((suggestion) => {
      if (concepts.has(suggestion.forms)) return false;
      concepts.add(suggestion.forms);
      return true;
    })
    .slice(0, 3);
}

/**
 * The queries that found nothing over the last `days` Iraq days (today included), most zero results first, with
 * whether they match something now and suggested spellings to join them to.
 */
export async function zeroResultQueries(db: Db, actor: Actor, filters: ZeroFilters, now: number): Promise<ZeroReport> {
  assertCan(actor, "cms.search.manage");
  const to = storeDay(now);
  const from = storeDay(now - (filters.days - 1) * DAY_MS);
  const where = sql`day >= ${from} AND day <= ${to} ${filters.locale ? sql`AND locale = ${filters.locale}` : sql``}`;
  const [totals, countRows] = await Promise.all([
    db.all<{ searched: number; zero: number }>(sql`SELECT COALESCE(SUM(searches), 0) AS searched, COALESCE(SUM(zero_results), 0) AS zero FROM search_query_stats WHERE ${where}`),
    db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM (SELECT 1 FROM search_query_stats WHERE ${where} GROUP BY locale, query HAVING SUM(zero_results) > 0)`),
  ]);
  const total = Number(countRows[0]?.n ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / ZERO_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<{ locale: string; query: string; searches: number; zero: number; days: number; last_at: number }>(sql`
    SELECT locale, query, SUM(searches) AS searches, SUM(zero_results) AS zero, COUNT(*) AS days, MAX(last_at) AS last_at
    FROM search_query_stats WHERE ${where}
    GROUP BY locale, query HAVING SUM(zero_results) > 0
    ORDER BY zero DESC, last_at DESC, query
    LIMIT ${ZERO_PAGE_SIZE} OFFSET ${(page - 1) * ZERO_PAGE_SIZE}`);
  const vocab = rows.length > 0 ? await vocabulary(db) : [];
  const out: ZeroRow[] = [];
  for (const row of rows) {
    const match = await matchQuery(db, row.query, now);
    out.push({
      locale: row.locale,
      query: row.query,
      searches: Number(row.searches),
      zeroResults: Number(row.zero),
      days: Number(row.days),
      lastAt: Number(row.last_at),
      matchesNow: match.ids.length,
      suggestions: match.ids.length > 0 ? [] : suggestFor(row.query, vocab),
    });
  }
  return { rows: out, total, page, pageCount, from, to, searched: Number(totals[0]?.searched ?? 0), zero: Number(totals[0]?.zero ?? 0) };
}

/** How many queries found nothing over the last `days` Iraq days — the total of zeroResultQueries for those days. */
export async function countZeroResultQueries(db: Db, now: number, days: (typeof ZERO_RESULT_DAYS)[number] = 7): Promise<number> {
  const from = storeDay(now - (days - 1) * DAY_MS);
  const to = storeDay(now);
  const rows = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM (SELECT 1 FROM search_query_stats WHERE day >= ${from} AND day <= ${to} GROUP BY locale, query HAVING SUM(zero_results) > 0)`);
  return Number(rows[0]?.n ?? 0);
}

const AddInput = z.object({
  locale: z.enum(SEARCH_LOCALES, { error: "required" }),
  query: z.string({ error: "required" }).trim().min(1, "required").max(SYNONYM_LIMITS.form, "too_long"),
  target: z.string({ error: "required" }).trim().min(1, "required").max(SYNONYM_LIMITS.form, "too_long"),
});

/**
 * Adds a searched spelling to the concept of `target` in the query's language: to the active set of that language
 * that already holds `target` (term or synonym), else a new set "target ⇄ query". Live at once here (see the header).
 */
export async function addQueryAsSynonym(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "cms.search.manage");
  const input = parseInput(AddInput, raw);
  const query = normalizeSearchText(latinDigits(input.query));
  const target = normalizeSearchText(latinDigits(input.target));
  if (!query || !target) throw invalid({ target: "required" });
  if (query === target) throw cmsError("synonym_same", 400, { fields: { target: "synonym_same" } });
  const rows = await db.select().from(searchSynonyms).where(and(eq(searchSynonyms.locale, input.locale), eq(searchSynonyms.isActive, true))).orderBy(desc(searchSynonyms.updatedAt));
  const holder = rows.find((row) => row.term === target || (Array.isArray(row.synonyms) && row.synonyms.includes(target)));
  if (holder) {
    const synonyms = Array.isArray(holder.synonyms) ? holder.synonyms : [];
    if (holder.term === query || synonyms.includes(query)) return { id: holder.id, created: false };
    if (synonyms.length >= SYNONYM_LIMITS.forms) throw cmsError("synonym_too_many", 400);
    await runBatch(db, [
      db.update(searchSynonyms).set({ synonyms: [...synonyms, query], updatedAt: now }).where(and(eq(searchSynonyms.id, holder.id), eq(searchSynonyms.updatedAt, holder.updatedAt))),
      expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: holder.id }),
      auditStatement(db, { actor, action: "cms.synonym.extend", entityType: "search_synonym", entityId: holder.id, before: { synonyms }, after: { synonyms: [...synonyms, query], from: "zero_results" }, at: now }),
    ]).catch(conflictOf);
    invalidateSearchCaches(db);
    return { id: holder.id, created: false };
  }
  const id = newId("syn");
  await runBatch(db, [
    db.insert(searchSynonyms).values({ id, locale: input.locale, term: target, synonyms: [query], isActive: true, createdBy: actorIdOf(actor), updatedAt: now }),
    auditStatement(db, { actor, action: "cms.synonym.create", entityType: "search_synonym", entityId: id, after: { locale: input.locale, term: target, synonyms: [query], from: "zero_results" }, at: now }),
  ]).catch(conflictOf);
  invalidateSearchCaches(db);
  return { id, created: true };
}

export async function countActiveSynonyms(db: Db): Promise<number> {
  const rows = await db.select({ n: count() }).from(searchSynonyms).where(eq(searchSynonyms.isActive, true));
  return Number(rows[0]?.n ?? 0);
}
