import type { RouteConfigEntry } from "@react-router/dev/routes";
import { homeRoutes } from "./home/routes";
import { catalogRoutes } from "./catalog/routes";
import { productRoutes } from "./product/routes";
import { checkoutRoutes } from "./checkout/routes";
import { accountRoutes } from "./account/routes";
import { devicesRoutes } from "./devices/routes";
import { usedRoutes } from "./used/routes";
import { supportRoutes } from "./support/routes";
import { contentRoutes } from "./content/routes";

/** Every storefront route, composed from one file per area so areas can be built in parallel. */
export const storefrontRoutes: RouteConfigEntry[] = [
  ...homeRoutes,
  ...catalogRoutes,
  ...productRoutes,
  ...checkoutRoutes,
  ...accountRoutes,
  ...devicesRoutes,
  ...usedRoutes,
  ...supportRoutes,
  ...contentRoutes, // contains the "*" not-found route — keep last
];
