#!/usr/bin/env node
/**
 * Switch library, step 1 of 3 — pull the open game list from Wikidata (CC0) into a committed, normalised snapshot.
 *
 *   node scripts/switch-library/fetch-wikidata.mjs            → catalog/switch-library/wikidata.json
 *
 * What it asks (docs/switch-builder.md §4.1): every item that carries a Nintendo eShop ID (P8084) ending in
 * "-switch" (a Nintendo US store product for Switch 1), with what the builder shows: labels (en, mul, ar, ckb),
 * aliases (en, mul, ar), types (P31), publication dates (P577 with their precision and whether a statement is
 * qualified with platform = Nintendo Switch), whether the item lists Nintendo Switch (Q19610114) as a platform
 * (P400), publishers (P123), developers (P178), series (P179), genres (P136), game modes (P404), the Metacritic game
 * slug (P12054) and OpenCritic id (P2864) for plain outbound links, the number of Wikipedia sitelinks (the "popular"
 * sort), the en/ar/ckb Wikipedia article titles, the labels of the publishers/developers/series, and the
 * "subclass of" (P279) chain of every genre, type and mode (build.mjs maps them through it).
 *
 * The snapshot keeps facts, not decisions: which items become library games is decided by build.mjs
 * (lib/select.mjs), so a rule can change without a new pull. Deprecated statements are left out.
 *
 * Network: https://query.wikidata.org/sparql only — one query for the slugs, then the items' facts in chunks of
 * ITEMS_PER_QUERY ids (subject look-ups stay far below the service's time limit), one at a time, at least 3 s
 * apart, gzip, the generic User-Agent of lib/http.mjs; it waits and retries on 429 / 5xx. A few minutes in all.
 */
import { WIKIDATA_SNAPSHOT, compareKeys, formatSnapshot, todayUtc, writeText } from "./lib/files.mjs";
import { createSparqlClient, literalOf, qidOf } from "./lib/sparql.mjs";
import { hasForbiddenWord } from "./lib/text.mjs";

const SWITCH = "Q19610114";
const RANK = "http://wikiba.se/ontology#";
const PROP = "http://www.wikidata.org/prop/";
const LABEL_LANGS = ["en", "mul", "ar", "ckb"];
const ALIAS_LANGS = ["en", "mul", "ar"];
const WIKIS = { "https://en.wikipedia.org/": "en", "https://ar.wikipedia.org/": "ar", "https://ckb.wikipedia.org/": "ckb" };
const RELATIONS = { P31: "types", P123: "publishers", P178: "developers", P179: "series", P136: "genres", P404: "modes" };
const CLASS_DEPTH = 8;
const ITEMS_PER_QUERY = 1_000;
const VALUES_PER_QUERY = 1_500;

const sparql = createSparqlClient();
const items = new Map();
const rankOf = (cell) => (cell?.value ?? "").replace(RANK, "").replace(/Rank$/, "").toLowerCase();
const clean = (text) => text.replace(/\s+/g, " ").trim();
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size));
const valuesOf = (qids) => qids.map((qid) => `wd:${qid}`).join(" ");
const langList = (langs) => langs.map((lang) => `"${lang}"`).join(", ");
const sortStrings = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const sortIds = (values) => [...values].sort(compareKeys);

/** Runs `build(valuesClause)` for every chunk of `ids` and hands each row to `onRow`. */
async function perChunk(ids, size, label, build, onRow) {
  const parts = chunks(ids, size);
  for (const [index, part] of parts.entries()) {
    const rows = await sparql.select(build(valuesOf(part)), parts.length > 1 ? `${label} ${index + 1}/${parts.length}` : label);
    for (const row of rows) onRow(row);
  }
}

