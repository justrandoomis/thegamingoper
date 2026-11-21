/**
 * Admin — the Switch builder's game library (docs/switch-builder.md §7; owner: admin). The pure input rules of
 * app/routes/admin/catalog/switch-library-input.ts, and the service app/server/services/admin/switch-library.server.ts
 * against a real local D1 (createTestDb):
 *
 *   · permission: catalog.switch_library.manage for every change, import and export (manager and content hold it;
 *     a cashier reads, cannot change anything, and nothing is written)
 *   · a save: sizes typed in GB → bytes, USD → cents, a YouTube link → its id, as-of days (today by default, and
 *     today when a value changes under an old day), one audit event with the changed fields before and after, the
 *     version guard (a stale form is refused), an untouched size never rewritten
 *   · the picture: public upload path, a replaced or removed picture's file deleted
 *   · CSV: preview writes nothing and reports each row (new, update, unchanged, errors); apply writes the changed rows
 *     once, in chunks, with an audit event per game; a stale preview is refused; > 100 ids and > 1 chunk work;
 *     export → import changes nothing; a file far past the limits (header cells, rows) is refused from one cheap count
 *     before it is parsed; the file's name reaches the audit trail cleaned, the import's id is generated
 *   · request bodies: read only up to their form's limit (chunked too), the upload limit counted before the body
 *   · the production grant script: once per role, never again after the owner took the permission away
 *   · the planner's storage figures (setting builder.switch.capacity, the form at the page's foot): what staff type
 *     (GB with one decimal, shares as percentages, Arabic digits), the bounds equal to the setting's schema, the preview
 *     per card size (the contract's figures), the setting's own permission (settings.manage), the save through
 *     setSetting (value, audit with the reason, the builder's payload follows), the stale-form guard (`expected`),
 *     every field error at once under the settings service's paths, and a stored value that no longer fits
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { formObject } from "~/routes/admin/catalog/catalog.server";
import { loader as moduleLoader } from "~/routes/admin/catalog/module";
import { action as editAction, loader as editLoader } from "~/routes/admin/catalog/switch-library-edit";
import { loader as exportLoader } from "~/routes/admin/catalog/switch-library-export";
import { action as importAction, loader as importLoader } from "~/routes/admin/catalog/switch-library-import";
import { action as listAction, loader as listLoader } from "~/routes/admin/catalog/switch-library";
import { signInEmployee } from "~/server/auth/admin.server";
import { MAX_UPLOAD_BODY_BYTES } from "~/server/body.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import libraryMessages from "~/i18n/messages/admin-switch-library";
import { translate, type MessageTree } from "~/i18n/translate";
import { bytesFromGiB, capacityOf, DEFAULT_CAPACITY, GIB, sanitizeCapacity, toGiB } from "~/lib/switch-builder/storage";
import { SWITCH_MODELS, type CapacityConfig, type LibraryGame } from "~/lib/switch-builder/types";
import {
  CAPACITY_ERROR_KEYS,
  CAPACITY_FIELDS,
  CAPACITY_SETTING_KEY,
  capacityDraft,
  capacityPreview,
  capacityText,
  parseCapacityFigure,
  readCapacityDraft,
  sameCapacity,
  type CapacityDraft,
  type CapacityField,
  type CapacityFigures,
} from "~/routes/admin/catalog/switch-library-capacity";
import { filterLibrary, filtersQuery, libraryItems, readFilters, type LibraryFilters } from "~/routes/admin/catalog/switch-library-list";
import {
  baghdadDay,
  foldSearch,
  formatSizeInput,
  formatUsdInput,
  isLibraryGameId,
  latinNumber,
  LIBRARY_CSV_COLUMNS,
  LIBRARY_CSV_MAX_BODY_BYTES,
  LIBRARY_CSV_MAX_BYTES,
  LIBRARY_CSV_MAX_CHANGES,
  LIBRARY_CSV_MAX_COLUMNS,
  LIBRARY_CSV_MAX_ROWS,
  libraryListUrl,
  parseAsOfDate,
  parseSizeInput,
  parseUsdInput,
  parseYesNo,
  parseYouTubeId,
  sameSize,
} from "~/routes/admin/catalog/switch-library-input";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, switchLibraryEntries } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { isAppError, toAppError } from "~/server/errors";
import { DEFAULT_ROLES, defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { enforceRateLimit, limitKey, RATE_LIMITS } from "~/server/ratelimit.server";
import { fingerprintOf, saveRolePermissions } from "~/server/services/admin/security/roles.server";
import { parseCsv, toCsv } from "~/server/services/admin/catalog/csv";
import { CAPACITY_SETTING, getLibraryExtras } from "~/server/services/switch-library.server";
import { parseSettingValue } from "~/server/settings.server";
import {
  applyLibraryCsv,
  exportLibraryCsv,
  getCapacityFigures,
  getLibraryEntry,
  LIBRARY_CSV_CHUNK,
  LIBRARY_ERROR_KEYS,
  libraryChunkGuard,
  libraryCsvShape,
  listLibraryRows,
  previewLibraryCsv,
  removeLibraryImage,
  saveCapacityFigures,
  saveLibraryEntry,
  SWITCH_LIBRARY_MANAGE,
  uploadLibraryImage,
  type LibraryListRow,
} from "~/server/services/admin/switch-library.server";
import { kvBlobStore } from "~/server/storage.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const MIB = 1024 ** 2;
/** 21 November 2026, 12:00 in Baghdad. */
const NOW = Date.UTC(2026, 10, 21, 9, 0, 0);
const TODAY = "2026-11-21";
const DAY = 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────────── pure input rules

describe("what staff type", () => {
  test("sizes: GB as the console shows them (binary, two decimals), MB for small games, Arabic digits", () => {
    const value = (text: string, allowZero = false) => {
      const parsed = parseSizeInput(text, { allowZero });
      return parsed.ok ? parsed.value : parsed.error;
    };
    expect(value("16.5")).toBe(bytesFromGiB(16.5));
    expect(value("16.52")).toBe(bytesFromGiB(16.52));
    expect(value(" 16.5 GB ")).toBe(bytesFromGiB(16.5));
    expect(value("16,5 GB")).toBe(bytesFromGiB(16.5));
    expect(value("١٦٫٥")).toBe(bytesFromGiB(16.5));
    expect(value("16.5 جيجا")).toBe(bytesFromGiB(16.5));
    expect(value("450 MB")).toBe(450 * MIB);
    expect(value("450mb")).toBe(450 * MIB);
    expect(value("39.3")).toBe(Math.round(39.3 * 1024 ** 3));
    expect(value("0")).toBe("size_zero");
    expect(value("0", true)).toBe(0);
    expect(value("16.555")).toBe("size_format");
    expect(value("abc")).toBe("size_format");
    expect(value("-5")).toBe("size_format");
    expect(value("16.5 TB")).toBe("size_format");
    expect(value("1650")).toBe("size_too_big");
  });

  test("a size reads back as staff typed it, and an untouched size stays as stored", () => {
    for (const text of ["16.5", "16.52", "0.6", "1", "450 MB", "120.25 MB", "199.99"]) {
      const parsed = parseSizeInput(text);
      if (!parsed.ok) throw new Error(text);
      const shown = formatSizeInput(parsed.value);
      const again = parseSizeInput(shown);
      expect(again.ok && again.value, text).toBe(parsed.value);
    }
    expect(formatSizeInput(bytesFromGiB(16.5))).toBe("16.5");
    expect(formatSizeInput(450 * MIB)).toBe("450 MB");
    expect(formatSizeInput(0)).toBe("0");
    // 17,688,428,544 bytes (Nintendo's "16.5 GB" figure for one game) shows as 16.47 and is not rewritten by "16.47".
    expect(formatSizeInput(17_688_428_544)).toBe("16.47");
    const typed = parseSizeInput("16.47");
    expect(typed.ok && sameSize(17_688_428_544, typed.value)).toBe(true);
  });

  test("eShop price in US dollars → cents", () => {
    const cents = (text: string) => {
      const parsed = parseUsdInput(text);
      return parsed.ok ? parsed.value : parsed.error;
    };
    expect(cents("59.99")).toBe(5999);
    expect(cents("$59.99")).toBe(5999);
    expect(cents("USD 19.99")).toBe(1999);
    expect(cents("59.9")).toBe(5990);
    expect(cents("٥٩٫٩٩")).toBe(5999);
    expect(cents("0")).toBe(0);
    expect(cents("59.999")).toBe("price_format");
    expect(cents("free")).toBe("price_format");
    expect(cents("1,299.99")).toBe("price_too_big");
    expect(formatUsdInput(5999)).toBe("59.99");
    expect(formatUsdInput(5990)).toBe("59.90");
    expect(formatUsdInput(6000)).toBe("60");
    expect(latinNumber("١٬٢٩٩٫٥")).toBe("1299.5");
  });

  test("trailer: a YouTube link or id → the 11-character id; any other site → nothing", () => {
    const id = "dQw4w9WgXcQ";
    for (const text of [
      id,
      `https://www.youtube.com/watch?v=${id}&t=10s`,
      `https://youtu.be/${id}?si=abc`,
      `youtube.com/embed/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
      `https://m.youtube.com/shorts/${id}`,
      `https://www.youtube.com/live/${id}`,
      `http://youtube.com/watch?feature=share&v=${id}`,
    ]) {
      expect(parseYouTubeId(text), text).toBe(id);
    }
    for (const text of [
      "",
      "short",
      `https://www.nintendo.com/us/store/products/hades-switch/?v=${id}`,
      `https://vimeo.com/${id}`,
      "https://www.youtube.com/watch?v=tooShort",
      "https://www.youtube.com/channel/UCGIY_O-8vW4rfX98KlMkvRg",
      `javascript:alert("${id}")`,
    ]) {
      expect(parseYouTubeId(text), text).toBeNull();
    }
  });

  test("as-of days: ISO or a spreadsheet's day/month when it is unambiguous; not before the Switch, not after today", () => {
    const day = (text: string) => {
      const parsed = parseAsOfDate(text, TODAY);
      return parsed.ok ? parsed.value : parsed.error;
    };
    expect(day("2026-11-21")).toBe("2026-11-21");
    expect(day("2026/11/2")).toBe("2026-11-02");
    expect(day("21/11/2026")).toBe("2026-11-21");
    expect(day("11/21/2026")).toBe("2026-11-21");
    expect(day("2026-11-21T00:00:00.000Z")).toBe("2026-11-21");
    expect(day("2026-11-20 10:30")).toBe("2026-11-20");
    expect(day("٢٠٢٦-١١-٢١")).toBe("2026-11-21");
    expect(day("05/06/2026")).toBe("date_ambiguous");
    // …unless one reading is the day already saved (Excel rewrote an exported 2026-11-05 as 11/5/2026 or 05/11/2026).
    const known = (text: string, saved: string) => {
      const parsed = parseAsOfDate(text, TODAY, saved);
      return parsed.ok ? parsed.value : parsed.error;
    };
    expect(known("11/5/2026", "2026-11-05")).toBe("2026-11-05");
    expect(known("05/11/2026", "2026-11-05")).toBe("2026-11-05");
    expect(known("03/04/2026", "2026-11-05")).toBe("date_ambiguous");
    expect(known("2026-11-04", "2026-11-05")).toBe("2026-11-04");
    expect(day("2026-02-30")).toBe("date_invalid");
    expect(day("yesterday")).toBe("date_invalid");
    expect(day("2016-12-31")).toBe("date_too_early");
    expect(day("2026-11-22")).toBe("date_future");
    expect(baghdadDay(Date.UTC(2026, 10, 21, 21, 30))).toBe("2026-11-22");
  });

  test("ids, yes/no, the list file's address and search folding", () => {
    expect(isLibraryGameId("hades-switch")).toBe(true);
    expect(isLibraryGameId("mario-kart-8-deluxe-switch")).toBe(true);
    for (const id of ["Hades-Switch", "hades", "hades-switch-2", "hades--switch", "-switch", "hades_switch", `${"a".repeat(160)}-switch`]) {
      expect(isLibraryGameId(id), id).toBe(false);
    }
    expect(parseYesNo("TRUE")).toBe(true);
    expect(parseYesNo("نعم")).toBe(true);
    expect(parseYesNo("0")).toBe(false);
    expect(parseYesNo("لا")).toBe(false);
    expect(parseYesNo("maybe")).toBeNull();
    expect(libraryListUrl(null)).toBeNull();
    expect(libraryListUrl("list.abcd1234.json")).toBe("/library/switch/list.abcd1234.json");
    expect(libraryListUrl("/library/switch/list.abcd1234.json")).toBe("/library/switch/list.abcd1234.json");
    expect(foldSearch("Pokémon Scarlet")).toBe("pokemon scarlet");
    expect(foldSearch("أسطورة زيلدا")).toBe(foldSearch("اسطوره زيلدا"));
  });
});

