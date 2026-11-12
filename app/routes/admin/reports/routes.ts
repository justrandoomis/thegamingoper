import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 18 — Reports and BI (docs/areas/admin-reports.md). Paths are relative to "/admin" (inside the
 * authenticated admin layout); route files live in routes/admin/reports/.
 *
 *   /admin/reports                 the reports this employee may open, their saved reports, the functions' status   (any reports.*)
 *   /admin/reports/sales           sales by day, platform, branch and channel                                       18.01
 *   /admin/reports/margin          net margin per SKU after discounts, refunds, delivery and fees                   18.02
 *   /admin/reports/inventory       ABC analysis; module 04's stock turnover and dead stock                          18.03
 *   /admin/reports/customers       cohorts, repeat purchases, customer value by RFM segment                         18.04
 *   /admin/reports/performance     suppliers, employees, shipping, customer service                                 18.05
 *   /admin/reports/saved           saved reports: open, rename / share, delete (POST)                               18.06
 *   /admin/reports/export          a report as CSV or XLSX (GET, audited)                                           18.06
 *   /admin/reports/dictionary      the metrics dictionary                                                           18.07
 */
export const reportsAdminRoutes: RouteConfigEntry[] = [
  route("reports", "routes/admin/reports/layout.tsx", [
    index("routes/admin/reports/index.tsx"),
    route("sales", "routes/admin/reports/sales.tsx"),
    route("margin", "routes/admin/reports/margin.tsx"),
    route("inventory", "routes/admin/reports/inventory.tsx"),
    route("customers", "routes/admin/reports/customers.tsx"),
    route("performance", "routes/admin/reports/performance.tsx"),
    route("saved", "routes/admin/reports/saved.tsx"),
    route("export", "routes/admin/reports/export.ts"),
    route("dictionary", "routes/admin/reports/dictionary.tsx"),
  ]),
];
