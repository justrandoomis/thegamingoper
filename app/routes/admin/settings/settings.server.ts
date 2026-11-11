/**
 * Admin module 22 (settings) — the route kit bound to its namespace (security/route-kit.server.ts, shared by modules
 * 20 and 22), and the deployment's mode for the environment page, read from the request context (STORE_MODE and
 * APP_ENV are deploy variables: shown, never switched here).
 */
import { routeKit } from "../security/route-kit.server";
import { SETTINGS_NS } from "../security/meta";

export const settingsKit = routeKit(SETTINGS_NS);
