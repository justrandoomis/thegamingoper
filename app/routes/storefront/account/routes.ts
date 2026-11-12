import { index, layout, prefix, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Sign-in, profile, addresses, wishlist, wallet, orders, returns, warranties, notifications.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/account/.
 *
 *   /account/login · /account/signup · /account/forgot · /account/logout (POST)     no account needed
 *   /account/wallet/proof[/:fileId]                                                 resource route: top-up proof upload / private preview
 *   /account · /account/{orders,orders/:ref,wallet,addresses,devices,returns,      signed-in pages inside the account layout
 *              warranties,notifications,profile,settings,rewards,privacy}
 *   /wishlist                                                                      favourites, for guests and customers
 */
const at = (file: string) => `routes/storefront/account/${file}`;

export const accountRoutes: RouteConfigEntry[] = [
  ...prefix("account", [
    route("login", at("login.tsx")),
    route("signup", at("signup.tsx")),
    route("forgot", at("forgot.tsx")),
    route("logout", at("logout.tsx")),
    route("wallet/proof/:fileId?", at("wallet-proof.ts")),
    layout(at("layout.tsx"), [
      index(at("overview.tsx")),
      route("orders", at("orders.tsx")),
      route("orders/:ref", at("order.tsx")),
      route("wallet", at("wallet.tsx")),
      route("addresses", at("addresses.tsx")),
      route("devices", at("devices.tsx")),
      route("returns", at("returns.tsx")),
      route("warranties", at("warranties.tsx")),
      route("notifications", at("notifications.tsx")),
      route("profile", at("profile.tsx")),
      route("settings", at("settings.tsx")),
      // 2026-11-12: points, membership and the referral code; the privacy-request form
      route("rewards", at("rewards.tsx")),
      route("privacy", at("privacy.tsx")),
    ]),
  ]),
  route("wishlist", at("wishlist.tsx")),
];
