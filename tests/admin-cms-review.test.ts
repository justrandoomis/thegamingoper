/**
 * Admin module 17 "cms" — the adversarial review (2026-11-12). Each test below failed on the module as it was handed
 * over and passes with the fix; a real local D1 with the demo catalogue (createTestDb + seedDemo), fixtures chosen by
 * their properties.
 *
 *   · redirects and banner links: an absolute address on the store's own host (tamtamgames.com, www., the request's
 *     origin) is the store path it names — it went around every rule (an admin target, a loop A → B → A); a second
 *     language prefix («/ckb/en/admin») is no store path; switching a redirect off a moment after someone else did
 *     wrote a second "switched off" audit event and reported a change that never happened
 *   · every filter chip's count equals the list it opens (banners, redirects, synonym sets, SEO entries)
 *   · a scheduled banner cannot lose its start (the store never shows it, while the admin called it "live")
 *   · a policy cannot be scheduled with an end (approving it with one is refused too: a legal text never lapses on its
 *     own); a withdrawn page keeps its text for the next draft; a landing page's address typed with Arabic-Indic or
 *     Persian digits
 *   · the module's home counts a platform as pinned only when the storefront read returns its pin; the calendar marks a
 *     draft's planned dates and a demo row; an approved policy is revised from its approved text; stopping a pin keeps
 *     its waiting changes
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import type { Db } from "~/server/db/drizzle.server";
import { seedDemo } from "~/server/db/seed/demo";
import { auditEvents, banners, employeeRoles, homeSections, products, redirects } from "~/server/db/schema";
import { isAppError } from "~/server/errors";
import { DEFAULT_ROLES, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { changeBannerStatus, listBanners, saveBanner, type BannerFilters } from "~/server/services/admin/cms/banners.server";
import { getHomeHero, publishHeroPin, saveHeroPin, unpublishHeroPin } from "~/server/services/admin/cms/home.server";
import { getCmsOverview } from "~/server/services/admin/cms/overview.server";
import { archivePage, createLandingPage, getPageEditor, publishPage, savePageDraft, schedulePage, startPageDraft } from "~/server/services/admin/cms/pages.server";
import { listRedirects, resolveRedirect, saveRedirect, setRedirectsActive } from "~/server/services/admin/cms/redirects.server";
import { DAY_MS, baghdadLocal, normalizeStorePath, ownStorePath } from "~/server/services/admin/cms/rules";
import { getSchedule } from "~/server/services/admin/cms/schedule.server";
import { listSynonyms } from "~/server/services/admin/cms/search.server";
import { listSeo } from "~/server/services/admin/cms/seo.server";
import { productReadiness } from "~/server/services/admin/cms/shared.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
let make: Fixtures;
let NOW: number;
let clock: number;
const tick = () => (clock += 1000);

async function failure(run: () => Promise<unknown>): Promise<{ code: string; status: number; fields?: Record<string, string> }> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, status: error.status, fields: error.fields };
    throw error;
  }
  throw new Error("expected the call to fail");
}
const code = async (run: () => Promise<unknown>) => (await failure(run)).code;

/**
 * The database as one service call sees it, with `competitor` run just before that call's write batch — the moment
 * a second person's request lands between what the service read and what it writes.
 */
