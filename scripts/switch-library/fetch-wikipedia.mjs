#!/usr/bin/env node
/**
 * Switch library, step 2 of 3 — Wikipedia lead extracts (CC BY-SA 4.0) for the library's games.
 *
 *   node scripts/switch-library/fetch-wikipedia.mjs              fetch the pages the snapshot does not hold yet
 *   node scripts/switch-library/fetch-wikipedia.mjs --refresh    fetch every page again
 *   node scripts/switch-library/fetch-wikipedia.mjs --max-age=90 fetch again what was fetched more than 90 days ago
 *   node scripts/switch-library/fetch-wikipedia.mjs --limit=50   at most 50 requests this run (a trial)
 *
 * Reads catalog/switch-library/wikidata.json, takes the games build.mjs would ship (lib/select.mjs) and their
 * English, Arabic and Sorani article titles (Wikidata sitelinks), and asks the Wikimedia REST summary endpoint
 *   https://<en|ar|ckb>.wikipedia.org/api/rest_v1/page/summary/<title>
 * for each article — only those, nothing else. Writes catalog/switch-library/wikipedia.json: per "<lang>:<title>" the
 * article's title, canonical URL, plain-text lead extract (whitespace normalised; build.mjs cuts it to ≤ 900
 * characters at a sentence end) and the date it was fetched — or why it was skipped (a disambiguation page, a page
 * without an extract, a missing page). A sentence holding a word contract §1.1 keeps out of the store ends the stored
 * extract before it (lib/text.mjs) — pages kept from an earlier run included, so even `--limit=0` (no request at all)
 * brings the file in line with a guard that learned a word — and not even the committed file holds one. Pages no game
 * needs any more are dropped from the file.
 *
 * Network: one request at a time, never more than 4 per second (250 ms apart), gzip, the generic User-Agent of
 * lib/http.mjs; redirects are followed only within the same wiki. The Wikimedia API gateway grants a client that
 * does not identify itself far less — bursts of about 20, then 429 with Retry-After 10–55 s; 14–20 pages a minute
 * in practice on 2026-11-21, the same across the three wikis — so the pace is adaptive: one request every 2.5 s at
 * first, a little faster after each answer that is not a 429; on a 429 it waits as long as Retry-After says and slows
 * down again, never below one request every 2.5 s (slower would leave the budget unused). Articles are fetched for
 * the most popular games first (Wikidata sitelinks), and progress is saved every 10 pages, so a run that stops — or
 * is stopped — can simply be started again and goes on where it was. A full first pull of ~2,400 pages takes two to
 * three hours; later runs fetch only what is new.
 */
import { existsSync } from "node:fs";
import { WIKIDATA_SNAPSHOT, WIKIPEDIA_SNAPSHOT, formatSnapshot, readJson, todayUtc, writeText } from "./lib/files.mjs";
import { createClient } from "./lib/http.mjs";
import { selectLibrary } from "./lib/select.mjs";
import { withoutForbiddenSentences } from "./lib/text.mjs";

const LANGS = ["en", "ar", "ckb"];
const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"]; }));
const refresh = args.get("refresh") === "true";
const maxAgeDays = args.has("max-age") ? Number(args.get("max-age")) : null;
const limit = args.has("limit") ? Number(args.get("limit")) : Infinity;

/** One client for the three wikis: the gateway's budget is per client, not per wiki (tried side by side: no gain). */
const http = createClient({ minIntervalMs: 250, adaptive: { startMs: 2_500, ceilingMs: 2_500 }, maxAttempts: 8, timeoutMs: 30_000 });

/** A stored page with the guard of lib/text.mjs applied again; with too little text left it becomes a "no-extract" skip. */
function guarded(entry) {
  if (typeof entry?.text !== "string") return entry;
  const text = withoutForbiddenSentences(entry.text) ?? "";
  if (text === entry.text) return entry;
  return text.length < 40 ? { skip: "no-extract", asOf: entry.asOf } : { ...entry, text };
}

