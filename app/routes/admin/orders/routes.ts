import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 05 — Orders and fulfilment (docs/areas/admin-orders.md). Paths are relative to "/admin" (inside the
 * authenticated admin layout); route files live in routes/admin/orders/. Static segments outrank ":ref", so
 * /admin/orders/proofs never reaches the order page.
 *
 *   /admin/orders                         list, filters in the URL, saved views, batch printing, CSV, queue cards   05.01 05.02
 *   /admin/orders/proofs                  transfer proofs awaiting verification (the shell's "proofs" queue)
 *   /admin/orders/proofs/:paymentId       one proof, decided by a person (mobile-first)
 *   /admin/orders/proofs/image/:proofId   the proof image (private file, payment_proof.read)
 *   /admin/orders/refunds                 refunds awaiting a second approval (the shell's "refunds" queue)
 *   /admin/orders/fulfillment             who packs what, task lists                                             05.03
 *   /admin/orders/review                  late / suspicious orders for a person, rules explained                 05.09
 *   /admin/orders/preorders               pre-orders: expected date, deposit, delay updates                      05.07
 *   /admin/orders/print                   invoices, packing slips, labels — one order or a batch                  05.06
 *   /admin/orders/export                  CSV of the filtered list (cost columns only for cost.read)
 *   /admin/orders/files/:fileId           proof-of-delivery photo (private file)                                 05.08
 *   /admin/orders/:ref                    the unified order page                                                 05.02 05.01 05.08
 *   /admin/orders/:ref/pack               packing station: scan, verify serials, parcels, hand over              04.11 05.03 05.04
 *   /admin/orders/:ref/edit               edit before shipping (quantities, address)                             05.05
 */
export const ordersAdminRoutes: RouteConfigEntry[] = [
  route("orders", "routes/admin/orders/layout.tsx", [
    index("routes/admin/orders/index.tsx"),
    route("proofs", "routes/admin/orders/proofs.tsx"),
    route("proofs/image/:proofId", "routes/admin/orders/proof-image.ts"),
    route("proofs/:paymentId", "routes/admin/orders/proof.tsx"),
    route("refunds", "routes/admin/orders/refunds.tsx"),
    route("fulfillment", "routes/admin/orders/fulfillment.tsx"),
    route("review", "routes/admin/orders/review.tsx"),
    route("preorders", "routes/admin/orders/preorders.tsx"),
    route("print", "routes/admin/orders/print.tsx"),
    route("export", "routes/admin/orders/export.ts"),
    route("files/:fileId", "routes/admin/orders/file.ts"),
    route(":ref", "routes/admin/orders/order.tsx"),
    route(":ref/pack", "routes/admin/orders/pack.tsx"),
    route(":ref/edit", "routes/admin/orders/edit.tsx"),
  ]),
];
