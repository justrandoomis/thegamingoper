import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 02 — Product catalogue. Paths are relative to "/admin" (inside the authenticated admin layout);
 * route files live in routes/admin/catalog/. The index (/admin/catalog, the product list) replaces the shell's
 * landing page for this module. Every loader and action checks its own permission (catalog.server.ts).
 *
 *   /admin/catalog                              products: search, filters, bulk actions (02.01, 02.05, 02.06)
 *   /admin/catalog/new                          new product (draft)
 *   /admin/catalog/products/:id                 details: texts ar/en/ckb, facts, specs, custom fields, workflow (02.03, 02.05)
 *   /admin/catalog/products/:id/variants        SKU variants: options, model numbers, barcodes (02.01)
 *   /admin/catalog/products/:id/media           gallery: uploads, catalogue photos, order, alt text (02.04)
 *   /admin/catalog/products/:id/bundle          bundle components with stock per component (02.07)
 *   /admin/catalog/products/:id/related         accessories, alternatives, upgrades, compatible accessories (02.08)
 *   /admin/catalog/products/:id/compatibility   compatibility rules of the product (02.10)
 *   /admin/catalog/products/:id/history         versions, price history, safe restore (02.09)
 *   /admin/catalog/categories                   category tree (02.02)
 *   /admin/catalog/devices                      platforms, generations, device models
 *   /admin/catalog/devices/:id                  one device model and its spec sheet
 *   /admin/catalog/compare                      device spec comparison and cross-generation compatibility (02.10)
 *   /admin/catalog/compatibility                every compatibility rule, by device and status (02.10)
 *   /admin/catalog/import                       CSV import (preview → apply → rollback) and export (02.06)
 *   /admin/catalog/import/:jobId                one import: its dry run, apply, rollback
 *   /admin/catalog/export                       CSV download (resource route)
 *
 * (File names differ from the paths on purpose: a route file referenced before it exists stays broken in the dev
 * server's module cache, so the module's files were created under these names.)
 */
export const catalogAdminRoutes: RouteConfigEntry[] = [
  route("catalog", "routes/admin/catalog/module.tsx", [
    index("routes/admin/catalog/product-list.tsx"),
    route("new", "routes/admin/catalog/new-product.tsx"),
    route("products/:id", "routes/admin/catalog/product-editor.tsx", [
      index("routes/admin/catalog/editor-details.tsx"),
      route("variants", "routes/admin/catalog/editor-variants.tsx"),
      route("media", "routes/admin/catalog/editor-media.tsx"),
      route("bundle", "routes/admin/catalog/editor-bundle.tsx"),
      route("related", "routes/admin/catalog/editor-related.tsx"),
      route("compatibility", "routes/admin/catalog/editor-compatibility.tsx"),
      route("history", "routes/admin/catalog/editor-history.tsx"),
    ]),
    route("categories", "routes/admin/catalog/category-tree.tsx"),
    route("devices", "routes/admin/catalog/device-list.tsx"),
    route("devices/:id", "routes/admin/catalog/device-editor.tsx"),
    route("compare", "routes/admin/catalog/device-compare.tsx"),
    route("compatibility", "routes/admin/catalog/compat-rules.tsx"),
    route("import", "routes/admin/catalog/csv-import.tsx"),
    route("import/:jobId", "routes/admin/catalog/csv-import-job.tsx"),
    route("export", "routes/admin/catalog/csv-export.ts"),
  ]),
];
