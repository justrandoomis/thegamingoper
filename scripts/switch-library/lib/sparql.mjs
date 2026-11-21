/**
 * The Wikidata Query Service (CC0): https://query.wikidata.org/sparql — POSTed queries, JSON results.
 * Queries run one at a time, at least 3 s apart (lib/http.mjs).
 */
import { createClient } from "./http.mjs";

export const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const ENTITY = "http://www.wikidata.org/entity/";

export function createSparqlClient(options = {}) {
  const http = createClient({ minIntervalMs: 3_000, timeoutMs: 120_000, ...options });
  /**
   * Runs one query; resolves with its rows, each variable as { type, value, lang? } (bnode = Wikidata's
   * "unknown value").
   */
  async function select(query, label = "query") {
    const started = Date.now();
    const response = await http.request(SPARQL_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({ query }).toString(),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 600)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${label}: the answer is not JSON (${text.slice(0, 200)})`);
    }
    const rows = json?.results?.bindings;
    if (!Array.isArray(rows)) throw new Error(`${label}: no results.bindings in the answer`);
    process.stderr.write(`  ${label}: ${rows.length} rows, ${(text.length / 1024).toFixed(0)} KB, ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
    return rows.map((row) => {
      const out = {};
      for (const [name, cell] of Object.entries(row)) out[name] = { type: cell.type, value: cell.value, ...(cell["xml:lang"] ? { lang: cell["xml:lang"] } : {}) };
      return out;
    });
  }
  return { select, get requests() { return http.count; } };
}

/** "http://www.wikidata.org/entity/Q123" → "Q123"; anything else (a blank node, a literal) → null. */
export function qidOf(cell) {
  if (!cell || cell.type !== "uri" || !cell.value.startsWith(ENTITY)) return null;
  const id = cell.value.slice(ENTITY.length);
  return /^Q\d+$/.test(id) ? id : null;
}

/** Plain value of a literal cell, or null. */
export function literalOf(cell) {
  return cell && cell.type === "literal" ? cell.value : null;
}
