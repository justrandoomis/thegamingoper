import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 07 — Customers and CRM (docs/areas/admin-customers.md). Paths are relative to "/admin" (inside the
 * authenticated admin layout); route files live in routes/admin/customers/. Static segments outrank ":customerId", so
 * /admin/customers/segments never reaches a customer page.
 *
 *   /admin/customers                                the list (search, saved views, segment), queues, blueprint status  07.01 07.06
 *   /admin/customers/export                         the list as CSV (customers.customer.export, audited)              07.01
 *   /admin/customers/segments                       RFM segments: the rules, stored vs now, the grid, recompute        07.02
 *   /admin/customers/consents                       the consent log (grants, withdrawals, unsubscribes)               07.04
 *   /admin/customers/privacy                        privacy requests: queue, due dates, open a request                 07.04
 *   /admin/customers/privacy/:ref                   one request: verify, export, erase, unsubscribe, complete          07.04
 *   /admin/customers/privacy/:ref/export            the customer's data as JSON (verified exports, audited)           07.04
 *   /admin/customers/duplicates                     accounts that look alike, latest merges                            07.05
 *   /admin/customers/:customerId                    the 360° profile; VIP, fraud flag, block; notes                    07.01 07.02 07.06
 *   /admin/customers/:customerId/contact            details, addresses, notification channels                         07.03
 *   /admin/customers/:customerId/privacy            consents with history, withdrawals, the customer's requests        07.04
 *   /admin/customers/:customerId/messages           communication log linked to orders; log a contact                  07.07
 *   /admin/customers/:customerId/merge              merge a duplicate into this account (plan → verify → confirm)      07.05
 */
export const customersAdminRoutes: RouteConfigEntry[] = [
  route("customers", "routes/admin/customers/layout.tsx", [
    index("routes/admin/customers/index.tsx"),
    route("export", "routes/admin/customers/export.ts"),
    route("segments", "routes/admin/customers/segments.tsx"),
    route("consents", "routes/admin/customers/consents.tsx"),
    route("privacy", "routes/admin/customers/privacy.tsx"),
    route("privacy/:ref", "routes/admin/customers/privacy-request.tsx"),
    route("privacy/:ref/export", "routes/admin/customers/privacy-export.ts"),
    route("duplicates", "routes/admin/customers/duplicates.tsx"),
    route(":customerId", "routes/admin/customers/customer-layout.tsx", [
      index("routes/admin/customers/customer.tsx"),
      route("contact", "routes/admin/customers/contact.tsx"),
      route("privacy", "routes/admin/customers/customer-privacy.tsx"),
      route("messages", "routes/admin/customers/customer-messages.tsx"),
      route("merge", "routes/admin/customers/customer-merge.tsx"),
    ]),
  ]),
];
