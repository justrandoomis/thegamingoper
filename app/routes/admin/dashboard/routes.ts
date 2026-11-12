import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 01 — Command centre and KPI dashboard (docs/areas/admin-dashboard.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/dashboard/.
 *
 *   /admin                         the command centre and every employee's admin home: urgent tiles, what waits for
 *                                  their decision, KPIs against the span before, funnel, role views, activity
 *                                  (the file keeps its name: tests/admin-auth-adversarial.test.ts imports its loader)
 *   /admin/dashboard/search?q=     global search: orders, customers, SKUs, serial numbers, tickets            01.06
 *   /admin/dashboard/activity      the activity feed: price changes, returns, approvals                        01.07
 *
 * /admin/dashboard itself stays the shell's landing route, which sends it to /admin.
 */
export const dashboardAdminRoutes: RouteConfigEntry[] = [
  index("routes/admin/dashboard/admin-home.tsx"),
  route("dashboard/search", "routes/admin/dashboard/search.tsx"),
  route("dashboard/activity", "routes/admin/dashboard/activity.tsx"),
];
