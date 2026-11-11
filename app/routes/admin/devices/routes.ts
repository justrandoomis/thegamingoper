import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 13 — Devices, games & trade-in (docs/areas/admin-devices.md). Paths are relative to "/admin" (inside the
 * authenticated admin layout); route files live in routes/admin/devices/. Static segments outrank the dynamic ones, so
 * /admin/devices/trade-ins/new never reaches the trade-in page.
 *
 *   /admin/devices                           what waits, the trade-in workflow, the sections, blueprint status
 *   /admin/devices/trade-ins                 trade-in requests (storefront and counter), views and filters        13.03 13.04
 *   /admin/devices/trade-ins/new             a trade-in at the counter                                             13.03
 *   /admin/devices/trade-ins/:ref            one trade-in: inspection, valuation, offer, answer, wipe, payout      13.02–13.04 13.08 13.09
 *   /admin/devices/trade-ins/:ref/print      the offer / receipt the customer signs                                13.04 13.09
 *   /admin/devices/used                      used units from intake to sold                                        13.09
 *   /admin/devices/used/:id                  one unit: checklist, grading, photos, ownership, wipe, listing        13.02 13.05 13.08 13.09
 *   /admin/devices/registry[/:serialId]      the device registry by serial, condition and source                   13.01
 *   /admin/devices/digital                   discs, cartridges, codes, subscriptions; code stock                   13.06 13.07
 *   /admin/devices/digital/:variantId        a digital variant's codes: import, reveal, revoke                     13.07
 *   /admin/devices/templates                 inspection checklists (new versions)                                  13.02 13.05
 *   /admin/devices/guides                    trade-in price guides                                                 13.03
 *   /admin/devices/files/:fileId             a private photo (trade-in, used unit)
 */
export const devicesAdminRoutes: RouteConfigEntry[] = [
  route("devices", "routes/admin/devices/layout.tsx", [
    index("routes/admin/devices/index.tsx"),
    route("trade-ins", "routes/admin/devices/trade-ins.tsx"),
    route("trade-ins/new", "routes/admin/devices/trade-in-new.tsx"),
    route("trade-ins/:ref", "routes/admin/devices/trade-in.tsx"),
    route("trade-ins/:ref/print", "routes/admin/devices/trade-in-print.tsx"),
    route("used", "routes/admin/devices/used.tsx"),
    route("used/:id", "routes/admin/devices/used-unit.tsx"),
    route("registry", "routes/admin/devices/registry.tsx"),
    route("registry/:serialId", "routes/admin/devices/registry-unit.tsx"),
    route("digital", "routes/admin/devices/digital.tsx"),
    route("digital/:variantId", "routes/admin/devices/digital-codes.tsx"),
    route("templates", "routes/admin/devices/templates.tsx"),
    route("guides", "routes/admin/devices/guides.tsx"),
    route("files/:fileId", "routes/admin/devices/file.ts"),
  ]),
];
