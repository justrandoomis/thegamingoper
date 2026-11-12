/**
 * Admin 17 — the module's home: what is live, what waits for a decision (drafts to approve, policies still served
 * as code drafts, waiting pin changes, a navigation draft), and what comes next. Each block only for an employee who
 * may open its section (cmsAccess); nothing is counted for someone who could not act on it.
 */
import { sql } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import { listPolicies } from "~/server/services/content.server";
import { getHomeHero } from "./home.server";
import { HERO_PIN_KIND, HERO_PLATFORMS, NAV_MENU_KEY, POLICIES_HERE } from "./rules";
import { getSchedule, type ScheduleItem } from "./schedule.server";
import { countActiveRedirects } from "./redirects.server";
import { countActiveSynonyms, countZeroResultQueries } from "./search.server";
import { cmsAccess, type CmsAccess } from "./shared.server";

const CMS_PERMISSIONS = ["cms.banner.manage", "cms.home.manage", "cms.page.manage", "cms.page.publish", "cms.navigation.manage", "cms.seo.manage", "cms.redirect.manage", "cms.search.manage", "cms.device_hub.manage", "cms.media.moderate", "cms.motion.manage"] as const;

export type CmsOverview = {
  access: CmsAccess;
  pages: { approved: number; total: number; mineAwaiting: number; drafts: number } | null;
  banners: { live: number; upcoming: number } | null;
  pins: { live: string[]; waiting: number; drafts: number } | null;
  search: { zero7: number; synonyms: number } | null;
  redirects: { active: number } | null;
  nav: { hasDraft: boolean; hasPublished: boolean } | null;
  next: ScheduleItem[];
};

export async function getCmsOverview(db: Db, actor: Actor, locale: Locale, now: number): Promise<CmsOverview> {
  if (!canAny(actor, [...CMS_PERMISSIONS])) throw forbidden("cms.page.manage");
  const access = cmsAccess(actor);
  const [policies, drafts, banners, pins, heroes, zero7, synonyms, redirects, nav, schedule] = await Promise.all([
    access.pages ? listPolicies(db, locale, { now }) : Promise.resolve(null),
    access.pages ? db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM pages WHERE draft IS NOT NULL`) : Promise.resolve(null),
    access.banners
      ? db.all<{ live: number; upcoming: number }>(sql`SELECT
          COALESCE(SUM(CASE WHEN status IN ('published', 'scheduled') AND (starts_at IS NULL OR starts_at <= ${now}) AND (ends_at IS NULL OR ends_at > ${now}) AND (status = 'published' OR starts_at IS NOT NULL) THEN 1 ELSE 0 END), 0) AS live,
          COALESCE(SUM(CASE WHEN status IN ('published', 'scheduled') AND starts_at > ${now} THEN 1 ELSE 0 END), 0) AS upcoming
          FROM banners WHERE is_demo = 0`)
      : Promise.resolve(null),
    access.home ? db.all<{ is_active: number; staged: number }>(sql`SELECT is_active, draft_config IS NOT NULL AS staged FROM home_sections WHERE kind = ${HERO_PIN_KIND}`) : Promise.resolve(null),
    // the platforms the storefront's own read pins now (not demo, inside the window, product on the store) — a pin
    // whose product left the catalogue is no pinned hero (review 2026-11-12)
    access.home ? getHomeHero(db, now) : Promise.resolve(null),
    access.search ? countZeroResultQueries(db, now, 7) : Promise.resolve(null),
    access.search ? countActiveSynonyms(db) : Promise.resolve(null),
    access.redirects ? countActiveRedirects(db) : Promise.resolve(null),
    access.navigation ? db.all<{ draft: number; items: string | null }>(sql`SELECT draft_items IS NOT NULL AS draft, items FROM nav_menus WHERE key = ${NAV_MENU_KEY}`) : Promise.resolve(null),
    access.schedule ? getSchedule(db, actor, { from: null, days: 14 }, locale, now) : Promise.resolve(null),
  ]);
  const mine = policies?.filter((policy) => (POLICIES_HERE as readonly string[]).includes(policy.slug)) ?? [];
  return {
    access,
    pages: policies ? { approved: policies.filter((policy) => policy.approved).length, total: policies.length, mineAwaiting: mine.filter((policy) => !policy.approved).length, drafts: Number(drafts?.[0]?.n ?? 0) } : null,
    banners: banners ? { live: Number(banners[0]?.live ?? 0), upcoming: Number(banners[0]?.upcoming ?? 0) } : null,
    pins: pins
      ? {
          live: HERO_PLATFORMS.filter((platform) => (heroes ?? []).some((hero) => hero.platform === platform)),
          waiting: pins.filter((pin) => Number(pin.staged) === 1).length,
          drafts: pins.filter((pin) => Number(pin.is_active) === 0).length,
        }
      : null,
    search: zero7 !== null && synonyms !== null ? { zero7, synonyms } : null,
    redirects: redirects !== null ? { active: redirects } : null,
    nav: nav ? { hasDraft: Number(nav[0]?.draft ?? 0) === 1, hasPublished: Boolean(nav[0]?.items && nav[0].items !== "[]") } : null,
    next: schedule ? [...schedule.days.flatMap((day) => day.items)].slice(0, 6) : [],
  };
}