describe("the list: the open list merged with TamTam's rows, search, filters, sorting", () => {
  const game = (id: string, title: string, extra: Partial<LibraryGame> = {}): LibraryGame => ({ id, qid: "Q1", title, publishers: [], genres: [], modes: [], popularity: 10, chunk: 0, ...extra });
  const row = (gameId: string, extra: Partial<LibraryListRow> = {}): LibraryListRow => ({
    gameId,
    sizeBytes: null,
    cartridgeBytes: null,
    sizeAsOf: null,
    priceUsdCents: null,
    priceAsOf: null,
    hasTrailer: false,
    image: null,
    descriptionLangs: [],
    hasMetacritic: false,
    hidden: false,
    updatedAt: 1,
    ...extra,
  });
  const games = [
    game("hades-switch", "Hades", { popularity: 40, titleAr: "هاديس", publishers: ["Supergiant Games"], released: "2020-09-17" }),
    game("pokemon-scarlet-switch", "Pokémon Scarlet", { popularity: 80, aliases: ["Pokemon Violet"], released: "2022-11-18" }),
    game("the-legend-of-zelda-tears-of-the-kingdom-switch", "The Legend of Zelda: Tears of the Kingdom", { popularity: 90, titleAr: "أسطورة زيلدا", released: "2023-05-12" }),
    game("celeste-switch", "Celeste", { popularity: 20, year: 2018 }),
  ];
  const rowsData = [
    row("hades-switch", { sizeBytes: bytesFromGiB(16.5), priceUsdCents: 2499, updatedAt: 30 }),
    row("celeste-switch", { sizeBytes: bytesFromGiB(1.2), hidden: true, updatedAt: 50 }),
    row("delisted-game-switch", { priceUsdCents: 999, updatedAt: 40 }),
  ];
  const items = libraryItems(games, rowsData);
  const ids = (filters: Partial<LibraryFilters>) => filterLibrary(items, { ...readFilters(new URLSearchParams()), ...filters }).map((item) => item.id);

  test("every game of the list, plus TamTam's rows for games the list does not have", () => {
    expect(items.map((item) => item.id)).toEqual([...games.map((entry) => entry.id), "delisted-game-switch"]);
    expect(items.find((item) => item.id === "delisted-game-switch")).toMatchObject({ game: null, popularity: -1 });
    expect(items.find((item) => item.id === "hades-switch")?.row?.priceUsdCents).toBe(2499);
  });

  test("search: title without accents, Arabic title, aliases, publishers, id words, an exact id", () => {
    expect(ids({ q: "pokemon" })).toEqual(["pokemon-scarlet-switch"]);
    expect(ids({ q: "violet" })).toEqual(["pokemon-scarlet-switch"]);
    expect(ids({ q: "اسطوره" })).toEqual(["the-legend-of-zelda-tears-of-the-kingdom-switch"]);
    expect(ids({ q: "supergiant" })).toEqual(["hades-switch"]);
    expect(ids({ q: "zelda kingdom" })).toEqual(["the-legend-of-zelda-tears-of-the-kingdom-switch"]);
    expect(ids({ q: "Delisted-Game-Switch" })).toEqual(["delisted-game-switch"]);
    expect(ids({ q: "nothing like this" })).toEqual([]);
  });

  test("filters: size added or missing, priced or not, hidden or shown", () => {
    expect(ids({ size: "added" }).sort()).toEqual(["celeste-switch", "hades-switch"]);
    expect(ids({ size: "missing" })).toEqual(["the-legend-of-zelda-tears-of-the-kingdom-switch", "pokemon-scarlet-switch", "delisted-game-switch"]);
    expect(ids({ price: "priced" }).sort()).toEqual(["delisted-game-switch", "hades-switch"]);
    expect(ids({ price: "unpriced", size: "added" })).toEqual(["celeste-switch"]);
    expect(ids({ hidden: "hidden" })).toEqual(["celeste-switch"]);
    expect(ids({ hidden: "shown" })).not.toContain("celeste-switch");
  });

  test("sorting: best known first, title, last changed, newest; the address keeps the filters", () => {
    expect(ids({})).toEqual(["the-legend-of-zelda-tears-of-the-kingdom-switch", "pokemon-scarlet-switch", "hades-switch", "celeste-switch", "delisted-game-switch"]);
    expect(ids({ sort: "title" })).toEqual(["celeste-switch", "delisted-game-switch", "hades-switch", "pokemon-scarlet-switch", "the-legend-of-zelda-tears-of-the-kingdom-switch"]);
    expect(ids({ sort: "updated" }).slice(0, 3)).toEqual(["celeste-switch", "delisted-game-switch", "hades-switch"]);
    expect(ids({ sort: "newest" }).slice(0, 4)).toEqual(["the-legend-of-zelda-tears-of-the-kingdom-switch", "pokemon-scarlet-switch", "hades-switch", "celeste-switch"]);
    const filters = readFilters(new URLSearchParams("q=zelda&size=missing&price=bogus&sort=title&page=3"));
    expect(filters).toEqual({ q: "zelda", size: "missing", price: "", hidden: "", sort: "title", page: 3 });
    expect(filtersQuery(filters)).toBe("?q=zelda&size=missing&sort=title&page=3");
    expect(filtersQuery(readFilters(new URLSearchParams("page=-2")))).toBe("");
  });
});

describe("error sentences", () => {
  test("every key the service or the CSV reader can answer has a sentence in ar, en and ckb", () => {
    const keys = [...LIBRARY_ERROR_KEYS, "csv_empty", "csv_unterminated_quote", "csv_too_many_cells", "csv_duplicate_column", "csv_no_header", "required", "too_long", "invalid", "forbidden", "not_found", "rate_limited", "upload_missing", "upload_too_large", "upload_type", "upload_corrupt", "upload_dimensions"];
    for (const locale of ["ar", "en", "ckb"] as const) {
      const errors = (libraryMessages[locale] as { errors: Record<string, unknown> }).errors;
      for (const key of keys) expect(typeof errors[key], `${locale} errors.${key}`).toBe("string");
    }
  });

  test("a count of games takes its number's plural form, with the number as the page formats it", () => {
    const say = (locale: "ar" | "en" | "ckb", key: string, count: number) =>
      translate(libraryMessages[locale] as unknown as MessageTree, locale, key, { count, n: new Intl.NumberFormat("en-US").format(count), max: "400" });
    expect([1, 2, 3, 11, 100, 4805].map((count) => say("ar", "importer.applyQ", count))).toEqual([
      "تطبيق تغييرات لعبة واحدة؟",
      "تطبيق تغييرات لعبتين؟",
      "تطبيق تغييرات 3 ألعاب؟",
      "تطبيق تغييرات 11 لعبة؟",
      "تطبيق تغييرات 100 لعبة؟",
      "تطبيق تغييرات 4,805 ألعاب؟",
    ]);
    expect([1, 3].map((count) => say("en", "importer.applyQ", count))).toEqual(["Apply the changes to 1 game?", "Apply the changes to 3 games?"]);
    expect([1, 2, 7].map((count) => say("ar", "importer.applied", count))).toEqual(["حُفظت تغييرات لعبة واحدة.", "حُفظت تغييرات لعبتين.", "حُفظت تغييرات 7 ألعاب."]);
    expect([1, 7].map((count) => say("en", "importer.applied", count))).toEqual(["Changes to 1 game saved.", "Changes to 7 games saved."]);
    expect(say("ckb", "importer.applied", 7)).toBe("گۆڕانکاریی 7 یاری پاشەکەوت کرا.");
    // the list's heading and its summary line say the same count the same way
    expect([say("ar", "list.games", 4805), say("en", "list.games", 4805), say("ar", "list.games", 0)]).toEqual(["4,805 ألعاب", "4,805 games", "لا ألعاب"]);
    expect(say("ar", "importer.tooMany", 403)).toMatch(/^الملف يغيّر 403 ألعاب، /);
    expect(say("ar", "importer.tooMany", 450)).toMatch(/^الملف يغيّر 450 لعبة، /);
    expect([1, 2].map((count) => say("en", "importer.moreRows", count))).toEqual(["1 more row is not shown here.", "2 more rows are not shown here."]);
  });
});

