/**
 * Switch bundle builder — TamTam's own per-game data (docs/switch-builder.md §4.2).
 *
 *   · getLibraryExtras maps switch_library_entries rows to LibraryExtras: bytes, cents, YYYY-MM-DD dates, the YouTube
 *     id, TamTam's descriptions, a licensed Metacritic score only with its review count and date
 *   · a hidden game is `{ hidden: true }` and nothing else: no picture, trailer, text, price, size or score of it
 *     leaves the server (qa-security 2026-11-21)
 *   · the picture is the PUBLIC file's storage key (+ width/height); a private or deleted file is never exposed
 *   · `rev` changes on every save, on a new row, on a removed row and on a capacity change
 *   · `capacity` = sanitizeCapacity(setting builder.switch.capacity): the default, a staff value, and a stored value
 *     that does not fit (or is not even JSON) falling back field by field instead of breaking the builder
 *   · getLibraryPrices, the quote's read: the price and the hidden flag of the games asked for only, mapped as
 *     getLibraryExtras maps them, so a quote from it equals a quote from the whole payload
 *   · GET /api/switch-library answers the payload as public JSON for a minute; past 60 uncached reads a minute from
 *     one address it answers 429 (no-store, Retry-After); a request without a client address is never counted
 */
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { DEFAULT_CAPACITY, sanitizeCapacity } from "~/lib/switch-builder/storage";
import type { BuilderPlan, LibraryExtrasPayload } from "~/lib/switch-builder/types";
import { loader } from "~/routes/api/switch-library";
import { quoteBuilderPlan } from "~/routes/storefront/builder/builder.server";
import type { EmployeeActor } from "~/server/actor";
import { requestContextMiddleware } from "~/server/context.server";
import { files, settings, switchLibraryEntries, type NewSwitchLibraryEntry } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { CAPACITY_SETTING, getLibraryExtras, getLibraryPrices } from "~/server/services/switch-library.server";
import { SETTINGS, settingDefault, setSetting } from "~/server/settings.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";

const NOW = TEST_NOW;
const GIB = 1024 ** 3;
const staff: EmployeeActor = { kind: "employee", id: "emp_switch_library_test", permissions: ["settings.read", "settings.manage"], label: "staff" };
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function addFile(id: string, storageKey: string, visibility: "public" | "private", extra: Partial<typeof files.$inferInsert> = {}) {
  await t.db.insert(files).values({ id, storageKey, visibility, kind: "switch_library_image", mime: "image/webp", bytes: 48_000, sha256: "a".repeat(64), width: 1280, height: 720, createdAt: NOW, ...extra });
}
async function addEntry(values: Partial<NewSwitchLibraryEntry> & { gameId: string }) {
  await t.db.insert(switchLibraryEntries).values({ createdAt: NOW, updatedAt: NOW, ...values });
}

