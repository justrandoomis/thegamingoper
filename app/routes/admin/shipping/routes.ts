import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 11 — Shipping and delivery (docs/areas/admin-shipping.md). Paths are relative to "/admin" (inside the
 * authenticated admin layout); route files live in routes/admin/shipping/. Static segments outrank the dynamic ones,
 * so /admin/shipping/cod/new never reaches the settlement page.
 *
 *   /admin/shipping                          what waits for a person, figures, the fee in force          (all)
 *   /admin/shipping/shipments                parcels: filters, saved views, scan, bulk actions            11.03 11.02
 *   /admin/shipping/shipments/:shipmentId    one parcel: waybill, pickup, statuses, delivery, way back    11.02 11.03 11.05 11.06
 *   /admin/shipping/print                    waybills and pickup manifests (print CSS)                    11.03
 *   /admin/shipping/attempts                 failed deliveries and parcels coming back (mobile-first)     11.05
 *   /admin/shipping/zones                    the flat fee, the overrides switch, governorates             11.01
 *   /admin/shipping/zones/:governorateId     availability, own fee, estimate, districts, carriers' rates  11.01
 *   /admin/shipping/carriers                 carriers and a new carrier                                   11.02
 *   /admin/shipping/carriers/:carrierId      one carrier and its rates per governorate and level          11.02
 *   /admin/shipping/cod                      settlements and what each carrier still holds                11.04
 *   /admin/shipping/cod/new                  a settlement draft from the carrier's statement              11.04
 *   /admin/shipping/cod/:settlementId        a settlement: correct, submit, reconcile, dispute            11.04
 *   /admin/shipping/files/:fileId            private files: packing photos, proofs, statements            11.04 11.06
 */
export const shippingAdminRoutes: RouteConfigEntry[] = [
  route("shipping", "routes/admin/shipping/layout.tsx", [
    index("routes/admin/shipping/home.tsx"),
    route("shipments", "routes/admin/shipping/shipments.tsx"),
    route("shipments/:shipmentId", "routes/admin/shipping/shipment.tsx"),
    route("print", "routes/admin/shipping/print.tsx"),
    route("attempts", "routes/admin/shipping/attempts.tsx"),
    route("zones", "routes/admin/shipping/zones.tsx"),
    route("zones/:governorateId", "routes/admin/shipping/zone.tsx"),
    route("carriers", "routes/admin/shipping/carriers.tsx"),
    route("carriers/:carrierId", "routes/admin/shipping/carrier.tsx"),
    route("cod", "routes/admin/shipping/cod.tsx"),
    route("cod/new", "routes/admin/shipping/cod-new.tsx"),
    route("cod/:settlementId", "routes/admin/shipping/settlement.tsx"),
    route("files/:fileId", "routes/admin/shipping/file.ts"),
  ]),
];
