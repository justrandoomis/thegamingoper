/**
 * Text matching for the command palette and the blueprint filter — Arabic and English, typed fast and loosely.
 * Pure and client-safe.
 *
 *   normalizeSearch("إستِرداد")   → "استرداد"      (diacritics and tatweel dropped, alef forms unified)
 *   normalizeSearch("Refunds")    → "refunds"
 *   matchesQuery(text, "رد مال")  → every word of the query occurs in the text
 */
const DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g;

export function normalizeSearch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim();
}

export function queryTokens(query: string): string[] {
  return normalizeSearch(query).split(" ").filter(Boolean);
}

/** True when every token occurs in the (already normalized) haystack. An empty query matches everything. */
export function matchesTokens(haystack: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => haystack.includes(token));
}

export type Searchable<G extends string> = { group: G; label: string; haystack: string };

/**
 * The rows to show for a query, group by group in `order`: the items whose haystack holds every word of the query,
 * best label match first (ties keep their original order), at most `limits[group]` per group. Groups listed in
 * `needsQuery` stay empty until something is typed (the palette shows functions only for a query).
 */
export function filterGrouped<G extends string, T extends Searchable<G>>(items: readonly T[], query: string, order: readonly G[], limits: Readonly<Record<G, number>>, needsQuery: readonly G[] = []): T[] {
  const tokens = queryTokens(query);
  const out: T[] = [];
  for (const group of order) {
    if (tokens.length === 0 && needsQuery.includes(group)) continue;
    const matching = items
      .filter((item) => item.group === group && matchesTokens(item.haystack, tokens))
      .map((item, index) => ({ item, index, rank: rankMatch(item.label, query) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, limits[group])
      .map((entry) => entry.item);
    out.push(...matching);
  }
  return out;
}

/** Lower is better: 0 the label starts with the query, 1 the label contains it, 2 only the rest of the text does. */
export function rankMatch(label: string, query: string): number {
  const normalizedLabel = normalizeSearch(label);
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return 0;
  if (normalizedLabel.startsWith(normalizedQuery)) return 0;
  if (normalizedLabel.includes(normalizedQuery)) return 1;
  return 2;
}
