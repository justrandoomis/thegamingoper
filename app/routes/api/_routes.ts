import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Resource routes (no UI): absolute paths under "/api/..." and "/media/...".
 * Add one line per endpoint; keep the list sorted by path.
 */
export const apiRoutes: RouteConfigEntry[] = [
  route("api/cart", "routes/api/cart.ts"),
  route("api/events", "routes/api/events.ts"),
  route("api/files/:fileId", "routes/api/files.ts"),
  route("api/health", "routes/api/health.ts"),
  route("api/onboarding", "routes/storefront/home/api.onboarding.ts"),
  route("api/product-preview/:slug", "routes/storefront/product/preview.ts"),
  route("api/recently-viewed", "routes/storefront/home/api.recently-viewed.ts"),
  route("api/search/suggest", "routes/api/search-suggest.ts"),
  route("api/upload/proof", "routes/api/upload-proof.ts"),
  route("api/upload/tradein", "routes/api/upload-tradein.ts"),
  route("api/wishlist", "routes/api/wishlist.ts"),
  route("media/:key", "routes/api/media.ts"),
  route("robots.txt", "routes/api/robots.ts"),
  route("sitemap.xml", "routes/api/sitemap.ts"),
];
