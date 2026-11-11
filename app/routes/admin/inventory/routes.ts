import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 04 — Inventory and warehouses (docs/areas/admin-inventory.md). Paths are relative to "/admin" (inside
 * the authenticated admin layout); route files live in routes/admin/inventory/. Static segments outrank the dynamic
 * ones, so /admin/inventory/locations/labels never reaches the location page.
 *
 *   /admin/inventory                         home: what waits for a decision, figures, quick actions      (all)
 *   /admin/inventory/stock                   on hand / reserved / available / incoming per SKU & location 04.01
 *   /admin/inventory/stock/:variantId        one SKU: levels, forecast, reservations, serials, cost layers 04.01 04.06 04.09 04.10
 *   /admin/inventory/locations               warehouses, shops, aisles, shelves, bins                     04.02
 *   /admin/inventory/locations/labels        printable barcode labels                                     04.02
 *   /admin/inventory/locations/:locationId   one location                                                 04.02
 *   /admin/inventory/receive                 receiving with inspection, counting and scanning             04.03
 *   /admin/inventory/movements               the immutable movement log (+ /export CSV)                   04.04
 *   /admin/inventory/counts                  periodic and selective counts                                04.05
 *   /admin/inventory/counts/:countId         counting, review, the supervisor's approval                  04.05
 *   /admin/inventory/reorder                 reorder points, days of cover, stock-out forecast            04.06
 *   /admin/inventory/transfers               transfers between locations                                  04.07
 *   /admin/inventory/transfers/:transferId   ship, receive, shortfall, cancel                             04.07
 *   /admin/inventory/reservations            stock held per order, expiry, manual release                 04.08
 *   /admin/inventory/oversell                negative-stock exceptions and their history                  04.09
 *   /admin/inventory/costing                 FIFO cost layers (cost.read)                                 04.10
 *   /admin/inventory/reports                 dead stock, turnover, sales vs inbound (+ /export CSV)       04.12
 *   /admin/inventory/serials[/:serialId]     serial numbers and a unit's history (inventory.serial.read)
 *   /admin/inventory/scan                    scan lookup for the scan fields (JSON)
 */
export const inventoryAdminRoutes: RouteConfigEntry[] = [
  route("inventory", "routes/admin/inventory/layout.tsx", [
    index("routes/admin/inventory/home.tsx"),
    route("stock", "routes/admin/inventory/stock.tsx"),
    route("stock/:variantId", "routes/admin/inventory/stock-item.tsx"),
    route("locations", "routes/admin/inventory/locations.tsx"),
    route("locations/labels", "routes/admin/inventory/labels.tsx"),
    route("locations/:locationId", "routes/admin/inventory/location.tsx"),
    route("receive", "routes/admin/inventory/receive.tsx"),
    route("movements", "routes/admin/inventory/movements.tsx"),
    route("movements/export", "routes/admin/inventory/movements-export.ts"),
    route("counts", "routes/admin/inventory/counts.tsx"),
    route("counts/:countId", "routes/admin/inventory/count.tsx"),
    route("reorder", "routes/admin/inventory/reorder.tsx"),
    route("transfers", "routes/admin/inventory/transfers.tsx"),
    route("transfers/:transferId", "routes/admin/inventory/transfer.tsx"),
    route("reservations", "routes/admin/inventory/reservations.tsx"),
    route("oversell", "routes/admin/inventory/oversell.tsx"),
    route("costing", "routes/admin/inventory/costing.tsx"),
    route("reports", "routes/admin/inventory/reports.tsx"),
    route("reports/export", "routes/admin/inventory/reports-export.ts"),
    route("serials", "routes/admin/inventory/serials.tsx"),
    route("serials/:serialId", "routes/admin/inventory/serial.tsx"),
    route("scan", "routes/admin/inventory/scan.ts"),
  ]),
];