describe("who may change the library", () => {
  test("manager and content manage it (the owner through the wildcard); cashier, support and inventory do not", () => {
    for (const key of ["owner", "manager", "content"] as const) expect(defaultRolePermissions(key).has(SWITCH_LIBRARY_MANAGE), key).toBe(true);
    for (const key of ["cashier", "support", "inventory", "fulfillment", "finance"] as const) expect(defaultRolePermissions(key).has(SWITCH_LIBRARY_MANAGE), key).toBe(false);
  });

  test("the storage figures follow their setting's own permission (settings.manage): owner and manager, not content", () => {
    for (const key of ["owner", "manager"] as const) expect(defaultRolePermissions(key).has("settings.manage"), key).toBe(true);
    for (const key of ["content", "cashier", "support", "inventory", "fulfillment", "finance"] as const) expect(defaultRolePermissions(key).has("settings.manage"), key).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── storage figures: pure rules

/** DEFAULT_CAPACITY with one figure set (by its input name), the headroom pair kept in order so only that figure is judged. */
function capacityWith(field: CapacityField, value: number): CapacityConfig {
  const config = structuredClone(DEFAULT_CAPACITY) as unknown as Record<string, Record<string, number> | number>;
  const path = field.name.split(".").slice(1);
  if (path.length === 1) config[path[0]] = value;
  else (config[path[0]] as Record<string, number>)[path[1]] = value;
  const headroom = config.cardHeadroom as Record<string, number>;
  if (field.key === "minGiB") headroom.maxGiB = Math.max(headroom.maxGiB, Math.min(value, 200));
  if (field.key === "maxGiB") headroom.minGiB = Math.min(headroom.minGiB, Math.max(value, 0));
  return config as unknown as CapacityConfig;
}

/** The settings service's field errors for a value of builder.switch.capacity ({} when it fits). */
function settingErrors(value: unknown): Record<string, string> {
  try {
    parseSettingValue(CAPACITY_SETTING, value);
    return {};
  } catch (error) {
    if (isAppError(error)) return error.fields ?? {};
    throw error;
  }
}

describe("storage figures: what staff type, the bounds, the preview", () => {
  test("the research defaults read back unchanged; Arabic digits, a decimal comma, units and % are read", () => {
    expect(CAPACITY_SETTING_KEY).toBe(CAPACITY_SETTING);
    const draft = capacityDraft(DEFAULT_CAPACITY);
    expect(draft).toEqual({ oled: "54.0", switch: "25.9", lite: "25.9", reserve: "2.0", margin: "98.5", fraction: "5", minGiB: "2.0", maxGiB: "8.0" });
    expect(readCapacityDraft(draft, DEFAULT_CAPACITY)).toEqual({ value: DEFAULT_CAPACITY, errors: {} });
    const typed = readCapacityDraft({ ...draft, oled: "٥٥٫٢", switch: "25,8", lite: "25.8 GB", reserve: "3", margin: "٩٨٫٢٥٪", fraction: "4.5 %", maxGiB: "10" }, DEFAULT_CAPACITY);
    expect(typed).toEqual({
      value: { internalUsableGiB: { "switch-oled": 55.2, switch: 25.8, "switch-lite": 25.8 }, internalReserveGiB: 3, cardMargin: 0.9825, cardHeadroom: { fraction: 0.045, minGiB: 2, maxGiB: 10 } },
      errors: {},
    });
    // the typed value is one the setting's schema takes as it is
    expect(settingErrors(typed.value)).toEqual({});
  });

  test("each figure's own error: empty, more decimals than the console shows, outside its bounds, the headroom pair", () => {
    const errors = (patch: Partial<CapacityDraft>) => readCapacityDraft({ ...capacityDraft(DEFAULT_CAPACITY), ...patch }, DEFAULT_CAPACITY).errors;
    expect(errors({ oled: "" })).toEqual({ oled: "required" });
    expect(errors({ oled: "54.25", reserve: "two" })).toEqual({ oled: "gb_format", reserve: "gb_format" });
    expect(errors({ oled: "64.1", switch: "32.1", lite: "0.9" })).toEqual({ oled: "too_big", switch: "too_big", lite: "too_small" });
    expect(errors({ reserve: "16.1" })).toEqual({ reserve: "too_big" });
    expect(errors({ margin: "89.99", fraction: "50.5" })).toEqual({ margin: "too_small", fraction: "too_big" });
    expect(errors({ margin: "100.01" })).toEqual({ margin: "too_big" });
    expect(errors({ margin: "98.555", fraction: "0.985" })).toEqual({ margin: "percent_format", fraction: "percent_format" });
    expect(errors({ minGiB: "9", maxGiB: "8.5" })).toEqual({ maxGiB: "below_paired" });
    expect(errors({ minGiB: "100.5" })).toEqual({ minGiB: "too_big" });
    // a figure that cannot be read counts at its saved value (what the preview shows)
    expect(readCapacityDraft({ ...capacityDraft(DEFAULT_CAPACITY), margin: "lots", oled: "60" }, DEFAULT_CAPACITY).value).toEqual({ ...DEFAULT_CAPACITY, internalUsableGiB: { ...DEFAULT_CAPACITY.internalUsableGiB, "switch-oled": 60 } });
  });

  test("an untouched figure keeps its stored value, even one finer than the form's decimals", () => {
    const stored: CapacityConfig = { ...DEFAULT_CAPACITY, internalUsableGiB: { ...DEFAULT_CAPACITY.internalUsableGiB, switch: 25.85 }, cardMargin: 0.98537 };
    const draft = capacityDraft(stored);
    expect(draft).toMatchObject({ switch: "25.85", margin: "98.54" });
    const read = readCapacityDraft(draft, stored);
    expect(read.errors).toEqual({});
    expect(sameCapacity(read.value, stored)).toBe(true);
    // …and a figure typed by staff follows the form's rule
    expect(readCapacityDraft({ ...draft, switch: "25.85 " }, stored).errors).toEqual({});
    expect(readCapacityDraft({ ...draft, switch: "25.84" }, stored).errors).toEqual({ switch: "gb_format" });
  });

  test("the bounds are the setting's own (settings.server.ts), and the builder's reader keeps them", () => {
    for (const field of CAPACITY_FIELDS) {
      const step = field.unit === "percent" ? 0.0001 : 0.1;
      for (const bound of [field.min, field.max]) {
        expect(settingErrors(capacityWith(field, bound)), `${field.key} ${bound}`).toEqual({});
        expect(sanitizeCapacity(capacityWith(field, bound)), `${field.key} ${bound}`).toEqual(capacityWith(field, bound));
        expect(parseCapacityFigure(field, capacityText(field, bound)), `${field.key} ${bound}`).toEqual({ ok: true, value: bound });
      }
      expect(settingErrors(capacityWith(field, field.min - step)), field.key).toEqual({ [field.name]: "too_small" });
      expect(settingErrors(capacityWith(field, field.max + step)), field.key).toEqual({ [field.name]: "too_big" });
    }
    // the headroom pair, under the same path as the form's field
    expect(settingErrors({ ...DEFAULT_CAPACITY, cardHeadroom: { fraction: 0.05, minGiB: 9, maxGiB: 8 } })).toEqual({ "value.cardHeadroom.maxGiB": "below_paired" });
  });

  test("the preview: the contract's space for games per card, the 8 GB cap from 256GB up, the totals per model", () => {
    const rows = capacityPreview(DEFAULT_CAPACITY);
    expect(rows.map((row) => row.sizeGB)).toEqual([0, 64, 128, 256, 512, 1000]);
    expect(rows.map((row) => toGiB(row.gamesOnCardBytes))).toEqual([0, 55.8, 111.6, 226.8, 461.7, 909.4]);
    expect(rows.map((row) => toGiB(row.cardBytes))).toEqual([0, 58.7, 117.4, 234.8, 469.7, 917.4]);
    expect(rows.slice(3).every((row) => row.headroomBytes === 8 * GIB)).toBe(true);
    expect(Object.fromEntries(SWITCH_MODELS.map((model) => [model, toGiB(rows[0].totals[model])]))).toEqual({ "switch-oled": 52, switch: 23.9, "switch-lite": 23.9 });
    for (const row of rows) for (const model of SWITCH_MODELS) expect(row.totals[model]).toBe(capacityOf(model, row.sizeGB, DEFAULT_CAPACITY).plannableBytes);
    // readings change what the page plans with: an OLED showing 55.2 GB, cards at 99 %
    const read = capacityPreview(readCapacityDraft({ ...capacityDraft(DEFAULT_CAPACITY), oled: "55.2", margin: "99" }, DEFAULT_CAPACITY).value);
    expect(toGiB(read[0].totals["switch-oled"])).toBe(53.2);
    expect(toGiB(read[3].cardBytes)).toBe(236);
  });

  test("every error the figures can answer has a sentence in ar, en and ckb (bounds named)", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const messages = libraryMessages[locale] as unknown as { storage: { errors: Record<string, string> }; errors: Record<string, string> };
      for (const key of CAPACITY_ERROR_KEYS) expect(typeof messages.storage.errors[key], `${locale} storage.errors.${key}`).toBe("string");
      expect(messages.storage.errors.too_small).toContain("{min}");
      expect(messages.storage.errors.too_big).toContain("{max}");
      for (const key of ["setting_changed", "setting_needs_approval", "forbidden", "invalid"]) expect(typeof messages.errors[key], `${locale} errors.${key}`).toBe("string");
    }
  });
});

// ───────────────────────────────────────────────────────────────── against D1

let t: TestDb;
let make: Fixtures;
let content: EmployeeActor;
let cashier: EmployeeActor;
let fulfillment: EmployeeActor;
let clock = NOW;
/** A fresh "now" per change (same Baghdad day), so updated_at always moves. */
const tick = () => (clock += 1000);

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const one = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T> => {
  const found = await rows<T>(query, ...params);
  if (!found[0]) throw new Error(`no row for: ${query}`);
  return found[0];
};
const count = async (query: string, ...params: unknown[]) => Number((await one<{ n: number }>(query, ...params)).n);

async function failure(run: () => Promise<unknown>): Promise<{ code: string; status: number; fields?: Record<string, string> }> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, status: error.status, fields: error.fields };
    throw error;
  }
  throw new Error("expected the call to fail");
}

async function staff(role: DefaultRoleKey, name: string): Promise<EmployeeActor> {
  const id = await make.employee({ name });
  return { kind: "employee", id, permissions: new Set(DEFAULT_ROLES.find((entry) => entry.key === role)!.permissions), label: name };
}

/** A full edit form, as the page posts it. */
function form(gameId: string, fields: Record<string, unknown> = {}) {
  return {
    gameId,
    updatedAt: "",
    size: "",
    cartridge: "",
    sizeAsOf: "",
    price: "",
    priceAsOf: "",
    trailer: "",
    description: { ar: "", en: "", ckb: "" },
    metacritic: { score: "", reviews: "", asOf: "" },
    ...fields,
  };
}

/** The current form of a game, as the edit page would post it back unchanged. */
async function currentForm(gameId: string) {
  const entry = await getLibraryEntry(t.db, content, gameId, clock);
  return { ...form(gameId), ...entry.form, updatedAt: entry.updatedAt === null ? "" : String(entry.updatedAt), hidden: entry.form.hidden ? "on" : undefined };
}

const csvFile = (text: string, name = "library.csv") => new File([text], name, { type: "text/csv" });

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  content = await staff("content", "محررة المحتوى");
  cashier = await staff("cashier", "كاشير");
  fulfillment = await staff("fulfillment", "مجهّز");
});
afterAll(async () => {
  await t?.dispose();
});