async function main() {
  const started = Date.now();
  process.stderr.write("Wikidata: items with a Nintendo US store slug for Switch 1\n");

  // 1. the store slugs: every non-deprecated P8084 value ending in -switch (optionally with a trailing slash), as written
  let deprecated = 0;
  for (const row of await sparql.select(`SELECT ?g ?v ?r WHERE { ?g p:P8084 ?st . ?st ps:P8084 ?v ; wikibase:rank ?r . FILTER(REGEX(STR(?v), "-switch/?$")) }`, "slugs")) {
    const qid = qidOf(row.g);
    const value = literalOf(row.v);
    if (!qid || !value) continue;
    if (rankOf(row.r) === "deprecated") {
      deprecated += 1;
      continue;
    }
    let entry = items.get(qid);
    if (!entry) {
      entry = { slugs: new Set(), platform: false, labels: {}, aliases: {}, types: new Set(), dates: new Map(), publishers: new Set(), developers: new Set(), series: new Set(), genres: new Set(), modes: new Set(), metacritic: [], opencritic: [], sitelinks: 0, wiki: {} };
      items.set(qid, entry);
    }
    entry.slugs.add(value);
  }
  process.stderr.write(`  ${items.size} items; ${deprecated} deprecated slug statements left out\n`);
  const ids = sortIds(items.keys());

  // 2. labels and aliases
  await perChunk(
    ids,
    ITEMS_PER_QUERY,
    "labels",
    (values) => `SELECT ?g ?k ?l WHERE { VALUES ?g { ${values} } VALUES ?k { rdfs:label skos:altLabel } ?g ?k ?l . FILTER(LANG(?l) IN (${langList(LABEL_LANGS)})) }`,
    (row) => {
      const entry = items.get(qidOf(row.g) ?? "");
      const lang = row.l?.lang;
      if (!entry || !lang) return;
      if (row.k?.value?.endsWith("#label")) entry.labels[lang] = clean(row.l.value);
      // an alias holding a word contract §1.1 keeps out of the store is not even kept in the committed snapshot (labels
      // are titles: they stay facts, and the build and its test decide about them)
      else if (ALIAS_LANGS.includes(lang) && !hasForbiddenWord(row.l.value)) (entry.aliases[lang] ??= new Set()).add(clean(row.l.value));
    },
  );

  // 3. types, publishers, developers, series, genres, modes (truthy values)
  await perChunk(
    ids,
    ITEMS_PER_QUERY,
    "relations",
    (values) => `SELECT ?g ?p ?v WHERE { VALUES ?g { ${values} } VALUES ?p { ${Object.keys(RELATIONS).map((p) => `wdt:${p}`).join(" ")} } ?g ?p ?v . FILTER(isIRI(?v)) }`,
    (row) => {
      const entry = items.get(qidOf(row.g) ?? "");
      const value = qidOf(row.v);
      const field = RELATIONS[row.p?.value?.split("/").pop() ?? ""];
      if (entry && value && field) entry[field].add(value);
    },
  );

  // 4. publication dates: value, precision, and whether the statement is qualified with platform = Nintendo Switch
  await perChunk(
    ids,
    ITEMS_PER_QUERY,
    "dates",
    (values) =>
      `SELECT ?g ?st ?t ?p ?q WHERE { VALUES ?g { ${values} } ?g p:P577 ?st . ?st psv:P577 ?val ; wikibase:rank ?r . FILTER(?r != wikibase:DeprecatedRank) ?val wikibase:timeValue ?t ; wikibase:timePrecision ?p . OPTIONAL { ?st pq:P400 ?q . FILTER(?q = wd:${SWITCH}) } }`,
    (row) => {
      const entry = items.get(qidOf(row.g) ?? "");
      const time = literalOf(row.t);
      const precision = Number(literalOf(row.p));
      const match = time ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(time) : null;
      if (!entry || !match || !Number.isInteger(precision)) return;
      const key = row.st?.value ?? time;
      const date = entry.dates.get(key) ?? { t: `${match[1]}-${match[2]}-${match[3]}`, p: precision };
      if (qidOf(row.q)) date.s = 1;
      entry.dates.set(key, date);
    },
  );

  // 5. statements with ranks: platform = Nintendo Switch, the Metacritic game slug and the OpenCritic id
  await perChunk(
    ids,
    ITEMS_PER_QUERY,
    "statements",
    (values) =>
      `SELECT ?g ?pp ?v ?r WHERE { VALUES ?g { ${values} } VALUES (?pp ?ps) { (p:P400 ps:P400) (p:P12054 ps:P12054) (p:P2864 ps:P2864) } ?g ?pp ?st . ?st ?ps ?v ; wikibase:rank ?r . FILTER(?pp != p:P400 || ?v = wd:${SWITCH}) }`,
    (row) => {
      const entry = items.get(qidOf(row.g) ?? "");
      const rank = rankOf(row.r);
      const property = (row.pp?.value ?? "").replace(PROP, "");
      if (!entry || rank === "deprecated") return;
      if (property === "P400") entry.platform = true;
      else if (property === "P12054" && literalOf(row.v)) entry.metacritic.push({ v: clean(literalOf(row.v)), r: rank });
      else if (property === "P2864" && literalOf(row.v)) entry.opencritic.push({ v: clean(literalOf(row.v)), r: rank });
    },
  );

  // 6. sitelinks: how many (the "popular" sort), and the en / ar / ckb Wikipedia titles
  await perChunk(
    ids,
    ITEMS_PER_QUERY,
    "sitelinks",
    (values) =>
      `SELECT ?g ?n ?site ?title WHERE { VALUES ?g { ${values} } ?g wikibase:sitelinks ?n . OPTIONAL { ?a schema:about ?g ; schema:isPartOf ?site ; schema:name ?title . VALUES ?site { ${Object.keys(WIKIS).map((site) => `<${site}>`).join(" ")} } } }`,
    (row) => {
      const entry = items.get(qidOf(row.g) ?? "");
      if (!entry) return;
      const count = Number(literalOf(row.n));
      if (Number.isInteger(count)) entry.sitelinks = count;
      const lang = WIKIS[row.site?.value ?? ""];
      const title = literalOf(row.title);
      if (lang && title) entry.wiki[lang] = title;
    },
  );

  // 7. labels of the publishers, developers and series
  const entityIds = new Set();
  for (const entry of items.values()) for (const field of ["publishers", "developers", "series"]) for (const id of entry[field]) entityIds.add(id);
  const entities = new Map();
  await perChunk(
    sortIds(entityIds),
    VALUES_PER_QUERY,
    "entity labels",
    (values) => `SELECT ?v ?l WHERE { VALUES ?v { ${values} } ?v rdfs:label ?l . FILTER(LANG(?l) IN (${langList(LABEL_LANGS)})) }`,
    (row) => {
      const id = qidOf(row.v);
      if (!id || !row.l?.lang) return;
      const labels = entities.get(id) ?? {};
      labels[row.l.lang] = clean(row.l.value);
      entities.set(id, labels);
    },
  );

  // 8. the P279 chain of every type, genre and mode (breadth first, CLASS_DEPTH levels), labels for the direct values
  const direct = new Set();
  for (const entry of items.values()) for (const field of ["types", "genres", "modes"]) for (const id of entry[field]) direct.add(id);
  const classes = new Map([...direct].map((id) => [id, { parents: new Set() }]));
  let frontier = sortIds(direct);
  for (let depth = 1; depth <= CLASS_DEPTH && frontier.length > 0; depth++) {
    const next = new Set();
    await perChunk(frontier, VALUES_PER_QUERY, `subclass-of, level ${depth}`, (values) => `SELECT ?x ?y WHERE { VALUES ?x { ${values} } ?x wdt:P279 ?y . }`, (row) => {
      const child = qidOf(row.x);
      const parent = qidOf(row.y);
      if (!child || !parent) return;
      classes.get(child)?.parents.add(parent);
      if (!classes.has(parent)) {
        classes.set(parent, { parents: new Set() });
        next.add(parent);
      }
    });
    frontier = sortIds(next);
  }
  await perChunk(sortIds(direct), VALUES_PER_QUERY, "class labels", (values) => `SELECT ?x ?l WHERE { VALUES ?x { ${values} } ?x rdfs:label ?l . FILTER(LANG(?l) IN ("en", "mul")) }`, (row) => {
    const entry = classes.get(qidOf(row.x) ?? "");
    if (!entry || !row.l?.lang) return;
    if (row.l.lang === "en" || !entry.label) entry.label = clean(row.l.value);
  });

  // normalise: sorted sets, dates by time
  const byValue = (a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : a.r < b.r ? -1 : a.r > b.r ? 1 : 0);
  const outItems = {};
  for (const [qid, entry] of items) {
    const labels = {};
    for (const lang of LABEL_LANGS) if (entry.labels[lang]) labels[lang] = entry.labels[lang];
    const aliases = {};
    for (const lang of ALIAS_LANGS) if (entry.aliases[lang]?.size) aliases[lang] = sortStrings(entry.aliases[lang]);
    const wiki = {};
    for (const lang of ["en", "ar", "ckb"]) if (entry.wiki[lang]) wiki[lang] = entry.wiki[lang];
    const dates = [...entry.dates.values()].map((date) => ({ t: date.t, p: date.p, ...(date.s ? { s: 1 } : {}) }));
    dates.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.p - b.p || (a.s ?? 0) - (b.s ?? 0)));
    outItems[qid] = {
      slugs: sortStrings(entry.slugs),
      platform: entry.platform,
      labels,
      ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
      types: sortIds(entry.types),
      dates,
      publishers: sortIds(entry.publishers),
      developers: sortIds(entry.developers),
      series: sortIds(entry.series),
      genres: sortIds(entry.genres),
      modes: sortIds(entry.modes),
      ...(entry.metacritic.length > 0 ? { metacritic: [...entry.metacritic].sort(byValue) } : {}),
      ...(entry.opencritic.length > 0 ? { opencritic: [...entry.opencritic].sort(byValue) } : {}),
      sitelinks: entry.sitelinks,
      ...(Object.keys(wiki).length > 0 ? { wiki } : {}),
    };
  }
  const outEntities = {};
  for (const [id, labels] of entities) {
    const ordered = {};
    for (const lang of LABEL_LANGS) if (labels[lang]) ordered[lang] = labels[lang];
    outEntities[id] = ordered;
  }
  const outClasses = {};
  for (const [id, entry] of classes) outClasses[id] = { ...(entry.label ? { label: entry.label } : {}), parents: sortIds(entry.parents) };

  const text = formatSnapshot(
    {
      source: "Wikidata, https://www.wikidata.org/ — structured data under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/)",
      query: "items with a Nintendo eShop ID (P8084) ending in -switch; see scripts/switch-library/fetch-wikidata.mjs",
      asOf: todayUtc(),
      counts: { items: Object.keys(outItems).length, entities: Object.keys(outEntities).length, classes: Object.keys(outClasses).length },
    },
    { items: outItems, entities: outEntities, classes: outClasses },
  );
  writeText(WIKIDATA_SNAPSHOT, text);
  process.stderr.write(
    `Wrote ${WIKIDATA_SNAPSHOT}: ${Object.keys(outItems).length} items, ${Object.keys(outEntities).length} entities, ${Object.keys(outClasses).length} classes, ${(text.length / 1024).toFixed(0)} KB; ${sparql.requests} requests in ${((Date.now() - started) / 1000).toFixed(0)} s\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`fetch-wikidata failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
