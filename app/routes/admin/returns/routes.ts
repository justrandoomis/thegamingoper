import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 12 — Returns and warranty (docs/areas/admin-returns.md). Paths are relative to "/admin" (inside the
 * authenticated admin layout); route files live in routes/admin/returns/. Static segments outrank ":rma", so
 * /admin/returns/repairs never reaches the RMA page.
 *
 *   /admin/returns                      queues, the RMA list (filters in the URL), the module's blueprint status   12.01 12.05
 *   /admin/returns/new                  open an RMA on the customer's behalf: order → units → reason → photos      12.01 12.02
 *   /admin/returns/policies             return eligibility rules (kind, category, new/used, window, seal, fee)      12.02
 *   /admin/returns/quarantine           units waiting to be refurbished / returned to the supplier / written off   12.03 12.07
 *   /admin/returns/repairs              repair tickets with SLA timers; a device handed over at the shop           12.07
 *   /admin/returns/repairs/:ref         one repair: status, diagnosis, quote, parts, technician, SLA               12.07 12.06
 *   /admin/returns/warranties           warranties: running, ending, expired, voided                               12.06
 *   /admin/returns/warranties/:id       one warranty: dates, maker's warranty, service history, replaced parts     12.06
 *   /admin/returns/files/:fileId        a private photo (RMA, repair request)                                      12.01
 *   /admin/returns/:rma                 one RMA: units, inspection, refund (two people), signals, history          12.01 12.03 12.04 12.05
 *   /admin/returns/:rma/print           the return slip (Code 128), browser print                                  12.01
 */
export const returnsAdminRoutes: RouteConfigEntry[] = [
  route("returns", "routes/admin/returns/layout.tsx", [
    index("routes/admin/returns/index.tsx"),
    route("new", "routes/admin/returns/new.tsx"),
    route("policies", "routes/admin/returns/policies.tsx"),
    route("quarantine", "routes/admin/returns/quarantine.tsx"),
    route("repairs", "routes/admin/returns/repairs.tsx"),
    route("repairs/:ref", "routes/admin/returns/repair.tsx"),
    route("warranties", "routes/admin/returns/warranties.tsx"),
    route("warranties/:id", "routes/admin/returns/warranty.tsx"),
    route("files/:fileId", "routes/admin/returns/file.ts"),
    route(":rma", "routes/admin/returns/rma.tsx"),
    route(":rma/print", "routes/admin/returns/print.tsx"),
  ]),
];
