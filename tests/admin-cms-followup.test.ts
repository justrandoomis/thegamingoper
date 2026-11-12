/**
 * Admin module 17 "cms" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · a published DEMO hero pin blocked every real pin of its platform for its window (pin_overlap), although the
 *     store never shows a demo pin. Demo pins now compete with demo pins only, real ones with real ones
 *   · getActiveBanners re-checked product links only: a banner pointing at a category, a platform (or a category
 *     filtered by a platform) switched off after it was published kept sending shoppers to a 404
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { seedDemo } from "~/server/db/seed/demo";
import { banners, categories, employeeRoles, homeSections, platforms } from "~/server/db/schema";
import { isAppError } from "~/server/errors";
import { DEFAULT_ROLES, roleId } from "~/server/permissions";
import { changeBannerStatus, getActiveBanners, saveBanner } from "~/server/services/admin/cms/banners.server";
import { publishHeroPin, saveHeroPin } from "~/server/services/admin/cms/home.server";
import { DAY_MS, baghdadLocal } from "~/server/services/admin/cms/rules";
import { productReadiness } from "~/server/services/admin/cms/shared.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
let make: Fixtures;
let NOW: number;
let clock: number;
const tick = () => (clock += 1000);
let content: { id: string; actor: EmployeeActor };
let consoleProduct: { id: string; slug: string; platform: string };

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return "no error";
}

beforeAll(async () => {
  t = await createTestDb();
  NOW = t.now;
  clock = NOW;
  make = fixtures(t.db, NOW);
  await seedDemo(t.db, NOW);
  await seedRoles(t.db, NOW);
  const id = await make.employee({ name: "محتوى" });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId("content") });
  content = { id, actor: { kind: "employee", id, permissions: new Set(DEFAULT_ROLES.find((role) => role.key === "content")?.permissions ?? []), label: "content" } };
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

async function publishedPin(window: { from: number; to: number }, options: { demo?: boolean; headline: string }) {
  const made = await saveHeroPin(t.db, content.actor, { platform: consoleProduct.platform, productId: consoleProduct.id, headline: { ar: options.headline }, startsAt: baghdadLocal(window.from), endsAt: baghdadLocal(window.to) }, tick(), { demo: options.demo });
  const row = await t.db.select().from(homeSections).where(eq(homeSections.id, made.pinId)).get();
  return { pinId: made.pinId, publish: () => publishHeroPin(t.db, content.actor, { pinId: made.pinId, version: row!.updatedAt, reason: "حملة" }, tick()) };
}

describe("admin 17 cms — follow-up", () => {
  test("a published demo pin never blocks a real pin of its platform (and demo pins still block each other)", async () => {
    const window = { from: NOW + 80 * DAY_MS, to: NOW + 85 * DAY_MS };
    const demo = await publishedPin(window, { demo: true, headline: "تثبيت تجريبي" });
    await demo.publish();
    const real = await publishedPin(window, { headline: "تثبيت حقيقي" });
    expect(await codeOf(real.publish)).toBe("no error");
    const secondDemo = await publishedPin(window, { demo: true, headline: "تجريبي ثانٍ" });
    expect(await codeOf(secondDemo.publish)).toBe("pin_overlap");
    const secondReal = await publishedPin(window, { headline: "حقيقي ثانٍ" });
    expect(await codeOf(secondReal.publish)).toBe("pin_overlap");
  });

  test("review 2026-11-12: a banner is never published with a platform filter the store would drop (the serve-time rule, at publishing)", async () => {
    const category = await t.db.select({ slug: categories.slug }).from(categories).where(eq(categories.isActive, true)).get();
    const off = await t.db.select({ id: platforms.id, slug: platforms.slug }).from(platforms).where(and(eq(platforms.isActive, true), eq(platforms.slug, consoleProduct.platform))).get();
    if (!category || !off) throw new Error("the demo catalogue has no active category or platform");
    const tryPublish = async (link: string) => {
      const at = tick();
      const made = await saveBanner(t.db, content.actor, { placement: "cart", title: { ar: "فلتر منصة" }, link }, at);
      return codeOf(() => changeBannerStatus(t.db, content.actor, { bannerId: made.bannerId, version: at, action: "publish", reason: "حملة" }, tick()));
    };
    // a typo: no such platform — getActiveBanners would never serve it, so it is refused when published
    expect(await tryPublish(`/c/${category.slug}?platform=no-such-platform`)).toBe("link_missing");
    // a platform switched off
    await t.db.update(platforms).set({ isActive: false }).where(eq(platforms.id, off.id));
    try {
      expect(await tryPublish(`/c/${category.slug}?platform=${off.slug}`)).toBe("link_missing");
    } finally {
      await t.db.update(platforms).set({ isActive: true }).where(eq(platforms.id, off.id));
    }
    // a live one: published (and served)
    expect(await tryPublish(`/c/${category.slug}?platform=${off.slug}`)).toBe("no error");
  });

  test("a banner whose category, platform or platform filter was switched off after publishing is no longer served", async () => {
    const category = await t.db.select({ id: categories.id, slug: categories.slug }).from(categories).where(eq(categories.isActive, true)).get();
    const platform = await t.db.select({ id: platforms.id, slug: platforms.slug }).from(platforms).where(and(eq(platforms.isActive, true), eq(platforms.slug, consoleProduct.platform))).get();
    if (!category || !platform) throw new Error("the demo catalogue has no active category or platform");
    const publish = async (title: string, link: string) => {
      const at = tick();
      const made = await saveBanner(t.db, content.actor, { placement: "cart", title: { ar: title }, link }, at);
      await changeBannerStatus(t.db, content.actor, { bannerId: made.bannerId, version: at, action: "publish", reason: "حملة" }, tick());
      return made.bannerId;
    };
    const toCategory = await publish("فئة", `/c/${category.slug}`);
    const toFiltered = await publish("فئة بمنصة", `/c/${category.slug}?platform=${platform.slug}`);
    const served = async () => (await getActiveBanners(t.db, "ar", "cart", { now: clock })).map((banner) => banner.id);
    expect(await served()).toEqual(expect.arrayContaining([toCategory, toFiltered]));
    try {
      // the platform goes off: the filtered link would 404; the plain category link still works
      await t.db.update(platforms).set({ isActive: false }).where(eq(platforms.id, platform.id));
      expect(await served()).toContain(toCategory);
      expect(await served()).not.toContain(toFiltered);
      // the category goes off: neither is served
      await t.db.update(categories).set({ isActive: false }).where(eq(categories.id, category.id));
      expect(await served()).not.toContain(toCategory);
    } finally {
      await t.db.update(platforms).set({ isActive: true }).where(eq(platforms.id, platform.id));
      await t.db.update(categories).set({ isActive: true }).where(eq(categories.id, category.id));
      await t.db.update(banners).set({ status: "archived" }).where(eq(banners.id, toCategory));
      await t.db.update(banners).set({ status: "archived" }).where(eq(banners.id, toFiltered));
    }
  });
});
