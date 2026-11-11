import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin sign-in, first-run setup, sign-out and the admin language switch. These sit OUTSIDE the authenticated layout
 * (absolute paths). /admin/login and /admin/setup are behind a Cloudflare managed challenge in production, so the app
 * reaches them with document redirects only (`redirectDocument`).
 *
 *   /admin/login    (sign-in.tsx) email + password, then the authenticator code or a recovery code; ?next=<admin path>
 *   /admin/setup    (first-owner.tsx) first owner, with SETUP_TOKEN, only while no employee exists — afterwards 404
 *   /admin/logout   (sign-out.ts) POST scope=one|all (GET just goes to the admin home)
 *   /admin/locale   (language.ts) POST locale=ar|en, back=<admin path> — sets the tt_admin_locale cookie
 */
export const authAdminRoutes: RouteConfigEntry[] = [
  route("admin/login", "routes/admin/auth/sign-in.tsx"),
  route("admin/setup", "routes/admin/auth/first-owner.tsx"),
  route("admin/logout", "routes/admin/auth/sign-out.ts"),
  route("admin/locale", "routes/admin/auth/language.ts"),
];
