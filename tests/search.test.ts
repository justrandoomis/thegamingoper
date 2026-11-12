/**
 * Search service (app/server/services/search.server.ts) against a real local D1 with the demo catalogue.
 *
 * Expectations are derived from the database (names, kinds, synonym rows), never from a hard-coded product list:
 *   · typo tolerance — a misspelt word finds exactly what the right spelling finds, and says which spelling it used
 *   · synonym expansion — spellings that exist only in `search_synonyms` (not in the index) still find their concept
 *   · exact-name-first ranking — searching a product's own name puts that product first ("xbox series x")
 *   · category-aware suggestions, zero-result help, autocomplete shape, anonymous query statistics
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { L10n } from "~/lib/locales";
import { loader as suggestLoader } from "~/routes/api/search-suggest";
import { requestContextMiddleware } from "~/server/context.server";
import { normalizeSearchText, searchProductIds } from "~/server/db/search.server";
import { seedDemo } from "~/server/db/seed/demo";
import {
  baghdadDay,
  buildConcepts,
  editDistance,
  isCountableQuery,
  matchQuery,
  nameCoverage,
  queryGroups,
  recordSearchQuery,
  searchProducts,
  suggestSearch,
  suggestSearchWithTotal,
  trigramsOf,
} from "~/server/services/search.server";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const parse = (text: string | null): L10n | null => (text ? (JSON.parse(text) as L10n) : null);
const set = (values: readonly string[]) => [...new Set(values)].sort();

type ProductRow = { id: string; slug: string; kind: string; name: string; platform: string | null };
let products: ProductRow[] = [];
const enName = (row: ProductRow) => parse(row.name)?.en ?? "";

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
  products = await rows<ProductRow>(
    "SELECT p.id, p.slug, p.kind, p.name, pl.slug AS platform FROM products p LEFT JOIN platforms pl ON pl.id = p.platform_id WHERE p.status = 'published' ORDER BY p.slug",
  );
});

afterAll(async () => {
  await t?.dispose();
});

describe("pure helpers", () => {
  it("measures edits with transpositions (Damerau–Levenshtein) by code point", () => {
    expect(editDistance("playstaion", "playstation")).toBe(1);
    expect(editDistance("plyastation", "playstation")).toBe(1);
    expect(editDistance("xbox", "xbox")).toBe(0);
    expect(editDistance("بلايستشن", "بلايستيشن")).toBe(1);
    expect(editDistance("controller", "zelda", 2)).toBeGreaterThan(2);
  });

  it("lists the distinct trigrams of a word", () => {
    expect(trigramsOf("playstaion")).toEqual(["pla", "lay", "ays", "yst", "sta", "tai", "aio", "ion"]);
    expect(trigramsOf("ps")).toEqual([]);
  });

  it("merges synonym sets of different languages that share a spelling into one concept", () => {
    const { forms, concepts } = buildConcepts([
      { term: "بلايستيشن", synonyms: ["بليستيشن", "playstation"] },
      { term: "playstation", synonyms: ["ps", "sony"] },
      { term: "اكس بوكس", synonyms: ["xbox"] },
    ]);
    expect(forms.get("بليستيشن")).toBe(forms.get("sony"));
    expect(forms.get("xbox")).not.toBe(forms.get("sony"));
    expect(concepts[forms.get("ps")!]).toEqual(expect.arrayContaining(["بلايستيشن", "بليستيشن", "playstation", "ps", "sony"]));
  });

  it("reads the longest synonym phrase first", () => {
    const vocab = buildConcepts([
      { term: "ps5", synonyms: ["playstation 5"] },
      { term: "ps5 pro", synonyms: ["playstation 5 pro"] },
    ]);
    const groups = queryGroups("playstation 5 pro controller", vocab);
    expect(groups.map((group) => group.text)).toEqual(["playstation 5 pro", "controller"]);
    expect(groups[0].concept).toBe(true);
    expect(groups[0].alternatives).toEqual(expect.arrayContaining(["ps5 pro"]));
    expect(groups[1]).toEqual({ text: "controller", alternatives: ["controller"], concept: false });
  });

  it("covers query words with distinct name words (the 'x' of 'xbox series x' cannot reuse 'xbox')", () => {
    const groups = [
      { text: "xbox", alternatives: ["xbox", "x box"], concept: true },
      { text: "series", alternatives: ["series"], concept: false },
      { text: "x", alternatives: ["x"], concept: false },
    ];
    expect(nameCoverage("xbox series x", groups)).toBe(3);
    expect(nameCoverage("xbox series x25 limited edition", groups)).toBe(3);
    expect(nameCoverage("xbox series s", groups)).toBe(2);
    expect(nameCoverage("xbox wireless controller", groups)).toBe(1);
  });

  it("never counts queries that may hold personal data", () => {
    expect(isCountableQuery("ps5 pro")).toBe(true);
    expect(isCountableQuery("0770 123 4567")).toBe(false);
    expect(isCountableQuery("٠٧٧٠١٢٣٤٥٦٧")).toBe(false);
    expect(isCountableQuery("someone@example.com")).toBe(false);
    expect(isCountableQuery("x".repeat(80))).toBe(false);
    expect(isCountableQuery("   ")).toBe(false);
  });

  it("days are Baghdad days", () => {
    expect(baghdadDay(Date.UTC(2026, 10, 10, 20, 59))).toBe("2026-11-10");
    expect(baghdadDay(Date.UTC(2026, 10, 10, 21, 0))).toBe("2026-11-11");
  });
});

describe("typo tolerance (the trigram index)", () => {
  it("'playstaion' finds what 'playstation' finds and says which spelling it used", async () => {
    const right = await matchQuery(t.db, "playstation", t.now);
    expect(right.ids.length).toBeGreaterThan(0);
    expect(right.correctedQuery).toBeNull();
    const typo = await matchQuery(t.db, "playstaion", t.now);
    expect(typo.correctedQuery).toBe("playstation");
    expect(set(typo.ids)).toEqual(set(right.ids));
    // the plain index search (no correction) finds nothing for the typo — the fix is the service's
    expect(await searchProductIds(t.db, "playstaion")).toEqual([]);
  });

  it("corrects a typo inside a longer query and keeps the other words", async () => {
    const typo = await matchQuery(t.db, "xbox serise x", t.now);
    expect(typo.correctedQuery).toBe("xbox series x");
    const right = await matchQuery(t.db, "xbox series x", t.now);
    expect(set(typo.ids)).toEqual(set(right.ids));
  });

  it("corrects Arabic spellings too", async () => {
    const typo = await matchQuery(t.db, "بلايستشن", t.now);
    expect(typo.ids.length).toBeGreaterThan(0);
    expect(typo.correctedQuery).not.toBeNull();
    const playstation = products.filter((product) => product.platform === "playstation" && product.kind === "console").map((product) => product.id);
    expect(playstation.length).toBeGreaterThan(0);
    for (const id of playstation) expect(typo.ids).toContain(id);
  });

  it("does not 'correct' a query that already finds something, nor nonsense", async () => {
    expect((await matchQuery(t.db, "zelda", t.now)).correctedQuery).toBeNull();
    const nonsense = await matchQuery(t.db, "qqqzzzwww", t.now);
    expect(nonsense.ids).toEqual([]);
    expect(nonsense.correctedQuery).toBeNull();
  });
});

describe("synonym expansion (search_synonyms, ar / en / ckb)", () => {
  type SynonymRow = { locale: string; term: string; synonyms: string };

  it("finds a concept through spellings that exist only in the synonym table", async () => {
    const synonymRows = await rows<SynonymRow>("SELECT locale, term, synonyms FROM search_synonyms WHERE is_active = 1");
    expect(synonymRows.length).toBeGreaterThanOrEqual(41);
    let onlyThroughSynonyms = 0;
    const checkedLocales = new Set<string>();
    for (const row of synonymRows) {
      const termHits = await matchQuery(t.db, row.term, t.now);
      if (termHits.ids.length === 0) continue;
      for (const form of JSON.parse(row.synonyms) as string[]) {
        const plain = await searchProductIds(t.db, form, { limit: 100 });
        if (plain.length > 0) continue;
        // the index alone does not know this spelling; the service must still find the concept
        const expanded = await matchQuery(t.db, form, t.now);
        expect(expanded.ids.length, `"${form}" (${row.locale}) should find what "${row.term}" finds`).toBeGreaterThan(0);
        expect(set(expanded.ids)).toEqual(set(termHits.ids));
        onlyThroughSynonyms++;
        checkedLocales.add(row.locale);
      }
    }
    expect(onlyThroughSynonyms).toBeGreaterThan(5);
    expect(checkedLocales.size).toBeGreaterThanOrEqual(2);
  });

  it("Kurdish, Arabic and English spellings of a platform find the same products", async () => {
    const english = await matchQuery(t.db, "playstation", t.now);
    const arabic = await matchQuery(t.db, "بليستيشن", t.now);
    const kurdish = await matchQuery(t.db, "پلەیستەیشن", t.now);
    expect(english.ids.length).toBeGreaterThan(0);
    expect(set(arabic.ids)).toEqual(set(english.ids));
    expect(set(kurdish.ids)).toEqual(set(english.ids));
  });

  it("'joypad' (a synonym only) finds every controller", async () => {
    const controllers = products.filter((product) => product.kind === "controller").map((product) => product.id);
    expect(controllers.length).toBeGreaterThan(0);
    const result = await matchQuery(t.db, "joypad", t.now);
    for (const id of controllers) expect(result.ids).toContain(id);
  });
});

describe("ranking: exact names first", () => {
  it("'xbox series x' ranks the Series X first and the Series S after every Series X edition", async () => {
    const result = await searchProducts(t.db, "en", "xbox series x", { now: t.now, limit: 60 });
    const exact = products.find((product) => normalizeSearchText(enName(product)) === "xbox series x");
    const seriesS = products.find((product) => normalizeSearchText(enName(product)) === "xbox series s");
    expect(exact).toBeDefined();
    expect(seriesS).toBeDefined();
    expect(result.items[0]?.id).toBe(exact!.id);
    const order = result.items.map((card) => card.id);
    const editions = products.filter((product) => normalizeSearchText(enName(product)).startsWith("xbox series x")).map((product) => product.id);
    expect(order.indexOf(seriesS!.id)).toBeGreaterThan(-1);
    for (const id of editions) expect(order.indexOf(id)).toBeLessThan(order.indexOf(seriesS!.id));
  });

  it("searching a console's own name puts that console first", async () => {
    const consoles = products.filter((product) => product.kind === "console");
    expect(consoles.length).toBeGreaterThan(10);
    const names = new Map<string, number>();
    for (const product of consoles) names.set(normalizeSearchText(enName(product)), (names.get(normalizeSearchText(enName(product))) ?? 0) + 1);
    for (const product of consoles) {
      const name = normalizeSearchText(enName(product));
      if (names.get(name) !== 1) continue;
      const result = await searchProducts(t.db, "en", enName(product), { now: t.now });
      expect(result.items[0]?.id, `"${enName(product)}"`).toBe(product.id);
    }
  });
});

describe("searchProducts", () => {
  it("returns cards and the list's facets; filters and sorts apply to the matches", async () => {
    const all = await searchProducts(t.db, "ar", "playstation", { now: t.now, limit: 60 });
    expect(all.total).toBeGreaterThan(5);
    expect(all.items.length).toBe(Math.min(60, all.total));
    expect(all.facets.categories.length).toBeGreaterThan(0);
    const sum = all.facets.categories.reduce((n, option) => n + option.count, 0);
    expect(sum).toBe(all.total);

    const cheap = await searchProducts(t.db, "ar", "playstation", { now: t.now, sort: "price_asc", filters: { inStock: true }, limit: 60 });
    const prices = cheap.items.map((card) => card.priceIqd);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    for (const card of cheap.items) expect(["in_stock", "low_stock"]).toContain(card.stock);
  });

  it("pages through relevance results with the cursor, without repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await searchProducts(t.db, "en", "game", { now: t.now, limit: 5, cursor });
      seen.push(...page.items.map((card) => card.id));
      cursor = page.nextCursor;
      if (!cursor) {
        expect(seen.length).toBe(page.total);
        break;
      }
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(5);
  });

  it("is category-aware: names the category, platform or device the query is about", async () => {
    const headsets = await searchProducts(t.db, "ar", "سماعات", { now: t.now });
    expect(headsets.suggestions.some((jump) => jump.kind === "category" && jump.href === "/c/headsets")).toBe(true);
    const platform = await searchProducts(t.db, "en", "ps5", { now: t.now });
    expect(platform.suggestions).toContainEqual(expect.objectContaining({ kind: "platform", href: "/platform/playstation" }));
    const device = await searchProducts(t.db, "en", "xbox series s", { now: t.now });
    expect(device.suggestions).toContainEqual(expect.objectContaining({ kind: "device", href: "/device/xbox-series-s" }));
  });

  it("zero results: no match → help with picks; filters → which filter to remove", async () => {
    const none = await searchProducts(t.db, "ar", "qqqzzzwww", { now: t.now });
    expect(none.total).toBe(0);
    expect(none.zeroResultHelp?.reason).toBe("no_match");
    expect(none.zeroResultHelp!.picks.length).toBeGreaterThan(0);
    expect(none.zeroResultHelp!.picks.length).toBeLessThanOrEqual(3);
    for (const card of none.zeroResultHelp!.picks) expect(["in_stock", "low_stock"]).toContain(card.stock);

    const filtered = await searchProducts(t.db, "en", "xbox", { now: t.now, filters: { formats: ["cartridge"], arabic: "voice" } });
    expect(filtered.total).toBe(0);
    expect(filtered.zeroResultHelp?.reason).toBe("filters");
    expect(filtered.zeroResultHelp!.relax.length).toBeGreaterThan(0);
    for (const entry of filtered.zeroResultHelp!.relax) {
      const without = await searchProducts(t.db, "en", "xbox", { now: t.now, filters: entry.group === "formats" ? { arabic: "voice" } : { formats: ["cartridge"] } });
      expect(without.total).toBe(entry.count);
    }
  });

  it("zero results for two words that never meet: suggests each word alone", async () => {
    const result = await searchProducts(t.db, "en", "zelda dualsense", { now: t.now });
    expect(result.total).toBe(0);
    const partial = result.zeroResultHelp!.partial;
    expect(partial.length).toBe(2);
    for (const entry of partial) expect((await matchQuery(t.db, entry.q, t.now)).ids.length).toBe(entry.count);
  });

  it("an empty query returns an empty page and no help", async () => {
    const result = await searchProducts(t.db, "ar", "   ", { now: t.now });
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.zeroResultHelp).toBeNull();
  });
});

describe("autocomplete (suggestSearch)", () => {
  it("returns at most eight locale-less suggestions with labels, products last", async () => {
    const items = await suggestSearch(t.db, "ar", "ps5", { now: t.now });
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(8);
    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.href.startsWith("/ar")).toBe(false);
    }
    expect(items[0]).toEqual(expect.objectContaining({ kind: "platform", href: "/platform/playstation" }));
    const firstProduct = items.findIndex((item) => item.kind === "product");
    expect(firstProduct).toBeGreaterThan(-1);
    expect(items.slice(firstProduct).every((item) => item.kind === "product")).toBe(true);
    const slugs = new Set(products.map((product) => product.slug));
    for (const item of items.filter((entry) => entry.kind === "product")) expect(slugs.has(item.href.slice("/p/".length))).toBe(true);
  });

  it("offers the corrected spelling first", async () => {
    const items = await suggestSearch(t.db, "en", "playstaion", { now: t.now });
    expect(items[0]).toEqual({ kind: "correction", label: "playstation", href: "/search?q=playstation" });
  });

  it("asks for two characters", async () => {
    expect(await suggestSearch(t.db, "en", "p", { now: t.now })).toEqual([]);
  });

  it("with its total and product ids, from one match: the same rows, the count /search lists (data owner)", async () => {
    for (const [locale, q] of [["en", "playstation"], ["ar", "بلايستيشن"], ["en", "playstaion"], ["ckb", "xbox"]] as const) {
      const result = await suggestSearchWithTotal(t.db, locale, q, { now: t.now });
      expect(result.items.map(({ id: _id, ...item }) => item), q).toEqual((await suggestSearch(t.db, locale, q, { now: t.now })).map(({ id: _id, ...item }) => item));
      expect(result.productIds, q).toEqual(result.items.filter((item) => item.kind === "product").map((item) => item.id));
      expect(result.productIds.length, q).toBeGreaterThan(0);
      expect(result.total, q).toBe((await searchProducts(t.db, locale, q, { now: t.now })).total);
    }
    expect(await suggestSearchWithTotal(t.db, "en", "p", { now: t.now })).toEqual({ items: [], productIds: [], total: null });
    expect((await suggestSearchWithTotal(t.db, "en", "zzzzqqxx", { now: t.now })).total).toBe(0);
  });
});

describe("«ابحث عنها كما كتبتها»: the words as typed (asTyped)", () => {
  it("never corrects the spelling: a typo finds what the typo finds — nothing here — and says no corrected query", async () => {
    const corrected = await searchProducts(t.db, "en", "playstaion", { now: t.now });
    expect(corrected.correctedQuery).toBe("playstation");
    expect(corrected.total).toBeGreaterThan(0);
    const typed = await searchProducts(t.db, "en", "playstaion", { now: t.now, asTyped: true });
    expect(typed.correctedQuery).toBeNull();
    expect(typed.query).toBe("playstaion");
    expect(typed.total).toBe(0);
    // a query that needs no correction finds the same either way
    const plain = await searchProducts(t.db, "en", "playstation", { now: t.now });
    expect((await searchProducts(t.db, "en", "playstation", { now: t.now, asTyped: true })).total).toBe(plain.total);
  });
});

// ───────────────────────────────────────────────────────────────── GET /api/search/suggest (the route)

type SuggestRow = { label: string; href: string; hint?: string; image?: string; priceIqd?: number; kindLabel?: string };
let suggestIp = 0;

/** Runs the route behind the real request middleware (locale, rate limit, headers). */
async function suggestRoute(q: string, locale: "ar" | "en" | "ckb") {
  const request = new Request(`http://localhost:5173/api/search/suggest?${new URLSearchParams({ q, locale })}`, { headers: { "CF-Connecting-IP": `198.51.100.${(suggestIp++ % 200) + 1}` } });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  const response = (await requestContextMiddleware({ request, context, url, pattern: "/api/search/suggest", params: {} } as never, async () => {
    return (await suggestLoader({ request, context, params: {}, url, pattern: "/api/search/suggest" } as never)) as Response;
  })) as Response;
  return { status: response.status, cache: response.headers.get("Cache-Control"), body: (await response.json()) as { suggestions: SuggestRow[]; total?: number } };
}

