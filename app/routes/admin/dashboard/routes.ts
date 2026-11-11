import { index, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 01 — Command center and KPI dashboard.
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/dashboard/.
 *
 * Today the index is the admin shell's minimal home (what is waiting for the employee, their sections, module 01's
 * blueprint status). The command-center module replaces admin-home.tsx when it is built.
 */
export const dashboardAdminRoutes: RouteConfigEntry[] = [index("routes/admin/dashboard/admin-home.tsx")];
