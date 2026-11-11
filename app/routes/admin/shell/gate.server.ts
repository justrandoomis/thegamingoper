/**
 * The admin gate — server middleware of the authenticated admin layout (app/routes/admin/_layout.tsx). It runs before
 * every loader and action under /admin (document and data requests alike), so nothing below it runs for:
 *
 *   · nobody signed in, or the second step still owed → document redirect to /admin/login?next=<this page>
 *     (`redirectDocument`: the sign-in page sits behind a Cloudflare challenge that a data fetch cannot pass)
 *   · a module the employee may not see (no permission of that module's group) → 403, even by direct URL; the module's
 *     loaders and actions are never called, so a missing check inside a module cannot leak its data
 *
 * and on the way out every admin response gets `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.
 *
 * Which module a request is for comes from the MATCHED ROUTE PATTERN ("admin/orders/:ref" → orders), never from the
 * raw URL, so encodings such as /admin/%6Frders cannot dodge it. Convention for module owners: register your routes
 * under your folder's slug (/admin/<slug>/…) — a route under /admin that is neither a module's nor one of the shell's
 * own pages is REFUSED for everyone (fail closed, gateRuleOf). The shell's own landing route (/admin/:module) checks access itself and
 * renders its 403 inside the shell. A module's finer permissions stay with the module: every loader and action calls
 * requireEmployee(ctx, db, "<permission>") and every service assertCan(…).
 *
 * Note on rendering: an error thrown by middleware before the loaders run is rendered by the ROOT error boundary
 * (React Router picks the first matched route with a loader), so the 403 of a built module that the employee cannot
 * see is the root's plain page, not the admin shell. That is the price of refusing before any module code runs.
 */
import { createContext, data, type MiddlewareFunction, type RouterContextProvider } from "react-router";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { canSeeModule } from "./access.server";
import { isAdminModuleSlug, type AdminModuleSlug } from "./modules";
import { ADMIN_HOME, adminNextPath } from "./next.server";

const sessionContext = createContext<EmployeeSession | null>(null);

/** The employee of this admin request (set by the gate). Throws when called outside the admin layout. */
export function getAdminSession(context: Readonly<RouterContextProvider>): EmployeeSession {
  const session = context.get(sessionContext);
  if (!session) throw new Error("No admin session: is this route inside the admin layout (app/routes/admin/_layout.tsx)?");
  return session;
}

/**
 * The module a matched route pattern belongs to: "admin/orders/:ref" → "orders". Null for the admin home ("admin"),
 * the shell's own pages (admin/me, admin/blueprint), the landing route (admin/:module) and the not-found splat.
 */
export function moduleOfPattern(pattern: string): AdminModuleSlug | null {
  const segments = pattern.split("/").filter(Boolean);
  if (segments[0] !== "admin") return null;
  const first = segments[1];
  return first && isAdminModuleSlug(first) ? first : null;
}

/** The shell's own route patterns: the home, My security, the blueprint, the landing fallback and the not-found splat. */
const SHELL_PATTERNS: ReadonlySet<string> = new Set(["admin", "admin/me", "admin/blueprint", "admin/:module", "admin/*"]);

/**
 * How the gate treats a matched route pattern: a module's route (checked against the module's permission group), one
 * of the shell's own pages (any signed-in employee; the page decides the rest), or neither — a route registered under
 * /admin but outside /admin/<module>/, which the gate cannot attribute to a permission group and therefore REFUSES
 * (fail closed: a module owner who registers /admin/payments instead of /admin/orders/payments finds out at once,
 * instead of shipping a page every employee can open).
 */
export function gateRuleOf(pattern: string): { kind: "module"; module: AdminModuleSlug } | { kind: "shell" } | { kind: "unmapped" } {
  const module = moduleOfPattern(pattern);
  if (module) return { kind: "module", module };
  return SHELL_PATTERNS.has(pattern.split("/").filter(Boolean).join("/")) ? { kind: "shell" } : { kind: "unmapped" };
}

/** The page to come back to after signing in: the normalized URL (no ".data", no router params). */
function returnPath(url: URL): string | null {
  const target = adminNextPath(`${url.pathname}${url.search}`, "");
  return target && target !== ADMIN_HOME ? target : null;
}

export const adminGate: MiddlewareFunction<Response> = async ({ context, url, pattern }, next) => {
  const ctx = getCtx(context);
  const session = await requireEmployee(ctx, getDb(), undefined, { next: returnPath(url) });
  context.set(sessionContext, session);

  const rule = gateRuleOf(pattern);
  if (rule.kind === "module" && !canSeeModule(session.actor, rule.module)) {
    throw data({ error: "forbidden", module: rule.module }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (rule.kind === "unmapped") {
    console.error(`[admin] refused: the route pattern "${pattern}" is neither under /admin/<module>/ nor one of the shell's pages (docs/areas/admin-shell.md, "For module owners")`);
    throw data({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const response = await next();
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
};