function beforeBatch(db: Db, competitor: () => Promise<unknown>): Db {
  let fired = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: unknown) => {
          if (!fired) {
            fired = true;
            await competitor();
          }
          return (target.batch as unknown as (input: unknown) => Promise<unknown>).call(target, statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type Staff = { id: string; actor: EmployeeActor };
async function staff(role: DefaultRoleKey | Permission[], name: string): Promise<Staff> {
  const id = await make.employee({ name });
  const permissions = Array.isArray(role) ? role : [...(DEFAULT_ROLES.find((entry) => entry.key === role)?.permissions ?? [])];
  if (!Array.isArray(role)) await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, actor: { kind: "employee", id, permissions: new Set(permissions), label: name } };
}

let owner: Staff;
let content: Staff;
/** A published console the catalogue shows now, with a photo, on a home platform. */
let consoleProduct: { id: string; slug: string; platform: string };

beforeAll(async () => {
  t = await createTestDb();
  NOW = t.now;
  clock = NOW;
  make = fixtures(t.db, NOW);
  await seedDemo(t.db, NOW);
  await seedRoles(t.db, NOW);
  owner = await staff(["*" as Permission], "المالك");
  content = await staff("content", "محتوى");
  const candidates = await t.db.all<{ id: string; slug: string; platform: string; art_key: string | null }>(sql`
    SELECT p.id, p.slug, pl.slug AS platform,
      (SELECT m.art_key FROM media m WHERE m.owner_type = 'product' AND m.owner_id = p.id AND m.art_key IS NOT NULL AND m.kind IN ('image', 'render') LIMIT 1) AS art_key
    FROM products p JOIN platforms pl ON pl.id = p.platform_id
    WHERE p.kind = 'console' AND p.status = 'published' AND pl.slug IN ('nintendo', 'playstation', 'xbox', 'handheld') ORDER BY p.slug`);
  for (const row of candidates) {
    if (row.art_key && (await productReadiness(t.db, row.id, NOW)).ok) {
      consoleProduct = { id: row.id, slug: row.slug, platform: row.platform };
      break;
    }
  }
  if (!consoleProduct) throw new Error("the demo catalogue has no ready console with a photo");
}, 180_000);

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── redirects and links

describe("review: the store's own addresses are store paths", () => {
  test("a redirect to the admin, or a loop, through a full address of the store is refused like the path", async () => {
    // the admin through the canonical host
    expect((await failure(() => saveRedirect(t.db, content.actor, { fromPath: "/review-admin", toPath: "https://tamtamgames.com/admin/login" }, tick()))).fields?.toPath).toBe("path_reserved");
    expect(ownStorePath("https://www.tamtamgames.com/en/P/X?y=1#top")).toBe("/en/P/X?y=1");
    expect(ownStorePath("https://example.com/admin")).toBeNull();
    expect(ownStorePath("https://tamtamgames.com.evil.example/admin")).toBeNull();
    expect(ownStorePath("/admin")).toBeNull();
    // the API through the host this request came to (a preview deployment)
    const origins = ["https://preview.tamtam.workers.dev"];
    expect((await failure(() => saveRedirect(t.db, content.actor, { fromPath: "/review-api", toPath: "https://preview.tamtam.workers.dev/api/cart" }, tick(), { origins }))).fields?.toPath).toBe("path_reserved");
    // A → B through a full address is stored as the path; B → A is then a loop
    const a = await saveRedirect(t.db, content.actor, { fromPath: "/review-loop-a", toPath: "https://www.tamtamgames.com/en/Review-Loop-B/" }, tick());
    expect((await t.db.select().from(redirects).where(eq(redirects.id, a.id)).get())?.toPath).toBe("/review-loop-b");
    expect(await resolveRedirect(t.db, "/review-loop-a")).toMatchObject({ id: a.id, to: "/review-loop-b", external: false });
    expect(await code(() => saveRedirect(t.db, content.actor, { fromPath: "/review-loop-b", toPath: "https://tamtamgames.com/review-loop-a" }, tick()))).toBe("redirect_loop");
    // another site stays an external target
    const out = await saveRedirect(t.db, content.actor, { fromPath: "/review-out", toPath: "https://example.com/x" }, tick());
    expect(await resolveRedirect(t.db, "/review-out")).toMatchObject({ id: out.id, to: "https://example.com/x", external: true });
  });

  test("a banner's link to the admin through a full address of the store is refused", async () => {
    const refused = await failure(() => saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "رابط كامل" }, link: "https://tamtamgames.com/admin/finance" }, tick()));
    expect(refused.fields?.link).toBe("link_reserved");
    const made = await saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "رابط كامل" }, link: "https://www.tamtamgames.com/en/used?x=1" }, tick());
    expect((await t.db.select().from(banners).where(eq(banners.id, made.bannerId)).get())?.link).toBe("/used?x=1");
  });

  test("one language prefix at most: «/ckb/en/admin» is no store path", async () => {
    expect(normalizeStorePath("/ckb/en/admin", { query: true }).ok).toBe(false);
    expect(normalizeStorePath("/en/en/used", { query: false }).ok).toBe(false);
    expect(normalizeStorePath("/en/used", { query: false })).toEqual({ ok: true, path: "/used", query: "" });
    expect((await failure(() => saveRedirect(t.db, content.actor, { fromPath: "/review-double", toPath: "/ckb/en/admin" }, tick()))).fields?.toPath).toBe("path_invalid");
  });

  test("switching a redirect off a moment after someone else did: one change, one audit event", async () => {
    const made = await saveRedirect(t.db, content.actor, { fromPath: "/review-race", toPath: "/used" }, tick());
    const at = tick();
    const raced = beforeBatch(t.db, () => setRedirectsActive(t.db, owner.actor, { ids: [made.id], active: false, reason: "أوقفه الأول" }, at));
    expect(await code(() => setRedirectsActive(raced, content.actor, { ids: [made.id], active: false, reason: "أوقفه الثاني" }, at + 1))).toBe("content_changed");
    const events = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, made.id), eq(auditEvents.action, "cms.redirect.deactivate")));
    expect(events).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────── counts equal their lists

