import { index, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Intro, onboarding and the home page (docs/areas/home.md).
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/home/.
 * The intro and the onboarding are overlays of the home page, not routes. Its two resource routes
 * (POST /api/onboarding, GET /api/recently-viewed) are registered in routes/api/_routes.ts.
 */
export const homeRoutes: RouteConfigEntry[] = [index("routes/storefront/home/home.tsx")];