describe("the production grant (scripts/sql/2026-11-21-switch-library-perms.sql)", () => {
  /** Runs the file as D1 does (one unit); `laterSec` runs it that many seconds later (its clock, unixepoch(), shifted). */
  const runScript = async ({ laterSec = 0 }: { laterSec?: number } = {}) => {
    const file = readFileSync(fileURLToPath(new URL("../scripts/sql/2026-11-21-switch-library-perms.sql", import.meta.url)), "utf8");
    const text = laterSec === 0 ? file : file.replaceAll("unixepoch()", `(unixepoch() + ${laterSec})`);
    const statements = text
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*(?:\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    await t.d1.batch(statements.map((statement) => t.d1.prepare(statement)));
  };
  const holders = async () => (await rows<{ key: string }>("SELECT r.key FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE p.permission = ? ORDER BY r.key", SWITCH_LIBRARY_MANAGE)).map((row) => row.key);

  test("gives the permission to manager and content once, each with an audit event; a role without the catalogue is left alone", async () => {
    await seedRoles(t.db, NOW);
    // Production before the deploy: the built-in roles exist without the new permission.
    await t.d1.prepare("DELETE FROM role_permissions WHERE permission = ?").bind(SWITCH_LIBRARY_MANAGE).run();
    expect(await holders()).toEqual([]);
    await runScript();
    expect(await holders()).toEqual(["content", "manager"]);
    const events = await rows<{ entity_id: string; actor_kind: string; action: string; after: string }>("SELECT entity_id, actor_kind, action, after FROM audit_events WHERE id LIKE 'aud_20261121_switch_library_perm_%' ORDER BY id");
    expect(events.map((event) => [event.entity_id, event.actor_kind, event.action])).toEqual([
      ["role_content", "system", "security.role.update"],
      ["role_manager", "system", "security.role.update"],
    ]);
    const after = JSON.parse(events[0].after) as { added: string[]; permissions: string[] };
    expect(after.added).toEqual([SWITCH_LIBRARY_MANAGE]);
    expect(after.permissions).toContain(SWITCH_LIBRARY_MANAGE);
    // A second run changes nothing.
    await runScript();
    expect(await holders()).toEqual(["content", "manager"]);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE id LIKE 'aud_20261121_switch_library_perm_%'")).toBe(2);
    // A content role the owner took the catalogue away from does not get it back.
    await t.d1.prepare("DELETE FROM role_permissions WHERE role_id = 'role_content' AND permission IN (?, 'catalog.product.update')").bind(SWITCH_LIBRARY_MANAGE).run();
    await runScript();
    expect(await holders()).toEqual(["manager"]);
    // Back to the defaults for the test below.
    await t.d1.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES ('role_content', 'catalog.product.update'), ('role_content', ?)").bind(SWITCH_LIBRARY_MANAGE).run();
  });

  test("taken away again, it stays away: a later run grants only what that run has just audited", async () => {
    const scriptEvents = () => count("SELECT count(*) AS n FROM audit_events WHERE id LIKE 'aud_20261121_switch_library_perm_%'");
    expect(await holders()).toEqual(["content", "manager"]);
    expect(await scriptEvents()).toBe(2);

    // Removed by hand (no audit event), and the file runs again an hour later. Nothing has been audited since the
    // file's own events, so only their age keeps the grant from coming back.
    await t.d1.prepare("DELETE FROM role_permissions WHERE role_id = 'role_manager' AND permission = ?").bind(SWITCH_LIBRARY_MANAGE).run();
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE seq > (SELECT max(seq) FROM audit_events WHERE id LIKE 'aud_20261121_switch_library_perm_%')")).toBe(0);
    await runScript({ laterSec: 3600 });
    expect(await holders()).toEqual(["content"]);
    expect(await scriptEvents()).toBe(2);

    // Taken away in Security → Roles (which audits it), and the file runs again at once: its events are fresh, but the
    // trail has moved on since them.
    const owner = await staff("owner", "المالكة");
    const current = (await rows<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_id = 'role_content'")).map((row) => row.permission);
    await saveRolePermissions(t.db, owner, { roleId: "role_content", permissions: current.filter((permission) => permission !== SWITCH_LIBRARY_MANAGE), fingerprint: fingerprintOf(current), reason: "ليس من عمل فريق المحتوى" }, tick());
    await runScript();
    expect(await holders()).toEqual([]);
    expect(await scriptEvents()).toBe(2);

    // Back to the defaults for the route tests below.
    await t.d1.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES ('role_manager', ?), ('role_content', ?)").bind(SWITCH_LIBRARY_MANAGE, SWITCH_LIBRARY_MANAGE).run();
  });
});

describe("permissions", () => {
  test("a cashier reads the library but every change, import and export is refused, and nothing is written", async () => {
    const store = kvBlobStore(t.kv);
    expect(Array.isArray(await listLibraryRows(t.db, cashier))).toBe(true);
    expect((await getLibraryEntry(t.db, cashier, "refused-game-switch", NOW)).exists).toBe(false);
    const audits = await count("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'catalog.switch_library.%'");
    const refusals = [
      await failure(() => saveLibraryEntry(t.db, cashier, form("refused-game-switch", { size: "16.5" }), tick())),
      await failure(() => uploadLibraryImage(t.db, store, cashier, { gameId: "refused-game-switch" }, csvFile("x"), tick())),
      await failure(() => removeLibraryImage(t.db, store, cashier, { gameId: "refused-game-switch" }, tick())),
      await failure(() => previewLibraryCsv(t.db, cashier, csvFile("game_id,size_gb\nrefused-game-switch,16.5\n"), tick())),
      await failure(() => applyLibraryCsv(t.db, cashier, csvFile("game_id,size_gb\nrefused-game-switch,16.5\n"), { fingerprint: "0".repeat(64) }, tick())),
      await failure(() => exportLibraryCsv(t.db, cashier, tick())),
    ];
    for (const refusal of refusals) expect(refusal).toMatchObject({ code: "forbidden", status: 403 });
    expect(await count("SELECT count(*) AS n FROM switch_library_entries WHERE game_id = 'refused-game-switch'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'catalog.switch_library.%'")).toBe(audits);
    // Without catalog.product.read the library is not even listed.
    expect(await failure(() => listLibraryRows(t.db, fulfillment))).toMatchObject({ code: "forbidden", status: 403 });
  });
});

describe("saving one game", () => {
  test("sizes, price, trailer and texts are stored in bytes, cents and an id, with an audit event and today's dates", async () => {
    const at = tick();
    const result = await saveLibraryEntry(
      t.db,
      content,
      form("hades-switch", {
        size: "16.5",
        cartridge: "1.2",
        price: "24.99",
        priceAsOf: "2026-11-20",
        trailer: "https://youtu.be/91t0ha9x0AE?si=share",
        description: { ar: "  لعبة هروب من العالم السفلي.\n\n\n\nقتال سريع.  ", en: "Escape from the underworld.", ckb: "" },
      }),
      at,
    );
    expect(result).toMatchObject({ changed: true, created: true, updatedAt: at });
    const row = await one<Record<string, unknown>>("SELECT * FROM switch_library_entries WHERE game_id = 'hades-switch'");
    expect(row).toMatchObject({
      size_bytes: bytesFromGiB(16.5),
      cartridge_bytes: bytesFromGiB(1.2),
      size_as_of: TODAY,
      price_usd_cents: 2499,
      price_as_of: "2026-11-20",
      trailer_youtube_id: "91t0ha9x0AE",
      is_hidden: 0,
      created_at: at,
      updated_at: at,
      updated_by: content.id,
      metacritic_score: null,
      image_file_id: null,
    });
    expect(JSON.parse(String(row.description))).toEqual({ ar: "لعبة هروب من العالم السفلي.\n\nقتال سريع.", en: "Escape from the underworld." });
    const audit = await one<{ actor_id: string; entity_type: string; before: string | null; after: string; at: number }>(
      "SELECT actor_id, entity_type, before, after, at FROM audit_events WHERE action = 'catalog.switch_library.save' AND entity_id = 'hades-switch' ORDER BY seq DESC LIMIT 1",
    );
    expect(audit).toMatchObject({ actor_id: content.id, entity_type: "switch_library_entry", before: null, at });
    expect(JSON.parse(audit.after)).toMatchObject({ sizeBytes: bytesFromGiB(16.5), priceUsdCents: 2499, trailerYoutubeId: "91t0ha9x0AE", sizeAsOf: TODAY });

    const entry = await getLibraryEntry(t.db, cashier, "hades-switch", at);
    expect(entry).toMatchObject({ exists: true, updatedAt: at, updatedByName: "محررة المحتوى" });
    expect(entry.form).toMatchObject({ size: "16.5", cartridge: "1.2", sizeAsOf: TODAY, price: "24.99", priceAsOf: "2026-11-20", trailer: "91t0ha9x0AE" });
    const listed = (await listLibraryRows(t.db, cashier)).find((item) => item.gameId === "hades-switch");
    expect(listed).toMatchObject({ sizeBytes: bytesFromGiB(16.5), priceUsdCents: 2499, hasTrailer: true, descriptionLangs: ["ar", "en"], hidden: false, image: null });
  });

  test("an unchanged form writes nothing; a stale one is refused; a changed size under its old day gets today", async () => {
    const unchanged = await saveLibraryEntry(t.db, content, await currentForm("hades-switch"), tick());
    expect(unchanged.changed).toBe(false);
    const audits = await count("SELECT count(*) AS n FROM audit_events WHERE entity_id = 'hades-switch'");

    const stale = await currentForm("hades-switch");
    // Two days later, in another tab, the size is measured again: the day field still shows the old day.
    clock += 2 * DAY;
    const later = await saveLibraryEntry(t.db, content, { ...(await currentForm("hades-switch")), size: "16.7" }, tick());
    expect(later).toMatchObject({ changed: true, fields: ["sizeBytes", "sizeAsOf"] });
    const row = await one<{ size_bytes: number; size_as_of: string; price_as_of: string }>("SELECT size_bytes, size_as_of, price_as_of FROM switch_library_entries WHERE game_id = 'hades-switch'");
    expect(row).toEqual({ size_bytes: bytesFromGiB(16.7), size_as_of: baghdadDay(clock), price_as_of: "2026-11-20" });
    const audit = await one<{ before: string; after: string }>("SELECT before, after FROM audit_events WHERE action = 'catalog.switch_library.save' AND entity_id = 'hades-switch' ORDER BY seq DESC LIMIT 1");
    expect(JSON.parse(audit.before)).toEqual({ sizeBytes: bytesFromGiB(16.5), sizeAsOf: TODAY });
    expect(JSON.parse(audit.after)).toEqual({ sizeBytes: bytesFromGiB(16.7), sizeAsOf: baghdadDay(clock) });

    // The first tab saves on top of that: refused, nothing changes.
    expect(await failure(() => saveLibraryEntry(t.db, content, { ...stale, price: "9.99" }, tick()))).toMatchObject({ code: "entry_changed", status: 409 });
    expect((await one<{ price_usd_cents: number }>("SELECT price_usd_cents FROM switch_library_entries WHERE game_id = 'hades-switch'")).price_usd_cents).toBe(2499);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE entity_id = 'hades-switch'")).toBe(audits + 1);

    // A form opened before the game had a row cannot create it a second time.
    expect(await failure(() => saveLibraryEntry(t.db, content, form("hades-switch", { size: "3" }), tick()))).toMatchObject({ code: "entry_changed", status: 409 });

    // Clearing the price clears its day too.
    await saveLibraryEntry(t.db, content, { ...(await currentForm("hades-switch")), price: "" }, tick());
    expect(await one("SELECT price_usd_cents, price_as_of FROM switch_library_entries WHERE game_id = 'hades-switch'")).toEqual({ price_usd_cents: null, price_as_of: null });
  });

  test("a size stored with more precision than two decimals is not rewritten by an unchanged form", async () => {
    await saveLibraryEntry(t.db, content, form("precise-size-switch", { size: "16.5" }), tick());
    await t.d1.prepare("UPDATE switch_library_entries SET size_bytes = 17688428544 WHERE game_id = 'precise-size-switch'").run();
    const again = await saveLibraryEntry(t.db, content, await currentForm("precise-size-switch"), tick());
    expect(again.changed).toBe(false);
    expect((await one<{ size_bytes: number }>("SELECT size_bytes FROM switch_library_entries WHERE game_id = 'precise-size-switch'")).size_bytes).toBe(17_688_428_544);
  });

  test("invalid input answers field errors and writes nothing", async () => {
    const before = await count("SELECT count(*) AS n FROM switch_library_entries");
    const bad = await failure(() =>
      saveLibraryEntry(
        t.db,
        content,
        form("broken-input-switch", {
          size: "16.555",
          cartridge: "lots",
          price: "59.999",
          sizeAsOf: "2026-12-01",
          trailer: "https://vimeo.com/76979871",
          metacritic: { score: "92", reviews: "", asOf: "" },
          description: { ar: "و".repeat(1300), en: "", ckb: "" },
        }),
        tick(),
      ),
    );
    expect(bad).toMatchObject({ code: "invalid", status: 400 });
    expect(bad.fields).toMatchObject({
      size: "size_format",
      cartridge: "size_format",
      price: "price_format",
      trailer: "trailer_invalid",
      "metacritic.reviews": "metacritic_incomplete",
      "description.ar": "too_long",
    });
    expect((await failure(() => saveLibraryEntry(t.db, content, form("future-date-switch", { size: "2", sizeAsOf: "2026-12-01" }), tick()))).fields).toEqual({ sizeAsOf: "date_future" });
    expect((await failure(() => saveLibraryEntry(t.db, content, form("few-reviews-switch", { metacritic: { score: "80", reviews: "3", asOf: "" } }), tick()))).fields).toEqual({ "metacritic.reviews": "reviews_range" });
    expect((await failure(() => saveLibraryEntry(t.db, content, form("Not An Id", { size: "2" }), tick()))).fields).toEqual({ gameId: "id_invalid" });
    expect((await failure(() => saveLibraryEntry(t.db, content, form("hades-switch-2", { size: "2" }), tick()))).fields).toEqual({ gameId: "id_invalid" });
    expect(await count("SELECT count(*) AS n FROM switch_library_entries")).toBe(before);
    // A licensed score with its review count and today's date.
    await saveLibraryEntry(t.db, content, form("licensed-score-switch", { metacritic: { score: "92", reviews: "120", asOf: "" }, hidden: "on" }), tick());
    expect(await one("SELECT metacritic_score, metacritic_reviews, metacritic_as_of, is_hidden, size_as_of FROM switch_library_entries WHERE game_id = 'licensed-score-switch'")).toEqual({
      metacritic_score: 92,
      metacritic_reviews: 120,
      metacritic_as_of: baghdadDay(clock),
      is_hidden: 1,
      size_as_of: null,
    });
  });

  test("a game without data opens with empty fields and today's dates; a malformed id is a 404", async () => {
    const entry = await getLibraryEntry(t.db, cashier, " Celeste-Switch ", NOW);
    expect(entry).toMatchObject({ gameId: "celeste-switch", exists: false, updatedAt: null, image: null, today: TODAY });
    expect(entry.form).toMatchObject({ size: "", price: "", sizeAsOf: TODAY, priceAsOf: TODAY, metacritic: { score: "", reviews: "", asOf: TODAY }, hidden: false });
    expect(await failure(() => getLibraryEntry(t.db, cashier, "../../etc", NOW))).toMatchObject({ code: "not_found", status: 404 });
  });
});

/** A real PNG (width × 9) with a text chunk the upload pipeline must strip. */
const pngChunk = (type: string, data: number[]) => {
  const body = Uint8Array.from([...new TextEncoder().encode(type), ...data]);
  const crc = crc32(body) >>> 0;
  const be = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return [...be(data.length), ...body, ...be(crc)];
};
const png = (width: number) =>
  new File(
    [
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ...pngChunk("IHDR", [0, 0, 0, width, 0, 0, 0, 9, 8, 2, 0, 0, 0]),
        ...pngChunk("tEXt", [...new TextEncoder().encode("Author"), 0, ...new TextEncoder().encode("Someone")]),
        ...pngChunk("IDAT", [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
        ...pngChunk("IEND", []),
      ]),
    ],
    "box.png",
    { type: "image/png" },
  );

describe("the picture", () => {
  test("an upload is stored public through the upload pipeline; a replaced or removed picture's file is deleted", async () => {
    const store = kvBlobStore(t.kv);
    expect(await uploadLibraryImage(t.db, store, content, { gameId: "picture-game-switch" }, png(12), tick())).toEqual({ replayed: false });
    const first = await one<{ image_file_id: string; visibility: string; kind: string; storage_key: string; width: number; owner_id: string }>(
      "SELECT e.image_file_id, f.visibility, f.kind, f.storage_key, f.width, f.owner_id FROM switch_library_entries e JOIN files f ON f.id = e.image_file_id WHERE e.game_id = 'picture-game-switch'",
    );
    expect(first).toMatchObject({ visibility: "public", kind: "switch_library_image", width: 12, owner_id: "picture-game-switch" });
    expect(first.storage_key.startsWith("pub_")).toBe(true);
    expect(new TextDecoder("latin1").decode((await store.get(first.storage_key))!.bytes)).not.toContain("Someone");
    expect((await getLibraryEntry(t.db, cashier, "picture-game-switch", clock)).image).toMatchObject({ key: first.storage_key, width: 12, height: 9 });
    // The same picture again: nothing changes.
    expect(await uploadLibraryImage(t.db, store, content, { gameId: "picture-game-switch" }, png(12), tick())).toEqual({ replayed: true });
    // Not a picture: refused by its content.
    expect((await failure(() => uploadLibraryImage(t.db, store, content, { gameId: "picture-game-switch" }, new File(["<svg onload=alert(1)>"], "x.png", { type: "image/png" }), tick()))).code).toBe("upload_type");

    // Another picture replaces it, and the old file goes.
    await uploadLibraryImage(t.db, store, content, { gameId: "picture-game-switch" }, png(13), tick());
    const second = await one<{ image_file_id: string; storage_key: string }>("SELECT e.image_file_id, f.storage_key FROM switch_library_entries e JOIN files f ON f.id = e.image_file_id WHERE e.game_id = 'picture-game-switch'");
    expect(second.image_file_id).not.toBe(first.image_file_id);
    expect((await one<{ deleted_at: number | null }>("SELECT deleted_at FROM files WHERE id = ?", first.image_file_id)).deleted_at).not.toBeNull();
    expect(await store.get(first.storage_key)).toBeNull();

    expect(await removeLibraryImage(t.db, store, content, { gameId: "picture-game-switch" }, tick())).toEqual({ removed: true });
    expect(await removeLibraryImage(t.db, store, content, { gameId: "picture-game-switch" }, tick())).toEqual({ removed: false });
    expect((await one<{ image_file_id: string | null }>("SELECT image_file_id FROM switch_library_entries WHERE game_id = 'picture-game-switch'")).image_file_id).toBeNull();
    expect(await store.get(second.storage_key)).toBeNull();
    const actions = (await rows<{ action: string }>("SELECT action FROM audit_events WHERE entity_id = 'picture-game-switch' ORDER BY seq")).map((row) => row.action);
    expect(actions).toEqual(["catalog.switch_library.image_upload", "catalog.switch_library.image_upload", "catalog.switch_library.image_remove"]);
  });
});

describe("CSV import and export", () => {
  test("preview writes nothing and reports every row; apply writes the changed rows once, each audited", async () => {
    await saveLibraryEntry(t.db, content, form("hollow-knight-switch", { size: "6.9", price: "14.99", priceAsOf: "2026-11-01" }), tick());
    await saveLibraryEntry(t.db, content, form("same-again-switch", { size: "2.5" }), tick());
    await saveLibraryEntry(t.db, content, form("trailer-game-switch", { size: "3", trailer: "dQw4w9WgXcQ" }), tick());
    const csv = toCsv(
      ["game_id", "title", "size_gb", "price_usd", "price_as_of", "trailer", "hidden", "notes"],
      [
        { game_id: "celeste-switch", title: "Celeste", size_gb: "1.2", price_usd: "19.99", notes: "measured on the OLED" },
        { game_id: "Stardew-Valley-Switch", size_gb: "950 MB", hidden: "no" },
        { game_id: "hollow-knight-switch", price_usd: "15.99", price_as_of: "2026-11-01" },
        { game_id: "not an id", size_gb: "1" },
        { game_id: "celeste-switch", size_gb: "1.3" },
        { game_id: "ori-switch", size_gb: "abc", price_usd: "9.999" },
        { game_id: "same-again-switch", size_gb: "2.5" },
        { game_id: "trailer-game-switch", trailer: "-" },
      ],
    );
    const entries = await count("SELECT count(*) AS n FROM switch_library_entries");
    const audits = await count("SELECT count(*) AS n FROM audit_events");
    const plan = await previewLibraryCsv(t.db, content, csvFile(csv), tick());
    expect(await count("SELECT count(*) AS n FROM switch_library_entries")).toBe(entries);
    expect(await count("SELECT count(*) AS n FROM audit_events")).toBe(audits);

    expect(plan.totals).toEqual({ rows: 8, create: 2, update: 2, unchanged: 1, error: 3 });
    expect(plan.fileErrors).toEqual([]);
    expect(plan.unknownColumns).toEqual(["notes"]);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const byLine = new Map(plan.rows.map((row) => [row.line, row]));
    expect(byLine.get(2)).toMatchObject({ gameId: "celeste-switch", action: "create" });
    expect(byLine.get(2)!.changes).toEqual(
      expect.arrayContaining([
        { field: "size_gb", from: null, to: "1.2 GB" },
        { field: "size_as_of", from: null, to: baghdadDay(clock) },
        { field: "price_usd", from: null, to: "$19.99" },
      ]),
    );
    expect(byLine.get(3)).toMatchObject({ gameId: "stardew-valley-switch", action: "create" });
    // The price changed but its day did not: today.
    expect(byLine.get(4)!.changes).toEqual([
      { field: "price_usd", from: "$14.99", to: "$15.99" },
      { field: "price_as_of", from: "2026-11-01", to: baghdadDay(clock) },
    ]);
    expect(byLine.get(5)).toMatchObject({ action: "error", errors: [{ field: "game_id", message: "id_invalid" }] });
    expect(byLine.get(6)).toMatchObject({ action: "error", errors: [{ field: "game_id", message: "id_repeated" }] });
    expect(byLine.get(7)).toMatchObject({ action: "error", errors: expect.arrayContaining([{ field: "size_gb", message: "size_format" }, { field: "price_usd", message: "price_format" }]) });
    expect(byLine.has(8)).toBe(false); // unchanged: counted, not listed
    expect(byLine.get(9)!.changes).toEqual([{ field: "trailer", from: "dQw4w9WgXcQ", to: null }]);

    const applied = await applyLibraryCsv(t.db, content, csvFile(csv), { fingerprint: plan.fingerprint, fileName: "library.csv" }, tick());
    expect(applied).toEqual({ created: 2, updated: 2, unchanged: 1, skipped: 3, interrupted: false });
    expect(await one("SELECT size_bytes, price_usd_cents, is_hidden FROM switch_library_entries WHERE game_id = 'celeste-switch'")).toEqual({ size_bytes: bytesFromGiB(1.2), price_usd_cents: 1999, is_hidden: 0 });
    expect((await one<{ size_bytes: number }>("SELECT size_bytes FROM switch_library_entries WHERE game_id = 'stardew-valley-switch'")).size_bytes).toBe(950 * MIB);
    expect((await one<{ trailer_youtube_id: string | null }>("SELECT trailer_youtube_id FROM switch_library_entries WHERE game_id = 'trailer-game-switch'")).trailer_youtube_id).toBeNull();
    expect(await count("SELECT count(*) AS n FROM switch_library_entries WHERE game_id IN ('ori-switch', 'not an id')")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'catalog.switch_library.import'")).toBe(4);
    const summary = await one<{ entity_id: string; summary: string; after: string }>("SELECT entity_id, summary, after FROM audit_events WHERE action = 'catalog.switch_library.import_apply' ORDER BY seq DESC LIMIT 1");
    // The import's id is generated (the preview's fingerprint); the file's name is text in the summary.
    expect(summary.entity_id).toBe(`csv_${plan.fingerprint.slice(0, 16)}`);
    expect(summary.summary).toMatch(/^library\.csv: 4 games: /);
    expect(JSON.parse(summary.after)).toMatchObject({ file: "library.csv", rows: 8, created: 2, updated: 2, unchanged: 1, skipped: 3 });
    const before = JSON.parse((await one<{ before: string }>("SELECT before FROM audit_events WHERE action = 'catalog.switch_library.import' AND entity_id = 'hollow-knight-switch'")).before);
    expect(before).toEqual({ priceUsdCents: 1499, priceAsOf: "2026-11-01" });

    // The same file again: its preview is stale (the rows changed) and a new preview has nothing to apply.
    expect(await failure(() => applyLibraryCsv(t.db, content, csvFile(csv), { fingerprint: plan.fingerprint }, tick()))).toMatchObject({ code: "import_stale", status: 409 });
    const again = await previewLibraryCsv(t.db, content, csvFile(csv), tick());
    expect(again.totals).toMatchObject({ create: 0, update: 0, unchanged: 5, error: 3 });
    expect(await failure(() => applyLibraryCsv(t.db, content, csvFile(csv), { fingerprint: again.fingerprint }, tick()))).toMatchObject({ code: "import_nothing", status: 409 });
  });

  test("a change between the preview and the apply refuses the apply; so does another file", async () => {
    const csv = "game_id,price_usd\nrace-game-switch,29.99\n";
    const plan = await previewLibraryCsv(t.db, content, csvFile(csv), tick());
    await saveLibraryEntry(t.db, content, form("race-game-switch", { size: "4" }), tick());
    expect(await failure(() => applyLibraryCsv(t.db, content, csvFile(csv), { fingerprint: plan.fingerprint }, tick()))).toMatchObject({ code: "import_stale" });
    const fresh = await previewLibraryCsv(t.db, content, csvFile(csv), tick());
    expect(await failure(() => applyLibraryCsv(t.db, content, csvFile("game_id,price_usd\nrace-game-switch,39.99\n"), { fingerprint: fresh.fingerprint }, tick()))).toMatchObject({ code: "import_stale" });
    expect((await one<{ price_usd_cents: number | null }>("SELECT price_usd_cents FROM switch_library_entries WHERE game_id = 'race-game-switch'")).price_usd_cents).toBeNull();
    await applyLibraryCsv(t.db, content, csvFile(csv), { fingerprint: fresh.fingerprint }, tick());
    expect((await one<{ price_usd_cents: number }>("SELECT price_usd_cents FROM switch_library_entries WHERE game_id = 'race-game-switch'")).price_usd_cents).toBe(2999);
  });

  test("150 games in one file: one lookup past 100 ids, several chunks; more than the import limit is refused before writing", async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `bulk-game-${String(index).padStart(3, "0")}-switch`);
    const csv = toCsv(["game_id", "size_gb", "price_usd"], ids.map((id, index) => ({ game_id: id, size_gb: (1 + index / 100).toFixed(2), price_usd: "9.99" })));
    const plan = await previewLibraryCsv(t.db, content, csvFile(csv), tick());
    expect(plan.totals).toMatchObject({ rows: 150, create: 150, error: 0 });
    expect(ids.length).toBeGreaterThan(LIBRARY_CSV_CHUNK * 3);
    const result = await applyLibraryCsv(t.db, content, csvFile(csv, "bulk.csv"), { fingerprint: plan.fingerprint, fileName: "bulk.csv" }, tick());
    expect(result).toMatchObject({ created: 150, updated: 0, interrupted: false });
    expect(await count("SELECT count(*) AS n FROM switch_library_entries WHERE game_id LIKE 'bulk-game-%'")).toBe(150);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'catalog.switch_library.import' AND entity_id LIKE 'bulk-game-%'")).toBe(150);
    expect((await one<{ size_bytes: number }>("SELECT size_bytes FROM switch_library_entries WHERE game_id = 'bulk-game-149-switch'")).size_bytes).toBe(bytesFromGiB(2.49));

    const tooMany = Array.from({ length: LIBRARY_CSV_MAX_CHANGES + 1 }, (_, index) => ({ game_id: `over-limit-${index}-switch`, size_gb: "1" }));
    const big = toCsv(["game_id", "size_gb"], tooMany);
    const bigPlan = await previewLibraryCsv(t.db, content, csvFile(big), tick());
    expect(bigPlan.tooManyChanges).toBe(true);
    expect(await failure(() => applyLibraryCsv(t.db, content, csvFile(big), { fingerprint: bigPlan.fingerprint }, tick()))).toMatchObject({ code: "import_too_many" });
    expect(await count("SELECT count(*) AS n FROM switch_library_entries WHERE game_id LIKE 'over-limit-%'")).toBe(0);
  });

  test("the chunk guard refuses a batch when a game changed or appeared after the preview, and the batch writes nothing", async () => {
    const seen = await one<{ updated_at: number }>("SELECT updated_at FROM switch_library_entries WHERE game_id = 'celeste-switch'");
    const write = (gameId: string) => t.db.update(switchLibraryEntries).set({ isHidden: true }).where(eq(switchLibraryEntries.gameId, gameId));
    // As the preview saw it: passes.
    await runBatch(t.db, [libraryChunkGuard(t.db, [{ gameId: "celeste-switch", seenAt: seen.updated_at }, { gameId: "never-seen-switch", seenAt: null }]), write("celeste-switch")]);
    expect((await one<{ is_hidden: number }>("SELECT is_hidden FROM switch_library_entries WHERE game_id = 'celeste-switch'")).is_hidden).toBe(1);
    await t.d1.prepare("UPDATE switch_library_entries SET is_hidden = 0 WHERE game_id = 'celeste-switch'").run();
    // Changed since (another updated_at), or created since (expected absent): the whole batch is refused.
    for (const chunk of [[{ gameId: "celeste-switch", seenAt: seen.updated_at - 1 }], [{ gameId: "celeste-switch", seenAt: null }]]) {
      const error = await runBatch(t.db, [libraryChunkGuard(t.db, chunk), write("celeste-switch")]).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(toAppError(error)).toMatchObject({ code: "import_stale" });
      expect((await one<{ is_hidden: number }>("SELECT is_hidden FROM switch_library_entries WHERE game_id = 'celeste-switch'")).is_hidden).toBe(0);
    }
  });

  test("a sheet edited without its dates gets today once; importing it again changes nothing", async () => {
    const { csv } = await exportLibraryCsv(t.db, content, tick());
    const sheet = parseCsv(csv).rows.map((row) => row.cells);
    const hollow = sheet.find((cells) => cells.game_id === "hollow-knight-switch")!;
    hollow.size_gb = "7.1"; // re-measured; the sheet still carries the old size_as_of
    const edited = toCsv(LIBRARY_CSV_COLUMNS, [hollow]);
    const first = await previewLibraryCsv(t.db, content, csvFile(edited), tick());
    expect(first.rows[0].changes).toEqual([
      { field: "size_gb", from: "6.9 GB", to: "7.1 GB" },
      ...(hollow.size_as_of === baghdadDay(clock) ? [] : [{ field: "size_as_of", from: hollow.size_as_of, to: baghdadDay(clock) }]),
    ]);
    await applyLibraryCsv(t.db, content, csvFile(edited), { fingerprint: first.fingerprint }, tick());
    const second = await previewLibraryCsv(t.db, content, csvFile(edited), tick());
    expect(second.totals).toMatchObject({ rows: 1, unchanged: 1, create: 0, update: 0, error: 0 });
  });

  test("a file that cannot be read says why, per file", async () => {
    expect((await previewLibraryCsv(t.db, content, csvFile("size_gb\n16.5\n"), tick())).fileErrors).toEqual([{ message: "csv_game_id_column" }]);
    expect((await previewLibraryCsv(t.db, content, csvFile('game_id,trailer\n"hades-switch,abc\n'), tick())).fileErrors[0]).toMatchObject({ message: "csv_unterminated_quote" });
    expect(await failure(() => previewLibraryCsv(t.db, content, new File([Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])], "book.xlsx"), tick()))).toMatchObject({ code: "invalid", fields: { file: "csv_not_text" } });
    // "No file" and "too large" carry no field key: the shared sentences for those keys speak of a picture, so the
    // page words them with this namespace's errors.<code> (which name the CSV file).
    for (const missing of [null, csvFile("")]) expect(await failure(() => previewLibraryCsv(t.db, content, missing, tick()))).toEqual({ code: "upload_missing", status: 400, fields: undefined });
    const big = `game_id,description_en\n${"x".repeat(LIBRARY_CSV_MAX_BYTES)}`;
    expect(await failure(() => previewLibraryCsv(t.db, content, csvFile(big), tick()))).toEqual({ code: "upload_too_large", status: 413, fields: undefined });
  });

  test("a file far past the limits is refused from one cheap count, before it is parsed", async () => {
    // 65 header cells: refused, whatever the rows (the parser's work is rows × header cells); 64 are read.
    const wide = (cells: number) => `game_id${",".repeat(cells - 1)}\nhades-switch\n`;
    expect((await previewLibraryCsv(t.db, content, csvFile(wide(LIBRARY_CSV_MAX_COLUMNS + 1)), tick())).fileErrors).toEqual([{ message: "csv_columns_limit" }]);
    expect((await previewLibraryCsv(t.db, content, csvFile(wide(LIBRARY_CSV_MAX_COLUMNS)), tick())).fileErrors).toEqual([]);
    // The auditor's file: 100,000 empty header cells over short rows, 293 KB — answered at once, nothing parsed.
    const attack = `${",".repeat(100_000)}game_id\n${"x\n".repeat(90_000)}`;
    const started = performance.now();
    expect((await previewLibraryCsv(t.db, content, csvFile(attack), tick())).fileErrors).toEqual([{ message: "csv_columns_limit" }]);
    expect(performance.now() - started).toBeLessThan(1000);
    // More rows than one file may hold: refused before parsing too.
    const long = `game_id\n${"x-switch\n".repeat(LIBRARY_CSV_MAX_ROWS + 1)}`;
    expect((await previewLibraryCsv(t.db, content, csvFile(long), tick())).fileErrors).toEqual([{ message: "csv_rows_limit" }]);
    // …but line breaks inside quoted descriptions and blank lines are not rows: 5,000 games read.
    const descriptions = Array.from({ length: LIBRARY_CSV_MAX_ROWS }, (_, index) => ({ game_id: `limit-${index}-switch`, description_en: index % 2 ? "One.\n\nTwo." : "" }));
    const full = toCsv(["game_id", "description_en"], descriptions).replace(/\r\n$/, "\r\n\r\n\n");
    expect(full.split("\n").length).toBeGreaterThan(LIBRARY_CSV_MAX_ROWS + 1 + 2 * (LIBRARY_CSV_MAX_ROWS / 2));
    const plan = await previewLibraryCsv(t.db, content, csvFile(full), tick());
    expect(plan.fileErrors).toEqual([]);
    expect(plan.totals.rows).toBe(LIBRARY_CSV_MAX_ROWS);
  });

  test("the cheap count reads records exactly as the parser does", () => {
    const samples = [
      "game_id,size_gb\nhades-switch,16.5\n",
      "\ufeffgame_id;size_gb\r\nhades-switch;16,5\r\n\r\n",
      'game_id,description_en\n"a-switch","Line one.\n\nLine ""two""."\n\n\n"b-switch",\n',
      'game_id,trailer\n""\n"c-switch",x\n""""\n',
      "game_id\r\ra-switch\rb-switch",
      'game_id,x,y\n x"y,"z\n"\nq-switch,"",\n,\n',
      "game_id,,,\n,,,\nz-switch\n\n",
      "game_id",
      'game_id\n""',
    ];
    for (const sample of samples) {
      const parsed = parseCsv(sample);
      expect(libraryCsvShape(sample, 100), JSON.stringify(sample)).toEqual({ records: parsed.rows.length + 1, headerCells: sample.replace(/^\ufeff/, "").split(/\r\n|\r|\n/)[0].split(/[,;]/).length });
    }
    // Counting stops past the limit it is given.
    expect(libraryCsvShape("game_id\na\nb\nc\nd\n", 2).records).toBe(3);
  });

  test("the export has the import's columns, and importing it back changes nothing", async () => {
    const { csv, rows: exported } = await exportLibraryCsv(t.db, content, tick());
    const parsed = parseCsv(csv);
    expect(parsed.header).toEqual([...LIBRARY_CSV_COLUMNS, "picture", "updated_at"]);
    expect(parsed.rows).toHaveLength(exported);
    const celeste = parsed.rows.find((row) => row.cells.game_id === "celeste-switch")!.cells;
    expect(celeste).toMatchObject({ size_gb: "1.2", price_usd: "19.99", hidden: "no", trailer: "", picture: "" });
    const hades = parsed.rows.find((row) => row.cells.game_id === "hades-switch")!.cells;
    expect(hades).toMatchObject({ size_gb: "16.7", cartridge_gb: "1.2", description_en: "Escape from the underworld." });
    const audit = await one<{ summary: string }>("SELECT summary FROM audit_events WHERE action = 'catalog.switch_library.export' ORDER BY seq DESC LIMIT 1");
    expect(audit.summary).toBe(`${exported} games`);

    const back = await previewLibraryCsv(t.db, content, csvFile(csv), tick());
    expect(back.fileErrors).toEqual([]);
    expect(back.totals).toMatchObject({ rows: exported, create: 0, update: 0, error: 0, unchanged: exported });
  });

  test("an export saved by Excel (dates rewritten as 11/5/2026 or 02/11/2026) imports back unchanged; a new size under its old day gets today", async () => {
    await saveLibraryEntry(t.db, content, form("excel-dates-switch", { size: "3.3", sizeAsOf: "2026-11-05", price: "9.99", priceAsOf: "2026-11-02" }), tick());
    const { csv } = await exportLibraryCsv(t.db, content, tick());
    const cells = parseCsv(csv).rows.map((row) => row.cells).find((row) => row.game_id === "excel-dates-switch")!;
    expect(cells).toMatchObject({ size_as_of: "2026-11-05", price_as_of: "2026-11-02" });
    // Excel in a US locale writes m/d/yyyy, in a British or Arabic one dd/mm/yyyy: both are ambiguous on their own.
    const excel = { ...cells, size_as_of: "11/5/2026", price_as_of: "02/11/2026" };
    const untouched = await previewLibraryCsv(t.db, content, csvFile(toCsv(LIBRARY_CSV_COLUMNS, [excel])), tick());
    expect(untouched.totals).toMatchObject({ rows: 1, unchanged: 1, error: 0 });
    // Re-measured in the sheet, the day left as Excel wrote it: today.
    const remeasured = await previewLibraryCsv(t.db, content, csvFile(toCsv(LIBRARY_CSV_COLUMNS, [{ ...excel, size_gb: "3.4" }])), tick());
    expect(remeasured.rows[0].changes).toEqual([
      { field: "size_gb", from: "3.3 GB", to: "3.4 GB" },
      { field: "size_as_of", from: "2026-11-05", to: baghdadDay(clock) },
    ]);
    // A different day that reads both ways is still refused.
    const other = await previewLibraryCsv(t.db, content, csvFile(toCsv(LIBRARY_CSV_COLUMNS, [{ ...excel, size_as_of: "03/04/2026" }])), tick());
    expect(other.rows[0]).toMatchObject({ action: "error", errors: [{ field: "size_as_of", message: "date_ambiguous" }] });
  });

  test("a file that is not UTF-8 is refused; Arabic or Sorani descriptions turned into question marks fail their row", async () => {
    // "game_id,description_ar\nhades-switch,لعبة" saved by Excel as plain CSV on an Arabic Windows (code page 1256).
    const cp1256 = Uint8Array.from([...new TextEncoder().encode("game_id,description_ar\nhades-switch,"), 0xe1, 0xda, 0xc8, 0xc9, 0x0a]);
    expect(await failure(() => previewLibraryCsv(t.db, content, new File([cp1256], "excel.csv", { type: "text/csv" }), tick()))).toMatchObject({ code: "invalid", fields: { file: "csv_encoding" } });
    // The same on a Western Windows: the letters become "?", which is valid text.
    const marks = await previewLibraryCsv(t.db, content, csvFile("game_id,description_ar,description_ckb,description_en\nhades-switch,???? ?????,?????,Escape? From the underworld.\n"), tick());
    expect(marks.rows[0]).toMatchObject({
      action: "error",
      errors: [
        { field: "description_ar", message: "description_script" },
        { field: "description_ckb", message: "description_script" },
      ],
    });
    // Real Arabic-script text passes, Latin brand names inside it included.
    const real = await previewLibraryCsv(t.db, content, csvFile("game_id,description_ckb\nhades-switch,یارییەکی خێرای Supergiant Games\n"), tick());
    expect(real.rows[0]).toMatchObject({ action: "update", changes: [{ field: "description_ckb", from: null, to: "یارییەکی خێرای Supergiant Games" }] });
    // A text already saved (here a Latin one, typed in the form) comes back from an export unchanged: no error.
    await saveLibraryEntry(t.db, content, form("latin-arabic-text-switch", { size: "2", description: { ar: "Celeste Classic", en: "", ckb: "" } }), tick());
    const kept = await previewLibraryCsv(t.db, content, csvFile("game_id,size_gb,description_ar\nlatin-arabic-text-switch,2.1,Celeste Classic\n"), tick());
    expect(kept.rows[0]).toMatchObject({ action: "update", errors: [] });
    expect(kept.rows[0].changes.map((change) => change.field)).toEqual(["size_gb"]);
  });
});

