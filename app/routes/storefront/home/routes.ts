import { index, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Intro, onboarding and the home page.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/home/.
 */
export const homeRoutes: RouteConfigEntry[] = [index("routes/storefront/home/home.tsx")];
