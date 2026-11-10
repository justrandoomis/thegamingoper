import type { RouteConfigEntry } from "@react-router/dev/routes";
import { authAdminRoutes } from "./auth/routes";
import { dashboardAdminRoutes } from "./dashboard/routes";
import { catalogAdminRoutes } from "./catalog/routes";
import { pricingAdminRoutes } from "./pricing/routes";
import { inventoryAdminRoutes } from "./inventory/routes";
import { ordersAdminRoutes } from "./orders/routes";
import { posAdminRoutes } from "./pos/routes";
import { customersAdminRoutes } from "./customers/routes";
import { promotionsAdminRoutes } from "./promotions/routes";
import { purchasingAdminRoutes } from "./purchasing/routes";
import { financeAdminRoutes } from "./finance/routes";
import { shippingAdminRoutes } from "./shipping/routes";
import { returnsAdminRoutes } from "./returns/routes";
import { devicesAdminRoutes } from "./devices/routes";
import { supportAdminRoutes } from "./support/routes";
import { staffAdminRoutes } from "./staff/routes";
import { marketingAdminRoutes } from "./marketing/routes";
import { cmsAdminRoutes } from "./cms/routes";
import { reportsAdminRoutes } from "./reports/routes";
import { automationAdminRoutes } from "./automation/routes";
import { securityAdminRoutes } from "./security/routes";
import { channelsAdminRoutes } from "./channels/routes";
import { settingsAdminRoutes } from "./settings/routes";
import { opsAdminRoutes } from "./ops/routes";

/** Routes rendered inside the authenticated admin layout ("/admin/..."), one file per blueprint module. */
export const adminModuleRoutes: RouteConfigEntry[] = [
  ...dashboardAdminRoutes,
  ...catalogAdminRoutes,
  ...pricingAdminRoutes,
  ...inventoryAdminRoutes,
  ...ordersAdminRoutes,
  ...posAdminRoutes,
  ...customersAdminRoutes,
  ...promotionsAdminRoutes,
  ...purchasingAdminRoutes,
  ...financeAdminRoutes,
  ...shippingAdminRoutes,
  ...returnsAdminRoutes,
  ...devicesAdminRoutes,
  ...supportAdminRoutes,
  ...staffAdminRoutes,
  ...marketingAdminRoutes,
  ...cmsAdminRoutes,
  ...reportsAdminRoutes,
  ...automationAdminRoutes,
  ...securityAdminRoutes,
  ...channelsAdminRoutes,
  ...settingsAdminRoutes,
  ...opsAdminRoutes,
];

/** Sign-in / setup routes that live outside the authenticated layout. */
export const adminPublicRoutes: RouteConfigEntry[] = [...authAdminRoutes];