/** What the REST summary says about one article: a record to keep, or { skip }. */
async function fetchSummary(lang, title) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const response = await http.request(url, { headers: { Accept: "application/json; charset=utf-8" } });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return { skip: "missing" };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return { skip: `http-${response.status}` };
  }
  const page = await response.json();
  if (page?.type === "disambiguation") return { skip: "disambiguation" };
  if (page?.type !== "standard") return { skip: `type-${String(page?.type ?? "unknown")}` };
  const text = withoutForbiddenSentences(typeof page.extract === "string" ? page.extract.replace(/\s+/g, " ").trim() : "") ?? "";
  if (text.length < 40) return { skip: "no-extract" };
  const pageUrl = page?.content_urls?.desktop?.page;
  let canonical;
  try {
    canonical = new URL(pageUrl);
  } catch {
    return { skip: "no-url" };
  }
  if (canonical.protocol !== "https:" || canonical.hostname !== `${lang}.wikipedia.org` || !canonical.pathname.startsWith("/wiki/")) return { skip: "foreign-url" };
  const name = typeof page?.titles?.normalized === "string" && page.titles.normalized.trim() ? page.titles.normalized.trim() : title;
  return { title: name, url: canonical.href, text };
}

async function main() {
  const snapshot = readJson(WIKIDATA_SNAPSHOT);
  const { games } = selectLibrary(snapshot);
  const wanted = new Set();
  /** The highest popularity (sitelinks) of the games that need each article: the fetch order. */
  const weight = new Map();
  for (const game of games) {
    for (const lang of LANGS) {
      if (!game.details.wiki[lang]) continue;
      const key = `${lang}:${game.details.wiki[lang]}`;
      wanted.add(key);
      weight.set(key, Math.max(weight.get(key) ?? 0, game.popularity));
    }
  }

  const previous = existsSync(WIKIPEDIA_SNAPSHOT) ? readJson(WIKIPEDIA_SNAPSHOT).pages ?? {} : {};
  const pages = {};
  // a page kept from an earlier run gets today's guard again (lib/text.mjs may know more words than when it was fetched)
  for (const key of wanted) if (previous[key]) pages[key] = guarded(previous[key]);
  const today = todayUtc();
  const stale = (entry) => {
    if (!entry || refresh) return true;
    if (maxAgeDays === null) return false;
    const age = (Date.parse(today) - Date.parse(entry.asOf ?? "1970-01-01")) / 86_400_000;
    return age > maxAgeDays;
  };
  const todo = [...wanted].filter((key) => stale(pages[key])).sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  process.stderr.write(`Wikipedia: ${wanted.size} articles for ${games.length} games; ${todo.length} to fetch${Number.isFinite(limit) ? ` (at most ${limit} this run)` : ""}\n`);

  const save = () => {
    writeText(
      WIKIPEDIA_SNAPSHOT,
      formatSnapshot(
        {
          source: "Wikipedia (en, ar, ckb), lead extracts from the Wikimedia REST API page summaries; text under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/) — shown with the article link and the licence",
          asOf: today,
          counts: { pages: Object.keys(pages).length, extracts: Object.values(pages).filter((entry) => entry.text).length },
        },
        { pages },
      ),
    );
  };

  let done = 0;
  const started = Date.now();
  for (const key of todo.slice(0, Number.isFinite(limit) ? limit : undefined)) {
    const lang = key.slice(0, key.indexOf(":"));
    let record;
    try {
      record = await fetchSummary(lang, key.slice(lang.length + 1));
    } catch (error) {
      process.stderr.write(`  ${key}: ${error instanceof Error ? error.message : String(error)} — left for the next run\n`);
      continue;
    }
    pages[key] = { ...record, asOf: today };
    done += 1;
    if (done % 10 === 0) save();
    if (done % 50 === 0) process.stderr.write(`  ${done}/${todo.length} (${((Date.now() - started) / 1000).toFixed(0)} s; one request every ${(http.intervalMs / 1000).toFixed(2)} s)\n`);
  }
  save();
  const kept = Object.values(pages).filter((entry) => entry.text).length;
  const skipped = {};
  for (const entry of Object.values(pages)) if (entry.skip) skipped[entry.skip] = (skipped[entry.skip] ?? 0) + 1;
  process.stderr.write(`Wrote ${WIKIPEDIA_SNAPSHOT}: ${Object.keys(pages).length} pages, ${kept} extracts, skipped ${JSON.stringify(skipped)}; ${http.count} requests in ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
}

main().catch((error) => {
  process.stderr.write(`fetch-wikipedia failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