// ───────────────────────────────────────────────────────────────── storage figures against D1

/** The storage figures' form as the page posts it (its input names through the route's formObject). */
function capacityForm(draft: CapacityDraft, expected: CapacityConfig | null, reason = "قراءة جهاز OLED في المعرض من Data Management") {
  const body = new FormData();
  body.set("intent", "capacity");
  body.set("expected", JSON.stringify(expected));
  body.set("reason", reason);
  for (const field of CAPACITY_FIELDS) body.set(field.name, draft[field.key]);
  return formObject(body);
}

describe("storage figures: the setting builder.switch.capacity through the settings service", () => {
  let manager: EmployeeActor;
  const SAVED: CapacityConfig = { internalUsableGiB: { "switch-oled": 55.2, switch: 25.8, "switch-lite": 25.9 }, internalReserveGiB: 2.5, cardMargin: 0.982, cardHeadroom: { fraction: 0.04, minGiB: 2, maxGiB: 10 } };
  const settingRow = () => rows<{ value: string; updated_by: string | null; updated_at: number }>("SELECT value, updated_by, updated_at FROM settings WHERE key = ?", CAPACITY_SETTING);
  const settingAudits = () => count("SELECT count(*) AS n FROM audit_events WHERE action = 'settings.setting.update' AND entity_id = ?", CAPACITY_SETTING);

  beforeAll(async () => {
    manager = await staff("manager", "مديرة المتجر");
  });

  test("every reader sees the figures in use; only the setting's own permission changes them, checked first, and a refusal writes nothing", async () => {
    expect(await getCapacityFigures(t.db, cashier)).toEqual({
      inUse: DEFAULT_CAPACITY,
      expected: DEFAULT_CAPACITY,
      defaults: DEFAULT_CAPACITY,
      isStored: false,
      isDefault: true,
      broken: null,
      updatedAt: null,
      updatedByName: null,
      canEdit: false,
      canSeeHistory: false,
    });
    expect((await getCapacityFigures(t.db, content)).canEdit).toBe(false);
    expect(await getCapacityFigures(t.db, manager)).toMatchObject({ canEdit: true, canSeeHistory: true });
    expect(await failure(() => getCapacityFigures(t.db, fulfillment))).toMatchObject({ code: "forbidden", status: 403 });

    const audits = await settingAudits();
    const typed = { ...capacityDraft(DEFAULT_CAPACITY), oled: "55.0" };
    for (const actor of [cashier, content]) expect(await failure(() => saveCapacityFigures(t.db, actor, capacityForm(typed, DEFAULT_CAPACITY), tick()))).toMatchObject({ code: "forbidden", status: 403 });
    // the permission before the form: an unreadable form from a role that may not change the figures is a 403, not field errors
    expect(await failure(() => saveCapacityFigures(t.db, content, { value: { cardMargin: "lots" } }, tick()))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await settingRow()).toEqual([]);
    expect(await settingAudits()).toBe(audits);
  });

  test("a manager saves readings: the setting holds them, one audit event with the reason, the builder's payload follows", async () => {
    const at = tick();
    const draft = { ...capacityDraft(DEFAULT_CAPACITY), oled: "55.2", switch: "٢٥٫٨", reserve: "2.5", margin: "98.2", fraction: "4", maxGiB: "10" };
    expect(await saveCapacityFigures(t.db, manager, capacityForm(draft, DEFAULT_CAPACITY), at)).toEqual({ changed: true });
    const [row] = await settingRow();
    expect(JSON.parse(row.value)).toEqual(SAVED);
    expect(row).toMatchObject({ updated_by: manager.id, updated_at: at });
    const audit = await one<{ actor_id: string; reason: string; before: string; after: string; at: number }>(
      "SELECT actor_id, reason, before, after, at FROM audit_events WHERE action = 'settings.setting.update' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
      CAPACITY_SETTING,
    );
    expect(audit).toMatchObject({ actor_id: manager.id, reason: "قراءة جهاز OLED في المعرض من Data Management", at });
    expect(JSON.parse(audit.before)).toEqual({ value: null });
    expect(JSON.parse(audit.after)).toEqual({ value: SAVED });
    // what GET /api/switch-library serves the builder
    expect((await getLibraryExtras(t.db)).capacity).toEqual(SAVED);
    expect(await getCapacityFigures(t.db, cashier)).toMatchObject({ inUse: SAVED, expected: SAVED, isStored: true, isDefault: false, broken: null, updatedAt: at, updatedByName: "مديرة المتجر" });

    // the same figures again, as the page now shows them: nothing written, no reason needed
    const audits = await settingAudits();
    expect(await saveCapacityFigures(t.db, manager, capacityForm(capacityDraft(SAVED), SAVED, ""), tick())).toEqual({ changed: false });
    expect(await settingAudits()).toBe(audits);
    expect((await settingRow())[0].updated_at).toBe(at);
  });

  test("a form opened before a colleague's change is refused (setting_changed) and writes nothing; so is one without its `expected`", async () => {
    const opened = (await getCapacityFigures(t.db, manager)).expected!;
    expect(opened).toEqual(SAVED);
    // a colleague, in another tab, re-reads the reserve
    await saveCapacityFigures(t.db, manager, capacityForm({ ...capacityDraft(opened), reserve: "3.0" }, opened, "قراءة جديدة"), tick());
    const audits = await settingAudits();
    expect(await failure(() => saveCapacityFigures(t.db, manager, capacityForm({ ...capacityDraft(opened), oled: "56.0" }, opened), tick()))).toMatchObject({ code: "setting_changed", status: 409 });
    const form = capacityForm({ ...capacityDraft(opened), oled: "56.0" }, opened);
    delete form.expected;
    expect(await failure(() => saveCapacityFigures(t.db, manager, form, tick()))).toMatchObject({ code: "setting_changed", status: 409 });
    expect(JSON.parse((await settingRow())[0].value)).toEqual({ ...SAVED, internalReserveGiB: 3 });
    expect(await settingAudits()).toBe(audits);
    // the colleague's figures, loaded again: the change goes through
    const now = (await getCapacityFigures(t.db, manager)).expected!;
    expect(await saveCapacityFigures(t.db, manager, capacityForm({ ...capacityDraft(now), oled: "56.0" }, now), tick())).toEqual({ changed: true });
    expect(JSON.parse((await settingRow())[0].value)).toMatchObject({ internalUsableGiB: { "switch-oled": 56 }, internalReserveGiB: 3 });
  });

  test("invalid figures answer every field error at once, under the settings service's paths, and write nothing", async () => {
    const now = (await getCapacityFigures(t.db, manager)).expected!;
    const before = (await settingRow())[0].value;
    const bad = await failure(() =>
      saveCapacityFigures(t.db, manager, capacityForm({ ...capacityDraft(now), oled: "64.5", switch: "0", lite: "25.95", margin: "89", fraction: "abc", minGiB: "9", maxGiB: "8" }, now, " a "), tick()),
    );
    expect(bad).toMatchObject({ code: "invalid", status: 400 });
    expect(bad.fields).toEqual({
      "value.internalUsableGiB.switch-oled": "too_big",
      "value.internalUsableGiB.switch": "too_small",
      "value.internalUsableGiB.switch-lite": "gb_format",
      "value.cardMargin": "too_small",
      "value.cardHeadroom.fraction": "percent_format",
      "value.cardHeadroom.maxGiB": "below_paired",
      reason: "reason_required",
    });
    expect((await settingRow())[0].value).toBe(before);
  });

  test("a stored value that no longer fits: reported, the builder keeps each figure it can, and only a form that saw it broken replaces it", async () => {
    const good = JSON.parse((await settingRow())[0].value) as CapacityConfig;
    await t.d1.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(JSON.stringify({ ...good, cardMargin: 2 }), CAPACITY_SETTING).run();
    const broken = await getCapacityFigures(t.db, manager);
    expect(broken).toMatchObject({ broken: "too_big", expected: null, isStored: true });
    expect(broken.inUse).toEqual({ ...good, cardMargin: DEFAULT_CAPACITY.cardMargin });
    expect((await getLibraryExtras(t.db)).capacity).toEqual(broken.inUse);
    // a form that showed a value, not the broken one, is refused
    expect(await failure(() => saveCapacityFigures(t.db, manager, capacityForm(capacityDraft(broken.inUse), good), tick()))).toMatchObject({ code: "setting_changed", status: 409 });
    // the form as the page shows it now (expected null) replaces it — the figures in use, unchanged, are a change here
    expect(await saveCapacityFigures(t.db, manager, capacityForm(capacityDraft(broken.inUse), null), tick())).toEqual({ changed: true });
    expect(JSON.parse((await settingRow())[0].value)).toEqual(broken.inUse);
    expect((await getCapacityFigures(t.db, manager)).broken).toBeNull();

    // not even JSON (a hand-edited row): the page still opens, with the defaults in use
    const kept = (await settingRow())[0].value;
    await t.d1.prepare("UPDATE settings SET value = 'not json' WHERE key = ?").bind(CAPACITY_SETTING).run();
    expect(await getCapacityFigures(t.db, cashier)).toMatchObject({ inUse: DEFAULT_CAPACITY, expected: null, broken: "invalid" });
    await t.d1.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(kept, CAPACITY_SETTING).run();
  });
});

