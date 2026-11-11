import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * The admin shell's own pages, inside the authenticated layout. Registered AFTER the 23 modules in ../_routes.ts;
 * order does not decide matching (React Router ranks static segments above dynamic ones above the splat), so a
 * module's own /admin/<slug> route always wins over the landing fallback here.
 *
 *   /admin/me          My security: two-step verification, password, own sessions
 *   /admin/blueprint   the 176 blueprint functions × their status in the admin, with filters
 *   /admin/:module     landing page of a module that has no page of its own yet (403 when the role cannot see it)
 *   /admin/*           not found, inside the shell
 */
export const adminShellRoutes: RouteConfigEntry[] = [
  route("me", "routes/admin/shell/me.tsx"),
  route("blueprint", "routes/admin/shell/blueprint.tsx"),
  route(":module", "routes/admin/shell/module.tsx"),
  route("*", "routes/admin/shell/not-found.tsx"),
];
