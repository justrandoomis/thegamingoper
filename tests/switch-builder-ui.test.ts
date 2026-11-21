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
import { readFileSync } from "node:fs";
import { AddAllKey, cartItemsOf, NOTHING_ID } from "~/routes/storefront/builder/components/AddAllKey";
import { BuilderPage } from "~/routes/storefront/builder/components/BuilderPage";
import { ChosenList } from "~/routes/storefront/builder/components/ChosenList";
import { DeviceStep, keepDashes, soldModels } from "~/routes/storefront/builder/components/DeviceStep";
import { FILTER_MODES } from "~/routes/storefront/builder/components/FiltersSheet";
import { GameCard, initialsOf } from "~/routes/storefront/builder/components/GameCard";
import { GamesStep, INITIAL_VIEW } from "~/routes/storefront/builder/components/GamesStep";
import { shortfallText } from "~/routes/storefront/builder/lib/format";
import { cardPlannableBytes } from "~/routes/storefront/builder/components/MemoryStep";
import { eshopPricesAsOf, ReviewStep, unpricedTitles, type ReviewStepProps } from "~/routes/storefront/builder/components/ReviewStep";
import { meterShares, meterTone, SpaceMeter } from "~/routes/storefront/builder/components/SpaceMeter";
import { StepKeys } from "~/routes/storefront/builder/components/StepKeys";
import { LIBRARY_LIST_FILE } from "~/routes/storefront/builder/library.manifest";
import { countsFor, mergeLibrary, NO_FILTERS, sortsFor, viewLibrary, type LibraryEntry, type LibraryView } from "~/routes/storefront/builder/lib/library";
import { stepHref, stepOf, stepOrder, stepTitle } from "~/routes/storefront/builder/lib/steps";
import { isLibraryUpdated, LibraryHttpError, libraryListUrl, readLibrary, type LibraryState } from "~/routes/storefront/builder/lib/use-library";

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

  it("over its space, a chosen game may still move to its smaller cartridge — never to the bigger download (QA 2026-11-21)", () => {
    // Found by QA: after a smaller card, Mario Tennis Aces could not go from its 2.4 GB download to its 0.3 GB cartridge
    // («تحتاج 0.3 GB، والمتبقي 0.0 GB»), although the change frees space
    const extras = { ...EXTRAS, "filler-switch": { sizeBytes: plannable + GB(20) } };
    const over: BuilderPlan = { ...base, games: [{ id: "filler-switch", format: "digital" }, { id: "the-legend-of-zelda-breath-of-the-wild-switch", format: "digital" }] };
    expect(planUsage(over, extras).usage.overBytes).toBeGreaterThan(0);
    const smaller = setGameFormat(over, "the-legend-of-zelda-breath-of-the-wild-switch", "cartridge", extras);
    expect(smaller).toMatchObject({ ok: true });
    if (!smaller.ok) return;
    expect(smaller.plan.games[1]).toEqual({ id: "the-legend-of-zelda-breath-of-the-wild-switch", format: "cartridge" });
    expect(planUsage(smaller.plan, extras).usage.usedBytes).toBeLessThan(planUsage(over, extras).usage.usedBytes);
    // back to the full download: it needs more than it takes now, and nothing is left
    expect(setGameFormat(smaller.plan, "the-legend-of-zelda-breath-of-the-wild-switch", "digital", extras)).toMatchObject({ ok: false, reason: "no_room" });
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
    // each step has its own document title (QA a11y 2026-11-21: the four said the same)
    const titles = { memory: "Choose a memory card", games: "Choose your games", review: "Review your Switch" };
    expect(stepTitle("Build your Switch", titles, "")).toBe("Build your Switch");
    expect(stepTitle("Build your Switch", titles, "?step=games")).toBe("Choose your games · Build your Switch");
    expect(stepTitle("Build your Switch", titles, "?step=nope")).toBe("Build your Switch");
    expect(stepTitle(undefined, titles, "?step=review")).toBeUndefined();
  });

  it("the builder's stylesheet renders every card (no content-visibility) and keeps the aside's keys in DOM order (QA a11y)", () => {
    // content-visibility:auto took the cards off screen out of the accessibility tree; column-reverse put «رجوع» first
    // in the Tab order while it was drawn last
    const css = readFileSync("app/routes/storefront/builder/builder.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/content-visibility|contain-intrinsic-size/);
    expect(css).not.toMatch(/column-reverse/);
    // "chosen" is a border inside the card, focus the ring outside it: never the same drawing
    expect(css).toMatch(/:is\(\.sb-model--checked, \.sb-game\[data-chosen\]\)::before \{[^}]*border: 2px solid var\(--ink\)/);
    expect(css).not.toMatch(/\.sb-game\[data-chosen\] \{[^}]*outline/);
  });

  it("Sorani never glues a suffix to a Latin word, a figure or a placeholder: it would be drawn on the wrong side (QA 2026-11-21)", () => {
    // «ئامێری Switchم هەیە» showed «مSwitch»; «{need}ی پێویستە» showed «ی14.9 GB»
    const texts: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") texts.push(value);
      else if (value && typeof value === "object") for (const child of Object.values(value)) walk(child);
    };
    walk(messagesFor("ckb", "switch-builder")["switch-builder"]);
    const glued = texts.filter((text) => [...text.matchAll(/[A-Za-z0-9}](\p{Script=Arabic})/gu)].some((match) => /\p{L}/u.test(match[1])));
    expect(glued).toEqual([]);
    // the namespace's spelling of "these games" (QA copy F21)
    expect(texts.filter((text) => text.includes("یاریانە"))).toEqual([]);
  });

  it("the review's lines are titled as the plan, and the saved plan lives in this browser — words that are true (QA copy F4, F7)", () => {
    const words = (locale: Locale) => messagesFor(locale, "switch-builder")["switch-builder"] as unknown as { review: { linesTitle: string }; keys: { offline: string } };
    // the lines include the shopper's own console and card and the eShop games: not "what goes in the cart"
    expect(words("ar").review.linesTitle).not.toContain("السلة");
    expect(words("en").review.linesTitle).not.toMatch(/cart/i);
    expect(words("ckb").review.linesTitle).not.toContain("سەبەتە");
    // «الجهاز» is the console on this page: the plan is saved in the browser
    expect(words("ar").keys.offline).toContain("المتصفح");
    expect(words("en").keys.offline).toContain("browser");
    expect(words("ckb").keys.offline).toContain("وێبگەڕ");
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
    expect(plain(shortfallText(f, GB(20), GB(15.99)))).toBe("4.1 GB");
    expect(plain(shortfallText(f, GB(0.8), GB(0.76)))).toBe("0.04 GB");
    expect(plain(shortfallText(f, GB(1) + 1000, GB(1)))).toBe("0.01 GB");
    // the sheet would show these two as «0.80 GB» and «0.78 GB» (digitsToTell): two decimals here too, rounded up
    expect(plain(shortfallText(f, 858_993_459, 832_199_680))).toBe("0.03 GB");
    // one decimal makes 0.02 GB look like 0.1 GB even when the sizes look different at one decimal (16.5 vs 16.4)
    expect(plain(shortfallText(f, GB(16.46), GB(16.44)))).toBe("0.02 GB");
    expect(shortfallText(f, GB(1), GB(2))).toBe("");
    expect(FILTER_MODES).toEqual(["single", "multi", "coop"]);
  });

  it("a 404 on the list or a details file means a newer list was published (a reload), any other failure is an error", () => {
    expect(isLibraryUpdated(new LibraryHttpError("/library/switch/list.deadbeef.json", 404))).toBe(true);
    expect(isLibraryUpdated(new LibraryHttpError("/library/switch/d/7.0badc0de.json", 404))).toBe(true);
    expect(isLibraryUpdated(new LibraryHttpError("/library/switch/d/7.0badc0de.json", 410))).toBe(true);
    // TamTam's data is an API, not a build file: a 404 there is an ordinary failure; so is a 5xx, or no connection
    expect(isLibraryUpdated(new LibraryHttpError("/api/switch-library", 404))).toBe(false);
    expect(isLibraryUpdated(new LibraryHttpError("/library/switch/list.deadbeef.json", 500))).toBe(false);
    expect(isLibraryUpdated(new TypeError("Failed to fetch"))).toBe(false);
    expect(isLibraryUpdated(new Error("/library/switch/list.deadbeef.json: HTTP 404"))).toBe(false);
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
    expect(eshopPricesAsOf(plan, quote, extras)).toBe(Date.parse("2026-10-15T12:00:00Z"));
    expect(eshopPricesAsOf(plan, quote, {})).toBeNull();
    const html = render("en", "?step=review", CATALOG, () => createElement(ReviewStep, { plan, byId, extras, quote: { status: "ready", quote, offline: false, retry: () => {} }, refusal: null }));
    expect(html).toContain("eShop prices as our team checked them, the oldest on");
    // the date comes with TamTam's data alone (GET /api/switch-library), before the list file has named the games
    const early = render("en", "?step=review", CATALOG, () => createElement(ReviewStep, { plan, byId: new Map(), extras, names: "loading", quote: { status: "ready", quote, offline: false, retry: () => {} }, refusal: null }));
    expect(early).toContain("eShop prices as our team checked them, the oldest on");
    // while that data is on its way the line says so; without it the prices are still said to be as checked
    const waiting = render("en", "?step=review", CATALOG, () => createElement(ReviewStep, { plan, byId, extras: {}, dates: "loading", quote: { status: "ready", quote, offline: false, retry: () => {} }, refusal: null }));
    expect(waiting).toContain("Loading the date of the eShop prices");
    const without = render("en", "?step=review", CATALOG, () => createElement(ReviewStep, { plan, byId, extras: {}, dates: "unavailable", quote: { status: "ready", quote, offline: false, retry: () => {} }, refusal: null }));
    // (QA copy F18: no dangling «on that date» — each game's details carry its own)
    expect(without).toContain("as our team checked them; each game's details show the date".replaceAll("'", "&#x27;"));
  });

  /** A quote with eShop cards in stock that cover only part of the priced digital total. */
  const partialQuote = (): { plan: BuilderPlan; quote: BuilderQuote; extras: Record<string, LibraryExtras> } => ({
    plan: {
      v: 1,
      device: { model: "switch-oled", owned: true },
      card: { sizeGB: 0, owned: false },
      games: [
        { id: "hades-switch", format: "digital" },
        { id: "mario-kart-8-deluxe-switch", format: "digital" },
        { id: "tetris-99-switch", format: "digital" },
      ],
    },
    quote: {
      lines: [{ kind: "eshop", variantId: "var_eshop-20", productSlug: "nintendo-eshop-us", qty: 2, name: "Nintendo eShop", variantTitle: "20 USD", unitPriceIqd: 30_000, orderable: true }],
      totalIqd: 60_000,
      digital: { pricedCents: 8498, pricedCount: 2, unpricedIds: ["tetris-99-switch"], cardsCents: 4000, cardsSold: true },
      notSold: [],
    },
    extras: {
      "hades-switch": { sizeBytes: GB(6.4), priceUsdCents: 2499, priceAsOf: "2026-11-02" },
      "mario-kart-8-deluxe-switch": { sizeBytes: GB(7.2), priceUsdCents: 5999, priceAsOf: "2026-10-15" },
      "tetris-99-switch": { sizeBytes: GB(0.4) },
    },
  });
  const review = (locale: Locale, props: Partial<ReviewStepProps> & Pick<ReviewStepProps, "plan" | "quote" | "byId" | "extras">) =>
    render(locale, "?step=review", CATALOG, () => createElement(ReviewStep, { refusal: null, ...props }));
  const ready = (quote: BuilderQuote) => ({ status: "ready" as const, quote, offline: false, retry: () => {} });

  it("when the eShop cards in stock cover only part of the digital total, the review says so plainly with both amounts and keeps the date", () => {
    const { plan, quote, extras } = partialQuote();
    const byId = new Map(mergeLibrary(GAMES, extras, CATALOG.cartridges).map((entry) => [entry.game.id, entry]));
    const en = review("en", { plan, quote: ready(quote), byId, extras });
    expect(en).toContain("The eShop cards we have in stock now cover only");
    expect(en).toMatch(/\$40\.00[^<]*<\/b>[^]*?\$84\.98/);
    expect(en).toContain("eShop prices as our team checked them, the oldest on");
    expect(en).not.toContain("eShop cards that cover");
    for (const locale of LOCALE_CODES) {
      const html = review(locale, { plan, quote: ready(quote), byId, extras });
      expect(html, locale).toContain("40.00");
      expect(html, locale).toContain("84.98");
      expect(html, locale).toContain("note--warning");
    }
    // cards that cover the whole total: the quiet line, no warning
    const covered = { ...quote, digital: { ...quote.digital, cardsCents: 9000 } };
    const all = review("en", { plan, quote: ready(covered), byId, extras });
    expect(all).toContain("eShop cards that cover");
    expect(all).not.toContain("cover only");
  });

  it("the games without a price are named once the list is here — counted while it loads or when it failed, never by their store slug", () => {
    const { plan, quote, extras } = partialQuote();
    const byId = new Map(mergeLibrary(GAMES, extras, CATALOG.cartridges).map((entry) => [entry.game.id, entry]));
    expect(unpricedTitles(["tetris-99-switch", "hades-switch"], byId)).toEqual(["Tetris 99", "Hades"]);
    expect(unpricedTitles(["tetris-99-switch"], new Map())).toBeNull();
    // one game the list does not have (hidden since, or a list of another build): count them all instead
    expect(unpricedTitles(["tetris-99-switch", "gone-game-switch"], byId)).toBeNull();
    // a direct load of ?step=review: the quote answered before the list file
    const loading = review("en", { plan, quote: ready(quote), byId: new Map(), extras, names: "loading" });
    expect(loading).toContain("We have not added the price of 1 of your games yet");
    expect(loading).toContain("Loading these games");
    expect(loading).not.toContain("tetris-99-switch");
    const failed = review("en", { plan, quote: ready(quote), byId: new Map(), extras, names: "unavailable" });
    expect(failed).toContain("We have not added the price of 1 of your games yet");
    expect(failed).not.toContain("Loading these games");
    expect(failed).not.toContain("tetris-99-switch");
    const named = review("en", { plan, quote: ready(quote), byId, extras });
    expect(named).toContain("check it on eShop: ");
    expect(named).not.toContain("tetris-99-switch");
    for (const locale of LOCALE_CODES) expect(review(locale, { plan, quote: ready(quote), byId: new Map(), extras, names: "loading" }), locale).not.toContain("tetris-99-switch");
  });

  it("a restored plan's games before their sizes have loaded: the space bar draws no false 0 and says it is loading", () => {
    const usage = planUsage({ ...defaultPlan(CATALOG), games: [{ id: "hades-switch", format: "digital" }] }, {}, DEFAULT_CAPACITY);
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const loading = render(locale, "?step=games", CATALOG, () => createElement(SpaceMeter, { usage, figures: "loading" }));
      expect(loading, locale).toContain(escape(s.meter.loading));
      expect(loading).not.toMatch(/role="meter"/);
      expect(loading).toContain('aria-busy="true"');
      // what is kept free depends on the console and the card only: it stays
      expect(loading).toContain(escape(s.meter.kept.split("{")[0].trim()));
      const failed = render(locale, "?step=games", CATALOG, () => createElement(SpaceMeter, { usage, figures: "unknown" }));
      expect(failed).toContain(escape(s.meter.unknown));
      expect(failed).not.toMatch(/role="meter"/);
      const known = render(locale, "?step=games", CATALOG, () => createElement(SpaceMeter, { usage }));
      expect(known).toMatch(/role="meter"/);
    }
    const en = render("en", "?step=games", CATALOG, () => createElement(SpaceMeter, { usage, figures: "loading" }));
    expect(en).not.toMatch(/Used [^<]*0\.0/);
  });

  it("below 1024 one meter is read: the task bar's copy is drawn for the eyes only (the games step's own meter has the figures)", () => {
    const usage = planUsage(defaultPlan(CATALOG), {}, DEFAULT_CAPACITY);
    const compact = render("en", "?step=games", CATALOG, () => createElement(SpaceMeter, { usage, compact: true, decorative: true }));
    expect(compact).not.toMatch(/role="meter"/);
    expect(compact).toMatch(/class="sb-meter sb-meter--compact[^"]*"[^>]*aria-hidden="true"/);
    // the page: the games step's meter (below 1024) and the aside's (from 1024) — never both on screen — and the task
    // bar's copy hidden from screen readers
    const page = render("en", "?step=games");
    expect(page.match(/role="meter"/g)).toHaveLength(2);
    expect(page).toMatch(/class="sb-meter sb-meter--compact[^"]*"[^>]*aria-hidden="true"/);
  });

  it("the chosen games' list says it is loading while the list file names them, never «no games yet»", () => {
    const s = strings("en");
    const loading = render("en", "?step=games", CATALOG, () => createElement(ChosenList, { items: [], pending: "loading", onRemove: () => {} }));
    expect(loading).toContain(escape(s.chosen.loading));
    expect(loading).not.toContain(escape(s.chosen.empty));
    const unnamed = render("en", "?step=games", CATALOG, () => createElement(ChosenList, { items: [], pending: "unnamed", onRemove: () => {} }));
    expect(unnamed).toContain(escape(s.chosen.unnamed));
    expect(render("en", "?step=games", CATALOG, () => createElement(ChosenList, { items: [], onRemove: () => {} }))).toContain(escape(s.chosen.empty));
  });

  it("a game card short by under 0.05 GB says it with two decimals, as the sheet does (never «0.0 GB short»)", () => {
    const entry = mergeLibrary([game("among-us-switch", { title: "Among Us" })], { "among-us-switch": { sizeBytes: 858_993_459 } }, {})[0];
    for (const locale of LOCALE_CODES) {
      const html = render(locale, "?step=games", CATALOG, () => createElement(GameCard, { entry, chosen: null, remainingBytes: 832_199_680, onToggle: () => {}, onOpen: () => {} }));
      const shown = html.replace(/[⁦-⁩]/g, "");
      expect(shown, locale).toMatch(/0[.٫]03/);
      expect(shown, locale).not.toMatch(/0[.٫]0(?!3)\d?\s*GB/);
    }
  });

  it("the aside's step keys say their full names and take a second line before they would cut them; the task bar's stay short", () => {
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const aside = render(locale, "?step=games", CATALOG, () => createElement(StepKeys, { step: "games" }));
      expect(aside, locale).toContain(escape(s.keys.toReview));
      expect(aside.match(/key--wrap/g)?.length ?? 0, locale).toBe(2);
      const bar = render(locale, "?step=games", CATALOG, () => createElement(StepKeys, { step: "games", compact: true }));
      expect(bar).toContain(escape(s.keys.continue));
      expect(bar).not.toContain("key--wrap");
    }
  });

  it("a newer game list published after the page was opened: the games step says so and offers a reload, not the generic error", () => {
    const library: LibraryState = { status: "stale", data: null, payload: null, payloadFailed: false, offline: false, retry: () => {} };
    const usage = planUsage(defaultPlan(CATALOG), {}, DEFAULT_CAPACITY);
    const step = (state: LibraryState, extra: { detailsUpdated?: boolean; entries?: readonly LibraryEntry[] } = {}) =>
      createElement(GamesStep, {
        library: state,
        entries: extra.entries ?? [],
        usage,
        chosen: new Map(),
        view: INITIAL_VIEW,
        onView: () => {},
        onToggle: () => {},
        onOpen: () => {},
        meterTour: false,
        detailsUpdated: extra.detailsUpdated,
        asOf: "2026-11-21",
      });
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const html = render(locale, "?step=games", CATALOG, () => step(library));
      expect(html, locale).toContain(escape(s.updated.title));
      expect(html).toContain(escape(s.updated.reload));
      expect(html).toContain('role="alert"');
      expect(html).not.toContain(escape(s.games.errorTitle));
    }
    // other failures keep the error with its retry
    const failed = render("en", "?step=games", CATALOG, () => step({ ...library, status: "error" }));
    expect(failed).toContain(escape(strings("en").games.errorTitle));
    expect(failed).not.toContain(escape(strings("en").updated.title));
    // a details file gone under a list that still works: the list stays, the notice above it
    const ready = render("en", "?step=games", CATALOG, () => step({ ...library, status: "ready" }, { detailsUpdated: true, entries: ENTRIES }));
    expect(ready).toContain(escape(strings("en").updated.title));
    expect(ready).toContain("Mario Kart 8 Deluxe");
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

  // ─────────────────────────────────────────────── QA fix round (2026-11-21): visual, a11y, copy and functional findings

  const longTitle = { ...game("the-legend-of-zelda-tears-of-the-kingdom-switch", { title: "The Legend of Zelda: Tears of the Kingdom", titleAr: "ذا ليجند أوف زيلدا: تيرز أوف ذا كينغدوم", year: 2023 }) };
  const longEntry = mergeLibrary([longTitle], { [longTitle.id]: { sizeBytes: GB(18.2) } }, {})[0];

  it("a game card keeps its year beside a long page-language title: only the title shortens (QA visual)", () => {
    const html = render("ar", "?step=games", CATALOG, () => createElement(GameCard, { entry: longEntry, chosen: null, remainingBytes: GB(100), onToggle: () => {}, onOpen: () => {} }));
    // the title in the kit's FactLine (it shortens at its own end); the year outside it, its own piece of the line
    expect(html).toMatch(/<p class="sb-game__meta"><span class="factline sb-game__local">[^]*ذا ليجند[^]*<\/span><span class="sb-game__year nums">[^<]*<span class="sb-game__sep"> · <\/span>2023<\/span><\/p>/);
    // the info key says it opens a dialog; the tile is drawn with the initials
    expect(html).toMatch(/aria-haspopup="dialog"[^>]*class="[^"]*sb-game__info|class="[^"]*sb-game__info[^"]*"[^>]*aria-haspopup="dialog"/);
    expect(html).toContain('class="sb-tile"');
    expect(html).toContain(">LZ<");
    // English has no local title: the year alone
    const en = render("en", "?step=games", CATALOG, () => createElement(GameCard, { entry: longEntry, chosen: null, remainingBytes: GB(100), onToggle: () => {}, onOpen: () => {} }));
    expect(en).toContain('<p class="sb-game__meta"><span class="sb-game__year nums">2023</span></p>');
  });

  it("over the space: the meter's sentence is plain content (said once by the page), the task bar's copy says it short (QA a11y, visual)", () => {
    const over = planUsage({ v: 1, device: { model: "switch-oled", owned: true }, card: { sizeGB: 0, owned: false }, games: [{ id: "big-switch", format: "digital" }] }, { "big-switch": { sizeBytes: GB(115.6) } }, DEFAULT_CAPACITY);
    expect(over.usage.overBytes).toBeGreaterThan(0);
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const full = render(locale, "?step=games", CATALOG, () => createElement(SpaceMeter, { usage: over }));
      expect(full, locale).toContain("sb-meter__over");
      expect(full).not.toContain('role="status"');
      const compact = render(locale, "?step=games", CATALOG, () => createElement(SpaceMeter, { usage: over, compact: true, decorative: true }));
      const short = s.meter.overShort.replace("{over}", "").trim();
      expect(compact, locale).toContain(escape(short));
      expect(compact).not.toContain(escape(s.meter.over.split("{over}")[0].trim() || "∅"));
    }
  });

  it("the aside's keys: the primary first in the DOM (the order on screen); the task bar's: «رجوع» first; both mark the primary for the skip key", () => {
    for (const locale of LOCALE_CODES) {
      const back = escape(strings(locale).keys.back);
      const order = (html: string) => [html.indexOf(back), html.indexOf("data-step-next")];
      const [backAt, nextAt] = order(render(locale, "?step=memory", CATALOG, () => createElement(StepKeys, { step: "memory" })));
      expect(nextAt, locale).toBeGreaterThan(-1);
      expect(nextAt).toBeLessThan(backAt);
      const [barBack, barNext] = order(render(locale, "?step=memory", CATALOG, () => createElement(StepKeys, { step: "memory", compact: true })));
      expect(barBack).toBeLessThan(barNext);
    }
  });

  it("«أضف الكل» with nothing to add stays focusable and names its reason; the task bar's short key has the full name (QA a11y)", () => {
    const s = strings("ar");
    const flat = render("ar", "?step=review", CATALOG, () => createElement(AddAllKey, { lines: [], added: false, onAdded: () => {}, onRefused: () => {} }));
    expect(flat).toContain('aria-disabled="true"');
    expect(flat).toContain(`aria-describedby="${NOTHING_ID}"`);
    expect(flat).not.toMatch(/<button[^>]* disabled=""/);
    // while the quote is worked out there is no reason to give yet
    expect(render("ar", "?step=review", CATALOG, () => createElement(AddAllKey, { lines: [], pending: true, added: false, onAdded: () => {}, onRefused: () => {} }))).not.toContain(NOTHING_ID);
    const lines = [{ kind: "device" as const, variantId: "var_nsw-oled-neon", productSlug: "nintendo-switch-oled", qty: 1, name: "Nintendo Switch – OLED Model", unitPriceIqd: 550_000, orderable: true }];
    const compact = render("ar", "?step=review", CATALOG, () => createElement(AddAllKey, { lines, compact: true, added: false, onAdded: () => {}, onRefused: () => {} }));
    expect(compact).toContain(`aria-label="${escape(s.review.addAllName)}"`);
    expect(s.review.addAllName).toContain(s.review.addAllShort);
    expect(strings("ckb").review.addAllName).toContain(strings("ckb").review.addAllShort);
    expect(strings("en").review.addAllName).toContain(strings("en").review.addAllShort);
  });

  it("the review says the plan no longer fits at every width, with both figures and the ways out; and the reminder after an earlier add (QA functional)", () => {
    const { plan, quote, extras } = partialQuote();
    const byId = new Map(mergeLibrary(GAMES, extras, CATALOG.cartridges).map((entry) => [entry.game.id, entry]));
    const over = planUsage({ ...plan, games: [{ id: "big-switch", format: "digital" }] }, { "big-switch": { sizeBytes: GB(115.6) } }, DEFAULT_CAPACITY);
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const html = review(locale, { plan, quote: ready(quote), byId, extras, usage: over, biggerCard: true });
      const warning = html.indexOf("sb-review__warning");
      expect(warning, locale).toBeGreaterThan(-1);
      // above the lines
      expect(warning).toBeLessThan(html.indexOf('data-tour="review-lines"'));
      expect(html).toContain("115.6");
      expect(html).toContain("step=memory");
      expect(html).toContain("step=games");
      expect(html).toContain(escape(s.review.overGames));
      // a plan that fits: no warning
      expect(review(locale, { plan, quote: ready(quote), byId, extras, usage: planUsage(plan, extras, DEFAULT_CAPACITY) })).not.toContain("sb-review__warning");
    }
    const again = review("en", { plan, quote: ready(quote), byId, extras, addedBefore: true });
    expect(again).toContain(escape(strings("en").review.addedBefore));
    expect(again).toContain('href="/en/cart"');
  });

  it("a refusal: an alert when lines are named, quiet when the error toast says it; the flat key's reason has its id; dates in words", () => {
    const { plan, quote, extras } = partialQuote();
    const byId = new Map(mergeLibrary(GAMES, extras, CATALOG.cartridges).map((entry) => [entry.game.id, entry]));
    const named = review("ar", { plan, quote: ready(quote), byId, extras, refusal: { code: "bundle_refused", problems: [{ variantId: "var_eshop-20", code: "out_of_stock" }] } });
    expect(named).toMatch(/<p class="sb-review__refused" role="alert">/);
    const generic = review("ar", { plan, quote: ready(quote), byId, extras, refusal: { code: "network", problems: [] } });
    expect(generic).toMatch(/<p class="sb-review__refused">/);
    const nothing = { ...quote, lines: [], totalIqd: 0 };
    expect(review("ar", { plan, quote: ready(nothing), byId, extras })).toContain(`id="${NOTHING_ID}"`);
    // Arabic dates are written with the month's name, as elsewhere in the store (QA copy F27)
    const ar = review("ar", { plan, quote: ready(quote), byId, extras });
    expect(ar).toContain("أسعار eShop كما راجعها فريقنا");
    expect(ar).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it("the quote's error in the builder's own offline words (it is asked again by itself), not the kit's «retry when back»", () => {
    const { plan, extras } = partialQuote();
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const html = review(locale, { plan, quote: { status: "error", quote: null, offline: true, retry: () => {} }, byId: new Map(), extras });
      expect(html, locale).toContain(escape(s.review.quoteOffline));
    }
    const library: LibraryState = { status: "error", data: null, payload: null, payloadFailed: false, offline: true, retry: () => {} };
    const usage = planUsage(defaultPlan(CATALOG), {}, DEFAULT_CAPACITY);
    const html = render("en", "?step=games", CATALOG, () => createElement(GamesStep, { library, entries: [], usage, chosen: new Map(), view: INITIAL_VIEW, onView: () => {}, onToggle: () => {}, onOpen: () => {}, meterTour: false, asOf: "2026-11-21" }));
    expect(html).toContain(escape(strings("en").games.offlineText));
  });

  it("the games toolbar: the guide's filters part lights both keys, a skip key for the grid, the sort's name says the sort in use, only the number is live", () => {
    const usage = planUsage(defaultPlan(CATALOG), {}, DEFAULT_CAPACITY);
    const library: LibraryState = { status: "ready", data: null, payload: null, payloadFailed: false, offline: false, retry: () => {} };
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const sort = (s.games as unknown as { sort: Record<string, string> }).sort;
      const html = render(locale, "?step=games", CATALOG, () => createElement(GamesStep, { library, entries: ENTRIES, usage, chosen: new Map(), view: INITIAL_VIEW, onView: () => {}, onToggle: () => {}, onOpen: () => {}, meterTour: false, asOf: "2026-11-21" }));
      expect(html, locale).toMatch(/<div class="sb-toolbar__keys" data-tour="filters">/);
      expect(html).toContain("sb-skip");
      expect(html).toContain(escape(s.games.skip));
      expect(html).toContain(`aria-label="${escape(`${sort.trigger} ${sort.popular}`)}"`);
      // the live count holds the number only; «… تأتي أولاً» is beside it
      expect(html).toMatch(/<p class="sb-count"><span class="nums" aria-live="polite">[^<]*<\/span><span class="sb-count__why">/);
      // every card is a real card (no placeholder geometry)
      expect(html.match(/class="sb-game surface lift"/g)?.length).toBe(ENTRIES.length);
    }
  });

  it("the chosen list: remove keys are bins (never the sheet's ×), the titles say they open a dialog (QA visual, a11y)", () => {
    const items = ENTRIES.slice(0, 2).map((entry) => ({ entry, format: entry.format, need: GB(1) }));
    const html = render("ar", "?step=games", CATALOG, () => createElement(ChosenList, { items, onRemove: () => {}, onOpen: () => {} }));
    expect(html.match(/data-chosen-remove=""/g)).toHaveLength(2);
    expect(html).toContain('data-icon="trash"');
    expect(html).not.toContain('data-icon="x"');
    expect(html.match(/class="sb-chosen__title" aria-haspopup="dialog"/g)).toHaveLength(2);
    // its box takes focus when the last game is removed
    expect(html).toContain('<div tabindex="-1" class="sb-chosen-box">');
  });

  it("the console step: the models are a named group, and a kept console TamTam no longer sells says so (QA a11y, functional)", () => {
    const stale: BuilderPlan = { v: 1, device: { model: "switch-lite", owned: false }, card: { sizeGB: 0, owned: false }, games: [] };
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const html = render(locale, "", CATALOG, () => createElement(DeviceStep, { catalog: CATALOG, plan: stale, capacity: DEFAULT_CAPACITY, onDevice: () => {} }));
      expect(html, locale).toContain(escape(s.device.stale.split("{name}")[0]));
      expect(html).toContain("Nintendo Switch Lite");
      expect(html).toMatch(/role="group" aria-labelledby="[^"]+"/);
      const none = render(locale, "", NO_CATALOG, () => createElement(DeviceStep, { catalog: NO_CATALOG, plan: stale, capacity: DEFAULT_CAPACITY, onDevice: () => {} }));
      expect(none).toContain(escape(s.device.staleNone.split("{name}")[0]));
    }
    // a console TamTam sells: no note
    const sold = render("ar", "", CATALOG, () => createElement(DeviceStep, { catalog: CATALOG, plan: defaultPlan(CATALOG), capacity: DEFAULT_CAPACITY, onDevice: () => {} }));
    expect(sold).not.toContain("note--warning");
  });

  it("the page: the first step puts its title before the rail (as the trade-in), the task bar has its own name, the aside is a labelled section", () => {
    for (const locale of LOCALE_CODES) {
      const s = strings(locale);
      const first = render(locale, "");
      expect(first.indexOf("data-step-heading"), locale).toBeLessThan(first.indexOf('data-tour="steps"'));
      const later = render(locale, "?step=memory");
      expect(later.indexOf('data-tour="steps"')).toBeLessThan(later.indexOf("data-step-heading"));
      // two landmarks never share a name: the rail's «خطوات…» and the task bar's «أزرار الخطوة»
      expect(later).toContain(`aria-label="${escape(s.keys.label)}"`);
      expect(s.keys.label).not.toBe(s.steps.label);
      expect(later).not.toMatch(/<aside[^>]*class="sb-aside/);
      expect(later).toMatch(/<section class="sb-aside" aria-labelledby="[^"]+"/);
      // the memory step's task bar draws the space bar too (decorative: one meter is read)
      expect(later).toMatch(/class="sb-taskbar__summary"><div class="sb-meter sb-meter--compact[^"]*"[^>]*aria-hidden="true"/);
    }
  });
});