describe("review: every chip's count equals the list it opens", () => {
  test("banners: the selected view's count is the list's total under the placement and words filters", async () => {
    for (const [placement, word] of [["cart", "أ"], ["cart", "ب"], ["home_strip", "ج"]] as const) await saveBanner(t.db, content.actor, { placement, title: { ar: `عدّ المراجعة ${word}` } }, tick());
    const cases: Omit<BannerFilters, "page">[] = [
      { view: "all", placement: "cart", q: "" },
      { view: "draft", placement: "cart", q: "" },
      { view: "draft", placement: null, q: "عدّ المراجعة" },
      { view: "all", placement: "home_strip", q: "عدّ المراجعة" },
    ];
    for (const filters of cases) {
      const list = await listBanners(t.db, content.actor, { ...filters, page: 1 }, "ar", clock);
      expect(list.counts[filters.view], JSON.stringify(filters)).toBe(list.total);
      expect(list.stored).toBeGreaterThanOrEqual(list.total);
    }
  });

  test("redirects, synonym sets and SEO entries: the selected chip's count is the list's total", async () => {
    for (const from of ["/review-count-one", "/review-count-two", "/review-other"]) await saveRedirect(t.db, content.actor, { fromPath: from, toPath: "/support" }, tick());
    const redirectList = await listRedirects(t.db, content.actor, { q: "review-count", state: "all", page: 1 }, clock);
    expect(redirectList.total).toBe(2);
    expect(redirectList.counts.all).toBe(redirectList.total);
    expect(redirectList.counts.active + redirectList.counts.inactive).toBe(redirectList.total);
    expect(redirectList.stored).toBeGreaterThan(redirectList.total);

    // the demo catalogue's synonym sets are all switched on: no Arabic set is off
    const synonyms = await listSynonyms(t.db, owner.actor, { locale: "ar", q: "", state: "inactive", page: 1 });
    expect(synonyms.counts.ar).toBe(synonyms.total);
    const all = await listSynonyms(t.db, owner.actor, { locale: null, q: "", state: "all", page: 1 });
    expect(all.counts.all).toBe(all.total);
    expect(all.stored).toBe(all.total);

    const categories = await listSeo(t.db, content.actor, { type: "category", issue: null, q: "", page: 1 }, "ar");
    expect(categories.counts.all).toBe(categories.total);
    const missing = await listSeo(t.db, content.actor, { type: "category", issue: "description_missing", q: "", page: 1 }, "ar");
    expect(missing.counts.description_missing).toBe(missing.total);
  });
});

// ───────────────────────────────────────────────────────────────── banners

