import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 20 — Security and compliance (docs/areas/admin-security.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/security/.
 * Static segments outrank dynamic ones, so /admin/security/audit/export never reaches the event page.
 *
 *   /admin/security                       what waits for a person, figures, honest limits, blueprint status   (all)
 *   /admin/security/staff                 staff with two-step state, coverage per role                        20.01
 *   /admin/security/staff/:employeeId     sessions (end), two-step reset, roles and branch, sign-in events    20.01 20.02
 *   /admin/security/roles                 roles, what they grant, a new role                                  20.02
 *   /admin/security/roles/:roleId         the permission editor, members, access reviews                      20.02 20.07
 *   /admin/security/audit                 the audit trail, the hash chain (verify, seal), CSV                 20.03
 *   /admin/security/audit/export          CSV of the same filters (resource route)                            20.03
 *   /admin/security/audit/:eventId        one event: before and after, same request, sealed or not            20.03
 *   /admin/security/protections           encryption status and self-test; idempotency and duplicates         20.04 20.06
 *   /admin/security/backups               the recovery plan, restore tests (evidence)                         20.05
 *   /admin/security/retention             retention policy (read-only), access reviews                        20.07
 *   /admin/security/sign-ins              abnormal sign-in alerts and the security log                        20.08
 *   /admin/security/refunds               refund reviews                                                      20.08
 */
export const securityAdminRoutes: RouteConfigEntry[] = [
  route("security", "routes/admin/security/layout.tsx", [
    index("routes/admin/security/home.tsx"),
    route("staff", "routes/admin/security/staff.tsx"),
    route("staff/:employeeId", "routes/admin/security/employee.tsx"),
    route("roles", "routes/admin/security/roles.tsx"),
    route("roles/:roleId", "routes/admin/security/role.tsx"),
    route("audit", "routes/admin/security/audit.tsx"),
    route("audit/export", "routes/admin/security/audit-export.ts"),
    route("audit/:eventId", "routes/admin/security/audit-event.tsx"),
    route("protections", "routes/admin/security/protections.tsx"),
    route("backups", "routes/admin/security/backups.tsx"),
    route("retention", "routes/admin/security/retention.tsx"),
    route("sign-ins", "routes/admin/security/sign-ins.tsx"),
    route("refunds", "routes/admin/security/refunds.tsx"),
  ]),
];
