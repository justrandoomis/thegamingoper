/**
 * Used marketplace read side (app/server/services/used.server.ts) against a real local D1 with the demo seed.
 *
 * Every expectation is derived from the database (raw SQL over used_units and their joins), never from a unit's slug,
 * so the tests keep holding when the demo units change.
 *
 * Covered: only `listed` units are listed · every filter (platform, model, grade, storage, price, warranty, location)
 * alone and combined, the sorts, paging and its edges · the tolerant URL parser · the facets · the unit page (status
 * rules, checklist labels from the template in three languages, defects, included items, warranty and return window,
 * photos honestly labelled — the demo units' maker photos are illustrations; a real public photo is evidence, a
 * private file never shows) · privacy (no serial, no acquisition cost, no internal location name, no private key) ·
 * buying goes through the cart (addToCart with usedUnitId).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import usedMessages from "~/i18n/messages/used";
import { makeT } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { bindDashes } from "~/routes/storefront/used/names";
import UsedList from "~/routes/storefront/used/used-list";
import UsedUnitPage from "~/routes/storefront/used/used-unit";
import { seedDemo } from "~/server/db/seed/demo";
import { getSetting } from "~/server/settings.server";
import { addToCart } from "~/server/services/cart.server";
import {
  activeFilterCount,
  getOtherUsedUnits,
  getUsedFacets,
  getUsedUnitDetail,
  listUsedUnits,
  parseUsedFilters,
  variantLine,
  type UsedFilters,
  type UsedUnitListItem,
} from "~/server/services/used.server";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
const rows = async <T>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;

type UnitRow = { id: string; slug: string; grade: string; price_iqd: number; warranty_days: number; listed_at: number; status: string; storage: string | null; platform: string | null; model: string | null; serial: string | null; cost: number | null };
let units: UnitRow[] = [];
const listed = () => units.filter((unit) => unit.status === "listed");
const ids = (items: { id: string }[]) => items.map((item) => item.id).sort();

const UNIT_SQL = `SELECT u.id, u.slug, u.grade, u.price_iqd, u.warranty_days, u.listed_at, u.status, json_extract(v.options, '$.storage') AS storage,
    pl.slug AS platform, dm.slug AS model, s.serial, u.acquisition_cost_iqd AS cost
  FROM used_units u JOIN variants v ON v.id = u.variant_id JOIN products p ON p.id = v.product_id
  LEFT JOIN platforms pl ON pl.id = p.platform_id LEFT JOIN device_models dm ON dm.id = p.device_model_id
  LEFT JOIN serials s ON s.id = u.serial_id`;

async function all(filters: UsedFilters, locale: Locale = "ar"): Promise<{ items: UsedUnitListItem[]; total: number }> {
  const items: UsedUnitListItem[] = [];
  let total = -1;
  for (let page = 1; page < 50; page++) {
    const result = await listUsedUnits(t.db, locale, { ...filters, page, limit: 2 });
    if (total === -1) total = result.total;
    expect(result.total).toBe(total);
    items.push(...result.items);
    if (!result.nextCursor) break;
    expect(result.nextCursor).toBe(String(page + 1));
  }
  return { items, total };
}

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
  units = await rows<UnitRow>(UNIT_SQL);
  expect(listed().length).toBeGreaterThanOrEqual(4);
});

afterAll(async () => {
  await t?.dispose();
});

describe("the list", () => {
  test("lists exactly the listed units, newest listing first, with the card's facts", async () => {
    const page = await listUsedUnits(t.db, "ar", {});
    expect(page.total).toBe(listed().length);
    expect(ids(page.items)).toEqual(ids(listed()));
    const order = [...listed()].sort((a, b) => b.listed_at - a.listed_at || (a.id < b.id ? 1 : -1)).map((unit) => unit.id);
    expect(page.items.map((item) => item.id)).toEqual(order);
    for (const item of page.items) {
      const row = units.find((unit) => unit.id === item.id)!;
      expect(item).toMatchObject({ slug: row.slug, grade: row.grade, priceIqd: row.price_iqd, warrantyDays: row.warranty_days, platformSlug: row.platform, storage: row.storage });
      expect(item.name).not.toBe("");
      expect(item.isDemo).toBe(true);
    }
  });

  test("the demo units carry the maker's photo of the model: an illustration, never 'a photo of this unit'", async () => {
    const page = await listUsedUnits(t.db, "ar", {});
    for (const item of page.items) {
      expect(item.hasRealPhotos).toBe(false);
      expect(item.image.isIllustration).toBe(true);
      expect(item.image.artKey ?? "").toMatch(/--\d+$/);
    }
  });

  test("nothing private leaves the service: no serial, no acquisition cost, no internal location name", async () => {
    const page = await listUsedUnits(t.db, "ar", {});
    const facets = await getUsedFacets(t.db, "ar");
    const text = JSON.stringify([page, facets]);
    for (const unit of units) {
      if (unit.serial) expect(text).not.toContain(unit.serial);
      if (unit.cost) expect(text).not.toContain(`:${unit.cost},`);
    }
    const [location] = await rows<{ name: string }>("SELECT name FROM inventory_locations LIMIT 1");
    expect(text).not.toContain(location.name);
    expect(text).not.toMatch(/acquisition|serial|cost/i);
  });

  test("each filter alone matches the database", async () => {
    const sample = listed()[0];
    const cases: [UsedFilters, (unit: UnitRow) => boolean][] = [
      [{ platform: [sample.platform!] }, (unit) => unit.platform === sample.platform],
      [{ model: [sample.model!] }, (unit) => unit.model === sample.model],
      [{ grade: [sample.grade as "A"] }, (unit) => unit.grade === sample.grade],
      [{ grade: ["A+", "C"] }, (unit) => unit.grade === "A+" || unit.grade === "C"],
      [{ storage: [sample.storage!] }, (unit) => unit.storage === sample.storage],
      [{ storage: [sample.storage!.toLowerCase()] }, (unit) => unit.storage === sample.storage],
      [{ priceMin: sample.price_iqd }, (unit) => unit.price_iqd >= sample.price_iqd],
      [{ priceMax: sample.price_iqd }, (unit) => unit.price_iqd <= sample.price_iqd],
      [{ priceMin: sample.price_iqd, priceMax: sample.price_iqd }, (unit) => unit.price_iqd === sample.price_iqd],
      [{ warrantyMin: 30 }, (unit) => unit.warranty_days >= 30],
      [{ warrantyMin: 15 }, (unit) => unit.warranty_days >= 15],
    ];
    for (const [filters, keep] of cases) {
      const { items, total } = await all(filters);
      const expected = listed().filter(keep);
      expect(total, JSON.stringify(filters)).toBe(expected.length);
      expect(ids(items), JSON.stringify(filters)).toEqual(ids(expected));
    }
  });

  test("filters combine (AND across kinds, OR within one); an impossible combination is empty, not an error", async () => {
    const sample = listed()[0];
    const { items } = await all({ platform: [sample.platform!], grade: [sample.grade as "A"], priceMax: sample.price_iqd });
    expect(ids(items)).toEqual(ids(listed().filter((unit) => unit.platform === sample.platform && unit.grade === sample.grade && unit.price_iqd <= sample.price_iqd)));
    expect((await listUsedUnits(t.db, "ar", { priceMin: 999_999_999 })).items).toEqual([]);
    expect((await listUsedUnits(t.db, "ar", { location: ["NOWHERE"] })).total).toBe(0);
  });

  test("sorts by price both ways; pages never repeat or skip; a page past the end is empty with the total", async () => {
    const up = await all({ sort: "price_asc" });
    expect(up.items.map((item) => item.priceIqd)).toEqual([...up.items.map((item) => item.priceIqd)].sort((a, b) => a - b));
    const down = await all({ sort: "price_desc" });
    expect(down.items.map((item) => item.priceIqd)).toEqual([...down.items.map((item) => item.priceIqd)].sort((a, b) => b - a));
    expect(new Set(up.items.map((item) => item.id)).size).toBe(listed().length);
    const past = await listUsedUnits(t.db, "ar", { page: 99 });
    expect(past).toEqual({ items: [], total: listed().length, nextCursor: null });
  });

  test("the URL parser is tolerant: bad values are dropped, a reversed price range is turned round", () => {
    const filters = parseUsedFilters(
      new URLSearchParams("platform=xbox&platform=Bad Value&grade=A%2B&grade=Z&storage=512GB&storage=lots&min=900,000&max=100000&warranty=30&warranty=x&sort=cheap&page=1&location=MAIN"),
    );
    expect(filters).toEqual({ platform: ["xbox"], grade: ["A+"], storage: ["512GB"], location: ["MAIN"], priceMin: 100_000, priceMax: 900_000, warrantyMin: 30 });
    expect(parseUsedFilters(new URLSearchParams("sort=price_desc&page=3"))).toEqual({ sort: "price_desc", page: 3 });
    expect(activeFilterCount(filters)).toBe(7);
  });

  test("facets: what the listed units offer, with counts", async () => {
    const facets = await getUsedFacets(t.db, "en");
    expect(facets.total).toBe(listed().length);
    expect(facets.platforms.reduce((sum, option) => sum + option.count, 0)).toBe(listed().filter((unit) => unit.platform).length);
    expect(facets.grades.map((option) => option.value)).toEqual(["A+", "A", "B", "C"].filter((grade) => listed().some((unit) => unit.grade === grade)));
    expect(facets.price).toEqual({ min: Math.min(...listed().map((unit) => unit.price_iqd)), max: Math.max(...listed().map((unit) => unit.price_iqd)) });
    const sizes = facets.storages.map((option) => option.value);
    const toGb = (value: string) => Number(value.replace(/[^\d.]/g, "")) * (/TB/i.test(value) ? 1024 : 1);
    expect(sizes).toEqual([...sizes].sort((a, b) => toGb(a) - toGb(b)));
    expect(facets.warranties.map((option) => option.days)).toEqual([...new Set(listed().map((unit) => unit.warranty_days))].filter((days) => days > 0).sort((a, b) => a - b));
    // No branch is entered in the demo data, so there is no location to filter by (never an internal warehouse name).
    expect(facets.locations).toEqual([]);
  });
});

describe("one unit", () => {
  test("the page of a listed unit: checklist with the template's words, battery, defects, included, warranty and returns", async () => {
    const unit = listed().find((row) => row.warranty_days > 0)!;
    const [stored] = await rows<{ checklist: string; defects: string; included: string; battery_health_pct: number | null }>("SELECT checklist, defects, included, battery_health_pct FROM used_units WHERE id = ?", unit.id);
    const checklist = JSON.parse(stored.checklist) as { templateId: string; completedAt: number; items: { key: string; result: string | null }[] };
    const [template] = await rows<{ items: string }>("SELECT items FROM inspection_templates WHERE id = ?", checklist.templateId);
    const labels = new Map((JSON.parse(template.items) as { key: string; label: Record<Locale, string> }[]).map((item) => [item.key, item.label]));
    const returnDays = await getSetting(t.db, "returns.window_days");

    for (const locale of ["ar", "en", "ckb"] as const) {
      const detail = await getUsedUnitDetail(t.db, locale, unit.slug);
      expect(detail).toMatchObject({ id: unit.id, status: "listed", priceIqd: unit.price_iqd, warrantyDays: unit.warranty_days, returnDays, isDemo: true, hasRealPhotos: false, inspectedAt: checklist.completedAt, ownershipChecked: true, dataWiped: true });
      expect(detail!.batteryHealthPct).toBe(stored.battery_health_pct);
      // Pass/fail lines only — "not applicable", free-text and battery lines are left out — in the shopper's language.
      const expected = checklist.items.filter((item) => (item.result === "pass" || item.result === "fail") && item.key !== "battery");
      expect(detail!.checklist.map((check) => check.key)).toEqual(expected.map((item) => item.key));
      for (const check of detail!.checklist) expect(check.label).toBe(labels.get(check.key)![locale]);
      expect(detail!.defects.length).toBe((JSON.parse(stored.defects) as unknown[]).length);
      for (const defect of detail!.defects) expect(defect.text).not.toBe("");
      expect(detail!.included.map((item) => item.key)).toEqual((JSON.parse(stored.included) as { key: string }[]).map((item) => item.key));
      expect(detail!.photos.length).toBeGreaterThan(0);
      for (const photo of detail!.photos) expect(photo.isIllustration).toBe(true);
      const text = JSON.stringify(detail);
      if (unit.serial) expect(text).not.toContain(unit.serial);
      expect(text).not.toMatch(/acquisition|serial/i);
    }
    const ar = await getUsedUnitDetail(t.db, "ar", unit.slug);
    const en = await getUsedUnitDetail(t.db, "en", unit.slug);
    expect(ar!.checklist[0].label).not.toBe(en!.checklist[0].label);
    // The new variant's price is shown only as a comparison, and only when the new one costs more.
    if (ar!.newPriceIqd !== null) expect(ar!.newPriceIqd).toBeGreaterThan(ar!.priceIqd);
  });

  test("status rules: reserved and sold still answer (with their state); intake, testing, ready and returned do not", async () => {
    const unit = listed()[listed().length - 1];
    const setStatus = (status: string) => t.d1.prepare("UPDATE used_units SET status = ? WHERE id = ?").bind(status, unit.id).run();
    try {
      await setStatus("reserved");
      expect((await getUsedUnitDetail(t.db, "ar", unit.slug))?.status).toBe("reserved");
      expect(ids((await listUsedUnits(t.db, "ar", {})).items)).not.toContain(unit.id);
      await setStatus("sold");
      expect((await getUsedUnitDetail(t.db, "ar", unit.slug))?.status).toBe("sold");
      for (const status of ["returned", "testing", "ready", "intake"]) {
        await setStatus(status);
        expect(await getUsedUnitDetail(t.db, "ar", unit.slug), status).toBeNull();
      }
    } finally {
      // "sold → listed" is not a move the triggers police (they guard reserved/sold only), so the fixture can be put back.
      await setStatus("listed");
    }
    expect(await getUsedUnitDetail(t.db, "ar", "no-such-unit")).toBeNull();
    expect(await getUsedUnitDetail(t.db, "ar", "../../etc")).toBeNull();
  });

  test("a real, public photo of the unit is evidence and comes first; a private file never shows", async () => {
    const unit = listed()[0];
    await t.d1.batch([
      t.d1.prepare("INSERT INTO files (id, storage_key, visibility, kind, mime, bytes, sha256, width, height, created_at) VALUES ('fil_USEDREALPHOTO0000000000001', 'pub_realphoto000000000001.jpg', 'public', 'used_photo', 'image/jpeg', 10, 'aa', 1200, 900, 0)"),
      t.d1.prepare("INSERT INTO files (id, storage_key, visibility, kind, mime, bytes, sha256, width, height, created_at) VALUES ('fil_USEDPRIVATE00000000000001', 'prv_private0000000000000001.jpg', 'private', 'used_photo', 'image/jpeg', 10, 'bb', 1200, 900, 0)"),
      t.d1.prepare("INSERT INTO media (id, owner_type, owner_id, file_id, kind, is_illustration, sort, created_at) VALUES ('med_USEDREAL1', 'used_unit', ?, 'fil_USEDREALPHOTO0000000000001', 'image', 0, 9, 0)").bind(unit.id),
      t.d1.prepare("INSERT INTO media (id, owner_type, owner_id, file_id, kind, is_illustration, sort, created_at) VALUES ('med_USEDPRIV1', 'used_unit', ?, 'fil_USEDPRIVATE00000000000001', 'image', 0, 0, 0)").bind(unit.id),
    ]);
    try {
      const detail = await getUsedUnitDetail(t.db, "ar", unit.slug);
      expect(detail!.hasRealPhotos).toBe(true);
      expect(detail!.photos[0]).toMatchObject({ mediaKey: "pub_realphoto000000000001.jpg", isIllustration: false, width: 1200, height: 900 });
      expect(JSON.stringify(detail)).not.toContain("prv_private");
      const card = (await listUsedUnits(t.db, "ar", {})).items.find((item) => item.id === unit.id)!;
      expect(card).toMatchObject({ hasRealPhotos: true, image: { mediaKey: "pub_realphoto000000000001.jpg", isIllustration: false } });
    } finally {
      await t.d1.batch([t.d1.prepare("DELETE FROM media WHERE id IN ('med_USEDREAL1', 'med_USEDPRIV1')")]);
    }
  });

  test("other units: never the unit itself, the same platform first", async () => {
    const unit = listed()[0];
    const detail = await getUsedUnitDetail(t.db, "ar", unit.slug);
    const others = await getOtherUsedUnits(t.db, "ar", { id: unit.id, platformSlug: detail!.platform?.slug ?? null }, 8);
    expect(others.map((item) => item.id)).not.toContain(unit.id);
    expect(others.length).toBe(listed().length - 1);
    const firstOther = others.findIndex((item) => item.platformSlug !== detail!.platform?.slug);
    if (firstOther !== -1) expect(others.slice(firstOther).every((item) => item.platformSlug !== detail!.platform?.slug)).toBe(true);
  });

  test("buying goes through the cart: one listed unit, once", async () => {
    const unit = listed()[1];
    const added = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { usedUnitId: unit.id, qty: 1 }, t.now);
    expect(added.added).toBe(1);
    expect(added.view.lines.find((line) => line.usedUnitId === unit.id)).toMatchObject({ kind: "used_unit", qty: 1, maxQty: 1, unitPriceIqd: unit.price_iqd, href: `/used/${unit.slug}` });
  });
});

// ───────────────────────────────────────────────────────────────── review fixes (design v2, P4 review)

/** The unit page as the server renders it (what a shopper without script gets first), with its loader's data. */
function renderUnitPage(loaderData: unknown, locale: Locale = "ar"): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: ":locale?/used/:slug", Component: UsedUnitPage as never }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [`${locale === "ar" ? "" : `/${locale}`}/used/x`],
      hydrationData: {
        loaderData: { root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui", "ui-card", "ui-shop", "ui-overlays") }, page: loaderData as never },
      },
    }),
  );
}