describe("review: a scheduled banner keeps its start", () => {
  test("saving a scheduled banner without a start is refused; a start-less one is never called live", async () => {
    const start = NOW + 3 * DAY_MS;
    const made = await saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "مجدول للمراجعة" } }, tick());
    let row = await t.db.select().from(banners).where(eq(banners.id, made.bannerId)).get();
    await changeBannerStatus(t.db, content.actor, { bannerId: made.bannerId, version: row!.updatedAt, action: "schedule", startsAt: baghdadLocal(start), reason: "موسم" }, tick());
    row = await t.db.select().from(banners).where(eq(banners.id, made.bannerId)).get();
    expect(row?.status).toBe("scheduled");
    const refused = await failure(() => saveBanner(t.db, content.actor, { bannerId: made.bannerId, version: row!.updatedAt, placement: "cart", title: { ar: "مجدول للمراجعة" } }, tick()));
    expect(refused.fields?.startsAt).toBe("required");
    // a row written before the rule: the storefront never shows it, so the admin does not call it live
    await t.db.update(banners).set({ startsAt: null }).where(eq(banners.id, made.bannerId));
    const live = await listBanners(t.db, content.actor, { view: "live", placement: "cart", q: "مجدول للمراجعة", page: 1 }, "ar", clock);
    expect(live.rows.map((entry) => entry.id)).not.toContain(made.bannerId);
  });
});

// ───────────────────────────────────────────────────────────────── pages

describe("review: pages", () => {
  test("a policy cannot be scheduled with an end — approving it with one is refused too", async () => {
    await startPageDraft(t.db, content.actor, { slug: "terms", version: "", reason: "مراجعة الشروط" }, tick(), "demo");
    const editor = await getPageEditor(t.db, content.actor, "terms", "ar", clock, "demo");
    const start = clock + 2 * DAY_MS;
    const refused = await failure(() => schedulePage(t.db, owner.actor, { slug: "terms", version: editor.version, reason: "موعد الشروط", startsAt: baghdadLocal(start), endsAt: baghdadLocal(start + DAY_MS) }, tick()));
    expect(refused.fields?.endsAt).toBe("invalid");
    const scheduled = await schedulePage(t.db, owner.actor, { slug: "terms", version: editor.version, reason: "موعد الشروط", startsAt: baghdadLocal(start) }, tick());
    expect(scheduled.startsAt).toBe(Math.floor(start / 60_000) * 60_000);
  });

  test("a landing page's address typed with Arabic-Indic or Persian digits", async () => {
    expect(await createLandingPage(t.db, content.actor, { slug: "ramadan-٢٠٢٧", titleAr: "رمضان" }, tick())).toEqual({ slug: "ramadan-2027" });
    expect(await createLandingPage(t.db, content.actor, { slug: "eid-۲۰۲۷", titleAr: "العيد" }, tick())).toEqual({ slug: "eid-2027" });
  });

  test("an approved policy is revised from its approved text, not only from the code's draft", async () => {
    await startPageDraft(t.db, content.actor, { slug: "privacy", version: "", reason: "مراجعة الخصوصية" }, tick(), "demo");
    let editor = await getPageEditor(t.db, content.actor, "privacy", "ar", clock, "demo");
    await savePageDraft(t.db, content.actor, { slug: "privacy", version: editor.version, title: { ar: "الخصوصية" }, textAr: "## ما نحفظه\nفقرة كتبها المالك بنفسه.", textEn: "## What we keep\nA paragraph the owner wrote." }, tick());
    editor = await getPageEditor(t.db, content.actor, "privacy", "ar", clock, "demo");
    await publishPage(t.db, owner.actor, { slug: "privacy", version: editor.version, reason: "اعتمده المالك" }, tick());
    editor = await getPageEditor(t.db, content.actor, "privacy", "ar", clock, "demo");
    expect(editor.fromApproved).toBe(true);
    await startPageDraft(t.db, content.actor, { slug: "privacy", version: editor.version, reason: "تعديل صغير", from: "approved" }, tick(), "demo");
    editor = await getPageEditor(t.db, content.actor, "privacy", "ar", clock, "demo");
    expect(editor.text.ar).toContain("فقرة كتبها المالك بنفسه.");
    expect(editor.text.en).toContain("A paragraph the owner wrote.");
    // the code's draft is still there to start again from
    await startPageDraft(t.db, content.actor, { slug: "privacy", version: editor.version, reason: "من الكود" }, tick(), "demo");
    editor = await getPageEditor(t.db, content.actor, "privacy", "ar", clock, "demo");
    expect(editor.text.ar).not.toContain("فقرة كتبها المالك بنفسه.");
    // a policy never approved has no approved text to start from
    expect(await code(() => startPageDraft(t.db, content.actor, { slug: "shipping", version: "", reason: "تجربة", from: "approved" }, tick(), "demo"))).toBe("page_not_live");
  });

  test("withdrawing a page keeps its text: the next draft starts from it", async () => {
    await createLandingPage(t.db, content.actor, { slug: "review-withdrawn", titleAr: "حملة مسحوبة" }, tick());
    let editor = await getPageEditor(t.db, content.actor, "review-withdrawn", "ar", clock, "demo");
    await savePageDraft(t.db, content.actor, { slug: "review-withdrawn", version: editor.version, title: { ar: "حملة مسحوبة" }, textAr: "## نص الحملة\nسطر من النص المعتمد.", textEn: "## The campaign\nA line of the approved text." }, tick());
    editor = await getPageEditor(t.db, content.actor, "review-withdrawn", "ar", clock, "demo");
    await publishPage(t.db, owner.actor, { slug: "review-withdrawn", version: editor.version, reason: "نشر" }, tick());
    editor = await getPageEditor(t.db, content.actor, "review-withdrawn", "ar", clock, "demo");
    await archivePage(t.db, owner.actor, { slug: "review-withdrawn", version: editor.version, reason: "انتهت" }, tick());
    editor = await getPageEditor(t.db, content.actor, "review-withdrawn", "ar", clock, "demo");
    await startPageDraft(t.db, content.actor, { slug: "review-withdrawn", version: editor.version, reason: "نعيدها" }, tick(), "demo");
    editor = await getPageEditor(t.db, content.actor, "review-withdrawn", "ar", clock, "demo");
    expect(editor.source).toBe("draft");
    expect(editor.text.ar).toContain("سطر من النص المعتمد.");
    expect(editor.text.en).toContain("A line of the approved text.");
  });
});

