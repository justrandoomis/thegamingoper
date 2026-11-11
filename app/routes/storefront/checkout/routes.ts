import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Cart, guest checkout, payment proof, order confirmation and guest order tracking.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/checkout/.
 * (POST /api/upload/proof is a resource route: app/routes/api/_routes.ts → routes/api/upload-proof.ts.)
 * The step of /checkout is in its search (?step=address|payment|review), not in the path.
 */
export const checkoutRoutes: RouteConfigEntry[] = [
  route("cart", "routes/storefront/checkout/cart.tsx"),
  route("checkout", "routes/storefront/checkout/checkout.tsx"),
  route("order/:ref", "routes/storefront/checkout/order.tsx"),
  route("track", "routes/storefront/checkout/track.tsx"),
];