describe("getLibraryExtras", () => {
  test("no rows yet: no extras, rev 0-0, the default capacity", async () => {
    const payload = await getLibraryExtras(t.db);
    expect(payload).toEqual({ rev: "0-0", extras: {}, capacity: DEFAULT_CAPACITY });
    expect(settingDefault(CAPACITY_SETTING)).toEqual(DEFAULT_CAPACITY);
    expect(SETTINGS[CAPACITY_SETTING].public).toBe(false);
  });

  test("rows become LibraryExtras; a hidden game is the flag alone; only a public, kept picture is exposed", async () => {
    await addFile("fil_sl_public", "pub_switchlibrarytest0001.webp", "public");
    await addFile("fil_sl_private", "prv_switchlibrarytest0002.webp", "private");
    await addFile("fil_sl_deleted", "pub_switchlibrarytest0003.webp", "public", { deletedAt: NOW });
    await addFile("fil_sl_hidden", "pub_switchlibrarytest0004.webp", "public");
    await addEntry({
      gameId: "hades-switch",
      sizeBytes: Math.round(15.4 * GIB),
      cartridgeBytes: Math.round(1.2 * GIB),
      sizeAsOf: "2026-11-20",
      priceUsdCents: 2499,
      priceAsOf: "2026-11-19",
      trailerYoutubeId: "591V2ITxR1w",
      imageFileId: "fil_sl_public",
      description: { ar: "  لعبة أكشن من Supergiant Games  ", en: "An action game by Supergiant Games.", ckb: "" },
      metacriticScore: 93,
      metacriticReviews: 51,
      metacriticAsOf: "2026-11-18",
      updatedAt: NOW + 10,
    });
    // hidden because its picture, trailer and text had to come down: everything set, a public picture included
    await addEntry({
      gameId: "delisted-game-switch",
      isHidden: true,
      sizeBytes: 4 * GIB,
      cartridgeBytes: GIB,
      sizeAsOf: "2026-11-20",
      priceUsdCents: 1999,
      priceAsOf: "2026-11-20",
      trailerYoutubeId: "dQw4w9WgXcQ",
      imageFileId: "fil_sl_hidden",
      description: { ar: "وصف لعبة سُحبت من المتجر", en: "A game taken down from the store.", ckb: "وەسفی یارییەکی لابراو" },
      metacriticScore: 70,
      metacriticReviews: 12,
      metacriticAsOf: "2026-11-18",
    });
    await addEntry({ gameId: "private-picture-switch", sizeBytes: 2 * GIB, imageFileId: "fil_sl_private", trailerYoutubeId: "not a video id", description: { ar: " ", en: "" } });
    await addEntry({ gameId: "deleted-picture-switch", priceUsdCents: 0, priceAsOf: "2026-02-30", imageFileId: "fil_sl_deleted" });
    // a score without its review count and date is not shown (no invented figures); reviews without a score neither
    await addEntry({ gameId: "score-only-switch", metacriticScore: 80, sizeAsOf: "2026-11-21T08:00:00.000Z" });
    await addEntry({ gameId: "reviews-only-switch", metacriticReviews: 12, metacriticAsOf: "2026-11-01" });
    await addEntry({ gameId: "nothing-yet-switch" });

    const { rev, extras } = await getLibraryExtras(t.db);
    expect(rev).toBe(`${NOW + 10}-7`);
    expect(extras["hades-switch"]).toEqual({
      sizeBytes: Math.round(15.4 * GIB),
      cartridgeBytes: Math.round(1.2 * GIB),
      sizeAsOf: "2026-11-20",
      priceUsdCents: 2499,
      priceAsOf: "2026-11-19",
      trailerYouTubeId: "591V2ITxR1w",
      imageKey: "pub_switchlibrarytest0001.webp",
      imageWidth: 1280,
      imageHeight: 720,
      description: { ar: "لعبة أكشن من Supergiant Games", en: "An action game by Supergiant Games." },
      metacritic: { score: 93, reviews: 51, asOf: "2026-11-18" },
    });
    // hidden: included, flagged — and nothing else of it leaves the server
    expect(extras["delisted-game-switch"]).toEqual({ hidden: true });
    const sent = JSON.stringify(await getLibraryExtras(t.db));
    for (const piece of ["switchlibrarytest0004", "dQw4w9WgXcQ", "سُحبت", "taken down", "لابراو"]) expect(sent).not.toContain(piece);
    expect(extras["private-picture-switch"]).toEqual({ sizeBytes: 2 * GIB });
    // a deleted picture and an impossible date are left out; a price of 0 cents is a real price
    expect(extras["deleted-picture-switch"]).toEqual({ priceUsdCents: 0 });
    expect(extras["score-only-switch"]).toEqual({ sizeAsOf: "2026-11-21" });
    expect(extras["reviews-only-switch"]).toBeUndefined();
    expect(extras["nothing-yet-switch"]).toBeUndefined();
    expect(JSON.stringify(extras)).not.toContain("prv_");
  });

  test("rev changes on a save, a new row and a removed row", async () => {
    const seen = new Set<string>();
    const rev = async () => (await getLibraryExtras(t.db)).rev;
    seen.add(await rev());
    await t.db.update(switchLibraryEntries).set({ sizeBytes: 3 * GIB, updatedAt: NOW + 20 }).where(eq(switchLibraryEntries.gameId, "private-picture-switch"));
    seen.add(await rev());
    await addEntry({ gameId: "new-row-switch", sizeBytes: GIB, updatedAt: NOW + 5 });
    seen.add(await rev());
    await t.db.delete(switchLibraryEntries).where(eq(switchLibraryEntries.gameId, "new-row-switch"));
    seen.add(await rev());
    expect(seen.size).toBe(3); // removing the new row brings back the state before it — the same rev, rightly
    expect([...seen]).toEqual([`${NOW + 10}-7`, `${NOW + 20}-7`, `${NOW + 20}-8`]);
    expect((await getLibraryExtras(t.db)).extras["private-picture-switch"]?.sizeBytes).toBe(3 * GIB);
  });
});

