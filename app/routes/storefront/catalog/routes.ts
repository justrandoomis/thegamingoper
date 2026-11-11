import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Category hubs, platform hubs, product listing, search and compare.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/catalog/.
 * (The suggestions endpoint GET /api/search/suggest is a resource route in routes/api.)
 * Area notes: docs/areas/catalog.md.
 */
export const catalogRoutes: RouteConfigEntry[] = [
  route("c/:category", "routes/storefront/catalog/category.tsx"),
  route("platform/:platform", "routes/storefront/catalog/platform.tsx"),
  route("search", "routes/storefront/catalog/search.tsx"),
  route("compare", "routes/storefront/catalog/compare.tsx"),
];
