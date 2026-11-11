import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Resource routes (no UI): absolute paths under "/api/..." and "/media/...".
 * Add one line per endpoint; keep the list sorted by path.
 */
export const apiRoutes: RouteConfigEntry[] = [
  route("api/health", "routes/api/health.ts"),
  route("media/:key", "routes/api/media.ts"),
];