describe("capacity: setting builder.switch.capacity", () => {
  const staffValue = {
    internalUsableGiB: { "switch-oled": 54.6, switch: 25.4, "switch-lite": 25.4 },
    internalReserveGiB: 1.5,
    cardMargin: 0.98,
    cardHeadroom: { fraction: 0.04, minGiB: 2, maxGiB: 6 },
  };

  test("a staff value is served and changes rev; values outside the bounds are refused when saved", async () => {
    const before = await getLibraryExtras(t.db);
    await setSetting(t.db, staff, CAPACITY_SETTING, staffValue, "قراءة من جهاز OLED في المتجر", NOW + 100);
    const after = await getLibraryExtras(t.db);
    expect(after.capacity).toEqual(staffValue);
    expect(after.rev).not.toBe(before.rev);
    expect(after.rev).toBe(`${NOW + 100}-7`);

    const refused = async (value: unknown) => {
      try {
        await setSetting(t.db, staff, CAPACITY_SETTING, value, "قيمة خاطئة", NOW + 101);
        return null;
      } catch (error) {
        return toAppError(error)?.fields ?? null;
      }
    };
    expect(await refused({ ...staffValue, cardMargin: 1.5 })).toMatchObject({ "value.cardMargin": "too_big" });
    expect(await refused({ ...staffValue, internalUsableGiB: { ...staffValue.internalUsableGiB, switch: 40 } })).toMatchObject({ "value.internalUsableGiB.switch": "too_big" });
    expect(await refused({ ...staffValue, cardHeadroom: { fraction: 0.05, minGiB: 8, maxGiB: 2 } })).toMatchObject({ "value.cardHeadroom.maxGiB": "below_paired" });
    expect((await getLibraryExtras(t.db)).capacity).toEqual(staffValue);
  });

  test("a stored value that does not fit is sanitised field by field; text that is not JSON gives the defaults", async () => {
    const broken = { internalUsableGiB: { switch: 20, "switch-oled": 900 }, cardMargin: 5, cardHeadroom: { minGiB: 9, maxGiB: 3 }, extra: true };
    await t.db.update(settings).set({ value: broken, updatedAt: NOW + 200 }).where(eq(settings.key, CAPACITY_SETTING));
    const payload: LibraryExtrasPayload = await getLibraryExtras(t.db);
    expect(payload.capacity).toEqual(sanitizeCapacity(broken));
    expect(payload.capacity).toEqual({
      internalUsableGiB: { "switch-oled": DEFAULT_CAPACITY.internalUsableGiB["switch-oled"], switch: 20, "switch-lite": DEFAULT_CAPACITY.internalUsableGiB["switch-lite"] },
      internalReserveGiB: DEFAULT_CAPACITY.internalReserveGiB,
      cardMargin: DEFAULT_CAPACITY.cardMargin,
      cardHeadroom: { fraction: DEFAULT_CAPACITY.cardHeadroom.fraction, minGiB: 3, maxGiB: 9 },
    });
    expect(payload.rev).toBe(`${NOW + 200}-7`);

    await t.d1.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?").bind("{not json", NOW + 300, CAPACITY_SETTING).run();
    expect((await getLibraryExtras(t.db)).capacity).toEqual(DEFAULT_CAPACITY);
    await t.db.delete(settings).where(eq(settings.key, CAPACITY_SETTING));
    expect((await getLibraryExtras(t.db)).capacity).toEqual(DEFAULT_CAPACITY);
  });
});

describe("getLibraryPrices: the quote's read", () => {
  test("the price and the hidden flag of the games asked for, mapped as the payload maps them", async () => {
    const asked = ["hades-switch", "delisted-game-switch", "deleted-picture-switch", "private-picture-switch", "not-in-the-table-switch", "hades-switch", ""];
    const prices = await getLibraryPrices(t.db, asked);
    expect(prices).toEqual({
      "hades-switch": { priceUsdCents: 2499, priceAsOf: "2026-11-19" },
      "delisted-game-switch": { hidden: true },
      "deleted-picture-switch": { priceUsdCents: 0 },
    });
    // the same figures as the whole payload, field by field
    const { extras } = await getLibraryExtras(t.db);
    for (const [id, entry] of Object.entries(prices)) {
      const whole = extras[id];
      expect(entry, id).toEqual(whole?.hidden ? { hidden: true } : { ...(whole?.priceUsdCents !== undefined ? { priceUsdCents: whole.priceUsdCents } : {}), ...(whole?.priceAsOf ? { priceAsOf: whole.priceAsOf } : {}) });
    }
    expect(await getLibraryPrices(t.db, [])).toEqual({});
    // more ids than D1 binds in one statement: still one bound value
    const many = Array.from({ length: 119 }, (_, index) => `filler-${index}-switch`).concat("hades-switch");
    expect(await getLibraryPrices(t.db, many)).toEqual({ "hades-switch": { priceUsdCents: 2499, priceAsOf: "2026-11-19" } });
  });

  test("a quote from it equals a quote from the whole payload", async () => {
    const plan: BuilderPlan = {
      v: 1,
      device: { model: "switch-oled", owned: true },
      card: { sizeGB: 256, owned: true },
      games: ["hades-switch", "delisted-game-switch", "deleted-picture-switch", "private-picture-switch", "not-in-the-table-switch"].map((id) => ({ id, format: "digital" as const })),
    };
    const narrow = await quoteBuilderPlan(t.db, "ar", plan, await getLibraryPrices(t.db, plan.games.map((game) => game.id)), NOW);
    const whole = await quoteBuilderPlan(t.db, "ar", plan, (await getLibraryExtras(t.db)).extras, NOW);
    expect(narrow).toEqual(whole);
    expect(narrow.digital).toMatchObject({ pricedCents: 2499, pricedCount: 1 });
    expect(narrow.digital.unpricedIds).toEqual(["delisted-game-switch", "deleted-picture-switch", "private-picture-switch", "not-in-the-table-switch"]);
  });
});

/** GET /api/switch-library behind the real request middleware (client address, clock); `ip` null = no client address. */
async function getLibrary(ip: string | null, path = "/api/switch-library") {
  const request = new Request(`http://localhost:5173${path}`, { headers: ip ? { "CF-Connecting-IP": ip } : {} });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  return (await requestContextMiddleware({ request, context, url, pattern: "/api/switch-library", params: {} } as never, async () => {
    return (await loader({ request, context, params: {}, url, pattern: "/api/switch-library" } as never)) as Response;
  })) as Response;
}

describe("GET /api/switch-library", () => {
  test("answers the payload as public JSON for a minute", async () => {
    const response = await getLibrary("192.0.2.10");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(await getLibraryExtras(t.db))));
  });

  test("past 60 uncached reads a minute from one address: 429, never kept; other addresses and the cache's own refresh go on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // the middle of a one-minute window, so the 61 requests share it
    vi.setSystemTime(Date.UTC(2026, 10, 21, 12, 0, 20));
    try {
      for (let index = 0; index < 60; index++) expect((await getLibrary("203.0.113.9", index % 2 === 0 ? "/api/switch-library?x=1" : "/api/switch-library")).status).toBe(200);
      const refused = await getLibrary("203.0.113.9");
      expect(refused.status).toBe(429);
      expect(refused.headers.get("Cache-Control")).toBe("no-store");
      expect(Number(refused.headers.get("Retry-After"))).toBe(40);
      expect(await refused.json()).toEqual({ error: "rate_limited" });
      expect((await getLibrary("203.0.113.10")).status).toBe(200);
      // the edge cache refreshes a copy with a request of its own, which carries no client address
      expect((await getLibrary(null)).status).toBe(200);
      vi.setSystemTime(Date.UTC(2026, 10, 21, 12, 1, 0));
      expect((await getLibrary("203.0.113.9")).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
