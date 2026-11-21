/**
 * Switch bundle builder — the open game library's static files (docs/switch-builder.md §4.1), as
 * scripts/switch-library/build.mjs writes them from the committed snapshots in catalog/switch-library/:
 *
 *   · the manifest names a list file that exists; the list and every chunk match LibraryList / LibraryChunk (zod)
 *   · ids are unique Nintendo US store slugs of Switch 1 products (ending in "-switch"), and every game's details
 *     sit in the chunk it names
 *   · one card per Wikidata item: an item with several store slugs is listed once, under the slug closest to its title
 *   · catalog/switch-library/exclusions.json (reviewed by hand) matches the snapshot and the build applied it: no
 *     excluded item or slug is listed, every exclusion is in the selection log, none is stale, and no listed game is
 *     tagged eroge in Wikidata (adult games stay out of a family store by default)
 *   · no URL anywhere points at a Nintendo or Metacritic host (contract §1.2); Wikipedia URLs are on the en / ar /
 *     ckb wikis and every extract carries its title, link and date (contract §1.3)
 *   · nothing the build ships holds a word contract §1.1 keeps out of the store
 *   · nothing it ships holds a character app/server/text.server.ts cleanText removes (controls, bidi overrides,
 *     invisibles), the Arabic and Sorani titles print Western digits, and on made-up Wikidata and Wikipedia text the
 *     build removes those characters (logging the field, never the text) and leaves out an extract whose link is not
 *     an https <lang>.wikipedia.org/wiki/ article (qa-security, qa-visual 2026-11-21)
 *   · budgets: the list ≤ 350 KB brotli, each chunk ≤ 60 KB brotli
 *   · the files are current: `build.mjs --check` finds nothing to rewrite, and the script's genre and mode keys are
 *     the ones of types.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { LIBRARY_AS_OF, LIBRARY_CHUNK_PATH, LIBRARY_GAME_COUNT, LIBRARY_LIST_FILE } from "~/routes/storefront/builder/library.manifest";
import { GENRE_KEYS, PLAY_MODES, type GameDetails, type LibraryChunk, type LibraryGame, type LibraryList } from "~/lib/switch-builder/types";
import { cleanText, isCleanText } from "~/server/text.server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const CHUNK_DIR = path.join(PUBLIC, "library", "switch", "d");
const SNAPSHOT_DIR = path.join(ROOT, "catalog", "switch-library");
const LIST_BUDGET = 350 * 1024;
const CHUNK_BUDGET = 60 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const GameSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-switch$/),
  qid: z.string().regex(/^Q\d+$/),
  title: z.string().trim().min(1),
  titleAr: z.string().trim().min(1).optional(),
  titleCkb: z.string().trim().min(1).optional(),
  year: z.number().int().min(1970).max(2100).optional(),
  released: z.string().regex(ISO_DATE).optional(),
  publishers: z.array(z.string().trim().min(1)),
  genres: z.array(z.enum(GENRE_KEYS)),
  modes: z.array(z.enum(PLAY_MODES)),
  popularity: z.number().int().min(0),
  chunk: z.number().int().min(0),
  metacriticSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  aliases: z.array(z.string().trim().min(1)).min(1).optional(),
});
const ExtractSchema = z.strictObject({ text: z.string().min(1).max(901), title: z.string().trim().min(1), url: z.url({ protocol: /^https$/ }), asOf: z.string().regex(ISO_DATE) });
const DetailsSchema = z.strictObject({
  id: z.string(),
  developers: z.array(z.string().trim().min(1)),
  series: z.array(z.string().trim().min(1)).min(1).optional(),
  opencriticId: z.string().regex(/^\d+$/).optional(),
  wikipedia: z.strictObject({ en: ExtractSchema.optional(), ar: ExtractSchema.optional(), ckb: ExtractSchema.optional() }).optional(),
});
const ListSchema = z.strictObject({
  version: z.literal(1),
  asOf: z.string().regex(ISO_DATE),
  sources: z.strictObject({ wikidata: z.string().min(1), wikipedia: z.string().min(1) }),
  chunks: z.array(z.string().regex(/^\d+\.[0-9a-f]{8}\.json$/)).min(1),
  games: z.array(GameSchema).min(1),
});
const ChunkSchema = z.strictObject({ version: z.literal(1), details: z.record(z.string(), DetailsSchema) });
const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-switch$/);
const QidSchema = z.string().regex(/^Q[1-9]\d*$/);
/** catalog/switch-library/exclusions.json: reviewed by hand, applied by lib/select.mjs. */
const ExclusionsSchema = z.strictObject({
  about: z.string().trim().min(1),
  reviewed: z.string().regex(ISO_DATE),
  items: z.array(z.strictObject({ id: SlugSchema, qid: QidSchema, title: z.string().trim().min(1), kind: z.enum(["not-a-game", "adult"]), reason: z.string().trim().min(1) })),
  slugs: z.array(z.strictObject({ id: SlugSchema, qid: QidSchema, title: z.string().trim().min(1), reason: z.string().trim().min(1) })),
});
/** The parts of catalog/switch-library/wikidata.json these tests read. */
type Snapshot = {
  items: Record<string, { slugs: string[]; genres: string[]; labels: Record<string, string> }>;
  classes: Record<string, { label?: string; parents: string[] }>;
};
type LogEntry = { slug?: string; qid: string; reason: string; detail?: string };
type Select = {
  selectLibrary(snapshot: unknown, options?: { exclusions?: unknown }): { games: LibraryGame[]; log: LogEntry[] };
  slugOfTitle(title: string): string;
  slugsByTitle(slugs: string[], title: string): string[];
  exclusionsOf(file: unknown): { items: Map<string, unknown>; slugs: Map<string, unknown> };
};
const importSelect = async () => (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "select.mjs")).href)) as Select;
/** Wikidata genres that mark an adult game: eroge (Q1046788) and erotic video game (Q3362070). */
const ADULT_GENRES = ["Q1046788", "Q3362070"];
/** The reason every adult entry gives: the owner lists them again only by deleting the entries. */
const ADULT_REASON = "adult (eroge) — owner may re-enable";