describe("GET /api/search/suggest (the header's suggestions)", () => {
  it("keeps every row and field of the service, adds the products' picture, price and kind, and how many /search lists", async () => {
    const { status, cache, body } = await suggestRoute("playstation", "en");
    expect(status).toBe(200);
    expect(cache).toBe("public, max-age=60");
    // the same rows, in the same order, as the service (the route only adds to them)
    const items = await suggestSearch(t.db, "en", "playstation", { now: Date.now() });
    expect(body.suggestions.map((row) => row.href)).toEqual(items.map((item) => item.href));
    for (const [index, row] of body.suggestions.entries()) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.href.startsWith("/")).toBe(true);
      if (items[index].hint) expect(row.hint).toBe(items[index].hint);
    }
    const productRows = body.suggestions.filter((row) => row.href.startsWith("/p/"));
    expect(productRows.length).toBeGreaterThan(0);
    for (const row of productRows) {
      expect(row.image).toMatch(/^[a-z0-9-]+--\d+$/);
      expect(row.kindLabel?.length).toBeGreaterThan(0);
      if (row.priceIqd !== undefined) expect(Number.isSafeInteger(row.priceIqd) && row.priceIqd >= 0).toBe(true);
    }
    // «اعرض كل النتائج (42)»: exactly what the results page lists for the same words
    const page = await searchProducts(t.db, "en", "playstation", { now: Date.now() });
    expect(body.total).toBe(page.total);
    // typed rows (platform, department, device) carry no product fields
    for (const row of body.suggestions.filter((entry) => !entry.href.startsWith("/p/"))) expect(row.image ?? row.priceIqd ?? row.kindLabel).toBeUndefined();
  });

  it("a typo: the corrected spelling first, products and the total of the corrected search, in every language", async () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const { body } = await suggestRoute("playstaion", locale);
      expect(body.suggestions[0]).toEqual(expect.objectContaining({ label: "playstation", href: "/search?q=playstation" }));
      expect(body.suggestions[0].hint?.length).toBeGreaterThan(0);
      expect(body.total).toBe((await searchProducts(t.db, locale, "playstaion", { now: Date.now() })).total);
      expect(body.total).toBeGreaterThan(0);
    }
  });

  it("a synonym in Arabic finds what the English name finds", async () => {
    const arabic = await suggestRoute("بلايستيشن", "ar");
    const english = await suggestRoute("playstation", "ar");
    expect(arabic.body.total).toBe(english.body.total);
    expect(arabic.body.suggestions.some((row) => row.href === "/platform/playstation")).toBe(true);
  });

  it("nothing found: no rows and a total of 0; too short to search: no rows and no total", async () => {
    expect((await suggestRoute("zzzzqqxx", "en")).body).toEqual({ suggestions: [], total: 0 });
    expect((await suggestRoute("p", "en")).body).toEqual({ suggestions: [] });
  });

  it("a sold-out product shows no price (it would read as an offer); in stock again, it does", async () => {
    const slug = "playstation-portal";
    const levels = await rows<{ variant_id: string; location_id: string; on_hand: number }>(
      "SELECT s.variant_id, s.location_id, s.on_hand FROM stock_levels s JOIN variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id WHERE p.slug = ?",
      slug,
    );
    expect(levels.length).toBeGreaterThan(0);
    const row = async () => (await suggestRoute("PlayStation Portal", "en")).body.suggestions.find((entry) => entry.href === `/p/${slug}`);
    expect((await row())?.priceIqd).toBeGreaterThan(0);
    const set = (level: { variant_id: string; location_id: string }, onHand: number) =>
      t.d1.prepare("UPDATE stock_levels SET on_hand = ? WHERE variant_id = ? AND location_id = ?").bind(onHand, level.variant_id, level.location_id).run();
    try {
      for (const level of levels) await set(level, 0);
      const soldOut = await row();
      expect(soldOut).toBeDefined();
      expect(soldOut?.priceIqd).toBeUndefined();
      expect(soldOut?.image).toBeDefined();
    } finally {
      for (const level of levels) await set(level, level.on_hand);
    }
  });
});

