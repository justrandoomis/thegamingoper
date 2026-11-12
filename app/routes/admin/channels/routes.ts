import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 21 — Branches, channels and integrations (docs/areas/admin-channels.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/channels/.
 * Static segments outrank dynamic ones, so /admin/channels/branches/new never reaches the branch page.
 *
 *   /admin/channels                         what waits, figures, honest limits, blueprint status            (any permission of the module)
 *   /admin/channels/branches                the branches, with what points at each one                       21.01
 *   /admin/channels/branches/new            add a branch                                                     21.01
 *   /admin/channels/branches/:branchId      one branch: details, switch, its locations / registers / staff   21.01
 *   /admin/channels/sales                   sales channels: stock, prices, delivery per channel; add one     21.01 21.06
 *   /admin/channels/orders                  orders of every channel for a period, with their lists          21.02
 *   /admin/channels/profit                  profitability per channel (and POS per branch), printable        21.06
 *   /admin/channels/api                     API keys: create (shown once), scopes, expiry, revoke             21.03
 *   /admin/channels/api/docs                the API and webhook reference                                    21.03
 *   /admin/channels/webhooks                the webhook registry; queue new order events                     21.03
 *   /admin/channels/webhooks/:webhookId     one webhook: events, pause, new secret, ping, deliveries         21.03 21.04
 *   /admin/channels/monitor                 failures and retries without duplicates; incoming events         21.04
 *   /admin/channels/providers               payment, shipping and messaging providers (not connected)        21.05
 *
 * The read API itself (GET /api/v1/:resource, routes/admin/channels/api-v1.ts) is a resource route outside the admin
 * layout: it is registered in app/routes/api/_routes.ts by its owner (requested), never here.
 */
export const channelsAdminRoutes: RouteConfigEntry[] = [
  route("channels", "routes/admin/channels/layout.tsx", [
    index("routes/admin/channels/home.tsx"),
    route("branches", "routes/admin/channels/branches.tsx"),
    route("branches/new", "routes/admin/channels/branch-new.tsx"),
    route("branches/:branchId", "routes/admin/channels/branch.tsx"),
    route("sales", "routes/admin/channels/sales.tsx"),
    route("orders", "routes/admin/channels/orders.tsx"),
    route("profit", "routes/admin/channels/profit.tsx"),
    route("api", "routes/admin/channels/api-keys.tsx"),
    route("api/docs", "routes/admin/channels/api-docs.tsx"),
    route("webhooks", "routes/admin/channels/webhooks.tsx"),
    route("webhooks/:webhookId", "routes/admin/channels/webhook.tsx"),
    route("monitor", "routes/admin/channels/monitor.tsx"),
    route("providers", "routes/admin/channels/providers.tsx"),
  ]),
];
