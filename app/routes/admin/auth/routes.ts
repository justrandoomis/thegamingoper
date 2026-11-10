import type { RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin sign-in, MFA and first-run setup. These sit OUTSIDE the authenticated layout; paths are absolute
 * (e.g. route("admin/login", "routes/admin/auth/login.tsx")).
 */
export const authAdminRoutes: RouteConfigEntry[] = [];
