import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Help center, maintenance assistant and repair requests.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/support/.
 *
 *   /support                    help centre: devices, guides, ways to reach a person
 *   /support/article/:slug      one approved guide (404 for anything else)
 *   /support/assistant          the guided maintenance assistant (conversation state in the query string)
 *   /support/repair             repair request form
 *   /support/repair/status      repair status by reference + phone (or the link given after sending)
 */
export const supportRoutes: RouteConfigEntry[] = [
  route("support", "routes/storefront/support/help-center.tsx"),
  route("support/assistant", "routes/storefront/support/assistant.tsx"),
  route("support/repair", "routes/storefront/support/repair.tsx"),
  route("support/repair/status", "routes/storefront/support/repair-status.tsx"),
  route("support/article/:slug", "routes/storefront/support/article.tsx"),
];
