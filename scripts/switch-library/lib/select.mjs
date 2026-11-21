/**
 * Which Wikidata items become library games, and how their facts become LibraryGame / GameDetails fields
 * (docs/switch-builder.md §4.1). Pure: reads the snapshot written by fetch-wikidata.mjs, never the network.
 *
 * Selection, in order (each refusal is logged with its reason):
 *   1. one candidate per Nintendo US store slug (P8084): trimmed, a trailing "/" removed, ending in "-switch",
 *      lower-case letters, digits and hyphens only; slugs of Switch 2 products are refused ("switch-2");
 *   2. the item must list Nintendo Switch (Q19610114) as a platform (P400) — contract §4.1;
 *   3. the item must be a video game or a compilation (P31 through P279); downloadable content and expansions,
 *      series, esports disciplines and software that is not a game are refused;
 *   4. the item needs a Latin title (an English or "mul" label);
 *   5. the reviewed exclusions (catalog/switch-library/exclusions.json, which build.mjs passes in): an item listed
 *      there loses every slug ("excluded-not-a-game": apps and services Wikidata types as video games;
 *      "excluded-adult": tagged eroge, kept out of a family store by default), and a slug listed there is left out
 *      for every item that holds it ("excluded-slug": a product no longer sold, so the item keeps its other slug);
 *      an entry that matched nothing is logged as "exclusion-unused";
 *   6. one card per item and one item per slug: the items take their slugs in order of sitelinks (then the lower
 *      item number), each the one closest to its English title among those no item before it took: the base
 *      product, not an edition of it. A slug an item leaves ("second-slug") stays free for the next item that holds
 *      it; a slug an item before it took is logged as "slug-shared".
 */
import {
  ADDON_TYPE_ROOTS,
  ESPORTS_TYPE_ROOTS,
  GAME_TYPE_OVERRIDES,
  GAME_TYPE_ROOTS,
  GENRE_KEYS,
  GENRE_MAX_DEPTH,
  GENRE_TABLE,
  MODE_TABLE,
  PLAY_MODES,
  SERIES_TYPE_ROOTS,
  TYPE_MAX_DEPTH,
} from "./mapping.mjs";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-switch$/;
const SWITCH_2_PATTERN = /(?:^|-)switch-2(?:-|$)/;
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
export const MAX_ALIASES = 8;
export const MAX_ALIAS_LENGTH = 60;

/** Walks P279 parents breadth first; true when one of `roots` is met within `maxDepth` steps. */
function reaches(classes, start, roots, maxDepth) {
  let level = [start];
  const seen = new Set(level);
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    if (level.some((id) => Object.hasOwn(roots, id))) return true;
    const next = [];
    for (const id of level) for (const parent of classes[id]?.parents ?? []) if (!seen.has(parent)) seen.add(parent), next.push(parent);
    level = next;
  }
  return false;
}

/** The nearest table entry up the P279 chain (several at the same distance are merged); null when none is near enough. */
function nearestIn(classes, start, table, maxDepth) {
  let level = [start];
  const seen = new Set(level);
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const found = level.filter((id) => Object.hasOwn(table, id));
    if (found.length > 0) return [...new Set(found.flatMap((id) => table[id]))];
    const next = [];
    for (const id of level) for (const parent of classes[id]?.parents ?? []) if (!seen.has(parent)) seen.add(parent), next.push(parent);
    level = next;
  }
  return null;
}

/** "game" | "addon" | "series" | "esports" | "other" for an item's P31 values. */
export function classifyTypes(classes, types) {
  const isAddon = (type) => reaches(classes, type, ADDON_TYPE_ROOTS, TYPE_MAX_DEPTH);
  const isGame = (type) => Object.hasOwn(GAME_TYPE_OVERRIDES, type) || (!isAddon(type) && reaches(classes, type, GAME_TYPE_ROOTS, TYPE_MAX_DEPTH));
  if (types.some(isGame)) return types.some(isAddon) ? "game+addon" : "game";
  if (types.some(isAddon)) return "addon";
  if (types.some((type) => reaches(classes, type, SERIES_TYPE_ROOTS, TYPE_MAX_DEPTH))) return "series";
  if (types.some((type) => reaches(classes, type, ESPORTS_TYPE_ROOTS, TYPE_MAX_DEPTH))) return "esports";
  return "other";
}

