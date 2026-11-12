import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 17 — Content & storefront experience (docs/areas/admin-cms.md). Paths are relative to "/admin" (inside
 * the authenticated admin layout); route files live in routes/admin/cms/. Static segments outrank the dynamic ones,
 * so /admin/cms/search/zero never reaches another page.
 *
 *   /admin/cms                          what waits, what is live, what comes next, blueprint status        17.*
 *   /admin/cms/home                     home sections (order, shown) and the pinned heroes                 17.01
 *   /admin/cms/home/pins/:pinId         one pinned hero ("new"): product, headline, period, preview        17.01 17.02 17.06
 *   /admin/cms/banners                  banners with views and filters                                     17.01 17.02
 *   /admin/cms/banners/:bannerId        one banner ("new"): words, photo, link, period, preview, publish   17.01 17.02 17.06
 *   /admin/cms/pages                    the six policies, about and contact, landing pages                 17.01
 *   /admin/cms/pages/:slug              one page: draft, preview, approve / schedule / withdraw            17.01 17.04 17.06
 *   /admin/cms/schedule                 campaigns and releases by Iraq day                                 17.02
 *   /admin/cms/navigation               the menu's order, hidden and featured entries; listing filters    17.03
 *   /admin/cms/search                   synonym sets, try a query                                          17.03 17.05
 *   /admin/cms/search/zero              searches with no results and suggested synonyms                   17.05
 *   /admin/cms/seo                      search-engine titles and descriptions with their issues           17.04
 *   /admin/cms/seo/:type/:id            one product's or category's SEO with the result preview           17.04 17.06
 *   /admin/cms/redirects                301/302 redirects (no loops, no chains), bulk on/off               17.04
 *   /admin/cms/preview/:token           a signed preview link (staff only, noindex)                        17.06
 */
export const cmsAdminRoutes: RouteConfigEntry[] = [
  route("cms", "routes/admin/cms/layout.tsx", [
    index("routes/admin/cms/index.tsx"),
    route("home", "routes/admin/cms/home.tsx"),
    route("home/pins/:pinId", "routes/admin/cms/pin.tsx"),
    route("banners", "routes/admin/cms/banners.tsx"),
    route("banners/:bannerId", "routes/admin/cms/banner.tsx"),
    route("pages", "routes/admin/cms/pages.tsx"),
    route("pages/:slug", "routes/admin/cms/page.tsx"),
    route("schedule", "routes/admin/cms/schedule.tsx"),
    route("navigation", "routes/admin/cms/navigation.tsx"),
    route("search", "routes/admin/cms/search.tsx"),
    route("search/zero", "routes/admin/cms/zero.tsx"),
    route("seo", "routes/admin/cms/seo.tsx"),
    route("seo/:type/:id", "routes/admin/cms/seo-item.tsx"),
    route("redirects", "routes/admin/cms/redirects.tsx"),
    route("preview/:token", "routes/admin/cms/preview.tsx"),
  ]),
];
