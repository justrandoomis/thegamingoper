/**
 * Switch bundle builder — the open game library's static files (docs/switch-builder.md §4.1), as
 * scripts/switch-library/build.mjs writes them from the committed snapshots in catalog/switch-library/:
 *
 *   · the manifest names a list file that exists; the list and every chunk match LibraryList / LibraryChunk (zod)
 *   · ids are unique Nintendo US store slugs of Switch 1 products (ending in "-switch"), and every game's details
 *     sit in the chunk it names
 *   · no URL anywhere points at a Nintendo or Metacritic host (contract §1.2); Wikipedia URLs are on the en / ar /
 *     ckb wikis and every extract carries its title, link and date (contract §1.3)
 *   · nothing the build ships holds a word contract §1.1 keeps out of the store
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
import { GENRE_KEYS, PLAY_MODES, type GameDetails, type LibraryGame } from "~/lib/switch-builder/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const CHUNK_DIR = path.join(PUBLIC, "library", "switch", "d");
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

  test("the files are current and the script's keys are the shared ones", async () => {
    const mapping = (await import(pathToFileURL(path.join(ROOT, "scripts", "switch-library", "lib", "mapping.mjs")).href)) as { GENRE_KEYS: string[]; PLAY_MODES: string[] };
    expect(mapping.GENRE_KEYS).toEqual([...GENRE_KEYS]);
    expect(mapping.PLAY_MODES).toEqual([...PLAY_MODES]);
    const output = execFileSync(process.execPath, [path.join(ROOT, "scripts", "switch-library", "build.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(output).toContain("up to date");
  }, 60_000);
});