/** GENRE_KEYS for an item's P136 values (canonical order); unmapped ids are reported through `onUnmapped`. */
export function genresOf(classes, genres, onUnmapped = () => {}) {
  if (genres.length === 0) return [];
  const keys = new Set();
  for (const genre of genres) {
    const mapped = nearestIn(classes, genre, GENRE_TABLE, GENRE_MAX_DEPTH);
    if (mapped === null) onUnmapped(genre);
    else for (const key of mapped) keys.add(key);
  }
  if (keys.size === 0) return ["other"];
  return GENRE_KEYS.filter((key) => keys.has(key));
}

/** PLAY_MODES for an item's P404 values (canonical order). */
export function modesOf(classes, modes, onUnmapped = () => {}) {
  const keys = new Set();
  for (const mode of modes) {
    const mapped = nearestIn(classes, mode, MODE_TABLE, 2);
    if (mapped === null) onUnmapped(mode);
    else for (const key of mapped) keys.add(key);
  }
  return PLAY_MODES.filter((key) => keys.has(key));
}

const truncate = (date, precision) => (precision >= 11 ? date : precision === 10 ? date.slice(0, 7) : date.slice(0, 4));
/** a before b, compared at their common precision; equal there → the more precise one comes first. */
function earlier(a, b) {
  const precision = Math.min(a.p, b.p, 11);
  const ka = truncate(a.t, precision);
  const kb = truncate(b.t, precision);
  if (ka !== kb) return ka < kb;
  return a.p > b.p;
}

/** A year a video game can have been published in; anything else is a typo in Wikidata (e.g. "0201-05-22"). */
const plausibleYear = (date) => {
  const year = Number(date.t.slice(0, 4));
  return year >= 1970 && year <= 2100;
};

/**
 * `year` and `released` (YYYY-MM-DD): the earliest Switch-qualified publication date when there is one, else the
 * earliest of all. `released` only for a date known to the day; a date known to the year gives the year alone.
 * Implausible years are left out BEFORE choosing, so a typo never hides the item's real dates (review 2026-11-21).
 */
export function releaseOf(dates) {
  const usable = dates.filter((date) => date.p >= 9 && /^\d{4}-\d{2}-\d{2}$/.test(date.t) && plausibleYear(date));
  const qualified = usable.filter((date) => date.s);
  const pool = qualified.length > 0 ? qualified : usable;
  let best = null;
  for (const date of pool) if (!best || earlier(date, best)) best = date;
  if (!best) return {};
  const year = Number(best.t.slice(0, 4));
  return best.p >= 11 ? { year, released: best.t } : { year };
}

const labelOf = (labels) => labels?.en || labels?.mul || null;
const arabicOnly = (text) => (text && ARABIC_SCRIPT.test(text) ? text : undefined);

