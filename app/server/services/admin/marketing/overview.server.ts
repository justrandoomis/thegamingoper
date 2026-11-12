/**
 * Admin 16 — the module's front page and its queues: what waits for this employee's decision, and each section's
 * figures counted from its tables (only the sections the employee may open; null otherwise, never 0).
 *
 *   marketingOverview(db, actor, now)       any marketing permission
 *   marketingQueueCounts(db, actor, now)    for the shell's bell (asked of the shell owner): each null when it does not concern the employee
 *
 * Every figure counts REAL records: a demo campaign, its links and its recipients, and a demo customer's cart
 * reminders never count (the campaigns card says how many demo campaigns were left out). The "due" figure is the
 * campaign list's "due" view, row for row.
 */
import { sql } from "drizzle-orm";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { countDecidableCampaigns, countDueCampaigns } from "./campaigns.server";
import { pendingReviewCount } from "./reviews.server";
import { assertAny, marketingAccess, MARKETING_PERMISSIONS, num } from "./shared.server";
import { DAY_MS } from "./types";

export type MarketingOverview = {
  decide: number | null;
  due: number | null;
  reviews: number | null;
  /** Real campaigns only (demo ones never count in a figure); `demo` = how many demo campaigns were left out. */
  campaigns: { drafts: number; scheduled: number; released: number; held: number; demo: number } | null;
  carts: { remindedThisWeek: number } | null;
  links: { total: number; attributedOrders: number } | null;
  rules: { active: number } | null;
  spend: { campaigns: number } | null;
};

export async function marketingOverview(db: Db, actor: Actor, now: number): Promise<MarketingOverview> {
  assertAny(actor, MARKETING_PERMISSIONS);
  const access = marketingAccess(actor);
  const [decide, reviews, due, campaignCounts, carts, links, rules, spend] = await Promise.all([
    countDecidableCampaigns(db, actor),
    pendingReviewCount(db, actor),
    can(actor, "marketing.campaign.send") ? countDueCampaigns(db, now) : Promise.resolve(null),
    access.campaigns
      ? db.all<{ drafts: number; scheduled: number; released: number; held: number; demo: number }>(sql`
          SELECT SUM(CASE WHEN is_demo = 0 AND status = 'draft' THEN 1 ELSE 0 END) AS drafts, SUM(CASE WHEN is_demo = 0 AND status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
            SUM(CASE WHEN is_demo = 0 AND status IN ('sending', 'sent', 'paused') THEN 1 ELSE 0 END) AS released,
            (SELECT COUNT(*) FROM campaign_recipients r JOIN campaigns c2 ON c2.id = r.campaign_id WHERE r.status = 'held' AND c2.is_demo = 0) AS held,
            SUM(CASE WHEN is_demo = 1 THEN 1 ELSE 0 END) AS demo
          FROM campaigns`)
      : Promise.resolve(null),
    access.carts
      ? db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM cart_reminders cr LEFT JOIN customers cu ON cu.id = cr.customer_id WHERE cr.created_at > ${now - 7 * DAY_MS} AND (cu.is_demo IS NULL OR cu.is_demo = 0)`)
      : Promise.resolve(null),
    access.links
      ? db.all<{ total: number; attributed: number }>(sql`
          SELECT (SELECT COUNT(*) FROM utm_links l LEFT JOIN campaigns c ON c.id = l.campaign_id WHERE c.is_demo IS NULL OR c.is_demo = 0) AS total,
            (SELECT COUNT(*) FROM orders WHERE is_demo = 0 AND (utm_link_id IS NOT NULL OR attribution IS NOT NULL)) AS attributed`)
      : Promise.resolve(null),
    access.crossSell ? db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM recommendation_rules WHERE is_active = 1`) : Promise.resolve(null),
    access.performance ? db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM campaigns WHERE is_demo = 0 AND spend_iqd <> 0`) : Promise.resolve(null),
  ]);
  return {
    decide,
    due,
    reviews,
    campaigns: campaignCounts
      ? { drafts: num(campaignCounts[0]?.drafts), scheduled: num(campaignCounts[0]?.scheduled), released: num(campaignCounts[0]?.released), held: num(campaignCounts[0]?.held), demo: num(campaignCounts[0]?.demo) }
      : null,
    carts: carts ? { remindedThisWeek: num(carts[0]?.n) } : null,
    links: links ? { total: num(links[0]?.total), attributedOrders: num(links[0]?.attributed) } : null,
    rules: rules ? { active: num(rules[0]?.n) } : null,
    spend: spend ? { campaigns: num(spend[0]?.n) } : null,
  };
}

/**
 * The bell's marketing queues (for the shell owner to add): campaign requests this employee may decide (never their
 * own, never one they wrote, real campaigns) → /admin/marketing/campaigns?view=decide; reviews waiting →
 * /admin/marketing/reviews (its default view, "pending").
 */
export async function marketingQueueCounts(db: Db, actor: Actor): Promise<{ campaignsToDecide: number | null; reviewsToModerate: number | null }> {
  const [campaignsToDecide, reviewsToModerate] = await Promise.all([countDecidableCampaigns(db, actor), pendingReviewCount(db, actor)]);
  return { campaignsToDecide, reviewsToModerate };
}

export const MARKETING_QUEUE_LINKS = { campaignsToDecide: "/admin/marketing/campaigns?view=decide", reviewsToModerate: "/admin/marketing/reviews" } as const;