describe("the unit page's states (rendered)", () => {
  test("listed: one add key in the buy box and one in the bar; reserved and sold: the state in words, no add key, the other units", async () => {
    const detail = (await getUsedUnitDetail(t.db, "ar", listed()[0].slug))!;
    const page = (unit: typeof detail) => ({ unit, others: [], device: null, accessories: null, meta: { title: unit.name, description: "", image: null }, i18n: messagesFor("ar", "used", "errors") });

    const listedHtml = renderUnitPage(page(detail));
    expect(listedHtml.match(/أضف إلى السلة/g)?.length).toBe(2);
    expect(listedHtml).not.toContain("شاهد أجهزة أخرى");

    for (const [status, words] of [["reserved", "محجوز لطلب آخر الآن"], ["sold", "بيع هذا الجهاز"]] as const) {
      const html = renderUnitPage(page({ ...detail, status }));
      expect(html, status).toContain(words);
      expect(html, status).not.toContain("أضف إلى السلة");
      expect(html.match(/href="#used-others"/g)?.length, status).toBe(2);
    }
  });

  // Review 2026-11-12: the other-units shelf's retry link was built from location.pathname, which already carries the
  // language prefix — LocaleLink added it again (/en/en/used/…, a 404).
  test("the other units failing: the retry link keeps one language prefix", async () => {
    const detail = (await getUsedUnitDetail(t.db, "en", listed()[0].slug))!;
    const html = renderUnitPage({ unit: detail, others: null, device: null, accessories: null, meta: { title: detail.name, description: "", image: null }, i18n: messagesFor("en", "used", "errors") }, "en");
    expect(html).toContain(`href="/en/used/${detail.slug}"`);
    expect(html).not.toContain("/en/en/");
  });

  // QA 2026-11-12: under the h1 «Nintendo Switch – OLED Model» the fact line said «Nintendo Switch – OLED Model —
  // أبيض» (the name again), and the balanced h1 broke before the dash («– OLED Model» starting the second line).
  test("the line under the name says what the variant adds, never the name again; a dash stays with the word before it", async () => {
    expect(variantLine("Nintendo Switch – OLED Model — أبيض", "Nintendo Switch – OLED Model")).toBe("أبيض");
    expect(variantLine("Nintendo Switch Lite — Turquoise", "Nintendo Switch Lite")).toBe("Turquoise");
    expect(variantLine("Steam Deck OLED 512GB", "Steam Deck OLED")).toBe("512GB");
    expect(variantLine("Legion Go Z1 Extreme 16GB / 512GB", "Lenovo Legion Go (2023)")).toBe("Z1 Extreme 16GB / 512GB");
    expect(variantLine("Xbox Series S ‏512GB، أبيض Robot White", "Xbox Series S")).toBe("512GB، أبيض Robot White");
    expect(variantLine("PlayStation 5 Slim – نسخة الأقراص 1TB", "PlayStation 5 Slim (نسخة الأقراص) – 1TB")).toBeNull();
    expect(variantLine("", "Xbox Series X")).toBeNull();
    expect(variantLine(null, "Xbox Series X")).toBeNull();

    expect(bindDashes("Nintendo Switch – OLED Model")).toBe("Nintendo Switch – OLED Model");
    expect(bindDashes("Pokémon Legends: Z-A – Nintendo Switch 2 Edition")).toBe("Pokémon Legends: Z-A – Nintendo Switch 2 Edition");
    expect(bindDashes("Nintendo Switch – OLED Model — أبيض")).toBe("Nintendo Switch – OLED Model — أبيض");
    expect(bindDashes("Xbox Series X")).toBe("Xbox Series X");

    for (const locale of ["ar", "en", "ckb"] as const) {
      for (const unit of listed()) {
        const detail = (await getUsedUnitDetail(t.db, locale, unit.slug))!;
        if (detail.subtitle) expect(detail.subtitle.includes(detail.name), `${locale} ${unit.slug}: ${detail.subtitle}`).toBe(false);
      }
    }
    const dashed = (await Promise.all(listed().map((unit) => getUsedUnitDetail(t.db, "ar", unit.slug)))).find((detail) => detail?.name.includes(" – "));
    if (dashed) {
      const html = renderUnitPage({ unit: dashed, others: [], device: null, accessories: null, meta: { title: dashed.name, description: "", image: null }, i18n: messagesFor("ar", "used", "errors") });
      // the h1's words (BidiText isolates the Latin runs of a mixed name in <bdi> elements)
      const h1 = html.slice(html.indexOf("<h1"), html.indexOf("</h1>")).replace(/<[^>]*>/g, "");
      expect(h1).toBe(bindDashes(dashed.name));
      expect(html).not.toContain(`${dashed.name} — `);
    }
  });
});