/** Folded form for comparing titles and aliases: lower case, no accents or punctuation. */
export function fold(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Character-bigram (Dice) similarity of two slugs, 0–1. */
function similarity(a, b) {
  const grams = (text) => {
    const out = new Map();
    for (let i = 0; i < text.length - 1; i++) out.set(text.slice(i, i + 2), (out.get(text.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const [gram, count] of ga) shared += Math.min(count, gb.get(gram) ?? 0);
  const total = Math.max(1, a.length - 1 + (b.length - 1));
  return (2 * shared) / total;
}

/** The Metacritic slug for a store slug: preferred rank first, then the one closest to the store slug. */
export function metacriticSlugOf(values, storeSlug) {
  const valid = (values ?? []).filter((entry) => /^[a-z0-9][a-z0-9-]*$/.test(entry.v) && entry.v.length <= 120);
  if (valid.length === 0) return undefined;
  const preferred = valid.filter((entry) => entry.r === "preferred");
  const pool = (preferred.length > 0 ? preferred : valid).map((entry) => entry.v);
  const target = storeSlug.replace(/-switch$/, "");
  if (pool.includes(target)) return target;
  return [...new Set(pool)].sort((a, b) => similarity(b, target) - similarity(a, target) || (a < b ? -1 : a > b ? 1 : 0))[0];
}

/** The OpenCritic id: preferred rank first, then the lowest number. */
export function opencriticIdOf(values) {
  const valid = (values ?? []).filter((entry) => /^\d{1,9}$/.test(entry.v));
  if (valid.length === 0) return undefined;
  const preferred = valid.filter((entry) => entry.r === "preferred");
  return (preferred.length > 0 ? preferred : valid).map((entry) => entry.v).sort((a, b) => Number(a) - Number(b))[0];
}

/** Latin names of linked items (publishers, developers, series), sorted, without duplicates; unnamed ones left out. */
function namesOf(entities, ids) {
  const names = new Set();
  for (const id of ids) {
    const name = labelOf(entities[id]);
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; });
}

/**
 * Search terms beyond the titles: the item's English, "mul" and Arabic aliases, then its series' names in the same
 * languages — folded duplicates of a title or of each other dropped, at most MAX_ALIASES of at most MAX_ALIAS_LENGTH
 * characters.
 */
function aliasesOf(entities, item, titles) {
  const seen = new Set(titles.filter(Boolean).map(fold));
  const out = [];
  const offer = (text) => {
    if (!text || out.length >= MAX_ALIASES) return;
    const value = text.replace(/\s+/g, " ").trim();
    if (value.length < 2 || value.length > MAX_ALIAS_LENGTH) return;
    const key = fold(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  for (const lang of ["en", "mul", "ar"]) for (const alias of item.aliases?.[lang] ?? []) offer(alias);
  for (const id of item.series) for (const lang of ["en", "mul", "ar"]) offer(entities[id]?.[lang]);
  return out;
}

/**
 * A title spelled the way the store slugs spell one: no accents and no trademark signs, "&" → "and", "+" → "plus",
 * apostrophes dropped, every other run of characters that are not Latin letters or digits one hyphen
 * ("Fate/Extella: The Umbral Star" → "fate-extella-the-umbral-star"). 92 % of the items with a single slug are spelled
 * exactly so (snapshot of 2026-11-21; deleting the punctuation instead matches fewer).
 */
export function slugOfTitle(title) {
  return String(title ?? "")
    .replace(/[\u{2122}\u{AE}\u{A9}]/gu, "")
    .normalize("NFKD")
    .replace(/[\u{300}-\u{36F}]/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/['`\u{2018}\u{2019}]/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * An item's store slugs, the one that best matches its title first: the title's own spelling (slugOfTitle) before
 * any other, then the most similar spelling (bigram similarity), then the shorter slug (the base product rather than
 * an edition such as "…-digital-deluxe-edition-switch"), then code point order.
 */
export function slugsByTitle(slugs, title) {
  const target = slugOfTitle(title);
  const score = new Map(slugs.map((slug) => {
    const stem = slug.endsWith("-switch") ? slug.slice(0, -"-switch".length) : slug;
    return [slug, stem === target ? 2 : similarity(stem, target)];
  }));
  return [...slugs].sort((a, b) => score.get(b) - score.get(a) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

export const EXCLUSION_KINDS = ["not-a-game", "adult"];
const QID_PATTERN = /^Q[1-9]\d*$/;
const isSlug = (value) => typeof value === "string" && SLUG_PATTERN.test(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * The reviewed exclusions (the parsed catalog/switch-library/exclusions.json) as look-ups: `items` by Wikidata item,
 * `slugs` by store slug. A malformed entry, or an item or slug listed twice, throws, so a typo never lets an item
 * through unnoticed. No argument = no exclusions: fetch-wikipedia.mjs selects without them, so the pages of an
 * excluded game stay in the snapshot and re-enabling it needs no new pull.
 */
export function exclusionsOf(file) {
  const items = new Map();
  const slugs = new Map();
  if (file === undefined) return { items, slugs };
  const fail = (message) => {
    throw new Error(`exclusions.json: ${message}`);
  };
  if (!file || typeof file !== "object" || !Array.isArray(file.items) || !Array.isArray(file.slugs)) fail('expected { "items": [...], "slugs": [...] }');
  for (const [index, entry] of file.items.entries()) {
    if (!isSlug(entry?.id) || !QID_PATTERN.test(entry?.qid ?? "") || !EXCLUSION_KINDS.includes(entry?.kind) || !isText(entry?.reason)) fail(`items[${index}] needs an id (the store slug), a qid, a kind (${EXCLUSION_KINDS.join(" or ")}) and a reason`);
    if (items.has(entry.qid)) fail(`items[${index}]: ${entry.qid} is listed twice`);
    items.set(entry.qid, entry);
  }
  for (const [index, entry] of file.slugs.entries()) {
    if (!isSlug(entry?.id) || !QID_PATTERN.test(entry?.qid ?? "") || !isText(entry?.reason)) fail(`slugs[${index}] needs an id (the store slug), a qid and a reason`);
    if (slugs.has(entry.id)) fail(`slugs[${index}]: ${entry.id} is listed twice`);
    slugs.set(entry.id, entry);
  }
  return { items, slugs };
}

/**
 * The library from a Wikidata snapshot and the reviewed exclusions (the parsed exclusions.json; none when left out).
 * @returns {{ games: Array<object>, log: Array<{ slug?: string, qid: string, reason: string, detail?: string }>, unmapped: { genres: Record<string, number>, modes: Record<string, number> } }}
 */
export function selectLibrary(snapshot, { exclusions } = {}) {
  const { items, entities, classes } = snapshot;
  const excluded = exclusionsOf(exclusions);
  const log = [];
  const unmapped = { genres: {}, modes: {} };
  const count = (bucket) => (id) => (bucket[id] = (bucket[id] ?? 0) + 1);
  const typesOf = (item) => item.types.map((type) => `${type} ${classes[type]?.label ?? ""}`.trim()).join("; ");

  // 1–5: each item's candidate slugs
  const slugsOf = new Map();
  const kinds = new Map();
  const matched = new Set(); // the exclusion entries that left something out: "item <qid>", "slug <slug>"
  const kindCache = new Map();
  for (const [qid, item] of Object.entries(items)) {
    const kind = kindCache.get(item.types.join("|")) ?? classifyTypes(classes, item.types);
    kindCache.set(item.types.join("|"), kind);
    const seen = new Set();
    for (const raw of item.slugs) {
      const slug = raw.trim().replace(/\/+$/, "");
      if (!slug.endsWith("-switch") || seen.has(slug)) continue;
      seen.add(slug);
      if (!SLUG_PATTERN.test(slug)) {
        log.push({ slug, qid, reason: "slug-format" });
        continue;
      }
      if (SWITCH_2_PATTERN.test(slug.slice(0, -"-switch".length))) {
        log.push({ slug, qid, reason: "switch-2" });
        continue;
      }
      if (!item.platform) {
        log.push({ slug, qid, reason: "no-switch-platform" });
        continue;
      }
      if (kind !== "game" && kind !== "game+addon") {
        log.push({ slug, qid, reason: kind === "other" ? "not-a-game" : kind, detail: typesOf(item) });
        continue;
      }
      if (!labelOf(item.labels)) {
        log.push({ slug, qid, reason: "no-latin-title" });
        continue;
      }
      const itemEntry = excluded.items.get(qid);
      if (itemEntry) {
        matched.add(`item ${qid}`);
        log.push({ slug, qid, reason: `excluded-${itemEntry.kind}`, detail: itemEntry.reason });
        continue;
      }
      const slugEntry = excluded.slugs.get(slug);
      if (slugEntry) {
        matched.add(`slug ${slug}`);
        log.push({ slug, qid, reason: "excluded-slug", detail: slugEntry.reason });
        continue;
      }
      kinds.set(qid, kind);
      slugsOf.set(qid, [...(slugsOf.get(qid) ?? []), slug]);
    }
  }
  // an entry that left nothing out is stale (the item is refused for another reason, or gone from Wikidata)
  const unused = "nothing left to exclude in this snapshot: review the entry";
  for (const [qid, entry] of excluded.items) if (!matched.has(`item ${qid}`)) log.push({ slug: entry.id, qid, reason: "exclusion-unused", detail: `items: ${unused}` });
  for (const [slug, entry] of excluded.slugs) if (!matched.has(`slug ${slug}`)) log.push({ slug, qid: entry.qid, reason: "exclusion-unused", detail: `slugs: ${unused}` });

  // 6: one card per item, one item per slug — the strongest item first, each takes its best slug still free
  const order = [...slugsOf.keys()].sort((a, b) => items[b].sitelinks - items[a].sitelinks || Number(a.slice(1)) - Number(b.slice(1)));
  const place = new Map(order.map((qid, index) => [qid, index]));
  const owner = new Map(); // slug → the item it is listed for
  const chosen = new Map(); // item → its slug
  for (const qid of order) {
    const slug = slugsByTitle(slugsOf.get(qid), labelOf(items[qid].labels)).find((candidate) => !owner.has(candidate));
    if (!slug) continue;
    owner.set(slug, qid);
    chosen.set(qid, slug);
  }
  for (const qid of order) {
    for (const slug of slugsOf.get(qid)) {
      if (chosen.get(qid) === slug) continue;
      const holder = owner.get(slug);
      if (holder !== undefined && place.get(holder) < place.get(qid)) log.push({ slug, qid, reason: "slug-shared", detail: `kept ${holder} (${items[holder].sitelinks} sitelinks) over ${qid} (${items[qid].sitelinks})` });
      else log.push({ slug, qid, reason: "second-slug", detail: `${qid} is listed as ${chosen.get(qid)}, its slug closest to its title${holder ? `; this slug went to ${holder}` : ""}` });
    }
  }

  const games = [];
  for (const slug of [...owner.keys()].sort()) {
    const qid = owner.get(slug);
    const item = items[qid];
    if (kinds.get(qid) === "game+addon") log.push({ slug, qid, reason: "kept-also-addon", detail: typesOf(item) });
    const title = labelOf(item.labels);
    const titleAr = arabicOnly(item.labels.ar);
    const titleCkb = arabicOnly(item.labels.ckb);
    const { year, released } = releaseOf(item.dates);
    const metacriticSlug = metacriticSlugOf(item.metacritic, slug);
    const aliases = aliasesOf(entities, item, [title, item.labels.en, item.labels.mul, titleAr, titleCkb]);
    games.push({
      id: slug,
      qid,
      title,
      ...(titleAr ? { titleAr } : {}),
      ...(titleCkb ? { titleCkb } : {}),
      ...(year ? { year } : {}),
      ...(released ? { released } : {}),
      publishers: namesOf(entities, item.publishers),
      genres: genresOf(classes, item.genres, count(unmapped.genres)),
      modes: modesOf(classes, item.modes, count(unmapped.modes)),
      popularity: item.sitelinks,
      ...(metacriticSlug ? { metacriticSlug } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      details: {
        developers: namesOf(entities, item.developers),
        series: namesOf(entities, item.series),
        opencriticId: opencriticIdOf(item.opencritic),
        wiki: item.wiki ?? {},
      },
    });
  }
  log.sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : (a.slug ?? "") < (b.slug ?? "") ? -1 : (a.slug ?? "") > (b.slug ?? "") ? 1 : Number(a.qid.slice(1)) - Number(b.qid.slice(1))));
  return { games, log, unmapped };
}