/** Whether the class `start` is one of `roots` or a subclass of one (P279, at most `depth` steps up). */
function reaches(classes: Snapshot["classes"], start: string, roots: string[], depth = 4): boolean {
  let level = [start];
  const seen = new Set(level);
  for (let step = 0; step <= depth && level.length > 0; step++) {
    if (level.some((id) => roots.includes(id))) return true;
    const next: string[] = [];
    for (const id of level) {
      for (const parent of classes[id]?.parents ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        next.push(parent);
      }
    }
    level = next;
  }
  return false;
}

/** A made-up snapshot item: a video game on Switch with nothing else known. */
const madeUpItem = (over: Record<string, unknown>) => ({ slugs: [], platform: true, labels: { en: "Game" }, types: ["Q7889"], dates: [], publishers: [], developers: [], series: [], genres: [], modes: [], sitelinks: 0, ...over });

// the schemas describe exactly the shared types (a field added to one and not the other fails the type check)
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const gameMatches: Same<z.infer<typeof GameSchema>, LibraryGame> = true;
const detailsMatch: Same<z.infer<typeof DetailsSchema>, GameDetails> = true;

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const brotli = (file: string) => brotliCompressSync(readFileSync(file)).length;

function load() {
  expect(LIBRARY_LIST_FILE, "run node scripts/switch-library/build.mjs").not.toBeNull();
  const listFile = path.join(PUBLIC, ...String(LIBRARY_LIST_FILE).split("/").filter(Boolean));
  expect(existsSync(listFile), listFile).toBe(true);
  const list = ListSchema.parse(readJson(listFile));
  const chunks = list.chunks.map((name) => {
    const file = path.join(CHUNK_DIR, name);
    expect(existsSync(file), file).toBe(true);
    return { name, file, chunk: ChunkSchema.parse(readJson(file)) };
  });
  return { listFile, list, chunks };
}