// ───────────────────────────────────────────────────────────────── the route modules

describe("routes: sessions, form names, answers", () => {
  const ORIGIN = "http://localhost:5173";

  /** A request context for the sign-in service (what the root middleware would build). */
  function signInCtx(cookies: string[]): RequestCtx {
    return {
      requestId: "switch-library-routes",
      nonce: "n",
      origin: ORIGIN,
      isHttps: false,
      isDev: true,
      now: Date.now(),
      ip: null,
      country: "IQ",
      userAgent: "vitest",
      locale: "ar",
      dir: "rtl",
      prefs: { theme: "system", currency: "IQD", numbering: "latn" },
      storeMode: "demo",
      cookie: () => null,
      setCookie: (serialized) => {
        cookies.push(serialized);
      },
    };
  }

  /** A signed-in employee of a built-in role (its permissions as the database holds them), as a Cookie header. */
  async function staffCookie(role: DefaultRoleKey): Promise<string> {
    return (await staffSession(role)).cookie;
  }

  /** As staffCookie, with the employee's id. */
  async function staffSession(role: DefaultRoleKey): Promise<{ cookie: string; id: string }> {
    const password = "switch-library-routes-1";
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next(role)}@switch-library.test`;
    const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
    const set: string[] = [];
    const result = await signInEmployee(signInCtx(set), t.db, { email, password });
    if (result.status !== "signed_in") throw new Error("sign-in failed");
    const token = set.map((cookie) => cookie.split(";")[0]).find((pair) => pair.startsWith("tt_adm=") && pair.length > "tt_adm=".length);
    if (!token) throw new Error("no session cookie");
    return { cookie: token, id };
  }

  type Args = { request: Request; context: RouterContextProvider; url: URL; pattern: string; params: Record<string, string> };
  const handler = (fn: unknown) => fn as (args: Args) => Promise<unknown>;

  /**
   * Runs a loader or action behind the root middleware (CSRF check, request context); its status and body. `stream`
   * sends a streamed body with its Content-Type and NO declared length (chunked).
   */
  async function run(
    fn: (args: Args) => Promise<unknown>,
    path: string,
    cookie: string,
    init: { method?: string; body?: FormData | URLSearchParams; stream?: { body: ReadableStream<Uint8Array>; type: string }; params?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { Cookie: cookie, ...(init.method && init.method !== "GET" ? { Origin: ORIGIN } : {}), ...(init.stream ? { "Content-Type": init.stream.type } : {}) };
    const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", body: init.stream?.body ?? init.body, headers, ...(init.stream ? { duplex: "half" } : {}) } as RequestInit);
    const context = new RouterContextProvider();
    const url = new URL(request.url);
    const args = { request, context, url, pattern: "admin/catalog/switch-library", params: init.params ?? {} };
    let value: unknown;
    try {
      await requestContextMiddleware(args, async () => {
        value = await fn(args);
        return new Response(null);
      });
    } catch (error) {
      value = error;
    }
    if (value instanceof Response) return { status: value.status, body: await value.text() as unknown, headers: value.headers };
    const wrapped = value as { type?: string; init?: { status?: number }; data?: unknown };
    if (wrapped?.type === "DataWithResponseInit") return { status: wrapped.init?.status ?? 200, body: wrapped.data, headers: new Headers() };
    return { status: 200, body: value, headers: new Headers() };
  }

  const formData = (entries: Record<string, string | Blob>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(entries)) body.append(key, value);
    return body;
  };

  /**
   * A multipart body of an `intent` and a file of `size` bytes, streamed in 64 KB chunks with no declared length.
   * `state.read` counts the bytes handed out and `state.pulls` the reads asked for; with `refuse`, any read throws (a
   * body that must not be touched).
   */
  function streamedUpload(intent: string, fileName: string, size: number, options: { refuse?: boolean } = {}) {
    const boundary = "switch-library-test-boundary";
    const encoder = new TextEncoder();
    const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="intent"\r\n\r\n${intent}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const state = { read: 0, pulls: 0 };
    /** File bytes handed out so far; -1 before the head. */
    let sent = -1;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulls++;
          if (options.refuse) throw new Error("the body was read");
          let chunk: Uint8Array;
          if (sent < 0) {
            chunk = head;
            sent = 0;
          } else if (sent < size) {
            chunk = new Uint8Array(Math.min(64 * 1024, size - sent)).fill(0x61);
            sent += chunk.byteLength;
          } else chunk = tail;
          controller.enqueue(chunk);
          state.read += chunk.byteLength;
          if (chunk === tail) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return { stream: { body, type: `multipart/form-data; boundary=${boundary}` }, state };
  }

  test("a cashier lists the library; saving, importing and exporting answer 403; a malformed id is a 404", async () => {
    const cashierCookie = await staffCookie("cashier");
    const list = await run(handler(listLoader), "/admin/catalog/switch-library", cashierCookie);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ can: { manage: false }, title: "مكتبة ألعاب Switch" });
    expect((list.body as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    const save = await run(handler(editAction), "/admin/catalog/switch-library/route-check-switch", cashierCookie, { method: "POST", body: formData({ intent: "save", size: "5" }), params: { gameId: "route-check-switch" } });
    expect(save.status).toBe(403);
    expect((await run(handler(importLoader), "/admin/catalog/switch-library/import", cashierCookie)).status).toBe(403);
    expect((await run(handler(exportLoader), "/admin/catalog/switch-library/export", cashierCookie)).status).toBe(403);
    expect((await run(handler(editLoader), "/admin/catalog/switch-library/Not_An_Id", cashierCookie, { params: { gameId: "Not_An_Id" } })).status).toBe(404);
    expect(await count("SELECT count(*) AS n FROM switch_library_entries WHERE game_id = 'route-check-switch'")).toBe(0);
  });

  test("the edit form's field names reach the service; invalid input answers 400 with its field keys", async () => {
    const managerCookie = await staffCookie("manager");
    const gameId = "route-check-switch";
    const page = await run(handler(editLoader), `/admin/catalog/switch-library/${gameId}`, managerCookie, { params: { gameId } });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ can: { manage: true }, entry: { gameId, exists: false } });
    const fields = {
      intent: "save",
      updatedAt: "",
      size: "12,5 GB",
      cartridge: "0",
      sizeAsOf: "",
      price: "$39.99",
      priceAsOf: "",
      trailer: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "description.ar": "وصف قصير من طمطم.",
      "description.en": "",
      "description.ckb": "",
      "metacritic.score": "",
      "metacritic.reviews": "",
      "metacritic.asOf": "",
      hidden: "on",
    };
    const bad = await run(handler(editAction), `/admin/catalog/switch-library/${gameId}`, managerCookie, { method: "POST", body: formData({ ...fields, size: "twelve", "metacritic.score": "101" }), params: { gameId } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, code: "invalid", intent: "save", fields: { size: "size_format", "metacritic.score": "score_range" } });
    const saved = await run(handler(editAction), `/admin/catalog/switch-library/${gameId}`, managerCookie, { method: "POST", body: formData(fields), params: { gameId } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, intent: "save", changed: true, created: true });
    const row = await one<Record<string, unknown>>("SELECT size_bytes, cartridge_bytes, price_usd_cents, trailer_youtube_id, description, is_hidden FROM switch_library_entries WHERE game_id = ?", gameId);
    expect(row).toMatchObject({ size_bytes: bytesFromGiB(12.5), cartridge_bytes: 0, price_usd_cents: 3999, trailer_youtube_id: "dQw4w9WgXcQ", is_hidden: 1 });
    expect(JSON.parse(String(row.description))).toEqual({ ar: "وصف قصير من طمطم." });
    // The same form again (its version is stale now): refused with entry_changed.
    const again = await run(handler(editAction), `/admin/catalog/switch-library/${gameId}`, managerCookie, { method: "POST", body: formData(fields), params: { gameId } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, code: "entry_changed" });
    // An unknown intent is a 400, not a crash.
    expect((await run(handler(editAction), `/admin/catalog/switch-library/${gameId}`, managerCookie, { method: "POST", body: formData({ intent: "drop" }), params: { gameId } })).status).toBe(400);
  });

  test("the import page previews and applies a file; the export is a CSV download; the catalogue's tab is named", async () => {
    const managerCookie = await staffCookie("manager");
    // A file name that would display reversed in the audit views (a right-to-left override inside it).
    const RLO = String.fromCharCode(0x202e);
    const csv = csvFile("game_id,price_usd\nroute-import-switch,4.99\n", `route${RLO}vsc.csv`);
    const preview = await run(handler(importAction), "/admin/catalog/switch-library/import", managerCookie, { method: "POST", body: formData({ intent: "preview", file: csv }) });
    expect(preview.status).toBe(200);
    const plan = (preview.body as { plan: { fingerprint: string; totals: Record<string, number> } }).plan;
    expect(plan.totals).toMatchObject({ rows: 1, create: 1 });
    const applied = await run(handler(importAction), "/admin/catalog/switch-library/import", managerCookie, { method: "POST", body: formData({ intent: "apply", file: csv, fingerprint: plan.fingerprint }) });
    expect(applied.body).toMatchObject({ ok: true, intent: "apply", result: { created: 1, updated: 0 } });
    expect((await one<{ price_usd_cents: number }>("SELECT price_usd_cents FROM switch_library_entries WHERE game_id = 'route-import-switch'")).price_usd_cents).toBe(499);
    // The import's audit id is generated; the file's name is cleaned text, in the summaries only.
    const audit = await one<{ entity_id: string; summary: string }>("SELECT entity_id, summary FROM audit_events WHERE action = 'catalog.switch_library.import_apply' ORDER BY seq DESC LIMIT 1");
    expect(audit).toEqual({ entity_id: `csv_${plan.fingerprint.slice(0, 16)}`, summary: expect.stringMatching(/^routevsc\.csv: 1 game: /) });
    expect((await one<{ summary: string }>("SELECT summary FROM audit_events WHERE action = 'catalog.switch_library.import' AND entity_id = 'route-import-switch'")).summary).toMatch(/^routevsc\.csv line 2: /);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE instr(coalesce(summary, ''), ?) > 0 OR instr(coalesce(entity_id, ''), ?) > 0", RLO, RLO)).toBe(0);

    const sheet = await run(handler(exportLoader), "/admin/catalog/switch-library/export", managerCookie);
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(sheet.headers.get("Cache-Control")).toBe("no-store");
    expect(sheet.headers.get("Content-Disposition")).toMatch(/^attachment; filename="tamtam-switch-library-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(parseCsv(sheet.body as string).rows.some((entry) => entry.cells.game_id === "route-import-switch")).toBe(true);

    const frame = await run(handler(moduleLoader), "/admin/catalog/switch-library", managerCookie);
    expect(frame.body).toMatchObject({ switchLibraryTab: "مكتبة Switch" });
  });

  test("a body past its form's limit is cut off while it is read, declared or not; the upload limit is counted first", async () => {
    const { cookie, id } = await staffSession("manager");
    const importPath = "/admin/catalog/switch-library/import";
    const gameId = "body-limit-switch";
    const editPath = `/admin/catalog/switch-library/${gameId}`;

    // The import: a 3 MB file in a chunked body is cut just past the CSV limit and its fields, and answered without a
    // field key (the shared sentence for it speaks of a picture; the page words the code with its own).
    const csv = streamedUpload("preview", "big.csv", 3 * 1024 * 1024);
    const refusedCsv = await run(handler(importAction), importPath, cookie, { method: "POST", stream: csv.stream });
    expect(refusedCsv).toMatchObject({ status: 413, body: { ok: false, code: "upload_too_large" } });
    expect((refusedCsv.body as { fields?: unknown }).fields).toBeUndefined();
    expect(csv.state.read).toBeLessThanOrEqual(LIBRARY_CSV_MAX_BODY_BYTES + 64 * 1024);

    // The picture: a 9 MB file is cut just past one picture and its fields; the answer sits under the file field.
    const picture = streamedUpload("upload", "big.png", 9 * 1024 * 1024);
    const refusedPicture = await run(handler(editAction), editPath, cookie, { method: "POST", stream: picture.stream, params: { gameId } });
    expect(refusedPicture).toMatchObject({ status: 413, body: { ok: false, code: "upload_too_large", fields: { file: expect.any(String) } } });
    expect(picture.state.read).toBeLessThanOrEqual(MAX_UPLOAD_BODY_BYTES + 64 * 1024);
    // A real picture still goes through the bounded read, and its removal (a plain form) too.
    expect(await run(handler(editAction), editPath, cookie, { method: "POST", body: formData({ intent: "upload", file: png(14) }), params: { gameId } })).toMatchObject({ status: 200, body: { ok: true, intent: "upload", replayed: false } });
    expect(await count("SELECT count(*) AS n FROM switch_library_entries WHERE game_id = ? AND image_file_id IS NOT NULL", gameId)).toBe(1);
    expect(await run(handler(editAction), editPath, cookie, { method: "POST", body: new URLSearchParams({ intent: "remove_image" }), params: { gameId } })).toMatchObject({ status: 200, body: { ok: true, removed: true } });

    // With the upload budget spent, neither page reads a file's body at all…
    const key = await limitKey("upload", "employee", id);
    for (let index = 0; index < RATE_LIMITS.upload.limit; index++) await enforceRateLimit(t.db, key, RATE_LIMITS.upload, Date.now()).catch(() => undefined);
    const untouched: Array<{ fn: unknown; path: string; body: ReturnType<typeof streamedUpload>; params: Record<string, string> }> = [
      { fn: importAction, path: importPath, body: streamedUpload("preview", "any.csv", 1024, { refuse: true }), params: {} },
      { fn: editAction, path: editPath, body: streamedUpload("upload", "any.png", 1024, { refuse: true }), params: { gameId } },
    ];
    for (const attempt of untouched) {
      expect(await run(handler(attempt.fn), attempt.path, cookie, { method: "POST", stream: attempt.body.stream, params: attempt.params })).toMatchObject({ status: 429, body: { ok: false, code: "rate_limited" } });
      expect(attempt.body.state.pulls).toBe(0);
    }
    // …while a save (a plain form, no file) is no upload and goes through.
    const version = (await one<{ updated_at: number }>("SELECT updated_at FROM switch_library_entries WHERE game_id = ?", gameId)).updated_at;
    const save = await run(handler(editAction), editPath, cookie, { method: "POST", body: new URLSearchParams({ intent: "save", updatedAt: String(version), size: "2" }), params: { gameId } });
    expect(save).toMatchObject({ status: 200, body: { ok: true, intent: "save", changed: true, created: false } });
    expect(await one("SELECT size_bytes, image_file_id FROM switch_library_entries WHERE game_id = ?", gameId)).toEqual({ size_bytes: bytesFromGiB(2), image_file_id: null });
  });

  test("the library page carries the storage figures; its action saves them for a manager, keeps field errors as keys, refuses a cashier", async () => {
    const managerCookie = await staffCookie("manager");
    const page = await run(handler(listLoader), "/admin/catalog/switch-library", managerCookie);
    expect(page.status).toBe(200);
    const capacity = (page.body as { capacity: CapacityFigures }).capacity;
    expect(capacity).toMatchObject({ canEdit: true, broken: null });
    const draft = capacityDraft(capacity.inUse);
    const fields: Record<string, string> = { intent: "capacity", expected: JSON.stringify(capacity.expected), reason: "route check", ...Object.fromEntries(CAPACITY_FIELDS.map((field) => [field.name, draft[field.key]])) };

    const bad = await run(handler(listAction), "/admin/catalog/switch-library", managerCookie, { method: "POST", body: formData({ ...fields, "value.cardMargin": "120", reason: "" }) });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ ok: false, intent: "capacity", code: "invalid", fields: { "value.cardMargin": "too_big", reason: "reason_required" } });

    const saved = await run(handler(listAction), "/admin/catalog/switch-library", managerCookie, { method: "POST", body: formData({ ...fields, "value.internalReserveGiB": "1.5" }) });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true, intent: "capacity", changed: true });
    expect((JSON.parse((await one<{ value: string }>("SELECT value FROM settings WHERE key = ?", CAPACITY_SETTING)).value) as CapacityConfig).internalReserveGiB).toBe(1.5);

    // the page it loads next shows them, and the form it held is stale now
    const again = await run(handler(listAction), "/admin/catalog/switch-library", managerCookie, { method: "POST", body: formData({ ...fields, "value.internalReserveGiB": "1.0" }) });
    expect(again).toMatchObject({ status: 409, body: { ok: false, code: "setting_changed" } });

    const cashierCookie = await staffCookie("cashier");
    expect((await run(handler(listLoader), "/admin/catalog/switch-library", cashierCookie)).body).toMatchObject({ capacity: { canEdit: false } });
    const refused = await run(handler(listAction), "/admin/catalog/switch-library", cashierCookie, { method: "POST", body: formData({ ...fields, "value.internalReserveGiB": "1.0" }) });
    expect(refused).toMatchObject({ status: 403, body: { ok: false, code: "forbidden" } });
    expect((await run(handler(listAction), "/admin/catalog/switch-library", managerCookie, { method: "POST", body: formData({ intent: "drop" }) })).status).toBe(400);
  });
});
