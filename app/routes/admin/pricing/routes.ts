import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 03 — Pricing and profitability (docs/areas/admin-pricing.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/pricing/.
 *
 *   /admin/pricing                       overview: what waits, the price book, the pages, blueprint status
 *   /admin/pricing/skus                  prices, stock, landed cost and margins (URL filters, CSV, bulk margin rules)
 *   /admin/pricing/skus/:variantId       one SKU: change form, cost, margin rules, suggestion, layers, history
 *   /admin/pricing/changes               approval queue and the price-change log
 *   /admin/pricing/landed[/:receiptId]   landed-cost bills of receipts and their allocation
 *   /admin/pricing/lists[/:listId]       price lists per channel / branch / segment
 *   /admin/pricing/simulate              discount simulation on net margin
 *   /admin/pricing/special               bundles, clearance and used devices
 *   /admin/pricing/fx                    the store's USD rate
 *   /admin/pricing/export/:kind          CSV (skus | changes | simulate)
 */
export const pricingAdminRoutes: RouteConfigEntry[] = [
  route("pricing", "routes/admin/pricing/layout.tsx", [
    index("routes/admin/pricing/overview.tsx"),
    route("skus", "routes/admin/pricing/skus.tsx"),
    route("skus/:variantId", "routes/admin/pricing/sku.tsx"),
    route("changes", "routes/admin/pricing/changes.tsx"),
    route("landed", "routes/admin/pricing/landed.tsx"),
    route("landed/:receiptId", "routes/admin/pricing/receipt.tsx"),
    route("lists", "routes/admin/pricing/lists.tsx"),
    route("lists/:listId", "routes/admin/pricing/list.tsx"),
    route("simulate", "routes/admin/pricing/simulate.tsx"),
    route("special", "routes/admin/pricing/special.tsx"),
    route("fx", "routes/admin/pricing/fx.tsx"),
    route("export/:kind", "routes/admin/pricing/export.ts"),
  ]),
];
