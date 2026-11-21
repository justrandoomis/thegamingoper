/**
 * The Switch bundle builder's page (docs/switch-builder.md §6.1–6.4, §6.8): the game search (Arabic folding, the
 * shoppers' spellings), the library's filters and sorts (games TamTam has a size for come first in every sort), the
 * plan's codec and fit rules (exact bytes, refusals that say why), and the server render of every step in ar / en /
 * ckb with the guide's targets in place. Pure modules and React's server renderer only — no database, no network.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { listNamespaces, messagesFor } from "~/i18n/i18n.server";
import { LOCALE_CODES, LOCALES, localePath, type Locale } from "~/lib/locales";
import {
  addGame,
  biggerCardExists,
  cardThatFits,
  decodePlan,
  defaultFormat,
  defaultPlan,
  encodePlan,
  isGameId,
  planUsage,
  prunePlan,
  readPlan,
  reconcilePlan,
  remainingWithout,
  removeGame,
  setCard,
  setDevice,
  setGameFormat,
  toggleGame,
} from "~/lib/switch-builder/plan";
import { gameSearchKey, matchTier, normalizeSearchText, searchTerms } from "~/lib/switch-builder/search";
import { bytesFromGiB, capacityOf, DEFAULT_CAPACITY, GIB } from "~/lib/switch-builder/storage";
import type { BuilderCatalog, BuilderPlan, BuilderQuote, CatalogOption, LibraryExtras, LibraryGame } from "~/lib/switch-builder/types";
import { PLAN_LIMITS } from "~/lib/switch-builder/types";
import { normalizeSearchText as serverNormalize } from "~/server/db/search.server";
import { AddAllKey, cartItemsOf } from "~/routes/storefront/builder/components/AddAllKey";
import { BuilderPage } from "~/routes/storefront/builder/components/BuilderPage";
import { keepDashes, soldModels } from "~/routes/storefront/builder/components/DeviceStep";
import { FILTER_MODES } from "~/routes/storefront/builder/components/FiltersSheet";
import { initialsOf } from "~/routes/storefront/builder/components/GameCard";
import { shortfallText } from "~/routes/storefront/builder/lib/format";
import { cardPlannableBytes } from "~/routes/storefront/builder/components/MemoryStep";
import { eshopPricesAsOf, ReviewStep } from "~/routes/storefront/builder/components/ReviewStep";
import { meterShares, meterTone } from "~/routes/storefront/builder/components/SpaceMeter";
import { LIBRARY_LIST_FILE } from "~/routes/storefront/builder/library.manifest";
import { countsFor, mergeLibrary, NO_FILTERS, sortsFor, viewLibrary, type LibraryEntry, type LibraryView } from "~/routes/storefront/builder/lib/library";
import { stepHref, stepOf, stepOrder } from "~/routes/storefront/builder/lib/steps";
import { libraryListUrl, readLibrary } from "~/routes/storefront/builder/lib/use-library";

const GB = (value: number) => bytesFromGiB(value);

// ───────────────────────────────────────────────────────────────── fixtures

function game(id: string, extra: Partial<LibraryGame> = {}): LibraryGame {
  return { id, qid: `Q${id.length}`, title: id, publishers: [], genres: [], modes: [], popularity: 0, chunk: 0, ...extra };
}

const GAMES: LibraryGame[] = [
  game("the-legend-of-zelda-breath-of-the-wild-switch", {
    title: "The Legend of Zelda: Breath of the Wild",
    titleAr: "أسطورة زيلدا: نفس البرية",
    year: 2017,
    released: "2017-03-03",
    publishers: ["Nintendo"],
    genres: ["adventure", "action"],
    modes: ["single"],
    popularity: 120,
    aliases: ["The Legend of Zelda", "BotW"],
  }),
  game("mario-kart-8-deluxe-switch", { title: "Mario Kart 8 Deluxe", year: 2017, released: "2017-04-28", publishers: ["Nintendo"], genres: ["racing"], modes: ["single", "multi", "online"], popularity: 90 }),
  game("hades-switch", { title: "Hades", year: 2020, released: "2020-09-17", publishers: ["Supergiant Games"], genres: ["action", "rpg"], modes: ["single"], popularity: 70 }),
  game("stardew-valley-switch", { title: "Stardew Valley", year: 2017, publishers: ["ConcernedApe"], genres: ["simulation", "rpg"], modes: ["single", "multi", "coop", "online"], popularity: 60 }),
  game("pokemon-scarlet-switch", { title: "Pokémon Scarlet", year: 2022, released: "2022-11-18", publishers: ["Nintendo", "The Pokémon Company"], genres: ["rpg"], modes: ["single", "online"], popularity: 100 }),
  game("tetris-99-switch", { title: "Tetris 99", year: 2019, publishers: ["Nintendo"], genres: ["puzzle"], modes: ["online"], popularity: 40 }),
  game("delisted-game-switch", { title: "Delisted Game", year: 2018, popularity: 500 }),
  game("Bad_Id", { title: "Bad id", popularity: 1000 }),
];

const EXTRAS: Record<string, LibraryExtras> = {
  "the-legend-of-zelda-breath-of-the-wild-switch": { sizeBytes: GB(16.5), cartridgeBytes: GB(0.8), priceUsdCents: 5999, metacritic: { score: 97, reviews: 109, asOf: "2026-11-01" } },
  "mario-kart-8-deluxe-switch": { sizeBytes: GB(7.2), priceUsdCents: 5999 },
  "hades-switch": { sizeBytes: GB(6.4), priceUsdCents: 2499 },
  "tetris-99-switch": { sizeBytes: GB(0.4) },
  "delisted-game-switch": { sizeBytes: GB(3), hidden: true },
};

function option(variantId: string, extra: Partial<CatalogOption> = {}): CatalogOption {
  return { variantId, productSlug: variantId, name: variantId, priceIqd: 100_000, orderable: true, ...extra };
}

const CATALOG: BuilderCatalog = {
  devices: {
    "switch-oled": {
      productSlug: "nintendo-switch-oled",
      name: "Nintendo Switch – OLED Model",
      art: "nintendo-switch-oled--1",
      variants: [
        option("var_nsw-oled-wht", { name: "Nintendo Switch – OLED Model", variantTitle: "White", priceIqd: 585_000, orderable: false, reason: "out_of_stock" }),
        option("var_nsw-oled-neon", { name: "Nintendo Switch – OLED Model", variantTitle: "Neon", priceIqd: 550_000 }),
      ],
    },
    switch: null,
    "switch-lite": null,
  },
  cards: { 1000: option("var_sandisk-ultra-1tb", { name: "SanDisk Ultra", variantTitle: "1TB", priceIqd: 175_000 }), 256: option("var_sandisk-extreme-256", { priceIqd: 0, orderable: false, reason: "unavailable" }) },
  cartridges: { "the-legend-of-zelda-breath-of-the-wild-switch": option("var_nsg-zelda-botw", { name: "The Legend of Zelda: Breath of the Wild", priceIqd: 90_000, art: "the-legend-of-zelda-breath-of-the-wild--1" }) },
  eshop: { sold: false, denominations: [] },
};

const NO_CATALOG: BuilderCatalog = { devices: { "switch-oled": null, switch: null, "switch-lite": null }, cards: {}, cartridges: {}, eshop: { sold: false, denominations: [] } };

const ENTRIES = mergeLibrary(GAMES, EXTRAS, CATALOG.cartridges);
const ids = (entries: readonly LibraryEntry[]) => entries.map((entry) => entry.game.id);
const view = (change: Partial<LibraryView> = {}): LibraryView => ({ query: "", filters: NO_FILTERS, sort: "popular", remainingBytes: GB(1000), chosen: new Map(), ...change });

// ───────────────────────────────────────────────────────────────── search

describe("the game search folds Arabic and Sorani the way the store's product search does", () => {
  it("normalizeSearchText is a faithful port of the server's (same output for every sample)", () => {
    const samples = [
      "أسطورة زيلدا: نفس البرية",
      "إكس بوكس",
      "آلة",
      "مدرسة",
      "مستشفى",
      "ماریۆ کارت",
      "یاریی کۆمەڵ",
      "سؤال",
      "ٱلرحمن",
      "حـــلو",
      "مَارِيُو",
      "Pokémon Scarlet™",
      "FIFA ٢٣ — ۲۴",
      "Hades​‏⁨x⁩",
      "  Mario   Kart 8 Deluxe!  ",
      "",
    ];
    for (const sample of samples) expect(normalizeSearchText(sample), sample).toBe(serverNormalize(sample));
  });

  it("folds hamza forms, teh marbuta, alef maqsura, Kurdish letters, tashkeel, tatweel and Arabic-Indic digits", () => {
    expect(normalizeSearchText("أسطورة زيلدا")).toBe("اسطوره زيلدا");
    expect(normalizeSearchText("إنمي")).toBe("انمي");
    expect(normalizeSearchText("مصطفى")).toBe("مصطفي");
    expect(normalizeSearchText("مَارِيُو")).toBe("ماريو");
    expect(normalizeSearchText("حـــلو")).toBe("حلو");
    expect(normalizeSearchText("ماریۆ کارت")).toBe("ماريۆ كارت");
    expect(normalizeSearchText("فيفا ٢٣")).toBe("فيفا 23");
    expect(normalizeSearchText("Pokémon")).toBe("pokemon");
  });

  it("reads the shoppers' Arabic spellings of the big series as the Latin titles, an article in front, and a word still being typed", () => {
    expect(searchTerms("ماريو")[0].forms).toContain("mario");
    expect(searchTerms("الزيلدا")[0].forms).toEqual(expect.arrayContaining(["زيلدا", "zelda"]));
    expect(searchTerms("بوكي")[0].forms).toContain("pokemon");
    const donkey = searchTerms("دونكي كونغ");
    expect(donkey).toHaveLength(2);
    expect(donkey[0].forms).toContain("donkey");
    expect(donkey[1].forms).toContain("kong");
    expect(searchTerms("ماين كرافت")).toEqual([{ forms: expect.arrayContaining(["minecraft"]) }]);
    expect(searchTerms("  ")).toEqual([]);
    expect(searchTerms("a b c d e f g h i j k")).toHaveLength(8);
  });

  it("ranks a match in a title above one in the aliases or publishers, and inside a word last", () => {
    const zelda = gameSearchKey(GAMES[0]);
    expect(matchTier(searchTerms("zelda"), zelda)).toBe(0);
    expect(matchTier(searchTerms("زيلدا"), zelda)).toBe(0);
    expect(matchTier(searchTerms("اسطورة"), zelda)).toBe(0);
    expect(matchTier(searchTerms("botw"), zelda)).toBe(1);
    expect(matchTier(searchTerms("nintendo"), zelda)).toBe(1);
    expect(matchTier(searchTerms("reath"), zelda)).toBe(2);
    expect(matchTier(searchTerms("zelda kart"), zelda)).toBeNull();
    expect(matchTier([], zelda)).toBe(0);
    // a two-letter fragment is never looked for inside a word ("ar" would match half the list)
    expect(matchTier(searchTerms("ar"), gameSearchKey(GAMES[1]))).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── the list: merge, filters, sorts

describe("the library: hidden games out, filters, sorts — games TamTam has a size for first in every sort", () => {
  it("merges TamTam's data and the cartridges, and leaves out hidden games and ids a plan could not hold", () => {
    expect(ids(ENTRIES)).not.toContain("delisted-game-switch");
    expect(ids(ENTRIES)).not.toContain("Bad_Id");
    expect(isGameId("Bad_Id")).toBe(false);
    const zelda = ENTRIES.find((entry) => entry.game.id === "the-legend-of-zelda-breath-of-the-wild-switch")!;
    expect(zelda.cartridge?.variantId).toBe("var_nsg-zelda-botw");
    expect(zelda.format).toBe("cartridge");
    expect(ENTRIES.find((entry) => entry.game.id === "hades-switch")!.format).toBe("digital");
  });

  it("popular: sized games by popularity, then the unsized ones", () => {
    expect(ids(viewLibrary(ENTRIES, view()))).toEqual([
      "the-legend-of-zelda-breath-of-the-wild-switch",
      "mario-kart-8-deluxe-switch",
      "hades-switch",
      "tetris-99-switch",
      "pokemon-scarlet-switch",
      "stardew-valley-switch",
    ]);
  });

  it("newest, A–Z, smallest, cheapest and score keep the sized games first", () => {
    expect(ids(viewLibrary(ENTRIES, view({ sort: "newest" })))).toEqual([
      "hades-switch",
      "tetris-99-switch",
      "mario-kart-8-deluxe-switch",
      "the-legend-of-zelda-breath-of-the-wild-switch",
      "pokemon-scarlet-switch",
      "stardew-valley-switch",
    ]);
    expect(ids(viewLibrary(ENTRIES, view({ sort: "az" })))).toEqual([
      "hades-switch",
      "mario-kart-8-deluxe-switch",
      "tetris-99-switch",
      "the-legend-of-zelda-breath-of-the-wild-switch",
      "pokemon-scarlet-switch",
      "stardew-valley-switch",
    ]);
    // Zelda counts as its cartridge (0.8 GB): the space it needs as it would be chosen
    expect(ids(viewLibrary(ENTRIES, view({ sort: "smallest" }))).slice(0, 4)).toEqual(["tetris-99-switch", "the-legend-of-zelda-breath-of-the-wild-switch", "hades-switch", "mario-kart-8-deluxe-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ sort: "cheapest" }))).slice(0, 4)).toEqual(["hades-switch", "the-legend-of-zelda-breath-of-the-wild-switch", "mario-kart-8-deluxe-switch", "tetris-99-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ sort: "score" })))[0]).toBe("the-legend-of-zelda-breath-of-the-wild-switch");
  });

  it("offers the score sort only when TamTam has entered a licensed score", () => {
    expect(sortsFor(ENTRIES)).toContain("score");
    const unscored = mergeLibrary(GAMES, { ...EXTRAS, "the-legend-of-zelda-breath-of-the-wild-switch": { sizeBytes: GB(16.5) } }, {});
    expect(sortsFor(unscored)).not.toContain("score");
  });

  it("filters: any of the chosen genres or modes, one size band, one price band, fits, cartridge, size added", () => {
    expect(ids(viewLibrary(ENTRIES, view({ filters: { ...NO_FILTERS, genres: ["racing", "puzzle"] } })))).toEqual(["mario-kart-8-deluxe-switch", "tetris-99-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ filters: { ...NO_FILTERS, modes: ["coop"] } })))).toEqual(["stardew-valley-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ filters: { ...NO_FILTERS, size: "upTo2" } })))).toEqual(["the-legend-of-zelda-breath-of-the-wild-switch", "tetris-99-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ filters: { ...NO_FILTERS, size: "2to8" } })))).toEqual(["mario-kart-8-deluxe-switch", "hades-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ filters: { ...NO_FILTERS, price: "10to30" } })))).toEqual(["hades-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ filters: { ...NO_FILTERS, price: "over50" } })))).toEqual(["the-legend-of-zelda-breath-of-the-wild-switch", "mario-kart-8-deluxe-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ filters: { ...NO_FILTERS, cartridge: true } })))).toEqual(["the-legend-of-zelda-breath-of-the-wild-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ filters: { ...NO_FILTERS, sized: true } })))).toHaveLength(4);
    // 7 GB left: Mario Kart (7.2) no longer fits; a chosen game always stays
    const fits = viewLibrary(ENTRIES, view({ remainingBytes: GB(7), filters: { ...NO_FILTERS, fits: true } }));
    expect(ids(fits)).toEqual(["the-legend-of-zelda-breath-of-the-wild-switch", "hades-switch", "tetris-99-switch"]);
    const chosen = viewLibrary(ENTRIES, view({ remainingBytes: GB(7), filters: { ...NO_FILTERS, fits: true }, chosen: new Map([["mario-kart-8-deluxe-switch", "digital"]]) }));
    expect(ids(chosen)).toContain("mario-kart-8-deluxe-switch");
  });

  it("the search narrows, keeps sized games first, then the better match", () => {
    expect(ids(viewLibrary(ENTRIES, view({ query: "زيلدا" })))).toEqual(["the-legend-of-zelda-breath-of-the-wild-switch"]);
    expect(ids(viewLibrary(ENTRIES, view({ query: "ماريو" })))).toEqual(["mario-kart-8-deluxe-switch"]);
    // "nintendo" is a publisher of four games: the sized ones first, by popularity
    expect(ids(viewLibrary(ENTRIES, view({ query: "nintendo" })))).toEqual(["the-legend-of-zelda-breath-of-the-wild-switch", "mario-kart-8-deluxe-switch", "tetris-99-switch", "pokemon-scarlet-switch"]);
    expect(viewLibrary(ENTRIES, view({ query: "no such game" }))).toEqual([]);
  });

  it("counts each genre with the other filters as they are", () => {
    const counts = countsFor(ENTRIES, view({ filters: { ...NO_FILTERS, genres: ["racing"], modes: ["single"] } }), "genres");
    expect(counts.get("rpg")).toBe(3);
    expect(counts.get("racing")).toBe(1);
    expect(counts.get("puzzle")).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────── the plan

describe("the plan: default, codec, reconciliation", () => {
  it("starts with the first model TamTam sells, its first orderable colour, to buy; else the shopper's own OLED", () => {
    expect(defaultPlan(CATALOG)).toEqual({ v: 1, device: { model: "switch-oled", owned: false, variantId: "var_nsw-oled-neon" }, card: { sizeGB: 0, owned: false }, games: [] });
    expect(defaultPlan(NO_CATALOG)).toEqual({ v: 1, device: { model: "switch-oled", owned: true }, card: { sizeGB: 0, owned: false }, games: [] });
    expect(soldModels(CATALOG)).toEqual(["switch-oled"]);
  });

  it("round-trips through localStorage text and refuses anything that is not a plan of this version", () => {
    const plan: BuilderPlan = { v: 1, device: { model: "switch", owned: true }, card: { sizeGB: 256, owned: false, variantId: "var_sandisk-extreme-256" }, games: [{ id: "hades-switch", format: "digital" }] };
    expect(decodePlan(encodePlan(plan))).toEqual(plan);
    expect(decodePlan(null)).toBeNull();
    expect(decodePlan("not json")).toBeNull();
    expect(decodePlan(JSON.stringify({ ...plan, v: 2 }))).toBeNull();
    expect(decodePlan(JSON.stringify({ ...plan, device: { model: "switch-2", owned: true } }))).toBeNull();
    expect(decodePlan(JSON.stringify({ ...plan, card: { sizeGB: 2000, owned: false } }))).toBeNull();
  });

  it("drops a repeated game, a malformed one, an owned part's variant, and keeps at most PLAN_LIMITS.maxGames", () => {
    const many = Array.from({ length: PLAN_LIMITS.maxGames + 10 }, (_, index) => ({ id: `game-${index}-switch`, format: "digital" }));
    const read = readPlan({
      v: 1,
      device: { model: "switch-oled", owned: true, variantId: "var_nsw-oled-neon" },
      card: { sizeGB: 0, owned: true, variantId: "x" },
      games: [{ id: "hades-switch", format: "digital" }, { id: "hades-switch", format: "cartridge" }, { id: "Bad Id", format: "digital" }, { id: "tetris-99-switch", format: "box" }, ...many],
    });
    expect(read?.device).toEqual({ model: "switch-oled", owned: true });
    expect(read?.card).toEqual({ sizeGB: 0, owned: false });
    expect(read?.games[0]).toEqual({ id: "hades-switch", format: "digital" });
    expect(read?.games).toHaveLength(PLAN_LIMITS.maxGames);
  });

  it("checks a restored plan against what the store sells now", () => {
    const stale: BuilderPlan = {
      v: 1,
      device: { model: "switch-oled", owned: false, variantId: "var_gone" },
      card: { sizeGB: 1000, owned: false, variantId: "var_old-card" },
      games: [{ id: "hades-switch", format: "cartridge" }, { id: "the-legend-of-zelda-breath-of-the-wild-switch", format: "cartridge" }],
    };
    const next = reconcilePlan(stale, CATALOG);
    expect(next.device).toEqual({ model: "switch-oled", owned: false, variantId: "var_nsw-oled-neon" });
    expect(next.card).toEqual({ sizeGB: 1000, owned: false, variantId: "var_sandisk-ultra-1tb" });
    expect(next.games).toEqual([{ id: "hades-switch", format: "digital" }, { id: "the-legend-of-zelda-breath-of-the-wild-switch", format: "cartridge" }]);
    expect(reconcilePlan(next, CATALOG)).toBe(next);
    expect(reconcilePlan({ ...stale, device: { model: "switch", owned: false, variantId: "x" } }, CATALOG).device).toEqual({ model: "switch", owned: false });
  });

  it("chooses TamTam's cartridge by default only when it can be ordered now", () => {
    expect(defaultFormat("the-legend-of-zelda-breath-of-the-wild-switch", CATALOG.cartridges)).toBe("cartridge");
    expect(defaultFormat("the-legend-of-zelda-breath-of-the-wild-switch", { "the-legend-of-zelda-breath-of-the-wild-switch": option("x", { orderable: false }) })).toBe("digital");
    expect(defaultFormat("hades-switch", CATALOG.cartridges)).toBe("digital");
  });
});

describe("the plan: fit rules on exact bytes", () => {
  const base: BuilderPlan = { v: 1, device: { model: "switch-oled", owned: true }, card: { sizeGB: 0, owned: false }, games: [] };
  const plannable = capacityOf("switch-oled", 0).plannableBytes; // 52.0 GB of system memory for games

  it("adds a game that fits and removes it on a second tap", () => {
    const added = toggleGame(base, "hades-switch", "digital", EXTRAS);
    expect(added).toMatchObject({ ok: true, change: "added" });
    if (!added.ok) return;
    expect(planUsage(added.plan, EXTRAS).usage.usedBytes).toBe(GB(6.4));
    const removed = toggleGame(added.plan, "hades-switch", "digital", EXTRAS);
    expect(removed).toMatchObject({ ok: true, change: "removed" });
    if (removed.ok) expect(removed.plan.games).toEqual([]);
  });

  it("refuses a game without a size, and a game that does not fit with both figures", () => {
    expect(toggleGame(base, "pokemon-scarlet-switch", "digital", EXTRAS)).toEqual({ ok: false, reason: "no_size" });
    const big = { "huge-game-switch": { sizeBytes: plannable + 1 } };
    expect(addGame(base, "huge-game-switch", "digital", big)).toEqual({ ok: false, reason: "no_room", needBytes: plannable + 1, leftBytes: plannable });
    // exactly what is left fits; one byte more does not
    expect(addGame(base, "huge-game-switch", "digital", { "huge-game-switch": { sizeBytes: plannable } })).toMatchObject({ ok: true });
  });

  it("a 256GB card does not hold 256 GB of games: a Switch with one plans 250.7 GB, so a fifth 60 GB game is refused", () => {
    const switchPlan: BuilderPlan = { ...base, device: { model: "switch", owned: true }, card: { sizeGB: 256, owned: true } };
    const space = planUsage(switchPlan, {}).capacity.plannableBytes;
    // system memory 25.9 − 2.0 kept, plus the card's 234.8 usable − 8.0 kept free for updates (storage.ts)
    expect(space / GIB).toBeCloseTo(23.9 + 226.84, 1);
    const extras = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`big-${index}-switch`, { sizeBytes: GB(60) }]));
    let plan = switchPlan;
    for (let index = 0; index < 4; index++) {
      const result = addGame(plan, `big-${index}-switch`, "digital", extras);
      expect(result.ok).toBe(true);
      if (result.ok) plan = result.plan;
    }
    const fifth = addGame(plan, "big-4-switch", "digital", extras);
    expect(fifth).toEqual({ ok: false, reason: "no_room", needBytes: GB(60), leftBytes: space - GB(240) });
    // the smallest bigger card that makes room is what «بطاقة أكبر» offers
    expect(cardThatFits(plan, GB(60), extras)).toBe(512);
  });

  it("a cartridge needs only its update data; going digital is refused when the full size does not fit", () => {
    const tight: BuilderPlan = { ...base, games: [] };
    const extras = { ...EXTRAS, "filler-switch": { sizeBytes: plannable - GB(10) } };
    const withFiller = addGame(tight, "filler-switch", "digital", extras);
    expect(withFiller.ok).toBe(true);
    if (!withFiller.ok) return;
    const cartridge = addGame(withFiller.plan, "the-legend-of-zelda-breath-of-the-wild-switch", "cartridge", extras);
    expect(cartridge.ok).toBe(true);
    if (!cartridge.ok) return;
    expect(remainingWithout(cartridge.plan, "the-legend-of-zelda-breath-of-the-wild-switch", extras)).toBe(GB(10));
    expect(setGameFormat(cartridge.plan, "the-legend-of-zelda-breath-of-the-wild-switch", "digital", extras)).toMatchObject({ ok: false, reason: "no_room", needBytes: GB(16.5) });
  });

  it("refuses a game beyond PLAN_LIMITS.maxGames", () => {
    const extras = Object.fromEntries(Array.from({ length: PLAN_LIMITS.maxGames + 1 }, (_, index) => [`tiny-${index}-switch`, { sizeBytes: 1000 }]));
    const full: BuilderPlan = { ...base, games: Array.from({ length: PLAN_LIMITS.maxGames }, (_, index) => ({ id: `tiny-${index}-switch`, format: "digital" as const })) };
    expect(addGame(full, `tiny-${PLAN_LIMITS.maxGames}-switch`, "digital", extras)).toEqual({ ok: false, reason: "limit" });
  });

  it("a smaller card keeps the games and says how far over the plan is", () => {
    const extras = { "game-a-switch": { sizeBytes: GB(100) } };
    const big = addGame({ ...base, card: { sizeGB: 256, owned: true } }, "game-a-switch", "digital", extras);
    expect(big.ok).toBe(true);
    if (!big.ok) return;
    const small = setCard(big.plan, { sizeGB: 0, owned: false });
    expect(small.games).toHaveLength(1);
    const { usage } = planUsage(small, extras);
    expect(usage.overBytes).toBe(GB(100) - plannable);
    expect(usage.remainingBytes).toBe(0);
    expect(biggerCardExists(small)).toBe(true);
    expect(biggerCardExists(setCard(small, { sizeGB: 1000, owned: true }))).toBe(false);
  });

  it("owning a console or a card drops its variant; prunes games the list no longer has", () => {
    expect(setDevice(base, { model: "switch-lite", owned: true, variantId: "x" }).device).toEqual({ model: "switch-lite", owned: true });
    expect(setCard(base, { sizeGB: 128, owned: true, variantId: "x" }).card).toEqual({ sizeGB: 128, owned: true });
    expect(setCard(base, { sizeGB: 0, owned: true }).card).toEqual({ sizeGB: 0, owned: false });
    const plan: BuilderPlan = { ...base, games: [{ id: "hades-switch", format: "digital" }, { id: "gone-switch", format: "digital" }] };
    expect(prunePlan(plan, (entry) => entry.id !== "gone-switch").games).toEqual([{ id: "hades-switch", format: "digital" }]);
    expect(prunePlan(plan, () => true)).toBe(plan);
    expect(removeGame(plan, "nope-switch")).toBe(plan);
  });
});

// ───────────────────────────────────────────────────────────────── small pure parts of the page

describe("the page's small parts", () => {
  it("steps are addresses, ordered for the sideways push", () => {
    expect(stepOf("")).toBe("device");
    expect(stepOf("?step=games")).toBe("games");
    expect(stepOf("?step=nope")).toBe("device");
    expect(stepHref("device")).toBe("/build/switch");
    expect(stepHref("review")).toBe("/build/switch?step=review");
    expect([stepOrder(""), stepOrder("?step=memory"), stepOrder("?step=games"), stepOrder("?step=review")]).toEqual([0, 10, 20, 30]);
  });

  it("the space bar's colour and shares: ink, --warn from 90 % used, --danger over", () => {
    const capacity = capacityOf("switch-oled", 256);
    const at = (used: number) => ({ capacity, usage: { usedBytes: used, plannableBytes: capacity.plannableBytes, remainingBytes: Math.max(0, capacity.plannableBytes - used), overBytes: Math.max(0, used - capacity.plannableBytes) } });
    expect(meterTone(at(0))).toBe("ok");
    expect(meterTone(at(Math.ceil(capacity.plannableBytes * 0.9)))).toBe("warn");
    expect(meterTone(at(capacity.plannableBytes + 1))).toBe("over");
    const shares = meterShares(at(capacity.plannableBytes));
    expect(shares.used + shares.kept).toBeCloseTo(1, 6);
  });

  it("each card's space for games is its usable space less what is kept free for updates (storage.ts)", () => {
    for (const size of [64, 128, 256, 512, 1000] as const) {
      expect(cardPlannableBytes(size, DEFAULT_CAPACITY), String(size)).toBe(capacityOf("switch-oled", size).plannableBytes - capacityOf("switch-oled", 0).plannableBytes);
    }
    // the contract's figures for the small cards (5 % kept free, at least 2 GB)
    expect(cardPlannableBytes(64, DEFAULT_CAPACITY) / GIB).toBeCloseTo(55.8, 1);
    expect(cardPlannableBytes(128, DEFAULT_CAPACITY) / GIB).toBeCloseTo(111.5, 0);
  });

  it("typographic tiles take the title's first two significant words; console names keep their dash on the first line", () => {
    expect(initialsOf("The Legend of Zelda: Breath of the Wild")).toBe("LZ");
    expect(initialsOf("Hades")).toBe("H");
    expect(initialsOf("Mario Kart 8 Deluxe")).toBe("MK");
    expect(initialsOf("!!!")).toBe("?");
    expect(keepDashes("Nintendo Switch – OLED Model")).toBe("Nintendo Switch – OLED Model");
  });

  it("a shortfall is rounded up and never reads 0.0 GB; the sparse «online» mode is not offered as a filter", () => {
    const f = { number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat("en", options).format(value) };
    const plain = (text: string) => text.replace(/[⁦-⁩]/g, "").replace(/ /g, " ");
    expect(plain(shortfallText(f, GB(4.01)))).toBe("4.1 GB");
    expect(plain(shortfallText(f, GB(0.04)))).toBe("0.04 GB");
    expect(plain(shortfallText(f, 1000))).toBe("0.01 GB");
    expect(FILTER_MODES).toEqual(["single", "multi", "coop"]);
  });

  it("the cart gets the quote's orderable lines, one item per variant", () => {
    const line = (variantId: string, qty: number, orderable = true) => ({ kind: "eshop" as const, variantId, productSlug: "x", qty, name: "x", unitPriceIqd: 1000, orderable });
    expect(cartItemsOf([line("a", 1), line("b", 2), line("a", 1), line("c", 1, false)])).toEqual([
      { variantId: "a", qty: 2 },
      { variantId: "b", qty: 2 },
    ]);
  });

  it("reads the list file's address from the manifest and refuses answers of another shape", () => {
    expect(libraryListUrl(null)).toBeNull();
    expect(libraryListUrl("list.abcd1234.json")).toBe("/library/switch/list.abcd1234.json");
    expect(libraryListUrl("/library/switch/list.abcd1234.json")).toBe("/library/switch/list.abcd1234.json");
    expect(() => readLibrary({ version: 2, games: [], chunks: [] }, { extras: {} })).toThrow();
    expect(() => readLibrary({ version: 1, games: [], chunks: [] }, null)).toThrow();
    const read = readLibrary({ version: 1, asOf: "2026-11-21", chunks: [], games: [{ id: "hades-switch", title: "Hades" }, { nope: true }] }, { rev: "1", extras: {}, capacity: { cardMargin: 5 } });
    expect(read.list.games).toEqual([{ id: "hades-switch", title: "Hades", publishers: [], genres: [], modes: [], popularity: 0 }]);
    expect(read.payload.capacity.cardMargin).toBe(DEFAULT_CAPACITY.cardMargin);
  });

  it("a game's malformed field is left out instead of breaking the page's search while it renders (review)", () => {
    const read = readLibrary(
      { version: 1, chunks: [], games: [{ id: "hades-switch", title: "Hades", titleAr: 7, aliases: "Hades II", publishers: ["Supergiant Games", null] }] },
      { rev: "1", extras: {} },
    );
    const [hades] = read.list.games;
    expect(hades.titleAr).toBeUndefined();
    expect(hades.aliases).toEqual([]);
    expect(hades.publishers).toEqual(["Supergiant Games"]);
    expect(() => mergeLibrary(read.list.games, {}, {})).not.toThrow();
    expect(ids(viewLibrary(mergeLibrary(read.list.games, {}, {}), view({ query: "supergiant" })))).toEqual(["hades-switch"]);
  });

  it("a quote request that never reached the store comes back as an answer, never the error page (the route's clientAction)", async () => {
    // Found by the review: one dropped quote request put «لا يوجد اتصال بالإنترنت» (the error boundary) in place of the
    // whole builder — a fetcher's failed action goes to the route's boundary.
    const route = (await import("~/routes/storefront/builder/switch-builder")) as { clientAction?: (args: unknown) => Promise<unknown> };
    expect(typeof route.clientAction).toBe("function");
    const clientAction = route.clientAction as (args: unknown) => Promise<unknown>;
    const request = new Request("http://localhost/build/switch?step=review", { method: "POST", body: new URLSearchParams({ intent: "quote", plan: "{}" }) });
    for (const failure of [new TypeError("Failed to fetch"), new Response("blocked", { status: 403 })]) {
      await expect(clientAction({ request, params: {}, serverAction: () => Promise.reject(failure) })).resolves.toMatchObject({ ok: false, code: "network" });
    }
    // the store's own answers pass through as they came
    const answer = { ok: false, code: "invalid_plan" };
    await expect(clientAction({ request, params: {}, serverAction: () => Promise.resolve(answer) })).resolves.toEqual(answer);
  });
});

// ───────────────────────────────────────────────────────────────── the server render of every step

describe("every step renders on the server, in every language, with the guide's targets", () => {
  const uiNamespaces = listNamespaces().filter((name) => name === "ui" || name.startsWith("ui-"));
  const render = (locale: Locale, search: string, catalog: BuilderCatalog = CATALOG, page: () => ReactElement = () => createElement(BuilderPage, { catalog })) => {
    const path = `${localePath("/build/switch", locale)}${search}`;
    const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "*", Component: page }] }]);
    return renderToStaticMarkup(
      createElement(Stub, {
        initialEntries: [path],
        hydrationData: {
          loaderData: {
            root: { locale, dir: LOCALES[locale].dir, fx: null, i18n: messagesFor(locale, ...uiNamespaces) },
            page: { catalog, i18n: messagesFor(locale, "switch-builder", "switch-builder-sheet", "errors") },
          },
        },
      }),
    );
  };
  const strings = (locale: Locale) => messagesFor(locale, "switch-builder")["switch-builder"] as unknown as Record<string, Record<string, string> & { title: string }> & { title: string };
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const tours = (html: string) => [...html.matchAll(/data-tour="([a-z-]+)"/g)].map((match) => match[1]);

  it("the console step: the page's title as its h1, both ways to start, the models TamTam sells, the keys", () => {
    for (const locale of LOCALE_CODES) {
      const html = render(locale, "");
      const s = strings(locale);
      expect(html.match(/<h1[\s>]/g), locale).toHaveLength(1);
      expect(html, locale).toContain(escape(s.title));
      expect(html).toContain(escape(s.device.buy));
      expect(html).toContain(escape(s.device.have));
      expect(html).toContain("Nintendo Switch");
      expect(html).toMatch(/data-step-heading=""/);
      expect(tours(html)).toEqual(expect.arrayContaining(["steps", "help", "device-mode", "device-list", "continue"]));
      // one primary in view: the task bar's «تابع» (the aside's copy has no guide target on the server's narrow guess)
      expect(tours(html).filter((name) => name === "continue")).toHaveLength(1);
    }
  });

  it("the console step without a console to sell: «عندي جهاز Switch» is chosen and the three models are listed", () => {
    const html = render("ar", "", NO_CATALOG);
    expect(html).toContain("Nintendo Switch Lite");
    expect(html).toContain(escape(strings("ar").device.noneSold));
  });

  it("the memory step: every size with its space for games, the card TamTam sells with its price, the owned switch", () => {
    for (const locale of LOCALE_CODES) {
      const html = render(locale, "?step=memory");
      const s = strings(locale);
      expect(html, locale).toContain(escape(s.memory.title));
      for (const label of ["64GB", "128GB", "256GB", "512GB", "1TB"]) expect(html).toContain(label);
      expect(html).toContain(escape(s.memory.notSold));
      expect(tours(html)).toEqual(expect.arrayContaining(["card-list", "card-usable", "card-owned", "continue"]));
      expect(tours(html).filter((name) => name === "card-usable")).toHaveLength(1);
    }
    // 1TB: its space for games on the card (whole GB, rounded down) and the price of the card TamTam sells
    const ar = render("ar", "?step=memory");
    expect(ar).toContain(String(Math.floor(cardPlannableBytes(1000, DEFAULT_CAPACITY) / GIB)));
    expect(ar).toContain("175,000");
  });

  it("the games step: the list loads in the browser (or says it is not built yet), the sources are credited", () => {
    for (const locale of LOCALE_CODES) {
      const html = render(locale, "?step=games");
      const s = strings(locale);
      expect(html, locale).toContain(escape(s.games.title));
      expect(html).toContain(LIBRARY_LIST_FILE ? escape(s.games.loading) : escape(s.games.unbuiltTitle));
      expect(html).toContain("https://www.wikidata.org/");
      expect(html).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
      expect(tours(html)).toEqual(expect.arrayContaining(["meter", "chosen", "continue"]));
      expect(html).toMatch(/role="meter"/);
    }
  });

  it("the review step: the prices are being worked out (the quote is the route's action, asked in the browser)", () => {
    for (const locale of LOCALE_CODES) {
      const html = render(locale, "?step=review");
      const s = strings(locale);
      expect(html, locale).toContain(escape(s.review.title));
      expect(html).toContain(escape(s.review.quoteLoading));
      expect(html).not.toContain(escape(s.keys.toReview));
    }
  });

  it("the review says the eShop total with the oldest day staff checked a price behind it (§1.5: a USD price has its date)", () => {
    // Found by the review: the digital line said «4 ألعاب بسعر $194.96 في eShop» with no date at all.
    const extras: Record<string, LibraryExtras> = {
      "hades-switch": { sizeBytes: GB(6.4), priceUsdCents: 2499, priceAsOf: "2026-11-02" },
      "mario-kart-8-deluxe-switch": { sizeBytes: GB(7.2), priceUsdCents: 5999, priceAsOf: "2026-10-15" },
      "the-legend-of-zelda-breath-of-the-wild-switch": { sizeBytes: GB(16.5), cartridgeBytes: GB(0.8), priceUsdCents: 5999, priceAsOf: "2026-09-01" },
      "tetris-99-switch": { sizeBytes: GB(0.4) },
    };
    const byId = new Map(mergeLibrary(GAMES, extras, CATALOG.cartridges).map((entry) => [entry.game.id, entry]));
    const plan: BuilderPlan = {
      v: 1,
      device: { model: "switch-oled", owned: true },
      card: { sizeGB: 0, owned: false },
      games: [
        { id: "hades-switch", format: "digital" },
        { id: "mario-kart-8-deluxe-switch", format: "digital" },
        { id: "the-legend-of-zelda-breath-of-the-wild-switch", format: "cartridge" },
        { id: "tetris-99-switch", format: "digital" },
      ],
    };
    const quote: BuilderQuote = {
      lines: [{ kind: "cartridge", gameId: "the-legend-of-zelda-breath-of-the-wild-switch", variantId: "var_nsg-zelda-botw", productSlug: "x", qty: 1, name: "Zelda", unitPriceIqd: 90_000, orderable: true }],
      totalIqd: 90_000,
      digital: { pricedCents: 8498, pricedCount: 2, unpricedIds: ["tetris-99-switch"], cardsCents: 0, cardsSold: false },
      notSold: [],
    };
    // Zelda is bought as a cartridge (its older date is not behind the eShop total); Tetris has no price
    expect(eshopPricesAsOf(plan, quote, byId)).toBe(Date.parse("2026-10-15T12:00:00Z"));
    expect(eshopPricesAsOf(plan, quote, new Map())).toBeNull();
    const html = render("en", "?step=review", CATALOG, () => createElement(ReviewStep, { plan, byId, quote: { status: "ready", quote, offline: false, retry: () => {} }, refusal: null }));
    expect(html).toContain("eShop prices as our team checked them, the oldest on");
  });

  it("«أضف الكل» / «عرض السلة» follow the page's answer, so the task bar's and the aside's copies always agree (review)", () => {
    // Found by the review: each copy kept its own "added" state, so after a resize (a turned tablet) the copy that came
    // into view offered «أضف الكل» again and a second tap added every line twice.
    const lines = [{ kind: "device" as const, variantId: "var_nsw-oled-neon", productSlug: "nintendo-switch-oled", qty: 1, name: "Nintendo Switch – OLED Model", unitPriceIqd: 550_000, orderable: true }];
    const key = (added: boolean, compact: boolean) => render("ar", "?step=review", CATALOG, () => createElement(AddAllKey, { lines, added, compact, onAdded: () => {}, onRefused: () => {} }));
    const s = strings("ar");
    for (const compact of [false, true]) {
      const label = escape(compact ? s.review.addAllShort : s.review.addAll);
      expect(key(false, compact)).toContain(label);
      expect(key(false, compact)).not.toContain(escape(s.review.viewCart));
      expect(key(true, compact)).toContain(escape(s.review.viewCart));
      expect(key(true, compact)).not.toContain(label);
    }
  });
});
