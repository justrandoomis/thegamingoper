import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 06 — Point of sale (docs/areas/admin-pos.md). Paths are relative to "/admin" (inside the authenticated
 * admin layout); route files live in routes/admin/pos/. Static segments outrank the dynamic ones.
 *
 *   /admin/pos                       the employee's drawer, shifts to review, registers, today, honest limits   (all)
 *   /admin/pos/sell                  the till: scan, search, cart, serials, discounts, buyer, payment, offline   06.01 06.03–06.07
 *   /admin/pos/shift                 open a shift (float), pay in / out / drop, close with a blind count        06.02
 *   /admin/pos/shifts                shifts with filters in the URL; the review queue                           06.02
 *   /admin/pos/shifts/:shiftId       the shift report (Z report, 80 mm print), approve a difference (2 people)  06.02
 *   /admin/pos/sales                 sales of the tills with filters in the URL                                 06.01 06.05
 *   /admin/pos/receipts/:ref         a receipt on 80 mm paper; copies recorded                                  06.01 06.05
 *   /admin/pos/registers             registers and their store location                                         06.01 06.04
 *   /admin/pos/api/:op               the till's JSON endpoints (lookup, search, catalog, customer, sale, sync)  06.01 06.07
 */
export const posAdminRoutes: RouteConfigEntry[] = [
  route("pos", "routes/admin/pos/layout.tsx", [
    index("routes/admin/pos/index.tsx"),
    route("sell", "routes/admin/pos/sell.tsx"),
    route("shift", "routes/admin/pos/shift.tsx"),
    route("shifts", "routes/admin/pos/shifts.tsx"),
    route("shifts/:shiftId", "routes/admin/pos/shift-report.tsx"),
    route("sales", "routes/admin/pos/sales.tsx"),
    route("receipts/:ref", "routes/admin/pos/receipt.tsx"),
    route("registers", "routes/admin/pos/registers.tsx"),
    route("api/:op", "routes/admin/pos/till-api.ts"),
  ]),
];
