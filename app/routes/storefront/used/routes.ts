import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Used marketplace, trade-in quote and trade-in tracking.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/used/.
 * The list and the unit page are siblings (the unit page does not render inside the list); same for the wizard and
 * a request's tracking page. The upload endpoint for trade-in photos is /api/upload/tradein (app/routes/api/_routes.ts).
 */
export const usedRoutes: RouteConfigEntry[] = [
  route("used", "routes/storefront/used/used-list.tsx"),
  route("used/:slug", "routes/storefront/used/used-unit.tsx"),
  route("trade-in", "routes/storefront/used/trade-in.tsx"),
  route("trade-in/:ref", "routes/storefront/used/trade-in-status.tsx"),
];
