import { data, isRouteErrorResponse, Outlet } from "react-router";

import type { Route } from "./+types/_layout";
import { messagesFor, type I18nPayload } from "~/i18n/i18n.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { AdminShell } from "./shell/AdminShell";
import { AdminErrorPage } from "./shell/ErrorPage";
import { adminGate, getAdminSession } from "./shell/gate.server";
import { adminMeta } from "./shell/meta";
import { loadAdminShell, type AdminShellData } from "./shell/shell.server";

/**
 * The authenticated admin layout — every page under /admin except sign-in and setup (docs/CONTRACTS.md §4, DESIGN.md §10).
 *
 *   middleware   adminGate (./shell/gate.server.ts): requireEmployee on EVERY document and data request — nobody signed
 *                in → document redirect to /admin/login?next=…; a module the role cannot see → 403 before any of the
 *                module's loaders or actions run; Cache-Control: no-store and X-Robots-Tag: noindex on every response
 *   loader       the shell's data: employee, visible modules (from the permission catalogue), what is waiting for them,
 *                the admin language (tt_admin_locale cookie, read by the root middleware) and the "admin" strings.
 *                React Router revalidates it on every navigation, so a revoked session or a changed role shows at once
 *   component    <AdminShell>: rail, tool bar, tab bar, sections sheet, command palette (Ctrl/⌘ K), notifications,
 *                employee menu, toasts — in admin density, Arabic-first RTL or English, light or dark
 *
 * Module pages still start every loader and action with requireEmployee(ctx, db, "<permission>") and their services
 * with assertCan(…): the shell's gate is the coarse outer check, not the only one.
 */
export const middleware: Route.MiddlewareFunction[] = [adminGate];

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const i18n = messagesFor(ctx.locale, "admin");
  let shell: AdminShellData;
  try {
    shell = await loadAdminShell(ctx, getDb(), getAdminSession(context));
  } catch (error) {
    // Reported, and shown inside the frame in the employee's language (the strings travel with the error).
    console.error("[admin] shell data failed", error);
    throw data({ error: "unavailable", i18n }, { status: 503 });
  }
  return { shell, i18n };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args);

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AdminShell data={loaderData.shell} messages={loaderData.i18n.admin}>
      <Outlet />
    </AdminShell>
  );
}

export function ErrorBoundary({ error, loaderData }: Route.ErrorBoundaryProps) {
  // The layout's data when a page below failed; the strings thrown with the error when the layout's own loader did.
  const thrown = isRouteErrorResponse(error) ? (error.data as { i18n?: I18nPayload } | null) : null;
  return (
    <AdminShell data={loaderData?.shell ?? null} messages={loaderData?.i18n.admin ?? thrown?.i18n?.admin}>
      <AdminErrorPage error={error} />
    </AdminShell>
  );
}