describe("anonymous query statistics", () => {
  it("counts searches and zero-result searches per Baghdad day, locale and normalised query — nothing else", async () => {
    const columns = (await rows<{ name: string }>("PRAGMA table_info(search_query_stats)")).map((column) => column.name).sort();
    expect(columns).toEqual(["day", "last_at", "locale", "query", "searches", "zero_results"]);

    expect(await recordSearchQuery(t.db, { locale: "ar", q: "PlayStation  5", total: 12, now: t.now })).toBe(true);
    expect(await recordSearchQuery(t.db, { locale: "ar", q: "playstation 5", total: 0, now: t.now + 1000 })).toBe(true);
    expect(await recordSearchQuery(t.db, { locale: "en", q: "playstation 5", total: 3, now: t.now })).toBe(true);
    expect(await recordSearchQuery(t.db, { locale: "ar", q: "07701234567", total: 0, now: t.now })).toBe(false);

    const stats = await rows<{ day: string; locale: string; query: string; searches: number; zero_results: number; last_at: number }>(
      "SELECT day, locale, query, searches, zero_results, last_at FROM search_query_stats ORDER BY locale, query",
    );
    expect(stats).toEqual([
      { day: baghdadDay(t.now), locale: "ar", query: "playstation 5", searches: 2, zero_results: 1, last_at: t.now + 1000 },
      { day: baghdadDay(t.now), locale: "en", query: "playstation 5", searches: 1, zero_results: 0, last_at: t.now },
    ]);
  });
});