function renderListPage(loaderData: unknown, search = "", locale: Locale = "ar"): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: ":locale?/used", Component: UsedList as never }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [`${locale === "ar" ? "" : `/${locale}`}/used${search}`],
      hydrationData: {
        loaderData: { root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui", "ui-card", "ui-shop", "ui-overlays") }, page: loaderData as never },
      },
    }),
  );
}

describe("the list's states (rendered)", () => {
  // QA 2026-11-12: with filters that match nothing, the title row said «6 أجهزة» while the toolbar said «لا أجهزة», and
  // the one way out («امسح الفلاتر») was a secondary key (v2 §4.23: one primary and one recovery link).
  test("filters that match nothing: no store-wide count in the title row, «امسح الفلاتر» is the primary, with a recovery link", async () => {
    const tUsed = makeT(usedMessages.ar, "ar", "used");
    const facets = (await getUsedFacets(t.db, "ar"))!;
    const page = async (query: string) => {
      const filters = parseUsedFilters(new URLSearchParams(query));
      const list = await listUsedUnits(t.db, "ar", { ...filters, page: 1, limit: 24 });
      return { list, facets, filters, pages: 1, maxPages: 10, pageSize: 24, activeCount: activeFilterCount(filters), meta: { title: "", description: "" }, i18n: messagesFor("ar", "used", "errors") };
    };
    const header = (html: string) => html.slice(html.indexOf("<h1"), html.indexOf("</header>"));
    const storeWide = tUsed("list.count", { count: facets.total, n: String(facets.total) });

    const all = renderListPage(await page(""));
    expect(header(all)).toContain(storeWide);

    const none = await page("max=1");
    expect(none.list.total).toBe(0);
    const html = renderListPage(none, "?max=1");
    expect(header(html)).not.toContain(storeWide);
    expect(html.match(/key--primary/g)?.length).toBe(1);
    expect(html).toMatch(new RegExp(`<a[^>]*class="key key--primary[^"]*"[^>]*>(?:(?!</a>)[\\s\\S])*${tUsed("list.clearFilters")}`));
    expect(html).toContain(tUsed("list.shopNew"));
  });
});