// ───────────────────────────────────────────────────────────────── the calendar

describe("review: the calendar tells a plan from a schedule", () => {
  test("a draft banner's or pin's planned start is marked as a draft, a scheduled one is not", async () => {
    const start = NOW + 4 * DAY_MS;
    const draft = await saveBanner(t.db, content.actor, { placement: "home_strip", title: { ar: "خطة لم تُجدول" }, startsAt: baghdadLocal(start), endsAt: baghdadLocal(start + DAY_MS) }, tick());
    const planned = await saveBanner(t.db, content.actor, { placement: "home_strip", title: { ar: "حملة مجدولة" }, startsAt: baghdadLocal(start), endsAt: baghdadLocal(start + DAY_MS) }, tick());
    const row = await t.db.select().from(banners).where(eq(banners.id, planned.bannerId)).get();
    await changeBannerStatus(t.db, content.actor, { bannerId: planned.bannerId, version: row!.updatedAt, action: "schedule", startsAt: baghdadLocal(start), endsAt: baghdadLocal(start + DAY_MS), reason: "موسم" }, tick());
    const pin = await saveHeroPin(t.db, content.actor, { platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: "تثبيت لم يُنشر" }, startsAt: baghdadLocal(NOW + 70 * DAY_MS), endsAt: baghdadLocal(NOW + 75 * DAY_MS) }, tick());
    const schedule = await getSchedule(t.db, content.actor, { from: null, days: 90 }, "ar", clock);
    const items = schedule.days.flatMap((day) => day.items);
    expect(items.find((item) => item.key === `banner:${draft.bannerId}:start`)?.draft).toBe(true);
    expect(items.find((item) => item.key === `banner:${planned.bannerId}:start`)?.draft).toBe(false);
    expect(items.find((item) => item.key === `pin:${pin.pinId}:start`)?.draft).toBe(true);
    // the module's home lists what comes next the same way
    const next = (await getCmsOverview(t.db, content.actor, "ar", clock)).next;
    for (const item of next) expect(typeof item.draft).toBe("boolean");
  });

  test("a demo banner on the calendar is marked as demo (the storefront never shows it)", async () => {
    const start = NOW + 6 * DAY_MS;
    const demo = await saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "تجريبي مجدول" }, startsAt: baghdadLocal(start) }, tick(), { demo: true });
    const row = await t.db.select().from(banners).where(eq(banners.id, demo.bannerId)).get();
    await changeBannerStatus(t.db, content.actor, { bannerId: demo.bannerId, version: row!.updatedAt, action: "schedule", startsAt: baghdadLocal(start), reason: "تجربة" }, tick());
    const items = (await getSchedule(t.db, content.actor, { from: null, days: 30 }, "ar", clock)).days.flatMap((day) => day.items);
    expect(items.find((item) => item.key === `banner:${demo.bannerId}:start`)?.demo).toBe(true);
    expect(items.filter((item) => item.kind === "product_publish" || item.kind === "preorder_release").every((item) => item.demo === false)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── hero pins

describe("review: stopping a pin keeps its waiting changes", () => {
  test("a published pin with changes waiting is stopped: the draft holds the changed words and period", async () => {
    const platform = consoleProduct.platform;
    const made = await saveHeroPin(t.db, content.actor, { platform, productId: consoleProduct.id, headline: { ar: "عنوان منشور" }, startsAt: baghdadLocal(NOW + 50 * DAY_MS), endsAt: baghdadLocal(NOW + 60 * DAY_MS) }, tick());
    let row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    await publishHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, reason: "حملة" }, tick());
    row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    const changedEnd = NOW + 55 * DAY_MS;
    await saveHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, platform, productId: consoleProduct.id, headline: { ar: "عنوان معدّل" }, startsAt: baghdadLocal(NOW + 50 * DAY_MS), endsAt: baghdadLocal(changedEnd) }, tick());
    row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    await unpublishHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, reason: "أوقفناه" }, tick());
    row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    expect(row?.isActive).toBe(false);
    expect(row?.draftConfig).toBeNull();
    expect((row?.config as { headline?: { ar?: string } } | null)?.headline?.ar).toBe("عنوان معدّل");
    expect(row?.endsAt).toBe(Math.floor(changedEnd / 60_000) * 60_000);
  });
});

// ───────────────────────────────────────────────────────────────── the module's home

describe("review: the module's home", () => {
  test("a platform counts as pinned only while the storefront read returns its pin", async () => {
    const made = await saveHeroPin(
      t.db,
      content.actor,
      { platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: "تثبيت للمراجعة" }, startsAt: baghdadLocal(NOW - DAY_MS), endsAt: baghdadLocal(NOW + 10 * DAY_MS) },
      tick(),
    );
    const row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
    await publishHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, reason: "حملة" }, tick());
    expect((await getCmsOverview(t.db, content.actor, "ar", clock)).pins?.live).toContain(consoleProduct.platform);
    // the catalogue takes the product off the store: the home page falls back to its own hero
    await t.db.update(products).set({ status: "draft" }).where(eq(products.id, consoleProduct.id));
    try {
      expect((await getHomeHero(t.db, clock)).map((pin) => pin.platform)).not.toContain(consoleProduct.platform);
      expect((await getCmsOverview(t.db, content.actor, "ar", clock)).pins?.live).not.toContain(consoleProduct.platform);
    } finally {
      await t.db.update(products).set({ status: "published" }).where(eq(products.id, consoleProduct.id));
    }
  });
});
