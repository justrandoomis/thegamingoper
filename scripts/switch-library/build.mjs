#!/usr/bin/env node
/**
 * Switch library, step 3 of 3 — the static files the Switch bundle builder loads (docs/switch-builder.md §4.1).
 *
 *   node scripts/switch-library/build.mjs           write the files below and print counts and budgets
 *   node scripts/switch-library/build.mjs --check   build in memory and compare with the files on disk (exit 1 when stale)
 *
 * Reads the committed snapshots catalog/switch-library/wikidata.json (fetch-wikidata.mjs) and wikipedia.json
 * (fetch-wikipedia.mjs) — never the network — and writes:
 *   public/library/switch/list.<h8>.json        LibraryList: every game (LibraryGame), the chunk file names, sources
 *   public/library/switch/d/<n>.<h8>.json       LibraryChunk n of CHUNKS: GameDetails of the games whose stable hash of
 *                                               id falls in it (developers, series, OpenCritic id, Wikipedia extracts)
 *   app/routes/storefront/builder/library.manifest.ts   the current list file's URL, the snapshot date, the count
 *   catalog/switch-library/selection-log.json   every slug left out (or kept despite a doubt) and why
 * <h8> = the first 8 hex digits of the sha256 of the file's content, so /library/* is served immutable
 * (public/_headers) and a rebuild that changes nothing rewrites nothing. Hashed files that are no longer current are
 * deleted. Output is deterministic: games and details sorted by id, fixed key order, no timestamps but the
 * snapshot's own dates.
 *
 * Budgets (brotli, node:zlib defaults): the list ≤ 350 KB, each chunk ≤ 60 KB. A build over budget fails.
 * Extracts are cut to ≤ 900 characters at a sentence end; a sentence holding a word §1.1 of the contract keeps out of
 * the store ends the extract before it.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { CHUNK_DIR, MANIFEST, PUBLIC_DIR, ROOT, SELECTION_LOG, WIKIDATA_SNAPSHOT, WIKIPEDIA_SNAPSHOT, hash8, readJson, stableU32, writeText } from "./lib/files.mjs";
import { selectLibrary } from "./lib/select.mjs";
import { cutAtSentence, hasForbiddenWord, withoutForbiddenSentences } from "./lib/text.mjs";

export const CHUNKS = 64;
export const LIST_BUDGET = 350 * 1024;
export const CHUNK_BUDGET = 60 * 1024;
export const LIST_URL_BASE = "/library/switch/";
export const CHUNK_URL_BASE = "/library/switch/d/";
const SOURCES = {
  wikidata: "Wikidata — CC0 1.0 — https://www.wikidata.org/wiki/Wikidata:Licensing",
  wikipedia: "Wikipedia — CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/",
};
const LIST_PATTERN = /^list\.[0-9a-f]{8}\.json$/;
const CHUNK_PATTERN = /^\d+\.[0-9a-f]{8}\.json$/;

export const chunkOf = (id) => stableU32(id) % CHUNKS;
/** Brotli size as tests/switch-library-data.test.ts measures it (node:zlib defaults: quality 11); `quality` for the report. */
const brotli = (text, quality = zlib.BROTLI_DEFAULT_QUALITY) => brotliCompressSync(Buffer.from(text, "utf8"), { params: { [zlib.BROTLI_PARAM_QUALITY]: quality } }).length;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** Everything the build writes, in memory: { files: Map<absolute path, text>, report }. */
export function buildLibrary() {
  const wikidata = readJson(WIKIDATA_SNAPSHOT);
  const wikipedia = existsSync(WIKIPEDIA_SNAPSHOT) ? readJson(WIKIPEDIA_SNAPSHOT).pages ?? {} : {};
  const { games, log, unmapped } = selectLibrary(wikidata);
  const notes = [];

  const list = [];
  const chunks = Array.from({ length: CHUNKS }, () => ({}));
  for (const game of games) {
    const chunk = chunkOf(game.id);
    // the log names the field, never its text: the committed log must not hold the word either (contract §1.1)
    const aliases = (game.aliases ?? []).filter((alias, index) => {
      if (!hasForbiddenWord(alias)) return true;
      notes.push({ slug: game.id, qid: game.qid, reason: "alias-left-out", detail: `alias ${index + 1} holds a word the store never prints` });
      return false;
    });
    if (hasForbiddenWord(game.title)) notes.push({ slug: game.id, qid: game.qid, reason: "title-word", detail: "the title holds a word the store never prints" });
    list.push({
      id: game.id,
      qid: game.qid,
      title: game.title,
      ...(game.titleAr ? { titleAr: game.titleAr } : {}),
      ...(game.titleCkb ? { titleCkb: game.titleCkb } : {}),
      ...(game.year ? { year: game.year } : {}),
      ...(game.released ? { released: game.released } : {}),
      publishers: game.publishers,
      genres: game.genres,
      modes: game.modes,
      popularity: game.popularity,
      chunk,
      ...(game.metacriticSlug ? { metacriticSlug: game.metacriticSlug } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
    });

    const extracts = {};
    for (const lang of ["en", "ar", "ckb"]) {
      const title = game.details.wiki[lang];
      const page = title ? wikipedia[`${lang}:${title}`] : undefined;
      if (!page?.text) continue;
      const cut = cutAtSentence(page.text);
      const text = withoutForbiddenSentences(cut);
      if (text !== cut) notes.push({ slug: game.id, qid: game.qid, reason: text ? "extract-shortened" : "extract-left-out", detail: `${lang}: a sentence holds a word the store never prints` });
      if (!text) continue;
      extracts[lang] = { text, title: page.title, url: page.url, asOf: page.asOf };
    }
    chunks[chunk][game.id] = {
      id: game.id,
      developers: game.details.developers,
      ...(game.details.series.length > 0 ? { series: game.details.series } : {}),
      ...(game.details.opencriticId ? { opencriticId: game.details.opencriticId } : {}),
      ...(Object.keys(extracts).length > 0 ? { wikipedia: extracts } : {}),
    };
  }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const files = new Map();
  const chunkNames = [];
  const chunkSizes = [];
  for (const [index, details] of chunks.entries()) {
    const sorted = {};
    for (const id of Object.keys(details).sort()) sorted[id] = details[id];
    const text = JSON.stringify({ version: 1, details: sorted });
    const name = `${index}.${hash8(text)}.json`;
    chunkNames.push(name);
    chunkSizes.push({ name, games: Object.keys(sorted).length, raw: Buffer.byteLength(text), brotli: brotli(text) });
    files.set(path.join(CHUNK_DIR, name), text);
  }
  const listText = JSON.stringify({ version: 1, asOf: wikidata.asOf, sources: SOURCES, chunks: chunkNames, games: list });
  const listName = `list.${hash8(listText)}.json`;
  files.set(path.join(PUBLIC_DIR, listName), listText);

  const manifest = `/**
 * GENERATED by scripts/switch-library/build.mjs — do not edit by hand.
 * The open game library (docs/switch-builder.md §4.1): content-hashed static files under public/library/switch/, served
 * immutable. Fetch LIBRARY_LIST_FILE for the LibraryList; a game's GameDetails are in the chunk
 * LIBRARY_CHUNK_PATH + list.chunks[game.chunk]. Never import the JSON through TypeScript or Vite.
 */
/** URL path of the current list file (LibraryList); null until the first build. */
export const LIBRARY_LIST_FILE: string | null = ${JSON.stringify(LIST_URL_BASE + listName)};
/** URL path that the chunk file names in LibraryList.chunks are relative to. */
export const LIBRARY_CHUNK_PATH: string = ${JSON.stringify(CHUNK_URL_BASE)};
/** ISO date of the Wikidata snapshot the list was built from. */
export const LIBRARY_AS_OF: string | null = ${JSON.stringify(wikidata.asOf)};
export const LIBRARY_GAME_COUNT: number = ${list.length};
`;
  files.set(MANIFEST, manifest);

  const entries = [...log, ...notes];
  const reasons = {};
  for (const entry of entries) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
  const logText = `{\n  "asOf": ${JSON.stringify(wikidata.asOf)},\n  "games": ${list.length},\n  "reasons": ${JSON.stringify(Object.fromEntries(Object.entries(reasons).sort()))},\n  "entries": [\n${entries.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ]\n}\n`;
  files.set(SELECTION_LOG, logText);

  const count = (test) => list.filter(test).length;
  const withExtract = (lang) => list.filter((game) => chunks[game.chunk][game.id].wikipedia?.[lang]).length;
  const byGenre = {};
  for (const game of list) for (const key of game.genres.length > 0 ? game.genres : ["(none)"]) byGenre[key] = (byGenre[key] ?? 0) + 1;
  const byMode = {};
  for (const game of list) for (const key of game.modes.length > 0 ? game.modes : ["(none)"]) byMode[key] = (byMode[key] ?? 0) + 1;
  const largest = [...chunkSizes].sort((a, b) => b.brotli - a.brotli)[0];
  const report = {
    games: list.length,
    items: new Set(list.map((game) => game.qid)).size,
    withArabicTitle: count((game) => game.titleAr),
    withSoraniTitle: count((game) => game.titleCkb),
    withYear: count((game) => game.year),
    withReleaseDay: count((game) => game.released),
    withMetacriticSlug: count((game) => game.metacriticSlug),
    withAliases: count((game) => game.aliases),
    withGenre: count((game) => game.genres.length > 0),
    withMode: count((game) => game.modes.length > 0),
    withExtract: { en: withExtract("en"), ar: withExtract("ar"), ckb: withExtract("ckb"), any: list.filter((game) => chunks[game.chunk][game.id].wikipedia).length },
    byGenre: Object.fromEntries(Object.entries(byGenre).sort((a, b) => b[1] - a[1])),
    byMode,
    logReasons: reasons,
    unmapped,
    list: { name: listName, raw: Buffer.byteLength(listText), gzip: gzipSync(listText, { level: 9 }).length, brotli: brotli(listText), brotliQ5: brotli(listText, 5) },
    chunks: { count: CHUNKS, largest, totalRaw: chunkSizes.reduce((sum, entry) => sum + entry.raw, 0), totalBrotli: chunkSizes.reduce((sum, entry) => sum + entry.brotli, 0), minGames: Math.min(...chunkSizes.map((entry) => entry.games)), maxGames: Math.max(...chunkSizes.map((entry) => entry.games)) },
  };
  const problems = [];
  if (report.list.brotli > LIST_BUDGET) problems.push(`list ${kb(report.list.brotli)} brotli > ${kb(LIST_BUDGET)}`);
  for (const entry of chunkSizes) if (entry.brotli > CHUNK_BUDGET) problems.push(`chunk ${entry.name} ${kb(entry.brotli)} brotli > ${kb(CHUNK_BUDGET)}`);
  return { files, report, problems };
}

/** Hashed library files on disk that the new build no longer has. */
function staleFiles(files) {
  const stale = [];
  for (const [dir, pattern] of [[PUBLIC_DIR, LIST_PATTERN], [CHUNK_DIR, CHUNK_PATTERN]]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (pattern.test(name) && !files.has(path.join(dir, name))) stale.push(path.join(dir, name));
  }
  return stale;
}

function main() {
  const check = process.argv.includes("--check");
  const { files, report, problems } = buildLibrary();
  const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
  if (check) {
    const differ = [...files].filter(([file, text]) => !existsSync(file) || readFileSync(file, "utf8") !== text).map(([file]) => rel(file));
    const stale = staleFiles(files).map(rel);
    if (differ.length > 0 || stale.length > 0 || problems.length > 0) {
      for (const file of differ) process.stderr.write(`out of date: ${file}\n`);
      for (const file of stale) process.stderr.write(`stale: ${file}\n`);
      for (const problem of problems) process.stderr.write(`over budget: ${problem}\n`);
      process.stderr.write("Run: node scripts/switch-library/build.mjs\n");
      process.exit(1);
    }
    process.stdout.write(`Switch library up to date: ${report.games} games, ${report.list.name}\n`);
    return;
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`over budget: ${problem}\n`);
    process.exit(1);
  }
  let written = 0;
  for (const [file, text] of files) {
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    writeText(file, text);
    written += 1;
  }
  const stale = staleFiles(files);
  for (const file of stale) rmSync(file);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Wrote ${written} file(s), deleted ${stale.length} stale file(s). List ${report.list.name}: ${kb(report.list.raw)} raw, ${kb(report.list.gzip)} gzip, ${kb(report.list.brotli)} brotli (q5 ${kb(report.list.brotliQ5)}); largest chunk ${report.chunks.largest.name}: ${kb(report.chunks.largest.brotli)} brotli.\n`);
}

// run as a script (not when imported); Windows paths compare without case ("d:\…" and "D:\…" are one file)
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
const self = fileURLToPath(import.meta.url);
if (process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) main();
