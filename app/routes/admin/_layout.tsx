import { data, isRouteErrorResponse, Outlet } from "react-router";

import type { Route } from "./+types/_layout";
import { messagesFor, type I18nPayload } from "~/i18n/i18n.server";
import { translate } from "~/i18n/translate";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { opsTimingMiddleware } from "./ops/observe.server";
import { AdminShell } from "./shell/AdminShell";
import { AdminErrorPage } from "./shell/ErrorPage";
import { adminGate, findAdminSession } from "./shell/gate.server";
import { adminMeta, adminMetaT } from "./shell/meta";
import { loadAdminShell, type AdminShellData } from "./shell/shell.server";

/**
 * The authenticated admin layout — every page under /admin except sign-in and setup (docs/CONTRACTS.md §4, DESIGN.md §10).
 *
 *   middleware   adminGate (./shell/gate.server.ts): requireEmployee on EVERY document and data request — nobody signed
 *                in → document redirect to /admin/login?next=…; a module the role cannot see → 403 before any of the
 *                module's loaders or actions run; Cache-Control: no-store and X-Robots-Tag: noindex on every response.
 *                Then opsTimingMiddleware (module 23, ./ops/observe.server.ts): the server time of every admin request
 *                that got past the gate, recorded only when it was slow or failed (one upsert) — timed once even where
 *                the operations module's own layout carries it too
 *   loader       the shell's data: employee, visible modules (from the permission catalogue), what is waiting for them,
 *                the admin language (tt_admin_locale cookie, read by the root middleware) and the "admin" strings.
 *                React Router revalidates it on every navigation, so a revoked session or a changed role shows at once.
 *                On the one page for nobody signed in (the password-set link, /admin/welcome) there is no shell data:
 *                the frame renders without navigation
 *   component    <AdminShell>: rail, tool bar, tab bar, sections sheet, command palette (Ctrl/⌘ K), notifications,
 *                employee menu, toasts, the browser's error and speed reporter — in admin density, Arabic-first RTL
 *                or English, light or dark
 *
 * Module pages still start every loader and action with requireEmployee(ctx, db, "<permission>") and their services
 * with assertCan(…): the shell's gate is the coarse outer check, not the only one.
 */
export const middleware: Route.MiddlewareFunction[] = [adminGate, opsTimingMiddleware];

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const i18n = messagesFor(ctx.locale, "admin");
  const session = findAdminSession(context);
  // the gate let a request through without a session only for a page that needs none (PUBLIC_PATTERNS)
  if (!session) return { shell: null, i18n };
  let shell: AdminShellData;
  try {
    shell = await loadAdminShell(ctx, getDb(), session);
  } catch (error) {
    // Reported, and shown inside the frame in the employee's language (the strings travel with the error).
    console.error("[admin] shell data failed", error);
    throw data({ error: "unavailable", i18n }, { status: 503 });
  }
  return { shell, i18n };
}

/** What may travel with an error this layout's boundary renders: the frame's words and data (a refusal, a 503). */
type ThrownFrame = { i18n?: I18nPayload; shell?: AdminShellData } | null;
const thrownFrame = (error: unknown): ThrownFrame => (isRouteErrorResponse(error) && error.data && typeof error.data === "object" ? (error.data as ThrownFrame) : null);

export const meta: Route.MetaFunction = (args) => {
  if (!args.error) return adminMeta(args);
  // An error page (this layout's boundary): its own title — not allowed, not found, could not load — in the admin's
  // words, from the layout's data or, when the layout's loader never ran (a client navigation's refusal), the frame
  // the error carries (polish 2026-11-13: these pages had the brand name alone).
  const status = isRouteErrorResponse(args.error) ? args.error.status : 500;
  const key = status === 403 ? "errors.forbiddenTitle" : status === 404 ? "errors.notFoundTitle" : "errors.serverTitle";
  const frame = thrownFrame(args.error);
  const tree = frame?.i18n?.admin;
  if (!adminMetaT(args) && tree) {
    const locale = frame?.shell?.locale ?? "ar";
    const t = (text: string) => translate(tree, locale, text) ?? text;
    return [{ title: `${t(key)} · ${t("brand.suffix")}` }, { name: "robots", content: "noindex, nofollow" }];
  }
  return adminMeta(args, (t) => t(key));
};

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AdminShell data={loaderData.shell} messages={loaderData.i18n.admin}>
      <Outlet />
    </AdminShell>
  );
}

export function ErrorBoundary({ error, loaderData }: Route.ErrorBoundaryProps) {
  // The layout's data when a page below failed; what was thrown with the error when the layout's own loader did (its
  // words) or never ran (a client navigation the gate refused: the frame's data and words — gate.server.ts).
  const frame = thrownFrame(error);
  return (
    <AdminShell data={loaderData?.shell ?? frame?.shell ?? null} messages={loaderData?.i18n.admin ?? frame?.i18n?.admin}>
      <AdminErrorPage error={error} />
    </AdminShell>
  );
}
