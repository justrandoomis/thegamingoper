import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 16 — Marketing and growth (docs/areas/admin-marketing.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/marketing/.
 * A campaign's page with the id "new" is its empty form.
 *
 *   /admin/marketing                              what waits, each section's figures, the boundaries, blueprint status
 *   /admin/marketing/campaigns                    campaigns: states, views, held messages, budget and spend        16.01
 *   /admin/marketing/campaigns/:campaignId        one campaign: draft, audience now, second person, release (held),
 *                                                 recipients, its links (16.04), its spend (16.07), history        16.01
 *   /admin/marketing/segments                     who bought which platform when; who may be messaged now          16.03
 *   /admin/marketing/carts                        abandoned carts, verdicts, held reminders with limits            16.02
 *   /admin/marketing/links                        UTM link builder, the links, attribution of sales               16.04
 *   /admin/marketing/cross-sell                   pin / boost / exclude add-ons with a device (verified only)      16.05
 *   /admin/marketing/reviews                      approve / reject customer reviews (verified purchases)           16.06
 *   /admin/marketing/performance                  CAC, ROAS, LTV with their definitions; print                     16.07
 *   /admin/marketing/performance/csv              the same as CSV (audited)                                        16.07
 */
export const marketingAdminRoutes: RouteConfigEntry[] = [
  route("marketing", "routes/admin/marketing/layout.tsx", [
    index("routes/admin/marketing/index.tsx"),
    route("campaigns", "routes/admin/marketing/campaigns.tsx"),
    route("campaigns/:campaignId", "routes/admin/marketing/campaign.tsx"),
    route("segments", "routes/admin/marketing/segments.tsx"),
    route("carts", "routes/admin/marketing/carts.tsx"),
    route("links", "routes/admin/marketing/links.tsx"),
    route("cross-sell", "routes/admin/marketing/cross-sell.tsx"),
    route("reviews", "routes/admin/marketing/reviews.tsx"),
    route("performance", "routes/admin/marketing/performance.tsx"),
    route("performance/csv", "routes/admin/marketing/performance-csv.ts"),
  ]),
];