/** Every string value inside `value`. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* strings(item);
}

describe("the Switch library files", () => {
  test("the manifest, the list and every chunk match the shared types", () => {
    expect(gameMatches && detailsMatch).toBe(true);
    const { list, chunks } = load();
    expect(LIBRARY_LIST_FILE).toMatch(/^\/library\/switch\/list\.[0-9a-f]{8}\.json$/);
    expect(LIBRARY_CHUNK_PATH).toBe("/library/switch/d/");
    expect(LIBRARY_AS_OF).toBe(list.asOf);
    expect(LIBRARY_GAME_COUNT).toBe(list.games.length);
    expect(list.games.length).toBeGreaterThan(4_000);
    expect(chunks).toHaveLength(64);
    chunks.forEach(({ name }, index) => expect(name.startsWith(`${index}.`), name).toBe(true));
    // only the current files are on disk
    expect(readdirSync(CHUNK_DIR).sort()).toEqual([...list.chunks].sort());
    expect(readdirSync(path.dirname(path.join(PUBLIC, ...String(LIBRARY_LIST_FILE).split("/").filter(Boolean)))).filter((name) => name.startsWith("list."))).toEqual([String(LIBRARY_LIST_FILE).split("/").pop()]);
  });

  test("ids are unique Switch 1 store slugs; each game's details are in the chunk it names, and only there", () => {
    const { list, chunks } = load();
    const ids = list.games.map((game) => game.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.endsWith("-switch") && !/(?:^|-)switch-2(?:-|$)/.test(id.slice(0, -7)))).toBe(true);
    expect([...ids].sort()).toEqual(ids); // stable order
    for (const game of list.games) {
      expect(game.chunk, game.id).toBeLessThan(chunks.length);
      expect(chunks[game.chunk].chunk.details[game.id]?.id, game.id).toBe(game.id);
      if (game.released) expect(game.year, game.id).toBe(Number(game.released.slice(0, 4)));
      expect(new Set(game.genres).size, game.id).toBe(game.genres.length);
      expect(new Set(game.modes).size, game.id).toBe(game.modes.length);
    }
    const listed = new Map(list.games.map((game) => [game.id, game.chunk]));
    chunks.forEach(({ chunk }, index) => {
      for (const [id, details] of Object.entries(chunk.details)) {
        expect(details.id).toBe(id);
        expect(listed.get(id), id).toBe(index);
      }
    });
    expect(chunks.reduce((sum, { chunk }) => sum + Object.keys(chunk.details).length, 0)).toBe(list.games.length);
  });

  test("one card per Wikidata item", () => {
    const { list } = load();
    const first = new Map<string, string>();
    const twice: string[] = [];
    for (const game of list.games) {
      const earlier = first.get(game.qid);
      if (earlier) twice.push(`${game.qid}: ${earlier} and ${game.id}`);
      else first.set(game.qid, game.id);
    }
    expect(twice, "an item listed under two slugs (lib/select.mjs, step 6)").toEqual([]);
  });

  test("no URL points at a Nintendo or Metacritic host; extracts carry their Wikipedia title, link and date", () => {
    const { list, chunks } = load();
    const urls = [...strings(list), ...chunks.flatMap(({ chunk }) => [...strings(chunk)])].flatMap((text) => text.match(/https?:\/\/[^\s"'<>)]+/g) ?? []);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(new URL(url).hostname, url).not.toMatch(/nintendo|metacritic/i);
    let extracts = 0;
    for (const { chunk } of chunks) {
      for (const details of Object.values(chunk.details)) {
        for (const [lang, extract] of Object.entries(details.wikipedia ?? {})) {
          if (!extract) continue;
          extracts += 1;
          const url = new URL(extract.url);
          expect(url.hostname, extract.url).toBe(`${lang}.wikipedia.org`);
          expect(url.pathname.startsWith("/wiki/"), extract.url).toBe(true);
          expect(extract.text.length).toBeLessThanOrEqual(901);
          expect(extract.text).toBe(extract.text.replace(/\s+/g, " ").trim());
          expect(extract.text).not.toMatch(/<[a-z][^>]*>/i);
        }
      }
    }
    expect(extracts).toBeGreaterThan(0);
  });

  test("a long lead is cut after its last sentence that fits", async () => {
    const text = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "text.mjs")).href)) as { cutAtSentence(text: string, max?: number): string };
    const lead = `Hades is a roguelike game by Supergiant Games, based in the U.S. It came out in 2020. ${"It has many rooms. ".repeat(60)}`;
    const cut = text.cutAtSentence(lead);
    expect(cut.length).toBeLessThanOrEqual(900);
    expect(cut.endsWith("It has many rooms.")).toBe(true);
    expect(text.cutAtSentence("Made by Nintendo Co. Ltd. in Kyoto. Then more words follow here.", 40)).toBe("Made by Nintendo Co. Ltd. in Kyoto.");
    expect(text.cutAtSentence(`${"word ".repeat(400)}`, 900).endsWith("…")).toBe(true);
    expect(text.cutAtSentence("هي لعبة فيديو. صدرت عام 2017. " + "جملة أخرى طويلة. ".repeat(80)).endsWith(".")).toBe(true);
  });

  test("nothing shipped holds a word the store never prints", async () => {
    const text = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "text.mjs")).href)) as { hasForbiddenWord(text: string): boolean };
    const { list, chunks } = load();
    const found = [...strings(list), ...chunks.flatMap(({ chunk }) => [...strings(chunk)])].filter((value) => text.hasForbiddenWord(value));
    expect(found).toEqual([]);
  });

  test("budgets: the list ≤ 350 KB brotli, each chunk ≤ 60 KB brotli", () => {
    const { listFile, chunks } = load();
    expect(brotli(listFile)).toBeLessThanOrEqual(LIST_BUDGET);
    for (const { name, file } of chunks) expect(brotli(file), name).toBeLessThanOrEqual(CHUNK_BUDGET);
  });

  test("the selection rules, on a small made-up snapshot", async () => {
    type Picked = { games: Array<LibraryGame & { details: { developers: string[] } }>; log: Array<{ slug?: string; qid: string; reason: string }> };
    const select = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "select.mjs")).href)) as {
      selectLibrary(snapshot: unknown): Picked;
      releaseOf(dates: Array<{ t: string; p: number; s?: 1 }>): { year?: number; released?: string };
    };
    const node = (parents: string[] = []) => ({ parents });
    const classes = { Q7889: node(), Q16070115: node(["Q7889"]), Q209163: node(["Q7889"]), Q1066707: node(["Q209163"]), Q7058673: node(), Q112144412: node(), Q166142: node(), Q61719251: node(["Q868217"]), Q999001: node() };
    const item = (over: Record<string, unknown>) => ({ slugs: [], platform: true, labels: { en: "Game" }, types: ["Q7889"], dates: [], publishers: [], developers: [], series: [], genres: [], modes: [], sitelinks: 0, ...over });
    const items = {
      Q1: item({ slugs: ["alpha-switch", "alpha-switch-2"], labels: { en: "Alpha", ar: "ألفا" }, genres: ["Q828322"], modes: ["Q208850", "Q1758804"], dates: [{ t: "2015-03-01", p: 11 }, { t: "2018-06-01", p: 11, s: 1 }], sitelinks: 10, metacritic: [{ v: "alpha", r: "normal" }], publishers: ["Q100"] }),
      Q2: item({ slugs: ["alpha-season-pass-70050000000001-switch"], types: ["Q1066707"] }),
      Q3: item({ slugs: ["alpha-saga-switch"], types: ["Q7058673"] }),
      Q4: item({ slugs: ["beta-switch"], types: ["Q7889", "Q112144412"], labels: { mul: "Beta" }, genres: ["Q61719251", "Q27670585"], dates: [{ t: "2019-01-01", p: 9 }] }),
      Q5: item({ slugs: ["shared-switch"], sitelinks: 2, labels: { en: "Shared, the lesser item" } }),
      Q6: item({ slugs: ["shared-switch"], sitelinks: 9, labels: { en: "Shared" } }),
      Q7: item({ slugs: ["gamma-nintendo-switch-2-edition-switch"] }),
      Q8: item({ slugs: ["delta-switch"], platform: false }),
      Q9: item({ slugs: ["epsilon-switch"], types: ["Q166142"] }),
      Q10: item({ slugs: ["zeta-switch"], genres: ["Q999001"], labels: { en: "Zeta", ar: "Zeta" } }),
      Q11: item({ slugs: ["Eta_Game-switch"] }),
      Q12: item({ slugs: ["theta-collection-switch/"], types: ["Q16070115"] }),
      Q13: item({ slugs: ["iota-switch"], labels: { ja: "イオタ" } }),
    };
    const { games, log } = select.selectLibrary({ items, entities: { Q100: { en: "Nintendo" } }, classes });
    expect(games.map((game) => game.id)).toEqual(["alpha-switch", "beta-switch", "shared-switch", "theta-collection-switch", "zeta-switch"]);
    const byId = Object.fromEntries(games.map((game) => [game.id, game]));
    // Switch-qualified date first; an Arabic label in Arabic script; genres through the table; co-op also counts as multi
    expect(byId["alpha-switch"]).toMatchObject({ qid: "Q1", title: "Alpha", titleAr: "ألفا", year: 2018, released: "2018-06-01", publishers: ["Nintendo"], genres: ["platformer"], modes: ["single", "multi", "coop"], popularity: 10, metacriticSlug: "alpha" });
    // a game that is also an esports discipline stays; "mul" title; a date known to the year gives no day; P279 walk to the nearest mapped genre
    expect(byId["beta-switch"]).toMatchObject({ title: "Beta", year: 2019, genres: ["sports"] });
    expect(byId["beta-switch"].released).toBeUndefined();
    // the item with the most sitelinks keeps a shared slug
    expect(byId["shared-switch"]).toMatchObject({ qid: "Q6", title: "Shared" });
    // a genre no table entry is near maps to "other"; a Latin "ar" label is no Arabic title
    expect(byId["zeta-switch"]).toMatchObject({ genres: ["other"] });
    expect(byId["zeta-switch"].titleAr).toBeUndefined();
    const reasons = Object.fromEntries(log.map((entry) => [entry.qid, entry.reason]));
    expect(reasons).toEqual({ Q2: "addon", Q3: "series", Q5: "slug-shared", Q7: "switch-2", Q8: "no-switch-platform", Q9: "not-a-game", Q11: "slug-format", Q13: "no-latin-title" });
    // dates: the more precise of two in the same year; nothing before 1970
    expect(select.releaseOf([{ t: "2017-01-01", p: 9 }, { t: "2017-03-03", p: 11 }])).toEqual({ year: 2017, released: "2017-03-03" });
    expect(select.releaseOf([{ t: "2016-05-01", p: 10 }, { t: "2017-03-03", p: 11, s: 1 }])).toEqual({ year: 2017, released: "2017-03-03" });
    expect(select.releaseOf([{ t: "1950-01-01", p: 9 }])).toEqual({});
    // a typo year is left out before choosing: it never hides the real dates, Switch-qualified or not
    expect(select.releaseOf([{ t: "0201-05-22", p: 11 }, { t: "2019-10-15", p: 11 }])).toEqual({ year: 2019, released: "2019-10-15" });
    expect(select.releaseOf([{ t: "0219-01-01", p: 11, s: 1 }, { t: "2017-03-03", p: 11 }])).toEqual({ year: 2017, released: "2017-03-03" });
  });

  test("one card per item: the slug closest to the title; a slug an item leaves goes to the next item that holds it", async () => {
    const select = await importSelect();
    const items = {
      // the base product, not its edition; the title's own spelling, not a near one ("1-2-Switch" gives "…-switch-switch")
      Q21: madeUpItem({ slugs: ["sonic-dash-digital-deluxe-edition-switch", "sonic-dash-switch"], labels: { en: "Sonic Dash" }, sitelinks: 5 }),
      Q22: madeUpItem({ slugs: ["1-2-switch", "1-2-switch-switch"], labels: { en: "1-2-Switch" }, sitelinks: 9 }),
      Q23: madeUpItem({ slugs: ["fateextella-switch", "fate-extella-switch"], labels: { en: "Fate/Extella" }, sitelinks: 3 }),
      // no slug spells the title: the most similar one, then the shorter
      Q24: madeUpItem({ slugs: ["prison-architect-nintendo-switch-edition-switch", "prison-architect-nintendo-switch"], labels: { en: "Prison Architect" }, sitelinks: 2 }),
      // the stronger item leaves its second slug to the game that slug belongs to
      Q25: madeUpItem({ slugs: ["neighbor-hide-and-seek-switch", "neighbor-switch"], labels: { en: "Neighbor" }, sitelinks: 31 }),
      Q26: madeUpItem({ slugs: ["neighbor-hide-and-seek-switch"], labels: { en: "Neighbor: Hide and Seek" } }),
      // a slug a stronger item took, and no other: no card
      Q27: madeUpItem({ slugs: ["sonic-dash-switch"], labels: { en: "Sonic Dash Plus" } }),
    };
    const { games, log } = select.selectLibrary({ items, entities: {}, classes: { Q7889: { parents: [] } } });
    expect(games.map((game) => `${game.id} ${game.qid}`)).toEqual(["1-2-switch-switch Q22", "fate-extella-switch Q23", "neighbor-hide-and-seek-switch Q26", "neighbor-switch Q25", "prison-architect-nintendo-switch Q24", "sonic-dash-switch Q21"]);
    expect(log.map((entry) => `${entry.reason} ${entry.slug} ${entry.qid}`)).toEqual([
      "second-slug 1-2-switch Q22",
      "second-slug fateextella-switch Q23",
      "second-slug neighbor-hide-and-seek-switch Q25",
      "second-slug prison-architect-nintendo-switch-edition-switch Q24",
      "second-slug sonic-dash-digital-deluxe-edition-switch Q21",
      "slug-shared sonic-dash-switch Q27",
    ]);
    expect(log.find((entry) => entry.slug === "neighbor-hide-and-seek-switch")?.detail).toBe("Q25 is listed as neighbor-switch, its slug closest to its title; this slug went to Q26");
    expect(log.find((entry) => entry.reason === "slug-shared")?.detail).toBe("kept Q21 (5 sitelinks) over Q27 (0)");
    // a title spelled as a store slug
    expect(select.slugOfTitle("Pokémon Café ReMix")).toBe("pokemon-cafe-remix");
    expect(select.slugOfTitle("Mario + Rabbids Kingdom Battle")).toBe("mario-plus-rabbids-kingdom-battle");
    expect(select.slugOfTitle("Atelier Lydie & Suelle")).toBe("atelier-lydie-and-suelle");
    expect(select.slugOfTitle("Sid Meier’s Civilization VI")).toBe("sid-meiers-civilization-vi");
    expect(select.slugOfTitle("EA SPORTS FC™ 24")).toBe("ea-sports-fc-24");
    expect(select.slugOfTitle("Robotics;Notes DaSH")).toBe("robotics-notes-dash");
    expect(select.slugsByTitle(["torchlight-2-switch", "torchlight-ii-switch"], "Torchlight II")).toEqual(["torchlight-ii-switch", "torchlight-2-switch"]);
  });

  test("the reviewed exclusions: an item loses every slug, a slug is left out for every holder, a stale entry is logged", async () => {
    const select = await importSelect();
    const items = {
      Q31: madeUpItem({ slugs: ["kitty-vol-1-switch", "kitty-vol1-switch"], labels: { en: "Kitty Vol. 1" } }),
      Q32: madeUpItem({ slugs: ["clock-app-switch"], labels: { en: "Clock App" } }),
      Q33: madeUpItem({ slugs: ["blocks-old-edition-switch", "blocks-switch"], labels: { en: "Blocks: Old Edition" }, sitelinks: 1 }),
      Q34: madeUpItem({ slugs: ["blocks-old-edition-switch"], labels: { en: "Blocks: Legacy Edition" } }),
      Q35: madeUpItem({ slugs: ["shared-two-switch"], labels: { en: "Shared Two" }, sitelinks: 9 }),
      Q36: madeUpItem({ slugs: ["shared-two-switch"], labels: { en: "Shared Two Deluxe" } }),
      Q37: madeUpItem({ slugs: ["refused-switch"], platform: false }),
    };
    const exclusions = {
      items: [
        { id: "kitty-vol-1-switch", qid: "Q31", kind: "adult", reason: ADULT_REASON },
        { id: "clock-app-switch", qid: "Q32", kind: "not-a-game", reason: "clock app" },
        { id: "shared-two-switch", qid: "Q35", kind: "not-a-game", reason: "storage service" },
        { id: "refused-switch", qid: "Q37", kind: "not-a-game", reason: "an app" },
      ],
      slugs: [
        { id: "blocks-old-edition-switch", qid: "Q33", reason: "no longer sold" },
        { id: "gone-switch", qid: "Q99", reason: "no longer sold" },
      ],
    };
    const snapshot = { items, entities: {}, classes: { Q7889: { parents: [] } } };
    const { games, log } = select.selectLibrary(snapshot, { exclusions });
    // the excluded item's shared slug goes to the other holder; the item whose slug is left out keeps its other one
    expect(games.map((game) => `${game.id} ${game.qid}`)).toEqual(["blocks-switch Q33", "shared-two-switch Q36"]);
    expect(log.map((entry) => `${entry.reason} ${entry.slug} ${entry.qid}`)).toEqual([
      "excluded-adult kitty-vol-1-switch Q31",
      "excluded-adult kitty-vol1-switch Q31",
      "excluded-not-a-game clock-app-switch Q32",
      "excluded-not-a-game shared-two-switch Q35",
      "excluded-slug blocks-old-edition-switch Q33",
      "excluded-slug blocks-old-edition-switch Q34",
      "exclusion-unused gone-switch Q99",
      "exclusion-unused refused-switch Q37",
      "no-switch-platform refused-switch Q37",
    ]);
    expect(log.find((entry) => entry.slug === "clock-app-switch")?.detail).toBe("clock app");
    // without the file (as fetch-wikipedia.mjs selects) every item has its card again
    expect(select.selectLibrary(snapshot).games.map((game) => game.id)).toEqual(["blocks-old-edition-switch", "clock-app-switch", "kitty-vol-1-switch", "shared-two-switch"]);
    // a malformed file throws instead of letting an item through
    const entry = { id: "kitty-vol-1-switch", qid: "Q31", kind: "adult", reason: ADULT_REASON };
    expect(() => select.exclusionsOf({ items: [{ ...entry, kind: "other" }], slugs: [] })).toThrow(/kind/);
    expect(() => select.exclusionsOf({ items: [entry, { ...entry, id: "kitty-vol1-switch" }], slugs: [] })).toThrow(/twice/);
    expect(() => select.exclusionsOf({ items: [{ ...entry, reason: " " }], slugs: [] })).toThrow(/reason/);
    expect(() => select.exclusionsOf({ items: [], slugs: [{ id: "Blocks", qid: "Q33", reason: "no longer sold" }] })).toThrow(/slugs\[0\]/);
    expect(() => select.exclusionsOf({ items: [] })).toThrow();
    expect(() => select.exclusionsOf(null)).toThrow();
  });

  test("the reviewed exclusions match the snapshot, the build applied them, and no listed game is tagged adult", async () => {
    const text = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "text.mjs")).href)) as { hasForbiddenWord(text: string): boolean };
    const exclusions = ExclusionsSchema.parse(readJson(path.join(SNAPSHOT_DIR, "exclusions.json")));
    const snapshot = readJson(path.join(SNAPSHOT_DIR, "wikidata.json")) as Snapshot;
    const log = readJson(path.join(SNAPSHOT_DIR, "selection-log.json")) as { games: number; entries: LogEntry[] };
    const { list } = load();
    const slugsOf = (qid: string) => (snapshot.items[qid]?.slugs ?? []).map((slug) => slug.trim().replace(/\/+$/, ""));

    // one entry per item and per slug, each reviewed on a slug its item holds in the snapshot
    expect(new Set(exclusions.items.map((entry) => entry.qid)).size).toBe(exclusions.items.length);
    expect(new Set(exclusions.slugs.map((entry) => entry.id)).size).toBe(exclusions.slugs.length);
    for (const entry of [...exclusions.items, ...exclusions.slugs]) expect(slugsOf(entry.qid), `${entry.id} (${entry.qid})`).toContain(entry.id);

    // "adult" = tagged eroge or erotic video game in Wikidata, with the owner's reason
    expect(ADULT_GENRES.map((id) => snapshot.classes[id]?.label)).toEqual(["eroge", "erotic video game"]);
    const adult = (qid: string) => (snapshot.items[qid]?.genres ?? []).some((genre) => reaches(snapshot.classes, genre, ADULT_GENRES));
    for (const entry of exclusions.items.filter((candidate) => candidate.kind === "adult")) {
      expect(entry.reason, entry.id).toBe(ADULT_REASON);
      expect(adult(entry.qid), `${entry.id} is not tagged adult in Wikidata`).toBe(true);
    }

    // nothing excluded is listed, and no listed game is tagged adult (one that a refresh brings needs an entry)
    const excludedItems = new Set(exclusions.items.map((entry) => entry.qid));
    const excludedSlugs = new Set(exclusions.slugs.map((entry) => entry.id));
    expect(list.games.filter((game) => excludedItems.has(game.qid) || excludedSlugs.has(game.id)).map((game) => game.id)).toEqual([]);
    expect(list.games.filter((game) => adult(game.qid)).map((game) => game.id), "tagged adult in Wikidata: add to exclusions.json").toEqual([]);
    // the item whose 2017 slug is left out keeps the slug sold today
    expect(list.games.find((game) => game.id === "minecraft-switch")?.qid).toBe("Q138152807");

    // the selection log names every exclusion with its reason, and none is stale
    for (const entry of exclusions.items) expect(log.entries.some((logged) => logged.reason === `excluded-${entry.kind}` && logged.qid === entry.qid && logged.slug === entry.id && logged.detail === entry.reason), entry.id).toBe(true);
    for (const entry of exclusions.slugs) expect(log.entries.some((logged) => logged.reason === "excluded-slug" && logged.qid === entry.qid && logged.slug === entry.id && logged.detail === entry.reason), entry.id).toBe(true);
    expect(log.entries.filter((logged) => logged.reason === "exclusion-unused")).toEqual([]);
    expect(log.games).toBe(list.games.length);

    // the apps and services Wikidata types as video games are not listed
    for (const id of ["pokemon-home-switch", "calculator-switch", "aaa-clock-switch"]) expect(list.games.some((game) => game.id === id), id).toBe(false);
    expect(list.games.filter((game) => /Nintendo Classics|Nintendo Switch Online/i.test(game.title)).map((game) => game.id)).toEqual([]);

    // the reviewed reasons go into the committed log: neither file holds a word the store never prints (contract §1.1)
    expect([...strings(exclusions), ...strings(log)].filter((value) => text.hasForbiddenWord(value))).toEqual([]);
  });

  test("the word guard sees through diacritics and invisible characters, and keeps the genre name", async () => {
    const text = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "text.mjs")).href)) as {
      hasForbiddenWord(text: string): boolean;
      withoutForbiddenSentences(text: string): string | null;
    };
    // built from fragments, so this file never holds the words themselves (contract §1.1)
    const join = (...parts: string[]) => parts.join("");
    const gerund = join("mod", "ding");
    expect(text.hasForbiddenWord(`It features support for ${gerund}.`)).toBe(true);
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const shadda = String.fromCharCode(0x651);
    expect(text.hasForbiddenWord(join("hac", zeroWidthSpace, "ked"))).toBe(true); // a zero-width space inside the word
    expect(text.hasForbiddenWord(join("جهاز ", "مه", "ك", shadda, "ر"))).toBe(true); // with a shadda
    expect(text.hasForbiddenWord(join("Hac", "ked"))).toBe(true); // capitals are no way round it
    expect(text.hasForbiddenWord(join("mod", "2", "ded"))).toBe(false); // only the invisible marks are dropped, never letters or digits
    expect(text.hasForbiddenWord(join("لعبة فيديو للقر", "صنة والقطع"))).toBe(true);
    expect(text.hasForbiddenWord(join("محم", "لة مسبقاً"))).toBe(true);
    expect(text.hasForbiddenWord("Hyrule Warriors: Age of Calamity is a 2020 hack and slash game.")).toBe(false);
    expect(text.hasForbiddenWord("قراصنة الفضاء في لعبة أكشن، ومعدل التقييم")).toBe(false); // pirates as characters, a rate
    expect(text.hasForbiddenWord("Game modes: single player and online.")).toBe(false);
    // the extract keeps the sentences before the first one that holds a word
    expect(text.withoutForbiddenSentences(`Terraria is a 2011 sandbox game. It features support for ${gerund}.`)).toBe("Terraria is a 2011 sandbox game.");
    expect(text.withoutForbiddenSentences(`It features support for ${gerund}. Terraria is a 2011 sandbox game.`)).toBeNull();
  });

  test("nothing shipped holds a control, bidi-override or invisible character; the Arabic and Sorani titles print Western digits", () => {
    const { list, chunks } = load();
    const shipped = [...strings(list), ...chunks.flatMap(({ chunk }) => [...strings(chunk)])];
    expect(shipped.length).toBeGreaterThan(10_000);
    expect(shipped.filter((value) => !isCleanText(value))).toEqual([]);
    const easternDigits = /[٠-٩۰-۹]/;
    expect(list.games.filter((game) => easternDigits.test(`${game.titleAr ?? ""}${game.titleCkb ?? ""}`)).map((game) => game.id)).toEqual([]);
    // Wikidata's Sorani label «… ١١» sat next to the year «2019» on the card (qa-visual 2026-11-21)
    expect(list.games.find((game) => game.id === "mortal-kombat-11-switch")?.titleCkb).toMatch(/ 11$/);
  });

  test("the build's text rules: the characters cleanText removes, Western digits, the one Wikipedia link form", async () => {
    const text = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "text.mjs")).href)) as {
      cleanLibraryText(text: unknown): string;
      westernDigits(text: string): string;
      wikipediaUrlOf(url: unknown, lang: string): string | null;
    };
    // exactly the set of app/server/text.server.ts cleanText, every code point of the basic plane
    const differ: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const value = `a${String.fromCharCode(code)}b`;
      const ours = text.cleanLibraryText(value);
      const server = cleanText(value);
      if ((ours !== value) !== (server !== value) || (ours !== value && ours !== server.replace(/\s+/g, " ").trim())) differ.push(code.toString(16));
    }
    expect(differ).toEqual([]);
    const ch = (code: number) => String.fromCharCode(code);
    expect(text.cleanLibraryText(`${ch(0xfeff)}Hades ${ch(0x202e)}II${ch(0x200b)}\n `)).toBe("Hades II");
    expect(text.cleanLibraryText(`پیکمین${ch(0x200c)}ی`)).toBe(`پیکمین${ch(0x200c)}ی`); // ZWNJ is Sorani spelling: kept
    expect(text.cleanLibraryText("Hades  (2020)")).toBe("Hades  (2020)"); // nothing to remove: left exactly as it is
    expect(text.cleanLibraryText(undefined)).toBe("");
    expect(text.westernDigits("مۆڕتاڵ کۆمبات ١١ · ۲۰۱۹ · 2019")).toBe("مۆڕتاڵ کۆمبات 11 · 2019 · 2019");
    expect(text.westernDigits("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹")).toBe("01234567890123456789");
    const article = "https://ckb.wikipedia.org/wiki/%D9%BE%DB%8C%DA%A9%D9%85%DB%8C%D9%86_2";
    expect(text.wikipediaUrlOf(article, "ckb")).toBe(article);
    expect(text.wikipediaUrlOf("https://en.wikipedia.org/wiki/Hades_(video_game)", "en")).toBe("https://en.wikipedia.org/wiki/Hades_(video_game)");
    for (const [url, lang] of [
      ["http://en.wikipedia.org/wiki/Hades", "en"],
      ["https://ar.wikipedia.org/wiki/Hades", "en"],
      ["https://en.wikipedia.org.example.net/wiki/Hades", "en"],
      ["https://en.wikipedia.org@example.net/wiki/Hades", "en"],
      ["https://user@en.wikipedia.org/wiki/Hades", "en"],
      ["https://en.wikipedia.org:8443/wiki/Hades", "en"],
      ["https://en.wikipedia.org/w/index.php?title=Hades", "en"],
      ["javascript:alert(1)", "en"],
      ["/wiki/Hades", "en"],
      [42, "en"],
    ] as const) {
      expect(text.wikipediaUrlOf(url, lang), String(url)).toBeNull();
    }
  });

  test("the build cleans made-up Wikidata and Wikipedia text, logs the field and never the text, and drops an extract without its own link", async () => {
    const build = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "build.mjs")).href)) as {
      buildLibrary(inputs: { wikidata: unknown; wikipedia: unknown; exclusions: unknown }): { files: Map<string, string>; problems: string[] };
    };
    const ch = (code: number) => String.fromCharCode(code);
    const [rlo, pdi, zwsp, bom, nel, csi] = [0x202e, 0x2069, 0x200b, 0xfeff, 0x85, 0x9b].map(ch);
    const ckbTitle = "مۆڕتاڵ کۆمبات ١١";
    const wikidata = {
      asOf: "2026-11-21",
      classes: { Q7889: { parents: [] } },
      entities: { Q100: { en: `Warner Bros.${nel}Games` }, Q101: { en: `NetherRealm${csi} Studios` }, Q102: { en: `${pdi}Mortal Kombat` } },
      items: {
        Q1: madeUpItem({ slugs: ["mortal-kombat-11-switch"], labels: { en: "Mortal Kombat 11", ar: "مورتال كومبات 11", ckb: ckbTitle }, publishers: ["Q100"], developers: ["Q101"], series: ["Q102"], sitelinks: 36, wiki: { en: "Mortal Kombat 11", ar: "مورتال كومبات 11", ckb: ckbTitle } }),
        // a title the override would reverse, and a "Sorani" label that is Latin once its BOM is gone
        Q2: madeUpItem({ slugs: ["hades-switch"], labels: { en: `Ha${rlo}des`, ckb: `${bom}Hades` }, aliases: { en: [`Hades${zwsp} II`] }, sitelinks: 20, wiki: { en: "Hades (video game)" } }),
      },
    };
    const page = (lang: string, title: string, url: string, text: string) => [`${lang}:${title}`, { title, url, text, asOf: "2026-11-21" }];
    const wikipedia = Object.fromEntries([
      page("en", "Mortal Kombat 11", "http://en.wikipedia.org/wiki/Mortal_Kombat_11", "Mortal Kombat 11 is a 2019 fighting game."),
      page("ar", "مورتال كومبات 11", "https://ar.wikipedia.org.example.net/wiki/Mortal_Kombat_11", "مورتال كومبات 11 هي لعبة قتال صدرت عام 2019."),
      page("ckb", ckbTitle, "https://ckb.wikipedia.org/wiki/Mortal_Kombat_11", `${ckbTitle} یارییەکی شەڕە.${zwsp} ${rlo}لە ساڵی ٢٠١٩ بڵاوکرایەوە.`),
      page("en", "Hades (video game)", "https://en.wikipedia.org/wiki/Hades_(video_game)", "Hades is a 2020 roguelike game."),
    ]);
    const { files, problems } = build.buildLibrary({ wikidata, wikipedia, exclusions: { items: [], slugs: [] } });
    expect(problems).toEqual([]);
    const fileText = (pattern: RegExp) => [...files].find(([file]) => pattern.test(file.replace(/\\/g, "/")))?.[1] ?? "";
    const list = JSON.parse(fileText(/\/list\.[0-9a-f]{8}\.json$/)) as LibraryList;
    const detailsOf = (game: LibraryGame) => (JSON.parse(fileText(new RegExp(`/d/${list.chunks[game.chunk].replace(/\./g, "\\.")}$`))) as LibraryChunk).details[game.id];
    const [hades, kombat] = list.games;

    expect(kombat).toMatchObject({ id: "mortal-kombat-11-switch", title: "Mortal Kombat 11", titleAr: "مورتال كومبات 11", titleCkb: "مۆڕتاڵ کۆمبات 11", publishers: ["Warner Bros. Games"], aliases: ["Mortal Kombat"] });
    expect(hades).toMatchObject({ id: "hades-switch", title: "Hades", aliases: ["Hades II"] });
    expect(hades.titleCkb).toBeUndefined();
    // the quoted Wikipedia text and article title keep their own digits; the http and foreign-host links are left out
    expect(detailsOf(kombat)).toEqual({
      id: "mortal-kombat-11-switch",
      developers: ["NetherRealm Studios"],
      series: ["Mortal Kombat"],
      wikipedia: { ckb: { text: `${ckbTitle} یارییەکی شەڕە. لە ساڵی ٢٠١٩ بڵاوکرایەوە.`, title: ckbTitle, url: "https://ckb.wikipedia.org/wiki/Mortal_Kombat_11", asOf: "2026-11-21" } },
    });
    expect(detailsOf(hades).wikipedia?.en?.url).toBe("https://en.wikipedia.org/wiki/Hades_(video_game)");
    expect([...files.values()].flatMap((value) => [...value]).filter((char) => [rlo, pdi, zwsp, bom, nel, csi].includes(char))).toEqual([]);

    const log = JSON.parse(fileText(/\/selection-log\.json$/)) as { entries: LogEntry[] };
    expect(log.entries.map((entry) => `${entry.slug} ${entry.reason} ${entry.detail}`)).toEqual([
      "hades-switch text-cleaned title: invisible, bidi or control characters removed",
      "hades-switch text-cleaned titleCkb: invisible, bidi or control characters removed",
      "hades-switch text-cleaned alias 1: invisible, bidi or control characters removed",
      "mortal-kombat-11-switch text-cleaned alias 1: invisible, bidi or control characters removed",
      "mortal-kombat-11-switch text-cleaned publisher 1: invisible, bidi or control characters removed",
      "mortal-kombat-11-switch extract-left-out en: the link is not an https en.wikipedia.org/wiki/ article",
      "mortal-kombat-11-switch extract-left-out ar: the link is not an https ar.wikipedia.org/wiki/ article",
      "mortal-kombat-11-switch text-cleaned wikipedia ckb text: invisible, bidi or control characters removed",
      "mortal-kombat-11-switch text-cleaned series 1: invisible, bidi or control characters removed",
      "mortal-kombat-11-switch text-cleaned developer 1: invisible, bidi or control characters removed",
    ]);
  });

  test("the files are current and the script's keys are the shared ones", async () => {
    const mapping = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "mapping.mjs")).href)) as { GENRE_KEYS: string[]; PLAY_MODES: string[] };
    expect(mapping.GENRE_KEYS).toEqual([...GENRE_KEYS]);
    expect(mapping.PLAY_MODES).toEqual([...PLAY_MODES]);
    const output = execFileSync(process.execPath, [path.join(ROOT, "scripts", "switch-library", "build.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(output).toContain("up to date");
  }, 60_000);
});
