import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Device ecosystem hubs and compatibility.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/devices/.
 *
 *   /device/:model     "everything about this device" — every published device model on an active platform
 *                      (services/devices.server.ts → getDeviceHub; unknown, draft or inactive-platform models are 404)
 */
export const devicesRoutes: RouteConfigEntry[] = [route("device/:model", "routes/storefront/devices/device.tsx")];
