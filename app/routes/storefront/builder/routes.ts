import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Switch bundle builder (docs/switch-builder.md).
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/builder/.
 *
 *   /build/switch   device → memory card → games → review; one URL per step (?step=…), the plan in localStorage
 */
export const builderRoutes: RouteConfigEntry[] = [route("build/switch", "routes/storefront/builder/switch-builder.tsx")];
