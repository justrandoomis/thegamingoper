import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 09 — Suppliers and purchasing (docs/areas/admin-purchasing.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/purchasing/.
 * Static segments outrank the dynamic ones, so /admin/purchasing/orders/new never reaches the order page.
 *
 *   /admin/purchasing                              home: what waits, figures, quick actions, blueprint status
 *   /admin/purchasing/suppliers[/:supplierId]      suppliers, profile, contacts, rating                 09.01 09.08
 *   /admin/purchasing/rfqs[/:rfqId]                requests for quotation, quotes compared, award        09.02
 *   /admin/purchasing/orders                       purchase orders (views, search, bulk "sent")          09.03
 *   /admin/purchasing/orders/new                   a new order (draft)                                   09.03
 *   /admin/purchasing/orders/:poId                 one order: approval, next steps, lines, documents     09.03
 *   /admin/purchasing/orders/:poId/edit            a draft's header and lines                            09.03
 *   /admin/purchasing/orders/:poId/print           the order as a printable document                     09.03
 *   /admin/purchasing/orders/:poId/receive         count what arrived (draft receipt)                    09.04
 *   /admin/purchasing/orders/:poId/invoice         record the supplier's invoice                         09.04
 *   /admin/purchasing/receipts[/:receiptId]        receipts: landed costs, posting into stock and books  09.04 09.05
 *   /admin/purchasing/invoices[/:invoiceId]        supplier invoices and the three-way match             09.04 09.07
 *   /admin/purchasing/claims[/:claimId]            shortage, damage and return claims                    09.06
 *   /admin/purchasing/alerts                       quantity and price variances, late orders             09.07
 */
export const purchasingAdminRoutes: RouteConfigEntry[] = [
  route("purchasing", "routes/admin/purchasing/layout.tsx", [
    index("routes/admin/purchasing/home.tsx"),
    route("suppliers", "routes/admin/purchasing/suppliers.tsx"),
    route("suppliers/:supplierId", "routes/admin/purchasing/supplier.tsx"),
    route("rfqs", "routes/admin/purchasing/rfqs.tsx"),
    route("rfqs/:rfqId", "routes/admin/purchasing/rfq.tsx"),
    route("orders", "routes/admin/purchasing/orders.tsx"),
    route("orders/new", "routes/admin/purchasing/order-new.tsx"),
    route("orders/:poId", "routes/admin/purchasing/order.tsx"),
    route("orders/:poId/edit", "routes/admin/purchasing/order-edit.tsx"),
    route("orders/:poId/print", "routes/admin/purchasing/order-print.tsx"),
    route("orders/:poId/receive", "routes/admin/purchasing/receive.tsx"),
    route("orders/:poId/invoice", "routes/admin/purchasing/invoice-new.tsx"),
    route("receipts", "routes/admin/purchasing/receipts.tsx"),
    route("receipts/:receiptId", "routes/admin/purchasing/receipt.tsx"),
    route("invoices", "routes/admin/purchasing/invoices.tsx"),
    route("invoices/:invoiceId", "routes/admin/purchasing/invoice.tsx"),
    route("claims", "routes/admin/purchasing/claims.tsx"),
    route("claims/:claimId", "routes/admin/purchasing/claim.tsx"),
    route("alerts", "routes/admin/purchasing/alerts.tsx"),
  ]),
];
