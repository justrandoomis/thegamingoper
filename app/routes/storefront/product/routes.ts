import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Product detail, gallery, reviews and quick preview.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/product/.
 * The quick-preview data endpoint (GET /api/product-preview/:slug) is a resource route registered in
 * app/routes/api/_routes.ts; its module is ./preview.ts (the sheet itself is ./QuickPreview.tsx).
 */
export const productRoutes: RouteConfigEntry[] = [route("p/:slug", "routes/storefront/product/product.tsx")];
