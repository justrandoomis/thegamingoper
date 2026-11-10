import { type RouteConfig, route } from "@react-router/dev/routes";
import { adminModuleRoutes, adminPublicRoutes } from "./routes/admin/_routes";
import { apiRoutes } from "./routes/api/_routes";
import { storefrontRoutes } from "./routes/storefront/_routes";

/**
 * Route map.
 *   /api/*, /media/*      resource routes
 *   /admin/login|setup    admin sign-in (outside the authenticated layout)
 *   /admin/*              admin control center (authenticated layout, one folder per blueprint module)
 *   /:locale?/*           storefront — Arabic has no prefix, English is /en, Kurdish (Sorani) is /ckb
 *
 * Do not add routes here: each area registers its own in routes/<area>/.../routes.ts.
 */
export default [
  ...apiRoutes,
  ...adminPublicRoutes,
  route("admin", "routes/admin/_layout.tsx", adminModuleRoutes),
  route(":locale?", "routes/storefront/_layout.tsx", storefrontRoutes),
] satisfies RouteConfig;
